// How much CPU one server-side replay check costs. node server/time-resim.mjs
// Times the server verifier (pass A, our loop, plus pass B, the game's strict verifier) on:
//   short: the scripted run of tools/record-replay.mjs (arcade, seed 2), a finished run of about 4,200 frames
//   full:  the sim-bot's seed 1 input stream (tools/sim-bot.mjs), a whole first loop of about 39,000 frames.
//          The sim-bot plays with infinite lives (so it can never be submitted); the timing re-runs its exact
//          inputs on the same sim with that option, which costs the same per frame as a real run.
// Reports per pass: first (cold, as on a fresh Worker) and the median of the next runs (warm), CPU milliseconds.
import { cpuUsage } from 'node:process';
import { createSim, GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { packWord } from '../engine/input-word.js';
import { createRecorder } from '../engine/replay.js';
import { botWord } from '../tools/sim-bot.mjs';
import { makeServerVerifier } from './verify.js';

const cpuMs = (fn) => { const c0 = cpuUsage(); const r = fn(); const c = cpuUsage(c0); return [(c.user + c.system) / 1000, r]; };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

// the record-replay 'script' policy, arcade seed 2 (same arithmetic as tools/record-replay.mjs)
function scriptRun(seed) {
  const sim = createSim({ seed, mode: 'arcade' }), rec = createRecorder(4096);
  let s = seed || 1;
  for (let f = 0; f < 200000 && !sim.done; f++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const w = packWord(((f / (30 + (s >>> 28))) | 0) % 3 - 1, (s >>> 20) % 3 !== 0, f % 9 === 0, sim.meter >= 10, false, 0);
    sim.step(w); rec.push(w); sim.clearEvents();
  }
  return { replay: rec.encode({ game: GAME_ID, version: GAME_VERSION, seed, mode: 'arcade' }), score: sim.score, frames: sim.frame };
}
function botWords(seed, goalStage = 16, limit = 120000) {
  const sim = createSim({ seed, mode: 'arcade', infiniteLives: true }), words = [];
  while (sim.frame < limit && !(sim.stage >= goalStage && sim.state === 'play')) { const w = botWord(sim); words.push(w); sim.step(w); sim.clearEvents(); }
  return Uint16Array.from(words);
}

const verify = makeServerVerifier();
const short = scriptRun(2);
const c = { game: GAME_ID, replay: short.replay, seed: 2, mode: 'free', version: GAME_VERSION };
const runs = [];
for (let i = 0; i < 8; i++) runs.push(cpuMs(() => verify(c))[0]);
console.log(`short run: ${short.frames} frames, score ${short.score}, server verify (2 passes): cold ${runs[0].toFixed(1)} ms, warm median ${median(runs.slice(1)).toFixed(1)} ms CPU`);

const words = botWords(1);
const one = () => { const sim = createSim({ seed: 1, mode: 'arcade', infiniteLives: true }); for (let i = 0; i < words.length; i++) { sim.step(words[i]); sim.clearEvents(); } return sim.frame; };
const full = [];
for (let i = 0; i < 6; i++) full.push(cpuMs(one)[0]);
const warm = median(full.slice(1));
console.log(`full loop: ${words.length} frames, one re-sim pass: cold ${full[0].toFixed(1)} ms, warm median ${warm.toFixed(1)} ms CPU (${(warm * 1000 / words.length).toFixed(2)} us/frame)`);
console.log(`full loop, server verify = 2 passes: about ${(2 * warm).toFixed(0)} ms CPU warm. Free plan limit: 10 ms per request.`);
