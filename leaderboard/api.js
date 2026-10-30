// Leaderboard API. Storage-agnostic: pass any adapter with async get/set/remove/keys.
import { memoryAdapter, trimBoard, isPlayerId } from './storage.js';
import { leagueFor, listLeagues as leaguesList, seasonFor, topRuns, average5, carryOver, seasonTrophies, percentile } from './ranking.js';

export class LeaderboardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LeaderboardError';
    this.code = code;
  }
}
const bad = (code, msg) => new LeaderboardError(code, msg);

const NAME_RE = /^[A-Z0-9 .-]{1,10}$/;
const ASCII_RE = /^[\x20-\x7E]*$/;
const GAME_RE = /^[a-z0-9_-]{1,32}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const BOARD_CAP = 100;
const MAX_STATS_JSON = 2000;
// Replay cap. The server re-simulates runs up to MAX_RUN_FRAMES (60 minutes at 60 Hz). The densest input an
// honest client records is touch: the steer-to x changes every frame, so every frame is its own run of length 1. A
// word is at most 13 bits (input-word.js: bits 13-15 are always 0), so a varint word is at most 2 bytes and the run
// length 1 byte: 3 bytes a frame, which is 4 base64url chars. Measured on a touch run that moves every frame:
// 4.00 chars a frame (tests/server-w22-limits.test.js). Cap = 216,000 frames x 4 chars + 64 for the header = 864,064.
export const MAX_RUN_FRAMES = 216000;
export const REPLAY_CHARS_PER_FRAME = 4;
export const MAX_REPLAY_CHARS = MAX_RUN_FRAMES * REPLAY_CHARS_PER_FRAME + 64;
const DAY_MS = 86400000;

const byRank = (a, b) => b.score - a.score || a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const dayKeyOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (key) => {
  if (!DAY_RE.test(key)) return NaN;
  const ms = Date.parse(`${key}T00:00:00Z`);
  return Number.isNaN(ms) || dayKeyOf(ms) !== key ? NaN : ms; // rejects 2026-02-31 and 9999-99-99
};

// 53-bit string hash (cyrb53). Used for duplicate detection and ids, not security.
export function hashReplay(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + str.length.toString(36);
}

function validEntry(e) {
  return e && typeof e === 'object' && typeof e.id === 'string' && typeof e.name === 'string' &&
    Number.isInteger(e.score) && e.score >= 0 && isNum(e.t) && typeof e.date === 'string' &&
    typeof e.pid === 'string' && (e.mode === 'daily' || e.mode === 'free');
}
// Corrupted storage never throws: unreadable boards become empty, bad rows are dropped.
function cleanBoard(raw) {
  return Array.isArray(raw) ? raw.filter(validEntry).sort(byRank) : [];
}
function cleanPlayer(raw) {
  if (!raw || typeof raw !== 'object' || !isNum(raw.trophies) || !Number.isInteger(raw.season)) return null;
  const top = Array.isArray(raw.top) ? topRunsOf(raw.top) : [];
  return { name: typeof raw.name === 'string' ? raw.name : '', trophies: Math.max(0, Math.floor(raw.trophies)), season: raw.season,
    best: isNum(raw.best) ? raw.best : 0, seasonBest: isNum(raw.seasonBest) ? raw.seasonBest : null,
    // A record saved before the best-5 rule has no best-5 list: its trophies become this season's floor, so nobody loses them.
    top, carry: Math.max(0, Math.floor(isNum(raw.carry) ? raw.carry : Array.isArray(raw.top) ? 0 : raw.trophies)) };
}

// A stored best-5 list, cleaned: whole numbers 0 or more, best first, at most 5.
function topRunsOf(list) {
  let top = [];
  for (const v of list) if (Number.isSafeInteger(v) && v >= 0) top = topRuns(top, v).top;
  return top;
}

// One best entry per player (by playerId), sorted best-first.
function uniqueBest(entries) {
  const seen = new Set();
  return entries.filter((e) => (seen.has(e.pid) ? false : (seen.add(e.pid), true)));
}
// Where `score` would rank among OTHER players' bests; a tie goes to the earlier submission.
function placement(entries, pid, score) {
  const others = uniqueBest(entries).filter((e) => e.pid !== pid);
  return { rank: 1 + others.filter((e) => e.score >= score).length, n: others.length + 1 };
}

function randomTag() {
  try { return globalThis.crypto.randomUUID().slice(0, 6); } catch { return Math.random().toString(36).slice(2, 8).padEnd(6, '0'); }
}

// Field checks for one submitScore input (no storage, no verifier). Exported so a server can refuse bad input
// before it spends CPU re-simulating the replay. Throws LeaderboardError; returns the cleaned fields.
export function validateSubmission(input) {
  if (!input || typeof input !== 'object') throw bad('bad_input', 'input must be an object');
  const { game, score, replay, seed, mode, version, stats } = input;
  if (typeof game !== 'string' || !GAME_RE.test(game)) throw bad('bad_game', 'game must be 1..32 chars of a-z 0-9 _ -');
  if (!isPlayerId(input.playerId)) throw bad('bad_player', 'playerId must be 8..64 chars of A-Z a-z 0-9 _ -');
  if (typeof input.name !== 'string' || !ASCII_RE.test(input.name)) throw bad('bad_name', 'name must be plain ASCII');
  const name = input.name.toUpperCase().trim();
  if (!NAME_RE.test(name) || !/[A-Z0-9]/.test(name)) throw bad('bad_name', 'name must be 1..10 chars of A-Z 0-9 space . - with a letter or digit');
  if (!Number.isSafeInteger(score) || score < 0) throw bad('bad_score', 'score must be a non-negative safe integer');
  if (typeof replay !== 'string' || replay.length === 0) throw bad('missing_replay', 'replay string is required');
  if (replay.length > MAX_REPLAY_CHARS) throw bad('replay_too_large', `replay over ${MAX_REPLAY_CHARS} chars`);
  if (!((typeof seed === 'string' && seed) || isNum(seed))) throw bad('bad_seed', 'seed is required');
  if (mode !== 'daily' && mode !== 'free') throw bad('bad_mode', "mode must be 'daily' or 'free'");
  if (!((typeof version === 'string' && version) || isNum(version))) throw bad('bad_version', 'version is required');
  if (input.dayKey !== undefined && !(typeof input.dayKey === 'string' && Number.isFinite(dayMs(input.dayKey)))) throw bad('bad_day', 'dayKey must be a real date, YYYY-MM-DD');
  if (stats !== undefined) {
    let ok = false;
    try { ok = stats !== null && typeof stats === 'object' && JSON.stringify(stats).length <= MAX_STATS_JSON; } catch { /* circular */ }
    if (!ok) throw bad('bad_stats', 'stats must be a small plain object');
  }
  return { game, pid: input.playerId, name, score, replay, seed, mode, version, stats, dayKey: input.dayKey };
}

export function createLeaderboard({ storage = memoryAdapter(), now = () => Date.now(), verifyReplay, instanceId } = {}) {
  let chain = Promise.resolve(); // serialises writes inside this instance
  const localLock = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  // The whole submit runs under one lock: the adapter's (shared by every instance and, in browsers, tab) if it has one.
  const locked = (fn) => (typeof storage.withLock === 'function' ? storage.withLock('leaderboard-submit', fn) : localLock(fn));
  const inst = (instanceId ?? randomTag()).replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'x';
  let counter = 0;

  const keyAll = (g) => `board:${g}:all`;
  const keySeason = (g, id) => `board:${g}:season:${id}`;
  const keyDaily = (g, d) => `board:${g}:daily:${d}`;
  const keyPlayer = (g, p) => `player:${g}:${p}`;
  const loadBoard = async (k) => cleanBoard(await storage.get(k));

  // Load a player, applying any season resets since they last played. Never lowers the stored season.
  // p.trophies is the last rating worked out for them; a reset keeps half of it as this season's floor (carry).
  async function loadPlayer(game, pid, seasonId) {
    const p = cleanPlayer(await storage.get(keyPlayer(game, pid))) ||
      { name: '', trophies: 0, season: seasonId, best: 0, seasonBest: null, top: [], carry: 0 };
    if (seasonId > p.season) {
      p.carry = carryOver(p.trophies, Math.min(seasonId - p.season, 60));
      p.trophies = p.carry;
      p.season = seasonId;
      p.seasonBest = null;
      p.top = [];
    }
    return p;
  }

  // Best-5 rule: rate `p` (its best 5 this season) against every other player of this game stored here this season.
  // On this device that is everyone who played in this browser; the server rates against everyone online.
  // Players whose best-5 average is 0 are not in the field (runs of score 0..4 must not lift the players above them).
  async function rate(game, pid, p, seasonId) {
    const avg = average5(p.top);
    let below = 0, ties = 0, others = 0, zeros = 0;
    const prefix = keyPlayer(game, '');
    for (const k of await storage.keys(prefix)) {
      if (k === keyPlayer(game, pid)) continue;
      const o = cleanPlayer(await storage.get(k));
      if (!o || o.season !== seasonId || !o.top.length) continue;
      const a = average5(o.top);
      if (a === 0) { zeros++; continue; } // a zero average is left out of the field: it cannot lift anyone (griefer guard)
      others++;
      if (a < avg) below++; else if (a === avg) ties++;
    }
    const rated = p.top.length > 0;
    const trophies = seasonTrophies({ rated, below, ties, others, carry: p.carry });
    return { trophies, avg5: avg, percentile: rated ? percentile({ below, ties, others }) : null, players: others + zeros + (rated ? 1 : 0) }; // head count, zero averages included
  }

  async function dropRef(id, boardKey) {
    const rec = await storage.get(`replay:${id}`);
    if (!rec || typeof rec !== 'object') return;
    const refs = Array.isArray(rec.refs) ? rec.refs.filter((k) => k !== boardKey) : [];
    if (refs.length) await storage.set(`replay:${id}`, { ...rec, refs });
    else await storage.remove(`replay:${id}`);
  }

  async function submitScore(input) {
    const c = validateSubmission(input);
    const hash = hashReplay(c.replay);
    if (verifyReplay) {
      let res;
      try { res = await verifyReplay({ game: c.game, replay: c.replay, seed: c.seed, mode: c.mode, dayKey: c.dayKey, version: c.version, score: c.score }); }
      catch (e) { throw bad('replay_error', `replay verification failed: ${e?.message ?? e}`); }
      const got = typeof res === 'number' ? res : res && typeof res === 'object' && res.ok !== false ? res.score : undefined;
      if (got !== c.score) throw bad('replay_mismatch', `replay scores ${got}, claimed ${c.score}`);
    }
    return locked(async () => {
      const t = now();
      const season = seasonFor(t);
      const dayKey = c.mode === 'daily' ? (c.dayKey ?? dayKeyOf(t)) : undefined;
      // Without a verifier the claimed day cannot be checked, so it must be today (UTC) give or take a day.
      if (dayKey && !verifyReplay && Math.abs(dayMs(dayKey) - dayMs(dayKeyOf(t))) > DAY_MS) throw bad('bad_day', 'dayKey must be within 1 day of today (UTC)');
      const dupKey = `rh:${c.game}:${hash}`;
      if ((await storage.get(dupKey)) != null) throw bad('duplicate_replay', 'this replay was already submitted');

      const undo = []; // [key, previous raw value] for every key this submit writes, to roll back on failure
      const put = async (key, val) => {
        if (!undo.some((u) => u[0] === key)) undo.push([key, await storage.get(key)]);
        await storage.set(key, val);
      };
      const id = `${Math.max(0, Math.floor(t)).toString(36).padStart(10, '0')}-${(++counter).toString(36).padStart(5, '0')}${inst}-${hash}`;
      const entry = { id, t, name: c.name, pid: c.pid, score: c.score, date: new Date(t).toISOString(), mode: c.mode, ...(dayKey && { dayKey }) };

      let player, before, beforeRate, afterRate, entered;
      const placements = {};
      const dropped = []; // [id, boardKey]
      try {
        player = await loadPlayer(c.game, c.pid, season.id);
        const targets = [['all', keyAll(c.game)], ['season', keySeason(c.game, season.id)]];
        if (dayKey) targets.push(['daily', keyDaily(c.game, dayKey)]);

        const refs = [];
        for (const [label, key] of targets) {
          // Read right before write so another instance's rows are merged; then verify our row landed
          // (a second instance can overwrite between our read and write) and retry a few times if not.
          let trimmed, entries, keep;
          for (let attempt = 0; attempt < 5; attempt++) {
            entries = (await loadBoard(key)).filter((e) => e.id !== id);
            const merged = [...entries, entry].sort(byRank);
            trimmed = trimBoard(merged, BOARD_CAP);
            keep = new Set(trimmed.map((e) => e.id));
            await put(key, trimmed);
            if (!keep.has(id) || (await loadBoard(key)).some((e) => e.id === id)) break;
          }
          const place = placement(entries, c.pid, c.score);
          placements[label] = place.rank;
          for (const e of [...entries, entry]) if (!keep.has(e.id) && e.id !== id) dropped.push([e.id, key]);
          if (keep.has(id)) refs.push(key);
        }

        // Best-5 rule: only a run that gets into the player's best 5 this season can change their rating.
        beforeRate = await rate(c.game, c.pid, player, player.season); // player.season >= season.id (a clock that went back)
        before = leagueFor(beforeRate.trophies);
        const tr = topRuns(player.top, c.score);
        entered = tr.entered;
        player.top = tr.top;
        afterRate = entered ? await rate(c.game, c.pid, player, player.season) : beforeRate;
        player.name = c.name;
        player.trophies = afterRate.trophies;
        player.best = Math.max(player.best, c.score);
        player.seasonBest = Math.max(player.seasonBest ?? 0, c.score);
        await put(keyPlayer(c.game, c.pid), player);

        await put(dupKey, id);
        // The replay lives while any board still lists its entry; each board's trim removes only its own reference.
        if (refs.length) {
          await put(`replay:${id}`, { id, game: c.game, name: c.name, score: c.score, seed: c.seed, mode: c.mode,
            dayKey: dayKey ?? null, version: c.version, replay: c.replay, date: entry.date, stats: c.stats ?? null, refs });
        }
      } catch (e) {
        for (const [key, raw] of undo.reverse()) {
          try { if (raw == null) await storage.remove(key); else await storage.set(key, raw); } catch { /* best effort */ }
        }
        throw e;
      }
      for (const [did, key] of dropped) await dropRef(did, key);

      const after = leagueFor(player.trophies);
      const out = { id, placements, trophyDelta: afterRate.trophies - beforeRate.trophies, trophies: player.trophies,
        league: { name: after.name, tier: after.tier, label: after.label },
        rating: { avg5: afterRate.avg5, top5: player.top.slice(), enteredTop5: entered, percentile: afterRate.percentile } };
      if (after.rung > before.rung) { out.promoted = true; out.from = before.label; }
      if (after.rung < before.rung) { out.demoted = true; out.from = before.label; }
      if (storage.degraded === true) out.storageDegraded = true;
      return out;
    });
  }

  const wholeNum = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0;

  // Boards show one best run per player by default; pass unique:false for every run.
  async function getBoard({ game, board = 'all', key, limit = 10, offset = 0, unique = true } = {}) {
    if (typeof game !== 'string' || !GAME_RE.test(game)) throw bad('bad_game', 'game required');
    if (!wholeNum(limit) || !wholeNum(offset)) throw bad('bad_board', 'limit and offset must be whole numbers, 0 or more');
    let k;
    if (board === 'all') k = keyAll(game);
    else if (board === 'season') {
      const sid = key === undefined ? seasonFor(now()).id : typeof key === 'string' && /^-?\d+$/.test(key) ? Number(key) : key;
      if (!Number.isSafeInteger(sid)) throw bad('bad_board', 'season key must be an integer season id');
      k = keySeason(game, sid);
    } else if (board === 'daily') {
      const day = key ?? dayKeyOf(now());
      if (typeof day !== 'string' || !Number.isFinite(dayMs(day))) throw bad('bad_board', 'daily key must be a real date, YYYY-MM-DD');
      k = keyDaily(game, day);
    } else throw bad('bad_board', "board must be 'all', 'daily' or 'season'");
    let rows = await loadBoard(k);
    if (unique) rows = uniqueBest(rows);
    const lim = Math.min(100, limit);
    return rows.slice(offset, offset + lim).map((e, i) => ({ rank: offset + i + 1, name: e.name, score: e.score, date: e.date, mode: e.mode, id: e.id }));
  }

  async function getRank({ game, playerId } = {}) {
    if (typeof game !== 'string' || !GAME_RE.test(game)) throw bad('bad_game', 'game required');
    if (!isPlayerId(playerId)) throw bad('bad_player', 'playerId required');
    const season = seasonFor(now());
    const p = await loadPlayer(game, playerId, season.id); // read-only: resets are applied in memory only
    const r = await rate(game, playerId, p, p.season);
    const lg = leagueFor(r.trophies);
    return { trophies: r.trophies, league: lg.name, tier: lg.tier, season, best: p.best, seasonBest: p.seasonBest ?? 0,
      avg5: r.avg5, top5: p.top.slice(), percentile: r.percentile, players: r.players, carry: p.carry };
  }

  async function getReplay(id) {
    if (typeof id !== 'string') return null;
    const r = await storage.get(`replay:${id}`);
    if (!r || typeof r !== 'object' || typeof r.replay !== 'string') return null;
    const { refs, ...pub } = r; // eslint-disable-line no-unused-vars
    return pub;
  }

  return {
    submitScore, getBoard, getRank, getReplay,
    getSeason: async (at = now()) => seasonFor(at instanceof Date ? at.getTime() : at),
    listLeagues: async () => leaguesList(),
  };
}
