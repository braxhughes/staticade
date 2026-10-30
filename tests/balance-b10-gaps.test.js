// B.10 gap tests (w8-tests): closes the gaps the w7-balance cold review found.
// (a) wingman clock frozen in clear / intro / bossOut, (b) wingman blink render, (c) power-up bar blink
// boundary at 120 / 121, (d) powerT and wingman life are part of stateHash().
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { playerLayer } from '../games/starfall/render/core.js';
import { powerupsLayer, BAR_DOTS, BAR_BLINK } from '../games/starfall/render/powerups.js';
import { WING_LIFE, WING_BLINK, H } from '../games/starfall/defs.js';

const IDLE = 128, KIN = IDLE | (1 << 11);
const step = (sim, n = 1, w = IDLE) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(w); sim.clearEvents(); } return sim; };
const toPlay = sim => { while (sim.state !== 'play') step(sim); return sim; };
function bare(seed = 1) {
  const sim = toPlay(createSim({ seed, mode: 'stage2' })), S = sim.ctx;
  S.clearEnemies();
  const k = S.mkEnemy('moth', -1, -1); k.st = 'wait'; k.delay = 1e9; S.enemies.push(k);
  return { sim, S };
}
function withWing() {
  const { sim, S } = bare();
  const d = S.mkEnemy('moth', -1, -1); d.st = 'dive'; d.x = d.px = sim.player.x + 30; d.y = d.py = sim.player.y - 40; d.noReturn = true;
  d.path = { L: [0, 1e9], K: [0], len: 1e9, m: 2, p: [d.x, d.y, d.x, d.y] }; d.spd = 0; S.enemies.push(d);
  S.meter = 10; sim.step(KIN); sim.clearEvents();
  assert.equal(sim.wing.length, 1, 'setup: one wingman');
  return { sim, S };
}

// ---------- (a) the wingman clock is frozen outside play ----------
for (const state of ['clear', 'intro', 'bossOut']) {
  test(`wingman life clock is frozen in ${state}, and runs again in play`, () => {
    const { sim, S } = withWing();
    const w = sim.wing[0], l0 = w.life;
    S.setState(state);
    for (let i = 0; i < 30; i++) { sim.step(IDLE); sim.clearEvents(); assert.equal(sim.state, state, 'state held'); }
    assert.equal(w.life, l0, `life unchanged after 30 frames in ${state}`);
    assert.equal(sim.wing.length, 1);
    S.setState('play'); step(sim, 5);
    assert.equal(w.life, l0 - 5, 'ticks again in play');
  });
}

// ---------- (b) wingman blink render ----------
function wingAlphas(life, F) {
  const sprs = [], dots = [];
  const R = { ui: { F }, drawSpr: (spr, x, y, ang, pal, sc, a) => sprs.push(a), dot: (x, y, s, r, g, b, a) => dots.push(a), text() {} };
  const sim = { wing: [{ ti: 0, x: 100, y: 200, px: 100, py: 200, ang: 0, life }], peelers: [], player: { alive: false } };
  playerLayer.draw(R, sim, 1, 'play');
  return sprs;
}
test('wingman render: steady above 90 life, alternates 4 on / 4 dim in the last 90 frames', () => {
  assert.equal(WING_BLINK, 90);
  for (const life of [600, 300, 91]) for (let F = 0; F < 16; F++) assert.deepEqual(wingAlphas(life, F), [1], `life ${life} F ${F} steady`);
  for (const life of [90, 60, 1]) {
    const seq = []; for (let F = 0; F < 16; F++) { const a = wingAlphas(life, F); assert.equal(a.length, 1); seq.push(a[0]); }
    assert.deepEqual(seq, [0.3, 0.3, 0.3, 0.3, 1, 1, 1, 1, 0.3, 0.3, 0.3, 0.3, 1, 1, 1, 1], `life ${life} blink pattern`);
  }
});
test('wingman render: the exhaust dot dims with the sprite', () => {
  const dim = [], lit = [];
  for (const [life, F, out] of [[50, 0, dim], [50, 4, lit]]) {
    const R = { ui: { F }, drawSpr() {}, dot: (x, y, s, r, g, b, a) => out.push(a), text() {} };
    playerLayer.draw(R, { wing: [{ ti: 0, x: 1, y: 2, px: 1, py: 2, ang: 0, life }], peelers: [], player: { alive: false } }, 1, 'play');
  }
  assert.ok(Math.max(...dim) <= 0.3 * 0.9 + 1e-9, 'dim exhaust');
  assert.ok(Math.max(...lit) > 0.3 * 0.9 + 1e-9, 'lit exhaust is brighter');
});

// ---------- (c) bar blink boundary ----------
function barDots(F, powerT) {
  const dots = [];
  const R = { dot: (x, y, s, r, g, b, a) => dots.push({ y, a }), text() {}, ui: { F } };
  const sim = { enemies: [], ps: [], player: { alive: true, x: 200, px: 200, y: 270, recoil: 0 },
    ctx: { glyph: { on: false }, echoN: 0, haloLostT: 0, power: 'fan', powerT, haloHits: 3 } };
  powerupsLayer.draw(R, sim, 1, 'play');
  return dots.filter(d => d.y === H - 15);
}
test('timer bar: blink starts at exactly 120 left (120 blinks, 121 is steady)', () => {
  assert.equal(BAR_BLINK, 120);
  for (const F of [0, 1, 2, 3, 4, 5, 6, 7]) {
    assert.equal(barDots(F, 121).length, BAR_DOTS, `121 steady, F ${F}`);
    assert.equal(barDots(F, 120).length, F % 8 < 4 ? BAR_DOTS : 0, `120 blinks, F ${F}`);
    assert.equal(barDots(F, 119).length, F % 8 < 4 ? BAR_DOTS : 0, `119 blinks, F ${F}`);
  }
});

// ---------- (d) hash coverage ----------
test('stateHash changes when powerT changes', () => {
  const { sim, S } = bare(); S.setPower('fan');
  const h0 = sim.stateHash(); S.powerT -= 1;
  assert.notEqual(sim.stateHash(), h0, 'powerT is hashed');
  S.powerT += 1; assert.equal(sim.stateHash(), h0, 'and restoring it restores the hash');
});
test('stateHash changes when a wingman life changes', () => {
  const { sim } = withWing();
  const h0 = sim.stateHash(), w = sim.wing[0]; w.life -= 1;
  assert.notEqual(sim.stateHash(), h0, 'wing life is hashed');
  w.life += 1; assert.equal(sim.stateHash(), h0);
});
