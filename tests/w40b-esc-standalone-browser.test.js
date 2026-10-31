// the cabinet only promises ESC: LOBBY where a lobby exists. Real starfall.html (no lobby) and real index.html (lobby,
// Enter on the Starfall cabinet, twice) at 1000x750 in headless Chrome. Hints are read from the page's own cabinet (SF.cabinetHints).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { staticServer, WAIT } from './w25-helpers.mjs';

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

async function open(file, opts = { viewport: { width: 1000, height: 750 } }) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.goto(web.url + file);
  if (file === 'index.html') {
    await page.waitForFunction(() => window.LOBBY && LOBBY.info().mode === 'lobby', null, WAIT);
    await page.evaluate(() => LOBBY.wordmarkSkip());
  }
  return { ctx, page };
}
const enter = async page => {
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => LOBBY.info().mode === 'gone' && window.SF && SF.away() === false && SF.app() === 'cabinet', null, WAIT);
  await page.waitForTimeout(300);
};

test('standalone starfall.html: no hint mentions ESC', async () => {
  const { ctx, page } = await open('starfall.html');
  try {
    await page.waitForFunction(() => window.SF && SF.app() === 'cabinet', null, WAIT);
    const h = await page.evaluate(() => SF.cabinetHints());
    assert.equal(h.door, 'FIRE / CLICK: INSERT COIN');
    assert.equal(h.dolly, 'FIRE: SKIP');
    assert.ok(!/ESC/.test(h.door + h.dolly));
  } finally { await ctx.close(); }
});

test('arcade index.html: both hints say ESC: LOBBY, also on a second entry (decided at draw time)', async () => {
  const { ctx, page } = await open('index.html');
  try {
    for (let visit = 0; visit < 2; visit++) {
      await enter(page);
      const h = await page.evaluate(() => SF.cabinetHints());
      assert.equal(h.door, 'FIRE / CLICK: INSERT COIN   ESC: LOBBY', 'visit ' + visit);
      assert.equal(h.dolly, 'FIRE: SKIP   ESC: LOBBY', 'visit ' + visit);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => LOBBY.info().mode === 'lobby' && SF.away() === true, null, WAIT);
    }
  } finally { await ctx.close(); }
});
