// Arcade cabinet intro: a few thousand dots in 3D seen through an eased look-at camera.
// Coin door close-up, a coin flips into the slot, the camera pans up past the control panel and
// marquee, then pushes into the CRT until the tube fills the view. The tube shows whatever the
// drawScreen callback draws (rendered to a texture and composited as a perspective-correct quad).
// World units are ~cm: floor at y=0, cabinet front plane at z=0, viewer at +z looking toward -z.
import { FONT, textW } from '../engine/font.js';

const PI = Math.PI, TAU = PI * 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const cr = (p0, p1, p2, p3, t) => { const t2 = t * t, t3 = t2 * t; return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3); };
const smoother = t => t * t * t * (t * (t * 6 - 15) + 10);
const easeIO = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export const DEFAULT_PALETTE = {
  edge: [.5, .42, 1], body: [.3, .25, .7], dark: [.2, .17, .4], steel: [.6, .66, .8], red: [1, .28, .18],
  teal: [.25, .95, .88], amber: [1, .7, .2], gold: [1, .88, .35], dim: [.35, .35, .5],
  lampFill: [1, .45, .15], ball: [1, .25, .3], marqueeBox: [1, .55, .3],
  // marquee title gradient, top row to bottom row
  marqueeTop: [1, 0.8, 0.3], marqueeBottom: [1, 0.3, 0.7],
  room: [[1, .35, .35], [.35, .6, 1], [1, 1, .45], [.45, 1, .6], [1, 1, 1], [1, .55, 1], [.4, 1, 1]]
};

export const COIN_DUR = 0.8, PAN_T0 = 1.05, PAN_T1 = 3.45, PUSH_T1 = 5.5;
export const G_STATIC = 0, G_LAMP = 1, G_INSERT = 2, G_CREDIT1 = 3, G_MARQ = 4, G_BTN = 5, G_ROOM = 6, G_CREDIT0 = 7;
export const FOC = 300;
export const CAB_KEYS = [
  [6, 42, 47, 0, 39, 0],     // coin door close-up
  [6, 114, 80, 0, 90, 10],   // control panel
  [5, 132, 82, 0, 128, -6],  // screen
  [3, 152, 80, 0, 174, 2],   // marquee
  [0, 129, 42, 0, 129, -6]   // tube fills the view: 64 wide at depth 48 projects to exactly 400
];

// The cabinet's dot geometry (world cm, cabinet front plane at z=0, centered on x=0), as parallel arrays.
// room=true adds the intro's carpet confetti and far-off glow blobs (consumes rnd). Group ids G_* below.
export function buildCabinetGeometry(PAL, marquee, sub, rnd, room, max) {
  const CAB_MAX = max || 9000, cbX = new Float32Array(CAB_MAX), cbY = new Float32Array(CAB_MAX), cbZ = new Float32Array(CAB_MAX),
    cbS = new Float32Array(CAB_MAX), cbR = new Float32Array(CAB_MAX), cbG = new Float32Array(CAB_MAX), cbB = new Float32Array(CAB_MAX),
    cbA = new Float32Array(CAB_MAX), cbGrp = new Uint8Array(CAB_MAX);
  let cbN = 0;
  function cpt(x, y, z, s, c, a, g) {
    if (cbN >= CAB_MAX) return;
    const i = cbN++;
    cbX[i] = x; cbY[i] = y; cbZ[i] = z; cbS[i] = s; cbR[i] = c[0]; cbG[i] = c[1]; cbB[i] = c[2]; cbA[i] = a; cbGrp[i] = g || G_STATIC;
  }
  function cline(x0, y0, z0, x1, y1, z1, step, s, c, a, g) {
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0, z1 - z0) / step));
    for (let i = 0; i <= n; i++) { const t = i / n; cpt(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, z0 + (z1 - z0) * t, s, c, a, g); }
  }
  // parallelogram of dots: origin o, edges u and v; skip(x, y) can punch holes
  function cgrid(ox, oy, oz, ux, uy, uz, vx, vy, vz, step, s, c, a, g, skip) {
    const nu = Math.max(1, Math.round(Math.hypot(ux, uy, uz) / step)), nv = Math.max(1, Math.round(Math.hypot(vx, vy, vz) / step));
    for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
      const x = ox + ux * i / nu + vx * j / nv, y = oy + uy * i / nu + vy * j / nv;
      if (!skip || !skip(x, y)) cpt(x, y, oz + uz * i / nu + vz * j / nv, s, c, a, g);
    }
  }
  // disc or ring in the plane spanned by unit vectors e1, e2
  function cdisc(x, y, z, r0, r1, e1, e2, step, s, c, a, g) {
    for (let r = r0; r <= r1 + 1e-3; r += step) {
      const n = Math.max(1, Math.round(r * TAU / step));
      for (let i = 0; i < n; i++) { const t = i / n * TAU, cs = Math.cos(t) * r, sn = Math.sin(t) * r; cpt(x + e1[0] * cs + e2[0] * sn, y + e1[1] * cs + e2[1] * sn, z + e1[2] * cs + e2[2] * sn, s, c, a, g); }
    }
  }
  // dot-font text on the front-facing plane z, centered on x, top row at y
  function ctext(str, x, y, z, sc, c, a, g, rowCol) {
    let x0 = x - textW(str, sc) / 2;
    for (let i = 0; i < str.length; i++, x0 += 6 * sc) {
      const gl7 = FONT[str[i]]; if (!gl7) continue;
      for (let r = 0; r < 7; r++) for (let b = 0; b < 5; b++) if ((gl7[r] >> (4 - b)) & 1) cpt(x0 + b * sc, y - r * sc, z, sc * 0.9, rowCol ? rowCol[r] : c, a, g);
    }
  }

  (function build() {
    const EDGE = PAL.edge, BODY = PAL.body, DARK = PAL.dark, STEEL = PAL.steel, RED = PAL.red;
    const XS = 38, BACK = -70;
    // room: arcade carpet confetti and the soft glow of far-off machines
    if (room) {
      for (let i = 0; i < 900; i++) cpt((rnd() - .5) * 360, 0, -170 + rnd() * 250, 0.6, PAL.room[i % PAL.room.length], 0.16, G_ROOM);
      for (let i = 0; i < 46; i++) cpt((rnd() - .5) * 600, 15 + rnd() * 170, -240 - rnd() * 160, 5 + rnd() * 7, PAL.room[i % PAL.room.length], 0.1, G_ROOM);
    }
    // side profile (z, y), walked once per side, plus the cross edges joining both sides
    const PROF = [[0, 0], [0, 80], [22, 80], [22, 86], [2, 95], [0, 96], [0, 160], [4, 162], [4, 188], [0, 190], [BACK, 190], [BACK, 0]];
    for (const sx of [-XS, XS]) {
      // only the front profile; top, back and floor edges would be hidden behind the cabinet from every camera pose
      for (let k = 0; k < PROF.length - 3; k++) {
        const a = PROF[k], b = PROF[k + 1];
        cline(sx, a[1], a[0], sx, b[1], b[0], 1.3, 0.55, EDGE, 0.7);
      }
      cgrid(sx, 0, BACK, 0, 0, -BACK, 0, 190, 0, 6, 0.5, BODY, 0.08);
      cline(sx, 14, -62, sx, 150, -6, 1.3, 0.6, PAL.teal, 0.55);
      cline(sx, 8, -52, sx, 120, -4, 1.3, 0.6, PAL.amber, 0.45);
    }
    for (const [z, y] of PROF) if (z > BACK && y < 190) cline(-XS, y, z, XS, y, z, 1.3, 0.55, EDGE, 0.7);
    // lower body front with a teal kick stripe
    cgrid(-XS, 0, 0, 2 * XS, 0, 0, 0, 80, 0, 4.5, 0.5, BODY, 0.15, G_STATIC, (x, y) => Math.abs(x) < 16 && y > 19 && y < 59);
    cline(-XS, 6, 0.2, XS, 6, 0.2, 1.3, 0.55, PAL.teal, 0.6);
    // coin door
    const DZ = 0.4;
    for (const [w, al] of [[15, .9], [13.8, .45]]) {
      cline(-w, 20, DZ, w, 20, DZ, 0.9, 0.5, STEEL, al); cline(-w, 58, DZ, w, 58, DZ, 0.9, 0.5, STEEL, al);
      cline(-w, 20, DZ, -w, 58, DZ, 0.9, 0.5, STEEL, al); cline(w, 20, DZ, w, 58, DZ, 0.9, 0.5, STEEL, al);
    }
    cgrid(-13, 21.5, DZ, 26, 0, 0, 0, 35, 0, 2.2, 0.4, STEEL, 0.1);
    ctext('INSERT', 0, 56, DZ + .1, 0.75, RED, 1, G_INSERT);
    ctext('COIN', 0, 49.5, DZ + .1, 0.75, RED, 1, G_INSERT);
    for (const sx of [-7, 7]) {
      cline(sx - 2.3, 33, DZ, sx + 2.3, 33, DZ, 0.7, 0.5, PAL.amber, 0.9, G_LAMP); cline(sx - 2.3, 43, DZ, sx + 2.3, 43, DZ, 0.7, 0.5, PAL.amber, 0.9, G_LAMP);
      cline(sx - 2.3, 33, DZ, sx - 2.3, 43, DZ, 0.7, 0.5, PAL.amber, 0.9, G_LAMP); cline(sx + 2.3, 33, DZ, sx + 2.3, 43, DZ, 0.7, 0.5, PAL.amber, 0.9, G_LAMP);
      cgrid(sx - 1.7, 33.6, DZ, 3.4, 0, 0, 0, 8.8, 0, 0.9, 0.45, PAL.lampFill, 0.35, G_LAMP, (x) => Math.abs(x - sx) < 0.6);
      cline(sx - 0.5, 34.6, DZ - .3, sx - 0.5, 41.4, DZ - .3, 0.6, 0.35, STEEL, 0.6); cline(sx + 0.5, 34.6, DZ - .3, sx + 0.5, 41.4, DZ - .3, 0.6, 0.35, STEEL, 0.6);
      cdisc(sx, 29.5, DZ + .2, 0, 1.1, [1, 0, 0], [0, 1, 0], 0.5, 0.45, RED, 0.7, G_LAMP);
    }
    cdisc(0, 31, DZ, 1.2, 1.2, [1, 0, 0], [0, 1, 0], 0.5, 0.4, STEEL, 0.8);
    ctext('CREDIT 0', 0, 25.5, DZ + .1, 0.36, [.4, .3, .25], 0.7, G_CREDIT0);
    ctext('CREDIT 1', 0, 25.5, DZ + .1, 0.36, PAL.gold, 1.2, G_CREDIT1);
    // control panel: slanted top from (y86, z22) to (y95, z2), a joystick and two buttons
    const PV = [0, 9, -20], PLn = Math.hypot(9, 20), E2 = [0, 9 / PLn, -20 / PLn], NRM = [0, 20 / PLn, 9 / PLn];
    cgrid(-XS, 86, 22, 2 * XS, 0, 0, PV[0], PV[1], PV[2], 3, 0.5, DARK, 0.3);
    cgrid(-XS, 80, 22, 2 * XS, 0, 0, 0, 6, 0, 3, 0.5, DARK, 0.25);
    cline(-XS, 86.5, 21, XS, 86.5, 21, 1.2, 0.5, PAL.amber, 0.5);
    cline(-XS, 94, 4.2, XS, 94, 4.2, 1.2, 0.5, PAL.teal, 0.4);
    const pt = t => [86 + 9 * t, 22 - 20 * t];
    const [jy, jz] = pt(0.45);
    cdisc(-18, jy, jz, 3.6, 3.6, [1, 0, 0], E2, 0.8, 0.5, STEEL, 0.8);
    cdisc(-18, jy, jz, 0, 2.2, [1, 0, 0], E2, 0.9, 0.45, DARK, 0.6);
    cline(-18, jy, jz, -18, jy + 8.5, jz + 1, 0.6, 0.6, STEEL, 0.9);
    for (let i = 0; i < 90; i++) {
      const yy = 1 - (i + .5) / 90 * 2, rr = Math.sqrt(1 - yy * yy), th = i * 2.39996;
      cpt(-18 + Math.cos(th) * rr * 2.4, jy + 10.5 + yy * 2.4, jz + 1 + Math.sin(th) * rr * 2.4, 0.5, PAL.ball, 0.55 + 0.45 * Math.max(0, yy));
    }
    for (const [bx, bc] of [[2, PAL.amber], [13, PAL.teal]]) {
      const n = 0.9;
      cdisc(bx, jy + NRM[1] * n, jz + NRM[2] * n, 0, 2.6, [1, 0, 0], E2, 0.65, 0.5, bc, 0.7, G_BTN);
      cdisc(bx, jy, jz, 3.3, 3.3, [1, 0, 0], E2, 0.8, 0.45, STEEL, 0.5);
    }
    // screen bezel board with the recessed tube opening; the screen image is composited into (±32, 105..153, z=-6)
    cgrid(-XS, 96, 0, 2 * XS, 0, 0, 0, 64, 0, 2.6, 0.5, DARK, 0.3, G_STATIC, (x, y) => Math.abs(x) < 34.5 && y > 101.5 && y < 156.5);
    cline(-34, 102, 0, 34, 102, 0, 1, 0.5, EDGE, 0.8); cline(-34, 156, 0, 34, 156, 0, 1, 0.5, EDGE, 0.8);
    cline(-34, 102, 0, -34, 156, 0, 1, 0.5, EDGE, 0.8); cline(34, 102, 0, 34, 156, 0, 1, 0.5, EDGE, 0.8);
    for (const [x0, y0, x1, y1] of [[-34, 102, -32, 105], [34, 102, 32, 105], [-34, 156, -32, 153], [34, 156, 32, 153]]) cline(x0, y0, 0, x1, y1, -6, 0.8, 0.4, EDGE, 0.5);
    // marquee: a back-lit lightbox carrying the name
    cgrid(-36, 163, 4, 72, 0, 0, 0, 24, 0, 1.8, 0.7, PAL.marqueeBox, 0.11, G_MARQ);
    const rows = [], a = PAL.marqueeTop, b = PAL.marqueeBottom;
    for (let r = 0; r < 7; r++) { const t = r / 6; rows.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
    // the name is sized to fit the 72-wide lightbox (1.45 for 8 letters, as Starfall v1)
    const msc = Math.min(1.45, 1.45 * 47 / Math.max(1, marquee.length * 6 - 1));
    ctext(marquee, 0, 182, 4.2, msc, null, 1, G_MARQ, rows);
    if (sub) ctext(sub, 0, 168.5, 4.2, 0.5, PAL.teal, 0.9, G_MARQ);
    cline(-XS, 162, 4, XS, 162, 4, 1, 0.55, EDGE, 0.9); cline(-XS, 188, 4, XS, 188, 4, 1, 0.55, EDGE, 0.9);
  })();
  return { n: cbN, X: cbX, Y: cbY, Z: cbZ, S: cbS, R: cbR, G: cbG, B: cbB, A: cbA, Grp: cbGrp };
}

// opts: { W, H, marquee, sub, palette, rnd, hint, onToss, onClunk, onDone }
export function createCabinet(opts = {}) {
  const W = opts.W || 400, H = opts.H || 300, CX = W / 2;
  const PAL = Object.assign({}, DEFAULT_PALETTE, opts.palette || {});
  const rnd = opts.rnd || Math.random;
  const marquee = opts.marquee || 'ARCADE', sub = opts.sub || '';
  const hint = opts.hint || 'FIRE / CLICK: INSERT COIN    ESC: SKIP';

  const geo = buildCabinetGeometry(PAL, marquee, sub, rnd, true, 9000);
  const cbX = geo.X, cbY = geo.Y, cbZ = geo.Z, cbS = geo.S, cbR = geo.R, cbG = geo.G, cbB = geo.B, cbA = geo.A, cbGrp = geo.Grp, cbN = geo.n;
  const COIN_UV = [];
  for (const [r, n] of [[2.4, 24], [1.6, 16], [0.8, 8], [0, 1]]) for (let i = 0; i < n; i++) COIN_UV.push(Math.cos(i / n * TAU) * r, Math.sin(i / n * TAU) * r);

  const cam = new Float32Array(6);
  let t = 0, cabCoin = -1, cabHold = -1, clunked = false;
  let Fx = 0, Fy = 0, Fz = -1, Rx = 1, Rz = 0, Ux = 0, Uy = 1, Uz = 0, PX = 0, PY = 0, PZ = 0;

  function cabTime(al) { return cabCoin < 0 ? -1 : cabHold >= 0 ? cabHold : (t - cabCoin + (al || 0)) / 60; }
  function camPose(ct, it) {
    if (ct < PAN_T0) for (let k = 0; k < 6; k++) cam[k] = CAB_KEYS[0][k];
    else if (ct < PAN_T1) {
      const u = Math.min(2.9999, smoother((ct - PAN_T0) / (PAN_T1 - PAN_T0)) * 3), i = u | 0, f = u - i;
      const a = CAB_KEYS[Math.max(0, i - 1)], b = CAB_KEYS[i], c = CAB_KEYS[i + 1], d = CAB_KEYS[Math.min(3, i + 2)];
      for (let k = 0; k < 6; k++) cam[k] = cr(a[k], b[k], c[k], d[k], f);
    } else {
      const q = easeIO(Math.min(1, (ct - PAN_T1) / (PUSH_T1 - PAN_T1))), a = CAB_KEYS[3], b = CAB_KEYS[4];
      for (let k = 0; k < 6; k++) cam[k] = a[k] + (b[k] - a[k]) * q;
    }
    // a little handheld sway that fades out during the first second of the pan
    const w = ct < PAN_T0 ? 1 : clamp(1 - (ct - PAN_T0), 0, 1);
    cam[0] += Math.sin(it * 0.6) * 0.6 * w; cam[1] += Math.sin(it * 0.8) * 0.35 * w;
    const fx = cam[3] - cam[0], fy = cam[4] - cam[1], fz = cam[5] - cam[2];
    const fl = Math.hypot(fx, fy, fz); Fx = fx / fl; Fy = fy / fl; Fz = fz / fl;
    const rl = Math.hypot(Fz, Fx); Rx = -Fz / rl; Rz = Fx / rl;
    Ux = -Rz * Fy; Uy = Rz * Fx - Rx * Fz; Uz = Rx * Fy;
  }
  function proj(x, y, z) {
    const dx = x - cam[0], dy = y - cam[1], dz = z - cam[2];
    PZ = dx * Fx + dy * Fy + dz * Fz;
    if (PZ < 1) return false;
    PX = CX + FOC * (dx * Rx + dz * Rz) / PZ; PY = H / 2 - FOC * (dx * Ux + dy * Uy + dz * Uz) / PZ;
    return PX > -20 && PX < W + 20 && PY > -20 && PY < H + 20;
  }
  // draws the cabinet dots and sets the tube quad corners (quadCorner from crt.js)
  function draw(dot, text, quadCorner, al, F) {
    const it = (F + al) / 60, ct = cabTime(al), coinIn = ct >= 0, credited = ct >= COIN_DUR;
    camPose(ct, it);
    // the cabinet's front silhouette hides room dots behind it
    let sx0 = 1e9, sx1 = -1e9, sy0 = 1e9, sy1 = -1e9;
    for (let k = 0; k < 4; k++) {
      proj(k & 1 ? 38 : -38, k & 2 ? 190 : 0, 0);
      if (PX < sx0) sx0 = PX; if (PX > sx1) sx1 = PX; if (PY < sy0) sy0 = PY; if (PY > sy1) sy1 = PY;
    }
    const blink = it % 1 < 0.6, sweep = (it * 70) % 160 - 80;
    for (let i = 0; i < cbN; i++) {
      const g = cbGrp[i];
      let a = cbA[i];
      if (g === G_LAMP) a *= coinIn ? (credited && ct < COIN_DUR + 0.6 ? 1.8 : 1) : 0.7 + 0.3 * Math.sin(it * 3);
      else if (g === G_INSERT) a *= coinIn ? 0.1 : blink ? 1 : 0.1;
      else if (g === G_CREDIT0) { if (credited) continue; }
      else if (g === G_CREDIT1) { if (!credited) continue; a *= 0.8 + 0.2 * Math.sin(it * 5); }
      else if (g === G_MARQ) a *= 0.85 + 0.6 * Math.max(0, 1 - Math.abs(sweep - cbX[i]) / 9);
      else if (g === G_BTN) a *= 0.75 + 0.25 * Math.sin(it * 4 + cbX[i] * 0.3);
      if (!proj(cbX[i], cbY[i], cbZ[i])) continue;
      if (g === G_ROOM && cbZ[i] < 0 && PX > sx0 && PX < sx1 && PY > sy0 && PY < sy1) continue;
      dot(PX, PY, clamp(cbS[i] * FOC / PZ, 0.35, 7), cbR[i], cbG[i], cbB[i], a);
    }
    // the coin: flips toward the right-hand slot and turns edge-on to slide in
    if (coinIn && ct < COIN_DUR + 0.05) {
      const q = Math.min(1, ct / COIN_DUR), m = Math.min(1, q / 0.82), e = easeIO(m);
      const x = 14 - 7 * e, y = 30 + 8 * e + Math.sin(PI * m) * 7, z = q > 0.82 ? 0.8 - (q - 0.82) / 0.18 * 4 : 26 - 25.2 * e;
      const ang = PI / 2 + Math.pow(1 - m, 3) * 5 * PI, ca = Math.cos(ang), sa = Math.sin(ang), shine = 0.55 + 0.45 * Math.abs(ca);
      for (let i = 0; i < COIN_UV.length; i += 2) {
        const u = COIN_UV[i], wz = z + u * sa;
        if (wz < 0.3 || !proj(x + u * ca, y + COIN_UV[i + 1], wz)) continue;
        dot(PX, PY, clamp(0.5 * FOC / PZ, 0.5, 7), 1, .82 * shine, .3 * shine, 1);
      }
    }
    // the tube: corners carry their view depth so the composited image is perspective-correct
    proj(-32, 105, -6); quadCorner(0, PX, PY, PZ, 0, 0);
    proj(32, 105, -6); quadCorner(1, PX, PY, PZ, 1, 0);
    proj(-32, 153, -6); quadCorner(2, PX, PY, PZ, 0, 1);
    proj(32, 153, -6); quadCorner(3, PX, PY, PZ, 1, 1);
    if (!coinIn) text(hint, CX, 288, PAL.dim, 1, 'c', Math.min(1, t / 60) * 0.9);
    else if (ct < PUSH_T1 - 1) text('ANY KEY: SKIP', W - 6, 290, PAL.dim, 1, 'r', 0.5);
  }

  return {
    // restart the intro from the coin door
    reset() { t = 0; cabCoin = -1; cabHold = -1; clunked = false; },
    // one 60 Hz tick. fire = insert coin; skip = any other key
    tick(fire, skip) {
      t++;
      if (cabCoin < 0) {
        if (fire) { cabCoin = t; if (opts.onToss) opts.onToss(); }
        else if (skip) end();
        return;
      }
      if (skip || fire) { end(); return; }
      const ct = cabTime();
      if (!clunked && ct >= COIN_DUR) { clunked = true; if (opts.onClunk) opts.onClunk(); }
      if (ct >= PUSH_T1) end();
    },
    // gfx: createGfx, crt: createCrt, drawScreen(): draws the tube content dots
    render(gfx, crt, text, al, F, crtOn, drawScreen) {
      gfx.reset(); drawScreen();
      gfx.clearCanvas();
      crt.dotsToTexture(gfx.count(), 0, 0);
      gfx.reset(); draw(gfx.dot, text, crt.quadCorner, al, F);
      gfx.toViewport(); gfx.drawDots(gfx.count(), 0, 0);
      crt.composite(crtOn, F / 60);
    },
    // freeze the intro at sec seconds after the coin; release() lets it run on
    hold(sec) { cabCoin = t; cabHold = sec; clunked = sec >= COIN_DUR; },
    release() { if (cabHold >= 0) { cabCoin = t - cabHold * 60; cabHold = -1; } },
    get t() { return t; }, get time() { return cabTime(0); }
  };
  function end() { cabHold = -1; if (opts.onDone) opts.onDone(); }
}
