// w17 tests-only slice, group 4: S.lives is part of stateHash; the V4 cues keep their length and release (duration and
// envelope were unpinned); tools/audio-check.mjs starts its own server on the one port its base URL uses (8772).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSim } from '../games/starfall/sim.js';
import { SFX } from '../games/starfall/sfx.js';

test('S.lives is mixed into stateHash (one ship more or fewer is a different state)', () => {
  const a = createSim({ seed: 5, mode: 'stage1' }), b = createSim({ seed: 5, mode: 'stage1' });
  assert.equal(a.stateHash(), b.stateHash(), 'same seed, same state');
  const h0 = a.stateHash(), l0 = a.ctx.lives;
  a.ctx.lives = l0 + 1; const h1 = a.stateHash();
  a.ctx.lives = l0 - 1; const h2 = a.stateHash();
  a.ctx.lives = l0;
  assert.notEqual(h1, h0, 'one more life changes the hash'); assert.notEqual(h2, h0, 'one fewer changes it'); assert.notEqual(h1, h2);
  assert.equal(a.stateHash(), h0, 'and back');
  // nothing else moved: only lives differs between the two sims
  assert.equal(b.stateHash(), h0);
});

function voices(name) {
  const list = [];
  SFX[name]({ o: {}, tone: (s, at) => list.push({ s, at: at || 0 }), noise: (s, at) => list.push({ s, at: at || 0 }) }, {});
  return list;
}
// when the last voice has faded out: start + duration + release
const endOf = n => Math.max(...voices(n).map(v => v.at + v.s.dur + (v.s.r || 0)));
test('cut, hunt and snap are short cues: total length and every voice\'s length and release stay in their bands', () => {
  const band = { cut: [0.2, 0.3], hunt: [0.3, 0.42], snap: [0.2, 0.32] };
  for (const n of Object.keys(band)) {
    const e = endOf(n);
    assert.ok(e >= band[n][0] && e <= band[n][1], `${n} lasts ${e.toFixed(3)} s, expected ${band[n]}`);
    for (const v of voices(n)) {
      assert.ok(v.s.dur >= 0.05 && v.s.dur <= 0.3, `${n} voice length ${v.s.dur}`);
      assert.ok(v.s.r > 0 && v.s.r <= 0.12, `${n} voice release ${v.s.r} (a release avoids a click and caps the tail)`);
    }
  }
  // the longest tail of each is the one that gives the cue its character
  assert.ok(endOf('hunt') > endOf('cut') && endOf('hunt') > endOf('snap'), 'hunt rings longest');
});
test('toss is a very short blip', () => {
  const v = voices('toss');
  assert.equal(v.length, 1); assert.ok(v[0].s.dur >= 0.03 && v[0].s.dur <= 0.08, 'toss length ' + v[0].s.dur);
});

test('audio-check: the server it spawns and the base URL it opens use the same port, 8772', () => {
  const src = fs.readFileSync(new URL('../tools/audio-check.mjs', import.meta.url), 'utf8');
  const spawned = /'http\.server',\s*'(\d+)'/.exec(src), base = /base\s*=\s*'http:\/\/localhost:(\d+)'/.exec(src);
  assert.ok(spawned && base, 'the default server lines are present');
  assert.equal(spawned[1], '8772'); assert.equal(base[1], '8772'); assert.equal(spawned[1], base[1]);
  assert.match(src, /default starts its own server on port 8772/, 'the usage line says 8772 too');
});
