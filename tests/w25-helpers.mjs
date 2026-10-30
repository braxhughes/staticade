// Shared helpers for the card 3b browser tests (tests/w25-*-browser.test.js): a static server for the game, the real
// leaderboard dev server (server/dev-server.mjs) as a child process that can be killed and started again on the same
// port and database file, and page helpers that drive window.SF. Not a test file itself (no .test.js).
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SHOT_DIR = process.env.W25_SHOT_DIR || null; // set to save the docs/w25 screenshots
export const WAIT = { timeout: 30000 };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

export async function staticServer() {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

export async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

// the real Worker on Node with an on-disk SQLite file, so kill() then start() keeps every stored run
export async function devServer() {
  const port = await freePort();
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'w25-dev-')), 'lb.db');
  const D = { port, db, url: `http://127.0.0.1:${port}`, child: null,
    async start() {
      const child = spawn(process.execPath, [path.join(ROOT, 'server/dev-server.mjs'), String(port), db], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
      D.child = child;
      await new Promise((resolve, reject) => {
        let out = '';
        const t = setTimeout(() => reject(new Error('dev server did not start: ' + out)), 20000);
        child.stdout.on('data', d => { out += d; if (/dev server on/.test(out)) { clearTimeout(t); resolve(); } });
        child.stderr.on('data', d => { out += d; });
        child.on('exit', c => { clearTimeout(t); reject(new Error('dev server exited ' + c + ': ' + out)); });
      }).catch(e => { throw e; });
    },
    async kill() {
      const c = D.child; D.child = null;
      if (!c || c.exitCode !== null) return;
      const gone = new Promise(r => c.once('exit', r));
      c.kill('SIGKILL'); await gone;
    },
    async get(q) { const r = await fetch(D.url + q); return r.json(); }
  };
  await D.start();
  return D;
}

// engine/font.js with a tap that records every string drawn (the s12-guard-gaps technique)
const FONT_SRC = fs.readFileSync(path.join(ROOT, 'engine/font.js'), 'utf8');
const TAP = 'return function text(str, x, y, col, sc, align, a, wave) {';
if (!FONT_SRC.includes(TAP)) throw new Error('engine/font.js no longer has the text() entry the tap wraps');
const FONT_TAPPED = FONT_SRC.replace(TAP, TAP + ' if (window.__texts) window.__texts.add(str);');

// open the game. lb: remote address for ?lb= ('' = no override). init: extra init scripts. perms: browser permissions.
// setup(ctx): called before the page loads (routes for a fake server, extra files)
export async function openGame(browser, staticUrl, { lb = '', init = [], perms = [], tap = true, query = '', setup = null, hasTouch = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 }, hasTouch });
  if (setup) await setup(ctx);
  if (perms.length) await ctx.grantPermissions(perms, { origin: staticUrl.replace(/\/$/, '') });
  if (tap) await ctx.route('**/engine/font.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: FONT_TAPPED }));
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && r.url().startsWith(staticUrl) && !/favicon/.test(r.url())) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  if (tap) await page.addInitScript('window.__texts = new Set();');
  for (const s of init) await page.addInitScript(s);
  const qs = [lb ? 'lb=' + encodeURIComponent(lb) : '', query].filter(Boolean).join('&');
  await page.goto(staticUrl + 'starfall.html' + (qs ? '?' + qs : ''));
  await page.waitForFunction(() => window.SF, null, WAIT);
  return { ctx, page, problems };
}
export const texts = page => page.evaluate(() => [...window.__texts]);
export const clearTexts = page => page.evaluate(() => window.__texts.clear());

export async function toTitle(page) {
  await page.evaluate(() => SF.skip());
  await page.waitForFunction(() => SF.state === 'title', null, WAIT);
  await page.waitForTimeout(500);
}
// a real ranked run (free or today's daily) played to game over by autoFire (recorded like played frames), then
// name entry; returns once the entry screen shows
export async function playToEntry(page, mode = 'free') {
  await page.evaluate(m => SF.mode(m), mode);
  await page.evaluate(() => { let n = 0; while (SF.state === 'intro' && n++ < 1000) SF.autoFire(1); });
  const r = await page.evaluate(() => { let n = 0; while (SF.state !== 'results' && n++ < 400) SF.autoFire(600); return { state: SF.state, score: SF.info().score, ranked: SF.ranked() }; });
  if (r.state !== 'results' || !(r.score > 0) || r.ranked !== true) throw new Error('run did not finish ranked: ' + JSON.stringify(r));
  for (let i = 0; i < 60; i++) {
    if ((await page.evaluate(() => SF.state)) === 'entry') return r;
    await page.keyboard.press('Enter'); await page.waitForTimeout(150);
  }
  throw new Error('never reached name entry');
}
export async function shot(page, name) {
  if (!SHOT_DIR) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') });
}
export const until = (page, fn, arg) => page.waitForFunction(fn, arg, WAIT);
