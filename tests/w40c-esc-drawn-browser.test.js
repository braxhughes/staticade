// test the hint that is actually DRAWN, not a hook. engine/font.js gets the same tap as tests/w25-helpers.mjs (every string
// passed to text() lands in window.__texts). Real starfall.html (no lobby) and real index.html (lobby) at 1000x750, headless Chrome.
// The set is cleared right before each screen is looked at, so a string can only come from that screen (door before the coin,
// dolly after it). The coin door draws its hint only while no coin is in; the dolly hint only after.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticServer, WAIT, ROOT } from './w25-helpers.mjs';

const TAP = 'return function text(str, x, y, col, sc, align, a, wave) {';
const FONT = fs.readFileSync(path.join(ROOT, 'engine/font.js'), 'utf8');
if (!FONT.includes(TAP)) throw new Error('engine/font.js no longer has the text() entry the tap wraps');
const FONT_TAPPED = FONT.replace(TAP, TAP + ' if (window.__texts) window.__texts.add(str);');

const DOOR_ALONE = 'FIRE / CLICK: INSERT COIN', DOOR_LOBBY = 'FIRE / CLICK: INSERT COIN   ESC: LOBBY';
const DOLLY_ALONE = 'FIRE: SKIP', DOLLY_LOBBY = 'FIRE: SKIP   ESC: LOBBY';

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

async function open(file) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  await ctx.route('**/engine/font.js*', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: FONT_TAPPED }));
  const page = await ctx.newPage();
  await page.addInitScript('window.__texts = new Set();');
  await page.goto(web.url + file);
  if (file === 'index.html') {
    await page.waitForFunction(() => window.LOBBY && LOBBY.info().mode === 'lobby', null, WAIT);
    await page.evaluate(() => LOBBY.wordmarkSkip());
  }
  return { ctx, page };
}
const atCabinet = page => page.waitForFunction(() => window.SF && SF.app() === 'cabinet' && SF.away() === false, null, WAIT);
const fresh = async page => { await page.evaluate(() => window.__texts.clear()); await page.waitForTimeout(400); };
const drawn = page => page.evaluate(() => [...window.__texts]);

// door screen, then drop the coin (Enter = FIRE) and the dolly screen; returns the strings seen on each
async function bothScreens(page) {
  await fresh(page);
  const door = await drawn(page);
  await page.keyboard.press('Enter');
  await page.evaluate(() => window.__texts.clear());
  await page.waitForTimeout(350);
  const dolly = await drawn(page);
  return { door, dolly };
}

test('standalone starfall.html: nothing drawn on the coin door or the dolly mentions ESC', async () => {
  const { ctx, page } = await open('starfall.html');
  try {
    await atCabinet(page);
    const { door, dolly } = await bothScreens(page);
    assert.ok(door.includes(DOOR_ALONE), 'door draws the plain hint, saw ' + JSON.stringify(door));
    assert.ok(dolly.includes(DOLLY_ALONE), 'dolly draws the plain hint, saw ' + JSON.stringify(dolly));
    assert.ok(!door.includes(DOLLY_ALONE), 'dolly string is not on the door');
    for (const s of door.concat(dolly)) assert.ok(!/ESC/.test(s), 'drawn string mentions ESC: ' + s);
  } finally { await ctx.close(); }
});

test('arcade index.html: door draws ESC: LOBBY, dolly draws ESC: LOBBY, also on a second entry', async () => {
  const { ctx, page } = await open('index.html');
  try {
    for (let visit = 0; visit < 2; visit++) {
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => LOBBY.info().mode === 'gone', null, WAIT);
      await atCabinet(page);
      const { door, dolly } = await bothScreens(page);
      assert.ok(door.includes(DOOR_LOBBY), 'visit ' + visit + ' door, saw ' + JSON.stringify(door));
      assert.ok(!door.includes(DOOR_ALONE), 'visit ' + visit + ' door has no plain hint');
      assert.ok(dolly.includes(DOLLY_LOBBY), 'visit ' + visit + ' dolly, saw ' + JSON.stringify(dolly));
      assert.ok(!dolly.includes(DOLLY_ALONE), 'visit ' + visit + ' dolly has no plain hint');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => LOBBY.info().mode === 'lobby' && SF.away() === true, null, WAIT);
    }
  } finally { await ctx.close(); }
});
