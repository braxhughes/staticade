// the best-5 trophy rule in leaderboard/ranking.js (pure) and in the browser's local leaderboard
// (leaderboard/api.js on the memory adapter, its JSON layout unchanged), plus the season epoch (launch day).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeaderboard, MAX_REPLAY_CHARS } from '../leaderboard/api.js';
import { memoryAdapter } from '../leaderboard/storage.js';
import { topRuns, average5, percentile, trophiesForPercentile, carryOver, seasonTrophies, seasonFor, leagueFor,
  SEASON_EPOCH_MS, SEASON_MS, TOP_RUNS, PHANTOMS } from '../leaderboard/ranking.js';

let n = 0;
const run = (o = {}) => ({ game: 'g', name: 'ann', playerId: `pid-${o.name ?? 'ann'}-w22`, score: 100, replay: `W22-${++n}`, seed: 1, mode: 'free', version: '1', ...o });
const T0 = SEASON_EPOCH_MS + 3600000;

test('LOW13: the season epoch is launch day, 2026-10-30 UTC; season 0 starts then', () => {
  assert.equal(new Date(SEASON_EPOCH_MS).toISOString(), '2026-10-30T00:00:00.000Z');
  assert.equal(seasonFor(Date.UTC(2026, 9, 30, 18)).id, 0);
  assert.equal(seasonFor(Date.UTC(2026, 9, 29, 23, 59)).id, -1);
  assert.equal(seasonFor(SEASON_EPOCH_MS + SEASON_MS).id, 1);
});

test('topRuns keeps the best 5, best first; a score equal to the 5th does not get in', () => {
  let t = [];
  for (const s of [500, 900, 700, 600, 800]) t = topRuns(t, s).top;
  assert.deepEqual(t, [900, 800, 700, 600, 500]);
  assert.deepEqual(topRuns(t, 450), { top: t, entered: false });
  assert.deepEqual(topRuns(t, 500), { top: t, entered: false });
  assert.deepEqual(topRuns(t, 1000), { top: [1000, 900, 800, 700, 600], entered: true });
  assert.equal(TOP_RUNS, 5);
  assert.deepEqual(topRuns([], 0), { top: [0], entered: true });
});

test('average5: missing runs count as 0; worked example 3 (700, then 800)', () => {
  assert.equal(average5([900, 800, 700, 600, 500]), 700);
  assert.equal(average5([1000, 900, 800, 700, 600]), 800);
  assert.equal(average5([1000]), 200);
  assert.equal(average5([]), 0);
  assert.equal(average5([7, 0, 0, 0, 0]), 1);
});

test('percentile with 20 imaginary players; worked examples 1 and 2; the league table', () => {
  assert.equal(PHANTOMS, 20);
  assert.equal(percentile({ below: 0, ties: 0, others: 0 }), 0.5);
  assert.equal(trophiesForPercentile(0.5), 750);
  assert.equal(leagueFor(750).label, 'Gold III');
  assert.equal(trophiesForPercentile(percentile({ below: 79, ties: 0, others: 99 })), 1391);
  for (const [p, t] of [[0, 0], [0.25, 300], [0.5, 750], [0.7, 1200], [0.85, 1800], [0.95, 2400], [0.99, 3400], [1, 3600]]) assert.equal(trophiesForPercentile(p), t, String(p));
  assert.equal(leagueFor(trophiesForPercentile(0.995)).name, 'Legend');
  assert.equal(leagueFor(trophiesForPercentile(0.10)).name, 'Bronze');
  // ties count half; never outside 0..1
  assert.equal(percentile({ below: 10, ties: 10, others: 30 }), (10 + 5 + 10) / 50);
  assert.equal(percentile({ below: 1e6, ties: 0, others: 1e6 }) <= 1, true);
});

test('carry: a reset keeps half; two seasons away a quarter; the rating replaces it only when higher', () => {
  assert.equal(carryOver(2000), 1000);
  assert.equal(carryOver(2000, 2), 500);
  assert.equal(carryOver(3, 1), 1);
  assert.equal(seasonTrophies({ rated: false, carry: 900 }), 900);
  assert.equal(seasonTrophies({ rated: true, below: 0, ties: 0, others: 0, carry: 900 }), 900); // 750 < 900
  assert.equal(seasonTrophies({ rated: true, below: 0, ties: 0, others: 0, carry: 100 }), 750);
});

test('local leaderboard: a run outside the best 5 changes nothing; a run inside raises the average; trophies never fall from your own run', async () => {
  const lb = createLeaderboard({ storage: memoryAdapter(), now: () => T0 });
  for (let i = 0; i < 10; i++) await lb.submitScore(run({ name: `F${i}`, score: 1000 * (i + 1) }));
  let last;
  for (const s of [3000, 4000, 5000, 6000, 7000]) {
    last = await lb.submitScore(run({ score: s }));
    assert.ok(last.trophyDelta >= 0);
  }
  const before = await lb.getRank({ game: 'g', playerId: 'pid-ann-w22' });
  assert.equal(before.avg5, 5000);
  assert.deepEqual(before.top5, [7000, 6000, 5000, 4000, 3000]);
  const weak = await lb.submitScore(run({ score: 2500 }));
  assert.equal(weak.rating.enteredTop5, false);
  assert.equal(weak.trophyDelta, 0);
  assert.equal(weak.trophies, last.trophies);
  const same = await lb.getRank({ game: 'g', playerId: 'pid-ann-w22' });
  assert.deepEqual([same.trophies, same.avg5, same.top5], [before.trophies, before.avg5, before.top5]);
  const strong = await lb.submitScore(run({ score: 20000 }));
  assert.equal(strong.rating.enteredTop5, true);
  assert.equal(strong.rating.avg5, Math.floor((20000 + 7000 + 6000 + 5000 + 4000) / 5));
  assert.ok(strong.trophyDelta >= 0 && strong.trophies >= before.trophies);
  // the 10 F players have avg5 = score / 5; ann's 8400 beats all ten
  assert.equal(strong.trophies, trophiesForPercentile(percentile({ below: 10, ties: 0, others: 10 })));
});

test('local leaderboard: season reset keeps half; a record saved before D31 keeps its trophies as a floor', async () => {
  const st = memoryAdapter();
  let t = T0;
  const lb = createLeaderboard({ storage: st, now: () => t });
  await st.set('player:g:pid-old-w22', { name: 'OLD', trophies: 1500, season: 0, best: 10, seasonBest: 10 }); // pre-best-5 shape
  const r0 = await lb.getRank({ game: 'g', playerId: 'pid-old-w22' });
  assert.equal(r0.trophies, 1500);
  assert.equal(r0.carry, 1500);
  const s = await lb.submitScore(run({ name: 'old', score: 1 }));
  assert.equal(s.trophyDelta, 0, 'alone is 750, below the 1500 floor');
  t += SEASON_MS;
  const r1 = await lb.getRank({ game: 'g', playerId: 'pid-old-w22' });
  assert.equal(r1.season.id, 1);
  assert.equal(r1.trophies, 750);
  assert.equal(r1.seasonBest, 0);
  assert.deepEqual(r1.top5, []);
});

test('the local API takes replays up to the new cap', async () => {
  const lb = createLeaderboard({ now: () => T0 });
  assert.ok((await lb.submitScore(run({ replay: 'x'.repeat(MAX_REPLAY_CHARS) }))).id);
  await assert.rejects(lb.submitScore(run({ replay: 'y'.repeat(MAX_REPLAY_CHARS + 1) })), (e) => e.code === 'replay_too_large');
});
