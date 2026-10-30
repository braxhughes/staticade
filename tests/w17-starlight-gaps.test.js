// w17 tests-only slice, group 1: S10 review MEDs. (1) exactly one off-beat kill in a phrase: Complete and In Order pay,
// In Tune does not, and the on-beat kills after it still play melody notes 0, 1, 2 ... (the note counts on-beat kills only).
// (2) STARLIGHT state (S.sl: kills, tune, order, gone, grade, ord, paid) is reset by setup for every new STARLIGHT stage.
// Expected values are literals from design.md B.4 (Z1 phrase of 6: Complete 90 x 6, In Tune 210 x 6, In Order x1.5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { EV_SFX, EV_POPUP, SFX_ID, POP_PHRASE, W, H } from '../games/starfall/defs.js';
import { starlight } from '../games/starfall/sim/starlight.js';
import { packWord } from '../engine/input-word.js';

const IDLE = packWord(0, false, false, false, false, 0);
const onScreen = e => e.x > 12 && e.x < W - 12 && e.y > 12 && e.y < H - 30;

// Z1 stage 4, phrase 0 only (sl indices 0..5, arrival order). offAt = the index shot off-beat (stage frame % 25 === 12),
// every other kill is shot on the beat (frame % 25 === 0). Returns the phrase-0 grade popup and the 'beat' sfx args.
function playPhrase0(offAt) {
  const sim = createSim({ seed: 1, mode: 'stage4' }), S = sim.ctx;
  const beats = [], pops = [];
  const drain = () => sim.drain((b, o) => {
    if (b[o] === EV_SFX && b[o + 1] === SFX_ID.beat && b[o + 2] < 0) beats.push(b[o + 2]);
    else if (b[o] === EV_POPUP && b[o + 1] === POP_PHRASE) pops.push({ pts: Math.floor(b[o + 4] / 8), flags: b[o + 4] & 7 });
  });
  while (sim.state !== 'play') { sim.step(IDLE); drain(); }
  const killedAt = [];
  while (sim.state === 'play') {
    const f = S.stageT;
    let t = 0; while (t < 6 && S.sl.ord[t] === null) t++;
    if (t < 6) {
      const e = S.sl.ord[t];
      if (e.st === 'phrase' && onScreen(e) && f % 25 === (t === offAt ? 12 : 0)) { S.shot(e.x, e.y + 6.5); killedAt.push([t, f]); }
    }
    sim.step(IDLE); drain();
  }
  return { pops, beats, killedAt, S, sim };
}

test('all six kills on the beat: In Tune + In Order (1890, flags 7) and notes 0..5 play in order', () => {
  const r = playPhrase0(-1);
  assert.equal(r.killedAt.length, 6);
  assert.deepEqual(r.pops, [{ pts: 1890, flags: 7 }]);
  assert.deepEqual(r.beats, [-2, -3, -4, -5, -6, -7]);
});

for (const k of [0, 2, 5]) {
  test(`exactly one off-beat kill (enemy ${k} of 6): Complete + In Order only (540 x 1.5 = 810, flags 5), no In Tune`, () => {
    const r = playPhrase0(k);
    assert.equal(r.killedAt.length, 6, 'all six shot down: ' + JSON.stringify(r.killedAt));
    assert.equal(r.killedAt.find(([t]) => t === k)[1] % 25, 12, 'the chosen kill was off-beat');
    assert.deepEqual(r.pops, [{ pts: 810, flags: 5 }], 'one off-beat kill loses the In Tune grade');
    // the muted off-beat thud (-1) sits where it happened; the on-beat kills count notes 0..4 without a gap
    const expect = [-2, -3, -4, -5, -6]; expect.splice(k, 0, -1);
    assert.deepEqual(r.beats, expect);
    assert.equal(r.S.sl.tune[0], 5, 'five on-beat kills counted');
  });
}

test('setup resets all STARLIGHT state for the next STARLIGHT stage (kills, tune, order, gone, grade, ord, paid, finale)', () => {
  const r = playPhrase0(-1);
  const S = r.S, L = S.sl;
  assert.equal(L.kills[0], 6); assert.ok(L.grade[0] & 8); assert.ok(L.paid > 0);
  // dirty every field the way a played stage leaves it, then enter the next STARLIGHT stage's setup again
  L.kills.fill(5); L.tune.fill(4); L.order.fill(0); L.gone.fill(3); L.grade.fill(15); L.paid = 777; L.finPts = 5; L.finale = 2;
  starlight.setup(S);
  assert.deepEqual(Array.from(L.kills), [0, 0, 0, 0, 0, 0], 'L.kills reset');
  assert.deepEqual(Array.from(L.tune), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(L.order), [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(Array.from(L.gone), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Array.from(L.grade), [0, 0, 0, 0, 0, 0]);
  assert.equal(L.paid, 0); assert.equal(L.finPts, 0); assert.equal(L.finale, 0);
  assert.equal(L.ord.filter(Boolean).length, 36, 'fresh enemies for the new stage');
});

test('a second STARLIGHT stage with stale kills grades fresh: one shot-down enemy is not a Complete phrase', () => {
  const sim = createSim({ seed: 1, mode: 'stage4' }), S = sim.ctx, L = S.sl;
  while (sim.state !== 'play') sim.step(IDLE);
  L.kills.fill(5); L.tune.fill(5); L.grade.fill(0); // leftovers of a previous stage (as if setup had not cleared them)
  starlight.setup(S);                                 // the real reset runs again for "the next stage"
  let shot = false;
  while (sim.state === 'play') {
    const e = L.ord[0], f = S.stageT;
    if (!shot && e && e.st === 'phrase' && onScreen(e) && f % 25 === 0) { S.shot(e.x, e.y + 6.5); shot = true; }
    sim.step(IDLE);
  }
  assert.equal(L.kills[0], 1, 'only this stage\'s kill counts');
  assert.equal(L.grade[0] & 1, 0, 'phrase 0 is not Complete');
});
