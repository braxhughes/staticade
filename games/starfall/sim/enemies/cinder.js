// The Cinder (design.md B.3, Z3): 1 hp, 120 in formation / 260 diving. Killing it drops an ember bullet
// straight down at 1.4. The 48-unit rule (B.9 readability rule 5): if the Cinder dies within 48 units of the
// player, no ember spawns, and an ember never spawns within 48 units of the player either.
//
// Telegraph (B.6 / B.9: every bullet-spawning event gets >= 20 frames of warning): the ember first hangs
// glowing at the death point for EMBER_TELE frames (harmless, not a bullet), then drops. The spawn obeys the
// volley-wait rule (B.5): with no room under the bullet cap it waits up to VOLLEY_WAIT frames, then fizzles.
//
// cinderSystem is a sim system (sim/systems.js). State lives in S.embers (preallocated typed arrays).
// Pure: no DOM, Math.random or Date; no per-frame allocation. Drawn by render/enemies-z3.js.
import { hypot } from '../../../../engine/dmath.js';
import { VOLLEY_WAIT } from '../feel.js';

export const EMBER_SPEED = 1.4, EMBER_SAFE = 48, EMBER_TELE = 20, EMBER_N = 16;

export const CINDER = {
  name: 'CINDER', hp: 1, r: 6, form: 120, dive: 260,
  // a coal-black husk with a glowing ember heart and crimson flame horns; two flicker frames
  art: {
    A: ['..r...r..', '...r.r...', '.rkkokkr.', 'rkkoyokkr', 'r.koyok.r', '..kooook.', '...kkk...', '....k....'],
    B: ['.r.....r.', '..r...r..', 'r.kkokk.r', 'rkkoyokkr', '..koyok..', '.kkoook..', '...kkk...', '...k.k...'],
    pal: { r: [1, .62, .55], k: [.62, .3, .26], o: [1, .55, .15], y: [1, .85, .3] } // light horns and husk so it reads on the crimson Z3 sky
  }
};

// S.embers: pending embers (glowing, not yet bullets) plus the last snuffed spot (presentation only)
function mkEmbers() {
  return { on: new Uint8Array(EMBER_N), x: new Float64Array(EMBER_N), y: new Float64Array(EMBER_N),
    age: new Int32Array(EMBER_N), wait: new Int32Array(EMBER_N), spawned: 0, snuffed: 0,
    snuffX: 0, snuffY: 0, snuffAge: 999 }; // snuff*: presentation only (gameplay frames since the last snuff)
}
function clearEmbers(E) { E.on.fill(0); }
const live = S => S.state === 'play' || S.state === 'dying' || S.state === 'ready' || S.state === 'gameover';
const near = (S, x, y) => hypot(x - S.player.x, y - S.player.y) < EMBER_SAFE;
function snuff(S, x, y) { const E = S.embers; E.snuffed++; E.snuffX = x; E.snuffY = y; E.snuffAge = 0; }

export const cinderSystem = {
  id: 'cinder',
  init(S) { S.embers = mkEmbers(); },
  onEvent(S, ev) {
    const E = S.embers;
    if (ev.type === 'stage' || ev.type === 'clear' || ev.type === 'death') { clearEmbers(E); return; } // a death wipes pending embers
    if (ev.type !== 'kill' || !ev.enemy || ev.enemy.type !== 'cinder' || ev.enemy.bonus) return;
    const e = ev.enemy;
    if (near(S, e.x, e.y)) { snuff(S, e.x, e.y); return; }   // died within 48 units: no ember
    for (let i = 0; i < EMBER_N; i++) if (!E.on[i]) { E.on[i] = 1; E.x[i] = e.x; E.y[i] = e.y; E.age[i] = 0; E.wait[i] = 0; return; }
  },
  step(S) {
    const E = S.embers;
    if (E.snuffAge < 999) E.snuffAge++;
    if (!live(S)) { clearEmbers(E); return; }
    for (let i = 0; i < EMBER_N; i++) {
      if (!E.on[i]) continue;
      // ages 1..EMBER_TELE are the glow (the kill frame shows age 1), so the warning is on screen EMBER_TELE frames
      if (++E.age[i] <= EMBER_TELE) continue;
      // telegraph done: drop now, unless the player is within 48 units (rule 5) or the cap has no room
      if (near(S, E.x[i], E.y[i])) { E.on[i] = 0; snuff(S, E.x[i], E.y[i]); continue; }
      if (S.volleyOk(1)) { S.eFire(E.x[i], E.y[i], 0, EMBER_SPEED, false); E.on[i] = 0; E.spawned++; continue; }
      if (++E.wait[i] > VOLLEY_WAIT) E.on[i] = 0;
    }
  },
  hash(S, u32, f64) {
    const E = S.embers;
    for (let i = 0; i < EMBER_N; i++) if (E.on[i]) { u32(i); f64(E.x[i]); f64(E.y[i]); u32(E.age[i]); u32(E.wait[i]); }
    u32(E.spawned); u32(E.snuffed);
  }
};
