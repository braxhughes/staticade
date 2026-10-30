// PYRE (slice S9, design.md B.6): entrance, phase triggers and the phase-change rule, the arc ring and its gap
// (every gap within 200 units of the player), the shot pull, the breath cycle, petal scoring, telegraph lead time
// before every bullet-spawning or dive event, the bullet cap, and the section C verify line.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { bosses, bossId } from '../games/starfall/sim/registry.js';
import { installHooks } from '../games/starfall/hooks.js';
import { packWord } from '../engine/input-word.js';
import { EV_POPUP, POP_PHASE2, POP_CORE } from '../games/starfall/defs.js';
import { PYRE } from '../games/starfall/sim/bosses/pyre.js';

const IDLE = 128, B = bosses.pyre;
const step = (sim, n = 1, w = IDLE) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(w); sim.clearEvents(); } return sim; };
const toPlay = sim => { while (sim.state !== 'play') step(sim); return sim; };
// touch word: the ship steers toward x
const goTo = x => packWord(0, false, false, false, true, x);
function fight(seed, phase = 1) {
  const sim = toPlay(createSim({ seed, mode: 'stage15' }));
  sim.setGod(true);
  while (sim.boss.entering) step(sim);
  if (phase > 1) { B.setPhase(sim.ctx, phase); step(sim, 1 + 8 + PYRE.quiet); }
  return sim;
}
// log every enemy bullet the sim fires: frame, origin, velocity
function logFire(sim) {
  const S = sim.ctx, log = [], orig = S.eFire;
  S.eFire = (x, y, vx, vy, big) => { log.push({ f: sim.frame, x, y, vx, vy, sp: Math.hypot(vx, vy) }); orig(x, y, vx, vy, big); };
  return log;
}
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

test('stage 15 is PYRE: 120-frame invulnerable entrance, then phase 1 with 12 petals of 4 hp and a 30 hp core', () => {
  assert.equal(bossId('pyre'), 'pyre');
  const sim = toPlay(createSim({ seed: 1, mode: 'stage15' })), boss = sim.boss;
  assert.equal(boss.id, 'pyre'); assert.equal(boss.name, 'PYRE');
  let n = 0;
  while (boss.entering) {
    if (n === 60) {
      const p = sim.ps[0]; p.on = true; p.x = p.px = boss.x; p.y = p.py = boss.y + 5;
      const hits = sim.hits;
      assert.equal(B.shot(sim.ctx, p), true); assert.equal(p.on, false); assert.equal(sim.hits, hits, 'deflected, not a hit');
      assert.equal(boss.core, 30);
    }
    step(sim); n++;
  }
  assert.equal(n, 120); assert.equal(boss.phase, 1); assert.equal(boss.y, 88);
  for (let k = 0; k < 12; k++) { assert.equal(boss.fHp[k], 4); assert.equal(boss.fSt[k], 0); }
  assert.equal(boss.core, 30);
  assert.deepEqual(Array.from(sim.bossHp()), [12 * 4 + 30, 12 * 4 + 30]);
});

test('phase triggers: 6 petals gone -> phase 2, core at 40% -> phase 3; bullets clear, 8 hit-stop, popup, 20 quiet frames', () => {
  const sim = fight(2), boss = sim.boss;
  for (const [want, pop] of [[2, POP_PHASE2], [3, POP_CORE]]) {
    while (sim.liveBullets() === 0) step(sim);
    if (want === 2) { let gone = 0; for (let k = 0; k < 12; k++) if (boss.fSt[k] >= 2) gone++; for (let k = 0; gone < 6; k++) if (boss.fSt[k] < 2) { boss.fSt[k] = 3; boss.fHp[k] = 0; gone++; } }
    else boss.core = 12;
    sim.clearEvents(); sim.step(IDLE);
    let popped = false; sim.drain((b, o) => { if (b[o] === EV_POPUP && b[o + 1] === pop) popped = true; });
    assert.equal(boss.phase, want); assert.ok(popped, 'popup'); assert.equal(sim.hitstop, 8); assert.equal(sim.liveBullets(), 0);
    step(sim, 8); assert.equal(sim.hitstop, 0);
    for (let i = 0; i < 20; i++) {
      step(sim); assert.equal(sim.liveBullets(), 0, 'quiet frame ' + i);
      assert.equal(boss.aimT + boss.ringT + boss.burstT + boss.guideT + boss.wAim + boss.wBurst, 0);
      for (let k = 0; k < 12; k++) { assert.notEqual(boss.fSt[k], 1, 'no petal telegraph in the quiet frames'); assert.equal(boss.fAimT[k], 0); }
    }
    step(sim); assert.ok(boss.ringT + boss.guideT + boss.at > 0, 'attacks resume');
  }
  assert.equal(boss.scale, 0.6);
  // phase 3: the remaining attached petals all start their 40-frame detach telegraph together
  let tele = 0, on = 0; for (let k = 0; k < 12; k++) { if (boss.fSt[k] === 1) tele++; if (boss.fHp[k] > 0 && boss.fSt[k] <= 1) on++; }
  assert.ok(tele > 0 && tele === on, 'remaining petals detach together: ' + tele + ' of ' + on);
  step(sim, 41); for (let k = 0; k < 12; k++) assert.notEqual(boss.fSt[k], 1);
});

test('section C verify: SF.start(15); SF.god(); SF.bossPhase(3); over 600 frames bullets <= 96', () => {
  const sim = createSim({ seed: 15, mode: 'stage15' }), SF = { info: () => ({}) };
  installHooks(SF, { sim });
  sim.setGod(true);
  assert.equal(SF.bossPhase(3), true);
  let mx = 0;
  for (let i = 0; i < 600; i++) { step(sim); mx = Math.max(mx, SF.info().bullets); }
  assert.equal(SF.info().bossPhase, 3);
  assert.ok(mx > 20 && mx <= 96, 'peak bullets ' + mx);
});

// a ring is a burst of more than 40 bullets on one frame at the ring speed
function ringsOf(log) {
  const by = new Map();
  for (const b of log) if (near(b.sp, 1.4)) { if (!by.has(b.f)) by.set(b.f, []); by.get(b.f).push(b); }
  return [...by.values()].filter(r => r.length > 40);
}

test('arc ring: 5-unit slots at the player row, a 48-unit gap locked at the marker, every gap within 200 units of the player', () => {
  let total = 0, clamped = 0, unclamped = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const sim = fight(seed, 2), boss = sim.boss, log = logFire(sim), spawns = [];
    let last = boss.rings;
    // the ship hugs one wall, then the other, then wanders, so the marker is often far away
    for (let i = 0; i < 3000; i++) {
      const tx = i < 1000 ? 10 : i < 2000 ? 390 : 200 + 180 * Math.sin(i * 0.02 + seed);
      sim.step(goTo(tx)); sim.clearEvents();
      // the ring locks the marker as it stands on its spawn frame, and the player's x on that frame
      if (boss.rings > last) { last = boss.rings; spawns.push({ f: sim.frame, mk: boss.mk, px: boss.gapPx, gap: boss.gapX }); }
    }
    const rings = ringsOf(log);
    assert.equal(rings.length, spawns.length);
    assert.ok(rings.length >= 10, 'rings ' + rings.length);
    rings.forEach((ring, i) => {
      const s = spawns[i];
      // the gap is the marker, pulled toward the player until it is at most 200 units away
      const d = Math.abs(s.gap - s.px);
      assert.ok(d <= 200 + 1e-9, 'gap ' + s.gap + ' is ' + d + ' from the player');
      if (Math.abs(s.mk - s.px) <= 200) { assert.equal(s.gap, s.mk); unclamped++; }
      else { assert.ok(near(d, 200) && Math.abs(s.gap - s.mk) < Math.abs(s.px - s.mk), 'moved toward the player'); clamped++; }
      // every bullet crosses the player's row (y = 274) on a 5-unit slot, none within 24 units of the gap
      const xs = ring.map(b => b.x + b.vx * (274 - b.y) / b.vy).sort((a, b) => a - b);
      for (const x of xs) { assert.ok(near(x / 5, Math.round(x / 5), 1e-6), 'slot ' + x); assert.ok(Math.abs(x - s.gap) > 24, 'bullet in the gap'); }
      for (let k = 1; k < xs.length; k++) { const g = xs[k] - xs[k - 1]; assert.ok(g < 5 + 1e-6 || (xs[k - 1] < s.gap && xs[k] > s.gap), 'only the gap is open: ' + g); }
      // 81 slots minus those within 24 units of the gap: 9 or 10 removed (about 72 bullets), fewer only at a wall
      let want = 0; for (let k = 0; k <= 80; k++) if (Math.abs(5 * k - s.gap) > 24) want++;
      assert.equal(ring.length, want); assert.ok(want >= 71 && want <= 75, 'about 72 bullets: ' + want);
      // the ship can stand in the gap: its 7-unit box fits between the gap's edge bullets with no bullet inside
      const lo = Math.max(...xs.filter(x => x < s.gap), -99), hi = Math.min(...xs.filter(x => x > s.gap), 499);
      assert.ok(hi - lo >= 45, 'gap width ' + (hi - lo));
      total++;
    });
  }
  assert.ok(total >= 60);
  assert.ok(clamped > 0 && unclamped > 0, 'both cases seen: clamped ' + clamped + ', unclamped ' + unclamped);
});

test('arc ring always spawns in full, even over the cap, and the marker sweeps 30..370 at 1.2 units/frame', () => {
  const sim = fight(9, 2), boss = sim.boss, log = logFire(sim);
  let lo = 999, hi = -1, prev = boss.mk, maxStep = 0;
  // fill the screen with parked bullets near the top so the cap is nearly full
  const park = () => { let n = 0; for (const b of sim.eb) { if (n >= 90) break; if (!b.on) { b.on = true; b.x = b.px = 5 + (n % 45) * 8; b.y = b.py = 2; b.vx = 0; b.vy = 0; } n++; } };
  while (boss.ringT === 0) { step(sim); maxStep = Math.max(maxStep, Math.abs(boss.mk - prev)); prev = boss.mk; }
  park();
  assert.ok(sim.liveBullets() >= 90);
  while (boss.ringT > 0) step(sim);
  prev = boss.mk;
  const rings = ringsOf(log);
  assert.equal(rings.length, 1); assert.ok(rings[0].length >= 71, 'full ring over the cap: ' + rings[0].length);
  assert.ok(sim.liveBullets() > 96, 'the ring went over the cap rather than wait');
  for (let i = 0; i < 1000; i++) { step(sim); lo = Math.min(lo, boss.mk); hi = Math.max(hi, boss.mk); maxStep = Math.max(maxStep, Math.abs(boss.mk - prev)); prev = boss.mk; }
  assert.equal(lo, 30); assert.equal(hi, 370); assert.ok(near(maxStep, 1.2, 1e-6), 'marker speed ' + maxStep);
});

test('breath: ring at inhale start, inhale 150, exhale 90 with a burst of 16 (1.5); the core is hittable only on the exhale', () => {
  const sim = fight(4, 2), boss = sim.boss, S = sim.ctx, log = logFire(sim);
  while (boss.breath !== 1) step(sim);
  const ringF = sim.frame;
  const r0 = log.filter(b => b.f === ringF).length;
  assert.ok(r0 === 71 || r0 === 72, 'ring spawned on the first inhale frame: ' + r0);
  let n = 0; while (boss.breath === 1) { step(sim); n++; } assert.equal(n, 150, 'inhale 150');
  const burst = log.filter(b => b.f === sim.frame);
  assert.equal(burst.length, 16); assert.ok(burst.every(b => near(b.sp, 1.5)));
  // the core is open now; a shot at it lands
  let p = sim.ps[0]; p.on = true; p.x = p.px = boss.x; p.y = p.py = boss.y + 4;
  let hits = S.hits, core = boss.core;
  assert.equal(B.shot(S, p), true); assert.equal(boss.core, core - 1); assert.equal(S.hits, hits + 1);
  n = 0; while (boss.breath === 2) { step(sim); n++; } assert.equal(n, 90, 'exhale 90');
  assert.equal(boss.breath, 1);
  // inhale: closed, the shot deflects and is not a hit
  p = sim.ps[0]; p.on = true; p.x = p.px = boss.x; p.y = p.py = boss.y + 4; hits = S.hits; core = boss.core;
  assert.equal(B.shot(S, p), true); assert.equal(p.on, false); assert.equal(boss.core, core); assert.equal(S.hits, hits);
});

test('shot pull: inhale accelerates shots 0.03/frame^2 toward the core x, capped at 1.2; exhale decays x0.8; vertical speed unchanged', () => {
  const sim = fight(5, 2), boss = sim.boss;
  while (boss.breath !== 1) step(sim);
  step(sim, 5);
  // fire from far left of the core, then watch the shot
  while (Math.abs(sim.player.x - 60) > 1) step(sim, 1, goTo(60));
  step(sim, 1, packWord(0, true, true, false, false, 0));
  const i = sim.ps.findIndex(p => p.on), p = sim.ps[i];
  let y = p.y, x = p.x, v = boss.sVx[i], frames = 0;
  assert.ok(near(v, 0.03), 'first pull step on the firing frame');
  while (p.on && boss.breath === 1 && frames < 40) {
    step(sim);
    if (!p.on) break;
    const nv = p.x - x;
    assert.ok(near(y - p.y, 6.5, 1e-9), 'vertical speed unchanged');
    assert.ok(near(nv, Math.min(1.2, v + 0.03), 1e-9), 'pull step ' + nv + ' after ' + v);
    v = nv; x = p.x; y = p.y; frames++;
  }
  assert.ok(frames >= 30);
  // a shot pulled long enough reaches the cap
  boss.sVx[i] = 1.19; x = p.x; step(sim); assert.ok(near(p.x - x, 1.2, 1e-9));
  // exhale: the sideways speed decays x0.8 per frame
  while (boss.breath !== 2) step(sim);
  const q = sim.ps[0]; q.on = true; q.x = q.px = 150; q.y = q.py = 250; boss.sVx[0] = 1; boss.sY[0] = 260;
  step(sim); assert.ok(near(boss.sVx[0], 0.8)); step(sim); assert.ok(near(boss.sVx[0], 0.64));
});

test('petal scoring: an attached petal kill is a 600-base piece, a detached one 300; hits count, deflects do not', () => {
  const sim = fight(6), boss = sim.boss, S = sim.ctx, bases = [];
  const orig = S.pieceKill; S.pieceKill = base => { bases.push(base); return orig(base); };
  // attached petal 3: four hits
  for (let i = 0; i < 4; i++) {
    const p = sim.ps[0]; p.on = true; p.x = p.px = boss.fX[3]; p.y = p.py = boss.fY[3];
    const h = S.hits; assert.equal(B.shot(S, p), true); assert.equal(S.hits, h + 1);
  }
  assert.equal(boss.fSt[3], 3); assert.deepEqual(bases, [600]);
  // wait for a petal to dive, then shoot it down
  let k = -1; while (k < 0) { step(sim); for (let j = 0; j < 12; j++) if (boss.fSt[j] === 2) k = j; }
  for (let i = 0; i < 4; i++) { const p = sim.ps[0]; p.on = true; p.x = p.px = boss.fX[k]; p.y = p.py = boss.fY[k]; B.shot(S, p); }
  assert.equal(boss.fSt[k], 3); assert.deepEqual(bases, [600, 300]);
});

test('telegraphs: every bullet-spawning or dive event has >= 20 frames of visible warning; speeds stay in 1.3..2.0', () => {
  for (const [seed, phase, frames] of [[11, 1, 1500], [12, 2, 2000], [13, 3, 1500], [14, 1, 4000]]) {
    // record from phase 1 on, so the phase change and its quiet frames are in the history too
    const sim = fight(seed), boss = sim.boss, S = sim.ctx, hist = [], fails = [];
    let spawns = 0, dives = 0;
    // telegraph state exactly as render/bosses/pyre.js draws it, recorded after every frame
    const snap = () => ({
      aim: boss.aimT > 0 || boss.wAim > 0, ring: boss.ringT > 0, burst: boss.burstT > 0 || boss.wBurst > 0,
      guide: boss.guideT > 0 || boss.spiral, phase: boss.phase,
      pTele: Array.from(boss.fSt, s => s === 1), pAim: Array.from(boss.fAimT, (t, k) => t > 0 || boss.fWait[k] > 0)
    });
    const warned = (f, key, k = -1) => { for (let d = 1; d <= 20; d++) { const h = hist[f - d]; if (!h || !(k >= 0 ? h[key][k] : h[key])) return false; } return true; };
    const orig = S.eFire;
    S.eFire = (x, y, vx, vy, big) => {
      const f = hist.length, sp = Math.hypot(vx, vy); spawns++;
      if (sp < 1.3 - 1e-9 || sp > 2.0 + 1e-9) fails.push('speed ' + sp);
      const muzzle = near(x, boss.x) && near(y, boss.y + 12 * boss.scale);
      let k = -1; for (let j = 0; j < 12; j++) if (boss.fSt[j] === 2 && near(x, boss.fX[j]) && near(y, boss.fY[j] + 4)) k = j;
      let ok;
      if (k >= 0) ok = warned(f, 'pAim', k);
      else if (muzzle) ok = warned(f, 'aim');
      else if (near(sp, 1.4)) ok = warned(f, 'ring');
      else if (near(sp, 1.5)) ok = warned(f, 'burst');
      else if (near(sp, 1.3)) ok = warned(f, 'guide');
      else ok = false;
      if (!ok) fails.push('frame ' + f + ' speed ' + sp.toFixed(2) + ' fired without 20 frames of warning');
      orig(x, y, vx, vy, big);
    };
    let wasDive = Array.from(boss.fSt, s => s === 2);
    if (phase > 1) B.setPhase(S, phase);
    for (let i = 0; i < frames && !sim.done; i++) {
      sim.step(goTo(200 + 150 * Math.sin(i * 0.013 + seed))); sim.clearEvents();
      const f = hist.length;
      for (let k = 0; k < 12; k++) {
        const dive = boss.fSt[k] === 2;
        if (dive && !wasDive[k]) { dives++; for (let d = 1; d <= 40; d++) if (!hist[f - d] || !hist[f - d].pTele[k]) { fails.push('petal ' + k + ' dove without 40 frames of glow'); break; } }
        wasDive[k] = dive;
      }
      hist.push(snap());
    }
    assert.deepEqual(fails, [], 'seed ' + seed + ' phase ' + phase);
    assert.ok(spawns > 30, 'spawns ' + spawns);
    if (phase !== 2) assert.ok(dives > 0, 'dives seen');
  }
});

test('bullet cap: other volleys wait for room; phase 2 and 3 stay within 96 over a long fight', () => {
  for (const phase of [2, 3]) {
    const sim = fight(20 + phase, phase);
    let mx = 0;
    for (let i = 0; i < 3000; i++) { sim.step(goTo(200 + 170 * Math.sin(i * 0.01))); sim.clearEvents(); mx = Math.max(mx, sim.liveBullets()); }
    assert.ok(mx <= 96, 'phase ' + phase + ' peak ' + mx);
  }
});

test('deterministic: same seed and inputs give the same hash; the hash covers PYRE state', () => {
  const run = () => { const sim = fight(30, 2); for (let i = 0; i < 900; i++) { sim.step(goTo(100 + i % 200)); sim.clearEvents(); } return sim; };
  const a = run(), b = run();
  assert.equal(a.stateHash(), b.stateHash());
  const h = a.stateHash(); a.boss.mk += 1; assert.notEqual(a.stateHash(), h, 'marker is hashed');
  a.boss.mk -= 1; a.boss.fT[0] += 1; assert.notEqual(a.stateHash(), h, 'petal timers are hashed');
});
