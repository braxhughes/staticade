// Difficulty (design.md B.5): the first-loop table, endless loop scaling, heat effects and the global limits.
// fillDifficulty() runs at stage setup into a preallocated object; the limit helpers run at use time,
// so the global limits are always applied last (after table, jitter, DEEP SKY, loop and heat).
import { rowOf, loopOf, STAGE_TABLE } from './stages.js';

// normal rows: entry, dive, bullet speed; shots per dive (-1 = 0 or 1 at 50%); max divers full / 8 or fewer;
// dive gap full / 8 or fewer; path fire chance per frame; bullet cap
const N = (entry, dive, bullet, shots, maxFull, maxLow, gapFull, gapLow, pathFire, cap) =>
  ({ entry, dive, bullet, shots, maxFull, maxLow, gapFull, gapLow, pathFire, cap });
export const DIFF_TABLE = [
  null,
  N(2.4, 1.65, 2.0, -1, 2, 3, 120, 45, 0, 12),
  N(2.4, 1.75, 2.0, 1, 2, 3, 120, 45, 0, 14),
  N(2.6, 1.95, 2.3, 2, 3, 5, 95, 25, 0.002, 18),
  { cap: 0 },                              // 4 STARLIGHT
  { cap: 26, bossLo: 1.0, bossHi: 1.6 },   // 5 ECLIPSE
  N(2.7, 2.10, 2.4, 2, 3, 6, 88, 25, 0.004, 22),
  N(2.8, 2.20, 2.5, 2, 4, 6, 80, 25, 0.005, 24),
  N(2.9, 2.35, 2.6, 2, 4, 7, 72, 22, 0.006, 26),
  { cap: 0 },                              // 9 STARLIGHT
  { cap: 84, bossLo: 1.2, bossHi: 1.4 },   // 10 MOONWELL
  N(3.0, 2.50, 2.8, 3, 5, 7, 64, 20, 0.008, 30),
  N(3.1, 2.65, 2.9, 3, 5, 8, 58, 20, 0.009, 32),
  N(3.2, 2.80, 3.0, 3, 6, 8, 52, 18, 0.010, 34),
  { cap: 0 },                              // 14 STARLIGHT
  { cap: 96, bossLo: 1.3, bossHi: 2.0 }    // 15 PYRE
];

// global limits (applied last, every loop including loop 0)
export const BULLET_MIN = 1.0, BULLET_MAX = 3.6, DIVE_MAX = 3.6, GAP_FLOOR_FULL = 30, GAP_FLOOR_LOW = 14;
export const BOSS_TIMEOUT = 5400;
export const limitBullet = v => v < BULLET_MIN ? BULLET_MIN : v > BULLET_MAX ? BULLET_MAX : v;
export const limitDive = v => v > DIVE_MAX ? DIVE_MAX : v;
export const limitGap = (v, low) => Math.max(low ? GAP_FLOOR_LOW : GAP_FLOOR_FULL, v);

export function createDifficulty() {
  return { row: 1, loop: 0, entry: 0, dive: 0, bullet: 0, shots: 0, maxFull: 0, maxLow: 0, gapFull: 0, gapLow: 0, pathFire: 0, cap: 0,
    bossLo: 0, bossHi: 0, bossHp: 1, scoreLoop: 1, bulletMul: 1, diveMul: 1, gapMul: 1, extraDivers: 0, extraShots: 0 };
}

// D: object from createDifficulty(). Boss and STARLIGHT rows take their dive values from the closest earlier
// normal row (Eclipse's summoned moths still dive with them).
export function fillDifficulty(D, stage) {
  const row = rowOf(stage), L = loopOf(stage);
  let nr = row; while (nr > 1 && STAGE_TABLE[nr].kind !== 'normal') nr--;
  const T = DIFF_TABLE[nr], R = DIFF_TABLE[row];
  D.row = row; D.loop = L;
  D.bulletMul = Math.min(1.36, 1 + 0.06 * L);
  D.diveMul = Math.min(1.30, 1 + 0.05 * L);
  // 0.92^L by repeated multiplication (Math.pow is not guaranteed identical across engines)
  let g = 1; for (let i = 0; i < L; i++) g *= 0.92;
  D.gapMul = g;
  D.extraDivers = L; D.extraShots = Math.floor(L / 2);
  D.entry = T.entry;
  D.dive = T.dive * D.diveMul;
  D.bullet = T.bullet * D.bulletMul;
  D.shots = T.shots;
  D.maxFull = Math.min(9, T.maxFull + L); D.maxLow = Math.min(9, T.maxLow + L);
  D.gapFull = T.gapFull * D.gapMul; D.gapLow = T.gapLow * D.gapMul;
  D.pathFire = T.pathFire;
  D.cap = Math.min(96, R.cap + 6 * L);
  D.bossLo = R.bossLo || 0; D.bossHi = R.bossHi || 0;
  D.bossHp = Math.min(2.5, 1 + 0.25 * L);
  D.scoreLoop = Math.min(3, 1 + 0.25 * L);
  return D;
}

// shots per dive for this stage: table value + floor(L / 2), at most 4; -1 means 0 or 1 at 50% (rng supplied)
export function diveShots(D, rnd) {
  const base = D.shots < 0 ? (rnd() < 0.5 ? 1 : 0) : D.shots;
  return Math.min(4, base + D.extraShots);
}

// heat effects (heat is fixed at 0 until S11)
export const heatBullet = heat => 1 + Math.min(100, heat) * 0.002;
export const heatGap = heat => Math.floor(Math.min(100, heat) * 0.3);
