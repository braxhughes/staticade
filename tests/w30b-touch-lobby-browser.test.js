// w30b: the touch-only LOBBY button on Starfall's pause screen. Through index.html in headless Chrome
// (system Chrome). Touch: a context with touch emulation; tapping LOBBY leaves (nothing submitted), a tap just outside it
// and a tap in the middle resume. Desktop: the button is never drawn and the line is ESC: LOBBY   FIRE: RESUME.
// Screenshots go to W30_SHOT_DIR when it is set (docs/w30).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticServer, WAIT } from './w25-helpers.mjs';

const SHOT_DIR = process.env.W30_SHOT_DIR || null;
// the button's box in field units (400 x 300); games/starfall/render/core.js LOBBY_BOX, hit box = box + 4
const BOX = { x0: 322, x1: 392, y0: 32, y1: 56 };
let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

async function openLobby(touch) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 }, hasTouch: touch });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.goto(web.url + 'index.html');
  await page.waitForFunction(() => window.LOBBY && LOBBY.info().mode === 'lobby', null, WAIT);
  await page.evaluate(() => LOBBY.wordmarkSkip());
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => LOBBY.info().mode === 'gone' && window.SF && SF.away() === false, null, WAIT);
  return { ctx, page, problems };
}
// field units -> CSS px on the canvas (letterboxed, centred)
const client = (page, fx, fy) => page.evaluate(([fx, fy]) => {
  const r = document.getElementById('c').getBoundingClientRect(), s = Math.min(r.width / 400, r.height / 300);
  return { x: r.left + (r.width - 400 * s) / 2 + fx * s, y: r.top + (r.height - 300 * s) / 2 + fy * s };
}, [fx, fy]);
const tapField = async (page, fx, fy) => { const p = await client(page, fx, fy); await page.touchscreen.tap(p.x, p.y); };
const shot = async (page, name) => { if (!SHOT_DIR) return; fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.waitForTimeout(300); await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') }); };
async function intoFreeRun(page) {
  await page.evaluate(() => SF.skip());
  await page.waitForFunction(() => SF.app() === 'title', null, WAIT);
  await page.waitForTimeout(450);
  await page.evaluate(() => SF.mode('free'));
  await page.evaluate(() => { let n = 0; while (SF.state === 'intro' && n++ < 1000) SF.autoFire(1); });
  assert.equal(await page.evaluate(() => SF.runInfo().claimed), true);
}
const pause = async page => { await page.keyboard.press('KeyP'); await page.waitForFunction(() => SF.paused() === true, null, WAIT); await page.waitForTimeout(150); };
const resumed = page => page.waitForFunction(() => SF.paused() === false, null, WAIT);

describe('w30b touch LOBBY button on the pause screen', () => {
  test('touch: the button shows; a tap just outside it and a tap in the middle resume; a tap on it leaves, nothing submitted', { timeout: 120000 }, async () => {
    const { ctx, page, problems } = await openLobby(true);
    try {
      await intoFreeRun(page);
      await tapField(page, 200, 200); // a touch in play: this player uses touch
      await page.waitForTimeout(300); // let that tap's FIRE be read before P (FIRE in the same tick as P would resume at once)
      assert.equal(await page.evaluate(() => SF.touchUi()), true, 'a touch on the canvas marks a touch player');
      await pause(page);
      assert.equal(await page.evaluate(() => SF.lobbyButton()), true, 'touch pause: the LOBBY button is drawn');
      await shot(page, 'pause-touch-lobby-button');
      // near it: 8 units left of the box (outside the 4-unit pad) resumes
      await tapField(page, BOX.x0 - 8, (BOX.y0 + BOX.y1) / 2);
      await resumed(page);
      assert.equal(await page.evaluate(() => LOBBY.info().mode), 'gone', 'a tap next to the button resumes, it does not leave');
      // below it too
      await pause(page);
      await tapField(page, (BOX.x0 + BOX.x1) / 2, BOX.y1 + 10);
      await resumed(page);
      assert.equal(await page.evaluate(() => SF.away()), false);
      // elsewhere: the middle
      await pause(page);
      await tapField(page, 200, 160);
      await resumed(page);
      assert.equal(await page.evaluate(() => SF.away()), false);
      assert.equal(await page.evaluate(() => SF.app()), 'game', 'still in the run');
      // on it: leaves
      await pause(page);
      await tapField(page, (BOX.x0 + BOX.x1) / 2, (BOX.y0 + BOX.y1) / 2);
      await page.waitForFunction(() => LOBBY.info().mode === 'lobby' && SF.away() === true, null, WAIT);
      assert.equal(await page.evaluate(() => SF.paused()), false);
      assert.equal((await page.evaluate(() => SF.scores('all', undefined, false))).length, 0, 'nothing was submitted');
      // and Starfall works again after a touch exit
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => LOBBY.info().mode === 'gone' && SF.away() === false, null, WAIT);
      assert.equal(await page.evaluate(() => SF.runInfo()), null, 'the abandoned run is gone');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('desktop: no button, the ESC line only; a click where the button would be resumes', { timeout: 120000 }, async () => {
    const { ctx, page, problems } = await openLobby(false);
    try {
      await intoFreeRun(page);
      await pause(page);
      assert.equal(await page.evaluate(() => SF.touchUi()), false);
      assert.equal(await page.evaluate(() => SF.lobbyButton()), false, 'desktop pause: the LOBBY button is not drawn');
      await shot(page, 'pause-desktop-no-button');
      const p = await client(page, (BOX.x0 + BOX.x1) / 2, (BOX.y0 + BOX.y1) / 2);
      await page.mouse.click(p.x, p.y);
      await resumed(page);
      assert.equal(await page.evaluate(() => SF.away()), false, 'a click there is FIRE (resume), not lobby');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });
});
