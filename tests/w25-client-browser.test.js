// The remote board client through the real entry point: starfall.html in headless Chrome (Playwright, system Chrome)
// against the real leaderboard Worker (server/dev-server.mjs, SQLite file), remote switch pointed at it with the
// test-only ?lb= override. Real runs are played to game over (autoFire records them like played frames).
// Scope items: 1 local first, 2 queue + exactly once, 3 ranked daily kept, 8 rating line, 9 share, 10 switch.
// The mocked server states (wrong_version, held, 5xx, timeout, OFFLINE board...) are tests/w25-states-browser.test.js.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticServer, devServer, openGame, toTitle, playToEntry, shot, texts, until, ROOT } from './w25-helpers.mjs';
import { dailyNumber, fmtScore } from '../games/starfall/modes.js';
import { ARCADE_NAME } from '../arcade/brand.js';

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });
const clean = (p, name) => assert.deepEqual(p.problems, [], name + ': no page errors (failed requests to the leaderboard aside)');
const BAD_TEXT = /null|undefined|nan/i;
const today = () => new Date().toISOString().slice(0, 10);

describe('card 3b against the real dev server', { concurrency: true }, () => {
  test('local first, then the server; rating line; accepted run never re-sent; bad_name shown once', async () => {
    const dev = await devServer();
    try {
      const g = await openGame(browser, web.url, { lb: dev.url });
      const { page } = g;
      assert.equal(await page.evaluate(() => SF.remote()), dev.url, 'the override points the game at the dev server');
      let localAtSend = null, localAtSend2 = null, sends = 0, accepted = 0;
      page.on('response', r => { if (r.url() === dev.url + '/submit' && r.status() === 201) accepted++; });
      await page.route(dev.url + '/submit', async route => {
        sends++;
        if (localAtSend === null) localAtSend = await page.evaluate(() => SF.scores('all'));
        else if (localAtSend2 === null) localAtSend2 = await page.evaluate(() => SF.scores('all', undefined, false)); // every saved run
        await route.continue();
      });
      await toTitle(page);
      const run = await playToEntry(page, 'free');
      const res = await page.evaluate(() => SF.nameEntry('ACE'));
      assert.ok(res && res.id, 'saved on this device');
      await until(page, () => SF.lastRemote() && SF.lastRemote().kind !== null);
      const lr = await page.evaluate(() => SF.lastRemote());
      assert.equal(lr.kind, 'ok', JSON.stringify(lr));
      assert.equal(localAtSend.length, 1, 'scope 1: the local board had the run before the network call');
      assert.equal(localAtSend[0].name, 'ACE');
      assert.equal(await page.evaluate(() => SF.queue().length), 0);
      const board = await dev.get('/board?game=starfall');
      assert.deepEqual(board.rows.map(r => [r.name, r.score]), [['ACE', run.score]], 'on the server board once');
      // Best-5 rating line from the server's answer: league and tier, best-5 average, percentile
      const st = await page.evaluate(() => SF.status());
      assert.match(st, /^ONLINE: BEST 5 AVG \d+  TOP \d+%$/);
      await until(page, () => SF.table().loaded && SF.table().rows === 1);
      const tb = await page.evaluate(() => SF.table());
      assert.equal(tb.summary, 'GOLD III  750 TROPHIES');
      assert.equal(tb.note, 'RANK 1 ALL-TIME  +750 TROPHIES');
      await page.waitForTimeout(400);
      const drawn = await texts(page);
      assert.ok(drawn.includes(st) && drawn.includes('GOLD III  750 TROPHIES'), 'rating line drawn');
      assert.deepEqual(drawn.filter(s => BAD_TEXT.test(s)), [], 'nothing drawn says null, undefined or NaN');
      await shot(page, 'rating-line');
      // an accepted run is never sent again: flush, then a reload (the queue is read again on load)
      await page.evaluate(() => SF.flushQueue(true));
      await page.reload(); await page.waitForFunction(() => window.SF);
      await page.waitForTimeout(2500);
      assert.equal(sends, 1, 'one send for one accepted run');
      assert.equal(accepted, 1);
      // a refusal the server makes for real (blocked name): the run stays on this device, the queue drops it, shown once
      await toTitle(page);
      await playToEntry(page, 'free');
      await page.evaluate(() => SF.nameEntry('WTF'));
      await until(page, () => SF.lastRemote() && SF.lastRemote().code === 'bad_name');
      assert.equal(await page.evaluate(() => SF.status()), 'NOT SENT: BAD NAME');
      assert.equal(await page.evaluate(() => SF.queue().length), 0);
      // the local board keeps one best entry per player, so a run that scores no better than ACE's never shows there.
      // The refused run is proved saved by the store of every run (unique false), and it was already there when the request went out.
      assert.ok(localAtSend2 && localAtSend2.some(r => r.name === 'WTF'), 'the refused run was saved locally before the request');
      assert.ok((await page.evaluate(() => SF.scores('all', undefined, false))).some(r => r.name === 'WTF'), 'kept in the local store');
      await page.evaluate(() => SF.flushQueue(true));
      assert.equal(sends, 2, 'a refused run is sent once');
      clean(g, 'submit');
      await g.ctx.close();
    } finally { await dev.kill(); }
  });

  test('kill the server before the send, then bring it back: the ranked daily is queued, stays ranked, arrives once by itself', async () => {
    const dev = await devServer();
    try {
      const g = await openGame(browser, web.url, { lb: dev.url });
      const { page } = g;
      let accepted = 0;
      page.on('response', r => { if (r.url() === dev.url + '/submit' && r.status() === 201) accepted++; });
      await toTitle(page);
      const run = await playToEntry(page, 'daily');
      await dev.kill();
      const res = await page.evaluate(() => SF.nameEntry('ACE'));
      assert.ok(res && res.id, 'saved on this device while the server is down');
      await until(page, () => SF.lastRemote() && SF.lastRemote().kind === 'retry');
      const q = await page.evaluate(() => SF.queue());
      assert.equal(q.length, 1);
      assert.equal(q.items[0].mode, 'daily', 'the ranked daily is queued as a daily');
      assert.equal(q.items[0].dayKey, today());
      assert.equal(q.items[0].code, 'offline');
      assert.equal(await page.evaluate(() => SF.ranked()), true, 'still the ranked attempt');
      assert.equal(await page.evaluate(() => SF.status()), 'OFFLINE: 1 RUN SAVED HERE, WILL RETRY');
      assert.equal((await page.evaluate(d => SF.scores('daily', d), today())).length, 1, 'on the local day board');
      await page.waitForTimeout(500);
      await shot(page, 'queued-retrying');
      await dev.start();
      // no manual flush: the backoff timer sends it (5 s after the failure)
      await page.waitForFunction(() => SF.queue().length === 0, null, { timeout: 30000 });
      assert.equal((await page.evaluate(() => SF.lastRemote())).kind, 'ok');
      const day = await dev.get('/board?game=starfall&board=daily&key=' + today());
      assert.deepEqual(day.rows.map(r => [r.name, r.score]), [['ACE', run.score]], 'the ranked daily is on the server day board once');
      await page.evaluate(() => SF.flushQueue(true));
      assert.equal(accepted, 1, 'accepted once');
      clean(g, 'kill');
      await g.ctx.close();
    } finally { await dev.kill(); }
  });

  test('kill the server after it stored the run (answer lost): the resend is a duplicate, the run is on the board once', async () => {
    const dev = await devServer();
    try {
      const g = await openGame(browser, web.url, { lb: dev.url });
      const { page } = g;
      let lose = true, sends = 0;
      await page.route(dev.url + '/submit', async route => {
        sends++;
        if (!lose) return route.continue();
        lose = false;
        await route.fetch(); // the server stores the run and answers 201 ...
        await dev.kill();    // ... and dies before the answer reaches the page
        await route.abort('connectionreset');
      });
      await toTitle(page);
      const run = await playToEntry(page, 'daily');
      await page.evaluate(() => SF.nameEntry('ACE'));
      await until(page, () => SF.lastRemote() && SF.lastRemote().kind === 'retry');
      assert.equal(await page.evaluate(() => SF.queue().length), 1);
      await dev.start();
      await page.evaluate(() => window.dispatchEvent(new Event('online'))); // back online: send now, not after the backoff
      await until(page, () => SF.queue().length === 0);
      assert.equal((await page.evaluate(() => SF.lastRemote())).kind, 'dup');
      assert.equal(await page.evaluate(() => SF.status()), 'ALREADY SAVED ONLINE');
      assert.equal(sends, 2);
      const all = await dev.get('/board?game=starfall');
      assert.deepEqual(all.rows.map(r => [r.name, r.score]), [['ACE', run.score]]);
      const day = await dev.get('/board?game=starfall&board=daily&key=' + today());
      assert.equal(day.rows.length, 1, 'the ranked daily counted once');
      clean(g, 'lost answer');
      await g.ctx.close();
    } finally { await dev.kill(); }
  });

  test('share my daily: C copies "<ARCADE_NAME> Daily #n · score · league" and the link', async () => {
    const dev = await devServer();
    try {
      const g = await openGame(browser, web.url, { lb: dev.url, perms: ['clipboard-read', 'clipboard-write'] });
      const { page } = g;
      await toTitle(page);
      const run = await playToEntry(page, 'daily');
      await page.evaluate(() => SF.nameEntry('ACE'));
      await until(page, () => SF.lastRemote() && SF.lastRemote().kind === 'ok');
      assert.equal(await page.evaluate(() => SF.table().hint), 'UP DOWN: BOARD   C: SHARE   FIRE: BACK');
      await page.keyboard.press('KeyC');
      await until(page, () => SF.status() === 'COPIED');
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      const n = dailyNumber(today());
      assert.equal(clip, `${ARCADE_NAME} Daily ${n ? '#' + n : today()} · ${fmtScore(run.score)} · Gold III\n${web.url}starfall.html`);
      assert.ok(!clip.includes('lb='), 'the test override is not in the shared link');
      await shot(page, 'share-copied');
      clean(g, 'share');
      await g.ctx.close();
    } finally { await dev.kill(); }
  });

  test('share: clipboard refused shows the text on screen; the arcade name comes from arcade/brand.js', async () => {
    const brand = fs.readFileSync(path.join(ROOT, 'arcade/brand.js'), 'utf8').replace(/ARCADE_NAME = '[^']*'/, "ARCADE_NAME = 'TEST CADE'");
    const g = await openGame(browser, web.url, { init: ["navigator.clipboard.writeText = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));"] });
    const { page } = g;
    await g.ctx.route('**/arcade/brand.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: brand }));
    await page.reload(); await page.waitForFunction(() => window.SF);
    await toTitle(page);
    const run = await playToEntry(page, 'daily');
    await page.evaluate(() => SF.nameEntry('ACE'));
    await until(page, () => SF.state === 'title' && SF.info().page === 'table');
    await page.keyboard.press('KeyC');
    await until(page, () => SF.status() === 'COPY REFUSED: TEXT ABOVE');
    const share = await page.evaluate(() => SF.table().share);
    assert.equal(share[0], `TEST CADE DAILY ${dailyNumber(today()) ? 'NO.' + dailyNumber(today()) : today()} - ${fmtScore(run.score)} - GOLD III`);
    assert.equal(share[1], web.url.replace(/^http:\/\//, '').toUpperCase() + 'STARFALL.HTML');
    assert.match(await page.evaluate(() => SF.lastShare()), /^TEST CADE Daily /);
    await page.waitForTimeout(300);
    const drawn = await texts(page);
    assert.ok(drawn.includes(share[0]) && drawn.includes(share[1]), 'the share text is drawn');
    await shot(page, 'share-refused');
    clean(g, 'share refused');
    await g.ctx.close();
  });

  test('remote switch off (default): no network beyond the page, behaviour as before; only localhost overrides count', async () => {
    const g = await openGame(browser, web.url);
    const { page } = g;
    const foreign = [];
    page.on('request', r => { if (!r.url().startsWith(web.url)) foreign.push(r.url()); });
    assert.equal(await page.evaluate(() => SF.remote()), '');
    await toTitle(page);
    await playToEntry(page, 'free');
    const res = await page.evaluate(() => SF.nameEntry('ACE'));
    assert.ok(res && res.id);
    assert.match(await page.evaluate(() => SF.table().note), /^RANK 1 ALL-TIME  /, 'the local result line as before');
    assert.equal(await page.evaluate(() => SF.status()), '');
    assert.equal(await page.evaluate(() => SF.queue().length), 0);
    assert.deepEqual(foreign, []);
    clean(g, 'off');
    await g.ctx.close();
    for (const [lb, want] of [['https://evil.example.com', ''], ['http://evil.example.com:80', ''], ['http://localhost:9', 'http://localhost:9']]) {
      const h = await openGame(browser, web.url, { lb, tap: false });
      assert.equal(await h.page.evaluate(() => SF.remote()), want, lb);
      await h.ctx.close();
    }
  });
});
