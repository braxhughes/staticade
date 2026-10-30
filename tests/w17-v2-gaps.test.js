// Test gaps, group 3: surviving V2 mutants. Hound: HOUND_LIFE 600, HOUND_NEAR 16, HOUND_HIT 7, the shadow ring
// filled with the ship's x at stage start. Tetherling: LINE_BLINK_Y 130, the P.inv guard on the line, the refall threshold
// (H + 16). Boundaries are tested one half-unit either side so a +-1 change to the constant is seen. New file only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { H as FIELD_H } from '../games/starfall/defs.js';
import { systems } from '../games/starfall/sim/systems.js';
import { TELE_DIVE } from '../games/starfall/sim/feel.js';
import { TETHER, LINE_FAINT, LINE_BLINKING, LINE_SOLID } from '../games/starfall/sim/enemies/tether.js';
import { H_SHADOW, H_LEAVE, HOUND_RING } from '../games/starfall/sim/enemies/hound.js';

const IDLE = 128;
const tetherSys = systems.find(s => s.id === 'tether');
const step = (sim, n = 1) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(IDLE); sim.clearEvents(); } return sim; };
const toPlay = sim => { while (sim.state !== 'play') step(sim); return sim; };
const mk = (stage, seed = 1, god = true) => { const sim = createSim({ seed, mode: 'stage' + stage }); if (god) sim.setGod(true); return sim; };
function formUp(sim) {
  const S = sim.ctx;
  for (const e of sim.enemies) if (!e.dead && e.r >= 0) { S.slot(e.r, e.c); e.x = e.px = S.SX; e.y = e.py = S.SY; e.st = 'form'; e.tele = 0; }
  S.formFull = true;
  return sim;
}

// ---------------- Hound ----------------
function hound13(seed = 1, god = true) {
  const sim = toPlay(mk(13, seed, god)), S = sim.ctx;
  const cull = n => { let k = 0; for (const e of sim.enemies) { if (k >= n) break; if (!e.dead && e.type !== 'cinder') { S.kill(e); k++; } } };
  return { sim, S, H: S.hounds, cull };
}
// Hound A in state 2 (shadow) with the ship still at shipX, dives stopped
function shadowing(shipX = 200, god = true) {
  const { sim, S, H, cull } = hound13(1, god);
  formUp(sim);
  let g = 0; while (!H.triggered && g++ < 6000) { cull(1); S.diveTimer = 1e9; S.player.x = shipX; step(sim); }
  while (H.st[0] !== H_SHADOW && g++ < 9000) { S.diveTimer = 1e9; S.player.x = shipX; step(sim); }
  return { sim, S, H };
}
// one twist step with the sim idling and nothing else in play
function twist(sim) { const S = sim.ctx, t0 = S.twistT; let g = 0; while (S.twistT === t0 && g++ < 50) { S.diveTimer = 1e9; step(sim); } assert.equal(S.twistT, t0 + 1); }

test('HOUND_LIFE: the 600th twist step in state 2 sends the Hound away; the 599th does not', () => {
  const { sim, S, H } = shadowing(200);
  H.life[0] = 597; H.cd[0] = 1e6; H.hp[0] = 3; S.player.inv = 1e6; H.ring.fill(S.player.x);
  twist(sim); assert.equal(H.life[0], 598); assert.equal(H.st[0], H_SHADOW);
  twist(sim); assert.equal(H.life[0], 599); assert.equal(H.st[0], H_SHADOW, 'life 599 still shadows');
  twist(sim); assert.equal(H.life[0], 600); assert.equal(H.st[0], H_LEAVE, 'life 600 leaves');
});

test('HOUND_NEAR: Hound B holds only when it is closer than 16 to A (15.9 holds, 16.1 moves)', () => {
  for (const [bx, holds] of [[115.9, true], [116.1, false]]) {
    const { sim, S, H } = shadowing(200);
    H.st[0] = H.st[1] = H_SHADOW; H.hp[0] = H.hp[1] = 3; H.y[0] = H.y[1] = 190; H.cd[0] = H.cd[1] = 1e6; H.life[0] = H.life[1] = 0;
    H.x[0] = 100; H.x[1] = bx; H.ring.fill(100); // both want x 100; A is already there, so only B can move
    S.player.inv = 1e6;
    twist(sim);
    assert.equal(H.x[0], 100, 'A stays on its target');
    if (holds) assert.equal(H.x[1], bx, 'B holds at ' + bx); else assert.ok(Math.abs(H.x[1] - (bx - 1.2)) < 1e-9, 'B moves 1.2 from ' + bx + ' to ' + H.x[1]);
  }
});

// a player shot at (dx, dyShot) from Hound A's centre; true when the Hound took the hit
function shootHound(dx, dy) {
  const { sim, S, H } = shadowing(200);
  H.x[0] = 200; H.y[0] = 190; H.tx[0] = 200; H.hp[0] = 3; H.cd[0] = 1e6; H.ring.fill(200); S.player.x = 200; S.player.inv = 1e6;
  for (const p of S.ps) p.on = false;
  const p = S.shot(200 + dx, 190 + dy);
  S.diveTimer = 1e9; step(sim);
  return { took: H.hp[0] === 2, used: !p.on };
}
test('HOUND_HIT: a shot hits inside 7 units across (6.5 hits, 7.5 misses)', () => {
  // vertical offset 9.5 below the Hound: the shot has flown into its box by the time the Hound checks (the damage test uses the same one)
  assert.deepEqual(shootHound(6.5, 9.5), { took: true, used: true });
  assert.deepEqual(shootHound(-6.5, 9.5), { took: true, used: true });
  assert.equal(shootHound(7.5, 9.5).took, false);
  assert.equal(shootHound(-7.5, 9.5).took, false);
});
test('HOUND_HIT: and inside 7 units up and down (the shot centre lands 6.5 away hits, 7.5 away misses)', () => {
  // the shot moves before the check; find its post-move y from a real step, then place two shots 6.5 and 7.5 off
  const probe = shadowing(200); const Sp = probe.S, Hp = probe.H;
  Hp.x[0] = 200; Hp.y[0] = 190; Hp.cd[0] = 1e6; Hp.ring.fill(200); Sp.player.x = 200; Sp.player.inv = 1e6; Hp.hp[0] = 3;
  for (const p of Sp.ps) p.on = false;
  const pr = Sp.shot(100, 400); const y0 = pr.y; Sp.diveTimer = 1e9; step(probe.sim); const moved = pr.y - y0; // moved < 0: up the screen
  assert.ok(moved < -1, 'shots fly up: ' + moved);
  const hitAt = off => shootHound(0, off - moved).took;   // off = the shot's distance below the Hound after it has moved
  assert.equal(hitAt(6.5), true); assert.equal(hitAt(-6.5), true);
  assert.equal(hitAt(7.5), false); assert.equal(hitAt(-7.5), false);
});

test('shadow ring: filled with the ship\'s x at stage start (the Hound shadows where the ship stood, not x 0)', () => {
  const sim = mk(13), S = sim.ctx, H = S.hounds;
  assert.equal(H.ring.length, HOUND_RING);
  assert.ok(S.player.x > 100, 'the ship starts mid-field: ' + S.player.x);
  assert.ok(Array.from(H.ring).every(v => v === S.player.x), 'every slot holds the start x');
  // the same after a fresh stage in a running sim
  toPlay(sim);
  S.player.x = 77; sim.ctx.hounds.ring.fill(0); // dirty, then a new stage event refills
  const ev = { type: 'stage' };
  systems.find(s => s.id === 'hound').onEvent(S, ev);
  assert.ok(Array.from(H.ring).every(v => v === 77), 'refilled with the ship x at the new stage');
});

// ---------------- Tetherling ----------------
function pairOf(S, k) { return [S.tethers.mem[2 * k], S.tethers.mem[2 * k + 1]]; }
function launched() {
  const sim = toPlay(mk(6, 1, false)), S = sim.ctx;
  formUp(sim);
  S.diveTimer = 1e9; S.player.inv = 1e6;
  const [a, b] = pairOf(S, 0);
  a.st = 'tele'; a.tele = TELE_DIVE; a.teleSide = a.x < 200 ? -1 : 1; a.teleOff = 0;
  return { sim, S, a, b };
}
function diving() {
  const r = launched(), { sim, S, a, b } = r;
  let g = 0; while (g++ < 400 && !(a.st === 'dive' && b.st === 'dive')) { S.diveTimer = 1e9; step(sim); }
  assert.ok(a.st === 'dive' && b.st === 'dive' && S.tethers.phase[0] === LINE_FAINT, 'a linked dive, line faint');
  return r;
}

test('LINE_BLINK_Y: the line starts blinking at a mean y of 130, not 129.5 (and not 130.5 late)', () => {
  let r = diving();
  r.a.y = r.b.y = 129.5; tetherSys.step(r.S);
  assert.equal(r.S.tethers.phase[0], LINE_FAINT, 'ym 129.5: still faint');
  r.a.y = r.b.y = 130.5; tetherSys.step(r.S);
  assert.equal(r.S.tethers.phase[0], LINE_BLINKING, 'ym 130.5: blinking');
  r = diving();
  r.a.y = r.b.y = 130; tetherSys.step(r.S);
  assert.equal(r.S.tethers.phase[0], LINE_BLINKING, 'ym exactly 130 blinks (>=)');
});

test('P.inv guard: a ship that is invulnerable is not hit by the solid line, one that is not, dies', () => {
  for (const [inv, dies] of [[5, false], [0, true]]) {
    const { sim, S, a, b } = diving();
    S.tethers.phase[0] = LINE_SOLID; S.tethers.phaseT[0] = 5;
    a.y = b.y = 200; a.x = 180; b.x = 220;
    const P = S.player; P.x = 200; P.y = 200; P.inv = inv;
    const d0 = S.deaths;
    tetherSys.step(S);
    assert.equal(S.deaths - d0, dies ? 1 : 0, 'inv ' + inv);
    assert.equal(P.alive, !dies);
  }
});

test('refall threshold: a fallen survivor rejoins only once it is more than 16 below the field (H + 16)', () => {
  const { sim, S } = diving();
  const e = S.tethers.mem[0];
  const tv = 2;
  // just inside: still falling
  e.tfall = 1; e.tv = tv; e.y = FIELD_H + 16 - 0.5 - tv; e.st = 'dive';
  assert.equal(TETHER.move(S, e), true);
  assert.equal(e.tfall, 1, 'at H + 15.5 it keeps falling'); assert.notEqual(e.st, 'join');
  // just past: re-enters from the top
  e.tfall = 1; e.tv = tv; e.y = FIELD_H + 16 + 0.5 - tv; e.st = 'dive';
  assert.equal(TETHER.move(S, e), true);
  assert.equal(e.tfall, 0, 'at H + 16.5 it re-enters'); assert.equal(e.st, 'join'); assert.equal(e.y, -16);
});
