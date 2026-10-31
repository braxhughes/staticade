// The arcade lobby: the selected cabinet stands on the right, swung about 60 degrees open from the back
// wall so its side panel shows; its wall board (the game's ALL-TIME top 10 and the player's own line) hangs beside it;
// the left of the screen carries the game's name. Arrows / A D / gamepad / swipe / tap slide the next cabinet in.
// Selecting Starfall swings the cabinet shut against the wall (facing the camera), then dollies down to the coin door
// (the exact first keyframe of Starfall's cabinet intro) and loads Starfall on the same canvas, so the next frame is
// the intro's own first frame. COMING SOON machines flash and refuse.
// Everything is dots. World units are cm (see lobby-cam.js).
import { createGfx } from '../engine/gl-dots.js';
import { createText, FONT, textW } from '../engine/font.js';
import { createLoop } from '../engine/loop.js';
import { createInput, M_FIRE, M_ALT, M_ANY, M_MUTE } from '../engine/input.js';
import { createRng, Rng } from '../engine/rng.js';
import { createAudio } from '../engine/audio.js';
import { TRACKS } from '../games/starfall/music.js';
import { SFX } from '../games/starfall/sfx.js';
import { STAR_COLS } from '../games/starfall/sprites.js';
import { buildCabinetGeometry, DEFAULT_PALETTE, G_LAMP, G_INSERT, G_CREDIT1, G_MARQ, G_BTN } from './cabinet.js';
import { MACHINES, START_INDEX } from './machines.js';
import { ARCADE_NAME, ARCADE_TAGLINE } from './brand.js';
import { createNav, dollyPose, coinDoorPose, DOLLY_TICKS, STEP_TICKS, LOBBY_FOC,
  floorPose, floorX, FLOOR_SPACING, CAB_ANGLE, WALL_Z, FLOOR_EYE_Z, SWING_TICKS, SWING_SHUT, swingAngle, slideK, slideL, slideR, rowShift, rowDX, rowPose } from './lobby-cam.js';
import { browserBoard } from './lobby-board.js';
const PLAY_HINT = (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) ? 'TAP: PLAY' : 'ENTER: PLAY';

const W = 400, H = 300, CX = W / 2, N = MACHINES.length;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const smooth = t => t * t * (3 - 2 * t);
const TAU = Math.PI * 2;

document.title = ARCADE_NAME;
const canvas = document.getElementById('c');
const gfx = createGfx(canvas, { W, H, maxDots: 72000 });
if (!gfx) {
  canvas.style.display = 'none'; document.getElementById('nogl').style.display = 'block';
  throw new Error('The arcade needs WebGL');
}
gfx.resize();
const dot = gfx.dot;

// ---------- shared state ----------
const ui = { F: 0, crtOn: true, muted: false };
try { ui.crtOn = localStorage.getItem('starfall.crt') !== '0'; } catch (e) {}
function setCrt(v) { ui.crtOn = v; try { localStorage.setItem('starfall.crt', v ? '1' : '0'); } catch (e) {} }
const text = createText(dot, ui);

// ---------- audio ----------
const audio = createAudio({ tracks: TRACKS, sfx: SFX });
let musicOn = false, altFoot = false;
function onGesture() {
  audio.unlock();
  if (!musicOn && mode !== 'gone') { musicOn = true; audio.playMusic('lobby', { fadeMs: 900 }); }
}
function sfx(name, o) { audio.sfx(name, o); }
const input = createInput({ target: window, onGesture });

// ---------- machines: geometry and screens ----------
const GEO = MACHINES.map((m, i) => {
  const pal = Object.assign({}, DEFAULT_PALETTE, m.palette);
  return buildCabinetGeometry(pal, m.name, m.sub, Math.random, false, 9000);
});
// side-panel dots (the see-through flanks) are only drawn at full strength for the select dolly's end frame,
// where they are part of Starfall's intro; in the lobby they would just clutter the neighbours
// (1 = the left flank, 2 = the right flank; while a cabinet stands swung open its right flank faces the camera)
const SIDE = GEO.map(g => { const a = new Uint8Array(g.n); for (let k = 0; k < g.n; k++) if (Math.abs(g.X[k]) > 37.9 && g.Z[k] < -3) a[k] = g.X[k] > 0 ? 2 : 1; return a; });
// the swung-open view also shows the right flank's top, back and floor edges, which the intro's builder leaves out
// (no camera there ever sees them). Lobby-only dots, faded out as the cabinet swings shut. Local cabinet coords.
const XE_MAX = 400, xeX = new Float32Array(XE_MAX), xeY = new Float32Array(XE_MAX), xeZ = new Float32Array(XE_MAX);
let xeN = 0;
{
  const add = (x0, y0, z0, x1, y1, z1) => { const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 1.3)); for (let i = 0; i <= n && xeN < XE_MAX; i++) { const t = i / n; xeX[xeN] = x0 + (x1 - x0) * t; xeY[xeN] = y0 + (y1 - y0) * t; xeZ[xeN++] = z0 + (z1 - z0) * t; } };
  add(38, 190, 0, 38, 190, -70); add(38, 190, -70, 38, 0, -70); add(38, 0, 0, 38, 0, -70);
}
// side art on the right flank (lobby only, it faces the camera while the cabinet stands swung open): a lit dot field,
// brightest near the top, crossed by three diagonal light stripes. Local cabinet coords; faded out by the swing.
const SA_MAX = 1400, saY = new Float32Array(SA_MAX), saZ = new Float32Array(SA_MAX), saA = new Float32Array(SA_MAX), saK = new Uint8Array(SA_MAX);
let saN = 0;
for (let y = 8; y <= 182 && saN < SA_MAX; y += 4.4) for (let z = -64; z <= -14 && saN < SA_MAX; z += 4.4) {
  // three bands running up and back at 60 degrees; k: 0 the field, 1..3 a band
  const u = y * 0.6 - z * 0.8 + 200, b = u % 40, band = b < 10 ? 1 + ((u / 40) | 0) % 3 : 0;
  saY[saN] = y; saZ[saN] = z; saK[saN] = band; saA[saN] = band ? 0.85 * (1 - Math.abs(b - 5) / 7) : 0.08 + 0.14 * (y / 182); saN++;
}
// COMING SOON machines get marquee-lit screens; precompute the two title colours per machine
const MP = MACHINES.map(m => Object.assign({}, DEFAULT_PALETTE, m.palette));

// ---------- static scene: floor, glow pools, back wall ----------
// Points tied to a machine (sBnd 1) follow its row shift (rowShift: the neighbours are pulled in toward the selected one).
const S_MAX = 32000, sX = new Float32Array(S_MAX), sY = new Float32Array(S_MAX), sZ = new Float32Array(S_MAX), sS = new Float32Array(S_MAX),
  sR = new Float32Array(S_MAX), sG = new Float32Array(S_MAX), sB = new Float32Array(S_MAX), sA = new Float32Array(S_MAX),
  sGrp = new Uint8Array(S_MAX), sMi = new Uint8Array(S_MAX), sBnd = new Uint8Array(S_MAX);
let sN = 0;
// S_TUBE: the long neon tube (hums, flickers now and then); S_WGLOW: light from a cabinet pooling on the wall behind it
const S_FLOOR = 0, S_POOL = 1, S_WALL = 2, S_NEON = 3, S_TUBE = 4, S_WGLOW = 5, S_CEIL = 6;
let SPILL_M = 0;   // scene build scratch: the machine whose light is brightest at a wall point
function spt(x, y, z, s, c, a, g, mi, bnd) {
  if (sN >= S_MAX) return;
  const i = sN++;
  sX[i] = x; sY[i] = y; sZ[i] = z; sS[i] = s; sR[i] = c[0]; sG[i] = c[1]; sB[i] = c[2]; sA[i] = a; sGrp[i] = g; sMi[i] = mi == null ? 255 : mi; sBnd[i] = bnd ? 1 : 0;
}
function sline(x0, y0, z0, x1, y1, z1, step, s, c, a, g, mi, bnd) {
  const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0, z1 - z0) / step));
  for (let i = 0; i <= n; i++) { const t = i / n; spt(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t, s, c, a, g, mi, bnd); }
}
// where a swung-open cabinet's footprint centre sits, relative to floorX(i) (for its floor glow). The scene is built
// for a flush cabinet (footprint centre floorX(i), WALL_Z + 35); a cabinet's points move by OPEN[i] of the difference
const POOL_DX = -38 + 38 * Math.cos(CAB_ANGLE) - 35 * Math.sin(CAB_ANGLE), POOL_Z = WALL_Z + 38 * Math.sin(CAB_ANGLE) + 35 * Math.cos(CAB_ANGLE);
// the wall board: its top-left corner on the wall, relative to floorX(i); drawn as a flat panel (see drawBoard)
const BOARD_WX = -420, BOARD_WY = 248;
const TRIM = [.5, .45, 1], TUBE = [.95, .35, 1];
(function buildScene() {
  const rng = createRng(0xA2CADE);
  const LX = -900, RX = (N - 1) * FLOOR_SPACING + 900, WZ = WALL_Z;
  // carpet confetti, same size and brightness as the intro's room
  for (let i = 0; i < 4200; i++) spt(LX + rng.next() * (RX - LX), 0, WZ + 2 + rng.next() * 270, 0.6, STAR_COLS[i % 7], 0.2, S_FLOOR);
  for (const z of [WZ + 30, WZ + 104, WZ + 178]) sline(LX, 0, z, RX, 0, z, 3.2, 0.45, [.5, .5, .85], 0.1, S_FLOOR);
  // the floor glow under each machine, tinted by its marquee, and a brighter sheen line along its foot
  for (let m = 0; m < N; m++) {
    const g = MACHINES[m].glow, mx = floorX(m);
    for (let r = 4; r <= 84; r += 4) {
      const n = Math.max(6, Math.round(r * 0.6));
      for (let k = 0; k < n; k++) {
        const t = k / n * TAU;
        spt(mx + Math.cos(t) * r * 1.05, 0, WZ + 35 + 14 + Math.sin(t) * r * 0.7, 0.9, g, 0.55 * (1 - r / 90), S_POOL, m, 1);
      }
    }
    // light from the cabinet pooling on the wall behind it: soft wide dots, brightest near the marquee
    for (let k = 0; k < 90; k++) {
      const r = Math.sqrt(rng.next()), t = rng.next() * TAU;
      spt(mx + Math.cos(t) * r * 130, 140 + Math.sin(t) * r * 110, WZ, 9 + rng.next() * 9, g, 0.1 * (1 - r * 0.8), S_WGLOW, m, 1);
    }
    // a short neon strip over the cabinet
    sline(mx - 48, 226, WZ, mx + 48, 226, WZ, 1.6, 1.2, g, 0.9, S_NEON, m, 1);
    sline(mx - 48, 232, WZ, mx + 48, 232, WZ, 2.6, 0.8, g, 0.35, S_NEON, m, 1);
  }
  // the wall: a faint dot texture, a wainscot (baseboard, panel seams, chair rail) and the trim where wall meets floor
  // the upper wall is brick in dots: mortar courses and staggered joints, lit up near each cabinet (the light
  // spills up the wall from its marquee, tinted by it) and fading toward the ceiling. Only the stretch any lobby eye
  // can see (BX0..BX1), to keep within the scene buffer.
  const BX0 = -620, BX1 = (N - 1) * FLOOR_SPACING + 320, BRICK_W = 30, BRICK_H = 12, MORTAR = [.42, .38, .9];
  const spill = (x, y) => { let b = 0, bi = 0; for (let m = 0; m < N; m++) { const d = (x - floorX(m)) / 125, v = Math.exp(-d * d); if (v > b) { b = v; bi = m; } } SPILL_M = bi; return b * clamp(1 - (y - 150) / 160, 0.25, 1); };
  const mix = (c, g, t, out) => { out[0] = c[0] + (g[0] - c[0]) * t; out[1] = c[1] + (g[1] - c[1]) * t; out[2] = c[2] + (g[2] - c[2]) * t; return out; };
  const mc = [0, 0, 0];
  for (let y = 104, row = 0; y <= 260; y += BRICK_H, row++) {
    const hf = 1 - (y - 104) / 220;
    for (let x = BX0; x <= BX1; x += 6) { const sp = spill(x, y); spt(x, y, WZ, 0.55, mix(MORTAR, MACHINES[SPILL_M].glow, sp * 0.6, mc), (0.15 + 0.22 * sp) * hf + 0.04, S_WALL); }
    if (y + BRICK_H > 262) break;
    for (let x = BX0 + (row & 1) * BRICK_W / 2; x <= BX1; x += BRICK_W) {
      const sp = spill(x, y + 6);
      for (let k = 1; k <= 1; k++) spt(x, y + 6, WZ, 0.6, mix(MORTAR, MACHINES[SPILL_M].glow, sp * 0.6, mc), (0.15 + 0.2 * sp) * hf + 0.04, S_WALL);
      // the brick's face: one soft wide dot, warmer where the light falls
      spt(x + BRICK_W / 2, y + 6, WZ, 6.5, mix([.3, .25, .6], MACHINES[SPILL_M].glow, sp, mc), (0.025 + 0.08 * sp) * hf, S_WALL);
    }
  }
  // the ceiling. A cornice where it meets the wall (crown line and a dimmer step under it), beams running from the
  // wall toward the viewer (they fan up out of the frame in perspective), and a row of wall-washer lamps on the ceiling
  // edge, each throwing a soft cone of light down the brick. Group S_CEIL: masked around the tagline (see render).
  const CEIL = 300;
  sline(BX0, CEIL, WZ, BX1, CEIL, WZ, 3.2, 0.8, TRIM, 0.42, S_CEIL);
  sline(BX0, CEIL - 5, WZ, BX1, CEIL - 5, WZ, 4, 0.5, TRIM, 0.18, S_CEIL);
  for (let x = BX0 + 20; x <= BX1; x += 110) sline(x, CEIL, WZ, x, CEIL, WZ + 130, 4.5, 0.65, [.4, .36, .85], 0.22, S_CEIL);
  sline(BX0, CEIL, WZ + 45, BX1, CEIL, WZ + 45, 7, 0.5, [.4, .36, .85], 0.1, S_CEIL);
  const LAMP = [1, .85, .6];
  for (let x = BX0 + 75; x <= BX1; x += 110) {
    spt(x, CEIL - 2, WZ + 8, 1.6, [1, .95, .85], 0.9, S_CEIL); spt(x, CEIL - 2, WZ + 8, 7, LAMP, 0.1, S_CEIL);
    for (let k = 0; k < 34; k++) {
      const t = (k + 0.5) / 34, yy = CEIL - 8 - t * 70, w = 6 + t * 34, xx = x + (((k * 37) % 17) / 8 - 1) * w;
      spt(xx, yy, WZ, 4 + t * 5, LAMP, 0.07 * (1 - t), S_CEIL);
    }
  }
  for (let x = LX; x <= RX; x += 14) for (let y = 16; y <= 90; y += 12) spt(x, y, WZ, 0.55, [.4, .38, .8], 0.09, S_WALL);
  sline(LX, 1, WZ + 0.5, RX, 1, WZ + 0.5, 1.8, 0.9, TRIM, 0.55, S_WALL);
  sline(LX, 11, WZ, RX, 11, WZ, 2.4, 0.6, TRIM, 0.4, S_WALL);
  sline(LX, 96, WZ, RX, 96, WZ, 2, 0.85, TRIM, 0.6, S_WALL);
  sline(LX, 100, WZ, RX, 100, WZ, 3.2, 0.5, TRIM, 0.18, S_WALL);
  for (let x = LX; x <= RX; x += 60) sline(x, 13, WZ, x, 94, WZ, 2.6, 0.55, TRIM, 0.3, S_WALL);
  for (let x = LX + 30; x <= RX; x += 120) sline(x, 104, WZ, x, 255, WZ, 3.5, 0.45, TRIM, 0.12, S_WALL);
  // the long neon tube along the wall, with its halo
  sline(LX, 271, WZ, RX, 271, WZ, 1.5, 1.1, TUBE, 0.7, S_TUBE);
  for (let x = LX; x <= RX; x += 9) spt(x + rng.next() * 6, 271 + (rng.next() - 0.5) * 10, WZ, 6 + rng.next() * 5, TUBE, 0.035, S_TUBE);
  // (no cornice line above the tube: from the lobby eye it would sit on the tagline)
  // far-off machines: big soft glows high on the wall
  for (let i = 0; i < 150; i++) spt(LX + rng.next() * (RX - LX), 150 + rng.next() * 140, WZ, 5 + rng.next() * 8, STAR_COLS[i % 7], 0.04, S_WALL);
  // the arcade carpet in front of the machines: a repeating pattern of little starbursts and rings, so the floor in the
  // lower third of the frame reads as a lit carpet, not a void (dimmer toward the wall, where the pools take over)
  const cr = createRng(0xCA4BE7);
  for (let z = WZ + 60, row = 0; z <= 236; z += 26, row++) for (let x = LX + (row & 1) * 22; x <= RX; x += 44) {
    const c = STAR_COLS[(((row * 3 + ((x / 44) | 0)) % 7) + 7) % 7], a = 0.16 + 0.16 * clamp((z - WZ - 60) / 200, 0, 1), ring = (row + ((x / 44) | 0)) & 1;
    if (ring) for (let k = 0; k < 10; k++) spt(x + Math.cos(k * TAU / 10) * 7, 0, z + Math.sin(k * TAU / 10) * 5, 1.1, c, a, S_FLOOR);
    else { spt(x, 0, z, 1.7, c, a * 1.5, S_FLOOR); for (let k = 0; k < 4; k++) { const t = k * TAU / 4 + 0.4; spt(x + Math.cos(t) * 5, 0, z + Math.sin(t) * 3.5, 1.0, c, a, S_FLOOR); spt(x + Math.cos(t) * 10, 0, z + Math.sin(t) * 7, 0.8, c, a * 0.6, S_FLOOR); } }
    spt(x + 22 + (cr.next() - 0.5) * 8, 0, z + 13 + (cr.next() - 0.5) * 6, 0.9, STAR_COLS[(row + 2) % 7], a * 0.7, S_FLOOR);
  }
})();

// dust motes drifting in the light (presentation only, so Math.sin is fine; a fixed seed keeps them the same each visit)
const MOTES = 160, moX = new Float32Array(MOTES), moY = new Float32Array(MOTES), moZ = new Float32Array(MOTES), moP = new Float32Array(MOTES), moC = new Uint8Array(MOTES);
{ const r = new Rng(0x0d057); for (let k = 0; k < MOTES; k++) { moX[k] = r.next() * 720; moY[k] = r.next() * 240; moZ[k] = WALL_Z + 20 + r.next() * 190; moP[k] = r.next() * TAU; moC[k] = k % 7; } }
// the row shift of each machine this frame (see rowShift in lobby-cam.js), and how far it is swung open (0 flush .. 1)
const DX = new Float32Array(N), OPEN = new Float32Array(N);
const camRow = new Float32Array(7);

// ---------- camera ----------
const nav = createNav(N, START_INDEX);
const cam = new Float32Array(7), camFrom = new Float32Array(7);
let Fx = 0, Fy = 0, Fz = -1, Rx = 1, Rz = 0, Ux = 0, Uy = 1, Uz = 0, focal = 190;
// the last projection lives in a typed array, not in module-level lets (a double stored to a module let can be
// boxed as a fresh heap number on each write; proj runs for every dot, so that was per-frame garbage)
const PP = new Float64Array(3);
function basis() {
  const fx = cam[3] - cam[0], fy = cam[4] - cam[1], fz = cam[5] - cam[2];
  const fl = Math.hypot(fx, fy, fz); Fx = fx / fl; Fy = fy / fl; Fz = fz / fl;
  const rl = Math.hypot(Fz, Fx); Rx = -Fz / rl; Rz = Fx / rl;
  Ux = -Rz * Fy; Uy = Rz * Fx - Rx * Fz; Uz = Rx * Fy;
  focal = cam[6];
}
function proj(x, y, z) {
  const dx = x - cam[0], dy = y - cam[1], dz = z - cam[2];
  PP[2] = dx * Fx + dy * Fy + dz * Fz;
  if (PP[2] < 1) return false;
  PP[0] = CX + focal * (dx * Rx + dz * Rz) / PP[2]; PP[1] = H / 2 - focal * (dx * Ux + dy * Uy + dz * Uz) / PP[2];
  return PP[0] > -20 && PP[0] < W + 20 && PP[1] > -20 && PP[1] < H + 20;
}
// the cabinet being drawn: at angle 0 it stands flush (exactly the old row's placement); otherwise it is swung open
// about the hinge at its back-left corner (local x -38, z -70), its front turned toward the left of the screen
let cbMX = 0, cbHX = 0, cbC = 1, cbS = 0, cbFlat = true;
function setCab(i, ang) { cbMX = floorX(i) + DX[i]; cbHX = cbMX - 38; cbFlat = ang === 0; cbC = Math.cos(ang); cbS = Math.sin(ang); }
function projCab(x, y, z) {
  if (cbFlat) return proj(x + cbMX, y, z);
  const dx = x + 38, dz = z - WALL_Z;
  return proj(cbHX + dx * cbC - dz * cbS, y, WALL_Z + dx * cbS + dz * cbC);
}

// ---------- wordmark: a field of dots that drift, then gather into the arcade's name ----------
// Presentation only. Every dot is a preallocated typed-array slot; positions come from a fixed-seed Rng, never Math.random.
// Timeline in ticks (60 Hz): drift, then an ease-out gather, then the tagline fades in, then settled.
const WM_DRIFT = 20, WM_GATHER = 108, WM_TAG = 60, WM_TOTAL = WM_DRIFT + WM_GATHER + WM_TAG;
const WM_MAX = 1400, WM_MIN_DOTS = 320;
const WM_TOP = 4, WM_MAXW = 356, WM_MAXSC = 3.4;
const wmTx = new Float32Array(WM_MAX), wmTy = new Float32Array(WM_MAX), wmSx = new Float32Array(WM_MAX), wmSy = new Float32Array(WM_MAX),
  wmVx = new Float32Array(WM_MAX), wmVy = new Float32Array(WM_MAX), wmPh = new Float32Array(WM_MAX),
  wmR = new Float32Array(WM_MAX), wmG = new Float32Array(WM_MAX), wmB = new Float32Array(WM_MAX), wmStray = new Uint8Array(WM_MAX);
let wmN = 0, wmSc = 1, wmBottom = 0, wmGlyph = 0;
{
  const name = String(ARCADE_NAME).toUpperCase(), rng = new Rng(0x57a7f1e1);
  wmSc = Math.min(WM_MAXSC, WM_MAXW / Math.max(1, textW(name, 1)));
  const w = textW(name, wmSc), x0 = CX - w / 2;
  let x = x0;
  for (let i = 0; i < name.length && wmN < WM_MAX; i++) {
    const g = FONT[name[i]];
    // each lit cell of the 5x7 glyph is two sub-dots on a diagonal, so the name is built from 2x the cells
    if (g) for (let r = 0; r < 7; r++) for (let b = 0; b < 5; b++) if (g[r] && ((g[r] >> (4 - b)) & 1)) for (let q = 0; q < 2 && wmN < WM_MAX - 200; q++) {
      const o = q ? 0.25 : -0.25;
      wmTx[wmN] = x + (b + o) * wmSc; wmTy[wmN] = WM_TOP + (r + o) * wmSc; wmStray[wmN] = 0;
      const k = r / 6;   // cool cyan on top to violet along the bottom rows
      wmR[wmN] = 0.4 + 0.3 * k; wmG[wmN] = 0.95 - 0.45 * k; wmB[wmN] = 1; wmN++;
    }
    x += 6 * wmSc;
  }
  wmBottom = WM_TOP + 7 * wmSc;
  const glyphDots = wmN, strays = Math.max(120, WM_MIN_DOTS - glyphDots);
  wmGlyph = glyphDots;
  for (let i = 0; i < wmN + strays && i < WM_MAX; i++) {
    if (i >= glyphDots) { wmTx[i] = 0; wmTy[i] = 0; wmStray[i] = 1; wmR[i] = 0.7; wmG[i] = 0.8; wmB[i] = 1; }
    wmSx[i] = rng.next() * W; wmSy[i] = i < glyphDots ? rng.next() * 170 : rng.next() * 50;   // strays stay above the cabinet screens
    wmVx[i] = (rng.next() - 0.5) * 0.5; wmVy[i] = (rng.next() - 0.5) * 0.3; wmPh[i] = rng.next() * TAU;
  }
  wmN = Math.min(WM_MAX, glyphDots + strays);
  // strays end near their start, so they simply drift and fade
  for (let i = glyphDots; i < wmN; i++) { wmTx[i] = wmSx[i]; wmTy[i] = wmSy[i]; }
}
const wmReduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
let wmT = wmReduced ? WM_TOTAL : 0, wmHold = -1;
const wmSkip = () => { wmT = WM_TOTAL; };
const wmNow = () => wmHold >= 0 ? wmHold : wmT;
const wmPhase = () => wmNow() >= WM_TOTAL ? 'settled' : 'gather';
const WM_TAGCOL = [.62, .6, .9];
function drawWordmark(al) {
  const t = wmHold >= 0 ? wmHold : wmT >= WM_TOTAL ? WM_TOTAL : wmT + al;
  const gp = clamp((t - WM_DRIFT) / WM_GATHER, 0, 1), e = 1 - (1 - gp) * (1 - gp) * (1 - gp);   // ease-out cubic
  const time = ui.F / 60;
  const boot = 0.15 + 0.85 * (bootT / 60);
  for (let i = 0; i < wmN; i++) {
    const dx = wmSx[i] + wmVx[i] * t, dy = wmSy[i] + wmVy[i] * t + Math.sin(t * 0.05 + wmPh[i]) * 3 * (1 - e);
    const px = dx + (wmTx[i] - dx) * e, py = dy + (wmTy[i] - dy) * e;
    const tw = wmReduced ? 1 : 0.85 + 0.15 * Math.sin(time * 2.2 + wmPh[i]);
    if (wmStray[i]) {
      const a = 0.5 * (1 - e) * tw;   // visible from the first frame, independent of the boot fade
      if (a > 0.004) dot(px, py, 1.6, wmR[i], wmG[i], wmB[i], a);
    } else {
      dot(px, py, 0.8 + (wmSc * 0.72 - 0.8) * e, wmR[i], wmG[i], wmB[i], (0.3 + 0.7 * e) * (e >= 1 ? tw : 1) * boot);
    }
  }
  const ta = smooth(clamp((t - WM_DRIFT - WM_GATHER + 20) / WM_TAG, 0, 1));
  if (ta > 0.004) text(ARCADE_TAGLINE, CX, wmBottom + 5, WM_TAGCOL, 1, 'c', 0.8 * ta);
}

// ---------- app state ----------
// mode: 'lobby' -> 'swing' (select on Starfall: the cabinet swings shut) -> 'dolly' -> 'handoff' (loading Starfall) -> 'gone'
let mode = 'lobby', swingT = 0, swingHold = -1, dollyT = 0, dollyHold = -1, skipFlag = false, manualHandoff = false, handoffReady = false, importStarted = false;
let flashT = 0, flashM = -1, queued = 0, prevMove = 0, footAt = -1, bootT = 0;
let latch = 0, selQ = false;
let tapX = -1, tapY = -1, tapPending = false, swipePending = 0, startedAt = 0;
const rx0 = new Float32Array(N), rx1 = new Float32Array(N), ry0 = new Float32Array(N), ry1 = new Float32Array(N);
const focus = new Float32Array(N);

function step(d) {
  const r = nav.go(nav.index + d);
  if (r === 'step') { sfx('lobbyStep', { alt: altFoot }); altFoot = !altFoot; footAt = Math.round(nav.dur * 0.52); }
  else if (r === 'bump') sfx('lobbyStep', { alt: true });
  return r;
}
function goTo(i) {
  const r = nav.go(i);
  if (r === 'step') { sfx('lobbyStep', { alt: altFoot }); altFoot = !altFoot; footAt = Math.round(nav.dur * 0.52); }
  return r;
}
function select() {
  if (mode !== 'lobby' || nav.moving) return false;
  const m = MACHINES[nav.index];
  if (m.playable) {
    sfx('menuSelect');
    mode = 'swing'; swingT = 0; swingHold = -1; skipFlag = false; handoffReady = false;
  } else {
    flashT = 44; flashM = nav.index;
    sfx('chainBreak'); sfx('menuMove');
  }
  return true;
}

// the swing is done: the cabinet stands flush, and the existing dolly starts from the lobby eye
function beginDolly() {
  rowPose(floorX(nav.index), camFrom);
  mode = 'dolly'; dollyT = 0; swingT = SWING_TICKS; swingHold = -1;
  sfx('clunk');
}
// progress of the Enter move, 0..1
const swingQ = al => swingHold >= 0 ? swingHold : clamp((swingT + al) / SWING_TICKS, 0, 1);
// current angle of machine i: only the selected one stands swung open (a step swings the old one back flush into its
// slot while the new one pulls out); on Enter it swings shut, and every cabinet stays flush after
function cabAngle(i, al) {
  if (mode === 'lobby') { const d = Math.abs(i - nav.pos(al)); return d >= 1 ? 0 : CAB_ANGLE * (1 - d); }
  if (mode !== 'swing' || i !== nav.index) return 0;
  const q = swingQ(al) / SWING_SHUT;
  return q >= 1 ? 0 : swingAngle(q);
}
// where every cabinet stands this frame: the lobby row (rowShift), sliding into the v1 row during the Enter move
// (the previous cabinets on slideL, the selected one with the eye on slideK, the next ones on slideR)
function layout(al, pos) {
  const sel = nav.index, sw = mode === 'swing', sq = sw ? swingQ(al) : 0;
  for (let i = 0; i < N; i++) {
    const k = mode === 'lobby' ? 0 : !sw ? 1 : i < sel ? slideL(sq) : i > sel ? slideR(sq) : slideK(sq);
    const r = mode === 'lobby' ? rowShift(i - pos) : rowShift(i - sel);
    DX[i] = r + (rowDX(i, sel) - r) * k;
    OPEN[i] = cabAngle(i, al) / CAB_ANGLE;
  }
}

// ---------- the wall board: one read when the lobby opens (and when the player comes back to it) ----------
const board = browserBoard(typeof location === 'object' ? location.search : '');
board.refresh();

let starfallLoaded = false;
// Starfall calls this (Esc / Backspace) after it has stopped its own loop, input and audio. Back on the Starfall cabinet:
// resetToLobby stands it swung open again, re-reads the wall board and restarts the loop.
export function returnToLobby() {
  tapPending = false; swipePending = 0; footAt = -1;
  input.releaseAll(); input.clearLatches(); // keys pressed inside Starfall must not select it again
  gfx.resize();
  resetToLobby(); // before the music: onGesture plays nothing while mode is 'gone'
  musicOn = false; onGesture(); // the lobby's own music again
}

function startImport() {
  if (importStarted) return;
  importStarted = true; mode = 'handoff';
  import('../games/starfall/main.js').then(mod => {
    if (starfallLoaded) mod.enterStarfall(); // second and later visits: the module is already loaded, start a fresh cabinet
    starfallLoaded = true; mod.setLobbyReturn(returnToLobby);
    mode = 'gone';
    loop.stop();
    audio.stopMusic({ fadeMs: 250 });
    // any key during the lead-in skips Starfall's intro straight to its title
    if (skipFlag && window.SF) window.SF.skip();
  }).catch(e => { console.error('Starfall failed to load', e); mode = 'lobby'; importStarted = false; });
}

function tick() {
  ui.F++;
  input.poll();
  const m = input.menu;
  // a key tapped and released inside one tick still counts: the keydown latch fills in when nothing is held
  let move = input.move > 0.3 ? 1 : input.move < -0.3 ? -1 : 0;
  if (move === 0) move = latch; latch = 0;
  if (m & M_MUTE) { ui.muted = !ui.muted; audio.setMuted(ui.muted); }
  if (bootT < 60) bootT++;
  if (flashT > 0) flashT--;
  revealTick();
  if (mode === 'lobby') {
    if (wmT < WM_TOTAL && wmHold < 0) wmT++;
    if ((m & M_ANY) && !(m & M_MUTE)) wmSkip();
    nav.tick();
    if (footAt >= 0 && nav.u >= footAt) { footAt = -1; sfx('lobbyStep', { alt: altFoot }); altFoot = !altFoot; }
    if (!nav.moving) {
      let d = move !== 0 ? move : queued; queued = 0;
      if (swipePending) { d = swipePending; swipePending = 0; }
      if (d) step(d);
    } else {
      if (move !== 0 && prevMove === 0) queued = move;
      if (swipePending) { queued = swipePending; swipePending = 0; }
    }
    if (tapPending) { tapPending = false; handleTap(tapX, tapY); }
    // Enter pressed mid-step waits for the step to end, then selects the machine we arrived at
    if (m & (M_FIRE | M_ALT)) selQ = true;
    if (selQ && !nav.moving) { selQ = false; select(); }
  } else if (mode === 'swing') {
    // the swing always finishes (keys mid-swing do nothing but mute), then the dolly takes over
    selQ = false; tapPending = false; swipePending = 0; queued = 0;
    if (swingHold < 0) swingT++;
    if (swingT >= SWING_TICKS && swingHold < 0) beginDolly();
  } else if (mode === 'dolly') {
    selQ = false; tapPending = false; swipePending = 0;
    if ((m & M_ANY) && !(m & M_MUTE) && dollyT > 0) { skipFlag = true; dollyT = DOLLY_TICKS; }
    if (dollyHold < 0) dollyT++;
    if (dollyT >= DOLLY_TICKS) { dollyT = DOLLY_TICKS; if (!manualHandoff) startImport(); else handoffReady = true; }
  } else if (mode === 'handoff') {
    if (m & M_ANY) skipFlag = true;
    if (tapPending) { skipFlag = true; tapPending = false; }
  }
  prevMove = move;
}

addEventListener('keydown', e => {
  if (!e.repeat && mode === 'lobby') {
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') latch = -1; else if (e.code === 'ArrowRight' || e.code === 'KeyD') latch = 1;
  }
});
addEventListener('keydown', e => { if (e.code === 'KeyC' && !e.repeat && mode === 'lobby') setCrt(!ui.crtOn); });

// ---------- pointer: tap a machine, tap an edge arrow, or swipe ----------
let pdX = 0, pdY = 0, pdOn = false;
canvas.addEventListener('pointerdown', e => { onGesture(); wmSkip(); pdX = e.clientX; pdY = e.clientY; pdOn = true; });
canvas.addEventListener('pointerup', e => {
  if (!pdOn) return; pdOn = false;
  const dx = e.clientX - pdX, dy = e.clientY - pdY;
  if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy)) swipePending = dx < 0 ? 1 : -1;
  else if (Math.abs(dx) < 16 && Math.abs(dy) < 16) {
    tapX = gfx.toFieldX(e.clientX); tapY = (e.clientY * gfx.view.dpr - gfx.view.y) / gfx.view.scale; tapPending = true;
  }
});
canvas.addEventListener('pointercancel', () => { pdOn = false; });
function handleTap(fx, fy) {
  // the two arrows beside the name, and the screen edges
  if (fx < 30 || (Math.abs(fx - ARW_L) < 16 && Math.abs(fy - ARW_Y) < 22)) { step(-1); return; }
  if (fx > W - 20 || (Math.abs(fx - ARW_R) < 16 && Math.abs(fy - ARW_Y) < 22)) { step(1); return; }
  // the cabinet, or the name block: play (or the COMING SOON flash)
  const i = nav.index;
  if ((fx >= rx0[i] && fx <= rx1[i] && fy >= ry0[i] && fy <= ry1[i]) || (Math.abs(fx - CX) < 95 && fy > NAME_Y - 10 && fy < HINT_Y + 14)) select();
}

// ---------- screens: each machine's attract animation, drawn as dots on the tube ----------
// Local screen coords: lx 0..64 across, ly 0..48 down. Cabinet-local: x = lx - 32, y = 153 - ly, z = -6 (see projCab).
let scrFade = 1, scrBoost = 1;
function sdot(lx, ly, s, r, g, b, a) {
  if (ui.crtOn) {
    // rounded-tube corners and faint scanlines
    const cx = lx - 32, cy = ly - 24;
    if (Math.abs(cx) > 27 && Math.abs(cy) > 19 && (Math.abs(cx) - 27) * (Math.abs(cy) - 19) > 5) return;
    if ((ly * 0.625 | 0) & 1) a *= 0.72;
  }
  if (!projCab(lx - 32, 153 - ly, -6)) return;
  dot(PP[0], PP[1], clamp(s * focal / PP[2], 0.3, 6), r, g, b, a * scrFade * scrBoost);
}
function stext(str, cx, y, sc, c0, c1, a, wave, t) {
  const w = str.length * 6 * sc - sc;
  let x0 = cx - w / 2;
  for (let i = 0; i < str.length; i++, x0 += 6 * sc) {
    const gl = FONT[str[i]]; if (!gl) continue;
    const wy = wave ? Math.sin(t * 5 + i * 0.7) * wave : 0;
    for (let r = 0; r < 7; r++) {
      const k = r / 6, cr = c0[0] + (c1[0] - c0[0]) * k, cg = c0[1] + (c1[1] - c0[1]) * k, cb = c0[2] + (c1[2] - c0[2]) * k;
      for (let b = 0; b < 5; b++) if ((gl[r] >> (4 - b)) & 1) sdot(x0 + b * sc, y + r * sc + wy, sc * 0.7, cr, cg, cb, a);
    }
  }
}
function sseg(x0, y0, x1, y1, step, s, r, g, b, a) {
  const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / step));
  for (let i = 0; i <= n; i++) sdot(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, s, r, g, b, a);
}
function tri(x) { x = x - Math.floor(x); return x < 0.5 ? x * 2 : 2 - x * 2; }
const WHITE = [1, 1, 1], ROSE = [1, .35, .55], MOTH_A = [1, .35, .5], MOTH_B = [1, .7, .2], TITLE_TOP = [1, .85, .3];

function attractStarfall(t) {
  // falling star field
  for (let i = 0; i < 44; i++) {
    const c = STAR_COLS[i % 7], sp = 5 + (i % 5) * 4;
    sdot((i * 53) % 64, ((i * 29) % 48 + t * sp) % 48, 0.3 + 0.12 * (i % 3), c[0], c[1], c[2], 0.5 + 0.35 * ((i % 3) / 2));
  }
  stext('STARFALL', 32, 6, 1.1, TITLE_TOP, ROSE, 1, 0.5, t);
  // a row of drifting moths and the lantern ship firing
  for (let k = 0; k < 6; k++) {
    const x = 11 + k * 8.4 + 2.6 * Math.sin(t * 1.5 + k), y = 24 + 2 * Math.sin(t * 2.1 + k * 1.3 + 1);
    const c = k % 2 ? MOTH_A : MOTH_B;
    sdot(x, y, 0.8, c[0], c[1], c[2], 1); sdot(x - 1.6, y - 1, 0.6, c[0], c[1], c[2], .8); sdot(x + 1.6, y - 1, 0.6, c[0], c[1], c[2], .8);
    sdot(x - 1, y + 1, 0.5, c[0], c[1], c[2], .7); sdot(x + 1, y + 1, 0.5, c[0], c[1], c[2], .7);
  }
  const sx = 32 + 19 * Math.sin(t * 0.9);
  sdot(sx, 39, 1, 1, 1, 1, 1); sdot(sx, 41, 0.8, 1, .88, .35, 1); sdot(sx - 2, 42.5, 0.7, .25, .95, .88, 1); sdot(sx + 2, 42.5, 0.7, .25, .95, .88, 1);
  sdot(sx, 36.5, 0.6, 1, .88, .35, .8);
  for (let k = 0; k < 3; k++) {
    const ph = (t * 1.6 + k / 3) % 1, bx = 32 + 19 * Math.sin((t - ph * 0.45) * 0.9);
    sdot(bx, 35 - ph * 24, 0.55, .5, 1, 1, 1 - ph * 0.5);
  }
}
function attractSoon(i, t, flash) {
  const m = MP[i], c0 = m.marqueeTop, c1 = m.marqueeBottom;
  const blink = 0.8 + 0.2 * Math.sin(t * 3.2);
  if (flash <= 0) {   // the flash draws its own big COMING SOON; hide this one so they do not double up
    stext('COMING', 32, 4, 1.15, c0, c1, blink, 0, t);
    stext('SOON', 32, 14.5, 1.15, c0, c1, blink, 0, t);
  }
  const id = MACHINES[i].attract, E = m.edge, A = m.amber, T = m.teal;
  if (id === 'blocks') attractBeams(t, E, A, T);
  else if (id === 'race') attractRace(t, E, A, T);
}

// STACKLIGHT: beams of light fall and melt into the stack: a bar of 3 cells, then a plus of 5. No 4-cell pieces.
const BEAM = [new Int8Array([0, 0, 0, 1, 0, 2]), new Int8Array([0, 0, -1, 1, 0, 1, 1, 1, 0, 2])];
function attractBeams(t, E, A, T) {
  sseg(20, 26, 20, 47, 1.6, 0.4, E[0], E[1], E[2], .8); sseg(44, 26, 44, 47, 1.6, 0.4, E[0], E[1], E[2], .8); sseg(20, 47, 44, 47, 1.6, 0.4, E[0], E[1], E[2], .8);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 11; c++) if (((c * 7 + r * 5 + 3) % 11) > 3 - r) sdot(21.6 + c * 2, 45 - r * 2, 0.85, c % 3 ? T[0] : A[0], c % 3 ? T[1] : A[1], c % 3 ? T[2] : A[2], .8);
  const tt = t * 3, drop = Math.floor(tt / 8), st = tt % 8, cells = BEAM[drop & 1];
  const px = 21.6 + 2 * (2 + (drop % 4) * 2), top = 26 + st * 1.5;
  for (let y = top + 6; y < 38; y += 1.6) sdot(px, y, 0.3, A[0], A[1], A[2], 0.22);   // the beam's light trail
  for (let k = 0; k < cells.length; k += 2) sdot(px + cells[k] * 2, top + cells[k + 1] * 2, 0.95, A[0], A[1], A[2], 1);
}

// The platform race (name in machines.js): two runners of light race along floating ledges toward a dawn beacon; the lead swaps as they jump the gaps,
// and a clean landing throws a spark ring. Our own picture: no plumber, no pipes, no mushrooms, no flagpole.
const LEDGE = new Float32Array([0, 21, 42, 29, 45, 37, 53, 69, 43, 77, 90, 38]), LEDGES = LEDGE.length / 3, RUN_L = 96;
let runY = 0, runAir = 0, runLand = 99;
// feet height of a runner at loop position u (0..RUN_L): on a ledge, or on the arc between two ledges
function runAt(u) {
  for (let k = 0; k < LEDGES; k++) {
    const x0 = LEDGE[3 * k], x1 = LEDGE[3 * k + 1];
    if (u >= x0 && u <= x1) { runY = LEDGE[3 * k + 2]; runAir = 0; runLand = u - x0; return; }
    const n = (k + 1) % LEDGES, s1 = k + 1 < LEDGES ? LEDGE[3 * n] : RUN_L;
    if (u > x1 && u < s1) {
      const f = (u - x1) / (s1 - x1), y0 = LEDGE[3 * k + 2], y1 = LEDGE[3 * n + 2];
      runY = y0 + (y1 - y0) * f - 7 * Math.sin(Math.PI * f); runAir = 1; runLand = 99; return;
    }
  }
  runY = LEDGE[2]; runAir = 0; runLand = 99;
}
function runner(sx, t, scroll, c, lead) {
  const u = ((scroll + sx) % RUN_L + RUN_L) % RUN_L;
  runAt(u);
  const y = runY, ph = t * 16 + sx, a = lead ? 1 : 0.75;
  for (let k = 1; k <= 4; k++) sdot(sx - k * 1.5, y - 2.6 - (k & 1) * 0.6, 0.35, c[0], c[1], c[2], (0.5 - k * 0.1) * a);   // speed trail
  sdot(sx + 0.3, y - 5.2, 0.85, 1, 1, 1, a);                               // head
  sdot(sx, y - 3.3, 0.75, c[0], c[1], c[2], a);                            // body
  if (runAir) { sdot(sx - 0.9, y - 1.6, 0.55, c[0], c[1], c[2], a); sdot(sx + 1, y - 1.9, 0.55, c[0], c[1], c[2], a); }
  else { const st = Math.sin(ph); sdot(sx + 1.4 * st, y - 1, 0.55, c[0], c[1], c[2], a); sdot(sx - 1.4 * st, y - 1, 0.55, c[0], c[1], c[2], a); }
  if (runLand < 4) {   // a clean landing throws a spark ring
    const r = 1 + runLand * 0.9, fa = 1 - runLand / 4;
    for (let k = 0; k < 6; k++) sdot(sx + Math.cos(k * 1.047) * r * 1.3, y + Math.sin(k * 1.047) * r * 0.6, 0.4, 1, .95, .7, fa);
  }
}
function attractRace(t, E, A, T) {
  const scroll = t * 17;
  // the dawn beacon they race toward, far off on the right
  const bp = 0.55 + 0.35 * Math.sin(t * 2.4);
  for (let y = 27; y < 46; y += 1.7) sdot(59, y, 0.4, 1, .9, .55, bp * (0.25 + 0.75 * (y - 27) / 19));
  sdot(59, 26, 1.1, 1, .95, .7, bp);
  // ledges scroll left; each is a bright top edge with a dim underside
  for (let rep = 0; rep < 2; rep++) for (let k = 0; k < LEDGES; k++) {
    const x0 = LEDGE[3 * k] - (scroll % RUN_L) + rep * RUN_L, x1 = LEDGE[3 * k + 1] - (scroll % RUN_L) + rep * RUN_L, y = LEDGE[3 * k + 2];
    if (x1 < 0 || x0 > 64) continue;
    for (let x = Math.max(0.5, x0); x <= Math.min(63.5, x1); x += 1.6) { sdot(x, y, 0.5, E[0], E[1], E[2], 0.95); sdot(x, y + 1.6, 0.4, E[0], E[1], E[2], 0.3); }
  }
  // the two runners swap the lead
  const sw = Math.sin(t * 0.8), aX = 30 + 7 * sw, bX = 30 - 7 * sw;
  if (sw > 0) { runner(bX, t, scroll, T, false); runner(aX, t + 0.3, scroll, A, true); }
  else { runner(aX, t + 0.3, scroll, A, false); runner(bX, t, scroll, T, true); }
}
// dark glass, with a faint wash of the machine's colour so every tube reads as switched on
function drawScreen(i, t, flash) {
  const g = MACHINES[i].glow;
  for (let y = 1; y < 48; y += 2.4) for (let x = 1; x < 64; x += 2.4) sdot(x, y, 0.5, g[0], g[1], g[2], 0.05);
  if (MACHINES[i].attract === 'starfall') attractStarfall(t); else attractSoon(i, t, flash);
  if (flash > 0) {
    const fa = Math.min(1, flash / 12);
    stext('COMING', 32, 9, 1.75, WHITE, g, fa, 0, t); stext('SOON', 32, 24, 1.75, WHITE, g, fa, 0, t);
  }
}

// ---------- drawing ----------
let sceneFade = 1, bdX0 = -1, bdX1 = -1, bdY0 = -1, bdY1 = -1;
function occluded(px, py) {
  for (let i = 0; i < N; i++) if (px > rx0[i] && px < rx1[i] && py > ry0[i] && py < ry1[i]) return true;
  return false;
}
// sideL / sideR: strength of the left / right flank dots; openK: 1 swung open .. 0 flush (the extra flank edges)
function drawMachine(i, itm, bright, sideL, sideR, openK, refl) {
  const SD = SIDE[i];
  const geo = GEO[i], playable = MACHINES[i].playable;
  const X = geo.X, Y = geo.Y, Z = geo.Z, S = geo.S, R = geo.R, G = geo.G, B = geo.B, A = geo.A, GR = geo.Grp, n = geo.n;
  const blink = ((itm % 1) + 1) % 1 < 0.6, sweep = (((itm * 70) % 160) + 160) % 160 - 80;
  const fl = flashM === i && flashT > 0 ? flashT / 44 : 0;
  for (let k = 0; k < n; k++) {
    const g = GR[k];
    let a = A[k] * bright;
    if (SD[k] === 1) a *= sideL; else if (SD[k] === 2) a *= sideR;
    if (g === G_LAMP) a *= playable ? 0.7 + 0.3 * Math.sin(itm * 3) : 0.32 + fl * 1.2;
    else if (g === G_INSERT) a *= playable ? (blink ? 1 : 0.1) : 0.1;
    else if (g === G_CREDIT1) continue;
    else if (g === G_MARQ) a *= 0.85 + 0.6 * Math.max(0, 1 - Math.abs(sweep - X[k]) / 9) + fl * 1.4;
    else if (g === G_BTN) a *= (playable ? 0.75 : 0.4) + 0.25 * Math.sin(itm * 4 + X[k] * 0.3);
    if (a < 0.004 || !projCab(X[k], Y[k], Z[k])) continue;
    dot(PP[0], PP[1], clamp(S[k] * focal / PP[2], 0.35, 7), R[k], G[k], B[k], a);
    // a soft reflection of the cabinet's lower body in the polished floor
    if (refl > 0 && (k & 1) === 0 && Y[k] < 110 && projCab(X[k], -Y[k], Z[k])) dot(PP[0], PP[1], clamp(S[k] * focal / PP[2], 0.35, 7), R[k], G[k], B[k], a * refl * 0.16 * (1 - Y[k] / 110));
  }
  const ea = 0.7 * bright * openK, E = MP[i].edge, Pm = MP[i];
  if (ea > 0.004) for (let k = 0; k < saN; k++) {
    if (!projCab(38, saY[k], saZ[k])) continue;
    const c = saK[k] === 0 ? E : saK[k] === 1 ? Pm.teal : saK[k] === 2 ? Pm.amber : Pm.gold;
    dot(PP[0], PP[1], clamp(1.25 * focal / PP[2], 0.35, 5), c[0], c[1], c[2], saA[k] * ea * (0.85 + 0.15 * Math.sin(itm * 2 + saY[k] * 0.05)));
  }
  if (ea > 0.004) for (let k = 0; k < xeN; k++) if (projCab(xeX[k], xeY[k], xeZ[k])) dot(PP[0], PP[1], clamp(0.55 * focal / PP[2], 0.35, 7), E[0], E[1], E[2], ea);
}

// the band from the wordmark's bottom row through the tagline (field coords, with a margin): ceiling, cornice and
// lamp dots stay out of it, so no line runs under the name or through the tagline (they show at the sides and above)
let tgX0 = 0, tgX1 = 0, tgY0 = 0, tgY1 = 0;
function render(al) {
  if (tgX1 === 0) { const hw = Math.max(textW(ARCADE_TAGLINE, 1), WM_MAXW) / 2 + 8; tgX0 = CX - hw; tgX1 = CX + hw; tgY0 = wmBottom - 5; tgY1 = wmBottom + 17; }
  fpsT[fpsN++ & 255] = performance.now();
  posterDrawn.fill(0);
  if (gfx.lost) return;
  const time = (ui.F + al) / 60;
  const inLobby = mode === 'lobby' || mode === 'swing';
  // camera
  let q = 0;
  if (inLobby) {
    floorPose(nav, al, time, cam);
    // the Enter move: the eye walks to the v1 lobby's spot in front of the cabinet as the row slides together
    if (mode === 'swing') { const k = slideK(swingQ(al)); rowPose(floorX(nav.index), camRow); for (let j = 0; j < 7; j++) cam[j] += (camRow[j] - cam[j]) * k; }
  } else {
    q = dollyHold >= 0 ? dollyHold : clamp((dollyT + (mode === 'dolly' ? al : 0)) / DOLLY_TICKS, 0, 1);
    if (mode !== 'dolly' && dollyHold < 0) q = 1;
    dollyPose(camFrom, floorX(START_INDEX), q, cam);
    if (q >= 1) coinDoorPose(floorX(START_INDEX), cam);
  }
  basis();
  gfx.reset();
  const fade = inLobby ? 1 : 1 - smooth(clamp((q - 0.1) / 0.5, 0, 1));
  const boot = bootT < 60 ? smooth((bootT + al) / 60) : 1;
  sceneFade = fade * boot;
  const pos = nav.pos(al);
  layout(al, pos);
  // silhouettes of every cabinet (the 8 corners of its box): hide wall dots behind them, and give taps something to hit
  for (let i = 0; i < N; i++) {
    setCab(i, cabAngle(i, al));
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let k = 0; k < 8; k++) {
      projCab(k & 1 ? 38 : -38, k & 2 ? 190 : 0, k & 4 ? -70 : 0);
      if (PP[0] < x0) x0 = PP[0]; if (PP[0] > x1) x1 = PP[0]; if (PP[1] < y0) y0 = PP[1]; if (PP[1] > y1) y1 = PP[1];
    }
    rx0[i] = x0; rx1[i] = x1; ry0[i] = y0; ry1[i] = y1;
    const f = 1 - Math.min(1, Math.abs(pos - i));
    focus[i] = f > 0 ? f : 0;
  }
  // the selected board's glass hides the wall behind it (once it is more than half faded in)
  bdX0 = bdX1 = bdY0 = bdY1 = -1;
  { const bi = Math.round(pos);
    if (mode === 'lobby' && focus[bi] > 0.8 && proj(floorX(bi) + DX[bi] + BOARD_WX, BOARD_WY, WALL_Z)) {
      const k = 0.94 * clamp(focal / PP[2] / KREF, 0.5, 2); bdX0 = PP[0]; bdY0 = PP[1]; bdX1 = PP[0] + BOARD_W * k; bdY1 = PP[1] + BOARD_H * k;
    } }
  if (inLobby || fade > 0.003) {
    // the neon tube hums, and now and then stutters (a short hash of the frame time, no randomness)
    const hum = 0.88 + 0.12 * Math.sin(time * 9.3) * Math.sin(time * 2.1);
    // the tube and cornice fade as the eye walks to the v1 spot (from there they would cross the wordmark)
    const topK = mode === 'lobby' ? 1 : mode === 'swing' ? 1 - slideK(swingQ(al)) : 0;
    const fz = time % 7.3, tube = fz > 5.1 && fz < 5.5 ? (Math.sin(fz * 90) > 0 ? 0.25 : 1) : hum;
    for (let k = 0; k < sN; k++) {
      const g = sGrp[k], mi = sMi[k];
      let a = sA[k] * sceneFade;
      if (g === S_POOL || g === S_WGLOW) a *= 0.45 + 0.8 * focus[mi];
      else if (g === S_NEON) a *= mi === 255 ? topK : 0.35 + 0.65 * focus[mi];   // a neighbour's strip is dimmer; 255: the cornice
      else if (g === S_TUBE) a *= tube * topK;
      if (a < 0.004 || !proj(sX[k] + (sBnd[k] ? DX[mi] + POOL_DX * OPEN[mi] : 0), sY[k], g === S_POOL ? sZ[k] + (POOL_Z - WALL_Z - 35) * OPEN[mi] : sZ[k])) continue;
      if (g >= S_WALL && (occluded(PP[0], PP[1]) || (PP[0] > bdX0 && PP[0] < bdX1 && PP[1] > bdY0 && PP[1] < bdY1))) continue;
      if (g === S_CEIL && PP[0] > tgX0 && PP[0] < tgX1 && PP[1] > tgY0 && PP[1] < tgY1) continue;   // keep clear of the tagline
      dot(PP[0], PP[1], clamp(sS[k] * focal / PP[2], 0.3, 9), sR[k], sG[k], sB[k], a);
    }
    // dust motes: they rise slowly through the light and twinkle; the field wraps around the eye as it walks
    const mx0 = cam[0] - 300;
    for (let k = 0; k < MOTES; k++) {
      const x = mx0 + (((moX[k] + Math.sin(time * 0.21 + moP[k]) * 14 - mx0) % 720) + 720) % 720;
      const y = 8 + ((moY[k] + time * 4.5) % 240), tw = 0.5 + 0.5 * Math.sin(time * 1.7 + moP[k] * 3);
      if (!proj(x, y, moZ[k] + Math.sin(time * 0.3 + moP[k]) * 10)) continue;
      const c = STAR_COLS[moC[k]];
      dot(PP[0], PP[1], clamp(0.7 * focal / PP[2], 0.35, 2.2), 0.6 + 0.4 * c[0], 0.6 + 0.4 * c[1], 0.6 + 0.4 * c[2], (0.08 + 0.28 * tw * tw) * sceneFade);
    }
    // the wall boards hang behind the cabinets, so they go first
    // (the selected one dims away while its cabinet swings shut across it; gone by q 0.17, as the previous
    // cabinet, now sliding in from the start, crosses it)
    const bf = mode === 'swing' ? 1 - smooth(clamp(swingQ(al) * 6, 0, 1)) : inLobby ? 1 : 0;
    for (let i = 0; i < N; i++) if (Math.abs(i - pos) < 1) drawBoard(i, sceneFade * (i === nav.index ? bf : 1));
  }
  for (let i = 0; i < N; i++) {
    const isSf = i === START_INDEX;
    if (!isSf && fade <= 0.003) continue;
    if (inLobby && Math.abs(i - pos) > 2.3) continue;
    const ang = cabAngle(i, al), openK = ang / CAB_ANGLE;
    setCab(i, ang);
    // Starfall's animation clock runs up to zero at the end of the dolly, matching the intro's first frame; the swing
    // runs on the same clock, so the lamps and marquee sweep carry on without a jump when the dolly starts
    let itm = time + i * 0.37;
    if (isSf && mode === 'swing') itm = (Math.min(swingHold >= 0 ? swingHold * SWING_TICKS : swingT + al, SWING_TICKS) - SWING_TICKS - DOLLY_TICKS) / 60;
    else if (isSf && !inLobby) itm = (Math.min(dollyT + (mode === 'dolly' ? al : 0), DOLLY_TICKS) - DOLLY_TICKS) / 60;
    const lb = 0.68 + 0.47 * focus[i], bright = isSf ? (inLobby ? lb * boot : lb + (1 - lb) * smooth(q)) : lb * fade * boot;
    const dk = isSf && !inLobby ? 0.1 + 0.9 * smooth(q) : 0.1;
    drawMachine(i, itm, bright, dk, Math.max(dk, 0.1 + 0.9 * openK), openK, inLobby ? 1 : fade);
    if (inLobby || fade > 0.003) {
      scrFade = (isSf && !inLobby ? fade : sceneFade) * (0.75 + 0.25 * focus[i]);
      scrBoost = flashM === i && flashT > 0 ? 1 + flashT / 20 : 1;
      drawScreen(i, time + i * 1.7, flashM === i ? flashT : 0);
    }
  }
  if (inLobby) drawHud(time, al);
  gfx.clearCanvas();
  gfx.toViewport();
  gfx.drawDots(gfx.count(), 0, 0);
}

const DIM = [.45, .45, .62], GOLD = [1, .84, .3], WH = [1, 1, 1], AMBER = [1, .62, .2], FAINT = [.3, .3, .45];
const SILVER = [.8, .86, 1], BRONZE = [1, .55, .3], VIOLET = [.62, .45, 1];
// a clickable arrow made of two rows of dots, with a soft glow
function chevron(x, y, d, a, sz) {
  for (let k = 0; k <= 5; k++) {
    const o = k * 2.2 * sz, tip = d * (5 - k) * 1.7 * sz;
    dot(x + tip, y - o, 1.6 * sz, 1, 1, 1, a); dot(x + tip, y + o, 1.6 * sz, 1, 1, 1, a);
    dot(x + tip, y - o, 4.5 * sz, .6, .7, 1, a * 0.12); dot(x + tip, y + o, 4.5 * sz, .6, .7, 1, a * 0.12);
  }
}
// Big bold dot type in the wordmark's style: each lit cell of the 5x7 glyph is two sub-dots on a diagonal, coloured
// top to bottom from c0 to c1, with a faint glow dot behind it. A bright band sweeps across at field x `shine`.
function bigText(str, x, y, sc, c0, c1, a, align, shine) {
  const w = textW(str, sc);
  let x0 = align === 'c' ? x - w / 2 : align === 'r' ? x - w : x;
  for (let i = 0; i < str.length; i++, x0 += 6 * sc) {
    const gl = FONT[str[i]]; if (!gl) continue;
    for (let r = 0; r < 7; r++) {
      const row = gl[r]; if (!row) continue;
      const k = r / 6, cr = c0[0] + (c1[0] - c0[0]) * k, cg = c0[1] + (c1[1] - c0[1]) * k, cb = c0[2] + (c1[2] - c0[2]) * k;
      for (let b = 0; b < 5; b++) if ((row >> (4 - b)) & 1) {
        const px = x0 + b * sc, py = y + r * sc, sh = Math.max(0, 1 - Math.abs(px - shine) / (4 * sc));
        const R = cr + (1 - cr) * sh, G = cg + (1 - cg) * sh, B = cb + (1 - cb) * sh;
        dot(px, py, sc * 2.4, cr, cg, cb, a * 0.07);
        dot(px - 0.25 * sc, py - 0.25 * sc, sc * 0.72, R, G, B, a);
        dot(px + 0.25 * sc, py + 0.25 * sc, sc * 0.72, R, G, B, a);
      }
    }
  }
}
// small text that types in: only the first `nmax` characters show; `cyc` > 0 cycles each character through the star colours
function ftext(str, x, y, col, sc, align, a, nmax, cyc) {
  const w = textW(str, sc);
  let x0 = align === 'c' ? x - w / 2 : align === 'r' ? x - w : x;
  const n = Math.min(str.length, nmax);
  for (let i = 0; i < n; i++, x0 += 6 * sc) {
    const gl = FONT[str[i]]; if (!gl) continue;
    const c = cyc > 0 ? STAR_COLS[(i + (cyc | 0)) % 7] : col;
    for (let r = 0; r < 7; r++) { const row = gl[r]; if (row) for (let b = 0; b < 5; b++) if ((row >> (4 - b)) & 1) dot(x0 + b * sc, y + r * sc, sc * 0.95, c[0], c[1], c[2], a); }
  }
  // the typing head: a bright cursor dot just after the last character shown
  if (n < str.length && n > 0) dot(x0 + 2 * sc, y + 3.5 * sc, 2 * sc, 1, 1, 1, a * 0.8);
}
const PIP_Y = Math.ceil(wmBottom + 5 + 7 + 8);
// the selector at the bottom centre: name, genre, hint, and the arrows either side (field units)
const NAME_Y = 236, GENRE_Y = 261, HINT_Y = 275, ARW_L = CX - 112, ARW_R = CX + 112, ARW_Y = NAME_Y + 8;
const NAME_SC = MACHINES.map(m => Math.min(2.6, 168 / textW(m.name, 1)));
const NAME_LIGHT = MACHINES.map(m => [.55 + .45 * m.glow[0], .55 + .45 * m.glow[1], .55 + .45 * m.glow[2]]);
function drawHud(time, al) {
  const m = MACHINES[nav.index], a = (nav.moving ? 0.3 : 1) * (mode === 'swing' ? 1 - smooth(clamp(swingQ(al) * 2, 0, 1)) : 1);
  drawWordmark(al);   // the arcade's name: the HUD title
  // position pips
  for (let i = 0; i < N; i++) {
    const f = focus[i], x = CX + (i - (N - 1) / 2) * 9;
    dot(x, PIP_Y, 1.2 + 1.3 * f, MACHINES[i].glow[0], MACHINES[i].glow[1], MACHINES[i].glow[2], 0.3 + 0.7 * f);
  }
  const g = m.glow, sc = NAME_SC[nav.index], nw = textW(m.name, sc);
  // a soft pool of the machine's light behind the name
  for (let k = -6; k <= 6; k++) dot(CX + k * 16, NAME_Y + 9, 22, g[0], g[1], g[2], 0.018 * a * (1 - Math.abs(k) / 7));
  const shine = CX - nw / 2 - 30 + ((time * 70) % (nw + 160));
  bigText(m.name, CX, NAME_Y + (2.6 - sc) * 3.5, sc, NAME_LIGHT[nav.index], g, a, 'c', shine);
  text(m.genre, CX, GENRE_Y, DIM, 1, 'c', a);
  // the arcade prompt: a hard blink, like an attract-mode PRESS START
  const on = (time * 1.9) % 1 < 0.62 ? 1 : 0.3, hc = m.playable ? GOLD : g;
  for (let k = -4; k <= 4; k++) dot(CX + k * 11, HINT_Y + 3, 13, hc[0], hc[1], hc[2], 0.05 * on * a * (1 - Math.abs(k) / 5));
  if (m.playable) { text(PLAY_HINT, CX, HINT_Y, GOLD, 1.2, 'c', on * a); text(PLAY_HINT, CX, HINT_Y, WH, 1.2, 'c', 0.35 * on * a); }
  else text('COMING SOON', CX, HINT_Y, g, 1.2, 'c', on * a);
  // arrows either side of the name: they pulse and nudge outward
  const pl = (0.5 + 0.4 * Math.sin(time * 3)) * (mode === 'swing' ? a : 1), nudge = 2.5 * Math.max(0, Math.sin(time * 3));
  if (nav.index > 0) chevron(ARW_L - nudge, ARW_Y, -1, pl, 1.1);
  if (nav.index < N - 1) chevron(ARW_R + nudge, ARW_Y, 1, pl, 1.1);
}

// ---------- the wall board ----------
// An arcade high-score panel on the wall to the left of each cabinet. Its top-left corner is a wall point, projected
// each frame, and its size follows that point's depth (so it slides with the room). A thick dot frame with chasing
// bulbs, the game's name in the big bold type, and rows that type in one after another when you arrive.
const BOARD_W = 136, BOARD_H = 166, ROW_SC = 0.85, ROW_H = 10;
const KREF = LOBBY_FOC / (FLOOR_EYE_Z - WALL_Z);
const BOARD_SC = MACHINES.map(m => Math.min(1.7, (BOARD_W - 22) / textW(m.name, 1)));
const HASH = [10, 10, 31, 10, 31, 10, 10];
function hashGlyph(x, y, sc, c, a) {
  for (let r = 0; r < 7; r++) for (let b = 0; b < 5; b++) if ((HASH[r] >> (4 - b)) & 1) dot(x + b * sc, y + r * sc, sc * 0.95, c[0], c[1], c[2], a);
}
function bline(x0, y0, x1, y1, st, s, c, a) {
  const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / st));
  for (let i = 0; i <= n; i++) dot(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, s, c[0], c[1], c[2], a);
}
function rect(x, y, w, h, st, s, c, a) { bline(x, y, x + w, y, st, s, c, a); bline(x, y + h, x + w, y + h, st, s, c, a); bline(x, y, x, y + h, st, s, c, a); bline(x + w, y, x + w, y + h, st, s, c, a); }
// chasing marquee bulbs around the frame: every 4th bulb lit, the pattern runs clockwise
function bulbs(x, y, w, h, k, c, a, F) {
  const st = 6.5 * k, nx = Math.max(2, Math.round(w / st)), ny = Math.max(2, Math.round(h / st)), tot = 2 * (nx + ny), ph = (F / 5) | 0;
  for (let j = 0; j < tot; j++) {
    let px, py;
    if (j < nx) { px = x + w * j / nx; py = y; }
    else if (j < nx + ny) { px = x + w; py = y + h * (j - nx) / ny; }
    else if (j < 2 * nx + ny) { px = x + w - w * (j - nx - ny) / nx; py = y + h; }
    else { px = x; py = y + h - h * (j - 2 * nx - ny) / ny; }
    const lit = ((j - ph) % 4 + 4) % 4 === 0;
    if (lit) { dot(px, py, 1.9 * k, 1, .95, .8, a); dot(px, py, 6 * k, c[0], c[1], c[2], 0.12 * a); }
    else dot(px, py, 1.3 * k, c[0], c[1], c[2], 0.4 * a);
  }
}
// ---------- the COMING SOON poster pasted across a non-playable machine's board ----------
// A sheet of aged paper in dots, slapped on at a tilt: a torn left edge and a torn-off top-left corner, the bottom-right
// corner curled up (its flap shows the paper's darker back), two strips of tape at the top corners, and COMING SOON in
// bold red ink in the board's own 5x7 type (each cell four sub-dots). Built once in poster-local units (board units,
// origin at the sheet's centre, v down); drawBoard only transforms it, so the frame allocates nothing. The dots blend
// additively, so the ink is a knockout: no paper dot sits under a letter, and the board's rows hide under the sheet.
const PO_HW = 61, PO_HH = 30, PO_CU = 68, PO_CV = 89, PO_ANG = -0.17, PO_C = Math.cos(PO_ANG), PO_S = Math.sin(PO_ANG);
const PO_MAX = 4200, poU = new Float32Array(PO_MAX), poV = new Float32Array(PO_MAX), poSz = new Float32Array(PO_MAX),
  poR = new Float32Array(PO_MAX), poG = new Float32Array(PO_MAX), poB = new Float32Array(PO_MAX), poA = new Float32Array(PO_MAX);
let poN = 0;
{
  const hsh = i => (Math.imul(i ^ 0x5bd1e995, 0x2c1b3c6d) >>> 0) / 4294967296;
  const add = (u, v, s, c, a) => { if (poN >= PO_MAX) return; poU[poN] = u; poV[poN] = v; poSz[poN] = s; poR[poN] = c[0]; poG[poN] = c[1]; poB[poN] = c[2]; poA[poN++] = a; };
  // the ink: two lines, centred, cells of PO_SC
  const PO_SC = 2.5, LINES = ['COMING', 'SOON'], TOPS = [-PO_HH + 6.5, 0.5];
  const inkAt = (u, v) => {
    for (let l = 0; l < 2; l++) {
      const str = LINES[l], x0 = -textW(str, PO_SC) / 2, r = Math.round((v - TOPS[l]) / PO_SC);
      if (r < 0 || r > 6) continue;
      const ci = Math.floor((u - x0 + PO_SC * 0.5) / (6 * PO_SC)); if (ci < 0 || ci >= str.length) continue;
      const b = Math.round((u - x0 - ci * 6 * PO_SC) / PO_SC); if (b < 0 || b > 4) continue;
      if ((FONT[str[ci]][r] >> (4 - b)) & 1) return true;
    }
    return false;
  };
  const CURL = 13;   // the curled corner's fold, measured along both edges from the bottom-right corner
  const inFlap = (u, v) => (PO_HW - u) + (PO_HH - v) < CURL;
  const PAPER = [1, .93, .76], AGED = [.95, .74, .42], BACK = [.78, .68, .5], INK = [1, .2, .16];
  let i = 0;
  for (let v = -PO_HH; v <= PO_HH; v += 2.1) for (let u = -PO_HW; u <= PO_HW; u += 2.1, i++) {
    const h = hsh(i), h2 = hsh(i + 7919);
    if (u < -PO_HW + 2.4 * hsh(((v * 3) | 0) + 99)) continue;                  // torn left edge
    if (v > PO_HH - 1.6 * hsh(((u * 2) | 0) + 17)) continue;                   // ragged bottom edge
    if ((u + PO_HW) + (v + PO_HH) < 8 + 3 * h) continue;                     // torn-off top-left corner
    if (inFlap(u, v)) continue;
    if (inkAt(u, v)) continue;
    const e = Math.min(PO_HW - Math.abs(u), PO_HH - Math.abs(v)), age = clamp(1 - e / 9, 0, 1) * 0.8 + h2 * 0.25;
    const c = age > 0.5 ? AGED : PAPER;
    add(u, v, 2.1 + h * 0.5, c, (0.36 + 0.08 * h) * (1 - 0.3 * age));
  }
  // the printed rule just inside the sheet, broken where the paper is torn
  for (let u = -PO_HW + 6; u <= PO_HW - 6; u += 1.6) { add(u, -PO_HH + 3.5, 0.55, INK, 0.45); if (u < PO_HW - CURL - 2) add(u, PO_HH - 3.5, 0.55, INK, 0.45); }
  for (let v = -PO_HH + 3.5; v <= PO_HH - 3.5; v += 1.6) { add(-PO_HW + 5, v, 0.55, INK, 0.45); if (v < PO_HH - CURL - 2) add(PO_HW - 3.5, v, 0.55, INK, 0.45); }
  // the letters: each lit cell is four sub-dots, so the type reads bold; a soft bleed of ink behind
  for (let l = 0; l < 2; l++) {
    const str = LINES[l]; let x0 = -textW(str, PO_SC) / 2;
    for (let ci = 0; ci < str.length; ci++, x0 += 6 * PO_SC) for (let r = 0; r < 7; r++) for (let b = 0; b < 5; b++) if ((FONT[str[ci]][r] >> (4 - b)) & 1) {
      const cu = x0 + b * PO_SC, cv = TOPS[l] + r * PO_SC;
      for (let q = 0; q < 4; q++) add(cu + (q & 1 ? 0.6 : -0.6), cv + (q & 2 ? 0.6 : -0.6), 1.15, INK, 0.95);
      add(cu, cv, 3.2, INK, 0.07);
    }
  }
  // the curled flap: the paper's back, folded over the corner, shaded darker toward the fold, with a crisp fold line
  const fx0 = PO_HW - CURL, fy0 = PO_HH - CURL;
  for (let v = fy0; v <= PO_HH; v += 1.8) for (let u = fx0; u <= PO_HW; u += 1.8) {
    const d = (u - fx0) + (v - fy0); if (d > CURL) continue;
    add(u, v, 1.6, BACK, 0.22 + 0.16 * (d / CURL));
  }
  for (let t = 0; t <= 1; t += 0.06) add(fx0 + CURL * t, PO_HH - CURL * t, 0.7, PAPER, 0.7);
  // two strips of tape over the top corners: pale, see-through, a little crooked, with frayed ends
  const tape = (cu, cv, ang) => {
    const c = Math.cos(ang), s = Math.sin(ang);
    for (let a = -11; a <= 11; a += 1.5) for (let b = -3.5; b <= 3.5; b += 1.5) {
      if (Math.abs(a) > 10 && hsh(((a * 13 + b * 7) | 0) + 400) < 0.5) continue;
      add(cu + a * c - b * s, cv + a * s + b * c, 1.5, [1, .97, .78], Math.abs(b) > 3 ? 0.2 : 0.12);
    }
  };
  tape(-PO_HW + 4, -PO_HH + 2, -0.62); tape(PO_HW - 3, -PO_HH + 1, 0.55);
}
const POT = new Float64Array([0, 0, 1]);   // this frame's poster transform x, y, scale (set by drawBoard)
// is field point (px, py) under the poster sheet, widened by pad board units? (the board's rows behind it are not drawn)
function underPoster(px, py, pad = 1) {
  const du = (px - POT[0]) / POT[2], dv = (py - POT[1]) / POT[2], u = du * PO_C + dv * PO_S, v = -du * PO_S + dv * PO_C;
  return u > -PO_HW - pad && u < PO_HW + pad && v > -PO_HH - pad && v < PO_HH + pad;
}
// a rank number (right edge xr, top y, height h) is drawn whole or not at all: if any corner of it comes within
// reach of the sheet or its tape (the tape strips stand out about 9 units past the sheet), it is left out
const PO_TAPE = 10;
const rankCovered = (xl, xr, y, h) => underPoster(xl, y, PO_TAPE) || underPoster(xr, y, PO_TAPE) || underPoster(xl, y + h, PO_TAPE) || underPoster(xr, y + h, PO_TAPE);
// which machines' posters the last frame drew (read by LOBBY.posterShown)
const posterDrawn = new Uint8Array(N);
function drawPoster(i, a) {
  posterDrawn[i] = 1;
  const c = PO_C * POT[2], s = PO_S * POT[2];
  for (let j = 0; j < poN; j++) {
    const u = poU[j], v = poV[j];
    dot(POT[0] + u * c - v * s, POT[1] + u * s + v * c, poSz[j] * POT[2], poR[j], poG[j], poB[j], poA[j] * a);
  }
}
// the row reveal: restarts whenever you arrive at a machine or its board's answer comes in
let revT = 0, revKey = -2;
function revealTick() {
  const rk = nav.moving ? -1 : nav.index * 8 + (board.state === 'ok' ? 1 : board.state === 'offline' ? 2 : 0);
  if (rk !== revKey) { revKey = rk; revT = 0; } else if (revT < 1000) revT++;
}
const rowChars = r => clamp((revT - 6 - r * 5) * 0.9, 0, 40);
function drawBoard(i, fa) {
  if (fa < 0.004 || !proj(floorX(i) + DX[i] + BOARD_WX, BOARD_WY, WALL_Z)) return;
  const k = 0.94 * clamp(focal / PP[2] / KREF, 0.5, 2), x = PP[0], y = PP[1], w = BOARD_W * k, h = BOARD_H * k;
  // only the selected machine's board shows: it fades out over the first half of a step and the next one in over the second
  const g = MACHINES[i].glow, a = fa * smooth(clamp(focus[i] * 2 - 1, 0, 1));
  if (a < 0.004) return;
  const F = ui.F, time = F / 60;
  // halo on the wall, then the glass: dim scanlines tinted by the machine
  for (let j = 0; j < 14; j++) dot(x + w * (j % 7 + 0.5) / 7, y + (j < 7 ? 0.2 : 0.8) * h, 34 * k, g[0], g[1], g[2], 0.022 * a);
  for (let yy = y + 3 * k, r = 0; yy < y + h - 2 * k; yy += 2.6 * k, r++) {
    const sa = (r & 1 ? 0.018 : 0.042) * a;
    for (let xx = x + 3 * k; xx < x + w - 2 * k; xx += 3.4 * k) dot(xx, yy, 0.9 * k, g[0] * .5, g[1] * .5, g[2] * .7 + .2, sa);
  }
  // a slow bright sweep down the glass
  const sw = y + ((time * 40 * k) % (h * 1.6));
  if (sw < y + h) bline(x + 3 * k, sw, x + w - 3 * k, sw, 3 * k, 0.8 * k, g, 0.12 * a);
  // the thick frame: outer glow line, bright main line, inner line, corner studs, chasing bulbs outside
  rect(x - 2 * k, y - 2 * k, w + 4 * k, h + 4 * k, 2.4 * k, 1.1 * k, g, 0.35 * a);
  rect(x, y, w, h, 1.5 * k, 0.85 * k, g, 0.85 * a);
  rect(x + 2.2 * k, y + 2.2 * k, w - 4.4 * k, h - 4.4 * k, 2.6 * k, 0.6 * k, VIOLET, 0.35 * a);
  bulbs(x - 6 * k, y - 6 * k, w + 12 * k, h + 12 * k, k, g, a, F);
  // the title: the game's name in the big bold type, a soft shine running across it
  const tsc = BOARD_SC[i] * k, cx = x + w / 2;
  bigText(MACHINES[i].name, cx, y + 8 * k, tsc, NAME_LIGHT[i], g, a, 'c', cx - w * 0.7 + ((time * 50 * k) % (w * 1.4)));
  text('ALL-TIME TOP 10', cx, y + 25 * k, VIOLET, 0.75 * k, 'c', 0.9 * a);
  bline(x + 8 * k, y + 28 * k, x + 28 * k, y + 28 * k, 2.2 * k, 0.6 * k, VIOLET, 0.5 * a);
  bline(x + w - 28 * k, y + 28 * k, x + w - 8 * k, y + 28 * k, 2.2 * k, 0.6 * k, VIOLET, 0.5 * a);
  const sc = ROW_SC * k, top = y + 35 * k, rh = ROW_H * k, xr = x + 17 * k, xn = x + 22 * k, xs = x + w - 8 * k, foot = y + 139 * k;
  bline(x + 8 * k, foot - 4 * k, x + w - 8 * k, foot - 4 * k, 2.2 * k, 0.6 * k, g, 0.5 * a);
  if (!MACHINES[i].playable) {
    // the COMING SOON poster across the middle of the board; the empty rows show only around it
    POT[0] = x + PO_CU * k; POT[1] = y + PO_CV * k; POT[2] = k;
    for (let r = 0; r < 10; r++) {
      const n = rowChars(r), ry = top + r * rh;
      if (!rankCovered(xr - textW(board.rows[r].rank, sc), xr, ry, 7 * sc)) ftext(board.rows[r].rank, xr, ry, FAINT, sc, 'r', 0.6 * a, n, 0);
      if (n > 0) {
        const x0 = xn + 2 * k, x1 = x0 + (xs - x0) * Math.min(1, n / 8), m = Math.max(1, Math.round((x1 - x0) / (4 * k)));
        for (let q = 0; q <= m; q++) { const px = x0 + (x1 - x0) * q / m; if (!underPoster(px, ry + 3 * k)) dot(px, ry + 3 * k, 0.5 * k, FAINT[0], FAINT[1], FAINT[2], 0.45 * a); }
      }
    }
    text('OPENS AT LAUNCH', cx, foot + 7 * k, g, sc, 'c', a * ((time * 1.9) % 1 < 0.62 ? 1 : 0.2));
    drawPoster(i, a);
    return;
  }
  const B = board;
  if (B.state === 'ok') {
    for (let r = 0; r < 10; r++) {
      const row = B.rows[r], ry = top + r * rh, n = rowChars(r);
      if (r >= B.n) { ftext(row.rank, xr, ry, FAINT, sc, 'r', 0.5 * a, n, 0); if (n > 0) bline(xn + 2 * k, ry + 3 * k, xs, ry + 3 * k, 4 * k, 0.45 * k, FAINT, 0.35 * a); continue; }
      const col = row.me ? (F % 30 < 20 ? GOLD : AMBER) : r === 0 ? GOLD : r === 1 ? SILVER : r === 2 ? BRONZE : g;
      const cyc = r === 0 && !row.me ? time * 9 : 0;
      if (row.me) for (let q = 0; q < 3; q++) dot(x + w * (q + 0.5) / 3, ry + 3 * sc, 14 * k, 1, .75, .25, 0.05 * a * (0.6 + 0.4 * Math.sin(time * 5)));
      ftext(row.rank, xr, ry, col, sc, 'r', a, n, cyc); ftext(row.name, xn, ry, col, sc, 'l', a, n, cyc); ftext(row.score, xs, ry, col, sc, 'r', a, n, cyc);
      // the champion row sparkles
      if (r === 0 && n >= 9) for (let q = 0; q < 4; q++) {
        const ph = (time * 0.9 + q * 0.27) % 1, sx = x + 8 * k + ((q * 37 + ((time * 0.9 + q * 0.27) | 0) * 53) % 120) / 120 * (w - 16 * k);
        dot(sx, ry - 1.5 * k + 7 * sc * ((q * 13) % 7) / 7, (0.6 + 1.6 * Math.sin(Math.PI * ph)) * k, 1, 1, .85, a * Math.sin(Math.PI * ph));
      }
    }
    if (B.n === 0) text('NO RUNS YET', cx, top + 4.5 * rh, DIM, sc, 'c', a);
  } else {
    for (let r = 0; r < 10; r++) ftext(B.rows[r].rank, xr, top + r * rh, FAINT, sc, 'r', 0.5 * a, rowChars(r), 0);
    if (B.state === 'offline') text('OFFLINE', cx, top + 4.5 * rh, AMBER, sc * 1.2, 'c', a);
    else text('LOADING', cx, top + 4.5 * rh, DIM, sc, 'c', a * (0.6 + 0.4 * Math.sin(F * 0.15)));
  }
  // the player's own line
  if (B.state !== 'ok') return;
  const ya = a * clamp((revT - 70) / 20, 0, 1);
  if (ya < 0.004) return;
  if (B.you === 'ranked') {
    const pu = 0.75 + 0.25 * Math.sin(time * 4);
    dot(x + 4 * k, foot + 5 * k, 1.6 * k, 1, .84, .3, ya * pu);
    text('YOU', x + 8 * k, foot + 2 * k, GOLD, sc, 'l', ya * pu); text(B.youScore, xs, foot + 2 * k, GOLD, sc, 'r', ya * pu);
    text('RANK', x + 8 * k, foot + 2 * k + rh, WH, sc, 'l', ya); text(B.youRank, xs, foot + 2 * k + rh, WH, sc, 'r', ya);
    hashGlyph(xs - textW(B.youRank, sc) - 6 * sc, foot + 2 * k + rh, sc, WH, ya);
  } else if (B.you === 'unknown') text('RANK OFFLINE', cx, foot + 7 * k, AMBER, sc, 'c', ya);
  else { text('PLAY A RUN', cx, foot + 2 * k, g, sc, 'c', ya); text('TO GET RANKED', cx, foot + 2 * k + rh, g, sc, 'c', ya); }
}

// ---------- fps ----------
const fpsT = new Float64Array(256); let fpsN = 0;
function fps() {
  const n = Math.min(fpsN, 256), now = fpsT[(fpsN - 1) & 255];
  let c = 0; for (let i = 0; i < n; i++) if (now - fpsT[(fpsN - 1 - i) & 255] < 1000) c++;
  return c;
}

const loop = createLoop({ step: tick, render });
loop.start();

// ---------- coming back from a game ----------
// The one entry point for the return path (returnToLobby): back to the lobby on the same machine, the swing and
// dolly cleared (so the selected cabinet stands swung open again), the board read again and its rows typed in again,
// and the draw loop running. Safe to call from any mode.
function resetToLobby() {
  mode = 'lobby'; swingT = 0; swingHold = -1; dollyT = 0; dollyHold = -1; skipFlag = false; handoffReady = false; importStarted = false;
  selQ = false; queued = 0; tapPending = false; swipePending = 0; latch = 0; flashT = 0; nav.hold(null); revKey = -2;
  const p = board.refresh();
  loop.start();
  return p;
}

// ---------- test hooks ----------
window.LOBBY = {
  // the return path: see resetToLobby
  reset() { return Promise.resolve(resetToLobby()).then(() => board.snapshot()); },
  info() {
    return {
      mode, index: nav.index, id: MACHINES[nav.index].id, ids: MACHINES.map(m => m.id), names: MACHINES.map(m => m.name),
      moving: nav.moving, pos: +nav.pos(0).toFixed(3), cam: Array.from(cam), crt: ui.crtOn, flash: flashT, dolly: +(dollyT / DOLLY_TICKS).toFixed(3),
      muted: ui.muted, music: musicOn, fps: fps(), handoffReady, stepTicks: STEP_TICKS, sceneDots: sN, sceneMax: S_MAX,
      // the selected cabinet's angle in degrees (72 swung open, 0 flush), the swing's progress 0..1
      angle: +(cabAngle(nav.index, 0) * 180 / Math.PI).toFixed(2), swing: mode === 'lobby' ? 0 : +clamp((swingHold >= 0 ? swingHold * SWING_TICKS : swingT) / SWING_TICKS, 0, 1).toFixed(3)
    };
  },
  // the wall board: state 'loading' | 'ok' | 'offline', rows, the player's line, and how many reads went out
  board() { return board.snapshot(); },
  // each cabinet's screen box from the last frame (field coords, 400 wide, centre 200) and its angle in degrees
  rowBoxes() {
    const out = [];
    for (let i = 0; i < N; i++) out.push({ id: MACHINES[i].id, x0: rx0[i], x1: rx1[i], y0: ry0[i], y1: ry1[i], angle: +(cabAngle(i, 0) * 180 / Math.PI).toFixed(2) });
    return { cx: CX, sel: nav.index, mode, boxes: out };
  },
  // the ids of the machines whose COMING SOON poster the last frame drew (read only)
  posterShown() { const out = []; for (let i = 0; i < N; i++) if (posterDrawn[i]) out.push(MACHINES[i].id); return out; },
  refreshBoard() { return board.refresh().then(() => board.snapshot()); },
  // freeze the Enter swing at q (0..1) on Starfall (starts it if needed); swingAt(null) lets it run
  swingAt(q) {
    if (q == null) { swingHold = -1; return; }
    if (mode === 'lobby') select();
    if (mode !== 'swing') return;
    swingHold = clamp(q, 0, 0.999);
  },
  wordmark() { return { phase: wmPhase(), progress: +clamp(wmNow() / WM_TOTAL, 0, 1).toFixed(4), dots: wmN, glyphDots: wmGlyph, name: ARCADE_NAME, scale: +wmSc.toFixed(3), bottom: +(wmBottom + 5 + 7).toFixed(2), pipY: PIP_Y }; },
  // a number that changes if any dot's start position, drift or phase changes (for the seeded-RNG test)
  wordmarkHash() { let h = 0; for (let i = 0; i < wmN; i++) h = (Math.imul(h, 31) + Math.round((wmSx[i] + wmSy[i] * 7 + wmVx[i] * 1e3 + wmVy[i] * 1e4 + wmPh[i] * 1e5) * 100)) | 0; return h; },
  wordmarkSkip() { wmSkip(); wmHold = -1; },
  // freeze the wordmark at sec seconds into its timeline; wordmarkAt(null) lets it run
  wordmarkAt(sec) { if (sec == null) { wmHold = -1; return; } wmHold = clamp(Math.round(sec * 60), 0, WM_TOTAL); },
  go(i) { return goTo(clamp(i | 0, 0, N - 1)); },
  next() { return step(1); },
  prev() { return step(-1); },
  select() { return select(); },
  // freeze a step toward dir (+1 next, -1 prev) at sec seconds; at(null) lets it run
  at(sec, dir = 1) {
    if (sec == null) { nav.hold(null); return; }
    if (mode !== 'lobby') return;
    if (!nav.moving) nav.go(nav.index + (dir < 0 ? -1 : 1));
    nav.hold(Math.round(sec * 60));
  },
  // freeze the select dolly at q (0..1); dollyAt(null) lets it run
  dollyAt(q) {
    if (q == null) { dollyHold = -1; return; }
    if (mode === 'lobby') select();
    if (mode === 'swing') beginDolly();   // a held dolly skips the swing (the swing has its own hook, swingAt)
    if (mode === 'lobby') return;   // the select did not start a dolly (moving, or a COMING SOON machine): nothing to hold
    dollyHold = clamp(q, 0, 1);
  },
  // stop at the last lobby frame instead of loading Starfall, until proceed()
  manualHandoff(v = true) { manualHandoff = !!v; },
  proceed() { startImport(); },
  returnToLobby,
  crt(v) { setCrt(v !== false); },
  fps,
  loseContext(ms = 300) {
    const ext = gfx.gl.getExtension('WEBGL_lose_context');
    if (!ext) return false;
    ext.loseContext(); setTimeout(() => ext.restoreContext(), ms); return true;
  }
};
