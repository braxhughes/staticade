// the cabinet hints against what the keys really do, through the real entry point (index.html, the lobby, Enter on the
// Starfall cabinet) in headless Chrome (Playwright, system Chrome); the hint text the real page's cabinet module draws under
// that browser's pointer (desktop and a touch phone); and SF.comet() through the real page, replayed in Node to show the
// page's hook forced a comet. Screenshots go to W40_SHOT_DIR when it is set.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticServer, WAIT } from './w25-helpers.mjs';
import { decode } from '../engine/replay.js';
import { createSim } from '../games/starfall/sim.js';
import { EV_FX, FX_COMET_TRAIL } from '../games/starfall/defs.js';

const SHOT_DIR = process.env.W40_SHOT_DIR || null;
let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

async function open(opts, file = 'index.html') {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.goto(web.url + file);
  if (file === 'index.html') {
    await page.waitForFunction(() => window.LOBBY && LOBBY.info().mode === 'lobby', null, WAIT);
    await page.evaluate(() => LOBBY.wordmarkSkip());
  }
  return { ctx, page, problems };
}
async function enterStarfall(page) {
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => LOBBY.info().mode === 'gone' && window.SF && SF.away() === false && SF.app() === 'cabinet', null, WAIT);
  await page.waitForTimeout(400); // the coin door, settled
}
const inLobby = page => page.waitForFunction(() => LOBBY.info().mode === 'lobby' && SF.away() === true, null, WAIT);
const onTitle = page => page.waitForFunction(() => SF.app() === 'title', null, WAIT);
const shot = async (page, name) => { if (!SHOT_DIR) return; fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') }); };
// the hint lines the page's own cabinet module draws on the coin door and during the dolly, under this browser's pointer
const pageHints = page => page.evaluate(async () => {
  const { createCabinet } = await import('/arcade/cabinet.js');
  const cab = createCabinet({ W: 400, H: 300, rnd: () => 0.5 });
  const lines = () => {
    const out = [], gfx = { reset() {}, clearCanvas() {}, count: () => 0, dot() {}, toViewport() {}, drawDots() {} };
    cab.render(gfx, { dotsToTexture() {}, quadCorner() {}, composite() {} }, s => out.push(s), 0, 120, false, () => {});
    return out;
  };
  for (let k = 0; k < 90; k++) cab.tick(false, false);
  const door = lines();
  cab.tick(true, false); for (let k = 0; k < 30; k++) cab.tick(false, false);
  return { door, dolly: lines(), coarse: matchMedia('(pointer: coarse)').matches };
});

test('desktop: each cabinet hint matches what the keys do on that screen', async () => {
  const { ctx, page, problems } = await open({ viewport: { width: 1000, height: 750 } });
  try {
    const h = await pageHints(page);
    assert.equal(h.coarse, false);
    assert.deepEqual(h.door, ['FIRE / CLICK: INSERT COIN   ESC: LOBBY']);
    assert.deepEqual(h.dolly, ['FIRE: SKIP   ESC: LOBBY']);

    // coin door, ESC: LOBBY
    await enterStarfall(page);
    await shot(page, 'coin-door-1000x750');
    await page.keyboard.press('Escape');
    await inLobby(page);
    // dolly (FIRE drops the coin and the camera moves), ESC: LOBBY
    await enterStarfall(page);
    await page.keyboard.press('Space');
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => SF.app()), 'cabinet', 'FIRE on the coin door starts the dolly, it does not skip');
    await page.keyboard.press('Escape');
    await inLobby(page);
    // dolly, FIRE: SKIP to the title
    await enterStarfall(page);
    await page.keyboard.press('Space');
    await page.waitForTimeout(500);
    await page.keyboard.press('Space');
    await onTitle(page);
    await page.keyboard.press('Escape'); // the title main menu goes back to the lobby too
    await inLobby(page);
    // dolly, CLICK: SKIP to the title; Backspace counts as Esc
    await enterStarfall(page);
    await page.mouse.click(500, 375);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => SF.app()), 'cabinet', 'a click on the coin door starts the dolly');
    if (SHOT_DIR) { await page.evaluate(() => SF.introAt(2)); await page.waitForTimeout(300); await shot(page, 'dolly-1000x750'); await page.evaluate(() => SF.release()); }
    await page.mouse.click(500, 375);
    await onTitle(page);
    await page.keyboard.press('Backspace');
    await inLobby(page);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('touch phone 390x844: the hints show the tap, and the tap does what they say', async () => {
  const { ctx, page, problems } = await open({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  try {
    const h = await pageHints(page);
    assert.equal(h.coarse, true);
    assert.deepEqual(h.door, ['TAP: INSERT COIN']);
    assert.deepEqual(h.dolly, ['TAP: SKIP']);
    await enterStarfall(page);
    await shot(page, 'coin-door-390x844-touch');
    await page.touchscreen.tap(195, 422);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => SF.app()), 'cabinet', 'a tap on the coin door starts the dolly');
    if (SHOT_DIR) { await page.evaluate(() => SF.introAt(2)); await page.waitForTimeout(300); await shot(page, 'dolly-390x844-touch'); await page.evaluate(() => SF.release()); }
    await page.touchscreen.tap(195, 422);
    await onTitle(page);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('narrow desktop 390x844 (the longest hints at phone width): Esc still leaves from the dolly', async () => {
  const { ctx, page, problems } = await open({ viewport: { width: 390, height: 844 } });
  try {
    await enterStarfall(page);
    await shot(page, 'coin-door-390x844');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    if (SHOT_DIR) { await page.evaluate(() => SF.introAt(2)); await page.waitForTimeout(300); await shot(page, 'dolly-390x844'); await page.evaluate(() => SF.release()); }
    await page.keyboard.press('Escape');
    await inLobby(page);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('SF.comet() through the real page forces a comet (replayed in Node with the same hook call)', async () => {
  const { ctx, page, problems } = await open({ viewport: { width: 1000, height: 750 } }, 'starfall.html');
  try {
    await page.waitForFunction(() => window.SF && typeof SF.comet === 'function', null, WAIT);
    // one synchronous evaluate: no animation frame can step the run between these calls
    const r = await page.evaluate(() => {
      SF.start(1, 4040);
      let n = 0; while (SF.state !== 'play' && n++ < 2000) SF.autoFire(1);
      const at = SF.info().frames, before = SF.info().tainted;
      SF.comet();
      SF.autoFire(120);
      return { at, before, after: SF.info().tainted, hash: SF.hash(), replay: SF.replay() };
    });
    assert.equal(r.before, false);
    assert.equal(r.after, true);
    const rp = decode(r.replay);
    assert.equal(rp.seed, 4040);
    const replay = hook => {
      const sim = createSim({ seed: rp.seed, mode: 'arcade' });
      let trails = 0;
      const count = (b, o) => { if (b[o] === EV_FX && b[o + 1] === FX_COMET_TRAIL) trails++; };
      for (let i = 0; i < rp.words.length; i++) {
        if (hook && sim.frame === r.at && i === r.at) sim.comet();
        sim.step(rp.words[i]); sim.drain(count);
      }
      return { trails, hash: sim.stateHash() };
    };
    const withHook = replay(true), without = replay(false);
    assert.equal(withHook.hash, r.hash, 'the page run is the sim run with comet() called at frame ' + r.at);
    assert.ok(withHook.trails > 30, 'comet trail events: ' + withHook.trails);
    assert.equal(without.trails, 0);
    assert.notEqual(without.hash, r.hash);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});
