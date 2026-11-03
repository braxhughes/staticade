// a Daily whose try at the deadline fails gets ONE extra try at deadline + 15 s.
// Real createSubmitQueue / createStacklightQueue, real server client and real createWorker with the shipped LIMITS, on a fake
// clock (same style as tests/w59c-stale-ticket.test.js outageRun). Localhost only; the secret is random per run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSubmitQueue, backoffMs, nextTry, afterFail, dailyDeadline, DEADLINE_MARGIN_MS, EXTRA_TRY_MS, MAX_TRIES } from '../games/starfall/submit-queue.js';
import { createStacklightQueue } from '../games/stacklight/modes.js';
import { GAME_ID as SF_ID, GAME_VERSION as SF_VERSION } from '../games/starfall/sim.js';
import { GAME_ID as SL_ID, GAME_VERSION as SL_VERSION } from '../games/stacklight/defs.js';
import { LeaderboardError } from '../leaderboard/api.js';
import { createRemoteLeaderboard, REMOTE_TIMEOUT_MS } from '../server/client.js';
import { LIMITS } from '../server/worker.js';
import { TICKET_GRACE_S } from '../server/daily.js';
import { playScripted, makeEnv, createWorker } from '../server/fixtures.mjs';

const S = 1000;
const memStore = () => { const m = new Map(); return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } }; };
const SECRET = randomBytes(32).toString('hex');
const TW0 = Date.parse('2026-11-07T10:00:00Z');
let N = 0;

// hangMs > 0 = while the server is down, a submit sent at or after the deadline (hangAll: every submit) never
// answers; the fake clock moves on by hangMs and the real client's own timeout (HANG_TIMEOUT_MS of real time, standing
// in for REMOTE_TIMEOUT_MS) ends the wait with code 'timeout', as a hanging server does in the browser.
const HANG_TIMEOUT_MS = 1500;
async function outageRun({ outageS, lateMs = 0, visibleAtS = [], hangMs = 0, hangAll = false }) {
  const c = { t: TW0 }, W = createWorker({ now: () => c.t }), env = { ...(await makeEnv()), DAILY_SECRET: SECRET };
  const player = `w59d-player-${String(++N).padStart(4, '0')}`, ip = `198.51.100.${(N % 250) + 1}`;
  const net = { upAt: -Infinity, log: [], t0: TW0, hangFrom: Infinity };
  const fetchFn = async (url, init = {}) => {
    const send = c.t, travel = 1000, kind = new URL(url).pathname.slice(1);
    if (c.t + travel < net.upAt && hangMs > 0 && kind === 'submit' && send >= net.hangFrom) {
      net.log.push(`${((send - net.t0) / S).toFixed(1)}s ${kind}:hang`); // same 0.1 s labels as below (the deadline can sit a fraction of a ms off +580 s)
      c.t = send + hangMs;
      return new Promise(() => {});
    }
    if (c.t + travel < net.upAt) { net.log.push(`${((send - net.t0) / S).toFixed(1)}s ${kind}:down`); throw new TypeError('network down'); }
    c.t = send + travel;
    const res = await W.fetch(new Request(url, { ...init, headers: { ...(init.headers || {}), 'cf-connecting-ip': ip } }), env);
    const b = await res.clone().json();
    net.log.push(`${((send - net.t0) / S).toFixed(1)}s ${kind}:${res.status}${b.error ? '/' + b.error : ''}`);
    c.t = kind === 'daily' ? c.t + travel : send;
    return res;
  };
  const remote = createRemoteLeaderboard({ url: 'https://lb.test', fetch: fetchFn, ...(hangMs > 0 && { timeoutMs: HANG_TIMEOUT_MS }) });
  const d = await remote.getDaily({ game: SF_ID, playerId: player });
  const ticketAt = c.t;
  const run = playScripted(d.seed, 7, 'script', 'daily');
  const go = ticketAt + Math.ceil(run.frames / 60 * S);
  c.t = go; net.t0 = go; net.upAt = go + outageS * S;
  const events = [];
  const q = createSubmitQueue({ remote, backend: memStore(), now: () => c.t, locks: null, version: SF_VERSION, onEvent: e => events.push(e) });
  const body = { game: SF_ID, playerId: player, name: 'ACE', score: run.score, replay: run.replay, seed: d.seed, mode: 'daily', dayKey: d.dayKey, version: SF_VERSION, ticket: d.ticket };
  await q.add(body, { ticketAt, frames: run.frames });
  const deadline = q.items()[0].deadline;
  assert.equal(deadline, dailyDeadline(ticketAt, run.frames));
  net.hangFrom = hangAll ? -Infinity : deadline;
  const vis = visibleAtS.map(s => go + s * S).sort((a, b) => a - b), notes = [];
  await q.flush();
  for (let g = 0; g < 80 && q.length; g++) {
    const fire = c.t + Math.max(1000, q.nextDue() - c.t) + lateMs;
    if (vis.length && vis[0] < fire) { c.t = vis.shift(); const due = q.due(); notes.push(`${((c.t - go) / S).toFixed(1)}s visible (due: ${due})`); if (due) await q.flush(); continue; }
    c.t = fire;
    await q.flush();
  }
  const windowEnd = parseInt(d.ticket.split('.')[0], 36) + (run.frames / 60 + 610) * S;
  return { last: events.at(-1), events, log: net.log, notes, q, deadlineS: (deadline - go) / S, windowEndS: (windowEnd - go) / S };
}
const line = (label, r) => `${label}: deadline +${r.deadlineS.toFixed(1)}s, window ends +${r.windowEndS.toFixed(1)}s, result ${r.last.kind}${r.last.code ? '/' + r.last.code : ''}\n    tries: ${r.log.join(' ')}${r.notes.length ? '\n    ' + r.notes.join(' ') : ''}`;
const submits = r => r.log.filter(l => / submit:/.test(l));

test('(a) server back at +590 s and +595 s (after the deadline, inside the window): the run is accepted at the extra try (real Worker, shipped LIMITS)', async () => {
  assert.equal(LIMITS.ticketGraceS, TICKET_GRACE_S);
  const out = [];
  for (const outageS of [590, 595]) {
    const r = await outageRun({ outageS, visibleAtS: [outageS] });
    out.push(line(`outage ${outageS} s, timers on time, visible at +${outageS} s`, r));
    assert.equal(r.last.kind, 'ok', line('outage ' + outageS, r));
    assert.equal(r.q.length, 0);
    assert.ok(r.log.at(-1).startsWith('595.0s submit:201'), r.log.at(-1));
    assert.ok(r.log.at(-2).startsWith('580.0s submit:down'), r.log.at(-2));
  }
  console.log('w59d transcripts:\n  ' + out.join('\n  '));
});

// The +600 s case is printed, not asserted, so a later change may close this gap without a test edit.
// Today a server back after the extra try (about the last 14 s of the window) still loses the run; see the log and README.
test('(a2) transcript only: server back at +600 s (inside the window, after the extra try at +595 s)', async () => {
  const r = await outageRun({ outageS: 600, visibleAtS: [600] });
  console.log('w59d +600 s transcript (not asserted, remaining gap):\n  ' + line('outage 600 s', r));
});

test('(b) server back at +620 s (past the window): ticket_stale, dropped, no further tries', async () => {
  const r = await outageRun({ outageS: 620 });
  assert.deepEqual([r.last.kind, r.last.code], ['drop', 'ticket_stale'], line('620', r));
  assert.equal(r.q.length, 0);
  const s = submits(r);
  assert.ok(s.at(-1).endsWith('submit:422/ticket_stale'), s.at(-1));
  assert.ok(s.at(-2).startsWith('595.0s submit:down'), 'the extra try failed, then the plain backoff: ' + s.at(-2));
  assert.equal(r.events.filter(e => e.kind === 'drop').length, 1);
});

// a remote that is always down; records the clock at every try
function downRemote(clock, code = 'offline') { const tries = []; return { tries, async submitScore() { tries.push(clock.t); throw new LeaderboardError(code, 'x'); } }; }
async function drive(q, clock, until) { for (let g = 0; g < 200 && q.length && clock.t <= until; g++) { await q.flush(); if (!q.length) break; const n = q.nextDue(); clock.t = n > clock.t ? n : clock.t + 1; } }
const FRAMES = 3600, T0 = 10_000_000, GO = T0 + FRAMES / 60 * S;
const fpBody = (i, extra = {}) => ({ game: SF_ID, playerId: 'retry-player-01', name: 'ACE', score: 1000 + i, replay: 'replay-' + i, seed: 7, mode: 'free', version: SF_VERSION, ...extra });
const dBody = i => fpBody(i, { mode: 'daily', dayKey: '2026-10-30', ticket: 'tick' + i });
const mk = (clock, remote) => createSubmitQueue({ remote, backend: memStore(), now: () => clock.t, locks: null, version: SF_VERSION });

test('(c) Free Play schedule unchanged (the plain doubling backoff, same list as w59c MED-1(a))', async () => {
  const clock = { t: GO }, remote = downRemote(clock), q = mk(clock, remote);
  await q.add(fpBody(1), { ticketAt: T0, frames: FRAMES });
  assert.equal(q.items()[0].deadline, undefined);
  await drive(q, clock, GO + 20000 * S);
  const expect = [0]; for (let k = 1; k < MAX_TRIES; k++) expect.push(expect.at(-1) + backoffMs(k) / S);
  assert.deepEqual(remote.tries.map(t => (t - GO) / S), expect);
  for (const tries of [1, 4, 9]) assert.equal(nextTry(GO, tries, 'offline', undefined), GO + backoffMs(tries, 'offline'));
});

test('(d) STACKLIGHT\'s queue (createStacklightQueue) gets the same extra try', async () => {
  const clock = { t: GO }, tries = [];
  const remote = { async submitScore() { tries.push(clock.t); if (clock.t < GO + 590 * S) throw new LeaderboardError('offline', 'down'); return { id: 's', placements: { all: 1 } }; } };
  const q = createStacklightQueue({ remote, backend: memStore(), now: () => clock.t, locks: null });
  const body = { game: SL_ID, playerId: 'retry-player-01', name: 'ACE', score: 500, replay: 'sl-replay-1', seed: 9, mode: 'daily', dayKey: '2026-10-30', ticket: 'sl-ticket', version: SL_VERSION, stats: { hash: '1', frames: FRAMES, stage: 1 } };
  assert.equal(await q.add(body, { ticketAt: T0, frames: FRAMES }), true);
  await drive(q, clock, GO + 700 * S);
  assert.equal(q.length, 0);
  assert.deepEqual(tries.slice(-2).map(t => (t - GO) / S), [580, 595]);
});

test('(e) the extra try happens once: a failure at the extra try goes to the plain backoff, and a rate_limited answer follows the same rule', async () => {
  for (const code of ['offline', 'rate_limited']) {
    const clock = { t: GO }, remote = downRemote(clock, code), q = mk(clock, remote);
    await q.add(dBody(1), { ticketAt: T0, frames: FRAMES });
    const deadline = dailyDeadline(T0, FRAMES);
    await drive(q, clock, GO + 5000 * S);
    const after = remote.tries.filter(t => t >= deadline);
    assert.equal(after[0], deadline);
    assert.equal(after[1], deadline + DEADLINE_MARGIN_MS / 2, code + ': the one extra try');
    assert.equal(after[2], after[1] + backoffMs(remote.tries.length - after.length + 2, code), code + ': then the plain backoff, not another extra try');
    assert.ok(after[2] - after[1] > DEADLINE_MARGIN_MS, 'a long gap, not a second 15 s step');
    assert.equal(remote.tries.length, MAX_TRIES);
  }
  // rate_limited just before the deadline goes to the deadline, then to the extra try
  const clock = { t: GO + 560 * S }, remote = downRemote(clock, 'rate_limited'), q = mk(clock, remote);
  await q.add(dBody(2), { ticketAt: T0, frames: FRAMES });
  await q.flush(); assert.equal(q.items()[0].next, GO + 580 * S);
  clock.t = GO + 580 * S; await q.flush(); assert.equal(q.items()[0].next, GO + 595 * S);
  clock.t = GO + 595 * S; await q.flush(); assert.equal(q.items()[0].next, GO + 595 * S + 60 * S);
});

test('(f) a hidden tab with timers 60 s late behaves as in w59c: lost if it stays hidden, sent when visible at +590 s', async () => {
  const hidden = await outageRun({ outageS: 590, lateMs: 60 * S });
  assert.deepEqual([hidden.last.kind, hidden.last.code], ['drop', 'ticket_stale'], line('hidden', hidden));
  const shown = await outageRun({ outageS: 590, lateMs: 60 * S, visibleAtS: [590] });
  assert.equal(shown.last.kind, 'ok', line('shown', shown));
  assert.ok(shown.log.at(-1).startsWith('590.0s submit:201'), shown.log.at(-1));
});

test('an old stored entry (no new field) is read and gets the extra try', async () => {
  const clock = { t: GO }, store = memStore(), remote = downRemote(clock);
  store.setItem('starfall.sendq', JSON.stringify({ v: 1, items: [{ id: 'x', body: dBody(3), tries: 7, next: GO + 315 * S, code: 'offline', deadline: GO + 580 * S }] }));
  const q = createSubmitQueue({ remote, backend: store, now: () => clock.t, locks: null, version: SF_VERSION });
  clock.t = GO + 580 * S; await q.flush();
  assert.equal(q.items()[0].next, GO + 595 * S);
});

// ---- the try at the deadline gets its extra try however long its answer took ----

test('(h) the deadline try hangs until the client timeout (REMOTE_TIMEOUT_MS), server back at +590 s: accepted at the extra try (real client timeout, real Worker)', async () => {
  assert.equal(EXTRA_TRY_MS, 15 * S);
  assert.equal(REMOTE_TIMEOUT_MS, 15 * S);
  const out = [];
  for (const hangAll of [false, true]) {
    const r = await outageRun({ outageS: 590, hangMs: REMOTE_TIMEOUT_MS, hangAll });
    out.push(line(`deadline try hangs ${REMOTE_TIMEOUT_MS / S} s${hangAll ? ' (every try hangs)' : ''}, server back at +590 s`, r));
    assert.equal(r.last.kind, 'ok', line('hang 15 s', r));
    assert.equal(r.q.length, 0);
    const s = submits(r);
    assert.equal(s.at(-2), '580.0s submit:hang', 'the try at the deadline hung: ' + s.at(-2));
    assert.ok(s.at(-1).startsWith('596.0s submit:201'), 'the extra try right after the timeout answer (main.js waits at least 1 s): ' + s.at(-1));
    assert.ok(r.events.some(e => e.kind === 'retry' && e.code === 'timeout'), 'the hang reached the queue as a timeout');
  }
  console.log('w59e hang transcripts:\n  ' + out.join('\n  '));
});

test('(i) the deadline try answers after 14.999 s, exactly 15 s and 20 s: each gets the extra try and is accepted (server back at +590 s)', async () => {
  const out = [];
  for (const [hangMs, at] of [[14999, '596.0s'], [15000, '596.0s'], [20000, '601.0s']]) {
    const r = await outageRun({ outageS: 590, hangMs });
    out.push(line(`deadline try answers after ${hangMs / S} s`, r));
    assert.equal(r.last.kind, 'ok', line('hang ' + hangMs, r));
    const s = submits(r);
    assert.equal(s.at(-2), '580.0s submit:hang', String(hangMs));
    assert.ok(s.at(-1).startsWith(at + ' submit:201'), hangMs + ': the extra try at ' + at + ': ' + s.at(-1));
  }
  console.log('w59e answer-time transcripts:\n  ' + out.join('\n  '));
  // the rule itself, deadline D: a try SENT in [D, D + 15 s) that fails gets the extra try at D + 15 s, or at once if its
  // answer came back at or after that; a try sent at or after D + 15 s gets the plain backoff (once only)
  const D = dailyDeadline(T0, FRAMES), X = D + EXTRA_TRY_MS;
  for (const code of ['timeout', 'offline', 'server_error', 'rate_limited']) {
    assert.equal(afterFail(D, D, 9, code, D), X, code + ': fast answer');
    assert.equal(afterFail(D, D + 14999, 9, code, D), X, code + ': answer after 14.999 s');
    assert.equal(afterFail(D, X, 9, code, D), X, code + ': answer after exactly 15 s');
    assert.equal(afterFail(D, D + 20 * S, 9, code, D), D + 20 * S, code + ': answer after 20 s: at once');
    assert.equal(afterFail(D + 10 * S, D + 25 * S, 9, code, D), D + 25 * S, code + ': sent inside the stretch, answer after it: at once');
    assert.equal(afterFail(X, X + 15 * S, 10, code, D), X + 15 * S + backoffMs(10, code), code + ': the extra try hung too: plain backoff');
    assert.equal(afterFail(X + S, X + S, 10, code, D), X + S + backoffMs(10, code), code + ': the extra try refused: plain backoff');
  }
  // before the deadline and without a deadline: as nextTry at the answer time
  assert.equal(afterFail(D - 60 * S, D - 45 * S, 9, 'timeout', D), D);
  assert.equal(afterFail(D - 14 * S, D + S, 9, 'timeout', D), X);
  assert.equal(afterFail(GO, GO + 15 * S, 3, 'timeout', undefined), GO + 15 * S + backoffMs(3, 'timeout'));
  assert.equal(afterFail(GO, GO + 15 * S, 3, 'timeout', null), GO + 15 * S + backoffMs(3, 'timeout'));
});

test('(i2) two hangs in a row (the deadline try and the extra try both hang 15 s): one extra try only, then the plain backoff (lost: ticket_stale)', async () => {
  const r = await outageRun({ outageS: 900, hangMs: REMOTE_TIMEOUT_MS });
  const s = submits(r);
  assert.deepEqual([r.last.kind, r.last.code], ['drop', 'ticket_stale'], line('two hangs', r));
  const i = s.indexOf('580.0s submit:hang');
  assert.ok(i >= 0, s.join(' '));
  assert.equal(s[i + 1], '596.0s submit:hang', 'the extra try, once: ' + s.join(' '));
  const nextS = parseFloat(s[i + 2]);
  assert.ok(nextS >= 596 + 15 + 60, 'then the plain backoff, not another quick try: ' + s[i + 2]);
  assert.equal(s.length, i + 3, 'nothing after the ticket_stale answer: ' + s.join(' '));
  console.log('w59e two hangs transcript:\n  ' + line('deadline try and extra try hang', r));
});
