// Phone screen checks: through the real index.html / starfall.html in headless Chrome, touch emulation.
//   results and name entry are held behind the turn-sideways screen (timers do not count, nothing auto-advances, nothing
//          is submitted), and they carry on once the phone is sideways.
//   the screen is really DRAWN in the lobby and in the game. Read with the font tap (every string the font draws,
//          window.__texts): TURN YOUR PHONE and SIDEWAYS are drawn upright and are not drawn sideways. Not hooks: drawn output.
//   a finger that goes down on the frame the phone turns sideways does not resume the paused run (justHid).
//   the iPad size (820x1180) in the lobby, drawn.
//   zero typed arrays or arrays built per frame at 390x844 (rotate screen, lobby and game) and 844x390 (bezel).
// Screenshots go to W42_SHOT_DIR when it is set.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticServer, WAIT, ROOT } from './w25-helpers.mjs';

const SHOT_DIR = process.env.W42_SHOT_DIR || null;
const FONT_SRC = fs.readFileSync(path.join(ROOT, 'engine/font.js'), 'utf8');
const TAP = 'return function text(str, x, y, col, sc, align, a, wave) {';
if (!FONT_SRC.includes(TAP)) throw new Error('engine/font.js no longer has the text() entry the tap wraps');
const FONT_TAPPED = FONT_SRC.replace(TAP, TAP + ' if (window.__texts) window.__texts.add(str);');

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

// the lobby page (index.html) with the font tap on, at a viewport, touch on or off
async function openLobby(w, h, touch, init = null) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch });
  await ctx.route('**/engine/font.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: FONT_TAPPED }));
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.addInitScript('window.__texts = new Set();');
  if (init) await page.addInitScript(init);
  await page.goto(web.url + 'index.html');
  await page.waitForFunction(() => window.LOBBY && LOBBY.info().mode === 'lobby', null, WAIT);
  await page.evaluate(() => LOBBY.wordmarkSkip());
  return { ctx, page, problems };
}
async function intoRun(page) {
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => LOBBY.info().mode === 'gone' && window.SF && SF.away() === false, null, WAIT);
  await page.evaluate(() => SF.skip());
  await page.waitForFunction(() => SF.app() === 'title', null, WAIT);
  await page.waitForTimeout(450);
  await page.evaluate(() => SF.mode('free'));
  await page.evaluate(() => { let n = 0; while (SF.state === 'intro' && n++ < 1000) SF.autoFire(1); SF.autoFire(240); });
  assert.equal(await page.evaluate(() => SF.runInfo().claimed), true);
}
// play the free run to its end (recorded sim frames, like a played run); the real loop then owns the results screen
const toResults = page => page.evaluate(() => { let n = 0; while (SF.state !== 'results' && n++ < 400) SF.autoFire(600); return { state: SF.state, score: SF.info().score }; });
const shot = async (page, name) => { if (!SHOT_DIR) return; fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.waitForTimeout(300); await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') }); };
const clearTexts = page => page.evaluate(() => window.__texts.clear());
const texts = page => page.evaluate(() => [...window.__texts]);
const upright = (page, w = 390, h = 844) => page.setViewportSize({ width: w, height: h });
const sideways = (page, w = 844, h = 390) => page.setViewportSize({ width: w, height: h });
const ticks = page => page.evaluate(() => SF.ticks());

describe('w42b MED-1 / MED-2 / LOW-3: the turn-sideways screen is really drawn (font tap)', () => {
  test('lobby 390x844 touch: TURN YOUR PHONE and SIDEWAYS are drawn upright, and not drawn sideways', { timeout: 120000 }, async () => {
    const { ctx, page, problems } = await openLobby(390, 844, true);
    try {
      await clearTexts(page); await page.waitForTimeout(500);
      let t = await texts(page);
      assert.ok(t.includes('TURN YOUR PHONE') && t.includes('SIDEWAYS'), 'the lobby draws the rotate screen words upright: ' + JSON.stringify(t));
      await sideways(page);
      await page.waitForFunction(() => LOBBY.rotateShown() === false, null, WAIT);
      await clearTexts(page); await page.waitForTimeout(500);
      t = await texts(page);
      assert.ok(!t.includes('TURN YOUR PHONE') && !t.includes('SIDEWAYS'), 'sideways the lobby does not draw them: ' + JSON.stringify(t));
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('iPad size 820x1180 touch, in the LOBBY: the words are drawn upright, not sideways (1180x820)', { timeout: 120000 }, async () => {
    const { ctx, page, problems } = await openLobby(820, 1180, true);
    try {
      assert.equal(await page.evaluate(() => LOBBY.rotateShown()), true);
      await clearTexts(page); await page.waitForTimeout(500);
      let t = await texts(page);
      assert.ok(t.includes('TURN YOUR PHONE') && t.includes('SIDEWAYS'), 'the iPad lobby draws the rotate screen: ' + JSON.stringify(t));
      await sideways(page, 1180, 820);
      await page.waitForFunction(() => LOBBY.rotateShown() === false, null, WAIT);
      await clearTexts(page); await page.waitForTimeout(500);
      t = await texts(page);
      assert.ok(!t.includes('TURN YOUR PHONE'), 'sideways the iPad lobby does not draw it');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('game 390x844 touch: the words are drawn upright (with YOUR RUN IS PAUSED), and not drawn sideways', { timeout: 150000 }, async () => {
    const { ctx, page, problems } = await openLobby(844, 390, true);
    try {
      await intoRun(page);
      await clearTexts(page); await page.waitForTimeout(400);
      let t = await texts(page);
      assert.ok(!t.includes('TURN YOUR PHONE'), 'sideways in play: not drawn');
      await upright(page);
      await page.waitForFunction(() => SF.rotateShown() === true && SF.paused() === true, null, WAIT);
      await clearTexts(page); await page.waitForTimeout(500);
      t = await texts(page);
      assert.ok(t.includes('TURN YOUR PHONE') && t.includes('SIDEWAYS') && t.includes('YOUR RUN IS PAUSED'), 'the game draws the rotate screen upright: ' + JSON.stringify(t));
      await sideways(page);
      await page.waitForFunction(() => SF.rotateShown() === false, null, WAIT);
      await clearTexts(page); await page.waitForTimeout(500);
      t = await texts(page);
      assert.ok(!t.includes('TURN YOUR PHONE') && !t.includes('SIDEWAYS'), 'sideways the game does not draw them: ' + JSON.stringify(t));
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });
});

describe('w42b MED-3: results and name entry are held behind the screen', () => {
  test('results 390x844: the 900-tick auto-advance does not run behind the screen; sideways it carries on', { timeout: 180000 }, async () => {
    const { ctx, page, problems } = await openLobby(844, 390, true);
    try {
      await intoRun(page);
      const r = await toResults(page);
      assert.equal(r.state, 'results'); assert.ok(r.score > 0);
      await upright(page);
      await page.waitForFunction(() => SF.rotateShown() === true, null, WAIT);
      await page.waitForTimeout(300);
      const t0 = (await ticks(page)).appT;
      assert.ok(t0 < 880, 'the results screen is still young when the screen comes up (' + t0 + ' ticks)');
      await clearTexts(page); await page.waitForTimeout(400);
      assert.ok((await texts(page)).includes('YOUR SCORE WAITS'), 'the screen says the score waits');
      await shot(page, 'results-390x844-held');
      await page.touchscreen.tap(195, 420); // a tap behind the screen: no advance
      await page.waitForTimeout(16500); // more than 900 ticks at 60 Hz
      assert.equal(await page.evaluate(() => SF.state), 'results', 'still on the results screen after 16.5 s upright');
      assert.equal((await ticks(page)).appT, t0, 'the results timer did not count while the screen was up');
      assert.equal(await page.evaluate(() => SF.app()), 'results');
      // sideways: it carries on from where it was, no extra tap
      await sideways(page);
      await page.waitForFunction(() => SF.rotateShown() === false, null, WAIT);
      await page.waitForFunction(a => SF.ticks().appT > a + 20, t0, WAIT);
      assert.equal(await page.evaluate(() => SF.state), 'results', 'it carries on from where it was (not skipped ahead)');
      await shot(page, 'results-844x390-after-turn');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('name entry 390x844: the 1800-tick countdown does not run and nothing is submitted behind the screen; sideways it carries on', { timeout: 240000 }, async () => {
    const { ctx, page, problems } = await openLobby(844, 390, true);
    try {
      await intoRun(page);
      const r = await toResults(page);
      assert.equal(r.state, 'results');
      await page.waitForFunction(() => SF.ticks().appT > 70, null, WAIT);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => SF.state === 'entry', null, WAIT);
      const before = await page.evaluate(() => ({ rows: SF.scores('all', undefined, false).length, sub: SF.lastSubmit() }));
      assert.equal(before.sub, null);
      await upright(page);
      await page.waitForFunction(() => SF.rotateShown() === true, null, WAIT);
      await page.waitForTimeout(300);
      const e0 = (await ticks(page)).entryT;
      assert.ok(e0 < 1700, 'the countdown is young when the screen comes up (' + e0 + ')');
      await clearTexts(page); await page.waitForTimeout(400);
      assert.ok((await texts(page)).includes('YOUR SCORE WAITS'));
      await page.keyboard.type('ZZZ'); // letters typed behind the screen are not taken
      await shot(page, 'entry-390x844-held');
      await page.waitForTimeout(32500); // more than 1800 ticks at 60 Hz
      assert.equal(await page.evaluate(() => SF.state), 'entry', 'still on the name entry after 32.5 s upright');
      assert.equal((await ticks(page)).entryT, e0, 'the countdown did not count');
      const after = await page.evaluate(() => ({ lastSubmit: SF.lastSubmit(), name: SF.nameEntry() }));
      assert.equal(after.lastSubmit, null, 'nothing was submitted');
      assert.notEqual(after.name.name, 'ZZZ', 'the typed letters were not taken');
      assert.equal(await page.evaluate(() => SF.scores('all', undefined, false).length), before.rows, 'the board did not change');
      await sideways(page);
      await page.waitForFunction(() => SF.rotateShown() === false, null, WAIT);
      await page.waitForFunction(a => SF.ticks().entryT > a + 20, e0, WAIT);
      assert.equal(await page.evaluate(() => SF.state), 'entry', 'it carries on from where it was');
      assert.equal(await page.evaluate(() => SF.lastSubmit()), null, 'still nothing submitted');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });
});

describe('w42b LOW-2: a finger that goes down as the phone turns does not resume the run', () => {
  test('game: a tap landing on the turn frame is thrown away (justHid); a later tap resumes', { timeout: 150000 }, async () => {
    const { ctx, page, problems } = await openLobby(844, 390, true);
    try {
      await intoRun(page);
      await upright(page);
      await page.waitForFunction(() => SF.rotateShown() === true && SF.paused() === true, null, WAIT);
      await page.waitForTimeout(300);
      // one synchronous block: the phone "turns" (innerWidth > innerHeight) and a finger taps the canvas, before the next tick runs
      await page.evaluate(() => {
        const c = document.getElementById('c');
        window.__innerW = Object.getOwnPropertyDescriptor(window, 'innerWidth');
        Object.defineProperty(window, 'innerWidth', { configurable: true, get: () => 900 });
        window.__tap = () => {
          const t = new Touch({ identifier: 7, target: c, clientX: 200, clientY: 300 });
          c.dispatchEvent(new TouchEvent('touchstart', { touches: [t], changedTouches: [t], bubbles: true, cancelable: true }));
          c.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [t], bubbles: true, cancelable: true }));
        };
        window.__tap();
      });
      await page.waitForFunction(() => SF.rotateShown() === false, null, WAIT);
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => SF.paused()), true, 'the tap on the turn frame did not resume the run');
      await page.evaluate(() => window.__tap()); // a fresh tap, ticks later: this one resumes
      await page.waitForFunction(() => SF.paused() === false, null, WAIT);
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });
});

describe('w42b LOW-4: no arrays or typed arrays built per frame at phone sizes', () => {
  const COUNT = () => {
    window.__alloc = 0; window.__count = false;
    for (const n of ['Float32Array', 'Array', 'Uint8Array']) {
      const Orig = window[n];
      window[n] = new Proxy(Orig, { construct(t, a, nt) { if (window.__count) window.__alloc++; return Reflect.construct(t, a, nt); } });
    }
  };
  const frames = (page, k) => page.evaluate(k => new Promise(r => { let f = 0; const t = () => { if (++f >= k) r(); else requestAnimationFrame(t); }; requestAnimationFrame(t); }), k);
  const counted = async (page, k) => {
    await page.evaluate(() => { window.__alloc = 0; window.__count = true; });
    await frames(page, k);
    return page.evaluate(() => { window.__count = false; return window.__alloc; });
  };

  test('390x844: the rotate screen over the lobby and over the game; 844x390: the bezel in the game; zero constructions each', { timeout: 180000 }, async () => {
    const { ctx, page, problems } = await openLobby(844, 390, true, COUNT);
    try {
      // lobby, sideways first to hand over to Starfall; the lobby rotate screen is counted before that at 390x844
      await upright(page);
      await page.waitForFunction(() => LOBBY.rotateShown() === true, null, WAIT);
      await frames(page, 30);
      assert.equal(await counted(page, 90), 0, 'lobby, rotate screen: constructions per 90 frames');
      await sideways(page);
      await page.waitForFunction(() => LOBBY.rotateShown() === false, null, WAIT);
      await intoRun(page);
      await upright(page);
      await page.waitForFunction(() => SF.rotateShown() === true && SF.paused() === true, null, WAIT);
      await frames(page, 30);
      assert.equal(await counted(page, 90), 0, 'game, rotate screen: constructions per 90 frames');
      await sideways(page);
      await page.waitForFunction(() => SF.rotateShown() === false, null, WAIT);
      await frames(page, 30);
      assert.ok((await page.evaluate(() => SF.bezelDots())) > 200, 'the bezel is built at 844x390');
      assert.equal(await page.evaluate(() => SF.paused()), true, 'still paused after the turn, so the sim allocates nothing in this count');
      assert.equal(await counted(page, 90), 0, 'game, bezel drawn every frame: constructions per 90 frames');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });
});
