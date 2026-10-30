// The Tetherling (design.md B.11 3.1, slice V2): linked pairs whose line is the hazard. Stage rows 6, 7, 8.
// HP 1 each, 150 in formation / 350 diving. The stage table (sim/stages.js TETHER6, TETHER78) puts each pair in two
// neighbouring slots that are consecutive members of one entry group, so the pair enters together.
//
// Launch   in this system's step (same frame as the pick; systems step after updFormation): a Tetherling in 'tele'
//          whose partner is live in 'form' puts the partner in 'tele' with the same telegraph count and side. The
//          left member gets offx -15, the right +15. If live divers + 1 is more than maxDivers(n), both go back to
//          'form' and that dive cycle passes (like an Eel ribbon that does not fit). If the partner is gone or not in
//          'form', the pick dives alone with no line.
// Spacing  the two dive paths' control points from the 6th on (y 159 and below) are exactly 30 apart in x; before
//          that the gap is the slot gap (24 to 28). Clamp note (C.2 CUT box LOW): formation.js clamps every control
//          point to 8..392 (cxl) and the ship x to 40..360, so near an edge the spacing collapses. A pair diving with
//          side -1 (it sits left of center) loses the 30 when the ship x is above 323 (its right member's last point,
//          px + 54 + 15, passes 392). A pair with side +1 loses it when the ship x is below 77 (the left member's last
//          point, px - 54 - 15, passes 8); the CUT box names 63, which is where the 6th point (px - 40 - 15) clamps.
// Line     ym = mean y of the pair. Phase 0: faint and harmless (formation, entry, early dive). Blink (phase 1) starts
//          on the first dive frame ym >= 130 and lasts exactly 30 frames, harmless. Solid (phase 2) from then until
//          ym > 290, or either member leaves the screen or its dive path, or dies. Then gone (phase 3) for that dive.
// Hit      during Solid, P = the point of the segment between the two centers nearest the ship's center; the ship is
//          hit when abs(P.x - x) < 3.5 and abs(P.y - y) < 4.5 (the bullet-point rule, B.9). A power with a bullet
//          hook (HALO) absorbs a touch as one bullet (one charge), then the line ignores the ship for 30 frames.
//          Wingmen and the MIRROR ghost ignore the line. The line never grazes and is not a bullet (no B.9 rule 5).
// Break    one member dies during the linked dive (shot, body hit, KINDLE; any death): SFX snap and FX_TETHER at
//          the line's midpoint while the line is up; a survivor still on its dive path leaves it and flies straight
//          down at limitDive(1.5 x diveSpd()), x fixed, then re-enters from the top and joins its slot like any diver.
//          One killed in formation: the other is a plain single diver. Deaths are found by polling in step (KINDLE
//          takes an enemy without a 'kill' event).
// CUT      both killed within 30 frames of each other: +1000 flat (addBonus), popup POP_CUT, SFX cut.
// Frames here are gameplay frames: this system's step (hit-stop skips it, so everything here freezes in hit-stop).
//
// State: S.tethers (2 pairs per stage, preallocated typed arrays). Per-enemy fields on the pooled enemy, set in
// init: tp (pair, -1 = lone), tm (0 left / 1 right), tid (serial), tfall (1 = falling after a break), tv (fall speed).
// Hash: per pair phase, phase frames, HALO ignore frames, CUT frames, dive mode, members alive; per live
// Tetherling tp, tfall and tv. Pure: no DOM, Math.random or Date; no per-frame allocation.
import { W, H, PI, SFX_ID, POP_CUT, FX_TETHER, C_GOLD } from '../../defs.js';
import { limitDive } from '../difficulty.js';
import { POWERS } from '../powerups.js';
import { TETHER6, TETHER78 } from '../stages.js';

export const TETHER_PAIRS = 2; // at most 2 pairs per stage
export const TETHER_OFF = 15, LINE_BLINK_Y = 130, LINE_BLINK = 30, LINE_END_Y = 290;
export const HALO_IGNORE = 30, CUT_WINDOW = 30, CUT_BONUS = 1000, FALL_MUL = 1.5;
export const HIT_X = 3.5, HIT_Y = 4.5;
// line phases
export const LINE_FAINT = 0, LINE_BLINKING = 1, LINE_SOLID = 2, LINE_GONE = 3;
// dive modes: 0 none, 1 linked dive (the line runs its phases), 2 one member dives alone (no line)
export const DIVE_NONE = 0, DIVE_LINKED = 1, DIVE_SOLO = 2;

// slot list (pair k = entries 2k, 2k + 1, left first) by stage row; endless rows repeat (B.11 0.7)
export const tetherSlots = row => row === 6 ? TETHER6 : row === 7 || row === 8 ? TETHER78 : null;

const PT = { x: 0, y: 0 }; // the touch point handed to a power's bullet hook (one reused object)

// stats from B.11 3.1. Art: a round seed with a bright clasp; plain data (sim files never import the renderer)
export const TETHER = {
  name: 'TETHERLING', hp: 1, r: 6, form: 150, dive: 350,
  art: {
    A: ['..lll..', '.lmmml.', 'lmwywml', 'lmyoyml', '.lmmml.', '..l.l..', '.l...l.'],
    B: ['..lll..', '.lmmml.', 'lmwywml', 'lmyoyml', '.lmmml.', '.l...l.', '..l.l..'],
    pal: { l: [0.95, 0.55, 1], m: [0.75, 0.35, 0.95], w: [1, 1, 1], y: [1, 0.92, 0.6], o: [1, 0.6, 0.25] },
    hurt: { l: [1, 0.45, 0.6], m: [0.9, 0.3, 0.5], w: [1, 1, 1], y: [1, 0.8, 0.8], o: [1, 0.5, 0.4] }
  },
  init(S, e) {
    e.tp = -1; e.tm = 0; e.tfall = 0; e.tv = 0;
    const T = S.tethers; if (!T) { e.tid = 0; return; }
    e.tid = ++T.serial;
    const L = tetherSlots(S.row);
    if (!L || S.stageKind !== 'normal') return;
    for (let i = 0; i < L.length; i++) if (L[i][0] === e.r && L[i][1] === e.c) {
      e.tp = i >> 1; e.tm = i & 1;
      T.mem[i] = e; T.mid[i] = e.tid;
      return;
    }
  },
  // a survivor of a break falls straight down, x fixed, then re-enters from the top and joins its slot
  move(S, e) {
    if (!e.tfall) return false;
    e.y += e.tv; e.ang += (PI - e.ang) * 0.3;
    if (e.y > H + 16) {
      e.tfall = 0; S.slot(e.r, e.c); e.x = e.px = S.SX; e.y = e.py = -16; e.st = 'join'; e.ang = PI;
    }
    return true;
  }
};

function mkTethers() {
  return { phase: new Uint8Array(TETHER_PAIRS), phaseT: new Int32Array(TETHER_PAIRS),
    ignoreT: new Int32Array(TETHER_PAIRS), cutT: new Int32Array(TETHER_PAIRS).fill(-1), dive: new Uint8Array(TETHER_PAIRS),
    mem: [null, null, null, null], mid: new Int32Array(TETHER_PAIRS * 2), serial: 0, cuts: 0, snaps: 0,
    // presentation only (render/enemies-c2.js; not hashed): the frame of the last break per pair and the line's ends then
    brkF: new Int32Array(TETHER_PAIRS).fill(-9999), brkAx: new Float64Array(TETHER_PAIRS), brkAy: new Float64Array(TETHER_PAIRS),
    brkBx: new Float64Array(TETHER_PAIRS), brkBy: new Float64Array(TETHER_PAIRS) };
}

// member j (0..3) is alive and still the enemy registered for it
export function tetherLive(T, j) { const e = T.mem[j]; return e !== null && !e.dead && e.type === 'tether' && e.tid === T.mid[j]; }
const diving = e => e.st === 'tele' || e.st === 'dive';
const offScreen = e => e.y > H || e.x < 0 || e.x > W;

// segment test (B.11 3.1): the point of segment A-B nearest (x, y) goes to PT; true when it is inside the ship box
export function lineTouch(ax, ay, bx, by, x, y) {
  const vx = bx - ax, vy = by - ay, vv = vx * vx + vy * vy;
  let t = vv > 0 ? ((x - ax) * vx + (y - ay) * vy) / vv : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  PT.x = ax + vx * t; PT.y = ay + vy * t;
  return Math.abs(PT.x - x) < HIT_X && Math.abs(PT.y - y) < HIT_Y;
}

function divers(S) {
  const en = S.enemies; let n = 0;
  for (let i = 0; i < en.length; i++) { const o = en[i]; if (!o.dead && (o.st === 'tele' || o.st === 'dive' || o.st === 'spark')) n++; }
  return n;
}

// a pick landed on a member this frame (it is in 'tele', the pair is not diving yet). a is the left member.
function launch(S, T, k, a, b) {
  const p = a.st === 'tele' ? a : b, q = p === a ? b : a;
  if (q.st !== 'form' && q.st !== 'tele') { T.dive[k] = DIVE_SOLO; T.phase[k] = LINE_GONE; T.phaseT[k] = 0; return; }
  if (q.st === 'form' && divers(S) + 1 > S.maxDivers(S.enemies.length)) {
    // the pair does not fit under the diver cap: both stay in formation and this dive cycle passes
    p.st = 'form'; p.tele = 0; p.hunt = 0;
    return;
  }
  q.st = 'tele'; q.tele = p.tele; q.teleSide = p.teleSide; q.hunt = 0;
  a.teleOff = -TETHER_OFF; b.teleOff = TETHER_OFF;
  T.dive[k] = DIVE_LINKED; T.phase[k] = LINE_FAINT; T.phaseT[k] = 0;
}

// the linked dive: line phase by the pair's mean y, then the hit test while Solid
function linked(S, T, k, a, b, ignoring) {
  if (a.st === 'tele' || b.st === 'tele') return; // still glowing in the slots: faint
  const gone = a.st !== 'dive' || b.st !== 'dive' || offScreen(a) || offScreen(b), ym = (a.y + b.y) / 2;
  switch (T.phase[k]) {
    case LINE_FAINT:
      if (gone) { T.phase[k] = LINE_GONE; T.phaseT[k] = 0; } else if (ym >= LINE_BLINK_Y) { T.phase[k] = LINE_BLINKING; T.phaseT[k] = 1; }
      break;
    case LINE_BLINKING:
      if (gone) { T.phase[k] = LINE_GONE; T.phaseT[k] = 0; } else if (++T.phaseT[k] > LINE_BLINK) { T.phase[k] = LINE_SOLID; T.phaseT[k] = 1; }
      break;
    case LINE_SOLID:
      if (gone || ym > LINE_END_Y) { T.phase[k] = LINE_GONE; T.phaseT[k] = 0; } else T.phaseT[k]++;
      break;
  }
  if (T.phase[k] !== LINE_SOLID || ignoring) return;
  const P = S.player;
  if (!P.alive || P.inv > 0 || S.state !== 'play') return;
  if (!lineTouch(a.x, a.y, b.x, b.y, P.x, P.y)) return;
  const pw = POWERS[S.power];
  if (pw && pw.bullet && pw.bullet(S, PT)) { T.ignoreT[k] = HALO_IGNORE; return; } // HALO: one charge, then 30 frames of grace
  S.playerDie();
}

function cut(S, T, e) {
  const v = S.addBonus(CUT_BONUS);
  S.popup(POP_CUT, e.x, e.y - 12, v, C_GOLD); S.sfx(SFX_ID.cut);
  T.cuts++;
}

// one or both members of pair k are no longer alive (the refs of the ones that died since the last step are still set)
function deaths(S, T, k) {
  const ja = 2 * k, jb = ja + 1, a = T.mem[ja], b = T.mem[jb], la = tetherLive(T, ja), lb = tetherLive(T, jb);
  const newA = a !== null && !la, newB = b !== null && !lb;
  if (newA && newB) cut(S, T, b);                                   // both in the same frame
  else if ((newA && b === null) || (newB && a === null)) {           // the second of the pair
    if (T.cutT[k] >= 0 && T.cutT[k] <= CUT_WINDOW) cut(S, T, newA ? a : b);
  } else if (newA || newB) {                                         // the first of the pair; the other lives on
    const d = newA ? a : b, s = newA ? b : a;
    T.cutT[k] = 0;
    if (T.dive[k] === DIVE_LINKED) {
      if (T.phase[k] !== LINE_GONE) {
        S.sfx(SFX_ID.snap); S.fx(FX_TETHER, (d.x + s.x) / 2, (d.y + s.y) / 2); T.snaps++;
        T.brkF[k] = S.frame; T.brkAx[k] = a.x; T.brkAy[k] = a.y; T.brkBx[k] = b.x; T.brkBy[k] = b.y;
      }
      if (s.st === 'dive') { s.tfall = 1; s.tv = limitDive(FALL_MUL * S.diveSpd()); }
    }
  }
  if (newA) T.mem[ja] = null;
  if (newB) T.mem[jb] = null;
  if (T.mem[ja] === null && T.mem[jb] === null) T.cutT[k] = -1;
  T.phase[k] = LINE_GONE; T.phaseT[k] = 0; T.dive[k] = DIVE_NONE; T.ignoreT[k] = 0;
}

export const tetherSystem = {
  id: 'tether',
  init(S) { S.tethers = mkTethers(); },
  step(S) {
    const T = S.tethers;
    for (let k = 0; k < TETHER_PAIRS; k++) {
      if (T.cutT[k] >= 0) T.cutT[k]++;              // frames since the pair's first death
      const ja = 2 * k;
      if (T.mem[ja] === null && T.mem[ja + 1] === null) continue;
      if (!tetherLive(T, ja) || !tetherLive(T, ja + 1)) { deaths(S, T, k); continue; }
      const a = T.mem[ja], b = T.mem[ja + 1];
      const ignoring = T.ignoreT[k] > 0;
      if (ignoring) T.ignoreT[k]--;
      if (T.dive[k] === DIVE_NONE) {
        if (a.st === 'tele' || b.st === 'tele') launch(S, T, k, a, b);
        else if (diving(a) || diving(b)) { T.dive[k] = DIVE_SOLO; T.phase[k] = LINE_GONE; T.phaseT[k] = 0; }
        else { T.phase[k] = LINE_FAINT; T.phaseT[k] = 0; }
      }
      if (T.dive[k] === DIVE_LINKED) linked(S, T, k, a, b, ignoring);
      // the dive is over once neither member is glowing or on a dive path: back to a faint line
      if (T.dive[k] !== DIVE_NONE && !diving(a) && !diving(b)) { T.dive[k] = DIVE_NONE; T.phase[k] = LINE_FAINT; T.phaseT[k] = 0; }
    }
  },
  onEvent(S, ev) {
    if (ev.type !== 'stage') return;
    // setupStage made this stage's Tetherlings (init registered them) before this event; drop any ref that is not
    // one of them (clearEnemies frees the old stage's enemies without marking them dead)
    const T = S.tethers, en = S.enemies;
    for (let j = 0; j < TETHER_PAIRS * 2; j++) {
      const e = T.mem[j]; if (e === null) continue;
      let found = false;
      for (let i = 0; i < en.length; i++) if (en[i] === e) { found = true; break; }
      if (!found || e.tid !== T.mid[j]) T.mem[j] = null;
    }
    for (let k = 0; k < TETHER_PAIRS; k++) {
      T.phase[k] = T.mem[2 * k] && T.mem[2 * k + 1] ? LINE_FAINT : LINE_GONE;
      T.phaseT[k] = 0; T.ignoreT[k] = 0; T.cutT[k] = -1; T.dive[k] = DIVE_NONE; T.brkF[k] = -9999;
    }
  },
  hash(S, u32, f64) {
    const T = S.tethers;
    for (let k = 0; k < TETHER_PAIRS; k++) {
      u32(T.phase[k]); u32(T.phaseT[k]); u32(T.ignoreT[k]); u32(T.cutT[k] + 1); u32(T.dive[k]);
      u32(tetherLive(T, 2 * k) ? 1 : 0); u32(tetherLive(T, 2 * k + 1) ? 1 : 0);
    }
    u32(T.cuts); u32(T.snaps);
    const en = S.enemies;
    for (let i = 0; i < en.length; i++) { const e = en[i]; if (!e.dead && e.type === 'tether') { u32(e.tp + 1); u32(e.tfall); f64(e.tv); } }
  }
};
