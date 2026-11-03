// STACKLIGHT input module, fixes: run start and resume through the
// real sim, gamepad across blur, touch and mouse menu flags, real-browser gamepad slots, pad hit
// areas at the edges, short wide screens, the default layout, allocation with input held.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceObserver } from 'node:perf_hooks';
import {
  createInput, touchLayout, PAD_LEFT, PAD_RIGHT, PAD_SOFT, PAD_HARD, PAD_ROTATE, PAD_GAP, SWIPE_PX, TAP_PX,
  M_UP, M_DOWN, M_FIRE, M_ALT, M_PAUSE
} from '../games/stacklight/input.js';
import { IN_LEFT, IN_RIGHT, IN_SOFT, IN_LEFT_PRESS, IN_RIGHT_PRESS, IN_HARD_PRESS, IN_ROT_PRESS } from '../games/stacklight/defs.js';
import { createSim, PH_PLAY } from '../games/stacklight/sim.js';

function fakeTarget(w = 844, h = 390) {
  const l = {};
  return {
    l, innerWidth: w, innerHeight: h,
    addEventListener(n, f) { (l[n] ||= []).push(f); }, removeEventListener(n, f) { l[n] = (l[n] || []).filter(x => x !== f); },
    fire(n, ev) { for (const f of (l[n] || []).slice()) f(ev); }
  };
}
const newPad = () => { const p = { buttons: [], axes: [0, 0] }; for (let i = 0; i < 17; i++) p.buttons.push({ pressed: false }); return p; };
// slots: what getGamepads() returns, like Chrome's fixed list, e.g. [pad, null, null, null]
function rig({ slots, layout = touchLayout(844, 390), ...extra } = {}) {
  const target = fakeTarget(), surface = fakeTarget(), doc = fakeTarget(); doc.hidden = false;
  const pad = newPad();
  const gps = slots || [pad];
  const input = createInput({ target, surface, doc, getGamepads: () => gps, layout, ...extra });
  const down = (code, repeat = false) => target.fire('keydown', { code, repeat, preventDefault() {} });
  const up = code => target.fire('keyup', { code });
  const tap = code => { down(code); up(code); };
  const touch = (type, touches, changed = touches) => surface.fire(type, { type, touches, changedTouches: changed, preventDefault() {} });
  return { input, target, surface, doc, pad, gps, down, up, tap, touch };
}
const frame = input => { input.poll(); return input.word(); };
const menuPoll = input => { input.poll(); return input.menu; };
const center = p => ({ clientX: p.x + p.w / 2, clientY: p.y + p.h / 2 });
const pt = (x, y) => ({ clientX: x, clientY: y });
const EPS = 1e-6;

// ---------- run start and resume ----------
// The title menu: Up (menu nav, also rotate) then Enter (start, also hard drop), the page polls the menu and never calls word().
function menuThenStart(r) {
  r.tap('ArrowUp'); const m1 = menuPoll(r.input);
  r.tap('Enter'); const m2 = menuPoll(r.input);
  assert.ok(m1 & M_UP); assert.ok(m2 & M_FIRE);
}

test('H1: menu Up + Enter, then beginRun(): the first word is 0 and the first piece is not locked on frame 0 (real sim)', () => {
  const r = rig();
  menuThenStart(r);
  const sim = createSim({ seed: 1, mode: 'arcade' });
  r.input.beginRun();
  const w = r.input.word(); // same tick as the menu poll that started the run
  assert.equal(w, 0);
  sim.step(w);
  assert.equal(sim.phase, PH_PLAY);
  assert.deepEqual(sim.heights(), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  // the next tick, a new press does reach the sim
  r.tap('ArrowLeft'); assert.equal(frame(r.input), IN_LEFT_PRESS);
});

test('H1: same with the first word on the tick after the start (Starfall shape)', () => {
  const r = rig();
  menuThenStart(r);
  const sim = createSim({ seed: 1, mode: 'arcade' });
  r.input.beginRun();
  const w = frame(r.input);
  assert.equal(w, 0);
  sim.step(w);
  assert.equal(sim.phase, PH_PLAY);
  assert.deepEqual(sim.heights(), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test('H1: a press made after beginRun() and before the first word does count', () => {
  const r = rig();
  menuThenStart(r);
  r.input.beginRun();
  r.tap('ArrowRight');
  assert.equal(frame(r.input), IN_RIGHT_PRESS);
});

test('H1 safety net: a page that forgets beginRun() still never sends the menu presses to the sim', () => {
  for (const sameTick of [true, false]) {
    const r = rig();
    menuThenStart(r);
    const sim = createSim({ seed: 1, mode: 'arcade' });
    const w = sameTick ? r.input.word() : frame(r.input);
    assert.equal(w, 0, 'sameTick ' + sameTick);
    sim.step(w);
    assert.equal(sim.phase, PH_PLAY);
    assert.deepEqual(sim.heights(), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
    r.tap('ArrowLeft'); assert.equal(frame(r.input), IN_LEFT_PRESS, 'presses work again after the first word');
  }
  // a gamepad A that starts the run on the same tick (its edge is made inside that poll) is dropped too
  const r = rig();
  r.pad.buttons[0].pressed = true; assert.ok(menuPoll(r.input) & M_FIRE);
  r.pad.buttons[0].pressed = false; assert.equal(menuPoll(r.input), 0);
  r.pad.buttons[0].pressed = true; assert.ok(menuPoll(r.input) & M_FIRE);
  assert.equal(r.input.word(), 0);
});

test('H1: presses during pause do not land on the resume frame (real sim, keyboard and gamepad resume)', () => {
  for (const how of ['enter', 'gamepadA', 'clearLatches']) {
    const r = rig();
    const sim = createSim({ seed: 1, mode: 'arcade' });
    r.input.beginRun();
    for (let i = 0; i < 3; i++) sim.step(frame(r.input));
    assert.equal(sim.phase, PH_PLAY);
    const row = sim.info().piece.row, col = sim.info().piece.col;
    r.tap('KeyP'); sim.step(frame(r.input)); // the pause key; the page pauses after this frame
    // paused: menu polls only
    r.tap('Space'); r.tap('ArrowUp'); r.tap('ArrowLeft'); assert.ok(menuPoll(r.input) & M_FIRE);
    r.pad.buttons[2].pressed = true; menuPoll(r.input); r.pad.buttons[2].pressed = false; menuPoll(r.input);
    // resume
    if (how === 'gamepadA') r.pad.buttons[0].pressed = true; else r.tap('Enter');
    assert.ok(menuPoll(r.input) & M_FIRE);
    if (how === 'clearLatches') r.input.clearLatches(); else r.input.resume();
    const w = frame(r.input);
    assert.equal(w, 0, how);
    sim.step(w);
    assert.equal(sim.phase, PH_PLAY, how);
    assert.equal(sim.info().piece.col, col, how);
    assert.ok(sim.info().piece.row >= row - 1 && sim.info().piece.row <= row + 1, how + ' no hard drop');
    assert.deepEqual(sim.heights(), [0, 0, 0, 0, 0, 0, 0, 0, 0], how);
  }
});

test('H1 safety net: a page that forgets resume() still drops the pause presses', () => {
  const r = rig();
  r.input.beginRun(); frame(r.input); frame(r.input);
  menuPoll(r.input); r.tap('Space'); menuPoll(r.input); r.tap('Enter'); menuPoll(r.input);
  assert.equal(frame(r.input), 0);
  r.tap('Space'); assert.equal(frame(r.input), IN_HARD_PRESS);
});

test('resume() keeps the previous pressed bits: a same-bit tap on the first resumed frame still moves (real sim)', () => {
  for (const how of ['resume', 'clearLatches']) {
    const r = rig();
    const sim = createSim({ seed: 1, mode: 'arcade' });
    r.input.beginRun();
    while (sim.phase !== PH_PLAY) sim.step(frame(r.input));
    sim.step(frame(r.input));
    const col = sim.info().piece.col;
    r.tap('ArrowLeft'); r.tap('KeyP');
    const w = frame(r.input); assert.equal(w, IN_LEFT_PRESS); sim.step(w); // the last frame before the pause
    menuPoll(r.input); menuPoll(r.input); r.tap('Enter'); menuPoll(r.input);
    r.input[how]();
    r.tap('ArrowLeft');
    for (let i = 0; i < 4; i++) sim.step(frame(r.input));
    assert.equal(sim.info().piece.col, col - 2, how + ': both LEFT taps moved');
  }
});

test('L1: beginRun() resets the previous pressed bits, so a new run gets its first tap at once', () => {
  const r = rig();
  r.input.beginRun();
  r.tap('Space'); assert.equal(frame(r.input), IN_HARD_PRESS); // the old run's last word carried HARD
  r.input.beginRun(); // a new sim (previous word 0)
  r.tap('Space');
  assert.equal(r.input.word(), IN_HARD_PRESS);
});

// ---------- gamepad across blur and hide ----------
test('M1: a gamepad button held across blur or a hidden page is not a new press', () => {
  const r = rig();
  r.pad.buttons[0].pressed = true; r.pad.buttons[14].pressed = true;
  assert.equal(frame(r.input), IN_LEFT | IN_LEFT_PRESS | IN_ROT_PRESS);
  assert.equal(frame(r.input), IN_LEFT);
  r.target.fire('blur', {});
  r.input.poll(); assert.equal(r.input.menu, 0); assert.equal(r.input.word(), IN_LEFT);
  r.doc.hidden = true; r.doc.fire('visibilitychange', {}); r.doc.hidden = false; r.doc.fire('visibilitychange', {});
  r.input.poll(); assert.equal(r.input.menu, 0, 'no M_FIRE after hide / show'); assert.equal(r.input.word(), IN_LEFT);
  // let go and press again: a real new press
  r.pad.buttons[0].pressed = false; r.pad.buttons[14].pressed = false; assert.equal(frame(r.input), 0);
  r.pad.buttons[0].pressed = true; r.input.poll(); assert.ok(r.input.menu & M_FIRE); assert.equal(r.input.word(), IN_ROT_PRESS);
});

test('M1: every gamepad edge (hard, rotate, left, right, menu flags) survives blur without refiring', () => {
  const r = rig();
  for (const b of [0, 1, 2, 8, 9, 12, 13, 14, 15]) r.pad.buttons[b].pressed = true;
  frame(r.input); frame(r.input);
  r.target.fire('blur', {});
  r.input.poll();
  assert.equal(r.input.menu, 0);
  assert.equal(r.input.word(), IN_LEFT | IN_RIGHT | IN_SOFT);
});

test('M1: a gamepad that disconnects mid-hold is released', () => {
  const r = rig({ slots: [null, null, null, null] });
  r.gps[0] = r.pad; r.pad.buttons[14].pressed = true;
  assert.equal(frame(r.input), IN_LEFT | IN_LEFT_PRESS);
  r.gps[0] = null;
  assert.equal(frame(r.input), 0);
});

// ---------- touch and mouse menu flags ----------
test('M2: a one-finger tap is M_FIRE, a vertical swipe is M_UP / M_DOWN, a mouse button is M_FIRE', () => {
  const r = rig();
  const f = r.input;
  // tap in the field (no pad): M_FIRE, no word bits
  const a = pt(422, 195);
  r.touch('touchstart', [a]); r.touch('touchend', [], [a]);
  f.poll(); assert.ok(f.menu & M_FIRE); assert.equal(f.word(), 0);
  // a tap that moves less than TAP_PX is still a tap
  const b = pt(422 + TAP_PX - 1, 195 + TAP_PX - 1);
  r.touch('touchstart', [a]); r.touch('touchmove', [b]); r.touch('touchend', [], [b]);
  assert.ok(menuPoll(f) & M_FIRE);
  // TAP_PX or more sideways is neither a tap nor a swipe
  const c = pt(422 + TAP_PX, 195);
  r.touch('touchstart', [a]); r.touch('touchend', [], [c]);
  assert.equal(menuPoll(f) & (M_FIRE | M_UP | M_DOWN), 0);
  // swipe up and down, flagged while the finger is still moving
  r.touch('touchstart', [a]); r.touch('touchmove', [pt(422, 195 - SWIPE_PX)]);
  assert.equal(menuPoll(f) & (M_UP | M_DOWN | M_FIRE), M_UP);
  r.touch('touchend', [], [pt(422, 195 - SWIPE_PX)]);
  assert.equal(menuPoll(f) & M_FIRE, 0, 'a swipe is not also a tap');
  r.touch('touchstart', [a]); r.touch('touchmove', [pt(422, 195 + SWIPE_PX)]); r.touch('touchend', [], [pt(422, 195 + SWIPE_PX)]);
  assert.equal(menuPoll(f) & (M_UP | M_DOWN | M_FIRE), M_DOWN);
  // a fast flick with no touchmove counts on touchend
  r.touch('touchstart', [a]); r.touch('touchend', [], [pt(422, 195 - SWIPE_PX - 5)]);
  assert.equal(menuPoll(f) & (M_UP | M_DOWN | M_FIRE), M_UP);
  // short of SWIPE_PX: nothing
  r.touch('touchstart', [a]); r.touch('touchmove', [pt(422, 195 - SWIPE_PX + 1)]); r.touch('touchend', [], [pt(422, 195 - SWIPE_PX + 1)]);
  assert.equal(menuPoll(f) & (M_UP | M_DOWN | M_FIRE), 0);
  // a mostly sideways swipe is not UP / DOWN
  r.touch('touchstart', [a]); r.touch('touchmove', [pt(422 + 80, 195 - SWIPE_PX)]); r.touch('touchend', [], [pt(422 + 80, 195 - SWIPE_PX)]);
  assert.equal(menuPoll(f) & (M_UP | M_DOWN | M_FIRE), 0);
  // two fingers: no tap; a cancelled touch: no tap
  const d = pt(500, 100);
  r.touch('touchstart', [a]); r.touch('touchstart', [a, d], [d]); r.touch('touchend', [d], [a]); r.touch('touchend', [], [d]);
  assert.equal(menuPoll(f) & M_FIRE, 0);
  r.touch('touchstart', [a]); r.touch('touchcancel', [], [a]);
  assert.equal(menuPoll(f) & M_FIRE, 0);
  // mouse
  r.surface.fire('mousedown', {});
  assert.ok(menuPoll(f) & M_FIRE);
  assert.equal(menuPoll(f), 0);
});

test('M2: a tap on a pad in a menu is M_FIRE too, and its pad press never reaches the run', () => {
  const r = rig(); const L = touchLayout(844, 390);
  const t = [center(L.pads[PAD_HARD])];
  r.touch('touchstart', t); r.touch('touchend', [], t);
  assert.ok(menuPoll(r.input) & M_FIRE);
  const sim = createSim({ seed: 1, mode: 'arcade' });
  r.input.beginRun();
  const w = r.input.word(); assert.equal(w, 0); sim.step(w);
  assert.deepEqual(sim.heights(), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

// ---------- real-browser gamepad lists ----------
test('M3: a fixed-slot gamepad list with nulls: keyboard menus and pad edges still work', () => {
  // no pad at all, like Chrome with nothing connected
  const r0 = rig({ slots: [null, null, null, null] });
  r0.tap('Enter'); r0.input.poll(); assert.ok(r0.input.menu & M_FIRE); assert.equal(r0.input.word(), IN_HARD_PRESS);
  r0.tap('KeyP'); assert.ok(menuPoll(r0.input) & M_PAUSE);
  // pad in slot 0, nulls after
  const r1 = rig({ slots: null });
  const s1 = [r1.pad, null, null, null];
  const in1 = createInput({ target: r1.target, surface: r1.surface, doc: r1.doc, getGamepads: () => s1, layout: touchLayout(844, 390) });
  r1.pad.buttons[15].pressed = true; r1.pad.buttons[2].pressed = true; r1.tap('KeyX');
  in1.poll(); assert.ok(in1.menu & M_ALT);
  assert.equal(in1.word(), IN_RIGHT | IN_RIGHT_PRESS | IN_HARD_PRESS | IN_ROT_PRESS);
  // pad in slot 2 after nulls (Chrome keeps the slot of a pad plugged in third)
  const r2 = rig({ slots: [null, null, null, null] });
  r2.gps[2] = r2.pad; r2.pad.buttons[0].pressed = true; r2.down('ArrowDown');
  r2.input.poll(); assert.ok(r2.input.menu & M_FIRE); assert.ok(r2.input.menu & M_DOWN);
  assert.equal(r2.input.word(), IN_ROT_PRESS | IN_SOFT);
  // two pads, the second one pressing
  const r3 = rig({ slots: [null, null, null, null] });
  const p2 = newPad(); r3.gps[0] = r3.pad; r3.gps[1] = null; r3.gps[3] = p2; p2.buttons[14].pressed = true;
  assert.equal(frame(r3.input), IN_LEFT | IN_LEFT_PRESS);
});

// ---------- pad hit areas and the layout at many sizes ----------
const SIZES = [[844, 390], [932, 430], [667, 375], [568, 320], [1366, 400], [1200, 300], [1024, 768], [2000, 400],
  [844, 390, { left: 47, right: 47, top: 0, bottom: 21 }], [1366, 400, { left: 0, right: 30, top: 10, bottom: 20 }]];
const PAD_BITS = [IN_LEFT | IN_LEFT_PRESS, IN_RIGHT | IN_RIGHT_PRESS, IN_SOFT, IN_HARD_PRESS, IN_ROT_PRESS];

test('M4 / L2: every pad keeps its 8 px margins and gaps, stays on screen and at least 44 px, at every size', () => {
  const rows = [];
  for (const [w, h, ins = { left: 0, right: 0, top: 0, bottom: 0 }] of SIZES) {
    const L = touchLayout(w, h, ins), F = L.field, P = L.pads;
    const top = ins.top + PAD_GAP, bot = h - ins.bottom - PAD_GAP;
    const tag = `${w}x${h}`;
    for (const p of P) {
      assert.ok(p.w >= 44 - EPS && p.h >= 44 - EPS, `${tag} ${p.name} ${p.w}x${p.h}`);
      assert.ok(p.y >= top - EPS && p.y + p.h <= bot + EPS, `${tag} ${p.name} off the top or bottom: y ${p.y} h ${p.h}`);
      const left = p.id === PAD_LEFT || p.id === PAD_RIGHT || p.id === PAD_SOFT;
      if (left) assert.ok(p.x >= ins.left + PAD_GAP - EPS && p.x + p.w <= F.x - PAD_GAP + EPS, `${tag} ${p.name} margins`);
      else assert.ok(p.x >= F.x + F.w + PAD_GAP - EPS && p.x + p.w <= w - ins.right - PAD_GAP + EPS, `${tag} ${p.name} margins`);
    }
    assert.ok(P[PAD_LEFT].x + P[PAD_LEFT].w + PAD_GAP <= P[PAD_RIGHT].x + EPS, `${tag} move gap`);
    assert.ok(P[PAD_SOFT].y + P[PAD_SOFT].h + PAD_GAP <= P[PAD_LEFT].y + EPS, `${tag} soft gap`);
    assert.ok(P[PAD_ROTATE].y + P[PAD_ROTATE].h + PAD_GAP <= P[PAD_HARD].y + EPS, `${tag} rotate / hard gap`);
    const f = v => v.toFixed(1);
    rows.push(`${tag}${ins.left || ins.right || ins.top || ins.bottom ? ' (insets)' : ''} field ${f(F.w)}x${f(F.h)} band ${f(L.band)} ` +
      `soft ${f(P[PAD_SOFT].x)},${f(P[PAD_SOFT].y)} ${f(P[PAD_SOFT].w)}x${f(P[PAD_SOFT].h)} ` +
      `rotate ${f(P[PAD_ROTATE].x)},${f(P[PAD_ROTATE].y)} ${f(P[PAD_ROTATE].w)}x${f(P[PAD_ROTATE].h)}`);
  }
  console.log('touchLayout at every size:\n' + rows.join('\n'));
});

test('M4: touches on pad edges hit; touches in the margins, the gaps and the field edge do nothing', () => {
  for (const [w, h, ins] of SIZES) {
    const L = touchLayout(w, h, ins), F = L.field, P = L.pads;
    const r = rig({ layout: L });
    const one = (x, y) => { const t = [pt(x, y)]; r.touch('touchstart', t); const v = frame(r.input); r.touch('touchend', [], t); frame(r.input); return v; };
    const tag = `${w}x${h}`;
    for (const p of P) {
      const bits = PAD_BITS[p.id];
      for (const [x, y] of [[p.x, p.y], [p.x + p.w - 0.5, p.y], [p.x, p.y + p.h - 0.5], [p.x + p.w - 0.5, p.y + p.h - 0.5]])
        assert.equal(one(x, y), bits, `${tag} ${p.name} inside edge ${x},${y}`);
      const my = p.y + p.h / 2, mx = p.x + p.w / 2;
      for (const [x, y] of [[p.x - 0.5, my], [p.x + p.w + 0.5, my], [p.x + p.w + PAD_GAP - 0.5, my], [mx, p.y - 0.5], [mx, p.y + p.h + 0.5]])
        assert.equal(one(x, y) & bits, 0, `${tag} ${p.name} just outside ${x},${y}`);
    }
    // the margins and gaps themselves
    const gaps = [
      [P[PAD_LEFT].x + P[PAD_LEFT].w + PAD_GAP / 2, P[PAD_LEFT].y + 5],          // between the move pads
      [P[PAD_LEFT].x + 5, P[PAD_LEFT].y - PAD_GAP / 2],                          // between soft and move
      [P[PAD_HARD].x + 5, P[PAD_HARD].y - PAD_GAP / 2],                          // between rotate and hard drop
      [F.x - PAD_GAP / 2, P[PAD_RIGHT].y + 5], [F.x + F.w + PAD_GAP / 2, P[PAD_HARD].y + 5], // the field margins
      [F.x + 0.5, P[PAD_RIGHT].y + 5], [F.x + F.w - 0.5, P[PAD_HARD].y + 5],      // the field's own edges
      [F.x + F.w / 2, F.y + F.h / 2]
    ];
    for (const [x, y] of gaps) assert.equal(one(x, y), 0, `${tag} gap ${x},${y}`);
  }
});

// ---------- the default layout ----------
test('L3: with no layout passed, the hit test uses touchLayout(innerWidth, innerHeight, insets), cached', () => {
  const target = fakeTarget(844, 390), surface = fakeTarget();
  const ins = { left: 47, right: 47, top: 0, bottom: 21 };
  const input = createInput({ target, surface, doc: null, getGamepads: () => null, insets: ins });
  const touch = (type, t, c = t) => surface.fire(type, { type, touches: t, changedTouches: c, preventDefault() {} });
  const L1 = input.getLayout();
  assert.deepEqual(L1, touchLayout(844, 390, ins));
  assert.equal(input.getLayout(), L1, 'cached: the same object while nothing changed');
  // the right move pad with insets sits where the no-inset layout has nothing of its own
  const p = L1.pads[PAD_RIGHT], t = [center(p)];
  touch('touchstart', t); touch('touchmove', t); touch('touchmove', t);
  assert.equal(input.getLayout(), L1, 'touch events do not rebuild it');
  input.poll(); assert.equal(input.word(), IN_RIGHT | IN_RIGHT_PRESS);
  touch('touchend', [], t); input.poll(); input.word();
  // a resize or new insets rebuild it once
  target.innerWidth = 932; target.innerHeight = 430;
  const L2 = input.getLayout(); assert.notEqual(L2, L1); assert.deepEqual(L2, touchLayout(932, 430, ins));
  assert.equal(input.getLayout(), L2);
  ins.left = 0;
  const L3 = input.getLayout(); assert.notEqual(L3, L2); assert.deepEqual(L3, touchLayout(932, 430, ins));
  input.dispose();
});

// ---------- no allocation with keys, touches and a gamepad held ----------
test('L4: poll() and word() do not allocate with keys, two pads and gamepad buttons held (no GC in 2M frames)', async () => {
  const L = touchLayout(844, 390);
  const pad = newPad(), gps = [pad, null, null, null];
  const target = fakeTarget(), surface = fakeTarget();
  const input = createInput({ target, surface, doc: null, getGamepads: () => gps, layout: L });
  for (const k of ['ArrowLeft', 'ArrowDown', 'KeyD']) target.fire('keydown', { code: k, repeat: false, preventDefault() {} });
  const t = [center(L.pads[PAD_RIGHT]), center(L.pads[PAD_SOFT])];
  surface.fire('touchstart', { type: 'touchstart', touches: t, changedTouches: t, preventDefault() {} });
  for (const b of [0, 2, 13, 14, 15]) pad.buttons[b].pressed = true;
  for (let i = 0; i < 100000; i++) { input.poll(); input.word(); }
  let gcs = 0;
  const obs = new PerformanceObserver(list => { gcs += list.getEntries().length; });
  obs.observe({ entryTypes: ['gc'] });
  const before = process.memoryUsage().heapUsed;
  let sink = 0;
  for (let i = 0; i < 2000000; i++) { input.poll(); sink += input.word(); }
  const grown = process.memoryUsage().heapUsed - before;
  await new Promise(res => setTimeout(res, 50));
  obs.disconnect();
  assert.equal(sink, 2000000 * (IN_LEFT | IN_RIGHT | IN_SOFT));
  assert.equal(gcs, 0, 'garbage collections during the loop: ' + gcs);
  assert.ok(grown < 1000000, 'heap grew ' + grown + ' bytes');
});
