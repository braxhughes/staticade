// STACKLIGHT T5 (design B.9, C.5, F.1 row T5): the real stacklight.html in headless Chrome, driven by real key
// and touch events and window.SL. The remote path runs against the real Worker on Node (server/dev-server.mjs), never the live server.
// No test waits on wall-clock timing for a result that can be stepped: __freeze() / __adv(k) feed the page's loop exactly k ticks.
// The page's clock is skewed from here (window.__skew added to Date.now) to cross UTC days and the read gate's 10 s.
//   1. the title: both modes, the start row, the key lines (mute key shown), SL.mode, SL.info().mode, row navigation
//   2. the Daily card is the run: for six UTC days the card (seed, ridge, rule, level, number), the ridge DRAWN on the title (pixels)
//      and the sim a run starts (SL.info() ridge, dayRule, level, seed, heights) all agree, and the card equals a Node sim of the seed
//   3. ranked then practice: first started Daily of the day ranks, quitting uses it, the second is practice and is not offered for
//      entry, a reload keeps it, the next UTC day ranks again; a ranked Daily goes to entry and the TODAY board
//   4. name entry: exactly 3 letters (letters only, extra letters replace the last, M types M and does not mute), the saved row,
//      the board page (nothing below the CRT bezel), tab cycling, the name remembered; the 30 s timer saves what is shown
//   5. board keying in a real browser: a STACKLIGHT run and a Starfall run in one browser store never share a board
//   6. save first, then submit: offline then online sends once; a reload while offline keeps the run and sends it once after
//   7. the Daily from the board: bad answer, offline answer, the 10 s read gate, then the real answer starts the run with its ticket
//   8. attract: exactly 30 s idle, the real demo replay (re-simulated in Node and compared), a key returns to the title and starts
//      nothing, Enter then gives one music track; table phase and loop; a best run of this player beats the demo; M in attract
//   9. mute: key, row, persists across a reload and runs, works paused and in attract, silent run while muted
//  10. zero arrays or typed arrays built per frame on the title, the Daily card, the board page, the entry screen and attract (the same pattern as the lobby tests)
//  11. phone sideways (844x390): title, tap to start, tap leaves attract; the lobby route (?from=lobby) on Esc
// Every page: console clean except the favicon 404. Screenshots go to W51_SHOT_DIR when it is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticServer, devServer, WAIT, ROOT, playToEntry, toTitle } from './w25-helpers.mjs';
import { dailySeed } from '../engine/rng.js';
import { decode } from '../engine/replay.js';
import { createSim } from '../games/stacklight/sim.js';
import { dailyCard, RULE_NOTE, todayUTC } from '../games/stacklight/modes.js';
import { DEMO_REPLAY } from '../games/stacklight/demo-replay.js';

const SHOT_DIR = process.env.W51_SHOT_DIR || null;
const DAY_MS = 86400000;
const FONT_SRC = fs.readFileSync(path.join(ROOT, 'engine/font.js'), 'utf8');
const TAP = 'return function text(str, x, y, col, sc, align, a, wave) {';
if (!FONT_SRC.includes(TAP)) throw new Error('engine/font.js no longer has the text() entry the tap wraps');
const FONT_TAPPED = FONT_SRC.replace(TAP, TAP + ' if (window.__texts) { window.__texts.add(str); if (window.__tlog) window.__tlog.push([str, x, y]); }');

// the page's clock can be moved (Date.now only: timers and rAF keep real time); a fixed run seed for Free Play; crt off for pixel reads
const PAGE_INIT = `(() => {
  const realNow = Date.now.bind(Date); window.__skew = 0; Date.now = () => realNow() + window.__skew;
  const g = crypto.getRandomValues.bind(crypto); window.__seed = null;
  crypto.getRandomValues = a => { if (a instanceof Uint32Array && a.length === 1 && window.__seed != null) { a[0] = window.__seed >>> 0; return a; } return g(a); };
})();`;
const CRT_OFF = `try { if (localStorage.getItem('stacklight.crt') === null) localStorage.setItem('stacklight.crt', '0'); } catch (e) {}`;
// frame stepper (as tests/stacklight-browser-w49c.test.js): __adv(k) runs exactly k sim ticks and one render
const STEPPER = `(() => {
  const real = window.requestAnimationFrame.bind(window), STEP = 1000 / 60;
  let frozen = false, held = null, lastPassed = 0, offset = 0, thawed = false;
  window.requestAnimationFrame = cb => real(t => {
    if (frozen) { held = cb; return; }
    if (thawed) { thawed = false; offset = t - (lastPassed + STEP); }
    lastPassed = t - offset; cb(lastPassed);
  });
  const until = f => new Promise(r => { const c = () => (f() ? r() : setTimeout(c, 2)); c(); });
  window.__freeze = async () => { frozen = true; await until(() => held); document.dispatchEvent(new Event('visibilitychange')); lastPassed = performance.now() - offset; };
  window.__adv = async (steps = 0) => {
    for (;;) {
      const k = Math.min(steps, 14); steps -= k;
      const cb = held; held = null; lastPassed += k * STEP + 1e-4; cb(lastPassed); await until(() => held);
      if (steps <= 0) return;
    }
  };
  window.__thaw = () => { frozen = false; thawed = true; const cb = held; held = null; if (cb) window.requestAnimationFrame(cb); };
})();`;

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

// open stacklight.html. ctx: reuse a context (same browser store); query: 'lb=...&from=lobby'
async function open({ w = 1000, h = 750, touch = false, crt = true, tap = true, query = '', init = [], ctx = null, setup = null } = {}) {
  const c = ctx || await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch });
  if (!ctx) {
    if (tap) await c.route('**/engine/font.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: FONT_TAPPED }));
    await c.addInitScript(PAGE_INIT); await c.addInitScript(STEPPER);
    if (!crt) await c.addInitScript(CRT_OFF);
    for (const s of init) await c.addInitScript(s);
    if (tap) await c.addInitScript('window.__texts = new Set();');
  }
  if (setup) await setup(c);
  const page = await c.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) problems.push('HTTP ' + r.status() + ' ' + r.url()); });
  await page.goto(web.url + 'stacklight.html' + (query ? '?' + query : ''));
  await page.waitForFunction(() => window.SL && SL.info().app === 'title' && SL.hud().F > 5, null, WAIT);
  return { ctx: c, page, problems };
}
const until = (page, fn, arg) => page.waitForFunction(fn, arg, WAIT);
const wait = ms => new Promise(r => setTimeout(r, ms));
const press = async (page, k, gap = 70) => { await page.keyboard.press(k); await wait(gap); };
const texts = page => page.evaluate(() => [...window.__texts]);
const clearTexts = page => page.evaluate(() => { window.__texts.clear(); if (window.__tlog) window.__tlog.length = 0; });
const shot = async (page, name) => { if (!SHOT_DIR) return; fs.mkdirSync(SHOT_DIR, { recursive: true }); await wait(250); await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') }); };
const frames = (page, k) => page.evaluate(k => new Promise(r => { let f = 0; const t = () => { if (++f >= k) r(); else requestAnimationFrame(t); }; requestAnimationFrame(t); }), k);
// a run played to game over with the page's own SL.place (recorded like played frames); returns its score
const COLS = [1, 4, 7, 2, 5, 3, 6];
const finish = page => page.evaluate(cols => { let n = 0; while (!SL.info().done && n++ < 800) SL.place(cols[n % 7], n % 2); return SL.info().score; }, COLS);
// Free Play from the title with the real Enter key, a fixed seed, played out, and the name entry screen reached
async function toEntry(page, { mode = 'free', seed = 11 } = {}) {
  await page.evaluate(s => { window.__seed = s; }, seed);
  if (mode === 'daily') await page.evaluate(() => SL.mode('daily')); else await page.evaluate(() => SL.mode('free'));
  await press(page, 'Enter', 200);
  await until(page, () => SL.info().app === 'play');
  const score = await finish(page);
  assert.ok(score > 0, 'the run scored ' + score);
  await until(page, () => SL.info().app === 'over');
  await wait(900);
  await press(page, 'Enter', 100);
  await until(page, () => SL.info().app === 'entry');
  return score;
}
const typeName = async (page, name) => { for (const ch of name) await press(page, /[A-Z]/.test(ch) ? 'Key' + ch : ch, 90); };
// mean brightness of the 12x12 px square at each (col, row) cell centre of the title's ridge preview (CRT off, 1000x750: 2.5 px a unit)
async function previewGrid(b64) { // runs in the page
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const PVP = 13 * 0.7, out = [];
  for (let r = 0; r < 3; r++) {
    let row = '';
    for (let col = 0; col < 9; col++) {
      const x = (332 - (9 * PVP) / 2 + PVP / 2 + col * PVP) * 2.5, y = (140 - r * PVP) * 2.5;
      const d = g.getImageData(Math.round(x) - 6, Math.round(y) - 6, 12, 12).data; let s = 0;
      for (let i = 0; i < d.length; i += 4) s += (d[i] + d[i + 1] + d[i + 2]) / 3;
      row += s / (d.length / 4) > 15 ? '1' : '0';
    }
    out.push(row);
  }
  return out;
}
// the ridge the title DRAWS, read back from a screenshot cell by cell (row 0 first): filled where the column is taller than the row.
// Up to four tries (a drifting background piece may sit on a cell). Returns the three row strings read.
async function drawnRidge(page, want) {
  const exp = [0, 1, 2].map(r => [...want].map(h => (+h > r ? '1' : '0')).join(''));
  let g = null;
  for (let k = 0; k < 4; k++) {
    await wait(120);
    g = await page.evaluate(previewGrid, (await page.screenshot()).toString('base64'));
    if (g.join() === exp.join()) break;
  }
  return { got: g, exp };
}

// ---------- 1 ----------
test('1. title: Daily Ridge and Free Play, FREE PLAY is the start row, keys and mute key shown, SL.mode and SL.info().mode, row navigation', { timeout: 90000 }, async () => {
  const { ctx, page, problems } = await open();
  try {
    await until(page, () => window.__texts.has('DAILY RIDGE'));
    const t = await texts(page);
    for (const s of ['A FALLING LIGHT PUZZLE', 'DAILY RIDGE', 'FREE PLAY', 'CRT: ON', 'BOARDS', 'SOUND: ON', 'ENTER: START   UP DOWN: CHOOSE', 'SPACE: DROP   P: PAUSE   M: MUTE', 'BEST']) assert.ok(t.includes(s), s + ' in ' + JSON.stringify(t));
    let ti = await page.evaluate(() => SL.title());
    assert.deepEqual([ti.app, ti.sel, ti.page, ti.mode, ti.dstate], ['title', 1, 'main', 'free', 'ready'], 'FREE PLAY is the row Enter starts');
    assert.equal(await page.evaluate(() => SL.info().mode), 'free');
    await shot(page, 'title-free');
    assert.equal(await page.evaluate(() => SL.mode('daily')), 'daily');
    assert.equal(await page.evaluate(() => SL.mode()), 'daily'); assert.equal(await page.evaluate(() => SL.info().mode), 'daily');
    assert.equal((await page.evaluate(() => SL.title())).sel, 0);
    await until(page, () => window.__texts.has('RANKED ATTEMPT READY')); await shot(page, 'title-daily');
    assert.equal(await page.evaluate(() => SL.mode('free')), 'free'); assert.equal((await page.evaluate(() => SL.title())).sel, 1);
    assert.equal(await page.evaluate(() => SL.mode('bogus')), null); assert.equal(await page.evaluate(() => SL.mode()), 'free', 'a bad mode changes nothing');
    // keys: up from FREE PLAY is DAILY RIDGE; down walks CRT, BOARDS, SOUND, then wraps to DAILY RIDGE
    await press(page, 'ArrowUp'); ti = await page.evaluate(() => SL.title()); assert.deepEqual([ti.sel, ti.mode], [0, 'daily']);
    await press(page, 'ArrowDown'); assert.deepEqual([(await page.evaluate(() => SL.title())).sel, await page.evaluate(() => SL.mode())], [1, 'free']);
    for (const want of [2, 3, 4, 0]) { await press(page, 'ArrowDown'); assert.equal((await page.evaluate(() => SL.title())).sel, want); }
    await press(page, 'ArrowUp'); assert.equal((await page.evaluate(() => SL.title())).sel, 4, 'up from the top wraps to SOUND');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

// ---------- 2 ----------
test('2. the Daily card is the run: card, drawn ridge and the sim a run starts agree for six UTC days (and equal a Node sim of the seed)', { timeout: 180000 }, async () => {
  const { ctx, page, problems } = await open({ crt: false });
  try {
    const seen = new Set();
    for (let d = 0; d < 6; d++) {
      await page.evaluate(k => { window.__skew = k * 86400000 * 3; }, d); // every 3rd day: six different seeds
      const dayKey = todayUTC(Date.now() + d * 3 * DAY_MS);
      await page.evaluate(() => { SL.mode('free'); window.__texts.clear(); });
      await page.evaluate(() => SL.mode('daily'));
      const card = (await page.evaluate(() => SL.title())).card;
      assert.equal(card.dayKey, dayKey);
      assert.equal(card.seed, dailySeed(dayKey), 'the public seed of that UTC day');
      const node = dailyCard(card.seed, dayKey), nsim = createSim({ seed: card.seed, mode: 'daily' }).info();
      assert.deepEqual([card.ridge, card.rule, card.level, card.levelStr, card.noStr], [nsim.ridge, nsim.dayRule, 4, 'LEVEL 4', node.noStr]);
      // the card's words are on screen
      await until(page, r => window.__texts.has(r), card.rule);
      const t = await texts(page);
      for (const s of [card.noStr, 'LEVEL 4', 'START', card.rule, 'DAY RULE', RULE_NOTE[card.rule], 'RANKED ATTEMPT READY']) assert.ok(t.includes(s), s + ' in ' + JSON.stringify(t));
      // and the ridge is DRAWN as the ridge the sim builds: heights read back from the pixels
      const dr = await drawnRidge(page, card.ridge); assert.deepEqual(dr.got, dr.exp, 'the title draws ridge ' + card.ridge + ' cell by cell');
      // start it: what the sim builds is what the card said
      await press(page, 'Enter', 200);
      await until(page, () => SL.info().app === 'play');
      const i = await page.evaluate(() => SL.info());
      assert.deepEqual([i.mode, i.seed, i.ridge, i.dayRule, i.level], ['daily', card.seed, card.ridge, card.rule, 4]);
      assert.deepEqual(i.heights, [...card.ridge].map(Number), 'the board holds the ridge');
      seen.add(card.ridge + card.rule);
      await press(page, 'Escape', 100); await press(page, 'Escape', 150);   // pause, then leave the run
      await until(page, () => SL.info().app === 'title');
    }
    assert.ok(seen.size >= 5, 'six days gave ' + seen.size + ' different cards');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

// ---------- 3 ----------
test('3. ranked then practice: first Daily of the UTC day ranks, quitting uses it, the second is practice (no entry), a reload keeps it, the next day ranks again', { timeout: 150000 }, async () => {
  const { ctx, page, problems } = await open();
  try {
    await page.evaluate(() => SL.mode('daily'));
    assert.equal((await page.evaluate(() => SL.title())).used, false);
    assert.equal(await page.evaluate(() => SL.attemptUsed()), false);
    await press(page, 'Enter', 200); await until(page, () => SL.info().app === 'play');
    let r = await page.evaluate(() => SL.runInfo());
    assert.deepEqual([r.mode, r.claimed, r.ranked, r.fromServer, r.ticket], ['daily', true, true, false, null], 'the first run of the day is the ranked attempt');
    assert.equal(await page.evaluate(() => SL.attemptUsed()), true, 'the marker is written at the first frame');
    await press(page, 'Escape', 100); await press(page, 'Escape', 150);   // quit without a score
    await until(page, () => SL.info().app === 'title' && SL.title().used === true);
    await page.evaluate(() => window.__texts.clear()); await page.evaluate(() => SL.mode('daily'));
    await until(page, () => window.__texts.has('PRACTICE: ATTEMPT USED'));
    // the second run: practice. Played to game over, it is never offered for entry and reaches no board.
    await press(page, 'Enter', 200); await until(page, () => SL.info().app === 'play');
    r = await page.evaluate(() => SL.runInfo());
    assert.deepEqual([r.claimed, r.ranked], [true, false], 'practice');
    const score = await finish(page); assert.ok(score > 0, 'the practice run scored ' + score);
    await until(page, () => SL.info().app === 'over'); await wait(900);
    assert.equal(await page.evaluate(() => window.__texts.has('ENTER: SAVE')), false, 'the results do not offer a save');
    await press(page, 'Enter', 300);
    assert.equal(await page.evaluate(() => SL.info().app), 'title', 'straight back to the title: no name entry for practice');
    assert.deepEqual(await page.evaluate(() => SL.scores('all')), [], 'nothing on the local board');
    // a reload keeps the marker (it is in localStorage)
    await page.reload(); await until(page, () => window.SL && SL.info().app === 'title' && SL.hud().F > 5);
    assert.equal(await page.evaluate(() => SL.attemptUsed()), true);
    await page.evaluate(() => SL.mode('daily')); await press(page, 'Enter', 200); await until(page, () => SL.info().app === 'play');
    assert.equal((await page.evaluate(() => SL.runInfo())).ranked, false, 'still practice after a reload');
    await press(page, 'Escape', 100); await press(page, 'Escape', 150); await until(page, () => SL.info().app === 'title');
    // Free Play is always ranked and never touches the Daily marker
    await page.evaluate(() => SL.mode('free')); await press(page, 'Enter', 200); await until(page, () => SL.info().app === 'play');
    r = await page.evaluate(() => SL.runInfo()); assert.deepEqual([r.mode, r.ranked, r.dayKey], ['free', true, null]);
    await press(page, 'Escape', 100); await press(page, 'Escape', 150); await until(page, () => SL.info().app === 'title');
    // the next UTC day: ranked again (the title notices within a second), and it goes through entry to the TODAY board
    await page.evaluate(() => { window.__skew = 86400000; window.__texts.clear(); });
    await until(page, () => SL.title().sel === 1); await page.evaluate(() => { SL.mode('free'); SL.mode('daily'); });
    await until(page, () => SL.title().used === false && window.__texts.has('RANKED ATTEMPT READY'));
    const tomorrow = todayUTC(Date.now() + DAY_MS);
    assert.equal((await page.evaluate(() => SL.title())).card.dayKey, tomorrow);
    await page.evaluate(() => { window.__seed = 3; });
    await press(page, 'Enter', 200); await until(page, () => SL.info().app === 'play');
    r = await page.evaluate(() => SL.runInfo()); assert.deepEqual([r.dayKey, r.ranked], [tomorrow, true]);
    const sc = await finish(page); assert.ok(sc > 0);
    await until(page, () => SL.info().app === 'over'); await wait(900); await press(page, 'Enter', 150);
    await until(page, () => SL.info().app === 'entry');
    assert.ok((await texts(page)).includes('DAILY RIDGE ' + tomorrow), 'the entry names the mode and day');
    await typeName(page, 'DAY'); await press(page, 'Enter', 100);
    await until(page, () => SL.title().page === 'table');
    await until(page, () => SL.table().loaded);
    const today = await page.evaluate(k => SL.scores('daily', k), tomorrow);
    assert.deepEqual(today.map(x => [x.name, x.score, x.mode]), [['DAY', sc, 'daily']], 'on the Daily board of that day');
    assert.deepEqual((await page.evaluate(() => SL.scores('all'))).map(x => x.name), ['DAY']);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

// ---------- 4 ----------
test('4. name entry: exactly 3 letters (letters only, a 4th letter replaces the 3rd, M types M), the saved row, the board page, tab cycling, name remembered', { timeout: 120000 }, async () => {
  const { ctx, page, problems } = await open({ tap: true });
  try {
    const score = await toEntry(page, { seed: 11 });
    await wait(200); await clearTexts(page);
    for (const s of ['NEW RUN RECORD', String(score), 'FREE PLAY', 'ENTER YOUR INITIALS']) await until(page, x => window.__texts.has(x), s);
    assert.deepEqual(await page.evaluate(() => SL.nameEntry()), { name: 'AAA', pos: 0 }, 'AAA first');
    await shot(page, 'entry');
    // 1, minus and period are not letters; Q W E fill the 3 slots; R replaces the 3rd, never a 4th letter
    await typeName(page, 'Q1'); await press(page, 'Minus', 90); await press(page, 'Period', 90);
    assert.deepEqual(await page.evaluate(() => SL.nameEntry()), { name: 'QAA', pos: 1 }, 'only the letter counted');
    await typeName(page, 'WER');
    assert.deepEqual(await page.evaluate(() => SL.nameEntry()), { name: 'QWR', pos: 2 });
    // M is a letter here: it is typed and does not mute
    await typeName(page, 'M');
    assert.deepEqual(await page.evaluate(() => SL.nameEntry()), { name: 'QWM', pos: 2 });
    assert.equal(await page.evaluate(() => SL.mute()), false, 'M typed a letter');
    // up and down change the letter at the cursor, Escape moves back
    await press(page, 'ArrowUp'); assert.equal((await page.evaluate(() => SL.nameEntry())).name, 'QWN');
    await press(page, 'ArrowDown'); await press(page, 'ArrowDown'); assert.equal((await page.evaluate(() => SL.nameEntry())).name, 'QWL');
    await press(page, 'Escape'); assert.equal((await page.evaluate(() => SL.nameEntry())).pos, 1);
    await press(page, 'Enter'); assert.equal((await page.evaluate(() => SL.nameEntry())).pos, 2); assert.equal(await page.evaluate(() => SL.info().app), 'entry', 'Enter on the 2nd letter only moves on');
    await clearTexts(page);
    await press(page, 'Enter', 100);                                                                  // third letter: save
    await until(page, () => SL.title().page === 'table'); await until(page, () => SL.table().loaded && SL.table().rows === 1);
    const rows = await page.evaluate(() => SL.scores('all'));
    assert.deepEqual(rows.map(r => [r.name, r.score, r.mode]), [['QWL', score, 'free']]);
    assert.match(rows[0].name, /^[A-Z]{3}$/);
    assert.equal(await page.evaluate(() => localStorage.getItem('stacklight.name')), 'QWL', 'the name is remembered');
    // the board page: every string inside the field and above the CRT bezel (y 290), the key line shown, rows drawn
    await wait(300); await clearTexts(page); await page.evaluate(() => { window.__tlog = []; });
    await wait(400);
    const log = await page.evaluate(() => window.__tlog);
    const t = log.map(x => x[0]);
    for (const s of ['ALL-TIME', 'TODAY', 'SEASON', '1.', 'QWL', String(score), 'UP DOWN: BOARD   ENTER: BACK']) assert.ok(t.includes(s), s + ' on the board page: ' + JSON.stringify([...new Set(t)]));
    const low = log.filter(([s, , y]) => y > 290 && !['STACKLIGHT'].includes(s));
    assert.deepEqual(low, [], 'nothing drawn under the CRT bezel');
    assert.ok(log.some(([s]) => /^RANK 1 ALL-TIME/.test(s)), 'the rank line');
    await shot(page, 'board');
    // up and down cycle the tabs; TODAY is empty for a Free Play run
    await press(page, 'ArrowDown'); assert.equal((await page.evaluate(() => SL.table())).tab, 1);
    assert.equal((await page.evaluate(() => SL.table())).rows, 0);
    await press(page, 'ArrowDown'); assert.equal((await page.evaluate(() => SL.table())).tab, 2); assert.equal((await page.evaluate(() => SL.table())).rows, 1, 'SEASON');
    await press(page, 'ArrowDown'); assert.equal((await page.evaluate(() => SL.table())).tab, 0);
    await press(page, 'ArrowUp'); assert.equal((await page.evaluate(() => SL.table())).tab, 2);
    await press(page, 'Enter'); assert.equal((await page.evaluate(() => SL.title())).page, 'main', 'Enter leaves the board page');
    // the next run starts its entry from the remembered name
    await toEntry(page, { seed: 12 });
    assert.deepEqual(await page.evaluate(() => SL.nameEntry()), { name: 'QWL', pos: 0 });
    // a run that ends by the timer saves what is shown (frozen page, exact ticks)
    await page.evaluate(() => window.__freeze());
    const e0 = await page.evaluate(() => SL.entryT());
    await page.evaluate(n => window.__adv(n), 1790 - e0); assert.equal(await page.evaluate(() => SL.info().app), 'entry', 'still waiting at tick 1790');
    await page.evaluate(() => window.__adv(15));
    assert.equal(await page.evaluate(() => SL.title().page), 'table', 'the 30 s timer saved the run');
    await page.evaluate(() => window.__thaw());
    await until(page, () => SL.table().loaded);
    assert.deepEqual((await page.evaluate(() => SL.scores('all', undefined, false))).map(r => r.name), ['QWL', 'QWL'], 'two saved runs (the board shows each player\'s best)');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

// ---------- 5 ----------
test('5. board keying in one browser store: a STACKLIGHT run and a Starfall run never share a board, either way round', { timeout: 150000 }, async () => {
  const { ctx, page, problems } = await open();
  try {
    await toEntry(page, { seed: 21 }); await typeName(page, 'SLT'); await press(page, 'Enter', 100);
    await until(page, () => SL.title().page === 'table' && SL.table().rows === 1);
    // a Starfall free run into the same store (same origin)
    const sf = await ctx.newPage();
    sf.on('pageerror', e => problems.push('starfall pageerror: ' + e.message));
    await sf.goto(web.url + 'starfall.html'); await sf.waitForFunction(() => window.SF, null, WAIT);
    await toTitle(sf); await playToEntry(sf, 'free');
    await sf.evaluate(() => SF.nameEntry('STR'));
    await sf.waitForFunction(() => SF.state !== 'entry', null, WAIT);
    await wait(500);
    const sfRows = await sf.evaluate(() => SF.scores('all'));
    assert.deepEqual(sfRows.map(r => r.name), ['STR'], 'Starfall board: only its own run');
    await page.reload(); await until(page, () => window.SL && SL.info().app === 'title' && SL.hud().F > 5);
    assert.deepEqual((await page.evaluate(() => SL.scores('all'))).map(r => r.name), ['SLT'], 'STACKLIGHT board: only its own run');
    const keys = await page.evaluate(() => Object.keys(localStorage));
    const boardKeys = keys.filter(k => /^arcade:(board|rh|player):/.test(k));
    assert.ok(boardKeys.some(k => k.includes(':stacklight:')) && boardKeys.some(k => k.includes(':starfall:')), boardKeys.join());
    for (const k of boardKeys) assert.ok(k.includes(':stacklight:') !== k.includes(':starfall:'), 'one game per key: ' + k);
    // the title's own settings are kept apart too
    assert.ok(keys.includes('stacklight.name'), 'the name is kept under STACKLIGHT\'s own prefix');
    await sf.close();
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

// ---------- 6 ----------
test('6. save first, then submit: offline then online sends once and never twice; a reload while offline keeps the run and sends it once after', { timeout: 180000 }, async () => {
  const dev = await devServer();
  const { ctx, page, problems } = await open({ query: 'lb=' + encodeURIComponent(dev.url) });
  const offline = r => r.abort('connectionrefused');
  try {
    assert.equal(await page.evaluate(() => SL.remote()), dev.url);
    await ctx.route(dev.url + '/**', offline);                                       // the board is unreachable
    await toEntry(page, { seed: 31 }); await typeName(page, 'OFF');
    const before = await page.evaluate(() => SL.info().score);
    await press(page, 'Enter', 100);
    await until(page, () => SL.title().page === 'table');
    const res = await page.evaluate(() => SL.lastSubmit().then(r => !!r));
    assert.equal(res, true, 'saved here');
    assert.deepEqual((await page.evaluate(() => SL.scores('all'))).map(r => [r.name, r.score]), [['OFF', before]], 'the local board has it first');
    await until(page, () => /^OFFLINE: 1 RUN SAVED HERE, WILL RETRY/.test(SL.status()));
    let q = await page.evaluate(() => SL.queue()); assert.equal(q.length, 1); assert.equal(q.items[0].mode, 'free'); assert.equal(q.items[0].score, before);
    assert.equal(await page.evaluate(() => localStorage.getItem('stacklight.sendq') !== null), true, 'the queue is under its own key');
    assert.equal(await page.evaluate(() => localStorage.getItem('starfall.sendq')), null);
    assert.deepEqual((await dev.get('/board?game=stacklight&board=all')).rows, [], 'nothing on the server');
    // back online: wake and flush, three at once; the server stores it once
    await ctx.unroute(dev.url + '/**', offline);
    const sent = await page.evaluate(() => Promise.all([SL.flushQueue(true), SL.flushQueue(true), SL.flushQueue(true)]));
    assert.deepEqual(sent.map(x => x.map(e => e.kind)), [['ok'], ['ok'], ['ok']], 'three callers share the one send: ' + JSON.stringify(sent));
    q = await page.evaluate(() => SL.queue()); assert.equal(q.length, 0);
    await page.evaluate(() => SL.flushQueue(true)); await page.evaluate(() => SL.flushQueue(true));
    let rows = (await dev.get('/board?game=stacklight&board=all')).rows;
    assert.deepEqual(rows.map(r => [r.name, r.score]), [['OFF', before]], 'exactly one row on the server');
    assert.deepEqual((await dev.get('/board?game=starfall&board=all')).rows, [], 'no STACKLIGHT row on the Starfall board');
    assert.match(await page.evaluate(() => SL.status()), /^(ONLINE|SAVED ONLINE)/);
    assert.equal((await page.evaluate(() => SL.lastRemote())).kind, 'ok');
    // a reload while online does not send it again
    await page.reload(); await until(page, () => window.SL && SL.info().app === 'title' && SL.hud().F > 5); await wait(1600);
    assert.equal((await dev.get('/board?game=stacklight&board=all')).rows.length, 1);
    // run 2: offline again, the page is reloaded still offline, the queue survives, the 'online' event sends it
    await ctx.route(dev.url + '/**', offline);
    await page.evaluate(() => { window.__seed = 32; });
    await toEntry(page, { seed: 32 }); await typeName(page, 'TWO'); const s2 = await page.evaluate(() => SL.info().score); await press(page, 'Enter', 100);
    await until(page, () => SL.title().page === 'table'); await until(page, () => /OFFLINE/.test(SL.status()));
    await page.reload(); await until(page, () => window.SL && SL.info().app === 'title' && SL.hud().F > 5);
    assert.equal((await page.evaluate(() => SL.queue())).length, 1, 'the run is still queued after a reload');
    await until(page, () => /WAITING TO SEND|OFFLINE/.test(SL.status()));
    assert.equal((await dev.get('/board?game=stacklight&board=all')).rows.length, 1);
    await ctx.unroute(dev.url + '/**', offline);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await until(page, () => SL.queue().length === 0);
    rows = (await dev.get('/board?game=stacklight&board=all')).rows;
    // the server's board keeps each player's best run, so one row: whichever of the two scored more (run 2's delivery is the queue
    // emptying with an ok answer; its score is on the local board)
    const best = s2 > before ? ['TWO', s2] : ['OFF', before];
    assert.deepEqual(rows.map(r => [r.name, r.score]), [best], 'one row, the better run, no duplicate');
    assert.equal((await page.evaluate(() => SL.lastRemote())).kind, 'ok');
    assert.deepEqual((await page.evaluate(() => SL.scores('all', undefined, false))).map(r => r.name).sort(), ['OFF', 'TWO'], 'both runs on the local board');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); await dev.kill(); }
});

// ---------- 7 ----------
test('7. the Daily from the board: a bad answer and a silent board keep it from starting, the read gate waits 10 s, then the real answer starts the run with its ticket', { timeout: 180000 }, async () => {
  const secret = 'w51-' + Math.random().toString(36).slice(2) + 'x'.repeat(40);
  let dev;
  process.env.DAILY_SECRET = secret;
  try { dev = await devServer(); } finally { delete process.env.DAILY_SECRET; }
  const { ctx, page, problems } = await open({ query: 'lb=' + encodeURIComponent(dev.url) });
  const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
  const bad = r => (r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: CORS })
    : r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ ok: true, dayKey: 'nope', seed: 5, ticket: null }) }));
  const gone = r => r.abort('connectionrefused');
  const isDaily = u => u.href.startsWith(dev.url + '/daily');
  try {
    // 1. an answer that is not a day
    await ctx.route(isDaily, bad);
    await clearTexts(page); await page.evaluate(() => SL.mode('daily'));
    await until(page, () => SL.title().dstate === 'off');
    let ti = await page.evaluate(() => SL.title()); assert.equal(ti.dmsg, 'BAD ANSWER'); assert.equal(ti.card, null);
    for (const s of ['DAILY NEEDS THE BOARD', 'BAD ANSWER', 'ENTER: TRY AGAIN']) await until(page, x => window.__texts.has(x), s);
    await shot(page, 'title-daily-needs-board');
    await press(page, 'Enter', 400);
    assert.equal(await page.evaluate(() => SL.info().app), 'title', 'a Daily that cannot be asked for does not start');
    assert.equal(await page.evaluate(() => SL.runInfo()), null);
    // 2. the board does not answer
    await ctx.unroute(isDaily, bad);
    await ctx.route(isDaily, gone);
    await press(page, 'Enter', 400); await until(page, () => SL.title().dstate === 'off' && SL.title().dmsg === 'OFFLINE');
    // 3. the board is back, but the read gate holds reads for 10 s after a failure: no request, no run
    await ctx.unroute(isDaily, gone);
    const reads = await page.evaluate(() => SL.boardReads());
    await press(page, 'Enter', 300);
    assert.equal(await page.evaluate(() => SL.boardReads()), reads, 'no request inside the 10 s wait');
    assert.equal(await page.evaluate(() => SL.info().app), 'title');
    await page.evaluate(() => { window.__skew += 11000; });
    // 4. the real answer: the run starts by itself, on the board's seed and ticket, never the public seed
    await press(page, 'Enter', 100);
    await until(page, () => SL.info().app === 'play').catch(async e => { throw new Error(e.message + ' ' + JSON.stringify(await page.evaluate(() => [SL.title(), SL.boardReads()]))); });
    const r = await page.evaluate(() => SL.runInfo()), i = await page.evaluate(() => SL.info()), card = (await page.evaluate(() => SL.title())).card;
    assert.deepEqual([r.mode, r.fromServer, r.ranked, r.claimed], ['daily', true, true, true]);
    assert.ok(typeof r.ticket === 'string' && r.ticket.length > 0, 'the board\'s ticket: ' + r.ticket);
    assert.notEqual(r.seed, dailySeed(r.dayKey), 'not the public seed of the day');
    assert.equal(r.dayKey, todayUTC(Date.now()));
    assert.deepEqual([i.seed, i.mode], [r.seed, 'daily']);
    assert.deepEqual([card.seed, card.ridge, card.rule], [r.seed, i.ridge, i.dayRule], 'the card was this run');
    const real = (await dev.get('/board?game=stacklight&board=daily')).rows;
    assert.ok(Array.isArray(real));
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); await dev.kill(); }
});

// ---------- 8 ----------
test('8. attract: exactly 30 s idle, the real demo (compared with a Node re-sim), a key returns to the title and starts nothing, Enter then gives one music track, table phase, loop, M', { timeout: 180000 }, async () => {
  const { ctx, page, problems } = await open();
  try {
    const dec = decode(DEMO_REPLAY), nsim = createSim({ seed: dec.seed, mode: dec.mode }), at = {};
    for (let f = 1; f <= 400; f++) { nsim.step(dec.words[f - 1]); nsim.clearEvents(); at[f] = { score: nsim.score, hash: nsim.stateHash() }; }
    await page.evaluate(() => window.__freeze());
    const adv = n => page.evaluate(k => window.__adv(k), n);
    // idle: 1799 ticks is still the title, the 1800th starts attract
    await page.evaluate(() => SL.idle(1798)); await adv(1);
    assert.deepEqual([await page.evaluate(() => SL.info().app), await page.evaluate(() => SL.idle())], ['title', 1799]);
    await adv(1);
    assert.equal(await page.evaluate(() => SL.info().app), 'attract', 'the 1800th idle tick');
    await until(page, () => SL.attract().phase === 'play' || (window.__adv(1), false));
    let a = await page.evaluate(() => SL.attract());
    assert.deepEqual([a.kind, a.banner, a.seed, a.mode], ['demo', 'DEMO RUN', dec.seed, dec.mode]);
    await clearTexts(page);
    await adv(120); a = await page.evaluate(() => SL.attract());
    assert.ok(a.frame >= 119 && a.frame <= 122, 'one sim frame a tick: ' + a.frame);
    assert.equal(a.score, at[a.frame].score, 'the same run as a Node re-sim of the bundled replay (frame ' + a.frame + ')');
    await adv(180); a = await page.evaluate(() => SL.attract()); assert.equal(a.score, at[a.frame].score, 'and at frame ' + a.frame);
    const t = await texts(page);
    for (const s of ['DEMO RUN', 'PRESS ANY KEY']) assert.ok(t.includes(s), s + ' in ' + JSON.stringify(t));
    await page.evaluate(() => window.__thaw()); await shot(page, 'attract'); await page.evaluate(() => window.__freeze());
    // M mutes and unmutes in attract and stays in it
    await press(page, 'KeyM', 30); await adv(2);
    assert.deepEqual([await page.evaluate(() => SL.info().app), await page.evaluate(() => SL.mute())], ['attract', true]);
    await press(page, 'KeyM', 30); await adv(2);
    assert.deepEqual([await page.evaluate(() => SL.info().app), await page.evaluate(() => SL.mute())], ['attract', false]);
    // no music in attract
    const au = await page.evaluate(() => SL.audio()); assert.deepEqual([au.playing, au.starts], [false, 0], 'attract makes no music');
    // a key returns to the title and starts nothing
    await press(page, 'ArrowLeft', 30); await adv(2);
    const back = await page.evaluate(() => ({ i: SL.info(), t: SL.title(), idle: SL.idle(), att: SL.attract() }));
    assert.deepEqual([back.i.app, back.t.sel, back.att.phase], ['title', 1, 'off']);
    assert.ok(back.idle <= 1, 'the idle count starts over: ' + back.idle);
    assert.equal(back.i.frame, 0, 'no run was started');
    // Enter starts a fresh run: clean state, ONE music track
    await press(page, 'Enter', 30); await adv(3);
    const run = await page.evaluate(() => SL.info()); assert.equal(run.app, 'play'); assert.ok(run.frame >= 1 && run.frame <= 3, 'a fresh run: frame ' + run.frame); assert.equal(run.score, 0);
    await adv(240);
    await page.evaluate(() => window.__thaw());
    await until(page, () => SL.audio().playing && SL.audio().ctxState === 'running');
    const m = await page.evaluate(() => SL.audio());
    assert.deepEqual([m.track !== null, m.starts, m.level], [true, 1, 1], 'one music track: ' + JSON.stringify({ starts: m.starts, track: m.track }));
    // table phase after the 20 s of play, and the loop. (Back to the title through the pause screen.)
    await press(page, 'Escape', 60); await press(page, 'Escape', 60); await until(page, () => SL.info().app === 'title');
    await page.evaluate(() => window.__freeze());
    await page.evaluate(() => SL.idle(1799)); await adv(1);
    await until(page, () => SL.attract().phase === 'play' || (window.__adv(1), false));
    await adv(1205); a = await page.evaluate(() => SL.attract()); assert.equal(a.phase, 'table', 'after 20 s: the table');
    await clearTexts(page); await adv(30);
    assert.ok((await texts(page)).includes('NO RUNS YET'), 'the board table is shown');
    await adv(1205); a = await page.evaluate(() => SL.attract()); assert.equal(a.phase, 'play'); assert.ok(a.frame >= 1 && a.frame <= 50, 'the demo starts over (35 + 1205 ticks into the table, 1200 for it): frame ' + a.frame);
    await press(page, 'Enter', 30); await adv(3);
    assert.equal(await page.evaluate(() => SL.info().app), 'title', 'a key returns');
    await page.evaluate(() => window.__thaw());
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('8b. attract plays the best run on this device instead of the demo, and a run saved by another version is skipped', { timeout: 150000 }, async () => {
  const { ctx, page, problems } = await open();
  try {
    await toEntry(page, { seed: 41 }); const sc = await page.evaluate(() => SL.info().score);
    await typeName(page, 'ACE'); await press(page, 'Enter', 100);
    await until(page, () => SL.title().page === 'table' && SL.table().rows === 1);
    await press(page, 'Enter', 100);
    await page.evaluate(() => window.__freeze());
    await page.evaluate(() => SL.idle(1799)); await page.evaluate(() => window.__adv(1));
    await until(page, () => SL.attract().phase === 'play' || (window.__adv(1), false));
    const a = await page.evaluate(() => SL.attract());
    assert.deepEqual([a.kind, a.banner, a.seed, a.mode], ['best', 'BEST RUN: ACE ' + sc, 41, 'arcade']);
    await page.evaluate(() => window.__thaw());
    // the stored replay says version 1.0 (an old version): attract skips it and plays the demo
    await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) if (k.startsWith('arcade:replay:')) { const o = JSON.parse(localStorage.getItem(k)); o.version = '1.0'; localStorage.setItem(k, JSON.stringify(o)); }
    });
    await page.reload(); await until(page, () => window.SL && SL.info().app === 'title' && SL.hud().F > 5);
    await page.evaluate(() => window.__freeze());
    await page.evaluate(() => SL.idle(1799)); await page.evaluate(() => window.__adv(1));
    await until(page, () => SL.attract().phase === 'play' || (window.__adv(1), false));
    assert.deepEqual([(await page.evaluate(() => SL.attract())).kind], ['demo']);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

// ---------- 9 ----------
test('9. mute: key and SOUND row, shown on the title, kept across a reload and runs, works paused, silent run while muted', { timeout: 150000 }, async () => {
  const { ctx, page, problems } = await open();
  try {
    assert.equal(await page.evaluate(() => SL.mute()), false);
    await press(page, 'KeyM');
    assert.equal(await page.evaluate(() => SL.mute()), true);
    assert.equal((await page.evaluate(() => SL.audio())).muted, true, 'the sound engine is muted');
    assert.equal(await page.evaluate(() => localStorage.getItem('stacklight.mute')), '1');
    await clearTexts(page); await until(page, () => window.__texts.has('MUTED') && window.__texts.has('SOUND: OFF'));
    // a reload keeps it; a run is silent
    await page.reload(); await until(page, () => window.SL && SL.info().app === 'title' && SL.hud().F > 5);
    assert.deepEqual([await page.evaluate(() => SL.mute()), (await page.evaluate(() => SL.audio())).muted], [true, true], 'muted after a reload');
    await press(page, 'Enter', 200); await until(page, () => SL.info().app === 'play');
    await wait(1500);
    let au = await page.evaluate(() => SL.audio()); assert.deepEqual([au.muted, au.playing], [true, false], 'no music while muted');
    // M in a run unmutes: the music comes in
    await press(page, 'KeyM'); au = await page.evaluate(() => SL.audio()); assert.equal(au.muted, false);
    await until(page, () => SL.audio().playing);
    // mute during pause: the run stays paused, the music stays off after resume
    await press(page, 'KeyP', 100); assert.equal(await page.evaluate(() => SL.info().paused), true);
    await press(page, 'KeyM'); assert.deepEqual([await page.evaluate(() => SL.mute()), await page.evaluate(() => SL.info().paused)], [true, true]);
    await press(page, 'KeyP', 100); await wait(1200);
    au = await page.evaluate(() => SL.audio()); assert.deepEqual([au.muted, au.playing, au.paused], [true, false, false]);
    await press(page, 'KeyM'); await until(page, () => SL.audio().playing);
    // the setting is kept for the next run too (muted from the title row, then Enter)
    await press(page, 'Escape', 100); await press(page, 'Escape', 150); await until(page, () => SL.info().app === 'title');
    for (let i = 0; i < 3; i++) await press(page, 'ArrowDown');                                  // FREE PLAY -> CRT -> BOARDS -> SOUND
    assert.equal((await page.evaluate(() => SL.title())).sel, 4);
    await press(page, 'Enter'); assert.equal(await page.evaluate(() => SL.mute()), true, 'the SOUND row toggles it');
    await clearTexts(page); await until(page, () => window.__texts.has('SOUND: OFF'));
    await press(page, 'ArrowDown'); await press(page, 'ArrowDown'); assert.equal((await page.evaluate(() => SL.title())).sel, 1);
    await press(page, 'Enter', 200); await until(page, () => SL.info().app === 'play'); await wait(1200);
    au = await page.evaluate(() => SL.audio()); assert.deepEqual([au.muted, au.playing], [true, false]);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

// ---------- 10 ----------
test('10. zero arrays or typed arrays built per frame on the title, the Daily card, the board page, the entry screen and attract (play and table phases)', { timeout: 180000 }, async () => {
  const COUNT = `(() => {
    window.__alloc = 0; window.__count = false; window.__allocBy = {};
    for (const n of ['Float32Array', 'Float64Array', 'Int8Array', 'Int16Array', 'Int32Array', 'Uint8Array', 'Uint16Array', 'Uint32Array', 'Array']) {
      const Orig = window[n];
      window[n] = new Proxy(Orig, { construct(t, a, nt) { if (window.__count) { window.__alloc++; window.__allocBy[n] = (window.__allocBy[n] || 0) + 1; } return Reflect.construct(t, a, nt); },
        apply(t, th, a) { if (window.__count) { window.__alloc++; window.__allocBy[n] = (window.__allocBy[n] || 0) + 1; } return Reflect.apply(t, th, a); } });
    }
  })();`;
  const { ctx, page, problems } = await open({ tap: false, init: [COUNT] });
  const counted = async (k, what) => {
    await page.evaluate(() => { window.__alloc = 0; window.__allocBy = {}; window.__count = true; });
    await frames(page, k);
    const r = await page.evaluate(() => { window.__count = false; return { n: window.__alloc, by: window.__allocBy }; });
    assert.deepEqual(r, { n: 0, by: {} }, what);
  };
  try {
    await counted(90, 'title, FREE PLAY card');
    await page.evaluate(() => SL.mode('daily')); await wait(100);
    await counted(90, 'title, Daily card (ridge preview)');
    await press(page, 'ArrowDown'); await press(page, 'ArrowDown'); await press(page, 'ArrowDown'); await press(page, 'ArrowDown');   // SOUND row
    await counted(60, 'title, SOUND row');
    await page.evaluate(() => SL.page('table', 0)); await until(page, () => SL.table().loaded); await wait(100);
    await counted(90, 'board page');
    await page.evaluate(() => SL.page('main'));
    // entry screen (a finished run)
    await page.evaluate(() => { SL.mode('free'); });
    await press(page, 'Enter', 200); await until(page, () => SL.info().app === 'play');
    await finish(page); await until(page, () => SL.info().app === 'over'); await wait(900); await press(page, 'Enter', 100);
    await until(page, () => SL.info().app === 'entry');
    await counted(120, 'name entry');
    await typeName(page, 'ZZZ'); await counted(60, 'name entry, typed');
    await press(page, 'Enter', 100); await until(page, () => SL.title().page === 'table');
    await counted(60, 'board page after a save (result line)');
    await press(page, 'Enter', 100);
    // attract: play phase, then the table phase
    await page.evaluate(() => SL.attractNow()); await until(page, () => SL.attract().phase === 'play');
    await counted(120, 'attract play phase');
    assert.equal((await page.evaluate(() => SL.attract())).phase, 'play');
    await page.evaluate(() => window.__freeze()); await page.evaluate(() => window.__adv(1100)); await page.evaluate(() => window.__thaw());
    await until(page, () => SL.attract().phase === 'table');
    await counted(90, 'attract table phase');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

// ---------- 11 ----------
test('11. phone sideways (844x390): the title, tap to start, a tap leaves attract; Esc on a title opened from the lobby goes back to it', { timeout: 120000 }, async () => {
  const { ctx, page, problems } = await open({ w: 844, h: 390, touch: true });
  try {
    assert.equal((await page.evaluate(() => SL.view())).touchUi, true);
    await until(page, () => window.__texts.has('TAP TO START'));
    const t = await texts(page);
    for (const s of ['DAILY RIDGE', 'FREE PLAY', 'SWIPE: CHOOSE', 'TAP TO START']) assert.ok(t.includes(s), s);
    assert.equal((await page.evaluate(() => SL.view())).rotateShown, false);
    await shot(page, 'title-phone');
    await page.evaluate(() => SL.mode('daily')); await wait(200);
    await shot(page, 'title-phone-daily');
    await page.evaluate(() => SL.mode('free'));
    // a tap leaves attract and starts nothing
    await page.evaluate(() => SL.attractNow()); await until(page, () => SL.attract().phase === 'play');
    await page.touchscreen.tap(422, 195); await until(page, () => SL.info().app === 'title'); await wait(200);
    assert.equal((await page.evaluate(() => SL.info())).frame, 0);
    // a tap on the title starts the highlighted mode
    await page.touchscreen.tap(422, 195); await until(page, () => SL.info().app === 'play');
    assert.equal((await page.evaluate(() => SL.runInfo())).mode, 'free');
    assert.ok((await page.evaluate(() => SL.view())).padsDrawn > 0, 'pads drawn in the side bands');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
  // the lobby route: ?from=lobby, Esc on the title goes back to index.html; without it Esc does nothing
  const a = await open({ query: 'from=lobby' });
  try {
    assert.equal(await a.page.evaluate(() => SL.fromLobby()), true);
    await Promise.all([a.page.waitForURL(/\/index\.html$/, WAIT), press(a.page, 'Escape', 10)]);
  } finally { await a.ctx.close(); }
  const b = await open();
  try {
    assert.equal(await b.page.evaluate(() => SL.fromLobby()), false);
    await press(b.page, 'Escape', 400);
    assert.match(b.page.url(), /stacklight\.html$/);
    assert.equal(await b.page.evaluate(() => SL.info().app), 'title');
    assert.deepEqual(b.problems, []);
  } finally { await b.ctx.close(); }
});
