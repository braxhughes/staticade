// held caps beaten by parallel submits, surviving mutants (m20 and m8)
// and a Daily claim handed back after the run was already written, through the Worker's real entry point
// (createWorker().fetch on node:sqlite via server/sqlite-d1.js) with a clock the test moves. Localhost only; nothing
// here calls a live service. The Daily secret and admin token are random per run of this file and never written.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decode } from '../engine/replay.js';
import { createSim, GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { similarity, signatureRecorder } from '../server/dedupe.js';
import { LIMITS } from '../server/worker.js';
import { DAILY_KEEP_MS } from '../server/daily.js';
import { playScripted, record, makeEnv, post, get, createWorker, SCHEMA } from '../server/fixtures.mjs';

const SECRET = randomBytes(32).toString('hex');
const TOKEN = randomBytes(24).toString('hex');
const H = 3600000, DAY = 24 * H, MIN = 60000;
const D = '2026-11-03', D_MS = Date.parse(D + 'T00:00:00Z');
const playTime = (run) => Math.ceil(run.frames / 60 * 1000);

let N = 0;
const pid = () => `w54b-player-${String(++N).padStart(4, '0')}`;
const ip = () => `198.51.${(N >> 8) & 255}.${(++N) & 255}`;
function clocked(t, limits) { const c = { t }; c.W = createWorker({ now: () => c.t, ...(limits && { limits }) }); return c; }
async function env({ secret = SECRET, admin = false } = {}) { const e = await makeEnv(); if (secret) e.DAILY_SECRET = secret; if (admin) e.ADMIN_TOKEN = TOKEN; return e; }
async function ticket(c, e, player, addr = ip()) {
  const r = await c.W.fetch(new Request(`https://lb.test/daily?game=${GAME_ID}`, { headers: { 'x-player-id': player, 'cf-connecting-ip': addr } }), e);
  const b = await r.json(); assert.equal(r.status, 200, JSON.stringify(b)); return b;
}
const dailyBody = (run, d, player) => ({ game: GAME_ID, playerId: player, name: 'ACE', score: run.score, replay: run.replay, seed: d.seed, mode: 'daily', dayKey: d.dayKey, version: GAME_VERSION, ticket: d.ticket });
const freeBody = (run, seed, player, over) => ({ game: GAME_ID, playerId: player, name: 'ACE', score: run.score, replay: run.replay, seed, mode: 'free', version: GAME_VERSION, ...over });
const sc = (r) => [r.status, r.body.error ?? r.body.code ?? 'ok'];
const count = (e, sql, ...a) => e.DB.raw.prepare(sql).get(...a).n;
const waiting = (e) => count(e, "SELECT COUNT(*) AS n FROM flagged WHERE status = 'flagged'");
const waitingFor = (e, p) => count(e, "SELECT COUNT(*) AS n FROM flagged WHERE status = 'flagged' AND pid = ?", p);
// waiting runs per address, from the table (kv rows heldip:<address>:<id> joined to flagged), not from the answers
const waitingFrom = (e, addr) => count(e, "SELECT COUNT(*) AS n FROM kv JOIN flagged AS f ON f.id = CAST(kv.v AS INTEGER) WHERE kv.k LIKE ? AND f.status = 'flagged'", `heldip:${addr}:%`);

function resim(replay) {
  const h = decode(replay), sim = createSim({ seed: h.seed, mode: h.mode }), rec = signatureRecorder();
  for (let i = 0; i < h.words.length && !sim.done; i++) { const b = sim.score; sim.step(h.words[i]); sim.clearEvents(); rec.add(sim.frame, b, sim.score); }
  return { score: sim.score, hash: sim.stateHash(), sig: rec.sig };
}
// One stored run and 20 distinct near copies of it: its opening (90% or 80% of its frames) kept, then a scripted
// player of their own. Each copy is a finished run with its own result (final state), so each is held as its own row.
let VICTIM = null, COPIES = null;
function victimCopies() {
  if (VICTIM) return;
  VICTIM = record('arcade', 2);
  const base = resim(VICTIM.replay), words = decode(VICTIM.replay).words, seen = new Set([base.hash]);
  COPIES = [];
  for (const frac of [0.9, 0.8]) {
    for (let k = 101; k < 140 && COPIES.length < 20; k++) {
      const r = playScripted(2, k, 'script', 'arcade', words.slice(0, Math.floor(words.length * frac)));
      const x = resim(r.replay);
      if (r.score > 0 && !seen.has(x.hash) && similarity(x.sig, base.sig) >= 0.75) { seen.add(x.hash); COPIES.push(r); }
    }
  }
  assert.equal(COPIES.length, 20, `distinct copies: ${COPIES.length}`);
}
const copyBody = (i, player) => freeBody(COPIES[i], 2, player, { name: 'THF' });
async function boardWithVictim(limits) {
  const c = clocked(D_MS + 15 * H, limits), e = await env({ secret: null });
  assert.deepEqual(sc(await post(c.W, e, freeBody(VICTIM, 2, `victim-${String(++N).padStart(6, '0')}`), { ip: ip() })), [201, 'ok']);
  return { c, e };
}
const tally = (rs) => { const m = {}; for (const r of rs) { const k = sc(r).join(' '); m[k] = (m[k] || 0) + 1; } return m; };

// ---------- the caps hold when copies arrive at the same moment ----------
test('MED-1: 5 distinct near copies for one playerId from 5 addresses, all at once: 3 held (202), 2 held_limit (409); 3 rows in the table', async () => {
  victimCopies();
  assert.deepEqual([LIMITS.heldPerPlayer, LIMITS.heldPerAddress], [3, 3]);
  const { c, e } = await boardWithVictim();
  const g = pid();
  const rs = await Promise.all([0, 1, 2, 3, 4].map((i) => post(c.W, e, copyBody(i, g), { ip: ip() })));
  assert.deepEqual(tally(rs), { '202 held_for_review': 3, '409 held_limit': 2 }, JSON.stringify(rs.map((r) => r.body)));
  assert.equal(waitingFor(e, g), 3, 'held rows for that playerId, counted in the table');
  assert.equal(waiting(e), 3);
  assert.equal(new Set(rs.filter((r) => r.status === 202).map((r) => r.body.heldId)).size, 3, 'three different held runs');
});

test('MED-1: 5 distinct near copies from one address under 5 playerIds, all at once: 3 held, 2 held_limit; 3 address rows', async () => {
  victimCopies();
  const { c, e } = await boardWithVictim();
  const addr = '203.0.113.150';
  const rs = await Promise.all([0, 1, 2, 3, 4].map((i) => post(c.W, e, copyBody(i, pid()), { ip: addr })));
  assert.deepEqual(tally(rs), { '202 held_for_review': 3, '409 held_limit': 2 }, JSON.stringify(rs.map((r) => r.body)));
  assert.equal(waitingFrom(e, addr), 3, 'held rows for that address, counted in the table');
  assert.equal(waiting(e), 3);
  assert.equal(count(e, "SELECT COUNT(*) AS n FROM kv WHERE k LIKE 'heldip:%'"), 3, 'one address row per held run, none for a refused one');
});

test('MED-1: 20 copies at once, mixed over 2 playerIds and 2 addresses (IPv6, one /64 each): no playerId or address passes 3 in the table', async () => {
  victimCopies();
  const { c, e } = await boardWithVictim();
  const ps = [pid(), pid()], as = ['2001:db8:1:1::a', '2001:db8:2:2::b'];
  // the addresses rotate inside their /64, so each address key is shared by 10 requests
  const rs = await Promise.all(COPIES.slice(0, 20).map((_, i) =>
    post(c.W, e, copyBody(i, ps[i % 2]), { ip: as[(i >> 1) % 2].replace(/::\w$/, `::${(i + 1).toString(16)}`) })));
  const t = tally(rs);
  assert.deepEqual(Object.keys(t).sort(), ['202 held_for_review', '409 held_limit'], JSON.stringify(t));
  for (const p of ps) assert.ok(waitingFor(e, p) <= 3, `${p}: ${waitingFor(e, p)}`);
  for (const a of ['2001:db8:1:1::/64', '2001:db8:2:2::/64']) assert.ok(waitingFrom(e, a) <= 3, `${a}: ${waitingFrom(e, a)}`);
  assert.equal(waiting(e), t['202 held_for_review'], 'every 202 is one waiting row, nothing else was written');
  assert.ok(waiting(e) <= 6 && waiting(e) >= 3, `waiting ${waiting(e)}`);
});

test('MED-1: 10 copies at once from 10 senders (new playerId and address each) with the global cap at 4: exactly 4 held, the rest near_duplicate', async () => {
  victimCopies();
  const { c, e } = await boardWithVictim({ heldCap: 4 });
  const rs = await Promise.all(COPIES.slice(0, 10).map((_, i) => post(c.W, e, copyBody(i, pid()), { ip: ip() })));
  assert.deepEqual(tally(rs), { '202 held_for_review': 4, '409 near_duplicate': 6 }, JSON.stringify(tally(rs)));
  assert.equal(waiting(e), 4);
});

test('MED-1: the same held run sent 5 times at once: one row and one address row; the others are duplicate_result (the result claim race, as on m1); a resend after is 202 with the same id', async () => {
  victimCopies();
  const { c, e } = await boardWithVictim();
  const g = pid();
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => post(c.W, e, copyBody(0, g), { ip: ip() })));
  const t = tally(rs);
  assert.ok(t['202 held_for_review'] >= 1 && Object.keys(t).every((k) => k === '202 held_for_review' || k === '409 duplicate_result'), JSON.stringify(t));
  assert.equal(new Set(rs.filter((r) => r.status === 202).map((r) => r.body.heldId)).size, 1);
  assert.equal(waiting(e), 1);
  assert.equal(count(e, "SELECT COUNT(*) AS n FROM kv WHERE k LIKE 'heldip:%'"), 1);
  const again = await post(c.W, e, copyBody(0, g), { ip: ip() });
  assert.deepEqual([...sc(again), again.body.heldId], [202, 'held_for_review', rs.find((r) => r.status === 202).body.heldId]);
});

test('MED-1: on a database with schema.sql applied twice, the caps still hold at once; a released run frees its slot, then the cap holds again', async () => {
  victimCopies();
  const c = clocked(D_MS + 15 * H), e = await env({ secret: null, admin: true });
  await e.DB.exec(SCHEMA); // second time
  await post(c.W, e, freeBody(VICTIM, 2, 'victim-schema2x'), { ip: ip() });
  const g = pid();
  const rs = await Promise.all([0, 1, 2, 3].map((i) => post(c.W, e, copyBody(i, g), { ip: ip() })));
  assert.deepEqual(tally(rs), { '202 held_for_review': 3, '409 held_limit': 1 });
  const id = rs.find((r) => r.status === 202).body.heldId;
  const rel = await c.W.fetch(new Request('https://lb.test/admin/release', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' }, body: JSON.stringify({ id }) }), e);
  assert.equal(rel.status, 201);
  assert.equal(waitingFor(e, g), 2, 'a released run no longer counts');
  const more = await Promise.all([5, 6, 7].map((i) => post(c.W, e, copyBody(i, g), { ip: ip() })));
  assert.deepEqual(tally(more), { '202 held_for_review': 1, '409 held_limit': 2 });
  assert.equal(waitingFor(e, g), 3);
});

// ---------- the sweep keeps today's Daily records (m20) and released runs (m8) ----------
test("LOW-1 (m20): the sweep deletes Daily records older than the keep window but never today's: a new ticket after a sweep is still daily_done", async () => {
  const t = D_MS + 9 * H, c = clocked(t), e = await env();
  // an old record the sweep must remove (proves the sweep ran), planted the way claimDaily writes it
  const oldDay = new Date(t - DAILY_KEEP_MS - DAY).toISOString().slice(0, 10);
  e.DB.raw.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run(`dailyrun:${oldDay}:${GAME_ID}:old-player-0001`, '{"ticket":"x","rhash":"y","t":0}');
  const p = pid(), d = await ticket(c, e, p), a = playScripted(d.seed, 7, 'script', 'daily'), b = playScripted(d.seed, 11, 'script', 'daily');
  c.t = t + playTime(a) + 2000;
  assert.deepEqual(sc(await post(c.W, e, dailyBody(a, d, p), { ip: ip() })), [201, 'ok']);
  c.t += LIMITS.windowMs + MIN; // a new rate window, same day: the next request sweeps
  const d2 = await ticket(c, e, p);
  assert.equal(count(e, "SELECT COUNT(*) AS n FROM kv WHERE k LIKE ?", `dailyrun:${oldDay}:%`), 0, 'the sweep ran and removed the old record');
  assert.equal(count(e, "SELECT COUNT(*) AS n FROM kv WHERE k = ?", `dailyrun:${D}:${GAME_ID}:${p}`), 1, "today's record survived the sweep");
  c.t += playTime(b) + 2000;
  assert.deepEqual(sc(await post(c.W, e, dailyBody(b, d2, p), { ip: ip() })), [409, 'daily_done']);
});

test(`LOW-1 (m8): expiry deletes only runs still waiting; a run released ${LIMITS.heldMaxAgeDays}+ days ago stays in flagged`, async () => {
  victimCopies();
  const t0 = D_MS + 16 * H, c = clocked(t0), e = await env({ secret: null, admin: true });
  await post(c.W, e, freeBody(VICTIM, 2, 'victim-m8-00001'), { ip: ip() });
  const kept = await post(c.W, e, copyBody(0, pid()), { ip: ip() });
  const gone = await post(c.W, e, copyBody(1, pid()), { ip: ip() });
  assert.deepEqual([kept.status, gone.status], [202, 202]);
  const r = await c.W.fetch(new Request('https://lb.test/admin/release', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1' }, body: JSON.stringify({ id: kept.body.heldId }) }), e);
  assert.equal(r.status, 201);
  c.t = t0 + (LIMITS.heldMaxAgeDays + 1) * DAY; // both rows are now older than the expiry age
  await get(c.W, e, `/daily?game=${GAME_ID}`); // a new rate window: this request sweeps
  const left = e.DB.raw.prepare('SELECT id, status FROM flagged ORDER BY id').all().map((x) => [x.id, x.status]);
  assert.deepEqual(left, [[kept.body.heldId, 'released']], 'the waiting one expired, the released one is kept as the record');
});

// ---------- a Daily claim is not handed back once the run was written ----------
test('LOW-2: the store commits but its answer is lost (place throws after the write): the claim stays, a second Daily is daily_done; a write that rolled back gives it back', async () => {
  const t = D_MS + 10 * H;
  // lost answer: the batch commits, then throws
  {
    const c = clocked(t), e = await env();
    let lose = true;
    const flaky = { ...e, DB: { ...e.DB, batch: async (s) => { const out = await e.DB.batch(s); if (lose) { lose = false; throw new Error('network: answer lost'); } return out; } } };
    const p = pid(), d = await ticket(c, flaky, p), a = playScripted(d.seed, 7, 'script', 'daily'), b = playScripted(d.seed, 11, 'script', 'daily');
    c.t = t + Math.max(playTime(a), playTime(b)) + 2000;
    const r1 = await post(c.W, flaky, dailyBody(a, d, p), { ip: ip() });
    assert.equal(r1.status, 500, JSON.stringify(r1.body));
    assert.deepEqual((await get(c.W, e, `/board?game=starfall&board=daily&key=${D}`)).body.rows.map((x) => x.score), [a.score], 'the run is on the board');
    assert.equal(count(e, 'SELECT COUNT(*) AS n FROM kv WHERE k = ?', `dailyrun:${D}:${GAME_ID}:${p}`), 1, 'the claim stayed');
    const d2 = await ticket(c, e, p);
    c.t += playTime(b) + 2000;
    assert.deepEqual(sc(await post(c.W, e, dailyBody(b, d2, p), { ip: ip() })), [409, 'daily_done'], 'no second ranked Daily');
  }
  // the write failed and rolled back: nothing stored, so the player keeps their Daily
  {
    const c = clocked(t), e = await env();
    let fail = true;
    const flaky = { ...e, DB: { ...e.DB, batch: async (s) => { if (fail) { fail = false; throw new Error('write refused'); } return e.DB.batch(s); } } };
    const p = pid(), d = await ticket(c, flaky, p), a = playScripted(d.seed, 7, 'script', 'daily');
    c.t = t + playTime(a) + 2000;
    assert.equal((await post(c.W, flaky, dailyBody(a, d, p), { ip: ip() })).status, 500);
    assert.equal(count(e, 'SELECT COUNT(*) AS n FROM kv WHERE k = ?', `dailyrun:${D}:${GAME_ID}:${p}`), 0, 'claim given back');
    assert.deepEqual(sc(await post(c.W, e, dailyBody(a, d, p), { ip: ip() })), [201, 'ok'], 'the same run then gets in');
  }
});
