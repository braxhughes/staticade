// Follow-up checks for the test-gap files (Node only; the browser one is in
// w17-gaps-fix-browser.test.js). STARLIGHT state resets through the REAL stage change (stage 4 -> stage 9), not a hand
// call to setup. Exact-boundary sides for HOUND_NEAR (< 16), HOUND_HIT (>= 7) and the refall (> H + 16).
// playSfx works on a live binding (positive control for the gate test). The toss blip starts at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { W, H as FIELD_H } from '../games/starfall/defs.js';
import { systems } from '../games/starfall/sim/systems.js';
import { TETHER } from '../games/starfall/sim/enemies/tether.js';
import { H_SHADOW } from '../games/starfall/sim/enemies/hound.js';
import { TELE_DIVE } from '../games/starfall/sim/feel.js';
import { LINE_FAINT } from '../games/starfall/sim/enemies/tether.js';
import { packWord } from '../engine/input-word.js';
import { createAudioBind } from '../games/starfall/audio-bind.js';
import { SFX } from '../games/starfall/sfx.js';

const IDLE = packWord(0, false, false, false, false, 0);
const IDLE2 = 128;

// ---------------- real second STARLIGHT stage ----------------
test('MED1: one kill in STARLIGHT stage 4, then the real stage change into STARLIGHT stage 9 starts with every kill count at zero', () => {
  const sim = createSim({ seed: 1, mode: 'stage4' }), S = sim.ctx, L = S.sl;
  while (sim.state !== 'play') sim.step(IDLE);
  let shot = false, g = 0;
  while (!shot && g++ < 4000) {
    const e = L.ord[0];
    if (e && e.st === 'phrase' && e.x > 12 && e.x < W - 12 && e.y > 12 && e.y < FIELD_H - 30 && S.stageT % 25 === 0) { S.shot(e.x, e.y + 6.5); shot = true; }
    sim.step(IDLE);
  }
  assert.ok(shot, 'a shot was fired');
  while (L.kills[0] < 1 && g++ < 4000) sim.step(IDLE);
  assert.equal(L.kills[0], 1, 'stage 4 counted its kill');
  S.stage = 8; // the clear step does stage++ and runs the real setupStage for stage 9 (also STARLIGHT)
  g = 0;
  while (!(S.stage === 9 && sim.state === 'intro') && g++ < 20000) sim.step(IDLE);
  assert.equal(S.stage, 9); assert.equal(S.stageKind, 'bonus', 'stage 9 is a STARLIGHT stage');
  assert.deepEqual(Array.from(L.kills), [0, 0, 0, 0, 0, 0], 'kills reset by the real setup at the stage change');
  while (sim.state !== 'play' && g++ < 30000) sim.step(IDLE);
  assert.deepEqual(Array.from(L.kills), [0, 0, 0, 0, 0, 0], 'and still zero when stage 9 plays');
  assert.deepEqual(Array.from(L.grade), [0, 0, 0, 0, 0, 0]);
});

// ---------------- boundaries ----------------
const step = (sim, n = 1) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(IDLE2); sim.clearEvents(); } return sim; };
const toPlay = sim => { while (sim.state !== 'play') step(sim); return sim; };
const mk = (stage, seed = 1, god = true) => { const sim = createSim({ seed, mode: 'stage' + stage }); if (god) sim.setGod(true); return sim; };
function formUp(sim) {
  const S = sim.ctx;
  for (const e of sim.enemies) if (!e.dead && e.r >= 0) { S.slot(e.r, e.c); e.x = e.px = S.SX; e.y = e.py = S.SY; e.st = 'form'; e.tele = 0; }
  S.formFull = true;
  return sim;
}
function shadowing(shipX = 200) {
  const sim = toPlay(mk(13, 1, true)), S = sim.ctx, H = S.hounds;
  const cull = n => { let k = 0; for (const e of sim.enemies) { if (k >= n) break; if (!e.dead && e.type !== 'cinder') { S.kill(e); k++; } } };
  formUp(sim);
  let g = 0; while (!H.triggered && g++ < 6000) { cull(1); S.diveTimer = 1e9; S.player.x = shipX; step(sim); }
  while (H.st[0] !== H_SHADOW && g++ < 9000) { S.diveTimer = 1e9; S.player.x = shipX; step(sim); }
  return { sim, S, H };
}
function twist(sim) { const S = sim.ctx, t0 = S.twistT; let g = 0; while (S.twistT === t0 && g++ < 50) { S.diveTimer = 1e9; step(sim); } assert.equal(S.twistT, t0 + 1); }

test('HOUND_NEAR exact: B exactly 16 from A is NOT held (it moves 1.2); the hold is strictly closer than 16', () => {
  const { sim, S, H } = shadowing(200);
  H.st[0] = H.st[1] = H_SHADOW; H.hp[0] = H.hp[1] = 3; H.y[0] = H.y[1] = 190; H.cd[0] = H.cd[1] = 1e6; H.life[0] = H.life[1] = 0;
  H.x[0] = 100; H.x[1] = 116; H.ring.fill(100);
  S.player.inv = 1e6;
  twist(sim);
  assert.equal(H.x[0], 100);
  assert.ok(Math.abs(H.x[1] - (116 - 1.2)) < 1e-9, 'B at distance exactly 16 moves: ' + H.x[1]);
});

function shootHound(dx, dy) {
  const { sim, S, H } = shadowing(200);
  H.x[0] = 200; H.y[0] = 190; H.tx[0] = 200; H.hp[0] = 3; H.cd[0] = 1e6; H.ring.fill(200); S.player.x = 200; S.player.inv = 1e6;
  for (const p of S.ps) p.on = false;
  S.shot(200 + dx, 190 + dy);
  S.diveTimer = 1e9; step(sim);
  return H.hp[0] === 2;
}
test('HOUND_HIT exact: a shot exactly 7 across misses (>= 7), 6.5 across still hits', () => {
  assert.equal(shootHound(6.5, 9.5), true, 'control: 6.5 hits');
  assert.equal(shootHound(7, 9.5), false, 'dx exactly 7 misses');
  assert.equal(shootHound(-7, 9.5), false, 'dx exactly -7 misses');
});

test('refall exact: a fallen survivor at exactly y = H + 16 keeps falling (> not >=)', () => {
  const sim = toPlay(mk(6, 1, false)), S = sim.ctx;
  formUp(sim);
  S.diveTimer = 1e9; S.player.inv = 1e6;
  const [a, b] = [S.tethers.mem[0], S.tethers.mem[1]];
  a.st = 'tele'; a.tele = TELE_DIVE; a.teleSide = a.x < 200 ? -1 : 1; a.teleOff = 0;
  let g = 0; while (g++ < 400 && !(a.st === 'dive' && b.st === 'dive')) { S.diveTimer = 1e9; step(sim); }
  assert.ok(a.st === 'dive' && S.tethers.phase[0] === LINE_FAINT);
  const tv = 2;
  a.tfall = 1; a.tv = tv; a.y = FIELD_H + 16 - tv; a.st = 'dive'; // after the move it sits at exactly H + 16
  assert.equal(TETHER.move(S, a), true);
  assert.equal(a.y, FIELD_H + 16);
  assert.equal(a.tfall, 1, 'exactly H + 16 is not past the edge: still falling');
  assert.notEqual(a.st, 'join');
});

// ---------------- live binding and toss blip ----------------
function mockCtx() {
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {}, setTargetAtTime() {} });
  const PARAMS = new Set(['gain', 'frequency', 'detune', 'pan', 'delayTime', 'Q', 'threshold', 'knee', 'ratio', 'attack', 'release']);
  const node = () => new Proxy({}, { get(t, k) { if (k in t) return t[k]; if (k === 'connect') return x => x; if (PARAMS.has(k)) return (t[k] = param()); return () => {}; }, set(t, k, v) { t[k] = v; return true; } });
  const st = { currentTime: 0, sampleRate: 44100, state: 'running', destination: node(), calls: [] };
  st.suspend = () => { st.state = 'suspended'; }; st.resume = () => { st.state = 'running'; };
  return new Proxy(st, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'createBuffer') return (c, len) => ({ getChannelData: () => new Float32Array(len) });
      if (k === 'createPeriodicWave') return () => ({});
      if (typeof k === 'string' && k.startsWith('create')) return () => node();
      return undefined;
    },
    set(t, k, v) { t[k] = v; return true; }
  });
}
test('AI2 control: playSfx(0, 0) on a live, unmuted, unpaused, visible binding returns true', () => {
  const bind = createAudioBind({ ctx: mockCtx() });
  try {
    assert.equal(bind.unlock(), true);
    assert.equal(bind.playSfx(0, 0), true, 'live binding plays sim sound 0');
  } finally { bind.engine.stopMusic({ fadeMs: 0 }); }
});

test('toss voice starts at offset 0 (the blip is immediate)', () => {
  const list = [];
  SFX.toss({ o: {}, tone: (s, at) => list.push({ s, at: at || 0 }), noise: (s, at) => list.push({ s, at: at || 0 }) }, {});
  assert.equal(list.length, 1);
  assert.equal(list[0].at, 0);
});
