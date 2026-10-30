// C.2 slice V2 (design.md B.11 3.1, 3.2): the Tetherling and the Hound. Every Verify line of 3.1 and 3.2 is a test
// here, plus the CUT box rulings (the cxl clamp edge case, Hound bullets freezing in hit-stop, Hound entry sides) and
// HALO absorbing the line. No state hash is compared with a stored value: the hash tests only check that the
// new state is mixed in. Measured values are printed with t.diagnostic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { GROUPS, EV_SFX, EV_FX, EV_POPUP, SFX_ID, FX_TETHER, POP_CUT, W } from '../games/starfall/defs.js';
import { slotType } from '../games/starfall/sim/stages.js';
import { systems } from '../games/starfall/sim/systems.js';
import { TELE_DIVE } from '../games/starfall/sim/feel.js';
import { tetherSlots, lineTouch, LINE_FAINT, LINE_BLINKING, LINE_SOLID, LINE_GONE, DIVE_LINKED, DIVE_SOLO } from '../games/starfall/sim/enemies/tether.js';
import { HOUND_N, H_OFF, H_ENTER, H_SHADOW, H_GLOW, H_SECOND, H_LEAVE, houndsLive } from '../games/starfall/sim/enemies/hound.js';
import { installHooks } from '../games/starfall/hooks.js';
import { packWord } from '../engine/input-word.js';

const IDLE = 128;
const tetherSys = systems.find(s => s.id === 'tether'), houndSys = systems.find(s => s.id === 'hound');
// step n frames; ev (optional) collects { sfx: [ids], fx: [[kind, x, y]], pop: [[kind, x, y, v]] }
function step(sim, n = 1, w = IDLE, ev = null) {
  for (let i = 0; i < n && !sim.done; i++) {
    sim.step(w);
    if (ev) sim.drain((b, o) => {
      if (b[o] === EV_SFX) ev.sfx.push(b[o + 1]);
      else if (b[o] === EV_FX) ev.fx.push([b[o + 1], b[o + 2], b[o + 3]]);
      else if (b[o] === EV_POPUP) ev.pop.push([b[o + 1], b[o + 2], b[o + 3], b[o + 4]]);
    });
    else sim.clearEvents();
  }
  return sim;
}
const evs = () => ({ sfx: [], fx: [], pop: [] });
const toPlay = sim => { while (sim.state !== 'play') step(sim); return sim; };
const mk = (stage, seed = 1, god = true) => { const sim = createSim({ seed, mode: 'stage' + stage }); if (god) sim.setGod(true); return sim; };
function formUp(sim) {
  const S = sim.ctx;
  for (const e of sim.enemies) if (!e.dead && e.r >= 0) { S.slot(e.r, e.c); e.x = e.px = S.SX; e.y = e.py = S.SY; e.st = 'form'; e.tele = 0; }
  S.formFull = true;
  return sim;
}
const pair = (S, k) => [S.tethers.mem[2 * k], S.tethers.mem[2 * k + 1]];
const live = sim => sim.enemies.filter(e => !e.dead).length;

// ================= 3.1 Tetherling =================

test('3.1 slots: stage 6 row 4 cols 2+3, 6+7 (group TL); stages 7 and 8 row 2 cols 0+1, 6+7 (group SR); none in stage 13; no overlap', (t) => {
  const want = { 6: [[4, 2], [4, 3], [4, 6], [4, 7]], 7: [[2, 0], [2, 1], [2, 6], [2, 7]], 8: [[2, 0], [2, 1], [2, 6], [2, 7]] };
  for (const row of [6, 7, 8]) {
    assert.deepEqual(tetherSlots(row), want[row]);
    const got = [];
    for (let r = 0; r < 5; r++) for (let c = 0; c < 10; c++) if (slotType(row, r, c) === 'tether') got.push([r, c]);
    assert.deepEqual(got, want[row], 'row ' + row + ': the tether slots are exactly these (a later mix line never takes one)');
    // each pair: neighbouring columns, consecutive members of one entry group
    for (let k = 0; k < 2; k++) {
      const [a, b] = [want[row][2 * k], want[row][2 * k + 1]];
      assert.equal(a[0], b[0]); assert.equal(b[1], a[1] + 1);
      const g = GROUPS.findIndex(G => G.slots.some(s => s[0] === a[0] && s[1] === a[1]));
      const ia = GROUPS[g].slots.findIndex(s => s[0] === a[0] && s[1] === a[1]), ib = GROUPS[g].slots.findIndex(s => s[0] === b[0] && s[1] === b[1]);
      assert.equal(ib, ia + 1, `row ${row} pair ${k} is consecutive in group ${GROUPS[g].path}`);
      assert.equal(GROUPS[g].path, row === 6 ? 'TL' : 'SR');
    }
  }
  for (const row of [1, 2, 3, 11, 12, 13]) for (let r = 0; r < 5; r++) for (let c = 0; c < 10; c++) assert.notEqual(slotType(row, r, c), 'tether', `row ${row}`);
  t.diagnostic('slots: stage 6 ' + JSON.stringify(want[6]) + '; stages 7-8 ' + JSON.stringify(want[7]));
});

test('3.1 Verify: stage 6 `types` includes tether once the formation is full (stages 7 and 8 too; endless stage 21 = row 6)', (t) => {
  for (const st of [6, 7, 8, 21]) {
    const sim = mk(st), S = sim.ctx;
    const SF = { info() { return {}; } }; installHooks(SF, { sim });
    let g = 0; while (!S.formFull && g++ < 5000) step(sim);
    assert.ok(S.formFull, 'formation full in stage ' + st);
    const types = SF.info().types;
    assert.ok(types.includes('tether'), `stage ${st} types: ${types.join(',')}`);
    assert.equal(sim.enemies.filter(e => e.type === 'tether').length, 4);
    for (let k = 0; k < 2; k++) { const [a, b] = pair(S, k); assert.ok(a && b && a.tm === 0 && b.tm === 1 && a.tp === k && b.tp === k && a.c + 1 === b.c); }
    if (st === 6) t.diagnostic(`stage 6 formation full at frame ${sim.frame}; types ${types.join(',')}`);
  }
  const S13 = mk(13).ctx;
  assert.equal(S13.enemies.filter(e => e.type === 'tether').length, 0, 'stage 13 has no Tetherlings');
});

// a stage 6 sim in play, formation snapped, random picks stopped; pair k picked with side `side` (default: its own side)
function launched(k = 0, seed = 1, opts = {}) {
  const sim = toPlay(mk(opts.stage || 6, seed, opts.god !== false)), S = sim.ctx;
  formUp(sim);
  S.diveTimer = 1e9; S.player.inv = 1e6; // no random picks; no body or line hits while the test watches
  if (opts.shipX != null) S.player.x = S.player.px = opts.shipX;
  const [a, b] = pair(S, k), p = opts.pickRight ? b : a;
  p.st = 'tele'; p.tele = TELE_DIVE; p.teleSide = a.x < 200 ? -1 : 1; p.teleOff = 0;
  return { sim, S, a, b };
}
const keepQuiet = S => { S.diveTimer = 1e9; };

test('3.1 Verify: forcing a pick on a Tetherling starts 2 telegraphs with offx -15 and +15 (same count and side)', (t) => {
  for (const pickRight of [false, true]) {
    const { sim, S, a, b } = launched(0, 1, { pickRight });
    step(sim);
    assert.equal(a.st, 'tele'); assert.equal(b.st, 'tele');
    assert.equal(a.teleOff, -15); assert.equal(b.teleOff, 15);
    assert.equal(a.tele, b.tele); assert.equal(a.teleSide, b.teleSide);
    assert.equal(S.tethers.dive[0], DIVE_LINKED);
    const tele = sim.enemies.filter(e => !e.dead && e.st === 'tele').length;
    assert.equal(tele, 2, 'exactly the 2 telegraphs');
    // both leave on the same frame
    let g = 0; while (a.st === 'tele' && g++ < 40) { keepQuiet(S); step(sim); }
    assert.equal(a.st, 'dive'); assert.equal(b.st, 'dive');
    if (!pickRight) t.diagnostic(`pick on the left member: telegraphs ${tele}, offx ${a.teleOff} / ${b.teleOff}, tele ${a.tele} / ${b.tele}`);
  }
});

test('3.1 launch: over the diver cap both go back to form (that cycle passes); a partner not in form means a lone dive with no line', () => {
  {
    const { sim, S, a, b } = launched(0);
    const max = S.maxDivers(sim.enemies.length);
    // fill the diver count so the pick fits but its partner does not: picked + (max - 1) others = max
    let n = 0; for (const e of sim.enemies) if (n < max - 1 && e.type === 'moth' && e.st === 'form') { e.st = 'tele'; e.tele = 999; n++; }
    step(sim);
    assert.equal(a.st, 'form'); assert.equal(b.st, 'form'); assert.equal(a.tele, 0); assert.equal(a.hunt, 0);
    assert.equal(S.tethers.dive[0], 0);
  }
  {
    const { sim, S, a, b } = launched(0);
    b.st = 'join';
    step(sim);
    assert.equal(a.st, 'tele'); assert.notEqual(b.st, 'tele');
    assert.equal(S.tethers.dive[0], DIVE_SOLO); assert.equal(S.tethers.phase[0], LINE_GONE);
    // the lone dive keeps no line even after the partner settles back in form
    let g = 0, sawLine = false; while (a.st !== 'join' && g++ < 600) { keepQuiet(S); step(sim); if (S.tethers.phase[0] !== LINE_GONE && (a.st === 'tele' || a.st === 'dive')) sawLine = true; }
    assert.equal(sawLine, false);
  }
});

// record each member's dive control points by wrapping S.startDive
function captureCp(S) {
  const cp = new Map(), orig = S.startDive;
  S.startDive = (e, side, offx) => { orig(e, side, offx); cp.set(e, Array.from(S.diveCp)); };
  return cp;
}
test('3.1 spacing: control points from the 6th on (y 159 and below) are exactly 30 apart; before that the slot gap', (t) => {
  const { sim, S, a, b } = launched(0, 1, { shipX: 200 });
  const cp = captureCp(S);
  let g = 0; while (a.st !== 'dive' && g++ < 40) { keepQuiet(S); step(sim); }
  const A = cp.get(a), B = cp.get(b);
  assert.ok(A && B);
  const gaps = [];
  for (let i = 0; i < 9; i++) gaps.push(+(B[2 * i] - A[2 * i]).toFixed(9));
  for (let i = 5; i < 9; i++) { assert.equal(B[2 * i] - A[2 * i], 30, 'point ' + (i + 1)); assert.equal(A[2 * i + 1], B[2 * i + 1]); assert.ok(A[2 * i + 1] >= 159); }
  for (let i = 0; i < 5; i++) assert.ok(gaps[i] >= 24 && gaps[i] <= 28.5, `point ${i + 1} gap ${gaps[i]}`);
  t.diagnostic(`control point x gaps (ship x 200): ${gaps.join(', ')}; 6th point y ${A[11].toFixed(2)}`);
});

test('3.1 clamp edge (CUT box LOW): the cxl clamp collapses the 30 for a side -1 pair when ship x > 323 and a side +1 pair when < 77', (t) => {
  const lastGap = (k, shipX) => {
    const { sim, S, a, b } = launched(k, 1, { shipX });
    const cp = captureCp(S);
    let g = 0; while (a.st !== 'dive' && g++ < 40) { keepQuiet(S); S.player.x = shipX; step(sim); }
    const A = cp.get(a), B = cp.get(b);
    let min = Infinity; for (let i = 5; i < 9; i++) min = Math.min(min, B[2 * i] - A[2 * i]);
    return { side: a.teleSide, min };
  };
  const out = [];
  for (const [k, x] of [[0, 200], [0, 323], [0, 324], [0, 380], [1, 200], [1, 77], [1, 76], [1, 63], [1, 20]]) {
    const r = lastGap(k, x); out.push(`pair ${k} side ${r.side} ship ${x}: min gap ${+r.min.toFixed(6)}`);
    const collapses = r.side < 0 ? x > 323 : x < 77;
    if (collapses) assert.ok(r.min < 30, out[out.length - 1]); else assert.equal(r.min, 30, out[out.length - 1]);
  }
  t.diagnostic(out.join('; '));
});

// run a linked dive of pair k to its end, recording (phase, ym, both diving) after every frame
function lineAudit(k, seed) {
  const { sim, S, a, b } = launched(k, seed);
  const rec = [];
  for (let g = 0; g < 400; g++) {
    keepQuiet(S); step(sim);
    rec.push({ f: sim.frame, ph: S.tethers.phase[k], ym: (a.y + b.y) / 2, dive: a.st === 'dive' && b.st === 'dive', on: a.y <= 300 && b.y <= 300 });
    if (a.st === 'join' && b.st === 'join') break;
  }
  return rec;
}
test('3.1 Verify: line phase 0 while ym < 130, 1 for exactly 30 frames from the first ym >= 130, then 2 until ym > 290', (t) => {
  const lines = [];
  for (const [k, seed] of [[0, 1], [1, 1], [0, 2], [1, 3]]) {
    const rec = lineAudit(k, seed);
    const i0 = rec.findIndex(r => r.dive && r.ym >= 130);
    assert.ok(i0 > 0, 'the pair reached ym 130');
    for (let i = 0; i < i0; i++) assert.equal(rec[i].ph, LINE_FAINT, `frame ${rec[i].f} ym ${rec[i].ym}`);
    for (let i = i0; i < i0 + 30; i++) assert.equal(rec[i].ph, LINE_BLINKING, `blink frame ${i - i0}`);
    const i1 = rec.findIndex((r, i) => i >= i0 + 30 && (r.ym > 290 || !r.dive || !r.on));
    for (let i = i0 + 30; i < i1; i++) assert.equal(rec[i].ph, LINE_SOLID, `solid frame ${rec[i].f} ym ${rec[i].ym}`);
    for (let i = i1; i < rec.length; i++) assert.notEqual(rec[i].ph, LINE_SOLID);
    assert.equal(rec[i1].ph, LINE_GONE);
    lines.push(`pair ${k} seed ${seed}: blink at ym ${rec[i0].ym.toFixed(2)} for ${i0 + 30 - i0} frames, solid ${i1 - i0 - 30} frames, gone at ym ${rec[i1].ym.toFixed(2)}`);
  }
  t.diagnostic(lines.join('; '));
});

// a launched pair advanced until `until(phase, phaseT, ym)` holds, then the ship is put on the segment's midpoint
function atPhase(until, opts = {}) {
  const { sim, S, a, b } = launched(0, 1, { god: false });
  let g = 0;
  while (g++ < 400) { keepQuiet(S); step(sim); if (a.st === 'dive' && until(S.tethers.phase[0], S.tethers.phaseT[0], (a.y + b.y) / 2)) break; }
  const P = S.player;
  P.x = (a.x + b.x) / 2; P.y = (a.y + b.y) / 2; P.inv = 0;
  if (opts.halo) S.setPower('halo');
  return { sim, S, a, b, P };
}
test('3.1 Verify: a ship on the segment\'s midpoint dies only in phase 2', (t) => {
  const cases = [
    ['phase 0 (dive, ym < 120)', (ph, pt, ym) => ph === LINE_FAINT && ym > 90 && ym < 120, false],
    ['phase 1 (blink frame 15)', (ph, pt) => ph === LINE_BLINKING && pt === 15, false],
    ['phase 2 (solid frame 10)', (ph, pt) => ph === LINE_SOLID && pt === 10, true]
  ];
  const out = [];
  for (const [name, until, dies] of cases) {
    const { S, P } = atPhase(until);
    const before = S.deaths;
    tetherSys.step(S);
    assert.equal(S.deaths - before, dies ? 1 : 0, name);
    assert.equal(P.alive, !dies, name);
    out.push(`${name}: ${dies ? 'dies' : 'lives'}`);
  }
  t.diagnostic(out.join('; '));
  // the segment test itself: the nearest point of the segment, the bullet-point box 3.5 x 4.5
  assert.equal(lineTouch(100, 100, 140, 100, 120, 104.4), true);
  assert.equal(lineTouch(100, 100, 140, 100, 120, 104.6), false);
  assert.equal(lineTouch(100, 100, 140, 100, 143.4, 100), true);
  assert.equal(lineTouch(100, 100, 140, 100, 143.6, 100), false);
  assert.equal(lineTouch(100, 100, 100, 100, 101, 101), true, 'a zero-length segment is its point');
});

test('3.1 Verify: with HALO the line takes one charge and ignores the ship for 30 frames (wingmen are ignored, no graze)', (t) => {
  const { S, P, a, b } = atPhase((ph, pt) => ph === LINE_SOLID && pt === 5, { halo: true });
  assert.equal(S.haloHits, 3);
  const g0 = S.grazes;
  tetherSys.step(S);
  assert.equal(P.alive, true); assert.equal(S.haloHits, 2); assert.equal(S.tethers.ignoreT[0], 30);
  // the line holds still (only the system steps); 30 more frames on the line cost nothing
  for (let i = 0; i < 30; i++) { tetherSys.step(S); assert.equal(S.haloHits, 2, 'ignored frame ' + (i + 1)); }
  tetherSys.step(S);
  assert.equal(S.haloHits, 1, 'the 31st frame on the line takes the next charge');
  assert.equal(S.grazes, g0, 'the line never grazes');
  assert.equal(S.tethers.phase[0], LINE_SOLID);
  // a wingman sitting on the line is not touched
  const w = S.wingPool[0]; w.x = w.px = (a.x + b.x) / 2; w.y = w.py = (a.y + b.y) / 2; w.side = 1; w.ti = 0; w.T = a.T; S.wing.push(w);
  P.x = 20; P.y = 274;
  for (let i = 0; i < 5; i++) tetherSys.step(S);
  assert.equal(S.wing.length, 1);
  t.diagnostic('HALO on the solid line: charges 3 -> 2, then 30 ignored frames, then 2 -> 1');
});

test('3.1 Verify: after a break the survivor flies straight down at min(3.6, 1.5 * diveSpd()), x fixed, then rejoins its slot', (t) => {
  const out = [];
  for (const stage of [6, 8]) {
    const { sim, S, a, b } = launched(0, 1, { stage });
    let g = 0; while (g++ < 400) { keepQuiet(S); step(sim); if (S.tethers.phase[0] === LINE_BLINKING) break; }
    const ev = evs();
    S.kill(a);
    step(sim, 1, IDLE, ev);
    assert.ok(ev.sfx.includes(SFX_ID.snap), 'snap'); assert.ok(ev.fx.some(f => f[0] === FX_TETHER), 'FX_TETHER');
    const v = Math.min(3.6, 1.5 * S.diveSpd());
    assert.equal(b.tfall, 1); assert.equal(b.tv, v);
    assert.equal(S.tethers.phase[0], LINE_GONE);
    const x0 = b.x;
    let y = b.y, frames = 0;
    while (b.tfall && frames++ < 400) { keepQuiet(S); step(sim); if (b.tfall) { assert.equal(b.x, x0); assert.ok(Math.abs(b.y - y - v) < 1e-9, 'falls at ' + v); y = b.y; } }
    assert.equal(b.st, 'join', 're-enters from the top');
    g = 0; while (b.st !== 'form' && g++ < 600) { keepQuiet(S); step(sim); }
    assert.equal(b.st, 'form', 'joins its slot');
    out.push(`stage ${stage}: diveSpd ${S.diveSpd().toFixed(4)}, survivor speed ${v.toFixed(4)}`);
  }
  t.diagnostic(out.join('; '));
});

test('3.1 break by KINDLE (no kill event) also snaps the line; a kill in formation leaves a plain single diver', () => {
  {
    const { sim, S, a, b } = launched(0, 1);
    let g = 0; while (g++ < 400) { keepQuiet(S); step(sim); if (S.tethers.phase[0] === LINE_SOLID) break; }
    S.player.x = a.x; S.player.inv = 1e6; sim.fill();
    const ev = evs();
    step(sim, 1, packWord(0, false, false, true, false, 0), ev);
    assert.equal(S.wing.length, 1, 'KINDLE took a diver');
    assert.ok(a.dead !== b.dead, 'one member taken');
    assert.ok(ev.sfx.includes(SFX_ID.snap));
    assert.equal((a.dead ? b : a).tfall, 1);
  }
  {
    const { sim, S, a, b } = launched(0, 1);
    a.st = 'form'; a.tele = 0;
    S.kill(a); step(sim);
    assert.equal(S.tethers.phase[0], LINE_GONE);
    b.st = 'tele'; b.tele = TELE_DIVE; b.teleSide = -1; b.teleOff = 0;
    let g = 0; while (b.st !== 'join' && g++ < 600) { keepQuiet(S); step(sim); assert.equal(b.tfall, 0); assert.equal(S.tethers.phase[0], LINE_GONE); }
    assert.equal(b.teleOff, 0, 'a plain single diver: no pair offset');
  }
});

test('3.1 CUT: both killed within 30 frames of each other pays +1000 flat with POP_CUT and SFX cut; 31 frames apart does not', (t) => {
  const out = [];
  for (const d of [0, 1, 30, 31]) {
    const sim = toPlay(mk(6)), S = sim.ctx; formUp(sim);
    const [a, b] = pair(S, 1);
    S.diveTimer = 1e9;
    S.kill(a);
    if (d > 0) { step(sim, 1); for (let i = 1; i < d; i++) { keepQuiet(S); step(sim); } }
    const s0 = S.score, ev = evs();
    S.kill(b);
    const killPts = S.score - s0;
    step(sim, 1, IDLE, ev);
    const cut = ev.pop.find(p => p[0] === POP_CUT);
    if (d <= 30) {
      assert.equal(S.tethers.cuts, 1, 'CUT at ' + d);
      assert.ok(cut && cut[3] === 1000, 'popup value 1000');
      assert.ok(ev.sfx.includes(SFX_ID.cut));
      assert.equal(S.score - s0 - killPts, 1000, 'flat 1000 (loop 0)');
    } else {
      assert.equal(S.tethers.cuts, 0); assert.equal(cut, undefined); assert.ok(!ev.sfx.includes(SFX_ID.cut));
    }
    out.push(`${d} frames apart: ${S.tethers.cuts ? 'CUT +' + (cut ? cut[3] : '?') : 'no CUT'}`);
  }
  t.diagnostic(out.join('; '));
});

test('3.1 hash: the pair state is mixed into stateHash; stage 6 is deterministic', () => {
  const sim = toPlay(mk(6)), S = sim.ctx;
  const h0 = sim.stateHash();
  S.tethers.phaseT[0] += 1; assert.notEqual(sim.stateHash(), h0, 'phase frames'); S.tethers.phaseT[0] -= 1;
  S.tethers.ignoreT[1] = 3; assert.notEqual(sim.stateHash(), h0, 'ignore frames'); S.tethers.ignoreT[1] = 0;
  S.tethers.cutT[0] = 4; assert.notEqual(sim.stateHash(), h0, 'CUT frames'); S.tethers.cutT[0] = -1;
  S.tethers.phase[1] = LINE_SOLID; assert.notEqual(sim.stateHash(), h0, 'phase'); S.tethers.phase[1] = LINE_FAINT;
  const [a] = pair(S, 0); a.tfall = 1; assert.notEqual(sim.stateHash(), h0, 'survivor fall'); a.tfall = 0;
  assert.equal(sim.stateHash(), h0);
  const word = f => packWord(((f / 50 | 0) % 4) < 2 ? -1 : 1, f % 40 < 30, f % 10 === 0, f % 700 === 699, false, 0);
  const run = () => { const s = createSim({ seed: 5, mode: 'stage6' }); for (let f = 0; f < 4000 && !s.done; f++) { s.step(word(f)); s.clearEvents(); } return s.stateHash(); };
  assert.equal(run(), run());
});

// ================= 3.2 Hound =================

// stage 13 sim in play; each call to cull(n) kills n live enemies (not Cinders, so no embers)
function hound13(seed = 1, god = true) {
  const sim = toPlay(mk(13, seed, god)), S = sim.ctx;
  const cull = n => { let k = 0; for (const e of sim.enemies) { if (k >= n) break; if (!e.dead && e.type !== 'cinder') { S.kill(e); k++; } } };
  return { sim, S, H: S.hounds, cull };
}
const LEGAL = new Set(['0>1', '1>2', '2>3', '2>5', '3>4', '3>2', '4>2', '5>0']);

test('3.2 Verify: stage 13, god mode: no Hound before the live count reaches floor(N0 / 2); exactly 2; y at most 200; every change follows the table; the stage clears with a Hound alive', (t) => {
  const out = [];
  for (const seed of [1, 2, 3]) {
    const { sim, S, H, cull } = hound13(seed);
    const n0 = H.n0, half = Math.floor(n0 / 2);
    assert.ok(n0 >= 30, 'N0 ' + n0);
    let trigLive = -1, prevLive = -1, enters = 0, maxY = -Infinity, bad = [];
    const last = Array.from(H.st), seen = new Set();
    let f = 0;
    for (; f < 9000 && sim.stage === 13; f++) {
      if (!H.triggered && f % 25 === 0) cull(1);
      // move the ship back and forth so the Hounds chase, fire and time out
      const mv = ((f / 140 | 0) % 2) ? 1 : -1;
      const L0 = live(sim);
      step(sim, 1, packWord(f % 400 < 300 ? mv : 0, false, false, false, false, 0));
      if (H.triggered && trigLive < 0) { trigLive = live(sim); prevLive = L0; }
      if (!H.triggered) assert.equal(houndsLive(S), 0, 'no Hound before the trigger');
      for (let i = 0; i < HOUND_N; i++) {
        if (H.st[i] !== last[i]) {
          const k = last[i] + '>' + H.st[i];
          if (k === '0>1') enters++;
          if (!LEGAL.has(k)) bad.push(`frame ${sim.frame} hound ${i}: ${k}`);
          seen.add(k); last[i] = H.st[i];
        }
        if (H.st[i] !== H_OFF) maxY = Math.max(maxY, H.y[i]);
      }
      // once both have left, clear the stage
      if (H.triggered && f > 2500 && houndsLive(S) === 0 && H.hp[0] === 0 && H.hp[1] === 0) break;
    }
    assert.ok(H.triggered, 'triggered');
    assert.ok(trigLive <= half, `live count ${trigLive} at the trigger, floor(N0/2) ${half}`);
    assert.ok(prevLive > half || trigLive === prevLive, 'the trigger is the first frame at or under half');
    assert.equal(enters, 2, 'exactly 2 Hounds');
    assert.ok(maxY <= 200, 'max y ' + maxY);
    assert.deepEqual(bad, []);
    for (const k of ['0>1', '1>2', '2>3', '3>4', '4>2', '2>5', '5>0']) assert.ok(seen.has(k), `transition ${k} seen (seed ${seed})`);
    out.push(`seed ${seed}: N0 ${n0}, trigger at live ${trigLive} (half ${half}), Hounds ${enters}, max y ${maxY}, transitions ${[...seen].sort().join(' ')}`);
  }
  // the stage clears with a Hound alive; it is removed with no points
  {
    const { sim, S, H, cull } = hound13(4);
    let g = 0; while (H.st[0] !== H_SHADOW && g++ < 6000) { if (!H.triggered) cull(1); step(sim); }
    assert.equal(H.st[0], H_SHADOW);
    const kills = H.kills;
    for (const e of sim.enemies) if (!e.dead) S.kill(e);
    step(sim);
    assert.equal(sim.state, 'clear', 'clears with a Hound on screen');
    assert.equal(houndsLive(S), 0); assert.equal(H.kills, kills, 'no Hound kill points');
    out.push('stage clears with a Hound in state 2: yes, removed');
  }
  t.diagnostic(out.join('; '));
});

test('3.2 entry sides (CUT box): Hound A enters at x 20, B at x 380 sixty twist steps later, both from y -10, straight down at 1.2 to y 190', (t) => {
  const { sim, S, H, cull } = hound13(1);
  let g = 0; while (!H.triggered && g++ < 6000) { cull(1); step(sim); }
  const tA = S.twistT;
  assert.equal(H.st[0], H_ENTER); assert.equal(H.x[0], 20); assert.equal(H.y[0], -10);
  assert.equal(H.st[1], H_OFF); assert.equal(H.hp[1], 3);
  let tB = -1, yA = H.y[0];
  while (g++ < 6000 && tB < 0) {
    const t0 = S.twistT; step(sim);
    if (S.twistT > t0 && H.st[0] === H_ENTER) { assert.ok(Math.abs(H.y[0] - yA - 1.2) < 1e-9); }
    yA = H.y[0];
    if (H.st[1] === H_ENTER && tB < 0) tB = S.twistT;
  }
  assert.equal(tB - tA, 60);
  assert.equal(H.x[1], 380); assert.equal(H.y[1], -10);
  while (H.st[1] === H_ENTER && g++ < 9000) step(sim);
  assert.equal(H.y[0], 190); assert.equal(H.y[1], 190);
  t.diagnostic(`A enters at (${20}, -10) on twist step ${tA}; B at (380, -10) on step ${tB} (+${tB - tA}); both stop at y 190`);
});

test('3.2 Verify: god off and the ship still, the Hound\'s first bullet passes within 3 units of the ship\'s x and hits it', (t) => {
  const out = [];
  for (const shipX of [200, 120, 330]) {
    const { sim, S, H } = hound13(1, false);
    formUp(sim);
    S.player.x = S.player.px = shipX;
    const n0 = H.n0;
    // kill down to half without Cinders (no embers); random dives stopped
    for (const e of sim.enemies) if (live(sim) > (n0 >> 1) && e.type !== 'cinder' && !e.dead) S.kill(e);
    let first = null, g = 0;
    while (S.deaths === 0 && g++ < 3000) {
      S.diveTimer = 1e9;
      step(sim);
      if (!first) for (const b of sim.eb) if (b.on && b.vx === 0 && b.vy === 2.2) { first = { x: b.x, b }; break; }
    }
    assert.ok(first, 'a Hound fired');
    assert.ok(Math.abs(first.x - shipX) < 3, `bullet x ${first.x} vs ship ${shipX}`);
    assert.equal(S.deaths, 1, 'the bullet hit the ship');
    assert.equal(first.b.on, false);
    for (const b of sim.eb) if (b.on) assert.equal(b.vy, 2.2, 'only Hound bullets in play');
    out.push(`ship x ${shipX}: first bullet x ${first.x.toFixed(3)} (|dx| ${Math.abs(first.x - shipX).toFixed(3)}), ship hit`);
  }
  t.diagnostic(out.join('; '));
});

// a stage 13 sim with Hound A in state 2 at x and the ship at shipX for > 30 twist steps (dives stopped)
function shadowing(shipX = 200, god = true) {
  const { sim, S, H, cull } = hound13(1, god);
  formUp(sim);
  let g = 0; while (!H.triggered && g++ < 6000) { cull(1); S.diveTimer = 1e9; S.player.x = shipX; step(sim); }
  while (H.st[0] !== H_SHADOW && g++ < 9000) { S.diveTimer = 1e9; S.player.x = shipX; step(sim); }
  return { sim, S, H };
}

test('3.2 timers count twist steps only: a Hound freezes while the ship is dead and in hit-stop; its bullets freeze in hit-stop and fly while the ship is dead', (t) => {
  const { sim, S, H } = shadowing(200, false);
  // wait for a bullet in flight
  let g = 0, b = null;
  while (!b && g++ < 3000) { S.diveTimer = 1e9; S.player.x = 300; S.player.inv = 1e6; step(sim); b = sim.eb.find(q => q.on && q.vy === 2.2); }
  assert.ok(b, 'a Hound bullet in flight');
  // hit-stop: everything frozen, the bullet too
  const snap = () => JSON.stringify([Array.from(H.st), Array.from(H.f), Array.from(H.x), Array.from(H.y), Array.from(H.life), Array.from(H.cd), H.ri]);
  const s0 = snap(), by = b.y, tw = S.twistT;
  S.hitstop = 5; step(sim, 5);
  assert.equal(snap(), s0, 'Hounds frozen in hit-stop'); assert.equal(b.y, by, 'Hound bullet frozen in hit-stop'); assert.equal(S.twistT, tw);
  // ship dead: Hounds frozen, bullets keep moving
  S.player.inv = 0; S.playerDie();
  const s1 = snap(), by1 = b.y;
  let moved = false, frames = 0;
  // the frame that turns 'ready' into 'play' is a twist step (B.11 0.1), so the check stops there
  while (frames++ < 600) { step(sim); if (sim.state === 'play') break; assert.equal(snap(), s1, 'frozen in ' + sim.state); if (b.on && b.y !== by1) moved = true; }
  assert.equal(sim.state, 'play');
  assert.ok(moved || !b.on, 'the bullet flew on while the ship was dead');
  t.diagnostic(`frozen through 5 hit-stop frames and ${frames} dead frames; bullet y ${by} held in hit-stop`);
});

test('3.2 shadow: tx is the ship x 30 twist steps ago (32-slot ring, after the Undertow pull), clamped to 10..390; B holds within 16 of A', (t) => {
  const { sim, S, H } = shadowing(200);
  const hist = [];
  let checks = 0;
  for (let g = 0; g < 400; g++) {
    S.diveTimer = 1e9; const t0 = S.twistT, was = H.st[0];
    step(sim, 1, packWord(Math.sin(g * 0.05) > 0 ? 1 : -1, false, false, false, false, 0));
    if (S.twistT === t0) continue;
    hist.push(S.player.x);
    // tx is taken on a step that starts in state 2
    if (hist.length > 30 && was === H_SHADOW && H.st[0] !== H_LEAVE) { assert.equal(H.tx[0], Math.max(10, Math.min(390, hist[hist.length - 31]))); checks++; }
  }
  assert.ok(checks > 100, 'checked ' + checks);
  // hold rule: both shadowing within 16 units: B keeps its x, A moves
  H.st[0] = H.st[1] = H_SHADOW; H.hp[0] = H.hp[1] = 3; H.x[0] = 100; H.x[1] = 110; H.y[0] = H.y[1] = 190; H.cd[0] = H.cd[1] = 50; H.life[0] = H.life[1] = 0;
  H.ring.fill(300);
  S.diveTimer = 1e9; let t0 = S.twistT; step(sim); assert.equal(S.twistT, t0 + 1);
  assert.equal(H.x[1], 110, 'B holds'); assert.ok(Math.abs(H.x[0] - 101.2) < 1e-9, 'A moves 1.2');
  H.x[0] = 80; S.diveTimer = 1e9; step(sim);
  assert.ok(Math.abs(H.x[1] - 111.2) < 1e-9, 'B moves once 16 or more apart');
  // clamp
  H.ring.fill(2); S.diveTimer = 1e9; step(sim); assert.equal(H.tx[0], 10);
  t.diagnostic(`tx matched the ship x 30 twist steps earlier on ${checks} steps; hold and clamp checked`);
});

test('3.2 fire: 20-step glow with x frozen, second bullet 8 steps later in the same column, cooldown 70; no room = wait up to 30 then skip', (t) => {
  const { sim, S, H } = shadowing(200);
  let g = 0;
  const twistStep = () => { const t0 = S.twistT; while (S.twistT === t0 && g++ < 20000) { S.diveTimer = 1e9; S.player.x = 200; S.player.inv = 1e6; step(sim); } };
  while (H.st[0] !== H_GLOW && g < 20000) twistStep();
  assert.equal(H.st[0], H_GLOW);
  const gx = H.x[0];
  let steps = 0; const n0 = sim.eb.filter(b => b.on).length;
  while (H.st[0] === H_GLOW) { twistStep(); steps++; assert.equal(H.x[0], gx); }
  assert.equal(steps, 20, 'glow 20 twist steps');
  const b1 = sim.eb.filter(b => b.on && b.vy === 2.2 && b.vx === 0);
  assert.equal(H.st[0], H_SECOND); assert.ok(b1.length >= 1);
  steps = 0; while (H.st[0] === H_SECOND) { twistStep(); steps++; assert.equal(H.x[0], gx); }
  assert.equal(steps, 8, 'second bullet 8 steps later');
  const col = sim.eb.filter(b => b.on && b.vy === 2.2 && b.x === gx);
  assert.ok(col.length >= 2, 'two bullets in the same column');
  assert.equal(H.st[0], H_SHADOW); assert.equal(H.cd[0], 70);
  // volley wait: the cap is full, so the glow waits 30 steps, then the volley is skipped
  while (H.st[0] !== H_GLOW && g < 20000) twistStep();
  for (const b of sim.eb) b.on = false;
  for (let i = 0; i < S.D.cap; i++) { const b = sim.eb[i]; b.on = true; b.x = b.px = 4 + i; b.y = b.py = 4; b.vx = 0; b.vy = 0; }
  const before = sim.eb.filter(b => b.on).length;
  steps = 0; while (H.st[0] === H_GLOW) { twistStep(); steps++; }
  assert.equal(steps, 50, '20 glow + 30 waiting steps');
  assert.equal(H.st[0], H_SHADOW); assert.equal(sim.eb.filter(b => b.on).length, before, 'no Hound bullet');
  t.diagnostic(`glow 20, gap 8, cooldown 70, full cap: skipped after 20 + 30 steps (cap ${S.D.cap}); ${n0} bullets before`);
});

test('3.2 damage: 3 hits, every shot used up (LANCE too) and counted as a hit; the kill is pieceKill(800): chain +1, window 90, feel big', (t) => {
  const { sim, S, H } = shadowing(200);
  S.setPower('lance');
  const hit = () => { const p = S.shot(H.x[0], H.y[0] + 6.5 + 3); p.pierce = 2; p.pw = 'lance'; const h0 = S.hits; S.diveTimer = 1e9; step(sim); return { p, dh: S.hits - h0 }; };
  let r = hit(); assert.equal(r.p.on, false); assert.equal(r.dh, 1); assert.equal(H.hp[0], 2);
  r = hit(); assert.equal(H.hp[0], 1);
  const chain = S.chain, score = S.score;
  r = hit();
  assert.equal(H.hp[0], 0); assert.equal(H.st[0], H_OFF); assert.equal(H.kills, 1);
  assert.equal(S.chain, chain + 1); assert.equal(S.chainT, 90); assert.equal(S.hitstop, 3, 'feel big');
  assert.ok(S.score - score >= 800, 'kill points ' + (S.score - score));
  // a dead Hound never comes back
  for (let i = 0; i < 2000; i++) { S.diveTimer = 1e9; step(sim); assert.equal(H.st[0], H_OFF); }
  t.diagnostic(`kill paid ${score === S.score ? 0 : 'kill points'}; chain ${chain} -> ${chain + 1}, window 90, hit-stop 3`);
});

test('3.2 life: 600 twist steps from entering state 1, checked only in state 2; then it leaves up at 1.2 with no points and is gone', (t) => {
  const { sim, S, H } = shadowing(200);
  let g = 0, prev = H.st[0], leaveLife = -1, from = -1;
  const score = () => S.score;
  while (H.st[0] !== H_OFF && g++ < 20000) {
    S.diveTimer = 1e9; S.player.inv = 1e6;
    step(sim, 1, packWord(((g / 90 | 0) % 2) ? 1 : -1, false, false, false, false, 0));
    if (H.st[0] !== prev) { if (H.st[0] === H_LEAVE) { leaveLife = H.life[0]; from = prev; } prev = H.st[0]; }
  }
  assert.equal(from, H_SHADOW); assert.ok(leaveLife >= 600, 'life ' + leaveLife);
  assert.equal(H.kills, 0); assert.equal(H.hp[0], 0);
  const s0 = score();
  for (let i = 0; i < 1500; i++) { S.diveTimer = 1e9; step(sim); assert.equal(H.st[0], H_OFF); }
  assert.equal(score(), s0);
  t.diagnostic(`left from state 2 at life ${leaveLife}`);
});

test('3.2 Hounds live in their own pool: never in enemies, never in the diver count; the hash mixes their state', () => {
  const { sim, S, H, cull } = hound13(2);
  let g = 0; while (!H.triggered && g++ < 6000) { cull(1); step(sim); }
  const n = sim.enemies.length;
  step(sim);
  assert.ok(sim.enemies.length <= n, 'no enemy added');
  const h0 = sim.stateHash();
  H.x[0] += 1; assert.notEqual(sim.stateHash(), h0); H.x[0] -= 1;
  H.ring[7] += 1; assert.notEqual(sim.stateHash(), h0); H.ring[7] -= 1;
  H.vWait[1] = 2; assert.notEqual(sim.stateHash(), h0); H.vWait[1] = 0;
  assert.equal(sim.stateHash(), h0);
  // other stages never trigger
  const s12 = toPlay(mk(12)); const S12 = s12.ctx;
  for (const e of s12.enemies) S12.kill(e);
  step(s12, 5);
  assert.equal(S12.hounds.triggered, 0);
});
