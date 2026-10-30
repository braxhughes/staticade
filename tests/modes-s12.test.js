// S12: Daily Flight / Free Play rules, submit with replay, name entry, attract-mode source choice, demo replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dailySeed } from '../engine/rng.js';
import { decode, createRecorder } from '../engine/replay.js';
import { M_UP, M_DOWN, M_FIRE, M_BACK } from '../engine/input.js';
import { createLeaderboard } from '../leaderboard/api.js';
import { memoryAdapter } from '../leaderboard/storage.js';
import { createSim, GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { createModes, createEntry, createTable, memoryKv, storageKv, resimReplay, makeVerifyReplay, todayUTC, ENTRY_TICKS } from '../games/starfall/modes.js';
import { createAttract, pickBest, pickDemo, IDLE_TICKS } from '../games/starfall/attract.js';
import { DEMO_REPLAY } from '../games/starfall/demo-replay.js';
import { makeDemo } from '../tools/make-demo.mjs';

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const PID = 'player-0001';

// play the demo bot's input words on a fresh sim for the given seed/mode; returns the sim and its replay string
function play(seed, mode, frames = 900) {
  const words = decode(DEMO_REPLAY).words, sim = createSim({ seed, mode }), rec = createRecorder(256);
  for (let i = 0; i < frames && i < words.length; i++) { sim.step(words[i]); rec.push(words[i]); sim.clearEvents(); }
  return { sim, replay: rec.encode({ game: GAME_ID, version: GAME_VERSION, seed, mode }) };
}
const env = () => {
  const lb = createLeaderboard({ storage: memoryAdapter(), now: () => NOW, verifyReplay: makeVerifyReplay({ now: () => NOW }) });
  const kv = memoryKv();
  return { lb, kv, modes: createModes({ lb, kv, now: () => NOW }) };
};

test('daily seed is the UTC-date seed; free seed is the one given', () => {
  const { modes } = env();
  const d = modes.begin('daily');
  assert.equal(d.dayKey, '2026-10-28');
  assert.equal(d.seed, dailySeed(todayUTC(NOW)));
  assert.equal(modes.begin('free', 12345).seed, 12345);
  assert.throws(() => modes.begin('arcade'));
});

test('first-started rule: the second daily run of the day is practice and is not submitted as ranked', async () => {
  const { modes, lb } = env();
  const a = modes.begin('daily'), b = modes.begin('daily');
  assert.equal(modes.attemptUsed(a.dayKey), false);
  assert.equal(modes.claim(a), true, 'first started run is ranked');
  assert.equal(modes.attemptUsed(a.dayKey), true, 'marker written at the first gameplay frame');
  assert.equal(modes.claim(b), false, 'second run is practice');
  assert.equal(modes.claim(a), true, 'claiming again does not change the answer');
  const { sim, replay } = play(b.seed, 'daily');
  assert.ok(sim.score > 0);
  assert.equal(modes.canSubmit(b, sim), false);
  await assert.rejects(modes.submit(b, sim, replay, 'AAA', PID), /cannot be submitted/);
  assert.equal((await lb.getBoard({ game: GAME_ID, board: 'all' })).length, 0, 'nothing reached the board');
  // the ranked one does go through
  const r = play(a.seed, 'daily');
  assert.equal(modes.canSubmit(a, r.sim), true);
  const res = await modes.submit(a, r.sim, r.replay, 'AAA', PID);
  assert.equal(res.placements.daily, 1);
});

test('a quit run still uses the daily attempt (marker is stored at claim, before any score)', () => {
  const kv = memoryKv();
  const m1 = createModes({ lb: null, kv, now: () => NOW });
  m1.claim(m1.begin('daily'));
  const m2 = createModes({ lb: null, kv, now: () => NOW }); // same storage, e.g. after a reload
  assert.equal(m2.claim(m2.begin('daily')), false);
  // a new UTC day gets a new attempt
  const m3 = createModes({ lb: null, kv, now: () => NOW + 86400000 });
  assert.equal(m3.claim(m3.begin('daily')), true);
});

test('free play: every run is ranked', () => {
  const { modes } = env();
  assert.equal(modes.claim(modes.begin('free', 1)), true);
  assert.equal(modes.claim(modes.begin('free', 2)), true);
});

test('a submitted run replay re-simulates to the submitted score and hash', async () => {
  const { modes, lb } = env();
  const run = modes.begin('free', 777); modes.claim(run);
  const { sim, replay } = play(777, 'arcade');
  const res = await modes.submit(run, sim, replay, 'ACE', PID);
  const stored = await lb.getReplay(res.id);
  assert.equal(stored.version, GAME_VERSION);
  assert.equal(stored.seed, 777);
  const again = resimReplay(stored.replay);
  assert.equal(again.score, stored.score);
  assert.equal(again.score, sim.score);
  assert.equal(again.hash, stored.stats.hash);
  assert.equal(again.frames, stored.stats.frames);
  const row = (await lb.getBoard({ game: GAME_ID, board: 'all' }))[0];
  assert.deepEqual([row.name, row.score, row.mode], ['ACE', sim.score, 'free']);
  // the same run cannot be submitted twice
  await assert.rejects(modes.submit(run, sim, replay, 'ACE', PID));
});

test('the leaderboard verifier rejects a claimed score the replay does not earn', async () => {
  const { lb } = env();
  const { sim, replay } = play(5, 'arcade');
  await assert.rejects(lb.submitScore({ game: GAME_ID, playerId: PID, name: 'CHT', score: sim.score + 1, replay, seed: 5, mode: 'free', version: GAME_VERSION }), /replay_mismatch|replay scores/);
  await assert.rejects(lb.submitScore({ game: GAME_ID, playerId: PID, name: 'CHT', score: sim.score, replay, seed: 6, mode: 'free', version: GAME_VERSION }), /replay scores/);
});

test('tainted runs, stage starts and zero scores are never submitted', () => {
  const { modes } = env();
  const run = modes.begin('free', 9); modes.claim(run);
  const { sim } = play(9, 'arcade');
  assert.equal(modes.canSubmit(run, sim), true);
  sim.fill(); // test hook taints the run
  assert.equal(modes.canSubmit(run, sim), false);
  const stage = play(9, 'stage5').sim;
  assert.equal(modes.canSubmit(run, stage), false);
  assert.equal(modes.canSubmit(run, createSim({ seed: 9, mode: 'arcade' })), false, 'score 0');
  assert.equal(modes.canSubmit(null, sim), false);
});

test('name entry: three letters, up/down cycle, fire advances and confirms, back steps back, typing, timeout', () => {
  const e = createEntry('AAA');
  e.step(M_UP); e.step(M_UP);
  assert.equal(e.name, 'CAA');
  e.step(M_DOWN); e.step(M_DOWN); e.step(M_DOWN);
  assert.equal(e.name, 'ZAA', 'wraps below A');
  e.step(M_FIRE); assert.equal(e.pos, 1);
  e.step(M_BACK); assert.equal(e.pos, 0);
  e.step(0, 8); assert.equal(e.name, 'HAA'); assert.equal(e.pos, 1);
  e.step(0, 9); e.step(0, 10); assert.equal(e.name, 'HIJ'); assert.equal(e.pos, 2, 'typing stops on the last slot');
  assert.equal(e.step(M_FIRE), true); assert.equal(e.done, true);
  assert.equal(createEntry('zq?').name, 'ZQA', 'bad characters fall back to A');
  const t = createEntry('BOB'); let confirmed = false;
  for (let i = 0; i < ENTRY_TICKS && !confirmed; i++) confirmed = t.step(0);
  assert.equal(confirmed, true, 'times out and confirms');
});

test('storageKv keeps working when localStorage refuses', () => {
  const bad = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); } };
  const kv = storageKv(bad);
  kv.set('daily-attempt:x', '1');
  assert.equal(kv.get('daily-attempt:x'), '1');
});

test('table rows load per board and a submit result sets the highlight', async () => {
  const { modes, lb } = env();
  const run = modes.begin('daily'); modes.claim(run);
  const { sim, replay } = play(run.seed, 'daily');
  const res = await modes.submit(run, sim, replay, 'ZED', PID);
  const t = createTable({ lb });
  await t.refresh(); t.setResult(res);
  for (const i of [0, 1, 2]) { assert.equal(t.rows[i].length, 1); assert.equal(t.rows[i][0].name, 'ZED'); }
  assert.equal(t.hiId, res.id);
  assert.match(t.note, /^RANK 1 ALL-TIME  1 TODAY/);
});

test('attract: best same-version replay wins; other versions are skipped; demo is the fallback; else table only', async () => {
  const { modes, lb } = env();
  assert.equal(await pickBest(lb), null);
  const run = modes.begin('free', 31); modes.claim(run);
  const a = play(31, 'arcade', 700);
  await modes.submit(run, a.sim, a.replay, 'BEST', PID);
  const best = await pickBest(lb);
  assert.equal(best.kind, 'best'); assert.equal(best.name, 'BEST'); assert.equal(best.score, a.sim.score);
  // a higher-scoring run recorded on another version is shown on the board but never played
  const other = createLeaderboard({ storage: memoryAdapter(), now: () => NOW });
  const { replay } = play(32, 'arcade', 300);
  const oldVer = replay.replace('~' + GAME_VERSION + '~', '~0.9~');
  await other.submitScore({ game: GAME_ID, playerId: PID, name: 'OLD', score: 99999, replay: oldVer, seed: 32, mode: 'free', version: '0.9' });
  assert.equal(await pickBest(other), null, 'version mismatch skipped');
  const fb = createAttract({ lb: other, demo: DEMO_REPLAY });
  await fb.prepare();
  assert.equal(fb.kind, 'demo'); assert.equal(fb.banner, 'DEMO FLIGHT');
  const none = createAttract({ lb: other, demo: DEMO_REPLAY.replace('~' + GAME_VERSION + '~', '~0.9~') });
  await none.prepare();
  assert.equal(none.kind, 'none');
  none.start(); assert.equal(none.phase, 'table');
});

test('attract: plays the replay live, then the table, then the replay again; the banner names the best flight', async () => {
  const { modes, lb } = env();
  const run = modes.begin('free', 41); modes.claim(run);
  const a = play(41, 'arcade', 500);
  await modes.submit(run, a.sim, a.replay, 'ACE', PID);
  const at = createAttract({ lb, demo: DEMO_REPLAY, playTicks: 200, tableTicks: 100 });
  at.start(); assert.equal(at.phase, 'wait');
  await at.prepare();
  assert.equal(at.phase, 'play'); assert.equal(at.banner, 'BEST FLIGHT: ACE ' + a.sim.score);
  for (let i = 0; i < 200; i++) at.update();
  assert.equal(at.phase, 'table');
  for (let i = 0; i < 100; i++) at.update();
  assert.equal(at.phase, 'play'); assert.equal(at.sim.frame, 0, 'a fresh sim for the next pass');
  // the whole recorded run re-simulates to its score
  const full = createAttract({ lb, demo: DEMO_REPLAY, playTicks: 5000 });
  await full.prepare(); full.start();
  for (let i = 0; i < 600; i++) full.update();
  assert.equal(full.sim.score, a.sim.score);
  assert.equal(IDLE_TICKS, 1800, '30 s at 60 Hz');
});

test('demo replay: tools/make-demo.mjs output is deterministic and, if current, re-simulates', () => {
  const a = makeDemo(), b = makeDemo();
  assert.equal(a.replay, b.replay);
  assert.equal(decode(a.replay).version, GAME_VERSION);
  const r = resimReplay(a.replay);
  assert.equal(r.score, a.score); assert.equal(r.hash, a.hash);
  // the bundled file: when its version is current it must be what the tool makes; a stale one is ignored by attract mode
  if (decode(DEMO_REPLAY).version === GAME_VERSION) assert.equal(DEMO_REPLAY, a.replay, 'bundled demo differs from make-demo output: run node tools/make-demo.mjs');
  else { assert.equal(pickDemo(DEMO_REPLAY), null); process.stderr.write('note: demo-replay.js is stale; run node tools/make-demo.mjs\n'); }
});
