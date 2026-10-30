// S13a: the game plays its sounds and music through engine/audio.js (games/starfall/audio-bind.js). Drives the real
// starfall.html in headless Chrome (system Chrome) with page spies on AudioContext node creation, like s12-wiring.test.js.
// Headless Chrome cannot be listened to: this pins what starts, when, and which track, not how it sounds.
// Mutants this file kills: two map entries swapped, kill kind dropped, ding/big ignoring a live boss, music played in attract,
// pause skipped, mute not zeroing the master gain or stopping music, fxTest always true, a silent id that makes sound,
// a jingle that never returns to the zone track, wrong zone/boss/bonus track.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { SIM_MAP, SILENT_IDS } from '../games/starfall/audio-bind.js';
import { SFX } from '../games/starfall/sfx.js';
import { TRACKS, ZONE_TRACKS, BOSS_TRACKS } from '../games/starfall/music.js';
import { SFX_NAMES } from '../games/starfall/defs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = process.env.S13_SHOT_DIR || null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const WAIT = { timeout: 30000 };
let server, browser, url;

const SPIES = `(() => {
  window.__audio = 0; window.__gains = []; window.__ctxs = [];
  const AC = window.BaseAudioContext || window.AudioContext;
  for (const n of ['createOscillator', 'createBufferSource']) { const f = AC.prototype[n]; AC.prototype[n] = function () { window.__audio++; return f.apply(this, arguments); }; }
  const cg = AC.prototype.createGain;
  AC.prototype.createGain = function () { const g = cg.apply(this, arguments); if (window.__gains.length === 0) { window.__gains.push(g); window.__ctxs.push(this); } return g; };
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
  return { ctx, page, problems };
}
const unlock = async page => { await page.keyboard.press('KeyQ'); await page.waitForFunction(() => SF.audio().unlocked, null, WAIT); };
const nodes = page => page.evaluate(() => window.__audio);
const aud = page => page.evaluate(() => SF.audio());
async function toTitle(page) {
  await page.evaluate(() => SF.skip());
  await page.waitForFunction(() => SF.state === 'title', null, WAIT);
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
  // the scenarios share nothing: start them together so the file stays fast
  P.ids = scenarioIds(); P.music = scenarioMusic(); P.mute = scenarioMute(); P.attract = scenarioAttract(); P.pause = scenarioPause(); P.jingle = scenarioJingle();
  for (const k of Object.keys(P)) P[k].catch(() => {}); // reported by the test that awaits it
});
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });
const P = {};

// ---------- the map itself (no browser) ----------
test('map: every sim sound id has an entry; every target exists in sfx.js; only the documented ids are silent', () => {
  assert.deepEqual(Object.keys(SIM_MAP).sort(), [...SFX_NAMES].sort());
  for (const [id, target] of Object.entries(SIM_MAP)) if (target !== null) assert.ok(SFX[target], `${id} -> ${target} exists in sfx.js`);
  assert.deepEqual(SILENT_IDS, ['jingle', 'beat']);
  // pinned pairs: a swapped pair of entries must fail here
  const pins = { fire: 'shot', ding: 'hit', pop: 'kill', big: 'panelBreak', die: 'playerDie', life: 'extraLife', bossDie: 'bossDie', select: 'menuSelect', cut: 'cut', snap: 'snap', hunt: 'hunt', powerup: 'powerup', powerdown: 'powerdown' };
  for (const [k, v] of Object.entries(pins)) assert.equal(SIM_MAP[k], v, k);
});

// ---------- sim ids in the real page ----------
async function scenarioIds() {
  const { ctx, page, problems } = await open();
  const out = { problems };
  out.locked = await page.evaluate(() => ({ cut: SF.fxTest('sfx', 'cut'), nodes: window.__audio, a: SF.audio() }));
  await toTitle(page); await unlock(page);
  out.rows = [];
  for (const id of SFX_NAMES) {
    // one evaluate: no title-music note can land between the two node counts (by design)
    const r = await page.evaluate(n => { const before = window.__audio; const ok = SF.fxTest('sfx', n); return { ok, grew: window.__audio - before }; }, id);
    out.rows.push({ id, ok: r.ok, grew: r.grew });
    await page.waitForTimeout(30);
  }
  out.unknown = await page.evaluate(() => [SF.fxTest('sfx', 'nope'), SF.fxTest('sfx', 99), SF.fxTest('sfx', -1), SF.fxTest('nothing', 'cut')]);
  // kill kinds: the second argument of 'pop' is the enemy type index (moth 0, wisp 1, warden 2, splitter 3, spark 4)
  out.kinds = [];
  for (const [ti, kind] of [[0, 'moth'], [1, 'wisp'], [2, 'warden'], [3, 'splitter'], [4, 'spark']]) {
    await page.evaluate(t => SF.fxTest('sfx', 'pop', t), ti);
    out.kinds.push([kind, (await page.evaluate(() => SF.audioLast())).kind]);
    await page.waitForTimeout(30);
  }
  // ding and big while no boss is on, then while a boss is on (stage 5)
  const lastOf = async n => { await page.waitForTimeout(30); await page.evaluate(x => SF.fxTest('sfx', x), n); return (await page.evaluate(() => SF.audioLast())).sfx; };
  out.noBoss = [await lastOf('ding'), await lastOf('big')];
  await page.evaluate(() => { SF.god(); SF.start(5); });
  await page.evaluate(() => { let n = 0; while (!SF.info().boss && n++ < 60) SF.autoFire(30); });
  out.bossOn = await page.evaluate(() => SF.info().boss);
  out.boss = [await lastOf('ding'), await lastOf('big')];
  // rapid events: a chain of 20 kills and a volley in one frame must not throw or pile up past the voice cap
  out.rapid = await page.evaluate(() => { for (let i = 0; i < 20; i++) { SF.fxTest('sfx', 'pop', i % 5); SF.fxTest('sfx', 'fire'); SF.fxTest('sfx', 'ding'); } return SF.audio().unlocked; });
  await page.waitForTimeout(300);
  await ctx.close();
  return out;
}
test('every sim sound id starts nodes, or is on the documented silent list; fxTest is honest', async () => {
  const o = await P.ids;
  assert.equal(o.locked.cut, false, 'before unlock fxTest sfx is false');
  assert.equal(o.locked.nodes, 0, 'before unlock no audio nodes exist');
  assert.equal(o.locked.a.unlocked, false);
  for (const r of o.rows) {
    if (SILENT_IDS.includes(r.id)) { assert.equal(r.ok, false, r.id + ' is silent: false'); assert.equal(r.grew, 0, r.id + ' creates no nodes'); }
    else { assert.equal(r.ok, true, r.id + ' plays'); assert.ok(r.grew > 0, r.id + ' creates nodes'); }
  }
  assert.deepEqual(o.unknown, [false, false, false, false]);
  for (const [want, got] of o.kinds) assert.equal(got, want, 'kill kind');
  assert.deepEqual(o.noBoss, ['hit', 'panelBreak']);
  assert.equal(o.bossOn, true, 'a boss is on at stage 5');
  assert.deepEqual(o.boss, ['bossHit', 'panelBreak']);
  assert.equal(o.rapid, true);
  noProblems(o, 'ids');
});

// ---------- music by stage ----------
async function scenarioMusic() {
  const { ctx, page, problems } = await open();
  const out = { problems, rows: {} };
  out.before = await page.evaluate(() => { SF.start(6); return SF.audio(); }); // not unlocked yet: the wanted track is still reported
  await unlock(page);
  await page.evaluate(() => SF.page('main'));
  out.title = await aud(page);
  for (const n of [1, 6, 11, 5, 10, 15, 4]) {
    out.rows[n] = await page.evaluate(s => { SF.start(s); return SF.audio(); }, n);
    if (n === 6) {
      await page.evaluate(() => SF.autoFire(60));
      await page.waitForTimeout(300);
      if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, 's13-stage6.png') });
    }
  }
  await ctx.close();
  return out;
}
test('music: zone track by zone, boss track on boss stages, bonus on STARLIGHT, title on the title', async () => {
  const o = await P.music;
  assert.equal(o.before.track, 'z2', 'SF.start(6); SF.audio().track === z2 (design verify line)');
  assert.equal(o.before.unlocked, false);
  assert.equal(o.title.track, 'title'); assert.equal(o.title.drift, null); assert.equal(o.title.muted, false);
  const want = { 1: ZONE_TRACKS[1], 6: ZONE_TRACKS[2], 11: ZONE_TRACKS[3], 5: BOSS_TRACKS[1], 10: BOSS_TRACKS[2], 15: BOSS_TRACKS[3], 4: 'bonus' };
  assert.deepEqual([want[1], want[6], want[11], want[5], want[10], want[15]], ['z1', 'z2', 'z3', 'boss1', 'boss2', 'boss3']);
  for (const [n, w] of Object.entries(want)) { assert.equal(o.rows[n].track, w, 'stage ' + n); assert.equal(o.rows[n].bpm, TRACKS[w].bpm, 'bpm of ' + w); assert.equal(o.rows[n].unlocked, true); }
  noProblems(o, 'music');
});

// ---------- mute ----------
async function scenarioMute() {
  const { ctx, page, problems } = await open();
  const out = { problems };
  await toTitle(page); await unlock(page);
  await page.waitForTimeout(200);
  out.gain0 = await page.evaluate(() => window.__gains[0].gain.value);
  out.playing = await aud(page);
  await page.keyboard.press('KeyM');
  await page.waitForFunction(() => SF.audio().muted, null, WAIT);
  await page.waitForTimeout(300);
  out.gainMuted = await page.evaluate(() => window.__gains[0].gain.value);
  out.muted = await aud(page);
  out.mutedSfx = await page.evaluate(() => SF.fxTest('sfx', 'cut'));
  const n0 = await nodes(page); await page.waitForTimeout(700); out.mutedGrowth = (await nodes(page)) - n0;
  await page.keyboard.press('KeyM');
  await page.waitForFunction(() => !SF.audio().muted, null, WAIT);
  await page.waitForTimeout(300);
  out.gainBack = await page.evaluate(() => window.__gains[0].gain.value);
  out.back = await aud(page);
  await ctx.close();
  return out;
}
test('mute: master gain 0, music stops, sfx report false; unmute brings the track back', async () => {
  const o = await P.mute;
  assert.ok(o.gain0 > 0.5); assert.equal(o.playing.track, 'title');
  assert.equal(o.muted.muted, true); assert.equal(o.muted.track, null);
  assert.ok(o.gainMuted < 0.01, 'master gain ' + o.gainMuted);
  assert.equal(o.mutedSfx, false); assert.equal(o.mutedGrowth, 0, 'no nodes while muted');
  assert.equal(o.back.muted, false); assert.equal(o.back.track, 'title'); assert.ok(o.gainBack > 0.5);
  noProblems(o, 'mute');
});

// ---------- attract ----------
async function scenarioAttract() {
  const { ctx, page, problems } = await open();
  const out = { problems };
  await toTitle(page); await unlock(page);
  await page.waitForTimeout(200);
  await page.evaluate(() => SF.attractNow());
  await page.waitForTimeout(900); // the title track's last scheduled notes (0.25 s look-ahead) and its fade
  out.a0 = await nodes(page);
  await page.evaluate(() => SF.autoFire && 0);
  await page.waitForTimeout(2500);
  out.a1 = await nodes(page);
  out.audio = await aud(page); out.state = await page.evaluate(() => SF.state);
  await ctx.close();
  return out;
}
test('attract: no music and no sound effects, no audio nodes created', async () => {
  const o = await P.attract;
  assert.equal(o.state, 'attract');
  assert.equal(o.audio.track, null);
  assert.equal(o.a1, o.a0, 'node count flat during attract');
  noProblems(o, 'attract');
});

// ---------- pause ----------
async function scenarioPause() {
  const { ctx, page, problems } = await open();
  const out = { problems };
  await toTitle(page); await unlock(page);
  await page.evaluate(() => SF.start(1));
  await page.waitForTimeout(300);
  out.run = await page.evaluate(() => window.__ctxs[0].state);
  await page.keyboard.press('KeyP');
  await page.waitForFunction(() => window.__ctxs[0].state === 'suspended', null, WAIT).then(() => { out.paused = 'suspended'; }, () => { out.paused = 'not suspended'; });
  await page.keyboard.press('KeyP');
  await page.waitForFunction(() => window.__ctxs[0].state === 'running', null, WAIT).then(() => { out.resumed = 'running'; }, () => { out.resumed = 'not running'; });
  out.track = (await aud(page)).track;
  await ctx.close();
  return out;
}
test('pause suspends the audio clock and unpause resumes it', async () => {
  const o = await P.pause;
  assert.equal(o.run, 'running'); assert.equal(o.paused, 'suspended'); assert.equal(o.resumed, 'running'); assert.equal(o.track, 'z1');
  noProblems(o, 'pause');
});

// ---------- jingles ----------
async function scenarioJingle() {
  const { ctx, page, problems } = await open();
  const out = { problems };
  await toTitle(page); await unlock(page);
  await page.evaluate(() => SF.start(1));
  await page.waitForTimeout(200);
  out.before = (await aud(page)).track;
  await page.evaluate(() => SF.fxTest('sfx', 'life'));
  out.during = (await aud(page)).track;
  out.lastSfx = (await page.evaluate(() => SF.audioLast())).sfx;
  out.back = await page.waitForFunction(() => SF.audio().track === 'z1', null, { timeout: 8000 }).then(() => true, () => false);
  // a run that ends: game over jingle, then (nothing is submitted for a stage start) the title returns
  await page.evaluate(() => { SF.god(false); });
  await ctx.close();
  return out;
}
// By design: an extra life plays the extraLife SFX and the zone track keeps playing (no jingle)
test('extra life: the extraLife sound plays and the zone track keeps playing', async () => {
  const o = await P.jingle;
  assert.equal(o.before, 'z1'); assert.equal(o.during, 'z1'); assert.equal(o.lastSfx, 'extraLife'); assert.equal(o.back, true);
  noProblems(o, 'jingle');
});
