// The interpolation alpha STACKLIGHT draws with is never exactly 1 (nor below 0), so render.js popups'
// integer shortcuts (popOn, risen, solid: "alpha in [0, 1)") always hold. The alpha comes only from engine/loop.js
// (render(acc / STEP) after the step loop leaves acc < STEP), and main.js writes renderer.T[1] only from that alpha or 0.
// tests/w69-popups-browser.test.js draws popups at alphas within 1e-12 of 1 and checks every call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLoop } from '../engine/loop.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// the largest double below x (x > 0)
function below(x) { const f = new Float64Array([x]), u = new BigUint64Array(f.buffer); u[0] -= 1n; return f[0]; }

test('the loop\'s alpha stays in [0, 1): adversarial and random frame times, the largest acc below a step included', () => {
  const STEP = 1000 / 60;
  // acc can be at most the largest double below STEP; that divided by STEP is still below 1
  assert.ok(below(STEP) < STEP);
  assert.ok(below(STEP) / STEP < 1, 'the largest acc / STEP rounds below 1');
  for (const hz of [60, 30, 120, 50, 144]) { const s = 1000 / hz; assert.ok(below(s) / s < 1, `hz ${hz}`); }
  let alphas = [], steps = 0;
  const loop = createLoop({ step: () => steps++, render: a => alphas.push(a), raf: () => {}, now: () => 0 });
  loop.resetClock();
  // timestamps that leave acc just under, at, or just over a whole step (every way to round), plus a seeded random walk
  let t = 0, min = 1, max = 0;
  const feed = x => { loop.advance(x); const a = alphas[alphas.length - 1]; if (a < min) min = a; if (a > max) max = a; assert.ok(a >= 0 && a < 1, `alpha ${a} at t ${x}`); };
  for (let k = 1; k <= 2000; k++) { t = below(k * STEP); feed(t); feed(t); feed(k * STEP); }
  for (let k = 0; k < 2000; k++) { t += below(STEP); feed(t); t += STEP; feed(t); t = below(t + STEP); feed(t); }
  let s = 0x9e3779b9;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
  for (let k = 0; k < 200000; k++) { t += rnd() < 0.5 ? STEP * (1 + rnd() * 1e-12) : rnd() * 40; feed(t); }
  // clamps: a long stall, a clock going backwards
  feed(t + 1e6); feed(t + 1e6 - 50); feed(t + 1e6 + below(STEP));
  assert.ok(max > 1 - 1e-9, `alphas reached near 1 (${max})`);
  assert.ok(min < 1e-9, `and near 0 (${min})`);
  assert.equal(loop.alpha >= 0 && loop.alpha < 1, true);
});

test('STACKLIGHT main.js: renderer.T[1] is written only from the loop\'s alpha (or 0), and render runs only from the loop', () => {
  const src = fs.readFileSync(ROOT + 'games/stacklight/main.js', 'utf8');
  const writes = [...src.matchAll(/renderer\.T\[1\]\s*=\s*([^;]+);/g)].map(m => m[1].trim());
  assert.deepEqual(writes, ['al', 'al', "app === 'play' && !ui.paused ? al : 0"]);
  assert.equal([...src.matchAll(/function render\((\w+)\)/g)].map(m => m[1]).join(), 'al', 'render(al) is the one render');
  assert.equal((src.match(/\brender\(/g) || []).length, 1, 'main.js never calls render itself (only its definition)');
  assert.ok(/createLoop\(\{ step: tick, render \}\)/.test(src), 'the loop calls render');
  assert.equal((src.match(/\bal\s*=/g) || []).length, 0, 'al is never reassigned');
  // nothing else writes the renderer's T[1]: render.js (its owner) never does, and no other file touches renderer.T
  const code = f => fs.readFileSync(ROOT + f, 'utf8').replace(/\/\/.*$/gm, ''); // comments left out
  assert.equal(/\bT\[1\]\s*=[^=]/.test(code('games/stacklight/render.js')), false, 'render.js does not write T[1]');
  for (const f of fs.readdirSync(ROOT + 'games/stacklight', { recursive: true }).filter(f => f.endsWith('.js'))) {
    if (f === 'main.js') continue;
    assert.equal(/renderer\.T\b/.test(code('games/stacklight/' + f)), false, `games/stacklight/${f} does not touch renderer.T`);
  }
});
