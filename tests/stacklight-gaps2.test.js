// STACKLIGHT T1 test gaps, round 2, found missing by a second cold review.
// New file only; nothing here edits an existing test. Expected values come from the STACKLIGHT design document
// (B.6 lock delay with no resets since 2.0 and 0 since 3.0, B.6 hard drop in delay, B.7 GLOW), not from sim output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, PH_PLAY, EV_CLEAR, EV_LOCK } from '../games/stacklight/sim.js';
import { ROT_H, ROT_V } from '../games/stacklight/defs.js';

const mk = (t = {}, seed = 1) => createSim({ seed, mode: 'test', test: t });
function toPlay(sim) { while (sim.ctx.phase !== PH_PLAY && !sim.done) sim.step(0); }
function events(sim, type) { const out = []; sim.drain((b, o) => { if (b[o] === type) out.push(Array.from(b.subarray(o, o + 6))); }); return out; }
function place(sim, col) { // tap to the pivot column, then hard drop (BAR stays flat)
  toPlay(sim);
  const S = sim.ctx;
  let guard = 0;
  while (S.px !== col && guard++ < 20) { sim.step(S.px > col ? 9 : 18); sim.step(0); }
  sim.step(32);
}
const ROTATE = 64, HARD = 32, SOFT = 4;
// B.6 doc constants, written out here on purpose. Since GAME_VERSION 3.0 (D119) the lock delay is 0 (instant lock: a
// piece locks at the end of the frame it first rests, after that frame's turn and move) and, since 2.0 (D111), there are
// no lock resets. So a live piece never ends a frame resting, and no turn can add a frame.
const DELAY = 0, CAP = 0;
function runTo(t, words, upTo) { const s = mk(t); for (let f = 0; f < upTo; f++) s.step(words(f)); return s; }
function lockOf(sim, word, max = 2000) { // steps word(frame) until a lock; returns [frame, lock event]
  for (let i = 0; i < max; i++) { const f = sim.frame; sim.step(word(f)); const l = events(sim, EV_LOCK); if (l.length) return [l[0][1], l[0]]; }
  return [-1, null];
}

// ---------- turns never restart or add a lock delay ----------
test('MED-1 rotate every 2nd frame on a falling BAR: no reset ever, no frame ends resting, it locks on the frame it first rests', () => {
  const s = mk({ pieces: ['BAR', 'BAR'] });
  toPlay(s);
  const spawned = s.ctx.spawned, start = s.frame;
  let turns = 0, maxResets = 0, lockFrame = -1, prevRot = s.ctx.rot;
  events(s, EV_LOCK);
  for (let i = 0; i < 400 && lockFrame < 0; i++) {
    const f = s.frame;
    s.step((i % 2 === 0 ? ROTATE : 0) | SOFT);
    const l = events(s, EV_LOCK);
    if (l.length) { lockFrame = l[0][1]; assert.equal(lockFrame, f, 'the lock event is on this frame'); break; }
    if (s.ctx.rot !== prevRot) turns++;
    prevRot = s.ctx.rot;
    maxResets = Math.max(maxResets, s.ctx.resets);
    assert.ok(s.ctx.resets <= CAP, 'no reset is ever spent (frame ' + f + ')');
    assert.ok(!s.resting(), 'frame ' + f + ': the live piece is in the air (a resting frame would have locked)');
    assert.equal(s.ctx.lockT, DELAY, 'frame ' + f + ': no delay is counting');
  }
  assert.ok(lockFrame >= 0, 'the piece locked, it did not stall');
  assert.ok(turns >= 13, 'at least 13 successful turns on the way down: ' + turns);
  assert.equal(maxResets, CAP, 'resets stay at 0');
  assert.equal(s.ctx.pType, 0, 'locked'); assert.equal(s.ctx.spawned, spawned, 'the same piece');
  // the same piece with no turns: every shape's lowest cell is its pivot row, so it touches down on the same frame
  const c = mk({ pieces: ['BAR', 'BAR'] }); toPlay(c);
  const [cf] = lockOf(c, () => SOFT);
  assert.equal(lockFrame, cf, 'the turns did not add a frame: it locks on its touchdown frame, as with no turn');
  console.log('rotate every 2nd frame on a falling BAR: locks ' + (lockFrame - start) + ' frames after spawn, on its first resting frame, resets ' + maxResets);
});

test('MED-1 a successful turn on the touchdown frame does not delay the lock (six pieces, flat to upright)', () => {
  // six BARs, each soft dropped straight down at the spawn column; on each one's touchdown frame a turn is pressed
  const t = { pieces: ['BAR', 'BAR', 'BAR', 'BAR', 'BAR', 'BAR', 'BAR'] };
  const plan = []; // [touchdown frame of piece k without the turn]
  const words = (f) => (plan.includes(f) ? ROTATE : 0) | SOFT;
  for (let k = 0; k < 6; k++) {
    // control: the same words so far, and no turn on this piece's touchdown frame
    const c = runTo(t, words, plan.length ? plan[plan.length - 1] + 1 : 0);
    const [T] = lockOf(c, (f) => SOFT);
    assert.ok(T > 0, 'piece ' + k + ' locked');
    const s = runTo(t, words, T);
    const rot0 = s.ctx.rot;
    assert.ok(s.ctx.pType !== 0 && !s.resting() && s.ctx.lockT === 0, 'piece ' + k + ': in the air one frame before');
    events(s, EV_LOCK);
    s.step(ROTATE | SOFT); // a successful turn on the touchdown frame
    const l = events(s, EV_LOCK);
    assert.equal(l.length, 1, 'piece ' + k + ': locked on the touchdown frame'); assert.equal(l[0][1], T);
    assert.notEqual(s.ctx.rot, rot0, 'piece ' + k + ': the turn itself still happened');
    assert.equal(s.ctx.rot, ROT_V, 'piece ' + k + ': spawned flat, turned upright');
    assert.equal(l[0][3], 0, 'piece ' + k + ': no FLAT, so it locked upright (an upright BAR never fits)');
    assert.equal(s.ctx.resets, CAP, 'no reset spent');
    plan.push(T);
  }
});

// ---------- a failed turn does not reset (B.6: only a successful move or turn does) ----------
// V BAR falling into a 1-wide well (walls 6 high on both sides of column 4): every turn in it is blocked both ways
function wellWord(f) { return f === 0 ? ROTATE : SOFT; }
test('LOW-2 blocked turns on a V BAR in a 1-wide well, on the way down and on its touchdown frame: no reset spent, it locks on the same frame', () => {
  const t = { heights: [0, 0, 0, 6, 0, 6, 0, 0, 0], pieces: ['BAR'] };
  const c = mk(t);
  const [T, lc] = lockOf(c, wellWord);
  assert.equal(c.ctx.px, 4); assert.equal(c.ctx.rot, ROT_V); assert.equal(c.ctx.py, 0, 'control: locked upright on the well floor');
  // the same piece pressing ROTATE every 2nd frame once it is inside the well (pivot row 5 or lower), the last press on
  // the touchdown frame itself: every turn is blocked, nothing else changes
  const s = mk(t); let n = 0;
  const [L, ls] = lockOf(s, (f) => {
    if (f === 0) return ROTATE;
    if (s.ctx.pType && s.ctx.py <= 5 && f <= T && (T - f) % 2 === 0) { n++; return ROTATE | SOFT; }
    return SOFT;
  });
  assert.ok(n >= 3, 'several turns pressed in the well: ' + n);
  assert.equal(s.ctx.rot, ROT_V, 'every turn was blocked'); assert.equal(s.ctx.px, 4);
  assert.equal(s.ctx.resets, 0, 'no reset spent by a failed turn');
  assert.equal(L, T, 'locks on the same frame as with no presses');
  assert.equal(s.frame, c.frame);
  assert.equal(s.score, c.score); assert.equal(s.ctx.spawned, c.ctx.spawned);
  assert.deepEqual(ls.slice(2), lc.slice(2), 'the same lock');
});

// ---------- hard drop pressed on the last frame of each delay is ignored, not buffered (B.6) ----------
test('LOW-3 hard drop pressed on the LAST entry-delay frame (L + 8) is ignored: the next piece spawns alive, not dropped', () => {
  const s = mk({ heights: [0, 0, 0, 0, 0, 0, 1, 1, 1], pieces: ['BAR', 'BAR'] });
  toPlay(s); s.step(HARD); // lock with no clear
  assert.equal(s.ctx.phase, 0, 'in delay');
  const L = s.frame - 1, spawned = s.ctx.spawned;
  for (let i = 0; i < 7; i++) s.step(0); // L + 1 .. L + 7
  assert.equal(s.frame, L + 8);
  s.step(HARD); // frame L + 8, the last delay frame
  assert.equal(s.frame, L + 9);
  assert.equal(s.ctx.spawned, spawned, 'still no spawn on the press frame');
  s.step(0); // the spawn frame
  assert.equal(s.ctx.spawned, spawned + 1);
  assert.equal(s.ctx.phase, PH_PLAY);
  assert.equal(s.ctx.py, 18, 'spawn row: the piece was not hard dropped');
  assert.equal(s.ctx.lockT, 0);
  for (let i = 0; i < 3; i++) { s.step(0); assert.equal(s.ctx.spawned, spawned + 1); assert.ok(s.ctx.py > 0); }
});

test('LOW-3 hard drop pressed on the LAST clear-delay frame (L + 28) is ignored: the next piece spawns alive, not dropped', () => {
  const s = mk({ heights: [1, 1, 1, 1, 0, 1, 1, 1, 1], pieces: ['PLUS', 'BAR'] });
  toPlay(s); s.step(HARD);
  assert.equal(events(s, EV_CLEAR).length, 1, 'cleared');
  const L = s.frame - 1, spawned = s.ctx.spawned;
  for (let i = 0; i < 27; i++) s.step(0); // L + 1 .. L + 27
  assert.equal(s.frame, L + 28);
  s.step(HARD); // frame L + 28
  assert.equal(s.ctx.spawned, spawned);
  s.step(0);
  assert.equal(s.ctx.spawned, spawned + 1);
  assert.equal(s.ctx.phase, PH_PLAY);
  assert.equal(s.ctx.py, 18, 'spawn row: not dropped');
  for (let i = 0; i < 3; i++) { s.step(0); assert.equal(s.ctx.spawned, spawned + 1); assert.ok(s.ctx.py > 0); }
});

// ---------- GLOW g is kept at a non-clearing lock after the timer ran out (B.7) ----------
test('LOW-3 GLOW: g is untouched by non-clearing locks after the timer ran out; only a clear recomputes it', () => {
  const s = mk({ pieces: Array(16).fill('BAR') });
  const clearThree = () => { place(s, 1); place(s, 4); place(s, 7); };
  clearThree(); clearThree();
  assert.equal(s.glow, 1, 'second clear within 240 frames: g = 1');
  events(s, EV_CLEAR); // drain the two clears
  while (s.glowT > 0) s.step(0);
  assert.equal(s.glow, 1, 'timer out, g kept');
  // two non-clearing BAR locks (row 0 stays incomplete), reading g right after each
  place(s, 1); assert.equal(s.glowT, 0, 'timer is out');
  assert.equal(s.glow, 1, 'g kept right after the first non-clearing lock');
  assert.equal(events(s, EV_CLEAR).length, 0);
  place(s, 4);
  assert.equal(s.glow, 1, 'g kept right after the second non-clearing lock');
  assert.equal(events(s, EV_CLEAR).length, 0);
  place(s, 7); // completes the row: timer was 0, so this clear finds g = 0
  const ev = events(s, EV_CLEAR);
  assert.equal(ev.length, 1); assert.equal(ev[0][5], 0); assert.equal(s.glow, 0);
});
