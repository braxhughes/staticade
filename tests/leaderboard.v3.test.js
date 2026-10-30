// Cross-instance locking, rollback, and boundary tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeaderboard } from '../leaderboard/api.js';
import { memoryAdapter, localStorageAdapter } from '../leaderboard/storage.js';
import { SEASON_EPOCH_MS, SEASON_MS } from '../leaderboard/ranking.js';

let n = 0;
const PID = 'player-lock-0001';
const run = (o = {}) => ({ game: 'g', name: 'ann', playerId: PID, score: 100, replay: `V3-${++n}`, seed: 1, mode: 'free', version: '1', ...o });
const code = (c) => (e) => e.code === c;
const T0 = SEASON_EPOCH_MS + 3600000; // 2026-10-30T01:00Z

test('two instances on one adapter, same replay at once: exactly one accepted', async () => {
  const st = memoryAdapter();
  const a = createLeaderboard({ storage: st, now: () => T0, instanceId: 'a' });
  const b = createLeaderboard({ storage: st, now: () => T0, instanceId: 'b' });
  const res = await Promise.allSettled([a.submitScore(run({ name: 'P', replay: 'DUP' })), b.submitScore(run({ name: 'Q', playerId: 'player-lock-0002', replay: 'DUP' }))]);
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 1);
  const rej = res.find((r) => r.status === 'rejected');
  assert.equal(rej.reason.code, 'duplicate_replay');
  assert.equal((await a.getBoard({ game: 'g' })).length, 1);
});

test('same playerId submitting 10 and 20 concurrently from two instances: seasonBest 20', async () => {
  for (let round = 0; round < 5; round++) {
    const st = memoryAdapter();
    const a = createLeaderboard({ storage: st, now: () => T0, instanceId: 'a' });
    const b = createLeaderboard({ storage: st, now: () => T0, instanceId: 'b' });
    await Promise.all([a.submitScore(run({ score: 10 })), b.submitScore(run({ score: 20 }))]);
    const r = await a.getRank({ game: 'g', playerId: PID });
    assert.equal(r.seasonBest, 20);
    assert.equal(r.best, 20);
  }
});

test('a failed player write rolls back board rows, replay and duplicate mark', async () => {
  const inner = memoryAdapter();
  let failPlayer = true;
  const st = { ...inner, async set(k, v) { if (failPlayer && k.startsWith('player:')) throw new Error('disk full'); return inner.set(k, v); } };
  const lb = createLeaderboard({ storage: st, now: () => T0 });
  await assert.rejects(lb.submitScore(run({ replay: 'ROLL' })), /disk full/);
  assert.deepEqual(await lb.getBoard({ game: 'g' }), []);
  assert.deepEqual(await lb.getBoard({ game: 'g', board: 'season' }), []);
  assert.deepEqual(await inner.keys('replay:'), []);
  assert.deepEqual(await inner.keys('rh:'), []);
  failPlayer = false;
  assert.ok((await lb.submitScore(run({ replay: 'ROLL' }))).id, 'same replay can be retried after rollback');
});

test('dayKey exactly 2 days from now is rejected; 1 day either side is accepted', async () => {
  const lb = createLeaderboard({ now: () => T0 });
  await assert.rejects(lb.submitScore(run({ mode: 'daily', dayKey: '2026-11-01' })), code('bad_day'));
  await assert.rejects(lb.submitScore(run({ mode: 'daily', dayKey: '2026-10-28' })), code('bad_day'));
  assert.ok((await lb.submitScore(run({ mode: 'daily', dayKey: '2026-10-31' }))).id);
  assert.ok((await lb.submitScore(run({ mode: 'daily', dayKey: '2026-10-29' }))).id);
});

test("the new season's rating starts at half and rises again after a new run", async () => {
  let t = T0;
  const lb = createLeaderboard({ now: () => t });
  let r = await lb.submitScore(run({ score: 100 }));
  assert.equal(r.trophies, 750);
  t += SEASON_MS;
  assert.equal((await lb.getRank({ game: 'g', playerId: PID })).trophies, 375, 'rollover keeps half');
  r = await lb.submitScore(run({ score: 5 }));
  assert.equal(r.trophyDelta, 375);
  assert.equal(r.trophies, 750, 'rises again after a new run');
});

test('adapters expose withLock that serialises callers; localStorage uses navigator.locks when present', async () => {
  for (const ad of [memoryAdapter(), localStorageAdapter('t:', { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 })]) {
    const order = [];
    await Promise.all([
      ad.withLock('x', async () => { order.push('a1'); await new Promise((r) => setTimeout(r, 10)); order.push('a2'); }),
      ad.withLock('x', async () => { order.push('b1'); order.push('b2'); }),
    ]);
    assert.deepEqual(order, ['a1', 'a2', 'b1', 'b2']);
  }
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const calls = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (name, fn) => { calls.push(name); return fn(); } } } });
  try {
    const ad = localStorageAdapter('p:', { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 });
    assert.equal(await ad.withLock('job', async () => 42), 42);
    assert.deepEqual(calls, ['p:job']);
  } finally {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc); else delete globalThis.navigator;
  }
});
