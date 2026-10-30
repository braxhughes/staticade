// Fresh-board checks through the real entry point: starfall.html in headless Chrome against the real Worker
// (server/dev-server.mjs), reached through a small counting proxy so a test sees which /board and /submit calls really
// went out. No page.route: Playwright turns the HTTP cache off while a route is set, and the bug is a cache bug.
// the table read after the player's own submit skips the browser cache; ordinary reads keep it.
// the share text carries the server's league, or none before the server answered.
// the table opened again from the menu inside the 10.5 s fresh window still has the player's row.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { staticServer, devServer, openGame, toTitle, playToEntry, shot, until } from './w25-helpers.mjs';

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

// forwards to the dev server, records every request, and can hold /submit answers until release().
// an upstream fetch that fails (a busy machine) is tried once more, then answered 502 (which the
// game treats as a failed read or send and retries), never left as an unhandled rejection.
async function proxy(target) {
  const log = [];
  let hold = false, waiting = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      log.push({ path: req.url, method: req.method, cc: req.headers['cache-control'] || '' });
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type, x-player-id' }); res.end(); return; }
      const body = Buffer.concat(chunks);
      let up, out;
      for (let attempt = 0; attempt < 2 && !out; attempt++) {
        try {
          up = await fetch(target + req.url, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/json', ...(req.headers['x-player-id'] ? { 'x-player-id': req.headers['x-player-id'] } : {}) }, body: body.length ? body : undefined });
          out = Buffer.from(await up.arrayBuffer());
        } catch (e) { up = null; out = null; }
      }
      if (!out) {
        log.push({ path: req.url, method: req.method, failed: true });
        try { res.writeHead(502, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end('{"ok":false,"error":"proxy_upstream"}'); } catch { /* the page went away */ }
        return;
      }
      const send = () => { const h = {}; up.headers.forEach((v, k) => { if (!/^(content-encoding|content-length|transfer-encoding|connection)$/.test(k)) h[k] = v; }); h['access-control-allow-origin'] = '*'; res.writeHead(up.status, h); res.end(out); };
      if (hold && req.url.startsWith('/submit')) waiting.push(send); else send();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, log, server,
    hold(v) { hold = v; }, release() { const w = waiting; waiting = []; hold = false; w.forEach(f => f()); },
    boards() { return log.filter(l => l.path.startsWith('/board') && l.method === 'GET' && !l.failed); } };
}
const clean = (g, name) => assert.deepEqual(g.problems, [], name + ': no page errors');

describe('w29: the table right after your own submit', { concurrency: true }, () => {
  test('MED-1: the new row is on the table at once (not "NO FLIGHTS YET"), a second player sees both rows, ordinary reads stay cached', { timeout: 300000 }, async () => {
    const dev = await devServer();
    const px = await proxy(dev.url);
    try {
      const g = await openGame(browser, web.url, { lb: px.url, tap: false });
      const { page } = g;
      await toTitle(page);
      await until(page, () => SF.table().loaded);
      // ordinary reads: the table's own URL read again twice inside the cache window costs no new request
      const before = px.boards().length;
      await page.evaluate(async () => { await SF.boardScores('all'); await SF.boardScores('all'); });
      assert.equal(px.boards().length, before, 'ordinary board reads are served from the browser cache (server saw none)');
      const run = await playToEntry(page, 'free');
      const mark = px.boards().length;
      await page.evaluate(() => SF.nameEntry('ACE'));
      await until(page, () => SF.lastRemote() && SF.lastRemote().kind === 'ok');
      // the read that follows the accepted submit must show the player's row, in a few seconds, well inside the 10 s cache window
      await page.waitForFunction(() => SF.table().loaded && SF.table().rows === 1, null, { timeout: 5000 });
      const after1 = px.boards().slice(mark);
      assert.ok(after1.length >= 3, 'the three tabs were read again after the submit: ' + after1.length);
      assert.ok(after1.every(l => /[?&]_=\d+/.test(l.path)), 'every post-submit board read carries the one-off param: ' + JSON.stringify(after1.map(l => l.path)));
      assert.ok(after1.every(l => /no-cache|no-store/.test(l.cc)), 'and asks the cache to revalidate: ' + JSON.stringify(after1.map(l => l.cc)));
      await page.waitForTimeout(500);
      await shot(page, 'table-after-submit');
      assert.equal(await page.evaluate(() => SF.table().note), 'RANK 1 ALL-TIME  +750 TROPHIES');
      // a second player (a new browser context, a new player id) submits; their table has both rows
      const g2 = await openGame(browser, web.url, { lb: px.url, tap: false });
      await toTitle(g2.page);
      await until(g2.page, () => SF.table().loaded);
      await playToEntry(g2.page, 'free');
      await g2.page.evaluate(() => SF.nameEntry('BOB'));
      await until(g2.page, () => SF.lastRemote() && SF.lastRemote().kind === 'ok');
      await g2.page.waitForFunction(() => SF.table().loaded && SF.table().rows === 2, null, { timeout: 5000 });
      await shot(g2.page, 'table-second-player');
      assert.equal((await dev.get('/board?game=starfall')).rows.length, 2);
      assert.ok(run.score > 0);
      clean(g, 'first'); clean(g2, 'second');
      await g.ctx.close(); await g2.ctx.close();
    } finally { px.server.close(); await dev.kill(); }
  });

  test('LOW-2: back to the menu and BEST FLIGHT opened again inside 10 s: the new row is still on the table', { timeout: 300000 }, async () => {
    const dev = await devServer();
    const px = await proxy(dev.url);
    try {
      const g = await openGame(browser, web.url, { lb: px.url, tap: false });
      const { page } = g;
      await toTitle(page);
      await until(page, () => SF.table().loaded);
      await playToEntry(page, 'free');
      // a plain (cacheable) read of the all-time board just before the submit: the browser now holds the empty board
      const t0 = Date.now();
      assert.deepEqual(await page.evaluate(() => SF.boardScores('all')), []);
      await page.evaluate(() => SF.nameEntry('ACE'));
      await until(page, () => SF.lastRemote() && SF.lastRemote().kind === 'ok');
      await page.waitForFunction(() => SF.table().loaded && SF.table().rows === 1, null, { timeout: 5000 });
      // back to the main menu with the keyboard, then down to BEST FLIGHT and open it again (keys held a few frames)
      const tap = async (k) => { await page.keyboard.down(k); await page.waitForTimeout(100); await page.keyboard.up(k); await page.waitForTimeout(100); };
      // the title takes keys once it has shown for 20 frames, so Escape is pressed until the menu answers
      for (let i = 0; i < 20 && (await page.evaluate(() => SF.info().page)) !== 'main'; i++) await tap('Escape');
      assert.equal(await page.evaluate(() => SF.info().page), 'main', 'back on the main menu');
      for (let i = 0; i < 8 && (await page.evaluate(() => SF.info().menu)) !== 5; i++) { await tap('ArrowDown'); }
      assert.equal(await page.evaluate(() => SF.info().menu), 5, 'BEST FLIGHT selected');
      const mark = px.boards().length;
      await tap('Enter');
      await page.waitForFunction(() => SF.info().page === 'table', null, { timeout: 5000 });
      const reopened = Date.now() - t0;
      assert.ok(reopened < 9500, `opened again ${reopened} ms after the cached read, inside its 10 s max-age (else the test proves nothing)`);
      // the reopen's reads finish (three tabs), then the row must still be there
      await page.waitForTimeout(1500);
      assert.equal(await page.evaluate(() => SF.table().rows), 1, 'the row is still on the all-time tab (not the cached pre-submit board)');
      const again = px.boards().slice(mark);
      assert.ok(again.length >= 3 && again.every(l => /[?&]_=\d+/.test(l.path)), 'the reopen read the board fresh: ' + JSON.stringify(again.map(l => l.path)));
      await shot(page, 'table-reopened');
      clean(g, 'reopen');
      await g.ctx.close();
    } finally { px.server.close(); await dev.kill(); }
  });

  test('LOW-1: the share text has the server league, and none before the server has answered', { timeout: 300000 }, async () => {
    const dev = await devServer();
    const px = await proxy(dev.url);
    try {
      const g = await openGame(browser, web.url, { lb: px.url, tap: false, perms: ['clipboard-read', 'clipboard-write'] });
      const { page } = g;
      await toTitle(page);
      await playToEntry(page, 'daily');
      px.hold(true); // the server's answer is held
      await page.evaluate(() => SF.nameEntry('ACE'));
      await until(page, () => SF.state === 'title' && SF.table().hint);
      await page.keyboard.press('KeyC');
      await until(page, () => SF.lastShare());
      const early = await page.evaluate(() => SF.lastShare());
      assert.match(early, /^STATICADE Daily (#\d+|\d{4}-\d\d-\d\d) · [\d,]+\nhttp/, 'no league yet: ' + JSON.stringify(early));
      assert.ok(!/Bronze|Silver|Gold|Platinum|Diamond|Master/i.test(early), 'no local league guess: ' + early);
      await shot(page, 'share-before-answer');
      px.release();
      await until(page, () => SF.lastRemote() && SF.lastRemote().kind === 'ok');
      await page.keyboard.press('KeyC');
      await until(page, () => SF.status() === 'COPIED');
      const late = await page.evaluate(() => navigator.clipboard.readText());
      assert.match(late, / · Gold III\n/, 'the server league once it answered: ' + JSON.stringify(late));
      clean(g, 'share');
      await g.ctx.close();
    } finally { px.server.close(); await dev.kill(); }
  });
});
