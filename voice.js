// صدای زنده بین بازیکن‌ها با WebRTC. سیگنالینگ از طریق Firestore (rooms/{code}/rtc).
// هر دو نفری که صداشون روشنه یه اتصال مستقیم دارن (mesh). برای ۱۶ نفر کافیه.
// میکروفون = صدای من برای بقیه. هدفون = شنیدن صدای بقیه.
import { ICE_SERVERS } from "./firebase-config.js";

const GATHER_MS = 2500;

export function createVoice(fb, uid, code, net, hooks = {}) {
  const { db, collection, doc, addDoc, deleteDoc, onSnapshot, query, where } = fb;
  const RTC = collection(db, "rooms", code, "rtc");
  const peers = new Map(); // id -> { pc, remoteSid, audio, offerer, tries, state }
  let sid = "", mic = false, spk = false, track = null, unsub = null, dead = false;
  const box = document.createElement("div");
  box.hidden = true;
  document.body.appendChild(box);

  const changed = () => hooks.onChange && hooks.onChange();
  const active = () => mic || spk;
  const newSid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  function gather(pc) {
    if (pc.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((res) => {
      const t = setTimeout(res, GATHER_MS);
      pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); res(); } });
    });
  }

  function closePeer(id) {
    const p = peers.get(id);
    if (!p) return;
    try { p.pc.close(); } catch {}
    if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
    peers.delete(id);
  }

  function makePc(id, remoteSid, offerer) {
    closePeer(id);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const p = { pc, remoteSid, offerer, audio: null, tries: (peers.get(id) || {}).tries || 0, state: "new", born: Date.now() };
    peers.set(id, p);
    pc.ontrack = (e) => {
      if (!p.audio) {
        p.audio = document.createElement("audio");
        p.audio.autoplay = true;
        p.audio.setAttribute("playsinline", "");
        box.appendChild(p.audio);
      }
      p.audio.srcObject = e.streams[0] || new MediaStream([e.track]);
      p.audio.muted = !spk;
      p.audio.play().catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      p.state = pc.connectionState;
      if (pc.connectionState === "failed" && p.offerer && peers.get(id) === p && p.tries < 3) {
        p.tries++;
        setTimeout(() => { if (peers.get(id) === p && !dead) offer(id, p.remoteSid); }, 1500);
      }
      changed();
    };
    return p;
  }

  async function send(to, toSid, type, desc) {
    await addDoc(RTC, { from: uid, to, fsid: sid, tsid: toSid, type, sdp: desc.sdp, at: Date.now() });
  }

  async function offer(id, remoteSid) {
    const p = makePc(id, remoteSid, true);
    const tr = p.pc.addTransceiver("audio", { direction: "sendrecv" });
    if (track) await tr.sender.replaceTrack(track);
    await p.pc.setLocalDescription(await p.pc.createOffer());
    await gather(p.pc);
    if (peers.get(id) !== p) return;
    await send(id, remoteSid, "offer", p.pc.localDescription);
  }

  async function onSignal(ds) {
    const m = ds.data();
    deleteDoc(ds.ref).catch(() => {});
    if (!sid || m.tsid !== sid || dead) return;
    if (m.type === "offer") {
      const p = makePc(m.from, m.fsid, false);
      await p.pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
      const tr = p.pc.getTransceivers()[0];
      if (tr) { tr.direction = "sendrecv"; if (track) await tr.sender.replaceTrack(track); }
      await p.pc.setLocalDescription(await p.pc.createAnswer());
      await gather(p.pc);
      if (peers.get(m.from) !== p) return;
      await send(m.from, m.fsid, "answer", p.pc.localDescription);
    } else if (m.type === "answer") {
      const p = peers.get(m.from);
      if (!p || !p.offerer || p.remoteSid !== m.fsid || p.pc.signalingState !== "have-local-offer") return;
      await p.pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
    }
  }

  // بعد از هر تغییر لیست بازیکن‌ها صدا زده می‌شه
  function sync() {
    if (dead || !sid) return;
    const players = net.state.players;
    for (const id of [...peers.keys()]) {
      const pl = players.get(id);
      // ممکنه پیشنهاد اتصال زودتر از آپدیت لیست بازیکن‌ها برسه، پس چند ثانیه صبر می‌کنیم
      const p = peers.get(id);
      if (!pl || (pl.vs !== p.remoteSid && Date.now() - p.born > 8000)) closePeer(id);
    }
    for (const pl of players.values()) {
      if (pl.id === uid || !pl.vs || peers.has(pl.id)) continue;
      // فقط یکی از دو طرف (اونی که شناسه‌ش کوچیک‌تره) شروع می‌کنه
      if (uid < pl.id) offer(pl.id, pl.vs).catch(() => closePeer(pl.id));
    }
    changed();
  }

  async function start() {
    sid = newSid();
    unsub = onSnapshot(query(RTC, where("to", "==", uid)), (snap) => {
      snap.docChanges().forEach((ch) => { if (ch.type === "added") onSignal(ch.doc).catch(() => {}); });
    }, () => {});
    await net.setMe({ vs: sid, mic });
    sync();
  }

  function stop() {
    if (unsub) unsub();
    unsub = null;
    for (const id of [...peers.keys()]) closePeer(id);
    sid = "";
    net.setMe({ vs: "", mic: false });
  }

  async function setMic(on) {
    if (on && !track) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("این مرورگر میکروفون رو پشتیبانی نمی‌کنه");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      track = stream.getAudioTracks()[0];
    }
    if (!on && track) { track.stop(); track = null; }
    mic = on;
    for (const p of peers.values()) {
      const tr = p.pc.getTransceivers()[0];
      if (tr && tr.sender) tr.sender.replaceTrack(track).catch(() => {});
    }
    await toggled();
  }

  async function setSpeaker(on) {
    spk = on;
    for (const p of peers.values()) if (p.audio) { p.audio.muted = !on; if (on) p.audio.play().catch(() => {}); }
    await toggled();
  }

  async function toggled() {
    if (active() && !sid) await start();
    else if (!active() && sid) stop();
    else if (sid) await net.setMe({ mic });
    changed();
  }

  function destroy() {
    dead = true;
    if (track) { track.stop(); track = null; }
    if (unsub) unsub();
    for (const id of [...peers.keys()]) closePeer(id);
    box.remove();
  }

  const connectedCount = () => [...peers.values()].filter((p) => p.state === "connected").length;

  return { setMic, setSpeaker, sync, destroy, get mic() { return mic; }, get speaker() { return spk; }, get active() { return active(); }, connectedCount };
}
