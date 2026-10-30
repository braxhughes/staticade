// S1 cold-review follow-ups: one-line enemy registration end to end, sim-level checks of the global
// limits and the feel events, the bossOut bullet clear, and golden replay hashes for the v2 sim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { registerEnemy, enemyTypes, TYPE_IDS, bosses } from '../games/starfall/sim/registry.js';
import { enemiesLayer } from '../games/starfall/render/core.js';
import { createFx } from '../games/starfall/fx.js';
import { artFor, spriteOf, PLAYER } from '../games/starfall/sprites.js';
import { EV_EXPLODE, EV_SHAKE, TI_PLAYER } from '../games/starfall/defs.js';

const IDLE = 128;
const step = (sim, n = 1, w = IDLE) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(w); sim.clearEvents(); } return sim; };
const toPlay = sim => { while (sim.state !== 'play') step(sim); return sim; };

// ---------- MED 1: an enemy type is one registry line ----------
const DUMMY_ART = { A: ['.x.', 'xyx', '.x.'], B: ['x.x', '.y.', 'x.x'], pal: { x: [1, 0.2, 0.2], y: [1, 1, 1] } };
registerEnemy('dummybug', { name: 'DUMMY', hp: 1, r: 5, form: 70, dive: 140, art: DUMMY_ART });
registerEnemy('noart', { name: 'NOART', hp: 1, r: 5, form: 10, dive: 20 });
let drawnCalls = 0;
registerEnemy('drawn', { name: 'DRAWN', hp: 1, r: 5, form: 10, dive: 20, draw(R, e) { drawnCalls++; R.dot(e.x, e.y, 1, 1, 1, 1, 1); } });

test('registered enemy types get indices by registration order; the player is a sentinel', () => {
  assert.deepEqual(TYPE_IDS.slice(0, 5), ['moth', 'wisp', 'warden', 'splitter', 'spark']);
  assert.equal(enemyTypes.dummybug.ti, TYPE_IDS.indexOf('dummybug'));
  assert.ok(enemyTypes.dummybug.ti >= 5, 'a new type does not collide with v1 indices');
  assert.ok(TI_PLAYER < 0);
  assert.equal(spriteOf(TI_PLAYER, 0), PLAYER);
  assert.throws(() => registerEnemy('moth', {}), /twice/);
});

test('a registered type works end to end: sim spawn, hit, kill score, explode event, fx, enemy layer', () => {
  const sim = toPlay(createSim({ seed: 1, mode: 'stage1' })), S = sim.ctx;
  const e = S.mkEnemy('dummybug', -1, -1), n = S.mkEnemy('noart', -1, -1), d = S.mkEnemy('drawn', -1, -1);
  assert.equal(e.type, 'dummybug'); assert.equal(e.T.dive, 140); assert.equal(e.ti, enemyTypes.dummybug.ti);
  for (const [k, x] of [[e, 100], [n, 200], [d, 300]]) { k.st = 'dive'; k.x = k.px = x; k.y = k.py = 120; k.noReturn = true; S.enemies.push(k); }
  // render: art type draws its own dots, no-art type falls back to the moth art, draw type draws itself
  let dots = 0; const sprDots = [];
  const R = { ui: { F: 0 }, dot() { dots++; }, drawSpr(spr) { sprDots.push(spr.d.length / 3); } };
  sim.enemies.length = 0; sim.enemies.push(e, n, d);
  enemiesLayer.draw(R, sim, 1, 'play');
  assert.equal(sprDots[0], 5, 'dummy art: 5 dots (both frames)');
  const moth = artFor('moth');
  assert.ok([moth.A.d.length / 3, moth.B.d.length / 3].includes(sprDots[1]), 'no art: moth art');
  assert.equal(drawnCalls, 1); assert.equal(dots, 1);
  // kill: score from the registered stats, and the explode event carries the registered index
  const before = sim.score; sim.clearEvents();
  S.kill(e);
  assert.equal(sim.score - before, 140);
  const fx = createFx(() => {});
  let tis = [];
  sim.drain((b, o) => { if (b[o] === EV_EXPLODE) tis.push(b[o + 1]); fx.handle(b, o); });
  assert.deepEqual(tis, [enemyTypes.dummybug.ti]);
  // no-art and draw-only types explode with the moth art, never crash
  S.kill(n); S.kill(d); S.playerDie();
  tis = [];
  assert.doesNotThrow(() => sim.drain((b, o) => { if (b[o] === EV_EXPLODE) tis.push(b[o + 1]); fx.handle(b, o); }));
  assert.ok(tis.includes(TI_PLAYER));
});

// ---------- MED 2: global limits on the values the sim actually uses ----------
test('loop 20: dive speed, bullet speed and dive gaps stay inside the global limits', () => {
  const sim = toPlay(createSim({ seed: 2, mode: 'stage313' })), S = sim.ctx; // row 13, loop 20
  assert.equal(sim.loop, 20); assert.equal(sim.row, 13);
  S.mult = 4;
  assert.ok(S.D.dive * 1.3 > 3.6 && S.D.bullet > 3.6, 'the table values do exceed the limits here');
  assert.equal(S.diveSpd(), 3.6);
  assert.equal(S.bulletSpd(), 3.6);
  const e = sim.enemies.find(x => x.st === 'wait' || x.st === 'path' || x.st === 'form');
  S.startDive(e, 1, 0); assert.equal(e.spd, 3.6);
  S.eFireAimed(200, 100, 200, 274);
  const b = sim.eb.find(x => x.on); assert.equal(b.vy, 3.6);
  let minFull = 1e9, minLow = 1e9;
  for (let i = 0; i < 400; i++) { minFull = Math.min(minFull, S.diveGap(40)); minLow = Math.min(minLow, S.diveGap(5)); }
  assert.equal(minFull, 30, 'full-formation floor reached and held');
  assert.equal(minLow, 14, '8-or-fewer floor reached and held');
});

test('loop 1 and loop 20 dive gaps are scaled by 0.92^L', () => {
  const a = createSim({ seed: 1, mode: 'stage28' }).ctx, b = createSim({ seed: 1, mode: 'stage313' }).ctx;
  assert.ok(Math.abs(a.D.gapFull - 52 * 0.92) < 1e-9);
  let g = 1; for (let i = 0; i < 20; i++) g *= 0.92;
  assert.ok(Math.abs(b.D.gapLow - 18 * g) < 1e-9);
});

// ---------- MED 2: feel events, as the sim applies them ----------
function findTelegraphingWarden() {
  for (let seed = 1; seed < 200; seed++) {
    const sim = createSim({ seed, mode: 'stage1' });
    sim.dive(1);
    const w = sim.enemies.find(x => x.st === 'tele' && x.type === 'warden');
    if (w) return { sim, w };
  }
  throw new Error('no warden telegraph found');
}
test('Interrupt: killing a Warden during its dive telegraph gives 4 frames of hit-stop', () => {
  const { sim, w } = findTelegraphingWarden();
  sim.ctx.kill(w); assert.equal(sim.hitstop, 4);
});
test('Big: killing a Warden in formation gives 3 frames of hit-stop', () => {
  const sim = createSim({ seed: 1, mode: 'stage1' });
  sim.dive(0); // snaps the formation in; dive(0) still picks one diver
  const w = sim.enemies.find(x => x.type === 'warden' && x.st === 'form');
  sim.ctx.kill(w); assert.equal(sim.hitstop, 3);
});
test('Close: a diving enemy killed within 32 units gives 1 frame; farther away gives none', () => {
  const sim = toPlay(createSim({ seed: 1, mode: 'stage1' })), S = sim.ctx, p = sim.player;
  const near = S.mkEnemy('moth', -1, -1), far = S.mkEnemy('moth', -1, -1);
  near.st = 'dive'; near.x = p.x + 10; near.y = p.y - 20; far.st = 'dive'; far.x = p.x; far.y = p.y - 100;
  S.kill(far); assert.equal(sim.hitstop, 0);
  S.kill(near); assert.equal(sim.hitstop, 1);
});

function eclipseFight(seed) {
  const sim = toPlay(createSim({ seed, mode: 'stage5' })), S = sim.ctx;
  S.god = true;
  while (S.boss.entering) step(sim);
  return { sim, S };
}
test('boss piece destroyed: 3 frames of hit-stop and a 4-unit shake', () => {
  const { sim, S } = eclipseFight(3), boss = S.boss;
  for (let k = 0; k < 8; k++) boss.ph[k] = 3;
  boss.ph[0] = 1; sim.clearEvents();
  const a = boss.rot + Math.PI / 8, p = sim.ps[0];
  p.on = true; p.x = boss.x + Math.cos(a) * 33; p.y = boss.y + Math.sin(a) * 33;
  assert.equal(bosses.eclipse.shot(S, p), true);
  assert.equal(boss.ph[0], 0);
  assert.equal(sim.hitstop, 3);
  let shake = 0; sim.drain((b, o) => { if (b[o] === EV_SHAKE) shake = b[o + 1]; });
  assert.equal(shake, 4);
});
test('boss phase change: 8 frames of hit-stop', () => {
  const { sim, S } = eclipseFight(4);
  for (let k = 0; k < 5; k++) S.boss.ph[k] = 0;
  bosses.eclipse.update(S);
  assert.equal(S.boss.fury, true); assert.equal(sim.hitstop, 8);
});
test('bossOut clears any enemy bullet that appears during it', () => {
  const { sim, S } = eclipseFight(5);
  S.bossDefeated();
  assert.equal(sim.state, 'bossOut');
  S.eFire(200, 100, 0, 0.0001, false);
  assert.equal(sim.liveBullets(), 1);
  step(sim, sim.hitstop + 1);
  assert.equal(sim.state, 'bossOut'); assert.equal(sim.liveBullets(), 0);
});

test('boss death: 8 frames of hit-stop', () => {
  const { sim, S } = eclipseFight(6);
  S.bossDefeated();
  assert.equal(sim.hitstop, 8);
});
test('wingman lost: 2 frames of hit-stop', () => {
  const sim = toPlay(createSim({ seed: 1, mode: 'stage1' })), S = sim.ctx;
  const p = sim.player, w = S.wingPool[0];
  w.ti = 0; w.side = -1; w.x = w.px = p.x - 17; w.y = w.py = p.y + 2; sim.wing.push(w); // already at its station
  S.eFire(w.x, w.y - 1, 0, 0.5, false);
  step(sim);
  assert.equal(sim.wing.length, 0); assert.equal(sim.hitstop, 2);
});

// ---------- LOW 8: cross-process determinism ----------
// Pinned golden hashes were dropped before merge: every later gameplay slice would have to re-record
// them, and builders may not edit tests. Instead the same scripted runs (with hit-stop frames) must
// give identical results in this process and in a fresh Node process, plus replay-proof checks browser vs Node.
function scripted(seed, mode, frames) {
  const sim = createSim({ seed, mode }); let s = seed, stops = 0;
  for (let f = 0; f < frames && !sim.done; f++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    if (sim.hitstop) stops++;
    sim.step((128 + (((f / 40) | 0) % 3 - 1) * 127) | ((s >>> 20) % 3 ? 512 : 0) | (f % 9 === 0 ? 1024 : 0)); sim.clearEvents();
  }
  return { hash: sim.stateHash(), score: sim.score, frame: sim.frame, stops };
}
test('scripted v2 runs with hit-stop match across a fresh Node process', async () => {
  const runs = [[12, 'stage3', 9000], [3, 'stage5', 9000], [7, 'arcade', 20000]];
  const here = runs.map(r => scripted(...r));
  assert.ok(here[0].stops > 0 && here[1].stops > 0, 'runs include hit-stop frames');
  const { spawnSync } = await import('node:child_process');
  const src = scripted.toString() + `\nconst { createSim } = await import(${JSON.stringify(new URL('../games/starfall/sim.js', import.meta.url).href)});\n` +
    `console.log(JSON.stringify(${JSON.stringify(runs)}.map(r => scripted(...r))));`;
  const out = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(JSON.parse(out.stdout), here);
});
