// S3 scoring (design.md B.4): Ember Chain, graze, Lead kill, Interrupt, Close, stacking, stage clear,
// accuracy cap, flat vs kill points, boss kill, zone no-miss, and the stage-3 worked example.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { packWord } from '../engine/input-word.js';
import {
  scoreSystem, tier, chainBonus, killBase, killPoints, heatFactor, accuracyPct, bossBonusOf,
  CHAIN_WINDOW, CHAIN_WINDOW_LANCE, CP_SCATTER, CP_INTERRUPT, CP_CLOSE
} from '../games/starfall/sim/score.js';

const IDLE = packWord(0, false, false, false, false, 0);
const ctx = (mode = 'stage3', seed = 1) => createSim({ seed, mode }).ctx;
// a stand-in enemy far from the player (the player sits at x 200, y 274)
const foe = (o = {}) => ({ type: 'moth', st: 'form', leader: false, group: -1, x: 200, y: 60, ...o });
const steps = (S, n) => { for (let i = 0; i < n; i++) scoreSystem.step(S); };
const popKinds = S => Array.from(S.cpop.k).filter(k => k);

test('chain tiers: x1 for 1-9, x2 for 10-29, x3 for 30-59, x4 from 60; chainMax tracks the longest', () => {
  assert.deepEqual([0, 9, 10, 29, 30, 59, 60, 200].map(tier), [1, 1, 2, 2, 3, 3, 4, 4]);
  const S = ctx('stage1');
  const got = [];
  for (let n = 1; n <= 70; n++) got.push(S.addKill(100, foe()));
  for (let n = 1; n <= 70; n++) assert.equal(got[n - 1], 100 * tier(n), 'kill ' + n);
  assert.equal(S.chain, 70); assert.equal(S.chainMax, 70);
});

test('chain window: 90 frames after each kill, 45 after a LANCE kill; running out ends the chain', () => {
  const S = ctx();
  S.addKill(100, foe()); assert.equal(S.chainT, CHAIN_WINDOW);
  steps(S, 89); assert.equal(S.chain, 1);
  steps(S, 1); assert.equal(S.chain, 0);
  S.addKill(100, foe()); steps(S, 60); S.addKill(100, foe()); // a kill refreshes the window
  assert.equal(S.chain, 2); assert.equal(S.chainT, 90);
  S.power = 'lance';
  S.addKill(100, foe()); assert.equal(S.chainT, CHAIN_WINDOW_LANCE); assert.equal(S.chainCap, 45);
  steps(S, 44); assert.equal(S.chain, 3);
  steps(S, 1); assert.equal(S.chain, 0);
  assert.equal(S.chainMax, 3);
});

test('hit-stop freezes the chain window', () => {
  const sim = createSim({ seed: 3, mode: 'stage3' }), S = sim.ctx;
  S.addKill(100, foe());
  S.hitstop = 5;
  for (let i = 0; i < 5; i++) { sim.step(IDLE); sim.clearEvents(); }
  assert.equal(S.hitstop, 0); assert.equal(S.chainT, 90);
  sim.step(IDLE); assert.equal(S.chainT, 89);
});

test('chain end bonus: 5 x n x n for n >= 10, n capped at 60, flat (loop factor only)', () => {
  assert.deepEqual([9, 10, 40, 60, 100].map(chainBonus), [0, 500, 8000, 18000, 18000]);
  // window runs out: banked
  const S = ctx(); S.mult = 4; S.heat = 100;
  for (let i = 0; i < 12; i++) S.addKill(100, foe());
  let before = S.score; steps(S, 90);
  assert.equal(S.score - before, 720, 'not scaled by DEEP SKY or heat'); assert.equal(S.chain, 0);
  // loop 1 (stage 16): x1.25
  const L = ctx('stage16');
  for (let i = 0; i < 40; i++) L.addKill(100, foe());
  before = L.score; L.endChain(); assert.equal(L.score - before, 10000);
  // a short chain pays nothing
  const T = ctx(); for (let i = 0; i < 9; i++) T.addKill(100, foe());
  before = T.score; steps(T, 90); assert.equal(T.score, before);
});

test('chain breaks on death and on stage end (stage end banks the bonus)', () => {
  const S = ctx();
  for (let i = 0; i < 15; i++) S.addKill(100, foe());
  let before = S.score; S.emit('death');
  assert.equal(S.chain, 0); assert.equal(S.score - before, 0, 'death forfeits the chain end bonus (Q7)');
  for (let i = 0; i < 12; i++) S.addKill(100, foe());
  S.state = 'clear'; before = S.score; steps(S, 1);
  assert.equal(S.chain, 0); assert.equal(S.score - before, 720);
  for (let i = 0; i < 11; i++) S.addKill(100, foe());
  S.state = 'play'; before = S.score; S.emit('bossTimeout');
  assert.equal(S.chain, 0); assert.equal(S.score - before, 605);
});

test('boss hits refresh the window to 90 without adding count; a destroyed piece adds 1', () => {
  const S = ctx('stage5');
  assert.ok(S.boss.on);
  S.addKill(1000); assert.equal(S.chain, 1, 'piece adds 1'); assert.equal(S.chainT, 90);
  steps(S, 50); assert.equal(S.chainT, 40);
  S.hits++; steps(S, 1); assert.equal(S.chainT, 89); assert.equal(S.chain, 1);
  // off a boss stage, an enemy-less kill (KINDLE bullet clear) neither counts nor refreshes
  const N = ctx(); N.addKill(100, foe()); steps(N, 10); N.addKill(150);
  assert.equal(N.chain, 1); assert.equal(N.chainT, 80);
});

test('graze: on entering 7 units, once per bullet, 20 flat, +12 chain frames up to the last window, +1/8 lantern dot; none on a hit or under HALO', () => {
  const S = ctx(); S.state = 'play';
  const P = S.player;
  // move one bullet (prev -> current like the sim does) and run the score step once
  const move = (b, x, y) => { b.px = b.x; b.py = b.y; b.vx = x - b.x; b.vy = y - b.y; b.x = x; b.y = y; steps(S, 1); };
  const fresh = (x, y) => { const b = S.takeBullet(); b.on = true; b.x = b.px = x; b.y = b.py = y; b.vx = 0; b.vy = 2; return b; };
  const pass = (dx, from = -20, to = 20, v = 2) => {
    const b = fresh(P.x + dx, P.y + from);
    for (let y = from + v; y <= to; y += v) move(b, P.x + dx, P.y + y);
    b.on = false; return b;
  };
  let score = S.score, meter = S.meter;
  // awarded on the first frame inside the radius
  const e = fresh(P.x + 5, P.y - 10);
  move(e, P.x + 5, P.y - 8); assert.equal(S.grazes, 0, 'outside: 8.6 units');
  move(e, P.x + 5, P.y - 4); assert.equal(S.grazes, 1, 'entered: 6.4 units');
  assert.equal(S.score - score, 20); assert.equal(S.meter - meter, 0.125);
  // the same bullet stays inside, leaves, comes back: no second graze
  move(e, P.x + 5, P.y); move(e, P.x + 5, P.y + 10); move(e, P.x + 5, P.y + 2); e.on = false;
  assert.equal(S.grazes, 1, 'once per bullet');
  pass(0); assert.equal(S.grazes, 1, 'into the hit box: no graze');
  // on course for the hit box when it enters: waits; the player steps aside, so it grazes once it is off course
  const w = fresh(P.x + 1, P.y - 10);
  move(w, P.x + 1, P.y - 6); assert.equal(S.grazes, 1, 'pending while on course');
  P.x += 6; move(w, w.x, P.y - 4); P.x -= 6; w.on = false;
  assert.equal(S.grazes, 2, 'grazed after the sidestep');
  pass(8); assert.equal(S.grazes, 2, 'outside 7 units: no graze');
  // a fast bullet that jumps across the radius between two samples still grazes (segment test)
  const f = fresh(P.x + 5, P.y - 12); move(f, P.x + 5, P.y + 12); f.on = false;
  assert.equal(S.grazes, 3, 'segment test');
  // refuel: +12, never above the window the last kill granted
  S.addKill(100, foe()); steps(S, 50); assert.equal(S.chainT, 40);
  pass(5, -10, -4, 2); // 3 steps; the graze lands on the third
  assert.equal(S.chainT, 40 - 3 + 12);
  S.chainT = 85; pass(5, -10, -2, 4); // 2 steps
  assert.equal(S.chainT, 90, 'never above 90');
  S.power = 'lance'; S.addKill(100, foe()); steps(S, 3); pass(5, -10, -2, 4);
  assert.equal(S.chainT, 45, 'never above the 45 a LANCE kill granted');
  // HALO: no grazing
  S.power = 'halo'; const g = S.grazes; pass(5); assert.equal(S.grazes, g);
  // a graze fills the last eighth of the lantern
  S.power = null; S.meter = 9.875; pass(5); assert.equal(S.meter, 10);
  // no graze while invulnerable or dead
  P.inv = 30; pass(5); P.inv = 0; P.alive = false; pass(5); P.alive = true;
  assert.equal(S.grazes, g + 1);
});

test('boss pieces are explicit: pieceKill adds 1; a KINDLE bullet clear on a boss stage never does', () => {
  const S = ctx('stage5'); assert.ok(S.boss.on);
  S.pieceKill(1000); assert.equal(S.chain, 1); assert.equal(S.chainT, 90);
  steps(S, 30);
  S.addKill(150, null, false); assert.equal(S.chain, 1, 'bullet clear: no count'); assert.equal(S.chainT, 60, 'and no refresh');
  S.addKill(1000); assert.equal(S.chain, 2, 'legacy no-enemy call from the boss still counts');
  // the real KINDLE path in sim.js: no diver near, enemy bullets near the ship are cleared and scored
  const sim = createSim({ seed: 4, mode: 'stage5' }), B = sim.ctx;
  B.state = 'play'; B.meter = 10; B.enemies.length = 0;
  const b = B.takeBullet(); b.on = true; b.x = b.px = B.player.x + 20; b.y = b.py = B.player.y - 20; b.vx = 0; b.vy = 0;
  const before = B.score;
  sim.step(packWord(0, false, false, true, false, 0)); sim.clearEvents();
  assert.ok(B.score > before, 'bullet clear scored'); assert.equal(B.chain, 0, 'bullet clear is not a piece');
});

test('Lead kill: leader on its path x2 with SCATTER; its followers x2 until they reach the formation', () => {
  const S = ctx();
  assert.equal(S.addKill(60, foe({ leader: true, group: 2, st: 'path' })), 120);
  assert.ok(popKinds(S).includes(CP_SCATTER));
  assert.equal(S.addKill(60, foe({ group: 2, st: 'path' })), 120);
  assert.equal(S.addKill(60, foe({ group: 2, st: 'join' })), 120);
  assert.equal(S.addKill(60, foe({ group: 2, st: 'form' })), 60, 'in formation: no x2');
  assert.equal(S.addKill(60, foe({ group: 3, st: 'path' })), 60, 'another group');
  // a leader killed after it reached the formation is no Lead kill
  assert.equal(S.addKill(60, foe({ leader: true, group: 4, st: 'form' })), 60);
  assert.equal(S.addKill(60, foe({ group: 4, st: 'path' })), 60);
  // a new stage clears the scatter flags
  S.emit('stage');
  assert.equal(S.addKill(60, foe({ group: 2, st: 'path' })), 60);
});

test('Interrupt: a Warden killed in its dive telegraph has base 750 (all multipliers apply); Lead never applies', () => {
  const S = ctx(); S.mult = 2;
  assert.equal(S.addKill(200, foe({ type: 'warden', st: 'tele' })), 1500);
  assert.ok(popKinds(S).includes(CP_INTERRUPT));
  assert.equal(S.addKill(200, foe({ type: 'warden', st: 'form' })), 400);
  assert.equal(S.addKill(200, foe({ type: 'warden', st: 'tele', leader: true, group: 1 })), 1500);
  assert.equal(S.addKill(120, foe({ type: 'moth', st: 'tele' })), 240, 'only Wardens interrupt');
});

test('Close: a diving enemy within 32 units of the player is base +50%; stacking rules', () => {
  const S = ctx(), P = S.player;
  assert.equal(S.addKill(120, foe({ st: 'dive', x: P.x + 10, y: P.y - 20 })), 180);
  assert.ok(popKinds(S).includes(CP_CLOSE));
  assert.equal(S.addKill(100, foe({ st: 'spark', x: P.x, y: P.y - 31 })), 150);
  assert.equal(S.addKill(120, foe({ st: 'dive', x: P.x + 30, y: P.y - 20 })), 120, '36 units away');
  assert.equal(S.addKill(120, foe({ st: 'path', x: P.x, y: P.y - 10 })), 120, 'not diving');
  // Interrupt and Close never stack (Interrupt needs the telegraph state, Close a dive)
  assert.equal(S.addKill(200, foe({ type: 'warden', st: 'tele', x: P.x, y: P.y - 10 })), 750);
  // base adjustments (no Lead + Close stack rule)
  assert.equal(killBase(100, true, false, false), 200);
  assert.equal(killBase(100, false, false, true), 150);
  assert.equal(killBase(100, true, true, false), 750, 'Interrupt replaces the base, Lead ignored');
});

test('flat vs kill points: kill points take DEEP SKY, tier, heat and loop; flat bonuses only the loop factor', () => {
  assert.equal(heatFactor(0), 1); assert.equal(heatFactor(4), 1.02); assert.equal(heatFactor(100), 1.5); assert.equal(heatFactor(250), 1.5);
  assert.equal(killPoints(110, 2, 1, 4, 1), 220, 'rounded down to 10');
  assert.equal(killPoints(100, 4, 4, 100, 3), 7200);
  const S = ctx(); S.mult = 3; S.heat = 100;
  for (let i = 0; i < 30; i++) S.addKill(100, foe());
  assert.equal(S.addKill(100, foe()), Math.floor(100 * 3 * 3 * 1.5 / 10) * 10);
  assert.equal(S.addBonus(1000), 1000);
  assert.equal(ctx('stage16').addBonus(1000), 1250);
  assert.equal(ctx('stage31').addBonus(1000), 1500);
});

test('stage clear: 30 x accuracy percent (max 3000), accuracy capped at 100%, only without a death this stage', () => {
  assert.deepEqual([accuracyPct(97, 100), accuracyPct(150, 100), accuracyPct(0, 0), accuracyPct(2, 3)], [97, 100, 0, 66]);
  const clear = (shots, hits, died) => {
    const S = ctx(); S.shotsFired = S.stShots + shots; S.hits = S.stHits + hits; if (died) S.deaths++;
    const before = S.score; S.emit('clear'); return S.score - before;
  };
  assert.equal(clear(100, 97), 2910);
  assert.equal(clear(100, 120), 3000);
  assert.equal(clear(100, 97, true), 0);
  assert.equal(clear(0, 0), 0);
});

test('boss kill: max(5000, 40000 - 8 x fight frames) flat; zone no-miss 20,000 only without a death in the zone, none on timeout', () => {
  assert.equal(bossBonusOf(3000), 16000); assert.equal(bossBonusOf(1800), 25600); assert.equal(bossBonusOf(6000), 5000);
  const S = ctx('stage5'); S.mult = 4;
  S.boss.fight = 3000; assert.equal(S.bossBonus(), 16000);
  let before = S.score; S.emit('bossKill'); assert.equal(S.score - before, 20000);
  const D = ctx('stage5'); D.deaths++; before = D.score; D.emit('bossKill'); assert.equal(D.score, before);
  const T = ctx('stage5'); before = T.score; T.emit('bossTimeout'); assert.equal(T.score, before);
  const L = ctx('stage20'); assert.equal(L.loop, 1); L.boss.fight = 0; assert.equal(L.bossBonus(), 50000);
});

test('B.4 worked example, stage 3: good player 6,800; great player within 1% of 29,310 (per-kill rounding)', () => {
  // good player: x1 DEEP SKY, heat 0, chains that break every few kills, 80% accuracy, no death this stage
  const G = ctx('stage3');
  let start = G.score;
  for (let i = 0; i < 40; i++) { G.addKill(110, foe()); if (i % 4 === 3) steps(G, 90); }
  G.shotsFired = G.stShots + 100; G.hits = G.stHits + 80; G.emit('clear');
  assert.equal(G.score - start, 6800);
  // great player: x2 DEEP SKY, heat 4 (factor 1.02), one 40-kill chain banked at stage end, 97% accuracy
  const S = ctx('stage3'); S.mult = 2; S.heat = 4;
  start = S.score;
  let kills = 0;
  for (let i = 0; i < 40; i++) { kills += S.addKill(110, foe()); steps(S, 30); }
  assert.equal(S.chain, 40);
  S.shotsFired = S.stShots + 100; S.hits = S.stHits + 97; S.emit('clear');
  const total = S.score - start;
  assert.equal(kills, 9 * 220 + 20 * 440 + 11 * 670); // 18,150 (the table's 18,400 rounds once, at the end)
  assert.equal(total, 18150 + 8000 + 2910);
  assert.ok(Math.abs(total - 29310) / 29310 < 0.01, 'total ' + total);
});

test('autoFire-style run on stage 3 in god mode builds a chain and is deterministic', () => {
  const run = () => {
    const sim = createSim({ seed: 2, mode: 'stage3' }); sim.setGod(true);
    for (let i = 0; i < 600; i++) { sim.step(packWord(0, true, i === 0, false, false, 0)); sim.clearEvents(); }
    return { chainMax: sim.ctx.chainMax, score: sim.score, hash: sim.stateHash() };
  };
  const a = run(), b = run();
  assert.deepEqual(a, b);
  assert.ok(a.chainMax >= 10, 'chainMax ' + a.chainMax);
});

test('Q7: death forfeits the chain end bonus; window timeout and stage end pay it', () => {
  const kills = (S, n) => { for (let i = 0; i < n; i++) S.addKill(100, foe()); };
  const D = ctx(); kills(D, 20);
  let before = D.score; D.emit('death');
  assert.equal(D.chain, 0); assert.equal(D.score, before, 'death pays nothing');
  const T = ctx(); kills(T, 20);
  before = T.score; steps(T, CHAIN_WINDOW);
  assert.equal(T.chain, 0); assert.equal(T.score - before, chainBonus(20), 'window timeout pays');
  const C = ctx(); kills(C, 20); C.shotsFired = C.stShots; C.hits = C.stHits;
  before = C.score; C.emit('clear');
  assert.equal(C.chain, 0); assert.equal(C.score - before, chainBonus(20), 'stage end pays (no shots: clear bonus 0)');
  const B = ctx('stage5'); kills(B, 20);
  before = B.score; B.emit('bossTimeout');
  assert.equal(B.score - before, chainBonus(20), 'boss timeout (stage end) pays');
});

test('Q7b: Lead and Close never stack; a lead kill that is also close pays Lead x2 only', () => {
  assert.equal(killBase(100, true, false, true), 200);
  assert.equal(killBase(100, false, true, true), 750);
});
