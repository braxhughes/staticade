// the comet body through the real page (starfall.html, headless Chrome, Playwright, system Chrome). The page's own
// render/core.js module instance is imported in the page, and its cometLayer `drawn` tap (body dots drawn last frame: 10 ring
// + 1 core) is read while the real loop renders: 0 before, 11 while SF.comet()'s comet crosses, 0 after it has left. Also a
// comet that comes on its own (stage 2, no hook). Screenshots go to W41_SHOT_DIR when it is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticServer, WAIT } from './w25-helpers.mjs';

const SHOT_DIR = process.env.W41_SHOT_DIR || null;
let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.goto(web.url + 'starfall.html');
  await page.waitForFunction(() => window.SF && typeof SF.comet === 'function', null, WAIT);
  // the same module URL main.js imports ('./render/core.js' from /games/starfall/main.js), so the same instance
  await page.evaluate(async () => { window.__w41 = (await import('/games/starfall/render/core.js')).cometLayer; });
  return { ctx, page, problems };
}
const frames = (page, n) => page.evaluate(n => new Promise(r => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);
const shot = async (page, name) => { if (!SHOT_DIR) return; fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') }); };

test('SF.comet() through the real page: the ring and core are drawn while it crosses, and not before or after', async () => {
  const { ctx, page, problems } = await open();
  try {
    await page.evaluate(() => { SF.start(1, 4040); let n = 0; while (SF.state !== 'play' && n++ < 2000) SF.autoFire(1); SF.god(true); });
    assert.equal(await page.evaluate(() => SF.state), 'play');
    await frames(page, 20);
    assert.equal(await page.evaluate(() => __w41.drawn), 0, 'no comet on stage 1 by itself: no body drawn');
    await page.evaluate(() => SF.comet());
    await page.waitForFunction(() => __w41.drawn === 11, null, WAIT);
    // let it get well into the playfield, then sample a few rendered frames
    await page.waitForFunction(() => __w41.drawn === 11 && __w41.x > 120 && __w41.x < 280, null, WAIT);
    const s = await page.evaluate(() => ({ drawn: __w41.drawn, x: __w41.x, y: __w41.y }));
    assert.equal(s.drawn, 11);
    assert.ok(s.y > 20 && s.y < 40, 'comet lane near the top: y=' + s.y);
    await shot(page, 'comet-mid-crossing');
    await page.waitForFunction(() => __w41.drawn === 0, null, WAIT);
    assert.equal(await page.evaluate(() => SF.state), 'play');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('a comet that comes on its own (stage 2, no hook) draws its body too', async () => {
  const { ctx, page, problems } = await open();
  try {
    let found = null;
    for (const seed of [4040, 7, 99, 2026, 31337]) {
      await page.evaluate(seed => { SF.start(2, seed); let n = 0; while (SF.state !== 'play' && n++ < 2000) SF.autoFire(1); SF.god(true); }, seed);
      // step the run in chunks without fire (so the ship cannot shoot the comet), letting the real loop render after each
      for (let chunk = 0; chunk < 50 && !found; chunk++) {
        await page.evaluate(() => SF.autoFireLoud(30, 0, false));
        await frames(page, 2);
        const d = await page.evaluate(() => ({ drawn: __w41.drawn, x: __w41.x }));
        if (d.drawn === 11) found = { seed, ...d };
      }
      if (found) break;
    }
    assert.ok(found, 'a natural comet in one of the seeds');
    assert.equal(found.drawn, 11);
    // step on in small chunks until it is well inside the playfield (it may have just come in at an edge), still drawn
    let inside = null;
    for (let k = 0; k < 30 && !inside; k++) {
      const d = await page.evaluate(() => ({ drawn: __w41.drawn, x: __w41.x }));
      if (d.drawn === 11 && d.x > 100 && d.x < 300) inside = d; else { await page.evaluate(() => SF.autoFireLoud(8, 0, false)); await frames(page, 2); }
    }
    assert.ok(inside, 'the natural comet is drawn inside the playfield');
    await shot(page, 'comet-natural-stage2');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});
