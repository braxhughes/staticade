// server/schema.sql must run on Cloudflare D1, which refuses a compound SELECT of more than
// 5 terms ("too many terms in compound SELECT"; node:sqlite allows 500, so the older tests never saw it).
// 1. The local D1 stand-in (server/sqlite-d1.js) enforces D1's lower limits, and the real schema loads in it.
// 2. A static scan of server/schema.sql and every SQL string literal in server/*.js finds no compound SELECT over
//    5 terms, so a long chain fails here even on a code path no other test runs.
// 3. The rewritten rank-count triggers and backfill give exactly the board_size rows the earlier schema gave
//    (a frozen copy of the earlier schema), on the same seeded sequence of rating inserts,
//    avg5 changes and deletes, and match a fresh count from ratings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqliteD1, D1_LIMITS } from '../server/sqlite-d1.js';
import { ratingOf } from '../server/boards.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = fs.readFileSync(path.join(ROOT, 'server/schema.sql'), 'utf8');
const OLD_SCHEMA = fs.readFileSync(path.join(ROOT, 'tests/w37-schema-m1.sql'), 'utf8');
const D1_COMPOUND_MAX = 5;

// ---------- 1. the stand-in enforces D1's limits ----------

test('w37: the D1 stand-in enforces D1 limits (compound SELECT 5 terms, 100 bound parameters, ...)', () => {
  const d = sqliteD1();
  const L = d.raw.limits;
  assert.equal(L.compoundSelect, 5);
  assert.equal(L.variableNumber, 100);
  assert.equal(L.sqlLength, 100000);
  assert.equal(L.column, 100);
  assert.equal(L.functionArg, 32);
  assert.equal(L.likePatternLength, 50);
  assert.equal(L.length, 2000000);
  assert.deepEqual({ ...D1_LIMITS }, { compoundSelect: 5, sqlLength: 100000, variableNumber: 100, column: 100, length: 2000000, functionArg: 32, likePatternLength: 50 });
  const chain = (n) => Array.from({ length: n }, (_, i) => `SELECT ${i}`).join(' UNION ALL ');
  assert.doesNotThrow(() => d.raw.prepare(chain(5)).all());
  assert.throws(() => d.raw.prepare(chain(6)).all(), /too many terms in compound SELECT/);
  const params = (n) => `SELECT ${Array.from({ length: n }, () => '?').join(' + ')} AS s`;
  assert.doesNotThrow(() => d.raw.prepare(params(100)));
  assert.throws(() => d.raw.prepare(params(101)), /too many SQL variables/);
  d.close();
});

test('w37: server/schema.sql loads in the D1 stand-in, twice (idempotent)', async () => {
  const d = sqliteD1();
  await d.exec(SCHEMA);
  await d.exec(SCHEMA);
  d.close();
});

// ---------- 2. static scan for compound SELECT chains ----------

// Longest compound chain (terms) in an SQL text: UNION / UNION ALL / INTERSECT / EXCEPT counted per parenthesis
// depth, reset at ';' and when a parenthesis closes. Quoted SQL strings and -- comments are skipped.
export function maxCompoundTerms(sql) {
  let max = 1;
  const stack = [0];
  const close = () => { max = Math.max(max, stack[stack.length - 1] + 1); };
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') { while (i < sql.length && sql[i] !== '\n') i++; continue; }
    if (c === "'" || c === '"') { const q = c; i++; while (i < sql.length && sql[i] !== q) i++; continue; }
    if (c === '(') { stack.push(0); continue; }
    if (c === ')') { close(); if (stack.length > 1) stack.pop(); continue; }
    if (c === ';') { close(); stack.length = 0; stack.push(0); continue; }
    if (/[A-Za-z_]/.test(c) && (i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]))) {
      const m = /^(UNION|INTERSECT|EXCEPT)(?![A-Za-z0-9_])/i.exec(sql.slice(i, i + 10));
      if (m) { stack[stack.length - 1]++; i += m[0].length - 1; }
    }
  }
  close();
  return max;
}

// SQL string literals of a JS file, with literals joined by '+' merged into one text (a statement split over lines).
// ${...} in a template literal reads as '?'.
function sqlLiterals(src) {
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  const re = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  const out = [];
  let m, cur = null, lastEnd = -1;
  while ((m = re.exec(noComments))) {
    const body = m[0].slice(1, -1).replace(/\$\{[^}]*\}/g, '?');
    const between = lastEnd < 0 ? null : noComments.slice(lastEnd, m.index);
    if (cur !== null && between !== null && /^\s*\+\s*$/.test(between)) cur += body;
    else { if (cur !== null) out.push(cur); cur = body; }
    lastEnd = m.index + m[0].length;
  }
  if (cur !== null) out.push(cur);
  return out.filter((s) => /\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(s));
}

test('w37: the compound-chain counter itself (a 6-term chain, nested chains, separate statements)', () => {
  const chain = (n) => Array.from({ length: n }, (_, i) => `SELECT ${i}`).join(' UNION ALL ');
  assert.equal(maxCompoundTerms(chain(5)), 5);
  assert.equal(maxCompoundTerms(chain(6)), 6);
  assert.equal(maxCompoundTerms(`SELECT * FROM (${chain(6)}) AS k`), 6);
  assert.equal(maxCompoundTerms(`SELECT * FROM (${chain(4)}) AS a, (${chain(3)}) AS b`), 4);
  assert.equal(maxCompoundTerms(`${chain(3)}; ${chain(3)};`), 3);
  assert.equal(maxCompoundTerms(`SELECT 'UNION UNION UNION UNION UNION' -- UNION UNION UNION UNION UNION\n`), 1);
  assert.equal(maxCompoundTerms(OLD_SCHEMA), 7, 'the pre-w37 schema has a 7-term chain');
  const lits = sqlLiterals("const a = 'SELECT 1 UNION ALL SELECT 2 ' +\n  'UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6';");
  assert.equal(lits.length, 1);
  assert.equal(maxCompoundTerms(lits[0]), 6);
});

test(`w37: no compound SELECT over ${D1_COMPOUND_MAX} terms in server/schema.sql or any SQL literal in server/*.js`, () => {
  const bad = [];
  const t = maxCompoundTerms(SCHEMA);
  if (t > D1_COMPOUND_MAX) bad.push(`server/schema.sql: ${t} terms`);
  const dir = path.join(ROOT, 'server');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
  assert.ok(files.includes('boards.js') && files.includes('d1-adapter.js'));
  let scanned = 0;
  for (const f of files) {
    for (const s of sqlLiterals(fs.readFileSync(path.join(dir, f), 'utf8'))) {
      scanned++;
      const n = maxCompoundTerms(s);
      if (n > D1_COMPOUND_MAX) bad.push(`server/${f}: ${n} terms in: ${s.slice(0, 120)}`);
    }
  }
  assert.ok(scanned >= 30, `scanned ${scanned} SQL literals`);
  assert.deepEqual(bad, []);
});

// ---------- 3. equivalence with the earlier schema ----------

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }

// The two databases: ours (the real schema in the real stand-in) and the old one (same stand-in, compound limit
// raised so the 7-term schema can load).
async function pair() {
  const ours = sqliteD1();
  await ours.exec(SCHEMA);
  const old = sqliteD1();
  old.raw.limits.compoundSelect = 500;
  await old.exec(OLD_SCHEMA);
  return { ours, old };
}
const rankRows = (d) => d.raw.prepare("SELECT game, ver, board, n FROM board_size WHERE board LIKE 'rank:%' ORDER BY game, ver, board").all().map((r) => ({ ...r }));

// A fresh count from ratings in JS (only the rows with n > 0 can be compared: the triggers keep a row at 0).
function recount(d) {
  const m = new Map();
  const add = (k) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const r of d.raw.prepare('SELECT game, ver, season, avg5 FROM ratings').all()) {
    const key = (lvl, pre) => `${r.game}|${r.ver}|rank:${r.season}:${lvl}:${String(pre).padStart(16, '0')}`;
    add(key(9, 0));
    if (r.avg5 > 0) { add(key(8, 0)); for (let k = 0; k < 5; k++) add(key(k, Math.floor(r.avg5 / 2 ** (6 * k)))); }
  }
  return m;
}
function assertMatchesRecount(d, label) {
  const want = recount(d);
  const got = new Map(rankRows(d).filter((r) => r.n !== 0).map((r) => [`${r.game}|${r.ver}|${r.board}`, r.n]));
  assert.deepEqual([...got].sort(), [...want].sort(), label);
}

// avg5 values at and around every level edge (64^k), zeros, and large values that reach level 4.
const EDGES = [0, 0, 0, 1, 2, 63, 64, 65, 4095, 4096, 4097, 262143, 262144, 262145, 16777215, 16777216, 16777217, 100000000, 1073741823];
function pickAvg(r) { return r() < 0.6 ? EDGES[Math.floor(r() * EDGES.length)] : Math.floor(r() * 2 ** (6 * Math.floor(r() * 5 + 1))); }

const OPS = 1500;
async function runSequence(dbs, seed) {
  const r = rng(seed);
  const games = ['starfall', 'other'], vers = ['2', '3'], seasons = [1, 2, 3];
  const live = [];
  const ins = 'INSERT INTO ratings (game, ver, season, pid, avg5, carry) VALUES (?, ?, ?, ?, ?, 0)';
  const upd = 'UPDATE ratings SET avg5 = ? WHERE game = ? AND ver = ? AND season = ? AND pid = ?';
  const del = 'DELETE FROM ratings WHERE game = ? AND ver = ? AND season = ? AND pid = ?';
  let pidN = 0;
  for (let i = 0; i < OPS; i++) {
    const x = r();
    if (live.length === 0 || x < 0.45) {
      const row = [games[Math.floor(r() * 2)], vers[Math.floor(r() * 2)], seasons[Math.floor(r() * 3)], `p${seed}-${++pidN}`];
      const a = pickAvg(r);
      for (const d of dbs) await d.prepare(ins).bind(...row, a).run();
      live.push(row);
    } else if (x < 0.85) {
      const row = live[Math.floor(r() * live.length)];
      const a = r() < 0.1 ? null : pickAvg(r); // null: set to the same value (the trigger's WHEN skips it)
      for (const d of dbs) {
        const v = a ?? d.raw.prepare('SELECT avg5 FROM ratings WHERE game = ? AND ver = ? AND season = ? AND pid = ?').get(...row).avg5;
        await d.prepare(upd).bind(v, ...row).run();
      }
    } else {
      const j = Math.floor(r() * live.length);
      for (const d of dbs) await d.prepare(del).bind(...live[j]).run();
      live.splice(j, 1);
    }
  }
  return live;
}

test('w37: rank counts after inserts, avg5 changes (to and from 0) and deletes across seasons equal the pre-w37 schema', async () => {
  for (const seed of [1, 37, 2026]) {
    const { ours, old } = await pair();
    await runSequence([ours, old], seed);
    const a = rankRows(ours), b = rankRows(old);
    assert.ok(a.length > 500, `seed ${seed}: ${a.length} rank rows`);
    assert.ok(a.some((x) => /^rank:\d+:4:0*[1-9]/.test(x.board)), 'level 4 non-zero prefixes are reached');
    assert.ok(a.some((x) => x.n === 0), 'some counts went back to 0');
    assert.deepEqual(a, b, `seed ${seed}: board_size rank rows differ from the pre-w37 schema`);
    assertMatchesRecount(ours, `seed ${seed}: ours vs recount`);
    // Applying the schema again never counts anyone twice.
    await ours.exec(SCHEMA);
    assert.deepEqual(rankRows(ours), a, `seed ${seed}: second apply changed the counts`);
    ours.close(); old.close();
  }
});

test('w37: the percentile read (ratingOf, as /rank uses it) gives the same answer on both schemas', async () => {
  const { ours, old } = await pair();
  const live = await runSequence([ours, old], 99);
  let checked = 0;
  for (const [game, ver, season, pid] of live.slice(0, 200)) {
    const a = await ratingOf(ours, { game, ver, pid, season });
    const b = await ratingOf(old, { game, ver, pid, season });
    assert.deepEqual(a, b, `${game} ${ver} ${season} ${pid}`);
    checked++;
  }
  assert.ok(checked >= 100);
  ours.close(); old.close();
});

test('w37: the one-time backfill (ratings present, no rank rows) equals the pre-w37 backfill, and runs only once', async () => {
  for (const seed of [5, 77]) {
    const { ours, old } = await pair();
    await runSequence([ours, old], seed);
    for (const d of [ours, old]) d.raw.exec("DELETE FROM board_size WHERE board LIKE 'rank:%'");
    assert.equal(rankRows(ours).length, 0);
    await ours.exec(SCHEMA);
    await old.exec(OLD_SCHEMA);
    const a = rankRows(ours);
    assert.ok(a.length > 300, `seed ${seed}: backfill made ${a.length} rows`);
    assert.deepEqual(a, rankRows(old), `seed ${seed}: backfill differs from the pre-w37 schema`);
    assert.ok(a.every((x) => x.n > 0));
    assertMatchesRecount(ours, `seed ${seed}: backfill vs recount`);
    // All seven levels are present for a rated player with avg5 > 0, and only level 9 for avg5 = 0.
    const lv = new Set(a.map((x) => x.board.split(':')[2]));
    assert.deepEqual([...lv].sort(), ['0', '1', '2', '3', '4', '8', '9']);
    await ours.exec(SCHEMA);
    assert.deepEqual(rankRows(ours), a, `seed ${seed}: second apply counted again`);
    // The triggers keep counting from the backfilled rows exactly as before.
    await runSequence([ours, old], seed + 1000);
    assert.deepEqual(rankRows(ours), rankRows(old), `seed ${seed}: after more changes`);
    assertMatchesRecount(ours, `seed ${seed}: after backfill and more changes`);
    ours.close(); old.close();
  }
});

test('w37: backfill with only zero averages makes just the head count rows', async () => {
  const { ours, old } = await pair();
  for (const d of [ours, old]) {
    for (let i = 0; i < 5; i++) await d.prepare('INSERT INTO ratings (game, ver, season, pid, avg5, carry) VALUES (?, ?, ?, ?, 0, 0)').bind('g', '2', 1 + (i % 2), `z${i}`).run();
    d.raw.exec("DELETE FROM board_size WHERE board LIKE 'rank:%'");
  }
  await ours.exec(SCHEMA); await old.exec(OLD_SCHEMA);
  assert.deepEqual(rankRows(ours), [
    { game: 'g', ver: '2', board: 'rank:1:9:0000000000000000', n: 3 },
    { game: 'g', ver: '2', board: 'rank:2:9:0000000000000000', n: 2 },
  ]);
  assert.deepEqual(rankRows(ours), rankRows(old));
  ours.close(); old.close();
});
