// STACKLIGHT T4 audio: what a cold review found. NEW file; the
// original tests/stacklight-audio.test.js is untouched.
//   1. hand-overs at the next bar line never miss: fps 144, 60, 30, 20, with jitter and with a stall, 200 start phases
//             each, levels 5 and 17, GLOW chord and tempo change. Fake engine clock (a track starts MUSIC_START_LEAD_S after the call).
//   2. the unlock stays armed until the context is really running (a context that needs a second gesture)
//   3. L2     no glowStep shimmer for a clear that is already at the cap
//   4. L4     bass, arpeggio and drums are built once and shared by every variant
//   5. page tests, real stacklight.html and real keys: endStep on the lock's own frame, the hide listener on document,
//             the turn-sideways screen passed to sync, and the real-page unlock with a context that wakes on the second gesture
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { staticServer, WAIT } from './w25-helpers.mjs';
import { createAudioBind } from '../games/stacklight/audio-bind.js';
import { trackFor, trackId, BARS, GLOW_STEPS, BPM_BASE } from '../games/stacklight/music.js';
import { EV_CLEAR, EV_LOCK, EVS } from '../games/stacklight/sim.js';

const LEAD = 0.06; // MUSIC_START_LEAD_S

// ---------- a fake engine whose clock the test moves; a track's beat 0 is LEAD after the call, as in engine/audio.js ----------
function fakeEngine() {
  const tracks = {};
  const E = {
    t: 0, cur: null, calls: [], stops: 0,
    ctx: { state: 'running', suspend() { this.state = 'suspended'; }, resume() { this.state = 'running'; return Promise.resolve(); } },
    unlock: () => true, setMuted() {}, registerTracks(o) { Object.assign(tracks, o); }, sfx: () => true, setIntensity() {},
    playMusic(id) {
      const tr = tracks[id]; if (!tr) throw new Error('unregistered ' + id);
      const [, bpm, bar, g] = id.split('-').map(Number);
      E.cur = { tr, bpm, bar, g, start: E.t + LEAD }; E.calls.push({ at: E.t, start: E.t + LEAD, bpm, bar, g }); return true;
    },
    stopMusic() { E.cur = null; E.stops++; },
    beatAt() { return E.cur ? (E.t - E.cur.start) * E.cur.bpm / 60 : -1; },
    now() { return E.t; }
  };
  return E;
}

// small seeded generator for the frame jitter (the test must be repeatable)
const lcg = seed => { let s = (seed * 2654435761 + 12345) >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; };

// One start phase. kind: 'glow' (the pad chord steps up at a bar line) or 'tempo' (a level up changes the tempo).
// style: 'steady' | 'jitter' (each frame 50 to 150 percent of nominal) | 'stall' (one frame jumps over the bar line).
function onePhase(fps, level, ph, kind, style) {
  const E = fakeEngine(), b = createAudioBind({ audio: E }); b.unlock();
  const rnd = lcg(ph + 1 + fps * 1000 + level);
  const nominal = 1 / fps;
  const dt = () => (style === 'jitter' ? nominal * (0.5 + rnd()) : nominal);
  const sim = { level: kind === 'tempo' ? level - 1 : level, glow: 0, glowT: 0, done: false };
  E.t = (ph / 200) * nominal;
  b.sync('play', false, sim);
  const pre = Math.floor(ph * 1.37 * fps) % (fps * 7) + Math.ceil(fps * 0.5);
  let maxDt = nominal;
  for (let i = 0; i < pre; i++) { const d = dt(); if (d > maxDt) maxDt = d; E.t += d; b.sync('play', false, sim); }
  assert.equal(E.calls.length, 1, 'one track so far');
  const old = E.cur, oldBpm = old.bpm, barSec = 240 / oldBpm;
  // the change appears now; its first frame is the first moment the bind can see it
  if (kind === 'glow') { sim.glow = 1; sim.glowT = 100000; } else sim.level = level;
  const n0 = E.calls.length;
  const barNow = (t) => Math.floor((t - old.start) / barSec + 1e-9);
  { const d = dt(); if (d > maxDt) maxDt = d; E.t += d; b.sync('play', false, sim); }
  const tFirst = E.t;
  let lineAfter = (barNow(tFirst) + 1) * barSec + old.start;
  // a first frame closer than LEAD to the line fires at once, and that start is after the line
  let stalled = false;
  for (let i = 0; i < Math.ceil(fps * 4) && E.calls.length === n0; i++) {
    let d = dt();
    if (style === 'stall' && !stalled && E.t + d < lineAfter && lineAfter - E.t < LEAD + 0.06 && lineAfter - E.t > LEAD) {
      // the next frame would still be before the line: instead it comes late, 2 to 92 ms past the line
      d = lineAfter - E.t + 0.002 + (ph % 10) * 0.01; stalled = true;
    }
    if (d > maxDt) maxDt = d;
    E.t += d; b.sync('play', false, sim);
  }
  const done = E.calls.length > n0;
  const c = E.calls[n0];
  const res = { done, maxDt, stalled, barSec, late: done ? c.start - lineAfter : NaN, waitBars: done ? (c.start - tFirst) / barSec : NaN, bar: done ? c.bar : -1, bpm: done ? c.bpm : 0, g: done ? c.g : -1 };
  res.expectBar = (old.bar + barNow(tFirst) + 1) % BARS;
  res.expectBarStalled = (old.bar + barNow(c ? c.at : tFirst)) % BARS;
  // no second track in the next 3 bars (a pending change is taken once)
  const calls1 = E.calls.length, tEnd = E.t + 3 * barSec;
  while (E.t < tEnd) { E.t += dt(); b.sync('play', false, sim); }
  res.extra = E.calls.length - calls1;
  return res;
}

const TABLE = [];
function sweep(fps, level, kind, style) {
  let miss = 0, worstLate = 0, worstWait = 0, early = 0, wrongBar = 0, extra = 0, wrongTarget = 0;
  const N = 200;
  for (let ph = 0; ph < N; ph++) {
    const r = onePhase(fps, level, ph, kind, style);
    if (!r.done || r.waitBars > 1 + (style === 'stall' ? 0.2 : 0.1) / r.barSec) { miss++; continue; }  // a stall frame is up to 92 ms past the line, plus the 60 ms lead
    const tempoTarget = kind === 'tempo' ? BPM_BASE + 8 * Math.floor((level - 1) / 4) : r.bpm;
    if (kind === 'glow' ? r.g !== 1 : r.bpm !== Math.min(144, tempoTarget)) wrongTarget++;
    if (r.late < -1e-9) early++;
    if (style !== 'stall') {
      if (r.late > Math.max(r.maxDt, LEAD) + 1e-6) worstLate = Infinity; else worstLate = Math.max(worstLate, r.late);
      if (r.bar !== r.expectBar) wrongBar++;
    } else if (r.bar !== r.expectBar && r.bar !== r.expectBarStalled) wrongBar++;
    worstWait = Math.max(worstWait, r.waitBars);
    extra += r.extra;
  }
  const row = { fps, level, kind, style, miss, N, lateMs: Math.round(worstLate * 1000), waitBars: +worstWait.toFixed(2), early, wrongBar, extra, wrongTarget };
  TABLE.push(row);
  return row;
}

test('1. MED-1 the hand-over never misses its bar line: 144, 60, 30 and 20 fps, steady and with jitter, 200 start phases, levels 5 and 17', () => {
  for (const style of ['steady', 'jitter'])
    for (const fps of [144, 60, 30, 20])
      for (const level of [5, 17])
        for (const kind of ['glow', 'tempo']) {
          const r = sweep(fps, level, kind, style);
          const tag = JSON.stringify(r);
          assert.equal(r.miss, 0, 'missed a bar line: ' + tag);
          assert.equal(r.early, 0, 'a track started before its bar line: ' + tag);
          assert.equal(r.wrongBar, 0, 'it carried on from the wrong bar of the loop: ' + tag);
          assert.equal(r.wrongTarget, 0, 'wrong chord or tempo: ' + tag);
          assert.equal(r.extra, 0, 'a second track was scheduled: ' + tag);
          assert.ok(Number.isFinite(r.lateMs) && r.lateMs <= Math.ceil(1000 * Math.max(1 / fps * 1.5, LEAD)), 'too late: ' + tag);
          assert.ok(r.waitBars <= 1.05, 'waited more than a bar: ' + tag);
        }
});

test('1b. a stall that carries one frame over the bar line still takes the change at once (restarts that bar, no wait for the next one)', () => {
  for (const fps of [60, 30, 20])
    for (const level of [5, 17])
      for (const kind of ['glow', 'tempo']) {
        const r = sweep(fps, level, kind, 'stall');
        assert.equal(r.miss, 0, JSON.stringify(r));
        assert.equal(r.early, 0, JSON.stringify(r));
        assert.equal(r.wrongBar, 0, JSON.stringify(r));
        assert.equal(r.wrongTarget, 0, JSON.stringify(r));
        assert.equal(r.extra, 0, 'double schedule: ' + JSON.stringify(r));
      }
});

test('1c. a change that shows up just after a line waits for the next line, not a restart of the bar (no stutter)', () => {
  const E = fakeEngine(), b = createAudioBind({ audio: E }); b.unlock();
  const sim = { level: 4, glow: 0, glowT: 0, done: false };
  for (let i = 0; i < 60; i++) { E.t += 1 / 60; b.sync('play', false, sim); }
  const c0 = E.cur, bar = 240 / c0.bpm;
  // step to 5 ms after the first bar line, then change the level
  while (E.t < c0.start + bar + 0.005) { E.t += 1 / 60; b.sync('play', false, sim); }
  const n = E.calls.length; sim.level = 5; E.t += 1 / 60; b.sync('play', false, sim);
  assert.equal(E.calls.length, n, 'no restart of the bar that just began');
  for (let i = 0; i < 400 && E.calls.length === n; i++) { E.t += 1 / 60; b.sync('play', false, sim); }
  assert.equal(E.calls.length, n + 1, 'it took the next line'); assert.ok(E.calls[n].start >= c0.start + 2 * bar - 1e-9);
});

// ================= 2. The unlock waits for a running context =================
// a context that stays suspended until the Nth user gesture (a phone: pointerdown does not count as an activation)
function lazyEngine(wakeAt) {
  const E = fakeEngine();
  E.gestures = 0; E.resumes = 0;
  E.ctx = { state: 'suspended', suspend() { this.state = 'suspended'; return Promise.resolve(); }, resume() { E.resumes++; if (E.gestures >= wakeAt) this.state = 'running'; return Promise.resolve(); } };
  E.unlock = () => { E.ctx.resume(); return true; };
  return E;
}
function listeners() {
  const h = new Map(), win = { addEventListener(e, f) { h.set(e, f); }, removeEventListener(e) { h.delete(e); } };
  const doc = { hidden: false, addEventListener(e, f) { h.set('doc:' + e, f); } };
  return { h, win, doc };
}

test('2. MED-3 the unlock stays armed while the context is suspended; the second gesture wakes it; then the listeners go', async () => {
  const E = lazyEngine(2), b = createAudioBind({ audio: E }); const { h, win, doc } = listeners();
  b.listen(win, doc);
  const sim = { level: 1, glow: 0, glowT: 0, done: false };
  E.gestures = 1; h.get('pointerdown')();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(E.ctx.state, 'suspended'); assert.ok(h.has('keydown') && h.has('touchend') && h.has('click'), 'still armed after one gesture that did not wake it');
  assert.equal(b.state().unlocked, true);
  // frames while it is suspended do not drop the listeners
  for (let i = 0; i < 10; i++) { E.t += 1 / 60; b.sync('play', false, sim); }
  assert.ok(h.has('touchend'), 'a suspended context does not disarm');
  const r1 = E.resumes;
  E.gestures = 2; h.get('touchend')();
  await Promise.resolve(); await Promise.resolve();
  assert.ok(E.resumes > r1, 'the second gesture asked the context to resume');
  assert.equal(E.ctx.state, 'running');
  assert.equal(h.has('keydown'), false); assert.equal(h.has('touchend'), false, 'running: the listeners are removed');
  for (let i = 0; i < 20; i++) { E.t += 1 / 60; b.sync('play', false, sim); }
  assert.equal(E.calls.length, 1, 'the music starts once it runs');
});

test('2b. a context that stays suspended for several gestures keeps the listeners; each gesture asks again', async () => {
  const E = lazyEngine(5), b = createAudioBind({ audio: E }); const { h, win, doc } = listeners();
  b.listen(win, doc);
  for (let k = 1; k <= 4; k++) {
    E.gestures = k; const r = E.resumes; h.get(k % 2 ? 'keydown' : 'click')();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(E.ctx.state, 'suspended'); assert.ok(h.has('keydown'), 'armed after gesture ' + k);
    if (k > 1) assert.equal(E.resumes, r + 1, 'one resume per gesture');
  }
  E.gestures = 5; h.get('keydown')(); await Promise.resolve(); await Promise.resolve();
  assert.equal(E.ctx.state, 'running'); assert.equal(h.has('keydown'), false);
});

test('2c. a context the game suspended on purpose (pause) is not woken by a gesture', async () => {
  const E = lazyEngine(1), b = createAudioBind({ audio: E }); const { h, win, doc } = listeners();
  b.listen(win, doc);
  const sim = { level: 1, glow: 0, glowT: 0, done: false };
  E.gestures = 0; h.get('keydown')();   // unlocked, still suspended (needs gesture 1 to be honoured, this was gesture 0)
  b.sync('play', true, sim);            // paused: the clock is held on purpose
  const r = E.resumes; E.gestures = 1; h.get('click')();
  assert.equal(E.resumes, r, 'no resume while paused'); assert.equal(E.ctx.state, 'suspended');
  b.sync('play', false, sim);           // resumed by the player: the bind itself resumes the clock
  assert.equal(E.ctx.state, 'running');
});

test('2d. a context that is running at the first gesture (desktop) removes the listeners at once', () => {
  const E = fakeEngine(); E.unlock = () => { E.ctx.state = 'running'; return true; };
  const b = createAudioBind({ audio: E }); const { h, win, doc } = listeners();
  b.listen(win, doc); h.get('keydown')();
  assert.equal(h.has('keydown'), false); assert.ok(h.has('doc:visibilitychange'));
});

// ================= 3. no glowStep shimmer at the cap =================
const CLEAR = (rows, g) => [EV_CLEAR, 1, rows, 1, 100, g];
function feed(b, ...evs) { const buf = new Int32Array(EVS); for (const e of evs) { buf.fill(0); e.forEach((v, i) => { buf[i] = v; }); b.event(buf, 0); } b.endStep(); }
test('3. L2 a clear at the cap (g was 4, stays 4) plays the clear but not the GLOW step shimmer', () => {
  const E = fakeEngine(), names = [];
  E.sfx = n => { names.push(n); return true; };
  const b = createAudioBind({ audio: E }); b.unlock();
  for (const g of [0, 1, 2, 3, 4]) feed(b, [EV_LOCK, 1, 1, 0, 0, 4], CLEAR(1, g));
  const steps = names.filter(n => n === 'glowStep').length;
  assert.equal(steps, 4, 'g 1, 2, 3 and 4 each step once');
  feed(b, [EV_LOCK, 1, 1, 0, 0, 4], CLEAR(1, 4)); feed(b, [EV_LOCK, 1, 1, 0, 0, 4], CLEAR(2, 4));
  assert.equal(names.filter(n => n === 'glowStep').length, 4, 'no shimmer for the two clears at the cap');
  assert.equal(names.filter(n => n === 'clear').length, 7, 'but every clear still sounds');
  feed(b, [EV_LOCK, 1, 1, 0, 0, 4], CLEAR(1, 0)); feed(b, [EV_LOCK, 1, 1, 0, 0, 4], CLEAR(1, 1));
  assert.equal(names.filter(n => n === 'glowStep').length, 5, 'GLOW lapsed and started again: g 1 steps');
});

// ================= 4. shared parts =================
test('4. L4 bass, arpeggio and drum patterns are built once and shared by every variant', () => {
  const ref = trackFor(112, 0, 0);
  for (const bpm of [112, 120, 144]) for (const bar of [0, 3, 7]) for (let g = 0; g < GLOW_STEPS; g++) {
    const t = trackFor(bpm, bar, g);
    assert.equal(t.channels, ref.channels);
    for (let k = 0; k < BARS; k++) { assert.equal(t.patterns['bass' + k], ref.patterns['bass' + k]); assert.equal(t.patterns['arp' + k], ref.patterns['arp' + k]); }
    assert.equal(t.patterns.drumA, ref.patterns.drumA); assert.equal(t.patterns.drumF, ref.patterns.drumF);
    assert.equal(t.patterns, trackFor(120, 5, g).patterns, 'one patterns object per g');
    assert.equal(t.song, trackFor(144, bar, (g + 1) % GLOW_STEPS).song, 'one song order per start bar');
  }
  // the pad is what g moves
  assert.notEqual(trackFor(112, 0, 0).patterns.pad0, trackFor(112, 0, 1).patterns.pad0);
  assert.equal(trackFor(112, 0, 2).id, trackId(112, 0, 2));
});

// ================= 5. the page =================
let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

async function open({ w = 1000, h = 750, touch = false, init = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch });
  const page = await ctx.newPage(), problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) problems.push('HTTP ' + r.status() + ' ' + r.url()); });
  if (init) await page.addInitScript(init);
  await page.goto(web.url + 'stacklight.html');
  await page.waitForFunction(() => window.SL && SL.info().app === 'title' && SL.hud().F > 5, null, WAIT);
  return { ctx, page, problems };
}
const audio = page => page.evaluate(() => SL.audio());
const POLL = { timeout: 8000, polling: 25 };

test('5a. MED-2 page: a real hard drop sounds its lock on the lock\'s own frame, not one piece later', { timeout: 90000 }, async () => {
  const { ctx, page, problems } = await open();
  try {
    await page.keyboard.press('Enter');                       // a real key: the first gesture, and it starts the run
    await page.waitForFunction(() => SL.info().app === 'play', null, WAIT);
    await page.evaluate(() => SL.start(5));
    await page.waitForFunction(() => SL.info().piece && !SL.info().paused, null, WAIT);
    const sum = a => a.sfx.lockSoft + a.sfx.lockFit + a.sfx.lockKey + a.sfx.melt;
    const before = sum(await audio(page));
    await page.keyboard.press('Space');                       // hard drop: one piece locks
    await page.waitForFunction(b => { const a = SL.audio(); return a.sfx.lockSoft + a.sfx.lockFit + a.sfx.lockKey + a.sfx.melt > b; }, before, POLL);
    const a = await audio(page);
    assert.equal(sum(a) - before, 1, 'exactly one lock sound for the one lock, requested before the next piece exists: ' + JSON.stringify(a.sfx));
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('5b. MED-2 page: a real-shaped visibilitychange on document (document.hidden true) hides the bind and stops the clock', { timeout: 90000 }, async () => {
  const { ctx, page, problems } = await open();
  try {
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => SL.audio().playing && SL.audio().ctxState === 'running', null, WAIT);
    // keep the run un-paused by the app's own hide handler for what we look at: we only read the bind's own state
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    });
    assert.equal((await audio(page)).hidden, true, 'the bind saw the tab hide, straight away');
    await page.waitForFunction(() => SL.audio().ctxState === 'suspended', null, POLL);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
    });
    assert.equal((await audio(page)).hidden, false);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

// hold the app's animation frames, then release exactly one that advances the loop clock by 0 ms (no sim tick, one render)
const HOLD = `(() => {
  const raf = window.requestAnimationFrame.bind(window); const held = []; let lastTs = 0, hold = false;
  window.requestAnimationFrame = cb => raf(ts => { if (hold && cb.name === 'frame') { held.push(cb); return; } lastTs = ts; cb(ts); });
  window.__hold = on => { hold = on; };
  window.__renderOnce = () => { const cb = held.shift(); if (!cb) return false; cb(lastTs); return true; };
})();`;

test('5c. MED-2 page: the turn-sideways screen reaches sync() by itself (not only through the pause the tick sets)', { timeout: 90000 }, async () => {
  const { ctx, page, problems } = await open({ w: 844, h: 390, touch: true, init: HOLD });
  try {
    await page.touchscreen.tap(422, 195);                                 // a real tap: the first gesture
    await page.evaluate(() => SL.start(3));
    await page.waitForFunction(() => SL.audio().playing && SL.audio().ctxState === 'running' && !SL.audio().paused, null, WAIT);
    await page.evaluate(() => window.__hold(true));
    await page.waitForTimeout(100);                                       // the app's last frame lands; from now frames are held
    await page.setViewportSize({ width: 390, height: 844 });              // upright
    await page.waitForFunction(() => SL.view().rotateShown === true, null, POLL);
    const r = await page.evaluate(() => { const ok = window.__renderOnce(); return { ok, ui: SL.info().paused, rotate: SL.view().rotateShown, bind: SL.audio().paused }; });
    assert.equal(r.ok, true, 'one render ran'); assert.equal(r.rotate, true);
    assert.equal(r.ui, false, 'the app has not paused the run yet (no tick ran), so only the rotate screen can hold the audio');
    assert.equal(r.bind, true, 'sync() was told the turn-sideways screen is up');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

// a context that stays suspended until the SECOND real user gesture (a phone: the first event of a tap is not an activation)
const LAZY_CTX = `(() => {
  const Real = window.AudioContext; let gestures = 0, resumes = 0;
  window.addEventListener('keydown', () => { gestures++; }, true);
  window.addEventListener('pointerdown', () => { gestures++; }, true);
  class Lazy extends Real {
    constructor(...a) { super(...a); this._ok = false; }
    get state() { return this._ok ? super.state : 'suspended'; }
    resume() { resumes++; if (gestures >= 2) { this._ok = true; return super.resume(); } return Promise.resolve(); }
  }
  window.AudioContext = Lazy;
  window.__lazy = () => ({ gestures, resumes });
})();`;

test('5d. MED-3 page: a context that needs a second gesture is woken by it (the first gesture does not disarm)', { timeout: 90000 }, async () => {
  const { ctx, page, problems } = await open({ init: LAZY_CTX });
  try {
    assert.equal((await audio(page)).unlocked, false);
    await page.keyboard.press('Enter');                                   // gesture 1: starts the run, unlocks, context stays suspended
    await page.waitForFunction(() => SL.audio().unlocked, null, WAIT);
    await page.waitForTimeout(400);
    let a = await audio(page);
    assert.equal(a.ctxState, 'suspended', 'the first gesture did not wake this context');
    assert.equal(a.unlocked, true);
    await page.keyboard.press('ArrowLeft');                               // gesture 2
    await page.waitForFunction(() => SL.audio().ctxState === 'running', null, POLL);
    await page.waitForFunction(() => SL.audio().playing, null, POLL);
    a = await audio(page);
    assert.equal(a.ctxState, 'running'); assert.equal(a.playing, true, 'the music plays once it runs: ' + JSON.stringify({ track: a.track, bpm: a.bpm }));
    const r = await page.evaluate(() => window.__lazy());
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowLeft');
    assert.equal((await page.evaluate(() => window.__lazy())).resumes, r.resumes, 'the listeners are gone once it runs: no more resume() calls');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

after(() => {
  const L = TABLE.map(r => `fps ${String(r.fps).padStart(3)} L${String(r.level).padStart(2)} ${r.kind.padEnd(5)} ${r.style.padEnd(6)} missed ${r.miss}/${r.N}  worst start after the line ${r.lateMs} ms  longest wait ${r.waitBars} bars  early ${r.early}  wrong bar ${r.wrongBar}  extra tracks ${r.extra}`);
  console.log('\nw50b hand-over table (200 start phases each):\n' + L.join('\n'));
});
