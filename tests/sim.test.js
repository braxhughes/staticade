import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSim } from '../games/starfall/sim.js';
import { packWord } from '../engine/input-word.js';
import { encode, decode } from '../engine/replay.js';

// scripted pseudo-random play: sweeps, taps fire, sometimes kindles
function inputs(n, salt = 1) {
  const out = new Uint16Array(n); let s = salt;
  for (let f = 0; f < n; f++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const mv = ((f / (30 + (s >>> 28))) | 0) % 3 - 1;
    out[f] = packWord(mv, (s >>> 20) % 3 !== 0, f % 9 === 0, (s >>> 8) % 500 === 0, false, 0);
  }
  return out;
}
function run(seed, mode, words) {
  const sim = createSim({ seed, mode });
  for (let i = 0; i < words.length && !sim.done; i++) { sim.step(words[i]); sim.clearEvents(); }
  return sim;
}

test('same seed + same inputs give identical hashes', () => {
  const w = inputs(20000);
  for (const mode of ['arcade', 'stage4', 'stage5']) {
    const a = run(1234, mode, w), b = run(1234, mode, w);
    assert.equal(a.stateHash(), b.stateHash());
    assert.equal(a.score, b.score); assert.equal(a.frame, b.frame);
    assert.ok(a.frame > 1000);
  }
});

test('hash is identical at every frame, not just the end', () => {
  const w = inputs(4000, 9), a = createSim({ seed: 5 }), b = createSim({ seed: 5 });
  for (let i = 0; i < w.length; i++) {
    a.step(w[i]); b.step(w[i]); a.clearEvents(); b.clearEvents();
    if (i % 97 === 0) assert.equal(a.stateHash(), b.stateHash(), 'frame ' + i);
  }
});

test('different seeds diverge', () => {
  const w = inputs(6000);
  const hashes = new Set([1, 2, 3, 4].map(s => run(s, 'arcade', w).stateHash()));
  assert.equal(hashes.size, 4);
  assert.notDeepEqual(createSim({ seed: 1 }).entry(), createSim({ seed: 2 }).entry());
});

test('a replay string re-simulates to the same result', () => {
  const w = inputs(8000, 3);
  const a = run(77, 'arcade', w);
  const used = w.subarray(0, a.frame);
  const r = decode(encode({ game: 'starfall', version: '1.1', seed: 77, mode: 'arcade' }, used));
  const b = run(r.seed, r.mode, r.words);
  assert.equal(b.stateHash(), a.stateHash());
});

test('accuracy can no longer exceed 100% (hits only count connecting shots)', () => {
  for (const mode of ['arcade', 'stage3', 'stage5']) for (let seed = 1; seed <= 4; seed++) {
    const sim = createSim({ seed, mode });
    if (mode === 'stage5') sim.setGod(true);
    const w = inputs(30000, seed);
    let kindles = 0;
    for (let i = 0; i < w.length && !sim.done; i++) {
      if (sim.meter >= 10) kindles++;
      sim.step(w[i] | (sim.meter >= 10 ? (1 << 11) : 0)); sim.clearEvents();
    }
    assert.ok(sim.hits <= sim.shotsFired, `${mode}/${seed}: hits ${sim.hits} > shots ${sim.shotsFired}`);
  }
});

test('the run ends: game over sets done and step() is then a no-op', () => {
  const sim = run(3, 'arcade', inputs(60 * 60 * 20, 2));
  assert.ok(sim.done, 'scripted play should lose all lives within 20 minutes');
  assert.equal(sim.lives, 0);
  const h = sim.stateHash(); sim.step(0); assert.equal(sim.stateHash(), h);
});

test('sim.js imports and runs in Node with no browser globals and no impure APIs', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const script = `
    const trap = name => { throw new Error('sim touched ' + name); };
    for (const g of ['window', 'document', 'navigator', 'localStorage', 'performance', 'requestAnimationFrame', 'AudioContext', 'WebGLRenderingContext', 'crypto'])
      Object.defineProperty(globalThis, g, { get: () => trap(g), configurable: true });
    Math.random = () => trap('Math.random'); Math.sin = () => trap('Math.sin'); Math.cos = () => trap('Math.cos');
    Math.atan2 = () => trap('Math.atan2'); Math.tan = () => trap('Math.tan'); Math.hypot = () => trap('Math.hypot');
    globalThis.Date = new Proxy(Date, { construct: () => trap('Date'), get: (t, k) => trap('Date.' + String(k)) });
    const { createSim } = await import('../games/starfall/sim.js');
    for (const mode of ['arcade', 'stage4', 'stage5']) {
      const sim = createSim({ seed: 11, mode });
      for (let f = 0; f < 6000 && !sim.done; f++) { sim.step(((f >> 5) & 1 ? 255 : 1) | 512 | (f % 8 === 0 ? 1024 : 0)); sim.drain(() => {}); }
      sim.stateHash();
    }
    console.log('pure-ok');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: here, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pure-ok/);
});
