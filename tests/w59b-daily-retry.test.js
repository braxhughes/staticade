// a Daily's retries land inside its ticket window.
// Queue tests use the real createSubmitQueue (and STACKLIGHT's wrapper) with a fake clock and a fake remote, the way
// tests/w25-queue.test.js does. Server tests go through createWorker().fetch with a clock the test moves and the shipped
// LIMITS (as tests/w59-ticket-age.test.js does). Localhost only; the secret is random per run and never kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSubmitQueue, backoffMs, nextTry, dailyDeadline, DEADLINE_MARGIN_MS, MAX_TRIES, QUEUE_KEY, QUEUE_V } from '../games/starfall/submit-queue.js';
import { createStacklightQueue, createModes as slModes, QUEUE_KEY as SL_KEY } from '../games/stacklight/modes.js';
import { GAME_ID as SF_ID, GAME_VERSION as SF_VERSION } from '../games/starfall/sim.js';
import { GAME_ID as SL_ID, GAME_VERSION as SL_VERSION } from '../games/stacklight/defs.js';
import { LeaderboardError } from '../leaderboard/api.js';
import { createRemoteLeaderboard } from '../server/client.js';
import { TICKET_GRACE_S, TICKET_SLACK_S } from '../server/daily.js';
import { LIMITS } from '../server/worker.js';
import { playScripted, makeEnv, post, createWorker } from '../server/fixtures.mjs';

const S = 1000;
const WINDOW_MS = (TICKET_GRACE_S + TICKET_SLACK_S) * S; // 610 s past play time
const memStore = () => { const m = new Map(); return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } }; };
const offline = () => new LeaderboardError('offline', 'down');
const FRAMES = 3600; // a one minute run
const T0 = 10_000_000; // client time the ticket arrived
const GO = T0 + FRAMES / 60 * S; // game over: no pause, name typed at once
const fpBody = (i, extra = {}) => ({ game: SF_ID, playerId: 'retry-player-01', name: 'ACE', score: 1000 + i, replay: 'replay-' + i, seed: 7, mode: 'free', version: SF_VERSION, ...extra });
const dBody = (i) => fpBody(i, { mode: 'daily', dayKey: '2026-10-30', ticket: 'tick' + i });

// a remote that is down until the clock reaches upAt; records the clock at every try
function outage(clock, upAt) {
  const tries = [], answers = [];
  return { tries, answers, async submitScore(b) { tries.push(clock.t); if (clock.t < upAt) throw offline(); const r = { id: 'stored', placements: { all: 1 } }; answers.push(r); return r; } };
}
// run the queue the way main.js does: flush, then sleep until the next due time, until it is empty or `until`
async function drive(q, clock, until) {
  for (let g = 0; g < 200 && q.length && clock.t <= until; g++) {
    await q.flush();
    if (!q.length) break;
    const n = q.nextDue();
    clock.t = n > clock.t ? n : clock.t + 1;
  }
}
const mkQ = (clock, remote, store = memStore(), extra = {}) => createSubmitQueue({ remote, backend: store, now: () => clock.t, locks: null, version: SF_VERSION, ...extra });

test('the window numbers are the server\'s own (one source), and dailyDeadline is ticket + play + grace + slack - margin', () => {
  assert.equal(DEADLINE_MARGIN_MS, 30000);
  assert.equal(dailyDeadline(T0, FRAMES), T0 + 60 * S + 610 * S - 30 * S);
  assert.equal(dailyDeadline(T0, 0), T0 + 580 * S);
  for (const bad of [[NaN, 10], [undefined, 10], ['5', 10], [T0, NaN], [T0, -1], [T0, undefined], [Infinity, 10]]) assert.equal(dailyDeadline(...bad), null, JSON.stringify(bad));
});

test('nextTry: no deadline is the plain backoff; before the deadline it is capped at it; at or past it the plain backoff', () => {
  for (const tries of [1, 2, 5, 9, 30]) for (const code of [null, 'offline', 'rate_limited']) assert.equal(nextTry(1000, tries, code, undefined), 1000 + backoffMs(tries, code));
  assert.equal(nextTry(1000, 3, null, 1000 + 10 * S), 1000 + 10 * S, 'backoff of 20 s is cut to the deadline 10 s ahead');
  assert.equal(nextTry(1000, 1, null, 1000 + 10 * S), 1000 + 5 * S, 'a backoff that fits is untouched');
  assert.equal(nextTry(5000, 1, null, 5000), 10000, 'at the deadline: plain backoff');
  assert.equal(nextTry(6000, 1, null, 5000), 11000, 'past it: plain backoff');
  assert.equal(nextTry(1000, 1, 'rate_limited', 1000 + 30 * S), 1000 + 30 * S, 'rate_limited waits a minute unless that passes the deadline');
  assert.equal(nextTry(1000, 1, 'rate_limited', 1000 + 90 * S), 1000 + 60 * S);
});

test('(a) a Daily queued at game over, server down 330 s: the last try is inside the window and the run is stored when the server returns at +331 s', async () => {
  const clock = { t: GO }, remote = outage(clock, GO + 331 * S), store = memStore();
  const q = mkQ(clock, remote, store);
  assert.equal(await q.add(dBody(1), { ticketAt: T0, frames: FRAMES }), true);
  const deadline = dailyDeadline(T0, FRAMES);
  assert.equal(q.items()[0].deadline, deadline);
  assert.equal(deadline, GO + 580 * S);
  await drive(q, clock, GO + 700 * S);
  assert.equal(q.length, 0, 'delivered');
  assert.equal(remote.answers.length, 1);
  const rel = remote.tries.map(t => (t - GO) / S);
  assert.deepEqual(rel, [0, 5, 15, 35, 75, 155, 315, 580], 'plain doubling backoff, then the try at the deadline instead of +615');
  assert.ok(remote.tries.at(-1) <= GO + WINDOW_MS, 'the accepted try is inside the server window');
  assert.ok(remote.tries.at(-1) <= deadline);
});

test('(a2) the same outage with a Daily that has no deadline would have jumped to +615 s, past the window (why this slice exists)', async () => {
  const clock = { t: GO }, remote = outage(clock, GO + 331 * S);
  const q = mkQ(clock, remote);
  await q.add(dBody(1)); // no ticketAt: the old behaviour
  assert.equal(q.items()[0].deadline, undefined);
  await drive(q, clock, GO + 700 * S);
  assert.equal((remote.tries.at(-1) - GO) / S, 615);
  assert.ok(remote.tries.at(-1) > GO + WINDOW_MS, 'lands past the window');
});

test('(b) server down for the whole window: a try lands exactly at the deadline, nothing before it is skipped over, and after it the plain backoff', async () => {
  const clock = { t: GO }, remote = outage(clock, Infinity);
  const q = mkQ(clock, remote);
  await q.add(dBody(1), { ticketAt: T0, frames: FRAMES });
  const deadline = dailyDeadline(T0, FRAMES);
  await drive(q, clock, GO + 5000 * S);
  const inside = remote.tries.filter(t => t <= deadline), after = remote.tries.filter(t => t > deadline);
  assert.equal(inside.at(-1), deadline, 'the last try inside the window is at the deadline');
  assert.ok(inside.at(-1) <= GO + WINDOW_MS);
  assert.ok(after.length >= 1, 'a try after the deadline gets the final answer');
  assert.equal(after[0], deadline + DEADLINE_MARGIN_MS / 2, 'w59d: one extra try 15 s after the deadline');
  assert.equal(after[1], after[0] + backoffMs(inside.length + 1), 'then the plain backoff is back');
  for (let i = 1; i < inside.length; i++) assert.ok(inside[i] - inside[i - 1] <= 300 * S, 'never a gap past the 5 minute cap inside the window');
  assert.equal(remote.tries.length, MAX_TRIES, 'MAX_TRIES still ends it');
  assert.equal(q.length, 0);
});

test('(b2) a rate_limited answer waits a minute unless that passes the deadline', async () => {
  const clock = { t: GO + 560 * S }; // 20 s before the deadline
  const remote = { tries: [], async submitScore() { remote.tries.push(clock.t); throw new LeaderboardError('rate_limited', 'slow down'); } };
  const q = mkQ(clock, remote);
  await q.add(dBody(1), { ticketAt: T0, frames: FRAMES });
  await q.flush();
  assert.equal(q.items()[0].next, GO + 580 * S, 'the deadline, not +60 s');
  clock.t = GO + 580 * S; await q.flush();
  assert.equal(q.items()[0].next, GO + 580 * S + DEADLINE_MARGIN_MS / 2, 'w59d: past the deadline, the one extra try');
});

test('(b3) a long pause: game over 9 minutes after the ticket still gets a deadline inside the window, and tries are capped to it', async () => {
  const go = T0 + 540 * S + FRAMES / 60 * S, clock = { t: go }, remote = outage(clock, go + 39 * S);
  const q = mkQ(clock, remote);
  await q.add(dBody(1), { ticketAt: T0, frames: FRAMES });
  const deadline = dailyDeadline(T0, FRAMES);
  assert.equal(deadline, go + 40 * S);
  await drive(q, clock, go + 500 * S);
  assert.deepEqual(remote.tries.map(t => (t - go) / S), [0, 5, 15, 35, 40], 'the 75 s try is cut to the deadline at +40 s');
  assert.equal(remote.answers.length, 1);
  assert.ok(remote.tries.at(-1) <= T0 + (FRAMES / 60 + 610) * S);
});

test('(b4) a ticket already past its deadline when the run is queued: plain backoff, the first answer decides', async () => {
  const late = T0 + 700 * S, clock = { t: late + FRAMES / 60 * S }, remote = outage(clock, Infinity);
  const q = mkQ(clock, remote);
  await q.add(dBody(1), { ticketAt: T0, frames: FRAMES });
  const start = clock.t;
  await drive(q, clock, start + 100 * S);
  assert.deepEqual(remote.tries.map(t => (t - start) / S), [0, 5, 15, 35, 75]);
});

test('(c) a Free Play entry under the same outage gets exactly the old schedule', async () => {
  for (const add of [q => q.add(fpBody(1)), q => q.add(fpBody(1), { ticketAt: T0, frames: FRAMES }), q => q.add(dBody(1) && { ...dBody(1), ticket: undefined }, { ticketAt: T0, frames: FRAMES })]) {
    const clock = { t: GO }, remote = outage(clock, Infinity), q = mkQ(clock, remote);
    await add(q);
    assert.equal(q.items()[0].deadline, undefined, 'no deadline field');
    assert.deepEqual(Object.keys(q.items()[0]).sort(), ['body', 'code', 'id', 'next', 'tries']);
    await drive(q, clock, GO + 20000 * S);
    const expect = [0]; for (let k = 1; k < MAX_TRIES; k++) expect.push(expect.at(-1) + backoffMs(k) / S);
    assert.deepEqual(remote.tries.map(t => (t - GO) / S), expect, 'try times equal the backoffMs sequence');
  }
});

test('(d) the deadline survives a reload (read back from localStorage); a bad stored deadline is read as none', async () => {
  const clock = { t: GO }, remote = outage(clock, Infinity), store = memStore();
  const q = mkQ(clock, remote, store);
  await q.add(dBody(1), { ticketAt: T0, frames: FRAMES });
  await q.flush();
  const stored = JSON.parse(store.getItem(QUEUE_KEY));
  assert.equal(stored.v, QUEUE_V);
  assert.equal(stored.items[0].deadline, GO + 580 * S);
  assert.equal(stored.items[0].body.ticket, 'tick1');
  assert.ok(!('deadline' in stored.items[0].body), 'the body is sent as is: the deadline is not in it');
  // a reload: a new queue on the same storage keeps spacing against the deadline
  clock.t = stored.items[0].next;
  const q2 = mkQ(clock, remote, store);
  assert.equal(q2.items()[0].deadline, GO + 580 * S);
  await drive(q2, clock, GO + 600 * S);
  assert.equal(remote.tries.filter(t => t <= GO + 580 * S).at(-1), GO + 580 * S, 'the reloaded queue still tries at the deadline');
  // hand-written bad deadlines
  for (const bad of ['600000', '', 'NaN', null, true, {}, [], 1e999 /* JSON.parse gives Infinity */]) {
    const st = memStore();
    st.setItem(QUEUE_KEY, '{"v":1,"items":[{"id":"x","tries":0,"next":0,"code":null,"deadline":' + (typeof bad === 'number' ? '1e999' : JSON.stringify(bad)) + ',"body":' + JSON.stringify(dBody(2)) + '}]}');
    const c = { t: GO }, r = outage(c, Infinity), qq = mkQ(c, r, st);
    assert.equal(qq.length, 1, 'the entry itself is kept');
    assert.equal(qq.items()[0].deadline, undefined, 'bad deadline ' + String(bad) + ' is dropped');
    await drive(qq, c, GO + 100 * S);
    assert.deepEqual(r.tries.map(t => (t - GO) / S), [0, 5, 15, 35, 75], 'behaves like Free Play');
  }
  // an old-format entry (no deadline field at all)
  const st = memStore();
  st.setItem(QUEUE_KEY, JSON.stringify({ v: 1, items: [{ id: 'x', body: dBody(3), tries: 2, next: 0, code: 'offline' }] }));
  assert.equal(mkQ({ t: GO }, outage({ t: GO }, 0), st).items()[0].deadline, undefined);
});

test('(d2) add() only gives a deadline to a Daily with a ticket and a usable ticketAt/frames', async () => {
  const clock = { t: GO }, q = mkQ(clock, outage(clock, Infinity));
  await q.add(dBody(1), { ticketAt: 'soon', frames: FRAMES });
  await q.add(dBody(2), { ticketAt: T0 });            // frames unknown: no stats on a Starfall body
  await q.add(dBody(3), { ticketAt: T0, frames: NaN });
  await q.add(dBody(4), {});
  await q.add(dBody(5));
  await q.add({ ...dBody(6), stats: { frames: FRAMES } }, { ticketAt: T0 }); // STACKLIGHT-style body carries frames
  await q.add({ ...dBody(7), stats: { frames: 1 } }, { ticketAt: T0, frames: FRAMES }); // opts.frames wins
  const d = q.items().map(e => e.deadline);
  assert.deepEqual(d, [undefined, undefined, undefined, undefined, undefined, dailyDeadline(T0, FRAMES), dailyDeadline(T0, FRAMES)]);
});

test('(e) STACKLIGHT\'s queue (games/stacklight/modes.js) gets the deadline too, on its own storage key', async () => {
  const clock = { t: GO }, store = memStore(), remote = outage(clock, GO + 331 * S);
  const q = createStacklightQueue({ remote, backend: store, now: () => clock.t, locks: null });
  const body = { game: SL_ID, playerId: 'retry-player-01', name: 'ACE', score: 500, replay: 'sl-replay-1', seed: 9, mode: 'daily', dayKey: '2026-10-30', ticket: 'sl-ticket', version: SL_VERSION, stats: { hash: '1', frames: FRAMES, stage: 1 } };
  assert.equal(await q.add(body, { ticketAt: T0, frames: FRAMES }), true);
  assert.equal(JSON.parse(store.getItem(SL_KEY)).items[0].deadline, GO + 580 * S);
  assert.equal(store.getItem(QUEUE_KEY), null, 'not on the Starfall key');
  await drive(q, clock, GO + 700 * S);
  assert.equal(q.length, 0);
  assert.equal(remote.answers.length, 1);
  assert.equal((remote.tries.at(-1) - GO) / S, 580);
});

test('(e2) STACKLIGHT modes.begin stamps when a ticket first arrived and a cached answer keeps that time', () => {
  const clock = { t: T0 };
  const m = slModes({ now: () => clock.t });
  const ans = { dayKey: '2026-10-30', seed: 123456, ticket: 'sl-ticket-A' };
  const first = m.begin('daily', 0, ans);
  assert.equal(first.ticketAt, T0);
  clock.t = T0 + 3600 * S; // an hour later the page starts a run from the cached answer
  const again = m.begin('daily', 0, ans);
  assert.equal(again.ticketAt, T0, 'the cached ticket is not made to look fresh');
  assert.equal(m.begin('daily', 0, { ...ans, ticket: 'sl-ticket-B' }).ticketAt, T0 + 3600 * S, 'a new ticket gets its own time');
  assert.equal('ticketAt' in m.begin('daily', 0, { ...ans, ticket: null }), false, 'no ticket, no time');
  assert.equal('ticketAt' in m.begin('daily'), false, 'a local Daily has none');
  assert.equal('ticketAt' in m.begin('free', 5), false);
});

// ---- end to end: the queue through the real Worker with the shipped LIMITS ----
const SECRET = randomBytes(32).toString('hex');
const TW0 = Date.parse('2026-11-07T10:00:00Z');
let N = 0;
// One Starfall Daily: ticket at server time TW0 (client time T0 + travel 1 s), the run played, the queue fed at game over.
async function e2e({ outageS, pauseS = 0, skewMs = 0, free = false }) {
  const c = { t: TW0 }, W = createWorker({ now: () => c.t }), env = { ...(await makeEnv()), DAILY_SECRET: SECRET };
  const player = `w59b-player-${String(++N).padStart(4, '0')}`, ip = `198.51.100.${(N % 250) + 1}`;
  const r = await W.fetch(new Request(`https://lb.test/daily?game=${SF_ID}`, { headers: { 'x-player-id': player, 'cf-connecting-ip': ip } }), env);
  const d = await r.json(); assert.equal(r.status, 200, JSON.stringify(d));
  const run = playScripted(d.seed, 7, 'script', free ? 'arcade' : 'daily');
  assert.ok(run.score > 0 && run.frames > 0);
  const playMs = Math.ceil(run.frames / 60 * S);
  const ticketAtServer = c.t + 1000; // the answer reached the client 1 s after the server issued it
  const goServer = TW0 + playMs + pauseS * S;
  c.t = goServer;
  let upAt = goServer + outageS * S;
  const log = [];
  const fetchFn = async (url, init) => {
    if (c.t < upAt) { log.push([c.t - goServer, 'down']); throw new TypeError('network down'); }
    const res = await W.fetch(new Request(url, { ...init, headers: { ...init.headers, 'cf-connecting-ip': ip } }), env);
    log.push([c.t - goServer, res.status]);
    return res;
  };
  const remote = createRemoteLeaderboard({ url: 'https://lb.test', fetch: fetchFn });
  const events = [];
  // the client clock is the server clock plus skewMs
  const q = createSubmitQueue({ remote, backend: memStore(), now: () => c.t + skewMs, locks: null, version: SF_VERSION, onEvent: e => events.push(e) });
  const body = free ? { game: SF_ID, playerId: player, name: 'ACE', score: run.score, replay: run.replay, seed: d.seed, mode: 'free', version: SF_VERSION }
    : { game: SF_ID, playerId: player, name: 'ACE', score: run.score, replay: run.replay, seed: d.seed, mode: 'daily', dayKey: d.dayKey, version: SF_VERSION, ticket: d.ticket };
  await q.add(body, { ticketAt: ticketAtServer + skewMs, frames: run.frames });
  const windowEnd = TW0 + (run.frames / 60 + 610) * S;
  const t0 = c.t;
  for (let g = 0; g < 60 && q.length && c.t < t0 + 3000 * S; g++) {
    await q.flush();
    if (!q.length) break;
    const n = q.nextDue() - skewMs; c.t = n > c.t ? n : c.t + 1;
  }
  return { events, log, run, windowEnd, goServer, q, last: events.at(-1) };
}
const show = r => r.log.map(([t, s]) => (t / S).toFixed(0) + 's:' + s).join(' ');

for (const [outageS, pauseS] of [[330, 0], [500, 0], [570, 0], [250, 300]]) {
  test(`(e3) end to end, real Worker, shipped LIMITS: outage ${outageS} s after a ${pauseS} s pause: the Daily is stored (201)`, async () => {
    assert.equal(LIMITS.ticketGraceS, TICKET_GRACE_S);
    const r = await e2e({ outageS, pauseS });
    assert.equal(r.last.kind, 'ok', 'tries: ' + show(r));
    assert.equal(r.q.length, 0);
    assert.ok(r.log.at(-1)[0] + r.goServer <= r.windowEnd, 'the stored try was inside the window');
  });
}

test('(e4) end to end: a client clock 10 s fast or 10 s slow against the server still lands inside', async () => {
  for (const skewMs of [10000, -10000]) {
    const r = await e2e({ outageS: 330, skewMs });
    assert.equal(r.last.kind, 'ok', 'skew ' + skewMs + ': ' + show(r));
  }
});

test('(e5) end to end: the server down for the whole window: the last try inside the window is at the deadline and the answer after it is ticket_stale', async () => {
  const r = await e2e({ outageS: 1500 });
  const inside = r.log.filter(([t]) => t + r.goServer <= r.windowEnd);
  assert.ok(inside.length >= 7, 'tries inside: ' + show(r));
  assert.ok(inside.at(-1)[0] >= 560 * S, 'a try close to the end of the window: ' + show(r));
  assert.ok(inside.at(-1)[0] <= 610 * S);
  assert.equal(r.last.kind, 'drop');
  assert.equal(r.last.code, 'ticket_stale');
});

test('(e6) end to end: Free Play under a 330 s outage is sent on the plain schedule (+315 s then +615 s), and stored', async () => {
  const r = await e2e({ outageS: 330, free: true });
  assert.deepEqual(r.log.map(([t]) => t / S), [0, 5, 15, 35, 75, 155, 315, 615]);
  assert.equal(r.last.kind, 'ok');
});

// ---- server ----
async function server() {
  const c = { t: TW0 }, W = createWorker({ now: () => c.t }), env = { ...(await makeEnv()), DAILY_SECRET: SECRET };
  const player = `w59b-srv-${String(++N).padStart(4, '0')}`, ip = `192.0.2.${(N % 250) + 1}`;
  const ticket = async () => {
    const r = await W.fetch(new Request(`https://lb.test/daily?game=${SF_ID}`, { headers: { 'x-player-id': player, 'cf-connecting-ip': ip } }), env);
    const d = await r.json(); assert.equal(r.status, 200, JSON.stringify(d)); return d;
  };
  const send = (d, run) => post(W, env, { game: SF_ID, playerId: player, name: 'ACE', score: run.score, replay: run.replay, seed: d.seed, mode: 'daily', dayKey: d.dayKey, version: SF_VERSION, ticket: d.ticket }, { ip });
  return { c, W, env, ticket, send };
}

test('LOW-1: a stale Daily is refused with ticket_stale BEFORE the player\'s day is claimed; a fresh valid run for the same day and player is then accepted', async () => {
  const { c, ticket, send } = await server();
  const d1 = await ticket();
  const run1 = playScripted(d1.seed, 7, 'script', 'daily');
  c.t = TW0 + Math.ceil(run1.frames / 60 * S) + 11 * 60 * S; // 11 minutes past play time
  const stale = await send(d1, run1);
  assert.deepEqual([stale.status, stale.body.error], [422, 'ticket_stale'], JSON.stringify(stale.body));
  const d2 = await ticket(); // a new ticket now, the same player and day
  assert.notEqual(d2.ticket, d1.ticket);
  const run2 = playScripted(d2.seed, 99, 'script', 'daily');
  assert.notEqual(run2.replay, run1.replay);
  c.t += Math.ceil(run2.frames / 60 * S) + 5 * S;
  const fresh = await send(d2, run2);
  assert.deepEqual([fresh.status, fresh.body.error ?? 'ok'], [201, 'ok'], 'the day was not claimed by the refused stale run: ' + JSON.stringify(fresh.body));
  const again = await send(d2, run2);
  assert.ok(again.status >= 400, 'and now the day is used');
});

test('LOW-2: at exactly play time + 600 s + 10 s the Daily passes; 1 ms later it is ticket_stale', async () => {
  for (const [extra, status, code] of [[0, 201, 'ok'], [1, 422, 'ticket_stale']]) {
    const { c, ticket, send } = await server();
    const d = await ticket();
    // The edge is a whole millisecond only when frames / 60 s is (frames a multiple of 3); only then do > and >= differ.
    // So play (a few) different runs of the same seed until one has such a length.
    let run, k = 7;
    do { run = playScripted(d.seed, k++, 'script', 'daily'); } while (run.frames % 3 !== 0 && k < 80);
    assert.equal(run.frames % 3, 0, 'found a run whose edge is a whole millisecond');
    c.t = TW0 + (run.frames / 60 + TICKET_GRACE_S + TICKET_SLACK_S) * S + extra;
    const r = await send(d, run);
    assert.deepEqual([r.status, r.body.error ?? 'ok'], [status, code], `+${extra} ms: ` + JSON.stringify(r.body));
  }
});
