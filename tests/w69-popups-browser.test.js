// What STACKLIGHT popups draw, pinned call by call. The real stacklight.html, served by
// tools/serve.mjs, in headless Chrome. Every text() call is logged (engine/font.js tapped through a route, nothing
// else changed). The page's rAF is held and fed exact timestamps, so the loop's interpolation alpha on every rendered
// frame is known exactly: this file re-runs the same arithmetic as engine/loop.js on the same doubles.
// Each frame, every popup call (string, x, y, size, align, alpha, colour, in order) must equal a reference model of the
// popups as render.js drew them before the popup rewrite (render.js at 8fd97cb, popups()), from the popups on screen
// (SL.fx()) and the frame on screen (sim.frame - 1 + alpha):
//   t = now - born, drawn when 0 <= t <= life (54, LEVEL 100); a = 1 while t < 0.6 life, then 1 - (t - 0.6 life) / (0.4 life)
//   rise = min(t, 24) * 0.35. FIT: y - 10 - rise, size 1.4, white, a. POINTS: y - rise, size 1, C_TOP, a * 0.9.
//   LEVEL: y - rise * 0.3, size 2, C_PLUS, a. A clear's points (x > 258.5): the lane at x 330, y 216 + 11 k + 3 - min(t, 24) / 8
//   (k = newer lane points on screen, at most 4 shown), C_TOP, a * 0.9.
// The scripted run covers every branch (rising and risen, solid and fading, for FIT, in-well points, lane points and LEVEL)
// and the test checks that it did. Alphas include ones within 1e-12 of 1, the largest the loop makes; that alpha is
// never exactly 1 is tests/w69-alpha-range.test.js. Console clean except the favicon 404.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOT_DIR = process.env.W69B_SHOT_DIR || null;
const FONT_SRC = fs.readFileSync(path.join(ROOT, 'engine/font.js'), 'utf8');
const TAP = 'return function text(str, x, y, col, sc, align, a, wave) {';
if (!FONT_SRC.includes(TAP)) throw new Error('engine/font.js no longer has the text() entry the tap wraps');
const FONT_TAPPED = FONT_SRC.replace(TAP, TAP + ' if (window.__tlog) window.__tlog.push([str, x, y, sc, align, a, col && col.join(",")]);');

// hold every rAF callback; __feed(t) runs them with timestamp t and waits for the loop to ask for the next frame
const STEPPER = `(() => {
  const real = window.requestAnimationFrame.bind(window);
  let frozen = false, held = [];
  window.requestAnimationFrame = cb => real(t => { if (frozen) held.push(cb); else cb(t); });
  const until = f => new Promise(r => { const c = () => (f() ? r() : setTimeout(c, 2)); c(); });
  window.__freeze = async () => { frozen = true; await until(() => held.length > 0); };
  window.__feed = async t => { const cbs = held; held = []; for (const cb of cbs) cb(t); await until(() => held.length > 0); };
})();`;

// engine/loop.js advance(), on the same doubles (STEP 1000 / 60, maxFrameMs 250)
const STEP = 1000 / 60;
function mirrorLoop(last) {
  let acc = 0;
  return {
    feed(t) { let dt = t - last; last = t; if (dt > 250) dt = 250; if (dt < 0) dt = 0; acc += dt; let n = 0; while (acc >= STEP) { acc -= STEP; n++; } return { steps: n, alpha: acc / STEP }; },
    // the timestamp that leaves acc at frac of a step after k more steps
    next(k, frac) { return last + ((k + frac) * STEP - acc); }
  };
}

const C_TOP = '0.6,1,0.65', C_WHITE = '1,1,1', C_PLUS = '0.9,1,0.3';
const LIFE = { fit: 54, points: 54, level: 100 };
// the popups as drawn before D123, from SL.fx().popups (slot order) and the frame on screen
function model(pops, now, cover) {
  const on = pops.map(p => { const t = now - p.born; return t >= 0 && t <= LIFE[p.kind]; });
  const out = [];
  for (let i = 0; i < pops.length; i++) {
    if (!on[i]) continue;
    const p = pops[i], life = LIFE[p.kind], t = now - p.born;
    const a = t < life * 0.6 ? 1 : 1 - (t - life * 0.6) / (life * 0.4), rise = Math.min(t, 24) * 0.35;
    const tag = (t >= 24 ? 'risen' : 'rising') + (t < life * 0.6 ? ' solid' : ' fading');
    if (p.kind === 'points' && p.x > 258.5) {
      let k = 0;
      for (let j = 0; j < pops.length; j++) {
        const q = pops[j];
        if (j === i || q.kind !== 'points' || !(q.x > 258.5) || !on[j]) continue;
        if (q.born > p.born || (q.born === p.born && j > i)) k++;
      }
      if (k < 4) { out.push([p.text, 330, 216 + k * 11 + 3 - Math.min(t, 24) / 8, 1, 'c', a * 0.9, C_TOP]); cover.add('lane ' + tag); }
    } else if (p.kind === 'fit') { out.push([p.text, p.x, p.y - 10 - rise, 1.4, 'c', a, C_WHITE]); cover.add('fit ' + tag); }
    else if (p.kind === 'points') { out.push([p.text, p.x, p.y - rise, 1, 'c', a * 0.9, C_TOP]); cover.add('points ' + tag); }
    else if (p.kind === 'level') { out.push([p.text, p.x, p.y - rise * 0.3, 2, 'c', a, C_PLUS]); cover.add('level ' + tag); }
  }
  return out;
}
const isPop = s => /^\+\d+$|^FLAT$|^KEY$|^LEVEL \d+$/.test(s);

let browser, serve, url;
async function freePort() {
  return new Promise(res => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
before(async () => {
  const port = await freePort();
  serve = spawn(process.execPath, ['tools/serve.mjs', String(port)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('tools/serve.mjs did not start')), 15000);
    serve.stdout.on('data', b => { if (String(b).includes('serving')) { clearTimeout(to); res(); } });
    serve.on('exit', code => rej(new Error('tools/serve.mjs exited ' + code)));
  });
  url = `http://localhost:${port}/stacklight.html`;
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (serve) serve.kill(); });

test('popups draw exactly what they drew before D123: string, x, y, size, colour, alpha, frame by frame', { timeout: 180000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  await ctx.route('**/engine/font.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: FONT_TAPPED }));
  await ctx.addInitScript(STEPPER);
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) problems.push('HTTP ' + r.status() + ' ' + r.url()); });
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.SL && SL.info().app === 'title' && SL.hud().F > 5, null, { timeout: 30000 });
    await page.evaluate(() => window.__freeze());
    // take the loop's clock: a visible-again event resets it (acc 0), then a first timestamp far past performance.now()
    // clamps to 250 ms, so acc is known exactly from here on. T0 = 2^16 ms keeps timestamps small enough that an alpha
    // within about 2e-12 of 1 can be fed.
    const T0 = 65536;
    assert.ok(await page.evaluate(() => performance.now()) < T0 - 1000, 'the page clock is behind T0');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    const L = mirrorLoop(-Infinity);
    L.feed(T0); await page.evaluate(t => window.__feed(t), T0);
    const cover = new Set();
    let frames = 0, calls = 0, maxAlpha = 0, shotDone = false;
    const FRACS = [0.37, 1 - 1e-12, 0.5, 1e-9, 0.83, 1 - 1e-13, 0.21, 0.999];
    // render one frame k steps on, check every popup call against the model
    const step = async (k = 1) => {
      const frac = FRACS[frames % FRACS.length];
      const t = L.next(k, frac), m = L.feed(t);
      const r = await page.evaluate(async t => {
        window.__tlog = []; await window.__feed(t); const log = window.__tlog; window.__tlog = null;
        return { log, frame: SL.info().frame, app: SL.info().app, paused: SL.info().paused, pops: SL.fx().popups };
      }, t);
      assert.equal(r.app, 'play'); assert.equal(r.paused, false);
      const now = r.frame - 1 + m.alpha;
      const want = model(r.pops, now, cover), got = r.log.filter(c => isPop(c[0]));
      const where = `frame ${r.frame} alpha ${m.alpha}`;
      assert.equal(got.length, want.length, `${where}: popup calls ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
      for (let c = 0; c < want.length; c++) {
        const g = got[c], w = want[c];
        assert.equal(g[0], w[0], `${where} call ${c}: string`);
        assert.equal(g[3], w[3], `${where} "${w[0]}": size`);
        assert.equal(g[4], w[4], `${where} "${w[0]}": align`);
        assert.equal(g[6], w[6], `${where} "${w[0]}": colour`);
        assert.ok(Math.abs(g[1] - w[1]) < 1e-9, `${where} "${w[0]}": x ${g[1]}, want ${w[1]}`);
        assert.ok(Math.abs(g[2] - w[2]) < 1e-9, `${where} "${w[0]}": y ${g[2]}, want ${w[2]}`);
        assert.ok(Math.abs(g[5] - w[5]) < 1e-9, `${where} "${w[0]}": alpha ${g[5]}, want ${w[5]}`);
      }
      frames++; calls += want.length; if (m.alpha > maxAlpha) maxAlpha = m.alpha;
      // the shot: a frame with a FIT word (FLAT or KEY, size 1.4) and its points over the lock, 10 frames after the lock
      if (SHOT_DIR && !shotDone && want.length >= 2 && want.some(w => w[3] === 1.4) && now - r.pops[0].born >= 10) {
        shotDone = true; await page.screenshot({ path: path.join(SHOT_DIR, 'w69b-popups-frame.png') });
      }
    };
    // 1. three bottom-row clears: points in the lane (stacked, newest on top), drawn through their whole life
    await page.evaluate(() => { SL.start(1); SL.setLines(8); SL.setHeights([8, 8, 8, 8, 0, 8, 8, 8, 8]); SL.place(3, 0); SL.place(3, 0); SL.place(3, 0); });
    for (let j = 0; j < 70; j++) await step();
    // 2. FIT and in-well points over each lock, placed 12 frames apart so their ages overlap
    await page.evaluate(() => SL.start(3));
    for (const c of [0, 3, 6, 1, 4, 7, 2, 5, 8]) { await page.evaluate(c => SL.place(c, 0), c); for (let j = 0; j < 12; j++) await step(); }
    for (let j = 0; j < 60; j++) await step();
    // 3. a level up: the lowest lines count one clear short of the next level
    const n = await page.evaluate(() => { SL.start(1); for (let n = 0; n < 40; n++) { SL.setLines(n); const l = SL.info().level; SL.setLines(n + 1); if (SL.info().level > l) return n; } return -1; });
    assert.ok(n >= 0, 'a lines count one short of a level');
    // (one place at a time, with frames drawn between: SL.place first waits out the clear delay, which would age the popup)
    await page.evaluate(n => { SL.setLines(n); SL.setHeights([8, 8, 8, 8, 0, 8, 8, 8, 8]); SL.place(3, 0); }, n);
    for (let j = 0; j < 30; j++) await step();
    await page.evaluate(() => SL.place(3, 0));
    for (let j = 0; j < 104; j++) await step(j % 9 === 4 ? 2 : 1); // a 2-step frame now and then
    const want = ['fit', 'points', 'lane', 'level'].flatMap(k => [k + ' rising solid', k + ' risen solid', k + ' risen fading']);
    for (const b of want) assert.ok(cover.has(b), `the run drew a ${b} popup (drew: ${[...cover].join(', ')})`);
    assert.ok(calls >= 300, `popup calls checked: ${calls}`);
    assert.ok(maxAlpha > 1 - 1e-11 && maxAlpha < 1, `an alpha within 1e-11 of 1 was drawn (${maxAlpha})`);
    if (process.env.W69B_PRINT) console.log('frames', frames, 'popup calls', calls, 'max alpha', maxAlpha, 'branches', [...cover].sort().join(', '));
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});
