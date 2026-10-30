// Added after a cold review: lifecycle, harmony, loop-body and beat-contract checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudio, parsePattern } from '../engine/audio.js';
import { TRACKS, TRACK_IDS, FRAMES_PER_BAR } from '../games/starfall/music.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- minimal fake AudioContext that records what the engine does ----
function mockCtx() {
  const log = { valueSets: 0, targetSets: 0, nodes: [] };
  const param = () => ({
    _v: 0,
    get value() { return this._v; },
    set value(x) { this._v = x; log.valueSets++; },
    setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {},
    setTargetAtTime() { log.targetSets++; }
  });
  const PARAMS = new Set(['gain', 'frequency', 'detune', 'pan', 'delayTime', 'Q', 'threshold', 'knee', 'ratio', 'attack', 'release']);
  const node = () => {
    const store = { _disc: 0 };
    const n = new Proxy(store, {
      get(t, k) {
        if (k in t) return t[k];
        if (k === 'connect') return (x) => x;
        if (k === 'disconnect') return () => { t._disc++; };
        if (PARAMS.has(k)) return (t[k] = param());
        return () => {};
      },
      set(t, k, v) { t[k] = v; return true; }
    });
    log.nodes.push(store);
    return n;
  };
  const ctx = new Proxy({ currentTime: 0, sampleRate: 44100, state: 'running', destination: node() }, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'createBuffer') return (c, len) => ({ getChannelData: () => new Float32Array(len) });
      if (k === 'createPeriodicWave') return () => ({});
      if (typeof k === 'string' && k.startsWith('create')) return () => node();
      if (k === 'resume') return () => {};
      return undefined;
    },
    set(t, k, v) { t[k] = v; return true; }
  });
  return { ctx, log };
}

const tiny = (id, extra) => Object.assign({
  id, bpm: 240, key: 'C', stepsPerBeat: 4, stepsPerBar: 4, loop: false, tail: 0.4,
  channels: { lead: { wave: 'pulse', duty: 0.5, vol: 0.1 } },
  patterns: { l: 'C5:4' }, song: [{ bars: 1, p: { lead: 'l' } }]
}, extra);
const LOOPER = tiny('looper', { loop: undefined });

test('jingle onEnd fires once when left alone', async () => {
  const { ctx } = mockCtx();
  const a = createAudio({ ctx, tracks: { jt: tiny('jt'), looper: LOOPER } });
  let n = 0;
  a.playMusic('jt', { onEnd: () => n++ });
  ctx.currentTime = 0.3;
  await sleep(900);
  a.stopMusic({ fadeMs: 10 });
  assert.equal(n, 1);
});

test('jingle onEnd does NOT fire after the track was replaced', async () => {
  const { ctx } = mockCtx();
  const a = createAudio({ ctx, tracks: { jt: tiny('jt'), looper: LOOPER } });
  let n = 0;
  a.playMusic('jt', { onEnd: () => n++ });
  ctx.currentTime = 0.3;
  await sleep(120);                  // song fully scheduled, end timer armed
  a.playMusic('looper');
  await sleep(700);
  a.stopMusic({ fadeMs: 10 });
  assert.equal(n, 0, 'onEnd fired for a replaced track');
});

test('jingle onEnd does NOT fire after stopMusic', async () => {
  const { ctx } = mockCtx();
  const a = createAudio({ ctx, tracks: { jt: tiny('jt') } });
  let n = 0;
  a.playMusic('jt', { onEnd: () => n++ });
  ctx.currentTime = 0.3;
  await sleep(120);
  a.stopMusic({ fadeMs: 10 });
  await sleep(700);
  assert.equal(n, 0, 'onEnd fired after stopMusic');
});

test('track end disconnects every per-track node (gains, panners, sends, echo loop)', async () => {
  const { ctx, log } = mockCtx();
  const t = tiny('ech', {
    echo: { beats: 0.75, fb: 0.3, mix: 0.4 }, tail: 0.1,
    channels: { lead: { wave: 'pulse', vol: 0.1, pan: 0.3, send: 0.5 }, bass: { wave: 'tri', vol: 0.1 } },
    patterns: { l: 'C5:4', b: 'C3:4' }, song: [{ bars: 1, p: { lead: 'l', bass: 'b' } }]
  });
  const a = createAudio({ ctx, tracks: { ech: t } });
  a.playMusic('ech');
  ctx.currentTime = 0.3;
  await sleep(700);
  // bus(1) + echo(delay, feedback, lowpass, wet = 4) + lead(gain, panner, send = 3) + bass(gain = 1) = 9
  const disconnected = log.nodes.filter((n) => n._disc > 0).length;
  assert.ok(disconnected >= 9, 'only ' + disconnected + ' nodes disconnected');
  a.stopMusic({ fadeMs: 10 });
});

test('setVolume ramps (no zipper clicks): uses setTargetAtTime, not a direct value write', () => {
  const { ctx, log } = mockCtx();
  const a = createAudio({ ctx, tracks: {} });
  const sets = log.valueSets, targets = log.targetSets;
  a.setVolume(0.3, 0.4);
  assert.equal(log.valueSets, sets, 'setVolume wrote .value directly');
  assert.equal(log.targetSets - targets, 2);
});

// ---- harmony must not clash with the pad ----
test('every harm note is a tone of the pad chord in its bar (no semitone clash, all tracks)', () => {
  let checked = 0;
  for (const id of TRACK_IDS) {
    const t = TRACKS[id];
    t.song.forEach((sec, si) => {
      if (!sec.p.harm || !sec.p.pad) return;
      const H = parsePattern(t.patterns[sec.p.harm]), P = parsePattern(t.patterns[sec.p.pad]);
      for (let bar = 0; bar < sec.bars; bar++) {
        const lo = bar * t.stepsPerBar, hi = lo + t.stepsPerBar;
        const padPcs = new Set();
        for (let s = lo; s < hi; s++) { const e = P.slots[s % P.steps]; if (e) e.notes.forEach((m) => padPcs.add(m % 12)); }
        assert.ok(padPcs.size >= 3, id + ' sec' + si + ' bar' + (bar + 1) + ' has no pad chord');
        for (let s = lo; s < hi; s++) {
          const e = H.slots[s % H.steps];
          if (!e) continue;
          for (const m of e.notes) {
            checked++;
            assert.ok(padPcs.has(m % 12), id + ' sec' + si + ' bar' + (bar + 1) + ': harm pc ' + (m % 12) + ' not in pad ' + [...padPcs]);
            for (const pc of padPcs) { const d = Math.abs(m % 12 - pc); assert.ok(d !== 1 && d !== 11, id + ' semitone clash'); }
          }
        }
      }
    });
  }
  assert.ok(checked > 500, 'checked only ' + checked + ' harmony notes');
});

// ---- loop bodies and beat contract ----
test('loop BODY (excluding intro) is at least 30 s for every zone, boss and endless track', () => {
  for (const id of ['z1', 'z2', 'z3', 'boss1', 'boss2', 'boss3', 'endless']) {
    const t = TRACKS[id], stepDur = 60 / t.bpm / t.stepsPerBeat;
    let secs = 0;
    for (let i = t.loopFrom || 0; i < t.song.length; i++) secs += t.song[i].bars * t.stepsPerBar * stepDur;
    assert.ok(secs >= 30, id + ' loop body is only ' + secs.toFixed(1) + 's');
  }
});

test('framesPerBar is exported only where whole; framesPerBeat is always whole', () => {
  for (const id of TRACK_IDS) {
    const t = TRACKS[id];
    assert.ok(Number.isInteger(t.framesPerBeat));
    const raw = (t.framesPerBeat * t.stepsPerBar) / t.stepsPerBeat;
    assert.equal(t.framesPerBar, Number.isInteger(raw) ? raw : null);
    assert.equal(FRAMES_PER_BAR[id], t.framesPerBar);
  }
  assert.equal(TRACKS.z2.framesPerBar, null);       // 7/8 at 25 f/beat = 87.5
  assert.equal(TRACKS.boss2.framesPerBar, 120);     // 5/4 at 24 f/beat
  assert.equal(TRACKS.z1.framesPerBar, 120);
});
