import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTrack, parsePattern, noteToMidi, midiToFreq, trackDuration, createAudio } from '../engine/audio.js';
import { TRACKS, TRACK_IDS, BPM, beatAt, beatDistance, timeOfBeat } from '../games/starfall/music.js';
import { SFX, SFX_NAMES, KILL_KINDS } from '../games/starfall/sfx.js';

const REQUIRED_TRACKS = ['title', 'z1', 'z2', 'z3', 'boss1', 'boss2', 'boss3', 'bonus', 'endless', 'stageClear', 'bossDefeat', 'gameOver', 'extraLife', 'nameEntry', 'lobby'];
const REQUIRED_SFX = ['shot', 'hit', 'kill', 'bossHit', 'panelBreak', 'bossDie', 'playerDie', 'kindle', 'wingLost', 'powerup', 'powerdown', 'chainTick', 'chainBreak', 'comet', 'extraLife', 'coin', 'clunk', 'menuMove', 'menuSelect', 'lobbyStep', 'grazeTick'];

test('note and pattern parsing', () => {
  assert.equal(noteToMidi('A4'), 69);
  assert.equal(noteToMidi('C4'), 60);
  assert.equal(noteToMidi('Bb3'), 58);
  assert.equal(noteToMidi('F#5'), 78);
  assert.ok(Number.isNaN(noteToMidi('H4')));
  assert.ok(Math.abs(midiToFreq(69) - 440) < 1e-9);
  const p = parsePattern('C4:2 . E4+G4:4^ k:1');
  assert.equal(p.steps, 8);
  assert.equal(p.errors.length, 0);
  assert.deepEqual(p.slots[0].notes, [60]);
  assert.equal(p.slots[1], null);
  assert.equal(p.slots[3].notes.length, 2);
  assert.ok(parsePattern('Z9 foo').errors.length === 2);
});

test('all required tracks exist', () => {
  for (const id of REQUIRED_TRACKS) assert.ok(TRACKS[id], 'missing track ' + id);
});

test('every track validates (ranges, references, bar lengths)', () => {
  for (const id of TRACK_IDS) {
    const errs = validateTrack(TRACKS[id]);
    assert.deepEqual(errs, [], id + ' has errors');
  }
});

test('tempos are whole frames per beat at 60 fps and exposed', () => {
  for (const id of TRACK_IDS) {
    const t = TRACKS[id];
    assert.ok(Number.isInteger(3600 / t.bpm), id + ' bpm ' + t.bpm);
    assert.equal(t.framesPerBeat, 3600 / t.bpm);
    assert.equal(BPM[id], t.bpm);
  }
  assert.equal(TRACKS.z1.bpm, 120);
  assert.equal(TRACKS.z2.bpm, 144);
  assert.equal(TRACKS.z3.bpm, 180);
  assert.equal(TRACKS.bonus.bpm, 144);
});

test('zone and endless tracks loop at least 30 s, bosses at least 30 s', () => {
  for (const id of ['title', 'z1', 'z2', 'z3', 'endless', 'bonus', 'boss1', 'boss2', 'boss3']) {
    assert.ok(trackDuration(TRACKS[id]) >= 30, id + ' is only ' + trackDuration(TRACKS[id]).toFixed(1) + 's');
  }
  for (const id of ['z1', 'z2', 'z3']) assert.ok(trackDuration(TRACKS[id]) >= 45, id + ' should be at least 45s');
});

test('jingles are one-shots, music tracks loop', () => {
  for (const id of ['stageClear', 'bossDefeat', 'gameOver', 'extraLife']) assert.equal(TRACKS[id].loop, false, id);
  for (const id of ['title', 'z1', 'z2', 'z3', 'boss1', 'boss2', 'boss3', 'bonus', 'endless', 'lobby', 'nameEntry']) assert.notEqual(TRACKS[id].loop, false, id);
});

test('intensity layers: zone tracks add drums/arp as intensity rises', () => {
  for (const id of ['z1', 'z2', 'z3', 'endless', 'boss1', 'boss2', 'boss3']) {
    const ch = Object.values(TRACKS[id].channels);
    const levels = new Set(ch.map((c) => c.minI || 0));
    assert.ok(levels.size >= 3, id + ' needs at least 3 distinct layer thresholds');
    assert.ok(ch.some((c) => c.drum && (c.minI || 0) > 0), id + ' drums should be a layer');
    assert.ok(ch.some((c) => (c.minI || 0) === 0 && !c.drum), id + ' needs a base layer at intensity 0');
  }
});

test('tracks are distinct: no two tracks share the same lead material', () => {
  const sig = new Map();
  for (const id of TRACK_IDS) {
    const lead = TRACKS[id].patterns.leadA || TRACKS[id].patterns.lead;
    if (!lead) continue;
    assert.ok(!sig.has(lead), id + ' lead duplicates ' + sig.get(lead));
    sig.set(lead, id);
  }
});

test('different zones differ in key, tempo or meter', () => {
  const k = (id) => TRACKS[id].key + '/' + TRACKS[id].bpm + '/' + TRACKS[id].stepsPerBar;
  assert.equal(new Set(['z1', 'z2', 'z3', 'boss1', 'boss2', 'boss3'].map(k)).size, 6);
});

test('beat helpers', () => {
  assert.equal(beatAt('bonus', 10), 24);
  assert.ok(Math.abs(timeOfBeat('bonus', 24) - 10) < 1e-9);
  assert.ok(beatDistance('bonus', 60 / 144 * 5) < 1e-9);
  assert.ok(Math.abs(beatDistance('bonus', 60 / 144 * 5.5) - 0.5) < 1e-9);
});

test('sfx bank covers the brief and every effect is well formed', () => {
  for (const n of REQUIRED_SFX) assert.equal(typeof SFX[n], 'function', 'missing sfx ' + n);
  assert.deepEqual(KILL_KINDS.slice().sort(), ['moth', 'spark', 'splitter', 'warden', 'wisp']);
  const jobs = [];
  for (const n of SFX_NAMES) {
    if (n === 'kill') KILL_KINDS.forEach((k) => jobs.push([n, { kind: k }]));
    else if (n === 'chainTick') [1, 5, 11].forEach((c) => jobs.push([n, { chain: c }]));
    else jobs.push([n, {}]);
  }
  for (const [n, o] of jobs) {
    const voices = [];
    const h = { o, tone: (s, at) => voices.push({ s, at: at || 0, noise: false }), noise: (s, at) => voices.push({ s, at: at || 0, noise: true }) };
    SFX[n](h, o);
    assert.ok(voices.length > 0, n + ' makes no sound');
    let end = 0;
    for (const v of voices) {
      const s = v.s;
      assert.ok(s.f > 15 && s.f < 20000, n + ' f ' + s.f);
      if (s.f2) assert.ok(s.f2 > 15 && s.f2 < 20000, n + ' f2');
      assert.ok(s.dur > 0 && s.dur < 3, n + ' dur ' + s.dur);
      assert.ok(s.vol > 0 && s.vol <= 0.6, n + ' vol ' + s.vol);
      assert.ok(v.at >= 0 && v.at < 3);
      end = Math.max(end, v.at + s.dur + (s.r || 0.03));
    }
    assert.ok(end < 3, n + ' lasts ' + end.toFixed(2) + 's');
  }
});

test('chainTick pitch rises with chain length', () => {
  const f = (c) => { let x; SFX.chainTick({ tone: (s) => { x = x || s.f; }, noise() {} }, { chain: c }); return x; };
  assert.ok(f(1) < f(4) && f(4) < f(8));
});

test('createAudio exposes the documented API and is inert without a browser', () => {
  const a = createAudio({ tracks: TRACKS, sfx: SFX });
  for (const m of ['unlock', 'setMuted', 'setVolume', 'sfx', 'playMusic', 'stopMusic', 'setIntensity', 'now', 'beatAt']) assert.equal(typeof a[m], 'function', m);
  assert.equal(a.unlock(), false);       // no AudioContext in node
  assert.equal(a.sfx('shot'), false);
  assert.equal(a.now(), 0);
  assert.doesNotThrow(() => { a.setIntensity(2); a.setVolume(0.5, 0.5); a.setMuted(true); a.stopMusic(); });
});
