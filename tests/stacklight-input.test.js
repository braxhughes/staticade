// STACKLIGHT input module (slice T2): keyboard, gamepad and touch pads to the C.2 word. Fake target, no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createInput, touchLayout, DEFAULT_BINDINGS, PAD_LEFT, PAD_RIGHT, PAD_SOFT, PAD_HARD, PAD_ROTATE,
  M_UP, M_DOWN, M_FIRE, M_ALT, M_BACK, M_ANY, M_PAUSE, M_MUTE
} from '../games/stacklight/input.js';
import { IN_LEFT, IN_RIGHT, IN_SOFT, IN_LEFT_PRESS, IN_RIGHT_PRESS, IN_HARD_PRESS, IN_ROT_PRESS } from '../games/stacklight/defs.js';
import { createSim, PH_PLAY } from '../games/stacklight/sim.js';

function fakeTarget() {
  const l = {};
  return {
    l, innerWidth: 844, innerHeight: 390,
    addEventListener(n, f) { (l[n] ||= []).push(f); }, removeEventListener(n, f) { l[n] = (l[n] || []).filter(x => x !== f); },
    fire(n, ev) { for (const f of (l[n] || []).slice()) f(ev); }
  };
}
function rig(extra = {}) {
  const target = fakeTarget(), surface = fakeTarget(), doc = fakeTarget(); doc.hidden = false;
  const pad = { buttons: [] }; for (let i = 0; i < 17; i++) pad.buttons.push({ pressed: false });
  pad.axes = [0, 0];
  const input = createInput({ target, surface, doc, getGamepads: () => [pad], layout: touchLayout(844, 390), ...extra });
  const down = (code, repeat = false) => target.fire('keydown', { code, repeat, preventDefault() {} });
  const up = code => target.fire('keyup', { code });
  const touch = (type, touches, changed = touches) => surface.fire(type, { type, touches, changedTouches: changed, preventDefault() {} });
  return { input, target, surface, doc, pad, down, up, touch };
}
const frame = input => { input.poll(); return input.word(); };

test('design verify: a 1-frame tap of Space yields exactly one word with bit 5', () => {
  const { input, down, up } = rig();
  const words = [];
  words.push(frame(input));
  down('Space'); words.push(frame(input)); up('Space');
  words.push(frame(input)); words.push(frame(input));
  assert.deepEqual(words, [0, 32, 0, 0]);
  assert.equal(words.filter(w => w & (1 << 5)).length, 1);
});

test('keydown and keyup between two polls still gives one pressed bit, once', () => {
  const { input, down, up } = rig();
  down('ArrowLeft'); up('ArrowLeft');
  assert.equal(frame(input), IN_LEFT_PRESS); // press latched, held bit already clear
  assert.equal(frame(input), 0);
  down('Space'); up('Space');
  assert.equal(frame(input), IN_HARD_PRESS);
  assert.equal(frame(input), 0);
});

test('a new tap latched while the previous word carried the bit is packed one frame later', () => {
  const { input, down, up } = rig();
  down('Space'); up('Space');
  assert.equal(frame(input), IN_HARD_PRESS);
  down('Space'); up('Space');
  assert.equal(frame(input), 0);
  assert.equal(frame(input), IN_HARD_PRESS);
  assert.equal(frame(input), 0);
});

test('key repeat events do not make pressed bits; held bits follow the key', () => {
  const { input, down, up } = rig();
  down('ArrowLeft');
  assert.equal(frame(input), IN_LEFT | IN_LEFT_PRESS);
  for (let i = 0; i < 5; i++) { down('ArrowLeft', true); assert.equal(frame(input), IN_LEFT); }
  up('ArrowLeft');
  assert.equal(frame(input), 0);
  down('Space'); assert.equal(frame(input), IN_HARD_PRESS);
  down('Space', true); down('Space', true); assert.equal(frame(input), 0);
});

test('every keyboard control maps to its E bit; reserved bits never set', () => {
  const cases = [
    ['ArrowLeft', IN_LEFT | IN_LEFT_PRESS], ['KeyA', IN_LEFT | IN_LEFT_PRESS],
    ['ArrowRight', IN_RIGHT | IN_RIGHT_PRESS], ['KeyD', IN_RIGHT | IN_RIGHT_PRESS],
    ['ArrowDown', IN_SOFT], ['KeyS', IN_SOFT],
    ['Space', IN_HARD_PRESS], ['Enter', IN_HARD_PRESS],
    ['ArrowUp', IN_ROT_PRESS], ['KeyW', IN_ROT_PRESS], ['KeyX', IN_ROT_PRESS], ['KeyK', IN_ROT_PRESS]
  ];
  for (const [code, want] of cases) {
    const { input, down, up } = rig();
    down(code);
    const w = frame(input);
    assert.equal(w, want, code);
    assert.equal(w & ~0x7f, 0);
    up(code);
  }
  // every key at once, many frames: still masked
  const { input, down } = rig();
  for (const k of Object.values(DEFAULT_BINDINGS).flat()) down(k);
  for (let i = 0; i < 6; i++) assert.equal(frame(input) & ~0x7f, 0);
});

test('menu flags: keys and gamepad', () => {
  const { input, down, pad } = rig();
  const m = code => { down(code); input.poll(); const v = input.menu; input.word(); return v; };
  assert.ok(m('KeyP') & M_PAUSE);
  assert.equal(m('KeyM'), M_MUTE);
  assert.ok(m('Escape') & M_BACK);
  assert.ok(m('Enter') & M_FIRE);
  assert.ok(m('ArrowUp') & M_UP);
  assert.ok(m('ArrowDown') & M_DOWN);
  assert.ok(m('KeyX') & M_ALT);
  input.poll(); assert.equal(input.menu, 0);
  pad.buttons[9].pressed = true; input.poll(); assert.ok(input.menu & M_PAUSE);
  input.poll(); assert.equal(input.menu & M_PAUSE, 0); // edge only
  pad.buttons[9].pressed = false;
  pad.buttons[8].pressed = true; input.poll(); assert.ok(input.menu & M_BACK);
  assert.ok(M_ANY);
});

test('every gamepad control maps to its E bit', () => {
  const cases = [
    [14, IN_LEFT | IN_LEFT_PRESS], [15, IN_RIGHT | IN_RIGHT_PRESS], [13, IN_SOFT],
    [12, IN_HARD_PRESS], [2, IN_HARD_PRESS], [0, IN_ROT_PRESS]
  ];
  for (const [b, want] of cases) {
    const { input, pad } = rig();
    pad.buttons[b].pressed = true;
    const w = frame(input);
    assert.equal(w, want, 'button ' + b);
    assert.equal(w & ~0x7f, 0);
  }
});

test('a gamepad button held across polls gives a pressed bit only on the first poll', () => {
  const { input, pad } = rig();
  pad.buttons[0].pressed = true; pad.buttons[14].pressed = true; pad.buttons[12].pressed = true;
  assert.equal(frame(input), IN_ROT_PRESS | IN_HARD_PRESS | IN_LEFT | IN_LEFT_PRESS);
  for (let i = 0; i < 4; i++) assert.equal(frame(input), IN_LEFT);
  pad.buttons[0].pressed = false; pad.buttons[14].pressed = false; pad.buttons[12].pressed = false;
  assert.equal(frame(input), 0);
  pad.buttons[0].pressed = true;
  assert.equal(frame(input), IN_ROT_PRESS);
});

test('blur and a hidden page release everything', () => {
  const r = rig();
  r.down('ArrowLeft'); r.down('ArrowDown'); r.pad.buttons[15].pressed = true;
  assert.ok(frame(r.input) & IN_LEFT);
  r.pad.buttons[15].pressed = false;
  r.target.fire('blur', {});
  assert.equal(frame(r.input), 0);
  r.down('ArrowRight'); r.down('Space');
  r.doc.hidden = true; r.doc.fire('visibilitychange', {});
  assert.equal(frame(r.input), 0);
  r.doc.hidden = false; r.doc.fire('visibilitychange', {});
  assert.equal(frame(r.input), 0);
  // a held pad is released too
  const p = r.input; p.setLayout(touchLayout(844, 390));
  const L = touchLayout(844, 390).pads[PAD_SOFT];
  r.touch('touchstart', [{ clientX: L.x + 5, clientY: L.y + 5 }]);
  assert.equal(frame(p), IN_SOFT);
  r.target.fire('blur', {});
  assert.equal(frame(p), 0);
});

test('dispose removes every listener', () => {
  const r = rig();
  r.input.dispose();
  for (const t of [r.target, r.surface, r.doc]) for (const k of Object.keys(t.l)) assert.equal(t.l[k].length, 0, k);
});

// ---------- touch ----------
const E_TABLE = [
  [844, 390, 520, 390, 162], [932, 430, 573, 430, 179], [667, 375, 443, 332, 112], [568, 320, 344, 258, 112]
];
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('touchLayout reproduces the E table and no pad touches the field', () => {
  const rows = [];
  for (const [w, h, fw, fh, band] of E_TABLE) {
    const L = touchLayout(w, h);
    rows.push(`${w}x${h} field ${L.field.w.toFixed(1)}x${L.field.h.toFixed(1)} band ${L.band.toFixed(1)}`);
    assert.ok(Math.abs(L.field.w - fw) <= 1, `${w}x${h} field w ${L.field.w}`);
    assert.ok(Math.abs(L.field.h - fh) <= 1, `${w}x${h} field h ${L.field.h}`);
    assert.ok(Math.abs(L.band - band) <= 1, `${w}x${h} band ${L.band}`);
    assert.ok(L.band >= 112 - 1e-9);
    assert.equal(L.pads.length, 5);
    for (const p of L.pads) {
      assert.ok(!hit(p, L.field), `${w}x${h} pad ${p.name} overlaps the field`);
      assert.ok(p.w >= 44 - 1e-9 && p.h >= 44 - 1e-9, `${w}x${h} pad ${p.name} too small`);
      assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.w <= w + 1e-9 && p.y + p.h <= h + 1e-9, `${w}x${h} pad ${p.name} off screen`);
      const inLeft = p.x + p.w <= L.field.x, inRight = p.x >= L.field.x + L.field.w;
      assert.ok(inLeft || inRight, p.name);
    }
    for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) assert.ok(!hit(L.pads[i], L.pads[j]), `${w}x${h} pads ${i},${j} overlap`);
  }
  console.log('touchLayout table:\n' + rows.join('\n'));
});

test('touchLayout honours safe-area insets and stays clear of the field', () => {
  const ins = { left: 47, right: 47, top: 0, bottom: 21 };
  const L = touchLayout(844, 390, ins);
  const L0 = touchLayout(844 - 94, 390 - 21);
  assert.ok(Math.abs(L.field.w - L0.field.w) < 1e-9 && Math.abs(L.band - L0.band) < 1e-9);
  assert.ok(Math.abs(L.field.x - (47 + L.band)) < 1e-9);
  for (const p of L.pads) {
    assert.ok(!hit(p, L.field));
    assert.ok(p.x >= 47 - 1e-9 && p.x + p.w <= 844 - 47 + 1e-9, p.name);
    assert.ok(p.y + p.h <= 390 - 21 + 1e-9, p.name);
  }
});

const center = p => ({ clientX: p.x + p.w / 2, clientY: p.y + p.h / 2 });

test('a touch on each pad gives its bits; a touch inside the field gives 0', () => {
  const want = [[PAD_LEFT, IN_LEFT | IN_LEFT_PRESS], [PAD_RIGHT, IN_RIGHT | IN_RIGHT_PRESS], [PAD_SOFT, IN_SOFT],
    [PAD_HARD, IN_HARD_PRESS], [PAD_ROTATE, IN_ROT_PRESS]];
  for (const [id, bits] of want) {
    const r = rig(); const L = touchLayout(844, 390);
    const t = [center(L.pads[id])];
    r.touch('touchstart', t);
    assert.equal(frame(r.input), bits, 'pad ' + id);
    const second = frame(r.input);
    assert.equal(second, bits & (IN_LEFT | IN_RIGHT | IN_SOFT), 'held pad ' + id);
    r.touch('touchend', [], t);
    assert.equal(frame(r.input), 0);
  }
  const r = rig(); const L = touchLayout(844, 390);
  const f = [{ clientX: L.field.x + L.field.w / 2, clientY: L.field.y + L.field.h / 2 }];
  r.touch('touchstart', f); assert.equal(frame(r.input), 0); r.touch('touchend', [], f); assert.equal(frame(r.input), 0);
  const corner = [{ clientX: 1, clientY: 1 }];
  r.touch('touchstart', corner); assert.equal(frame(r.input), 0);
});

test('two touches on two pads at once; a slide from a pad into the field releases it', () => {
  const r = rig(); const L = touchLayout(844, 390);
  const a = center(L.pads[PAD_RIGHT]), b = center(L.pads[PAD_ROTATE]);
  r.touch('touchstart', [a]);
  r.touch('touchstart', [a, b], [b]);
  assert.equal(frame(r.input), IN_RIGHT | IN_RIGHT_PRESS | IN_ROT_PRESS);
  const into = { clientX: L.field.x + 10, clientY: L.field.y + 10 };
  r.touch('touchmove', [into, b]);
  assert.equal(frame(r.input), 0);
  // sliding back onto a pad is a new press
  r.touch('touchmove', [a, b]);
  assert.equal(frame(r.input), IN_RIGHT | IN_RIGHT_PRESS);
  r.touch('touchcancel', []);
  assert.equal(frame(r.input), 0);
});

test('a tap that starts and ends between polls is not lost', () => {
  const r = rig(); const L = touchLayout(844, 390); const t = [center(L.pads[PAD_HARD])];
  r.touch('touchstart', t); r.touch('touchend', [], t);
  assert.equal(frame(r.input), IN_HARD_PRESS);
  assert.equal(frame(r.input), 0);
});

// ---------- allocation ----------
test('poll() and word() do not allocate', () => {
  const r = rig(); const L = touchLayout(844, 390);
  r.down('ArrowLeft'); r.touch('touchstart', [center(L.pads[PAD_SOFT])]);
  // reuse one pad list so the fake gamepad source itself allocates nothing
  const gps = [r.pad]; const input = createInput({ target: fakeTarget(), doc: null, getGamepads: () => gps, layout: L });
  for (let i = 0; i < 2000; i++) { input.poll(); input.word(); }
  if (global.gc) global.gc();
  const before = process.memoryUsage().heapUsed;
  let sink = 0;
  for (let i = 0; i < 200000; i++) { input.poll(); sink += input.word(); }
  const grown = process.memoryUsage().heapUsed - before;
  assert.ok(grown < 400000, 'heap grew ' + grown + ' bytes (sink ' + sink + ')');
});

// ---------- the real sim ----------
test('feeding input words to createSim: a LEFT tap moves the piece one column', () => {
  const sim = createSim({ seed: 1, mode: 'arcade' });
  const { input, down, up } = rig();
  while (sim.phase !== PH_PLAY) sim.step(frame(input));
  const col = sim.ctx.px;
  down('ArrowLeft'); sim.step(frame(input)); up('ArrowLeft');
  for (let i = 0; i < 4; i++) sim.step(frame(input));
  assert.equal(sim.ctx.px, col - 1);
  // a sub-frame RIGHT tap (down and up between polls) also moves exactly one column
  down('ArrowRight'); up('ArrowRight');
  for (let i = 0; i < 4; i++) sim.step(frame(input));
  assert.equal(sim.ctx.px, col);
  assert.equal(sim.badInput, false);
});
