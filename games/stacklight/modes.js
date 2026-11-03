// STACKLIGHT modes (design B.9, C.5, slice T5): Free Play and Daily Ridge, the first-started-run rule, the run record, the
// local-first submit, the client-side replay check, the retry queue's storage keys, and what the title card shows for a Daily.
// No DOM here: storage, the clock and the boards are injected, so all of it runs in Node tests.
//
// Reuse, not copy: the 3-letter name entry, the board table data (createTable takes a game id), the text helpers and the
// key/value store come from games/starfall/modes.js UNCHANGED. The run record (createModes), the replay check and the Daily card
// are STACKLIGHT's own, because Starfall's are bound to Starfall's sim and game id.
//
// Boards are keyed by game ('stacklight') in leaderboard/api.js, so a STACKLIGHT row can never appear on a Starfall board or the
// other way round; the replay's own header carries game and version too (checked by the verifier below).
import { dailySeed } from '../../engine/rng.js';
import { decode, encode } from '../../engine/replay.js';
import { createSim } from './sim.js';
import { GAME_ID, GAME_VERSION, DAY_RULES, DAILY_START_LEVEL, REPLAY_MODES, INPUT_MASK } from './defs.js';
import {
  MODE_DAILY, MODE_FREE, LETTERS, NAME_LEN, ENTRY_TICKS, todayUTC, dailyNumber, dailyResetText, fmtScore, ratingText,
  memoryKv, storageKv as starfallStorageKv, createEntry, createTable
} from '../starfall/modes.js';
import { createSubmitQueue, gateReads, statusFor, READ_RETRY_MS } from '../starfall/submit-queue.js';

export {
  MODE_DAILY, MODE_FREE, LETTERS, NAME_LEN, ENTRY_TICKS, todayUTC, dailyNumber, dailyResetText, fmtScore, ratingText,
  memoryKv, createEntry, createTable, gateReads, statusFor, READ_RETRY_MS
};

export const KV_PREFIX = 'stacklight.';
export const storageKv = (backend, prefix = KV_PREFIX) => starfallStorageKv(backend, prefix);

// The local board as the page reads it: only runs of this major version. 2.0 changed the lock rule (D111, D117),
// so a 1.0 run saved on this device must not show on the 2.0 table. Writes and every other read go to lb unchanged.
// (The remote board is already one board per major version on the server.)
export function versionBoard(lb, version = GAME_VERSION) {
  return { ...lb, getBoard: (o = {}) => lb.getBoard({ ...o, version }) };
}

// games/stacklight is scanned for impure APIs (tests/stacklight-sim.test.js), so the page hands the wall clock in
// (stacklight.html sets window.__wallClock) and a day key is read here with plain calendar arithmetic (days from civil).
export const wallClock = () => (typeof globalThis.__wallClock === 'function' ? globalThis.__wallClock() : performance.timeOrigin + performance.now());
const DAY_MS = 86400000;
export function utcDayMs(k) { // ms of 00:00 UTC of a 'YYYY-MM-DD' key, NaN for anything else (including 2026-02-31)
  const m = typeof k === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(k) : null;
  if (!m) return NaN;
  let y = +m[1]; const mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
  y -= mo <= 2 ? 1 : 0;
  const era = Math.floor(y / 400), yoe = y - era * 400, doy = Math.floor((153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const ms = (era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468) * DAY_MS;
  return todayUTC(ms) === k ? ms : NaN;
}
const realDayKey = k => Number.isFinite(utcDayMs(k));
// replay header mode for each claimed mode (leaderboard/api.js says 'free' or 'daily'; the replay string says 'arcade' or 'daily')
const MODE_HEADER = { [MODE_DAILY]: 'daily', [MODE_FREE]: 'arcade' };

// ---------- replay re-simulation (the local board's verifier and the tests) ----------
// Returns { score, frames, level, hash, seed, mode, version, done }. Throws if the replay is not this game and version.
export function resimReplay(str, strictEnd = false) {
  const r = decode(str);
  if (r.game !== GAME_ID) throw new Error(`replay is for "${r.game}", not ${GAME_ID}`);
  if (r.version !== GAME_VERSION) throw new Error(`replay is version ${r.version}, this sim is ${GAME_VERSION}`);
  if (REPLAY_MODES.indexOf(r.mode) < 0) throw new Error('replay mode ' + r.mode + ' is not playable');
  const sim = createSim({ seed: r.seed, mode: r.mode });
  for (let i = 0; i < r.words.length; i++) {
    if (strictEnd && sim.done) throw new Error('replay carries frames after the run ended');
    if (r.words[i] & ~INPUT_MASK) throw new Error('replay has a reserved input bit');
    sim.step(r.words[i]); sim.clearEvents();
  }
  return { score: sim.score, frames: sim.frame, level: sim.level, hash: sim.stateHash(), seed: r.seed, mode: r.mode, version: r.version, done: sim.done };
}

// For createLeaderboard({ verifyReplay }) on this device: the stored score must be what the replay really scores, the run must be
// finished, and the claim must be honest (same game, version, seed, a header mode that fits the claimed mode, and for a Daily the
// real day seed within 1 day of now). Anything else gives NaN, which the leaderboard rejects. It is the same rule set as the server's
// STACKLIGHT verifier (server/games.js) without importing it. A seed the board handed out this page (begin with a /daily answer)
// is also taken for its day, as on Starfall's local board.
const boardSeeds = new Map(); // dayKey -> seed from GET /daily, this page only
export function makeVerifyReplay({ now = wallClock, version = GAME_VERSION, dailySeedOf = null } = {}) {
  return function verifyReplay({ replay, seed, mode, dayKey, version: claimedVersion, game }) {
    const want = MODE_HEADER[mode];
    if (!want || typeof seed !== 'number' || typeof replay !== 'string') return NaN;
    if (game !== undefined && game !== GAME_ID) return NaN;
    let h; try { h = decode(replay); } catch (e) { return NaN; }
    if (encode(h, h.words) !== replay) return NaN; // one run, one string
    if (h.game !== GAME_ID || h.mode !== want || h.seed !== seed) return NaN;
    if (h.version !== version || String(claimedVersion) !== String(version)) return NaN;
    if (mode === MODE_DAILY) {
      if (typeof dayKey !== 'string') return NaN;
      let ds; try { ds = dailySeed(dayKey); if (dailySeedOf) ds = dailySeedOf(dayKey); } catch (e) { return NaN; }
      const dayMs = utcDayMs(dayKey);
      if (!(seed === ds || (!dailySeedOf && boardSeeds.get(dayKey) === seed)) || !Number.isFinite(dayMs)) return NaN;
      if (now && Math.abs(dayMs - utcDayMs(todayUTC(now()))) > DAY_MS) return NaN;
    }
    try { const r = resimReplay(replay, true); return r.done ? r.score : NaN; } catch (e) { return NaN; }
  };
}

// ---------- run rules ----------
// a cached Daily answer whose ticket first arrived more than this long ago is asked for again when the run starts (main.js).
// Why 60 s: the server's window is play time + 610 s from the ticket, so a ticket at most a minute old leaves 9 minutes for pause, name and send.
export const TICKET_FRESH_MS = 60000;
export function createModes({ lb, kv = memoryKv(), now = wallClock, game = GAME_ID, version = GAME_VERSION } = {}) {
  const attemptKey = day => 'daily-attempt:' + day;
  const ticketSeen = new Map(); // ticket string -> client time (ms) it was first seen
  return {
    todayKey: () => todayUTC(now()),
    attemptUsed: day => kv.get(attemptKey(day)) != null,
    // A run record: ranked is decided by claim() on the first sim frame.
    // server (remote board on): the answer of GET /daily?game=stacklight. The run then uses the board's day, seed and ticket, never
    // the public seed; an answer that is not a real day and a uint32 seed throws (the caller shows the Daily as unavailable).
    begin(mode, freeSeed, server) {
      if (mode === MODE_DAILY && server !== undefined) {
        const s = server;
        if (!s || typeof s !== 'object' || !realDayKey(s.dayKey) || !Number.isInteger(s.seed) || s.seed < 0 || s.seed > 0xffffffff ||
          !(s.ticket === null || (typeof s.ticket === 'string' && s.ticket.length > 0 && s.ticket.length <= 64))) throw new Error('bad daily answer from the board');
        if (boardSeeds.size >= 8) boardSeeds.clear();
        boardSeeds.set(s.dayKey, s.seed);
        // when this ticket first reached the page (main.js calls begin the moment the answer arrives, and again
        // when a cached answer starts a run, which must not look fresh): the send queue times the ticket window from it
        let ticketAt;
        if (s.ticket) {
          if (ticketSeen.has(s.ticket)) ticketAt = ticketSeen.get(s.ticket);
          else { if (ticketSeen.size >= 8) ticketSeen.clear(); ticketAt = now(); ticketSeen.set(s.ticket, ticketAt); }
        }
        return { mode, dayKey: s.dayKey, seed: s.seed, ticket: s.ticket, ...(ticketAt !== undefined && { ticketAt }), fromServer: true, claimed: false, ranked: false, submitted: false };
      }
      if (mode === MODE_DAILY) { const dayKey = todayUTC(now()); return { mode, dayKey, seed: dailySeed(dayKey), claimed: false, ranked: false, submitted: false }; }
      if (mode === MODE_FREE) return { mode, dayKey: null, seed: freeSeed >>> 0, claimed: false, ranked: false, submitted: false };
      throw new Error('mode must be daily or free');
    },
    // may a run start on this cached /daily answer? Yes without a ticket (nothing to go stale); with one only if this page
    // first saw it at most TICKET_FRESH_MS ago. A ticket never seen here, or a clock that went back, counts as old (ask again).
    ticketFresh(s) {
      if (!s || !s.ticket) return true;
      if (!ticketSeen.has(s.ticket)) return false;
      const age = now() - ticketSeen.get(s.ticket);
      return age >= 0 && age <= TICKET_FRESH_MS;
    },
    // a local Daily whose UTC day is no longer today (started at 23:59:59, first sim frame after midnight): the caller starts it
    // again so the day, the seed and the sim agree. A Daily from the board is never stale: its day and seed come together from the
    // server, and this device's clock may not match the server's.
    stale: run => !!run && run.mode === MODE_DAILY && !run.fromServer && run.dayKey !== todayUTC(now()),
    // Called on the first sim frame of a run. Daily: the first started run of the UTC day is ranked, later runs are practice. The
    // marker is written at once, so quitting still uses the attempt. Free Play: every run ranks.
    claim(run) {
      if (run.claimed) return run.ranked;
      run.claimed = true;
      if (run.mode === MODE_DAILY) {
        if (kv.get(attemptKey(run.dayKey)) != null) run.ranked = false;
        else { kv.set(attemptKey(run.dayKey), '1'); run.ranked = true; }
      } else run.ranked = true;
      return run.ranked;
    },
    // test starts and runs the page started with a chosen seed have no run record, so they never reach here
    canSubmit(run, sim) {
      return !!run && run.claimed && run.ranked && !run.submitted && !!sim && sim.done && sim.score > 0 && sim.mode === MODE_HEADER[run.mode];
    },
    // the exact submit body for this run (the local board gets it first; the remote queue keeps a copy to send)
    body(run, sim, replay, name, playerId) {
      return { game, playerId, name, score: sim.score, replay, seed: run.seed, mode: run.mode,
        ...(run.dayKey && { dayKey: run.dayKey }), ...(run.ticket && { ticket: run.ticket }), version,
        stats: { hash: String(sim.stateHash()), frames: sim.frame, stage: sim.level } };
    },
    async submit(run, sim, replay, name, playerId) {
      if (!this.canSubmit(run, sim)) throw new Error('this run cannot be submitted');
      run.submitted = true;
      try {
        return await lb.submitScore(this.body(run, sim, replay, name, playerId));
      } catch (e) { run.submitted = false; throw e; }
    }
  };
}

// ---------- the Daily card (title) ----------
// What the title shows for a Daily seed, read from a sim BUILT FROM THAT SEED (never recomputed here): the ridge the sim put on
// the board, the day rule, the start level. Called when the seed is known or changes, never per frame; its strings are kept.
export function dailyCard(seed, dayKey) {
  const sim = createSim({ seed, mode: MODE_HEADER[MODE_DAILY] });
  const i = sim.info();
  return {
    seed: seed >>> 0, dayKey, grid: sim.grid, ridge: i.ridge, rule: i.dayRule, level: i.level,
    levelStr: 'LEVEL ' + i.level, no: dailyNumber(dayKey), noStr: dailyNumber(dayKey) ? 'DAILY NO. ' + dailyNumber(dayKey) : 'DAILY ' + dayKey
  };
}
export const RULE_NOTE = { 'LEAN': 'MORE PLUS, FEWER BARS', 'SHORT SIGHT': 'NEXT SHOWS ONE PIECE', 'QUICK GLOW': 'GLOW LASTS 2.5 SECONDS' };
export const DAILY_LEVEL = DAILY_START_LEVEL;
export { DAY_RULES };

// ---------- the retry queue (Starfall's module, unchanged, on STACKLIGHT's own storage key and lock names) ----------
// games/starfall/submit-queue.js keeps its queue at 'starfall.sendq' and sends under the locks 'starfall-sendq-*'. STACKLIGHT uses
// the same module through two adapters, so nothing of Starfall changes and the two games' queues never meet:
//   - a storage view that renames the key prefix 'starfall.' to 'stacklight.'
//   - a lock view that renames the lock names the same way
// Its entry check (validBody) only needs game, a player id, a name, a score, a replay, a seed, mode free|daily and the version, all
// of which this game's body has.
export const QUEUE_KEY = 'stacklight.sendq';
const rename = s => (typeof s === 'string' && s.startsWith('starfall') ? 'stacklight' + s.slice(8) : s);
export function queueBackend(backend) {
  const ls = () => { try { return backend !== undefined ? backend : globalThis.localStorage || null; } catch (e) { return null; } };
  const need = () => { const s = ls(); if (!s) throw new Error('no localStorage'); return s; };
  return { getItem: k => need().getItem(rename(k)), setItem: (k, v) => need().setItem(rename(k), v), removeItem: k => need().removeItem(rename(k)) };
}
export function queueLocks(locks) {
  let L = locks;
  if (L === undefined) { try { L = globalThis.navigator && globalThis.navigator.locks; } catch (e) { L = null; } }
  if (!L || typeof L.request !== 'function') return null;
  return { request: (name, fn) => L.request(rename(name), fn) };
}
export function createStacklightQueue({ remote, backend, locks, now, onEvent } = {}) {
  return createSubmitQueue({ remote, backend: queueBackend(backend), locks: queueLocks(locks), ...(now && { now }), version: GAME_VERSION, onEvent });
}
