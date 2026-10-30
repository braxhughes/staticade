import test from 'node:test';
import assert from 'node:assert/strict';
import { STAGE_TABLE, rowOf, loopOf, slotType } from '../games/starfall/sim/stages.js';
import { createDifficulty, fillDifficulty, diveShots, limitBullet, limitDive, limitGap } from '../games/starfall/sim/difficulty.js';
import { enemyTypeId, bossId, enemyTypes } from '../games/starfall/sim/registry.js';
import { systems } from '../games/starfall/sim/systems.js';
import { layers } from '../games/starfall/render/layers.js';
import { createSim } from '../games/starfall/sim.js';
import { GROUPS } from '../games/starfall/defs.js';

const run = (sim, n, w = 128) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(w); sim.clearEvents(); } return sim; };

test('15-stage table: kinds, zones and bosses follow B.0', () => {
  const kinds = [], zones = [];
  for (let s = 1; s <= 15; s++) { kinds.push(STAGE_TABLE[s].kind); zones.push(STAGE_TABLE[s].zone); }
  assert.deepEqual(kinds, ['normal', 'normal', 'normal', 'bonus', 'boss', 'normal', 'normal', 'normal', 'bonus', 'boss', 'normal', 'normal', 'normal', 'bonus', 'boss']);
  assert.deepEqual(zones, [1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3]);
  assert.deepEqual([5, 10, 15].map(s => STAGE_TABLE[s].boss), ['eclipse', 'moonwell', 'pyre']);
  assert.deepEqual([4, 9, 14].map(s => STAGE_TABLE[s].enemies), [36, 42, 48]);
});

test('endless: stage s plays row ((s-1)%15)+1 in loop floor((s-1)/15)', () => {
  assert.deepEqual([1, 15, 16, 30, 31, 47].map(rowOf), [1, 15, 1, 15, 1, 2]);
  assert.deepEqual([1, 15, 16, 30, 31, 47].map(loopOf), [0, 0, 1, 1, 2, 3]);
});

test('sim stage kinds come from the table, not v1 modulo (8 normal, 9 STARLIGHT, 12 normal, 14 STARLIGHT)', () => {
  const want = { 4: 'bonus', 5: 'boss', 8: 'normal', 9: 'bonus', 10: 'boss', 11: 'normal', 12: 'normal', 14: 'bonus', 15: 'boss', 16: 'normal', 19: 'bonus', 20: 'boss' };
  for (const [s, k] of Object.entries(want)) {
    const sim = createSim({ seed: 3, mode: 'stage' + s });
    assert.equal(sim.stageKind, k, 'stage ' + s);
  }
  const s11 = createSim({ seed: 1, mode: 'stage11' });
  assert.equal(s11.zone, 3); assert.equal(s11.loop, 0);
  const s16 = createSim({ seed: 1, mode: 'stage16' });
  assert.equal(s16.zone, 1); assert.equal(s16.loop, 1); assert.equal(s16.row, 1);
});

test('enemy mix: v1 base layout, overrides, and the moth fallback for unregistered ids', () => {
  assert.equal(slotType(1, 0, 0), 'warden'); assert.equal(slotType(1, 1, 0), 'wisp'); assert.equal(slotType(1, 3, 1), 'moth');
  assert.equal(slotType(2, 3, 1), 'splitter'); assert.equal(slotType(2, 2, 3), 'lamplighter');
  assert.equal(slotType(6, 1, 1), 'prism'); assert.equal(slotType(7, 4, 0), 'eel'); assert.equal(slotType(13, 1, 3), 'mirage');
  assert.equal(slotType(11, 3, 0), 'cinder');
  const count = (row, t) => { let n = 0; for (const G of GROUPS) for (const [r, c] of G.slots) if (slotType(row, r, c) === t) n++; return n; };
  assert.equal(count(2, 'splitter'), 4); assert.equal(count(3, 'splitter'), 6);
  assert.equal(count(6, 'prism'), 4); assert.equal(count(8, 'prism'), 6); assert.equal(count(8, 'eel'), 10);
  assert.equal(count(11, 'cinder'), 6); assert.equal(count(12, 'mirage'), 4); assert.equal(count(13, 'mirage'), 6);
  for (let row = 2; row <= 13; row++) if (STAGE_TABLE[row].kind === 'normal') assert.equal(count(row, 'lamplighter'), 1, 'row ' + row);
  assert.equal(enemyTypeId('nosuch'), 'moth'); assert.equal(enemyTypeId('splitter'), 'splitter');
  assert.equal(bossId('nosuch'), 'eclipse'); assert.equal(bossId('eclipse'), 'eclipse');
  const sim = createSim({ seed: 2, mode: 'stage6' });
  assert.equal(sim.enemies.length, 40);
  for (const e of sim.enemies) assert.ok(Object.keys(enemyTypes).includes(e.type), e.type);
  const b10 = createSim({ seed: 2, mode: 'stage10' });
  assert.equal(b10.boss.on, true); assert.equal(b10.boss.id, bossId(STAGE_TABLE[10].boss));
});

test('group leaders: one per entry group, never a Warden', () => {
  const sim = createSim({ seed: 4, mode: 'stage1' });
  const leaders = sim.enemies.filter(e => e.leader);
  assert.equal(leaders.length, GROUPS.length);
  for (const e of leaders) assert.notEqual(e.type, 'warden');
  assert.deepEqual(leaders.map(e => e.group).sort(), [0, 1, 2, 3, 4]);
});

test('difficulty table B.5, loop scaling and global limits', () => {
  const D = createDifficulty();
  fillDifficulty(D, 3);
  assert.equal(D.entry, 2.6); assert.equal(D.dive, 1.95); assert.equal(D.bullet, 2.3); assert.equal(D.maxFull, 3); assert.equal(D.maxLow, 5);
  assert.equal(D.gapFull, 95); assert.equal(D.gapLow, 25); assert.equal(D.pathFire, 0.002); assert.equal(D.cap, 18);
  fillDifficulty(D, 13);
  assert.equal(D.maxFull, 6); assert.equal(D.maxLow, 8); assert.equal(D.cap, 34); assert.equal(D.scoreLoop, 1);
  fillDifficulty(D, 5);
  assert.equal(D.cap, 26); assert.equal(D.bossLo, 1.0); assert.equal(D.bossHi, 1.6); assert.equal(D.dive, 1.95, 'boss rows dive like the previous normal row');
  fillDifficulty(D, 28); // row 13, loop 1
  assert.ok(Math.abs(D.bullet - 3.0 * 1.06) < 1e-9); assert.ok(Math.abs(D.dive - 2.8 * 1.05) < 1e-9);
  assert.equal(D.maxFull, 7); assert.equal(D.maxLow, 9); assert.equal(D.cap, 40); assert.equal(D.scoreLoop, 1.25); assert.equal(D.bossHp, 1.25);
  fillDifficulty(D, 15 * 20 + 13); // loop 20: every cap hits
  assert.equal(D.bulletMul, 1.36); assert.equal(D.diveMul, 1.30); assert.equal(D.maxFull, 9); assert.equal(D.cap, 96);
  assert.equal(D.scoreLoop, 3); assert.equal(D.bossHp, 2.5); assert.equal(diveShots(D, () => 0), 4);
  assert.equal(limitBullet(0.2), 1.0); assert.equal(limitBullet(9), 3.6); assert.equal(limitDive(5), 3.6);
  assert.equal(limitGap(3, false), 30); assert.equal(limitGap(3, true), 14); assert.equal(limitGap(50, true), 50);
});

test('extra lives at 40,000 and 150,000 then every 250,000, stock capped at 6', () => {
  const sim = createSim({ seed: 1 }), S = sim.ctx;
  S.addScore(39990); assert.equal(sim.lives, 3);
  S.addScore(10); assert.equal(sim.lives, 4);
  S.addScore(110000); assert.equal(sim.lives, 5);
  S.addScore(250000); assert.equal(sim.lives, 6);
  S.addScore(250000); assert.equal(sim.lives, 6, 'capped');
  assert.equal(S.nextLife, 900000);
});

test('boss timeout: the boss passes after 5400 fight frames, the run advances, no kill bonus', () => {
  const sim = createSim({ seed: 9, mode: 'stage5' });
  sim.setGod(true);
  let passed = -1;
  for (let i = 0; i < 6000 && passed < 0; i++) { sim.step(128); sim.clearEvents(); if (!sim.boss.on && sim.state === 'clear') passed = sim.frame; }
  assert.ok(passed > 5400, 'boss left at frame ' + passed);
  const before = sim.score;
  run(sim, 400);
  assert.equal(sim.stage, 6); assert.equal(sim.zone, 2);
  assert.ok(sim.score - before < 20000, 'no boss kill bonus');
});

test('registries: systems and layers are ordered lists with the expected shape', () => {
  for (const s of systems) { assert.equal(typeof s.id, 'string'); for (const f of ['init', 'step', 'onEvent']) assert.equal(typeof s[f], 'function'); }
  assert.ok(systems.some(s => s.id === 'score'));
  for (const L of layers) { assert.equal(typeof L.id, 'string'); assert.equal(typeof L.draw, 'function'); }
  assert.deepEqual(layers.filter(l => l.hud).map(l => l.id), ['hud', 'overlay']);
});

test('score stub: kill points scale by DEEP SKY mult and loop factor; flat bonus by loop factor only', () => {
  const a = createSim({ seed: 1, mode: 'stage1' }).ctx;
  a.mult = 2; assert.equal(a.addKill(60), 120); assert.equal(a.addBonus(500), 500);
  const b = createSim({ seed: 1, mode: 'stage16' }).ctx;
  b.mult = 1; assert.equal(b.addKill(90), 110); assert.equal(b.addBonus(1000), 1250);
});
