// ECLIPSE, the Z1 boss, rebalanced to design.md B.6: a ring of 8 panels around a core, three phases.
//   Phase 1 Ring   (start):            ring volley of 8 (lower half, 1.1) every 140, aimed 3-way (1.6) every 90,
//                                       2 moths every 420 (B.10). Lead panel glows 20 frames before each ring.
//   Phase 2 Spiral (4 panels broken):  2-arm spiral, one bullet per arm every 16 frames (1.1), after 30 frames
//                                       of guide lines; aimed 3-way (1.6) every 120. No summons.
//   Phase 3 Core   (6 panels broken):  ring shrinks to 70%, sway 60; aimed 5-way fan (1.3) every 75 behind a
//                                       white core glow; slow ring of 8 (1.0) every 200 behind a ring source glow.
// Every aimed volley has a 20-frame aim-lock glow; the target point (the player's position) is locked when the
// glow starts, and the volley flies from the muzzle at that point (B.9: where the player was 20 frames earlier).
// Phase change: bullets clear, 8 frames of hit-stop and shake 6 (feel 'phase'), a popup, then 20 quiet frames.
// Entrance: 120 frames, invulnerable. Timeout and the death sequence are sim.js (bossPass, bossOut).
// Every volley obeys the bullet cap (B.5 volley-wait rule): it spawns in full or waits up to VOLLEY_WAIT frames.
// Boss interface: see sim/registry.js.
import { CX, PI, TAU, SFX_ID, POP_NUM, POP_PHASE2, POP_CORE, C_ROSE, C_TEAL, FX_BOSS_DOTS, FX_CORE, FX_DEFLECT } from '../../defs.js';
import { sin, cos, atan2, hypot } from '../../../../engine/dmath.js';
import { limitBullet, heatBullet } from '../difficulty.js';
import { TELE_AIM, VOLLEY_WAIT } from '../feel.js';

// ---------- the B.6 table ----------
export const ECLIPSE = {
  enterFrames: 120, panelHp: 3, coreHp: 16, panelPts: 1000,
  phase2At: 4, phase3At: 6,             // panels broken
  quiet: 20,                            // frames with no new attacks after a phase change (after its hit-stop)
  spin: 0.006, spinPerPanel: 0.002, spin2: 0.014,
  sway: 120, sway3: 60, scale3: 0.7,
  ringR: 41, ringIn: 28, coreR: 13,     // hit radii at scale 1 (v1)
  // phase 1
  ring1Every: 140, ring1N: 8, ring1Spd: 1.1, aim1Every: 90, aimSpd: 1.6, summonEvery: 420,
  // phase 2
  guide: 30, spiralEvery: 16, spiralSpd: 1.1, spiralTurn: 0.023, aim2Every: 120,
  // phase 3
  fanEvery: 75, fanN: 5, fanSpd: 1.3, ring3Every: 200, ring3N: 8, ring3Spd: 1.0,
  tele: TELE_AIM                        // 20-frame telegraph before rings and aimed volleys
};
const E = ECLIPSE;

// boss bullet speed: table value with loop scaling and heat, then the global limits (B.5)
const spd = (S, v) => limitBullet(v * S.D.bulletMul * heatBullet(S.heat));
const phaseFor = broken => broken >= E.phase3At ? 3 : broken >= E.phase2At ? 2 : 1;
const muzzleY = boss => boss.y + 12 * boss.scale;

// ---------- attacks (each spawns in full or not at all) ----------
// phase 1 ring: 8 bullets spread over the lower half only; the pattern turns with the ring
// (f in [0, 1) is how far the ring has turned through one bullet step)
function ring1Frac(boss) { const st = PI / E.ring1N; let o = boss.rot % st; if (o < 0) o += st; return o / st; }
function fireRing1(S) {
  const boss = S.boss, st = PI / E.ring1N, sp = spd(S, E.ring1Spd), f = ring1Frac(boss), r = 30 * boss.scale;
  for (let i = 0; i < E.ring1N; i++) {
    const a = (i + 0.1 + 0.8 * f) * st, ca = cos(a), sa = sin(a); // a in [0.1, 7.9] steps of PI/8: lower half only
    S.eFire(boss.x + ca * r, boss.y + sa * r, ca * sp, sa * sp, true);
  }
}
// phase 3 slow ring of 8, full circle
function fireRing3(S) {
  const boss = S.boss, sp = spd(S, E.ring3Spd), r = 22 * boss.scale;
  for (let i = 0; i < E.ring3N; i++) {
    const a = boss.rot + (i + 0.5) * TAU / E.ring3N, ca = cos(a), sa = sin(a);
    S.eFire(boss.x + ca * r, boss.y + sa * r, ca * sp, sa * sp, true);
  }
}
// phase 2 spiral: one bullet per arm; the arm angle (boss.sa) is driven by the attack clock
function fireSpiral(S) {
  const boss = S.boss, sp = spd(S, E.spiralSpd), r = 14 * boss.scale;
  for (let k = 0; k < 2; k++) { const a = boss.sa + k * PI, ca = cos(a), sa = sin(a); S.eFire(boss.x + ca * r, boss.y + sa * r, ca * sp, sa * sp, true); }
}
// aimed volley (3-way, or the phase 3 fan): the center bullet flies from the muzzle at the point locked when the glow started
function fireAim(S) {
  const boss = S.boss, fan = boss.phase === 3, n = fan ? E.fanN : 3, sp = spd(S, fan ? E.fanSpd : E.aimSpd), step = fan ? 0.2 : 0.22;
  boss.aimA = atan2(boss.aimY - muzzleY(boss), boss.aimX - boss.x);
  for (let i = 0; i < n; i++) { const a = boss.aimA + (i - (n - 1) / 2) * step; S.eFire(boss.x, muzzleY(boss), cos(a) * sp, sin(a) * sp, false); }
}
const aimCount = boss => boss.phase === 3 ? E.fanN : 3;
const ringCount = boss => boss.phase === 3 ? E.ring3N : E.ring1N;
function fireRing(S) { if (S.boss.phase === 3) fireRing3(S); else fireRing1(S); }

// start the aim-lock glow: the target point is locked now, at the player's position
function startAim(S) {
  const boss = S.boss, p = S.player;
  boss.aimT = E.tele; boss.aimX = p.x; boss.aimY = p.y;
}
// start the ring telegraph; in phase 1 the lead panel is the intact panel nearest straight down
function startRing(S) {
  const boss = S.boss;
  boss.ringT = E.tele; boss.lead = -1;
  let best = 99;
  for (let k = 0; k < 8; k++) {
    if (boss.ph[k] <= 0) continue;
    let d = (boss.rot + (k + 0.5) * PI / 4 - PI / 2) % TAU; if (d < 0) d += TAU; if (d > PI) d = TAU - d;
    if (d < best) { best = d; boss.lead = k; }
  }
}
// drop every telegraph and waiting volley (player down, or a phase change)
function dropAttacks(boss) { boss.aimT = 0; boss.ringT = 0; boss.wRing = 0; boss.wSpiral = 0; boss.wAim = 0; boss.guideT = 0; boss.spiral = false; }

// the phase-change rule (B.6, B.9)
function enterPhase(S, n) {
  const boss = S.boss;
  boss.phase = n; boss.fury = n >= 2; boss.at = 0; boss.quiet = E.quiet;
  dropAttacks(boss);
  for (let i = 0; i < S.eb.length; i++) S.eb[i].on = false;
  // summoned moths still in flight hold their fire for good, so the quiet period is really quiet
  for (let i = 0; i < S.enemies.length; i++) { const e = S.enemies[i]; e.shots = 0; e.aimT = 0; e.vWait = 0; }
  if (n === 3) boss.scale = E.scale3;
  S.feel('phase'); S.sfx(SFX_ID.phase2);
  if (n >= 2) S.popup(n === 3 ? POP_CORE : POP_PHASE2, boss.x, boss.y - 50, 0, C_ROSE);
}

function summon(S) {
  const boss = S.boss;
  for (let sd = -1; sd <= 1; sd += 2) {
    const e = S.mkEnemy('moth', -1, -1); if (!e) break;
    e.noReturn = true; e.x = e.px = boss.x + sd * 40; e.y = e.py = boss.y; e.ang = PI;
    S.startDive(e, sd, 0); S.enemies.push(e);
  }
}

// one volley tick: fire now if it fits under the cap, else start waiting (B.5)
function tryRing(S) { if (S.volleyOk(ringCount(S.boss))) fireRing(S); else S.boss.wRing = VOLLEY_WAIT; }
function tryAim(S) { if (S.volleyOk(aimCount(S.boss))) fireAim(S); else S.boss.wAim = VOLLEY_WAIT; }

function attacks(S) {
  const boss = S.boss, at = ++boss.at;
  // waiting volleys retry every frame for up to VOLLEY_WAIT frames; the attack clocks keep running meanwhile
  if (boss.wRing > 0) { if (S.volleyOk(ringCount(boss))) { boss.wRing = 0; fireRing(S); } else boss.wRing--; }
  if (boss.wSpiral > 0) { if (S.volleyOk(2)) { boss.wSpiral = 0; fireSpiral(S); } else boss.wSpiral--; }
  if (boss.wAim > 0) { if (S.volleyOk(aimCount(boss))) { boss.wAim = 0; fireAim(S); } else boss.wAim--; }
  // telegraphs that run out fire their volley
  if (boss.ringT > 0 && --boss.ringT === 0) tryRing(S);
  if (boss.aimT > 0 && --boss.aimT === 0) tryAim(S);
  const T = E.tele;
  if (boss.phase === 1) {
    if (at % E.aim1Every === 25 - T && boss.wAim === 0 && boss.aimT === 0) startAim(S);
    if (at % E.ring1Every === E.ring1Every - T && boss.wRing === 0 && boss.ringT === 0) startRing(S);
    if (at % E.summonEvery === E.summonEvery / 2) summon(S);
  } else if (boss.phase === 2) {
    boss.sa = at * E.spiralTurn;
    // guide lines first, then the spiral runs for the rest of the phase
    if (!boss.spiral) {
      if (boss.guideT === 0) boss.guideT = E.guide;
      else if (--boss.guideT === 0) boss.spiral = true;
    } else if (at % E.spiralEvery === 0 && boss.wSpiral === 0) { if (S.volleyOk(2)) fireSpiral(S); else boss.wSpiral = VOLLEY_WAIT; }
    if (at % E.aim2Every === E.aim2Every - T && boss.wAim === 0 && boss.aimT === 0) startAim(S);
  } else {
    if (at % E.fanEvery === E.fanEvery - T && boss.wAim === 0 && boss.aimT === 0) startAim(S);
    if (at % E.ring3Every === E.ring3Every - 25 - T && boss.wRing === 0 && boss.ringT === 0) startRing(S);
  }
}

export const eclipse = {
  id: 'eclipse',
  name: 'ECLIPSE',
  setup(S) {
    const boss = S.boss;
    boss.phMax = Math.round(E.panelHp * S.D.bossHp);
    for (let k = 0; k < 8; k++) { boss.ph[k] = boss.phMax; boss.pf[k] = 0; }
    boss.coreMax = boss.core = Math.round(E.coreHp * S.D.bossHp);
    boss.phase = 1; boss.fury = false; boss.enterT = 0; boss.at = 0; boss.quiet = 0; boss.scale = 1; boss.swayA = E.sway;
    boss.sa = 0; boss.aimA = PI / 2; boss.lead = -1;
    dropAttacks(boss);
  },
  update(S) {
    const boss = S.boss, player = S.player;
    if (boss.flash > 0) boss.flash--;
    for (let k = 0; k < 8; k++) if (boss.pf[k] > 0) boss.pf[k]--;
    if (boss.entering) {
      // 120 frames sliding in from the top, invulnerable
      const u = ++boss.enterT / E.enterFrames, e = 1 - (1 - u) * (1 - u);
      boss.t = 0; boss.x = CX; boss.y = -60 + 148 * e;
      boss.rot += E.spin;
      if (boss.enterT >= E.enterFrames) boss.entering = false;
      return;
    }
    // phase triggers (panels broken); phases only move forward
    const want = phaseFor(S.panelsBroken()), changed = want > boss.phase;
    if (changed) enterPhase(S, want);
    boss.t++;
    boss.rot += E.spin + S.panelsBroken() * E.spinPerPanel + (boss.phase >= 2 ? E.spin2 : 0);
    boss.swayA += ((boss.phase === 3 ? E.sway3 : E.sway) - boss.swayA) * 0.05;
    boss.x = CX + sin(boss.t * 0.01) * boss.swayA; boss.y = 88 + sin(boss.t * 0.023) * 14;
    // the quiet frames count from the frame after the phase change (so they follow its hit-stop in full)
    if (changed) return;
    if (boss.quiet > 0) { boss.quiet--; return; }
    // no attacks while the player is down; glows and waiting volleys are dropped (the spiral re-shows its guide)
    if (S.state !== 'play' || !player.alive) { dropAttacks(boss); return; }
    attacks(S);
  },
  // test hook (SF.bossPhase): break panels to the phase's trigger and run the phase change now
  // (or at the end of the entrance). n = 1 restores every panel.
  setPhase(S, n) {
    const boss = S.boss, want = n >= 3 ? 3 : n <= 1 ? 1 : 2, broken = want === 3 ? E.phase3At : want === 2 ? E.phase2At : 0;
    for (let k = 0; k < 8; k++) boss.ph[k] = k < broken ? 0 : boss.phMax;
    if (boss.entering) { if (want === 1) boss.phase = 1; return; }
    if (want !== boss.phase) enterPhase(S, want);
    if (want < 3) boss.scale = 1;
  },
  // B.6 core-hit rule: a shot crossing the ring over an intact panel hits that panel; over a broken panel it
  // passes through. Inside the ring, in phase 3, a shot whose path crosses the core circle (radius 13, scaled with
  // the ring, as drawn) flies on until it is inside that circle (or level with the center) and hits the core;
  // any other shot inside the ring deflects off the hull (and in phases 1 and 2 the closed core deflects too).
  shot(S, p) {
    const boss = S.boss, sc = boss.scale;
    const dx = p.x - boss.x, dy = p.y - boss.y, r = hypot(dx, dy);
    if (r > E.ringR * sc) return false;
    if (boss.entering) { p.on = false; S.sfx(SFX_ID.deflect); S.fx(FX_DEFLECT, p.x, p.y); return true; }
    if (r >= E.ringIn * sc) {
      let a = atan2(dy, dx) - boss.rot; a = ((a % TAU) + TAU) % TAU;
      const k = Math.min(7, a / (PI / 4) | 0);
      if (boss.ph[k] <= 0) return false;
      p.on = false; S.hits++;
      boss.ph[k]--; boss.pf[k] = 6; S.sfx(SFX_ID.ding);
      if (boss.ph[k] <= 0) {
        S.fx(FX_BOSS_DOTS, 2 + k, boss.rot, 2.5, boss.x, boss.y);
        const v = S.pieceKill(E.panelPts); S.popup(POP_NUM, p.x, p.y, v, C_TEAL);
        S.feel('piece'); S.sfx(SFX_ID.big);
      }
      return true;
    }
    const cr = E.coreR * sc, core = boss.phase === 3 && dx > -cr && dx < cr;
    if (core && r >= cr && dy > 0) return false; // still on its way in to the core
    p.on = false;
    if (core) {
      S.hits++; boss.flash = 5; boss.core--; S.sfx(SFX_ID.ding);
      S.fx(FX_CORE, p.x, p.y);
      if (boss.core <= 0) {
        S.fx(FX_BOSS_DOTS, 0, -boss.rot * 0.6, 3, boss.x, boss.y);
        S.fx(FX_BOSS_DOTS, 1, 0, 4, boss.x, boss.y);
        S.bossDefeated();
      }
    } else {
      S.sfx(SFX_ID.deflect);
      S.fx(FX_DEFLECT, p.x, p.y);
    }
    return true;
  },
  // the boss's own state for stateHash (sim.js mixes the shared boss fields itself)
  hash(S, h) {
    const b = S.boss;
    h.u32(b.phase); h.u32(b.quiet); h.u32(b.at); h.u32(b.ringT); h.u32(b.guideT); h.u32(b.spiral ? 1 : 0); h.u32(b.enterT); h.u32(b.lead + 1);
    h.f64(b.scale); h.f64(b.swayA); h.f64(b.sa); h.f64(b.aimX); h.f64(b.aimY);
  },
  // HUD bar: [current hp, max hp]
  hp(S, out) {
    const boss = S.boss;
    let cur = boss.core; for (let k = 0; k < 8; k++) cur += Math.max(0, boss.ph[k]);
    out[0] = cur; out[1] = 8 * boss.phMax + boss.coreMax;
    return out;
  }
};
