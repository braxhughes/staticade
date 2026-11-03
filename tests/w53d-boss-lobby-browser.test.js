// on the touch pause screen in a boss fight, the boss HUD (name and HP bar, top right) stays clear of the LOBBY panel,
// CRT on and off (with the CRT on, the warped HP bar ran through the flat LOBBY panel's top edge).
// Through index.html (the lobby route, so the pause screen has its touch LOBBY button) in headless Chrome with touch. Both
// are found from drawn pixels: the LOBBY panel is the largest amber cluster (as in the lobby-trap test), the boss HUD is the
// violet name plus the rose HP bar (red and blue both well above green; amber has blue below green, so the two never mix,
// and the CRT's colour fringe splits red from blue, so a fringe pixel is never counted). The gap between any boss HUD pixel
// and the panel's box must be at least 4 field units. Every listed size, ECLIPSE, MOONWELL and PYRE, CRT on; CRT off at two.
// Also: at 480x360 the corner PAUSE box reaches into LOBBY's hit box. A tap where they meet resumes and
// never leaves, CRT on and off, paused by the button, by P and by Esc (an earlier test covered only CRT on, paused by the button).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { staticServer, WAIT } from './w25-helpers.mjs';
import { LOBBY_BOX } from '../games/starfall/render/core.js';

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

// Scan the top 40% of the PLAYFIELD's right half (the 4:3 field centred in the canvas), minimum over K frames so blinks and
// twinkles drop out. Returns, in CSS px: the LOBBY panel box (largest amber cluster, grid cells 3 field units) and the boss
// HUD pixels' distance to that box, plus the HUD's own bounding box and pixel count. The field scale (CSS px per unit) too.
function measure(page, K = 4) {
  return page.evaluate(K => new Promise(res => {
    const c = document.getElementById('c'), r = c.getBoundingClientRect(), dpr = c.width / r.width;
    const fw = Math.min(c.width, c.height * 4 / 3), fh = fw * 3 / 4, fx = (c.width - fw) / 2, fy = (c.height - fh) / 2;
    const x0 = Math.floor(fx + fw * 0.5), y0 = Math.max(0, Math.floor(fy)), W = Math.floor(fx + fw) - x0, H = Math.floor(fh * 0.4);
    const mn = new Uint8ClampedArray(W * H * 4).fill(255);
    const t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
    const g = t.getContext('2d', { willReadFrequently: true });
    // amber from 40 up: at 800x600 the panel's frame dots peak near red 64. The CRT's fringe can leave a violet edge pixel with
    // its blue gone, which reads as amber; so an amber pixel within FR device px of a boss HUD pixel is not counted.
    const amberC = (R, G, B) => R >= 40 && G >= 0.45 * R && G <= 0.85 * R && B <= 0.45 * R;
    const hud = (R, G, B) => Math.max(R, B) >= 70 && R - G >= 25 && B - G >= 20; // violet name, rose bar
    const FR = Math.max(3, Math.ceil(0.002 * fw) + 2);
    const hm = new Uint8Array(W * H);
    let amber;
    let k = 0;
    const grab = () => {
      g.drawImage(c, 0, 0);
      const d = g.getImageData(x0, y0, W, H).data;
      for (let i = 0; i < d.length; i++) if (d[i] < mn[i]) mn[i] = d[i];
      if (++k < K) setTimeout(() => requestAnimationFrame(grab), 90); else done();
    };
    function done() {
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if (hud(mn[i], mn[i + 1], mn[i + 2])) hm[y * W + x] = 1; }
      const nearHud = (x, y) => {
        for (let yy = Math.max(0, y - FR); yy <= Math.min(H - 1, y + FR); yy++) for (let xx = Math.max(0, x - FR); xx <= Math.min(W - 1, x + FR); xx++) if (hm[yy * W + xx]) return true;
        return false;
      };
      const am = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if (amberC(mn[i], mn[i + 1], mn[i + 2]) && !nearHud(x, y)) am[y * W + x] = 1; }
      amber = (x, y) => am[y * W + x] === 1;
      const S = Math.max(6, Math.ceil(fw / 400 * 3)), GW = Math.ceil(W / S), GH = Math.ceil(H / S), cnt = new Int32Array(GW * GH);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (amber(x, y)) cnt[((y / S) | 0) * GW + ((x / S) | 0)]++;
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
      const scale = fw / 400 / dpr; // CSS px per field unit
      if (!best) { res({ panel: null, scale }); return; }
      let a = 1e9, b = 1e9, cc = -1, dd = -1;
      for (let y = best.b * S; y < Math.min(H, (best.dd + 1) * S); y++) for (let x = best.a * S; x < Math.min(W, (best.cc + 1) * S); x++) {
        if (lab[((y / S) | 0) * GW + ((x / S) | 0)] !== best.id) continue;
        if (amber(x, y)) { if (x < a) a = x; if (x > cc) cc = x; if (y < b) b = y; if (y > dd) dd = y; }
      }
      // boss HUD pixels: distance (device px) from each to the panel box; keep the nearest
      let hn = 0, hx0 = 1e9, hy0 = 1e9, hx1 = -1, hy1 = -1, near = 1e9, nx = 0, ny = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        if (!hud(mn[i], mn[i + 1], mn[i + 2])) continue;
        hn++; if (x < hx0) hx0 = x; if (x > hx1) hx1 = x; if (y < hy0) hy0 = y; if (y > hy1) hy1 = y;
        const dx = x < a ? a - x : x > cc ? x - cc : 0, dy = y < b ? b - y : y > dd ? y - dd : 0, dist = Math.hypot(dx, dy);
        if (dist < near) { near = dist; nx = x; ny = y; }
      }
      const css = (px, py) => [(x0 + px) / dpr + r.left, (y0 + py) / dpr + r.top];
      const [px0, py0] = css(a, b), [px1, py1] = css(cc + 1, dd + 1);
      res({
        scale, panel: { x0: px0, y0: py0, x1: px1, y1: py1 },
        hud: hn ? { n: hn, box: [...css(hx0, hy0), ...css(hx1 + 1, hy1 + 1)], near: near / dpr, at: css(nx, ny) } : null
      });
    }
    requestAnimationFrame(grab);
  }), K);
}
const f1 = v => v.toFixed(1);
const fmtB = b => `x ${f1(b.x0)}..${f1(b.x1)} y ${f1(b.y0)}..${f1(b.y1)}`;

// a boss stage paused by the PAUSE button: from a resumed state, start the stage, step to the boss, tap PAUSE
async function pausedAtBoss(page, stage, name, w, h) {
  if (await page.evaluate(() => SF.paused())) {
    await page.keyboard.press('KeyP');
    await page.waitForFunction(() => SF.paused() === false, null, WAIT);
  }
  await page.evaluate(s => { SF.god(true); SF.start(s, 77); }, stage);
  await page.waitForFunction(() => SF.app() === 'game', null, WAIT);
  await page.evaluate(() => { let n = 0; while (!SF.info().boss && n++ < 5000) SF.autoFire(1); });
  assert.equal(await page.evaluate(() => SF.info().boss), true, `stage ${stage}: the boss is on`);
  const b = await page.evaluate(() => SF.pauseButton());
  assert.ok(b, 'the PAUSE button shows');
  await page.touchscreen.tap(b.x + b.w / 2, b.y + b.h / 2);
  await page.waitForFunction(() => SF.paused() === true, null, WAIT);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => SF.lobbyButton()), true, 'the pause screen shows LOBBY');
}

const GAP = 4; // field units
const SIZES = [[1180, 820], [1024, 768], [1000, 750], [800, 600], [640, 480], [844, 390]];
const BOSSES = [[5, 'ECLIPSE'], [10, 'MOONWELL'], [15, 'PYRE']];
const cases = [];
for (const [w, h] of SIZES) cases.push([w, h, true]);
cases.push([1180, 820, false], [640, 480, false]);

describe('w53d: the boss HUD stays clear of the LOBBY panel on the touch pause screen', () => {
  for (const [w, h, crt] of cases) {
    test(`${w}x${h} CRT ${crt ? 'on' : 'off'}: ECLIPSE, MOONWELL, PYRE: boss name and HP bar at least ${GAP} field units from the drawn LOBBY panel`, { timeout: 300000 }, async () => {
      const { ctx, page, problems } = await fromLobby(w, h);
      try {
        await page.evaluate(c => SF.crt(c), crt);
        await page.evaluate(() => SF.skip());
        await page.waitForFunction(() => SF.app() === 'title', null, WAIT);
        await page.waitForTimeout(450);
        assert.equal(await page.evaluate(() => SF.info().crt), crt);
        await page.evaluate(() => { SF.god(true); SF.start(1, 77); });
        await page.waitForFunction(() => SF.app() === 'game', null, WAIT);
        await page.touchscreen.tap(w / 2, h * 0.7); await page.waitForTimeout(600); // a touch player: PAUSE and LOBBY show
        for (const [stage, name] of BOSSES) {
          await pausedAtBoss(page, stage, name, w, h);
          const m = await measure(page);
          assert.ok(m.panel, `${name}: the LOBBY panel is drawn`);
          const pw = (m.panel.x1 - m.panel.x0) / m.scale, ph = (m.panel.y1 - m.panel.y0) / m.scale;
          assert.ok(pw >= 30 && ph >= 16, `${name}: the panel found is panel sized (${f1(pw)} x ${f1(ph)} field units; ${fmtB(m.panel)})`);
          assert.ok(m.hud && m.hud.n >= 20, `${name}: the boss HUD is drawn (${m.hud ? m.hud.n : 0} px)`);
          const gap = m.hud.near / m.scale;
          if (process.env.W53D_VERBOSE) console.log(`${w}x${h} crt ${crt} ${name}: gap ${f1(gap)} units, panel ${fmtB(m.panel)}, HUD y ${f1(m.hud.box[1])}..${f1(m.hud.box[3])}`);
          assert.ok(gap >= GAP, `${w}x${h} CRT ${crt ? 'on' : 'off'} ${name}: the boss HUD comes within ${f1(gap)} field units of the LOBBY panel ` +
            `(nearest HUD pixel at ${f1(m.hud.at[0])}, ${f1(m.hud.at[1])}; panel ${fmtB(m.panel)}; HUD x ${f1(m.hud.box[0])}..${f1(m.hud.box[2])} y ${f1(m.hud.box[1])}..${f1(m.hud.box[3])}), want at least ${GAP}`);
        }
        assert.deepEqual(problems, []);
      } finally { await ctx.close(); }
    });
  }
});

describe('w53d: the PAUSE spot is never LOBBY, CRT on and off, however the game was paused', () => {
  const PAD = 4; // LOBBY's hit box is its box plus 4 field units (render/core.js lobbyHit)
  const cases = [[false, 'button'], [true, 'KeyP'], [false, 'KeyP'], [true, 'Escape'], [false, 'Escape']];
  for (const [crt, how] of cases) {
    test(`480x360 CRT ${crt ? 'on' : 'off'}, paused by ${how === 'button' ? 'the PAUSE button' : how}: a tap where the PAUSE box and LOBBY's hit box meet resumes, never leaves`, { timeout: 200000 }, async () => {
      const [w, h] = [480, 360];
      const { ctx, page, problems } = await fromLobby(w, h);
      try {
        await page.evaluate(c => SF.crt(c), crt);
        await page.evaluate(() => SF.skip());
        await page.waitForFunction(() => SF.app() === 'title', null, WAIT);
        await page.waitForTimeout(450);
        await page.evaluate(() => SF.mode('free'));
        await page.evaluate(() => { let n = 0; while (SF.state === 'intro' && n++ < 1000) SF.autoFire(1); });
        assert.equal(await page.evaluate(() => SF.info().crt), crt);
        await page.touchscreen.tap(w / 2, h * 0.7); await page.waitForTimeout(600);
        const b = await page.evaluate(() => SF.pauseButton());
        assert.ok(b && b.where === 'corner', 'the button is in the corner');
        const v = await page.evaluate(() => { const r = document.getElementById('c').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; });
        const fw = Math.min(v.w, v.h * 4 / 3), s = fw / 400, fl = v.l + (v.w - fw) / 2, ft = v.t + (v.h - fw * 0.75) / 2;
        const lx1 = fl + (LOBBY_BOX.x1 + PAD) * s, ly0 = ft + (LOBBY_BOX.y0 - PAD) * s, ly1 = ft + (LOBBY_BOX.y1 + PAD) * s;
        const oy0 = Math.max(b.y, ly0), oy1 = Math.min(b.y + b.h, ly1);
        assert.ok(b.x < lx1 - 2 && oy1 - oy0 > 4, `precondition: the PAUSE box (x ${f1(b.x)}.., y ${f1(b.y)}..${f1(b.y + b.h)}) reaches into LOBBY's hit box (x ..${f1(lx1)}, y ${f1(ly0)}..${f1(ly1)})`);
        const px = (b.x + lx1) / 2, py = (oy0 + oy1) / 2;
        if (how === 'button') await page.touchscreen.tap(b.x + b.w / 2, b.y + b.h / 2);
        else await page.keyboard.press(how);
        await page.waitForFunction(() => SF.paused() === true, null, WAIT);
        assert.equal(await page.evaluate(() => SF.lobbyButton()), true, 'the pause screen shows LOBBY');
        await page.waitForTimeout(900);
        await page.touchscreen.tap(px, py);
        await page.waitForTimeout(300);
        assert.equal(await page.evaluate(() => SF.away()), false, `a tap at (${f1(px)}, ${f1(py)}), on both boxes, did not leave for the lobby`);
        assert.equal(await page.evaluate(() => SF.paused()), false, 'it resumed');
        assert.deepEqual(problems, []);
      } finally { await ctx.close(); }
    });
  }
});
