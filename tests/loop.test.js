import test from 'node:test';
import assert from 'node:assert/strict';
import { createLoop } from '../engine/loop.js';
import { packWord, wordMove, wordTouchX, W_FIRE, W_FIRE_PRESS, W_ALT_PRESS, W_TOUCH } from '../engine/input-word.js';

test('fixed 60 Hz steps from an accumulator, alpha in [0, 1)', () => {
  let steps = 0; const alphas = [];
  const L = createLoop({ step: () => steps++, render: a => alphas.push(a), now: () => 0, raf: () => {} });
  L.resetClock();
  let t = 0;
  for (let i = 0; i < 600; i++) { t += 1000 / 144; L.advance(t); } // 144 Hz display for ~4.17 s
  // 600 frames at 144 Hz = exactly 250 steps of time; float accumulation may land a hair short
  assert.ok(steps === 249 || steps === 250, 'steps ' + steps);
  for (const a of alphas) assert.ok(a >= 0 && a < 1);
});

test('a long frame is clamped (no catch-up burst)', () => {
  let steps = 0;
  const L = createLoop({ step: () => steps++, render: () => {}, now: () => 0, raf: () => {}, maxFrameMs: 250 });
  L.resetClock();
  L.advance(5000);
  assert.equal(steps, 15);
});

test('input word packs to 16 bits and unpacks', () => {
  for (const m of [-1, -0.5, 0, 0.31, 1]) {
    const w = packWord(m, true, false, true, false, 0);
    assert.ok(w >= 0 && w <= 0xffff);
    assert.ok(Math.abs(wordMove(w) - m) <= 0.5 / 127 + 1e-12);
    assert.ok(w & W_FIRE); assert.ok(!(w & W_FIRE_PRESS)); assert.ok(w & W_ALT_PRESS);
  }
  assert.equal(wordMove(packWord(1, false, false, false, false, 0)), 1);
  assert.equal(wordMove(packWord(-1, false, false, false, false, 0)), -1);
  const t = packWord(0, true, true, false, true, 233.6);
  assert.ok(t & W_TOUCH); assert.equal(wordTouchX(t), 234); assert.equal(wordMove(t), 0);
  assert.equal(wordTouchX(packWord(0, 0, 0, 0, true, -40)), 0);
});
