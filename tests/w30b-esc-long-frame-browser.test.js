// w30b: the w30 review HIGH. loop.stop() only stops the next rAF; the steps the current frame already bought still run.
// If Esc is read on a long frame, the rest of that frame's ticks ran with Starfall gone: the finished cabinet intro
// called end() -> setApp('title') -> Starfall's title music over the lobby, and its audio context kept running.
// This reaches the title the real way (coin into the cabinet, not SF.skip()), then presses Esc inside a rAF callback
// that blocks about 120 ms, so the next frame runs several ticks. Index.html in headless Chrome (system Chrome).
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

// every audio context made, tagged when Starfall's code made it, and a count of sources started on each
const INIT = `(() => {
  const ctxs = []; window.__ctxs = ctxs; window.__src = [];
  const AC = window.AudioContext;
  window.AudioContext = class extends AC { constructor(...a) { super(...a); this.__sf = /games\\/starfall\\//.test(new Error().stack || ''); ctxs.push(this); window.__src.push(0); } };
  const st = AudioScheduledSourceNode.prototype.start;
  AudioScheduledSourceNode.prototype.start = function (...a) { const i = ctxs.indexOf(this.context); if (i >= 0) window.__src[i]++; return st.apply(this, a); };
  window.__sfAudio = () => { const i = ctxs.findIndex(c => c.__sf); return i < 0 ? null : { state: ctxs[i].state, src: window.__src[i] }; };
})();`;

test('Esc on a long frame after a real coin: no Starfall tick, render, music or running audio after leaving (3 trips)', { timeout: 180000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  try {
    await page.addInitScript(INIT);
    await page.goto(web.url + 'index.html');
    await page.waitForFunction(() => window.LOBBY && LOBBY.info().mode === 'lobby', null, WAIT);
    await page.evaluate(() => LOBBY.wordmarkSkip());
    for (let trip = 0; trip < 3; trip++) {
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => LOBBY.info().mode === 'gone' && window.SF && SF.away() === false && SF.app() === 'cabinet', null, WAIT);
      await page.waitForTimeout(500);
      await page.keyboard.press('Space'); // the coin
      await page.waitForFunction(() => SF.app() === 'title', null, { timeout: 60000 });
      await page.waitForTimeout(800); // the title takes keys after 20 frames
      assert.ok(await page.evaluate(() => SF.audio().track), `trip ${trip + 1}: sanity, the title music plays before leaving`);
      // Esc read on the next frame, and this rAF callback blocks ~120 ms so that frame buys about 7 steps
      await page.evaluate(() => new Promise(res => requestAnimationFrame(() => {
        dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape' }));
        dispatchEvent(new KeyboardEvent('keyup', { code: 'Escape', key: 'Escape' }));
        const t = performance.now(); while (performance.now() - t < 120) {}
        res();
      })));
      await page.waitForFunction(() => LOBBY.info().mode === 'lobby' && SF.away() === true, null, WAIT);
      await page.waitForTimeout(300);
      const early = await page.evaluate(() => ({ app: SF.app(), src: __sfAudio() }));
      await page.waitForTimeout(1200); // 1.5 s after leaving
      const late = await page.evaluate(() => ({ app: SF.app(), track: SF.audio().track, sf: __sfAudio(), info: SF.info ? SF.info().page : null }));
      const msg = `trip ${trip + 1}: ` + JSON.stringify({ early, late });
      assert.equal(early.app, 'cabinet', msg + ' (leaving parks Starfall on the cabinet; a stray tick would end the intro to the title)');
      assert.equal(late.app, 'cabinet', msg + ' Starfall app unchanged by ticks after leaving');
      assert.equal(late.track, null, msg + ' no Starfall music track');
      assert.ok(late.sf, msg + ' sanity: Starfall made an audio context');
      assert.notEqual(late.sf.state, 'running', msg + ' Starfall audio context not running');
      assert.equal(late.sf.src, early.src.src, msg + ' no Starfall sources started after leaving');
    }
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});
