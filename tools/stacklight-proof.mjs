// STACKLIGHT survival proof (the STACKLIGHT design notes B.3 and Evidence E.1): the greatest fixed point over
// height maps. A state is (the column heights minus the lowest, each 0..K, at least one 0) x (BARs and PLUSes left in
// the deck). It is safe if, for every piece the deck can still deal, some placement (after MELT and clears) leaves a
// safe state. Start with all states safe and remove unsafe ones until nothing changes. If the empty board with a fresh
// deck survives, then against any order of pieces inside each deck the spread never passes K.
// The fixed point is E.1's gfp2.mjs, unchanged; only the defaults come from games/stacklight/defs.js.
//
// Usage:
//   node tools/stacklight-proof.mjs [W] [K] [bars] [pluses]   default: 9 wide, spread 3, the 3 BAR + 2 PLUS deck
//   node tools/stacklight-proof.mjs --ridges                  also checks every Daily RIDGE (B.9) with a fresh deck,
//                                                             for the 3+2 deck and the LEAN 2+2 deck
// Prints one line per fixed point, e.g. `W=9 K=3 deck=3bar+2plus iterations=12 safe=1963604 emptyFreshSafe=true`.
// Exits 1 if the empty board (or, with --ridges, any ridge) is not safe.
import { COLS, DECK, LEAN_DECK, BAR, PLUS, RIDGES } from '../games/stacklight/defs.js';

const argv = process.argv.slice(2);
const RIDGE_CHECK = argv.includes('--ridges');
const pos = argv.filter(a => !a.startsWith('--'));
const count = (deck, p) => deck.filter(x => x === p).length;

function solve(W, K, NB, NP) {
  const B = K + 1, NH = B ** W, D = (NB + 1) * (NP + 1);
  const mv = { bar: [], plus: [] };
  for (let c = 0; c + 2 < W; c++) mv.bar.push([c, 1, c + 1, 1, c + 2, 1]); // BAR flat
  for (let c = 0; c < W; c++) mv.bar.push([c, 3]);                         // BAR upright
  for (let c = 1; c + 1 < W; c++) mv.plus.push([c - 1, 1, c, 3, c + 1, 1]); // PLUS (after MELT)
  const ok = new Uint8Array(NH), a = new Int32Array(W);
  for (let s = 0; s < NH; s++) { let x = s, mn = 99; for (let i = 0; i < W; i++) { const v = x % B; x = (x / B) | 0; if (v < mn) mn = v; } ok[s] = mn === 0 ? 1 : 0; }
  function succ(s, m) {
    let x = s; for (let i = 0; i < W; i++) { a[i] = x % B; x = (x / B) | 0; }
    for (let k = 0; k < m.length; k += 2) a[m[k]] += m[k + 1];
    let mn = 99; for (let i = 0; i < W; i++) if (a[i] < mn) mn = a[i];
    let t = 0; for (let i = W - 1; i >= 0; i--) { const v = a[i] - mn; if (v > K) return -1; t = t * B + v; } return t;
  }
  const safe = new Uint8Array(NH * D), di = (b, p) => b * (NP + 1) + p;
  for (let s = 0; s < NH; s++) if (ok[s]) for (let d = 0; d < D; d++) safe[s * D + d] = 1;
  function nextDeck(b, p, pc) {
    if (b === 0 && p === 0) { b = NB; p = NP; }
    if (pc === 'bar') { if (b === 0) return -1; b--; } else { if (p === 0) return -1; p--; } return di(b, p);
  }
  let changed = true, it = 0;
  while (changed) {
    changed = false; it++;
    for (let s = 0; s < NH; s++) {
      if (!ok[s]) continue;
      for (let b = 0; b <= NB; b++) for (let p = 0; p <= NP; p++) {
        const d = di(b, p); if (!safe[s * D + d]) continue;
        for (const pc of ['bar', 'plus']) {
          const nd = nextDeck(b, p, pc); if (nd < 0) continue;
          let good = false; for (const m of mv[pc]) { const t = succ(s, m); if (t >= 0 && safe[t * D + nd]) { good = true; break; } }
          if (!good) { safe[s * D + d] = 0; changed = true; break; }
        }
      }
    }
  }
  let n = 0; for (let i = 0; i < safe.length; i++) n += safe[i];
  const freshSafe = heights => { let t = 0; for (let i = W - 1; i >= 0; i--) t = t * B + heights[i]; return safe[t * D + di(0, 0)] === 1; };
  console.log(`W=${W} K=${K} deck=${NB}bar+${NP}plus iterations=${it} safe=${n} emptyFreshSafe=${!!safe[di(0, 0)]}`);
  return { emptyFreshSafe: !!safe[di(0, 0)], freshSafe };
}

const W = +(pos[0] ?? COLS), K = +(pos[1] ?? 3), NB = +(pos[2] ?? count(DECK, BAR)), NP = +(pos[3] ?? count(DECK, PLUS));
const main = solve(W, K, NB, NP);
let fail = !main.emptyFreshSafe;
if (RIDGE_CHECK) {
  // B.9: each ridge is a solid height map with min 0 and max 2, so it is a state of the K = 3 fixed point as it is
  const lean = solve(COLS, 3, count(LEAN_DECK, BAR), count(LEAN_DECK, PLUS));
  const std = W === COLS && K === 3 && NB === count(DECK, BAR) && NP === count(DECK, PLUS) ? main : solve(COLS, 3, count(DECK, BAR), count(DECK, PLUS));
  const hs = RIDGES.map(r => [...r].map(Number));
  const okStd = hs.every(h => Math.min(...h) === 0 && std.freshSafe(h)), okLean = hs.every(h => Math.min(...h) === 0 && lean.freshSafe(h));
  console.log(`ridges=${RIDGES.length} all safe for 3+2: ${okStd}  for 2+2: ${okLean}`);
  if (!okStd || !okLean) fail = true;
}
process.exit(fail ? 1 : 0);
