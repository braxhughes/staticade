// w18 review follow-up (w18-lb-server-fix): the near-copy check, plus the review's test gaps, through the real
// entry point worker.fetch(new Request(...), env) on the node:sqlite D1 shim.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { decode, encode } from '../engine/replay.js';
import { dailySeed } from '../engine/rng.js';
import { createSim, GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { similarity, signatureRecorder, NEAR } from '../server/dedupe.js';
import { ipKey, LIMITS } from '../server/worker.js';
import { record, playScripted, makeEnv, post, get, createWorker } from '../server/fixtures.mjs';

const DAY = 86400000;
let VICTIM; // tools/record-replay.mjs arcade seed 2: 4239 frames, score 33995 (the run the reviewer copied)
let n = 0;
const pid = () => `dedupe-${String(++n).padStart(4, '0')}`;
const ip = () => `198.18.${n >> 8}.${n & 255}`;
const body = (over = {}) => ({ game: GAME_ID, playerId: pid(), name: 'ACE', score: VICTIM.score, replay: VICTIM.replay, seed: 2, mode: 'free', version: GAME_VERSION, ...over });
const rows = (env, q = '') => env.DB.raw.prepare('SELECT COUNT(*) AS n FROM ' + q).get().n;
function resim(replay) {
  const h = decode(replay), sim = createSim({ seed: h.seed, mode: h.mode }), rec = signatureRecorder();
  let i = 0;
  for (; i < h.words.length && !sim.done; i++) { const b = sim.score; sim.step(h.words[i]); sim.clearEvents(); rec.add(sim.frame, b, sim.score); }
  return { finished: sim.done && i === h.words.length, score: sim.score, hash: sim.stateHash(), sig: rec.sig };
}
const flip = (replay, frame, bit) => { const h = decode(replay); const w = Uint16Array.from(h.words); w[frame] ^= bit; return encode(h, w); };

before(() => { VICTIM = record('arcade', 2); });

// The 19 frames of the victim run where flipping fire-press (0x400) keeps a finished run with the same score but
// changes the final state hash: the reviewer's MED1 attack (found by trying every frame, 2026-10-29, GAME_VERSION 2.5).
const REVIEW_FRAMES = [412, 587, 588, 589, 909, 954, 999, 1044, 1089, 1134, 1179, 1195, 1196, 1224, 1269, 1598, 2653, 3085, 3086];

test('MED1: the reviewer\'s one-bit copies of a fetched replay are held for review, not stored; the board keeps one row', async () => {
  const env = await makeEnv();
  const W = createWorker();
  const first = await post(W, env, body(), { ip: ip() });
  assert.equal(first.status, 201);
  const fetched = await get(W, env, `/replay/${first.body.id}`); // the attacker downloads the victim's run
  assert.equal(fetched.status, 200);
  const base = resim(fetched.body.replay);
  const heldIds = new Set(), hashes = new Set();
  for (const f of REVIEW_FRAMES) {
    const copy = flip(fetched.body.replay, f, 0x400);
    const r0 = resim(copy); // the attack's premise: a finished run, same score, new final hash (the old key missed it)
    assert.ok(r0.finished && r0.score === base.score && r0.hash !== base.hash, `frame ${f}: not the reviewer's case`);
    const r = await post(W, env, body({ replay: copy, name: 'THF' }), { ip: ip() });
    assert.equal(r.status, 202, `frame ${f}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'held_for_review');
    heldIds.add(r.body.heldId); hashes.add(r0.hash);
  }
  const board = await get(W, env, '/board?game=starfall&unique=false&limit=50');
  assert.deepEqual(board.body.rows.map((x) => [x.name, x.score]), [['ACE', VICTIM.score]]);
  assert.equal(rows(env, 'results'), 1); // held copies leave no claim behind
  // held once per distinct result (some flips end in the same final state), none on a board
  assert.equal(heldIds.size, hashes.size);
  assert.equal(rows(env, "flagged WHERE status = 'flagged'"), hashes.size);
});

test('MED1: copies sent at the same moment as the original: exactly one is stored', async () => {
  const env = await makeEnv();
  const W = createWorker();
  const copies = [VICTIM.replay, ...REVIEW_FRAMES.slice(0, 4).map((f) => flip(VICTIM.replay, f, 0x400))];
  const rs = await Promise.all(copies.map((replay) => post(W, env, body({ replay }), { ip: ip() })));
  assert.equal(rs.filter((r) => r.status === 201).length, 1, JSON.stringify(rs.map((r) => r.body.error ?? r.status)));
  assert.ok(rs.filter((r) => r.status !== 201).every((r) => (r.status === 202 && r.body.code === 'held_for_review') || (r.status === 409 && r.body.error === 'duplicate_result')),
    JSON.stringify(rs.map((r) => r.body.code ?? r.body.error ?? r.status)));
  assert.equal((await get(W, env, '/board?game=starfall&unique=false')).body.rows.length, 1);
});

test('two different honest runs with the same score on the same seed are both accepted', async () => {
  const env = await makeEnv();
  const W = createWorker();
  const a = playScripted(4, 126708, 'lazy'), b = playScripted(4, 205898, 'lazy'); // found by server/dedupe-measure.mjs
  assert.equal(a.score, b.score);
  assert.notEqual(a.replay, b.replay);
  assert.ok(similarity(resim(a.replay).sig, resim(b.replay).sig) < NEAR);
  for (const r of [a, b]) {
    const res = await post(W, env, body({ seed: 4, replay: r.replay, score: r.score }), { ip: ip() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  const board = await get(W, env, '/board?game=starfall&unique=false');
  assert.deepEqual(board.body.rows.map((x) => x.score), [a.score, a.score]);
});

test('similarity: honest runs on one seed stay well under NEAR; an edited copy is far over it', () => {
  const runs = [1, 2, 3, 4, 5, 6].map((k) => resim(playScripted(2, k * 7919 + 2, k % 2 ? 'script' : 'lazy').replay));
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) assert.ok(similarity(runs[i].sig, runs[j].sig) < NEAR, `${i} ${j}`);
  const v = resim(VICTIM.replay);
  assert.ok(similarity(v.sig, resim(flip(VICTIM.replay, 412, 0x400)).sig) > 0.9);
  assert.equal(similarity(v.sig, v.sig), 1);
  assert.equal(similarity([1, 10, 2, 10], [1, 10, 2, 10]), 0); // too few events to judge: left to the exact check
});

test('releaseResult: a submit that fails after its claim leaves no claim, and the same run then goes in', async () => {
  const env = await makeEnv();
  const W = createWorker();
  let failOnce = true;
  const real = env.DB;
  const flaky = { ...real, prepare: (sql) => real.prepare(sql), async batch(stmts) {
    if (failOnce) { failOnce = false; throw new Error('disk on fire'); }
    return real.batch(stmts);
  } };
  const r = await post(W, { DB: flaky }, body(), { ip: ip() });
  assert.equal(r.status, 500);
  assert.equal(r.body.error, 'server_error');
  assert.equal(rows(env, 'results'), 0);
  assert.equal((await post(W, env, body(), { ip: ip() })).status, 201);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM results WHERE entry IS NOT NULL').get().n, 1);
});

test('concurrent submits of one replay: exactly one 201', async () => {
  const env = await makeEnv();
  const W = createWorker();
  const rs = await Promise.all(Array.from({ length: 6 }, () => post(W, env, body(), { ip: ip() })));
  assert.equal(rs.filter((r) => r.status === 201).length, 1);
  assert.ok(rs.filter((r) => r.status !== 201).every((r) => r.status === 409 && ['duplicate_replay', 'duplicate_result'].includes(r.body.error)),
    JSON.stringify(rs.map((r) => r.body.error ?? r.status)));
});

test('daily window edges: days -1, 0 and +1 are accepted, -2 and +2 refused (bad_day)', async () => {
  const env = await makeEnv();
  const T = Date.UTC(2026, 9, 29, 12, 0, 0);
  const W = createWorker({ now: () => T });
  for (const [d, ok] of [[-2, false], [-1, true], [0, true], [1, true], [2, false]]) {
    const day = new Date(T + d * DAY).toISOString().slice(0, 10);
    const run = record('daily', dailySeed(day));
    const r = await post(W, env, body({ mode: 'daily', dayKey: day, seed: dailySeed(day), replay: run.replay, score: run.score }), { ip: ip() });
    if (ok) assert.equal(r.status, 201, `${d}: ${JSON.stringify(r.body)}`);
    else { assert.equal(r.status, 422, String(d)); assert.equal(r.body.error, 'bad_day'); }
  }
});

test('sweepRate: old rate windows are dropped by a later submit, once per window, not on every request', async () => {
  const env = await makeEnv();
  let t = Date.UTC(2026, 9, 29, 0, 0, 0);
  const W = createWorker({ now: () => t });
  await post(W, env, '{}', { ip: '192.0.2.10' });
  assert.equal(rows(env, 'rate'), 1);
  t += 2 * LIMITS.windowMs;
  await post(W, env, '{}', { ip: '192.0.2.11' }); // first request of a new window: sweeps the old row
  assert.deepEqual(env.DB.raw.prepare('SELECT k FROM rate').all().map((x) => x.k), ['ip:192.0.2.11']);
  env.DB.raw.prepare("INSERT INTO rate (k, win, n) VALUES ('ip:old', 1, 1)").run();
  await post(W, env, '{}', { ip: '192.0.2.12' }); // same window: no sweep this time
  assert.equal(rows(env, 'rate'), 3);
  t += LIMITS.windowMs;
  await post(W, env, '{}', { ip: '192.0.2.13' });
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM rate WHERE k = 'ip:old'").get().n, 0);
  const idx = env.DB.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'rate_win'").all();
  assert.equal(idx.length, 1);
});

test('IPv6 rate limits count per /64; IPv4 per address', async () => {
  assert.equal(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:DB8:0001:0002::1'), '2001:db8:1:2::/64');
  assert.equal(ipKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(ipKey('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(ipKey('203.0.113.9'), '203.0.113.9');
  const env = await makeEnv();
  const W = createWorker();
  const rs = [];
  for (let i = 0; i < LIMITS.ipPerWindow + 5; i++) rs.push(await post(W, env, '{}', { ip: `2001:db8:5:6::${(i + 1).toString(16)}` }));
  assert.equal(rs.filter((r) => r.body.error === 'rate_limited').length, 5);
  assert.equal((await post(W, env, '{}', { ip: '2001:db8:5:7::1' })).body.error, 'bad_game'); // the next /64 is its own
});

test('fuzz: 150 garbage and mutated submits never give a 500', async () => {
  const env = await makeEnv();
  const W = createWorker();
  let x = 12345;
  const rnd = (m) => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return (x >>> 8) % m; };
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_~.!';
  const junk = [null, 0, -1, 1e308, NaN, '', 'x', [], {}, true, '\u0000', 'r1~starfall', { a: 1 }];
  const statuses = new Map();
  for (let i = 0; i < 150; i++) {
    let b;
    const kind = i % 3;
    if (kind === 0) { // mutate a few characters of the real replay
      const c = VICTIM.replay.split('');
      for (let k = 0; k <= rnd(4); k++) c[rnd(c.length)] = B64[rnd(B64.length)];
      b = body({ replay: c.join('') });
    } else if (kind === 1) { // a random field set to junk
      const keys = Object.keys(body());
      b = body({ [keys[rnd(keys.length)]]: junk[rnd(junk.length)] });
    } else { // a random string as the whole body
      b = Array.from({ length: rnd(200) }, () => B64[rnd(B64.length)]).join('');
    }
    const r = await post(W, env, b, { ip: ip() });
    assert.notEqual(r.status, 500, JSON.stringify(r.body));
    assert.equal(typeof r.body.ok, 'boolean');
    statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
  }
  assert.ok(statuses.size >= 3, JSON.stringify([...statuses]));
});

// w18-lb-server-fix2: the threshold pinned on both sides, near copies held (not thrown away), and the owner's release.
// Runs built from the victim: its first F input frames as given, then a scripted player with its own input seed.
// F picks how much of the opening the two runs share, so how alike they are (similarity measured and asserted).
const splice = (F, inSeed) => playScripted(2, inSeed, 'script', 'arcade', decode(VICTIM.replay).words.slice(0, F));
const TOKEN = 'test-admin-token-0123456789abcdef';
const admin = (W, env, b, token = TOKEN) => W.fetch(new Request('https://lb.test/admin/release', { method: 'POST',
  headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.99', ...(token && { authorization: `Bearer ${token}` }) },
  body: JSON.stringify(b) }), env).then(async (r) => ({ status: r.status, body: await r.json() }));
const scores = async (W, env) => (await get(W, env, '/board?game=starfall&unique=false&limit=50')).body.rows.map((x) => x.score);

test('threshold, honest side: two runs about 35% alike (a shared opening) are both accepted onto the board', async () => {
  const b = splice(1700, 12 * 7919 + 1700);
  const s = similarity(resim(VICTIM.replay).sig, resim(b.replay).sig);
  assert.ok(s >= 0.30 && s <= 0.40, `measured ${s}`);
  assert.ok(b.score >= VICTIM.score / 2 && b.score <= VICTIM.score * 2, 'inside the near check score window, so it is compared');
  const env = await makeEnv();
  const W = createWorker();
  assert.equal((await post(W, env, body(), { ip: ip() })).status, 201);
  const r = await post(W, env, body({ replay: b.replay, score: b.score, name: 'BEE' }), { ip: ip() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual((await scores(W, env)).sort(), [VICTIM.score, b.score].sort());
  assert.equal(rows(env, 'flagged'), 0);
});

test('threshold, copy side: a copy about 70% alike is held for review: no board row, no trophies, then released', async () => {
  const c = splice(2300, 12 * 7919 + 2300);
  const s = similarity(resim(VICTIM.replay).sig, resim(c.replay).sig);
  assert.ok(s >= 0.65 && s <= 0.75, `measured ${s}`);
  const env = { ...(await makeEnv()), ADMIN_TOKEN: TOKEN };
  const W = createWorker();
  const first = await post(W, env, body(), { ip: ip() });
  assert.equal(first.status, 201);
  const thief = pid();
  const r = await post(W, env, body({ playerId: thief, replay: c.replay, score: c.score, name: 'CPY' }), { ip: ip() });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.code, 'held_for_review');
  assert.match(r.body.message, /held for review/);
  assert.deepEqual(await scores(W, env), [VICTIM.score]);
  assert.deepEqual((await get(W, env, '/board?game=starfall&board=season&unique=false')).body.rows.length, 1);
  const rank0 = (await get(W, env, `/rank?game=starfall&playerId=${thief}`)).body;
  assert.equal(rank0.trophies, 0);
  assert.equal(rank0.best, 0);
  const held = env.DB.raw.prepare('SELECT * FROM flagged').all();
  assert.equal(held.length, 1);
  assert.equal(held[0].id, r.body.heldId);
  assert.equal(held[0].status, 'flagged');
  assert.equal(held[0].near_entry, first.body.id);
  assert.ok(Math.abs(held[0].similarity - s) < 1e-9);
  assert.equal(held[0].score, c.score);
  // the same run again: held once, same id
  const again = await post(W, env, body({ playerId: thief, replay: c.replay, score: c.score, name: 'CPY' }), { ip: ip() });
  assert.equal(again.body.heldId, r.body.heldId);
  assert.equal(rows(env, 'flagged'), 1);
  // release: no token, wrong token, bad id are refused; the right token puts it on the board once
  assert.equal((await admin(W, env, { id: r.body.heldId }, null)).status, 401);
  assert.equal((await admin(W, env, { id: r.body.heldId }, TOKEN + 'x')).status, 401);
  assert.equal((await admin(W, env, { id: 999 })).status, 404);
  assert.equal((await admin(W, env, { id: '1' })).status, 400);
  assert.equal((await admin(W, { DB: env.DB }, { id: r.body.heldId })).status, 404); // no ADMIN_TOKEN set: the route is off
  const rel = await admin(W, env, { id: r.body.heldId });
  assert.equal(rel.status, 201, JSON.stringify(rel.body));
  assert.deepEqual((await scores(W, env)).sort(), [VICTIM.score, c.score].sort());
  assert.equal((await get(W, env, `/rank?game=starfall&playerId=${thief}`)).body.best, c.score);
  assert.equal(env.DB.raw.prepare('SELECT status FROM flagged').get().status, 'released');
  assert.equal((await admin(W, env, { id: r.body.heldId })).status, 409);
  assert.equal((await scores(W, env)).length, 2);
  // released, it is a stored run like any other: the exact run again is a duplicate
  assert.equal((await post(W, env, body({ replay: c.replay, score: c.score }), { ip: ip() })).body.error, 'duplicate_replay');
});

test('TOL: scoring moments up to 4 frames apart count as the same moment, 5 apart do not', () => {
  const v = resim(VICTIM.replay).sig;
  const shift = (d) => v.map((x, i) => (i % 2 === 0 ? x + d : x));
  assert.equal(similarity(v, shift(4)), 1);
  assert.equal(similarity(v, shift(-4)), 1);
  assert.ok(similarity(v, shift(2)) >= NEAR); // a copy whose kills land a frame or two late is still a copy
  const even = Array.from({ length: 40 }, (_, i) => [100 + i * 50, 100]).flat(); // moments 50 frames apart
  const evenShift = (d) => even.map((x, i) => (i % 2 === 0 ? x + d : x));
  assert.equal(similarity(even, evenShift(4)), 1);
  assert.equal(similarity(even, evenShift(5)), 0);
});

test('held cap: past LIMITS.heldCap waiting runs, a new near copy is refused (near_duplicate) instead of held', async () => {
  const env = await makeEnv();
  const W = createWorker({ limits: { heldCap: 1 } });
  assert.equal((await post(W, env, body(), { ip: ip() })).status, 201);
  const a = flip(VICTIM.replay, REVIEW_FRAMES[0], 0x400);
  const b = REVIEW_FRAMES.map((f) => flip(VICTIM.replay, f, 0x400)).find((x) => resim(x).hash !== resim(a).hash); // a different result
  assert.equal((await post(W, env, body({ replay: a }), { ip: ip() })).status, 202);
  assert.equal((await post(W, env, body({ replay: a }), { ip: ip() })).status, 202); // already held: still answered as held
  const r = await post(W, env, body({ replay: b }), { ip: ip() });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'near_duplicate');
  assert.equal(rows(env, 'flagged'), 1);
  assert.equal((await scores(W, env)).length, 1);
});
