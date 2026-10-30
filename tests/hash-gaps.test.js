// w13-tests (w8-tests review LOW, log ~21:30): the hash tests nudged a field by 1 and so passed if the hash dropped the low
// bit (or a whole byte) of a value, and the wingman clock in 'bonusEnd' was untested. New file only.
// (a) full-value hash checks: every bit of every listed field changes stateHash(). No stored hash values: each check
//     compares the hash with the same sim's hash a moment earlier.
// (b) the wingman clock does not run in 'bonusEnd' (the third state of the B.10 rule; clear / intro / bossOut are in
//     balance-b10-gaps.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';

const IDLE = 128, KIN = IDLE | (1 << 11);
const step = (sim, n = 1, w = IDLE) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(w); sim.clearEvents(); } return sim; };
const toPlay = sim => { while (sim.state !== 'play') step(sim); return sim; };
function withWing() {
  const sim = toPlay(createSim({ seed: 1, mode: 'stage2' })), S = sim.ctx;
  S.clearEnemies();
  const k = S.mkEnemy('moth', -1, -1); k.st = 'wait'; k.delay = 1e9; S.enemies.push(k);
  const d = S.mkEnemy('moth', -1, -1); d.st = 'dive'; d.x = d.px = sim.player.x + 30; d.y = d.py = sim.player.y - 40; d.noReturn = true;
  d.path = { L: [0, 1e9], K: [0], len: 1e9, m: 2, p: [d.x, d.y, d.x, d.y] }; d.spd = 0; S.enemies.push(d);
  S.meter = 10; sim.step(KIN); sim.clearEvents();
  assert.equal(sim.wing.length, 1, 'setup: one wingman');
  return { sim, S };
}

// ---------- (a) every bit of the value reaches the hash ----------
const dv = new DataView(new ArrayBuffer(8));
function flipU32(sim, obj, key, bit) {
  const o = obj[key], v = ((o >>> 0) ^ (1 << bit)) >>> 0;   // 1 << 31 is negative: >>> 0 brings it back
  obj[key] = v; const h = sim.stateHash(); obj[key] = o; return h;
}
function flipF64(sim, obj, key, bit) {   // bit 0..51 mantissa, 63 sign (the exponent could make a NaN, whose payload bits collapse)
  const o = obj[key];
  dv.setFloat64(0, o, true);
  const word = bit < 32 ? 0 : 4, b = bit % 32;
  dv.setUint32(word, (dv.getUint32(word, true) ^ (1 << b)) >>> 0, true);
  obj[key] = dv.getFloat64(0, true); const h = sim.stateHash(); obj[key] = o; return h;
}
test('full-value hash: every one of the 32 bits of each listed integer field changes stateHash (powerT, wing life, lanceCd, haloHits, twistT, pincerN, huntN, score, stage, hp, tele)', () => {
  const { sim, S } = withWing();
  S.setPower('fan'); S.powerT = 1000; S.lanceCd = 7; S.haloHits = 3; S.twistT = 123; S.pincerN = 2; S.huntN = 40; S.score = 5000;
  const en = sim.enemies.find(e => !e.dead);
  const fields = [[S, 'powerT'], [sim.wing[0], 'life'], [S, 'lanceCd'], [S, 'haloHits'], [S, 'twistT'], [S, 'pincerN'], [S, 'huntN'], [S, 'score'], [S, 'stage'], [en, 'hp'], [en, 'tele']];
  const h0 = sim.stateHash();
  assert.equal(sim.stateHash(), h0, 'the hash is stable when nothing changes');
  for (const [obj, key] of fields) {
    for (let bit = 0; bit < 32; bit++) assert.notEqual(flipU32(sim, obj, key, bit), h0, `${key} bit ${bit} changes the hash`);
  }
  assert.equal(sim.stateHash(), h0, 'everything restored');
});
test('full-value hash: odd and even values both react to a step of 1 (a dropped low bit hides half of all steps)', () => {
  const { sim, S } = withWing(); S.setPower('fan');
  for (const [obj, key] of [[S, 'powerT'], [sim.wing[0], 'life']]) {
    for (const base of [200, 201, 4094, 4095, 65535, 65536]) {
      obj[key] = base; const a = sim.stateHash();
      obj[key] = base + 1; const b = sim.stateHash();
      assert.notEqual(a, b, `${key} ${base} vs ${base + 1}`);
    }
  }
});
test('full-value hash: the low mantissa bits and the sign of the f64 fields (ship x, kindle meter, wingman x and y, hunt centre) change stateHash', () => {
  const { sim, S } = withWing();
  S.huntC = 173.25;
  const fields = [[sim.player, 'x'], [sim.player, 'vx'], [S, 'meter'], [sim.wing[0], 'x'], [sim.wing[0], 'y'], [S, 'huntC']];
  const h0 = sim.stateHash();
  for (const [obj, key] of fields) {
    if (obj[key] === 0) obj[key] = 0.5;
    const hb = sim.stateHash();
    for (const bit of [0, 1, 7, 8, 15, 16, 31, 32, 40, 47, 51, 63]) assert.notEqual(flipF64(sim, obj, key, bit), hb, `${key} bit ${bit} changes the hash`);
  }
  assert.ok(typeof h0 === 'string');
});

// ---------- (b) bonusEnd ----------
test('wingman life clock is frozen in bonusEnd, and runs again in play', () => {
  const { sim, S } = withWing();
  const w = sim.wing[0], l0 = w.life;
  S.setState('bonusEnd');
  for (let i = 0; i < 30; i++) { sim.step(IDLE); sim.clearEvents(); assert.equal(sim.state, 'bonusEnd', 'state held'); }
  assert.equal(w.life, l0, 'life unchanged after 30 frames in bonusEnd');
  assert.equal(sim.wing.length, 1);
  S.setState('play'); step(sim, 5);
  assert.equal(w.life, l0 - 5, 'ticks again in play');
});
