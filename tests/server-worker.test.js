// Leaderboard server (server/worker.js) through its real entry point: worker.fetch(new Request(...), env), with a
// node:sqlite database behind the D1-shaped binding. Replays are real runs recorded by tools/record-replay.mjs.
// Every known attack has a test here.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode, encodeRuns, MAX_FRAMES } from '../engine/replay.js';
import { dailySeed } from '../engine/rng.js';
import { createSim, GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { todayUTC } from '../games/starfall/modes.js';
import { MAX_RUN_FRAMES } from '../server/verify.js';
import { MAX_REPLAY_CHARS } from '../leaderboard/api.js';
import worker, { LIMITS } from '../server/worker.js';
import { record, makeEnv, post, get, createWorker } from '../server/fixtures.mjs';

const DAY = 86400000;
let FREE, DAILY, OLD_DAILY, CUT; // recorded runs
let PID_N = 0;
const pid = () => `player-${String(++PID_N).padStart(4, '0')}-test`;
const ipN = () => `198.51.100.${PID_N % 250}`;
const freeBody = (over = {}) => ({ game: GAME_ID, playerId: pid(), name: 'ACE', score: FREE.score, replay: FREE.replay, seed: 2, mode: 'free', version: GAME_VERSION, ...over });
const reencode = (str, edit) => { const h = decode(str); const w = Uint16Array.from(h.words); const out = edit(w, h) ?? w; return encode(h, out); };
const W = createWorker();

before(() => {
  FREE = record('arcade', 2);                                      // finished, 4239 frames, score 33995
  DAILY = record('daily', dailySeed(todayUTC()));                   // today's daily seed
  const old = new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10);
  OLD_DAILY = { ...record('daily', dailySeed(old)), dayKey: old };  // a real daily run from 3 days ago
  CUT = record('arcade', 2, 3000);                                  // the same run stopped at frame 3000 (not over)
});

test('happy path: a real finished run is re-simulated, stored with the server score and stats, and readable', async () => {
  const env = await makeEnv();
  const body = freeBody();
  const r = await post(W, env, body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.score, FREE.score);
  assert.equal(r.body.verified.hash, FREE.hash);
  assert.equal(r.body.verified.frames, FREE.frames);
  assert.equal(r.body.placements.all, 1);
  const b = await get(W, env, '/board?game=starfall&board=all');
  assert.equal(b.status, 200);
  assert.deepEqual(b.body.rows.map((x) => [x.rank, x.name, x.score]), [[1, 'ACE', FREE.score]]);
  const rp = await get(W, env, `/replay/${r.body.id}`);
  assert.equal(rp.status, 200);
  assert.equal(rp.body.replay, FREE.replay);
  assert.deepEqual(rp.body.stats, { hash: FREE.hash, frames: FREE.frames, stage: FREE.stage }); // server numbers
  const rk = await get(W, env, `/rank?game=starfall&playerId=${body.playerId}`);
  assert.equal(rk.status, 200);
  assert.equal(rk.body.best, FREE.score);
});

test('client stats are ignored: the stored stats are what the server re-simulated', async () => {
  const env = await makeEnv();
  const r = await post(W, env, freeBody({ stats: { hash: 'deadbeef', frames: 1, stage: 99 } }));
  assert.equal(r.status, 201);
  const rp = await get(W, env, `/replay/${r.body.id}`);
  assert.deepEqual(rp.body.stats, { hash: FREE.hash, frames: FREE.frames, stage: FREE.stage });
});

test('daily: today\'s daily run is accepted onto the daily board', async () => {
  const env = await makeEnv();
  const day = todayUTC();
  const r = await post(W, env, freeBody({ mode: 'daily', dayKey: day, seed: dailySeed(day), replay: DAILY.replay, score: DAILY.score }));
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.placements.daily, 1);
  const b = await get(W, env, `/board?game=starfall&board=daily&key=${day}`);
  assert.equal(b.body.rows[0].score, DAILY.score);
});

test('attack: inflated claimed score is refused (score_mismatch) and nothing is stored', async () => {
  const env = await makeEnv();
  for (const score of [FREE.score + 1, FREE.score * 10, FREE.score - 5]) {
    const r = await post(W, env, freeBody({ score }));
    assert.equal(r.status, 422);
    assert.equal(r.body.error, 'score_mismatch');
  }
  assert.deepEqual((await get(W, env, '/board?game=starfall')).body.rows, []);
  // the honest claim of the same replay still goes through afterwards (the failed attempts left no claim behind)
  assert.equal((await post(W, env, freeBody())).status, 201);
});

test('attack (Q22): the same run padded with ignored frames is refused (duplicate_result)', async () => {
  const env = await makeEnv();
  assert.equal((await post(W, env, freeBody())).status, 201);
  // flip input bits on the game-over frames, which the sim ignores: a different string with the same result
  const h = decode(FREE.replay);
  const sim = createSim({ seed: h.seed, mode: h.mode });
  let over = -1;
  for (let i = 0; i < h.words.length; i++) { sim.step(h.words[i]); sim.clearEvents(); if (over < 0 && sim.state === 'gameover') over = i; }
  const padded = reencode(FREE.replay, (w) => { for (let i = over + 5; i < w.length; i++) w[i] ^= 1; });
  assert.notEqual(padded, FREE.replay);
  const r = await post(W, env, freeBody({ replay: padded })); // a different playerId too
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'duplicate_result');
  assert.equal((await get(W, env, '/board?game=starfall&unique=false')).body.rows.length, 1);
});

test('attack: the identical replay string again is refused (duplicate_replay) before any re-sim', async () => {
  const env = await makeEnv();
  assert.equal((await post(W, env, freeBody())).status, 201);
  const r = await post(W, env, freeBody());
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'duplicate_replay');
});

test('attack: truncated replays are refused (bad_replay or run_not_finished)', async () => {
  const env = await makeEnv();
  // cut in the middle of the encoded body: the string no longer decodes cleanly
  for (const cut of [FREE.replay.slice(0, FREE.replay.length - 1), FREE.replay.slice(0, FREE.replay.length - 3), FREE.replay.slice(0, 40)]) {
    const r = await post(W, env, freeBody({ replay: cut }));
    assert.equal(r.status, 422, cut.length + ' ' + JSON.stringify(r.body));
    assert.ok(['bad_replay', 'run_not_finished'].includes(r.body.error), r.body.error);
  }
  // a clean prefix of the run (recorded to frame 3000, still alive): refused, the run is not over
  let r = await post(W, env, freeBody({ replay: CUT.replay, score: CUT.score }));
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'run_not_finished');
  // cut right after the last point scored (the other near-copy case): same score, not over
  const h = decode(FREE.replay);
  const sim = createSim({ seed: h.seed, mode: h.mode });
  let last = 0;
  for (let i = 0; i < h.words.length; i++) { const s = sim.score; sim.step(h.words[i]); sim.clearEvents(); if (sim.score !== s) last = i; }
  const short = encode(h, h.words.subarray(0, last + 1));
  r = await post(W, env, freeBody({ replay: short }));
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'run_not_finished');
});

test('attack: frames after the end of the run are refused (frames_after_end)', async () => {
  const env = await makeEnv();
  const h = decode(FREE.replay);
  const longer = new Uint16Array(h.words.length + 60); longer.set(h.words); longer.fill(5, h.words.length);
  const r = await post(W, env, freeBody({ replay: encode(h, longer) }));
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'frames_after_end');
});

test('attack: a replay from an older GAME_VERSION is refused (wrong_version)', async () => {
  const env = await makeEnv();
  const old = FREE.replay.replace(`~${GAME_VERSION}~`, '~2.4~');
  let r = await post(W, env, freeBody({ replay: old, version: '2.4' }));
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'wrong_version');
  r = await post(W, env, freeBody({ version: '2.4' })); // current replay, old claim
  assert.equal(r.body.error, 'wrong_version');
  r = await post(W, env, freeBody({ replay: old })); // old replay, current claim
  assert.equal(r.body.error, 'wrong_version');
});

test('attack: a daily claim outside the day window is refused (bad_day); wrong seed or mode too', async () => {
  const env = await makeEnv();
  const d = OLD_DAILY;
  let r = await post(W, env, freeBody({ mode: 'daily', dayKey: d.dayKey, seed: dailySeed(d.dayKey), replay: d.replay, score: d.score }));
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'bad_day');
  const future = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
  r = await post(W, env, freeBody({ mode: 'daily', dayKey: future, seed: dailySeed(today()), replay: DAILY.replay, score: DAILY.score }));
  assert.ok(['bad_day', 'bad_seed'].includes(r.body.error), r.body.error);
  r = await post(W, env, freeBody({ mode: 'daily', seed: dailySeed(today()), replay: DAILY.replay, score: DAILY.score })); // no dayKey
  assert.equal(r.body.error, 'bad_day');
  r = await post(W, env, freeBody({ mode: 'daily', dayKey: today(), seed: 2 })); // a free-play replay claimed as daily
  assert.equal(r.body.error, 'bad_mode');
  r = await post(W, env, freeBody({ seed: 3 })); // seed that is not the replay's
  assert.equal(r.body.error, 'bad_seed');
  assert.deepEqual((await get(W, env, '/board?game=starfall')).body.rows, []);
});
const today = () => todayUTC();

test('attack: a 10 MB body is refused (body_too_large) without being read whole', async () => {
  const env = await makeEnv();
  const big = 'x'.repeat(10 * 1024 * 1024);
  let r = await post(W, env, big);
  assert.equal(r.status, 413);
  assert.equal(r.body.error, 'body_too_large');
  // no content-length header (streamed): the reader stops at the cap
  let pulled = 0;
  const stream = new ReadableStream({ pull(c) { if (pulled >= 10 * 1024 * 1024) { c.close(); return; } pulled += 65536; c.enqueue(new Uint8Array(65536).fill(120)); } });
  const res = await W.fetch(new Request('https://lb.test/submit', { method: 'POST', body: stream, duplex: 'half', headers: { 'cf-connecting-ip': '192.0.2.1' } }), env);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'body_too_large');
  assert.ok(pulled <= LIMITS.bodyBytes + 3 * 65536, `read ${pulled} bytes`);
  // a replay over the leaderboard's MAX_REPLAY_CHARS cap inside a body under the byte cap
  r = await post(W, env, freeBody({ replay: 'r1~starfall~2.5~2~arcade~' + 'A'.repeat(MAX_REPLAY_CHARS + 1) }));
  assert.equal(r.status, 413);
  assert.equal(r.body.error, 'replay_too_large');
});

test('attack: a burst of 100 submits from one address is cut off at the per-IP limit (rate_limited)', async () => {
  const env = await makeEnv();
  const rs = await Promise.all(Array.from({ length: 100 }, () => post(W, env, '{}', { ip: '192.0.2.50' })));
  const limited = rs.filter((r) => r.status === 429);
  assert.equal(rs.length - limited.length, LIMITS.ipPerWindow);
  assert.equal(limited.length, 100 - LIMITS.ipPerWindow);
  assert.ok(limited.every((r) => r.body.error === 'rate_limited' && Number(r.headers.get('retry-after')) > 0));
  // another address is not affected
  assert.equal((await post(W, env, '{}', { ip: '192.0.2.51' })).body.error, 'bad_game');
});

test('attack: one playerId from many addresses is cut off at the per-player limit; the window resets', async () => {
  const env = await makeEnv();
  let t = Date.UTC(2026, 9, 29, 12, 0, 0);
  const w = createWorker({ now: () => t });
  const id = 'burst-player-01';
  const body = freeBody({ playerId: id, version: '2.4' }); // refused cheaply after the rate check
  const rs = [];
  for (let i = 0; i < 100; i++) rs.push(await post(w, env, body, { ip: `10.0.${i >> 8}.${i & 255}` }));
  assert.equal(rs.filter((r) => r.body.error === 'wrong_version').length, LIMITS.pidPerWindow);
  assert.equal(rs.filter((r) => r.body.error === 'rate_limited').length, 100 - LIMITS.pidPerWindow);
  t += LIMITS.windowMs;
  assert.equal((await post(w, env, body, { ip: '10.9.9.9' })).body.error, 'wrong_version');
});

test('attack: SQL injection in name, playerId and query strings is refused and the tables are intact', async () => {
  const env = await makeEnv();
  assert.equal((await post(W, env, freeBody({ name: 'AAA' }))).status, 201);
  const evil = ["x'); DROP TABLE kv;--", "' OR '1'='1", 'Robert"; DELETE FROM results; --'];
  for (const s of evil) {
    assert.equal((await post(W, env, freeBody({ name: s }))).body.error, 'bad_name');
    assert.equal((await post(W, env, freeBody({ playerId: s }))).body.error, 'bad_player');
    assert.equal((await get(W, env, `/rank?game=starfall&playerId=${encodeURIComponent(s)}`)).body.error, 'bad_player');
    assert.equal((await get(W, env, `/board?game=${encodeURIComponent('starfall' + s)}`)).body.error, 'bad_game');
    assert.equal((await get(W, env, `/board?game=starfall&key=${encodeURIComponent(s)}&board=daily`)).body.error, 'bad_board');
    assert.equal((await get(W, env, `/replay/${encodeURIComponent(s)}`)).status, 404);
  }
  assert.equal((await get(W, env, '/board?game=starfall&limit=1;DROP')).body.error, 'bad_board');
  const tables = env.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  assert.deepEqual(tables, ['board', 'board_size', 'flagged', 'hidden', 'kv', 'locks', 'players', 'rate', 'ratings', 'replays', 'results', 'season_runs', 'seen']); // flagged: held near-copies (w18-lb-server-fix2); the rest are the SQL boards
  assert.equal((await get(W, env, '/board?game=starfall')).body.rows.length, 1);
});

test('attack: a replay that would run the sim for MAX_FRAMES is refused before simulating (replay_too_long)', async () => {
  const env = await makeEnv();
  const hdr = { game: GAME_ID, version: GAME_VERSION, seed: 2, mode: 'arcade' };
  const huge = encodeRuns(hdr, Uint16Array.of(0), Uint32Array.of(MAX_FRAMES), 1); // 2^26 frames in a few bytes
  const t0 = performance.now();
  let r = await post(W, env, freeBody({ replay: huge, score: 1 }));
  assert.equal(r.status, 422);
  assert.equal(r.body.error, 'replay_too_long');
  assert.ok(performance.now() - t0 < 1000, 'refused fast');
  r = await post(W, env, freeBody({ replay: encodeRuns(hdr, Uint16Array.of(0), Uint32Array.of(MAX_RUN_FRAMES + 1), 1), score: 1 }));
  assert.equal(r.body.error, 'replay_too_long');
  // many runs that add up past the engine's own MAX_FRAMES
  r = await post(W, env, freeBody({ replay: encodeRuns(hdr, Uint16Array.of(0, 1, 0), Uint32Array.of(MAX_FRAMES, MAX_FRAMES, MAX_FRAMES), 3), score: 1 }));
  assert.equal(r.body.error, 'replay_too_long');
});

test('bad input: not JSON, non-canonical replay, wrong game, unknown routes, methods, CORS preflight', async () => {
  const env = await makeEnv();
  assert.equal((await post(W, env, '{not json')).body.error, 'bad_json');
  assert.equal((await post(W, env, freeBody({ replay: FREE.replay + ' ' }))).body.error, 'bad_replay');
  assert.equal((await post(W, env, freeBody({ game: 'other' }))).body.error, 'bad_game');
  assert.equal((await post(W, env, freeBody({ replay: FREE.replay.replace('~arcade~', '~stage5~') }))).body.error, 'bad_mode');
  assert.equal((await get(W, env, '/nope')).status, 404);
  assert.equal((await get(W, env, '/submit')).status, 405);
  const pre = await W.fetch(new Request('https://lb.test/submit', { method: 'OPTIONS' }), env);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  const res = await W.fetch(new Request('https://lb.test/board?game=starfall'), { ...env, ALLOWED_ORIGIN: 'https://retro-arcade.pages.dev' });
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://retro-arcade.pages.dev');
  const noDb = await W.fetch(new Request('https://lb.test/board?game=starfall'), {});
  assert.equal(noDb.status, 500);
  assert.equal((await noDb.json()).error, 'server_error');
});

test('the default export is a Worker module with fetch(request, env)', async () => {
  const env = await makeEnv();
  assert.equal(typeof worker.fetch, 'function');
  const r = await get(worker, env, '/board?game=starfall&board=season');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.rows, []);
});
