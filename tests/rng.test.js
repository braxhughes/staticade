import test from 'node:test';
import assert from 'node:assert/strict';
import { Rng, createRng, seedFromString, dailySeed } from '../engine/rng.js';

test('same seed gives the same sequence', () => {
  const a = createRng(12345), b = createRng(12345);
  for (let i = 0; i < 1000; i++) assert.equal(a.u32(), b.u32());
});

test('seed stability: sequence for seed 12345 never changes (golden values)', () => {
  const r = createRng(12345), got = [];
  for (let i = 0; i < 5; i++) got.push(r.u32());
  assert.deepEqual(got, GOLDEN_12345);
});

test('next() is in [0, 1) and roughly uniform', () => {
  const r = createRng(7); let sum = 0;
  for (let i = 0; i < 100000; i++) { const v = r.next(); assert.ok(v >= 0 && v < 1); sum += v; }
  assert.ok(Math.abs(sum / 100000 - 0.5) < 0.01);
});

test('save / restore resumes the exact sequence', () => {
  const r = createRng(99);
  for (let i = 0; i < 37; i++) r.u32();
  const s = r.save();
  const first = []; for (let i = 0; i < 50; i++) first.push(r.u32());
  r.restore(s);
  const again = []; for (let i = 0; i < 50; i++) again.push(r.u32());
  assert.deepEqual(again, first);
  const other = new Rng(0).restore(s), third = [];
  for (let i = 0; i < 50; i++) third.push(other.u32());
  assert.deepEqual(third, first);
});

test('different seeds give different sequences', () => {
  const a = createRng(1), b = createRng(2);
  let same = 0; for (let i = 0; i < 100; i++) if (a.u32() === b.u32()) same++;
  assert.ok(same < 3);
});

test('seedFromString and dailySeed are stable, distinct and validated', () => {
  assert.equal(seedFromString('starfall'), seedFromString('starfall'));
  assert.notEqual(seedFromString('a'), seedFromString('b'));
  assert.equal(dailySeed('2026-10-28'), dailySeed('2026-10-28'));
  assert.notEqual(dailySeed('2026-10-28'), dailySeed('2026-10-29'));
  assert.ok(Number.isInteger(dailySeed('2026-10-28')) && dailySeed('2026-10-28') >= 0);
  assert.throws(() => dailySeed('10/28/2026'));
});

const GOLDEN_12345 = [3011696732,1322452079,1156943195,3010002114,3863689114];
