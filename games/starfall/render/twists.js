// Stage twist cues (design.md B.11): the Hunt ring (2.2), Undertow bands (1.3), Thermals edges (1.5).
// Reads the sim, never writes it. Dots only. Cosmetic motion may use Math.sin and the render frame R.ui.F.
// No per-frame allocation: plain loops over the sim's own arrays.
import { W, H, TAU } from '../defs.js';
import { leverOf, undertowPhase, undertowDir, thermalX, UNDERTOW_TELE, UNDERTOW_PULL, UNDERTOW_CYCLE, THERM_HALF } from '../sim/twists.js';

// Hunt: red dots over the dive glow, and a ring of 8 dots (radius 10) that blinks 4 frames on, 4 off for the whole
// telegraph (the blink reads without colour). Counted from the telegraph so every Hunt blinks the same way.
function huntRing(R, x, y, tele, F) {
  for (let k = 0; k < 10; k++) {
    const q = k / 10 * TAU + F * 0.12;
    R.dot(x + Math.cos(q) * 9, y + Math.sin(q) * 9, 1.0, 1, 0.15, 0.15, 0.75);
  }
  if ((tele >> 2) & 1) return;
  for (let k = 0; k < 8; k++) {
    const q = k / 8 * TAU;
    R.dot(x + Math.cos(q) * 10, y + Math.sin(q) * 10, 1.5, 1, 0.25, 0.2, 0.95);
    R.dot(x + Math.cos(q) * 10, y + Math.sin(q) * 10, 0.7, 1, 0.9, 0.9, 0.9);
  }
}

// Undertow: the Z2 caustic bands (same band lines as render/zones.js) brighten over the 30-frame telegraph and
// stream toward the pull side; during the pull they stay lit and keep streaming. Bright dashes travel along each band.
function undertowBands(R, t, F) {
  const p = undertowPhase(t);
  if (p < UNDERTOW_TELE) return;
  const d = undertowDir(t);
  const k = p < UNDERTOW_PULL ? (p - UNDERTOW_TELE + 1) / (UNDERTOW_PULL - UNDERTOW_TELE) : 1 - 0.4 * (p - UNDERTOW_PULL) / (UNDERTOW_CYCLE - UNDERTOW_PULL);
  const flow = F * 1.6 * d;
  for (let b = 0; b < 3; b++) {
    const by = 70 + b * 80 + Math.sin(F * 0.012 + b * 2.1) * 12;
    for (let x = 0; x <= W; x += 5) {
      const y = by + Math.sin(x * 0.045 + F * 0.035 + b * 1.7) * 6 + Math.sin(x * 0.11 - F * 0.02) * 2;
      // a dash every 40 units, moving with the current
      const ph = ((x - flow) % 40 + 40) % 40, dash = ph < 14 ? 1 - ph / 14 : 0;
      R.dot(x, y, 1.9, 0.35, 1, 0.95, (0.22 + 0.55 * dash) * k);
      if (dash > 0.4) R.dot(x - d * 3, y + 1.5, 1.3, 0.85, 1, 1, 0.7 * dash * k);
    }
    // chevrons below each band, pointing with the pull and streaming with it
    for (let j = 0; j < 4; j++) {
      const cx = (((j * 100 + flow) % W) + W) % W, cy = by + 14;
      for (let s = -3; s <= 3; s++) R.dot(cx - d * Math.abs(s) * 2.5, cy + s * 2.2, 1.3, 0.75, 1, 1, 0.75 * k);
    }
  }
}

// Thermals: each column is two thin dotted edge lines (alpha at most 0.25) with dots rising slowly. Not a grid.
function thermalEdges(R, t, F) {
  for (let c = 0; c < 2; c++) {
    const cx = thermalX(t, c);
    for (let s = -1; s <= 1; s += 2) {
      const x = cx + s * THERM_HALF;
      for (let y0 = 0; y0 < H + 12; y0 += 6) {
        const y = ((y0 - F * 0.35) % (H + 12) + H + 12) % (H + 12);
        R.dot(x, y, (y0 % 18) === 0 ? 1.6 : 1.1, 1, 0.85, 0.45, 0.25);
      }
    }
  }
}

export const twistsLayer = {
  id: 'twists',
  draw(R, sim, al, st) {
    const S = sim.ctx, F = R.ui.F, L = leverOf(sim.row);
    if (sim.stageKind === 'normal' && L === 'undertow') undertowBands(R, S.twistT, F);
    if (sim.stageKind === 'normal' && L === 'thermals') thermalEdges(R, S.twistT, F);
    const en = sim.enemies;
    for (let i = 0; i < en.length; i++) {
      const e = en[i];
      if (!e.hunt || e.st !== 'tele' || e.dead) continue;
      huntRing(R, e.px + (e.x - e.px) * al, e.py + (e.y - e.py) * al, e.tele, F);
    }
  }
};
