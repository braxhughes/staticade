import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { FEEL, HITSTOP_CAP, TELE_DIVE, TELE_WARDEN, TELE_AIM, VOLLEY_WAIT } from '../games/starfall/sim/feel.js';
import { bosses } from '../games/starfall/sim/registry.js';
import { EV_HITSTOP, EV_STATE, STATES } from '../games/starfall/defs.js';

const IDLE = 128;
const step = (sim, n = 1, w = IDLE) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(w); sim.clearEvents(); } return sim; };
const toPlay = sim => { while (sim.state !== 'play') step(sim); return sim; };

test('feel table matches design.md B.9', () => {
  const want = { kill: [0, 0], close: [1, 1], big: [3, 3], interrupt: [4, 3], piece: [3, 4], phase: [8, 6], bossDeath: [8, 8], wingLost: [2, 3], death: [5, 7] };
  for (const [k, [stop, shake]] of Object.entries(want)) { assert.equal(FEEL[k].stop, stop, k); assert.equal(FEEL[k].shake, shake, k); }
  assert.equal(HITSTOP_CAP, 8); assert.equal(TELE_DIVE, 20); assert.equal(TELE_WARDEN, 30); assert.equal(TELE_AIM, 20); assert.equal(VOLLEY_WAIT, 30);
});

test('hit-stop stacks to at most 8 and freezes gameplay timers while the frame counter runs', () => {
  const sim = toPlay(createSim({ seed: 1, mode: 'stage1' })), S = sim.ctx;
  S.addHitstop(5); S.addHitstop(5);
  assert.equal(sim.hitstop, 8);
  const f0 = sim.frame, st0 = sim.stateT, ft0 = S.formT, x0 = sim.enemies.map(e => e.x + ',' + e.y).join();
  step(sim, 8, IDLE | (1 << 9) | (1 << 10));
  assert.equal(sim.frame, f0 + 8, 'replay frame counter advances');
  assert.equal(sim.stateT, st0); assert.equal(S.formT, ft0); assert.equal(sim.shotsFired, 0, 'input ignored');
  assert.equal(sim.enemies.map(e => e.x + ',' + e.y).join(), x0, 'nothing moved');
  assert.equal(sim.hitstop, 0);
  step(sim); assert.equal(sim.stateT, st0 + 1);
});

test('STARLIGHT has no hit-stop', () => {
  const sim = createSim({ seed: 1, mode: 'stage4' });
  sim.ctx.addHitstop(5);
  assert.equal(sim.hitstop, 0);
});

test('player death applies 5 frames of hit-stop through the feel table', () => {
  const sim = toPlay(createSim({ seed: 2, mode: 'stage1' }));
  let stop = 0;
  sim.ctx.playerDie();
  sim.drain((b, o) => { if (b[o] === EV_HITSTOP) stop += b[o + 1]; });
  assert.equal(stop, 5); assert.equal(sim.hitstop, 5); assert.equal(sim.state, 'dying');
});

test('dive telegraph: 20 frames glowing in formation (Warden 30), then the dive', () => {
  const sim = createSim({ seed: 3, mode: 'stage3' });
  sim.dive(1);
  assert.ok(sim.telegraphs() >= 1);
  step(sim);
  assert.ok(sim.telegraphs() >= 1, 'still telegraphing on the next frame (intro does not run the world)');
  toPlay(sim);
  const e = sim.enemies.find(x => x.st === 'tele');
  assert.ok(e);
  const want = e.type === 'warden' ? TELE_WARDEN : TELE_DIVE;
  assert.equal(e.tele, want);
  step(sim, want - 1); assert.equal(e.st, 'tele');
  step(sim); assert.equal(e.st, 'dive');
});

test('a Warden and its escorts glow for 30 frames; group leader flag is never on a Warden', () => {
  for (let seed = 1; seed < 60; seed++) {
    const sim = createSim({ seed, mode: 'stage1' });
    sim.dive(1);
    const tele = sim.enemies.filter(x => x.st === 'tele');
    if (tele[0].type !== 'warden' && !tele.some(x => x.type === 'warden')) continue;
    for (const x of tele) assert.equal(x.tele, TELE_WARDEN);
    assert.equal(tele.length, 3);
    assert.ok(sim.enemies.filter(x => x.leader).every(x => x.type !== 'warden'));
    return;
  }
  assert.fail('no warden picked in 60 seeds');
});

test('aimed dive shot: 20-frame aim-lock glow, fired at where the player was when it started', () => {
  const sim = toPlay(createSim({ seed: 7, mode: 'stage3' })), S = sim.ctx;
  S.god = true;
  let e = null;
  for (let i = 0; i < 6000 && !e; i++) { step(sim); e = sim.enemies.find(x => x.aimT === TELE_AIM && x.st === 'dive'); }
  assert.ok(e, 'a diver started an aim-lock glow');
  const ax = e.aimX, ay = e.aimY;
  assert.equal(ax, sim.player.x); assert.equal(ay, sim.player.y);
  const mark = new Set(sim.eb.filter(b => b.on));
  step(sim, TELE_AIM - 1, 128 + 127); // hold right: the player moves away from the locked point
  assert.equal(e.aimT, 1);
  const sx = e.x, sy = e.y; // the shot leaves from where the diver is at the start of the firing frame
  step(sim, 1, 128 + 127);
  assert.equal(e.aimT, 0);
  const fresh = sim.eb.filter(b => b.on && !mark.has(b));
  assert.equal(fresh.length, 1, 'exactly one new shot');
  const b = fresh[0], sp = b.vy;
  const wantVx = Math.max(-1.2, Math.min(1.2, (ax - sx) / Math.max(20, (ay - sy - 4) / sp)));
  assert.ok(Math.abs(b.vx - wantVx) < 1e-9, 'aimed at the locked point, not at the moved player');
  assert.ok(Math.abs(sim.player.x - ax) > 20, 'the player had moved away');
});

test('volley-wait rule: a volley over the cap waits up to 30 frames, then is skipped', () => {
  const sim = toPlay(createSim({ seed: 5, mode: 'stage1' })), S = sim.ctx;
  S.god = true;
  // fill the screen to the cap with slow harmless bullets far from the player
  const cap = S.D.cap;
  for (let i = 0; i < cap; i++) S.eFire(5 + i * 3, -5, 0, 0.0001, false);
  assert.equal(sim.liveBullets(), cap);
  assert.equal(S.volleyOk(1), false);
  // force a diver into an aim-lock glow that comes due next frame
  sim.dive(1); step(sim, 40);
  const e = sim.enemies.find(x => x.st === 'dive') || sim.enemies[0];
  e.aimT = 1; e.aimX = 200; e.aimY = 274;
  step(sim);
  assert.equal(e.vWait, VOLLEY_WAIT, 'volley waits');
  assert.equal(sim.liveBullets(), cap, 'nothing spawned');
  step(sim, VOLLEY_WAIT);
  assert.equal(e.vWait, 0, 'skipped after 30 frames');
  assert.equal(sim.liveBullets(), cap);
});

test('bossOut: 60 frames after the boss dies, bullets cleared, no damage, then clear', () => {
  const sim = toPlay(createSim({ seed: 4, mode: 'stage5' })), S = sim.ctx;
  step(sim, 200);
  S.boss.core = 1; for (let k = 0; k < 8; k++) S.boss.ph[k] = 0;
  const states = [];
  // shoot straight at the core until it dies
  for (let i = 0; i < 2000 && sim.state !== 'bossOut'; i++) {
    const p = sim.ps[0]; p.on = true; p.x = p.px = S.boss.x; p.y = p.py = S.boss.y + 10;
    sim.step(IDLE);
    sim.drain((b, o) => { if (b[o] === EV_STATE) states.push(STATES[b[o + 1]]); });
    if (sim.state === 'dying') { S.god = true; }
  }
  assert.equal(sim.state, 'bossOut');
  assert.equal(sim.liveBullets(), 0);
  const score = sim.score, deaths = sim.deaths;
  const frozen = sim.hitstop;
  assert.equal(frozen, 8, 'boss death hit-stop');
  for (let i = 0; i < 59 + frozen; i++) { sim.step(IDLE | (1 << 9)); sim.clearEvents(); assert.equal(sim.state, 'bossOut'); assert.equal(sim.liveBullets(), 0); }
  assert.equal(sim.score, score, 'no score during bossOut'); assert.equal(sim.deaths, deaths);
  step(sim); assert.equal(sim.state, 'clear');
});

test('boss timeout goes through bossOut too, and the timeout counts only non-hit-stop frames', () => {
  const sim = toPlay(createSim({ seed: 9, mode: 'stage5' })), S = sim.ctx;
  S.god = true;
  while (S.boss.entering) step(sim);
  step(sim, 100);
  const fight = S.boss.fight;
  S.addHitstop(8); step(sim, 8);
  assert.equal(S.boss.fight, fight, 'frozen during hit-stop');
  let out = false;
  for (let i = 0; i < 6000 && !out; i++) { step(sim); out = sim.state === 'bossOut'; }
  assert.ok(out); assert.equal(S.boss.on, false);
});

test('Eclipse is registered with the boss interface and its aimed 3-way telegraphs 20 frames', () => {
  const B = bosses.eclipse;
  for (const f of ['setup', 'update', 'shot', 'hp']) assert.equal(typeof B[f], 'function', f);
  const sim = toPlay(createSim({ seed: 6, mode: 'stage5' })), S = sim.ctx;
  S.god = true;
  while (S.boss.entering) step(sim);
  let seen = false;
  for (let i = 0; i < 200 && !seen; i++) { step(sim); seen = S.boss.aimT === TELE_AIM; }
  assert.ok(seen);
  assert.equal(S.boss.t % 50, 5, 'glow starts 20 frames before the v1 volley frame');
});

test('Eclipse respects its 26-bullet cap (B.5 volley-wait rule)', () => {
  const sim = toPlay(createSim({ seed: 8, mode: 'stage5' })), S = sim.ctx;
  S.god = true; sim.breakPanels(5);
  let max = 0;
  for (let i = 0; i < 3000; i++) { step(sim); max = Math.max(max, sim.liveBullets()); }
  assert.equal(S.D.cap, 26);
  assert.ok(max <= 26, 'max bullets ' + max);
});

test('a replay with hit-stop re-simulates exactly', () => {
  const words = new Uint16Array(9000); let s = 3;
  for (let f = 0; f < words.length; f++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; words[f] = (128 + (((f / 40) | 0) % 3 - 1) * 127) | ((s >>> 20) % 3 ? 512 : 0) | (f % 9 === 0 ? 1024 : 0); }
  const a = createSim({ seed: 12, mode: 'stage3' }), b = createSim({ seed: 12, mode: 'stage3' });
  let stops = 0;
  for (let i = 0; i < words.length; i++) { if (a.hitstop) stops++; a.step(words[i]); b.step(words[i]); a.clearEvents(); b.clearEvents(); }
  assert.ok(stops > 0, 'the run had hit-stop frames');
  assert.equal(a.stateHash(), b.stateHash());
});
