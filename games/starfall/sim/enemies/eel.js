// Eel (design.md B.3, Z2+): a 5-segment ribbon. 1 hp per segment; 80 per segment, 400 for the head.
//
// Ribbons: the stage table puts Eels in formation row 4. Columns 0-4 are ribbon 0 (head at column 0) and
// columns 5-9 are ribbon 1 (head at column 9); segment index k counts from the head (0) to the tail (4).
//   Entry   the ribbon enters as one: every segment takes the head's entry path, 8 frames behind the one before.
//           Ribbon 0 enters on the TL group path, ribbon 1 on the TR group path. In formation it is a curled row.
//   Dive    only the head dives. A dive pick that lands on a segment is passed to its head. When the head starts its
//           dive telegraph, every segment resting in formation glows with it and waits; segment k then follows the
//           head's recorded path 8 x k frames later (so it glows 20 + 8 x k frames before it moves). When the head's
//           dive ends, each segment rejoins its own slot as it reaches that point in the record.
//   Hunt    (B.1) a diving head steers toward the nearest wingman, if one exists. Z2+ Wisps also aim at wingmen
//           first (huntAim, set as the Wisp's aim hook in sim/registry.js).
//   Scatter if the head dies (shot, or taken by KINDLE), the rest scatter as free flyers. Segments that were
//           following it fly on at once; segments that were resting glow 20 frames first, then break off.
//           Segments not on screen yet (still waiting, or at the off-screen start of the entry path) enter as lone Eels.
//   Cap     a ribbon dives only when all its members fit under the B.5 diver cap (see ribbonFits).
//   UNSPOOLED killing all five tail to head (k = 4, 3, 2, 1, 0) pays a flat +2000.
// An Eel outside row 4 (or spawned by hand) is a lone segment and moves like any core enemy.
//
// Sim only: plain data art, no render imports. Pure and allocation-free per frame: per-sim ribbon state
// (typed arrays) is allocated once, on the first Eel of a run, at S.eels; per-enemy fields live on the pooled enemy.
// Enemy fields: eid (serial), eg (ribbon, -1 none), ek (segment, -1 lone), ew (0 own / 1 waiting / 2 following),
//   eep (dive number it follows), esc (scatter glow frames left), eoff (head's hunt offset), etl (head telegraph seen), ein (entry pending).
import { PI, W, GROUPS, POP_NUM, C_TEAL } from '../../defs.js';
import { atan2 } from '../../../../engine/dmath.js';
import { angDiff, clamp } from '../../sim-path.js';
import { TELE_DIVE } from '../feel.js';

export const EEL_LEN = 5, EEL_DELAY = 8, EEL_SCATTER = 20, UNSPOOL_BONUS = 2000;
export const HUNT_STEER = 0.7, HUNT_MAX = 70, HUNT_Y = 110; // per-frame change and cap of the head's lateral hunt offset; steering starts below y = HUNT_Y
const NR = 2, HN = 64; // ribbons per stage, history frames kept per ribbon (>= 1 + 8 x 4)
const GI_TL = GROUPS.findIndex(G => G.path === 'TL'), GI_TR = GROUPS.findIndex(G => G.path === 'TR');

let HEAD = null; // the head's stats: the registered def with head points (built once from the registered def)

function ribbons(S) {
  if (!S.eels) S.eels = {
    heads: [null, null], hid: new Int32Array(NR), hc: new Int32Array(NR), ep: new Int32Array(NR), next: new Int8Array(NR),
    hx: new Float64Array(NR * HN), hy: new Float64Array(NR * HN), he: new Int32Array(NR * HN),
    serial: 0, unspooled: 0, uf: -9999, ux: 0, uy: 0
  };
  return S.eels;
}
// the living head of e's ribbon, or null
export function headOf(S, e) {
  if (e.eg < 0 || !S.eels) return null;
  const R = S.eels, h = R.heads[e.eg];
  return h && !h.dead && h.type === 'eel' && h.eid === R.hid[e.eg] ? h : null;
}
// the wingman nearest to (x, y), or null
function nearestWing(S, x, y) {
  const wing = S.wing; let best = null, bd = Infinity;
  for (let i = 0; i < wing.length; i++) { const dx = wing[i].x - x, dy = wing[i].y - y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = wing[i]; } }
  return best;
}
// Wisp aim hook (B.1): from Z2, an aimed shot locks onto the nearest wingman instead of the player
export function huntAim(S, e) {
  if (S.zone < 2 || !S.wing.length) return;
  const w = nearestWing(S, e.x, e.y); e.aimX = w.x; e.aimY = w.y;
}

// start a segment's scatter: free flyer now if it was moving, else a 20-frame glow first
// (a segment that has not entered yet just enters on its own as a lone Eel: it still scores and still fights)
function scatter(S, e) {
  const k = e.ek, side = e.eg === 1 ? 1 : -1;
  e.ek = -1; e.eg = -1;
  if (e.st === 'wait' || (e.st === 'path' && (e.y < 4 || e.x < 4 || e.x > W - 4))) { e.ew = 0; return false; }
  if (e.ew === 2 || e.st === 'dive') { e.ew = 0; fly(e, e.vx, Math.max(1.2, e.vy)); return true; }
  e.ew = 0; e.st = 'tele'; e.tele = EEL_SCATTER; e.esc = EEL_SCATTER;
  e.vx = side * (0.35 + 0.22 * k); e.vy = 1.5;
  return true;
}
// formation pose: the ribbon rests as a curled row (B.3), each segment a little off its slot's line
export const CURL = [0, 3, 4.5, 3, -1];
function rest(S, e) { S.slot(e.r, e.c); e.x = S.SX; e.y = S.SY + CURL[e.ek]; e.ang += angDiff(e.ang, PI) * 0.15; }
// B.5 diver cap: a ribbon dives only if all its members fit under the cap at once (core divers + head + resting
// segments <= maxDivers); otherwise the pick is dropped and the head stays in formation. So a ribbon never pushes
// the dive count over the cap; it just needs a quieter moment than a single diver.
function ribbonFits(S, h) {
  const en = S.enemies; let divers = 0, m = 1;
  for (let i = 0; i < en.length; i++) {
    const o = en[i];
    if (o.dead || o === h) continue;
    if (o.st === 'tele' || o.st === 'dive' || o.st === 'spark') divers++;
    else if (o.type === 'eel' && o.ek > 0 && o.eg === h.eg && o.st === 'form' && headOf(S, o) === h) m++;
  }
  return divers + m <= S.maxDivers(en.length);
}
function fly(e, vx, vy) { e.st = 'spark'; e.tele = 0; e.esc = 0; e.vx = vx; e.vy = vy; e.asm = 1; }

// once per ribbon, on the head's first frame: the whole ribbon takes one entry path, 8 frames apart
function ribbonEntry(S, h) {
  const g = h.eg, gi = g === 0 ? GI_TL : GI_TR, P = gi >= 0 ? S.entryInfo[gi].a : h.path, en = S.enemies;
  let D = Infinity, spd = h.spd;
  for (let i = 0; i < en.length; i++) { const o = en[i]; if (o.type === 'eel' && o.eg === g && o.path === P && o.delay < D) { D = o.delay; spd = o.spd; } }
  if (D === Infinity || !P) return;
  for (let i = 0; i < en.length; i++) {
    const o = en[i];
    if (o.type !== 'eel' || o.ek < 0 || o.st !== 'wait' || (o !== h && headOf(S, o) !== h)) continue;
    o.path = P; o.delay = D + EEL_DELAY * o.ek; o.spd = spd;
  }
}

function moveHead(S, e) {
  const R = S.eels, g = e.eg;
  if (e.ein) { e.ein = 0; ribbonEntry(S, e); }
  let own = false;
  if (e.st === 'tele') {
    if (!e.etl) {
      if (!ribbonFits(S, e)) { e.st = 'form'; e.tele = 0; rest(S, e); return true; }
      // dive telegraph starts: the resting segments glow with the head and wait for its path
      e.etl = 1; R.ep[g]++;
      const en = S.enemies;
      for (let i = 0; i < en.length; i++) {
        const o = en[i];
        if (o.dead || o.type !== 'eel' || o.ek <= 0 || o.eg !== g || o.st !== 'form' || headOf(S, o) !== e) continue;
        o.st = 'tele'; o.tele = TELE_DIVE; o.ew = 1; o.eep = R.ep[g];
      }
    }
    rest(S, e);
    if (--e.tele <= 0) {
      e.tele = 0; e.etl = 0;
      const w = nearestWing(S, e.x, e.y), px = clamp(S.player.x, 40, W - 40);
      S.startDive(e, e.teleSide, w ? clamp(w.x, 40, W - 40) - px : 0);
      e.shots = 0; e.eoff = 0; // Eels never shoot; the ribbon itself is the threat
    }
    own = true;
  } else if (e.st === 'dive') {
    if (!S.follow(e)) {
      S.slot(e.r, e.c); e.x = e.px = S.SX; e.y = e.py = -16; e.st = 'join'; e.ang = PI; e.eoff = 0;
    } else {
      // hunt (B.1): in the lower part of the dive, steer the head toward the nearest wingman while it is still above it
      const w = nearestWing(S, e.x, e.y), x = e.x + e.eoff;
      if (w && e.y > HUNT_Y && e.y < w.y) e.eoff += clamp((w.x - x) * 0.06, -HUNT_STEER, HUNT_STEER);
      else if (!w) e.eoff *= 0.97;
      e.eoff = clamp(e.eoff, -HUNT_MAX, HUNT_MAX);
      e.x = clamp(e.x + e.eoff, 6, W - 6);
    }
    own = true;
  }
  // record the head for its segments (dive number while diving, 0 otherwise)
  const j = g * HN + (R.hc[g] % HN);
  R.hx[j] = e.x; R.hy[j] = e.y; R.he[j] = e.st === 'dive' ? R.ep[g] : 0; R.hc[g]++;
  return own;
}

function moveSegment(S, e) {
  const h = headOf(S, e);
  if (!h) return scatter(S, e);
  if (e.ew === 0) {
    // a core dive pick landed on a segment: the ribbon dives from its head instead
    if (e.st === 'tele') {
      e.st = 'form'; e.tele = 0;
      if (h.st === 'form') { h.st = 'tele'; h.tele = TELE_DIVE; h.teleSide = e.teleSide; h.teleOff = 0; }
    }
    return false;
  }
  const R = S.eels, g = e.eg, n = R.hc[g] - 1 - EEL_DELAY * e.ek, j = g * HN + (n >= 0 ? n % HN : 0), on = n >= 0 && R.he[j] === e.eep;
  if (e.ew === 1) {
    if (!on) { rest(S, e); return true; }
    e.ew = 2; e.st = 'dive'; e.tele = 0;
  } else if (!on) {
    // the head's dive ended at this point of the record: rejoin the own slot from above, as the head did
    e.ew = 0; S.slot(e.r, e.c); e.x = e.px = S.SX; e.y = e.py = -16; e.st = 'join'; e.ang = PI;
    return true;
  }
  const nx = R.hx[j], ny = R.hy[j];
  e.vx = nx - e.x; e.vy = ny - e.y;
  if (e.vx * e.vx + e.vy * e.vy > 0.01) e.ang += angDiff(e.ang, atan2(e.vx, -e.vy)) * 0.4;
  e.x = nx; e.y = ny;
  return true;
}

export const eel = {
  name: 'EEL', hp: 1, r: 5, form: 80, dive: 80,
  art: {
    A: ['..tit..', '.tvvvt.', 'tvwiwvt', 'tviiivt', '.tvvvt.', '..t.t..', '..t.t..'],
    B: ['..tit..', '.tvvvt.', 'tvwiwvt', 'tviiivt', '.tvvvt.', '.t...t.', '.t...t.'],
    pal: { t: [0.25, 0.95, 0.9], v: [0.6, 0.4, 1], i: [0.8, 0.95, 1], w: [1, 1, 1] },
    hurt: { t: [1, 0.45, 0.6], v: [0.9, 0.3, 0.6], i: [1, 0.8, 0.85], w: [1, 1, 1] }
  },
  init(S, e) {
    const R = ribbons(S);
    e.eid = ++R.serial; e.ew = 0; e.eep = 0; e.esc = 0; e.eoff = 0; e.etl = 0; e.ein = 0;
    const k = e.r === 4 && e.c >= 0 && e.c <= 9 ? (e.c < EEL_LEN ? e.c : 9 - e.c) : -1;
    e.ek = k; e.eg = k < 0 ? -1 : e.c < EEL_LEN ? 0 : 1;
    if (k !== 0) return;
    if (!HEAD) HEAD = Object.assign({}, e.T, { form: 400, dive: 400, head: true });
    e.T = HEAD; e.ein = 1;
    const g = e.eg;
    R.heads[g] = e; R.hid[g] = e.eid; R.hc[g] = 0; R.ep[g] = 0; R.next[g] = EEL_LEN - 1;
    R.he.fill(0, g * HN, g * HN + HN);
  },
  move(S, e) {
    if (e.esc > 0) { if (--e.esc === 0) fly(e, e.vx, e.vy); return true; } // scatter glow, holding still
    if (e.ek < 0) { if (e.st === 'dive') e.shots = 0; return false; } // a lone Eel moves like any core enemy, but never shoots
    const own = e.ek === 0 ? moveHead(S, e) : moveSegment(S, e);
    if (!own && e.st === 'form' && e.ek >= 0) { rest(S, e); return true; }
    return own;
  },
  // UNSPOOLED: count kills tail to head; any other order (or a segment lost to KINDLE) breaks the run
  onKill(S, e) {
    if (e.ek < 0 || !S.eels) return;
    const R = S.eels, g = e.eg;
    if (e.ek !== R.next[g]) { R.next[g] = -9; return; }
    R.next[g]--;
    if (e.ek !== 0) return;
    const v = S.addBonus(UNSPOOL_BONUS);
    S.popup(POP_NUM, e.x, e.y - 14, v, C_TEAL);
    R.unspooled++; R.uf = S.frame; R.ux = e.x; R.uy = e.y;
  }
};
