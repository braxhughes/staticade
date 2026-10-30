// B.10 balance (w7-balance): 900-frame power-up timer and its bar, one wingman with a 600-frame life,
// ECLIPSE at the lower density and the 26-bullet cap, and the 2.1 game version.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { bosses } from '../games/starfall/sim/registry.js';
import { installHooks } from '../games/starfall/hooks.js';
import { ECLIPSE } from '../games/starfall/sim/bosses/eclipse.js';
import { dropGlyph, POWER_FRAMES } from '../games/starfall/sim/powerups.js';
import { powerupsLayer, BAR_DOTS, BAR_BLINK } from '../games/starfall/render/powerups.js';
import { GAME_VERSION, EV_POPUP, EV_SFX, POP_FADED, SFX_ID, WING_MAX, WING_LIFE, WING_BLINK, H } from '../games/starfall/defs.js';
import { packWord } from '../engine/input-word.js';

const IDLE = 128, KIN = IDLE | (1 << 11);
const step = (sim, n = 1, w = IDLE) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(w); sim.clearEvents(); } return sim; };
const toPlay = sim => { while (sim.state !== 'play') step(sim); return sim; };
function bare(seed = 1, mode = 'stage2') {
  const sim = toPlay(createSim({ seed, mode })), S = sim.ctx;
  S.clearEnemies();
  const k = S.mkEnemy('moth', -1, -1); k.st = 'wait'; k.delay = 1e9; S.enemies.push(k);
  return { sim, S };
}
function diver(S, x, y) {
  const e = S.mkEnemy('moth', -1, -1); e.st = 'dive'; e.x = e.px = x; e.y = e.py = y; e.noReturn = true;
  e.path = { L: [0, 1e9], K: [0], len: 1e9, m: 2, p: [x, y, x, y] }; e.spd = 0; S.enemies.push(e); return e;
}
function kindle(sim, S) {   // fill the lantern and press X for one frame
  S.meter = 10; sim.step(KIN); sim.clearEvents();
}

test('version is 2.4', () => { assert.equal(GAME_VERSION, '2.5'); });

// ---------- power-up timer ----------
test('timer: starts at 900 and counts only on play frames with the ship alive', () => {
  assert.equal(POWER_FRAMES, 900);
  // intro frames do not count
  const intro = createSim({ seed: 1, mode: 'stage2' }), I = intro.ctx;
  assert.equal(intro.state, 'intro');
  I.setPower('fan'); assert.equal(I.powerT, 900);
  step(intro, 20); assert.equal(I.powerT, 900, 'frozen in the stage intro');
  const { sim, S } = bare();
  S.setPower('lance'); assert.equal(S.powerT, 900);
  step(sim, 10); assert.equal(S.powerT, 890);
  // hit-stop freezes it
  S.addHitstop(6); const t0 = S.powerT; step(sim, 6); assert.equal(S.powerT, t0, 'frozen by hit-stop');
  step(sim, 1); assert.equal(S.powerT, t0 - 1);
  // stage clear freezes it
  S.setState('clear'); const t1 = S.powerT; step(sim, 5); assert.equal(S.powerT, t1, 'frozen in stage clear');
  // a dead ship does not burn it either
  S.setState('play'); sim.player.alive = false; S.setState('dying'); const t2 = S.powerT; step(sim, 5);
  assert.equal(S.powerT, t2, 'frozen while the ship is down');
});

test('timer: any catch (even the same type) restarts it at 900', () => {
  const { sim, S } = bare();
  S.setPower('fan'); step(sim, 300); assert.equal(S.powerT, 600);
  dropGlyph(S, sim.player.x, sim.player.y, 0);   // starts as FAN: the same type
  step(sim, 1);
  assert.equal(S.glyph.on, false, 'caught');
  assert.equal(S.power, 'fan'); assert.equal(S.powerT, 900);
  step(sim, 50); dropGlyph(S, sim.player.x, sim.player.y, 1);
  step(sim, 1); assert.equal(S.power, 'lance'); assert.equal(S.powerT, 900);
});

test('timer: at 0 the power ends with a powerdown event and a FADED popup', () => {
  const { sim, S } = bare();
  S.setPower('echo'); S.powerT = 3;
  const seen = { faded: 0, down: 0 }, ge = [];
  const orig = S.emit; S.emit = (type, ...a) => { ge.push(type); return orig(type, ...a); };
  for (let i = 0; i < 3; i++) {
    sim.step(IDLE);
    sim.drain((b, o) => {
      if (b[o] === EV_POPUP && b[o + 1] === POP_FADED) seen.faded++;
      if (b[o] === EV_SFX && b[o + 1] === SFX_ID.powerdown) seen.down++;
    });
    if (i < 2) assert.equal(S.power, 'echo', 'still held at ' + S.powerT);
  }
  assert.equal(S.power, ''); assert.equal(S.powerT, 0);
  assert.equal(seen.faded, 1); assert.equal(seen.down, 1); assert.deepEqual(ge.filter(t => t === 'powerdown'), ['powerdown']);
  step(sim, 5); assert.equal(S.powerT, 0);
});

test('timer: HALO still ends early on its third absorb', () => {
  const { sim, S } = bare();
  S.setPower('halo'); assert.equal(S.haloHits, 3);
  for (let i = 0; i < 3; i++) S.eFire(sim.player.x, sim.player.y - 3, 0, 0.1, false);
  step(sim, 3);
  assert.equal(S.power, '', 'ring used up well before 900 frames');
});

// ---------- hooks ----------
test('hooks: info exposes powerT, wings and wingLife', () => {
  const { sim, S } = bare();
  const SF = { info: () => ({}) }, app = { sim };
  installHooks(SF, app);
  S.setPower('fan'); step(sim, 4);
  let i = SF.info(); assert.equal(i.powerT, 896); assert.equal(i.wings, 0); assert.equal(i.wingLife, 0);
  diver(S, sim.player.x + 20, sim.player.y - 40); kindle(sim, S);
  i = SF.info(); assert.equal(i.wings, 1); assert.equal(i.wingLife, WING_LIFE);
});

// ---------- wingman ----------
test('KINDLE: at most 1 wingman; X with one out does the bullet clear instead', () => {
  assert.equal(WING_MAX, 1);
  const { sim, S } = bare();
  const d1 = diver(S, sim.player.x + 30, sim.player.y - 40);
  kindle(sim, S);
  assert.equal(sim.wing.length, 1); assert.ok(d1.dead, 'the diver became the wingman');
  const d2 = diver(S, sim.player.x - 30, sim.player.y - 40);
  S.eFire(sim.player.x + 60, sim.player.y - 60, 0, 0.0001, false);
  const before = sim.liveBullets(); assert.equal(before, 1);
  const score = sim.score;
  kindle(sim, S);
  assert.equal(sim.wing.length, 1, 'still one');
  assert.equal(d2.dead, false, 'the second diver is untouched');
  assert.equal(sim.liveBullets(), 0, 'bullets cleared instead');
  assert.ok(sim.score > score, 'the clear pays its bonus');
});

test('wingman: lives 600 play frames, blinks for the last 90, then peels off with no score or lantern change', () => {
  assert.equal(WING_LIFE, 600); assert.equal(WING_BLINK, 90);
  const { sim, S } = bare();
  diver(S, sim.player.x + 30, sim.player.y - 40); kindle(sim, S);
  const w = sim.wing[0]; assert.equal(w.life, 600);
  step(sim, 100); assert.equal(w.life, 500);
  S.addHitstop(4); step(sim, 4); assert.equal(w.life, 500, 'hit-stop freezes the clock');
  step(sim, 410); assert.equal(sim.wing.length, 1); assert.equal(w.life, 90);
  S.meter = 4; const score = sim.score, deaths = sim.deaths;
  step(sim, 89); assert.equal(sim.wing.length, 1, 'alive at 1 frame left');
  assert.equal(sim.wing[0].life, 1);
  const meter = S.meter;
  sim.step(IDLE); sim.clearEvents();
  assert.equal(sim.wing.length, 0, 'gone at 0');
  assert.equal(sim.score, score, 'no points'); assert.ok(S.meter > meter - 1 / 600 - 1e-9 && S.meter <= meter, 'no lantern loss (WING_LOSS is 3; at most one frame of burn)');
  assert.equal(sim.deaths, deaths);
  const peel = sim.peelers.find(q => q.on); assert.ok(peel, 'peeling');
  let y0 = peel.y; step(sim, 20); assert.ok(peel.y < y0 - 10, 'flying up');
  step(sim, 120); assert.equal(sim.peelers.some(q => q.on), false, 'off the top');
  assert.equal(sim.score, score);
  // the same slot can host a fresh wingman with a full life
  diver(S, sim.player.x + 30, sim.player.y - 40); kindle(sim, S);
  assert.equal(sim.wing.length, 1); assert.equal(sim.wing[0].life, 600);
});

// ---------- ECLIPSE ----------
const B = bosses.eclipse;
function fight(seed) {
  const sim = toPlay(createSim({ seed, mode: 'stage5' }));
  sim.setGod(true);
  while (sim.boss.entering) step(sim);
  return sim;
}
// per-volley log: { at, n, sp } with the boss attack clock, bullets in the volley, speed*10
function volleys(sim, frames) {
  const S = sim.ctx, boss = sim.boss, out = [];
  const orig = S.eFire; let cur = null;
  S.eFire = (x, y, vx, vy, big) => {
    const sp = Math.round(Math.hypot(vx, vy) * 10);
    if (cur && cur.at === boss.at && cur.sp === sp) cur.n++; else { cur = { at: boss.at, n: 1, sp, phase: boss.phase }; out.push(cur); }
    orig(x, y, vx, vy, big);
  };
  let max = 0;
  for (let i = 0; i < frames; i++) { step(sim); max = Math.max(max, sim.liveBullets()); }
  S.eFire = orig; out.max = max;
  return out;
}
const gaps = v => { const g = []; for (let i = 1; i < v.length; i++) g.push(v[i].at - v[i - 1].at); return g; };
const modeOf = a => { const c = new Map(); let b = a[0]; for (const x of a) { c.set(x, (c.get(x) || 0) + 1); if (c.get(x) > c.get(b)) b = x; } return b; };

test('ECLIPSE B.10 table values', () => {
  const E = ECLIPSE;
  assert.deepEqual([E.ring1Every, E.ring1N, E.aim1Every, E.summonEvery], [140, 8, 90, 420]);
  assert.deepEqual([E.spiralEvery, E.aim2Every], [16, 120]);
  assert.deepEqual([E.fanEvery, E.ring3Every, E.ring3N], [75, 200, 8]);
  assert.equal(createSim({ seed: 1, mode: 'stage5' }).ctx.D.cap, 26);
});

test('ECLIPSE phase 1: ring of 8 every 140, 3-way every 90, 2 moths every 420', () => {
  const sim = fight(3), S = sim.ctx, boss = sim.boss;
  let moths = 0, prev = sim.enemies.length;
  const log = [], orig = S.eFire;
  S.eFire = (x, y, vx, vy, big) => { log.push({ at: boss.at, sp: Math.round(Math.hypot(vx, vy) * 10), vy }); orig(x, y, vx, vy, big); };
  for (let i = 0; i < 1260; i++) { step(sim); if (sim.enemies.length > prev) moths += sim.enemies.length - prev; prev = sim.enemies.length; }
  const ring = log.filter(b => b.sp === 11), aim = log.filter(b => b.sp === 16);
  assert.equal(ring.length % 8, 0); assert.equal(ring.length / 8, 9, '9 rings in 1260 frames');
  assert.ok(ring.every(b => b.vy > 0) && ring.every(b => b.at % 140 === 0));
  assert.ok(aim.every(b => b.at % 90 === 25)); assert.equal(aim.length / 3, 14);
  assert.equal(log.length, ring.length + aim.length);
  assert.equal(moths, 6, '2 moths at 210, 630, 1050');
});

test('ECLIPSE phase 2 and 3 rates, and never more than 26 bullets in any phase over 600 frames', () => {
  const run = (seed, ph) => { const sim = fight(seed); if (ph > 1) B.setPhase(sim.ctx, ph); return volleys(sim, 600 + 28); };
  const v1 = run(10, 1), v2 = run(11, 2), v3 = run(12, 3);
  const spiral = v2.filter(x => x.sp === 11), aim2 = v2.filter(x => x.sp === 16);
  assert.ok(spiral.every(x => x.n === 2)); assert.equal(modeOf(gaps(spiral)), 16); assert.equal(modeOf(gaps(aim2)), 120);
  const fan = v3.filter(x => x.sp === 13), ring = v3.filter(x => x.sp === 10);
  assert.ok(fan.every(x => x.n === 5)); assert.ok(ring.every(x => x.n === 8));
  assert.equal(modeOf(gaps(fan)), 75); assert.equal(modeOf(gaps(ring)), 200);
  for (const [i, v] of [v1, v2, v3].entries()) { console.log(`  eclipse phase ${i + 1}: max bullets in 628 frames = ${v.max}`); assert.ok(v.max <= 26, `phase ${i + 1} max ${v.max}`); }
});

// ---------- timer bar ----------
function barDots(F, powerT, power = 'fan') {
  const dots = [];
  const R = { dot: (x, y, s, r, g, b, a) => dots.push({ x, y, a }), text() {}, ui: { F } };
  const sim = { enemies: [], ps: [], player: { alive: true, x: 200, px: 200, y: 270, recoil: 0 },
    ctx: { glyph: { on: false }, echoN: 0, haloLostT: 0, power, powerT, haloHits: 3 } };
  powerupsLayer.draw(R, sim, 1, 'play');
  return dots.filter(d => d.y === H - 15);
}
test('timer bar: draws a dot row that shrinks with the time left and blinks in the last 120 frames', () => {
  assert.equal(BAR_BLINK, 120);
  const full = barDots(0, 900); assert.equal(full.length, BAR_DOTS);
  assert.equal(full.filter(d => d.a > 0.5).length, BAR_DOTS, 'all lit at 900');
  assert.equal(barDots(0, 450).filter(d => d.a > 0.5).length, BAR_DOTS / 2, 'half lit at 450');
  assert.equal(barDots(0, 121).length, BAR_DOTS, 'steady at 121');
  assert.equal(barDots(1, 121).length, BAR_DOTS, 'steady at 121 on any frame');
  assert.equal(barDots(0, 100).length, BAR_DOTS, 'on phase of the blink');
  assert.equal(barDots(4, 100).length, 0, 'off phase of the blink');
  assert.equal(barDots(0, 900, '').length, 0, 'no bar without a power-up');
});
