// C.2 seams (design.md C.2, slice C2-0): structure only. No state hash is compared with a stored value.
// Every check here must stay true after V1 and V2 fill their stubs: stage 1 is the base game in B.11
// (no lever, lead k = 0 in zone 1, no Tetherlings or Hounds), so the stage-1 checks hold for the filled systems too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim, startStageOf } from '../games/starfall/sim.js';
import { STATES, SFX_NAMES, SFX_ID, POP_FADED, POP_CUT, FX_DEFLECT, FX_TETHER, H } from '../games/starfall/defs.js';
import { enemyTypes, TYPE_IDS } from '../games/starfall/sim/registry.js';
import { systems } from '../games/starfall/sim/systems.js';
import { layers } from '../games/starfall/render/layers.js';
import { installHooks } from '../games/starfall/hooks.js';
import { packWord } from '../engine/input-word.js';

const IDLE = 128;
const step = (sim, n = 1, w = IDLE) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(w); sim.clearEvents(); } return sim; };
const toPlay = sim => { while (sim.state !== 'play') step(sim); return sim; };
const C2_SYSTEMS = ['aim', 'twists', 'tether', 'hound'];

test('defs: old states, sound ids, popups and bursts keep their numbers; the C.2 ids are appended', () => {
  assert.deepEqual(STATES.slice(0, 8), ['intro', 'play', 'dying', 'ready', 'clear', 'bonusEnd', 'gameover', 'bossOut']);
  assert.equal(SFX_ID.powerdown, 17);
  for (const n of ['cut', 'hunt', 'snap']) assert.ok(SFX_ID[n] > SFX_ID.powerdown, n + ' comes after the v2 sounds');
  assert.equal(SFX_NAMES.length, new Set(SFX_NAMES).size, 'sound names are unique');
  assert.equal(POP_FADED, 10); assert.equal(POP_CUT, 11);
  assert.equal(FX_DEFLECT, 8); assert.equal(FX_TETHER, 10);
});

test('registries: the C.2 systems run after cinder in order; tether is registered after every older type; layers exist', () => {
  const ids = systems.map(s => s.id);
  const at = C2_SYSTEMS.map(id => ids.indexOf(id));
  assert.ok(at.every(i => i > ids.indexOf('cinder')), 'after score, powerups, cinder: ' + ids.join(','));
  for (let k = 1; k < at.length; k++) assert.ok(at[k] > at[k - 1], 'order aim, twists, tether, hound: ' + ids.join(','));
  for (const id of C2_SYSTEMS) { const s = systems[ids.indexOf(id)]; for (const f of ['init', 'step', 'onEvent']) assert.equal(typeof s[f], 'function', id + '.' + f); }
  const T = enemyTypes.tether;
  assert.ok(T, 'tether registered');
  assert.equal(T.ti, TYPE_IDS.indexOf('tether'));
  for (const old of ['moth', 'wisp', 'warden', 'splitter', 'spark', 'prism', 'eel', 'lamplighter', 'cinder', 'mirage']) assert.ok(enemyTypes[old].ti < T.ti, old);
  assert.equal(T.hp, 1); assert.equal(T.form, 150); assert.equal(T.dive, 350);
  for (const id of ['enemies-c2', 'twists']) {
    const L = layers.find(l => l.id === id);
    assert.ok(L, id + ' layer'); assert.ok(!L.hud, id + ' draws in the playfield'); assert.equal(typeof L.draw, 'function');
  }
  assert.ok(layers.findIndex(l => l.id === 'enemies-c2') > layers.findIndex(l => l.id === 'enemies'));
});

test('a new sim: C.2 state exists with its defaults, and the aim entry points are exposed', () => {
  const sim = createSim({ seed: 3, mode: 'stage1' }), S = sim.ctx;
  assert.equal(S.twistT, 0); assert.equal(S.huntN, 0); assert.equal(S.pincerN, 0);
  assert.ok(S.tethers, 'tether pair state');
  assert.ok(S.hounds && S.hounds.st.every(v => v === 0), 'hounds start off');
  for (const f of ['startAim', 'fireAim', 'lead', 'eFireAimed']) assert.equal(typeof S[f], 'function', f);
  assert.ok(sim.enemies.length > 0);
  for (const e of sim.enemies) { assert.equal(e.hunt, 0); assert.equal(e.pin, 0); assert.equal(e.aimV, 1.2); }
  for (const b of sim.eb) assert.equal(b.th, 0);
  assert.equal(startStageOf('stage6'), 6); assert.equal(startStageOf('arcade'), 1);
});

test('SF.info has twistT, hunt and hounds (0 on a new run)', () => {
  const sim = createSim({ seed: 1, mode: 'stage1' });
  const SF = { info() { return {}; } };
  installHooks(SF, { sim });
  const i = SF.info();
  for (const k of ['twistT', 'hunt', 'hounds']) assert.equal(i[k], 0, k);
});

test('mkEnemy and takeBullet reset the C.2 fields of a reused pool entry', () => {
  const sim = createSim({ seed: 1, mode: 'stage1' }), S = sim.ctx;
  const e = S.mkEnemy('moth', 0, 0); e.hunt = 1; e.pin = 2; e.aimV = 1.6;
  S.enemies.push(e); S.clearEnemies();
  const e2 = S.mkEnemy('wisp', 1, 1);
  assert.equal(e2, e, 'the same pool entry comes back');
  assert.equal(e2.hunt, 0); assert.equal(e2.pin, 0); assert.equal(e2.aimV, 1.2);
  for (const b of sim.eb) b.on = false;
  sim.eb[0].th = 0.6;
  const b = S.takeBullet();
  assert.equal(b, sim.eb[0]); assert.equal(b.th, 0);
});

test('eFireAimed: the sideways limit is 1.2 by default and the caller\'s limit when given', () => {
  const sim = toPlay(createSim({ seed: 1, mode: 'stage1' })), S = sim.ctx;
  for (const b of sim.eb) b.on = false;
  S.eFireAimed(200, 100, 400, 110);
  assert.equal(sim.eb.find(b => b.on).vx, 1.2);
  for (const b of sim.eb) b.on = false;
  S.eFireAimed(200, 100, 400, 110, 1.6);
  assert.equal(sim.eb.find(b => b.on).vx, 1.6);
  for (const b of sim.eb) b.on = false;
  S.eFireAimed(200, 100, 0, 110, 1.6);
  assert.equal(sim.eb.find(b => b.on).vx, -1.6);
});

test('stage 1 (zone 1, no lead): startAim locks on the ship with limit 1.2 and fireAim shoots the v1 shot', () => {
  const sim = toPlay(createSim({ seed: 1, mode: 'stage1' })), S = sim.ctx;
  S.clearEnemies();
  const e = S.mkEnemy('moth', 0, 0); e.st = 'form'; e.x = e.px = 200; e.y = e.py = 150; S.enemies.push(e);
  S.player.x = 150; S.player.vx = 2.0;
  S.startAim(e);
  assert.equal(e.aimX, 150); assert.equal(e.aimY, S.player.y); assert.equal(e.aimV, 1.2);
  for (const b of sim.eb) b.on = false;
  S.fireAim(e);
  const b = sim.eb.find(b => b.on), sp = S.bulletSpd();
  assert.equal(b.vy, sp);
  assert.equal(b.vx, Math.max(-1.2, Math.min(1.2, (150 - 200) / Math.max(20, (H - 26 - 150) / sp))));
});

test('stage 1 plays the same with and without the C.2 systems (3000 scripted frames, seeds 1-3)', () => {
  const word = f => packWord(((f / 45 | 0) % 4) < 2 ? -1 : 1, f % 50 < 40, f % 12 === 0, f % 600 === 599, false, 0);
  const play = seed => {
    const sim = createSim({ seed, mode: 'stage1' });
    for (let f = 0; f < 3000 && !sim.done; f++) { sim.step(word(f)); sim.clearEvents(); }
    const r = sim.rng;
    return JSON.stringify({ score: sim.score, frame: sim.frame, state: sim.state, deaths: sim.deaths, x: sim.player.x, rng: [r.a, r.b, r.c, r.d],
      enemies: sim.enemies.map(e => [e.type, e.st, e.x, e.y, e.hp]), bullets: sim.eb.filter(b => b.on).map(b => [b.x, b.y, b.vx, b.vy]) });
  };
  const removed = [];
  for (const seed of [1, 2, 3]) {
    const withC2 = play(seed);
    try {
      for (const id of C2_SYSTEMS) { const i = systems.findIndex(s => s.id === id); removed.push([i, systems[i]]); systems.splice(i, 1); }
      assert.equal(play(seed), withC2, 'seed ' + seed);
    } finally {
      while (removed.length) { const [i, s] = removed.pop(); systems.splice(i, 0, s); }
    }
  }
  assert.deepEqual(C2_SYSTEMS.map(id => systems.some(s => s.id === id)), [true, true, true, true], 'systems restored');
});
