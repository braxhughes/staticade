// D1 storage adapter (server/d1-adapter.js) on the node:sqlite D1 shim: the leaderboard storage contract,
// the lease lock, result claims and rate counters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { d1Storage, claimResult, finishResult, releaseResult, hitRate, sweepRate, LockBusyError } from '../server/d1-adapter.js';
import { createLeaderboard } from '../leaderboard/api.js';
import { makeEnv } from '../server/fixtures.mjs';

test('get/set/remove/keys round-trip JSON; keys() matches a literal prefix (no LIKE wildcards)', async () => {
  const { DB } = await makeEnv();
  const s = d1Storage(DB);
  assert.equal(await s.get('nope'), null);
  await s.set("a'b", { x: 1, y: [1, 2], q: "it's" });
  assert.deepEqual(await s.get("a'b"), { x: 1, y: [1, 2], q: "it's" });
  await s.set("a'b", 7);
  assert.equal(await s.get("a'b"), 7);
  for (const k of ['board:sf:all', 'board:sf:daily:2026-10-29', 'board%x', 'board_y', 'player:sf:p']) await s.set(k, 1);
  assert.deepEqual(await s.keys('board:'), ['board:sf:all', 'board:sf:daily:2026-10-29']);
  assert.deepEqual(await s.keys('board%'), ['board%x']);
  assert.deepEqual(await s.keys('board_'), ['board_y']);
  await s.remove('board_y');
  assert.equal(await s.get('board_y'), null);
  DB.raw.prepare("INSERT INTO kv (k, v) VALUES ('bad', '{not json')").run();
  assert.equal(await s.get('bad'), null);
});

test('createLeaderboard on the D1 adapter ranks like the memory adapter', async () => {
  const { DB } = await makeEnv();
  const lb = createLeaderboard({ storage: d1Storage(DB), now: () => Date.UTC(2026, 10, 3) });
  const base = { game: 'starfall', seed: 1, mode: 'free', version: '2.5' };
  await lb.submitScore({ ...base, playerId: 'aaaaaaaa1', name: 'AAA', score: 100, replay: 'r-1' });
  await lb.submitScore({ ...base, playerId: 'bbbbbbbb1', name: 'BBB', score: 300, replay: 'r-2' });
  await lb.submitScore({ ...base, playerId: 'aaaaaaaa1', name: 'AAA', score: 200, replay: 'r-3' });
  assert.deepEqual((await lb.getBoard({ game: 'starfall' })).map((r) => [r.name, r.score]), [['BBB', 300], ['AAA', 200]]);
  await assert.rejects(lb.submitScore({ ...base, playerId: 'cccccccc1', name: 'CCC', score: 1, replay: 'r-2' }), { code: 'duplicate_replay' });
});

test('withLock: two holders never overlap; a held lock times out as busy; a dead holder\'s lease expires', async () => {
  const { DB } = await makeEnv();
  const s = d1Storage(DB, { pollMs: 2 });
  const log = [];
  const job = (n) => s.withLock('L', async () => { log.push(`in${n}`); await new Promise((r) => setTimeout(r, 15)); log.push(`out${n}`); return n; });
  assert.deepEqual(await Promise.all([job(1), job(2), job(3)]), [1, 2, 3]);
  for (let i = 0; i < log.length; i += 2) assert.equal(log[i].slice(2), log[i + 1].slice(3)); // in/out pairs, never interleaved
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM locks').get().n, 0); // released
  // someone else holds it (a lease that has not expired): busy
  let t = 1000;
  DB.raw.prepare("INSERT INTO locks (name, owner, until) VALUES ('L', 'ghost', 5000)").run();
  const short = d1Storage(DB, { now: () => t, waitMs: 30, pollMs: 5 });
  await assert.rejects(short.withLock('L', async () => 1), (e) => e instanceof LockBusyError && e.code === 'busy');
  t = 6000; // the ghost's lease ran out
  assert.equal(await short.withLock('L', async () => 'mine'), 'mine');
});

test('claimResult (Q22): one claim per game/board/hash/score; release frees it; a stale unfinished claim can be retaken', async () => {
  const { DB } = await makeEnv();
  const k = { game: 'starfall', board: 'free', hash: 'abc', score: 10 };
  assert.equal(await claimResult(DB, { ...k, t: 1000 }), true);
  assert.equal(await claimResult(DB, { ...k, t: 1001 }), false);
  assert.equal(await claimResult(DB, { ...k, board: 'daily:2026-10-29', t: 1001 }), true); // another board
  assert.equal(await claimResult(DB, { ...k, score: 11, t: 1001 }), true);                // another score
  await releaseResult(DB, k);
  assert.equal(await claimResult(DB, { ...k, t: 1002 }), true);
  assert.equal(await claimResult(DB, { ...k, t: 1002 + 60001 }), true);                     // unfinished and stale
  await finishResult(DB, { ...k, entry: 'id1' });
  assert.equal(await claimResult(DB, { ...k, t: 1e9 }), false);                             // finished: never retaken
  await releaseResult(DB, k);                                                              // release leaves a finished claim alone
  assert.equal(await claimResult(DB, { ...k, t: 2e9 }), false);
});

test('hitRate counts per key and window; sweepRate drops old windows', async () => {
  const { DB } = await makeEnv();
  const o = { limit: 3, windowMs: 1000 };
  const hits = [];
  for (let i = 0; i < 5; i++) hits.push(await hitRate(DB, 'ip:a', { ...o, t: 500 }));
  assert.deepEqual(hits.map((h) => [h.n, h.ok]), [[1, true], [2, true], [3, true], [4, false], [5, false]]);
  assert.equal(hits[4].retryAfter, 1);
  assert.equal((await hitRate(DB, 'ip:b', { ...o, t: 500 })).n, 1);
  assert.equal((await hitRate(DB, 'ip:a', { ...o, t: 1500 })).n, 1); // next window
  await sweepRate(DB, { windowMs: 1000, t: 3500 });
  assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM rate').get().n, 0);
});
