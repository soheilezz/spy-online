// جاسوس آنلاین: سرور بدون وابستگی (فقط Node.js). اجرا: node server.js
// اتاق‌ها با کد ۵ رقمی، ارتباط زنده با Server-Sent Events.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { CATEGORIES, CATEGORY_KEYS } = require("./words");

const PORT = process.env.PORT || 3000;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 16;
const ROOM_TTL = 3 * 60 * 60 * 1000; // اتاق بی‌استفاده بعد از ۳ ساعت پاک می‌شه
const rooms = new Map();

const rand = (n) => crypto.randomInt(n);
const pick = (a) => a[rand(a.length)];
const shuffle = (a) => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};
const cleanName = (s) => String(s || "").replace(/[<>]/g, "").trim().slice(0, 20);

function newCode() {
  let c;
  do c = String(10000 + rand(90000));
  while (rooms.has(c));
  return c;
}

function addPlayer(room, name) {
  const id = crypto.randomBytes(6).toString("hex");
  const token = crypto.randomBytes(16).toString("hex");
  room.players.set(id, { id, name, token, joinedAt: Date.now(), clients: new Set() });
  if (!room.host || !room.players.has(room.host)) room.host = id;
  return { id, token };
}

const isOnline = (p) => p.clients.size > 0;

function onlineIds(room) {
  return [...room.players.values()].filter(isOnline).map((p) => p.id);
}

function viewFor(room, me) {
  const g = room.game;
  const inRound = g.roster.includes(me.id);
  const amSpy = g.spies.includes(me.id);
  const reveal = g.phase === "result";
  const voters = g.roster.filter((id) => room.players.get(id) && isOnline(room.players.get(id)));
  return {
    code: room.code,
    me: { id: me.id, name: me.name },
    host: room.host,
    settings: room.settings,
    categories: Object.fromEntries(CATEGORY_KEYS.map((k) => [k, CATEGORIES[k].label])),
    players: [...room.players.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({ id: p.id, name: p.name, online: isOnline(p) })),
    scores: room.scores,
    game: {
      phase: g.phase,
      round: g.round,
      roster: g.roster,
      starter: g.starter,
      endsAt: g.endsAt,
      cat: inRound ? g.cat : "",
      word: inRound && (!amSpy || reveal) ? g.word : "",
      amSpy: inRound && amSpy,
      inRound,
      spies: reveal ? g.spies : [],
      accused: g.phase === "last" || reveal ? g.accused : "",
      guess: reveal ? g.guess : null,
      outcome: reveal ? g.outcome : "",
      reason: reveal ? g.reason : "",
      myVote: g.votes[me.id] || "",
      votedCount: voters.filter((id) => g.votes[id]).length,
      voterCount: voters.length,
      guessWords: (amSpy && (g.phase === "play" || (g.phase === "last" && g.accused === me.id))) ? CATEGORIES[g.cat].words : [],
    },
    now: Date.now(),
  };
}

function broadcast(room) {
  room.touched = Date.now();
  for (const p of room.players.values()) {
    const data = `data: ${JSON.stringify(viewFor(room, p))}\n\n`;
    for (const res of p.clients) res.write(data);
  }
}

function freshGame() {
  return { phase: "lobby", round: 0, cat: "", word: "", spies: [], roster: [], starter: "", endsAt: 0, votes: {}, accused: "", guess: null, outcome: "", reason: "" };
}

function finish(room, fields) {
  const g = room.game;
  Object.assign(g, { phase: "result" }, fields);
  if (g.outcome === "town") g.roster.filter((id) => !g.spies.includes(id)).forEach((id) => (room.scores[id] = (room.scores[id] || 0) + 1));
  else g.spies.forEach((id) => (room.scores[id] = (room.scores[id] || 0) + 2));
}

function resolveVotes(room) {
  const g = room.game;
  const tally = {};
  Object.entries(g.votes).forEach(([voter, t]) => g.roster.includes(voter) && (tally[t] = (tally[t] || 0) + 1));
  const max = Math.max(0, ...Object.values(tally));
  const top = Object.keys(tally).filter((id) => tally[id] === max);
  if (top.length === 1 && g.spies.includes(top[0])) Object.assign(g, { phase: "last", accused: top[0] });
  else finish(room, { outcome: "spy", accused: top.length === 1 ? top[0] : "", reason: top.length === 1 ? "wrong" : "tie" });
}

function maybeResolve(room) {
  const g = room.game;
  if (g.phase !== "vote") return;
  const voters = g.roster.filter((id) => room.players.get(id) && isOnline(room.players.get(id)));
  if (voters.length && voters.every((id) => g.votes[id])) resolveVotes(room);
}

function act(room, me, a) {
  const g = room.game;
  const isHost = room.host === me.id;
  switch (a.type) {
    case "settings": {
      if (!isHost || g.phase !== "lobby") return "فقط میزبان";
      const s = room.settings;
      if (a.cat && (a.cat === "mixed" || CATEGORIES[a.cat])) s.cat = a.cat;
      if (Number.isInteger(a.minutes)) s.minutes = Math.min(12, Math.max(2, a.minutes));
      if (Number.isInteger(a.spyCount)) s.spyCount = Math.min(2, Math.max(1, a.spyCount));
      return;
    }
    case "start": {
      if (!isHost) return "فقط میزبان";
      if (g.phase !== "lobby" && g.phase !== "result") return;
      const roster = shuffle(onlineIds(room));
      if (roster.length < MIN_PLAYERS) return "حداقل ۳ نفر";
      const cat = room.settings.cat === "mixed" ? pick(CATEGORY_KEYS) : room.settings.cat;
      const spyN = roster.length >= 6 ? room.settings.spyCount : 1;
      room.game = {
        ...freshGame(),
        phase: "play",
        round: g.round + 1,
        cat,
        word: pick(CATEGORIES[cat].words),
        spies: shuffle(roster).slice(0, spyN),
        roster,
        starter: pick(roster),
        endsAt: Date.now() + room.settings.minutes * 60000,
      };
      return;
    }
    case "toVote":
      if (g.phase === "play" && g.roster.includes(me.id)) g.phase = "vote";
      return;
    case "vote":
      if (g.phase !== "vote" || !g.roster.includes(me.id)) return;
      if (!g.roster.includes(a.target) || a.target === me.id) return;
      g.votes[me.id] = a.target;
      maybeResolve(room);
      return;
    case "countNow":
      if (g.phase === "vote" && Object.keys(g.votes).length) resolveVotes(room);
      return;
    case "guess": {
      const can = g.spies.includes(me.id) && (g.phase === "play" || (g.phase === "last" && g.accused === me.id));
      if (!can || !CATEGORIES[g.cat].words.includes(a.word)) return;
      finish(room, { outcome: a.word === g.word ? "spy" : "town", guess: { by: me.id, word: a.word }, reason: g.phase === "last" ? "last" : "early" });
      return;
    }
    case "lobby":
      if (g.phase === "result" || isHost) room.game = { ...freshGame(), round: g.round };
      return;
    case "resetScores":
      if (isHost) room.scores = {};
      return;
    case "leave": {
      room.players.delete(me.id);
      for (const res of me.clients) res.end();
      if (room.host === me.id) room.host = onlineIds(room)[0] || [...room.players.keys()][0] || "";
      if (room.players.size === 0) rooms.delete(room.code);
      return;
    }
    default:
      return "نامعتبر";
  }
}

/* ---------- http ---------- */

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => {
      d += c;
      if (d.length > 1e4) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(d || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function auth(q) {
  const room = rooms.get(String(q.code || ""));
  const me = room && room.players.get(String(q.id || ""));
  if (!me || me.token !== q.token) return {};
  return { room, me };
}

const INDEX = path.join(__dirname, "public", "index.html");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const q = Object.fromEntries(url.searchParams);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return fs.createReadStream(INDEX).pipe(res);
  }

  if (req.method === "HEAD" && url.pathname === "/api/events") {
    res.writeHead(auth(q).room ? 200 : 403);
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    const { room, me } = auth(q);
    if (!room) return json(res, 403, { error: "دسترسی نداری" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": hi\n\n");
    me.clients.add(res);
    broadcast(room);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => {
      clearInterval(ping);
      me.clients.delete(res);
      if (rooms.has(room.code)) {
        if (room.host === me.id && !isOnline(me)) {
          setTimeout(() => {
            if (!isOnline(me) && room.host === me.id) {
              room.host = onlineIds(room)[0] || me.id;
              broadcast(room);
            }
          }, 15000);
        }
        maybeResolve(room);
        broadcast(room);
      }
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/create") {
    const b = await readBody(req);
    const name = cleanName(b.name);
    if (!name) return json(res, 400, { error: "اسمت رو بنویس" });
    const code = newCode();
    const room = { code, host: "", players: new Map(), settings: { cat: "places", minutes: 5, spyCount: 1 }, scores: {}, game: freshGame(), touched: Date.now() };
    rooms.set(code, room);
    return json(res, 200, { code, ...addPlayer(room, name) });
  }

  if (req.method === "POST" && url.pathname === "/api/join") {
    const b = await readBody(req);
    const name = cleanName(b.name);
    const room = rooms.get(String(b.code || ""));
    if (!name) return json(res, 400, { error: "اسمت رو بنویس" });
    if (!room) return json(res, 404, { error: "همچین اتاقی پیدا نشد" });
    if (room.players.size >= MAX_PLAYERS) return json(res, 409, { error: "اتاق پره" });
    return json(res, 200, { code: room.code, ...addPlayer(room, name) });
  }

  if (req.method === "POST" && url.pathname === "/api/action") {
    const b = await readBody(req);
    const { room, me } = auth(b);
    if (!room) return json(res, 403, { error: "دسترسی نداری" });
    const err = act(room, me, b);
    if (rooms.has(room.code)) broadcast(room);
    return json(res, err ? 400 : 200, err ? { error: err } : { ok: true });
  }

  json(res, 404, { error: "پیدا نشد" });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyone = [...room.players.values()].some(isOnline);
    if (!anyone && now - room.touched > ROOM_TTL) rooms.delete(code);
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log(`جاسوس روی پورت ${PORT} بالا اومد: http://localhost:${PORT}`));
