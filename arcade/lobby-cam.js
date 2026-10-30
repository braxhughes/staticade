// Lobby camera and navigation. Pure math: no DOM, WebGL, audio or Date, so it runs in node tests.
// World units are cm, as in cabinet.js: floor y=0, cabinet fronts at z=0, viewer at +z looking toward -z.
// Machine i stands at x = i * SPACING. The camera is a first-person eye 150 cm in front of the focused one.
// A step is a short sideways dolly with an eased slide, a slight head turn into the move, a small
// back-off and a head bob. The ends of the row STOP (no wrap); pushing past an end gives a small bump.
import { CAB_KEYS, FOC } from './cabinet.js';

const PI = Math.PI, TAU = PI * 2;
export const SPACING = 96;
export const STEP_TICKS = 34, BUMP_TICKS = 16, DOLLY_TICKS = 54;
export const EYE_Y = 112, EYE_Z = 185, PITCH = 0.10;
export const LOBBY_FOC = 172;   // wider lens in the lobby; tweens to the intro's 300 during the select dolly
const smoother = t => t * t * t * (t * (t * 6 - 15) + 10);
const easeIO = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

export const machineX = i => i * SPACING;

// navigation state over n machines. tick() once per 60 Hz step; read poses with an interpolation alpha.
export function createNav(n, start = 0) {
  let to = clamp(start | 0, 0, n - 1), from = to, u = 1, dur = 1, dir = 1, bumping = false, held = -1;
  const api = {
    get index() { return to; },
    get moving() { return held >= 0 ? held < dur : u < dur; },
    get dir() { return dir; },
    get bumping() { return bumping && api.moving; },
    get dur() { return dur; },
    // ticks elapsed in the current step (or the frozen value)
    get u() { return held >= 0 ? held : u; },
    // go to machine i; returns 'step', 'bump' (pushed against an end) or 'none'
    go(i) {
      i = i | 0;
      if (i > n - 1 || i < 0) {
        const d = i < 0 ? -1 : 1;
        if (api.moving && !bumping) return 'none';
        dir = d; bumping = true; u = 0; dur = BUMP_TICKS; from = to; return 'bump';
      }
      if (i === to) return 'none';
      const p = api.pos(0);
      dir = i > p ? 1 : -1;
      from = p; to = i; u = 0; bumping = false;
      dur = STEP_TICKS + 8 * (Math.abs(i - p) > 1.5 ? Math.round(Math.abs(i - p)) - 1 : 0);
      return 'step';
    },
    next() { return api.go(to + 1); },
    prev() { return api.go(to - 1); },
    tick() { if (u < dur && held < 0) u++; },
    // freeze the current step at tick t (null releases)
    hold(t) { held = t == null ? -1 : t; },
    // normalised time within the step, 0..1
    t(alpha = 0) { const k = held >= 0 ? held : u + alpha; return clamp(k / dur, 0, 1); },
    // fractional machine index of the eye
    pos(alpha = 0) {
      if (bumping) return to;
      const tt = api.t(alpha); return from + (to - from) * smoother(tt);
    }
  };
  return api;
}

// First-person pose [ex, ey, ez, lx, ly, lz, focal] for a nav state; time (seconds) drives the idle breathing.
export function lobbyPose(nav, alpha, time, out) {
  const tt = nav.t(alpha), moving = nav.moving;
  const w = moving ? Math.sin(PI * tt) : 0;
  const bump = nav.bumping;
  const cx = nav.pos(alpha) * SPACING;
  let yaw = 0;
  if (bump) yaw = nav.dir * 0.035 * w;
  else yaw = nav.dir * 0.10 * w;
  const bob = bump ? 0 : 1.5 * Math.sin(tt * TAU * 1.5) * w;
  const ex = cx + Math.sin(time * 0.5) * 0.9 + (bump ? nav.dir * 2.2 * w : 0);
  const ey = EYE_Y + bob + Math.sin(time * 0.7) * 0.45;
  const ez = EYE_Z + (bump ? 0 : 11 * w);
  const cp = Math.cos(PITCH), L = 150;
  out[6] = LOBBY_FOC;
  out[0] = ex; out[1] = ey; out[2] = ez;
  out[3] = ex + Math.sin(yaw) * cp * L; out[4] = ey - Math.sin(PITCH) * L; out[5] = ez - Math.cos(yaw) * cp * L;
  return out;
}

// The select dolly: from pose `from` (a snapshot) to the coin-door close-up that opens Starfall's cabinet
// intro (CAB_KEYS[0]), offset to machine x. q is 0..1 time. Matches the intro's first keyframe at q=1.
export function coinDoorPose(mx, out) {
  const k = CAB_KEYS[0];
  out[0] = k[0] + mx; out[1] = k[1]; out[2] = k[2]; out[3] = k[3] + mx; out[4] = k[4]; out[5] = k[5]; out[6] = FOC;
  return out;
}
const TX = new Float64Array(6);   // scratch target: dollyPose runs every frame, so it must not allocate
export function dollyPose(from, mx, q, out) {
  const e = easeIO(clamp(q, 0, 1)), k = CAB_KEYS[0];
  // position eases a touch ahead of the gaze so the move reads as leaning in
  const ep = smoother(clamp(q * 1.0, 0, 1));
  const tx = TX; tx[0] = k[0] + mx; tx[1] = k[1]; tx[2] = k[2]; tx[3] = k[3] + mx; tx[4] = k[4]; tx[5] = k[5];
  for (let i = 0; i < 3; i++) out[i] = from[i] + (tx[i] - from[i]) * ep;
  for (let i = 3; i < 6; i++) out[i] = from[i] + (tx[i] - from[i]) * e;
  out[6] = from[6] + (FOC - from[6]) * e;
  return out;
}

// ---------- floor layout: the selected cabinet pulled out on the right, its wall board on the left ----------
// Cabinet i stands with its back on the wall (z = WALL_Z) at x = floorX(i) + rowShift(i - pos). Only the selected one is
// pulled out: swung open about a hinge at its back-left corner by CAB_ANGLE (front turned toward the left of the screen,
// right side panel showing). Its neighbours stand flush against the wall facing the camera, like the v1 row, and peek in
// at the screen edges. A step swings the old selection back into its slot while the new one pulls out.
// Pressing Enter swings the selected one shut (angle 0) and slides the whole row into the v1 arcade row (ROW_SPACING
// apart, the selected cabinet centred) while the eye moves to rowPose: then the v1 dolly runs unchanged.
export const FLOOR_SPACING = 300, CAB_ANGLE = 72 * PI / 180, WALL_Z = -70, CAM_OFF = 186;
export const FLOOR_EYE_Y = 120, FLOOR_EYE_Z = 235, FLOOR_PITCH = 0.09;
// where the flush neighbours' centres rest, relative to the eye's x (cm): the next one just clear of the swung-open
// cabinet and cut off by the right edge, the previous one cut off by the left edge, left of the board
export const NEXT_R = 280, PREV_R = -250, ROW_SPACING = SPACING;
// in the v1 row (after Enter) machine i stands at floorX(sel) + (i - sel) * ROW_SPACING: its offset from floorX(i)
export const rowDX = (i, sel) => (i - sel) * (ROW_SPACING - FLOOR_SPACING);
export const floorX = i => i * FLOOR_SPACING;
// d = machine index minus the eye's fractional index (0 at the selected one); returns the offset from floorX(i)
export function rowShift(d) {
  let r;
  if (d >= 1) r = NEXT_R + (d - 1) * FLOOR_SPACING;
  else if (d >= 0) r = CAM_OFF + (NEXT_R - CAM_OFF) * smoother(d);
  else if (d > -1) r = CAM_OFF + (PREV_R - CAM_OFF) * smoother(-d);
  else r = PREV_R + (d + 1) * FLOOR_SPACING;
  return r - CAM_OFF - d * FLOOR_SPACING;
}
// the v1 lobby's resting eye in front of a cabinet at x mx (lobbyPose without the breathing): where the Enter move ends
export function rowPose(mx, out) {
  const cp = Math.cos(PITCH), L = 150;
  out[0] = mx; out[1] = EYE_Y; out[2] = EYE_Z; out[3] = mx; out[4] = EYE_Y - Math.sin(PITCH) * L; out[5] = EYE_Z - cp * L; out[6] = LOBBY_FOC;
  return out;
}
export function floorPose(nav, alpha, time, out) {
  const tt = nav.t(alpha), w = nav.moving ? Math.sin(PI * tt) : 0, bump = nav.bumping;
  const yaw = nav.dir * (bump ? 0.035 : 0.07) * w;
  const bob = bump ? 0 : 1.5 * Math.sin(tt * TAU * 1.5) * w;
  const ex = nav.pos(alpha) * FLOOR_SPACING - CAM_OFF + Math.sin(time * 0.5) * 0.9 + (bump ? nav.dir * 2.2 * w : 0);
  const ey = FLOOR_EYE_Y + bob + Math.sin(time * 0.7) * 0.45;
  const ez = FLOOR_EYE_Z + (bump ? 0 : 14 * w);
  const cp = Math.cos(FLOOR_PITCH), L = 150;
  out[6] = LOBBY_FOC;
  out[0] = ex; out[1] = ey; out[2] = ez;
  out[3] = ex + Math.sin(yaw) * cp * L; out[4] = ey - Math.sin(FLOOR_PITCH) * L; out[5] = ez - Math.cos(yaw) * cp * L;
  return out;
}
// the Enter move, SWING_TICKS long: the cabinet swings shut over the first SWING_SHUT of it (swingAngle of its own
// 0..1), and from SLIDE_FROM on the row slides together into the v1 row while the eye moves to rowPose (slideK)
export const SWING_TICKS = 56, SWING_SHUT = 0.55, SLIDE_FROM = 0.35;
export const swingAngle = q => CAB_ANGLE * (1 - easeIO(clamp(q, 0, 1)));
export const slideK = q => easeIO(clamp((q - SLIDE_FROM) / (1 - SLIDE_FROM), 0, 1));
