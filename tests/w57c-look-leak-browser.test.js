// STACKLIGHT look switch leak check (browser): the look switch cannot change the sim while frames are drawn. The real stacklight.html in
// headless Chrome. tests/w57-looks-browser.test.js runs its compared run inside one page.evaluate, so the renderer never
// draws during it; here every placement is followed by real rendered frames (the main loop's own requestAnimationFrame
// callback, driven by the frame stepper of tests/stacklight-browser-w49c.test.js), some with sim ticks in between, so the
// look's render code runs on the live sim all through the run, including every clear and its sweep.
// The same seeded run (fixed placements, fixed tick counts) is played in looks 0, 1, 2 and 3, each on a fresh page. Look 2
// (the earlier shipped look) never calls into render/looks.js, so it is the reference: looks 0, 1 and 3 must give the
// same score after every placement, the same final sim hash, score, lines and frame, and the same replay.
// Guards against a pass with nothing tested: each run draws at least 100 frames, clears lines, and draws frames while a
// clear is on screen (the sweep in looks 0 and 3). A render loop that stops (an exception in a frame) fails with its error.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { staticServer, WAIT } from './w25-helpers.mjs';

// the frame stepper, with a bounded wait: __adv(k) runs exactly k ticks and one render, or rejects if no frame comes
const STEPPER = `(() => {
  const real = window.requestAnimationFrame.bind(window), STEP = 1000 / 60;
  let frozen = false, held = null, lastPassed = 0, offset = 0;
  window.__renders = 0;
  window.requestAnimationFrame = cb => real(t => { if (frozen) { held = cb; return; } lastPassed = t - offset; cb(lastPassed); });
  const until = f => new Promise((res, rej) => { const t0 = performance.now(); const c = () => (f() ? res() : performance.now() - t0 > 8000 ? rej(new Error('no frame within 8 s: the render loop stopped')) : setTimeout(c, 2)); c(); });
  window.__freeze = async () => { frozen = true; await until(() => held); document.dispatchEvent(new Event('visibilitychange')); lastPassed = performance.now() - offset; };
  window.__adv = async (steps = 0) => {
    for (;;) {
      const k = Math.min(steps, 14); steps -= k;
      const cb = held; held = null; lastPassed += k * STEP + 1e-4; window.__renders++; cb(lastPassed); await until(() => held);
      if (steps <= 0) return;
    }
  };
})();`;

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

const SEED = 4242, PLACEMENTS = 36;
const TICKS = [0, 1, 3, 0, 6, 2]; // sim ticks before each of the 6 frames drawn after a placement

// one seeded run in look L on a fresh page: a placement (the lowest column, a fixed rotation), then 6 rendered frames
async function play(L) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  await ctx.addInitScript(STEPPER);
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  try {
    await page.goto(web.url + 'stacklight.html');
    await page.waitForFunction(() => window.SL && SL.info().app === 'title' && SL.hud().F > 5, null, WAIT);
    assert.equal(await page.evaluate(L => SL.look(L), L), L, 'look ' + L + ' set');
    await page.evaluate(() => window.__freeze());
    await page.evaluate(s => { SL.start(s); }, SEED);
    await page.evaluate(() => window.__adv(0));
    const trace = [];
    let clearFrames = 0;
    for (let i = 0; i < PLACEMENTS; i++) {
      const p = await page.evaluate(i => {
        const h = SL.info().heights;
        let col = 0; for (let c = 1; c < h.length; c++) if (h[c] < h[col]) col = c;
        return SL.place(col, (i >> 1) & 1);
      }, i);
      if (!p) break; // the run is over
      trace.push(p.score);
      for (const k of TICKS) {
        const f = await page.evaluate(async k => { await window.__adv(k); const x = SL.fx(); return { age: x.clearAge, rows: x.clearRows, app: SL.info().app }; }, k);
        if (f.rows > 0 && f.age >= 0 && f.age < 28) clearFrames++;
        if (f.app !== 'play') break;
      }
      if ((await page.evaluate(() => SL.info().app)) !== 'play') break;
    }
    const out = await page.evaluate(() => { const i = SL.info(); return { hash: SL.hash(), replay: SL.replay(), score: i.score, lines: i.lines, frame: i.frame, renders: window.__renders }; });
    return { ...out, trace, clearFrames, problems };
  } finally { await ctx.close(); }
}

test('the look switch cannot change the sim while frames are drawn: the same seeded run, drawn frame by frame in looks 0 to 3, gives the same scores, hash and replay', { timeout: 240000 }, async t => {
  const runs = [];
  for (const L of [2, 0, 1, 3]) runs[L] = await play(L); // one look at a time, each on its own page
  const ref = runs[2];
  for (const L of [2, 0, 1, 3]) {
    const r = runs[L];
    t.diagnostic(`look ${L}: ${r.trace.length} placements, ${r.renders} frames drawn, ${r.clearFrames} during a clear, score ${r.score}, lines ${r.lines}, sim frame ${r.frame}, hash ${r.hash}`);
    assert.deepEqual(r.problems, [], `look ${L}: no page errors while drawing`);
    assert.ok(r.renders >= 100, `look ${L}: frames were drawn during the run (${r.renders})`);
    assert.ok(r.lines > 0 && r.clearFrames >= 10, `look ${L}: the run clears lines and frames are drawn during the clears (lines ${r.lines}, ${r.clearFrames} frames)`);
    assert.ok(r.replay, `look ${L}: a seeded run makes a replay`);
  }
  for (const L of [0, 1, 3]) {
    const r = runs[L];
    assert.deepEqual(r.trace, ref.trace, `look ${L}: the score after every placement matches look 2`);
    assert.equal(r.score, ref.score, `look ${L}: same final score as look 2`);
    assert.equal(r.lines, ref.lines, `look ${L}: same lines as look 2`);
    assert.equal(r.frame, ref.frame, `look ${L}: same sim frame as look 2`);
    assert.equal(r.hash, ref.hash, `look ${L}: same sim hash as look 2`);
    assert.equal(r.replay, ref.replay, `look ${L}: same replay as look 2`);
  }
});
