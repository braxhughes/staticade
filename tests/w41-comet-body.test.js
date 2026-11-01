// the comet body. The sim's returned object exposes the comet state object as `cometBody` (`comet` stays the test hook
// that forces one), and render/core.js cometLayer reads it, so the ring (10 dots) and core dot draw while the comet crosses.
// Node only; tests/w41-comet-body-browser.test.js checks the same through the real page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { W } from '../games/starfall/defs.js';
import { cometLayer } from '../games/starfall/render/core.js';

const W_FIRE = 1 << 9, W_FIRE_PRESS = 1 << 10;

// a stub R that counts the dots a layer draws (no graphics)
function stubR() {
  const R = { n: 0, last: null, ui: { F: 0 }, dot(x, y) { R.n++; R.last = [x, y]; } };
  return R;
}
function toPlay(sim) {
  let n = 0;
  while (sim.state !== 'play' && n++ < 2000) { sim.step(0); sim.drain(() => {}); }
  assert.equal(sim.state, 'play');
}

test('cometBody is the live comet state object; comet is still the hook', () => {
  const sim = createSim({ seed: 4040, mode: 'arcade' });
  assert.equal(typeof sim.comet, 'function');
  const b = sim.cometBody;
  assert.equal(typeof b, 'object');
  assert.equal(b, sim.ctx.comet, 'same object as the sim state, not a copy');
  for (const k of ['on', 'x', 'y', 'px', 'py']) assert.ok(k in b, 'missing ' + k);
  assert.equal(sim.cometBody, b, 'the same reference every read');
});

test('cometBody goes on after comet() and stays on while it crosses, then leaves past the edge', () => {
  const sim = createSim({ seed: 4040, mode: 'arcade' });
  toPlay(sim);
  const b = sim.cometBody;
  for (let k = 0; k < 30; k++) { sim.step(0); sim.drain(() => {}); assert.equal(b.on, false, 'no comet on stage 1 by itself'); }
  sim.comet();
  let k = 0;
  while (!b.on && k++ < 10) { sim.step(0); sim.drain(() => {}); }
  assert.equal(b.on, true, 'on within a few frames of comet()');
  assert.equal(sim.cometBody, b);
  const dir = Math.sign(b.vx), x0 = b.x;
  let frames = 0, lastX = b.x;
  while (b.on && frames < 400) {
    sim.step(0); sim.drain(() => {}); frames++;
    if (!b.on) break;
    assert.ok((b.x - lastX) * dir > 0, 'moves one way');
    assert.equal(b.px, lastX, 'px is the previous x (interpolation)');
    lastX = b.x;
  }
  assert.equal(b.on, false);
  assert.ok(frames > 200, 'crossed the playfield: ' + frames + ' frames on');
  assert.ok(lastX < -18 || lastX > W + 18, 'left past the edge at x=' + lastX + ' (from ' + x0 + ')');
});

test('cometLayer draws ring + core (11 dots) at the interpolated spot while on, nothing while off', () => {
  const sim = createSim({ seed: 4040, mode: 'arcade' });
  toPlay(sim);
  const R = stubR();
  cometLayer.draw(R, sim, 0.5);
  assert.equal(R.n, 0, 'no comet: nothing drawn');
  assert.equal(cometLayer.drawn, 0);
  sim.comet();
  for (let k = 0; k < 40; k++) { sim.step(0); sim.drain(() => {}); }
  const b = sim.cometBody;
  assert.equal(b.on, true);
  R.n = 0; R.ui.F = 17;
  cometLayer.draw(R, sim, 0.25);
  assert.equal(R.n, 11, '10 ring dots + 1 core');
  assert.equal(cometLayer.drawn, 11);
  const ex = b.px + (b.x - b.px) * 0.25, ey = b.py + (b.y - b.py) * 0.25;
  assert.deepEqual(R.last, [ex, ey], 'core dot is drawn last, at the interpolated centre');
  assert.equal(cometLayer.x, ex); assert.equal(cometLayer.y, ey);
  while (b.on) { sim.step(0); sim.drain(() => {}); }
  R.n = 0;
  cometLayer.draw(R, sim, 0.5);
  assert.equal(R.n, 0);
  assert.equal(cometLayer.drawn, 0);
});

// the run used for the stateHash comparison: an LCG over the seed picks move and fire for each of 9000 frames;
// `forced`: god mode and sim.comet() at frame 600 (that run also meets comets on its own later)
function run(seed, forced, drawEachFrame) {
  const sim = createSim({ seed, mode: 'arcade' });
  if (forced) sim.setGod(true);
  const R = stubR();
  let x = seed >>> 0, held = false, mv = 128, comets = 0, wasOn = false, drawnOn = 0;
  for (let f = 0; f < 9000; f++) {
    if (forced && f === 600) sim.comet();
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    if ((x >>> 24) < 12) mv = 1 + ((x >>> 8) % 255);
    const fire = ((x >>> 16) & 3) !== 0, word = mv | (fire ? W_FIRE : 0) | (fire && !held ? W_FIRE_PRESS : 0);
    held = fire; sim.step(word); sim.drain(() => {});
    const on = sim.cometBody.on; if (on && !wasOn) comets++; wasOn = on;
    if (drawEachFrame) { R.n = 0; cometLayer.draw(R, sim, 0.5); if (R.n === 11) drawnOn++; else assert.equal(R.n, 0); }
  }
  return { hash: sim.stateHash(), comets, drawnOn };
}

test('stateHash: drawing the comet body every frame does not touch the sim (same hash with and without)', () => {
  const plain = run(4040, true, false), drawn = run(4040, true, true);
  assert.equal(drawn.hash, plain.hash);
  assert.ok(drawn.comets >= 2, 'comets in the run: ' + drawn.comets);
  assert.ok(drawn.drawnOn > 300, 'frames with the body drawn: ' + drawn.drawnOn);
});
