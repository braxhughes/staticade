// STACKLIGHT mirror copies. Free Play starts on an empty board, the board is 9 wide with spawn
// on the centre column 4, and every shape is left-right symmetric, so swapping LEFT and RIGHT in every input word of
// someone else's Free Play run plays its mirror image with the exact score. The near-copy check compares a STACKLIGHT
// run with the stored one as it is and mirrored (server/dedupe.js similarity, mirrorPlace) and keeps the larger share.
// It does not fold the column, so two runs that build on opposite sides piece by piece still differ.
// Through the Worker's real entry point (worker.fetch on node:sqlite) and the dev server's real /submit route.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decode, encode } from '../engine/replay.js';
import { Rng, seedFromString } from '../engine/rng.js';
import { createSim, PH_PLAY } from '../games/stacklight/sim.js';
import { GAME_ID, GAME_VERSION, COLS, BAR, PLUS, ROT_H, ROT_V, RIDGES } from '../games/stacklight/defs.js';
import { columnHeight } from '../games/stacklight/sim/board.js';
import { makeServerVerifier } from '../server/verify.js';
import { GAMES } from '../server/games.js';
import { similarity, signatureRecorder, pieceKey, placeCode, mirrorPlace, MIRROR_COL, NEAR } from '../server/dedupe.js';
import { makeEnv, post, get, createWorker } from '../server/fixtures.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// the golden runs, read from the golden test (never copied here)
const GOLDENS = (() => {
  const src = fs.readFileSync(fileURLToPath(new URL('./stacklight-golden.test.js', import.meta.url)), 'utf8');
  const re = /name: '([^']+)', seed: (\d+), mode: '(\w+)'.*?score: (\d+).*?r1: '([^']+)'/gs;
  return [...src.matchAll(re)].map((m) => ({ name: m[1], seed: +m[2], mode: m[3], score: +m[4], replay: m[5] }));
})();
const FREE = () => GOLDENS.find((g) => g.mode === 'arcade');
const SL = GAMES.stacklight;

// pass A's signature, recorded as server/verify.js does it (the registry's sigKey and sigValue). value(sim, n, type),
// if given, replaces sigValue for the n-th scoring event (type: the piece that was last in play)
function resim(seed, mode, words, value) {
  const sim = createSim({ seed, mode }), rec = signatureRecorder();
  let i = 0, n = 0, type = 0;
  for (; i < words.length && !sim.done; i++) {
    if (sim.ctx.pType) type = sim.ctx.pType;
    const b = sim.score; sim.step(words[i]); sim.clearEvents();
    const v = sim.score !== b && value ? value(sim.ctx, n++, type) : SL.sigValue(sim);
    rec.add(SL.sigKey(sim), b, sim.score, v);
  }
  return { done: sim.done && i === words.length, score: sim.score, sig: rec.sig };
}
const wordsOf = (replay) => Array.from(decode(replay).words);
const withWords = (replay, words) => encode(decode(replay), words);
// LEFT (1) and RIGHT (2), and their presses (8, 16), swapped
const mirrorWord = (w) => (w & ~27) | ((w & 1) << 1) | ((w & 2) >> 1) | ((w & 8) << 1) | ((w & 16) >> 1);
const insertIdle = (words, at, k) => words.slice(0, at).concat(new Array(k).fill(0), words.slice(at));

// a greedy word bot (the T6 copy test's rule) that scans columns left to right or right to left, so ties go the other
// way: two honest players with mirror-ish habits
function playBot(seed, mode, inSeed, rightFirst) {
  const sim = createSim({ seed, mode }), rng = new Rng(seedFromString('w48c-mirrorish:' + inSeed));
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
          cands.push({ rot, col, v: lines * 20 - mx * 4 - bump + rng.int(2) });
        };
        const cols = []; for (let c = 0; c < COLS; c++) cols.push(rightFirst ? COLS - 1 - c : c);
        if (S.pType === BAR) { for (const c of cols) if (c > 0 && c < COLS - 1) add(ROT_H, c, [1, 1, 1]); for (const c of cols) add(ROT_V, c, [3]); }
        else for (const c of cols) if (c > 0 && c < COLS - 1) add(ROT_H, c, [1, 3, 1]);
        plan = cands[0]; for (const k of cands) if (k.v > plan.v) plan = k;
        if (rng.int(10) === 0) plan = cands[rng.int(cands.length)];
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
const pid = () => `w48c-${String(++N).padStart(4, '0')}`;
const ipN = () => `198.51.100.${(N % 250) + 1}`;
const slBody = (o) => ({ game: GAME_ID, playerId: pid(), name: o.player || 'ACE', score: o.score, replay: o.replay, seed: o.seed, mode: o.mode || 'free', version: GAME_VERSION });

// ---------- the value: where the piece locked ----------
test('placeCode keeps row, column and orientation apart; mirrorPlace maps column c to 8 - c and nothing else', () => {
  assert.equal(MIRROR_COL, COLS - 1, 'the mirror column is the board\'s last column');
  const seen = new Set();
  for (let r = 0; r < 21; r++) for (let c = 0; c < COLS; c++) for (const o of [ROT_H, ROT_V]) {
    const v = placeCode(r, c, o);
    assert.ok(v < 0, 'a placement is negative (Starfall points are positive)');
    assert.ok(!seen.has(v), `placeCode(${r}, ${c}, ${o}) is not shared`); seen.add(v);
    assert.equal(mirrorPlace(v), placeCode(r, MIRROR_COL - c, o));
    assert.equal(mirrorPlace(mirrorPlace(v)), v);
  }
});

test('L1: the signature value is where the scoring piece locked, orientation included', () => {
  for (const g of GOLDENS) {
    const w = wordsOf(g.replay), base = resim(g.seed, g.mode, w);
    const mine = resim(g.seed, g.mode, w, (S) => placeCode(S.py, S.px, S.rot));
    assert.deepEqual(base.sig, mine.sig, `${g.name}: the value is placeCode(row, column, orientation) of the piece`);
    // the same pivots with every BAR turned the other way is a different run (an orientation-blind key calls it 1.0)
    const turned = resim(g.seed, g.mode, w, (S, n, type) => placeCode(S.py, S.px, type === BAR ? 1 - S.rot : S.rot));
    const x = similarity(base.sig, turned.sig);
    assert.ok(x < NEAR, `${g.name}: BARs turned, similarity ${x}`);
  }
});

// ---------- mirror copies ----------
test('mirror copies of all 3 golden runs: Free Play keeps the exact score and is 1.0 alike (held); a Daily mirror plays out as a different run', () => {
  assert.equal(RIDGES.filter((r) => r === [...r].reverse().join('')).length, 0, 'no Daily ridge is a palindrome');
  for (const g of GOLDENS) {
    const w = wordsOf(g.replay), base = resim(g.seed, g.mode, w);
    const m = w.map(mirrorWord), c = resim(g.seed, g.mode, m);
    const at = 2, ms = resim(g.seed, g.mode, insertIdle(m, at, 10));
    const x = similarity(base.sig, c.sig), xs = similarity(base.sig, ms.sig);
    if (g.mode === 'arcade') {
      assert.equal(c.score, g.score, 'the Free Play mirror keeps the exact score');
      assert.equal(x, 1, `mirror: ${x}`);
      assert.equal(ms.score, g.score);
      assert.equal(xs, 1, `mirror plus 10 idle frames: ${xs}`);
    } else {
      // not a copy: the ridge is not symmetric, so the mirror keeps almost nothing
      assert.ok(x >= NEAR || c.score < 0.1 * g.score, `${g.name}: mirror ${x}, score ${c.score}`);
      assert.ok(xs >= NEAR || ms.score < 0.1 * g.score, `${g.name}: mirror + shift ${xs}, score ${ms.score}`);
    }
    // and the compare does not depend on the mode: the Daily run's own placements mirrored are 1.0 alike
    const mirroredSig = base.sig.map((v, i) => (i % 2 ? mirrorPlace(v) : v));
    assert.equal(similarity(base.sig, mirroredSig), 1, `${g.name}: placements mirrored`);
    assert.equal(similarity(mirroredSig, base.sig), 1, `${g.name}: either way round`);
  }
});

test('Starfall signatures are never compared mirrored: points moved the way mirrorPlace would move them do not match', () => {
  // Starfall's [frame, points]: points are positive, so similarity() takes Starfall's one plain path (byte-identical:
  // tests/server-stacklight-copy.test.js). If the mirror compare ran on points, mirrorPlace(100) = 136 would match here.
  const a = [], b = [];
  for (let i = 0; i < 20; i++) { const p = 100 + 20 * (i % 5); a.push(20 * (i + 1), p); b.push(20 * (i + 1), mirrorPlace(p)); }
  assert.ok(b.every((x, i) => i % 2 === 0 || (x > 0 && x !== a[i])), 'every moved value is another positive number');
  assert.equal(similarity(a, b), 0);
  assert.equal(similarity(b, a), 0);
  assert.equal(similarity(a, a), 1);
});

test('column fold is not the fix: the golden runs with every other scoring piece on the other side are not held', () => {
  // a fold (|c - 4|) calls this 1.0. Mirror compare: the plain half or the mirrored half, whichever is larger
  for (const g of GOLDENS) {
    const w = wordsOf(g.replay), base = resim(g.seed, g.mode, w);
    const alt = resim(g.seed, g.mode, w, (S, n) => placeCode(S.py, n % 2 ? MIRROR_COL - S.px : S.px, S.rot));
    const x = similarity(base.sig, alt.sig);
    assert.ok(x < NEAR, `${g.name}: ${x}`);
  }
});

test('honest bots with mirror-ish habits (ties broken left or right) on one seed are not alike, and all are taken (201)', async () => {
  const v = makeServerVerifier();
  const L = [1, 2, 3, 4].map((i) => playBot(1, 'arcade', i, false)), R = [5, 6, 7, 8].map((i) => playBot(1, 'arcade', i, true));
  const sig = (r) => v({ game: GAME_ID, replay: r.replay, seed: 1, mode: 'free', version: GAME_VERSION }).sig;
  const sl = L.map(sig), sr = R.map(sig);
  for (const a of sl) for (const b of sr) assert.ok(similarity(a, b) < NEAR, `left vs right: ${similarity(a, b)}`);
  const W = createWorker(), env = await makeEnv();
  for (const r of [...L, ...R]) {
    const res = await post(W, env, slBody({ ...r, seed: 1 }), { ip: ipN() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
});

test('worker.fetch: the mirror of a stored Free Play bot run is held (202), not stored', async () => {
  const W = createWorker(), env = await makeEnv();
  const o = { ...playBot(424242, 'arcade', 3, false), seed: 424242 };
  const first = await post(W, env, slBody(o), { ip: ipN() });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const fetched = (await get(W, env, `/replay/${first.body.id}`)).body.replay;
  const copy = withWords(fetched, wordsOf(fetched).map(mirrorWord));
  assert.notEqual(copy, fetched);
  const r = await post(W, env, slBody({ ...o, replay: copy, player: 'MIR' }), { ip: ipN() });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.code, 'held_for_review');
  assert.equal(r.body.score, o.score, 'the mirror kept the exact score');
  const rows = (await get(W, env, '/board?game=stacklight&board=all&unique=false&limit=50')).body.rows;
  assert.deepEqual(rows.map((x) => x.name), ['ACE']);
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

test('dev server HTTP: the review\'s mirror copy (and a mirror plus 10 idle frames) of the stored golden run is held (202); the board keeps one row', async () => {
  await startDev();
  const g = { ...FREE(), mode: 'free' };
  const first = await http('/submit', slBody(g));
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const fetched = (await http(`/replay/${first.body.id}`)).body.replay;
  const m = wordsOf(fetched).map(mirrorWord);
  for (const [who, words] of [['MIR', m], ['MIS', insertIdle(m, 2, 10)]]) {
    const copy = withWords(fetched, words);
    const r = await http('/submit', slBody({ ...g, replay: copy, player: who }));
    assert.equal(r.status, 202, `${who}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'held_for_review');
    assert.equal(r.body.score, g.score, `${who} kept the exact score`);
  }
  const board = await http('/board?game=stacklight&board=all&unique=false');
  assert.deepEqual(board.body.rows.map((x) => [x.name, x.score]), [['ACE', g.score]]);
});
