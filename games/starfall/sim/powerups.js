// Power-ups (design.md B.2): the glyph a Lamplighter drops, its type cycle, the catch, the mercy rule,
// and the four powers FAN / LANCE / HALO / ECHO with their costs.
// Pure and allocation-free per frame. Uses the seams in sim.js: S.power picks a def from POWERS
// (registered as registry.powerups), whose optional fields change the ship's weapon:
//   speed            ship top speed (v1: 2.7)
//   gap              auto-fire refire frames (v1: 10)
//   units(S)         how much of the shot cap is in use (v1: live shots)
//   ready(S)         false = the ship may not fire this frame (checked before the cap, for presses too)
//   fire(S, x, y)    spawns the ship's own shot(s); wingmen always fire the base shot
//   bullet(S, b)     true = the enemy bullet b was absorbed (checked before the hit test)
//   body(S, e)       true = the body hit by e was absorbed (e is killed either way)
// Kill attribution for scoring: while a shot's kill runs, S.hitBy is that shot's power id ('lance' gives
// 45 frames of chain time, B.4; pending). Grazing is off while S.power === 'halo' (sim/score.js reads it).
// S.haloLostT counts down from HALO_LOST_T when the ring is used up (presentation only: the render's 'lost it' cue).
import { H, SFX_ID, POP_NUM, POP_FADED, C_TEAL, C_ROSE, FX_SPARK } from '../defs.js';
import { sin, cos, hypot, PI } from '../../../engine/dmath.js';

export const POWER_IDS = ['fan', 'lance', 'halo', 'echo'];   // the glyph cycle order
export const GLYPH_CYCLE = 45, GLYPH_FALL = 0.8, GLYPH_CATCH = 8, CATCH_BONUS = 500;
export const MERCY_START = 2;                                 // HALO
export const BASE_SPEED = 2.7, BASE_SHOT = 6.5;
export const FAN_SPEED = 5.0, FAN_DEG = 12;
export const LANCE_GAP = 24, LANCE_HITS = 3, LANCE_CHAIN = 45;
export const HALO_HITS = 3, HALO_SPEED = 2.3, HALO_R = 9;
export const POWER_FRAMES = 900;                              // B.10: every power-up lasts 900 play frames
export const ECHO_DELAY = 20, ECHO_MAX = 8, HALO_LOST_T = 24;

const FAN_A = FAN_DEG * PI / 180, FAN_VX = FAN_SPEED * sin(FAN_A), FAN_VY = -FAN_SPEED * cos(FAN_A);

// distinct live volleys (a FAN volley shares one id) plus echoes still waiting to fire
function units(S) {
  const ps = S.ps;
  let n = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (!p.on) continue;
    let dup = false;
    for (let j = 0; j < i; j++) if (ps[j].on && ps[j].vol === p.vol) { dup = true; break; }
    if (!dup) n++;
  }
  return n + S.echoN;
}

export const POWERS = {
  // three shots at -12, 0, +12 degrees; slower shots (5.0), and the cap still counts whole volleys
  fan: {
    id: 'fan', units,
    fire(S, x, y) {
      const c = S.shot(x, y); if (!c) return;
      c.vy = -FAN_SPEED; c.pw = 'fan';
      for (let k = -1; k <= 1; k += 2) {
        const p = S.shot(x, y); if (!p) return;
        p.vx = k * FAN_VX; p.vy = FAN_VY; p.vol = c.vol; p.pw = 'fan';
      }
    }
  },
  // one shot that hits up to 3 enemies in a line; refire every 24 frames
  lance: {
    id: 'lance', units, gap: LANCE_GAP,
    // strict: a fresh press cannot beat the 24-frame gap (the gap is LANCE's cost)
    ready: S => S.lanceCd <= 0,
    fire(S, x, y) { const p = S.shot(x, y); if (p) { p.pierce = LANCE_HITS - 1; p.pw = 'lance'; S.lanceCd = LANCE_GAP; } }
  },
  // a ring absorbs 3 enemy bullets or 1 body hit; slower ship, no grazing
  halo: {
    id: 'halo', units, speed: HALO_SPEED,
    bullet(S, b) {
      const P = S.player;
      if (hypot(b.x - P.x, b.y - P.y) >= HALO_R) return false;
      S.fx(FX_SPARK, b.x, b.y); S.sfx(SFX_ID.deflect);
      if (--S.haloHits <= 0) loseHalo(S);
      return true;
    },
    body(S, e) {
      S.fx(FX_SPARK, e.x, e.y); S.sfx(SFX_ID.deflect);
      loseHalo(S);
      return true;
    }
  },
  // every shot fires again from the same spot 20 frames later; the echo holds a cap slot while it waits.
  // Echo shots count as fired (S.shotsFired), so an echo that misses lowers accuracy like any other shot.
  echo: {
    id: 'echo', units,
    fire(S, x, y) {
      const p = S.shot(x, y); if (!p) return;
      if (S.echoN < ECHO_MAX) { const o = S.echoN++ * 3; S.echoQ[o] = x; S.echoQ[o + 1] = y; S.echoQ[o + 2] = ECHO_DELAY + 1; } // +1: this frame's system step counts once
    }
  }
};

// set the held power-up ('' = none); an unknown id is ignored
export function setPower(S, id) {
  if (id !== '' && !POWERS[id]) return false;
  S.power = id; S.haloHits = id === 'halo' ? HALO_HITS : 0; S.powerT = id === '' ? 0 : POWER_FRAMES;
  return true;
}
// the HALO ring is used up: power gone, powerdown sound, and the render's 'lost it' cue
function loseHalo(S) { setPower(S, ''); S.haloLostT = HALO_LOST_T; S.sfx(SFX_ID.powerdown); }

export const glyphType = g => POWER_IDS[(g.start + ((g.t / GLYPH_CYCLE) | 0)) % 4];

// drop a glyph at (x, y) that starts its cycle at POWER_IDS[start]
export function dropGlyph(S, x, y, start) {
  const g = S.glyph;
  g.on = true; g.x = g.px = x; g.y = g.py = y; g.t = 0; g.start = start & 3;
}

function catchGlyph(S, g) {
  g.on = false;
  setPower(S, glyphType(g));
  const v = S.addBonus(CATCH_BONUS);
  S.popup(POP_NUM, g.x, g.y - 8, v, C_TEAL); S.sfx(SFX_ID.powerup);
  S.emit('catch', null, g.x, g.y, v);
}

function hasLamplighter(S) { for (const e of S.enemies) if (e.type === 'lamplighter') return true; return false; }

export const powerSystem = {
  id: 'powerups',
  init(S) {
    S.power = ''; S.powerT = 0; S.haloHits = 0; S.hitBy = ''; S.lanceCd = 0; S.haloLostT = 0;
    S.glyph = { on: false, x: 0, y: 0, px: 0, py: 0, t: 0, start: 0 };
    S.glyphStart = 0; S.stageDeaths = 0;
    S.echoQ = new Float64Array(ECHO_MAX * 3); S.echoN = 0;
    S.setPower = id => setPower(S, id);
  },
  step(S) {
    if (S.lanceCd > 0) S.lanceCd--;
    if (S.haloLostT > 0) S.haloLostT--;
    // B.10 timer: counts only on play frames with the ship alive (hit-stop never reaches here; intro and clear are not play)
    if (S.power && S.state === 'play' && S.player.alive && --S.powerT <= 0) {
      const P = S.player;
      setPower(S, ''); S.sfx(SFX_ID.powerdown); S.popup(POP_FADED, P.x, P.y - 22, 0, C_ROSE);
      S.emit('powerdown', null, P.x, P.y);
    }
    const g = S.glyph;
    if (g.on) {
      g.px = g.x; g.py = g.y; g.y += GLYPH_FALL; g.t++;
      const P = S.player;
      if (g.y > H + 8) g.on = false;
      else if (P.alive && hypot(g.x - P.x, g.y - P.y) < GLYPH_CATCH) catchGlyph(S, g);
    }
    // echoes fire on play frames only (shots do not move outside play)
    if (S.state === 'play' && S.echoN > 0) {
      const q = S.echoQ;
      let j = 0;
      for (let i = 0; i < S.echoN; i++) {
        const o = i * 3;
        if (--q[o + 2] <= 0) { const p = S.shot(q[o], q[o + 1]); if (p) p.pw = 'echo'; continue; }
        if (j !== i) { const d = j * 3; q[d] = q[o]; q[d + 1] = q[o + 1]; q[d + 2] = q[o + 2]; }
        j++;
      }
      S.echoN = j;
    }
  },
  onEvent(S, ev) {
    switch (ev.type) {
      case 'stage':
        S.glyph.on = false; S.echoN = 0;
        // start type rng.int(4), drawn only in stages with a Lamplighter; mercy: a death last stage starts at HALO
        if (hasLamplighter(S)) {
          S.glyphStart = S.rng.int(4);
          if (S.deaths > S.stageDeaths) S.glyphStart = MERCY_START;
        }
        S.stageDeaths = S.deaths;
        break;
      case 'kill':
        if (ev.enemy && ev.enemy.type === 'lamplighter') dropGlyph(S, ev.x, ev.y, S.glyphStart);
        break;
      case 'death':
        S.echoN = 0;
        if (S.power) { setPower(S, ''); S.sfx(SFX_ID.powerdown); }
        break;
    }
  },
  hash(S, u32, f64) {
    const g = S.glyph;
    u32(POWER_IDS.indexOf(S.power) + 1); u32(S.haloHits); u32(S.powerT); u32(S.lanceCd); u32(S.glyphStart); u32(S.stageDeaths);
    u32(g.on ? 1 : 0); if (g.on) { f64(g.x); f64(g.y); u32(g.t); u32(g.start); }
    u32(S.echoN); for (let i = 0; i < S.echoN * 3; i++) f64(S.echoQ[i]);
  }
};
