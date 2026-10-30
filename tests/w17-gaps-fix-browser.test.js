// w17 tests-only follow-up, LOW1: positive control for the G test in w17-main-gaps.test.js. In the same setup, the boss-kill
// sound IS accepted (fxTest returns true) and the flag it sets is effective: the same escaped boss that gets no bossDefeat
// after an earlier stage's mark DOES get exactly one when a bossDie is heard in its own stage.
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
let server, browser, url;

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

test('G control: the boss-kill mark is accepted, and a mark heard in the boss stage itself earns exactly one bossDefeat', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  const page = await ctx.newPage();
  try {
    await page.goto(url + 'starfall.html');
    await page.waitForFunction(() => window.SF, null, WAIT);
    await page.keyboard.press('KeyQ'); await page.waitForFunction(() => SF.audio().unlocked, null, WAIT);
    await page.evaluate(() => {
      const until = (cond, max) => { let f = 0; while (!cond() && f < max) { if (!SF.autoFireLoud(1, Math.sin(f / 150) * 0.9, false)) break; f++; } return cond(); };
      SF.god(); SF.start(4, 11);
      const marked = SF.fxTest('sfx', 'bossDie');
      const reached = until(() => SF.stage === 5 && SF.state === 'play', 6000);
      window.__r = { marked, reached }; return null; });
    // the engine drops a repeat of one sound within 20 ms of audio time, which barely moves inside one script
    await page.waitForTimeout(60);
    const res = await page.evaluate(() => {
      const until = (cond, max) => { let f = 0; while (!cond() && f < max) { if (!SF.autoFireLoud(1, Math.sin(f / 150) * 0.9, false)) break; f++; } return cond(); };
      const { marked, reached } = window.__r;
      // a bossDie heard in this stage's own fight (after the intro reset the flag), then the boss escapes
      const markedHere = SF.fxTest('sfx', 'bossDie');
      const j0 = SF.audioLast().jingles;
      const cleared = until(() => SF.state === 'clear', 9000);
      return { marked, markedHere, reached, cleared, jingles: SF.audioLast().jingles - j0 };
    });
    assert.equal(res.marked, true, 'the boss-kill sound was accepted in the STARLIGHT stage (the mark was set)');
    assert.equal(res.reached, true); assert.equal(res.cleared, true);
    assert.equal(res.markedHere, true);
    assert.equal(res.jingles, 1, 'a boss kill heard in its own stage earns one bossDefeat');
  } finally { await ctx.close(); }
});
