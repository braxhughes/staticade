// A tap on the PAUSE spot never quits the run. Through index.html (the lobby route, so the pause
// screen has its touch LOBBY button) in headless Chrome, real touches at positions read from the drawn canvas.
//   trap:   corner mode (1180x820, 1024x768): tap the PAUSE button, wait 0.2 s, 0.9 s or 3 s, tap the same spot again: the run
//           resumes every time and Starfall never leaves (SF.away() false), CRT on and off. Paused with P instead: same. At
//           480x360 the PAUSE box reaches into the LOBBY hit box: a tap where they meet resumes too.
//   lobby:  the LOBBY panel as drawn (amber pixels on the canvas) is found from pixels; a tap at its centre or any corner leaves,
//           CRT on and off, at the iPad sizes, 1000x750 and the phone sizes. In corner mode the drawn panel and the PAUSE box
//           do not overlap.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { staticServer, WAIT } from './w25-helpers.mjs';

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

async function fromLobby(w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.goto(web.url + 'index.html');
  await page.waitForFunction(() => window.LOBBY && LOBBY.info().mode === 'lobby', null, WAIT);
  await page.evaluate(() => LOBBY.wordmarkSkip());
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => LOBBY.info().mode === 'gone' && window.SF && SF.away() === false, null, WAIT);
  return { ctx, page, problems };
}
async function intoRun(page, crt) {
  await page.evaluate(c => SF.crt(c), crt);
  await page.evaluate(() => SF.skip());
  await page.waitForFunction(() => SF.app() === 'title', null, WAIT);
  await page.waitForTimeout(450);
  await page.evaluate(() => SF.mode('free'));
  await page.evaluate(() => { let n = 0; while (SF.state === 'intro' && n++ < 1000) SF.autoFire(1); });
  assert.equal(await page.evaluate(() => SF.runInfo().claimed), true);
  assert.equal(await page.evaluate(() => SF.info().crt), crt);
}
// a first tap low in the field marks a touch player (the button then shows); let its FIRE settle
const markTouch = async (page, w, h) => { await page.touchscreen.tap(w / 2, h * 0.7); await page.waitForTimeout(600); };
const btn = page => page.evaluate(() => SF.pauseButton());
const isPaused = v => page => page.waitForFunction(v => SF.paused() === v, v, WAIT);

// The drawn LOBBY panel: amber pixels (red high, green about 0.7 of red, blue low) in the top right quarter of the PLAYFIELD
// (the 4:3 field centred in the canvas; the bezel strips beside it, with their lamps, are not scanned), minimum over K frames
// so the blink and stars drop out. Amber pixels are grouped into clusters on a grid of cells 3 field units (at least 6 pixels) wide (touching cells join, so
// the panel's dotted frame is one cluster); the cluster with the largest bounding box is the panel (its frame encloses the
// LOBBY text, which can be a separate cluster with more amber pixels). Returns its CSS px box, or null.
function lobbyPanel(page, K = 5) {
  return page.evaluate(K => new Promise(res => {
    const c = document.getElementById('c'), r = c.getBoundingClientRect(), dpr = c.width / r.width;
    const fw = Math.min(c.width, c.height * 4 / 3), fh = fw * 3 / 4, fx = (c.width - fw) / 2, fy = (c.height - fh) / 2;
    const x0 = Math.floor(fx + fw * 0.5), y0 = Math.max(0, Math.floor(fy)), W = Math.floor(fx + fw) - x0, H = Math.floor(fh * 0.4);
    const mn = new Uint8ClampedArray(W * H * 4).fill(255);
    const t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
    const g = t.getContext('2d', { willReadFrequently: true });
    let k = 0;
    const grab = () => {
      g.drawImage(c, 0, 0);
      const d = g.getImageData(x0, y0, W, H).data;
      for (let i = 0; i < d.length; i++) if (d[i] < mn[i]) mn[i] = d[i];
      if (++k < K) setTimeout(() => requestAnimationFrame(grab), 90); else done();
    };
    function done() {
      const S = Math.max(6, Math.ceil(fw / 400 * 3)), GW = Math.ceil(W / S), GH = Math.ceil(H / S), cnt = new Int32Array(GW * GH);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4, R = mn[i], G = mn[i + 1], B = mn[i + 2];
        if (R >= 70 && G >= 0.45 * R && G <= 0.85 * R && B <= 0.45 * R) cnt[((y / S) | 0) * GW + ((x / S) | 0)]++;
      }
      const lab = new Int32Array(GW * GH).fill(-1);
      let best = null;
      for (let s0 = 0; s0 < GW * GH; s0++) {
        if (!cnt[s0] || lab[s0] !== -1) continue;
        const q = [s0]; lab[s0] = s0;
        let n = 0, a = 1e9, b = 1e9, cc = -1, dd = -1;
        while (q.length) {
          const s = q.pop(), gx = s % GW, gy = (s / GW) | 0;
          n += cnt[s]; if (gx < a) a = gx; if (gx > cc) cc = gx; if (gy < b) b = gy; if (gy > dd) dd = gy;
          for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
            const nx = gx + ox, ny = gy + oy;
            if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
            const o = ny * GW + nx;
            if (cnt[o] && lab[o] === -1) { lab[o] = s0; q.push(o); }
          }
        }
        const area = (cc - a + 1) * (dd - b + 1);
        if (n >= 20 && (!best || area > best.area)) best = { id: s0, n, area, a, b, cc, dd };
      }
      if (!best) { res(null); return; }
      // pixel-exact edges inside the cluster's cells
      let a = 1e9, b = 1e9, cc = -1, dd = -1;
      for (let y = best.b * S; y < Math.min(H, (best.dd + 1) * S); y++) for (let x = best.a * S; x < Math.min(W, (best.cc + 1) * S); x++) {
        if (lab[((y / S) | 0) * GW + ((x / S) | 0)] !== best.id) continue;
        const i = (y * W + x) * 4, R = mn[i], G = mn[i + 1], B = mn[i + 2];
        if (R >= 70 && G >= 0.45 * R && G <= 0.85 * R && B <= 0.45 * R) { if (x < a) a = x; if (x > cc) cc = x; if (y < b) b = y; if (y > dd) dd = y; }
      }
      res({ n: best.n, x0: (x0 + a) / dpr + r.left, x1: (x0 + cc + 1) / dpr + r.left, y0: (y0 + b) / dpr + r.top, y1: (y0 + dd + 1) / dpr + r.top });
    }
    requestAnimationFrame(grab);
  }), K);
}
const fmt = b => b ? `x ${b.x0.toFixed(1)}..${b.x1.toFixed(1)} y ${b.y0.toFixed(1)}..${b.y1.toFixed(1)}` : 'none';

describe('w53c trap: the PAUSE spot never quits the run', () => {
  // a small 4:3 window: the 48 CSS px PAUSE box is 40 field units wide and reaches into LOBBY's hit box (field x to 368).
  // A tap where the two meet, after 0.9 s, still resumes: a touch that starts on the PAUSE box is never a LOBBY tap.
  test('480x360 CRT on, from the lobby: the PAUSE box reaches into the LOBBY hit box; a tap there after 0.9 s resumes, never leaves', { timeout: 200000 }, async () => {
    const [w, h] = [480, 360];
    const { ctx, page, problems } = await fromLobby(w, h);
    try {
      await intoRun(page, true);
      await markTouch(page, w, h);
      const b = await btn(page);
      assert.ok(b && b.where === 'corner', 'the button is in the corner');
      const v = await page.evaluate(() => { const r = document.getElementById('c').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
      const fw = Math.min(v.w, v.h * 4 / 3), s = fw / 400, lobbyR = v.l + (v.w - fw) / 2 + 368 * s; // LOBBY hit box right edge, CSS px
      assert.ok(b.x < lobbyR - 2, `precondition: the PAUSE box (from x ${b.x.toFixed(1)}) reaches into the LOBBY hit box (to x ${lobbyR.toFixed(1)})`);
      const px = (b.x + lobbyR) / 2, py = b.y + b.h / 2;
      await page.touchscreen.tap(b.x + b.w / 2, py);
      await isPaused(true)(page);
      assert.equal(await page.evaluate(() => SF.lobbyButton()), true, 'the pause screen shows LOBBY');
      await page.waitForTimeout(900);
      await page.touchscreen.tap(px, py);
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => SF.away()), false, `a tap at (${px.toFixed(1)}, ${py.toFixed(1)}), on both boxes, did not leave for the lobby`);
      assert.equal(await page.evaluate(() => SF.paused()), false, 'it resumed');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });
  for (const [w, h, crts] of [[1180, 820, [true, false]], [1024, 768, [true, false]]]) for (const crt of crts) {
    test(`${w}x${h} CRT ${crt ? 'on' : 'off'}, from the lobby: tap PAUSE, wait 0.2 s / 0.9 s / 3 s, tap the same spot: resumes each time, never leaves`, { timeout: 200000 }, async () => {
      const { ctx, page, problems } = await fromLobby(w, h);
      try {
        await intoRun(page, crt);
        await markTouch(page, w, h);
        const b = await btn(page);
        assert.ok(b && b.where === 'corner', 'the button is in the corner');
        const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
        for (const ms of [200, 900, 3000]) {
          await page.touchscreen.tap(cx, cy);
          await isPaused(true)(page);
          assert.equal(await page.evaluate(() => SF.lobbyButton()), true, 'the pause screen shows LOBBY');
          await page.waitForTimeout(ms);
          await page.touchscreen.tap(cx, cy);
          await page.waitForTimeout(300);
          assert.equal(await page.evaluate(() => SF.away()), false, `${ms} ms: the second tap on the PAUSE spot did not leave for the lobby`);
          assert.equal(await page.evaluate(() => SF.paused()), false, `${ms} ms: the second tap resumed`);
          assert.equal(await page.evaluate(() => SF.app()), 'game');
          await page.waitForTimeout(400);
        }
        // paused another way (P), a tap on the PAUSE spot resumes too
        await page.keyboard.press('KeyP');
        await isPaused(true)(page);
        await page.waitForTimeout(900);
        await page.touchscreen.tap(cx, cy);
        await page.waitForTimeout(300);
        assert.equal(await page.evaluate(() => SF.away()), false, 'P pause: a tap on the PAUSE spot did not leave');
        assert.equal(await page.evaluate(() => SF.paused()), false, 'P pause: a tap on the PAUSE spot resumed');
        assert.deepEqual(problems, []);
      } finally { await ctx.close(); }
    });
  }
});

describe('w53c lobby: LOBBY works where it is drawn', () => {
  // the centre and the four corners (3 CSS px in) of the drawn panel each leave for the lobby: the hit box covers the whole
  // drawing, not just its middle. Between taps, Enter in the lobby starts Starfall again and a new run is paused.
  const spots = [['centre', 0.5, 0.5], ['top left', 0, 0], ['top right', 1, 0], ['bottom left', 0, 1], ['bottom right', 1, 1]];
  const cases = [[1180, 820, true], [1180, 820, false], [1024, 768, true], [1024, 768, false], [1000, 750, true], [844, 390, true], [844, 390, false], [667, 375, true]];
  for (const [w, h, crt] of cases) {
    test(`${w}x${h} CRT ${crt ? 'on' : 'off'}: a tap at the centre or any corner of the drawn LOBBY panel leaves for the lobby; it is clear of the PAUSE box`, { timeout: 300000 }, async () => {
      const { ctx, page, problems } = await fromLobby(w, h);
      try {
        for (let k = 0; k < spots.length; k++) {
          const [name, fx, fy] = spots[k];
          if (k > 0) { // back from the lobby into Starfall
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => LOBBY.info().mode === 'gone' && SF.away() === false, null, WAIT);
          }
          await intoRun(page, crt);
          await markTouch(page, w, h);
          const b = await btn(page);
          assert.ok(b, 'the PAUSE button shows');
          await page.touchscreen.tap(b.x + b.w / 2, b.y + b.h / 2);
          await isPaused(true)(page);
          await page.waitForTimeout(300);
          const p = await lobbyPanel(page);
          assert.ok(p, 'the LOBBY panel is drawn');
          assert.ok(p.x1 - p.x0 >= 44, `the drawn LOBBY panel is at least 44 CSS px wide (${fmt(p)})`);
          const clear = p.x1 <= b.x || p.x0 >= b.x + b.w || p.y1 <= b.y || p.y0 >= b.y + b.h;
          assert.ok(clear, `the drawn LOBBY panel (${fmt(p)}) and the PAUSE box (x ${b.x.toFixed(1)}..${(b.x + b.w).toFixed(1)} y ${b.y.toFixed(1)}..${(b.y + b.h).toFixed(1)}) do not overlap`);
          await page.waitForTimeout(400);
          const tx = fx === 0.5 ? (p.x0 + p.x1) / 2 : fx === 0 ? p.x0 + 3 : p.x1 - 3;
          const ty = fy === 0.5 ? (p.y0 + p.y1) / 2 : fy === 0 ? p.y0 + 3 : p.y1 - 3;
          await page.touchscreen.tap(tx, ty);
          await page.waitForTimeout(300);
          assert.equal(await page.evaluate(() => SF.away()), true, `a tap at the drawn panel's ${name} (${tx.toFixed(1)}, ${ty.toFixed(1)}; panel ${fmt(p)}) left for the lobby`);
          await page.waitForFunction(() => LOBBY.info().mode === 'lobby', null, WAIT);
          assert.equal((await page.evaluate(() => SF.scores('all', undefined, false))).length, 0, 'nothing was submitted');
        }
        assert.deepEqual(problems, []);
      } finally { await ctx.close(); }
    });
  }
});
