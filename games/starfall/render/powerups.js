// Power-up visuals (design.md B.2, B.9): the Lamplighter's lit lantern, the falling glyph, and the held
// power (HALO ring, LANCE sheath, pending ECHO marks, FAN wingtips, and its name). Dots only.
// Reads the sim, never writes it. Drawn after the enemies and before the player, shots and bullets.
// No white-core round dots here (that look belongs to enemy bullets only, B.9 rule 1).
import { W, H, TAU } from '../defs.js';
import { glyphType, HALO_R, HALO_HITS, HALO_LOST_T, ECHO_DELAY, GLYPH_CYCLE, POWER_FRAMES } from '../sim/powerups.js';

export const BAR_DOTS = 30, BAR_X = 8, BAR_STEP = 2, BAR_BLINK = 120;   // B.10 timer bar: 30 dots just above the lives row (the CRT bezel hides the bottom edge)

export const POWER_COL = {
  fan: [1, .82, .3],     // gold
  lance: [.72, .5, 1],   // violet
  halo: [.3, .95, .88],  // teal
  echo: [.55, 1, .45]    // green
};
const COL_ROSE = [1, .4, .55];
const NAMES = { fan: 'FAN', lance: 'LANCE', halo: 'HALO', echo: 'ECHO' };
const HALO_NAMES = []; for (let i = 0; i <= HALO_HITS; i++) HALO_NAMES.push('HALO ' + i + '/' + HALO_HITS);

// glyph icons: dot offsets (x, y pairs) on a small grid, one shape per power
const ICON = {
  fan: [0, -4, 0, -2, 0, 0, -2, -3, -3.5, -4.5, 2, -3, 3.5, -4.5, 0, 2],
  lance: [0, -5, 0, -3, 0, -1, 0, 1, 0, 3, -1.5, -3.5, 1.5, -3.5],
  halo: [],
  echo: [-3, -1, -1.5, -2.5, 0, -4, 1.5, -2.5, 3, -1, -3, 3, -1.5, 1.5, 0, 0, 1.5, 1.5, 3, 3]
};
for (let k = 0; k < 8; k++) ICON.halo.push(Math.cos(k / 8 * TAU) * 3.5, Math.sin(k / 8 * TAU) * 3.5);

function drawGlyph(R, g, al) {
  const dot = R.dot, F = R.ui.F, x = g.px + (g.x - g.px) * al, y = g.py + (g.y - g.py) * al;
  const id = glyphType(g), c = POWER_COL[id], pulse = 0.75 + 0.25 * Math.sin(F * 0.3);
  // soft glow, then a dotted diamond frame turning slowly
  dot(x, y, 6, c[0], c[1], c[2], 0.16 * pulse);
  for (let k = 0; k < 16; k++) {
    const q = k / 16 * TAU + F * 0.04, cq = Math.cos(q), sq = Math.sin(q), d = 9 / (Math.abs(cq) + Math.abs(sq));
    dot(x + cq * d, y + sq * d, 1.15, c[0], c[1], c[2], 0.95 * pulse);
  }
  const ic = ICON[id];
  for (let i = 0; i < ic.length; i += 2) dot(x + ic[i] * 1.2, y + ic[i + 1] * 1.2, 1.3, c[0], c[1], c[2], 1);
  // cycle pips: frames left before the type changes (4 dots that go out one by one)
  const left = GLYPH_CYCLE - (g.t % GLYPH_CYCLE), n = Math.ceil(left / (GLYPH_CYCLE / 4));
  for (let k = 0; k < 4; k++) dot(x - 4.5 + k * 3, y + 12, 0.8, c[0], c[1], c[2], k < n ? 0.8 : 0.15);
}

export const powerupsLayer = {
  id: 'powerups',
  draw(R, sim, al, st) {
    const S = sim.ctx, dot = R.dot, F = R.ui.F;
    // the Lamplighter's lantern: a warm flickering light above it
    const en = sim.enemies;
    for (let i = 0; i < en.length; i++) {
      const e = en[i];
      if (e.type !== 'lamplighter' || e.st === 'wait' || e.dead) continue;
      const x = e.px + (e.x - e.px) * al, y = e.py + (e.y - e.py) * al - 9, f = 0.8 + 0.2 * Math.sin(F * 0.37 + e.phase);
      dot(x, y, 3.2, 1, .6, .15, 0.22 * f);
      dot(x, y, 1.7, 1, .78, .3, 0.95 * f);
      dot(x, y + 2.2, 0.8, .8, .55, .25, 0.8);
    }
    if (S.glyph.on) drawGlyph(R, S.glyph, al);
    // LANCE shots: a violet sheath behind the streak
    for (const p of sim.ps) if (p.on && p.pw === 'lance') {
      const x = p.px + (p.x - p.px) * al, y = p.py + (p.y - p.py) * al;
      for (let k = 0; k < 4; k++) dot(x, y + 4 + k * 2.2, 1.3 - k * 0.2, .72, .5, 1, 0.6 - k * 0.12);
    }
    // ECHO: the spot each echo will fire from, a ring closing in as it comes due
    for (let i = 0; i < S.echoN; i++) {
      const ex = S.echoQ[i * 3], ey = S.echoQ[i * 3 + 1], t = S.echoQ[i * 3 + 2], r = 1.5 + t / ECHO_DELAY * 4;
      for (let k = 0; k < 6; k++) { const q = k / 6 * TAU; dot(ex + Math.cos(q) * r, ey + Math.sin(q) * r, 0.8, .55, 1, .45, 0.55); }
    }
    const pw = S.power, P = sim.player;
    // HALO used up: the ring bursts outward in rose and 'HALO LOST' fades above the ship (B.9: a loss must read)
    if (S.haloLostT > 0 && P.alive) {
      const k = 1 - S.haloLostT / HALO_LOST_T, lx = P.px + (P.x - P.px) * al, r = HALO_R + k * 14, a = 0.9 * (1 - k);
      for (let i = 0; i < 16; i++) { const q = i / 16 * TAU; dot(lx + Math.cos(q) * r, P.y + Math.sin(q) * r, 1, 1, .4, .55, a); }
      R.text('HALO LOST', lx, P.y - 40 - k * 6, COL_ROSE, 1, 'c', Math.min(1, 1.6 * (1 - k)));
    }
    if (!pw || !P.alive || st === 'gameover' || st === 'results') return;
    const c = POWER_COL[pw], px = P.px + (P.x - P.px) * al, py = P.y + P.recoil;
    if (pw === 'halo') {
      // the ring shows the absorb radius; one bright arc per absorb left
      for (let k = 0; k < 24; k++) {
        const q = k / 24 * TAU + F * 0.05, lit = (k / 8 | 0) < S.haloHits;
        dot(px + Math.cos(q) * HALO_R, py + Math.sin(q) * HALO_R, lit ? 1 : 0.7, c[0], c[1], c[2], lit ? 0.85 : 0.2);
      }
    } else if (pw === 'fan') {
      dot(px - 6, py - 1, 1, c[0], c[1], c[2], 0.8); dot(px + 6, py - 1, 1, c[0], c[1], c[2], 0.8);
    } else if (pw === 'lance') {
      dot(px, py - 9, 1.1, c[0], c[1], c[2], 0.7 + 0.3 * Math.sin(F * 0.4));
    } else if (pw === 'echo') {
      dot(px - 3, py - 9, 0.9, c[0], c[1], c[2], 0.7); dot(px + 3, py - 9, 0.9, c[0], c[1], c[2], 0.7);
    }
    // B.10 timer bar: dots left of the 900 frames, just above the lives row (the CRT bezel hides the bottom edge); blinks for the last 120 frames
    const left = S.powerT, lit = Math.ceil(left / POWER_FRAMES * BAR_DOTS), by = H - 15;
    if (left > BAR_BLINK || F % 8 < 4) {
      for (let k = 0; k < BAR_DOTS; k++) dot(BAR_X + k * BAR_STEP, by, 1.1, c[0], c[1], c[2], k < lit ? 0.95 : 0.22);
    }
    // held power name, bottom right above the stage badges
    R.text(pw === 'halo' ? HALO_NAMES[S.haloHits] : NAMES[pw], W - 8, H - 22, c, 1, 'r', 0.9);
  }
};
