// Lobby wall boards per game: each lobby wall board reads ITS OWN game. Node half: real createLeaderboard + createLobbyBoard, runs
// verified by each game's own replay check, one store and one player id for both games.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decode, createRecorder } from '../engine/replay.js';
import { dailySeed } from '../engine/rng.js';
import { createLeaderboard } from '../leaderboard/api.js';
import { memoryAdapter } from '../leaderboard/storage.js';
import { createSim } from '../games/stacklight/sim.js';
import * as SL from '../games/stacklight/modes.js';
import * as SF from '../games/starfall/modes.js';
import { DEMO_REPLAY as SF_DEMO } from '../games/starfall/demo-replay.js';
import { createSim as createSfSim, GAME_ID as SF_ID, GAME_VERSION as SF_VERSION } from '../games/starfall/sim.js';
import { createLobbyBoard, browserBoard } from '../arcade/lobby-board.js';
import { MACHINES } from '../arcade/machines.js';

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY = '2026-11-01';
const PID = 'w68-player-0001';
const PAT = [-4, 4, -2, 2, 0, -3, 3];

function slRun(seed, mode = 'arcade') {
  const sim = createSim({ seed, mode });
  let f = 0;
  while (!sim.done && f < 30000) {
    const c = Math.floor(f / 40), r = f % 40, dir = PAT[c % PAT.length];
    let w = 0;
    if (r < Math.abs(dir) * 4 && r % 4 === 0) w = dir < 0 ? 9 : 18; else if (r === 30) w = 32;
    sim.step(w); sim.clearEvents(); f++;
  }
  return { sim, replay: sim.replay() };
}
function sfRun(seed, frames, mode = 'arcade') {
  const words = decode(SF_DEMO).words, sim = createSfSim({ seed, mode }), rec = createRecorder(256);
  for (let i = 0; i < frames && i < words.length; i++) { sim.step(words[i]); rec.push(words[i]); sim.clearEvents(); }
  return { sim, rec, seed };
}
function makeLb() {
  const slV = SL.makeVerifyReplay({ now: () => NOW }), sfV = SF.makeVerifyReplay({ now: () => NOW });
  return createLeaderboard({ storage: memoryAdapter(), now: () => NOW, verifyReplay: x => (x.game === 'stacklight' ? slV(x) : sfV(x)) });
}
async function postSl(lb, seed, name, pid = PID) {
  const modes = SL.createModes({ lb, kv: SL.memoryKv(), now: () => NOW }), run = modes.begin(SL.MODE_FREE, seed); modes.claim(run);
  const p = slRun(seed); await modes.submit(run, p.sim, p.replay, name, pid); return p.sim.score;
}
async function postSf(lb, frames, name, pid = PID) {
  const modes = SF.createModes({ lb, kv: SL.memoryKv(), now: () => NOW }), run = modes.begin('free', 777); modes.claim(run);
  const p = sfRun(777, frames);
  await modes.submit(run, p.sim, p.rec.encode({ game: SF_ID, version: SF_VERSION, seed: 777, mode: 'arcade' }), name, pid); return p.sim.score;
}
// A ranked Daily run in each game, on today's public daily seed (the local board's check accepts it)
async function postSlDaily(lb, name, pid = PID) {
  const modes = SL.createModes({ lb, kv: SL.memoryKv(), now: () => NOW }), run = modes.begin(SL.MODE_DAILY); modes.claim(run);
  assert.equal(run.dayKey, DAY); assert.equal(run.ranked, true);
  const p = slRun(run.seed, 'daily'); await modes.submit(run, p.sim, p.replay, name, pid); return p.sim.score;
}
async function postSfDaily(lb, name, pid = PID) {
  const modes = SF.createModes({ lb, kv: SL.memoryKv(), now: () => NOW }), run = modes.begin(SF.MODE_DAILY); modes.claim(run);
  assert.equal(run.dayKey, DAY); assert.equal(run.seed, dailySeed(DAY)); assert.equal(run.ranked, true);
  const p = sfRun(run.seed, 900, 'daily');
  await modes.submit(run, p.sim, p.rec.encode({ game: SF_ID, version: SF_VERSION, seed: run.seed, mode: 'daily' }), name, pid); return p.sim.score;
}
const wall = (lb, game) => createLobbyBoard({ lb, game, playerId: async () => PID });

test('the same player id in both games: each lobby board lists only its own run, rank and you-line', async () => {
  const lb = makeLb();
  const slScore = await postSl(lb, 5, 'SLT'), sfScore = await postSf(lb, 900, 'STR');
  assert.ok(slScore > 0 && sfScore > 0 && slScore !== sfScore, `scores ${slScore} ${sfScore}`);
  const A = wall(lb, 'stacklight'), B = wall(lb, 'starfall');
  await Promise.all([A.refresh(), B.refresh()]);
  const a = A.snapshot(), b = B.snapshot();
  assert.deepEqual(a.rows.map(r => r.name), ['SLT']); assert.deepEqual(b.rows.map(r => r.name), ['STR']);
  assert.equal(a.rows[0].me, true); assert.equal(b.rows[0].me, true);
  assert.equal(a.you, 'ranked'); assert.equal(b.you, 'ranked');
  assert.equal(a.youRank, '1'); assert.equal(b.youRank, '1');
  assert.equal(a.rows[0].score, a.youScore); assert.equal(b.rows[0].score, b.youScore);
  assert.notEqual(a.youScore, b.youScore, 'each you-line is that game\'s own best');
  assert.equal(a.youScore.replace(/,/g, ''), String(slScore)); assert.equal(b.youScore.replace(/,/g, ''), String(sfScore));
});

test('a player with a run in only one game has no run, no rank on the other wall', async () => {
  const lb = makeLb();
  await postSl(lb, 5, 'SLT');
  const B = wall(lb, 'starfall'); await B.refresh();
  assert.equal(B.snapshot().n, 0); assert.equal(B.snapshot().you, 'none');
  const lb2 = makeLb();
  await postSf(lb2, 900, 'STR');
  const A = wall(lb2, 'stacklight'); await A.refresh();
  assert.equal(A.snapshot().n, 0); assert.equal(A.snapshot().you, 'none');
});

test('through the real local API: a score posted in one game is absent from every other board and rank, both directions', async () => {
  for (const [from, to] of [['stacklight', 'starfall'], ['starfall', 'stacklight']]) {
    const lb = makeLb();
    // A Free Play run AND a ranked Daily run, so the daily check has something to leak
    if (from === 'stacklight') { await postSl(lb, 5, 'ONLY'); await postSlDaily(lb, 'DAY'); } else { await postSf(lb, 900, 'ONLY'); await postSfDaily(lb, 'DAY'); }
    // first: both runs really are on the source game's own boards (else the absence below proves nothing)
    const own = {};
    for (const board of ['all', 'season', 'daily']) own[board] = (await lb.getBoard({ game: from, board, key: board === 'daily' ? DAY : undefined, unique: false })).map(r => r.name).sort();
    assert.deepEqual(own, { all: ['DAY', 'ONLY'], season: ['DAY', 'ONLY'], daily: ['DAY'] }, `${from} own boards`);
    for (const board of ['all', 'season', 'daily']) {
      const rows = await lb.getBoard({ game: to, board, key: board === 'daily' ? DAY : undefined, unique: false });
      assert.equal(rows.length, 0, `${from} run leaked to ${to} ${board}`);
    }
    const rk = await lb.getRank({ game: to, playerId: PID });
    assert.ok(!rk || !rk.best, `${from} best leaked into ${to} rank: ` + JSON.stringify(rk));
    assert.equal((await lb.getBoard({ game: from, board: 'all' })).length, 1, 'it is on its own board (one best per player)');
  }
});

// No default game id on the browser board path. (What each cabinet really draws is checked in the
// browser by tests/w68-drawn-board-browser.test.js, which replaces the old source-text pin.)
// (createLobbyBoard keeps its 'starfall' default for now: an older lobby test relies on it.)
test('the lobby board needs a game id: browserBoard (the browser path) throws without one and keeps the one it is given', () => {
  assert.deepEqual(MACHINES.filter(m => m.playable).map(m => m.id), ['stacklight', 'starfall']);
  for (const bad of [undefined, '', null, 7]) assert.throws(() => browserBoard('', bad), /game id required/, String(bad));
  for (const id of ['stacklight', 'starfall']) assert.equal(browserBoard('', id).game, id);
});
