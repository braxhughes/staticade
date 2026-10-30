// Starfall simulation: all gameplay state and rules, and nothing else.
// Pure: no DOM, WebGL, audio, wall clock or unseeded randomness; trig comes from engine/dmath.js.
// The same seed, mode and input words give the same game in any browser and in Node.
// Presentation (sound, shake, hit-stop, popups, particles) leaves as events in a preallocated ring.
//
// All state lives on one context object `S`. Modules under sim/ (systems, bosses, formation, STARLIGHT)
// receive S and use its fields and helpers, so a slice can add a file without editing this one.
import { Rng } from '../../engine/rng.js';
import { sin, cos, atan2, hypot } from '../../engine/dmath.js';
import { W_PAYLOAD, W_FIRE, W_FIRE_PRESS, W_ALT_PRESS, W_TOUCH, MOVE_ZERO, MOVE_SCALE } from '../../engine/input-word.js';
import {
  GAME_ID, GAME_VERSION, W, H, CX, PI, TAU, TI_PLAYER, ROWS, GROUPS, CP_TOP, CP_SIDE, CP_TOP_LOOP, CP_SIDE_LOOP,
  BONUS_TYPES, METER_MAX, WING_MAX, WING_LIFE, WING_DRAIN, WING_LOSS, STATES,
  EV_SFX, EV_SHAKE, EV_HITSTOP, EV_STATE, EV_POPUP, EV_EXPLODE, EV_FX, EV_PULSE, SFX_ID,
  POP_NUM, POP_1UP, POP_KINDLE_READY, POP_LANTERN, POP_KINDLED, POP_CLEAR, POP_DEEPSKY, POP_PHASE2, POP_CORE, POP_PASSES, BOSS_NAMES,
  C_WHITE, C_AMBER, C_ROSE, C_TEAL, C_GOLD, PC_HURT, PC_KINDLE, PC_PLAYER,
  FX_SPLIT, FX_DEATH, FX_KINDLE, FX_SPARK, FX_COMET_TRAIL, FX_COMET_HIT, FX_BOSS_DOTS, FX_CORE, FX_DEFLECT
} from './defs.js';
import { createPath, angDiff, clamp } from './sim-path.js';
import { STAGE_TABLE, rowOf, loopOf } from './sim/stages.js';
import { createDifficulty, fillDifficulty, limitBullet, limitDive, limitGap, heatBullet, heatGap, BOSS_TIMEOUT } from './sim/difficulty.js';
import { enemyTypes, enemyTypeId, bosses, bossId, TYPE_IDS, powerups } from './sim/registry.js';
import { systems } from './sim/systems.js';
import { setupFormation, updFormation, slot as formSlot, startDive as formDive, pickDiver as formPick } from './sim/formation.js';
import { starlight } from './sim/starlight.js';
import { isClose } from './sim/score.js';
import { feel, HITSTOP_CAP, BIG_KILLS, TELE_DIVE, TELE_WARDEN, TELE_AIM, VOLLEY_WAIT } from './sim/feel.js';

export { GAME_ID, GAME_VERSION };
// sim/save-state format; no consumer yet. 2 = the v2 sim (stage table, hit-stop in the sim).
export const SIM_FORMAT = 2;
export { TYPE_IDS };

// mode: 'arcade' or 'daily' start at stage 1; 'stageN' starts at stage N (practice / test runs).
// A '+dev' suffix marks a run changed by a test hook; it plays the same but will not re-simulate.
export function startStageOf(mode) {
  const m = /^stage([0-9]{1,3})$/.exec(String(mode).split('+')[0]);
  return m ? Math.max(1, +m[1]) : 1;
}

const SX_SFX = SFX_ID;
const ENEMY_POOL = 128, NPS = 24, NEB = 220, EVN = 4096, EVS = 10;
// extra lives at 40,000 and 150,000, then every 250,000; at most 6 ships in stock
const LIFE_FIRST = 40000, LIFE_SECOND = 150000, LIFE_STEP = 250000, MAX_LIVES = 6;
// C2-0 seam: the lead-aim hook S.lead(S, e) runs inside startAim; the aim system (sim/aim.js) replaces this default
function noLead() {}

// infiniteLives: test-only (tools/sim-bot.mjs); main.js never passes it. The run is tainted from frame 0 (sim/heat.js).
export function createSim({ seed = 0, mode = 'arcade', infiniteLives = false } = {}) {
  seed = seed >>> 0;
  const rng = new Rng(seed);
  const rnd = () => rng.next();

  // ---------- events (presentation) ----------
  const ev = new Float64Array(EVN * EVS);
  let evHead = 0, evCount = 0;
  function push(type, a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0, i = 0) {
    if (evCount >= EVN) return; // presentation only: dropping is safe
    const o = ((evHead + evCount) % EVN) * EVS; evCount++;
    ev[o] = type; ev[o + 1] = a; ev[o + 2] = b; ev[o + 3] = c; ev[o + 4] = d; ev[o + 5] = e; ev[o + 6] = f; ev[o + 7] = g; ev[o + 8] = h; ev[o + 9] = i;
  }
  const sfx = (id, arg = 0) => push(EV_SFX, id, arg);
  const popup = (kind, x, y, v, c) => push(EV_POPUP, kind, x, y, v, c);
  const shake = (v, set) => push(EV_SHAKE, v, set ? 1 : 0);
  // hit-stop is sim state (B.9): it stacks up to HITSTOP_CAP and freezes every gameplay timer; STARLIGHT has none
  function addHitstop(n) {
    if (S.stageKind === 'bonus' || n <= 0) return;
    S.hitstop = Math.min(HITSTOP_CAP, S.hitstop + n);
    push(EV_HITSTOP, n);
  }
  const explode = (ti, variant, pc, x, y, ang, vx, vy, power) => push(EV_EXPLODE, ti, variant, pc, x, y, ang, vx, vy, power);
  const fx = (kind, a = 0, b = 0, c = 0, d = 0, e = 0, f = 0) => push(EV_FX, kind, a, b, c, d, e, f);

  // ---------- state ----------
  const player = { x: CX, y: H - 26, px: CX, py: H - 26, vx: 0, tilt: 0, alive: true, recoil: 0, inv: 0 };
  const wingPool = [mkWing(), mkWing()], wing = [];
  function mkWing() { return { ti: 0, T: null, x: 0, y: 0, px: 0, py: 0, side: 0, ang: 0, life: WING_LIFE }; }
  // B.10: a wingman whose 600 frames run out peels off the top of the screen (no points, no lantern loss); presentation-only pool
  const peelers = [mkPeel(), mkPeel()];
  function mkPeel() { return { on: false, ti: 0, x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, ang: 0 }; }

  const pool = [], free = [], enemies = [];
  for (let i = 0; i < ENEMY_POOL; i++) { const e = blankEnemy(); pool.push(e); free.push(e); }
  function blankEnemy() {
    return { type: '', ti: 0, T: null, r: 0, c: 0, x: 0, y: 0, px: 0, py: 0, ang: 0, st: 'wait', delay: 0, path: null, dpath: createPath(),
      dist: 0, idx: 0, spd: 0, hp: 0, flash: 0, fireCd: 0, shots: 0, phase: 0, dead: false, noReturn: false, bonus: false,
      asm: 1, vx: 0, vy: 0, hurt: false, fast: false, group: -1, leader: false,
      tele: 0, teleSide: 0, teleOff: 0, aimT: 0, aimX: 0, aimY: 0, vWait: 0,
      hunt: 0, pin: 0, aimV: 1.2 }; // C2-0 seams (B.11 2.2 Hunt, 1.1 Pincer, 2.1 aimed-shot sideways limit); hashed by the twist system
  }
  const cand = new Array(ENEMY_POOL).fill(null);

  // player shots; vx, vy, pierce (extra enemies it may hit), vol (volley id), pw (power id) and the last two
  // enemies hit are the power-up seam (S4); a plain shot flies straight up at 6.5 and stops on its first hit
  const ps = []; for (let i = 0; i < NPS; i++) ps.push({ on: false, x: 0, y: 0, px: 0, py: 0, vx: 0, vy: -6.5, pierce: 0, vol: 0, pw: '', hit: false, l1: null, l2: null });
  let volSeq = 0;
  const eb = []; for (let i = 0; i < NEB; i++) eb.push({ on: false, x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, big: false, g: 0, th: 0 }); // g: graze state (sim/score.js); th: Thermals factor (B.11 1.5)
  const comet = { on: false, x: 0, y: 0, px: 0, py: 0, vx: 0 };
  const boss = { on: false, id: 'eclipse', name: 'ECLIPSE', x: CX, y: -60, px: 120, py: -60, t: 0, rot: 0, core: 0, coreMax: 0,
    ph: new Float32Array(8), pf: new Float32Array(8), phMax: 3, flash: 0, entering: true, fury: false, fight: 0,
    aimT: 0, aimX: 0, aimY: 0, wRing: 0, wSpiral: 0, wAim: 0 };

  // per-stage entry paths and their parameters (SF.entry())
  const entryPaths = []; for (let i = 0; i < 10; i++) entryPaths.push(createPath());
  const entryInfo = GROUPS.map(G => ({ path: G.path, mir: false, loop: 0, spd: 0, a: null, b: null }));

  // gameplay events for systems (one reused object, no per-event allocation)
  const GE = { type: '', enemy: null, x: 0, y: 0, v: 0 };

  const S = {
    seed, mode, rng, rnd,
    state: 'intro', stateT: 0, frame: 0, stage: startStageOf(mode), row: 1, zone: 1, loop: 0, stageKind: 'normal', stageT: 0,
    score: 0, lives: 3, nextLife: LIFE_FIRST, mult: 1, meter: 0, heat: 0, god: false, done: false, tainted: !!infiniteLives, deaths: 0,
    infiniteLives: !!infiniteLives,
    shotsFired: 0, hits: 0, warp: 0, formT: 0, formFull: false, diveTimer: 0, hitstop: 0, bossDown: false,
    bonusHits: 0, bonusTotal: 0, cometTime: -1, fireHold: 0,
    // decoded input for this frame
    inMove: 0, inFire: false, inFirePressed: false, inKin: false, inTouch: false, inTouchX: 0,
    player, wing, wingPool, enemies, ps, eb, comet, boss, entryPaths, entryInfo, cand,
    D: createDifficulty(),
    SX: 0, SY: 0, // slot() output
    diveCp: new Float64Array(18),
    // helpers (filled below)
    push, sfx, popup, shake, explode, fx, addHitstop, feel: id => feel(S, id),
    mkEnemy, clearEnemies, addScore, kill, playerDie, setState, emit, takeBullet, eFire, eFireAimed, follow, bossDefeated, shot,
    startAim, fireAim, lead: noLead, // C2-0: aim-lock entry points and the lead hook (B.11 2.1)
    startDive: null, slot: null, diveSpd, bulletSpd, diveGap, maxDivers, panelsBroken, liveBullets, volleyOk, telegraphs,
    addKill: null, addBonus: null // score system (sim/score.js)
  };

  S.startDive = (e, side, offx) => formDive(S, e, side, offx);
  S.slot = (r, c) => formSlot(S, r, c);
  let bossDef = null; // the active boss module (sim/registry.js)
  const hpBuf = [0, 0];

  function emit(type, enemy = null, x = 0, y = 0, v = 0) {
    GE.type = type; GE.enemy = enemy; GE.x = x; GE.y = y; GE.v = v;
    for (let i = 0; i < systems.length; i++) systems[i].onEvent(S, GE);
    GE.enemy = null;
  }

  // ---------- enemies ----------
  function mkEnemy(type, r, c) {
    const e = free.pop();
    if (!e) return null;
    const id = enemyTypeId(type), T = enemyTypes[id];
    e.type = id; e.ti = T.ti; e.T = T; e.r = r; e.c = c; e.x = e.px = e.y = e.py = -99; e.ang = PI; e.st = 'wait'; e.delay = 0; e.path = null;
    e.dist = 0; e.idx = 0; e.spd = 2.6; e.hp = T.hp; e.flash = 0; e.fireCd = 0; e.shots = 0; e.phase = rnd() * 40 | 0;
    e.dead = false; e.noReturn = false; e.bonus = false; e.asm = 1; e.vx = 0; e.vy = 0; e.hurt = false; e.fast = false;
    e.group = -1; e.leader = false; e.tele = 0; e.teleSide = 0; e.teleOff = 0; e.aimT = 0; e.aimX = 0; e.aimY = 0; e.vWait = 0;
    e.hunt = 0; e.pin = 0; e.aimV = 1.2;
    if (T.init) T.init(S, e); // enemy type hooks (init, move, shot, aim, onKill): see sim/registry.js
    return e;
  }
  function clearEnemies() { for (let i = 0; i < enemies.length; i++) free.push(enemies[i]); enemies.length = 0; }
  function panelsBroken() { let n = 0; for (let k = 0; k < 8; k++) if (boss.ph[k] <= 0) n++; return n; }
  function liveBullets() { let n = 0; for (let i = 0; i < NEB; i++) if (eb[i].on) n++; return n; }
  // volley-wait rule (B.5): a volley of n bullets may spawn only if it keeps the on-screen count within the cap
  function volleyOk(n) { return liveBullets() + n <= S.D.cap; }
  // active telegraphs: dive glows, aim-lock glows (enemies and boss)
  function telegraphs() {
    let n = 0;
    for (const e of enemies) if (!e.dead && (e.st === 'tele' || e.aimT > 0)) n++;
    if (boss.on && boss.aimT > 0) n++;
    return n;
  }

  // difficulty (sim/difficulty.js); global limits are applied last, here
  function diveSpd() { return limitDive(S.D.dive * (1 + 0.1 * (S.mult - 1))); }
  function bulletSpd() { return limitBullet(S.D.bullet * heatBullet(S.heat)); }
  function diveGap(n) { const low = n <= 8; return limitGap((low ? S.D.gapLow : S.D.gapFull) + rnd() * 40 - heatGap(S.heat), low); }
  function maxDivers(n) { return n <= 8 ? S.D.maxLow : S.D.maxFull; }

  function setupStage() {
    clearEnemies();
    const R = STAGE_TABLE[rowOf(S.stage)];
    S.row = rowOf(S.stage); S.loop = loopOf(S.stage); S.zone = R.zone; S.stageKind = R.kind;
    fillDifficulty(S.D, S.stage);
    S.formFull = false; S.formT = 0; S.diveTimer = 90; S.stageT = 0;
    comet.on = false; S.cometTime = S.stageKind === 'normal' && S.row >= 2 && S.row <= 13 && rnd() < 0.7 ? 500 + (rnd() * 700 | 0) : -1;
    for (const p of ps) p.on = false;
    for (const b of eb) b.on = false;
    boss.on = false; boss.fury = false; S.bossDown = false;
    if (S.stageKind === 'normal') setupFormation(S);
    else if (S.stageKind === 'bonus') starlight.setup(S);
    else setupBoss(R.boss);
    emit('stage');
  }
  function setupBoss(want) {
    const B = bosses[bossId(want)];
    boss.id = B.id; boss.name = B.name;
    bossDef = B;
    boss.on = true; boss.entering = true; boss.x = boss.px = CX; boss.y = boss.py = -60; boss.t = 0; boss.rot = 0; boss.flash = 0; boss.fight = 0;
    boss.aimT = 0; boss.wRing = 0; boss.wSpiral = 0; boss.wAim = 0; boss.phase = 0; // the boss's setup sets its own phase
    B.setup(S);
  }
  function setState(s) { S.state = s; S.stateT = 0; push(EV_STATE, STATES.indexOf(s)); }

  function addScore(v) {
    S.score += v;
    while (S.score >= S.nextLife) {
      S.nextLife = S.nextLife === LIFE_FIRST ? LIFE_SECOND : S.nextLife + LIFE_STEP;
      if (S.lives < MAX_LIVES) { S.lives++; sfx(SX_SFX.life); popup(POP_1UP, player.x, player.y - 24, 0, C_TEAL); }
    }
  }

  // ---------- movement ----------
  function follow(e) {
    const p = e.path, L = p.L;
    e.dist += e.spd * p.K[e.idx];
    if (e.dist >= p.len) return false;
    while (e.idx < p.m - 2 && L[e.idx + 1] < e.dist) e.idx++;
    const i = e.idx, seg = (L[i + 1] - L[i]) || 1, f = (e.dist - L[i]) / seg;
    const x0 = p.p[i * 2], y0 = p.p[i * 2 + 1], x1 = p.p[i * 2 + 2], y1 = p.p[i * 2 + 3];
    e.x = x0 + (x1 - x0) * f; e.y = y0 + (y1 - y0) * f;
    e.ang += angDiff(e.ang, atan2(x1 - x0, -(y1 - y0))) * 0.3;
    return true;
  }
  function takeBullet() { for (let i = 0; i < NEB; i++) if (!eb[i].on) { eb[i].g = 0; eb[i].th = 0; return eb[i]; } return null; }
  // aimed shot at a target point (the aim locked when the glow started); lim = the sideways speed limit
  // (an enemy's own shot passes e.aimV, B.11 2.1; every other caller keeps the v1 1.2)
  function eFireAimed(x, y, tx, ty, lim = 1.2) {
    const b = takeBullet(); if (!b) return;
    b.on = true; b.x = b.px = x; b.y = b.py = y; b.big = false;
    const sp = bulletSpd(); b.vy = sp; b.vx = clamp((tx - x) / Math.max(20, (ty - y) / sp), -lim, lim);
    // on a boss stage the boss's summons shoot inside the boss band (B.6: D.bossLo..D.bossHi; vy >= 1.0 keeps the floor)
    if (S.stageKind === 'boss' && S.D.bossHi) { const m = hypot(b.vx, b.vy); if (m > S.D.bossHi) { b.vx *= S.D.bossHi / m; b.vy *= S.D.bossHi / m; } }
  }
  // start an enemy's aim-lock glow; the shot fires TELE_AIM frames later at where the player is now.
  // Order (B.11 2.1): sideways limit back to 1.2, then the lead hook (may move the aim point and raise aimV),
  // then the type's own aim hook; a type hook that retargets wins, and the limit goes back to 1.2.
  function startAim(e) {
    e.aimT = TELE_AIM; e.aimX = player.x; e.aimY = player.y; e.aimV = 1.2;
    S.lead(S, e);
    if (e.T.aim) { const ax = e.aimX, ay = e.aimY; e.T.aim(S, e); if (e.aimX !== ax || e.aimY !== ay) e.aimV = 1.2; }
  }
  function fireAim(e) { eFireAimed(e.x, e.y + (e.st === 'dive' ? 4 : 0), e.aimX, e.aimY, e.aimV); }
  function eFire(x, y, vx, vy, big) {
    const b = takeBullet(); if (!b) return;
    b.on = true; b.x = b.px = x; b.y = b.py = y; b.big = !!big; b.vx = vx; b.vy = vy;
  }
  function split(e) {
    e.dead = true; sfx(SX_SFX.morph);
    for (let k = -1; k <= 1; k++) {
      const s = mkEnemy('spark', -1, -1); if (!s) break;
      s.st = 'spark'; s.x = s.px = e.x; s.y = s.py = e.y; s.vx = k * 1.25 + e.vx * 0.2; s.vy = 1.7 + Math.abs(k) * 0.3; s.asm = 0; s.ang = e.ang;
      enemies.push(s);
    }
    fx(FX_SPLIT, e.x, e.y);
  }

  // ---------- scoring & damage ----------
  function kill(e, pts = -1) {
    if (e.dead) return;
    e.dead = true;
    const inForm = e.st === 'form' || e.st === 'tele';
    const val = S.addKill(pts >= 0 ? pts : (inForm ? e.T.form : e.T.dive), e);
    if (!inForm || val >= 300) popup(POP_NUM, e.x, e.y - 4, val, e.type === 'warden' ? C_GOLD : C_WHITE);
    explode(e.ti, e.fast ? 1 : 0, (e.hurt ? PC_HURT : 0) + Math.min(S.mult - 1, 3), e.x, e.y, e.ang, e.x - e.px, e.y - e.py, e.type === 'warden' ? 1.4 : 1);
    if (!e.bonus) {
      const was = S.meter; S.meter = Math.min(METER_MAX, S.meter + 1);
      if (was < METER_MAX && S.meter === METER_MAX) { popup(POP_KINDLE_READY, player.x, player.y - 22, 0, C_AMBER); sfx(SX_SFX.kindle); }
    }
    sfx(SX_SFX.pop);
    if (e.type === 'warden') sfx(SX_SFX.big);
    if (e.T.onKill) e.T.onKill(S, e);
    if (e.type === 'warden' && e.st === 'tele') S.feel('interrupt');
    else if (BIG_KILLS[e.type]) S.feel('big');
    else if (isClose(e, player)) S.feel('close');
    emit('kill', e, e.x, e.y, val);
  }
  function playerDie() {
    if (!player.alive || S.god) return;
    player.alive = false; S.deaths++;
    explode(TI_PLAYER, 0, PC_PLAYER, player.x, player.y, player.tilt, 0, 0, 1.8);
    fx(FX_DEATH, player.x, player.y);
    for (const w of wing) explode(w.ti, 0, PC_KINDLE, w.x, w.y, 0, 0, 0, 1.2);
    S.meter = Math.max(0, S.meter - WING_LOSS * wing.length);
    for (const w of wing) w.life = WING_LIFE;
    wing.length = 0; S.mult = 1; S.feel('death'); S.lives--;
    sfx(SX_SFX.die); setState('dying');
    emit('death', null, player.x, player.y);
  }
  function loseWing(k) {
    const w = wing[k];
    explode(w.ti, 0, PC_KINDLE, w.x, w.y, w.ang, 0, 0, 1);
    for (let i = k; i < wing.length - 1; i++) wing[i] = wing[i + 1];
    wing.length--; w.life = WING_LIFE;
    S.meter = Math.max(0, S.meter - WING_LOSS);
    popup(POP_LANTERN, w.x, w.y - 10, WING_LOSS, C_ROSE);
    sfx(SX_SFX.pop); sfx(SX_SFX.wingLost); S.feel('wingLost');
  }
  function peelOff(k) {
    const w = wing[k];
    for (let i = k; i < wing.length - 1; i++) wing[i] = wing[i + 1];
    wing.length--; w.life = WING_LIFE;
    for (let i = 0; i < peelers.length; i++) if (!peelers[i].on) {
      const q = peelers[i];
      q.on = true; q.ti = w.ti; q.x = q.px = w.x; q.y = q.py = w.y; q.ang = w.ang; q.vx = w.side * 0.6; q.vy = -1.2;
      break;
    }
  }
  function updPeel() {
    for (let i = 0; i < peelers.length; i++) {
      const q = peelers[i]; if (!q.on) continue;
      q.px = q.x; q.py = q.y; q.x += q.vx; q.y += q.vy; q.vy -= 0.08;
      if (q.y < -16) q.on = false;
    }
  }
  function doKindle() {
    if (S.meter < METER_MAX || !player.alive) return;
    S.meter = 0; push(EV_PULSE, player.x, player.y);
    sfx(SX_SFX.kindle); shake(2, false);
    let best = null, bd = 140;
    for (const e of enemies) {
      if (e.dead || e.bonus || !(e.st === 'dive' || e.st === 'spark' || e.st === 'path' || e.st === 'join')) continue;
      const d = hypot(e.x - player.x, e.y - player.y);
      if (d < bd) { bd = d; best = e; }
    }
    if (best && wing.length < WING_MAX) {
      best.dead = true;
      S.addKill(best.T.dive, best);
      popup(POP_KINDLED, best.x, best.y - 6, 0, C_AMBER);
      fx(FX_KINDLE, best.ti, best.x, best.y, best.ang, player.x, player.y);
      const side = wing.length && wing[0].side < 0 ? 1 : -1;
      const w = wing.length && wing[0] === wingPool[0] ? wingPool[1] : wingPool[0];
      w.ti = best.ti; w.T = best.T; w.x = w.px = best.x; w.y = w.py = best.y; w.side = side; w.ang = best.ang;
      w.life = WING_LIFE; wing.push(w);
    } else {  // B.10: with a wingman out, X does the bullet clear instead
      let n = 0;
      for (const b of eb) if (b.on && hypot(b.x - player.x, b.y - player.y) < 130) { b.on = false; n++; fx(FX_SPARK, b.x, b.y); }
      if (n) { const v = S.addKill(n * 50, null, false); popup(POP_CLEAR, player.x, player.y - 22, v, C_AMBER); }
    }
  }
  // a boss module calls this when its last piece falls
  function bossDefeated() {
    boss.on = false;
    const v = S.bossBonus();
    popup(POP_NUM, boss.x, boss.y, v, C_GOLD);
    for (let i = 0; i < enemies.length; i++) if (!enemies[i].dead) kill(enemies[i]);
    for (const b of eb) b.on = false;
    S.feel('bossDeath'); sfx(SX_SFX.bossDie);
    emit('bossKill', null, boss.x, boss.y, v);
    // the ship died earlier this frame (or is still respawning): the stage only ends once a live ship is back
    if (player.alive) setState('bossOut'); else S.bossDown = true;
  }
  // boss timeout: after BOSS_TIMEOUT fight frames the boss leaves; no kill bonus
  function bossPass() {
    boss.on = false;
    for (let i = 0; i < enemies.length; i++) enemies[i].dead = true;
    for (const b of eb) b.on = false;
    popup(POP_PASSES, CX, 120, Math.max(0, BOSS_NAMES.indexOf(boss.name)), C_ROSE); sfx(SX_SFX.warp);
    emit('bossTimeout', null, boss.x, boss.y);
    setState('bossOut');
  }

  // ---------- update ----------
  function savePrev() {
    player.px = player.x; player.py = player.y;
    for (const w of wing) { w.px = w.x; w.py = w.y; }
    for (const e of enemies) { e.px = e.x; e.py = e.y; }
    for (let i = 0; i < NPS; i++) { ps[i].px = ps[i].x; ps[i].py = ps[i].y; }
    for (let i = 0; i < NEB; i++) { eb[i].px = eb[i].x; eb[i].py = eb[i].y; }
    boss.px = boss.x; boss.py = boss.y; comet.px = comet.x; comet.py = comet.y;
  }
  function anyDiving() { for (const e of enemies) if (!e.dead && (e.st === 'dive' || e.st === 'spark')) return true; return false; }

  function step(word) {
    if (S.done) return;
    S.frame++;
    S.inTouch = (word & W_TOUCH) !== 0;
    S.inTouchX = word & W_PAYLOAD;
    S.inMove = S.inTouch ? 0 : ((word & W_PAYLOAD) - MOVE_ZERO) / MOVE_SCALE;
    S.inFire = (word & W_FIRE) !== 0; S.inFirePressed = (word & W_FIRE_PRESS) !== 0; S.inKin = (word & W_ALT_PRESS) !== 0;
    savePrev();
    // hit-stop: the frame counts (and its input is recorded) but every gameplay timer stays frozen
    if (S.hitstop > 0) { S.hitstop--; return; }
    updPeel();
    S.stateT++;
    switch (S.state) {
      case 'intro':
        S.warp = Math.max(0, S.warp - 0.02);
        updPlayer(false);
        if (S.stateT > 130) setState(player.alive ? 'play' : S.lives > 0 ? 'ready' : 'gameover');
        break;
      case 'play':
        S.stageT++;
        // a full lantern holds its charge; only a partly filled one burns down
        if (wing.length && S.meter < METER_MAX) S.meter = Math.max(0, S.meter - WING_DRAIN * wing.length);
        updPlayer(true); updWorld(); checkStage();
        break;
      case 'dying':
        updWorld();
        if (S.stateT > 120) {
          if (S.lives <= 0) setState('gameover');
          else if (!anyDiving() || S.stateT > 360) setState('ready');
        }
        break;
      case 'ready':
        updWorld();
        if (S.stateT > 80) { player.alive = true; player.x = player.px = CX; player.inv = 90; setState('play'); }
        break;
      case 'clear':
        S.warp = S.stateT < 100 ? Math.min(1, S.warp + 0.02) : S.warp;
        for (const b of eb) b.on = false;
        updPlayer(false);
        if (S.stateT === 40) sfx(SX_SFX.warp);
        if (S.stateT > 130) { S.stage++; setupStage(); setState('intro'); }
        break;
      case 'bossOut':
        // 60 frames after a boss dies or leaves: no bullets, nothing can hurt the player, no score
        for (const b of eb) b.on = false;
        updPlayer(false);
        if (S.stateT >= 60) setState('clear');
        break;
      case 'bonusEnd':
        updPlayer(false);
        starlight.endStep(S);
        break;
      case 'gameover':
        updWorld();
        if (S.stateT > 200) S.done = true;
        break;
    }
    for (let i = 0; i < systems.length; i++) systems[i].step(S);
  }

  function updPlayer(canFire) {
    if (!player.alive) return;
    let mv = S.inMove;
    if (S.inTouch) mv = clamp((S.inTouchX - player.x) / 6, -1, 1);
    const P = powerups[S.power];
    const target = mv * (P && P.speed || 2.7);
    player.vx += (target - player.vx) * 0.35;
    player.x = clamp(player.x + player.vx, 10, W - 10);
    player.tilt += (player.vx * 0.13 - player.tilt) * 0.25;
    player.recoil *= 0.75;
    if (player.inv > 0) player.inv--;
    for (const w of wing) {
      w.x += (player.x + w.side * 17 - w.x) * 0.2; w.y += (player.y + 2 - w.y) * 0.2;
      w.ang += angDiff(w.ang, player.tilt) * 0.15;
    }
    // B.10: the wingman's clock runs on play frames only (canFire is true only in 'play')
    if (canFire) for (let k = wing.length - 1; k >= 0; k--) if (--wing[k].life <= 0) peelOff(k);
    if (!canFire) return;
    if (S.inFirePressed) S.fireHold = 0;
    if (S.inFirePressed || (S.inFire && ++S.fireHold % (P && P.gap || 10) === 0)) fire();
    if (S.inKin) doKindle();
  }
  function fire() {
    const P = powerups[S.power];
    if (P && P.ready && !P.ready(S)) return;   // a power's own refire rule (LANCE: strict 24 frames, presses too)
    let n = 0; if (P && P.units) n = P.units(S); else for (const p of ps) if (p.on) n++;
    if (n >= 2 * (1 + wing.length)) return;
    if (P && P.fire) P.fire(S, player.x, player.y - 8); else shot(player.x, player.y - 8);
    for (const w of wing) shot(w.x, w.y - 6);
    player.recoil = 2.2; sfx(SX_SFX.fire);
  }
  // spawn one plain shot (a power-up may change its fields); null when the pool is full
  function shot(x, y) {
    for (const p of ps) if (!p.on) {
      p.on = true; p.x = p.px = x; p.y = p.py = y; p.vx = 0; p.vy = -6.5; p.pierce = 0; p.vol = ++volSeq; p.pw = ''; p.hit = false; p.l1 = p.l2 = null;
      S.shotsFired++; return p;
    }
    return null;
  }

  function updWorld() {
    if (S.state === 'play' || S.state === 'dying' || S.state === 'ready') S.formT++;
    for (let i = 0; i < enemies.length; i++) updEnemy(enemies[i]);
    let j = 0;
    for (let i = 0; i < enemies.length; i++) { const e = enemies[i]; if (!e.dead) enemies[j++] = e; else free.push(e); }
    enemies.length = j;
    updFormation(S);
    if (boss.on) {
      bossDef.update(S);
      if (!boss.entering && ++boss.fight >= BOSS_TIMEOUT && S.state === 'play') bossPass();
    }
    // comet
    if (S.state === 'play' && S.cometTime > 0 && S.stageT === S.cometTime && S.stageKind === 'normal') {
      const dir = rnd() < 0.5 ? 1 : -1; comet.on = true; comet.x = comet.px = dir > 0 ? -10 : W + 10; comet.y = comet.py = 24 + rnd() * 10; comet.vx = dir * 1.6;
    }
    if (comet.on) {
      comet.x += comet.vx;
      fx(FX_COMET_TRAIL, comet.x, comet.y, comet.vx);
      if (comet.x < -20 || comet.x > W + 20) comet.on = false;
    }
    // player shots; a hit counts toward accuracy only when a shot connects
    for (const p of ps) {
      if (!p.on) continue;
      p.x += p.vx; p.y += p.vy;
      if (p.y < -8 || p.x < -8 || p.x > W + 8) { p.on = false; continue; }
      if (comet.on && Math.abs(p.x - comet.x) < 7 && Math.abs(p.y - comet.y) < 7) {
        p.on = false; comet.on = false; S.hits++; S.mult = Math.min(4, S.mult + 1);
        S.addBonus(1000 * S.mult); popup(POP_DEEPSKY, comet.x, comet.y + 8, S.mult, C_TEAL);
        S.warp = 0.7; shake(3, true); sfx(SX_SFX.warp);
        fx(FX_COMET_HIT, comet.x, comet.y);
        continue;
      }
      if (boss.on && bossDef.shot(S, p)) continue;
      for (const e of enemies) {
        if (e.dead || e.st === 'wait' || e === p.l1 || e === p.l2) continue;
        const r = e.T.r + 1, ex = e.T.hitX ? e.T.hitX(S, e) : e.x; // hitX: S7 Mirage (only its solid copy is hit)
        if (Math.abs(p.x - ex) < r && Math.abs(p.y - e.y) < r + 3) {
          if (e.T.shot && e.T.shot(S, e, p)) { p.on = false; break; } // deflected (any shot, LANCE included): gone, no hit, no damage
          // accuracy counts a shot once; a piercing shot (LANCE) flies on past this enemy
          if (!p.hit) S.hits++;
          p.hit = true;
          if (p.pierce > 0) { p.pierce--; p.l2 = p.l1; p.l1 = e; } else p.on = false;
          S.hitBy = p.pw;
          if (--e.hp > 0) { e.flash = 6; e.hurt = true; sfx(SX_SFX.ding); }
          else if (e.bonus) starlight.hit(S, e);
          else kill(e);
          S.hitBy = '';
          break;
        }
      }
    }
    if (S.state === 'play' && S.warp > 0) S.warp = Math.max(0, S.warp - 0.012);
    // enemy bullets
    for (const b of eb) {
      if (!b.on) continue;
      b.x += b.vx; b.y += b.vy;
      if (b.y > H + 6 || b.y < -10 || b.x < -10 || b.x > W + 10) { b.on = false; continue; }
      const P = powerups[S.power];
      if (P && P.bullet && player.alive && player.inv <= 0 && P.bullet(S, b)) { b.on = false; continue; }
      if (player.alive && player.inv <= 0 && Math.abs(b.x - player.x) < 3.5 && Math.abs(b.y - player.y) < 4.5) { b.on = false; playerDie(); continue; }
      for (let k = 0; k < wing.length; k++) {
        const w = wing[k];
        if (Math.abs(b.x - w.x) < 4.5 && Math.abs(b.y - w.y) < 5) { b.on = false; loseWing(k); break; }
      }
    }
  }

  function updEnemy(e) {
    if (e.dead) return;
    if (e.flash > 0) e.flash--;
    e.fast = e.st === 'dive' || e.st === 'spark';
    // aim-lock glow (started on an earlier frame) runs out: the shot fires (or waits for room under the bullet cap, then is skipped)
    if (e.aimT > 0 && --e.aimT === 0) {
      if (!player.alive) { /* nothing to aim at */ } else if (volleyOk(1)) fireAim(e); else e.vWait = VOLLEY_WAIT;
    } else if (e.vWait > 0) {
      if (volleyOk(1)) { e.vWait = 0; if (player.alive) fireAim(e); } else e.vWait--;
    }

    if (e.T.move && e.T.move(S, e)) { if (e.dead) return; } else // the type moved e itself this frame
    switch (e.st) {
      case 'wait':
        if (--e.delay <= 0) { e.st = 'path'; e.dist = 0; e.idx = 0; e.x = e.px = e.path.p[0]; e.y = e.py = e.path.p[1]; e.ang = atan2(e.path.p[2] - e.x, -(e.path.p[3] - e.y)); }
        return;
      case 'path':
        if (!follow(e)) { if (e.bonus) { e.dead = true; return; } e.st = 'join'; }
        else if (!e.bonus && e.aimT === 0 && e.vWait === 0 && S.D.pathFire > 0 && player.alive && e.y > 40 && e.y < 200 && rnd() < S.D.pathFire) startAim(e);
        break;
      case 'tele':
        // dive telegraph: glows in its formation slot, then leaves
        formSlot(S, e.r, e.c); e.x = S.SX; e.y = S.SY; e.ang += angDiff(e.ang, PI) * 0.15;
        if (--e.tele <= 0) { e.tele = 0; S.startDive(e, e.teleSide, e.teleOff); }
        break;
      case 'dive':
        if (!follow(e)) {
          if (e.noReturn || e.r < 0) { e.dead = true; return; }
          formSlot(S, e.r, e.c); e.x = e.px = S.SX; e.y = e.py = -16; e.st = 'join'; e.ang = PI;
          break;
        }
        if (e.type === 'splitter' && e.y > H * 0.47) { split(e); return; }
        if (e.aimT === 0 && e.vWait === 0 && e.shots > 0 && player.alive && e.y > H * 0.28 && e.y < H * 0.69 && --e.fireCd <= 0) { startAim(e); e.shots--; e.fireCd = 18 + rnd() * 24; }
        break;
      case 'join': {
        formSlot(S, e.r, e.c);
        const dx = S.SX - e.x, dy = S.SY - e.y, d = hypot(dx, dy), sp = 2.4;
        if (d < sp) { e.x = S.SX; e.y = S.SY; e.st = 'form'; }
        else { e.x += dx / d * sp; e.y += dy / d * sp; e.ang += angDiff(e.ang, atan2(dx, -dy)) * 0.2; }
        break;
      }
      case 'form':
        formSlot(S, e.r, e.c); e.x = S.SX; e.y = S.SY; e.ang += angDiff(e.ang, PI) * 0.15;
        break;
      case 'spark':
        e.x += e.vx; e.y += e.vy; e.vx += clamp((player.x - e.x) * 0.002, -0.03, 0.03);
        e.ang += 0.18; e.asm = Math.min(1, e.asm + (1 - e.asm) * 0.12 + 0.01);
        if (e.y > H + 12 || e.x < -16 || e.x > W + 16) { e.dead = true; return; }
        break;
    }
    if (e.bonus || !(e.st === 'path' || e.st === 'join' || e.st === 'dive' || e.st === 'spark')) return;
    // body collisions (hitX: S7 Mirage, whose ghost copy has no body)
    const bx = e.T.hitX ? e.T.hitX(S, e) : e.x;
    if (player.alive && player.inv <= 0 && Math.abs(bx - player.x) < 7 && Math.abs(e.y - player.y) < 7) {
      const P = powerups[S.power];
      kill(e); if (!(P && P.body && P.body(S, e))) playerDie(); return;
    }
    for (let k = 0; k < wing.length; k++) {
      const w = wing[k];
      if (Math.abs(bx - w.x) < 7 && Math.abs(e.y - w.y) < 7) { kill(e); loseWing(k); return; }
    }
  }

  function checkStage() {
    // a stage never ends while the ship is dead: dying -> ready revives it, then 'play' checks again
    if (!player.alive) return;
    if (S.bossDown) { S.bossDown = false; setState('bossOut'); return; }
    if (S.stageKind === 'normal' && enemies.length === 0) { emit('clear'); setState('clear'); }
    else if (S.stageKind === 'bonus') starlight.check(S);
  }

  // ---------- hash ----------
  // FNV-1a over everything that steers the game, so a divergence shows up on the frame it happens.
  const hv = new DataView(new ArrayBuffer(8));
  let H32 = 0;
  function mixU32(v) { for (let i = 0; i < 4; i++) { H32 ^= (v >>> (i * 8)) & 255; H32 = Math.imul(H32, 0x01000193); } }
  function mixF64(v) { hv.setFloat64(0, v, true); mixU32(hv.getUint32(0, true)); mixU32(hv.getUint32(4, true)); }
  function mixStr(s) { for (let i = 0; i < s.length; i++) mixU32(s.charCodeAt(i)); }
  const HMIX = { u32: mixU32, f64: mixF64 };
  function stateHash() {
    H32 = 0x811c9dc5 | 0;
    mixU32(S.frame); mixU32(S.score); mixU32(S.stage); mixU32(S.lives); mixU32(S.deaths); mixF64(player.x); mixF64(player.vx);
    mixU32(rng.a); mixU32(rng.b); mixU32(rng.c); mixU32(rng.d);
    mixU32(enemies.length); mixU32(S.mult); mixF64(S.meter); mixU32(S.shotsFired); mixU32(S.hits); mixU32(STATES.indexOf(S.state)); mixU32(S.stateT);
    mixU32(S.nextLife); mixU32(S.heat); mixU32(player.alive ? 1 : 0); mixU32(player.inv);
    mixF64(S.warp); mixU32(S.formT); mixU32(S.formFull ? 1 : 0); mixF64(S.diveTimer); mixU32(S.stageT); mixU32(S.bonusHits);
    mixU32(S.hitstop);
    if (S.bossDown) mixU32(0xb055d0e); // only set in the boss-dies-while-the-ship-is-dead case, so older hashes stay valid
    for (const e of enemies) { mixF64(e.x); mixF64(e.y); mixStr(e.st); mixU32(e.hp); mixU32(e.shots); mixF64(e.fireCd); mixU32(e.tele); mixU32(e.aimT); mixU32(e.vWait); }
    for (let i = 0; i < NEB; i++) { const b = eb[i]; if (b.on) { mixU32(i); mixF64(b.x); mixF64(b.y); mixF64(b.vx); mixF64(b.vy); } }
    for (let i = 0; i < NPS; i++) { const p = ps[i]; if (p.on) { mixU32(i); mixF64(p.x); mixF64(p.y); } }
    mixU32(wing.length); for (let i = 0; i < wing.length; i++) { mixF64(wing[i].x); mixF64(wing[i].y); mixU32(wing[i].life); }
    mixU32(boss.on ? 1 : 0); mixU32(boss.core); mixU32(boss.t); mixF64(boss.rot); mixF64(boss.x); mixF64(boss.y); mixU32(boss.fight);
    for (let k = 0; k < 8; k++) mixF64(boss.ph[k]);
    mixU32(boss.aimT); mixU32(boss.wRing); mixU32(boss.wSpiral); mixU32(boss.wAim);
    if (boss.on && bossDef && bossDef.hash) bossDef.hash(S, HMIX); // optional: the boss mixes its own state
    mixU32(comet.on ? 1 : 0); mixF64(comet.x); mixF64(comet.y); mixU32(S.cometTime);
    // a system may mix its own state in (optional hash(S, mixU32, mixF64); S4 power-ups)
    for (let i = 0; i < systems.length; i++) if (systems[i].hash) systems[i].hash(S, mixU32, mixF64);
    return (H32 >>> 0).toString(16).padStart(8, '0');
  }

  // ---------- start ----------
  for (let i = 0; i < systems.length; i++) systems[i].init(S);
  setupStage(); setState('intro'); sfx(SX_SFX.jingle);

  return {
    step, stateHash,
    // drain(fn): fn(buf, offset) per pending event, oldest first; buf[offset] is the EV_* type
    drain(fn) { while (evCount) { fn(ev, evHead * EVS); evHead = (evHead + 1) % EVN; evCount--; } },
    clearEvents() { evHead = 0; evCount = 0; },
    player, wing, peelers, enemies, ps, eb, boss, comet,
    ctx: S,
    get seed() { return seed; }, get mode() { return mode; }, get rng() { return rng; },
    get state() { return S.state; }, get stateT() { return S.stateT; }, get frame() { return S.frame; },
    get stage() { return S.stage; }, get stageKind() { return S.stageKind; }, get stageT() { return S.stageT; },
    get hitstop() { return S.hitstop; }, liveBullets, telegraphs,
    get row() { return S.row; }, get zone() { return S.zone; }, get loop() { return S.loop; }, get heat() { return S.heat; },
    get score() { return S.score; }, get lives() { return S.lives; }, get deaths() { return S.deaths; }, get mult() { return S.mult; },
    get meter() { return S.meter; }, get warp() { return S.warp; }, get formFull() { return S.formFull; },
    get shotsFired() { return S.shotsFired; }, get hits() { return S.hits; },
    get bonusHits() { return S.bonusHits; }, get bonusTotal() { return S.bonusTotal; },
    get done() { return S.done; }, get god() { return S.god; }, get tainted() { return S.tainted; },
    panelsBroken,
    // boss HUD bar: [current hp, max hp] (reused array)
    bossHp() { if (bossDef) bossDef.hp(S, hpBuf); else { hpBuf[0] = 0; hpBuf[1] = 1; } return hpBuf; },
    entry() { return entryInfo.map(v => ({ path: v.path, mir: v.mir, loop: v.loop, spd: v.spd })); },
    // test hooks: each one changes the run outside its inputs, so the replay is marked tainted
    fill() { S.meter = METER_MAX; S.tainted = true; },
    setGod(v) { S.god = !!v; if (S.god) S.tainted = true; },
    // dive(n): n formation enemies start their dive telegraph now; a formation still entering snaps into its slots first
    dive(n) {
      let formed = false; for (const e of enemies) if (e.st === 'form') { formed = true; break; }
      if (!formed) for (const e of enemies) if (!e.dead && e.r >= 0 && (e.st === 'wait' || e.st === 'path' || e.st === 'join')) {
        formSlot(S, e.r, e.c); e.x = e.px = S.SX; e.y = e.py = S.SY; e.st = 'form'; e.ang = PI;
      }
      for (let i = 0; i < (n || 1); i++) formPick(S);
      S.tainted = true;
    },
    comet() { S.cometTime = S.stageT + 2; S.tainted = true; },
    breakPanels(n) { for (let k = 0; k < Math.min(8, n || 5); k++) boss.ph[k] = 0; S.tainted = true; }
  };
}
