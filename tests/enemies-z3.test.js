// S7 Z3 enemies (design.md B.3, B.5, B.9): the Cinder (ember on death, the 48-unit rule) and the Mirage
// (two copies 30 apart, swap every 40 frames, 12-frame cross-fade, hit state switches at the start of the fade),
// plus the telegraph rule (B.6 / B.9): every bullet-spawning or dive event gets >= 20 frames of visible warning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { enemyTypes } from '../games/starfall/sim/registry.js';
import { systems } from '../games/starfall/sim/systems.js';
import { layers } from '../games/starfall/render/layers.js';
import { cinderSystem, EMBER_SPEED, EMBER_SAFE, EMBER_TELE } from '../games/starfall/sim/enemies/cinder.js';
import { mirageSide, mirageFade, mirageHitX, MIRAGE_GAP, MIRAGE_SWAP, MIRAGE_FADE } from '../games/starfall/sim/enemies/mirage.js';
import { TELE_AIM } from '../games/starfall/sim/feel.js';
import { H_GLOW, H_SECOND, H_SHADOW } from '../games/starfall/sim/enemies/hound.js';
import { packWord } from '../engine/input-word.js';

const IDLE = 128, FIRE = IDLE | (1 << 9);
const step = (sim, n = 1, w = IDLE) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(w); sim.clearEvents(); } return sim; };
const toPlay = sim => { while (sim.state !== 'play') step(sim); return sim; };
// a test field on stage 13: every enemy removed except one parked far off (so the stage does not clear)
function bare(seed = 1) {
  const sim = toPlay(createSim({ seed, mode: 'stage13' })), S = sim.ctx;
  S.clearEnemies();
  const k = S.mkEnemy('moth', -1, -1); k.st = 'wait'; k.delay = 1e9; S.enemies.push(k);
  return { sim, S };
}
function place(S, type, x, y, st = 'dive') {
  const e = S.mkEnemy(type, -1, -1); e.st = st; e.x = e.px = x; e.y = e.py = y; e.noReturn = true;
  if (st === 'dive') { e.path = { L: [0, 1e9], K: [0], len: 1e9, m: 2, p: [x, y, x, y] }; e.spd = 0; e.shots = 0; }
  S.enemies.push(e); return e;
}
const bullets = sim => sim.eb.filter(b => b.on);

// ---------- registration ----------
test('Cinder and Mirage are registered with B.3 stats, plus the ember system and the Z3 layer', () => {
  const C = enemyTypes.cinder, M = enemyTypes.mirage;
  assert.deepEqual([C.hp, C.form, C.dive], [1, 120, 260]);
  assert.deepEqual([M.hp, M.form, M.dive], [1, 200, 500]);
  assert.equal(M.hitX, mirageHitX);
  for (const T of [C, M]) { const w = T.art.A[0].length; for (const row of [...T.art.A, ...T.art.B]) assert.equal(row.length, w); }
  assert.ok(systems.includes(cinderSystem));
  assert.ok(layers.some(l => l.id === 'enemies-z3'));
  assert.equal(typeof M.draw === 'function', true, 'the Z3 layer module attaches the Mirage draw (render side)');
});

test('stage 13 formation holds 6 Cinders and 6 Mirages (section C verify, Node side)', () => {
  const sim = createSim({ seed: 3, mode: 'stage13' });
  for (let i = 0; i < 4000 && !sim.formFull; i++) step(sim);
  assert.ok(sim.formFull);
  const n = t => sim.enemies.filter(e => e.type === t).length;
  assert.equal(n('cinder'), 6); assert.equal(n('mirage'), 6);
});

// ---------- Cinder ----------
test('Cinder killed far from the player: the ember glows 20 frames, then drops straight down at 1.4', () => {
  const { sim, S } = bare();
  const e = place(S, 'cinder', 200, 80);
  assert.ok(Math.hypot(e.x - S.player.x, e.y - S.player.y) >= EMBER_SAFE);
  S.kill(e);
  assert.equal(bullets(sim).length, 0, 'no bullet on the kill frame');
  let warned = 0;
  while (!bullets(sim).length && warned < 100) { step(sim); if (S.embers.on.some(v => v)) warned++; }
  assert.equal(EMBER_TELE, 20);
  assert.ok(warned >= EMBER_TELE, 'warning frames ' + warned);
  const b = bullets(sim)[0];
  assert.equal(EMBER_SPEED, 1.4);
  assert.equal(b.vx, 0); assert.equal(b.vy, 1.4);
  assert.ok(Math.abs(b.x - 200) < 1e-9);
  assert.equal(S.embers.spawned, 1);
});

test('48-unit rule: a Cinder that dies within 48 units of the player drops no ember', () => {
  const { sim, S } = bare();
  const p = S.player, e = place(S, 'cinder', p.x + 20, p.y - 40);
  assert.ok(Math.hypot(e.x - p.x, e.y - p.y) < EMBER_SAFE);
  S.kill(e);
  step(sim, 80);
  assert.equal(bullets(sim).length, 0);
  assert.equal(S.embers.spawned, 0);
  assert.equal(S.embers.snuffed, 1);
  // just outside 48 does drop one
  const f = place(S, 'cinder', p.x, p.y - 49);
  S.kill(f); step(sim, EMBER_TELE + 1);
  assert.equal(S.embers.spawned, 1);
});

test('48-unit rule at spawn: an ember does not spawn if the player came within 48 units during the glow', () => {
  const { sim, S } = bare();
  const p = S.player, e = place(S, 'cinder', p.x, p.y - 60);
  S.kill(e);
  step(sim, 5);
  S.embers.y[S.embers.on.indexOf(1)] = p.y - 30; // the player is now within 48 of the hanging ember
  step(sim, EMBER_TELE + 5);
  assert.equal(bullets(sim).length, 0);
  assert.equal(S.embers.snuffed, 1);
});

test('the ember obeys the bullet cap: it waits for room, then is skipped after 30 frames', () => {
  const { sim, S } = bare();
  for (let i = 0; i < S.D.cap; i++) S.eFire(5 + i, 5, 0, 0, false); // fill the cap with parked bullets
  S.kill(place(S, 'cinder', 300, 60));
  step(sim, EMBER_TELE + 10);
  assert.equal(S.embers.spawned, 0);
  assert.equal(S.embers.on.reduce((a, b) => a + b, 0), 1, 'still waiting');
  step(sim, 30);
  assert.equal(S.embers.on.reduce((a, b) => a + b, 0), 0, 'skipped');
  assert.equal(S.embers.spawned, 0);
});

// ---------- Mirage ----------
test('Mirage: two copies 30 apart, the solid side swaps every 40 frames, the fade lasts 12', () => {
  const { sim, S } = bare();
  const e = place(S, 'mirage', 200, 80, 'form'); e.phase = 0; S.formT = 0; // the clock is formT + phase
  const seen = [];
  for (let i = 0; i < MIRAGE_SWAP * 3; i++) { seen.push([mirageSide(S, e), mirageFade(S, e)]); S.formT++; }
  assert.equal(MIRAGE_GAP, 30); assert.equal(MIRAGE_FADE, 12); assert.equal(MIRAGE_SWAP, 40);
  const swaps = []; for (let i = 1; i < seen.length; i++) if (seen[i][0] !== seen[i - 1][0]) swaps.push(i);
  assert.deepEqual(swaps, [40, 80]);
  const sw = swaps[0];
  // the hit side switches on the first fade frame, and the fade then runs 12 frames
  for (let k = 0; k < MIRAGE_FADE; k++) assert.ok(Math.abs(seen[sw + k][1] - (k + 1) / MIRAGE_FADE) < 1e-12, 'fade frame ' + k);
  assert.equal(seen[sw + MIRAGE_FADE][1], 1);
  assert.equal(seen[sw][0], seen[sw + 1][0], 'the solid side holds through the fade');
  assert.equal(Math.abs(mirageHitX(S, e) - e.x), MIRAGE_GAP / 2);
  void sim;
});

test('Mirage: shots pass through the ghost (counted as fired, not hit) and kill the solid copy', () => {
  const { sim, S } = bare();
  const e = place(S, 'mirage', 200, 80);
  // keep the swap clock away from a boundary for this check
  e.phase = (MIRAGE_SWAP - (S.formT % MIRAGE_SWAP) + 15) % MIRAGE_SWAP;
  const side = mirageSide(S, e);
  const fired = S.shotsFired, hits = S.hits;
  S.shot(e.x - side * MIRAGE_GAP / 2, 100);
  step(sim, 12);
  assert.equal(e.dead, false, 'the ghost has no body');
  assert.equal(S.shotsFired, fired + 1); assert.equal(S.hits, hits);
  assert.equal(mirageSide(S, e), side);
  S.shot(e.x + side * MIRAGE_GAP / 2, 100);
  step(sim, 12);
  assert.equal(e.dead, true); assert.equal(S.hits, hits + 1);
});

test('Mirage: the hit state switches at the start of the fade (the brightening copy is already solid)', () => {
  const { sim, S } = bare();
  const e = place(S, 'mirage', 200, 80);
  e.phase = (MIRAGE_SWAP - (S.formT % MIRAGE_SWAP) + MIRAGE_SWAP - 1) % MIRAGE_SWAP; // the swap lands on the next frame
  const old = mirageSide(S, e);
  // a shot already level with the Mirage, under the copy that is about to brighten, arrives on the swap frame
  const p = S.shot(e.x - old * MIRAGE_GAP / 2, 80 + 6.5);
  step(sim, 1);
  assert.equal(mirageSide(S, e), -old);
  assert.equal(mirageFade(S, e), 1 / MIRAGE_FADE);
  assert.equal(e.dead, true, 'hit on the first fade frame');
  assert.equal(p.on, false);
});

test('Mirage ghost has no body: a dive copy overlapping the ship only as a ghost does not kill it', () => {
  const { sim, S } = bare();
  const p = S.player;
  const e = place(S, 'mirage', 0, p.y);
  e.phase = (MIRAGE_SWAP - (S.formT % MIRAGE_SWAP) + 15) % MIRAGE_SWAP;
  const side = mirageSide(S, e);
  e.x = e.px = p.x + side * MIRAGE_GAP / 2; e.path.p[0] = e.path.p[2] = e.x; // the ghost sits on the ship
  step(sim, 3);
  assert.equal(p.alive, true); assert.equal(e.dead, false);
});

test('48-unit rule at kill time: a Cinder killed within 48 drops no ember even if the player then moves away', () => {
  const { sim, S } = bare();
  const p = S.player, e = place(S, 'cinder', p.x + 10, p.y - 30);
  S.kill(e);
  p.x = p.px = 380; // far from the death point for the whole glow
  step(sim, EMBER_TELE + 10);
  assert.equal(S.embers.spawned, 0);
  assert.equal(bullets(sim).length, 0);
});

test('pending embers are wiped on a stage change and on player death', () => {
  const { sim, S } = bare();
  S.kill(place(S, 'cinder', 300, 60));
  assert.equal(S.embers.on.reduce((a, b) => a + b, 0), 1);
  S.emit('stage');
  assert.equal(S.embers.on.reduce((a, b) => a + b, 0), 0);
  S.kill(place(S, 'cinder', 300, 60));
  assert.equal(S.embers.on.reduce((a, b) => a + b, 0), 1);
  S.playerDie();
  assert.equal(S.embers.on.reduce((a, b) => a + b, 0), 0);
  step(sim, EMBER_TELE + 5);
  assert.equal(S.embers.spawned, 0);
});

// a Mirage parked so its MIDPOINT sits on the target; its solid copy is 15 units to the side (out of the 7-unit body box)
function midpointMirage(S, x, y) {
  const e = place(S, 'mirage', x, y);
  e.phase = (MIRAGE_SWAP - (S.formT % MIRAGE_SWAP) + 15) % MIRAGE_SWAP; // well clear of a swap
  return e;
}
test('Mirage body test uses the solid copy: the ship on the midpoint is not hit', () => {
  const { sim, S } = bare();
  const p = S.player, e = midpointMirage(S, p.x, p.y);
  step(sim, 3);
  assert.equal(p.alive, true); assert.equal(e.dead, false);
  assert.equal(Math.abs(mirageHitX(S, e) - p.x), MIRAGE_GAP / 2);
});
test('Mirage body test uses the solid copy: a wingman on the midpoint is not hit', () => {
  const { sim, S } = bare();
  const p = S.player, w = S.wingPool[0];
  w.side = 1; w.x = w.px = p.x + 17; w.y = w.py = p.y + 2; w.ti = 0; w.T = enemyTypes.moth; w.ang = 0; S.wing.push(w);
  const e = midpointMirage(S, w.x, w.y);
  if (mirageSide(S, e) < 0) e.phase += MIRAGE_SWAP; // solid copy on the far side from the ship
  assert.equal(mirageSide(S, e), 1);
  step(sim, 3);
  assert.equal(S.wing.length, 1, 'wingman kept'); assert.equal(e.dead, false); assert.equal(p.alive, true);
});

// ---------- telegraph audit (B.6 / B.9) and determinism, on a real stage 13 ----------
// a scripted bot (god mode): moves under the nearest enemy and fires. Every frame it checks that
//   - every dive starts from >= 20 frames of dive glow ('tele'),
//   - every new enemy bullet is either a Cinder ember whose glow showed >= 20 frames, or an aimed shot whose
//     aim-lock glow showed >= 20 frames (aimT 20..1 observed, or it was waiting on the bullet cap after that),
//     or a Hound volley bullet whose Hound showed its glow (state 3) >= 20 frames before the volley's first bullet
//     (by design: the second bullet of the volley counts under the same glow).
function runStage13(seed, audit) {
  const sim = createSim({ seed, mode: 'stage13' }), S = sim.ctx;
  sim.setGod(true);
  const T = new Map(), emberSeen = new Map(), wasOn = new Uint8Array(sim.eb.length);
  const out = { dives: 0, embers: 0, aimed: 0, z3dives: 0, problems: [] };
  const hPrev = new Uint8Array(2), hGlow = new Int32Array(2), hVolley = new Int32Array(2);
  for (let f = 0; f < 9000 && sim.stage === 13 && !sim.done; f++) {
    // input: chase the nearest live enemy's x and hold fire
    let tx = S.player.x, bd = 1e9;
    for (const e of sim.enemies) if (!e.dead && e.st !== 'wait') { const d = Math.abs(e.x - S.player.x) + e.y * 0.01; if (d < bd) { bd = d; tx = e.x; } }
    const mv = Math.max(-1, Math.min(1, (tx - S.player.x) / 4));
    const due = audit ? sim.enemies.filter(e => (e.aimT === 1 || e.vWait > 0) && (T.get(e)?.aim ?? 0) >= TELE_AIM).length : 0;
    const ember = new Map();
    if (audit) for (let i = 0; i < 16; i++) if (S.embers.on[i]) ember.set(S.embers.x[i] + ',' + S.embers.y[i], emberSeen.get(i) || 0);
    if (audit) hPrev.set(S.hounds.st);
    const fire = f % 150 < 45; // fire in bursts, so the stage lasts long enough for dives and volleys
    sim.step(packWord(mv, fire, fire && f % 9 === 0, false, false, 0)); sim.clearEvents();
    if (!audit) continue;
    for (const e of sim.enemies) {
      let t = T.get(e); if (!t) T.set(e, t = { st: e.st, tele: 0, aim: 0 });
      if (e.st === 'dive' && t.st !== 'dive') {
        out.dives++; if (e.type === 'cinder' || e.type === 'mirage') out.z3dives++;
        if (t.st !== 'tele' || t.tele < 20) out.problems.push(`frame ${sim.frame}: ${e.type} dived after ${t.tele} glow frames (from ${t.st})`);
      }
      t.tele = e.st === 'tele' ? t.tele + 1 : 0;
      t.aim = e.aimT > 0 ? (e.aimT === TELE_AIM ? 1 : t.aim + 1) : e.vWait > 0 ? t.aim : 0;
      t.st = e.st;
    }
    for (let i = 0; i < 16; i++) emberSeen.set(i, S.embers.on[i] ? (emberSeen.get(i) || 0) + 1 : 0);
    let houndDue = 0;
    for (let i = 0; i < 2; i++) {
      const st = S.hounds.st[i];
      if (hPrev[i] === H_GLOW && st === H_SECOND) { hVolley[i] = hGlow[i]; if (hGlow[i] >= 20) houndDue++; }
      else if (hPrev[i] === H_SECOND && st === H_SHADOW && hVolley[i] >= 20) houndDue++;
      hGlow[i] = st === H_GLOW ? hGlow[i] + 1 : 0;
    }
    let newAimed = 0;
    for (let i = 0; i < sim.eb.length; i++) {
      const b = sim.eb[i];
      if (b.on && !wasOn[i]) {
        const k = b.x + ',' + b.y;
        if (b.vx === 0 && b.vy === EMBER_SPEED && ember.has(k)) {
          out.embers++;
          if (ember.get(k) < EMBER_TELE) out.problems.push(`frame ${sim.frame}: ember after ${ember.get(k)} glow frames`);
        } else newAimed++;
      }
      wasOn[i] = b.on ? 1 : 0;
    }
    out.aimed += newAimed;
    if (newAimed > due + houndDue) out.problems.push(`frame ${sim.frame}: ${newAimed} bullets without a 20-frame aim glow (due ${due}, Hound ${houndDue})`);
  }
  out.hash = sim.stateHash(); out.frame = sim.frame; out.score = sim.score;
  return out;
}

test('telegraphs on stage 13: every dive and every bullet (aimed shots and embers) had >= 20 frames of warning', () => {
  for (const seed of [1, 2]) {
    const r = runStage13(seed, true);
    assert.deepEqual(r.problems.slice(0, 5), [], 'seed ' + seed);
    assert.ok(r.z3dives >= 2, 'Cinders/Mirages dived: ' + r.z3dives);
    assert.ok(r.embers >= 2, 'embers dropped: ' + r.embers);
    assert.ok(r.aimed >= 1, 'aimed shots: ' + r.aimed);
  }
});

test('stage 13 is deterministic: the same seed and inputs give the same hash', () => {
  const a = runStage13(5, false), b = runStage13(5, false);
  assert.equal(a.hash, b.hash); assert.equal(a.frame, b.frame); assert.equal(a.score, b.score);
  assert.ok(a.score > 0);
});
