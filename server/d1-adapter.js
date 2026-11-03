// D1 helpers (db.prepare(sql).bind(...).run()/all()/first()). Schema: server/schema.sql.
// The Worker uses: result claims (exact and near copies), held near copies and rate limit counters. Boards,
// players, replays and trophies are rows in server/boards.js. d1Storage below is the general key-value
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
// No lock: only claims made BEFORE this run's claim (smaller seq) count. Two copies sent at once: the
// later claim always sees the earlier one (it was inserted first) and is held; the earlier one never waits on the
// later. So at most one of them goes on the board, as with the old per-board lock.
export const nearLockName = (game, board) => `results:${game}:${board}`; // kept for callers of the old lock name
// The 50 each side by score could be filled with planted runs so the copied original sat outside them.
// So the board's top K runs (by score, whatever their distance) are compared too: a copy of a top-K run is found however
// many runs sit between them. Worst case per submit: 1 + 50 + 50 + K = 121 rows read (K = 20), each with its sig.
export const NEAR_TOP_K = 20;
export async function findNearRun(db, { game, board, hash, score, sig, t, staleMs = 60000, limit = 50, topK = NEAR_TOP_K }) {
  if ((sig.length >> 1) < MIN_EVENTS) return null;
  const mine = await db.prepare('SELECT seq FROM results WHERE game = ? AND board = ? AND hash = ? AND score = ?').bind(game, board, String(hash), score).first('seq');
  const seq = mine == null ? Number.MAX_SAFE_INTEGER : mine; // no claim of its own: compare with every claim
  const live = 'hash <> ? AND (entry IS NOT NULL OR t >= ?) AND seq < ?'; // hash: skip this run's own claim
  const up = await db.prepare(`SELECT entry, score, sig FROM results WHERE game = ? AND board = ? AND score >= ? AND score <= ? AND sig IS NOT NULL AND ${live} ORDER BY score ASC LIMIT ?`)
    .bind(game, board, score, score * 2, String(hash), t - staleMs, seq, limit).all();
  const down = await db.prepare(`SELECT entry, score, sig FROM results WHERE game = ? AND board = ? AND score < ? AND score >= ? AND sig IS NOT NULL AND ${live} ORDER BY score DESC LIMIT ?`)
    .bind(game, board, score, Math.floor(score / 2), String(hash), t - staleMs, seq, limit).all();
  const top = await db.prepare(`SELECT entry, score, sig FROM results WHERE game = ? AND board = ? AND sig IS NOT NULL AND ${live} ORDER BY score DESC LIMIT ?`)
    .bind(game, board, String(hash), t - staleMs, seq, topK).all();
  let best = null;
  for (const row of [...up.results, ...down.results, ...top.results]) {
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

// One ranked Daily per player per day per game, one accepted run per ticket. The record is one kv row,
// key dailyrun:<day>:<game>:<pid>, value JSON { ticket, rhash, t }. One key covers both rules: a ticket is signed for
// exactly one game, day and player (server/daily.js), so it can only ever be used under its own key; a second run under
// that key with the same ticket is ticket_used, with another ticket daily_done. rhash (the replay's hash) tells the
// same run sent again (an answer lost on the way back) from a second run.
// claimDaily: the atomic claim, after the run checked out: one INSERT OR IGNORE on the key, so of two submits racing
// with the same ticket or player exactly one writes the row. Returns { ok: true, fresh: true } when this submit wrote
// it, { ok: true, fresh: false } when the row is this same run, else { ok: false, code: 'ticket_used' | 'daily_done' }.
const dailyRunKey = ({ game, day, pid }) => `dailyrun:${day}:${game}:${pid}`;
function dailyVerdict(raw, { ticket, rhash }) {
  let row = null; try { row = JSON.parse(raw); } catch { /* unreadable: treat as another run */ }
  if (row && row.ticket === ticket && row.rhash === rhash) return { ok: true, fresh: false };
  if (row && row.ticket === ticket) return { ok: false, code: 'ticket_used' };
  return { ok: false, code: 'daily_done' };
}
export async function claimDaily(db, k) {
  const key = dailyRunKey(k);
  for (let i = 0; i < 2; i++) {
    const r = await db.prepare('INSERT OR IGNORE INTO kv (k, v) VALUES (?, ?)').bind(key, JSON.stringify({ ticket: k.ticket, rhash: k.rhash, t: k.t })).run();
    if (r.meta.changes === 1) return { ok: true, fresh: true };
    const raw = await db.prepare('SELECT v FROM kv WHERE k = ?').bind(key).first('v');
    if (raw != null) return dailyVerdict(raw, k);
    // the row that refused us was given back in between (that submit failed later): try once more
  }
  return { ok: false, code: 'daily_done' };
}
// Give a claim back when the run was not stored after all (duplicate_result, a cap, a failed write). Only our own row.
export async function dropDaily(db, k) {
  await db.prepare("DELETE FROM kv WHERE k = ? AND json_extract(v, '$.ticket') = ? AND json_extract(v, '$.rhash') = ?")
    .bind(dailyRunKey(k), k.ticket, k.rhash).run();
}
// Rows of days before `day` (YYYY-MM-DD) go. Keys sort by day (fixed width), so this is one range of the primary key.
export async function sweepDaily(db, { day }) {
  await db.prepare("DELETE FROM kv WHERE k >= 'dailyrun:' AND k < ?").bind(`dailyrun:${day}`).run();
}

// Held runs still waiting, per player (index flagged_pid) and per address (kv rows
// heldip:<address>:<id>, value '<id>'; one primary-key range per address: ids are digits, ';' sorts right after ':'
// and after every digit, so the range holds exactly this address's rows). A player or address at the cap is refused
// before its run is held, so neither count passes the cap.
const heldPrefix = (ip) => `heldip:${ip}:`;
export async function countHeldBy(db, { pid, ip }) {
  const byPid = await db.prepare("SELECT COUNT(*) AS n FROM flagged WHERE pid = ? AND status = 'flagged'").bind(String(pid)).first('n');
  const p = heldPrefix(ip);
  const byIp = await db.prepare("SELECT COUNT(*) AS n FROM kv JOIN flagged AS f ON f.id = CAST(kv.v AS INTEGER) WHERE kv.k >= ? AND kv.k < ? AND f.status = 'flagged'")
    .bind(p, p.slice(0, -1) + ';').first('n');
  return { pid: byPid ?? 0, ip: byIp ?? 0 };
}
// Hold a near copy only if every cap still has room, as ONE atomic write. The old way read the
// counts, then inserted: 5 copies sent at once all read "2 waiting" and all got in. Here the caps are checked inside
// the INSERT itself (INSERT ... SELECT ... WHERE count < cap), and the address row is written in the same db.batch,
// which D1 runs as one transaction (one SQL transaction on the database's single writer; the local node:sqlite shim
// runs it as BEGIN ... COMMIT with no await in between). So the next hold, from any Worker copy, sees both rows.
// Caps (only runs still waiting count, so a released or expired run frees its slot): `total` over every game,
// `pid` per playerId and `ip` per address, both over every game and day. Returns { id, fresh: true } when this call
// held the run, { id, fresh: false } when the same run (game, board, hash, score) was already held, or null when a cap
// is full (nothing written).
export const HOLD_SQL = 'INSERT INTO flagged (game, board, hash, score, t, status, pid, name, near_entry, near_score, similarity, sig, run) ' +
  "SELECT ?, ?, ?, ?, ?, 'flagged', ?, ?, ?, ?, ?, ?, ? " +
  "WHERE (SELECT COUNT(*) FROM flagged WHERE status = 'flagged') < ? " +
  "AND (SELECT COUNT(*) FROM flagged WHERE pid = ? AND status = 'flagged') < ? " +
  "AND (SELECT COUNT(*) FROM kv JOIN flagged AS f ON f.id = CAST(kv.v AS INTEGER) WHERE kv.k >= ? AND kv.k < ? AND f.status = 'flagged') < ? " +
  'ON CONFLICT(game, board, hash, score) DO NOTHING';
// the address row of the run just held: only for a waiting row with no address row yet (same rule as noteHeldFrom)
const NOTE_SQL = "INSERT OR IGNORE INTO kv (k, v) SELECT ? || f.id, CAST(f.id AS TEXT) FROM flagged AS f WHERE f.game = ? AND f.board = ? AND f.hash = ? AND f.score = ? AND f.status = 'flagged' " +
  "AND NOT EXISTS (SELECT 1 FROM kv AS o WHERE o.k >= 'heldip:' AND o.k < 'heldip;' AND o.v = CAST(f.id AS TEXT))";
export async function holdRunCapped(db, { game, board, hash, score, t, near, sig, run, ip, caps }) {
  const p = heldPrefix(ip), h = String(hash), pid = String(run.playerId);
  const [ins] = await db.batch([
    db.prepare(HOLD_SQL).bind(game, board, h, score, t, pid, String(run.name ?? ''), near.entry ?? null, near.score,
      near.similarity, JSON.stringify(sig), JSON.stringify(run), caps.total, pid, caps.pid, p, p.slice(0, -1) + ';', caps.ip),
    db.prepare(NOTE_SQL).bind(p, game, board, h, score),
  ]);
  const id = await db.prepare('SELECT id FROM flagged WHERE game = ? AND board = ? AND hash = ? AND score = ?').bind(game, board, h, score).first('id');
  if (id == null) return null;
  return { id, fresh: Number(ins?.meta?.changes) === 1 };
}
// Record the address a held run came from (once per held run; the same run sent again keeps its first address).
export async function noteHeldFrom(db, { id, ip }) {
  if (!Number.isSafeInteger(id)) return;
  const owned = await db.prepare("SELECT COUNT(*) AS n FROM kv WHERE k >= 'heldip:' AND k < 'heldip;' AND v = ?").bind(String(id)).first('n');
  if (!owned) await db.prepare('INSERT OR IGNORE INTO kv (k, v) VALUES (?, ?)').bind(heldPrefix(ip) + id, String(id)).run();
}
// Held runs still waiting that were held before `before` (ms) are deleted, then every address row whose run is no
// longer waiting (expired, or released by the owner). Released runs stay in flagged (a record of what went on the
// boards). Returns how many held runs went.
// Both deletes in ONE db.batch (one transaction). flagged.id has no AUTOINCREMENT, so a
// deleted newest id is given to the next held run; with two separate statements a hold landing between them got the
// expired run's id, its address row was refused (the stale heldip:<old address>:<id> row still pointed at that id),
// and the stale row was never cleaned. In one transaction no hold can land between them.
// One read first: when no waiting run is past the age and no address row is orphaned (the usual case), nothing is
// written (no batch, no write cost). Safe to skip: with nothing to delete there is nothing a hold could race with.
const ORPHAN_IP = "SELECT 1 FROM kv WHERE k >= 'heldip:' AND k < 'heldip;' AND NOT EXISTS (SELECT 1 FROM flagged AS f WHERE f.id = CAST(kv.v AS INTEGER) AND f.status = 'flagged')";
const EXPIRE_SQL = ["DELETE FROM flagged WHERE status = 'flagged' AND t < ?",
  "DELETE FROM kv WHERE k >= 'heldip:' AND k < 'heldip;' AND NOT EXISTS (SELECT 1 FROM flagged AS f WHERE f.id = CAST(kv.v AS INTEGER) AND f.status = 'flagged')"];
export async function expireHeld(db, { before }) {
  const work = await db.prepare(`SELECT (EXISTS (SELECT 1 FROM flagged WHERE status = 'flagged' AND t < ?) OR EXISTS (${ORPHAN_IP})) AS n`).bind(before).first('n');
  if (!work) return 0;
  const [r] = await db.batch([db.prepare(EXPIRE_SQL[0]).bind(before), db.prepare(EXPIRE_SQL[1])]);
  return Number(r?.meta?.changes ?? 0);
}
