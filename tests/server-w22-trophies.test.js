// w22 MED7 on the server: trophies from the average of a player's best 5 runs this season, rated against
// everyone (percentile -> league and tier). A run outside the best 5 changes nothing; a season reset keeps half.
// Real runs through worker.fetch where a few are enough; seeding many players goes through storeRun directly.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { seasonFor, leagueFor, trophiesForPercentile, percentile, carryOver, SEASON_EPOCH_MS, SEASON_MS } from '../leaderboard/ranking.js';
import { storeRun, ratingOf, majorOf } from '../server/boards.js';
import { playScripted, makeEnv, post, get, createWorker } from '../server/fixtures.mjs';

let RUNS; // six honest, different runs on seed 2, best first
let n = 0;
const pid = () => `w22-troph-${String(++n).padStart(5, '0')}`;
const ip = () => `198.21.${(n >> 8) & 255}.${n & 255}`;
const body = (run, over = {}) => ({ game: GAME_ID, playerId: pid(), name: 'TRO', score: run.score, replay: run.replay, seed: 2, mode: 'free', version: GAME_VERSION, ...over });
const VER = majorOf(GAME_VERSION);

before(() => {
  RUNS = [21, 22, 23, 24, 25, 26, 27, 28].map((k) => playScripted(2, k * 7919, 'script'))
    .filter((r, i, a) => r.score > 0 && a.findIndex((x) => x.score === r.score) === i).sort((a, b) => b.score - a.score).slice(0, 6);
});

async function seed(env, list, t) {
  for (const [p, score] of list) {
    t += 1;
    const run = { game: GAME_ID, pid: p, name: 'BOT', score, replay: `x${p}${score}${t}`, seed: 2, mode: 'free', version: GAME_VERSION, stats: null };
    await storeRun(env.DB, { run, t, season: seasonFor(t).id, entry: `e-${p}-${score}-${t}`.toLowerCase(), rhash: `h-${p}-${score}-${t}`.toLowerCase() });
  }
  return t;
}

test('/rank shows league and tier from the best-5 average rated against everyone; submit answers carry the rating', async () => {
  assert.equal(RUNS.length, 6, 'six distinct honest runs');
  const env = await makeEnv();
  const W = createWorker();
  // 40 others this season, scores 1,000 .. 40,000 a run (five runs each, so avg5 = the score)
  let t = Date.now() - 1000;
  const others = [];
  for (let i = 0; i < 40; i++) for (let k = 0; k < 5; k++) others.push([`other-${String(i).padStart(4, '0')}`, 1000 * (i + 1) + k * 0]);
  t = await seed(env, others.map(([p, s], j) => [p, s + (j % 5)]), t); // five slightly different runs each
  const me = pid();
  const r = await post(W, env, body(RUNS[0], { playerId: me }), { ip: ip() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const avg = Math.floor(RUNS[0].score / 5);
  assert.equal(r.body.rating.avg5, avg);
  assert.deepEqual(r.body.rating.top5, [RUNS[0].score]);
  assert.equal(r.body.rating.enteredTop5, true);
  const below = Array.from({ length: 40 }, (_, i) => 1000 * (i + 1) + 2).filter((a) => a < avg).length; // others' avg5 = 1000(i+1)+2
  const want = trophiesForPercentile(percentile({ below, ties: 0, others: 40 }));
  assert.equal(r.body.trophies, want);
  assert.equal(r.body.trophyDelta, want, 'from 0 (no run yet) to the rating');
  assert.deepEqual(r.body.league, { name: leagueFor(want).name, tier: leagueFor(want).tier, label: leagueFor(want).label });
  const rk = await get(W, env, `/rank?game=starfall&playerId=${me}`);
  assert.equal(rk.status, 200);
  assert.equal(rk.body.trophies, want);
  assert.equal(rk.body.league, leagueFor(want).name);
  assert.equal(rk.body.tier, leagueFor(want).tier);
  assert.equal(rk.body.avg5, avg);
  assert.deepEqual(rk.body.top5, [RUNS[0].score]);
  assert.equal(rk.body.players, 41);
  assert.equal(rk.body.best, RUNS[0].score);
  assert.equal(rk.body.seasonBest, RUNS[0].score);
  assert.equal(rk.body.season.id, seasonFor(Date.now()).id);
  // an unknown player: Bronze III, 0
  const nobody = (await get(W, env, '/rank?game=starfall&playerId=nobody-at-all-1')).body;
  assert.deepEqual([nobody.trophies, nobody.league, nobody.tier, nobody.best, nobody.avg5], [0, 'Bronze', 'III', 0, 0]);
});

test('a run that does not enter the best 5 changes nothing (real runs through the Worker); one that does can only raise it', async () => {
  const env = await makeEnv();
  const W = createWorker();
  let t = Date.now() - 1000;
  t = await seed(env, Array.from({ length: 30 }, (_, i) => [`field-${String(i).padStart(4, '0')}`, 2000 * (i + 1)]), t);
  const me = pid();
  let last;
  for (const r of RUNS.slice(0, 5)) {
    const res = await post(W, env, body(r, { playerId: me }), { ip: ip() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.trophyDelta >= 0, 'your own run never costs trophies');
    last = res.body;
  }
  const before = (await get(W, env, `/rank?game=starfall&playerId=${me}`)).body;
  assert.equal(before.top5.length, 5);
  // the sixth run is the weakest of the six: not in the best 5
  const sixth = await post(W, env, body(RUNS[5], { playerId: me }), { ip: ip() });
  assert.equal(sixth.status, 201);
  assert.equal(sixth.body.rating.enteredTop5, false);
  assert.equal(sixth.body.trophyDelta, 0);
  assert.equal(sixth.body.trophies, last.trophies);
  const after = (await get(W, env, `/rank?game=starfall&playerId=${me}`)).body;
  assert.deepEqual([after.trophies, after.avg5, after.top5], [before.trophies, before.avg5, before.top5]);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM season_runs WHERE pid = ?').get(me).n, 5, 'the sixth is trimmed in the same batch');
});

test('season boundary: a new season has its own board; trophies start at half of last season and the new rating replaces it once higher', async () => {
  const env = await makeEnv();
  const W = createWorker();
  const end0 = SEASON_EPOCH_MS + SEASON_MS - 5000; // the last seconds of season 0
  let t = await seed(env, [...Array.from({ length: 50 }, (_, i) => [`s0-${String(i).padStart(4, '0')}`, 100 + i]), ['s0-star-00001', 90000]], end0);
  const last = await ratingOf(env.DB, { game: GAME_ID, ver: VER, pid: 's0-star-00001', season: 0 });
  assert.equal(last.trophies, trophiesForPercentile(percentile({ below: 50, ties: 0, others: 50 }))); // top of 51: Diamond
  assert.equal(leagueFor(last.trophies).name, 'Diamond');
  const s1 = SEASON_EPOCH_MS + SEASON_MS + 1000;
  const Wn = createWorker({ now: () => s1 });
  const rk = (await get(Wn, env, '/rank?game=starfall&playerId=s0-star-00001')).body;
  assert.equal(rk.season.id, 1);
  assert.equal(rk.carry, carryOver(last.trophies));
  assert.equal(rk.trophies, Math.floor(last.trophies / 2), 'keeps half');
  assert.deepEqual(rk.top5, []);
  assert.deepEqual((await get(Wn, env, '/board?game=starfall&board=season')).body.rows, [], 'season 1 board is empty');
  assert.equal((await get(Wn, env, '/board?game=starfall&board=season&key=0')).body.rows[0].score, 90000);
  assert.equal((await get(Wn, env, '/board?game=starfall')).body.rows[0].score, 90000, 'all-time keeps it');
  // a weak first run of the new season: rated alone (Gold III) is below the carry, so the carry holds
  t = await seed(env, [['s0-star-00001', 5]], s1);
  const r1 = await ratingOf(env.DB, { game: GAME_ID, ver: VER, pid: 's0-star-00001', season: 1 });
  assert.equal(r1.trophies, Math.max(Math.floor(last.trophies / 2), trophiesForPercentile(0.5)));
  // two seasons away: a quarter
  const s3 = SEASON_EPOCH_MS + 3 * SEASON_MS + 1000;
  const far = (await get(createWorker({ now: () => s3 }), env, '/rank?game=starfall&playerId=s0-2nd-player1')).body;
  assert.equal(far.trophies, 0, 'never played: nothing to carry');
  void W; void t;
});

test('13,000 rated players in a season: /rank and a submit stay fast (the percentile count is an index-only walk of one season)', async () => {
  const env = await makeEnv();
  const season = seasonFor(Date.now()).id;
  const ins = env.DB.raw.prepare('INSERT INTO ratings (game, ver, season, pid, avg5, carry) VALUES (?, ?, ?, ?, ?, 0)');
  env.DB.raw.exec('BEGIN');
  for (let i = 0; i < 13000; i++) ins.run(GAME_ID, VER, season, `bulk-${String(i).padStart(6, '0')}`, (i * 7919) % 100000);
  env.DB.raw.exec('COMMIT');
  const W = createWorker();
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) assert.equal((await get(W, env, '/rank?game=starfall&playerId=bulk-000123')).status, 200);
  const rankMs = (performance.now() - t0) / 20;
  const t1 = performance.now();
  await seed(env, Array.from({ length: 20 }, (_, i) => [`bulk-new-${String(i).padStart(4, '0')}`, 50000 + i]), Date.now());
  const submitMs = (performance.now() - t1) / 20;
  assert.ok(rankMs < 25 && submitMs < 50, `rank ${rankMs.toFixed(2)} ms, store ${submitMs.toFixed(2)} ms`);
  const r = (await get(W, env, '/rank?game=starfall&playerId=bulk-000123')).body;
  assert.equal(r.players, 13020);
});
