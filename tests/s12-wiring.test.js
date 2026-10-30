// drives the real Starfall page in headless Chrome (Playwright, system Chrome) and pins the main.js
// wiring that the Node tests cannot reach. Each scenario runs in its own browser context, all at once, so the whole file
// takes well under a minute. Only window.SF hooks, the keyboard and three page-level spies (clock, audio, storage) are used.
// Mutants this file kills: verifier off, no claim, claim during the intro, SF.start(n)
// ranked, attract never starts, attract plays sound, results always to name entry, DAILY FLIGHT starts a free run,
// Shift advances the name slot, title-row cache removed, replay header not marking +dev, daily day taken at menu select.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { dailySeed } from '../engine/rng.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = process.env.W10_SHOT_DIR || null; // set to also save the name-entry screenshot
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const DAY1 = Date.UTC(2026, 9, 28, 12, 0, 0), D1 = '2026-10-28', D2 = '2026-10-29';

let server, browser, url;
const WAIT = { timeout: 30000 };

// page-level spies, installed before the game loads
const SPIES = `(() => {
  window.__now = null; window.__dateCalls = 0; window.__getCalls = 0; window.__audio = 0;
  const realNow = Date.now.bind(Date);
  Date.now = () => { window.__dateCalls++; return window.__now == null ? realNow() : window.__now; };
  const realGet = Storage.prototype.getItem;
  Storage.prototype.getItem = function (k) { window.__getCalls++; return realGet.call(this, k); };
  const AC = window.BaseAudioContext || window.AudioContext;
  for (const n of ['createOscillator', 'createBufferSource']) { const f = AC.prototype[n]; AC.prototype[n] = function () { window.__audio++; return f.apply(this, arguments); }; }
})();`;

async function open({ now = null, clock = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.addInitScript(SPIES);
  if (now != null) await page.addInitScript(`window.__now = ${now};`);
  if (clock) await page.clock.install();
  await page.goto(url + 'starfall.html');
  await page.waitForFunction(() => window.SF, null, WAIT);
  return { ctx, page, problems };
}
const evalSF = (page, fn, arg) => page.evaluate(fn, arg);
// past the coin-door intro and the first 20 title ticks (menu input is ignored before that)
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
// step the sim one frame at a time until the first play frame; returns what the claim looked like on the way
async function toPlay(page) {
  return page.evaluate(() => {
    const seen = { introRanked: [], introClaimed: [] };
    let n = 0;
    while (SF.state === 'intro' && n++ < 1000) {
      seen.introRanked.push(SF.ranked()); const ri = SF.runInfo(); seen.introClaimed.push(ri ? ri.claimed : null);
      SF.autoFire(1);
    }
    seen.state = SF.state; seen.ranked = SF.ranked();
    return seen;
  });
}
const finish = page => page.evaluate(() => { let n = 0; while (SF.state !== 'results' && n++ < 400) SF.autoFire(600); return { state: SF.state, score: SF.info().score }; });
// press a key every so often until the app reaches a state ('results' wants a second of ticks before it takes Fire)
async function pressUntil(page, key, want) {
  for (let i = 0; i < 60; i++) {
    if ((await page.evaluate(() => SF.state)) === want) return want;
    await page.keyboard.press(key); await page.waitForTimeout(150);
  }
  return page.evaluate(() => SF.state);
}
const noProblems = (p, name) => assert.deepEqual(p.problems, [], name + ': console and network are clean (favicon 404 aside)');

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

// ---------- scenarios ----------

// menu -> DAILY FLIGHT -> ranked claim -> name entry -> table -> second daily is practice
async function scenarioDailyFlow() {
  const { ctx, page, problems } = await open({ now: DAY1 });
  await toTitle(page);
  await menuPick(page, 1); // DAILY FLIGHT
  const r0 = await page.evaluate(() => SF.runInfo());
  assert.equal(r0.mode, 'daily', 'DAILY FLIGHT starts a daily run');
  assert.equal(r0.dayKey, D1);
  assert.equal(r0.seed, dailySeed(D1), "today's UTC seed");
  const seen = await toPlay(page);
  assert.ok(seen.introRanked.length > 0 && seen.introRanked.every(x => x === null), 'nothing is claimed during the intro: ' + JSON.stringify(seen.introRanked.slice(0, 3)));
  assert.ok(seen.introClaimed.every(x => x === false), 'run record unclaimed during the intro');
  assert.equal(seen.state, 'play');
  assert.equal(seen.ranked, true, 'the first play frame claims a ranked daily attempt');
  const f = await finish(page);
  assert.equal(f.state, 'results'); assert.ok(f.score > 0);
  assert.equal(await pressUntil(page, 'Enter', 'entry'), 'entry', 'a ranked finished run goes to name entry');
  // Shift alone does not move the slot, and Shift then B types B in slot 0
  await page.waitForTimeout(200);
  await page.keyboard.down('Shift'); await page.waitForTimeout(150);
  assert.deepEqual(await page.evaluate(() => SF.nameEntry()), { name: 'AAA', pos: 0 }, 'Shift alone');
  await page.keyboard.press('KeyB'); await page.waitForTimeout(150);
  assert.deepEqual(await page.evaluate(() => SF.nameEntry()), { name: 'BAA', pos: 1 }, 'Shift then B');
  await page.keyboard.up('Shift');
  if (SHOT_DIR) { fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, 'name-entry.png') }); }
  const res = await page.evaluate(() => SF.nameEntry('ABC'));
  assert.ok(res && res.id, 'an honest daily run is stored through the wired verifier: ' + JSON.stringify(await page.evaluate(() => SF.lastError())));
  const board = await page.evaluate(() => SF.scores('all'));
  assert.equal(board.length, 1); assert.equal(board[0].name, 'ABC');
  const today = await page.evaluate(d => SF.scores('daily', d), D1);
  assert.equal(today.length, 1, 'the daily run is on the day board');
  await page.waitForFunction(() => SF.state === 'title', null, WAIT);
  // the second daily of the same UTC day is practice and never reaches name entry
  await page.evaluate(() => SF.mode('daily'));
  await toPlay(page);
  assert.equal(await page.evaluate(() => SF.ranked()), false, 'second daily is practice');
  assert.equal((await finish(page)).state, 'results');
  assert.equal(await pressUntil(page, 'Enter', 'title'), 'title', 'a practice run skips name entry');
  noProblems({ problems }, 'daily flow');
  await ctx.close();
}

// the verifier is wired into the leaderboard the game really uses: a claim the clock rejects is refused by it
async function scenarioVerifierWired() {
  const { ctx, page, problems } = await open({ now: DAY1 });
  await toTitle(page);
  await menuPick(page, 1);
  await toPlay(page);
  await finish(page);
  assert.equal(await pressUntil(page, 'Enter', 'entry'), 'entry');
  await page.evaluate(ms => { window.__now = ms; }, DAY1 + 3 * 86400000); // three days later: outside the verifier's 1-day window
  const res = await page.evaluate(() => SF.nameEntry('EVL'));
  assert.equal(res, null, 'not saved');
  assert.equal(await page.evaluate(() => SF.lastError()), 'replay_mismatch', 'rejected by the verifier, not by the leaderboard day check');
  assert.equal((await page.evaluate(() => SF.scores('all'))).length, 0, 'nothing stored');
  noProblems({ problems }, 'verifier');
  await ctx.close();
}

// stage starts, seeded starts and test-hook runs are never ranked, never offered name entry, and say so in the replay header
async function scenarioPractice() {
  const { ctx, page, problems } = await open();
  await toTitle(page);
  await page.evaluate(() => SF.start(2));
  assert.equal((await toPlay(page)).ranked, null, 'SF.start(2): no run record');
  assert.equal((await finish(page)).state, 'results');
  assert.equal(await pressUntil(page, 'Enter', 'title'), 'title', 'stage start goes straight back to the title');
  await page.evaluate(() => SF.start(1, 123));
  assert.equal((await toPlay(page)).ranked, null, 'SF.start(1, seed): no run record');
  assert.equal(await page.evaluate(() => SF.seed()), 123);
  assert.equal((await finish(page)).state, 'results');
  assert.equal(await pressUntil(page, 'Enter', 'title'), 'title', 'seeded start goes straight back to the title');
  assert.equal((await page.evaluate(() => SF.scores('all'))).length, 0);
  // replay header: clean run says arcade, a test-hook run says arcade+dev
  await page.evaluate(() => SF.start(1));
  await toPlay(page);
  await page.evaluate(() => SF.autoFire(120));
  const clean = await page.evaluate(() => ({ r: SF.replay(), t: SF.info().tainted }));
  assert.equal(clean.t, false); assert.equal(clean.r.split('~')[4], 'arcade');
  await page.evaluate(() => SF.fill());
  const dev = await page.evaluate(() => ({ r: SF.replay(), t: SF.info().tainted }));
  assert.equal(dev.t, true); assert.equal(dev.r.split('~')[4], 'arcade+dev', 'a hooked run is marked +dev in its replay header');
  assert.equal((await finish(page)).state, 'results');
  assert.equal(await pressUntil(page, 'Enter', 'title'), 'title', 'a tainted run is never offered name entry');
  noProblems({ problems }, 'practice');
  await ctx.close();
}

// 30 s idle on the title starts attract mode, and attract mode is silent
async function scenarioAttract() {
  const { ctx, page, problems } = await open({ clock: true });
  await page.clock.runFor(1500);
  await toTitleClock(page);
  await page.keyboard.press('ArrowDown'); await page.clock.runFor(100); // a key press is the audio gesture and resets idle
  await page.keyboard.press('ArrowUp'); await page.clock.runFor(100);
  const audioAtTitle = await page.evaluate(() => window.__audio);
  assert.ok(audioAtTitle > 0, 'the audio spy sees menu sounds (so silence in attract means something): ' + audioAtTitle);
  await page.clock.runFor(29000);
  assert.equal(await page.evaluate(() => SF.state), 'title', 'still the title before 30 s');
  await page.clock.runFor(3000);
  assert.equal(await page.evaluate(() => SF.state), 'attract', 'attract starts after 30 s idle');
  await page.clock.runFor(1000);
  const a0 = await page.evaluate(() => ({ at: SF.attract(), audio: window.__audio }));
  assert.equal(a0.at.phase, 'play'); assert.equal(a0.at.kind, 'demo'); assert.match(a0.at.banner, /DEMO/);
  await page.clock.runFor(6000);
  const a1 = await page.evaluate(() => ({ at: SF.attract(), audio: window.__audio }));
  assert.ok(a1.at.frame > a0.at.frame + 100, `attract is playing: frame ${a0.at.frame} -> ${a1.at.frame}`);
  assert.equal(a1.audio, a0.audio, 'attract makes no sound');
  await page.keyboard.press('Space'); await page.clock.runFor(100);
  assert.equal(await page.evaluate(() => SF.state), 'title', 'any key leaves attract');
  await page.clock.runFor(1000);
  await page.keyboard.press('Enter'); await page.clock.runFor(100);
  assert.ok((await page.evaluate(() => window.__audio)) > a1.audio, 'the spy still hears real sounds afterwards');
  noProblems({ problems }, 'attract');
  await ctx.close();
}
async function toTitleClock(page) {
  await page.evaluate(() => SF.skip());
  await page.clock.runFor(1000);
  assert.equal(await page.evaluate(() => SF.state), 'title');
}

// the title rows read Date and storage about once a second, not every frame
async function scenarioTitleCache() {
  const { ctx, page, problems } = await open();
  await toTitle(page);
  for (const row of [1, 0]) {
    await page.keyboard.press(row === 1 ? 'ArrowDown' : 'ArrowUp'); await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => SF.info().menu), row);
    await page.evaluate(() => { window.__dateCalls = 0; window.__getCalls = 0; });
    await page.waitForTimeout(2000);
    const c = await page.evaluate(() => ({ d: window.__dateCalls, g: window.__getCalls }));
    assert.ok(c.d < 30, `row ${row}: Date.now called ${c.d} times in 2 s (once a second is the rule)`);
    assert.ok(c.g < 30, `row ${row}: storage read ${c.g} times in 2 s`);
  }
  noProblems({ problems }, 'title cache');
  await ctx.close();
}

// a daily run started just before midnight UTC ranks for the new day if its first play frame is after midnight
async function scenarioMidnight() {
  const before = Date.UTC(2026, 9, 28, 23, 59, 59), after = Date.UTC(2026, 9, 29, 0, 0, 1);
  const { ctx, page, problems } = await open({ now: before });
  await toTitle(page);
  await menuPick(page, 1);
  assert.equal((await page.evaluate(() => SF.runInfo())).dayKey, D1, 'chosen at 23:59:59');
  await page.evaluate(ms => { window.__now = ms; }, after);
  const seen = await toPlay(page);
  assert.equal(seen.state, 'play');
  const r = await page.evaluate(() => SF.runInfo());
  assert.equal(r.dayKey, D2, 'the day is the one on the first play frame');
  assert.equal(r.seed, dailySeed(D2), 'and so is the seed');
  assert.equal(r.ranked, true);
  assert.equal(await page.evaluate(() => SF.seed()), dailySeed(D2), 'the sim runs the new seed');
  await finish(page);
  assert.equal(await pressUntil(page, 'Enter', 'entry'), 'entry');
  const res = await page.evaluate(() => SF.nameEntry('MID'));
  assert.ok(res && res.id, 'verifier accepts it: ' + (await page.evaluate(() => SF.lastError())));
  assert.equal((await page.evaluate(d => SF.scores('daily', d), D2)).length, 1, 'ranks on the new day board');
  assert.equal((await page.evaluate(d => SF.scores('daily', d), D1)).length, 0, 'not on the old one');
  noProblems({ problems }, 'midnight');
  await ctx.close();
}

test('S12 wiring in a real browser', { concurrency: true, timeout: 120000 }, async t => {
  await Promise.all([
    t.test('daily flow: menu row, claim on first play frame (not intro), name entry, Shift, stored, practice second run', scenarioDailyFlow),
    t.test('verifier is wired into the game leaderboard', scenarioVerifierWired),
    t.test('stage/seed/test-hook runs are not ranked and not offered name entry; +dev header', scenarioPractice),
    t.test('attract starts after 30 s idle and is silent', scenarioAttract),
    t.test('title rows read Date and storage once a second', scenarioTitleCache),
    t.test('daily day and seed are taken on the first play frame', scenarioMidnight)
  ]);
});
