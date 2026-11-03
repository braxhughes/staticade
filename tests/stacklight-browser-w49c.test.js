// STACKLIGHT T3: the tests a cold review found missing.
// The real stacklight.html in headless Chrome, driven by real key and touch events and window.SL. Three taps are put in
// front of engine modules by routing (the repo files are untouched): gfx.dot (every dot of a frame), crt.flush (is the CRT
// pass on) and the font text() (what was written where). A frame stepper replaces the page's requestAnimationFrame:
// __adv(k) runs exactly k sim ticks and one render, so tick and display-frame counts are exact and no test depends on
// wall-clock timing (the box may be loaded).
//   1. a render with no tick loses no press; the pause tick and paused ticks run no sim frame and call no word()
//   2. blur pauses a run
//   3. the HUD score drawn equals SL.info().score on every drawn frame of a scoring stretch
//   4. the active piece is drawn interpolated between sim ticks
//   5. the CRT menu toggle reaches the CRT pass
//   6. drawn output: melt drip, particles, GLOW rings, light shaft
//   7. game over: the topped-out piece is burnt out, the panel has a clear backdrop; SL.place after the title
//   8. render-path allocation per function, desktop and touch (heap sampler at 4 byte intervals)
//   9. touch pads: drawn only in the side bands, faithful to the layout, held pads lit, touch heap under 1 KB
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticServer, WAIT, ROOT } from './w25-helpers.mjs';
import { decode } from '../engine/replay.js';

const SHOT_DIR = process.env.W49_SHOT_DIR || null;
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const TAPS = [
  ['engine/gl-dots.js', 'function dot(x, y, s, r, g, b, a) {', 'function dot(x, y, s, r, g, b, a) { if (window.__dots) window.__dots.push(x, y, s, r, g, b, a);'],
  ['engine/crt.js', 'function flush(splitAt, ox, oy, on, time) {', 'function flush(splitAt, ox, oy, on, time) { window.__crtOn = on;'],
  ['engine/font.js', 'return function text(str, x, y, col, sc, align, a, wave) {', 'return function text(str, x, y, col, sc, align, a, wave) { if (window.__tlog) window.__tlog.push([str, x, y]);']
].map(([f, from, to]) => {
  const src = read(f);
  if (!src.includes(from)) throw new Error(f + ' no longer has the entry the tap wraps');
  return { file: f, body: src.replace(from, to) };
});

// The frame stepper. __freeze() holds the page's rAF chain; __adv(k) feeds the loop k ticks of time (plus a hair, so the
// accumulator never lands just short) and renders once; k may be fractional for an exact interpolation alpha.
const STEPPER = `(() => {
  const real = window.requestAnimationFrame.bind(window), STEP = 1000 / 60;
  let frozen = false, held = null, lastPassed = 0, offset = 0, thawed = false;
  window.requestAnimationFrame = cb => real(t => {
    if (frozen) { held = cb; return; }
    if (thawed) { thawed = false; offset = t - (lastPassed + STEP); }
    lastPassed = t - offset; cb(lastPassed);
  });
  const until = f => new Promise(r => { const c = () => (f() ? r() : setTimeout(c, 2)); c(); });
  // freeze: hold the chain, then reset the loop's accumulator (its visibilitychange handler) so alpha starts at 0
  window.__freeze = async () => { frozen = true; await until(() => held); document.dispatchEvent(new Event('visibilitychange')); lastPassed = performance.now() - offset; };
  // the loop clamps one frame to 250 ms (15 ticks), so a longer advance is fed in chunks of 14 ticks (one render each)
  window.__adv = async (steps = 0) => {
    for (;;) {
      const k = Math.min(steps, 14); steps -= k;
      const cb = held; held = null; lastPassed += k * STEP + 1e-4; cb(lastPassed); await until(() => held);
      if (steps <= 0) return;
    }
  };
  window.__thaw = () => { frozen = false; thawed = true; const cb = held; held = null; if (cb) window.requestAnimationFrame(cb); };
})();`;

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

async function open({ w = 1000, h = 750, touch = false, taps = true, frozen = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch });
  if (taps) for (const t of TAPS) await ctx.route('**/' + t.file, r => r.fulfill({ status: 200, contentType: 'text/javascript', body: t.body }));
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) problems.push('HTTP ' + r.status() + ' ' + r.url()); });
  await page.addInitScript(STEPPER);
  await page.goto(web.url + 'stacklight.html');
  await page.waitForFunction(() => window.SL && SL.info().app === 'title' && SL.hud().F > 5, null, WAIT);
  if (frozen) await page.evaluate(() => window.__freeze());
  return { ctx, page, problems };
}
const adv = (page, k = 0) => page.evaluate(k => window.__adv(k), k);
const info = page => page.evaluate(() => SL.info());
const words = async page => { const s = await page.evaluate(() => SL.replay()); return s ? Array.from(decode(s).words) : null; };
const shot = async (page, name) => { if (!SHOT_DIR) return; fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') }); };
// run ticks until a piece is in play
async function untilPiece(page) { for (let n = 0; n < 120; n++) { if ((await info(page)).piece) return; await adv(page, 1); } throw new Error('no piece appeared'); }
// draw one frame (k ticks first) and return its dots as [x, y, size, r, g, b, a] rows
async function dots(page, k = 0) {
  return page.evaluate(async k => {
    window.__dots = []; await window.__adv(k);
    const d = window.__dots; window.__dots = null;
    const o = []; for (let i = 0; i < d.length; i += 7) o.push([d[i], d[i + 1], d[i + 2], d[i + 3], d[i + 4], d[i + 5], d[i + 6]]);
    return o;
  }, k);
}
const near = (a, b, e = 0.01) => Math.abs(a - b) < e;
const inBoard = d => d[0] > 142 && d[0] < 258;
const CELL_SIZES = [3.1, 3.3, 2.4];
const isCellDot = d => CELL_SIZES.some(s => near(d[2], s));
const BAR_COL = [0.2, 1, 0.75], STEEL = [0.65, 0.8, 0.72];
const isCol = (d, c) => near(d[3], c[0], 0.02) && near(d[4], c[1], 0.02) && near(d[5], c[2], 0.02);

test('a render with no tick loses no press; the pause tick and paused ticks run no sim frame and call no word() (M01, M04, M27)', { timeout: 90000 }, async () => {
  const { ctx, page, problems } = await open({ frozen: true });
  try {
    await page.evaluate(() => SL.start(1));
    await untilPiece(page);
    // (a) display frames between ticks (a 120 Hz screen) must not eat a latched press
    for (const [key, bit, name] of [['ArrowUp', 64, 'turn'], ['ArrowLeft', 8, 'left'], ['ArrowUp', 64, 'turn'], ['ArrowRight', 16, 'right']]) {
      const f0 = (await info(page)).frame;
      await page.keyboard.press(key);                  // latched; no tick has run
      await adv(page, 0); await adv(page, 0); await adv(page, 0); // three render-only frames
      assert.equal((await info(page)).frame, f0, 'no sim frame on a render-only frame');
      await adv(page, 1);                              // the next tick: the press must be in its word
      const w = await words(page);
      assert.equal(w.length, f0 + 1);
      assert.ok(w[f0] & bit, name + ' press survived the render-only frames: word ' + w[f0]);
      await adv(page, 2);                              // the same bit may not be packed two frames running
    }
    // (b) pause tick, paused ticks, resume tick: no sim frame, and no word() (the sim still remembers the last word)
    await page.keyboard.press('ArrowUp');
    await adv(page, 1);
    const f1 = (await info(page)).frame;
    assert.ok((await words(page))[f1 - 1] & 64, 'a turn press in the last word before the pause');
    await page.keyboard.press('KeyP');
    await adv(page, 1);
    assert.equal((await info(page)).paused, true);
    assert.equal((await info(page)).frame, f1, 'the pause tick runs no sim frame');
    await adv(page, 4);
    assert.equal((await info(page)).frame, f1, 'paused ticks run no sim frame');
    await page.keyboard.press('Enter');
    await adv(page, 1);
    assert.equal((await info(page)).paused, false);
    assert.equal((await info(page)).frame, f1, 'the resume tick runs no sim frame');
    await page.keyboard.press('ArrowUp');              // a same-bit press on the first resumed frame: packed one frame later
    await adv(page, 1); await adv(page, 1);
    const w = (await words(page)).slice(f1);
    assert.deepEqual(w, [0, 64], 'the press after the resume is packed one frame later, never swallowed: ' + JSON.stringify(w));
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('a lost focus pauses the run (M13)', { timeout: 60000 }, async () => {
  const { ctx, page, problems } = await open({ frozen: true });
  try {
    await page.evaluate(() => SL.start(2));
    await untilPiece(page);
    assert.equal((await info(page)).paused, false);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    assert.equal((await info(page)).paused, true, 'blur paused the run');
    const f = (await info(page)).frame;
    await adv(page, 5);
    assert.equal((await info(page)).frame, f, 'no sim frame after the blur');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('the HUD score drawn equals SL.info().score on every drawn frame of a scoring stretch (M11)', { timeout: 90000 }, async () => {
  const { ctx, page, problems } = await open({ frozen: true });
  try {
    await page.evaluate(async () => { SL.start(1); SL.setHeights([3, 3, 3, 3, 0, 3, 3, 3, 3]); await window.__adv(2); });
    const drawn = () => page.evaluate(async () => {
      window.__tlog = []; await window.__adv(0);
      const t = window.__tlog; window.__tlog = null;
      const s = t.find(a => a[1] === 22 && a[2] === 56);
      return { hud: s ? s[0] : null, score: String(SL.info().score) };
    });
    const seen = new Set();
    let frames = 0;
    for (let k = 0; k < 14; k++) {
      await page.evaluate(k => SL.place([3, 3, 3, 0, 8, 5, 2, 6, 4, 1, 7, 3, 0, 5][k], k % 2), k);
      for (let j = 0; j < 3; j++) {
        const d = await drawn(); frames++;
        assert.equal(d.hud, d.score, 'frame ' + frames + ': HUD ' + d.hud + ', sim ' + d.score);
        seen.add(d.score);
        if (j === 1) await adv(page, 1);
      }
      if ((await info(page)).done) break;
    }
    assert.ok(seen.size >= 3, 'the stretch scored (distinct scores seen: ' + [...seen].join(',') + ')');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('the active piece is drawn interpolated between sim ticks (M08)', { timeout: 60000 }, async () => {
  const { ctx, page, problems } = await open({ frozen: true });
  try {
    await page.evaluate(() => SL.start(1));
    await untilPiece(page);
    const col0 = (await info(page)).piece.col;
    await page.keyboard.down('ArrowRight');
    await adv(page, 1);                                  // one tick: the piece moves one column right
    assert.equal((await info(page)).piece.col, col0 + 1);
    // the white core dot of each piece cell (size 2.4, alpha .95): its mean x is the piece's drawn x
    const meanX = ds => { const c = ds.filter(d => near(d[2], 2.4) && near(d[6], 0.95) && d[3] === 1 && d[4] === 1 && d[5] === 1 && inBoard(d)); assert.ok(c.length >= 3, 'piece cores drawn: ' + c.length); return c.reduce((a, d) => a + d[0], 0) / c.length; };
    const x0 = meanX(await dots(page, 0));               // alpha about 0: still at the old column
    const x1 = meanX(await dots(page, 0.5));             // alpha .5: half a column on
    const x2 = meanX(await dots(page, 0.49));            // alpha about 1: at the new column
    await page.keyboard.up('ArrowRight');
    assert.ok(near(x1 - x0, 6.5, 0.4), 'half a column (6.5) between alpha 0 and .5: ' + (x1 - x0).toFixed(2));
    assert.ok(near(x2 - x1, 6.5, 0.4), 'half a column (6.5) between alpha .5 and 1: ' + (x2 - x1).toFixed(2));
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('the CRT menu toggle reaches the CRT pass, on the title and in a run (M17)', { timeout: 60000 }, async () => {
  const { ctx, page, problems } = await open({ frozen: true });
  try {
    await adv(page, 1);
    assert.equal(await page.evaluate(() => window.__crtOn), true, 'CRT on by default');
    await page.keyboard.press('ArrowDown'); await adv(page, 1);
    await page.keyboard.press('Enter'); await adv(page, 1);
    await adv(page, 0);
    assert.equal((await info(page)).crt, false);
    assert.equal(await page.evaluate(() => window.__crtOn), false, 'CRT pass off after the toggle');
    await page.keyboard.press('ArrowUp'); await adv(page, 1);
    await page.keyboard.press('Enter'); await adv(page, 1); // FREE PLAY: a run, CRT still off
    assert.equal((await info(page)).app, 'play');
    await adv(page, 3);
    assert.equal(await page.evaluate(() => window.__crtOn), false, 'CRT pass still off in a run');
    await page.keyboard.press('KeyP'); await adv(page, 1);
    await page.keyboard.press('Escape'); await adv(page, 1);  // back to the title
    assert.equal((await info(page)).app, 'title');
    await page.keyboard.press('ArrowDown'); await adv(page, 1);
    await page.keyboard.press('Enter'); await adv(page, 2);
    assert.equal(await page.evaluate(() => window.__crtOn), true, 'CRT back on');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('drawn output: melt drip, particles, GLOW rings and the light shaft are on screen (M20, M19, M21, M23)', { timeout: 120000 }, async () => {
  const { ctx, page, problems } = await open({ frozen: true });
  try {
    // melt drip: a BAR over a hole slides its middle cell down with a trail (row 0 is not completed, so nothing clears)
    await page.evaluate(async () => { SL.start(1); SL.setHeights([3, 3, 0, 3, 3, 3, 3, 3, 0]); await window.__adv(2); SL.place(2, 0); });
    let f = await page.evaluate(() => SL.fx());
    assert.ok(f.melt > 0 && f.lockAge >= 0 && f.lockAge < 8 && f.clearMask === 0, 'inside the drip, no clear: ' + JSON.stringify(f));
    let d = await dots(page, 0);
    const trail = d.filter(x => near(x[2], 1.8) && isCol(x, BAR_COL) && near(x[0], 174, 0.5)); // the sliding cell's first trail dot, column 2
    assert.ok(trail.length >= 1, 'melt drip trail drawn: ' + trail.length);
    // particles: a cleared row scatters dots once the flash is over
    await page.evaluate(async () => { SL.start(1); SL.setHeights([3, 3, 3, 3, 0, 3, 3, 3, 3]); await window.__adv(2); SL.place(3, 0); });
    const spark = ds => ds.filter(x => inBoard(x) && x[1] > 20 && x[1] < 276 && x[2] >= 1.55 && x[2] <= 3.5 && !isCellDot(x) && !near(x[2], 1.9) && !near(x[2], 1.6, 0.0005) && x[6] > 0.05);
    d = await dots(page, 0);
    assert.equal(spark(d).length, 0, 'no sparks while the rows still flash');
    d = await dots(page, 9);                             // flash over (6 frames), sparks in flight
    f = await page.evaluate(() => SL.fx());
    assert.ok(f.particles >= 20 && f.clearAge >= 8, 'sparks alive: ' + JSON.stringify(f));
    assert.ok(spark(d).length >= 10, 'sparks drawn: ' + spark(d).length + ' of ' + f.particles);
    // GLOW rings: two clears lit ring 1 (6 dots) and ring 2 (12 dots), size 1.4 around (112, 222)
    await page.evaluate(async () => { SL.place(3, 0); SL.place(3, 0); await window.__adv(1); });
    const g = (await info(page)).glow;
    assert.ok(g >= 2, 'GLOW lit: ' + g);
    d = await dots(page, 0);
    const lit = d.filter(x => near(x[2], 1.4) && near(x[0], 112, 26) && near(x[1], 222, 26));
    assert.equal(lit.length, 6 * g * (g + 1) / 2, 'lit GLOW ring dots for GLOW ' + g);
    await shot(page, 'drawn-glow-test');
    // light shaft: faint dots down the piece's columns (size 1.1) and the landing cells outlined (size .9, alpha .32)
    await page.evaluate(async () => { SL.start(1); await window.__adv(2); });
    await untilPiece(page);
    d = await dots(page, 0);
    const shaft = d.filter(x => near(x[2], 1.1) && x[6] > 0.15 && x[6] < 0.27 && inBoard(x));
    const landing = d.filter(x => near(x[2], 0.9) && near(x[6], 0.32, 0.01) && inBoard(x));
    assert.ok(shaft.length >= 30, 'light shaft dots: ' + shaft.length);
    assert.ok(landing.length >= 30, 'landing outline dots: ' + landing.length);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('game over: the topped-out piece is burnt out like the stack, the panel has a clear backdrop (L1, L2); SL.place after leaving to the title does nothing (L4)', { timeout: 90000 }, async () => {
  const { ctx, page, problems } = await open({ frozen: true });
  try {
    await page.evaluate(() => { SL.start(99); let n = 0; while (!SL.info().done && n++ < 40) SL.place(4, 1); });
    assert.equal((await info(page)).app, 'over');
    await adv(page, 70);                                  // the burn-out has run (2 frames a row) and the panel is up
    const d = await dots(page, 0);
    const cells = d.filter(x => inBoard(x) && isCellDot(x));
    assert.ok(cells.length > 100, 'the grey stack is drawn: ' + cells.length);
    assert.equal(d.filter(x => near(x[2], 2.4) && x[3] === 1 && x[4] === 1 && x[5] === 1 && near(x[6], 0.95)).length, 0, 'no lit white core left in the field (L1)');
    const notGrey = cells.filter(x => !isCol(x, STEEL));
    assert.equal(notGrey.length, 0, 'every cell is burnt out grey, the topped-out piece too (L1): ' + JSON.stringify(notGrey.slice(0, 3)));
    const behind = cells.filter(x => x[1] >= 96 && x[1] <= 206);
    assert.equal(behind.length, 0, 'no stack cell behind the result panel (L2): ' + behind.length);
    const t = await page.evaluate(async () => { window.__tlog = []; await window.__adv(0); const o = window.__tlog.map(a => a[0]); window.__tlog = null; return o; });
    assert.ok(t.includes('TOP OUT') && t.includes('ENTER: TITLE'), 'panel text drawn: ' + JSON.stringify(t));
    await shot(page, 'over-test');
    // A run left to the title is not stepped by SL.place
    await page.evaluate(() => SL.start(5));
    await untilPiece(page);
    await page.keyboard.press('Escape'); await adv(page, 1);
    assert.equal((await info(page)).paused, true);
    await page.keyboard.press('Escape'); await adv(page, 1);
    assert.equal((await info(page)).app, 'title');
    const f0 = (await info(page)).frame, h0 = await page.evaluate(() => SL.hash());
    assert.equal(await page.evaluate(() => SL.place(4, 0)), null, 'SL.place returns null on the title');
    assert.equal((await info(page)).frame, f0, 'no sim frame from SL.place on the title');
    assert.equal(await page.evaluate(() => SL.hash()), h0);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

// ---------- allocation ----------
// Chrome's sampling heap profiler at a 4 byte interval (every object is seen), objects freed by GC included, summed per
// function in the STACKLIGHT files this slice owns. The scenario is steady (a falling piece, no input), so each function's
// bytes per frame are the same run to run (measured spread under 1 B); each budget is that number plus 16 B, which a
// single small object (an empty object is 28 B and up, a two element array 48 B) or a boxed double pair breaks.
const OWN = /games\/stacklight\/(main\.js|hooks\.js|render\.js|render\/\w+\.js)$/;
const BUDGET = { 'render.js shapeAt': 140, 'render.js piece': 62, 'render.js drawPads': 125, 'render.js board': 30, 'render.js drawRun': 30, 'main.js render': 30, 'render/fx.js age': 26, 'render/geom.js rowY': 18, 'render.js popups': 18, 'render.js cell': 18 };
const OTHER = 16; // any other function in those files
async function heapProfile(page, ctx, frameCount = 600) {
  const frames = k => page.evaluate(k => new Promise(r => { let f = 0; const t = () => { if (++f >= k) r(); else requestAnimationFrame(t); }; requestAnimationFrame(t); }), k);
  await frames(200); // warm: the hot functions are optimised
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 4, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  const f0 = await page.evaluate(() => SL.hud().F);
  await frames(frameCount);
  const { profile } = await cdp.send('HeapProfiler.stopSampling');
  const n = (await page.evaluate(() => SL.hud().F)) - f0;
  const by = {};
  const walk = node => {
    const m = (node.callFrame.url || '').match(OWN);
    if (node.selfSize && m) { const k = m[1] + ' ' + node.callFrame.functionName; by[k] = (by[k] || 0) + node.selfSize; }
    for (const c of node.children) walk(c);
  };
  walk(profile.head);
  for (const k of Object.keys(by)) by[k] /= n;
  return { n, by, total: Object.values(by).reduce((a, b) => a + b, 0) };
}
function overBudget(by) {
  return Object.entries(by).filter(([k, v]) => v > (BUDGET[k] !== undefined ? BUDGET[k] : OTHER)).map(([k, v]) => k + ' ' + v.toFixed(1) + ' B/frame (budget ' + (BUDGET[k] !== undefined ? BUDGET[k] : OTHER) + ')');
}

test('allocation per function in main.js, hooks.js and the render files stays within budget over 600 frames, desktop (M06, M07, M26)', { timeout: 120000 }, async t => {
  const { ctx, page, problems } = await open({ taps: false });
  try {
    await page.evaluate(() => SL.start(3));
    const { n, by, total } = await heapProfile(page, ctx);
    t.diagnostic('desktop: ' + n + ' frames, own files ' + total.toFixed(0) + ' B/frame; ' + JSON.stringify(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, +v.toFixed(1)]))));
    assert.ok(n >= 590, 'sampled frames ' + n);
    assert.deepEqual(overBudget(by), [], 'functions over their allocation budget');
    assert.ok(total < 1024, 'render files under 1 KB a frame: ' + total.toFixed(0));
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('allocation per function, touch at 844x390 with a pad held: render files stay under 1 KB a frame and within budget (MED 3)', { timeout: 120000 }, async t => {
  const { ctx, page, problems } = await open({ w: 844, h: 390, touch: true, taps: false });
  try {
    await page.evaluate(() => SL.start(3));
    const v = await page.evaluate(() => SL.view());
    const left = v.pads.find(p => p.name === 'left'), cdp = await ctx.newCDPSession(page);
    // a finger held on the left pad: the pad is lit (fill dots, white icon) and the piece auto-repeats to the wall
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: left.x + left.w / 2, y: left.y + left.h / 2 }] });
    const { n, by, total } = await heapProfile(page, ctx);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    t.diagnostic('touch: ' + n + ' frames, own files ' + total.toFixed(0) + ' B/frame; ' + JSON.stringify(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, +v.toFixed(1)]))));
    assert.equal((await info(page)).touchUi, true);
    assert.ok(n >= 590, 'sampled frames ' + n);
    assert.ok(total < 1024, 'render files under 1 KB a frame in touch mode: ' + total.toFixed(0));
    assert.deepEqual(overBudget(by), [], 'functions over their allocation budget');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

// ---------- touch pads ----------
test('touch pads: drawn only in the side bands, inside their boxes, a held pad is lit (844x390)', { timeout: 90000 }, async () => {
  const { ctx, page, problems } = await open({ w: 844, h: 390, touch: true, frozen: true });
  try {
    await page.evaluate(() => SL.start(3));
    await untilPiece(page);
    const v = await page.evaluate(() => SL.view());
    const toField = p => ({ x: (p.x - v.field.x) / v.scale, y: (p.y - v.field.y) / v.scale, w: p.w / v.scale, h: p.h / v.scale });
    const boxes = v.pads.map(toField);
    const padDots = ds => ds.filter(d => d[0] < 0 || d[0] > 400);
    const inBox = (d, b) => d[0] >= b.x - 1 && d[0] <= b.x + b.w + 1 && d[1] >= b.y - 1 && d[1] <= b.y + b.h + 1;
    let d = padDots(await dots(page, 0));
    assert.ok(d.length > 150, 'pad dots drawn: ' + d.length);
    assert.ok(d.every(x => boxes.some(b => inBox(x, b))), 'every pad dot lies inside a pad box');
    for (let i = 0; i < boxes.length; i++) assert.ok(d.filter(x => inBox(x, boxes[i])).length >= 20, v.pads[i].name + ' pad drawn');
    const right = v.pads.findIndex(p => p.name === 'right'), cdp = await ctx.newCDPSession(page);
    const idleFill = d.filter(x => inBox(x, boxes[right]) && near(x[6], 0.18)).length, idleWhite = d.filter(x => inBox(x, boxes[right]) && x[3] === 1 && x[4] === 1 && x[5] === 1).length;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: v.pads[right].x + v.pads[right].w / 2, y: v.pads[right].y + v.pads[right].h / 2 }] });
    d = padDots(await dots(page, 0));
    const heldFill = d.filter(x => inBox(x, boxes[right]) && near(x[6], 0.18)).length, heldWhite = d.filter(x => inBox(x, boxes[right]) && x[3] === 1 && x[4] === 1 && x[5] === 1).length;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(idleFill, 0); assert.equal(idleWhite, 0);
    assert.ok(heldFill > 20, 'held pad filled: ' + heldFill);
    assert.ok(heldWhite > 10, 'held pad icon white: ' + heldWhite);
    // after a resize the pads follow the new layout
    await page.setViewportSize({ width: 667, height: 375 });
    await page.waitForFunction(() => Math.abs(SL.view().band - 112) < 1, null, WAIT);
    const v2 = await page.evaluate(() => SL.view());
    const boxes2 = v2.pads.map(p => ({ x: (p.x - v2.field.x) / v2.scale, y: (p.y - v2.field.y) / v2.scale, w: p.w / v2.scale, h: p.h / v2.scale }));
    d = padDots(await dots(page, 0));
    assert.ok(d.length > 100 && d.every(x => boxes2.some(b => inBox(x, b))), 'pads redrawn in the new layout: ' + d.length);
    await shot(page, 'touch-667x375-test');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});
