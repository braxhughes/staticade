// Regenerates the STACKLIGHT golden values (tests/stacklight-golden.test.js) from the test file's own word script.
// What this is: the reproducible form of the "scratch loader" used to re-record the goldens for GAME_VERSION 2.0.
// It cuts the word script (makePlan, planWord, scriptFor, runScript) out of the test file, runs it in this process on the real sim
// for every GOLDEN entry (name, seed, mode, and the script scriptFor() picks), and prints what the test should store: frames, reason, score,
// lines, stateHash, dayRule and the r1 string, plus how many pieces scored and how many of those locked on the centre
// column. It never writes the test file: a person pastes the values in, and the golden test then checks them two ways
// (stored string re-sims, and the script still produces the stored string).
// Usage: node tools/stacklight-golden.mjs [name filter]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST = path.join(ROOT, 'tests/stacklight-golden.test.js');
const src = fs.readFileSync(TEST, 'utf8');
const a = src.indexOf('// ---------- the fixed word script ----------'), b = src.indexOf('function resim(');
if (a < 0 || b < a) throw new Error('could not find the word script in ' + TEST);
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;
const mod = `
import { Rng, seedFromString } from '${url('engine/rng.js')}';
import { encode } from '${url('engine/replay.js')}';
import { createSim, PH_PLAY, EV_LOCK, EV_CLEAR, EV_TURN } from '${url('games/stacklight/sim.js')}';
import { GAME_ID, GAME_VERSION, COLS, BAR, PLUS, ROT_H, ROT_V } from '${url('games/stacklight/defs.js')}';
import { columnHeight } from '${url('games/stacklight/sim/board.js')}';
${src.slice(a, b)}
export { runScript, scriptFor, encode, GAME_ID, GAME_VERSION };`;
const { runScript, scriptFor, encode, GAME_ID, GAME_VERSION } = await import('data:text/javascript;base64,' + Buffer.from(mod).toString('base64'));
const { createSim } = await import(url('games/stacklight/sim.js'));

// the GOLDEN entries' inputs (the outputs are what this tool prints)
const entries = [...src.matchAll(/\{ name: '([^']+)', seed: (\d+), mode: '(\w+)'/g)]
  .map((m) => ({ name: m[1], seed: +m[2], mode: m[3], script: scriptFor(m[1]) }));
const filter = process.argv[2] || '';
for (const g of entries.filter((e) => e.name.includes(filter))) {
  const { sim, words } = runScript(g.seed, g.mode, g.script);
  const r1 = encode({ game: GAME_ID, version: GAME_VERSION, seed: g.seed, mode: g.mode }, words);
  // scoring pieces and where they locked, from a fresh re-sim of the words
  const re = createSim({ seed: g.seed, mode: g.mode });
  let scoring = 0, centre = 0;
  for (const w of words) {
    const before = re.score; re.step(w); re.clearEvents();
    if (re.score !== before) { scoring++; if (re.ctx.px === 4) centre++; } // the column the scoring piece locked in
  }
  console.log(JSON.stringify({ name: g.name, script: g.script, frames: words.length, reason: sim.reason, score: sim.score,
    lines: sim.lines, hash: sim.stateHash(), dayRule: sim.info().dayRule, scoringPieces: scoring, onCentreColumn: centre,
    replayMatches: sim.replay() === r1 }));
  console.log('r1: ' + r1);
}
