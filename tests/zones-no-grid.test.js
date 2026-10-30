import test from 'node:test';
import assert from 'node:assert/strict';
import { zonesLayer } from '../games/starfall/render/zones.js';

// a regular grid of dim dots renders as shaded balls on a 2x screen. Fail if any zone draws one again.
test('no zone draws a grid of dim dots: at most 12 dim dots (alpha < 0.12) share one y', () => {
  for (const zone of [1, 2, 3]) {
    for (const F of [0, 37, 100, 555]) {
      const rows = new Map();
      const R = { ui: { F: F + zone * 1000 }, dot(x, y, s, r, g, b, a) { if (a < 0.12) { const key = Math.round(y * 2) / 2; rows.set(key, (rows.get(key) || 0) + 1); } } };
      zonesLayer.draw(R, { zone, warp: 0 });
      let worst = 0, at = 0;
      for (const [y, n] of rows) if (n > worst) { worst = n; at = y; }
      assert.ok(worst <= 12, `zone ${zone} frame ${F}: ${worst} dim dots share y=${at}`);
    }
  }
});
