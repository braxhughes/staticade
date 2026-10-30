// PYRE literal B.6 numbers and locked targets (S9 review fixes): attack cadences, counts and speeds per phase,
// dive speed and the locked dive target, aim lock at glow start, the phase 2 hold point, ring start radius,
// the 6-petal trigger, the 48-unit spawn rule, hashing of the shot pull, and the phase 3 star-field reversal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { bosses } from '../games/starfall/sim/registry.js';
import { packWord } from '../engine/input-word.js';
import { z3Dir } from '../games/starfall/render/zones.js';

const IDLE = 128, B = bosses.pyre, CX = 200, H = 300;
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
const goTo = x => packWord(0, false, false, false, true, x);
const step = (sim, n = 1, w = IDLE) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(w); sim.clearEvents(); } return sim; };
function fight(seed, phase = 1) {
  const sim = createSim({ seed, mode: 'stage15' });
  while (sim.state !== 'play') step(sim);
  sim.setGod(true);
  while (sim.boss.entering) step(sim);
  if (phase > 1) { B.setPhase(sim.ctx, phase); step(sim, 1 + 8 + 20); }
  return sim;
}
// every bullet fired, with its source: 'muzzle' (boss aimed volley), 'petal' (a diving petal's shot) or 'core'
function logFire(sim) {
  const S = sim.ctx, boss = sim.boss, log = [], orig = S.eFire;
  S.eFire = (x, y, vx, vy, big) => {
    let src = 'core';
    if (near(x, boss.x) && near(y, boss.y + 12 * boss.scale)) src = 'muzzle';
    for (let k = 0; k < 12; k++) if (boss.fSt[k] === 2 && near(x, boss.fX[k]) && near(y, boss.fY[k] + 4)) src = 'petal';
    log.push({ f: sim.frame, src, x, y, vx, vy, sp: Math.hypot(vx, vy), a: Math.atan2(vy, vx), bx: boss.x, by: boss.y });
    orig(x, y, vx, vy, big);
  };
  return log;
}
const groups = (log, pred) => { const m = new Map(); for (const b of log) if (pred(b)) { if (!m.has(b.f)) m.set(b.f, []); m.get(b.f).push(b); } return [...m.entries()]; };
const gaps = g => g.slice(1).map((e, i) => e[0] - g[i][0]);

test('phase 1: aimed 3-way at 1.8 every 70 frames; a petal dives every 90 at 2.4 with shots at 1.8', () => {
  const sim = fight(41), boss = sim.boss, log = logFire(sim), dives = [];
  let was = Array.from(boss.fSt);
  for (let i = 0; i < 520 && boss.phase === 1; i++) {
    step(sim);
    for (let k = 0; k < 12; k++) { if (was[k] === 1 && boss.fSt[k] === 2) dives.push({ f: sim.frame, k }); was[k] = boss.fSt[k]; }
  }
  const aim = groups(log, b => b.src === 'muzzle');
  assert.ok(aim.length >= 6, 'volleys ' + aim.length);
  for (const [, g] of aim) { assert.equal(g.length, 3); for (const b of g) assert.ok(near(b.sp, 1.8), 'speed ' + b.sp); assert.ok(near(g[1].a - g[0].a, 0.22) && near(g[2].a - g[1].a, 0.22)); }
  assert.deepEqual([...new Set(gaps(aim))], [70]);
  assert.ok(dives.length >= 4, 'dives ' + dives.length);
  assert.deepEqual([...new Set(gaps(dives.map(d => [d.f])))], [90]);
  const petal = log.filter(b => b.src === 'petal');
  assert.ok(petal.length >= 2); for (const b of petal) assert.ok(near(b.sp, 1.8), 'petal shot ' + b.sp);
  // dive speed: a diving petal moves 2.4 units per frame
  const k = dives[0].k; let n = 0;
  const s2 = fight(41); while (s2.boss.fSt[k] !== 2) step(s2);
  for (let i = 0; i < 30 && s2.boss.fSt[k] === 2; i++) { const x = s2.boss.fX[k], y = s2.boss.fY[k]; step(s2); if (s2.boss.fSt[k] === 2) { assert.ok(near(Math.hypot(s2.boss.fX[k] - x, s2.boss.fY[k] - y), 2.4), 'dive speed'); n++; } }
  assert.ok(n >= 20);
});

test('phase 2 trigger: 5 petals gone stays phase 1, the 6th (diving counts) starts phase 2', () => {
  const sim = fight(42), boss = sim.boss;
  for (let k = 0; k < 4; k++) { boss.fSt[k] = 3; boss.fHp[k] = 0; }
  boss.fSt[4] = 2; boss.fX[4] = 100; boss.fY[4] = 120; boss.fVy[4] = 2.4; boss.fTx[4] = 100; // diving counts as gone
  step(sim, 3); assert.equal(boss.phase, 1, '5 gone');
  boss.fSt[5] = 3; boss.fHp[5] = 0; step(sim); assert.equal(boss.phase, 2, '6 gone');
});

test('phase 2: the sun holds at (200, 88); ring bullets start 14 units from the core', () => {
  const sim = fight(43, 2), boss = sim.boss, log = logFire(sim);
  for (let i = 0; i < 600; i++) { step(sim, 1, goTo(80 + (i % 240))); assert.equal(boss.x, CX); assert.equal(boss.y, 88); }
  const ring = log.filter(b => near(b.sp, 1.4));
  assert.ok(ring.length >= 140);
  for (const b of ring) assert.ok(near(Math.hypot(b.x - b.bx, b.y - b.by), 14), 'start radius ' + Math.hypot(b.x - b.bx, b.y - b.by));
});

test('phase 3: 3-arm spiral at 1.3 every 9 frames; aimed 5-way at 2.0 every 60; sway 140', () => {
  const sim = fight(44, 3), boss = sim.boss, log = logFire(sim);
  let mx = 0;
  for (let i = 0; i < 900; i++) { step(sim); if (i > 300) mx = Math.max(mx, Math.abs(boss.x - CX)); }
  const sp = groups(log, b => b.src === 'core' && near(b.sp, 1.3));
  assert.ok(sp.length > 60);
  for (const [, g] of sp) { assert.equal(g.length, 3); assert.ok(near(((g[1].a - g[0].a) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI), 2 * Math.PI / 3, 1e-6)); }
  assert.deepEqual([...new Set(gaps(sp))], [9]);
  const fan = groups(log, b => b.src === 'muzzle');
  assert.ok(fan.length >= 10);
  for (const [, g] of fan) { assert.equal(g.length, 5); for (const b of g) assert.ok(near(b.sp, 2.0)); for (let i = 1; i < 5; i++) assert.ok(near(g[i].a - g[i - 1].a, 0.2)); }
  assert.deepEqual([...new Set(gaps(fan))], [60]);
  assert.ok(mx > 135 && mx <= 140.5, 'phase 3 sway ' + mx);
});

// center bullet angle of a volley vs the direction from its origin to a point
const angTo = (b, x, y) => Math.atan2(y - b.y, x - b.x);
test('aim lock: boss volleys and petal shots fly at where the player was when the glow started', () => {
  for (const phase of [1, 3]) {
    const sim = fight(45 + phase, phase), boss = sim.boss, log = logFire(sim);
    let checked = 0;
    for (let i = 0; i < 1200 && checked < 3; i++) {
      const before = boss.aimT; step(sim, 1, goTo(60));
      if (before === 0 && boss.aimT === 20) {
        const lx = sim.player.x, ly = sim.player.y, f0 = sim.frame;
        // the ship runs across the screen during the glow
        while (sim.frame < f0 + 20) step(sim, 1, goTo(340));
        const g = log.filter(b => b.f === sim.frame && b.src === 'muzzle');
        if (!g.length) continue;
        const c = g[(g.length - 1) / 2];
        assert.ok(Math.abs(sim.player.x - lx) > 40, 'the player moved');
        assert.ok(near(c.a, angTo(c, lx, ly), 1e-9), 'center bullet aims at the locked point');
        assert.ok(Math.abs(c.a - angTo(c, sim.player.x, sim.player.y)) > 0.05, 'not at the current position');
        checked++;
        step(sim, 30, goTo(60));
      }
    }
    assert.equal(checked, 3, 'phase ' + phase);
  }
  // petal shots: locked at their own glow start
  const sim = fight(48), boss = sim.boss, log = logFire(sim);
  let checked = 0;
  const prev = new Float64Array(12);
  for (let i = 0; i < 1500 && checked < 3 && boss.phase === 1; i++) {
    for (let k = 0; k < 12; k++) prev[k] = boss.fAimT[k];
    step(sim, 1, goTo(i % 300 < 150 ? 60 : 340));
    for (let k = 0; k < 12; k++) if (prev[k] === 0 && boss.fAimT[k] === 20 && boss.fSt[k] === 2) {
      const lx = sim.player.x, ly = sim.player.y, f0 = sim.frame, tgt = lx < 200 ? 340 : 60;
      while (sim.frame < f0 + 20) step(sim, 1, goTo(tgt));
      const b = log.find(e => e.f === sim.frame && e.src === 'petal');
      if (!b) break;
      assert.ok(Math.abs(sim.player.x - lx) > 40);
      assert.ok(near(b.a, angTo(b, lx, ly), 1e-9), 'petal shot aims at the locked point');
      checked++;
      break;
    }
  }
  assert.ok(checked >= 1, 'petal shots checked ' + checked);
});

test('dive target: locked at the player x on the detach frame; the petal heads there, not to the moving player', () => {
  const sim = fight(49), boss = sim.boss;
  let k = -1, tx = 0;
  const was = Array.from(boss.fSt);
  while (k < 0) {
    step(sim, 1, goTo(60));
    for (let j = 0; j < 12; j++) { if (was[j] === 1 && boss.fSt[j] === 2) { k = j; tx = sim.player.x; } was[j] = boss.fSt[j]; }
  }
  assert.equal(boss.fTx[k], tx);
  // the ship crosses to the far side; the petal still dives toward the locked x
  while (boss.fSt[k] === 2 && boss.fY[k] < H * 0.9) { step(sim, 1, goTo(340)); assert.equal(boss.fTx[k], tx); }
  assert.ok(boss.fSt[k] === 2, 'still diving');
  assert.ok(Math.abs(boss.fX[k] - tx) < Math.abs(boss.fX[k] - sim.player.x), 'petal x ' + boss.fX[k] + ' locked ' + tx + ' player ' + sim.player.x);
});

test('no petal shot spawns within 48 units of the player (B.9 rule 5)', () => {
  for (const [dy, fires] of [[34, false], [120, true]]) {
    const sim = fight(50), boss = sim.boss, log = logFire(sim), p = sim.player;
    for (let k = 0; k < 12; k++) if (boss.fSt[k] === 1) boss.fSt[k] = 0;
    boss.fSt[0] = 2; boss.fX[0] = p.x; boss.fY[0] = p.y - dy; boss.fVx[0] = 0; boss.fVy[0] = 2.4; boss.fTx[0] = p.x;
    boss.fAimT[0] = 1; boss.fAimX[0] = p.x; boss.fAimY[0] = p.y; boss.fShots[0] = 0;
    step(sim);
    assert.equal(log.filter(b => b.src === 'petal').length, fires ? 1 : 0, 'petal ' + dy + ' above the ship');
  }
});

test('the hash covers the shot pull state (sideways speeds and last y per shot slot)', () => {
  const sim = fight(51, 2), boss = sim.boss, h = sim.stateHash();
  boss.sVx[3] += 0.5; assert.notEqual(sim.stateHash(), h); boss.sVx[3] -= 0.5; assert.equal(sim.stateHash(), h);
  boss.sY[3] += 1; assert.notEqual(sim.stateHash(), h);
});

test('B.6 cosmetic cue: the Z3 star field runs in reverse only in PYRE phase 3', () => {
  const sim = fight(52);
  assert.equal(z3Dir(sim), 1);
  B.setPhase(sim.ctx, 2); step(sim, 30); assert.equal(z3Dir(sim), 1);
  B.setPhase(sim.ctx, 3); step(sim); assert.equal(z3Dir(sim), -1);
  assert.equal(z3Dir({ boss: { on: true, id: 'eclipse', phase: 3 } }), 1);
  assert.equal(z3Dir({ boss: { on: false, id: 'pyre', phase: 3 } }), 1);
});
