// Test helpers for the server tests (tests/server-*.test.js). Node only; the Worker never imports this.
// Replays are recorded by the real tool, tools/record-replay.mjs, into a temp directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sqliteD1 } from './sqlite-d1.js';
import { createWorker } from './worker.js';
import { createSim, GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { packWord, IDLE_WORD } from '../engine/input-word.js';
import { createRecorder } from '../engine/replay.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lb-server-'));
export const SCHEMA = fs.readFileSync(path.join(ROOT, 'server/schema.sql'), 'utf8');

// Record with tools/record-replay.mjs: returns { replay, score, frames, hash, ... } as the tool prints it.
export function record(mode, seed, frames = 200000, how = 'script') {
  const out = path.join(TMP, `${mode}-${seed}-${frames}-${how}.txt`);
  const info = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'tools/record-replay.mjs'), mode, String(seed), String(frames), out, how], { cwd: ROOT, encoding: 'utf8' }));
  return { ...info, replay: fs.readFileSync(out, 'utf8').trim() };
}

// A scripted honest player with its own input seed, so many different honest runs exist on one game seed.
// 'script' sweeps and taps fire like tools/record-replay.mjs; 'lazy' sweeps slower and fires half the time.
// prefix (optional): input words played first, as given (another run's opening), before the script takes over.
// Plays until game over. Returns { replay, score, frames }.
export function playScripted(seed, inSeed, how = 'script', mode = 'arcade', prefix = null) {
  const sim = createSim({ seed, mode }), rec = createRecorder(4096);
  let s = inSeed || 1;
  for (let f = 0; f < 200000 && !sim.done; f++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const lazy = how === 'lazy';
    const mv = lazy ? ((f / (60 + (s >>> 27))) | 0) % 3 - 1 : ((f / (30 + (s >>> 28))) | 0) % 3 - 1;
    const fire = lazy ? (s >>> 20) % 2 === 0 : (s >>> 20) % 3 !== 0;
    const w = prefix && f < prefix.length ? prefix[f] : packWord(mv, fire, f % 9 === 0, sim.meter >= 10, false, 0);
    sim.step(w); rec.push(w); sim.clearEvents();
  }
  return { replay: rec.encode({ game: GAME_ID, version: GAME_VERSION, seed, mode }), score: sim.score, frames: sim.frame };
}

// A touch player: every frame is a touch word whose steer-to x moves, so no two frames in a row are
// the same word: the densest input an honest client records (4 chars a frame). Plays until game over, or for
// `frames` frames if given (then the run may be unfinished, or carry frames after the end).
export function playTouch(seed, inSeed, frames = 0) {
  const sim = createSim({ seed, mode: 'arcade' }), rec = createRecorder(4096);
  let s = inSeed || 1, x = 200, dx = 1;
  for (let f = 0; frames ? f < frames : (f < 200000 && !sim.done); f++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    if ((s >>> 24) < 8) dx = -dx;
    x += dx * (1 + ((s >>> 16) & 3));
    if (x < 8) { x = 8; dx = 1; } else if (x > 392) { x = 392; dx = -1; }
    const w = packWord(0, (s >>> 20) % 3 !== 0, f % 9 === 0, sim.meter >= 10, true, x);
    if (!sim.done) { sim.step(w); sim.clearEvents(); }
    rec.push(w);
  }
  return { replay: rec.encode({ game: GAME_ID, version: GAME_VERSION, seed, mode: 'arcade' }), score: sim.score, frames: rec.frames, done: sim.done };
}

// A run with no input at all until game over: what a score-0 spammer would send.
export function playIdle(seed) {
  const sim = createSim({ seed, mode: 'arcade' }), rec = createRecorder(64);
  for (let f = 0; f < 200000 && !sim.done; f++) { sim.step(IDLE_WORD); rec.push(IDLE_WORD); sim.clearEvents(); }
  return { replay: rec.encode({ game: GAME_ID, version: GAME_VERSION, seed, mode: 'arcade' }), score: sim.score, frames: sim.frame };
}

export async function makeEnv() {
  const db = sqliteD1();
  await db.exec(SCHEMA);
  return { DB: db };
}

export function post(worker, env, body, { ip = '203.0.113.7', headers = {} } = {}) {
  const init = { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body) };
  return worker.fetch(new Request('https://lb.test/submit', init), env).then(async (r) => ({ status: r.status, headers: r.headers, body: await r.json() }));
}
export function get(worker, env, pathAndQuery) {
  return worker.fetch(new Request('https://lb.test' + pathAndQuery), env).then(async (r) => ({ status: r.status, headers: r.headers, body: r.status === 204 ? null : await r.json() }));
}

export { createWorker };
