// Near-copy check. A run's "signature" is its first SIG_EVENTS scoring events, each [frame, points], read off
// the server's own re-sim. An edited copy of someone else's replay (a flipped fire bit, a nudge here and there)
// plays out almost the same: the same kills at the same moments, give or take a frame or two. Two honest runs do
// not: different inputs put the kills at different frames.
//
// similarity(a, b): the share of scoring events of one run that the other run also has (same points, within TOL
// frames), over the longer of the two lists. Measured (server/dedupe-measure.mjs, numbers in server/README.md):
// honest runs on the same seed top out near 0.32; edited copies start near 0.97. NEAR = 0.6 sits between.
// Runs with fewer than MIN_EVENTS scoring events are too short to tell apart and are left to the exact check.
export const SIG_EVENTS = 128, TOL = 4, NEAR = 0.6, MIN_EVENTS = 16;

// a, b: flat arrays [frame0, points0, frame1, points1, ...], frames increasing.
export function similarity(a, b) {
  const na = a.length >> 1, nb = b.length >> 1;
  if (na < MIN_EVENTS || nb < MIN_EVENTS) return 0;
  let i = 0, j = 0, m = 0;
  while (i < a.length && j < b.length) {
    const d = a[i] - b[j];
    if (d > TOL) { j += 2; continue; }
    if (d < -TOL) { i += 2; continue; }
    let hit = -1;
    for (let k = j; k < b.length && b[k] - a[i] <= TOL; k += 2) {
      if (b[k + 1] === a[i + 1] && Math.abs(b[k] - a[i]) <= TOL) { hit = k; break; }
    }
    if (hit >= 0) { m++; j = hit + 2; }
    i += 2;
  }
  return m / Math.max(na, nb);
}

// Collects the signature while a sim runs: call add(frame, scoreBefore, scoreAfter) after each step.
export function signatureRecorder() {
  const sig = [];
  return {
    sig,
    add(frame, before, after) { if (after !== before && sig.length < 2 * SIG_EVENTS) sig.push(frame, after - before); },
  };
}
