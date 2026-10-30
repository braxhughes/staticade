// The Daily through the real entry point: starfall.html in headless Chrome (Playwright, system Chrome)
// against the real Worker (server/dev-server.mjs) started with a DAILY_SECRET made at random for this run.
// 1. DAILY FLIGHT asks the board: the run uses the server's seed (not the public one) and ticket, is played at real
//    speed (the server refuses a run longer than the time since its ticket), is accepted and lands on the day board.
// 2. The board does not answer: DAILY NEEDS THE BOARD: OFFLINE, no daily starts, FIRE gives free play.
// 3. Remote board off: the local daily on the public seed, as before.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { staticServer, devServer, freePort, openGame, toTitle, shot, texts, until, WAIT } from './w25-helpers.mjs';
import { dailySeed } from '../engine/rng.js';

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });
const clean = (p, name) => assert.deepEqual(p.problems, [], name + ': no page errors (failed requests to the leaderboard aside)');
const today = () => new Date().toISOString().slice(0, 10);

describe('card 3c daily from the board', { concurrency: true }, () => {
  test('secret set: the daily uses the server seed and ticket, is played at real speed, accepted, and on the day board', { timeout: 300000 }, async () => {
    const secret = randomBytes(32).toString('hex');
    process.env.DAILY_SECRET = secret; // the child copies the environment when it starts
    let dev;
    try { dev = await devServer(); } finally { delete process.env.DAILY_SECRET; }
    try {
      assert.equal((await dev.get('/daily?game=starfall')).error, 'bad_player', 'the dev server runs with the secret (a ticket needs a player)');
      const g = await openGame(browser, web.url, { lb: dev.url });
      const { page } = g;
      await toTitle(page);
      const day = today();
      const want = createHmac('sha256', secret).update(`daily:starfall:${day}`).digest().readUInt32BE(0);
      assert.equal(await page.evaluate(() => SF.mode('daily')), 'daily');
      const info = await page.evaluate(() => SF.runInfo());
      assert.equal(info.mode, 'daily');
      assert.equal(info.dayKey, day);
      assert.equal(info.seed, want, 'the server seed');
      assert.notEqual(info.seed, dailySeed(day), 'never the public seed online');
      assert.equal(info.fromServer, true);
      assert.match(info.ticket, /^[0-9a-z]+\.[A-Za-z0-9_-]{43}$/);
      assert.equal(await page.evaluate(() => SF.seed()), want, 'the sim runs on it');
      const issuedAt = parseInt(info.ticket.split('.')[0], 36);
      await page.waitForTimeout(600);
      await shot(page, 'daily-server-seed');
      // played at real speed with the keyboard (the server refuses a run longer than the time since its ticket):
      // fire tapped all the time, the ship swept left and right
      let r;
      const t0 = Date.now();
      await page.keyboard.down('ArrowLeft');
      for (let n = 0; Date.now() - t0 < 240000; n++) {
        r = await page.evaluate(() => ({ state: SF.state, frames: SF.info().frames, score: SF.info().score, ranked: SF.ranked() }));
        if (r.state === 'results' || r.state === 'entry') break;
        if (n === 30) await shot(page, 'daily-server-run'); // a few seconds in: the daily label on the run
        if (n % 8 === 0) { const left = (n / 8) % 2 === 0; await page.keyboard.up(left ? 'ArrowLeft' : 'ArrowRight'); await page.keyboard.down(left ? 'ArrowRight' : 'ArrowLeft'); }
        await page.keyboard.down('Space'); await page.waitForTimeout(120); await page.keyboard.up('Space'); await page.waitForTimeout(30);
      }
      await page.keyboard.up('ArrowLeft'); await page.keyboard.up('ArrowRight');
      const secs = (Date.now() - issuedAt) / 1000;
      assert.ok(r.frames / 60 <= secs + 10, `played no faster than real time (${r.frames} frames in ${secs.toFixed(1)} s)`);
      assert.ok(r.score > 0 && r.ranked === true, 'the run finished ranked: ' + JSON.stringify(r));
      for (let i = 0; i < 60 && (await page.evaluate(() => SF.state)) !== 'entry'; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(150); }
      assert.equal(await page.evaluate(() => SF.state), 'entry');
      const saved = await page.evaluate(() => SF.nameEntry('ACE'));
      assert.ok(saved && saved.id, 'saved on this device first');
      await until(page, () => SF.lastRemote() && SF.lastRemote().kind !== null);
      const lr = await page.evaluate(() => SF.lastRemote());
      assert.equal(lr.kind, 'ok', JSON.stringify(lr));
      const board = await dev.get(`/board?game=starfall&board=daily&key=${day}`);
      assert.deepEqual(board.rows.map(x => [x.name, x.score]), [['ACE', r.score]], 'on the server day board');
      assert.equal((await page.evaluate(d => SF.scores('daily', d), day)).length, 1, 'and on the local day board');
      clean(g, 'secret daily');
    } finally { await dev.kill(); }
  });

  test('the board does not answer /daily: DAILY NEEDS THE BOARD: OFFLINE, no daily starts, FIRE gives free play', async () => {
    const dead = `http://127.0.0.1:${await freePort()}`; // nothing listens there
    const g = await openGame(browser, web.url, { lb: dead });
    const { page } = g;
    await toTitle(page);
    await page.keyboard.press('ArrowDown'); await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => SF.info().menu), 1, 'DAILY FLIGHT selected');
    await page.keyboard.press('Enter');
    await until(page, () => SF.dailyOff() !== '');
    assert.equal(await page.evaluate(() => SF.dailyOff()), 'DAILY NEEDS THE BOARD: OFFLINE');
    assert.equal(await page.evaluate(() => SF.state), 'title');
    assert.equal(await page.evaluate(() => SF.runInfo()), null, 'no run started, so no public-seed daily');
    await page.waitForTimeout(500);
    const drawn = await texts(page);
    assert.ok(drawn.includes('DAILY NEEDS THE BOARD: OFFLINE'), 'drawn on screen');
    assert.ok(drawn.includes('FIRE: FREE PLAY'));
    await shot(page, 'daily-offline');
    assert.equal(await page.evaluate(() => SF.mode('daily')), null, 'asked again (hook): still no daily');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => SF.runInfo() !== null, null, WAIT);
    assert.equal(await page.evaluate(() => SF.runInfo().mode), 'free', 'FIRE: free play');
    clean(g, 'offline daily');
  });

  test('remote board off: the local daily on the public seed, exactly as before', async () => {
    const g = await openGame(browser, web.url);
    const { page } = g;
    await toTitle(page);
    assert.equal(await page.evaluate(() => SF.mode('daily')), 'daily');
    const info = await page.evaluate(() => SF.runInfo());
    const day = today();
    assert.deepEqual([info.mode, info.dayKey, info.seed, info.ticket, info.fromServer], ['daily', day, dailySeed(day), null, false]);
    clean(g, 'local daily');
  });
});
