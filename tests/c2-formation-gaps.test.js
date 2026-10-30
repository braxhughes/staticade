// w13-tests: closes the V1 test gaps the cold review found (log ~06:40). New file only; game code untouched.
// Lead aim k / T floor / aimX clamp, Pincer gating (row, type, mate row, which enemy fires), Hunt band re-centring,
// huntC reset, tie-break, THERM_HALF / THERM_AMP and the Undertow clamp. Inputs are picked so the 72 lead cap
// and the other clamps do not hide the number under test. No stored hash values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { ROWS, W } from '../games/starfall/defs.js';
import { pickDiver } from '../games/starfall/sim/formation.js';
import { TELE_AIM } from '../games/starfall/sim/feel.js';
import { packWord } from '../engine/input-word.js';

const IDLE = 128;
const step = (sim, n = 1, w = IDLE) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(w); sim.clearEvents(); } return sim; };
const toPlay = sim => { while (sim.state !== 'play') step(sim); return sim; };
const mk = (stage, seed = 1) => { const sim = createSim({ seed, mode: 'stage' + stage }); sim.setGod(true); return sim; };
function formUp(sim) {
  const S = sim.ctx;
  for (const e of sim.enemies) if (!e.dead && e.r >= 0) { S.slot(e.r, e.c); e.x = e.px = S.SX; e.y = e.py = S.SY; e.st = 'form'; e.tele = 0; }
  S.formFull = true;
  return sim;
}
const teles = sim => sim.enemies.filter(e => !e.dead && e.st === 'tele');
const at = (sim, r, c) => sim.enemies.find(e => !e.dead && e.r === r && e.c === c);
function only(sim, keep) { for (const e of sim.enemies) if (!keep.some(([r, c]) => e.r === r && e.c === c)) e.st = 'wait'; }
function release(sim) { for (const e of sim.enemies) if (e.st === 'tele') { e.st = 'form'; e.tele = 0; e.pin = 0; e.hunt = 0; } }

// ---------- 2.1 lead aim ----------
function pinned(stage, px, vx, dy) {
  const sim = toPlay(mk(stage)), S = sim.ctx;
  const e = sim.enemies.find(q => q.type === 'moth');
  e.st = 'form'; e.x = e.px = 200; e.y = e.py = dy === undefined ? 150 : S.player.y - dy; e.aimT = 0; e.vWait = 0;
  S.heat = 0; S.player.x = px; S.player.vx = vx;
  for (const b of sim.eb) b.on = false;
  return { sim, S, e };
}

test('lead aim k: Z2 0.5 and Z3 0.75, with a small speed so the 72 cap does not hide them', () => {
  for (const [stage, k] of [[6, 0.5], [11, 0.75], [13, 0.75]]) {
    const { S, e } = pinned(stage, 150, 0.6);
    S.startAim(e);
    const T = Math.max(20, (S.player.y - e.y) / S.bulletSpd());
    const lead = 0.6 * (TELE_AIM + T) * k;
    assert.ok(lead > 5 && lead < 60, 'the cap is not in play: ' + lead);
    assert.ok(Math.abs(e.aimX - (150 + lead)) < 1e-9, `stage ${stage} k ${k}: aimX ${e.aimX} vs ${150 + lead}`);
    assert.equal(e.aimV, 1.6);
  }
  // zone 1 never leads, however fast the ship moves
  const z1 = pinned(1, 150, 2.5); z1.S.startAim(z1.e);
  assert.equal(z1.e.aimX, 150); assert.equal(z1.e.aimV, 1.2);
});

test('lead aim T floor: a shooter 20 above the ship uses T = 20, not the raw (dy / speed)', () => {
  for (const [stage, k] of [[6, 0.5], [11, 0.75]]) {
    const { S, e } = pinned(stage, 150, 0.5, 20);
    assert.ok(20 / S.bulletSpd() < 20, 'the raw T is under the floor');
    S.startAim(e);
    const want = 150 + 0.5 * (TELE_AIM + 20) * k;
    assert.ok(Math.abs(e.aimX - want) < 1e-9, `stage ${stage}: aimX ${e.aimX} vs ${want}`);
  }
  // far shooter: T is the raw value (above the floor)
  const far = pinned(11, 150, 0.5, 200);
  far.S.startAim(far.e);
  const T = 200 / far.S.bulletSpd();
  assert.ok(T > 20);
  assert.ok(Math.abs(far.e.aimX - (150 + 0.5 * (TELE_AIM + T) * 0.75)) < 1e-9);
});

test('lead aim clamp: aimX stays inside 10..390 at both edges', () => {
  const lo = pinned(11, 12, -0.5); lo.S.startAim(lo.e);
  assert.equal(lo.e.aimX, 10, 'left edge'); assert.equal(lo.e.aimY, lo.S.player.y);
  const hi = pinned(11, 388, 0.5); hi.S.startAim(hi.e);
  assert.equal(hi.e.aimX, W - 10, 'right edge'); assert.equal(hi.e.aimY, hi.S.player.y);
  const lo2 = pinned(6, 12, -0.8); lo2.S.startAim(lo2.e);
  assert.equal(lo2.e.aimX, 10);
  const hi2 = pinned(6, 388, 0.8); hi2.S.startAim(hi2.e);
  assert.equal(hi2.e.aimX, W - 10);
});

// ---------- 1.1 Pincer ----------
test('Pincer only runs on row-3 lever stages: stages 4, 8, 9, 12, 13, 14 never count a launch, stage 18 (row 3 again) does', () => {
  for (const st of [4, 9, 14, 8, 12, 13]) {
    const sim = formUp(toPlay(mk(st))), S = sim.ctx;
    for (let k = 0; k < 6; k++) { pickDiver(S); release(sim); }
    assert.equal(S.pincerN, 0, 'stage ' + st);
    assert.ok(!sim.enemies.some(e => e.pin), 'stage ' + st + ' has no pin');
  }
  const sim = formUp(toPlay(mk(18))), S = sim.ctx;
  assert.equal(S.row, 3);
  for (let k = 0; k < 3; k++) { pickDiver(S); release(sim); }
  assert.equal(S.pincerN, 3);
});

// stage 3, only slots (4,1) and (4,8) live in 'form'; the pick is steered onto the diver at (dr, dc)
function pairProbe(typeDiver, typeMate, swapPick) {
  const sim = formUp(toPlay(mk(3))), S = sim.ctx;
  S.pincerN = 2;
  const a = at(sim, 4, 1), b = at(sim, 4, 8);
  a.type = typeDiver; b.type = typeMate;
  only(sim, [[4, 1], [4, 8]]);
  const order = sim.enemies.filter(e => e.st === 'form');
  const want = swapPick ? b : a;
  S.rnd = () => (order.indexOf(want) + 0.5) / order.length; // cand[...] = want
  pickDiver(S);
  return { sim, T: teles(sim), want };
}
test('Pincer never pairs a type outside moth, wisp, splitter: not as the diver, not as the mate (control: moth + moth pairs)', () => {
  for (const [da, db] of [['moth', 'moth'], ['wisp', 'splitter'], ['splitter', 'wisp']]) {
    for (const sw of [false, true]) assert.equal(pairProbe(da, db, sw).T.length, 2, `${da}+${db} pairs`);
  }
  for (const ty of ['warden', 'lamplighter', 'eel', 'prism', 'cinder', 'mirage', 'hound', 'spark']) {
    for (const sw of [false, true]) {
      assert.equal(pairProbe(ty, 'moth', sw).T.length, 1, `${ty} diver (pick ${sw ? 'mate slot' : 'first slot'}) or moth diver with a ${ty} mate: no pair`);
      assert.equal(pairProbe('moth', ty, sw).T.length, 1, `moth diver with a ${ty} mate: no pair`);
    }
  }
});

test('Pincer mate must sit in the same row: a mirrored column in another row is not a mate, nor is a wrong column', () => {
  const sim = formUp(toPlay(mk(3))), S = sim.ctx;
  S.pincerN = 2;
  const a = at(sim, 4, 1), x = at(sim, 3, 8), y = at(sim, 4, 7);
  for (const e of [a, x, y]) e.type = 'moth';
  only(sim, [[4, 1], [3, 8], [4, 7]]);
  const order = sim.enemies.filter(e => e.st === 'form');
  S.rnd = () => (order.indexOf(a) + 0.5) / order.length;
  assert.equal(ROWS[4] - 1 - 1, 8);
  pickDiver(S);
  assert.equal(teles(sim).length, 1, 'neither (3, 8) nor (4, 7) is the mate of (4, 1)');
  assert.equal(a.pin, 0);
});

test('Pincer: the picked diver carries the one shot, its mate none', () => {
  for (const sw of [false, true]) {
    const { sim, T, want } = pairProbe('moth', 'moth', sw);
    assert.equal(T.length, 2);
    const mate = T.find(e => e !== want);
    assert.equal(want.pin, 1); assert.equal(mate.pin, 2);
    for (const e of T) sim.ctx.startDive(e, e.teleSide, e.teleOff);
    assert.equal(want.shots, 1, 'the picked diver fires');
    assert.equal(mate.shots, 0, 'the mirrored mate does not');
  }
});

// ---------- 2.2 Hunt ----------
test('Hunt band: moving more than 24 re-centres it at once; exactly 24 stays inside; the count then runs from the new centre', () => {
  const sim = toPlay(mk(3)), S = sim.ctx;
  assert.equal(S.huntC, 200);
  S.player.x = 224; step(sim);
  assert.equal(S.huntC, 200, 'exactly 24 away is still in the band'); assert.ok(S.huntN >= 2);
  S.player.x = 224.5; step(sim);
  assert.equal(S.huntC, 224.5, 'just over 24: the band re-centres on the ship'); assert.equal(S.huntN, 0);
  S.player.x = 224.5 - 24; step(sim);
  assert.equal(S.huntC, 224.5, 'the band is now centred at 224.5'); assert.equal(S.huntN, 1);
  S.player.x = 224.5 + 24; step(sim);
  assert.equal(S.huntC, 224.5); assert.equal(S.huntN, 2);
  S.player.x = 100; step(sim);
  assert.equal(S.huntC, 100); assert.equal(S.huntN, 0);
  // a ship parked at its new place becomes huntable: huntN climbs to 150 there
  step(sim, 149);
  assert.equal(S.huntN, 149); assert.equal(S.huntC, 100);
});

test('Hunt: a launch re-centres the band on the ship and restarts the count; the next launch is not a Hunt', () => {
  const sim = formUp(toPlay(mk(3))), S = sim.ctx;
  S.player.x = 210; S.huntC = 190; S.huntN = 150;
  pickDiver(S);
  assert.equal(sim.enemies.filter(e => e.hunt).length, 1, 'a Hunt launch');
  assert.equal(S.huntC, 210, 'huntC reset to the ship x'); assert.equal(S.huntN, 0);
  release(sim);
  pickDiver(S);
  assert.equal(sim.enemies.filter(e => e.hunt).length, 0, 'the very next launch is a plain one');
});

test('Hunt tie-break: two enemies as far from the ship in x go to the smaller column, whichever comes first in the list', () => {
  for (const flip of [false, true]) {
    const sim = formUp(toPlay(mk(3))), S = sim.ctx;
    const a = at(sim, 4, 3), b = at(sim, 4, 6);
    a.type = b.type = 'moth';
    only(sim, [[4, 3], [4, 6]]);
    a.x = a.px = flip ? 220 : 180; b.x = b.px = flip ? 180 : 220;
    if (flip) sim.enemies.reverse();
    S.player.x = 200; S.huntC = 200; S.huntN = 150;
    pickDiver(S);
    assert.equal(a.st, 'tele', 'smaller column c3 is hunted (flip ' + flip + ')'); assert.equal(a.hunt, 1);
    assert.equal(b.st, 'form'); assert.equal(b.hunt, 0);
  }
});

// ---------- 1.5 Thermals: width and reach ----------
test('Thermals: columns sit 120 either side of 200 at the peak and are 12 wide each way (11.5 slowed, 12.5 not)', () => {
  const sim = toPlay(mk(12)), S = sim.ctx, T0 = 392;
  const pin = () => { S.twistT = T0; S.hitstop = 0; };
  const peak = 120 * Math.sin((T0 + 1) * 0.004);
  assert.ok(peak > 119.9, 'near the peak');
  const probe = (x) => {
    for (const b of sim.eb) b.on = false;
    pin(); S.eFire(x, 100, 0, 2.9, false);
    const b = sim.eb.find(q => q.on);
    step(sim); pin();
    return b.th;
  };
  assert.ok(probe(200 + peak) < 1 && probe(200 + peak) > 0, 'centre of the right column');
  assert.equal(probe(200 + peak + 11.5), 0.6, 'right column, 11.5 out');
  assert.equal(probe(200 + peak - 11.5), 0.6, 'right column, 11.5 in');
  assert.equal(probe(200 + peak + 12.5), 0, 'right column, 12.5 out');
  assert.equal(probe(200 + peak - 12.5), 0, 'right column, 12.5 in');
  assert.equal(probe(200 - peak + 11.5), 0.6, 'left column, 11.5 out');
  assert.equal(probe(200 - peak - 11.5), 0.6);
  assert.equal(probe(200 - peak + 12.5), 0);
  assert.equal(probe(200 - peak - 12.5), 0);
});

// ---------- 1.3 Undertow clamp ----------
test('Undertow clamp: the pull stops at x 390 on the right and 10 on the left', () => {
  const sim = toPlay(mk(8)), S = sim.ctx, p = S.player;
  S.twistT = 320; p.x = 389.9; p.px = 389.9;
  step(sim, 6);
  assert.equal(p.x, W - 10, 'right edge');
  S.twistT = 720; p.x = 10.1; p.px = 10.1;
  step(sim, 6);
  assert.equal(p.x, 10, 'left edge');
});
