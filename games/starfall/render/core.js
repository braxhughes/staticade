// The v1 draw layers, one object each: { id, hud?, draw(R, sim, al, st) }.
// R is the renderer context (dot, text, fx, ui, drawSpr, panel). st is the sim state, or 'results'.
// Reads the sim, never writes it. Cosmetic randomness (thruster flicker) is unseeded on purpose.
import { W, H, CX, TAU, METER_MAX, WING_BLINK } from '../defs.js';
import { artFor, artOfTi, PLAYER, PAL_PLAYER, COL } from '../sprites.js';
import { enemyTypes } from '../sim/registry.js';
import { haloOf } from './zones.js';

const rnd = Math.random;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

// the zone sky (render/zones.js) draws the stars during a run; this v1 layer stays for any sim without a zone
export const starsLayer = { id: 'stars', draw(R, sim) { if (!(sim.zone >= 1 && sim.zone <= 3)) R.fx.drawStars(sim.warp, R.ui.F); } };

export const enemiesLayer = {
  id: 'enemies',
  draw(R, sim, al) {
    const en = sim.enemies, m = Math.min(sim.mult - 1, 3);
    for (let i = 0; i < en.length; i++) {
      const e = en[i];
      if (e.st === 'wait') continue;
      const x = e.px + (e.x - e.px) * al, y = e.py + (e.y - e.py) * al, def = enemyTypes[e.type];
      if (def && def.draw) def.draw(R, e, al, sim);
      else drawArt(R, e, x, y, m);
      if (e.st === 'tele') diveGlow(R, x, y, e.tele, e.type === 'warden');
      if (e.aimT > 0) aimGlow(R, x, y + 6, e.aimT);
    }
  }
};
// the registered art for this enemy's type (sprites.js artFor), two-frame animation
function drawArt(R, e, x, y, m) {
  const T = artFor(e.type), fr = ((R.ui.F + e.phase) / (e.fast ? 5 : 16) | 0) & 1;
  R.drawSpr(fr ? T.B : T.A, x, y, e.ang, e.hurt ? T.hurts[m] : T.pals[m], 1, 1, e.flash > 0, e.asm);
}

// dive telegraph: a pulsing ring around the diver (gold for a Warden's longer glow, amber otherwise)
function diveGlow(R, x, y, t, warden) {
  const F = R.ui.F, a = 0.35 + 0.35 * (((F >> 2) & 1) ? 1 : 0.4), r = 9 + (t & 3) * 0.4;
  for (let k = 0; k < 10; k++) {
    const q = k / 10 * TAU + F * 0.12;
    R.dot(x + Math.cos(q) * r, y + Math.sin(q) * r, 1.1, 1, warden ? .88 : .7, warden ? .4 : .25, a);
  }
}
// aim-lock glow: rose dots closing in on the muzzle as the shot comes due (t = frames left)
export function aimGlow(R, x, y, t) {
  const r = 2 + t * 0.35, a = 0.45 + 0.4 * (1 - t / 20);
  for (let k = 0; k < 6; k++) { const q = k / 6 * TAU; R.dot(x + Math.cos(q) * r, y + Math.sin(q) * r, 0.9, 1, .3, .6, a); }
}

export const cometLayer = {
  id: 'comet',
  draw(R, sim, al) {
    const comet = sim.comet;
    if (!comet.on) return;
    const x = comet.px + (comet.x - comet.px) * al, y = comet.py + (comet.y - comet.py) * al;
    for (let i = 0; i < 10; i++) { const a = i / 10 * TAU + R.ui.F * 0.1; R.dot(x + Math.cos(a) * 3, y + Math.sin(a) * 3, 1.1, .5, .9, 1, 1); }
    R.dot(x, y, 2.4, 1, 1, 1, 1);
  }
};

export const playerLayer = {
  id: 'player',
  draw(R, sim, al, st) {
    const F = R.ui.F, player = sim.player, dot = R.dot;
    for (const w of sim.wing) {
      const x = w.px + (w.x - w.px) * al, y = w.py + (w.y - w.py) * al, T = artOfTi(w.ti);
      const wa = w.life <= WING_BLINK && F % 8 < 4 ? 0.3 : 1;   // B.10: blinks for its last 90 frames
      R.drawSpr(((F / 8) | 0) & 1 ? T.B : T.A, x, y, w.ang, T.kpal, 1, wa, false);
      dot(x, y + 7 + rnd(), 1.2, 1, .6, .2, (.5 + rnd() * .4) * wa);
    }
    for (const q of sim.peelers) {   // B.10: a wingman whose time ran out peels off the top
      if (!q.on) continue;
      const x = q.px + (q.x - q.px) * al, y = q.py + (q.y - q.py) * al, T = artOfTi(q.ti);
      R.drawSpr(((F / 8) | 0) & 1 ? T.B : T.A, x, y, q.ang, T.kpal, 1, 0.7, false);
      dot(x, y + 7 + rnd(), 1.2, 1, .6, .2, .4 + rnd() * .3);
    }
    if (!player.alive || st === 'gameover' || st === 'results') return;
    const x = player.px + (player.x - player.px) * al, y = player.y + player.recoil;
    const a = player.inv > 0 && F % 6 < 3 ? 0.3 : 1;
    R.drawSpr(PLAYER, x, y, player.tilt, PAL_PLAYER, 1, a, false);
    for (let i = 0; i < 4; i++) { const f = rnd(); dot(x + (rnd() - .5) * 2.4, y + 6 + i * 1.4 + f, 1.1 - i * 0.2, 1, .5 + .4 * f, .15, a * (0.9 - i * 0.2)); }
  }
};

export const shotsLayer = {
  id: 'shots',
  draw(R, sim, al) {
    const dot = R.dot;
    for (const p of sim.ps) if (p.on) {
      const x = p.px + (p.x - p.px) * al, y = p.py + (p.y - p.py) * al, k = p.pw === 'echo' ? 0.7 : 1; // ECHO shots at 70% (B.9 rule 2)
      dot(x, y, 1.3, 1, 1, .9, k); dot(x, y + 2, 1.1, 1, .8, .35, .9 * k); dot(x, y + 4, 0.9, 1, .5, .15, .6 * k);
    }
  }
};

export const bulletsLayer = {
  id: 'bullets',
  draw(R, sim, al) {
    const dot = R.dot;
    for (const b of sim.eb) if (b.on) {
      const x = b.px + (b.x - b.px) * al, y = b.py + (b.y - b.py) * al;
      // B.9 rule 1: white core 1.1 inside a 2.2 halo in the zone's halo color (render/zones.js)
      const h = haloOf(sim.zone);
      if (!b.big) dot(x - b.vx, y - b.vy * 0.8, 1.1, h[0], h[1], h[2], .7);
      dot(x, y, 2.2, h[0], h[1], h[2], 1); dot(x, y, 1.1, 1, 1, 1, 1);
    }
  }
};

export const particlesLayer = { id: 'particles', draw(R, sim, al) { R.fx.drawParticles(al); R.fx.drawPulse(); R.fx.drawPops(R.text); } };

function drawMini(R, x, y) { R.drawSpr(PLAYER, x, y, 0, PAL_PLAYER, 0.62, 0.9, false); }
export const hudLayer = {
  id: 'hud', hud: true,
  draw(R, sim, al, st) {
    const { text, dot, ui } = R;
    const F = ui.F, blink = F % 40 < 26, boss = sim.boss, meter = sim.meter, stage = sim.stage;
    if (blink || st !== 'play') text('SCORE', 8, 2, COL.amber, 1);
    text(String(sim.score), 8, 11, COL.white, 1);
    text('BEST', CX, 2, COL.rose, 1, 'c');
    text(String(ui.hi), CX, 11, COL.white, 1, 'c');
    if (sim.mult > 1) text('X' + sim.mult, W - 8, 2, COL.teal, 1, 'r', 0.7 + 0.3 * Math.sin(F * 0.2));
    if (boss.on) {
      text(boss.name, W - 8, 11, COL.violet, 1, 'r');
      const hp = sim.bossHp(), cur = hp[0], tot = hp[1];
      for (let i = 0; i < 40; i++) dot(W - 88 + i * 2, 21, 1, i / 40 < cur / tot ? 1 : .25, i / 40 < cur / tot ? .35 : .25, i / 40 < cur / tot ? .6 : .35, 1);
    }
    // reserves
    for (let i = 0; i < Math.min(6, sim.lives - 1); i++) drawMini(R, 10 + i * 11, H - 8);
    // kindle meter; a burning (partly drained) dot flickers while wingmen feed on the lantern
    const full = meter >= METER_MAX;
    for (let i = 0; i < METER_MAX; i++) {
      const f = clamp(meter - i, 0, 1), on = f > 0, pulseA = full ? 0.6 + 0.4 * Math.sin(F * 0.25 + i * 0.5) : f < 1 ? f * (0.75 + 0.25 * Math.sin(F * 0.4)) : 1;
      if (on && f < 1) dot(CX - 22 + i * 5, H - 7, 1, .3, .25, .3, .6);
      dot(CX - 22 + i * 5, H - 7, on ? 1.6 : 1, on ? 1 : .3, on ? .65 : .25, on ? .2 : .3, on ? pulseA : .6);
    }
    if (sim.wing.length && meter > 0) dot(CX - 26, H - 7, 1, 1, .5, .15, 0.5 + 0.5 * Math.sin(F * 0.3));
    // stage badges
    let bx = W - 8; const by = H - 8;
    const big = Math.floor(stage / 5), small = stage % 5;
    for (let i = 0; i < small && bx > W - 90; i++, bx -= 6) { dot(bx, by - 2, 1, 1, .85, .3, 1); dot(bx, by, 1.2, 1, .55, .15, 1); dot(bx, by + 2, 1, .9, .3, .1, 1); }
    for (let i = 0; i < big && bx > W - 90; i++, bx -= 9) for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; dot(bx + Math.cos(a) * 3, by + Math.sin(a) * 3, 1, .4, .9, 1, 1); dot(bx, by, 1.4, 1, 1, 1, 1); }
  }
};

// w30b: the touch-only LOBBY button on the pause screen, in field units (400 x 300). Top right, under the boss bar (y 21)
// and the multiplier, far from the centre where a resume tap lands. The hit box is the drawn box plus 4 units.
export const LOBBY_BOX = Object.freeze({ x0: 322, x1: 392, y0: 32, y1: 56 });
const LOBBY_PAD = 4;
export const lobbyHit = (x, y) => x >= LOBBY_BOX.x0 - LOBBY_PAD && x <= LOBBY_BOX.x1 + LOBBY_PAD && y >= LOBBY_BOX.y0 - LOBBY_PAD && y <= LOBBY_BOX.y1 + LOBBY_PAD;
function lobbyButton(R) {
  const b = LOBBY_BOX, F = R.ui.F;
  R.ui.lobbyBtnF = F; // test hook: the frame the button was last drawn (SF.lobbyButton())
  R.panel(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0, COL.amber, 0.85);
  R.panel(b.x0 + 2, b.y0 + 2, b.x1 - b.x0 - 4, b.y1 - b.y0 - 4, COL.amber, 0.3);
  R.text('LOBBY', (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2 - 3, COL.amber, 1, 'c', F % 60 < 40 ? 1 : 0.75);
}

export const overlayLayer = {
  id: 'overlay', hud: true,
  draw(R, sim, al, st) {
    const { text, ui, panel } = R;
    const F = ui.F, stateT = ui.appT;
    if (ui.paused) {
      text('PAUSED', CX, 150, COL.white, 2, 'c');
      if (ui.canLobby && st !== 'results' && ui.touchUi) { text('TAP: RESUME', CX, 170, COL.dim, 1, 'c'); lobbyButton(R); } // w30b: touch players get a LOBBY button
      else if (ui.canLobby && st !== 'results') text('ESC: LOBBY   FIRE: RESUME', CX, 170, COL.dim, 1, 'c');
      else text('PRESS FIRE', CX, 170, COL.dim, 1, 'c');
      return;
    }
    const t = st === 'results' ? ui.appT : sim.stateT;
    if (st === 'intro') {
      const a = Math.min(1, t / 15);
      if (sim.stageKind === 'bonus') { /* render/starlight.js */ }
      else if (sim.stageKind === 'boss') { text('STAGE ' + sim.stage, CX, 140, COL.white, 1.4, 'c', a); if (F % 30 < 20) text('WARNING: ' + sim.boss.name, CX, 160, COL.rose, 1, 'c', a); }
      else text('STAGE ' + sim.stage, CX, 150, COL.white, 1.4, 'c', a);
    }
    if (st === 'ready') text('READY', CX, 160, COL.amber, 1.4, 'c');
    if (st === 'gameover') text('GAME OVER', CX, 150, COL.rose, 2, 'c', Math.min(1, t / 20), 1);
    if (st === 'results') {
      panel(CX - 90, 100, 180, 120, COL.violet, 0.5);
      text('- FLIGHT LOG -', CX, 112, COL.teal, 1, 'c');
      text('SCORE', CX - 74, 134, COL.amber, 1); text(String(sim.score), CX + 74, 134, COL.white, 1, 'r');
      text('STAGE', CX - 74, 148, COL.amber, 1); text(String(sim.stage), CX + 74, 148, COL.white, 1, 'r');
      text('SHOTS', CX - 74, 162, COL.amber, 1); text(String(sim.shotsFired), CX + 74, 162, COL.white, 1, 'r');
      text('HITS', CX - 74, 176, COL.amber, 1); text(String(sim.hits), CX + 74, 176, COL.white, 1, 'r');
      // hits only count shots that connected, so this stays at or under 100%
      const acc = sim.shotsFired ? Math.min(100, sim.hits / sim.shotsFired * 100).toFixed(1) : '0.0';
      text('ACCURACY', CX - 74, 190, COL.amber, 1); text(acc + '%', CX + 74, 190, COL.white, 1, 'r');
      if (stateT > 60 && F % 40 < 26) text('PRESS FIRE', CX, 206, COL.dim, 1, 'c');
    }
  }
};
