import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { slot } from '../games/starfall/sim/formation.js';
import { sin } from '../engine/dmath.js';
import { ZONES, haloOf, zonesLayer } from '../games/starfall/render/zones.js';
import { starsLayer, bulletsLayer } from '../games/starfall/render/core.js';
import { FRAMES_PER_BEAT } from '../games/starfall/music.js';
import { layers } from '../games/starfall/render/layers.js';
import { ROWS } from '../games/starfall/defs.js';

// slot() reads only zone, formT and formFull from the context, so a bare object is enough
const at = (zone, formT, r, c, formFull = true) => { const S = { zone, formT, formFull, SX: 0, SY: 0 }; slot(S, r, c); return [S.SX, S.SY]; };

test('Z2 tide sway: row r shifts x by sin(formT*0.02 + r*0.9)*10 on top of the v1 slot', () => {
  for (const t of [0, 7, 100, 333, 1500]) for (let r = 0; r < ROWS.length; r++) for (const c of [0, ROWS[r] - 1]) {
    const base = at(1, t, r, c), tide = at(2, t, r, c);
    assert.ok(Math.abs(tide[0] - base[0] - sin(t * 0.02 + r * 0.9) * 10) < 1e-9);
    assert.equal(tide[1], base[1]);
  }
});

test('tide sway is zero in Z1 and Z3 (identical slots)', () => {
  for (const t of [0, 50, 400, 2000]) for (let r = 0; r < ROWS.length; r++) {
    assert.deepEqual(at(1, t, r, 0, false), at(3, t, r, 0, false)); // Z3 differs only by its faster breathe, absent before the formation is full
    assert.deepEqual(at(1, t, r, 0), at(0, t, r, 0)); // the v1 formula, untouched
  }
});

test('tide sway differs per row, so the formation visibly rolls', () => {
  const xs = []; for (let r = 0; r < ROWS.length; r++) xs.push(at(2, 100, r, 0)[0] - at(1, 100, r, 0)[0]);
  assert.ok(new Set(xs.map(v => v.toFixed(6))).size === xs.length);
  assert.ok(xs.every(v => Math.abs(v) <= 10));
});

test('sway is deterministic: two stage-6 runs with the same seed and inputs end on the same hash', () => {
  const run = () => { const s = createSim({ seed: 9, mode: 'stage6' }); for (let i = 0; i < 700 && !s.done; i++) { s.step(i % 50 < 25 ? 1 : 2); s.clearEvents(); } return s; };
  const a = run(), b = run();
  assert.equal(a.zone, 2);
  assert.equal(a.stateHash(), b.stateHash());
});

test('zone sims report the right zone: stage 1, 6, 11', () => {
  assert.deepEqual([1, 6, 11].map(s => createSim({ seed: 1, mode: 'stage' + s }).zone), [1, 2, 3]);
});

test('palettes follow B.3 and halos differ per zone', () => {
  assert.deepEqual(ZONES[1].a1, [1, 0.7, 0.25]);
  assert.deepEqual(ZONES[2].a1, [0.25, 0.95, 0.9]);
  assert.deepEqual(ZONES[3].a1, [0.95, 0.15, 0.25]);
  assert.deepEqual(haloOf(1), [1, 0.3, 0.6]);
  assert.deepEqual(haloOf(2), [1, 0.55, 0.3]);
  assert.deepEqual(haloOf(3), [0.6, 1, 1]);
  assert.deepEqual(haloOf(9), haloOf(1));
});

test('zones layer is registered first and draws stars with bounded alpha and dot counts', () => {
  assert.equal(layers[0], zonesLayer);
  for (const zone of [1, 2, 3]) {
    let n = 0, maxA = 0, bad = 0;
    const R = { ui: { F: 100 + zone }, dot(x, y, s, r, g, b, a) { n++; if (s < 20 && a > maxA) maxA = a; if (!(a >= 0) || !(s > 0) || r > 1 || g > 1 || b > 1) bad++; } };
    zonesLayer.draw(R, { zone, warp: 0 });
    assert.equal(bad, 0);
    assert.ok(n >= [0, 140, 120, 160][zone] && n < 2000, 'dots ' + n);
    assert.ok(maxA > 0.1 && maxA <= 0.5, 'non-wash alpha ' + maxA); // B.9 rule 4: stars and sky dots at most 0.5
  }
});

test('sim stays pure in Z2 and Z3: stage 6 and 11 run under the Math.sin / Math.cos / Math.random trap', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const script = `
    const trap = name => { throw new Error('sim touched ' + name); };
    Math.random = () => trap('Math.random'); Math.sin = () => trap('Math.sin'); Math.cos = () => trap('Math.cos');
    const { createSim } = await import('../games/starfall/sim.js');
    for (const mode of ['stage6', 'stage11']) {
      const sim = createSim({ seed: 5, mode });
      for (let f = 0; f < 900 && !sim.done; f++) { sim.step(((f >> 5) & 1 ? 255 : 1) | 512); sim.drain(() => {}); }
      sim.stateHash();
    }
    console.log('pure-ok');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: here, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pure-ok/);
});

test('Z3 formation breathes faster (0.045) than Z1 and Z2 (0.03); Z1 and Z2 unchanged', () => {
  const x = (zone, t) => { const S = { zone, formT: t, formFull: true, SX: 0, SY: 0 }; slot(S, 0, 0); return S.SX; };
  const want = (k, t) => { const n = ROWS[0], br = (sin(t * k) * 0.5 + 0.5) * 0.14; return 200 + (0 - (n - 1) / 2) * 24 * (1 + br) + sin(t * 0.017) * 4; };
  for (const t of [10, 77, 400]) {
    assert.ok(Math.abs(x(3, t) - want(0.045, t)) < 1e-9);
    assert.ok(Math.abs(x(1, t) - want(0.03, t)) < 1e-9);
    assert.ok(Math.abs(x(2, t) - want(0.03, t) - sin(t * 0.02) * 10) < 1e-9);
  }
  assert.notEqual(x(3, 77), x(1, 77));
});

test('bulletsLayer: white core 1.1 inside a 2.2 halo of the zone halo color (B.9 rule 1)', () => {
  for (const zone of [1, 2, 3]) {
    const dots = [];
    const R = { dot: (x, y, s, r, g, b, a) => dots.push({ x, y, s, r, g, b, a }) };
    const sim = { zone, eb: [{ on: true, x: 50, y: 60, px: 50, py: 60, vx: 0, vy: 2, big: false }, { on: true, x: 80, y: 90, px: 80, py: 90, vx: 0, vy: 2, big: true }] };
    bulletsLayer.draw(R, sim, 1);
    const h = haloOf(zone);
    for (const [bx, by] of [[50, 60], [80, 90]]) {
      const at = dots.filter(d => d.x === bx && d.y === by);
      const halo = at.find(d => d.s === 2.2), core = at.find(d => d.s === 1.1);
      assert.ok(halo && core, 'halo and core at ' + bx);
      assert.deepEqual([halo.r, halo.g, halo.b], h);
      assert.deepEqual([core.r, core.g, core.b, core.a], [1, 1, 1, 1]);
      assert.ok(at.indexOf(core) > at.indexOf(halo), 'core drawn on top of the halo');
    }
  }
  assert.notDeepEqual(haloOf(1), haloOf(3));
});

test('v1 starsLayer yields in zones 1-3 and still draws without a zone', () => {
  for (const zone of [1, 2, 3]) { let n = 0; starsLayer.draw({ fx: { drawStars() { n++; } }, ui: { F: 1 } }, { zone, warp: 0 }); assert.equal(n, 0); }
  let n = 0; starsLayer.draw({ fx: { drawStars() { n++; } }, ui: { F: 1 } }, { zone: 0, warp: 0 }); assert.equal(n, 1);
});

test('Z2 star field sways in x by sin(F*0.01)*6 on top of its drift', () => {
  // the far layer drifts 0.32 per frame, so at F = 1250 it has wrapped W=400 exactly: the only x change left is the sway
  const stars = F => { const d = []; zonesLayer.draw({ ui: { F }, dot: (x, y, s, r, g, b, a) => d.push(x) }, { zone: 2, warp: 0 }); return d.slice(-120); };
  const a = stars(0), b = stars(1250), want = Math.sin(12.5) * 6;
  assert.ok(Math.abs(want) > 0.3);
  for (let i = 2; i < 120; i += 3) assert.ok(Math.abs(b[i] - a[i] - want) < 0.01, `star ${i}: ${b[i] - a[i]} vs ${want}`);
});

test('Z3 sun pulses on the 20-frame beat (180 BPM) and its alpha stays within 0.5', () => {
  assert.equal(FRAMES_PER_BEAT.z3, 20);
  const ring = F => { let m = 0; zonesLayer.draw({ ui: { F }, dot: (x, y, s, r, g, b, a) => { if (s === 1.5) m = Math.max(m, a); } }, { zone: 3, warp: 0 }); return m; };
  assert.ok(ring(40) > ring(50) && ring(60) > ring(70), 'brightest on the beat, dimmer between');
  assert.ok(Math.abs(ring(40) - ring(60)) < 1e-9 && ring(40) <= 0.5);
});

test('a new run starts on its own sky, with no cross-fade from the previous run', () => {
  const seen = []; const mk = z => ({ zone: z, warp: 0 });
  const R = F => ({ ui: { F }, dot() {} });
  const s3 = mk(3), s1 = mk(1);
  zonesLayer.draw(R(1000), s3);
  zonesLayer.draw(R(1001), s1);
  let gold = 0, crimson = 0; zonesLayer.draw({ ui: { F: 1002 }, dot(x, y, s, r, g, b, a) { if (r === 1 && g === 0.88) gold++; if (r === 0.95 && g === 0.15) crimson++; } }, s1);
  assert.ok(gold > 0); // Z1 gold stars drawn
  assert.equal(crimson, 0); // no Z3 crimson mixed in from the previous run
});
