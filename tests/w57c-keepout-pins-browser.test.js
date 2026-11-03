// STACKLIGHT keep-out pins (browser): two claims that nothing pinned. The real stacklight.html in headless Chrome.
//   1. right-aligned strings get the same text keep-out as the rest. The title's board page is drawn with 10 rows
//      (a board put in localStorage before the page loads), so its right-aligned rank, score and D columns are on screen,
//      and the title with MUTED on (BEST and MUTED are right-aligned). Over many frames, no field speck or sweep dot comes
//      within 1 field unit of any string, and the field does reach close to the right-aligned strings (so the check is not
//      empty). Review mutant M7 (right-aligned boxes on the wrong side) must fail it.
//   2. The clear sweep starts outside the well walls. In a TEST START run, a 14-row and a 1-row clear, in look 0 and
//      look 3 (both draw the sweep): every sweep dot, edge to edge, stays outside the well's wall line (x 138.5 and 261.5),
//      the sweep starts right at the wall (within 10 units of it) and reaches both screen edges. Review mutant M10 (the sweep
//      starts at the well centre) must fail it.
// Taps as tests/w57b-text-keepout-browser.test.js, put in front of modules by routing (the repo files are untouched):
//   gfx.dot    every dot of a frame, tagged with the looks.js function drawing it (field2 = the field, sweep3 = the sweep)
//   font text  every string drawn that frame, with its position, scale and alignment
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticServer, WAIT, ROOT } from './w25-helpers.mjs';
import { CX, BX0, BX1 } from '../games/stacklight/render/geom.js';

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const LOOKS = 'games/stacklight/render/looks.js';
let looksBody = read(LOOKS);
for (const n of ['field2', 'sweep3']) {
  if (!looksBody.includes('function ' + n + '(')) throw new Error(LOOKS + ' has no ' + n + ' for the tap to wrap');
  looksBody = looksBody.replace('function ' + n + '(',
    `function ${n}(...__a) { const __p = window.__lkTag; window.__lkTag = '${n}'; try { return __${n}(...__a); } finally { window.__lkTag = __p; } }\n  function __${n}(`);
}
const TAPS = [
  ['engine/gl-dots.js', 'function dot(x, y, s, r, g, b, a) {', 'function dot(x, y, s, r, g, b, a) { if (window.__dots) window.__dots.push(x, y, s, a, window.__lkTag === "field2" ? 1 : window.__lkTag === "sweep3" ? 2 : 0);'],
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
// a local all-time board of 10 rows (the shape leaderboard/api.js stores), scores of 1 to 7 digits, three of them Daily runs
const NAMES = ['ACE', 'BOB', 'CAT', 'DOT', 'EVE', 'FOX', 'GUS', 'HAL', 'IVY', 'JAY'];
const SCORES = [9876543, 765432, 65432, 54321, 43210, 9870, 8760, 765, 54, 3];
const BOARD = NAMES.map((name, i) => ({ id: 'w57c-' + i, t: 1761955200000 + i * 1000, name, pid: 'p-w57c-' + i, score: SCORES[i], date: new Date(1761955200000 + i * 1000).toISOString(), mode: i % 3 === 1 ? 'daily' : 'free' }));
const SEED_BOARD = `try { localStorage.setItem('arcade:board:stacklight:all', ${JSON.stringify(JSON.stringify(BOARD))}); localStorage.setItem('stacklight.mute', '1'); } catch (e) {}`;

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

async function open(w, h, phone, init, look) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: phone, isMobile: phone });
  for (const f of Object.keys(BODY)) await ctx.route('**/' + f, r => r.fulfill({ status: 200, contentType: 'text/javascript', body: BODY[f] }));
  if (init) await ctx.addInitScript(init);
  await ctx.addInitScript(STEPPER);
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.goto(web.url + 'stacklight.html');
  await page.waitForFunction(() => window.SL && SL.info().app === 'title' && SL.hud().F > 5, null, WAIT);
  if (look !== undefined) assert.equal(await page.evaluate(L => SL.look(L), look), look, 'look ' + look);
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
// the box of a string's lit dots (font dot size sc * 0.95), as tests/w57b-text-keepout-browser.test.js
const textBox = ([str, x, y, sc, align]) => {
  const w = str.length * 6 * sc - sc, x0 = align === 'c' ? x - w / 2 : align === 'r' ? x - w : x, h = sc * 0.95 / 2;
  return { str, align, x0: x0 - h, y0: y - h, x1: x0 + w + h, y1: y + 6 * sc + h };
};
// edge of a dot (centre +- size / 2) to a box; 0 when they touch or overlap
const gap = (d, b) => Math.max(0, Math.hypot(Math.max(b.x0 - d[0], 0, d[0] - b.x1), Math.max(b.y0 - d[1], 0, d[1] - b.y1)) - d[2] / 2);
const MIN = 1;
// every lit field or sweep dot at least MIN from every string; returns how many field dots came within 8 of a right-aligned one
function clean(c, tag) {
  const boxes = c.texts.filter(t => t[0].trim() !== '').map(textBox);
  let nearR = 0;
  for (const [kind, dots] of [['field', c.field], ['sweep', c.sweep]]) {
    for (const d of dots) {
      if (d[3] <= 0) continue; // an unlit dot adds no light
      for (const b of boxes) {
        const e = gap(d, b);
        assert.ok(e >= MIN, `${tag}: ${kind} dot at (${d[0].toFixed(2)}, ${d[1].toFixed(2)}) size ${d[2].toFixed(2)} alpha ${d[3].toFixed(3)} is ${e.toFixed(2)} from the ${b.align === 'r' ? 'right-aligned ' : ''}text "${b.str}" (under ${MIN})`);
        if (kind === 'field' && b.align === 'r' && e < 8) nearR++;
      }
    }
  }
  return nearR;
}

for (const [w, h, phone] of [[1000, 750, false], [844, 390, true]]) {
  const size = `${w}x${h}`;

  test(`${size} LOW-2: specks keep off right-aligned strings (the board page's rank, score and D columns; BEST and MUTED on the title)`, { timeout: 120000 }, async t => {
    const { ctx, page, problems } = await open(w, h, phone, SEED_BOARD);
    try {
      // the title, MUTED on: BEST and MUTED are right-aligned
      let near = 0;
      for (let i = 0; i < 20; i++) {
        const c = await frame(page, i === 0 ? 0 : 11);
        assert.equal(c.info.app, 'title');
        const right = c.texts.filter(x => x[4] === 'r').map(x => x[0]);
        assert.ok(right.includes('BEST') && right.includes('MUTED'), `${size} title: BEST and MUTED drawn right-aligned: ` + JSON.stringify(right));
        assert.ok(c.field.length >= 300, `${size} title frame ${i}: the field is drawn (${c.field.length} dots)`);
        near += clean(c, `${size} title frame ${i}`);
      }
      t.diagnostic(`${size} title: ${near} field dots within 8 units of BEST or MUTED over 20 frames`);
      assert.ok(near >= 5, `${size} title: the field reaches close to BEST and MUTED (${near} dots within 8 units over 20 frames)`);
      // the board page with 10 rows
      await page.evaluate(() => SL.page('table'));
      near = 0;
      for (let i = 0; i < 30; i++) {
        const c = await frame(page, 7);
        const right = c.texts.filter(x => x[4] === 'r').map(x => x[0]);
        assert.ok(c.texts.some(x => x[0] === 'ALL-TIME'), `${size} board page drawn: ` + JSON.stringify(c.texts.map(x => x[0])));
        for (const want of ['1.', '10.', '9876543', '3', 'D']) assert.ok(right.includes(want), `${size} board page: "${want}" drawn right-aligned: ` + JSON.stringify(right));
        assert.ok(right.length >= 23, `${size} board page: 10 ranks, 10 scores and 3 D marks right-aligned (${right.length})`);
        assert.ok(c.field.length >= 300, `${size} board page frame ${i}: the field is drawn (${c.field.length} dots)`);
        near += clean(c, `${size} board page frame ${i}`);
      }
      t.diagnostic(`${size} board page: ${near} field dots within 8 units of a right-aligned string over 30 frames`);
      assert.ok(near >= 30, `${size} board page: the field reaches close to the right-aligned columns (${near} dots within 8 units over 30 frames)`);
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  for (const look of [0, 3]) {
    test(`${size} LOW-4, look ${look}: the clear sweep starts outside the well walls (a 14-row and a 1-row clear)`, { timeout: 120000 }, async t => {
      const { ctx, page, problems } = await open(w, h, phone, null, look);
      // the well's wall line (render/looks.js frame: walls at BX0 - 3 and BX1 + 3); a sweep dot's edge must stay outside it
      const WL = CX - (BX0 - 3), WR = (BX1 + 3) - CX;
      assert.equal(WL, WR, 'the well is centred');
      try {
        for (const [heights, rows] of [[[14, 14, 14, 14, 13, 14, 14, 14, 14], 14], [[1, 1, 1, 1, 0, 1, 1, 1, 1], 1]]) {
          await page.evaluate(h => { SL.setHeights(h); SL.place(4, 0); }, heights);
          let c = await frame(page, 0);
          assert.equal(c.fx.clearRows, rows, `${size}: a ${rows}-row clear is on screen: ` + JSON.stringify(c.fx));
          let swept = 0, minX = 400, maxX = 0, inner = Infinity;
          for (let k = 0; k < 30; k++) {
            for (const d of c.sweep) {
              if (d[3] <= 0) continue;
              const e = Math.abs(d[0] - CX) - d[2] / 2; // the dot's inner edge, from the well centre
              assert.ok(e >= WL, `${size} look ${look} ${rows}-row clear, age ${c.fx.clearAge}: sweep dot at (${d[0].toFixed(2)}, ${d[1].toFixed(2)}) size ${d[2].toFixed(2)} reaches ${e.toFixed(2)} from the well centre, inside the wall line at ${WL}`);
              if (e < inner) inner = e;
              swept++;
              if (d[0] < minX) minX = d[0]; if (d[0] > maxX) maxX = d[0];
            }
            c = await frame(page, 1);
          }
          t.diagnostic(`${size} look ${look} ${rows}-row clear: ${swept} sweep dots, x ${minX.toFixed(1)} to ${maxX.toFixed(1)}, closest edge ${inner.toFixed(2)} from the centre (wall line ${WL})`);
          assert.ok(swept >= 100 * rows, `${size} ${rows}-row clear: the sweep is drawn (${swept} dots over 30 frames)`);
          assert.ok(inner <= WL + 10, `${size} ${rows}-row clear: the sweep starts at the wall (closest edge ${inner.toFixed(2)}, wall line ${WL})`);
          assert.ok(minX <= 5 && maxX >= 395, `${size} ${rows}-row clear: the sweep reaches both screen edges (x ${minX.toFixed(1)} to ${maxX.toFixed(1)})`);
        }
        assert.deepEqual(problems, []);
      } finally { await ctx.close(); }
    });
  }
}
