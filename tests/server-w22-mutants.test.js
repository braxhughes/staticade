// w22 continuation: tests for two mutants that survived the first table.
// (a) players.best upserted without MAX: a worse later run would lower the all-time best on /rank.
// (b) the board_replaced trigger: when a player's better run replaces their row, the old run's replay must go
//     once no board lists it (otherwise replays grow one per improvement, forever).
import test from 'node:test';
import assert from 'node:assert/strict';
import { GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { seasonFor } from '../leaderboard/ranking.js';
import { storeRun, readRank, readReplay, majorOf } from '../server/boards.js';
import { makeEnv } from '../server/fixtures.mjs';

const VER = majorOf(GAME_VERSION);
let k = 0;
async function put(env, pid, score, t) {
  const tag = `${pid}-${score}-${++k}`.toLowerCase();
  const run = { game: GAME_ID, pid, name: 'MUT', score, replay: `m${tag}`, seed: 2, mode: 'free', version: GAME_VERSION, stats: null };
  await storeRun(env.DB, { run, t, season: seasonFor(t).id, entry: `e-${tag}`, rhash: `h-${tag}` });
  return `e-${tag}`;
}
const count = (env, sql) => env.DB.raw.prepare(sql).get().n;

test('all-time best never goes down: a worse later run leaves /rank best at the higher score', async () => {
  const env = await makeEnv();
  const t = Date.now() - 10000;
  await put(env, 'mut-best-0001', 9000, t);
  await put(env, 'mut-best-0001', 4000, t + 1);
  const r = await readRank(env.DB, { game: GAME_ID, ver: VER, pid: 'mut-best-0001', season: seasonFor(t).id });
  assert.equal(r.best, 9000);
});

test('a better run that replaces a player row drops the old replay (no board lists it any more)', async () => {
  const env = await makeEnv();
  const t = Date.now() - 10000;
  const old = await put(env, 'mut-repl-0001', 1000, t);
  assert.ok(await readReplay(env.DB, old));
  const neu = await put(env, 'mut-repl-0001', 2000, t + 1);
  assert.equal(await readReplay(env.DB, old), null, 'old replay gone');
  assert.ok(await readReplay(env.DB, neu));
  assert.equal(count(env, 'SELECT COUNT(*) AS n FROM replays'), 1);
  assert.equal(count(env, 'SELECT COUNT(*) AS n FROM replays WHERE entry NOT IN (SELECT entry FROM board)'), 0);
});
