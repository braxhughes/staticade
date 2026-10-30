// MOONWELL drawing plus its B.6 telegraphs. A draw layer that only draws while the Moonwell boss is on.
// Reads sim state only (sim/bosses/moonwell.js):
//   tip fill (phase 1 bubble: mw.tTele / mw.tWait, the tip fills white over 20 frames), aim-lock glow with a line to
//   the locked point (boss.aimT / wAim, aimX / aimY), gap glow (phase 2: boss.wallT, boss.gapX, 30 frames before
//   each wall), open lens (boss.lensT), shard glow before its ring (phase 3: mw.sTele / mw.sWait), diving shard
//   flash and wobble (boss.dState 1, boss.dT, 30 frames) with a line to the dive target.
// Cut tendrils and the bell's fall-out are drawn as dim debris (alpha <= 0.7, never white-core; B.9 rule 4).
import { aimGlow } from '../core.js';
import { COL } from '../../sprites.js';
import { MOONWELL as M } from '../../sim/bosses/moonwell.js';

const TELE = 20, PI = Math.PI, TAU = 2 * PI;
const glow = (t, wait, n = TELE) => t > 0 ? 1 - t / n : wait > 0 ? 1 : -1;

export const moonwellLayer = {
  id: 'boss-moonwell',
  draw(R, sim, al) {
    const boss = sim.boss;
    if (!boss.on || boss.id !== 'moonwell' || !boss.mw) return;
    const dot = R.dot, F = R.ui.F, mw = boss.mw;
    const x = boss.px + (boss.x - boss.px) * al, y = boss.py + (boss.y - boss.py) * al;
    const phase = boss.phase || 1, pl = 0.5 + 0.5 * Math.sin(F * 0.06);

    // cut tendrils: dim chains that sink and fade (harmless debris)
    for (let k = 0; k < 6; k++) {
      const t = mw.cutT[k];
      if (t < 0 || t >= 110) continue;
      const a = 0.7 * (1 - t / 110), fy = 0.012 * t * t + 0.4 * t, sx = (k - 2.5) * 0.25 * t;
      for (let i = 0; i < 7; i++) dot(mw.cutX[k] + sx * (1 - i / 9) + Math.sin(t * 0.1 + i) * 1.5, mw.cutY[k] - i * 6 + fy * (1 - i * 0.05), 1, .4, .7, 1, a * (1 - i * 0.08));
    }

    // gap glow (phase 2): the row where the wall will appear lights up faintly, the gap brightly
    if (phase === 2 && boss.wallT > 0) {
      const g = 1 - boss.wallT / M.wallGlow, blink = (F >> 2) & 1 ? 1 : 0.7;
      for (let k = 0; k < M.wallSlots; k++) {
        const wx = M.wallX0 + M.wallStep * k;
        if (wx >= boss.gapX - M.gapHalf && wx < boss.gapX + M.gapHalf) continue;
        dot(wx, M.wallY, 0.9, .5, .55, .95, 0.2 + 0.35 * g);
      }
      for (let s = -1; s <= 1; s += 2) {
        const ex = boss.gapX + s * M.gapHalf;
        for (let j = 0; j < 10; j++) dot(ex, M.wallY - 10 + j * 3, 1.5, .3, 1, .85, (0.55 + 0.45 * g) * blink * (1 - j / 14));
        for (let j = 1; j < 4; j++) dot(ex - s * j * 2.5, M.wallY - 10 - j * 2.5, 1.3, .3, 1, .85, (0.5 + 0.5 * g) * blink);
      }
      for (let i = 0; i < 9; i++) dot(boss.gapX - 16 + i * 4, M.wallY, 1.3, .3, 1, .85, (0.4 + 0.5 * g) * blink);
      // a light shaft down through the gap, so it reads where the ship should be
      for (let j = 1; j < 30; j++) dot(boss.gapX + Math.sin(j * 0.7 + F * 0.1) * 6, M.wallY + j * 6, 1, .3, .9, .85, (0.15 + 0.3 * g) * (1 - j / 32));
    }

    // tendrils (phase 1, and during the entrance)
    if (phase === 1) {
      for (let k = 0; k < 6; k++) {
        if (mw.th[k] <= 0) continue;
        const a = M.swing * Math.sin(boss.t * M.swingW + k * 0.9), hp = mw.th[k] / boss.tMax, fl = mw.tf[k] > 0;
        let cx = x + (k - 2.5) * 6.4, cy = y + 12;
        for (let i = 1; i <= M.links; i++) {
          const q = a * (0.35 + 0.65 * i / M.links); cx += Math.sin(q) * M.link; cy += Math.cos(q) * M.link;
          if (i < M.links) dot(cx, cy, 1.2, fl ? 1 : .5, fl ? 1 : .85, 1, 0.65 + 0.3 * hp);
        }
        // tip: fills white over the 20 frames before its bubble
        const fill = glow(mw.tTele[k], mw.tWait[k]);
        // tip: a ring of 8 dots that fills white, dot by dot, over the 20 frames before its bubble
        const lit = fill >= 0 ? Math.ceil(fill * 8) : 0;
        for (let d = 0; d < 8; d++) {
          const q = d / 8 * TAU - PI / 2, X = cx + Math.cos(q) * 3.4, Y = cy + Math.sin(q) * 3.4;
          if (fl || d < lit) dot(X, Y, 1.2, 1, 1, 1, 1);
          else dot(X, Y, 1.1, .35, .75 + .2 * pl, 1, 0.6 + 0.4 * hp);
        }
        if (fill >= 0) dot(cx, cy, 1.6 + 1.4 * fill, .6 + .4 * fill, .9, 1, .35 + .45 * fill);
      }
    }

    // the bell: a glass dome (rim at y + 12) that flips upside down in phase 2
    if (phase < 3) {
      const fl = boss.flash > 0, f = Math.cos(Math.min(1, boss.flip || 0) * PI); // 1 hanging, -1 flipped
      for (let ring = 0; ring < 3; ring++) {
        const r = M.bellR - ring * 6, n = 18 - ring * 4;
        for (let i = 0; i <= n; i++) {
          const q = PI + i / n * PI, bx = x + Math.cos(q) * r, by = y + 4 + Math.sin(q) * r * 0.85 * f;
          dot(bx, by, 1.1, fl ? 1 : .35 + .15 * ring, fl ? 1 : .55 + .1 * pl, 1, 0.55 + 0.15 * ring);
        }
      }
      for (let i = -10; i <= 10; i++) dot(x + i * 2.1, y + 4, 1, .55, .7, 1, .8);
    }

    // the lens (phase 2): open for 60 frames after each wall, shut (iris blades) otherwise
    if (phase === 2) {
      const ly = y + 4, open = boss.lensT > 0, o = open ? Math.min(1, boss.lensT / 8) : 0, hp = boss.lens / boss.lensMax;
      for (let i = 0; i < 16; i++) {
        const q = i / 16 * TAU + F * 0.03;
        dot(x + Math.cos(q) * M.lensR, ly + Math.sin(q) * M.lensR, 1.1, open ? .4 : .35, open ? 1 : .4, open ? .9 : .7, open ? .9 : .6);
      }
      if (open) {
        for (let i = 0; i < 10; i++) { const q = i / 10 * TAU - F * 0.08, r = 4 + 2 * o; dot(x + Math.cos(q) * r, ly + Math.sin(q) * r, 1.2, .6, 1, 1, .9); }
        dot(x, ly, 2.4 * o + 1, 1, .85, .45 + .2 * hp, 1);
        // open time left, as a shrinking arc
        const n = Math.ceil(boss.lensT / M.lensOpen * 20);
        for (let i = 0; i < n; i++) { const q = -PI / 2 + i / 20 * TAU; dot(x + Math.cos(q) * 14, ly + Math.sin(q) * 14, 0.8, .3, 1, .85, .6); }
      } else {
        for (let b = 0; b < 6; b++) { const q = b / 6 * TAU + 0.4; for (let r = 2; r < M.lensR; r += 2.5) dot(x + Math.cos(q + r * 0.08) * r, ly + Math.sin(q + r * 0.08) * r, 0.9, .4, .35, .7, .7); }
      }
    }

    // shards (phase 3): three glass splinters orbiting the center
    if (phase === 3) {
      for (let i = 0; i < 3; i++) {
        if (mw.sh[i] <= 0) continue;
        let sx = mw.sx[i], sy = mw.sy[i];
        const diveTele = boss.dK === i && boss.dState === 1, fl = mw.sf[i] > 0, hp = mw.sh[i] / boss.shMax;
        if (diveTele) { sx += Math.sin(F * 0.9) * 2.5; sy += Math.cos(F * 1.3) * 1.5; }
        const rg = glow(mw.sTele[i], mw.sWait[i]), flashOn = diveTele && ((F >> 1) & 1);
        const rot = boss.rot * 3 + i * 2.1;
        for (let v = 0; v < 3; v++) {
          const q0 = rot + v * TAU / 3, q1 = rot + (v + 1) * TAU / 3;
          for (let ring = 0; ring < 2; ring++) {
            const R0 = ring ? 6 : 12, n = ring ? 4 : 7;
            for (let s = 0; s < n; s++) {
              const u = s / n, px = sx + (Math.cos(q0) * (1 - u) + Math.cos(q1) * u) * R0, py = sy + (Math.sin(q0) * (1 - u) + Math.sin(q1) * u) * R0;
              if (fl || flashOn) dot(px, py, 1.3, 1, 1, 1, 1);
              else if (rg >= 0) dot(px, py, 1.3, 1, .75 + .2 * rg, .35, .7 + .3 * rg);
              else dot(px, py, 1.2, ring ? .7 : .45, ring ? .9 : .8 + .2 * pl, 1, 0.65 + 0.35 * hp);
            }
          }
        }
        dot(sx, sy, 1.8, .8, .6, 1, .85);
        // ring source glow: the 6 directions the ring will take
        if (rg >= 0) for (let n = 0; n < 6; n++) {
          const q = boss.rot + (n + 0.5) * TAU / 6;
          for (let r = 15; r < 15 + 8 * rg + 1; r += 3) dot(sx + Math.cos(q) * r, sy + Math.sin(q) * r, 1.2, 1, .7, .25, .45 + .5 * rg);
        }
        // dive telegraph: a line to the point the shard will dive at
        if (diveTele) {
          const g = 1 - boss.dT / M.diveTele, q = Math.atan2(boss.dAimY - sy, boss.dAimX - sx), c = Math.cos(q), s = Math.sin(q);
          for (let r = 14; r < 170; r += 5) dot(sx + c * r, sy + s * r, 1.3, 1, .35, .5, (0.5 + 0.5 * g) * (1 - r / 190));
        }
      }
      if (boss.phT < 80) R.text('SHATTER', x, y - 64, COL.rose, 1.2, 'c', Math.min(1, (80 - boss.phT) / 20));
    }

    // aim-lock glow at the muzzle, with the direction locked when the glow started
    const aimG = glow(boss.aimT, boss.wAim);
    if (aimG >= 0 && phase < 3) {
      const my = y + 16, q = Math.atan2(boss.aimY - my, boss.aimX - x), c = Math.cos(q), s = Math.sin(q);
      aimGlow(R, x, my, Math.max(1, boss.aimT));
      for (let r = 8; r < 90; r += 5) dot(x + c * r, my + s * r, 1.1, 1, .3, .6, (0.45 + 0.5 * aimG) * (1 - r / 100));
    }
  }
};
