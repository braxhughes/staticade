// Percentile counts (rows read flat as the season grows), board
// cache key and clamps, hide also takes the run out of trophies, the three mutants that survived
// (skipped-season carry through the Worker, ties in the server percentile, placement tie order).
// Seeding many players goes straight to server/boards.js storeRun (the function the Worker calls); the Worker paths
// go through worker.fetch on the node:sqlite D1 shim.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { seasonFor, seasonTrophies, percentile, carryOver, SEASON_MS, TOP_RUNS } from '../leaderboard/ranking.js';
import { storeRun, ratingOf, hideEntry, majorOf, histKey, histRanges, BOARD_CAP, HIST_LEVELS, HIST_BITS } from '../server/boards.js';
import { LIMITS, BOARD_WINDOW } from '../server/worker.js';
import { playScripted, makeEnv, post, get, createWorker } from '../server/fixtures.mjs';

const VER = majorOf(GAME_VERSION);
const TOKEN = 'w22-fix-admin-token-0123456789';
const admin = (W, env, b) => W.fetch(new Request('https://lb.test/admin/hide', { method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.77', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(b) }), env)
  .then(async (r) => ({ status: r.status, body: await r.json() }));
let k = 0;
async function put(env, p, score, t) {
  const tag = `${p}-${score}-${++k}`.toLowerCase();
  const run = { game: GAME_ID, pid: p, name: 'FIX', score, replay: `f${tag}`, seed: 2, mode: 'free', version: GAME_VERSION, stats: null };
  const res = await storeRun(env.DB, { run, t, season: seasonFor(t).id, entry: `e-${tag}`, rhash: `h-${tag}` });
  return { ...res, entry: `e-${tag}` };
}
const all = (env, sql, ...v) => env.DB.raw.prepare(sql).all(...v);

// What a scan of ratings says (the pre-fix way): the field for one player.
function bruteField(env, season, p) {
  const me = env.DB.raw.prepare('SELECT avg5 FROM ratings WHERE game = ? AND ver = ? AND season = ? AND pid = ?').get(GAME_ID, VER, season, p);
  const rows = all(env, 'SELECT pid, avg5 FROM ratings WHERE game = ? AND ver = ? AND season = ?', GAME_ID, VER, season);
  if (!me) return null;
  const x = me.avg5;
  const pos = rows.filter((r) => r.avg5 > 0).length;
  return { below: x > 0 ? rows.filter((r) => r.avg5 > 0 && r.avg5 < x).length : 0,
    ties: x > 0 ? rows.filter((r) => r.avg5 === x && r.pid !== p).length : 0, others: pos - (x > 0 ? 1 : 0), players: rows.length, avg5: x };
}
// The 'rank:' counts rebuilt from ratings, as a map key -> n (zero counts left out).
function rebuilt(env) {
  const m = new Map();
  const add = (key) => m.set(key, (m.get(key) ?? 0) + 1);
  for (const r of all(env, 'SELECT season, avg5 FROM ratings WHERE game = ? AND ver = ?', GAME_ID, VER)) {
    add(histKey(r.season, 9, 0));
    if (r.avg5 > 0) { add(histKey(r.season, 8, 0)); for (let l = 0; l < HIST_LEVELS; l++) add(histKey(r.season, l, Math.floor(r.avg5 / 2 ** (HIST_BITS * l)))); }
  }
  return m;
}
function stored(env) {
  return new Map(all(env, "SELECT board, n FROM board_size WHERE game = ? AND ver = ? AND board LIKE 'rank:%' AND n <> 0", GAME_ID, VER).map((r) => [r.board, r.n]));
}
async function checkPlayer(env, season, p) {
  const f = bruteField(env, season, p);
  const r = await ratingOf(env.DB, { game: GAME_ID, ver: VER, pid: p, season });
  if (!f) { assert.equal(r.rated, false, p); return; }
  const carry = env.DB.raw.prepare('SELECT carry FROM ratings WHERE game = ? AND ver = ? AND season = ? AND pid = ?').get(GAME_ID, VER, season, p).carry;
  assert.equal(r.avg5, f.avg5, p);
  assert.equal(r.players, f.players, `${p} head count`);
  assert.equal(r.percentile, Math.round(percentile(f) * 1000) / 1000, `${p} percentile`);
  assert.equal(r.trophies, seasonTrophies({ rated: true, ...f, carry }), `${p} trophies`);
}

let RUN; // one honest recorded run (seed 2) for the Worker paths
before(() => { RUN = playScripted(2, 31 * 7919, 'script'); });

test('MED1: the percentile counts are exact at the level edges (63/64, 4095/4096, ...) and with ties', async () => {
  const env = await makeEnv();
  const t = Date.now() - 100000;
  const season = seasonFor(t).id;
  // single runs, so avg5 = floor(score / 5); edges of every level, ties on both sides of each edge
  const avgs = [1, 1, 62, 63, 63, 64, 64, 65, 127, 128, 4095, 4095, 4096, 4097, 262143, 262144, 262144, 16777215, 16777216, 16777216, 2 ** 30 + 5];
  let i = 0;
  for (const a of avgs) await put(env, `edge-${String(i++).padStart(4, '0')}`, a * TOP_RUNS, t + i);
  await put(env, 'edge-zero-0001', 3, t + 99); // avg5 0: rated, not in the field
  for (let j = 0; j < i; j++) await checkPlayer(env, season, `edge-${String(j).padStart(4, '0')}`);
  await checkPlayer(env, season, 'edge-zero-0001');
  assert.deepEqual(stored(env), rebuilt(env));
  // a direct look at two tie pairs: 64 sits above 1, 1, 62, 63, 63 and ties one other 64
  const f = bruteField(env, season, 'edge-0005');
  assert.deepEqual([f.below, f.ties], [5, 1]);
  // the ranges cover exactly "every prefix below" at each level
  assert.deepEqual(histRanges(64), [[0, 64, 64], [1, 0, 1], [2, 0, 0], [3, 0, 0], [4, 0, 0]]);
  assert.deepEqual(histRanges(4096 + 70), [[0, 4160, 4166], [1, 64, 65], [2, 0, 1], [3, 0, 0], [4, 0, 0]]);
});

test('MED1: no drift: after 1,500 random submits and hides over two seasons the counts equal a rebuild from ratings', async () => {
  const env = await makeEnv();
  let s = 12345;
  const rnd = (n) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s % n; };
  const t0 = Date.now() - 3 * SEASON_MS;
  let t = t0;
  const players = Array.from({ length: 120 }, (_, j) => `drift-${String(j).padStart(5, '0')}`);
  const sizes = [5, 320, 4000, 20000, 400000, 90000000];
  for (let op = 0; op < 1500; op++) {
    if (op === 750) t += SEASON_MS; // half the ops in the next season
    t += 1;
    if (rnd(7) === 0) {
      const rows = all(env, 'SELECT entry FROM season_runs');
      if (rows.length) await hideEntry(env.DB, { entry: rows[rnd(rows.length)].entry, t });
    } else {
      const score = 1 + rnd(sizes[rnd(sizes.length)]);
      await put(env, players[rnd(players.length)], score, t);
    }
    if (op % 250 === 249) {
      assert.deepEqual(stored(env), rebuilt(env), `after op ${op}`);
      for (const season of [seasonFor(t0).id, seasonFor(t).id]) {
        const head = env.DB.raw.prepare('SELECT n FROM board_size WHERE board = ?').get(histKey(season, 9, 0))?.n ?? 0;
        assert.equal(head, all(env, 'SELECT 1 FROM ratings WHERE season = ?', season).length, 'head count = players rated');
        for (let j = 0; j < 12; j++) await checkPlayer(env, season, players[rnd(players.length)]);
      }
    }
  }
});

test('MED1: the field read touches only the counts (primary key), never ratings', async () => {
  const env = await makeEnv();
  await put(env, 'plan-player-01', 5000, Date.now());
  const plans = [];
  const spy = { ...env.DB, prepare: (sql) => { if (/rank:|board >= \?/.test(sql) || /FROM ratings WHERE game = \? AND ver = \? AND season = \?(?! AND pid)/.test(sql)) plans.push(sql); return env.DB.prepare(sql); } };
  await ratingOf(spy, { game: GAME_ID, ver: VER, pid: 'plan-player-01', season: seasonFor(Date.now()).id });
  assert.equal(plans.length, 1, 'one field statement');
  const qp = env.DB.raw.prepare(`EXPLAIN QUERY PLAN ${plans[0]}`).all(...Array(3 * 3 + HIST_LEVELS * 4).fill('x')).map((r) => r.detail);
  assert.ok(qp.every((d) => !/ratings/.test(d)), qp.join(' | '));
  assert.ok(qp.filter((d) => /board_size/.test(d)).every((d) => /SEARCH board_size USING PRIMARY KEY/.test(d)), qp.join(' | '));
});

let hasCli = true;
try { execFileSync('sqlite3', ['-version'], { stdio: 'ignore' }); } catch { hasCli = false; }
test('MED1: rows read per submit and per /rank stay flat from 1,000 to 100,000 players (sqlite3 .scanstats)', { skip: hasCli ? false : 'no sqlite3 command line tool' }, async () => {
  const { measure } = await import('../server/rows-read.mjs');
  const a = await measure(13000), b = await measure(100000), c = await measure(1000);
  for (const r of [a, b, c]) assert.ok(r.rank <= 400, `rank ${JSON.stringify(r)}`);
  for (const r of [a, b]) assert.ok(r.submit <= 400, `submit ${JSON.stringify(r)}`); // boards full, run below them
  assert.ok(c.submit <= 1000 + 400, `1k: the run is on the board, so its placement walks at most BOARD_CAP rows: ${c.submit}`);
  assert.ok(b.onboard <= 2 * BOARD_CAP + 400, `a run that just gets on the boards: ${b.onboard}`);
  assert.ok(b.submit - a.submit <= 100 && b.rank - a.rank <= 100, `flat: 13k ${a.submit}/${a.rank}, 100k ${b.submit}/${b.rank}`);
});

test('MED1: placement on a full board below its lowest row, with and without the player\'s own row there', async () => {
  const env = await makeEnv();
  let t = Date.now() - 1e6;
  for (let j = 0; j < BOARD_CAP; j++) await put(env, `full-${String(j).padStart(5, '0')}`, 10000 + j, ++t);
  const low = await put(env, 'full-new-00001', 500, ++t); // not on the board: below the cap
  assert.equal(low.placements.all, null);
  // full-00000 holds the lowest row (10000); its worse run ranks below every row but its own: BOARD_CAP
  const own = await put(env, 'full-00000', 9000, ++t);
  assert.equal(own.placements.all, BOARD_CAP);
  // the same through the walk (a score inside the board) agrees with a count
  const mid = await put(env, 'full-00500', 10200, ++t);
  const above = env.DB.raw.prepare("SELECT COUNT(*) AS n FROM board WHERE board = 'all' AND pid <> 'full-00500' AND score >= 10200").get().n;
  assert.equal(mid.placements.all, above + 1);
});

test('MED2: the board cache key is the normalised query; random, reordered and spelled-out params hit the same entries', async () => {
  const env = await makeEnv();
  const t = Date.now() - 1e5;
  for (let j = 0; j < 250; j++) await put(env, `cache-${String(j).padStart(5, '0')}`, 1000 + j, t + j);
  const store = new Map();
  const had = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
    match: async (req) => store.get(req.url)?.clone(), put: async (req, res) => { store.set(req.url, res); } } } });
  try {
    const W = createWorker();
    let reads = 0;
    const counting = { ...env, DB: { ...env.DB, prepare: (sql) => { reads++; return env.DB.prepare(sql); } } };
    const first = await get(W, counting, '/board?game=starfall');
    assert.equal(first.body.rows.length, 10);
    const r0 = reads;
    const season = seasonFor(Date.now()).id;
    for (const q of [`game=starfall&x=${Math.random()}`, 'board=all&game=starfall', `game=starfall&version=${GAME_VERSION}`, `game=starfall&version=${VER}&unique=false`,
      'game=starfall&limit=10&offset=0', 'game=starfall&limit=3&offset=7', 'game=starfall&limit=100', `game=starfall&cb=${Date.now()}&cb2=1`]) {
      const r = await get(W, counting, `/board?${q}`);
      assert.equal(r.status, 200, q);
    }
    assert.equal(reads, r0, 'all served from the one cached window');
    assert.equal(store.size, 1);
    // the window slices right: ranks 8..10, and 95..105 across two windows
    assert.deepEqual((await get(W, counting, '/board?game=starfall&limit=3&offset=7')).body.rows.map((r) => r.rank), [8, 9, 10]);
    const span = (await get(W, counting, '/board?game=starfall&limit=11&offset=94')).body.rows;
    assert.deepEqual(span.map((r) => r.rank), [95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105]);
    assert.deepEqual(span.map((r) => r.score), Array.from({ length: 11 }, (_, i) => 1000 + 249 - 94 - i));
    assert.equal(store.size, 2);
    // the season board: default key and the spelled-out current season id are one entry
    await get(W, counting, '/board?game=starfall&board=season');
    const s1 = store.size;
    await get(W, counting, `/board?board=season&key=${season}&game=starfall&z=1`);
    assert.equal(store.size, s1);
    // a page of 100 rows past the end: clamped, at most BOARD_WINDOW rows read on a miss
    const before = store.size;
    const deep = await get(W, counting, `/board?game=starfall&limit=100&offset=${BOARD_CAP - 1}`);
    assert.deepEqual(deep.body.rows, []); // the board has 250 rows
    assert.ok(store.size - before <= 1);
    assert.ok(store.size <= 2 + 1 + 1 + BOARD_CAP / BOARD_WINDOW);
  } finally {
    if (had) Object.defineProperty(globalThis, 'caches', had); else delete globalThis.caches;
  }
});

test('MED2: limit and offset are clamped or refused; offset 10^9 and limit -1 never reach the database', async () => {
  const env = await makeEnv();
  const t = Date.now() - 1e5;
  for (let j = 0; j < 150; j++) await put(env, `clamp-${String(j).padStart(5, '0')}`, 1000 + j, t + j);
  const W = createWorker();
  let reads = 0;
  const counting = { ...env, DB: { ...env.DB, prepare: (sql) => { reads++; return env.DB.prepare(sql); } } };
  for (const q of ['offset=1000000000', 'limit=-1', 'offset=-5', 'limit=1e3', 'limit=99999999']) {
    const r = await get(W, counting, `/board?game=starfall&${q}`);
    assert.equal(r.status, 400, q);
    assert.equal(r.body.error, 'bad_board', q);
  }
  assert.equal(reads, 0);
  assert.equal((await get(W, env, '/board?game=starfall&limit=999999')).body.rows.length, 100, 'limit cut to 100');
  assert.deepEqual((await get(W, env, '/board?game=starfall&limit=0')).body.rows, []);
  assert.deepEqual((await get(W, env, '/board?game=starfall&offset=999999')).body.rows, [], 'offset cut to BOARD_CAP: nothing there');
  const r = await get(W, env, `/board?game=starfall&offset=${BOARD_CAP}&limit=100`);
  assert.deepEqual(r.body.rows, []);
  assert.equal(r.headers.get('cache-control'), `public, max-age=${LIMITS.boardMaxAge}`);
});

test('MED3: hide takes the run out of the best 5 and the field; the hidden player drops, the player under them moves up', async () => {
  const env = { ...(await makeEnv()), ADMIN_TOKEN: TOKEN };
  const W = createWorker();
  const t = Date.now() - 1e5;
  const season = seasonFor(Date.now()).id;
  for (let j = 0; j < 10; j++) await put(env, `field-${String(j).padStart(5, '0')}`, 1000 * (j + 1), t + j);
  const below = await put(env, 'just-below-001', 50000, t + 20);
  const cheat = await put(env, 'cheater-00001', 99999, t + 21);
  await put(env, 'cheater-00001', 400, t + 22); // a second, honest-looking run stays in the best 5
  const rank = async (p) => (await get(W, env, `/rank?game=starfall&playerId=${p}`)).body;
  const b0 = await rank('just-below-001'), c0 = await rank('cheater-00001');
  assert.equal(c0.best, 99999);
  assert.equal(b0.players, 12);
  const h = await admin(W, env, { entryId: cheat.entry });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.deepEqual([h.body.rows, h.body.runs], [2, 1]);
  const c1 = await rank('cheater-00001'), b1 = await rank('just-below-001');
  assert.deepEqual(c1.top5, [400]);
  assert.equal(c1.avg5, 80);
  assert.equal(c1.best, 400, 'all-time best falls to the best run left');
  assert.ok(c1.trophies < c0.trophies);
  assert.ok(b1.percentile > b0.percentile, `${b0.percentile} -> ${b1.percentile}`);
  assert.ok(b1.trophies > b0.trophies);
  await checkPlayer(env, season, 'just-below-001');
  await checkPlayer(env, season, 'cheater-00001');
  // hide the last run: the player is unrated this season (trophies back to the carry, 0 here), off the head count
  const last = env.DB.raw.prepare("SELECT entry FROM season_runs WHERE pid = 'cheater-00001'").get().entry;
  const h2 = await admin(W, env, { entryId: last });
  assert.equal(h2.status, 200, 'a run on no board (worse than the player\'s own row) can still be hidden');
  assert.deepEqual([h2.body.rows, h2.body.runs], [0, 1]);
  const c2 = await rank('cheater-00001');
  assert.deepEqual([c2.trophies, c2.avg5, c2.percentile, c2.top5], [0, 0, null, []]);
  assert.equal((await rank('just-below-001')).players, 11);
  assert.deepEqual(stored(env), rebuilt(env));
  assert.equal((await admin(W, env, { entryId: last })).status, 404, 'already hidden');
});

test('LOW5: a skipped season keeps a half per season through the Worker (/rank carry after 1 and after 2 seasons away)', async () => {
  const env = await makeEnv();
  let clock = seasonFor(Date.now()).start + 3600000;
  const W = createWorker({ now: () => clock });
  const r = await post(W, env, { game: GAME_ID, playerId: 'carry-skip-0001', name: 'CAR', score: RUN.score, replay: RUN.replay, seed: 2, mode: 'free', version: GAME_VERSION }, { ip: '198.51.100.40' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.trophies, 750, 'alone: Gold III');
  clock += SEASON_MS;
  assert.equal((await get(W, env, '/rank?game=starfall&playerId=carry-skip-0001')).body.carry, carryOver(750, 1));
  clock += SEASON_MS;
  const two = (await get(W, env, '/rank?game=starfall&playerId=carry-skip-0001')).body;
  assert.equal(two.carry, carryOver(750, 2));
  assert.equal(two.trophies, 187);
});

test('LOW5: ties in the server percentile count half (two players on the same average)', async () => {
  const env = await makeEnv();
  const t = Date.now() - 1e5;
  const season = seasonFor(t).id;
  await put(env, 'tie-low-00001', 1000, t);
  await put(env, 'tie-a-0000001', 5000, t + 1);
  await put(env, 'tie-b-0000001', 5000, t + 2);
  await put(env, 'tie-high-0001', 9000, t + 3);
  const r = await ratingOf(env.DB, { game: GAME_ID, ver: VER, pid: 'tie-a-0000001', season });
  const want = percentile({ below: 1, ties: 1, others: 3 });
  assert.equal(r.percentile, Math.round(want * 1000) / 1000);
  assert.notEqual(r.percentile, Math.round(percentile({ below: 1, ties: 0, others: 3 }) * 1000) / 1000);
  assert.notEqual(r.percentile, Math.round(percentile({ below: 2, ties: 0, others: 3 }) * 1000) / 1000);
  assert.equal(r.trophies, seasonTrophies({ rated: true, below: 1, ties: 1, others: 3 }));
});

test('LOW5: placement ties go to the earlier run (the later equal score ranks below it)', async () => {
  const env = await makeEnv();
  const t = Date.now() - 1e5;
  const a = await put(env, 'ptie-early-001', 7000, t);
  const b = await put(env, 'ptie-late-0001', 7000, t + 5);
  assert.equal(a.placements.all, 1);
  assert.equal(b.placements.all, 2);
  assert.equal(b.placements.season, 2);
  const W = createWorker();
  assert.deepEqual((await get(W, env, '/board?game=starfall')).body.rows.map((x) => x.id), [a.entry, b.entry]);
});
