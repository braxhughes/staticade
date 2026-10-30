// w10-s12-guard: review MED2 and LOWs for S12 that run in Node. New file; no existing test is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dailySeed } from '../engine/rng.js';
import { decode, encode, createRecorder, b64urlEncode, b64urlDecode } from '../engine/replay.js';
import { packWord } from '../engine/input-word.js';
import { createLeaderboard } from '../leaderboard/api.js';
import { memoryAdapter } from '../leaderboard/storage.js';
import { createSim, GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { makeVerifyReplay, resimReplay, createModes, memoryKv, drawEntry, createEntry, NAME_LEN } from '../games/starfall/modes.js';
import { createAttract } from '../games/starfall/attract.js';
import { CX } from '../games/starfall/defs.js';

const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
const claim = (replay, seed, mode, extra = {}) => ({ replay, seed, mode, version: GAME_VERSION, game: GAME_ID, ...extra });

// An honest finished run: ship still, fire held, until the sim says done (about 4500 frames).
function finishedRun(seed = 77, mode = 'arcade') {
  const sim = createSim({ seed, mode }), rec = createRecorder(256);
  for (let i = 0; i < 20000 && !sim.done; i++) { const w = packWord(0, true, i === 0, false, false, 0); sim.step(w); rec.push(w); sim.clearEvents(); }
  assert.ok(sim.done && sim.score > 0, 'the helper run finishes with a score');
  return { sim, replay: rec.encode({ game: GAME_ID, version: GAME_VERSION, seed, mode }) };
}
const parts = r => r.split('~');
const join = p => p.join('~');

// ---------- MED2: one honest run is one string ----------
test('MED2: an honest finished run verifies; the five re-encodings of it are rejected', () => {
  const v = makeVerifyReplay({ now: () => NOW });
  const { sim, replay } = finishedRun();
  assert.equal(v(claim(replay, 77, 'free')), sim.score, 'canonical string verifies');

  const p = parts(replay), bytes = b64urlDecode(p[5]);

  // 1. whitespace around the string (decode trims it)
  assert.equal(v(claim(' ' + replay + '\n', 77, 'free')), NaN, 'whitespace');

  // 2. a run split in two runs of the same word (decodes to the same frames)
  const first = decode(replay);
  const runs = [];
  for (const w of first.words) { if (runs.length && runs[runs.length - 1][0] === w) runs[runs.length - 1][1]++; else runs.push([w, 1]); }
  const at = runs.findIndex(r => r[1] >= 2);
  assert.ok(at >= 0, 'some run is long enough to split');
  runs.splice(at, 1, [runs[at][0], runs[at][1] - 1], [runs[at][0], 1]);
  const split = [];
  const varint = x => { while (x >= 128) { split.push((x & 127) | 128); x = Math.floor(x / 128); } split.push(x); };
  for (const [w, n] of runs) { varint(w); varint(n); }
  const body2 = b64urlEncode(Uint8Array.from(split));
  const unmerged = join([...p.slice(0, 5), body2]);
  assert.notEqual(unmerged, replay);
  assert.deepEqual([...decode(unmerged).words], [...first.words], 'decodes to the same frames');
  assert.equal(v(claim(unmerged, 77, 'free')), NaN, 'unmerged run-length pair');

  // 3. spare bits in the last base64 character (decode drops them)
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const body = p[5], last = body[body.length - 1], rem = (body.length * 6) % 8;
  assert.ok(rem > 0, 'body ends mid-character');
  const alt = B64[B64.indexOf(last) ^ 1];
  const highBits = join([...p.slice(0, 5), body.slice(0, -1) + alt]);
  assert.notEqual(highBits, replay);
  assert.deepEqual([...decode(highBits).words], [...first.words], 'same frames');
  assert.equal(v(claim(highBits, 77, 'free')), NaN, 'spare base64 bits');

  // 4. a longer varint than needed (0x80 0x00 for 0 style padding on the first word)
  const padded = Array.from(bytes);
  let e = 0; while (padded[e] >= 128) e++; // last byte of the first varint
  padded[e] |= 128; padded.splice(e + 1, 0, 0); // it now says "more follows"; the extra byte is 0
  const body4 = b64urlEncode(Uint8Array.from(padded));
  const overlong = join([...p.slice(0, 5), body4]);
  assert.deepEqual([...decode(overlong).words], [...first.words], 'same frames');
  assert.equal(v(claim(overlong, 77, 'free')), NaN, 'overlong varint');

  // 5. idle frames added after the run ended (the sim ignores them, the string differs)
  const longer = encode({ game: GAME_ID, version: GAME_VERSION, seed: 77, mode: 'arcade' }, [...first.words, 0, 0, 0, 0, 0]);
  assert.notEqual(longer, replay);
  assert.equal(resimReplay(longer).score, sim.score, 'plain resim cannot tell (that is the hole)');
  assert.equal(v(claim(longer, 77, 'free')), NaN, 'trailing idle frames');
  assert.throws(() => resimReplay(longer, true), /after the run ended/);

  // and a leading-zero seed spelling
  const seedZero = join([p[0], p[1], p[2], '00' + p[3], p[4], p[5]]);
  assert.equal(v(claim(seedZero, 77, 'free')), NaN, 'seed with leading zeros');
});

test('MED2: a partial (unfinished) canonical replay still verifies; only frames past the end are refused', () => {
  const v = makeVerifyReplay({ now: () => NOW });
  const sim = createSim({ seed: 5, mode: 'arcade' }), rec = createRecorder(64);
  for (let i = 0; i < 600; i++) { const w = packWord(0, true, i === 0, false, false, 0); sim.step(w); rec.push(w); sim.clearEvents(); }
  const replay = rec.encode({ game: GAME_ID, version: GAME_VERSION, seed: 5, mode: 'arcade' });
  assert.equal(v(claim(replay, 5, 'free')), sim.score);
});

// ---------- LOW: claimed game ----------
test('LOW: a claimed game that is not Starfall is rejected by the verifier and by a leaderboard that uses it', async () => {
  const v = makeVerifyReplay({ now: () => NOW });
  const { sim, replay } = finishedRun(78);
  assert.equal(v(claim(replay, 78, 'free')), sim.score);
  assert.equal(v(claim(replay, 78, 'free', { game: 'pong' })), NaN, 'other game');
  assert.equal(v(claim(replay, 78, 'free', { game: '' })), NaN, 'empty game');
  const lb = createLeaderboard({ storage: memoryAdapter(), now: () => NOW, verifyReplay: v });
  const sub = game => lb.submitScore({ game, playerId: 'player-0001', name: 'ABC', score: sim.score, replay, seed: 78, mode: 'free', version: GAME_VERSION });
  await assert.rejects(sub('pong'), /replay_mismatch|scores/);
  assert.ok((await sub(GAME_ID)).id, 'the real game still stores');
});

// ---------- LOW: the daily day is read on the first play frame ----------
test('LOW: a daily run is stale once the UTC day has moved on, a free run never is', () => {
  let t = Date.UTC(2026, 9, 28, 23, 59, 59);
  const m = createModes({ lb: null, kv: memoryKv(), now: () => t });
  const d = m.begin('daily'), f = m.begin('free', 5);
  assert.equal(d.dayKey, '2026-10-28');
  assert.equal(m.stale(d), false);
  t = Date.UTC(2026, 9, 29, 0, 0, 1);
  assert.equal(m.stale(d), true, 'daily begun yesterday');
  assert.equal(m.stale(f), false, 'free run');
  assert.equal(m.stale(null), false);
  const d2 = m.begin('daily');
  assert.equal(d2.dayKey, '2026-10-29'); assert.equal(d2.seed, dailySeed('2026-10-29'));
  assert.equal(m.stale(d2), false);
});

// ---------- LOW: name entry up-arrow clear of the title ----------
test('LOW: name entry up-arrow dots start below the bottom of "ENTER YOUR INITIALS"', () => {
  const texts = [], dots = [];
  const R = { text: (str, x, y, col, sc) => texts.push({ str, x, y, sc }), dot: (x, y, r, cr, cg, cb) => { if (cr === 1 && cg === 0.7) dots.push({ x, y }); } };
  const e = createEntry('AAA');
  drawEntry(R, e, { scoreStr: '1', modeStr: 'FREE PLAY', timeStr: 'TIME 30' }, 0);
  const title = texts.find(t => t.str === 'ENTER YOUR INITIALS');
  const above = texts.find(t => t.str === 'FREE PLAY');
  assert.ok(title && above);
  const titleBottom = title.y + 7 * title.sc, titleTop = title.y;
  const arrowTop = Math.min(...dots.map(d => d.y));
  assert.ok(dots.length >= 10, 'arrow dots drawn: ' + dots.length);
  assert.ok(arrowTop >= titleBottom + 4, `up-arrow top ${arrowTop} must clear the title bottom ${titleBottom} by 4`);
  assert.ok(titleTop >= above.y + 7 * above.sc + 4, 'title also clear of the line above it');
  const half = (title.str.length * 6 - 1) / 2;
  assert.ok(half > 0 && CX > 0 && NAME_LEN === 3);
});

// ---------- LOW: attract.stop() cancels a pending prepare ----------
test('LOW: attract.stop() while prepare() is waiting leaves it unready (token bump)', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const lb = { getBoard: async () => { await gate; return []; }, getReplay: async () => null };
  const A = createAttract({ lb, demo: null });
  A.start();
  assert.equal(A.phase, 'wait');
  A.stop();
  release();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(A.ready, false, 'a prepare started before stop() must not finish after it');
  assert.equal(A.phase, 'off');
  assert.equal(A.source, null);
  // a fresh start still works
  A.start(); await new Promise(r => setTimeout(r, 10));
  assert.equal(A.ready, true);
});
