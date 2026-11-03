// GAME_VERSION 2.0: STACKLIGHT firm lock. No lock resets: a piece locks exactly lockDelayFor(level) frames
// after it first rests (32 at levels 1 to 16, 24 at 17 to 19, 16 at 20). Moves and turns while resting still happen but
// never restart the delay. The delay never pauses either. From the first frame the piece rests it counts
// every frame, in the air too, and the piece locks on its first resting frame with the delay run out.
// Expected numbers come from the STACKLIGHT design document, B.6 (delays, the per-level bound), written out here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim, PH_PLAY, EV_LOCK } from '../games/stacklight/sim.js';
import { GAME_VERSION, LOCK_RESETS, ROT_H, ROT_V, ENTRY_DELAY, GRAVITY, SUB_ROW, SPAWN_ROW, lockDelayFor } from '../games/stacklight/defs.js';

const mk = (t = {}, seed = 1) => createSim({ seed, mode: 'test', test: t });
const LEFT_TAP = 9, RIGHT_TAP = 18, LEFT_HELD = 1, ROTATE = 64, HARD = 32, SOFT = 4;
// B.6, from the doc: level -> lines that start the test board on that level (8 lines a level in Free Play), delay
const LEVELS = [[1, 0, 32], [16, 120, 32], [17, 128, 24], [19, 144, 24], [20, 152, 16]];
// B.6 "No piece stalls forever" (the exact bound): a piece falls at most 18 rows (spawn row 18 to row 0, never
// up), and a resting frame sets the sub-row counter to 0, which can throw away up to one partial row before the first
// rest. Fall to the first rest: at most ceil((r1 + 1) x 256 / G) frames; then at most delay - 2 frames to the last resting
// frame; then the remaining r3 <= 18 - r1 rows: at most ceil(r3 x 256 / G). Locking while resting: ceil(18 x 256 / G) + delay - 1.
// The longest of these is the bound (tests/w64c-lock-bound.test.js shows it is reached).
const ROWS_DOWN = 18;
const boundFor = (level) => {
  const G = GRAVITY[level], delay = lockDelayFor(level), c = (r) => Math.ceil(r * 256 / G);
  let air = 0; for (let r1 = 0; r1 <= 17; r1++) air = Math.max(air, c(r1 + 1) + c(ROWS_DOWN - r1) + delay - 2);
  return Math.max(air, c(ROWS_DOWN) + delay - 1);
};
const BOUND = 842; // level 1: ceil(512 / 6) + ceil(4352 / 6) + 30 = 86 + 726 + 30

function events(sim, type) { const out = []; sim.drain((b, o) => { if (b[o] === type) out.push(Array.from(b.subarray(o, o + 6))); }); return out; }
// soft drop until the piece rests; returns the frame on which it first rested (lockT 1)
function landing(sim) { let g = 0; while (sim.ctx.lockT === 0 && g++ < 2000) sim.step(SOFT); assert.equal(sim.ctx.lockT, 1); return sim.frame - 1; }
// step with wordAt(frame) until the piece locks; returns the lock frame, checking lockT climbs by exactly 1 a frame
function lockFrame(sim, wordAt, max = 400) {
  const spawned = sim.ctx.spawned;
  for (let i = 0; i < max; i++) {
    const f = sim.frame, lt = sim.ctx.lockT;
    sim.step(wordAt(f));
    const l = events(sim, EV_LOCK);
    if (l.length) return l[0][1];
    assert.equal(sim.ctx.spawned, spawned);
    assert.equal(sim.ctx.lockT, lt + 1, `frame ${f}: lockT went ${lt} -> ${sim.ctx.lockT} (a restart)`);
    assert.equal(sim.ctx.resets, 0);
  }
  return -1;
}

test('rule constants: version 2.0 and no lock resets', () => {
  assert.equal(GAME_VERSION, '2.0');
  assert.equal(LOCK_RESETS, 0);
});

test('tapping LEFT/RIGHT on a resting piece every frame, or every 2nd frame, locks it on exactly the delay frame (levels 1, 16, 17, 19, 20)', () => {
  for (const [level, lines, delay] of LEVELS) {
    const quiet = mk({ lines }); assert.equal(quiet.level, level);
    const q0 = landing(quiet);
    assert.equal(lockFrame(quiet, () => 0), q0 + delay - 1, `level ${level}: no input`);
    // every frame: LEFT press, RIGHT press, LEFT press ... (each word's press bit is new, so every one is a press)
    const a = mk({ lines }); const a0 = landing(a);
    let moved = 0; const px = () => a.ctx.px;
    let last = px();
    const fa = lockFrame(a, f => { if (px() !== last) { moved++; last = px(); } return (f - a0) % 2 ? LEFT_TAP : RIGHT_TAP; });
    assert.equal(fa, a0 + delay - 1, `level ${level}: tap every frame`);
    assert.ok(moved >= delay - 3, `level ${level}: the taps really moved it (${moved})`);
    // every 2nd frame
    const b = mk({ lines }); const b0 = landing(b);
    assert.equal(lockFrame(b, f => ((f - b0) % 2 === 0 ? ((f - b0) % 4 === 0 ? LEFT_TAP : RIGHT_TAP) : 0)), b0 + delay - 1, `level ${level}: tap every 2nd frame`);
  }
});

test('holding LEFT on a resting piece: it slides with auto-repeat, then locks on the delay frame', () => {
  for (const [level, lines, delay] of LEVELS) {
    const s = mk({ lines }); const f0 = landing(s);
    const x0 = s.ctx.px;
    let first = true;
    const f = lockFrame(s, () => { const w = first ? LEFT_HELD | 8 : LEFT_HELD; first = false; return w; });
    assert.equal(f, f0 + delay - 1, `level ${level}`);
    assert.ok(s.ctx.pType === 0, 'locked');
    assert.ok(x0 >= 1, 'it started off the wall');
  }
});

test('turns while resting (in place, wall kick) and blocked moves or turns never restart the delay (levels 1, 17, 20)', () => {
  for (const [level, lines, delay] of [LEVELS[0], LEVELS[2], LEVELS[4]]) {
    // rotate every 2nd frame on the floor: every turn succeeds (the BAR turns about its pivot)
    const r = mk({ lines, pieces: ['BAR', 'BAR'] }); const r0 = landing(r);
    let turns = 0, rot = r.ctx.rot;
    const fr = lockFrame(r, f => { if (r.ctx.rot !== rot) { turns++; rot = r.ctx.rot; } return (f - r0) % 2 === 0 ? ROTATE : 0; });
    assert.equal(fr, r0 + delay - 1, `level ${level}: rotate every 2nd frame`);
    assert.ok(turns >= delay / 2 - 2, `level ${level}: ${turns} turns happened`);
    // against the left wall: LEFT taps are blocked, a V to H turn kicks (+1), then more blocked taps
    const k = mk({ lines, pieces: ['BAR', 'BAR'] });
    while (k.ctx.phase !== PH_PLAY) k.step(0);
    k.step(ROTATE); assert.equal(k.ctx.rot, ROT_V);
    for (let i = 0; i < 6 && k.ctx.px > 0; i++) { k.step(LEFT_TAP); k.step(0); }
    if (k.ctx.lockT === 0) landing(k);
    const k0 = k.frame - k.ctx.lockT;
    assert.equal(k.ctx.px, 0, `level ${level}: at the wall`);
    let kicked = false;
    const fk = lockFrame(k, f => {
      if (!kicked && k.ctx.rot === ROT_V && f - k0 >= 3) { kicked = true; return ROTATE; } // V to H at column 0: kicks to pivot 1
      return (f - k0) % 2 === 0 ? LEFT_TAP : 0;
    });
    assert.ok(kicked, 'the kick turn was sent');
    assert.equal(fk, k0 + delay - 1, `level ${level}: kick and blocked taps`);
    // a blocked turn: upright BAR in a 1-wide well
    const w = mk({ lines, heights: [0, 0, 0, 6, 0, 6, 0, 0, 0], pieces: ['BAR'] });
    while (w.ctx.phase !== PH_PLAY) w.step(0);
    w.step(ROTATE); assert.equal(w.ctx.rot, ROT_V);
    if (w.ctx.lockT === 0) landing(w);
    const w0 = w.frame - w.ctx.lockT;
    assert.equal(lockFrame(w, f => ((f - w0) % 2 === 0 ? ROTATE : 0)), w0 + delay - 1, `level ${level}: blocked turns`);
    assert.equal(w.ctx.pType, 0, 'locked');
  }
});

test('a successful move into a gap while resting still happens, the piece falls into it, and the delay keeps counting in the air (D117)', () => {
  const s = mk({ heights: [2, 2, 0, 2, 2, 2, 2, 2, 2], pieces: ['BAR'] });
  while (s.ctx.phase !== PH_PLAY) s.step(0);
  s.step(ROTATE); // upright, pivot 4
  const f0 = landing(s);
  assert.equal(s.ctx.py, 2);
  for (let i = 0; i < 4; i++) { s.step(0); }
  const lt = s.ctx.lockT;
  s.step(LEFT_TAP); s.step(0); assert.equal(s.ctx.px, 3); assert.equal(s.ctx.lockT, lt + 2, 'still on the stack');
  s.step(LEFT_TAP); assert.equal(s.ctx.px, 2, 'moved over the gap');
  assert.equal(s.ctx.lockT, lt + 3, 'not resting, and the delay still counts');
  let air = 1;
  while (s.ctx.py > 0) { const l0 = s.ctx.lockT; s.step(SOFT); air++; assert.equal(s.ctx.lockT, l0 + 1, 'one a frame, resting or not'); }
  assert.equal(s.ctx.py, 0, 'fell into the gap');
  assert.equal(s.ctx.lockT, lt + 2 + air, 'landed: no frame since the first rest was skipped');
  assert.ok(s.ctx.pType !== 0 && s.ctx.lockT < 32, 'time left on landing');
  const spawned = s.ctx.spawned; let lockAt = -1;
  while (s.ctx.pType !== 0 && s.ctx.spawned === spawned) { const f = s.frame; s.step(0); if (s.ctx.pType === 0) lockAt = f; }
  assert.equal(lockAt, f0 + 31, 'locks 32 frames after it first rested, the fall included');
});

test('sliding off a ledge into a deep hole when the delay runs out (or after it ran out in the air) locks on the landing frame', () => {
  // col 8 is 16 high: a flat BAR at pivot 7 (cells 6 to 8) rests on it at row 16; pivot 6 (cells 5 to 7) is over the floor
  for (const tapAt of [32, 20]) {
    const s = mk({ heights: [0, 0, 0, 0, 0, 0, 0, 0, 16], pieces: ['BAR', 'BAR'] });
    while (s.ctx.phase !== PH_PLAY) s.step(0);
    const start = s.frame - 1; // the spawn frame (stepped above)
    for (let i = 0; i < 3; i++) { s.step(RIGHT_TAP); s.step(0); }
    while (s.ctx.lockT === 0) s.step(0);
    assert.equal(s.ctx.px, 7); assert.equal(s.ctx.py, 16, 'resting on the tall ledge');
    const f0 = s.frame - 1;
    while (s.ctx.lockT < tapAt - 1) s.step(0);
    s.step(LEFT_TAP); // the move happens before the lock check, so on the frame the delay runs out the piece is already off
    assert.equal(s.ctx.px, 6); assert.equal(s.ctx.lockT, tapAt); assert.ok(s.ctx.pType !== 0, 'off the ledge, not locked');
    events(s, EV_LOCK); // empty the event buffer
    const spawned = s.ctx.spawned; let lockAt = -1, lockT = -1, lockRow = -1, sawRun = false;
    for (let i = 0; i < 2000 && lockAt < 0; i++) {
      const f = s.frame, py = s.ctx.py;
      s.step(0);
      if (s.ctx.pType === 0 || s.ctx.spawned !== spawned) { lockAt = f; lockRow = py; break; }
      if (s.ctx.lockT >= 32) sawRun = true;
      lockT = s.ctx.lockT;
      assert.ok(s.ctx.py <= 16 && s.ctx.px === 6, 'over the hole, in the air');
    }
    assert.ok(sawRun, `tap at ${tapAt}: the delay ran out while the piece was in the air`);
    const [lk] = events(s, EV_LOCK);
    assert.equal(lk[1], lockAt, 'the lock event is on that frame');
    assert.ok(lockRow <= 1, `tap at ${tapAt}: it fell all the way (row ${lockRow} before the landing step)`);
    assert.equal(lk[5], 6, 'locked at pivot 6, over the floor');
    assert.ok(lockT >= 32, 'it reached the floor with the delay already run out');
    // in the air it falls one row per ceil(256 / 6) frames at most, starting from the last rest (sub-row counter 0)
    const lastRest = f0 + tapAt - 2; // the frame before the tap was the last resting frame
    assert.equal(lockAt, lastRest + Math.ceil(16 * 256 / 6), `tap at ${tapAt}: lands (and locks) 16 rows of fall after its last rest`);
    assert.ok(lockAt - start + 1 <= BOUND, `tap at ${tapAt}: ${lockAt - start + 1} frames from spawn, bound ${BOUND}`);
  }
});

// a stalling player: whenever the piece rests, step it toward the lower side (off the ledge); otherwise wait.
// Records every frame's lockT and whether the piece rested on it, so the no-pause rule can be checked frame by frame.
function stall(sim, dir) {
  while (sim.ctx.phase !== PH_PLAY) sim.step(0);
  const spawned = sim.ctx.spawned, start = sim.frame - 1, delay = lockDelayFor(sim.level); // start: the spawn frame (stepped above)
  let rested = 0, prev = 0, frames = 0, falls = 0, lockT = 0;
  while (sim.ctx.spawned === spawned && sim.ctx.pType !== 0 && frames < 5000) {
    const lt = sim.ctx.lockT, py = sim.ctx.py;
    const w = lt > 0 && !(prev & 24) ? (dir < 0 ? LEFT_TAP : RIGHT_TAP) : 0;
    sim.step(w); prev = w; frames++;
    if (sim.ctx.pType === 0) { rested++; lockT = lt + 1; break; }
    const resting = sim.resting();
    if (resting) rested++;
    if (lt > 0) assert.equal(sim.ctx.lockT, lt + 1, 'after the first rest the delay counts every frame, in the air too (D117)');
    if (resting) assert.ok(sim.ctx.lockT < delay, 'no resting frame with the delay run out goes by without a lock');
    if (lt > 0 && sim.ctx.py < py) falls++; // it had rested, and now it dropped a row: slid off a ledge
  }
  return { frames: sim.frame - start, rested, lockT, falls, locked: sim.ctx.pType === 0 || sim.ctx.spawned !== spawned };
}

test('chaining ledges cannot stall: a staircase walk locks on its first resting frame with the delay run out, inside the bound', () => {
  // a staircase down to the left: every step is a ledge to slide off and fall from
  for (const [heights, dir] of [[[0, 1, 2, 3, 4, 5, 6, 7, 8], -1], [[8, 7, 6, 5, 4, 3, 2, 1, 0], 1], [[0, 2, 4, 6, 8, 10, 12, 14, 16], -1]]) {
    for (const piece of ['BAR', 'PLUS']) {
      const s = mk({ heights, pieces: [piece, piece] });
      const r = stall(s, dir);
      assert.ok(r.locked, `${piece} ${heights.join('')}: it locked`);
      assert.ok(r.rested <= 32, `${piece} ${heights.join('')}: rested ${r.rested} frames in all (at most one delay)`);
      assert.ok(r.lockT >= 32, `${piece} ${heights.join('')}: it locked only once the delay had run out (${r.lockT})`);
      assert.ok(r.frames <= BOUND, `${piece} ${heights.join('')}: ${r.frames} frames from spawn to lock`);
      assert.ok(r.falls >= 2, `${piece} ${heights.join('')}: it slid off a ledge ${r.falls} times`);
    }
  }
});

// The hover attack: rest on a ledge, tap off it, wait in the air just short of
// a full row, tap back onto it, repeat. With the 2.0 pause this lasted 2,015 frames at level 1. It must lock within
// the bound at every level, and within one delay of the first rest plus at most one row of air.
function hover(level, lines) {
  const s = mk({ heights: [0, 0, 0, 0, 0, 0, 0, 2, 2], pieces: ['BAR', 'BAR'], lines });
  assert.equal(s.level, level);
  while (s.ctx.phase !== PH_PLAY) s.step(0);
  const start = s.frame - 1, sp = s.ctx.spawned, G = GRAVITY[level]; // start: the spawn frame (stepped above)
  s.step(RIGHT_TAP); s.step(0); s.step(RIGHT_TAP); s.step(0); // pivot 6: cells 5 to 7, the ledge under column 7
  while (s.ctx.lockT === 0 && s.ctx.pType) s.step(0);
  const firstRest = s.frame - 1;
  let cycles = 0, guard = 0;
  while (s.ctx.pType && s.ctx.spawned === sp && guard++ < 100000) {
    s.step(LEFT_TAP); // off the ledge
    while (s.ctx.pType && s.ctx.sub + G < SUB_ROW && s.ctx.py === 2) s.step(0); // in the air, short of a row
    if (!s.ctx.pType || s.ctx.py !== 2) break;
    s.step(RIGHT_TAP); // back onto the ledge
    cycles++;
  }
  return { frames: s.frame - start, fromRest: s.frame - firstRest, cycles, locked: s.ctx.pType === 0 };
}

test('the review\'s hover trick (tap off a ledge and back on before a row of fall) locks within the bound at levels 1, 5, 10, 13, 16', () => {
  for (const [level, lines] of [[1, 0], [5, 32], [10, 72], [13, 96], [16, 120]]) {
    const r = hover(level, lines);
    assert.ok(r.locked, `level ${level}: locked`);
    assert.ok(r.cycles >= 1, `level ${level}: the trick ran (${r.cycles} cycles)`);
    assert.ok(r.frames <= boundFor(level), `level ${level}: ${r.frames} frames from spawn to lock, bound ${boundFor(level)}`);
    const row = Math.ceil(SUB_ROW / GRAVITY[level]);
    assert.ok(r.fromRest <= 32 + row, `level ${level}: ${r.fromRest} frames from first rest to lock, at most 32 + ${row}`);
  }
});

test('the bound itself: the slowest possible piece at level 1 locks within 842 frames, and a plain do-nothing piece takes 799', () => {
  // the in-air part: from rest, a row at G 6 takes 43 frames (42 x 6 = 252 < 256); 18 rows from rest take 768 frames
  let sub = 0, f = 0; for (let row = 0; row < 1; f++) { sub += 6; if (sub >= 256) { row++; sub -= 256; } }
  assert.equal(f, 43);
  assert.equal(SPAWN_ROW, ROWS_DOWN, 'the pivot spawns on row 18, and every shape\'s lowest cell is its pivot row');
  assert.equal(Math.ceil(2 * 256 / 6) + Math.ceil(17 * 256 / 6) + 32 - 2, BOUND);
  assert.equal(boundFor(1), BOUND);
  // a real piece that does nothing at level 1 on an empty board: falls 18 rows (lands on its 768th frame), then 31 more
  const s = mk({ pieces: ['BAR'] });
  while (s.ctx.phase !== PH_PLAY) s.step(0);
  let n = 1; // the spawn frame, stepped by the loop above
  while (s.ctx.pType !== 0 && n < 2000) { s.step(0); n++; }
  assert.equal(n, 768 + 31, `${n} frames`);
  assert.ok(n <= BOUND);
  // the per-level bounds the doc states (B.6)
  assert.deepEqual([1, 5, 10, 13, 16, 17, 20].map(boundFor), [842, 334, 127, 79, 55, 41, 16]);
});

test('hard drop and soft drop locks unchanged; entry delay unchanged', () => {
  // hard drop locks on the press frame; the next piece's first frame is L + 9 (B.6)
  const h = mk({ pieces: ['BAR', 'BAR'] });
  while (h.ctx.phase !== PH_PLAY) h.step(0);
  const pf = h.frame; h.step(HARD);
  const [lk] = events(h, EV_LOCK); assert.equal(lk[1], pf, 'locked on the press frame');
  const spawned = h.ctx.spawned;
  while (h.ctx.spawned === spawned) h.step(0);
  assert.equal(h.frame - 1, pf + ENTRY_DELAY + 1, 'next piece on L + 9');
  // hard drop on a resting piece after some moves: locks on that frame, not later
  const m = mk({ pieces: ['BAR', 'BAR'] }); const m0 = landing(m);
  m.step(LEFT_TAP); m.step(0); m.step(RIGHT_TAP);
  const hf = m.frame; m.step(HARD);
  const [lm] = events(m, EV_LOCK); assert.equal(lm[1], hf); assert.ok(hf - m0 < 32);
  // soft drop held all the way: lands, then locks 32 frames after first resting (soft drop does not shorten it)
  const s = mk({ pieces: ['BAR', 'BAR'] }); const s0 = landing(s);
  const sp = s.ctx.spawned; let lf = -1;
  for (let i = 0; i < 100 && lf < 0; i++) { const f = s.frame; s.step(SOFT); if (s.ctx.spawned !== sp || s.ctx.pType === 0) lf = f; }
  assert.equal(lf, s0 + 31);
});

test('resets stay 0 for every piece of a whole run with constant wiggling', () => {
  let pieces = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const s = createSim({ seed, mode: 'arcade' });
    let i = 0;
    while (!s.done && i < 20000) {
      const k = (i + seed) % 7;
      s.step(k === 0 ? LEFT_TAP : k === 2 ? RIGHT_TAP : k === 4 ? ROTATE : k === 5 ? SOFT : 0);
      assert.equal(s.ctx.resets, 0, 'seed ' + seed + ' frame ' + i);
      i++;
    }
    pieces += s.ctx.spawned;
  }
  assert.ok(pieces > 50, 'many pieces played: ' + pieces);
  assert.equal(ROT_H, 0);
});
