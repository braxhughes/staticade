// The local STACKLIGHT board shown on this version must not show runs saved under an older one on this device.
// (Written for 2.0; since 3.0, the runs of "this version" here are 3.0 and the old runs stay 1.0.)
// leaderboard/api.js getBoard takes an optional `version` (keeps runs whose stored replay has that major version);
// games/stacklight/modes.js versionBoard(lb) is the read view the page uses for its local board. Starfall never passes a
// version, so its boards read exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createLeaderboard } from '../leaderboard/api.js';
import { memoryAdapter } from '../leaderboard/storage.js';
import { versionBoard } from '../games/stacklight/modes.js';
import { GAME_VERSION } from '../games/stacklight/defs.js';

const PID = (n) => `w64bplayer${String(n).padStart(4, '0')}`;
// no verifyReplay: the board takes the claim as given, which is what a play-test device's old 1.0 rows look like here
async function seeded() {
  const storage = memoryAdapter();
  const lb = createLeaderboard({ storage, now: () => Date.UTC(2026, 10, 2, 12), instanceId: 'w64b' });
  const runs = [
    // [player, name, score, version, game]
    [1, 'OLD', 1813885, '1.0', 'stacklight'], // a 1.0 run with lock resets: much higher than any 2.0 run
    [1, 'NEW', 300000, '3.0', 'stacklight'],  // the same player on this version (3.0)
    [2, 'TWO', 250000, '3.0', 'stacklight'],
    [3, 'ONE', 900000, '1.0', 'stacklight'],
    [4, 'SF1', 5000, '2.0', 'starfall'],
    [5, 'SF2', 7000, '1.0', 'starfall']
  ];
  let i = 0;
  for (const [p, name, score, version, game] of runs) {
    await lb.submitScore({ game, playerId: PID(p), name, score, replay: `r1~${game}~${version}~${++i}~free~AAAA${i}`, seed: i, mode: 'free', version });
  }
  return { storage, lb };
}
const names = (rows) => rows.map((r) => r.name);

test('getBoard with no version shows every run, as before (Starfall and the old behaviour unchanged)', async () => {
  const { lb } = await seeded();
  assert.deepEqual(names(await lb.getBoard({ game: 'stacklight' })), ['OLD', 'ONE', 'TWO'], 'one best per player, any version');
  assert.deepEqual(names(await lb.getBoard({ game: 'stacklight', unique: false })), ['OLD', 'ONE', 'NEW', 'TWO']);
  assert.deepEqual(names(await lb.getBoard({ game: 'starfall' })), ['SF2', 'SF1'], 'Starfall: both runs, whatever their version');
  assert.deepEqual(names(await lb.getBoard({ game: 'starfall', board: 'season' })), ['SF2', 'SF1']);
});

test('getBoard with a version keeps only that major version, then picks each player\'s best among those', async () => {
  const { lb } = await seeded();
  const v2 = await lb.getBoard({ game: 'stacklight', version: '3.0' });
  assert.deepEqual(names(v2), ['NEW', 'TWO'], 'player 1\'s 1.0 best does not hide their 3.0 run');
  assert.deepEqual(v2.map((r) => r.rank), [1, 2], 'ranks counted after the filter');
  assert.deepEqual(names(await lb.getBoard({ game: 'stacklight', version: '3.3' })), ['NEW', 'TWO'], 'major version match');
  assert.deepEqual(names(await lb.getBoard({ game: 'stacklight', version: '1.0', unique: false })), ['OLD', 'ONE']);
  assert.deepEqual(names(await lb.getBoard({ game: 'stacklight', board: 'season', version: '3.0' })), ['NEW', 'TWO']);
  assert.deepEqual(names(await lb.getBoard({ game: 'stacklight', version: '3.0', limit: 1, offset: 1 })), ['TWO']);
  assert.deepEqual(names(await lb.getBoard({ game: 'stacklight', version: '4.0' })), []);
  assert.deepEqual(names(await lb.getBoard({ game: 'stacklight', version: '2.0' })), []);
});

test('a board row with no stored replay is kept (it cannot be shown to be another version)', async () => {
  const { storage, lb } = await seeded();
  const all = await storage.get('board:stacklight:all');
  const lone = { ...all[0], id: 'w64bnoreplay', name: 'NOR', score: 1, pid: PID(9) };
  await storage.set('board:stacklight:all', [...all, lone]);
  assert.deepEqual(names(await lb.getBoard({ game: 'stacklight', version: '3.0', unique: false })), ['NEW', 'TWO', 'NOR']);
});

test('versionBoard: the STACKLIGHT page\'s local board view shows only this version\'s runs; writes pass through', async () => {
  const { lb } = await seeded();
  assert.equal(GAME_VERSION, '3.0');
  const view = versionBoard(lb);
  const rows = await view.getBoard({ game: 'stacklight', board: 'all', limit: 10 });
  assert.deepEqual(names(rows), ['NEW', 'TWO'], 'no 1.0 run on the 3.0 table');
  assert.ok(!rows.some((r) => r.score === 1813885), 'the 1.0 high score is not shown');
  assert.deepEqual(names(await view.getBoard({ game: 'stacklight', board: 'all', limit: 100, unique: false })), ['NEW', 'TWO'], 'what attract reads');
  const id = (await view.submitScore({ game: 'stacklight', playerId: PID(6), name: 'ADD', score: 260000, replay: 'r1~stacklight~3.0~99~free~ZZZZ', seed: 99, mode: 'free', version: '3.0' })).id;
  assert.ok(id, 'a submit through the view is stored');
  assert.deepEqual(names(await view.getBoard({ game: 'stacklight' })), ['NEW', 'ADD', 'TWO']);
  assert.equal((await view.getReplay(id)).version, '3.0', 'other reads pass through');
});

test('the page reads its local board through versionBoard; Starfall\'s page never passes a version', () => {
  const sl = fs.readFileSync(new URL('../games/stacklight/main.js', import.meta.url), 'utf8');
  assert.match(sl, /const localBoard = versionBoard\(lb\);/);
  assert.match(sl, /const boardLb = remote \? gateReads\(remote\) : localBoard;/, 'the table, rank and attract read the filtered view');
  assert.match(sl, /fallback: remote \? localBoard : null/, 'attract\'s local fallback too');
  assert.ok(!/\blb\.getBoard\(/.test(sl), 'no unfiltered local board read left in the page');
  for (const f of ['../games/starfall/main.js', '../games/starfall/modes.js']) {
    const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
    for (const call of src.match(/getBoard\(\{[^}]*\}/g) || []) assert.ok(!/version/.test(call), f + ': ' + call);
    assert.ok(!/versionBoard/.test(src), f);
  }
});
