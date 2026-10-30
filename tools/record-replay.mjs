// Record a deterministic scripted replay in Node and print its re-simulated hash.
// Usage: node tools/record-replay.mjs <mode> <seed> <frames> <outFile> [script|bot]
// 'script' (default): a fixed input script (sweeps, tapped and held fire, KINDLE when full).
// 'bot': reads sim state each frame (dodge the nearest falling bullet, else steer under the boss or the
// nearest enemy and fire). Both are deterministic, so the same
// arguments always give the same replay string. Used to check that a refactor keeps a run bit-identical:
// record at one commit, then run `node tools/resim.mjs <outFile>` at the next and compare hashes.
import fs from 'node:fs';
import { createSim, GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';
import { packWord } from '../engine/input-word.js';
import { createRecorder } from '../engine/replay.js';

const [mode = 'stage5', seedArg = '5', framesArg = '9000', out, how = 'script'] = process.argv.slice(2);
if (!out) { console.error('usage: node tools/record-replay.mjs <mode> <seed> <frames> <outFile>'); process.exit(2); }
const seed = +seedArg >>> 0, frames = +framesArg;
const sim = createSim({ seed, mode }), rec = createRecorder(4096);
let s = seed || 1;
function botMove(sim) {
  const p = sim.player;
  let threat = 0, best = 1e9;
  for (const b of sim.eb) {
    if (!b.on || b.vy <= 0) continue;
    const dy = p.y - b.y; if (dy < -6 || dy > 70) continue;
    const t = Math.max(0, dy / b.vy), dx = b.x + b.vx * t - p.x;
    if (Math.abs(dx) < 14 && dy < best) { best = dy; threat = dx; }
  }
  for (const e of sim.enemies) {
    if (e.st !== 'dive' && e.st !== 'spark') continue;
    const dy = p.y - e.y; if (dy < -8 || dy > 60) continue;
    const dx = e.x - p.x; if (Math.abs(dx) < 16 && dy < best) { best = dy; threat = dx; }
  }
  if (best < 1e9) { const away = threat > 0 ? -1 : 1; return p.x < 30 ? 1 : p.x > 370 ? -1 : away; }
  let tx = 200;
  if (sim.boss.on) tx = sim.boss.x;
  else { let bd = 1e9; for (const e of sim.enemies) if (e.st !== 'wait') { const d = Math.abs(e.x - p.x); if (d < bd) { bd = d; tx = e.x; } } }
  const d = tx - p.x;
  return Math.abs(d) < 3 ? 0 : Math.max(-1, Math.min(1, d / 20));
}
for (let f = 0; f < frames && !sim.done; f++) {
  s = (Math.imul(s, 1103515245) + 12345) >>> 0;
  const mv = how === 'bot' ? botMove(sim) : ((f / (30 + (s >>> 28))) | 0) % 3 - 1;
  const w = packWord(mv, how === 'bot' || (s >>> 20) % 3 !== 0, f % 9 === 0, sim.meter >= 10, false, 0);
  sim.step(w); rec.push(w); sim.clearEvents();
}
fs.writeFileSync(out, rec.encode({ game: GAME_ID, version: GAME_VERSION, seed, mode }) + '\n');
console.log(JSON.stringify({ mode, seed, frames: sim.frame, score: sim.score, stage: sim.stage, lives: sim.lives, hits: sim.hits, hash: sim.stateHash() }));
