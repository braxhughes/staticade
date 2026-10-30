// players whose best-5 average is 0 are left out of the percentile field (server and local), so a
// pile of tiny runs (score 1..4 on the server, where score 0 is refused; score 0 locally) cannot lift anyone.
// A lone player is still Gold III (the 20 imaginary players), and a player at 0 is still rated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { seasonFor, trophiesForPercentile, percentile, SEASON_EPOCH_MS } from '../leaderboard/ranking.js';
import { storeRun, ratingOf, majorOf } from '../server/boards.js';
import { createLeaderboard } from '../leaderboard/api.js';
import { memoryAdapter } from '../leaderboard/storage.js';
import { makeEnv } from '../server/fixtures.mjs';

const VER = majorOf(GAME_VERSION);
async function seed(env, list, t) {
  for (const [p, score] of list) {
    t += 1;
    const run = { game: GAME_ID, pid: p, name: 'BOT', score, replay: `g${p}${score}${t}`, seed: 2, mode: 'free', version: GAME_VERSION, stats: null };
    await storeRun(env.DB, { run, t, season: seasonFor(t).id, entry: `g-${p}-${score}-${t}`.toLowerCase(), rhash: `gh-${p}-${score}-${t}`.toLowerCase() });
  }
  return t;
}
const rate = (env, pid, t) => ratingOf(env.DB, { game: GAME_ID, ver: VER, pid, season: seasonFor(t).id });

test('server: 50 griefer players with avg5 0 (one run of score 4 each) do not move a real player', async () => {
  const env = await makeEnv();
  let t = Date.now() - 100000;
  t = await seed(env, [0, 1, 2, 3].map((i) => [`real-${i}-000`, 3000]), t); // avg5 600 each
  t = await seed(env, [['bob-real-0001', 4500]], t); // avg5 900
  const before = await rate(env, 'bob-real-0001', t);
  assert.equal(before.trophies, trophiesForPercentile(percentile({ below: 4, ties: 0, others: 4 })));
  t = await seed(env, Array.from({ length: 50 }, (_, i) => [`grief-${String(i).padStart(4, '0')}`, 4]), t);
  const after = await rate(env, 'bob-real-0001', t);
  assert.equal(after.trophies, before.trophies, 'zero averages are not in the field');
  assert.equal(after.percentile, before.percentile);
  assert.equal(after.players, 55, 'head count still includes them');
  // a griefer is still rated: against the 5 real players, all above it
  const g = await rate(env, 'grief-0000', t);
  assert.equal(g.rated, true);
  assert.equal(g.trophies, trophiesForPercentile(percentile({ below: 0, ties: 0, others: 5 })));
});

test('server: a lone player is Gold III (750), whether the average is 0 or not', async () => {
  const env = await makeEnv();
  let t = Date.now() - 1000;
  t = await seed(env, [['lone-pos-0001', 5000]], t);
  assert.equal((await rate(env, 'lone-pos-0001', t)).trophies, 750);
  const env2 = await makeEnv();
  t = await seed(env2, [['lone-zero-001', 3]], t);
  assert.equal((await rate(env2, 'lone-zero-001', t)).trophies, 750);
});

test('local: score-0 runs by many other players do not lift anyone; a lone player is 750', async () => {
  let clock = SEASON_EPOCH_MS + 3600000;
  let k = 0;
  const lb = createLeaderboard({ storage: memoryAdapter(), now: () => clock++ });
  const run = (o) => ({ game: 'g', name: 'AAA', score: 100, replay: `GR-${++k}`, seed: 1, mode: 'free', version: '1', ...o });
  const alone = await lb.submitScore(run({ playerId: 'alone-player-1', score: 500 }));
  assert.equal(alone.trophies, 750);
  for (let i = 0; i < 3; i++) await lb.submitScore(run({ playerId: `real-player-${i}`, score: 100 }));
  const before = (await lb.getRank({ game: 'g', playerId: 'alone-player-1' })).trophies;
  for (let i = 0; i < 30; i++) await lb.submitScore(run({ playerId: `griefer-pl-${i}`, score: 0 }));
  const r = await lb.getRank({ game: 'g', playerId: 'alone-player-1' });
  assert.equal(r.trophies, before);
  assert.equal(r.players, 34, 'head count includes the zero averages');
});
