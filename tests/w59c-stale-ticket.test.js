// STACKLIGHT never starts a ranked Daily on an old ticket, and a due
// Daily try is sent when the page is visible again. Node half: the real createModes (STACKLIGHT), the real createSubmitQueue
// and createStacklightQueue, the real server client and the real createWorker(...).fetch with the shipped LIMITS, on a fake
// clock. The page half (stacklight.html, starfall.html) is tests/w59c-stale-ticket-browser.test.js.
// The transcripts printed here are the ones recorded when this was written. Localhost only; the secret is random per run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createSubmitQueue, backoffMs, dailyDeadline, MAX_TRIES } from '../games/starfall/submit-queue.js';
import { createModes, createStacklightQueue, TICKET_FRESH_MS } from '../games/stacklight/modes.js';
import { GAME_ID as SL_ID, GAME_VERSION as SL_VERSION } from '../games/stacklight/defs.js';
import { GAME_ID as SF_ID, GAME_VERSION as SF_VERSION } from '../games/starfall/sim.js';
import { LeaderboardError } from '../leaderboard/api.js';
import { createRemoteLeaderboard } from '../server/client.js';
import { TICKET_GRACE_S } from '../server/daily.js';
import { LIMITS } from '../server/worker.js';
import { playScripted, makeEnv, createWorker } from '../server/fixtures.mjs';
import { playRun } from '../tools/stacklight-bot.mjs';

const S = 1000, MIN = 60 * S;
const memStore = () => { const m = new Map(); return { m, getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } }; };
const SECRET = randomBytes(32).toString('hex');
const TW0 = Date.parse('2026-11-07T10:00:00Z');
let N = 0;

// ---------- the freshness rule ----------
test('TICKET_FRESH_MS is 60 s and leaves most of the 600 s grace for pause, name and send', () => {
  assert.equal(TICKET_FRESH_MS, 60000);
  assert.ok(TICKET_FRESH_MS <= TICKET_GRACE_S * S / 10);
});

test('modes.ticketFresh: fresh up to 60 s after the ticket first arrived, old after; no ticket is always fine; unseen or a clock gone back is old', () => {
  const c = { t: TW0 }, m = createModes({ now: () => c.t });
  const ans = { dayKey: '2026-11-07', seed: 77, ticket: 'sl-tick-A' };
  assert.equal(m.ticketFresh(ans), false, 'a ticket this page never saw');
  m.begin('daily', 0, ans); // the answer arrives (main.js calls begin at once)
  assert.equal(m.ticketFresh(ans), true);
  c.t = TW0 + TICKET_FRESH_MS; assert.equal(m.ticketFresh(ans), true, 'exactly 60 s');
  c.t = TW0 + TICKET_FRESH_MS + 1; assert.equal(m.ticketFresh(ans), false, '60 s + 1 ms');
  c.t = TW0 + 15 * MIN; assert.equal(m.ticketFresh(ans), false, '15 minutes');
  c.t = TW0 - 1; assert.equal(m.ticketFresh(ans), false, 'the clock went back');
  assert.equal(m.ticketFresh({ ...ans, ticket: null }), true, 'no ticket (no secret on the server): nothing to go stale');
  assert.equal(m.ticketFresh(null), true);
  c.t = TW0 + 15 * MIN; m.begin('daily', 0, { ...ans, ticket: 'sl-tick-B' });
  assert.equal(m.ticketFresh({ ...ans, ticket: 'sl-tick-B' }), true, 'a new ticket is fresh');
});

// ---------- the queue's due() helper (main.js flushes on visibilitychange when it is true) ----------
test('queue.due(): false when empty, true for a new entry, false while it waits its backoff, true again once next has come', async () => {
  const c = { t: TW0 }, store = memStore();
  const remote = { async submitScore() { throw new LeaderboardError('offline', 'down'); } };
  const q = createSubmitQueue({ remote, backend: store, now: () => c.t, locks: null, version: SF_VERSION });
  assert.equal(q.due(), false, 'empty');
  await q.add({ game: SF_ID, playerId: 'w59c-player-01', name: 'ACE', score: 10, replay: 'r1', seed: 1, mode: 'free', version: SF_VERSION });
  assert.equal(q.due(), true, 'new entries go at once');
  await q.flush();
  assert.equal(q.items()[0].next, TW0 + backoffMs(1));
  assert.equal(q.due(), false);
  c.t = TW0 + backoffMs(1) - 1; assert.equal(q.due(), false);
  c.t = TW0 + backoffMs(1); assert.equal(q.due(), true);
  const sl = createStacklightQueue({ remote, backend: memStore(), now: () => c.t, locks: null });
  assert.equal(sl.due(), false, 'STACKLIGHT\'s queue has it too');
});

// ---------- end to end transcripts ----------
// The real Worker on a fake clock; the client's fetch goes to W.fetch. Each request takes travelMs to reach the server.
async function world({ travelMs = 1000 } = {}) {
  const c = { t: TW0 }, W = createWorker({ now: () => c.t }), env = { ...(await makeEnv()), DAILY_SECRET: SECRET };
  const player = `w59c-player-${String(++N).padStart(4, '0')}`, ip = `198.51.100.${(N % 250) + 1}`;
  const net = { upAt: -Infinity, log: [], t0: TW0 };
  const fetchFn = async (url, init = {}) => {
    const send = c.t, arrive = c.t + travelMs;
    const kind = new URL(url).pathname.slice(1);
    if (arrive < net.upAt) { net.log.push(`${((send - net.t0) / S).toFixed(1)}s ${kind}:down`); throw new TypeError('network down'); }
    c.t = arrive;
    const res = await W.fetch(new Request(url, { ...init, headers: { ...(init.headers || {}), 'cf-connecting-ip': ip } }), env);
    const b = await res.clone().json();
    net.log.push(`${((send - net.t0) / S).toFixed(1)}s ${kind}:${res.status}${b.error ? '/' + b.error : ''}`);
    if (kind === 'daily') c.t += travelMs; // the answer travels back (the submit's return trip is left out, as in the earlier probes)
    else c.t = send;
    return res;
  };
  const remote = createRemoteLeaderboard({ url: 'https://lb.test', fetch: fetchFn });
  return { c, W, env, player, net, remote };
}

test('HIGH-1 transcript: STACKLIGHT Daily highlighted, started 15 minutes later: the page asks again and the run is accepted (201); the old cached ticket would have been ticket_stale', async () => {
  assert.equal(LIMITS.ticketGraceS, TICKET_GRACE_S);
  const w = await world(), { c, net } = w;
  const modes = createModes({ now: () => c.t });
  const lines = [];
  // the title cursor lands on DAILY RIDGE: the page asks once and keeps the answer (main.js dServer)
  const dServer = await w.remote.getDaily({ game: SL_ID, playerId: w.player });
  modes.begin('daily', 0, dServer);
  lines.push(`0.0s highlight: GET /daily, ticket A issued at server ${(parseInt(dServer.ticket.split('.')[0], 36) - TW0) / S}s`);
  // 15 minutes of Free Play or idling, then Enter on DAILY RIDGE: main.js chooseDaily(true) checks ticketFresh first
  c.t = TW0 + 15 * MIN;
  assert.equal(modes.ticketFresh(dServer), false, 'the cached ticket is too old to start on');
  const fresh = await w.remote.getDaily({ game: SL_ID, playerId: w.player });
  assert.notEqual(fresh.ticket, dServer.ticket);
  assert.deepEqual([fresh.dayKey, fresh.seed], [dServer.dayKey, dServer.seed], 'same day, same seed: only the ticket is new');
  const run = modes.begin('daily', 0, fresh);
  assert.equal(run.ticket, fresh.ticket);
  assert.equal(run.ticketAt, c.t, 'the run times its window from the new ticket');
  lines.push(`${((c.t - TW0) / S).toFixed(1)}s start: ticket A is ${((c.t - TW0) / S).toFixed(0)}s old (> ${TICKET_FRESH_MS / S}s), GET /daily again, ticket B`);
  // play the run (a real STACKLIGHT sim on the day's seed), then name entry for 5 s, then the queue sends it
  const p = playRun({ seed: fresh.seed, tier: 1, mode: 'daily' });
  assert.ok(p.score > 0 && p.frames > 0);
  c.t += Math.ceil(p.frames / 60 * S) + 5 * S;
  const body = { game: SL_ID, playerId: w.player, name: 'ACE', score: p.score, replay: p.replay, seed: fresh.seed, mode: 'daily', dayKey: fresh.dayKey,
    ticket: run.ticket, version: SL_VERSION, stats: { hash: String(p.hash), frames: p.frames, stage: p.level } };
  // the control: the same run on the cached ticket A, checked by a second Worker copy with the same clock and secret (no claim is made)
  const W2 = createWorker({ now: () => c.t }), env2 = { ...(await makeEnv()), DAILY_SECRET: SECRET };
  const ctl = await W2.fetch(new Request('https://lb.test/submit', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.9' },
    body: JSON.stringify({ ...body, ticket: dServer.ticket }) }), env2);
  const ctlBody = await ctl.json();
  assert.deepEqual([ctl.status, ctlBody.error], [422, 'ticket_stale'], 'before w59c the run went out on ticket A and was refused');
  lines.push(`${((c.t - TW0) / S).toFixed(1)}s control: the same run on cached ticket A: ${ctl.status}/${ctlBody.error}`);
  const events = [];
  const q = createStacklightQueue({ remote: w.remote, backend: memStore(), now: () => c.t, locks: null, onEvent: e => events.push(e) });
  assert.equal(await q.add(body, { ticketAt: run.ticketAt, frames: p.frames }), true);
  net.log.length = 0; net.t0 = TW0;
  await q.flush();
  assert.equal(events.at(-1).kind, 'ok', JSON.stringify(events.at(-1).code));
  assert.equal(q.length, 0);
  lines.push(`${((c.t - TW0) / S).toFixed(1)}s game over after ${(p.frames / 60).toFixed(1)}s of play + 5s name: ${net.log.join(' ')} (ticket B)`);
  console.log('HIGH-1 transcript (STACKLIGHT, fake clock, real queue and createWorker):\n  ' + lines.join('\n  '));
});

// One Starfall Daily with a server outage after game over, the queue run the way main.js runs it: a timer at
// max(1000, due - now), that fires `lateMs` late (a throttled hidden tab), plus optional
// visibilitychange events at the given seconds after game over (main.js: if (!document.hidden && sendq.due()) flushQueue()).
async function outageRun({ outageS, lateMs = 0, visibleAtS = [] }) {
  const w = await world(), { c, net } = w;
  const d = await w.remote.getDaily({ game: SF_ID, playerId: w.player });
  const ticketAt = c.t; // the answer reached the page (Starfall: Date.now() when it arrives)
  const run = playScripted(d.seed, 7, 'script', 'daily');
  const go = ticketAt + Math.ceil(run.frames / 60 * S);
  c.t = go; net.t0 = go; net.upAt = go + outageS * S;
  const events = [];
  const q = createSubmitQueue({ remote: w.remote, backend: memStore(), now: () => c.t, locks: null, version: SF_VERSION, onEvent: e => events.push(e) });
  const body = { game: SF_ID, playerId: w.player, name: 'ACE', score: run.score, replay: run.replay, seed: d.seed, mode: 'daily', dayKey: d.dayKey, version: SF_VERSION, ticket: d.ticket };
  await q.add(body, { ticketAt, frames: run.frames });
  const deadline = q.items()[0].deadline;
  assert.equal(deadline, dailyDeadline(ticketAt, run.frames));
  const vis = visibleAtS.map(s => go + s * S).sort((a, b) => a - b);
  const notes = [];
  await q.flush();
  for (let g = 0; g < 80 && q.length; g++) {
    let fire = c.t + Math.max(1000, q.nextDue() - c.t) + lateMs;
    if (vis.length && vis[0] < fire) { // the player comes back to the tab before the timer fires
      c.t = vis.shift();
      const due = q.due();
      notes.push(`${((c.t - go) / S).toFixed(1)}s visible (due: ${due})`);
      if (due) await q.flush();
      continue;
    }
    c.t = fire;
    await q.flush();
  }
  const windowEnd = parseInt(d.ticket.split('.')[0], 36) + (run.frames / 60 + 610) * S;
  return { last: events.at(-1), log: net.log, notes, deadlineS: (deadline - go) / S, windowEndS: (windowEnd - go) / S };
}
const line = (label, r) => `${label}: deadline +${r.deadlineS.toFixed(1)}s, window ends +${r.windowEndS.toFixed(1)}s, result ${r.last.kind}${r.last.code ? '/' + r.last.code : ''}\n    tries: ${r.log.join(' ')}${r.notes.length ? '\n    ' + r.notes.join(' ') : ''}`;

test('MED-1(a) transcript: outage 590 s, tab hidden, timers 60 s late: lost if it stays hidden; visible at +590 s the late deadline try goes at once (201)', async () => {
  const hidden = await outageRun({ outageS: 590, lateMs: 60 * S });
  assert.deepEqual([hidden.last.kind, hidden.last.code], ['drop', 'ticket_stale'], line('hidden', hidden));
  const shown = await outageRun({ outageS: 590, lateMs: 60 * S, visibleAtS: [590] });
  assert.equal(shown.last.kind, 'ok', line('shown', shown));
  assert.ok(shown.log.at(-1).startsWith('590.0s submit:201'), shown.log.at(-1));
  console.log('MED-1(a) transcripts, outage 590 s, timers 60 s late:\n  ' + [line('hidden all along', hidden), line('visible at +590 s', shown)].join('\n  '));
});

test('w59d: outage 590 s with timers on time: the extra try at +595 s is SENT (accepted), the run is stored', async () => {
  const r = await outageRun({ outageS: 590, visibleAtS: [590] });
  console.log('known limit transcript:\n  ' + line('outage 590 s, timers on time, visible at +590 s', r));
  assert.ok(r.notes.includes('590.0s visible (due: false)'), r.notes.join(' '));
  assert.deepEqual([r.last.kind, r.last.code], ['ok', null]);
});

test('MED-1(a): a visible page with nothing due does not send (Free Play schedule untouched by the visibility check)', async () => {
  const c = { t: TW0 }, tries = [];
  const remote = { async submitScore() { tries.push(c.t); throw new LeaderboardError('offline', 'down'); } };
  const q = createSubmitQueue({ remote, backend: memStore(), now: () => c.t, locks: null, version: SF_VERSION });
  await q.add({ game: SF_ID, playerId: 'w59c-player-02', name: 'ACE', score: 10, replay: 'r2', seed: 1, mode: 'free', version: SF_VERSION });
  for (let g = 0; g < 40 && q.length; g++) {
    await q.flush();
    if (!q.length) break;
    // a visibilitychange every 7 s between tries: never due, never a send
    const next = q.nextDue();
    for (let k = c.t + S; k < next; k += 7 * S) { c.t = k; if (q.due()) await q.flush(); }
    c.t = q.nextDue();
  }
  const expect = [0]; for (let k = 1; k < MAX_TRIES; k++) expect.push(expect.at(-1) + backoffMs(k) / S);
  assert.deepEqual(tries.map(t => (t - TW0) / S), expect);
});
