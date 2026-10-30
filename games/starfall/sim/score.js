// Scoring (design.md B.4): the Ember Chain, graze, Lead kill, Interrupt, Close, stage clear, boss kill, zone no-miss.
//
// Two kinds of points:
//   sim.addKill(base, e, piece) -> kill points = base x DEEP SKY x chain tier x heat factor x loop factor, rounded down to 10.
//                           With an enemy `e`, Interrupt / Lead / Close adjust the base and the kill extends the chain.
//                           Without one, only a destroyed boss piece adds 1 to the chain:
//                             piece === true   a boss piece (use sim.pieceKill(base))
//                             piece === false  never a piece (KINDLE bullet clear passes this)
//                             piece omitted    legacy: a piece if a boss is up (v1 Eclipse still calls addKill(1000))
//   sim.pieceKill(base)  -> a destroyed boss piece (panel, tendril, lens, ...): kill points, chain +1, window 90.
//   sim.addBonus(value)  -> flat bonus = value x loop factor only.
//   sim.bossBonus()      -> the boss kill bonus, max(5000, 40000 - 8 x fight frames), flat.
// Both add to the score through sim.addScore (which owns the extra-life rule).
//
// Boss hits contract (every boss): a shot that connects with any boss part must do S.hits++ (as Eclipse does).
// While S.boss.on, any rise in S.hits refreshes the chain window to 90 without adding count; deflected
// shots must not touch S.hits. A destroyed piece calls S.pieceKill(base).
//
// Every timer here runs in step(), which the sim skips during hit-stop, so hit-stop freezes the chain window.
// Seams for later slices (read, never written here):
//   S.power === 'lance'  a kill grants a 45-frame window instead of 90 (S4 sets S.power)
//   S.power === 'halo'   no grazing while HALO is up (S4)
// Presentation: popups go into a small preallocated ring on S (S.cpop) that render/hud-chain.js reads.
import { METER_MAX, POP_KINDLE_READY, C_AMBER, SFX_ID } from '../defs.js';
import { CLOSE_RANGE } from './feel.js';

export const CHAIN_WINDOW = 90, CHAIN_WINDOW_LANCE = 45, GRAZE_FRAMES = 12;
export const GRAZE_RADIUS = 7, GRAZE_POINTS = 20, GRAZE_METER = 1 / 8;
export const INTERRUPT_BASE = 750, LEAD_MULT = 2, CLOSE_MULT = 1.5;
export const CHAIN_BONUS_K = 5, CHAIN_BONUS_MIN = 10, CHAIN_BONUS_CAP = 60;
export const CLEAR_PER_PCT = 30, BOSS_BONUS_MAX = 40000, BOSS_BONUS_PER_FRAME = 8, BOSS_BONUS_MIN = 5000, ZONE_NO_MISS = 20000;
// Close (B.4, and the 'close' feel in sim.js): a diving enemy within CLOSE_RANGE of the living player's center
export function isClose(e, P) {
  if (!P.alive || !(e.st === 'dive' || e.st === 'spark')) return false;
  const dx = e.x - P.x, dy = e.y - P.y;
  return dx * dx + dy * dy < CLOSE_RANGE * CLOSE_RANGE;
}
// player hit box for enemy bullets (sim.js: abs(dx) < 3.5 and abs(dy) < 4.5); a graze is outside it but within 7 units
const HIT_X = 3.5, HIT_Y = 4.5;

// popup kinds in S.cpop
export const CP_SCATTER = 1, CP_INTERRUPT = 2, CP_CLOSE = 3, CP_GRAZE = 4, CP_CHAIN = 5, CP_CLEAR = 6, CP_NOMISS = 7, CP_LEADX2 = 8;
export const CPOP_N = 16;

// chain tier for a chain of length n (the kill that makes the chain n is scored at tier(n))
export function tier(n) { return n >= 60 ? 4 : n >= 30 ? 3 : n >= 10 ? 2 : 1; }
// the chain end bonus for a chain of length n (before the loop factor)
export function chainBonus(n) { if (n < CHAIN_BONUS_MIN) return 0; const m = Math.min(n, CHAIN_BONUS_CAP); return CHAIN_BONUS_K * m * m; }
// base adjustments (B.4): at most one applies. Interrupt replaces the base; Lead x2 (on a path or joining)
// and Close +50% (diving) never meet, since they need different enemy states (no stack rule)
export function killBase(base, lead, interrupt, close) {
  return interrupt ? INTERRUPT_BASE : lead ? base * LEAD_MULT : close ? base * CLOSE_MULT : base;
}
export const heatFactor = heat => 1 + Math.min(100, Math.max(0, heat)) / 200;
// kill points; the tiny epsilon keeps products like 110 x 1.02 x 2 from flooring a float hair below a multiple of 10
export function killPoints(b, mult, t, heat, loop) { return Math.floor(b * mult * t * heatFactor(heat) * loop / 10 + 1e-7) * 10; }
export const accuracyPct = (hits, shots) => shots > 0 ? Math.min(100, Math.floor(hits * 100 / shots)) : 0;
export const bossBonusOf = fight => Math.max(BOSS_BONUS_MIN, BOSS_BONUS_MAX - BOSS_BONUS_PER_FRAME * fight);

const isMoving = st => st === 'wait' || st === 'path' || st === 'join';

export const scoreSystem = {
  id: 'score',
  init(S) {
    S.chain = 0; S.chainT = 0; S.chainCap = CHAIN_WINDOW; S.chainMax = 0; S.grazes = 0;
    S.chainLast = 0; S.chainEndF = -999; // last chain length and the frame it ended (HUD fade)
    S.scatter = new Uint8Array(32);       // entry groups whose leader was killed on its path this stage
    S.stShots = 0; S.stHits = 0; S.stDeaths = 0; S.zoneKey = -1; S.zoneDeaths = 0; S.lastHits = 0;
    S.cpop = { k: new Uint8Array(CPOP_N), x: new Float32Array(CPOP_N), y: new Float32Array(CPOP_N),
      v: new Int32Array(CPOP_N), w: new Int32Array(CPOP_N), f: new Int32Array(CPOP_N), head: 0 };

    const pop = (k, x, y, v, w) => {
      const P = S.cpop, i = P.head; P.head = (i + 1) % CPOP_N;
      P.k[i] = k; P.x[i] = x; P.y[i] = y; P.v[i] = v; P.w[i] = w; P.f[i] = S.frame;
    };
    S.chainPop = pop;
    const grant = window => {
      S.chain++; S.chainT = window; S.chainCap = window;
      if (S.chain > S.chainMax) S.chainMax = S.chain;
    };

    S.addKill = (base, e, piece) => {
      let b = base;
      if (e) {
        const P = S.player;
        const interrupt = e.type === 'warden' && e.st === 'tele';
        const leadKill = !interrupt && e.leader && e.st === 'path';
        const follower = !interrupt && !leadKill && e.group >= 0 && S.scatter[e.group] === 1 && isMoving(e.st);
        const close = isClose(e, P);
        b = killBase(base, leadKill || follower, interrupt, close);
        if (leadKill) { S.scatter[e.group] = 1; pop(CP_SCATTER, e.x, e.y - 12, 0, 0); }
        else if (follower) pop(CP_LEADX2, e.x, e.y - 12, 0, 0);
        if (interrupt) pop(CP_INTERRUPT, e.x, e.y - 12, 0, 0);
        else if (close) pop(CP_CLOSE, e.x, e.y - 12, 0, 0);
        grant(S.power === 'lance' ? CHAIN_WINDOW_LANCE : CHAIN_WINDOW);
      } else if (piece === true || (piece === undefined && S.boss.on)) grant(CHAIN_WINDOW); // a destroyed boss piece
      const v = killPoints(b, S.mult, tier(S.chain), S.heat, S.D.scoreLoop);
      S.addScore(v);
      return v;
    };
    S.pieceKill = base => S.addKill(base, null, true);
    S.addBonus = value => {
      const v = Math.floor(value * S.D.scoreLoop);
      S.addScore(v);
      return v;
    };
    S.bossBonus = () => S.addBonus(bossBonusOf(S.boss.fight));
    // end the chain. Window ran out or stage end: a chain of 10 or more pays its end bonus.
    // Death: forfeit (pass forfeit = true), the chain pays nothing
    S.endChain = forfeit => {
      if (S.chain <= 0) return 0;
      const n = S.chain, pts = forfeit ? 0 : chainBonus(n);
      const v = pts ? S.addBonus(pts) : 0;
      if (v) pop(CP_CHAIN, S.player.x, 60, v, n);
      S.chainLast = n; S.chainEndF = S.frame;
      S.chain = 0; S.chainT = 0; S.chainCap = CHAIN_WINDOW;
      return v;
    };
  },

  step(S) {
    if (S.chain > 0) {
      // stage end banks the chain
      if (S.state === 'clear' || S.state === 'bossOut' || S.state === 'bonusEnd') S.endChain();
      else {
        // boss hits (any shot that connects while a boss is up) refresh the window to 90 but add no count
        if (S.boss.on && S.hits !== S.lastHits) { S.chainT = CHAIN_WINDOW; S.chainCap = CHAIN_WINDOW; }
        if (--S.chainT <= 0) S.endChain();
      }
    }
    S.lastHits = S.hits;
    grazeStep(S);
  },

  onEvent(S, ev) {
    switch (ev.type) {
      case 'stage': {
        S.endChain();
        S.scatter.fill(0);
        S.stShots = S.shotsFired; S.stHits = S.hits; S.stDeaths = S.deaths; S.lastHits = S.hits;
        const zk = (S.stage - 1) / 5 | 0;
        if (zk !== S.zoneKey) { S.zoneKey = zk; S.zoneDeaths = S.deaths; }
        break;
      }
      case 'death': S.endChain(true); break;
      case 'clear': {
        // a normal stage was cleared: bank the chain, then the no-death clear bonus (accuracy capped at 100%)
        S.endChain();
        if (S.deaths === S.stDeaths) {
          const pct = accuracyPct(S.hits - S.stHits, S.shotsFired - S.stShots);
          const v = S.addBonus(CLEAR_PER_PCT * pct);
          S.chainPop(CP_CLEAR, 200, 190, v, pct);
        }
        break;
      }
      case 'bossKill':
        S.endChain();
        if (S.deaths === S.zoneDeaths) { const v = S.addBonus(ZONE_NO_MISS); S.chainPop(CP_NOMISS, 200, 200, v, 0); }
        break;
      case 'bossTimeout': S.endChain(); break;
    }
  }
};

// graze (B.4): an enemy bullet comes within 7 units of the player's center without hitting. Once per bullet.
// b.g: 0 not yet, 1 inside the radius but on course for the hit box (decided later), 2 done (grazed or touched).
// A bullet is awarded on the first frame it is inside the radius, unless its current velocity carries it into the
// hit box within HIT_LOOK frames: then it waits, and grazes only if it leaves the radius (or turns off course)
// without touching the box. The radius test uses the bullet's whole path this frame (prev -> current position),
// so a fast bullet cannot skip over the radius between two samples. Bullets that hit this frame are already off.
const HIT_LOOK = 8;
// does a bullet at (dx, dy) from the player, moving (vx, vy) per frame, enter the hit box within HIT_LOOK frames?
function onCourse(dx, dy, vx, vy) {
  let t0 = 0, t1 = HIT_LOOK;
  if (vx === 0) { if (Math.abs(dx) >= HIT_X) return false; }
  else { let a = (-HIT_X - dx) / vx, b = (HIT_X - dx) / vx; if (a > b) { const t = a; a = b; b = t; } if (a > t0) t0 = a; if (b < t1) t1 = b; }
  if (vy === 0) { if (Math.abs(dy) >= HIT_Y) return false; }
  else { let a = (-HIT_Y - dy) / vy, b = (HIT_Y - dy) / vy; if (a > b) { const t = a; a = b; b = t; } if (a > t0) t0 = a; if (b < t1) t1 = b; }
  return t0 < t1;
}
function grazeStep(S) {
  const P = S.player;
  if (S.state !== 'play' || !P.alive || P.inv > 0 || S.power === 'halo') return;
  const eb = S.eb, r2 = GRAZE_RADIUS * GRAZE_RADIUS;
  for (let i = 0; i < eb.length; i++) {
    const b = eb[i];
    if (!b.on || b.g === 2) continue;
    const dx = b.x - P.x, dy = b.y - P.y;
    if (Math.abs(dx) < HIT_X && Math.abs(dy) < HIT_Y) { b.g = 2; continue; }
    if (b.g === 1) {
      // waiting: grazes once it has left the radius, or is no longer heading for the hit box
      if (dx * dx + dy * dy >= r2 || !onCourse(dx, dy, b.vx, b.vy)) { b.g = 2; graze(S, b); }
      continue;
    }
    // closest point of the segment prev -> current to the player's center
    const ox = b.px - P.x, oy = b.py - P.y, vx = b.x - b.px, vy = b.y - b.py, vv = vx * vx + vy * vy;
    let t = vv > 0 ? -(ox * vx + oy * vy) / vv : 1;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ox + vx * t, cy = oy + vy * t;
    if (cx * cx + cy * cy >= r2) continue;
    if (dx * dx + dy * dy < r2 && onCourse(dx, dy, b.vx, b.vy)) b.g = 1;
    else { b.g = 2; graze(S, b); }
  }
}

function graze(S, b) {
  S.grazes++;
  S.addBonus(GRAZE_POINTS);
  // refuel the chain, never above the window the last kill granted
  if (S.chain > 0) S.chainT = Math.min(S.chainCap, S.chainT + GRAZE_FRAMES);
  if (S.meter < METER_MAX) {
    S.meter = Math.min(METER_MAX, S.meter + GRAZE_METER);
    if (S.meter === METER_MAX) { S.popup(POP_KINDLE_READY, S.player.x, S.player.y - 22, 0, C_AMBER); S.sfx(SFX_ID.kindle); }
  }
  // spark direction: from the ship toward the bullet, x1000 (presentation only)
  const P = S.player, dx = b.x - P.x, dy = b.y - P.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
  S.chainPop(CP_GRAZE, P.x, P.y, Math.round(dx / d * 1000), Math.round(dy / d * 1000));
}
