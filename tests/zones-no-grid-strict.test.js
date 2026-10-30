// Strict no-grid guard (w8-tests): the first no-grid test only looks at dots with alpha < 0.12 and 12 per row,
// so a grid at alpha 0.12 to 0.2, a big-dot wash, a spaced or rotated grid, wobbled rows, or a grid drawn on some
// frames got past it (cold review of w8-z3-shimmer).
// Rule, applied to EVERY frame of 2,000 per zone and warp (0, 0.5, 1):
//   - "big" dots (size >= 8, the old size-36 wash): at most 3 share a y bucket and at most 3 share an x bucket.
//   - "dim" dots (alpha <= 0.2, size < 8): at most 14 share a y bucket (0.25 units wide); at most 8 share an
//     x bucket at warp 0 (22 with warp, where one star's streak shares an x).
//   - warp 0 only, loose check: at most 45 dim dots inside any 3-unit y window (catches rows wobbling per dot).
// Measured on today's content (2,000 frames, worst case): dim same-y 11, dim same-x 5 (warp 0) / 16 (warp), big dots 0,
// dim 3-unit window 30 at warp 0.
// Out of scope: cross-fades (zone change). A cross-fade draws two skies at once, so a cross-fade-aware rule
// would falsely fail (caustics reach 15 to 17 per row mid-fade). Grids brighter than alpha 0.2 are also out of scope.
import test from 'node:test';
import assert from 'node:assert/strict';
import { zonesLayer } from '../games/starfall/render/zones.js';

const FRAMES = 2000;
const Y_DIM = 14, X_DIM_0 = 8, X_DIM_WARP = 22, BIG_MAX = 3, WIN_MAX = 45;

function sweep(zone, warp) {
  const sim = { zone, warp };   // a fresh sim object: a new run starts on its own sky, no cross-fade
  let my = new Map(), mx = new Map(), by = new Map(), bx = new Map(), ys = [];
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const R = { ui: { F: 0 }, dot(x, y, s, r, g, b, a) {
    if (s >= 8) { bump(by, Math.round(y * 4)); bump(bx, Math.round(x * 4)); }
    else if (a <= 0.2) { bump(my, Math.round(y * 4)); bump(mx, Math.round(x * 4)); ys.push(y); }
  } };
  const worst = { y: 0, x: 0, by: 0, bx: 0, win: 0, at: 0 };
  const top = m => { let w = 0; for (const n of m.values()) if (n > w) w = n; return w; };
  for (let F = 0; F < FRAMES; F++) {
    my.clear(); mx.clear(); by.clear(); bx.clear(); ys.length = 0;
    R.ui.F = F; zonesLayer.draw(R, sim);
    const y = top(my), x = top(mx);
    if (y > worst.y) { worst.y = y; worst.at = F; }
    worst.x = Math.max(worst.x, x); worst.by = Math.max(worst.by, top(by)); worst.bx = Math.max(worst.bx, top(bx));
    if (warp === 0) {   // sliding 3-unit y window
      ys.sort((p, q) => p - q);
      let j = 0; for (let i = 0; i < ys.length; i++) { while (ys[i] - ys[j] > 3) j++; if (i - j + 1 > worst.win) worst.win = i - j + 1; }
    }
  }
  return worst;
}

for (const zone of [1, 2, 3]) for (const warp of [0, 0.5, 1]) {
  test(`strict no-grid: zone ${zone} warp ${warp} over ${FRAMES} frames`, () => {
    const w = sweep(zone, warp);
    console.log(`  strict no-grid zone ${zone} warp ${warp}: worst same-y ${w.y}/${Y_DIM}, same-x ${w.x}/${warp === 0 ? X_DIM_0 : X_DIM_WARP}, big same-y ${w.by} same-x ${w.bx} (max ${BIG_MAX})${warp === 0 ? `, 3-unit window ${w.win}/${WIN_MAX}` : ''}`);
    assert.ok(w.y <= Y_DIM, `${w.y} dim dots share one y (frame ${w.at})`);
    assert.ok(w.x <= (warp === 0 ? X_DIM_0 : X_DIM_WARP), `${w.x} dim dots share one x`);
    assert.ok(w.by <= BIG_MAX, `${w.by} big dots share one y`);
    assert.ok(w.bx <= BIG_MAX, `${w.bx} big dots share one x`);
    if (warp === 0) assert.ok(w.win <= WIN_MAX, `${w.win} dim dots inside a 3-unit y window`);
  });
}
