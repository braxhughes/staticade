// STACKLIGHT attract mode (design B.9, slice T5): after 30 s idle on the title, play the best all-time replay of THIS game version,
// re-simulated live, with a banner. No matching replay: the bundled demo replay (games/stacklight/demo-replay.js). Neither
// matches this version: the board table only. Plays up to 20 s, then shows the table for 20 s, and repeats.
// No DOM, no audio: main.js owns drawing and input and plays no sound for it (sim events go to the effects only).
// Same shape as games/starfall/attract.js (which is bound to Starfall's sim, so this is its own file).
import { decode } from '../../engine/replay.js';
import { createSim } from './sim.js';
import { GAME_ID, GAME_VERSION, REPLAY_MODES, INPUT_MASK } from './defs.js';

export const IDLE_TICKS = 1800;   // 30 s on the title
export const PHASE_TICKS = 1200;  // 20 s per phase

// a decoded replay is playable here only if it is this game, this version, a real solo mode (never a test start) and has no reserved bits
function playable(r, game, version) {
  if (r.game !== game || r.version !== version || REPLAY_MODES.indexOf(r.mode) < 0) return false;
  for (let i = 0; i < r.words.length; i++) if (r.words[i] & ~INPUT_MASK) return false;
  return true;
}

export function pickDemo(str, game = GAME_ID, version = GAME_VERSION) {
  if (typeof str !== 'string' || !str) return null;
  let r; try { r = decode(str); } catch (e) { return null; }
  return playable(r, game, version) ? { kind: 'demo', name: '', score: 0, seed: r.seed, mode: r.mode, words: r.words } : null;
}

// the best all-time run whose replay is playable on this version, or null
export async function pickBest(lb, game = GAME_ID, version = GAME_VERSION) {
  const rows = await lb.getBoard({ game, board: 'all', limit: 100, unique: false });
  for (const row of rows) {
    const rec = await lb.getReplay(row.id);
    if (!rec || rec.game !== game || rec.version !== version) continue;
    let r; try { r = decode(rec.replay); } catch (e) { continue; }
    if (playable(r, game, version)) return { kind: 'best', name: row.name, score: row.score, seed: r.seed, mode: r.mode, words: r.words };
  }
  return null;
}

// fallback: a second board (the local one) tried when lb (the remote board) cannot be read or has no playable run.
export function createAttract({ lb, fallback = null, demo = null, game = GAME_ID, version = GAME_VERSION, playTicks = PHASE_TICKS, tableTicks = PHASE_TICKS }) {
  const A = {
    phase: 'off',      // off | wait | play | table
    kind: 'none',      // best | demo | none
    banner: '', sim: null, t: 0, i: 0, source: null, ready: false, token: 0,
    // choose the source; works while the title is still showing, so it is ready at the 30 s mark
    async prepare() {
      const tok = ++A.token;
      let src = null;
      try { src = await pickBest(lb, game, version); } catch (e) { src = null; }
      if (!src && fallback && fallback !== lb) { try { src = await pickBest(fallback, game, version); } catch (e) { src = null; } }
      if (!src) src = pickDemo(demo, game, version);
      if (tok !== A.token) return;
      A.source = src; A.ready = true;
      A.kind = src ? src.kind : 'none';
      A.banner = !src ? '' : src.kind === 'best' ? 'BEST RUN: ' + src.name + ' ' + src.score : 'DEMO RUN';
      if (A.phase === 'wait') A.next();
    },
    start() { A.phase = 'wait'; A.t = 0; A.sim = null; if (!A.ready) A.prepare(); else A.next(); },
    stop() { A.phase = 'off'; A.sim = null; A.ready = false; A.token++; },
    next() { // pick the phase that follows 'wait' or the end of a phase
      A.t = 0;
      if (!A.source) { A.phase = 'table'; A.sim = null; return; }
      A.sim = createSim({ seed: A.source.seed, mode: A.source.mode }); A.i = 0; A.phase = 'play';
    },
    // one 60 Hz tick. beforeStep(sim) and onEvent get the sim's effects only (sound stays off).
    update(beforeStep, onEvent) {
      if (A.phase === 'wait' || A.phase === 'off') return;
      A.t++;
      if (A.phase === 'play') {
        const w = A.source.words, s = A.sim;
        if (A.i < w.length && !s.done) {
          if (beforeStep) beforeStep(s);
          s.step(w[A.i++]);
          if (onEvent) s.drain(onEvent); else s.clearEvents();
        }
        if (A.i >= w.length || s.done || A.t >= playTicks) { A.phase = 'table'; A.t = 0; }
      } else if (A.t >= tableTicks) { if (A.source) A.next(); else A.t = 0; }
    }
  };
  return A;
}
