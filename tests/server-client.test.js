// The optional remote leaderboard (server/client.js) against the real Worker, and the game's own submit path
// (games/starfall/modes.js createModes) running unchanged on top of it. Off by default.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from '../engine/replay.js';
import { createSim, GAME_ID } from '../games/starfall/sim.js';
import { createModes, memoryKv } from '../games/starfall/modes.js';
import { createLeaderboard } from '../leaderboard/api.js';
import { createRemoteLeaderboard, pickLeaderboard, REMOTE_LEADERBOARD_URL } from '../server/client.js';
import { record, makeEnv, createWorker } from '../server/fixtures.mjs';

let RUN;
before(() => { RUN = record('arcade', 2); });
const wire = (env, w = createWorker()) => (url, init) => w.fetch(new Request(url, init), env);

test('off by default: the config URL is empty and pickLeaderboard keeps the local leaderboard', () => {
  assert.equal(REMOTE_LEADERBOARD_URL, '');
  const local = createLeaderboard();
  assert.equal(pickLeaderboard(local), local);
  const remote = pickLeaderboard(local, 'https://lb.test', { fetch: () => { throw new Error('no'); } });
  assert.notEqual(remote, local);
  assert.equal(remote.remote, true);
});

test('the game\'s own submit (createModes) works unchanged against the server', async () => {
  const env = await makeEnv();
  const lb = createRemoteLeaderboard({ url: 'https://lb.test/', fetch: wire(env) });
  const modes = createModes({ lb, kv: memoryKv() });
  const run = modes.begin('free', 2);
  modes.claim(run);
  const h = decode(RUN.replay);
  const sim = createSim({ seed: h.seed, mode: h.mode });
  for (const w of h.words) { sim.step(w); sim.clearEvents(); }
  assert.ok(modes.canSubmit(run, sim));
  const res = await modes.submit(run, sim, RUN.replay, 'ACE', 'remote-player-1');
  assert.equal(res.score, RUN.score);
  assert.equal(res.placements.all, 1);
  const rows = await lb.getBoard({ game: GAME_ID, board: 'all', limit: 10 });
  assert.deepEqual(rows.map((r) => [r.rank, r.name, r.score]), [[1, 'ACE', RUN.score]]);
  const rp = await lb.getReplay(rows[0].id);
  assert.equal(rp.replay, RUN.replay);
  assert.equal(await lb.getReplay('00000-nope'), null);
  const rank = await lb.getRank({ game: GAME_ID, playerId: 'remote-player-1' });
  assert.equal(rank.best, RUN.score);
  assert.equal(typeof (await lb.getSeason()).id, 'number');
  assert.ok((await lb.listLeagues()).length > 0);
});

test('server errors come back as LeaderboardError codes; an unreachable server is "offline"', async () => {
  const env = await makeEnv();
  const lb = createRemoteLeaderboard({ url: 'https://lb.test', fetch: wire(env) });
  const run = { game: GAME_ID, playerId: 'remote-player-2', name: 'ACE', score: RUN.score + 1, replay: RUN.replay, seed: 2, mode: 'free', version: '2.5' };
  await assert.rejects(lb.submitScore(run), { name: 'LeaderboardError', code: 'score_mismatch' });
  const down = createRemoteLeaderboard({ url: 'https://lb.test', fetch: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(down.getBoard({ game: GAME_ID }), { code: 'offline' });
  assert.throws(() => createRemoteLeaderboard({ url: 'ftp://x' }), TypeError);
});
