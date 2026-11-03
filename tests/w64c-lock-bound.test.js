// The true STACKLIGHT lock bound. A resting frame sets the sub-row counter to 0, so a piece that slides onto a
// ledge late in a row's fall throws away part of a row. Written out here from the STACKLIGHT design document, B.6, not
// read from the sim. A piece's life (spawn frame = frame 1) is: the fall to its first rest, r1 rows plus the discarded
// partial row, at most ceil((r1 + 1) x 256 / G) frames; then at most delay - 2 more frames to its last resting frame
// (that frame has lockT <= delay - 1, or it would have locked); then, if the delay ran out in the air, the fall of the
// remaining r3 <= 18 - r1 rows from a rest, at most ceil(r3 x 256 / G) frames. If it locks while resting instead, the
// life is at most ceil(18 x 256 / G) + delay - 1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, PH_PLAY } from '../games/stacklight/sim.js';
import { GRAVITY, lockDelayFor } from '../games/stacklight/defs.js';
import { Rng } from '../engine/rng.js';

const rows = (r, G) => Math.ceil(r * 256 / G);
export const bound = (level) => {
  const G = GRAVITY[level], delay = lockDelayFor(level);
  let air = 0; // delay ran out in the air: first rest after r1 rows (a ledge, so r1 <= 17), then the rest of the fall
  for (let r1 = 0; r1 <= 17; r1++) air = Math.max(air, rows(r1 + 1, G) + rows(18 - r1, G) + delay - 2);
  return Math.max(air, rows(18, G) + delay - 1);
};
const LV = [[1, 0], [2, 8], [5, 32], [10, 72], [13, 96], [16, 120]];
const LEFT = 9, RIGHT = 18;
const start = (heights, lines, seed = 1, pieces = ['BAR', 'BAR']) => {
  const s = createSim({ seed, mode: 'test', test: { heights, pieces, lines } });
  let g = 0; while (s.ctx.phase !== PH_PLAY && g++ < 100) s.step(0);
  return s;
};

// The stretch shape: wait until the pivot is on the ledge row with the sub counter near a full row, tap
// right onto the ledge, stay `slide` frames, step off. Returns frames from spawn to lock.
function stretch(lvl, lines, H, slide, trigger) {
  const G = GRAVITY[lvl];
  const s = start([0, 0, 0, 0, 0, 0, H, 0, 0], lines);
  const sp = s.ctx.spawned, f0 = s.frame;
  let state = 0;
  while (s.ctx.spawned === sp && s.ctx.pType && s.frame - f0 < 3000) {
    let w = 0;
    if (state === 0 && s.ctx.py === H && s.ctx.px === 4 && s.ctx.sub + G >= trigger) { w = RIGHT; state = 1; }
    else if (state === 1 && s.ctx.lockT >= 1) state = 2;
    if (state === 2 && s.ctx.lockT >= slide + 1) { w = LEFT; state = 3; }
    s.step(w);
    if (state === 1 && s.ctx.lockT >= 1) state = 2;
  }
  assert.ok(s.ctx.spawned !== sp || !s.ctx.pType, 'the piece locked');
  return s.frame - f0 + 1;
}

test('partial-row ledge slide: never beyond the bound, and the bound is reached, at levels 1, 2, 5, 10, 13, 16', () => {
  const table = [];
  for (const [lvl, lines] of LV) {
    const G = GRAVITY[lvl], delay = lockDelayFor(lvl);
    let worst = 0;
    // broad grid: every ledge height 1 to 16, every slide length, three sub phases
    for (let H = 1; H <= 16; H++) {
      for (let slide = 0; slide <= delay; slide++) {
        for (const trigger of [256 - G, 256 - 2 * G, 128]) {
          const life = stretch(lvl, lines, H, slide, trigger);
          assert.ok(life <= bound(lvl), `level ${lvl} ledge ${H} slide ${slide}: ${life} frames, bound ${bound(lvl)}`);
          if (life > worst) worst = life;
        }
      }
    }
    // fine grid on the ledges that make the longest lives: every sub phase
    for (const H of [1, 2]) for (const slide of [delay - 3, delay - 2, delay - 1]) for (let trigger = 0; trigger <= 260; trigger++) {
      const life = stretch(lvl, lines, H, slide, trigger);
      assert.ok(life <= bound(lvl), `level ${lvl} ledge ${H} slide ${slide} phase ${trigger}: ${life} frames, bound ${bound(lvl)}`);
      if (life > worst) worst = life;
    }
    assert.equal(worst, bound(lvl), `level ${lvl}: the longest life found should equal the bound (it is tight)`);
    table.push(`level ${lvl}: worst found ${worst}, bound ${bound(lvl)}`);
  }
  console.log(table.join('\n'));
});

test('the old 18-row bound is really too small (the partial-row slide beats it at level 1), so the test above can fail', () => {
  const old = Math.ceil(18 * 256 / GRAVITY[1]) + lockDelayFor(1);
  assert.equal(old, 800);
  let best = 0; for (let slide = 0; slide <= 32; slide++) best = Math.max(best, stretch(1, 0, 2, slide, 256 - GRAVITY[1]));
  assert.ok(best > old, `best ${best}`);
});

test('seeded random-input fuzz: thousands of pieces per level all lock within the bound', () => {
  const WORDS = [0, 0, 0, LEFT, RIGHT, 64, 4, 1, 2, 3, 5];
  for (const [lvl, lines] of LV) {
    const rng = new Rng(64 * 1000 + lvl);
    const limit = bound(lvl); let pieces = 0, worst = 0;
    while (pieces < 2500) {
      const heights = []; for (let i = 0; i < 9; i++) heights.push(rng.int(2) ? 0 : rng.int(17));
      let s; try { s = start(heights, lines, 1 + rng.int(1e6), ['BAR', 'PLUS', 'BAR', 'PLUS']); } catch (e) { continue; }
      if (s.ctx.phase !== PH_PLAY) continue;
      const mode = rng.int(3), p = rng.next();
      for (let k = 0; k < 4 && !s.ctx.done; k++) { // follow several pieces on the same board
        let g = 0; while ((s.ctx.phase !== PH_PLAY || !s.ctx.pType) && !s.ctx.done && g++ < 300) s.step(0);
        if (s.ctx.done || !s.ctx.pType) break;
        const sp = s.ctx.spawned, f0 = s.frame;
        while (s.ctx.spawned === sp && s.ctx.pType && s.frame - f0 < limit + 100) {
          let w;
          if (mode === 0) w = WORDS[rng.int(WORDS.length)];
          else if (mode === 1) w = (s.frame & 1) ? LEFT : RIGHT;
          else w = rng.next() < p ? ((s.frame % 3 === 0) ? LEFT : RIGHT) : 0;
          s.step(w);
        }
        assert.ok(s.ctx.spawned !== sp || !s.ctx.pType, `level ${lvl}: a piece outlived ${limit + 100} frames`);
        const life = s.frame - f0 + 1; // the spawn frame counts as frame 1
        assert.ok(life <= limit, `level ${lvl}: ${life} frames from spawn, bound ${limit}`);
        pieces++; if (life > worst) worst = life;
      }
    }
    console.log(`fuzz level ${lvl}: ${pieces} pieces, worst ${worst}, bound ${limit}`);
  }
});
