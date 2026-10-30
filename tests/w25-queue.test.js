// Card 3b (w25-client): the retry queue for remote submits (games/starfall/submit-queue.js), the remote client's
// timeout and HTTP status (server/client.js), the read gate, and the text helpers in games/starfall/modes.js.
// Node only. The browser side (real page + server/dev-server.mjs) is tests/w25-client-browser.test.js and
// tests/w25-states-browser.test.js.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createSubmitQueue, gateReads, statusFor, isRetryable, backoffMs, MAX_TRIES, QUEUE_KEY, QUEUE_V, QUEUE_CAP, BACKOFF_MS, RATE_WAIT_MS, READ_RETRY_MS } from '../games/starfall/submit-queue.js';
import { createModes, createTable, memoryKv, ratingText, dailyResetText, dailyNumber, shareText, shareScreenLines, fmtScore } from '../games/starfall/modes.js';
import { LeaderboardError, hashReplay } from '../leaderboard/api.js';
import { createRemoteLeaderboard } from '../server/client.js';
import { GAME_ID, GAME_VERSION, createSim } from '../games/starfall/sim.js';
import { playScripted, makeEnv, createWorker } from '../server/fixtures.mjs';
import { dailySeed } from '../engine/rng.js';

const err = (code, status, message) => { const e = new LeaderboardError(code, message || code); if (status) e.status = status; return e; };
function memStore() {
  const m = new Map();
  return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } };
}
// a Web Locks stand-in shared by "tabs": one holder per name at a time
function fakeLocks() {
  const chains = new Map();
  return { request(name, fn) { const prev = chains.get(name) || Promise.resolve(); const run = prev.then(() => fn(), () => fn()); chains.set(name, run.catch(() => {})); return run; } };
}
const body = (i, extra = {}) => ({ game: GAME_ID, playerId: 'queue-player-1', name: 'ACE', score: 1000 + i, replay: 'replay-' + i, seed: 7, mode: 'free', version: GAME_VERSION, ...extra });
const daily = (i) => body(i, { mode: 'daily', dayKey: '2026-10-30' });
// a scripted remote: answers[] are returned (or thrown) in order; calls[] records every body sent
function scripted(answers) {
  const calls = [];
  return { calls, async submitScore(b) { calls.push(b); const a = answers.length ? answers.shift() : { id: 'x' }; if (a instanceof Error) throw a; return typeof a === 'function' ? a(b) : a; } };
}
function mk({ answers = [], store = memStore(), clock = { t: 1_000_000 }, locks = null, version = GAME_VERSION } = {}) {
  const remote = scripted(answers), events = [];
  const q = createSubmitQueue({ remote, backend: store, now: () => clock.t, locks, version, onEvent: e => events.push(e) });
  return { q, remote, events, store, clock };
}

test('a delivered run leaves the queue and is never sent again', async () => {
  const { q, remote, events } = mk({ answers: [{ id: 'e1', placements: { all: 1 } }] });
  assert.equal(await q.add(body(1)), true);
  assert.equal(q.length, 1);
  await q.flush();
  assert.equal(remote.calls.length, 1);
  assert.deepEqual(remote.calls[0], body(1), 'the exact submit body is sent');
  assert.equal(q.length, 0);
  assert.equal(events[0].kind, 'ok');
  await q.flush(); await q.flush();
  assert.equal(remote.calls.length, 1, 'accepted run is not re-sent');
  await q.add(body(1)); // the same run queued again (a stale tab)
  assert.equal(q.length, 1, 'same replay can be re-added only after it left');
  await q.add(body(1));
  assert.equal(q.length, 1, 'the same replay is never queued twice');
});

test('retryable failures stay queued with backoff; the next due send goes through', async () => {
  for (const [e, code] of [[err('offline'), 'offline'], [err('timeout'), 'timeout'], [err('server_error', 500), 'server_error'], [err('busy', 503), 'busy'],
    [err('rate_limited', 429), 'rate_limited'], [new TypeError('boom'), 'server_error']]) {
    const { q, remote, events, clock } = mk({ answers: [e, { id: 'ok' }] });
    await q.add(daily(1));
    await q.flush();
    assert.equal(events.at(-1).kind, 'retry', code);
    assert.equal(q.length, 1, code + ': still queued');
    const it = q.items()[0];
    assert.equal(it.code, code);
    assert.equal(it.tries, 1);
    assert.equal(it.body.mode, 'daily', 'a ranked daily stays queued as a daily');
    const wait = code === 'rate_limited' ? RATE_WAIT_MS : BACKOFF_MS;
    assert.equal(it.next, clock.t + wait, code + ': backoff');
    await q.flush();
    assert.equal(remote.calls.length, 1, code + ': not sent again before the backoff');
    clock.t += wait;
    await q.flush();
    assert.equal(remote.calls.length, 2);
    assert.equal(q.length, 0, code + ': delivered on the retry');
    assert.equal(events.at(-1).kind, 'ok');
  }
  assert.equal(backoffMs(1), 5000); assert.equal(backoffMs(2), 10000); assert.equal(backoffMs(30), 300000);
});

test('one failing send stops the flush: a down server is not asked again for every entry', async () => {
  const { q, remote } = mk({ answers: [err('offline'), err('offline')] });
  await q.add(body(1)); await q.add(body(2)); await q.add(body(3));
  await q.flush();
  assert.equal(remote.calls.length, 1);
  assert.equal(q.length, 3);
});

test('non-retryable refusals leave the queue and are reported once', async () => {
  for (const code of ['bad_name', 'score_zero', 'replay_mismatch', 'near_duplicate', 'bad_day', 'score_mismatch', 'duplicate_result']) {
    const { q, remote, events } = mk({ answers: [err(code, 422)] });
    await q.add(body(1));
    await q.flush(); await q.flush();
    assert.equal(remote.calls.length, 1, code + ': sent once');
    assert.equal(q.length, 0, code);
    assert.deepEqual(events.map(e => e.kind), ['drop'], code + ': shown once');
    assert.equal(statusFor(events[0]), 'NOT SENT: ' + code.toUpperCase().replace(/_/g, ' '));
  }
});

test('held for review (202) counts as delivered; duplicate_replay counts as already delivered', async () => {
  const a = mk({ answers: [{ held: true, code: 'held_for_review', heldId: 4, score: 1001 }] });
  await a.q.add(body(1)); await a.q.flush();
  assert.equal(a.q.length, 0); assert.equal(a.events[0].kind, 'held');
  assert.equal(statusFor(a.events[0]), 'HELD FOR REVIEW');
  const b = mk({ answers: [err('duplicate_replay', 409)] });
  await b.q.add(body(1)); await b.q.flush();
  assert.equal(b.q.length, 0); assert.equal(b.events[0].kind, 'dup');
  assert.equal(statusFor(b.events[0]), 'ALREADY SAVED ONLINE');
});

test('wrong_version: NEW VERSION, RELOAD, never retried, and the other runs of that version go too', async () => {
  const { q, remote, events } = mk({ answers: [err('wrong_version', 422, 'new version, reload: the server takes starfall 2.6, this run is 2.5')] });
  await q.add(body(1)); await q.add(body(2));
  await q.flush(); await q.flush();
  assert.equal(remote.calls.length, 1);
  assert.equal(q.length, 0);
  assert.equal(statusFor(events[0]), 'NEW VERSION, RELOAD');
  // a message that starts "new version, reload" counts even under another code
  const b = mk({ answers: [err('bad_version', 422, 'new version, reload please')] });
  await b.q.add(body(1)); await b.q.flush();
  assert.equal(b.events[0].kind, 'version');
});

test('the queue holds at most QUEUE_CAP runs; past the cap the oldest goes', async () => {
  const { q } = mk();
  for (let i = 0; i < QUEUE_CAP + 3; i++) await q.add(body(i));
  const items = q.items();
  assert.equal(items.length, QUEUE_CAP);
  assert.equal(items[0].body.score, 1003, 'the three oldest were dropped');
  assert.equal(items.at(-1).body.score, 1000 + QUEUE_CAP + 2);
});

test('corrupt JSON, an older format version and bad entries read as an empty queue, never a crash', async () => {
  const store = memStore();
  store.setItem(QUEUE_KEY, '{not json');
  const a = mk({ store });
  assert.equal(a.q.length, 0); assert.equal(a.q.lastRead.corrupt, true);
  await a.q.add(body(1));
  assert.equal(JSON.parse(store.getItem(QUEUE_KEY)).items.length, 1, 'the next write replaces the bad value');
  store.setItem(QUEUE_KEY, JSON.stringify({ v: 0, items: [{ body: body(1) }] }));
  assert.equal(a.q.length, 0, 'an older queue format is dropped');
  store.setItem(QUEUE_KEY, JSON.stringify([body(1)]));
  assert.equal(a.q.length, 0, 'a bare array (no version) is dropped');
  store.setItem(QUEUE_KEY, JSON.stringify({ v: QUEUE_V, items: [null, 5, { body: body(1, { version: '2.4' }) }, { body: body(2, { score: 0 }) },
    { body: body(3, { playerId: 'x' }) }, { body: body(4, { mode: 'daily' }) }, { body: body(5), tries: 'x', next: 'y' }, { body: body(5) }] }));
  const items = a.q.items();
  assert.equal(items.length, 1, 'only the well-formed entry for this game version is kept');
  assert.equal(items[0].body.score, 1005); assert.equal(items[0].tries, 0); assert.equal(items[0].next, 0);
  assert.equal(a.q.lastRead.dropped, 7);
  assert.equal(await a.q.add({ nope: 1 }), false, 'a malformed body is never queued');
});

test('full storage drops the oldest until the queue fits; refused storage keeps the queue in memory', async () => {
  const store = memStore();
  const set = store.setItem;
  store.setItem = (k, v) => { if (String(v).length > 600) throw new Error('QuotaExceededError'); set(k, v); };
  const a = mk({ store });
  for (let i = 0; i < 6; i++) await a.q.add(body(i, { replay: 'r'.repeat(150) + i }));
  const kept = a.q.items();
  assert.ok(kept.length >= 1 && kept.length < 6, 'oldest dropped: ' + kept.length);
  assert.equal(kept.at(-1).body.score, 1005, 'the newest run is kept');
  assert.equal(a.q.degraded, false);
  const refused = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const b = mk({ store: refused, answers: [err('offline'), { id: 'ok' }] });
  await b.q.add(body(1));
  assert.equal(b.q.degraded, true);
  assert.equal(b.q.length, 1, 'kept in memory for this page');
  await b.q.flush();
  assert.equal(b.q.length, 1);
  b.clock.t += BACKOFF_MS; await b.q.flush();
  assert.equal(b.q.length, 0);
});

test('two tabs flushing at once send a queued run once (Web Locks); without locks the server dedupe makes it harmless', async () => {
  const store = memStore(), locks = fakeLocks(), clock = { t: 5 };
  let stored = 0;
  const slowOk = () => new Promise(r => setTimeout(() => { stored++; r({ id: 'e' + stored }); }, 20));
  const A = mk({ store, locks, clock, answers: [slowOk] }), B = mk({ store, locks, clock, answers: [slowOk] });
  await A.q.add(body(1));
  await Promise.all([A.q.flush(), B.q.flush()]);
  assert.equal(A.remote.calls.length + B.remote.calls.length, 1, 'one send across both tabs');
  assert.equal(A.q.length, 0);
  // no Web Locks (each tab has its own in-page queue): the entry's next time moves before the send, so a second tab
  // that reads the queue during the send skips it
  const store2 = memStore(), noLocks = { request: undefined };
  const C = mk({ store: store2, locks: noLocks, clock, answers: [slowOk] }), D = mk({ store: store2, locks: noLocks, clock, answers: [slowOk] });
  await C.q.add(body(2));
  await Promise.all([C.q.flush(), D.q.flush()]);
  assert.equal(C.remote.calls.length + D.remote.calls.length, 1);
});

// the real Worker behind the real client: the server stores the run, the answer is lost, the queue sends it again
let RUN, DAY, FREE;
before(() => { DAY = new Date().toISOString().slice(0, 10); RUN = playScripted(dailySeed(DAY), 1, 'script', 'daily'); FREE = playScripted(9, 1); });
test('kill mid-submit: the answer is lost after the server stored the run; the resend is a duplicate and the run is on the board once', async () => {
  const env = await makeEnv(), worker = createWorker();
  const dayKey = DAY;
  let mode = 'up', sends = 0;
  const fetch = async (url, init) => {
    if (mode === 'down') throw new TypeError('connect ECONNREFUSED');
    const r = await worker.fetch(new Request(url, init), env);
    if (url.endsWith('/submit')) sends++;
    if (mode === 'lose') { mode = 'up'; throw new TypeError('socket hang up'); } // stored, then the answer is lost
    return r;
  };
  const remote = createRemoteLeaderboard({ url: 'https://lb.test', fetch });
  const clock = { t: Date.now() };
  const events = [];
  const q = createSubmitQueue({ remote, backend: memStore(), now: () => clock.t, version: GAME_VERSION, onEvent: e => events.push(e) });
  const b = { game: GAME_ID, playerId: 'kill-player-01', name: 'ACE', score: RUN.score, replay: RUN.replay, seed: dailySeed(dayKey), mode: 'daily', version: GAME_VERSION, dayKey };
  await q.add(b);
  mode = 'down'; await q.flush();
  assert.equal(events.at(-1).kind, 'retry'); assert.equal(events.at(-1).code, 'offline');
  mode = 'lose'; clock.t += BACKOFF_MS; await q.flush();
  assert.equal(events.at(-1).kind, 'retry', 'a lost answer looks offline');
  assert.equal(q.length, 1);
  clock.t += 2 * BACKOFF_MS; await q.flush();
  assert.equal(events.at(-1).kind, 'dup', 'the resend is refused as the same replay: delivered');
  assert.equal(q.length, 0);
  assert.equal(sends, 2, 'two sends reached the server');
  const rows = await remote.getBoard({ game: GAME_ID, board: 'all', limit: 10 });
  assert.equal(rows.filter(r => r.name === 'ACE').length, 1, 'on the board once');
  assert.equal((await remote.getBoard({ game: GAME_ID, board: 'daily', key: dayKey, limit: 10 })).length, 1, 'the ranked daily is on the day board');
});

test('client: a fetch that never answers fails with timeout; HTTP errors carry their status', async () => {
  const hang = createRemoteLeaderboard({ url: 'https://lb.test', fetch: () => new Promise(() => {}), timeoutMs: 40 });
  await assert.rejects(hang.submitScore(body(1)), e => e.code === 'timeout' && isRetryable(e));
  await assert.rejects(hang.getBoard({ game: GAME_ID }), { code: 'timeout' });
  const five = createRemoteLeaderboard({ url: 'https://lb.test', fetch: async () => new Response('oops', { status: 502 }) });
  await assert.rejects(five.submitScore(body(1)), e => e.code === 'server_error' && e.status === 502 && isRetryable(e));
  const json = (status, b) => async () => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
  const v = createRemoteLeaderboard({ url: 'https://lb.test', fetch: json(422, { ok: false, error: 'wrong_version', message: 'new version, reload: x' }) });
  await assert.rejects(v.submitScore(body(1)), e => e.code === 'wrong_version' && e.status === 422 && !isRetryable(e));
  const held = createRemoteLeaderboard({ url: 'https://lb.test', fetch: json(202, { ok: true, held: true, code: 'held_for_review', heldId: 3, score: 5 }) });
  assert.deepEqual(await held.submitScore(body(1)), { held: true, code: 'held_for_review', heldId: 3, score: 5 });
});

test('read gate: after a failed read every read fails at once for 10 s, then one real request', async () => {
  const clock = { t: 0 };
  let calls = 0, up = false;
  const remote = { getBoard: async () => { calls++; if (!up) throw err('offline'); return []; }, getRank: async () => { calls++; throw err('offline'); }, getReplay: async () => { calls++; return null; } };
  const g = gateReads(remote, { now: () => clock.t });
  await assert.rejects(g.getBoard({}), { code: 'offline' });
  for (let i = 0; i < 50; i++) { await assert.rejects(g.getBoard({})); await assert.rejects(g.getRank({})); await assert.rejects(g.getReplay('x')); }
  assert.equal(calls, 1, 'no request storm');
  clock.t += READ_RETRY_MS - 1; await assert.rejects(g.getBoard({}));
  assert.equal(calls, 1);
  clock.t += 1; up = true;
  assert.deepEqual(await g.getBoard({}), []);
  assert.equal(calls, 2); assert.equal(g.requests, 2);
});

test('table: a failed read shows OFFLINE (not LOADING forever); null placements never print null', async () => {
  const t = createTable({ lb: { getBoard: async () => { throw err('offline'); } } });
  await t.refresh();
  assert.equal(t.offline, true); assert.equal(t.loaded, false);
  const texts = [];
  const { drawTable } = await import('../games/starfall/modes.js');
  drawTable({ text: s => texts.push(s), panel() {}, ui: {} }, t, 0);
  assert.ok(texts.includes('OFFLINE')); assert.ok(!texts.includes('LOADING'));
  const t2 = createTable({ lb: null });
  t2.setResult({ id: 'x', placements: { all: null, season: null, daily: null }, trophyDelta: 0, trophies: 750, league: { name: 'Gold', tier: 'III', label: 'Gold III' },
    rating: { avg5: 7713, top5: [38565], enteredTop5: true, percentile: 0.5, players: 1 } });
  assert.equal(t2.note, 'PAST THE TOP 1000  +0 TROPHIES');
  t2.setResult({ id: 'x', placements: {}, league: null });
  assert.equal(t2.note, ''); assert.equal(t2.summary, '');
  t2.setResult({ id: 'x', placements: { all: 3, daily: 2 }, trophyDelta: 12, trophies: 40, league: { name: 'Bronze', tier: 'III' } });
  assert.equal(t2.note, 'RANK 3 ALL-TIME  2 TODAY  +12 TROPHIES');
  for (const r of [null, {}, { avg5: null, percentile: undefined }, { rating: { avg5: NaN, percentile: NaN } }, { avg5: 0, percentile: null }, { rating: { avg5: 5, percentile: 1 } }]) {
    assert.doesNotMatch(ratingText(r), /null|undefined|nan/i, JSON.stringify(r));
  }
  assert.equal(ratingText({ rating: { avg5: 7713.4, percentile: 0.5 } }), 'BEST 5 AVG 7713  TOP 50%');
  assert.equal(ratingText({ avg5: 0, percentile: null }), 'NOT RATED THIS SEASON');
  assert.equal(statusFor({ kind: 'ok', res: { rating: { avg5: 10, percentile: 0.9 } } }, ratingText), 'ONLINE: BEST 5 AVG 10  TOP 10%');
  assert.equal(statusFor({ kind: 'ok', res: { held: false } }, ratingText), 'SAVED ONLINE');
  assert.equal(statusFor({ kind: 'retry', code: 'offline', left: 2 }), 'OFFLINE: 2 RUNS SAVED HERE, WILL RETRY');
  assert.equal(statusFor({ kind: 'retry', code: 'busy', left: 1 }), 'SERVER BUSY: 1 RUN SAVED HERE, WILL RETRY');
});

test('daily timer, daily number and share text', () => {
  assert.equal(dailyResetText(Date.UTC(2026, 9, 30, 19, 0, 0)), 'NEW DAILY IN 5H');
  assert.equal(dailyResetText(Date.UTC(2026, 9, 30, 0, 0, 0)), 'NEW DAILY IN 24H');
  assert.equal(dailyResetText(Date.UTC(2026, 9, 30, 22, 59, 59)), 'NEW DAILY IN 1H');
  assert.equal(dailyResetText(Date.UTC(2026, 9, 30, 23, 18, 0)), 'NEW DAILY IN 42M');
  assert.equal(dailyResetText(Date.UTC(2026, 9, 30, 23, 59, 59)), 'NEW DAILY IN 1M');
  assert.equal(dailyNumber('2026-10-30'), 1); assert.equal(dailyNumber('2026-11-10'), 12);
  assert.equal(dailyNumber('2026-10-29'), null); assert.equal(dailyNumber('nope'), null);
  assert.equal(fmtScore(184300), '184,300'); assert.equal(fmtScore(999), '999'); assert.equal(fmtScore(1234567), '1,234,567');
  const s = shareText({ arcade: 'RETRO ARCADE', dayKey: '2026-11-10', score: 184300, league: 'Gold III', link: 'https://x.pages.dev/starfall.html' });
  assert.equal(s, 'RETRO ARCADE Daily #12 · 184,300 · Gold III\nhttps://x.pages.dev/starfall.html');
  assert.equal(shareText({ arcade: 'NEW NAME', dayKey: '2026-11-10', score: 5, league: undefined, link: '' }), 'NEW NAME Daily #12 · 5');
  assert.deepEqual(shareScreenLines(s), ['RETRO ARCADE DAILY NO.12 - 184,300 - GOLD III', 'X.PAGES.DEV/STARFALL.HTML']);
});

test('modes.body is exactly what modes.submit sends (the queue keeps the same body)', async () => {
  const sent = [];
  const modes = createModes({ lb: { submitScore: async b => { sent.push(b); return { id: 'x' }; } }, kv: memoryKv() });
  const run = modes.begin('free', 9); modes.claim(run);
  const sim = createSim({ seed: 9, mode: 'arcade' });
  const { words } = (await import('../engine/replay.js')).decode(FREE.replay);
  for (const w of words) { sim.step(w); sim.clearEvents(); }
  assert.ok(modes.canSubmit(run, sim));
  const b = modes.body(run, sim, FREE.replay, 'ACE', 'body-player-1');
  await modes.submit(run, sim, FREE.replay, 'ACE', 'body-player-1');
  assert.deepEqual(sent[0], b);
  assert.equal(b.score, FREE.score); assert.equal(b.mode, 'free'); assert.equal(b.seed, 9);
  assert.equal(hashReplay(b.replay), hashReplay(FREE.replay));
});

// ---------- fix round 3b-fix: LOW4, LOW5, LOW6 ----------
test('LOW4: a 500 verify_disagree and a non-JSON 4xx (a 413 HTML page) are never retried and show NOT SENT once', async () => {
  const cases = [[err('verify_disagree', 500), 'NOT SENT: VERIFY DISAGREE'], [err('server_error', 413, 'leaderboard server sent 413 without JSON'), 'NOT SENT: HTTP 413'],
    [err('server_error', 400), 'NOT SENT: HTTP 400'], [err('server_error', 404), 'NOT SENT: HTTP 404']];
  for (const [e, want] of cases) {
    const { q, remote, events, clock } = mk({ answers: [e, { id: 'late' }] });
    await q.add(body(1));
    await q.flush();
    clock.t += 10 * 60 * 1000; await q.flush(); await q.flush();
    assert.equal(remote.calls.length, 1, want + ': sent once');
    assert.equal(q.length, 0, want);
    assert.deepEqual(events.map(x => x.kind), ['drop']);
    assert.equal(statusFor(events[0]), want);
    assert.equal(isRetryable(e), false);
  }
  // a 5xx without JSON, a 408 and a 429 without JSON are still worth another go
  for (const st of [500, 502, 503, 408, 429]) assert.equal(isRetryable(err('server_error', st)), true, String(st));
});

test('LOW4: every entry has a maximum try count; after it the run leaves the queue and NOT SENT shows once', async () => {
  const { q, remote, events, clock } = mk({ answers: Array.from({ length: MAX_TRIES + 5 }, () => err('offline')) });
  assert.ok(Number.isInteger(MAX_TRIES) && MAX_TRIES >= 5 && MAX_TRIES <= 50);
  await q.add(body(1));
  for (let i = 0; i < MAX_TRIES + 3 && q.length; i++) { await q.flush(); clock.t += 6 * 60 * 1000; }
  assert.equal(remote.calls.length, MAX_TRIES, 'exactly MAX_TRIES sends');
  assert.equal(q.length, 0, 'gone from the queue');
  const drops = events.filter(e => e.kind === 'drop');
  assert.equal(drops.length, 1, 'shown once');
  assert.equal(events.at(-1).kind, 'drop');
  assert.equal(statusFor(drops[0]), 'NOT SENT: OFFLINE');
  clock.t += 60 * 60 * 1000; await q.flush();
  assert.equal(remote.calls.length, MAX_TRIES, 'never sent again');
});

test('LOW5: add() refuses a body that is not a valid submit for this game version, and the status says so', async () => {
  const { q } = mk();
  assert.equal(await q.add({ ...body(1), score: 0 }), false);
  assert.equal(await q.add({ ...body(1), version: 'other' }), false);
  assert.equal(q.length, 0);
  assert.equal(statusFor({ kind: 'nosend' }), 'NOT SENT: SAVED HERE ONLY');
});

test('LOW6: a queued ranked daily the server refuses with bad_day is dropped later and shown as NOT SENT: BAD DAY', async () => {
  const { q, remote, events, clock } = mk({ answers: [err('offline'), err('bad_day', 422, 'that day is closed')] });
  await q.add(daily(1));
  await q.flush();
  assert.equal(q.length, 1);
  assert.equal(events.at(-1).kind, 'retry');
  clock.t += BACKOFF_MS;
  await q.flush();
  assert.equal(q.length, 0, 'dropped');
  assert.equal(events.at(-1).kind, 'drop');
  assert.equal(statusFor(events.at(-1)), 'NOT SENT: BAD DAY');
  clock.t += 60 * 60 * 1000; await q.flush();
  assert.equal(remote.calls.length, 2, 'not sent again');
});
