// Balance bot gate (the balance band in docs/design.md, B.0): seeds 1-5 reach stage 16 in 34,000-46,000 frames
// with at most 8 deaths, and the same seed gives the same hash twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBot, BAND_MIN, BAND_MAX, MAX_DEATHS } from '../tools/sim-bot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the gate is the Q27 band: 34,000-46,000 frames, at most 8 deaths', () => {
  assert.equal(BAND_MIN, 34000);
  assert.equal(BAND_MAX, 46000);
  assert.equal(MAX_DEATHS, 8);
});

test('the bot has no randomness or clock of its own', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/sim-bot.mjs'), 'utf8');
  assert.ok(!/Math\.random|Date|performance|\.rnd\(|\.rng\b/.test(src));
});

for (const seed of [1, 2, 3, 4, 5]) {
  test(`seed ${seed}: PASS (stage 16 inside the band, deaths <= 8)`, () => {
    const r = runBot(seed);
    assert.equal(r.stage, 16);
    assert.ok(r.reached >= BAND_MIN && r.reached <= BAND_MAX, `stage 16 at frame ${r.reached}`);
    assert.ok(r.deaths <= MAX_DEATHS, `${r.deaths} deaths`);
    assert.equal(r.pass, true);
    if (seed === 1) {
      assert.equal(runBot(1).hash, r.hash, 'same seed, same hash');
      assert.equal(r.rows[0].deaths, 0);
      assert.equal(r.rows[0].heat, 2, 'stage 1 cleared clean: +2 heat');
    }
  });
}
