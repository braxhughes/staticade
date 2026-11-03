// One input layer for every game: keyboard + gamepad, plus a touch adapter.
// Each tick call poll(); then read `menu` (bit flags for menu/app events this tick) and, while
// a run is live, word() (the compact gameplay input word, see input-word.js; reading it consumes
// the "pressed" latches). Keys release on window blur and when the page is hidden.
import { packWord } from './input-word.js';

export const M_UP = 1, M_DOWN = 2, M_FIRE = 4, M_ALT = 8, M_BACK = 16, M_ANY = 32, M_PAUSE = 64, M_MUTE = 128;

export const DEFAULT_BINDINGS = {
  left: ['ArrowLeft', 'KeyA'], right: ['ArrowRight', 'KeyD'], up: ['ArrowUp', 'KeyW'], down: ['ArrowDown', 'KeyS'],
  fire: ['Space', 'KeyZ', 'Enter'], alt: ['KeyX', 'KeyK', 'ShiftLeft', 'ShiftRight'], back: ['Escape', 'Backspace'],
  pause: 'KeyP', mute: 'KeyM', prevent: ['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
};

const SWIPE_PX = 48, TAP_PX = 16;
const btn = (bt, n) => bt[n] !== undefined && bt[n].pressed;

export function createInput({ target = window, surface, toField, onGesture, excludeStart, bindings = DEFAULT_BINDINGS } = {}) {
  const B = bindings, keys = Object.create(null);
  let pending = 0;
  let latchFire = false, latchAlt = false;
  // gamepad state from the previous poll (for edges)
  let pgFire = false, pgAlt = false, pgUp = false, pgDown = false, pgBack = false;
  // touch
  let touchActive = false, touchX = 0, touchFire = false;
  let gActive = false, gMulti = false, gSwiped = false, gx0 = 0, gy0 = 0;
  // fingers whose touchstart landed where excludeStart(clientX, clientY) is true (the touch PAUSE button) are not ours: they
  // never steer, fire, kindle, tap or swipe. Their ids live in a fixed array (no allocation per event).
  const MAXEX = 8, exIds = new Int32Array(MAXEX); let exN = 0;
  const exHas = id => { for (let i = 0; i < exN; i++) if (exIds[i] === id) return true; return false; };
  const inList = (list, id) => { for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return true; return false; };
  function exPrune(list) { for (let i = exN - 1; i >= 0; i--) if (!inList(list, exIds[i])) exIds[i] = exIds[--exN]; }
  // results of the last poll
  const api = { menu: 0, move: 0, fire: false, touchActive: false };

  const any = list => { for (let i = 0; i < list.length; i++) if (keys[list[i]]) return true; return false; };
  const gesture = () => { if (onGesture) onGesture(); };

  function onKeyDown(e) {
    if (B.prevent.indexOf(e.code) >= 0) e.preventDefault();
    keys[e.code] = true; gesture();
    if (e.repeat) return;
    if (e.code !== B.mute) pending |= M_ANY;
    if (e.code === B.pause) pending |= M_PAUSE;
    if (e.code === B.mute) pending |= M_MUTE;
    if (B.fire.indexOf(e.code) >= 0) { latchFire = true; pending |= M_FIRE; }
    if (B.alt.indexOf(e.code) >= 0) { latchAlt = true; pending |= M_ALT; }
    if (B.up.indexOf(e.code) >= 0) pending |= M_UP;
    if (B.down.indexOf(e.code) >= 0) pending |= M_DOWN;
    if (B.back.indexOf(e.code) >= 0) pending |= M_BACK;
  }
  function onKeyUp(e) { keys[e.code] = false; }
  function releaseAll() {
    for (const k in keys) keys[k] = false;
    touchActive = false; touchFire = false; gActive = false; exN = 0;
    latchFire = latchAlt = false;
  }
  function onVis() { if (document.hidden) releaseAll(); }

  // touch adapter: in play the first finger steers and fires, a second finger kindles.
  // In menus a tap is FIRE (select) and a vertical swipe is UP/DOWN.
  function onTouch(ev) {
    ev.preventDefault(); gesture();
    if (excludeStart) {
      const cl = ev.changedTouches;
      let allEx = cl.length > 0;
      if (ev.type === 'touchstart') {
        exPrune(ev.touches); // an id left behind by a lost touchend must not eat a later finger
        for (let i = 0; i < cl.length; i++) {
          if (exN < MAXEX && excludeStart(cl[i].clientX, cl[i].clientY)) exIds[exN++] = cl[i].identifier; else allEx = false;
        }
      } else for (let i = 0; i < cl.length; i++) if (!exHas(cl[i].identifier)) { allEx = false; break; }
      if (!allEx) handle(ev);
      if (exN) exPrune(ev.touches);
    } else handle(ev);
  }
  function handle(ev) {
    const t = ev.touches, type = ev.type;
    let n = 0, t0 = null; // the fingers that count: not on the excluded box
    for (let i = 0; i < t.length; i++) if (!exHas(t[i].identifier)) { if (!t0) t0 = t[i]; n++; }
    let c0 = null; // the first changed finger that counts
    for (let i = 0; i < ev.changedTouches.length; i++) if (!exHas(ev.changedTouches[i].identifier)) { c0 = ev.changedTouches[i]; break; }
    if (type === 'touchstart') {
      latchFire = true;
      if (!gActive && c0) { gActive = true; gMulti = false; gSwiped = false; gx0 = c0.clientX; gy0 = c0.clientY; }
      if (n >= 2) { latchAlt = true; gMulti = true; }
    } else if (type === 'touchmove' && gActive && !gMulti && t0) {
      const dy = t0.clientY - gy0, dx = t0.clientX - gx0;
      if (Math.abs(dy) >= SWIPE_PX && Math.abs(dy) > Math.abs(dx)) { pending |= dy < 0 ? M_UP : M_DOWN; gSwiped = true; gy0 = t0.clientY; gx0 = t0.clientX; }
    }
    if (!n) {
      touchActive = false; touchFire = false;
      if (gActive && type === 'touchend' && !gMulti && !gSwiped && c0) {
        const dx = c0.clientX - gx0, dy = c0.clientY - gy0;
        if (Math.abs(dy) >= SWIPE_PX && Math.abs(dy) > Math.abs(dx)) pending |= dy < 0 ? M_UP : M_DOWN;
        else if (Math.abs(dx) < TAP_PX && Math.abs(dy) < TAP_PX) pending |= M_FIRE;
      }
      gActive = false;
      return;
    }
    touchActive = true; touchFire = true;
    touchX = toField ? toField(t0.clientX, t0.clientY) : t0.clientX;
  }
  function onMouse() { gesture(); latchFire = true; pending |= M_FIRE; }

  const touchNames = ['touchstart', 'touchmove', 'touchend', 'touchcancel'];
  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', releaseAll);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
  if (surface) {
    for (const n of touchNames) surface.addEventListener(n, onTouch, { passive: false });
    surface.addEventListener('mousedown', onMouse);
  }
  // take every listener back off (leaving a game for the lobby); the object is dead after this
  api.dispose = function dispose() {
    target.removeEventListener('keydown', onKeyDown);
    target.removeEventListener('keyup', onKeyUp);
    target.removeEventListener('blur', releaseAll);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
    if (surface) {
      for (const n of touchNames) surface.removeEventListener(n, onTouch, { passive: false });
      surface.removeEventListener('mousedown', onMouse);
    }
    releaseAll(); pending = 0;
  };

  api.poll = function poll() {
    let gl = false, gr = false, gu = false, gd = false, gf = false, ga = false, gb = false, ax = 0;
    const gps = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : null;
    if (gps) for (let i = 0; i < gps.length; i++) {
      const g = gps[i]; if (!g) continue;
      const bt = g.buttons;
      if (Math.abs(g.axes[0]) > 0.3) ax = g.axes[0];
      if (g.axes[1] < -0.5 || btn(bt, 12)) gu = true;
      if (g.axes[1] > 0.5 || btn(bt, 13)) gd = true;
      if (btn(bt, 14)) gl = true; if (btn(bt, 15)) gr = true;
      if (btn(bt, 0) || btn(bt, 9) || btn(bt, 7)) gf = true;
      if (btn(bt, 2) || btn(bt, 3) || btn(bt, 6)) ga = true;
      if (btn(bt, 1)) gb = true;
    }
    if (gf && !pgFire) { latchFire = true; pending |= M_FIRE | M_ANY; }
    if (ga && !pgAlt) { latchAlt = true; pending |= M_ALT | M_ANY; }
    if (gu && !pgUp) pending |= M_UP;
    if (gd && !pgDown) pending |= M_DOWN;
    if (gb && !pgBack) pending |= M_BACK | M_ANY;
    pgFire = gf; pgAlt = ga; pgUp = gu; pgDown = gd; pgBack = gb;

    const left = any(B.left) || gl, right = any(B.right) || gr;
    api.move = left ? -1 : right ? 1 : ax;
    api.fire = any(B.fire) || gf || touchFire;
    api.touchActive = touchActive;
    api.menu = pending; pending = 0;
  };
  // the gameplay word for this tick; consumes the pressed latches
  api.word = function word() {
    const w = packWord(api.move, api.fire, latchFire, latchAlt, touchActive, touchX);
    latchFire = latchAlt = false;
    return w;
  };
  api.clearLatches = function () { latchFire = latchAlt = false; pending = 0; };
  api.releaseAll = releaseAll;
  return api;
}
