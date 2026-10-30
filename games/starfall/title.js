// Title screen: logo dots that assemble with springs, the menu, how-to-play and best-score pages.
import { FONT, textW } from '../../engine/font.js';
import { W, H, CX, PI, TAU, STATS } from './defs.js';
import { ART, PLAYER, PAL_PLAYER, COL } from './sprites.js';

const rnd = Math.random;
export const MENU = ['FREE PLAY', 'DAILY FLIGHT', 'HOW TO PLAY', 'SOUND', 'CRT', 'BEST FLIGHT'];

export function createTitle({ dot, text, drawSpr, panel, fx, ui }) {
  const LOGO = [];
  (function buildLogo() {
    const str = 'STARFALL', sc = 4.6, w = textW(str, sc), x0 = CX - w / 2, y0 = 26;
    for (let i = 0; i < str.length; i++) {
      const g = FONT[str[i]];
      for (let r = 0; r < 7; r++) for (let b = 0; b < 5; b++) if ((g[r] >> (4 - b)) & 1) {
        for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
          const tx = x0 + i * 6 * sc + b * sc + (sx - 1) * sc * 0.33, ty = y0 + r * sc + (sy - 1) * sc * 0.33;
          LOGO.push({ tx, ty, x: rnd() * W, y: rnd() * H, vx: 0, vy: 0, i, r });
        }
      }
    }
  })();
  function scatter() { for (const d of LOGO) { d.x = rnd() * W; d.y = rnd() * H * 1.2 - 40; d.vx = (rnd() - .5) * 4; d.vy = (rnd() - .5) * 4; } }
  scatter();

  function update() {
    const F = ui.F;
    for (const d of LOGO) {
      const tx = d.tx + Math.sin(F * 0.03 + d.ty * 0.2) * 0.4, ty = d.ty + Math.sin(F * 0.05 + d.tx * 0.08) * 0.8;
      d.vx += (tx - d.x) * 0.02; d.vy += (ty - d.y) * 0.02; d.vx *= 0.86; d.vy *= 0.86;
      const sx = CX + Math.sin(F * 0.011) * 230, sy = 42 + Math.cos(F * 0.017) * 26;
      const dx = d.x - sx, dy = d.y - sy, dd = dx * dx + dy * dy;
      if (dd < 200) { const f = (200 - dd) / 200 * 0.6; d.vx += dx * f * 0.1; d.vy += dy * f * 0.1; }
      d.x += d.vx; d.y += d.vy;
    }
    if (F % 2 === 0) fx.emit(CX + Math.sin(F * 0.011) * 230, 42 + Math.cos(F * 0.017) * 26, (rnd() - .5) * .3, (rnd() - .5) * .3, 40, 1, .75, .3, 1, 0);
  }

  const SCORE_TYPES = ['moth', 'wisp', 'splitter', 'warden'];
  const HOW = [['MOVE', 'A D / ARROWS'], ['FIRE', 'SPACE / Z'], ['KINDLE', 'X / SHIFT'], ['PAUSE', 'P'], ['MUTE', 'M'], ['GAMEPAD', 'STICK  A  X']];
  const TIPS = ['KILLS FILL THE LANTERN.', 'KINDLE A DIVER:', 'IT BECOMES YOUR WINGMAN.', 'SHOOT THE COMET:', 'DEEP SKY POINTS X2.', 'SPLITTERS BREAK IN 3.', 'EVERY 5TH: ECLIPSE.', 'WINGMEN BURN LANTERN.'];

  function draw() {
    const F = ui.F;
    // assembling logo with a shimmer sweeping across
    for (const d of LOGO) {
      const sweep = Math.max(0, 1 - Math.abs(((F * 2) % (W + 160)) - 80 - d.tx) / 22);
      const g = (d.ty - 26) / 32;
      const r = 1, gg = 0.75 - g * 0.45 + sweep * 0.25, b = 0.25 + g * 0.35 + sweep * 0.7;
      dot(d.x, d.y, 1.05, r, Math.min(1, gg), Math.min(1, b), 1);
    }
    // orbiting ring around the logo
    for (let i = 0; i < 56; i++) { const a = i / 56 * TAU + F * 0.01; dot(CX + Math.cos(a) * 150, 42 + Math.sin(a) * 32, 0.7, .4, .5, 1, 0.25 + 0.25 * Math.sin(a * 3 + F * 0.05)); }
    fx.drawParticles(1);
    if (ui.menuPage === 'main') {
      panel(30, 100, 160, 108, COL.violet, 0.35);
      for (let i = 0; i < MENU.length; i++) {
        const y = 110 + i * 16, sel = i === ui.menuSel;
        const label = i === 3 ? (ui.muted ? 'SOUND: OFF' : 'SOUND: ON') : i === 4 ? (ui.crtOn ? 'CRT: ON' : 'CRT: OFF') : MENU[i];
        if (sel) {
          drawSpr(PLAYER, 46, y + 3, PI / 2 + Math.sin(F * 0.15) * 0.15, PAL_PLAYER, 0.7, 1, false);
          for (let k = 0; k < 3; k++) dot(37 - k * 3 + rnd(), y + 3, 1 - k * .2, 1, .6, .2, .8 - k * .25);
          text(label, 116, y, COL.amber, 1, 'c', 1, 0.8);
        } else text(label, 116, y, COL.dim, 1, 'c');
      }
      // right: score table, cycling sprites
      panel(210, 100, 162, 92, COL.teal, 0.25);
      const fr = (F / 16 | 0) & 1;
      text('FORM', 316, 106, COL.dim, 1, 'c'); text('DIVE', 352, 106, COL.dim, 1, 'c');
      for (let i = 0; i < SCORE_TYPES.length; i++) {
        const k = SCORE_TYPES[i], t = ART[k], s = STATS[k], y = 122 + i * 17, bob = Math.sin(F * 0.07 + i) * 1.2;
        drawSpr(fr ? t.B : t.A, 226, y + 3 + bob, PI, t.pal, 1, 1, false);
        text(s.name, 238, y, COL.white, 1);
        text(String(s.form), 316, y, COL.teal, 1, 'c'); text(String(s.dive), 352, y, COL.amber, 1, 'c');
      }
      if (F % 50 < 34) text('PRESS FIRE', CX, 222, COL.white, 1.4, 'c');
      text('BEST ' + ui.hi, CX, 246, COL.rose, 1, 'c');
      text('ARROWS MOVE   SPACE FIRE   X KINDLE', CX, 272, COL.dim, 1, 'c');
    } else if (ui.menuPage === 'how') {
      panel(20, 94, 360, 186, COL.teal, 0.35);
      HOW.forEach(([a, b], i) => { text(a, 36, 108 + i * 14, COL.amber, 1); text(b, 186, 108 + i * 14, COL.white, 1, 'r'); });
      TIPS.forEach((t, i) => text(t, 290, 108 + i * 13, i % 2 ? COL.white : COL.teal, 1, 'c'));
      if (F % 50 < 34) text('PRESS FIRE', CX, 262, COL.dim, 1, 'c');
    } else if (ui.menuPage === 'scores') {
      panel(CX - 80, 110, 160, 80, COL.rose, 0.35);
      text('BEST FLIGHT', CX, 126, COL.rose, 1.2, 'c', 1, 1);
      text(String(ui.hi), CX, 150, COL.gold, 2, 'c');
      if (F % 50 < 34) text('PRESS FIRE', CX, 204, COL.dim, 1, 'c');
    }
  }
  return { update, draw, scatter };
}
