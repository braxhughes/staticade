// STACKLIGHT input, multi-finger menu taps. The earlier two-finger case lifted its last finger far from where
// the gesture started, so the tap distance rule rejected it and a "two fingers count as a tap" bug (a mutant that did this) slipped
// through. Here every multi-finger gesture ends inside TAP_PX of its start, so only the multi-touch rule can reject it.
//
// The rule STACKLIGHT follows is engine/input.js:
//   line 62: `if (t.length >= 2) { latchAlt = true; gMulti = true; }`   (a second finger down marks the gesture multi-touch)
//   line 69: `if (gActive && type === 'touchend' && !gMulti && !gSwiped) {`   (a multi-touch gesture is never a tap)
// Each gesture below is fed through both the real STACKLIGHT input and the real engine input, and the M_FIRE results are
// compared, as well as checked against the expected value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInput, touchLayout, TAP_PX, PAD_HARD, M_FIRE, M_UP, M_DOWN } from '../games/stacklight/input.js';
import { createInput as createEngineInput } from '../engine/input.js';

function fakeTarget(w = 844, h = 390) {
  const l = {};
  return {
    l, innerWidth: w, innerHeight: h,
    addEventListener(n, f) { (l[n] ||= []).push(f); }, removeEventListener(n, f) { l[n] = (l[n] || []).filter(x => x !== f); },
    fire(n, ev) { for (const f of (l[n] || []).slice()) f(ev); }
  };
}
const pt = (x, y) => ({ clientX: x, clientY: y });

// one STACKLIGHT input and one engine input, each with its own fake surface
function rigs() {
  const sTarget = fakeTarget(), sSurface = fakeTarget(), doc = fakeTarget(); doc.hidden = false;
  const s = createInput({ target: sTarget, surface: sSurface, doc, getGamepads: () => [], layout: touchLayout(844, 390) });
  const eTarget = fakeTarget(), eSurface = fakeTarget();
  const e = createEngineInput({ target: eTarget, surface: eSurface });
  return { s, e, surfaces: [sSurface, eSurface] };
}
// steps: [type, touches, changedTouches]; returns the menu flags each input saw after one poll()
function play(r, steps) {
  for (const [type, touches, changed] of steps)
    for (const surf of r.surfaces) surf.fire(type, { type, touches, changedTouches: changed, preventDefault() {} });
  r.s.poll(); r.e.poll();
  return { s: r.s.menu, e: r.e.menu };
}
function expectFire(name, steps, want) {
  const r = rigs();
  const m = play(r, steps);
  const sf = (m.s & M_FIRE) !== 0, ef = (m.e & M_FIRE) !== 0;
  assert.equal(ef, want, `${name}: engine M_FIRE expected ${want}`);
  assert.equal(sf, ef, `${name}: STACKLIGHT M_FIRE ${sf} differs from engine ${ef}`);
  assert.equal(m.s & (M_UP | M_DOWN), 0, `${name}: no swipe flag`);
  return { s: sf, e: ef };
}

// Field point (no pad at 844x390) and points within TAP_PX of it.
const A = pt(422, 195);
const near = (p, d) => pt(p.clientX + d, p.clientY + d);
const N = TAP_PX - 1;

test('control: a one-finger tap that ends near its start is M_FIRE (so the cases below are not vacuous)', () => {
  expectFire('one finger', [['touchstart', [A], [A]], ['touchend', [], [A]]], true);
  expectFire('one finger, moved under TAP_PX', [['touchstart', [A], [A]], ['touchmove', [near(A, N)], [near(A, N)]], ['touchend', [], [near(A, N)]]], true);
});

test('two fingers down together, both lift within TAP_PX of the start: not a tap (engine/input.js line 62 and 69)', () => {
  const B = near(A, 4);
  // the second finger lifts last, ending near the gesture start
  const got = expectFire('two fingers, second lifts last', [
    ['touchstart', [A], [A]], ['touchstart', [A, B], [B]], ['touchend', [B], [A]], ['touchend', [], [B]]
  ], false);
  // the first finger lifts last, exactly at the gesture start
  expectFire('two fingers, first lifts last', [
    ['touchstart', [A], [A]], ['touchstart', [A, B], [B]], ['touchend', [A], [B]], ['touchend', [], [A]]
  ], false);
  // both fingers land in one touchstart and lift in one touchend
  expectFire('two fingers in one event', [['touchstart', [A, B], [A, B]], ['touchend', [], [A, B]]], false);
  console.log(`two-finger tap near start: menu flag M_FIRE=${got.s ? 1 : 0} (engine: M_FIRE=${got.e ? 1 : 0})`);
});

test('two fingers where one moves far and comes back, and two fingers on a pad: still not a tap', () => {
  const B = near(A, 4), far = pt(422, 195 - 120);
  expectFire('second finger swipes far then back', [
    ['touchstart', [A], [A]], ['touchstart', [A, B], [B]],
    ['touchmove', [A, far], [far]], ['touchmove', [A, B], [B]],
    ['touchend', [A], [B]], ['touchend', [], [A]]
  ], false);
  expectFire('first finger swipes far then back', [
    ['touchstart', [A], [A]], ['touchstart', [A, B], [B]],
    ['touchmove', [far, B], [far]], ['touchmove', [A, B], [A]],
    ['touchend', [B], [A]], ['touchend', [], [B]]
  ], false);
  const L = touchLayout(844, 390), q = L.pads[PAD_HARD];
  const P = pt(q.x + q.w / 2, q.y + q.h / 2), P2 = near(P, 3);
  expectFire('two fingers on the hard pad', [
    ['touchstart', [P], [P]], ['touchstart', [P, P2], [P2]], ['touchend', [P2], [P]], ['touchend', [], [P2]]
  ], false);
});

test('three fingers that all lift near the start: not a tap', () => {
  const B = near(A, 4), C = near(A, -4);
  expectFire('three fingers', [
    ['touchstart', [A], [A]], ['touchstart', [A, B], [B]], ['touchstart', [A, B, C], [C]],
    ['touchend', [B, C], [A]], ['touchend', [C], [B]], ['touchend', [], [C]]
  ], false);
});

test('a second finger that lands after the first lifted is a second tap, not a multi-touch', () => {
  const r = rigs(), B = near(A, 4);
  const m1 = play(r, [['touchstart', [A], [A]], ['touchend', [], [A]]]);
  const m2 = play(r, [['touchstart', [B], [B]], ['touchend', [], [B]]]);
  for (const [name, m] of [['first tap', m1], ['second tap', m2]]) {
    assert.ok(m.e & M_FIRE, `${name}: engine M_FIRE`);
    assert.ok(m.s & M_FIRE, `${name}: STACKLIGHT M_FIRE`);
  }
  // and a multi-touch gesture does not poison the next one-finger tap
  play(r, [['touchstart', [A], [A]], ['touchstart', [A, B], [B]], ['touchend', [A], [B]], ['touchend', [], [A]]]);
  const m3 = play(r, [['touchstart', [A], [A]], ['touchend', [], [A]]]);
  assert.ok(m3.e & M_FIRE); assert.ok(m3.s & M_FIRE, 'one-finger tap after a two-finger gesture is M_FIRE');
});
