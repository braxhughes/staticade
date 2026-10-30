// Pure ranking rules: trophies, leagues, seasons. No storage, no clock.
//
// TROPHY RULE (best 5)
//   Your rating this season is the average of your best 5 runs this season (avg5 = floor(sum of best 5 / 5); a
//   season with fewer than 5 runs counts the missing ones as 0, so a single lucky run is not a full rating).
//   Your trophies come from where that average sits among everyone rated this season (the percentile):
//     p = (players below you + half the players tied with you + 10) / (other players + 20)
//   The 10 and 20 are 20 imaginary players, half above you and half below, so a near-empty season does not make
//   the first player a Legend (alone, p = 0.5: Gold III). With 1,000 players they barely matter.
//   p maps to trophies on straight lines between these points (PCT_TROPHIES), which keeps the leagues below:
//     p 0 -> 0, .25 -> 300 (Silver), .50 -> 750 (Gold), .70 -> 1200 (Platinum), .85 -> 1800 (Diamond),
//     .95 -> 2400 (Master), .99 -> 3400 (Legend), 1 -> 3600.
//   A run that does not make your best 5 changes nothing. A run that does can only raise your average, so your
//   own play never costs trophies. Others passing you can move you down; the season carry (below) is a floor.
//
//   Worked examples
//   1. Alone in the season, any score: p = (0 + 0 + 10) / (0 + 20) = 0.5 -> 750 (Gold III).
//   2. 99 others, you beat 79 of them, no ties: p = (79 + 10) / (99 + 20) = 0.748 -> 1200 + (.048/.15)*600 = 1391.
//   3. Best 5 are 900, 800, 700, 600, 500 (avg5 700). A new run of 450 is not in the best 5: nothing changes.
//      A new run of 1000 replaces the 500: avg5 = 800.
//
// LEAGUES  (min trophies)
//   Bronze 0, Silver 300, Gold 750, Platinum 1200, Diamond 1800, Master 2400, Legend 3400.
//   Below Master each league has three equal sub-tiers: III (low), II, I (high).
//   Example: Gold spans 750..1199, so 750 = Gold III, 900 = Gold II, 1050 = Gold I.
//
// SEASONS
//   28 days from the epoch 2026-10-30T00:00:00Z, launch day. id = floor((t - epoch) / 28 days).
//   Season reset keeps half: at the start of a season your trophies are at least half of what you ended the last
//   season with (a quarter after two seasons away, and so on). Your new season rating replaces it once it is higher.
//   Example: ended at 2000 -> starts the next season at 1000 until the new best-5 rating beats 1000.

export const SEASON_EPOCH_MS = Date.UTC(2026, 9, 30); // launch day, the one place it is set
export const SEASON_DAYS = 28;
export const SEASON_MS = SEASON_DAYS * 86400000;
export const TOP_RUNS = 5;
export const PHANTOMS = 20;
export const PCT_TROPHIES = Object.freeze([[0, 0], [0.25, 300], [0.5, 750], [0.7, 1200], [0.85, 1800], [0.95, 2400], [0.99, 3400], [1, 3600]]);
export const CARRY_KEEP = 0.5;

// LEGACY (the per-run gain and loss before the best-5 rule). Nothing in the leaderboard uses these any more; they stay
// exported only until the tests that pin them are edited.
export const MIN_BOARD = 5;
export const SEASON_GAIN_CAP = 1200;
export const RESET_THRESHOLD = 1200;
export const RESET_KEEP = 0.5;

export const LEAGUES = [
  { name: 'Bronze', min: 0 },
  { name: 'Silver', min: 300 },
  { name: 'Gold', min: 750 },
  { name: 'Platinum', min: 1200 },
  { name: 'Diamond', min: 1800 },
  { name: 'Master', min: 2400 },
  { name: 'Legend', min: 3400 },
];
const SUBTIERS = ['III', 'II', 'I'];
const SUBTIER_LEAGUES = 5; // Bronze..Diamond have sub-tiers

export function leagueFor(trophies) {
  const t = Math.max(0, Math.floor(Number(trophies) || 0));
  let index = 0;
  for (let i = 0; i < LEAGUES.length; i++) if (t >= LEAGUES[i].min) index = i;
  const lg = LEAGUES[index];
  if (index >= SUBTIER_LEAGUES) {
    return { name: lg.name, tier: null, label: lg.name, index, rung: SUBTIER_LEAGUES * 3 + (index - SUBTIER_LEAGUES), min: lg.min };
  }
  const width = (LEAGUES[index + 1].min - lg.min) / 3;
  const sub = Math.min(2, Math.floor((t - lg.min) / width));
  return {
    name: lg.name,
    tier: SUBTIERS[sub],
    label: `${lg.name} ${SUBTIERS[sub]}`,
    index,
    rung: index * 3 + sub,
    min: Math.round(lg.min + sub * width),
  };
}

export function listLeagues() {
  return LEAGUES.map((l, i) => ({
    name: l.name,
    min: l.min,
    max: i + 1 < LEAGUES.length ? LEAGUES[i + 1].min - 1 : null,
    tiers: i < SUBTIER_LEAGUES ? SUBTIERS.map((tier, s) => ({ tier, min: Math.round(l.min + (s * (LEAGUES[i + 1].min - l.min)) / 3) })) : [],
  }));
}

export function seasonFor(ms) {
  const id = Math.floor((ms - SEASON_EPOCH_MS) / SEASON_MS);
  const start = SEASON_EPOCH_MS + id * SEASON_MS;
  return { id, start, end: start + SEASON_MS };
}

// ---------- best-5 trophy rule ----------

// top: best-first array of this season's best scores (at most TOP_RUNS). Returns the new list and whether
// `score` got into it. A score equal to the lowest kept one does not get in (the earlier run keeps its place).
export function topRuns(top, score) {
  const list = Array.isArray(top) ? top.filter((v) => Number.isFinite(v)).slice().sort((a, b) => b - a).slice(0, TOP_RUNS) : [];
  if (list.length >= TOP_RUNS && !(score > list[TOP_RUNS - 1])) return { top: list, entered: false };
  let i = list.length;
  while (i > 0 && list[i - 1] < score) i--;
  list.splice(i, 0, score);
  return { top: list.slice(0, TOP_RUNS), entered: true };
}

// floor(sum of the best TOP_RUNS / TOP_RUNS); missing runs count as 0.
export function average5(top) {
  let sum = 0;
  for (let i = 0; i < Math.min(TOP_RUNS, top.length); i++) sum += top[i];
  return Math.floor(sum / TOP_RUNS);
}

// below: other rated players with a lower avg5; ties: other players with the same avg5; others: all other rated players.
export function percentile({ below, ties = 0, others }) {
  const p = (below + ties / 2 + PHANTOMS / 2) / (others + PHANTOMS);
  return Math.min(1, Math.max(0, p));
}

export function trophiesForPercentile(p) {
  const x = Math.min(1, Math.max(0, Number(p) || 0));
  for (let i = 1; i < PCT_TROPHIES.length; i++) {
    const [p0, t0] = PCT_TROPHIES[i - 1], [p1, t1] = PCT_TROPHIES[i];
    if (x <= p1) return Math.floor(t0 + ((x - p0) / (p1 - p0)) * (t1 - t0));
  }
  return PCT_TROPHIES[PCT_TROPHIES.length - 1][1];
}

// What is left of `trophies` after `seasons` season resets (keeps half each time).
export function carryOver(trophies, seasons = 1) {
  let t = Math.max(0, Math.floor(Number(trophies) || 0));
  for (let i = 0; i < Math.min(Math.max(0, seasons), 60); i++) t = Math.floor(t * CARRY_KEEP);
  return t;
}

// A player's trophies this season. rated: has at least one run this season. carry: the floor from last season.
export function seasonTrophies({ rated, below = 0, ties = 0, others = 0, carry = 0 }) {
  const c = Math.max(0, Math.floor(carry || 0));
  if (!rated) return c;
  return Math.max(c, trophiesForPercentile(percentile({ below, ties, others })));
}

// ---------- LEGACY per-run rule (pre-best-5, unused; see the note at MIN_BOARD) ----------
export function placementPoints(rank, n) {
  const size = Math.max(MIN_BOARD, n);
  if (rank <= 1 && n >= MIN_BOARD) return 30;
  const p = (rank - 1) / size;
  if (p < 0.1) return 16;
  if (p < 0.25) return 10;
  if (p < 0.5) return 3;
  if (p < 0.75) return -3;
  return -6;
}

export function multiplier(trophies) {
  return Math.min(1.5, Math.max(0.5, 1.5 - trophies / 2000));
}

// seasonBest null/undefined means "no run yet this season" (any score, even 0, is a new best).
// Returns { delta, trophies, points, bonus, mult }. `delta` is the real change after cap and floor.
export function trophyChange({ trophies, rank, n, score, seasonBest, seasonGain = 0 }) {
  const t = Math.max(0, trophies | 0);
  const isBest = seasonBest == null || score > seasonBest;
  const points = isBest ? placementPoints(rank, n) : Math.min(0, placementPoints(rank, n));
  const bonus = isBest ? 8 : 0;
  const mult = multiplier(t);
  let raw = Math.round((points + bonus) * mult);
  if (raw > 0) raw = Math.max(0, Math.min(raw, SEASON_GAIN_CAP - seasonGain));
  const next = Math.max(0, t + raw);
  return { delta: next - t, trophies: next, points, bonus, mult };
}

export function seasonReset(trophies) {
  const t = Math.max(0, Math.floor(trophies));
  return t <= RESET_THRESHOLD ? t : Math.floor(RESET_THRESHOLD + (t - RESET_THRESHOLD) * RESET_KEEP);
}
