// The true STACKLIGHT lock bound. GAME_VERSION 2.0 had a lock delay, and a resting frame set the sub-row
// counter to 0, so a piece that slid onto a ledge late in a row's fall threw away part of a row and lived longer than
// the plain 18-row fall. GAME_VERSION 3.0 (D119) locks a piece on its first resting frame, so the only frame
// that sets the sub-row counter to 0 is the lock frame: nothing is thrown away. Written out here from the STACKLIGHT
// design document, B.6, NOT read from the sim or from lockDelayFor (so a sim with a lock delay of 1 fails this file):
// a piece falls at most 18 rows (spawn row 18 to row 0, never up), it gains G / 256 of a row every frame it is in the
// air, so from its spawn frame (frame 1) it lives at most ceil(18 x 256 / G) frames, and the plain full fall lives
// exactly that long. Rewritten for 3.0 (D119 approved this file): same three checks (attack grid with tightness, the
// bound one frame shorter is too small, the seeded fuzz).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, PH_PLAY } from '../games/stacklight/sim.js';
import { GRAVITY } from '../games/stacklight/defs.js';
import { Rng } from '../engine/rng.js';

const rows = (r, G) => Math.ceil(r * 256 / G);
export const bound = (level) => rows(18, GRAVITY[level]);
// the bounds B.6 states for these levels, typed from the doc
const DOC = { 1: 768, 2: 576, 5: 288, 10: 91, 13: 46, 16: 23 };
const LV = [[1, 0], [2, 8], [5, 32], [10, 72], [13, 96], [16, 120]];
const LEFT = 9, RIGHT = 18;
const start = (heights, lines, seed = 1, pieces = ['BAR', 'BAR']) => {
  const s = createSim({ seed, mode: 'test', test: { heights, pieces, lines } });
  let g = 0; while (s.ctx.phase !== PH_PLAY && g++ < 100) s.step(0);
  return s;
};

// The stretch shape: wait until the pivot is on the ledge row with the sub counter near a full row, tap
// right onto the ledge, stay `slide` frames, step off. Returns frames from spawn to lock. On 3.0 the piece locks on the
// frame it taps onto the ledge, so the stay and the step off never happen; H = 0 is the floor (no ledge): the full fall.
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
    const G = GRAVITY[lvl];
    assert.equal(bound(lvl), DOC[lvl], `level ${lvl}: the formula gives the bound B.6 states`);
    let worst = 0;
    // broad grid: the floor and every ledge height 1 to 16, slide lengths 0 to 32 (the 2.0 level 1 delay), three sub phases
    for (let H = 0; H <= 16; H++) {
      for (let slide = 0; slide <= 32; slide += (slide < 4 ? 1 : 7)) {
        for (const trigger of [256 - G, 256 - 2 * G, 128]) {
          const life = stretch(lvl, lines, H, slide, trigger);
          assert.ok(life <= bound(lvl), `level ${lvl} ledge ${H} slide ${slide}: ${life} frames, bound ${bound(lvl)}`);
          if (life > worst) worst = life;
        }
      }
    }
    // fine grid on the ledges that made the longest 2.0 lives: every sub phase
    for (const H of [1, 2]) for (const slide of [0, 1, 2]) for (let trigger = 0; trigger <= 260; trigger++) {
      const life = stretch(lvl, lines, H, slide, trigger);
      assert.ok(life <= bound(lvl), `level ${lvl} ledge ${H} slide ${slide} phase ${trigger}: ${life} frames, bound ${bound(lvl)}`);
      if (life > worst) worst = life;
    }
    assert.equal(worst, bound(lvl), `level ${lvl}: the longest life found should equal the bound (it is tight)`);
    table.push(`level ${lvl}: worst found ${worst}, bound ${bound(lvl)}`);
  }
  console.log(table.join('\n'));
});

test('a bound one frame shorter is really too small (the full fall beats it at level 1), so the test above can fail', () => {
  const short = Math.ceil(18 * 256 / GRAVITY[1]) - 1;
  assert.equal(short, 767);
  let best = 0;
  for (const H of [0, 1, 2]) for (let slide = 0; slide <= 32; slide++) best = Math.max(best, stretch(1, 0, H, slide, 256 - GRAVITY[1]));
  assert.ok(best > short, `best ${best}`);
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
