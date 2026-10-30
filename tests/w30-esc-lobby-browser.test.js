// Esc and Backspace take you back to the arcade lobby. Through the real entry point: index.html in headless Chrome
// (Playwright, system Chrome), Enter on the Starfall cabinet, then the keys. Counts rAF loops, window/document/canvas
// listeners and audio contexts / playing sources across round trips. Screenshots go to W30_SHOT_DIR when it is set.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { staticServer, WAIT, ROOT } from './w25-helpers.mjs';

const SHOT_DIR = process.env.W30_SHOT_DIR || null;
let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

// counters installed before any page script runs
const COUNTERS = `(() => {
  const pend = new Set(), raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => { const id = raf(t => { pend.delete(id); cb(t); }); pend.add(id); return id; };
  window.cancelAnimationFrame = id => { pend.delete(id); caf(id); };
  window.__loops = () => pend.size;
  const reg = new Map(); // target -> Set of 'type|capture|fnId'
  let fid = 0; const ids = new WeakMap();
  const idOf = f => { if (!ids.has(f)) ids.set(f, ++fid); return ids.get(f); };
  const tracked = t => t === window || t === document || (t && t.tagName === 'CANVAS');
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
  const key = (t, type, f, o) => type + '|' + (typeof o === 'boolean' ? o : !!(o && o.capture)) + '|' + (typeof f === 'function' ? idOf(f) : f && idOf(f));
  EventTarget.prototype.addEventListener = function (type, f, o) {
    if (tracked(this) && f) { if (!reg.has(this)) reg.set(this, new Set()); reg.get(this).add(key(this, type, f, o)); }
    return add.call(this, type, f, o);
  };
  EventTarget.prototype.removeEventListener = function (type, f, o) {
    if (tracked(this) && f && reg.has(this)) reg.get(this).delete(key(this, type, f, o));
    return rem.call(this, type, f, o);
  };
  window.__listeners = () => { let n = 0; const by = {}; for (const [t, s] of reg) for (const k of s) { n++; const ty = k.split('|')[0]; by[ty] = (by[ty] || 0) + 1; } return { n, by }; };
  // audio: contexts made, and sources started but not yet ended
  const ctxs = []; window.__ctxs = ctxs;
  const AC = window.AudioContext;
  window.AudioContext = class extends AC { constructor(...a) { super(...a); ctxs.push(this); } };
  const live = new Set();
  const st = AudioScheduledSourceNode.prototype.start;
  AudioScheduledSourceNode.prototype.start = function (...a) { live.add(this); this.addEventListener('ended', () => { live.delete(this); }); return st.apply(this, a); };
  window.__audio = () => { let active = 0; for (const n of live) if (n.context.state === 'running') active++; return { contexts: ctxs.length, running: ctxs.filter(c => c.state === 'running').length, active }; };
})();`;

async function openLobby() {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  await page.addInitScript(COUNTERS);
  await page.goto(web.url + 'index.html');
  await page.waitForFunction(() => window.LOBBY && LOBBY.info().mode === 'lobby', null, WAIT);
  await page.evaluate(() => LOBBY.wordmarkSkip());
  return { ctx, page, problems };
}
const mode = page => page.evaluate(() => LOBBY.info().mode);
async function enterStarfall(page) {
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => LOBBY.info().mode === 'gone' && window.SF && SF.away() === false, null, WAIT);
}
async function toTitle(page) {
  await page.evaluate(() => SF.skip());
  await page.waitForFunction(() => SF.app() === 'title', null, WAIT);
  await page.waitForTimeout(450); // the title takes keys after 20 frames, and a little more for the listeners to settle
}
const inLobby = page => page.waitForFunction(() => LOBBY.info().mode === 'lobby' && SF.away() === true, null, WAIT);
// the most sources playing on a running context over about a second (music notes are scheduled a little ahead, so one sample is noisy)
const peakSources = page => page.evaluate(async () => { let m = 0; for (let i = 0; i < 12; i++) { m = Math.max(m, __audio().active); await new Promise(r => setTimeout(r, 90)); } return m; });
const snap = page => page.evaluate(() => ({ loops: __loops(), l: __listeners(), a: __audio(), sf: window.SF ? SF.audio() : null, lob: LOBBY.info().music }));
const shot = async (page, name) => { if (!SHOT_DIR) return; fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.waitForTimeout(300); await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') }); };
// run a free/daily run until the first play frame (claimed) by stepping the sim with the test hook
async function intoRun(page, m) {
  await page.evaluate(x => SF.mode(x), m);
  await page.evaluate(() => { let n = 0; while (SF.state === 'intro' && n++ < 1000) SF.autoFire(1); });
}

describe('w30 Esc and Backspace go back to the lobby', () => {
  test('lobby -> Starfall -> Esc -> lobby five times: one loop, no doubled listeners, one live audio engine each', { timeout: 240000 }, async () => {
    const { ctx, page, problems } = await openLobby();
    try {
      const lobbyOnly = await snap(page);
      assert.equal(lobbyOnly.loops, 1, 'the lobby alone: one rAF loop');
      const trips = [];
      for (let i = 0; i < 5; i++) {
        await enterStarfall(page);
        await toTitle(page);
        const inGame = await snap(page);
        assert.equal(inGame.loops, 1, `trip ${i + 1}: in Starfall one loop`);
        assert.equal(await page.evaluate(() => SF.app()), 'title');
        await page.keyboard.press(i % 2 ? 'Backspace' : 'Escape');
        await inLobby(page);
        await page.waitForTimeout(500);
        await page.waitForFunction(() => __audio().running === 1, null, WAIT).catch(async e => { throw new Error(e.message + JSON.stringify(await page.evaluate(() => ({ s: __ctxs.map(c => c.state), a: SF.audio() })))); }); // suspend() is asynchronous
        const back = await snap(page); back.peak = await peakSources(page);
        assert.equal(back.loops, 1, `trip ${i + 1}: back in the lobby one loop`);
        assert.equal(back.sf.track, null, `trip ${i + 1}: Starfall music stopped`);
        assert.equal(back.lob, true, `trip ${i + 1}: lobby music flag on`);
        assert.ok(back.a.contexts <= 2, `at most the lobby's and Starfall's audio contexts (${back.a.contexts})`);
        assert.equal(back.a.running, 1, `trip ${i + 1}: only the lobby's audio runs (Starfall's is suspended)`);
        trips.push({ inGame, back });
        if (i === 1) await shot(page, 'lobby-after-return');
      }
      for (const t of trips) {
        assert.deepEqual(t.back.l, trips[0].back.l, 'same listener count and kinds in the lobby after every trip');
        assert.deepEqual(t.inGame.l, trips[0].inGame.l, 'same listener count and kinds in Starfall every time');
        assert.ok(t.back.peak <= trips[0].back.peak * 1.5 + 4, `playing sources do not pile up (${t.back.peak} vs ${trips[0].back.peak})`);
      }
      assert.ok(trips[0].inGame.l.n >= trips[0].back.l.n - 20, 'sanity: counted something');
      await enterStarfall(page); // and it still plays a run after five trips
      await toTitle(page);
      await page.evaluate(() => SF.mode('free'));
      await page.waitForFunction(() => SF.app() === 'game', null, WAIT);
      assert.equal(await page.evaluate(() => __loops()), 1);
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('sub-pages go back to the main menu first; the table, how-to and attract', { timeout: 120000 }, async () => {
    const { ctx, page, problems } = await openLobby();
    try {
      await enterStarfall(page); await toTitle(page);
      for (const p of ['how', 'table']) {
        await page.evaluate(x => SF.page(x), p);
        await page.waitForTimeout(450);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => SF.info().page === 'main', null, WAIT);
        assert.equal(await mode(page), 'gone', p + ': back went to the main menu, not the lobby');
        await page.evaluate(x => SF.page(x), p);
        await page.waitForTimeout(450);
        await page.keyboard.press('Backspace');
        await page.waitForFunction(() => SF.info().page === 'main', null, WAIT);
        assert.equal(await mode(page), 'gone');
      }
      await page.keyboard.press('Escape'); // main menu: now it leaves
      await inLobby(page);
      // attract
      await enterStarfall(page); await toTitle(page);
      await page.evaluate(() => SF.attractNow());
      await page.waitForFunction(() => SF.app() === 'attract', null, WAIT);
      await page.waitForTimeout(400);
      await page.keyboard.press('Escape');
      await inLobby(page);
      // the cabinet intro too
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => LOBBY.info().mode === 'gone' && SF.away() === false && SF.app() === 'cabinet', null, WAIT);
      await page.keyboard.press('Escape');
      await inLobby(page);
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('mid-run Esc pauses (LOBBY line), second Esc leaves; nothing submitted; a claimed daily stays used', { timeout: 120000 }, async () => {
    const { ctx, page, problems } = await openLobby();
    try {
      await enterStarfall(page); await toTitle(page);
      await intoRun(page, 'daily');
      const info = await page.evaluate(() => SF.runInfo());
      assert.equal(info.mode, 'daily'); assert.equal(info.claimed, true, 'first play frame seen');
      await page.waitForTimeout(300);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => SF.paused() === true, null, WAIT);
      assert.equal(await mode(page), 'gone', 'the first Esc only pauses');
      assert.equal(await page.evaluate(() => SF.app()), 'game');
      await shot(page, 'pause-lobby-line');
      await page.keyboard.press('Escape');
      await inLobby(page);
      assert.equal(await page.evaluate(() => SF.paused()), false);
      const kept = await page.evaluate(() => Object.keys(localStorage).filter(k => /daily-attempt/.test(k)));
      assert.equal(kept.length, 1, 'the claimed daily attempt marker is still there (used, as if the tab had closed)');
      const rows = await page.evaluate(() => SF.scores('all', undefined, false));
      assert.equal(rows.length, 0, 'nothing was submitted to the local board');
      // fresh run after returning: the daily is a practice run now (attempt used), free play still ranks
      await enterStarfall(page); await toTitle(page);
      assert.equal(await page.evaluate(() => SF.runInfo()), null, 'the abandoned run is gone');
      await intoRun(page, 'free');
      assert.equal(await page.evaluate(() => SF.runInfo().claimed), true);
      await page.waitForTimeout(200);
      await page.keyboard.press('Backspace'); // Backspace pauses too
      await page.waitForFunction(() => SF.paused() === true, null, WAIT);
      await page.keyboard.press('Backspace');
      await inLobby(page);
      assert.equal((await page.evaluate(() => SF.scores('all', undefined, false))).length, 0);
      // an unclaimed daily (left in the stage intro) stays unclaimed
      await page.evaluate(() => localStorage.clear());
      await enterStarfall(page); await toTitle(page);
      await page.evaluate(() => SF.mode('daily'));
      assert.equal(await page.evaluate(() => SF.runInfo().claimed), false);
      await page.keyboard.press('Escape'); await page.waitForFunction(() => SF.paused() === true, null, WAIT);
      await page.keyboard.press('Escape'); await inLobby(page);
      assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(k => /daily-attempt/.test(k)).length), 0, 'an unclaimed daily is not burned');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('name entry: Backspace deletes a letter and never leaves; Esc does not leave either', { timeout: 240000 }, async () => {
    const { ctx, page, problems } = await openLobby();
    try {
      await enterStarfall(page); await toTitle(page);
      await page.evaluate(() => SF.mode('free'));
      await page.evaluate(() => { let n = 0; while (SF.state === 'intro' && n++ < 1000) SF.autoFire(1); });
      await page.evaluate(() => { let n = 0; while (SF.state !== 'results' && n++ < 400) SF.autoFire(600); });
      for (let i = 0; i < 60 && (await page.evaluate(() => SF.app())) !== 'entry'; i++) { await page.keyboard.press('Enter'); await page.waitForTimeout(150); }
      assert.equal(await page.evaluate(() => SF.app()), 'entry');
      await page.evaluate(() => SF.nameEntry === undefined);
      await page.keyboard.press('KeyB'); await page.waitForTimeout(100);
      await page.keyboard.press('Backspace'); await page.waitForTimeout(100);
      await page.keyboard.press('Backspace'); await page.waitForTimeout(100);
      await page.keyboard.press('Escape'); await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => SF.app()), 'entry', 'still on name entry');
      assert.equal(await mode(page), 'gone');
      assert.equal(await page.evaluate(() => SF.away()), false);
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('starfall.html alone: back does nothing harmful on the title; pause still works; Esc in a run only pauses', { timeout: 120000 }, async () => {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
    const page = await ctx.newPage();
    const problems = [];
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
    page.on('pageerror', e => problems.push('pageerror: ' + e.message));
    try {
      await page.goto(web.url + 'starfall.html');
      await page.waitForFunction(() => window.SF, null, WAIT);
      await toTitle(page);
      for (const k of ['Escape', 'Backspace']) { await page.keyboard.press(k); await page.waitForTimeout(300); }
      assert.equal(await page.evaluate(() => SF.app()), 'title');
      assert.equal(await page.evaluate(() => SF.away()), false);
      await page.evaluate(() => SF.mode('free'));
      await page.waitForTimeout(300);
      await page.keyboard.press('KeyP'); await page.waitForFunction(() => SF.paused() === true, null, WAIT);
      await page.keyboard.press('KeyP'); await page.waitForFunction(() => SF.paused() === false, null, WAIT);
      await page.keyboard.press('Escape'); await page.waitForFunction(() => SF.paused() === true, null, WAIT);
      await shot(page, 'pause-standalone');
      await page.keyboard.press('Escape'); await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => SF.paused()), true, 'no lobby: the second Esc does nothing');
      assert.equal(await page.evaluate(() => SF.app()), 'game');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });
});
