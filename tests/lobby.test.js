import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNav, lobbyPose, dollyPose, coinDoorPose, SPACING, STEP_TICKS, BUMP_TICKS, DOLLY_TICKS, LOBBY_FOC, machineX } from '../arcade/lobby-cam.js';
import { MACHINES, START_INDEX } from '../arcade/machines.js';
import { buildCabinetGeometry, DEFAULT_PALETTE, CAB_KEYS, FOC } from '../arcade/cabinet.js';

const run = (nav, n) => { for (let i = 0; i < n; i++) nav.tick(); };

test('machine list: Starfall plus two original COMING SOON machines', () => {
  assert.equal(MACHINES.length, 3);
  assert.equal(MACHINES.filter(m => m.playable).length, 1);
  assert.equal(MACHINES[START_INDEX].id, 'starfall');
  const ids = new Set(MACHINES.map(m => m.id)), names = new Set(MACHINES.map(m => m.name));
  assert.equal(ids.size, 3); assert.equal(names.size, 3);
  for (const m of MACHINES) {
    assert.match(m.name, /^[A-Z]+( [A-Z]+)?$/); assert.ok(m.genre && m.sub && m.glow.length === 3);
    if (m.playable) continue;
    for (const k of ['edge', 'body', 'dark', 'marqueeTop', 'marqueeBottom', 'marqueeBox']) assert.equal(m.palette[k].length, 3, `${m.id}.${k}`);
  }
  // no real game names
  const banned = /PAC|TETRIS|ASTEROIDS|BREAKOUT|ARKANOID|GALAGA|GALAXIAN|INVADERS|OUTRUN|POLE|CENTIPEDE|FROGGER|DONKEY/;
  for (const m of MACHINES) assert.doesNotMatch(m.name, banned);
});

test('nav: step, ease, and stop at the ends with a bump', () => {
  const nav = createNav(5, 2);
  assert.equal(nav.index, 2); assert.equal(nav.moving, false);
  assert.equal(nav.go(3), 'step'); assert.equal(nav.index, 3); assert.equal(nav.moving, true);
  assert.equal(nav.pos(0), 2);
  run(nav, STEP_TICKS / 2); assert.ok(Math.abs(nav.pos(0) - 2.5) < 0.01, 'smoother is symmetric at the midpoint');
  const a = nav.pos(0); run(nav, 1); assert.ok(nav.pos(0) > a, 'monotonic');
  run(nav, STEP_TICKS); assert.equal(nav.moving, false); assert.equal(nav.pos(0), 3);
  assert.equal(nav.go(3), 'none');
  // ends stop, never wrap
  const e = createNav(5, 4);
  assert.equal(e.next(), 'bump'); assert.equal(e.index, 4); assert.equal(e.pos(0.5), 4);
  run(e, BUMP_TICKS); assert.equal(e.moving, false);
  const s = createNav(5, 0); assert.equal(s.prev(), 'bump'); assert.equal(s.index, 0);
});

test('nav: a new target mid-step starts from the current eased position (no jump)', () => {
  const nav = createNav(5, 1);
  nav.go(2); run(nav, 12);
  const p = nav.pos(0);
  nav.go(3);
  assert.ok(Math.abs(nav.pos(0) - p) < 1e-9);
  run(nav, 60); assert.equal(nav.pos(0), 3);
});

test('nav: hold freezes a step for screenshots', () => {
  const nav = createNav(5, 1);
  nav.go(2); nav.hold(10); run(nav, 100);
  assert.ok(nav.pos(0) > 1 && nav.pos(0) < 2); assert.equal(nav.moving, true);
  nav.hold(null); run(nav, STEP_TICKS); assert.equal(nav.pos(0), 2);
});

test('pose: steps over with a turn, back-off and bob, and rests square on the machine', () => {
  const nav = createNav(5, 2), p = new Float32Array(7), q = new Float32Array(7);
  lobbyPose(nav, 0, 0, p);
  assert.ok(Math.abs(p[0] - machineX(2)) < 1.2, 'x on the machine (plus idle sway)');
  assert.equal(p[6], LOBBY_FOC);
  nav.go(3); run(nav, STEP_TICKS / 2);
  lobbyPose(nav, 0, 0, q);
  assert.ok(Math.abs(q[0] - (machineX(2) + SPACING / 2)) < 1.2, 'halfway across');
  assert.ok(q[2] > p[2] + 8, 'backs off mid-step');
  const yawMid = Math.atan2(q[3] - q[0], q[2] - q[5]);
  assert.ok(yawMid > 0.07, 'head turns toward the move');
  run(nav, STEP_TICKS);
  lobbyPose(nav, 0, 0, q);
  assert.ok(Math.abs(Math.atan2(q[3] - q[0], q[2] - q[5])) < 1e-6, 'square again at rest');
});

test('dolly: ends exactly on the cabinet intro first keyframe, focal 300, offset to the machine', () => {
  const from = new Float32Array(7), out = new Float32Array(7), door = new Float32Array(7);
  const mx = machineX(START_INDEX);
  lobbyPose(createNav(5, START_INDEX), 0, 0, from);
  dollyPose(from, mx, 1, out); coinDoorPose(mx, door);
  for (let i = 0; i < 7; i++) assert.ok(Math.abs(out[i] - door[i]) < 1e-4, `k${i}`);
  for (let i = 0; i < 6; i++) assert.equal(door[i], CAB_KEYS[0][i] + (i === 0 || i === 3 ? mx : 0));
  assert.equal(door[6], FOC); assert.equal(FOC, 300);
  dollyPose(from, mx, 0, out);
  for (let i = 0; i < 7; i++) assert.ok(Math.abs(out[i] - from[i]) < 1e-4);
  assert.ok(DOLLY_TICKS > 30);
  // eased: speed is zero at both ends
  const a = new Float32Array(7), b = new Float32Array(7);
  dollyPose(from, mx, 0.01, a); dollyPose(from, mx, 0.5, b);
  assert.ok(Math.abs(a[2] - from[2]) < 0.2 * Math.abs(b[2] - from[2]));
});

test('cabinet geometry builder keeps the intro dot counts', () => {
  const room = buildCabinetGeometry(DEFAULT_PALETTE, 'STARFALL', 'A LANTERN CAT ARCADE', () => 0.5, true, 9000);
  const bare = buildCabinetGeometry(DEFAULT_PALETTE, 'STARFALL', 'A LANTERN CAT ARCADE', () => 0.5, false, 9000);
  assert.equal(room.n - bare.n, 946);
  assert.ok(bare.n > 4000 && bare.n < 9000);
  for (let i = 0; i < bare.n; i++) assert.ok(Number.isFinite(bare.X[i] + bare.Y[i] + bare.Z[i]));
});
