// STACKLIGHT presentation state built from sim events (B.10): melt drip, clear flash and fade, render-only particles,
// FIT / clear / level popups, the hard-drop streak, top-out. Reads the sim (grid, events, active piece); never writes it.
// Everything is preallocated. Strings for popups are made once per event (a lock), never per frame.
// Times are in sim frames, so a pause freezes every effect exactly where it was. "now" = the frame on screen =
// sim.frame - 1 + alpha; an event pushed on frame f is at age now - f (the lock frame is age 0).
import { Rng } from '../../../engine/rng.js';
import { CELLS, COLS, FIT_FLAT, FIT_KEY } from '../defs.js';
import { EV_SPAWN, EV_HARD_DROP, EV_LOCK, EV_MELT, EV_FIT, EV_CLEAR, EV_LEVEL, EV_TOPOUT, EV_LIGHTSOUT } from '../sim.js';
import { colX, rowY, CELL } from './geom.js';

export const DRIP = 8;    // B.4 / B.10: the melt drip runs over 8 frames after the lock
export const FLASH = 6;   // B.10: cleared rows flash white for 6 frames
export const FADE = 14;   // then fade over 14 while dots scatter (6 + 14 = the 20-frame clear delay)
export const POP_LIFE = 54, LEVEL_LIFE = 100, STREAK = 7;
export const PMAX = 600, PS = 8; // particle pool: x0, y0, vx, vy, born, life, type, size
export const POPS = 6;           // popup ring
export const POP_FIT = 1, POP_POINTS = 2, POP_LEVEL = 3;

const NEVER = -1e9;
const FIT_STR = ['', 'FLAT', 'KEY'];
const LEVEL_STR = []; for (let i = 0; i <= 20; i++) LEVEL_STR.push('LEVEL ' + i);

export function createFx() {
  const before = new Uint8Array(CELLS); // the grid before the current step
  const base = new Uint8Array(CELLS);   // the grid before the last lock (drawn under the drip)
  const melt = new Uint8Array(CELLS);   // the grid after the last lock's melt, before its clears (drawn under the flash)
  const mc = new Int16Array(5), m0 = new Int16Array(5), m1 = new Int16Array(5); // melt records: col, row before, row after
  const part = new Float32Array(PMAX * PS);
  const pop = new Float32Array(POPS * 5); // kind, x, y, born, life
  const popStr = ['', '', '', '', '', ''];
  const rng = new Rng(0x51c7); // render-only randomness (particles), never the sim's streams
  const S = {
    lockF: NEVER, lockType: 0, lockCol: 0, nMelt: 0, moved: 0, fit: 0, topRow: 0,
    clearF: NEVER, clearMask: 0, clearRows: 0, clearPts: 0, clearG: 0,
    hardF: NEVER, hardRows: 0, spawnF: NEVER, overF: NEVER, overReason: 0, levelF: NEVER,
    prevPx: 0, prevPy: 0, prevRot: 0, prevSpawned: -1, nPart: 0, popHead: 0,
    lastFitX: 0, lastFitY: 0, lastFitKind: 0
  };

  function reset() {
    S.lockF = S.clearF = S.hardF = S.spawnF = S.overF = S.levelF = NEVER;
    S.clearMask = 0; S.nMelt = 0; S.prevSpawned = -1; S.lastFitKind = 0;
    for (let i = 0; i < PMAX; i++) part[i * PS + 5] = 0;
    for (let i = 0; i < POPS; i++) pop[i * 5] = 0;
  }

  // before every sim step: keep the grid and the active piece (for the drip and for interpolation)
  function beforeStep(sim) {
    before.set(sim.grid);
    const c = sim.ctx;
    S.prevPx = c.px; S.prevPy = c.py; S.prevRot = c.rot; S.prevSpawned = c.pType ? c.spawned : -1;
  }

  function addPop(kind, x, y, born, life, str) {
    const i = S.popHead; S.popHead = (S.popHead + 1) % POPS;
    const o = i * 5;
    pop[o] = kind; pop[o + 1] = x; pop[o + 2] = y; pop[o + 3] = born; pop[o + 4] = life; popStr[i] = str;
  }

  function addPart(x, y, vx, vy, born, life, type, size) {
    let k = -1;
    for (let i = 0; i < PMAX; i++) if (part[i * PS + 5] === 0) { k = i; break; }
    if (k < 0) return;
    const o = k * PS;
    part[o] = x; part[o + 1] = y; part[o + 2] = vx; part[o + 3] = vy; part[o + 4] = born; part[o + 5] = life; part[o + 6] = type; part[o + 7] = size;
  }

  // one sim event (buf, offset), as sim.drain hands them over, oldest first
  function onEvent(buf, o) {
    const type = buf[o], f = buf[o + 1], a = buf[o + 2], b = buf[o + 3], c = buf[o + 4], d = buf[o + 5];
    switch (type) {
      case EV_SPAWN: S.spawnF = f; break;
      case EV_HARD_DROP: S.hardF = f; S.hardRows = a; break;
      case EV_LOCK:
        S.lockF = f; S.lockType = a; S.fit = b; S.moved = c; S.lockCol = d; S.nMelt = 0; S.topRow = 0;
        base.set(before); melt.set(before);
        break;
      case EV_MELT:
        if (S.nMelt < 5) { const i = S.nMelt++; mc[i] = a; m0[i] = b; m1[i] = c; }
        if (a >= 0 && a < COLS && c >= 0) melt[c * COLS + a] = S.lockType;
        if (c > S.topRow) S.topRow = c;
        break;
      case EV_FIT: {
        // FLAT / KEY above the piece: centred on the pivot column (for KEY, the notch), just over its top cell
        const x = colX(S.lockCol), y = rowY(S.topRow) - CELL - 4;
        addPop(POP_FIT, x, y, f, POP_LIFE, FIT_STR[a] || '');
        addPop(POP_POINTS, x, y + 4, f, POP_LIFE, '+' + b);
        S.lastFitX = x; S.lastFitY = y; S.lastFitKind = a;
        break;
      }
      case EV_CLEAR: {
        S.clearF = f; S.clearMask = b; S.clearRows = a; S.clearPts = c; S.clearG = d;
        // points beside the board (right panel, between NEXT and BEST), level with the lowest cleared row
        let low = 0; while (low < 21 && !(b & (1 << low))) low++;
        const py = rowY(low);
        addPop(POP_POINTS, 292, py < 214 ? 214 : py > 252 ? 252 : py, f, POP_LIFE, '+' + c);
        // render-only particles: they start when the flash ends and scatter while the rows fade
        for (let r = 0; r < 21; r++) {
          if (!(b & (1 << r))) continue;
          for (let col = 0; col < COLS; col++) {
            const t = melt[r * COLS + col] || 1;
            for (let k = 0; k < 3; k++) {
              const vx = (rng.next() - 0.5) * 2.4, vy = -0.6 - rng.next() * 1.6;
              addPart(colX(col) + (rng.next() - 0.5) * 8, rowY(r) + (rng.next() - 0.5) * 8, vx, vy, f + FLASH, 14 + rng.next() * 16, t, 1.6 + rng.next() * 1.8);
            }
          }
        }
        break;
      }
      case EV_LEVEL: S.levelF = f; addPop(POP_LEVEL, 200, 130, f, LEVEL_LIFE, LEVEL_STR[a] || 'LEVEL UP'); break;
      case EV_TOPOUT: S.overF = f; S.overReason = 1; break;
      case EV_LIGHTSOUT: S.overF = f; S.overReason = 2; break;
    }
  }

  // free particles whose life is over (called once per render frame with the current sim time)
  function age(now) {
    let n = 0;
    for (let i = 0; i < PMAX; i++) {
      const o = i * PS;
      if (part[o + 5] === 0) continue;
      if (now - part[o + 4] > part[o + 5]) part[o + 5] = 0; else n++;
    }
    S.nPart = n;
  }

  return { S, before, base, melt, mc, m0, m1, part, pop, popStr, reset, beforeStep, onEvent, age };
}
