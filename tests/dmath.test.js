import test from 'node:test';
import assert from 'node:assert/strict';
import { sin, cos, atan2, hypot } from '../engine/dmath.js';

const TOL = 1e-6;
function samples() {
  const xs = [0, -0, 1e-9, -1e-9, Math.PI, -Math.PI, Math.PI / 2, Math.PI / 4, 3 * Math.PI / 4, 1e4, -1e4, 123456.789];
  let s = 1;
  for (let i = 0; i < 20000; i++) { s = (s * 16807) % 2147483647; xs.push((s / 2147483647 - 0.5) * 2000); }
  return xs;
}

test('sin and cos match Math within 1e-6', () => {
  let worst = 0;
  for (const x of samples()) {
    worst = Math.max(worst, Math.abs(sin(x) - Math.sin(x)), Math.abs(cos(x) - Math.cos(x)));
  }
  assert.ok(worst < TOL, 'worst error ' + worst);
});

test('atan2 matches Math within 1e-6, including signs and zeros', () => {
  let worst = 0, s = 7;
  for (let i = 0; i < 20000; i++) {
    s = (s * 16807) % 2147483647; const y = (s / 2147483647 - 0.5) * 800;
    s = (s * 16807) % 2147483647; const x = (s / 2147483647 - 0.5) * 800;
    worst = Math.max(worst, Math.abs(atan2(y, x) - Math.atan2(y, x)));
  }
  for (const [y, x] of [[0, 0], [0, -0], [-0, -0], [-0, 0], [0, -1], [-0, -1], [1, 0], [-1, 0], [5, 5], [-5, -5], [1e-12, -3], [3, 1e-12]]) {
    assert.ok(Math.abs(atan2(y, x) - Math.atan2(y, x)) < TOL, `atan2(${y}, ${x})`);
    assert.equal(Object.is(atan2(y, x), -0), Object.is(Math.atan2(y, x), -0), `sign of zero for atan2(${y}, ${x})`);
  }
  assert.ok(worst < TOL, 'worst error ' + worst);
});

test('hypot matches Math', () => {
  for (const [x, y] of [[3, 4], [0, 0], [-5, 12], [1e-3, 2e-3], [300, -400]]) assert.ok(Math.abs(hypot(x, y) - Math.hypot(x, y)) < 1e-9);
});

test('results are exactly repeatable (bit for bit) and pinned', () => {
  const xs = samples();
  for (const x of xs) { assert.ok(Object.is(sin(x), sin(x))); assert.ok(Object.is(cos(x), cos(x))); }
  // pinned values: if these change, every recorded replay changes too
  const pin = [sin(1), cos(1), atan2(1, 2), sin(1000.5), atan2(-3, -7)];
  assert.deepEqual(pin, PINNED);
});

const PINNED = [0.8414709848078965,0.5403023058681398,0.4636476090008061,0.9952739571052135,-2.7367008673047097];
