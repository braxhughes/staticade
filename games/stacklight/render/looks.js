// STACKLIGHT looks. Look 0 is the shipped look; SL.look(n) switches for comparison (test-only, never stored).
// Render only: reads the sim and the fx state, never writes them, and holds no state a replay could see.
//   0 LIVING FIELD + SWEEP (shipped)  a slow field of rising light fills the sides; its colour follows the level, it surges
//                   with GLOW and a clear sends a ripple through it; the well and HUD panels take the same colour; each clear
//                   fires a laser sweep out from the well to the screen edges, broken around every string on screen
//   1 SOLID LIGHT   the stack is a solid lit mass: tiles, a glowing rim on every open edge, deeper rows sink into shadow
//   2 CLASSIC       the earlier shipped look (render.js alone, never calls in here)
//   3 HYBRID        look 1's lit stack on look 0's field, with the sweep
// (the full LIGHTSHOW and plain LIVING FIELD without the sweep are no longer reachable.)
// Text keep-out: render.js records a box around every string it draws this frame (tb, in fifths of a unit), and the field and
// the sweep are drawn after all text and skip any dot that would come within 1.5 units of a box. Dots add light (additive
// blend), so nothing can be drawn "under" text: keeping out is the only way the words stay clean.
// No allocation per frame, in any V8 tier. The field, the keep-out and the sweep work in integers only (quarter units, alpha
// in 1/256, angles as sine-table steps), so no double is ever made; a double made in code V8 has not fully optimised is a heap
// number (a heap profile: a 720-speck loop in doubles stayed in a middle tier and cost 600 B a frame). Every value
// passed to dot is a literal, a small integer, or read from a tagged table built here (a plain array that also held null, so
// its numbers are heap numbers already and passing one boxes nothing).
import { COLS, TOTAL_ROWS } from '../defs.js';
import { sin as dsin, TAU } from '../../../engine/dmath.js';
import { FLASH, FADE } from './fx.js';
import { W, H, BX0, BX1, BY_FLOOR, BY_CEIL, BY_TOP, CX, colX, rowY, C_BAR, C_PLUS, C_STEEL, C_WHITE } from './geom.js';

export const LOOK_N = 4;
export const LOOK_NAMES = ['LIVING FIELD + SWEEP', 'SOLID LIGHT', 'CLASSIC', 'HYBRID'];

const rgb = (r, g, b) => { const c = [null, null, null]; c[0] = r; c[1] = g; c[2] = b; return c; };
const tagged = n => new Array(n).fill(null);

// look 1: RIDGE and SHADE turn from grey to a cool slate, so a test start or a Daily ridge reads as part of the light
const SLATE = rgb(0.42, 0.5, 0.95);
const L1COL = [C_WHITE, C_BAR, C_PLUS, SLATE, SLATE];

// the field: one palette (main, accent) per two levels; the field eases from one to the next
const PAL = [
  [0.25, 1, 0.6, 0.75, 1, 0.5],     // 1-2 jade
  [0.2, 0.85, 1, 0.6, 1, 0.9],      // 3-4 sea
  [0.35, 0.5, 1, 0.45, 0.95, 1],    // 5-6 deep blue
  [0.7, 0.4, 1, 1, 0.55, 0.9],      // 7-8 violet
  [1, 0.35, 0.6, 1, 0.75, 0.45],    // 9-10 rose
  [1, 0.55, 0.2, 1, 0.92, 0.45]     // 11+ ember
];
const NP = PAL.length, PSTEPS = 64; // a palette change eases over 64 rendered frames
const NM = 720; // specks in the field
// speck sizes (none is 1.4, 2.4, 3.1 or 3.3: the sizes tests use to find GLOW ring and cell dots)
const SIZES = [0.9, 1.05, 1.25, 1.6, 2.0, 2.6, 3.2];
// positions in quarter units: index 0 is -16 (x and y), so x index = (x + 16) * 4
const QX0 = -16, QXN = (W + 32) * 4 + 1, QY0 = -16, QYN = (H + 32) * 4 + 1, AN = 257; // alpha in 1/256 steps, 0 to 1
const X4L = (0 - QX0) * 4, X4R = (W - QX0) * 4, Y4T = (0 - QY0) * 4, Y4B = (H - QY0) * 4; // the field's edges as indices
const H4 = H * 4, SN = 1024; // the rise wraps every 300 units; sine table steps per turn
const FM = 0x3ffff; // the clock is taken mod 2^18 frames (73 minutes) so every product below stays a small integer

// hud (from render.js): the HUD frame, k corner brackets and d dividers as tagged x, y pairs, and box the two panels in
// fifths of a unit (x0, y0, x1, y1 each), so the HUD grid lives in one place (render.js)
export function createLooks({ dot, text, T, tb, tbN, hud }) {
  // ---------- tables (built once) ----------
  const XQ = tagged(QXN), YQ = tagged(QYN), AQ = tagged(AN), SZ = tagged(SIZES.length), BIG = tagged(SIZES.length);
  for (let i = 0; i < QXN; i++) XQ[i] = QX0 + i / 4;
  for (let i = 0; i < QYN; i++) YQ[i] = QY0 + i / 4;
  for (let i = 0; i < AN; i++) AQ[i] = i / 256;
  for (let i = 0; i < SIZES.length; i++) { SZ[i] = SIZES[i]; BIG[i] = 12 + SIZES[i] * 3; }
  // sway (+-4 units, in quarter units) and twinkle (+-0.11 alpha, in 1/256) per sine-table step
  const SW = new Int8Array(SN), TW = new Int8Array(SN);
  for (let i = 0; i < SN; i++) { const s = dsin(i / SN * TAU); SW[i] = Math.round(s * 16); TW[i] = Math.round(s * 0.11 * 256); }
  // 65536 / d, for the ripple's push along the line from its centre (d in quarter units)
  const INV = new Int32Array(4097);
  for (let d = 1; d <= 4096; d++) INV[d] = Math.floor(65536 / d);
  // keep-out pads in fifths of a unit: the dot's radius plus 1.5
  const PAD = new Int32Array(SIZES.length), PADB = new Int32Array(SIZES.length);
  for (let i = 0; i < SIZES.length; i++) { PAD[i] = Math.ceil((SIZES[i] / 2 + 1.5) * 5); PADB[i] = Math.ceil(((12 + SIZES[i] * 3) / 2 + 1.5) * 5); }
  const P17 = Math.ceil((1.7 / 2 + 1.5) * 5), P12 = Math.ceil((1.2 / 2 + 1.5) * 5), P120 = Math.ceil((12 / 2 + 1.5) * 5);
  // palette blends: index ((from * NP + to) * (PSTEPS + 1) + step) * 6, main rgb then accent rgb
  const PALT = tagged(NP * NP * (PSTEPS + 1) * 6);
  for (let a = 0; a < NP; a++) for (let b = 0; b < NP; b++) for (let s = 0; s <= PSTEPS; s++) {
    const o = ((a * NP + b) * (PSTEPS + 1) + s) * 6, k = s / PSTEPS, e = k * k * (3 - 2 * k);
    for (let j = 0; j < 6; j++) PALT[o + j] = PAL[a][j] + (PAL[b][j] - PAL[a][j]) * e;
  }
  const WARN = rgb(1, 0.45, 0.4);

  // the specks, fixed: x and y at rest (quarter-unit indices), rise speed per GLOW step (1/1024 quarter units a frame),
  // the two phases (sine-table steps) and a size index. acc: how far each has risen (render state, 1/1024 quarter units).
  const mx = new Int32Array(NM), my = new Int32Array(NM), spd = new Int32Array(5 * NM), mp1 = new Int32Array(NM), mp3 = new Int32Array(NM);
  const msi = new Uint8Array(NM), acc = new Int32Array(NM);
  {
    let s = 0x2f6b1;
    const lcg = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    for (let i = 0; i < NM; i++) {
      mx[i] = Math.round((lcg() * W - QX0) * 4); my[i] = Math.round(lcg() * H * 4);
      const sp = 0.5 + lcg();
      for (let g = 0; g <= 4; g++) spd[g * NM + i] = Math.round((0.1 + 0.07 * g) * sp * 4 * 1024);
      const ph = lcg(); mp1[i] = Math.floor(ph * SN); mp3[i] = Math.floor(ph * 3 * SN) & (SN - 1);
      const sz = 0.9 + lcg() * lcg() * 2.4;
      let best = 0; for (let j = 1; j < SIZES.length; j++) if (Math.abs(SIZES[j] - sz) < Math.abs(SIZES[best] - sz)) best = j;
      msi[i] = best;
    }
  }

  // the frame: x, y pairs (FW walls and floor, FH wall halo, FS spawn-zone sides, FC ceiling, FK the cell sockets), and per
  // GLOW step the wall alpha (FA), the halo alpha (FHA), the HUD bracket alpha (BA) and divider alpha (DA)
  const xl = BX0 - 3, xr = BX1 + 3, yb = BY_FLOOR + 3;
  const pairs = [[], [], [], [], []];
  for (let y = BY_CEIL; y <= yb; y += 3) pairs[0].push(xl, y, xr, y);
  for (let x = xl; x <= xr; x += 3) pairs[0].push(x, yb);
  for (let y = BY_CEIL + 4; y <= yb; y += 8) pairs[1].push(xl - 2, y, xr + 2, y);
  for (let y = BY_TOP; y < BY_CEIL; y += 4) pairs[2].push(xl, y, xr, y);
  for (let x = xl; x <= xr; x += 4) pairs[3].push(x, BY_CEIL);
  for (let r = 0; r < 18; r++) for (let c = 0; c < COLS; c++) pairs[4].push(colX(c), rowY(r));
  const [FW, FH, FS, FC, FK] = pairs.map(p => { const t = tagged(p.length); for (let i = 0; i < p.length; i++) t[i] = p[i]; return t; });
  const BK = hud.k, BD = hud.d, HB = hud.box; // the HUD frame from render.js (was three brackets built here)
  const FA = tagged(5), FHA = tagged(5), BA = tagged(5), DA = tagged(5);
  for (let g = 0; g <= 4; g++) { FA[g] = 0.45 + g * 0.12; FHA[g] = 0.035 + g * 0.02; BA[g] = 0.5 + 0.08 * g; DA[g] = 0.22 + 0.04 * g; }

  // ---------- state (render only) ----------
  let pFrom = 0, pTo = 0, pStep = PSTEPS, pSim = null, pc = 0; // pc: the PALT offset for this frame
  let lastF = -1;

  function palFor(level) { const p = (level - 1) >> 1; return p < 0 ? 0 : p > NP - 1 ? NP - 1 : p; }
  function sync(sim) {
    const p = sim ? palFor(sim.level) : 0;
    if (sim !== pSim) { pSim = sim; pFrom = p; pTo = p; pStep = PSTEPS; } // a new run (or the title) starts on its own colour
    else if (p !== pTo) { if (pStep >= PSTEPS / 2) pFrom = pTo; pTo = p; pStep = 0; }
    else if (pStep < PSTEPS) pStep++;
    pc = ((pFrom * NP + pTo) * (PSTEPS + 1) + pStep) * 6;
  }

  // ---------- the text keep-out ----------
  // true when a dot centred at (x5, y5), in fifths of a unit, comes within p5 of any string drawn this frame
  function onText(x5, y5, p5) {
    const n = tbN[0];
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (x5 > tb[o] - p5 && x5 < tb[o + 2] + p5 && y5 > tb[o + 1] - p5 && y5 < tb[o + 3] + p5) return true;
    }
    return false;
  }

  // ---------- the field ----------
  // F: the frame clock (an integer: the sim frame in a run, the title's frame count); g: GLOW (0 to 4); S: the run's fx state
  // (null on the title) for the clear ripple; inWell: 1 on the title (no well to keep dark)
  function field2(F, g, S, inWell) {
    let dF = F - lastF; if (dF < 0 || dF > 4) dF = 1; // a new clock (title to run) moves on one frame
    lastF = F;
    const Fm = F & FM, s1 = (Fm * 459) >> 8, s3 = (Fm * 1877) >> 8; // 0.011 and 0.045 radians a frame, in table steps
    const br = 256 + 102 * g, so = g * NM;                          // GLOW: brighter (1 + 0.4 g) and faster
    let ca = 999, cy4 = 0, R4 = 0, fade = 0;
    if (S !== null && S.clearMask !== 0) {
      ca = F - S.clearF;
      if (ca >= 0 && ca < 80) { let low = 0; while (low < 21 && !((S.clearMask >> low) & 1)) low++; cy4 = (BY_FLOOR - low * 13 - QY0) * 4 - 26; R4 = ca * 22; fade = ((80 - ca) * 819) >> 8; }
      else ca = 999;
    }
    const pa = pc, pb = pc + 3;
    for (let i = 0; i < NM; i++) {
      let r = acc[i] + spd[so + i] * dF; if (r >= H4 * 1024) r -= H4 * 1024;
      acc[i] = r;
      let y4 = my[i] - (r >> 10); if (y4 < 0) y4 += H4;
      y4 += Y4T;
      let x4 = mx[i] + SW[(s1 + mp1[i]) & (SN - 1)];
      if (inWell === 0 && x4 > (131 - QX0) * 4 && x4 < (269 - QX0) * 4) continue; // the well is dark glass, top to bottom
      let a = ((44 + TW[(s3 + mp3[i]) & (SN - 1)]) * br) >> 8;
      if (ca !== 999) { // the clear ripple: a ring of light running out from the cleared row, pushing the specks it passes
        const dx = x4 - (CX - QX0) * 4, dy = y4 - cy4, ax = dx < 0 ? -dx : dx, ay = dy < 0 ? -dy : dy;
        const mxd = ax > ay ? ax : ay, mnd = ax > ay ? ay : ax, est = (mxd * 983 + mnd * 407) >> 10, d = est > mxd ? est : mxd; // |(dx, dy)| within 4%
        const e = d - R4, ae = e < 0 ? -e : e;
        if (ae < 64) {
          const k = ((256 - ae * 4) * fade) >> 8, iv = d <= 4096 ? INV[d] : 0;
          a += (141 * k) >> 8;
          x4 += (((dx * 24 * k) >> 8) * iv) >> 16; y4 += (((dy * 24 * k) >> 8) * iv) >> 16;
        }
      }
      if (x4 < X4L || x4 > X4R || y4 < Y4T || y4 >= Y4B) continue; // inside the 400 x 300 field only
      const x5 = ((x4 + QX0 * 4) * 5) >> 2, y5 = ((y4 + QY0 * 4) * 5) >> 2;
      // dimmer inside the HUD panels
      if (inWell === 0 && ((x5 > HB[0] && x5 < HB[2] && y5 > HB[1] && y5 < HB[3]) || (x5 > HB[4] && x5 < HB[6] && y5 > HB[5] && y5 < HB[7]))) a = (a * 77) >> 8;
      const si = msi[i];
      if (onText(x5, y5, PAD[si])) continue;
      if (a > 256) a = 256;
      const P = (i & 3) === 0 ? pb : pa;
      dot(XQ[x4], YQ[y4], SZ[si], PALT[P], PALT[P + 1], PALT[P + 2], AQ[a]);
      if (i % 23 === 0 && !onText(x5, y5, PADB[si])) dot(XQ[x4], YQ[y4], BIG[si], PALT[P], PALT[P + 1], PALT[P + 2], AQ[(8 * br) >> 8]); // a few big soft lights
    }
  }
  function frame2(g, warn) {
    const r = PALT[pc], gg = PALT[pc + 1], b = PALT[pc + 2], a = FA[g], ha = FHA[g];
    for (let i = 0; i < FW.length; i += 2) dot(FW[i], FW[i + 1], 1.2, r, gg, b, a);
    for (let i = 0; i < FH.length; i += 2) dot(FH[i], FH[i + 1], 6, r, gg, b, ha); // a soft halo on the walls, stronger with GLOW
    for (let i = 0; i < FS.length; i += 2) dot(FS[i], FS[i + 1], 0.9, r, gg, b, 0.16);
    const cr = warn ? WARN[0] : PALT[pc + 3], cg = warn ? WARN[1] : PALT[pc + 4], cb = warn ? WARN[2] : PALT[pc + 5], ca = warn ? 0.45 : 0.25;
    for (let i = 0; i < FC.length; i += 2) dot(FC[i], FC[i + 1], 0.9, cr, cg, cb, ca);
    for (let i = 0; i < FK.length; i += 2) dot(FK[i], FK[i + 1], 1, r, gg, b, 0.06);
  }
  function hud2(g) { // the HUD panels: corner brackets and the dividers (built in render.js)
    const r = PALT[pc + 3], gg = PALT[pc + 4], b = PALT[pc + 5], a = BA[g], da = DA[g];
    for (let i = 0; i < BK.length; i += 2) dot(BK[i], BK[i + 1], 1, r, gg, b, a);
    for (let i = 0; i < BD.length; i += 2) dot(BD[i], BD[i + 1], 0.8, r, gg, b, da);
  }

  // ---------- the clear sweep (look 3) ----------
  // A white laser line with teal and amber edges flies out from the well to both screen edges in about 4 frames and fades
  // over the clear (28 frames). It starts outside the well walls (inside, the cleared rows already flash white) and breaks
  // around every string on screen. F: the sim frame (an integer).
  const SW_LIFE = FLASH + FADE + 8, SW_K = Math.round(256 * 1024 / SW_LIFE), SW_J0 = 26; // the first dot is 26 steps of 2.5 (65 units) out from the centre: past the wall halo
  function sweep3(S, F) {
    if (S.clearMask === 0) return;
    const ca = F - S.clearF;
    if (ca < 0 || ca >= SW_LIFE) return;
    const k = ((SW_LIFE - ca) * SW_K) >> 10, a0 = AQ[(230 * k) >> 8], a1 = AQ[(128 * k) >> 8], a2 = AQ[(31 * k) >> 8];
    const n = ca * 20 > 80 ? 80 : ca * 20, th4 = 4 + ((ca * 45) >> 5); // reach in steps (50 units a frame, half the field at most); edge offset 1 + 0.35 a frame
    const cx4 = (CX - QX0) * 4;
    for (let r = 0; r < 21; r++) {
      if (!((S.clearMask >> r) & 1)) continue;
      const y4 = (BY_FLOOR - r * 13 - QY0) * 4 - 26, yu = y4 - th4, yd = y4 + th4;
      if (yu < 0 || yd >= QYN) continue;
      const Y = YQ[y4], YU = YQ[yu], YD = YQ[yd], y5 = ((y4 + QY0 * 4) * 5) >> 2, yu5 = ((yu + QY0 * 4) * 5) >> 2, yd5 = ((yd + QY0 * 4) * 5) >> 2;
      for (let j = SW_J0; j <= n; j++) {
        for (let side = -1; side <= 1; side += 2) {
          const x4 = cx4 + side * j * 10, X = XQ[x4], x5 = ((x4 + QX0 * 4) * 5) >> 2;
          if (!onText(x5, y5, P17)) dot(X, Y, 1.7, 1, 1, 1, a0);
          if (!onText(x5, yu5, P12)) dot(X, YU, 1.2, C_BAR[0], C_BAR[1], C_BAR[2], a1);
          if (!onText(x5, yd5, P12)) dot(X, YD, 1.2, C_PLUS[0], C_PLUS[1], C_PLUS[2], a1);
          if ((j & 3) === 0 && !onText(x5, y5, P120)) dot(X, Y, 12, 0.8, 1, 0.9, a2); // a soft light every 10 units
        }
      }
    }
  }

  // ---------- look 1 (and 3): the stack as a solid lit mass ----------
  let ts = 1; // tile scale: 1 on the board, less for NEXT and the title pieces (set by the caller, so no double is passed)
  function tile(x, y, col, a, rt, rl, rr, rb) {
    const r = col[0], g = col[1], b = col[2], p = 3 * ts, ds = 2.8 * ts, e = 6.3 * ts;
    for (let j = 0; j < 4; j++) {
      const yy = y - 1.5 * p + j * p, sh = a * (1.08 - j * 0.14);
      dot(x - 1.5 * p, yy, ds, r, g, b, sh); dot(x - 0.5 * p, yy, ds, r, g, b, sh); dot(x + 0.5 * p, yy, ds, r, g, b, sh); dot(x + 1.5 * p, yy, ds, r, g, b, sh);
    }
    const wr = r + (1 - r) * 0.75, wg = g + (1 - g) * 0.75, wb = b + (1 - b) * 0.75;
    if (rt > 0) for (let i = 0; i < 5; i++) dot(x - 2 * p + i * p, y - e, 1.9 * ts, wr, wg, wb, rt);
    if (rb > 0) for (let i = 0; i < 5; i++) dot(x - 2 * p + i * p, y + e, 1.2 * ts, wr, wg, wb, rb);
    if (rl > 0) for (let j = 1; j < 4; j++) dot(x - e, y - 2 * p + j * p, 1.3 * ts, wr, wg, wb, rl);
    if (rr > 0) for (let j = 1; j < 4; j++) dot(x + e, y - 2 * p + j * p, 1.3 * ts, wr, wg, wb, rr);
  }
  function tileMix(x, y, col, k, a) { // a tile blended toward white by k, for the clear fade
    const r = col[0] + (1 - col[0]) * k, g = col[1] + (1 - col[1]) * k, b = col[2] + (1 - col[2]) * k;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) dot(x - 4.5 + i * 3, y - 4.5 + j * 3, 2.9, r, g, b, a);
  }
  function cells1(grid, fadeMask, k, fa, greyFrom, c0, c1) {
    for (let c = 0; c < COLS; c++) {
      let depth = 0;
      for (let r = TOTAL_ROWS - 1; r >= 0; r--) {
        const t = grid[r * COLS + c];
        if (t === 0) { depth = 0; continue; }
        const d = depth++;
        if (r >= c0 && r <= c1) continue;
        const x = colX(c), y = rowY(r);
        if ((fadeMask >> r) & 1) { if (fa > 0.01) tileMix(x, y, L1COL[t] || C_WHITE, k, fa); continue; }
        if (r >= greyFrom) { tile(x, y, C_STEEL, 0.18, 0, 0, 0, 0); continue; }
        const up = r + 1 < TOTAL_ROWS ? grid[(r + 1) * COLS + c] : 0;
        const lf = c > 0 ? grid[r * COLS + c - 1] : 1, rt = c < COLS - 1 ? grid[r * COLS + c + 1] : 1, dn = r > 0 ? grid[(r - 1) * COLS + c] : 1;
        const a = d < 6 ? 0.72 - d * 0.09 : 0.18, col = L1COL[t] || C_WHITE;
        tile(x, y, col, a, up === 0 ? 1 : 0, lf === 0 ? 0.55 : 0, rt === 0 ? 0.55 : 0, dn === 0 ? 0.3 : 0);
        if (up === 0) { dot(x, y - 11, 11, col[0], col[1], col[2], 0.07); dot(x, y - 20, 15, col[0], col[1], col[2], 0.035); } // light rising off the skyline
      }
    }
  }
  const TITLE_CH = ['S', 'T', 'A', 'C', 'K', 'L', 'I', 'G', 'H', 'T'];
  const SKY = new Uint8Array([2, 1, 1, 2, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 2, 3, 0, 0, 0]); // the right end stays clear of MUTED
  function title1(t) {
    // the wordmark gets a lit top edge: a white copy one unit up, so each letter reads as a lit block
    const n = 10, x0 = CX - (n * 24 - 4) / 2;
    for (let i = 0; i < n; i++) { const wave = dsin(t * 0.05 - i * 0.5) * 1.5; text(TITLE_CH[i], x0 + i * 24, 45 + wave, C_WHITE, 4, 'l', 0.28); }
    // a low skyline of lit tiles along the floor of the screen (fixed heights, rims on top)
    for (let c = 0; c < 30; c++) {
      const h = SKY[c], x = 6.5 + c * 13;
      for (let r = 0; r < h; r++) {
        const y = 293 - r * 13, top = r === h - 1;
        tile(x, y, (c * 7 + r) % 5 === 0 ? C_PLUS : (c + r) % 3 === 0 ? SLATE : C_BAR, top ? 0.32 : 0.16, top ? 0.6 : 0, 0, 0, 0);
      }
    }
  }

  // ---------- entry points (render.js) ----------
  return {
    // looks 0 and 3: the well walls and sockets in the field's colour (called where render.js draws its frame)
    frame(sim, g, warn) { sync(sim); frame2(g, warn); },
    // looks 0 and 3, after all text of a run: the field, the HUD brackets and (not while paused) the clear sweep
    run(sim, fx, paused) {
      const g = sim.glowT > 0 ? sim.glow : 0;
      field2(sim.frame, g, fx.S, 0);
      hud2(g);
      if (!paused) sweep3(fx.S, sim.frame);
    },
    // looks 0 and 3, after all text of the title (and of its board page): the field, the well's area lit too. F: ui.F
    titleField(F) { sync(null); field2(F, 0, null, 1); },
    title1,
    cells: cells1,
    // looks 1 and 3: every cell drawn outside the stack (the falling piece, NEXT, title pieces) as a tile; core = the active piece
    cell1(x, y, col, a, core, sz) {
      ts = sz;
      if (core) { tile(x, y, col, 0.95 * a, a, 0.8 * a, 0.8 * a, 0.6 * a); dot(x, y, 3 * sz, 1, 1, 1, 0.6 * a); } else tile(x, y, col, 0.9 * a, a, 0.5 * a, 0.5 * a, 0.3 * a);
      ts = 1;
    }
  };
}
