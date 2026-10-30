// S11 heat (design.md B.5 "Heat (visible rank)", B.4 worked example, B.9 hit-stop) and the test-only infiniteLives
// option. Drives the real sim from createSim; events go through the sim's own emit (every system sees them).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSim, GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { heatBullet, heatGap, heatFactor, flameStep, intensity, HEAT_MAX } from '../games/starfall/sim/heat.js';
import { killPoints } from '../games/starfall/sim/score.js';
import { limitBullet, BULLET_MAX, GAP_FLOOR_LOW } from '../games/starfall/sim/difficulty.js';
import { encode } from '../engine/replay.js';
import { makeVerifyReplay, createModes, MODE_FREE } from '../games/starfall/modes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fresh = (seed = 1) => { const sim = createSim({ seed }); return { sim, S: sim.ctx }; };

test('heat starts at 0 and is part of the state hash', () => {
  const a = fresh(), b = fresh();
  assert.equal(a.sim.heat, 0);
  assert.equal(a.sim.stateHash(), b.sim.stateHash());
  b.S.heat = 1;
  assert.notEqual(a.sim.stateHash(), b.sim.stateHash());
});

test('clear a normal stage without dying: +2; after a death in that stage: +0', () => {
  const { S } = fresh();
  S.emit('clear');
  assert.equal(S.heat, 2);
  S.emit('stage'); S.heat = 20;
  S.playerDie();                 // 20 - 15 = 5
  assert.equal(S.heat, 5);
  S.emit('clear');
  assert.equal(S.heat, 5, 'a stage with a death pays no clear heat');
  S.emit('stage'); S.emit('clear');
  assert.equal(S.heat, 7, 'the next clean stage pays again');
});

test('kill a boss: +5; a boss timeout: +0', () => {
  const { S } = fresh();
  S.emit('bossKill');
  assert.equal(S.heat, 5);
  S.emit('bossTimeout');
  assert.equal(S.heat, 5);
});

test('reach chain tier x4 (chain 60): +1 once per stage, from the step, a kill, or a chain that ended this frame', () => {
  const { sim, S } = fresh();
  S.chain = 59; S.chainT = 45; sim.step(0);
  assert.equal(S.heat, 0, 'chain 59 is tier x3');
  S.chain = 60; S.chainT = 45; sim.step(0);
  assert.equal(S.heat, 1);
  S.chain = 80; sim.step(0); S.emit('kill');
  assert.equal(S.heat, 1, 'only once per stage');
  S.emit('stage');
  S.chain = 60; S.emit('kill');
  assert.equal(S.heat, 2, 'paid again in the next stage');
  // a chain that ended at 60+ on this frame (the score system ends it first) still counts on the clear
  S.emit('stage');
  S.chain = 0; S.chainLast = 61; S.chainEndF = S.frame;
  S.emit('clear');
  assert.equal(S.heat, 2 + 1 + 2, 'tier x4 +1 and the clean clear +2');
  S.emit('stage'); S.chainLast = 61; S.chainEndF = S.frame - 1;
  S.emit('bossKill');
  assert.equal(S.heat, 5 + 5, 'a chain that ended on an earlier frame does not count');
});

test('hold a power-up when a stage starts: +1; no power-up: +0', () => {
  const { S } = fresh();
  S.emit('stage');
  assert.equal(S.heat, 0);
  assert.ok(S.setPower('halo'));
  S.emit('stage');
  assert.equal(S.heat, 1);
});

test('death: -15, never below 0', () => {
  const { S } = fresh();
  S.heat = 40; S.playerDie();
  assert.equal(S.heat, 25);
  const b = fresh(); b.S.heat = 10; b.S.playerDie();
  assert.equal(b.S.heat, 0);
});

test('heat is held in 0..100', () => {
  const { S } = fresh();
  S.heat = 99; S.emit('bossKill');
  assert.equal(S.heat, HEAT_MAX);
  assert.equal(HEAT_MAX, 100);
  S.emit('clear');
  assert.equal(S.heat, 100);
});

test('heat events freeze in hit-stop', () => {
  const { sim, S } = fresh();
  S.chain = 60; S.chainT = 45; S.addHitstop(6);
  const n = S.hitstop;
  assert.ok(n > 0);
  for (let i = 0; i < n; i++) sim.step(0);
  assert.equal(S.heat, 0, 'tier x4 is not paid during hit-stop');
  assert.equal(S.hitstop, 0);
  sim.step(0);
  assert.equal(S.heat, 1, 'paid on the first frame after hit-stop');
});

test('effect numbers: bullet speed, dive gap, kill-point factor (B.5)', () => {
  assert.equal(heatBullet(0), 1);
  assert.equal(heatBullet(50), 1.1);
  assert.equal(heatBullet(100), 1.2);
  assert.equal(heatBullet(150), 1.2, 'at most +20%');
  assert.equal(heatGap(0), 0);
  assert.equal(heatGap(10), 3);
  assert.equal(heatGap(55), 16, 'floor(55 x 0.3)');
  assert.equal(heatGap(100), 30);
  assert.equal(heatFactor(0), 1);
  assert.equal(heatFactor(4), 1.02);
  assert.equal(heatFactor(100), 1.5);
  assert.equal(heatFactor(150), 1.5, 'at most x1.5');
});

test('B.4 worked example: heat 4 at stage 3 gives factor 1.02 and 110 x 2 x 82 x 1.02 = 18,400', () => {
  assert.equal(heatFactor(4), 1.02);
  assert.equal(killPoints(110, 2, 82, 4, 1), 18400);
  assert.equal(killPoints(110, 2, 82, 0, 1), 18040);
});

test('the real sim applies heat to bullet speed, dive gap and kill points', () => {
  const a = fresh(7), b = fresh(7);
  b.S.heat = 50;
  assert.equal(b.S.bulletSpd(), limitBullet(b.S.D.bullet * 1.1));
  assert.equal(a.S.diveGap(20) - b.S.diveGap(20), 15, 'same rng draw, floor(50 x 0.3) frames shorter');
  const c = fresh(7), d = fresh(7);
  d.S.heat = 100;
  const v0 = c.S.pieceKill(100), v1 = d.S.pieceKill(100);
  assert.equal(v1, Math.floor(v0 * 1.5 / 10) * 10);
});

test('the global limits run after heat', () => {
  const { S } = fresh();
  S.heat = 100; S.D.bullet = 3.5;              // 3.5 x 1.2 = 4.2
  assert.equal(S.bulletSpd(), BULLET_MAX);
  S.D.gapLow = 20;                             // 20 + rnd x 40 - 30 can go under the low floor
  for (let i = 0; i < 50; i++) assert.ok(S.diveGap(4) >= GAP_FLOOR_LOW);
});

test('every boss bullet speed goes through heat, then the limit', () => {
  for (const f of ['eclipse', 'moonwell', 'pyre']) {
    const src = fs.readFileSync(path.join(ROOT, 'games/starfall/sim/bosses', f + '.js'), 'utf8');
    assert.match(src, /const spd = \(S, v\) => limitBullet\(v \* S\.D\.bulletMul \* heatBullet\(S\.heat\)\);/, f);
  }
});

test('flame steps and music intensity', () => {
  assert.deepEqual([0, 1, 20, 21, 40, 41, 60, 61, 80, 81, 100].map(flameStep), [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  assert.equal(intensity(0), 0);
  assert.equal(intensity(50), 0.5);
  assert.equal(intensity(100), 1);
});

test('infiniteLives: deaths count, the ship comes back, the run is tainted and hashes differently', () => {
  const sim = createSim({ seed: 3, infiniteLives: true }), S = sim.ctx;
  assert.equal(sim.tainted, true);
  const plain = createSim({ seed: 3 });
  assert.notEqual(sim.stateHash(), plain.stateHash());
  for (let i = 0; i < 5; i++) { S.player.alive = true; S.playerDie(); }
  assert.equal(sim.deaths, 5);
  assert.equal(sim.lives, 3);
  const b = createSim({ seed: 3 }); b.ctx.playerDie();
  assert.equal(b.lives, 2, 'a normal run still loses the ship');
});

test('infiniteLives cannot be reached from the page', () => {
  for (const f of ['starfall.html', 'games/starfall/main.js', 'games/starfall/hooks.js', 'games/starfall/modes.js', 'games/starfall/attract.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!src.includes('infiniteLives'), f + ' must not mention infiniteLives');
  }
  // the page and the verifier build the sim from seed and mode only
  const main = fs.readFileSync(path.join(ROOT, 'games/starfall/main.js'), 'utf8');
  assert.match(main, /createSim\(\{ seed, mode \}\)/);
});

test('an infiniteLives run can never be submitted or verified as ranked', () => {
  // an idle ship on an infiniteLives run: it dies again and again and the run goes on
  const sim = createSim({ seed: 3, mode: 'arcade', infiniteLives: true });
  const words = [];
  while (sim.frame < 20000 && sim.deaths < 4) { sim.step(0); words.push(0); sim.clearEvents(); }
  for (let i = 0; i < 400; i++) { sim.step(0); words.push(0); sim.clearEvents(); }
  assert.ok(sim.deaths >= 4, 'the idle ship died at least 4 times');
  assert.ok(sim.lives > 0 && !sim.done);
  // the page's header for a tainted run is mode + '+dev' (main.js): the verifier refuses it
  const verify = makeVerifyReplay({ now: null });
  const base = { game: GAME_ID, version: GAME_VERSION, seed: 3 };
  assert.ok(Number.isNaN(verify({ replay: encode({ ...base, mode: 'arcade+dev' }, words), seed: 3, mode: MODE_FREE, version: GAME_VERSION })));
  // a forged plain header re-simulates without infiniteLives: that run is over after 3 deaths, so the replay runs
  // past its end and is refused
  const forged = verify({ replay: encode({ ...base, mode: 'arcade' }, words), seed: 3, mode: MODE_FREE, version: GAME_VERSION });
  assert.ok(Number.isNaN(forged));
  const plain = createSim({ seed: 3, mode: 'arcade' });
  for (const w of words) { if (plain.done) break; plain.step(w); plain.clearEvents(); }
  assert.ok(plain.done || plain.lives <= 0, 'the plain run is over after 4 deaths');
  assert.notEqual(plain.stateHash(), sim.stateHash());
  // and the modes layer refuses to submit a tainted sim
  const modes = createModes({ lb: null });
  const run = modes.begin(MODE_FREE, 3); modes.claim(run);
  assert.equal(modes.canSubmit(run, sim), false);
});
