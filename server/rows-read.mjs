// Counts the database rows one submit and one /rank read touch, for seasons of N players.
// Local only (Node and the sqlite3 command line tool); the Worker never imports this.
//   node server/rows-read.mjs [--root <repo dir>] [--json] N1 N2 ...      (default 1000 13000 100000)
// How: it builds a season of N rated players straight in SQL (one run each, the all-time and season boards full),
// runs one submit (a new player in the middle of the field, below the board cap), one /rank read (a player in the
// middle) and one submit that just gets onto the full boards (the dearest kind) through the real server/boards.js, and records every statement they send. It then replays those statements
// in the sqlite3 tool with `.scanstats on`, which prints, for every table or index walk, how many rows it visited, and
// adds them up. D1 bills "rows read" the same way (rows scanned, index entries included), so this is close to the
// bill. Not counted: reads made by triggers (they are single-row lookups by primary key).
// --root points at another checkout (for example an old commit unpacked with git archive) to measure "before".
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
let root = fileURLToPath(new URL('..', import.meta.url));
let asJson = false;
const sizes = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root') root = path.resolve(args[++i]);
  else if (args[i] === '--json') asJson = true;
  else sizes.push(Number(args[i]));
}
if (!sizes.length) sizes.push(1000, 13000, 100000);

const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const { sqliteD1 } = await imp('server/sqlite-d1.js');
const boards = await imp('server/boards.js');
const { GAME_ID, GAME_VERSION } = await imp('games/starfall/sim.js');
const { seasonFor } = await imp('leaderboard/ranking.js');
const SCHEMA = fs.readFileSync(path.join(root, 'server/schema.sql'), 'utf8');
const VER = boards.majorOf(GAME_VERSION);

// Wraps a D1 binding so every statement it runs is logged as { sql, values }, in order.
function recording(db, log) {
  const wrap = (inner, sql, values = []) => ({
    sql, inner,
    bind: (...v) => wrap(inner.bind(...v), sql, v),
    run: () => { log.push({ sql, values }); return inner.run(); },
    all: () => { log.push({ sql, values }); return inner.all(); },
    first: (c) => { log.push({ sql, values }); return inner.first(c); },
    values,
  });
  return { ...db, prepare: (sql) => wrap(db.prepare(sql), sql), batch: (stmts) => { for (const s of stmts) log.push({ sql: s.sql, values: s.values }); return db.batch(stmts.map((s) => s.inner)); } };
}

const lit = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' || typeof v === 'bigint' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
function inline({ sql, values }) {
  let i = 0;
  return sql.replace(/\?/g, () => lit(values[i++]));
}

// Sum of rows visited per phase, from sqlite3 .scanstats output. Phases are split by SELECT 'MARK <name>'.
function scan(dbFile, phases) {
  let script = '.scanstats on\n';
  for (const [name, log] of phases) {
    script += `SELECT 'MARK ${name}';\n`;
    for (const s of log) script += `${inline(s)};\n`;
  }
  script += "SELECT 'MARK end';\n";
  const out = execFileSync('sqlite3', [dbFile], { input: script, encoding: 'utf8', maxBuffer: 1 << 28 });
  const totals = {};
  let cur = null;
  for (const line of out.split('\n')) {
    const m = /^MARK (\S+)$/.exec(line.trim());
    if (m) { cur = m[1]; totals[cur] = 0; continue; }
    if (!cur || !/(SEARCH|SCAN) /.test(line) || /SCAN CONSTANT ROW/.test(line)) continue;
    const n = /\s([\d.]+[KMG]?)\s+([\d.]+)([KMG]?)\s*$/.exec(line); // big counts print as 13.0K
    if (n) totals[cur] += Math.round(Number(n[2]) * ({ '': 1, K: 1e3, M: 1e6, G: 1e9 })[n[3]]);
  }
  delete totals.end;
  return totals;
}

export async function measure(n, { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rows-read-')) } = {}) {
  const T = Date.UTC(2026, 10, 10, 12);
  const season = seasonFor(T).id;
  const file = path.join(tmp, `n${n}.db`), copy = path.join(tmp, `n${n}-copy.db`);
  for (const f of [file, copy]) fs.rmSync(f, { force: true });
  let db = sqliteD1(file);
  await db.exec(SCHEMA);
  // N players, one run each this season; scores spread over 5..1,000,000 (avg5 1..200,000).
  await db.exec(`BEGIN;
    WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM c WHERE i < ${n - 1})
    INSERT INTO season_runs (game, ver, season, pid, entry, score, t)
      SELECT '${GAME_ID}', '${VER}', ${season}, printf('p%08d', i), printf('e%08d', i), 5 * (1 + (i * 7919) % 200000), ${T - 1e7} + i FROM c;
    INSERT INTO ratings (game, ver, season, pid, avg5, carry) SELECT game, ver, season, pid, score / 5, 0 FROM season_runs;
    INSERT INTO players (game, ver, pid, name, best, t) SELECT game, ver, pid, 'BOT', score, t FROM season_runs;
    INSERT INTO board (game, ver, board, pid, score, t, entry, name, mode, date)
      SELECT game, ver, 'all', pid, score, t, entry, 'BOT', 'free', '2026-11-10T00:00:00.000Z' FROM season_runs ORDER BY score DESC, t LIMIT ${boards.BOARD_CAP};
    INSERT INTO board (game, ver, board, pid, score, t, entry, name, mode, date)
      SELECT game, ver, 'season:${season}', pid, score, t, entry, 'BOT', 'free', '2026-11-10T00:00:00.000Z' FROM board WHERE board = 'all';
    COMMIT;`);
  db.close();
  fs.copyFileSync(file, copy);
  db = sqliteD1(file);
  const mid = 5 * 100000; // a score in the middle of the field, below every full board's lowest row
  const subLog = [], rankLog = [];
  const run = { game: GAME_ID, pid: 'zz-new-player-1', name: 'NEW', score: mid, replay: 'r1~measure', seed: 2, mode: 'free', version: GAME_VERSION, stats: null };
  const changes = () => db.raw.prepare('SELECT total_changes() AS c').get().c; // rows written, triggers included
  const w0 = changes();
  await boards.storeRun(recording(db, subLog), { run, t: T, season, entry: 'zz-entry-1', rhash: 'zz-hash-1' });
  const written = changes() - w0;
  await boards.readRank(recording(db, rankLog), { game: GAME_ID, ver: VER, pid: 'p00000007', season });
  // The dearest submit: a run that just gets onto the full boards (its placement counts the rows above it).
  const lo = db.raw.prepare("SELECT MIN(score) AS lo FROM board WHERE board = 'all'").get().lo;
  const onLog = [];
  await boards.storeRun(recording(db, onLog), { run: { ...run, pid: 'zz-new-player-2', score: lo + 1, replay: 'r1~measure2' }, t: T + 1, season, entry: 'zz-entry-2', rhash: 'zz-hash-2' });
  db.close();
  const r = scan(copy, [['submit', subLog], ['rank', rankLog], ['onboard', onLog]]);
  for (const f of [file, copy]) fs.rmSync(f, { force: true });
  return { players: n, written, submit: r.submit, rank: r.rank, onboard: r.onboard, statements: { submit: subLog.length, rank: rankLog.length, onboard: onLog.length } };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = [];
  for (const n of sizes) rows.push(await measure(n));
  if (asJson) console.log(JSON.stringify(rows));
  else {
    const f = (x) => x.toLocaleString('en-US');
    console.log('| Players | Rows read per submit (typical: below the full boards) | Per submit that just gets onto the boards | Per /rank | Rows written per typical submit |');
    console.log('|---|---|---|---|---|');
    for (const r of rows) console.log(`| ${f(r.players)} | ${f(r.submit)} | ${f(r.onboard)} | ${f(r.rank)} | ${f(r.written)} |`);
  }
}
