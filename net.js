// لایه شبکه روی Firestore. به DOM وابسته نیست تا بشه جدا تستش کرد.
// ایده: گوشی میزبان نقش سرور قبلی رو داره. بقیه فقط «درخواست» می‌فرستن (actions)
// و میزبان اون‌ها رو اجرا می‌کنه و وضعیت بازی رو توی Firestore می‌نویسه.
import { newRoom, newPriv, applyAction, rand, MAX_PLAYERS, NOW } from "./game.js";

const PRESENCE_MS = 100000; // بدون ضربان بیشتر از این یعنی آفلاین
const BEAT_MS = 40000;

const clone = (o) => JSON.parse(JSON.stringify(o));
const ms = (t) => (t && typeof t.toMillis === "function" ? t.toMillis() : typeof t === "number" ? t : null);
const byJoin = (a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1);

export function createNet(fb, uid, hooks = {}, opts = {}) {
  const { db, doc, collection, setDoc, updateDoc, getDoc, getDocs, deleteDoc, addDoc, onSnapshot, writeBatch, serverTimestamp, query, orderBy, limitToLast } = fb;
  const now = opts.now || (() => Date.now());
  const useTimers = opts.timers !== false;

  const R = (c) => doc(db, "rooms", c);
  const PL = (c) => collection(db, "rooms", c, "players");
  const P = (c, id) => doc(db, "rooms", c, "players", id);
  const SEC = (c, id) => doc(db, "rooms", c, "secrets", id);
  const PRIV = (c) => doc(db, "rooms", c, "private", "host");
  const ACT = (c) => collection(db, "rooms", c, "actions");
  const CHAT = (c) => collection(db, "rooms", c, "chat");

  const st = { code: "", room: null, players: new Map(), secret: null, skew: 0, myVote: null, chat: [] };
  const presence = new Map(); // id -> { beat, at } (زمان محلی آخرین تغییر ضربان)
  const seenActions = new Set();
  let unsubs = [], timerIds = [], hostUnsub = null, hostActive = false, privReady = null, priv = null;
  let chain = Promise.resolve(), claiming = false, offlineSince = 0, leavingSelf = false, sawMe = false, lastSeen = 0;

  const changed = () => hooks.onChange && hooks.onChange();
  const isHost = () => !!st.room && st.room.host === uid;
  const isOnline = (id) => id === uid || (presence.has(id) && now() - presence.get(id).at < PRESENCE_MS);
  const onlineIds = () => [...st.players.keys()].filter(isOnline);
  const connected = () => !offlineSince || now() - offlineSince < 4000;

  /* ---------- میزبان ---------- */

  function hostRun(fn) {
    const p = chain.then(fn);
    chain = p.then(() => {}, (e) => hooks.onError && hooks.onError(e));
    return p;
  }

  async function apply(a) {
    const room0 = st.room;
    if (!room0 || !isHost()) return null;
    if (!priv) {
      await privReady;
      if (!priv) return "نشد، دوباره امتحان کن";
    }
    const room = clone(room0), p = clone(priv);
    const res = applyAction(room, p, a, { onlineIds: onlineIds() });
    if (res.error) return res.error;
    const patch = {};
    for (const k of Object.keys(room)) if (JSON.stringify(room[k]) !== JSON.stringify(room0[k])) patch[k] = room[k];
    const batch = writeBatch(db);
    let n = 0;
    if (res.secrets) for (const [id, s] of Object.entries(res.secrets)) { batch.set(SEC(st.code, id), s); n++; }
    if (res.clearSecrets) for (const id of res.clearSecrets) { batch.delete(SEC(st.code, id)); n++; }
    if (res.kick) { batch.delete(P(st.code, res.kick)); n++; }
    if (JSON.stringify(p) !== JSON.stringify(priv)) { batch.set(PRIV(st.code), p); n++; }
    if (Object.keys(patch).length) {
      const up = { ...patch };
      if (up.startedAt === NOW) up.startedAt = serverTimestamp();
      batch.update(R(st.code), up);
      n++;
    }
    if (!n) return null;
    await batch.commit();
    priv = p;
    if (room.startedAt === NOW) room.startedAt = now() + st.skew;
    if (st.room === room0) { st.room = room; changed(); }
    return null;
  }

  function startHost() {
    hostActive = true;
    const code = st.code;
    privReady = (async () => {
      for (let i = 0; i < 3 && !priv; i++) {
        try {
          const s = await getDoc(PRIV(code));
          priv = s.exists() ? { ...newPriv(), ...s.data() } : newPriv();
        } catch { /* دوباره امتحان */ }
      }
    })();
    hostUnsub = onSnapshot(ACT(code), (snap) => {
      snap.docChanges().forEach((ch) => {
        if (ch.type !== "added") return;
        const id = ch.doc.id;
        if (seenActions.has(id)) return;
        seenActions.add(id);
        const a = ch.doc.data();
        hostRun(async () => {
          await privReady;
          if (st.room && (a.type === "lobby" || a.round === st.room.round)) await apply(a);
          await deleteDoc(ch.doc.ref).catch(() => {});
        });
      });
    }, () => {});
  }

  function stopHost() {
    hostActive = false;
    priv = null;
    if (hostUnsub) hostUnsub();
    hostUnsub = null;
  }

  function syncHostRole() {
    if (isHost() && !hostActive) startHost();
    else if (!isHost() && hostActive) stopHost();
  }

  // اگه میزبان رفته یا آفلاینه، قدیمی‌ترین بازیکن آنلاین میزبانی رو می‌گیره.
  // قوانین Firestore هم چک می‌کنن که میزبان قبلی واقعاً بی‌ضربان مونده باشه.
  function maybeClaim() {
    const r = st.room;
    if (!r || isHost() || claiming || !st.players.has(uid)) return;
    if (st.players.has(r.host) && isOnline(r.host)) return;
    const next = [...st.players.values()].filter((p) => p.id !== r.host && isOnline(p.id)).sort(byJoin)[0];
    if (!next || next.id !== uid) return;
    claiming = true;
    updateDoc(R(st.code), { host: uid }).catch(() => {}).then(() => { claiming = false; });
  }

  function tick() {
    const r = st.room;
    if (!r) return;
    if (isHost()) { if (r.phase === "vote") hostRun(() => apply({ type: "tick", by: uid })); }
    else maybeClaim();
  }

  /* ---------- اتصال ---------- */

  function beat() {
    if (st.code) updateDoc(P(st.code, uid), { beat: now(), seen: serverTimestamp() }).catch(() => {});
  }

  function attach(code) {
    detach();
    st.code = code;
    unsubs.push(onSnapshot(R(code), { includeMetadataChanges: true }, (snap) => {
      offlineSince = snap.metadata.fromCache ? offlineSince || now() : 0;
      if (!snap.exists()) {
        if (st.room) { st.room = null; hooks.onRoomGone && hooks.onRoomGone(); }
        return;
      }
      const d = snap.data({ serverTimestamps: "estimate" });
      st.room = { ...d, startedAt: ms(d.startedAt) };
      syncHostRole();
      changed();
    }, () => { st.room = null; hooks.onRoomGone && hooks.onRoomGone(); }));

    unsubs.push(onSnapshot(PL(code), (snap) => {
      const t = now(), next = new Map();
      snap.forEach((ds) => {
        const d = ds.data();
        next.set(ds.id, { id: ds.id, name: d.name || "", joinedAt: d.joinedAt || 0, vs: d.vs || "", mic: !!d.mic });
        const p = presence.get(ds.id);
        if (!p) presence.set(ds.id, { beat: d.beat, at: t });
        else if (p.beat !== d.beat) { p.beat = d.beat; p.at = t; }
        const seen = ms(d.seen);
        // فقط وقتی ضربان خودم تازه برگشته، اختلاف ساعت با سرور رو حساب کن (وگرنه ضربان قدیمی حسابش رو خراب می‌کنه)
        if (ds.id === uid && seen && !ds.metadata.hasPendingWrites && seen !== lastSeen) { lastSeen = seen; st.skew = seen - t; }
      });
      for (const id of [...presence.keys()]) if (!next.has(id)) presence.delete(id);
      // اگه سند خودم پاک شد و خودم نرفتم، یعنی میزبان بیرونم کرده
      if (next.has(uid)) sawMe = true;
      else if (sawMe && !leavingSelf && !snap.metadata.hasPendingWrites && !snap.metadata.fromCache) {
        const code = st.code;
        detach();
        hooks.onKicked && hooks.onKicked(code);
        return;
      }
      st.players = next;
      tick();
      changed();
    }, () => {}));

    unsubs.push(onSnapshot(query(CHAT(code), orderBy("at"), limitToLast(120)), (snap) => {
      st.chat = snap.docs.map((ds) => ({ id: ds.id, ...ds.data() }));
      hooks.onChat && hooks.onChat();
    }, () => {}));

    unsubs.push(onSnapshot(SEC(code, uid), (snap) => {
      st.secret = snap.exists() ? snap.data() : null;
      changed();
    }, () => {}));

    if (useTimers) {
      timerIds.push(setInterval(beat, BEAT_MS));
      timerIds.push(setInterval(() => { tick(); changed(); }, 8000));
    }
  }

  function detach() {
    unsubs.forEach((u) => u());
    unsubs = [];
    timerIds.forEach(clearInterval);
    timerIds = [];
    stopHost();
    Object.assign(st, { code: "", room: null, players: new Map(), secret: null, myVote: null, chat: [] });
    sawMe = false;
    presence.clear();
    seenActions.clear();
    offlineSince = 0;
  }

  /* ---------- کارهایی که UI صدا می‌زنه ---------- */

  async function createRoom(name) {
    for (let i = 0; i < 8; i++) {
      const code = String(10000 + rand(90000));
      try {
        await setDoc(R(code), newRoom(code, uid));
      } catch (e) {
        if (e && e.code === "permission-denied") continue; // کد تکراری
        throw e;
      }
      await setDoc(P(code, uid), { name, joinedAt: now(), beat: now(), seen: serverTimestamp(), vs: "", mic: false });
      attach(code);
      return code;
    }
    throw new Error("نشد اتاق بسازم. دوباره امتحان کن.");
  }

  async function joinRoom(name, code) {
    const rs = await getDoc(R(code));
    if (!rs.exists()) throw new Error("همچین اتاقی پیدا نشد");
    if ((rs.data().kicked || []).includes(uid)) throw new Error("میزبان تو رو از این اتاق بیرون کرده");
    const pl = await getDocs(PL(code));
    const mine = pl.docs.find((d) => d.id === uid);
    if (!mine && pl.size >= MAX_PLAYERS) throw new Error("اتاق پره");
    if (mine) await updateDoc(P(code, uid), { name, beat: now(), seen: serverTimestamp(), vs: "", mic: false });
    else await setDoc(P(code, uid), { name, joinedAt: now(), beat: now(), seen: serverTimestamp(), vs: "", mic: false });
    attach(code);
  }

  async function resume(code) {
    const rs = await getDoc(R(code));
    if (!rs.exists()) return false;
    const ps = await getDoc(P(code, uid));
    if (!ps.exists()) return false;
    await updateDoc(P(code, uid), { beat: now(), seen: serverTimestamp(), vs: "", mic: false });
    attach(code);
    return true;
  }

  async function leave() {
    const code = st.code, r = st.room;
    if (!code) return;
    const others = [...st.players.values()].filter((p) => p.id !== uid);
    leavingSelf = true;
    try {
      if (r && r.host === uid) {
        const next = others.filter((p) => isOnline(p.id)).sort(byJoin)[0] || others.sort(byJoin)[0];
        if (next) await updateDoc(R(code), { host: next.id });
        else await deleteDoc(R(code));
      }
      await deleteDoc(P(code, uid));
    } catch { /* مهم نیست */ }
    detach();
    leavingSelf = false;
  }

  function sendChat(msg) {
    if (!st.code) return Promise.resolve();
    const me = st.players.get(uid);
    const text = String(msg.text || "").trim().slice(0, 300);
    if (!text) return Promise.resolve();
    return addDoc(CHAT(st.code), {
      by: uid, name: (me && me.name) || "", text, kind: msg.kind || "msg",
      target: msg.target || "", tname: msg.tname || "", at: now() + st.skew,
    });
  }

  // فیلدهای صدا روی سند خودم (vs = شناسه‌ی جلسه‌ی صدا، mic = میکروفون روشنه)
  function setMe(fields) {
    if (!st.code) return Promise.resolve();
    return updateDoc(P(st.code, uid), fields).catch(() => {});
  }

  function act(type, extra = {}) {
    const r = st.room;
    if (!r) return Promise.resolve();
    const a = { type, by: uid, round: r.round, ...extra };
    if (type === "vote") st.myVote = { round: r.round, target: extra.target };
    if (isHost()) {
      return hostRun(() => apply(a)).then((err) => { if (err && hooks.onError) hooks.onError(new Error(err)); }, (e) => hooks.onError && hooks.onError(e));
    }
    return addDoc(ACT(st.code), { ...a, at: now() }).then(() => {}, () => {});
  }

  return { state: st, isOnline, onlineIds, connected, createRoom, joinRoom, resume, leave, act, tick, beat, sendChat, setMe, destroy: detach };
}
