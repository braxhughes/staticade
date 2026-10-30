// Stage twists (design.md B.11 0.1, 1.0, 1.1, 1.3, 1.5, 2.2): the twist clock, the per-stage lever and Hunt.
// Parting (1.2) and Pressing sky (1.4) are cut (design.md C.2 CUT box), so there is no press, lift or row mask.
//
// Twist clock (0.1): S.twistT counts twist steps, the gated play-frame step: at the start of this system's step,
// if S.state === 'play' and the ship is alive, twistT++; then, in this order, the Undertow pull (1.3), Thermals
// (1.5) and the Hunt band (2.2) run with the new value. Hit-stop skips every system step, so the clock freezes.
// The 'stage' event resets it to 0. V2 derives its own twist-step count from the twistT delta.
//
// Levers by stage row (0.7: endless stage s uses row ((s - 1) % 15) + 1, which S.row already is):
//   row 2 Weave (formation.js slot()), row 3 Pincer (formation.js pickDiver), row 8 Undertow, row 12 Thermals.
//   Hunt runs on every normal stage of row 3 and later.
// Formation-side rules (Weave offset, Pincer pair, Hunt target) live in formation.js and read the helpers below.
//
// Hash (0.3): twistT, pincerN, huntC, huntN; every live enemy's hunt, pin, aimV; th of every live bullet.
// Pure: no DOM, Math.random or Date; trig from engine/dmath.js; no per-frame allocation.
import { sin, hypot } from '../../../engine/dmath.js';
import { W } from '../defs.js';
import { clamp } from '../sim-path.js';

export const LEVERS = ['', '', 'weave', 'pincer', '', '', '', '', 'undertow', '', '', '', 'thermals', '', '', ''];
export const leverOf = row => LEVERS[row] || '';

// 1.0 Weave: row 3 slides by +wv, row 4 by -wv
export const WEAVE_AMP = 24, WEAVE_W = 0.0131;
export const weaveOffset = S => WEAVE_AMP * sin(S.twistT * WEAVE_W);

// 1.1 Pincer
export const PINCER_EVERY = 3;
export const PINCER_TYPES = { moth: true, wisp: true, splitter: true };

// 1.3 Undertow
export const UNDERTOW_CYCLE = 400, UNDERTOW_TELE = 280, UNDERTOW_PULL = 310, UNDERTOW_V = 0.4;
// phase within the cycle, and the pull side (+1 right, -1 left) of the cycle twistT is in
export const undertowPhase = t => t % UNDERTOW_CYCLE;
export const undertowDir = t => (Math.floor(t / UNDERTOW_CYCLE) % 2 === 0 ? 1 : -1);

// 1.5 Thermals: two columns 24 wide
export const THERM_HALF = 12, THERM_AMP = 120, THERM_W = 0.004, THERM_FLOOR = 0.6;
export const thermalX = (t, k) => { const s = THERM_AMP * sin(t * THERM_W); return k === 0 ? 200 + s : 200 - s; };

// 2.2 Hunt
export const HUNT_BAND = 24, HUNT_FRAMES = 150;
export const huntOn = S => S.row >= 3 && S.stageKind === 'normal';
export const huntReady = S => huntOn(S) && S.huntN >= HUNT_FRAMES;

function undertow(S, t) {
  if (undertowPhase(t) < UNDERTOW_PULL) return;
  const pl = S.player;
  pl.x = clamp(pl.x + UNDERTOW_V * undertowDir(t), 10, W - 10); // player.px is left alone: the render interpolates the pull
}

function thermals(S, t) {
  const c0 = thermalX(t, 0), c1 = thermalX(t, 1), eb = S.eb;
  for (let i = 0; i < eb.length; i++) {
    const b = eb[i];
    if (!b.on) continue;
    const inside = Math.abs(b.x - c0) < THERM_HALF || Math.abs(b.x - c1) < THERM_HALF;
    if (inside && b.th === 0) {
      // slowed, but never below 1.0 (B.5 floor); a bullet already at 1.0 or less keeps its speed (f = 1)
      const s = hypot(b.vx, b.vy), f = s <= 1.0 ? 1 : Math.max(THERM_FLOOR, 1.0 / s);
      b.vx *= f; b.vy *= f; b.th = f;
    } else if (!inside && b.th > 0) {
      b.vx /= b.th; b.vy /= b.th; b.th = 0;
    }
  }
}

function huntBand(S) {
  const x = S.player.x;
  if (Math.abs(x - S.huntC) > HUNT_BAND) { S.huntC = x; S.huntN = 0; } else S.huntN++;
}

export const twistSystem = {
  id: 'twists',
  init(S) {
    S.twistT = 0;   // play frames with the ship alive this stage (0.1)
    S.pincerN = 0;  // dive launches counted for Pincer (1.1)
    S.huntC = 0;    // Hunt band center (2.2)
    S.huntN = 0;    // twist steps the ship has stayed inside the band (2.2)
  },
  step(S) {
    if (S.state !== 'play' || !S.player.alive) return;
    const t = ++S.twistT, L = leverOf(S.row);
    if (L === 'undertow') undertow(S, t);
    else if (L === 'thermals') thermals(S, t);
    if (huntOn(S)) huntBand(S);
  },
  onEvent(S, ev) {
    if (ev.type !== 'stage') return;
    S.twistT = 0; S.pincerN = 0; S.huntC = S.player.x; S.huntN = 0;
  },
  hash(S, u32, f64) {
    u32(S.twistT); u32(S.pincerN); f64(S.huntC); u32(S.huntN);
    const en = S.enemies;
    for (let i = 0; i < en.length; i++) { const e = en[i]; if (e.dead) continue; u32(e.hunt); u32(e.pin); f64(e.aimV); }
    const eb = S.eb;
    for (let i = 0; i < eb.length; i++) { const b = eb[i]; if (b.on) { u32(i); f64(b.th); } }
  }
};
