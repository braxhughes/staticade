// ECLIPSE drawing (v1 look) plus the B.6 telegraphs. A draw layer that only draws while the Eclipse boss is on.
// Telegraphs, all read from sim state:
//   lead-panel glow (phase 1 ring, boss.ringT + boss.lead), aim-lock glow with a line to the locked target point
//   (boss.aimT + boss.aimX/aimY; white core glow for the phase 3 fan), spiral guide lines (phase 2, boss.guideT,
//   faint while the spiral runs), ring source glow (phase 3 ring of 8, boss.ringT).
import { B_HULL, B_CORE, B_PANEL } from '../../sprites.js';
import { aimGlow } from '../core.js';

const TELE = 20, GUIDE = 30;
// a volley still waiting for room under the bullet cap keeps its glow at full until it fires or is skipped
const glow = (t, wait) => t > 0 ? 1 - t / TELE : wait > 0 ? 1 : -1;

export const eclipseLayer = {
  id: 'boss-eclipse',
  draw(R, sim, al) {
    const boss = sim.boss;
    if (!boss.on || boss.id !== 'eclipse') return;
    const dot = R.dot, player = sim.player, F = R.ui.F;
    const x = boss.px + (boss.x - boss.px) * al, y = boss.py + (boss.y - boss.py) * al, rot = boss.rot, sc = boss.scale || 1;
    const phase = boss.phase || 1, pl = 0.5 + 0.5 * Math.sin(F * (phase >= 2 ? 0.3 : 0.08));

    // spiral guide lines (phase 2): bright for the 30 frames before the spiral, faint while it runs
    if (phase === 2 && (boss.guideT > 0 || boss.spiral)) {
      const g = boss.guideT > 0 ? 1 - boss.guideT / GUIDE : 0, a = boss.guideT > 0 ? (0.5 + 0.45 * g) * ((F >> 2) & 1 ? 1 : 0.75) : 0.14;
      for (let k = 0; k < 2; k++) {
        const q = boss.sa + k * Math.PI, c = Math.cos(q), s = Math.sin(q);
        for (let r = 18; r < 160; r += 5) dot(x + c * r, y + s * r, 1.1, 1, .5, .75, a * (1 - r / 190));
      }
    }

    // ring source glow (phase 3): the hull lights gold as the ring of 8 comes due, with its 8 directions marked
    const ringGlow = phase === 3 ? glow(boss.ringT, boss.wRing) : -1;
    for (let i = 0; i < B_HULL.length; i += 2) {
      const r = B_HULL[i] * sc, a = B_HULL[i + 1] - rot * 0.6, X = x + Math.cos(a) * r, Y = y + Math.sin(a) * r;
      if (ringGlow >= 0) dot(X, Y, 1.1, 1, .8 + .2 * ringGlow, .35, .5 + .45 * ringGlow);
      else dot(X, Y, 1, .45 + pl * .1, .3, .85, .75);
    }
    if (ringGlow >= 0) for (let i = 0; i < 8; i++) {
      const q = rot + (i + 0.5) * Math.PI / 4, r = 30 * sc + 4 * ringGlow;
      dot(x + Math.cos(q) * r, y + Math.sin(q) * r, 1, 1, .6, .2, .3 + .4 * ringGlow);
    }

    // panels; in phase 1 the lead panel glows gold before a ring volley
    const lg0 = phase === 1 ? glow(boss.ringT, boss.wRing) : -1, leadOn = lg0 >= 0, lg = leadOn ? lg0 : 0;
    for (let k = 0; k < 8; k++) {
      if (boss.ph[k] <= 0) continue;
      const L = B_PANEL[k], fl = boss.pf[k] > 0, hp = boss.ph[k] / boss.phMax, lead = leadOn && k === boss.lead;
      for (let i = 0; i < L.length; i += 2) {
        const r = L[i] * sc, a = L[i + 1] + rot, teal = ((L[i] - 29) / 2.5 | 0) % 2 === 0, X = x + Math.cos(a) * r, Y = y + Math.sin(a) * r;
        if (fl) dot(X, Y, 1.2, 1, 1, 1, 1);
        else if (lead) dot(X, Y, 1.3, 1, .85, .3 + .4 * lg, .6 + .4 * ((F >> 1) & 1 ? 1 : lg));
        else dot(X, Y, 1.1, teal ? .2 : 1, teal ? .95 : .3, teal ? .9 : .75, 0.45 + 0.55 * hp);
      }
    }
    // the ring volley's lower-half arc glows faintly too, so the whole volley is announced
    if (leadOn) for (let i = 0; i < 20; i++) { const q = (i + 0.5) / 20 * Math.PI; dot(x + Math.cos(q) * 44 * sc, y + Math.sin(q) * 44 * sc, 0.9, 1, .8, .35, .15 + .35 * lg); }

    // core: white glow before the phase 3 fan, otherwise v1 colors (gold when closed, rose once exposed)
    const aimG = glow(boss.aimT, boss.wAim), fanGlow = phase === 3 ? aimG : -1;
    const fl = boss.flash > 0, cg = fl ? 1 : phase >= 2 ? .3 + .3 * pl : .85, cb = fl ? 1 : phase >= 2 ? .3 : .4 + .2 * pl;
    for (let i = 0; i < B_CORE.length; i += 2) {
      const r = B_CORE[i] * sc * (1 + 0.08 * pl), a = B_CORE[i + 1] + F * 0.02, X = x + Math.cos(a) * r, Y = y + Math.sin(a) * r;
      if (fanGlow >= 0) dot(X, Y, 1.1, 1, .7 + .3 * fanGlow, .7 + .3 * fanGlow, 0.55 + 0.4 * fanGlow);
      else dot(X, Y, 1.1, 1, cg, cb, 0.6 + 0.4 * (1 - r / 12));
    }
    if (fanGlow >= 0) for (let k = 0; k < 10; k++) { const q = k / 10 * Math.PI * 2 + F * 0.1, r = 16 - 4 * fanGlow; dot(x + Math.cos(q) * r, y + Math.sin(q) * r, 1, 1, .9, .9, .35 + .5 * fanGlow); }

    // aim-lock glow at the muzzle, with the direction that was locked when the glow started
    if (aimG >= 0) {
      const my = y + 12 * sc, q = Math.atan2(boss.aimY - my, boss.aimX - x), c = Math.cos(q), s = Math.sin(q);
      if (phase !== 3) aimGlow(R, x, my, Math.max(1, boss.aimT));
      const a = 0.45 + 0.5 * aimG, white = phase === 3;
      for (let r = 8; r < 90; r += 5) dot(x + c * r, my + s * r, 1.1, 1, white ? .95 : .3, white ? .95 : .6, a * (1 - r / 100));
    }
    if (boss.entering) return;
    // eye tracking the player
    const ea = Math.atan2(player.y - y, player.x - x);
    dot(x + Math.cos(ea) * 4, y + Math.sin(ea) * 4, 2.6, 0, 0, 0, 0);
  }
};
