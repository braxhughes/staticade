// MOONWELL boss (slice S8, design.md B.6): the section C verify (20 tide walls), the tide wall spec, the 84-bullet
// cap over a long god-mode fight, telegraph lead time before every bullet-spawning or dive event, phase triggers and
// the phase-change rule, the lens window, the scoring contract (S.hits, S.pieceKill), the dive, and the draw layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { bosses } from '../games/starfall/sim/registry.js';
import { installHooks } from '../games/starfall/hooks.js';
import { packWord } from '../engine/input-word.js';
import { EV_POPUP, EV_SHAKE, POP_PHASE2, POP_CORE } from '../games/starfall/defs.js';
import { MOONWELL as M } from '../games/starfall/sim/bosses/moonwell.js';
import { moonwellLayer } from '../games/starfall/render/bosses/moonwell.js';
import { layers } from '../games/starfall/render/layers.js';

const IDLE = 128;
const B = bosses.moonwell;
const step = (sim, n = 1, w = IDLE) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(w); sim.clearEvents(); } return sim; };
const toPlay = sim => { while (sim.state !== 'play') step(sim); return sim; };
function fight(seed, god = true) {
  const sim = toPlay(createSim({ seed, mode: 'stage10' }));
  if (god) sim.setGod(true);
  while (sim.boss.entering) step(sim);
  return sim;
}
const sweep = f => packWord(((f / 90) | 0) % 2 ? 0.4 : -0.4, false, false, false, false, 0);
// a player shot placed at (x, y), as the sim's shot loop would pass it
function shotAt(sim, x, y) { const p = sim.ps[0]; p.on = true; p.x = p.px = x; p.y = p.py = y; return p; }

test('stage 10 is MOONWELL: registered boss, cap 84, boss bullet band 1.2 to 1.4', () => {
  const sim = createSim({ seed: 1, mode: 'stage10' });
  assert.equal(sim.boss.id, 'moonwell'); assert.equal(sim.boss.name, 'MOONWELL');
  assert.equal(sim.ctx.D.cap, 84); assert.equal(sim.ctx.D.bossLo, 1.2); assert.equal(sim.ctx.D.bossHi, 1.4);
  assert.ok(layers.includes(moonwellLayer), 'draw layer registered');
});

test('section C verify: SF.start(10); SF.god(); SF.bossPhase(2); 20 walls, every gap center in 40..360 and within 160 of the last', () => {
  const sim = createSim({ seed: 1, mode: 'stage10' }), SF = { info() { return {}; } };
  installHooks(SF, { sim, stepSim: () => false });
  sim.setGod(true);                                // SF.god()
  assert.equal(SF.bossPhase(2), true);             // SF.bossPhase(2), during the stage card / entrance
  const S = sim.ctx, boss = sim.boss, gaps = [];
  let glowRun = 0, glowGap = -1, spawned = 0, f = 0;
  const orig = S.eFire; S.eFire = (x, y, vx, vy, big) => { if (y === M.wallY && vx === 0 && !big) spawned++; orig(x, y, vx, vy, big); };
  while (gaps.length < 20 && f++ < 6000) {
    const before = sim.liveBullets(), walls = boss.walls;
    spawned = 0;
    step(sim);
    if (boss.wallT > 0) { if (glowRun === 0) glowGap = boss.gapX; glowRun++; assert.equal(boss.gapX, glowGap, 'gap fixed while it glows'); }
    if (boss.walls > walls) {
      assert.equal(spawned, 71, 'wall of 71 bullets, spawned in full');
      assert.ok(before < 10, 'one wall at a time: ' + before + ' bullets on screen when the next wall spawns');
      assert.ok(glowRun >= 30, 'gap glow ' + glowRun + ' frames'); assert.equal(boss.gapX, glowGap, 'the wall has the glowing gap');
      gaps.push(boss.gapX); glowRun = 0;
    }
  }
  S.eFire = orig;
  console.log('  verify: SF.start(10); SF.god(); SF.bossPhase(2) -> info ' + JSON.stringify({ bossPhase: SF.info().bossPhase, bullets: SF.info().bullets }));
  console.log('  20 gap centers: ' + gaps.map(g => g.toFixed(1)).join(', '));
  assert.equal(gaps.length, 20, '20 walls');
  assert.equal(SF.info().bossPhase, 2);
  let ok = true;
  for (let i = 0; i < gaps.length; i++) {
    ok = ok && gaps[i] >= 40 && gaps[i] <= 360;
    if (i > 0) ok = ok && Math.abs(gaps[i] - gaps[i - 1]) <= 160;
  }
  console.log('  every gap center in 40..360 and within 160 of the last: ' + ok);
  assert.ok(ok);
  assert.ok(Math.max(...gaps) - Math.min(...gaps) > 100, 'gaps actually move around');
});

test('tide wall geometry: slots x = 5 + 5k, 5 apart, 8 missing around the gap; the ship fits the gap and nowhere else', () => {
  const sim = fight(2); B.setPhase(sim.ctx, 2);
  const boss = sim.boss;
  for (let w = 0; w < 6; w++) {
    const n = boss.walls; while (boss.walls === n) step(sim);
    const row = sim.eb.filter(b => b.on && Math.abs(b.y - (M.wallY + boss.wallV)) < 0.01 && b.vx === 0).map(b => b.x).sort((a, b) => a - b);
    assert.equal(row.length, 71);
    for (const x of row) assert.equal((x - 5) % 5, 0, 'on the 5-unit grid');
    let gapsSeen = 0;
    for (let i = 1; i < row.length; i++) { const d = row[i] - row[i - 1]; if (d !== 5) { gapsSeen++; assert.equal(d, 45); assert.ok(row[i - 1] < boss.gapX && row[i] > boss.gapX); } }
    assert.equal(gapsSeen, 1, 'one gap');
    assert.ok(row[0] <= 10 && row[row.length - 1] >= 390, 'the wall reaches both sides of the ship\'s range (10..390)');
    // the ship (center within 3.5 of a bullet = hit) is safe only between the two bullets either side of the gap,
    // with at least 33 units of safe space for its center (B.6); everywhere else it cannot thread the wall
    const L = row.find((x, i) => row[i + 1] - x === 45), Rx = L + 45;
    let safe = 0;
    for (let px = 10; px <= 390; px += 0.25) {
      const hit = row.some(x => Math.abs(x - px) < 3.5);
      if (px > L && px < Rx) { if (!hit) safe += 0.25; } else assert.ok(hit, 'threaded at ' + px);
    }
    assert.ok(safe >= 33, 'safe space ' + safe);
    assert.ok(L - boss.gapX < -15 && Rx - boss.gapX > 20, 'gap is around its center');
  }
});

test('tide wall timing: falls at 1.2; next gap glow starts after the wall passes y = 280; a wall every ~180 frames; walls never overlap', () => {
  const sim = fight(3); B.setPhase(sim.ctx, 2);
  const boss = sim.boss, spawnAt = [];
  for (let f = 0; f < 2000; f++) {
    const n = boss.walls, glowing = boss.wallT > 0;
    step(sim);
    if (boss.wallT === M.wallGlow && !glowing && boss.walls > 0) assert.ok(!boss.wallOn && boss.wallY > 280, 'glow starts only after the wall passes 280');
    if (boss.walls > n) { spawnAt.push(sim.frame); assert.equal(boss.wallV, 1.2); }
    let rows = new Set(); for (const b of sim.eb) if (b.on && b.vx === 0 && !b.big) rows.add(b.y.toFixed(3));
    assert.ok(rows.size <= 1, 'one wall row at a time');
  }
  const g = spawnAt.slice(1).map((v, i) => v - spawnAt[i]);
  assert.ok(g.length >= 9 && g.every(v => v >= 180 && v <= 182), 'period ' + g.join(','));
});

test('walls never wait or skip: a wall spawns in full even when the cap is already full', () => {
  const sim = fight(4); B.setPhase(sim.ctx, 2);
  const S = sim.ctx, boss = sim.boss;
  while (boss.wallT !== 1) step(sim);
  for (const b of sim.eb) b.on = false;
  for (let i = 0; i < 80; i++) S.eFire(20 + i * 4.5, 20, 0, 0, true); // stationary filler, 80 of the 84
  const n = boss.walls; step(sim);
  assert.equal(boss.walls, n + 1); assert.equal(sim.liveBullets(), 151, 'all 71 spawned over the cap');
  // other volleys wait for room meanwhile
  let pairs = 0; const orig = S.eFire; S.eFire = (x, y, vx, vy, big) => { if (!big && vx !== 0) pairs++; orig(x, y, vx, vy, big); };
  step(sim, 120); S.eFire = orig;
  assert.equal(pairs, 0, 'aimed pairs wait or skip while over the cap');
});

test('entrance: 120 play frames, invulnerable; then phase 1 with 6 tendrils of 6 hp, lens 24', () => {
  const sim = toPlay(createSim({ seed: 5, mode: 'stage10' })), boss = sim.boss, S = sim.ctx;
  let n = 0;
  while (boss.entering) {
    if (n === 100) { const p = shotAt(sim, boss.x, boss.y + 5), h = S.hits; assert.equal(B.shot(S, p), true); assert.equal(p.on, false); assert.equal(S.hits, h, 'deflected, no hit'); }
    step(sim); n++;
  }
  assert.equal(n, 120); assert.equal(boss.phase, 1); assert.equal(boss.y, 70);
  assert.deepEqual(Array.from(boss.mw.th), [6, 6, 6, 6, 6, 6]); assert.equal(boss.lens, 24);
});

test('phase 1 attacks: each tip drops a bubble every 70 (rises 20 over 60, then falls at 1.2); aimed pair at 1.4 every 80', () => {
  const sim = fight(6), S = sim.ctx, boss = sim.boss, bubbles = [], pairs = [];
  const orig = S.eFire; S.eFire = (x, y, vx, vy, big) => { (big ? bubbles : pairs).push({ at: boss.at, x, y, vx, vy }); orig(x, y, vx, vy, big); };
  // follow one bubble
  let tracked = null, rise = 0, y0 = 0, turned = false;
  for (let i = 0; i < 1400; i++) {
    const nb = bubbles.length; step(sim);
    if (!tracked && bubbles.length > nb) { tracked = sim.eb.find(b => b.on && b.big && b.vy < 0 && Math.abs(b.y - bubbles[nb].y) < 1); y0 = tracked.y; }
    else if (tracked && tracked.vy < 0) rise++;
    else if (tracked && !turned && rise && tracked.vy > 0) { assert.equal(rise, 59, 'rising frames after the spawn frame'); assert.ok(Math.abs(y0 - (tracked.y - 1.2) - 59 / 3) < 1e-6, 'rose 20 over 60 frames'); assert.equal(tracked.vy, 1.2); turned = true; }
  }
  S.eFire = orig;
  assert.ok(turned, 'a bubble turned and fell');
  assert.ok(bubbles.every(b => b.vx === 0 && Math.abs(b.vy + 1 / 3) < 1e-12), 'bubbles spawn rising');
  // every tendril fires every 70 frames
  for (let k = 0; k < 6; k++) {
    const at = bubbles.filter(b => (b.at + k * 12) % 70 === 0).map(b => b.at);
    assert.ok(at.length >= 18, 'tendril ' + k + ': ' + at.length);
  }
  assert.ok(pairs.length % 2 === 0 && pairs.every(p => Math.abs(Math.hypot(p.vx, p.vy) - 1.4) < 1e-9));
  assert.ok(pairs.every(p => p.at % 80 === 0), 'pairs every 80');
  assert.ok(pairs.length / 2 >= 15);
});

test('telegraphs: every bullet-spawning or dive event follows >= 20 frames of its warning (bubble tip, aim lock, gap glow 30, shard glow, dive 30)', () => {
  const checked = { bubble: 0, pair: 0, wall: 0, ring: 0, dive: 0 };
  for (const seed of [7, 8]) {
    const sim = fight(seed), S = sim.ctx, boss = sim.boss, mw = boss.mw, spawns = [];
    const orig = S.eFire; S.eFire = (x, y, vx, vy, big) => { spawns.push({ x, y, vx, vy, big }); orig(x, y, vx, vy, big); };
    // run lengths of each telegraph (frames on, counted on frames the boss clock ran), and frames since it ended
    const run = {}, last = {}, since = {};
    const track = (k, on) => { if (on) { run[k] = (run[k] || 0) + 1; } else if (run[k] > 0) { last[k] = run[k]; run[k] = 0; since[k] = 0; } };
    for (const ph of [1, 2, 3]) {
      if (ph === 2) B.setPhase(S, 2);
      if (ph === 3) B.setPhase(S, 3);
      for (let i = 0; i < (ph === 3 ? 2400 : 1400) && boss.on; i++) {
        // phase 3: kill shards down to the last one, so the dive runs too
        if (ph === 3 && i === 300) { mw.sh[1] = 0; mw.sh[2] = 0; }
        spawns.length = 0;
        const t0 = boss.t, stopped = sim.hitstop > 0, dPrev = boss.dState, dRun = run.dive || 0;
        step(sim, 1, sweep(i));
        if (stopped || boss.t === t0) { assert.equal(spawns.length, 0, 'nothing spawns during hit-stop'); continue; }
        for (const k in since) since[k]++;
        for (let k = 0; k < 6; k++) track('t' + k, mw.tTele[k] > 0);
        for (let k = 0; k < 3; k++) track('s' + k, mw.sTele[k] > 0);
        track('aim', boss.aimT > 0); track('wall', boss.wallT > 0); track('dive', boss.dState === 1);
        if (dPrev === 1 && boss.dState === 2) { assert.ok(dRun >= 30, 'dive warning ' + dRun); checked.dive++; }
        const walls = spawns.filter(s => s.vx === 0 && !s.big && s.y === M.wallY);
        if (walls.length) { assert.equal(walls.length, 71); assert.ok(last.wall >= 30 && since.wall === 0, 'gap glow ' + last.wall); checked.wall++; }
        for (const s of spawns) {
          if (walls.includes(s)) continue;
          let key, kind;
          if (s.big && s.vx === 0 && Math.abs(s.vy + 1 / 3) < 1e-12) { // bubble: from the nearest tendril tip
            let best = 1e9; for (let k = 0; k < 6; k++) { const d = Math.hypot(mw.tx[k] - s.x, mw.ty[k] + 3 - s.y); if (d < best) { best = d; key = 't' + k; } }
            kind = 'bubble';
          } else if (s.big) { // shard ring: from the nearest shard
            let best = 1e9; for (let k = 0; k < 3; k++) { const d = Math.hypot(mw.sx[k] - s.x, mw.sy[k] - s.y); if (d < best) { best = d; key = 's' + k; } }
            kind = 'ring';
          } else { key = 'aim'; kind = 'pair'; }
          assert.ok(last[key] >= 20, kind + ' warning ' + last[key] + ' frames');
          assert.ok(since[key] <= 31, kind + ' fired ' + since[key] + ' frames after its warning ended');
          checked[kind]++;
        }
      }
    }
  }
  console.log('  telegraph checks: ' + JSON.stringify(checked));
  assert.ok(checked.bubble > 100 && checked.pair > 60 && checked.wall > 15 && checked.ring > 100 && checked.dive >= 4, JSON.stringify(checked));
});

test('bullet cap: never more than 84 enemy bullets over a long god-mode fight through every phase', () => {
  for (const seed of [1, 9]) {
    const sim = toPlay(createSim({ seed, mode: 'stage10' })), S = sim.ctx;
    sim.setGod(true);
    let max = 0, f = 0, maxP = [0, 0, 0, 0];
    while (sim.boss.on && sim.state !== 'bossOut') {
      if (sim.boss.fight === 1500 && sim.boss.phase === 1) B.setPhase(S, 2);
      if (sim.boss.fight === 3800 && sim.boss.phase === 2) B.setPhase(S, 3);
      step(sim, 1, sweep(f++));
      const n = sim.liveBullets(); max = Math.max(max, n); maxP[sim.boss.phase] = Math.max(maxP[sim.boss.phase], n);
      assert.ok(n <= 84, 'frame ' + f + ': ' + n);
    }
    console.log(`  seed ${seed}: max bullets ${max} (phase 1 ${maxP[1]}, phase 2 ${maxP[2]}, phase 3 ${maxP[3]})`);
    assert.ok(maxP[2] >= 71, 'walls on screen'); assert.ok(maxP[1] >= 15 && maxP[3] >= 25, 'other phases busy');
    assert.equal(sim.state, 'bossOut', 'run ends by the boss timeout');
  }
});

test('bullet speeds: every falling or flying boss bullet is 1.2 to 1.4; only a rising bubble is slower', () => {
  const sim = toPlay(createSim({ seed: 10, mode: 'stage10' })); sim.setGod(true);
  let lo = 9, hi = 0, rising = 0;
  for (let i = 0; i < 5200 && sim.boss.on; i++) {
    if (i === 1500) B.setPhase(sim.ctx, 2);
    if (i === 3500) B.setPhase(sim.ctx, 3);
    step(sim, 1, sweep(i));
    for (const b of sim.eb) if (b.on) {
      if (b.big && b.vy < 0 && b.vx === 0 && Math.abs(b.vy + 1 / 3) < 1e-12) { rising++; continue; }
      const v = Math.hypot(b.vx, b.vy); lo = Math.min(lo, v); hi = Math.max(hi, v);
    }
  }
  assert.ok(lo >= 1.2 - 1e-9 && hi <= 1.4 + 1e-9, `speeds ${lo}..${hi}`); assert.ok(rising > 0);
});

test('phase triggers: all tendrils cut -> phase 2, lens below 50% -> phase 3; bullets clear, 8 hit-stop, popup, 20 quiet frames', () => {
  const sim = fight(11), S = sim.ctx, boss = sim.boss, mw = boss.mw;
  step(sim, 200);
  mw.th[0] = mw.th[1] = mw.th[2] = mw.th[3] = mw.th[4] = 0; step(sim, 3); assert.equal(boss.phase, 1, '5 cut is still phase 1');
  while (sim.liveBullets() === 0) step(sim);
  mw.th[5] = 0; sim.clearEvents(); sim.step(IDLE);
  let popped = false; sim.drain((b, o) => { if (b[o] === EV_POPUP && b[o + 1] === POP_PHASE2) popped = true; });
  assert.equal(boss.phase, 2); assert.ok(popped); assert.equal(sim.hitstop, 8); assert.equal(sim.liveBullets(), 0);
  step(sim, 8);
  for (let i = 0; i < 20; i++) { step(sim); assert.equal(sim.liveBullets(), 0); assert.equal(boss.aimT + boss.wallT, 0, 'quiet ' + i); }
  step(sim); assert.ok(boss.wallT === 30, 'gap glow starts right after the quiet period');
  step(sim, 600);
  boss.lens = 12; step(sim, 2); assert.equal(boss.phase, 2, '12 of 24 is not below 50%');
  boss.lens = 11; sim.step(IDLE); sim.clearEvents();
  assert.equal(boss.phase, 3); assert.equal(sim.hitstop, 8); assert.equal(sim.liveBullets(), 0);
  assert.deepEqual(Array.from(mw.sh), [10, 10, 10]);
  step(sim, 8);
  for (let i = 0; i < 20; i++) { step(sim); assert.equal(sim.liveBullets(), 0, 'quiet ' + i); }
  // shards orbit the center at radius 50
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(Math.hypot(mw.sx[i] - boss.x, mw.sy[i] - boss.y) - 50) < 1e-9);
});

test('scoring contract: tip hits do S.hits++; a cut calls S.pieceKill(800); bell deflects without a hit', () => {
  const sim = fight(12), S = sim.ctx, boss = sim.boss, mw = boss.mw;
  const pk = []; const orig = S.pieceKill; S.pieceKill = v => { pk.push(v); return orig(v); };
  let h = S.hits, p = shotAt(sim, boss.x, boss.y);
  assert.equal(B.shot(S, p), true); assert.equal(S.hits, h, 'bell deflects'); assert.equal(p.on, false);
  for (let i = 0; i < 6; i++) { p = shotAt(sim, mw.tx[2], mw.ty[2]); assert.equal(B.shot(S, p), true); }
  assert.equal(S.hits, h + 6); assert.equal(mw.th[2], 0); assert.deepEqual(pk, [800]);
  assert.ok(mw.cutT[2] === 0, 'debris starts falling');
  p = shotAt(sim, mw.tx[2], mw.ty[2] + 30); assert.equal(B.shot(S, p), false, 'a cut tendril is gone');
  S.pieceKill = orig;
});

test('lens: open only for the 60 frames after each wall spawns; closed lens deflects (no hit); open lens hits; break is a piece', () => {
  const sim = fight(13), S = sim.ctx, boss = sim.boss;
  B.setPhase(S, 2);
  const pk = []; const orig = S.pieceKill; S.pieceKill = v => { pk.push(v); return orig(v); };
  const n = boss.walls; while (boss.walls === n) step(sim);
  let open = 0; while (boss.lensT > 0) { open++; step(sim); }
  assert.equal(open, 60);
  let h = S.hits, p = shotAt(sim, boss.x, boss.y + 4);
  assert.equal(B.shot(S, p), true); assert.equal(S.hits, h, 'closed: deflected'); assert.equal(boss.lens, 24);
  // a shot coming up the lens column flies on until it reaches the lens
  p = shotAt(sim, boss.x, boss.y + 18); assert.equal(B.shot(S, p), false); assert.equal(p.on, true); p.on = false;
  while (boss.lensT === 0) step(sim);
  for (let i = 0; i < 13; i++) { p = shotAt(sim, boss.x + 2, boss.y + 5); assert.equal(B.shot(S, p), true); }
  assert.equal(S.hits, h + 13); assert.equal(boss.lens, 11); assert.deepEqual(pk, [1000], 'lens break');
  step(sim); assert.equal(boss.phase, 3);
  S.pieceKill = orig;
});

test('shatter: shards 10 hp, 1000 per shard; the last one dives every 180 after a 30-frame wobble; killing all three wins', () => {
  const sim = fight(14), S = sim.ctx, boss = sim.boss, mw = boss.mw;
  B.setPhase(S, 3); step(sim, 30);
  const pk = []; const orig = S.pieceKill; S.pieceKill = v => { pk.push(v); return orig(v); };
  for (const i of [0, 1]) for (let k = 0; k < 10; k++) { const p = shotAt(sim, mw.sx[i], mw.sy[i]); assert.equal(B.shot(S, p), true); }
  assert.deepEqual(pk, [1000, 1000]); assert.equal(boss.on, true);
  const starts = []; let prev = 0, fell = false;
  for (let i = 0; i < 900; i++) {
    step(sim, 1, sweep(i));
    if (boss.dState === 1 && prev !== 1) starts.push(boss.at);
    if (boss.dState === 2 && mw.sy[2] > 280) fell = true;
    prev = boss.dState;
  }
  assert.ok(fell, 'the shard dives down past the player row');
  const g = starts.slice(1).map((v, i) => v - starts[i]);
  assert.ok(starts.length >= 4 && g.every(v => v >= 180) && g.filter(v => v === 180).length * 2 >= g.length, 'dive every 180: ' + g.join(','));
  for (let k = 0; k < 10 && boss.on; k++) { const p = shotAt(sim, mw.sx[2], mw.sy[2]); B.shot(S, p); }
  assert.equal(boss.on, false); assert.equal(sim.state, 'bossOut'); assert.equal(pk.length, 3);
  S.pieceKill = orig;
});

test('the diving shard kills the player on contact (god off)', () => {
  const sim = fight(15, false), S = sim.ctx, boss = sim.boss, mw = boss.mw;
  B.setPhase(S, 3); step(sim, 30); mw.sh[0] = mw.sh[1] = 0;
  let died = false;
  for (let i = 0; i < 1500 && !died; i++) {
    for (const b of sim.eb) b.on = false; // only the body can kill here
    const d = sim.deaths; step(sim); if (sim.deaths > d) died = true;
  }
  assert.ok(died, 'an idle player dies to the dive');
});

test('bossPhase hook: works during the entrance and after; info bossPhase; taints the run', () => {
  const sim = createSim({ seed: 16, mode: 'stage10' }), SF = { info() { return {}; } };
  installHooks(SF, { sim, stepSim: () => false });
  assert.equal(SF.bossPhase(3), true); assert.equal(sim.tainted, true);
  toPlay(sim); while (sim.boss.entering) step(sim);
  step(sim); assert.equal(SF.info().bossPhase, 3, 'phase change runs at the end of the entrance');
  const s2 = createSim({ seed: 17, mode: 'stage10' }), SF2 = { info() { return {}; } };
  installHooks(SF2, { sim: s2, stepSim: () => false });
  toPlay(s2); while (s2.boss.entering) step(s2);
  assert.equal(SF2.info().bossPhase, 1); assert.equal(s2.tainted, false);
  assert.equal(SF2.bossPhase(2), true); assert.equal(SF2.info().bossPhase, 2); assert.equal(s2.hitstop, 8);
  assert.equal(SF2.bossPhase(1), true); assert.equal(s2.boss.phase, 1); assert.deepEqual(Array.from(s2.boss.mw.th), [6, 6, 6, 6, 6, 6]);
});

test('deterministic, and stateHash covers the Moonwell state', () => {
  const run = seed => { const sim = toPlay(createSim({ seed, mode: 'stage10' })); sim.setGod(true); for (let i = 0; i < 4000; i++) { if (i === 1200) B.setPhase(sim.ctx, 2); if (i === 3000) B.setPhase(sim.ctx, 3); step(sim, 1, sweep(i)); } return sim.stateHash(); };
  assert.equal(run(18), run(18));
  const a = fight(19), b = fight(19);
  B.setPhase(a.ctx, 2); B.setPhase(b.ctx, 2); step(a, 100); step(b, 100);
  assert.equal(a.stateHash(), b.stateHash());
  for (const [k, v] of [['phase', 3], ['quiet', 5], ['at', 7], ['lens', 3], ['lensT', 9], ['wallT', 4], ['gapX', 77], ['gapPrev', 66], ['walls', 99], ['dState', 1], ['aimX', 11]]) {
    const old = b.boss[k]; b.boss[k] = v;
    assert.notEqual(a.stateHash(), b.stateHash(), k); b.boss[k] = old;
  }
  b.boss.mw.th[3] = 2; assert.notEqual(a.stateHash(), b.stateHash(), 'tendril hp'); b.boss.mw.th[3] = a.boss.mw.th[3];
  assert.equal(a.stateHash(), b.stateHash());
});

test('HUD hp bar: full at start, counts down through tendrils, lens (to its break) and shards', () => {
  const sim = fight(20), boss = sim.boss;
  assert.deepEqual(Array.from(sim.bossHp()), [36 + 13 + 30, 79]);
  B.setPhase(sim.ctx, 2); step(sim, 10); assert.equal(sim.bossHp()[0], 13 + 30);
  B.setPhase(sim.ctx, 3); step(sim, 10); assert.equal(sim.bossHp()[0], 30);
  assert.equal(boss.phase, 3);
});

test('draw layer: draws every phase and telegraph without touching the sim, and stays off for other bosses', () => {
  let dots = 0, texts = [];
  const R = { dot() { dots++; }, text(s) { texts.push(s); }, ui: { F: 0 } };
  const sim = fight(21), S = sim.ctx, boss = sim.boss;
  const frames = [[1, 300], [2, 700], [3, 300]];
  for (const [ph, n] of frames) {
    if (ph > 1) B.setPhase(S, ph);
    for (let i = 0; i < n; i++) {
      step(sim, 1, sweep(i)); R.ui.F++;
      const h = sim.stateHash(); dots = 0;
      moonwellLayer.draw(R, sim, 0.5);
      assert.ok(dots > 30, 'drew the boss'); assert.equal(sim.stateHash(), h, 'render never writes the sim');
    }
  }
  assert.ok(texts.includes('SHATTER'));
  const e = toPlay(createSim({ seed: 1, mode: 'stage5' })); dots = 0; moonwellLayer.draw(R, e, 0.5); assert.equal(dots, 0);
});

// ---------- review fixes: literal numbers, measured from behavior ----------
test('phase 3 change pops (POP_CORE) with shake 6 and 8 hit-stop, like phase 2', () => {
  const sim = fight(30), boss = sim.boss;
  B.setPhase(sim.ctx, 2); step(sim, 100);
  boss.lens = 11; sim.clearEvents(); sim.step(IDLE);
  let pop = false, shake = 0;
  sim.drain((b, o) => { if (b[o] === EV_POPUP && b[o + 1] === POP_CORE) pop = true; if (b[o] === EV_SHAKE) shake = Math.max(shake, b[o + 1]); });
  assert.equal(boss.phase, 3); assert.ok(pop, 'phase 3 popup'); assert.equal(shake, 6); assert.equal(sim.hitstop, 8);
});

test('literal B.6 numbers: shard ring of exactly 6; phase 2 aimed pair every 90', () => {
  const sim = fight(31), S = sim.ctx, boss = sim.boss;
  B.setPhase(S, 3);
  const vols = []; let cur = null;
  const orig = S.eFire; S.eFire = (x, y, vx, vy, big) => { if (big) { if (!cur) { cur = { n: 0 }; vols.push(cur); } cur.n++; } orig(x, y, vx, vy, big); };
  for (let i = 0; i < 600; i++) { cur = null; step(sim); }
  S.eFire = orig;
  assert.ok(vols.length >= 10 && vols.every(v => v.n === 6), 'rings of 6: ' + vols.map(v => v.n).join(','));
  const s2 = fight(32); B.setPhase(s2.ctx, 2);
  const at = []; const o2 = s2.ctx.eFire; let last = -1;
  s2.ctx.eFire = (x, y, vx, vy, big) => { if (!big && vx !== 0 && s2.boss.at !== last) { last = s2.boss.at; at.push(s2.boss.at); } o2(x, y, vx, vy, big); };
  for (let i = 0; i < 1500; i++) step(s2);
  assert.ok(at.length >= 12 && at.every(a => a % 90 === 0), 'pairs at ' + at.join(','));
});

test('gap center never below 40 or above 360, even from a previous gap at the edge (60 and 340)', () => {
  for (const prev of [60, 340, 41, 359]) {
    let lo = 1e9, hi = -1e9;
    for (let seed = 40; seed < 70; seed++) {
      const sim = fight(seed); B.setPhase(sim.ctx, 2); step(sim, 30);
      const boss = sim.boss;
      boss.gapPrev = prev; boss.wallOn = false; boss.wallT = 0;
      while (boss.wallT === 0) step(sim);
      lo = Math.min(lo, boss.gapX); hi = Math.max(hi, boss.gapX);
      assert.ok(boss.gapX >= 40 && boss.gapX <= 360 && Math.abs(boss.gapX - prev) <= 160, `prev ${prev}: gap ${boss.gapX}`);
    }
    if (prev <= 60) assert.ok(lo < 50, `from ${prev} the low edge is used: ${lo}`);
    if (prev >= 340) assert.ok(hi > 330, `from ${prev} the high edge is used: ${hi}`);
  }
});

test('player down cancels the gap glow; it restarts in full (30 frames) when play resumes', () => {
  const sim = fight(33, false), S = sim.ctx, boss = sim.boss;
  B.setPhase(S, 2);
  while (boss.wallT !== 15) step(sim);
  sim.player.inv = 0; S.playerDie();
  while (sim.hitstop > 0) step(sim); // death hit-stop freezes the boss first
  step(sim); assert.equal(boss.wallT, 0, 'glow cancelled while the player is down');
  let n = 0; while (sim.state !== 'play') { step(sim); assert.equal(boss.wallT, 0); n++; }
  step(sim); assert.equal(boss.wallT, 30, 'fresh 30-frame glow');
});

test('setPhase(1) from a later phase restores the hanging bell (flip 0)', () => {
  const sim = fight(34); B.setPhase(sim.ctx, 2); step(sim, 40);
  assert.equal(sim.boss.flip, 1);
  B.setPhase(sim.ctx, 1); assert.equal(sim.boss.flip, 0); step(sim, 40); assert.equal(sim.boss.flip, 0);
});
