// MOONWELL, the Z2 boss (design.md B.6): a glass bell with six hanging tendrils, three phases. All bullets 1.2 to 1.4.
//   Phase 1 Tendrils (start):           bell at y = 70 drifts in a figure 8; 6 tendrils (chains of 7 dots) swing as
//                                        pendulums. Each tip drops a bubble every 70 frames (rises 20 units over 60
//                                        frames, then falls at 1.2) after its tip fills white for 20 frames.
//                                        Aimed pair (1.4) every 80 frames behind a 20-frame aim-lock glow.
//                                        Tips: 6 hp each, 800 per cut (S.pieceKill). Cut tendrils fall as harmless debris.
//   Phase 2 Tide wall (all tendrils cut): the bell flips and its lens opens. Tide wall (spec below) plus an aimed
//                                        pair (1.4) every 90. Lens: 24 hp, open only for the 60 frames after each wall
//                                        spawns; a closed lens deflects shots (no S.hits).
//   Phase 3 Shatter (lens below 50%):    the bell breaks into 3 shards orbiting the center (radius 50), 10 hp each.
//                                        Each shard fires a ring of 6 (1.2) every 90 frames, staggered by 30, after a
//                                        20-frame shard glow. The last shard alive dives at the player once every 180
//                                        frames, after it flashes and wobbles for 30 frames (render reads dState/dT).
//                                        If a long diagonal dive is not back in orbit when the next 180 comes due,
//                                        the next dive starts as soon as it is back (never sooner than 180).
// Tide wall spec (B.5, B.6): one row of 5-unit slots x = 5 + 5k (k = 0..78) at y = 100, falling at 1.2, minus the
// 8 slots in [gap - 20, gap + 20): 71 bullets. The gap center is picked with the seeded RNG inside x 40..360 and
// within 160 of the previous wall's gap. A 30-frame gap glow (render: boss.wallT, boss.gapX) comes before each wall;
// the next glow starts only once the previous wall passes y = 280, so walls never overlap. Walls always spawn in
// full (never wait, never skip) and count toward the 84 cap; every other volley obeys the volley-wait rule.
// Phase change (B.6, B.9): bullets clear, 8 frames of hit-stop and shake 6, a popup, then 20 quiet frames.
// Entrance: 120 frames, invulnerable. Timeout and the death sequence are sim.js (bossPass, bossOut).
// Boss interface: see sim/registry.js. Reference boss: sim/bosses/eclipse.js.
import { CX, H, TAU, SFX_ID, POP_NUM, POP_PHASE2, POP_CORE, C_ROSE, C_TEAL, FX_CORE, FX_DEFLECT } from '../../defs.js';
import { sin, cos, atan2, hypot } from '../../../../engine/dmath.js';
import { limitBullet, limitDive, heatBullet } from '../difficulty.js';
import { TELE_AIM, VOLLEY_WAIT } from '../feel.js';

// ---------- the B.6 table ----------
export const MOONWELL = {
  enterFrames: 120, quiet: 20,
  bellY: 70, driftX: 90, driftY: 10, bellR: 22,          // figure 8: x = CX + 90 sin(t w), y = 70 + 10 sin(2 t w)
  drift3: 40,                                            // phase 3 center drifts less
  // phase 1
  tendrils: 6, links: 7, link: 6, swing: 0.38, swingW: 0.045, tipHp: 6, tipPts: 800, tipBox: 6,
  bubbleEvery: 70, bubbleStagger: 12, bubbleRise: 60, bubbleRiseBy: 20, bubbleSpd: 1.2,
  aim1Every: 80, aimSpd: 1.4, pairSpread: 0.1,
  // phase 2
  lensHp: 24, lensR: 10, lensOpen: 60, lensPts: 1000, aim2Every: 90, flipFrames: 20,
  wallY: 100, wallSpd: 1.2, wallPass: 280, wallGlow: 30, wallSlots: 79, wallX0: 5, wallStep: 5,
  gapHalf: 20, gapLo: 40, gapHi: 360, gapReach: 160,
  // phase 3
  shards: 3, shardHp: 10, shardPts: 1000, orbitR: 50, orbitSpin: 0.012, shardR: 9,
  ringEvery: 90, ringStagger: 30, ringN: 6, ringSpd: 1.2,
  diveEvery: 180, diveTele: 30, diveSpd: 2.4, returnSpd: 3.6,      // return = the B.5 dive ceiling
  tele: TELE_AIM                                         // 20-frame telegraph before bubbles, pairs and rings
};
const M = MOONWELL;
const NBUB = 16;

const spd = (S, v) => limitBullet(v * S.D.bulletMul * heatBullet(S.heat));
const muzzleY = boss => boss.y + 16;

// per-boss arrays, allocated once per sim and reused every fight (no per-frame allocation)
function mwState() {
  return {
    th: new Float64Array(6), tf: new Int16Array(6), tx: new Float64Array(6), ty: new Float64Array(6),
    tTele: new Int16Array(6), tWait: new Int16Array(6), cutT: new Int16Array(6), cutX: new Float64Array(6), cutY: new Float64Array(6),
    bubI: new Int16Array(NBUB), bubT: new Int16Array(NBUB),
    sh: new Float64Array(3), sf: new Int16Array(3), sx: new Float64Array(3), sy: new Float64Array(3),
    sTele: new Int16Array(3), sWait: new Int16Array(3)
  };
}

const cutCount = mw => { let n = 0; for (let k = 0; k < M.tendrils; k++) if (mw.th[k] <= 0) n++; return n; };
const shardsLeft = mw => { let n = 0; for (let i = 0; i < M.shards; i++) if (mw.sh[i] > 0) n++; return n; };
// the lens is "below 50%" once lens * 2 < lensMax; lensFloor is the highest such value
const lensFloor = boss => Math.ceil(boss.lensMax / 2) - 1;
function phaseFor(boss) {
  const mw = boss.mw;
  if (cutCount(mw) < M.tendrils) return 1;
  return boss.lens * 2 < boss.lensMax ? 3 : 2;
}

// ---------- body ----------
// tendril k hangs from the bell rim and swings as a pendulum; each link bends a little more than the one above it
export function tendrilTip(boss, k, out) {
  const a = M.swing * sin(boss.t * M.swingW + k * 0.9);
  let x = boss.x + (k - 2.5) * 6.4, y = boss.y + 12;
  for (let i = 1; i <= M.links; i++) { const q = a * (0.35 + 0.65 * i / M.links); x += sin(q) * M.link; y += cos(q) * M.link; }
  out[0] = x; out[1] = y;
}
const TIP = [0, 0];
function placeTips(boss) {
  const mw = boss.mw;
  for (let k = 0; k < M.tendrils; k++) { tendrilTip(boss, k, TIP); mw.tx[k] = TIP[0]; mw.ty[k] = TIP[1]; }
}
function placeShards(boss) {
  const mw = boss.mw;
  for (let i = 0; i < M.shards; i++) {
    if (boss.dState >= 2 && i === boss.dK) { mw.sx[i] = boss.dX; mw.sy[i] = boss.dY; continue; }
    const a = boss.rot + i * TAU / M.shards;
    mw.sx[i] = boss.x + cos(a) * M.orbitR; mw.sy[i] = boss.y + sin(a) * M.orbitR;
  }
}

// ---------- attacks ----------
function firstFree(S) { for (let i = 0; i < S.eb.length; i++) if (!S.eb[i].on) return i; return -1; }
// bubble: spawns rising (20 units over 60 frames), then falls at 1.2; tracked here until it turns
function fireBubble(S, k) {
  const boss = S.boss, mw = boss.mw, i = firstFree(S);
  S.eFire(mw.tx[k], mw.ty[k] + 3, 0, -M.bubbleRiseBy / M.bubbleRise, true);
  if (i < 0 || !S.eb[i].on) return;
  for (let j = 0; j < NBUB; j++) if (mw.bubT[j] === 0) { mw.bubI[j] = i; mw.bubT[j] = M.bubbleRise; return; }
}
function updBubbles(S) {
  const mw = S.boss.mw, fall = spd(S, M.bubbleSpd);
  for (let j = 0; j < NBUB; j++) {
    if (mw.bubT[j] === 0) continue;
    const b = S.eb[mw.bubI[j]];
    if (!b.on || b.vy >= 0) { mw.bubT[j] = 0; continue; }
    if (--mw.bubT[j] === 0) { b.vx = 0; b.vy = fall; }
  }
}
// aimed pair: two bullets either side of the line to the point locked when the glow started
function firePair(S) {
  const boss = S.boss, sp = spd(S, M.aimSpd), my = muzzleY(boss);
  const a0 = atan2(boss.aimY - my, boss.aimX - boss.x);
  for (let s = -1; s <= 1; s += 2) { const a = a0 + s * M.pairSpread; S.eFire(boss.x, my, cos(a) * sp, sin(a) * sp, false); }
}
// shard ring of 6, full circle
function fireRing(S, i) {
  const boss = S.boss, mw = boss.mw, sp = spd(S, M.ringSpd);
  for (let n = 0; n < M.ringN; n++) {
    const a = boss.rot + (n + 0.5) * TAU / M.ringN, c = cos(a), s = sin(a);
    S.eFire(mw.sx[i] + c * 6, mw.sy[i] + s * 6, c * sp, s * sp, true);
  }
}
// tide wall: the gap was picked when its glow started; spawns in full, never waits (B.5 exception)
function spawnWall(S) {
  const boss = S.boss, v = spd(S, M.wallSpd), lo = boss.gapX - M.gapHalf, hi = boss.gapX + M.gapHalf;
  for (let k = 0; k < M.wallSlots; k++) {
    const x = M.wallX0 + M.wallStep * k;
    if (x >= lo && x < hi) continue;
    S.eFire(x, M.wallY, 0, v, false);
  }
  boss.wallOn = true; boss.wallY = M.wallY; boss.wallV = v; boss.walls++; boss.gapPrev = boss.gapX;
  boss.lensT = M.lensOpen;
  S.sfx(SFX_ID.warp);
}
function startWallGlow(S) {
  const boss = S.boss, lo = Math.max(M.gapLo, boss.gapPrev - M.gapReach), hi = Math.min(M.gapHi, boss.gapPrev + M.gapReach);
  boss.gapX = lo + S.rnd() * (hi - lo);
  boss.wallT = M.wallGlow;
}

function startAim(S) { const boss = S.boss, p = S.player; boss.aimT = M.tele; boss.aimX = p.x; boss.aimY = p.y; }
function tryPair(S) { if (S.volleyOk(2)) firePair(S); else S.boss.wAim = VOLLEY_WAIT; }

// drop every telegraph and waiting volley (player down, or a phase change); a wall already falling keeps falling
function dropAttacks(boss) {
  const mw = boss.mw;
  boss.aimT = 0; boss.wAim = 0; boss.wallT = 0;
  for (let k = 0; k < M.tendrils; k++) { mw.tTele[k] = 0; mw.tWait[k] = 0; }
  for (let i = 0; i < M.shards; i++) { mw.sTele[i] = 0; mw.sWait[i] = 0; }
  if (boss.dState === 1) { boss.dState = 0; boss.dT = 0; }
}

function enterPhase(S, n) {
  const boss = S.boss, mw = boss.mw;
  boss.phase = n; boss.fury = n >= 2; boss.at = 0; boss.quiet = M.quiet; boss.phT = 0;
  dropAttacks(boss);
  for (let i = 0; i < S.eb.length; i++) S.eb[i].on = false;
  for (let j = 0; j < NBUB; j++) mw.bubT[j] = 0;
  boss.wallOn = false; boss.lensT = 0;
  if (n <= 2) boss.flip = 0;
  if (n === 3) {
    boss.flip = 1;
    for (let i = 0; i < M.shards; i++) { mw.sh[i] = boss.shMax; mw.sf[i] = 0; }
    boss.dState = 0; boss.dT = 0; boss.dClock = 0; boss.dK = -1;
    placeShards(boss);
  }
  S.feel('phase'); S.sfx(SFX_ID.phase2);
  // B.6: every phase change pops; phase 3 uses the closest shared popup (the bell breaks open)
  if (n >= 2) S.popup(n === 3 ? POP_CORE : POP_PHASE2, boss.x, boss.y - 40, 0, C_ROSE);
}

function attacks(S) {
  const boss = S.boss, mw = boss.mw, at = ++boss.at, T = M.tele;
  // the aimed pair (phases 1 and 2): waiting volley retries, the glow fires when it runs out
  if (boss.wAim > 0) { if (S.volleyOk(2)) { boss.wAim = 0; firePair(S); } else boss.wAim--; }
  if (boss.aimT > 0 && --boss.aimT === 0) tryPair(S);
  if (boss.phase === 1) {
    for (let k = 0; k < M.tendrils; k++) {
      if (mw.th[k] <= 0) continue;
      if (mw.tWait[k] > 0) { if (S.volleyOk(1)) { mw.tWait[k] = 0; fireBubble(S, k); } else mw.tWait[k]--; }
      if (mw.tTele[k] > 0 && --mw.tTele[k] === 0) { if (S.volleyOk(1)) fireBubble(S, k); else mw.tWait[k] = VOLLEY_WAIT; }
      if ((at + k * M.bubbleStagger) % M.bubbleEvery === M.bubbleEvery - T && mw.tTele[k] === 0 && mw.tWait[k] === 0) mw.tTele[k] = T;
    }
    if (at % M.aim1Every === M.aim1Every - T && boss.wAim === 0 && boss.aimT === 0) startAim(S);
  } else if (boss.phase === 2) {
    if (boss.wallT > 0) { if (--boss.wallT === 0) spawnWall(S); }
    else if (!boss.wallOn) startWallGlow(S);
    if (at % M.aim2Every === M.aim2Every - T && boss.wAim === 0 && boss.aimT === 0) startAim(S);
  } else {
    const left = shardsLeft(mw);
    for (let i = 0; i < M.shards; i++) {
      if (mw.sh[i] <= 0) continue;
      const free = !(i === boss.dK && boss.dState !== 0);
      if (mw.sWait[i] > 0) { if (!free) mw.sWait[i] = 0; else if (S.volleyOk(M.ringN)) { mw.sWait[i] = 0; fireRing(S, i); } else mw.sWait[i]--; }
      if (mw.sTele[i] > 0 && --mw.sTele[i] === 0) { if (S.volleyOk(M.ringN)) fireRing(S, i); else mw.sWait[i] = VOLLEY_WAIT; }
      if (free && (at + M.ringEvery - i * M.ringStagger) % M.ringEvery === M.ringEvery - T && mw.sTele[i] === 0 && mw.sWait[i] === 0) mw.sTele[i] = T;
    }
    // the last shard alive dives at the player once every 180 frames, after a 30-frame flash and wobble
    if (left === 1) {
      if (boss.dK < 0 || mw.sh[boss.dK] <= 0) { for (let i = 0; i < M.shards; i++) if (mw.sh[i] > 0) boss.dK = i; boss.dClock = 0; }
      boss.dClock++;
      // the dive keeps its 180-frame beat: a ring still glowing on this shard is called off (it never fires)
      if (boss.dState === 0 && boss.dClock >= M.diveEvery) {
        mw.sTele[boss.dK] = 0; mw.sWait[boss.dK] = 0;
        boss.dState = 1; boss.dT = M.diveTele; boss.dClock = 0; boss.dAimX = S.player.x; boss.dAimY = S.player.y;
      } else if (boss.dState === 1 && --boss.dT === 0) {
        const k = boss.dK, x = mw.sx[k], y = mw.sy[k], d = hypot(boss.dAimX - x, boss.dAimY - y) || 1, v = limitDive(M.diveSpd);
        boss.dState = 2; boss.dX = x; boss.dY = y; boss.dVX = (boss.dAimX - x) / d * v; boss.dVY = (boss.dAimY - y) / d * v;
        S.sfx(SFX_ID.big);
      }
    }
  }
}

// the diving shard flies on, leaves the bottom, comes back in from the top and rejoins its orbit slot
function updDive(S) {
  const boss = S.boss, mw = boss.mw, p = S.player;
  if (boss.dState < 2) return;
  if (boss.dK < 0 || mw.sh[boss.dK] <= 0) { boss.dState = 0; return; }
  const v = limitDive(M.returnSpd);
  if (boss.dState === 2) {
    boss.dX += boss.dVX; boss.dY += boss.dVY;
    if (boss.dY > H + 16 || boss.dX < -20 || boss.dX > 420) { boss.dState = 3; boss.dX = boss.x; boss.dY = -16; }
  } else {
    const a = boss.rot + boss.dK * TAU / M.shards, tx = boss.x + cos(a) * M.orbitR, ty = boss.y + sin(a) * M.orbitR;
    const dx = tx - boss.dX, dy = ty - boss.dY, d = hypot(dx, dy);
    if (d < v + 1) boss.dState = 0; else { boss.dX += dx / d * v; boss.dY += dy / d * v; }
  }
  // body contact (B.9: enemy body vs player, abs(dx) < 7 and abs(dy) < 7)
  if (boss.dState >= 2 && p.alive && p.inv <= 0 && Math.abs(boss.dX - p.x) < 7 && Math.abs(boss.dY - p.y) < 7) S.playerDie();
}

function deflect(S, p) { p.on = false; S.sfx(SFX_ID.deflect); S.fx(FX_DEFLECT, p.x, p.y); return true; }

export const moonwell = {
  id: 'moonwell',
  name: 'MOONWELL',
  setup(S) {
    const boss = S.boss;
    if (!boss.mw) boss.mw = mwState();
    const mw = boss.mw;
    boss.tMax = Math.round(M.tipHp * S.D.bossHp);
    boss.lensMax = boss.lens = Math.round(M.lensHp * S.D.bossHp);
    boss.shMax = Math.round(M.shardHp * S.D.bossHp);
    for (let k = 0; k < M.tendrils; k++) { mw.th[k] = boss.tMax; mw.tf[k] = 0; mw.cutT[k] = -1; }
    for (let i = 0; i < M.shards; i++) { mw.sh[i] = boss.shMax; mw.sf[i] = 0; }
    for (let j = 0; j < NBUB; j++) mw.bubT[j] = 0;
    boss.phase = 1; boss.fury = false; boss.enterT = 0; boss.at = 0; boss.quiet = 0; boss.phT = 0; boss.flip = 0;
    boss.lensT = 0; boss.wallT = 0; boss.wallOn = false; boss.wallY = 0; boss.wallV = 0; boss.walls = 0; boss.gapX = CX; boss.gapPrev = CX;
    boss.dState = 0; boss.dT = 0; boss.dClock = 0; boss.dK = -1; boss.dX = 0; boss.dY = 0; boss.dVX = 0; boss.dVY = 0; boss.dAimX = 0; boss.dAimY = 0;
    boss.scale = 1;
    dropAttacks(boss);
    placeTips(boss);
  },
  update(S) {
    const boss = S.boss, mw = boss.mw, player = S.player;
    if (boss.flash > 0) boss.flash--;
    for (let k = 0; k < M.tendrils; k++) { if (mw.tf[k] > 0) mw.tf[k]--; if (mw.cutT[k] >= 0 && mw.cutT[k] < 200) mw.cutT[k]++; }
    for (let i = 0; i < M.shards; i++) if (mw.sf[i] > 0) mw.sf[i]--;
    if (boss.entering) {
      const u = ++boss.enterT / M.enterFrames, e = 1 - (1 - u) * (1 - u);
      boss.t = 0; boss.x = CX; boss.y = -60 + (M.bellY + 60) * e;
      placeTips(boss);
      if (boss.enterT >= M.enterFrames) boss.entering = false;
      return;
    }
    const want = phaseFor(boss), changed = want > boss.phase;
    if (changed) enterPhase(S, want);
    boss.t++; boss.phT++;
    if (boss.phase >= 2 && boss.flip < 1) boss.flip = Math.min(1, boss.flip + 1 / M.flipFrames);
    const amp = boss.phase === 3 ? M.drift3 : M.driftX, w = 0.009;
    boss.x = CX + sin(boss.t * w) * amp; boss.y = M.bellY + sin(boss.t * w * 2) * M.driftY;
    if (boss.phase === 3) boss.rot += M.orbitSpin;
    placeTips(boss);
    updBubbles(S);
    if (boss.wallOn) { boss.wallY += boss.wallV; if (boss.wallY > M.wallPass) boss.wallOn = false; }
    if (boss.lensT > 0) boss.lensT--;
    updDive(S);
    if (boss.phase === 3) placeShards(boss);
    // the quiet frames count from the frame after the phase change (so they follow its hit-stop in full)
    if (changed) return;
    if (boss.quiet > 0) { boss.quiet--; return; }
    // no attacks while the player is down; glows and waiting volleys are dropped
    if (S.state !== 'play' || !player.alive) { dropAttacks(boss); return; }
    attacks(S);
  },
  // test hook (SF.bossPhase): put the boss at the phase's trigger and run the phase change now (or at the end of
  // the entrance). n = 1 restores the tendrils and the lens; 2 cuts every tendril; 3 also takes the lens below 50%.
  setPhase(S, n) {
    const boss = S.boss, mw = boss.mw, want = n >= 3 ? 3 : n <= 1 ? 1 : 2;
    for (let k = 0; k < M.tendrils; k++) {
      if (want === 1) { mw.th[k] = boss.tMax; mw.cutT[k] = -1; }
      else if (mw.th[k] > 0) { mw.th[k] = 0; mw.cutT[k] = 0; mw.cutX[k] = mw.tx[k]; mw.cutY[k] = mw.ty[k]; }
    }
    boss.lens = want === 3 ? lensFloor(boss) : boss.lensMax;
    if (boss.entering) { if (want === 1) boss.phase = 1; return; }
    if (want !== boss.phase) enterPhase(S, want);
  },
  // hits: tendril tips (phase 1), the lens while open (phase 2), shards (phase 3). The bell deflects everything
  // else that reaches it; a shot heading up the lens column flies on until it reaches the lens (like Eclipse's core).
  shot(S, p) {
    const boss = S.boss, mw = boss.mw;
    const dx = p.x - boss.x, dy = p.y - boss.y, r = hypot(dx, dy);
    if (boss.entering) return r < M.bellR ? deflect(S, p) : false;
    if (boss.phase === 1) {
      for (let k = 0; k < M.tendrils; k++) {
        if (mw.th[k] <= 0 || Math.abs(p.x - mw.tx[k]) >= M.tipBox || Math.abs(p.y - mw.ty[k]) >= M.tipBox) continue;
        p.on = false; S.hits++; mw.th[k]--; mw.tf[k] = 6; S.sfx(SFX_ID.ding);
        if (mw.th[k] <= 0) {
          mw.cutT[k] = 0; mw.cutX[k] = mw.tx[k]; mw.cutY[k] = mw.ty[k];
          const v = S.pieceKill(M.tipPts); S.popup(POP_NUM, p.x, p.y, v, C_TEAL);
          S.fx(FX_CORE, mw.tx[k], mw.ty[k]); S.feel('piece'); S.sfx(SFX_ID.big);
        }
        return true;
      }
      return r < M.bellR ? deflect(S, p) : false;
    }
    if (boss.phase === 2) {
      if (r >= M.bellR) return false;
      const ly = boss.y + 4, ldx = p.x - boss.x, ldy = p.y - ly, inLens = ldx * ldx + ldy * ldy < M.lensR * M.lensR;
      if (Math.abs(ldx) < M.lensR && !inLens && ldy > 0) return false; // on its way up to the lens
      if (!inLens || boss.lensT <= 0) return deflect(S, p);
      p.on = false; S.hits++; boss.flash = 5; S.sfx(SFX_ID.ding); S.fx(FX_CORE, p.x, p.y);
      const was = boss.lens * 2 < boss.lensMax;
      boss.lens--;
      if (!was && boss.lens * 2 < boss.lensMax) { const v = S.pieceKill(M.lensPts); S.popup(POP_NUM, p.x, p.y, v, C_TEAL); S.sfx(SFX_ID.big); }
      return true;
    }
    for (let i = 0; i < M.shards; i++) {
      if (mw.sh[i] <= 0) continue;
      const sx = p.x - mw.sx[i], sy = p.y - mw.sy[i];
      if (sx * sx + sy * sy >= M.shardR * M.shardR) continue;
      p.on = false; S.hits++; mw.sh[i]--; mw.sf[i] = 6; S.sfx(SFX_ID.ding);
      if (mw.sh[i] <= 0) {
        mw.sTele[i] = 0; mw.sWait[i] = 0;
        if (i === boss.dK) { boss.dState = 0; boss.dT = 0; }
        const v = S.pieceKill(M.shardPts); S.popup(POP_NUM, p.x, p.y, v, C_TEAL);
        S.fx(FX_CORE, mw.sx[i], mw.sy[i]); S.feel('piece'); S.sfx(SFX_ID.big);
        if (shardsLeft(mw) === 0) S.bossDefeated();
      }
      return true;
    }
    return false;
  },
  // the boss's own state for stateHash (sim.js mixes the shared boss fields itself)
  hash(S, h) {
    const b = S.boss, mw = b.mw;
    h.u32(b.phase); h.u32(b.quiet); h.u32(b.at); h.u32(b.enterT); h.u32(b.phT); h.f64(b.flip);
    h.u32(b.lens); h.u32(b.lensT); h.u32(b.wallT); h.u32(b.wallOn ? 1 : 0); h.f64(b.wallY); h.f64(b.wallV); h.u32(b.walls);
    h.f64(b.gapX); h.f64(b.gapPrev); h.f64(b.aimX); h.f64(b.aimY);
    h.u32(b.dState); h.u32(b.dT); h.u32(b.dClock); h.u32(b.dK + 1); h.f64(b.dX); h.f64(b.dY); h.f64(b.dVX); h.f64(b.dVY); h.f64(b.dAimX); h.f64(b.dAimY);
    for (let k = 0; k < M.tendrils; k++) { h.f64(mw.th[k]); h.u32(mw.tTele[k]); h.u32(mw.tWait[k]); }
    for (let i = 0; i < M.shards; i++) { h.f64(mw.sh[i]); h.u32(mw.sTele[i]); h.u32(mw.sWait[i]); }
    for (let j = 0; j < NBUB; j++) { h.u32(mw.bubT[j]); h.u32(mw.bubI[j]); }
  },
  // HUD bar: [current hp, max hp]; the lens counts only down to its break point
  hp(S, out) {
    const boss = S.boss, mw = boss.mw, fl = lensFloor(boss);
    let cur = Math.max(0, boss.lens - fl);
    for (let k = 0; k < M.tendrils; k++) cur += Math.max(0, mw.th[k]);
    for (let i = 0; i < M.shards; i++) cur += boss.phase === 3 ? Math.max(0, mw.sh[i]) : boss.shMax;
    out[0] = cur; out[1] = M.tendrils * boss.tMax + (boss.lensMax - fl) + M.shards * boss.shMax;
    return out;
  }
};
