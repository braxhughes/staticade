// Same intent as replay-hardening's "version mismatch" test, but keyed to the live
// GAME_VERSION so a version bump cannot break it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encode } from '../engine/replay.js';
import { GAME_ID, GAME_VERSION } from '../games/starfall/defs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tool = path.join(ROOT, 'tools/resim.mjs');

test('resim: current version re-sims; any other version is a hard error unless --force', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resimv-'));
  const f = path.join(dir, 'r.txt');
  const H = { game: GAME_ID, version: GAME_VERSION, seed: 9, mode: 'arcade' };
  fs.writeFileSync(f, encode(H, [128, 128, 640]));
  const ok = spawnSync(process.execPath, [tool, f], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr); assert.equal(JSON.parse(ok.stdout).frames, 3);
  fs.writeFileSync(f, encode({ ...H, version: GAME_VERSION + '.old' }, [128, 128, 640]));
  const bad = spawnSync(process.execPath, [tool, f], { encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /--force/);
  const forced = spawnSync(process.execPath, [tool, f, '--force'], { encoding: 'utf8' });
  assert.equal(forced.status, 0, forced.stderr);
  fs.rmSync(dir, { recursive: true, force: true });
});
