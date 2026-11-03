// Server hardening: the 2026-11-01 audit's fixes (the Daily ticket, the held queue, read paths, the near-copy window, the ?lb= override and CORS origin), through the Worker's real entry point
// (createWorker().fetch on node:sqlite via server/sqlite-d1.js) with a clock the test moves. Localhost only; nothing
// here calls a live service. The Daily secret is random per run of this file and is never written anywhere.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';
import { decode, encode } from '../engine/replay.js';
import { createSim, GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { similarity, signatureRecorder } from '../server/dedupe.js';
import { SEASON_EPOCH_MS, SEASON_MS } from '../leaderboard/ranking.js';
import { createSubmitQueue, isRetryable } from '../games/starfall/submit-queue.js';
import { createRemoteLeaderboard } from '../server/client.js';
import { sqliteD1 } from '../server/sqlite-d1.js';
import { replayKey, LIMITS } from '../server/worker.js';
import { TICKET_GRACE_S, TICKET_SLACK_S } from '../server/daily.js';
import { playScripted, record, makeEnv, post, get, createWorker, SCHEMA } from '../server/fixtures.mjs';
import { GAME_ID as SL_ID } from '../games/stacklight/defs.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SECRET = randomBytes(32).toString('hex');
const TOKEN = randomBytes(24).toString('hex');
const H = 3600000, DAY = 24 * H, MIN = 60000;
const D = '2026-11-02', D_MS = Date.parse(D + 'T00:00:00Z');
const dk = (ms) => new Date(ms).toISOString().slice(0, 10);
const hmacSeed = (day, game = GAME_ID) => createHmac('sha256', SECRET).update(`daily:${game}:${day}`).digest().readUInt32BE(0);
const playTime = (run) => Math.ceil(run.frames / 60 * 1000);

let N = 0;
const pid = () => `w54-player-${String(++N).padStart(4, '0')}`;
const ip = () => `198.51.${(N >> 8) & 255}.${(++N) & 255}`;
function clocked(t, limits) { const c = { t }; c.W = createWorker({ now: () => c.t, ...(limits && { limits }) }); return c; }
async function env({ secret = SECRET, admin = false } = {}) { const e = await makeEnv(); if (secret) e.DAILY_SECRET = secret; if (admin) e.ADMIN_TOKEN = TOKEN; return e; }
async function ticket(c, e, player, addr = ip()) {
  const r = await c.W.fetch(new Request(`https://lb.test/daily?game=${GAME_ID}`, { headers: { 'x-player-id': player, 'cf-connecting-ip': addr } }), e);
  const b = await r.json(); assert.equal(r.status, 200, JSON.stringify(b)); return b;
}
const dailyBody = (run, d, player, over) => ({ game: GAME_ID, playerId: player, name: 'ACE', score: run.score, replay: run.replay, seed: d.seed, mode: 'daily', dayKey: d.dayKey, version: GAME_VERSION, ticket: d.ticket, ...over });
const freeBody = (run, seed, player, over) => ({ game: GAME_ID, playerId: player, name: 'ACE', score: run.score, replay: run.replay, seed, mode: 'free', version: GAME_VERSION, ...over });
const sc = (r) => [r.status, r.body.error ?? r.body.code ?? 'ok'];
const count = (e, sql, ...a) => e.DB.raw.prepare(sql).get(...a).n;

const RUNS = new Map();
const runOn = (seed, k = 7, prefix = null) => {
  const key = `${seed}|${k}|${prefix ? prefix.length : 0}`;
  if (!RUNS.has(key)) RUNS.set(key, playScripted(seed, k, 'script', 'daily', prefix));
  return RUNS.get(key);
};
function resim(replay) {
  const h = decode(replay), sim = createSim({ seed: h.seed, mode: h.mode }), rec = signatureRecorder();
  for (let i = 0; i < h.words.length && !sim.done; i++) { const b = sim.score; sim.step(h.words[i]); sim.clearEvents(); rec.add(sim.frame, b, sim.score); }
  return { score: sim.score, hash: sim.stateHash(), sig: rec.sig };
}
// a near copy of `victim` on `seed`: its opening kept, then its own play; alike enough to be held, a different result
function nearCopy(victim, seed, mode = 'daily') {
  const words = decode(victim.replay).words, base = resim(victim.replay);
  for (const frac of [0.9, 0.75, 0.6]) {
    for (let k = 101; k < 140; k++) {
      const r = playScripted(seed, k, 'script', mode, words.slice(0, Math.floor(words.length * frac)));
      if (r.score <= 0 || r.replay === victim.replay) continue;
      const x = resim(r.replay);
      if (x.hash !== base.hash && similarity(x.sig, base.sig) >= 0.75) return r;
    }
  }
  throw new Error('no near copy found');
}

// ---------- the Daily ticket ----------
test('H2: a ticket is good for one run: the same ticket again is ticket_used (409), even from a new name; another playerId is bad_ticket', async () => {
  const t = D_MS + 9 * H, c = clocked(t), e = await env();
  const p = pid(), d = await ticket(c, e, p);
  const a = runOn(d.seed, 7), b = runOn(d.seed, 11), x = runOn(d.seed, 23);
  c.t = t + Math.max(playTime(a), playTime(b), playTime(x)) + 2000;
  assert.deepEqual(sc(await post(c.W, e, dailyBody(a, d, p), { ip: ip() })), [201, 'ok']);
  assert.deepEqual(sc(await post(c.W, e, dailyBody(b, d, p), { ip: ip() })), [409, 'ticket_used']);
  assert.deepEqual(sc(await post(c.W, e, dailyBody(x, d, p, { name: 'ZED' }), { ip: ip() })), [409, 'ticket_used'], 'a new name changes nothing');
  assert.deepEqual(sc(await post(c.W, e, dailyBody(b, d, pid()), { ip: ip() })), [422, 'bad_ticket'], 'a ticket is signed for one playerId');
  assert.deepEqual(sc(await post(c.W, e, dailyBody(a, d, p), { ip: ip() })), [409, 'duplicate_replay'], 'the stored run sent again: answered as delivered, as on m1');
  const rows = (await get(c.W, e, `/board?game=starfall&board=daily&key=${D}`)).body.rows;
  assert.deepEqual(rows.map((r) => r.score), [a.score]);
});

test('H2: two submits racing with one ticket (both checked before either is recorded): exactly one gets in', async () => {
  const t = D_MS + 10 * H, c = clocked(t), e = await env();
  const p = pid(), d = await ticket(c, e, p);
  const a = runOn(d.seed, 7), b = runOn(d.seed, 11);
  c.t = t + Math.max(playTime(a), playTime(b)) + 2000;
  const rs = await Promise.all([post(c.W, e, dailyBody(a, d, p), { ip: ip() }), post(c.W, e, dailyBody(b, d, p), { ip: ip() })]);
  assert.deepEqual(rs.map(sc).sort(), [[201, 'ok'], [409, 'ticket_used']], JSON.stringify(rs.map((r) => r.body)));
  assert.equal((await get(c.W, e, `/board?game=starfall&board=daily&key=${D}`)).body.rows.length, 1);
});

test('H2: one ranked Daily per playerId per day: a new ticket is daily_done (409), also when two race; a new playerId on the same address still gets in (known limit)', async () => {
  const t = D_MS + 11 * H, c = clocked(t), e = await env();
  const p = pid(), addr = '203.0.113.99';
  const d1 = await ticket(c, e, p, addr);
  const a = runOn(d1.seed, 7), b = runOn(d1.seed, 11), x = runOn(d1.seed, 23);
  c.t = t + playTime(a) + 2000;
  assert.deepEqual(sc(await post(c.W, e, dailyBody(a, d1, p), { ip: addr })), [201, 'ok']);
  const d2 = await ticket(c, e, p, addr);
  c.t += playTime(b) + 2000;
  assert.deepEqual(sc(await post(c.W, e, dailyBody(b, d2, p), { ip: addr })), [409, 'daily_done']);
  // race: a fresh player sends two runs on two tickets at once
  const q = pid(), t1 = await ticket(c, e, q, addr); c.t += 1000; const t2 = await ticket(c, e, q, addr); // two tickets (a ticket carries its time)
  c.t += Math.max(playTime(b), playTime(x)) + 2000;
  const rs = await Promise.all([post(c.W, e, dailyBody(b, t1, q), { ip: addr }), post(c.W, e, dailyBody(x, t2, q), { ip: addr })]);
  assert.deepEqual(rs.map(sc).sort(), [[201, 'ok'], [409, 'daily_done']], JSON.stringify(rs.map((r) => r.body)));
  // the known limit: a new playerId from the same address is a new player (no accounts)
  const r3 = pid(), d3 = await ticket(c, e, r3, addr), y = runOn(d1.seed, 31);
  c.t += playTime(y) + 2000;
  assert.deepEqual(sc(await post(c.W, e, dailyBody(y, d3, r3), { ip: addr })), [201, 'ok']);
  // the next day is a new Daily for the same player
  c.t = D_MS + DAY + H;
  const n = await ticket(c, e, p, addr), z = runOn(n.seed, 7);
  c.t += playTime(z) + 2000;
  assert.deepEqual(sc(await post(c.W, e, dailyBody(z, n, p), { ip: addr })), [201, 'ok']);
});

test('H2: a held (202) first run uses the ticket; the held run sent again is still 202 with the same id; a refused run gives the ticket back', async () => {
  const t = D_MS + 12 * H, c = clocked(t), e = await env();
  const v = pid(), dv = await ticket(c, e, v), victim = runOn(dv.seed, 7);
  c.t = t + playTime(victim) + 2000;
  assert.deepEqual(sc(await post(c.W, e, dailyBody(victim, dv, v), { ip: ip() })), [201, 'ok']);
  const copy = nearCopy(victim, dv.seed);
  const cp = pid(), dc = await ticket(c, e, cp), honest = runOn(dv.seed, 41);
  c.t += Math.max(playTime(copy), playTime(honest)) + 2000;
  const held = await post(c.W, e, dailyBody(copy, dc, cp), { ip: ip() });
  assert.deepEqual(sc(held), [202, 'held_for_review']);
  const again = await post(c.W, e, dailyBody(copy, dc, cp), { ip: ip() });
  assert.deepEqual([...sc(again), again.body.heldId], [202, 'held_for_review', held.body.heldId], 'an answer lost on the way back: the resend is answered the same');
  assert.deepEqual(sc(await post(c.W, e, dailyBody(honest, dc, cp), { ip: ip() })), [409, 'ticket_used'], 'held counts as used');

  // a copy refused outright (no room to hold it) is not stored, so the player keeps their Daily
  const c2 = clocked(t, { heldCap: 0 }), e2 = await env();
  const d2 = await ticket(c2, e2, v);
  c2.t = t + playTime(victim) + 2000;
  assert.deepEqual(sc(await post(c2.W, e2, dailyBody(victim, d2, v), { ip: ip() })), [201, 'ok']);
  const q = pid(), dq = await ticket(c2, e2, q);
  c2.t += Math.max(playTime(copy), playTime(honest)) + 2000;
  assert.deepEqual(sc(await post(c2.W, e2, dailyBody(copy, dq, q), { ip: ip() })), [409, 'near_duplicate']);
  assert.equal(count(e2, "SELECT COUNT(*) AS n FROM kv WHERE k LIKE 'dailyrun:%' AND k LIKE ?", `%${q}`), 0, 'claim given back');
  assert.deepEqual(sc(await post(c2.W, e2, dailyBody(honest, dq, q), { ip: ip() })), [201, 'ok'], 'the same ticket then takes an honest run');
});

test(`H2c: with the age rule on (grace ${TICKET_GRACE_S} s + ${TICKET_SLACK_S} s slack), a late ticket is ticket_stale; a slow honest player and the 23:59 run still pass`, async () => {
  const on = { ticketGraceS: TICKET_GRACE_S };
  assert.ok(TICKET_GRACE_S <= 600, 'the brief caps the grace at 10 minutes');
  const t = D_MS + 13 * H, e = await env();
  let k = 50;
  const go = async (start, after, limits = on) => {
    const c = clocked(start, limits), p = pid(), d = await ticket(c, e, p), run = runOn(d.seed, ++k);
    c.t = start + (typeof after === 'function' ? after(run) : after);
    return post(c.W, e, dailyBody(run, d, p), { ip: ip() });
  };
  assert.deepEqual(sc(await go(t, (run) => playTime(run) + 9 * MIN)), [201, 'ok'], 'played, paused a while, typed a name: 9 minutes over');
  assert.deepEqual(sc(await go(t, (run) => playTime(run) + 11 * MIN)), [422, 'ticket_stale']);
  assert.deepEqual(sc(await go(D_MS + 5 * MIN, 46 * H)), [422, 'ticket_stale'], "the audit's 46-hour-old ticket (yesterday's daily)");
  assert.deepEqual(sc(await go(D_MS - MIN, (run) => Math.max(2 * MIN, playTime(run) + 2000))), [201, 'ok'], 'ticket at 23:59, sent after midnight');
  assert.deepEqual(sc(await go(t, (run) => playTime(run) - (TICKET_SLACK_S + 3) * 1000)), [422, 'bad_ticket'], 'the m1 too-fast rule is unchanged');
  // the same 46-hour case with the rule as shipped in LIMITS (off until the owner settles the STACKLIGHT test, see log)
  const shipped = await go(D_MS + 5 * MIN, 46 * H, {});
  assert.deepEqual(sc(shipped), LIMITS.ticketGraceS == null ? [201, 'ok'] : [422, 'ticket_stale']);
});

test('H2: a fresh honest Daily is still 201, and the client\'s queue treats every new code as final (no retry loop)', async () => {
  const t = D_MS + 14 * H, c = clocked(t, { ticketGraceS: TICKET_GRACE_S }), e = await env();
  const p = pid(), d = await ticket(c, e, p), run = runOn(d.seed, 7), other = runOn(d.seed, 11);
  c.t = t + Math.max(playTime(run), playTime(other)) + 2000;
  // the real browser client (server/client.js) and queue (submit-queue.js) talking to the real Worker
  const fetch = (url, init) => c.W.fetch(new Request(url, init), e);
  const R = createRemoteLeaderboard({ url: 'https://lb.test', fetch });
  const m = new Map(), store = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
  const events = [];
  const q = createSubmitQueue({ remote: R, backend: store, locks: null, version: GAME_VERSION, now: () => c.t, onEvent: (ev) => events.push(ev) });
  await q.add(dailyBody(run, d, p));
  await q.flush(true);
  assert.equal(events.at(-1).kind, 'ok', JSON.stringify(events.at(-1)));
  await q.add(dailyBody(other, d, p));
  await q.flush(true);
  assert.deepEqual([events.at(-1).kind, events.at(-1).code, q.length], ['drop', 'ticket_used', 0]);
  const d2 = await ticket(c, e, p);
  c.t += playTime(other) + 2000;
  await q.add(dailyBody(other, d2, p));
  await q.flush(true);
  assert.deepEqual([events.at(-1).kind, events.at(-1).code, q.length], ['drop', 'daily_done', 0]);
  // queued offline, retried long after: ticket_stale, dropped, never sent again
  const p2 = pid(), d3 = await ticket(c, e, p2);
  c.t += 3 * H;
  await q.add(dailyBody(runOn(d3.seed, 23), d3, p2));
  await q.flush(true);
  assert.deepEqual([events.at(-1).kind, events.at(-1).code, q.length], ['drop', 'ticket_stale', 0]);
  const before = events.length;
  c.t += H; await q.flush(true);
  assert.equal(events.length, before, 'nothing left to send');
  for (const [code, status] of [['ticket_used', 409], ['daily_done', 409], ['ticket_stale', 422], ['held_limit', 409]]) {
    assert.equal(isRetryable(Object.assign(new Error(code), { code, status })), false, code);
  }
});

// ---------- the held queue ----------
let VICTIM = null, COPIES = null;
function victimCopies() {
  if (VICTIM) return;
  VICTIM = record('arcade', 2);
  // the frames where flipping fire keeps a finished run with the same score but a new final state (tests/server-dedupe.test.js)
  const frames = [412, 587, 588, 589, 909, 954, 999, 1044, 1089, 1134, 1179, 1195, 1196, 1224, 1269, 1598, 2653, 3085, 3086];
  const seen = new Set([resim(VICTIM.replay).hash]);
  COPIES = [];
  for (const f of frames) {
    const h = decode(VICTIM.replay), w = Uint16Array.from(h.words); w[f] ^= 0x400;
    const replay = encode(h, w), x = resim(replay);
    if (x.score === VICTIM.score && !seen.has(x.hash)) { seen.add(x.hash); COPIES.push(replay); }
  }
  assert.ok(COPIES.length >= 5, `distinct copies: ${COPIES.length}`);
}
const copyBody = (i, player) => freeBody({ score: VICTIM.score, replay: COPIES[i] }, 2, player, { name: 'THF' });

test('M1: held runs are capped at 3 per playerId and 3 per address (held_limit, 409, not stored); the global cap stays', async () => {
  victimCopies();
  const c = clocked(D_MS + 15 * H), e = await env({ secret: null });
  assert.deepEqual([LIMITS.heldPerPlayer, LIMITS.heldPerAddress, LIMITS.heldCap], [3, 3, 500]);
  assert.deepEqual(sc(await post(c.W, e, freeBody(VICTIM, 2, 'victim-0000001'), { ip: ip() })), [201, 'ok']);
  // one playerId, a new address each time
  const g = pid(), ids = [];
  for (let i = 0; i < 3; i++) { const r = await post(c.W, e, copyBody(i, g), { ip: ip() }); assert.deepEqual(sc(r), [202, 'held_for_review']); ids.push(r.body.heldId); }
  assert.deepEqual(sc(await post(c.W, e, copyBody(3, g), { ip: ip() })), [409, 'held_limit']);
  const again = await post(c.W, e, copyBody(0, g), { ip: ip() });
  assert.deepEqual([...sc(again), again.body.heldId], [202, 'held_for_review', ids[0]], 'a run already held is answered as held');
  // the known limit: a new playerId on a new address is a new sender
  assert.deepEqual(sc(await post(c.W, e, copyBody(4, pid()), { ip: ip() })), [202, 'held_for_review']);
  assert.equal(count(e, "SELECT COUNT(*) AS n FROM flagged WHERE status = 'flagged'"), 4, 'the refused copy is not stored');
  assert.equal((await get(c.W, e, '/board?game=starfall')).body.rows.length, 1, 'no copy on the board');
  // one address, a new playerId each time (a fresh database, same copies)
  const c1 = clocked(D_MS + 15 * H), e1 = await env({ secret: null });
  await post(c1.W, e1, freeBody(VICTIM, 2, 'victim-0000001'), { ip: ip() });
  const addr = '2001:db8:aa:bb::1';
  for (let i = 0; i < 3; i++) assert.deepEqual(sc(await post(c1.W, e1, copyBody(i, pid()), { ip: addr })), [202, 'held_for_review']);
  assert.deepEqual(sc(await post(c1.W, e1, copyBody(3, pid()), { ip: '2001:db8:aa:bb:ffff::9' })), [409, 'held_limit'], 'same IPv6 /64');
  assert.equal(count(e1, "SELECT COUNT(*) AS n FROM flagged WHERE status = 'flagged'"), 3);
  // the global cap still answers near_duplicate first
  const c2 = clocked(D_MS + 15 * H, { heldCap: 1 }), e2 = await env({ secret: null });
  await post(c2.W, e2, freeBody(VICTIM, 2, 'victim-0000002'), { ip: ip() });
  assert.deepEqual(sc(await post(c2.W, e2, copyBody(0, pid()), { ip: ip() })), [202, 'held_for_review']);
  assert.deepEqual(sc(await post(c2.W, e2, copyBody(1, pid()), { ip: ip() })), [409, 'near_duplicate']);
});

test(`M1: a held run still waiting after ${LIMITS.heldMaxAgeDays} days is deleted; younger and released ones stay; release frees the sender's slot`, async () => {
  victimCopies();
  const t0 = D_MS + 16 * H, c = clocked(t0), e = await env({ secret: null, admin: true });
  await post(c.W, e, freeBody(VICTIM, 2, 'victim-0000003'), { ip: ip() });
  const addr = '192.0.2.200';
  const old = await post(c.W, e, copyBody(0, pid()), { ip: addr });
  c.t = t0 + 10 * DAY;
  const young = await post(c.W, e, copyBody(1, pid()), { ip: addr });
  const rel = await post(c.W, e, copyBody(2, pid()), { ip: addr });
  assert.deepEqual([old, young, rel].map((r) => r.status), [202, 202, 202]);
  assert.deepEqual(sc(await post(c.W, e, copyBody(3, pid()), { ip: addr })), [409, 'held_limit'], 'the address is full');
  const r = await c.W.fetch(new Request('https://lb.test/admin/release', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' }, body: JSON.stringify({ id: rel.body.heldId }) }), e);
  assert.equal(r.status, 201);
  c.t = t0 + 14 * DAY + 11 * MIN; // a new rate window: the next request sweeps
  await get(c.W, e, `/daily?game=${GAME_ID}`);
  await c.W.fetch(new Request(`https://lb.test/daily?game=${GAME_ID}`, { headers: { 'cf-connecting-ip': ip() } }), e);
  const left = e.DB.raw.prepare('SELECT id, status FROM flagged ORDER BY id').all().map((x) => [x.id, x.status]);
  assert.deepEqual(left, [[young.body.heldId, 'flagged'], [rel.body.heldId, 'released']]);
  assert.equal(count(e, "SELECT COUNT(*) AS n FROM kv WHERE k LIKE 'heldip:%'"), 1, 'address rows of expired and released runs are gone');
  assert.deepEqual(sc(await post(c.W, e, copyBody(4, pid()), { ip: addr })), [202, 'held_for_review'], 'room again on that address');
});

// ---------- read paths ----------
test('M2: /board and /rank refuse unknown games, versions, seasons and days before any read; real boards still 200', async () => {
  const now = SEASON_EPOCH_MS + 2 * SEASON_MS + 3 * DAY + 5 * H; // season 2
  const c = clocked(now), e = await env({ secret: null });
  const today = dk(now), yest = dk(now - DAY), tom = dk(now + DAY), after = dk(now + 2 * DAY);
  const run = playScripted(5, 3);
  assert.equal((await post(c.W, e, freeBody(run, 5, pid()), { ip: ip() })).status, 201);
  let reads = 0;
  const counting = { ...e, DB: { ...e.DB, prepare: (sql) => { reads++; return e.DB.prepare(sql); } } };
  const want = async (q, status, code) => {
    reads = 0;
    const r = await get(c.W, counting, q);
    assert.deepEqual([r.status, r.body.error ?? 'ok'], [status, code], q + ' ' + JSON.stringify(r.body));
    if (status !== 200) assert.equal(reads, 0, q + ': refused before any database read');
    return r;
  };
  for (const [q, code] of [
    ['/board?game=zz-not-a-game', 'bad_game'], ['/board?game=constructor', 'bad_game'], ['/board?game=starfall&version=9999', 'bad_version'],
    ['/board?game=starfall&version=0', 'bad_version'], ['/board?game=starfall&version=4', 'bad_version'],
    ['/board?game=starfall&board=season&key=-999999', 'bad_board'], ['/board?game=starfall&board=season&key=-1', 'bad_board'],
    ['/board?game=starfall&board=season&key=4', 'bad_board'], ['/board?game=starfall&board=daily&key=1970-01-01', 'bad_board'],
    ['/board?game=starfall&board=daily&key=2026-10-29', 'bad_board'], [`/board?game=starfall&board=daily&key=${after}`, 'bad_board'],
    [`/board?game=${SL_ID}&version=4`, 'bad_version'],
    ['/rank?game=zz-not-a-game&playerId=whatever-1234', 'bad_game'], ['/rank?game=starfall&playerId=whatever-1234&version=9999', 'bad_version'],
  ]) await want(q, 400, code);
  for (const q of ['/board?game=starfall', '/board?game=starfall&version=2.5', '/board?game=starfall&version=1', '/board?game=starfall&version=3',
    '/board?game=starfall&board=season', '/board?game=starfall&board=season&key=2', '/board?game=starfall&board=season&key=1',
    '/board?game=starfall&board=season&key=0', '/board?game=starfall&board=season&key=3', '/board?game=starfall&board=daily',
    `/board?game=starfall&board=daily&key=${today}`, `/board?game=starfall&board=daily&key=${yest}`, `/board?game=starfall&board=daily&key=${tom}`,
    '/board?game=starfall&board=daily&key=2026-10-30', `/board?game=${SL_ID}`, `/board?game=${SL_ID}&version=1`, `/board?game=${SL_ID}&board=season`,
    `/board?game=${SL_ID}&version=2`, '/rank?game=starfall&playerId=whatever-1234', `/rank?game=${SL_ID}&playerId=whatever-1234`]) await want(q, 200, 'ok');
  assert.deepEqual((await get(c.W, e, '/board?game=starfall')).body.rows.map((r) => r.score), [run.score]);
  assert.deepEqual((await get(c.W, e, '/board?game=starfall&board=season&key=2')).body.rows.map((r) => r.score), [run.score], 'the current season board');
});

test('M2: /replay/:id goes through the edge cache (the second read costs no database read); a 404 is not cached; hide deletes it', async () => {
  const store = new Map(); let matches = 0;
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { default: {
    async match(req) { matches++; return store.get(req.url)?.clone(); }, async put(req, res) { store.set(req.url, res); }, async delete(req) { return store.delete(req.url); } } } });
  try {
    const c = clocked(D_MS + 17 * H), e = await env({ secret: null, admin: true });
    const run = playScripted(6, 3), stored = await post(c.W, e, freeBody(run, 6, pid()), { ip: ip() });
    assert.equal(stored.status, 201);
    const id = stored.body.id;
    let reads = 0;
    const counting = { ...e, DB: { ...e.DB, prepare: (sql) => { reads++; return e.DB.prepare(sql); } } };
    const r1 = await get(c.W, counting, `/replay/${id}`);
    assert.equal(r1.status, 200);
    assert.equal(r1.headers.get('cache-control'), `public, max-age=${LIMITS.replayMaxAge}`);
    const afterFirst = reads;
    assert.ok(afterFirst >= 1);
    matches = 0;
    const r2 = await get(c.W, counting, `/replay/${id}`);
    assert.equal(reads, afterFirst, 'served from the cache');
    assert.equal(matches, 1);
    assert.deepEqual(r2.body, r1.body);
    assert.ok(store.has(replayKey('https://lb.test', id)));
    assert.equal((await get(c.W, e, '/replay/no-such-entry')).status, 404);
    assert.ok(!store.has(replayKey('https://lb.test', 'no-such-entry')), 'a 404 is not cached');
    const h = await c.W.fetch(new Request('https://lb.test/admin/hide', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' }, body: JSON.stringify({ entryId: id }) }), e);
    assert.equal(h.status, 200);
    assert.ok(!store.has(replayKey('https://lb.test', id)), 'hide deletes the cached replay');
    assert.equal((await get(c.W, e, `/replay/${id}`)).status, 404);
  } finally { delete globalThis.caches; }
  const readme = fs.readFileSync(path.join(ROOT, 'server/README.md'), 'utf8');
  assert.match(readme, /8b\.[^\n]*\/replay\//, 'WAF step 8b names /replay/');
});

// ---------- the near-copy window ----------
test('M3: a copy of a top run is found even with 55 planted runs between the copy and the original (top-K)', async () => {
  const seed = 7919 * 3, top = playScripted(seed, 3, 'script', 'arcade');
  const words = decode(top.replay).words, base = resim(top.replay);
  let copy = null;
  for (let k = 101; k < 160 && !copy; k++) {
    const r = playScripted(seed, k, 'script', 'arcade', words.slice(0, Math.floor(words.length * 0.75)));
    if (r.score > 0 && r.score < top.score - 60 && similarity(resim(r.replay).sig, base.sig) >= 0.75) copy = r;
  }
  assert.ok(copy, 'a lower-scoring near copy');
  for (const plant of [false, true]) {
    const c = clocked(D_MS + 18 * H), e = await env({ secret: null });
    const orig = await post(c.W, e, freeBody(top, seed, 'victim-0000004'), { ip: ip() });
    assert.equal(orig.status, 201);
    if (plant) {
      const ins = e.DB.raw.prepare('INSERT INTO results (game, board, hash, score, entry, t, sig, seq) VALUES (?, ?, ?, ?, ?, ?, ?, 0)');
      for (let i = 0; i < 55; i++) {
        const s = copy.score + 1 + Math.floor((top.score - copy.score - 2) * i / 55), sig = [];
        for (let j = 0; j < 40; j++) sig.push(100000 + i * 997 + j * 31, 7); // runs nothing like either
        ins.run(GAME_ID, 'free', `plant${i}`, s, `plant-entry-${i}`, c.t, JSON.stringify(sig));
      }
      assert.equal(count(e, "SELECT COUNT(*) AS n FROM results WHERE score > ? AND score < ?", copy.score, top.score), 55);
    }
    const r = await post(c.W, e, freeBody(copy, seed, 'copier-000004', { name: 'CPY' }), { ip: ip() });
    assert.deepEqual(sc(r), [202, 'held_for_review'], `planted=${plant}: ${JSON.stringify(r.body)}`);
    assert.equal(e.DB.raw.prepare('SELECT near_entry FROM flagged').get().near_entry, orig.body.id, 'matched to the original');
  }
});

// ---------- schema: additive, safe twice on a database with rows ----------
test('schema.sql applied twice to a populated pre-w54 database keeps every row and adds the w54 index', async () => {
  victimCopies();
  const W54 = SCHEMA.indexOf('\n-- w54 (audit 2026-11-01).');
  assert.ok(W54 > 0, 'the w54 block is at the end of schema.sql');
  const db = sqliteD1();
  await db.exec(SCHEMA.slice(0, W54)); // the schema as it was before this update (what the live database has)
  const e = { DB: db, DAILY_SECRET: SECRET };
  const c = clocked(D_MS + 19 * H);
  // fill it through the real Worker: free runs (boards, players, ratings, seen, results), a held copy, a Daily
  await post(c.W, e, freeBody(VICTIM, 2, 'victim-0000005'), { ip: ip() });
  for (const s of [5, 6, 8]) assert.equal((await post(c.W, e, freeBody(playScripted(s, 3), s, pid()), { ip: ip() })).status, 201);
  assert.equal((await post(c.W, e, copyBody(0, pid()), { ip: ip() })).status, 202);
  const p = pid(), d = await ticket(c, e, p), run = runOn(d.seed, 7);
  c.t += playTime(run) + 2000;
  assert.equal((await post(c.W, e, dailyBody(run, d, p), { ip: ip() })).status, 201);
  const snap = () => {
    const out = {};
    for (const { name } of db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()) {
      out[name] = db.raw.prepare(`SELECT * FROM "${name}"`).all().map((r) => JSON.stringify(r)).sort();
    }
    return out;
  };
  const before = snap();
  for (const t of ['board', 'players', 'ratings', 'replays', 'results', 'seen', 'flagged', 'kv', 'board_size']) assert.ok(before[t].length > 0, t + ' has rows');
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'flagged_pid'").get().n, 0);
  await db.exec(SCHEMA);
  await db.exec(SCHEMA);
  assert.deepEqual(snap(), before, 'no row added, changed or lost, in any table');
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'flagged_pid'").get().n, 1);
  assert.match(SCHEMA.slice(W54), /^(?:--[^\n]*\n|\s|CREATE INDEX IF NOT EXISTS [^\n]*\n)*$/, 'the w54 block is comments and CREATE INDEX IF NOT EXISTS only');
  assert.equal((await get(c.W, e, '/board?game=starfall')).body.rows.length, 5, 'the Worker still reads it (4 free runs and the Daily)');
});

// ---------- CORS origin ----------
test('L5: no ALLOWED_ORIGIN still answers (CORS *) and warns once per Worker copy; with it, no warning; the example names staticade.com', async () => {
  const warned = [], orig = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    const W = createWorker(), e = await env({ secret: null });
    const r1 = await get(W, e, '/board?game=starfall'), r2 = await get(W, e, '/board?game=starfall');
    assert.equal(r1.headers.get('access-control-allow-origin'), '*');
    assert.equal(r2.status, 200);
    assert.equal(warned.filter((w) => /ALLOWED_ORIGIN is not set/.test(w)).length, 1);
    const W2 = createWorker();
    const r3 = await get(W2, { ...e, ALLOWED_ORIGIN: 'https://staticade.com' }, '/board?game=starfall');
    assert.equal(r3.headers.get('access-control-allow-origin'), 'https://staticade.com');
    assert.equal(warned.length, 1);
  } finally { console.warn = orig; }
  const ex = fs.readFileSync(path.join(ROOT, 'server/wrangler.toml.example'), 'utf8');
  assert.match(ex, /^ALLOWED_ORIGIN = "https:\/\/staticade\.com"$/m);
  assert.ok(!/pages\.dev/.test(ex));
});

// ---------- the ?lb= override is off in the deployed copy ----------
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
function deployScratch(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w54-site-')); made.push(d);
  const G = ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@localhost'];
  for (const dir of ['arcade', 'engine', 'games/starfall', 'leaderboard', 'server']) fs.mkdirSync(path.join(d, dir), { recursive: true });
  fs.writeFileSync(path.join(d, 'index.html'), '<title>x</title>');
  fs.writeFileSync(path.join(d, 'starfall.html'), '<title>x</title>');
  fs.writeFileSync(path.join(d, 'stacklight.html'), '<title>x</title>');
  fs.writeFileSync(path.join(d, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  fs.writeFileSync(path.join(d, 'sitemap.xml'), '<urlset></urlset>\n');
  for (const dir of ['arcade', 'engine', 'games', 'leaderboard']) fs.writeFileSync(path.join(d, dir, 'a.js'), '// ok\n');
  fs.writeFileSync(path.join(d, 'server', 'client.js'), "export const REMOTE_LEADERBOARD_URL = '';\n");
  for (const [p, txt] of Object.entries(files)) fs.writeFileSync(path.join(d, p), txt);
  for (const a of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'x']]) assert.equal(spawnSync('git', [...G, ...a], { cwd: d }).status, 0);
  const cfg = path.join(d, '..', path.basename(d) + '.gitconfig'); made.push(cfg);
  fs.writeFileSync(cfg, '[user]\n\tname = Zed Quokkaman\n\temail = nobody\n');
  return spawnSync('bash', [path.join(ROOT, 'tools/deploy-site.sh'), '--dry-run'],
    { env: { ...process.env, STATICADE_REPO: d, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1' }, cwd: os.tmpdir(), encoding: 'utf8' });
}
test('L3: deploy-site.sh (dry run only) switches the ?lb= localhost override off in the built copy, and its leak grep refuses one left on', () => {
  const line = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').find((l) => l.includes("get('lb')"));
  const main = line('games/starfall/main.js'), lobby = line('arcade/lobby-board.js');
  assert.ok(main && lobby, 'both overrides found in the repo');
  const r = deployScratch({ 'games/starfall/main.js': main + '\n', 'arcade/lobby-board.js': lobby + '\n' });
  assert.equal(r.status, 0, r.stderr);
  const folder = r.stdout.trim().split('\n').find((l) => l.endsWith('/site'));
  made.push(path.dirname(folder));
  for (const f of ['games/starfall/main.js', 'arcade/lobby-board.js']) {
    const built = fs.readFileSync(path.join(folder, f), 'utf8');
    assert.ok(!built.includes('127\\.0\\.0\\.1'), f + ': no localhost check left');
    assert.ok(built.includes("get('lb')") && built.includes('/(?!)/.test(v)'), f + ': the override reads ?lb= but never accepts it');
    // and it really is off: run the built check on a localhost address
    const check = built.match(/v && (\/.*?\/)\.test\(v\)/)[1];
    assert.equal(new Function('v', `return ${check}.test(v)`)('http://127.0.0.1:8850'), false);
  }
  assert.equal(fs.readFileSync(path.join(ROOT, 'games/starfall/main.js'), 'utf8').includes('127\\.0\\.0\\.1'), true, 'the repo copy is untouched');
  // an override written another way is caught by the leak grep
  const bad = deployScratch({ 'arcade/x.js': "const v = new URLSearchParams(location.search).get('lb'); export const u = v && /^http:\\/\\/localhost/.test(v) ? v : '';\n" });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /LEAK \(\?lb= override\)/);
});
