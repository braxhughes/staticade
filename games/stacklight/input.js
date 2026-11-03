// STACKLIGHT input: keyboard, gamepad and touch pads to the 16-bit C.2 input word, plus the menu flags.
// Design: the STACKLIGHT design notes C.2 (word) and E (controls and the side-band layout). No drawing here (T3 draws
// the pads); no DOM except the injected target / surface. Imports in Node.
//
// Word bits: 0 LEFT held, 1 RIGHT held, 2 SOFT held, 3 LEFT pressed, 4 RIGHT pressed, 5 HARD pressed, 6 ROTATE pressed.
// Bits 7 to 15 are always 0. Pressed bits are latched when the press happens (a tap shorter than a frame is never lost)
// and consumed by word(). Auto-repeat lives in the sim, not here. C.2: "the input layer never packs the same pressed bit
// two frames in a row": a new press latched while the previous word carried that bit is packed one frame later.
//
// CALL CONTRACT (T3 and every page that steps a STACKLIGHT sim must follow it):
//   1. Every tick: input.poll() first, then read input.menu. On a tick where a sim frame runs, call sim.step(input.word())
//      exactly once, after poll(). Never call word() on a tick where no sim frame runs (menu, pause, results, a hold).
//   2. Run start: right after createSim(...) and before the first word() of that run, call input.beginRun(). It drops
//      every latched press (menu Enter / Up / Left and so on), the menu flags not yet read, and the previous word's
//      pressed bits (a new sim starts with previous word 0, so nothing is held back).
//   3. Leaving pause (or any hold where sim frames stopped and the same sim carries on): call input.resume() before the
//      next word(). It drops latched presses and unread menu flags but KEEPS the previous word's pressed bits, because
//      the sim still remembers that word (C.2): a same-bit tap on the first resumed frame is then packed one frame later
//      instead of being ignored by the sim.
//   clearLatches() is kept for engine/input.js call-shape parity; it does what resume() does, so it is safe at either
//   point (at run start it can only add one frame of latency, never lose or invent a press).
// Safety net, in case a page forgets 2 or 3: a poll() that follows a poll() with no word(), beginRun() or resume() in
// between marks the input as out of a run, and the next word() then drops every latched press before packing (held
// bits still pass). So a menu or pause press can never reach the sim; forgetting the call costs at most a press made in
// the one tick between leaving the menu and the first word. A new input counts as just begun.
//
// Hard drop (Enter / Space) and menu confirm (M_FIRE) are separate outputs: one key press sets both. That is safe only
// because of the contract above: the Enter that starts a run or resumes it is dropped by beginRun() / resume().
// Touch in menus follows engine/input.js: a one-finger tap (moves under 16 px) is M_FIRE, a vertical swipe of 48 px is
// M_UP / M_DOWN; a mouse button on the surface is M_FIRE. A tap on a pad also counts as a menu tap; in a run the page
// ignores M_FIRE (except on the pause screen, where resume() then drops the pad's press). Gamepad sticks are ignored on
// purpose: E's table is d-pad only (the engine reads axes; STACKLIGHT does not). Gamepad state is never reset by blur
// or a hidden page (as in engine/input.js): it is polled, so a button held across blur is not a new press afterwards.
import { IN_LEFT, IN_RIGHT, IN_SOFT, IN_LEFT_PRESS, IN_RIGHT_PRESS, IN_HARD_PRESS, IN_ROT_PRESS, IN_PRESS_BITS } from './defs.js';
import { M_UP, M_DOWN, M_FIRE, M_ALT, M_BACK, M_ANY, M_PAUSE, M_MUTE } from '../../engine/input.js';

export { M_UP, M_DOWN, M_FIRE, M_ALT, M_BACK, M_ANY, M_PAUSE, M_MUTE };

// E control table. Names match engine/input.js where they exist (left, right, up, down, fire, alt, back, pause, mute).
export const DEFAULT_BINDINGS = {
  left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'], soft: ['ArrowDown', 'KeyS'],
  hard: ['Space', 'Enter'], rotate: ['ArrowUp', 'KeyW', 'KeyX', 'KeyK'],
  // menu navigation and confirm (flags only)
  up: ['ArrowUp', 'KeyW'], down: ['ArrowDown', 'KeyS'], fire: ['Space', 'Enter'], alt: ['KeyX', 'KeyK'],
  back: ['Escape'], pause: 'KeyP', mute: 'KeyM',
  prevent: ['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
};

// E touch pads
export const PAD_LEFT = 0, PAD_RIGHT = 1, PAD_SOFT = 2, PAD_HARD = 3, PAD_ROTATE = 4, PAD_COUNT = 5;
export const PAD_NAMES = ['left', 'right', 'soft', 'hard', 'rotate'];
const PAD_HELD = [IN_LEFT, IN_RIGHT, IN_SOFT, 0, 0];
const PAD_PRESS = [IN_LEFT_PRESS, IN_RIGHT_PRESS, 0, IN_HARD_PRESS, IN_ROT_PRESS];
// PAUSE is drawn and hit tested like a pad but is not one of the five word pads: a press is the P key (M_PAUSE), never a word bit
export const PAD_PAUSE = 5, PAUSE_H = 48;
export const FIELD_W = 400, FIELD_H = 300, MIN_BAND = 112, PAD_GAP = 8, PAD_MIN = 44;
// engine/input.js gesture thresholds (menu tap and swipe)
export const SWIPE_PX = 48, TAP_PX = 16;

const NO_INSETS = { left: 0, right: 0, top: 0, bottom: 0 };

// E: pure layout. w, h = layout viewport (innerWidth, innerHeight); insets = safe-area insets, subtracted here. Result
// boxes are in viewport CSS px. Field scale = min(h / 300, (w - 224) / 400); the field is centred; each band is
// (w - field width) / 2 wide. Move pads: two side by side at the bottom of the left band; soft drop above them (full band
// width less margins); hard drop at the bottom of the right band, rotate above it. Every pad keeps an 8 px margin to the
// band edges and the field, and 8 px between pads. Pad heights are capped by the available height, so on wide, short
// screens the stacks shrink instead of running off the top (they stay at least 44 px while h is at least 112).
export function touchLayout(w, h, insets = NO_INSETS) {
  const il = insets.left || 0, ir = insets.right || 0, it = insets.top || 0, ib = insets.bottom || 0;
  const aw = w - il - ir, ah = h - it - ib;
  let scale = Math.min(ah / FIELD_H, (aw - 2 * MIN_BAND) / FIELD_W);
  if (!(scale > 0)) scale = 0;
  const fw = FIELD_W * scale, fh = FIELD_H * scale, band = (aw - fw) / 2;
  const fx = il + band, fy = it + (ah - fh) / 2;
  const mk = (id, x, y, bw, bh) => ({ id, name: PAD_NAMES[id], x, y, w: bw, h: bh, held: PAD_HELD[id], press: PAD_PRESS[id] });
  const stackH = Math.max(0, (ah - 3 * PAD_GAP) / 2); // two pads, a gap, and the top and bottom margins fit in ah
  const pw = (band - 3 * PAD_GAP) / 2, ph = Math.min(pw, stackH); // 44 at the 112 px minimum
  const bottom = it + ah - PAD_GAP, lx = il + PAD_GAP, rx = il + band + fw + PAD_GAP, bigW = band - 2 * PAD_GAP;
  const bigH = Math.min(bigW, stackH);
  const pads = [
    mk(PAD_LEFT, lx, bottom - ph, pw, ph),
    mk(PAD_RIGHT, lx + pw + PAD_GAP, bottom - ph, pw, ph),
    mk(PAD_SOFT, lx, bottom - ph - PAD_GAP - ph, bigW, ph),
    mk(PAD_HARD, rx, bottom - bigH, bigW, bigH),
    mk(PAD_ROTATE, rx, bottom - 2 * bigH - PAD_GAP, bigW, bigH)
  ];
  // the PAUSE pad. Not in pads. It never overlaps a pad or the field and is always at least 44 x 44 (PAD_MIN):
  //   1. room above TURN (44 px or more): top of the right band, above TURN, up to 48 high (the four phone sizes);
  //   2. else room above SOFT: top of the left band, above SOFT, up to 48 high;
  //   3. else (both stacks fill the height, wide short screens): beside SOFT at the outer edge of the left band, up to 48 wide,
  //      SOFT's height (up to 48); SOFT keeps the rest of its row (44 px or more, as the band is at least 112);
  //   4. else (only when the pads themselves are under 44, ah < 112): no PAUSE pad (pause is null); P, Start, Esc and turning
  //      the phone upright still pause.
  const py0 = it + PAD_GAP, soft = pads[PAD_SOFT];
  const roomR = pads[PAD_ROTATE].y - PAD_GAP - py0, roomL = soft.y - PAD_GAP - py0, sideW = Math.min(PAUSE_H, bigW - PAD_GAP - PAD_MIN);
  let pause = null;
  if (roomR >= PAD_MIN) pause = { id: PAD_PAUSE, name: 'pause', x: rx, y: py0, w: bigW, h: Math.min(PAUSE_H, roomR) };
  else if (roomL >= PAD_MIN) pause = { id: PAD_PAUSE, name: 'pause', x: lx, y: py0, w: bigW, h: Math.min(PAUSE_H, roomL) };
  else if (soft.h >= PAD_MIN && sideW >= PAD_MIN) {
    pause = { id: PAD_PAUSE, name: 'pause', x: lx, y: soft.y, w: sideW, h: Math.min(PAUSE_H, soft.h) };
    soft.x = lx + sideW + PAD_GAP; soft.w = bigW - sideW - PAD_GAP;
  }
  return { w, h, insets: { left: il, right: ir, top: it, bottom: ib }, scale, band, field: { x: fx, y: fy, w: fw, h: fh }, pads, pause };
}

const btn = (bt, n) => bt[n] !== undefined && bt[n].pressed;

// opts: target (keyboard/blur events, default window), surface (touch and mouse events), bindings, layout (a touchLayout
// result, or a function returning one; default: touchLayout(target.innerWidth, target.innerHeight, insets), cached and
// rebuilt only when one of those numbers changes), insets (safe-area insets {left, right, top, bottom} for the default
// layout; the page may update the object's fields), doc (for visibilitychange, default document), getGamepads (default
// navigator.getGamepads), onGesture (first-interaction hook, e.g. audio unlock).
// `toField` is accepted for call-shape parity with engine/input.js and unused (touch here is pads, not a field position).
export function createInput({ target = globalThis.window, surface, bindings = DEFAULT_BINDINGS, layout, insets, doc = globalThis.document,
  getGamepads, onGesture } = {}) {
  const B = bindings, keys = Object.create(null);
  const gamepads = getGamepads || (typeof navigator !== 'undefined' && navigator.getGamepads ? () => navigator.getGamepads() : null);
  let pending = 0;      // menu flags since the last poll
  let latch = 0;        // pressed bits latched since the last word()
  let lastPressed = 0;  // pressed bits packed in the previous word
  let heldPad = 0;      // pads under a finger, as a bitmask of pad ids
  let gpHeld = 0;       // gamepad held bits (IN_*) from the last poll
  // gamepad buttons at the previous poll (for edges). Never reset by blur or hide: the pad is polled, so its state is true.
  let pgHard = false, pgRot = false, pgStart = false, pgBack = false, pgUp = false, pgDown = false, pgAlt = false;
  let pgLeft = false, pgRight = false;
  // run state (see the call contract): live = presses may reach the sim; the two flags record what happened since poll
  let live = true, wordSincePoll = false, armedSincePoll = true;
  // touch menu gesture (engine/input.js rules)
  let gActive = false, gMulti = false, gSwiped = false, gx0 = 0, gy0 = 0;
  let curLayout = typeof layout === 'function' ? null : layout || null;
  const layoutFn = typeof layout === 'function' ? layout : null;
  let cache = null, cW = -1, cH = -1, cL = -1, cR = -1, cT = -1, cB = -1;
  let gOnPause = false; // the gesture started on the PAUSE pad (its tap is not a menu tap)
  // pauseLive: main.js sets it true only in a run in play (not on the title, the results, the entry or behind the rotate screen)
  const api = { menu: 0, touchActive: false, pauseLive: false };
  const inBox = (q, x, y) => x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h;

  const any = list => { for (let i = 0; i < list.length; i++) if (keys[list[i]]) return true; return false; };
  const has = (list, code) => list.indexOf(code) >= 0;
  const gesture = () => { if (onGesture) onGesture(); };
  const getLayout = () => {
    if (layoutFn) return layoutFn();
    if (curLayout) return curLayout;
    const ins = insets || NO_INSETS;
    const w = target.innerWidth || 0, h = target.innerHeight || 0;
    const l = ins.left || 0, r = ins.right || 0, t = ins.top || 0, b = ins.bottom || 0;
    if (!cache || w !== cW || h !== cH || l !== cL || r !== cR || t !== cT || b !== cB) {
      cache = touchLayout(w, h, ins); cW = w; cH = h; cL = l; cR = r; cT = t; cB = b;
    }
    return cache;
  };

  function onKeyDown(e) {
    if (has(B.prevent, e.code)) e.preventDefault();
    keys[e.code] = true; gesture();
    if (e.repeat) return; // auto-repeat is the sim's job; OS key repeat never makes pressed bits
    const c = e.code;
    if (c !== B.mute) pending |= M_ANY;
    if (c === B.pause) pending |= M_PAUSE;
    if (c === B.mute) pending |= M_MUTE;
    if (has(B.fire, c)) pending |= M_FIRE;
    if (has(B.alt, c)) pending |= M_ALT;
    if (has(B.up, c)) pending |= M_UP;
    if (has(B.down, c)) pending |= M_DOWN;
    if (has(B.back, c)) pending |= M_BACK;
    if (has(B.left, c)) latch |= IN_LEFT_PRESS;
    if (has(B.right, c)) latch |= IN_RIGHT_PRESS;
    if (has(B.hard, c)) latch |= IN_HARD_PRESS;
    if (has(B.rotate, c)) latch |= IN_ROT_PRESS;
  }
  function onKeyUp(e) { keys[e.code] = false; }
  // keys and touches cannot be read back after blur or hide, so they are released. The gamepad is left alone (polled).
  function releaseAll() {
    for (const k in keys) keys[k] = false;
    heldPad = 0; latch = 0; api.touchActive = false; gActive = false; gOnPause = false;
  }
  function onVis() { if (doc && doc.hidden) releaseAll(); }

  // Touch: pads currently under any finger, recomputed from ev.touches on every event, so a finger that slides out of a
  // pad releases it and one that slides into a pad holds it. A pad newly under a finger latches its pressed bit.
  // The same events also drive the menu gesture (tap = M_FIRE, vertical swipe = M_UP / M_DOWN).
  function onTouch(ev) {
    if (ev.preventDefault) ev.preventDefault();
    gesture();
    const L = getLayout(), t = ev.touches, pads = L.pads, type = ev.type, ch = ev.changedTouches;
    let now = 0;
    for (let i = 0; i < t.length; i++) {
      const x = t[i].clientX, y = t[i].clientY;
      for (let p = 0; p < pads.length; p++) {
        const q = pads[p];
        if (x >= q.x && x < q.x + q.w && y >= q.y && y < q.y + q.h) { now |= 1 << p; break; }
      }
    }
    // only a finger that comes DOWN on the PAUSE pad pauses (the same as P). A finger that slides onto it (a thumb steering
    // on SOFT or TURN) does not, and a second finger landing elsewhere while one rests on it does not pause again.
    if (type === 'touchstart' && api.pauseLive && L.pause) {
      const cs = ch && ch.length ? ch : t;
      for (let i = 0; i < cs.length; i++) if (inBox(L.pause, cs[i].clientX, cs[i].clientY)) { pending |= M_PAUSE | M_ANY; break; }
    }
    const added = now & ~heldPad;
    if (added) {
      for (let p = 0; p < pads.length; p++) if (added & (1 << p)) latch |= pads[p].press;
      pending |= M_ANY;
    }
    heldPad = now; api.touchActive = t.length > 0;

    if (type === 'touchstart') {
      const c0 = ch && ch.length ? ch[0] : t[0];
      if (!gActive && c0) {
        gActive = true; gMulti = false; gSwiped = false; gx0 = c0.clientX; gy0 = c0.clientY;
        gOnPause = !!(api.pauseLive && L.pause && inBox(L.pause, gx0, gy0));
      }
      if (t.length >= 2) gMulti = true;
    } else if (type === 'touchmove' && gActive && !gMulti && t.length) {
      const dy = t[0].clientY - gy0, dx = t[0].clientX - gx0;
      if (Math.abs(dy) >= SWIPE_PX && Math.abs(dy) > Math.abs(dx)) {
        pending |= (dy < 0 ? M_UP : M_DOWN) | M_ANY; gSwiped = true; gy0 = t[0].clientY; gx0 = t[0].clientX;
      }
    }
    if (!t.length) {
      if (gActive && type === 'touchend' && !gMulti && !gSwiped && ch && ch.length) {
        const dx = ch[0].clientX - gx0, dy = ch[0].clientY - gy0;
        if (Math.abs(dy) >= SWIPE_PX && Math.abs(dy) > Math.abs(dx)) pending |= (dy < 0 ? M_UP : M_DOWN) | M_ANY;
        else if (Math.abs(dx) < TAP_PX && Math.abs(dy) < TAP_PX && !gOnPause) pending |= M_FIRE | M_ANY; // a tap on PAUSE paused; its lift must not resume
      }
      gActive = false;
    }
  }
  function onMouse() { gesture(); pending |= M_FIRE | M_ANY; }

  const touchNames = ['touchstart', 'touchmove', 'touchend', 'touchcancel'];
  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', releaseAll);
  if (doc) doc.addEventListener('visibilitychange', onVis);
  if (surface) {
    for (const n of touchNames) surface.addEventListener(n, onTouch, { passive: false });
    surface.addEventListener('mousedown', onMouse);
  }
  api.dispose = function dispose() {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', onKeyUp);
    target.removeEventListener('blur', releaseAll);
    if (doc) doc.removeEventListener('visibilitychange', onVis);
    if (surface) {
      for (const n of touchNames) surface.removeEventListener(n, onTouch, { passive: false });
      surface.removeEventListener('mousedown', onMouse);
    }
    releaseAll(); pending = 0;
  };
  api.setLayout = function setLayout(l) { curLayout = l; };
  // the layout the touch hit test uses right now (T3 draws the pads from this, so drawn and hit areas match)
  api.getLayout = getLayout;
  api.releaseAll = releaseAll;
  // contract step 2: a new run (a new sim, previous word 0)
  api.beginRun = function beginRun() { latch = 0; pending = 0; lastPressed = 0; live = true; armedSincePoll = true; };
  // contract step 3: the same sim carries on after a pause or hold (the sim still remembers the previous word)
  api.resume = function resume() { latch = 0; pending = 0; live = true; armedSincePoll = true; };
  api.clearLatches = api.resume;

  api.poll = function poll() {
    if (!wordSincePoll && !armedSincePoll) live = false; // a tick passed with no sim frame: out of a run (safety net)
    wordSincePoll = false; armedSincePoll = false;
    let gl = false, gr = false, gu = false, gd = false, gh = false, grot = false, gx = false, gstart = false, gback = false;
    const gps = gamepads ? gamepads() : null;
    if (gps) for (let i = 0; i < gps.length; i++) {
      const g = gps[i]; if (!g) continue;
      const bt = g.buttons;
      if (btn(bt, 14)) gl = true;
      if (btn(bt, 15)) gr = true;
      if (btn(bt, 13)) gd = true;
      if (btn(bt, 12)) { gu = true; gh = true; }  // d-pad up: hard drop
      if (btn(bt, 2)) { gx = true; gh = true; }   // X: hard drop
      if (btn(bt, 0)) grot = true;                // A: rotate
      if (btn(bt, 9)) gstart = true;
      if (btn(bt, 8) || btn(bt, 1)) gback = true;
    }
    // gamepad edges: a button held across polls gives one pressed bit, on its first poll
    if (gh && !pgHard) latch |= IN_HARD_PRESS;
    if (grot && !pgRot) latch |= IN_ROT_PRESS;
    if (gl && !pgLeft) latch |= IN_LEFT_PRESS;
    if (gr && !pgRight) latch |= IN_RIGHT_PRESS;
    if (grot && !pgRot) { pending |= M_FIRE | M_ANY; }
    if (gx && !pgAlt) { pending |= M_ALT | M_ANY; }
    if (gu && !pgUp) pending |= M_UP | M_ANY;
    if (gd && !pgDown) pending |= M_DOWN | M_ANY;
    if (gstart && !pgStart) pending |= M_PAUSE | M_ANY;
    if (gback && !pgBack) pending |= M_BACK | M_ANY;
    pgHard = gh; pgRot = grot; pgUp = gu; pgDown = gd; pgAlt = gx; pgStart = gstart; pgBack = gback; pgLeft = gl; pgRight = gr;
    gpHeld = (gl ? IN_LEFT : 0) | (gr ? IN_RIGHT : 0) | (gd ? IN_SOFT : 0);
    api.menu = pending; pending = 0;
  };

  // the gameplay word for this tick; consumes the pressed latches. Bits 7 to 15 are never set.
  api.word = function word() {
    wordSincePoll = true;
    if (!live) { latch = 0; live = true; } // safety net: presses from outside a run never reach the sim
    let held = gpHeld;
    if (any(B.left)) held |= IN_LEFT;
    if (any(B.right)) held |= IN_RIGHT;
    if (any(B.soft)) held |= IN_SOFT;
    if (heldPad) {
      if (heldPad & (1 << PAD_LEFT)) held |= IN_LEFT;
      if (heldPad & (1 << PAD_RIGHT)) held |= IN_RIGHT;
      if (heldPad & (1 << PAD_SOFT)) held |= IN_SOFT;
    }
    const out = latch & IN_PRESS_BITS & ~lastPressed; // never the same pressed bit two frames running
    latch &= ~out; lastPressed = out;
    return (held | out) & 0x7f;
  };
  return api;
}
