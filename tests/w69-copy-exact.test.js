// STACKLIGHT 3.0: two checks on the near-copy signature through the real server verifier
// (server/verify.js makeServerVerifier, the same pass A the Worker runs). tests/server-stacklight-copy.test.js is not edited.
//   1. The real 3.0 Free Play golden shifted one piece later matches itself on exactly the events whose next piece also
//       scored with the same placement (plain or mirrored): similarity === that count / n, counted here with tolerance 0
//       and no help from similarity(). On 3.0 that is 1 of 60. A looser signature (a piece step inside TOL, a coarser
//       placeCode) matches more or records something else, and fails; the signature's contents are pinned too.
//   2. The fast copier (thinks up to 11 frames, rnd(12): the attacker before 3.0 slowed it to rnd(20)) replays the
//       golden's placements on a new timing. Its copies are caught: similarity >= NEAR, and through worker.fetch the
//       copy of a stored run is held (202), not stored.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decode } from '../engine/replay.js';
import { createSim, PH_PLAY } from '../games/stacklight/sim.js';
import { GAME_ID, GAME_VERSION } from '../games/stacklight/defs.js';
import { makeServerVerifier } from '../server/verify.js';
import { similarity, signatureRecorder, pieceKey, mirrorPlace, NEAR } from '../server/dedupe.js';
import { GAMES } from '../server/games.js';
import { makeEnv, post, createWorker } from '../server/fixtures.mjs';

// the golden runs, read from the golden test (never copied here)
const GOLDENS = (() => {
  const src = fs.readFileSync(fileURLToPath(new URL('./stacklight-golden.test.js', import.meta.url)), 'utf8');
  const re = /name: '([^']+)', seed: (\d+), mode: '(\w+)'.*?score: (\d+).*?r1: '([^']+)'/gs;
  return [...src.matchAll(re)].map((m) => ({ name: m[1], seed: +m[2], mode: m[3], score: +m[4], replay: m[5] }));
})();
const FREE = GOLDENS.find((g) => g.mode === 'arcade');
const verify = makeServerVerifier();
const sigOf = (replay, seed) => verify({ game: GAME_ID, replay, seed, mode: 'free', version: GAME_VERSION });

test('M2: the real 3.0 golden shifted one piece later scores exactly its count of equal next pieces (1 of 60)', () => {
  assert.equal(GAME_VERSION, '3.0');
  const v = sigOf(FREE.replay, FREE.seed), sig = v.sig, n = sig.length / 2;
  assert.equal(v.score, FREE.score, 'the verifier re-sims the golden to its score');
  const later = sig.map((x, i) => (i % 2 === 0 ? x + pieceKey(1) : x));
  // count by hand: a shifted event matches only an event of the same piece (key equal) with the same value, or the
  // mirrored value (similarity takes the larger of the plain and the mirrored share)
  let plain = 0, mirrored = 0;
  for (let i = 0; i < later.length; i += 2) {
    for (let j = 0; j < sig.length; j += 2) {
      if (sig[j] !== later[i]) continue;
      if (sig[j + 1] === later[i + 1]) plain++;
      if (sig[j + 1] === mirrorPlace(later[i + 1])) mirrored++;
    }
  }
  const same = Math.max(plain, mirrored);
  assert.equal(similarity(sig, later), same / n, `similarity is exactly ${same} / ${n}`);
  assert.equal(similarity(later, sig), same / n, 'and the same the other way round');
  // pinned on the 3.0 golden: 60 scoring pieces, 1 whose next piece scored with the same placement, none mirrored
  assert.equal(n, 60, 'scoring events in the 3.0 Free Play golden');
  assert.equal(plain, 1, 'equal next pieces (plain)');
  assert.equal(mirrored, 0, 'equal next pieces (mirrored)');
  assert.equal(similarity(sig, later), 1 / 60);
  // and the signature itself, so a coarser placement code (row, column or orientation left out) cannot hide behind the
  // same count: 35 different placements, 13 of them upright (orientation bit 1), and its exact contents
  const vals = sig.filter((x, i) => i % 2 === 1);
  assert.equal(new Set(vals).size, 35, 'different placements among the 60');
  assert.equal(vals.filter((x) => ((-1 - x) & 1) === 1).length, 13, 'upright placements');
  assert.equal(createHash('sha256').update(sig.join(',')).digest('hex'), '9d4d2f7b769eb43a9c2665dc5624f22858d856243c8e68bb1140aa02df4d58ed', 'the 3.0 Free Play golden signature');
});

// where each piece of a run locked (the copier reads them off the stored replay)
function placements(seed, mode, words) {
  const sim = createSim({ seed, mode }), pl = [];
  let locked = 0;
  for (let i = 0; i < words.length && !sim.done; i++) {
    sim.step(words[i]); sim.clearEvents();
    if (sim.ctx.pType === 0 && sim.ctx.phase !== PH_PLAY && locked !== sim.ctx.spawned) { locked = sim.ctx.spawned; pl.push([sim.ctx.px, sim.ctx.rot]); }
  }
  return pl;
}
// the fast copier: the same bot as tests/server-stacklight-copy.test.js retimed() before 3.0, thinking up to 11 frames
// (rnd(12)) per piece, then turning, moving and dropping (hard, or soft held all the way)
function fastCopy(seed, mode, pl, inSeed, soft) {
  const sim = createSim({ seed, mode });
  let s = inSeed, prev = 0, planned = -1, think = 0, tries = 0;
  const rnd = (n) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 16) % n; };
  while (!sim.done) {
    const S = sim.ctx; let w = 0;
    if (S.phase === PH_PLAY) {
      if (S.spawned !== planned) { planned = S.spawned; think = rnd(12); tries = 0; }
      const [col, rot] = pl[S.spawned - 1] || [S.px, S.rot];
      if (think > 0) think--;
      else if (S.rot !== rot && tries < 3) { w = prev & 64 ? 0 : 64; tries++; }
      else if (S.px !== col) { const press = S.px > col ? 9 : 18; w = prev & (press & 24) ? 0 : press; }
      else w = soft ? 4 : (prev & 32 ? 0 : 32);
    }
    sim.step(w); sim.clearEvents(); prev = w;
  }
  return sim.replay();
}

// pass A's signature exactly as server/verify.js records it (sigKey, sigValue, sigCanon from the registry), for the
// daily golden: its seed 4 is not a real day's seed, so the verifier's daily door (dayKey checks) cannot take it
const SLG = GAMES.stacklight;
function passA(seed, mode, words) {
  const sim = SLG.createSim({ seed, mode }), rec = signatureRecorder(), canon = SLG.sigCanon == null ? null : SLG.sigCanon(sim);
  for (let i = 0; i < words.length && !sim.done; i++) {
    const b = sim.score; sim.step(words[i]); sim.clearEvents();
    rec.add(SLG.sigKey(sim), b, sim.score, canon === null ? SLG.sigValue(sim) : canon(sim, SLG.sigValue(sim)));
  }
  return { score: sim.score, sig: rec.sig };
}

test('M3: the fast copier (rnd(12)) on 3.0: its copies of the 2 goldens, input seeds 1 to 8, hard and soft, are all at or above NEAR', () => {
  // the Free Play golden through the real verifier; the passA recording agrees with it there
  const fw = Array.from(decode(FREE.replay).words);
  assert.deepEqual(passA(FREE.seed, FREE.mode, fw).sig, sigOf(FREE.replay, FREE.seed).sig, 'passA records what the verifier records');
  let n = 0, worst = 1;
  for (const g of GOLDENS.slice(0, 2)) { // free play seed 1 and daily LEAN seed 4, as in the slowed attacker test
    const words = Array.from(decode(g.replay).words), pl = placements(g.seed, g.mode, words);
    const free = g.mode === 'arcade';
    const base = free ? sigOf(g.replay, g.seed) : passA(g.seed, g.mode, words);
    assert.equal(base.score, g.score, `${g.name}: re-sim score`);
    for (let inSeed = 1; inSeed <= 8; inSeed++) for (const soft of [false, true]) {
      const copy = fastCopy(g.seed, g.mode, pl, inSeed, soft);
      const c = free ? sigOf(copy, g.seed) : passA(g.seed, g.mode, Array.from(decode(copy).words));
      const x = similarity(base.sig, c.sig);
      assert.ok(x >= NEAR, `${g.name} input seed ${inSeed} ${soft ? 'soft' : 'hard'}: similarity ${x}, score ${c.score} of ${g.score}`);
      n++; if (x < worst) worst = x;
    }
  }
  assert.equal(n, 32);
  if (process.env.W69B_PRINT) console.log('fast copier worst similarity', worst);
  assert.ok(worst >= NEAR, `worst ${worst}`);
});

test('M3: through worker.fetch, a fast copy of a stored Free Play golden is held (202), not stored', async () => {
  const W = createWorker(), env = await makeEnv();
  const body = (o) => ({ game: GAME_ID, playerId: o.pid, name: o.name, score: o.score, replay: o.replay, seed: FREE.seed, mode: 'free', version: GAME_VERSION });
  const first = await post(W, env, body({ pid: 'w69b-0001', name: 'ACE', score: FREE.score, replay: FREE.replay }), { ip: '198.51.100.11' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const words = Array.from(decode(FREE.replay).words);
  const copy = fastCopy(FREE.seed, FREE.mode, placements(FREE.seed, FREE.mode, words), 2, false);
  const c = sigOf(copy, FREE.seed);
  const r = await post(W, env, body({ pid: 'w69b-0002', name: 'CPY', score: c.score, replay: copy }), { ip: '198.51.100.12' });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.code, 'held_for_review');
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM flagged WHERE status = 'flagged'").get().n, 1, 'the copy is held for review');
});
