// launch leftovers. (The static <title> part is on hold: tests/lobby-wordmark.test.js keeps the arcade name in
// arcade/brand.js only; see the log.) (b) the cabinet hints say what the keys
// do now (Esc leaves for the lobby); (c) the sim's hook object names each key once, and the comet() hook still
// forces a comet. Node only; tests/w40-lobby-lows-browser.test.js drives the real pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCabinet, PUSH_T1 } from '../arcade/cabinet.js';
import { createSim } from '../games/starfall/sim.js';
import { EV_FX, FX_COMET_TRAIL } from '../games/starfall/defs.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
// keys of the object literal that createSim returns, read from the source (top level of that literal only)
function hookKeys(src) {
  const start = src.indexOf('return {', src.indexOf('// ---------- start ----------'));
  assert.ok(start > 0, 'createSim return object not found');
  let i = start + 'return {'.length, depth = 1, expectKey = true;
  const keys = [];
  const skipWs = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (src.startsWith('/*', i)) { i = src.indexOf('*/', i) + 2; continue; }
      return;
    }
  };
  while (i < src.length && depth > 0) {
    if (depth === 1 && expectKey) {
      skipWs();
      if (src[i] === '}') break;
      let m = /^(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)/.exec(src.slice(i, i + 80));
      if (/^(get|set)\s*[(:,]/.test(src.slice(i, i + 10))) m = /^([A-Za-z_$][\w$]*)/.exec(src.slice(i, i + 80));
      assert.ok(m, 'unexpected token at ' + src.slice(i, i + 30));
      keys.push(m[1]); i += m[0].length; expectKey = false; continue;
    }
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i) + 2; continue; }
    if (c === "'" || c === '"' || c === '`') { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; } i++; continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 1) expectKey = true;
    i++;
  }
  return keys;
}

test('the sim hook object names every key once', () => {
  const keys = hookKeys(read('games/starfall/sim.js'));
  assert.ok(keys.length > 40, 'scan found too few keys: ' + keys.length);
  for (const k of ['step', 'stateHash', 'drain', 'player', 'boss', 'seed', 'comet', 'breakPanels']) assert.ok(keys.includes(k), 'missing key ' + k);
  const dup = keys.filter((k, n) => keys.indexOf(k) !== n);
  assert.deepEqual(dup, [], 'duplicate keys: ' + dup.join(', '));
});

// count comet trail particle events over a stretch of play; hook = call sim.comet() on the first play frame
function cometTrails(hook) {
  const sim = createSim({ seed: 4040, mode: 'arcade' });
  let n = 0, frames = 0;
  const count = (b, o) => { if (b[o] === EV_FX && b[o + 1] === FX_COMET_TRAIL) n++; };
  while (sim.state !== 'play' && frames++ < 2000) { sim.step(0); sim.drain(count); }
  assert.equal(sim.state, 'play');
  if (hook) { assert.equal(typeof sim.comet, 'function'); sim.comet(); }
  for (let k = 0; k < 120; k++) { sim.step(0); sim.drain(count); }
  return { n, tainted: sim.tainted, hash: sim.stateHash() };
}
test('comet() still forces a comet on stage 1 (none comes on its own there) and taints the run', () => {
  const plain = cometTrails(false), forced = cometTrails(true);
  assert.equal(plain.n, 0);
  assert.equal(plain.tainted, false);
  assert.ok(forced.n > 30, 'trail events with the hook: ' + forced.n);
  assert.equal(forced.tainted, true);
  assert.notEqual(forced.hash, plain.hash);
});

// the text lines the cabinet draws on a frame, through its real render path with stub graphics
function cabinetLines(cab) {
  const lines = [];
  const gfx = { reset() {}, clearCanvas() {}, count: () => 0, dot() {}, toViewport() {}, drawDots() {} };
  const crt = { dotsToTexture() {}, quadCorner() {}, composite() {} };
  cab.render(gfx, crt, (s, x, y, c, sc, al) => lines.push({ s, x, al }), 0, 120, false, () => {});
  return lines;
}
test('cabinet hints say what the keys do now (desktop: no coarse pointer in Node)', () => {
  const cab = createCabinet({ W: 400, H: 300, rnd: () => 0.5 });
  for (let k = 0; k < 90; k++) cab.tick(false, false);
  const door = cabinetLines(cab).map(l => l.s);
  assert.deepEqual(door, ['FIRE / CLICK: INSERT COIN   ESC: LOBBY']);
  cab.tick(true, false); // the coin goes in: the dolly
  for (let k = 0; k < 30; k++) cab.tick(false, false);
  const dolly = cabinetLines(cab).map(l => l.s);
  assert.deepEqual(dolly, ['FIRE: SKIP   ESC: LOBBY']);
  for (const s of [...door, ...dolly]) {
    assert.ok(!/ESC: SKIP|ANY KEY/.test(s), 'stale hint: ' + s);
    assert.ok(s.length * 6 - 1 <= 400 - 12, 'hint wider than the field: ' + s);
  }
  // the hint goes away for the last second of the push, as before
  cab.hold(PUSH_T1 - 0.5);
  assert.deepEqual(cabinetLines(cab).map(l => l.s), []);
});
