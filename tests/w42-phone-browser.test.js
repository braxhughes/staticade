// phones. Through the real index.html / starfall.html in headless Chrome (system Chrome), with touch emulation
// where a phone is meant (hasTouch makes (pointer: coarse) true).
//   Upright touch (390x844, iPad 820x1180): the TURN YOUR PHONE SIDEWAYS screen is up in the lobby and in the game; the run is
//     paused behind it (no sim frame, no new replay frame); turning sideways takes it away and the game stays paused until a tap.
//   Sideways touch (844x390, 932x430): no rotate screen; the lobby has no black column at either side; the game's side strips
//     carry bezel dots (not pure black); the playfield keeps its 400x300 box.
//   Desktop, with or without a tall window (1000x750, 600x900, no touch): never shown, no bezel.
// Screenshots go to W42_SHOT_DIR when it is set.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticServer, WAIT } from './w25-helpers.mjs';

const SHOT_DIR = process.env.W42_SHOT_DIR || null;
let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

async function openLobby(w, h, touch) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.goto(web.url + 'index.html');
  await page.waitForFunction(() => window.LOBBY && LOBBY.info().mode === 'lobby', null, WAIT);
  await page.evaluate(() => LOBBY.wordmarkSkip());
  return { ctx, page, problems };
}
// sideways first (the lobby only selects Starfall when the rotate screen is not up), then into a free run
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
const frames = page => page.evaluate(() => SF.info().frames);
const shot = async (page, name) => { if (!SHOT_DIR) return; fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.waitForTimeout(300); await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') }); };

// pixels of the canvas as the last frame drew them (read inside a rAF, after the loop's own frame callback, before the buffer is presented).
// bands: [{ x0, x1, y0, y1 }] in canvas pixels. Returns, per band, the fraction of pixels that are not black and the brightest channel.
function sample(page, bands) {
  return page.evaluate(b => new Promise(res => requestAnimationFrame(() => {
    const c = document.getElementById('c'), t = document.createElement('canvas');
    t.width = c.width; t.height = c.height;
    const x = t.getContext('2d'); x.drawImage(c, 0, 0);
    res(b.map(r => {
      const x0 = Math.max(0, r.x0 | 0), x1 = Math.min(c.width, r.x1 | 0), y0 = Math.max(0, r.y0 | 0), y1 = Math.min(c.height, r.y1 | 0);
      const d = x.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      let lit = 0, max = 0;
      for (let i = 0; i < d.length; i += 4) { const m = Math.max(d[i], d[i + 1], d[i + 2]); if (m > 0) lit++; if (m > max) max = m; }
      return { lit: lit / (d.length / 4), max, w: x1 - x0, h: y1 - y0 };
    }));
  })), bands);
}
const canvasSize = page => page.evaluate(() => { const c = document.getElementById('c'); return { w: c.width, h: c.height }; });

describe('w42 upright touch phone: turn-sideways screen', () => {
  test('lobby 390x844 touch: the screen is up (the room is not drawn), sideways it goes and the lobby works', { timeout: 120000 }, async () => {
    const { ctx, page, problems } = await openLobby(390, 844, true);
    try {
      assert.equal(await page.evaluate(() => LOBBY.rotateShown()), true, 'upright touch: the rotate screen is shown in the lobby');
      await page.waitForTimeout(500);
      await shot(page, 'lobby-390x844-rotate');
      const sz = await canvasSize(page);
      const [top, mid] = await sample(page, [{ x0: 0, x1: sz.w, y0: 0, y1: sz.h * 0.2 }, { x0: sz.w * 0.2, x1: sz.w * 0.8, y0: sz.h * 0.3, y1: sz.h * 0.7 }]);
      assert.equal(top.lit, 0, 'the room is not drawn behind the screen (top of the canvas is black)');
      assert.ok(mid.lit > 0.002, 'the screen has dots in the middle');
      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForFunction(() => LOBBY.rotateShown() === false, null, WAIT);
      assert.equal(await page.evaluate(() => LOBBY.info().mode), 'lobby');
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => LOBBY.info().mode === 'gone' && window.SF, null, WAIT);
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('game 390x844 touch mid-run: paused behind the screen, no sim or replay frame while it is up, stays paused after the turn until a tap', { timeout: 150000 }, async () => {
    const { ctx, page, problems } = await openLobby(844, 390, true);
    try {
      await intoRun(page);
      await page.evaluate(() => SF.autoFire(120));
      assert.equal(await page.evaluate(() => SF.paused()), false);
      assert.equal(await page.evaluate(() => SF.rotateShown()), false);
      await page.waitForTimeout(250);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => SF.rotateShown() === true && SF.paused() === true, null, WAIT);
      await page.waitForTimeout(300);
      const f0 = await frames(page), rep0 = await page.evaluate(() => SF.replay()), h0 = await page.evaluate(() => SF.hash());
      await shot(page, 'game-390x844-rotate');
      await page.waitForTimeout(900);
      assert.equal(await frames(page), f0, 'the sim frame count does not advance while the screen is up');
      assert.equal(await page.evaluate(() => SF.replay()), rep0, 'nothing is recorded in the replay while the screen is up');
      assert.equal(await page.evaluate(() => SF.hash()), h0, 'the state hash does not move');
      await page.touchscreen.tap(195, 420); // a tap on the screen does not resume
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => SF.paused()), true, 'a tap on the rotate screen does not resume');
      assert.equal(await frames(page), f0);
      // sideways again: the screen goes, the game stays on its pause screen
      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForFunction(() => SF.rotateShown() === false, null, WAIT);
      await page.waitForTimeout(800);
      assert.equal(await page.evaluate(() => SF.paused()), true, 'no surprise resume after the turn');
      assert.equal(await frames(page), f0, 'still no sim frame after the turn');
      await shot(page, 'game-844x390-paused-after-turn');
      // the player resumes with a tap in the middle: the run goes on from where it was
      await page.touchscreen.tap(422, 195);
      await page.waitForFunction(() => SF.paused() === false, null, WAIT);
      await page.waitForFunction(f => SF.info().frames > f, f0, WAIT);
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('game: turning back and forth fast ends sideways paused with the frame count where the first turn left it', { timeout: 150000 }, async () => {
    const { ctx, page, problems } = await openLobby(844, 390, true);
    try {
      await intoRun(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => SF.rotateShown() === true && SF.paused() === true, null, WAIT);
      await page.waitForTimeout(200);
      const f0 = await frames(page), rep0 = await page.evaluate(() => SF.replay());
      for (let i = 0; i < 6; i++) {
        await page.setViewportSize(i % 2 === 0 ? { width: 844, height: 390 } : { width: 390, height: 844 });
        await page.waitForTimeout(40);
      }
      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForFunction(() => SF.rotateShown() === false, null, WAIT);
      await page.waitForTimeout(500);
      assert.equal(await page.evaluate(() => SF.paused()), true);
      assert.equal(await frames(page), f0);
      assert.equal(await page.evaluate(() => SF.replay()), rep0);
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('iPad size 820x1180 touch: shown in the lobby and the game', { timeout: 120000 }, async () => {
    const { ctx, page, problems } = await openLobby(1180, 820, true);
    try {
      await intoRun(page);
      await page.setViewportSize({ width: 820, height: 1180 });
      await page.waitForFunction(() => SF.rotateShown() === true && SF.paused() === true, null, WAIT);
      await shot(page, 'game-820x1180-rotate');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });
});

describe('w42 sideways touch phone: the screen is filled', () => {
  for (const [w, h] of [[844, 390], [932, 430]]) {
    test(`${w}x${h} touch: not shown; the lobby has no black column at either side; the game's side strips carry bezel dots, the playfield box stays 400x300`, { timeout: 150000 }, async () => {
      const { ctx, page, problems } = await openLobby(w, h, true);
      try {
        await page.waitForTimeout(1800);
        assert.equal(await page.evaluate(() => LOBBY.rotateShown()), false);
        const sz = await canvasSize(page);
        const band = Math.round(sz.w * 0.03); // the outer 3% of the width on each side
        const [l, r] = await sample(page, [{ x0: 0, x1: band, y0: 0, y1: sz.h }, { x0: sz.w - band, x1: sz.w, y0: 0, y1: sz.h }]);
        assert.ok(l.lit > 0.01 && l.max > 20, `lobby, far left is not a black column (lit ${l.lit.toFixed(3)}, max ${l.max})`);
        assert.ok(r.lit > 0.01 && r.max > 20, `lobby, far right is not a black column (lit ${r.lit.toFixed(3)}, max ${r.max})`);
        assert.ok((await page.evaluate(() => LOBBY.fillX())) > 100, 'the lobby shows more than 100 field units past each side');
        await shot(page, `lobby-${w}x${h}`);
        await intoRun(page);
        assert.equal(await page.evaluate(() => SF.rotateShown()), false);
        assert.equal(await page.evaluate(() => SF.paused()), false);
        assert.ok((await page.evaluate(() => SF.bezelDots())) > 200, 'bezel dots exist');
        await page.waitForTimeout(400);
        // the playfield box: scale = min(w/400, h/300); the strips are what is left to the left and right of it
        const sc = Math.min(sz.w / 400, sz.h / 300), boxX = Math.floor((sz.w - Math.floor(400 * sc)) / 2);
        const bars = await sample(page, [{ x0: 0, x1: boxX - 2, y0: 0, y1: sz.h }, { x0: sz.w - boxX + 2, x1: sz.w, y0: 0, y1: sz.h }]);
        for (const b of bars) {
          assert.ok(b.w > 40, 'the strip is wide enough to sample (' + b.w + ' px)');
          assert.ok(b.lit > 0.02 && b.max > 25, `game, the strip is not pure black (lit ${b.lit.toFixed(3)}, max ${b.max})`);
          assert.ok(b.max < 170, `game, the bezel stays dim (max ${b.max})`);
        }
        const [mid] = await sample(page, [{ x0: boxX + 20, x1: sz.w - boxX - 20, y0: 10, y1: sz.h - 10 }]);
        assert.ok(mid.lit > 0.01, 'the playfield still draws');
        await shot(page, `game-${w}x${h}`);
        assert.deepEqual(problems, []);
      } finally { await ctx.close(); }
    });
  }
});

describe('w42 desktop: never shown', () => {
  for (const [w, h, name] of [[1000, 750, 'desktop 1000x750'], [600, 900, 'a tall desktop window 600x900']]) {
    test(`${name}, no touch: no rotate screen in the lobby or the game, the run is not paused, no bezel`, { timeout: 150000 }, async () => {
      const { ctx, page, problems } = await openLobby(w, h, false);
      try {
        await page.waitForTimeout(1200);
        assert.equal(await page.evaluate(() => LOBBY.rotateShown()), false);
        if (w === 1000) await shot(page, 'lobby-1000x750');
        await intoRun(page);
        assert.equal(await page.evaluate(() => SF.rotateShown()), false);
        assert.equal(await page.evaluate(() => SF.paused()), false);
        assert.equal(await page.evaluate(() => SF.bezelDots()), 0, 'no bezel when there are no side strips');
        const f0 = await frames(page);
        await page.evaluate(() => SF.autoFire(60));
        await page.waitForTimeout(300);
        assert.ok((await frames(page)) > f0, 'the run advances');
        const sz = await canvasSize(page);
        const [mid] = await sample(page, [{ x0: sz.w * 0.2, x1: sz.w * 0.8, y0: sz.h * 0.2, y1: sz.h * 0.8 }]);
        assert.ok(mid.lit > 0.01, 'the game draws');
        if (w === 1000) await shot(page, 'game-1000x750');
        assert.deepEqual(problems, []);
      } finally { await ctx.close(); }
    });
  }
});
