// W6 HIGH: dying on the frame the stage clears used to softlock the run ('play' with a dead ship forever).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { packWord } from '../engine/input-word.js';

const IDLE = packWord(0, false, false, false, false, 0);
const step = (sim, n = 1) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(IDLE); sim.clearEvents(); } };
const toPlay = sim => { while (sim.state !== 'play') step(sim); return sim; };

// leave one enemy alive and park it on the ship, moving like a dive that is about to ram it
function lastEnemyRams(sim) {
  const S = sim.ctx, p = sim.player;
  const e = sim.enemies.find(x => !x.dead);
  for (const x of sim.enemies) if (x !== e) x.dead = true;
  sim.enemies.length = 0; sim.enemies.push(e);
  e.st = 'spark'; e.vx = 0; e.vy = 0; e.x = e.px = p.x; e.y = e.py = p.y - 2;
  p.inv = 0; S.power = '';
  step(sim);
}

// every state the run passes through until it ends or reaches the next stage's 'play'
function trace(sim, limit = 2000) {
  const seen = [];
  let last = '';
  for (let f = 0; f < limit && !sim.done; f++) {
    if (sim.state !== last) { last = sim.state; seen.push({ state: last, alive: sim.player.alive, stage: sim.stage }); }
    if (sim.state === 'play' && seen.length > 1 && seen.some(s => s.state === 'intro')) break;
    step(sim);
  }
  if (sim.state !== last) seen.push({ state: sim.state, alive: sim.player.alive, stage: sim.stage });
  return seen;
}

test('last enemy rams the ship: no clear while dead; the stage clears after the respawn', () => {
  const sim = toPlay(createSim({ seed: 3, mode: 'stage1' }));
  const lives = sim.lives;
  lastEnemyRams(sim);
  assert.equal(sim.enemies.length, 0);
  assert.equal(sim.player.alive, false);
  assert.equal(sim.state, 'dying', 'the death is not overwritten by a clear');
  assert.equal(sim.lives, lives - 1);
  const seen = trace(sim);
  assert.deepEqual(seen.map(s => s.state), ['dying', 'ready', 'play', 'clear', 'intro', 'play']);
  for (const s of seen) if (s.state === 'clear' || s.state === 'play' || s.state === 'intro') assert.equal(s.alive, true, s.state + ' with a live ship');
  assert.equal(sim.stage, 2);
  assert.equal(sim.player.alive, true);
});

test('last enemy rams the ship on the last life: game over, never a clear', () => {
  const sim = toPlay(createSim({ seed: 3, mode: 'stage1' }));
  sim.ctx.lives = 1;
  lastEnemyRams(sim);
  assert.equal(sim.state, 'dying');
  const seen = trace(sim);
  assert.deepEqual(seen.map(s => s.state), ['dying', 'gameover']);
  for (let f = 0; f < 600 && !sim.done; f++) step(sim);
  assert.equal(sim.done, true);
});

test('boss killed on the same frame the ship dies: bossOut waits for the respawn', () => {
  const sim = toPlay(createSim({ seed: 5, mode: 'stage5' })), S = sim.ctx;
  while (S.boss.entering) step(sim);
  S.playerDie(); S.bossDefeated(); // same order as inside one step: a summoned enemy rams, then a shot ends the boss
  assert.equal(sim.boss.on, false);
  assert.equal(sim.state, 'dying');
  const seen = trace(sim);
  assert.deepEqual(seen.map(s => s.state), ['dying', 'ready', 'play', 'bossOut', 'clear', 'intro', 'play']);
  for (const s of seen) if (s.state !== 'dying' && s.state !== 'ready') assert.equal(s.alive, true, s.state + ' with a live ship');
  assert.equal(sim.stage, 6);
});

test('boss killed while the ship is dead on its last life: game over', () => {
  const sim = toPlay(createSim({ seed: 5, mode: 'stage5' })), S = sim.ctx;
  while (S.boss.entering) step(sim);
  S.lives = 1; S.playerDie(); S.bossDefeated();
  const seen = trace(sim);
  assert.deepEqual(seen.map(s => s.state), ['dying', 'gameover']);
});

test('intro never hands a dead ship to play', () => {
  const sim = createSim({ seed: 4, mode: 'stage1' });
  step(sim, 5);
  assert.equal(sim.state, 'intro');
  sim.player.alive = false;
  while (sim.state === 'intro') step(sim);
  assert.equal(sim.state, 'ready');
  while (sim.state === 'ready') step(sim);
  assert.equal(sim.state, 'play'); assert.equal(sim.player.alive, true);
});
