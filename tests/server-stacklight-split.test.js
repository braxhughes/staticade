// STACKLIGHT split mirrors. From any moment where the board's occupied cells are left-right
// symmetric and no piece is in play, swapping LEFT and RIGHT in every later word plays the exact mirror of the rest of
// the run, with the same score. A copier can do that once or several times in one run. The whole-run plain and
// mirrored compares each see only part of such a copy, so it got under NEAR and went on the board (201).
// Pass A now records each placement in canonical left-right form (server/games.js makeStacklightCanon): after every
// symmetric board, the first lock off the centre column decides the side, so a run and any such mirror of it record
// the same signature. Checked on review 3's own cases, through server/verify.js and the dev server's real /submit.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decode, encode } from '../engine/replay.js';
import { createSim, PH_PLAY } from '../games/stacklight/sim.js';
import { GAME_ID, GAME_VERSION, COLS, TOTAL_ROWS, CELLS, SPAWN_COL } from '../games/stacklight/defs.js';
import { makeServerVerifier } from '../server/verify.js';
import { GAMES, boardSymmetric, makeStacklightCanon } from '../server/games.js';
import { similarity, signatureRecorder, placeCode, mirrorPlace, NEAR } from '../server/dedupe.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SL = GAMES.stacklight;

// the honest bot of tools/replay-proof.mjs (botSource), loaded the way its --likeness loads it in Node
const BOT = await (async () => {
  const t = fs.readFileSync(fileURLToPath(new URL('../tools/replay-proof.mjs', import.meta.url)), 'utf8');
  const a = t.indexOf('function botSource(base) {'), b = t.indexOf('\nfunction slPage');
  assert.ok(a >= 0 && b > a, 'tools/replay-proof.mjs still has botSource');
  const botSource = new Function(t.slice(a, b) + '\nreturn botSource;')();
  return import('data:text/javascript,' + encodeURIComponent(botSource(pathToFileURL(ROOT).href)));
})();

const wordsOf = (replay) => Array.from(decode(replay).words);
const withWords = (replay, words) => encode(decode(replay), words);
const mirrorWord = (w) => (w & ~27) | ((w & 1) << 1) | ((w & 2) >> 1) | ((w & 8) << 1) | ((w & 16) >> 1);
// mirrored from the 1st switch frame to the 2nd, plain to the 3rd, and so on
const switched = (words, sw) => words.map((x, i) => (sw.filter((f) => i >= f).length & 1 ? mirrorWord(x) : x));
const insertIdle = (words, at, k) => words.slice(0, at).concat(new Array(k).fill(0), words.slice(at));
const V = makeServerVerifier();
const verify = (replay, seed, mode = 'free') => V({ game: GAME_ID, replay, seed, mode, version: GAME_VERSION });
// the signature as played (the earlier rule: sigValue with no canonical form)
function asPlayed(seed, mode, words) {
  const sim = createSim({ seed, mode }), rec = signatureRecorder();
  for (let i = 0; i < words.length && !sim.done; i++) { const b = sim.score; sim.step(words[i]); sim.clearEvents(); rec.add(SL.sigKey(sim), b, sim.score, SL.sigValue(sim)); }
  return rec.sig;
}
// the real symmetric moments of a run (review 3 symscan.mjs): no piece in play, no LEFT or RIGHT held or charging, the
// board symmetric; one per scoring event, after the first event
function symMoments(seed, mode, words) {
  const sim = createSim({ seed, mode }), out = [];
  let ev = 0, lastEv = -1;
  for (let i = 0; i < words.length && !sim.done; i++) {
    const S = sim.ctx;
    if (ev > 0 && ev !== lastEv && S.phase !== PH_PLAY && S.arDir === 0 && (S.prev & 27) === 0 && (words[i] & 27) === 0 && boardSymmetric(sim.grid)) { lastEv = ev; out.push(i); }
    const b = sim.score; sim.step(words[i]); sim.clearEvents(); if (sim.score !== b) ev++;
  }
  return out;
}

// Five exact-score escapes: [seed, bot input seed, split frame, original score]
// GAME_VERSION 2.0 (no lock resets): the bot plays other runs on 2.0, and the 1.0 runs no longer have these
// escapes (1.0: [1, 11, 9826, 62855], [1, 13, 10814, 57230], [1, 14, 5990, 23590], [424242, 15, 6042, 9735],
// [7, 17, 7652, 42445]). Five 2.0 escapes of the same kind, found by scanning the same bot (seed 1 input seeds 1 to 60,
// seeds 7 and 424242 input seeds 1 to 40, seeds 2 to 42 input seeds 1 to 8) for every split frame where the copy keeps the
// exact score and, as played, is under NEAR. The scan found 7 such runs; these 5 are the ones with the highest scores.
// Since the lock timer no longer pauses in the air, the same scan re-run finds the same 7 runs with the same
// scores; two split frames moved (seed 41 run 2: 7458 to 7438; seed 13 run 4: 5148 to 5126).
// GAME_VERSION 3.0 (instant lock, D119): the 2.0 escapes ([1, 11, 9823, 58040], [41, 2, 7438, 103610],
// [33, 7, 4852, 22810], [13, 4, 5126, 18725], [35, 1, 5429, 34860]) are other runs on 3.0. The same scan (same bot, same
// seed and input seed ranges) on 3.0 finds 14 escape frames in 12 runs; these 5 are the runs with the highest scores
// (first escape frame of each), except seed 37 run 6 (58640, split at 9961): its split copy plus 10 idle frames at
// frame 2 tops out earlier (the shift moves every lock on 3.0), so the split + shift test would not see the same run.
// The scan is docs/w69/scan-split.mjs.
const ESCAPES = [[31, 8, 11428, 78540], [424242, 37, 8813, 51805], [424242, 39, 8595, 33785], [32, 5, 4712, 30215], [22, 5, 10428, 26755]];
// a run with three symmetric moments whose 3-switch copy got under NEAR as played (1.0: seed 1 run 14; 2.0: seed 41
// run 2; 3.0: the scan found seed 1 run 14 and seed 22 run 5; seed 22 run 5 is already in ESCAPES, so this one)
const THREE = [1, 14];

test('review 3 H1: the five split-mirror copies keep the exact score and are now 1.0 alike (held); as played they were under NEAR', () => {
  for (const [seed, inSeed, f, score] of ESCAPES) {
    const r = BOT.playBot(seed, 'arcade', inSeed), w = wordsOf(r.replay);
    assert.equal(r.score, score, `bot seed ${seed} run ${inSeed} is the review's run`);
    assert.ok(symMoments(seed, 'arcade', w).includes(f), `frame ${f} is a symmetric moment`);
    const copy = withWords(r.replay, switched(w, [f]));
    const a = verify(r.replay, seed), c = verify(copy, seed);
    assert.equal(c.score, a.score, 'the split mirror keeps the exact score');
    const before = similarity(asPlayed(seed, 'arcade', w), asPlayed(seed, 'arcade', switched(w, [f])));
    assert.ok(before < NEAR, `as played (w48c) it got through: ${before}`);
    assert.equal(similarity(a.sig, c.sig), 1, `seed ${seed} run ${inSeed} split at ${f}`);
    assert.equal(similarity(c.sig, a.sig), 1, 'either way round');
  }
});

test('split mirror plus 10 idle frames, and plus a late flip that keeps the score, are held', () => {
  for (const [seed, inSeed, f] of ESCAPES) {
    const r = BOT.playBot(seed, 'arcade', inSeed), w = wordsOf(r.replay), a = verify(r.replay, seed);
    const shifted = withWords(r.replay, insertIdle(switched(w, [f]), 2, 10)), s = verify(shifted, seed);
    assert.equal(s.score, a.score);
    assert.equal(similarity(a.sig, s.sig), 1, `seed ${seed} run ${inSeed}: split + shift`);
    // a hard-drop bit flipped late in the copy: if the run still ends, its score and likeness are checked
    const late = switched(w, [f]); const k = Math.floor(f + (late.length - f) * 0.7); late[k] ^= 32;
    let fl = null; try { fl = verify(withWords(r.replay, late), seed); } catch { /* the edit broke the run: the server refuses it anyway */ }
    if (fl && fl.score >= 0.9 * a.score) assert.ok(similarity(a.sig, fl.sig) >= NEAR, `seed ${seed} run ${inSeed}: split + late flip ${similarity(a.sig, fl.sig)}`);
  }
});

test('three switches at three symmetric moments (and a switch at every one) keep the exact score and are held', () => {
  const [seed, inSeed] = THREE;
  const r = BOT.playBot(seed, 'arcade', inSeed), w = wordsOf(r.replay), at = symMoments(seed, 'arcade', w), a = verify(r.replay, seed);
  assert.ok(at.length >= 3, `seed ${seed} run ${inSeed} has ${at.length} symmetric moments`);
  for (const sw of [at.slice(0, 3), at, [at[0], at[at.length - 1]]]) {
    const c = verify(withWords(r.replay, switched(w, sw)), seed);
    assert.equal(c.score, a.score, `switches at ${sw}: exact score`);
    assert.equal(similarity(a.sig, c.sig), 1, `switches at ${sw}`);
  }
  const three = switched(w, at.slice(0, 3));
  assert.ok(similarity(asPlayed(seed, 'arcade', w), asPlayed(seed, 'arcade', three)) < NEAR, 'as played (w48c) the 3-switch copy got through');
});

test('whole-run mirror copies stay held at 1.0', () => {
  for (const [seed, inSeed] of ESCAPES) {
    const r = BOT.playBot(seed, 'arcade', inSeed), a = verify(r.replay, seed);
    const c = verify(withWords(r.replay, wordsOf(r.replay).map(mirrorWord)), seed);
    assert.equal(c.score, a.score);
    assert.equal(similarity(a.sig, c.sig), 1);
  }
});

test('honest same-seed bot runs, Free Play and Daily, including runs that pass symmetric boards, are not alike', () => {
  for (const [seed, mode, claim] of [[1, 'arcade', 'free'], [7, 'arcade', 'free'], [2, 'daily', 'daily']]) {
    const sigs = [];
    let withMoments = 0;
    for (let i = 1; i <= 32; i++) { // 32 runs on 2.0 (24 on 1.0): Daily seed 2 needs 32 to have 5 that pass a symmetric board
      const r = BOT.playBot(seed, mode, i), w = wordsOf(r.replay);
      if (symMoments(seed, mode, w).length) withMoments++;
      // a Daily run is re-simmed as pass A records it (no dayKey for these old seeds): the registry's own functions
      const sim = createSim({ seed, mode }), rec = signatureRecorder(), canon = SL.sigCanon(sim);
      for (let k = 0; k < w.length && !sim.done; k++) { const b = sim.score; sim.step(w[k]); sim.clearEvents(); rec.add(SL.sigKey(sim), b, sim.score, canon(sim, SL.sigValue(sim))); }
      if (claim === 'free') assert.deepEqual(rec.sig, verify(r.replay, seed).sig, 'recorded as pass A does');
      sigs.push(rec.sig);
    }
    assert.ok(withMoments >= 5, `${seed} ${mode}: ${withMoments} runs pass a symmetric board`);
    for (let i = 0; i < sigs.length; i++) for (let j = i + 1; j < sigs.length; j++) {
      const x = similarity(sigs[i], sigs[j]);
      assert.ok(x < 0.3, `${seed} ${mode} runs ${i + 1} and ${j + 1}: ${x}`);
    }
  }
});

// ---------- the canonical form, piece by piece ----------
test('boardSymmetric: occupancy mirrored about the centre column, every row, every column pair', () => {
  const g = new Uint8Array(CELLS);
  assert.equal(boardSymmetric(g), true, 'empty');
  for (let r = 0; r < TOTAL_ROWS; r++) for (let c = 0; c < COLS; c++) {
    g.fill(0); g[r * COLS + c] = 1;
    assert.equal(boardSymmetric(g), c === SPAWN_COL, `one cell at row ${r}, column ${c}`);
    g[r * COLS + COLS - 1 - c] = 2; // the other side, another colour: colour does not count
    assert.equal(boardSymmetric(g), true, `cells at row ${r}, columns ${c} and ${COLS - 1 - c}`);
    if (c !== SPAWN_COL && c + 1 < COLS && COLS - 2 - c !== c) { g.fill(0); g[r * COLS + c] = 1; g[r * COLS + COLS - 2 - c] = 1; assert.equal(boardSymmetric(g), false, `row ${r}: ${c} with ${COLS - 2 - c} is one column off`); }
  }
});

test('the first lock off the centre after a symmetric board decides the side: right is recorded mirrored, left as played', () => {
  // golden-free bot run: the canonical signature is the as-played one with every segment's deciding lock on the left
  for (const [seed, inSeed] of ESCAPES) {
    const r = BOT.playBot(seed, 'arcade', inSeed), w = wordsOf(r.replay);
    const sim = createSim({ seed, mode: 'arcade' }), canon = makeStacklightCanon(sim);
    let free = true, deciding = 0, prevType = 0, prevSpawned = 0;
    for (let k = 0; k < w.length && !sim.done; k++) {
      sim.step(w[k]); sim.clearEvents();
      const S = sim.ctx, v = SL.sigValue(sim), out = canon(sim, v);
      const locked = S.pType === 0 && (prevType !== 0 || S.spawned !== prevSpawned);
      prevType = S.pType; prevSpawned = S.spawned;
      if (!locked) continue;
      if (free && S.px !== SPAWN_COL) {
        deciding++;
        assert.equal(out, S.px > SPAWN_COL ? mirrorPlace(v) : v, `deciding lock at column ${S.px}`);
        assert.equal(out, placeCode(S.py, Math.min(S.px, COLS - 1 - S.px), S.rot), 'recorded on the left side');
        free = false;
      }
      if (boardSymmetric(sim.grid)) free = true;
    }
    assert.ok(deciding >= 2, `seed ${seed} run ${inSeed}: ${deciding} deciding locks (the start and the split)`);
  }
});

// a stand-in sim with only what the canonical form reads: the grid (made symmetric or not by hand) and ctx
function fakeSim(symmetricStart) {
  const sim = { grid: new Uint8Array(CELLS), ctx: { pType: 0, spawned: 0, px: SPAWN_COL, py: 18, rot: 0 } };
  if (!symmetricStart) sim.grid[0] = 4; // one ridge cell in column 0
  const canon = makeStacklightCanon(sim);
  const setBoard = (sym, col) => { sim.grid.fill(0); sim.grid[col] = 1; if (sym) sim.grid[COLS - 1 - col] = 1; };
  return {
    sim,
    spawn() { sim.ctx.pType = 1; sim.ctx.spawned++; sim.ctx.px = SPAWN_COL; return canon(sim, placeCode(18, SPAWN_COL, 0)); },
    // the piece locks at column col; the board after it is symmetric or not
    lock(col, sym, row = 0) { sim.ctx.pType = 0; sim.ctx.px = col; sim.ctx.py = row; setBoard(sym, col); return canon(sim, placeCode(row, col, 0)); },
    // spawn and lock in one step (a hard drop on the spawn frame)
    spawnLock(col, sym) { sim.ctx.pType = 0; sim.ctx.spawned++; sim.ctx.px = col; setBoard(sym, col); return canon(sim, placeCode(0, col, 0)); },
  };
}
const at = (col) => placeCode(0, col, 0);

test('canonical form on a stand-in sim: the side is decided after every symmetric board, by the first lock off the centre', () => {
  for (let c = 0; c < COLS; c++) {
    if (c === SPAWN_COL) continue;
    const f = fakeSim(true), left = Math.min(c, COLS - 1 - c);
    f.spawn();
    assert.equal(f.lock(c, false), at(left), `deciding lock at ${c} is recorded at ${left}`);
    f.spawn();
    assert.equal(f.lock(3, false), at(c > SPAWN_COL ? 5 : 3), `after deciding at ${c}, column 3 follows the same flip`);
    f.spawn();
    assert.equal(f.lock(5, true), at(c > SPAWN_COL ? 3 : 5), 'this lock leaves the board symmetric: still the old flip');
    // a new free mark: column 3 now decides on its own (left, as played), whatever the old flip was
    f.spawn();
    assert.equal(f.lock(3, false), at(3), `after the reset, the old flip (${c > SPAWN_COL ? 1 : 0}) is gone`);
    f.spawn();
    assert.equal(f.lock(6, false), at(6), 'and stays until the next symmetric board');
    f.spawn();
    assert.equal(f.lock(2, true), at(2));
    f.spawn();
    assert.equal(f.lock(7, false), at(1), 'next mark: column 7 decides, recorded mirrored');
  }
});

test('canonical form: a lock in the same step as its spawn counts; centre locks never decide; an asymmetric start is as played', () => {
  const f = fakeSim(true);
  f.spawn(); assert.equal(f.lock(SPAWN_COL, true), at(SPAWN_COL), 'centre lock on a symmetric board');
  assert.equal(f.spawnLock(7, false), at(1), 'spawn and lock in one step, column 7: decides, mirrored');
  f.spawn(); assert.equal(f.lock(2, false), at(6), 'flip 1 holds');
  assert.equal(f.spawnLock(6, true), at(2), 'spawn and lock leaving a symmetric board: a new mark');
  f.spawn(); assert.equal(f.lock(3, false), at(3), 'decided anew by column 3');
  const d = fakeSim(false);
  d.spawn(); assert.equal(d.lock(7, false), at(7), 'asymmetric start (a Daily ridge): as played');
  d.spawn(); assert.equal(d.lock(1, true), at(1));
  d.spawn(); assert.equal(d.lock(8, false), at(0), 'after the first symmetric board, the side is decided');
});

test('a Daily run starts on an asymmetric ridge, so its placements are recorded as played until a symmetric board', () => {
  const r = BOT.playBot(4, 'daily', 1), w = wordsOf(r.replay), sim = createSim({ seed: 4, mode: 'daily' });
  assert.equal(boardSymmetric(sim.grid), false);
  const canon = makeStacklightCanon(sim);
  for (let k = 0; k < w.length && !sim.done && k < 3000; k++) { sim.step(w[k]); sim.clearEvents(); const v = SL.sigValue(sim); assert.equal(canon(sim, v), v, `frame ${k}`); }
});

test('review 3 L3: a placement signature is compared mirrored only with another placement signature', () => {
  // findNearRun compares only rows of one game (server/d1-adapter.js), so this is defence in depth: a list whose
  // first value is positive (a Starfall event) is never read as placements, even if later values look like them
  const a = [], b = [];
  // columns 0 to 3 only: never the centre column, whose mirror is itself
  for (let i = 0; i < 20; i++) { const v = placeCode(i % 18, i % 4, i & 1); a.push(5 * i, v); b.push(5 * i, i === 0 ? 100 : mirrorPlace(v)); }
  assert.equal(similarity(a, b), 0, 'b is not a placement signature: plain compare only');
  assert.equal(similarity(b, a), 0);
  const b2 = b.slice(); b2[1] = mirrorPlace(a[1]);
  assert.equal(similarity(a, b2), 1, 'with b a placement signature the mirror compare finds it');
});

test('Starfall has no canonical form: its registry entry and pass A path are unchanged', () => {
  assert.equal(GAMES.starfall.sigCanon, undefined);
  assert.equal(GAMES.starfall.sigValue, null);
  assert.equal(SL.sigCanon, makeStacklightCanon);
});

// ---------- the real entry point ----------
let dev = null, base = '';
async function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
after(() => { if (dev) dev.kill(); });
const http = async (path, body) => {
  const r = await fetch(base + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return { status: r.status, body: await r.json() };
};
let N = 0;
const body = (o) => ({ game: GAME_ID, playerId: `w48d-${String(++N).padStart(4, '0')}`, name: o.name, score: o.score, replay: o.replay, seed: o.seed, mode: 'free', version: GAME_VERSION });

test('dev server HTTP: review 3\'s split mirror (3.0: the first ESCAPES run from its split frame), a 3-switch copy are held (202) and a 2-switch copy is an exact duplicate (409), never 201; the board keeps the originals only', async () => {
  const port = await freePort();
  dev = spawn(process.execPath, ['server/dev-server.mjs', String(port)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DAILY_SECRET: '', ADMIN_TOKEN: '' } });
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('dev server did not start')), 15000);
    dev.stdout.on('data', (b) => { if (String(b).includes('leaderboard dev server on')) { clearTimeout(to); res(); } });
    dev.on('exit', (code) => rej(new Error('dev server exited ' + code)));
  });
  base = `http://127.0.0.1:${port}`;
  const want = [];
  // an even number of switches ends plain on the original's own final board (same hash): the exact check takes it (409)
  const copiesOf = { ORG: (at) => [['SPL', [ESCAPES[0][2]], 202], ['SPT', at.slice(0, 2), 409]], ORH: (at) => [['SPH', at.slice(0, 3), 202]] };
  for (const [seed, inSeed, name] of [[ESCAPES[0][0], ESCAPES[0][1], 'ORG'], [THREE[0], THREE[1], 'ORH']]) {
    const r = BOT.playBot(seed, 'arcade', inSeed);
    const first = await http('/submit', body({ name, seed, score: r.score, replay: r.replay }));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    want.push([name, r.score]);
    const fetched = (await http(`/replay/${first.body.id}`)).body.replay, w = wordsOf(fetched), at = symMoments(seed, 'arcade', w);
    for (const [who, sw, status] of copiesOf[name](at)) {
      assert.ok(sw.length >= 1 && sw.every((f) => at.includes(f)), `${who}: switches at symmetric moments ${sw}`);
      const res = await http('/submit', body({ name: who, seed, score: r.score, replay: withWords(fetched, switched(w, sw)) }));
      assert.equal(res.status, status, `${who} (switches at ${sw}): ${JSON.stringify(res.body)}`);
      if (status === 202) {
        assert.equal(res.body.code, 'held_for_review');
        assert.equal(res.body.score, r.score, `${who} kept the exact score`);
      } else assert.equal(res.body.error, 'duplicate_result');
    }
  }
  assert.equal(want.length, 2);
  const board = await http('/board?game=stacklight&board=all&unique=false');
  assert.deepEqual(board.body.rows.map((x) => [x.name, x.score]), want.sort((a, b) => b[1] - a[1]));
});
