// Camera feel checks for the lobby (rule: eased, never a linear slide; head bob; eased dolly).
// These are numeric checks on lobby-cam.js, written to fail if any easing is made linear or the bob is removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNav, lobbyPose, dollyPose, machineX, STEP_TICKS } from '../arcade/lobby-cam.js';
import { START_INDEX } from '../arcade/machines.js';

test('step slide: near-zero speed at both ends, fast in the middle', () => {
  const nav = createNav(5, 1); nav.go(2);
  const p = [nav.pos(0)];
  for (let i = 0; i < STEP_TICKS; i++) { nav.tick(); p.push(nav.pos(0)); }
  const mid = STEP_TICKS >> 1, vMid = p[mid + 1] - p[mid];
  assert.ok(vMid > 0.04, 'moves at mid-step');
  assert.ok(p[1] - p[0] < 0.1 * vMid, 'starts almost still');
  assert.ok(p[STEP_TICKS] - p[STEP_TICKS - 1] < 0.1 * vMid, 'lands almost still');
});

test('head bob: the eye height moves mid-step and is level at rest', () => {
  const nav = createNav(5, 1), pose = new Float32Array(7);
  lobbyPose(nav, 0, 0, pose); const rest = pose[1];
  nav.go(2); let maxDev = 0;
  for (let i = 0; i < STEP_TICKS; i++) { nav.tick(); lobbyPose(nav, 0, 0, pose); maxDev = Math.max(maxDev, Math.abs(pose[1] - rest)); }
  assert.ok(maxDev > 0.8, `bob amplitude ${maxDev}`);
  lobbyPose(nav, 0, 0, pose); assert.ok(Math.abs(pose[1] - rest) < 1e-6);
});

test('select dolly: position, gaze and focal length all ease in and out', () => {
  const from = new Float32Array(7), a = new Float32Array(7), mx = machineX(START_INDEX);
  lobbyPose(createNav(5, START_INDEX), 0, 0, from);
  const end = dollyPose(from, mx, 1, new Float32Array(7));
  const frac = (lo, hi, q) => { dollyPose(from, mx, q, a); let d = 0, tot = 0; for (let i = lo; i < hi; i++) { d += (a[i] - from[i]) ** 2; tot += (end[i] - from[i]) ** 2; } return Math.sqrt(d / tot); };
  // position (xyz) and gaze (target xyz): tiny fraction of the way early, almost all the way late; symmetric at q=.5 is not required
  for (const [name, lo, hi] of [['position', 0, 3], ['gaze', 3, 6]]) {
    assert.ok(frac(lo, hi, 0.04) < 0.01, `${name} starts almost still`);
    assert.ok(frac(lo, hi, 0.96) > 0.99, `${name} lands almost still`);
  }
  dollyPose(from, mx, 0.04, a); assert.ok((a[6] - from[6]) / (end[6] - from[6]) < 0.01, 'focal starts almost still');
  dollyPose(from, mx, 0.96, a); assert.ok((a[6] - from[6]) / (end[6] - from[6]) > 0.99, 'focal lands almost still');
  // gaze is cubic-eased (slower to start than position), so it is not just a copy of the position curve
  assert.ok(frac(3, 6, 0.3) < frac(0, 3, 0.3), 'gaze trails position');
});
