// C.2 enemy visuals (design.md B.11 3.1, 3.2): the Tetherling line and the Hounds. The Tetherling's own sprite is
// its registered art (sim/enemies/tether.js), drawn by the core enemies layer. Reads the sim, never writes it. Dots
// only. Cosmetic motion may use Math.sin and the render frame R.ui.F. No per-frame allocation.
//
// Line   faint (alpha 0.18, sparse) in formation and early in the dive; blink (4 frames on, 4 off, bright) for the
//        30-frame warning; solid (dense, bright, a white core with a rose sheath) while it kills. A broken line
//        leaves two short stubs that fall away for 24 frames (the snap burst itself is FX_TETHER, fx.js).
// Hound  a lean ash-and-ember stalker head, eyes on the ship; a faint ring of dots on the ship's row marks the past
//        position it is stalking (tx); during the 20-step glow, the core's aim-lock glow plus a dotted fall line.
import { TAU } from '../defs.js';
import { aimGlow } from './core.js';
import { TETHER_PAIRS, tetherLive, LINE_FAINT, LINE_BLINKING, LINE_SOLID } from '../sim/enemies/tether.js';
import { HOUND_N, H_OFF, H_GLOW, H_SECOND, HOUND_GLOW, HOUND_ROW } from '../sim/enemies/hound.js';

const BRK_T = 24;

function lineDots(R, ax, ay, bx, by, step, size, r, g, b, a, wob, F) {
  const dx = bx - ax, dy = by - ay, d = Math.sqrt(dx * dx + dy * dy), n = Math.max(1, Math.ceil(d / step));
  const nx = d > 0 ? -dy / d : 0, ny = d > 0 ? dx / d : 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n, w = wob * Math.sin(t * 9.4 + F * 0.3);
    R.dot(ax + dx * t + nx * w, ay + dy * t + ny * w, size, r, g, b, a);
  }
}

function drawLines(R, sim, al) {
  const S = sim.ctx, T = S.tethers, F = R.ui.F;
  if (!T) return;
  for (let k = 0; k < TETHER_PAIRS; k++) {
    // the stubs of a broken line fall apart
    const dt = S.frame - T.brkF[k];
    if (dt >= 0 && dt < BRK_T) {
      const f = 1 - dt / BRK_T, mx = (T.brkAx[k] + T.brkBx[k]) / 2, my = (T.brkAy[k] + T.brkBy[k]) / 2, sag = dt * 0.5;
      lineDots(R, T.brkAx[k], T.brkAy[k], T.brkAx[k] + (mx - T.brkAx[k]) * f * 0.7, my + sag, 3, 1.2, 1, .5, .7, f, 0, F);
      lineDots(R, T.brkBx[k], T.brkBy[k], T.brkBx[k] + (mx - T.brkBx[k]) * f * 0.7, my + sag, 3, 1.2, 1, .5, .7, f, 0, F);
    }
    if (!tetherLive(T, 2 * k) || !tetherLive(T, 2 * k + 1)) continue;
    const a = T.mem[2 * k], b = T.mem[2 * k + 1];
    if (a.st === 'wait' || b.st === 'wait') continue;
    const ax = a.px + (a.x - a.px) * al, ay = a.py + (a.y - a.py) * al, bx = b.px + (b.x - b.px) * al, by = b.py + (b.y - b.py) * al;
    const ph = T.phase[k];
    if (ph === LINE_FAINT) lineDots(R, ax, ay, bx, by, 4, 0.9, .85, .6, 1, 0.18, 0.6, F);
    else if (ph === LINE_BLINKING) {
      if ((F >> 2) & 1) lineDots(R, ax, ay, bx, by, 3, 1.3, 1, .45, .75, 0.9, 1.2, F);
      else lineDots(R, ax, ay, bx, by, 4, 0.9, .85, .6, 1, 0.25, 0.6, F);
    } else if (ph === LINE_SOLID) {
      lineDots(R, ax, ay, bx, by, 2, 1.9, 1, .3, .6, 0.55, 0, F);
      lineDots(R, ax, ay, bx, by, 2, 1.0, 1, .95, 1, 1, 0, F);
    }
  }
}

// the Hound: an ash head pointing down at the ship, ember eyes, two ear tips (animated), drawn as it appears on screen
const HOUND_A = ['b.........b', 'bb.......bb', '.bbbbbbbbb.', '.baebbbeab.', '..bbbbbbb..', '..bbcccbb..', '...bbcbb...', '....bcb....', '.....b.....'];
const HOUND_B = ['.b.......b.', 'bb.......bb', '.bbbbbbbbb.', '.baebbbeab.', '..bbbbbbb..', '..bbcccbb..', '...bbcbb...', '....bcb....', '.....b.....'];
function sprite(rows) {
  const h = rows.length, w = rows[0].length, d = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const ch = rows[y][x]; if (ch !== '.') d.push(x - (w - 1) / 2, y - (h - 1) / 2, ch.charCodeAt(0)); }
  return { d, w, h };
}
const SPR_A = sprite(HOUND_A), SPR_B = sprite(HOUND_B);
const PAL = new Array(128).fill(null);
PAL[98] = [0.78, 0.74, 0.8];  // b: ash
PAL[97] = [1, 0.55, 0.15];    // a: ember
PAL[101] = [1, 0.95, 0.6];    // e: eye
PAL[99] = [0.45, 0.4, 0.55];  // c: muzzle shadow

function drawHounds(R, sim, al) {
  const S = sim.ctx, Hd = S.hounds, F = R.ui.F, P = sim.player;
  if (!Hd || sim.row !== HOUND_ROW) return;
  for (let i = 0; i < HOUND_N; i++) {
    const st = Hd.st[i];
    if (st === H_OFF) continue;
    const x = Hd.px[i] + (Hd.x[i] - Hd.px[i]) * al, y = Hd.py[i] + (Hd.y[i] - Hd.py[i]) * al;
    // the stalked spot: where the ship was 30 steps ago, on the ship's row
    if (st >= 2 && st <= 4) {
      const tx = Hd.tx[i];
      for (let k = 0; k < 8; k++) { const q = k / 8 * TAU + F * 0.05; R.dot(tx + Math.cos(q) * 6, P.y + Math.sin(q) * 3, 1, .8, .7, .9, 0.28); }
    }
    if (st === H_GLOW || st === H_SECOND) {
      const left = st === H_GLOW ? Math.max(1, HOUND_GLOW - Hd.f[i]) : 1;
      aimGlow(R, x, y + 8, left);
      const a = st === H_GLOW ? 0.12 + 0.3 * (1 - left / HOUND_GLOW) : 0.3;
      for (let yy = y + 12; yy < P.y + 4; yy += 6) R.dot(x, yy, 0.9, 1, .4, .45, a);
    }
    const spr = ((F >> 4) & 1) ? SPR_B : SPR_A;
    R.drawSpr(spr, x, y, 0, PAL, 1, 1, Hd.flash[i] > 0, 1);
    // ember breath under the jaw
    R.dot(x + Math.sin(F * 0.3 + i) * 0.8, y + 6, 1.1, 1, .5, .2, 0.5 + 0.3 * Math.sin(F * 0.2));
  }
}

export const enemiesC2Layer = {
  id: 'enemies-c2',
  draw(R, sim, al) {
    if (!sim.ctx) return;
    drawLines(R, sim, al);
    drawHounds(R, sim, al);
  }
};
