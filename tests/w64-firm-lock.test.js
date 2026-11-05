// STACKLIGHT firm lock. GAME_VERSION 2.0 (D111, D117) had no lock resets and a 32 / 24 / 16 frame delay that never
// paused. GAME_VERSION 3.0 (D119) keeps no lock resets and makes the delay 0 at every level: instant lock.
// A piece locks at the end of the frame it first rests (the touchdown frame), after that frame's turn, move and gravity.
// So a live piece never ends a frame resting, and a move or turn on the touchdown frame happens before the lock.
// Rewritten for 3.0 (D119 approved this file): every 2.0 check here has a 3.0 check of the same kind (exact lock
// frames, lock count per frame, the per-level bound, the stall attacks). Expected numbers come from the STACKLIGHT
// design document, B.6 (the bound, written out below), never from the sim.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, PH_PLAY, PH_DELAY, EV_LOCK } from '../games/stacklight/sim.js';
import { GAME_VERSION, LOCK_RESETS, ROT_H, ROT_V, ENTRY_DELAY, GRAVITY, SUB_ROW, SPAWN_ROW, SPAWN_COL, lockDelayFor } from '../games/stacklight/defs.js';

const mk = (t = {}, seed = 1) => createSim({ seed, mode: 'test', test: t });
const LEFT_TAP = 9, RIGHT_TAP = 18, LEFT_HELD = 1, ROTATE = 64, HARD = 32, SOFT = 4;
// B.6 "No piece stalls forever" (3.0): a piece falls at most 18 rows (spawn row 18 to row 0, never up), it gains at
// least G / 256 of a row every frame it is in the air, and the sub-row counter is never thrown away before the lock
// (only a resting frame sets it to 0, and that frame is the lock frame). So from its spawn frame (frame 1) a piece
// lives at most ceil(18 x 256 / G) frames, and a piece that falls 18 rows with no stop lives exactly that long.
const ROWS_DOWN = 18;
const boundFor = (level) => Math.ceil(ROWS_DOWN * 256 / GRAVITY[level]);
const BOUND = 768; // level 1: ceil(4608 / 6)
// level -> lines that start the test board on that level (8 lines a level in Free Play), the bound from the doc
const LEVELS = [[1, 0, 768], [16, 120, 23], [17, 128, 18], [19, 144, 8], [20, 152, 1]];

function events(sim, type) { const out = []; sim.drain((b, o) => { if (b[o] === type) out.push(Array.from(b.subarray(o, o + 6))); }); return out; }
// steps word 0 until the next frame is a spawn frame; returns that frame's number (not stepped yet). Control and test
// sims replay the same words from the same frames, and lockFrame sees the spawn frame (at level 20 it is the lock frame).
function toSpawn(sim) {
  while (!sim.done && !(sim.ctx.phase === PH_DELAY && sim.ctx.delayT === 0)) sim.step(0);
  assert.ok(!sim.done); return sim.frame;
}
// steps word 0 through the next spawn frame; returns that spawn frame's number (already stepped)
function toPlay(sim) { const s0 = sim.ctx.spawned; while (!sim.done && sim.ctx.spawned === s0) sim.step(0); assert.ok(!sim.done); return sim.frame - 1; }
// step with wordAt(frame) until the piece locks; returns the lock frame. Every frame before it must end with the piece
// in the air, the lock count at 0 and no reset spent: under instant lock a live piece never ends a frame resting.
function lockFrame(sim, wordAt, max = 2000) {
  const spawned = sim.ctx.spawned + (sim.ctx.phase === PH_DELAY ? 1 : 0);
  events(sim, EV_LOCK);
  for (let i = 0; i < max; i++) {
    const f = sim.frame;
    sim.step(wordAt(f));
    const l = events(sim, EV_LOCK);
    if (l.length) return l[0][1];
    assert.equal(sim.ctx.spawned, spawned);
    assert.ok(!sim.resting(), `frame ${f}: a live piece ended the frame resting (it should have locked)`);
    assert.equal(sim.ctx.lockT, 0, `frame ${f}: lockT ${sim.ctx.lockT} in the air`);
    assert.equal(sim.ctx.resets, 0);
  }
  return -1;
}
function runTo(t, wordAt, upTo) { const s = mk(t); for (let f = 0; f < upTo; f++) s.step(wordAt(f)); return s; }

test('rule constants: version 3.0, no lock resets, lock delay 0 at every level', () => {
  assert.equal(GAME_VERSION, '3.0');
  assert.equal(LOCK_RESETS, 0);
  for (let level = 1; level <= 20; level++) assert.equal(lockDelayFor(level), 0, `level ${level}`);
});

test('tapping LEFT/RIGHT every frame, or every 2nd frame, while it falls: it locks on its touchdown frame (levels 1, 16, 17, 19, 20)', () => {
  for (const [level, lines, life] of LEVELS) {
    const quiet = mk({ lines }); assert.equal(quiet.level, level);
    const q0 = toSpawn(quiet);
    assert.equal(lockFrame(quiet, () => 0), q0 + life - 1, `level ${level}: no input, a full 18-row fall`);
    // every frame: LEFT press, RIGHT press, LEFT press ... (each word's press bit is new, so every one is a press)
    const a = mk({ lines }); const a0 = toSpawn(a);
    let moved = 0, last = a.ctx.px;
    const fa = lockFrame(a, f => { if (a.ctx.px !== last) { moved++; last = a.ctx.px; } return (f - a0) % 2 ? LEFT_TAP : RIGHT_TAP; });
    if (a.ctx.px !== last) moved++;
    assert.equal(fa, a0 + life - 1, `level ${level}: tap every frame`);
    assert.ok(moved >= life - 1, `level ${level}: the taps really moved it (${moved})`);
    // every 2nd frame
    const b = mk({ lines }); const b0 = toSpawn(b);
    assert.equal(lockFrame(b, f => ((f - b0) % 2 === 0 ? ((f - b0) % 4 === 0 ? LEFT_TAP : RIGHT_TAP) : 0)), b0 + life - 1, `level ${level}: tap every 2nd frame`);
  }
});

test('holding LEFT while it falls: it slides with auto-repeat, then locks on its touchdown frame', () => {
  for (const [level, lines, life] of LEVELS) {
    const s = mk({ lines }); const f0 = toSpawn(s);
    const x0 = SPAWN_COL; // the spawn column (the piece is not in play until the spawn frame)
    let first = true;
    const f = lockFrame(s, () => { const w = first ? LEFT_HELD | 8 : LEFT_HELD; first = false; return w; });
    assert.equal(f, f0 + life - 1, `level ${level}`);
    assert.ok(s.ctx.pType === 0, 'locked');
    assert.ok(s.ctx.px < x0, `level ${level}: it slid left (${x0} to ${s.ctx.px})`);
    if (level === 1) assert.equal(s.ctx.px, 1, 'level 1: all the way to the wall (a flat BAR pivot stops at 1)');
  }
});

test('turns on the way down (in place, wall kick) and blocked turns never add a frame; a turn on the touchdown frame happens before the lock (levels 1, 17, 20)', () => {
  for (const [level, lines, life] of [LEVELS[0], LEVELS[2], LEVELS[4]]) {
    // rotate every 2nd frame: every turn succeeds (the BAR turns about its pivot, its lowest cell)
    const r = mk({ lines, pieces: ['BAR', 'BAR'] }); const r0 = toSpawn(r);
    let turns = 0, rot = r.ctx.rot;
    const fr = lockFrame(r, f => { if (r.ctx.rot !== rot) { turns++; rot = r.ctx.rot; } return (f - r0) % 2 === 0 ? ROTATE : 0; });
    if (r.ctx.rot !== rot) turns++;
    assert.equal(fr, r0 + life - 1, `level ${level}: rotate every 2nd frame`);
    assert.ok(turns >= Math.ceil(life / 2) - 1, `level ${level}: ${turns} turns happened`);
    // a turn on the touchdown frame: an upright BAR walked to the left wall, V to H on its last frame kicks to pivot 1
    // (at level 20 the whole life is the spawn frame: the turn on it is that frame's turn)
    const walk = f => level === 20 ? 0 : f === 0 ? ROTATE : f <= 8 ? (f % 2 ? LEFT_TAP : 0) : 0;
    const c = mk({ lines, pieces: ['BAR', 'BAR'] });
    const T = lockFrame(c, walk);
    assert.equal(T, life - 1, `level ${level}: control lock frame`);
    if (level !== 20) assert.deepEqual([c.ctx.px, c.ctx.rot], [0, ROT_V], `level ${level}: control locked upright at the wall`);
    const k = runTo({ lines, pieces: ['BAR', 'BAR'] }, walk, T);
    events(k, EV_LOCK);
    k.step(ROTATE);
    const [lk] = events(k, EV_LOCK);
    assert.ok(lk, `level ${level}: locked on the touchdown frame`); assert.equal(lk[1], T);
    if (level === 20) assert.equal(k.ctx.rot, ROT_V, 'level 20: the spawn-frame turn happened, then the beam drop, then the lock');
    else { assert.equal(k.ctx.rot, ROT_H, `level ${level}: turned`); assert.equal(lk[5], 1, `level ${level}: kicked +1 off the wall, then locked`); }
    // blocked turns: an upright BAR falling into a 1-wide well (walls 6 high), ROTATE every 2nd frame in the well
    if (level === 20) continue; // no frame in the well: the spawn frame is the touchdown frame
    const well = { lines, heights: [0, 0, 0, 6, 0, 6, 0, 0, 0], pieces: ['BAR'] };
    const wc = mk(well); const W = lockFrame(wc, f => (f === 0 ? ROTATE : 0));
    const w = mk(well); let pressed = 0;
    const fw = lockFrame(w, f => { if (f === 0) return ROTATE; if (w.ctx.py <= 5 && (W - f) % 2 === 0) { pressed++; return ROTATE; } return 0; });
    assert.equal(fw, W, `level ${level}: blocked turns, the same lock frame`);
    assert.ok(pressed >= 1, `level ${level}: turns pressed in the well (${pressed})`);
    assert.equal(w.ctx.rot, ROT_V); assert.equal(w.ctx.pType, 0, 'locked');
  }
});

test('a move into a gap on the touchdown frame happens before the lock: the piece falls into the gap and locks when it lands there', () => {
  // an upright BAR at pivot 3 over a stack 2 high, with a gap (column 2, height 0) to its left
  const t = { heights: [2, 2, 0, 2, 2, 2, 2, 2, 2], pieces: ['BAR'] };
  const walk = f => f === 0 ? ROTATE : f === 2 ? LEFT_TAP : SOFT;
  const c = mk(t); const T = lockFrame(c, walk);
  assert.deepEqual([c.ctx.px, c.ctx.py], [3, 2], 'control: locked on the stack on its touchdown frame');
  const s = runTo(t, walk, T);
  events(s, EV_LOCK);
  s.step(LEFT_TAP | SOFT); // the touchdown frame: LEFT first, over the gap
  assert.equal(events(s, EV_LOCK).length, 0, 'not locked: the move came first and it is over the gap, in the air');
  assert.equal(s.ctx.px, 2); assert.equal(s.ctx.lockT, 0);
  const L = lockFrame(s, () => SOFT);
  assert.deepEqual([s.ctx.px, s.ctx.py], [2, 0], 'fell into the gap and locked on landing');
  assert.ok(L > T && L - T <= Math.ceil(2 * 256 / 128) + 1, `two more rows of soft drop: ${L - T}`);
});

test('sliding off a ledge on the touchdown frame falls on and locks on landing, inside the bound; one frame later it is already locked on the ledge', () => {
  // col 8 is 16 high: a flat BAR at pivot 7 (cells 6 to 8) touches down on it at row 16; pivot 6 (cells 5 to 7) is over the floor
  const t = { heights: [0, 0, 0, 0, 0, 0, 0, 0, 16], pieces: ['BAR', 'BAR'] };
  const walk = f => f < 6 ? (f % 2 === 0 ? RIGHT_TAP : 0) : 0;
  const c = mk(t); const start = toSpawn(c); const T = lockFrame(c, walk);
  assert.deepEqual([c.ctx.px, c.ctx.py], [7, 16], 'control: locked on the tall ledge on its touchdown frame');
  // LEFT on the touchdown frame: off the ledge before the lock check
  const s = runTo(t, walk, T);
  const L = lockFrame(s, f => (f === T ? LEFT_TAP : 0));
  assert.deepEqual([s.ctx.px, s.ctx.py], [6, 0], 'it fell all the way and locked at pivot 6 on the floor');
  // it never stopped, so it lived exactly a full 18-row fall from its spawn frame: the bound at level 1, no more
  assert.equal(L - start + 1, BOUND, `${L - start + 1} frames from spawn, bound ${BOUND}`);
  // LEFT one frame after the touchdown frame: the piece locked on the ledge already, the press moves nothing
  const late = runTo(t, walk, T + 1);
  assert.equal(late.ctx.pType, 0, 'locked on the ledge');
  const g = Array.from(late.grid); late.step(LEFT_TAP);
  assert.deepEqual(Array.from(late.grid), g, 'the board did not change');
});

// a stalling player: tap toward the lower side every 2nd frame, all the way down (it tries to keep finding a ledge to
// slide off). Records how many frames the piece rested and its lock count on the lock frame.
function stall(sim, dir) {
  const start = toPlay(sim), spawned = sim.ctx.spawned, x0 = sim.ctx.px;
  let rested = 0, frames = 0, lockT = 0, prev = 0;
  while (sim.ctx.spawned === spawned && sim.ctx.pType !== 0 && frames < 5000) {
    const w = (frames % 2 === 0 && !(prev & 24)) ? (dir < 0 ? LEFT_TAP : RIGHT_TAP) : 0;
    const lt = sim.ctx.lockT;
    sim.step(w); prev = w; frames++;
    if (sim.ctx.pType === 0) { rested++; lockT = lt + 1; break; }
    if (sim.resting()) rested++;
    assert.equal(sim.ctx.lockT, 0, 'no lock count in the air');
  }
  return { frames: sim.frame - start, rested, lockT, walked: Math.abs(sim.ctx.px - x0), locked: sim.ctx.pType === 0 || sim.ctx.spawned !== spawned };
}

test('chaining ledges cannot stall: a staircase walk locks on its first resting frame, inside the bound', () => {
  for (const [heights, dir] of [[[0, 1, 2, 3, 4, 5, 6, 7, 8], -1], [[8, 7, 6, 5, 4, 3, 2, 1, 0], 1], [[0, 2, 4, 6, 8, 10, 12, 14, 16], -1]]) {
    for (const piece of ['BAR', 'PLUS']) {
      const s = mk({ heights, pieces: [piece, piece] });
      const r = stall(s, dir);
      assert.ok(r.locked, `${piece} ${heights.join('')}: it locked`);
      assert.equal(r.rested, 1, `${piece} ${heights.join('')}: it rested for exactly one frame, the lock frame`);
      assert.equal(r.lockT, 1, `${piece} ${heights.join('')}: it locked with the first resting frame counted (delay 0)`);
      assert.ok(r.frames <= BOUND, `${piece} ${heights.join('')}: ${r.frames} frames from spawn to lock`);
      assert.ok(r.walked >= 2, `${piece} ${heights.join('')}: it walked down the staircase ${r.walked} columns`);
    }
  }
});

// The 2.0 review's hover attack: rest on a ledge, tap off it, wait in the air just short of a full row, tap back onto
// it, repeat. On 3.0 the piece locks on the touchdown frame, so the trick starts on that frame (tap off before the
// lock check), and the first time the piece is back on the ledge it locks.
function hover(level, lines) {
  const t = { heights: [0, 0, 0, 0, 0, 0, 0, 2, 2], pieces: ['BAR', 'BAR'], lines };
  const walk = f => f < 4 ? (f % 2 === 0 ? RIGHT_TAP : 0) : 0; // pivot 6: cells 5 to 7, the ledge under column 7
  const c = mk(t); assert.equal(c.level, level);
  const start = toSpawn(c), T = lockFrame(c, walk);
  assert.equal(c.ctx.py, 2, 'control: locked on the ledge');
  const s = runTo(t, walk, T), sp = s.ctx.spawned, G = GRAVITY[level];
  let cycles = 0, guard = 0;
  s.step(LEFT_TAP); // the touchdown frame: off the ledge first
  while (s.ctx.pType && s.ctx.spawned === sp && guard++ < 100000) {
    while (s.ctx.pType && s.ctx.sub + G < SUB_ROW && s.ctx.py === 2) s.step(0); // in the air, short of a row
    if (!s.ctx.pType || s.ctx.py !== 2) break;
    s.step(RIGHT_TAP); // back onto the ledge
    cycles++;
    if (s.ctx.pType) s.step(LEFT_TAP);
  }
  return { frames: s.frame - start, fromTouch: s.frame - T, cycles, locked: s.ctx.pType === 0 || s.ctx.spawned !== sp };
}

test('the hover trick (tap off a ledge and back on before a row of fall) locks the first time it is back, within the bound, at levels 1, 5, 10, 13, 16', () => {
  for (const [level, lines] of [[1, 0], [5, 32], [10, 72], [13, 96], [16, 120]]) {
    const r = hover(level, lines);
    assert.ok(r.locked, `level ${level}: locked`);
    assert.equal(r.cycles, 1, `level ${level}: the trick ran once and the piece locked on coming back (${r.cycles} cycles)`);
    assert.ok(r.frames <= boundFor(level), `level ${level}: ${r.frames} frames from spawn to lock, bound ${boundFor(level)}`);
    const row = Math.ceil(SUB_ROW / GRAVITY[level]);
    assert.ok(r.fromTouch <= row + 1, `level ${level}: ${r.fromTouch} frames from the first touchdown to the lock, at most ${row} + 1`);
  }
});

test('the bound itself: a do-nothing piece at level 1 locks on its 768th frame, which is the bound', () => {
  // the in-air part: from the spawn frame, a row at G 6 takes 43 frames (42 x 6 = 252 < 256); 18 rows take 768 frames
  let sub = 0, f = 0; for (let row = 0; row < 1; f++) { sub += 6; if (sub >= 256) { row++; sub -= 256; } }
  assert.equal(f, 43);
  assert.equal(SPAWN_ROW, ROWS_DOWN, 'the pivot spawns on row 18, and every shape\'s lowest cell is its pivot row');
  assert.equal(Math.ceil(18 * 256 / 6), BOUND);
  assert.equal(boundFor(1), BOUND);
  const s = mk({ pieces: ['BAR'] });
  toSpawn(s);
  let n = 0; // frames stepped from the spawn frame through the lock frame
  do { s.step(0); n++; } while (s.ctx.pType !== 0 && n < 2000);
  assert.equal(n, BOUND, `${n} frames`);
  // the per-level bounds the doc states (B.6)
  assert.deepEqual([1, 5, 10, 13, 16, 17, 20].map(boundFor), [768, 288, 91, 46, 23, 18, 1]);
});

test('hard drop and soft drop: a hard drop locks on its press frame, a held soft drop on its touchdown frame; entry delay unchanged', () => {
  // hard drop locks on the press frame; the next piece's first frame is L + 9 (B.6)
  const h = mk({ pieces: ['BAR', 'BAR'] });
  toPlay(h);
  const pf = h.frame; h.step(HARD);
  const [lk] = events(h, EV_LOCK); assert.equal(lk[1], pf, 'locked on the press frame');
  const spawned = h.ctx.spawned;
  while (h.ctx.spawned === spawned) h.step(0);
  assert.equal(h.frame - 1, pf + ENTRY_DELAY + 1, 'next piece on L + 9');
  // hard drop after some moves in the air: locks on that frame
  const m = mk({ pieces: ['BAR', 'BAR'] }); toPlay(m);
  m.step(LEFT_TAP); m.step(0); m.step(RIGHT_TAP);
  const hf = m.frame; m.step(HARD);
  const [lm] = events(m, EV_LOCK); assert.equal(lm[1], hf);
  // soft drop held all the way: G is at least 128, so 18 rows take 36 frames and it locks on the 36th (touchdown)
  const s = mk({ pieces: ['BAR', 'BAR'] }); const s0 = toSpawn(s);
  assert.equal(lockFrame(s, () => SOFT), s0 + Math.ceil(18 * 256 / 128) - 1);
});

test('resets stay 0 and the lock count never shows at a frame end, for every piece of a whole run with constant wiggling', () => {
  let pieces = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const s = createSim({ seed, mode: 'arcade' });
    let i = 0;
    while (!s.done && i < 20000) {
      const k = (i + seed) % 7;
      s.step(k === 0 ? LEFT_TAP : k === 2 ? RIGHT_TAP : k === 4 ? ROTATE : k === 5 ? SOFT : 0);
      assert.equal(s.ctx.resets, 0, 'seed ' + seed + ' frame ' + i);
      assert.equal(s.ctx.lockT, 0, 'seed ' + seed + ' frame ' + i + ': instant lock, no frame ends with a lock count');
      if (s.ctx.pType) assert.ok(!s.resting(), 'seed ' + seed + ' frame ' + i + ': a live piece is never resting at a frame end');
      i++;
    }
    pieces += s.ctx.spawned;
  }
  assert.ok(pieces > 50, 'many pieces played: ' + pieces);
  assert.equal(ROT_H, 0);
});
