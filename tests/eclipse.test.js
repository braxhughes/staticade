// ECLIPSE rebalance (slice S5, design.md B.6): phase triggers and the phase-change rule, the 40-bullet cap,
// telegraph lead time before every boss volley, the core-hit rule, the bossPhase hook, and a deterministic
// scripted bot (god off, base shot, no wingmen) that kills the boss before the timeout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { bosses } from '../games/starfall/sim/registry.js';
import { installHooks } from '../games/starfall/hooks.js';
import { packWord } from '../engine/input-word.js';
import { EV_POPUP, POP_PHASE2, POP_CORE } from '../games/starfall/defs.js';
import { BOSS_TIMEOUT } from '../games/starfall/sim/difficulty.js';

const IDLE = 128, TAU = Math.PI * 2;
const B = bosses.eclipse;
const step = (sim, n = 1, w = IDLE) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(w); sim.clearEvents(); } return sim; };
const toPlay = sim => { while (sim.state !== 'play') step(sim); return sim; };
function fight(seed, god = true) {
  const sim = toPlay(createSim({ seed, mode: 'stage5' }));
  if (god) sim.setGod(true);
  while (sim.boss.entering) step(sim);
  return sim;
}
// a shot placed in the middle of panel sector k at radius r (scaled), as the sim's shot loop would pass it
function shotAt(sim, k, r) {
  const boss = sim.boss, a = boss.rot + (k + 0.5) * Math.PI / 4, p = sim.ps[0];
  p.on = true; p.x = p.px = boss.x + Math.cos(a) * r * boss.scale; p.y = p.py = boss.y + Math.sin(a) * r * boss.scale;
  return p;
}

test('entrance: 120 play frames, invulnerable, then phase 1 with full hp', () => {
  const sim = toPlay(createSim({ seed: 1, mode: 'stage5' })), boss = sim.boss;
  let n = 0;
  while (boss.entering) {
    if (n === 60) {
      const before = Array.from(boss.ph), p = shotAt(sim, 2, 34);
      assert.equal(B.shot(sim.ctx, p), true, 'shot absorbed'); assert.equal(p.on, false);
      assert.deepEqual(Array.from(boss.ph), before, 'no damage while entering');
    }
    step(sim); n++;
  }
  assert.equal(n, 120, 'entrance is 120 frames (B.6)');
  assert.equal(boss.phase, 1); assert.equal(boss.y, 88);
  assert.equal(boss.phMax, 3); assert.equal(boss.core, 16);
  for (let k = 0; k < 8; k++) assert.equal(boss.ph[k], 3);
});

test('phase triggers: 4 panels broken -> phase 2, 6 -> phase 3; bullets clear, 8 hit-stop, shake, popup, 20 quiet frames', () => {
  const sim = fight(2), S = sim.ctx, boss = sim.boss;
  step(sim, 200);
  for (let k = 0; k < 3; k++) boss.ph[k] = 0;
  step(sim, 5); assert.equal(boss.phase, 1, '3 broken is still phase 1');
  for (const [broken, want, pop] of [[4, 2, POP_PHASE2], [6, 3, POP_CORE]]) {
    while (sim.liveBullets() === 0) step(sim);
    for (let k = 0; k < broken; k++) boss.ph[k] = 0;
    sim.clearEvents();
    sim.step(IDLE);
    let popped = false; sim.drain((b, o) => { if (b[o] === EV_POPUP && b[o + 1] === pop) popped = true; });
    assert.equal(boss.phase, want); assert.equal(boss.fury, true);
    assert.ok(popped, 'phase popup'); assert.equal(sim.hitstop, 8); assert.equal(sim.liveBullets(), 0, 'bullets cleared');
    step(sim, 8); assert.equal(sim.hitstop, 0);
    // 20 quiet frames: no new attacks, no telegraphs
    for (let i = 0; i < 20; i++) { step(sim); assert.equal(sim.liveBullets(), 0, 'quiet frame ' + i); assert.equal(boss.aimT + boss.ringT + boss.guideT, 0); }
    step(sim); assert.ok(boss.aimT + boss.ringT + boss.guideT + boss.at > 0, 'attacks resume after the quiet period');
  }
  assert.equal(boss.scale, 0.7, 'ring shrinks to 70% in phase 3');
  // sway slows to 60
  step(sim, 600); let mx = 0; for (let i = 0; i < 700; i++) { step(sim); mx = Math.max(mx, Math.abs(boss.x - 200)); }
  assert.ok(mx > 55 && mx <= 60.5, 'phase 3 sway ' + mx);
  // breaking a 7th panel in phase 3 changes nothing; phases only move forward
  boss.ph[6] = 0; step(sim); assert.equal(boss.phase, 3); assert.equal(sim.hitstop, 0);
});

test('phase 1 attacks: ring of 8 in the lower half every 140, 3-way every 90, 2 moths every 420; phase 2 summons none', () => {
  const sim = fight(3), S = sim.ctx, boss = sim.boss, log = [];
  const orig = S.eFire; S.eFire = (x, y, vx, vy, big) => { log.push({ at: boss.at, vy, sp: Math.hypot(vx, vy) }); orig(x, y, vx, vy, big); };
  let moths = 0, prev = sim.enemies.length;
  for (let i = 0; i < 900; i++) { step(sim); if (sim.enemies.length > prev) moths += sim.enemies.length - prev; prev = sim.enemies.length; }
  const ring = log.filter(b => Math.abs(b.sp - 1.1) < 1e-9), aim = log.filter(b => Math.abs(b.sp - 1.6) < 1e-9);
  assert.equal(ring.length, 48, '6 rings of 8'); assert.ok(ring.every(b => b.vy > 0), 'ring bullets go down only');
  assert.ok(ring.every(b => b.at % 140 === 0));
  assert.equal(aim.length, 30, '10 aimed 3-ways'); assert.ok(aim.every(b => b.at % 90 === 25));
  assert.equal(log.length, ring.length + aim.length, 'no other boss bullets in phase 1');
  assert.equal(moths, 4, '2 moths at 210, 630');
  B.setPhase(S, 2); step(sim, 8 + 20 + 600);
  assert.equal(sim.enemies.filter(e => !e.dead).length, 0, 'no summons in phase 2');
});

// boss bullets are told apart by phase and speed: 1.1 ring (p1) / spiral (p2), 1.6 aimed 3-way, 1.3 fan, 1.0 ring of 8
test('telegraph lead time: every boss volley follows at least 20 frames of its telegraph (all three phases)', () => {
  const sim = fight(4), S = sim.ctx, boss = sim.boss, spawns = [];
  const orig = S.eFire; S.eFire = (x, y, vx, vy, big) => { spawns.push(Math.round(Math.hypot(vx, vy) * 10)); orig(x, y, vx, vy, big); };
  const run = { aim: 0, ring: 0, guide: 0 }, last = { aim: 0, ring: 0, guide: 0 }, since = { aim: 1e9, ring: 1e9 };
  let checked = { aim: 0, ring: 0, spiral: 0 }, guideDone = false, phase = 1;
  const track = (k, on) => { if (on) run[k]++; else if (run[k] > 0) { last[k] = run[k]; run[k] = 0; if (k !== 'guide') since[k] = 0; } };
  for (const ph of [1, 2, 3]) {
    if (ph > 1) B.setPhase(S, ph);
    for (let i = 0; i < 1800; i++) {
      spawns.length = 0;
      const t0 = boss.t, stopped = sim.hitstop > 0;
      step(sim);
      if (boss.phase !== phase) { phase = boss.phase; guideDone = false; last.guide = 0; }
      if (stopped || boss.t === t0) { assert.equal(spawns.length, 0, 'nothing spawns during hit-stop'); continue; }
      since.aim++; since.ring++;
      track('aim', boss.aimT > 0); track('ring', boss.ringT > 0); track('guide', boss.guideT > 0);
      if (last.guide >= 20) guideDone = true;
      for (const v of spawns) {
        const kind = v === 16 || v === 13 ? 'aim' : v === 10 || (v === 11 && phase === 1) ? 'ring' : 'spiral';
        if (kind === 'spiral') { assert.ok(guideDone, 'spiral after its guide lines'); checked.spiral++; continue; }
        assert.ok(last[kind] >= 20, kind + ' telegraph ' + last[kind] + ' frames');
        assert.ok(since[kind] <= 31, kind + ' fired ' + since[kind] + ' frames after its telegraph ended');
        checked[kind]++;
      }
    }
  }
  assert.ok(checked.aim > 100 && checked.ring > 100 && checked.spiral > 100, JSON.stringify(checked));
});

test('bullet cap: never more than 26 enemy bullets over a long god-mode run through every phase', () => {
  for (const seed of [1, 7]) {
    const sim = toPlay(createSim({ seed, mode: 'stage5' })), S = sim.ctx;
    sim.setGod(true);
    let max = 0, f = 0;
    // the player sweeps slowly so the moths and aimed volleys spread out; phases forced at 1800 and 3600 fight frames
    while (sim.boss.on && sim.state !== 'bossOut') {
      if (sim.boss.fight === 1800 && sim.boss.phase === 1) B.setPhase(S, 2);
      if (sim.boss.fight === 3600 && sim.boss.phase === 2) B.setPhase(S, 3);
      sim.step(packWord(((f++ / 90) | 0) % 2 ? 0.4 : -0.4, false, false, false, false, 0)); sim.clearEvents();
      max = Math.max(max, sim.liveBullets());
      assert.ok(sim.liveBullets() <= 26, 'frame ' + f + ': ' + sim.liveBullets());
    }
    assert.equal(S.D.cap, 26);
    assert.ok(max >= 24, 'the cap is actually approached: ' + max);
    assert.equal(sim.state, 'bossOut', 'run ends by the boss timeout');
  }
});

test('core-hit rule: the core is reachable only through broken sectors, and only in phase 3', () => {
  const sim = fight(5), S = sim.ctx, boss = sim.boss;
  // phase 1: a shot inside the ring deflects off the closed core
  let p = shotAt(sim, 0, 5); assert.equal(B.shot(S, p), true); assert.equal(boss.core, 16);
  B.setPhase(S, 3); step(sim, 30);
  assert.equal(boss.phase, 3);
  const intact = [6, 7], broken = [0, 1, 2, 3, 4, 5];
  // over an intact panel's sector the shot hits that panel and never reaches the core
  for (const k of intact) { const hp = boss.ph[k]; p = shotAt(sim, k, 35); assert.equal(B.shot(S, p), true); assert.equal(boss.ph[k], hp - 1); assert.equal(boss.core, 16); }
  // over a broken panel's sector the shot passes the ring (returns false, stays live)
  for (const k of broken) { p = shotAt(sim, k, 35); assert.equal(B.shot(S, p), false); assert.equal(p.on, true); }
  // a real shot fired from below through an open bottom sector reaches the core
  let hit = false;
  for (let i = 0; i < 2000 && !hit; i++) {
    let a = Math.PI / 2 - boss.rot; a = ((a % TAU) + TAU) % TAU;
    const k = Math.min(7, a / (Math.PI / 4) | 0);
    if (boss.ph[k] <= 0 && !sim.ps.some(s => s.on)) { const s = sim.ps[0]; s.on = true; s.x = s.px = boss.x; s.y = s.py = boss.y + 60; }
    const c = boss.core; step(sim); hit = boss.core < c;
  }
  assert.ok(hit, 'core hit through a broken sector');
  // a shot inside the ring but wide of the core deflects off the hull
  const c = boss.core; p = sim.ps[1]; p.on = true; p.x = p.px = boss.x + 16; p.y = p.py = boss.y + 4; // between the core (13) and the ring (19.6)
  assert.equal(B.shot(S, p), true); assert.equal(boss.core, c);
});

test('bossPhase hook: generic, calls the active boss setPhase, taints the run; info bossPhase (section C verify in Node)', () => {
  const sim = createSim({ seed: 1, mode: 'stage5' });
  const SF = { info() { return {}; } };
  installHooks(SF, { sim, stepSim: () => false });
  assert.equal(SF.info().bossPhase, 1);
  sim.setGod(true); sim.breakPanels(4);
  let max = 0; for (let i = 0; i < 600; i++) { step(sim); max = Math.max(max, sim.liveBullets()); }
  assert.ok(SF.info().bossPhase === 2 && SF.info().bullets <= 40, JSON.stringify(SF.info()));
  const s2 = createSim({ seed: 2, mode: 'stage5' }), SF2 = { info() { return {}; } };
  installHooks(SF2, { sim: s2, stepSim: () => false });
  toPlay(s2); while (s2.boss.entering) step(s2);
  assert.equal(s2.tainted, false);
  assert.equal(SF2.bossPhase(3), true);
  assert.equal(SF2.info().bossPhase, 3); assert.equal(s2.tainted, true); assert.equal(s2.hitstop, 8);
  const s3 = createSim({ seed: 2, mode: 'stage1' }), SF3 = { info() { return {}; } };
  installHooks(SF3, { sim: s3, stepSim: () => false });
  assert.equal(SF3.bossPhase(2), false, 'no boss: no-op'); assert.equal(SF3.info().bossPhase, 0);
});

// ---------- beatable with the base shot (god off, no wingmen) ----------
// A deterministic bot: no RNG of its own, reads sim state each frame. It aims at a panel (or, in phase 3, the
// core through an open sector) predicting where the ring will be when the shot arrives, and picks the move that
// keeps clear of bullets and moths over a short look-ahead.
function botWord(sim, mem) {
  const p = sim.player, boss = sim.boss;
  const vrot = mem.rot == null ? 0 : boss.rot - mem.rot; mem.rot = boss.rot;
  if (!p.alive || sim.state !== 'play') return packWord(0, false, false, false, false, 0);
  const sc = boss.scale, vbx = boss.x - boss.px;
  let tx = boss.x, best = -1e9;
  for (let dx = -38 * sc; dx <= 38 * sc; dx += 1) {
    const rm = 34 * sc; if (Math.abs(dx) >= rm) continue;
    const yc = boss.y + Math.sqrt(rm * rm - dx * dx), T = (p.y - 8 - yc) / 6.5, bx = boss.x + vbx * T;
    let a = Math.atan2(yc - boss.y, dx) - (boss.rot + vrot * T); a = ((a % TAU) + TAU) % TAU;
    const k = Math.min(7, a / (Math.PI / 4) | 0);
    let v;
    if (boss.ph[k] > 0) v = 10 - Math.abs(a - (k + 0.5) * Math.PI / 4) * 10;
    else if (boss.phase === 3 && Math.abs(dx) < 9) v = 20 - Math.abs(dx);
    else continue;
    v -= Math.abs(bx + dx - p.x) * 0.05;
    if (v > best) { best = v; tx = bx + dx; }
  }
  let bestM = 0, bestScore = -1e9;
  for (const m of [-1, -0.5, 0, 0.5, 1]) {
    let x = p.x, vx = p.vx, hit = 29, near = 99;
    for (let t = 1; t <= 28 && hit > 28; t++) {
      vx += (m * 2.7 - vx) * 0.35; x = Math.max(10, Math.min(390, x + vx));
      for (const b of sim.eb) if (b.on) {
        const dx = Math.abs(b.x + b.vx * t - x), dy = Math.abs(b.y + b.vy * t - p.y);
        if (dx < 6 && dy < 7) { hit = t; break; }
        if (dy < 12) near = Math.min(near, dx);
      }
      if (hit > 28) for (const e of sim.enemies) {
        if (e.dead || e.st === 'wait') continue;
        if (Math.abs(e.x + (e.x - e.px) * t - x) < 11 && Math.abs(e.y + (e.y - e.py) * t - p.y) < 11) { hit = t; break; }
      }
    }
    const score = hit * 100 + Math.min(near, 20) * 2 - Math.abs(x - tx) * 0.5;
    if (score > bestScore) { bestScore = score; bestM = m; }
  }
  let shots = 0; for (const s of sim.ps) if (s.on) shots++;
  let mothAbove = false; for (const e of sim.enemies) if (!e.dead && e.st !== 'wait' && Math.abs(e.x - p.x) < 6 && e.y < p.y - 20) mothAbove = true;
  return packWord(bestM, false, shots < 2 && (Math.abs(p.x - tx) < 3 || mothAbove), false, false, 0);
}
function botRun(seed) {
  const sim = createSim({ seed, mode: 'stage5' }), mem = {}, phases = [];
  let start = -1;
  for (let f = 0; f < 12000 && !sim.done && sim.state !== 'bossOut'; f++) {
    const ph = sim.boss.phase;
    sim.step(botWord(sim, mem)); sim.clearEvents();
    if (start < 0 && sim.state === 'play') start = sim.frame;
    if (sim.boss.phase !== ph) phases.push(sim.boss.phase + '@' + sim.frame);
  }
  return { state: sim.state, killed: sim.boss.core <= 0, frame: sim.frame, fightFrames: sim.boss.fight, fromPlay: sim.frame - start,
    deaths: sim.deaths, wing: sim.wing.length, tainted: sim.tainted, hash: sim.stateHash(), phases: phases.join(' ') };
}
test('beatable with the base shot: a god-off scripted bot kills ECLIPSE before the timeout', () => {
  for (const seed of [1, 3, 5]) {
    const r = botRun(seed);
    console.log(`  eclipse bot seed ${seed}: kill at sim frame ${r.frame} (${r.fromPlay} frames of play, ${r.fightFrames} fight frames), deaths ${r.deaths}, phases ${r.phases}`);
    assert.equal(r.state, 'bossOut'); assert.ok(r.killed, 'killed, not timed out');
    assert.ok(r.fightFrames < BOSS_TIMEOUT); assert.equal(r.wing, 0, 'no wingmen'); assert.equal(r.tainted, false, 'no test hooks used');
    assert.ok(r.phases.startsWith('2@') && r.phases.includes('3@'), 'went through phases 2 and 3: ' + r.phases);
    assert.deepEqual(botRun(seed), r, 'deterministic');
  }
});

// ---------- review fixes: literal B.6 numbers, measured from behavior ----------
// spawns grouped per gameplay frame: { at, n, sp } where sp is the speed (x10, rounded) of the volley's bullets
function volleys(sim, frames, w = IDLE) {
  const S = sim.ctx, boss = sim.boss, out = [];
  let cur = null;
  const orig = S.eFire; S.eFire = (x, y, vx, vy, big) => {
    const sp = Math.round(Math.hypot(vx, vy) * 10);
    if (!cur || cur.sp !== sp) { cur = { f: sim.frame, at: boss.at, n: 0, sp, phase: boss.phase }; out.push(cur); }
    cur.n++; orig(x, y, vx, vy, big);
  };
  for (let i = 0; i < frames; i++) { cur = null; step(sim, 1, w); }
  S.eFire = orig;
  return out;
}
const gaps = list => { const g = []; for (let i = 1; i < list.length; i++) g.push(list[i].at - list[i - 1].at); return g; };
const mode = arr => { const c = new Map(); for (const v of arr) c.set(v, (c.get(v) || 0) + 1); return [...c].sort((a, b) => b[1] - a[1])[0][0]; };

test('B.6 body: ring spin 0.006 + 0.002 per broken panel, +0.014 from phase 2; sway 120 in phase 1', () => {
  const sim = fight(11), boss = sim.boss;
  const spin = () => { const r0 = boss.rot; step(sim); return boss.rot - r0; };
  assert.ok(Math.abs(spin() - 0.006) < 1e-12);
  boss.ph[5] = 0; boss.ph[6] = 0; boss.ph[7] = 0;
  assert.ok(Math.abs(spin() - 0.012) < 1e-12, '3 broken');
  let mx = 0; for (let i = 0; i < 700; i++) { step(sim); mx = Math.max(mx, Math.abs(boss.x - 200)); }
  assert.ok(mx > 119 && mx <= 120.001, 'phase 1 sway ' + mx);
  B.setPhase(sim.ctx, 2); step(sim, 8);
  assert.ok(Math.abs(spin() - (0.006 + 4 * 0.002 + 0.014)) < 1e-12, 'phase 2');
});

test('B.6 phase 2 attacks: 2-arm spiral, 2 bullets every 16 frames at 1.1; aimed 3-way at 1.6 every 120', () => {
  const sim = fight(12); B.setPhase(sim.ctx, 2);
  const v = volleys(sim, 3000).filter(x => x.phase === 2);
  const spiral = v.filter(x => x.sp === 11), aim = v.filter(x => x.sp === 16);
  assert.equal(v.length, spiral.length + aim.length, 'nothing else fires');
  assert.ok(spiral.every(x => x.n === 2), 'two arms'); assert.ok(aim.every(x => x.n === 3), '3-way');
  assert.equal(mode(gaps(spiral)), 16); assert.equal(mode(gaps(aim)), 120);
  assert.ok(spiral.length > 150 && aim.length >= 20, spiral.length + ' / ' + aim.length);
});

test('B.6 phase 3 attacks: aimed 5-way fan at 1.3 every 75; ring of 8 at 1.0 every 200; core 16 hp', () => {
  const sim = fight(13); B.setPhase(sim.ctx, 3);
  const v = volleys(sim, 3000).filter(x => x.phase === 3);
  const fan = v.filter(x => x.sp === 13), ring = v.filter(x => x.sp === 10);
  assert.equal(v.length, fan.length + ring.length, 'nothing else fires');
  assert.ok(fan.every(x => x.n === 5), '5-way'); assert.ok(ring.every(x => x.n === 8), 'ring of 8');
  assert.equal(mode(gaps(fan)), 75); assert.equal(mode(gaps(ring)), 200);
  assert.ok(fan.length >= 35 && ring.length >= 12, fan.length + ' / ' + ring.length);
  assert.equal(sim.boss.core, 16);
});

test('core deflects in phase 2 even through a broken sector; in phase 3 the hit area is a circle of 13 x 0.7', () => {
  const sim = fight(14), S = sim.ctx, boss = sim.boss;
  B.setPhase(S, 2); step(sim, 30);
  let p = sim.ps[0]; p.on = true; p.x = p.px = boss.x; p.y = p.py = boss.y + 3;
  assert.equal(B.shot(S, p), true); assert.equal(p.on, false); assert.equal(boss.core, 16, 'phase 2: closed');
  B.setPhase(S, 3); step(sim, 30);
  const cr = 13 * 0.7;
  // inside the circle: hit
  p.on = true; p.x = p.px = boss.x + 3; p.y = p.py = boss.y + 3;
  assert.equal(B.shot(S, p), true); assert.equal(boss.core, 15);
  // heading for the core but still outside the circle: flies on
  p.on = true; p.x = p.px = boss.x + 2; p.y = p.py = boss.y + cr + 4;
  assert.equal(B.shot(S, p), false); assert.equal(p.on, true); assert.equal(boss.core, 15);
  // wide of the circle (inside the ring): deflects off the hull
  p.on = true; p.x = p.px = boss.x + cr + 1; p.y = p.py = boss.y + 4;
  assert.equal(B.shot(S, p), true); assert.equal(p.on, false); assert.equal(boss.core, 15);
});

test('aim lock: the center bullet flies at the point the player held when the glow started (boss sways meanwhile)', () => {
  for (const ph of [1, 2, 3]) {
    const sim = fight(15 + ph), S = sim.ctx, boss = sim.boss;
    if (ph > 1) B.setPhase(S, ph);
    let lock = null, checked = 0, swayed = 0;
    const orig = S.eFire; let vol = [];
    S.eFire = (x, y, vx, vy, big) => { if (!big) vol.push([x, y, vx, vy]); orig(x, y, vx, vy, big); };
    for (let i = 0; i < 1500; i++) {
      const bx = boss.x; vol = [];
      step(sim);
      if (boss.aimT === 20) lock = { x: sim.player.x, y: sim.player.y, bx };
      if (vol.length && lock) {
        const [x, y, vx, vy] = vol[(vol.length - 1) / 2], t = ((lock.x - x) * vx + (lock.y - y) * vy) / (vx * vx + vy * vy);
        const d = Math.hypot(x + vx * t - lock.x, y + vy * t - lock.y);
        assert.ok(d < 2, `phase ${ph}: center bullet misses the locked point by ${d.toFixed(2)}`);
        assert.equal(boss.aimX, lock.x); assert.equal(boss.aimY, lock.y);
        if (Math.abs(boss.x - lock.bx) > 5) swayed++;
        checked++; lock = null;
      }
    }
    assert.ok(checked >= 10 && swayed >= 5, `phase ${ph}: ${checked} volleys, ${swayed} with sway`);
  }
});

test('an idle player is hit by an aimed volley (god off)', () => {
  const sim = fight(20, false), p = sim.player;
  let killer = null;
  for (let i = 0; i < 600 && !killer; i++) {
    const near = sim.eb.filter(b => b.on && Math.abs(b.x - p.x) < 8 && Math.abs(b.y - p.y) < 10);
    step(sim);
    if (sim.deaths > 0) killer = near.find(b => !b.on) || 'unknown';
  }
  assert.ok(killer && killer !== 'unknown', 'died to a bullet');
  assert.equal(killer.big, false, 'an aimed bullet, not a ring');
  assert.ok(Math.abs(Math.hypot(killer.vx, killer.vy) - 1.6) < 1e-9, 'the phase 1 3-way');
});

test('every enemy bullet on the ECLIPSE stage, summoned moths included, flies at 1.0 to 1.6', () => {
  const sim = toPlay(createSim({ seed: 21, mode: 'stage5' })); sim.setGod(true);
  let moth = 0, lo = 9, hi = 0;
  const was = sim.eb.map(b => b.on);
  for (let i = 0; i < 5000 && sim.boss.on; i++) {
    step(sim, 1, packWord(((i / 70) | 0) % 2 ? 0.5 : -0.5, false, false, false, false, 0));
    sim.eb.forEach((b, j) => {
      if (b.on) {
        const v = Math.hypot(b.vx, b.vy); lo = Math.min(lo, v); hi = Math.max(hi, v);
        // a bullet that just appeared next to a moth is a moth shot
        if (!was[j] && sim.enemies.some(e => !e.dead && Math.abs(e.x - b.x) < 10 && Math.abs(e.y - b.y) < 12)) moth++;
      }
      was[j] = b.on;
    });
    if (i === 1800) B.setPhase(sim.ctx, 2);
    if (i === 3400) B.setPhase(sim.ctx, 3);
  }
  assert.ok(lo >= 1.0 - 1e-9 && hi <= 1.6 + 1e-9, `speeds ${lo}..${hi}`);
  assert.ok(moth > 0, 'moth shots were seen and checked');
});

test('a telegraphed volley skipped by the cap leaves no glow, no wait and no bullets behind', () => {
  const sim = fight(22), S = sim.ctx, boss = sim.boss;
  B.setPhase(S, 2); step(sim, 30);
  while (boss.aimT !== 1) step(sim);
  for (const b of sim.eb) b.on = false;
  for (let i = 0; i < 40; i++) S.eFire(20 + i * 9, 20, 0, 0, true); // stationary, far from the player
  step(sim);
  assert.equal(boss.aimT, 0); assert.equal(boss.wAim, 30, 'waiting for room');
  step(sim, 30);
  assert.equal(boss.wAim, 0); assert.equal(boss.aimT, 0, 'no dangling glow'); assert.equal(sim.liveBullets(), 40, 'skipped, not fired');
  assert.equal(sim.telegraphs(), 0);
  // the next 3-way is on its own clock (every 90), with a fresh 20-frame glow
  let next = 0; while (boss.aimT !== 20) { step(sim); next++; }
  assert.ok(next > 20, 'the skip did not pull the next volley forward');
});

test('stateHash covers the boss state that is not in the shared fields (phase, quiet, clocks, aim point)', () => {
  const a = fight(23), b = fight(23);
  assert.equal(a.stateHash(), b.stateHash());
  for (const [k, v] of [['quiet', 5], ['phase', 2], ['at', 7], ['ringT', 3], ['guideT', 4], ['scale', 0.7], ['swayA', 60], ['aimX', 11]]) {
    const old = b.boss[k]; b.boss[k] = v;
    assert.notEqual(a.stateHash(), b.stateHash(), k); b.boss[k] = old;
  }
  assert.equal(a.stateHash(), b.stateHash());
});

test('bossPhase hook rejects a missing or bad phase number', () => {
  const sim = toPlay(createSim({ seed: 24, mode: 'stage5' })), SF = { info() { return {}; } };
  installHooks(SF, { sim, stepSim: () => false });
  while (sim.boss.entering) step(sim);
  for (const bad of [undefined, null, 0, -1, 2.5, '2', NaN]) assert.equal(SF.bossPhase(bad), false, String(bad));
  assert.equal(sim.boss.phase, 1); assert.equal(sim.tainted, false); assert.equal(sim.panelsBroken(), 0);
});
