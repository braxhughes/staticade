// STACKLIGHT GLOW meter placement (browser): the GLOW meter stays clear of the well wall and the HUD text (the owner said it looked "a little close and seems off").
// The real stacklight.html in headless Chrome. Three taps are put in front of modules by routing (the repo files are untouched):
// gfx.dot (every dot of a frame), the font text() (each string and where), and two markers in render.js around the glowMeter
// and frame calls, so the dots of the meter and of the well frame are read from the dot buffer, not from constants.
// At 1000x750 and the phone sizes 844x390, 844x340 and 667x375, for GLOW 0 to 4 (GLOW 4 with the timer ring full):
//   1. every meter dot (the centre, rings 1 to 4, the 32-dot timer ring) is at least 6 field units, edge to edge, from every
//      dot of the well's left wall (the frame edge and the outer GLOW edge)
//   2. every meter dot is at least 6 field units from every string drawn that frame (GLOW, X1.75, SCORE, LINES, ...)
//   3. the meter stays inside the 400 x 300 field
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticServer, WAIT, ROOT } from './w25-helpers.mjs';

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const mark = (call, k) => `if (window.__dots) window.__${k}0 = window.__dots.length; ${call} if (window.__dots) window.__${k}1 = window.__dots.length;`;
const GLOW_CALL = 'glowMeter(sim.glow, sim.glowT, sim.glowFrames);', FRAME_CALL = 'frame(sim.glow, stackHigh(sim.grid));';
const TAPS = [
  ['engine/gl-dots.js', 'function dot(x, y, s, r, g, b, a) {', 'function dot(x, y, s, r, g, b, a) { if (window.__dots) window.__dots.push(x, y, s, r, g, b, a);'],
  ['engine/font.js', 'return function text(str, x, y, col, sc, align, a, wave) {', 'return function text(str, x, y, col, sc, align, a, wave) { if (window.__tlog) window.__tlog.push([str, x, y, sc || 1, align || "l"]);'],
  ['games/stacklight/render.js', GLOW_CALL, mark(GLOW_CALL, 'gm')],
  ['games/stacklight/render.js', FRAME_CALL, mark(FRAME_CALL, 'fr')]
];
const BODY = {};
for (const [f, from, to] of TAPS) {
  const src = BODY[f] || read(f);
  if (!src.includes(from)) throw new Error(f + ' no longer has the line the tap wraps: ' + from);
  BODY[f] = src.replace(from, to);
}
const PAGE_INIT = `try { localStorage.setItem('stacklight.crt', '0'); } catch (e) {}`;

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

async function open(w, h, phone) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: phone, isMobile: phone });
  for (const f of Object.keys(BODY)) await ctx.route('**/' + f, r => r.fulfill({ status: 200, contentType: 'text/javascript', body: BODY[f] }));
  await ctx.addInitScript(PAGE_INIT);
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.goto(web.url + 'stacklight.html');
  await page.waitForFunction(() => window.SL && SL.info().app === 'title' && SL.hud().F > 5, null, WAIT);
  return { ctx, page, problems };
}

// one rendered frame: the meter dots, the left wall dots, and the text boxes drawn (field units)
async function capture(page) {
  return page.evaluate(() => new Promise(res => {
    requestAnimationFrame(() => {
      window.__dots = []; window.__tlog = [];
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const d = window.__dots, t = window.__tlog; window.__dots = null; window.__tlog = null;
        const rows = (a, b) => { const o = []; for (let i = a * 7; i < b * 7; i += 7) o.push([d[i], d[i + 1], d[i + 2], d[i + 6]]); return o; };
        res({ meter: rows(window.__gm0 / 7, window.__gm1 / 7), frame: rows(window.__fr0 / 7, window.__fr1 / 7), texts: t, info: SL.info() });
      }));
    });
  }));
}

const textBox = ([str, x, y, sc, align]) => {
  const w = str.length * 6 * sc - sc, x0 = align === 'c' ? x - w / 2 : align === 'r' ? x - w : x, h = sc * 0.95 / 2; // font dot size sc * 0.95
  return { str, x0: x0 - h, y0: y - h, x1: x0 + w + h, y1: y + 6 * sc + h };
};
// distance from a dot's edge (centre +- size / 2) to a box (0 when they touch or overlap)
const dotToBox = (m, b) => Math.max(0, Math.hypot(Math.max(b.x0 - m[0], 0, m[0] - b.x1), Math.max(b.y0 - m[1], 0, m[1] - b.y1)) - m[2] / 2);

function check(c, tag) {
  const { meter, frame, texts } = c;
  assert.equal(meter.length, 1 + 6 + 12 + 18 + 24 + 32, tag + ': the meter draws its centre, 4 rings and the 32-dot timer ring');
  const wall = frame.filter(w => w[0] < 200);
  assert.ok(wall.length > 50, tag + ': the left wall is drawn: ' + wall.length);
  let worst = Infinity, wm = null, ww = null;
  for (const m of meter) for (const w of wall) {
    const e = Math.hypot(m[0] - w[0], m[1] - w[1]) - m[2] / 2 - w[2] / 2;
    if (e < worst) { worst = e; wm = m; ww = w; }
  }
  assert.ok(worst >= 6, `${tag}: GLOW dot at (${wm[0].toFixed(2)}, ${wm[1].toFixed(2)}) is ${worst.toFixed(2)} from the well wall dot at (${ww[0].toFixed(2)}, ${ww[1].toFixed(2)}), under 6`);
  for (const t of texts) {
    const b = textBox(t);
    for (const m of meter) {
      const e = dotToBox(m, b);
      assert.ok(e >= 6, `${tag}: GLOW dot at (${m[0].toFixed(2)}, ${m[1].toFixed(2)}) is ${e.toFixed(2)} from the text "${b.str}"`);
    }
  }
  for (const m of meter) assert.ok(m[0] - m[2] / 2 >= 0 && m[0] + m[2] / 2 <= 400 && m[1] - m[2] / 2 >= 0 && m[1] + m[2] / 2 <= 300, tag + ': meter dot outside the field: ' + m);
  return worst;
}

for (const [w, h, phone] of [[1000, 750, false], [844, 390, true], [844, 340, true], [667, 375, true]]) {
  test(`GLOW meter at ${w}x${h}: 6 units clear of the well wall and the HUD text at GLOW 0 to 4, timer ring full at GLOW 4`, { timeout: 90000 }, async t => {
    const { ctx, page, problems } = await open(w, h, phone);
    try {
      await page.evaluate(() => { SL.start(1); SL.setHeights([8, 8, 8, 8, 0, 8, 8, 8, 8]); });
      const seen = new Set();
      let c = await capture(page);
      for (let i = 0; i < 6; i++) {
        const g = c.info.glow;
        seen.add(g);
        const worst = check(c, `${w}x${h} GLOW ${g}`);
        t.diagnostic(`GLOW ${g}: closest wall gap ${worst.toFixed(2)}`);
        if (g === 4) {
          assert.ok(c.info.glowT > 0, 'GLOW 4 timer running');
          const timer = c.meter.slice(1 + 60), lit = timer.filter(m => m[3] > 0.5).length;
          if (c.info.glowT >= 0.97 * 240) assert.equal(lit, 32, 'timer ring full at GLOW 4: ' + lit);
          seen.add('full:' + lit);
        }
        await page.evaluate(() => SL.place(3, 0));
        c = await capture(page);
      }
      assert.ok(seen.has(0) && seen.has(3) && seen.has(4) && seen.has('full:32'), 'covered GLOW 0, 3 (the longest label X1.75) and 4 with the ring full: ' + JSON.stringify([...seen]));
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });
}
