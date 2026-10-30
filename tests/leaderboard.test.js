// Ported from an earlier version after a spec change; original in git history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeaderboard } from '../leaderboard/api.js';
import { memoryAdapter, localStorageAdapter } from '../leaderboard/storage.js';
import { leagueFor, trophyChange, seasonFor, seasonReset, SEASON_EPOCH_MS, SEASON_MS, listLeagues } from '../leaderboard/ranking.js';

const DAY = 86400000;
function setup(opts = {}) {
  const clock = { t: SEASON_EPOCH_MS + 3600000 };
  const storage = opts.storage || memoryAdapter();
  const lb = createLeaderboard({ storage, now: () => clock.t, verifyReplay: opts.verifyReplay });
  return { lb, clock, storage };
}
let replayCounter = 0;
const pidOf = (name) => `pid-${String(name ?? 'ann').toUpperCase().replace(/[^A-Z0-9_-]/g, 'x')}-0000`;
const run = (o = {}) => ({ game: 'starfall', name: 'ann', playerId: pidOf(o.name ?? 'ann'), score: 100, replay: `RPL${++replayCounter}`, seed: 7, mode: 'free', version: '1.0', ...o });
const code = (c) => (e) => e.code === c;

test('validation rejects bad input', async () => {
  const { lb } = setup();
  await assert.rejects(lb.submitScore(run({ replay: '' })), code('missing_replay'));
  await assert.rejects(lb.submitScore(run({ replay: undefined })), code('missing_replay'));
  await assert.rejects(lb.submitScore(run({ score: -1 })), code('bad_score'));
  await assert.rejects(lb.submitScore(run({ score: 1.5 })), code('bad_score'));
  await assert.rejects(lb.submitScore(run({ score: '5' })), code('bad_score'));
  await assert.rejects(lb.submitScore(run({ name: '' })), code('bad_name'));
  await assert.rejects(lb.submitScore(run({ name: 'ELEVENCHARS' })), code('bad_name'));
  await assert.rejects(lb.submitScore(run({ name: 'a_b' })), code('bad_name'));
  await assert.rejects(lb.submitScore(run({ mode: 'weekly' })), code('bad_mode'));
  await assert.rejects(lb.submitScore(run({ dayKey: 'today', mode: 'daily' })), code('bad_day'));
  await assert.rejects(lb.submitScore(null), code('bad_input'));
});

test('names are uppercased and valid punctuation accepted', async () => {
  const { lb } = setup();
  await lb.submitScore(run({ name: 'a.b-c 9' }));
  const b = await lb.getBoard({ game: 'starfall' });
  assert.equal(b[0].name, 'A.B-C 9');
});

test('board ordering, ranks, ties go to the earlier submission', async () => {
  const { lb, clock } = setup();
  await lb.submitScore(run({ name: 'AAA', score: 500 }));
  clock.t += 1000;
  await lb.submitScore(run({ name: 'BBB', score: 900 }));
  clock.t += 1000;
  await lb.submitScore(run({ name: 'CCC', score: 500 })); // ties AAA, later
  const b = await lb.getBoard({ game: 'starfall' });
  assert.deepEqual(b.map((e) => [e.rank, e.name, e.score]), [[1, 'BBB', 900], [2, 'AAA', 500], [3, 'CCC', 500]]);
  assert.deepEqual(Object.keys(b[0]).sort(), ['date', 'id', 'mode', 'name', 'rank', 'score']);
  const page = await lb.getBoard({ game: 'starfall', limit: 1, offset: 1 });
  assert.deepEqual(page.map((e) => e.name), ['AAA']);
  assert.equal(page[0].rank, 2);
});

test('placements reported on submit', async () => {
  const { lb } = setup();
  await lb.submitScore(run({ name: 'AAA', score: 500 }));
  const r = await lb.submitScore(run({ name: 'BBB', score: 800 }));
  assert.equal(r.placements.all, 1);
  assert.equal(r.placements.season, 1);
  assert.equal(r.placements.daily, undefined);
  const r2 = await lb.submitScore(run({ name: 'CCC', score: 500 }));
  assert.equal(r2.placements.all, 3); // ties lose to earlier AAA
});

test('daily boards are isolated by dayKey; free runs stay off them', async () => {
  const { lb } = setup();
  await lb.submitScore(run({ name: 'AAA', score: 300, mode: 'daily', dayKey: '2026-10-30' }));
  const r = await lb.submitScore(run({ name: 'BBB', score: 200, mode: 'daily', dayKey: '2026-10-31' }));
  await lb.submitScore(run({ name: 'CCC', score: 999, mode: 'free' }));
  assert.equal(r.placements.daily, 1);
  const d2 = await lb.getBoard({ game: 'starfall', board: 'daily', key: '2026-10-30' });
  const d3 = await lb.getBoard({ game: 'starfall', board: 'daily', key: '2026-10-31' });
  assert.deepEqual(d2.map((e) => e.name), ['AAA']);
  assert.deepEqual(d3.map((e) => e.name), ['BBB']);
  assert.equal((await lb.getBoard({ game: 'starfall' })).length, 3);
  assert.deepEqual(await lb.getBoard({ game: 'starfall', board: 'daily', key: '2026-12-01' }), []);
});

test('daily without dayKey defaults to the UTC day of the injected clock', async () => {
  const { lb } = setup();
  await lb.submitScore(run({ mode: 'daily' }));
  const b = await lb.getBoard({ game: 'starfall', board: 'daily', key: '2026-10-30' });
  assert.equal(b.length, 1);
});

test('games have separate boards', async () => {
  const { lb } = setup();
  await lb.submitScore(run({ game: 'starfall' }));
  assert.deepEqual(await lb.getBoard({ game: 'other' }), []);
});

test('season rollover with injected clock: new season board, seasonBest resets, trophies squash', async () => {
  const { lb, clock } = setup();
  assert.deepEqual(await lb.getSeason(clock.t), { id: 0, start: SEASON_EPOCH_MS, end: SEASON_EPOCH_MS + SEASON_MS });
  await lb.submitScore(run({ name: 'AAA', score: 1000 }));
  const s0 = await lb.getBoard({ game: 'starfall', board: 'season' });
  assert.equal(s0.length, 1);
  clock.t += SEASON_MS;
  assert.equal((await lb.getSeason()).id, 1);
  assert.deepEqual(await lb.getBoard({ game: 'starfall', board: 'season' }), []);
  assert.equal((await lb.getBoard({ game: 'starfall', board: 'season', key: 0 })).length, 1);
  assert.equal((await lb.getBoard({ game: 'starfall' })).length, 1); // all-time persists
  const rank = await lb.getRank({ game: 'starfall', playerId: pidOf('AAA') });
  assert.equal(rank.seasonBest, 0);
  assert.equal(rank.best, 1000);
  assert.equal(rank.season.id, 1);
  const r = await lb.submitScore(run({ name: 'AAA', score: 50 })); // lower than old best but new season best
  assert.ok(r.trophyDelta > 0, 'first run of a season counts as a season best');
});

test('season reset squashes trophies above the threshold only', () => {
  assert.equal(seasonReset(500), 500);
  assert.equal(seasonReset(1200), 1200);
  assert.equal(seasonReset(2000), 1600);
  assert.equal(seasonReset(3400), 2300);
  assert.equal(seasonFor(SEASON_EPOCH_MS - 1).id, -1);
  assert.equal(seasonFor(SEASON_EPOCH_MS + SEASON_MS - 1).id, 0);
  assert.equal(seasonFor(SEASON_EPOCH_MS + SEASON_MS).id, 1);
});

test('trophy squash is applied when a player skips seasons', async () => {
  const { lb, clock, storage } = setup();
  await storage.set(`player:starfall:${pidOf('AAA')}`, { name: 'AAA', trophies: 2000, season: 0, best: 10, seasonBest: 10 });
  clock.t += 2 * SEASON_MS;
  const rank = await lb.getRank({ game: 'starfall', playerId: pidOf('AAA') });
  assert.equal(rank.trophies, 500); // Best-5 rule: each reset keeps half, 2000 -> 1000 -> 500
});

test('trophy gain, loss, floor, and low-vs-high swing size', () => {
  const win = trophyChange({ trophies: 0, rank: 1, n: 1, score: 10, seasonBest: 0 });
  assert.equal(win.delta, 36); // was 57: solo rank 1 is now padded to a 5-player board (+16 not +30)
  const weak = trophyChange({ trophies: 1000, rank: 9, n: 10, score: 5, seasonBest: 100 });
  assert.equal(weak.delta, -6);
  const floor = trophyChange({ trophies: 2, rank: 9, n: 10, score: 5, seasonBest: 100 });
  assert.equal(floor.trophies, 0);
  assert.equal(floor.delta, -2);
  // Spec change: rank 1 with a score below your season best now earns 0 (was a gain).
  assert.equal(trophyChange({ trophies: 100, rank: 1, n: 10, score: 5, seasonBest: 100 }).delta, 0);
  // The swing-size comparison now needs a run that beats the personal best (score 500 vs best 100).
  const low = trophyChange({ trophies: 100, rank: 1, n: 10, score: 500, seasonBest: 100 }).delta;
  const high = trophyChange({ trophies: 3000, rank: 1, n: 10, score: 500, seasonBest: 100 }).delta;
  assert.ok(low > high && high > 0, `${low} > ${high}`);
  const lossLow = trophyChange({ trophies: 500, rank: 9, n: 10, score: 5, seasonBest: 100 }).delta;
  const lossHigh = trophyChange({ trophies: 3000, rank: 9, n: 10, score: 5, seasonBest: 100 }).delta;
  assert.ok(lossLow < lossHigh && lossHigh < 0);
  // Rank 9 of 10 (negative band) so the personal-best clamp on positive points does not mask the +8 bonus.
  const pb = trophyChange({ trophies: 1000, rank: 9, n: 10, score: 200, seasonBest: 100 });
  const nopb = trophyChange({ trophies: 1000, rank: 9, n: 10, score: 50, seasonBest: 100 });
  assert.equal(pb.delta - nopb.delta, 8);
});

test('trophies never go below 0 through the API', async () => {
  const { lb } = setup();
  await lb.submitScore(run({ name: 'TOP', score: 9999 }));
  await lb.submitScore(run({ name: 'MID', score: 5000 }));
  await lb.submitScore(run({ name: 'MID2', score: 4000 }));
  let r;
  for (let i = 0; i < 5; i++) r = await lb.submitScore(run({ name: 'LOW', score: 1 }));
  assert.ok(r.trophies >= 0);
  assert.ok((await lb.getRank({ game: 'starfall', playerId: pidOf('LOW') })).trophies >= 0);
});

test('league thresholds and sub-tiers', () => {
  const at = (t) => leagueFor(t).label;
  assert.equal(at(0), 'Bronze III');
  assert.equal(at(99), 'Bronze III');
  assert.equal(at(100), 'Bronze II');
  assert.equal(at(200), 'Bronze I');
  assert.equal(at(299), 'Bronze I');
  assert.equal(at(300), 'Silver III');
  assert.equal(at(750), 'Gold III');
  assert.equal(at(1049), 'Gold II');
  assert.equal(at(1050), 'Gold I');
  assert.equal(at(1200), 'Platinum III');
  assert.equal(at(1800), 'Diamond III');
  assert.equal(at(2399), 'Diamond I');
  assert.equal(at(2400), 'Master');
  assert.equal(leagueFor(2400).tier, null);
  assert.equal(at(3399), 'Master');
  assert.equal(at(3400), 'Legend');
  assert.equal(at(99999), 'Legend');
  assert.equal(listLeagues().map((l) => l.name).join(), 'Bronze,Silver,Gold,Platinum,Diamond,Master,Legend');
});

test('promotion flag is set and a submit never demotes (D31: a submit cannot lower the rating)', async () => {
  const { lb } = setup();
  const r = await lb.submitScore(run({ name: 'AAA', score: 10 })); // a lone player rates 750
  assert.equal(r.trophies, 750);
  assert.equal(r.promoted, true);
  assert.equal(r.from, 'Bronze III');
  assert.equal(r.league.label, 'Gold III');
  assert.equal(r.demoted, undefined);
});

test('verifyReplay: accepts a matching score, rejects a different one, rejects errors', async () => {
  const seen = [];
  const { lb } = setup({ verifyReplay: async (a) => { seen.push(a); return a.replay === 'GOOD' ? 123 : { score: 1 }; } });
  const ok = await lb.submitScore(run({ replay: 'GOOD', score: 123 }));
  assert.ok(ok.id);
  assert.equal(seen[0].seed, 7);
  await assert.rejects(lb.submitScore(run({ replay: 'GOOD', score: 124 })), code('replay_mismatch'));
  await assert.rejects(lb.submitScore(run({ replay: 'BAD', score: 123 })), code('replay_mismatch'));
  assert.equal((await lb.getBoard({ game: 'starfall' })).length, 1, 'rejected runs leave no trace');
  const { lb: lb2 } = setup({ verifyReplay: async () => { throw new Error('boom'); } });
  await assert.rejects(lb2.submitScore(run()), code('replay_error'));
});

test('replays are retrievable by id', async () => {
  const { lb } = setup();
  const r = await lb.submitScore(run({ replay: 'ABC', stats: { kills: 3 } }));
  const rep = await lb.getReplay(r.id);
  assert.equal(rep.replay, 'ABC');
  assert.equal(rep.score, 100);
  assert.deepEqual(rep.stats, { kills: 3 });
  assert.equal(await lb.getReplay('nope'), null);
});

test('getRank for an unknown player', async () => {
  const { lb } = setup();
  const r = await lb.getRank({ game: 'starfall', playerId: pidOf('new') });
  assert.deepEqual([r.trophies, r.league, r.tier, r.best, r.seasonBest], [0, 'Bronze', 'III', 0, 0]);
});

test('board keeps one best run per player by default, all runs with unique:false', async () => {
  const { lb } = setup();
  await lb.submitScore(run({ score: 100 }));
  await lb.submitScore(run({ score: 300 }));
  await lb.submitScore(run({ score: 200 }));
  assert.deepEqual((await lb.getBoard({ game: 'starfall' })).map((e) => e.score), [300]);
  assert.deepEqual((await lb.getBoard({ game: 'starfall', unique: false })).map((e) => e.score), [300, 200, 100]);
});

test('board cap keeps top 100 plus every player best', async () => {
  const { lb, storage } = setup();
  for (let i = 0; i < 105; i++) await lb.submitScore(run({ name: `P${i}`, score: 1000 + i }));
  const stored = await storage.get('board:starfall:all');
  assert.equal(stored.length, 105, 'every distinct player best survives');
  for (let i = 0; i < 120; i++) await lb.submitScore(run({ name: 'P0', score: 1 + (i % 3) }));
  const after = await storage.get('board:starfall:all');
  assert.ok(after.length <= 106 && after.length >= 105);
  assert.ok(after.some((e) => e.name === 'P0' && e.score === 1000));
});

test('corrupted storage recovers instead of throwing', async () => {
  const { lb, storage } = setup();
  await lb.submitScore(run({ name: 'AAA', score: 100 }));
  for (const k of await storage.keys('board:')) await storage.set(k, 'garbage');
  await storage.set(`player:starfall:${pidOf('AAA')}`, { trophies: 'lots' });
  await storage.set('seq', 'x');
  assert.deepEqual(await lb.getBoard({ game: 'starfall' }), []);
  assert.equal((await lb.getRank({ game: 'starfall', playerId: pidOf('AAA') })).trophies, 0);
  const r = await lb.submitScore(run({ name: 'AAA', score: 50 }));
  assert.equal(r.placements.all, 1);
  await storage.set('board:starfall:all', [null, 5, { id: 'x' }, ...(await storage.get('board:starfall:all'))]);
  assert.equal((await lb.getBoard({ game: 'starfall' })).length, 1, 'bad rows dropped, good rows kept');
});

test('localStorageAdapter: prefix, corrupt JSON, throwing backend falls back to memory', async () => {
  const data = new Map();
  const fake = {
    get length() { return data.size; },
    key: (i) => [...data.keys()][i] ?? null,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, v),
    removeItem: (k) => data.delete(k),
  };
  const ad = localStorageAdapter('t:', fake);
  await ad.set('a', { x: 1 });
  assert.equal(data.get('t:a'), '{"x":1}');
  assert.deepEqual(await ad.get('a'), { x: 1 });
  data.set('t:bad', '{not json');
  assert.equal(await ad.get('bad'), null);
  assert.deepEqual(await ad.keys(), ['a', 'bad']);
  await ad.remove('a');
  assert.equal(await ad.get('a'), null);

  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('x'); }, key() { throw new Error('x'); }, length: 1 };
  const mem = localStorageAdapter('t:', broken);
  await mem.set('k', [1, 2]);
  assert.deepEqual(await mem.get('k'), [1, 2]);
  assert.deepEqual(await mem.keys(), ['k']);
  await mem.remove('k');
  assert.equal(await mem.get('k'), null);

  const none = localStorageAdapter('t:'); // no localStorage in node
  await none.set('z', 1);
  assert.equal(await none.get('z'), 1);

  const { lb } = setup({ storage: localStorageAdapter('lb:', broken) });
  await lb.submitScore(run());
  assert.equal((await lb.getBoard({ game: 'starfall' })).length, 1);
});

test('concurrent submissions all get distinct ids and are all stored', async () => {
  const { lb } = setup();
  const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => lb.submitScore(run({ name: `N${i}`, score: i * 10 }))));
  assert.equal(new Set(rs.map((r) => r.id)).size, 5);
  assert.equal((await lb.getBoard({ game: 'starfall' })).length, 5);
});
