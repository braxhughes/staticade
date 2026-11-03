// STACKLIGHT text keep-out (browser): the field specks and the clear sweep never land on text (the owner said "specks over the title text and TEST START",
// "the laser crosses the right HUD text"). The real stacklight.html in headless Chrome, at 1000x750 and the phone size 844x390.
// Taps are put in front of modules by routing (the repo files are untouched):
//   gfx.dot      every dot of a frame, tagged with the looks.js function drawing it (field2 = the field, sweep3 or front3 = the
//                clear sweep; front3 is the LIGHTSHOW function the sweep came from, so this file also runs on an older commit)
//   font text()  every string drawn that frame and where (its lit-dot box, as tests/w57-glow-meter-browser.test.js)
//   looks.js     field2, sweep3 and front3 are wrapped so the dot tap knows which one is drawing
// For every captured frame: each field or sweep dot, edge to edge, is at least 1 field unit from the box of every string drawn
// that frame. Screens: the title, the title's board page (desktop), a TEST START run in play, a 14-row clear (the sweep crosses
// BEST, X1.75, GLOW, LINES, LEVEL and their numbers) and a 1-row clear, paused, game over (the results panel).
// Guards against a pass with nothing drawn: every frame has field dots, the clears have sweep dots reaching both screen edges.
// W57B_LOOK=n runs every screen in look n (SL.look(n)), for checking an older commit; unset, the default look is used.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticServer, WAIT, ROOT } from './w25-helpers.mjs';

const FORCE = process.env.W57B_LOOK === undefined ? null : Number(process.env.W57B_LOOK);
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const WRAP = ['field2', 'sweep3', 'front3'];
const wrap = (src, name) => src.replace('function ' + name + '(',
  `function ${name}(...__a) { const __p = window.__lkTag; window.__lkTag = '${name}'; try { return __${name}(...__a); } finally { window.__lkTag = __p; } }\n  function __${name}(`);
const LOOKS = 'games/stacklight/render/looks.js';
let looksBody = read(LOOKS);
const wrapped = WRAP.filter(n => looksBody.includes('function ' + n + '('));
if (!wrapped.includes('field2')) throw new Error(LOOKS + ' has no field2 for the tap to wrap');
if (!wrapped.includes('sweep3') && !wrapped.includes('front3')) throw new Error(LOOKS + ' has no sweep function (sweep3 or front3) for the tap to wrap');
for (const n of wrapped) looksBody = wrap(looksBody, n);
const TAPS = [
  ['engine/gl-dots.js', 'function dot(x, y, s, r, g, b, a) {', 'function dot(x, y, s, r, g, b, a) { if (window.__dots) window.__dots.push(x, y, s, a, window.__lkTag === "field2" ? 1 : window.__lkTag ? 2 : 0);'],
  ['engine/font.js', 'return function text(str, x, y, col, sc, align, a, wave) {', 'return function text(str, x, y, col, sc, align, a, wave) { if (window.__tlog) window.__tlog.push([str, x, y, sc || 1, align || "l"]);']
];
const BODY = { [LOOKS]: looksBody };
for (const [f, from, to] of TAPS) {
  const src = read(f);
  if (!src.includes(from)) throw new Error(f + ' no longer has the line the tap wraps: ' + from);
  BODY[f] = src.replace(from, to);
}
// the frame stepper of tests/stacklight-browser-w49c.test.js: __adv(k) runs exactly k ticks and one render
const STEPPER = `(() => {
  const real = window.requestAnimationFrame.bind(window), STEP = 1000 / 60;
  let frozen = false, held = null, lastPassed = 0, offset = 0;
  window.requestAnimationFrame = cb => real(t => { if (frozen) { held = cb; return; } lastPassed = t - offset; cb(lastPassed); });
  const until = f => new Promise(r => { const c = () => (f() ? r() : setTimeout(c, 2)); c(); });
  window.__freeze = async () => { frozen = true; await until(() => held); document.dispatchEvent(new Event('visibilitychange')); lastPassed = performance.now() - offset; };
  window.__adv = async (steps = 0) => {
    for (;;) {
      const k = Math.min(steps, 14); steps -= k;
      const cb = held; held = null; lastPassed += k * STEP + 1e-4; cb(lastPassed); await until(() => held);
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

async function open(w, h, phone) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: phone, isMobile: phone });
  for (const f of Object.keys(BODY)) await ctx.route('**/' + f, r => r.fulfill({ status: 200, contentType: 'text/javascript', body: BODY[f] }));
  await ctx.addInitScript(STEPPER);
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.goto(web.url + 'stacklight.html');
  await page.waitForFunction(() => window.SL && SL.info().app === 'title' && SL.hud().F > 5, null, WAIT);
  if (FORCE !== null) assert.equal(await page.evaluate(L => SL.look(L), FORCE), FORCE, 'forced look ' + FORCE);
  await page.evaluate(() => window.__freeze());
  return { ctx, page, problems };
}
// k ticks, then one rendered frame: its field dots, sweep dots (x, y, size, alpha) and strings
function frame(page, k = 0) {
  return page.evaluate(async k => {
    await window.__adv(k);
    window.__dots = []; window.__tlog = [];
    await window.__adv(0);
    const d = window.__dots, t = window.__tlog; window.__dots = null; window.__tlog = null;
    const field = [], sweep = [];
    for (let i = 0; i < d.length; i += 5) { if (d[i + 4] === 1) field.push([d[i], d[i + 1], d[i + 2], d[i + 3]]); else if (d[i + 4] === 2) sweep.push([d[i], d[i + 1], d[i + 2], d[i + 3]]); }
    return { field, sweep, texts: t, fx: SL.fx(), info: SL.info() };
  }, k);
}
const textBox = ([str, x, y, sc, align]) => {
  const w = str.length * 6 * sc - sc, x0 = align === 'c' ? x - w / 2 : align === 'r' ? x - w : x, h = sc * 0.95 / 2; // font dot size sc * 0.95
  return { str, x0: x0 - h, y0: y - h, x1: x0 + w + h, y1: y + 6 * sc + h };
};
// edge of a dot (centre +- size / 2) to a box; 0 when they touch or overlap
const gap = (d, b) => Math.max(0, Math.hypot(Math.max(b.x0 - d[0], 0, d[0] - b.x1), Math.max(b.y0 - d[1], 0, d[1] - b.y1)) - d[2] / 2);
const MIN = 1;
function clean(c, tag) {
  const boxes = c.texts.filter(t => t[0].trim() !== '').map(textBox);
  for (const [kind, dots] of [['field', c.field], ['sweep', c.sweep]]) {
    for (const d of dots) {
      if (d[3] <= 0) continue; // an unlit dot adds no light
      for (const b of boxes) {
        const e = gap(d, b);
        assert.ok(e >= MIN, `${tag}: ${kind} dot at (${d[0].toFixed(2)}, ${d[1].toFixed(2)}) size ${d[2].toFixed(2)} alpha ${d[3].toFixed(3)} is ${e.toFixed(2)} from the text "${b.str}" (under ${MIN})`);
      }
    }
  }
}
const FIELD_MIN = 300;
function hasField(c, tag) { assert.ok(c.field.length >= FIELD_MIN, `${tag}: the field is drawn (${c.field.length} dots)`); }

for (const [w, h, phone] of [[1000, 750, false], [844, 390, true]]) {
  const size = `${w}x${h}`;

  test(`${size}: field specks keep off the title text${phone ? '' : ' and the board page'}`, { timeout: 90000 }, async () => {
    const { ctx, page, problems } = await open(w, h, phone);
    try {
      for (let i = 0; i < 6; i++) {
        const c = await frame(page, i === 0 ? 0 : 23);
        assert.equal(c.info.app, 'title');
        assert.ok(c.texts.some(t => t[0] === 'S') && c.texts.some(t => t[0] === 'FREE PLAY'), `${size} title: the wordmark and menu are drawn`);
        hasField(c, `${size} title frame ${i}`);
        clean(c, `${size} title frame ${i}`);
      }
      if (!phone) {
        await page.evaluate(() => SL.page('table'));
        for (let i = 0; i < 3; i++) {
          const c = await frame(page, 17);
          assert.ok(c.texts.some(t => t[0] === 'ALL-TIME'), `${size} board page drawn: ` + JSON.stringify(c.texts.map(t => t[0])));
          hasField(c, `${size} board page frame ${i}`);
          clean(c, `${size} board page frame ${i}`);
        }
      }
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test(`${size}: field specks and the clear sweep keep off the HUD text in a TEST START run (play, a 14-row and a 1-row clear, paused)`, { timeout: 120000 }, async () => {
    const { ctx, page, problems } = await open(w, h, phone);
    try {
      // a TEST START run in play
      await page.evaluate(() => SL.setHeights([3, 1, 0, 2, 0, 0, 1, 2, 0]));
      for (let i = 0; i < 3; i++) {
        const c = await frame(page, 9);
        assert.ok(c.texts.some(t => t[0] === 'TEST START'), `${size} play: TEST START drawn`);
        hasField(c, `${size} play frame ${i}`);
        clean(c, `${size} play frame ${i}`);
      }
      // a 14-row clear (rows 0 to 13): the sweep runs on the rows of BEST, X1, GLOW, LINES, LEVEL and the numbers under them;
      // then a 1-row clear (row 0, the row of BEST). Every frame of each sweep is checked.
      for (const [heights, rows] of [[[14, 14, 14, 14, 13, 14, 14, 14, 14], 14], [[1, 1, 1, 1, 0, 1, 1, 1, 1], 1]]) {
        await page.evaluate(h => { SL.setHeights(h); SL.place(4, 0); }, heights);
        let c = await frame(page, 0);
        assert.equal(c.fx.clearRows, rows, `${size}: a ${rows}-row clear is on screen: ` + JSON.stringify(c.fx));
        let swept = 0, minX = 400, maxX = 0;
        for (let k = 0; k < 30; k++) {
          hasField(c, `${size} ${rows}-row clear, age ${c.fx.clearAge}`);
          clean(c, `${size} ${rows}-row clear, age ${c.fx.clearAge}`);
          swept += c.sweep.length;
          for (const d of c.sweep) { if (d[0] < minX) minX = d[0]; if (d[0] > maxX) maxX = d[0]; }
          c = await frame(page, 1);
        }
        assert.ok(swept >= 100 * rows, `${size} ${rows}-row clear: the sweep is drawn (${swept} dots over 30 frames)`);
        assert.ok(minX <= 5 && maxX >= 395, `${size} ${rows}-row clear: the sweep reaches both screen edges (x ${minX.toFixed(1)} to ${maxX.toFixed(1)})`);
      }
      // a clear, then paused mid-sweep (PAUSED, P: RESUME, ESC: QUIT)
      await page.evaluate(() => { SL.setHeights([2, 2, 2, 2, 1, 2, 2, 2, 2]); SL.place(4, 0); });
      await frame(page, 3);
      await page.keyboard.press('KeyP');
      const p = await frame(page, 1);
      assert.equal(p.info.paused, true, `${size}: paused`);
      assert.ok(p.texts.some(t => t[0] === 'PAUSED'), `${size}: PAUSED drawn`);
      hasField(p, `${size} paused`);
      clean(p, `${size} paused`);
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test(`${size}: field specks keep off the results panel and the HUD after a game over`, { timeout: 90000 }, async () => {
    const { ctx, page, problems } = await open(w, h, phone);
    try {
      await page.evaluate(() => { SL.start(99); let n = 0; while (!SL.info().done && n++ < 40) SL.place(4, 1); });
      assert.equal((await page.evaluate(() => SL.info())).app, 'over');
      for (const k of [10, 40, 40]) {
        const c = await frame(page, k);
        hasField(c, `${size} over +${k}`);
        clean(c, `${size} over +${k}`);
      }
      const c = await frame(page, 0);
      assert.ok(c.texts.some(t => t[0] === 'TOP OUT'), `${size}: the results panel is up: ` + JSON.stringify(c.texts.map(t => t[0])));
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });
}
