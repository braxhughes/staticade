// STACKLIGHT T5 (design B.9, C.5), Node only. The browser half is tests/stacklight-t5-browser.test.js.
//   1. mode seeds: Free Play takes the seed given, Daily takes the public day seed or the board's answer; bad answers throw
//   2. the ranked-attempt marker: first started run of the UTC day ranks, later runs are practice; quitting uses the attempt;
//      the next UTC day starts fresh; midnight; a Daily that began before midnight is stale; a board Daily never is
//   3. the Daily card is read from a sim built with the seed (ridge, rule, level) and equals what a run of that seed builds
//   4. RIDGES: all 64 safe for both decks (tools/stacklight-proof.mjs --ridges, the E.4 fixed point), the table is the one the sim uses
//   5. board keying: STACKLIGHT rows live on the 'stacklight' board only; Starfall's rows never mix in, in either direction
//   6. the local verifier: wrong game, version, mode header, seed, day, score, unfinished run, a second string for one run
//   7. the retry queue: its own storage key and lock names, offline then online sends once, the same run is never queued twice
//   8. name entry is exactly 3 letters, whatever is typed
//   9. attract: best replay of this version, other versions skipped, the bundled demo, the phase clock
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dailySeed } from '../engine/rng.js';
import { decode, encode } from '../engine/replay.js';
import { M_UP, M_DOWN, M_FIRE, M_BACK } from '../engine/input.js';
import { createLeaderboard, LeaderboardError, hashReplay } from '../leaderboard/api.js';
import { memoryAdapter } from '../leaderboard/storage.js';
import { createSim } from '../games/stacklight/sim.js';
import { GAME_ID, GAME_VERSION, RIDGES, DAY_RULES, DAILY_START_LEVEL, CELL_RIDGE, COLS } from '../games/stacklight/defs.js';
import * as M from '../games/stacklight/modes.js';
import { createAttract, pickBest, pickDemo, IDLE_TICKS, PHASE_TICKS } from '../games/stacklight/attract.js';
import { DEMO_REPLAY } from '../games/stacklight/demo-replay.js';
import { createModes as createStarfallModes, makeVerifyReplay as starfallVerify } from '../games/starfall/modes.js';
import { DEMO_REPLAY as STARFALL_DEMO } from '../games/starfall/demo-replay.js';
import { createSim as createStarfallSim, GAME_ID as SF_ID, GAME_VERSION as SF_VERSION } from '../games/starfall/sim.js';
import { createRecorder } from '../engine/replay.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);          // 2026-11-01 12:00 UTC
const DAY = '2026-11-01';
const PID = 'player-0001';
const PAT = [-4, 4, -2, 2, 0, -3, 3];                   // a fixed hands-off pattern that scores and tops out (found by search, see below)

// A finished run of the real sim, no randomness: every 40 frames, shift the piece (press words) and hard drop it.
function playOut(seed, mode, pat = PAT) {
  const sim = createSim({ seed, mode });
  let f = 0;
  while (!sim.done && f < 30000) {
    const c = Math.floor(f / 40), r = f % 40, dir = pat[c % pat.length];
    let w = 0;
    if (r < Math.abs(dir) * 4 && r % 4 === 0) w = dir < 0 ? 9 : 18; // IN_LEFT|IN_LEFT_PRESS, IN_RIGHT|IN_RIGHT_PRESS
    else if (r === 30) w = 32;                                       // IN_HARD_PRESS
    sim.step(w); sim.clearEvents(); f++;
  }
  return { sim, replay: sim.replay() };
}
const env = (now = () => NOW) => {
  const lb = createLeaderboard({ storage: memoryAdapter(), now, verifyReplay: M.makeVerifyReplay({ now }) });
  const kv = M.memoryKv();
  return { lb, kv, modes: M.createModes({ lb, kv, now }) };
};

test('0. the hands-off pattern really ends a scoring run in both modes (the helper every test below leans on)', () => {
  for (const mode of ['arcade', 'daily']) {
    const { sim, replay } = playOut(5, mode);
    assert.equal(sim.done, true, mode + ' topped out');
    assert.ok(sim.score > 0, mode + ' scored ' + sim.score);
    assert.equal(decode(replay).mode, mode);
    assert.equal(M.resimReplay(replay, true).score, sim.score);
  }
});

// ---------- 1. mode seeds ----------
test('1a. Free Play takes the seed it is given (as a uint32); Daily takes the public seed of the UTC day', () => {
  const { modes } = env();
  const f = modes.begin(M.MODE_FREE, 12345);
  assert.deepEqual([f.mode, f.seed, f.dayKey, f.claimed, f.ranked], ['free', 12345, null, false, false]);
  assert.equal(modes.begin(M.MODE_FREE, -1).seed, 0xffffffff, 'a seed is a uint32');
  const d = modes.begin(M.MODE_DAILY);
  assert.equal(d.dayKey, DAY);
  assert.equal(d.seed, dailySeed(DAY));
  assert.equal(d.fromServer, undefined);
  assert.throws(() => modes.begin('arcade'), /mode must be daily or free/);
  assert.throws(() => modes.begin(undefined), /mode must be daily or free/);
});

test('1b. Daily with the board on: the run uses the board\'s day, seed and ticket, never the public seed; a bad answer throws', () => {
  const { modes } = env();
  const r = modes.begin(M.MODE_DAILY, 0, { dayKey: '2026-11-02', seed: 777, ticket: 'tkt-1' });
  assert.deepEqual([r.dayKey, r.seed, r.ticket, r.fromServer], ['2026-11-02', 777, 'tkt-1', true]);
  assert.notEqual(r.seed, dailySeed('2026-11-02'));
  assert.equal(modes.begin(M.MODE_DAILY, 0, { dayKey: DAY, seed: 5, ticket: null }).ticket, null, 'no ticket is allowed');
  for (const bad of [null, 5, {}, { dayKey: '2026-02-31', seed: 1, ticket: null }, { dayKey: 'today', seed: 1, ticket: null },
    { dayKey: DAY, seed: -1, ticket: null }, { dayKey: DAY, seed: 2 ** 32, ticket: null }, { dayKey: DAY, seed: 1.5, ticket: null },
    { dayKey: DAY, seed: 1, ticket: '' }, { dayKey: DAY, seed: 1, ticket: 'x'.repeat(65) }, { dayKey: DAY, seed: 1, ticket: 7 }, { dayKey: DAY, seed: '1', ticket: null }]) {
    assert.throws(() => modes.begin(M.MODE_DAILY, 0, bad), /bad daily answer/, JSON.stringify(bad));
  }
});

test('1c. utcDayMs reads plain calendar days and nothing else', () => {
  assert.equal(M.utcDayMs('2026-11-01'), Date.UTC(2026, 10, 1));
  assert.equal(M.utcDayMs('2024-02-29'), Date.UTC(2024, 1, 29));
  for (const k of ['2026-02-29', '2026-13-01', '2026-00-10', '2026-11-00', '2026-11-31', '26-11-01', 'x', '', null, undefined, 20261101]) assert.ok(Number.isNaN(M.utcDayMs(k)), String(k));
});

// ---------- 2. the ranked attempt ----------
test('2a. first started Daily of the UTC day is ranked, later ones are practice, claiming twice changes nothing', async () => {
  const { modes, lb } = env();
  const a = modes.begin(M.MODE_DAILY), b = modes.begin(M.MODE_DAILY);
  assert.equal(modes.attemptUsed(DAY), false);
  assert.equal(modes.claim(a), true);
  assert.equal(modes.attemptUsed(DAY), true, 'the marker is written at the first frame');
  assert.equal(modes.claim(b), false, 'second is practice');
  assert.equal(modes.claim(a), true); assert.equal(modes.claim(b), false);
  const pb = playOut(b.seed, 'daily');
  assert.equal(modes.canSubmit(b, pb.sim), false);
  await assert.rejects(modes.submit(b, pb.sim, pb.replay, 'AAA', PID), /cannot be submitted/);
  assert.equal((await lb.getBoard({ game: GAME_ID, board: 'all' })).length, 0, 'a practice run reaches no board');
  const pa = playOut(a.seed, 'daily');
  assert.equal(modes.canSubmit(a, pa.sim), true);
  const res = await modes.submit(a, pa.sim, pa.replay, 'ACE', PID);
  assert.equal(res.placements.daily, 1);
  assert.equal(a.submitted, true);
  assert.equal(modes.canSubmit(a, pa.sim), false, 'one run, one submit');
});

test('2b. a quit run still uses the attempt, across a reload (same storage) and not across the next UTC day', () => {
  const kv = M.memoryKv();
  const m1 = M.createModes({ lb: null, kv, now: () => NOW });
  m1.claim(m1.begin(M.MODE_DAILY));                       // started, then quit: no score, the marker is written
  const m2 = M.createModes({ lb: null, kv, now: () => NOW });
  assert.equal(m2.claim(m2.begin(M.MODE_DAILY)), false);
  const m3 = M.createModes({ lb: null, kv, now: () => NOW + 86400000 });
  assert.equal(m3.claim(m3.begin(M.MODE_DAILY)), true, 'a new UTC day gets a new ranked attempt');
});

test('2c. Free Play: every run ranks, and never touches the Daily marker', () => {
  const { modes, kv } = env();
  assert.equal(modes.claim(modes.begin(M.MODE_FREE, 1)), true);
  assert.equal(modes.claim(modes.begin(M.MODE_FREE, 2)), true);
  assert.equal(modes.attemptUsed(DAY), false);
  assert.equal(kv.get('daily-attempt:' + DAY), null);
});

test('2d. UTC midnight: 23:59:59.999 is one day, 00:00:00.000 the next; a local Daily begun before midnight is stale after it; a board Daily never is', () => {
  const clock = { t: Date.UTC(2026, 10, 1, 23, 59, 59, 999) };
  const kv = M.memoryKv();
  const modes = M.createModes({ lb: null, kv, now: () => clock.t });
  const local = modes.begin(M.MODE_DAILY), board = modes.begin(M.MODE_DAILY, 0, { dayKey: '2026-11-01', seed: 99, ticket: null });
  assert.equal(local.dayKey, '2026-11-01'); assert.equal(modes.stale(local), false);
  clock.t += 1; // 2026-11-02 00:00:00.000
  assert.equal(modes.todayKey(), '2026-11-02');
  assert.equal(modes.stale(local), true, 'the caller starts it again');
  assert.equal(modes.stale(board), false, 'the board\'s day and seed come together; this device\'s clock does not decide');
  assert.equal(modes.stale(modes.begin(M.MODE_FREE, 1)), false);
  assert.equal(modes.stale(null), false);
  assert.equal(modes.attemptUsed('2026-11-02'), false, 'the stale run claimed nothing');
  // the marker belongs to the run's own day, not to the clock at claim time
  assert.equal(modes.claim(board), true);
  assert.equal(modes.attemptUsed('2026-11-01'), true); assert.equal(modes.attemptUsed('2026-11-02'), false);
});

test('2e. the submit body is what the board takes: game, version 2.0, replay, seed, mode, day, ticket, stats', () => {
  const { modes } = env();
  const r = modes.begin(M.MODE_DAILY, 0, { dayKey: DAY, seed: dailySeed(DAY), ticket: 'tk' }); modes.claim(r);
  const { sim, replay } = playOut(r.seed, 'daily');
  const b = modes.body(r, sim, replay, 'ZED', PID);
  assert.deepEqual(Object.keys(b).sort(), ['dayKey', 'game', 'mode', 'name', 'playerId', 'replay', 'score', 'seed', 'stats', 'ticket', 'version']);
  assert.equal(b.game, 'stacklight'); assert.equal(b.version, '2.0'); assert.equal(b.mode, 'daily');
  assert.equal(b.score, sim.score); assert.equal(b.stats.hash, String(sim.stateHash())); assert.equal(b.stats.frames, sim.frame);
  const f = modes.begin(M.MODE_FREE, 3); modes.claim(f);
  const fb = modes.body(f, playOut(3, 'arcade').sim, 'r', 'AAA', PID);
  assert.equal('dayKey' in fb, false); assert.equal('ticket' in fb, false); assert.equal(fb.mode, 'free');
});

test('2f. canSubmit: needs a claimed, ranked, unsubmitted run, a finished sim, a score, and a sim mode that fits the claim', () => {
  const { modes } = env();
  const r = modes.begin(M.MODE_FREE, 5);
  const done = playOut(5, 'arcade').sim;
  assert.equal(modes.canSubmit(r, done), false, 'not claimed');
  modes.claim(r);
  assert.equal(modes.canSubmit(r, done), true);
  assert.equal(modes.canSubmit(r, createSim({ seed: 5, mode: 'arcade' })), false, 'unfinished');
  assert.equal(modes.canSubmit(r, playOut(5, 'daily').sim), false, 'a daily sim under a free claim');
  const z = createSim({ seed: 1, mode: 'arcade' }); z.step(32); // no score, not done
  assert.equal(modes.canSubmit(r, z), false);
  assert.equal(modes.canSubmit(null, done), false); assert.equal(modes.canSubmit(r, null), false);
});

// ---------- 3. the Daily card ----------
test('3. the Daily card is read from a sim built from the seed: its ridge, rule and level are what a run of that seed builds (400 seeds, 6 real days)', () => {
  const seeds = [dailySeed(DAY), dailySeed('2026-11-02'), dailySeed('2026-11-03'), dailySeed('2026-12-25'), dailySeed('2027-01-01'), dailySeed('2026-10-30')];
  for (let i = 1; i <= 394; i++) seeds.push((i * 2654435761) >>> 0);
  const seenRidge = new Set(), seenRule = new Set();
  for (const seed of seeds) {
    const card = M.dailyCard(seed, DAY), sim = createSim({ seed, mode: 'daily' }), i = sim.info();
    assert.equal(card.ridge, i.ridge, 'ridge ' + seed); assert.equal(card.rule, i.dayRule, 'rule ' + seed); assert.equal(card.level, i.level);
    assert.equal(card.level, DAILY_START_LEVEL); assert.equal(card.levelStr, 'LEVEL 4');
    assert.ok(RIDGES.includes(card.ridge)); assert.ok(DAY_RULES.includes(card.rule));
    // the board it draws is the sim's own: RIDGE cells in exactly the heights the ridge string names
    const g = card.grid;
    for (let c = 0; c < COLS; c++) {
      let h = 0; while (g[h * COLS + c] === CELL_RIDGE) h++;
      assert.equal(h, +card.ridge[c], 'column ' + c + ' of ' + card.ridge);
      assert.equal(g[h * COLS + c], 0, 'nothing above the ridge');
    }
    seenRidge.add(card.ridge); seenRule.add(card.rule);
  }
  assert.ok(seenRidge.size > 40, 'many different ridges come up: ' + seenRidge.size);
  assert.deepEqual([...seenRule].sort(), [...DAY_RULES].sort(), 'every rule comes up');
  assert.equal(M.dailyCard(dailySeed('2026-11-01'), '2026-11-01').noStr, 'DAILY NO. 3');
  assert.equal(M.dailyCard(1, '2026-10-30').noStr, 'DAILY NO. 1');
  assert.equal(M.dailyCard(1, '2026-10-01').noStr, 'DAILY 2026-10-01', 'before launch: the date');
  assert.deepEqual(Object.keys(M.RULE_NOTE).sort(), [...DAY_RULES].sort(), 'a note for every rule');
});

// ---------- 4. RIDGES ----------
test('4. RIDGES re-check: all 64 starting ridges are safe for the 3+2 deck and the LEAN 2+2 deck (tools/stacklight-proof.mjs --ridges, design E.4)', { timeout: 120000 }, () => {
  assert.equal(RIDGES.length, 64); assert.equal(new Set(RIDGES).size, 64);
  for (const r of RIDGES) assert.match(r, /^[0-2]{9}$/);
  const p = spawnSync(process.execPath, [path.join(ROOT, 'tools/stacklight-proof.mjs'), '--ridges'], { encoding: 'utf8', timeout: 110000 });
  assert.equal(p.status, 0, 'exit code: ' + p.stderr + p.stdout);
  assert.match(p.stdout, /deck=3bar\+2plus .*emptyFreshSafe=true/);
  assert.match(p.stdout, /deck=2bar\+2plus .*emptyFreshSafe=true/);
  assert.match(p.stdout, /ridges=64 all safe for 3\+2: true {2}for 2\+2: true/);
});

// ---------- 5. board keying ----------
test('5. STACKLIGHT and Starfall rows share one store but never one board, either way round', async () => {
  const storage = memoryAdapter();
  const slVerify = M.makeVerifyReplay({ now: () => NOW }), sfVerify = starfallVerify({ now: () => NOW });
  const lb = createLeaderboard({ storage, now: () => NOW, verifyReplay: x => (x.game === GAME_ID ? slVerify(x) : sfVerify(x)) });
  const sl = M.createModes({ lb, kv: M.memoryKv(), now: () => NOW });
  const run = sl.begin(M.MODE_FREE, 5); sl.claim(run);
  const p = playOut(5, 'arcade');
  await sl.submit(run, p.sim, p.replay, 'SLT', PID);
  // a real Starfall run, scored, on the same store and the same player id
  const sf = createStarfallModes({ lb, kv: M.memoryKv(), now: () => NOW }), sfRun = sf.begin('free', 777); sf.claim(sfRun);
  const words = decode(STARFALL_DEMO).words, sfSim = createStarfallSim({ seed: 777, mode: 'arcade' }), rec = createRecorder(256);
  for (let i = 0; i < 900 && i < words.length; i++) { sfSim.step(words[i]); rec.push(words[i]); sfSim.clearEvents(); }
  assert.ok(sfSim.score > 0, 'the Starfall run scored ' + sfSim.score);
  await sf.submit(sfRun, sfSim, rec.encode({ game: SF_ID, version: SF_VERSION, seed: 777, mode: 'arcade' }), 'STR', PID);
  for (const board of ['all', 'season', 'daily']) {
    const key = board === 'daily' ? DAY : undefined;
    const slRows = await lb.getBoard({ game: 'stacklight', board, key }), sfRows = await lb.getBoard({ game: 'starfall', board, key });
    if (board !== 'daily') { assert.deepEqual(slRows.map(r => r.name), ['SLT'], 'stacklight ' + board); assert.deepEqual(sfRows.map(r => r.name), ['STR'], 'starfall ' + board); }
    else { assert.equal(slRows.length, 0, 'a Free Play run is not on the Daily board'); }
  }
  assert.equal((await lb.getBoard({ game: 'stacklight', board: 'all' }))[0].score, p.sim.score);
  // the keys of the one store: each board, player and replay-hash key names exactly one game
  const keys = await storage.keys('');
  for (const k of keys.filter(k => /^(board|rh|player):/.test(k))) assert.ok(/:(stacklight|starfall):/.test(k) || /:(stacklight|starfall)$/.test(k), k);
  assert.ok(keys.some(k => k.startsWith('board:stacklight:')) && keys.some(k => k.startsWith('board:starfall:')), keys.join());
  // a STACKLIGHT replay submitted under the other game's name, and the reverse, is refused
  await assert.rejects(lb.submitScore({ game: 'starfall', playerId: PID, name: 'BAD', score: p.sim.score, replay: p.replay, seed: 5, mode: 'free', version: SF_VERSION }));
  await assert.rejects(lb.submitScore({ game: 'stacklight', playerId: PID, name: 'BAD', score: sfSim.score, replay: rec.encode({ game: SF_ID, version: SF_VERSION, seed: 777, mode: 'arcade' }), seed: 777, mode: 'free', version: '2.0' }));
  assert.deepEqual((await lb.getBoard({ game: 'stacklight', board: 'all' })).map(r => r.name), ['SLT']);
  assert.deepEqual((await lb.getBoard({ game: 'starfall', board: 'all' })).map(r => r.name), ['STR']);
});

// ---------- 6. the verifier ----------
test('6. the local verifier takes an honest finished run and refuses every kind of lie', () => {
  const v = M.makeVerifyReplay({ now: () => NOW });
  const a = playOut(5, 'arcade'), claim = { replay: a.replay, seed: 5, mode: 'free', version: '2.0', game: 'stacklight' };
  assert.equal(v(claim), a.sim.score, 'honest free run');
  assert.ok(Number.isNaN(v({ ...claim, mode: 'daily', dayKey: DAY })), 'free replay claimed as daily');
  assert.ok(Number.isNaN(v({ ...claim, seed: 6 })), 'seed');
  assert.ok(Number.isNaN(v({ ...claim, version: '1.0' })), 'version');
  assert.ok(Number.isNaN(v({ ...claim, game: 'starfall' })), 'game');
  assert.ok(Number.isNaN(v({ ...claim, mode: 'weird' })), 'mode');
  assert.ok(Number.isNaN(v({ ...claim, replay: 7 })), 'replay not a string');
  assert.ok(Number.isNaN(v({ ...claim, replay: claim.replay + 'AAAA' })), 'extra frames after the end: one run, one string');
  // an unfinished run
  const open = createSim({ seed: 5, mode: 'arcade' }); for (let i = 0; i < 100; i++) { open.step(0); open.clearEvents(); }
  assert.ok(Number.isNaN(v({ ...claim, replay: open.replay() })), 'unfinished');
  // a daily: right day seed; wrong seed for the day; a day far from today; a bad day
  const d = playOut(dailySeed(DAY), 'daily'), dc = { replay: d.replay, seed: dailySeed(DAY), mode: 'daily', dayKey: DAY, version: '2.0', game: 'stacklight' };
  assert.equal(v(dc), d.sim.score);
  assert.ok(Number.isNaN(v({ ...dc, dayKey: '2026-11-02', seed: dailySeed(DAY) })), 'the seed of another day');
  assert.ok(Number.isNaN(v({ ...dc, dayKey: undefined })), 'no day');
  const old = playOut(dailySeed('2026-10-01'), 'daily');
  assert.ok(Number.isNaN(v({ ...dc, replay: old.replay, seed: dailySeed('2026-10-01'), dayKey: '2026-10-01' })), 'a day a month ago');
  assert.equal(v({ ...dc, replay: playOut(dailySeed('2026-11-02'), 'daily').replay, seed: dailySeed('2026-11-02'), dayKey: '2026-11-02' }) > 0, true, 'tomorrow (1 day) is allowed for a device clock behind');
  // a daily from the board's /daily answer is trusted for its day
  const board = M.createModes({ lb: null, kv: M.memoryKv(), now: () => NOW });
  board.begin(M.MODE_DAILY, 0, { dayKey: DAY, seed: 4242, ticket: null });
  const bp = playOut(4242, 'daily');
  assert.equal(v({ ...dc, replay: bp.replay, seed: 4242 }), bp.sim.score, 'a seed the board handed out');
  assert.ok(Number.isNaN(v({ ...dc, replay: bp.replay, seed: 4243 })));
  // resimReplay refuses other games and versions
  const h = decode(a.replay);
  assert.throws(() => M.resimReplay(encode({ ...h, game: 'starfall' }, h.words)), /not stacklight/);
  assert.throws(() => M.resimReplay(encode({ ...h, version: '9.9' }, h.words)), /version/);
  assert.throws(() => M.resimReplay(encode({ ...h, mode: 'test' }, h.words)), /not playable/);
});

// ---------- 7. the retry queue ----------
const memStore = () => { const m = new Map(); return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } }; };
const qbody = () => { const r = M.createModes({ lb: null, kv: M.memoryKv(), now: () => NOW }), run = r.begin(M.MODE_FREE, 5); r.claim(run); const p = playOut(5, 'arcade'); return r.body(run, p.sim, p.replay, 'ACE', PID); };
const oops = (code, status) => { const e = new LeaderboardError(code, code); if (status) e.status = status; return e; };

test('7a. the queue lives under stacklight.sendq and its own lock names; Starfall\'s key is never touched', async () => {
  const store = memStore(), lockNames = [];
  const locks = { request: (name, fn) => { lockNames.push(name); return fn(); } };
  const calls = [];
  const q = M.createStacklightQueue({ remote: { submitScore: async b => { calls.push(b); return { id: 'e1', placements: { all: 1 } }; } }, backend: store, locks, now: () => NOW });
  assert.equal(await q.add(qbody()), true);
  assert.deepEqual([...store.m.keys()], ['stacklight.sendq']);
  assert.equal(M.QUEUE_KEY, 'stacklight.sendq');
  await q.flush();
  assert.equal(calls.length, 1); assert.equal(store.m.size, 0, 'delivered: the key is gone');
  assert.ok(lockNames.length >= 2 && lockNames.every(n => n.startsWith('stacklight-sendq-')), lockNames.join());
  // a Starfall-shaped entry already in storage is not read as STACKLIGHT's
  store.setItem('starfall.sendq', JSON.stringify({ v: 1, items: [] }));
  assert.equal(q.length, 0);
  assert.deepEqual([...store.m.keys()], ['starfall.sendq']);
});

test('7b. offline, then online: saved first, sent once, the same run is never queued or sent twice', async () => {
  const store = memStore(), clock = { t: NOW };
  let online = false; const sent = [], events = [];
  const remote = { submitScore: async b => { if (!online) throw oops('offline'); sent.push(b); return { id: 'e' + sent.length, placements: { all: 1 } }; } };
  const q = M.createStacklightQueue({ remote, backend: store, locks: null, now: () => clock.t, onEvent: e => events.push(e) });
  const b = qbody();
  assert.equal(await q.add(b), true); assert.equal(await q.add(b), true);
  assert.equal(q.length, 1, 'one run, one entry');
  await q.flush();
  assert.equal(sent.length, 0); assert.equal(q.length, 1, 'kept');
  assert.equal(events.at(-1).kind, 'retry'); assert.equal(M.statusFor(events.at(-1)), 'OFFLINE: 1 RUN SAVED HERE, WILL RETRY');
  await q.flush(); assert.equal(sent.length, 0, 'not due yet: backoff, no hammering');
  online = true; await q.wake();
  await q.flush(); await q.flush(); await q.flush();
  assert.equal(sent.length, 1, 'sent exactly once');
  assert.deepEqual(sent[0], b);
  assert.equal(q.length, 0);
  // the answer is lost after the server stored it: the retry gets duplicate_replay, which counts as delivered
  const q2 = M.createStacklightQueue({ remote: { submitScore: async () => { throw oops('duplicate_replay', 409); } }, backend: store, locks: null, now: () => clock.t, onEvent: e => events.push(e) });
  await q2.add(b); await q2.flush();
  assert.equal(events.at(-1).kind, 'dup'); assert.equal(q2.length, 0);
  assert.equal(hashReplay(b.replay), events.at(-1).entry.id);
});

test('7c. a body that is not a well-formed STACKLIGHT run is refused by the queue (name, version, mode)', async () => {
  const q = M.createStacklightQueue({ remote: { submitScore: async () => ({}) }, backend: memStore(), locks: null, now: () => NOW });
  const b = qbody();
  for (const bad of [{ ...b, version: '1.0' }, { ...b, mode: 'arcade' }, { ...b, mode: 'daily', dayKey: undefined }, { ...b, score: 0 }, { ...b, name: 7 }, { ...b, playerId: 'x' }, { ...b, replay: '' }])
    assert.equal(await q.add(bad), false, JSON.stringify(Object.keys(bad)) + ' ' + bad.mode);
  assert.equal(q.length, 0);
});

// ---------- 8. name entry ----------
test('8. the name is always exactly 3 letters, A to Z, whatever is typed or pressed', () => {
  const e = M.createEntry('AAA');
  assert.equal(M.NAME_LEN, 3); assert.equal(e.name, 'AAA');
  for (const [n, want] of [['zed', 'ZED'], ['ab', 'ABA'], ['', 'AAA'], ['x', 'XAA'], ['a1b', 'AAB'], ['abcdef', 'ABC'], [null, 'AAA'], ['ééé', 'AAA'], ['q r', 'QAR']]) { e.set(n); assert.equal(e.name, want, String(n)); assert.match(e.name, /^[A-Z]{3}$/); }
  // typed letters: each fills the cursor and moves on; the third letter does not run off the end
  e.set('AAA'); assert.equal(e.step(0, 8), false); assert.equal(e.step(0, 9), false); assert.equal(e.step(0, 26), false); assert.equal(e.name, 'HIZ'); assert.equal(e.pos, 2);
  assert.equal(e.step(0, 5), false); assert.equal(e.name, 'HIE', 'the last letter is replaced, never a 4th added');
  assert.equal(e.step(M_FIRE, 0), true, 'Enter on the last letter confirms'); assert.equal(e.name, 'HIE');
  // up/down wrap, back moves left, fire moves right
  e.set('AAA'); e.step(M_DOWN, 0); assert.equal(e.name, 'ZAA'); e.step(M_UP, 0); assert.equal(e.name, 'AAA');
  e.step(M_FIRE, 0); assert.equal(e.pos, 1); e.step(M_BACK, 0); assert.equal(e.pos, 0); e.step(M_BACK, 0); assert.equal(e.pos, 0);
  // the timer confirms what is shown
  e.set('QRS'); let done = false; for (let i = 0; i < M.ENTRY_TICKS + 2 && !done; i++) done = e.step(0, 0);
  assert.equal(done, true); assert.equal(e.t, M.ENTRY_TICKS); assert.equal(e.name, 'QRS');
});

// ---------- 9. attract ----------
const fakeLb = (rows, replays) => ({ getBoard: async () => rows, getReplay: async id => replays[id] || null });
test('9a. attract picks the best all-time replay of THIS version; other versions, other games and test modes are skipped', async () => {
  const good = playOut(5, 'arcade').replay, daily = playOut(dailySeed(DAY), 'daily').replay;
  const rows = [{ id: 'a', name: 'TOP', score: 900 }, { id: 'b', name: 'SF', score: 800 }, { id: 'c', name: 'OLD', score: 700 }, { id: 'd', name: 'DLY', score: 600 }, { id: 'e', name: 'OK', score: 500 }];
  const h = decode(good);
  const lb = fakeLb(rows, {
    a: { game: 'stacklight', version: '1.0', replay: good },                            // the record says another (the old) version
    b: { game: 'starfall', version: '2.0', replay: good },                              // another game
    c: { game: 'stacklight', version: '2.0', replay: encode({ ...h, version: '1.0' }, h.words) }, // the string says another (the old) version
    d: { game: 'stacklight', version: '2.0', replay: daily },
    e: { game: 'stacklight', version: '2.0', replay: good }
  });
  const best = await pickBest(lb);
  assert.equal(best.name, 'DLY', 'the first playable row, in board order: a Daily replay is fine, the others are skipped');
  assert.equal(best.mode, 'daily'); assert.equal(best.seed, dailySeed(DAY));
  rows.splice(3, 1);
  assert.equal((await pickBest(lb)).name, 'OK');
  assert.equal(await pickBest(fakeLb([], {})), null);
  assert.equal(await pickBest(fakeLb(rows.slice(0, 3), { a: { game: 'stacklight', version: '1.0', replay: good } })), null, 'only wrong-version replays: nothing');
  // a replay with a reserved input bit, or a test mode, is never played
  const bits = encode(h, Uint16Array.from([...h.words].map((w, i) => (i === 3 ? 0x100 : w))));
  assert.equal(pickDemo(bits), null);
  assert.equal(pickDemo(encode({ ...h, mode: 'test' }, h.words)), null);
  assert.equal(pickDemo('nonsense'), null); assert.equal(pickDemo(''), null); assert.equal(pickDemo(null), null);
});

test('9b. the bundled demo is a real STACKLIGHT 2.0 run: it plays whole on the real sim and is what attract falls back to', async () => {
  const d = decode(DEMO_REPLAY);
  assert.equal(d.game, 'stacklight'); assert.equal(d.version, GAME_VERSION); assert.equal(d.mode, 'arcade');
  assert.ok(d.words.length > 1200, 'long enough to fill a 20 s phase: ' + d.words.length);
  const sim = createSim({ seed: d.seed, mode: d.mode });
  for (const w of d.words) { assert.equal(sim.done, false, 'the demo does not top out early'); sim.step(w); sim.clearEvents(); }
  assert.ok(sim.score > 5000 && sim.lines >= 20, 'a good run: ' + sim.score + ' ' + sim.lines);
  assert.ok(pickDemo(DEMO_REPLAY), 'playable');
  assert.equal(pickDemo(DEMO_REPLAY, 'stacklight', '1.0'), null, 'a demo for another version is ignored');
  const A = createAttract({ lb: fakeLb([], {}), demo: DEMO_REPLAY });
  await A.prepare();
  assert.equal(A.kind, 'demo'); assert.equal(A.banner, 'DEMO RUN');
  const B = createAttract({ lb: fakeLb([], {}), demo: null }); await B.prepare();
  assert.equal(B.kind, 'none'); assert.equal(B.banner, '');
  const C = createAttract({ lb: { getBoard: async () => { throw new LeaderboardError('offline', 'x'); } }, demo: DEMO_REPLAY }); await C.prepare();
  assert.equal(C.kind, 'demo', 'a board that cannot be read: the demo');
});

test('9c. attract phases: play up to 20 s, then the table for 20 s, then play again; a stop leaves nothing running', async () => {
  assert.equal(IDLE_TICKS, 1800, '30 s at 60 Hz'); assert.equal(PHASE_TICKS, 1200);
  const A = createAttract({ lb: fakeLb([], {}), demo: DEMO_REPLAY });
  assert.equal(A.phase, 'off');
  A.start(); assert.equal(A.phase, 'wait');
  await A.prepare(); assert.equal(A.phase, 'play'); assert.ok(A.sim);
  let ticks = 0, frames = 0;
  const beforeN = { n: 0 }, evN = { n: 0 };
  while (A.phase === 'play' && ticks < 5000) { A.update(() => { beforeN.n++; }, () => { evN.n++; }); ticks++; }
  assert.equal(A.phase, 'table'); assert.ok(ticks <= PHASE_TICKS, 'play lasts at most 20 s: ' + ticks);
  assert.equal(beforeN.n, A.i, 'beforeStep ran once per replay frame'); assert.ok(evN.n > 0, 'sim events reach the effects');
  let t2 = 0; while (A.phase === 'table' && t2 < 5000) { A.update(); t2++; }
  assert.equal(t2, PHASE_TICKS, 'the table shows for 20 s'); assert.equal(A.phase, 'play'); assert.equal(A.sim.frame, 0, 'the run starts from its first frame again');
  A.stop(); assert.equal(A.phase, 'off'); assert.equal(A.sim, null); assert.equal(A.ready, false);
  A.update(); assert.equal(A.phase, 'off', 'a stopped attract does nothing');
  // no source: the table only, restarting its clock
  const N = createAttract({ lb: fakeLb([], {}), demo: null }); N.start(); await N.prepare();
  assert.equal(N.phase, 'table'); for (let i = 0; i < PHASE_TICKS + 5; i++) N.update(); assert.equal(N.phase, 'table'); assert.equal(N.sim, null);
  // a late answer of a stopped attract is dropped (token)
  const L = createAttract({ lb: fakeLb([], {}), demo: DEMO_REPLAY }); L.start(); const p = L.prepare(); L.stop(); await p;
  assert.equal(L.phase, 'off'); assert.equal(L.ready, false);
});
