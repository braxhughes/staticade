// STACKLIGHT PAUSE pad and title (node, no browser): the PAUSE pad box in touchLayout, its hit test and gesture, and the title drawing.
//   1. touchLayout: the pause box is in the right band, outside the field, at least 44 px, clear of the five pads, at the four phone sizes
//      (and with safe-area insets); the five pads' boxes are the ones touchLayout always gave (pinned in the older input tests)
//   2. the pad: a finger newly on it gives M_PAUSE only (no word bit); only while pauseLive; its lift is not a menu tap
//   3. the title: no background beam dot lands on any text box, the board page or the Daily card; every card line keeps a margin
import test from 'node:test';
import assert from 'node:assert/strict';
import { touchLayout, createInput, M_PAUSE, M_FIRE, PAD_COUNT } from '../games/stacklight/input.js';
import { createRenderer } from '../games/stacklight/render.js';
import { textW } from '../engine/font.js';
import { dailyCard, RULE_NOTE } from '../games/stacklight/modes.js';

const SIZES = [[844, 390], [932, 430], [667, 375], [568, 320]];
const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('1. the PAUSE pad fits in the right band at the four phone sizes, with and without insets', () => {
  for (const [w, h] of SIZES) for (const ins of [undefined, { left: 47, right: 47, top: 0, bottom: 21 }]) {
    const L = touchLayout(w, h, ins), p = L.pause, F = L.field, tag = `${w}x${h}${ins ? ' insets' : ''}`;
    assert.equal(L.pads.length, PAD_COUNT, tag + ': still five pads');
    assert.ok(p.w >= 44 && p.h >= 44, `${tag}: ${p.w} x ${p.h} is at least 44`);
    assert.ok(p.x >= F.x + F.w && p.x + p.w <= w - (ins ? ins.right : 0) + 1e-9, tag + ': inside the right band');
    assert.ok(p.y >= (ins ? ins.top : 0) && p.y + p.h <= h - (ins ? ins.bottom : 0) + 1e-9, tag + ': inside the screen height');
    assert.ok(!hit(p, F), tag + ': outside the field');
    for (const q of L.pads) assert.ok(!hit(p, q), `${tag}: clear of ${q.name} by at least 8 px or more`);
    const turn = L.pads[4];
    assert.ok(turn.y - (p.y + p.h) >= 8 - 1e-9, tag + ': a gap of 8 px above TURN: ' + (turn.y - (p.y + p.h)));
    // TURN and DROP are not shrunk (the stop rule): they are the 44 px or more they always were
    for (const q of [L.pads[3], L.pads[4]]) assert.ok(q.w >= 44 && q.h >= 44, tag + ': ' + q.name + ' keeps its size');
  }
});

// a fake surface and target: events come in through the registered listeners
function rig() {
  const L = {}, add = o => (n, f) => { (o[n] || (o[n] = [])).push(f); };
  const target = { addEventListener: add(L), removeEventListener() {}, innerWidth: 844, innerHeight: 390 };
  const S = {}, surface = { addEventListener: add(S), removeEventListener() {} };
  const input = createInput({ target, surface, doc: null, getGamepads: () => [], layout: touchLayout(844, 390) });
  const fire = (type, touches, changed = touches) => { for (const f of S[type]) f({ type, touches, changedTouches: changed, preventDefault() {} }); };
  const tap = (x, y) => [{ clientX: x, clientY: y }];
  return { input, fire, tap, L: touchLayout(844, 390) };
}
const mid = q => [q.x + q.w / 2, q.y + q.h / 2];

test('2. a finger on the PAUSE pad is M_PAUSE and nothing else; it is live only in a run; its lift does not resume', () => {
  const { input, fire, tap, L } = rig();
  const [px, py] = mid(L.pause);
  // not live (title, results, entry): a finger there is an ordinary tap, never a pause
  fire('touchstart', tap(px, py)); input.poll();
  assert.equal(input.menu & M_PAUSE, 0, 'not live: no pause flag');
  fire('touchend', [], tap(px, py)); input.poll();
  assert.ok(input.menu & M_FIRE, 'not live: the lift is the usual menu tap');
  // live: the press is the P key
  input.pauseLive = true; input.beginRun();
  fire('touchstart', tap(px, py)); input.poll();
  assert.ok(input.menu & M_PAUSE, 'live: pause flag');
  assert.equal(input.word(), 0, 'no word bit from the pad (no turn, drop or move)');
  fire('touchend', [], tap(px, py)); input.poll();
  assert.equal(input.menu & M_FIRE, 0, 'the lift of a pause tap is not a menu tap (it would resume at once)');
  // held on the pad: one flag, not one per poll
  fire('touchstart', tap(px, py)); input.poll(); assert.ok(input.menu & M_PAUSE);
  input.poll(); assert.equal(input.menu & M_PAUSE, 0, 'held: no second flag');
  fire('touchend', [], tap(px, py)); input.poll();
  // a tap on a neighbour pad (TURN) is a turn, not a pause
  const [tx, ty] = mid(L.pads[4]); input.resume();
  fire('touchstart', tap(tx, ty)); input.poll();
  assert.equal(input.menu & M_PAUSE, 0); assert.ok(input.word() & 64, 'TURN still turns');
  fire('touchend', [], tap(tx, ty));
  // a tap elsewhere is still a menu tap (a paused run resumes with it, as today)
  fire('touchstart', tap(422, 195)); fire('touchend', [], tap(422, 195)); input.poll();
  assert.ok(input.menu & M_FIRE, 'a tap in the field still gives M_FIRE');
});

// ---------- 3. the title ----------
function makeTitle() {
  const dots = [], texts = [], ui = { F: 0 };
  const gfx = { dot: (x, y, s) => { dots.push([x, y, s]); } };
  const text = (str, x, y, col, sc = 1, align = 'l') => {
    const w = textW(str, sc), x0 = align === 'c' ? x - w / 2 : align === 'r' ? x - w : x;
    texts.push({ str, x0, y0: y, x1: x0 + w, y1: y + 7 * sc });
  };
  const r = createRenderer({ gfx, text, ui });
  return { r, dots, texts, ui };
}
const card = dailyCard(12345, '2026-11-01');
const opts = o => Object.assign({ sel: 1, crtOn: true, muted: false, touch: false, best: '12345', page: 'main', card, dstate: 'ready', dmsg: '', used: false, reset: 'NEW DAILY IN 9H',
  status: '', statusCol: [1, 1, 1], warn: '' }, o);
const BEAM_SIZE = 3.1 * 0.55; // cell(): dot size 3.1 * sz, sz 0.55. No other title element is this size.

test('3a. no background beam dot lands on any title text, the Daily card, the card box, or the board page', () => {
  const variants = [opts({ sel: 1 }), opts({ sel: 0 }), opts({ sel: 0, used: true }), opts({ sel: 0, dstate: 'off', dmsg: 'OFFLINE' }),
    opts({ sel: 1, muted: true, status: 'SAVED ON THIS DEVICE', warn: 'SCORES NOT KEPT ON THIS DEVICE' }), opts({ sel: 1, touch: true }), opts({ page: 'table' })];
  let beams = 0, checked = 0;
  for (const o of variants) {
    for (let F = 0; F < 1500; F += 5) {
      const t = makeTitle(); t.ui.F = F; t.r.T[1] = 0;
      t.r.drawTitle(o);
      const boxes = t.texts.map(x => ({ x0: x.x0 - 1, y0: x.y0 - 1, x1: x.x1 + 1, y1: x.y1 + 1 }));
      if (o.page === 'table') boxes.push({ x0: 40, y0: 100, x1: 360, y1: 242 });
      else boxes.push({ x0: 212, y0: 100, x1: 212 + 172, y1: 100 + 92 }); // the card
      for (const d of t.dots) {
        if (Math.abs(d[2] - BEAM_SIZE) > 1e-6) continue;
        beams++;
        for (const b of boxes) if (d[0] >= b.x0 && d[0] <= b.x1 && d[1] >= b.y0 && d[1] <= b.y1) assert.fail(`beam dot at ${d[0].toFixed(1)},${d[1].toFixed(1)} on F ${F} (${JSON.stringify(b)})`);
        checked++;
      }
    }
  }
  assert.ok(beams > 2000, 'beams are still drawn at the edges: ' + beams);
  assert.ok(checked === beams);
});

test('3b. every line on the Daily and Free Play cards keeps a margin of 8 from the left and right edges and 4 from the bottom', () => {
  const lines = [];
  for (const rule of Object.keys(RULE_NOTE)) for (const used of [false, true]) {
    const c = Object.assign({}, card, { rule });
    const t = makeTitle(); t.r.drawTitle(opts({ sel: 0, card: c, used }));
    for (const x of t.texts) if (x.y0 >= 100 && x.y0 < 192 && x.x0 >= 212 - 1 && x.x1 <= 384 + 1) lines.push(x);
  }
  const t = makeTitle(); t.r.drawTitle(opts({ sel: 1 }));
  for (const x of t.texts) if (x.y0 >= 100 && x.y0 < 192 && x.x0 >= 212 && x.x1 <= 384) lines.push(x);
  assert.ok(lines.some(l => l.str === 'RANKED ATTEMPT READY') && lines.some(l => l.str === 'RANDOM SEED, ALL RUNS RANK'));
  for (const l of lines) {
    assert.ok(l.x0 - 212 >= 5 && 384 - l.x1 >= 8, `${l.str}: left ${l.x0 - 212}, right ${384 - l.x1}`);
    assert.ok(192 - l.y1 >= 4, `${l.str}: bottom margin ${192 - l.y1}`);
  }
});
