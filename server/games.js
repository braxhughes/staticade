// The games this server re-simulates (design C.4, card T6). server/verify.js picks one by the run's game id; an id that
// is not here is refused (bad_game). Each entry carries what the checks need:
//   id, version     the game id and its current GAME_VERSION (only the current version is taken)
//   modeHeader      claimed mode (leaderboard/api.js: 'daily' or 'free') -> the mode the replay header must carry
//   createSim       the game's own sim, for pass A (server/verify.js)
//   stageOf(sim)    the number stored as stats.stage: Starfall's stage, STACKLIGHT's level
//   sigKey(sim)     the key of a scoring event in the near-copy signature (server/dedupe.js), read after each step.
//                   Starfall: the frame. STACKLIGHT: pieceKey(spawned), the piece that scored, which idle frames cannot
//                   move.
//   sigValue        null: the event records its points (Starfall). Else sigValue(sim) is recorded instead: STACKLIGHT's
//                   placeCode of where the piece locked (row, column, orientation). Its points are left out because GLOW
//                   makes them depend on timing (server/dedupe.js). A placeCode is negative, which tells similarity() to
//                   compare the run mirrored too (a LEFT-RIGHT swapped Free Play run keeps the exact score).
//   sigCanon(sim)   optional (STACKLIGHT). Called once per run on the fresh sim; returns canon(sim, value), called
//                   after every step with sigValue(sim). Its result is what pass A records. STACKLIGHT: the placement in
//                   canonical left-right form (makeStacklightCanon below), so a mirror that starts at any symmetric board
//                   records the same signature as the run it copies. Starfall has none (its path is unchanged).
//   hashOf(sim)     the final state hash as a string. The results table keys copies by it (hash TEXT, server/d1-adapter.js
//                   compares it with String(hash)). Starfall's stateHash() is already 8 hex digits; STACKLIGHT's is a
//                   uint32 number, so it is kept as its decimal string: a number bound as a double would be stored as
//                   '2241779068.0', never equal its own String(), and every run would be held as a copy of itself.
//   inputMask       bits an input word may have; a word with any other bit set is bad_replay (null: no such rule)
//   makeVerifyReplay({ now, dailySeedOf }) -> verifyReplay({ game, replay, seed, mode, dayKey, version }): pass B, the
//                   strict verifier. It returns the score, or NaN for any run it does not accept.
// STACKLIGHT's 'test' mode (B.7) is in no modeHeader, so no replay with it can ever be taken.
import { decode } from '../engine/replay.js';
import { dailySeed } from '../engine/rng.js';
import { createSim as createStarfall, GAME_ID as SF_ID, GAME_VERSION as SF_VERSION } from '../games/starfall/sim.js';
import { makeVerifyReplay as makeStarfallVerify, todayUTC } from '../games/starfall/modes.js';
import { createSim as createStacklight } from '../games/stacklight/sim.js';
import { GAME_ID as SL_ID, GAME_VERSION as SL_VERSION, INPUT_MASK as SL_MASK, REPLAY_MODES as SL_MODES } from '../games/stacklight/defs.js';
import { COLS, TOTAL_ROWS, EMPTY, SPAWN_COL } from '../games/stacklight/defs.js';
import { pieceKey, placeCode, mirrorPlace } from './dedupe.js';

const DAY_MS = 86400000;
const SL_HEADER = Object.freeze({ daily: 'daily', free: 'arcade' });
// C.2 written out here, not read from defs.js INPUT_MASK: only bits 0 to 6 of an input word mean anything;
// bits 7 to 15 (and anything above) are reserved. Pass A masks with the registry's inputMask (defs.js); pass B checks
// this literal, so widening INPUT_MASK alone lets no reserved bit through (pass B refuses it, the passes disagree).
const SL_C2_BITS = 0x007f;

// STACKLIGHT pass B. games/stacklight has no strict verifier of its own yet (its modes.js is card T5), so this is the
// smallest one, kept here rather than in games/stacklight. It is independent of pass A in how it reaches each verdict:
//   - frames after the end, and one canonical string per run: pass A stops at the first word it sees with sim.done
//     set, and re-encodes the decoded words. Here the sim's own recorder does both: step() records nothing once the run
//     is over, so sim.replay() (the words the sim took, encoded by the sim) equals the submitted string only if every
//     word was played, the run ended on the last one, and the string was canonical.
//   - reserved bits: pass A masks each word with inputMask (defs.js INPUT_MASK). Here the C.2 literal SL_C2_BITS
//     (above, not INPUT_MASK) and the sim's own flag (badInput, set inside step()) both say.
//   - finished: sim.done after the last word.
//   - header: its own checks of game, version, mode, seed and the Daily's day, from the decoded header.
// It shares the sim and the replay codec with pass A (as Starfall's pass B does): a fault in those is what the golden
// replays and tools/replay-proof.mjs catch, not this.
export function makeStacklightVerify({ now = Date.now, dailySeedOf = null } = {}) {
  return function verifyReplay({ replay, seed, mode, dayKey, version, game }) {
    const want = SL_HEADER[mode];
    if (!want || typeof seed !== 'number' || typeof replay !== 'string') return NaN;
    if (game !== undefined && game !== SL_ID) return NaN;
    let h;
    try { h = decode(replay); } catch { return NaN; }
    if (h.game !== SL_ID || h.version !== SL_VERSION || String(version) !== SL_VERSION) return NaN;
    if (h.mode !== want || !SL_MODES.includes(h.mode) || h.seed !== seed) return NaN;
    if (mode === 'daily') {
      if (typeof dayKey !== 'string') return NaN;
      let ds; try { ds = dailySeedOf ? dailySeedOf(dayKey) : dailySeed(dayKey); } catch { return NaN; }
      const dayMs = Date.parse(dayKey + 'T00:00:00Z');
      if (seed !== ds || !Number.isFinite(dayMs)) return NaN;
      if (now && Math.abs(dayMs - Date.parse(todayUTC(now()) + 'T00:00:00Z')) > DAY_MS) return NaN;
    }
    let sim;
    try { sim = createStacklight({ seed: h.seed, mode: h.mode }); } catch { return NaN; }
    const w = h.words, n = w.length;
    for (let i = 0; i < n; i++) { if ((w[i] & ~SL_C2_BITS) !== 0) return NaN; sim.step(w[i]); sim.clearEvents(); }
    if (!sim.done || sim.badInput || sim.replay() !== replay) return NaN;
    return sim.score;
  };
}

// STACKLIGHT has no left-right bias but the V-to-H turn kick, and every shape is symmetric about its
// pivot, so from any moment where the board's occupied cells are left-right symmetric and no piece is in play, swapping
// LEFT and RIGHT in every later word plays the exact mirror of the rest of the run (same score). Comparing the whole
// run plain and mirrored (server/dedupe.js) misses a copy that switches there: half its events match plain, half
// mirrored. So pass A records each placement in a canonical form instead of as played:
//   - a "free" mark is set at the start if the board is symmetric (Free Play starts empty) and after every lock that
//     leaves the board symmetric (locks are the only frames the grid changes, and the next piece is not in play yet);
//   - after a free mark, the first lock off the centre column (SPAWN_COL, 4) decides the side: right of centre sets
//     flip = 1, left sets flip = 0;
//   - every placement is recorded through flip (mirrorPlace when flip = 1) until the next free mark.
// A run and its mirror from any number of symmetric moments have the same marks (symmetry is mirror-blind) and make
// the opposite choice at each decision, so they record the same signature and the plain compare catches them. The
// symmetry test runs only on lock frames, on the sim's own grid, with no allocation; other frames cost a few integer
// compares. Board symmetric means occupancy only (cell colours do not change how the sim plays).
export function boardSymmetric(grid) {
  const half = COLS >> 1;
  for (let r = 0; r < TOTAL_ROWS; r++) {
    const o = r * COLS;
    for (let c = 0; c < half; c++) if ((grid[o + c] === EMPTY) !== (grid[o + COLS - 1 - c] === EMPTY)) return false;
  }
  return true;
}
export function makeStacklightCanon(sim0) {
  const grid = sim0.grid;
  let lastType = sim0.ctx.pType, lastSpawned = sim0.ctx.spawned, flip = 0, free = boardSymmetric(grid);
  return function canon(sim, value) {
    const S = sim.ctx;
    // a lock this step: no piece now, and there was one before or a new one spawned and locked in the same step
    if (S.pType === 0 && (lastType !== 0 || S.spawned !== lastSpawned)) {
      if (free && S.px !== SPAWN_COL) { flip = S.px > SPAWN_COL ? 1 : 0; free = false; }
      const out = flip === 1 ? mirrorPlace(value) : value;
      if (boardSymmetric(grid)) free = true;
      lastType = 0; lastSpawned = S.spawned;
      return out;
    }
    lastType = S.pType; lastSpawned = S.spawned;
    return flip === 1 ? mirrorPlace(value) : value;
  };
}

export const GAMES = Object.freeze({
  [SF_ID]: Object.freeze({
    id: SF_ID, version: SF_VERSION, modeHeader: Object.freeze({ daily: 'daily', free: 'arcade' }), // as in games/starfall/modes.js
    createSim: createStarfall, sigKey: (sim) => sim.frame, sigValue: null, stageOf: (sim) => sim.stage, hashOf: (sim) => sim.stateHash(), inputMask: null, makeVerifyReplay: makeStarfallVerify,
  }),
  [SL_ID]: Object.freeze({
    id: SL_ID, version: SL_VERSION, modeHeader: SL_HEADER,
    createSim: createStacklight, sigKey: (sim) => pieceKey(sim.ctx.spawned), sigValue: (sim) => placeCode(sim.ctx.py, sim.ctx.px, sim.ctx.rot), sigCanon: makeStacklightCanon, stageOf: (sim) => sim.level, hashOf: (sim) => String(sim.stateHash()), inputMask: SL_MASK, makeVerifyReplay: makeStacklightVerify,
  }),
});
export const GAME_IDS = Object.freeze(Object.keys(GAMES));

// The registry entry for a game id, or null. Own keys only, so 'constructor' or '__proto__' is never a game.
export function gameOf(id) { return typeof id === 'string' && Object.hasOwn(GAMES, id) ? GAMES[id] : null; }
