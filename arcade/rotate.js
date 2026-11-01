// phones. Two small view helpers shared by the lobby and Starfall; no gameplay in here.
//   1. The TURN YOUR PHONE SIDEWAYS screen: shown on a touch device (coarse pointer) held upright (taller than wide).
//      A dot-drawn phone outline turns 90 degrees in a loop above the words. Desktop windows, even tall ones, never see it.
//   2. The bezel: sideways, the 400 x 300 playfield keeps its size and place and the strips left and right of it
//      get dim dots (a cabinet's bezel) instead of black. Built once per resize into a preallocated buffer.
// Everything is dots. The playfield, the sim and the replay never see any of this.

const PI = Math.PI;
const TEAL = [0.3, 0.9, 0.85], AMBER = [1, 0.62, 0.2], WHITE = [1, 1, 1], DIM = [0.45, 0.45, 0.62], VIOLET = [0.62, 0.45, 1], ROSE = [1, 0.4, 0.5];
const BZ_MAX = 6000, BZ_STRIDE = 7;
const LOOP = 240;                          // ticks in one turn animation
const PW = 56, PH = 96, PR = 9;            // phone outline: width, height, corner radius (field units)
const easeIO = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

export function createRotate({ gfx, text }) {
  const mq = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null; // live: .matches follows the device
  let t = 0, was = false, justHid = false;
  const dot = gfx.dot;
  const rot = new Float64Array(2); // cos, sin of the phone's turn (typed array: no boxed doubles per frame)

  const upright = () => !!mq && mq.matches && typeof innerWidth === 'number' && innerHeight > innerWidth;

  // one phone-local dot (lx, ly from the phone's centre), turned by the current angle and moved to (cx, cy)
  function pd(cx, cy, lx, ly, s, c, a) { dot(cx + lx * rot[0] - ly * rot[1], cy + lx * rot[1] + ly * rot[0], s, c[0], c[1], c[2], a); }

  function drawPhone(cx, cy, p, al) {
    // 0..60 upright, 60..130 turns to the right, 130..210 holds sideways, 210..240 fades to start again
    const k = easeIO(clamp((p - 60) / 70, 0, 1)), ang = k * PI / 2;
    rot[0] = Math.cos(ang); rot[1] = Math.sin(ang);
    const hw = PW / 2, hh = PH / 2, a = al * 0.95;
    // body outline: straight edges and four quarter-circle corners
    for (let x = -hw + PR; x <= hw - PR + 0.01; x += 3.2) { pd(cx, cy, x, -hh, 1.5, TEAL, a); pd(cx, cy, x, hh, 1.5, TEAL, a); }
    for (let y = -hh + PR; y <= hh - PR + 0.01; y += 3.2) { pd(cx, cy, -hw, y, 1.5, TEAL, a); pd(cx, cy, hw, y, 1.5, TEAL, a); }
    for (let q = 0; q <= 4; q++) {
      const u = q / 4 * PI / 2, ox = Math.cos(u) * PR, oy = Math.sin(u) * PR;
      pd(cx, cy, hw - PR + ox, hh - PR + oy, 1.5, TEAL, a); pd(cx, cy, -(hw - PR + ox), hh - PR + oy, 1.5, TEAL, a);
      pd(cx, cy, hw - PR + ox, -(hh - PR + oy), 1.5, TEAL, a); pd(cx, cy, -(hw - PR + ox), -(hh - PR + oy), 1.5, TEAL, a);
    }
    // speaker slot at the top, home bar at the bottom
    for (let x = -4; x <= 4.01; x += 2) pd(cx, cy, x, -hh + 5, 1, WHITE, a * 0.7);
    for (let x = -6; x <= 6.01; x += 2) pd(cx, cy, x, hh - 5, 1, WHITE, a * 0.5);
    // the screen: a dim dot field that lights up as the phone lies on its side
    const lit = 0.12 + 0.5 * k;
    for (let y = -hh + 11; y <= hh - 11; y += 5) for (let x = -hw + 6; x <= hw - 6; x += 5) pd(cx, cy, x, y, 1, AMBER, a * lit * (0.6 + 0.4 * (((x * 3 + y * 5) % 3 + 3) % 3) / 2));
  }

  // a curved arrow around the phone: the way to turn it
  function drawArrow(cx, cy, p, al) {
    if (p < 20 || p > 150) return;
    const grow = clamp((p - 20) / 40, 0, 1), fade = al * (p > 130 ? clamp((150 - p) / 20, 0, 1) : 1) * 0.8;
    const R = 76, a0 = -PI * 0.78, a1 = a0 + PI * 0.62 * grow;
    for (let a = a0; a <= a1; a += 0.07) dot(cx + Math.cos(a) * R, cy + Math.sin(a) * R, 1.3, AMBER[0], AMBER[1], AMBER[2], fade);
    if (grow > 0.2) { // arrowhead at the end of the arc, pointing along the turn
      const hx = cx + Math.cos(a1) * R, hy = cy + Math.sin(a1) * R, tx = -Math.sin(a1), ty = Math.cos(a1), nx = Math.cos(a1), ny = Math.sin(a1);
      for (let i = 1; i <= 4; i++) {
        dot(hx - tx * i * 2.2 + nx * i * 1.8, hy - ty * i * 2.2 + ny * i * 1.8, 1.4, AMBER[0], AMBER[1], AMBER[2], fade);
        dot(hx - tx * i * 2.2 - nx * i * 1.8, hy - ty * i * 2.2 - ny * i * 1.8, 1.4, AMBER[0], AMBER[1], AMBER[2], fade);
      }
    }
  }

  // ---------- the bezel: the strips beside the playfield ----------
  const bz = new Float32Array(BZ_MAX * BZ_STRIDE);
  let bzN = 0;
  function put(x, y, s, c, a) {
    if (bzN >= BZ_MAX) return;
    const o = bzN++ * BZ_STRIDE;
    bz[o] = x; bz[o + 1] = y; bz[o + 2] = s; bz[o + 3] = c[0]; bz[o + 4] = c[1]; bz[o + 5] = c[2]; bz[o + 6] = a;
  }
  // x measured from the playfield edge outward (u), mirrored to both sides; y down the strip
  function both(u, y, s, c, a) { put(-u, y, s, c, a); put(gfx.W + u, y, s, c, a); }
  function build(view) {
    bzN = 0;
    const pad = view.padX, H = gfx.H;
    if (!(pad > 3)) return;
    for (let y = 0; y <= H; y += 3) both(2.5, y, 1.2, VIOLET, 0.4);                        // the lit inner edge
    if (pad > 9) for (let y = 1.5; y <= H; y += 6) both(6.5, y, 1, VIOLET, 0.2);        // a second, fainter line
    if (pad > 22) {
      for (let u = 14, i = 0; u <= pad - 8; u += 7, i++) {                                  // the grille
        const fall = clamp(1 - (u - 14) / Math.max(1, pad - 14) * 0.55, 0.35, 1);
        for (let y = 6, j = 0; y <= H - 3; y += 7, j++) both(u, y, 1.2, DIM, (0.13 + 0.15 * ((i * 7 + j * 13) % 5) / 4) * fall);
      }
      for (let y = 0; y <= H; y += 4) both(pad - 3, y, 1, DIM, 0.3);                      // the outer edge of the bezel
      // three small lamps near the top, like a cabinet's status lights
      const mid = Math.max(14, (pad + 2.5) / 2), lamps = [TEAL, AMBER, ROSE];
      for (let k = 0; k < 3; k++) { both(mid, 26 + k * 10, 1.8, lamps[k], 0.4); }
    }
  }
  gfx.onResize(build);
  build(gfx.view);

  return {
    // read-only: is the turn-sideways screen up right now (touch device, taller than wide)
    shown: upright,
    // once per 60 Hz tick (wherever the app freezes itself). Returns true while the app must hold still:
    // the screen is up, and the first tick after it goes (so a finger still down for the turn cannot resume or select anything)
    tick() {
      const s = upright();
      if (s) { t++; justHid = false; } else if (was) justHid = true; else justHid = false;
      was = s;
      return s || justHid;
    },
    // the turn-sideways screen, over the whole canvas. note: a small second line ('YOUR RUN IS PAUSED' in the game)
    draw(note) {
      gfx.reset();
      const p = t % LOOP, al = clamp(p / 12, 0, 1) * (p > LOOP - 24 ? clamp((LOOP - p) / 24, 0, 1) : 1);
      const cx = gfx.W / 2, cy = 98;
      drawArrow(cx, cy, p, al);
      drawPhone(cx, cy, p, al);
      text('TURN YOUR PHONE', cx, 196, WHITE, 2.4, 'c', 1);
      text('SIDEWAYS', cx, 222, AMBER, 3.4, 'c', 1);
      if (note) text(note, cx, 258, DIM, 1.6, 'c', 0.95);
      gfx.clearCanvas(); gfx.toFull(); gfx.drawDots(gfx.count(), 0, 0);
    },
    // the bezel dots, in the strips beside the playfield. Call after the playfield is on screen; it does not clear.
    drawBezel() {
      if (bzN === 0) return;
      gfx.reset();
      for (let k = 0, o = 0; k < bzN; k++, o += BZ_STRIDE) dot(bz[o], bz[o + 1], bz[o + 2], bz[o + 3], bz[o + 4], bz[o + 5], bz[o + 6]);
      gfx.drawBars();
    },
    bezelDots() { return bzN; }
  };
}
