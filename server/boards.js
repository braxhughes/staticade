// Boards, players, replays and trophies as SQL rows. Schema: server/schema.sql.
// No lock anywhere: one submit is one db.batch (one transaction in D1), and every write in it is a single atomic
// statement (INSERT ... ON CONFLICT ... WHERE excluded.score > score), so submits for different players never wait
// on each other and two runs of one player can only both raise their rows.
// Every value is bound with bind(); no input is ever pasted into SQL text.
import { LeaderboardError } from '../leaderboard/api.js';
import { leagueFor, seasonTrophies, percentile, carryOver, TOP_RUNS } from '../leaderboard/ranking.js';

// BOARD_CAP 1000 rows per board. Why: the game shows the top 10 and the attract mode plays the top few, so 1,000
// exact ranks is plenty; a run below the 1,000th on a full board is answered (placement null, trophies still count)
// without being stored. It bounds what a board costs: the placement count walks at most 1,000 index entries, and a
// board holds at most 1,000 replays (about 15 KB for a typical run, 864 KB at the very most).
export const BOARD_CAP = 1000;

export const majorOf = (version) => String(version).split('.')[0];

// The boards one run goes on: all-time, this season, and (daily runs) that day.
export function boardsFor({ season, dayKey }) {
  const out = [['all', 'all'], ['season', `season:${season}`]];
  if (dayKey) out.push(['daily', `daily:${dayKey}`]);
  return out;
}

const bad = (code, msg) => new LeaderboardError(code, msg);

export async function isSeen(db, game, rhash) {
  return (await db.prepare('SELECT 1 AS x FROM seen WHERE game = ? AND rhash = ?').bind(game, rhash).first('x')) != null;
}

// Where `score` ranks among the OTHER players' rows of one board (ties: the earlier row ranks higher).
// null when that is below the cap (the run is not kept there).
async function placeOn(db, { game, ver, board, pid, score, t }) {
  // A full board and a score below its lowest row (most submits once a board is full): every row there is above
  // it, so the rank is known from three single-row reads instead of a walk of up to BOARD_CAP rows.
  const low = await db.prepare('SELECT (SELECT n FROM board_size WHERE game = ? AND ver = ? AND board = ?) AS n, ' +
    '(SELECT score FROM board WHERE game = ? AND ver = ? AND board = ? ORDER BY score ASC, t DESC, entry DESC LIMIT 1) AS lo, ' +
    '(SELECT 1 FROM board WHERE game = ? AND ver = ? AND board = ? AND pid = ?) AS own')
    .bind(game, ver, board, game, ver, board, game, ver, board, pid).first();
  if (low && low.n >= BOARD_CAP && low.lo != null && score < low.lo) {
    const rank = low.n - (low.own ? 1 : 0) + 1;
    return rank <= BOARD_CAP ? rank : null;
  }
  // score >= ? lets the walk stop at this score on index board_top: it reads only the rows above (at most BOARD_CAP).
  const n = await db.prepare('SELECT COUNT(*) AS n FROM board WHERE game = ? AND ver = ? AND board = ? AND score >= ? AND pid <> ? AND (score > ? OR t <= ?)')
    .bind(game, ver, board, score, pid, score, t).first('n');
  return n + 1 <= BOARD_CAP ? n + 1 : null;
}

// Percentile inputs for one avg5 in one season. `self`: whether the player has a row there (then it is not counted).
// Players whose avg5 is 0 are left out of the field (avg5 > 0): a run of score 1..4 averages 0, and a griefer with
// many such players must not lift everyone above them. A player at 0 is still rated, against the others.
// `players` is everyone rated this season (zero averages included): it is a head count for display, not the field.
// Read from the 'rank:' counts in board_size (server/schema.sql), not from ratings: "below" is, at
// each of the 5 levels, the sum of the lower siblings of the avg5's prefix there, so this reads at most about
// 5 x 63 + 3 rows whatever the season's size, and gives exactly the counts a scan of ratings would.
export const HIST_LEVELS = 5, HIST_BITS = 6;
export const histKey = (season, lvl, pre) => `rank:${season}:${lvl}:${String(pre).padStart(16, '0')}`;
// Per level k: [k, lo, hi], the prefixes lo <= p < hi that hold the players below avg5 at that level.
export function histRanges(avg5) {
  const out = [];
  for (let k = 0; k < HIST_LEVELS; k++) {
    const pre = Math.floor(avg5 / 2 ** (HIST_BITS * k));
    const lo = k === HIST_LEVELS - 1 ? 0 : Math.floor(pre / 2 ** HIST_BITS) * 2 ** HIST_BITS; // the top level: everything below
    out.push([k, lo, pre]);
  }
  return out;
}
const ONE = '(SELECT n FROM board_size WHERE game = ? AND ver = ? AND board = ?)';
const SUM = '(SELECT COALESCE(SUM(n), 0) FROM board_size WHERE game = ? AND ver = ? AND board >= ? AND board < ?)';
const FIELD_SQL = `SELECT ${ONE} AS n, ${ONE} AS pos, ${ONE} AS same, ${Array.from({ length: HIST_LEVELS }, () => SUM).join(' + ')} AS below`;
async function fieldOf(db, { game, ver, season, avg5, self }) {
  const v = [game, ver, histKey(season, 9, 0), game, ver, histKey(season, 8, 0), game, ver, histKey(season, 0, avg5)];
  for (const [k, lo, hi] of histRanges(avg5)) v.push(game, ver, histKey(season, k, lo), histKey(season, k, hi));
  const r = await db.prepare(FIELD_SQL).bind(...v).first();
  const pos = r?.pos ?? 0, same = avg5 > 0 ? (r?.same ?? 0) : 0, below = avg5 > 0 ? (r?.below ?? 0) : 0;
  const k = self && avg5 > 0 ? 1 : 0;
  return { below, ties: same - k, others: pos - k, players: r?.n ?? 0 };
}

// The floor a player starts `season` with: half of what they ended their last played season with, per season since.
async function carryInto(db, { game, ver, pid, season }) {
  const prev = await db.prepare('SELECT season, avg5, carry FROM ratings INDEXED BY ratings_pid WHERE game = ? AND ver = ? AND pid = ? AND season < ? ORDER BY season DESC LIMIT 1')
    .bind(game, ver, pid, season).first();
  if (!prev) return 0;
  const f = await fieldOf(db, { game, ver, season: prev.season, avg5: prev.avg5, self: true });
  return carryOver(seasonTrophies({ rated: true, ...f, carry: prev.carry }), season - prev.season);
}

// A player's trophies now: { rated, avg5, carry, trophies, percentile, players }.
export async function ratingOf(db, { game, ver, pid, season }) {
  const row = await db.prepare('SELECT avg5, carry FROM ratings WHERE game = ? AND ver = ? AND season = ? AND pid = ?').bind(game, ver, season, pid).first();
  if (!row) {
    const carry = await carryInto(db, { game, ver, pid, season });
    return { rated: false, avg5: 0, carry, trophies: carry, percentile: null, players: null };
  }
  const f = await fieldOf(db, { game, ver, season, avg5: row.avg5, self: true });
  return { rated: true, avg5: row.avg5, carry: row.carry, trophies: seasonTrophies({ rated: true, ...f, carry: row.carry }),
    percentile: Math.round(percentile(f) * 1000) / 1000, players: f.players };
}

async function topOf(db, { game, ver, season, pid }) {
  const { results } = await db.prepare('SELECT entry, score FROM season_runs WHERE game = ? AND ver = ? AND season = ? AND pid = ? ORDER BY score DESC, t ASC, entry ASC')
    .bind(game, ver, season, pid).all();
  return results;
}

// Store one checked run. run: { game, pid, name (A-Z x3), score, replay, seed, mode, dayKey?, version, stats }.
// claim (optional): the result claim, marked finished in the same batch. Returns the submit answer.
export async function storeRun(db, { run, t, season, entry, rhash, claim }) {
  const { game, pid, name, score } = run;
  const ver = majorOf(run.version);
  const date = new Date(t).toISOString();
  const before = await ratingOf(db, { game, ver, pid, season });
  const boards = boardsFor({ season, dayKey: run.dayKey });

  const q = (sql, ...v) => db.prepare(sql).bind(...v);
  const stmts = [
    q('INSERT INTO seen (game, rhash, entry) VALUES (?, ?, ?)', game, rhash, entry), // a repeat fails the whole batch
    q('INSERT INTO replays (entry, game, ver, name, score, seed, mode, day, version, date, replay, stats) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      entry, game, ver, name, score, run.seed, run.mode, run.dayKey ?? null, String(run.version), date, run.replay, run.stats == null ? null : JSON.stringify(run.stats)),
  ];
  for (const [, b] of boards) {
    // In only if the board has room or the run beats its lowest row; a player's row only ever goes up.
    stmts.push(q('INSERT INTO board (game, ver, board, pid, score, t, entry, name, mode, date) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ' +
      'WHERE COALESCE((SELECT n FROM board_size WHERE game = ? AND ver = ? AND board = ?), 0) < ? ' +
      '   OR ? > (SELECT score FROM board WHERE game = ? AND ver = ? AND board = ? ORDER BY score ASC, t DESC, entry DESC LIMIT 1) ' +
      'ON CONFLICT (game, ver, board, pid) DO UPDATE SET score = excluded.score, t = excluded.t, entry = excluded.entry, name = excluded.name, ' +
      'mode = excluded.mode, date = excluded.date WHERE excluded.score > board.score',
    game, ver, b, pid, score, t, entry, name, run.mode, date, game, ver, b, BOARD_CAP, score, game, ver, b));
    // Over the cap (a new player came in at the top): drop the lowest row.
    stmts.push(q('DELETE FROM board WHERE game = ? AND ver = ? AND board = ? AND COALESCE((SELECT n FROM board_size WHERE game = ? AND ver = ? AND board = ?), 0) > ? ' +
      'AND pid = (SELECT pid FROM board WHERE game = ? AND ver = ? AND board = ? ORDER BY score ASC, t DESC, entry DESC LIMIT 1)',
    game, ver, b, game, ver, b, BOARD_CAP, game, ver, b));
  }
  stmts.push(
    q('INSERT INTO players (game, ver, pid, name, best, t) VALUES (?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT (game, ver, pid) DO UPDATE SET name = excluded.name, best = MAX(players.best, excluded.best), t = excluded.t',
    game, ver, pid, name, score, t),
    q('INSERT INTO season_runs (game, ver, season, pid, entry, score, t) VALUES (?, ?, ?, ?, ?, ?, ?)', game, ver, season, pid, entry, score, t),
    q(`DELETE FROM season_runs WHERE game = ? AND ver = ? AND season = ? AND pid = ? AND entry NOT IN ` +
      `(SELECT entry FROM season_runs WHERE game = ? AND ver = ? AND season = ? AND pid = ? ORDER BY score DESC, t ASC, entry ASC LIMIT ${TOP_RUNS})`,
    game, ver, season, pid, game, ver, season, pid),
    q(`INSERT INTO ratings (game, ver, season, pid, avg5, carry) VALUES (?, ?, ?, ?, ` +
      `(SELECT COALESCE(SUM(score), 0) / ${TOP_RUNS} FROM season_runs WHERE game = ? AND ver = ? AND season = ? AND pid = ?), ?) ` +
      'ON CONFLICT (game, ver, season, pid) DO UPDATE SET avg5 = excluded.avg5',
    game, ver, season, pid, game, ver, season, pid, before.carry),
    // On no board at all (worse than the player's own rows and below every cap): no replay to keep.
    q('DELETE FROM replays WHERE entry = ? AND NOT EXISTS (SELECT 1 FROM board WHERE entry = ?)', entry, entry),
  );
  if (claim) stmts.push(q('UPDATE results SET entry = ? WHERE game = ? AND board = ? AND hash = ? AND score = ?', entry, claim.game, claim.board, claim.hash, claim.score));

  try { await db.batch(stmts); }
  catch (e) {
    if (/UNIQUE/i.test(String(e?.message)) && (await isSeen(db, game, rhash))) throw bad('duplicate_replay', 'this replay was already submitted');
    throw e;
  }

  const top = await topOf(db, { game, ver, season, pid });
  const entered = top.some((r) => r.entry === entry);
  const after = entered ? await ratingOf(db, { game, ver, pid, season }) : before; // Best-5 rule: not in the best 5, nothing moves
  const placements = {};
  for (const [label, b] of boards) placements[label] = await placeOn(db, { game, ver, board: b, pid, score, t });
  const lb = leagueFor(before.trophies), la = leagueFor(after.trophies);
  const out = { id: entry, placements, trophyDelta: after.trophies - before.trophies, trophies: after.trophies,
    league: { name: la.name, tier: la.tier, label: la.label },
    rating: { avg5: after.avg5, top5: top.map((r) => r.score), enteredTop5: entered, percentile: after.percentile, players: after.players },
    boardCap: BOARD_CAP };
  if (la.rung > lb.rung) { out.promoted = true; out.from = lb.label; }
  if (la.rung < lb.rung) { out.demoted = true; out.from = lb.label; }
  return out;
}

// Top-N of one board: a walk of index board_top, so the cost is limit + offset rows whatever the board size.
export async function readBoard(db, { game, ver, board, limit, offset }) {
  const { results } = await db.prepare('SELECT name, score, date, mode, entry FROM board WHERE game = ? AND ver = ? AND board = ? ' +
    'ORDER BY score DESC, t ASC, entry ASC LIMIT ? OFFSET ?').bind(game, ver, board, limit, offset).all();
  return results.map((r, i) => ({ rank: offset + i + 1, name: r.name, score: r.score, date: r.date, mode: r.mode, id: r.entry }));
}

export async function readRank(db, { game, ver, pid, season }) {
  const r = await ratingOf(db, { game, ver, pid, season });
  const top = (await topOf(db, { game, ver, season, pid })).map((x) => x.score);
  const best = (await db.prepare('SELECT best FROM players WHERE game = ? AND ver = ? AND pid = ?').bind(game, ver, pid).first('best')) ?? 0;
  const lg = leagueFor(r.trophies);
  return { trophies: r.trophies, league: lg.name, tier: lg.tier, label: lg.label, best, seasonBest: top[0] ?? 0,
    avg5: r.avg5, top5: top, percentile: r.percentile, players: r.players, carry: r.carry };
}

export async function readReplay(db, entry) {
  const r = await db.prepare('SELECT * FROM replays WHERE entry = ?').bind(entry).first();
  if (!r) return null;
  let stats = null;
  try { stats = r.stats == null ? null : JSON.parse(r.stats); } catch { /* unreadable: none */ }
  return { id: r.entry, game: r.game, name: r.name, score: r.score, seed: r.seed, mode: r.mode, dayKey: r.day,
    version: r.version, replay: r.replay, date: r.date, stats };
}

// POST /admin/hide: take an entry off every board (all versions), and out of trophies: its run leaves
// the player's best 5, their avg5 is worked out again from the runs left (so the percentile counts move with it, by
// the ratings triggers), and a player with no run left this season is unrated again (back to their carry). If the
// hidden run was their all-time best, best drops to the best run left in their best 5. All of it is one batch.
// Its replay goes with the last board row (trigger). The 6th-best run was trimmed when it was beaten, so a player's
// average after a hide counts the missing run as 0 (it can only go down, which is what a hide is for).
// Returns { rows, runs }: board rows and best-5 rows it removed (both 0: no such entry anywhere).
export async function hideEntry(db, { entry, t }) {
  const { results: keys } = await db.prepare('SELECT game, ver, season, pid, score FROM season_runs WHERE entry = ?').bind(entry).all();
  const q = (sql, ...v) => db.prepare(sql).bind(...v);
  const stmts = [q('DELETE FROM board WHERE entry = ?', entry), q('DELETE FROM season_runs WHERE entry = ?', entry)];
  for (const k of keys) {
    const key = [k.game, k.ver, k.season, k.pid];
    stmts.push(
      q(`UPDATE ratings SET avg5 = (SELECT COALESCE(SUM(score), 0) / ${TOP_RUNS} FROM season_runs WHERE game = ? AND ver = ? AND season = ? AND pid = ?) ` +
        'WHERE game = ? AND ver = ? AND season = ? AND pid = ?', ...key, ...key),
      q('DELETE FROM ratings WHERE game = ? AND ver = ? AND season = ? AND pid = ? AND NOT EXISTS ' +
        '(SELECT 1 FROM season_runs WHERE game = ? AND ver = ? AND season = ? AND pid = ?)', ...key, ...key),
      q('UPDATE players SET best = COALESCE((SELECT MAX(score) FROM season_runs WHERE game = ? AND ver = ? AND season = ? AND pid = ?), 0) ' +
        'WHERE game = ? AND ver = ? AND pid = ? AND best = ?', ...key, k.game, k.ver, k.pid, k.score),
    );
  }
  const out = await db.batch(stmts);
  const rows = out[0].meta.changes, runs = out[1].meta.changes;
  if (rows > 0 || runs > 0) {
    await db.prepare('INSERT INTO hidden (entry, t, rows) VALUES (?, ?, ?) ON CONFLICT (entry) DO UPDATE SET t = excluded.t, rows = hidden.rows + excluded.rows')
      .bind(entry, t, rows).run();
  }
  return { rows, runs };
}
