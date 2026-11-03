// STACKLIGHT scoring (B.7) and levels (B.7, B.9). Integer math only.
import { LINE_POINTS, FLAT_POINTS, KEY_POINTS, FIT_FLAT, FIT_KEY, GLOW_MAX, LEVEL_CAP,
  FREE_LINES_PER_LEVEL, DAILY_START_LEVEL, DAILY_LINES_PER_LEVEL } from '../defs.js';

// clear of n rows at this level with GLOW step g: base x level x (4 + g) / 4, always whole
// (100 -> 25 x level x (4 + g), 260 -> 65 x ..., 640 -> 160 x ...). More than 3 rows cannot happen (B.5); scored as 3.
export function clearPoints(n, level, g) {
  if (n <= 0) return 0;
  return (LINE_POINTS[n > 3 ? 3 : n] / 4) * level * (4 + g);
}

// FIT bonus: FLAT 40 x level, KEY 120 x level, not multiplied by GLOW
export function fitPoints(kind, level) {
  return kind === FIT_FLAT ? FLAT_POINTS * level : kind === FIT_KEY ? KEY_POINTS * level : 0;
}

// GLOW on a lock that clears: if the timer is above 0, g = min(g + 1, 4); else g = 0
export function nextGlow(g, timer) { return timer > 0 ? (g + 1 > GLOW_MAX ? GLOW_MAX : g + 1) : 0; }

// Free Play (and the test start): 1 + floor(lines / 8); Daily: 4 + floor(lines / 6); both capped at 20
export function levelFor(daily, lines) {
  const l = daily ? DAILY_START_LEVEL + Math.floor(lines / DAILY_LINES_PER_LEVEL) : 1 + Math.floor(lines / FREE_LINES_PER_LEVEL);
  return l > LEVEL_CAP ? LEVEL_CAP : l;
}
