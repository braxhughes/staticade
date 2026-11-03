// the touch PAUSE button in Starfall. Through starfall.html in headless Chrome (system Chrome) with real dispatched
// TouchEvents (and Playwright taps), as the other touch tests do.
//   placement: inside the right bezel strip and outside the playfield at 844x390, 932x430, 667x375, 568x320; in the field's
//              top-right corner (no strip) at 1000x750 and the iPad 1180x820; at least 44x44 CSS px; null on desktop.
//   behaviour: a tap on it pauses (the same pause as P); a tap elsewhere steers and does not pause; a finger that starts on it
//              never steers, fires or kindles (read from the RECORDED input words, not a hook); a finger that starts elsewhere
//              and slides onto it keeps steering and does not pause; a second finger on it while steering pauses on lift and
//              never kindles.
//   replay:    a touch run paused by the button and resumed records a replay that re-simulates to the live hash.
//   alloc:     no arrays or typed arrays built per frame while the button is drawn (the usual Proxy count).
// Screenshots go to W53_SHOT_DIR when it is set.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticServer, WAIT } from './w25-helpers.mjs';
import { decode } from '../engine/replay.js';
import { IDLE_WORD, W_FIRE, W_FIRE_PRESS, W_ALT_PRESS, W_TOUCH } from '../engine/input-word.js';
import { resim } from '../tools/resim.mjs';

const SHOT_DIR = process.env.W53_SHOT_DIR || null;
let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

// starfall.html at a viewport; touch on or off. init: an extra init script
async function open(w, h, touch, init = null) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  if (init) await page.addInitScript(init);
  await page.goto(web.url + 'starfall.html');
  await page.waitForFunction(() => window.SF, null, WAIT);
  return { ctx, page, problems };
}
// a free run past the intro (frames recorded like played ones); the real loop owns it from here
async function intoRun(page) {
  await page.evaluate(() => SF.skip());
  await page.waitForFunction(() => SF.app() === 'title', null, WAIT);
  await page.waitForTimeout(450);
  await page.evaluate(() => SF.mode('free'));
  await page.evaluate(() => { let n = 0; while (SF.state === 'intro' && n++ < 1000) SF.autoFire(1); });
  assert.equal(await page.evaluate(() => SF.runInfo().claimed), true);
}
// one TouchEvent on the canvas. touches / changed: arrays of [id, x, y]
const touch = (page, type, touches, changed) => page.evaluate(([type, touches, changed]) => {
  const c = document.getElementById('c');
  const mk = ([id, x, y]) => new Touch({ identifier: id, target: c, clientX: x, clientY: y });
  c.dispatchEvent(new TouchEvent(type, { touches: touches.map(mk), targetTouches: touches.map(mk), changedTouches: changed.map(mk), bubbles: true, cancelable: true }));
}, [type, touches, changed]);
const centre = b => [b.x + b.w / 2, b.y + b.h / 2];
const btn = page => page.evaluate(() => SF.pauseButton());
const frames = page => page.evaluate(() => SF.info().frames);
const shot = async (page, name) => { if (!SHOT_DIR) return; fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.waitForTimeout(300); await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') }); };
// the recorded input words of the live run, sim frames [a, b)
const words = async (page, a, b) => decode(await page.evaluate(() => SF.replay())).words.slice(a, b);
const idleWords = ws => ws.every(w => w === IDLE_WORD);
// a first tap anywhere in the field marks a touch player (the pause button then shows); it records a few touch words
const markTouch = async (page, w, h) => { await page.touchscreen.tap(w / 2, h * 0.7); await page.waitForTimeout(250); };
// the LOBBY button on the pause screen (field box 322..392 x 32..56) as a CSS px point
const lobbyCentre = page => page.evaluate(() => {
  const r = document.getElementById('c').getBoundingClientRect(), s = Math.min(r.width / 400, r.height / 300);
  return [r.left + (r.width - 400 * s) / 2 + 357 * s, r.top + (r.height - 300 * s) / 2 + 44 * s];
});
// the playfield's right edge in CSS px (400 x 300 letterboxed, centred)
const fieldRight = (w, h) => { const s = Math.min(w / 400, h / 300); return (w - 400 * s) / 2 + 400 * s; };

describe('w53 placement', () => {
  for (const [w, h] of [[844, 390], [932, 430], [667, 375], [568, 320]]) {
    test(`${w}x${h} touch, in play: the button is in the right strip, outside the playfield, at least 44x44`, { timeout: 120000 }, async () => {
      const { ctx, page, problems } = await open(w, h, true);
      try {
        await intoRun(page);
        await markTouch(page, w, h);
        const b = await btn(page);
        assert.ok(b, 'the button is shown in play for a touch player');
        assert.equal(b.where, 'strip');
        assert.ok(b.w >= 44 && b.h >= 44, `hit area ${b.w}x${b.h}`);
        assert.ok(b.x >= fieldRight(w, h), `box left ${b.x} is right of the playfield edge ${fieldRight(w, h)}`);
        assert.ok(b.x + b.w <= w && b.y >= 0 && b.y + b.h <= h, 'whole box on screen');
        assert.ok(b.y < h / 2, 'near the top');
        assert.equal(await page.evaluate(() => SF.pauseButtonDrawn()), true, 'it is really drawn');
        assert.deepEqual(problems, []);
      } finally { await ctx.close(); }
    });
  }

  for (const [w, h] of [[1000, 750], [1180, 820]]) {
    test(`${w}x${h} touch: no wide strip, so the button is in the top-right corner inside the playfield, off the score block`, { timeout: 120000 }, async () => {
      const { ctx, page, problems } = await open(w, h, true);
      try {
        await intoRun(page);
        await markTouch(page, w, h);
        const b = await btn(page);
        assert.ok(b);
        assert.equal(b.where, 'corner');
        assert.ok(b.w >= 44 && b.h >= 44);
        const fr = fieldRight(w, h), s = Math.min(w / 400, h / 300), top = (h - 300 * s) / 2;
        assert.ok(b.x + b.w <= fr && b.x > w / 2 + 100 * s, 'inside the right end of the playfield');
        assert.ok(b.y >= top && b.y < top + 40 * s, 'in the HUD row, top');
        assert.ok(b.x > (400 - 120) * s, 'far from the score block at the top left and BEST at the top centre');
        assert.equal(await page.evaluate(() => SF.pauseButtonDrawn()), true);
        assert.deepEqual(problems, []);
      } finally { await ctx.close(); }
    });
  }

  test('1000x750 desktop (no touch): null, never drawn, even after a mouse click', { timeout: 120000 }, async () => {
    const { ctx, page, problems } = await open(1000, 750, false);
    try {
      await intoRun(page);
      await page.mouse.click(500, 400);
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => SF.touchUi()), false);
      assert.equal(await btn(page), null);
      assert.equal(await page.evaluate(() => SF.pauseButtonDrawn()), false);
      await shot(page, 'desktop-1000x750-no-button');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('touch phone: not on the title, not on the pause screen, not behind the turn-sideways screen, not on results', { timeout: 150000 }, async () => {
    const { ctx, page, problems } = await open(844, 390, true);
    try {
      await page.evaluate(() => SF.skip());
      await page.waitForFunction(() => SF.app() === 'title', null, WAIT);
      await page.touchscreen.tap(422, 300);
      await page.waitForTimeout(300);
      assert.equal(await btn(page), null, 'title');
      assert.equal(await page.evaluate(() => SF.pauseButtonDrawn()), false);
      await page.waitForFunction(() => SF.app() === 'title');
      await intoRun(page);
      await markTouch(page, 844, 390);
      assert.ok(await btn(page));
      await page.keyboard.press('KeyP');
      await page.waitForFunction(() => SF.paused() === true, null, WAIT);
      assert.equal(await btn(page), null, 'paused');
      await page.keyboard.press('KeyP');
      await page.waitForFunction(() => SF.paused() === false, null, WAIT);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => SF.rotateShown() === true, null, WAIT);
      assert.equal(await btn(page), null, 'behind the turn-sideways screen');
      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForFunction(() => SF.rotateShown() === false, null, WAIT);
      await page.touchscreen.tap(422, 200); // resume (it was paused by the turn)
      await page.waitForFunction(() => SF.paused() === false, null, WAIT);
      assert.ok(await btn(page), 'back in play: shown again');
      await page.evaluate(() => { let n = 0; while (SF.state !== 'results' && n++ < 400) SF.autoFire(600); });
      await page.waitForFunction(() => SF.app() === 'results', null, WAIT);
      assert.equal(await btn(page), null, 'results');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });
});

describe('w53 behaviour', () => {
  test('844x390: a tap on it pauses (the same pause as P: no sim frame while paused); a tap elsewhere does not; LOBBY and RESUME still work', { timeout: 150000 }, async () => {
    const { ctx, page, problems } = await open(844, 390, true);
    try {
      await intoRun(page);
      await markTouch(page, 844, 390);
      await shot(page, 'play-844x390-pause-button');
      assert.equal(await page.evaluate(() => SF.paused()), false);
      await page.touchscreen.tap(422, 200); // a tap in the field: steers, does not pause
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => SF.paused()), false, 'a tap elsewhere does not pause');
      const b = await btn(page);
      const [cx, cy] = centre(b);
      await page.touchscreen.tap(cx, cy);
      await page.waitForFunction(() => SF.paused() === true, null, WAIT);
      await page.waitForTimeout(200);
      const f0 = await frames(page);
      await page.waitForTimeout(500);
      assert.equal(await frames(page), f0, 'no sim frame while paused');
      assert.equal(await btn(page), null, 'the button gives way to the pause screen');
      // tapping where the button was now resumes (it is a plain tap on the pause screen)
      await page.touchscreen.tap(cx, cy);
      await page.waitForFunction(() => SF.paused() === false, null, WAIT);
      await page.waitForTimeout(200);
      assert.ok((await frames(page)) > f0, 'the sim runs again');
      assert.ok(await btn(page), 'the button is back');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('from the arcade lobby (index.html) at 844x390: pausing with the button shows PAUSED with the touch LOBBY button; tapping LOBBY leaves', { timeout: 150000 }, async () => {
    const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true });
    const page = await ctx.newPage();
    const problems = [];
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
    page.on('pageerror', e => problems.push('pageerror: ' + e.message));
    try {
      await page.goto(web.url + 'index.html');
      await page.waitForFunction(() => window.LOBBY && LOBBY.info().mode === 'lobby', null, WAIT);
      await page.evaluate(() => LOBBY.wordmarkSkip());
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => LOBBY.info().mode === 'gone' && window.SF && SF.away() === false, null, WAIT);
      await intoRun(page);
      await markTouch(page, 844, 390);
      await page.waitForTimeout(500);
      const [cx, cy] = centre(await btn(page));
      await page.touchscreen.tap(cx, cy);
      await page.waitForFunction(() => SF.paused() === true, null, WAIT);
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => SF.lobbyButton()), true, 'the pause screen shows the LOBBY button');
      await shot(page, 'paused-844x390-by-button');
      await page.touchscreen.tap(...(await lobbyCentre(page)));
      await page.waitForFunction(() => SF.away() === true, null, WAIT);
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('a finger that starts on the button never steers, fires or kindles: the recorded input words stay idle; lifting off it does not pause', { timeout: 150000 }, async () => {
    const { ctx, page, problems } = await open(844, 390, true);
    try {
      await intoRun(page);
      await markTouch(page, 844, 390);
      await page.waitForTimeout(200);
      const b = await btn(page), [cx, cy] = centre(b);
      const f0 = await frames(page);
      await touch(page, 'touchstart', [[5, cx, cy]], [[5, cx, cy]]);
      await page.waitForTimeout(250);
      await touch(page, 'touchmove', [[5, cx - 30, cy + 30]], [[5, cx - 30, cy + 30]]); // wanders inside the strip
      await page.waitForTimeout(250);
      await touch(page, 'touchmove', [[5, 300, 200]], [[5, 300, 200]]); // and out over the playfield
      await page.waitForTimeout(250);
      await touch(page, 'touchend', [], [[5, 300, 200]]); // lifted over the playfield, not on the button
      await page.waitForTimeout(250);
      const f1 = await frames(page);
      assert.ok(f1 - f0 > 40, 'frames ran during the press (' + (f1 - f0) + ')');
      const ws = await words(page, f0, f1);
      assert.ok(idleWords(ws), 'every recorded word during the press is idle: ' + JSON.stringify([...new Set(ws)]));
      assert.equal(await page.evaluate(() => SF.paused()), false, 'lifting off the button does not pause');
      // and a normal tap right after still steers: touch words appear
      const f2 = await frames(page);
      await touch(page, 'touchstart', [[6, 300, 200]], [[6, 300, 200]]);
      await page.waitForTimeout(200);
      await touch(page, 'touchend', [], [[6, 300, 200]]);
      const f3 = await frames(page);
      const ws2 = await words(page, f2, f3);
      assert.ok(ws2.some(w => (w & W_TOUCH) !== 0), 'a finger in the field steers');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('a finger that starts in the field and slides onto the button keeps steering and does not pause on lift', { timeout: 150000 }, async () => {
    const { ctx, page, problems } = await open(844, 390, true);
    try {
      await intoRun(page);
      await markTouch(page, 844, 390);
      const b = await btn(page), [cx, cy] = centre(b);
      const f0 = await frames(page);
      await touch(page, 'touchstart', [[1, 420, 250]], [[1, 420, 250]]);
      await page.waitForTimeout(150);
      await touch(page, 'touchmove', [[1, cx, cy]], [[1, cx, cy]]);
      await page.waitForTimeout(250);
      const f1 = await frames(page);
      await touch(page, 'touchend', [], [[1, cx, cy]]); // lifted right on the button
      await page.waitForTimeout(250);
      const ws = await words(page, f0, f1);
      assert.ok(ws.filter(w => (w & W_TOUCH) !== 0).length > 10, 'it steered the whole time, also over the button');
      assert.equal(await page.evaluate(() => SF.paused()), false, 'a slide onto it never pauses');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('two fingers: one on the button while another steers pauses on lift and never kindles; the steering finger is not disturbed', { timeout: 150000 }, async () => {
    const { ctx, page, problems } = await open(844, 390, true);
    try {
      await intoRun(page);
      await markTouch(page, 844, 390);
      const b = await btn(page), [cx, cy] = centre(b);
      const f0 = await frames(page);
      await touch(page, 'touchstart', [[1, 420, 250]], [[1, 420, 250]]);
      await page.waitForTimeout(150);
      await touch(page, 'touchstart', [[1, 420, 250], [2, cx, cy]], [[2, cx, cy]]); // second finger lands on the button
      await page.waitForTimeout(250);
      const f1 = await frames(page);
      const ws = await words(page, f0, f1);
      assert.ok(!ws.some(w => (w & W_ALT_PRESS) !== 0), 'no kindle from the button finger');
      assert.ok(ws.filter(w => (w & W_TOUCH) !== 0).length > 5, 'finger 1 keeps steering');
      assert.equal(await page.evaluate(() => SF.paused()), false, 'not yet: it pauses on lift');
      await touch(page, 'touchend', [[1, 420, 250]], [[2, cx, cy]]);
      await page.waitForFunction(() => SF.paused() === true, null, WAIT);
      await touch(page, 'touchend', [], [[1, 420, 250]]);
      await page.waitForTimeout(250);
      assert.equal(await page.evaluate(() => SF.paused()), true, 'the steering finger lifting afterwards is not a tap that resumes the pause');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('the first finger on the button, a second finger steering in the field: the second finger steers and does not kindle, no pause until the first lifts on the button', { timeout: 150000 }, async () => {
    const { ctx, page, problems } = await open(844, 390, true);
    try {
      await intoRun(page);
      await markTouch(page, 844, 390);
      const b = await btn(page), [cx, cy] = centre(b);
      const f0 = await frames(page);
      await touch(page, 'touchstart', [[1, cx, cy]], [[1, cx, cy]]);
      await page.waitForTimeout(150);
      await touch(page, 'touchstart', [[1, cx, cy], [2, 380, 220]], [[2, 380, 220]]);
      await page.waitForTimeout(300);
      const f1 = await frames(page);
      const ws = await words(page, f0, f1);
      assert.ok(!ws.some(w => (w & W_ALT_PRESS) !== 0), 'no kindle');
      assert.ok(ws.filter(w => (w & W_TOUCH) !== 0).length > 10, 'the field finger steers');
      assert.equal(await page.evaluate(() => SF.paused()), false);
      await touch(page, 'touchend', [[2, 380, 220]], [[1, cx, cy]]);
      await page.waitForFunction(() => SF.paused() === true, null, WAIT);
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('a press on the button does not fire a shot or move the ship even on the first frame (idle recorded words, shots unchanged)', { timeout: 150000 }, async () => {
    const { ctx, page, problems } = await open(844, 390, true);
    try {
      await intoRun(page);
      await markTouch(page, 844, 390);
      await page.waitForTimeout(600); // let the markTouch fire settle
      const b = await btn(page), [cx, cy] = centre(b);
      const shots0 = await page.evaluate(() => SF.info().shots), f0 = await frames(page);
      await page.touchscreen.tap(cx, cy);
      await page.waitForFunction(() => SF.paused() === true, null, WAIT);
      const f1 = await frames(page);
      assert.equal(await page.evaluate(() => SF.info().shots), shots0, 'no shot');
      assert.ok(idleWords(await words(page, f0, f1)), 'idle words only');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });
});

describe('w53 replay', () => {
  test('a touch run paused by the button and resumed records a replay that re-simulates to the live hash', { timeout: 180000 }, async () => {
    const { ctx, page, problems } = await open(844, 390, true);
    try {
      await intoRun(page);
      await markTouch(page, 844, 390);
      // steer for a while with a finger sweeping the field
      await touch(page, 'touchstart', [[1, 330, 250]], [[1, 330, 250]]);
      for (let i = 0; i < 12; i++) { await touch(page, 'touchmove', [[1, 330 + i * 15, 250]], [[1, 330 + i * 15, 250]]); await page.waitForTimeout(60); }
      await touch(page, 'touchend', [], [[1, 330 + 11 * 15, 250]]);
      const b = await btn(page), [cx, cy] = centre(b);
      await page.touchscreen.tap(cx, cy);
      await page.waitForFunction(() => SF.paused() === true, null, WAIT);
      await page.waitForTimeout(400);
      const fp = await frames(page);
      await page.touchscreen.tap(422, 200); // resume
      await page.waitForFunction(() => SF.paused() === false, null, WAIT);
      await touch(page, 'touchstart', [[3, 250, 250]], [[3, 250, 250]]);
      for (let i = 0; i < 10; i++) { await touch(page, 'touchmove', [[3, 250 - i * 10, 250]], [[3, 250 - i * 10, 250]]); await page.waitForTimeout(60); }
      await touch(page, 'touchend', [], [[3, 160, 250]]);
      assert.ok((await frames(page)) > fp, 'play carried on after the pause');
      const snap = await page.evaluate(() => { const i = SF.info(); return { replay: SF.replay(), score: i.score, frames: i.frames, hash: SF.hash(), tainted: i.tainted, state: SF.state }; });
      assert.equal(snap.tainted, false);
      assert.equal(await page.evaluate(() => SF.paused()), false);
      const r = resim(snap.replay);
      assert.equal(r.frames, snap.frames, 'same frame count');
      assert.equal(r.score, snap.score, 'same score');
      assert.equal(r.hash, snap.hash, 'same state hash');
      assert.ok(decode(snap.replay).words.some(w => (w & W_TOUCH) !== 0), 'the replay holds touch input');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });
});

describe('w53 allocation', () => {
  const COUNT = () => {
    window.__alloc = 0; window.__count = false;
    for (const n of ['Float32Array', 'Array', 'Uint8Array']) {
      const Orig = window[n];
      window[n] = new Proxy(Orig, { construct(t, a, nt) { if (window.__count) window.__alloc++; return Reflect.construct(t, a, nt); } });
    }
  };
  const nextFrames = (page, k) => page.evaluate(k => new Promise(r => { let f = 0; const t = () => { if (++f >= k) r(); else requestAnimationFrame(t); }; requestAnimationFrame(t); }), k);
  const counted = async (page, k) => {
    await page.evaluate(() => { window.__alloc = 0; window.__count = true; });
    await nextFrames(page, k);
    return page.evaluate(() => { window.__count = false; return window.__alloc; });
  };

  test('844x390 (strip) and 1000x750 (corner): zero constructions per frame while the button is drawn, and while it is drawn pressed', { timeout: 180000 }, async () => {
    for (const [w, h] of [[844, 390], [1000, 750]]) {
      const { ctx, page, problems } = await open(w, h, true, COUNT);
      try {
        await intoRun(page);
        await markTouch(page, w, h);
        await nextFrames(page, 30);
        assert.ok(await btn(page));
        assert.equal(await page.evaluate(() => SF.pauseButtonDrawn()), true);
        // the baseline: the same count with the button not shown (paused by P, the pause screen) tells what the rest of the frame builds
        const n = await counted(page, 90);
        assert.equal(n, 0, `${w}x${h}: constructions per 90 frames with the button drawn`);
        const b = await btn(page), [cx, cy] = centre(b);
        await touch(page, 'touchstart', [[9, cx, cy]], [[9, cx, cy]]); // pressed: drawn brighter
        await nextFrames(page, 10);
        assert.equal(await counted(page, 60), 0, `${w}x${h}: constructions per 60 frames while pressed`);
        assert.equal(await page.evaluate(() => SF.pauseButtonDrawn()), true);
        await touch(page, 'touchend', [], [[9, 10, 10]]);
        assert.deepEqual(problems, []);
      } finally { await ctx.close(); }
    }
  });
});
