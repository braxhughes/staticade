// w13-tests (S12 guard review LOW2): the five main.js wiring mutants that survived w10-s12-guard.
//   idle timer not reset by input (main.js updTitle), "PRACTICE: NOT RANKED" label removed (runLabel), last name not stored
//   (confirmEntry kv.set), claim before the stale check (afterStep), runInfo().claimed forced false.
// Same harness as tests/s12-wiring.test.js (own server, headless Chrome, own context per scenario, all at once). New file only.
// The label is a dot-matrix text drawn to WebGL, so the page is given a wrapped engine/font.js (served by a route, nothing on
// disk changes) that records every string passed to text(); the test reads that record.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const DAY1 = Date.UTC(2026, 9, 28, 12, 0, 0), DAY2 = Date.UTC(2026, 9, 29, 12, 0, 0);
const WAIT = { timeout: 30000 };
let server, browser, url;

const INIT = ms => `(() => { window.__now = ${ms}; const realNow = Date.now.bind(Date); Date.now = () => window.__now == null ? realNow() : window.__now; window.__texts = new Set(); })();`;
const FONT_SRC = fs.readFileSync(path.join(ROOT, 'engine/font.js'), 'utf8');
const TAP = 'return function text(str, x, y, col, sc, align, a, wave) {';
assert.ok(FONT_SRC.includes(TAP), 'engine/font.js still has the text() entry the recorder wraps');
const FONT_TAPPED = FONT_SRC.replace(TAP, TAP + ' if (window.__texts) window.__texts.add(str);');

async function newPage(ctx, ms, clock = false) {
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.addInitScript(INIT(ms));
  if (clock) await page.clock.install();
  await page.goto(url + 'starfall.html');
  await page.waitForFunction(() => window.SF, null, WAIT);
  return { page, problems };
}
async function open(ms, clock = false) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  await ctx.route('**/engine/font.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: FONT_TAPPED }));
  return { ctx, ...(await newPage(ctx, ms, clock)) };
}
async function toTitle(page) {
  await page.evaluate(() => SF.skip());
  await page.waitForFunction(() => SF.state === 'title', null, WAIT);
  await page.waitForTimeout(500);
}
async function menuPick(page, row) {
  for (let i = 0; i < row; i++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(40); }
  await page.waitForFunction(r => SF.info().menu === r, row, WAIT);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => SF.state !== 'title', null, WAIT);
}
const toPlay = page => page.evaluate(() => { let n = 0; while (SF.state === 'intro' && n++ < 1000) SF.autoFire(1); return SF.state; });
const finish = page => page.evaluate(() => { let n = 0; while (SF.state !== 'results' && n++ < 400) SF.autoFire(600); return SF.state; });
async function pressUntil(page, key, want) {
  for (let i = 0; i < 60; i++) {
    if ((await page.evaluate(() => SF.state)) === want) return want;
    await page.keyboard.press(key); await page.waitForTimeout(150);
  }
  return page.evaluate(() => SF.state);
}
// the strings drawn over the next ~200 ms
async function drawn(page) {
  await page.evaluate(() => window.__texts.clear());
  await page.waitForTimeout(250);
  return page.evaluate(() => [...window.__texts]);
}

test.before(async () => {
  server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(p).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });

// input on the title resets the idle timer (read through SF.idle(); the 30 s attract start itself is in s12-wiring)
async function scenarioIdle() {
  const { ctx, page, problems } = await open(DAY1, true);
  await page.clock.runFor(1500);
  await page.evaluate(() => SF.skip()); await page.clock.runFor(1000);
  assert.equal(await page.evaluate(() => SF.state), 'title');
  await page.keyboard.press('ArrowDown'); await page.clock.runFor(100); // audio gesture; starts the count
  await page.clock.runFor(4000);
  const before = await page.evaluate(() => SF.idle());
  assert.ok(before > 200, 'idle timer is counting after 4 s of nothing: ' + before);
  await page.keyboard.press('ArrowUp'); await page.clock.runFor(100);
  const after = await page.evaluate(() => SF.idle());
  assert.ok(after < 30, `a key press resets the idle timer (${before} -> ${after})`);
  await page.clock.runFor(1000);
  const later = await page.evaluate(() => SF.idle());
  assert.ok(later > after && later < 100, 'and it counts again from there: ' + later);
  assert.deepEqual(problems, []);
  await ctx.close();
}

// practice label on the results screen, last name remembered across a reload
async function scenarioLabelAndName() {
  const { ctx, page, problems } = await open(DAY1);
  await toTitle(page);
  await menuPick(page, 1);
  assert.equal(await toPlay(page), 'play');
  const ri = await page.evaluate(() => SF.runInfo());
  assert.equal(ri.claimed, true, 'runInfo reports the claim after the first play frame'); assert.equal(ri.ranked, true);
  assert.equal(await finish(page), 'results');
  const ranked = await drawn(page);
  assert.ok(ranked.includes('DAILY FLIGHT'), 'ranked run: DAILY FLIGHT label: ' + ranked.join('|'));
  assert.ok(!ranked.includes('PRACTICE: NOT RANKED') && !ranked.includes('PRACTICE'), 'ranked run: no practice label');
  assert.equal(await pressUntil(page, 'Enter', 'entry'), 'entry');
  assert.deepEqual(await page.evaluate(() => SF.nameEntry()), { name: 'AAA', pos: 0 }, 'first time: the default name');
  const res = await page.evaluate(() => SF.nameEntry('QZX'));
  assert.ok(res && res.id, 'saved');
  await page.waitForFunction(() => SF.state === 'title', null, WAIT);
  assert.equal(await page.evaluate(() => localStorage.getItem('starfall.name')), 'QZX', 'the name is stored');
  // the second daily of the day is practice, and says so on its results screen
  await page.evaluate(() => SF.mode('daily'));
  assert.equal(await toPlay(page), 'play');
  assert.equal(await page.evaluate(() => SF.ranked()), false);
  assert.equal(await finish(page), 'results');
  const practice = await drawn(page);
  assert.ok(practice.includes('PRACTICE: NOT RANKED'), 'practice results screen says PRACTICE: NOT RANKED: ' + practice.join('|'));
  assert.ok(practice.includes('PRACTICE'), 'and the corner label says PRACTICE');
  // a new page in the same browser context, next UTC day: the entry screen starts on the last name
  const p2 = await newPage(ctx, DAY2);
  await toTitle(p2.page);
  await menuPick(p2.page, 1);
  await toPlay(p2.page);
  assert.equal(await p2.page.evaluate(() => SF.ranked()), true, 'a new day is a new ranked attempt');
  assert.equal(await finish(p2.page), 'results');
  assert.equal(await pressUntil(p2.page, 'Enter', 'entry'), 'entry');
  assert.deepEqual(await p2.page.evaluate(() => SF.nameEntry()), { name: 'QZX', pos: 0 }, 'the entry screen offers the last name');
  assert.deepEqual([...problems, ...p2.problems], []);
  await ctx.close();
}

// a daily run started before midnight and first played after it: the attempt is claimed for the new day only
async function scenarioClaimAfterStale() {
  const before = Date.UTC(2026, 9, 28, 23, 59, 59), after = Date.UTC(2026, 9, 29, 0, 0, 1);
  const { ctx, page, problems } = await open(before);
  await toTitle(page);
  await menuPick(page, 1);
  assert.equal((await page.evaluate(() => SF.runInfo())).dayKey, '2026-10-28');
  assert.equal(await page.evaluate(() => localStorage.getItem('starfall.daily-attempt:2026-10-28')), null, 'nothing claimed yet');
  await page.evaluate(ms => { window.__now = ms; }, after);
  assert.equal(await toPlay(page), 'play');
  const r = await page.evaluate(() => SF.runInfo());
  assert.equal(r.dayKey, '2026-10-29'); assert.equal(r.claimed, true); assert.equal(r.ranked, true);
  assert.equal(await page.evaluate(() => localStorage.getItem('starfall.daily-attempt:2026-10-28')), null, 'the stale day was never claimed (stale check runs before the claim)');
  assert.equal(await page.evaluate(() => localStorage.getItem('starfall.daily-attempt:2026-10-29')), '1', 'the new day holds the one attempt');
  assert.deepEqual(problems, []);
  await ctx.close();
}

test('S12 guard gaps in a real browser', { concurrency: true, timeout: 120000 }, async t => {
  await Promise.all([
    t.test('input resets the idle timer', scenarioIdle),
    t.test('practice label on results; last name remembered; runInfo claimed', scenarioLabelAndName),
    t.test('claim happens after the stale check', scenarioClaimAfterStale)
  ]);
});
