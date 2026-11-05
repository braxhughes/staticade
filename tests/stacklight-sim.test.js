// STACKLIGHT sim core rules (STACKLIGHT design document B.1 to B.9, C.1, C.2, C.6). Slice T1.
// Rules, determinism, no allocation in step() and stateHash(), reserved bits, the previous-word press rule, the hash
// covering every piece of state, the test-only start, purity, and the survival proof re-run on the RIDGES table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Rng } from '../engine/rng.js';
import { decode } from '../engine/replay.js';
import { createSim, PH_PLAY, PH_DELAY, EV_LOCK, EV_TURN, EV_CLEAR, EV_SPAWN } from '../games/stacklight/sim.js';
import {
  COLS, TOTAL_ROWS, BAR, PLUS, ROT_H, ROT_V, RUN_CAP, RIDGES, DECK, LEAN_DECK, streamSeed, GAME_ID, GAME_VERSION
} from '../games/stacklight/defs.js';
import { columnHeight } from '../games/stacklight/sim/board.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SIM = path.join(ROOT, 'games/stacklight/sim.js');

// ---------- helpers ----------
const mk = (t = {}, seed = 1) => createSim({ seed, mode: 'test', test: t });
const heights = sim => { const a = []; for (let c = 0; c < COLS; c++) a.push(columnHeight(sim.grid, c)); return a; };
const cellCount = sim => { let n = 0; for (const v of sim.grid) if (v) n++; return n; };
function events(sim, type) { const out = []; sim.drain((b, o) => { if (b[o] === type) out.push(Array.from(b.subarray(o, o + 6))); }); return out; }
// step until a piece is in play (the spawn frame is stepped with word 0)
function toPlay(sim) { while (sim.ctx.phase !== PH_PLAY && !sim.done) sim.step(0); }
// drives one piece: turn to rot, tap to col (pivot column), hard drop. Returns the lock frame.
function place(sim, col, rot = ROT_H) {
  toPlay(sim);
  const S = sim.ctx;
  if (S.pType === BAR && S.rot !== rot) { sim.step(64); sim.step(0); }
  let guard = 0;
  while (S.px !== col && guard++ < 20) { sim.step(S.px > col ? 9 : 18); sim.step(0); }
  const f = sim.frame; sim.step(32);
  return f;
}

// ---------- C.6 ----------
test('C.6 test vector: streamSeed and the first draws of every stream for seed 1', () => {
  const want = { pieces: [2760421238, [5, 41, 5]], dusk: [2761248098, [4, 31, 18]], daily: [1325341515, [57, 29, 5]], bot: [369394894, [20, 38, 56]] };
  for (const [name, [s, ints]] of Object.entries(want)) {
    assert.equal(streamSeed(1, name), s, name);
    const r = new Rng(streamSeed(1, name));
    assert.deepEqual([r.int(64), r.int(64), r.int(64)], ints, name);
  }
  const r = new Rng(1);
  assert.deepEqual([r.u32(), r.u32(), r.u32()], [3585872636, 2787328886, 4207505755]);
});

// ---------- modes and the test-only start (B.7, B.9, C.3) ----------
test('modes: arcade and daily only; test start only with mode test; replay() is null for a test start', () => {
  assert.throws(() => createSim({ seed: 1, mode: 'pvp' }), /unknown mode/);
  assert.throws(() => createSim({ seed: 1, mode: 'stage4' }), /unknown mode/);
  assert.throws(() => createSim({ seed: 1, mode: 'arcade', test: { lines: 16 } }), /only allowed with mode test/);
  assert.throws(() => createSim({ seed: 1, mode: 'daily', test: {} }), /only allowed with mode test/);
  assert.throws(() => createSim({ seed: 1, mode: 'test' }), /needs a test start/);
  assert.throws(() => mk({ heights: [1, 1, 1] }), /heights/);
  assert.throws(() => mk({ heights: [18, 0, 0, 0, 0, 0, 0, 0, 0] }), /height out of range/);
  assert.throws(() => mk({ pieces: ['T'] }), /BAR or PLUS/);
  const t = mk({ lines: 16 });
  t.step(0);
  assert.equal(t.replay(), null);
  assert.equal(t.level, 3, 'lines 16 is level 3 (Free Play rule)');
  const a = createSim({ seed: 7, mode: 'arcade' });
  for (let i = 0; i < 50; i++) a.step(i % 7 === 0 ? 9 : 0);
  const d = decode(a.replay());
  assert.equal(d.game, GAME_ID); assert.equal(d.version, GAME_VERSION); assert.equal(d.mode, 'arcade'); assert.equal(d.seed, 7);
  assert.equal(d.frames, 50); assert.equal(d.words[0], 9); assert.equal(d.words[1], 0);
});

test('Free Play start: level 1, empty board, 3-piece preview, first piece on frame 0 at the spawn pivot', () => {
  const s = createSim({ seed: 1, mode: 'arcade' });
  assert.equal(s.level, 1); assert.equal(cellCount(s), 0); assert.equal(s.previewN, 3); assert.equal(s.glowFrames, 240);
  assert.equal(s.ctx.phase, PH_DELAY); assert.equal(s.ctx.pType, 0);
  s.step(0);
  assert.equal(s.ctx.phase, PH_PLAY); assert.equal(s.ctx.px, 4); assert.equal(s.ctx.py, 18);
  assert.equal(s.info().next.length, 3);
});

test('Daily start: ridge and day rule from the daily stream (seed 1: RIDGES[57], SHORT SIGHT), level 4', () => {
  const s = createSim({ seed: 1, mode: 'daily' });
  assert.equal(s.ctx.ridge, 57); assert.equal(s.info().dayRule, 'SHORT SIGHT');
  assert.deepEqual(heights(s), [...RIDGES[57]].map(Number));
  for (let i = 0; i < s.grid.length; i++) if (s.grid[i]) assert.equal(s.grid[i], 4, 'ridge cells are type 4');
  assert.equal(s.level, 4); assert.equal(s.previewN, 1); assert.equal(s.info().next.length, 1);
  const lean = createSim({ seed: 4, mode: 'daily' }), quick = createSim({ seed: 2, mode: 'daily' });
  assert.equal(lean.info().dayRule, 'LEAN'); assert.equal(lean.previewN, 3); assert.equal(lean.glowFrames, 240);
  assert.equal(quick.info().dayRule, 'QUICK GLOW'); assert.equal(quick.glowFrames, 150);
  // Daily levels: every 6 lines from 4
  assert.equal(createSim({ seed: 3, mode: 'daily' }).level, 4);
});

// ---------- spawn and pieces (B.2) ----------
test('spawn cells: BAR flat (3..5, 18); BAR upright pivot is the bottom cell; PLUS (4,18) (3..5,19) (4,20)', () => {
  const s = mk({ pieces: ['BAR', 'PLUS'] });
  s.step(0);
  let n = s.cells(); const cells = [];
  for (let i = 0; i < n; i++) cells.push([s.pieceCells[i * 2], s.pieceCells[i * 2 + 1]]);
  assert.deepEqual(cells, [[3, 18], [4, 18], [5, 18]]);
  s.step(64);
  n = s.cells(); const v = []; for (let i = 0; i < n; i++) v.push([s.pieceCells[i * 2], s.pieceCells[i * 2 + 1]]);
  assert.deepEqual(v, [[4, 18], [4, 19], [4, 20]]);
  s.step(32);
  toPlay(s);
  n = s.cells(); const p = []; for (let i = 0; i < n; i++) p.push([s.pieceCells[i * 2], s.pieceCells[i * 2 + 1]]);
  assert.deepEqual(p, [[4, 18], [3, 19], [4, 19], [5, 19], [4, 20]]);
});

// ---------- deck (B.3) ----------
function expectedDeal(seed, lean, n) {
  const r = new Rng(seed), out = [];
  while (out.length < n) {
    const d = (lean ? LEAN_DECK : DECK).slice();
    for (let i = d.length - 1; i >= 1; i--) { const j = r.int(i + 1); const t = d[i]; d[i] = d[j]; d[j] = t; }
    out.push(...d);
  }
  return out.slice(0, n);
}
function dealt(sim, n) {
  const out = []; let col = 0;
  while (out.length < n && !sim.done) {
    toPlay(sim); out.push(sim.ctx.pType);
    place(sim, sim.ctx.pType === PLUS ? 1 + (col++ % 7) : col++ % 9, ROT_V);
  }
  return out;
}
test('deck: Fisher-Yates of [BAR x3, PLUS x2] from new Rng(seed), dealt from index 0; LEAN deals [BAR x2, PLUS x2]', () => {
  assert.deepEqual(dealt(createSim({ seed: 1, mode: 'arcade' }), 15), expectedDeal(1, false, 15));
  assert.deepEqual(dealt(createSim({ seed: 9, mode: 'arcade' }), 15), expectedDeal(9, false, 15));
  const lean = createSim({ seed: 4, mode: 'daily' });
  assert.deepEqual(dealt(lean, 12), expectedDeal(4, true, 12));
  // test pieces first, then the normal deck from new Rng(seed)
  assert.deepEqual(dealt(mk({ pieces: ['PLUS', 'PLUS', 'BAR'] }, 5), 8), [PLUS, PLUS, BAR, ...expectedDeal(5, false, 5)]);
});

// ---------- timings (B.6) ----------
test('entry delay: lock on L with no clear gives the next piece on L + 9; with a clear on L + 29', () => {
  const s = mk({ pieces: ['BAR', 'BAR'] });
  s.step(32); // lock on frame 0
  for (let f = 1; f <= 8; f++) { s.step(0); assert.equal(s.ctx.pType, 0, 'entry frame ' + f); }
  s.step(0); assert.equal(s.ctx.spawned, 2, 'next piece on frame 9');
  const c = mk({ heights: [1, 1, 1, 1, 0, 1, 1, 1, 1], pieces: ['BAR', 'BAR'] });
  c.step(32); assert.equal(c.lines, 1, 'a clear on frame 0');
  for (let f = 1; f <= 28; f++) { c.step(0); assert.equal(c.ctx.pType, 0, 'clear or entry frame ' + f); }
  c.step(0); assert.equal(c.ctx.spawned, 2, 'next piece on frame 29');
});

test('C.2 press rule: a pressed bit counts only if it was clear in the previous word', () => {
  // tapping (press, release, press...) moves every 2 frames
  const a = mk({});
  for (let f = 0; f < 6; f++) a.step(f % 2 ? 0 : 9);
  assert.equal(a.ctx.px, 1, '3 taps on frames 0, 2, 4 (pivot 1 is against the wall)');
  // the pressed bit set on every frame counts once; then it is just a held LEFT (repeat after 11, then every 2)
  const b = mk({}), xs = [];
  for (let f = 0; f < 16; f++) { b.step(9); xs.push(b.ctx.px); }
  assert.deepEqual(xs, [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 1, 1, 1]);
  // a pressed bit with its held bit clear counts once, and never repeats
  const c = mk({});
  for (let f = 0; f < 30; f++) c.step(8);
  assert.equal(c.ctx.px, 3);
  // the same for turn: pressed every frame turns once
  const d = mk({});
  for (let f = 0; f < 6; f++) d.step(64);
  assert.equal(d.ctx.rot, ROT_V);
  // and hard drop: held across the entry delay, it never drops the next piece
  const e = mk({ pieces: ['BAR', 'BAR'] });
  for (let f = 0; f < 40; f++) e.step(32);
  assert.equal(e.ctx.spawned, 2); assert.ok(e.ctx.pType !== 0, 'the second piece is still falling');
  assert.ok(e.ctx.py > 10);
});

test('auto-repeat: first repeat 11 frames after the press, then every 2; last pressed wins; both pressed: no move', () => {
  const a = mk({}), xs = [];
  a.step(9); xs.push(a.ctx.px);
  for (let f = 1; f < 16; f++) { a.step(1); xs.push(a.ctx.px); }
  assert.deepEqual(xs, [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 1, 1, 1]);
  // hold LEFT, then press RIGHT while LEFT stays held: RIGHT wins
  const b = mk({});
  b.step(9); b.step(1); b.step(1 | 2 | 16);
  assert.equal(b.ctx.px, 4);
  for (let f = 0; f < 10; f++) b.step(3);
  assert.equal(b.ctx.px, 4);
  b.step(3);
  assert.equal(b.ctx.px, 5, 'RIGHT repeats 11 frames after its press');
  // both pressed on the same frame: neither moves, and no repeat while both stay held
  const c = mk({});
  c.step(1 | 2 | 8 | 16);
  for (let f = 0; f < 30; f++) c.step(3);
  assert.equal(c.ctx.px, 4);
  // then RIGHT is let go: LEFT (still held) charges from the start
  for (let f = 0; f < 11; f++) c.step(1);
  assert.equal(c.ctx.px, 4);
  c.step(1);
  assert.equal(c.ctx.px, 3, '11 frames after LEFT was left alone');
});

test('the repeat charge carries through the delay (a held direction moves on the spawn frame); presses in entry are not buffered', () => {
  const a = mk({ heights: [1, 1, 1, 1, 0, 1, 1, 1, 1], pieces: ['BAR', 'BAR'] });
  a.step(32); // clear on frame 0: next piece on frame 29
  a.step(9); // press on frame 1 (not a move, not buffered), then held through the clear and entry delays
  for (let f = 2; f < 29; f++) a.step(1);
  assert.equal(a.ctx.pType, 0);
  a.step(1); // frame 29: spawn, and the charged repeat moves at once
  assert.equal(a.ctx.px, 3);
  a.step(1); assert.equal(a.ctx.px, 3); a.step(1); assert.equal(a.ctx.px, 2);
  const b = mk({ pieces: ['BAR', 'BAR'] });
  b.step(32); b.step(0); b.step(0); b.step(9); // a LEFT tap on frame 3, in entry
  for (let f = 4; f <= 9; f++) b.step(0);
  assert.equal(b.ctx.spawned, 2); assert.equal(b.ctx.px, 4, 'the tap was not buffered');
});

test('a turn pressed in the entry delay is applied on the spawn frame; a hard drop pressed in a delay is ignored', () => {
  const a = mk({ pieces: ['BAR', 'BAR'] });
  a.step(32); a.step(0); a.step(0); a.step(64);
  for (let f = 4; f <= 9; f++) a.step(0);
  assert.equal(a.ctx.spawned, 2); assert.equal(a.ctx.rot, ROT_V);
  a.step(0); assert.equal(a.ctx.rot, ROT_V, 'turned once only');
  const b = mk({ pieces: ['BAR', 'BAR'] });
  b.step(32); b.step(0); b.step(32); // hard drop in entry
  for (let f = 3; f <= 12; f++) b.step(0);
  assert.equal(b.ctx.spawned, 2); assert.ok(b.ctx.py >= 17, 'not dropped');
  // design reading: a turn in the clear delay (before the entry frames) is not buffered
  const c = mk({ heights: [1, 1, 1, 1, 0, 1, 1, 1, 1], pieces: ['BAR', 'BAR'] });
  c.step(32); for (let f = 1; f < 5; f++) c.step(0); c.step(64);
  for (let f = 6; f <= 29; f++) c.step(0);
  assert.equal(c.ctx.spawned, 2); assert.equal(c.ctx.rot, ROT_H);
  const d = mk({ heights: [1, 1, 1, 1, 0, 1, 1, 1, 1], pieces: ['BAR', 'BAR'] });
  d.step(32); for (let f = 1; f < 22; f++) d.step(0); d.step(64); // frame 22 is an entry frame (21..28)
  for (let f = 23; f <= 29; f++) d.step(0);
  assert.equal(d.ctx.spawned, 2); assert.equal(d.ctx.rot, ROT_V);
});

test('turns: BAR about its bottom cell, V to H kicks +1 then -1 at the walls, blocked turn does nothing, PLUS never turns', () => {
  const a = mk({});
  a.step(64); assert.equal(a.ctx.rot, ROT_V); assert.equal(a.ctx.px, 4);
  for (let i = 0; i < 4; i++) { a.step(9); a.step(0); }
  assert.equal(a.ctx.px, 0);
  a.step(64); assert.equal(a.ctx.rot, ROT_H); assert.equal(a.ctx.px, 1, 'kicked +1 off the left wall');
  const b = mk({});
  b.step(64); for (let i = 0; i < 4; i++) { b.step(18); b.step(0); }
  assert.equal(b.ctx.px, 8);
  b.step(64); assert.equal(b.ctx.rot, ROT_H); assert.equal(b.ctx.px, 7, 'kicked -1 off the right wall');
  // blocked: upright BAR in a 1-wide well 3 deep. Since 3.0 (D119, instant lock) a piece never stays resting, so the
  // blocked turn is tried in the air inside the well (pivot row 1, the walls at rows 0 to 2 on both sides)
  const c = mk({ heights: [3, 3, 3, 0, 3, 3, 3, 3, 3] });
  c.step(64); c.step(9);
  while (c.ctx.py > 1) c.step(4);
  assert.ok(c.ctx.pType !== 0 && !c.resting(), 'in the air inside the well');
  const py = c.ctx.py; events(c, EV_TURN);
  c.step(64);
  assert.equal(c.ctx.rot, ROT_V); assert.equal(c.ctx.py, py);
  assert.deepEqual(events(c, EV_TURN).map(e => e[2]), [0], 'a blocked turn');
  // PLUS: no turn and no lock reset; in the air the lock count does not run (3.0: it counts only the resting frame)
  const d = mk({ pieces: ['PLUS'] });
  for (let i = 0; i < 5; i++) d.step(4);
  events(d, EV_TURN);
  d.step(64);
  assert.equal(d.ctx.rot, ROT_H); assert.equal(d.ctx.resets, 0); assert.equal(d.ctx.lockT, 0);
  assert.deepEqual(events(d, EV_TURN).map(e => e[2]), [2], 'PLUS: the no-turn event');
});

test('gravity: level 1 drops a row every 256 / 6 frames; soft drop at least 128; level 20 is the instant beam', () => {
  const a = mk({});
  for (let f = 0; f < 42; f++) a.step(0);
  assert.equal(a.ctx.py, 18);
  a.step(0); assert.equal(a.ctx.py, 17, 'first row after 43 frames of 6/256');
  const b = mk({});
  b.step(4); assert.equal(b.ctx.py, 18); b.step(4); assert.equal(b.ctx.py, 17); b.step(4); b.step(4); assert.equal(b.ctx.py, 16);
  const c = mk({ lines: 152 }); // level 20
  assert.equal(c.level, 20);
  events(c, EV_LOCK); c.step(0); assert.equal(c.ctx.py, 0); assert.equal(c.ctx.pType, 0, 'lands on its spawn frame and, with instant lock (3.0), locks on it');
  assert.deepEqual(events(c, EV_LOCK).map(e => e[1]), [0], 'the lock event is on frame 0, the spawn frame');
  const d = mk({ lines: 128 }); // level 17: one row a frame
  d.step(0); assert.equal(d.ctx.py, 17); d.step(0); assert.equal(d.ctx.py, 16);
  // soft drop never slows a fast level
  const e = mk({ lines: 136 }); // level 18: 384
  e.step(4); assert.equal(e.ctx.py, 17); e.step(4); assert.equal(e.ctx.py, 15);
});

// GAME_VERSION 3.0 (D119): instant lock. Steps wordAt(frame) until the piece locks and returns the lock event's frame.
// Every frame before it must end with the piece in the air and the lock count at 0: a live piece never ends a frame
// resting (it would have locked on that frame).
function lockFrame(sim, wordAt, max = 1000) {
  events(sim, EV_LOCK);
  for (let i = 0; i < max; i++) {
    const f = sim.frame; sim.step(wordAt(f));
    const l = events(sim, EV_LOCK); if (l.length) return l[0][1];
    assert.ok(sim.ctx.pType !== 0 && !sim.resting(), 'frame ' + f + ': a live piece never ends a frame resting');
    assert.equal(sim.ctx.lockT, 0, 'frame ' + f + ': no delay is counting in the air');
  }
  return -1;
}
// B.6 (3.0): from the spawn frame (frame 0 here) a piece falling 18 rows on an empty board touches down, and locks, on
// frame ceil(18 x 256 / G) - 1; soft drop makes G at least 128. Written out per level from the B.6 gravity table.
test('lock delay 0 at every level (D119, GAME_VERSION 3.0): the piece locks on the frame it touches down; the landing frame is the lock frame', () => {
  // [lines, level, lock frame with no input, lock frame with soft drop held]
  for (const [lines, level, quiet, soft] of [[0, 1, 767, 35], [120, 16, 22, 22], [128, 17, 17, 17], [144, 19, 7, 7], [152, 20, 0, 0], [400, 20, 0, 0]]) {
    const q = mk({ lines }); assert.equal(q.level, level);
    assert.equal(lockFrame(q, () => 0), quiet, 'lines ' + lines + ': no input');
    const s = mk({ lines });
    assert.equal(lockFrame(s, () => 4), soft, 'lines ' + lines + ': soft drop');
  }
});

test('no lock resets, instant lock (D111, D119): moves and turns in the air never start a delay; a move on the touchdown frame happens before the lock; a piece that rests on a ledge locks there', () => {
  // tap LEFT, RIGHT, LEFT ... every 2 frames from frame 2: the moves happen, lockT stays 0, it locks on the same frame as with no input
  const w = f => f >= 2 && f % 2 === 0 ? (f % 4 === 2 ? 9 : 18) : 0;
  const s = mk({});
  assert.equal(lockFrame(s, w), 767, 'locks on its touchdown frame, as with no input');
  const m = mk({});
  let moves = 0;
  for (let f = 0; f < 700; f++) { const px = m.ctx.px; m.step(w(f)); if (m.ctx.px !== px) moves++; assert.equal(m.ctx.lockT, 0, 'frame ' + f); assert.equal(m.ctx.resets, 0); }
  assert.ok(moves >= 300, 'the taps really moved the piece: ' + moves);
  // a ledge: column 8 is 2 high. A flat BAR at pivot 7 (cells 6 to 8) rests on it at row 2; pivot 6 (cells 5 to 7) is over the floor
  const ledge = () => mk({ heights: [0, 0, 0, 0, 0, 0, 0, 0, 2], pieces: ['BAR', 'BAR'] });
  const toLedge = f => f < 6 ? (f % 2 === 0 ? 18 : 0) : 4; // 3 RIGHT taps to pivot 7, then soft drop
  const p = ledge();
  const T = lockFrame(p, toLedge);
  assert.ok(T > 6, 'it reached the ledge');
  assert.deepEqual([p.ctx.px, p.ctx.py], [7, 2], 'no input on the touchdown frame: locked on the ledge, on that frame');
  // the same run with LEFT pressed on the touchdown frame: the move comes first, so the piece is over the floor and falls on
  const l = ledge();
  const L = lockFrame(l, f => f === T ? 9 | 4 : toLedge(f));
  assert.ok(L > T, 'the move on the touchdown frame took it off the ledge before the lock check: ' + L + ' > ' + T);
  assert.deepEqual([l.ctx.px, l.ctx.py], [6, 0], 'it fell to the floor at pivot 6 and locked on landing');
  assert.equal(l.ctx.resets, 0);
  // and once it has locked on the ledge, a LEFT on the next frame moves nothing (the piece is gone)
  const g = p.grid.slice(); p.step(9);
  assert.equal(p.ctx.pType, 0); assert.deepEqual(Array.from(p.grid), Array.from(g), 'the board did not change');
});

// ---------- MELT, clears, FIT (B.4, B.5, B.7) ----------
test('MELT: each cell drops to the top of its column, lowest first; FLAT and KEY only with no melt; BAR upright never fits', () => {
  const a = mk({ heights: [0, 0, 1, 0, 0, 0, 0, 0, 0] });
  for (let i = 0; i < 3; i++) { a.step(9); a.step(0); }
  events(a, EV_LOCK); a.step(32);
  const [lk] = events(a, EV_LOCK);
  assert.equal(lk[3], 0, 'no fit'); assert.equal(lk[4], 2, 'two cells melted');
  assert.deepEqual(heights(a), [1, 1, 2, 0, 0, 0, 0, 0, 0]);
  const b = mk({ pieces: ['PLUS'] }); b.step(32);
  const [pl] = events(b, EV_LOCK);
  assert.equal(pl[3], 0); assert.equal(pl[4], 2);
  assert.deepEqual(heights(b), [0, 0, 0, 1, 3, 1, 0, 0, 0]);
  assert.equal(b.score, 0);
  // PLUS into a 2-deep well: the centre cells melt lowest first and stack (5 cells kept)
  const c = mk({ heights: [0, 0, 0, 2, 0, 2, 0, 0, 0], pieces: ['PLUS'] }); c.step(32);
  assert.deepEqual(heights(c), [0, 0, 0, 3, 3, 3, 0, 0, 0]);
  assert.equal(cellCount(c), 4 + 5);
  // KEY: a 1-cell notch
  const d = mk({ heights: [0, 0, 0, 1, 0, 1, 0, 0, 0], pieces: ['PLUS'], lines: 8 }); d.step(32);
  const [ky] = events(d, EV_LOCK);
  assert.equal(ky[3], 2); assert.equal(d.score, 120 * 2);
  // FLAT
  const e = mk({ lines: 16 }); e.step(32);
  assert.equal(events(e, EV_LOCK)[0][3], 1); assert.equal(e.score, 40 * 3);
  // BAR upright: no fit
  const f = mk({}); f.step(64); f.step(0); f.step(32);
  assert.equal(events(f, EV_LOCK)[0][3], 0); assert.equal(f.score, 0);
});

test('line clears: 1, 2 and 3 rows score 100 / 260 / 640 x level x (4 + g) / 4; rows above drop as whole rows', () => {
  const one = mk({ heights: [1, 1, 1, 1, 0, 1, 1, 1, 1] }); one.step(32);
  assert.equal(one.lines, 1); assert.equal(one.score, 100 + 0); // the BAR melts (no FLAT): 25 x 1 x 4
  const two = mk({ heights: [2, 2, 2, 2, 0, 2, 2, 2, 2] }); two.step(64); two.step(0); two.step(32);
  assert.equal(two.lines, 2); assert.equal(two.score, 260);
  assert.deepEqual(heights(two), [0, 0, 0, 0, 1, 0, 0, 0, 0]);
  assert.equal(two.grid[4], 1, 'the BAR cell from row 2 dropped to row 0');
  const three = mk({ heights: [3, 3, 3, 3, 0, 3, 3, 3, 3], lines: 40 }); three.step(64); three.step(0); three.step(32);
  assert.equal(three.lines, 43); assert.equal(three.score, 640 * 6);
  assert.equal(cellCount(three), 0);
  const [cl] = events(three, EV_CLEAR);
  assert.deepEqual(cl.slice(2), [3, 7, 640 * 6, 0]);
  // GLOW: a second clear inside the timer steps g
  const g = mk({ heights: [2, 2, 2, 2, 0, 2, 2, 2, 2], pieces: ['BAR', 'BAR'] });
  g.step(32); // BAR flat on cols 3..5 melts into col 4: one row
  assert.equal(g.lines, 1); assert.equal(g.glow, 0); assert.equal(g.glowT, 240);
  toPlay(g); g.step(32); // the same again on [1,1,1,2,0,2,1,1,1]: one more row, inside the timer
  assert.equal(g.lines, 2); assert.equal(g.glow, 1);
});

test('levels: Free Play 1 + floor(lines / 8), a clear scores at the level before its lines; capped at 20', () => {
  const s = mk({ heights: [1, 1, 1, 1, 0, 1, 1, 1, 1], lines: 7 });
  s.step(32);
  assert.equal(s.lines, 8); assert.equal(s.level, 2); assert.equal(s.score, 100, 'scored at level 1');
  assert.equal(mk({ lines: 1000 }).level, 20);
});

test('ceiling rule: a lock leaving any cell in rows 18 to 20 ends the run (TOP OUT); row 17 does not', () => {
  const run = h => {
    const s = mk({ heights: [h, 0, 0, 0, 0, 0, 0, 0, 0] });
    s.step(64); s.step(0); for (let i = 0; i < 4; i++) { s.step(9); s.step(0); }
    s.step(32);
    return s;
  };
  const ok = run(15);
  assert.equal(columnHeight(ok.grid, 0), 18); assert.equal(ok.done, false);
  const out = run(16);
  assert.equal(out.done, true); assert.equal(out.reason, 'topout');
  const f = out.frame, h = out.stateHash();
  out.step(32); out.step(9);
  assert.equal(out.frame, f, 'no frames after the end'); assert.equal(out.stateHash(), h);
  // the ceiling is checked after the clears: a PLUS centre reaching row 18 comes back down when its arm fills row 0
  const c = mk({ heights: [1, 0, 16, 1, 1, 1, 1, 1, 1], pieces: ['PLUS'] });
  c.step(9); c.step(0); c.step(9); c.step(0);
  assert.equal(c.ctx.px, 2);
  c.step(32);
  assert.equal(c.done, false, 'the clear brought the stack back under row 18'); assert.equal(c.lines, 1);
  assert.equal(columnHeight(c.grid, 2), 18);
  // the spawn zone is empty whenever a piece spawns
  toPlay(c);
  for (let i = 18 * COLS; i < TOTAL_ROWS * COLS; i++) assert.equal(c.grid[i], 0);
});

test('run cap: the run ends LIGHTS OUT after frame 215,999 with its score kept', () => {
  const s = mk({ frame: RUN_CAP - 3, lines: 16 });
  s.step(32); assert.equal(s.score, 120);
  s.step(0); assert.equal(s.done, false);
  s.step(0); assert.equal(s.done, true); assert.equal(s.reason, 'lightsout'); assert.equal(s.frame, RUN_CAP);
  assert.equal(s.score, 120);
});

// ---------- C.2 reserved bits ----------
test('reserved bits 7 to 15: never change the game, are flagged, and are kept in the replay for the server to refuse', () => {
  const a = createSim({ seed: 3, mode: 'arcade' }), b = createSim({ seed: 3, mode: 'arcade' });
  const r = new Rng(77);
  for (let f = 0; f < 3000; f++) {
    const w = [0, 9, 18, 64, 32, 4, 1, 2][r.int(8)];
    a.step(w | (r.int(512) << 7)); b.step(w);
    assert.equal(a.stateHash(), b.stateHash(), 'frame ' + f);
  }
  assert.equal(a.badInput, true); assert.equal(b.badInput, false);
  assert.ok(decode(a.replay()).words.some(w => w & 0xff80));
  const c = mk({}); c.step(0x80); assert.equal(c.badInput, true); assert.equal(c.ctx.prev, 0);
});

// ---------- hash (C.1) ----------
test('stateHash covers every field of the state, the grid, deck, preview and every stream word', () => {
  const s = createSim({ seed: 5, mode: 'daily' });
  for (let f = 0; f < 400; f++) s.step(f % 37 === 0 ? 32 : f % 5 === 0 ? 9 : 0);
  const h0 = s.stateHash();
  for (const k of Object.keys(s.ctx)) {
    const v = s.ctx[k]; s.ctx[k] = v + 1;
    assert.notEqual(s.stateHash(), h0, 'ctx.' + k); s.ctx[k] = v;
  }
  for (let i = 0; i < s.grid.length; i++) { const v = s.grid[i]; s.grid[i] = v ^ 1; assert.notEqual(s.stateHash(), h0, 'grid ' + i); s.grid[i] = v; }
  for (let i = 0; i < s.ctx.deckLen; i++) { const v = s.deck[i]; s.deck[i] = 3 - v; assert.notEqual(s.stateHash(), h0, 'deck ' + i); s.deck[i] = v; }
  for (let i = 0; i < s.ctx.queueLen; i++) { const v = s.queue[i]; s.queue[i] = 3 - v; assert.notEqual(s.stateHash(), h0, 'queue ' + i); s.queue[i] = v; }
  for (const [name, r] of [['pieces', s.rng], ['daily', s.dailyRng]]) for (const k of ['a', 'b', 'c', 'd']) {
    const v = r[k]; r[k] = (v ^ 0x10000) | 0; assert.notEqual(s.stateHash(), h0, name + ' rng.' + k); r[k] = v;
  }
  assert.equal(s.stateHash(), h0);
  // test pieces not dealt yet are part of the state; dealt ones already sit in the queue
  const t = mk({ pieces: ['BAR', 'PLUS', 'BAR', 'PLUS', 'BAR'] }); const ht = t.stateHash();
  assert.equal(t.ctx.testPos, 4);
  t.testPieces[3] = PLUS; assert.equal(t.stateHash(), ht, 'piece 3 is already in the queue');
  t.testPieces[4] = PLUS; assert.notEqual(t.stateHash(), ht, 'piece 4 is still to come');
});

test('the sim never calls rng.save() or rng.restore() (C.1, review M3)', () => {
  const save = Rng.prototype.save, restore = Rng.prototype.restore; let n = 0;
  Rng.prototype.save = function () { n++; return save.call(this); };
  Rng.prototype.restore = function (x) { n++; return restore.call(this, x); };
  try {
    const s = createSim({ seed: 8, mode: 'daily' });
    for (let f = 0; f < 5000 && !s.done; f++) { s.step(f % 23 === 0 ? 32 : f % 3 === 0 ? 18 : 0); s.stateHash(); }
  } finally { Rng.prototype.save = save; Rng.prototype.restore = restore; }
  assert.equal(n, 0);
});

// ---------- determinism ----------
function scriptWords(n, seed) {
  const r = new Rng(seed), w = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const k = r.int(100);
    w[i] = k < 8 ? 9 : k < 16 ? 18 : k < 19 ? 64 : k < 20 ? 32 : k < 30 ? 4 : k < 35 ? 1 : k < 40 ? 2 : 0;
    if (i && (w[i] & 0x78) && w[i - 1] === w[i]) w[i] = 0;
  }
  return w;
}
function hashTrace(seed, mode, words) {
  const s = createSim({ seed, mode }), out = [];
  for (let i = 0; i < words.length && !s.done; i++) { s.step(words[i]); out.push(s.stateHash()); }
  return out;
}
test('determinism: the same seed and words give the same hash on every frame, twice and in a second Node process', () => {
  const words = scriptWords(20000, 99);
  for (const [seed, mode] of [[11, 'arcade'], [12, 'daily']]) {
    const a = hashTrace(seed, mode, words), b = hashTrace(seed, mode, words);
    assert.deepEqual(a, b);
    assert.ok(a.length > 1000, 'the run lasted ' + a.length + ' frames');
    const child = `
      const { createSim } = await import(process.argv[1]);
      const words = Uint16Array.from(JSON.parse(process.argv[2])); const s = createSim({ seed: +process.argv[3], mode: process.argv[4] }); const out = [];
      for (let i = 0; i < words.length && !s.done; i++) { s.step(words[i]); out.push(s.stateHash()); }
      console.log(JSON.stringify(out));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', child, SIM, JSON.stringify(Array.from(words.subarray(0, a.length))), String(seed), mode], { encoding: 'utf8', maxBuffer: 1 << 26 });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout.trim()), a);
  }
});

// ---------- no allocation (CLAUDE.md, C.1) ----------
const ALLOC_CHILD = `
import { PerformanceObserver } from 'node:perf_hooks';
const { createSim } = await import(process.argv[1]);
const { Rng } = await import(process.argv[2]);
const N = 40000, r = new Rng(4242), words = new Uint16Array(N);
for (let i = 0; i < N; i++) { const k = r.int(400); words[i] = k < 30 ? 9 : k < 60 ? 18 : k < 70 ? 64 : k < 72 ? 32 : k < 110 ? 4 : 0; if (i && (words[i] & 0x78) && words[i - 1] === words[i]) words[i] = 0; }
const noop = () => {};
function play(sim) { let i = 0, acc = 0; while (!sim.done && i < N) { sim.step(words[i++]); acc ^= sim.stateHash(); sim.drain(noop); } return i + (acc & 0); }
for (let k = 0; k < 6; k++) play(createSim({ seed: 900 + k, mode: k % 2 ? 'daily' : 'arcade' })); // warm up
// 60 sims (D113): on 2.0 (no lock resets) 40 of them topped out at 157,347 frames, under the 200,000 this test needs
// 100 sims (D119, w69): on 3.0 (instant lock) the 60 top out at 140,447 frames; 100 play 239,449
const sims = []; for (let k = 0; k < 100; k++) sims.push(createSim({ seed: 1 + k, mode: k % 2 ? 'daily' : 'arcade' }));
let scav = 0;
new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.detail.kind === 1) scav++; }).observe({ entryTypes: ['gc'] });
await new Promise(res => setTimeout(res, 50)); scav = 0;
let frames = 0; for (const s of sims) frames += play(s);
await new Promise(res => setTimeout(res, 100));
console.log(JSON.stringify({ scav, frames }));
`;
test('step() and stateHash() allocate nothing per frame (no minor GC over 200,000+ frames, 1 MB young space)', { timeout: 180000 }, () => {
  const r = spawnSync(process.execPath, ['--no-turbo-escape', '--max-semi-space-size=1', '--input-type=module', '-e', ALLOC_CHILD, SIM, path.join(ROOT, 'engine/rng.js')], { encoding: 'utf8', timeout: 170000 });
  assert.equal(r.status, 0, 'child failed: ' + r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.ok(out.frames > 200000, 'frames played: ' + out.frames);
  assert.ok(out.scav <= 1, 'minor GCs while playing: ' + out.scav + ' (zero allocation gives 0)');
});

// ---------- purity ----------
test('the sim imports and runs in Node with no browser globals and no impure APIs', () => {
  const script = `
    const trap = name => { throw new Error('sim touched ' + name); };
    for (const g of ['window', 'document', 'navigator', 'localStorage', 'performance', 'requestAnimationFrame', 'AudioContext', 'crypto'])
      Object.defineProperty(globalThis, g, { get: () => trap(g), configurable: true });
    Math.random = () => trap('Math.random'); Math.sin = () => trap('Math.sin'); Math.cos = () => trap('Math.cos');
    Math.atan2 = () => trap('Math.atan2'); Math.tan = () => trap('Math.tan'); Math.hypot = () => trap('Math.hypot');
    globalThis.Date = new Proxy(Date, { construct: () => trap('Date'), get: (t, k) => trap('Date.' + String(k)) });
    const { createSim } = await import(process.argv[1]);
    for (const [mode, test] of [['arcade'], ['daily'], ['test', { heights: [1, 1, 1, 1, 0, 1, 1, 1, 1], lines: 16 }]]) {
      const sim = createSim({ seed: 11, mode, test });
      for (let f = 0; f < 6000 && !sim.done; f++) { sim.step(f % 41 === 0 ? 32 : f % 6 === 0 ? 9 : f % 6 === 3 ? 18 : 4); sim.drain(() => {}); sim.stateHash(); }
      sim.info(); sim.replay();
    }
    console.log('pure-ok');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, SIM], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pure-ok/);
});

test('games/stacklight sources: no Math.random, wall clock, Math.sin or Math.cos, and no em dashes', () => {
  const files = [];
  const walk = d => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(path.join(ROOT, 'games/stacklight'));
  assert.ok(files.length >= 6);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /Math\.random|Date|Math\.sin|Math\.cos/, f);
    assert.ok(!src.includes('—'), f + ' has an em dash');
  }
});

// ---------- B.3 / B.9 survival proof re-run ----------
test('survival proof: 9 wide, spread 3, 3+2 deck is safe from the empty board, and all 64 RIDGES are safe for both decks', { timeout: 120000 }, () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/stacklight-proof.mjs'), '--ridges'], { encoding: 'utf8', timeout: 110000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /^W=9 K=3 deck=3bar\+2plus iterations=12 safe=1963604 emptyFreshSafe=true$/m);
  assert.match(r.stdout, /^W=9 K=3 deck=2bar\+2plus iterations=12 safe=1361557 emptyFreshSafe=true$/m);
  assert.match(r.stdout, /^ridges=64 all safe for 3\+2: true {2}for 2\+2: true$/m);
});

// ---------- info ----------
test('info() reports the run for hooks and render', () => {
  const s = createSim({ seed: 1, mode: 'arcade' });
  s.step(0);
  const i = s.info();
  assert.equal(i.game, 'stacklight'); assert.equal(i.mode, 'arcade'); assert.equal(i.frame, 1); assert.equal(i.level, 1);
  assert.equal(i.phase, 'play'); assert.deepEqual(i.piece && [i.piece.col, i.piece.row, i.piece.rot], [4, 18, 0]);
  assert.equal(i.heights.length, 9); assert.equal(i.done, false); assert.equal(i.dayRule, null);
  const sp = events(s, EV_SPAWN);
  assert.equal(sp.length, 1); assert.deepEqual(sp[0].slice(1, 5), [0, BAR === i.piece.type ? 1 : i.piece.type === 'BAR' ? 1 : 2, 4, 18]);
});
