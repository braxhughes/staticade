// Review-fix tests (playerId, anti-farming, replay retention, ids, validation, caps).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeaderboard, hashReplay, MAX_REPLAY_CHARS } from '../leaderboard/api.js';
import { memoryAdapter, localStorageAdapter, getLocalPlayerId } from '../leaderboard/storage.js';
import { trophyChange, placementPoints, SEASON_EPOCH_MS, SEASON_MS, SEASON_GAIN_CAP, leagueFor } from '../leaderboard/ranking.js';

let n = 0;
const pid = (name) => `pid-${name}-0000`.slice(0, 40);
const run = (o = {}) => ({ game: 'g', name: 'ann', playerId: pid(o.name || 'ann'), score: 100, replay: `RP${++n}`, seed: 1, mode: 'free', version: '1', ...o });
const code = (c) => (e) => e.code === c;
function setup(opts = {}) {
  const clock = { t: SEASON_EPOCH_MS + 3600000 };
  const storage = opts.storage || memoryAdapter();
  const lb = createLeaderboard({ storage, now: () => clock.t, verifyReplay: opts.verifyReplay, instanceId: opts.instanceId });
  return { lb, clock, storage };
}
const fill = async (lb, count, base = 1000) => { for (let i = 0; i < count; i++) await lb.submitScore(run({ name: `F${i}`, score: base + i })); };

test('farming: a solo player resubmitting is rejected as duplicate_replay', async () => {
  const { lb } = setup();
  await lb.submitScore(run({ score: 5, replay: 'SAME' }));
  await assert.rejects(lb.submitScore(run({ score: 5, replay: 'SAME' })), code('duplicate_replay'));
  await assert.rejects(lb.submitScore(run({ name: 'bob', score: 5, replay: 'SAME' })), code('duplicate_replay'));
});

test('farming: 300 runs by a solo player stay at 750', async () => {
  const { lb } = setup();
  let r;
  for (let i = 0; i < 300; i++) r = await lb.submitScore(run({ score: i + 1 })); // every run is a new best
  assert.equal(r.trophies, 750, `got ${r.trophies}`);
});

test('farming: #1 player resubmitting low scores gains nothing', async () => {
  const { lb } = setup();
  await lb.submitScore(run({ name: 'TOP', score: 1000 }));
  await lb.submitScore(run({ name: 'TWO', score: 10 }));
  const base = (await lb.getRank({ game: 'g', playerId: pid('TOP') })).trophies;
  let r;
  for (let i = 0; i < 20; i++) r = await lb.submitScore(run({ name: 'TOP', score: 11 + i }));
  assert.equal(r.trophies, base);
  assert.equal(r.trophyDelta, 0);
});

test('ranking: positive points need a personal best; weak runs still lose', () => {
  const repeat = trophyChange({ trophies: 1000, rank: 1, n: 10, score: 5, seasonBest: 100 });
  assert.equal(repeat.delta, 0);
  const weak = trophyChange({ trophies: 1000, rank: 9, n: 10, score: 5, seasonBest: 100 });
  assert.equal(weak.delta, -6);
  const best = trophyChange({ trophies: 1000, rank: 3, n: 10, score: 200, seasonBest: 100 });
  assert.equal(best.delta, 18);
});

test('ranking: boards under 5 are padded, rank 1 of 1 is not worth +30', () => {
  assert.equal(placementPoints(1, 1), 16);
  assert.equal(placementPoints(1, 4), 16);
  assert.equal(placementPoints(2, 4), 10); // p = 1/5
  assert.equal(placementPoints(1, 5), 30);
  assert.equal(trophyChange({ trophies: 0, rank: 1, n: 1, score: 1, seasonBest: null }).delta, 36);
});

test('ranking: every placement band (n=20)', () => {
  const pts = (r) => placementPoints(r, 20);
  assert.equal(pts(1), 30);
  assert.equal(pts(2), 16); // p = .05
  assert.equal(pts(3), 10); // p = .10 boundary moves up a band
  assert.equal(pts(5), 10); // p = .20
  assert.equal(pts(6), 3); // p = .25
  assert.equal(pts(10), 3); // p = .45
  assert.equal(pts(11), -3); // p = .50
  assert.equal(pts(15), -3); // p = .70
  assert.equal(pts(16), -6); // p = .75
  assert.equal(pts(20), -6);
});

test('ranking: season gain cap clips gains only', () => {
  assert.equal(trophyChange({ trophies: 500, rank: 1, n: 10, score: 9, seasonBest: 1, seasonGain: SEASON_GAIN_CAP - 5 }).delta, 5);
  assert.equal(trophyChange({ trophies: 500, rank: 1, n: 10, score: 9, seasonBest: 1, seasonGain: SEASON_GAIN_CAP }).delta, 0);
  assert.ok(trophyChange({ trophies: 500, rank: 10, n: 10, score: 1, seasonBest: 9, seasonGain: SEASON_GAIN_CAP }).delta < 0);
  assert.equal(leagueFor(0).label, 'Bronze III');
});

test('identity: players are keyed by playerId; the name is only a label', async () => {
  const { lb } = setup();
  await lb.submitScore(run({ name: 'BOB', playerId: 'player-one-aaaa', score: 50 }));
  await lb.submitScore(run({ name: 'BOB', playerId: 'player-two-bbbb', score: 60 }));
  const b = await lb.getBoard({ game: 'g' });
  assert.equal(b.length, 2, 'same label, two players');
  const one = await lb.getRank({ game: 'g', playerId: 'player-one-aaaa' });
  assert.equal(one.best, 50);
});

test('identity: griefing under someone else name does not touch their trophies', async () => {
  const { lb } = setup();
  await fill(lb, 4, 600);
  await lb.submitScore(run({ name: 'BOB', playerId: 'bob-real-0001', score: 900 }));
  const before = (await lb.getRank({ game: 'g', playerId: 'bob-real-0001' })).trophies;
  for (let i = 0; i < 20; i++) await lb.submitScore(run({ name: 'BOB', playerId: 'griefer-0002', score: 0 }));
  assert.equal((await lb.getRank({ game: 'g', playerId: 'bob-real-0001' })).trophies, before);
});

test('identity: playerId is required and validated; getLocalPlayerId is stable', async () => {
  const { lb, storage } = setup();
  await assert.rejects(lb.submitScore(run({ playerId: undefined })), code('bad_player'));
  await assert.rejects(lb.submitScore(run({ playerId: 'short' })), code('bad_player'));
  await assert.rejects(lb.getRank({ game: 'g', name: 'ann' }), code('bad_player'));
  const a = await getLocalPlayerId(storage);
  assert.equal(await getLocalPlayerId(storage), a);
  assert.match(a, /^[A-Za-z0-9_-]{8,64}$/);
  await storage.set('playerId', 'bad id!');
  assert.notEqual(await getLocalPlayerId(storage), 'bad id!');
});

test('retention: replay survives while an old-season board and a daily board still list it', async () => {
  const { lb, clock } = setup();
  const first = await lb.submitScore(run({ name: 'X', score: 1, mode: 'daily', dayKey: '2026-10-30' }));
  clock.t += SEASON_MS; // season 1: 'all' board churns, old boards untouched
  for (let i = 0; i < 110; i++) await lb.submitScore(run({ name: `Y${i}`, score: 1000 + i }));
  await lb.submitScore(run({ name: 'X', score: 5 })); // X now has a better run, the old one falls off 'all'
  const all = await lb.getBoard({ game: 'g', limit: 100, unique: false });
  assert.ok(!all.some((e) => e.id === first.id), 'dropped from all board');
  const d = await lb.getBoard({ game: 'g', board: 'daily', key: '2026-10-30', unique: false });
  const s0 = await lb.getBoard({ game: 'g', board: 'season', key: 0, unique: false });
  assert.deepEqual([d.length, s0.length], [1, 1]);
  assert.equal((await lb.getReplay(first.id))?.id, first.id, 'still referenced by daily + season 0');
});

test('retention: replay removed once the last board stops listing it', async () => {
  const { lb, storage } = setup();
  const old = await lb.submitScore(run({ name: 'X', score: 1 }));
  assert.ok(await lb.getReplay(old.id));
  await storage.remove('board:g:all');
  await storage.remove(`board:g:season:0`);
  await lb.submitScore(run({ name: 'X', score: 2 })); // fresh boards, 'old' no longer listed anywhere, nothing to clean
  // Direct drop path: exceed the cap with distinct players so the earliest low run is trimmed everywhere.
  const { lb: lb2 } = setup();
  const low = await lb2.submitScore(run({ name: 'LOW', score: 1 }));
  for (let i = 0; i < 101; i++) await lb2.submitScore(run({ name: `H${i}`, score: 100 + i }));
  await lb2.submitScore(run({ name: 'LOW', score: 2 })); // LOW's best is now 2, run 'low' (score 1) is no longer a best
  await lb2.submitScore(run({ name: 'LOW', score: 3 }));
  assert.equal(await lb2.getReplay(low.id), null, 'trimmed from all and season: no references left');
});

test('ids: no collision if the sequence key is lost, or across two instances on one storage', async () => {
  const st = memoryAdapter();
  const a = await createLeaderboard({ storage: st, now: () => SEASON_EPOCH_MS, instanceId: 'a' }).submitScore(run({ name: 'OLD', score: 500 }));
  await st.remove('seq');
  const b = await createLeaderboard({ storage: st, now: () => SEASON_EPOCH_MS, instanceId: 'b' }).submitScore(run({ name: 'NEW', score: 500 }));
  assert.notEqual(a.id, b.id);
  const l1 = createLeaderboard({ storage: st, now: () => SEASON_EPOCH_MS, instanceId: 'c' });
  const l2 = createLeaderboard({ storage: st, now: () => SEASON_EPOCH_MS, instanceId: 'd' });
  const rs = await Promise.all([l1.submitScore(run({ name: 'P', score: 1 })), l2.submitScore(run({ name: 'Q', score: 2 }))]);
  assert.notEqual(rs[0].id, rs[1].id);
  const board = await l1.getBoard({ game: 'g', limit: 100 });
  assert.ok(board.some((e) => e.name === 'P') && board.some((e) => e.name === 'Q'));
  assert.equal((await l1.getReplay(a.id)).name, 'OLD', 'old replay not overwritten');
});

test('ids: ties still go to the earlier submission using the stored timestamp', async () => {
  const { lb, clock } = setup();
  await lb.submitScore(run({ name: 'AAA', score: 500 }));
  clock.t += 5;
  await lb.submitScore(run({ name: 'BBB', score: 500 }));
  assert.deepEqual((await lb.getBoard({ game: 'g' })).map((e) => e.name), ['AAA', 'BBB']);
});

test('dayKey: must be a real date and near today without a verifier', async () => {
  const { lb } = setup();
  for (const k of ['9999-99-99', '2026-02-31', '2026-13-01']) await assert.rejects(lb.submitScore(run({ mode: 'daily', dayKey: k })), code('bad_day'));
  await assert.rejects(lb.submitScore(run({ mode: 'daily', dayKey: '2099-01-01' })), code('bad_day'));
  await assert.rejects(lb.submitScore(run({ mode: 'daily', dayKey: '2026-10-01' })), code('bad_day'));
  const ok = await lb.submitScore(run({ mode: 'daily', dayKey: '2026-10-31' })); // yesterday: allowed
  assert.ok(ok.id);
  await assert.rejects(lb.getBoard({ game: 'g', board: 'daily', key: '9999-99-99' }), code('bad_board'));
});

test('dayKey: with a verifier any real date is allowed', async () => {
  const { lb } = setup({ verifyReplay: async () => 5 });
  const r = await lb.submitScore(run({ score: 5, mode: 'daily', dayKey: '2026-06-01' }));
  assert.equal(r.placements.daily, 1);
});

test('caps: unsafe scores, oversize replays', async () => {
  const { lb } = setup();
  await assert.rejects(lb.submitScore(run({ score: 1e300 })), code('bad_score'));
  await assert.rejects(lb.submitScore(run({ score: Number.MAX_SAFE_INTEGER + 2 })), code('bad_score'));
  await assert.rejects(lb.submitScore(run({ replay: 'x'.repeat(MAX_REPLAY_CHARS + 1) })), code('replay_too_large'));
  assert.ok((await lb.submitScore(run({ score: Number.MAX_SAFE_INTEGER, replay: 'x'.repeat(MAX_REPLAY_CHARS) }))).id);
});

test('degraded storage is exposed on the adapter and in submit results', async () => {
  const broken = { getItem() { return null; }, setItem() { throw new Error('quota'); }, removeItem() {}, key() { return null; }, length: 0 };
  const ad = localStorageAdapter('d:', broken);
  assert.equal(ad.degraded, false);
  const { lb } = setup({ storage: ad });
  const r = await lb.submitScore(run());
  assert.equal(ad.degraded, true);
  assert.equal(r.storageDegraded, true);
  const { lb: lb2 } = setup();
  assert.equal((await lb2.submitScore(run())).storageDegraded, undefined);
});

test('first run of a season gets the first-run bonus even with score 0', async () => {
  const { lb } = setup();
  const r = await lb.submitScore(run({ score: 0 }));
  assert.ok(r.trophyDelta > 0);
  const r2 = await lb.submitScore(run({ score: 0 }));
  assert.ok(r2.trophyDelta <= 0, 'a second zero is not a new best');
});

test('clock going backwards never lowers the stored season or double squashes', async () => {
  const { lb, clock, storage } = setup();
  clock.t = SEASON_EPOCH_MS + SEASON_MS + 5;
  await storage.set(`player:g:${pid('Z')}`, { name: 'Z', trophies: 2000, season: 1, best: 0, seasonBest: null });
  clock.t = SEASON_EPOCH_MS + 5;
  await lb.submitScore(run({ name: 'Z', score: 1 }));
  assert.equal((await storage.get(`player:g:${pid('Z')}`)).season, 1);
  clock.t = SEASON_EPOCH_MS + SEASON_MS + 10;
  assert.ok((await lb.getRank({ game: 'g', playerId: pid('Z') })).trophies >= 1900, 'not squashed again');
});

test('getBoard rejects NaN, null, negative and fractional paging, and junk season keys', async () => {
  const { lb } = setup();
  for (const o of [{ limit: NaN }, { limit: null }, { offset: NaN }, { offset: -1 }, { limit: 1.5 }, { limit: '5' }]) {
    await assert.rejects(lb.getBoard({ game: 'g', ...o }), code('bad_board'));
  }
  await assert.rejects(lb.getBoard({ game: 'g', board: 'season', key: 'zz' }), code('bad_board'));
  assert.deepEqual(await lb.getBoard({ game: 'g', board: 'season', key: '0' }), []);
});

test('names: ASCII only and at least one letter or digit', async () => {
  const { lb } = setup();
  for (const name of ['ßß', '..', '   ', '-', 'ÀB', 'ａｂ']) await assert.rejects(lb.submitScore(run({ name, playerId: 'valid-pid-0001' })), code('bad_name'));
  assert.ok((await lb.submitScore(run({ name: 'a.', playerId: 'valid-pid-0001' }))).id);
});

test('hashReplay is stable and differs for different replays', () => {
  assert.equal(hashReplay('abc'), hashReplay('abc'));
  assert.notEqual(hashReplay('abc'), hashReplay('abd'));
});
