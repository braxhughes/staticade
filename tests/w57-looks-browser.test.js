// STACKLIGHT looks (browser): the look directions behind the test-only switch SL.look(n) (games/stacklight/render/looks.js).
// The real stacklight.html in headless Chrome.
//   1. each look (0 to 3) builds no array and no typed array over 90 frames of play (a clear, its particles and sweep, the shaft,
//      a held key) and over 90 frames of the title (the usual Proxy count, as tests/stacklight-browser.test.js)
//   2. the switch cannot leak: a fresh page is look 0, a bad value changes nothing, and the same placements in look 0 and in
//      look 3 give the same sim hash and the same replay (render only)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { staticServer, WAIT } from './w25-helpers.mjs';

const COUNT = `(() => {
  window.__alloc = 0; window.__count = false; window.__allocBy = {};
  for (const n of ['Float32Array', 'Float64Array', 'Int8Array', 'Int16Array', 'Int32Array', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Array']) {
    const Orig = window[n];
    window[n] = new Proxy(Orig, { construct(t, a, nt) { if (window.__count) { window.__alloc++; window.__allocBy[n] = (window.__allocBy[n] || 0) + 1; } return Reflect.construct(t, a, nt); },
      apply(t, th, a) { if (window.__count) { window.__alloc++; window.__allocBy[n] = (window.__allocBy[n] || 0) + 1; } return Reflect.apply(t, th, a); } });
  }
})();`;

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

async function open(init) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.goto(web.url + 'stacklight.html');
  await page.waitForFunction(() => window.SL && SL.info().app === 'title' && SL.hud().F > 5, null, WAIT);
  return { ctx, page, problems };
}
// count constructions over n rendered frames
async function counted(page, n) {
  await page.evaluate(() => { window.__alloc = 0; window.__allocBy = {}; window.__count = true; });
  await page.evaluate(n => new Promise(r => { let f = 0; const t = () => (++f >= n ? r() : requestAnimationFrame(t)); requestAnimationFrame(t); }), n);
  return page.evaluate(() => { window.__count = false; return { n: window.__alloc, by: window.__allocBy }; });
}

for (const L of [0, 1, 2, 3]) {
  test(`look ${L}: 0 arrays or typed arrays built over 90 frames of play (clear, sweep, shaft, held key) and 90 of the title`, { timeout: 90000 }, async () => {
    const { ctx, page, problems } = await open(COUNT);
    try {
      assert.equal(await page.evaluate(L => SL.look(L), L), L);
      let r = await counted(page, 90);
      assert.equal(r.n, 0, `look ${L} title: ${JSON.stringify(r.by)}`);
      await page.evaluate(() => { SL.start(1); SL.setHeights([5, 5, 5, 5, 0, 5, 5, 5, 5]); SL.place(3, 0); SL.place(3, 0); });
      const f = await page.evaluate(() => SL.fx());
      assert.ok(f.clearRows > 0 && f.clearAge < 30, 'a clear is on screen: ' + JSON.stringify(f));
      await page.keyboard.down('ArrowLeft');
      r = await counted(page, 90);
      await page.keyboard.up('ArrowLeft');
      assert.equal(r.n, 0, `look ${L} play: ${JSON.stringify(r.by)}`);
      assert.ok((await page.evaluate(() => SL.info())).frame > 60, 'the run was playing');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });
}

test('the look switch cannot leak into a run or a replay: fresh page is look 0, bad values change nothing, same hash and replay in look 0 and look 3', { timeout: 90000 }, async () => {
  const { ctx, page, problems } = await open(null);
  try {
    assert.equal(await page.evaluate(() => SL.look()), 0, 'a fresh page draws look 0');
    for (const bad of [4, -1, 1.5, '2', null]) assert.equal(await page.evaluate(v => SL.look(v), bad), 0, 'bad value ' + JSON.stringify(bad));
    const run = L => page.evaluate(L => {
      SL.look(L); SL.start(4242);
      const cols = [0, 3, 6, 8, 1, 4, 7, 2, 5, 0, 8, 4];
      for (let i = 0; i < cols.length; i++) SL.place(cols[i], i & 1);
      return { hash: SL.hash(), replay: SL.replay(), info: SL.info().score };
    }, L);
    const a = await run(0), b = await run(3), c = await run(1);
    assert.ok(a.replay, 'a seeded run makes a replay');
    assert.equal(b.hash, a.hash, 'look 3: same sim hash'); assert.equal(b.replay, a.replay, 'look 3: same replay');
    assert.equal(c.hash, a.hash, 'look 1: same sim hash'); assert.equal(c.replay, a.replay, 'look 1: same replay');
    await page.reload();
    await page.waitForFunction(() => window.SL && SL.info().app === 'title', null, WAIT);
    assert.equal(await page.evaluate(() => SL.look()), 0, 'a reload is look 0 again (nothing stored)');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});
