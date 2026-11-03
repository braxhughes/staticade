// STACKLIGHT PAUSE pad size sweep (node, no browser): the PAUSE pad never covers another pad or the field, at any landscape size.
//   1. size sweep through touchLayout: every landscape size from 480x260 to 1400x1000 in steps of 4 px, plus every height
//      (1 px steps) at six common widths, plus a notch-insets sweep: the six boxes (five pads and PAUSE) are each at least
//      44 x 44, no two of them come closer than 8 px, none comes within 8 px of the field, all stay 8 px inside the screen
//   2. the placement rule: right band above TURN when it fits, else left band above SOFT, else beside SOFT; none only when
//      the pads themselves are under 44 (then no touch pauses and nothing throws)
//   3. the hit test at the short sizes from the review: a finger down on the centre of each pad gives that pad's bits and no
//      pause; a finger down on PAUSE pauses and gives no word bit
//   4. a finger that slides onto PAUSE (steering on SOFT, TURN or LEFT) does not pause; a second finger landing elsewhere while
//      one rests on PAUSE does not pause again
import test from 'node:test';
import assert from 'node:assert/strict';
import { touchLayout, createInput, M_PAUSE, PAD_GAP } from '../games/stacklight/input.js';

const EPS = 1e-6;
const MIN = 44;
// the gap between two boxes (negative when they overlap): the larger of the horizontal and vertical gaps
const gap = (a, b) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
const NOTCH = { left: 47, right: 47, top: 0, bottom: 21 };

function check(w, h, ins) {
  const L = touchLayout(w, h, ins), tag = `${w}x${h}${ins ? ' insets' : ''}`;
  const il = ins ? ins.left : 0, ir = ins ? ins.right : 0, it = ins ? ins.top : 0, ib = ins ? ins.bottom : 0;
  if (!L.pause) return tag + ': no PAUSE pad';
  const six = L.pads.concat([L.pause]);
  for (const q of six) {
    if (!(q.w >= MIN - EPS && q.h >= MIN - EPS)) return `${tag}: ${q.name} is ${q.w.toFixed(1)} x ${q.h.toFixed(1)}`;
    if (gap(q, L.field) < PAD_GAP - EPS) return `${tag}: ${q.name} within ${gap(q, L.field).toFixed(1)} px of the field`;
    if (q.x < il + PAD_GAP - EPS || q.y < it + PAD_GAP - EPS || q.x + q.w > w - ir - PAD_GAP + EPS || q.y + q.h > h - ib - PAD_GAP + EPS)
      return `${tag}: ${q.name} off the screen margins`;
  }
  for (let i = 0; i < six.length; i++) for (let j = i + 1; j < six.length; j++) {
    const g = gap(six[i], six[j]);
    if (g < PAD_GAP - EPS) return `${tag}: ${six[i].name} and ${six[j].name} ${g < 0 ? 'overlap' : 'are ' + g.toFixed(1) + ' px apart'} ` +
      `(${six[j].name} y ${six[j].y.toFixed(1)} to ${(six[j].y + six[j].h).toFixed(1)}, ${six[i].name} y ${six[i].y.toFixed(1)} to ${(six[i].y + six[i].h).toFixed(1)})`;
  }
  return null;
}

test('1. size sweep: six pads, each 44 x 44 or more, 8 px apart, clear of the field, at every landscape size', () => {
  const bad = [];
  let n = 0;
  const run = (w, h, ins) => { n++; const e = check(w, h, ins); if (e) bad.push(e); };
  for (let w = 480; w <= 1400; w += 4) for (let h = 260; h <= 1000 && h < w; h += 4) run(w, h);
  for (const w of [568, 667, 740, 844, 932, 1024, 1366]) for (let h = 260; h < w && h <= 1000; h++) run(w, h); // 1 px near every cut-off
  for (let w = 600; w <= 1400; w += 8) for (let h = 280; h <= 1000 && h < w; h += 8) run(w, h, NOTCH);
  assert.ok(n > 40000, 'sizes checked: ' + n);
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} of ${n} sizes fail, first: ${bad[0]}`);
});

test('2. the placement rule, size by size', () => {
  const tier = L => !L.pause ? 'none' : L.pause.x > L.field.x ? 'right' : L.pause.y < L.pads[2].y ? 'above-soft' : 'beside-soft';
  // the four phone sizes keep the earlier place (right band, above TURN, 48 high)
  for (const [w, h] of [[844, 390], [932, 430], [667, 375], [568, 320]]) {
    const L = touchLayout(w, h);
    assert.equal(tier(L), 'right', `${w}x${h}`); assert.equal(L.pause.h, 48);
    assert.ok(L.pads[4].y - (L.pause.y + L.pause.h) >= PAD_GAP - EPS);
  }
  // short landscape (Safari bars showing): the left band above SOFT
  for (const [w, h] of [[844, 350], [844, 340], [932, 400], [844, 320], [667, 300], [932, 380]]) {
    const L = touchLayout(w, h);
    assert.equal(tier(L), 'above-soft', `${w}x${h}`);
    assert.ok(L.pads[2].y - (L.pause.y + L.pause.h) >= PAD_GAP - EPS, `${w}x${h} above SOFT`);
  }
  // wide and short: both stacks fill the height, so PAUSE sits beside SOFT, which keeps the rest of its row
  for (const [w, h] of [[844, 260], [1400, 260], [1366, 400]]) {
    const L = touchLayout(w, h), s = L.pads[2];
    assert.equal(tier(L), 'beside-soft', `${w}x${h}`);
    assert.equal(L.pause.y, s.y); assert.ok(s.x >= L.pause.x + L.pause.w + PAD_GAP - EPS);
    assert.ok(Math.abs(s.x + s.w - (L.field.x - PAD_GAP)) < EPS, `${w}x${h} SOFT still ends 8 px from the field`);
  }
  // tall-narrow landscape: right band
  assert.equal(tier(touchLayout(1024, 760)), 'right');
  // no room even for the five pads at 44 (h under 112): no PAUSE pad, and a finger anywhere never pauses
  const L = touchLayout(700, 100);
  assert.equal(L.pause, null);
  const { input, fire } = rig(L);
  input.pauseLive = true; input.beginRun();
  for (let x = 4; x < 700; x += 37) for (let y = 4; y < 100; y += 23) {
    fire('touchstart', [pt(x, y)]); input.poll(); assert.equal(input.menu & M_PAUSE, 0, `${x},${y}`);
    fire('touchend', [], [pt(x, y)]); input.poll(); input.word();
  }
});

const pt = (x, y) => ({ clientX: x, clientY: y });
function rig(layout) {
  const T = {}, S = {}, add = o => (n, f) => { (o[n] || (o[n] = [])).push(f); };
  const target = { addEventListener: add(T), removeEventListener() {}, innerWidth: layout.w, innerHeight: layout.h };
  const surface = { addEventListener: add(S), removeEventListener() {} };
  const input = createInput({ target, surface, doc: null, getGamepads: () => [], layout });
  const fire = (type, touches, changed = touches) => { for (const f of S[type]) f({ type, touches, changedTouches: changed, preventDefault() {} }); };
  return { input, fire };
}
const mid = q => pt(q.x + q.w / 2, q.y + q.h / 2);
const BITS = { left: 1 | 8, right: 2 | 16, soft: 4, hard: 32, rotate: 64 };

test('3. at the short sizes, a finger down on each pad centre gives that pad only; on PAUSE, a pause and no word bit', () => {
  for (const [w, h] of [[844, 340], [932, 400], [844, 320], [667, 300], [844, 260], [1400, 260], [844, 390]]) {
    const L = touchLayout(w, h), tag = `${w}x${h}`;
    const { input, fire } = rig(L);
    input.pauseLive = true; input.beginRun();
    for (const q of L.pads) {
      const p = mid(q);
      fire('touchstart', [p]); input.poll();
      assert.equal(input.menu & M_PAUSE, 0, `${tag}: ${q.name} does not pause`);
      assert.equal(input.word(), BITS[q.name], `${tag}: ${q.name} bits`);
      fire('touchend', [], [p]); input.poll(); input.word(); input.poll(); input.word();
    }
    const p = mid(L.pause);
    fire('touchstart', [p]); input.poll();
    assert.ok(input.menu & M_PAUSE, `${tag}: PAUSE pauses`);
    assert.equal(input.word(), 0, `${tag}: PAUSE sets no word bit`);
    fire('touchend', [], [p]); input.poll(); input.word();
  }
});

test('4. a finger sliding onto PAUSE does not pause; a second finger elsewhere does not pause again', () => {
  for (const [w, h] of [[844, 390], [844, 340], [932, 400], [1400, 260], [844, 260]]) {
    const L = touchLayout(w, h), tag = `${w}x${h}`, P = L.pause;
    const { input, fire } = rig(L);
    input.pauseLive = true; input.beginRun();
    // from every pad, slide in 2 px steps straight to the PAUSE centre and lift there
    for (const q of L.pads) {
      const a = mid(q), b = mid(P);
      fire('touchstart', [a]); input.poll(); assert.equal(input.menu & M_PAUSE, 0); input.word();
      for (let k = 1; k <= 200; k++) {
        const c = pt(a.clientX + (b.clientX - a.clientX) * k / 200, a.clientY + (b.clientY - a.clientY) * k / 200);
        fire('touchmove', [c]); input.poll();
        assert.equal(input.menu & M_PAUSE, 0, `${tag}: a finger from ${q.name} slid onto PAUSE and paused`);
        input.word();
      }
      fire('touchend', [], [b]); input.poll(); input.word();
    }
    // a finger resting on PAUSE (one pause), then a second finger lands on LEFT: no second pause
    const p = mid(P), l = mid(L.pads[0]);
    fire('touchstart', [p]); input.poll(); assert.ok(input.menu & M_PAUSE, tag); input.word();
    fire('touchstart', [p, l], [l]); input.poll(); assert.equal(input.menu & M_PAUSE, 0, tag + ': second finger');
    fire('touchend', [p], [l]); fire('touchend', [], [p]); input.poll();
  }
});
