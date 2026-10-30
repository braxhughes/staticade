// S10 STARLIGHT rhythm stage (design.md B.4, B.8 rules 1-3, B.9): every number in B.4's two tables measured from real
// sim runs (createSim, real shots through the core's collision code), per zone. Expected values are written out as
// literals from the design, never read back from sim/starlight.js, so a changed constant fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createSim } from '../games/starfall/sim.js';
import { EV_SFX, EV_POPUP, EV_HITSTOP, SFX_ID, POP_NUM, POP_PHRASE, POP_FINALE, W, H } from '../games/starfall/defs.js';
import { starlightInfo, phrasePoint } from '../games/starfall/sim/starlight.js';
import { systems } from '../games/starfall/sim/systems.js';
import { chainBonus, CP_CHAIN } from '../games/starfall/sim/score.js';
import { packWord } from '../engine/input-word.js';

const IDLE = packWord(0, false, false, false, false, 0);
const FIRE = packWord(0, true, true, false, false, 0);
const STAGE = { 1: 4, 2: 9, 3: 14 };
const SIZE = { 1: 6, 2: 7, 3: 8 };
const TOTAL = { 1: 36, 2: 42, 3: 48 };
const onScreen = e => e.x > 12 && e.x < W - 12 && e.y > 12 && e.y < H - 30;
const isOn = f => { const d = f % 25; return d <= 4 || d >= 21; };

// One STARLIGHT stage. plan(f, S) -> sl index to shoot on stage frame f (or -1); the shot is placed so the core's own
// collision test hits that enemy on frame f. Returns per-frame records and every event.
function run({ stage = 4, seed = 1, plan = null, tally = true, until = null, before = null } = {}) {
  const sim = createSim({ seed, mode: 'stage' + stage }), S = sim.ctx;
  const out = { sim, S, sfx: [], pops: [], hitstopEv: 0, maxBullets: 0, maxTele: 0, maxStop: 0, missed: [], killF: [], playFrames: 0, gradeF: [] };
  const drain = f => sim.drain((b, o) => {
    if (b[o] === EV_SFX) out.sfx.push({ f, id: b[o + 1], arg: b[o + 2] });
    else if (b[o] === EV_POPUP) out.pops.push({ f, kind: b[o + 1], v: b[o + 4], c: b[o + 5] });
    else if (b[o] === EV_HITSTOP) out.hitstopEv++;
  });
  if (before) before(sim, S);
  while (sim.state !== 'play') { sim.step(IDLE); drain(-1); }
  out.start = sim.score;
  while (sim.state === 'play') {
    const f = S.stageT;
    if (until && until(f, S, sim)) return out;
    let want = -1;
    if (plan) {
      const i = plan(f, S);
      const e = i >= 0 ? S.sl.ord[i] : null;
      // shoot only when no enemy ahead of the target in the core's list overlaps it (the core hits the first one it finds)
      const k = e ? S.enemies.indexOf(e) : -1;
      if (e && e.st === 'phrase' && onScreen(e) && !S.enemies.some((o, j) => j < k && !o.dead && o.st !== 'wait' && Math.abs(o.x - e.x) < 14 && Math.abs(o.y - e.y) < 18)) { S.shot(e.x, e.y + 6.5); want = i; }
    }
    const g0 = Array.from(S.sl.grade);
    sim.step(IDLE); out.playFrames++;
    drain(f);
    if (want >= 0) { if (S.sl.ord[want] !== null) out.missed.push([f, want]); else out.killF[want] = f; }
    for (let p = 0; p < 6; p++) if (S.sl.grade[p] !== g0[p]) out.gradeF[p] = f;
    out.maxBullets = Math.max(out.maxBullets, sim.liveBullets()); out.maxTele = Math.max(out.maxTele, sim.telegraphs()); out.maxStop = Math.max(out.maxStop, sim.hitstop);
  }
  out.endState = sim.state; out.afterPlay = sim.score;
  if (tally) while (sim.state === 'bonusEnd') { const f = -2; sim.step(IDLE); drain(f); }
  return out;
}
// kill plan: shoot enemies in the order given by seq (sl indices), each on the first frame where ok(f) holds and it is on
// screen; a target that has left is skipped
function seqPlan(seq, ok) {
  let j = 0;
  return (f, S) => {
    while (j < seq.length && S.sl.ord[seq[j]] === null) j++;
    if (j >= seq.length || !ok(f)) return -1;
    return seq[j];
  };
}
const range = (a, n) => Array.from({ length: n }, (_, k) => a + k);
const ON = f => f % 25 === 0, OFF = f => f % 25 === 12;
const phrasePops = o => o.pops.filter(p => p.kind === POP_PHRASE).map(p => ({ pts: Math.floor(p.v / 8), flags: p.v & 7 }));

// ---------- the design verify line and counts ----------
test('verify line: stages 4 / 9 / 14 give beatFrames 25 and enemy totals 36 / 42 / 48 (6 phrases of 6 / 7 / 8)', () => {
  for (const z of [1, 2, 3]) {
    const sim = createSim({ seed: 1, mode: 'stage' + STAGE[z] });
    const info = starlightInfo(sim.ctx);
    assert.equal(info.beatFrames, 25, 'zone ' + z);
    assert.equal(info.beat, -1); assert.equal(info.phrase, -1);
    assert.equal(sim.enemies.length, TOTAL[z]); assert.equal(sim.bonusTotal, TOTAL[z]);
    assert.ok(sim.enemies.every(e => e.bonus && e.hp === 1));
    assert.equal(sim.ctx.sl.size, SIZE[z]);
  }
  const n = createSim({ seed: 1, mode: 'stage1' });
  assert.deepEqual(starlightInfo(n.ctx), { beatFrames: 0, beat: -1, phrase: -1 }, 'no beat clock on a normal stage');
  assert.ok(systems.some(s => s.id === 'starlight'), 'the starlight system is registered');
});

// ---------- phrase starts, density, flight, stage length ----------
for (const z of [1, 2, 3]) {
  test(`zone ${z}: arrivals (phrase starts every 16 beats, density), 10-beat flight, 2600-frame stage`, () => {
    const sim = createSim({ seed: 2, mode: 'stage' + STAGE[z] }), S = sim.ctx, n = TOTAL[z];
    const first = new Array(n).fill(-1), last = new Array(n).fill(-1);
    while (sim.state !== 'play') { sim.step(IDLE); sim.clearEvents(); }
    let frames = 0, beatAtEnd = -1;
    const beatsSeen = [];
    while (sim.state === 'play') {
      const f = S.stageT;
      for (let i = 0; i < n; i++) { const e = S.sl.ord[i]; if (e && e.st === 'phrase') { if (first[i] < 0) first[i] = f; last[i] = f; } }
      sim.step(IDLE); frames++;
      sim.drain((b, o) => { if (b[o] === EV_SFX && b[o + 1] === SFX_ID.beat) beatsSeen.push([f, b[o + 2]]); });
      if (sim.state === 'play') beatAtEnd = S.sl.beat;
      if (f === 2599) beatAtEnd = S.sl.beat;
    }
    assert.equal(frames, 2600, '104 beats x 25 frames of play');
    assert.equal(sim.state, 'bonusEnd');
    assert.equal(beatAtEnd, 103, 'the last frame is in beat 103');
    // one beat event per sim beat, on the beat frame, numbered 0..103
    assert.equal(beatsSeen.length, 104);
    beatsSeen.forEach(([f, b], k) => { assert.equal(f, k * 25); assert.equal(b, k); });
    const size = SIZE[z];
    const offs = { 1: [0, 50, 100, 150, 200, 250], 2: [0, 25, 50, 75, 100, 125, 150], 3: [0, 12, 25, 37, 50, 62, 75, 87] }[z];
    for (let p = 0; p < 6; p++) {
      assert.equal(first[p * size], p * 400, `phrase ${p} starts on beat ${p * 16}`);
      for (let k = 0; k < size; k++) {
        const i = p * size + k;
        assert.equal(first[i], p * 400 + offs[k], `zone ${z} phrase ${p} enemy ${k} arrival`);
        assert.equal(last[i] - first[i], 250, 'flies 10 beats (frames A..A+250)');
        assert.equal(S.sl.ord[i], null, 'then exits');
      }
    }
    if (z === 3) {
      const gaps = []; for (let k = 1; k < 8; k++) gaps.push(offs[k] - offs[k - 1]);
      assert.deepEqual(gaps, [12, 13, 12, 13, 12, 13, 12], 'two per beat: the half beat at 12 then 13 frames');
    }
    if (z === 1) assert.equal(last[5], 500, 'Z1: a phrase\'s last enemy leaves on beat 20 (frame 500), while the next phrase started on beat 16');
    assert.equal(sim.enemies.length, 0, 'every enemy has exited');
  });
}

test('phrase paths: every zone and phrase starts and ends off screen and comes on screen in between', () => {
  const off = ([x, y]) => x < -6 || x > W + 6 || y < -6 || y > H + 6;
  for (const z of [1, 2, 3]) for (let p = 0; p < 6; p++) {
    assert.ok(off(phrasePoint(z, p, 0)), `z${z} p${p} start off screen ${phrasePoint(z, p, 0)}`);
    assert.ok(off(phrasePoint(z, p, 250)), `z${z} p${p} end off screen ${phrasePoint(z, p, 250)}`);
    let onFrames = 0, maxY = -1e9;
    for (let t = 0; t <= 250; t++) { const [x, y] = phrasePoint(z, p, t); if (x > 12 && x < W - 12 && y > 12 && y < H - 30) onFrames++; maxY = Math.max(maxY, y); }
    assert.ok(onFrames > 120, `z${z} p${p} on screen ${onFrames} frames`);
    if (z !== 3) assert.ok(maxY < 200, 'stays above the ship band');
  }
});

// ---------- on-beat window ----------
test('on-beat window: frames 0-4 and 21-24 after a beat score 250, frames 5-20 score 120 (kill points at x1)', () => {
  // Z2, phrase 0: enemy 0 is on screen around frames 60-200; kill it on one chosen frame each run
  for (const [d, want] of [[0, 250], [4, 250], [5, 120], [12, 120], [20, 120], [21, 250], [24, 250]]) {
    const F = 100 + d;
    const o = run({ stage: 9, plan: (f, S) => f === F ? 0 : -1, tally: false });
    assert.equal(o.missed.length, 0); assert.equal(o.killF[0], F);
    const pts = o.pops.filter(p => p.kind === POP_NUM && p.f === F).map(p => p.v);
    assert.deepEqual(pts, [want], `kill on frame ${F} (${d} after a beat)`);
    const ev = o.sfx.filter(s => s.f === F && s.id === SFX_ID.beat && s.arg < 0).map(s => s.arg);
    assert.deepEqual(ev, [want === 250 ? -2 : -1], 'beat sound arg: -2 first on-beat note, -1 off-beat thud');
  }
  let on = 0; for (let f = 0; f < 25; f++) if (isOn(f)) on++;
  assert.equal(on, 9, '9 of every 25 frames');
});

test('kill points: DEEP SKY and the loop factor apply to STARLIGHT kills', () => {
  const a = run({ stage: 9, plan: (f) => f === 100 ? 0 : -1, tally: false, before: (sim, S) => { S.mult = 3; } });
  assert.deepEqual(a.pops.filter(p => p.kind === POP_NUM).map(p => p.v), [750], 'on-beat 250 x DEEP SKY 3');
  const b = run({ stage: 24, plan: (f) => f === 112 ? 0 : -1, tally: false }); // stage 24 = loop 1, row 9 (Z2 STARLIGHT)
  assert.equal(b.S.loop, 1); assert.equal(b.S.D.scoreLoop, 1.25);
  assert.deepEqual(b.pops.filter(p => p.kind === POP_NUM).map(p => p.v), [150], 'off-beat 120 x loop 1.25');
});

// ---------- grades ----------
for (const z of [1, 2, 3]) {
  test(`zone ${z}: phrase grades Complete ${90 * SIZE[z]}, In Tune ${210 * SIZE[z]}, In Order x1.5; a miss pays nothing`, () => {
    const n = SIZE[z], P0 = range(0, n), swap = [1, 0, ...range(2, n - 2)];
    const cases = [
      { seq: P0, ok: ON, pts: 210 * n * 1.5, flags: 7, name: 'In Tune, In Order' },
      { seq: swap, ok: ON, pts: 210 * n, flags: 3, name: 'In Tune' },
      { seq: P0, ok: OFF, pts: 90 * n * 1.5, flags: 5, name: 'Complete, In Order' },
      { seq: swap, ok: OFF, pts: 90 * n, flags: 1, name: 'Complete' }
    ];
    for (const c of cases) {
      const o = run({ stage: STAGE[z], plan: seqPlan(c.seq, c.ok), tally: false, until: f => f > 420 });
      assert.equal(o.missed.length, 0, c.name + ': every shot hit its target');
      assert.equal(o.S.sl.kills[0], n, c.name + ': phrase 0 fully killed');
      const pp = phrasePops(o);
      assert.deepEqual(pp, [{ pts: c.pts, flags: c.flags }], `zone ${z} ${c.name}`);
      assert.equal(o.gradeF[0], Math.max(...o.killF.filter(v => v !== undefined)), 'graded on the frame of the last kill');
    }
    // a mix of on- and off-beat: Complete only
    const mix = run({ stage: STAGE[z], plan: seqPlan(P0, f => (f % 25 === 0 && f < 60) || f % 25 === 12), tally: false, until: f => f > 420 });
    assert.equal(mix.missed.length, 0);
    assert.ok(mix.S.sl.tune[0] > 0 && mix.S.sl.tune[0] < n, 'some on, some off');
    assert.deepEqual(phrasePops(mix), [{ pts: 90 * n * 1.5, flags: 5 }]);
    // one enemy left alone: no phrase bonus when it exits
    const miss = run({ stage: STAGE[z], plan: seqPlan(range(0, n - 1), ON), tally: false, until: f => f > 520 });
    assert.equal(miss.S.sl.kills[0], n - 1);
    assert.deepEqual(phrasePops(miss), [], 'not Complete: nothing');
    assert.equal(miss.gradeF[0], 0 + { 1: 250, 2: 150, 3: 87 }[z] + 250, 'graded when the last enemy exits');
  });
}

test('In Order is judged per phrase: overlapping Z1 phrases interleaved still both grade In Order', () => {
  // phrase 1's first enemy (arrives 400) is killed before phrase 0's last (arrives 250, leaves 500)
  const seq = [0, 1, 2, 3, 4, 6, 5, 7, 8, 9, 10, 11];
  const o = run({ stage: 4, plan: seqPlan(seq, ON), tally: false, until: f => f > 900 });
  assert.equal(o.missed.length, 0);
  assert.ok(o.killF[6] < o.killF[5], 'the kills really interleave');
  assert.deepEqual(phrasePops(o), [{ pts: 1890, flags: 7 }, { pts: 1890, flags: 7 }]);
  // and an out-of-order kill inside phrase 1 breaks only phrase 1
  const o2 = run({ stage: 4, plan: seqPlan([0, 1, 2, 3, 4, 6, 5, 8, 7, 9, 10, 11], ON), tally: false, until: f => f > 900 });
  assert.equal(o2.missed.length, 0);
  assert.deepEqual(phrasePops(o2), [{ pts: 1890, flags: 7 }, { pts: 1260, flags: 3 }]);
});

// ---------- finales and full stages ----------
for (const z of [1, 2, 3]) {
  test(`zone ${z}: STANDING OVATION ${440 * TOTAL[z]}, ENCORE ${175 * TOTAL[z]}, none with a miss; score ledger adds up`, () => {
    const all = range(0, TOTAL[z]);
    const full = (ok, seq = all) => run({ stage: STAGE[z], seed: 4, plan: seqPlan(seq, ok) });
    const fin = o => o.pops.filter(p => p.kind === POP_FINALE).map(p => ({ pts: Math.floor(p.v / 2), ovation: p.v & 1 }));
    const ov = full(ON);
    assert.equal(ov.missed.length, 0); assert.equal(ov.sim.bonusHits, TOTAL[z]);
    assert.equal(ov.playFrames, 2600);
    assert.deepEqual(fin(ov), [{ pts: 440 * TOTAL[z], ovation: 1 }]);
    assert.deepEqual(phrasePops(ov).map(p => p.pts), new Array(6).fill(210 * SIZE[z] * 1.5));
    // ledger: kill popups + phrase bonuses + finale + chain end bonus = the score the stage added
    const kills = ov.pops.filter(p => p.kind === POP_NUM).reduce((a, p) => a + p.v, 0);
    const chainEnd = ov.S.chainLast >= 10 ? chainBonus(ov.S.chainLast) : 0;
    assert.equal(ov.sim.score - ov.start, kills + 6 * 210 * SIZE[z] * 1.5 + 440 * TOTAL[z] + chainEnd);
    const en = full(OFF);
    assert.equal(en.missed.length, 0);
    assert.deepEqual(fin(en), [{ pts: 175 * TOTAL[z], ovation: 0 }]);
    // every phrase In Tune but one phrase only Complete: ENCORE, not STANDING OVATION
    const one = full(f => f < 400 ? OFF(f) : ON(f));
    assert.equal(one.missed.length, 0);
    assert.deepEqual(fin(one), [{ pts: 175 * TOTAL[z], ovation: 0 }]);
    // one enemy missed: no finale, the tally still runs and the stage clears
    const miss = full(ON, all.slice(1));
    assert.deepEqual(fin(miss), []);
    assert.equal(miss.sim.state, 'clear');
    assert.ok(miss.sfx.some(s => s.id === SFX_ID.select && s.f === -2), 'no finale: the plain tally sound');
    assert.ok(ov.sfx.some(s => s.id === SFX_ID.life && s.f === -2), 'finale: the reward cue (life id, no ship)');
  });
}

test('finale and phrase bonuses are flat: loop factor only (stage 19, loop 1: x1.25), DEEP SKY ignored', () => {
  const o = run({ stage: 19, seed: 4, plan: seqPlan(range(0, 36), ON), before: (sim, S) => { S.mult = 2; } });
  assert.equal(o.missed.length, 0);
  assert.deepEqual(o.pops.filter(p => p.kind === POP_FINALE).map(p => Math.floor(p.v / 2)), [Math.floor(15840 * 1.25)]);
  assert.deepEqual(phrasePops(o).map(p => p.pts), new Array(6).fill(Math.floor(1890 * 1.25)));
});

// ---------- chain, hit-stop, fire, stage card ----------
test('STARLIGHT kills extend the Ember Chain; the stage end banks it', () => {
  const o = run({ stage: 4, plan: seqPlan(range(0, 6), ON), tally: false, until: f => f > 300 });
  assert.equal(o.S.chain, 6, 'six kills 50 frames apart: one chain of 6');
  // a paced player (on-beat, the next kill once 75 frames of the 90-frame window are used, the first to leave first)
  // keeps one chain through all 36
  const on = ([x, y]) => x > 12 && x < W - 12 && y > 12 && y < H - 30;
  let end = null;
  const paced = (f, S) => {
    const L = S.sl;
    if (!end) { end = []; for (let i = 0; i < L.n; i++) { let t1 = -1; for (let t = 0; t <= 250; t++) if (on(phrasePoint(L.zone, (i / L.size) | 0, t))) t1 = t; end[i] = L.arr[i] + t1; } }
    if (f % 25) return -1;
    let best = -1;
    for (let i = 0; i < L.n; i++) { const e = L.ord[i]; if (e && e.st === 'phrase' && on([e.x, e.y]) && (best < 0 || end[i] < end[best])) best = i; }
    if (best >= 0 && (end[best] < f + 25 || S.chain === 0 || S.chainT <= 15)) return best;
    return -1;
  };
  const full = run({ stage: 4, plan: paced, tally: false });
  assert.equal(full.missed.length, 0);
  assert.equal(full.S.bonusHits, 36); assert.equal(full.S.chainMax, 36, 'one 36-kill chain');
  // the stage end (the last play frame moves to bonusEnd) banks it: 5 x 36 x 36
  assert.equal(full.S.chain, 0, 'banked at the stage end'); assert.equal(full.S.chainLast, 36);
  const P = full.S.cpop, banked = [];
  for (let i = 0; i < P.k.length; i++) if (P.k[i] === CP_CHAIN) banked.push([P.v[i], P.w[i]]);
  assert.deepEqual(banked, [[5 * 36 * 36, 36]], 'chain end bonus 6480 for a chain of 36');
});

test('no hit-stop on STARLIGHT, no enemy bullets, no telegraphs, no death possible from the enemies', () => {
  for (const z of [1, 2, 3]) {
    const o = run({ stage: STAGE[z], plan: seqPlan(range(0, TOTAL[z]), ON), before: (sim, S) => { S.feel('big'); S.addHitstop(8); } });
    assert.equal(o.maxStop, 0); assert.equal(o.hitstopEv, 0);
    assert.equal(o.maxBullets, 0); assert.equal(o.maxTele, 0);
    assert.equal(o.sim.deaths, 0);
  }
  // an enemy flown straight through the ship does not hurt it
  const o = run({ stage: 4, tally: false, until: (f, S, sim) => {
    const e = S.sl.ord[0]; if (f === 150 && e) { e.x = sim.player.x; e.y = sim.player.y; } return f > 160; } });
  assert.equal(o.sim.deaths, 0); assert.ok(o.sim.player.alive);
});

test('no kill during the stage card: fire held through the card fires nothing and the clock starts at beat 0', () => {
  const sim = createSim({ seed: 1, mode: 'stage9' }), S = sim.ctx;
  while (sim.state === 'intro') { sim.step(FIRE); sim.clearEvents(); assert.equal(sim.shotsFired, 0); assert.equal(S.sl.beat, -1); }
  assert.equal(S.bonusHits, 0); assert.equal(sim.stageT, 0);
  sim.step(IDLE); assert.equal(S.sl.beat, 0); assert.equal(S.sl.phrase, 0);
});

test('KINDLE on STARLIGHT takes no enemy and grants no wingman', () => {
  const o = run({ stage: 4, tally: false, until: (f, S, sim) => { if (f === 300) { S.meter = 10; sim.step(packWord(0, false, false, true, false, 0)); sim.clearEvents(); } return f > 305; } });
  assert.equal(o.sim.wing.length, 0); assert.equal(o.S.bonusHits, 0);
});

test('the last kill of a phrase on its last on-screen frame is graded that frame; the stage ends after frame 2599', () => {
  // Z2 phrase 5: kill enemies 0-5 on beats, then enemy 6 on its last on-screen frame
  const base = 5 * 7;
  let lastOn = -1;
  { const s = createSim({ seed: 1, mode: 'stage9' }), S = s.ctx; while (s.state !== 'play') { s.step(IDLE); s.clearEvents(); }
    while (s.state === 'play') { const f = S.stageT, e = S.sl.ord[base + 6]; if (e && e.st === 'phrase' && onScreen(e)) lastOn = f; s.step(IDLE); s.clearEvents(); } }
  const first6 = seqPlan(range(base, 6), ON);
  const o = run({ stage: 9, plan: (f, S) => f === lastOn ? base + 6 : first6(f, S), tally: false });
  assert.equal(o.killF[base + 6], lastOn);
  assert.equal(o.gradeF[5], lastOn);
  assert.equal(o.endState, 'bonusEnd'); assert.equal(o.playFrames, 2600);
});

// ---------- hash and determinism ----------
test('hash: every piece of STARLIGHT state changes stateHash', () => {
  const o = run({ stage: 9, plan: seqPlan(range(0, 7), ON), tally: false, until: f => f === 300 });
  const { sim, S } = o, L = S.sl, h0 = sim.stateHash();
  const flip = (obj, key, v) => { const old = obj[key]; obj[key] = v; const h = sim.stateHash(); obj[key] = old; return h; };
  for (const k of ['zone', 'size', 'n', 'beat', 'phrase', 'finale', 'paid', 'finPts']) assert.notEqual(flip(L, k, L[k] + 1), h0, k);
  for (const k of ['kills', 'tune', 'order', 'gone', 'grade']) for (const p of [0, 5]) assert.notEqual(flip(L[k], p, L[k][p] ^ 1), h0, k + '[' + p + ']');
  assert.notEqual(flip(L.arr, 40, L.arr[40] + 1), h0, 'arrival frame');
  const i = L.ord.findIndex(e => e !== null);
  assert.notEqual(flip(L.ord, i, null), h0, 'which enemies are still ours');
  assert.equal(sim.stateHash(), h0, 'restored');
});

const SCRIPT = `
import { createSim } from './games/starfall/sim.js';
const sim = createSim({ seed: 11, mode: 'stage14' }), S = sim.ctx;
while (!(sim.state === 'clear')) {
  if (sim.state === 'play') { const f = S.stageT; if (f % 25 === (f >> 7) % 25) for (let i = 0; i < S.sl.n; i++) { const e = S.sl.ord[i]; if (e && e.st === 'phrase' && e.x > 12 && e.x < 388 && e.y > 12 && e.y < 270) { S.shot(e.x, e.y + 6.5); break; } } }
  sim.step(128); sim.clearEvents();
}
console.log(JSON.stringify({ h: sim.stateHash(), score: sim.score, hits: S.bonusHits }));
`;
test('determinism: the same seed and inputs give the same hash twice in this process and in a fresh Node process', () => {
  const runOnce = () => {
    const sim = createSim({ seed: 11, mode: 'stage14' }), S = sim.ctx;
    while (!(sim.state === 'clear')) {
      if (sim.state === 'play') { const f = S.stageT; if (f % 25 === (f >> 7) % 25) for (let i = 0; i < S.sl.n; i++) { const e = S.sl.ord[i]; if (e && e.st === 'phrase' && e.x > 12 && e.x < 388 && e.y > 12 && e.y < 270) { S.shot(e.x, e.y + 6.5); break; } } }
      sim.step(IDLE); sim.clearEvents();
    }
    return { h: sim.stateHash(), score: sim.score, hits: S.bonusHits };
  };
  const a = runOnce(), b = runOnce();
  assert.deepEqual(a, b);
  assert.ok(a.hits > 20 && a.score > 0);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', SCRIPT], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), a, 'a fresh process agrees');
});
