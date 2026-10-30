// Measures the near-copy check (server/dedupe.js) in Node: how alike honest runs are, and how alike edited
// copies of one run are. Usage: node server/dedupe-measure.mjs   (about 2 minutes; numbers go in server/README.md)
//   honest: 5 game seeds x 40 input seeds x 2 play styles (fixtures.mjs playScripted), every same-seed pair
//   copies: 3 victim runs, each with 1, 5 or 40 random bit flips (fire, fire press, kindle, move bits), 200 tries
//           each; only edits that still give a finished run with no frames after game over count (the rest the
//           server refuses anyway), then the same edits "repaired" the way a cheater would: cut the frames after
//           game over, or add idle frames until game over, so every edited copy is a finished run
import { createSim } from '../games/starfall/sim.js';
import { decode } from '../engine/replay.js';
import { similarity, signatureRecorder, NEAR } from './dedupe.js';
import { playScripted, record } from './fixtures.mjs';

function resim(seed, words, repair = false) {
  const sim = createSim({ seed, mode: 'arcade' }), rec = signatureRecorder();
  let i = 0;
  for (; i < words.length && !sim.done; i++) { const b = sim.score; sim.step(words[i]); sim.clearEvents(); rec.add(sim.frame, b, sim.score); }
  if (repair) {
    for (let k = 0; k < 200000 && !sim.done; k++) { const b = sim.score; sim.step(128); sim.clearEvents(); rec.add(sim.frame, b, sim.score); }
    return { ok: sim.done, score: sim.score, hash: sim.stateHash(), sig: rec.sig };
  }
  return { ok: sim.done && i === words.length, score: sim.score, hash: sim.stateHash(), sig: rec.sig };
}
const tenths = () => new Array(11).fill(0);

const honest = [];
for (let seed = 1; seed <= 5; seed++) for (let k = 1; k <= 40; k++) for (const how of ['script', 'lazy']) {
  const p = playScripted(seed, k * 7919 + seed, how);
  honest.push({ seed, score: p.score, ...resim(seed, decode(p.replay).words) });
}
let pairs = 0, max = 0, over = 0, sameScore = 0;
const hh = tenths();
for (let a = 0; a < honest.length; a++) for (let b = a + 1; b < honest.length; b++) {
  if (honest[a].seed !== honest[b].seed) continue;
  pairs++;
  if (honest[a].score === honest[b].score) sameScore++;
  const s = similarity(honest[a].sig, honest[b].sig);
  if (s > max) max = s;
  if (s >= NEAR) over++;
  hh[Math.floor(s * 10)]++;
}
console.log(`honest: ${honest.length} runs, ${pairs} same-seed pairs (${sameScore} with equal score), max similarity ${max.toFixed(3)}, at or over ${NEAR}: ${over}`);
console.log(`  pairs by tenths 0.0..1.0: ${hh.join(' ')}`);

const BITS = [9, 10, 11, 0, 1, 2, 7];
for (const [seed, inSeed, how] of [[2, 2, 'script'], [3, 99, 'lazy'], [1, 1, 'script']]) {
  const words = decode(playScripted(seed, inSeed, how).replay).words;
  const base = resim(seed, words);
  for (const [edits, repair] of [[1, false], [5, false], [40, false], [1, true], [5, true], [40, true]]) {
    let x = 4242 + edits, valid = 0, min = 1, under = 0, sameScore = 0, newHash = 0, underHigh = 0, underBest = 0;
    const h = tenths();
    for (let t = 0; t < 200; t++) {
      const w = words.slice();
      for (let e = 0; e < edits; e++) {
        x = (Math.imul(x, 1103515245) + 12345) >>> 0; const f = x % w.length;
        x = (Math.imul(x, 1103515245) + 12345) >>> 0; w[f] ^= 1 << BITS[x % BITS.length];
      }
      const r = resim(seed, w, repair);
      if (!r.ok) continue;
      valid++;
      if (r.score === base.score) sameScore++;
      if (r.hash !== base.hash) newHash++;
      const s = similarity(r.sig, base.sig);
      if (s < min) min = s;
      if (s < NEAR) { under++; if (r.score >= base.score * 0.9) underHigh++; if (r.score > underBest) underBest = r.score; }
      h[Math.floor(s * 10)]++;
    }
    console.log(`copies of seed ${seed} ${how} (score ${base.score}), ${edits} edit(s)${repair ? ' repaired' : ''}: ${valid} finished, ${sameScore} same score, ${newHash} new hash, min similarity ${min.toFixed(3)}, under ${NEAR}: ${under} (best of those ${underBest}, ${underHigh} at 90% of the victim or more)`);
  }
}

// Strong victims: the state-reading bot of tools/record-replay.mjs (scores 230k to 330k). Repaired edited copies
// that get under NEAR have thrown the run away: their best score shows how much of the victim's run they kept.
for (const seed of [1, 2, 3]) {
  const words = decode(record('arcade', seed, 200000, 'bot').replay).words;
  const base = resim(seed, words);
  let x = 99, n = 0, under = 0, high = 0, best = 0;
  for (const edits of [1, 5, 40]) for (let t = 0; t < 40; t++) {
    const w = words.slice();
    for (let e = 0; e < edits; e++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0; const f = x % w.length;
      x = (Math.imul(x, 1103515245) + 12345) >>> 0; w[f] ^= 1 << BITS[x % BITS.length];
    }
    const r = resim(seed, w, true);
    n++;
    if (similarity(r.sig, base.sig) < NEAR) { under++; if (r.score > best) best = r.score; if (r.score >= base.score * 0.9) high++; }
  }
  console.log(`copies of bot run seed ${seed} (score ${base.score}), 1/5/40 edits repaired: ${n} tries, under ${NEAR}: ${under}, best of those ${best} (${(100 * best / base.score).toFixed(0)}% of the victim), ${high} at 90% or more`);
}
