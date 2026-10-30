// w17 tests-only slice, group 2 (audio-bind half): S13a review survivors N, Q and AI, driven straight through
// createAudioBind on a fake AudioContext (no browser). N: jingle() while muted. Q: the jingle hands back to the wanted
// track when it ends. AI: sfxName (menu / cabinet sounds) is gated by unlocked, muted, paused and hidden, each on its own.
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAudioBind } from '../games/starfall/audio-bind.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function mockCtx() {
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {}, setTargetAtTime() {} });
  const PARAMS = new Set(['gain', 'frequency', 'detune', 'pan', 'delayTime', 'Q', 'threshold', 'knee', 'ratio', 'attack', 'release']);
  const node = () => new Proxy({}, { get(t, k) { if (k in t) return t[k]; if (k === 'connect') return x => x; if (PARAMS.has(k)) return (t[k] = param()); return () => {}; }, set(t, k, v) { t[k] = v; return true; } });
  const st = { currentTime: 0, sampleRate: 44100, state: 'running', destination: node(), calls: [] };
  st.suspend = () => { st.calls.push('suspend'); st.state = 'suspended'; };
  st.resume = () => { st.calls.push('resume'); st.state = 'running'; };
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
// a fresh binding, unlocked; the fake clock steps forward so the engine's 20 ms same-sound guard never eats a call
const made = [];
afterEach(() => { for (const b of made.splice(0)) b.engine.stopMusic({ fadeMs: 0 }); }); // the engine's timers must not outlive a failing test
function fresh(unlock = true) {
  const ctx = mockCtx(), bind = createAudioBind({ ctx });
  made.push(bind);
  if (unlock) assert.equal(bind.unlock(), true);
  const tick = () => { ctx.currentTime += 1; };
  return { ctx, bind, tick };
}

test('N: jingle() while muted starts nothing and leaves no track playing', () => {
  const { bind } = fresh();
  bind.music('z1');
  assert.equal(bind.state().track, 'z1');
  bind.setMuted(true);
  assert.equal(bind.state().track, null, 'mute stops the music');
  assert.equal(bind.jingle('stageClear'), false, 'a muted jingle is refused');
  assert.equal(bind.state().track, null, 'no jingle in the music slot');
  assert.equal(bind.last().jingles, 0, 'not counted as started');
  // and it must not block the wanted track when mute lifts
  bind.setMuted(false);
  assert.equal(bind.state().track, 'z1', 'unmute brings the wanted track back');
  bind.stopMusic();
});

test('N2: jingle() before the first gesture (locked audio) is refused too', () => {
  const { bind } = fresh(false);
  assert.equal(bind.jingle('stageClear'), false);
  assert.equal(bind.last().jingles, 0);
});

test('Q: when a jingle ends, the wanted track starts again (jingle-to-track handoff)', async () => {
  const { ctx, bind } = fresh();
  bind.music('z1');
  assert.equal(bind.jingle('stageClear'), true);
  assert.equal(bind.state().track, 'stageClear', 'the jingle holds the music slot');
  assert.equal(bind.last().jingles, 1);
  ctx.currentTime = 1000;       // the whole jingle is scheduled and past: the engine's end timer fires at once
  await sleep(300);
  assert.equal(bind.state().track, 'z1', 'handed back to the wanted track');
  assert.equal(bind.engine.current().id, 'z1', 'and the engine really plays it');
  bind.stopMusic();
});

test('Q2: a jingle that ends after the wanted track was cleared hands back to silence, not a stale track', async () => {
  const { ctx, bind } = fresh();
  bind.music('z1');
  bind.jingle('stageClear');
  bind.music(null);             // a state-driven change stops the jingle at once
  assert.equal(bind.state().track, null);
  ctx.currentTime = 1000;
  await sleep(300);
  assert.equal(bind.state().track, null);
  assert.equal(bind.engine.current(), null);
  bind.stopMusic();
});

test('AI: sfxName plays only when unlocked, not muted, not paused and the tab is visible; each gate alone is enough to stop it', () => {
  const locked = fresh(false);
  assert.equal(locked.bind.sfxName('menuMove'), false, 'locked');

  const a = fresh();
  assert.equal(a.bind.sfxName('menuMove'), true, 'live');
  a.tick(); assert.equal(a.bind.sfxName('clunk'), true);

  const m = fresh(); m.bind.setMuted(true);
  assert.equal(m.bind.sfxName('menuMove'), false, 'muted');
  m.bind.setMuted(false); m.tick();
  assert.equal(m.bind.sfxName('menuMove'), true, 'unmuted');

  const p = fresh(); p.bind.pause(true);
  assert.equal(p.bind.sfxName('menuMove'), false, 'paused');
  p.bind.pause(false); p.tick();
  assert.equal(p.bind.sfxName('menuMove'), true, 'unpaused');

  const h = fresh(); h.bind.hidden(true);
  assert.equal(h.bind.sfxName('menuMove'), false, 'tab hidden');
  h.bind.hidden(false); h.tick();
  assert.equal(h.bind.sfxName('menuMove'), true, 'tab visible');
});

test('AI2: sim sounds (playSfx) are gated the same way as sfxName', () => {
  const m = fresh(); m.bind.setMuted(true);
  assert.equal(m.bind.playSfx(0, 0), false);
  const p = fresh(); p.bind.pause(true);
  assert.equal(p.bind.playSfx(0, 0), false);
  const h = fresh(); h.bind.hidden(true);
  assert.equal(h.bind.playSfx(0, 0), false);
});
