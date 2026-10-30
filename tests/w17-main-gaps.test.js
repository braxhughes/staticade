// w17 tests-only slice, group 2 (main.js half): S13a review survivors G, L, T and V, driven through the real starfall.html
// in headless Chrome. The page's sfx.js is served with a few extra lines appended (by this test, in memory: the file on
// disk is untouched) that log the NAME of every sound the engine actually starts, so the tests can see which sound was
// chosen, not just the last one (SF.audioLast() only keeps the latest).
//   V  the cabinet coin toss plays 'toss' and the drop plays 'clunk' (a swap of the two is seen)
//   T  the last hit on a boss still sounds as a boss hit ('bossHit'): the boss flag is read BEFORE the step
//   L  the music stops while the boss blows up (state 'bossOut'), it does not keep the boss track
//   G  a boss kill in one stage does not make the next stage's boss "killed": the flag resets on each stage intro
// The page's engine/audio.js is also served with its two sound-dropping guards (same sound within 20 ms, more than 90
// live voices) cut out, in memory, so a fast-forwarded run logs every sound the game chose; the replace throws if the
// guards are not found, so the test cannot silently drift. For T/L the sim is deterministic (fixed seed, still god-mode
// ship): a first pass finds the frame the boss dies on, a second pass fast-forwards quietly to 40 frames before it.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const WAIT = { timeout: 30000 };
const LOGGER = `
;(() => { const log = (window.__sfxLog = window.__sfxLog || []); for (const k of Object.keys(SFX)) { const f = SFX[k]; SFX[k] = function () { log.push(k); return f.apply(this, arguments); }; } })();
`;
let server, browser, url;

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  await ctx.route('**/engine/audio.js', route => {
    let src = fs.readFileSync(path.join(ROOT, 'engine/audio.js'), 'utf8');
    const guards = ["if (now - (lastSfx[name] || -1) < 0.02) return false;", "if (activeVoices > 90) return false;"];
    for (const g of guards) { if (!src.includes(g)) throw new Error('engine guard not found: ' + g); src = src.replace(g, ''); }
    route.fulfill({ status: 200, contentType: 'text/javascript', body: src });
  });
  await ctx.route('**/games/starfall/sfx.js', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(path.join(ROOT, 'games/starfall/sfx.js'), 'utf8') + LOGGER }));
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.goto(url + 'starfall.html');
  await page.waitForFunction(() => window.SF, null, WAIT);
  return { ctx, page, problems };
}
async function unlock(page) { await page.keyboard.press('KeyQ'); await page.waitForFunction(() => SF.audio().unlocked, null, WAIT); }

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

test('V: the cabinet plays toss on the coin toss and clunk when the coin drops (not swapped)', async () => {
  const { ctx, page, problems } = await open();
  try {
    await page.keyboard.press('Space');  // fire as the first key: unlocks the audio and tosses the coin (any other key would skip the intro)
    await page.waitForFunction(() => window.__sfxLog.includes('clunk'), null, WAIT);
    const names = (await page.evaluate(() => window.__sfxLog)).filter(n => n === 'toss' || n === 'clunk');
    assert.deepEqual(names.slice(0, 2), ['toss', 'clunk'], 'toss first, then clunk: ' + names.join(','));
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

// the frames of the stage 5 boss fight, one at a time near the end (see the header)
async function bossEnd() {
  const { ctx, page, problems } = await open();
  try {
    await unlock(page);
    // pass 1 (quiet): how many frames until the boss dies
    const K = await page.evaluate(() => {
      SF.god(); SF.start(5, 123); SF.breakPanels(8);
      let k = 0; while (SF.info().boss && k < 8000) { SF.autoFire(1); k++; }
      return k;
    });
    assert.ok(K > 100 && K < 8000, 'boss died after ' + K + ' frames');
    // pass 2: the same run again; loud for the last 40 frames
    await page.evaluate(k => { SF.god(); SF.start(5, 123); SF.breakPanels(8); for (let i = 0; i < k - 40; i++) SF.autoFire(1); window.__sfxLog.length = 0; }, K);
    const frames = await page.evaluate(() => {
      const out = [];
      for (let i = 0; i < 70; i++) {
        SF.autoFireLoud(1, 0, true);
        out.push({ log: window.__sfxLog.splice(0), boss: SF.info().boss, state: SF.state, track: SF.audio().track });
      }
      return out;
    });
    return { frames, problems };
  } finally { await ctx.close(); }
}
let BOSS = null;
test('T: the killing blow on a boss sounds as a boss hit (bossHit, then bossDie), not as a plain hit', async () => {
  BOSS = await bossEnd();
  const flat = BOSS.frames.flatMap(f => f.log);
  const die = flat.indexOf('bossDie');
  assert.ok(die > 0, 'bossDie played: ' + flat.join(','));
  const hits = flat.slice(0, die).filter(n => n === 'hit' || n === 'bossHit');
  assert.ok(hits.length >= 1, 'core hits before the kill');
  assert.equal(hits[hits.length - 1], 'bossHit', 'the last hit before bossDie is a boss hit: ' + hits.join(','));
  assert.ok(!flat.slice(0, die).includes('hit'), 'no plain hit sound during the boss fight');
  // the killing frame itself: bossHit and bossDie come from the same frame
  const killFrame = BOSS.frames.find(f => f.log.includes('bossDie'));
  assert.ok(killFrame.log.includes('bossHit'), 'the kill frame carries the bossHit: ' + killFrame.log.join(','));
  assert.deepEqual(BOSS.problems, []);
});
test('L: while the boss blows up (bossOut) no music plays; it does not keep the boss track', async () => {
  BOSS = BOSS || await bossEnd();
  const out = BOSS.frames.filter(f => f.state === 'bossOut');
  assert.ok(out.length >= 2, 'bossOut frames seen: ' + out.length);
  for (const f of out) assert.equal(f.track, null, 'no track during bossOut');
  const before = BOSS.frames.filter(f => f.state === 'play');
  assert.ok(before.length > 5 && before.every(f => f.track === 'boss1'), 'boss1 played during the fight: ' + before.map(f => f.track).slice(-3));
});

test('G: a boss killed in one stage does not give the next boss that was only escaped a bossDefeat (flag resets on intro)', async () => {
  const { ctx, page, problems } = await open();
  try {
    await unlock(page);
    const res = await page.evaluate(() => {
      const until = (cond, max, fire) => { let f = 0; while (!cond() && f < max) { if (!SF.autoFireLoud(1, Math.sin(f / 150) * 0.9, fire)) break; f++; } return cond(); };
      SF.god(); SF.start(4, 11);
      // a boss kill was heard in the last stage (its bossDie sets the flag; here played by hand on the STARLIGHT stage 4)
      const marked = SF.fxTest('sfx', 'bossDie');
      const reached = until(() => SF.stage === 5 && SF.state === 'play', 6000, false);   // STARLIGHT runs out by itself; stage 5's intro follows
      const j0 = SF.audioLast().jingles;
      const cleared = until(() => SF.state === 'clear', 9000, false);                    // no shots: the boss escapes at the timeout
      return { marked, reached, cleared, jingles: SF.audioLast().jingles - j0, stage: SF.stage, track: SF.audio().track };
    });
    assert.equal(res.reached, true, 'reached stage 5'); assert.equal(res.cleared, true, 'the boss escaped and the stage cleared');
    assert.equal(res.jingles, 0, 'an escaped boss gets no bossDefeat, even though an earlier stage marked a boss kill');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});
