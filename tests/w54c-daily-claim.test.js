// a Daily claim handed back while the same Daily, sent twice at once, is
// still being stored, and a run held between held-run expiry's two deletes got a stale address row, through
// the Worker's real entry point (createWorker().fetch on node:sqlite via server/sqlite-d1.js) with a clock the test
// moves. The races are forced with a test-only wrapper around the db binding (gates and delays live here, never in
// shipped code). Localhost only; nothing here calls a live service. The Daily secret is random per run of this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decode } from '../engine/replay.js';
import { createSim, GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { similarity, signatureRecorder } from '../server/dedupe.js';
import { LIMITS } from '../server/worker.js';
import { expireHeld } from '../server/d1-adapter.js';
import { playScripted, record, makeEnv, post, get, createWorker } from '../server/fixtures.mjs';

const SECRET = randomBytes(32).toString('hex');
const H = 3600000, DAY = 24 * H;
const D = '2026-11-03', T0 = Date.parse(D + 'T10:00:00Z');
const playTime = (run) => Math.ceil(run.frames / 60 * 1000);
let N = 0;
const pid = () => `w54c-player-${String(++N).padStart(4, '0')}`;
const ip = () => `198.51.${(N >> 8) & 255}.${(++N) & 255}`;
const sc = (r) => [r.status, r.body.error ?? r.body.code ?? 'ok'];
const tally = (rs) => { const m = {}; for (const r of rs) { const k = sc(r).join(' '); m[k] = (m[k] || 0) + 1; } return m; };
const count = (e, sql, ...a) => e.DB.raw.prepare(sql).get(...a).n;
const claimRows = (e) => count(e, 'SELECT COUNT(*) AS n FROM kv WHERE k LIKE ?', `dailyrun:${D}:%`);
const seenRows = (e) => count(e, 'SELECT COUNT(*) AS n FROM seen');

// A gate that also opens by itself after 10 s, so a mutant that never reaches a gate fails its asserts, not hangs.
function gate() {
  let open; const p = new Promise((r) => { open = r; });
  const t = setTimeout(() => open('timeout'), 10000); t.unref?.();
  return { open: (v = 'open') => { clearTimeout(t); open(v); }, wait: () => p };
}
// The real db binding, with hooks on statement runs and on batches. Bound statements keep the shim's own methods
// (Object.create), so a hooked statement still works inside db.batch.
function hooked(db, { onRun = (sql, v, go) => go(), onBatch = (stmts, go) => go() } = {}) {
  const wrap = (s, sql, values) => { const w = Object.create(s); w.run = () => onRun(sql, values, () => s.run()); return w; };
  return {
    raw: db.raw, exec: (sql) => db.exec(sql), close: () => db.close(),
    prepare(sql) {
      const s = db.prepare(sql), w = wrap(s, sql, []);
      w.bind = (...v) => wrap(s.bind(...v), sql, v);
      return w;
    },
    batch: (stmts) => onBatch(stmts, () => db.batch(stmts)),
  };
}

function clocked(t) { const c = { t }; c.W = createWorker({ now: () => c.t }); return c; }
async function dailyEnv() { const e = await makeEnv(); e.DAILY_SECRET = SECRET; return e; }
async function ticket(c, e, player, addr) {
  const r = await c.W.fetch(new Request(`https://lb.test/daily?game=${GAME_ID}`, { headers: { 'x-player-id': player, 'cf-connecting-ip': addr } }), e);
  const b = await r.json(); assert.equal(r.status, 200, JSON.stringify(b)); return b;
}
const dailyBody = (run, d, player) => ({ game: GAME_ID, playerId: player, name: 'ACE', score: run.score, replay: run.replay, seed: d.seed, mode: 'daily', dayKey: d.dayKey, version: GAME_VERSION, ticket: d.ticket });
const freeBody = (run, seed, player, over) => ({ game: GAME_ID, playerId: player, name: 'ACE', score: run.score, replay: run.replay, seed, mode: 'free', version: GAME_VERSION, ...over });
const dailyBoard = async (c, e) => (await get(c.W, e, `/board?game=${GAME_ID}&board=daily&key=${D}`)).body.rows;

// One player, one ticket, two different Daily runs (a is sent, b is the second try with a new ticket).
async function dailySetup() {
  const c = clocked(T0), e = await dailyEnv(), p = pid(), addr = ip();
  const tk = await ticket(c, e, p, addr);
  const a = playScripted(tk.seed, 7, 'script', 'daily'), b = playScripted(tk.seed, 11, 'script', 'daily');
  assert.ok(a.score > 0 && b.score > 0 && a.replay !== b.replay);
  c.t = T0 + playTime(a) + 2000;
  return { c, e, p, addr, tk, a, b };
}
// After the race: a new ticket and a second, different run from the same player must be daily_done.
async function secondDaily({ c, e, p, addr, b }) {
  const tk2 = await ticket(c, e, p, addr);
  c.t += playTime(b) + 2000;
  return post(c.W, e, dailyBody(b, tk2, p), { ip: addr });
}

// The MED-A window, forced. Each request gets its own hooked binding on the same database, so the test knows which
// request wrote the Daily claim (fresh) and which found it already there (the resends). The fresh request's result
// claim waits until a resend has taken the result claim; every resend's store batch waits until the fresh request
// has answered. So the fresh request is refused duplicate_result and does its whole catch path while the winning
// resend's run is not committed yet: exactly the order a probe hit with 30 ms and 120 ms delays.
async function forcedRace(k) {
  const s = await dailySetup();
  const resendClaimed = gate(), freshAnswered = gate();
  const roles = [];
  const envs = Array.from({ length: k }, (_, i) => {
    roles[i] = { fresh: null };
    return { ...s.e, DB: hooked(s.e.DB, {
      async onRun(sql, v, go) {
        if (/^INSERT OR IGNORE INTO kv/.test(sql) && String(v[0]).startsWith('dailyrun:')) {
          const r = await go(); if (roles[i].fresh === null) roles[i].fresh = r.meta.changes === 1; return r;
        }
        if (/^INSERT INTO results/.test(sql)) {
          if (roles[i].fresh) { await resendClaimed.wait(); return go(); }
          const r = await go(); resendClaimed.open(); return r;
        }
        return go();
      },
      async onBatch(stmts, go) {
        if (roles[i].fresh === false && stmts.some((x) => /^INSERT INTO seen/.test(x.sql))) await freshAnswered.wait();
        return go();
      },
    }) };
  });
  const rs = await Promise.all(envs.map((en, i) => post(s.c.W, en, dailyBody(s.a, s.tk, s.p), { ip: s.addr })
    .then((r) => { if (roles[i].fresh) freshAnswered.open(); return r; })));
  return { ...s, rs, roles };
}

// ---------- MED-A: the same Daily sent at once never hands the claim back while the run is being stored ----------
test('MED-A: the same Daily sent twice at once, the resend winning the result claim: one 201, the fresh one duplicate_result, the claim row stays, a second Daily is daily_done', async () => {
  const s = await forcedRace(2);
  assert.deepEqual(s.roles.map((r) => r.fresh).sort(), [false, true], 'one request wrote the claim, one found it');
  const fresh = s.rs[s.roles.findIndex((r) => r.fresh)], resend = s.rs[s.roles.findIndex((r) => !r.fresh)];
  assert.deepEqual(sc(fresh), [409, 'duplicate_result'], 'the window was hit: the fresh request lost the result claim');
  assert.deepEqual(sc(resend), [201, 'ok']);
  const claims = claimRows(s.e), runs = seenRows(s.e);
  const second = await secondDaily(s);
  console.log(`# w54c race k=2: ${sc(fresh).join(' ')} / ${sc(resend).join(' ')} | claim rows ${claims} | stored runs ${runs} | second Daily ${sc(second).join(' ')}`);
  assert.equal(claims, 1, 'the Daily claim row is still there after the race');
  assert.equal(runs, 1, 'one run stored');
  assert.deepEqual(sc(second), [409, 'daily_done'], 'no second ranked Daily');
  assert.deepEqual((await dailyBoard(s.c, s.e)).map((r) => r.score), [s.a.score], 'only the first run is on the Daily board');
});

for (const k of [3, 5]) {
  test(`MED-A: the same Daily sent ${k} times at once, the window forced: exactly one 201, the rest duplicate_result, one claim row, a second Daily is daily_done`, async () => {
    const s = await forcedRace(k);
    assert.equal(s.roles.filter((r) => r.fresh).length, 1);
    assert.deepEqual(tally(s.rs), { '201 ok': 1, '409 duplicate_result': k - 1 }, JSON.stringify(s.rs.map((r) => r.body)));
    assert.equal(claimRows(s.e), 1);
    assert.equal(seenRows(s.e), 1);
    assert.deepEqual(sc(await secondDaily(s)), [409, 'daily_done']);
  });
}

test('MED-A: the same Daily sent 5 times at once with no gates (the fresh one may win): one 201, one claim row, a second Daily is daily_done', async () => {
  const s = await dailySetup();
  const rs = await Promise.all([1, 2, 3, 4, 5].map(() => post(s.c.W, s.e, dailyBody(s.a, s.tk, s.p), { ip: s.addr })));
  const t = tally(rs);
  assert.equal(t['201 ok'], 1, JSON.stringify(t));
  assert.ok(Object.keys(t).every((x) => ['201 ok', '409 duplicate_result', '409 duplicate_replay'].includes(x)), JSON.stringify(t));
  assert.equal(claimRows(s.e), 1);
  assert.equal(seenRows(s.e), 1);
  assert.deepEqual(sc(await secondDaily(s)), [409, 'daily_done']);
});

test('MED-A: the same Daily twice at once with plain delays on the other side (fresh request\'s store slow): one 201, claim kept, second Daily daily_done', async () => {
  const s = await dailySetup();
  let first = true;
  const slow = { ...s.e, DB: hooked(s.e.DB, { async onBatch(stmts, go) {
    if (first && stmts.some((x) => /^INSERT INTO seen/.test(x.sql))) { first = false; await new Promise((r) => setTimeout(r, 120)); }
    return go();
  } }) };
  const rs = await Promise.all([post(s.c.W, slow, dailyBody(s.a, s.tk, s.p), { ip: s.addr }), post(s.c.W, slow, dailyBody(s.a, s.tk, s.p), { ip: s.addr })]);
  assert.deepEqual(tally(rs), { '201 ok': 1, '409 duplicate_result': 1 }, JSON.stringify(rs.map((r) => r.body)));
  assert.equal(claimRows(s.e), 1);
  assert.deepEqual(sc(await secondDaily(s)), [409, 'daily_done']);
});

test('the rule for other failures is kept: a store error after the claim hands the claim back, and the same Daily sent again is stored', async () => {
  const s = await dailySetup();
  let fail = true;
  const broken = { ...s.e, DB: hooked(s.e.DB, { async onBatch(stmts, go) {
    if (fail && stmts.some((x) => /^INSERT INTO seen/.test(x.sql))) { fail = false; throw new Error('injected store failure (test only)'); }
    return go();
  } }) };
  const r1 = await post(s.c.W, broken, dailyBody(s.a, s.tk, s.p), { ip: s.addr });
  assert.ok(r1.status >= 500, `a failed write is a server error: ${r1.status} ${JSON.stringify(r1.body)}`);
  assert.equal(claimRows(s.e), 0, 'the claim was handed back (the run is neither stored nor held)');
  assert.equal(seenRows(s.e), 0);
  assert.deepEqual(sc(await post(s.c.W, s.e, dailyBody(s.a, s.tk, s.p), { ip: s.addr })), [201, 'ok'], 'the honest player retries and is stored');
  assert.equal(claimRows(s.e), 1);
  assert.deepEqual(sc(await secondDaily(s)), [409, 'daily_done']);
});

// ---------- held Dailies ----------
function resim(replay) {
  const h = decode(replay), sim = createSim({ seed: h.seed, mode: h.mode }), rec = signatureRecorder();
  for (let i = 0; i < h.words.length && !sim.done; i++) { const b = sim.score; sim.step(h.words[i]); sim.clearEvents(); rec.add(sim.frame, b, sim.score); }
  return { score: sim.score, hash: sim.stateHash(), sig: rec.sig };
}
// near copies of `base` on seed `seed` in `mode`: base's opening, then a scripted player of their own
function nearCopies(base, seed, mode, n) {
  const b = resim(base.replay), words = decode(base.replay).words, seen = new Set([b.hash]), out = [];
  for (const frac of [0.9, 0.8]) {
    for (let k = 101; k < 160 && out.length < n; k++) {
      const r = playScripted(seed, k, 'script', mode, words.slice(0, Math.floor(words.length * frac)));
      const x = resim(r.replay);
      if (r.score > 0 && !seen.has(x.hash) && similarity(x.sig, b.sig) >= 0.75) { seen.add(x.hash); out.push(r); }
    }
  }
  assert.equal(out.length, n, `near copies found: ${out.length}`);
  return out;
}

test('held Daily: a held (202) Daily, then its resend (202, same id), then a different run: the claim stays and the different run is daily_done', async () => {
  const s = await dailySetup();
  assert.deepEqual(sc(await post(s.c.W, s.e, dailyBody(s.a, s.tk, s.p), { ip: s.addr })), [201, 'ok']);
  const q = pid(), qa = ip(), tq = await ticket(s.c, s.e, q, qa);
  const [copy] = nearCopies(s.a, s.tk.seed, 'daily', 1);
  s.c.t += playTime(copy) + 2000;
  const h1 = await post(s.c.W, s.e, dailyBody(copy, tq, q), { ip: qa });
  assert.deepEqual(sc(h1), [202, 'held_for_review']);
  const h2 = await post(s.c.W, s.e, dailyBody(copy, tq, q), { ip: qa });
  assert.deepEqual([...sc(h2), h2.body.heldId], [202, 'held_for_review', h1.body.heldId]);
  assert.equal(count(s.e, 'SELECT COUNT(*) AS n FROM kv WHERE k = ?', `dailyrun:${D}:${GAME_ID}:${q}`), 1, 'the held player\'s claim row stays');
  const tq2 = await ticket(s.c, s.e, q, qa), other = playScripted(s.tk.seed, 23, 'script', 'daily');
  s.c.t += playTime(other) + 2000;
  assert.deepEqual(sc(await post(s.c.W, s.e, dailyBody(other, tq2, q), { ip: qa })), [409, 'daily_done']);
});

// ---------- LOW-A: held-run expiry is one batch; a run held right after it gets its own address row ----------
let VICTIM = null, COPIES = null;
function victimCopies() { if (!VICTIM) { VICTIM = record('arcade', 2); COPIES = nearCopies(VICTIM, 2, 'arcade', 2); } }

test('LOW-A: a run held right after held-run expiry starts (reusing the expired run\'s id) gets its own address row; address rows match waiting runs one to one', async () => {
  victimCopies();
  const c = clocked(T0), e = await makeEnv();
  assert.deepEqual(sc(await post(c.W, e, freeBody(VICTIM, 2, pid()), { ip: ip() })), [201, 'ok']);
  const A = '203.0.113.61', B = '203.0.113.62';
  const ha = await post(c.W, e, freeBody(COPIES[0], 2, pid(), { name: 'THF' }), { ip: A });
  assert.deepEqual(sc(ha), [202, 'held_for_review']);
  c.t = T0 + (LIMITS.heldMaxAgeDays + 1) * DAY; // A's run is now past the expiry age, and this is a new rate window
  // X starts the sweep. Right after expiry's flagged delete (between the two deletes when they are separate
  // statements, after both when they are one batch), X waits while B's run is held; then X goes on.
  const deleted = gate(), bHeld = gate();
  const isExpiry = (sql) => /^DELETE FROM flagged WHERE status = 'flagged' AND t < \?/.test(sql);
  const ex = { ...e, DB: hooked(e.DB, {
    async onRun(sql, v, go) { const r = await go(); if (isExpiry(sql)) { deleted.open(); await bHeld.wait(); } return r; },
    async onBatch(stmts, go) { const r = await go(); if (stmts.some((x) => isExpiry(x.sql))) { deleted.open(); await bHeld.wait(); } return r; },
  }) };
  const px = post(c.W, ex, 'not json', { ip: '203.0.113.63' });
  assert.equal(await deleted.wait(), 'open', 'expiry ran');
  const hb = await post(c.W, e, freeBody(COPIES[1], 2, pid(), { name: 'THF' }), { ip: B });
  bHeld.open();
  assert.deepEqual(sc(await px), [400, 'bad_json']);
  assert.deepEqual(sc(hb), [202, 'held_for_review']);
  const kv = e.DB.raw.prepare("SELECT k, v FROM kv WHERE k LIKE 'heldip:%' ORDER BY k").all().map((r) => r.k);
  const waitingIds = e.DB.raw.prepare("SELECT id FROM flagged WHERE status = 'flagged' ORDER BY id").all().map((r) => r.id);
  console.log(`# w54c expiry: A held id ${ha.body.heldId}, B held id ${hb.body.heldId}, waiting ${JSON.stringify(waitingIds)}, address rows ${JSON.stringify(kv)}`);
  assert.equal(hb.body.heldId, ha.body.heldId, 'precondition: B reused the expired run\'s id (the LOW-A window)');
  assert.deepEqual(waitingIds, [hb.body.heldId]);
  assert.deepEqual(kv, [`heldip:${B}:${hb.body.heldId}`], 'B\'s run has its own address row, and no stale row of A is left');
});

test('LOW-A: expireHeld sends both deletes in one db.batch (one transaction), and nothing as a separate statement', async () => {
  const e = await makeEnv(), calls = [];
  const db = hooked(e.DB, {
    onRun(sql, v, go) { calls.push(['run', sql.slice(0, 22)]); return go(); },
    onBatch(stmts, go) { calls.push(['batch', ...stmts.map((x) => x.sql.slice(0, 22))]); return go(); },
  });
  e.DB.raw.prepare("INSERT INTO flagged (game, board, hash, score, t, status, pid, name, near_entry, near_score, similarity, sig, run) VALUES ('g', 'free', 'h', 5, 1, 'flagged', 'p', 'ABC', NULL, 1, 0.99, '[]', '{}')").run();
  const id = e.DB.raw.prepare('SELECT id FROM flagged').get().id;
  e.DB.raw.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run(`heldip:A:${id}`, String(id));
  assert.equal(await expireHeld(db, { before: 2 }), 1, 'one held run expired');
  assert.deepEqual(calls, [['batch', 'DELETE FROM flagged WH', 'DELETE FROM kv WHERE k']]);
  assert.equal(count(e, 'SELECT COUNT(*) AS n FROM flagged'), 0);
  assert.equal(count(e, "SELECT COUNT(*) AS n FROM kv WHERE k LIKE 'heldip:%'"), 0, 'its address row went in the same batch');
});

test('LOW-A: expireHeld writes nothing when nothing is due (no batch, no delete), and still cleans an orphaned address row alone', async () => {
  const e = await makeEnv(), calls = [];
  const db = hooked(e.DB, {
    onRun(sql, v, go) { calls.push(['run', sql.slice(0, 22)]); return go(); },
    onBatch(stmts, go) { calls.push(['batch', stmts.length]); return go(); },
  });
  e.DB.raw.prepare("INSERT INTO flagged (game, board, hash, score, t, status, pid, name, near_entry, near_score, similarity, sig, run) VALUES ('g', 'free', 'h', 5, 100, 'flagged', 'p', 'ABC', NULL, 1, 0.99, '[]', '{}')").run();
  const id = e.DB.raw.prepare('SELECT id FROM flagged').get().id;
  e.DB.raw.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run(`heldip:A:${id}`, String(id));
  assert.equal(await expireHeld(db, { before: 50 }), 0, 'the waiting run is younger than the age');
  assert.deepEqual(calls, [], 'nothing due: no write at all');
  e.DB.raw.prepare("UPDATE flagged SET status = 'released'").run(); // released: its address row is now an orphan
  assert.equal(await expireHeld(db, { before: 50 }), 0);
  assert.deepEqual(calls, [['batch', 2]]);
  assert.equal(count(e, "SELECT COUNT(*) AS n FROM kv WHERE k LIKE 'heldip:%'"), 0, 'the orphaned address row went');
  assert.equal(count(e, 'SELECT COUNT(*) AS n FROM flagged'), 1, 'the released run stays as the record');
});
