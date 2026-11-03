// Server-side replay check for every game in server/games.js (Starfall, STACKLIGHT). The server trusts nothing the
// client says about a run: it re-simulates the replay on the same sim the game ships and keeps what the sim says.
// The game is picked by the run's game id (card T6); an id not in the registry is bad_game.
//
// Order (cheap checks first, so a bad claim never costs a full re-sim):
//   1. header: format r1, game (claimed and in the replay, the same registry entry), that game's GAME_VERSION
//      (current only), mode (the game's own mode list), seed, daily day and window (with
//      DAILY_SECRET, the server's seed for that day, today or yesterday only, and no more frames than real time
//      since the run's ticket)
//   2. frame count, read from the run lengths without building the frame array (replay_too_long)
//   3. canonical encoding (one run, one string)
//   4. pass A, our own loop on the game's createSim: no frames after the run ended, no input word with a bit outside
//      the game's inputMask (STACKLIGHT: bits 7 to 15, bad_replay), the run must be finished (game over), and it gives
//      the final score, state hash, stage (STACKLIGHT: level) and the run's signature (server/dedupe.js), each
//      scoring event recorded by the game's sigKey and sigValue (Starfall: frame and points; STACKLIGHT: piece and
//      where it locked)
//   5. pass B, the game's makeVerifyReplay (Starfall: games/starfall/modes.js, the strict verifier the game itself
//      wires in; STACKLIGHT: server/games.js until the game has its own): it must agree with pass A. Defence in depth;
//      it roughly doubles CPU for an honest run (see server/README.md).
// Failures throw LeaderboardError with a code. Returns { score, hash, frames, stage, sig }.
import { LeaderboardError } from '../leaderboard/api.js';
import { decode, encode, b64urlDecode, REPLAY_FORMAT } from '../engine/replay.js';
import { dailySeed } from '../engine/rng.js';
import { todayUTC } from '../games/starfall/modes.js';
import { GAMES } from './games.js';
import { signatureRecorder } from './dedupe.js';
import { maxFramesSince } from './daily.js';

// MAX_RUN_FRAMES (leaderboard/api.js, where the replay cap is derived from it): 216,000 frames = 60 minutes at 60 Hz.
// A full first loop is about 39,000 frames; an hour of play costs about 1 to 2 s of CPU per pass. Longer runs are
// refused rather than letting one request burn minutes of CPU.
import { MAX_RUN_FRAMES } from '../leaderboard/api.js';
export { MAX_RUN_FRAMES };
const DAY_MS = 86400000;
const fail = (code, msg) => { throw new LeaderboardError(code, msg); };

// Sum of run lengths, stopping as soon as it passes `cap`. Same varint rules as engine/replay.js decode().
export function countFrames(body, cap) {
  let bytes;
  try { bytes = b64urlDecode(body); } catch (e) { fail('bad_replay', e.message); }
  let i = 0, frames = 0;
  while (i < bytes.length) {
    for (let k = 0; k < 2; k++) { // word, then run length
      let v = 0, mul = 1;
      for (;;) {
        if (i >= bytes.length) fail('bad_replay', 'replay: truncated body');
        const b = bytes[i++]; v += (b & 127) * mul;
        if (b < 128) break;
        mul *= 128; if (mul > 2 ** 35) fail('bad_replay', 'replay: varint too long');
      }
      if (k === 1) { frames += v; if (frames > cap) return frames; }
    }
  }
  return frames;
}

// games: the registry (server/games.js GAMES); tests may pass their own to make pass A and pass B disagree.
export function makeServerVerifier({ now = Date.now, maxFrames = MAX_RUN_FRAMES, games = GAMES } = {}) {
  const ids = Object.keys(games);
  const gameOf = (id) => (typeof id === 'string' && Object.hasOwn(games, id) ? games[id] : null);
  const strict = {}; // game id -> pass B verifier on the public daily seed, made once per game
  for (const id of ids) strict[id] = games[id].makeVerifyReplay({ now });
  // c: the cleaned fields from validateSubmission (leaderboard/api.js).
  // daily: { seed, issuedAt } when DAILY_SECRET is set and the run's ticket checked out (server/worker.js);
  // undefined without a secret, which keeps the public seed and the plus-or-minus 1 day window exactly as before.
  return function verifyRun(c, daily) {
    const parts = c.replay.split('~');
    if (parts.length !== 6 || parts[0] !== REPLAY_FORMAT) fail('bad_replay', `not an ${REPLAY_FORMAT} replay`);
    const [, rGame, rVersion, seed36, rMode, body] = parts;
    const g = gameOf(c.game);
    if (!g || rGame !== g.id) fail('bad_game', `this server checks ${ids.join(' and ')} runs only, and the replay must be for the claimed game`);
    const GAME_ID = g.id, GAME_VERSION = g.version;
    if (rVersion !== GAME_VERSION || String(c.version) !== GAME_VERSION) {
      // the client shows this as "new version, reload" (a page left open across a deploy runs the old game).
      fail('wrong_version', `new version, reload: the server takes ${GAME_ID} ${GAME_VERSION}, this run is ${rVersion} (claimed ${c.version})`);
    }
    if (!Object.hasOwn(g.modeHeader, c.mode) || g.modeHeader[c.mode] !== rMode) fail('bad_mode', `claimed mode ${c.mode} does not match the replay (${rMode})`);
    if (!/^[0-9a-z]{1,7}$/.test(seed36) || typeof c.seed !== 'number' || parseInt(seed36, 36) !== c.seed) fail('bad_seed', 'claimed seed does not match the replay');
    if (c.mode === 'daily') {
      if (typeof c.dayKey !== 'string') fail('bad_day', 'a daily run needs its dayKey');
      let ds; try { ds = dailySeed(c.dayKey); } catch { fail('bad_day', 'dayKey must be YYYY-MM-DD'); }
      if (daily) {
        // DAILY_SECRET set: the seed the server issued for that day, and today or yesterday only (UTC)
        if (daily.seed !== c.seed) fail('bad_seed', `seed is not the server's daily seed of ${c.dayKey}`);
        const back = Date.parse(todayUTC(now()) + 'T00:00:00Z') - Date.parse(c.dayKey + 'T00:00:00Z');
        if (!(back === 0 || back === DAY_MS)) fail('bad_day', `daily runs are taken only for today or yesterday (UTC); ${c.dayKey} is not`);
      } else {
        if (ds !== c.seed) fail('bad_seed', `seed is not the daily seed of ${c.dayKey}`);
        const off = Math.abs(Date.parse(c.dayKey + 'T00:00:00Z') - Date.parse(todayUTC(now()) + 'T00:00:00Z'));
        if (!(off <= DAY_MS)) fail('bad_day', `daily runs are taken only within 1 day of today (UTC); ${c.dayKey} is outside`);
      }
    }
    const frames = countFrames(body, maxFrames);
    if (frames > maxFrames) fail('replay_too_long', `replay runs over ${maxFrames} frames`);
    // a ticketed daily cannot hold more play than real time since its ticket (plus TICKET_SLACK_S)
    if (daily && c.mode === 'daily' && frames > maxFramesSince(daily.issuedAt, now())) {
      fail('bad_ticket', `the run is ${frames} frames, longer than the time since its ticket`);
    }

    let h;
    try { h = decode(c.replay); } catch (e) { fail('bad_replay', e.message); }
    if (encode(h, h.words) !== c.replay) fail('bad_replay', 'replay is not in canonical form');

    // pass A
    const sim = g.createSim({ seed: h.seed, mode: h.mode });
    const rec = signatureRecorder();
    // the signature (games.js): Starfall [frame, points]; STACKLIGHT [piece, where it locked]
    const w = h.words, mask = g.inputMask, sigKey = g.sigKey, sigValue = g.sigValue == null ? null : g.sigValue;
    // STACKLIGHT: each placement in canonical left-right form (server/games.js makeStacklightCanon); made once
    // per run, then a few integer compares per frame and a board symmetry test on lock frames only
    const canon = g.sigCanon == null ? null : g.sigCanon(sim);
    for (let i = 0; i < w.length; i++) {
      if (sim.done) fail('frames_after_end', `replay carries ${w.length - i} frames after the run ended`);
      if (mask !== null && (w[i] & ~mask) !== 0) fail('bad_replay', `input word at frame ${i} sets a reserved bit`);
      const before = sim.score;
      sim.step(w[i]); sim.clearEvents();
      rec.add(sigKey(sim), before, sim.score, sigValue === null ? undefined : canon === null ? sigValue(sim) : canon(sim, sigValue(sim)));
    }
    if (!sim.done) fail('run_not_finished', 'replay stops before the run is over (game over)');
    const out = { score: sim.score, hash: g.hashOf(sim), frames: sim.frame, stage: g.stageOf(sim), sig: rec.sig };

    // pass B
    const s2 = (daily ? g.makeVerifyReplay({ now, dailySeedOf: () => daily.seed }) : strict[g.id])({ game: c.game, replay: c.replay, seed: c.seed, mode: c.mode, dayKey: c.dayKey, version: c.version });
    if (s2 !== out.score) fail('verify_disagree', 'the game verifier and the server re-sim disagree');
    return out;
  };
}
