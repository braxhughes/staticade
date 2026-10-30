// S13b: the STARLIGHT bonus track is locked to the sim's beat clock and heat drives the music's intensity.
// Drives the real starfall.html in headless Chrome (system Chrome) with page spies on AudioParam.setTargetAtTime, like s13-audio.test.js.
// Headless Chrome cannot be listened to: this pins the measured offset (SF.audio().drift, sim frames) and when the engine is told.
// Mutants this file kills: no beat anchor (drift = bar-edge offset), anchor on the stage card start instead of beat 0, drift left null,
// a track restart on unmute that ignores the bar edge, setIntensity never called or called every frame, drift reported off STARLIGHT.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { STAGE_TABLE } from '../games/starfall/sim/stages.js';
import { TRACKS } from '../games/starfall/music.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const WAIT = { timeout: 30000 };
let server, browser, url;

// ints counts the engine's setIntensity work: applyIntensity calls setTargetAtTime with time constant 0.07 on every channel
const SPIES = `(() => {
  window.__ints = 0;
  const AC = window.AudioParam;
  const f = AC.prototype.setTargetAtTime;
  AC.prototype.setTargetAtTime = function (v, t, tc) { if (tc === 0.07) window.__ints++; return f.apply(this, arguments); };
})();`;

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  const page = await ctx.newPage();
  const problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.addInitScript(SPIES);
  await page.goto(url + 'starfall.html');
  await page.waitForFunction(() => window.SF, null, WAIT);
  await page.evaluate(() => SF.skip());
  await page.waitForFunction(() => SF.state === 'title', null, WAIT);
  await page.keyboard.press('KeyQ');
  await page.waitForFunction(() => SF.audio().unlocked, null, WAIT);
  return { ctx, page, problems };
}
const aud = page => page.evaluate(() => SF.audio());
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
  P.lock = scenarioLock(); P.pause5 = scenarioPause5(); P.heat = scenarioHeat(); // independent pages: start them together
  for (const k of Object.keys(P)) P[k].catch(() => {});
});
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });
const P = {};

test('stage 9 is a STARLIGHT stage and the bonus track is 144 bpm with 25-frame beats', () => {
  assert.equal(STAGE_TABLE[9].kind, 'bonus');
  assert.equal(TRACKS.bonus.bpm, 144);
  assert.equal(3600 / TRACKS.bonus.bpm, 25, 'one audio beat = one sim beat');
});

// ---------- the beat lock ----------
async function scenarioLock() {
  const { ctx, page, problems } = await open();
  const out = { problems, samples: [] };
  const sample = async tag => { const a = await aud(page); out.samples.push([tag, a.drift]); return a; };
  await page.evaluate(() => SF.start(9));
  out.card = await aud(page); // the stage card: the track is wanted but waits for the bar edge
  await page.waitForFunction(() => SF.info().beat >= 32, null, { timeout: 60000 });
  out.at32 = await sample('beat32');
  out.beat32 = await page.evaluate(() => SF.info().beat);
  // pause 2 s: the sim stops, the audio clock stops with it
  await page.keyboard.press('KeyP');
  await page.waitForFunction(() => window.SF.audio().track === 'bonus', null, WAIT);
  await page.waitForTimeout(2000);
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(1500); // past a bar edge (100 frames = 1.67 s)
  for (let i = 0; i < 4; i++) { await sample('afterPause'); await page.waitForTimeout(250); }
  // mute then unmute during STARLIGHT: the track comes back on a bar edge of the sim beat clock
  await page.keyboard.press('KeyM');
  await page.waitForFunction(() => SF.audio().muted, null, WAIT);
  out.mutedDrift = (await aud(page)).drift;
  await page.waitForTimeout(700);
  await page.keyboard.press('KeyM');
  await page.waitForFunction(() => !SF.audio().muted, null, WAIT);
  await page.waitForTimeout(2200);
  out.unmuted = await sample('afterUnmute');
  await page.waitForTimeout(500);
  await sample('afterUnmute2');
  out.beatAfter = await page.evaluate(() => SF.info().beat);
  // leaving STARLIGHT: no beat clock, no drift
  await page.evaluate(() => SF.start(1));
  await page.waitForTimeout(300);
  out.off = await aud(page);
  await ctx.close();
  return out;
}
test('beat lock: SF.start(9), after 32 sim beats bpm is 144 and |drift| <= 1; a 2 s pause and a mute do not break it', async () => {
  const o = await P.lock;
  if (process.env.S13B_TRACE) console.log('TRACE lock', JSON.stringify(o.samples));
  assert.equal(o.card.track, 'bonus', 'wanted on the stage card');
  assert.equal(o.card.drift, null, 'no drift before the track has started');
  assert.ok(o.beat32 >= 32);
  assert.equal(o.at32.bpm, 144, 'design verify line: SF.audio().bpm===144');
  for (const [tag, d] of o.samples) assert.ok(typeof d === 'number' && Math.abs(d) <= 1, `${tag}: drift ${d} within 1 sim frame (all: ${JSON.stringify(o.samples)})`);
  assert.equal(o.mutedDrift, null, 'muted: the track is stopped, so there is no drift');
  assert.equal(o.unmuted.track, 'bonus');
  assert.equal(o.off.drift, null, 'drift is null off STARLIGHT');
  assert.equal(o.off.track, 'z1');
  noProblems(o, 'lock');
});

// a long pause (5 s): the re-anchor heals drift back within 1 frame inside 8 sim beats (2 bars)
async function scenarioPause5() {
  const { ctx, page, problems } = await open();
  const out = { problems, samples: [] };
  await page.evaluate(() => SF.start(9));
  await page.waitForFunction(() => SF.info().beat >= 12, null, { timeout: 60000 });
  await page.keyboard.press('KeyP');
  await page.waitForTimeout(5000);
  await page.keyboard.press('KeyP');
  const b0 = await page.evaluate(() => SF.info().beat);
  out.b0 = b0;
  // sample at every beat for 8 beats from the resume, then once more a bar later
  for (let n = 0; n <= 9; n++) {
    await page.waitForFunction(b => SF.info().beat >= b, b0 + n, { timeout: 30000 });
    const r = await page.evaluate(() => ({ d: SF.audio().drift, b: SF.info().beat }));
    out.samples.push(r);
  }
  await ctx.close();
  return out;
}
test('a 5 s pause: drift is back within 1 frame within 8 sim beats of the resume', async () => {
  const o = await P.pause5;
  if (process.env.S13B_TRACE) console.log('TRACE pause5', JSON.stringify(o.samples.map(x => [x.b - o.b0, x.d])));
  const tail = o.samples.filter(s => s.b >= o.b0 + 8);
  assert.ok(tail.length > 0);
  for (const s of tail) assert.ok(typeof s.d === 'number' && Math.abs(s.d) <= 1, `drift ${s.d} at beat ${s.b} (all: ${JSON.stringify(o.samples)})`);
  noProblems(o, 'pause5');
});

// ---------- heat drives the music intensity ----------
async function scenarioHeat() {
  const { ctx, page, problems } = await open();
  const out = { problems };
  await page.evaluate(() => { SF.god(); SF.start(1); });
  await page.waitForTimeout(600);
  out.start = await page.evaluate(() => ({ i: SF.info().intensity, ints: window.__ints, a: SF.audio() }));
  // steady heat: the engine is not called again (it would be 7+ calls a frame if called every frame)
  await page.waitForTimeout(1000);
  out.steady = await page.evaluate(() => window.__ints);
  // play stage 1 to its end without dying: +2 heat
  await page.evaluate(() => { let n = 0; while (SF.info().intensity === 0 && SF.state !== 'results' && n++ < 400) SF.autoFire(600); });
  out.after = await page.evaluate(() => ({ i: SF.info().intensity, heat: SF.info().flame, ints: window.__ints, state: SF.state }));
  await page.waitForTimeout(800);
  out.settled = await page.evaluate(() => window.__ints);
  await page.waitForTimeout(1000);
  out.held = await page.evaluate(() => window.__ints);
  await ctx.close();
  return out;
}
test('intensity follows heat: the engine is told when heat changes, not every frame', async () => {
  const o = await P.heat;
  assert.equal(o.start.i, 0, 'a run starts at heat 0');
  assert.equal(o.start.a.drift, null, 'drift is null on a normal stage');
  assert.ok(o.start.ints <= 7 * 3, 'only a few intensity changes at the start: ' + o.start.ints);
  assert.equal(o.steady, o.start.ints, 'no calls while heat holds still for 1 s');
  assert.ok(o.after.i > 0, 'heat rose by playing: ' + JSON.stringify(o.after));
  assert.ok(o.settled > o.steady, 'the engine was told the new intensity');
  assert.equal(o.held, o.settled, 'and then left alone while heat holds still');
  noProblems(o, 'heat');
});

// ---------- fix round (MED1-MED4, LOW3): stalls, the sim beat grid, the intensity value ----------
// The main thread is blocked for ms (a busy page): the audio clock runs on, the sim's catch-up is clamped at 250 ms, so drift jumps.
const BLOCK = ms => page => page.evaluate(m => { const t = performance.now(); while (performance.now() - t < m) { /* busy */ } }, ms);
// range [lo, hi] (optional): the drift the stall must leave, read when it has settled (see below). A stall of a given length leaves a
// load-dependent drift (how much of the block the sim's catch-up eats depends on when the browser stamps the first frame after it).
// So the first reading after the block is not the drift: the catch-up burst is still running and moves it by up to a frame or two.
// With a range, the drift is read every 100 ms until the first nudge lands, d0 = the last reading before it, and if d0 is outside the
// range the scenario is run again with a stall length corrected by the shortfall (at most 3 runs, every one in out.attempts). The
// assertions on d0 and on the heal are the same ones: a bind that heals wrongly still fails them on the run that is judged.
async function scenarioStall(ms, beatsAfter, range) {
  const { ctx, page, problems } = await open();
  const out = { problems, trace: [], ms, attempts: [] };
  await page.evaluate(() => SF.start(9));
  await page.waitForFunction(() => SF.info().beat >= 10 && SF.audio().drift !== null, null, { timeout: 60000 });
  const snap = async tag => { const r = await page.evaluate(() => ({ b: SF.info().beat, a: SF.audio() })); out.trace.push([tag, r.b, r.a.drift === null ? null : +r.a.drift.toFixed(2), r.a.rearms, r.a.nudges, r.a.anchor]); return r.a; };
  if (!range) {
    out.before = await snap('before');
    await BLOCK(ms)(page);
    out.justAfter = await snap('stall+0');
  } else {
    for (let attempt = 0; ; attempt++) {
      out.trace = []; out.ms = ms; // the trace is the judged (last) run only
      out.before = await snap('before');
      const simF0 = await page.evaluate(() => SF.audio().simF);
      await BLOCK(ms)(page);
      await page.waitForFunction(f => SF.audio().simF !== f, simF0, WAIT); // the sim's first step after the block
      let settled = null; const t0 = Date.now();
      for (;;) {
        const a = await snap('s');
        if (a.nudges > out.before.nudges || Date.now() - t0 > 10000) break;
        settled = a; await page.waitForTimeout(100);
      }
      out.justAfter = settled || out.trace[1] && { drift: out.trace[1][2], nudges: out.before.nudges };
      out.attempts.push([ms, out.justAfter.drift]);
      if (attempt >= 2 || (out.justAfter.drift > range[0] && out.justAfter.drift <= range[1])) break;
      ms = Math.min(450, Math.max(260, Math.round(ms + ((range[0] + range[1]) / 2 - out.justAfter.drift) * (1000 / 60))));
      await page.waitForFunction(() => { const a = SF.audio(); return a.drift !== null && Math.abs(a.drift) <= 1; }, null, { timeout: 30000 });
      await page.waitForTimeout(500);
    }
  }
  for (let i = 0; i < beatsAfter; i++) { await page.waitForTimeout(500); out.last = await snap('+' + (i + 1) * 0.5 + 's'); }
  out.final = out.last;
  await ctx.close();
  return out;
}
test('a 1 s stall: drift jumps, then the track re-anchors on a bar edge and drift is back within 1 frame (never builds up)', async () => {
  const o = await scenarioStall(1000, 16);
  if (process.env.S13B_TRACE) console.log('TRACE stall1000', JSON.stringify(o.trace));
  assert.ok(Math.abs(o.before.drift) <= 1, 'locked before the stall: ' + o.before.drift);
  assert.ok(o.justAfter.drift > 20, 'the audio clock ran on during the stall (drift is measured on the audio clock, not the wall clock): ' + JSON.stringify(o.trace));
  assert.ok(o.final.rearms >= o.before.rearms + 1, 're-armed (a drift past 6 frames is not nudged): ' + JSON.stringify(o.trace));
  assert.ok(typeof o.final.drift === 'number' && Math.abs(o.final.drift) <= 1, 'drift back within 1 frame 8 s after a 1 s stall: ' + JSON.stringify(o.trace));
  assert.equal(o.final.anchor % 25, 0, 'the new anchor is on the sim beat grid');
  assert.equal(o.final.track, 'bonus');
  noProblems(o, 'stall1000');
});
test('a 250 ms stall (the sim catch-up limit) leaves drift small and it is back within 1 frame', async () => {
  const o = await scenarioStall(250, 8);
  if (process.env.S13B_TRACE) console.log('TRACE stall250', JSON.stringify(o.trace));
  assert.ok(typeof o.final.drift === 'number' && Math.abs(o.final.drift) <= 1, 'back within 1 frame: ' + JSON.stringify(o.trace));
  assert.equal(o.final.track, 'bonus');
  noProblems(o, 'stall250');
});
test('a small drift (a ~330 ms stall) heals by nudging, at most 2 frames per bar, without a re-arm', async () => {
  const o = await scenarioStall(330, 16, [3.6, 6]);
  if (process.env.S13B_TRACE) console.log('TRACE stall330', JSON.stringify(o.attempts), JSON.stringify(o.trace));
  const d0 = o.justAfter.drift;
  assert.ok(d0 > 3.6 && d0 <= 6, 'the stall left a small drift (audio ahead, past 3.6 and under the 6 frame re-arm): ' + JSON.stringify(o.trace));
  const after = o.trace.slice(1).map(t => t[2]).filter(d => d !== null);
  for (let i = 1; i < after.length; i++) assert.ok(Math.abs(after[i] - after[i - 1]) <= 2.6, `drift moved by more than the 2 frame clamp between samples: ${JSON.stringify(o.trace)}`);
  assert.ok(after.some(d => d >= d0 - 2.6 && d <= d0 - 1.0), 'a capped step on the way (one bar moves at most 2 frames, not all of it at once): ' + JSON.stringify(o.trace));
  assert.ok(Math.abs(o.final.drift) <= 1, 'healed: ' + JSON.stringify(o.trace));
  assert.ok(o.final.nudges > o.before.nudges, 'by nudging: ' + JSON.stringify(o.trace));
  assert.ok(o.final.nudges - o.justAfter.nudges <= 6, 'one nudge per bar, not one per step: ' + JSON.stringify(o.trace));
  assert.equal(o.final.rearms, o.before.rearms, 'no re-arm for a small drift');
  noProblems(o, 'stall330');
});

// fast-forward through the hooks (frames run far faster than the wall clock): the re-arm keeps drift from sticking at -586
test('fast-forward through test hooks: drift is not left stuck, the track re-anchors and locks again', async () => {
  const { ctx, page, problems } = await open();
  await page.evaluate(() => SF.start(9));
  await page.waitForFunction(() => SF.info().beat >= 8 && SF.audio().drift !== null, null, { timeout: 60000 });
  const ff = await page.evaluate(() => { SF.god(); SF.autoFireLoud(600, 0, false); return SF.audio(); });
  assert.ok(ff.drift < -100, 'the fast-forward left a huge negative drift: ' + JSON.stringify(ff));
  await page.waitForFunction(r => SF.audio().rearms > r, ff.rearms, WAIT);
  let last;
  await page.waitForFunction(() => { const a = SF.audio(); return a.drift !== null && Math.abs(a.drift) <= 1; }, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  last = await aud(page);
  assert.ok(last.drift !== null && Math.abs(last.drift) <= 1, 'locked again after the fast-forward: ' + JSON.stringify(last));
  noProblems({ problems }, 'ff');
  await ctx.close();
});

// the bind's beat position is the SIM's beat grid: anchor on a 25-frame beat, and the sim frame the bind sees is the sim's own beat * 25
test('the bind is on the sim beat grid: anchor is a multiple of 25, pos matches the sim frame within 1, simF = beat x 25 at each beat edge', async () => {
  const { ctx, page, problems } = await open();
  await page.evaluate(() => SF.start(9));
  await page.waitForFunction(() => SF.info().beat >= 5 && SF.audio().drift !== null, null, { timeout: 60000 });
  // mute / unmute so the anchor is not the stage's first bar (k > 0)
  await page.keyboard.press('KeyM'); await page.waitForFunction(() => SF.audio().muted, null, WAIT);
  await page.keyboard.press('KeyM'); await page.waitForFunction(() => !SF.audio().muted && SF.audio().drift !== null, null, { timeout: 20000 });
  const a = await page.evaluate(() => { const x = SF.audio(); return { anchor: x.anchor, pos: x.pos, simF: x.simF, beat: SF.info().beat, bf: SF.info().beatFrames }; });
  assert.equal(a.bf, 25);
  assert.ok(a.anchor > 0 && a.anchor % 25 === 0, 'anchor on the sim beat grid: ' + JSON.stringify(a));
  assert.ok(Math.abs(a.pos - a.simF) <= 1, 'audio position matches the sim frame: ' + JSON.stringify(a));
  assert.equal(Math.floor(a.simF / 25), a.beat, 'the frame the bind is given is in the sim beat: ' + JSON.stringify(a));
  // step single sim frames: at every beat change the bind's frame is exactly beat x 25 (a beatPos off by one fails here)
  const edges = await page.evaluate(() => {
    const out = []; let prev = SF.info().beat;
    for (let i = 0; i < 80; i++) { SF.autoFireLoud(1, 0, false); const b = SF.info().beat; if (b !== prev) { out.push([b, SF.audio().simF]); prev = b; } }
    return out;
  });
  assert.ok(edges.length >= 3, 'saw beat edges: ' + JSON.stringify(edges));
  for (const [b, f] of edges) assert.equal(f, b * 25, `beat ${b} starts at bind frame ${f}`);
  noProblems({ problems }, 'grid');
  await ctx.close();
});

// MED4: the value, not the call count
test('the engine intensity equals SF.info().intensity (heat / 100), at heat 0 and after heat rises', async () => {
  const { ctx, page, problems } = await open();
  await page.evaluate(() => { SF.god(); SF.start(1); });
  await page.waitForTimeout(500);
  const z = await page.evaluate(() => ({ i: SF.info().intensity, e: SF.audio().intensity }));
  assert.equal(z.i, 0);
  assert.equal(z.e, 0, 'heat 0 -> engine intensity 0 (not inverted, not the 0.5 default): ' + JSON.stringify(z));
  await page.evaluate(() => { let n = 0; while (SF.info().intensity === 0 && SF.state !== 'results' && n++ < 400) SF.autoFire(600); });
  await page.waitForTimeout(300);
  const h = await page.evaluate(() => ({ i: SF.info().intensity, e: SF.audio().intensity }));
  assert.ok(h.i > 0, 'heat rose: ' + JSON.stringify(h));
  assert.equal(h.e, h.i, 'engine intensity is the sim intensity: ' + JSON.stringify(h));
  noProblems({ problems }, 'heatvalue');
  await ctx.close();
});
