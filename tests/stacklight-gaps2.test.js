// STACKLIGHT T1 test gaps, round 2, found missing by a second cold review.
// New file only; nothing here edits an existing test. Expected values come from the STACKLIGHT design document
// (B.6 lock delay with no resets since 2.0, B.6 hard drop in delay, B.7 GLOW), not from sim output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, PH_PLAY, EV_CLEAR } from '../games/stacklight/sim.js';
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
// B.6 doc constants, written out here on purpose: lock delay 32 (levels 1 to 16) and, since GAME_VERSION 2.0 (D111),
// no lock resets: a piece locks exactly 32 frames after it first rests, whatever it does while resting
const DELAY = 32, CAP = 0;

// ---------- turns while resting never restart the lock delay ----------
test('MED-1 rotate every 2nd frame on a resting BAR: no reset ever, it locks exactly 32 frames after it first rested', () => {
  const s = mk({ pieces: ['BAR', 'BAR'] });
  toPlay(s);
  while (s.ctx.lockT === 0) s.step(SOFT); // soft drop until it rests on the floor
  const rest = s.frame - 1; // the frame on which it first rested (lockT 1)
  assert.equal(s.ctx.lockT, 1, 'it really rested');
  assert.equal(s.ctx.resets, 0);
  const spawned = s.ctx.spawned;
  let restarts = 0, maxResets = 0, turns = 0, lockFrame = -1, prevLockT = s.ctx.lockT, prevRot = s.ctx.rot;
  for (let i = 0; i < 13 * DELAY + 10 && lockFrame < 0; i++) {
    const press = i % 2 === 0;
    const f = s.frame;
    s.step(press ? ROTATE : 0);
    if (s.ctx.spawned !== spawned || s.ctx.phase !== PH_PLAY) { lockFrame = f; break; }
    if (s.ctx.rot !== prevRot) turns++;
    prevRot = s.ctx.rot;
    if (s.ctx.lockT !== prevLockT + 1) restarts++;
    prevLockT = s.ctx.lockT;
    maxResets = Math.max(maxResets, s.ctx.resets);
    assert.ok(s.ctx.resets <= CAP, 'no reset is ever spent (frame ' + f + ')');
  }
  assert.ok(lockFrame >= 0, 'the piece locked, it did not stall');
  assert.ok(turns >= 13, 'at least 13 successful turns while resting: ' + turns);
  assert.equal(maxResets, CAP, 'resets stay at 0');
  assert.equal(restarts, 0, 'no turn restarted the delay: lockT went up by exactly 1 every frame');
  assert.equal(lockFrame - rest, DELAY - 1, 'locks on the 32nd frame of rest, counting the landing frame as the first');
  // log line for the card
  console.log('rotate every 2nd frame on a resting BAR: locks at frame ' + (lockFrame - rest) + ' (after resting), resets ' + maxResets);
});

test('MED-1 a successful turn on a resting piece does not restart the lock delay (lockT keeps counting)', () => {
  const s = mk({ pieces: ['BAR'] });
  toPlay(s);
  while (s.ctx.lockT === 0) s.step(SOFT);
  for (let k = 0; k < 6; k++) {
    const t0 = s.ctx.lockT, rot0 = s.ctx.rot;
    assert.ok(t0 > 0 && t0 < DELAY - 3, 'still resting with delay left: ' + t0);
    s.step(ROTATE); // a successful turn while resting
    assert.notEqual(s.ctx.rot, rot0, 'the turn itself still happened');
    assert.equal(s.ctx.resets, CAP, 'no reset spent');
    assert.equal(s.ctx.lockT, t0 + 1, 'no restart');
    s.step(0);
    assert.equal(s.ctx.lockT, t0 + 2);
  }
});

// ---------- a failed turn does not reset (B.6: only a successful move or turn does) ----------
function wellBar(extra = {}) { // V BAR resting at the bottom of a 1-wide well, rotate blocked both ways
  const s = mk({ heights: [0, 0, 0, 6, 0, 6, 0, 0, 0], pieces: ['BAR'], ...extra });
  toPlay(s);
  s.step(ROTATE); // to V at the spawn column 4, in the air
  assert.equal(s.ctx.rot, ROT_V); assert.equal(s.ctx.px, 4);
  let guard = 0;
  while (s.ctx.lockT === 0 && guard++ < 100) s.step(SOFT);
  assert.equal(s.ctx.px, 4); assert.equal(s.ctx.rot, ROT_V); assert.equal(s.ctx.lockT, 1, 'resting on the well floor');
  assert.equal(s.ctx.resets, 0);
  return s;
}
test('LOW-2 a blocked turn on a resting V BAR in a 1-wide well: no reset spent, lock delay keeps counting, piece locks on time', () => {
  const s = wellBar(), c = wellBar();
  for (let i = 0; i < 4; i++) { s.step(0); c.step(0); }
  const t0 = s.ctx.lockT;
  assert.equal(t0, 5);
  s.step(ROTATE); c.step(0);
  assert.equal(s.ctx.rot, ROT_V, 'the turn was blocked');
  assert.equal(s.ctx.px, 4);
  assert.equal(s.ctx.resets, 0, 'no reset spent by a failed turn');
  assert.equal(s.ctx.lockT, t0 + 1, 'lock delay not restarted');
  // keep pressing every 2nd frame; both pieces must lock on the same frame (the press changes nothing)
  let n = 0;
  while (s.ctx.phase === PH_PLAY && n++ < 100) {
    s.step(n % 2 ? 0 : ROTATE); c.step(0);
    if (s.ctx.phase === PH_PLAY) { assert.equal(s.ctx.resets, 0); assert.equal(s.ctx.lockT, c.ctx.lockT); }
  }
  assert.notEqual(s.ctx.phase, PH_PLAY, 'locked');
  assert.equal(s.frame, c.frame);
  assert.equal(s.score, c.score); assert.equal(s.ctx.spawned, c.ctx.spawned);
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
