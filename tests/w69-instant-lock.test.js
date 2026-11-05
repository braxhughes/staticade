// STACKLIGHT GAME_VERSION 3.0 instant lock, through replay words on the pure sim.
// The rule (design B.6): a piece locks at the end of the first frame it rests, after that frame's turn, move and gravity.
// Every expected frame here comes from the B.6 formulas written out below, never from the sim or from lockDelayFor:
//   - a piece in the air gains G / 256 of a row per frame (soft drop: at least 128), from its spawn frame on
//   - a full fall from spawn row 18 to row 0 locks on frame spawn + ceil(18 x 256 / G) - 1
//   - a hard drop locks on its press frame; the next piece spawns 9 frames after a lock with no rows cleared
// Red-proof (docs/w69/evidence.md): a lock delay of 1, the lock check moved before input, and the lock check moved after
// input but before gravity each fail this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, EV_LOCK, EV_TOPOUT } from '../games/stacklight/sim.js';
import { GAME_VERSION, GRAVITY } from '../games/stacklight/defs.js';

const LEFT = 9, RIGHT = 18, ROTATE = 64, HARD = 32, SOFT = 4;
const mk = (t = {}) => createSim({ seed: 1, mode: 'test', test: t });
const fullFall = G => Math.ceil(18 * 256 / G); // frames from the spawn frame (frame 1) to the lock frame, B.6
function evs(sim, type) { const out = []; sim.drain((b, o) => { if (b[o] === type) out.push(Array.from(b.subarray(o, o + 6))); }); return out; }
// steps words from frame 0 until the first lock; returns its frame. Every frame before it must end with the piece out
// and in the air: under instant lock a live piece never ends a frame resting.
function firstLock(sim, wordAt, max = 1000) {
  for (let f = 0; f < max; f++) {
    sim.step(wordAt(f));
    const l = evs(sim, EV_LOCK);
    if (l.length) { assert.equal(l[0][1], f); return f; }
    assert.ok(sim.ctx.pType !== 0, `frame ${f}: the piece is out`);
    assert.ok(!sim.resting(), `frame ${f}: a live piece ended the frame resting (instant lock locks it that frame)`);
  }
  return -1;
}
// lines that start a test board on each level (Free Play: 8 lines a level)
const linesFor = level => (level - 1) * 8;

test('3.0: a do-nothing piece locks on its touchdown frame at every level 1 to 20 (frame ceil(18 x 256 / G) - 1)', () => {
  assert.equal(GAME_VERSION, '3.0');
  const want = [];
  for (let level = 1; level <= 20; level++) {
    const s = mk({ lines: linesFor(level) }); assert.equal(s.level, level);
    const L = firstLock(s, () => 0);
    assert.equal(L, fullFall(GRAVITY[level]) - 1, `level ${level}: lock frame`);
    want.push(L);
  }
  // the doc's numbers for a few levels, typed out (B.6): 768 frames at level 1, 1 at level 20 (the spawn frame)
  assert.deepEqual([want[0], want[4], want[15], want[16], want[19]], [767, 287, 22, 17, 0]);
});

test('a touchdown on a stack locks that frame; the frame after it the next piece is not out yet (entry delay)', () => {
  // a flat BAR over a flat stack 9 high falls 9 rows: at level 1 that is ceil(9 x 256 / 6) = 384 frames from spawn
  const s = mk({ heights: [9, 9, 9, 9, 9, 9, 9, 9, 9], pieces: ['BAR', 'BAR'] });
  const L = firstLock(s, () => 0);
  assert.equal(L, Math.ceil(9 * 256 / 6) - 1);
  assert.equal(s.ctx.pType, 0, 'locked: no live piece at the end of the touchdown frame');
  s.step(0); assert.equal(s.ctx.pType, 0, 'entry delay');
});

test('a move on the touchdown frame happens first: into a gap it keeps falling; one frame later it moves nothing', () => {
  // flat BAR at pivot 4 (cells 3 to 5) over a stack 4 high in columns 1 to 5; columns 6 to 8 are a pit 0 deep
  const t = { heights: [4, 4, 4, 4, 4, 4, 0, 0, 0], pieces: ['BAR', 'BAR'] };
  const T = firstLock(mk(t), () => 0); // control: lands on the stack
  assert.equal(T, Math.ceil(14 * 256 / 6) - 1);
  // RIGHT three times on frames T-4, T-2, T: the last one, on the touchdown frame, puts it over the pit before gravity
  const at = f => (f === T - 4 || f === T - 2 || f === T) ? RIGHT : 0;
  const s = mk(t); const L = firstLock(s, at);
  assert.equal(s.ctx.pType, 0);
  assert.ok(L > T, `it did not lock on the stack (${L} > ${T})`);
  // from the touchdown frame on it falls the remaining 4 rows at G 6: the sub-row counter was never thrown away
  assert.equal(L, Math.ceil(18 * 256 / 6) - 1, 'and it locks on the floor on the full-fall frame');
  // the same three presses one frame late: the piece locked on the stack at T, the last press moves nothing
  const late = mk(t); const T2 = firstLock(late, f => (f === T - 3 || f === T - 1 || f === T + 1) ? RIGHT : 0);
  assert.equal(T2, T, 'late press: locked on the stack on the touchdown frame');
  const g = Array.from(late.grid); late.step(RIGHT); assert.deepEqual(Array.from(late.grid), g);
});

test('a turn on the touchdown frame happens first: a flat BAR turned upright over a 1-wide well drops into it', () => {
  // flat BAR at pivot 4 over columns 3 to 5 at height 6, with column 4 a well 0 deep
  const t = { heights: [0, 0, 0, 6, 0, 6, 0, 0, 0], pieces: ['BAR', 'BAR'] };
  const T = firstLock(mk(t), () => 0);
  assert.equal(T, Math.ceil(12 * 256 / 6) - 1, 'control: rests flat on the two walls');
  const s = mk(t); const L = firstLock(s, f => (f === T ? ROTATE : 0));
  assert.ok(L > T, 'the turn came before the lock check');
  assert.equal(L, Math.ceil(18 * 256 / 6) - 1, 'upright, it falls on into the well and locks on the floor');
  assert.equal(s.ctx.px, 4);
});

test('soft drop held from the spawn frame locks on frame ceil(18 x 256 / 128) - 1; a hard drop locks on its press frame', () => {
  const s = mk({ pieces: ['BAR', 'BAR'] });
  assert.equal(firstLock(s, () => SOFT), 35);
  for (const level of [1, 10, 19]) {
    for (const press of [0, 3, 9]) {
      const h = mk({ lines: linesFor(level), pieces: ['PLUS', 'BAR'] });
      if (press >= fullFall(GRAVITY[level])) continue;
      assert.equal(firstLock(h, f => (f === press ? HARD : 0)), press, `level ${level} hard drop on frame ${press}`);
      // next piece out on frame press + 9 (8 entry frames), and it is in the air at that frame's end
      for (let f = press + 1; f < press + 9; f++) { h.step(0); assert.equal(h.ctx.pType, 0, 'entry delay frame ' + f); }
      h.step(0); assert.ok(h.ctx.pType !== 0 && !h.resting(), 'next piece out on frame ' + (press + 9));
    }
  }
});

test('sliding off a ledge on the touchdown frame keeps it falling; it locks on landing on the floor', () => {
  // flat BAR pushed right to pivot 7 (cells 6 to 8) lands on column 8 (12 high); LEFT on that frame puts it at pivot 6
  // (cells 5 to 7), over the floor
  const t = { heights: [0, 0, 0, 0, 0, 0, 0, 0, 12], pieces: ['BAR', 'BAR'] };
  const walk = f => (f === 0 || f === 2 || f === 4) ? RIGHT : 0;
  const T = firstLock(mk(t), walk);
  assert.equal(T, Math.ceil(6 * 256 / 6) - 1, 'control: locks on the ledge on its touchdown frame');
  const s = mk(t); const L = firstLock(s, f => (f === T ? LEFT : walk(f)));
  assert.deepEqual([s.ctx.px, L], [6, Math.ceil(18 * 256 / 6) - 1]);
});

test('a piece that spawns resting locks on its spawn frame, at level 1 too (and that lock tops out)', () => {
  // first piece: hard drop on frame 0, a flat BAR on columns 3 to 5 at row 17 (on a stack 17 high there)
  const s = mk({ heights: [0, 0, 0, 17, 17, 17, 0, 0, 0], pieces: ['BAR', 'BAR'] });
  assert.equal(s.level, 1);
  s.step(HARD);
  const [l0] = evs(s, EV_LOCK); assert.equal(l0[1], 0);
  for (let f = 1; f < 9; f++) { s.step(0); assert.equal(evs(s, EV_LOCK).length, 0); }
  // frame 9: the next BAR spawns at row 18 resting on row 17. It locks that frame and its cells are in the spawn zone
  s.step(0);
  const out = [];
  s.drain((b, o) => { if (b[o] === EV_LOCK || b[o] === EV_TOPOUT) out.push([b[o], b[o + 1]]); });
  assert.deepEqual(out, [[EV_LOCK, 9], [EV_TOPOUT, 9]], 'locked and topped out on the spawn frame');
  assert.equal(s.reason, 'topout');
});

test('frame-end invariant over whole runs: no live piece ever ends a frame resting, and lockT is 0 at every frame end', () => {
  for (const seed of [1, 2, 3]) {
    const s = createSim({ seed, mode: 'arcade' });
    for (let i = 0; i < 30000 && !s.done; i++) {
      const k = (i * 7 + seed) % 11;
      s.step(k === 0 ? LEFT : k === 3 ? RIGHT : k === 5 ? ROTATE : k === 7 ? SOFT : 0);
      if (s.ctx.pType) assert.ok(!s.resting(), `seed ${seed} frame ${i}: resting at frame end`);
      assert.equal(s.ctx.lockT, 0, `seed ${seed} frame ${i}`);
      s.clearEvents();
    }
  }
});
