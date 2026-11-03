// STACKLIGHT T5 lobby: the real index.html in headless Chrome, driven by real keys and
// touch taps. STACKLIGHT is a playable cabinet; Enter or a tap on it plays the select sound and goes to stacklight.html?from=lobby.
//   1. walk left from Starfall to STACKLIGHT with the real arrow key: PLAY hint (playable), no COMING SOON poster, no refusal flash
//   2. the route is testable without leaving: under LOBBY.manualHandoff the select waits ~18 ticks, LOBBY.info().leaveTo names the page,
//      the lobby does not move meanwhile, and only LOBBY.proceed() loads it
//   3. Enter lands on the STACKLIGHT title with SL.fromLobby() true; Esc on that title goes back to index.html (no console errors)
//   4. a tap on the STACKLIGHT cabinet does the same; a tap on LEDGE LORDS still only flashes COMING SOON and stays in the lobby
//   5. Starfall still opens by Enter and by tap (the swing and dolly path, SF running), not the STACKLIGHT page
//   6. the upright-phone rotate screen still shows over the lobby (390x844 touch) and goes when turned sideways (844x390)
//   7. the poster is gone from STACKLIGHT and still on LEDGE LORDS (and only there); STACKLIGHT's tube no longer says COMING SOON
//      (its attract animation shares the COMING SOON machines' code path) and LEDGE LORDS' tube still does
//   8. zero arrays or typed arrays built per frame in the lobby at idle on STACKLIGHT, through the leave wait
// Every page: console clean except the favicon 404. Screenshots go to W51_SHOT_DIR when it is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticServer, WAIT } from './w25-helpers.mjs';

const SHOT_DIR = process.env.W51_SHOT_DIR || null;
let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

const wait = ms => new Promise(r => setTimeout(r, ms));
const shot = async (page, name) => { if (!SHOT_DIR) return; fs.mkdirSync(SHOT_DIR, { recursive: true }); await wait(400); await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') }); };
const frames = (page, k) => page.evaluate(k => new Promise(r => { let f = 0; const t = () => { if (++f >= k) r(); else requestAnimationFrame(t); }; requestAnimationFrame(t); }), k);

// index.html with the wordmark skipped (it ignores Enter until it is done), listening for errors on every page the context opens
async function openLobby({ w = 1000, h = 750, touch = false, manual = false, ctx = null } = {}) {
  const c = ctx || await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch });
  const page = await c.newPage();
  const problems = [];
  watch(page, problems);
  await page.goto(web.url + 'index.html');
  await page.waitForFunction(() => window.LOBBY && LOBBY.info().mode === 'lobby', null, WAIT);
  await page.evaluate(m => { LOBBY.wordmarkSkip(); if (m) LOBBY.manualHandoff(true); }, manual);
  return { ctx: c, page, problems };
}
function watch(page, problems) {
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) problems.push('HTTP ' + r.status() + ' ' + r.url()); });
}
const settled = page => page.waitForFunction(() => !LOBBY.info().moving, null, WAIT);
// the real arrow key, until the wanted cabinet is selected and standing still
async function walkTo(page, id) {
  for (let n = 0; n < 6; n++) {
    const i = await page.evaluate(() => LOBBY.info());
    if (i.id === id && !i.moving) return;
    const want = i.ids.indexOf(id);
    await page.keyboard.press(want < i.index ? 'ArrowLeft' : 'ArrowRight');
    await page.waitForFunction(() => LOBBY.info().moving, null, WAIT).catch(() => {});
    await settled(page);
  }
  assert.equal((await page.evaluate(() => LOBBY.info())).id, id);
}
// field units (400 x 300) -> CSS px on the canvas (letterboxed, centred)
const client = (page, fx, fy) => page.evaluate(([fx, fy]) => {
  const r = document.getElementById('c').getBoundingClientRect(), s = Math.min(r.width / 400, r.height / 300);
  return { x: r.left + (r.width - 400 * s) / 2 + fx * s, y: r.top + (r.height - 300 * s) / 2 + fy * s };
}, [fx, fy]);
// tap the middle of a cabinet's screen box as the last frame drew it
async function tapCabinet(page, id) {
  const r = await page.evaluate(() => LOBBY.rowBoxes());
  const b = r.boxes.find(x => x.id === id);
  const p = await client(page, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
  await page.touchscreen.tap(p.x, p.y);
}
const onTitle = page => page.waitForFunction(() => window.SL && SL.info().app === 'title' && SL.hud().F > 5, null, WAIT);

test('1. walking left from Starfall with the arrow key selects a playable STACKLIGHT: PLAY hint, no flash, no poster', { timeout: 90000 }, async () => {
  const { ctx, page, problems } = await openLobby({ manual: true });
  try {
    assert.deepEqual(await page.evaluate(() => LOBBY.info().ids), ['stacklight', 'starfall', 'ledgelords']);
    assert.equal((await page.evaluate(() => LOBBY.info())).id, 'starfall', 'the lobby opens on Starfall');
    await walkTo(page, 'stacklight');
    await frames(page, 90);
    const i = await page.evaluate(() => LOBBY.info());
    assert.equal(i.id, 'stacklight'); assert.equal(i.mode, 'lobby'); assert.equal(i.flash, 0); assert.equal(i.leaveTo, '');
    assert.deepEqual(await page.evaluate(() => LOBBY.posterShown()), [], 'no COMING SOON poster on STACKLIGHT');
    await shot(page, 'lobby-stacklight');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('2. the route is a hook, not a page load: the select waits, names the page, holds the lobby still, and only proceed() goes', { timeout: 90000 }, async () => {
  const { ctx, page, problems } = await openLobby({ manual: true });
  try {
    await walkTo(page, 'stacklight');
    const before = await page.evaluate(() => ({ url: location.href, i: LOBBY.info() }));
    assert.equal(before.i.leaveTo, ''); assert.equal(before.i.leaveReady, false);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => LOBBY.info().leaveTo !== '', null, WAIT);
    const during = await page.evaluate(() => LOBBY.info());
    assert.match(during.leaveTo, /\/stacklight\.html\?from=lobby$/);
    assert.equal(during.mode, 'lobby', 'no swing and no dolly for STACKLIGHT');
    assert.equal(during.id, 'stacklight');
    // keys during the wait do nothing (the lobby holds still), then the wait ends ready
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => LOBBY.info().leaveReady === true, null, WAIT);
    const ready = await page.evaluate(() => ({ url: location.href, i: LOBBY.info() }));
    assert.equal(ready.i.id, 'stacklight', 'an arrow pressed during the wait did not move the lobby');
    assert.equal(ready.i.mode, 'lobby'); assert.equal(ready.i.leaveWait, 0);
    assert.equal(ready.url, before.url, 'manualHandoff: the page has not been left');
    await frames(page, 30);
    assert.equal(await page.evaluate(() => location.href), before.url);
    // proceed() goes
    await Promise.all([page.waitForURL(/\/stacklight\.html\?from=lobby$/, WAIT), page.evaluate(() => LOBBY.proceed())]);
    await onTitle(page);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('3. Enter on STACKLIGHT lands on its title (SL.fromLobby true); Esc there goes back to index.html', { timeout: 120000 }, async () => {
  const { ctx, page, problems } = await openLobby();
  try {
    await walkTo(page, 'stacklight');
    await frames(page, 60);
    await Promise.all([page.waitForURL(/\/stacklight\.html\?from=lobby$/, WAIT), page.keyboard.press('Enter')]);
    await onTitle(page);
    assert.equal(await page.evaluate(() => SL.fromLobby()), true);
    assert.equal(await page.evaluate(() => SL.info().app), 'title');
    assert.equal(await page.evaluate(() => typeof window.LOBBY), 'undefined', 'this is the STACKLIGHT page, not the lobby');
    await shot(page, 'lobby-to-title');
    // Esc goes back to the lobby page, which opens with its loop running
    await Promise.all([page.waitForURL(/\/index\.html$/, WAIT), page.keyboard.press('Escape')]);
    await page.waitForFunction(() => window.LOBBY && LOBBY.info().mode === 'lobby', null, WAIT);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('4. a tap on the STACKLIGHT cabinet goes to its title; a tap on LEDGE LORDS only flashes COMING SOON', { timeout: 120000 }, async () => {
  const { ctx, page, problems } = await openLobby({ touch: true });
  try {
    // LEDGE LORDS first: a tap on it stays in the lobby
    await page.evaluate(() => LOBBY.go(2)); await settled(page); await frames(page, 60);
    await tapCabinet(page, 'ledgelords');
    await page.waitForFunction(() => LOBBY.info().flash > 0, null, WAIT);
    let i = await page.evaluate(() => LOBBY.info());
    assert.equal(i.id, 'ledgelords'); assert.equal(i.mode, 'lobby'); assert.equal(i.leaveTo, '');
    await frames(page, 60);
    assert.match(page.url(), /index\.html$/);
    // STACKLIGHT: the same tap goes
    await page.evaluate(() => LOBBY.go(0)); await settled(page); await frames(page, 60);
    await Promise.all([page.waitForURL(/\/stacklight\.html\?from=lobby$/, WAIT), tapCabinet(page, 'stacklight')]);
    await onTitle(page);
    assert.equal(await page.evaluate(() => SL.fromLobby()), true);
    // the name block under the cabinet is a tap target too (field x 200, y 245 is inside the NAME_Y..HINT_Y band)
    await Promise.all([page.waitForURL(/\/index\.html$/, WAIT), page.keyboard.press('Escape')]);
    await page.waitForFunction(() => window.LOBBY && LOBBY.info().mode === 'lobby', null, WAIT);
    await page.evaluate(() => { LOBBY.wordmarkSkip(); LOBBY.go(0); }); await settled(page); await frames(page, 60);
    const nb = await client(page, 200, 245);
    await Promise.all([page.waitForURL(/\/stacklight\.html\?from=lobby$/, WAIT), page.touchscreen.tap(nb.x, nb.y)]);
    await onTitle(page);
    assert.equal(await page.evaluate(() => SL.fromLobby()), true);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('5. Starfall still opens by Enter and by tap: the swing and dolly path, SF running, no STACKLIGHT page', { timeout: 120000 }, async () => {
  for (const how of ['enter', 'tap']) {
    const { ctx, page, problems } = await openLobby({ touch: how === 'tap' });
    try {
      assert.equal((await page.evaluate(() => LOBBY.info())).id, 'starfall');
      await frames(page, 30);
      if (how === 'enter') await page.keyboard.press('Enter'); else await tapCabinet(page, 'starfall');
      await page.waitForFunction(() => LOBBY.info().mode === 'swing' || LOBBY.info().mode === 'dolly', null, WAIT);
      assert.equal((await page.evaluate(() => LOBBY.info())).leaveTo, '', how + ': Starfall has no page route');
      await page.waitForFunction(() => LOBBY.info().mode === 'gone' && window.SF && SF.away() === false, null, WAIT);
      assert.match(page.url(), /index\.html$/, how + ': still on the lobby page (Starfall loads in it)');
      assert.deepEqual(problems, [], how);
    } finally { await ctx.close(); }
  }
});

test('6. the upright-phone rotate screen still shows over the lobby, and goes when the phone is turned sideways', { timeout: 120000 }, async () => {
  const { ctx, page, problems } = await openLobby({ w: 390, h: 844, touch: true, manual: true });
  try {
    assert.equal(await page.evaluate(() => LOBBY.rotateShown()), true, 'upright touch: the rotate screen is up');
    await wait(400);
    // drawn, not only flagged: the room is not drawn behind it (top of the canvas black) and the screen has dots in the middle
    const px = await page.evaluate(() => new Promise(res => requestAnimationFrame(() => {
      const c = document.getElementById('c'), t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
      const x = t.getContext('2d'); x.drawImage(c, 0, 0);
      const lit = (x0, y0, x1, y1) => { const d = x.getImageData(x0 | 0, y0 | 0, (x1 - x0) | 0, (y1 - y0) | 0).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (Math.max(d[i], d[i + 1], d[i + 2]) > 0) n++; return n / (d.length / 4); };
      res({ top: lit(0, 0, c.width, c.height * 0.2), mid: lit(c.width * 0.2, c.height * 0.3, c.width * 0.8, c.height * 0.7) });
    })));
    assert.equal(px.top, 0, 'the room is not drawn behind the rotate screen'); assert.ok(px.mid > 0.002, 'the rotate screen has dots: ' + px.mid);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(() => LOBBY.rotateShown() === false, null, WAIT);
    await walkTo(page, 'stacklight');
    await frames(page, 90);
    await shot(page, 'lobby-phone-844x390');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => LOBBY.rotateShown() === true, null, WAIT);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('7. the COMING SOON poster and tube text are on LEDGE LORDS only', { timeout: 90000 }, async () => {
  const { ctx, page, problems } = await openLobby({ manual: true });
  try {
    const seen = {}, tube = {};
    for (const id of ['stacklight', 'starfall', 'ledgelords']) {
      await walkTo(page, id); await frames(page, 90);
      seen[id] = await page.evaluate(() => LOBBY.posterShown());
      tube[id] = await page.evaluate(() => LOBBY.tubeSoonShown());
    }
    assert.deepEqual(seen, { stacklight: [], starfall: [], ledgelords: ['ledgelords'] });
    assert.ok(!tube.stacklight.includes('stacklight') && !tube.starfall.includes('stacklight') && !tube.ledgelords.includes('stacklight'), 'STACKLIGHT tube: ' + JSON.stringify(tube));
    assert.ok(tube.ledgelords.includes('ledgelords'), 'LEDGE LORDS tube still says COMING SOON: ' + JSON.stringify(tube));
    assert.ok(!tube.starfall.includes('starfall'), 'Starfall never did');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('8. zero arrays or typed arrays built per frame in the lobby at idle on STACKLIGHT, through the select wait', { timeout: 90000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  await ctx.addInitScript(() => {
    window.__alloc = 0; window.__count = false;
    for (const n of ['Float32Array', 'Array', 'Uint8Array']) {
      const Orig = window[n];
      window[n] = new Proxy(Orig, { construct(t, a, nt) { if (window.__count) window.__alloc++; return Reflect.construct(t, a, nt); } });
    }
  });
  const { page, problems } = await openLobby({ ctx, manual: true });
  try {
    await walkTo(page, 'stacklight');
    const n = await page.evaluate(async () => {
      const f = k => new Promise(r => { let c = 0; const t = () => { if (++c >= k) r(); else requestAnimationFrame(t); }; requestAnimationFrame(t); });
      window.__alloc = 0; window.__count = true;
      await f(90);                                  // idle on the cabinet
      LOBBY.select(); await f(40);                  // the select wait and the held lobby after it
      window.__count = false; return { n: window.__alloc, leave: LOBBY.info().leaveReady };
    });
    assert.equal(n.leave, true, 'the select ran inside the counted frames');
    assert.equal(n.n, 0, 'constructions: ' + n.n);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});
