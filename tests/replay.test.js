import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, createRecorder, b64urlEncode, b64urlDecode } from '../engine/replay.js';

const H = { game: 'starfall', version: '1.1', seed: 4000000000, mode: 'arcade' };

test('encode/decode round-trips words and header exactly', () => {
  let s = 3; const words = [];
  for (let i = 0; i < 20000; i++) {
    s = (s * 16807) % 2147483647;
    // long runs of the same word, like real play
    const w = (s >> 8) & 0xffff, n = 1 + (s % 90);
    for (let k = 0; k < n; k++) words.push(w);
  }
  const str = encode(H, words), r = decode(str);
  assert.equal(r.game, H.game); assert.equal(r.version, H.version); assert.equal(r.seed, H.seed); assert.equal(r.mode, H.mode);
  assert.equal(r.frames, words.length);
  assert.deepEqual(Array.from(r.words), words);
  assert.match(str, /^r1~starfall~1\.1~[0-9a-z]+~arcade~[A-Za-z0-9_-]*$/);
});

test('edge cases: empty, a single word, extreme values, huge runs', () => {
  for (const words of [[], [0], [0xffff], [128, 128, 0xffff, 0, 0x1fff]]) assert.deepEqual(Array.from(decode(encode(H, words)).words), words);
  const big = new Uint16Array(300000).fill(128 | 512);
  const str = encode(H, big);
  assert.ok(str.length < 80, 'a 300k-frame idle run should be tiny, got ' + str.length);
  assert.deepEqual(decode(str).words, big);
  assert.equal(decode(encode({ ...H, seed: 0 }, [1])).seed, 0);
  assert.equal(decode(encode({ ...H, mode: 'stage5+dev' }, [1])).mode, 'stage5+dev');
});

test('recorder matches encode()', () => {
  const r = createRecorder(2), words = [];
  for (let i = 0; i < 5000; i++) { const w = (i * 7919) % 13 === 0 ? i & 0xffff : 128; r.push(w); words.push(w); }
  assert.equal(r.frames, 5000);
  assert.equal(r.encode(H), encode(H, words));
  r.reset(); assert.equal(r.frames, 0);
});

test('base64url round-trips every length', () => {
  for (let n = 0; n < 40; n++) {
    const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 37 + n) & 255;
    assert.deepEqual(Array.from(b64urlDecode(b64urlEncode(b))), Array.from(b));
  }
});

test('rejects malformed replays', () => {
  assert.throws(() => decode('hello'));
  assert.throws(() => decode('r2~starfall~1.1~0~arcade~AA'));
  assert.throws(() => decode('r1~starfall~1.1~0~arcade~A'));
  assert.throws(() => decode('r1~starfall~1.1~0~arcade~gA'));   // truncated run
  assert.throws(() => decode('r1~starfall~1.1~0~arcade~!!!!'));
  assert.throws(() => encode({ ...H, mode: 'bad~mode' }, [1]));
  assert.throws(() => encode({ ...H, seed: -1 }, [1]));
});
