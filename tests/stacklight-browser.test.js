// STACKLIGHT T3 (design F.1 row T3): the real stacklight.html in headless Chrome, driven by real key and touch events and
// window.SL, never by importing the page's modules into Node.
//   1. F.1 verify: SL.start(1); SL.setLines(16); SL.setHeights([1,1,1,1,0,1,1,1,1]); then a PLUS at column 4: level 3, the
//      KEY popup over the notch drawn, the row flash drawn, 660 in the HUD (font tap window.__texts and SL.hud()).
//      Seed 1 deals BAR, BAR, PLUS, so the two BARs go upright on the wall columns first (0 points, no clear, no fit).
//   2. Enter on the title starts a run whose first word is 0, and Enter held into the run never hard drops.
//   3. Pause then resume: presses made while paused never reach the sim; a press after resume is not dropped; a hidden
//      tab pauses the run.
//   4. The browser's stateHash equals a Node re-sim of the browser's own replay after about 2,000 frames of random keys.
//   5. Zero arrays or typed arrays built per frame while playing, paused, over and on the title (the same Proxy-count pattern as the other browser tests).
//   6. Touch: 844x390 pads drawn only in the side bands; 390x844 shows the shared turn-sideways screen and holds the run.
//   7. SL.setHeights with bad input throws and the run carries on.
//   8. Heap sampling: the renderer allocates under 1 KB a frame over 600 warm frames (heap numbers included).
//   The random-keys run in 4 must reach 2,000 frames without topping out.
// Every page: console clean except the favicon 404. Screenshots go to W49_SHOT_DIR when it is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticServer, WAIT, ROOT } from './w25-helpers.mjs';
import { decode } from '../engine/replay.js';
import { createSim } from '../games/stacklight/sim.js';

const SHOT_DIR = process.env.W49_SHOT_DIR || null;
const FONT_SRC = fs.readFileSync(path.join(ROOT, 'engine/font.js'), 'utf8');
const TAP = 'return function text(str, x, y, col, sc, align, a, wave) {';
if (!FONT_SRC.includes(TAP)) throw new Error('engine/font.js no longer has the text() entry the tap wraps');
const FONT_TAPPED = FONT_SRC.replace(TAP, TAP + ' if (window.__texts) window.__texts.add(str);');

// Frame control for exact moments: __freeze() holds the page's rAF chain (no tick, no render); __drawOnce() renders one
// frame with no time passing (dt 0: no sim frame); __thaw() lets it run again with the frozen time taken out.
const FREEZE = `(() => {
  const real = window.requestAnimationFrame.bind(window);
  let frozen = false, held = null, lastPassed = 0, offset = 0, thawed = false;
  window.requestAnimationFrame = cb => real(t => {
    if (frozen) { held = cb; return; }
    if (thawed) { thawed = false; offset = t - (lastPassed + 1000 / 60); }
    lastPassed = t - offset; cb(lastPassed);
  });
  window.__freeze = () => new Promise(r => { frozen = true; const chk = () => (held ? r() : setTimeout(chk, 4)); chk(); });
  window.__drawOnce = () => { const cb = held; held = null; cb(lastPassed); return new Promise(r => setTimeout(r, 30)); };
  window.__thaw = () => { frozen = false; thawed = true; const cb = held; held = null; if (cb) window.requestAnimationFrame(cb); };
})();`;

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

async function open({ w = 1000, h = 750, touch = false, init = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch });
  await ctx.route('**/engine/font.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: FONT_TAPPED }));
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) problems.push('HTTP ' + r.status() + ' ' + r.url()); });
  await page.addInitScript('window.__texts = new Set();');
  await page.addInitScript(FREEZE);
  if (init) await page.addInitScript(init);
  await page.goto(web.url + 'stacklight.html');
  await page.waitForFunction(() => window.SL && SL.info().app === 'title' && SL.hud().F > 5, null, WAIT);
  return { ctx, page, problems };
}
const shot = async (page, name) => { if (!SHOT_DIR) return; fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') }); };
const frames = (page, k) => page.evaluate(k => new Promise(r => { let f = 0; const t = () => { if (++f >= k) r(); else requestAnimationFrame(t); }; requestAnimationFrame(t); }), k);
const words = async page => { const s = await page.evaluate(() => SL.replay()); return s ? Array.from(decode(s).words) : null; };
// mean brightness (0..255) of a CSS-px rectangle in a screenshot, decoded by the browser itself
async function brightness(page, png, x, y, w, h) {
  return page.evaluate(async ({ b64, x, y, w, h }) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(x, y, w, h).data; let s = 0;
    for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
    return s / (d.length / 4);
  }, { b64: png.toString('base64'), x, y, w, h });
}

test('F.1 T3 verify: PLUS at column 4 gives level 3, KEY over the notch, the row flash and 660 in the HUD, all drawn', { timeout: 90000 }, async () => {
  const { ctx, page, problems } = await open();
  try {
    const out = await page.evaluate(async () => {
      await window.__freeze();
      SL.start(1); SL.setLines(16); SL.setHeights([1, 1, 1, 1, 0, 1, 1, 1, 1]);
      const placed = [SL.place(0, 1), SL.place(8, 1), SL.place(4, 0)];
      window.__texts.clear();
      await window.__drawOnce();
      const i = SL.info();
      return { placed, level: i.level, lines: i.lines, score: i.score, mode: i.mode, fx: SL.fx(), hud: SL.hud(), texts: [...window.__texts] };
    });
    assert.deepEqual(out.placed.map(p => [p.type, p.ok]), [['BAR', true], ['BAR', true], ['PLUS', true]], JSON.stringify(out.placed));
    assert.equal(out.mode, 'test');
    assert.equal(out.level, 3, 'SL.info().level === 3');
    assert.equal(out.lines, 17);
    assert.equal(out.score, 660, 'KEY 360 + one row 300');
    // KEY popup over the notch: column 4 (x 200), above the notch row
    assert.equal(out.fx.fit, 2, 'the lock was a KEY');
    assert.equal(out.fx.lockCol, 4);
    const key = out.fx.popups.find(p => p.kind === 'fit');
    assert.ok(key && key.text === 'KEY' && key.x === 200 && key.y < 267.5, 'KEY popup over the notch: ' + JSON.stringify(out.fx.popups));
    assert.ok(out.texts.includes('KEY'), 'KEY drawn in the 5x7 font: ' + JSON.stringify(out.texts));
    // row flash: row 0 cleared, still inside the 6 flash frames when drawn
    assert.equal(out.fx.clearMask, 1, 'row 0 cleared');
    assert.ok(out.fx.clearAge >= 0 && out.fx.clearAge < 6, 'drawn during the flash, age ' + out.fx.clearAge);
    // 660 in the HUD: drawn by the font and the HUD's own string
    assert.equal(out.hud.score, '660'); assert.equal(out.hud.level, '3'); assert.equal(out.hud.lines, '17');
    assert.ok(out.texts.includes('660') && out.texts.includes('SCORE') && out.texts.includes('LEVEL'), 'HUD drawn: ' + JSON.stringify(out.texts));
    // the flash is really on screen: row 0 of the board (field y 261 to 274, centre 267.5) is much brighter than an empty
    // row higher up. At 1000x750 a field unit is 2.5 px; the CRT pass draws the field 1 / 1.1 the size about the centre,
    // so row 0's centre lands near y = 375 + (267.5 / 150 - 1) / 1.1 * 375 = 642 px.
    const png = await page.screenshot();
    if (SHOT_DIR) { fs.mkdirSync(SHOT_DIR, { recursive: true }); fs.writeFileSync(path.join(SHOT_DIR, 'verify-test.png'), png); }
    const row0 = await brightness(page, png, 385, 634, 230, 16), empty = await brightness(page, png, 385, 300, 230, 16);
    assert.ok(row0 > 60 && row0 > empty * 5, 'row flash drawn: row 0 brightness ' + row0.toFixed(1) + ', empty row ' + empty.toFixed(1));
    await page.evaluate(() => window.__thaw());
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('Enter on the title starts a run with first word 0; Enter held into the run never hard drops', { timeout: 60000 }, async () => {
  const { ctx, page, problems } = await open();
  try {
    await page.keyboard.down('Enter');
    await page.waitForFunction(() => SL.info().app === 'play', null, WAIT);
    await page.waitForTimeout(400); // Enter still held
    await page.keyboard.up('Enter');
    await page.waitForTimeout(150);
    await page.keyboard.press('KeyP');
    await page.waitForFunction(() => SL.info().paused === true, null, WAIT);
    const i = await page.evaluate(() => SL.info());
    const w = await words(page);
    assert.equal(i.mode, 'arcade');
    assert.ok(w.length > 20 && w.length === i.frame, 'frames recorded: ' + w.length);
    assert.equal(w[0], 0, 'first word 0');
    assert.ok(w.every(x => (x & 32) === 0), 'no hard drop bit while Enter was held from the title');
    assert.equal(i.spawned, 1, 'still the first piece');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('pause then resume: presses made while paused never fire, a press after resume is not dropped, a hidden tab pauses', { timeout: 60000 }, async () => {
  const { ctx, page, problems } = await open();
  try {
    await page.evaluate(() => SL.start(1)); // first piece: a BAR (it can turn)
    await page.waitForFunction(() => SL.info().piece && SL.info().piece.type === 'BAR', null, WAIT);
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => SL.info().piece.rot === 1, null, WAIT);
    await page.keyboard.press('KeyP'); // down and up inside one frame
    await page.waitForFunction(() => SL.info().paused === true, null, WAIT);
    const f0 = (await page.evaluate(() => SL.info())).frame;
    // (Space and Enter are FIRE, which resumes; these keys do not)
    for (const k of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'KeyX', 'ArrowDown']) { await page.keyboard.press(k); await page.waitForTimeout(30); }
    await page.waitForTimeout(250);
    let i = await page.evaluate(() => SL.info());
    assert.equal(i.frame, f0, 'no sim frame while paused');
    await page.keyboard.press('Enter'); // resume with Enter: its hard-drop latch must not reach the sim
    await page.waitForFunction(() => SL.info().paused === false, null, WAIT);
    await page.waitForTimeout(250);
    i = await page.evaluate(() => SL.info());
    let w = await words(page);
    assert.ok(i.frame > f0 + 5, 'running again');
    assert.ok(w.slice(f0).every(x => (x & 0x78) === 0), 'no stale press after resume: ' + JSON.stringify(w.slice(f0, f0 + 12)));
    assert.equal(i.spawned, 1); assert.equal(i.piece.rot, 1); assert.equal(i.piece.col, 4);
    // a press after resume is not dropped
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => SL.info().piece.rot === 0, null, WAIT);
    w = await words(page);
    assert.equal(w.slice(f0).filter(x => x & 64).length, 1, 'exactly one turn press after resume');
    // a hidden tab pauses the run
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(await page.evaluate(() => SL.info().paused), true, 'hidden tab paused the run');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => SL.info().paused), true, 'still paused when the tab is back');
    {
      await page.evaluate(() => window.__texts.clear()); await frames(page, 4);
      const t = await page.evaluate(() => [...window.__texts]);
      assert.ok(t.includes('PAUSED'), 'pause screen drawn: ' + JSON.stringify(t));
    }
    await shot(page, 'pause-test');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('browser stateHash equals a Node re-sim of the browser replay after about 2,000 frames of random keys', { timeout: 120000 }, async () => {
  const { ctx, page, problems } = await open();
  try {
    await page.evaluate(() => SL.start(424242));
    let s = 0x2545f491;
    const rnd = n => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) % n; };
    // a gentler mix so the run reaches 2,000 frames instead of topping out. Random presses and held keys as
    // before (moves, turns, soft drop, auto-repeat), plus a steer: 3 actions in 10 move the piece toward a target column
    // that changes per piece (0, 4, 8, 3, 7, 2, 6, 1, 5: spread across the board) and hard drop it there, at most once a
    // second. Every key still goes through real key events; the hard drop bit is still exercised.
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'KeyA', 'KeyD', 'KeyX'];
    const held = new Set();
    let lastDrop = -999;
    for (;;) {
      const i = await page.evaluate(() => SL.info());
      if (i.done || i.frame >= 2000) break;
      if (held.size && rnd(2)) { for (const k of held) await page.keyboard.up(k); held.clear(); }
      if (rnd(10) < 3) {
        if (i.piece) {
          const target = (i.spawned * 4) % 9;
          if (i.piece.col < target) await page.keyboard.press('ArrowRight');
          else if (i.piece.col > target) await page.keyboard.press('ArrowLeft');
          else if (i.frame - lastDrop > 60) { await page.keyboard.press('Space'); lastDrop = i.frame; }
        }
      } else {
        const k = keys[rnd(keys.length)];
        if (held.has(k)) { await page.keyboard.up(k); held.delete(k); }
        else if (k === 'ArrowUp' || k === 'KeyX') await page.keyboard.press(k);
        else { await page.keyboard.down(k); held.add(k); }
      }
      await page.waitForTimeout(rnd(40));
    }
    for (const k of held) await page.keyboard.up(k);
    const done = await page.evaluate(() => SL.info().done);
    if (!done) { await page.keyboard.press('KeyP'); await page.waitForFunction(() => SL.info().paused === true, null, WAIT); }
    const b = await page.evaluate(() => ({ replay: SL.replay(), hash: SL.hash(), info: SL.info() }));
    const r = decode(b.replay);
    assert.equal(r.frames, b.info.frame);
    assert.ok(r.frames >= 2000 || b.info.done, 'frames ' + r.frames);
    // the run must really reach 2,000 frames (not top out early)
    assert.ok(r.frames >= 2000 && !b.info.done, 'reached 2,000 frames without topping out: frames ' + r.frames + ', done ' + b.info.done);
    assert.ok(r.words.some(x => x & 32), 'the run had hard drops');
    const sim = createSim({ seed: r.seed, mode: r.mode });
    for (let k = 0; k < r.frames; k++) sim.step(r.words[k]);
    assert.equal(sim.stateHash(), b.hash, 'browser and Node hashes');
    assert.equal(sim.score, b.info.score); assert.equal(sim.lines, b.info.lines);
    assert.ok(r.words.some(x => x & 0x78), 'the run had presses');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('zero allocation per frame: no arrays or typed arrays built while playing (clear, particles, shaft, held key), paused, over, title', { timeout: 120000 }, async () => {
  const COUNT = `(() => {
    window.__alloc = 0; window.__count = false; window.__allocBy = {};
    for (const n of ['Float32Array', 'Float64Array', 'Int8Array', 'Int16Array', 'Int32Array', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Array']) {
      const Orig = window[n];
      window[n] = new Proxy(Orig, { construct(t, a, nt) { if (window.__count) { window.__alloc++; window.__allocBy[n] = (window.__allocBy[n] || 0) + 1; } return Reflect.construct(t, a, nt); },
        apply(t, th, a) { if (window.__count) { window.__alloc++; window.__allocBy[n] = (window.__allocBy[n] || 0) + 1; } return Reflect.apply(t, th, a); } });
    }
  })();`;
  const { ctx, page, problems } = await open({ init: COUNT });
  const counted = async k => {
    await page.evaluate(() => { window.__alloc = 0; window.__allocBy = {}; window.__count = true; });
    await frames(page, k);
    return page.evaluate(() => { window.__count = false; return { n: window.__alloc, by: window.__allocBy }; });
  };
  try {
    assert.deepEqual(await counted(60), { n: 0, by: {} }, 'title');
    // play: the verify start, so a clear (flash, fade, particles, popups) and the drip run inside the count
    await page.evaluate(async () => {
      await window.__freeze();
      SL.start(1); SL.setLines(16); SL.setHeights([1, 1, 1, 1, 0, 1, 1, 1, 1]);
      SL.place(0, 1); SL.place(8, 1); SL.place(4, 0);
      window.__thaw();
    });
    await page.keyboard.down('ArrowLeft'); // a held key: auto-repeat moves and the light shaft every frame
    const play = await counted(150);
    await page.keyboard.up('ArrowLeft');
    const fx = await page.evaluate(() => SL.fx());
    assert.ok(fx.lockAge > 60, 'the clear ran inside the count (age ' + fx.lockAge + ')');
    assert.deepEqual(play, { n: 0, by: {} }, 'playing');
    await page.evaluate(() => SL.start(99));
    await frames(page, 30);
    await page.keyboard.press('KeyP');
    await page.waitForFunction(() => SL.info().paused === true, null, WAIT);
    assert.deepEqual(await counted(60), { n: 0, by: {} }, 'paused');
    // over: a top out (upright bars in the middle column), then the result screen
    await page.keyboard.press('KeyP');
    await page.evaluate(() => { let n = 0; while (!SL.info().done && n++ < 40) SL.place(4, 1); });
    await page.waitForFunction(() => SL.info().app === 'over', null, WAIT);
    await frames(page, 10);
    assert.deepEqual(await counted(90), { n: 0, by: {} }, 'over');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('heap sampling over 600 warm frames: the STACKLIGHT renderer allocates under 1 KB a frame (w49b)', { timeout: 120000 }, async t => {
  // The array test above cannot see heap numbers: a double passed to gfx.dot from code where the compiler did not inline
  // dot is boxed into a new heap number. Chrome's sampling heap profiler (CDP, every 64 bytes on average, objects freed
  // by minor and major GC included) sees them. Before the fix the renderer made about 9 KB a frame this way (frame,
  // outline, glowMeter, box); the tagged tables in render.js remove those. The bound is per frame over 600 frames.
  const { ctx, page, problems } = await open();
  try {
    // GLOW 2 lit (two clears inside the timer), then a held key: shaft, landing outline, meter and frame every frame
    const g = await page.evaluate(async () => {
      await window.__freeze();
      SL.start(1); SL.setHeights([3, 3, 3, 3, 0, 3, 3, 3, 3]); SL.place(3, 0); SL.place(3, 0); SL.place(3, 0);
      window.__thaw();
      return SL.info().glow;
    });
    assert.ok(g >= 2, 'GLOW lit for the sample: ' + g);
    await page.keyboard.down('ArrowRight');
    await frames(page, 120); // warm: the hot functions are optimised
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 64, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
    const f0 = await page.evaluate(() => SL.hud().F);
    await frames(page, 600);
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    const n = (await page.evaluate(() => SL.hud().F)) - f0;
    await page.keyboard.up('ArrowRight');
    const by = {};
    let total = 0;
    const walk = node => {
      const u = node.callFrame.url || '';
      if (node.selfSize) { total += node.selfSize; const m = u.match(/games\/stacklight\/(render\.js|render\/\w+\.js)$/); if (m) by[m[1] + ' ' + node.callFrame.functionName] = (by[m[1] + ' ' + node.callFrame.functionName] || 0) + node.selfSize; }
      for (const c of node.children) walk(c);
    };
    walk(profile.head);
    const render = Object.values(by).reduce((a, b) => a + b, 0) / n;
    t.diagnostic('frames ' + n + '; renderer ' + render.toFixed(0) + ' B/frame; whole page ' + (total / n).toFixed(0) + ' B/frame; by function ' +
      JSON.stringify(Object.fromEntries(Object.entries(by).map(([k, v]) => [k, Math.round(v / n)]))));
    assert.ok(n >= 590, 'sampled frames ' + n);
    assert.ok(render < 1024, 'renderer allocation per frame ' + render.toFixed(0) + ' B: ' + JSON.stringify(by));
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('touch: 844x390 draws the five pads only in the side bands; 390x844 shows the turn-sideways screen and holds the run', { timeout: 90000 }, async () => {
  const { ctx, page, problems } = await open({ w: 844, h: 390, touch: true });
  try {
    await page.evaluate(() => SL.start(3));
    await frames(page, 10);
    await page.evaluate(() => window.__texts.clear()); await frames(page, 4);
    const v = await page.evaluate(() => SL.view());
    assert.equal(v.touchUi, true);
    assert.ok(Math.abs(v.band - 162) < 1 && Math.abs(v.field.w - 520) < 1 && Math.abs(v.field.h - 390) < 1, 'E table, 844 x 390: ' + JSON.stringify(v));
    assert.equal(v.padsDrawn, 5);
    assert.ok(v.F - v.padsDrawnF <= 3, 'pads drawn in the last frames');
    for (const p of v.pads) {
      assert.ok(p.x + p.w <= v.field.x || p.x >= v.field.x + v.field.w, p.name + ' is outside the field: ' + JSON.stringify(p));
      assert.ok(p.w >= 44 && p.h >= 44, p.name + ' at least 44 px');
    }
    // the GL field is exactly the layout's field (so drawn pads and hit areas match)
    assert.ok(Math.abs(v.gl.x / v.gl.dpr - v.field.x) <= 1 && Math.abs(v.gl.w / v.gl.dpr - v.field.w) <= 1, 'GL view ' + JSON.stringify(v.gl));
    const t = await page.evaluate(() => [...window.__texts]);
    assert.ok(t.includes('TURN') && t.includes('DROP') && t.includes('SOFT'), 'pad labels drawn: ' + JSON.stringify(t));
    // a real tap on the right-move pad moves the piece one column
    const col0 = (await page.evaluate(() => SL.info())).piece.col, right = v.pads.find(p => p.name === 'right');
    await page.touchscreen.tap(right.x + right.w / 2, right.y + right.h / 2);
    await page.waitForFunction(c => SL.info().piece && SL.info().piece.col === c + 1, col0, WAIT);
    await shot(page, 'touch-844x390');
    // upright: the shared screen, the run is held
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => SL.view().rotateShown === true && SL.info().paused === true, null, WAIT);
    const f0 = (await page.evaluate(() => SL.info())).frame;
    await page.evaluate(() => window.__texts.clear()); await page.waitForTimeout(300);
    const t2 = await page.evaluate(() => [...window.__texts]);
    assert.ok(t2.includes('TURN YOUR PHONE') && t2.includes('SIDEWAYS') && t2.includes('YOUR RUN IS PAUSED'), 'turn-sideways screen drawn: ' + JSON.stringify(t2));
    assert.equal((await page.evaluate(() => SL.info())).frame, f0, 'no sim frame behind the screen');
    await shot(page, 'touch-upright-390x844');
    // sideways again: still paused until a tap; the tap resumes
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(() => SL.view().rotateShown === false, null, WAIT);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => SL.info().paused), true, 'still paused after the turn');
    await page.touchscreen.tap(422, 195);
    await page.waitForFunction(() => SL.info().paused === false, null, WAIT);
    await page.waitForTimeout(150);
    const w = await words(page);
    assert.ok(w.slice(f0).every(x => (x & 0x78) === 0), 'the resume tap reached no sim frame');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('SL.setHeights and SL.setLines with bad input throw and leave the run as it was', { timeout: 60000 }, async () => {
  const { ctx, page, problems } = await open();
  try {
    await page.evaluate(() => SL.start(5));
    await page.keyboard.press('KeyP');
    await page.waitForFunction(() => SL.info().paused === true, null, WAIT);
    const h0 = await page.evaluate(() => SL.hash());
    for (const bad of ['[1, 2]', '"x"', '[0,0,0,0,0,0,0,0,18]', '[-1,0,0,0,0,0,0,0,0]', '[0.5,0,0,0,0,0,0,0,0]', 'null']) {
      const r = await page.evaluate(b => { try { SL.setHeights(eval(b)); return 'no throw'; } catch (e) { return 'threw'; } }, bad);
      assert.equal(r, 'threw', 'setHeights(' + bad + ')');
    }
    for (const bad of ['-1', '1.5', '"8"']) {
      const r = await page.evaluate(b => { try { SL.setLines(eval(b)); return 'no throw'; } catch (e) { return 'threw'; } }, bad);
      assert.equal(r, 'threw', 'setLines(' + bad + ')');
    }
    const i = await page.evaluate(() => SL.info());
    assert.equal(i.mode, 'arcade'); assert.equal(i.app, 'play');
    assert.equal(await page.evaluate(() => SL.hash()), h0, 'the run is unchanged');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});
