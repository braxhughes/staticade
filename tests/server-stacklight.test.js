// Card T6: the leaderboard server verifies STACKLIGHT runs through the same pipeline as Starfall, picked from the
// game registry (server/games.js), and /daily answers game=stacklight. Through the Worker's real entry point
// (worker.fetch on node:sqlite) and, for the golden run, a bad replay and a Starfall run, through the dev server's real
// HTTP route (server/dev-server.mjs in a child process). Starfall must behave exactly as before.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decode, encode } from '../engine/replay.js';
import { dailySeed, Rng, seedFromString } from '../engine/rng.js';
import { createSim, PH_PLAY } from '../games/stacklight/sim.js';
import { GAME_ID, GAME_VERSION, COLS, BAR, PLUS, ROT_H, ROT_V, INPUT_MASK } from '../games/stacklight/defs.js';
import { columnHeight } from '../games/stacklight/sim/board.js';
import { GAME_VERSION as SF_VERSION } from '../games/starfall/sim.js';
import { todayUTC } from '../games/starfall/modes.js';
import { makeServerVerifier, MAX_RUN_FRAMES } from '../server/verify.js';
import { GAMES, gameOf, makeStacklightVerify } from '../server/games.js';
import { record, makeEnv, post, get, createWorker } from '../server/fixtures.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const H = 3600000, DAY = 24 * H;
// Golden Free Play seed 1 (tests/stacklight-golden.test.js): its r1 string is read from that file in before().
// GAME_VERSION 2.0 (D111, D113): re-recorded golden; 1.0 was frames 9941, score 13885, lines 31, hash 2241779068.
// GAME_VERSION 3.0 (D119): re-recorded golden (instant lock); 2.0 was frames 9382, score 10925, lines 29, hash 226820778.
const GOLD = { seed: 1, frames: 15520, score: 49680, lines: 64, hash: 943174853 };

// ---------- a word bot (the golden script's placement rule, best placement only, tap and hard drop) ----------
function heights(sim) { const h = []; for (let c = 0; c < COLS; c++) h.push(columnHeight(sim.grid, c)); return h; }
function bestPlacement(sim, rng) {
  const h = heights(sim), type = sim.ctx.pType, cands = [];
  const add = (rot, col, adds) => {
    const n = h.slice();
    if (adds.length === 1) n[col] += 3; else { n[col - 1] += adds[0]; n[col] += adds[1]; n[col + 1] += adds[2]; }
    const lines = Math.min(...n), mx = Math.max(...n) - lines;
    let bump = 0; for (let c = 1; c < COLS; c++) bump += Math.abs(n[c] - n[c - 1]);
    cands.push({ rot, col, v: lines * 20 - mx * 4 - bump + rng.int(3) });
  };
  if (type === BAR) { for (let c = 1; c < COLS - 1; c++) add(ROT_H, c, [1, 1, 1]); for (let c = 0; c < COLS; c++) add(ROT_V, c, [3]); }
  else for (let c = 1; c < COLS - 1; c++) add(ROT_H, c, [1, 3, 1]);
  let best = cands[0]; for (const k of cands) if (k.v > best.v) best = k;
  return best;
}
// plays a whole run; returns { replay, score, frames, hash, level, words }
function playBot(seed, mode, inSeed = 1) {
  const sim = createSim({ seed, mode }), rng = new Rng(seedFromString('t6-test:' + inSeed));
  let plan = null, planned = -1, prev = 0, idle = 0, lastPx = -1;
  while (!sim.done) {
    const S = sim.ctx; let w = 0;
    if (S.phase === PH_PLAY) {
      if (S.spawned !== planned) { planned = S.spawned; plan = bestPlacement(sim, rng); idle = 0; lastPx = S.px; }
      if (S.pType !== PLUS && S.rot !== plan.rot && idle < 3) { w = prev & 64 ? 0 : 64; idle++; }
      else if (S.px !== plan.col && idle < 40) {
        if (S.px !== lastPx) { lastPx = S.px; } else idle++;
        const press = S.px > plan.col ? 8 | 1 : 16 | 2; w = prev & (press & 24) ? 0 : press;
      } else w = prev & 32 ? 0 : 32;
    }
    sim.step(w); sim.clearEvents(); prev = w;
  }
  return { replay: sim.replay(), score: sim.score, frames: sim.frame, hash: sim.stateHash(), level: sim.level };
}

const reencode = (str, edit) => { const h = decode(str); const w = Array.from(h.words); return encode(h, edit(w, h) ?? w); };
let N = 0;
const pid = () => `t6-player-${String(++N).padStart(4, '0')}`;
const ipN = () => `198.51.100.${(N % 250) + 1}`;
// the submit body for a run; game, mode, version or dayKey on the run object (or in over) replace the defaults
const BODY_KEYS = ['game', 'mode', 'version', 'dayKey'];
const slBody = (run, over = {}) => ({ game: GAME_ID, playerId: pid(), name: 'ACE', score: run.score, replay: run.replay, seed: run.seed,
  mode: 'free', version: GAME_VERSION, ...Object.fromEntries(BODY_KEYS.filter((k) => k in run).map((k) => [k, run[k]])), ...over });

let GOLDEN, FREE2, TODAY, SF_FREE;
before(() => {
  // the golden r1 string itself, read from the golden test file so this test never holds a second copy
  const text = fs.readFileSync(fileURLToPath(new URL('./stacklight-golden.test.js', import.meta.url)), 'utf8');
  const m = /r1: '(r1~stacklight~3\.0~1~arcade~[^']+)'/.exec(text);
  GOLDEN = { ...GOLD, replay: m[1] };
  FREE2 = { ...playBot(77, 'arcade', 5), seed: 77 };
  const day = todayUTC();
  TODAY = { ...playBot(dailySeed(day), 'daily', 3), seed: dailySeed(day), dayKey: day };
  SF_FREE = { ...record('arcade', 2), seed: 2 };
});

// ---------- registry ----------
test('registry: starfall and stacklight, own keys only, no test mode, per-game version and mode headers', () => {
  assert.deepEqual(Object.keys(GAMES).sort(), ['stacklight', 'starfall']);
  assert.equal(gameOf('stacklight').version, '3.0');
  assert.equal(gameOf('starfall').version, SF_VERSION);
  for (const id of ['constructor', '__proto__', 'toString', 'other', '', undefined, null]) assert.equal(gameOf(id), null, String(id));
  assert.deepEqual({ ...gameOf('stacklight').modeHeader }, { daily: 'daily', free: 'arcade' });
  assert.ok(!Object.values(gameOf('stacklight').modeHeader).includes('test'), 'mode test is never a replay mode (B.7)');
  assert.equal(gameOf('stacklight').inputMask, INPUT_MASK);
  assert.equal(gameOf('starfall').inputMask, null, 'Starfall keeps no reserved-bit rule (behaviour unchanged)');
  assert.ok(Object.isFrozen(GAMES) && Object.isFrozen(GAMES.stacklight));
});

// ---------- the golden run ----------
test('golden Free Play seed 1 verifies: the server keeps its own score, frames, level and hash', () => {
  const v = makeServerVerifier()({ game: GAME_ID, replay: GOLDEN.replay, seed: 1, mode: 'free', version: GAME_VERSION });
  assert.equal(v.score, GOLD.score); assert.equal(v.frames, GOLD.frames); assert.equal(v.hash, String(GOLD.hash), 'the hash is kept as a string (results.hash is TEXT)');
  assert.equal(v.stage, 9, 'stage is the level (64 lines in Free Play: level 9)');
  assert.ok(v.sig.length >= 32 && v.sig.length % 2 === 0, 'a near-copy signature is recorded');
});

test('golden run through worker.fetch: 201, on the stacklight board (version 3), not on Starfall\'s', async () => {
  const W = createWorker(), env = await makeEnv();
  const r = await post(W, env, slBody({ ...GOLDEN, seed: 1 }), { ip: ipN() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.verified, { frames: GOLD.frames, stage: 9, hash: String(GOLD.hash) });
  const b = await get(W, env, '/board?game=stacklight&board=all');
  assert.deepEqual(b.body.rows.map((x) => [x.name, x.score]), [['ACE', GOLD.score]], 'default board version is STACKLIGHT\'s major (3)');
  assert.deepEqual((await get(W, env, '/board?game=stacklight&board=all&version=3')).body.rows.length, 1);
  assert.deepEqual((await get(W, env, '/board?game=stacklight&board=all&version=2')).body.rows, [], 'a 3.0 run is not on the 2.0 board');
  assert.deepEqual((await get(W, env, '/board?game=stacklight&board=all&version=1')).body.rows, [], 'a 3.0 run is not on the 1.0 board');
  assert.deepEqual((await get(W, env, '/board?game=starfall&board=all')).body.rows, []);
  const rp = await get(W, env, `/replay/${r.body.id}`);
  assert.equal(rp.body.replay, GOLDEN.replay);
  // the same replay again, and a bot run on another seed
  assert.equal((await post(W, env, slBody({ ...GOLDEN, seed: 1 }), { ip: ipN() })).body.error, 'duplicate_replay');
  const r2 = await post(W, env, slBody(FREE2), { ip: ipN() });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
});

// ---------- every failure code for a bad STACKLIGHT replay ----------
async function refuse(body, code, status = 422) {
  const W = createWorker(), env = await makeEnv();
  const r = await post(W, env, body, { ip: ipN() });
  assert.equal(r.body.error, code, JSON.stringify(r.body));
  assert.equal(r.status, status);
  assert.deepEqual((await get(W, env, '/board?game=stacklight&board=all')).body.rows, [], 'nothing stored');
}
const G = () => ({ ...GOLDEN, seed: 1 });

test('bad version: an old or future STACKLIGHT version, or Starfall\'s version number, is wrong_version', async () => {
  await refuse(slBody({ ...G(), replay: GOLDEN.replay.replace('~3.0~', '~1.0~'), version: '1.0' }), 'wrong_version');
  await refuse(slBody({ ...G(), replay: GOLDEN.replay.replace('~3.0~', '~2.0~'), version: '2.0' }), 'wrong_version');
  await refuse(slBody({ ...G(), replay: GOLDEN.replay.replace('~3.0~', '~4.0~'), version: '4.0' }), 'wrong_version');
  await refuse(slBody({ ...G(), version: '1.0' }), 'wrong_version');
  await refuse(slBody({ ...G(), version: SF_VERSION }), 'wrong_version');
});

test('bad mode: claimed mode does not match the header; a header with mode test is refused', async () => {
  await refuse(slBody({ ...G(), mode: 'daily', dayKey: todayUTC() }), 'bad_mode');
  await refuse(slBody({ ...G(), replay: GOLDEN.replay.replace('~arcade~', '~test~') }), 'bad_mode');
  await refuse(slBody({ ...G(), replay: GOLDEN.replay.replace('~arcade~', '~daily~') }), 'bad_mode');
  // straight to the verifier, past validateSubmission's own mode check: a claimed 'test' or prototype key is no mode
  const v = makeServerVerifier();
  for (const mode of ['test', 'arcade', 'constructor', '__proto__']) {
    assert.throws(() => v({ game: GAME_ID, replay: GOLDEN.replay.replace('~arcade~', '~test~'), seed: 1, mode, version: GAME_VERSION }), (e) => e.code === 'bad_mode', mode);
  }
});

test('reserved input bits (7 to 15) on a single frame are bad_replay, even where the sim would ignore them', async () => {
  for (const bit of [7, 10, 15]) {
    const replay = reencode(GOLDEN.replay, (w) => { w[5000] |= 1 << bit; });
    await refuse(slBody({ ...G(), replay }), 'bad_replay');
  }
  const last = reencode(GOLDEN.replay, (w) => { w[w.length - 1] |= 0x80; });
  await refuse(slBody({ ...G(), replay: last }), 'bad_replay');
});

test('frames after the end (top out) are frames_after_end', async () => {
  await refuse(slBody({ ...G(), replay: reencode(GOLDEN.replay, (w) => w.concat([0])) }), 'frames_after_end');
  await refuse(slBody({ ...G(), replay: reencode(GOLDEN.replay, (w) => w.concat(new Array(600).fill(32))) }), 'frames_after_end');
});

test('a run cut before the end is run_not_finished', async () => {
  await refuse(slBody({ ...G(), replay: reencode(GOLDEN.replay, (w) => w.slice(0, 5000)) }), 'run_not_finished');
  await refuse(slBody({ ...G(), replay: reencode(GOLDEN.replay, (w) => w.slice(0, w.length - 1)) }), 'run_not_finished');
});

test('over the 216,000-frame cap is replay_too_long; the cap is MAX_RUN_FRAMES', async () => {
  assert.equal(MAX_RUN_FRAMES, 216000);
  const over = reencode(GOLDEN.replay, (w) => w.concat(new Array(MAX_RUN_FRAMES + 1 - w.length).fill(0)));
  assert.equal(decode(over).frames, 216001);
  await refuse(slBody({ ...G(), replay: over }), 'replay_too_long');
  const at = reencode(GOLDEN.replay, (w) => w.concat(new Array(MAX_RUN_FRAMES - w.length).fill(0)));
  await refuse(slBody({ ...G(), replay: at }), 'frames_after_end'); // at the cap it is re-simulated (and ended long before)
});

test('claimed score is checked against the re-sim (score_mismatch)', async () => {
  await refuse(slBody({ ...G(), score: GOLD.score + 5 }), 'score_mismatch');
});

test('pass B disagreeing with pass A is verify_disagree (500), and pass B gets the run as claimed', async () => {
  const seen = [];
  const games = { ...GAMES, stacklight: { ...GAMES.stacklight, makeVerifyReplay: () => (c) => { seen.push(c); return GOLD.score + 1; } } };
  const v = makeServerVerifier({ games });
  assert.throws(() => v({ game: GAME_ID, replay: GOLDEN.replay, seed: 1, mode: 'free', version: GAME_VERSION }), (e) => e.code === 'verify_disagree');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { game: GAME_ID, replay: GOLDEN.replay, seed: 1, mode: 'free', dayKey: undefined, version: GAME_VERSION });
  // and the real pass B agrees on the golden run
  assert.equal(makeServerVerifier()({ game: GAME_ID, replay: GOLDEN.replay, seed: 1, mode: 'free', version: GAME_VERSION }).score, GOLD.score);
});

test('STACKLIGHT pass B on its own: the score for an honest run, NaN for every bad one', () => {
  const vb = makeStacklightVerify({ now: () => Date.now() });
  const base = { game: GAME_ID, seed: 1, mode: 'free', version: GAME_VERSION };
  assert.equal(vb({ ...base, replay: GOLDEN.replay }), GOLD.score);
  const bad = {
    'frames after end': reencode(GOLDEN.replay, (w) => w.concat([0])),
    'cut': reencode(GOLDEN.replay, (w) => w.slice(0, 5000)),
    'reserved bit': reencode(GOLDEN.replay, (w) => { w[100] |= 0x100; }),
    'test mode': GOLDEN.replay.replace('~arcade~', '~test~'),
    'old version': GOLDEN.replay.replace('~3.0~', '~2.0~'),
    'starfall header': GOLDEN.replay.replace('~stacklight~', '~starfall~'),
    'not canonical': GOLDEN.replay + 'A',
  };
  for (const [name, replay] of Object.entries(bad)) assert.ok(Number.isNaN(vb({ ...base, replay })), name);
  assert.ok(Number.isNaN(vb({ ...base, replay: GOLDEN.replay, game: 'starfall' })), 'claimed starfall');
  assert.ok(Number.isNaN(vb({ ...base, replay: GOLDEN.replay, version: '1.0' })), 'claimed version');
  assert.ok(Number.isNaN(vb({ ...base, replay: GOLDEN.replay, seed: 2 })), 'seed');
  assert.ok(Number.isNaN(vb({ ...base, replay: GOLDEN.replay, mode: 'daily', dayKey: todayUTC() })), 'mode');
  assert.ok(Number.isNaN(vb({ ...base, replay: GOLDEN.replay, mode: 'test' })), 'claimed test');
  // Daily Ridge: today's public seed, or the seed dailySeedOf gives (DAILY_SECRET); the day within 1 day of now
  const day = { game: GAME_ID, replay: TODAY.replay, seed: TODAY.seed, mode: 'daily', dayKey: TODAY.dayKey, version: GAME_VERSION };
  assert.equal(vb(day), TODAY.score);
  const prev = new Date(Date.parse(TODAY.dayKey + 'T00:00:00Z') - 3 * DAY).toISOString().slice(0, 10);
  assert.ok(Number.isNaN(vb({ ...day, dayKey: prev })), 'seed of another day');
  assert.ok(Number.isNaN(vb({ ...day, dayKey: undefined })), 'no dayKey');
  assert.equal(makeStacklightVerify({ dailySeedOf: () => TODAY.seed })(day), TODAY.score, 'the server seed');
  assert.ok(Number.isNaN(makeStacklightVerify({ dailySeedOf: () => TODAY.seed + 1 })(day)), 'not the server seed');
  assert.ok(Number.isNaN(makeStacklightVerify({ dailySeedOf: () => TODAY.seed, now: () => Date.now() + 3 * DAY })(day)), 'day out of window');
});

// ---------- game confusion ----------
test('unknown game and cross-game claims are bad_game', async () => {
  await refuse(slBody({ ...G(), game: 'other' }), 'bad_game', 400);
  await refuse(slBody({ ...G(), game: 'starfall' }), 'bad_game', 400);                                   // STACKLIGHT replay claiming starfall
  await refuse(slBody({ ...G(), game: 'starfall', version: SF_VERSION }), 'bad_game', 400);
  await refuse(slBody(SF_FREE, { mode: 'free', version: SF_VERSION }), 'bad_game', 400);                            // Starfall replay claiming stacklight
  await refuse(slBody(SF_FREE, { mode: 'free', version: GAME_VERSION }), 'bad_game', 400);
  await refuse(slBody({ ...G(), replay: GOLDEN.replay.replace('~stacklight~', '~other~'), game: 'other' }), 'bad_game', 400);
});

// ---------- Daily Ridge ----------
test('/daily answers game=stacklight; game=other stays bad_game; Starfall and STACKLIGHT get different secret seeds', async () => {
  const W = createWorker(), e = await makeEnv();
  const r = await get(W, e, '/daily?game=stacklight');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.game, 'stacklight'); assert.equal(r.body.seed, dailySeed(r.body.dayKey)); assert.equal(r.body.ticket, null);
  assert.equal((await get(W, e, '/daily?game=other')).body.error, 'bad_game');
  assert.equal((await get(W, e, '/daily?game=constructor')).body.error, 'bad_game');
  assert.equal((await get(W, e, '/daily')).body.error, 'bad_game');
  const secret = randomBytes(32).toString('hex');
  const es = { ...(await makeEnv()), DAILY_SECRET: secret };
  const ask = async (game) => (await W.fetch(new Request(`https://lb.test/daily?game=${game}`, { headers: { 'x-player-id': 'daily-player-01', 'cf-connecting-ip': '203.0.113.9' } }), es)).json();
  const sl = await ask('stacklight'), sf = await ask('starfall');
  const hmac = (game, day) => createHmac('sha256', secret).update(`daily:${game}:${day}`).digest().readUInt32BE(0);
  assert.equal(sl.seed, hmac('stacklight', sl.dayKey));
  assert.equal(sf.seed, hmac('starfall', sf.dayKey));
  assert.notEqual(sl.seed, sf.seed);
  assert.ok(sl.ticket && sl.ticket !== sf.ticket);
});

test('Daily Ridge: today\'s run on the public seed is taken onto the daily board; 2 days out is bad_day', async () => {
  const W = createWorker(), e = await makeEnv();
  const r = await post(W, e, slBody(TODAY, { mode: 'daily', dayKey: TODAY.dayKey }), { ip: ipN() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.placements.daily, 1);
  assert.ok(r.body.verified.stage >= 4, 'Daily Ridge starts at level 4');
  const b = await get(W, e, `/board?game=stacklight&board=daily&key=${TODAY.dayKey}`);
  assert.equal(b.body.rows[0].score, TODAY.score);
  // a day 2 days away, on its own public seed
  const far = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
  const run = { ...playBot(dailySeed(far), 'daily', 4), seed: dailySeed(far) };
  await refuse(slBody(run, { mode: 'daily', dayKey: far }), 'bad_day');
  await refuse(slBody(TODAY, { mode: 'daily', dayKey: far }), 'bad_seed');
});

test('Daily Ridge with DAILY_SECRET: the seed and ticket /daily gave are taken; tomorrow\'s day or a Starfall ticket are not', async () => {
  const secret = randomBytes(32).toString('hex');
  const t0 = Date.parse('2026-11-07T10:00:00Z');
  const c = { t: t0 }, W = createWorker({ now: () => c.t }), e = { ...(await makeEnv()), DAILY_SECRET: secret };
  const player = pid();
  const ask = async (game) => (await W.fetch(new Request(`https://lb.test/daily?game=${game}`, { headers: { 'x-player-id': player, 'cf-connecting-ip': '203.0.113.10' } }), e)).json();
  const d = await ask('stacklight'), dsf = await ask('starfall');
  const run = { ...playBot(d.seed, 'daily', 6), seed: d.seed };
  c.t = t0 + H; // an hour later: more real time than the run's frames
  const body = (over) => slBody(run, { playerId: player, mode: 'daily', dayKey: d.dayKey, ticket: d.ticket, ...over });
  const tomorrow = new Date(t0 + DAY).toISOString().slice(0, 10);
  assert.equal((await post(W, e, body({ dayKey: tomorrow }), { ip: ipN() })).body.error, 'bad_ticket');
  assert.equal((await post(W, e, body({ ticket: dsf.ticket }), { ip: ipN() })).body.error, 'bad_ticket', 'a Starfall ticket is not a STACKLIGHT ticket');
  c.t = t0 + 60000; // a minute after the ticket: less real time than the run holds
  assert.equal((await post(W, e, body({}), { ip: ipN() })).body.error, 'bad_ticket');
  c.t = t0 + Math.ceil(run.frames / 60 * 1000);
  const ok = await post(W, e, body({}), { ip: ipN() });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  // the public seed of the day is not the secret seed
  const pub = { ...playBot(dailySeed(d.dayKey), 'daily', 6), seed: dailySeed(d.dayKey) };
  const r = await post(W, e, slBody(pub, { playerId: player, mode: 'daily', dayKey: d.dayKey, ticket: d.ticket }), { ip: ipN() });
  assert.equal(r.body.error, 'bad_seed');
});

// ---------- copies ----------
test('a one-bit edited copy of a stored STACKLIGHT run is held for review (202), never on the board', async () => {
  const W = createWorker(), env = await makeEnv();
  assert.equal((await post(W, env, slBody(G()), { ip: ipN() })).status, 201);
  // flip one input bit on one late frame; keep the first edit that changes the final state (so it is not the exact
  // duplicate_result case) and still ends exactly on its last word.
  // The step was 7 in an earlier version of this search, which kept f % 7 (the flipped bit) the same on every try, so the search
  // only ever flipped one bit; on the current golden that bit (RIGHT press) never gives a clean copy. A step of 1 tries every
  // bit as intended; the assertions below are unchanged.
  let copy = null;
  for (let f = GOLD.frames - 40; f > GOLD.frames - 2000 && !copy; f -= 1) {
    const replay = reencode(GOLDEN.replay, (w) => { w[f] ^= 1 << (f % 7); });
    const h = decode(replay), sim = createSim({ seed: 1, mode: 'arcade' });
    let i = 0; for (; i < h.words.length && !sim.done; i++) sim.step(h.words[i]);
    if (sim.done && i === h.words.length && sim.score > 0 && sim.stateHash() !== GOLD.hash) copy = { replay, score: sim.score, seed: 1 };
  }
  assert.ok(copy, 'found a one-bit copy that still ends cleanly');
  const r = await post(W, env, slBody(copy, { name: 'KIT' }), { ip: ipN() });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.held, true);
  assert.deepEqual((await get(W, env, '/board?game=stacklight')).body.rows.map((x) => x.name), ['ACE']);
});

// ---------- Starfall unchanged ----------
test('Starfall still verifies, with the same fields, and its default board is still version 2', async () => {
  const W = createWorker(), env = await makeEnv();
  const r = await post(W, env, { game: 'starfall', playerId: pid(), name: 'ACE', score: SF_FREE.score, replay: SF_FREE.replay, seed: 2, mode: 'free', version: SF_VERSION }, { ip: ipN() });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.verified, { frames: SF_FREE.frames, stage: SF_FREE.stage, hash: SF_FREE.hash });
  assert.equal((await get(W, env, '/board?game=starfall')).body.rows[0].score, SF_FREE.score);
  assert.equal((await get(W, env, '/board?game=starfall&version=2')).body.rows.length, 1);
  assert.equal((await get(W, env, '/board?game=stacklight')).body.rows.length, 0);
  const sf = await get(W, env, '/daily?game=starfall');
  assert.equal(sf.status, 200); assert.equal(sf.body.game, 'starfall');
});

// ---------- the dev server's real HTTP route ----------
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

test('dev server HTTP: the golden STACKLIGHT run 201s, a bad replay 422s, a Starfall run 201s, /daily?game=stacklight 200s', async () => {
  await startDev();
  const g = await http('/submit', slBody(G()));
  assert.equal(g.status, 201, JSON.stringify(g.body));
  assert.equal(g.body.score, GOLD.score); assert.equal(g.body.verified.hash, String(GOLD.hash));
  const bad = await http('/submit', slBody({ ...G(), replay: reencode(GOLDEN.replay, (w) => { w[300] |= 0x80; }) }));
  assert.deepEqual([bad.status, bad.body.error], [422, 'bad_replay']);
  const cut = await http('/submit', slBody({ ...G(), replay: reencode(GOLDEN.replay, (w) => w.slice(0, 4000)) }));
  assert.deepEqual([cut.status, cut.body.error], [422, 'run_not_finished']);
  const sf = await http('/submit', { game: 'starfall', playerId: pid(), name: 'ACE', score: SF_FREE.score, replay: SF_FREE.replay, seed: 2, mode: 'free', version: SF_VERSION });
  assert.equal(sf.status, 201, JSON.stringify(sf.body));
  const d = await http('/daily?game=stacklight');
  assert.equal(d.status, 200); assert.equal(d.body.game, 'stacklight');
  const board = await http('/board?game=stacklight&board=all');
  assert.deepEqual(board.body.rows.map((x) => x.score), [GOLD.score]);
});
