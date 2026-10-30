import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encode, decode, createRecorder, b64urlEncode, MAX_FRAMES } from '../engine/replay.js';
import { GAME_VERSION } from '../games/starfall/defs.js';

const H = { game: 'starfall', version: '1.1', seed: 9, mode: 'arcade' };
const HDR = 'r1~starfall~1.1~9~arcade~';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a hostile run length fails fast with a clear error (no hang, no huge allocation)', { timeout: 2000 }, () => {
  // word 128, then a run length of 2^34 - 1 (five varint bytes)
  const huge = b64urlEncode(Uint8Array.from([0x80, 0x01, 0xff, 0xff, 0xff, 0xff, 0x7f]));
  assert.throws(() => decode(HDR + huge), /more than \d+ frames/);
  // many runs that each fit but together pass the cap
  const bytes = []; for (let i = 0; i < 40; i++) bytes.push(i & 0x7f, 0xff, 0xff, 0xff, 0x0f);
  assert.throws(() => decode(HDR + b64urlEncode(Uint8Array.from(bytes))), /more than \d+ frames/);
  // a varint that never ends
  assert.throws(() => decode(HDR + b64urlEncode(new Uint8Array(64).fill(0x80))), /varint too long|truncated/);
  // exactly at the cap is accepted in principle: one run of MAX_FRAMES decodes the header check
  assert.equal(MAX_FRAMES, 2 ** 26);
});

test('RLE runs longer than 255 and 65535 round-trip exactly', () => {
  for (const n of [255, 256, 300, 65535, 65536, 70000, 200001]) {
    const words = new Uint16Array(n + 2); words.fill(0x2ff); words[0] = 7; words[n + 1] = 0xffff;
    const str = encode(H, words), r = decode(str);
    assert.equal(r.frames, n + 2, 'frames for run ' + n);
    assert.deepEqual(r.words, words, 'words for run ' + n);
    const rec = createRecorder(2); for (const w of words) rec.push(w);
    assert.equal(rec.encode(H), str, 'recorder for run ' + n);
  }
});

test('recorder masks pushed words to 16 bits', () => {
  const rec = createRecorder(2);
  rec.push(0x1_0080); rec.push(0x80); rec.push(-1);
  assert.deepEqual(Array.from(decode(rec.encode(H)).words), [0x80, 0x80, 0xffff]);
});

test('resim: version mismatch is a hard error unless --force', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resim-'));
  const f = path.join(dir, 'old.txt');
  fs.writeFileSync(f, encode({ ...H, version: '0.9' }, [128, 128, 640]));
  const tool = path.join(ROOT, 'tools/resim.mjs');
  const a = spawnSync(process.execPath, [tool, f], { encoding: 'utf8' });
  assert.equal(a.status, 1); assert.match(a.stderr, /recorded on starfall 0\.9.*--force/);
  const b = spawnSync(process.execPath, [tool, f, '--force'], { encoding: 'utf8' });
  assert.equal(b.status, 0, b.stderr); assert.equal(JSON.parse(b.stdout).frames, 3);
  fs.writeFileSync(f, encode({ ...H, version: GAME_VERSION }, [128, 128, 640]));
  const c = spawnSync(process.execPath, [tool, f], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr); assert.equal(JSON.parse(c.stdout).frames, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});
