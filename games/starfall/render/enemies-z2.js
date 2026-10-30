// Z2 enemy extras, drawn over the registered sprites (the enemies layer draws the Prism and Eel art itself):
//   Prism  the face: an arc of glass dots on the side it has turned toward the player. Bright while it deflects
//          (90 frames), dim while it rests (60); it flickers for the last 12 resting frames before it lights again.
//   Eel    the ribbon spine between neighboring segments, the head's crest, a faint hunt line from a diving
//          head to the wingman it steers for, and the UNSPOOLED call-out.
// Reads the sim, never writes it. Allocation-free per frame (preallocated segment table).
import { W } from '../defs.js';
import { COL } from '../sprites.js';
import { prismT, PRISM_ON, PRISM_CYCLE, FACE_ARC } from '../sim/enemies/prism.js';
import { EEL_LEN } from '../sim/enemies/eel.js';

const lerp = (a, b, t) => a + (b - a) * t;
const segs = [new Array(EEL_LEN).fill(null), new Array(EEL_LEN).fill(null)];

// face brightness 0..1 at glow-clock position t
export function faceLevel(t) {
  if (t < PRISM_ON) return t < 4 ? 0.6 + 0.1 * t : t > PRISM_ON - 8 ? 0.55 + 0.45 * (PRISM_ON - t) / 8 : 1;
  return t >= PRISM_CYCLE - 12 && (t & 2) ? 0.35 : 0.12;
}

function drawPrism(R, e, x, y, frame) {
  const lv = faceLevel(prismT(e)), on = prismT(e) < PRISM_ON, a = e.pfa;
  // deflect flare: a fan of glass sparks bursts off the face for 10 frames where the shot struck
  const fl = frame - e.pdf;
  if (fl >= 0 && fl < 10) {
    const fa = 1 - fl / 10, fx = x + Math.sin(a) * 8, fy = y + Math.cos(a) * 8;
    for (let i = 0; i < 6; i++) { const q = a + (i / 5 - 0.5) * 2.4, r = 2 + fl * 0.7; R.dot(fx + Math.sin(q) * r, fy + Math.cos(q) * r, 1.4, 0.85, 1, 1, 0.95 * fa); }
  }
  for (let i = 0; i < 7; i++) {
    const q = a + (i / 6 - 0.5) * FACE_ARC * 1.6, r = 8;
    // q is measured from straight down (+y), positive toward +x
    const px = x + Math.sin(q) * r, py = y + Math.cos(q) * r;
    if (on) R.dot(px, py, 1.15, 0.75, 1, 1, lv);
    else R.dot(px, py, 0.95, 0.6, 0.4, 1, lv);
  }
  if (on) R.dot(x + Math.sin(a) * 4.5, y + Math.cos(a) * 4.5, 1.6, 0.25, 0.95, 0.9, 0.35 * lv);
}

function drawRibbon(R, list, al, F) {
  let prev = null, px = 0, py = 0;
  for (let k = 0; k < EEL_LEN; k++) {
    const e = list[k];
    if (!e) { prev = null; continue; }
    const x = lerp(e.px, e.x, al), y = lerp(e.py, e.y, al);
    if (prev) {
      const dx = x - px, dy = y - py;
      if (dx * dx + dy * dy < 30 * 30) for (let s = 1; s <= 3; s++) {
        const t = s / 4, w = Math.sin(F * 0.15 + k * 1.3 + s) * 1.2;
        R.dot(lerp(px, x, t) - dy * 0.05 * w, lerp(py, y, t) + dx * 0.05 * w, 0.95, 0.25, 0.95, 0.9, 0.7);
      }
    }
    prev = e; px = x; py = y;
  }
}

function drawHead(R, e, x, y, sim, F) {
  const s = Math.sin(e.ang), c = Math.cos(e.ang);
  // crest: two antennae forward of the head (sprite 'up' is -y rotated by ang)
  for (let k = -1; k <= 1; k += 2) {
    const fx = k * 2.5, fy = -5.5 - (F >> 3 & 1);
    R.dot(x + fx * c - fy * s, y + fx * s + fy * c, 1, 0.6, 0.4, 1, 0.9);
  }
  if (e.st !== 'dive' || !sim.wing.length) return;
  // hunt line: faint dots toward the wingman this head steers for
  let w = sim.wing[0], bd = Infinity;
  for (let i = 0; i < sim.wing.length; i++) { const o = sim.wing[i], d = (o.x - x) * (o.x - x) + (o.y - y) * (o.y - y); if (d < bd) { bd = d; w = o; } }
  if (w.y <= y) return;
  for (let i = 1; i <= 7; i++) { const t = i / 8; R.dot(lerp(x, w.x, t), lerp(y, w.y, t), 1, 1, 0.55, 0.3, 0.45 + 0.25 * ((F >> 2) + i & 1)); }
}

export const enemiesZ2Layer = {
  id: 'enemies-z2',
  draw(R, sim, al) {
    const en = sim.enemies, F = R.ui.F;
    let eels = false;
    for (let i = 0; i < en.length; i++) {
      const e = en[i];
      if (e.st === 'wait' || e.dead) continue;
      if (e.type === 'prism') drawPrism(R, e, lerp(e.px, e.x, al), lerp(e.py, e.y, al), sim.frame);
      else if (e.type === 'eel') {
        if (e.ek >= 0 && e.eg >= 0) { segs[e.eg][e.ek] = e; eels = true; }
        if (e.ek === 0) drawHead(R, e, lerp(e.px, e.x, al), lerp(e.py, e.y, al), sim, F);
      }
    }
    if (eels) for (let g = 0; g < 2; g++) { drawRibbon(R, segs[g], al, F); segs[g].fill(null); }
    const Z = sim.ctx && sim.ctx.eels;
    if (Z) {
      const t = sim.frame - Z.uf;
      if (t >= 0 && t < 80) R.text('UNSPOOLED', Math.max(40, Math.min(W - 40, Z.ux)), Z.uy - 26 - t * 0.2, COL.teal, 1, 'c', t < 60 ? 1 : (80 - t) / 20);
    }
  }
};
