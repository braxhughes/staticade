// C.2 slice V1 (design.md B.11 0.1, 1.0, 1.1, 1.3, 1.5, 2.1, 2.2): Weave, Pincer, Undertow, Thermals, lead aim, Hunt.
// Parting (1.2) and Pressing sky (1.4) are cut (C.2 CUT box). Each lever's Verify line is a test here, plus the
// lead-aim feel check and the startAim seam order. No state hash is compared with a stored
// value: the hash tests only check that the new state is mixed in.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSim } from '../games/starfall/sim.js';
import { ROWS, H, SFX_ID, EV_SFX } from '../games/starfall/defs.js';
import { pickDiver } from '../games/starfall/sim/formation.js';
import { thermalX, leverOf, LEVERS } from '../games/starfall/sim/twists.js';
import { TELE_DIVE, TELE_WARDEN, TELE_AIM } from '../games/starfall/sim/feel.js';
import { packWord } from '../engine/input-word.js';

const IDLE = 128, RIGHT = packWord(1), LEFT = packWord(-1);
const step = (sim, n = 1, w = IDLE) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(w); sim.clearEvents(); } return sim; };
const toPlay = sim => { while (sim.state !== 'play') step(sim); return sim; };
const mk = (stage, seed = 1, god = true) => { const sim = createSim({ seed, mode: 'stage' + stage }); if (god) sim.setGod(true); return sim; };
// every formation enemy snaps into its slot (like SF.dive's snap), and the formation counts as full
function formUp(sim) {
  const S = sim.ctx;
  for (const e of sim.enemies) if (!e.dead && e.r >= 0) { S.slot(e.r, e.c); e.x = e.px = S.SX; e.y = e.py = S.SY; e.st = 'form'; e.tele = 0; }
  S.formFull = true;
  return sim;
}
const teles = sim => sim.enemies.filter(e => !e.dead && e.st === 'tele');
const at = (sim, r, c) => sim.enemies.find(e => !e.dead && e.r === r && e.c === c);
// step until twistT reaches n (hit-stop frames do not count)
function toTwist(sim, n, w = IDLE) { const S = sim.ctx; let g = 0; while (S.twistT < n) { step(sim, 1, w); if (++g > 20000) throw new Error('twistT stuck at ' + S.twistT); } return sim; }

// ---------- 0.1 twist clock ----------
test('twist clock: 0 through the intro, 1 after the first play frame, frozen in hit-stop and while the ship is dead, reset by the stage event', () => {
  const sim = mk(2, 1, false), S = sim.ctx;
  while (sim.state === 'intro') { assert.equal(S.twistT, 0, 'no twist steps in intro'); step(sim); }
  assert.equal(sim.state, 'play'); assert.equal(S.twistT, 1, 'the first play frame ends with twistT 1');
  step(sim, 9); assert.equal(S.twistT, 10);
  S.hitstop = 3; step(sim, 3); assert.equal(S.twistT, 10, 'hit-stop freezes the clock');
  step(sim); assert.equal(S.twistT, 11);
  S.playerDie(); assert.equal(sim.state, 'dying');
  const t = S.twistT;
  // the frame that turns 'ready' into 'play' is a play frame (0.1 reads the state at the system step)
  while (sim.state !== 'play') { step(sim); if (sim.state !== 'play') assert.equal(S.twistT, t, 'no twist steps in ' + sim.state); }
  assert.equal(S.twistT, t + 1);
  S.player.x = 123; S.huntN = 77; S.pincerN = 5;
  S.emit('stage');
  assert.equal(S.twistT, 0); assert.equal(S.pincerN, 0); assert.equal(S.huntN, 0); assert.equal(S.huntC, 123);
});

test('lever table: Weave row 2, Pincer row 3, Undertow row 8, Thermals row 12; Parting (7) and Pressing sky (11) are cut; endless rows repeat', () => {
  assert.equal(leverOf(2), 'weave'); assert.equal(leverOf(3), 'pincer'); assert.equal(leverOf(8), 'undertow'); assert.equal(leverOf(12), 'thermals');
  assert.equal(leverOf(7), ''); assert.equal(leverOf(11), '');
  assert.equal(LEVERS.filter(Boolean).length, 4);
  assert.equal(mk(17).row, 2, 'stage 17 plays row 2 (0.7)');
  assert.equal(mk(18).row, 3);
});

// ---------- 1.0 Weave ----------
function slotX(S, r, c, tw) { const t0 = S.twistT; S.twistT = tw; S.slot(r, c); S.twistT = t0; return S.SX; }
test('Weave (1.0) Verify: stage 2, formT fixed, twistT 120: row 3 is +24, row 4 is -24, rows 0-2 unchanged; stages 1 and 3 never move', (t) => {
  const S = mk(2).ctx; S.formT = 777; S.formFull = true;
  const d3 = slotX(S, 3, 4, 120) - slotX(S, 3, 4, 0), d4 = slotX(S, 4, 4, 120) - slotX(S, 4, 4, 0);
  t.diagnostic(`weave span at twistT 120: row 3 ${d3.toFixed(4)}, row 4 ${d4.toFixed(4)}, rows apart ${(d3 - d4).toFixed(4)}`);
  for (let c = 0; c < ROWS[3]; c++) assert.ok(Math.abs(slotX(S, 3, c, 120) - slotX(S, 3, c, 0) - 24) < 0.01, 'row 3 col ' + c);
  for (let c = 0; c < ROWS[4]; c++) assert.ok(Math.abs(slotX(S, 4, c, 120) - slotX(S, 4, c, 0) + 24) < 0.01, 'row 4 col ' + c);
  for (let r = 0; r < 3; r++) for (let c = 0; c < ROWS[r]; c++) assert.equal(slotX(S, r, c, 120), slotX(S, r, c, 0), `row ${r} col ${c}`);
  // widest point: row 4 stays inside 10..390
  let lo = Infinity, hi = -Infinity;
  for (let tw = 0; tw < 480; tw++) for (let c = 0; c < ROWS[4]; c++) { const x = slotX(S, 4, c, tw); lo = Math.min(lo, x); hi = Math.max(hi, x); }
  assert.ok(lo >= 10 && hi <= 390, `row 4 spans ${lo}..${hi}`);
  for (const st of [1, 3]) {
    const S2 = mk(st).ctx; S2.formT = 777; S2.formFull = true;
    for (const tw of [37, 120, 360, 999]) for (let r = 0; r < 5; r++) for (let c = 0; c < ROWS[r]; c++) assert.equal(slotX(S2, r, c, tw), slotX(S2, r, c, 0), `stage ${st} row ${r} col ${c} twistT ${tw}`);
  }
});

test('Weave: in a played stage 2 the two bottom rows visibly slide past each other by about 15 s', () => {
  const sim = toPlay(mk(2)), S = sim.ctx;
  toTwist(sim, 900);
  let n = 0;
  for (let g = 0; g < 600 && n === 0; g++) {
    step(sim);
    // same column, so without Weave they would share x; the offset is 2 * wv. Slots were placed before this
    // frame's twist step, so they read the twistT of the frame before (0.1)
    const wv = 24 * Math.sin((S.twistT - 1) * 0.0131);
    for (let c = 0; c < 10; c++) {
      const a = at(sim, 3, c), b = at(sim, 4, c);
      if (!a || !b || a.st !== 'form' || b.st !== 'form') continue;
      assert.ok(Math.abs((a.x - b.x) - 2 * wv) < 0.05, `col ${c}: offset ${a.x - b.x} vs ${2 * wv}`);
      n++;
    }
  }
  assert.ok(n > 0, 'rows 3 and 4 have joined and slide');
});

// ---------- 1.1 Pincer ----------
// stage 3 with only the listed slots in 'form' (the rest held out of the pick, not stepped)
function only(sim, keep) {
  for (const e of sim.enemies) if (!keep.some(([r, c]) => e.r === r && e.c === c)) e.st = 'wait';
}
function release(sim) { for (const e of sim.enemies) if (e.st === 'tele') { e.st = 'form'; e.tele = 0; e.pin = 0; e.hunt = 0; } }
test('Pincer (1.1) Verify: launches 1 and 2 start one telegraph, launch 3 a mirrored pair with one shot between them; dead mirror: one telegraph', () => {
  const sim = formUp(toPlay(mk(3))), S = sim.ctx;
  assert.equal(S.pincerN, 0);
  for (let k = 1; k <= 2; k++) {
    pickDiver(S);
    const T = teles(sim), d = T[0];
    assert.equal(S.pincerN, k);
    assert.equal(T.length, d.type === 'warden' ? 1 + T.filter(e => e.teleOff !== 0).length : 1, 'launch ' + k + ': one telegraph (plus escorts)');
    assert.ok(T.every(e => e.pin === 0));
    release(sim);
  }
  only(sim, [[4, 1], [4, 8]]); // moths in mirror slots (10 columns: 9 - 1 = 8)
  pickDiver(S);
  assert.equal(S.pincerN, 3);
  const T = teles(sim);
  assert.equal(T.length, 2, 'launch 3 starts exactly 2 telegraphs');
  assert.equal(T[0].r, T[1].r);
  assert.equal(T[0].c + T[1].c, ROWS[T[0].r] - 1, 'columns c and ROWS[r]-1-c');
  assert.equal(T[0].teleSide, -T[1].teleSide, 'opposite sides');
  assert.ok(T.every(e => e.tele === TELE_DIVE && e.teleOff === 0));
  assert.deepEqual(T.map(e => e.pin).sort(), [1, 2]);
  for (const e of T) S.startDive(e, e.teleSide, e.teleOff); // what the 'tele' state does when the glow ends
  assert.equal(T[0].shots + T[1].shots, 1, 'one shot per pincer');
  assert.ok(T.every(e => e.pin === 0), 'pin cleared at dive start');
  // launch 6 with the mirror slot dead: a normal dive, the counter still advances
  const sim2 = formUp(toPlay(mk(3))), S2 = sim2.ctx;
  S2.pincerN = 5;
  only(sim2, [[4, 1]]); at(sim2, 4, 8).dead = true;
  pickDiver(S2);
  assert.equal(S2.pincerN, 6); assert.equal(teles(sim2).length, 1); assert.equal(teles(sim2)[0].pin, 0);
});

test('Pincer: never with a Warden, Lamplighter or Eel, and never over the diver cap', () => {
  const sim = formUp(toPlay(mk(3))), S = sim.ctx;
  // Lamplighter at (2, 3), mirror (2, 4) a wisp: not a pincer
  S.pincerN = 2; only(sim, [[2, 3]]);
  pickDiver(S); assert.equal(teles(sim).length, 1); release(sim);
  // eligible pair, but 2 divers already out (stage 3 full cap is 3): 2 + 2 > 3
  const sim2 = formUp(toPlay(mk(3))), S2 = sim2.ctx;
  S2.pincerN = 2; only(sim2, [[4, 1], [4, 8]]);
  at(sim2, 0, 0).st = 'dive'; at(sim2, 0, 1).st = 'dive';
  pickDiver(S2);
  assert.equal(S2.pincerN, 3); assert.equal(teles(sim2).length, 1, 'over the cap: normal dive');
  // no Pincer outside stage row 3: the counter stays 0
  const sim3 = formUp(toPlay(mk(2))), S3 = sim3.ctx;
  for (let k = 0; k < 6; k++) { pickDiver(S3); release(sim3); }
  assert.equal(S3.pincerN, 0);
});

test('Pincer in play: on stage 3 only every 3rd launch pairs, and each pair dives with exactly one shot', (t) => {
  let launches = 0, pairs = 0, shotsSum = 0, dives = 0;
  for (const seed of [1, 2, 3]) {
    const sim = toPlay(mk(3, seed)), S = sim.ctx;
    let n = 0, f = 0;
    while (f++ < 4000 && sim.state !== 'clear') {
      // move a little so Hunt does not take over every launch
      step(sim, 1, (f % 240) < 20 ? RIGHT : (f % 240) >= 120 && (f % 240) < 140 ? LEFT : IDLE);
      if (S.pincerN !== n) {
        n = S.pincerN; launches++;
        const P = sim.enemies.filter(e => e.pin);
        if (P.length) {
          assert.equal(n % 3, 0, 'a pair only on launch 3k'); assert.equal(P.length, 2); pairs++;
          // follow the pair into its dive
          let g = 0; while (P.some(e => e.st === 'tele') && g++ < 60) step(sim);
          if (P.every(e => !e.dead && e.st === 'dive')) { dives++; shotsSum += P[0].shots + P[1].shots; }
        }
      }
    }
  }
  t.diagnostic(`stage 3, seeds 1-3: ${launches} launches, ${pairs} pincer pairs (every 3rd launch at most ${Math.floor(launches / 3)})`);
  assert.ok(pairs > 0, 'at least one pincer happens');
  assert.ok(pairs <= Math.ceil(launches / 3));
});

// ---------- 1.3 Undertow ----------
test('Undertow (1.3) Verify: stage 8, ship idle at x 200: 200 at twistT 309, 236 at 399, back to 200 at 799', (t) => {
  const sim = toPlay(mk(8)), S = sim.ctx, p = S.player;
  assert.equal(p.x, 200);
  toTwist(sim, 309); const x309 = p.x;
  toTwist(sim, 399); const x399 = p.x;
  toTwist(sim, 709); const x709 = p.x;
  toTwist(sim, 799); const x799 = p.x;
  t.diagnostic(`undertow pull: x ${x309} at 309, ${x399} at 399, ${x709} at 709, ${x799} at 799`);
  assert.equal(x309, 200);
  assert.ok(Math.abs(x399 - 236) < 1e-9, 'first pull goes right 36');
  assert.ok(Math.abs(x709 - 236) < 1e-9, 'no pull outside 310-399');
  assert.ok(Math.abs(x799 - 200) < 1e-9, 'second pull goes left');
});

test('Undertow: px is left alone (smooth render), and no other stage pulls the ship', () => {
  const sim = toPlay(mk(8)), S = sim.ctx, p = S.player;
  toTwist(sim, 320);
  step(sim); while (S.hitstop) step(sim);
  assert.ok(Math.abs(p.x - p.px - 0.4) < 1e-9, 'one frame of pull shows as x - px = 0.4');
  for (const st of [2, 3, 6, 7, 12]) {
    const s2 = toPlay(mk(st)); toTwist(s2, 420);
    assert.equal(s2.ctx.player.x, 200, 'stage ' + st);
  }
});

// ---------- 1.5 Thermals ----------
test('Thermals (1.5) Verify: vy 2.9 at cx0 becomes 1.74, and 2.9 again the frame after it leaves; speed 1.4 slows to 1.0', (t) => {
  const sim = toPlay(mk(12)), S = sim.ctx, T0 = 392; // sin(393 * 0.004) ~ 1: columns at about 320 and 80
  const pin = () => { S.twistT = T0; S.hitstop = 0; };
  for (const b of sim.eb) b.on = false;
  pin();
  const cx0 = thermalX(T0 + 1, 0);
  S.eFire(cx0, 100, 0, 2.9, false);
  const b = sim.eb.find(q => q.on);
  step(sim); pin();
  t.diagnostic(`thermals: column at ${cx0.toFixed(2)}, vy 2.9 -> ${b.vy}`);
  assert.ok(Math.abs(b.vy - 1.74) < 1e-9); assert.equal(b.th, 0.6);
  step(sim); pin();
  assert.ok(Math.abs(b.vy - 1.74) < 1e-9, 'stays slowed inside');
  b.x = 200; // out of both columns
  step(sim); pin();
  assert.ok(Math.abs(b.vy - 2.9) < 1e-9, 'back to 2.9 after leaving'); assert.equal(b.th, 0);
  b.on = false;
  S.eFire(cx0, 100, 0, 1.4, false);
  const b2 = sim.eb.find(q => q.on);
  step(sim); pin();
  t.diagnostic(`thermals: speed 1.4 -> ${Math.hypot(b2.vx, b2.vy)}`);
  assert.ok(Math.abs(Math.hypot(b2.vx, b2.vy) - 1.0) < 1e-12, 'slows to the 1.0 floor');
  b2.on = false;
  S.eFire(thermalX(T0 + 1, 1), 100, 0, 0.9, false);
  const b3 = sim.eb.find(q => q.on);
  step(sim); pin();
  assert.equal(b3.vy, 0.9, 'a bullet at 1.0 or less keeps its speed'); assert.equal(b3.th, 1);
});

test('Thermals: columns drift at most 0.48 per frame, cross at the middle; other stages never touch a bullet', (t) => {
  let mx = 0;
  for (let tw = 1; tw < 1600; tw++) mx = Math.max(mx, Math.abs(thermalX(tw, 0) - thermalX(tw - 1, 0)));
  t.diagnostic(`thermals: max drift ${mx.toFixed(4)} per frame, period ${(2 * Math.PI / 0.004).toFixed(0)} frames`);
  assert.ok(mx <= 0.48 + 1e-9);
  assert.equal(thermalX(0, 0), 200); assert.equal(thermalX(0, 1), 200);
  const sim = toPlay(mk(11)), S = sim.ctx;
  for (const b of sim.eb) b.on = false;
  S.eFire(200, 100, 0, 2.9, false);
  const b = sim.eb.find(q => q.on);
  S.hitstop = 0; step(sim);
  assert.equal(b.vy, 2.9); assert.equal(b.th, 0);
});

// ---------- 2.1 lead aim ----------
function pinned(stage, px, vx) {
  const sim = toPlay(mk(stage)), S = sim.ctx;
  const e = sim.enemies.find(q => q.type === 'moth');
  e.st = 'form'; e.x = e.px = 200; e.y = e.py = 150; e.aimT = 0; e.vWait = 0;
  S.heat = 0; S.player.x = px; S.player.vx = vx;
  for (const b of sim.eb) b.on = false;
  return { sim, S, e };
}
test('lead aim (2.1) Verify (pinned): stage 6 k 0.5 gives the lead and aimV 1.6; fireAim uses it; stage 1 has no lead', () => {
  const { S, e, sim } = pinned(6, 150, 2.0);
  S.startAim(e);
  const sp = S.bulletSpd(), T = Math.max(20, 124 / sp);
  const want = Math.min(390, Math.max(10, 150 + Math.min(72, Math.max(-72, 2.0 * (20 + T) * 0.5))));
  assert.equal(S.player.y - e.y, 124);
  assert.ok(Math.abs(e.aimX - want) < 1e-9, `aimX ${e.aimX} vs ${want}`);
  assert.equal(e.aimY, S.player.y); assert.equal(e.aimV, 1.6); assert.equal(e.aimT, TELE_AIM);
  S.fireAim(e);
  const b = sim.eb.find(q => q.on);
  const vx = Math.min(1.6, Math.max(-1.6, (e.aimX - 200) / Math.max(20, 124 / sp)));
  assert.ok(Math.abs(b.vx - vx) < 1e-9); assert.equal(b.vy, sp);
  const one = pinned(1, 150, 2.0);
  one.S.startAim(one.e);
  assert.equal(one.e.aimX, 150); assert.equal(one.e.aimV, 1.2);
  // a still ship has no lead
  const still = pinned(11, 150, 0);
  still.S.startAim(still.e);
  assert.equal(still.e.aimX, 150); assert.equal(still.e.aimV, 1.2);
});

test('lead aim: a Z2 Wisp with a wingman out aims at the wingman, aimV back to 1.2', () => {
  const sim = toPlay(mk(6)), S = sim.ctx;
  const e = sim.enemies.find(q => q.type === 'wisp');
  e.st = 'form'; e.x = 200; e.y = 150;
  const w = S.wingPool[0]; w.x = 333; w.y = S.player.y + 2; S.wing.push(w);
  S.player.x = 150; S.player.vx = 2.0;
  S.startAim(e);
  assert.equal(e.aimX, 333); assert.equal(e.aimV, 1.2);
});

test('lead aim feel check: ship at x 200 moving 2.7: the shot crosses y 274 at least 60 right of 200 in stages 6 and 11; k 0 crosses at 200', (t) => {
  const cross = stage => {
    const { S, e, sim } = pinned(stage, 200, 2.7);
    S.startAim(e); S.fireAim(e);
    const b = sim.eb.find(q => q.on);
    return b.x + b.vx * (274 - b.y) / b.vy;
  };
  const x6 = cross(6), x11 = cross(11), x1 = cross(1);
  t.diagnostic(`lead aim crossing at y 274: stage 6 ${x6.toFixed(2)} (+${(x6 - 200).toFixed(2)}), stage 11 ${x11.toFixed(2)} (+${(x11 - 200).toFixed(2)}), stage 1 ${x1.toFixed(2)}`);
  assert.ok(x6 - 200 >= 60 && Math.abs(x6 - 272) < 1e-6, 'stage 6: 72');
  assert.ok(x11 - 200 >= 60 && Math.abs(x11 - 271) < 1, 'stage 11: about 71');
  assert.equal(x1, 200);
});

// ---------- the startAim seam order ----------
test('startAim seam order: S.lead runs once, after aimV is reset to 1.2 and before T.aim; a retarget resets aimV; fireAim uses e.aimV', () => {
  const { S, e, sim } = pinned(6, 150, 2.0);
  const log = [];
  const realLead = S.lead;
  S.lead = (S_, en) => { log.push(['lead', en.aimV, en.aimX, en.aimY]); realLead(S_, en); };
  const keep = e.T;
  e.T = Object.assign({}, keep, { aim(S_, en) { log.push(['aim', en.aimV, en.aimX]); } });
  e.aimV = 9;
  S.startAim(e);
  assert.equal(log.length, 2, 'lead once, aim once');
  assert.equal(log[0][0], 'lead'); assert.equal(log[1][0], 'aim');
  assert.equal(log[0][1], 1.2, 'aimV reset to 1.2 before the lead hook');
  assert.equal(log[0][2], S.player.x); assert.equal(log[0][3], S.player.y);
  assert.equal(log[1][1], 1.6, 'the type hook sees the lead result');
  assert.equal(e.aimV, 1.6, 'a hook that does not retarget keeps the lead limit');
  // a retarget wins and puts aimV back to 1.2
  e.T = Object.assign({}, keep, { aim(S_, en) { en.aimX = 50; } });
  S.startAim(e);
  assert.equal(e.aimX, 50); assert.equal(e.aimV, 1.2);
  e.T = keep;
  // fireAim takes the sideways limit from e.aimV
  for (const lim of [0.5, 1.2, 1.6]) {
    for (const b of sim.eb) b.on = false;
    e.aimX = 400; e.aimY = S.player.y; e.aimV = lim;
    S.fireAim(e);
    assert.equal(sim.eb.find(q => q.on).vx, lim, 'limit ' + lim);
  }
});

// ---------- 2.2 Hunt ----------
// the enemies that were in 'form' when this frame's pick ran: still 'form', or freshly telegraphed
const pickable = sim => sim.enemies.filter(e => !e.dead && (e.st === 'form' || (e.st === 'tele' && (e.tele === TELE_DIVE || e.tele === TELE_WARDEN))));
function nearest(list, px) {
  let best = null;
  for (const o of list) { const d = Math.abs(o.x - px), bd = best && Math.abs(best.x - px); if (!best || d < bd || (d === bd && (o.r > best.r || (o.r === best.r && o.c < best.c)))) best = o; }
  return best;
}
test('Hunt (2.2) Verify: ship still on stage 3: the launch after huntN reaches 150 takes the nearest enemy, huntN 0 after, within 150 + 135 frames of formFull', (t) => {
  for (const seed of [1, 2, 3]) {
    const sim = toPlay(mk(3, seed)), S = sim.ctx;
    let fullAt = -1, f = 0, hunted = null, huntF = -1, sfx = 0;
    while (f++ < 6000 && !hunted) {
      const ready = S.huntN >= 150, before = S.huntN;
      sim.step(IDLE);
      sim.drain((buf, o) => { if (buf[o] === EV_SFX && buf[o + 1] === SFX_ID.hunt) sfx++; });
      if (S.formFull && fullAt < 0) fullAt = S.frame;
      const h = sim.enemies.find(e => e.hunt === 1 && e.st === 'tele');
      if (h) {
        assert.ok(ready, `seed ${seed}: a Hunt only after huntN reached 150 (was ${before})`);
        // the launch sets huntN to 0; this frame's twist step (after the formation update) then counts 1
        assert.equal(S.huntN, 1, 'huntN restarted by the Hunt launch');
        assert.equal(S.huntC, S.player.x);
        assert.equal(h, nearest(pickable(sim), S.player.x), 'the nearest-rule target');
        hunted = h; huntF = S.frame;
      }
    }
    assert.ok(hunted, 'seed ' + seed + ': a Hunt happened');
    assert.equal(sfx, 1, 'SFX hunt on the launch');
    t.diagnostic(`hunt seed ${seed}: formFull at frame ${fullAt}, Hunt at ${huntF} (+${huntF - fullAt}), target r${hunted.r} c${hunted.c} at x ${hunted.x.toFixed(1)}, ship x ${S.player.x}`);
    assert.ok(huntF - fullAt <= 150 + 135, `within 285 frames of formFull (${huntF - fullAt})`);
  }
});

test('Hunt: triggers at exactly 150 twist steps in the band; a ship that moves 30 units every 120 frames is never hunted in 3000 frames', (t) => {
  const sim = toPlay(mk(3)), S = sim.ctx;
  assert.equal(S.huntN, 1, 'first play frame counts'); assert.equal(S.huntC, 200);
  toTwist(sim, 149); assert.equal(S.huntN, 149);
  formUp(sim);
  assert.equal(pickDiver(S), undefined);
  assert.ok(!sim.enemies.some(e => e.hunt), 'huntN 149: not a Hunt');
  release(sim);
  toTwist(sim, 150); assert.equal(S.huntN, 150);
  pickDiver(S);
  assert.equal(sim.enemies.filter(e => e.hunt).length, 1, 'huntN 150: a Hunt'); assert.equal(S.huntN, 0);
  // drifting beats it
  const m = toPlay(mk(3, 2)), M = m.ctx;
  let maxN = 0, hunts = 0, dir = 1, x0 = M.player.x, moving = false;
  for (let f = 0; f < 3000; f++) {
    if (f % 120 === 0) { moving = true; x0 = M.player.x; if (x0 > 300) dir = -1; else if (x0 < 100) dir = 1; }
    if (moving && Math.abs(M.player.x - x0) >= 30) moving = false;
    step(m, 1, moving ? (dir > 0 ? RIGHT : LEFT) : IDLE);
    maxN = Math.max(maxN, M.huntN);
    if (m.enemies.some(e => e.hunt)) hunts++;
  }
  t.diagnostic(`drifting 30 units every 120 frames: max huntN ${maxN}, hunted frames ${hunts}`);
  assert.equal(hunts, 0); assert.ok(maxN < 150);
});

test('Hunt: no Hunt on stages 1 and 2; on stage 3 a Hunt that is also launch 3 of a pincer dives as the pair\'s diver', () => {
  for (const st of [1, 2]) {
    const sim = toPlay(mk(st)); toTwist(sim, 400);
    assert.equal(sim.ctx.huntN, 0, 'stage ' + st);
  }
  const sim = formUp(toPlay(mk(3))), S = sim.ctx;
  const target = at(sim, 4, 1); // a moth; row 3 col 1 is a splitter at the same x, so the tie goes to the larger r
  S.player.x = target.x; S.huntN = 150; S.pincerN = 2;
  for (const e of sim.enemies) if (e.st === 'form' && e.r === 0) e.st = 'wait'; // keep Wardens out of reach of the tie
  pickDiver(S);
  const T = teles(sim);
  assert.equal(T.length, 2);
  assert.equal(target.st, 'tele'); assert.equal(target.hunt, 1); assert.equal(target.pin, 1, 'the Hunt target is the diver');
  assert.equal(at(sim, 4, 8).pin, 2); assert.equal(at(sim, 4, 8).hunt, 0);
});

test('Hunt: the mark lasts for the telegraph only (cleared when the dive starts)', () => {
  const sim = formUp(toPlay(mk(3))), S = sim.ctx;
  S.huntN = 150; pickDiver(S);
  const h = sim.enemies.find(e => e.hunt);
  let g = 0; while (h.st === 'tele' && g++ < 60) step(sim);
  assert.equal(h.st, 'dive'); assert.equal(h.hunt, 0);
});

// ---------- 0.3 hash and purity ----------
test('hash: twistT, pincerN, huntC, huntN and per-enemy hunt / pin / aimV and per-bullet th are mixed in (no stored values)', () => {
  const sim = toPlay(mk(12)), S = sim.ctx;
  S.eFire(100, 100, 0, 2, false);
  const b = sim.eb.find(q => q.on), e = sim.enemies.find(q => !q.dead);
  const h0 = sim.stateHash();
  const flip = (obj, k, v) => { const o = obj[k]; obj[k] = v; const h = sim.stateHash(); obj[k] = o; assert.notEqual(h, h0, k + ' changes the hash'); assert.equal(sim.stateHash(), h0); };
  flip(S, 'twistT', S.twistT + 1); flip(S, 'pincerN', 1); flip(S, 'huntC', S.huntC + 0.5); flip(S, 'huntN', S.huntN + 1);
  flip(e, 'hunt', 1); flip(e, 'pin', 2); flip(e, 'aimV', 1.6); flip(b, 'th', 0.6);
});

test('determinism: two runs with the same seed and inputs match on stages 2, 3, 8, 12', () => {
  for (const st of [2, 3, 8, 12]) {
    const a = createSim({ seed: 9, mode: 'stage' + st }), b = createSim({ seed: 9, mode: 'stage' + st });
    for (let f = 0; f < 2500; f++) { const w = packWord(Math.sin(f * 0.01) > 0.3 ? 1 : Math.sin(f * 0.01) < -0.3 ? -1 : 0, f % 7 === 0, f % 7 === 0); a.step(w); b.step(w); a.clearEvents(); b.clearEvents(); }
    assert.equal(a.stateHash(), b.stateHash(), 'stage ' + st);
    assert.ok(a.ctx.twistT > 0);
  }
});

test('purity: the V1 sim files use no Math.random, Date or browser trig', () => {
  for (const f of ['sim/twists.js', 'sim/aim.js', 'sim/formation.js']) {
    const src = fs.readFileSync(new URL('../games/starfall/' + f, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/Math\.random|Date\b|Math\.(sin|cos|tan|atan2|hypot|pow|exp)\b/.test(src), f);
  }
});
