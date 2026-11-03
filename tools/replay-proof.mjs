// Replay proof: play Starfall in headless Chrome, then re-simulate the recorded replay in Node and
// require the exact same score, frame count and state hash.
//
// Usage:
//   node tools/replay-proof.mjs [seconds=90] [outFile=shots/replay-proof.txt]   default run
//   node tools/replay-proof.mjs --mode=<name> [--seconds=N]                     one mode
//   node tools/replay-proof.mjs --all [--seconds=N]                             every mode, then STACKLIGHT
//   node tools/replay-proof.mjs --game stacklight                               STACKLIGHT only (card T6)
//   node tools/replay-proof.mjs --likeness [--runs=24]                          STACKLIGHT same-seed likeness table
// Modes:
//   default  title -> START GAME with real keys, 90 s of keyboard play, at least one death required
//   bonus    run started at stage 4 (STARLIGHT bonus) with SF.start(4), keyboard play
//   boss     run started at stage 5 (ECLIPSE boss) with SF.start(5), keyboard play
//   touch    keyboard starts the run, then only scripted touch input (TouchEvent via dispatchEvent)
//   pause    keyboard play with a pause (P) mid-run, and a window blur while keys are held
//   late     one 20 s keyboard run each from SF.start(n), n = 2, 3, 6, 7, 8, 11, 12, 13, each re-simulated
//            (C2-0: the stages B.11 changes; every one must match)
// Stage starts use mode 'stageN', which is not tainted. Every mode needs score > 0 and an exact match.
// Serves the repo itself on a free port, so no other server is needed. Exits 1 on any failure.
//
// STACKLIGHT (card T6; no stacklight.html exists yet, so the browser side is a bare page the tool serves that imports
// games/stacklight/sim.js): the 3 golden replays of tests/stacklight-golden.test.js are re-simulated in headless Chrome
// and in a separate Node process, and both must give the stored score, lines, frames and hash (so a sim change that
// both sides share still FAILs). Then 4 bot runs (Free Play and Daily) are PLAYED in Chrome by the word bot below, and
// the replay the browser recorded is re-simulated in Node: score, lines, level, frames and hash must be identical.
// --likeness (Node only): honest bot runs with different word scripts on one seed, their near-copy signatures
// (server/dedupe.js, as server/verify.js pass A records them) compared pair by pair, against NEAR, and the copy attacks
// (time shifts at the start and mid-run, one-bit flips early and late, a shift plus a flip, the same placements on a new
// timing). It FAILs if honest runs reach NEAR or if any copy keeps 90% or more of the score and gets under NEAR.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_URL = pathToFileURL(ROOT).href + '/';
const MODES = ['default', 'bonus', 'boss', 'touch', 'pause', 'late'];
const LATE_STAGES = [2, 3, 6, 7, 8, 11, 12, 13];
const argv = process.argv.slice(2);
const flag = name => { const a = argv.find(x => x.startsWith('--' + name + '=')); return a ? a.split('=')[1] : null; };
const pos = argv.filter(a => !a.startsWith('--'));
const ALL = argv.includes('--all');
const ONE = flag('mode');
if (ONE && !MODES.includes(ONE)) { console.error('unknown mode ' + ONE + '; modes: ' + MODES.join(', ')); process.exit(2); }
const gi = argv.indexOf('--game');
const GAME = flag('game') || (gi >= 0 ? argv[gi + 1] : null);
if (GAME && GAME !== 'starfall' && GAME !== 'stacklight') { console.error('unknown game ' + GAME + '; games: starfall, stacklight'); process.exit(2); }
if (gi >= 0 && argv[gi + 1]) pos.splice(pos.indexOf(argv[gi + 1]), 1); // '--game stacklight': the name is not a seconds value
const SL_ONLY = GAME === 'stacklight';
if (argv.includes('--likeness')) { process.exit(await likeness(+(flag('runs') || 24)) ? 0 : 1); }
const modes = SL_ONLY ? [] : ALL ? MODES : [ONE || 'default'];
const secondsFor = m => +(flag('seconds') || (m === 'default' ? pos[0] || 90 : m === 'late' ? 20 : 40));
const outFor = m => path.resolve(ROOT, m === 'default' && pos[1] ? pos[1] : m === 'default' ? 'shots/replay-proof.txt' : `shots/replay-proof-${m}.txt`);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const pn = new URL(req.url, 'http://x').pathname;
  if (pn === '/__sl-proof.html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(slPage()); return; }
  if (pn === '/__sl-bot.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(botSource('/')); return; }
  const p = path.join(ROOT, decodeURIComponent(pn));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/starfall.html`;
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });

const info = page => page.evaluate(() => SF.info());
const over = st => st === 'gameover' || st === 'results' || st === 'title';

// keyboard play: sweep left/right with tapped and held fire, an occasional kindle.
// hooks(page, elapsedSeconds, k) runs each loop for mode-specific events (pause, blur).
async function keyboardPlay(page, seconds, { needDeath, hooks } = {}) {
  const t0 = Date.now();
  let held = null, k = 0;
  const hold = async key => { if (held === key) return; if (held) await page.keyboard.up(held); held = key; if (key) await page.keyboard.down(key); };
  while (Date.now() - t0 < seconds * 1000) {
    const i = await info(page);
    if (over(i.state)) break;
    const el = (Date.now() - t0) / 1000;
    if (hooks) { await hold(null); await hooks(page, el, k); }
    // no death by 40 s: sit still in the dive lanes with fire off until something hits the ship
    if (needDeath && el > 40 && i.deaths === 0) { await hold(null); await page.waitForTimeout(250); continue; }
    const phase = k % 11;
    await hold(phase < 4 ? 'ArrowLeft' : phase < 5 ? null : phase < 9 ? 'ArrowRight' : null);
    if (k % 6 === 5) { await page.keyboard.down('Space'); await page.waitForTimeout(400); await page.keyboard.up('Space'); }
    else { await page.keyboard.press('Space'); await page.waitForTimeout(120 + (k * 37) % 140); }
    if (k % 41 === 40) await page.keyboard.press('KeyX');
    k++;
  }
  await hold(null);
}

// touch play: one finger slides across the playfield (steer + autofire), lifts and lands again
// every couple of seconds (fire press), and sometimes a second finger lands (kindle)
async function touchPlay(page, seconds) {
  await page.evaluate(() => {
    const c = document.getElementById('c');
    const mk = (id, x, y) => new Touch({ identifier: id, target: c, clientX: x, clientY: y });
    window.__touch = (type, pts, lifted) => {
      const touches = pts.map((p, i) => mk(i, p[0], p[1]));
      const changed = type === 'touchend' ? lifted.map((p, i) => mk(i, p[0], p[1])) : type === 'touchstart' ? [touches[touches.length - 1]] : touches;
      c.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: changed, cancelable: true, bubbles: true }));
    };
  });
  const t0 = Date.now(), view = await page.evaluate(() => [innerWidth, innerHeight]);
  const sc = Math.min(view[0] / 400, view[1] / 300), ox = (view[0] - 400 * sc) / 2, cy = view[1] * 0.85;
  const fx = x => ox + x * sc;
  let k = 0;
  while (Date.now() - t0 < seconds * 1000) {
    if (over((await info(page)).state)) break;
    let x = 200 + 150 * Math.sin(k * 0.9);
    await page.evaluate(([x, y]) => __touch('touchstart', [[x, y]]), [fx(x), cy]);
    for (let s = 0; s < 14; s++) {
      x = 200 + 150 * Math.sin(k * 0.9 + s * 0.12);
      await page.evaluate(([x, y]) => __touch('touchmove', [[x, y]]), [fx(x), cy]);
      if (k % 5 === 4 && s === 7) await page.evaluate(([x, y]) => { __touch('touchstart', [[x, y], [x + 120, y - 200]]); __touch('touchend', [[x, y]], [[x + 120, y - 200]]); }, [fx(x), cy]);
      await page.waitForTimeout(110);
    }
    await page.evaluate(([x, y]) => __touch('touchend', [], [[x, y]]), [fx(x), cy]);
    await page.waitForTimeout(90);
    k++;
  }
}

// mode 'late': one stage start per run (sub-runs report as late-s<n>); fails if any one fails
async function runLate() {
  let ok = true;
  for (const n of LATE_STAGES) if (!(await runMode('late', n))) ok = false;
  console.log(ok ? 'PASS late: every stage start identical' : 'FAIL late: see the stage runs above');
  return ok;
}

async function runMode(mode, lateStage = 0) {
  const seconds = secondsFor(mode), notes = [], fails = [];
  const out = lateStage ? path.resolve(ROOT, `shots/replay-proof-late-s${lateStage}.txt`) : outFor(mode);
  const name = lateStage ? `late-s${lateStage}` : mode;
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 }, hasTouch: mode === 'touch' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => window.SF);
    await page.waitForTimeout(800);
    // real flow: Escape skips the cabinet; then Enter picks START GAME, or a stage start for bonus/boss
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
    if (mode === 'bonus') await page.evaluate(() => SF.start(4));
    else if (mode === 'boss') await page.evaluate(() => SF.start(5));
    else if (mode === 'late') await page.evaluate(n => SF.start(n), lateStage);
    else await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    const i0 = await info(page);
    if (i0.state !== 'intro' && i0.state !== 'play') throw new Error('run did not start, state = ' + i0.state);
    if (i0.tainted) throw new Error('run is tainted by a test hook');

    const t0 = Date.now();
    if (mode === 'touch') await touchPlay(page, seconds);
    else if (mode === 'pause') {
      let paused = false, blurred = false;
      await keyboardPlay(page, seconds, {
        hooks: async (page, el) => {
          if (!paused && el > 8) {
            paused = true;
            await page.keyboard.press('KeyP');
            await page.waitForTimeout(150);
            const f0 = (await info(page)).frames;
            await page.keyboard.down('ArrowLeft'); await page.waitForTimeout(1200); await page.keyboard.up('ArrowLeft');
            const f1 = (await info(page)).frames;
            if (f1 !== f0) fails.push(`sim advanced ${f1 - f0} frames while paused`);
            notes.push(`paused 1.2 s at ${el.toFixed(1)} s: sim frames ${f0} -> ${f1}`);
            await page.keyboard.press('Space'); // fire unpauses
            await page.waitForTimeout(150);
          }
          if (!blurred && el > 16) {
            blurred = true;
            // keys held across a window blur must release, then play carries on
            await page.keyboard.down('ArrowRight'); await page.keyboard.down('Space');
            await page.waitForTimeout(300);
            const x0 = await page.evaluate(() => SF.info().frames);
            await page.evaluate(() => window.dispatchEvent(new Event('blur')));
            await page.waitForTimeout(600);
            const shots0 = (await info(page)).shots;
            await page.waitForTimeout(600);
            const shots1 = (await info(page)).shots;
            await page.keyboard.up('ArrowRight'); await page.keyboard.up('Space');
            if (shots1 !== shots0) fails.push(`fire kept auto-firing after blur (${shots0} -> ${shots1} shots)`);
            notes.push(`blur at ${el.toFixed(1)} s (frame ${x0}) with Right+Space held: shots ${shots0} -> ${shots1} over 0.6 s after`);
          }
        }
      });
      if (!paused) fails.push('run ended before the pause step');
      if (!blurred) fails.push('run ended before the blur step');
    } else await keyboardPlay(page, seconds, { needDeath: mode === 'default' });

    // snapshot replay, score and hash in one evaluate so they describe the same sim frame
    const snap = await page.evaluate(() => {
      const i = SF.info();
      return { replay: SF.replay(), score: i.score, hash: SF.hash(), frames: i.frames, stage: i.stage, lives: i.lives, deaths: i.deaths, state: SF.state, tainted: i.tainted };
    });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, snap.replay + '\n');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/resim.mjs'), out], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('resim failed: ' + r.stderr);
    const node = JSON.parse(r.stdout);
    const b = { score: snap.score, frames: snap.frames, stage: snap.stage, lives: snap.lives, hash: snap.hash };

    console.log(`\n== ${name}: played ${((Date.now() - t0) / 1000).toFixed(1)} s, mode ${snap.replay.split('~')[4]}, final state ${snap.state}, deaths ${snap.deaths}, replay ${snap.replay.length} chars -> ${path.relative(ROOT, out)}`);
    for (const n of notes) console.log('   ' + n);
    console.log('browser', JSON.stringify(b));
    console.log('node   ', JSON.stringify(node));
    if (b.score !== node.score) fails.push('score differs');
    if (b.hash !== node.hash) fails.push('hash differs');
    if (b.frames !== node.frames) fails.push('frames differ');
    if (b.stage !== node.stage || b.lives !== node.lives) fails.push('stage/lives differ');
    if (!(b.score > 0)) fails.push('score is 0');
    if (mode === 'default' && !(snap.deaths >= 1)) fails.push('no death in the run');
    if (mode === 'bonus' && !/~stage4~/.test(snap.replay)) fails.push('not a stage-4 start');
    if (mode === 'boss' && !/~stage5~/.test(snap.replay)) fails.push('not a stage-5 start');
    if (mode === 'late' && !snap.replay.includes(`~stage${lateStage}~`)) fails.push(`not a stage-${lateStage} start`);
    if (snap.tainted) fails.push('run used a test hook');
  } catch (e) {
    console.log(`\n== ${name}: ERROR ${e.message}`);
    fails.push(e.message);
  }
  if (errors.length) fails.push('page errors: ' + errors.join(' | '));
  console.log(fails.length ? `FAIL ${name}: ${fails.join('; ')}` : `PASS ${name}: identical score, frames and hash`);
  await ctx.close();
  return fails.length === 0;
}

const results = [];
for (const m of modes) results.push([m, m === 'late' ? await runLate() : await runMode(m)]);
if (SL_ONLY || ALL) results.push(['stacklight', await runStacklight()]);
await browser.close();
server.close();
if (results.length > 1) console.log('\nsummary: ' + results.map(([m, ok]) => `${m} ${ok ? 'PASS' : 'FAIL'}`).join(', '));
process.exit(results.every(([, ok]) => ok) ? 0 : 1);

// ---------- STACKLIGHT (card T6) ----------
// The word bot, as module source, so the same code runs in Chrome (served at /__sl-bot.js) and in Node (a data: URL).
// It is the golden word script's idea (tests/stacklight-golden.test.js: score every placement on the column heights,
// take the best or sometimes a random one, then pick a style of input) with its own input seed: different seeds give
// different word scripts (weights, styles, mistakes) on the same game seed. playBot(seed, mode, inSeed) plays until the
// run ends and returns { replay, score, lines, level, frames, hash, sig } (sig: server/dedupe.js signatureRecorder).
function botSource(base) {
  return `
import { Rng, seedFromString } from '${base}engine/rng.js';
import { createSim, PH_PLAY } from '${base}games/stacklight/sim.js';
import { COLS, BAR, PLUS, ROT_H, ROT_V } from '${base}games/stacklight/defs.js';
import { columnHeight } from '${base}games/stacklight/sim/board.js';
import { signatureRecorder, pieceKey, placeCode } from '${base}server/dedupe.js';
function makePlan(sim, rng, k) {
  const S = sim.ctx, h = [];
  for (let c = 0; c < COLS; c++) h.push(columnHeight(sim.grid, c));
  const cands = [];
  const add = (rot, col, adds) => {
    const n = h.slice(); let fit = 0;
    if (adds.length === 3 && adds[1] === 1) fit = h[col - 1] === h[col] && h[col] === h[col + 1] ? 1 : 0;
    if (adds.length === 3 && adds[1] === 3) fit = h[col - 1] === h[col] + 1 && h[col + 1] === h[col] + 1 ? 1 : 0;
    if (adds.length === 1) n[col] += 3; else { n[col - 1] += adds[0]; n[col] += adds[1]; n[col + 1] += adds[2]; }
    const lines = Math.min(...n), mx = Math.max(...n) - lines;
    let bump = 0; for (let c = 1; c < COLS; c++) bump += Math.abs(n[c] - n[c - 1]);
    cands.push({ rot, col, v: lines * k.wl + fit * k.wf - mx * k.wh - bump * k.wb + rng.int(k.noise + 1) });
  };
  if (S.pType === BAR) { for (let c = 1; c < COLS - 1; c++) add(ROT_H, c, [1, 1, 1]); for (let c = 0; c < COLS; c++) add(ROT_V, c, [3]); }
  else for (let c = 1; c < COLS - 1; c++) add(ROT_H, c, [1, 3, 1]);
  let best = cands[0]; for (const c of cands) if (c.v > best.v) best = c;
  const pRand = Math.min(0.9, k.mistake + S.frame / k.tire);
  const pick = rng.int(1000) < pRand * 1000 ? cands[rng.int(cands.length)] : best;
  const st = rng.int(20);
  const style = st < k.hard ? 'hard' : st < 13 ? 'held' : st < 16 ? 'soft' : st < 18 ? 'wait' : 'wiggle';
  return { rot: S.pType === PLUS ? S.rot : pick.rot, col: pick.col, style, spin: rng.int(10) === 0 ? 2 : 0, wig: rng.int(16),
    stage: 0, tries: 0, idle: 0, lastPx: S.px, think: rng.int(k.think + 1) };
}
function planWord(p, S, prev) {
  if (p.think > 0) { p.think--; return 0; }
  if (p.stage === 0) {
    if (S.pType === PLUS || S.rot === p.rot || p.tries >= 3) p.stage = 1;
    else { if (prev & 64) return 0; p.tries++; return 64; }
  }
  if (p.stage === 1) {
    if (S.px === p.col) p.stage = 2;
    else {
      if (S.px !== p.lastPx) { p.lastPx = S.px; p.idle = 0; } else if (++p.idle > 40) p.stage = 2;
      if (p.stage === 1) {
        const left = S.px > p.col, held = left ? 1 : 2, press = left ? 8 : 16;
        if (p.style === 'held') return (prev & held) ? held : held | press;
        return (prev & press) ? 0 : held | press;
      }
    }
  }
  if (p.stage === 2) { if (p.spin > 0) { if (prev & 64) return 0; p.spin--; return 64; } p.stage = 3; }
  if (p.style === 'hard' || p.style === 'held') return (prev & 32) ? 0 : 32;
  if (p.style === 'soft') return 4;
  if (p.style === 'wiggle' && S.lockT > 0 && p.wig > 0) { if (prev & 24) return 0; p.wig--; return p.wig & 1 ? 9 : 18; }
  return 0;
}
export function playBot(seed, mode, inSeed, maxFrames = 216000) {
  const sim = createSim({ seed, mode });
  const rng = new Rng(seedFromString('sl-bot:' + inSeed));
  const k = { wl: 16 + rng.int(9), wf: 4 + rng.int(9), wh: 2 + rng.int(5), wb: 1 + rng.int(2), noise: rng.int(6),
    mistake: 0.03 + rng.int(8) / 100, tire: 15000 + rng.int(15000), hard: 6 + rng.int(7), think: rng.int(12) };
  const rec = signatureRecorder();
  let plan = null, planned = -1, prev = 0;
  while (!sim.done && sim.frame < maxFrames) {
    const S = sim.ctx; let w = 0;
    if (S.phase === PH_PLAY) {
      if (S.spawned !== planned) { planned = S.spawned; plan = makePlan(sim, rng, k); }
      w = planWord(plan, S, prev);
    } else {
      const r = rng.int(48);
      w = r === 0 && !(prev & 64) ? 64 : r === 1 && !(prev & 32) ? 32 : r === 2 ? 1 : r === 3 ? 2 : 0;
    }
    const before = sim.score;
    sim.step(w); sim.clearEvents(); rec.add(pieceKey(sim.ctx.spawned), before, sim.score, placeCode(sim.ctx.py, sim.ctx.px, sim.ctx.rot)); prev = w; // the server's key (server/games.js sigKey); the value as played, not pass A's canonical form (w48d: --likeness re-sims with sigCanon)
  }
  return { replay: sim.replay(), score: sim.score, lines: sim.lines, level: sim.level, frames: sim.frame, hash: sim.stateHash(), done: sim.done, sig: rec.sig };
}
export function resim(r1) {
  const d = decodeR1(r1);
  const sim = createSim({ seed: d.seed, mode: d.mode });
  for (let i = 0; i < d.words.length; i++) { sim.step(d.words[i]); sim.clearEvents(); }
  return { score: sim.score, lines: sim.lines, level: sim.level, frames: sim.frame, hash: sim.stateHash(), done: sim.done };
}
import { decode as decodeR1 } from '${base}engine/replay.js';
`;
}
function slPage() {
  return `<!doctype html><meta charset="utf-8"><title>stacklight proof</title><body>
<script type="module">import * as bot from '/__sl-bot.js'; window.SLP = bot; window.SLP_READY = true;</script>`;
}

async function nodeBot() { return import('data:text/javascript,' + encodeURIComponent(botSource(ROOT_URL))); }

// The golden replays and their stored numbers, read from the golden test (never copied, so they cannot drift).
function goldens() {
  const src = fs.readFileSync(path.join(ROOT, 'tests/stacklight-golden.test.js'), 'utf8');
  const re = /\{ name: '([^']+)', seed: (\d+), mode: '(\w+)', dayRule: [^,]+, frames: (\d+), reason: '\w+', score: (\d+), lines: (\d+), hash: (\d+),\s*r1: '([^']+)' \}/g;
  return [...src.matchAll(re)].map(m => ({ name: m[1], seed: +m[2], mode: m[3], frames: +m[4], score: +m[5], lines: +m[6], hash: +m[7], r1: m[8] }));
}

// Node side in its own process (not this one, which also drives the browser): re-sim each r1 string.
function nodeResim(r1s) {
  const file = path.join(fs.mkdtempSync(path.join((process.env.TMPDIR || '/tmp'), 'sl-proof-')), 'r1.json');
  fs.writeFileSync(file, JSON.stringify(r1s));
  const child = `const fs = await import('node:fs'); const m = await import(process.argv[1]);
    console.log(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).map(s => m.resim(s))));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', child, 'data:text/javascript,' + encodeURIComponent(botSource(ROOT_URL)), file], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error('node re-sim failed: ' + r.stderr);
  return JSON.parse(r.stdout);
}

async function runStacklight() {
  const fails = [];
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
  const pick = o => ({ score: o.score, lines: o.lines, frames: o.frames, hash: o.hash });
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/__sl-proof.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.SLP_READY === true);
    const ua = await page.evaluate(() => navigator.userAgent);
    console.log(`\n== stacklight: browser ${(/(HeadlessChrome|Chrome)\/[\d.]+/.exec(ua) || [ua])[0]}, Node ${process.version}`);
    const gold = goldens();
    if (gold.length !== 3) throw new Error(`expected 3 golden replays in tests/stacklight-golden.test.js, found ${gold.length}`);
    // bot runs PLAYED in the browser: 2 Free Play, 2 Daily (input seeds differ from the golden script)
    const BOTS = [{ seed: 7, mode: 'arcade', inSeed: 1 }, { seed: 123456, mode: 'arcade', inSeed: 2 },
      { seed: 20261107, mode: 'daily', inSeed: 3 }, { seed: 99, mode: 'daily', inSeed: 4 }];
    const played = await page.evaluate(bots => bots.map(b => { const r = SLP.playBot(b.seed, b.mode, b.inSeed); delete r.sig; return r; }), BOTS);
    const browserGold = await page.evaluate(r1s => r1s.map(s => SLP.resim(s)), gold.map(g => g.r1));
    const node = nodeResim([...gold.map(g => g.r1), ...played.map(p => p.replay)]);
    const rows = [];
    gold.forEach((g, i) => {
      const b = pick(browserGold[i]), n = pick(node[i]), want = pick(g);
      const ok = JSON.stringify(b) === JSON.stringify(n) && JSON.stringify(b) === JSON.stringify(want);
      rows.push([`golden ${g.name}`, b, n, ok ? '' : `want ${JSON.stringify(want)}`]);
      if (!ok) fails.push(`golden ${g.name}: browser, Node and stored numbers differ`);
    });
    played.forEach((p, i) => {
      const bb = BOTS[i], b = pick(p), n = pick(node[gold.length + i]);
      const ok = JSON.stringify(b) === JSON.stringify(n) && p.done && node[gold.length + i].done && p.score > 0 && p.level === node[gold.length + i].level;
      rows.push([`bot ${bb.mode} seed ${bb.seed} input ${bb.inSeed} (${p.replay.length} chars)`, b, n, ok ? '' : 'differs or unfinished']);
      if (!ok) fails.push(`bot run ${i + 1} (${bb.mode} seed ${bb.seed}): browser and Node differ, or the run did not finish`);
    });
    for (const [name, b, n, note] of rows) {
      console.log(`   ${name}`);
      console.log(`     browser ${JSON.stringify(b)}`);
      console.log(`     node    ${JSON.stringify(n)}${note ? '   ' + note : ''}`);
    }
  } catch (e) {
    console.log(`\n== stacklight: ERROR ${e.message}`);
    fails.push(e.message);
  }
  if (errors.length) fails.push('page errors: ' + errors.join(' | '));
  console.log(fails.length ? `FAIL stacklight: ${fails.join('; ')}` : 'PASS stacklight: 3 golden replays and 4 browser-played bot runs, identical score, lines, frames and hash in browser and Node');
  await ctx.close();
  return fails.length === 0;
}

// --likeness: same-seed honest runs, pairwise near-copy similarity (server/dedupe.js), per seed and mode, and the copy
// attacks: time shifts (idle frames inserted at the start or mid-run), one-bit flips early and late, a shift
// plus a flip, and re-timed copies (every piece put in the same place on a new timing). Mirror
// copies (LEFT and RIGHT swapped in every word; in Free Play that is the exact score), a mirror plus 10 idle frames, and
// the second half mirrored. Split mirrors, LEFT and RIGHT swapped from a real symmetric moment (the
// board left-right symmetric, no piece in play, no LEFT or RIGHT down) to the end, from every such moment of every bot run
// and golden, and a copy that switches at every symmetric moment of a run with two or more. Every signature here is
// recorded the way server/verify.js pass A records it: the registry's sigKey, sigValue and sigCanon (server/games.js;
// STACKLIGHT keys a scoring event on the piece, not the frame, and records each placement in canonical left-right form).
async function likeness(runs) {
  const { playBot } = await nodeBot();
  const { similarity, signatureRecorder, NEAR, MIN_EVENTS } = await import(ROOT_URL + 'server/dedupe.js');
  const { GAMES } = await import(ROOT_URL + 'server/games.js');
  const { createSim, PH_PLAY } = await import(ROOT_URL + 'games/stacklight/sim.js');
  const { decode } = await import(ROOT_URL + 'engine/replay.js');
  const { sigKey, sigValue, sigCanon } = GAMES.stacklight;
  const { boardSymmetric } = await import(ROOT_URL + 'server/games.js');
  // re-sim words as the server does; past the last word, play no input until the run ends (a cut copy is cut there)
  const resim = (seed, mode, words) => {
    const sim = createSim({ seed, mode }), rec = signatureRecorder(), canon = sigCanon(sim);
    for (let k = 0; !sim.done && k < 216000; k++) { const b = sim.score; sim.step(k < words.length ? words[k] : 0); sim.clearEvents(); rec.add(sigKey(sim), b, sim.score, canon(sim, sigValue(sim))); }
    return { score: sim.score, sig: rec.sig, done: sim.done };
  };
  // the first frame at or after `from` where the piece is in play and this word and the one before are 0: K idle frames
  // put there change nothing but timing (the shift a review used, at frame 2 or 3)
  const quietAt = (seed, mode, w, from) => {
    const sim = createSim({ seed, mode });
    for (let i = 0; i < w.length; i++) {
      if (i >= from && sim.ctx.phase === PH_PLAY && w[i] === 0 && (i === 0 || w[i - 1] === 0)) return i;
      sim.step(w[i]); sim.clearEvents();
    }
    return -1;
  };
  const insert = (w, at, k) => { const e = new Uint16Array(w.length + k); e.set(w.subarray(0, at)); e.set(w.subarray(at), at + k); return e; };
  const flipAt = (w, f, bit) => { const e = Uint16Array.from(w); e[f] ^= bit; return e; };
  // LEFT (1) and RIGHT (2), and their presses (8, 16), swapped in every word from frame `from` on
  const mirW = (x) => (x & ~27) | ((x & 1) << 1) | ((x & 2) >> 1) | ((x & 8) << 1) | ((x & 16) >> 1);
  const mirrorFrom = (w, from) => w.map((x, i) => i < from ? x : mirW(x));
  // mirrored between the 1st and 2nd switch frame, plain to the 3rd, and so on
  const mirrorSegs = (w, sw) => { let k = 0; return w.map((x, i) => { while (k < sw.length && i >= sw[k]) k++; return k & 1 ? mirW(x) : x; }); };
  // the real symmetric moments of a run (review 3, symscan.mjs): no piece in play, no LEFT or RIGHT held or charging
  // before or in this word, the board's occupied cells left-right symmetric; one per scoring event, after the first
  // event and before the signature is full (a split before any event, or after event 128, is a whole-run mirror or
  // a plain copy as far as the signature can see)
  const symMoments = (seed, mode, w) => {
    const sim = createSim({ seed, mode }), out = [];
    let ev = 0, lastEv = -1;
    for (let i = 0; i < w.length && !sim.done; i++) {
      const S = sim.ctx;
      if (i > 0 && ev > 0 && ev < 128 && ev !== lastEv && S.phase !== PH_PLAY && S.arDir === 0 && (S.prev & 27) === 0 && (w[i] & 27) === 0 && boardSymmetric(sim.grid)) { lastEv = ev; out.push(i); }
      const b = sim.score; sim.step(w[i]); sim.clearEvents(); if (sim.score !== b) ev++;
    }
    return out;
  };
  const splitsOf = (seed, mode, w) => {
    const at = symMoments(seed, mode, w), out = at.map(f => ['split mirror', mirrorSegs(w, [f]), f]);
    if (at.length >= 2) out.push(['every-moment switch', mirrorSegs(w, at), at.length]);
    return out;
  };
  // the re-timed copy (a copier's bot): read where each piece of the original locked, then put every piece in the same
  // place on a new timing (0 to 11 think frames, taps, then a hard drop, or soft drop held all the way down). Pieces
  // and placements match; frames, GLOW and so points do not. Played out on the sim, so it is a valid finished run.
  const placements = (seed, mode, w) => {
    const sim = createSim({ seed, mode }), pl = [];
    let locked = 0;
    for (let i = 0; i < w.length && !sim.done; i++) {
      sim.step(w[i]); sim.clearEvents();
      const S = sim.ctx;
      if (S.pType === 0 && S.phase !== PH_PLAY && locked !== S.spawned) { locked = S.spawned; pl.push(S.px, S.rot); }
    }
    return pl;
  };
  const retimed = (seed, mode, pl, inSeed, soft) => {
    const sim = createSim({ seed, mode });
    let s = inSeed, prev = 0, planned = -1, think = 0, tries = 0;
    const rnd = (n) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 16) % n; };
    while (!sim.done && sim.frame < 216000) {
      const S = sim.ctx; let w = 0;
      if (S.phase === PH_PLAY) {
        if (S.spawned !== planned) { planned = S.spawned; think = rnd(12); tries = 0; }
        const i = 2 * (S.spawned - 1), col = i < pl.length ? pl[i] : S.px, rot = i < pl.length ? pl[i + 1] : S.rot;
        if (think > 0) think--;
        else if (S.rot !== rot && tries < 3) { w = prev & 64 ? 0 : 64; tries++; }
        else if (S.px !== col) { const press = S.px > col ? 9 : 18; w = prev & (press & 24) ? 0 : press; }
        else w = soft ? 4 : (prev & 32 ? 0 : 32);
      }
      sim.step(w); sim.clearEvents(); prev = w;
    }
    return sim.replay();
  };
  const SHIFTS = [5, 10, 30, 60, 300];
  const mirrorsOf = (seed, mode, w) => {
    const m = mirrorFrom(w, 0), at = quietAt(seed, mode, m, 2);
    return [['mirror', m], ...(at >= 0 ? [['mirror + shift', insert(m, at, 10)]] : []), ['half mirror', mirrorFrom(w, w.length >> 1)]];
  };
  // all copies of one run: [kind, words]
  const copiesOf = (seed, mode, w, i) => {
    const out = [];
    const a0 = quietAt(seed, mode, w, 2), a1 = quietAt(seed, mode, w, Math.floor(w.length / 2));
    for (const k of SHIFTS) { if (a0 >= 0) out.push(['shift start', insert(w, a0, k), k]); if (a1 >= 0) out.push(['shift mid', insert(w, a1, k), k]); }
    for (const p of [0.1, 0.25]) out.push(['flip early', flipAt(w, Math.floor(w.length * p), 1 << (i % 7))]);
    for (let t = 0; t < 5; t++) out.push(['flip late', flipAt(w, Math.floor(w.length * (0.5 + 0.1 * t)), 1 << ((i + t) % 7))]);
    if (a0 >= 0) { const e = insert(w, a0, 10); out.push(['shift + flip', flipAt(e, Math.floor(e.length * 0.7), 1 << ((i + 2) % 7))]); }
    const pl = placements(seed, mode, w);
    for (const soft of [false, true]) out.push(['re-timed', Uint16Array.from(decode(retimed(seed, mode, pl, i + 1, soft)).words)]);
    out.push(...mirrorsOf(seed, mode, w));
    return out;
  };
  const SEEDS = [{ seed: 1, mode: 'arcade' }, { seed: 424242, mode: 'arcade' }, { seed: 4, mode: 'daily' }, { seed: 2, mode: 'daily' }];
  const q = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  const KINDS = ['shift start', 'shift mid', 'flip early', 'flip late', 'shift + flip', 're-timed', 'mirror', 'mirror + shift', 'half mirror', 'split mirror', 'every-moment switch'];
  const tally = () => Object.fromEntries(KINDS.map(k => [k, { tries: 0, held: 0, min: 1, escBest: 0, escKeep90: 0 }]));
  const all = tally();
  const count = (t, kind, x, ratio) => {
    for (const c of [t[kind], all[kind]]) { c.tries++; c.min = Math.min(c.min, x); if (x >= NEAR) c.held++; else { c.escBest = Math.max(c.escBest, ratio); if (ratio >= 0.9) c.escKeep90++; } }
  };
  let worst = 0, worstShiftEsc = 0;
  console.log(`STACKLIGHT same-seed likeness: ${runs} honest bot runs per seed (input seeds 1..${runs}), NEAR = ${NEAR}, MIN_EVENTS = ${MIN_EVENTS}, key: piece (server/games.js sigKey)`);
  console.log('| seed, mode | runs | score range | moments (min to max) | pairs | median | p95 | max | pairs at NEAR or more | time-shift copies held (min) | 1-bit copies held (min) | shift + flip held | re-timed held | mirror held (min) | split mirrors of all runs held (min) | copies not held: best score vs original |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of SEEDS) {
    const rs = [];
    for (let i = 1; i <= runs; i++) {
      const r = playBot(s.seed, s.mode, i), w = Uint16Array.from(decode(r.replay).words);
      rs.push({ ...r, w, sig: resim(s.seed, s.mode, w).sig });
    }
    const sims = [];
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) sims.push(similarity(rs[i].sig, rs[j].sig));
    sims.sort((a, b) => a - b);
    const max = sims[sims.length - 1], over = sims.filter(x => x >= NEAR).length;
    worst = Math.max(worst, max);
    // copies of the first 4 runs, each compared with the run it was made from. A copy that is not held played out
    // differently after the edit: its score against the original's shows how much of the run it kept.
    const t = tally();
    for (let i = 0; i < 4; i++) {
      for (const [kind, e] of copiesOf(s.seed, s.mode, rs[i].w, i)) {
        const c = resim(s.seed, s.mode, e);
        count(t, kind, similarity(rs[i].sig, c.sig), c.score / rs[i].score);
      }
    }
    // split mirrors: every real symmetric moment of every run, not only the first 4 (they are not common)
    for (let i = 0; i < rs.length; i++) {
      for (const [kind, e] of splitsOf(s.seed, s.mode, rs[i].w)) {
        const c = resim(s.seed, s.mode, e);
        count(t, kind, similarity(rs[i].sig, c.sig), c.score / rs[i].score);
      }
    }
    const sp = { tries: t['split mirror'].tries + t['every-moment switch'].tries, held: t['split mirror'].held + t['every-moment switch'].held, min: Math.min(t['split mirror'].min, t['every-moment switch'].min) };
    const sh = { tries: t['shift start'].tries + t['shift mid'].tries, held: t['shift start'].held + t['shift mid'].held, min: Math.min(t['shift start'].min, t['shift mid'].min) };
    const fl = { tries: t['flip early'].tries + t['flip late'].tries, held: t['flip early'].held + t['flip late'].held, min: Math.min(t['flip early'].min, t['flip late'].min) };
    const esc = Math.max(...KINDS.map(k => t[k].escBest));
    const sc = rs.map(r => r.score).sort((a, b) => a - b), mo = rs.map(r => r.sig.length >> 1).sort((a, b) => a - b);
    console.log(`| ${s.seed}, ${s.mode} | ${runs} | ${sc[0]} to ${sc[sc.length - 1]} | ${mo[0]} to ${mo[mo.length - 1]} | ${sims.length} | ${q(sims, 0.5).toFixed(3)} | ${q(sims, 0.95).toFixed(3)} | ${max.toFixed(3)} | ${over} | ${sh.held} of ${sh.tries} (${sh.min.toFixed(3)}) | ${fl.held} of ${fl.tries} (${fl.min.toFixed(3)}) | ${t['shift + flip'].held} of ${t['shift + flip'].tries} | ${t['re-timed'].held} of ${t['re-timed'].tries} (${t['re-timed'].min.toFixed(3)}) | ${t.mirror.held} of ${t.mirror.tries} (${t.mirror.min.toFixed(3)}) | ${sp.held} of ${sp.tries}${sp.tries ? ` (${sp.min.toFixed(3)})` : ''} | ${esc === 0 ? 'none' : Math.round(esc * 100) + '%'} |`);
  }
  // the golden runs (tests/stacklight-golden.test.js), shifted by K idle frames at the start and mid-run
  console.log('\nTime-shifted copies of the golden runs (K idle frames inserted where the piece is in play and no key is down):');
  console.log('| golden run | where | ' + SHIFTS.map(k => `K=${k}`).join(' | ') + ' |');
  console.log('|---|---|' + SHIFTS.map(() => '---|').join(''));
  for (const g of goldens()) {
    const d = decode(g.r1), w = Uint16Array.from(d.words), base = resim(d.seed, d.mode, w);
    for (const [where, from] of [['start', 2], ['mid', Math.floor(w.length / 2)]]) {
      const at = quietAt(d.seed, d.mode, w, from), cells = [];
      for (const k of SHIFTS) {
        const c = resim(d.seed, d.mode, insert(w, at, k)), x = similarity(base.sig, c.sig), ratio = c.score / base.score;
        count(tally(), where === 'start' ? 'shift start' : 'shift mid', x, ratio);
        if (x < NEAR && ratio >= 0.9) worstShiftEsc++;
        cells.push(`${x.toFixed(3)} ${x >= NEAR ? 'held' : 'NOT held'}, score ${c.score === base.score ? 'same' : Math.round(ratio * 100) + '%'}`);
      }
      console.log(`| ${g.name} (${g.score}) | ${where}, frame ${at} | ${cells.join(' | ')} |`);
    }
  }
  console.log('\nRe-timed copies of the golden runs (same placements, new timing):');
  console.log('| golden run | hard drop, input seed 1 | 2 | 3 | soft drop held, input seed 1 | 2 | 3 |');
  console.log('|---|---|---|---|---|---|---|');
  for (const g of goldens()) {
    const d = decode(g.r1), w = Uint16Array.from(d.words), base = resim(d.seed, d.mode, w), pl = placements(d.seed, d.mode, w), cells = [];
    for (const soft of [false, true]) for (const k of [1, 2, 3]) {
      const c = resim(d.seed, d.mode, Uint16Array.from(decode(retimed(d.seed, d.mode, pl, k, soft)).words)), x = similarity(base.sig, c.sig), ratio = c.score / base.score;
      count(tally(), 're-timed', x, ratio);
      cells.push(`${x.toFixed(3)} ${x >= NEAR ? 'held' : 'NOT held'}, score ${Math.round(ratio * 100)}%`);
    }
    console.log(`| ${g.name} (${g.score}) | ${cells.join(' | ')} |`);
  }
  // mirror copies of the golden runs: Free Play starts empty, so its mirror keeps the exact score; no Daily ridge
  // is a palindrome, so a Daily mirror plays out as a different run
  console.log('\nMirror copies of the golden runs (LEFT and RIGHT swapped):');
  console.log('| golden run | mirror | mirror + 10 idle frames | second half mirrored | split mirrors at symmetric moments |');
  console.log('|---|---|---|---|---|');
  for (const g of goldens()) {
    const d = decode(g.r1), w = Uint16Array.from(d.words), base = resim(d.seed, d.mode, w), cells = [];
    const splits = splitsOf(d.seed, d.mode, w);
    let splitHeld = 0;
    for (const [kind, e] of splits) {
      const c = resim(d.seed, d.mode, e), x = similarity(base.sig, c.sig);
      count(tally(), kind, x, c.score / base.score);
      if (x >= NEAR) splitHeld++;
    }
    for (const [kind, e] of mirrorsOf(d.seed, d.mode, w)) {
      const c = resim(d.seed, d.mode, e), x = similarity(base.sig, c.sig), ratio = c.score / base.score;
      count(tally(), kind, x, ratio);
      cells.push(`${x.toFixed(3)} ${x >= NEAR ? 'held' : 'NOT held'}, score ${c.score === base.score ? 'same' : Math.round(ratio * 100) + '%'}`);
    }
    console.log(`| ${g.name} (${g.score}) | ${cells.join(' | ')} | ${splits.length ? `${splitHeld} of ${splits.length} held` : 'none (no symmetric moment after the first event)'} |`);
  }
  console.log('\nCopies by kind, all seeds and goldens:');
  console.log('| kind | tries | held | min similarity | not held: best score vs original | not held and kept 90% or more of the score |');
  console.log('|---|---|---|---|---|---|');
  for (const k of KINDS) { const c = all[k]; console.log(`| ${k} | ${c.tries} | ${c.held} | ${c.min.toFixed(3)} | ${c.held === c.tries ? 'none' : Math.round(c.escBest * 100) + '%'} | ${c.escKeep90} |`); }
  const esc90 = KINDS.reduce((n, k) => n + all[k].escKeep90, 0);
  const ok = worst < NEAR && esc90 === 0;
  console.log(ok ? `PASS likeness: honest same-seed runs top out at ${worst.toFixed(3)}, under NEAR ${NEAR}; no copy (time shift, flip, re-timed, mirror, split mirror) that kept 90% of the score got under NEAR`
    : worst >= NEAR ? `FAIL likeness: honest same-seed runs reach ${worst.toFixed(3)}, at or over NEAR ${NEAR} (they would be held as copies)`
    : `FAIL likeness: ${esc90} copies kept 90% or more of the score and got under NEAR ${NEAR}`);
  return ok;
}
