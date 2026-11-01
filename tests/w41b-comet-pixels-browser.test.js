// The comet browser test reads cometLayer.drawn, a counter the layer writes itself, so a layer that
// set the counter and drew nothing would pass. This test reads the real pixels of the WebGL canvas (gl.readPixels in a
// requestAnimationFrame callback queued after the page's own, so it sees the frame the page just drew). With the CRT off
// (SF.crt(false), no screen warp) the playfield maps straight onto the canvas: pixel = view offset + field * scale, y up from
// the bottom. While SF.comet()'s comet is on, the white core must light pixels at cometLayer.x/y; once it has left, the same
// spot must be dark (a blank sky fails the first check, a stuck core fails the second); and a spot well away from the comet
// is dark while it is on (a full-screen white wash would fail).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { staticServer, WAIT } from './w25-helpers.mjs';

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

// In the next rendered frame: bright (every channel > 200) pixel counts in a 13x13 box at each given field spot, plus the
// comet layer's own spot and drawn flag in that same callback. `at` null = the comet's current spot.
const probe = (page, spots) => page.evaluate(spots => new Promise(res => requestAnimationFrame(() => {
  const cv = document.getElementById('c'), gl = cv.getContext('webgl2') || cv.getContext('webgl');
  const cw = cv.width, ch = cv.height, s = Math.min(cw / 400, ch / 300), ox = Math.floor((cw - Math.floor(400 * s)) / 2), oy = Math.floor((ch - Math.floor(300 * s)) / 2);
  const c = window.__w41;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const buf = new Uint8Array(cw * ch * 4); gl.readPixels(0, 0, cw, ch, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const count = (fx, fy) => {
    const cx = Math.round(ox + fx * s), cy = ch - Math.round(oy + fy * s); let n = 0;
    for (let y = cy - 6; y <= cy + 6; y++) for (let x = cx - 6; x <= cx + 6; x++) {
      if (x < 0 || y < 0 || x >= cw || y >= ch) continue;
      const i = (y * cw + x) * 4; if (buf[i] > 200 && buf[i + 1] > 200 && buf[i + 2] > 200) n++;
    }
    return n;
  };
  res({ drawn: c.drawn, x: c.x, y: c.y, counts: spots.map(p => (p ? count(p[0], p[1]) : count(c.x, c.y))) });
})), spots);

test('the comet core really reaches the canvas: bright pixels at cometLayer.x/y while it crosses, none there after it leaves', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  try {
    await page.goto(web.url + 'starfall.html');
    await page.waitForFunction(() => window.SF && typeof SF.comet === 'function', null, WAIT);
    await page.evaluate(async () => { window.__w41 = (await import('/games/starfall/render/core.js')).cometLayer; });
    await page.evaluate(() => { SF.start(1, 4040); let n = 0; while (SF.state !== 'play' && n++ < 2000) SF.autoFire(1); SF.god(true); SF.crt(false); });
    assert.equal(await page.evaluate(() => SF.state), 'play');
    await page.evaluate(() => SF.comet());
    await page.waitForFunction(() => __w41.drawn === 11 && __w41.x > 120 && __w41.x < 280, null, WAIT);
    // the comet lane is near the top (y about 30); a spot 100 field units below it holds no comet
    const on = await probe(page, [null, [200, 150]]);
    assert.equal(on.drawn, 11, 'the comet is on in the frame sampled');
    assert.ok(on.counts[0] >= 4, 'white core pixels at the comet spot (' + on.x.toFixed(1) + ', ' + on.y.toFixed(1) + '): ' + on.counts[0]);
    assert.ok(on.counts[1] <= 2, 'a spot away from the comet is not white: ' + on.counts[1]);
    await page.waitForFunction(() => __w41.drawn === 0, null, WAIT);
    const off = await probe(page, [[on.x, on.y]]);
    assert.equal(off.drawn, 0);
    assert.equal(off.counts[0], 0, 'the spot where the comet was is dark once it has left: ' + off.counts[0]);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});
