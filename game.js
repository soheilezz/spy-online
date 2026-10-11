// منطق خالص بازی جاسوس (بدون Firebase و بدون DOM).
// همون قوانین server.js قبلیه، فقط حالا روی گوشی میزبان اجرا می‌شه.
import { CATEGORIES, CATEGORY_KEYS } from "./words.js";

export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 16;
export const MAX_MINUTES = 180;
export const MAX_ROUNDS = 50;
export const MAX_CUSTOM = 200; // حداکثر کلمه‌ی اضافه برای هر دسته
export const NOW = "__NOW__"; // جای‌گیر زمان سرور؛ لایه شبکه می‌ذاره serverTimestamp

export const rand = (n) => {
  const a = new Uint32Array(1);
  const lim = Math.floor(4294967296 / n) * n;
  do crypto.getRandomValues(a);
  while (a[0] >= lim);
  return a[0] % n;
};
const pick = (a) => a[rand(a.length)];
const shuffle = (a) => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};

export const newRoom = (code, host) => ({
  code,
  host,
  settings: { cat: "places", minutes: 5, spyCount: 1, rounds: 5 },
  scores: {},
  played: 0, // چند دور از این بازی تموم شده
  custom: {}, // کلمه‌هایی که میزبان اضافه کرده: { cat: [word] }
  kicked: [], // کسایی که میزبان بیرون کرده
  phase: "lobby", // lobby | play | vote | last | result
  round: 0,
  cat: "",
  roster: [],
  starter: "",
  accused: "",
  votedIds: [],
  result: null,
  startedAt: null,
});

export const totalRounds = (room) => room.settings.rounds || 5;
export const wordsOf = (room, cat) => (CATEGORIES[cat] ? CATEGORIES[cat].words.concat((room.custom && room.custom[cat]) || []) : []);
const cleanWord = (w) => String(w || "").replace(/\s+/g, " ").trim();

// حالت مخفی که فقط میزبان می‌بینه: کلمه، جاسوس‌ها و رأی‌ها
export const newPriv = () => ({ word: "", spies: [], votes: {} });

function finish(room, priv, f) {
  room.phase = "result";
  if (f.accused !== undefined) room.accused = f.accused;
  room.result = { word: priv.word, spies: priv.spies, outcome: f.outcome, reason: f.reason, guess: f.guess || null };
  const scores = { ...room.scores };
  if (f.outcome === "town") room.roster.filter((id) => !priv.spies.includes(id)).forEach((id) => (scores[id] = (scores[id] || 0) + 1));
  else priv.spies.forEach((id) => (scores[id] = (scores[id] || 0) + 2));
  room.scores = scores;
  room.played = (room.played || 0) + 1;
}

function resolveVotes(room, priv) {
  const tally = {};
  Object.entries(priv.votes).forEach(([voter, t]) => room.roster.includes(voter) && (tally[t] = (tally[t] || 0) + 1));
  const max = Math.max(0, ...Object.values(tally));
  const top = Object.keys(tally).filter((id) => tally[id] === max);
  if (top.length === 1 && priv.spies.includes(top[0])) {
    room.phase = "last";
    room.accused = top[0];
  } else {
    finish(room, priv, { outcome: "spy", accused: top.length === 1 ? top[0] : "", reason: top.length === 1 ? "wrong" : "tie" });
  }
}

function maybeResolve(room, priv, env) {
  if (room.phase !== "vote") return;
  const online = new Set(env.onlineIds);
  const voters = room.roster.filter((id) => online.has(id));
  if (voters.length && voters.every((id) => priv.votes[id])) resolveVotes(room, priv);
}

// room و priv رو دست‌کاری می‌کنه. خروجی: { error?, secrets?, clearSecrets? }
export function applyAction(room, priv, a, env) {
  const isHost = room.host === a.by;
  switch (a.type) {
    case "settings": {
      if (!isHost || room.phase !== "lobby") return { error: "فقط میزبان" };
      const s = { ...room.settings };
      if (a.cat && (a.cat === "mixed" || CATEGORIES[a.cat])) s.cat = a.cat;
      if (Number.isInteger(a.minutes)) s.minutes = Math.min(MAX_MINUTES, Math.max(1, a.minutes));
      if (Number.isInteger(a.rounds)) s.rounds = Math.min(MAX_ROUNDS, Math.max(1, a.rounds));
      if (Number.isInteger(a.spyCount)) s.spyCount = Math.min(2, Math.max(1, a.spyCount));
      room.settings = s;
      return {};
    }
    case "start": {
      if (!isHost) return { error: "فقط میزبان" };
      if (room.phase !== "lobby" && room.phase !== "result") return {};
      const kicked = room.kicked || [];
      const roster = shuffle(env.onlineIds.filter((id) => !kicked.includes(id)));
      if (roster.length < MIN_PLAYERS) return { error: "حداقل ۳ نفر" };
      const cat = room.settings.cat === "mixed" ? pick(CATEGORY_KEYS) : room.settings.cat;
      const spyN = roster.length >= 6 ? room.settings.spyCount : 1;
      const word = pick(wordsOf(room, cat));
      // بازی قبلی تموم شده؟ از نو
      if ((room.played || 0) >= totalRounds(room)) { room.scores = {}; room.played = 0; }
      const spies = shuffle(roster).slice(0, spyN);
      Object.assign(room, { phase: "play", round: room.round + 1, cat, roster, starter: pick(roster), accused: "", votedIds: [], result: null, startedAt: NOW });
      priv.word = word;
      priv.spies = spies;
      priv.votes = {};
      const secrets = {};
      roster.forEach((id) => (secrets[id] = { round: room.round, amSpy: spies.includes(id), word: spies.includes(id) ? "" : word }));
      return { secrets };
    }
    case "toVote":
      if (room.phase === "play" && room.roster.includes(a.by)) room.phase = "vote";
      return {};
    case "vote":
      if (room.phase !== "vote" || !room.roster.includes(a.by)) return {};
      if (!room.roster.includes(a.target) || a.target === a.by) return {};
      priv.votes[a.by] = a.target;
      room.votedIds = Object.keys(priv.votes);
      maybeResolve(room, priv, env);
      return {};
    case "countNow":
      if (room.phase === "vote" && room.roster.includes(a.by) && Object.keys(priv.votes).length) resolveVotes(room, priv);
      return {};
    case "tick":
      maybeResolve(room, priv, env);
      return {};
    case "guess": {
      const can = priv.spies.includes(a.by) && (room.phase === "play" || (room.phase === "last" && room.accused === a.by));
      if (!can || !wordsOf(room, room.cat).includes(a.word)) return {};
      finish(room, priv, { outcome: a.word === priv.word ? "spy" : "town", reason: room.phase === "last" ? "last" : "early", guess: { by: a.by, word: a.word } });
      return {};
    }
    case "lobby": {
      if (room.phase !== "result" && !isHost) return {};
      const old = room.roster;
      Object.assign(room, { phase: "lobby", cat: "", roster: [], starter: "", accused: "", votedIds: [], result: null, startedAt: null });
      priv.word = "";
      priv.spies = [];
      priv.votes = {};
      return { clearSecrets: old };
    }
    case "resetScores":
      if (isHost) { room.scores = {}; room.played = 0; }
      return {};
    case "addWord": {
      if (!isHost) return { error: "فقط میزبان" };
      const w = cleanWord(a.word);
      if (!CATEGORIES[a.cat]) return { error: "اول یه دسته انتخاب کن" };
      if (!w || w.length > 30) return { error: "کلمه باید بین ۱ تا ۳۰ حرف باشه" };
      if (wordsOf(room, a.cat).includes(w)) return { error: "این کلمه از قبل هست" };
      const list = ((room.custom && room.custom[a.cat]) || []).slice();
      if (list.length >= MAX_CUSTOM) return { error: "دیگه جا نداره" };
      list.push(w);
      room.custom = { ...(room.custom || {}), [a.cat]: list };
      return {};
    }
    case "removeWord": {
      if (!isHost || !room.custom || !room.custom[a.cat]) return {};
      room.custom = { ...room.custom, [a.cat]: room.custom[a.cat].filter((x) => x !== a.word) };
      return {};
    }
    case "kick": {
      const t = a.target;
      if (!isHost || !t || t === room.host) return { error: "نمی‌شه" };
      room.kicked = [...new Set([...(room.kicked || []), t])];
      if (room.roster.includes(t) && room.phase !== "lobby" && room.phase !== "result") {
        room.roster = room.roster.filter((id) => id !== t);
        delete priv.votes[t];
        for (const [voter, target] of Object.entries(priv.votes)) if (target === t) delete priv.votes[voter];
        room.votedIds = Object.keys(priv.votes);
        if (priv.spies.includes(t)) {
          priv.spies = priv.spies.filter((id) => id !== t);
          if (!priv.spies.length) { priv.spies = [t]; finish(room, priv, { outcome: "town", reason: "kicked" }); }
        } else maybeResolve(room, priv, env);
      }
      return { kick: t, clearSecrets: [t] };
    }
    default:
      return { error: "نامعتبر" };
  }
}
