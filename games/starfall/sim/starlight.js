// STARLIGHT: the phrase-based rhythm stage (design.md B.4, B.8, B.9). Stages 4, 9 and 14 (and their loops).
//
// The sim owns the beat: one beat = BEAT_FRAMES (25) frames in every zone. Beat 0 is the first 'play' frame after the
// stage card, so the stage frame is f = S.stageT - 1 and beat = floor(f / 25). STARLIGHT has no hit-stop (sim.js
// addHitstop returns early on a bonus stage), so the beat clock never pauses.
//
// Six phrases start every 16 beats (beats 0, 16, 32, 48, 64, 80). A phrase has 6 / 7 / 8 enemies (Z1 / Z2 / Z3) that
// arrive one per 2 beats / one per beat / two per beat (on the beat and the half beat: 12 frames, then 13 to the next
// beat). Enemy k of phrase p arrives on stage frame 400 p + arrivalOffset(zone, k) and can be shot from that frame.
// Each enemy flies its zone's phrase path for 10 beats (FLIGHT = 250 frames, off screen to off screen), then exits
// (removed at the end of frame arrival + 250). The stage lasts exactly 104 beats = 2600 'play' frames, then
// 'bonusEnd' (the tally), then 'clear'. No enemy ever fires, and STARLIGHT enemies have no body (sim.js skips it).
//
// Scoring: a kill on a frame within ON_BEAT (4) frames of a beat (9 of every 25 frames) is on-beat, base 250; any other
// kill is off-beat, base 120. Both are kill points (sim.addKill: DEEP SKY, chain tier, heat and loop apply, and the kill
// extends the Ember Chain). When a phrase's last enemy is gone (killed or exited) the phrase is graded, flat bonuses:
//   Complete (all killed) 90 x phrase size; In Tune (Complete and every kill on-beat) 210 x size instead;
//   In Order (Complete and this phrase's enemies killed in their arrival order) x1.5. Other phrases' kills never
//   break a phrase's order (Z1 phrases overlap: a phrase's last enemy leaves at beat 20, the next starts at beat 16).
// Finale, paid in the tally (bonusEnd frame 70): ENCORE (every phrase Complete) 175 x enemy count; STANDING OVATION
// (every phrase In Tune) 440 x enemy count instead.
//
// Presentation events: POP_PHRASE per Complete phrase (value = points x 8 + grade flags, color = the phrase hue) with a
// 'select' sound; POP_FINALE in the tally (value = points x 2 + 1 for STANDING OVATION) with the 'life' id (no ship:
// main.js plays the STARLIGHT reward cue). The 'beat' sound id carries the rhythm (silent in audio-bind.js until S13b
// maps it): arg >= 0 = sim beat n started; arg BEAT_OFF (-1) = an off-beat kill (the muted thud); arg <= -2 = an
// on-beat kill playing note (-2 - arg) of its phrase's melody (0 = the phrase's first on-beat kill).
//
// State lives in S.sl (allocated once in init, reset per STARLIGHT stage) and is mixed into stateHash by the
// starlight system below. Pure: no DOM, Math.random or Date; trig from engine/dmath.js; no per-frame allocation.
import { CX, PI, TAU, SFX_ID, C_TEAL, C_ROSE, C_GOLD, POP_PHRASE, POP_FINALE } from '../defs.js';
import { sin, cos, atan2 } from '../../../engine/dmath.js';
import { STAGE_TABLE } from './stages.js';

export const BEAT_FRAMES = 25, STAGE_BEATS = 104, STAGE_FRAMES = STAGE_BEATS * BEAT_FRAMES; // 2600
export const PHRASES = 6, PHRASE_BEATS = 16, FLIGHT_BEATS = 10, FLIGHT = FLIGHT_BEATS * BEAT_FRAMES; // 250
export const ON_BEAT = 4;
export const KILL_ON = 250, KILL_OFF = 120;
export const COMPLETE_PER = 90, TUNE_PER = 210, ORDER_X = 1.5, ENCORE_PER = 175, OVATION_PER = 440;
export const SL_MAX = 48;
// per zone (index 1..3): phrase size; enemy count = 6 x size (36 / 42 / 48, the run table's `enemies`)
export const PHRASE_SIZE = [0, 6, 7, 8];
// grade flags (S.sl.grade[p]); GR_DONE = the phrase was graded
export const GR_COMPLETE = 1, GR_TUNE = 2, GR_ORDER = 4, GR_DONE = 8;
// finale (S.sl.finale)
export const FIN_NONE = 0, FIN_ENCORE = 1, FIN_OVATION = 2;
// 'beat' sound args (see the header)
export const BEAT_OFF = -1;
export const beatNote = n => -2 - n;
// the two alternating phrase hues (popups; render/starlight.js draws the same pair)
export const PHRASE_C = [C_TEAL, C_ROSE];
const TYPES = ['moth', 'wisp', 'splitter'];

// frames from a phrase's start to the arrival of its enemy k
export function arrivalOffset(zone, k) {
  if (zone === 1) return k * 2 * BEAT_FRAMES;           // one arrival every 2 beats
  if (zone === 2) return k * BEAT_FRAMES;               // one per beat
  return (k >> 1) * BEAT_FRAMES + (k & 1) * 12;         // two per beat: on the beat and 12 frames later
}
// is stage frame f on-beat (within ON_BEAT frames of a beat)?
export function onBeat(f) { const d = f % BEAT_FRAMES; return d <= ON_BEAT || d >= BEAT_FRAMES - ON_BEAT; }
const zoneOf = S => S.zone >= 1 && S.zone <= 3 ? S.zone : 1;

// ---------- phrase paths (our own: one family per zone, varied per phrase) ----------
// t = frames on the path, 0..FLIGHT; both ends are off screen. Writes PX, PY.
let PX = 0, PY = 0;
function pathAt(zone, p, t) {
  const u = t / FLIGHT, s = (p & 1) ? -1 : 1;
  if (zone === 1) {
    // Lantern swing: a lantern on a rope from a pivot above the screen. The rope pays out and reels back in
    // (length 30 -> 230 -> 30) while the lantern swings across and back once (0.65 rad each side), so it passes
    // the middle twice at under 3 units a frame. Odd phrases swing mirrored.
    const L = 30 + 200 * sin(PI * u), th = s * 0.65 * cos(TAU * u);
    PX = CX + L * sin(th); PY = -60 + L * cos(th);
  } else if (zone === 2) {
    // Tide: a wave rolling across the screen, edge to edge; phrases alternate direction and ride at three heights.
    PX = CX - s * (212 - 424 * u); PY = 90 + (p % 3) * 22 + 40 * sin(TAU * 1.5 * u + p * 0.7);
  } else {
    // Sun orbit: spirals in around the hollow sun and back out (radius 320 -> 70 -> 320, 1.25 turns);
    // phrases alternate the turn and start a sixth of a turn apart.
    const r = 320 - 250 * sin(PI * u), a = -PI / 2 + p * 1.05 + s * TAU * 1.25 * u;
    PX = CX + r * cos(a); PY = 130 + r * 0.8 * sin(a);
  }
}
// for tests and tools: [x, y] (allocates; the sim never calls it)
export function phrasePoint(zone, p, t) { pathAt(zone, p, t); return [PX, PY]; }

function place(S, e, i, t) {
  const L = S.sl, p = (i / L.size) | 0;
  pathAt(L.zone, p, t + 1); const nx = PX, ny = PY;
  pathAt(L.zone, p, t);
  e.x = PX; e.y = PY; e.ang = atan2(nx - PX, -(ny - PY));
}

// put every enemy where it is on stage frame nf: arrivals (st 'wait' -> 'phrase'), flight, exits
function advance(S, nf) {
  const L = S.sl;
  for (let i = 0; i < L.n; i++) {
    const e = L.ord[i];
    if (!e) continue;
    const p = (i / L.size) | 0;
    if (e.dead) { L.ord[i] = null; L.gone[p]++; continue; } // removed by something other than a shot (does not happen in play)
    const t = nf - L.arr[i];
    if (t < 0) continue;
    if (t > FLIGHT) { e.dead = true; L.ord[i] = null; L.gone[p]++; continue; } // exits (already off screen)
    place(S, e, i, t);
    if (e.st === 'wait') { e.st = 'phrase'; e.px = e.x; e.py = e.y; }
  }
}

// grade every phrase whose last enemy is gone (every phrase, when the stage ends)
function grade(S, all) {
  const L = S.sl, n = L.size;
  for (let p = 0; p < PHRASES; p++) {
    if (L.grade[p] & GR_DONE) continue;
    if (!all && L.kills[p] + L.gone[p] < n) continue;
    let g = GR_DONE;
    if (L.kills[p] === n) {
      g |= GR_COMPLETE;
      if (L.tune[p] === n) g |= GR_TUNE;
      if (L.order[p]) g |= GR_ORDER;
      let pts = (g & GR_TUNE ? TUNE_PER : COMPLETE_PER) * n;
      if (g & GR_ORDER) pts *= ORDER_X;
      const v = S.addBonus(pts);
      L.paid += v;
      S.popup(POP_PHRASE, CX, 96, v * 8 + (g & 7), PHRASE_C[p & 1]);
      S.sfx(SFX_ID.select, p);
    }
    L.grade[p] = g;
  }
}

export const starlight = {
  setup(S) {
    const L = S.sl, zone = zoneOf(S), size = PHRASE_SIZE[zone], R = STAGE_TABLE[S.row];
    L.zone = zone; L.size = size; L.n = size * PHRASES;
    if (R && R.enemies !== L.n) throw new Error('STARLIGHT count mismatch: table ' + R.enemies + ', phrases ' + L.n);
    L.beat = -1; L.phrase = -1; L.finale = FIN_NONE; L.paid = 0; L.finPts = 0;
    L.kills.fill(0); L.tune.fill(0); L.order.fill(1); L.gone.fill(0); L.grade.fill(0);
    L.ord.fill(null); L.arr.fill(0);
    S.bonusHits = 0; S.bonusTotal = L.n;
    for (let p = 0; p < PHRASES; p++) for (let k = 0; k < size; k++) {
      const i = p * size + k, e = S.mkEnemy(TYPES[p % 3], -1, -1);
      e.bonus = true; e.hp = 1; e.st = 'wait'; e.delay = 1e9; // the core never wakes it; advance() does
      L.ord[i] = e; L.arr[i] = p * PHRASE_BEATS * BEAT_FRAMES + arrivalOffset(zone, k);
      S.enemies.push(e);
    }
    advance(S, 0); // the enemy that arrives on frame 0 (beat 0) is in place for the first 'play' frame
  },
  // a STARLIGHT enemy was shot down (sim.js, inside the world update)
  hit(S, e) {
    const L = S.sl;
    let i = 0; while (i < L.n && L.ord[i] !== e) i++;
    if (i === L.n) { S.kill(e, KILL_OFF); return; } // not one of ours (does not happen)
    const f = S.stageT - 1, on = onBeat(f), p = (i / L.size) | 0, k = i - p * L.size;
    S.kill(e, on ? KILL_ON : KILL_OFF);
    L.ord[i] = null;
    if (L.kills[p] !== k) L.order[p] = 0; // In Order: this phrase's kills in arrival order (other phrases never matter)
    L.kills[p]++;
    if (on) { S.sfx(SFX_ID.beat, beatNote(L.tune[p])); L.tune[p]++; } else S.sfx(SFX_ID.beat, BEAT_OFF);
    S.bonusHits++;
  },
  // each 'play' frame with a live ship, after the world update
  check(S) {
    const L = S.sl, f = S.stageT - 1, b = (f / BEAT_FRAMES) | 0;
    L.beat = b; L.phrase = Math.min(PHRASES - 1, (b / PHRASE_BEATS) | 0);
    if (f % BEAT_FRAMES === 0) S.sfx(SFX_ID.beat, b); // one per sim beat (v1 sent one every 15 frames)
    advance(S, f + 1);
    if (S.stageT >= STAGE_FRAMES) {
      // the stage ends: anything still flying is gone (does not happen: the last phrase ends by beat 100)
      for (let i = 0; i < L.n; i++) { const e = L.ord[i]; if (e) { e.dead = true; L.ord[i] = null; L.gone[(i / L.size) | 0]++; } }
      grade(S, true);
      let all = 0, tune = 0;
      for (let p = 0; p < PHRASES; p++) { if (L.grade[p] & GR_COMPLETE) all++; if (L.grade[p] & GR_TUNE) tune++; }
      L.finale = tune === PHRASES ? FIN_OVATION : all === PHRASES ? FIN_ENCORE : FIN_NONE;
      for (let i = 0; i < S.ps.length; i++) S.ps[i].on = false;
      S.setState('bonusEnd');
    } else grade(S, false);
  },
  // each 'bonusEnd' frame (the tally); the caller moves on to 'clear'
  endStep(S) {
    const L = S.sl;
    if (S.stateT === 70) {
      if (L.finale !== FIN_NONE) {
        const v = S.addBonus((L.finale === FIN_OVATION ? OVATION_PER : ENCORE_PER) * L.n);
        L.finPts = v;
        S.popup(POP_FINALE, CX, 214, v * 2 + (L.finale === FIN_OVATION ? 1 : 0), C_GOLD);
        S.sfx(SFX_ID.life);
      } else S.sfx(SFX_ID.select);
    }
    if (S.stateT > 230) S.setState('clear');
  }
};

// SF.info() fields (hooks.js): beatFrames 25 on STARLIGHT (0 elsewhere); beat and phrase are -1 before beat 0
export function starlightInfo(S) {
  const on = S.stageKind === 'bonus';
  return { beatFrames: on ? BEAT_FRAMES : 0, beat: on ? S.sl.beat : -1, phrase: on ? S.sl.phrase : -1 };
}

// The starlight system owns S.sl and mixes it into stateHash. It is registered last in sim/systems.js (S11 moved the
// registration there from a module-load push; same position, so the step and hash order are unchanged); its step and
// onEvent do nothing.
export const starlightSystem = {
  id: 'starlight',
  init(S) {
    S.sl = { zone: 1, size: 6, n: 36, beat: -1, phrase: -1, finale: FIN_NONE, paid: 0, finPts: 0,
      ord: new Array(SL_MAX).fill(null), arr: new Int32Array(SL_MAX),
      kills: new Uint8Array(PHRASES), tune: new Uint8Array(PHRASES), order: new Uint8Array(PHRASES),
      gone: new Uint8Array(PHRASES), grade: new Uint8Array(PHRASES) };
  },
  step() {},
  onEvent() {},
  hash(S, u32) {
    const L = S.sl;
    u32(L.zone); u32(L.size); u32(L.n); u32(L.beat); u32(L.phrase); u32(L.finale); u32(L.paid); u32(L.finPts);
    for (let p = 0; p < PHRASES; p++) { u32(L.kills[p]); u32(L.tune[p]); u32(L.order[p]); u32(L.gone[p]); u32(L.grade[p]); }
    let bits = 0;
    for (let i = 0; i < SL_MAX; i++) {
      if (L.ord[i]) bits |= 1 << (i & 31);
      if ((i & 31) === 31 || i === SL_MAX - 1) { u32(bits); bits = 0; }
      u32(L.arr[i]);
    }
  }
};
