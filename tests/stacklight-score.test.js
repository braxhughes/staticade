// STACKLIGHT scoring (the STACKLIGHT design notes B.7) and the C.6 stream test vector. Slice T1 verify:
// the B.7 worked example from the test-only start, fed B.7's word list, must give exactly 1,815.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from '../engine/rng.js';
import { createSim } from '../games/stacklight/sim.js';
import { streamSeed, COLS } from '../games/stacklight/defs.js';
import { columnHeight } from '../games/stacklight/sim/board.js';
import { clearPoints, fitPoints, nextGlow, levelFor } from '../games/stacklight/sim/score.js';

const B7_WORDS = `0:32  29:9 31:9 33:9  80:32  89:18 91:18 93:18  140:32  169:9 171:9  450:32
459:18 461:18  520:32  529:64 531:9 533:9 535:9 537:9  600:32
609:64 611:18 613:18 615:18 617:18  660:32`;
// score and heights after each step's drop frame (B.7 table)
const B7_STEPS = [[0, 660, [0, 0, 0, 1, 2, 1, 0, 0, 0]], [80, 780, [1, 1, 1, 1, 2, 1, 0, 0, 0]], [140, 1275, [0, 0, 0, 0, 1, 0, 0, 0, 0]],
  [450, 1395, [0, 1, 1, 1, 1, 0, 0, 0, 0]], [520, 1515, [0, 1, 1, 1, 1, 1, 1, 1, 0]], [600, 1515, [3, 1, 1, 1, 1, 1, 1, 1, 0]],
  [660, 1815, [2, 0, 0, 0, 0, 0, 0, 0, 2]]];
// golden hashes recorded by T1 (B.7: "records stateHash() after frame 0 and after frame 660")
const HASH_AFTER_0 = 54503069, HASH_AFTER_660 = 2263656401;

test('B.7 worked example: test-only start, B.7 word list, total 1815, lines 19, level 3', () => {
  const sim = createSim({ seed: 1, mode: 'test', test: { heights: [1, 1, 1, 1, 0, 1, 1, 1, 1], lines: 16, pieces: ['PLUS', 'BAR', 'BAR', 'BAR', 'BAR', 'BAR', 'BAR'] } });
  const words = new Map(B7_WORDS.trim().split(/\s+/).map(s => s.split(':').map(Number)));
  const steps = new Map(B7_STEPS.map(s => [s[0], s]));
  for (let f = 0; f <= 660; f++) {
    sim.step(words.get(f) || 0);
    if (f === 0) assert.equal(sim.stateHash(), HASH_AFTER_0);
    const st = steps.get(f);
    if (st) {
      const h = []; for (let c = 0; c < COLS; c++) h.push(columnHeight(sim.grid, c));
      assert.equal(sim.score, st[1], 'score after frame ' + f); assert.deepEqual(h, st[2], 'heights after frame ' + f);
    }
  }
  console.log('B.7 total', sim.score);
  assert.equal(sim.score, 1815); assert.equal(sim.lines, 19); assert.equal(sim.level, 3);
  assert.equal(sim.stateHash(), HASH_AFTER_660);
});

test('C.6 test vector', () => {
  const want = { pieces: [2760421238, [5, 41, 5]], dusk: [2761248098, [4, 31, 18]], daily: [1325341515, [57, 29, 5]], bot: [369394894, [20, 38, 56]] };
  for (const [name, [s, ints]] of Object.entries(want)) {
    assert.equal(streamSeed(1, name), s, name);
    const r = new Rng(s); assert.deepEqual([r.int(64), r.int(64), r.int(64)], ints, name);
  }
  const r = new Rng(1); assert.deepEqual([r.u32(), r.u32(), r.u32()], [3585872636, 2787328886, 4207505755]);
  const d = new Rng(streamSeed(1, 'daily')); assert.equal(d.int(64), 57); assert.equal(d.int(3), 1);
});

test('score tables: integer clear points, FIT points, GLOW steps, levels', () => {
  assert.equal(clearPoints(1, 3, 0), 300); assert.equal(clearPoints(1, 3, 1), 375); assert.equal(clearPoints(2, 1, 0), 260);
  assert.equal(clearPoints(3, 10, 4), 12800); assert.equal(clearPoints(0, 5, 2), 0);
  for (let n = 1; n <= 3; n++) for (let l = 1; l <= 20; l++) for (let g = 0; g <= 4; g++) assert.ok(Number.isInteger(clearPoints(n, l, g)));
  assert.equal(fitPoints(1, 3), 120); assert.equal(fitPoints(2, 3), 360); assert.equal(fitPoints(0, 3), 0);
  assert.equal(nextGlow(0, 100), 1); assert.equal(nextGlow(4, 1), 4); assert.equal(nextGlow(3, 0), 0);
  assert.equal(levelFor(false, 23), 3); assert.equal(levelFor(false, 24), 4); assert.equal(levelFor(false, 999), 20);
  assert.equal(levelFor(true, 0), 4); assert.equal(levelFor(true, 6), 5); assert.equal(levelFor(true, 999), 20);
});
