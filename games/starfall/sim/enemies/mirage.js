// The Mirage (design.md B.3, Z3): 1 hp, 200 in formation / 500 diving. It shows two copies MIRAGE_GAP units
// apart, centered on the enemy's position (e.x is the midpoint). Every MIRAGE_SWAP frames the solid copy swaps
// sides. The swap is a MIRAGE_FADE-frame cross-fade, and the hit state switches at the START of the fade: on
// the first fade frame the copy that begins brightening is already the solid one. Shots and bodies pass
// through the ghost (it is an image, not a body); ghost shots still count as fired.
//
// The clock is S.formT (frozen during hit-stop, like every gameplay timer) plus the enemy's own seeded phase,
// so neighboring Mirages do not swap in step. Pure functions of sim state: nothing to store or hash.
// The sim reads `hitX` (sim.js shot and body tests) for the x of the copy that can be hit.
// Drawn by render/enemies-z3.js (the two copies and the fade).
export const MIRAGE_GAP = 30, MIRAGE_SWAP = 40, MIRAGE_FADE = 12;
const HALF = MIRAGE_GAP / 2;

const clock = (S, e) => S.formT + e.phase;
// side of the solid copy: -1 = left, +1 = right
export const mirageSide = (S, e) => ((clock(S, e) / MIRAGE_SWAP | 0) & 1) ? 1 : -1;
// frames since the last swap began (0 = the first fade frame)
export const mirageT = (S, e) => clock(S, e) % MIRAGE_SWAP;
// cross-fade progress toward the current solid copy: (t + 1) / MIRAGE_FADE during the fade, then 1
export const mirageFade = (S, e) => { const t = mirageT(S, e); return t < MIRAGE_FADE ? (t + 1) / MIRAGE_FADE : 1; };
// x of the solid (hittable) copy
export const mirageHitX = (S, e) => e.x + mirageSide(S, e) * HALF;

export const MIRAGE = {
  name: 'MIRAGE', hp: 1, r: 6, form: 200, dive: 500,
  hitX: mirageHitX,
  // a rose-and-violet heat-haze eye with a gold pupil; it breathes between two frames
  art: {
    A: ['....m....', '...mpm...', '..mp.pm..', '.mp.e.pm.', 'mp.eye.pm', '.mp.e.pm.', '..mp.pm..', '...mpm...', '....m....'],
    B: ['....m....', '..mmpmm..', '.mp...pm.', 'mp..e..pm', 'p..eye..p', 'mp..e..pm', '.mp...pm.', '..mmpmm..', '....m....'],
    pal: { m: [1, .5, .65], p: [.8, .4, 1], e: [1, .85, .3], y: [1, .97, .8] }
  }
};
