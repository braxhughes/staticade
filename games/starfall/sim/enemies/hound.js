// The Hound (design.md B.11 3.2, slice V2): two stalkers in their own pool (never in S.enemies), stage row 13.
// They never block the stage clear, never count in n or in divers, and KINDLE, ARC and Hunt never touch them.
//
// Trigger  N0 = the live enemy count on the stage's first play frame (the first twist step). On the first play frame
//          the live count is at most floor(N0 / 2), Hound A enters at once from (20, -10); Hound B waits 60 twist steps
//          in state 0, then enters from (380, -10). Once per stage. When the stage clears, live Hounds are removed.
// States   (st per Hound, f = twist steps in the state)
//          0 off     not drawn, not hit                     -> 1 when triggered (B waits 60 first)
//          1 enter   straight down at 1.2                   -> 2 on reaching y 190
//          2 shadow  x moves toward tx at up to 1.2         -> 3 when the fire rule holds; 5 when life reaches 600
//          3 glow    20-step aim-lock glow, x frozen        -> 4 when the first bullet fires (2 if the volley wait runs out)
//          4 second  x frozen, 8 steps, then the 2nd bullet -> 2, cooldown 70
//          5 leave   up at 1.2, no points                   -> 0 when y < -10
// Timers   every Hound timer (f, life, cooldown, volley wait) counts twist steps only: this system derives a twist step
//          from the twistT delta (the twist system runs first and is the only thing that moves twistT). So a Hound
//          freezes in place while the ship is dead and during hit-stop. Its bullets in flight are ordinary enemy
//          bullets: they freeze in hit-stop like all bullets (sim.js skips the whole frame) and fly on while the ship
//          is dead.
// Shadow   tx = the ship's x 30 twist steps ago, from a 32-slot ring of ship x written each twist step (after the
//          Undertow pull, since the twist system steps first), filled with the ship's x at stage start, clamped to
//          10..390. If the two Hounds are within 16 units, the later one (B) holds its x that step. A Hound's lowest
//          point on screen is y 190 (B.11 allows up to 200), so its body never meets the ship (y 274).
// Fire     state 2, abs(x - tx) < 3, cooldown 0. Two bullets straight down at 2.2 from the Hound's x, the second 8
//          steps after the first in the same column. One 2-bullet volley: the first needs volleyOk(2); with no room it
//          waits up to 30 steps, then the volley is skipped; the second always follows once the first fired.
// Life     600 twist steps from entering state 1; checked only in state 2.
// Damage   a player shot inside abs(dx) < 7, abs(dy) < 7 is used up (LANCE and FAN shots too, no pierce) and counts as
//          a hit (S.hits++, once per shot like the core's accuracy rule). 3 hp. Kill: S.pieceKill(800) (kill points
//          with every multiplier, chain +1, window 90), feel 'big'. Shots are checked every frame a Hound is out.
// Hash: per Hound st, f, x, y, hp, life, cooldown, volley wait, tx; the ring and its index; trigger flag; N0;
// the last twistT seen; kills. Pure: no DOM, Math.random or Date; hypot from engine/dmath.js; no per-frame allocation.
import { hypot } from '../../../../engine/dmath.js';
import { W, SFX_ID, POP_NUM, C_GOLD, FX_SPLIT } from '../../defs.js';
import { VOLLEY_WAIT } from '../feel.js';

export const HOUND_N = 2, HOUND_RING = 32;
export const HOUND_ROW = 13, HOUND_HP = 3, HOUND_PTS = 800;
export const HOUND_X = [20, 380], HOUND_DELAY = [0, 60], HOUND_TOP = -10, HOUND_Y = 190, HOUND_V = 1.2;
export const HOUND_LIFE = 600, HOUND_LAG = 30, HOUND_GLOW = 20, HOUND_GAP = 8, HOUND_CD = 70;
export const HOUND_ALIGN = 3, HOUND_NEAR = 16, HOUND_BULLET = 2.2, HOUND_HIT = 7, HOUND_MUZZLE = 6;
// states
export const H_OFF = 0, H_ENTER = 1, H_SHADOW = 2, H_GLOW = 3, H_SECOND = 4, H_LEAVE = 5;

function mkHounds() {
  return { st: new Uint8Array(HOUND_N), f: new Int32Array(HOUND_N), x: new Float64Array(HOUND_N), y: new Float64Array(HOUND_N),
    hp: new Int32Array(HOUND_N), life: new Int32Array(HOUND_N), cd: new Int32Array(HOUND_N), vWait: new Int32Array(HOUND_N),
    tx: new Float64Array(HOUND_N),
    ring: new Float64Array(HOUND_RING), ri: 0, triggered: 0, n0: 0, lastT: 0, kills: 0,
    // presentation only (render/enemies-c2.js; not hashed): previous position for interpolation, hit flash
    px: new Float64Array(HOUND_N), py: new Float64Array(HOUND_N), flash: new Int32Array(HOUND_N) };
}

// Hounds on screen now (state other than 0)
export function houndsLive(S) { const H = S.hounds; let n = 0; for (let i = 0; i < HOUND_N; i++) if (H.st[i] !== 0) n++; return n; }
export const houndStage = S => S.row === HOUND_ROW && S.stageKind === 'normal';
// the ship's x k twist steps ago (k < HOUND_RING), clamped to the ship's own range
export function shipAgo(H, k) { const v = H.ring[(H.ri - 1 - k + 2 * HOUND_RING) % HOUND_RING]; return v < 10 ? 10 : v > W - 10 ? W - 10 : v; }

function liveCount(S) { const en = S.enemies; let n = 0; for (let i = 0; i < en.length; i++) if (!en[i].dead) n++; return n; }

function enter(H, i) {
  H.st[i] = H_ENTER; H.f[i] = 0; H.x[i] = H.px[i] = HOUND_X[i]; H.y[i] = H.py[i] = HOUND_TOP;
  H.life[i] = 0; H.cd[i] = 0; H.vWait[i] = 0; H.tx[i] = HOUND_X[i];
}
function off(H, i) { H.st[i] = H_OFF; H.f[i] = 0; H.hp[i] = 0; H.vWait[i] = 0; H.flash[i] = 0; }
function to(H, i, st) { H.st[i] = st; H.f[i] = 0; }

function fireBullet(S, H, i) { S.eFire(H.x[i], H.y[i] + HOUND_MUZZLE, 0, HOUND_BULLET, false); }

// one twist step of Hound i
function tick(S, H, i) {
  switch (H.st[i]) {
    case H_OFF:
      // armed (hp > 0) but not out yet: Hound B counts its 60-step wait here
      if (H.hp[i] > 0 && ++H.f[i] >= HOUND_DELAY[i]) enter(H, i);
      return;
    case H_ENTER:
      H.life[i]++; H.f[i]++;
      H.y[i] += HOUND_V;
      if (H.y[i] >= HOUND_Y) { H.y[i] = HOUND_Y; to(H, i, H_SHADOW); }
      return;
    case H_SHADOW: {
      H.life[i]++; H.f[i]++;
      if (H.cd[i] > 0) H.cd[i]--;
      if (H.life[i] >= HOUND_LIFE) { to(H, i, H_LEAVE); return; }
      const tx = H.tx[i] = shipAgo(H, HOUND_LAG);
      const o = 1 - i, hold = i === 1 && H.st[o] !== H_OFF && hypot(H.x[i] - H.x[o], H.y[i] - H.y[o]) < HOUND_NEAR;
      if (!hold) { const d = tx - H.x[i]; H.x[i] += d > HOUND_V ? HOUND_V : d < -HOUND_V ? -HOUND_V : d; }
      if (Math.abs(H.x[i] - tx) < HOUND_ALIGN && H.cd[i] === 0) to(H, i, H_GLOW);
      return;
    }
    case H_GLOW:
      H.life[i]++;
      if (++H.f[i] < HOUND_GLOW) return;
      if (S.volleyOk(2)) { fireBullet(S, H, i); H.vWait[i] = 0; to(H, i, H_SECOND); }
      else if (++H.vWait[i] > VOLLEY_WAIT) { H.vWait[i] = 0; to(H, i, H_SHADOW); } // no room for 30 steps: volley skipped
      return;
    case H_SECOND:
      H.life[i]++;
      if (++H.f[i] < HOUND_GAP) return;
      fireBullet(S, H, i); H.cd[i] = HOUND_CD; to(H, i, H_SHADOW);
      return;
    case H_LEAVE:
      H.f[i]++;
      H.y[i] -= HOUND_V;
      if (H.y[i] < HOUND_TOP) off(H, i);
      return;
  }
}

// player shots that reach a Hound (every frame one is out)
function shots(S, H, i) {
  const ps = S.ps, x = H.x[i], y = H.y[i];
  for (let j = 0; j < ps.length; j++) {
    const p = ps[j];
    if (!p.on || Math.abs(p.x - x) >= HOUND_HIT || Math.abs(p.y - y) >= HOUND_HIT) continue;
    p.on = false;
    if (!p.hit) S.hits++;
    p.hit = true;
    if (--H.hp[i] > 0) { H.flash[i] = 6; S.sfx(SFX_ID.ding); continue; }
    const v = S.pieceKill(HOUND_PTS);
    S.popup(POP_NUM, x, y - 6, v, C_GOLD); S.fx(FX_SPLIT, x, y);
    S.sfx(SFX_ID.pop); S.sfx(SFX_ID.big); S.feel('big');
    H.kills++; off(H, i);
    return;
  }
}

export const houndSystem = {
  id: 'hound',
  init(S) { S.hounds = mkHounds(); },
  step(S) {
    const H = S.hounds;
    const tw = S.twistT - H.lastT === 1; // a twist step this frame (the twist system has already stepped)
    H.lastT = S.twistT;
    for (let i = 0; i < HOUND_N; i++) { H.px[i] = H.x[i]; H.py[i] = H.y[i]; if (H.flash[i] > 0) H.flash[i]--; }
    if (!houndStage(S)) return;
    for (let i = 0; i < HOUND_N; i++) if (H.st[i] !== H_OFF) shots(S, H, i);
    if (!tw) return;
    H.ring[H.ri] = S.player.x; H.ri = (H.ri + 1) % HOUND_RING;
    if (S.twistT === 1) H.n0 = liveCount(S);
    for (let i = 0; i < HOUND_N; i++) tick(S, H, i);
    // trigger last, so Hound A's first move is on the next twist step (it appears at y -10 this frame)
    if (!H.triggered && H.n0 > 0 && S.state === 'play' && liveCount(S) <= (H.n0 >> 1)) {
      H.triggered = 1;
      for (let i = 0; i < HOUND_N; i++) { H.hp[i] = HOUND_HP; H.f[i] = 0; }
      enter(H, 0);
    }
  },
  onEvent(S, ev) {
    const H = S.hounds;
    if (ev.type === 'clear') { for (let i = 0; i < HOUND_N; i++) off(H, i); return; } // removed, no points
    if (ev.type !== 'stage') return;
    for (let i = 0; i < HOUND_N; i++) {
      off(H, i); H.x[i] = H.px[i] = HOUND_X[i]; H.y[i] = H.py[i] = HOUND_TOP; H.life[i] = 0; H.cd[i] = 0; H.tx[i] = HOUND_X[i];
    }
    H.ring.fill(S.player.x); H.ri = 0; H.triggered = 0; H.n0 = 0; H.lastT = 0; // the twist system reset twistT to 0
  },
  hash(S, u32, f64) {
    const H = S.hounds;
    for (let i = 0; i < HOUND_N; i++) {
      u32(H.st[i]); u32(H.f[i]); f64(H.x[i]); f64(H.y[i]); u32(H.hp[i]); u32(H.life[i]); u32(H.cd[i]); u32(H.vWait[i]); f64(H.tx[i]);
    }
    for (let k = 0; k < HOUND_RING; k++) f64(H.ring[k]);
    u32(H.ri); u32(H.triggered); u32(H.n0); u32(H.lastT); u32(H.kills);
  }
};
