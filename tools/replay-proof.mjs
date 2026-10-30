// Replay proof: play Starfall in headless Chrome, then re-simulate the recorded replay in Node and
// require the exact same score, frame count and state hash.
//
// Usage:
//   node tools/replay-proof.mjs [seconds=90] [outFile=shots/replay-proof.txt]   default run
//   node tools/replay-proof.mjs --mode=<name> [--seconds=N]                     one mode
//   node tools/replay-proof.mjs --all [--seconds=N]                             every mode
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
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODES = ['default', 'bonus', 'boss', 'touch', 'pause', 'late'];
const LATE_STAGES = [2, 3, 6, 7, 8, 11, 12, 13];
const argv = process.argv.slice(2);
const flag = name => { const a = argv.find(x => x.startsWith('--' + name + '=')); return a ? a.split('=')[1] : null; };
const pos = argv.filter(a => !a.startsWith('--'));
const ALL = argv.includes('--all');
const ONE = flag('mode');
if (ONE && !MODES.includes(ONE)) { console.error('unknown mode ' + ONE + '; modes: ' + MODES.join(', ')); process.exit(2); }
const modes = ALL ? MODES : [ONE || 'default'];
const secondsFor = m => +(flag('seconds') || (m === 'default' ? pos[0] || 90 : m === 'late' ? 20 : 40));
const outFor = m => path.resolve(ROOT, m === 'default' && pos[1] ? pos[1] : m === 'default' ? 'shots/replay-proof.txt' : `shots/replay-proof-${m}.txt`);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
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
await browser.close();
server.close();
if (modes.length > 1) console.log('\nsummary: ' + results.map(([m, ok]) => `${m} ${ok ? 'PASS' : 'FAIL'}`).join(', '));
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
