// Near-copy check. A run's "signature" is its first SIG_EVENTS scoring events, each [frame, points], read off
// the server's own re-sim. An edited copy of someone else's replay (a flipped fire bit, a nudge here and there)
// plays out almost the same: the same kills at the same moments, give or take a frame or two. Two honest runs do
// not: different inputs put the kills at different frames.
//
// similarity(a, b): the share of scoring events of one run that the other run also has (same points, within TOL
// frames), over the longer of the two lists. Measured (server/dedupe-measure.mjs, numbers in server/README.md):
// honest runs on the same seed top out near 0.32; edited copies start near 0.97. NEAR = 0.6 sits between.
// Runs with fewer than MIN_EVENTS scoring events are too short to tell apart and are left to the exact check.
//
// What an event records is per game (server/games.js sigKey and sigValue). Starfall: [frame, points], as above.
// STACKLIGHT: [pieceKey(n), placeCode(row, col, rot)], the piece that scored and where it locked.
// Its outcome ignores timing (the piece order comes from the deck), so idle frames inserted into someone else's run
// moved every later score by the same number of frames and changed nothing else; on the frame key that copy scored
// 0.000 to 0.037 and went on the board. Timing cannot move the piece count (the sim's `spawned`) or where a piece
// locks. Points are left out on purpose: GLOW pays for the gap between clears, so a copy of the same placements played
// faster or slower scores different points on the same pieces (a re-timed copy of golden seed 1 scored 152% of it).
// pieceKey(n) = n * PIECE_STEP with PIECE_STEP > TOL, so similarity() below matches STACKLIGHT events only on the
// same piece (tolerance 0) without knowing the game: server/d1-adapter.js calls it with two stored signatures and no
// game. Measured in tools/replay-proof.mjs --likeness (numbers in server/README.md): honest same-seed runs, time-shifted
// copies and one-bit copies on this key.
// Mirror copies: the STACKLIGHT board is 9 wide, spawn is the centre column 4, and every shape is
// left-right symmetric around its pivot, so swapping LEFT and RIGHT in every input word of a run that starts on a
// symmetric board (Free Play starts empty) plays its mirror image: every piece locks at column 8 - c, same rows, same
// clears, same frames, the exact score. So a STACKLIGHT run is compared with the stored one twice, as it is and with its
// placements mirrored, and the larger share counts. The column is not folded (|c - 4|): that would make two honest
// runs that build on opposite sides piece by piece look alike. similarity() knows a STACKLIGHT signature without the
// game by the sign of its values: a placeCode is negative, a Starfall event's points are always positive. Starfall's
// path is the one it always was.
export const SIG_EVENTS = 128, TOL = 4, NEAR = 0.6, MIN_EVENTS = 16;
export const PIECE_STEP = TOL + 1;
export function pieceKey(n) { return n * PIECE_STEP; }
// where a STACKLIGHT piece locked: its pivot row and column and its orientation (0 or 1), one negative integer
// (negative marks it as a placement, above). MIRROR_COL is the board's last column (defs.js COLS - 1): column c mirrors
// to MIRROR_COL - c. Orientation mirrors to itself (a flat BAR stays flat, an upright one upright, PLUS never turns).
export const MIRROR_COL = 8;
export function placeCode(row, col, rot) { return -1 - (row * 32 + col * 2 + rot); }
// the placeCode of the mirror image of a placement: same row and orientation, column MIRROR_COL - col
export function mirrorPlace(v) {
  const p = -1 - v, col = (p >> 1) & 15;
  return -1 - (p + (MIRROR_COL - 2 * col) * 2);
}

// a, b: flat arrays [key0, value0, key1, value1, ...], keys increasing (Starfall: frame and points; STACKLIGHT: pieceKey
// and placeCode). Two events match on equal values and keys within TOL. If both are placement signatures (negative
// values), the larger of the plain share and the mirrored share.
export function similarity(a, b) {
  const na = a.length >> 1, nb = b.length >> 1;
  if (na < MIN_EVENTS || nb < MIN_EVENTS) return 0;
  let m = matches(a, b, false);
  if (a[1] < 0 && b[1] < 0) { const mm = matches(a, b, true); if (mm > m) m = mm; }
  return m / Math.max(na, nb);
}
// how many events of a also are in b, a's values mirrored when mirror is set (no allocation)
function matches(a, b, mirror) {
  let i = 0, j = 0, m = 0;
  while (i < a.length && j < b.length) {
    const d = a[i] - b[j];
    if (d > TOL) { j += 2; continue; }
    if (d < -TOL) { i += 2; continue; }
    const va = mirror ? mirrorPlace(a[i + 1]) : a[i + 1];
    let hit = -1;
    for (let k = j; k < b.length && b[k] - a[i] <= TOL; k += 2) {
      if (b[k + 1] === va && Math.abs(b[k] - a[i]) <= TOL) { hit = k; break; }
    }
    if (hit >= 0) { m++; j = hit + 2; }
    i += 2;
  }
  return m;
}

// Collects the signature while a sim runs: call add(key, scoreBefore, scoreAfter, value) after each step. key is the
// game's sigKey(sim) (server/games.js): Starfall's frame, STACKLIGHT's pieceKey(spawned). value is the game's
// sigValue(sim), or undefined to record the points (Starfall).
export function signatureRecorder() {
  const sig = [];
  return {
    sig,
    add(key, before, after, value) { if (after !== before && sig.length < 2 * SIG_EVENTS) sig.push(key, value === undefined ? after - before : value); },
  };
}
