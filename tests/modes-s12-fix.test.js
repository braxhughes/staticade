// w9-s12-fix: the cold-review findings for S12. New file; the S12 tests in modes-s12.test.js are untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dailySeed } from '../engine/rng.js';
import { decode, createRecorder } from '../engine/replay.js';
import { M_UP, M_FIRE, M_ALT, M_BACK } from '../engine/input.js';
import { createLeaderboard } from '../leaderboard/api.js';
import { memoryAdapter } from '../leaderboard/storage.js';
import { createSim, GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import fs from 'node:fs';
import { createModes, createEntry, createTable, memoryKv, resimReplay, makeVerifyReplay, verifyReplay, todayUTC } from '../games/starfall/modes.js';
import { pickBest, pickDemo } from '../games/starfall/attract.js';
import { DEMO_REPLAY } from '../games/starfall/demo-replay.js';

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const PID = 'player-0001';
const words = decode(DEMO_REPLAY).words;
function play(seed, mode, frames = 700) {
  const sim = createSim({ seed, mode }), rec = createRecorder(256);
  for (let i = 0; i < frames; i++) { sim.step(words[i]); rec.push(words[i]); sim.clearEvents(); }
  return { sim, replay: rec.encode({ game: GAME_ID, version: GAME_VERSION, seed, mode }) };
}
const claim = (replay, seed, mode, dayKey, version = GAME_VERSION) => ({ replay, seed, mode, dayKey, version });

// ---------- MED1: the verifier ----------
test('verifier: a real free run and a real daily run still verify to their score', () => {
  const v = makeVerifyReplay({ now: () => NOW });
  const f = play(77, 'arcade'), ds = dailySeed('2026-10-28'), d = play(ds, 'daily');
  assert.ok(f.sim.score > 0 && d.sim.score > 0);
  assert.equal(v(claim(f.replay, 77, 'free')), f.sim.score);
  assert.equal(v(claim(d.replay, ds, 'daily', '2026-10-28')), d.sim.score);
  assert.equal(v(claim(d.replay, ds, 'daily', '2026-10-27')), NaN, 'seed must belong to the claimed dayKey');
  assert.equal(v(claim(d.replay, ds, 'daily', '2026-10-29')), NaN);
});

test('verifier: the five cases the review found accepted are now rejected', () => {
  const v = makeVerifyReplay({ now: () => NOW });
  const s5 = play(77, 'stage5');
  assert.equal(v(claim(s5.replay, 77, 'free')), NaN, 'stage-start practice run as free');
  const a = play(dailySeed('2020-01-01'), 'arcade');
  assert.equal(v(claim(a.replay, dailySeed('2020-01-01'), 'daily', '2020-01-01')), NaN, 'arcade run as daily');
  const d30 = play(dailySeed('2030-01-01'), 'daily');
  assert.equal(v(claim(d30.replay, dailySeed('2030-01-01'), 'daily', '2030-01-01')), NaN, 'daily far in the future');
  const d20 = play(dailySeed('2020-01-01'), 'daily');
  assert.equal(v(claim(d20.replay, dailySeed('2020-01-01'), 'daily', '2020-01-01')), NaN, 'daily far in the past');
  const f = play(77, 'arcade');
  assert.equal(v(claim(f.replay, '77', 'free')), NaN, 'string seed');
  assert.equal(v(claim(play(77, 'arcade+dev').replay, 77, 'free')), NaN, '+dev header');
  assert.equal(v(claim(play(dailySeed('2026-10-28'), 'daily+dev').replay, dailySeed('2026-10-28'), 'daily', '2026-10-28')), NaN, 'daily+dev header');
});

test('verifier: seed, version, mode and dayKey each have to match', () => {
  const v = makeVerifyReplay({ now: () => NOW });
  const f = play(77, 'arcade'), ds = dailySeed('2026-10-28'), d = play(ds, 'daily');
  assert.equal(v(claim(f.replay, 78, 'free')), NaN, 'seed differs from the replay');
  assert.equal(v(claim(f.replay, 77, 'free', undefined, '9.9')), NaN, 'claimed version differs');
  assert.equal(v(claim(f.replay, 77, 'daily', '2026-10-28')), NaN, 'free replay claimed as daily');
  assert.equal(v(claim(d.replay, ds, 'free')), NaN, 'daily replay claimed as free');
  assert.equal(v(claim(d.replay, ds, 'daily')), NaN, 'daily without a dayKey');
  assert.equal(v(claim(d.replay, ds, 'daily', 'nonsense')), NaN, 'daily with a bad dayKey');
  assert.equal(v(claim(f.replay, 77, 'other')), NaN, 'unknown mode');
});

test('verifier: the 1-day window follows the clock and is on UTC days', () => {
  const ds = dailySeed('2026-10-28'), d = play(ds, 'daily');
  const at = ms => makeVerifyReplay({ now: () => ms })(claim(d.replay, ds, 'daily', '2026-10-28'));
  assert.equal(at(Date.UTC(2026, 9, 27, 0, 0, 0)), d.sim.score, 'day before');
  assert.equal(at(Date.UTC(2026, 9, 29, 23, 59, 59, 999)), d.sim.score, 'day after');
  assert.equal(at(Date.UTC(2026, 9, 30, 0, 0, 0)), NaN, 'two days later');
  assert.equal(at(Date.UTC(2026, 9, 25, 23, 59, 59)), NaN, 'three days earlier');
});

test('verifier: an old-version replay is refused (resim throws, verify rejects)', () => {
  const { replay } = play(77, 'arcade', 200);
  const old = replay.replace('~' + GAME_VERSION + '~', '~0.9~');
  assert.notEqual(old, replay);
  assert.throws(() => resimReplay(old), /version/);
  assert.equal(makeVerifyReplay({ now: () => NOW })(claim(old, 77, 'free', undefined, '0.9')), NaN, 'honest old claim');
  assert.equal(makeVerifyReplay({ now: () => NOW })(claim(old, 77, 'free')), NaN, 'old replay claimed as current');
  assert.equal(typeof verifyReplay, 'function');
});

test('leaderboard with the verifier: bad claims are rejected, a good one is stored with its dayKey', async () => {
  const lb = createLeaderboard({ storage: memoryAdapter(), now: () => NOW, verifyReplay: makeVerifyReplay({ now: () => NOW }) });
  const modes = createModes({ lb, kv: memoryKv(), now: () => NOW });
  const s5 = play(77, 'stage5');
  await assert.rejects(lb.submitScore({ game: GAME_ID, playerId: PID, name: 'BAD', score: s5.sim.score, replay: s5.replay, seed: 77, mode: 'free', version: GAME_VERSION }), /replay_mismatch|scores/);
  const run = modes.begin('daily'); modes.claim(run);
  const { sim, replay } = play(run.seed, 'daily');
  const res = await modes.submit(run, sim, replay, 'DAY', PID);
  assert.ok(res.id);
  const today = await lb.getBoard({ game: GAME_ID, board: 'daily', limit: 5 });
  assert.equal(today.length, 1, 'the daily submit carries dayKey, so it is on the day board');
});

// ---------- MED2: Shift does not move the name slot ----------
test('name entry: Shift does not advance; Fire does; Shift then B gives B in slot 0', () => {
  const e = createEntry('AAA');
  e.step(M_ALT, 0);
  assert.equal(e.pos, 0, 'Shift alone does nothing');
  assert.equal(e.done, false);
  e.step(0, 2); // typed B
  assert.equal(e.name, 'BAA', 'Shift then B gives B in slot 0, not ABA');
  const f = createEntry('AAA');
  f.step(M_ALT, 0); f.step(M_UP, 0);
  assert.equal(f.name, 'BAA'); assert.equal(f.pos, 0, 'Shift then Up keeps slot 0');
  f.step(M_FIRE, 0); assert.equal(f.pos, 1, 'Fire still advances');
  f.step(M_FIRE, 0); f.step(M_ALT, 0); assert.equal(f.done, false, 'Shift on the last slot does not save');
  assert.equal(f.step(M_FIRE | M_ALT, 0), true, 'Fire on the last slot saves');
  const g = createEntry('AAA'); g.step(M_FIRE, 0); g.step(M_BACK, 0); assert.equal(g.pos, 0, 'Back still goes back');
});

// ---------- MED3: mutants ----------
test('todayUTC: UTC day flips exactly at 00:00:00.000 UTC', () => {
  assert.equal(todayUTC(Date.UTC(2026, 9, 28, 23, 59, 59, 999)), '2026-10-28');
  assert.equal(todayUTC(Date.UTC(2026, 9, 29, 0, 0, 0, 0)), '2026-10-29');
  assert.equal(todayUTC(Date.UTC(2026, 11, 31, 23, 59, 59, 999)), '2026-12-31');
  assert.equal(todayUTC(Date.UTC(2027, 0, 1, 0, 0, 0, 0)), '2027-01-01');
  const m = createModes({ lb: null, kv: memoryKv(), now: () => Date.UTC(2026, 9, 28, 23, 59, 59, 999) });
  assert.equal(m.todayKey(), '2026-10-28');
  assert.equal(m.begin('daily').seed, dailySeed('2026-10-28'));
  let t = Date.UTC(2026, 9, 28, 23, 59, 59, 999);
  const m2 = createModes({ lb: null, kv: memoryKv(), now: () => t });
  const a = m2.begin('daily'); t += 1; const b = m2.begin('daily');
  assert.equal(a.dayKey, '2026-10-28'); assert.equal(b.dayKey, '2026-10-29');
  assert.notEqual(a.seed, b.seed);
});

test('todayUTC gives the same day in far-east, far-west and UTC time zones', () => {
  const code = `import { todayUTC } from ${JSON.stringify(new URL('../games/starfall/modes.js', import.meta.url).href)};
    console.log([Date.UTC(2026,9,28,23,59,59,999), Date.UTC(2026,9,29,0,0,0,0), Date.UTC(2026,9,28,12)].map(t => todayUTC(t)).join(','));`;
  const outs = ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'America/Los_Angeles', 'UTC'].map(TZ =>
    execFileSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, TZ }, encoding: 'utf8' }).trim());
  for (const o of outs) assert.equal(o, '2026-10-28,2026-10-29,2026-10-28');
});

test('attract refuses a +dev replay (demo and best-of-board)', async () => {
  const dev = play(31, 'arcade+dev', 200);
  assert.equal(pickDemo(dev.replay), null, 'demo source');
  const lb = createLeaderboard({ storage: memoryAdapter(), now: () => NOW });
  await lb.submitScore({ game: GAME_ID, playerId: PID, name: 'DEV', score: 99999, replay: dev.replay, seed: 31, mode: 'free', version: GAME_VERSION });
  assert.equal(await pickBest(lb), null, 'a high +dev score on the board is never played');
  const ok = play(32, 'arcade', 200);
  await lb.submitScore({ game: GAME_ID, playerId: 'player-0002', name: 'OKK', score: 5, replay: ok.replay, seed: 32, mode: 'free', version: GAME_VERSION });
  assert.equal((await pickBest(lb)).name, 'OKK', 'falls through to the next playable row');
  assert.ok(pickDemo(DEMO_REPLAY), 'the bundled demo still plays');
});

test('league line reads the same with and without a tier', () => {
  const t = createTable({ lb: null });
  assert.equal(t.leagueLine('Bronze', 'III', 36), 'BRONZE III  36 TROPHIES');
  assert.equal(t.leagueLine('Master', null, 900), 'MASTER  900 TROPHIES');
  t.setResult({ id: 'x', placements: { all: 1 }, trophyDelta: 5, league: { name: 'Bronze', tier: 'III', label: 'Bronze III' }, trophies: 36 });
  assert.equal(t.summary, 'BRONZE III  36 TROPHIES');
  t.setResult({ id: 'x', placements: { all: 1 }, trophyDelta: 5, league: { name: 'Master', tier: null, label: 'Master' }, trophies: 900 });
  assert.equal(t.summary, 'MASTER  900 TROPHIES');
});

test('the real-clock verifier rejects a far-future daily; the game wires that one, not the clock-free export', () => {
  const d30 = play(dailySeed('2030-01-01'), 'daily', 100);
  assert.equal(makeVerifyReplay()(claim(d30.replay, dailySeed('2030-01-01'), 'daily', '2030-01-01')), NaN);
  // source check only: no browser hook reaches this wiring from npm test
  const main = fs.readFileSync(new URL('../games/starfall/main.js', import.meta.url), 'utf8');
  assert.match(main, /createLeaderboard\(\{[^}]*verifyReplay: makeVerifyReplay\(\)/);
});
