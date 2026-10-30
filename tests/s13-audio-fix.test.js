// Audio checks for review findings and surviving mutants, driven through the real starfall.html in
// headless Chrome (system Chrome) with the page's real main.js, keyboard and window.SF. Real stage clears, a real boss kill,
// a real boss timeout, a real game over and a real STARLIGHT stage are played with SF.autoFireLoud (sim frames with sound on).
// Headless Chrome cannot be listened to: this pins what starts, when, and which track, not how it sounds.
// Findings: 1 keys while paused resume audio; 2 a jingle blocks music changes; 3 escaped boss gets bossDefeat; 4 Hound pop
// uses a stale kind; 5 STARLIGHT double stageClear and life jingle with no ship; 6 hidden tab keeps the audio running.
// Mutants: M1 two same-name map ids swapped; M3 explosion no longer sets the kill kind; M7 no clear / game over jingles;
// M8 boss clear plays stageClear; M10 big always full volume; M14 unpause never resumes; M15 no music change during a run;
// M18 music() ignores mute; M19 wrong name-entry track.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { SIM_MAP, KILL_KIND_OF, STARLIGHT_PERFECT } from '../games/starfall/audio-bind.js';
import { SFX, KILL_KINDS } from '../games/starfall/sfx.js';
import { TYPE_IDS } from '../games/starfall/sim/registry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = process.env.S13_SHOT_DIR || null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const WAIT = { timeout: 30000 };
let server, browser, url;

const SPIES = `(() => {
  window.__audio = 0; window.__ctxs = [];
  const AC = window.BaseAudioContext || window.AudioContext;
  for (const n of ['createOscillator', 'createBufferSource']) { const f = AC.prototype[n]; AC.prototype[n] = function () { window.__audio++; return f.apply(this, arguments); }; }
  const cg = AC.prototype.createGain;
  AC.prototype.createGain = function () { if (window.__ctxs.length === 0) window.__ctxs.push(this); return cg.apply(this, arguments); };
  // a hidden tab, on demand: __hide(true) / __hide(false)
  let hid = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hid });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hid ? 'hidden' : 'visible') });
  window.__hide = v => { hid = !!v; document.dispatchEvent(new Event('visibilitychange')); };
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
  await page.keyboard.press('KeyQ'); // a gesture that is no game key: unlocks the audio
  await page.waitForFunction(() => SF.audio().unlocked, null, WAIT);
  return { ctx, page, problems };
}
const nodes = page => page.evaluate(() => window.__audio);
const aud = page => page.evaluate(() => SF.audio());
const last = page => page.evaluate(() => SF.audioLast());
const clock = page => page.evaluate(() => window.__ctxs[0].state);
const clockIs = (page, s) => page.waitForFunction(x => window.__ctxs[0].state === x, s, { timeout: 3000 }).then(() => s, async () => clock(page));
// sim frames with sound on until cond (a function source over SF) holds; the ship sweeps unless move is a number
function stepUntil(page, cond, max = 20000, fire = true, move = null) {
  return page.evaluate(([cond, max, fire, move]) => {
    const ok = new Function('return (' + cond + ')');
    let f = 0;
    while (!ok() && f < max) { const n = SF.autoFireLoud(1, move === null ? Math.sin(f / 150) * 0.9 : move, fire); if (!n) break; f++; }
    return ok();
  }, [cond, max, fire, move]);
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
  P.pause = scenarioPause(); P.clear = scenarioClear(); P.boss = scenarioBoss(); P.over = scenarioGameOver();
  P.star = scenarioStarlight(); P.kind = scenarioKinds(); P.hidden = scenarioHidden(); P.vol = scenarioVol();
  for (const k of Object.keys(P)) P[k].catch(() => {}); // reported by the test that awaits it
});
test.after(async () => { if (browser) await browser.close(); if (server) server.close(); });
const P = {};

// ---------- M1: every map entry pinned (no browser) ----------
test('map: every sim id pinned to its sound (a swap of any two entries fails); kill kinds pinned for every enemy type', () => {
  assert.deepEqual(SIM_MAP, {
    fire: 'shot', ding: 'hit', pop: 'kill', big: 'panelBreak', die: 'playerDie', kindle: 'kindle', life: 'extraLife', warp: 'warp',
    wingLost: 'wingLost', phase2: 'phase2', morph: 'morph', deflect: 'deflect', select: 'menuSelect', jingle: null, beat: null,
    bossDie: 'bossDie', powerup: 'powerup', powerdown: 'powerdown', cut: 'cut', hunt: 'hunt', snap: 'snap'
  });
  assert.deepEqual(KILL_KIND_OF, { moth: 'moth', wisp: 'wisp', warden: 'warden', splitter: 'splitter', spark: 'spark',
    prism: 'wisp', eel: 'spark', lamplighter: 'wisp', cinder: 'spark', mirage: 'wisp', tether: 'splitter' });
  for (const t of TYPE_IDS) assert.ok(KILL_KINDS.includes(KILL_KIND_OF[t]), t + ' has a kill kind of its own');
  assert.equal(STARLIGHT_PERFECT, 'coin'); assert.ok(SFX[STARLIGHT_PERFECT]);
});

// ---------- finding 1, M14: keys while paused; pause owns the clock ----------
async function scenarioPause() {
  const { ctx, page, problems } = await open();
  const out = { problems };
  await page.evaluate(() => SF.start(1));
  await page.waitForTimeout(300);
  out.run = await clock(page);
  await page.keyboard.press('KeyP');
  out.paused = await clockIs(page, 'suspended');
  // every mapped key that is not fire, pause or mute, and keys no map knows: no nodes, the clock stays suspended
  const keys = ['ArrowLeft', 'KeyA', 'ArrowRight', 'KeyD', 'ArrowUp', 'KeyW', 'ArrowDown', 'KeyS', 'KeyX', 'KeyK', 'ShiftLeft', 'ShiftRight',
    'Escape', 'Backspace', 'KeyQ', 'KeyJ', 'Digit1', 'Tab'];
  await page.waitForTimeout(150); // the engine's one look-ahead pump at the moment of suspension settles first
  const n0 = await nodes(page);
  out.after = [];
  for (const k of keys) { await page.keyboard.press(k); await page.waitForTimeout(40); out.after.push(k + ':' + (await clock(page))); }
  await page.waitForTimeout(500);
  out.grew = (await nodes(page)) - n0;
  // mute and unmute while paused: mute owns the gain only (unmute may queue the track, the clock stays suspended)
  for (const k of ['KeyM', 'KeyM']) { await page.keyboard.press(k); await page.waitForTimeout(80); out.after.push(k + ':' + (await clock(page))); }
  await page.waitForTimeout(300);
  out.held = await clock(page);
  out.track = (await aud(page)).track;
  await page.keyboard.press('KeyP');
  out.resumed = await clockIs(page, 'running');
  await ctx.close();
  return out;
}
test('pause: no key but P (or fire) resumes a paused audio clock; P resumes it (finding 1, M14)', async () => {
  const o = await P.pause;
  assert.equal(o.run, 'running'); assert.equal(o.paused, 'suspended');
  for (const r of o.after) assert.ok(r.endsWith(':suspended'), 'still suspended after ' + r);
  assert.equal(o.held, 'suspended'); assert.equal(o.grew, 0, 'no audio nodes while paused');
  assert.equal(o.track, 'z1');
  assert.equal(o.resumed, 'running', 'unpause resumes');
  noProblems(o, 'pause');
});

// ---------- finding 2, M7, M18: a real stage clear; jingles never block a track change; mute ----------
async function scenarioClear() {
  const { ctx, page, problems } = await open();
  const out = { problems };
  await page.evaluate(() => { SF.god(); SF.start(1); });
  const j0 = (await last(page)).jingles;
  out.reached = await stepUntil(page, "SF.state === 'clear'");
  out.clear = (await aud(page)).track; out.jingles = (await last(page)).jingles - j0;
  // the next stage takes over from the clear jingle at once (real ticks carry the clear into stage 2)
  await page.waitForFunction(() => SF.stage === 2, null, WAIT);
  out.stage2 = (await aud(page)).track;
  // a jingle in progress, then SF.start(6): z2 at once and still z2 3.5 s later
  await stepUntil(page, "SF.state === 'clear'");
  out.clear2 = (await aud(page)).track;
  await page.evaluate(() => SF.start(6));
  out.start6 = (await aud(page)).track;
  await page.waitForTimeout(3500);
  out.later6 = (await aud(page)).track;
  // mute during a jingle: the jingle stops; music() ignores nothing while muted (M18); unmute brings the wanted track
  await stepUntil(page, "SF.state === 'clear'");
  out.clear3 = (await aud(page)).track;
  await page.keyboard.press('KeyM');
  await page.waitForFunction(() => SF.audio().muted, null, WAIT);
  out.mutedClear = (await aud(page)).track;
  out.mutedStart = await page.evaluate(() => { SF.start(11); return SF.audio().track; });
  await page.waitForTimeout(200);
  out.mutedLater = (await aud(page)).track;
  await page.keyboard.press('KeyM');
  await page.waitForFunction(() => !SF.audio().muted, null, WAIT);
  out.unmuted = (await aud(page)).track;
  await ctx.close();
  return out;
}
test('stage clear: stageClear jingle; the next stage, SF.start and mute each stop it at once (finding 2, M7, M18)', async () => {
  const o = await P.clear;
  assert.equal(o.reached, true, 'stage 1 cleared');
  assert.equal(o.clear, 'stageClear'); assert.equal(o.jingles, 1, 'one jingle for one clear');
  assert.equal(o.stage2, 'z1', 'stage 2 plays its zone track');
  assert.equal(o.clear2, 'stageClear');
  assert.equal(o.start6, 'z2', 'SF.start(6) during a jingle: z2 at once');
  assert.equal(o.later6, 'z2', 'still z2 3.5 s later');
  assert.equal(o.clear3, 'stageClear');
  assert.equal(o.mutedClear, null, 'mute stops the jingle');
  assert.equal(o.mutedStart, null, 'muted: a new stage starts no music');
  assert.equal(o.mutedLater, null);
  assert.equal(o.unmuted, 'z3', 'unmute: the wanted track');
  noProblems(o, 'clear');
});

// ---------- finding 2, finding 3, M8, M15: a real boss kill, a natural 5 -> 6, a boss timeout ----------
async function scenarioBoss() {
  const { ctx, page, problems } = await open();
  const out = { problems };
  await page.evaluate(() => { SF.god(); SF.start(5); });
  out.fight = await stepUntil(page, 'SF.info().boss', 3000);
  out.fightTrack = (await aud(page)).track;
  await page.evaluate(() => SF.breakPanels(8)); // panels off; the core still has to be shot down
  const j0 = (await last(page)).jingles;
  out.killed = await stepUntil(page, "SF.state === 'clear'", 6000, true, 0);
  out.clear = (await aud(page)).track; out.jingles = (await last(page)).jingles - j0;
  // the natural move to stage 6: real ticks, no SF.start
  await page.waitForFunction(() => SF.stage === 6 && SF.state === 'play', null, WAIT);
  out.stage6 = (await aud(page)).track;
  await page.waitForTimeout(1500);
  out.stage6later = (await aud(page)).track;
  if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, 's13-stage6.png') });
  out.audio6 = await aud(page);
  // a boss that escapes: no fire until the timeout; no bossDefeat
  await page.evaluate(() => SF.start(5));
  const j1 = (await last(page)).jingles;
  out.passed = await stepUntil(page, "SF.state === 'clear'", 7000, false, 0);
  out.passClear = (await aud(page)).track; out.passJingles = (await last(page)).jingles - j1;
  await stepUntil(page, 'SF.stage === 6', 400, false, 0);
  out.passStage6 = (await aud(page)).track;
  await ctx.close();
  return out;
}
test('boss: a real kill plays bossDefeat, stage 6 then plays z2 (natural 5 -> 6); an escaped boss gets no bossDefeat (findings 2, 3, M8, M15)', async () => {
  const o = await P.boss;
  assert.equal(o.fight, true); assert.equal(o.fightTrack, 'boss1');
  assert.equal(o.killed, true, 'boss killed and stage cleared');
  assert.equal(o.clear, 'bossDefeat', 'a destroyed boss: bossDefeat'); assert.equal(o.jingles, 1);
  assert.equal(o.stage6, 'z2', 'stage 6 in play: z2'); assert.equal(o.stage6later, 'z2', 'bossDefeat does not come back');
  assert.equal(o.passed, true, 'boss timed out and stage cleared');
  assert.equal(o.passClear, null, 'an escaped boss: no jingle'); assert.equal(o.passJingles, 0);
  assert.equal(o.passStage6, 'z2');
  noProblems(o, 'boss');
});

// ---------- finding 2, M7, M19: a real game over, results, name entry, title, attract ----------
async function scenarioGameOver() {
  const { ctx, page, problems } = await open();
  const out = { problems };
  await page.evaluate(() => SF.start(1)); // a free run (no god: it must be able to submit)
  await stepUntil(page, "SF.info().lives === 0", 60000);
  const j0 = (await last(page)).jingles;
  out.over = await stepUntil(page, "SF.state === 'gameover'", 60000);
  out.overTrack = (await aud(page)).track; out.jingles = (await last(page)).jingles - j0;
  out.results = await stepUntil(page, "SF.state === 'results'", 400, false, 0);
  out.resultsTrack = (await aud(page)).track;
  await page.waitForTimeout(1200);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => SF.state !== 'results', null, WAIT);
  out.state = await page.evaluate(() => SF.state);
  out.entryTrack = (await aud(page)).track;
  await page.evaluate(() => SF.nameEntry('ABC'));
  await page.waitForFunction(() => SF.state === 'title', null, WAIT);
  out.titleTrack = (await aud(page)).track;
  await page.evaluate(() => SF.attractNow());
  await page.waitForTimeout(900); // the title track's last scheduled notes and its fade
  const a0 = await nodes(page);
  await page.waitForTimeout(3000);
  out.attractGrew = (await nodes(page)) - a0;
  out.attractTrack = (await aud(page)).track; out.attractState = await page.evaluate(() => SF.state);
  await ctx.close();
  return out;
}
test('game over: gameOver jingle, name entry plays nameEntry, title plays title, attract is silent (finding 2, M7, M19)', async () => {
  const o = await P.over;
  assert.equal(o.over, true, 'the run ended');
  assert.equal(o.overTrack, 'gameOver'); assert.equal(o.jingles, 1);
  assert.equal(o.results, true); assert.equal(o.resultsTrack, 'gameOver', 'the jingle runs on over the results');
  assert.equal(o.state, 'entry', 'a free run with a score goes to name entry');
  assert.equal(o.entryTrack, 'nameEntry');
  assert.equal(o.titleTrack, 'title');
  assert.equal(o.attractState, 'attract'); assert.equal(o.attractTrack, null); assert.equal(o.attractGrew, 0, 'attract creates no audio nodes');
  noProblems(o, 'gameover');
});

// ---------- finding 5, extra-life ruling: STARLIGHT and life ----------
async function scenarioStarlight() {
  const { ctx, page, problems } = await open();
  const out = { problems };
  // extra life on a normal stage: the extraLife sound, no jingle, the zone track runs on
  await page.evaluate(() => SF.start(1));
  await page.waitForTimeout(200);
  out.life = await page.evaluate(() => { const j = SF.audioLast().jingles; const ok = SF.fxTest('sfx', 'life'); const L = SF.audioLast(); return { ok, sfx: L.sfx, j: L.jingles - j, track: SF.audio().track }; });
  await page.waitForTimeout(1500);
  out.lifeLater = (await aud(page)).track;
  // a STARLIGHT stage played through
  await page.evaluate(() => { SF.god(); SF.start(4); });
  await page.waitForTimeout(200);
  out.bonusTrack = (await aud(page)).track;
  // life with no ship awarded (what a perfect sends): not the extra-life sound, no jingle
  out.perfect = await page.evaluate(() => { const j = SF.audioLast().jingles; const ok = SF.fxTest('sfx', 'life'); const L = SF.audioLast(); return { ok, sfx: L.sfx, j: L.jingles - j, track: SF.audio().track }; });
  const j0 = (await last(page)).jingles;
  out.end = await stepUntil(page, "SF.state === 'bonusEnd'");
  out.endTrack = (await aud(page)).track; out.endJ = (await last(page)).jingles - j0;
  out.clear = await stepUntil(page, "SF.state === 'clear'", 400, false, 0);
  out.clearTrack = (await aud(page)).track; out.clearJ = (await last(page)).jingles - j0;
  await stepUntil(page, 'SF.stage === 5', 400, false, 0);
  out.nextTrack = (await aud(page)).track; out.nextJ = (await last(page)).jingles - j0;
  await ctx.close();
  return out;
}
test('STARLIGHT: one stageClear per bonus stage; life with no ship is not the extra-life cue; extra life keeps the zone track (finding 5)', async () => {
  const o = await P.star;
  assert.deepEqual(o.life, { ok: true, sfx: 'extraLife', j: 0, track: 'z1' }, 'extra life: sound only, zone track runs on');
  assert.equal(o.lifeLater, 'z1');
  assert.equal(o.bonusTrack, 'bonus');
  assert.deepEqual(o.perfect, { ok: true, sfx: 'coin', j: 0, track: 'bonus' }, 'STARLIGHT life without a ship');
  assert.equal(o.end, true); assert.equal(o.endTrack, 'stageClear'); assert.equal(o.endJ, 1);
  assert.equal(o.clear, true); assert.equal(o.clearTrack, 'stageClear'); assert.equal(o.clearJ, 1, 'the clear after bonusEnd adds no second stageClear');
  assert.equal(o.nextTrack, 'boss1'); assert.equal(o.nextJ, 1);
  noProblems(o, 'starlight');
});

// ---------- finding 4, M3: kill kinds from real kills; the Hound's pop is neutral ----------
async function scenarioKinds() {
  const { ctx, page, problems } = await open();
  const out = { problems };
  out.rows = await page.evaluate(() => {
    SF.god(); SF.start(13);
    const rows = []; let f = 0, hn = 0, pops = SF.audioLast().pops;
    while (SF.stage === 13 && f < 20000) {
      SF.autoFireLoud(1, Math.sin(f / 150) * 0.9); f++;
      const h = SF.info().hounds, L = SF.audioLast();
      if (L.pops !== pops) { pops = L.pops; rows.push([h < hn ? 'hound' : 'enemy', L.pop]); }
      hn = h;
    }
    return rows;
  });
  await ctx.close();
  return out;
}
test('kill kinds: real kills take their kind from their own explosion; a Hound kill after other kills is neutral (finding 4, M3)', async () => {
  const o = await P.kind;
  const enemy = o.rows.filter(r => r[0] === 'enemy').map(r => r[1]), hound = o.rows.filter(r => r[0] === 'hound').map(r => r[1]);
  assert.ok(enemy.length > 10, 'real kills: ' + enemy.length);
  assert.ok(enemy.every(k => KILL_KINDS.includes(k)), 'every real enemy kill has a kind: ' + enemy.join(','));
  assert.ok(enemy.includes('warden') && enemy.includes('wisp'), 'warden and wisp kills seen');
  assert.ok(hound.length >= 1, 'a Hound was killed');
  const at = o.rows.findIndex(r => r[0] === 'hound');
  assert.ok(at > 0 && o.rows[at - 1][1] !== null, 'a kill with a kind came just before the Hound kill');
  assert.ok(hound.every(k => k === null), 'Hound kills are neutral, never a stale kind: ' + hound.join(','));
  noProblems(o, 'kinds');
});

// ---------- finding 6: hidden tab ----------
async function scenarioHidden() {
  const { ctx, page, problems } = await open();
  const out = { problems };
  await page.evaluate(() => SF.start(1));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__hide(true));
  out.hidden = await clockIs(page, 'suspended');
  await page.waitForTimeout(300);
  const n0 = await nodes(page); await page.waitForTimeout(800); out.hiddenGrew = (await nodes(page)) - n0;
  await page.evaluate(() => window.__hide(false));
  out.visible = await clockIs(page, 'running');
  // hidden during pause: visible again stays suspended until unpause
  await page.keyboard.press('KeyP');
  await clockIs(page, 'suspended');
  await page.evaluate(() => window.__hide(true)); await page.waitForTimeout(100);
  await page.evaluate(() => window.__hide(false)); await page.waitForTimeout(300);
  out.pausedVisible = await clock(page);
  await page.keyboard.press('KeyP');
  out.unpaused = await clockIs(page, 'running');
  // hidden while muted: visible again stays suspended until unmute
  await page.keyboard.press('KeyM');
  await page.waitForFunction(() => SF.audio().muted, null, WAIT);
  await page.evaluate(() => window.__hide(true)); await page.waitForTimeout(100);
  await page.evaluate(() => window.__hide(false)); await page.waitForTimeout(300);
  out.mutedVisible = await clock(page);
  await page.keyboard.press('KeyM');
  out.unmuted = await clockIs(page, 'running');
  out.track = (await aud(page)).track;
  await ctx.close();
  return out;
}
test('hidden tab: suspends the audio; visible resumes only when not paused and not muted (finding 6)', async () => {
  const o = await P.hidden;
  assert.equal(o.hidden, 'suspended'); assert.equal(o.hiddenGrew, 0, 'no music scheduled while hidden');
  assert.equal(o.visible, 'running');
  assert.equal(o.pausedVisible, 'suspended'); assert.equal(o.unpaused, 'running');
  assert.equal(o.mutedVisible, 'suspended'); assert.equal(o.unmuted, 'running'); assert.equal(o.track, 'z1');
  noProblems(o, 'hidden');
});

// ---------- M10: big is quieter without a boss ----------
async function scenarioVol() {
  const { ctx, page, problems } = await open();
  const out = { problems };
  out.noBoss = await page.evaluate(() => { SF.fxTest('sfx', 'big'); const L = SF.audioLast(); return [L.sfx, L.vol]; });
  await page.evaluate(() => { SF.god(); SF.start(5); });
  out.boss = await stepUntil(page, 'SF.info().boss', 3000);
  await page.waitForTimeout(50);
  out.withBoss = await page.evaluate(() => { SF.fxTest('sfx', 'big'); const L = SF.audioLast(); return [L.sfx, L.vol]; });
  // endless (stage 16 and on): normal stages play the endless track, boss and bonus stages keep theirs
  out.endless = await page.evaluate(() => [16, 19, 20, 26].map(n => { SF.start(n); return SF.audio().track; }));
  await ctx.close();
  return out;
}
test('big: panelBreak at half volume without a boss, full volume with one (M10); endless track from stage 16', async () => {
  const o = await P.vol;
  assert.deepEqual(o.noBoss, ['panelBreak', 0.5]);
  assert.equal(o.boss, true);
  assert.deepEqual(o.withBoss, ['panelBreak', 1]);
  assert.deepEqual(o.endless, ['endless', 'bonus', 'boss1', 'endless'], 'stages 16, 19, 20, 26');
  noProblems(o, 'vol');
});
