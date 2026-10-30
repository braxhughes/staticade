// w29 fix 2 (MED-1): the Worker keeps /board windows in Cloudflare's edge cache (caches.default). An accepted submit,
// an admin release and an admin hide must purge every cached window of every board the run is on, before the
// answer goes back, so the player's next read shows the new board. A held (202) or refused submit changes no board
// and purges nothing. Through the real entry point worker.fetch on the node:sqlite D1 shim, with a fake
// caches.default (a Map keyed by URL, as the real one is).
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from '../engine/replay.js';
import { dailySeed } from '../engine/rng.js';
import { GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { seasonFor } from '../leaderboard/ranking.js';
import { storeRun, majorOf } from '../server/boards.js';
import { record, playScripted, makeEnv, post, get, createWorker } from '../server/fixtures.mjs';

const H = 3600000;
const D = '2026-11-02', T = Date.parse(D + 'T00:00:00Z') + 12 * H; // the Worker's clock: noon UTC on day D
const TOKEN = 'w29-purge-admin-token-0123456789';
let n = 0;
const pid = () => `w29-purge-${String(++n).padStart(4, '0')}`;
const ip = () => `198.18.9.${(n % 250) + 1}`;
let VICTIM, DAILY, COPY;
before(() => {
  VICTIM = record('arcade', 2);
  DAILY = playScripted(dailySeed(D), 7, 'script', 'daily');
  // a near copy of VICTIM (about 70% alike, as in tests/server-dedupe.test.js): held for review, not stored
  COPY = playScripted(2, 12 * 7919 + 2300, 'script', 'arcade', decode(VICTIM.replay).words.slice(0, 2300));
});
const free = (run, over = {}) => ({ game: GAME_ID, playerId: pid(), name: 'ACE', score: run.score, replay: run.replay, seed: 2, mode: 'free', version: GAME_VERSION, ...over });
const admin = (W, env, route, b) => W.fetch(new Request(`https://lb.test/admin/${route}`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.88', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(b) }), env)
  .then(async (r) => ({ status: r.status, body: await r.json() }));
const names = async (W, env, q) => (await get(W, env, `/board?game=${GAME_ID}&${q}`)).body.rows.map((r) => r.name);

// the fake edge cache
let store, deletes, had;
beforeEach(() => {
  store = new Map(); deletes = [];
  had = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
    match: async (req) => store.get(req.url)?.clone(),
    put: async (req, res) => { store.set(req.url, res); },
    // a delete takes a few ms, so a purge that is not awaited loses the race with the next read
    delete: async (req) => { deletes.push(req.url); await new Promise((r) => setTimeout(r, 5)); return store.delete(req.url); } } } });
});
afterEach(() => { if (had) Object.defineProperty(globalThis, 'caches', had); else delete globalThis.caches; });

async function setup() {
  const env = { ...(await makeEnv()), ADMIN_TOKEN: TOKEN };
  return { env, W: createWorker({ now: () => T }) };
}

test('free submit: the all-time and season boards read before it are purged; the read after has the new row', async () => {
  const { env, W } = await setup();
  assert.deepEqual(await names(W, env, 'board=all'), []);
  assert.deepEqual(await names(W, env, 'board=season'), []);
  assert.equal(store.size, 2, 'both reads were cached');
  assert.deepEqual(await names(W, env, 'board=all'), [], 'served from the cache');
  const r = await post(W, env, free(VICTIM), { ip: ip() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(await names(W, env, 'board=all'), ['ACE'], 'all-time: the new row, not the cached empty board');
  assert.deepEqual(await names(W, env, 'board=season'), ['ACE'], 'season: the new row');
  assert.deepEqual(await names(W, env, `board=season&key=${seasonFor(T).id}`), ['ACE'], 'season spelled out: the same window');
});

test('free submit: every window of the board is purged, not only the first (a new top row moves every rank down)', async () => {
  const { env, W } = await setup();
  for (let j = 0; j < 150; j++) {
    const tag = `deep-${j}`, t = T - 1e6 + j;
    await storeRun(env.DB, { run: { game: GAME_ID, pid: `deep-player-${String(j).padStart(4, '0')}`, name: 'OLD', score: 1000 + j, replay: `r${tag}`, seed: 2,
      mode: 'free', version: GAME_VERSION, stats: null }, t, season: seasonFor(t).id, entry: `e-${tag}`, rhash: `h-${tag}` });
  }
  const deep = async () => (await get(W, env, `/board?game=${GAME_ID}&limit=10&offset=100`)).body.rows.map((r) => [r.rank, r.score]);
  const was = await deep();
  assert.deepEqual(was[0], [101, 1049]);
  const r = await post(W, env, free(VICTIM), { ip: ip() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(VICTIM.score > 1149);
  assert.deepEqual((await deep())[0], [101, 1050], 'ranks 101+ shifted down by one: the second window was purged too');
});

test('daily submit: the TODAY board is purged as well as all-time and season', async () => {
  const { env, W } = await setup();
  assert.deepEqual(await names(W, env, 'board=daily'), []);
  assert.deepEqual(await names(W, env, `board=daily&key=${D}`), []);
  assert.deepEqual(await names(W, env, 'board=all'), []);
  const r = await post(W, env, { game: GAME_ID, playerId: pid(), name: 'DAY', score: DAILY.score, replay: DAILY.replay, seed: dailySeed(D),
    mode: 'daily', dayKey: D, version: GAME_VERSION }, { ip: ip() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(await names(W, env, 'board=daily'), ['DAY'], 'the daily board: the new row, not the cached empty board');
  assert.deepEqual(await names(W, env, `board=daily&key=${D}`), ['DAY']);
  assert.deepEqual(await names(W, env, 'board=all'), ['DAY']);
  assert.deepEqual(await names(W, env, 'board=season'), ['DAY']);
});

test('admin hide purges every board the entry was on: the hidden row is gone from the next read', async () => {
  const { env, W } = await setup();
  const r = await post(W, env, { game: GAME_ID, playerId: pid(), name: 'BAD', score: DAILY.score, replay: DAILY.replay, seed: dailySeed(D),
    mode: 'daily', dayKey: D, version: GAME_VERSION }, { ip: ip() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  for (const q of ['board=all', 'board=season', 'board=daily']) assert.deepEqual(await names(W, env, q), ['BAD'], q);
  const h = await admin(W, env, 'hide', { entryId: r.body.id });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  for (const q of ['board=all', 'board=season', 'board=daily']) assert.deepEqual(await names(W, env, q), [], q + ' after hide');
});

test('a held (202) or refused submit purges nothing; the admin release of the held run does', async () => {
  const { env, W } = await setup();
  assert.equal((await post(W, env, free(VICTIM, { name: 'ACE' }), { ip: ip() })).status, 201);
  assert.deepEqual(await names(W, env, 'board=all'), ['ACE']);
  assert.deepEqual(await names(W, env, 'board=season'), ['ACE']);
  const cached = store.size;
  deletes.length = 0;
  const held = await post(W, env, free(COPY, { name: 'CPY' }), { ip: ip() });
  assert.equal(held.status, 202, JSON.stringify(held.body));
  const dup = await post(W, env, free(VICTIM, { name: 'TWO' }), { ip: ip() });
  assert.equal(dup.status, 409, JSON.stringify(dup.body));
  assert.deepEqual(deletes, [], 'no board changed, so no window was purged');
  assert.equal(store.size, cached);
  assert.deepEqual(await names(W, env, 'board=all'), ['ACE'], 'still the cached window (and the right board)');
  const rel = await admin(W, env, 'release', { id: held.body.heldId });
  assert.equal(rel.status, 201, JSON.stringify(rel.body));
  assert.deepEqual((await names(W, env, 'board=all')).sort(), ['ACE', 'CPY'], 'the released run shows on the next read');
  assert.deepEqual((await names(W, env, 'board=season')).sort(), ['ACE', 'CPY']);
});

test('purge keys are the board read keys: the window for the run\'s major version, for every window start', async () => {
  const { env, W } = await setup();
  const r = await post(W, env, free(VICTIM), { ip: ip() });
  assert.equal(r.status, 201);
  const ver = majorOf(GAME_VERSION), s = seasonFor(T).id;
  for (const b of ['all', `season:${s}`]) {
    for (let from = 0; from < 1000; from += 100) {
      const k = `https://lb.test/board?game=${GAME_ID}&version=${ver}&board=${encodeURIComponent(b)}&from=${from}`;
      assert.ok(deletes.includes(k), 'purged: ' + k);
    }
  }
  assert.equal(deletes.length, 20, 'a free run is on two boards: 2 x 10 windows');
});

test('no edge cache, or one without delete: submit and hide work unchanged', async () => {
  for (const shape of ['none', 'no-delete']) {
    if (shape === 'none') delete globalThis.caches;
    else Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
      match: async (req) => store.get(req.url)?.clone(), put: async (req, res) => { store.set(req.url, res); } } } });
    const { env, W } = await setup();
    const r = await post(W, env, free(VICTIM), { ip: ip() });
    assert.equal(r.status, 201, shape + ': ' + JSON.stringify(r.body));
    const h = await admin(W, env, 'hide', { entryId: r.body.id });
    assert.equal(h.status, 200, shape + ': ' + JSON.stringify(h.body));
    store.clear();
  }
});
