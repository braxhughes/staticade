// w31 lobby v2, the Node half: the three-machine floor, the wall board's data (lobby-board.js, driven with a fake
// board), and the swing / floor camera math. The browser half is tests/w31-lobby-browser.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MACHINES, START_INDEX, PLATFORM_RACE_NAME } from '../arcade/machines.js';
import { createLobbyBoard, fmtScore, BOARD_ROWS, RANK_WINDOW } from '../arcade/lobby-board.js';
import { createNav, floorPose, floorX, swingAngle, CAB_ANGLE, SWING_TICKS, FLOOR_SPACING, CAM_OFF } from '../arcade/lobby-cam.js';
import { createLeaderboard } from '../leaderboard/api.js';
import { memoryAdapter } from '../leaderboard/storage.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PID = 'w31-player-0001';

test('floor: exactly STACKLIGHT, STARFALL and the platform race, in that order; Starfall the only playable one', () => {
  assert.deepEqual(MACHINES.map(m => m.id), ['stacklight', 'starfall', 'ledgelords']);
  assert.deepEqual(MACHINES.map(m => m.name), ['STACKLIGHT', 'STARFALL', PLATFORM_RACE_NAME]);
  assert.equal(MACHINES[START_INDEX].id, 'starfall');
  assert.deepEqual(MACHINES.map(m => m.playable), [false, true, false]);
  assert.equal(MACHINES[1].sub, 'FIXED SHOOTER', 'Starfall marquee sub is its genre');
  assert.equal(MACHINES[2].genre, 'PLATFORM RACE');
  for (const k of ['edge', 'body', 'dark', 'marqueeTop', 'marqueeBottom', 'marqueeBox']) assert.equal(MACHINES[2].palette[k].length, 3, k);
});

test('the platform race name is kept in one place (arcade/machines.js) and the retired machines are gone', () => {
  const hits = [], gone = [];
  const files = [...fs.readdirSync(path.join(ROOT, 'arcade')).map(f => path.join(ROOT, 'arcade', f)), path.join(ROOT, 'index.html')];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    if (s.includes(PLATFORM_RACE_NAME)) hits.push(path.relative(ROOT, f));
    if (/MOTHRUN|DRIFTLINE|EMBERWALL|attractMaze|attractRoad|attractDome/i.test(s)) gone.push(path.relative(ROOT, f));
  }
  assert.deepEqual(hits, ['arcade/machines.js']);
  assert.deepEqual(gone, []);
  // the twist comment: our own game, not a copy
  const src = fs.readFileSync(path.join(ROOT, 'arcade/machines.js'), 'utf8'), tw = src.slice(src.indexOf('Platform race twist:'), src.indexOf("id: 'ledgelords'"));
  assert.ok(tw.length > 20, 'twist comment above the cabinet');
  for (const w of ['no plumber', 'no pipes', 'no mushrooms', 'no flagpole']) assert.ok(tw.toLowerCase().includes(w), w);
});

// a fake board: n players, scores falling from top; getRank answers best for PID
function fakeLb({ n = 0, top = 50000, best = 0, names, failBoard = false, failRank = false } = {}) {
  const calls = { board: 0, rank: 0 };
  const rows = [];
  for (let i = 0; i < n; i++) rows.push({ rank: i + 1, name: names ? names[i % names.length] : 'P' + i, score: top - i * 100, id: 'e' + i, mode: 'free' });
  return {
    calls,
    async getBoard({ limit }) { calls.board++; if (failBoard) throw Object.assign(new Error('down'), { code: 'offline' }); return rows.slice(0, Math.min(100, limit)); },
    async getRank() { calls.rank++; if (failRank) throw new Error('down'); return { best }; }
  };
}

test('board: 10 rows plus the you-line, from a 50-entry board; the player at #37', async () => {
  const lb = fakeLb({ n: 50, top: 50000, best: 50000 - 36 * 100 });
  const B = createLobbyBoard({ lb, playerId: async () => PID });
  assert.equal(B.state, 'idle');
  const p = B.refresh(); assert.equal(B.state, 'loading');
  await p;
  const s = B.snapshot();
  assert.equal(s.state, 'ok'); assert.equal(s.n, BOARD_ROWS); assert.equal(s.rows.length, 10);
  assert.deepEqual(s.rows.map(r => r.rank), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  assert.equal(s.rows[0].score, '50,000');
  assert.equal(s.you, 'ranked'); assert.equal(s.youRank, '37'); assert.equal(s.youScore, '46,400');
  assert.ok(s.rows.every(r => !r.me), 'not in the top 10: no row highlighted');
  assert.deepEqual(lb.calls, { board: 1, rank: 1 });
});

test('board: 0, 3 and 10 entries; a player ranked #1 is one highlighted row, not two', async () => {
  for (const n of [0, 3, 10]) {
    const B = createLobbyBoard({ lb: fakeLb({ n }), playerId: async () => null });
    await B.refresh();
    assert.equal(B.n, n); assert.equal(B.state, 'ok'); assert.equal(B.you, 'none');
  }
  const B = createLobbyBoard({ lb: fakeLb({ n: 3, top: 9000, best: 9000 }), playerId: async () => PID });
  await B.refresh();
  const s = B.snapshot();
  assert.equal(s.youRank, '1');
  assert.deepEqual(s.rows.map(r => r.me), [true, false, false]);
  assert.equal(s.rows.filter(r => r.score === '9,000').length, 1);
});

test('board: a 7-digit score gets its commas; long names are clipped to fit; unknown glyphs become ?', async () => {
  const B = createLobbyBoard({ lb: fakeLb({ n: 2, top: 1234567, names: ['ABCDEFGHIJ', 'a~b'] }), playerId: async () => null });
  await B.refresh();
  assert.equal(B.rows[0].score, '1,234,567');
  assert.equal(B.rows[0].name, 'ABCDE');
  assert.equal(B.rows[1].name, 'A?B');
  assert.equal(fmtScore(184300), '184,300');
});

test('board: a rank past the one-request window reads 100+ (no extra reads)', async () => {
  const lb = fakeLb({ n: 1000, top: 200000, best: 1000 });
  const B = createLobbyBoard({ lb, playerId: async () => PID });
  await B.refresh();
  assert.equal(B.youRank, RANK_WINDOW + '+');
  assert.deepEqual(lb.calls, { board: 1, rank: 1 });
});

test('board: OFFLINE when the board read fails (and the rank is not asked); a failed rank keeps the rows', async () => {
  const lb = fakeLb({ n: 5, failBoard: true });
  const B = createLobbyBoard({ lb, playerId: async () => PID });
  await B.refresh();
  assert.equal(B.state, 'offline'); assert.equal(B.n, 0); assert.equal(lb.calls.rank, 0);
  const lb2 = fakeLb({ n: 5, failRank: true });
  const B2 = createLobbyBoard({ lb: lb2, playerId: async () => PID });
  await B2.refresh();
  assert.equal(B2.state, 'ok'); assert.equal(B2.n, 5); assert.equal(B2.you, 'unknown');
});

test('board: refreshes started together cost one read', async () => {
  const lb = fakeLb({ n: 4 });
  const B = createLobbyBoard({ lb, playerId: async () => null });
  await Promise.all([B.refresh(), B.refresh(), B.refresh()]);
  assert.equal(lb.calls.board, 1); assert.equal(B.reads, 1);
  await B.refresh(); assert.equal(lb.calls.board, 2, 'a later visit reads again');
});

test('board: works on the real local leaderboard (no runs: empty, not ranked)', async () => {
  const lb = createLeaderboard({ storage: memoryAdapter() });
  const B = createLobbyBoard({ lb, playerId: async () => PID });
  await B.refresh();
  assert.equal(B.state, 'ok'); assert.equal(B.n, 0); assert.equal(B.you, 'none');
});

test('swing: starts at the lobby angle (70-75 degrees, w31b), ends flush, eased at both ends', () => {
  const deg = CAB_ANGLE * 180 / Math.PI;
  assert.ok(deg >= 70 && deg <= 75, 'angle ' + deg);
  assert.equal(swingAngle(0), CAB_ANGLE); assert.equal(swingAngle(1), 0);
  const d = q => swingAngle(q) - swingAngle(q + 1 / SWING_TICKS);
  assert.ok(d(0) < 0.15 * d(0.5) && d(1 - 1 / SWING_TICKS) < 0.15 * d(0.5), 'slow at both ends');
  for (let q = 0; q < 1; q += 1 / SWING_TICKS) assert.ok(swingAngle(q + 1 / SWING_TICKS) <= swingAngle(q), 'monotonic');
});

test('floor camera: rests left of the cabinet looking straight at the wall; a step slides one machine over', () => {
  const nav = createNav(MACHINES.length, START_INDEX), p = new Float32Array(7);
  floorPose(nav, 0, 0, p);
  assert.ok(Math.abs(p[0] - (floorX(START_INDEX) - CAM_OFF)) < 1.2);
  assert.ok(Math.abs(p[3] - p[0]) < 1e-6, 'square at rest');
  nav.go(START_INDEX + 1);
  for (let i = 0; i < 200; i++) nav.tick();
  floorPose(nav, 0, 0, p);
  assert.ok(Math.abs(p[0] - (floorX(START_INDEX + 1) - CAM_OFF)) < 1.2);
  assert.equal(floorX(1) - floorX(0), FLOOR_SPACING);
});
