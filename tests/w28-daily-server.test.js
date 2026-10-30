// Card 3c (w28-daily): the Daily's seed comes from the server's secret, a daily submit needs the ticket GET /daily
// gave, a run may not hold more play than real time since that ticket, and only today's or yesterday's daily (UTC)
// is taken. Through the Worker's real entry point (worker.fetch) on node:sqlite, with a clock the test moves.
// The secret is random per run of this file; it is never written anywhere.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { dailySeed } from '../engine/rng.js';
import { createRecorder } from '../engine/replay.js';
import { IDLE_WORD } from '../engine/input-word.js';
import { GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { createModes, memoryKv, makeVerifyReplay, MODE_DAILY, MODE_FREE } from '../games/starfall/modes.js';
import { createSubmitQueue } from '../games/starfall/submit-queue.js';
import { createRemoteLeaderboard } from '../server/client.js';
import { validateSubmission } from '../leaderboard/api.js';
import { makeServerVerifier } from '../server/verify.js';
import { TICKET_SLACK_S } from '../server/daily.js';
import { playScripted, makeEnv, post, createWorker } from '../server/fixtures.mjs';

const SECRET = randomBytes(32).toString('hex');
const OTHER = randomBytes(32).toString('hex');
const H = 3600000, DAY = 24 * H;
const D = '2026-11-02', D_MS = Date.parse(D + 'T00:00:00Z');
const dk = ms => new Date(ms).toISOString().slice(0, 10);
// the seed formula written out again here (node:crypto, not server/daily.js), so the test checks the contract
const hmacSeed = (secret, day, game = GAME_ID) => createHmac('sha256', secret).update(`daily:${game}:${day}`).digest().readUInt32BE(0);

let N = 0;
const pid = () => `w28-player-${String(++N).padStart(4, '0')}`;
const ip = () => `198.51.100.${(N % 250) + 1}`;
const RUNS = new Map(); // `${secret}|${day}` -> a finished scripted daily on that day's seed
function runOn(seed) { const k = String(seed); if (!RUNS.has(k)) RUNS.set(k, playScripted(seed, 7, 'script', 'daily')); return RUNS.get(k); }

function clocked(t) { const c = { t }; c.W = createWorker({ now: () => c.t }); return c; }
async function env(secret = SECRET) { const e = await makeEnv(); if (secret !== null) e.DAILY_SECRET = secret; return e; }
async function daily(W, e, { player, game = GAME_ID, addr = '203.0.113.50', method = 'GET' } = {}) {
  const headers = { 'cf-connecting-ip': addr };
  if (player) headers['x-player-id'] = player;
  const r = await W.fetch(new Request(`https://lb.test/daily?game=${game}`, { method, headers }), e);
  return { status: r.status, headers: r.headers, body: await r.json() };
}
const dailyBody = (run, over) => ({ game: GAME_ID, name: 'ACE', score: run.score, replay: run.replay, mode: 'daily', version: GAME_VERSION, ...over });
// ask for a ticket at time t, then submit at time t + after ms (the run on the seed /daily gave unless seed is given)
async function ticketThenSubmit({ e, c, t, after, player = pid(), seed, over = {} }) {
  c.t = t;
  const d = await daily(c.W, e, { player, addr: ip() });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  const s = seed ?? d.body.seed;
  const run = runOn(s);
  c.t = t + (typeof after === 'function' ? after(run) : after);
  const r = await post(c.W, e, dailyBody(run, { playerId: player, seed: s, dayKey: d.body.dayKey, ticket: d.body.ticket, ...over }), { ip: ip() });
  return { d, run, r, player };
}
const playTime = run => Math.ceil(run.frames / 60 * 1000); // ms of real time the run takes at 60 frames a second

before(() => { runOn(hmacSeed(SECRET, D)); runOn(hmacSeed(SECRET, dk(D_MS - DAY))); runOn(dailySeed(D)); });

test('seed: deterministic per secret and day, differs across secrets and days, is not the public seed', async () => {
  const a = clocked(D_MS + 12 * H), b = clocked(D_MS + 20 * H); // two Worker copies, two times of the same day
  const e1 = await env(), e2 = await env(), eo = await env(OTHER);
  const s1 = (await daily(a.W, e1, { player: pid() })).body, s2 = (await daily(b.W, e2, { player: pid() })).body;
  assert.equal(s1.dailySecret, true);
  assert.equal(s1.dayKey, D);
  assert.equal(s1.seed, hmacSeed(SECRET, D), 'uint32 from the first 4 bytes of HMAC-SHA256(secret, "daily:starfall:<day>")');
  assert.equal(s2.seed, s1.seed, 'same secret, same day: same seed for everyone');
  assert.notEqual((await daily(a.W, eo, { player: pid() })).body.seed, s1.seed, 'another secret: another seed');
  assert.notEqual(s1.seed, dailySeed(D), 'not the public seed anyone can compute');
  a.t = D_MS + DAY + 1;
  const next = (await daily(a.W, e1, { player: pid() })).body;
  assert.equal(next.dayKey, dk(D_MS + DAY));
  assert.equal(next.seed, hmacSeed(SECRET, next.dayKey));
  assert.notEqual(next.seed, s1.seed, 'a new day: a new seed');
  assert.ok(Number.isInteger(s1.seed) && s1.seed >= 0 && s1.seed <= 0xffffffff);
});

test('/daily with a secret: one ticket per player and time, the player header is required, nothing secret in the answer', async () => {
  const c = clocked(D_MS + 9 * H), e = await env();
  const p1 = pid(), p2 = pid();
  const r1 = await daily(c.W, e, { player: p1 });
  assert.equal(r1.status, 200);
  assert.deepEqual(Object.keys(r1.body).sort(), ['dailySecret', 'dayKey', 'game', 'issuedAt', 'ok', 'seed', 'ticket']);
  assert.equal(r1.body.issuedAt, c.t, 'issuedAt is the server clock');
  assert.match(r1.body.ticket, /^[0-9a-z]{1,11}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(parseInt(r1.body.ticket.split('.')[0], 36), c.t, 'the ticket carries its issuedAt');
  assert.ok(!JSON.stringify(r1.body).includes(SECRET), 'the secret is never in an answer');
  assert.equal(r1.headers.get('access-control-allow-headers'), 'content-type, x-player-id', 'the browser may send the player header');
  const r2 = await daily(c.W, e, { player: p2 });
  assert.equal(r2.body.seed, r1.body.seed);
  assert.notEqual(r2.body.ticket, r1.body.ticket, 'tickets are per player');
  const none = await daily(c.W, e, {});
  assert.deepEqual([none.status, none.body.error], [400, 'bad_player']);
  const badPid = await daily(c.W, e, { player: 'x y' });
  assert.deepEqual([badPid.status, badPid.body.error], [400, 'bad_player']);
  const game = await daily(c.W, e, { player: p1, game: 'other' });
  assert.deepEqual([game.status, game.body.error], [400, 'bad_game']);
  const pst = await daily(c.W, e, { player: p1, method: 'POST' });
  assert.deepEqual([pst.status, pst.body.error], [405, 'method_not_allowed']);
});

test('a daily with its ticket, sent after the run could really have been played, is accepted and lands on the day board', async () => {
  const c = clocked(D_MS + 10 * H), e = await env();
  const { r, run } = await ticketThenSubmit({ e, c, t: D_MS + 10 * H, after: run => playTime(run) + 2000 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.score, run.score);
  assert.ok(r.body.placements.daily >= 1);
  const b = await c.W.fetch(new Request(`https://lb.test/board?game=starfall&board=daily&key=${D}`), e).then(x => x.json());
  assert.deepEqual(b.rows.map(x => [x.name, x.score]), [['ACE', run.score]]);
});

test('missing, bad, forged, another player\'s, another day\'s and another secret\'s tickets are refused with bad_ticket', async () => {
  const t = D_MS + 11 * H, c = clocked(t), e = await env();
  const p = pid();
  const d = (await daily(c.W, e, { player: p })).body;
  const run = runOn(d.seed);
  c.t = t + playTime(run) + 5000;
  const send = (over, player = p) => post(c.W, e, dailyBody(run, { playerId: player, seed: d.seed, dayKey: D, ticket: d.ticket, ...over }), { ip: ip() });
  const [ts, mac] = d.ticket.split('.');
  const flip = mac.slice(0, 10) + (mac[10] === 'A' ? 'B' : 'A') + mac.slice(11);
  // another player's ticket
  const other = (await daily(c.W, e, { player: pid() })).body.ticket;
  // a ticket made with another secret by a server with the same clock
  const eo = await env(OTHER), co = clocked(t);
  const foreign = (await daily(co.W, eo, { player: p })).body.ticket;
  // yesterday's ticket for this player
  const cy = clocked(t - DAY);
  const yest = (await daily(cy.W, e, { player: p })).body.ticket;
  const cases = [
    ['missing', { ticket: undefined }], ['null', { ticket: null }], ['empty', { ticket: '' }], ['number', { ticket: 12345 }],
    ['garbage', { ticket: 'not-a-ticket' }], ['too long', { ticket: d.ticket + 'x'.repeat(60) }],
    ['one MAC character changed', { ticket: ts + '.' + flip }],
    ['issuedAt moved one hour earlier (more time to play)', { ticket: (parseInt(ts, 36) - H).toString(36) + '.' + mac }],
    ['issuedAt with a leading zero', { ticket: '0' + ts + '.' + mac }],
    ['another player\'s ticket', { ticket: other }],
    ['another secret\'s ticket', { ticket: foreign }],
    ['yesterday\'s ticket on today\'s daily', { ticket: yest }],
  ];
  for (const [name, over] of cases) {
    const r = await send(over);
    assert.deepEqual([r.status, r.body.error], [422, 'bad_ticket'], name + ': ' + JSON.stringify(r.body));
  }
  // the right ticket under another playerId
  const r = await send({}, pid());
  assert.deepEqual([r.status, r.body.error], [422, 'bad_ticket'], 'ticket bound to its player');
  // and the real one still works (nothing above used it up). 13 sends for this player: wait out the 12-per-10-minutes limit
  c.t += 600000;
  const ok = await send({});
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test(`real time: a run longer than the time since its ticket plus ${TICKET_SLACK_S} s is refused; within it, accepted`, async () => {
  const t = D_MS + 13 * H, e = await env();
  const tooSoon = await ticketThenSubmit({ e, c: clocked(t), t, after: run => playTime(run) - (TICKET_SLACK_S + 3) * 1000 });
  assert.deepEqual([tooSoon.r.status, tooSoon.r.body.error], [422, 'bad_ticket'], JSON.stringify(tooSoon.r.body));
  const inSlack = await ticketThenSubmit({ e, c: clocked(t), t, after: run => playTime(run) - (TICKET_SLACK_S - 2) * 1000 });
  assert.equal(inSlack.r.status, 201, 'within the stated slack: ' + JSON.stringify(inSlack.r.body));
  // the reviewer's attack: a 20-minute daily sent 1 minute after its ticket (refused before any re-sim)
  const c = clocked(t), p = pid();
  const d = (await daily(c.W, e, { player: p })).body;
  const rec = createRecorder(64);
  for (let f = 0; f < 20 * 60 * 60; f++) rec.push(IDLE_WORD);
  const long = rec.encode({ game: GAME_ID, version: GAME_VERSION, seed: d.seed, mode: 'daily' });
  c.t = t + 60000;
  const r = await post(c.W, e, { game: GAME_ID, playerId: p, name: 'ACE', score: 1000, replay: long, seed: d.seed, mode: 'daily', dayKey: D, version: GAME_VERSION, ticket: d.ticket }, { ip: ip() });
  assert.deepEqual([r.status, r.body.error], [422, 'bad_ticket'], JSON.stringify(r.body));
});

test('day window with a secret: 23:59 run sent at 00:01 (yesterday) accepted; two days ago refused; tomorrow refused', async () => {
  const e = await env();
  // ticket at 23:59:00 on D-1, run sent after midnight on D: at 00:01:00, or once the run could have been played
  // (the seed comes from a random secret, so the run's length differs from one test run to the next)
  const y = await ticketThenSubmit({ e, c: clocked(0), t: D_MS - 60000, after: run => Math.max(120000, playTime(run) + 2000) });
  assert.equal(y.d.body.dayKey, dk(D_MS - DAY));
  assert.equal(y.r.status, 201, 'yesterday is taken: ' + JSON.stringify(y.r.body));
  // ticket on D-2 at noon, run sent on D at noon
  const old = await ticketThenSubmit({ e, c: clocked(0), t: D_MS - 2 * DAY + 12 * H, after: 2 * DAY });
  assert.deepEqual([old.r.status, old.r.body.error], [422, 'bad_day'], JSON.stringify(old.r.body));
  // tomorrow: a ticket from a Worker copy whose clock is a day ahead, sent to one on today's clock
  const ahead = clocked(D_MS + DAY + H), now = clocked(D_MS + H + 120000);
  const p = pid();
  const t = (await daily(ahead.W, e, { player: p })).body;
  assert.equal(t.dayKey, dk(D_MS + DAY));
  const run = runOn(t.seed);
  const r = await post(now.W, e, dailyBody(run, { playerId: p, seed: t.seed, dayKey: t.dayKey, ticket: t.ticket }), { ip: ip() });
  assert.equal(r.status, 422, JSON.stringify(r.body));
  assert.ok(['bad_ticket', 'bad_day'].includes(r.body.error));
});

test('verify.js day window with a server seed: today and yesterday only, never tomorrow or two days back', () => {
  const now = D_MS + 12 * H, verify = makeServerVerifier({ now: () => now });
  for (const [day, want] of [[D, null], [dk(D_MS - DAY), null], [dk(D_MS + DAY), 'bad_day'], [dk(D_MS - 2 * DAY), 'bad_day']]) {
    const seed = hmacSeed(SECRET, day), run = runOn(seed);
    const c = validateSubmission({ game: GAME_ID, playerId: 'w28-verify-01', name: 'ACE', score: run.score, replay: run.replay, seed, mode: 'daily', dayKey: day, version: GAME_VERSION });
    let code = null;
    try { verify(c, { seed, issuedAt: now - DAY }); } catch (err) { code = err.code; }
    assert.equal(code, want, day);
  }
});

test('with a secret, a daily on the public seed is refused with bad_seed even with a valid ticket', async () => {
  const e = await env();
  const r = await ticketThenSubmit({ e, c: clocked(0), t: D_MS + 14 * H, after: 120000, seed: dailySeed(D) });
  assert.deepEqual([r.r.status, r.r.body.error], [422, 'bad_seed'], JSON.stringify(r.r.body));
});

test('no secret (dev, tests): /daily gives the public seed and ticket null; daily submits work exactly as before', async () => {
  const t = D_MS + 15 * H, c = clocked(t), e = await env(null);
  const d = await daily(c.W, e, {}); // no player header needed
  assert.equal(d.status, 200);
  assert.deepEqual(d.body, { ok: true, game: GAME_ID, dayKey: D, seed: dailySeed(D), ticket: null, issuedAt: t, dailySecret: false });
  const run = runOn(dailySeed(D));
  c.t = t + 1000; // no real-time check without a secret
  const ok = await post(c.W, e, dailyBody(run, { playerId: pid(), seed: dailySeed(D), dayKey: D }), { ip: ip() });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  // the old window, plus or minus 1 day: tomorrow's public daily is still taken, two days back is not
  const tom = dk(D_MS + DAY), tr = runOn(dailySeed(tom));
  const r1 = await post(c.W, e, dailyBody(tr, { playerId: pid(), seed: dailySeed(tom), dayKey: tom }), { ip: ip() });
  assert.equal(r1.status, 201, 'previous behaviour kept without a secret: ' + JSON.stringify(r1.body));
  const old = dk(D_MS - 2 * DAY), or = runOn(dailySeed(old));
  const r2 = await post(c.W, e, dailyBody(or, { playerId: pid(), seed: dailySeed(old), dayKey: old }), { ip: ip() });
  assert.deepEqual([r2.status, r2.body.error], [422, 'bad_day']);
});

test('a secret that is set but too short: no dailies at all (500), never the public seed', async () => {
  const c = clocked(D_MS + 16 * H), e = await env('short-secret');
  const d = await daily(c.W, e, { player: pid() });
  assert.deepEqual([d.status, d.body.error], [500, 'server_error']);
  const free = playScripted(5, 3);
  const r = await post(c.W, e, { game: GAME_ID, playerId: pid(), name: 'ACE', score: free.score, replay: free.replay, seed: 5, mode: 'free', version: GAME_VERSION }, { ip: ip() });
  assert.deepEqual([r.status, r.body.error], [500, 'server_error'], 'every submit refuses, so the mistake is seen at once (README)');
});

test('/daily is rate limited per address: 60 in 10 minutes, then rate_limited', async () => {
  const c = clocked(D_MS + 17 * H), e = await env();
  for (let i = 0; i < 60; i++) assert.equal((await daily(c.W, e, { player: pid(), addr: '192.0.2.77' })).status, 200, 'call ' + (i + 1));
  const r = await daily(c.W, e, { player: pid(), addr: '192.0.2.77' });
  assert.deepEqual([r.status, r.body.error], [429, 'rate_limited']);
  assert.equal((await daily(c.W, e, { player: pid(), addr: '192.0.2.78' })).status, 200, 'another address is not held');
});

// ---------- the client side (modes.js, client.js, submit-queue.js) ----------
test('modes: a run from the board uses its day, seed and ticket; bad answers throw; remote off keeps the public daily', () => {
  let t = D_MS + 23 * H + 59 * 60000;
  const m = createModes({ lb: null, kv: memoryKv(), now: () => t });
  const ans = { dayKey: D, seed: hmacSeed(SECRET, D), ticket: 'abc.' + 'A'.repeat(43), issuedAt: t };
  const run = m.begin(MODE_DAILY, 0, ans);
  assert.deepEqual([run.mode, run.dayKey, run.seed, run.ticket, run.fromServer], [MODE_DAILY, D, ans.seed, ans.ticket, true]);
  t += 2 * 60000; // past midnight UTC
  assert.equal(m.stale(run), false, 'a board daily is never restarted on this device\'s clock');
  const local = m.begin(MODE_DAILY);
  assert.deepEqual([local.dayKey, local.seed, local.fromServer, local.ticket], [dk(t), dailySeed(dk(t)), undefined, undefined], 'remote off: the public daily, as before');
  assert.equal(m.begin(MODE_FREE, 99).seed, 99);
  const sim = { score: 10, frame: 5, stage: 1, stateHash: () => 'h' };
  assert.equal(m.body(run, sim, 'r', 'ACE', 'pid-00000001').ticket, ans.ticket, 'the submit body carries the ticket');
  assert.equal('ticket' in m.body(local, sim, 'r', 'ACE', 'pid-00000001'), false, 'no ticket on a local daily');
  for (const bad of [null, 5, {}, { ...ans, seed: -1 }, { ...ans, seed: 2 ** 32 }, { ...ans, seed: 1.5 }, { ...ans, seed: '5' }, { ...ans, dayKey: '2026-13-01' },
    { ...ans, dayKey: '2026-02-30' }, { ...ans, ticket: 'x'.repeat(65) }, { ...ans, ticket: '' }, { ...ans, ticket: 7 }]) {
    assert.throws(() => m.begin(MODE_DAILY, 0, bad), /bad daily answer/, JSON.stringify(bad));
  }
  assert.equal(m.begin(MODE_DAILY, 0, { ...ans, ticket: null }).ticket, null, 'a dev server with no secret answers ticket null');
});

test('modes: the game\'s own verifier takes a daily on the seed the board handed out on this page; dailySeedOf pins one seed', () => {
  const day = dk(Date.now()), seed = hmacSeed(SECRET, day), run = runOn(seed);
  const args = { game: GAME_ID, replay: run.replay, seed, mode: 'daily', dayKey: day, version: GAME_VERSION };
  const v = makeVerifyReplay();
  createModes({ lb: null }).begin(MODE_DAILY, 0, { dayKey: day, seed, ticket: null });
  assert.equal(v(args), run.score, 'local board keeps an online daily');
  assert.ok(Number.isNaN(makeVerifyReplay({ dailySeedOf: () => dailySeed(day) })(args)), 'a pinned seed refuses any other');
  assert.equal(makeVerifyReplay({ dailySeedOf: () => seed })(args), run.score);
});

test('client: getDaily asks /daily?game= with the player in a header, never in the URL', async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ ok: true, dayKey: D, seed: 5, ticket: null, issuedAt: 1, dailySecret: false }) }; };
  const R = createRemoteLeaderboard({ url: 'http://127.0.0.1:9/', fetch });
  const d = await R.getDaily({ game: GAME_ID, playerId: 'w28-client-01' });
  assert.deepEqual(d, { dayKey: D, seed: 5, ticket: null, issuedAt: 1, dailySecret: false });
  assert.equal(calls[0].url, 'http://127.0.0.1:9/daily?game=starfall');
  assert.equal(calls[0].init.headers['x-player-id'], 'w28-client-01');
  assert.ok(!calls[0].url.includes('w28-client-01'));
});

test('submit queue: a queued daily keeps its ticket through a reload and sends it', async () => {
  const m = new Map();
  const store = { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } };
  const sent = [];
  const remote = { async submitScore(b) { sent.push(b); return { id: 'x' }; } };
  const b = { game: GAME_ID, playerId: 'w28-queue-01', name: 'ACE', score: 500, replay: 'replay-w28', seed: 7, mode: 'daily', dayKey: D, ticket: 'abc.' + 'Z'.repeat(43), version: GAME_VERSION };
  const q1 = createSubmitQueue({ remote: { submitScore: async () => { throw Object.assign(new Error('x'), { code: 'offline' }); } }, backend: store, locks: null, version: GAME_VERSION });
  await q1.add(b);
  const q2 = createSubmitQueue({ remote, backend: store, locks: null, version: GAME_VERSION }); // another page load
  assert.equal(q2.length, 1);
  await q2.flush(true);
  assert.equal(sent[0].ticket, b.ticket);
});
