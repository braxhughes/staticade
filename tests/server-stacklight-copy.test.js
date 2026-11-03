// STACKLIGHT's near-copy check survives time shifts. A STACKLIGHT signature event is the piece
// that scored and where it locked (server/games.js sigKey and sigValue, server/dedupe.js pieceKey and placeCode), not
// the frame, so idle frames inserted into someone else's run, or the same placements played on a new timing, are held.
// Starfall's signature ([frame, points]) and similarity are unchanged: compared with values computed at 9fd4dcb.
// Through the Worker's real entry point (worker.fetch on node:sqlite) and the dev server's real /submit route.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decode, encode } from '../engine/replay.js';
import { dailySeed, Rng, seedFromString } from '../engine/rng.js';
import { createSim, PH_PLAY } from '../games/stacklight/sim.js';
import { GAME_ID, GAME_VERSION, COLS, BAR, PLUS, ROT_H, ROT_V, INPUT_MASK } from '../games/stacklight/defs.js';
import { columnHeight } from '../games/stacklight/sim/board.js';
import { GAME_ID as SF_ID, GAME_VERSION as SF_VERSION } from '../games/starfall/sim.js';
import { todayUTC } from '../games/starfall/modes.js';
import { makeServerVerifier } from '../server/verify.js';
import { GAMES, makeStacklightVerify } from '../server/games.js';
import { similarity, signatureRecorder, pieceKey, PIECE_STEP, TOL, NEAR } from '../server/dedupe.js';
import { record, playScripted, makeEnv, post, get, createWorker } from '../server/fixtures.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ---------- the golden runs, read from the golden test (never copied here) ----------
const GOLDENS = (() => {
  const src = fs.readFileSync(fileURLToPath(new URL('./stacklight-golden.test.js', import.meta.url)), 'utf8');
  const re = /name: '([^']+)', seed: (\d+), mode: '(\w+)'.*?score: (\d+).*?r1: '([^']+)'/gs;
  return [...src.matchAll(re)].map((m) => ({ name: m[1], seed: +m[2], mode: m[3], score: +m[4], replay: m[5] }));
})();
const FREE = () => GOLDENS.find((g) => g.mode === 'arcade');

// pass A's signature, recorded exactly as server/verify.js does it: the registry's sigKey and sigValue
const SL = GAMES.stacklight;
function resim(seed, mode, words) {
  const sim = createSim({ seed, mode }), rec = signatureRecorder();
  let i = 0;
  for (; i < words.length && !sim.done; i++) { const b = sim.score; sim.step(words[i]); sim.clearEvents(); rec.add(SL.sigKey(sim), b, sim.score, SL.sigValue(sim)); }
  return { done: sim.done && i === words.length, score: sim.score, hash: sim.stateHash(), sig: rec.sig };
}
const wordsOf = (replay) => Array.from(decode(replay).words);
const withWords = (replay, words) => encode(decode(replay), words);
const insertIdle = (words, at, k) => words.slice(0, at).concat(new Array(k).fill(0), words.slice(at));
// the first frame at or after `from` with the piece in play and no key down on this frame or the one before
function quietAt(seed, mode, words, from) {
  const sim = createSim({ seed, mode });
  for (let i = 0; i < words.length; i++) {
    if (i >= from && sim.ctx.phase === PH_PLAY && words[i] === 0 && (i === 0 || words[i - 1] === 0)) return i;
    sim.step(words[i]); sim.clearEvents();
  }
  return -1;
}
// where each piece of a run locked, then the same placements on a new timing (think frames, taps, a hard drop or soft
// drop held all the way): the copier's bot
function placements(seed, mode, words) {
  const sim = createSim({ seed, mode }), pl = [];
  let locked = 0;
  for (let i = 0; i < words.length && !sim.done; i++) {
    sim.step(words[i]); sim.clearEvents();
    if (sim.ctx.pType === 0 && sim.ctx.phase !== PH_PLAY && locked !== sim.ctx.spawned) { locked = sim.ctx.spawned; pl.push([sim.ctx.px, sim.ctx.rot]); }
  }
  return pl;
}
function retimed(seed, mode, pl, inSeed, soft) {
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
  return Array.from(decode(sim.replay()).words);
}

// an honest word bot: best placement on the column heights plus a little noise from its own input seed
function playBot(seed, mode, inSeed) {
  const sim = createSim({ seed, mode }), rng = new Rng(seedFromString('w48b-honest:' + inSeed));
  let plan = null, planned = -1, prev = 0, idle = 0, lastPx = -1;
  while (!sim.done) {
    const S = sim.ctx; let w = 0;
    if (S.phase === PH_PLAY) {
      if (S.spawned !== planned) {
        planned = S.spawned; idle = 0; lastPx = S.px;
        const h = []; for (let c = 0; c < COLS; c++) h.push(columnHeight(sim.grid, c));
        const cands = [];
        const add = (rot, col, adds) => {
          const n = h.slice();
          if (adds.length === 1) n[col] += 3; else { n[col - 1] += adds[0]; n[col] += adds[1]; n[col + 1] += adds[2]; }
          const lines = Math.min(...n), mx = Math.max(...n) - lines;
          let bump = 0; for (let c = 1; c < COLS; c++) bump += Math.abs(n[c] - n[c - 1]);
          cands.push({ rot, col, v: lines * 20 - mx * 4 - bump + rng.int(5) });
        };
        if (S.pType === BAR) { for (let c = 1; c < COLS - 1; c++) add(ROT_H, c, [1, 1, 1]); for (let c = 0; c < COLS; c++) add(ROT_V, c, [3]); }
        else for (let c = 1; c < COLS - 1; c++) add(ROT_H, c, [1, 3, 1]);
        plan = cands[0]; for (const k of cands) if (k.v > plan.v) plan = k;
        if (rng.int(10) === 0) plan = cands[rng.int(cands.length)]; // a mistake now and then, so runs end
      }
      if (S.pType !== PLUS && S.rot !== plan.rot && idle < 3) { w = prev & 64 ? 0 : 64; idle++; }
      else if (S.px !== plan.col && idle < 40) { if (S.px !== lastPx) lastPx = S.px; else idle++; const p = S.px > plan.col ? 9 : 18; w = prev & (p & 24) ? 0 : p; }
      else w = prev & 32 ? 0 : 32;
    }
    sim.step(w); sim.clearEvents(); prev = w;
  }
  return { replay: sim.replay(), score: sim.score };
}

let N = 0;
const pid = () => `w48b-${String(++N).padStart(4, '0')}`;
const ipN = () => `198.51.100.${(N % 250) + 1}`;
const slBody = (o) => ({ game: GAME_ID, playerId: pid(), name: o.player || 'ACE', score: o.score, replay: o.replay, seed: o.seed, mode: o.mode || 'free', version: GAME_VERSION, ...(o.dayKey ? { dayKey: o.dayKey } : {}) });

// ---------- the signature key ----------
test('STACKLIGHT signature: one event per scoring piece, keyed by pieceKey(piece), valued by where it locked; Starfall keeps frame and points', () => {
  assert.equal(GAMES.starfall.sigValue, null, 'Starfall records points');
  const g = FREE(), v = makeServerVerifier()({ game: GAME_ID, replay: g.replay, seed: g.seed, mode: 'free', version: GAME_VERSION });
  const sig = v.sig, keys = [];
  for (let i = 0; i < sig.length; i += 2) keys.push(sig[i]);
  assert.ok(keys.every((k) => k % PIECE_STEP === 0), 'every key is a piece key');
  assert.ok(keys.every((k, i) => i === 0 || k > keys[i - 1]), 'one event per piece, increasing');
  assert.ok(keys[keys.length - 1] / PIECE_STEP <= 400, 'keys count pieces, not frames (the run is 9,444 frames)');
  assert.deepEqual(sig, resim(g.seed, g.mode, wordsOf(g.replay)).sig, 'this file records the signature as pass A does');
});

test('piece tolerance is 0: the same events one piece later do not match at all', () => {
  assert.ok(pieceKey(1) - pieceKey(0) > TOL, 'adjacent pieces are further apart than TOL');
  const sig = resim(FREE().seed, 'arcade', wordsOf(FREE().replay)).sig;
  const later = sig.map((x, i) => (i % 2 === 0 ? x + pieceKey(1) : x));
  assert.equal(similarity(sig, sig), 1);
  assert.equal(similarity(sig, later), 0);
});

// ---------- the time-shift attack ----------
test('time-shifted copies of all 3 golden runs (5 to 300 idle frames, at frame 2 and at the first quiet frame) are held when they keep the score', () => {
  let keptScore = 0;
  for (const g of GOLDENS) {
    const w = wordsOf(g.replay), base = resim(g.seed, g.mode, w);
    assert.equal(base.score, g.score);
    for (const at of [2, 3, quietAt(g.seed, g.mode, w, 2)]) {
      for (const k of [5, 10, 30, 60, 300]) {
        const c = resim(g.seed, g.mode, insertIdle(w, at, k));
        const x = similarity(base.sig, c.sig);
        if (c.score >= 0.9 * g.score) { keptScore++; assert.ok(x >= NEAR, `${g.name} +${k} at ${at}: score ${c.score}, similarity ${x}`); }
        else assert.ok(c.score < 0.9 * g.score); // played out as a different, weaker run
      }
    }
  }
  assert.ok(keptScore >= 30, `the attack's premise: most shifts keep the score (${keptScore} of 45)`);
});

test('time-shifted copies mid-run (between locks): every copy that keeps 90% of the score is held', () => {
  let kept = 0;
  for (const g of GOLDENS) {
    const w = wordsOf(g.replay), base = resim(g.seed, g.mode, w);
    for (const p of [0.25, 0.5, 0.75]) {
      const at = quietAt(g.seed, g.mode, w, Math.floor(w.length * p));
      for (const k of [5, 10, 30, 60, 300]) {
        const c = resim(g.seed, g.mode, insertIdle(w, at, k));
        if (c.score >= 0.9 * g.score) { kept++; assert.ok(similarity(base.sig, c.sig) >= NEAR, `${g.name} +${k} at ${at}`); }
      }
    }
  }
  assert.ok(kept >= 5, `some mid-run shifts keep the score (${kept})`);
});

test('the same placements on a new timing (hard drop or soft drop held) are held, even when GLOW changes the score', () => {
  let between = 0;
  for (const g of GOLDENS.slice(0, 2)) { // free play seed 1, daily LEAN seed 4: the copier's bot reaches their placements
    const w = wordsOf(g.replay), base = resim(g.seed, g.mode, w), pl = placements(g.seed, g.mode, w);
    for (const soft of [false, true]) {
      // input seed 2 (2.0 goldens, D113): with seed 1 every 2.0 copy came out at 0.97 or more, so none showed NEAR at work
      const c = resim(g.seed, g.mode, retimed(g.seed, g.mode, pl, 2, soft)), x = similarity(base.sig, c.sig);
      assert.ok(c.done, `${g.name}: a finished run`);
      assert.ok(x >= NEAR, `${g.name} ${soft ? 'soft' : 'hard'}: similarity ${x}, score ${c.score} of ${g.score}`);
      if (x < 0.95) between++;
    }
  }
  assert.ok(between >= 1, 'at least one held copy sits between NEAR and 0.95 (so NEAR is what holds it)');
  assert.equal(NEAR, 0.6, 'NEAR stays 0.6 for both games');
});

test('a time shift plus a one-bit flip late in the run is still held', () => {
  const g = FREE(), w = wordsOf(g.replay), base = resim(g.seed, g.mode, w);
  const e = insertIdle(w, 2, 10);
  e[Math.floor(e.length * 0.8)] ^= 32;
  const c = resim(g.seed, g.mode, e);
  assert.ok(similarity(base.sig, c.sig) >= NEAR, `similarity ${similarity(base.sig, c.sig)}`);
});

// ---------- honest runs ----------
test('honest bot runs on one seed are not alike, and all of them are taken through worker.fetch (201)', async () => {
  const runs = [1, 2, 3, 4, 5, 6].map((i) => ({ ...playBot(1, 'arcade', i), seed: 1 }));
  const v = makeServerVerifier();
  const sigs = runs.map((r) => v({ game: GAME_ID, replay: r.replay, seed: 1, mode: 'free', version: GAME_VERSION }).sig);
  for (let i = 0; i < sigs.length; i++) for (let j = i + 1; j < sigs.length; j++) {
    assert.ok(similarity(sigs[i], sigs[j]) < NEAR, `runs ${i + 1} and ${j + 1}: ${similarity(sigs[i], sigs[j])}`);
  }
  const W = createWorker(), env = await makeEnv();
  for (const r of runs) {
    const res = await post(W, env, slBody(r), { ip: ipN() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
  assert.equal((await get(W, env, '/board?game=stacklight&board=all&unique=false&limit=50')).body.rows.length, runs.length);
});

// ---------- through the Worker and the dev server ----------
test('worker.fetch: a time-shifted copy of a stored Free Play and of a stored Daily run is held (202), not stored', async () => {
  const W = createWorker(), env = await makeEnv();
  const day = todayUTC(), ds = dailySeed(day);
  const daily = { ...playBot(ds, 'daily', 7), seed: ds, mode: 'daily', dayKey: day };
  for (const o of [{ ...FREE(), mode: 'free' }, daily]) {
    const first = await post(W, env, slBody(o), { ip: ipN() });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const fetched = (await get(W, env, `/replay/${first.body.id}`)).body.replay;
    const w = wordsOf(fetched), rmode = o.mode === 'free' ? 'arcade' : 'daily';
    // the copier tries a few shifts and keeps one that plays out to the same score (the review's attack)
    let copy = null;
    for (const at of [2, 3, ...[2, 0.1, 0.25].map((p) => quietAt(o.seed, rmode, w, p < 1 ? Math.floor(w.length * p) : p))]) for (const k of [5, 10, 30, 60]) {
      const e = insertIdle(w, at, k), c = resim(o.seed, rmode, e);
      if (!copy && c.done && c.score === o.score) copy = withWords(fetched, e);
    }
    assert.ok(copy, 'a time shift that keeps the exact score exists');
    const r = await post(W, env, slBody({ ...o, replay: copy, player: 'CPY' }), { ip: ipN() });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.code, 'held_for_review');
    assert.equal(r.body.score, o.score, 'the copy kept the exact score');
  }
  const rows = (await get(W, env, '/board?game=stacklight&board=all&unique=false&limit=50')).body.rows;
  assert.ok(rows.length >= 1 && rows.every((x) => x.name === 'ACE'), JSON.stringify(rows));
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM flagged WHERE status = 'flagged'").get().n, 2, 'both copies held for review');
});

let dev = null, base = '';
async function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function startDev() {
  const port = await freePort();
  dev = spawn(process.execPath, ['server/dev-server.mjs', String(port)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DAILY_SECRET: '', ADMIN_TOKEN: '' } });
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('dev server did not start')), 15000);
    dev.stdout.on('data', (b) => { if (String(b).includes('leaderboard dev server on')) { clearTimeout(to); res(); } });
    dev.on('exit', (code) => rej(new Error('dev server exited ' + code)));
  });
  base = `http://127.0.0.1:${port}`;
}
after(() => { if (dev) dev.kill(); });
const http = async (path, body) => {
  const r = await fetch(base + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return { status: r.status, body: await r.json() };
};

test('dev server HTTP: the review\'s attack (10 and 37 idle frames at frame 2 of the stored golden run) is held (202); the board keeps one row', async () => {
  await startDev();
  const g = { ...FREE(), mode: 'free' };
  const first = await http('/submit', slBody(g));
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const fetched = (await http(`/replay/${first.body.id}`)).body.replay;
  for (const k of [10, 37]) {
    const copy = withWords(fetched, insertIdle(wordsOf(fetched), 2, k));
    assert.notEqual(copy, fetched);
    const r = await http('/submit', slBody({ ...g, replay: copy, player: 'CPY' }));
    assert.equal(r.status, 202, JSON.stringify(r.body));
    assert.equal(r.body.code, 'held_for_review');
    assert.equal(r.body.score, g.score);
  }
  const board = await http('/board?game=stacklight&board=all&unique=false');
  assert.deepEqual(board.body.rows.map((x) => [x.name, x.score]), [['ACE', g.score]]);
});

// ---------- Starfall unchanged (values computed with server/verify.js and server/dedupe.js at 9fd4dcb) ----------
const fnv = (a) => { let h = 0x811c9dc5; for (const x of a) { h ^= x & 0xffff; h = Math.imul(h, 16777619) >>> 0; h ^= x >>> 16; h = Math.imul(h, 16777619) >>> 0; } return h; };
test('Starfall: signatures and similarity are byte-identical to 9fd4dcb on fixed replays', () => {
  const v = makeServerVerifier({ now: () => Date.parse('2026-10-31T12:00:00Z') });
  const V = record('arcade', 2);
  const h = decode(V.replay), w = Uint16Array.from(h.words); w[412] ^= 0x400;
  const runs = { victim: [V.replay, 2], flip412: [encode(h, w), 2], lazyA: [playScripted(4, 126708, 'lazy').replay, 4], lazyB: [playScripted(4, 205898, 'lazy').replay, 4] };
  const out = {};
  for (const [k, [replay, seed]] of Object.entries(runs)) out[k] = v({ game: SF_ID, replay, seed, mode: 'free', version: SF_VERSION });
  const want = {
    victim: { score: 33995, hash: '09123f0e', frames: 4239, n: 164, fnv: 1633393851 },
    flip412: { score: 33995, hash: 'de1dca81', frames: 4239, n: 164, fnv: 1633393851 },
    lazyA: { score: 8510, hash: '072b4369', frames: 4627, n: 80, fnv: 3267860341 },
    lazyB: { score: 8510, hash: 'd7611b4d', frames: 4233, n: 80, fnv: 1178906061 },
  };
  for (const k of Object.keys(want)) {
    const o = out[k];
    assert.deepEqual({ score: o.score, hash: o.hash, frames: o.frames, n: o.sig.length, fnv: fnv(o.sig) }, want[k], k);
  }
  assert.deepEqual(out.victim.sig.slice(0, 12), [211, 120, 239, 120, 410, 90, 428, 180, 446, 180, 555, 500]);
  assert.equal(similarity(out.victim.sig, out.flip412.sig), 1);
  assert.equal(similarity(out.lazyA.sig, out.lazyB.sig), 0.125);
  assert.equal(similarity(out.victim.sig, out.lazyA.sig), 0.012195121951219513);
  // the frame tolerance: Starfall moments up to 4 frames apart are the same moment, 5 apart are not
  const even = []; for (let i = 0; i < 20; i++) even.push(20 * (i + 1), 100);
  const moved = (d) => even.map((x, i) => (i % 2 === 0 ? x + d : x));
  assert.equal(similarity(even, moved(4)), 1);
  assert.equal(similarity(even, moved(-4)), 1);
  assert.equal(similarity(even, moved(5)), 0);
});

// ---------- pass B on its own ----------
test('M1: pass B refuses every reserved bit from its own C.2 literal; defs.js INPUT_MASK is still bits 0 to 6', () => {
  assert.equal(INPUT_MASK, 0x007f, 'C.2: widening INPUT_MASK is a design change, not a code change');
  const g = FREE(), passB = makeStacklightVerify();
  const call = (replay) => passB({ game: GAME_ID, replay, seed: g.seed, mode: 'free', version: GAME_VERSION });
  assert.equal(call(g.replay), g.score);
  for (let bit = 7; bit < 16; bit++) {
    const w = wordsOf(g.replay); w[300] |= 1 << bit;
    assert.ok(Number.isNaN(call(withWords(g.replay, w))), `bit ${bit}`);
  }
});

test('M1 (review B11): pass B on its own refuses a run whose header mode is not the claimed mode', () => {
  const passB = makeStacklightVerify();
  const d = GOLDENS.find((g) => g.mode === 'daily'), f = FREE();
  // a Daily header claimed as Free Play: every other pass B check passes (the game, version, seed, a finished run)
  assert.ok(Number.isNaN(passB({ game: GAME_ID, replay: d.replay, seed: d.seed, mode: 'free', version: GAME_VERSION })));
  // and a Free Play header claimed as a Daily (for the day whose public seed is the run's seed, were there one)
  assert.ok(Number.isNaN(passB({ game: GAME_ID, replay: f.replay, seed: f.seed, mode: 'daily', dayKey: todayUTC(), version: GAME_VERSION })));
  assert.equal(passB({ game: GAME_ID, replay: f.replay, seed: f.seed, mode: 'free', version: GAME_VERSION }), f.score, 'control: the right mode is taken');
});
