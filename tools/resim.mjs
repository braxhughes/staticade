// Re-simulate a Starfall replay headlessly and print the result.
// Usage: node tools/resim.mjs <replayFile> [--force]
//   The file holds one replay string (see engine/replay.js).
//   Prints JSON {score, frames, stage, lives, hash}. Exits 1 if the replay can't be used.
//
// Rules:
// - Game version mismatch is a hard error: a replay only re-simulates on the sim version that
//   recorded it. --force runs it anyway (the result is then not trustworthy).
// - Runs changed by a test hook (SF.god, SF.fill, SF.dive, SF.comet, SF.breakPanels) carry a
//   '+dev' mode suffix. Those hooks change the sim outside its recorded inputs, so a '+dev'
//   replay (god mode included) will NOT re-simulate to the same result. resim warns and runs it.
import fs from 'node:fs';
import { decode } from '../engine/replay.js';
import { createSim, GAME_ID, GAME_VERSION } from '../games/starfall/sim.js';

export function resim(str, { force = false } = {}) {
  const r = decode(str);
  if (r.game !== GAME_ID) throw new Error(`replay is for "${r.game}", not ${GAME_ID}`);
  if (r.version !== GAME_VERSION) {
    if (!force) throw new Error(`replay was recorded on ${GAME_ID} ${r.version}, this sim is ${GAME_VERSION} (use --force to run anyway)`);
    process.stderr.write(`warning: --force: replay version ${r.version}, sim version ${GAME_VERSION}\n`);
  }
  if (/\+dev/.test(r.mode)) process.stderr.write('warning: this run used test hooks (+dev, e.g. god mode); it will not re-simulate exactly\n');
  const sim = createSim({ seed: r.seed, mode: r.mode });
  for (let i = 0; i < r.words.length; i++) { sim.step(r.words[i]); sim.clearEvents(); }
  return { score: sim.score, frames: sim.frame, stage: sim.stage, lives: sim.lives, hash: sim.stateHash() };
}

if (process.argv[1] && process.argv[1].endsWith('resim.mjs')) {
  const args = process.argv.slice(2), force = args.includes('--force'), file = args.find(a => !a.startsWith('--'));
  if (!file) { console.error('usage: node tools/resim.mjs <replayFile> [--force]'); process.exit(2); }
  try { console.log(JSON.stringify(resim(fs.readFileSync(file, 'utf8'), { force }))); }
  catch (e) { console.error('resim: ' + e.message); process.exit(1); }
}
