// cut, hunt and snap must differ from each other and keep their character.
// The surviving mutants were: cut replaced by snap, hunt pitch x10, cut noise lowpassed at 20 Hz, a cue made much louder.
// Reads the synth voice lists in Node (no browser). New file only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SFX } from '../games/starfall/sfx.js';

function voices(name) {
  const list = [];
  SFX[name]({ o: {}, tone: (s, at) => list.push({ kind: 'tone', s, at: at || 0 }), noise: (s, at) => list.push({ kind: 'noise', s, at: at || 0 }) }, {});
  return list;
}
const tones = n => voices(n).filter(v => v.kind === 'tone');
const noises = n => voices(n).filter(v => v.kind === 'noise');
const vol = v => (v.s.vol == null ? 0.2 : v.s.vol);
const falls = v => v.s.f2 !== undefined && v.s.f2 < v.s.f;
const meanF = n => tones(n).reduce((a, v) => a + v.s.f, 0) / tones(n).length;
const sumVol = n => voices(n).reduce((a, v) => a + vol(v), 0);

test('cut, hunt and snap are three different sounds (voice lists, kinds and pitch centres all differ)', () => {
  const names = ['cut', 'hunt', 'snap'];
  const sig = names.map(n => JSON.stringify(voices(n)));
  assert.equal(new Set(sig).size, 3, 'no two cues share a voice list');
  const kinds = names.map(n => voices(n).map(v => v.kind + ':' + (v.s.w || v.s.ft || '')).sort().join(','));
  assert.equal(new Set(kinds).size, 3, 'no two cues share a voice layout: ' + kinds.join(' | '));
  // hunt sits well below the other two
  assert.ok(meanF('hunt') * 3 < meanF('cut') && meanF('hunt') * 3 < meanF('snap'), 'hunt is at least 3x lower in pitch');
  assert.ok(Math.abs(meanF('cut') - meanF('snap')) > 100, 'cut and snap pitch centres differ');
});

test('cut: a falling highpass noise slice with a bright falling saw and a high ring after it', () => {
  const n = noises('cut'), t = tones('cut');
  assert.equal(n.length, 1);
  assert.equal(n[0].s.ft, 'highpass', 'the slice is highpassed');
  assert.ok(n[0].s.f >= 4000 && n[0].s.f <= 9000, 'noise starts bright: ' + n[0].s.f);
  assert.ok(n[0].s.f2 >= 800 && n[0].s.f2 < n[0].s.f, 'noise sweeps down but stays audible: ' + n[0].s.f2);
  const saw = t.find(v => v.s.w === 'saw');
  assert.ok(saw && falls(saw), 'a saw sweeping down');
  assert.ok(saw.s.f >= 1000 && saw.s.f <= 2500 && saw.s.f2 >= 250 && saw.s.f2 <= 800, 'saw band ' + saw.s.f + ' to ' + saw.s.f2);
  assert.ok(saw.s.lp >= 1500 && saw.s.lp <= 6000, 'saw lowpass in the audible band: ' + saw.s.lp);
  const ring = t.find(v => v.s.w === 'sine');
  assert.ok(ring && ring.s.f >= 1500 && ring.s.f <= 2500 && ring.s.f2 === undefined, 'a steady high sine ring');
  assert.ok(ring.at > 0 && ring.at <= 0.06, 'the ring follows the slice');
});

test('hunt: low and calm, no noise, two falling triangle pings (the second higher) over a low sine', () => {
  assert.equal(noises('hunt').length, 0, 'no noise');
  for (const v of tones('hunt')) assert.ok(v.s.f >= 60 && v.s.f <= 400, 'every voice is low: ' + v.s.f);
  const tri = tones('hunt').filter(v => v.s.w === 'tri').sort((a, b) => a.at - b.at);
  assert.equal(tri.length, 2);
  assert.ok(falls(tri[0]) && falls(tri[1]), 'each ping sinks');
  assert.ok(tri[1].s.f > tri[0].s.f, 'the second ping is higher');
  assert.ok(tri[1].at - tri[0].at >= 0.08 && tri[1].at - tri[0].at <= 0.3, 'pings are close together');
  const sine = tones('hunt').find(v => v.s.w === 'sine');
  assert.ok(sine && sine.s.f >= 60 && sine.s.f <= 150, 'a low sine under them');
});

test('snap: a falling noise crack (not highpassed), a falling square twang and a lower falling triangle tail', () => {
  const n = noises('snap'), t = tones('snap');
  assert.equal(n.length, 1);
  assert.notEqual(n[0].s.ft, 'highpass', 'not the cut slice');
  assert.ok(n[0].s.f >= 3000 && n[0].s.f <= 9000 && n[0].s.f2 >= 500 && n[0].s.f2 < n[0].s.f, 'noise ' + n[0].s.f + ' to ' + n[0].s.f2);
  assert.ok(t.length >= 2 && t.every(falls), 'every tone falls');
  const sq = t.find(v => v.s.w === 'square');
  assert.ok(sq && sq.s.f >= 1200 && sq.s.f <= 2600 && sq.s.f2 >= 400, 'square twang ' + (sq && sq.s.f));
  const tri = t.find(v => v.s.w === 'tri');
  assert.ok(tri && tri.s.f >= 500 && tri.s.f <= 1200 && tri.s.f < sq.s.f && tri.at > 0, 'triangle tail below the twang');
});

test('per-voice and per-cue levels stay in a quiet band (no voice louder than 0.15 or quieter than 0.03; cue total 0.12 to 0.3)', () => {
  for (const n of ['cut', 'hunt', 'snap']) {
    for (const v of voices(n)) assert.ok(vol(v) >= 0.03 && vol(v) <= 0.15, `${n} ${v.kind} voice vol ${vol(v)}`);
    assert.ok(sumVol(n) >= 0.12 && sumVol(n) <= 0.3, `${n} total vol ${sumVol(n).toFixed(3)}`);
  }
  // the cue levels keep their order: hunt is the quietest of the three, snap and cut louder
  assert.ok(sumVol('hunt') < sumVol('cut') && sumVol('hunt') < sumVol('snap'), 'hunt is the quietest');
});

test('every filter value is in an audible range: noise sweeps and voice lowpass sit between 500 and 10000 Hz', () => {
  for (const n of ['cut', 'hunt', 'snap']) for (const v of voices(n)) {
    if (v.kind === 'noise') for (const f of [v.s.f, v.s.f2]) if (f !== undefined) assert.ok(f >= 500 && f <= 10000, `${n} noise at ${f} Hz`);
    if (v.s.lp !== undefined) assert.ok(v.s.lp >= 1000 && v.s.lp <= 10000, `${n} lowpass ${v.s.lp}`);
  }
});
