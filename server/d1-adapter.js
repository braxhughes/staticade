// D1 helpers (db.prepare(sql).bind(...).run()/all()/first()). Schema: server/schema.sql.
// The Worker uses: result claims (exact and near copies), held near copies and rate limit counters. Boards,
// players, replays and trophies are rows in server/boards.js (w22). d1Storage below is the general key-value
// adapter leaderboard/api.js can run on; the Worker no longer uses it.
// Every value is bound with bind(); no input is ever pasted into SQL text.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
import { similarity, NEAR, MIN_EVENTS } from './dedupe.js';

let ownerSeq = 0;
const ownerTag = () => {
  try { return globalThis.crypto.randomUUID(); } catch { return `o${Date.now().toString(36)}${(++ownerSeq).toString(36)}`; }
};

export class LockBusyError extends Error {
  constructor() { super('leaderboard is busy, try again'); this.code = 'busy'; }
}

// leaseMs: how long a lock is held at most if a Worker dies while holding it.
// waitMs: how long a submit waits for the lock before it gives up with 'busy'.
export function d1Storage(db, { now = () => Date.now(), leaseMs = 10000, waitMs = 5000, pollMs = 25 } = {}) {
  return {
    async get(key) {
      const raw = await db.prepare('SELECT v FROM kv WHERE k = ?').bind(String(key)).first('v');
      if (raw == null) return null;
      try { return JSON.parse(raw); } catch { return null; } // corrupt value reads as missing, like the other adapters
    },
    async set(key, value) {
      await db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
        .bind(String(key), JSON.stringify(value)).run();
    },
    async remove(key) {
      await db.prepare('DELETE FROM kv WHERE k = ?').bind(String(key)).run();
    },
    async keys(prefix = '') {
      const p = String(prefix);
      const { results } = await db.prepare('SELECT k FROM kv WHERE substr(k, 1, ?) = ? ORDER BY k').bind(p.length, p).all();
      return results.map((r) => r.k);
    },
    // A lease lock in D1: shared by every Worker copy, so board writes never interleave.
    async withLock(name, fn) {
      const owner = ownerTag();
      const give = Date.now() + waitMs;
      for (;;) {
        const t = now();
        const r = await db.prepare('INSERT INTO locks (name, owner, until) VALUES (?, ?, ?) ' +
          'ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, until = excluded.until WHERE locks.until < ?')
          .bind(String(name), owner, t + leaseMs, t).run();
        if (r.meta.changes === 1) break;
        if (Date.now() > give) throw new LockBusyError();
        await sleep(pollMs);
      }
      try { return await fn(); }
      finally { await db.prepare('DELETE FROM locks WHERE name = ? AND owner = ?').bind(String(name), owner).run(); }
    },
  };
}

// Claim a re-simulated result before storing it. Returns false if this game and board already hold a run
// with the same final hash and score. A claim left unfinished by a crashed Worker can be taken over after staleMs.
// sig (optional): the run's signature (server/dedupe.js), kept for the near-copy check in findNearRun.
// Each claim gets the next seq in the same statement (one statement is atomic in D1), so claims have one order.
export async function claimResult(db, { game, board, hash, score, t, sig = null, staleMs = 60000 }) {
  const r = await db.prepare('INSERT INTO results (game, board, hash, score, entry, t, sig, seq) VALUES (?, ?, ?, ?, NULL, ?, ?, ' +
    '(SELECT COALESCE(MAX(seq), 0) + 1 FROM results)) ' +
    'ON CONFLICT(game, board, hash, score) DO UPDATE SET t = excluded.t, sig = excluded.sig, seq = excluded.seq WHERE results.entry IS NULL AND results.t < ?')
    .bind(game, board, hash, score, t, sig == null ? null : JSON.stringify(sig), t - staleMs).run();
  return r.meta.changes === 1;
}

// Near copies. Looks at up to `limit` stored runs each side of `score` (between half and double it) on this game
// and board, live claims and finished ones (a claim older than staleMs that never finished is ignored), and returns
// the most similar one if it is at least NEAR alike, else null. Call it right after this run's own claimResult.
// No lock (w22, MED4): only claims made BEFORE this run's claim (smaller seq) count. Two copies sent at once: the
// later claim always sees the earlier one (it was inserted first) and is held; the earlier one never waits on the
// later. So at most one of them goes on the board, as with the old per-board lock.
export const nearLockName = (game, board) => `results:${game}:${board}`; // kept for callers of the old lock name
export async function findNearRun(db, { game, board, hash, score, sig, t, staleMs = 60000, limit = 50 }) {
  if ((sig.length >> 1) < MIN_EVENTS) return null;
  const mine = await db.prepare('SELECT seq FROM results WHERE game = ? AND board = ? AND hash = ? AND score = ?').bind(game, board, String(hash), score).first('seq');
  const seq = mine == null ? Number.MAX_SAFE_INTEGER : mine; // no claim of its own: compare with every claim
  const live = 'hash <> ? AND (entry IS NOT NULL OR t >= ?) AND seq < ?'; // hash: skip this run's own claim
  const up = await db.prepare(`SELECT entry, score, sig FROM results WHERE game = ? AND board = ? AND score >= ? AND score <= ? AND sig IS NOT NULL AND ${live} ORDER BY score ASC LIMIT ?`)
    .bind(game, board, score, score * 2, String(hash), t - staleMs, seq, limit).all();
  const down = await db.prepare(`SELECT entry, score, sig FROM results WHERE game = ? AND board = ? AND score < ? AND score >= ? AND sig IS NOT NULL AND ${live} ORDER BY score DESC LIMIT ?`)
    .bind(game, board, score, Math.floor(score / 2), String(hash), t - staleMs, seq, limit).all();
  let best = null;
  for (const row of [...up.results, ...down.results]) {
    let other; try { other = JSON.parse(row.sig); } catch { continue; }
    if (!Array.isArray(other)) continue;
    const s = similarity(sig, other);
    if (s >= NEAR && (!best || s > best.similarity)) best = { entry: row.entry, score: row.score, similarity: s };
  }
  return best;
}
// Held near-copies (table flagged). holdRun stores one (once per game, board, hash and score; sending the
// same run again returns the same id) and returns its id. run: the full submit, so it can be released later.
export async function holdRun(db, { game, board, hash, score, t, near, sig, run }) {
  await db.prepare('INSERT INTO flagged (game, board, hash, score, t, status, pid, name, near_entry, near_score, similarity, sig, run) ' +
    "VALUES (?, ?, ?, ?, ?, 'flagged', ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(game, board, hash, score) DO NOTHING")
    .bind(game, board, String(hash), score, t, String(run.playerId), String(run.name ?? ''), near.entry ?? null, near.score,
      near.similarity, JSON.stringify(sig), JSON.stringify(run)).run();
  return db.prepare('SELECT id FROM flagged WHERE game = ? AND board = ? AND hash = ? AND score = ?')
    .bind(game, board, String(hash), score).first('id');
}
// One held run, by id or by (game, board, hash, score); null if none.
export async function getHeld(db, { id, game, board, hash, score }) {
  if (id !== undefined) return db.prepare('SELECT * FROM flagged WHERE id = ?').bind(id).first();
  return db.prepare('SELECT * FROM flagged WHERE game = ? AND board = ? AND hash = ? AND score = ?').bind(game, board, String(hash), score).first();
}
export async function countHeld(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM flagged WHERE status = 'flagged'").first('n');
}
export async function markReleased(db, { id, entry }) {
  await db.prepare("UPDATE flagged SET status = 'released', entry = ? WHERE id = ?").bind(entry, id).run();
}
export async function finishResult(db, { game, board, hash, score, entry }) {
  await db.prepare('UPDATE results SET entry = ? WHERE game = ? AND board = ? AND hash = ? AND score = ?')
    .bind(entry, game, board, hash, score).run();
}
export async function releaseResult(db, { game, board, hash, score }) {
  await db.prepare('DELETE FROM results WHERE game = ? AND board = ? AND hash = ? AND score = ? AND entry IS NULL')
    .bind(game, board, hash, score).run();
}

// Fixed-window counter. Counts this hit and returns { ok, n, retryAfter } (retryAfter in seconds).
// One upsert, so two Worker copies cannot both slip under the limit with the same count.
export async function hitRate(db, key, { limit, windowMs, t }) {
  const win = Math.floor(t / windowMs);
  const n = await db.prepare('INSERT INTO rate (k, win, n) VALUES (?, ?, 1) ' +
    'ON CONFLICT(k) DO UPDATE SET n = CASE WHEN rate.win = excluded.win THEN rate.n + 1 ELSE 1 END, win = excluded.win RETURNING n')
    .bind(key, win).first('n');
  return { ok: n <= limit, n, retryAfter: Math.max(1, Math.ceil(((win + 1) * windowMs - t) / 1000)) };
}
// Old windows are useless; drop them so the table stays one small row per active key. The Worker calls this once per
// window per Worker copy, not on every request (index rate_win keeps it cheap).
export async function sweepRate(db, { windowMs, t }) {
  await db.prepare('DELETE FROM rate WHERE win < ?').bind(Math.floor(t / windowMs) - 1).run();
}
