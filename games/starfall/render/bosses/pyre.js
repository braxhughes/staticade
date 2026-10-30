// PYRE drawing (design.md B.6) plus every telegraph, all read from sim state. Draw layer only; never writes the sim.
//   hollow sun: a corona ring of dots around a dark core; the core opens (rose, white-hot) on the exhale and in phase 3
//   petals: 12 flame petals on the crown; a petal about to detach brightens to gold and wobbles (fSt 1, 40 frames);
//           detached petals dive pointing along their flight, with an aim-lock glow (fAimT / fWait)
//   aim-lock glow at the muzzle with a line to the locked target point (aimT / wAim; white for the phase 3 5-way)
//   arc ring (phase 2): gold gap marker on the player's row; for the 24 frames before a ring (ringT) it brightens,
//           brackets the gap where it will lock (reach clamp included) and the corona glows gold
//   pull (inhale): dust streams sideways into the sun's column and each pulled shot shows a bent trail
//   exhale telegraph: the core glows rose for 20 frames with the 16 burst directions marked (burstT / wBurst)
//   phase 3 spiral guide lines for 30 frames after the quiet period (guideT), faint while the spiral runs
import { aimGlow } from '../core.js';

const TAU = Math.PI * 2, NP = 12, ROW = 274, REACH = 200, GAP = 24;
const glow = (t, n, wait) => t > 0 ? 1 - t / n : wait > 0 ? 1 : -1;

// one flame petal: base at (x, y), pointing along angle a, length L; c = 0..1 telegraph brightness, fl = hit flash
function petal(dot, x, y, a, L, hp, c, fl, F, k) {
  const ca = Math.cos(a), sa = Math.sin(a), nx = -sa, ny = ca;
  for (let i = 0; i < 6; i++) {
    const u = i / 5, d = u * L, w = (1 - u) * 2.6 * (L / 12) + 0.3, flick = 0.8 + 0.2 * Math.sin(F * 0.3 + k * 1.7 + i);
    for (let s = -1; s <= 1; s++) {
      if (s !== 0 && w < 0.9) continue;
      const X = x + ca * d + nx * s * w, Y = y + sa * d + ny * s * w;
      if (fl) dot(X, Y, 1.2, 1, 1, .85, 1);
      else if (c > 0) dot(X, Y, 1.3, 1, .85 + .15 * c, .35 + .45 * c, (.65 + .35 * c) * flick);
      else dot(X, Y, 1.15, 1, .45 + .4 * u, .12 + .2 * u, (.5 + .5 * hp) * flick);
    }
  }
}

export const pyreLayer = {
  id: 'boss-pyre',
  draw(R, sim, al) {
    const boss = sim.boss;
    if (!boss.on || boss.id !== 'pyre') return;
    const dot = R.dot, F = R.ui.F, player = sim.player, ps = sim.ps;
    const x = boss.px + (boss.x - boss.px) * al, y = boss.py + (boss.y - boss.py) * al, sc = boss.scale || 1, rot = boss.rot;
    const phase = boss.phase || 1, open = phase === 3 || (phase === 2 && boss.breath === 2), inhale = phase === 2 && boss.breath === 1;
    const ringG = phase === 2 ? glow(boss.ringT, 24, 0) : -1, burstG = phase === 2 ? glow(boss.burstT, 20, boss.wBurst) : -1;

    // pull: dust streams flowing sideways into the sun's column, and bent trails on pulled shots
    if (inhale) {
      // the sun breathes in: rows of embers drift sideways into its column
      for (let r = 0; r < 9; r++) {
        const ry = 110 + r * 18;
        for (let j = 0; j < 10; j++) {
          const u = ((F * 0.012 + j / 10 + r * 0.13) % 1), side = (j & 1) ? 1 : -1, d = 200 * (1 - u);
          dot(x + side * d, ry + Math.sin(u * 6 + r) * 2, 1.1, 1, .8, .45, 0.15 + 0.5 * u);
          dot(x + side * (d + 4), ry + Math.sin(u * 6 + r) * 2, 0.8, 1, .8, .45, 0.08 + 0.25 * u);
        }
      }
    }
    if (boss.sVx) for (let i = 0; i < ps.length; i++) {
      const p = ps[i], v = boss.sVx[i];
      if (!p.on || Math.abs(v) < 0.05) continue;
      // a pulled shot leaves a bent trail behind it (the path it curved along)
      const sx = p.px + (p.x - p.px) * al, sy = p.py + (p.y - p.py) * al;
      for (let k = 1; k <= 8; k++) dot(sx - v * k * 1.6 - v * k * k * 0.12, sy + k * 5, 1.1, 1, .85, .5, 0.7 * (1 - k / 9));
    }

    // phase 3 spiral guide lines: bright for the 30 frames before the spiral, faint while it runs
    if (phase === 3 && (boss.guideT > 0 || boss.spiral)) {
      const g = boss.guideT > 0 ? 1 - boss.guideT / 30 : 0, a = boss.guideT > 0 ? (0.5 + 0.45 * g) * ((F >> 2) & 1 ? 1 : 0.75) : 0.14;
      for (let k = 0; k < 3; k++) {
        const q = boss.sa + k * TAU / 3, c = Math.cos(q), s = Math.sin(q);
        for (let r = 16; r < 160; r += 5) dot(x + c * r, y + s * r, 1.1, 1, .6, .7, a * (1 - r / 190));
      }
    }

    // corona: the sun's rim; gold before a ring, rose before the exhale burst
    const n = 28, rr = 20 * sc;
    for (let i = 0; i < n; i++) {
      const q = i / n * TAU - rot * 0.5, fl = 1 + 0.12 * Math.sin(F * 0.2 + i * 2.3), X = x + Math.cos(q) * rr * fl, Y = y + Math.sin(q) * rr * fl;
      if (ringG >= 0) dot(X, Y, 1.3, 1, .75 + .2 * ringG, .25, .55 + .45 * ringG);
      else if (burstG >= 0) dot(X, Y, 1.3, 1, .35, .5 + .2 * burstG, .55 + .45 * burstG);
      else dot(X, Y, 1.2, 1, .55 + .25 * (i & 1), .25, .8);
    }
    // core: dark when closed; open on the exhale / phase 3 (rose, white-hot when hit)
    const cg = burstG >= 0 ? burstG : 0;
    for (let i = 0; i < 18; i++) {
      const q = i / 18 * TAU + F * 0.03, r = (4 + (i % 3) * 3.5) * sc, X = x + Math.cos(q) * r, Y = y + Math.sin(q) * r;
      if (boss.flash > 0) dot(X, Y, 1.2, 1, .95, .9, 1);
      else if (open) dot(X, Y, 1.2, 1, .45 + .25 * Math.sin(F * 0.25), .55, .8);
      else dot(X, Y, 1.1, .3 + .7 * cg, .05 + .25 * cg, .1 + .35 * cg, .35 + .5 * cg);
    }
    if (burstG >= 0) for (let i = 0; i < 16; i++) {
      const q = (boss.rings || 0) * 0.2 + (i + 0.5) * TAU / 16, r = 24 * sc + 6 * burstG;
      dot(x + Math.cos(q) * r, y + Math.sin(q) * r, 1.3, 1, .4, .6, .35 + .6 * burstG);
    }

    // attached petals (crown), with the detach telegraph (brighten + wobble)
    for (let k = 0; k < NP; k++) {
      const st = boss.fSt[k];
      if (st > 1 || boss.fHp[k] <= 0) continue;
      const tele = st === 1, c = tele ? 1 - boss.fT[k] / 40 : 0, wob = tele ? Math.sin(F * 0.9 + k) * (0.08 + 0.1 * c) : 0;
      const a = rot + k * TAU / NP + wob, r0 = 24 * sc + (tele ? 2 * c : 0);
      petal(dot, x + Math.cos(a) * r0, y + Math.sin(a) * r0, a, 12 * sc * (tele ? 1 + 0.25 * c : 1), boss.fHp[k] / boss.fMax, tele ? Math.max(0.2, c) : 0, boss.fFl[k] > 0, F, k);
    }
    // diving petals with their aim-lock glow
    for (let k = 0; k < NP; k++) {
      if (boss.fSt[k] !== 2) continue;
      const px = boss.fPx[k] + (boss.fX[k] - boss.fPx[k]) * al, py = boss.fPy[k] + (boss.fY[k] - boss.fPy[k]) * al;
      const a = Math.atan2(boss.fVy[k], boss.fVx[k]) + Math.PI;
      petal(dot, px - Math.cos(a) * 5, py - Math.sin(a) * 5, a, 12, boss.fHp[k] / boss.fMax, 0, boss.fFl[k] > 0, F, k);
      if (boss.fAimT[k] > 0 || boss.fWait[k] > 0) {
        aimGlow(R, px, py + 6, Math.max(1, boss.fAimT[k]));
        for (let j = 0; j < 8; j++) { const q = j / 8 * TAU + F * 0.15, rr = 9 - 3 * (1 - boss.fAimT[k] / 20); dot(px + Math.cos(q) * rr, py + Math.sin(q) * rr, 1.1, 1, .9, .35, .7); }
        const q = Math.atan2(boss.fAimY[k] - py - 4, boss.fAimX[k] - px), c = Math.cos(q), si = Math.sin(q), g = 1 - boss.fAimT[k] / 20;
        for (let r = 8; r < 50; r += 5) dot(px + c * r, py + 4 + si * r, 1.3, 1, .9, .35, (0.45 + 0.5 * g) * (1 - r / 60));
      }
    }

    // boss aim-lock glow at the muzzle, with the direction locked when the glow started
    const aimG = glow(boss.aimT, 20, boss.wAim);
    if (aimG >= 0) {
      const my = y + 12 * sc, q = Math.atan2(boss.aimY - my, boss.aimX - x), c = Math.cos(q), s = Math.sin(q), white = phase === 3;
      aimGlow(R, x, my, Math.max(1, boss.aimT));
      for (let r = 8; r < 90; r += 5) dot(x + c * r, my + s * r, 1.1, 1, white ? .95 : .9, white ? .95 : .35, (0.45 + 0.5 * aimG) * (1 - r / 100));
    }

    // arc ring gap marker on the player's row (phase 2)
    if (phase === 2 && !boss.entering) {
      const mk = boss.mk, tele = ringG >= 0;
      if (tele) {
        // where the gap will lock: the marker, pulled to within 200 units of the player
        let g = mk; const pxp = player.x;
        if (g - pxp > REACH) g = pxp + REACH; else if (pxp - g > REACH) g = pxp - REACH;
        const a = 0.65 + 0.35 * ringG;
        for (let s = -1; s <= 1; s += 2) for (let j = 0; j < 7; j++) dot(g + s * (GAP + 1), ROW - 14 + j * 4, 1.3, 1, .85, .3, a);
        for (let xx = 0; xx <= 400; xx += 8) if (Math.abs(xx - g) > GAP + 2) dot(xx, ROW + 9, 1, 1, .5, .3, 0.3 + 0.4 * ringG);
        // source glow: dotted rays from the core toward both ends of the gap
        for (let s = -1; s <= 1; s += 2) {
          const tx = g + s * GAP, q = Math.atan2(ROW - y, tx - x), c = Math.cos(q), si = Math.sin(q);
          for (let r = 18; r < 60; r += 6) dot(x + c * r, y + si * r, 1, 1, .8, .3, a * (1 - r / 70));
        }
      } else if (boss.breath === 1 && boss.gapX >= 0) {
        // the locked gap of the ring in flight, faint
        for (let s = -1; s <= 1; s += 2) dot(boss.gapX + s * (GAP + 1), ROW + 9, 1, 1, .8, .3, 0.35);
      }
      const big = tele ? 3 : 1.6, pulse = tele ? ((F >> 1) & 1 ? 1 : 0.75) : 0.55;
      dot(mk, ROW + 9, big, 1, .85, .25, pulse);
      dot(mk, ROW + 9, big * 0.5, 1, .95, .6, pulse);
    }
  }
};
