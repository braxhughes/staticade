// Run the leaderboard Worker locally on Node (no Cloudflare, no wrangler): node server/dev-server.mjs [port=8850] [dbFile=:memory:]
// The database is node:sqlite behind the same D1-shaped calls the Worker uses (server/sqlite-d1.js).
// Try it:  curl -s 'http://127.0.0.1:8850/board?game=starfall'
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sqliteD1 } from './sqlite-d1.js';
import worker from './worker.js';

const port = Number(process.argv[2] || 8850);
const db = sqliteD1(process.argv[3] || ':memory:');
await db.exec(fs.readFileSync(fileURLToPath(new URL('./schema.sql', import.meta.url)), 'utf8'));
// ADMIN_TOKEN: optional, turns on POST /admin/release. DAILY_SECRET: optional, the Daily's seed and tickets come
// from it (at least 32 characters; never commit one: tests make a random one at runtime). Both only from the environment.
const env = { DB: db, ADMIN_TOKEN: process.env.ADMIN_TOKEN, DAILY_SECRET: process.env.DAILY_SECRET || undefined };

http.createServer(async (req, res) => {
  const chunks = [];
  let total = 0;
  for await (const c of req) { total += c.length; if (total > 1 << 24) { res.writeHead(413).end(); return; } chunks.push(c); }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  headers.set('cf-connecting-ip', req.socket.remoteAddress || 'unknown'); // what Cloudflare's edge would set
  const r = await worker.fetch(new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, '127.0.0.1', () => console.log(`leaderboard dev server on http://127.0.0.1:${port}` + (env.DAILY_SECRET ? ' (daily secret set)' : '')));
