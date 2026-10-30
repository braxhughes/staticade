// the 'rank:' percentile counts in board_size must never drift from ratings.
// A seeded random sequence of submits (values at and around every level edge), better runs that move avg5 across an
// edge, hides that leave a player unrated, hides that leave runs, and a season change. Every 25 operations each
// count row is compared with a fresh GROUP BY recount from ratings (one query per level), and percentile reads are
// compared with a brute-force percentile computed from ratings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { seasonFor, seasonTrophies, percentile, SEASON_MS, TOP_RUNS } from '../leaderboard/ranking.js';
import { storeRun, ratingOf, hideEntry, majorOf, histKey, HIST_LEVELS, HIST_BITS } from '../server/boards.js';
import { makeEnv } from '../server/fixtures.mjs';

const VER = majorOf(GAME_VERSION);
let seq = 0;
async function put(env, p, score, t) {
  const tag = `${p}-${score}-${++seq}`.toLowerCase();
  const run = { game: GAME_ID, pid: p, name: 'CNT', score, replay: `c${tag}`, seed: 2, mode: 'free', version: GAME_VERSION, stats: null };
  await storeRun(env.DB, { run, t, season: seasonFor(t).id, entry: `e-${tag}`, rhash: `h-${tag}` });
}
const all = (env, sql, ...v) => env.DB.raw.prepare(sql).all(...v);

// Stored counts per level, as Map key -> n. Every row is kept (a zero is fine, a negative is a bug).
function stored(env) {
  const m = new Map();
  for (const r of all(env, "SELECT board, n FROM board_size WHERE game = ? AND ver = ? AND board LIKE 'rank:%'", GAME_ID, VER)) m.set(r.board, r.n);
  return m;
}
// Fresh recount from ratings: one GROUP BY per level (0..4), plus the field (8) and the head count (9).
function recount(env) {
  const m = new Map();
  for (let l = 0; l < HIST_LEVELS; l++) {
    for (const r of all(env, `SELECT season, avg5 >> ${HIST_BITS * l} AS pre, COUNT(*) AS c FROM ratings WHERE game = ? AND ver = ? AND avg5 > 0 GROUP BY season, pre`, GAME_ID, VER)) m.set(histKey(r.season, l, r.pre), r.c);
  }
  for (const r of all(env, 'SELECT season, COUNT(*) AS c FROM ratings WHERE game = ? AND ver = ? AND avg5 > 0 GROUP BY season', GAME_ID, VER)) m.set(histKey(r.season, 8, 0), r.c);
  for (const r of all(env, 'SELECT season, COUNT(*) AS c FROM ratings WHERE game = ? AND ver = ? GROUP BY season', GAME_ID, VER)) m.set(histKey(r.season, 9, 0), r.c);
  return m;
}
function assertCounts(env, label) {
  const s = stored(env), f = recount(env);
  for (const [key, n] of s) assert.ok(n >= 0, `${label}: negative count ${key}=${n}`);
  const keys = new Set([...s.keys(), ...f.keys()]);
  for (const key of keys) assert.equal(s.get(key) ?? 0, f.get(key) ?? 0, `${label}: ${key}`);
}
// Brute-force percentile inputs straight from ratings.
async function assertPercentile(env, season, p, label) {
  const me = env.DB.raw.prepare('SELECT avg5, carry FROM ratings WHERE game = ? AND ver = ? AND season = ? AND pid = ?').get(GAME_ID, VER, season, p);
  const r = await ratingOf(env.DB, { game: GAME_ID, ver: VER, pid: p, season });
  if (!me) { assert.equal(r.rated, false, `${label} ${p}`); return; }
  const rows = all(env, 'SELECT pid, avg5 FROM ratings WHERE game = ? AND ver = ? AND season = ?', GAME_ID, VER, season);
  const x = me.avg5, pos = rows.filter((q) => q.avg5 > 0).length;
  const f = { below: x > 0 ? rows.filter((q) => q.avg5 > 0 && q.avg5 < x).length : 0,
    ties: x > 0 ? rows.filter((q) => q.avg5 === x && q.pid !== p).length : 0, others: pos - (x > 0 ? 1 : 0), players: rows.length };
  assert.equal(r.players, f.players, `${label} ${p} head count`);
  assert.equal(r.percentile, Math.round(percentile(f) * 1000) / 1000, `${label} ${p} percentile`);
  assert.equal(r.trophies, seasonTrophies({ rated: true, ...f, carry: me.carry }), `${label} ${p} trophies`);
}

test('counts never drift: 400 random submits, better runs, hides, direct deletes and a season change vs a recount of ratings', async () => {
  const env = await makeEnv();
  let s = 987654321;
  const rnd = (n) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) % n; };
  const t0 = Date.now() - 3 * SEASON_MS;
  let t = t0;
  const players = Array.from({ length: 70 }, (_, j) => `cnt-${String(j).padStart(4, '0')}`);
  // avg5 edges: 64, 4096, 262144, 2^24 (a single run's avg5 is floor(score / 5)); values just under, on and over each
  const edges = [64, 4096, 262144, 2 ** 24];
  const score = () => {
    const c = rnd(10);
    if (c < 6) { const e = edges[rnd(4)]; return Math.max(1, (e + rnd(5) - 2) * TOP_RUNS + rnd(TOP_RUNS)); } // around an edge
    if (c < 7) return 1 + rnd(8); // avg5 0 or 1
    const sizes = [300, 5000, 90000, 2000000, 100000000];
    return 1 + rnd(sizes[rnd(sizes.length)]); // spread over every level
  };
  let unrated = 0, moved = 0, hidLeft = 0, direct = 0;
  const season1 = seasonFor(t0).id;
  let lastT = t;
  for (let op = 0; op < 400; op++) {
    if (op === 200) t += SEASON_MS; // a season change
    t += 1; lastT = t;
    const c = rnd(10);
    if (c < 2) { // hide: half of the time aim at a player with exactly one run (it leaves them unrated)
      const rows = all(env, 'SELECT entry, game, ver, season, pid FROM season_runs');
      if (rows.length) {
        const singles = rows.filter((r) => rows.filter((q) => q.pid === r.pid && q.season === r.season).length === 1);
        const pick = singles.length && rnd(2) === 0 ? singles[rnd(singles.length)] : rows[rnd(rows.length)];
        const left = rows.filter((q) => q.pid === pick.pid && q.season === pick.season).length - 1;
        await hideEntry(env.DB, { entry: pick.entry, t });
        if (left === 0) unrated++; else hidLeft++;
      }
    } else if (c < 4) { // a better run for a player who has one: moves avg5 (often across an edge)
      const rows = all(env, 'SELECT pid, MAX(score) AS m FROM season_runs WHERE season = ? GROUP BY pid', seasonFor(t).id);
      if (rows.length) { const r = rows[rnd(rows.length)]; await put(env, r.pid, r.m + 1 + rnd(r.m * 2 + 50), t); moved++; }
    } else if (c < 5) {
      // a ratings row deleted directly with its avg5 still above 0. hideEntry never does this (it sets avg5 to 0 first,
      // so only the moved trigger fires), but ratings_removed has to keep the counts right for any delete.
      const rows = all(env, 'SELECT season, pid FROM ratings');
      if (rows.length) { const r = rows[rnd(rows.length)]; env.DB.raw.prepare('DELETE FROM ratings WHERE season = ? AND pid = ?').run(r.season, r.pid); direct++; }
    } else {
      await put(env, players[rnd(players.length)], score(), t);
    }
    if (op % 25 === 24) {
      assertCounts(env, `after op ${op}`);
      for (const season of [season1, seasonFor(lastT).id]) {
        const rated = all(env, 'SELECT pid FROM ratings WHERE season = ?', season).map((r) => r.pid);
        for (let j = 0; j < 6 && rated.length; j++) await assertPercentile(env, season, rated[rnd(rated.length)], `after op ${op}`);
        await assertPercentile(env, season, players[rnd(players.length)], `after op ${op} (maybe unrated)`);
      }
    }
  }
  assertCounts(env, 'end');
  for (const season of [season1, seasonFor(lastT).id]) {
    for (const r of all(env, 'SELECT pid FROM ratings WHERE season = ?', season)) await assertPercentile(env, season, r.pid, 'end');
  }
  // the sequence really did exercise the paths the triggers care about
  assert.ok(unrated >= 5, `hides that left a player unrated: ${unrated}`);
  assert.ok(hidLeft >= 5, `hides that left runs: ${hidLeft}`);
  assert.ok(direct >= 10, `direct deletes of rated rows: ${direct}`);
  assert.ok(moved >= 20, `better runs: ${moved}`);
  assert.notEqual(season1, seasonFor(lastT).id);
  for (const e of edges) assert.ok(all(env, 'SELECT 1 FROM ratings WHERE avg5 >= ? AND avg5 < ? LIMIT 1', e - 3, e + 3).length > 0);
});
