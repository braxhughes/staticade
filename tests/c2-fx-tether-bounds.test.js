// w13-tests (V4 re-review MED-2 and LOW): the tether burst had a floor on its spread but no ceiling, and the dot
// size floor was 0.3 while the real size is 1.4. New file only. fx.js uses Math.random, so every check is a bound
// held over many bursts, not a stored value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFx } from '../games/starfall/fx.js';
import { EV_FX, FX_TETHER } from '../games/starfall/defs.js';

const OX = 250, OY = 160, TRIALS = 40;
function run(frames) {
  let cur = [];
  const fx = createFx((x, y, s, r, g, b, a) => cur.push({ x, y, s, r, g, b, a }));
  const ev = new Float64Array(10); ev[0] = EV_FX; ev[1] = FX_TETHER; ev[2] = OX; ev[3] = OY;
  assert.equal(fx.handle(ev, 0), true);
  const snaps = [];
  for (let f = 0; f <= frames; f++) { cur = []; fx.drawParticles(1); snaps.push(cur); fx.update(0, false); }
  return snaps;
}
const dist = d => Math.hypot(d.x - OX, d.y - OY);

test('tether spread has a ceiling: no dot is faster than about 2 units a frame, and none ends past 45 units', () => {
  let worst10 = 0, worst17 = 0, worst25 = 0;
  for (let t = 0; t < TRIALS; t++) {
    const s = run(26);
    for (const d of s[1]) assert.ok(dist(d) <= 2.6, 'after 1 frame a dot is at most 2.6 out, got ' + dist(d));
    for (const d of s[10]) { worst10 = Math.max(worst10, dist(d)); assert.ok(dist(d) <= 24, 'after 10 frames at most 24 out, got ' + dist(d)); }
    for (const d of s[17]) { worst17 = Math.max(worst17, dist(d)); assert.ok(dist(d) <= 38, 'after 17 frames at most 38 out, got ' + dist(d)); }
    for (const d of s[25] || []) { worst25 = Math.max(worst25, dist(d)); assert.ok(dist(d) <= 48, 'after 25 frames at most 48 out, got ' + dist(d)); }
  }
  assert.ok(worst17 > 20, 'the ring does reach out: ' + worst17.toFixed(1));
});

test('tether dot size is about 1.4 at the start and shrinks to half by the end', () => {
  for (let t = 0; t < TRIALS; t++) {
    const s = run(18);
    for (const d of s[0]) assert.ok(d.s >= 1.3 && d.s <= 1.5, 'size at birth near 1.4, got ' + d.s);
    for (const d of s[8]) assert.ok(d.s >= 0.9 && d.s <= 1.4, 'size at frame 8 between 0.9 and 1.4, got ' + d.s);
    for (const d of s[17]) assert.ok(d.s >= 0.65 && d.s <= 1.1, 'size late in life, got ' + d.s);
  }
});
