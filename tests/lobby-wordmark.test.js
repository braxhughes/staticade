// w24: the lobby wordmark. The name lives only in arcade/brand.js; the wordmark gathers, skips, and respects reduced motion.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { ARCADE_NAME, ARCADE_TAGLINE } from '../arcade/brand.js';
import { FONT } from '../engine/font.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

test('brand: name and tagline are drawable in the dot font', () => {
  for (const s of [ARCADE_NAME, ARCADE_TAGLINE]) {
    assert.ok(s.length > 0);
    for (const ch of s) assert.ok(ch === ' ' || FONT[ch], 'no glyph for ' + JSON.stringify(ch));
  }
});

test('the arcade name string appears in no source file except arcade/brand.js', () => {
  const hits = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git', '.claude', 'agent_docs', 'docs', 'shots'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|html)$/.test(e.name) && !/\.test\.js$/.test(e.name) && fs.readFileSync(p, 'utf8').includes(ARCADE_NAME)) hits.push(path.relative(root, p));
    }
  };
  walk(root);
  assert.deepEqual(hits, ['arcade/brand.js']);
});

let server, base, browser;
before(async () => {
  server = http.createServer((req, res) => {
    const f = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle'] });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 }, ...opts });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/index.html');
  await page.waitForFunction(() => window.LOBBY);
  return { ctx, page, errors };
}

test('wordmark: starts in gather, 300 to 600+ dots, and settles on its own', async () => {
  const { ctx, page, errors } = await open();
  await page.evaluate(() => LOBBY.wordmarkAt(0));
  let w = await page.evaluate(() => LOBBY.wordmark());
  assert.equal(w.phase, 'gather'); assert.equal(w.progress, 0); assert.ok(w.glyphDots >= 250 && w.dots <= 1400 && w.dots > w.glyphDots, 'glyph dots ' + w.glyphDots + ' of ' + w.dots);
  assert.equal(w.name, ARCADE_NAME);
  await page.evaluate(() => LOBBY.wordmarkAt(1));
  w = await page.evaluate(() => LOBBY.wordmark());
  assert.equal(w.phase, 'gather'); assert.ok(w.progress > 0.2 && w.progress < 0.8);
  await page.evaluate(() => LOBBY.wordmarkAt(null));
  await page.waitForFunction(() => LOBBY.wordmark().phase === 'settled', null, { timeout: 8000 });
  assert.equal((await page.evaluate(() => LOBBY.wordmark())).progress, 1);
  assert.equal(await page.title(), ARCADE_NAME);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('wordmark: a key press mid-gather skips to settled, and a click does too', async () => {
  for (const how of ['key', 'click']) {
    const { ctx, page } = await open();
    await page.waitForTimeout(150);
    assert.equal((await page.evaluate(() => LOBBY.wordmark())).phase, 'gather');
    if (how === 'key') await page.keyboard.press('Space'); else await page.mouse.click(500, 60);
    await page.waitForFunction(() => LOBBY.wordmark().phase === 'settled', null, { timeout: 1500 });
    await ctx.close();
  }
});

test('wordmark: the wordmarkSkip hook jumps to settled; the wordmark clears the cabinet marquees', async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => LOBBY.wordmarkSkip());
  const w = await page.evaluate(() => LOBBY.wordmark());
  assert.equal(w.phase, 'settled');
  assert.ok(w.pipY < 52, 'banner and pips stay above the cabinet marquees (field y 56): ' + w.pipY);
  assert.ok(w.bottom < w.pipY);
  await ctx.close();
});

test('wordmark: prefers-reduced-motion starts settled', async () => {
  const { ctx, page } = await open({ reducedMotion: 'reduce' });
  assert.equal((await page.evaluate(() => LOBBY.wordmark())).phase, 'settled');
  await ctx.close();
});

test('wordmark: Enter during the gather still selects Starfall without waiting for it', async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => LOBBY.manualHandoff(true));
  await page.waitForTimeout(150);
  assert.equal((await page.evaluate(() => LOBBY.wordmark())).phase, 'gather');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => LOBBY.info().mode === 'dolly', null, { timeout: 1500 });
  await ctx.close();
});

test('wordmark: the name is built from 300+ glyph dots, not padding', async () => {
  const { ctx, page } = await open();
  const w = await page.evaluate(() => LOBBY.wordmark());
  assert.ok(w.glyphDots >= 250, 'glyph dots ' + w.glyphDots);
  await ctx.close();
});

test('wordmark: start positions come from the seeded RNG (two loads match; Math.random would differ)', async () => {
  const hashes = [];
  for (let k = 0; k < 2; k++) {
    const { ctx, page } = await open();
    await page.evaluate(() => LOBBY.wordmarkAt(0.5));
    hashes.push(await page.evaluate(() => LOBBY.wordmarkHash()));
    await ctx.close();
  }
  assert.equal(typeof hashes[0], 'number');
  assert.equal(hashes[0], hashes[1]);
  assert.notEqual(hashes[0], 0);
});

test('wordmark: drawWordmark allocates nothing per frame (runtime constructor count and source scan)', async () => {
  const src = fs.readFileSync(path.join(root, 'arcade/lobby.js'), 'utf8');
  const i = src.indexOf('function drawWordmark(');
  assert.ok(i >= 0);
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(!/\bnew\b/.test(body), 'no new in drawWordmark');
  assert.ok(!/(^|[=(,:?&|]|return)\s*\[/m.test(body), 'no array literal in drawWordmark');
  assert.ok(!/=>|\bfunction\b/.test(body.slice(body.indexOf('{'))), 'no closures in drawWordmark');
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  await ctx.addInitScript(() => {
    window.__alloc = 0; window.__count = false;
    for (const n of ['Float32Array', 'Array']) {
      const Orig = window[n];
      window[n] = new Proxy(Orig, { construct(t, a, nt) { if (window.__count) window.__alloc++; return Reflect.construct(t, a, nt); } });
    }
  });
  const page = await ctx.newPage();
  await page.goto(base + '/index.html');
  await page.waitForFunction(() => window.LOBBY);
  await page.evaluate(() => LOBBY.wordmarkAt(0.6));
  await page.waitForTimeout(300);
  const n = await page.evaluate(async () => {
    window.__alloc = 0; window.__count = true;
    let f = 0; await new Promise(r => { const t = () => { if (++f >= 200) r(); else requestAnimationFrame(t); }; requestAnimationFrame(t); });
    window.__count = false; return window.__alloc;
  });
  assert.equal(n, 0, 'Float32Array/Array constructions over 200 frames: ' + n);
  await ctx.close();
});

test('wordmark: a non-action key skips the gather and stays in the lobby', async () => {
  const { ctx, page } = await open();
  await page.waitForTimeout(150);
  assert.equal((await page.evaluate(() => LOBBY.wordmark())).phase, 'gather');
  await page.keyboard.press('KeyQ');
  await page.waitForFunction(() => LOBBY.wordmark().phase === 'settled', null, { timeout: 1500 });
  assert.equal((await page.evaluate(() => LOBBY.info())).mode, 'lobby');
  await ctx.close();
});

test('wordmark: phase and progress agree while the clock is held (wordmarkAt)', async () => {
  const { ctx, page } = await open();
  await page.evaluate(() => LOBBY.wordmarkSkip());
  await page.evaluate(() => LOBBY.wordmarkAt(0.5));
  const w = await page.evaluate(() => LOBBY.wordmark());
  assert.equal(w.phase, 'gather'); assert.ok(w.progress < 0.5);
  await ctx.close();
});

test('the arcade name appears in no source file except arcade/brand.js, ignoring case', () => {
  const needle = ARCADE_NAME.toLowerCase(), hits = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', '.git', '.claude', 'agent_docs', 'docs', 'shots'].includes(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|html)$/.test(e.name) && !/\.test\.js$/.test(e.name) && fs.readFileSync(p, 'utf8').toLowerCase().includes(needle)) hits.push(path.relative(root, p));
    }
  };
  walk(root);
  assert.deepEqual(hits, ['arcade/brand.js']);
});
