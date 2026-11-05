// STACKLIGHT play HUD (browser): the play HUD is one grid. The real stacklight.html in headless Chrome.
// Taps put in front of modules by routing (the repo files are untouched): gfx.dot (every dot of a frame, tagged by the looks.js
// function drawing it), the font text() (each string, where, its size, alignment and colour), and a wrapper on looks.js hud2 (the
// HUD panel frame: corner brackets and dividers). Frames are stepped one at a time (the frame stepper).
//   a. the left and right panels share a top line and a bottom line and a width, mirror images about the well, both in
//      SL.hudLayout() and in the frame dots actually drawn
//   b. every label is size 1 in one colour, every value size 2; each label's value sits the same 12 units under it at the same
//      x; SCORE, LEVEL, LINES, GLOW are one pitch apart; BEST shares GLOW's row and NEXT shares SCORE's; all text inside a panel
//   c. no frame or bracket dot within 1.5 units, edge to edge, of any string drawn that frame (play, a clear with its sweep,
//      paused, game over), at 1000x750 and the four phone sizes
//   d. clear points (several alive at once, from clears on the bottom rows, BEST's old spot) stay in their lane under BEST:
//      never overlapping each other, a frame dot or another string
//   e. no array or typed array built per frame in play (a clear, its popups and sweep), looks 0 and 2 (the usual Proxy)
//   f. every frame dot is on its panel's 3-unit lattice; every panel corner has the same bracket (arm / step + 1 dots each way)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticServer, WAIT, ROOT } from './w25-helpers.mjs';

const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const LOOKS = 'games/stacklight/render/looks.js';
let looksBody = read(LOOKS);
for (const name of ['hud2', 'field2', 'sweep3']) {
  if (!looksBody.includes('function ' + name + '(')) throw new Error(LOOKS + ' has no ' + name + ' for the tap to wrap');
  looksBody = looksBody.replace('function ' + name + '(',
    `function ${name}(...__a) { const __p = window.__lkTag; window.__lkTag = '${name}'; try { return __${name}(...__a); } finally { window.__lkTag = __p; } }\n  function __${name}(`);
}
const TAPS = [
  ['engine/gl-dots.js', 'function dot(x, y, s, r, g, b, a) {', 'function dot(x, y, s, r, g, b, a) { if (window.__dots) window.__dots.push(x, y, s, a, window.__lkTag === "hud2" ? 1 : 0);'],
  ['engine/font.js', 'return function text(str, x, y, col, sc, align, a, wave) {', 'return function text(str, x, y, col, sc, align, a, wave) { if (window.__tlog) window.__tlog.push([str, x, y, sc || 1, align || "l", col ? col.join(",") : ""]);']
];
const BODY = { [LOOKS]: looksBody };
for (const [f, from, to] of TAPS) {
  const src = read(f);
  if (!src.includes(from)) throw new Error(f + ' no longer has the line the tap wraps: ' + from);
  BODY[f] = src.replace(from, to);
}
const STEPPER = `(() => {
  const real = window.requestAnimationFrame.bind(window), STEP = 1000 / 60;
  let frozen = false, held = null, lastPassed = 0, offset = 0;
  window.requestAnimationFrame = cb => real(t => { if (frozen) { held = cb; return; } lastPassed = t - offset; cb(lastPassed); });
  const until = f => new Promise(r => { const c = () => (f() ? r() : setTimeout(c, 2)); c(); });
  window.__freeze = async () => { frozen = true; await until(() => held); document.dispatchEvent(new Event('visibilitychange')); lastPassed = performance.now() - offset; };
  window.__adv = async (steps = 0) => { for (;;) { const k = Math.min(steps, 14); steps -= k; const cb = held; held = null; lastPassed += k * STEP + 1e-4; cb(lastPassed); await until(() => held); if (steps <= 0) return; } };
})();`;
const INIT = `try { localStorage.setItem('stacklight.crt', '0'); localStorage.setItem('stacklight.mute', '1'); localStorage.setItem('stacklight.hi', '9999999'); } catch (e) {}`;
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

async function open(w, h, phone, { taps = true, stepper = true, init = '' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: phone, isMobile: phone });
  if (taps) for (const f of Object.keys(BODY)) await ctx.route('**/' + f, r => r.fulfill({ status: 200, contentType: 'text/javascript', body: BODY[f] }));
  await ctx.addInitScript(INIT);
  if (init) await ctx.addInitScript(init);
  if (stepper) await ctx.addInitScript(STEPPER);
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.goto(web.url + 'stacklight.html');
  await page.waitForFunction(() => window.SL && SL.info().app === 'title' && SL.hud().F > 5, null, WAIT);
  if (stepper) await page.evaluate(() => window.__freeze());
  return { ctx, page, problems };
}
// k ticks, then one rendered frame: the HUD frame dots (x, y, size, alpha) and every string
function frame(page, k = 0) {
  return page.evaluate(async k => {
    await window.__adv(k);
    window.__dots = []; window.__tlog = [];
    await window.__adv(0);
    const d = window.__dots, t = window.__tlog; window.__dots = null; window.__tlog = null;
    const hud = [];
    for (let i = 0; i < d.length; i += 5) if (d[i + 4] === 1) hud.push([d[i], d[i + 1], d[i + 2], d[i + 3]]);
    return { hud, texts: t, fx: SL.fx(), info: SL.info() };
  }, k);
}
// the box of a string's lit dots (font dot size sc * 0.95), as tests/w57b-text-keepout-browser.test.js
const textBox = ([str, x, y, sc, align]) => {
  const w = str.length * 6 * sc - sc, x0 = align === 'c' ? x - w / 2 : align === 'r' ? x - w : x, h = sc * 0.95 / 2;
  return { str, x0: x0 - h, y0: y - h, x1: x0 + w + h, y1: y + 6 * sc + h };
};
const gap = (d, b) => Math.max(0, Math.hypot(Math.max(b.x0 - d[0], 0, d[0] - b.x1), Math.max(b.y0 - d[1], 0, d[1] - b.y1)) - d[2] / 2);
const boxGap = (a, b) => Math.hypot(Math.max(0, a.x0 - b.x1, b.x0 - a.x1), Math.max(0, a.y0 - b.y1, b.y0 - a.y1));
const KEEP = 1.5;

// c: no HUD frame dot within KEEP of any string drawn this frame
function clear(c, tag) {
  assert.ok(c.hud.length >= 100, `${tag}: the HUD frame is drawn (${c.hud.length} dots)`);
  const boxes = c.texts.filter(t => t[0].trim() !== '').map(textBox);
  for (const d of c.hud) for (const b of boxes) {
    const e = gap(d, b);
    assert.ok(e >= KEEP, `${tag}: frame dot at (${d[0]}, ${d[1]}) is ${e.toFixed(2)} from the text "${b.str}" (under ${KEEP})`);
  }
}
// a and f: panels from the drawn frame dots, against SL.hudLayout()
function panels(c, L, tag) {
  for (const [side, P] of [['left', L.left], ['right', L.right]]) {
    const ds = c.hud.filter(d => (side === 'left' ? d[0] < 200 : d[0] > 200));
    const xs = ds.map(d => d[0]), ys = ds.map(d => d[1]);
    assert.deepEqual([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], [P.x0, P.y0, P.x1, P.y1], `${tag}: ${side} frame drawn on its panel box`);
    for (const d of ds) {
      assert.ok((d[0] - P.x0) % L.step === 0 && (d[1] - P.y0) % L.step === 0, `${tag}: ${side} frame dot (${d[0]}, ${d[1]}) off the ${L.step}-unit lattice from (${P.x0}, ${P.y0})`);
    }
    const has = (x, y) => ds.some(d => d[0] === x && d[1] === y);
    const n = L.arm / L.step;
    for (const [cx, cy, sx, sy] of [[P.x0, P.y0, 1, 1], [P.x1, P.y0, -1, 1], [P.x0, P.y1, 1, -1], [P.x1, P.y1, -1, -1]]) {
      for (let i = 0; i <= n; i++) {
        assert.ok(has(cx + sx * i * L.step, cy), `${tag}: ${side} corner (${cx}, ${cy}) bracket arm dot ${i} along x`);
        assert.ok(has(cx, cy + sy * i * L.step), `${tag}: ${side} corner (${cx}, ${cy}) bracket arm dot ${i} along y`);
      }
      assert.ok(!has(cx + sx * (n + 1) * L.step, cy) && !has(cx, cy + sy * (n + 1) * L.step), `${tag}: ${side} corner (${cx}, ${cy}) arm longer than ${L.arm}`);
    }
  }
}

const SIZES = [[1000, 750, false], [844, 390, true], [932, 430, true], [667, 375, true], [568, 320, true]];

test('a. SL.hudLayout(): the two panels share top, bottom and width, mirror images about the well', { timeout: 60000 }, async () => {
  const { ctx, page, problems } = await open(1000, 750, false, { taps: false, stepper: false });
  try {
    const L = await page.evaluate(() => SL.hudLayout());
    assert.equal(L.left.y0, L.right.y0, 'panel tops equal: ' + JSON.stringify(L));
    assert.equal(L.left.y1, L.right.y1, 'panel bottoms equal: ' + JSON.stringify(L));
    assert.equal(L.left.x1 - L.left.x0, L.right.x1 - L.right.x0, 'panel widths equal');
    assert.equal(L.left.x0 + L.right.x1, 400, 'mirror about x 200 (outer edges)');
    assert.equal(L.left.x1 + L.right.x0, 400, 'mirror about x 200 (inner edges)');
    assert.ok(L.left.x1 < 138.5 - 6 && L.right.x0 > 261.5 + 6, 'the panels keep off the well walls (x 138.5, 261.5)');
    for (const P of [L.left, L.right]) assert.ok((P.x1 - P.x0) % L.step === 0 && (P.y1 - P.y0) % L.step === 0, 'panel sides are whole dot steps: ' + JSON.stringify(P));
    assert.ok(L.arm % L.step === 0, 'bracket arm is whole dot steps');
    // a 7-digit score and best (size 2) fit inside their panels with the keep-out to spare
    for (const l of L.labels.filter(l => l.str === 'SCORE' || l.str === 'BEST')) {
      const P = l.x < 200 ? L.left : L.right, b = textBox(['9999999', l.x, l.valueY, L.valueSc, 'l']);
      assert.ok(b.x1 <= P.x1 - KEEP && b.x0 >= P.x0 + KEEP, `${l.str}: 7 digits fit (${b.x0}..${b.x1} in ${P.x0}..${P.x1})`);
    }
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

for (const [w, h, phone] of SIZES) {
  const size = `${w}x${h}`;
  test(`${size}: a, c, f. frame drawn on the shared panel lines and lattice; no frame dot within ${KEEP} of any string (play, clear, paused, over)`, { timeout: 120000 }, async () => {
    const { ctx, page, problems } = await open(w, h, phone);
    try {
      const L = await page.evaluate(() => SL.hudLayout());
      // play, at level 20 with GLOW lit and a long best
      // Setup only: start at lines 150 (level 19, was 190). The two places clear 2 lines, so level 20 is drawn as
      // before. On 3.0 a level 20 piece locks on its spawn frame, so from 190 the run topped out during the clear frames and
      // P had nothing to pause; from 150 the third place is a real 4-line clear and the run lasts 98+ frames past it.
      await page.evaluate(() => { SL.start(1); SL.setLines(150); SL.setHeights([8, 8, 8, 8, 0, 8, 8, 8, 8]); SL.place(3, 0); SL.place(3, 0); });
      let c = await frame(page, 2);
      panels(c, L, `${size} play`);
      clear(c, `${size} play`);
      assert.ok(c.texts.some(t => t[0] === '9999999'), `${size}: the 7-digit best is drawn`);
      assert.ok(c.texts.some(t => t[0] === '20'), `${size}: level 20 is drawn`);
      // every frame of a clear (sweep, popups)
      await page.evaluate(() => SL.place(3, 0));
      for (let k = 0; k < 30; k++) { c = await frame(page, 1); clear(c, `${size} clear frame ${k}`); }
      // paused
      await page.keyboard.press('p'); c = await frame(page, 2);
      assert.ok(c.info.paused && c.texts.some(t => t[0] === 'PAUSED'), `${size}: paused`);
      clear(c, `${size} paused`);
      await page.keyboard.press('p'); await frame(page, 2);
      // over: fill to the top
      await page.evaluate(() => { SL.start(99); let n = 0; while (!SL.info().done && n++ < 40) SL.place(4, 1); });
      for (const k of [1, 30, 60]) {
        c = await frame(page, k);
        assert.ok(c.info.done, `${size}: the run is over`);
        clear(c, `${size} over +${k}`);
      }
      assert.ok(c.texts.some(t => t[0] === 'TOP OUT'), `${size}: the results panel is up`);
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });
}

test('b. labels and values: one size and colour each, the same gap, one pitch, inside their panels', { timeout: 60000 }, async () => {
  const { ctx, page, problems } = await open(1000, 750, false);
  try {
    const L = await page.evaluate(() => SL.hudLayout());
    await page.evaluate(() => { SL.start(1); SL.setLines(16); SL.setHeights([4, 5, 3, 6, 2, 5, 4, 3, 1]); SL.place(0, 1); });
    const c = await frame(page, 2);
    const hud = await page.evaluate(() => SL.hud());
    const find = s => { const t = c.texts.filter(x => x[0] === s); assert.equal(t.length, 1, `"${s}" drawn once: ` + JSON.stringify(t)); return t[0]; };
    const pairs = [['SCORE', hud.score], ['LEVEL', hud.level], ['LINES', hud.lines], ['GLOW', hud.glow], ['BEST', hud.best]];
    const labels = ['SCORE', 'LEVEL', 'LINES', 'GLOW', 'NEXT', 'BEST'].map(find);
    assert.deepEqual([...new Set(labels.map(t => t[3]))], [1], 'every label size 1: ' + JSON.stringify(labels));
    assert.equal(new Set(labels.map(t => t[5])).size, 1, 'every label one colour: ' + JSON.stringify(labels));
    const gaps = [];
    for (const [lab, val] of pairs) {
      const l = find(lab), v = c.texts.find(t => t[0] === val && t[1] === l[1] && t[2] > l[2]);
      assert.ok(v, `${lab}: its value "${val}" is drawn at the label's x under it: ` + JSON.stringify(c.texts));
      assert.equal(v[3], 2, `${lab}: value size 2`);
      gaps.push(v[2] - l[2]);
    }
    assert.deepEqual(gaps, gaps.map(() => L.valueGap), 'label top to value top is the same for every label: ' + JSON.stringify(gaps));
    const [s, lv, ln, gl, nx, be] = labels;
    assert.equal(lv[2] - s[2], ln[2] - lv[2], 'SCORE, LEVEL, LINES one pitch apart');
    assert.equal(gl[2] - ln[2], ln[2] - lv[2], 'GLOW on the same pitch');
    assert.equal(be[2], gl[2], 'BEST on GLOW\'s row');
    assert.equal(nx[2], s[2], 'NEXT on SCORE\'s row');
    assert.ok(s[1] === lv[1] && lv[1] === ln[1] && ln[1] === gl[1], 'left labels share an x');
    assert.equal(nx[1], be[1], 'right labels share an x');
    assert.equal(s[1] - L.left.x0, nx[1] - L.right.x0, 'the same inner padding in both panels');
    for (const l of L.labels) {
      const t = c.texts.find(x => x[0] === l.str);
      assert.deepEqual([t[1], t[2]], [l.x, l.y], `${l.str} where SL.hudLayout() says`);
    }
    // every string of the HUD inside its panel, KEEP in from the edges (the well's strings excluded)
    for (const t of c.texts) {
      if (t[1] > 135 && t[1] < 265) continue;
      const b = textBox(t), P = t[1] < 200 ? L.left : L.right;
      assert.ok(b.x0 >= P.x0 + KEEP && b.x1 <= P.x1 - KEEP && b.y0 >= P.y0 + KEEP && b.y1 <= P.y1 - KEEP, `"${t[0]}" inside its panel: ` + JSON.stringify(b));
    }
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('d. clear points: several at once, from bottom-row clears, stay in the lane, never on each other, a frame dot or a string', { timeout: 90000 }, async () => {
  const { ctx, page, problems } = await open(1000, 750, false);
  try {
    const L = await page.evaluate(() => SL.hudLayout());
    // three clears of the bottom rows in quick succession (each places a BAR into the gap: rows 0 and up)
    await page.evaluate(() => { SL.start(1); SL.setHeights([8, 8, 8, 8, 0, 8, 8, 8, 8]); SL.place(3, 0); SL.place(3, 0); SL.place(3, 0); });
    let most = 0, frames = 0;
    for (let k = 0; k < 50; k++) {
      const c = await frame(page, 1);
      const live = c.fx.popups.filter(p => p.kind === 'points' && p.x > 261.5);
      const lane = c.texts.filter(t => t[0][0] === '+' && t[1] > 261.5);
      if (!lane.length) continue;
      frames++;
      most = Math.max(most, lane.length);
      // SL.fx() counts a popup alive through its last sim frame; the renderer (interpolated time) may drop it one frame earlier
      const sure = live.filter(p => c.fx.now - p.born <= 52).length;
      assert.ok(lane.length >= Math.min(sure, L.lane.n) && lane.length <= Math.min(live.length, L.lane.n), `frame ${k}: every live clear popup drawn (up to ${L.lane.n}), ${lane.length} drawn: ` + JSON.stringify(live));
      const boxes = lane.map(textBox);
      for (const t of lane) assert.equal(t[1], L.lane.x, 'centred on the lane');
      for (const b of boxes) {
        assert.ok(b.y0 >= L.lane.y - 1 && b.y1 <= L.lane.y + L.lane.n * L.lane.dy + 1, `frame ${k}: "${b.str}" inside the lane: ` + JSON.stringify(b));
        for (const d of c.hud) assert.ok(gap(d, b) >= KEEP, `frame ${k}: "${b.str}" ${gap(d, b).toFixed(2)} from the frame dot (${d[0]}, ${d[1]})`);
        for (const o of c.texts) {
          if (lane.includes(o) || o[0].trim() === '') continue;
          assert.ok(boxGap(b, textBox(o)) >= KEEP, `frame ${k}: "${b.str}" ${boxGap(b, textBox(o)).toFixed(2)} from "${o[0]}"`);
        }
      }
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        assert.ok(boxGap(boxes[i], boxes[j]) >= 1, `frame ${k}: popups "${boxes[i].str}" and "${boxes[j].str}" overlap: ` + JSON.stringify([boxes[i], boxes[j]]));
      }
    }
    assert.ok(frames >= 20 && most >= 2, `the clears put several popups up together (${most} at once, ${frames} frames)`);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

for (const look of [0, 2]) {
  test(`e. look ${look}: 0 arrays or typed arrays built over 90 frames of play with clears, popups and the sweep`, { timeout: 90000 }, async () => {
    const { ctx, page, problems } = await open(1000, 750, false, { taps: false, stepper: false, init: COUNT });
    try {
      await page.evaluate(L => SL.look(L), look);
      await page.evaluate(() => new Promise(r => { let f = 0; const t = () => (++f >= 30 ? r() : requestAnimationFrame(t)); requestAnimationFrame(t); }));
      await page.evaluate(() => { SL.start(1); SL.setHeights([8, 8, 8, 8, 0, 8, 8, 8, 8]); SL.place(3, 0); SL.place(3, 0); });
      const f = await page.evaluate(() => SL.fx());
      assert.ok(f.clearRows > 0 && f.clearAge < 30 && f.popups.some(p => p.kind === 'points' && p.x > 261.5), 'a clear and its points are on screen: ' + JSON.stringify(f));
      await page.evaluate(() => { window.__alloc = 0; window.__allocBy = {}; window.__count = true; });
      await page.evaluate(() => new Promise(r => { let f = 0; const t = () => (++f >= 90 ? r() : requestAnimationFrame(t)); requestAnimationFrame(t); }));
      const r = await page.evaluate(() => { window.__count = false; return { n: window.__alloc, by: window.__allocBy, pops: SL.fx().popups.length }; });
      assert.equal(r.n, 0, `look ${look}: ${JSON.stringify(r.by)}`);
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });
}
