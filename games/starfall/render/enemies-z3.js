// Z3 enemy visuals (design.md B.3, B.9): the Mirage's two copies and their 12-frame cross-fade, the Cinder's
// hanging ember telegraph, and the "snuffed" cue when the 48-unit rule eats an ember. Dots only.
// Reads the sim, never writes it. The Mirage draw is attached to its registered def here (render side), so the
// sim files stay free of render imports. No white-core round dots (that look is enemy bullets only, rule 1).
import { TAU } from '../defs.js';
import { artFor } from '../sprites.js';
import { enemyTypes } from '../sim/registry.js';
import { mirageSide, mirageT, MIRAGE_GAP, MIRAGE_FADE } from '../sim/enemies/mirage.js';
import { EMBER_TELE, EMBER_N, EMBER_SAFE } from '../sim/enemies/cinder.js';

const HALF = MIRAGE_GAP / 2, GHOST = 0.3, SNUFF_T = 45;

// Mirage: the solid copy at full alpha, the ghost faint and slightly hazy. During the fade the copy that is
// becoming solid brightens from the first fade frame (the hit state has already switched to it).
function drawMirage(R, e, al, sim) {
  const S = sim.ctx, x = e.px + (e.x - e.px) * al, y = e.py + (e.y - e.py) * al;
  const T = artFor('mirage'), m = Math.min(sim.mult - 1, 3), pal = T.pals[m];
  const fr = ((R.ui.F + e.phase) / (e.fast ? 5 : 16) | 0) & 1, spr = fr ? T.B : T.A;
  const side = mirageSide(S, e), t = mirageT(S, e);
  const f = t < MIRAGE_FADE ? Math.min(1, (t + 1) / MIRAGE_FADE) : 1;
  const aSolid = GHOST + (1 - GHOST) * f, aGhost = 1 - (1 - GHOST) * f;
  const hz = 1 + 0.12 * (1 - f) + 0.04 * Math.sin(R.ui.F * 0.4);
  R.drawSpr(spr, x - side * HALF, y, e.ang, pal, 1, aGhost, false, e.asm * hz);
  R.drawSpr(spr, x + side * HALF, y, e.ang, pal, 1, aSolid, e.flash > 0, e.asm);
  // a faint heat thread between the copies
  for (let k = -3; k <= 3; k++) R.dot(x + k * 3.5, y + Math.sin(R.ui.F * 0.2 + k) * 1.2, 0.7, 1, .5, .65, 0.18);
  // the core layer draws the dive / aim glow at the midpoint; ring both copies too so the telegraph reads
  if (e.st === 'tele') for (let s = -1; s <= 1; s += 2) ring(R, x + s * HALF, y, 9, 10, 1, .7, .25, 0.55);
}
if (enemyTypes.mirage) enemyTypes.mirage.draw = drawMirage;

function ring(R, x, y, r, n, cr, cg, cb, a) {
  const F = R.ui.F;
  for (let k = 0; k < n; k++) { const q = k / n * TAU + F * 0.12; R.dot(x + Math.cos(q) * r, y + Math.sin(q) * r, 1.1, cr, cg, cb, a); }
}

export const z3EnemiesLayer = {
  id: 'enemies-z3',
  draw(R, sim) {
    const S = sim.ctx, E = S && S.embers;
    if (!E) return;
    const F = R.ui.F;
    // hanging embers: a crimson ring closing in on a flickering gold coal as the drop comes due
    for (let i = 0; i < EMBER_N; i++) {
      if (!E.on[i]) continue;
      const x = E.x[i], y = E.y[i], k = Math.min(1, E.age[i] / EMBER_TELE), r = 11 - 7 * k;
      ring(R, x, y, r, 10, 1, .55 + .3 * k, .2, 0.6 + 0.4 * k);
      const fl = 0.6 + 0.4 * (((F >> 1) & 1) ? 1 : 0.5);
      R.dot(x, y, 2, 1, .6 + .3 * k, .15, fl);
      R.dot(x, y + 3 + k * 2, 0.9, 1, .85, .3, 0.5 * k);
    }
    // snuffed: the Cinder died within 48 units, so its ember went out; a grey wisp and the 48-unit ring
    const dt = E.snuffAge;
    if (dt < SNUFF_T) {
      const a = 1 - dt / SNUFF_T, p = S.player;
      for (let k = 0; k < 6; k++) R.dot(E.snuffX + Math.sin(k * 2.1 + dt * 0.1) * 3, E.snuffY - dt * 0.4 - k * 2, 1.2, .55, .5, .5, a * (1 - k / 7));
      for (let k = 0; k < 32; k++) { const q = k / 32 * TAU; R.dot(p.x + Math.cos(q) * EMBER_SAFE, p.y + Math.sin(q) * EMBER_SAFE, 1.3, 1, .9, .45, a); }
    }
  }
};
