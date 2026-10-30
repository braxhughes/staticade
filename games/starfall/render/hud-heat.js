// Heat flame (design.md B.5): a small dot flame just right of the lantern (the kindle meter at the bottom center).
// It grows in 5 steps with heat (sim/heat.js flameStep): heat 0 is an unlit ember, step 1 a low flicker, step 5 a
// tall flame with a white-gold tip. Our own drawing: a teardrop of dots, red at the root, amber in the body, gold
// at the tip, swaying a little (render-only motion from the frame counter). Reads the sim, never writes it.
// A playfield layer (not `hud`), like render/hud-chain.js, so the HUD split stays hud + overlay.
import { H, CX, METER_MAX } from '../defs.js';
import { flameStep } from '../sim/heat.js';

const FX = CX - 22 + (METER_MAX - 1) * 5 + 11;   // 11 units right of the last lantern dot
const FY = H - 4;                                 // flame root
const ROWS = [0, 3, 5, 7, 9, 11];                 // rows of dots per step (1.6 units apart)
const WIDE = [0, 2, 2.6, 3.2, 3.6, 4];            // half-width of the widest row per step

export const heatLayer = {
  id: 'heat',
  draw(R, sim, al, st) {
    if (st === 'results' || sim.heat == null) return;
    const { dot, ui } = R, F = ui.F, s = flameStep(sim.heat);
    if (s === 0) {
      // unlit ember: two dim coals
      dot(FX - 1.2, FY - 1, 1, .45, .18, .12, .7);
      dot(FX + 1.2, FY - 1, 1, .45, .18, .12, .7);
      return;
    }
    const n = ROWS[s], w = WIDE[s];
    for (let r = 0; r < n; r++) {
      const t = r / (n - 1 || 1);                          // 0 at the root, 1 at the tip
      // teardrop profile: widest a third of the way up, a point at the tip
      const half = w * (t < 0.33 ? 0.7 + 0.9 * t : (1 - t) * 1.5);
      const sway = Math.sin(F * 0.21 + r * 0.6) * t * (0.4 + 0.15 * s);
      const y = FY - r * 1.6, x0 = FX + sway;
      // color: red root -> amber body -> gold tip (white-gold at the top steps)
      const cr = 1, cg = 0.3 + 0.6 * t, cb = 0.12 + (s >= 4 ? 0.55 : 0.25) * t * t;
      const a = 0.65 + 0.35 * (1 - t) * (0.8 + 0.2 * Math.sin(F * 0.37 + r));
      const cols = Math.max(0, Math.round(half / 1.4));
      for (let c = -cols; c <= cols; c++) dot(x0 + c * 1.4, y, c === 0 ? 1.25 : 1, cr, cg, cb, c === 0 ? a : a * 0.8);
    }
    // hot core at the top steps
    if (s >= 4) dot(FX, FY - 2.4, 1.2, 1, .95, .7, 0.75 + 0.25 * Math.sin(F * 0.5));
  }
};
