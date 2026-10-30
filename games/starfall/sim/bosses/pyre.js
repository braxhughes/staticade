// PYRE, the Z3 boss (design.md B.6): a hollow sun with a crown of 12 flare petals around a dark core.
//   Phase 1 Corona   (start):            every 90 frames one petal brightens and wobbles for 40 frames, then
//                                         detaches and dives (2.4) with 2 aimed shots (1.8). Aimed 3-way (1.8)
//                                         every 70. Attached petal kill = 600 base, detached = 300 base.
//   Phase 2 Breath   (6 petals gone):     the sun holds still at (CX, 88). The rest of the crown stays attached.
//                                         It alternates inhale (150) and exhale (90). Inhale starts with one arc
//                                         ring (spec below) and pulls player shots sideways toward the core.
//                                         Exhale opens with a radial burst of 16 (1.5); the core (30 hp) can be
//                                         hit only during the exhale.
//   Phase 3 Collapse (core <= 40%):      sun shrinks to 60%, sway 140, faster; the remaining petals all detach
//                                         (40-frame brighten first). 3-arm spiral, one bullet per arm every 9
//                                         frames (1.3) after 30 frames of guide lines; aimed 5-way (2.0) every 60.
//                                         Core always open, 12 hp left.
// Arc ring (phase 2): bullet k aims at (5k, 274) for k = 0..80 from the core, all at the same speed, radius 14
// to start, 1.4 units/frame. Slots within 24 units of the gap x are removed (9 slots, 72 bullets). A gold marker
// sweeps the player's row at 1.2 units/frame between x 30 and 370; the gap locks at the marker's x when the ring
// spawns, then is moved toward the player until it is at most 200 units from the player's x. The ring always
// spawns in full (B.5 exception) and counts toward the cap. Its telegraph: marker bright + source glow, 24 frames.
// Shot pull (inhale only): each player shot gets 0.03 units/frame^2 sideways toward the core's x, sideways speed
// capped at 1.2; otherwise sideways speed decays x0.8 per frame. Vertical speed is unchanged.
// Every bullet-spawning or dive event has >= 20 frames of visible warning (B.6, B.9); aimed volleys lock their
// target point when the 20-frame glow starts. Phase change: bullets clear, 8 hit-stop, shake 6, popup, 20 quiet
// frames. Entrance 120 frames, invulnerable. Every volley except the ring obeys the volley-wait rule (B.5).
// Boss interface: see sim/registry.js.
import { CX, W, H, PI, TAU, SFX_ID, POP_NUM, POP_PHASE2, POP_CORE, C_ROSE, C_GOLD, C_TEAL, FX_BOSS_DOTS, FX_CORE, FX_DEFLECT } from '../../defs.js';
import { sin, cos, atan2, hypot } from '../../../../engine/dmath.js';
import { limitBullet, heatBullet } from '../difficulty.js';
import { TELE_AIM, VOLLEY_WAIT } from '../feel.js';

// ---------- the B.6 table ----------
export const PYRE = {
  enterFrames: 120, petals: 12, petalHp: 4, attachedPts: 600, detachedPts: 300, coreHp: 30,
  phase2Gone: 6, phase3Frac: 0.4, quiet: 20,
  petalR: 30, petalHit: 6, diveHitX: 7, diveHitY: 8, coreR: 14, hullR: 38,
  spin1: 0.008, spin2: 0.004, spin3: 0.016,
  sway1: 100, sway3: 140, swayF1: 0.01, swayF3: 0.016, bob: 14, holdY: 88, scale3: 0.6,
  // phase 1
  detachEvery: 90, detachTele: 40, diveSpd: 2.4, diveShots: 2, diveShotSpd: 1.8, diveTurn: 0.06,
  aim1Every: 70, aim1N: 3, aim1Spd: 1.8, aim1Step: 0.22,
  // phase 2
  inhale: 150, exhale: 90, ringTele: 24, burstTele: 20, burstN: 16, burstSpd: 1.5,
  ringSlots: 81, ringStep: 5, rowY: 274, gapHalf: 24, ringR0: 14, ringSpd: 1.4,
  markerSpd: 1.2, markerLo: 30, markerHi: 370, reach: 200,
  pullAcc: 0.03, pullMax: 1.2, pullDecay: 0.8,
  // phase 3
  guide: 30, spiralEvery: 9, spiralArms: 3, spiralSpd: 1.3, spiralTurn: 0.021,
  fanEvery: 60, fanN: 5, fanSpd: 2.0, fanStep: 0.2,
  tele: TELE_AIM, safe: 48            // aim-lock glow length; no bullet spawns within 48 units of the player (B.9)
};
const P = PYRE, NP = P.petals;
// petal states
export const PETAL_ON = 0, PETAL_TELE = 1, PETAL_DIVE = 2, PETAL_GONE = 3;
// breath states (phase 2)
export const BREATH_WAIT = 0, BREATH_IN = 1, BREATH_OUT = 2;

const spd = (S, v) => limitBullet(v * S.D.bulletMul * heatBullet(S.heat));
const muzzleY = boss => boss.y + 12 * boss.scale;
const coreThreshold = boss => Math.round(boss.coreMax * P.phase3Frac);
// petals gone from the crown for the phase 2 trigger: diving petals count as gone, as do destroyed ones
function petalsGone(boss) { let n = 0; for (let k = 0; k < NP; k++) if (boss.fSt[k] >= PETAL_DIVE) n++; return n; }
const phaseFor = boss => boss.core <= coreThreshold(boss) ? 3 : petalsGone(boss) >= P.phase2Gone ? 2 : 1;
// core open: exhale in phase 2, always in phase 3
export const coreOpen = boss => boss.phase === 3 || (boss.phase === 2 && boss.breath === BREATH_OUT);

// ---------- petals ----------
function attachedPos(boss) {
  const r = P.petalR * boss.scale;
  for (let k = 0; k < NP; k++) {
    if (boss.fSt[k] > PETAL_TELE) continue;
    const a = boss.rot + k * TAU / NP;
    boss.fX[k] = boss.x + cos(a) * r; boss.fY[k] = boss.y + sin(a) * r;
  }
}
// the attached petal nearest straight down starts its 40-frame brighten-and-wobble telegraph
function startDetach(boss) {
  let best = 99, pick = -1;
  for (let k = 0; k < NP; k++) {
    if (boss.fSt[k] !== PETAL_ON || boss.fHp[k] <= 0) continue;
    let d = (boss.rot + k * TAU / NP - PI / 2) % TAU; if (d < 0) d += TAU; if (d > PI) d = TAU - d;
    if (d < best) { best = d; pick = k; }
  }
  if (pick >= 0) { boss.fSt[pick] = PETAL_TELE; boss.fT[pick] = P.detachTele; }
}
function detach(S, k) {
  const boss = S.boss, a = boss.rot + k * TAU / NP, sp = P.diveSpd * S.D.diveMul;
  boss.fSt[k] = PETAL_DIVE; boss.fT[k] = 0;
  boss.fVx[k] = cos(a) * sp; boss.fVy[k] = sin(a) * sp;
  boss.fTx[k] = S.player.x;                         // the dive heads for where the player was at detach
  boss.fShots[k] = P.diveShots; boss.fCd[k] = 10; boss.fAimT[k] = 0; boss.fWait[k] = 0;
  S.sfx(SFX_ID.morph);
}
function firePetal(S, k) {
  const boss = S.boss, p = S.player, x = boss.fX[k], y = boss.fY[k] + 4;
  if (hypot(x - p.x, y - p.y) < P.safe) return;    // B.9 rule 5
  const a = atan2(boss.fAimY[k] - y, boss.fAimX[k] - x), sp = spd(S, P.diveShotSpd);
  S.eFire(x, y, cos(a) * sp, sin(a) * sp, false);
}
function petalGone(S, k) {
  const boss = S.boss;
  boss.fSt[k] = PETAL_GONE; boss.fHp[k] = 0; boss.fAimT[k] = 0; boss.fWait[k] = 0; boss.fShots[k] = 0;
  for (let i = 0; i < 3; i++) S.fx(FX_CORE, boss.fX[k], boss.fY[k]);
}
// diving petals move every frame (like enemies, also during the quiet frames); they shoot only while the player is in play
function petals(S) {
  const boss = S.boss, pl = S.player, play = S.state === 'play' && pl.alive;
  for (let k = 0; k < NP; k++) {
    if (boss.fFl[k] > 0) boss.fFl[k]--;
    if (boss.fSt[k] !== PETAL_DIVE) continue;
    // steer toward the locked target x, then off the bottom of the screen
    const sp = P.diveSpd * S.D.diveMul, dx = boss.fTx[k] - boss.fX[k], dy = H + 30 - boss.fY[k], d = hypot(dx, dy) || 1;
    let vx = boss.fVx[k] + (dx / d * sp - boss.fVx[k]) * P.diveTurn, vy = boss.fVy[k] + (dy / d * sp - boss.fVy[k]) * P.diveTurn;
    const m = hypot(vx, vy) || 1; vx *= sp / m; vy *= sp / m;
    boss.fVx[k] = vx; boss.fVy[k] = vy; boss.fX[k] += vx; boss.fY[k] += vy;
    if (boss.fY[k] > H + 12 || boss.fX[k] < -16 || boss.fX[k] > W + 16) { boss.fSt[k] = PETAL_GONE; boss.fAimT[k] = 0; boss.fWait[k] = 0; continue; }
    // aimed shots: the 20-frame glow runs out, then the shot fires (or waits for room, then is skipped)
    if (boss.fAimT[k] > 0) {
      if (--boss.fAimT[k] === 0) { if (play) { if (S.volleyOk(1)) firePetal(S, k); else boss.fWait[k] = VOLLEY_WAIT; } }
    } else if (boss.fWait[k] > 0) {
      if (!play) boss.fWait[k] = 0;
      else if (S.volleyOk(1)) { boss.fWait[k] = 0; firePetal(S, k); } else boss.fWait[k]--;
    } else if (play && boss.fShots[k] > 0 && boss.fY[k] > H * 0.28 && boss.fY[k] < H * 0.69 && --boss.fCd[k] <= 0) {
      boss.fAimT[k] = P.tele; boss.fAimX[k] = pl.x; boss.fAimY[k] = pl.y; boss.fShots[k]--; boss.fCd[k] = 24;
    }
    // body hit (B.9: abs(dx) < 7 and abs(dy) < 7)
    if (pl.alive && pl.inv <= 0 && Math.abs(boss.fX[k] - pl.x) < 7 && Math.abs(boss.fY[k] - pl.y) < 7) { petalGone(S, k); S.playerDie(); }
  }
}

// ---------- shot pull (phase 2 inhale) ----------
// boss.sVx[i]: sideways speed of player shot slot i; boss.sY[i]: its y at the last update (a shot only moves up,
// so a slot whose y did not drop holds a new shot and starts with no sideways speed)
function pull(S) {
  const boss = S.boss, ps = S.ps, on = boss.phase === 2 && boss.breath === BREATH_IN;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (!p.on || p.y >= boss.sY[i]) boss.sVx[i] = 0;
    boss.sY[i] = p.on ? p.y : 1e9;
    if (!p.on) continue;
    let v = boss.sVx[i];
    if (on) { v += p.x < boss.x ? P.pullAcc : p.x > boss.x ? -P.pullAcc : 0; if (v > P.pullMax) v = P.pullMax; else if (v < -P.pullMax) v = -P.pullMax; }
    else v *= P.pullDecay;
    boss.sVx[i] = v; p.x += v;
  }
}

// ---------- attacks ----------
function fireAim(S) {
  const boss = S.boss, fan = boss.phase === 3, n = fan ? P.fanN : P.aim1N, sp = spd(S, fan ? P.fanSpd : P.aim1Spd), st = fan ? P.fanStep : P.aim1Step;
  boss.aimA = atan2(boss.aimY - muzzleY(boss), boss.aimX - boss.x);
  for (let i = 0; i < n; i++) { const a = boss.aimA + (i - (n - 1) / 2) * st; S.eFire(boss.x, muzzleY(boss), cos(a) * sp, sin(a) * sp, false); }
}
const aimCount = boss => boss.phase === 3 ? P.fanN : P.aim1N;
function startAim(S) { const boss = S.boss; boss.aimT = P.tele; boss.aimX = S.player.x; boss.aimY = S.player.y; }

// the arc ring: always in full (B.5 exception)
function fireRing(S) {
  const boss = S.boss, px = S.player.x, sp = spd(S, P.ringSpd);
  let g = boss.mk;
  if (g - px > P.reach) g = px + P.reach; else if (px - g > P.reach) g = px - P.reach;
  boss.gapX = g; boss.gapPx = px; boss.rings++;
  const dy = P.rowY - boss.y;
  for (let k = 0; k < P.ringSlots; k++) {
    const x = k * P.ringStep;
    if (Math.abs(x - g) <= P.gapHalf) continue;
    const dx = x - boss.x, d = hypot(dx, dy), ux = dx / d, uy = dy / d;
    S.eFire(boss.x + ux * P.ringR0, boss.y + uy * P.ringR0, ux * sp, uy * sp, true);
  }
  S.sfx(SFX_ID.big);
}
function fireBurst(S) {
  const boss = S.boss, sp = spd(S, P.burstSpd), r = 14 * boss.scale, o = boss.rings * 0.2;
  for (let i = 0; i < P.burstN; i++) { const a = o + (i + 0.5) * TAU / P.burstN, c = cos(a), s = sin(a); S.eFire(boss.x + c * r, boss.y + s * r, c * sp, s * sp, true); }
}
function fireSpiral(S) {
  const boss = S.boss, sp = spd(S, P.spiralSpd), r = 14 * boss.scale;
  for (let k = 0; k < P.spiralArms; k++) { const a = boss.sa + k * TAU / P.spiralArms, c = cos(a), s = sin(a); S.eFire(boss.x + c * r, boss.y + s * r, c * sp, s * sp, true); }
}
function tryAim(S) { if (S.volleyOk(aimCount(S.boss))) fireAim(S); else S.boss.wAim = VOLLEY_WAIT; }
function tryBurst(S) { if (S.volleyOk(P.burstN)) fireBurst(S); else S.boss.wBurst = VOLLEY_WAIT; }

// drop every telegraph and waiting volley (player down, or a phase change); phase 2 restarts its breath cycle
function dropAttacks(boss) {
  boss.aimT = 0; boss.wAim = 0; boss.ringT = 0; boss.burstT = 0; boss.wBurst = 0; boss.wSpiral = 0; boss.guideT = 0; boss.spiral = false;
  boss.breath = BREATH_WAIT; boss.bt = 0;
  for (let k = 0; k < NP; k++) {
    if (boss.fSt[k] === PETAL_TELE) { boss.fSt[k] = PETAL_ON; boss.fT[k] = 0; }
    boss.fAimT[k] = 0; boss.fWait[k] = 0;
  }
}

function attacks(S) {
  const boss = S.boss, at = ++boss.at, T = P.tele;
  if (boss.wAim > 0) { if (S.volleyOk(aimCount(boss))) { boss.wAim = 0; fireAim(S); } else boss.wAim--; }
  if (boss.wBurst > 0) { if (S.volleyOk(P.burstN)) { boss.wBurst = 0; fireBurst(S); } else boss.wBurst--; }
  if (boss.wSpiral > 0) { if (S.volleyOk(P.spiralArms)) { boss.wSpiral = 0; fireSpiral(S); } else boss.wSpiral--; }
  if (boss.aimT > 0 && --boss.aimT === 0) tryAim(S);
  // petal telegraphs that run out detach
  for (let k = 0; k < NP; k++) if (boss.fSt[k] === PETAL_TELE && --boss.fT[k] <= 0) detach(S, k);

  if (boss.phase === 1) {
    if (at % P.aim1Every === P.aim1Every - T && boss.wAim === 0 && boss.aimT === 0) startAim(S);
    if (at % P.detachEvery === P.detachEvery - P.detachTele) {
      let busy = false; for (let k = 0; k < NP; k++) if (boss.fSt[k] === PETAL_TELE) busy = true;
      if (!busy) startDetach(boss);
    }
  } else if (boss.phase === 2) {
    if (boss.burstT > 0 && --boss.burstT === 0) tryBurst(S);
    if (boss.ringT > 0) {
      if (--boss.ringT === 0) { fireRing(S); boss.breath = BREATH_IN; boss.bt = P.inhale; }
    } else if (boss.breath === BREATH_IN) {
      if (--boss.bt === P.burstTele) boss.burstT = P.burstTele;     // core glows rose 20 frames before the exhale
      if (boss.bt === 0) { boss.breath = BREATH_OUT; boss.bt = P.exhale; }
    } else if (boss.breath === BREATH_OUT) {
      if (--boss.bt === P.ringTele) boss.ringT = P.ringTele;        // the ring telegraph ends the exhale
    } else boss.ringT = P.ringTele;                                // first ring of the phase (or after a respawn)
  } else {
    if (boss.detachAll) {
      boss.detachAll = false;
      for (let k = 0; k < NP; k++) if (boss.fSt[k] === PETAL_ON && boss.fHp[k] > 0) { boss.fSt[k] = PETAL_TELE; boss.fT[k] = P.detachTele; }
    }
    boss.sa = at * P.spiralTurn;
    if (!boss.spiral) {
      if (boss.guideT === 0) boss.guideT = P.guide;
      else if (--boss.guideT === 0) boss.spiral = true;
    } else if (at % P.spiralEvery === 0 && boss.wSpiral === 0) { if (S.volleyOk(P.spiralArms)) fireSpiral(S); else boss.wSpiral = VOLLEY_WAIT; }
    if (at % P.fanEvery === P.fanEvery - T && boss.wAim === 0 && boss.aimT === 0) startAim(S);
  }
}

// the phase-change rule (B.6, B.9)
function enterPhase(S, n) {
  const boss = S.boss;
  boss.phase = n; boss.fury = n >= 2; boss.at = 0; boss.quiet = P.quiet;
  dropAttacks(boss);
  for (let i = 0; i < S.eb.length; i++) S.eb[i].on = false;
  // petals already diving hold their fire for good, so the quiet period is really quiet
  for (let k = 0; k < NP; k++) boss.fShots[k] = 0;
  boss.detachAll = n === 3;
  if (n === 3) boss.scale = P.scale3;
  S.feel('phase'); S.sfx(SFX_ID.phase2);
  if (n >= 2) S.popup(n === 3 ? POP_CORE : POP_PHASE2, boss.x, boss.y - 50, 0, C_ROSE);
}

function hitPetal(S, p, k, detached) {
  const boss = S.boss;
  p.on = false; S.hits++;
  boss.fHp[k]--; boss.fFl[k] = 6; S.sfx(SFX_ID.ding);
  if (boss.fHp[k] <= 0) {
    petalGone(S, k);
    const v = S.pieceKill(detached ? P.detachedPts : P.attachedPts); S.popup(POP_NUM, p.x, p.y, v, detached ? C_GOLD : C_TEAL);
    S.feel('piece'); S.sfx(SFX_ID.big);
  }
  return true;
}

export const pyre = {
  id: 'pyre',
  name: 'PYRE',
  setup(S) {
    const boss = S.boss;
    if (!boss.fHp) {
      // allocated once per sim (the boss object is reused for every boss stage)
      for (const f of ['fHp', 'fSt', 'fT', 'fX', 'fY', 'fPx', 'fPy', 'fVx', 'fVy', 'fTx', 'fAimT', 'fAimX', 'fAimY', 'fWait', 'fShots', 'fCd', 'fFl']) boss[f] = new Float64Array(NP);
      boss.sVx = new Float64Array(S.ps.length); boss.sY = new Float64Array(S.ps.length);
    }
    boss.fMax = Math.round(P.petalHp * S.D.bossHp);
    for (let k = 0; k < NP; k++) {
      boss.fHp[k] = boss.fMax; boss.fSt[k] = PETAL_ON; boss.fT[k] = 0; boss.fVx[k] = 0; boss.fVy[k] = 0; boss.fTx[k] = 0;
      boss.fAimT[k] = 0; boss.fAimX[k] = 0; boss.fAimY[k] = 0; boss.fWait[k] = 0; boss.fShots[k] = 0; boss.fCd[k] = 0; boss.fFl[k] = 0;
    }
    for (let i = 0; i < boss.sVx.length; i++) { boss.sVx[i] = 0; boss.sY[i] = 1e9; }
    boss.coreMax = boss.core = Math.round(P.coreHp * S.D.bossHp);
    boss.phase = 1; boss.fury = false; boss.enterT = 0; boss.at = 0; boss.quiet = 0; boss.scale = 1;
    boss.swayA = P.sway1; boss.bobA = 1; boss.sa = 0; boss.aimA = PI / 2; boss.detachAll = false;
    boss.mk = CX; boss.mkDir = 1; boss.gapX = -1; boss.gapPx = -1; boss.rings = 0;
    dropAttacks(boss);
    attachedPos(boss);
    for (let k = 0; k < NP; k++) { boss.fPx[k] = boss.fX[k]; boss.fPy[k] = boss.fY[k]; }
  },
  update(S) {
    const boss = S.boss, player = S.player;
    if (boss.flash > 0) boss.flash--;
    for (let k = 0; k < NP; k++) { boss.fPx[k] = boss.fX[k]; boss.fPy[k] = boss.fY[k]; }
    if (boss.entering) {
      const u = ++boss.enterT / P.enterFrames, e = 1 - (1 - u) * (1 - u);
      boss.t = 0; boss.x = CX; boss.y = -60 + 148 * e;
      boss.rot += P.spin1;
      attachedPos(boss);
      if (boss.enterT >= P.enterFrames) boss.entering = false;
      return;
    }
    const want = phaseFor(boss), changed = want > boss.phase;
    if (changed) enterPhase(S, want);
    boss.t++;
    const ph = boss.phase;
    boss.rot += ph === 1 ? P.spin1 : ph === 2 ? P.spin2 : P.spin3;
    if (ph === 2) {
      // hold still at (CX, 88): ease there over the quiet frames
      boss.swayA *= 0.85; boss.bobA *= 0.85;
      boss.x += (CX - boss.x) * 0.15; boss.y += (P.holdY - boss.y) * 0.15;
      if (Math.abs(boss.x - CX) < 0.01) boss.x = CX;
      if (Math.abs(boss.y - P.holdY) < 0.01) boss.y = P.holdY;
      // the gap marker sweeps the player's row
      boss.mk += boss.mkDir * P.markerSpd;
      if (boss.mk >= P.markerHi) { boss.mk = P.markerHi; boss.mkDir = -1; } else if (boss.mk <= P.markerLo) { boss.mk = P.markerLo; boss.mkDir = 1; }
    } else {
      const s3 = ph === 3;
      boss.swayA += ((s3 ? P.sway3 : P.sway1) - boss.swayA) * 0.05; boss.bobA += (1 - boss.bobA) * 0.05;
      boss.x = CX + sin(boss.t * (s3 ? P.swayF3 : P.swayF1)) * boss.swayA;
      boss.y = P.holdY + sin(boss.t * (s3 ? 0.035 : 0.023)) * P.bob * boss.bobA;
    }
    attachedPos(boss);
    pull(S);
    petals(S);
    if (changed) return;
    if (boss.quiet > 0) { boss.quiet--; return; }
    if (S.state !== 'play' || !player.alive) { dropAttacks(boss); return; }
    attacks(S);
  },
  // test hook (SF.bossPhase): n = 1 restores the crown and the core; n = 2 removes 6 petals; n = 3 also takes the
  // core to its phase 3 hp. The phase change runs now (or at the end of the entrance).
  setPhase(S, n) {
    const boss = S.boss, want = n >= 3 ? 3 : n <= 1 ? 1 : 2;
    for (let k = 0; k < NP; k++) {
      const gone = want >= 2 && k < P.phase2Gone;
      boss.fSt[k] = gone ? PETAL_GONE : PETAL_ON; boss.fHp[k] = gone ? 0 : boss.fMax;
      boss.fT[k] = 0; boss.fAimT[k] = 0; boss.fWait[k] = 0; boss.fShots[k] = 0;
    }
    boss.core = want === 3 ? coreThreshold(boss) : boss.coreMax;
    attachedPos(boss);
    if (boss.entering) { if (want === 1) boss.phase = 1; return; }
    if (want !== boss.phase) enterPhase(S, want);
    if (want < 3) { boss.scale = 1; boss.detachAll = false; }
  },
  // hit rule: diving petals, then attached petals, then the core (open: hit; closed: deflect). A shot through a
  // gap in the crown that misses the core passes on.
  shot(S, p) {
    const boss = S.boss, sc = boss.scale, dx = p.x - boss.x, dy = p.y - boss.y;
    if (boss.entering) {
      if (hypot(dx, dy) > P.hullR * sc) return false;
      p.on = false; S.sfx(SFX_ID.deflect); S.fx(FX_DEFLECT, p.x, p.y); return true;
    }
    for (let k = 0; k < NP; k++) {
      if (boss.fSt[k] !== PETAL_DIVE || boss.fHp[k] <= 0) continue;
      if (Math.abs(p.x - boss.fX[k]) < P.diveHitX && Math.abs(p.y - boss.fY[k]) < P.diveHitY) return hitPetal(S, p, k, true);
    }
    const h = P.petalHit * (0.5 + 0.5 * sc);
    for (let k = 0; k < NP; k++) {
      if (boss.fSt[k] > PETAL_TELE || boss.fHp[k] <= 0) continue;
      if (Math.abs(p.x - boss.fX[k]) < h && Math.abs(p.y - boss.fY[k]) < h) return hitPetal(S, p, k, false);
    }
    if (hypot(dx, dy) > P.coreR * sc) return false;
    p.on = false;
    if (coreOpen(boss)) {
      S.hits++; boss.flash = 5; boss.core--; S.sfx(SFX_ID.ding); S.fx(FX_CORE, p.x, p.y);
      if (boss.core <= 0) {
        for (let i = 0; i < 4; i++) S.fx(FX_CORE, boss.x, boss.y);
        S.fx(FX_BOSS_DOTS, 1, 0, 4, boss.x, boss.y);
        S.bossDefeated();
      }
    } else { S.sfx(SFX_ID.deflect); S.fx(FX_DEFLECT, p.x, p.y); }
    return true;
  },
  hash(S, h) {
    const b = S.boss;
    h.u32(b.phase); h.u32(b.quiet); h.u32(b.at); h.u32(b.enterT); h.u32(b.ringT); h.u32(b.burstT); h.u32(b.wBurst); h.u32(b.guideT);
    h.u32(b.spiral ? 1 : 0); h.u32(b.breath); h.u32(b.bt); h.u32(b.rings); h.u32(b.detachAll ? 1 : 0); h.u32(b.mkDir + 1);
    h.f64(b.scale); h.f64(b.swayA); h.f64(b.bobA); h.f64(b.sa); h.f64(b.aimX); h.f64(b.aimY); h.f64(b.mk); h.f64(b.gapX); h.f64(b.gapPx);
    for (let k = 0; k < NP; k++) {
      h.u32(b.fSt[k]); h.f64(b.fHp[k]); h.u32(b.fT[k]); h.f64(b.fX[k]); h.f64(b.fY[k]); h.f64(b.fVx[k]); h.f64(b.fVy[k]); h.f64(b.fTx[k]);
      h.u32(b.fAimT[k]); h.f64(b.fAimX[k]); h.f64(b.fAimY[k]); h.u32(b.fWait[k]); h.u32(b.fShots[k]); h.f64(b.fCd[k]);
    }
    for (let i = 0; i < b.sVx.length; i++) { h.f64(b.sVx[i]); h.f64(b.sY[i]); }
  },
  hp(S, out) {
    const boss = S.boss;
    // once the core is out the boss is dead: petals still alive at that moment no longer count, so the bar reads 0
    let cur = Math.max(0, boss.core); if (cur > 0) for (let k = 0; k < NP; k++) cur += Math.max(0, boss.fHp[k]);
    out[0] = cur; out[1] = NP * boss.fMax + boss.coreMax;
    return out;
  }
};
