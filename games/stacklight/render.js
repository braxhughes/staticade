// STACKLIGHT renderer: everything in design B.10, drawn as dots. Reads the sim (grid, active piece, queue, score) and
// the presentation state in render/fx.js; never changes the sim. No allocation per frame: strings for the HUD are
// rebuilt only when their number changes, every table is built once here.
import { COLS, ROWS, TOTAL_ROWS, BAR, PLUS, ROT_H } from './defs.js';
// trig from the deterministic helpers in engine/dmath.js (tests/stacklight-sim.test.js keeps browser trig out of games/stacklight)
import { sin as dsin, cos as dcos, TAU as DTAU, HALF_PI } from '../../engine/dmath.js';
import { PH_PLAY } from './sim.js';
import { SHAPE_N, SHAPE_DX, SHAPE_DY, shapeOf, fits, meltInto } from './sim/piece.js';
import { DRIP, FLASH, FADE, PMAX, PS, POPS, POP_FIT, POP_POINTS, POP_LEVEL, STREAK } from './render/fx.js';
import {
  W, H, CX, CELL, BX0, BX1, BY_FLOOR, BY_CEIL, BY_TOP, colX, rowY,
  C_BAR, C_PLUS, C_STEEL, C_WHITE, C_EDGE, C_TOP, C_LOW, C_DIM, C_WARN, TYPE_COL, TYPE_A
} from './render/geom.js';
import { createLooks, LOOK_N } from './render/looks.js';

const TAU = DTAU;
const GLOW_STR = ['X1', 'X1.25', 'X1.5', 'X1.75', 'X2'];
const MODE_STR = { arcade: 'FREE PLAY', daily: 'DAILY RIDGE', test: 'TEST START' };
const PIECE_COL = [C_WHITE, C_BAR, C_PLUS];
const OVER_STR = ['', 'TOP OUT', 'LIGHTS OUT'];
const TITLE = 'STACKLIGHT', TITLE_CH = TITLE.split('');
// game-over panel box (field units) and the rows it covers: the stack is not drawn behind it
const PANEL_Y0 = 96, PANEL_Y1 = 206;
const PANEL_R0 = Math.ceil((BY_FLOOR - PANEL_Y1) / CELL) - 1, PANEL_R1 = Math.floor((BY_FLOOR - PANEL_Y0) / CELL);
const RING_N = 32; // dots in the GLOW timer ring
// one HUD grid for both side panels (docs/w60/HUD-AUDIT.md). Field units, integers only.
// Panels: mirror images about the well (x 200), each the well's height (y 40 to 277) plus two dot steps at each end.
const HP_Y0 = 34, HP_Y1 = 283, HP_L0 = 13, HP_L1 = 127, HP_R0 = 273, HP_R1 = 387;
const HP_STEP = 3, HP_ARM = 12;             // corner brackets: a dot every 3 units, arms 12 long, on the panel's 3-unit lattice
const HX_L = 22, HX_R = 282;                // text starts 9 in from the panel edge (x 22 is pinned: tests/stacklight-browser-w49c.test.js)
const HY_LAB = 44, HY_PITCH = 46, HY_VAL = 12; // first label row, block pitch, label top to value top
const HY_DIV = 172;                         // the divider in both panels: stats above GLOW, the NEXT queue above BEST
const HY_ROW4 = HY_LAB + 3 * HY_PITCH;      // GLOW (left) and BEST (right): 182
const HX_MID = 330;                         // right panel centre (the NEXT column, the points lane)
const NEXT_Y = [80, 118, 149];              // the next piece and the two queue pieces, centred on HX_MID
const LANE_Y = 216, LANE_DY = 11, LANE_N = 4; // clear points: their own lane under BEST, newest on top
const FOOT_Y = 267;                         // the mode line, right panel footer

export function createRenderer({ gfx, text: textOut, ui }) {
  const dot = gfx.dot;
  // a box around every string drawn this frame (x0, y0, x1, y1 in fifths of a unit, covering the lit dots), so the
  // field and the clear sweep (render/looks.js) can keep out of all text. Reset at the start of each screen. Integers only:
  // x and y are truncated by an Int32Array store and the scale is rounded up to fifths by comparing with a tagged table, so
  // no double is made here in any V8 tier (a double made in unoptimised code is a heap number).
  const TB_MAX = 160, tb = new Int32Array(TB_MAX * 4), tbN = new Int32Array(1), tI = new Int32Array(2);
  const SC5 = new Array(41).fill(null);
  for (let q = 0; q <= 40; q++) SC5[q] = q / 5;
  function text(str, x, y, col, sc, align, a, wave) {
    const n = tbN[0];
    if (n < TB_MAX) {
      tI[0] = x; tI[1] = y;
      let s5 = 5;
      if (sc !== undefined && sc !== 1) { s5 = 1; while (s5 < 40 && SC5[s5] < sc) s5++; }
      const X = tI[0] * 5, Y = tI[1] * 5, w = s5 * (6 * str.length - 1), h = (s5 + 1) >> 1, o = n * 4;
      const x0 = align === 'c' ? X - (w >> 1) - 1 : align === 'r' ? X - w : X;
      tb[o] = x0 - h; tb[o + 1] = Y - h; tb[o + 2] = x0 + 5 + w + h; tb[o + 3] = Y + 5 + 6 * s5 + h; // + 5: x and y were truncated
      tbN[0] = n + 1;
    }
    textOut(str, x, y, col, sc, align, a, wave);
  }
  const scratch = new Uint8Array(COLS * TOTAL_ROWS);
  // T: per-frame doubles shared by the draw functions (0 now, 1 alpha, 2 the active piece's y offset). Doubles passed as
  // arguments to a call the compiler does not inline are boxed (a heap number each); read from here they never are.
  const T = new Float64Array(4);
  const mOut = new Int8Array(15);
  // the looks (render/looks.js), switched only by the test hook SL.look(n). Look 0, the shipped look, is
  // LIVING FIELD + SWEEP: the field, the well and the HUD brackets come from looks.js (fieldLook). Look 1 SOLID LIGHT and look 3
  // HYBRID draw the stack as tiles (tileLook). Look 2 is the earlier shipped look and never calls into looks.js.
  // the HUD frame as x, y pairs (HK corner brackets, HD the dividers) and the panel boxes in fifths (HB, for the field's
  // dimming), built once; looks 0 and 3 draw them in the field's colour (looks.js hud2), looks 1 and 2 in the edge colour (hudFrame)
  const hk = [], hd = [];
  for (const [x0, x1] of [[HP_L0, HP_L1], [HP_R0, HP_R1]]) {
    for (let d = 0; d <= HP_ARM; d += HP_STEP) {
      hk.push(x0 + d, HP_Y0, x1 - d, HP_Y0, x0 + d, HP_Y1, x1 - d, HP_Y1);
      if (d > 0) hk.push(x0, HP_Y0 + d, x1, HP_Y0 + d, x0, HP_Y1 - d, x1, HP_Y1 - d);
    }
    for (let x = x0 + 2 * HP_STEP; x <= x1 - 2 * HP_STEP; x += HP_STEP) hd.push(x, HY_DIV);
  }
  const HK = new Array(hk.length).fill(null), HD = new Array(hd.length).fill(null);
  for (let i = 0; i < hk.length; i++) HK[i] = hk[i];
  for (let i = 0; i < hd.length; i++) HD[i] = hd[i];
  const HB = Int32Array.of(HP_L0 * 5, HP_Y0 * 5, HP_L1 * 5, HP_Y1 * 5, HP_R0 * 5, HP_Y0 * 5, HP_R1 * 5, HP_Y1 * 5);
  const lk = createLooks({ dot, text, T, tb, tbN, hud: { k: HK, d: HD, box: HB } });
  let look = 0, lkSim = null, titleFieldDue = false;
  const fieldLook = () => look === 0 || look === 3, tileLook = () => look === 1 || look === 3;
  function setLook(n) { if (Number.isInteger(n) && n >= 0 && n < LOOK_N) look = n; return look; }
  const ringCos = new Float32Array(RING_N), ringSin = new Float32Array(RING_N);
  for (let i = 0; i < RING_N; i++) { const a = -HALF_PI + i / RING_N * TAU; ringCos[i] = dcos(a); ringSin[i] = dsin(a); }
  const ringK = new Float32Array(5 * 24 * 2); // GLOW rings 1 to 4: 6k dots on radius 5k
  for (let k = 1; k <= 4; k++) for (let i = 0; i < 6 * k; i++) { const a = i / (6 * k) * TAU + k * 0.3; ringK[(k * 24 + i) * 2] = dcos(a) * 5 * k; ringK[(k * 24 + i) * 2 + 1] = dsin(a) * 5 * k; }
  // title colours per letter (cabinet marquee: top green to bottom cyan)
  const titleCol = TITLE_CH.map((_, i) => { const t = i / (TITLE_CH.length - 1); return [C_TOP[0] + (C_LOW[0] - C_TOP[0]) * t, C_TOP[1] + (C_LOW[1] - C_TOP[1]) * t, C_TOP[2] + (C_LOW[2] - C_TOP[2]) * t]; });
  // title backdrop: falling beams (render only, from a fixed table)
  // where title text sits (field units: x0, y0, x1, y1 of the lit dots). A beam whose centre is within 14 of a box is hidden,
  // and fades back in over the next 14, so no beam crosses the wordmark, the menu, the card, the key lines, the status lines or BEST.
  // The last box is the board page (used only while that page is up).
  const QUIET = new Float32Array([82, 44, 318, 94, 54, 104, 384, 192, 88, 202, 312, 238, 107, 246, 293, 264, 170, 268, 230, 278, 350, 288, 390, 298, 40, 100, 360, 290]);
  const QUIET_BOARD = 6, QUIET_N = 7;
  const BEAMS = new Float32Array([18, 0.42, 0, 1, 52, 0.31, 150, 2, 86, 0.37, 260, 1, 314, 0.34, 40, 2, 348, 0.45, 200, 1, 382, 0.29, 300, 1, 120, 0.25, 90, 2, 280, 0.27, 330, 2]);

  // Tagged tables. A double that is computed, or read from a typed array or an all-number array, is boxed into a new
  // heap number each time it is passed to gfx.dot from code where the compiler did not inline dot (a heap profile
  // found that in frame, outline, glowMeter and box, about 9 KB a frame). Values read from a plain array that also holds
  // a non-number keep generic elements: they are passed as the heap numbers they already are, so nothing is allocated.
  // These tables are built once here; everything those four functions pass to dot is a small integer, a literal, or
  // a value read from one of them.
  const tagged = n => new Array(n).fill(null);
  const tcol = c => { const t = tagged(3); t[0] = c[0]; t[1] = c[1]; t[2] = c[2]; return t; };
  const T_EDGE = tcol(C_EDGE), T_WARN = tcol(C_WARN), T_PLUS = tcol(C_PLUS);
  const T_PIECE = [tcol(C_WHITE), tcol(C_BAR), tcol(C_PLUS)];
  // outline: x and y of a cell centre plus -6, -3, 0, 3, 6 (index c * 5 + 2 + i, r * 5 + 2 + i)
  const OX = tagged(COLS * 5), OY = tagged(TOTAL_ROWS * 5);
  for (let c = 0; c < COLS; c++) for (let i = -2; i <= 2; i++) OX[c * 5 + 2 + i] = colX(c) + i * 3;
  for (let r = 0; r < TOTAL_ROWS; r++) for (let i = -2; i <= 2; i++) OY[r * 5 + 2 + i] = rowY(r) + i * 3;
  // frame: x, y pairs per group (0 edges, 1 GLOW outer edges, 2 spawn-zone sides, 3 ceiling line); per GLOW step g
  // the edge colour (FC, 3 per g), edge alpha (FA) and outer alpha (FA1)
  const FP = [[], [], [], []];
  {
    const xl = BX0 - 3, xr = BX1 + 3, yb = BY_FLOOR + 3;
    for (let y = BY_CEIL; y <= yb; y += 3) FP[0].push(xl, y, xr, y);
    for (let x = xl; x <= xr; x += 3) FP[0].push(x, yb);
    for (let y = BY_CEIL + 1.5; y <= yb; y += 6) FP[1].push(xl - 3, y, xr + 3, y);
    for (let y = BY_TOP; y < BY_CEIL; y += 4) FP[2].push(xl, y, xr, y);
    for (let x = xl; x <= xr; x += 4) FP[3].push(x, BY_CEIL);
  }
  for (let q = 0; q < 4; q++) { const t = tagged(FP[q].length); for (let i = 0; i < t.length; i++) t[i] = FP[q][i]; FP[q] = t; }
  const FC = tagged(15), FA = tagged(5), FA1 = tagged(5);
  for (let g = 0; g <= 4; g++) {
    const k = g / 4, a = 0.42 + g * 0.12;
    FC[g * 3] = C_EDGE[0] + (1 - C_EDGE[0]) * k * 0.6; FC[g * 3 + 1] = C_EDGE[1]; FC[g * 3 + 2] = C_EDGE[2] + (1 - C_EDGE[2]) * k * 0.6;
    FA[g] = a; FA1[g] = a * 0.35 * k;
  }
  // GLOW meter: dot positions of rings 1 to 4 (index k * 24 + i), the timer ring (RING_N), ring colours (3 per k),
  // and the per-frame ring alphas (GA, written once a frame: 4 heap numbers, not one per dot)
  // inside the left panel, under the GLOW block and to its right: the timer ring (radius 25) runs x 75 to 125 (the panel is
  // 13 to 127), y 209 to 259, 7.6 units from the X1.75 value and 8 from the well's outer glow (x 133.5). The centre stays in the
  // window tests/stacklight-browser-w49c.test.js:255 pins (lit ring 2 within 26 of (112, 222)), with the later rule (6 from the
  // wall); a ring centred in the panel (x 70) is outside that pin. (the earlier x 100, y 222 was outside the old bracket.)
  const GMX = 100, GMY = 234;
  const GX = tagged(5 * 24), GY = tagged(5 * 24), RX = tagged(RING_N), RY = tagged(RING_N), GC = tagged(15), GA = tagged(5);
  for (let k = 1; k <= 4; k++) {
    for (let i = 0; i < 6 * k; i++) { GX[k * 24 + i] = GMX + ringK[(k * 24 + i) * 2]; GY[k * 24 + i] = GMY + ringK[(k * 24 + i) * 2 + 1]; }
    const w = k / 4;
    GC[k * 3] = C_BAR[0] + (1 - C_BAR[0]) * w * 0.7; GC[k * 3 + 1] = C_BAR[1]; GC[k * 3 + 2] = C_BAR[2] + (1 - C_BAR[2]) * w * 0.7;
  }
  for (let i = 0; i < RING_N; i++) { RX[i] = GMX + ringCos[i] * 25; RY[i] = GMY + ringSin[i] * 25; }
  // light shaft: y on a quarter-unit grid (YQ, from YQ0) and alpha in 1/32 steps (AQ). The shaft moves with the piece's
  // interpolated y, so its dots are snapped to 0.25 field units (under 1 px at 1000 x 750) to come from a table.
  const YQ0 = -32, YQ = tagged(1409), AQ = tagged(33);
  for (let i = 0; i < YQ.length; i++) YQ[i] = YQ0 + i / 4;
  for (let i = 0; i < AQ.length; i++) AQ[i] = i / 32;

  // HUD strings, rebuilt only when the number changes (hud is read by SL.hud())
  const hud = { score: '0', level: '1', lines: '0', glow: 'X1', best: '0', nScore: 0, nLevel: 1, nLines: 0, nBest: 0, drawnF: -1 };
  function hudSync(sim, best) {
    if (sim.score !== hud.nScore || hud.drawnF < 0) { hud.nScore = sim.score; hud.score = String(sim.score); }
    if (sim.level !== hud.nLevel || hud.drawnF < 0) { hud.nLevel = sim.level; hud.level = String(sim.level); }
    if (sim.lines !== hud.nLines || hud.drawnF < 0) { hud.nLines = sim.lines; hud.lines = String(sim.lines); }
    if (best !== hud.nBest || hud.drawnF < 0) { hud.nBest = best; hud.best = String(best); }
    hud.glow = GLOW_STR[sim.glow] || 'X1';
  }
  function hudReset() { hud.drawnF = -1; }

  // ---------- primitives ----------
  // B.10 cell: a 3 x 3 cluster of dots; the active piece adds a white-core centre dot
  function cell(x, y, col, a, core, sz) {
    const p = 4 * sz, s = 3.1 * sz;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) dot(x + i * p, y + j * p, s, col[0], col[1], col[2], a);
    if (core) dot(x, y, 2.4 * sz, 1, 1, 1, 0.95);
  }
  function cellMix(x, y, col, k, a) { // a cell blended toward white by k (0..1), for the flash and fade
    const r = col[0] + (1 - col[0]) * k, g = col[1] + (1 - col[1]) * k, b = col[2] + (1 - col[2]) * k;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) dot(x + i * 4, y + j * 4, 3.3, r, g, b, a);
  }
  function outline(c, r, ci) { // a dim square of dots around cell (c, r), 6 out from its centre: the landing marker
    const xb = c * 5 + 2, yb = r * 5 + 2, col = T_PIECE[ci], cr = col[0], cg = col[1], cb = col[2];
    for (let i = -2; i <= 2; i++) {
      dot(OX[xb + i], OY[yb - 2], 0.9, cr, cg, cb, 0.32); dot(OX[xb + i], OY[yb + 2], 0.9, cr, cg, cb, 0.32);
      if (i > -2 && i < 2) { dot(OX[xb - 2], OY[yb + i], 0.9, cr, cg, cb, 0.32); dot(OX[xb + 2], OY[yb + i], 0.9, cr, cg, cb, 0.32); }
    }
  }
  function box(x, y, w, h, col, a, step) { // dotted rectangle; integer x, y, w, h and a tagged colour (tcol) allocate nothing
    const s = step || 3, r = col[0], g = col[1], b = col[2];
    for (let i = 0; i <= w; i += s) { dot(x + i, y, 0.8, r, g, b, a); dot(x + i, y + h, 0.8, r, g, b, a); }
    for (let j = s; j < h; j += s) { dot(x, y + j, 0.8, r, g, b, a); dot(x + w, y + j, 0.8, r, g, b, a); }
  }
  // a piece shape (rot H) centred at (x, y) at size sz, for NEXT and the title
  function shapeAt(type, rot, x, y, sz, a, core) {
    const sh = shapeOf(type, rot), o = sh * 5, n = SHAPE_N[sh], col = PIECE_COL[type];
    const midY = sh === 2 || sh === 1 ? 1 : 0;
    if (tileLook()) { for (let i = 0; i < n; i++) lk.cell1(x + SHAPE_DX[o + i] * CELL * sz, y - (SHAPE_DY[o + i] - midY) * CELL * sz, col, a, core, sz); return; }
    for (let i = 0; i < n; i++) cell(x + SHAPE_DX[o + i] * CELL * sz, y - (SHAPE_DY[o + i] - midY) * CELL * sz, col, a, core, sz);
  }

  // ---------- board ----------
  function frame(g, warn) {
    // B.10: dot-drawn board edges, brighter with each GLOW step; the spawn zone edges dimmer. Every value from the
    // tagged tables built above (FP, FC, FA, FA1), so no heap number is made per dot.
    if (fieldLook()) { lk.frame(lkSim, g, warn); return; }
    const r = FC[g * 3], gg = FC[g * 3 + 1], b = FC[g * 3 + 2], a = FA[g], a1 = FA1[g];
    const P0 = FP[0], P1 = FP[1], P2 = FP[2], P3 = FP[3];
    for (let i = 0; i < P0.length; i += 2) dot(P0[i], P0[i + 1], 1.15, r, gg, b, a);
    if (g > 0) for (let i = 0; i < P1.length; i += 2) dot(P1[i], P1[i + 1], 0.9, r, gg, b, a1);
    // spawn zone: dimmer edges and the ceiling line (rows 18 to 20, B.1); red-tinted while the stack is near it
    const cc = warn ? T_WARN : T_EDGE, ca = warn ? 0.45 : 0.2, er = T_EDGE[0], eg = T_EDGE[1], eb = T_EDGE[2];
    for (let i = 0; i < P2.length; i += 2) dot(P2[i], P2[i + 1], 0.9, er, eg, eb, 0.16);
    for (let i = 0; i < P3.length; i += 2) dot(P3[i], P3[i + 1], 0.9, cc[0], cc[1], cc[2], ca);
  }
  function sockets() { // a faint dot in every visible cell, so the grid reads when the board is empty
    if (fieldLook()) return; // looks 0 and 3 draw their own (lk.frame)
    const er = T_EDGE[0], eg = T_EDGE[1], eb = T_EDGE[2];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) dot(OX[c * 5 + 2], OY[r * 5 + 2], 1, er, eg, eb, 0.07);
  }
  // grid cells. fadeMask rows are drawn toward white (k) at alpha fa; greyFrom: rows at or above it are drawn burnt out
  // clipR0..clipR1: rows left undrawn behind the game-over panel; 99 and -1 = none
  let clipR0 = 99, clipR1 = -1;
  function cells(grid, fadeMask, k, fa, greyFrom) {
    if (tileLook()) { lk.cells(grid, fadeMask, k, fa, greyFrom, clipR0, clipR1); return; }
    for (let r = 0; r < TOTAL_ROWS; r++) {
      if (r >= clipR0 && r <= clipR1) continue;
      const fr = (fadeMask >> r) & 1, grey = r >= greyFrom;
      for (let c = 0; c < COLS; c++) {
        const t = grid[r * COLS + c];
        if (t === 0) continue;
        const x = colX(c), y = rowY(r);
        if (fr) { if (fa > 0.01) cellMix(x, y, TYPE_COL[t], k, fa); continue; }
        if (grey) { cell(x, y, C_STEEL, 0.22, false, 1); continue; }
        cell(x, y, TYPE_COL[t], TYPE_A[t], false, 1);
        if (t === 3) dot(x, y, 1, C_STEEL[0], C_STEEL[1], C_STEEL[2], 0.2); // SHADE: no core
      }
    }
  }
  // B.10 SHADE gap: one faint dot in the empty cell of a SHADE row (1v1 junk; solo boards never have one)
  function shadeGaps(grid) {
    for (let r = 0; r < ROWS; r++) {
      let shade = false;
      for (let c = 0; c < COLS; c++) if (grid[r * COLS + c] === 3) { shade = true; break; }
      if (!shade) continue;
      for (let c = 0; c < COLS; c++) if (grid[r * COLS + c] === 0) dot(colX(c), rowY(r), 1.3, C_STEEL[0], C_STEEL[1], C_STEEL[2], 0.3);
    }
  }

  // B.10 light shaft: faint dots down each column of the active piece to where that cell lands after melt, and the
  // landing cells outlined dimly. Uses the sim's own melt rule (meltInto) on a scratch copy of the grid.
  function shaft(sim) {
    const S = sim.ctx, grid = sim.grid, sh = shapeOf(S.pType, S.rot), o = sh * 5, n = SHAPE_N[sh];
    let ly = S.py;
    while (fits(grid, sh, S.px, ly - 1)) ly--;
    scratch.set(grid);
    meltInto(scratch, sh, S.px, ly, S.pType, mOut);
    for (let i = 0; i < n; i++) {
      const c = mOut[i * 3], r1 = mOut[i * 3 + 2], dx = SHAPE_DX[o + i], dy = SHAPE_DY[o + i];
      outline(c, r1, S.pType);
      // the shaft starts under the lowest piece cell of this column only
      let lowest = true;
      for (let j = 0; j < n; j++) if (j !== i && SHAPE_DX[o + j] === dx && SHAPE_DY[o + j] < dy) { lowest = false; break; }
      if (!lowest) continue;
      let lowLand = r1;
      for (let j = 0; j < n; j++) if (SHAPE_DX[o + j] === dx && mOut[j * 3 + 2] < lowLand) lowLand = mOut[j * 3 + 2];
      shaftCol(c, S.py + dy, lowLand, S.pType);
    }
  }
  // one column of the shaft: from under piece row rFrom (moved by the interpolation offset T[2]) down to landing row rLow
  function shaftCol(c, rFrom, rLow, ci) {
    const col = T_PIECE[ci], cr = col[0], cg = col[1], cb = col[2], x = OX[c * 5 + 2];
    const y0 = rowY(rFrom) + T[2] + CELL / 2, y1 = rowY(rLow) - CELL / 2, flow = (T[0] * 0.6) % 4, span = y1 - y0 + 1;
    for (let y = y0 + flow; y < y1; y += 4) {
      const qi = Math.max(0, Math.min(YQ.length - 1, Math.round((y - YQ0) * 4)));
      dot(x, YQ[qi], 1.1, cr, cg, cb, AQ[Math.round((0.16 + 0.1 * ((y - y0) / span)) * 32)]);
    }
  }

  function piece(sim, fx) {
    const al = T[1], S = sim.ctx, F = fx.S, sh = shapeOf(S.pType, S.rot), o = sh * 5, n = SHAPE_N[sh], col = PIECE_COL[S.pType];
    // interpolate from the position before the last sim step (same piece, same turn) to now
    let ox = 0, oy = 0;
    if (F.prevSpawned === S.spawned && F.prevRot === S.rot) { ox = (F.prevPx - S.px) * (1 - al); oy = (F.prevPy - S.py) * (1 - al); }
    const yOff = -oy * CELL;
    T[2] = yOff;
    if (tileLook()) { for (let i = 0; i < n; i++) lk.cell1(colX(S.px + SHAPE_DX[o + i] + ox), rowY(S.py + SHAPE_DY[o + i]) + yOff, col, 1, true, 1); return; }
    for (let i = 0; i < n; i++) cell(colX(S.px + SHAPE_DX[o + i] + ox), rowY(S.py + SHAPE_DY[o + i]) + yOff, col, 1, true, 1);
  }

  function stackHigh(grid) { for (let c = 0; c < COLS; c++) if (grid[(ROWS - 3) * COLS + c]) return true; return false; }

  // the board for a run in play or over: grid (with the drip, flash and fade), shaft, piece, streak, particles, popups
  function board(sim, fx, greyFrom) {
    const now = T[0], F = fx.S, S = sim.ctx;
    const lockAge = now - F.lockF, hasClear = F.clearF === F.lockF && F.clearMask !== 0;
    if (lockAge >= 0 && lockAge < DRIP) {
      // B.4 / B.10 melt drip: the grid as it was, plus each piece cell sliding from its rigid spot to its landing spot
      cells(fx.base, 0, 0, 0, greyFrom);
      const t = lockAge / DRIP, e = t * t * (3 - 2 * t), col = PIECE_COL[F.lockType] || C_WHITE;
      for (let i = 0; i < F.nMelt; i++) {
        const c = fx.mc[i], r0 = fx.m0[i], r1 = fx.m1[i], x = colX(c);
        const rr = r0 + (r1 - r0) * e, y = rowY(rr), bright = 1 - 0.45 * e;
        if (hasClear && lockAge < FLASH && (F.clearMask >> r1) & 1) continue; // drawn by the flash
        if (r1 >= greyFrom) { if (r1 < clipR0 || r1 > clipR1) cell(x, y, C_STEEL, 0.22, false, 1); continue; } // burnt out like the stack
        cell(x, y, col, bright, e < 0.6, 1);
        if (r0 !== r1) for (let k = 1; k <= 3; k++) dot(x, y - k * 4.5, 2.2 - k * 0.4, col[0], col[1], col[2], (0.45 - k * 0.12) * (1 - e));
      }
      if (hasClear && lockAge < FLASH) flashRows(fx.melt, F.clearMask, lockAge);
    } else if (hasClear && lockAge >= 0 && lockAge < FLASH + FADE) {
      if (lockAge < FLASH) { cells(fx.melt, F.clearMask, 0, 0, greyFrom); flashRows(fx.melt, F.clearMask, lockAge); }
      else { const k = (lockAge - FLASH) / FADE; cells(fx.melt, F.clearMask, 1 - k, 1 - k, greyFrom); }
    } else cells(sim.grid, 0, 0, 0, greyFrom);
    shadeGaps(sim.grid);
    // hard-drop streak: a short trail above where the piece came down
    if (F.hardF === F.lockF && lockAge >= 0 && lockAge < STREAK && F.hardRows > 0) {
      const col = PIECE_COL[F.lockType] || C_WHITE, a = 0.35 * (1 - lockAge / STREAK);
      for (let i = 0; i < F.nMelt; i++) {
        const x = colX(fx.mc[i]), yTop = rowY(fx.m0[i] + F.hardRows), yLow = rowY(fx.m0[i]) - CELL / 2;
        for (let y = yTop; y < yLow; y += 5) dot(x, y, 1.4, col[0], col[1], col[2], a);
      }
    }
    if (S.phase === PH_PLAY && S.pType && !sim.done) { piece(sim, fx); shaft(sim); }
    particles(fx);
    popups(fx);
  }
  function flashRows(grid, mask, age) {
    const a = 0.85 + 0.15 * ((age | 0) & 1);
    for (let r = 0; r < TOTAL_ROWS; r++) {
      if (!((mask >> r) & 1)) continue;
      for (let c = 0; c < COLS; c++) cellMix(colX(c), rowY(r), C_WHITE, 1, a);
      for (let x = BX0 + 2; x < BX1; x += 3) dot(x, rowY(r), 1.6, 1, 1, 1, 0.5); // a bright line through the row
    }
  }
  function particles(fx) {
    const now = T[0], P = fx.part;
    for (let i = 0; i < PMAX; i++) {
      const o = i * PS, life = P[o + 5];
      if (life === 0) continue;
      const t = now - P[o + 4];
      if (t < 0 || t > life) continue;
      const x = P[o] + P[o + 2] * t, y = P[o + 1] + P[o + 3] * t + 0.035 * t * t, k = 1 - t / life;
      const col = TYPE_COL[P[o + 6] | 0] || C_WHITE, w = k * 0.6;
      dot(x, y, P[o + 7], col[0] + (1 - col[0]) * w, col[1] + (1 - col[1]) * w, col[2] + (1 - col[2]) * w, k);
    }
  }
  // Popups make (almost) no heap numbers, in any V8 tier. The first popup of a run reaches code paths with no
  // type feedback yet, so V8 drops popups back to unoptimised code, where a double (12 bytes) is made for every non-integer
  // read from a float array and every double result. So:
  //   - each frame, a slot is checked against the copy kept of it by its bits only: fx.pop is copied into PF (a Float32Array
  //     made here, so nothing is built during play) and read back as 16-bit halves through PU, a Uint16Array over PF's
  //     buffer (every value read is a small integer). Only a new popup is read as floats, once: kind, born and life go to
  //     Int32Arrays (PI), x (PX), life * 0.6 and life * 0.4 (PL6, PL4) are made once and kept, and so is y after the
  //     24-frame rise (PY). PX, PY, PL6 and PL4 are tagged arrays (filled with null first, so their elements stay tagged).
  //   - on screen or not is decided on integers (TN[0], the integer frame, set in drawRun): t = TN[0] - born + alpha with
  //     alpha in [0, 1), so tf < 0 means t < 0 except tf = -1, and tf >= life means t >= life; only those two edge cases
  //     run the double test from before. The same goes for "risen" (t >= 24) and "solid" (t < life * 0.6).
  //   - t (and T[0]) is read only when a value drawn needs it: y while rising, the alpha while fading. Otherwise the alpha
  //     is the literal 1 or 0.9 (what 1 and 1 * 0.9 were).
  // Each case is its own text() call with the reused value or literal written in it (a ?: between a literal and a computed
  // double would make one double again). The values drawn are exactly the ones computed before.
  const TN = new Int32Array(1), PB = new Uint16Array(POPS * 10), PI = new Int32Array(POPS * 4); // PI: kind, born, life, lane
  const PX = new Array(POPS).fill(null), PY = new Array(POPS).fill(null), PL6 = new Array(POPS).fill(null), PL4 = new Array(POPS).fill(null);
  const PF = new Float32Array(POPS * 5), PU = new Uint16Array(PF.buffer);
  // 1 when slot i is on screen this frame (the old test: 0 <= t <= life)
  function popOn(i, f) {
    const q = i * 4, tf = f - PI[q + 1], life = PI[q + 2];
    if (PI[q] === 0 || tf < -1 || tf > life) return 0;
    if (tf >= 0 && tf < life) return 1;
    const t = T[0] - PI[q + 1];
    return t < 0 || t > life ? 0 : 1;
  }
  function popups(fx) {
    const f = TN[0], p = fx.pop;
    PF.set(p);
    for (let i = 0; i < POPS; i++) {
      const u = i * 10;
      let same = true;
      for (let h = 0; h < 10; h++) if (PB[u + h] !== PU[u + h]) { same = false; break; }
      if (same) continue;
      for (let h = 0; h < 10; h++) PB[u + h] = PU[u + h];
      // a new popup in this slot (or a cleared one): read it once
      const o = i * 5, q = i * 4, kind = p[o];
      PI[q] = kind; PI[q + 1] = p[o + 3]; PI[q + 2] = p[o + 4]; PI[q + 3] = kind === POP_POINTS && p[o + 1] > BX1 ? 1 : 0;
      PX[i] = p[o + 1]; PY[i] = null; PL6[i] = p[o + 4] * 0.6; PL4[i] = p[o + 4] * 0.4;
    }
    for (let i = 0; i < POPS; i++) {
      if (popOn(i, f) === 0) continue;
      const o = i * 5, q = i * 4, kind = PI[q], born = PI[q + 1], lane = PI[q + 3] === 1, tf = f - born;
      // risen: t >= 24; solid: t < life * 0.6 (PL6). Integers settle them except when tf is the integer just below.
      const risen = tf >= 24 ? true : tf < 23 ? false : T[0] - born >= 24;
      const solid = tf + 1 < PL6[i] ? true : tf >= PL6[i] ? false : T[0] - born < PL6[i];
      const str = fx.popStr[i];
      // rise = Math.min(t, 24) * 0.35 (8 units, 3 in the lane: / 8); after the rise it is 24 * 0.35 for good
      if (risen && !lane && PY[i] === null) {
        const rise = 24 * 0.35;
        PY[i] = kind === POP_FIT ? p[o + 2] - 10 - rise : kind === POP_LEVEL ? p[o + 2] - rise * 0.3 : p[o + 2] - rise;
      }
      if (lane) {
        // a clear's points (render/fx.js puts them right of the well) go in the right panel's lane under BEST, never on a
        // frame line or another string: newest on top, each older one 11 units lower, at most 4; a 3-unit rise instead of 8
        let k = 0;
        for (let j = 0; j < POPS; j++) {
          if (j === i || PI[j * 4] !== POP_POINTS || PI[j * 4 + 3] !== 1 || popOn(j, f) === 0) continue;
          const bj = PI[j * 4 + 1];
          if (bj > born || (bj === born && j > i)) k++;
        }
        if (k >= LANE_N) continue;
        // after the rise y is LANE_Y + k * LANE_DY, a whole number (a small integer is never boxed)
        if (risen) {
          if (solid) text(str, HX_MID, LANE_Y + k * LANE_DY + 3 - 24 / 8, C_TOP, 1, 'c', 0.9);
          else text(str, HX_MID, LANE_Y + k * LANE_DY + 3 - 24 / 8, C_TOP, 1, 'c', (1 - (T[0] - born - PL6[i]) / PL4[i]) * 0.9);
        } else if (solid) text(str, HX_MID, LANE_Y + k * LANE_DY + 3 - (T[0] - born) / 8, C_TOP, 1, 'c', 0.9);
        else text(str, HX_MID, LANE_Y + k * LANE_DY + 3 - (T[0] - born) / 8, C_TOP, 1, 'c', (1 - (T[0] - born - PL6[i]) / PL4[i]) * 0.9);
      } else if (kind === POP_FIT) {
        if (risen) {
          if (solid) text(str, PX[i], PY[i], C_WHITE, 1.4, 'c', 1);
          else text(str, PX[i], PY[i], C_WHITE, 1.4, 'c', 1 - (T[0] - born - PL6[i]) / PL4[i]);
        } else if (solid) text(str, PX[i], p[o + 2] - 10 - (T[0] - born) * 0.35, C_WHITE, 1.4, 'c', 1);
        else text(str, PX[i], p[o + 2] - 10 - (T[0] - born) * 0.35, C_WHITE, 1.4, 'c', 1 - (T[0] - born - PL6[i]) / PL4[i]);
      } else if (kind === POP_POINTS) {
        if (risen) {
          if (solid) text(str, PX[i], PY[i], C_TOP, 1, 'c', 0.9);
          else text(str, PX[i], PY[i], C_TOP, 1, 'c', (1 - (T[0] - born - PL6[i]) / PL4[i]) * 0.9);
        } else if (solid) text(str, PX[i], p[o + 2] - (T[0] - born) * 0.35, C_TOP, 1, 'c', 0.9);
        else text(str, PX[i], p[o + 2] - (T[0] - born) * 0.35, C_TOP, 1, 'c', (1 - (T[0] - born - PL6[i]) / PL4[i]) * 0.9);
      } else if (kind === POP_LEVEL) {
        if (risen) {
          if (solid) text(str, PX[i], PY[i], C_PLUS, 2, 'c', 1);
          else text(str, PX[i], PY[i], C_PLUS, 2, 'c', 1 - (T[0] - born - PL6[i]) / PL4[i]);
        } else if (solid) text(str, PX[i], p[o + 2] - (T[0] - born) * 0.35 * 0.3, C_PLUS, 2, 'c', 1);
        else text(str, PX[i], p[o + 2] - (T[0] - born) * 0.35 * 0.3, C_PLUS, 2, 'c', 1 - (T[0] - born - PL6[i]) / PL4[i]);
      }
    }
  }

  // ---------- HUD (B.1: left SCORE, LEVEL, LINES, GLOW; right NEXT 3) ----------
  // one grid (HUD-AUDIT.md). Every label size 1 in C_DIM, every value size 2, value top = label top + 12, blocks 46 apart.
  function hudLeft(sim) {
    const L = HX_L;
    text('SCORE', L, HY_LAB, C_DIM, 1, 'l', 0.9); text(hud.score, L, HY_LAB + HY_VAL, C_WHITE, 2, 'l', 1);
    text('LEVEL', L, HY_LAB + HY_PITCH, C_DIM, 1, 'l', 0.9); text(hud.level, L, HY_LAB + HY_PITCH + HY_VAL, C_WHITE, 2, 'l', 1);
    text('LINES', L, HY_LAB + 2 * HY_PITCH, C_DIM, 1, 'l', 0.9); text(hud.lines, L, HY_LAB + 2 * HY_PITCH + HY_VAL, C_WHITE, 2, 'l', 1);
    const on = sim.glow > 0 && sim.glowT > 0;
    text('GLOW', L, HY_ROW4, C_DIM, 1, 'l', 0.9);
    text(hud.glow, L, HY_ROW4 + HY_VAL, on ? C_PLUS : C_DIM, 2, 'l', on ? 1 : 0.6);
    glowMeter(sim.glow, sim.glowT, sim.glowFrames);
  }
  // looks 1 and 2: the same panel frame as looks 0 and 3 (which draw it in looks.js, in the field's colour)
  function hudFrame() {
    const r = T_EDGE[0], g = T_EDGE[1], b = T_EDGE[2];
    for (let i = 0; i < HK.length; i += 2) dot(HK[i], HK[i + 1], 1, r, g, b, 0.5);
    for (let i = 0; i < HD.length; i += 2) dot(HD[i], HD[i + 1], 0.8, r, g, b, 0.25);
  }
  // B.10 GLOW meter, left of the board: each step g adds a ring of dots; the outer ring is the GLOW timer
  function glowMeter(g, gt, frames) {
    // positions and colours from the tagged tables (GX, GY, GC, RX, RY); the lit alpha is written to GA once per ring
    const now = T[0];
    dot(GMX, GMY, 2, 1, 1, 1, gt > 0 ? 0.9 : 0.15);
    for (let k = 1; k <= 4; k++) {
      const lit = k <= g, n = 6 * k, o = k * 24;
      GA[k] = lit ? 0.55 + 0.4 * (gt > 0 ? 1 : 0.3) + 0.05 * dsin(now * 0.2 + k) : 0.08;
      const r = GC[k * 3], gg = GC[k * 3 + 1], b = GC[k * 3 + 2], a = GA[k];
      if (lit) for (let i = 0; i < n; i++) dot(GX[o + i], GY[o + i], 1.4, r, gg, b, a);
      else for (let i = 0; i < n; i++) dot(GX[o + i], GY[o + i], 1, r, gg, b, a);
    }
    const on = Math.ceil(gt / frames * RING_N), pr = T_PLUS[0], pg = T_PLUS[1], pb = T_PLUS[2];
    for (let i = 0; i < RING_N; i++) dot(RX[i], RY[i], 0.9, pr, pg, pb, i < on ? 0.75 : 0.06);
  }
  // right panel: NEXT, the next piece and the queue in one column above the divider; BEST on the GLOW row; the points lane;
  // the mode line as the footer
  function hudRight(sim) {
    const L = HX_R;
    text('NEXT', L, HY_LAB, C_DIM, 1, 'l', 0.9);
    const n = sim.previewN, q = sim.queue;
    if (n > 0 && q[0]) shapeAt(q[0], ROT_H, HX_MID, NEXT_Y[0], 0.95, 1, false);
    if (n > 1 && q[1]) shapeAt(q[1], ROT_H, HX_MID, NEXT_Y[1], 0.6, 0.7, false);
    if (n > 2 && q[2]) shapeAt(q[2], ROT_H, HX_MID, NEXT_Y[2], 0.6, 0.7, false);
    text('BEST', L, HY_ROW4, C_DIM, 1, 'l', 0.9); text(hud.best, L, HY_ROW4 + HY_VAL, C_TOP, 2, 'l', 0.85);
    text(MODE_STR[sim.mode] || '', L, FOOT_Y, C_DIM, 1, 'l', 0.55);
  }
  // SL.hudLayout() (read only, built on each call; tests only): the grid above in field units
  function hudLayout() {
    const lab = (str, x, y) => ({ str, x, y, valueY: y + HY_VAL });
    return {
      left: { x0: HP_L0, y0: HP_Y0, x1: HP_L1, y1: HP_Y1 }, right: { x0: HP_R0, y0: HP_Y0, x1: HP_R1, y1: HP_Y1 },
      step: HP_STEP, arm: HP_ARM, divY: HY_DIV, labelSc: 1, valueSc: 2, valueGap: HY_VAL, pitch: HY_PITCH,
      labels: [lab('SCORE', HX_L, HY_LAB), lab('LEVEL', HX_L, HY_LAB + HY_PITCH), lab('LINES', HX_L, HY_LAB + 2 * HY_PITCH), lab('GLOW', HX_L, HY_ROW4),
        lab('NEXT', HX_R, HY_LAB), lab('BEST', HX_R, HY_ROW4)],
      next: NEXT_Y.map(y => ({ x: HX_MID, y })), meter: { x: GMX, y: GMY, r: 25 },
      lane: { x: HX_MID, y: LANE_Y, dy: LANE_DY, n: LANE_N }, footY: FOOT_Y
    };
  }

  // ---------- screens ----------
  // a run: playing, paused (cells hidden) or over (burnt out from the top, then the result panel)
  // the caller sets T[1] = alpha first (renderer.T), so no double is passed in
  function drawRun(sim, fx, o) {
    hudSync(sim, o.best);
    const now = sim.frame - 1 + T[1];
    T[0] = now; T[2] = 0; TN[0] = sim.frame - 1;
    fx.age(sim.frame - 1);
    lkSim = sim; tbN[0] = 0;
    sockets();
    frame(sim.glow, stackHigh(sim.grid));
    clipR0 = o.over ? PANEL_R0 : 99; clipR1 = o.over ? PANEL_R1 : -1;
    if (!o.paused) board(sim, fx, o.over ? TOTAL_ROWS - Math.floor(o.overT / 2) : 99);
    hudLeft(sim);
    hudRight(sim);
    if (!fieldLook()) hudFrame(); // looks 0 and 3: lk.run draws the frame after the field
    if (o.paused) {
      text('PAUSED', CX, 128, C_WHITE, 2, 'c');
      text(o.touch ? 'TAP: RESUME' : 'P: RESUME', CX, 156, C_DIM, 1, 'c', ui.F % 60 < 40 ? 1 : 0.6);
      if (!o.touch) text('ESC: QUIT', CX, 170, C_DIM, 1, 'c', 0.7);
    } else if (o.over) {
      const a = Math.min(1, o.overT / 30);
      box(148, PANEL_Y0, 104, PANEL_Y1 - PANEL_Y0, T_EDGE, 0.5 * a);
      text(OVER_STR[sim.ctx.reason] || 'GAME OVER', CX, 108, sim.ctx.reason === 2 ? C_PLUS : C_WARN, 1.6, 'c', a);
      text('SCORE', CX, 134, C_DIM, 1, 'c', a); text(hud.score, CX, 146, C_WHITE, 2, 'c', a);
      if (o.newBest) text('NEW BEST', CX, 170, C_PLUS, 1, 'c', a * (ui.F % 40 < 28 ? 1 : 0.5));
      if (o.overT > 45) text(o.save ? (o.touch ? 'TAP: SAVE' : 'ENTER: SAVE') : o.touch ? 'TAP: TITLE' : 'ENTER: TITLE', CX, 190, C_DIM, 1, 'c', ui.F % 60 < 40 ? 1 : 0.55);
    }
    if (fieldLook()) lk.run(sim, fx, o.paused); // last: every string of this frame is in tb, so the field and sweep keep out of it
    hud.drawnF = ui.F;
  }

  // ---------- T5: title card, name entry and board table ----------
  // o (main.js titleOpts, one reused object): sel, crtOn, muted, touch, best, page, status, warn, and for the Daily card o.card
  // (modes.js dailyCard: grid, levelStr, rule, noStr built once from a sim made with the seed), o.dstate ('ready' | 'asking' |
  // 'off'), o.dmsg, o.used, o.reset. Every string is built by main.js when it changes; nothing is built or allocated per frame.
  const MENU_N = ['DAILY RIDGE', 'FREE PLAY', 'CRT: ON', 'BOARDS', 'SOUND: ON'];
  const CRT_STR = ['CRT: OFF', 'CRT: ON'], SND_STR = ['SOUND: OFF', 'SOUND: ON'];
  const MENU_Y = 112, MENU_DY = 16, MENU_X = 106;
  const PX0 = 212, PY0 = 100, PW = 172, PH = 92;
  const RULE_NOTE = { 'LEAN': 'MORE PLUS, FEWER BARS', 'SHORT SIGHT': 'NEXT SHOWS ONE PIECE', 'QUICK GLOW': 'GLOW LASTS 2.5 SECONDS' };
  const PV = 0.7, PVP = CELL * PV; // ridge preview cell size and pitch
  function ridgePreview(grid, cx, y0) { // the day's ridge as the board will show it: RIDGE cells in SHADE steel at 45%, rows 0..2
    const x0 = cx - (COLS * PVP) / 2 + PVP / 2;
    for (let r = 0; r < 3; r++) for (let c = 0; c < COLS; c++) {
      const x = x0 + c * PVP, y = y0 - r * PVP;
      if (grid[r * COLS + c]) cell(x, y, C_STEEL, 0.45, false, PV);
      else dot(x, y, 1, C_EDGE[0], C_EDGE[1], C_EDGE[2], 0.2);
    }
    for (let i = 0; i <= COLS * 3; i++) dot(cx - (COLS * PVP) / 2 + i * PVP / 3, y0 + PVP / 2 + 2, 0.9, C_EDGE[0], C_EDGE[1], C_EDGE[2], 0.5);
  }
  function drawTitle(o) {
    const t = ui.F + T[1];
    tbN[0] = 0; titleFieldDue = false;
    if (look === 1) lk.title1(t);
    // backdrop: beams of light falling past the sides
    for (let i = 0; i < BEAMS.length; i += 4) {
      const x = BEAMS[i], sp = BEAMS[i + 1], ph = BEAMS[i + 2], type = BEAMS[i + 3];
      const y = ((t * sp + ph) % 360) - 40;
      let a = 0.22;
      const nq = o.page === 'table' ? QUIET_N : QUIET_BOARD;
      for (let q = 0; q < nq; q++) {
        const o4 = q * 4, ex = Math.max(QUIET[o4] - x, 0, x - QUIET[o4 + 2]), ey = Math.max(QUIET[o4 + 1] - y, 0, y - QUIET[o4 + 3]);
        const d = Math.max(ex, ey) - 14;
        if (d < 14) a *= d <= 0 ? 0 : d / 14;
      }
      if (a <= 0) continue;
      shapeAt(type, type === BAR && (i & 4) ? 1 : ROT_H, x, y, 0.55, a, false);
    }
    for (let i = 0; i < TITLE_CH.length; i++) {
      const x = CX - (TITLE_CH.length * 24 - 4) / 2 + i * 24, wave = dsin(t * 0.05 - i * 0.5) * 1.5;
      text(TITLE_CH[i], x, 46 + wave, titleCol[i], 4, 'l', 1);
    }
    text('A FALLING LIGHT PUZZLE', CX, 90, C_DIM, 1, 'c', 0.9);
    const blink = ui.F % 40 < 28 ? 1 : 0.4;
    if (o.page === 'table') { titleFieldDue = fieldLook(); return; } // the field comes after the board page's text (drawBoard)
    // the menu (left)
    const sel = o.sel;
    for (let i = 0; i < MENU_N.length; i++) {
      const lab = i === 2 ? CRT_STR[o.crtOn ? 1 : 0] : i === 4 ? SND_STR[o.muted ? 0 : 1] : MENU_N[i], y = MENU_Y + i * MENU_DY;
      text(lab, MENU_X, y, i === sel ? C_WHITE : C_DIM, 1.2, 'c', 1);
      if (i === sel) { text('>', MENU_X - 52, y, C_PLUS, 1.2, 'c', blink); text('<', MENU_X + 52, y, C_PLUS, 1.2, 'c', blink); }
    }
    // the card (right): what the highlighted mode is
    box(PX0, PY0, PW, PH, T_EDGE, 0.35);
    const cx = PX0 + PW / 2;
    if (sel === 0) {
      const c = o.card;
      if (c !== null && o.dstate === 'ready') {
        text(c.noStr, cx, PY0 + 6, C_TOP, 1, 'c', 1);
        // the rows sit 3 units higher than before so the last line keeps a margin above the card's bottom edge
        text(c.levelStr, PX0 + 6, PY0 + 21, C_WHITE, 1, 'l', 1);
        text('START', PX0 + 6, PY0 + 31, C_DIM, 1, 'l', 0.8);
        text(c.rule, PX0 + 6, PY0 + 46, C_PLUS, 1, 'l', 1);
        text('DAY RULE', PX0 + 6, PY0 + 56, C_DIM, 1, 'l', 0.8);
        ridgePreview(c.grid, PX0 + PW - 52, PY0 + 40);
        text(RULE_NOTE[c.rule], cx, PY0 + 67, C_DIM, 1, 'c', 0.9);
        text(o.used ? 'PRACTICE: ATTEMPT USED' : 'RANKED ATTEMPT READY', cx, PY0 + 79, o.used ? C_DIM : C_PLUS, 1, 'c', 1);
      } else if (o.dstate === 'off') {
        text('DAILY NEEDS THE BOARD', cx, PY0 + 22, C_WARN, 1, 'c', 1);
        text(o.dmsg, cx, PY0 + 38, C_WARN, 1, 'c', 0.9);
        text('ONE DAILY FOR EVERYONE,', cx, PY0 + 56, C_DIM, 1, 'c', 0.9);
        text('SENT BY THE BOARD', cx, PY0 + 68, C_DIM, 1, 'c', 0.9);
        text(o.touch ? 'TAP: TRY AGAIN' : 'ENTER: TRY AGAIN', cx, PY0 + 84, C_TOP, 1, 'c', blink);
      } else text('ASKING THE BOARD...', cx, PY0 + 40, C_TOP, 1, 'c', blink);
    } else {
      text('FREE PLAY', cx, PY0 + 6, C_TOP, 1, 'c', 1);
      shapeAt(BAR, ROT_H, cx - 34, PY0 + 40, 0.8, 0.9, true);
      shapeAt(PLUS, ROT_H, cx + 34, PY0 + 40, 0.8, 0.9, true);
      text('LEVEL 1, EMPTY BOARD', cx, PY0 + 66, C_DIM, 1, 'c', 0.9);
      text('RANDOM SEED, ALL RUNS RANK', cx, PY0 + 80, C_DIM, 1, 'c', 0.9);
    }
    if (o.touch) {
      text('TAP TO START', CX, 206, C_TOP, 1, 'c', blink);
      text('SWIPE: CHOOSE', CX, 220, C_DIM, 1, 'c', 0.8);
    } else {
      text('ENTER: START   UP DOWN: CHOOSE', CX, 204, C_TOP, 1, 'c', 0.9);
      text('LEFT RIGHT: MOVE   UP: TURN   DOWN: SOFT', CX, 218, C_DIM, 1, 'c', 0.8);
      text('SPACE: DROP   P: PAUSE   M: MUTE', CX, 230, C_DIM, 1, 'c', 0.8);
    }
    if (o.status !== '') text(o.status, CX, 246, o.statusCol, 1, 'c', 1);
    else if (sel === 0 && o.dstate === 'ready') text(o.reset, CX, 246, C_BAR, 1, 'c', 0.8);
    if (o.warn !== '') text(o.warn, CX, 257, C_WARN, 1, 'c', 1);
    text('BEST', CX - 4, 270, C_DIM, 1, 'r', 0.8); text(o.best, CX + 4, 270, C_TOP, 1, 'l', 0.9);
    if (o.muted) text('MUTED', 390, 290, C_DIM, 1, 'r', 0.8);
    if (fieldLook()) lk.titleField(ui.F); // last, so it keeps out of every string above
  }

  // the board table (also behind attract's table phase): t = modes.js createTable; tab titles from TABS, rows pre-built strings
  const TAB_NAMES = ['ALL-TIME', 'TODAY', 'SEASON'];
  function drawBoard(t, o) {
    box(40, 100, 320, 142, T_EDGE, 0.4); // rows end at y 230; everything below stays above y 290 (the CRT bezel covers the last rows of the field)
    for (let i = 0; i < 3; i++) {
      const sel = i === t.tab;
      text(TAB_NAMES[i], 90 + i * 110, 108, sel ? C_PLUS : C_DIM, 1, 'c', 1);
    }
    const rows = t.rows[t.tab];
    if (!rows.length) text(t.offline ? 'OFFLINE' : t.loaded ? 'NO RUNS YET' : 'LOADING', CX, 170, t.offline ? C_PLUS : C_DIM, 1, 'c');
    if (t.offline && o.hints) text('BOARD RETRIES EVERY 10 S', CX, 184, C_DIM, 1, 'c');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], y = 122 + i * 12, hi = r.id === t.hiId, blink = hi && (ui.F % 30 < 20);
      const col = hi ? (blink ? C_WHITE : C_PLUS) : i === 0 ? C_PLUS : i < 3 ? C_WHITE : C_BAR;
      text(r.rank, 82, y, col, 1, 'r'); text(r.name, 94, y, col, 1); text(r.score, 336, y, col, 1, 'r');
      if (r.mode === 'daily') text('D', 296, y, C_STEEL, 1, 'r', 0.8);
    }
    if (o.hints) { // the player's own result, the storage warning and the key line are for the title's board page, not attract's table
      if (t.warn) text(t.warn, CX, 250, C_WARN, 1, 'c');
      else if (t.summary) text(t.summary, CX, 250, C_BAR, 1, 'c', 0.8);
      if (t.note) text(t.note, CX, 262, C_PLUS, 1, 'c');
      if (t.line) text(t.line, CX, 274, t.lineCol, 1, 'c');
      text(o.touch ? 'SWIPE: BOARD   TAP: BACK' : 'UP DOWN: BOARD   ENTER: BACK', CX, 286, C_DIM, 1, 'c', 0.9);
    }
    if (titleFieldDue) { titleFieldDue = false; lk.titleField(ui.F); } // the title's board page: the field after its text
  }

  // name entry: info = { scoreStr, modeStr, timeStr }, e = modes.js createEntry
  function drawEntry(e, info) {
    const F = ui.F;
    if (info.record) text('NEW RUN RECORD', CX, 34, C_TOP, 1.4, 'c', 1);       // only for a run that beat the best
    else text('RUN COMPLETE', CX, 34, C_TOP, 1.4, 'c', 1);
    text(info.scoreStr, CX, 58, C_PLUS, 2.4, 'c');
    text(info.modeStr, CX, 86, C_DIM, 1, 'c');
    text('ENTER YOUR INITIALS', CX, 100, C_WHITE, 1, 'c');
    for (let i = 0; i < 3; i++) {
      const x = CX + (i - 1) * 56, act = i === e.pos, blink = act && (F % 40 < 28);
      text(e.letter(i), x, 130, act ? (blink ? C_PLUS : C_WHITE) : C_BAR, 6, 'c');
      for (let k = -14; k <= 14; k += 2) dot(x + k, 178, 1, act ? C_PLUS[0] : C_BAR[0], act ? C_PLUS[1] : C_BAR[1], act ? C_PLUS[2] : C_BAR[2], act ? 1 : 0.5);
      if (act) {
        for (let k = 0; k < 5; k++) { // little up and down arrows made of dots
          dot(x - k * 2, 114 + k * 2, 1, C_PLUS[0], C_PLUS[1], C_PLUS[2], 0.9); dot(x + k * 2, 114 + k * 2, 1, C_PLUS[0], C_PLUS[1], C_PLUS[2], 0.9);
          dot(x - k * 2, 192 - k * 2, 1, C_PLUS[0], C_PLUS[1], C_PLUS[2], 0.9); dot(x + k * 2, 192 - k * 2, 1, C_PLUS[0], C_PLUS[1], C_PLUS[2], 0.9);
        }
      }
    }
    text(e.pos === 2 ? 'ENTER: SAVE' : 'ENTER: NEXT', CX, 214, C_WHITE, 1, 'c', F % 50 < 34 ? 1 : 0.5);
    text('UP DOWN OR TYPE   ESC: PREVIOUS', CX, 228, C_DIM, 1, 'c');
    text('TOUCH: SWIPE UP DOWN, TAP FOR NEXT', CX, 240, C_DIM, 1, 'c');
    text(info.timeStr, CX, 262, C_DIM, 1, 'c');
  }

  // ---------- touch pads (E): drawn in the side bands from the input layout, outside the field ----------
  // The geometry depends only on the layout (window size and insets), so it is built into tagged tables when the layout
  // changes and drawing a frame reads them: no double is computed per dot, so none is boxed (touch heap).
  const PAD_LABEL = ['', '', 'SOFT', 'DROP', 'TURN', '']; // PAUSE is the two-bars icon alone: a text label costs about 36 B a frame, and the budget for drawPads is 125
  const padKey = new Float64Array(3);
  const PAD_A = tagged(2); PAD_A[0] = 0.55; PAD_A[1] = 1; // border alpha: idle, held (read from a tagged table: nothing is boxed)
  let padL = null, padTab = null;
  const tag = arr => { const t = tagged(arr.length); for (let i = 0; i < arr.length; i++) t[i] = arr[i]; return t; };
  // icon dots for pad id centred at (x, y), size s: [x, y, size, alpha factor] per dot, pushed onto o
  function iconDots(o, id, x, y, s) {
    const add = (px, py, sz, m) => o.push(px, py, sz, m);
    if (id === 0 || id === 1) { // arrow
      const d = id === 0 ? -1 : 1;
      for (let i = 0; i <= 4; i++) for (let j = -i; j <= i; j++) add(x + d * (4 - i) * s * 2.4 - d * s * 2, y + j * s * 2.4, 1.3 * s, 1);
    } else if (id === 2) { // soft: two chevrons
      for (let k = 0; k < 2; k++) for (let i = -3; i <= 3; i++) add(x + i * s * 2.4, y - 5 * s + k * 7 * s + (3 - Math.abs(i)) * s * 2, 1.3 * s, 1);
    } else if (id === 3) { // hard drop: a beam to the floor
      for (let j = -4; j <= 2; j++) add(x, y + j * s * 2.6, 1.4 * s, 0.5 + 0.1 * (j + 4));
      for (let i = -4; i <= 4; i++) add(x + i * s * 2.4, y + 6 * s, 1.3 * s, 1);
    } else if (id === 5) { // pause: two bars
      for (let j = -3; j <= 3; j++) { add(x - 4 * s, y + j * s * 2.4, 2.8 * s, 1); add(x + 4 * s, y + j * s * 2.4, 2.8 * s, 1); }
    } else { // rotate: an arc with a head
      for (let i = 0; i < 10; i++) { const ang = -2.6 + i * 0.5; add(x + dcos(ang) * 8 * s, y + dsin(ang) * 8 * s, 1.3 * s, 1); }
      const ex = x + dcos(1.9) * 8 * s, ey = y + dsin(1.9) * 8 * s;
      add(ex - 3 * s, ey - 1 * s, 1.3 * s, 1); add(ex - 2 * s, ey - 4 * s, 1.3 * s, 1);
    }
  }
  function buildPads(L) {
    const sc = L.scale, fx0 = L.field.x, fy0 = L.field.y, pads = L.pause ? L.pads.concat([L.pause]) : L.pads, out = [];
    for (let p = 0; p < pads.length; p++) {
      const q = pads[p];
      const x = (q.x - fx0) / sc, y = (q.y - fy0) / sc, w = q.w / sc, h = q.h / sc;
      const st = Math.max(2.5, Math.min(w, h) / 10);
      const bd = [], fl = [], ic = [];
      for (let i = 0; i <= w; i += st) { bd.push(x + i, y); bd.push(x + i, y + h); }
      for (let j = st; j < h; j += st) { bd.push(x, y + j); bd.push(x + w, y + j); }
      for (let j = st; j < h; j += st) for (let i = st; i < w; i += st) fl.push(x + i, y + j);
      const s = Math.min(w, h) / 34;
      iconDots(ic, q.id, x + w / 2, y + h / 2 - (PAD_LABEL[q.id] ? 3 * s : 0), s);
      const n = ic.length / 4, ix = tagged(n), iy = tagged(n), isz = tagged(n), ia0 = tagged(n), ia1 = tagged(n);
      for (let i = 0; i < n; i++) { ix[i] = ic[i * 4]; iy[i] = ic[i * 4 + 1]; isz[i] = ic[i * 4 + 2]; ia0[i] = 0.85 * ic[i * 4 + 3]; ia1[i] = ic[i * 4 + 3]; }
      const ls = Math.max(0.8, s), lab = PAD_LABEL[q.id];
      out.push({
        id: q.id, bd: tag(bd), nbd: bd.length, fl: tag(fl), nfl: fl.length, ix, iy, isz, ia0, ia1, ni: n,
        lab, lx: tag([x + w / 2])[0], ly: tag([y + h - 10 * ls])[0], ls: tag([ls])[0], col: q.id === 3 || q.id === 4 ? C_PLUS : C_BAR
      });
    }
    padTab = out; padL = L; padKey[0] = sc; padKey[1] = fx0; padKey[2] = fy0;
  }
  // L: input.getLayout() (CSS px). touches: Float32Array of x, y pairs (CSS px), nT of them. Field units = (css - field) / scale.
  // withPause: the PAUSE pad (L.pause, not one of the five pads) is drawn too, only in a run in play. The return counts the five pads.
  function drawPads(L, touches, nT, withPause) {
    const sc = L.scale;
    if (!(sc > 0)) return 0;
    if (L !== padL || padKey[0] !== sc || padKey[1] !== L.field.x || padKey[2] !== L.field.y) buildPads(L);
    const pads = L.pads, np = pads.length, total = withPause && padTab.length > np ? np + 1 : np;
    let drawn = 0;
    for (let p = 0; p < total; p++) {
      const q = p < np ? pads[p] : L.pause, t = padTab[p];
      let held = false;
      for (let i = 0; i < nT; i++) { const tx = touches[i * 2], ty = touches[i * 2 + 1]; if (tx >= q.x && tx < q.x + q.w && ty >= q.y && ty < q.y + q.h) { held = true; break; } }
      const col = t.col, r = col[0], g = col[1], b = col[2], bd = t.bd, a = PAD_A[held ? 1 : 0]; // a tagged table: a computed double would be boxed
      for (let i = 0; i < t.nbd; i += 2) dot(bd[i], bd[i + 1], 1.1, r, g, b, a);
      if (held) { const fl = t.fl; for (let i = 0; i < t.nfl; i += 2) dot(fl[i], fl[i + 1], 1, r, g, b, 0.18); }
      const ic = held ? C_WHITE : col, ir = ic[0], ig = ic[1], ib = ic[2], ia = held ? t.ia1 : t.ia0, ix = t.ix, iy = t.iy, isz = t.isz;
      for (let i = 0; i < t.ni; i++) dot(ix[i], iy[i], isz[i], ir, ig, ib, ia[i]);
      if (t.lab) text(t.lab, t.lx, t.ly, col, t.ls, 'c', 0.8);
      if (p < np) drawn++;
    }
    return drawn;
  }

  return { T, look: setLook, hudLayout, drawRun, drawTitle, drawBoard, drawEntry, drawPads, hud, hudReset, cell, shapeAt };
}
