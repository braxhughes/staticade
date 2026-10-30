// the strict no-grid test misses (a) tilted lattices (20-30 degrees: no two
// dots share an x or a y), (b) grids drawn only at warp 0.1-0.4 and (c) grids drawn only during PYRE phase 3, because it
// samples warp 0 / 0.5 / 1 and never passes a boss. New file only; the strict test is untouched.
// Rule 1 (axis grids): the strict test's buckets, over warp 0.1..0.9 and with PYRE phase 3 on the Z3 sky.
// Rule 2 (tilted lattices): count how often one non-axis difference vector (0.05 units wide, 3x3 neighbours merged) repeats
// between dim dots (alpha <= 0.2) in a frame. A lattice repeats its basic vector once per row of dots; today's skies peak at
// 17 (measured over every zone, warp and PYRE phase 3), the limit is 35. Out of scope: lattices with jitter; alpha above 0.2.
import test from 'node:test';
import assert from 'node:assert/strict';
import { zonesLayer } from '../games/starfall/render/zones.js';

const WARPS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const PYRE3 = { on: true, id: 'pyre', phase: 3 }, NOBOSS = { on: false };
const Y_DIM = 14, X_DIM_WARP = 22, BIG_MAX = 3, LATTICE_MAX = 35;

function axisSweep(zone, warp, boss, frames) {
  const sim = { zone, warp, boss };
  const my = new Map(), mx = new Map(), by = new Map(), bx = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const R = { ui: { F: 0 }, dot(x, y, s, r, g, b, a) {
    if (s >= 8) { bump(by, Math.round(y * 4)); bump(bx, Math.round(x * 4)); } else if (a <= 0.2) { bump(my, Math.round(y * 4)); bump(mx, Math.round(x * 4)); }
  } };
  const top = m => { let w = 0; for (const n of m.values()) if (n > w) w = n; return w; };
  const worst = { y: 0, x: 0, by: 0, bx: 0 };
  for (let F = 0; F < frames; F++) {
    my.clear(); mx.clear(); by.clear(); bx.clear(); R.ui.F = F; zonesLayer.draw(R, sim);
    worst.y = Math.max(worst.y, top(my)); worst.x = Math.max(worst.x, top(mx)); worst.by = Math.max(worst.by, top(by)); worst.bx = Math.max(worst.bx, top(bx));
  }
  return worst;
}
function checkAxis(zone, warp, boss, frames = 300) {
  const w = axisSweep(zone, warp, boss, frames);
  assert.ok(w.y <= Y_DIM, `zone ${zone} warp ${warp}: ${w.y} dim dots share one y`);
  assert.ok(w.x <= X_DIM_WARP, `zone ${zone} warp ${warp}: ${w.x} dim dots share one x`);
  assert.ok(w.by <= BIG_MAX && w.bx <= BIG_MAX, `zone ${zone} warp ${warp}: big dots share a row or column (${w.by}, ${w.bx})`);
}

// ---------- (b) and (c): axis grids at in-between warps and in PYRE phase 3 ----------
for (const zone of [1, 2, 3]) {
  test(`no axis grid in zone ${zone} at warp 0.1 to 0.9 (nine values)`, () => { for (const warp of WARPS) checkAxis(zone, warp, NOBOSS); });
}
test('no axis grid in PYRE phase 3 (zone 3 sky, reversed stars) at warp 0, 0.1 to 0.9 and 1', () => {
  for (const warp of [0, ...WARPS, 1]) checkAxis(3, warp, PYRE3);
  // the boss hook really flips the sky: phase 3 draws different dots than phase 2
  const grab = boss => { const d = []; zonesLayer.draw({ ui: { F: 500 }, dot: (x, y) => d.push(x + ',' + y) }, { zone: 3, warp: 0, boss }); return d.join(';'); };
  assert.notEqual(grab(PYRE3), grab({ on: true, id: 'pyre', phase: 2 }), 'PYRE phase 3 is a different draw');
});

// ---------- (a) tilted lattices ----------
const Q = 0.05, K = (ix, iy) => (ix + 4000) * 10000 + (iy + 4000);
function latticeScore(dots, maxLen = 40) {
  const m = new Map(), n = dots.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    let dx = dots[j][0] - dots[i][0], dy = dots[j][1] - dots[i][1];
    if (Math.abs(dx) < 0.3 || Math.abs(dy) < 0.3 || Math.abs(dx) > maxLen || Math.abs(dy) > maxLen) continue; // axis pairs belong to rule 1
    if (dx < 0) { dx = -dx; dy = -dy; }
    const k = K(Math.round(dx / Q), Math.round(dy / Q));
    m.set(k, (m.get(k) || 0) + 1);
  }
  let best = 0;
  for (const k of m.keys()) {
    const ix = Math.floor(k / 10000) - 4000, iy = (k % 10000) - 4000;
    let s = 0; for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) s += m.get(K(ix + a, iy + b)) || 0;
    if (s > best) best = s;
  }
  return best;
}
function latticeWorst(zone, warp, boss) {
  const sim = { zone, warp, boss };
  let worst = 0;
  for (const F of [0, 19, 61, 140, 333, 777]) {
    const dots = [];
    zonesLayer.draw({ ui: { F }, dot(x, y, s, r, g, b, a) { if (a <= 0.2) dots.push([x, y]); } }, sim);
    worst = Math.max(worst, latticeScore(dots));
  }
  return worst;
}
for (const zone of [1, 2, 3]) {
  test(`no tilted lattice of dim dots in zone ${zone} (warp 0, 0.1, 0.5, 0.9, 1; zone 3 also in PYRE phase 3)`, (t) => {
    let worst = 0;
    for (const warp of [0, 0.1, 0.5, 0.9, 1]) for (const boss of zone === 3 ? [NOBOSS, PYRE3] : [NOBOSS]) {
      const w = latticeWorst(zone, warp, boss); worst = Math.max(worst, w);
      assert.ok(w <= LATTICE_MAX, `zone ${zone} warp ${warp}${boss.on ? ' PYRE3' : ''}: one vector repeats ${w} times (limit ${LATTICE_MAX})`);
    }
    t.diagnostic(`zone ${zone}: worst repeat count ${worst} (limit ${LATTICE_MAX})`);
  });
}
test('the lattice counter itself: a 20 to 30 degree rotated grid of 8 x 8 dots scores far above the limit, random dots do not', () => {
  const rot = (deg, sp, n) => { const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180), out = []; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push([100 + (i * c - j * s) * sp, 100 + (i * s + j * c) * sp]); return out; };
  for (const deg of [20, 25, 30]) assert.ok(latticeScore(rot(deg, 12, 8)) >= 56, `${deg} degrees`);
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const noise = []; for (let i = 0; i < 300; i++) noise.push([rnd() * 400, rnd() * 300]);
  assert.ok(latticeScore(noise) < LATTICE_MAX);
});
