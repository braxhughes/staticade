// Spline paths with curvature-eased speed, written into preallocated buffers.
import { atan2, hypot } from '../../engine/dmath.js';
import { W, H, PI, TAU, BONUS_CP_RAW } from './defs.js';

export const PATH_CAP = 160;
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export function angDiff(a, b) { let d = b - a; while (d > PI) d -= TAU; while (d < -PI) d += TAU; return d; }
export function cr(p0, p1, p2, p3, t) { const t2 = t * t, t3 = t2 * t; return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3); }

export function createPath() { return { p: new Float32Array(PATH_CAP * 2), L: new Float32Array(PATH_CAP), K: new Float32Array(PATH_CAP), len: 0, m: 0 }; }

// cp: flat array-like of control points [x0, y0, x1, y1, ...]
export function buildPath(path, cp) {
  const n = cp.length >> 1, p = path.p, L = path.L, K = path.K;
  let m = 0;
  for (let i = 0; i < n - 1; i++) {
    const a = i > 0 ? i - 1 : 0, d = i + 2 < n - 1 ? i + 2 : n - 1;
    for (let k = 0; k < 14; k++) {
      const t = k / 14;
      p[m * 2] = cr(cp[a * 2], cp[i * 2], cp[i * 2 + 2], cp[d * 2], t);
      p[m * 2 + 1] = cr(cp[a * 2 + 1], cp[i * 2 + 1], cp[i * 2 + 3], cp[d * 2 + 1], t);
      m++;
    }
  }
  p[m * 2] = cp[(n - 1) * 2]; p[m * 2 + 1] = cp[(n - 1) * 2 + 1]; m++;
  L[0] = 0;
  for (let i = 1; i < m; i++) L[i] = L[i - 1] + hypot(p[i * 2] - p[i * 2 - 2], p[i * 2 + 1] - p[i * 2 - 1]);
  for (let i = 0; i < m; i++) {
    if (i === 0 || i === m - 1) { K[i] = 1; continue; }
    const a1 = atan2(p[i * 2 + 1] - p[i * 2 - 1], p[i * 2] - p[i * 2 - 2]);
    const a2 = atan2(p[i * 2 + 3] - p[i * 2 + 1], p[i * 2 + 2] - p[i * 2]);
    const seg = (L[i + 1] - L[i - 1]) * 0.5 || 1;
    K[i] = clamp(1.2 / (1 + Math.abs(angDiff(a1, a2)) / seg * 10), 0.45, 1.2);
  }
  for (let pass = 0; pass < 4; pass++) for (let i = 1; i < m - 1; i++) K[i] = (K[i - 1] + K[i] * 2 + K[i + 1]) / 4;
  path.len = L[m - 1]; path.m = m;
  return path;
}

export const fit = cp => cp.map((v, i) => i % 2 ? v * H / 320 : (v < 0 ? v : v > 240 ? W + v - 240 : v * W / 240));
export const mirror = cp => cp.map((v, i) => i % 2 ? v : W - v);

const BCP = BONUS_CP_RAW.slice();
BCP[0] = fit(BCP[0]); BCP[2] = fit(BCP[2]); BCP[4] = fit(BCP[4]);
BCP[1] = mirror(BCP[0]); BCP[3] = mirror(BCP[2]);
export const BONUS_PATHS = BCP.map(cp => buildPath(createPath(), cp));
