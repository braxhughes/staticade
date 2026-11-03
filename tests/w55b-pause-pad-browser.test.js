// STACKLIGHT PAUSE pad drawn where it is hit (browser): the real stacklight.html in headless Chrome, real CDP touches at positions read from the drawn canvas.
//   1. at 844x340, 932x400 (short landscape, Safari bars showing) and 844x390, 568x320: every pad and PAUSE is drawn where the
//      layout says (lit-pixel bounds of each drawn box match the hit box); no two drawn boxes overlap; a tap at the centre of
//      the drawn TURN, LEFT, RIGHT, SOFT and DROP boxes gives that pad's word bits only and never pauses; a tap at the centre of
//      the drawn PAUSE box pauses and the run stops
//   2. browser half, independent of the production `builds` counter: render.js is served with one line added at the top
//      of drawEntry that hands its `info` object to the test; the test puts accessors on that object's three strings and
//      counts writes. Over ~2 s on the entry screen: one object every frame, no write to the score or mode string, and at
//      most one TIME write a second
// Every page: console clean except the favicon 404. Screenshots go to W55B_SHOT_DIR when set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticServer, ROOT } from './w25-helpers.mjs';
import { decode } from '../engine/replay.js';

const WAIT = { timeout: 30000 };
const SHOT_DIR = process.env.W55B_SHOT_DIR || null;
const PAGE_INIT = `(() => {
  const g = crypto.getRandomValues.bind(crypto); window.__seed = null;
  crypto.getRandomValues = a => { if (a instanceof Uint32Array && a.length === 1 && window.__seed != null) { a[0] = window.__seed >>> 0; return a; } return g(a); };
  try { if (localStorage.getItem('stacklight.crt') === null) localStorage.setItem('stacklight.crt', '0'); } catch (e) {}
})();`;
const RENDER_SRC = fs.readFileSync(path.join(ROOT, 'games/stacklight/render.js'), 'utf8');
const ENTRY_HEAD = 'function drawEntry(e, info) {';
if (!RENDER_SRC.includes(ENTRY_HEAD)) throw new Error('render.js no longer has the drawEntry head the instrument wraps');
const RENDER_TAPPED = RENDER_SRC.replace(ENTRY_HEAD, ENTRY_HEAD + ' if (window.__entryTap) window.__entryTap(info);');
// the instrument: every info object drawEntry gets, and every write to its three strings after the first frame
const ENTRY_TAP = `(() => {
  const T = window.__entry = { objs: [], frames: 0, writes: { scoreStr: 0, modeStr: 0, timeStr: 0 } };
  window.__entryTap = info => {
    T.frames++;
    if (T.objs.indexOf(info) < 0) {
      T.objs.push(info);
      for (const k of ['scoreStr', 'modeStr', 'timeStr']) {
        let v = info[k];
        Object.defineProperty(info, k, { get() { return v; }, set(x) { T.writes[k]++; v = x; }, enumerable: true, configurable: true });
      }
    }
  };
})();`;

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

async function open({ w = 1000, h = 750, touch = false, init = [], tapEntry = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch });
  if (tapEntry) await ctx.route('**/games/stacklight/render.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: RENDER_TAPPED }));
  await ctx.addInitScript(PAGE_INIT);
  for (const s of init) await ctx.addInitScript(s);
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
const info = page => page.evaluate(() => SL.info());
const shot = async (page, name) => { if (!SHOT_DIR) return; fs.mkdirSync(SHOT_DIR, { recursive: true }); await wait(250); await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') }); };
async function touch(ctx, page, x, y, holdMs = 80) {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await wait(holdMs);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}
// bounds of the lit pixels (any channel over 20: the dotted pad borders are dim) inside each region (CSS px, dpr 1), from one screenshot
async function litBounds(page, regions) {
  const b64 = (await page.screenshot()).toString('base64');
  return page.evaluate(async ([b64, regions]) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    return regions.map(q => {
      const x0 = Math.max(0, Math.floor(q.x)), y0 = Math.max(0, Math.floor(q.y));
      const w = Math.min(img.width - x0, Math.ceil(q.w)), h = Math.min(img.height - y0, Math.ceil(q.h));
      const d = g.getImageData(x0, y0, w, h).data;
      let n = 0, a = 1e9, b = 1e9, cc = -1, dd = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (Math.max(d[i], d[i + 1], d[i + 2]) > 20) { n++; if (x < a) a = x; if (y < b) b = y; if (x > cc) cc = x; if (y > dd) dd = y; }
      }
      return n ? { n, x: x0 + a, y: y0 + b, w: cc - a + 1, h: dd - b + 1 } : { n: 0 };
    });
  }, [b64, regions]);
}
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const words = async page => Array.from(decode(await page.evaluate(() => SL.replay())).words);
const ALLOWED = { rotate: 64, left: 1 | 8, right: 2 | 16, soft: 4, hard: 32 };
const NEEDED = { rotate: 64, left: 8, right: 16, soft: 4, hard: 32 };

// ---------- 1 ----------
test('1. short landscape: every pad drawn where it is hit, none overlapping; real taps on the drawn centres do what the pad says; PAUSE pauses', { timeout: 300000 }, async t => {
  const rows = [];
  for (const [w, h] of [[844, 340], [932, 400], [844, 390], [568, 320]]) {
    const { ctx, page, problems } = await open({ w, h, touch: true });
    try {
      const tag = `${w}x${h}`;
      await page.evaluate(() => SL.start(6)); await until(page, () => SL.info().piece); await wait(300); // seed 6: the first piece is a BAR (a PLUS never turns)
      const v = await page.evaluate(() => SL.view());
      assert.equal(v.pads.length, 6, tag + ': six pads in a run');
      const P = Object.fromEntries(v.pads.map(q => [q.name, q]));
      // the drawn boxes: lit pixels in each hit box grown by 3 px. The border dots sit on the box edge, so the lit bounds
      // must match the hit box to within 3 px on every side
      const grown = v.pads.map(q => ({ x: q.x - 3, y: q.y - 3, w: q.w + 6, h: q.h + 6 }));
      const drawn = await litBounds(page, grown), D = {};
      v.pads.forEach((q, i) => {
        const d = drawn[i];
        assert.ok(d.n > 40, `${tag}: ${q.name} is drawn (${d.n} lit px)`);
        for (const [a, b, s] of [[d.x, q.x, 'left'], [d.y, q.y, 'top'], [d.x + d.w, q.x + q.w, 'right'], [d.y + d.h, q.y + q.h, 'bottom']])
          assert.ok(Math.abs(a - b) <= 3, `${tag}: ${q.name} drawn ${s} edge ${a} vs hit ${b.toFixed(1)}`);
        assert.ok(q.w >= 44 - 1e-6 && q.h >= 44 - 1e-6, `${tag}: ${q.name} ${q.w} x ${q.h}`);
        assert.ok(!hit(q, v.field), `${tag}: ${q.name} outside the field`);
        D[q.name] = d;
      });
      for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) {
        assert.ok(!hit(drawn[i], drawn[j]), `${tag}: drawn ${v.pads[i].name} and ${v.pads[j].name} overlap`);
        assert.ok(!hit(v.pads[i], v.pads[j]), `${tag}: hit ${v.pads[i].name} and ${v.pads[j].name} overlap`);
      }
      rows.push({ size: tag, pause: ['x', 'y', 'w', 'h'].map(k => +P.pause[k].toFixed(1)), turn: ['x', 'y', 'w', 'h'].map(k => +P.rotate[k].toFixed(1)), soft: ['x', 'y', 'w', 'h'].map(k => +P.soft[k].toFixed(1)) });
      await shot(page, `w55b-play-${tag}`);
      // real taps on the centres of the drawn boxes, DROP last (it ends the piece)
      const p0 = (await info(page)).piece, rot0 = p0.rot;
      assert.equal(p0.type, 'BAR', tag + ': the first piece can turn');
      for (const name of ['rotate', 'left', 'right', 'soft', 'hard']) {
        const d = D[name], n0 = (await words(page)).length;
        await touch(ctx, page, d.x + d.w / 2, d.y + d.h / 2, name === 'soft' ? 200 : 80);
        await wait(200);
        const now = await info(page), ws = (await words(page)).slice(n0);
        const or = ws.reduce((a, x) => a | x, 0);
        assert.equal(now.paused, false, `${tag}: a tap on ${name} paused the run`);
        assert.ok((or & NEEDED[name]) === NEEDED[name], `${tag}: ${name} bit ${NEEDED[name]} missing (got ${or})`);
        assert.equal(or & ~ALLOWED[name], 0, `${tag}: a tap on ${name} gave other bits: ${or}`);
        if (name === 'rotate') assert.notEqual(now.piece.rot, rot0, `${tag}: TURN turned the piece`);
      }
      const d = D.pause;
      await touch(ctx, page, d.x + d.w / 2, d.y + d.h / 2, 80);
      await until(page, () => SL.info().paused);
      const f1 = (await info(page)).frame; await wait(400);
      const after = await info(page);
      assert.equal(after.paused, true, tag + ': still paused after the lift'); assert.equal(after.frame, f1, tag + ': no sim frame while paused');
      await shot(page, `w55b-paused-${tag}`);
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  }
  t.diagnostic('boxes [x, y, w, h] CSS px: ' + JSON.stringify(rows));
});

// ---------- 2 ----------
const COLS = [1, 4, 7, 2, 5, 3, 6];
test('2. L3, independent of the builds counter: on the entry screen the strings are written only when they change', { timeout: 180000 }, async () => {
  const { ctx, page, problems } = await open({ tapEntry: true, init: [ENTRY_TAP] });
  try {
    await page.evaluate(() => { window.__seed = 11; SL.mode('free'); });
    await page.keyboard.press('Enter'); await until(page, () => SL.info().app === 'play');
    await page.evaluate(cols => { let n = 0; while (!SL.info().done && n++ < 800) SL.place(cols[n % 7], n % 2); }, COLS);
    await until(page, () => SL.info().app === 'over'); await wait(900); await page.keyboard.press('Enter');
    await until(page, () => SL.info().app === 'entry'); await until(page, () => window.__entry.frames > 3);
    const a = await page.evaluate(() => { const T = window.__entry; T.writes = { scoreStr: 0, modeStr: 0, timeStr: 0 }; T.frames = 0; return SL.entryInfo(); });
    assert.ok(/^\d+$/.test(a.scoreStr) && a.modeStr === 'FREE PLAY' && /^TIME \d+$/.test(a.timeStr), JSON.stringify(a));
    await wait(2300);
    const r = await page.evaluate(() => { const T = window.__entry; return { frames: T.frames, objs: T.objs.length, writes: Object.assign({}, T.writes) }; });
    const secs = Math.ceil(r.frames / 60) + 1;
    assert.ok(r.frames > 100, 'frames drawn: ' + r.frames);
    assert.equal(r.objs, 1, 'drawEntry gets the same info object every frame');
    assert.equal(r.writes.scoreStr, 0, `score string written ${r.writes.scoreStr} times in ${r.frames} frames`);
    assert.equal(r.writes.modeStr, 0, `mode string written ${r.writes.modeStr} times in ${r.frames} frames`);
    assert.ok(r.writes.timeStr >= 1 && r.writes.timeStr <= secs, `TIME written ${r.writes.timeStr} times in ${r.frames} frames (at most ${secs})`);
    assert.equal((await info(page)).app, 'entry');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});
