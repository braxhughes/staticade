// STACKLIGHT PAUSE pad and touch layout (browser): the real stacklight.html in headless Chrome with real touch and key events and window.SL.
//   1. the PAUSE pad at 844x390, 932x430, 667x375 and 568x320: measured from the live layout (SL.pausePad / SL.view), inside the right band,
//      outside the field, at least 44 px, clear of the five pads; drawn only in a run in play (pixels), absent on the title, results, entry
//      and behind the turn-sideways screen (390x844)
//   2. a real tap on it pauses; the piece does not move, turn or drop (every word of the run is 0); the pause holds (no sim frame); a tap
//      on it again, and a tap elsewhere, resume
//   3. a touch run (pads held and tapped) with a pad pause in the middle re-sims in Node to exactly the live hash
//   4. the mode hook after a Daily then Esc, after attract, and after a Daily game over and save equals what Enter would start (free)
//   5. the entry heading says NEW RUN RECORD only for a run that beats the best (not for a lower score, not for a tie)
//   6. the entry strings are built once at entry (score, mode) and once a second (TIME); zero arrays built per frame on the entry screen
// Every page: console clean except the favicon 404. Screenshots go to W55_SHOT_DIR when set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticServer, ROOT } from './w25-helpers.mjs';
import { decode } from '../engine/replay.js';
import { createSim } from '../games/stacklight/sim.js';

const WAIT = { timeout: 30000 };
const SHOT_DIR = process.env.W55_SHOT_DIR || null;
const FONT_SRC = fs.readFileSync(path.join(ROOT, 'engine/font.js'), 'utf8');
const TAP = 'return function text(str, x, y, col, sc, align, a, wave) {';
if (!FONT_SRC.includes(TAP)) throw new Error('engine/font.js no longer has the text() entry the tap wraps');
const FONT_TAPPED = FONT_SRC.replace(TAP, TAP + ' if (window.__texts) window.__texts.add(str);');
const PAGE_INIT = `(() => {
  const g = crypto.getRandomValues.bind(crypto); window.__seed = null;
  crypto.getRandomValues = a => { if (a instanceof Uint32Array && a.length === 1 && window.__seed != null) { a[0] = window.__seed >>> 0; return a; } return g(a); };
  try { if (localStorage.getItem('stacklight.crt') === null) localStorage.setItem('stacklight.crt', '0'); } catch (e) {}
})();`;
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

async function open({ w = 1000, h = 750, touch = false, init = [], tapFont = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch });
  if (tapFont) await ctx.route('**/engine/font.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: FONT_TAPPED }));
  await ctx.addInitScript(PAGE_INIT);
  for (const s of init) await ctx.addInitScript(s);
  if (tapFont) await ctx.addInitScript('window.__texts = new Set();');
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) problems.push('HTTP ' + r.status() + ' ' + r.url()); });
  await page.goto(web.url + 'stacklight.html');
  await page.waitForFunction(() => window.SL && SL.info().app === 'title' && SL.hud().F > 5, null, WAIT);
  return { ctx, page, problems };
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, WAIT);
const wait = ms => new Promise(r => setTimeout(r, ms));
const press = async (page, k, gap = 70) => { await page.keyboard.press(k); await wait(gap); };
const info = page => page.evaluate(() => SL.info());
const shot = async (page, name) => { if (!SHOT_DIR) return; fs.mkdirSync(SHOT_DIR, { recursive: true }); await wait(250); await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') }); };
const centre = q => [q.x + q.w / 2, q.y + q.h / 2];
// a real touch: down and up through CDP, with a hold in between (ms)
async function touch(ctx, page, x, y, holdMs = 80) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await wait(holdMs);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
// lit pixels (any channel over 60) inside a CSS-px box of a screenshot (dpr 1)
async function lit(page, q) {
  const b64 = (await page.screenshot()).toString('base64');
  return page.evaluate(async ([b64, q]) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(Math.round(q.x), Math.round(q.y), Math.round(q.w), Math.round(q.h)).data; let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.max(d[i], d[i + 1], d[i + 2]) > 60) n++;
    return n;
  }, [b64, q]);
}
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const COLS = [1, 4, 7, 2, 5, 3, 6];
const finish = page => page.evaluate(cols => { let n = 0; while (!SL.info().done && n++ < 800) SL.place(cols[n % 7], n % 2); return SL.info().score; }, COLS);
async function untilPiece(page) { await until(page, () => SL.info().piece); }

// ---------- 1 ----------
test('1. the PAUSE pad at the four phone sizes: in the right band, clear of the field and the pads, 44 px or more, drawn only in a run in play', { timeout: 240000 }, async t => {
  const rows = [];
  for (const [w, h] of [[844, 390], [932, 430], [667, 375], [568, 320]]) {
    const { ctx, page, problems } = await open({ w, h, touch: true });
    try {
      const tag = `${w}x${h}`;
      // title: a touch device (coarse pointer), no pause pad
      assert.equal(await page.evaluate(() => SL.pausePad()), null, tag + ': no pause pad on the title');
      const v0 = await page.evaluate(() => SL.view());
      assert.equal(v0.touchUi, true);
      const box = { x: v0.pause.x, y: v0.pause.y, w: v0.pause.w, h: v0.pause.h };
      assert.equal(await lit(page, box), 0, tag + ': nothing drawn where the pause pad goes, on the title');
      await page.evaluate(() => SL.start(5)); await untilPiece(page); await wait(300);
      const v = await page.evaluate(() => SL.view()), p = await page.evaluate(() => SL.pausePad());
      assert.ok(p, tag + ': the pad is live in a run');
      assert.deepEqual(p, v.pause, tag + ': the hook and the layout agree');
      const F = v.field;
      assert.ok(p.w >= 44 - 1e-6 && p.h >= 44 - 1e-6, `${tag}: ${p.w} x ${p.h} is at least 44`);
      assert.ok(p.x >= F.x + F.w - 1e-6 && p.x + p.w <= w + 1e-6 && p.y >= 0 && p.y + p.h <= h + 1e-6, tag + ': inside the right band');
      assert.ok(!hit(p, F), tag + ': outside the field');
      // view().pads lists PAUSE too while it is live (an earlier test needs that); compare it with the five others only
      const five = v.pads.filter(q => q.name !== 'pause');
      assert.equal(five.length, 5, tag + ': five pads besides PAUSE');
      for (const q of five) assert.ok(!hit(p, q), `${tag}: clear of ${q.name}`);
      for (const q of five) assert.ok(q.w >= 44 - 1e-6 && q.h >= 44 - 1e-6, `${tag}: ${q.name} still 44 or more`);
      assert.equal(v.padsDrawn, 5, tag + ': five pads drawn as before');
      const nl = await lit(page, p); assert.ok(nl > 60, tag + ': the pad is drawn, lit pixels ' + nl);
      rows.push({ size: tag, pause: [p.x, p.y, p.w, p.h].map(n => +n.toFixed(1)), band: +v.band.toFixed(1), turn: [v.pads[4].x, v.pads[4].y, v.pads[4].w, v.pads[4].h].map(n => +n.toFixed(1)), drop: [v.pads[3].x, v.pads[3].y, v.pads[3].w, v.pads[3].h].map(n => +n.toFixed(1)), gapToTurn: +(v.pads[4].y - p.y - p.h).toFixed(1) });
      if (w === 844) await shot(page, 'play-844x390');
      if (w === 568) await shot(page, 'play-568x320');
      // results: not live, not drawn
      await finish(page); await until(page, () => SL.info().app === 'over'); await wait(150);
      assert.equal(await page.evaluate(() => SL.pausePad()), null, tag + ': no pause pad on the results');
      assert.equal(await lit(page, p), 0, tag + ': nothing drawn in its place on the results');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  }
  t.diagnostic('pause pad boxes [x, y, w, h] CSS px: ' + JSON.stringify(rows));
});

test('1b. the PAUSE pad is not live on the entry screen or behind the turn-sideways screen', { timeout: 120000 }, async () => {
  const { ctx, page, problems } = await open({ w: 844, h: 390, touch: true, tapFont: true });
  try {
    await page.evaluate(() => { window.__seed = 11; });
    await page.touchscreen.tap(422, 195); await until(page, () => SL.info().app === 'play');
    const p = await page.evaluate(() => SL.pausePad());
    assert.ok(p);
    await finish(page); await until(page, () => SL.info().app === 'over'); await wait(900);
    await page.touchscreen.tap(422, 195); await until(page, () => SL.info().app === 'entry');
    assert.equal(await page.evaluate(() => SL.pausePad()), null, 'no pause pad on the entry screen');
    assert.equal(await lit(page, p), 0, 'nothing drawn in its place on the entry screen');
    // a tap on the place the pad was does not pause (there is no run) and does not break the entry screen
    await touch(ctx, page, ...centre(p)); await wait(100);
    assert.equal((await info(page)).app, 'entry');
    // upright: the shared turn-sideways screen, the run paused behind it, no pad
    await page.evaluate(() => { SL.nameEntry('AAA'); }); await until(page, () => SL.info().app === 'title');
    await page.evaluate(() => SL.page('main'));
    await page.touchscreen.tap(422, 195); await until(page, () => SL.info().app === 'play');
    await page.setViewportSize({ width: 390, height: 844 });
    await until(page, () => SL.view().rotateShown);
    assert.equal(await page.evaluate(() => SL.pausePad()), null, 'no pause pad behind the rotate screen');
    await until(page, () => SL.info().paused);
    assert.equal((await info(page)).paused, true, 'the run is paused behind it');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

// ---------- 2 ----------
test('2. a real tap on the PAUSE pad pauses and moves nothing; the pause holds; the pad and a tap elsewhere resume', { timeout: 120000 }, async () => {
  const { ctx, page, problems } = await open({ w: 844, h: 390, touch: true });
  try {
    await page.evaluate(() => SL.start(7)); await untilPiece(page); await wait(250);
    const p = await page.evaluate(() => SL.pausePad()), before = await info(page);
    assert.equal(before.paused, false);
    await touch(ctx, page, ...centre(p), 120);
    await until(page, () => SL.info().paused);
    await wait(100);
    const h1 = await page.evaluate(() => ({ hash: SL.hash(), frame: SL.info().frame, piece: SL.info().piece }));
    await shot(page, 'paused-844x390');
    await wait(500);                       // the lift of the tap must not resume it, and no sim frame runs
    const h2 = await page.evaluate(() => ({ hash: SL.hash(), frame: SL.info().frame, paused: SL.info().paused }));
    assert.equal(h2.paused, true, 'still paused after the finger lifted');
    assert.equal(h2.hash, h1.hash); assert.equal(h2.frame, h1.frame);
    assert.equal(h1.piece.col, before.piece.col, 'the piece did not move sideways'); assert.equal(h1.piece.rot, before.piece.rot, 'the piece did not turn');
    // a tap on the pad again resumes
    await touch(ctx, page, ...centre(p), 100);
    await until(page, () => !SL.info().paused);
    await wait(300);
    assert.ok((await info(page)).frame > h1.frame, 'the run carries on');
    // pause again, then a tap elsewhere (the field) resumes, as today
    await touch(ctx, page, ...centre(p), 100); await until(page, () => SL.info().paused);
    const F = (await page.evaluate(() => SL.view())).field;
    await touch(ctx, page, F.x + F.w / 2, F.y + F.h / 2, 60);
    await until(page, () => !SL.info().paused);
    await wait(250);
    // every word of the run is 0: no pad press became a move, turn or drop (pressing PAUSE is the P key, not a word bit)
    const words = Array.from(decode(await page.evaluate(() => SL.replay())).words);
    assert.ok(words.length > 30);
    assert.ok(words.every(x => x === 0), 'words with bits: ' + words.filter(x => x !== 0).length);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

// ---------- 3 ----------
test('3. a touch run with a pad pause in the middle re-sims in Node to exactly the live hash', { timeout: 120000 }, async () => {
  const { ctx, page, problems } = await open({ w: 844, h: 390, touch: true });
  try {
    await page.evaluate(() => SL.start(21)); await untilPiece(page);
    const v = await page.evaluate(() => SL.view()), P = Object.fromEntries(v.pads.map(q => [q.name, q]));
    const p = await page.evaluate(() => SL.pausePad());
    await touch(ctx, page, ...centre(P.left), 500);     // hold left (auto-repeat)
    await touch(ctx, page, ...centre(P.rotate), 80);
    await touch(ctx, page, ...centre(p), 80); await until(page, () => SL.info().paused);   // pause by the pad
    await wait(200);
    await touch(ctx, page, ...centre(p), 80); await until(page, () => !SL.info().paused);  // resume by the pad
    await touch(ctx, page, ...centre(P.right), 400);
    await touch(ctx, page, ...centre(P.hard), 80);
    await wait(150);
    await touch(ctx, page, ...centre(p), 80); await until(page, () => SL.info().paused);   // pause again to read a still state
    await wait(150);
    const live = await page.evaluate(() => ({ replay: SL.replay(), hash: SL.hash(), frame: SL.info().frame, score: SL.info().score }));
    const r = decode(live.replay), words = Array.from(r.words);
    assert.equal(words.length, live.frame);
    assert.ok(words.some(x => x & 1) && words.some(x => x & 2) && words.some(x => x & 64) && words.some(x => x & 32), 'the run really used left, right, turn and drop');
    const sim = createSim({ seed: r.seed, mode: r.mode });
    for (const x of words) sim.step(x);
    assert.equal(sim.stateHash(), live.hash, 're-sim hash equals the live hash');
    assert.equal(sim.score, live.score);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

// ---------- 4 ----------
test('4. L1: the mode hook equals the highlighted row after a Daily then Esc, after attract, and after a Daily game over and save', { timeout: 180000 }, async () => {
  const { ctx, page, problems } = await open({ tapFont: true });
  try {
    const both = async () => { const a = await info(page), b = await page.evaluate(() => SL.title()); return { info: a.mode, title: b.mode, sel: b.sel, app: a.app }; };
    // Daily, then Esc twice (pause, leave)
    await page.evaluate(() => SL.mode('daily')); await press(page, 'Enter', 200);
    await until(page, () => SL.info().app === 'play'); assert.equal((await info(page)).mode, 'daily');
    await press(page, 'Escape'); await press(page, 'Escape'); await until(page, () => SL.info().app === 'title'); await wait(100);
    assert.deepEqual(await both(), { info: 'free', title: 'free', sel: 1, app: 'title' }, 'after Daily then Esc');
    await wait(1500); await shot(page, 'title-free');
    await press(page, 'Enter', 200); await until(page, () => SL.info().app === 'play');
    assert.equal((await page.evaluate(() => SL.runInfo())).mode, 'free', 'what Enter starts is what the hook said');
    await press(page, 'Escape'); await press(page, 'Escape'); await until(page, () => SL.info().app === 'title');
    // attract
    await page.evaluate(() => SL.mode('daily')); await page.evaluate(() => SL.attractNow()); await until(page, () => SL.attract().phase === 'play');
    await press(page, 'Space', 100); await until(page, () => SL.info().app === 'title'); await wait(100);
    assert.deepEqual(await both(), { info: 'free', title: 'free', sel: 1, app: 'title' }, 'after attract');
    // a Daily played to game over, saved, back on the title
    await page.evaluate(() => SL.mode('daily')); await press(page, 'Enter', 200); await until(page, () => SL.info().app === 'play');
    await finish(page); await until(page, () => SL.info().app === 'over'); await wait(900); await press(page, 'Enter', 100);
    await until(page, () => ['entry', 'title'].includes(SL.info().app));
    if ((await info(page)).app === 'entry') { await page.evaluate(() => SL.nameEntry('ABC')); await until(page, () => SL.info().app === 'title'); }
    await wait(150);
    assert.deepEqual(await both(), { info: 'free', title: 'free', sel: 1, app: 'title' }, 'after a Daily game over');
    // moving the highlight still moves the hook
    await press(page, 'ArrowUp'); await press(page, 'ArrowUp'); await press(page, 'ArrowUp'); await press(page, 'ArrowUp'); // up from FREE PLAY wraps: 1 -> 0 -> 4 -> 3 -> 2
    await page.evaluate(() => SL.mode('daily')); assert.equal((await both()).info, 'daily');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

// ---------- 5 and 6 ----------
async function toEntry(page, seed) {
  await page.evaluate(s => { window.__seed = s; SL.mode('free'); }, seed);
  await press(page, 'Enter', 200); await until(page, () => SL.info().app === 'play');
  const score = await finish(page);
  await until(page, () => SL.info().app === 'over'); await wait(900); await press(page, 'Enter', 100);
  await until(page, () => SL.info().app === 'entry');
  return score;
}
const hasText = (page, s) => page.evaluate(s => window.__texts.has(s), s);
test('5. L5: the entry heading is NEW RUN RECORD only when the run beats the best; a lower score and a tie get RUN COMPLETE', { timeout: 240000 }, async () => {
  let S = 0;
  { // no best yet: a record
    const { ctx, page, problems } = await open({ tapFont: true });
    try {
      S = await toEntry(page, 11); assert.ok(S > 0);
      await page.evaluate(() => window.__texts.clear()); await wait(200);
      assert.equal((await page.evaluate(() => SL.entryInfo())).record, true);
      assert.ok(await hasText(page, 'NEW RUN RECORD')); assert.ok(!(await hasText(page, 'RUN COMPLETE')));
      await shot(page, 'entry-record');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  }
  for (const [name, hi, record] of [['a lower score than the best', S * 10, false], ['a tie with the best', S, false], ['one point over the old best', S - 1, true]]) {
    const { ctx, page, problems } = await open({ tapFont: true, init: [`try { localStorage.setItem('stacklight.hi', '${hi}'); } catch (e) {}`] });
    try {
      const score = await toEntry(page, 11);
      assert.equal(score, S, 'the same seed and moves give the same score');
      await page.evaluate(() => window.__texts.clear()); await wait(200);
      assert.equal((await page.evaluate(() => SL.entryInfo())).record, record, name);
      assert.equal(await hasText(page, 'NEW RUN RECORD'), record, name + ': NEW RUN RECORD shown');
      assert.equal(await hasText(page, 'RUN COMPLETE'), !record, name + ': RUN COMPLETE shown');
      assert.ok(await hasText(page, 'ENTER YOUR INITIALS'));
      if (hi === S * 10) await shot(page, 'entry-not-best');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  }
});

test('6. L3: the entry strings are built when they change (score and mode once, TIME once a second); no array built per frame on the entry screen', { timeout: 180000 }, async () => {
  const { ctx, page, problems } = await open({ tapFont: true, init: [COUNT] });
  try {
    await toEntry(page, 11);
    const a = await page.evaluate(() => SL.entryInfo());
    assert.ok(/^\d+$/.test(a.scoreStr) && a.modeStr === 'FREE PLAY' && /^TIME \d+$/.test(a.timeStr), JSON.stringify(a));
    await page.evaluate(() => { window.__alloc = 0; window.__allocBy = {}; window.__count = true; });
    const f0 = (await page.evaluate(() => SL.hud())).F;
    await wait(2300);
    const r = await page.evaluate(() => { window.__count = false; return { n: window.__alloc, by: window.__allocBy, F: SL.hud().F }; });
    const b = await page.evaluate(() => SL.entryInfo());
    assert.deepEqual({ n: r.n, by: r.by }, { n: 0, by: {} }, 'no typed array or array built on the entry screen');
    const frames = r.F - f0, secs = Math.ceil(frames / 60) + 1;
    assert.ok(frames > 100, 'frames drawn: ' + frames);
    assert.ok(b.builds - a.builds >= 1 && b.builds - a.builds <= secs, `builds over ${frames} frames: ${b.builds - a.builds} (at most one a second: ${secs})`);
    assert.equal(b.scoreStr, a.scoreStr); assert.equal(b.modeStr, a.modeStr);
    const times = await page.evaluate(() => [...window.__texts].filter(s => /^TIME \d+$/.test(s)));
    assert.ok(times.length >= 2, 'TIME changes with the second: ' + times);
    await shot(page, 'entry-time');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});
