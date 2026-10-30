// Zone skies (design B.3): palette, a star field with its own motion per zone, and the bullet halo color.
// Draw layer only. Reads the sim, never writes it. Cosmetic: may use Math.sin and a local LCG; nothing here
// touches the seeded RNG. Star positions are closed-form in the frame counter, so there is no per-frame state
// to allocate or advance (typed arrays are built once at load).
import { W, H, CX, TAU } from '../defs.js';
import { registerInfo } from '../hooks.js';
import { FRAMES_PER_BEAT } from '../music.js';

// B.3 table, RGB 0..1
export const ZONES = [
  null,
  { name: 'Lantern Reach', base: [0.04, 0.025, 0.01], a1: [1, 0.7, 0.25], a2: [1, 0.88, 0.4], a3: [1, 0.95, 0.85], halo: [1, 0.3, 0.6] },
  { name: 'Glass Tide', base: [0.0, 0.035, 0.05], a1: [0.25, 0.95, 0.9], a2: [0.6, 0.4, 1], a3: [0.8, 0.95, 1], halo: [1, 0.55, 0.3] },
  { name: 'Hollow Sun', base: [0.05, 0.0, 0.015], a1: [0.95, 0.15, 0.25], a2: [1, 0.5, 0.65], a3: [1, 0.85, 0.3], halo: [0.6, 1, 1] }
];
// enemy bullet halo color for a zone (out-of-range zones fall back to Z1)
export const haloOf = z => (ZONES[z] || ZONES[1]).halo;

// ---- star tables, built once ----
let seed = 12345;
const lcg = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
const N1 = 140, N2 = 120, N3 = 160;
function field(n) {
  const x = new Float32Array(n), y = new Float32Array(n), ph = new Float32Array(n), sz = new Float32Array(n);
  for (let i = 0; i < n; i++) { x[i] = lcg() * W; y[i] = lcg() * H; ph[i] = lcg() * TAU; sz[i] = 0.7 + lcg() * 0.5; }
  return { x, y, ph, sz };
}
const F1 = field(N1), F2 = field(N2), F3 = field(N3);
const SPD1 = [0.3, 0.6, 0.9], SPD3 = [1.2, 1.8, 2.4];
const wrap = (v, m) => { v %= m; return v < 0 ? v + m : v; };

// ---- zone change: the sky cross-fades over FADE frames; `cur` is the zone shown, `prev` the one fading out ----
const FADE = 45;
let cur = 0, prev = 0, fadeT = FADE, lastF = -1, lastSim = null;

// ---- per-zone star fields: dot(x, y, size, r, g, b, a); `k` scales alpha (cross-fade), warp streaks the stars ----
function stars1(dot, F, warp, k, P) {
  const c = P.a2, w = P.a3;
  for (let i = 0; i < N1; i++) {
    const L = i % 3, v = SPD1[L], y = wrap(F1.y[i] + F * v, H);
    // slow gold twinkle: the far layer twinkles deepest
    const tw = 0.65 + 0.35 * Math.sin(F * 0.04 + F1.ph[i]);
    const a = (0.3 + L * 0.1) * tw * k;
    dot(F1.x[i], y, F1.sz[i] * (0.8 + L * 0.15), L === 2 ? w[0] : c[0], L === 2 ? w[1] : c[1], L === 2 ? w[2] : c[2], a);
    if (warp > 0.05) for (let j = 1; j <= 4; j++) dot(F1.x[i], y - j * warp * v * 7, 0.7, c[0], c[1], c[2], a * (1 - j / 5) * warp);
  }
}
function stars2(dot, F, warp, k, P) {
  const sway = Math.sin(F * 0.01) * 6, tl = P.a1, vi = P.a2, ice = P.a3;
  // three faint caustic bands that ripple (teal light sliding across the glass)
  for (let b = 0; b < 3; b++) {
    const by = 70 + b * 80 + Math.sin(F * 0.012 + b * 2.1) * 12;
    for (let x = 0; x <= W; x += 5) {
      const y = by + Math.sin(x * 0.045 + F * 0.035 + b * 1.7) * 6 + Math.sin(x * 0.11 - F * 0.02) * 2;
      dot(x, y, 1.6, tl[0], tl[1], tl[2], 0.2 * k);
      dot(x, y + 3, 1.0, vi[0], vi[1], vi[2], 0.3 * k);
    }
  }
  for (let i = 0; i < N2; i++) {
    const L = i % 3, vx = -(0.12 + L * 0.1), vy = 0.25 + L * 0.2;
    const x = wrap(F2.x[i] + F * vx, W) + sway, y = wrap(F2.y[i] + F * vy, H);
    const a = (0.3 + L * 0.1) * k;
    const c = L === 1 ? vi : L === 2 ? ice : tl;
    dot(x, y, F2.sz[i] * (0.8 + L * 0.15), c[0], c[1], c[2], a);
    if (warp > 0.05) for (let j = 1; j <= 4; j++) dot(x, y - j * warp * vy * 8, 0.7, c[0], c[1], c[2], a * (1 - j / 5) * warp);
  }
}
const BEAT = FRAMES_PER_BEAT.z3; // Z3 is 180 BPM: one beat every 20 frames (B.8); cosmetic, the sim has no beat counter
// B.6: the Z3 star field runs in reverse during PYRE's phase 3 (cosmetic cue); 1 = normal, -1 = reversed
export const z3Dir = sim => sim.boss && sim.boss.on && sim.boss.id === 'pyre' && sim.boss.phase === 3 ? -1 : 1;
let dir3 = 1;
function stars3(dot, F, warp, k, P) {
  const cr = P.a1, rose = P.a2, gold = P.a3;
  // hollow sun: a ring (radius 70) low on the horizon, flaring on each beat
  const bt = F % BEAT, pulse = Math.exp(-bt * 0.14), r = 70 + pulse * 5, sy = H + 45; // ring top at y 275: below the ship band
  for (let i = 0; i < 96; i++) {
    const q = i / 96 * TAU, x = CX + Math.cos(q) * r, y = sy + Math.sin(q) * r;
    if (y > H + 4) continue;
    dot(x, y, 1.5, gold[0], gold[1], gold[2], (0.25 + 0.25 * pulse) * k);
    dot(x, y, 3.2, cr[0], cr[1], cr[2], (0.08 + 0.1 * pulse) * k);
  }
  for (let i = 0; i < N3; i++) {
    const L = i % 3, v = SPD3[L] * dir3, y = wrap(F3.y[i] + F * v, H);
    const a = (0.3 + L * 0.1) * k, c = L === 0 ? rose : L === 1 ? cr : gold;
    // short streak so the fast field reads as a stream, not as drifting points
    dot(F3.x[i], y, F3.sz[i] * (0.8 + L * 0.15), c[0], c[1], c[2], a);
    dot(F3.x[i], y - v * 2.2, 0.7, c[0], c[1], c[2], a * 0.5);
    dot(F3.x[i], y - v * 4.4, 0.5, c[0], c[1], c[2], a * 0.25);
    if (warp > 0.05) for (let j = 1; j <= 4; j++) dot(F3.x[i], y - v * 4.4 - j * warp * v * 6, 0.7, c[0], c[1], c[2], a * (1 - j / 5) * warp);
  }
}

// Sky base is the canvas's black, as in v1 (B.3). A full-screen wash of large dim dots was tried and removed:
// each dot renders as a soft ball, and at near-black levels the 8-bit steps showed the whole grid as shaded balls.
// The zone 3 heat-shimmer grid (rows of dim dots) was removed for the same reason.
// Each zone's color comes from its star field.
function drawZone(dot, z, F, warp, k) {
  const P = ZONES[z];
  (z === 1 ? stars1 : z === 2 ? stars2 : stars3)(dot, F, warp, k, P);
}

export const zonesLayer = {
  id: 'zones',
  draw(R, sim) {
    const z = sim.zone >= 1 && sim.zone <= 3 ? sim.zone : 1, F = R.ui.F, dot = R.dot;
    dir3 = z3Dir(sim);
    // advance the cross-fade once per rendered frame
    if (sim !== lastSim) { lastSim = sim; cur = z; prev = 0; fadeT = FADE; } // a new run starts on its own sky
    if (F !== lastF) {
      lastF = F;
      if (z !== cur) { prev = cur; cur = z; fadeT = prev ? 0 : FADE; }
      else if (fadeT < FADE) fadeT++;
    }
    if (fadeT >= FADE) drawZone(dot, cur, F, sim.warp, 1);
    else { const t = fadeT / FADE; drawZone(dot, prev, F, sim.warp, 1 - t); drawZone(dot, cur, F, sim.warp, t); }
  }
};

// test hook: SF.info().sky = { zone shown, fading }
registerInfo(() => ({ sky: { zone: cur, fading: fadeT < FADE } }));
