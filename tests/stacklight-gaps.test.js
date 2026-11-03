// STACKLIGHT T1 test gaps found missing by a cold review.
// New file only; nothing here edits an existing test. The RIDGES and gravity expectations are parsed from the design
// doc text, never from defs.js, so a typo in defs.js cannot hide behind itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSim, PH_PLAY, EV_CLEAR, EV_LOCK } from '../games/stacklight/sim.js';
import { COLS, BAR, PLUS, ROT_H, ROT_V, RUN_CAP, RIDGES, GRAVITY, GAME_ID, GAME_VERSION, CELL_RIDGE } from '../games/stacklight/defs.js';

const DOC = fs.readFileSync(fileURLToPath(new URL('../agent_docs/stacklight-design.md', import.meta.url)), 'utf8');
const mk = (t = {}, seed = 1) => createSim({ seed, mode: 'test', test: t });
function toPlay(sim) { while (sim.ctx.phase !== PH_PLAY && !sim.done) sim.step(0); }
function events(sim, type) { const out = []; sim.drain((b, o) => { if (b[o] === type) out.push(Array.from(b.subarray(o, o + 6))); }); return out; }
// tap to the pivot column, then hard drop (BAR stays flat)
function place(sim, col) {
  toPlay(sim);
  const S = sim.ctx;
  let guard = 0;
  while (S.px !== col && guard++ < 20) { sim.step(S.px > col ? 9 : 18); sim.step(0); }
  sim.step(32);
}

// ---------- M1 (rewritten for D111, GAME_VERSION 2.0): a successful turn while resting never restarts the lock delay ----------
test('M1 no lock reset: a successful BAR turn on a resting piece keeps the lock delay counting and spends no reset', () => {
  const s = mk({ pieces: ['BAR'] });
  toPlay(s);
  while (s.ctx.lockT === 0) s.step(4); // soft drop until it rests
  while (s.ctx.lockT < 20) s.step(0);
  assert.equal(s.ctx.lockT, 20); assert.equal(s.ctx.resets, 0);
  s.step(64); // H to V on the floor
  assert.equal(s.ctx.rot, ROT_V, 'the turn happened');
  assert.equal(s.ctx.resets, 0, 'no reset spent');
  assert.equal(s.ctx.lockT, 21, 'the delay went on (no restart)');
  const spawned = s.ctx.spawned;
  for (let i = 0; i < 10; i++) s.step(0); // frames 22 .. 31 of rest
  assert.equal(s.ctx.lockT, 31); assert.equal(s.ctx.spawned, spawned, 'not locked yet');
  s.step(0); // the 32nd frame of rest
  assert.equal(s.ctx.pType, 0, 'locked on the 32nd frame of rest, as with no turn');
});

test('M1 no lock reset: a kicked V to H turn on a resting piece keeps the lock delay counting', () => {
  const s = mk({ pieces: ['BAR'] });
  toPlay(s);
  while (s.ctx.lockT === 0) s.step(4);
  s.step(64); // to V
  while (s.ctx.px < 8) { s.step(18); s.step(0); }
  while (s.ctx.lockT < 10) s.step(0);
  assert.equal(s.ctx.px, 8); assert.equal(s.ctx.rot, ROT_V); assert.ok(s.ctx.lockT >= 10 && s.ctx.lockT < 20);
  const t0 = s.ctx.lockT;
  s.step(64); // V to H against the right wall: +1 blocked, -1 kicks to pivot 7
  assert.equal(s.ctx.rot, ROT_H); assert.equal(s.ctx.px, 7, 'kicked one column left');
  assert.equal(s.ctx.resets, 0);
  assert.equal(s.ctx.lockT, t0 + 1, 'no restart');
});

// ---------- the 64 RIDGES equal the design doc table ----------
test('M2 RIDGES: all 64 equal the table in the design doc (B.9), digit for digit', () => {
  const at = DOC.indexOf('RIDGES (64, each 9 digits');
  assert.ok(at > 0, 'doc table found');
  const open = DOC.indexOf('```', at), close = DOC.indexOf('```', open + 3);
  const want = DOC.slice(open + 3, close).trim().split(/\s+/);
  assert.equal(want.length, 64);
  for (const r of want) assert.match(r, /^[0-2]{9}$/);
  assert.equal(RIDGES.length, 64);
  for (let i = 0; i < 64; i++) assert.equal(RIDGES[i], want[i], 'RIDGES[' + i + ']');
  // literal spot checks of the ends, copied from the doc
  assert.equal(RIDGES[0], '222200000'); assert.equal(RIDGES[63], '001202222'); assert.equal(RIDGES[57], '112201122'); // the Daily seed 1 ridge (C.6)
});

// ---------- gravity table equals B.6 (the doc's "Gravity table"), and drives the fall ----------
function docGravity() {
  const start = DOC.indexOf('**Gravity table**');
  assert.ok(start > 0);
  const out = {};
  for (const line of DOC.slice(start, start + 2000).split('\n')) {
    const m = /^\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*[\d.]+\s*\|\s*(\d+)\+?\s*\|\s*(\d+)\s*\|/.exec(line);
    if (m) { out[+m[1]] = +m[2]; out[+m[3]] = +m[4]; }
  }
  return out;
}
test('M3 gravity: every level G equals the design doc table (levels 1 to 20)', () => {
  const g = docGravity();
  for (let l = 1; l <= 20; l++) assert.ok(Number.isInteger(g[l]), 'doc has level ' + l);
  assert.equal(g[14], 128); assert.equal(g[15], 160); assert.equal(g[17], 256); assert.equal(g[18], 384); assert.equal(g[19], 640);
  assert.equal(GRAVITY.length, 21);
  assert.equal(GRAVITY[0], 0);
  for (let l = 1; l <= 20; l++) assert.equal(GRAVITY[l], g[l], 'GRAVITY[' + l + ']');
});

test('M3 gravity: in free fall the sub-row counter plus 256 per row fallen equals frames x doc G, at every level 1 to 19', () => {
  const g = docGravity();
  for (let l = 1; l <= 19; l++) {
    const s = mk({ lines: (l - 1) * 8, pieces: ['BAR'] });
    assert.equal(s.level, l);
    for (let n = 1; n <= 3; n++) {
      s.step(0);
      assert.equal((18 - s.ctx.py) * 256 + s.ctx.sub, n * g[l], 'level ' + l + ' after ' + n + ' frames');
    }
  }
  const s = mk({ lines: 19 * 8, pieces: ['BAR'] }); // level 20: an instant beam, the piece lands on the spawn frame
  s.step(0); assert.equal(s.ctx.py, 0);
});

// ---------- the run cap and test start heights ----------
test('L1 RUN_CAP is 216000 frames (the server MAX_RUN_FRAMES, C.3)', () => { assert.equal(RUN_CAP, 216000); });

test('L2 test start: height cells are RIDGE (type 4) the moment the sim is created, empty above', () => {
  const h = [3, 0, 1, 0, 2, 0, 0, 5, 1];
  const s = mk({ heights: h });
  for (let c = 0; c < COLS; c++) for (let r = 0; r < 8; r++) {
    assert.equal(s.grid[r * COLS + c], r < h[c] ? CELL_RIDGE : 0, 'col ' + c + ' row ' + r);
  }
  assert.equal(CELL_RIDGE, 4);
});

// ---------- direct rule tests ----------
test('L5 hard drop in delay: a hard drop pressed during entry or clear delay is ignored, not buffered', () => {
  // entry delay: lock, then press hard drop on every other delay frame
  const s = mk({ heights: [0, 0, 0, 0, 0, 0, 1, 1, 1], pieces: ['BAR', 'BAR'] });
  toPlay(s); s.step(32); // hard drop a BAR at cols 3..5: a lock with no clear
  assert.equal(s.ctx.phase, 0, 'in delay');
  const spawned = s.ctx.spawned, L = s.frame - 1;
  for (let i = 0; i < 8; i++) { s.step(i % 2 ? 0 : 32); assert.equal(s.ctx.spawned, spawned, 'no spawn in entry delay'); }
  assert.equal(s.ctx.phase, 0);
  s.step(0); // the first frame of the next piece: it must be alive and not dropped
  assert.equal(s.ctx.spawned, spawned + 1); assert.equal(s.frame, L + 10);
  assert.equal(s.ctx.pType, BAR); assert.equal(s.ctx.py, 18, 'spawn row, not dropped, not locked');
  // held (no new edge) hard drop bit never drops the next piece by itself
  const t = mk({ pieces: ['BAR', 'BAR'] });
  toPlay(t); t.step(32);
  for (let i = 0; i < 12; i++) t.step(32); // held pressed bit, no new edge
  assert.equal(t.ctx.spawned, 2); assert.equal(t.ctx.phase, PH_PLAY); assert.ok(t.ctx.py > 0);
  // clear delay: a clearing lock, then a press on a delay frame is ignored
  const c = mk({ heights: [1, 1, 1, 1, 0, 1, 1, 1, 1], pieces: ['PLUS', 'BAR'] });
  toPlay(c); c.step(32);
  assert.ok(events(c, EV_CLEAR).length === 1, 'cleared');
  const sp = c.ctx.spawned;
  for (let i = 0; i < 28; i++) { c.step(i % 2 ? 0 : 32); assert.equal(c.ctx.spawned, sp); }
  c.step(0); assert.equal(c.ctx.spawned, sp + 1); assert.equal(c.ctx.py, 18);
});

function clearThree(sim) { // fills row 0 on an empty board with three flat BARs: clears on the third
  place(sim, 1); place(sim, 4); place(sim, 7);
}
test('L5 GLOW: g is kept when the timer runs out and only resets on the next clear (B.7)', () => {
  const s = mk({ pieces: Array(12).fill('BAR') });
  clearThree(s); let ev = events(s, EV_CLEAR);
  assert.equal(ev.length, 1); assert.equal(ev[0][5], 0, 'first clear: timer was 0, g = 0'); assert.equal(ev[0][4], 100);
  assert.equal(s.glowT, 240);
  clearThree(s); ev = events(s, EV_CLEAR);
  assert.equal(ev.length, 1); assert.equal(ev[0][5], 1, 'within 240 frames: g = 1'); assert.equal(ev[0][4], 125);
  assert.equal(s.glow, 1);
  while (s.glowT > 0) s.step(0);
  assert.equal(s.glow, 1, 'timer out, g untouched until the next clear');
  for (let i = 0; i < 5; i++) s.step(0);
  assert.equal(s.glow, 1);
  clearThree(s); ev = events(s, EV_CLEAR);
  assert.equal(ev.length, 1); assert.equal(ev[0][5], 0, 'the next clear finds the timer at 0: g = 0'); assert.equal(ev[0][4], 100);
});

test('L5 GLOW: the timer counts down every frame, in the clear and entry delays too', () => {
  const s = mk({ heights: [1, 1, 1, 1, 0, 1, 1, 1, 1], pieces: ['PLUS', 'BAR'] });
  toPlay(s); s.step(32);
  assert.equal(s.glowT, 240);
  const f0 = s.frame;
  for (let i = 1; i <= 28; i++) { s.step(0); assert.equal(s.glowT, 240 - i, 'delay frame ' + i); assert.equal(s.frame, f0 + i); }
});

test('L5 FIT is paid at the level before the clear raises it (B.7): KEY 120 + clear 100 at level 1 when the clear takes level 1 to 2', () => {
  const s = mk({ lines: 7, heights: [1, 1, 1, 1, 0, 1, 1, 1, 1], pieces: ['PLUS'] });
  assert.equal(s.level, 1);
  toPlay(s); s.step(32);
  assert.equal(s.lines, 8); assert.equal(s.level, 2);
  assert.equal(s.score, 120 * 1 + 100 * 1);
  const b = mk({ lines: 7, heights: [1, 1, 1, 1, 1, 1, 0, 0, 0], pieces: ['BAR'] });
  toPlay(b); while (b.ctx.px < 7) { b.step(18); b.step(0); }
  b.step(32);
  assert.equal(b.lines, 8); assert.equal(b.score, 40 * 1 + 100 * 1, 'FLAT at level 1 too');
});

test('L5 LEAN deck is 2 BAR + 2 PLUS; the normal deck is 3 BAR + 2 PLUS', () => {
  let lean = null, normal = null;
  for (let seed = 1; seed < 200 && (lean === null || normal === null); seed++) {
    const d = createSim({ seed, mode: 'daily' });
    if (d.info().dayRule === 'LEAN') lean ||= d; else normal ||= d;
  }
  assert.ok(lean && normal);
  const count = sim => { let b = 0, p = 0; for (let i = 0; i < sim.ctx.deckLen; i++) sim.deck[i] === BAR ? b++ : p++; return [b, p, sim.ctx.deckLen]; };
  assert.deepEqual(count(lean), [2, 2, 4]);
  assert.equal(normal.ctx.deckLen, 5);
  assert.deepEqual(count(normal), [3, 2, 5]);
  const free = createSim({ seed: 1, mode: 'arcade' });
  assert.deepEqual(count(free), [3, 2, 5]);
});

test('L5 version: game id and version are pinned (a bump invalidates every stored replay)', () => {
  assert.equal(GAME_ID, 'stacklight'); assert.equal(GAME_VERSION, '2.0');
  assert.equal(createSim({ seed: 1, mode: 'arcade' }).info().version, '2.0');
});
