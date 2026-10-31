// A tiny stand-in for a Cloudflare D1 binding, built on node:sqlite. For tests and the local dev server only:
// the Worker never imports this file. It copies the D1 calls the server uses:
//   db.prepare(sql).bind(...values).run() -> { success, meta: { changes, last_row_id } }
//   ... .all() -> { success, results: [rows], meta }     ... .first(column?) -> row | value | null
//   db.batch([statements]) runs them in one transaction; db.exec(sql) runs a script.
// Like D1, every call returns a Promise and values are bound, never pasted into the SQL.
import { DatabaseSync } from 'node:sqlite';

const plain = (row) => (row == null ? null : { ...row });
const ok = (changes = 0, lastId = 0) => ({ success: true, meta: { changes: Number(changes), last_row_id: Number(lastId) } });

class Stmt {
  constructor(db, sql, values = []) { this.db = db; this.sql = sql; this.values = values; }
  bind(...values) {
    for (const v of values) {
      if (v !== null && !['string', 'number', 'bigint'].includes(typeof v)) throw new TypeError('D1 shim: bind only string, number or null');
    }
    return new Stmt(this.db, this.sql, values);
  }
  runSync() {
    const r = this.db.prepare(this.sql).run(...this.values);
    return ok(r.changes, r.lastInsertRowid);
  }
  async run() { return this.runSync(); }
  async all() { const rows = this.db.prepare(this.sql).all(...this.values); return { success: true, results: rows.map(plain), meta: {} }; }
  async first(column) {
    const row = plain(this.db.prepare(this.sql).get(...this.values));
    if (row == null) return null;
    return column === undefined ? row : (row[column] ?? null);
  }
}

// Cloudflare D1's limits where they are lower than SQLite's (https://developers.cloudflare.com/d1/platform/limits/),
// so SQL that D1 would refuse fails here too. compoundSelect: D1 refuses a compound SELECT of more than 5 terms
// ("too many terms in compound SELECT", seen on the real D1; the docs page does not list it). The rest are on that page:
// statement length 100,000 bytes, 100 bound parameters, 100 columns per table, 2 MB string or row, 32 arguments per
// SQL function, 50-byte LIKE or GLOB pattern.
export const D1_LIMITS = Object.freeze({ compoundSelect: 5, sqlLength: 100000, variableNumber: 100, column: 100,
  length: 2000000, functionArg: 32, likePatternLength: 50 });

export function sqliteD1(path = ':memory:') {
  const db = new DatabaseSync(path, { limits: { ...D1_LIMITS } });
  return {
    raw: db,
    prepare: (sql) => new Stmt(db, sql),
    async exec(sql) { db.exec(sql); return { count: 1, duration: 0 }; },
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = stmts.map((s) => (/^\s*select/i.test(s.sql) ? { success: true, results: db.prepare(s.sql).all(...s.values).map(plain) } : s.runSync()));
        db.exec('COMMIT');
        return out;
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    close: () => db.close(),
  };
}
