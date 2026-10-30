// w22 HIGH1: the replay cap comes from MAX_RUN_FRAMES at the densest honest input (touch, a new word every frame),
// with the body cap to match. Through worker.fetch on the node:sqlite D1 shim with real touch runs.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { MAX_REPLAY_CHARS, MAX_RUN_FRAMES as API_FRAMES, REPLAY_CHARS_PER_FRAME } from '../leaderboard/api.js';
import { MAX_RUN_FRAMES } from '../server/verify.js';
import { LIMITS } from '../server/worker.js';
import { playTouch, makeEnv, post, createWorker } from '../server/fixtures.mjs';

let TOUCH, NEAR_MAX;
let n = 0;
const body = (over = {}) => ({ game: GAME_ID, playerId: `w22-limits-${String(++n).padStart(4, '0')}`, name: 'TCH', seed: 2, mode: 'free', version: GAME_VERSION, ...over });
const ip = () => `198.20.0.${n & 255}`;
const bodyOf = (replay) => replay.split('~')[5];

before(() => {
  TOUCH = [1, 2, 3].map((k) => playTouch(2, k * 977));
  NEAR_MAX = playTouch(2, 5, MAX_RUN_FRAMES); // 216,000 frames of dense touch input (the ship dies long before)
});

test('the cap is derived: MAX_RUN_FRAMES x 4 chars + 64 = 864,064; the server and the API agree on MAX_RUN_FRAMES', () => {
  assert.equal(API_FRAMES, MAX_RUN_FRAMES);
  assert.equal(MAX_RUN_FRAMES, 216000);
  assert.equal(REPLAY_CHARS_PER_FRAME, 4);
  assert.equal(MAX_REPLAY_CHARS, 864064);
  assert.equal(LIMITS.bodyBytes, MAX_REPLAY_CHARS + 16384);
});

test('measured: real finished touch runs that move every frame cost 4.00 chars a frame at most (never more than the cap assumes)', () => {
  for (const r of TOUCH) {
    assert.ok(r.done && r.score > 0, 'a real finished run');
    const cpf = bodyOf(r.replay).length / r.frames;
    assert.ok(cpf > 3.9 && cpf <= REPLAY_CHARS_PER_FRAME, `measured ${cpf.toFixed(3)} chars a frame`);
  }
  const cpf = bodyOf(NEAR_MAX.replay).length / NEAR_MAX.frames;
  assert.ok(cpf > 3.9 && cpf <= REPLAY_CHARS_PER_FRAME, `measured ${cpf.toFixed(3)}`);
});

test('a real finished dense touch run is accepted (201) and stored with its replay', async () => {
  const env = await makeEnv();
  const W = createWorker();
  for (const r of TOUCH) {
    const res = await post(W, env, body({ replay: r.replay, score: r.score }), { ip: ip() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  }
});

test('a dense touch replay at the full 216,000 frames gets past both caps (to the re-sim, which finds frames after the end)', async () => {
  const env = await makeEnv();
  const W = createWorker();
  assert.equal(NEAR_MAX.frames, MAX_RUN_FRAMES);
  assert.ok(NEAR_MAX.replay.length <= MAX_REPLAY_CHARS, `${NEAR_MAX.replay.length}`);
  assert.ok(NEAR_MAX.replay.length > 860000);
  const b = body({ replay: NEAR_MAX.replay, score: NEAR_MAX.score });
  assert.ok(JSON.stringify(b).length <= LIMITS.bodyBytes);
  const r = await post(W, env, b, { ip: ip() });
  assert.equal(r.status, 422, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.error, 'frames_after_end'); // not body_too_large, not replay_too_large: it was let in and re-simulated
});

test('one char over the replay cap is refused (replay_too_large) before the replay is parsed; a body over the byte cap before JSON', async () => {
  const env = await makeEnv();
  const W = createWorker();
  // not even base64: if it were parsed it would be bad_replay; it is refused on length alone
  const head = `r1~starfall~${GAME_VERSION}~2~arcade~`;
  const over = head + '!'.repeat(MAX_REPLAY_CHARS + 1 - head.length);
  assert.equal(over.length, MAX_REPLAY_CHARS + 1);
  const t0 = performance.now();
  let r = await post(W, env, body({ replay: over, score: 1 }), { ip: ip() });
  assert.equal(r.status, 413);
  assert.equal(r.body.error, 'replay_too_large');
  assert.ok(performance.now() - t0 < 500);
  // exactly at the cap: let through to the replay checks
  r = await post(W, env, body({ replay: over.slice(0, -1), score: 1 }), { ip: ip() });
  assert.equal(r.body.error, 'bad_replay');
  // the real near-max run plus one more dense frame is over the frame cap
  const longer = playTouch(2, 5, MAX_RUN_FRAMES + 1);
  assert.ok(longer.replay.length <= MAX_REPLAY_CHARS);
  assert.equal((await post(W, env, body({ replay: longer.replay, score: 1 }), { ip: ip() })).body.error, 'replay_too_long');
  // a body one byte over the byte cap, with and without content-length: refused while reading
  const big = 'x'.repeat(LIMITS.bodyBytes + 1);
  assert.equal((await post(W, env, big, { ip: ip() })).body.error, 'body_too_large');
  let pulled = 0;
  const stream = new ReadableStream({ pull(c) { if (pulled >= LIMITS.bodyBytes + 1) { c.close(); return; } const k = Math.min(65536, LIMITS.bodyBytes + 1 - pulled); pulled += k; c.enqueue(new Uint8Array(k).fill(120)); } });
  const res = await W.fetch(new Request('https://lb.test/submit', { method: 'POST', body: stream, duplex: 'half', headers: { 'cf-connecting-ip': ip() } }), env);
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'body_too_large');
});
