-- Leaderboard server schema for Cloudflare D1 (hosted SQLite). Apply once:
--   cd server && npx wrangler d1 execute arcade-lb --remote --file=schema.sql
-- Every statement is IF NOT EXISTS, so applying it again is safe.

-- Boards: one row per player per board, the player's best run on it. A board is 'all',
-- 'season:<id>' or 'daily:YYYY-MM-DD', kept per game and major game version (ver). Reads are a top-N walk of
-- board_top, so their cost does not grow with the board. At most BOARD_CAP rows per board (server/boards.js).
CREATE TABLE IF NOT EXISTS board (
  game  TEXT NOT NULL,
  ver   TEXT NOT NULL,     -- major GAME_VERSION, e.g. '2'
  board TEXT NOT NULL,
  pid   TEXT NOT NULL,
  score INTEGER NOT NULL,
  t     INTEGER NOT NULL,  -- ms when stored (ties: earlier wins)
  entry TEXT NOT NULL,     -- the run's id (replays.entry)
  name  TEXT NOT NULL,
  mode  TEXT NOT NULL,
  date  TEXT NOT NULL,
  PRIMARY KEY (game, ver, board, pid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS board_top ON board (game, ver, board, score DESC, t, entry);
CREATE INDEX IF NOT EXISTS board_entry ON board (entry);

-- Rows per board, kept by the triggers below, so the cap check reads one row instead of counting the board.
-- Also holds the percentile counts under keys 'rank:...' (see the ratings triggers below).
CREATE TABLE IF NOT EXISTS board_size (
  game  TEXT NOT NULL,
  ver   TEXT NOT NULL,
  board TEXT NOT NULL,
  n     INTEGER NOT NULL,
  PRIMARY KEY (game, ver, board)
) WITHOUT ROWID;

-- One stored run (its replay) per entry that some board still lists. The triggers drop it when the last board row
-- that points at it goes (a better run replaced it, the cap pushed it out, or POST /admin/hide).
CREATE TABLE IF NOT EXISTS replays (
  entry   TEXT PRIMARY KEY NOT NULL,
  game    TEXT NOT NULL,
  ver     TEXT NOT NULL,
  name    TEXT NOT NULL,
  score   INTEGER NOT NULL,
  seed    INTEGER NOT NULL,
  mode    TEXT NOT NULL,
  day     TEXT,
  version TEXT NOT NULL,
  date    TEXT NOT NULL,
  replay  TEXT NOT NULL,
  stats   TEXT
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS board_added AFTER INSERT ON board BEGIN
  INSERT OR IGNORE INTO board_size (game, ver, board, n) VALUES (new.game, new.ver, new.board, 0);
  UPDATE board_size SET n = n + 1 WHERE game = new.game AND ver = new.ver AND board = new.board;
END;
CREATE TRIGGER IF NOT EXISTS board_removed AFTER DELETE ON board BEGIN
  UPDATE board_size SET n = n - 1 WHERE game = old.game AND ver = old.ver AND board = old.board;
  DELETE FROM replays WHERE entry = old.entry AND NOT EXISTS (SELECT 1 FROM board WHERE entry = old.entry);
END;
CREATE TRIGGER IF NOT EXISTS board_replaced AFTER UPDATE OF entry ON board WHEN old.entry <> new.entry BEGIN
  DELETE FROM replays WHERE entry = old.entry AND NOT EXISTS (SELECT 1 FROM board WHERE entry = old.entry);
END;

-- Exact replay strings already stored (duplicate_replay): game and the replay's 53-bit hash. Grows one row per
-- accepted submit (about 60 bytes).
CREATE TABLE IF NOT EXISTS seen (
  game  TEXT NOT NULL,
  rhash TEXT NOT NULL,
  entry TEXT NOT NULL,
  PRIMARY KEY (game, rhash)
) WITHOUT ROWID;

-- One row per player per game and major version: display name and all-time best.
CREATE TABLE IF NOT EXISTS players (
  game TEXT NOT NULL,
  ver  TEXT NOT NULL,
  pid  TEXT NOT NULL,
  name TEXT NOT NULL,
  best INTEGER NOT NULL,
  t    INTEGER NOT NULL,
  PRIMARY KEY (game, ver, pid)
) WITHOUT ROWID;

-- Trophies. season_runs: each player's best 5 runs per season (a 6th is trimmed in the same batch).
-- ratings: one row per player per season, avg5 = floor(sum of those best 5 / 5), carry = the floor kept from the
-- last season. ratings_avg makes the percentile count an index-only walk of one season.
CREATE TABLE IF NOT EXISTS season_runs (
  game   TEXT NOT NULL,
  ver    TEXT NOT NULL,
  season INTEGER NOT NULL,
  pid    TEXT NOT NULL,
  entry  TEXT NOT NULL,
  score  INTEGER NOT NULL,
  t      INTEGER NOT NULL,
  PRIMARY KEY (game, ver, season, pid, entry)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ratings (
  game   TEXT NOT NULL,
  ver    TEXT NOT NULL,
  season INTEGER NOT NULL,
  pid    TEXT NOT NULL,
  avg5   INTEGER NOT NULL,
  carry  INTEGER NOT NULL,
  PRIMARY KEY (game, ver, season, pid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ratings_avg ON ratings (game, ver, season, avg5);
CREATE INDEX IF NOT EXISTS ratings_pid ON ratings (game, ver, pid, season);
CREATE INDEX IF NOT EXISTS season_runs_entry ON season_runs (entry);

-- The percentile field as counts, so a submit or /rank reads a few hundred rows at most instead of
-- one row per rated player. The counts live in board_size (a table of counts kept by triggers) under keys that
-- start 'rank:', which no board name can (boards are 'all', 'season:<id>', 'daily:<day>'). They are kept by the
-- triggers below on every change to ratings, in the same statement, so they cannot drift from ratings (a test
-- rebuilds them from ratings and compares). Key: 'rank:<season>:<lvl>:<prefix, 16 digits>'.
--   lvl 9, prefix 0: every rated player this season (the head count, zero averages included)
--   lvl 8, prefix 0: players whose avg5 > 0 (the field)
--   lvl k = 0..4: players with avg5 > 0 per prefix avg5 >> (6 * k). Level 0 is the exact avg5, level 1 groups 64
--   neighbouring values, level 2 groups 4,096, and so on. "Players below X" is the sum, at each level, of X's
--   lower siblings (at most 63 rows a level), so it is exact and costs at most about 5 x 63 rows to read.
-- Cloudflare D1 allows at most 5 terms in one compound SELECT (node:sqlite allows 500), so each set of levels
-- below is written as two additive upserts of at most 4 terms. Adding 1 to the same keys in two statements is the
-- same as in one. server/sqlite-d1.js sets the same limit, so a longer chain fails the tests.
CREATE TRIGGER IF NOT EXISTS ratings_added AFTER INSERT ON ratings BEGIN
  INSERT INTO board_size (game, ver, board, n)
    SELECT new.game, new.ver, printf('rank:%d:%d:%016d', new.season, l.lvl, l.pre), 1 FROM (
      SELECT 9 AS lvl, 0 AS pre UNION ALL SELECT 8, 0 WHERE new.avg5 > 0
      UNION ALL SELECT 0, new.avg5 WHERE new.avg5 > 0 UNION ALL SELECT 1, new.avg5 >> 6 WHERE new.avg5 > 0) AS l WHERE true
    ON CONFLICT (game, ver, board) DO UPDATE SET n = n + 1;
  INSERT INTO board_size (game, ver, board, n)
    SELECT new.game, new.ver, printf('rank:%d:%d:%016d', new.season, l.lvl, l.pre), 1 FROM (
      SELECT 2 AS lvl, new.avg5 >> 12 AS pre UNION ALL SELECT 3, new.avg5 >> 18
      UNION ALL SELECT 4, new.avg5 >> 24) AS l WHERE new.avg5 > 0
    ON CONFLICT (game, ver, board) DO UPDATE SET n = n + 1;
END;
CREATE TRIGGER IF NOT EXISTS ratings_moved AFTER UPDATE OF avg5 ON ratings WHEN old.avg5 <> new.avg5 BEGIN
  UPDATE board_size SET n = n - 1 WHERE game = old.game AND ver = old.ver AND old.avg5 > 0 AND board IN (
    printf('rank:%d:8:%016d', old.season, 0), printf('rank:%d:0:%016d', old.season, old.avg5),
    printf('rank:%d:1:%016d', old.season, old.avg5 >> 6), printf('rank:%d:2:%016d', old.season, old.avg5 >> 12),
    printf('rank:%d:3:%016d', old.season, old.avg5 >> 18), printf('rank:%d:4:%016d', old.season, old.avg5 >> 24));
  INSERT INTO board_size (game, ver, board, n)
    SELECT new.game, new.ver, printf('rank:%d:%d:%016d', new.season, l.lvl, l.pre), 1 FROM (
      SELECT 8 AS lvl, 0 AS pre UNION ALL SELECT 0, new.avg5 UNION ALL SELECT 1, new.avg5 >> 6) AS l WHERE new.avg5 > 0
    ON CONFLICT (game, ver, board) DO UPDATE SET n = n + 1;
  INSERT INTO board_size (game, ver, board, n)
    SELECT new.game, new.ver, printf('rank:%d:%d:%016d', new.season, l.lvl, l.pre), 1 FROM (
      SELECT 2 AS lvl, new.avg5 >> 12 AS pre UNION ALL SELECT 3, new.avg5 >> 18 UNION ALL SELECT 4, new.avg5 >> 24) AS l WHERE new.avg5 > 0
    ON CONFLICT (game, ver, board) DO UPDATE SET n = n + 1;
END;
CREATE TRIGGER IF NOT EXISTS ratings_removed AFTER DELETE ON ratings BEGIN
  UPDATE board_size SET n = n - 1 WHERE game = old.game AND ver = old.ver AND board = printf('rank:%d:9:%016d', old.season, 0);
  UPDATE board_size SET n = n - 1 WHERE game = old.game AND ver = old.ver AND old.avg5 > 0 AND board IN (
    printf('rank:%d:8:%016d', old.season, 0), printf('rank:%d:0:%016d', old.season, old.avg5),
    printf('rank:%d:1:%016d', old.season, old.avg5 >> 6), printf('rank:%d:2:%016d', old.season, old.avg5 >> 12),
    printf('rank:%d:3:%016d', old.season, old.avg5 >> 18), printf('rank:%d:4:%016d', old.season, old.avg5 >> 24));
END;
-- A database made before these counts existed: fill them once from ratings (only while there are none, so applying
-- this file again never counts anyone twice). The levels 0..4, 8, 9 are i + 8 * j over two short lists (D1's 5-term
-- compound limit), so the one "only while there are none" check stays in one statement.
INSERT INTO board_size (game, ver, board, n)
  SELECT r.game, r.ver, printf('rank:%d:%d:%016d', r.season, k.lvl, CASE WHEN k.lvl >= 8 THEN 0 ELSE r.avg5 >> (6 * k.lvl) END), COUNT(*)
  FROM ratings AS r, (SELECT a.i + 8 * b.j AS lvl
    FROM (SELECT 0 AS i UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4) AS a,
         (SELECT 0 AS j UNION ALL SELECT 1) AS b WHERE b.j = 0 OR a.i < 2) AS k
  WHERE (k.lvl = 9 OR r.avg5 > 0) AND NOT EXISTS (SELECT 1 FROM board_size WHERE board LIKE 'rank:%')
  GROUP BY r.game, r.ver, r.season, k.lvl, CASE WHEN k.lvl >= 8 THEN 0 ELSE r.avg5 >> (6 * k.lvl) END;

-- POST /admin/hide: the entries the owner took off the boards (a record; the board rows themselves are deleted).
CREATE TABLE IF NOT EXISTS hidden (
  entry TEXT PRIMARY KEY NOT NULL,
  t     INTEGER NOT NULL,
  rows  INTEGER NOT NULL
) WITHOUT ROWID;

-- Not used by the Worker any more (boards are rows above, and there is no global lock any more). Kept because
-- server/d1-adapter.js d1Storage, a general key-value adapter with a lease lock, still works on them.
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY NOT NULL,
  v TEXT NOT NULL
) WITHOUT ROWID;

-- One row per accepted re-simulated result. A second run with the same final sim hash and score on the
-- same game and board is refused (duplicate_result), so one honest run cannot be resubmitted with edited
-- frames the game ignores. sig holds the run's first scoring events; a run too much like a stored one (an
-- edited copy that changed the hash) is held for review in flagged (server/dedupe.js). Grows one row per
-- accepted submit.
CREATE TABLE IF NOT EXISTS results (
  game  TEXT NOT NULL,
  board TEXT NOT NULL,    -- 'free' or 'daily:YYYY-MM-DD'
  hash  TEXT NOT NULL,    -- the server's re-simulated final state hash
  score INTEGER NOT NULL, -- the server's re-simulated score
  entry TEXT,             -- the stored entry id once the submit finished
  t     INTEGER NOT NULL, -- ms when claimed
  sig   TEXT,             -- JSON [frame, points, ...] of the first 128 scoring events (server/dedupe.js)
  seq   INTEGER,          -- claim order: a near copy is held only if it matches an EARLIER claim, so two
                          -- copies sent at the same moment need no lock (server/d1-adapter.js findNearRun)
  PRIMARY KEY (game, board, hash, score)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS results_score ON results (game, board, score);
CREATE INDEX IF NOT EXISTS results_seq ON results (seq);

-- Near copies are held here for review instead of being thrown away (the honest/copy gap was measured on
-- bots, not people). A held run is on no board and moves no trophies. The owner lists them and releases one with
-- POST /admin/release (server/README.md, "Near-copy check"). At most 500 wait at once (LIMITS.heldCap).
CREATE TABLE IF NOT EXISTS flagged (
  id         INTEGER PRIMARY KEY,
  game       TEXT NOT NULL,
  board      TEXT NOT NULL,
  hash       TEXT NOT NULL,
  score      INTEGER NOT NULL,
  t          INTEGER NOT NULL,     -- ms when held
  status     TEXT NOT NULL,        -- 'flagged' (waiting) or 'released' (on the board now)
  pid        TEXT NOT NULL,
  name       TEXT NOT NULL,
  near_entry TEXT,                 -- the stored run it matched (its entry id; NULL if that one was still being stored)
  near_score INTEGER,
  similarity REAL NOT NULL,        -- how alike, 0 to 1 (server/dedupe.js)
  sig        TEXT,
  run        TEXT NOT NULL,        -- JSON of the whole submit with the server's score and stats, for release
  entry      TEXT,                 -- the board entry id once released
  UNIQUE (game, board, hash, score)
);
CREATE INDEX IF NOT EXISTS flagged_status ON flagged (status, t);

-- Fixed-window rate limit counters: k is 'ip:<address>' (IPv6: its /64) or 'pid:<playerId>', win is the window number.
CREATE TABLE IF NOT EXISTS rate (
  k   TEXT PRIMARY KEY NOT NULL,
  win INTEGER NOT NULL,
  n   INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS rate_win ON rate (win);

-- d1Storage's lease lock (see kv above). The Worker no longer takes any lock.
CREATE TABLE IF NOT EXISTS locks (
  name  TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  until INTEGER NOT NULL
) WITHOUT ROWID;
