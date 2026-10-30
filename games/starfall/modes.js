// Starfall modes (design B.7): Daily Flight and Free Play, the first-started rule, submitting finished runs
// to the local leaderboard with their replay, and the screens that go with it (name entry, high-score table).
// No DOM here: drawing functions get dot/text/panel from the caller, storage and the leaderboard are injected,
// so all of it runs in Node tests.
import { dailySeed } from '../../engine/rng.js';
import { decode, encode } from '../../engine/replay.js';
import { M_UP, M_DOWN, M_FIRE, M_BACK } from '../../engine/input.js';
import { createSim, GAME_ID, GAME_VERSION } from './sim.js';
import { CX } from './defs.js';
import { COL } from './sprites.js';
import { SEASON_EPOCH_MS } from '../../leaderboard/ranking.js';

export const MODE_DAILY = 'daily', MODE_FREE = 'free';
export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const NAME_LEN = 3;
export const ENTRY_TICKS = 1800; // 30 s, then the shown name is submitted

export const todayUTC = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const realDayKey = k => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(Date.parse(k + 'T00:00:00Z')) && todayUTC(Date.parse(k + 'T00:00:00Z')) === k;

// ---------- small text helpers for the daily row, the rating line and the share text (card 3b) ----------
const HOUR_MS = 3600000;
// LOW12: time to the next UTC day: whole hours ('NEW DAILY IN 5H'), minutes in the last hour ('NEW DAILY IN 42M')
export function dailyResetText(ms) {
  const left = 86400000 - (((ms % 86400000) + 86400000) % 86400000);
  return left >= HOUR_MS ? 'NEW DAILY IN ' + Math.floor(left / HOUR_MS) + 'H' : 'NEW DAILY IN ' + Math.max(1, Math.ceil(left / 60000)) + 'M';
}
// Daily #1 is launch day (the season epoch, 2026-10-30 UTC); null for a day before it or a bad key
export function dailyNumber(dayKey) {
  const ms = Date.parse(String(dayKey) + 'T00:00:00Z');
  if (!Number.isFinite(ms)) return null;
  const n = Math.floor((ms - SEASON_EPOCH_MS) / 86400000) + 1;
  return n >= 1 ? n : null;
}
export const fmtScore = n => (Number.isFinite(n) ? String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '0');
const isCount = v => Number.isInteger(v) && v > 0;
// Best-5 rating line from a submit result ({ rating: { avg5, percentile } }) or a rank result ({ avg5, percentile }).
// Never prints null, undefined or NaN: a missing number leaves its part out.
export function ratingText(r) {
  if (!r || typeof r !== 'object') return '';
  const src = r.rating && typeof r.rating === 'object' ? r.rating : r;
  const parts = [];
  if (Number.isFinite(src.avg5) && src.avg5 > 0) parts.push('BEST 5 AVG ' + Math.round(src.avg5));
  if (Number.isFinite(src.percentile)) parts.push('TOP ' + Math.max(1, Math.min(100, Math.round((1 - src.percentile) * 100))) + '%');
  else if (src.percentile === null && !parts.length) parts.push('NOT RATED THIS SEASON');
  return parts.join('  ');
}
// D35a share text: '<ARCADE> Daily #12 · 184,300 · Gold III' plus the page link on its own line
export function shareText({ arcade, dayKey, score, league, link }) {
  const n = dailyNumber(dayKey);
  let s = String(arcade) + ' Daily ' + (n ? '#' + n : String(dayKey)) + ' \u00b7 ' + fmtScore(score);
  if (typeof league === 'string' && league) s += ' \u00b7 ' + league;
  return link ? s + '\n' + link : s;
}
// the same text in the dot font (capitals, no '#' or middle dot): shown on screen when the clipboard is refused
export function shareScreenLines(text) {
  const [a, b = ''] = String(text).split('\n');
  const up = x => x.toUpperCase().replace(/\u00b7/g, '-').replace(/#/g, 'NO.').replace(/[^A-Z0-9 .:\-%/'+,()?=><*!]/g, ' ');
  return [up(a), up(b.replace(/^https?:\/\//, ''))];
}

// ---------- key/value store with a memory fallback (sync; used for the daily attempt marker and the last name) ----------
export function memoryKv() {
  const m = new Map();
  return { get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, String(v)); } };
}
export function storageKv(backend, prefix = 'starfall.') {
  const mem = memoryKv();
  const ls = () => { try { return backend || globalThis.localStorage || null; } catch (e) { return null; } };
  return {
    get(k) { try { const s = ls(); const v = s ? s.getItem(prefix + k) : null; return v != null ? v : mem.get(k); } catch (e) { return mem.get(k); } },
    set(k, v) { mem.set(k, v); try { const s = ls(); if (s) s.setItem(prefix + k, String(v)); } catch (e) { /* memory copy still counts this session */ } }
  };
}

// ---------- replay re-simulation (the leaderboard verifier and the tests use this) ----------
// Returns { score, frames, stage, hash, seed, mode, version }. Throws if the replay is not this game and version.
// strictEnd: a replay that carries frames after the sim has finished the run is refused (the extra frames change nothing
// the sim can see, so they would give one honest run many different strings).
export function resimReplay(str, strictEnd = false) {
  const r = decode(str);
  if (r.game !== GAME_ID) throw new Error(`replay is for "${r.game}", not ${GAME_ID}`);
  if (r.version !== GAME_VERSION) throw new Error(`replay is version ${r.version}, this sim is ${GAME_VERSION}`);
  const sim = createSim({ seed: r.seed, mode: r.mode });
  for (let i = 0; i < r.words.length; i++) {
    if (strictEnd && sim.done) throw new Error('replay carries frames after the run ended');
    sim.step(r.words[i]); sim.clearEvents();
  }
  return { score: sim.score, frames: sim.frame, stage: sim.stage, hash: sim.stateHash(), seed: r.seed, mode: r.mode, version: r.version };
}
// For createLeaderboard({ verifyReplay }): the stored score must be what the replay really scores, and the claim must be
// honest: same seed, same version, a header mode that fits the claimed mode, and for daily the real day seed within 1 day
// of now (leaderboard/api.js skips its own dayKey guard when a verifier is passed, so it is restored here).
// The replay must also be the canonical encoding of what it decodes to (no whitespace, split runs, spare bits), must not
// run on past the end of the run, and a claimed game, if given, must be this one.
// Anything that does not hold gives NaN, which the leaderboard rejects as a mismatch.
const DAY_MS = 86400000;
const MODE_HEADER = { [MODE_DAILY]: 'daily', [MODE_FREE]: 'arcade' };
// now: null skips only the day window (for tests that run on a fixed clock); every other check stays on.
// dailySeedOf (card 3c): the seed a daily of that dayKey must have. The server passes the seed it issued from
// DAILY_SECRET. Default (null): the public dailySeed, or the seed the board handed out for that day in this page
// (createModes begin with a /daily answer records it in boardSeeds), so the game's local board keeps an online daily.
// A Worker never calls begin, so its boardSeeds stays empty and the default there is the public seed only.
const boardSeeds = new Map(); // dayKey -> seed from GET /daily, this page only
export function makeVerifyReplay({ now = Date.now, version = GAME_VERSION, dailySeedOf = null } = {}) {
  return function verifyReplay({ replay, seed, mode, dayKey, version: claimedVersion, game }) {
    const want = MODE_HEADER[mode];
    if (!want || typeof seed !== 'number') return NaN;
    if (game !== undefined && game !== GAME_ID) return NaN;
    const h = decode(replay);
    if (encode(h, h.words) !== replay) return NaN; // one run, one string
    if (h.mode !== want || h.seed !== seed) return NaN;
    if (h.version !== version || String(claimedVersion) !== String(version)) return NaN;
    if (mode === MODE_DAILY) {
      if (typeof dayKey !== 'string') return NaN;
      let ds; try { ds = dailySeed(dayKey); if (dailySeedOf) ds = dailySeedOf(dayKey); } catch (e) { return NaN; }
      const dayMs = Date.parse(dayKey + 'T00:00:00Z');
      if (!(seed === ds || (!dailySeedOf && boardSeeds.get(dayKey) === seed)) || !Number.isFinite(dayMs)) return NaN;
      if (now && Math.abs(dayMs - Date.parse(todayUTC(now()) + 'T00:00:00Z')) > DAY_MS) return NaN;
    }
    try { return resimReplay(replay, true).score; } catch (e) { return NaN; } // frames past the end, or not this game/version
  };
}
// Real clock, day window on (the same checks the game wires through makeVerifyReplay()).
export const verifyReplay = makeVerifyReplay();

// ---------- run rules ----------
export function createModes({ lb, kv = memoryKv(), now = Date.now, game = GAME_ID, version = GAME_VERSION } = {}) {
  const attemptKey = day => 'daily-attempt:' + day;
  return {
    todayKey: () => todayUTC(now()),
    attemptUsed: day => kv.get(attemptKey(day)) != null,
    // a run record: ranked is decided by claim() on the first gameplay frame
    // server (card 3c, remote board on): the answer of GET /daily. The run then uses the board's day, seed and ticket,
    // never the public seed; an answer that is not a real day and a uint32 seed throws (the caller shows the daily as
    // offline instead).
    begin(mode, freeSeed, server) {
      if (mode === MODE_DAILY && server !== undefined) {
        const s = server;
        if (!s || typeof s !== 'object' || !realDayKey(s.dayKey) || !Number.isInteger(s.seed) || s.seed < 0 || s.seed > 0xffffffff ||
          !(s.ticket === null || (typeof s.ticket === 'string' && s.ticket.length > 0 && s.ticket.length <= 64))) throw new Error('bad daily answer from the board');
        if (boardSeeds.size >= 8) boardSeeds.clear();
        boardSeeds.set(s.dayKey, s.seed);
        return { mode, dayKey: s.dayKey, seed: s.seed, ticket: s.ticket, fromServer: true, claimed: false, ranked: false, submitted: false };
      }
      if (mode === MODE_DAILY) { const dayKey = todayUTC(now()); return { mode, dayKey, seed: dailySeed(dayKey), claimed: false, ranked: false, submitted: false }; }
      if (mode === MODE_FREE) return { mode, dayKey: null, seed: freeSeed >>> 0, claimed: false, ranked: false, submitted: false };
      throw new Error('mode must be daily or free');
    },
    // a daily run whose UTC day is no longer today (started at 23:59:59, first play frame after midnight): the caller
    // starts it again so the day, the seed and the sim agree. A daily from the board is never stale: its day and seed
    // come together from the server (which takes yesterday's), and this device's clock may not match the server's.
    stale: run => !!run && run.mode === MODE_DAILY && !run.fromServer && run.dayKey !== todayUTC(now()),
    // Called on the first gameplay frame of stage 1. Daily: the first started run of the UTC day is ranked,
    // later runs are practice. The marker is written at once, so quitting still uses the attempt. Free: every run ranks.
    claim(run) {
      if (run.claimed) return run.ranked;
      run.claimed = true;
      if (run.mode === MODE_DAILY) {
        if (kv.get(attemptKey(run.dayKey)) != null) run.ranked = false;
        else { kv.set(attemptKey(run.dayKey), '1'); run.ranked = true; }
      } else run.ranked = true;
      return run.ranked;
    },
    // test hooks taint a run (it will not re-simulate); stage starts have no run record at all
    canSubmit(run, sim) {
      return !!run && run.claimed && run.ranked && !run.submitted && !!sim && !sim.tainted && sim.score > 0 && sim.mode === (run.mode === MODE_DAILY ? 'daily' : 'arcade');
    },
    // the exact submit body for this run (the local board gets it first; the remote queue keeps a copy to send)
    body(run, sim, replay, name, playerId) {
      return { game, playerId, name, score: sim.score, replay, seed: run.seed, mode: run.mode,
        ...(run.dayKey && { dayKey: run.dayKey }), ...(run.ticket && { ticket: run.ticket }), version,
        stats: { hash: sim.stateHash(), frames: sim.frame, stage: sim.stage } };
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

// ---------- name entry (3 letters, arcade style) ----------
// step(menuBits, typedLetter) once per tick; typedLetter is 1 for A .. 26 for Z, or 0. Returns true on the tick the name is confirmed.
export function createEntry(initial = 'AAA') {
  const L = new Uint8Array(NAME_LEN);
  const e = {
    pos: 0, t: 0, done: false,
    get name() { let s = ''; for (let i = 0; i < NAME_LEN; i++) s += LETTERS[L[i]]; return s; },
    set(name) { for (let i = 0; i < NAME_LEN; i++) { const k = LETTERS.indexOf(String(name || 'AAA').toUpperCase()[i]); L[i] = k < 0 ? 0 : k; } e.pos = 0; e.t = 0; e.done = false; },
    letter(i) { return LETTERS[L[i]]; },
    step(m, typed) {
      if (e.done) return false;
      e.t++;
      if (typed) { L[e.pos] = (typed - 1) % 26; if (e.pos < NAME_LEN - 1) e.pos++; return false; }
      if (m & M_UP) L[e.pos] = (L[e.pos] + 1) % 26;
      if (m & M_DOWN) L[e.pos] = (L[e.pos] + 25) % 26;
      if (m & M_BACK) { if (e.pos > 0) e.pos--; }
      if (m & M_FIRE) { if (e.pos < NAME_LEN - 1) e.pos++; else e.done = true; }
      if (e.t >= ENTRY_TICKS) e.done = true;
      return e.done;
    }
  };
  e.set(initial);
  return e;
}

// ---------- high-score table ----------
const TABS = [['all', 'ALL-TIME'], ['daily', 'TODAY'], ['season', 'SEASON']];
export function createTable({ lb, game = GAME_ID }) {
  // offline: the last read failed (LOW11: OFFLINE, not LOADING). line: status or rating line; warn: storage warning;
  // share: two lines of share text shown when the clipboard is refused; hint: the key line (null = the default)
  const t = { tab: 0, rows: [[], [], []], loaded: false, offline: false, hiId: null, note: '', summary: '', line: '', lineCol: COL.teal,
    warn: '', share: null, hint: null, tap: null,
    async refresh(fresh = false) {
      try {
        const next = [];
        for (let i = 0; i < TABS.length; i++) {
          const r = await lb.getBoard(fresh ? { game, board: TABS[i][0], limit: 10, fresh: true } : { game, board: TABS[i][0], limit: 10 });
          next.push((Array.isArray(r) ? r : []).map(x => ({ id: x.id, rank: x.rank + '.', name: String(x.name), score: String(x.score), mode: x.mode })));
        }
        t.rows = next; t.loaded = true; t.offline = false;
      } catch (e) {
        t.rows = [[], [], []]; t.loaded = false; t.offline = true;
      }
    },
    // a short line under the table after a submit. Placements past the server's 1000-row cap are null: left out.
    setResult(res) {
      t.hiId = res.id;
      const p = res.placements || {}, d = res.trophyDelta;
      const parts = [];
      if (isCount(p.all)) parts.push('RANK ' + p.all + ' ALL-TIME' + (isCount(p.daily) ? '  ' + p.daily + ' TODAY' : ''));
      else if (isCount(p.daily)) parts.push('RANK ' + p.daily + ' TODAY');
      else if (p.all === null) parts.push('PAST THE TOP 1000');
      if (Number.isFinite(d)) parts.push((d >= 0 ? '+' : '') + d + ' TROPHIES');
      t.note = parts.join('  ');
      const lg = res.league;
      t.summary = lg && typeof lg === 'object' && typeof lg.name === 'string' && Number.isFinite(res.trophies) ? t.leagueLine(lg.name, lg.tier, res.trophies) : '';
    },
    // one league line for submit results (name, tier) and getRank results (league, tier): 'BRONZE III  36 TROPHIES', 'MASTER  900 TROPHIES'
    leagueLine(name, tier, trophies) { return (name + (tier ? ' ' + tier : '') + '  ' + trophies + ' TROPHIES').toUpperCase(); }, // the dot font has capitals only
    cycle(dir) { t.tab = (t.tab + TABS.length + dir) % TABS.length; }
  };
  return t;
}

// LOW8: the touch target for share on the table: label and hit box in field units (400 x 300)
export const SHARE_TAP = 'TAP HERE: SHARE';
export const SHARE_BOX = Object.freeze({ x0: 110, x1: 290, y0: 279, y1: 300 });
export const shareHit = (x, y) => x >= SHARE_BOX.x0 && x <= SHARE_BOX.x1 && y >= SHARE_BOX.y0 && y <= SHARE_BOX.y1;

export function drawTable(R, t, F) {
  const { text, panel, ui } = R;
  panel(40, 80, 320, 206, COL.violet, 0.4);
  for (let i = 0; i < TABS.length; i++) {
    const x = 90 + i * 110, sel = i === t.tab;
    text(TABS[i][1], x, 88, sel ? COL.amber : COL.dim, 1, 'c', 1, sel ? 0.6 : 0);
  }
  const rows = t.rows[t.tab];
  if (!rows.length) text(t.offline ? 'OFFLINE' : t.loaded ? 'NO FLIGHTS YET' : 'LOADING', CX, 160, t.offline ? COL.amber : COL.dim, 1, 'c');
  if (t.offline && ui) text('BOARD RETRIES EVERY 10 S', CX, 174, COL.dim, 1, 'c');
  if (t.warn) text(t.warn, CX, 97, COL.amber, 1, 'c');
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], y = 106 + i * 14, hi = r.id === t.hiId, blink = hi && (F % 30 < 20);
    const col = hi ? (blink ? COL.gold : COL.amber) : i === 0 ? COL.gold : i < 3 ? COL.white : COL.teal;
    text(r.rank, 82, y, col, 1, 'r'); text(r.name, 94, y, col, 1); text(r.score, 336, y, col, 1, 'r');
    if (r.mode === 'daily') text('D', 296, y, COL.violet, 1, 'r', 0.8);
  }
  if (t.share) { text(t.share[0], CX, 238, COL.white, 1, 'c'); text(t.share[1], CX, 252, COL.teal, 1, 'c'); }
  else {
    if (t.note) text(t.note, CX, 252, COL.gold, 1, 'c');
    if (t.summary) text(t.summary, CX, 238, COL.teal, 1, 'c', 0.8);
  }
  if (t.line && ui) text(t.line, CX, 262, t.lineCol, 1, 'c');
  if (ui) text(t.hint || 'UP DOWN: BOARD   FIRE: BACK', CX, 272, COL.dim, 1, 'c');
  if (ui && t.tap) text(t.tap, CX, 289, COL.gold, 1, 'c'); // LOW8: tap target (a constant string)
}

// ---------- name entry screen ----------
export function drawEntry(R, e, info, F) {
  const { text, dot } = R;
  text('NEW FLIGHT RECORD', CX, 34, COL.teal, 1.4, 'c', 1, 0.8);
  text(info.scoreStr, CX, 58, COL.gold, 2.4, 'c');
  text(info.modeStr, CX, 86, COL.dim, 1, 'c');
  text('ENTER YOUR INITIALS', CX, 100, COL.white, 1, 'c'); // glyph rows 100..107; the up-arrow tip is at y 114
  for (let i = 0; i < NAME_LEN; i++) {
    const x = CX + (i - 1) * 56, act = i === e.pos, blink = act && (F % 40 < 28);
    text(e.letter(i), x, 130, act ? (blink ? COL.amber : COL.gold) : COL.white, 6, 'c');
    for (let k = -14; k <= 14; k += 2) dot(x + k, 178, 1, act ? 1 : 0.4, act ? 0.7 : 0.4, act ? 0.2 : 0.6, act ? 1 : 0.6);
    if (act) {
      for (let k = 0; k < 5; k++) { // little up and down arrows made of dots
        dot(x - k * 2, 122 - 8 + k * 2, 1, 1, .7, .2, 0.9); dot(x + k * 2, 122 - 8 + k * 2, 1, 1, .7, .2, 0.9);
        dot(x - k * 2, 184 + 8 - k * 2, 1, 1, .7, .2, 0.9); dot(x + k * 2, 184 + 8 - k * 2, 1, 1, .7, .2, 0.9);
      }
    }
  }
  text(e.pos === NAME_LEN - 1 ? 'FIRE: SAVE' : 'FIRE: NEXT', CX, 214, COL.white, 1, 'c', F % 50 < 34 ? 1 : 0.5);
  text('UP DOWN OR TYPE   BACK: PREVIOUS', CX, 228, COL.dim, 1, 'c');
  text('TOUCH: SWIPE UP DOWN, TAP FOR NEXT', CX, 240, COL.dim, 1, 'c');
  text(info.timeStr, CX, 262, COL.dim, 1, 'c');
}
