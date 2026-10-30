// V4 fix: FX_TETHER must look right, not just emit 10 dots. Kills these mutants of the tether burst in fx.js:
// speed 0 (no spread), life 38-39 (too long), gravity/fire colour modes, black colour, size 0, non-straight flight.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFx } from '../games/starfall/fx.js';
import { EV_FX, FX_TETHER } from '../games/starfall/defs.js';

const OX = 250, OY = 160;

// Fire one burst on a fresh fx and return a drawn snapshot (array of dots) after each of `frames` updates (index 0 = before any update).
function run(frames) {
  let cur = [];
  const fx = createFx((x, y, s, r, g, b, a) => cur.push({ x, y, s, r, g, b, a }));
  const ev = new Float64Array(10); ev[0] = EV_FX; ev[1] = FX_TETHER; ev[2] = OX; ev[3] = OY;
  assert.equal(fx.handle(ev, 0), true);
  const snaps = [];
  for (let f = 0; f <= frames; f++) {
    cur = []; fx.drawParticles(1); snaps.push(cur);
    fx.update(0, false);
  }
  return snaps;
}
const dist = (d) => Math.hypot(d.x - OX, d.y - OY);
const TRIALS = 12; // the burst is random; check many

test('tether dots spread to a measurable radius and keep flying outward', () => {
  for (let t = 0; t < TRIALS; t++) {
    const s = run(30);
    assert.equal(s[0].length, 10);
    for (const d of s[10]) assert.ok(dist(d) >= 6, 'every dot is at least 6 units out after 10 frames, got ' + dist(d));
    for (const d of s[17]) assert.ok(dist(d) >= 10, 'every dot is at least 10 units out after 17 frames, got ' + dist(d));
    const mean = (k) => s[k].reduce((a, d) => a + dist(d), 0) / s[k].length;
    assert.ok(mean(17) > mean(5) + 3, 'the ring keeps growing');
  }
});

test('tether dots go out in all directions, not as one clump', () => {
  for (let t = 0; t < TRIALS; t++) {
    const s = run(12)[12];
    const sectors = new Set(s.map((d) => Math.floor(((Math.atan2(d.y - OY, d.x - OX) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 5))));
    assert.ok(sectors.size >= 8, 'at least 8 of 10 direction sectors used, got ' + sectors.size);
  }
});

test('tether dots live 18 to 25 frames', () => {
  for (let t = 0; t < TRIALS * 2; t++) {
    const s = run(30);
    assert.equal(s[17].length, 10, 'all 10 still drawn after 17 updates');
    assert.equal(s[26].length, 0, 'none left after 26 updates');
  }
});

test('tether dots stay visible while they live', () => {
  for (let t = 0; t < TRIALS; t++) {
    const s = run(18);
    for (const k of [0, 6, 12, 17]) for (const d of s[k]) {
      assert.ok(d.s >= 0.3, 'size ' + d.s + ' at frame ' + k);
      assert.ok(Math.max(d.r, d.g, d.b) >= 0.8, 'bright colour at frame ' + k);
      assert.ok(d.r + d.g + d.b >= 1.5, 'not near black at frame ' + k);
      assert.ok(d.a >= (k === 17 ? 0.05 : 0.4) && d.a <= 1, 'alpha ' + d.a + ' at frame ' + k);
    }
  }
});

test('tether colour is teal-white all the way, with no fire or white-flash fade', () => {
  for (let t = 0; t < TRIALS; t++) {
    const s = run(18);
    for (let k = 0; k <= 17; k++) for (const d of s[k]) {
      assert.ok(d.g >= 0.9 && d.b >= 0.9, 'teal-white (g,b high) at frame ' + k + ': ' + [d.r, d.g, d.b]);
      assert.ok(d.r <= 0.7, 'red stays low (not fire/white) at frame ' + k + ': ' + d.r);
    }
  }
});

test('tether dots fly in straight lines (no gravity)', () => {
  for (let t = 0; t < TRIALS; t++) {
    const s = run(18);
    for (let i = 0; i < 10; i++) {
      const a1 = Math.atan2(s[4][i].y - OY, s[4][i].x - OX), a2 = Math.atan2(s[17][i].y - OY, s[17][i].x - OX);
      const dv = Math.abs(Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1)));
      assert.ok(dv < 0.03, 'dot ' + i + ' bent by ' + dv + ' rad');
    }
  }
});
