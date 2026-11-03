// the touch PAUSE button in corner mode (no bezel strip wide enough: iPad 1180x820, 1024x768, 1000x750 with touch).
// Through starfall.html and index.html in headless Chrome (system Chrome) with real taps (Playwright touchscreen) and real
// dispatched TouchEvents, as the other touch tests do.
//   glyph:   the glyph is FOUND FROM PIXELS (the canvas as the frame drew it, a per-pixel minimum over several frames so moving
//            things drop out, then the glyph's grey-blue colour), never from the hook. A tap at the centre of the drawn glyph
//            pauses, CRT on and CRT off, at 1180x820 and 1024x768; SF.pauseButton() is the box the glyph is drawn in; a tap on
//            the old spot (unwarped corner, now empty bezel) and a tap just left of the glyph do not pause.
//   boss:    in a boss fight the boss name and HP bar (found from pixels) and the score digits stay clear of the button, CRT on
//            and off, at 1180x820, 1024x768 and 1000x750.
//   fingers: the steering finger keeps steering (its own x is recorded, not the button finger's) when the button finger went
//            down first, and when it went down second (review mutant M7).
//   lobby:   after a Starfall run the PAUSE spot does not leak into the arcade lobby (review mutant M10); a quick second tap on
//            the PAUSE spot resumes and never leaves for the lobby (the corner box overlaps the pause screen's LOBBY box).
//   alloc:   no Float32Array, Float64Array, Int32Array, Uint8Array, Uint16Array or Array built per frame in corner mode.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { staticServer, WAIT } from './w25-helpers.mjs';
import { decode } from '../engine/replay.js';
import { W_TOUCH, W_ALT_PRESS, wordTouchX } from '../engine/input-word.js';

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

function watch(page) {
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  return problems;
}
async function open(w, h, init = null) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true });
  const page = await ctx.newPage();
  const problems = watch(page);
  if (init) await page.addInitScript(init);
  await page.goto(web.url + 'starfall.html');
  await page.waitForFunction(() => window.SF, null, WAIT);
  return { ctx, page, problems };
}
async function toTitle(page) {
  await page.evaluate(() => SF.skip());
  await page.waitForFunction(() => SF.app() === 'title', null, WAIT);
  await page.waitForTimeout(450);
}
async function intoRun(page) {
  await toTitle(page);
  await page.evaluate(() => SF.mode('free'));
  await page.evaluate(() => { let n = 0; while (SF.state === 'intro' && n++ < 1000) SF.autoFire(1); });
  assert.equal(await page.evaluate(() => SF.runInfo().claimed), true);
}
// stage 5 (ECLIPSE) with god mode, stepped until the boss is on (its name and HP bar show from the stage intro on)
async function intoBoss(page) {
  await toTitle(page);
  await page.evaluate(() => { SF.god(true); SF.start(5, 77); });
  await page.waitForFunction(() => SF.app() === 'game', null, WAIT);
  await page.evaluate(() => { let n = 0; while (!SF.info().boss && n++ < 5000) SF.autoFire(1); });
  assert.equal(await page.evaluate(() => SF.info().boss), true, 'the boss is on');
}
const touch = (page, type, touches, changed) => page.evaluate(([type, touches, changed]) => {
  const c = document.getElementById('c');
  const mk = ([id, x, y]) => new Touch({ identifier: id, target: c, clientX: x, clientY: y });
  c.dispatchEvent(new TouchEvent(type, { touches: touches.map(mk), targetTouches: touches.map(mk), changedTouches: changed.map(mk), bubbles: true, cancelable: true }));
}, [type, touches, changed]);
const btn = page => page.evaluate(() => SF.pauseButton());
const paused = page => page.evaluate(() => SF.paused());
const frames = page => page.evaluate(() => SF.info().frames);
const words = async (page, a, b) => decode(await page.evaluate(() => SF.replay())).words.slice(a, b);
// a first tap low in the field marks a touch player (the button then shows); let its FIRE settle
const markTouch = async (page, w, h) => { await page.touchscreen.tap(w / 2, h * 0.7); await page.waitForTimeout(600); };
// the playfield (400 x 300, letterboxed, centred) in CSS px
const fieldOf = (w, h) => { const s = Math.min(w / 400, h / 300); return { s, x: (w - 400 * s) / 2, y: (h - 300 * s) / 2 }; };
const toCss = (w, h, fx, fy) => { const f = fieldOf(w, h); return [f.x + fx * f.s, f.y + fy * f.s]; };
// the earlier corner box (field x W-9-sz .. W-9, y 9 .. 9+sz, sz = 48 CSS px) as a CSS px centre: where the old hit box was
const oldSpot = (w, h) => { const f = fieldOf(w, h), sz = 48 / f.s; return toCss(w, h, 400 - 9 - sz / 2, 9 + sz / 2); };

// The canvas as frames drew it (read in a rAF after the loop's own callback), the top-right part of the field only (field x
// 250..400, y 0..120: never the bezel strips beside the field). Per pixel the minimum of each channel over K frames ~90 ms
// apart, so stars, enemies and shots drop out and static things (HUD, the button) stay. Returns CSS px boxes:
//   glyph (broad = true, no boss on screen): any static pixel with a channel at least 35 that is not the teal multiplier text;
//          this finds the glyph also when it is drawn through the CRT warp (colour fringes), to prove the check can fail.
//   glyph (broad = false, beside the boss HUD): pixels of the button's grey-blue (0.45, 0.45, 0.62 and 0.6, 0.6, 0.85): red and green equal (within 6 or 12%), blue
//          about 1.4 times them (1.15x + 6 to 1.8x + 12), blue at least 40. The violet boss name (red 1.44 times green) is not it.
//          The glyph is the 56 x 56 CSS px window (box plus glow) with the most such pixels (the boss HP bar's dim end shares the colour but is a line).
//   hud:   saturated pixels (max channel at least 60, max - min at least 50) that are not the glyph's blue with red = green: the
//          boss name (violet), the HP bar (rose); plus any
//          grey-blue pixels outside the glyph window
function scan(page, broad = false, K = 7) {
  return page.evaluate(([broad, K]) => new Promise(res => {
    const c = document.getElementById('c'), r = c.getBoundingClientRect(), dpr = c.width / r.width;
    const s = Math.min(c.width / 400, c.height / 300), fx0 = (c.width - 400 * s) / 2, fy0 = (c.height - 300 * s) / 2;
    const x0 = Math.floor(fx0 + 250 * s), x1 = Math.floor(fx0 + 400 * s), y0 = Math.max(0, Math.floor(fy0)), y1 = Math.ceil(fy0 + 120 * s);
    const W = x1 - x0, H = y1 - y0, mn = new Uint8ClampedArray(W * H * 4).fill(255);
    const t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
    const g = t.getContext('2d', { willReadFrequently: true });
    let k = 0;
    const grab = () => {
      g.drawImage(c, 0, 0);
      const d = g.getImageData(x0, y0, W, H).data;
      for (let i = 0; i < d.length; i++) if (d[i] < mn[i]) mn[i] = d[i];
      if (++k < K) setTimeout(() => requestAnimationFrame(grab), 90); else done();
    };
    const box = () => ({ n: 0, x0: 1e9, y0: 1e9, x1: -1, y1: -1 });
    const add = (b, x, y) => { b.n++; if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y; };
    const css = b => b.n ? { n: b.n, x0: (x0 + b.x0) / dpr + r.left, x1: (x0 + b.x1 + 1) / dpr + r.left, y0: (y0 + b.y0) / dpr + r.top, y1: (y0 + b.y1 + 1) / dpr + r.top } : null;
    function done() {
      // grey-blue mask, then the 56 x 56 CSS px window holding the most of it (an integral image): that is the glyph. The dim
      // unlit end of the boss HP bar has the same grey-blue, but it is a thin line, so it never wins a square window.
      const isG = new Uint8Array(W * H), I = new Int32Array((W + 1) * (H + 1));
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4, R = mn[i], G = mn[i + 1], B = mn[i + 2], rg = Math.max(R, G);
        if (broad ? Math.max(R, G, B) >= 35 && !(G >= 1.8 * R + 20 && B >= 1.6 * R + 20 && Math.abs(G - B) < 0.3 * Math.max(G, B))
          : B >= 40 && Math.abs(R - G) <= Math.max(6, 0.12 * rg) && B >= 1.15 * rg + 6 && B <= 1.8 * rg + 12) isG[y * W + x] = 1;
      }
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) I[(y + 1) * (W + 1) + x + 1] = isG[y * W + x] + I[y * (W + 1) + x + 1] + I[(y + 1) * (W + 1) + x] - I[y * (W + 1) + x];
      const S = Math.min(W, H, Math.round(56 * dpr)); // the 48 px box plus the dots' glow
      let best = -1, bx = 0, by = 0;
      for (let y = 0; y + S <= H; y++) for (let x = 0; x + S <= W; x++) {
        const v = I[(y + S) * (W + 1) + x + S] - I[y * (W + 1) + x + S] - I[(y + S) * (W + 1) + x] + I[y * (W + 1) + x];
        if (v > best) { best = v; bx = x; by = y; }
      }
      const m = Math.round(6 * dpr), wx0 = bx - m, wx1 = bx + S + m, wy0 = by - m, wy1 = by + S + m; // the window and a small margin
      const gl = box(), hud = box();
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4, R = mn[i], G = mn[i + 1], B = mn[i + 2], hi = Math.max(R, G, B), lo = Math.min(R, G, B);
        const inWin = x >= wx0 && x < wx1 && y >= wy0 && y < wy1;
        if (isG[y * W + x]) { if (inWin) add(gl, x, y); else add(hud, x, y); }
        else if (hi >= 60 && hi - lo >= 50 && !(B === hi && Math.abs(R - G) <= Math.max(6, 0.12 * Math.max(R, G)))) add(hud, x, y); // a bright glyph core (blue, red = green) is not HUD
      }
      res({ glyph: css(gl), hud: css(hud) });
    }
    requestAnimationFrame(grab);
  }), [broad, K]);
}
const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const hookBox = b => ({ x0: b.x, x1: b.x + b.w, y0: b.y, y1: b.y + b.h });
const fmt = b => b ? `x ${b.x0.toFixed(1)}..${b.x1.toFixed(1)} y ${b.y0.toFixed(1)}..${b.y1.toFixed(1)}` + (b.n ? ` (${b.n} px)` : '') : 'none';

describe('w53b corner mode: the button pauses where it is seen', () => {
  for (const [w, h] of [[1180, 820], [1024, 768]]) for (const crt of [true, false]) {
    test(`${w}x${h} CRT ${crt ? 'on' : 'off'}: a tap at the centre of the drawn glyph (from pixels) pauses; the old spot and the bezel beside it do not`, { timeout: 150000 }, async () => {
      const { ctx, page, problems } = await open(w, h);
      try {
        await page.evaluate(c => SF.crt(c), crt);
        await intoRun(page);
        await markTouch(page, w, h);
        assert.equal(await page.evaluate(() => SF.info().crt), crt);
        const b = await btn(page);
        assert.ok(b, 'shown');
        assert.equal(b.where, 'corner');
        const { glyph } = await scan(page, true);
        assert.ok(glyph && glyph.n >= 40, 'the glyph is found in the pixels: ' + fmt(glyph));
        const gw = glyph.x1 - glyph.x0, gh = glyph.y1 - glyph.y0;
        assert.ok(gw >= 30 && gh >= 30, 'glyph size about the 48 px box: ' + fmt(glyph));
        const hb = hookBox(b);
        const gx = (glyph.x0 + glyph.x1) / 2, gy = (glyph.y0 + glyph.y1) / 2;
        // not here: the old hit box spot (no glyph there now), and empty bezel just left of the glyph
        const [ox, oy] = oldSpot(w, h);
        assert.ok(!(ox >= glyph.x0 && ox <= glyph.x1 && oy >= glyph.y0 && oy <= glyph.y1), 'the old spot is off the glyph');
        for (const [tx, ty, what] of [[ox, oy, 'the old w53 spot'], [glyph.x0 - 14, gy, 'just left of the glyph']]) {
          await page.touchscreen.tap(tx, ty);
          await page.waitForTimeout(350);
          assert.equal(await paused(page), false, `a tap on ${what} (${tx.toFixed(0)}, ${ty.toFixed(0)}) does not pause`);
        }
        await page.waitForTimeout(300);
        await page.touchscreen.tap(gx, gy);
        await page.waitForFunction(() => SF.paused() === true, null, { timeout: 5000 }).catch(() => {});
        assert.equal(await paused(page), true, `a tap at the drawn glyph's centre (${gx.toFixed(1)}, ${gy.toFixed(1)}) pauses`);
        // the hook tells where the glyph really is: the drawn glyph (with its glow, up to 8 px) sits on the hook box
        const tol = 8;
        assert.ok(glyph.x0 >= hb.x0 - tol && glyph.x1 <= hb.x1 + tol && glyph.y0 >= hb.y0 - tol && glyph.y1 <= hb.y1 + tol,
          `drawn glyph ${fmt(glyph)} on the hook box ${fmt(hb)}`);
        assert.deepEqual(problems, []);
      } finally { await ctx.close(); }
    });
  }
});

describe('w53b corner mode: clear of the boss HUD and the score', () => {
  for (const [w, h] of [[1180, 820], [1024, 768], [1000, 750]]) for (const crt of [true, false]) {
    test(`${w}x${h} CRT ${crt ? 'on' : 'off'}, boss fight: the boss name and HP bar (from pixels) do not touch the button`, { timeout: 150000 }, async () => {
      const { ctx, page, problems } = await open(w, h);
      try {
        await page.evaluate(c => SF.crt(c), crt);
        await intoBoss(page);
        await markTouch(page, w, h);
        const b = await btn(page);
        assert.ok(b && b.where === 'corner', 'shown in the corner');
        const { glyph, hud } = await scan(page);
        assert.ok(hud && hud.n >= 40, 'the boss name and HP bar are found in the pixels: ' + fmt(hud));
        assert.ok(glyph && glyph.n >= 40, 'the glyph is found: ' + fmt(glyph));
        const hb = hookBox(b);
        assert.ok(!overlap(hud, hb), `boss HUD ${fmt(hud)} clear of the button box ${fmt(hb)}`);
        assert.ok(!overlap(hud, glyph), `boss HUD ${fmt(hud)} clear of the drawn glyph ${fmt(glyph)}`);
        // the score digits are at the top left (field x 8 on): the button is in the right quarter of the field
        const f = fieldOf(w, h);
        assert.ok(hb.x0 > f.x + 300 * f.s, 'far right of the score block and BEST');
        assert.equal(await page.evaluate(() => SF.info().boss), true, 'still the boss fight');
        assert.deepEqual(problems, []);
      } finally { await ctx.close(); }
    });
  }
});

describe('w53b fingers: the steering finger keeps its own x', () => {
  for (const [w, h] of [[844, 390], [1180, 820]]) {
    test(`${w}x${h}: button finger first then a steering finger, and steering finger first then the button finger: the recorded x is the steering finger's`, { timeout: 150000 }, async () => {
      const { ctx, page, problems } = await open(w, h);
      try {
        await intoRun(page);
        await markTouch(page, w, h);
        const b = await btn(page), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        const f = fieldOf(w, h), sx = f.x + 60 * f.s, sy = f.y + 220 * f.s; // the steering finger, field x 60
        // order 1: button finger down first, then the steering finger
        let f0 = await frames(page);
        await touch(page, 'touchstart', [[1, cx, cy]], [[1, cx, cy]]);
        await page.waitForTimeout(150);
        await touch(page, 'touchstart', [[1, cx, cy], [2, sx, sy]], [[2, sx, sy]]);
        await page.waitForTimeout(350);
        let f1 = await frames(page);
        let ws = (await words(page, f0, f1)).filter(x => (x & W_TOUCH) !== 0);
        assert.ok(ws.length > 8, 'the field finger steers (' + ws.length + ' touch words)');
        assert.ok(ws.every(x => Math.abs(wordTouchX(x) - 60) <= 2), 'every touch word steers to field x 60, not the button: ' + JSON.stringify([...new Set(ws.map(wordTouchX))]));
        assert.ok(!(await words(page, f0, f1)).some(x => (x & W_ALT_PRESS) !== 0), 'no kindle');
        await touch(page, 'touchend', [[2, sx, sy]], [[1, cx, cy]]); // the button finger lifts on the button: pause
        await page.waitForFunction(() => SF.paused() === true, null, WAIT);
        await touch(page, 'touchend', [], [[2, sx, sy]]);
        await page.waitForTimeout(250);
        assert.equal(await paused(page), true, 'the steering finger lifting is not a resume tap');
        await page.touchscreen.tap(w / 2, h * 0.6); // resume
        await page.waitForFunction(() => SF.paused() === false, null, WAIT);
        await page.waitForTimeout(400);
        // order 2: steering finger first (field x 300), then the button finger
        const sx2 = f.x + 300 * f.s;
        f0 = await frames(page);
        await touch(page, 'touchstart', [[3, sx2, sy]], [[3, sx2, sy]]);
        await page.waitForTimeout(150);
        await touch(page, 'touchstart', [[3, sx2, sy], [4, cx, cy]], [[4, cx, cy]]);
        await page.waitForTimeout(350);
        f1 = await frames(page);
        ws = (await words(page, f0, f1)).filter(x => (x & W_TOUCH) !== 0);
        assert.ok(ws.length > 8, 'the field finger steers (' + ws.length + ')');
        assert.ok(ws.every(x => Math.abs(wordTouchX(x) - 300) <= 2), 'every touch word steers to field x 300: ' + JSON.stringify([...new Set(ws.map(wordTouchX))]));
        await touch(page, 'touchend', [[3, sx2, sy]], [[4, cx, cy]]);
        await page.waitForFunction(() => SF.paused() === true, null, WAIT);
        await touch(page, 'touchend', [], [[3, sx2, sy]]);
        assert.deepEqual(problems, []);
      } finally { await ctx.close(); }
    });
  }
});

describe('w53b lobby', () => {
  async function fromLobby(w, h) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true });
    const page = await ctx.newPage();
    const problems = watch(page);
    await page.goto(web.url + 'index.html');
    await page.waitForFunction(() => window.LOBBY && LOBBY.info().mode === 'lobby', null, WAIT);
    await page.evaluate(() => LOBBY.wordmarkSkip());
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => LOBBY.info().mode === 'gone' && window.SF && SF.away() === false, null, WAIT);
    return { ctx, page, problems };
  }
  // the pause screen's touch LOBBY button (field box 322..392 x 32..56) centre, CSS px
  const lobbyBtn = (w, h) => toCss(w, h, 357, 44);

  test('1180x820 from the lobby: a quick second tap on the PAUSE spot resumes and never leaves; a finger held on the button is let go on leaving; in the lobby the PAUSE spot is the lobby\'s; back in Starfall the button works and LOBBY leaves at once', { timeout: 200000 }, async () => {
    const W = 1180, H = 820;
    const { ctx, page, problems } = await fromLobby(W, H);
    try {
      await intoRun(page);
      await markTouch(page, W, H);
      const b = await btn(page), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      assert.equal(b.where, 'corner');
      // the corner box and the LOBBY hit box overlap: a fast double tap on the PAUSE spot must not abandon the run
      await page.touchscreen.tap(cx, cy);
      await page.waitForFunction(() => SF.paused() === true, null, WAIT);
      await page.touchscreen.tap(cx, cy);
      await page.waitForFunction(() => SF.paused() === false, null, WAIT);
      assert.equal(await page.evaluate(() => SF.away()), false, 'the double tap paused and resumed; it did not leave');
      assert.equal(await page.evaluate(() => SF.app()), 'game');
      // a finger is down on the button (never lifted: a lost touchend) when the run is paused with Esc and left with LOBBY
      await page.waitForTimeout(300);
      await touch(page, 'touchstart', [[11, cx, cy]], [[11, cx, cy]]);
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => SF.pauseButtonFinger()), 11, 'the button tracks the held finger');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => SF.paused() === true, null, WAIT);
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => SF.lobbyButton()), true);
      await page.touchscreen.tap(...lobbyBtn(W, H));
      await page.waitForFunction(() => SF.away() === true && LOBBY.info().mode === 'lobby', null, WAIT);
      assert.equal(await page.evaluate(() => SF.pauseButtonFinger()), -1, 'leaving for the lobby lets go of the held finger');
      // in the lobby a finger held on the old PAUSE spot is the lobby's, not Starfall's
      await page.waitForTimeout(300);
      assert.equal(await btn(page), null, 'no PAUSE button while away');
      await touch(page, 'touchstart', [[7, cx, cy]], [[7, cx, cy]]);
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => SF.pauseButtonFinger()), -1, 'Starfall does not track a lobby finger on its PAUSE spot');
      await touch(page, 'touchend', [], [[7, cx, cy]]);
      assert.equal(await page.evaluate(() => SF.pauseButtonFinger()), -1);
      // a real tap there is the lobby's: the right screen edge steps to the next machine
      const i0 = await page.evaluate(() => LOBBY.info().index);
      await page.touchscreen.tap(cx, cy);
      await page.waitForFunction(i0 => LOBBY.info().index !== i0, i0, WAIT);
      assert.equal(await page.evaluate(() => LOBBY.info().mode), 'lobby', 'the lobby stepped, nothing else');
      assert.equal(await page.evaluate(() => SF.pauseButtonFinger()), -1);
      // back to Starfall's cabinet and in
      await page.waitForFunction(() => !LOBBY.info().moving, null, WAIT);
      await page.evaluate(() => LOBBY.go(LOBBY.info().ids.indexOf('starfall')));
      await page.waitForFunction(() => !LOBBY.info().moving && LOBBY.info().id === 'starfall', null, WAIT);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => LOBBY.info().mode === 'gone' && SF.away() === false, null, WAIT);
      // back in Starfall: a fresh run is not paused by anything left over, and the button pauses
      await intoRun(page);
      await markTouch(page, W, H);
      assert.equal(await paused(page), false, 'nothing left over pauses the new run');
      const b2 = await btn(page);
      assert.ok(b2 && b2.where === 'corner');
      await page.waitForTimeout(400);
      assert.equal(await paused(page), false);
      await page.touchscreen.tap(b2.x + b2.w / 2, b2.y + b2.h / 2);
      await page.waitForFunction(() => SF.paused() === true, null, WAIT);
      // the double-tap guard covers only the PAUSE spot: LOBBY's own centre leaves at once after a button pause
      await page.touchscreen.tap(...lobbyBtn(W, H));
      await page.waitForFunction(() => SF.away() === true && LOBBY.info().mode === 'lobby', null, WAIT);
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });
});

describe('w53b allocation', () => {
  const COUNT = () => {
    window.__alloc = 0; window.__count = false; window.__kinds = {};
    for (const n of ['Float32Array', 'Float64Array', 'Int32Array', 'Uint8Array', 'Uint16Array', 'Array']) {
      const Orig = window[n];
      window[n] = new Proxy(Orig, { construct(t, a, nt) { if (window.__count) { window.__alloc++; window.__kinds[n] = (window.__kinds[n] || 0) + 1; } return Reflect.construct(t, a, nt); } });
    }
  };
  const nextFrames = (page, k) => page.evaluate(k => new Promise(r => { let f = 0; const t = () => { if (++f >= k) r(); else requestAnimationFrame(t); }; requestAnimationFrame(t); }), k);
  const counted = async (page, k) => {
    await page.evaluate(() => { window.__alloc = 0; window.__kinds = {}; window.__count = true; });
    await nextFrames(page, k);
    return page.evaluate(() => { window.__count = false; return { n: window.__alloc, kinds: window.__kinds }; });
  };
  test('1180x820 corner, CRT on and off: zero constructions per frame while the button is drawn and while it is pressed', { timeout: 180000 }, async () => {
    for (const crt of [true, false]) {
      const { ctx, page, problems } = await open(1180, 820, COUNT);
      try {
        await page.evaluate(c => SF.crt(c), crt);
        await intoRun(page);
        await markTouch(page, 1180, 820);
        await nextFrames(page, 30);
        const b = await btn(page);
        assert.ok(b && b.where === 'corner');
        assert.equal(await page.evaluate(() => SF.pauseButtonDrawn()), true);
        let c = await counted(page, 90);
        assert.equal(c.n, 0, `CRT ${crt}: constructions per 90 frames with the button drawn: ` + JSON.stringify(c.kinds));
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        await touch(page, 'touchstart', [[9, cx, cy]], [[9, cx, cy]]);
        await nextFrames(page, 10);
        c = await counted(page, 60);
        assert.equal(c.n, 0, `CRT ${crt}: constructions per 60 frames while pressed: ` + JSON.stringify(c.kinds));
        await touch(page, 'touchend', [], [[9, 10, 10]]);
        assert.deepEqual(problems, []);
      } finally { await ctx.close(); }
    }
  });
});
