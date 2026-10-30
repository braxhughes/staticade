// w22 (card 3a): boards as SQL rows, the board cap, score 0, 3-letter names and the blocklist, POST /admin/hide,
// boards per major version, board caching, no global lock. Through worker.fetch(new Request(...), env) on the
// node:sqlite D1 shim with real recorded runs, except where noted (seeding thousands of rows goes straight to
// server/boards.js storeRun, the function the Worker calls, because re-simulating thousands of runs takes minutes).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode } from '../engine/replay.js';
import { GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { seasonFor } from '../leaderboard/ranking.js';
import { LIMITS, SERVER_VERSION } from '../server/worker.js';
import { storeRun, readBoard, BOARD_CAP, majorOf } from '../server/boards.js';
import { BLOCKED, cleanName } from '../server/names.js';
import { record, playScripted, playIdle, makeEnv, post, get, createWorker } from '../server/fixtures.mjs';

let FREE, IDLE, RUNS; // real runs: arcade seed 2 (score 33995), an idle run (score 0), five more honest runs
let n = 0;
const pid = () => `w22-boards-${String(++n).padStart(5, '0')}`;
const ip = () => `198.19.${(n >> 8) & 255}.${n & 255}`;
const body = (run, over = {}) => ({ game: GAME_ID, playerId: pid(), name: 'ACE', score: run.score, replay: run.replay, seed: run.seed ?? 2, mode: 'free', version: GAME_VERSION, ...over });
const count = (env, sql) => env.DB.raw.prepare(sql).get().n;
const TOKEN = 'w22-admin-token-0123456789abcdef';
const admin = (W, env, path, b, token = TOKEN) => W.fetch(new Request(`https://lb.test${path}`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.98', ...(token && { authorization: `Bearer ${token}` }) },
  body: typeof b === 'string' ? b : JSON.stringify(b) }), env).then(async (r) => ({ status: r.status, body: await r.json() }));

before(() => {
  FREE = { ...record('arcade', 2), seed: 2 };
  IDLE = { ...playIdle(2), seed: 2 };
  RUNS = [11, 12, 13, 14, 15].map((k) => ({ ...playScripted(2, k * 7919, 'script'), seed: 2 }));
});

// Seed a board straight through storeRun (no re-sim). Returns the answers.
async function seed(env, list, { t0 = Date.now(), version = GAME_VERSION, dayKey } = {}) {
  const out = [];
  let t = t0;
  for (const [p, score] of list) {
    t += 1;
    const run = { game: GAME_ID, pid: p, name: 'BOT', score, replay: `r1~starfall~${version}~2~arcade~seed${p}${score}`, seed: 2, mode: dayKey ? 'daily' : 'free', dayKey, version, stats: null };
    out.push(await storeRun(env.DB, { run, t, season: seasonFor(t).id, entry: `e${p.toLowerCase()}-${score}-${t}`, rhash: `h${p}-${score}-${t}`.toLowerCase() }));
  }
  return out;
}

test('board as rows: one row per player per board (their best); the old one-JSON-value layout is gone', async () => {
  const env = await makeEnv();
  const W = createWorker();
  const me = pid();
  for (const r of [RUNS[0], RUNS[1]]) assert.equal((await post(W, env, body(r, { playerId: me }), { ip: ip() })).status, 201);
  const best = Math.max(RUNS[0].score, RUNS[1].score);
  for (const b of ['all', `season:${seasonFor(Date.now()).id}`]) {
    const rows = env.DB.raw.prepare('SELECT pid, score FROM board WHERE board = ?').all(b);
    assert.deepEqual(rows.map((r) => [r.pid, r.score]), [[me, best]], b);
  }
  assert.equal(count(env, 'SELECT COUNT(*) AS n FROM kv'), 0, 'nothing in the key-value table');
  const rows = (await get(W, env, '/board?game=starfall&unique=false')).body.rows;
  assert.deepEqual(rows.map((r) => r.score), [best]);
  // the worse run is on no board, so its replay is not kept
  assert.equal(count(env, 'SELECT COUNT(*) AS n FROM replays'), 1);
});

test('attack: 1,000 score-0 submits (a real idle run, distinct players and addresses) are all refused (score_zero) before any re-sim', async () => {
  assert.equal(IDLE.score, 0);
  const env = await makeEnv();
  const W = createWorker();
  const t0 = performance.now();
  for (let i = 0; i < 1000; i++) {
    const r = await post(W, env, body(IDLE, { score: 0 }), { ip: `10.${i >> 8}.${i & 255}.1` });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, 'score_zero');
  }
  assert.ok(performance.now() - t0 < 5000, 'refused cheaply');
  assert.equal(count(env, 'SELECT COUNT(*) AS n FROM board'), 0);
  assert.equal(count(env, 'SELECT COUNT(*) AS n FROM results'), 0);
  // claiming a non-zero score for the idle replay is a mismatch: a run that really scores 0 can never be stored
  assert.equal((await post(W, env, body(IDLE, { score: 10 }), { ip: ip() })).body.error, 'score_mismatch');
});

test('names: exactly 3 letters A-Z; ab, ABCD, a1c, unicode, empty, blocked words and SQL are refused (bad_name)', async () => {
  const env = await makeEnv();
  const W = createWorker();
  for (const name of ['ab', 'ABCD', 'a1c', 'A C', 'ÀBC', 'ａｂｃ', '', 'A', 'AB.', "A'B", "x'); DROP TABLE board;--", ...BLOCKED, BLOCKED[0].toLowerCase()]) {
    const r = await post(W, env, body(FREE, { name }), { ip: ip() });
    assert.equal(r.status, 400, name);
    assert.equal(r.body.error, 'bad_name', name);
  }
  assert.equal(count(env, 'SELECT COUNT(*) AS n FROM results'), 0, 'refused before the re-sim and the claim');
  const ok = await post(W, env, body(FREE, { name: 'zed' }), { ip: ip() });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await get(W, env, '/board?game=starfall')).body.rows[0].name, 'ZED');
  assert.equal(cleanName('ACE'), 'ACE');
  assert.equal(cleanName(null), null);
});

test('board cap: 1,300 players on one board keep the best BOARD_CAP rows; a score below the lowest is answered, not stored', async () => {
  const env = await makeEnv();
  const list = Array.from({ length: BOARD_CAP + 300 }, (_, i) => [`cap-player-${String(i).padStart(5, '0')}`, 1000 + ((i * 7919) % 5000)]);
  await seed(env, list);
  for (const b of ['all', `season:${seasonFor(Date.now()).id}`]) {
    assert.equal(count(env, `SELECT COUNT(*) AS n FROM board WHERE board = '${b}'`), BOARD_CAP, b);
    assert.equal(env.DB.raw.prepare('SELECT n FROM board_size WHERE board = ?').get(b).n, BOARD_CAP);
  }
  const kept = env.DB.raw.prepare("SELECT MIN(score) AS lo FROM board WHERE board = 'all'").get().lo;
  const sorted = list.map((x) => x[1]).sort((a, b) => b - a);
  assert.equal(kept, sorted[BOARD_CAP - 1], 'the kept rows are exactly the top BOARD_CAP');
  // every kept row still has its replay; every pushed-out one lost it (no replay is orphaned)
  assert.equal(count(env, 'SELECT COUNT(*) AS n FROM replays WHERE entry NOT IN (SELECT entry FROM board)'), 0);
  // a new player below the lowest kept row: answered (placement null), stored on no board, trophies still count
  const [low] = await seed(env, [['cap-low-0001', kept - 1]]);
  assert.equal(low.placements.all, null);
  assert.equal(low.placements.season, null);
  assert.equal(low.rating.enteredTop5, true);
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM board WHERE pid = 'cap-low-0001'"), 0);
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM ratings WHERE pid = 'cap-low-0001'"), 1);
  // equal to the lowest: the earlier row keeps its place
  await seed(env, [['cap-tie-0001', kept]]);
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM board WHERE pid = 'cap-tie-0001'"), 0);
  // a new top score goes in at rank 1 and pushes the lowest row out
  const [top] = await seed(env, [['cap-top-0001', 999999]]);
  assert.equal(top.placements.all, 1);
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM board WHERE board = 'all'"), BOARD_CAP);
  assert.ok(env.DB.raw.prepare("SELECT MIN(score) AS lo FROM board WHERE board = 'all'").get().lo >= kept);
  const W = createWorker();
  const page = await get(W, env, `/board?game=starfall&limit=100&offset=${BOARD_CAP - 5}`);
  assert.equal(page.body.rows.length, 5);
  assert.equal(page.body.rows[4].rank, BOARD_CAP);
  assert.deepEqual((await get(W, env, `/board?game=starfall&offset=${BOARD_CAP}`)).body.rows, []);
});

test('race: two players for the last kept row; one player racing themselves with two better runs', async () => {
  const env = await makeEnv();
  await seed(env, Array.from({ length: BOARD_CAP - 1 }, (_, i) => [`race-fill-${String(i).padStart(5, '0')}`, 5000 + i]));
  // the board has one free row; two new players race for it; both beat nothing, so the better one stays
  await Promise.all([seed(env, [['race-a-00001', 100]]), seed(env, [['race-b-00001', 200]])]);
  const all = env.DB.raw.prepare("SELECT pid FROM board WHERE board = 'all' AND pid LIKE 'race-_-%'").all().map((r) => r.pid);
  assert.deepEqual(all, ['race-b-00001'], 'the board is full; the lower of the two is pushed out');
  assert.equal(count(env, "SELECT COUNT(*) AS n FROM board WHERE board = 'all'"), BOARD_CAP);
  // one player, two better runs at the same moment: the board keeps the higher, the best 5 keep both
  const me = 'race-self-0001';
  await seed(env, [[me, 6000]]);
  await Promise.all([seed(env, [[me, 7000]], { t0: Date.now() + 10 }), seed(env, [[me, 8000]], { t0: Date.now() + 10 })]);
  assert.equal(env.DB.raw.prepare("SELECT score FROM board WHERE board = 'all' AND pid = ?").get(me).score, 8000);
  assert.deepEqual(env.DB.raw.prepare('SELECT score FROM season_runs WHERE pid = ? ORDER BY score DESC').all(me).map((r) => r.score), [8000, 7000, 6000]);
  assert.equal(env.DB.raw.prepare('SELECT avg5 FROM ratings WHERE pid = ?').get(me).avg5, Math.floor(21000 / 5));
  // and a worse run later never lowers the row (the upsert only ever raises it)
  await seed(env, [[me, 6500]], { t0: Date.now() + 20 });
  assert.equal(env.DB.raw.prepare("SELECT score FROM board WHERE board = 'all' AND pid = ?").get(me).score, 8000);
});

test('/board cost stays flat: the top-N read and the cap check use the indexes (EXPLAIN QUERY PLAN), no full scan or sort', async () => {
  const env = await makeEnv();
  const plan = (sql, ...v) => env.DB.raw.prepare('EXPLAIN QUERY PLAN ' + sql).all(...v).map((r) => r.detail).join(' | ');
  const top = plan('SELECT name, score, date, mode, entry FROM board WHERE game = ? AND ver = ? AND board = ? ORDER BY score DESC, t ASC, entry ASC LIMIT ? OFFSET ?', 'starfall', '2', 'all', 10, 0);
  assert.match(top, /USING INDEX board_top/);
  assert.doesNotMatch(top, /TEMP B-TREE|SCAN board(?! USING)/);
  const low = plan('SELECT score FROM board WHERE game = ? AND ver = ? AND board = ? ORDER BY score ASC, t DESC, entry DESC LIMIT 1', 'starfall', '2', 'all');
  assert.match(low, /USING (COVERING )?INDEX board_top/);
  assert.doesNotMatch(low, /TEMP B-TREE/);
  const size = plan('SELECT n FROM board_size WHERE game = ? AND ver = ? AND board = ?', 'starfall', '2', 'all');
  assert.match(size, /PRIMARY KEY|USING PRIMARY KEY/);
  const field = plan('SELECT COUNT(*) AS n, COALESCE(SUM(avg5 < ?), 0) AS below, COALESCE(SUM(avg5 = ?), 0) AS same FROM ratings WHERE game = ? AND ver = ? AND season = ?', 1, 1, 'starfall', '2', 0);
  assert.match(field, /COVERING INDEX ratings_avg/);
  // and in time: the top-10 read on a full board vs. an almost empty one
  await seed(env, Array.from({ length: BOARD_CAP + 50 }, (_, i) => [`flat-${String(i).padStart(6, '0')}`, 100 + i]));
  const time = (f) => { const t = performance.now(); for (let i = 0; i < 200; i++) f(); return (performance.now() - t) / 200; };
  const q = env.DB.raw.prepare("SELECT name, score FROM board WHERE game = 'starfall' AND ver = ? AND board = 'all' ORDER BY score DESC, t ASC, entry ASC LIMIT 10 OFFSET 0");
  const ms = time(() => q.all(SERVER_VERSION));
  assert.ok(ms < 1, `top-10 read ${ms} ms`);
});

test('POST /admin/hide: off without a token, needs the token, removes the entry from every board read; then re-submit', async () => {
  const env = { ...(await makeEnv()), ADMIN_TOKEN: TOKEN };
  const W = createWorker();
  const me = pid();
  const day = new Date().toISOString().slice(0, 10);
  const r = await post(W, env, body(FREE, { playerId: me, name: 'ASH' }), { ip: ip() });
  assert.equal(r.status, 201);
  const other = await post(W, env, body(RUNS[2], { name: 'BOB' }), { ip: ip() });
  assert.equal(other.status, 201);
  assert.equal((await admin(W, { DB: env.DB }, '/admin/hide', { entryId: r.body.id })).status, 404, 'no ADMIN_TOKEN: the route is off');
  assert.equal((await admin(W, env, '/admin/hide', { entryId: r.body.id }, null)).status, 401);
  assert.equal((await admin(W, env, '/admin/hide', { entryId: r.body.id }, TOKEN + 'x')).status, 401);
  for (const bad of [{ entryId: "x' OR '1'='1" }, { entryId: 7 }, {}, { entryId: 'A'.repeat(200) }]) assert.equal((await admin(W, env, '/admin/hide', bad)).status, 400, JSON.stringify(bad));
  assert.equal((await admin(W, env, '/admin/hide', '{nope')).body.error, 'bad_json');
  assert.equal((await admin(W, env, '/admin/hide', { entryId: 'no-such-entry' })).status, 404);
  const h = await admin(W, env, '/admin/hide', { entryId: r.body.id });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal(h.body.rows, 2); // all-time and season
  for (const q of ['board=all', 'board=season', `board=daily&key=${day}`]) {
    assert.ok(!(await get(W, env, `/board?game=starfall&${q}&limit=100`)).body.rows.some((x) => x.id === r.body.id), q);
  }
  assert.deepEqual((await get(W, env, '/board?game=starfall')).body.rows.map((x) => x.name), ['BOB']);
  assert.equal((await get(W, env, `/replay/${r.body.id}`)).status, 404, 'its replay went with its last board row');
  assert.equal((await admin(W, env, '/admin/hide', { entryId: r.body.id })).status, 404, 'already hidden');
  assert.equal(count(env, 'SELECT COUNT(*) AS n FROM hidden'), 1);
  // the same run again is still a duplicate; a new run by the same player goes on the board as normal
  assert.equal((await post(W, env, body(FREE, { playerId: me, name: 'ASH' }), { ip: ip() })).body.error, 'duplicate_replay');
  const again = await post(W, env, body(RUNS[3], { playerId: me, name: 'ASH' }), { ip: ip() });
  assert.equal(again.status, 201);
  assert.ok((await get(W, env, '/board?game=starfall')).body.rows.some((x) => x.id === again.body.id));
  // rate limited like the release route
  const W2 = createWorker(), env3 = { ...(await makeEnv()), ADMIN_TOKEN: TOKEN };
  const rs = [];
  for (let i = 0; i < LIMITS.ipPerWindow + 3; i++) rs.push(await admin(W2, env3, '/admin/hide', { entryId: 'no-such-entry' }, 'wrong-token-wrong-token-wrong'));
  assert.equal(rs.filter((x) => x.status === 429).length, 3);
});

test('versions (MED8): boards per major version; a wrong version is refused with a "new version, reload" message', async () => {
  const env = await makeEnv();
  const W = createWorker();
  assert.equal(SERVER_VERSION, majorOf(GAME_VERSION));
  assert.equal((await post(W, env, body(FREE), { ip: ip() })).status, 201);
  const major = SERVER_VERSION, minor = `${major}.99`, next = String(Number(major) + 1);
  assert.equal((await get(W, env, '/board?game=starfall')).body.rows.length, 1);
  assert.equal((await get(W, env, `/board?game=starfall&version=${GAME_VERSION}`)).body.rows.length, 1);
  assert.equal((await get(W, env, `/board?game=starfall&version=${minor}`)).body.rows.length, 1, 'same major, same board');
  assert.deepEqual((await get(W, env, `/board?game=starfall&version=${next}`)).body.rows, [], 'another major: its own board');
  for (const v of ['x', '2;DROP TABLE board', '-1', '2.5.1', '']) assert.equal((await get(W, env, `/board?game=starfall&version=${encodeURIComponent(v)}`)).body.error, 'bad_board', v);
  // an older major's rows stay readable on their own board and never mix with the current one
  await seed(env, [['old-version-0001', 999999]], { version: '1.9' });
  assert.equal((await get(W, env, '/board?game=starfall')).body.rows[0].score, FREE.score);
  assert.equal((await get(W, env, '/board?game=starfall&version=1')).body.rows[0].score, 999999);
  // a page left open across a deploy sends the old version: refused, with the message the client shows
  const old = FREE.replay.replace(`~${GAME_VERSION}~`, '~2.4~');
  const r = await post(W, env, body(FREE, { replay: old, version: '2.4' }), { ip: ip() });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'wrong_version');
  assert.match(r.body.message, /^new version, reload/);
  // rank reads are per version too
  const me = pid();
  assert.equal((await post(W, env, body(RUNS[0], { playerId: me }), { ip: ip() })).status, 201);
  assert.ok((await get(W, env, `/rank?game=starfall&playerId=${me}`)).body.best > 0);
  assert.equal((await get(W, env, `/rank?game=starfall&playerId=${me}&version=${next}`)).body.best, 0);
});

test('LOW10: a board read says public, max-age=10 and goes through the edge cache when there is one; errors are not cached', async () => {
  const env = await makeEnv();
  const W = createWorker();
  const r = await get(W, env, '/board?game=starfall');
  assert.equal(r.headers.get('cache-control'), `public, max-age=${LIMITS.boardMaxAge}`);
  assert.equal(LIMITS.boardMaxAge, 10);
  const e = await get(W, env, '/board?game=starfall&board=nope');
  assert.equal(e.status, 400);
  assert.equal(e.headers.get('cache-control'), 'no-store');
  assert.equal((await post(W, env, '{}', { ip: ip() })).headers.get('cache-control'), 'no-store');
  // a stand-in for Cloudflare's caches.default: the second read is served without touching the database
  const store = new Map();
  const had = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
    match: async (req) => store.get(req.url)?.clone(), put: async (req, res) => { store.set(req.url, res); } } } });
  try {
    let reads = 0;
    const counting = { ...env, DB: { ...env.DB, prepare: (sql) => { reads++; return env.DB.prepare(sql); } } };
    const a = await get(W, counting, '/board?game=starfall&limit=5');
    const before = reads;
    const b = await get(W, counting, '/board?game=starfall&limit=5');
    assert.equal(a.status, 200);
    assert.deepEqual(b.body, a.body);
    assert.equal(reads, before, 'served from the cache');
    await get(W, counting, '/board?game=starfall&board=nope');
    assert.equal(store.size, 1, 'an error is not put in the cache');
  } finally {
    if (had) Object.defineProperty(globalThis, 'caches', had); else delete globalThis.caches;
  }
});

test('attack: SQL injection in every new field (version, key, entryId, playerId on rank) leaves the tables intact', async () => {
  const env = { ...(await makeEnv()), ADMIN_TOKEN: TOKEN };
  const W = createWorker();
  assert.equal((await post(W, env, body(FREE), { ip: ip() })).status, 201);
  const evil = ["x'); DROP TABLE board;--", "' OR '1'='1", '1; DELETE FROM ratings; --', 'all\u0000'];
  for (const s of evil) {
    const e = encodeURIComponent(s);
    assert.equal((await get(W, env, `/board?game=starfall&version=${e}`)).body.error, 'bad_board');
    assert.equal((await get(W, env, `/board?game=starfall&board=season&key=${e}`)).body.error, 'bad_board');
    assert.equal((await get(W, env, `/board?game=starfall&board=${e}`)).body.error, 'bad_board');
    assert.equal((await get(W, env, `/rank?game=starfall&playerId=${e}`)).body.error, 'bad_player');
    assert.equal((await get(W, env, `/rank?game=starfall&playerId=valid-player-01&version=${e}`)).body.error, 'bad_board');
    assert.equal((await admin(W, env, '/admin/hide', { entryId: s })).status, 400);
    assert.equal((await get(W, env, `/replay/${e}`)).status, 404);
  }
  const tables = env.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, ['board', 'board_size', 'flagged', 'hidden', 'kv', 'locks', 'players', 'rate', 'ratings', 'replays', 'results', 'season_runs', 'seen']);
  assert.equal((await get(W, env, '/board?game=starfall')).body.rows.length, 1);
});

test('MED4: no lock is taken: the locks table is never written, and submits for different players run side by side', async () => {
  const env = await makeEnv();
  const W = createWorker();
  let lockWrites = 0;
  const spy = { ...env, DB: { ...env.DB, prepare: (sql) => { if (/\blocks\b/.test(sql)) lockWrites++; return env.DB.prepare(sql); } } };
  const rs = await Promise.all(RUNS.map((r) => post(W, spy, body(r), { ip: ip() })));
  assert.deepEqual(rs.map((r) => r.status), RUNS.map(() => 201), JSON.stringify(rs.map((r) => r.body.error)));
  assert.equal(lockWrites, 0);
  assert.equal((await get(W, env, '/board?game=starfall&limit=10')).body.rows.length, RUNS.length);
});

// The w18 duplicate tests that use 4- and 5-letter names (THIEF, COPY) or score 0, rerun with 3-letter names and a
// non-zero score, so the behaviour they pin stays covered while their edits wait (w22 report, "Test edits needed").
test('Q22 under the new rules: one-bit copies of a fetched replay are held, not stored; the board keeps one row', async () => {
  const env = await makeEnv();
  const W = createWorker();
  const first = await post(W, env, body(FREE), { ip: ip() });
  assert.equal(first.status, 201);
  const h = decode(FREE.replay);
  const held = [];
  for (const f of [412, 587, 909, 1598, 2653]) {
    const w = Uint16Array.from(h.words); w[f] ^= 0x400;
    const r = await post(W, env, body(FREE, { replay: encode(h, w), name: 'THF' }), { ip: ip() });
    assert.equal(r.status, 202, `frame ${f}: ${JSON.stringify(r.body)}`);
    held.push(r.body.heldId);
  }
  assert.deepEqual((await get(W, env, '/board?game=starfall&limit=50')).body.rows.map((x) => [x.name, x.score]), [['ACE', FREE.score]]);
  assert.equal(count(env, 'SELECT COUNT(*) AS n FROM results'), 1);
  // copies sent at the same moment as each other (no original yet): exactly one goes on the board
  const env2 = await makeEnv();
  const copies = [FREE.replay, ...[412, 909, 1598, 2653].map((f) => { const w = Uint16Array.from(h.words); w[f] ^= 0x400; return encode(h, w); })];
  const rs = await Promise.all(copies.map((replay) => post(W, env2, body(FREE, { replay }), { ip: ip() })));
  assert.equal(rs.filter((r) => r.status === 201).length, 1, JSON.stringify(rs.map((r) => r.body.code ?? r.body.error ?? r.status)));
  assert.ok(rs.every((r) => r.status === 201 || r.status === 202 || (r.status === 409 && r.body.error === 'duplicate_result')));
});

test('releaseResult under the new store: a batch that fails after the claim leaves no claim and no rows; the same run then goes in', async () => {
  const env = await makeEnv();
  const W = createWorker();
  const real = env.DB;
  let failOnce = true;
  const flaky = { ...real, batch: async (stmts) => {
    if (failOnce) { failOnce = false; throw new Error('disk on fire'); }
    return real.batch(stmts);
  } };
  const r = await post(W, { DB: flaky }, body(FREE), { ip: ip() });
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'server_error');
  for (const t of ['results', 'board', 'replays', 'seen', 'season_runs', 'ratings', 'players']) assert.equal(count(env, `SELECT COUNT(*) AS n FROM ${t}`), 0, t);
  assert.equal((await post(W, env, body(FREE), { ip: ip() })).status, 201);
  assert.equal(count(env, 'SELECT COUNT(*) AS n FROM results WHERE entry IS NOT NULL'), 1);
  // a batch that fails half way (the shim, like D1, runs it in one transaction) leaves nothing behind either
  const env2 = await makeEnv();
  const half = { ...env2.DB, batch: async (stmts) => env2.DB.batch([...stmts.slice(0, 4), env2.DB.prepare('INSERT INTO nope VALUES (1)')]) };
  assert.equal((await post(W, { DB: half }, body(FREE), { ip: ip() })).status, 500);
  for (const t of ['results', 'board', 'replays', 'seen']) assert.equal(count(env2, `SELECT COUNT(*) AS n FROM ${t}`), 0, t);
});
