// STACKLIGHT T4 (design F.1, B.11): music in three layers, tempo by level at a bar line, the sound effects from sim events.
// Two kinds of test in one file:
//   * bind tests (1 to 9): audio-bind.js with a FAKE engine (a recording stand-in with a clock the test moves), real sim events.
//     The fake counts every call, so "once per event" and "only at a bar line" are exact, with no wall-clock timing.
//   * page tests (10 to 12): the real stacklight.html in headless Chrome with real keys. Chrome runs a real AudioContext, so
//     SL.audio() shows the real engine's state. Real time passes here (a bar is about 2 s at 112 BPM).
//   1. every track the score can build is valid for the engine; tempo and layer tables; the pad moves one scale step per g
//   2. each B.11 event fires its sound once; blocked moves and blocked turns are silent; FIT, KEY, melt length by fall
//   3. a burst of locks, clears and level ups in one frame: one sound per event
//   4. real sim: a clear that levels up fires clear and levelUp once each
//   5. audio never changes the sim: the state hash is identical with sound on and off over the same replay
//   6. layers by level (4/5, 9/10); tempo changes only at a bar line, on the same bar of the loop, over a whole run of levels
//   7. pause, tab hide, turn-sideways, top out, restart, quit to title: no stuck music, no double music
//   8. the bind path allocates nothing per frame
//   9. nothing sounds before the first gesture; the gesture unlocks once
//   10. the page: SL.audio() layers and tempo at levels 4/5 and 9/10, sound after a real key press
//   11. the page: a real clear changes the tempo at a bar line; pause stops the clock; a top out ends in silence
//   12. the page: console clean, one shot at 1000x750
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { staticServer, WAIT, ROOT } from './w25-helpers.mjs';
import { validateTrack } from '../engine/audio.js';
import { createSim, PH_PLAY, EV_MOVE, EV_TURN, EV_LOCK, EV_MELT, EV_CLEAR, EV_LEVEL, EV_TOPOUT, EVS } from '../games/stacklight/sim.js';
import { BAR } from '../games/stacklight/defs.js';
import { Rng } from '../engine/rng.js';
import { createAudioBind } from '../games/stacklight/audio-bind.js';
import { tempoFor, layersFor, trackFor, stepUp, BARS, PIECE } from '../games/stacklight/music.js';
import { SFX, SFX_LIST } from '../games/stacklight/sfx.js';

const LEAD = 0.06; // MUSIC_START_LEAD_S

// ---------- the fake engine ----------
function fakeEngine() {
  const tracks = {};
  const E = {
    t: 0, cur: null, active: 0, musicCalls: [], sfxCalls: [], stops: 0, intensities: [], unlocks: 0,
    ctx: { state: 'suspended', suspend() { this.state = 'suspended'; }, resume() { this.state = 'running'; } },
    unlock() { E.unlocks++; E.ctx.state = 'running'; return true; },
    setMuted() {}, registerTracks(o) { Object.assign(tracks, o); },
    sfx(name, o) { E.sfxCalls.push({ name, rows: o.rows, fall: o.fall, g: o.g }); return true; },
    playMusic(id) {
      const tr = tracks[id]; if (!tr) throw new Error('unregistered track ' + id);
      E.cur = { id, tr, start: E.t + LEAD }; E.active = 1; E.musicCalls.push({ id, at: E.t, start: E.t + LEAD, bpm: tr.bpm });
      return true;
    },
    stopMusic() { E.cur = null; E.active = 0; E.stops++; },
    setIntensity(x) { E.intensities.push(x); },
    beatAt() { return E.cur ? (E.t - E.cur.start) * E.cur.tr.bpm / 60 : -1; },
    now() { return E.t; },
    names() { return E.sfxCalls.map(c => c.name); },
    count(n) { return E.sfxCalls.filter(c => c.name === n).length; }
  };
  return E;
}
const mkBind = () => { const E = fakeEngine(), b = createAudioBind({ audio: E }); b.unlock(); return { E, b }; };
const stubSim = (level = 1) => ({ level, glow: 0, glowT: 0, done: false });
// an event record the way sim.drain hands it over: [type, frame, a, b, c, d]
function feed(b, ...evs) { const buf = new Int32Array(EVS); for (const e of evs) { buf.fill(0); e.forEach((v, i) => { buf[i] = v; }); b.event(buf, 0); } b.endStep(); }
const MOVE = (moved = 1) => [EV_MOVE, 1, 1, moved];
const TURN = a => [EV_TURN, 1, a, 0];
const LOCK = (type, fit, melted, col = 4) => [EV_LOCK, 1, type, fit, melted, col];
const MELT = (col, from, to) => [EV_MELT, 1, col, from, to, 0];
const CLEAR = (rows, g = 0) => [EV_CLEAR, 1, rows, 1 << 0, 100, g];
const LEVELUP = n => [EV_LEVEL, 1, n, 0, 0, 0];
const TOP = () => [EV_TOPOUT, 1, 0, 0, 0, 0];
// run the fake clock and the bind for `sec` seconds at 60 Hz; returns nothing
function run(E, b, sim, sec, app = 'play', paused = false) {
  const n = Math.round(sec * 60);
  for (let i = 0; i < n; i++) { E.t += 1 / 60; b.sync(app, paused, sim); }
}

// ================= 1. the score =================
test('1. all 200 tracks (5 tempos x 8 start bars x 5 GLOW steps) are valid; tempo and layer tables; the pad moves one scale step per g', () => {
  for (const bpm of [112, 120, 128, 136, 144]) for (let s = 0; s < BARS; s++) for (let g = 0; g < 5; g++) {
    const t = trackFor(bpm, s, g);
    assert.deepEqual(validateTrack(t), [], t.id);
    assert.equal(t.bpm, bpm); assert.equal(t.song.length, BARS); assert.equal(t.song[0].p.pad, 'pad' + s, 'starts on bar ' + s);
  }
  const wantT = l => (l <= 4 ? 112 : l <= 8 ? 120 : l <= 12 ? 128 : l <= 16 ? 136 : 144);
  for (let l = 1; l <= 20; l++) {
    assert.equal(tempoFor(l), wantT(l), 'tempo at level ' + l);
    assert.equal(layersFor(l), l <= 4 ? 1 : l <= 9 ? 2 : 3, 'layers at level ' + l);
  }
  assert.equal(tempoFor(99), 144, 'capped at 144');
  const g0 = trackFor(112, 0, 0), g1 = trackFor(112, 0, 1), g4 = trackFor(112, 0, 4);
  assert.equal(g0.patterns.pad0, 'D3+F3+A3:16');
  assert.equal(g1.patterns.pad0, 'E3+G3+A#3:16', 'Dm up one D minor step = Em-ish (E G Bb)');
  assert.equal(g4.patterns.pad0, 'A3+C4+E4:16', 'up four steps');
  for (let b = 0; b < BARS; b++) { assert.equal(g1.patterns['bass' + b], g0.patterns['bass' + b]); assert.equal(g1.patterns['arp' + b], g0.patterns['arp' + b]); }
  assert.equal(stepUp(50, 0), 50); assert.equal(stepUp(57, 1), 58); assert.equal(stepUp(58, 1), 60);
  // layers are gated by the channels' minI: pad and bass always, arp from 0.5, drums at 1
  assert.deepEqual(['pad', 'bass', 'arp', 'drums'].map(c => g0.channels[c].minI || 0), [0, 0, 0.5, 1]);
  // every sound in the bank can be called by the bind
  for (const n of SFX_LIST) assert.equal(typeof SFX[n], 'function', n);
});

// ================= 2. B.11 events =================
test('2. each B.11 event fires its sound once; blocked move and blocked turn are silent', () => {
  const { E, b } = mkBind();
  feed(b, MOVE(1)); assert.deepEqual(E.names(), ['move']);
  feed(b, MOVE(0)); assert.equal(E.sfxCalls.length, 1, 'a blocked move is silent');
  feed(b, TURN(1)); feed(b, TURN(2)); feed(b, TURN(0));
  assert.deepEqual(E.names(), ['move', 'turnBar', 'turnPlus'], 'BAR chime, PLUS shimmer, blocked turn silent');
  E.sfxCalls.length = 0;
  feed(b, LOCK(1, 1, 0)); assert.deepEqual(E.names(), ['lockFit'], 'FLAT fit: bright bell');
  E.sfxCalls.length = 0;
  feed(b, LOCK(2, 2, 0)); assert.deepEqual(E.names(), ['lockKey'], 'KEY: the bell with a fifth above');
  E.sfxCalls.length = 0;
  feed(b, LOCK(1, 0, 0)); assert.deepEqual(E.names(), ['lockSoft'], 'no melt and no fit: a soft thud');
  E.sfxCalls.length = 0;
  feed(b, LOCK(1, 0, 3), MELT(3, 5, 4), MELT(4, 5, 2), MELT(5, 5, 5));
  assert.deepEqual(E.names(), ['melt']); assert.equal(E.sfxCalls[0].fall, 3, 'melt length follows the largest fall');
  E.sfxCalls.length = 0;
  feed(b, LOCK(1, 0, 1), MELT(3, 9, 1)); assert.equal(E.sfxCalls[0].fall, 8);
  E.sfxCalls.length = 0;
  for (const rows of [1, 2, 3]) feed(b, LOCK(1, 0, 0), CLEAR(rows));
  assert.deepEqual(E.names(), ['lockSoft', 'clear', 'lockSoft', 'clear', 'lockSoft', 'clear']);
  assert.deepEqual(E.sfxCalls.filter(c => c.name === 'clear').map(c => c.rows), [1, 2, 3]);
  E.sfxCalls.length = 0;
  feed(b, LOCK(1, 0, 0), CLEAR(1, 0)); assert.equal(E.count('glowStep'), 0, 'g 0 is no GLOW step');
  for (const g of [1, 2, 3, 4]) feed(b, LOCK(1, 0, 0), CLEAR(1, g));
  assert.deepEqual(E.sfxCalls.filter(c => c.name === 'glowStep').map(c => c.g), [1, 2, 3, 4]);
  E.sfxCalls.length = 0;
  feed(b, LEVELUP(5)); assert.deepEqual(E.names(), ['levelUp']);
  E.sfxCalls.length = 0;
  feed(b, TOP()); assert.deepEqual(E.names(), ['topOut']);
  const st = b.state();
  assert.equal(st.sfx.topOut, 1); assert.equal(st.played.topOut, 1);
});

test('2b. the sounds themselves build voices: melt is longer for a longer fall, KEY has an extra voice, clear grows with rows', () => {
  const dur = (name, o) => { const v = []; SFX[name]({ tone: (s, at) => v.push({ ...s, at: at || 0 }), noise: (s, at) => v.push({ ...s, at: at || 0, noise: 1 }) }, o); return v; };
  assert.ok(dur('melt', { fall: 8 })[0].dur > dur('melt', { fall: 1 })[0].dur + 0.2, 'longer fall, longer glissando');
  assert.ok(dur('melt', { fall: 99 })[0].dur <= 1.1, 'and capped');
  assert.ok(dur('melt', { fall: 3 })[0].f2 < dur('melt', { fall: 3 })[0].f, 'a falling glissando');
  assert.equal(dur('lockKey', {}).length, dur('lockFit', {}).length + 1);
  const n = r => dur('clear', { rows: r }).filter(v => !v.noise).length;
  assert.deepEqual([n(1), n(2), n(3)], [1, 2, 3], 'one tone, a fifth, a triad');
  const ratio = dur('clear', { rows: 2 }); assert.ok(Math.abs(ratio[1].f / ratio[0].f - 1.5) < 0.01, 'the fifth is a 3:2 above');
  assert.ok(dur('topOut', {})[0].f2 < dur('topOut', {})[0].f / 8, 'top out falls a long way');
});

// ================= 3. a burst in one frame =================
test('3. a burst of locks, clears and level ups in one frame: one sound per event', () => {
  const { E, b } = mkBind();
  const buf = new Int32Array(EVS * 40); let n = 0;
  const put = e => { e.forEach((v, i) => { buf[n * EVS + i] = v; }); n++; };
  // three whole lock + clear + level groups in one drained batch (a catch-up frame), then a move
  for (let k = 0; k < 3; k++) { put(LOCK(1, 0, 0)); put(CLEAR(2, 1)); put(LEVELUP(2 + k)); }
  put(MOVE(1));
  for (let i = 0; i < n; i++) b.event(buf, i * EVS);
  b.endStep();
  assert.deepEqual(E.names(), ['lockSoft', 'clear', 'glowStep', 'levelUp', 'lockSoft', 'clear', 'glowStep', 'levelUp', 'lockSoft', 'clear', 'glowStep', 'levelUp', 'move']);
  const st = b.state(); assert.equal(st.sfx.clear, 3); assert.equal(st.sfx.levelUp, 3);
});

// ================= 4. the real sim =================
const mk = (t, seed) => createSim({ seed, mode: 'test', test: t });
function toPlay(sim) { while (sim.ctx.phase !== PH_PLAY && !sim.done) sim.step(0); }
function placeBar(sim, col) { // BAR upright at col, hard drop
  toPlay(sim); const S = sim.ctx;
  if (S.rot !== 1) { sim.step(64); sim.step(0); }
  let g = 0; while (S.px !== col && g++ < 20) { sim.step(S.px > col ? 9 : 18); sim.step(0); }
  sim.step(32); sim.step(0);
}
function barSeed(test) { for (let s = 1; s < 200; s++) { const sim = mk(test, s); toPlay(sim); if (sim.ctx.pType === BAR) return s; } throw new Error('no BAR seed'); }

test('4. real sim: a clear that levels up fires clear and levelUp once each, and one lock sound for the lock', () => {
  const test = { heights: [1, 1, 1, 1, 1, 1, 1, 1, 0], lines: 31 };
  const sim = mk(test, barSeed(test));
  const { E, b } = mkBind();
  b.sync('play', false, sim);
  const evs = []; const tap = (buf, o) => { evs.push(buf[o]); b.event(buf, o); };
  placeBar(sim, 8); sim.drain(tap); b.endStep();
  assert.ok(evs.includes(EV_CLEAR) && evs.includes(EV_LEVEL), 'the setup clears a row and levels up');
  assert.equal(sim.level, 5);
  const st = b.state();
  assert.equal(st.sfx.clear, 1); assert.equal(st.sfx.levelUp, 1); assert.equal(st.sfx.glowStep, 0);
  assert.equal(st.sfx.lockFit + st.sfx.lockKey + st.sfx.lockSoft + st.sfx.melt, 1, 'one lock, one lock sound');
  assert.equal(E.sfxCalls.length, st.sfx.clear + st.sfx.levelUp + st.sfx.lockFit + st.sfx.lockKey + st.sfx.lockSoft + st.sfx.melt + st.sfx.move + st.sfx.turnBar + st.sfx.turnPlus);
});

// ================= 5. audio never changes the sim =================
function replayHashes(withAudio, seed, mode) {
  const sim = createSim({ seed, mode }); let b = null, E = null;
  if (withAudio) { ({ E, b } = mkBind()); b.sync('play', false, sim); }
  const r = new Rng(777), hs = []; let k = 0;
  const tap = withAudio ? (buf, o) => b.event(buf, o) : () => {};
  for (let i = 0; i < 6000 && !sim.done; i++) {
    const x = r.int(400);
    let w = x < 30 ? 9 : x < 60 ? 18 : x < 70 ? 64 : x < 72 ? 32 : x < 110 ? 4 : 0;
    sim.step(w); sim.drain(tap);
    if (withAudio) { b.endStep(); E.t += 1 / 60; b.sync('play', false, sim); }
    if (i % 250 === 0) hs.push(sim.stateHash());
    k = i;
  }
  hs.push(sim.stateHash(), sim.frame, sim.score);
  return { hs, plays: withAudio ? E.sfxCalls.length : 0, k };
}
test('5. the state hash is identical with sound on and off over the same replay (arcade and daily)', () => {
  for (const [seed, mode] of [[11, 'arcade'], [12, 'daily'], [13, 'arcade']]) {
    const off = replayHashes(false, seed, mode), on = replayHashes(true, seed, mode);
    assert.deepEqual(on.hs, off.hs, mode + ' ' + seed);
    assert.ok(on.plays > 50, 'the audio really ran: ' + on.plays + ' sounds');
  }
});
test('5b. the bind sources never write the sim: no assignment to a sim field, no sim import beyond event ids', () => {
  const src = fs.readFileSync(path.join(ROOT, 'games/stacklight/audio-bind.js'), 'utf8').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bsim\s*\.\s*\w+\s*(=[^=]|\+\+|--|\+=|-=)/.test(src), 'no sim.x = ...');
  assert.ok(!/\bsim\s*\.\s*(step|restore|save|clearEvents|drain)\b/.test(src), 'no sim mutators');
  assert.ok(!/Math\.random|Date\.now/.test(src));
  assert.deepEqual([...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/sim\.js'/g)].map(m => m[1].split(',').map(s => s.trim()).filter(s => !/^EV_/.test(s))).flat(), []);
});

// ================= 6. layers and tempo =================
test('6a. layers by level: 1 to 4 pad+bass, 5 to 9 +arp, 10+ +drums (4/5 and 9/10 edges)', () => {
  const { E, b } = mkBind(), sim = stubSim(1);
  E.t = 1; b.sync('play', false, sim);
  const seen = {};
  for (const l of [1, 4, 5, 9, 10, 20]) { sim.level = l; E.t += 0.02; b.sync('play', false, sim); seen[l] = b.state().layers; }
  assert.deepEqual(seen, { 1: 1, 4: 1, 5: 2, 9: 2, 10: 3, 20: 3 });
  assert.deepEqual(E.intensities.filter((x, i, a) => a[i - 1] !== x), [0, 0.5, 1], 'intensity 0, 0.5, 1 as the layers join');
  assert.equal(b.state().track, PIECE);
});

test('6b. tempo changes only at a bar line, on the same bar of the loop, through levels 1 to 20; no change mid-bar', () => {
  const { E, b } = mkBind(), sim = stubSim(1);
  E.t = 5; b.sync('play', false, sim); // starts at level 1: 112 BPM, bar 0
  assert.equal(E.musicCalls.length, 1); assert.equal(E.musicCalls[0].bpm, 112);
  // pick a level step at a random point in each stretch: raise the level and run until the engine has started the next tempo
  let seed = 0; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let prev = E.musicCalls[0], bpmSeen = 112;
  for (let lvl = 2; lvl <= 20; lvl++) {
    run(E, b, sim, 0.3 + rnd() * 5); // a random stretch of play: the level then rises at an arbitrary point in a bar
    sim.level = lvl;
    const target = tempoFor(lvl);
    const callsBefore = E.musicCalls.length, bpmBefore = b.state().bpm;
    run(E, b, sim, 6);
    if (target === bpmSeen) { assert.equal(E.musicCalls.length, callsBefore, 'no change of tempo at level ' + lvl); continue; }
    assert.equal(E.musicCalls.length, callsBefore + 1, 'one hand-over at level ' + lvl);
    const c = E.musicCalls[E.musicCalls.length - 1], old = prev;
    assert.equal(c.bpm, target); assert.equal(bpmBefore, bpmSeen, 'tempo stayed until the bar line');
    const barSec = 240 / old.bpm, bars = (c.start - old.start) / barSec;
    assert.ok(Math.abs(bars - Math.round(bars)) * barSec < 0.031, `level ${lvl}: new track starts ${(Math.abs(bars - Math.round(bars)) * barSec * 1000).toFixed(1)} ms off a bar line`);
    assert.ok(c.start >= old.start + Math.round(bars) * barSec - 1e-9, 'never early');
    // same bar of the loop: the new track starts on the bar after the one that was playing
    const startBar = +/-(\d)-\d$/.exec(c.id)[1], fromBar = (+/-(\d)-\d$/.exec(old.id)[1] + Math.round(bars)) % BARS;
    assert.equal(startBar, fromBar, 'the loop carries on from the same bar');
    prev = c; bpmSeen = target;
  }
  assert.equal(bpmSeen, 144);
  const log = b.state().switchLog; assert.ok(log.length >= 4 && log.every(l => l.lineLateMs >= 0 && l.lineLateMs <= 31), JSON.stringify(log));
});

test('6c. the GLOW pad chord moves at a bar line too, and goes back when GLOW runs out', () => {
  const { E, b } = mkBind(), sim = stubSim(1);
  E.t = 2; b.sync('play', false, sim); run(E, b, sim, 1);
  sim.glow = 2; sim.glowT = 200; // a GLOW step 2 is live
  const n0 = E.musicCalls.length; run(E, b, sim, 3);
  assert.equal(E.musicCalls.length, n0 + 1); assert.equal(E.musicCalls[n0].id.split('-')[3], '2', 'pad two steps up');
  sim.glowT = 0; run(E, b, sim, 3);
  assert.equal(E.musicCalls[E.musicCalls.length - 1].id.split('-')[3], '0', 'back to the home chord');
  for (const c of E.musicCalls.slice(1)) { const prev = E.musicCalls.indexOf(c) - 1; const barSec = 240 / E.musicCalls[prev].bpm, x = (c.start - E.musicCalls[prev].start) / barSec; assert.ok(Math.abs(x - Math.round(x)) * barSec < 0.031); }
});

// ================= 7. pause, hide, sideways, top out, restart, title =================
test('7. pause, tab hide, turn-sideways, top out, restart and quit to title leave no stuck or doubled music', () => {
  const { E, b } = mkBind(); let sim = stubSim(3);
  E.t = 1; run(E, b, sim, 1);
  assert.equal(E.ctx.state, 'running'); assert.equal(E.active, 1);
  // pause (or the turn-sideways screen: the same flag) suspends the clock; resuming runs it again
  b.sync('play', true, sim); assert.equal(E.ctx.state, 'suspended', 'paused: clock stopped');
  feed(b, MOVE(1)); assert.equal(b.state().sfx.move, 1, 'counted as requested'); assert.equal(E.count('move'), 0, 'but the engine got nothing while paused');
  b.sync('play', false, sim); assert.equal(E.ctx.state, 'running');
  assert.equal(E.musicCalls.length, 1, 'resume does not restart the music');
  // tab hide: suspended; shown again it stays suspended until sync says whether the game is paused
  b.hidden(true); assert.equal(E.ctx.state, 'suspended');
  b.hidden(false); assert.equal(E.ctx.state, 'suspended', 'shown again: waits for the next frame');
  b.sync('play', true, sim); assert.equal(E.ctx.state, 'suspended', 'the game is paused (main.js pauses on hide): stays suspended');
  b.sync('play', false, sim); assert.equal(E.ctx.state, 'running');
  assert.equal(E.musicCalls.length, 1);
  // top out: sweep, music fades, then silence
  const stops0 = E.stops; feed(b, TOP()); sim.done = true;
  assert.equal(E.count('topOut'), 1); assert.equal(E.stops, stops0 + 1); assert.equal(E.active, 0);
  b.sync('over', false, sim); run(E, b, sim, 2, 'over');
  assert.equal(E.active, 0, 'silent on game over'); assert.equal(E.musicCalls.length, 1);
  // quit to title: still silent; no music on the title
  run(E, b, sim, 1, 'title'); assert.equal(E.active, 0);
  // restart (new sim): exactly one track, at bar 0, level 1 tempo
  sim = stubSim(1); run(E, b, sim, 0.2);
  assert.equal(E.active, 1); assert.equal(E.musicCalls.length, 2); assert.match(E.musicCalls[1].id, /^afterglow-112-0-0$/);
  // restart again in the middle of a run: the old one is replaced, never layered
  const calls = E.musicCalls.length; sim = stubSim(1); run(E, b, sim, 0.2);
  assert.equal(E.musicCalls.length, calls + 1); assert.equal(E.active, 1);
  assert.ok(E.stops >= 2);
  // quit to title from a paused run: music stops
  b.sync('play', true, sim); b.sync('title', false, sim); assert.equal(E.active, 0);
  // a fresh run afterwards plays again
  sim = stubSim(1); run(E, b, sim, 0.2); assert.equal(E.active, 1);
});

// ================= 8. allocation =================
const ALLOC_CHILD = `
import { PerformanceObserver } from 'node:perf_hooks';
const { createAudioBind } = await import(process.argv[1]);
const E = { t: 0, bpm: 120, start: 0, on: false, ctx: { state: 'running', suspend() {}, resume() {} },
  unlock() { return true; }, setMuted() {}, registerTracks() {}, sfx() { return true; }, playMusic(id) { E.on = true; E.start = E.t + 0.06; E.bpm = (id.charCodeAt(10) - 48) * 100 + (id.charCodeAt(11) - 48) * 10 + (id.charCodeAt(12) - 48); return true; },
  stopMusic() { E.on = false; }, setIntensity() {}, beatAt() { return E.on ? (E.t - E.start) * E.bpm / 60 : -1; }, now() { return E.t; } };
const b = createAudioBind({ audio: E }); b.unlock();
const sim = { level: 1, glow: 0, glowT: 0, done: false };
const buf = new Int32Array(6 * 8);
const set = (i, t, a, bb, c, d) => { const o = i * 6; buf[o] = t; buf[o + 1] = 1; buf[o + 2] = a; buf[o + 3] = bb; buf[o + 4] = c; buf[o + 5] = d; };
set(0, 2, 1, 1, 0, 0); set(1, 3, 1, 0, 0, 0); set(2, 5, 1, 0, 3, 4); set(3, 6, 3, 9, 2, 0); set(4, 8, 2, 1, 100, 2); set(5, 9, 5, 0, 0, 0); set(6, 3, 2, 0, 0, 0); set(7, 5, 2, 2, 0, 0);
function frame(i) {
  E.t += 1 / 60;
  sim.level = 1 + ((i / 600) | 0) % 20; sim.glow = (i / 400) & 3; sim.glowT = (i % 800) < 400 ? 100 : 0; // a tempo or chord hand-over every few seconds
  b.sync('play', false, sim);
  for (let k = 0; k < 8; k++) b.event(buf, k * 6);
  b.endStep();
}
for (let i = 0; i < 20000; i++) frame(i); // warm up: builds and registers every track it will need
for (let i = 0; i < 12000; i++) frame(i);
let scav = 0;
new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.detail.kind === 1) scav++; }).observe({ entryTypes: ['gc'] });
await new Promise(r => setTimeout(r, 50)); scav = 0;
const N = 600000; for (let i = 0; i < N; i++) frame(i % 12000);
await new Promise(r => setTimeout(r, 100));
console.log(JSON.stringify({ scav, N, starts: b.state().starts }));
`;
test('8. the bind path (sync, event, endStep) allocates nothing per frame: no minor GC over 600,000 frames in a 1 MB young space', { timeout: 120000 }, () => {
  const r = spawnSync(process.execPath, ['--no-turbo-escape', '--max-semi-space-size=1', '--input-type=module', '-e', ALLOC_CHILD, path.join(ROOT, 'games/stacklight/audio-bind.js')], { encoding: 'utf8', timeout: 110000 });
  assert.equal(r.status, 0, 'child failed: ' + r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.ok(out.starts > 10, 'the child switched tempo and chord many times: ' + out.starts);
  assert.ok(out.scav <= 1, 'minor GCs while playing: ' + out.scav + ' (zero allocation gives 0)');
});

// ================= 9. autoplay =================
test('9. nothing sounds before the first gesture; the first gesture unlocks once; listeners are removed', () => {
  const E = fakeEngine(); const b = createAudioBind({ audio: E });
  const sim = stubSim(1); E.t = 1;
  b.sync('play', false, sim); feed(b, MOVE(1));
  assert.equal(E.musicCalls.length, 0, 'no music before a gesture'); assert.equal(b.state().played.move, 0);
  assert.equal(b.state().layers, 1, 'but the state still reports the layers');
  const handlers = new Map(), win = { addEventListener(e, f) { handlers.set(e, f); }, removeEventListener(e) { handlers.delete(e); } };
  const doc = { hidden: false, addEventListener(e, f) { handlers.set('doc:' + e, f); } };
  b.listen(win, doc);
  assert.ok(handlers.has('keydown') && handlers.has('pointerdown') && handlers.has('touchend'));
  handlers.get('keydown')(); assert.equal(E.unlocks, 1); assert.equal(handlers.has('keydown'), false, 'listeners removed after the first gesture');
  run(E, b, sim, 0.2); assert.equal(E.musicCalls.length, 1, 'music starts once unlocked');
  feed(b, MOVE(1)); assert.equal(b.state().played.move, 1);
  handlers.get('doc:visibilitychange')(); // visible: harmless
  doc.hidden = true; handlers.get('doc:visibilitychange')(); assert.equal(E.ctx.state, 'suspended');
});

// ================= the page =================
let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

const SHOT_DIR = process.env.W50_SHOT_DIR || null;
async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  const page = await ctx.newPage(), problems = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) problems.push('HTTP ' + r.status() + ' ' + r.url()); });
  await page.goto(web.url + 'stacklight.html');
  await page.waitForFunction(() => window.SL && SL.info().app === 'title' && SL.hud().F > 5, null, WAIT);
  return { ctx, page, problems };
}
const audio = page => page.evaluate(() => SL.audio());
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

test('10. page: SL.audio() before any gesture is silent; after a real key press the music plays; layers and tempo at levels 4/5 and 9/10', { timeout: 90000 }, async () => {
  const { ctx, page, problems } = await open();
  try {
    let a = await audio(page);
    assert.equal(a.unlocked, false); assert.equal(a.playing, false); assert.equal(a.track, null);
    await page.keyboard.press('Enter'); // title: Enter starts a run, and is the first gesture
    await page.waitForFunction(() => SL.info().app === 'play' && SL.audio().playing, null, WAIT);
    a = await audio(page);
    assert.equal(a.unlocked, true); assert.equal(a.track, 'afterglow'); assert.equal(a.bpm, 112); assert.equal(a.layers, 1);
    assert.ok(['running', 'suspended'].includes(a.ctxState));
    await page.waitForFunction(() => SL.audio().ctxState === 'running', null, WAIT);
    // the levels (a test start restarts the run at that many lines): 24 = L4, 32 = L5, 64 = L9, 72 = L10
    const table = [[24, 4, 1, 112], [32, 5, 2, 120], [64, 9, 2, 128], [72, 10, 3, 128], [152, 20, 3, 144]];
    for (const [lines, level, layers, bpm] of table) {
      await page.evaluate(n => SL.setLines(n), lines);
      await page.waitForFunction(([l, b]) => SL.audio().level === l && SL.audio().playing && SL.audio().bpm === b, [level, bpm], WAIT);
      a = await audio(page);
      assert.equal(a.level, level, 'level for ' + lines + ' lines'); assert.equal(a.layers, layers, 'layers at level ' + level); assert.equal(a.bpm, bpm, 'bpm at level ' + level);
    }
    // a real key: a move ticks once per press
    await page.evaluate(() => SL.setLines(0)); await settle(page);
    const m0 = (await audio(page)).sfx.move;
    await page.keyboard.press('ArrowLeft'); await settle(page);
    const a2 = await audio(page); assert.ok(a2.sfx.move >= m0 + 1, 'a left press moved the piece and ticked'); assert.ok(a2.played.move >= 1, 'and the engine played it');
    await page.keyboard.press('ArrowUp'); await settle(page);
    const a3 = await audio(page); assert.ok(a3.sfx.turnBar + a3.sfx.turnPlus >= 1, 'a turn press chimed');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('11. page: a real clear changes the tempo at a bar line; pause stops the clock; a top out ends the music', { timeout: 120000 }, async () => {
  const { ctx, page, problems } = await open();
  try {
    // a BAR as the first piece, a board with one gap: dropping it in column 8 clears a row and lifts the run to level 5
    const heights = [1, 1, 1, 1, 1, 1, 1, 1, 0];
    let seed = 0;
    await page.keyboard.press('Enter');
    for (let s = 1; s < 60 && !seed; s++) {
      const ok = await page.evaluate(([s2, h]) => { SL.start(s2); SL.setHeights(h); SL.setLines(31); const p = SL.info().piece; return !!p && p.type === 'BAR'; }, [s, heights]);
      if (ok) seed = s;
    }
    if (!seed) { // the piece shows only after the spawn delay: step the run until it exists
      for (let s = 1; s < 60 && !seed; s++) {
        await page.evaluate(([s2, h]) => { SL.start(s2); SL.setHeights(h); SL.setLines(31); }, [s, heights]);
        await page.waitForFunction(() => SL.info().piece, null, WAIT);
        if (await page.evaluate(() => SL.info().piece.type === 'BAR')) seed = s;
      }
    }
    assert.ok(seed, 'found a BAR first');
    await page.waitForFunction(() => SL.audio().playing && SL.audio().bpm === 112, null, WAIT);
    const before = await audio(page);
    const r = await page.evaluate(() => SL.place(8, 1)); // upright in column 8: fills row 0, one row clears, 32 lines = level 5
    assert.equal(r.level, 5);
    await page.waitForFunction(() => SL.audio().layers === 2, null, WAIT);
    let a = await audio(page);
    assert.equal(a.targetBpm, 120); assert.ok(a.bpm === 112 || a.bpm === 120, 'the tempo is the old or the new one, nothing between');
    assert.equal(a.sfx.clear - before.sfx.clear, 1); assert.equal(a.sfx.levelUp - before.sfx.levelUp, 1);
    await page.waitForFunction(() => SL.audio().bpm === 120, null, { timeout: 15000 });
    a = await audio(page);
    const sw = a.switchLog[a.switchLog.length - 1];
    assert.equal(sw.from, 112); assert.equal(sw.bpm, 120); assert.ok(sw.lineLateMs >= 0 && sw.lineLateMs <= 40, 'started ' + sw.lineLateMs + ' ms after the bar line');
    // pause: the clock stops, P again: it runs
    await page.keyboard.press('p'); await page.waitForFunction(() => SL.info().paused, null, WAIT); await settle(page);
    assert.equal((await audio(page)).ctxState, 'suspended');
    const starts = (await audio(page)).starts;
    await page.keyboard.press('p'); await page.waitForFunction(() => !SL.info().paused, null, WAIT);
    await page.waitForFunction(() => SL.audio().ctxState === 'running', null, WAIT);
    assert.equal((await audio(page)).starts, starts, 'resume did not restart the music');
    // blur (lost focus) pauses the run and so the clock
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await settle(page);
    assert.equal((await audio(page)).ctxState, 'suspended'); assert.equal((await page.evaluate(() => SL.info().paused)), true);
    await page.keyboard.press('p'); await page.waitForFunction(() => SL.audio().ctxState === 'running', null, WAIT);
    // top out: tall columns, then a drop
    await page.evaluate(() => SL.setHeights([17, 17, 17, 17, 17, 17, 17, 17, 0])); // column 8 stays open: no row can clear
    await page.waitForFunction(() => SL.audio().playing && SL.info().piece, null, WAIT);
    const t0 = (await audio(page)).sfx.topOut;
    await page.evaluate(() => { for (let i = 0; i < 4 && !SL.info().done; i++) SL.place(3, 0); }); // stacked past the ceiling
    await page.waitForFunction(() => SL.info().done, null, WAIT); await settle(page);
    a = await audio(page);
    assert.equal(a.sfx.topOut - t0, 1, 'the top out sweep fired once'); assert.equal(a.playing, false, 'music stopped'); assert.equal(a.track, null);
    await new Promise(r2 => setTimeout(r2, 1500));
    a = await audio(page); assert.equal(a.playing, false, 'and stays silent');
    // restart: one new music, at level 1 tempo, from bar 0
    const s2 = a.starts;
    await page.evaluate(() => SL.start(5)); await page.waitForFunction(() => SL.audio().playing, null, WAIT);
    a = await audio(page); assert.equal(a.starts, s2 + 1); assert.equal(a.variant, 'afterglow-112-0-0');
    // quit to title (Esc to pause, Esc again): silence
    await page.keyboard.press('Escape'); await page.waitForFunction(() => SL.info().paused, null, WAIT);
    await page.keyboard.press('Escape'); await page.waitForFunction(() => SL.info().app === 'title', null, WAIT); await settle(page);
    assert.equal((await audio(page)).playing, false);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('12. page: the shot at 1000x750 with SL.audio() printed, console clean', { timeout: 90000 }, async () => {
  const { ctx, page, problems } = await open();
  try {
    await page.keyboard.press('Enter');
    await page.evaluate(() => SL.setLines(40));
    await page.waitForFunction(() => SL.audio().playing && SL.audio().layers === 2, null, WAIT);
    for (let i = 0; i < 3; i++) { await page.evaluate(() => SL.place(2 + 2 * (SL.info().frame % 3), 0)); }
    await settle(page);
    const a = await audio(page);
    const line = JSON.stringify({ track: a.track, bpm: a.bpm, layers: a.layers, level: a.level, ctx: a.ctxState, sfx: a.sfx });
    console.log('SL.audio() => ' + line);
    if (SHOT_DIR) { fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, 'stacklight-audio.png') }); fs.writeFileSync(path.join(SHOT_DIR, 'audio.txt'), line + '\n'); }
    assert.equal(a.layers, 2);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});
