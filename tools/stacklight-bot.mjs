// STACKLIGHT balance bot (design F.1 row T7, D.7 BOT tiers, B.8 pacing). Measure only: this file never edits the game.
//
// Usage:
//   node tools/stacklight-bot.mjs --seeds 1-5                 tier 9 Free Play on each seed, prints the band table, PASS or FAIL
//   node tools/stacklight-bot.mjs --tiers --seeds 1-20        the 9x9 tier win table, PASS or FAIL
//   node tools/stacklight-bot.mjs --seeds 1-5 --tier 5        one other tier
//   node tools/stacklight-bot.mjs --seeds 1-5 --gravity a,b,...(20 numbers, levels 1 to 20)   run against a candidate table
//   node tools/stacklight-bot.mjs --reaction-sweep [--plan-ahead] [--reactions 10-20] [--seeds 1-5]
//                                 tier-9 placement, 0% mistakes, one reaction at a time: where the reaction cliff sits
//   node tools/stacklight-bot.mjs --cause [--seeds 1-10]   tiers 1-9 as D.7, with reaction forced to 12, with 0% mistakes
//   node tools/stacklight-bot.mjs --options               candidate rule sets for the owner (proposals, never applied; runs
//                                 itself again with the tools/stacklight-rules.mjs hook for lock delay / resets / lines)
//   node tools/stacklight-bot.mjs --score-band [--seeds 1-20]   the rules-unchanged alternative: a score-percentile band
//   node tools/stacklight-bot.mjs --band score [--good-tier 8] [--seeds 1-20]   the B.8 gate, PASS or FAIL.
//                                 PASS rule: in both fields (plan ahead OFF and ON) p75 and p90 equal the frozen SCORE_BAND,
//                                 tier 8 (good player) median is inside [p75, p90], tier 6 is below p75, tier 9 above p90
//                                 It refuses --move, --tap-gap and --plan-ahead (exit 2): the field is fixed
//   --plan-ahead (any run): the bot reads NEXT in the entry delay and starts its wait at the lock (see word() and early())
//   --move hold|tap|best [--tap-gap N] (band, --tiers, --reaction-sweep): which controller presses. hold (default) is
//                                 the original controller; tap = every column a separate 1-frame press, one per N frames
//                                 (default 4 = 15 a second); best = per move, hold or tap, whichever arrives sooner
//   node tools/stacklight-bot.mjs --move-options [--seeds 1-5] [--reactions 8,12,16,20,24] [--score-seeds 1-20] [--no-score]
//                                 [--seen-lock] [--only A,B]   every option (NOW, A, B, C, LONG, D, E, side checks, SCORE)
//                                 under five controllers. --seen-lock: see createBot
//   node tools/stacklight-bot.mjs --wall-search [--walls 15,17] [--locks 16,12,10,8,6] [--resets 12,4,2,1,0] [--seeds 1-5]
//                                 [--reactions 8,12,16,20,24] [--seen-lock]   which lock / resets are a wall for every controller
// Exit 0 on PASS, 1 on FAIL, 2 on bad usage. Runtimes go to stderr, so stdout is identical run to run. The sweeps, --cause,
// --options and --score-band measure only and exit 0.
//
// WHAT THE BOT IS ALLOWED TO DO (the likely objections, answered up front)
//   * It drives createSim only through sim.step(word). The word is one of the C.2 input words: LEFT / RIGHT held, SOFT held,
//     LEFT / RIGHT / HARD / ROTATE pressed. It never moves a piece, edits the grid, or reads the RNG.
//   * It reads what a player sees: the board (sim.grid, copied into the bot's own array), the current piece (info().piece),
//     the level. It could read NEXT (info().next) but the choice below does not use it. It never reads the deck beyond
//     NEXT, never reads a stream, never steps or clones a sim. With --plan-ahead it reads NEXT[0] only (tested), and only
//     between a lock and the next spawn: the piece it will get, on the board it will land on.
//   * Plan ahead timing (B.6): it first sees a lock one frame after it (as it first sees a piece one frame after the spawn),
//     waits its reaction from there, and predicts the spawn frame from the public delays (8, or 28 after a clear). In the
//     delay it sends only what the sim carries: a rotate in the 8 entry frames, a held direction (no press). A tap or a drop
//     waits for the spawn frame.
//   * "Can I reach that spot in time?" is answered by a small model of the piece that the bot owns (kinematic below). It runs
//     on the bot's own board copy and uses only the public rules (B.6: gravity table, 11 / 2 auto-repeat, lock delay). It is
//     the player's feel for "will it get there before it lands", written down. It is not the sim and shares no state with it.
//   * No Math.random, no Date. The only randomness is the mistake roll from new Rng(streamSeed(seed, 'bot')) (D.7, C.6),
//     drawn exactly twice per piece whatever the tier, so the stream position never depends on what was chosen.
//
// HOW IT PICKS A PLACEMENT (fixed by the brief and D.7; nothing here was tuned to land in the band)
//   Candidates: BAR flat at pivot columns 1..7, BAR upright at columns 0..8, PLUS at columns 1..7.
//   A candidate counts only if the bot's own model, running the same controller the bot then uses, reaches that column and
//   turn and locks there. Candidates it cannot reach are dropped and counted ("skipped").
//   Each reachable candidate is lowered onto the board the way the sim does (MELT, then clear full rows), and ranked by a
//   lexicographic key, most important first:
//     1. lowest resulting stack (highest column after clears)           weight 1e9 per row
//     2. FIT: KEY best, then FLAT, then none                            1e8 per step below KEY
//     3. most rows cleared                                              1e7 per row fewer
//     4. fewest holes (always 0 in solo: a melted cell lands on its column)   1e5 per hole
//     5. flattest top (sum of height steps between neighbours)          100 per step
//     6. least travel from the spawn (|col - 4| + 1 if a turn is needed) 1 per step
//     7. lower column, flat before upright (stable order)
//   Ties inside a row are broken only by the order above, so the choice is a pure function of the board.
//   Mistake (D.7): chance 4 x (9 - tier) percent, then the 2nd or 3rd best (a second roll). Reaction (D.7): 12 + 4 x (9 - tier)
//   frames of neutral words after a piece appears, before the first press.
//
// HOW IT PRESSES (human-like limits)
//   One controller turns "target column and turn" into words: rotate once if needed (press), taps of at most one per TAP_GAP
//   (4) frames when 3 or fewer columns away, and a held direction (the sim's real auto-repeat: first repeat after 11 frames,
//   then every 2) when 4 or more away, released the frame the piece shows the target column; then HARD DROP (press).
//   While a piece rests, the same presses slide it along the stack inside the lock delay, exactly as a player would.
import { createSim } from '../games/stacklight/sim.js';
import {
  COLS, TOTAL_ROWS, SPAWN_ZONE_ROW, EMPTY, BAR, PLUS, ROT_H, ROT_V, SPAWN_COL, GRAVITY, SUB_ROW, SOFT_DROP_G, RUN_CAP,
  AUTO_REPEAT_FIRST, AUTO_REPEAT_EVERY, LOCK_RESETS, lockDelayFor, FIT_NONE, FIT_FLAT, FIT_KEY, CELL_BAR, CELL_PLUS,
  IN_LEFT, IN_RIGHT, IN_LEFT_PRESS, IN_RIGHT_PRESS, IN_HARD_PRESS, IN_ROT_PRESS, NEUTRAL, streamSeed,
  SPAWN_ROW, ENTRY_DELAY, CLEAR_DELAY
} from '../games/stacklight/defs.js';
import * as defs from '../games/stacklight/defs.js';
import { Rng } from '../engine/rng.js';
import { SHAPE_BAR_H, SHAPE_BAR_V, SHAPE_PLUS, SHAPE_N, shapeOf, fits, meltInto } from '../games/stacklight/sim/piece.js';
import { fullRowMask, clearRows, spawnZoneUsed, popcount } from '../games/stacklight/sim/board.js';

export const BAND_LEVEL_MIN = 13, BAND_LEVEL_MAX = 17, BAND_FRAMES_MIN = 21600, BAND_FRAMES_MAX = 36000;
// --band score: the frozen field percentiles of B.8. Score at 10 min (final score if the run ended sooner),
// tiers 1-9 as D.7, seeds 1-20, one field per plan ahead setting, 180 runs each. pN = sorted[floor(N/100 x 180)].
// The same numbers are in the STACKLIGHT design document, B.8 (tests/w52d-score-band.test.js checks they agree).
export const SCORE_BAND = Object.freeze({
  seeds: '1-20', goodTier: 8, belowTier: 6, aboveTier: 9,
  // re-frozen for GAME_VERSION 2.0 (no lock resets). 1.0: off 384595 / 1813885, on 2384700 / 2869070
  // re-frozen again (the lock timer never pauses in the air): off p75 297425 became 296580
  // re-frozen for GAME_VERSION 3.0 (D119 instant lock, D122): 2.0 was off 296580 / 364910, on 394270 / 417830
  off: Object.freeze({ p75: 178040, p90: 205495 }),
  on: Object.freeze({ p75: 241870, p90: 272270 })
});
export const TAP_GAP = 4, HOLD_MIN = 4, MODEL_LIMIT = 400;
// plan ahead: a held direction is started in the delay only if its charge (11 frames) is full by the spawn frame, so the
// first step happens on the spawn frame, in the air, before gravity. A shorter charge would move later than a press on
// the spawn frame itself (which moves at once), and at instant gravity a late first step can no longer pass a taller column.
export const EARLY_HOLD_MIN = AUTO_REPEAT_FIRST;
export const reactionFor = tier => 12 + 4 * (9 - tier);
export const mistakePercentFor = tier => 4 * (9 - tier);

// ---------- the controller: target (col, turn) in, one input word per frame out ----------
// The same object type drives the bot's real presses and its model of them, so the model predicts what will be pressed.
// move: 'hold' (default, today's controller: taps for 1 to 3 columns, a held direction for 4 or more) or 'tap'
// (every column is its own 1-frame press, at most one press per `gap` frames, never a held direction, so never an
// auto-repeat). gap: frames from one sideways press to the next (default TAP_GAP = 4, 15 presses a second).
export class Controller {
  constructor(type, tcol, trot, move = 'hold', gap = TAP_GAP) {
    this.type = type; this.tcol = tcol; this.trot = trot; this.move = move; this.gap = gap;
    this.holdMin = move === 'tap' ? Infinity : HOLD_MIN;
    this.last = 0; this.sinceTap = gap; this.holding = 0; this.rotSent = 0; this.failed = false;
  }
  copy() { const c = new Controller(this.type, this.tcol, this.trot, this.move, this.gap); c.last = this.last; c.sinceTap = this.sinceTap; c.holding = this.holding; c.rotSent = this.rotSent; c.failed = this.failed; return c; }
  // col, rot: what the piece shows right now. pre > 0: the piece is not out yet, its spawn frame is pre frames away.
  next(col, rot, pre = 0) {
    let w = NEUTRAL;
    this.sinceTap++;
    if (pre > 0) return this.early(pre);
    const needRot = this.type === BAR && rot !== this.trot;
    if (needRot) {
      if ((this.last & IN_ROT_PRESS) === 0) { if (this.rotSent >= 2) this.failed = true; else { w |= IN_ROT_PRESS; this.rotSent++; } }
    }
    const d = this.tcol - col;
    if (d === 0) {
      this.holding = 0;
      if (!needRot || this.failed) w |= IN_HARD_PRESS;
    } else {
      const dir = d < 0 ? -1 : 1, hb = dir < 0 ? IN_LEFT : IN_RIGHT, pb = dir < 0 ? IN_LEFT_PRESS : IN_RIGHT_PRESS;
      if (this.holding === dir) w |= hb;
      else if ((d < 0 ? -d : d) >= this.holdMin) { this.holding = dir; w |= hb | pb; }
      else { this.holding = 0; if (this.sinceTap >= this.gap) { w |= hb | pb; this.sinceTap = 0; } }
    }
    this.last = w;
    return w;
  }
  // plan ahead (--plan-ahead), entry delay only: send just what B.6 carries into the spawn frame. A rotate pressed inside
  // the 8 entry frames is applied on the spawn frame. A held direction charges the auto-repeat, which moves on the spawn
  // frame once charged. A sideways press in the delay is not buffered, so taps (1 to 3 columns) wait for the spawn frame,
  // and no sideways or drop press is ever sent in the delay.
  early(pre) {
    let w = NEUTRAL;
    if (this.type === BAR && this.trot !== ROT_H && this.rotSent === 0 && pre <= ENTRY_DELAY) { w |= IN_ROT_PRESS; this.rotSent = 1; }
    const d = this.tcol - SPAWN_COL;
    if ((d < 0 ? -d : d) >= this.holdMin && pre >= EARLY_HOLD_MIN) {
      // the held bit only: a sideways press here would be thrown away by the sim, the held bit alone starts the charge
      const dir = d < 0 ? -1 : 1;
      w |= dir < 0 ? IN_LEFT : IN_RIGHT;
      this.holding = dir;
    }
    this.last = w;
    return w;
  }
}

// ---------- the bot's own model of a falling piece (public rules B.6; its own board copy) ----------
export class PieceModel {
  constructor() { this.grid = new Uint8Array(COLS * TOTAL_ROWS); this.reset(0, 0, 0, 0, 0, 1); }
  // pre: entry-delay frames still to run before the spawn frame (0 = the piece is already out)
  reset(type, c, r, rot, g, level, pre = 0) {
    this.type = type; this.c = c; this.r = r; this.rot = rot; this.g = g; this.level = level;
    this.sub = 0; this.lockT = 0; this.resets = 0; this.arDir = 0; this.arT = 0; this.prev = 0; this.locked = false;
    this.pre = pre; this.turnBuf = 0;
  }
  shape() { return shapeOf(this.type, this.rot); }
  resting() { return !fits(this.grid, this.shape(), this.c, this.r - 1); }
  // one frame; returns true when the piece locks
  step(w) {
    const edge = w & ~this.prev; this.prev = w;
    const active = this.pre === 0; // the charge runs in the delay too, but moves only from the spawn frame (B.6)
    let move = 0;
    if ((edge & IN_LEFT_PRESS) && (edge & IN_RIGHT_PRESS)) { this.arDir = 0; this.arT = 0; }
    else if (edge & IN_LEFT_PRESS) { this.arDir = -1; this.arT = AUTO_REPEAT_FIRST; move = -1; }
    else if (edge & IN_RIGHT_PRESS) { this.arDir = 1; this.arT = AUTO_REPEAT_FIRST; move = 1; }
    else {
      const hL = w & IN_LEFT, hR = w & IN_RIGHT;
      if ((this.arDir < 0 && !hL) || (this.arDir > 0 && !hR)) { this.arDir = 0; this.arT = 0; }
      if (this.arDir === 0) {
        if (hL && !hR) { this.arDir = -1; this.arT = AUTO_REPEAT_FIRST; } else if (hR && !hL) { this.arDir = 1; this.arT = AUTO_REPEAT_FIRST; }
      } else {
        if (this.arT > 0) this.arT--;
        if (this.arT === 0 && active) { move = this.arDir; this.arT = AUTO_REPEAT_EVERY; }
      }
    }
    if (this.pre > 0) { // an entry-delay frame: a rotate inside the 8 entry frames is kept for the spawn frame; nothing moves
      if ((edge & IN_ROT_PRESS) && this.pre <= ENTRY_DELAY) this.turnBuf = 1;
      this.pre--;
      return false;
    }
    const grid = this.grid;
    const turnNow = (edge & IN_ROT_PRESS) !== 0 || this.turnBuf !== 0;
    this.turnBuf = 0;
    if (turnNow && this.type === BAR && this.rot === ROT_H) {
      const was = this.resting();
      if (fits(grid, SHAPE_BAR_V, this.c, this.r)) { this.rot = ROT_V; if (was && this.resets < LOCK_RESETS) { this.resets++; this.lockT = 0; } }
    }
    if (move !== 0) {
      const was = this.resting();
      if (fits(grid, this.shape(), this.c + move, this.r)) { this.c += move; if (was && this.resets < LOCK_RESETS) { this.resets++; this.lockT = 0; } }
    }
    if (edge & IN_HARD_PRESS) { const sh = this.shape(); while (fits(grid, sh, this.c, this.r - 1)) this.r--; this.locked = true; return true; }
    const sh = this.shape();
    if (fits(grid, sh, this.c, this.r - 1)) {
      this.sub += this.g;
      while (this.sub >= SUB_ROW && fits(grid, sh, this.c, this.r - 1)) { this.r--; this.sub -= SUB_ROW; }
    }
    if (!fits(grid, sh, this.c, this.r - 1)) {
      this.sub = 0; this.lockT++;
      if (this.lockT > lockDelayFor(this.level)) { this.locked = true; return true; } // D119: delay = frames after the first rest
    }
    return false;
  }
}

// ---------- scoring a finished placement ----------
const scratch = new Uint8Array(COLS * TOTAL_ROWS), meltOut = new Int8Array(15);
function evaluate(grid, type, c, r, rot) {
  scratch.set(grid);
  const sh = shapeOf(type, rot);
  const melted = meltInto(scratch, sh, c, r, type === BAR ? CELL_BAR : CELL_PLUS, meltOut);
  const fit = melted !== 0 ? FIT_NONE : sh === SHAPE_BAR_H ? FIT_FLAT : sh === SHAPE_PLUS ? FIT_KEY : FIT_NONE;
  const mask = fullRowMask(scratch), rows = popcount(mask);
  if (rows > 0) clearRows(scratch, mask);
  const topOut = spawnZoneUsed(scratch);
  let maxH = 0, holes = 0, bump = 0, prevH = -1;
  for (let col = 0; col < COLS; col++) {
    let h = 0;
    for (let row = TOTAL_ROWS - 1; row >= 0; row--) if (scratch[row * COLS + col] !== EMPTY) { h = row + 1; break; }
    for (let row = 0; row < h; row++) if (scratch[row * COLS + col] === EMPTY) holes++;
    if (h > maxH) maxH = h;
    if (prevH >= 0) bump += h > prevH ? h - prevH : prevH - h;
    prevH = h;
  }
  const travel = (c > SPAWN_COL ? c - SPAWN_COL : SPAWN_COL - c) + (type === BAR && rot === ROT_V ? 1 : 0);
  return maxH * 1e9 + (FIT_KEY - fit) * 1e8 + (3 - rows) * 1e7 + holes * 1e5 + bump * 100 + travel + (topOut ? 1e11 : 0);
}

// ---------- the bot ----------
// reaction and mistakePct default to the tier's (D.7); the sweeps set them directly. planAhead: see early() and word().
// move / tapGap: which controller turns a chosen placement into presses ('hold', 'tap' or 'best', see Controller
// and plan()), and the frames from one sideways tap to the next. The default ('hold', 4) is the original bot exactly.
export const MOVES = ['hold', 'tap', 'best'];
export function checkMove(move, tapGap) {
  if (!MOVES.includes(move)) throw new Error('bot: move must be hold, tap or best');
  if (!Number.isInteger(tapGap) || tapGap < TAP_GAP || tapGap > 60) throw new Error('bot: tapGap must be an integer 4 to 60 (4 frames = 15 taps a second, about the fastest human tapping)');
}
// seenLock (default off so the default bot is unchanged): when it plans a piece that is already resting, the bot's
// model starts from the lock time already used and the resets already spent (info().piece.lockT / resets: what a player
// sees as "it has been sitting there"), not from a fresh piece. Off, the model can think it has more time than it has.
// GAME_VERSION 3.0 (D119): it also starts from the piece's sub-row counter (how far into the next row it has
// fallen). With instant lock the landing frame is the lock frame, so a model that starts the fall at 0 lands a frame
// late and misses; that is the bot's planning, not the model's physics, which is what seenLock is for.
export function createBot({ seed, tier = 9, reaction, mistakePct, planAhead = false, move = 'hold', tapGap = TAP_GAP, seenLock = false }) {
  checkMove(move, tapGap);
  if (reaction === undefined) reaction = reactionFor(tier);
  if (mistakePct === undefined) mistakePct = mistakePercentFor(tier);
  if (!Number.isInteger(reaction) || reaction < 1 || reaction > 200) throw new Error('bot: reaction must be an integer 1 to 200');
  if (!Number.isInteger(mistakePct) || mistakePct < 0 || mistakePct > 100) throw new Error('bot: mistakePct must be 0 to 100');
  const rng = new Rng(streamSeed(seed, 'bot')); // its own stream, never the sim's
  const model = new PieceModel();
  const cand = [];            // reusable candidate list
  const bot = {
    tier, reaction, mistakePct, planAhead: !!planAhead, rng, move, tapGap,
    stats: { pieces: 0, plans: 0, skipped: 0, forced: 0, missed: 0, mistakes: 0, early: 0, pickHold: 0, pickTap: 0 },
    // per piece state
    spawned: -1, wait: 0, ctl: null, planFrames: 0, lastCol: 0, lastRot: 0,
    // plan ahead state: inGap = between a lock and the next spawn; spawnAt = the frame the next piece appears (B.6);
    // ctlEarly = ctl was planned in the gap for the piece about to spawn; linesSeen = lines while the last piece was out
    inGap: false, gapFor: -1, spawnAt: -1, ctlEarly: false, linesSeen: 0,
    word(sim) {
      const info = sim.info();
      const p = info.piece;
      if (info.phase === 'over' || info.done) { this.closeOut(); return NEUTRAL; }
      if (p === null) return this.gap(sim, info);
      if (info.spawned !== this.spawned) { // a new piece is on screen
        if (this.ctlEarly) this.ctlEarly = false; // the plan made in the gap is for this piece: keep it
        else {
          this.closeOut();
          this.ctl = null; this.planFrames = 0;
          // without planning the clock starts now (first sight, a frame after the spawn frame); with planning it
          // started at the lock and keeps running (only the run's first piece starts here)
          if (!this.inGap) this.wait = this.reaction;
        }
        this.spawned = info.spawned; this.inGap = false;
        this.stats.pieces++;
      }
      this.lastCol = p.col; this.lastRot = p.rot; this.linesSeen = info.lines;
      if (this.wait > 0) { this.wait--; return NEUTRAL; }
      if (this.ctl === null) this.ctl = this.plan(sim.grid, p.type === 'BAR' ? BAR : PLUS, p.col, p.row, p.rot, info.level, 0, seenLock ? { lockT: p.lockT, resets: p.resets, sub: sim.ctx.sub } : null);
      if (++this.planFrames > MODEL_LIMIT) return IN_HARD_PRESS; // a plan that has not finished in 400 frames is dropped
      return this.ctl.next(p.col, p.rot);
    },
    // between a lock and the next spawn (entry delay, or clear delay then entry delay)
    gap(sim, info) {
      if (!this.planAhead || this.spawned < 0) { this.closeOut(); return NEUTRAL; } // no plan ahead, or before the first piece
      if (this.inGap && info.spawned !== this.gapFor) {
        // the piece this gap was for came out and locked on its spawn frame (a hard drop sent on that frame), so the bot
        // never saw it in play. Count it, and check it against the plan (it was at the spawn column, flat: see below).
        this.ctlEarly = false; this.inGap = false; this.spawned = info.spawned; this.stats.pieces++;
      }
      if (!this.ctlEarly) this.closeOut();
      if (!this.inGap) {
        // the first frame the bot sees the lock: the board is final and NEXT shows the coming piece. The wait for the
        // next piece starts here. The spawn frame follows from B.6: 8 frames, or 28 when the lock cleared rows (visible:
        // LINES went up). A lock on frame L is first seen on frame L + 1, and the next piece's first frame is L + 9 / L + 29.
        this.inGap = true; this.gapFor = info.spawned; this.ctl = null; this.ctlEarly = false; this.planFrames = 0;
        this.spawnAt = info.frame + (info.lines !== this.linesSeen ? CLEAR_DELAY + ENTRY_DELAY : ENTRY_DELAY);
        this.linesSeen = info.lines; // a piece that locks unseen (above) must be compared with these lines, not older ones
        this.wait = this.reaction;
      }
      if (this.wait > 0) { this.wait--; return NEUTRAL; }
      const pre = this.spawnAt - info.frame;
      if (pre < 0) throw new Error('bot: plan ahead lost the spawn frame');
      if (this.ctl === null) {
        // only NEXT (one piece) is read; it will appear at the spawn column and row, flat (B.2)
        const type = info.next[0] === 'BAR' ? BAR : PLUS;
        this.ctl = this.plan(sim.grid, type, SPAWN_COL, SPAWN_ROW, ROT_H, info.level, pre);
        this.ctlEarly = true; this.stats.early++;
      }
      ++this.planFrames;
      // on the spawn frame the piece is where B.2 puts it; if this word hard drops it, it locks there unseen
      if (pre === 0) { this.lastCol = SPAWN_COL; this.lastRot = ROT_H; }
      return this.ctl.next(SPAWN_COL, ROT_H, pre);
    },
    // after a lock: did the piece end where the plan said?
    closeOut() {
      if (this.ctl !== null) {
        if (this.lastCol !== this.ctl.tcol || (this.ctl.type === BAR && this.lastRot !== this.ctl.trot)) this.stats.missed++;
        this.ctl = null;
      }
    },
    // grid: the board the piece will land on; (type, col, row, rot): the piece now, or where it will spawn;
    // pre: entry-delay frames before the spawn frame (0 = the piece is out)
    plan(grid, type, col, row, rot, level, pre, seen = null) {
      const g = GRAVITY[level], gap = this.tapGap, single = this.move === 'best' ? null : this.move;
      cand.length = 0; this.stats.plans++;
      // run one controller on the model; returns the frame it first shows the target (column and turn), or -1 if it does
      // not lock there. The model is left at the lock.
      const tryMove = (tc, tr, mv) => {
        const ctl = new Controller(type, tc, tr, mv, gap);
        model.grid.set(grid);
        model.reset(type, col, row, rot, g, level, pre);
        if (seen !== null) { model.lockT = seen.lockT; model.resets = seen.resets; model.sub = seen.sub; }
        let locked = false, arrive = -1;
        for (let t = 0; t < MODEL_LIMIT; t++) {
          locked = model.step(ctl.next(model.c, model.rot, model.pre));
          if (arrive < 0 && model.pre === 0 && model.c === tc && (type !== BAR || model.rot === tr)) arrive = t;
          if (locked) break;
        }
        if (!locked || model.c !== tc || (type === BAR && model.rot !== tr) || ctl.failed) return -1;
        return arrive;
      };
      const addCand = (tc, tr) => {
        let mv = single;
        if (single === null) {
          // 'best': the controller that shows the target sooner on the bot's own model; a tie goes to hold
          const aH = tryMove(tc, tr, 'hold'), aT = tryMove(tc, tr, 'tap');
          if (aH < 0 && aT < 0) { this.stats.skipped++; return; }
          mv = aH >= 0 && (aT < 0 || aH <= aT) ? 'hold' : 'tap';
          if (mv === 'hold') tryMove(tc, tr, 'hold'); // the tap path ran last: put the model back at the hold path's lock
        } else if (tryMove(tc, tr, mv) < 0) { this.stats.skipped++; return; }
        cand.push({ key: evaluate(model.grid, type, model.c, model.r, model.rot) + cand.length * 1e-3, tc, tr, mv });
      };
      if (type === BAR) {
        for (let c = 1; c <= COLS - 2; c++) if (rot === ROT_H) addCand(c, ROT_H);
        for (let c = 0; c < COLS; c++) addCand(c, ROT_V);
      } else for (let c = 1; c <= COLS - 2; c++) addCand(c, ROT_H);
      // two draws per piece at every tier: the stream position never depends on what was chosen
      const roll = rng.int(100), which = rng.int(2);
      if (cand.length === 0) { this.stats.forced++; const f = new Controller(type, col, rot, single || 'hold', gap); return f; }
      cand.sort((a, b) => a.key - b.key);
      let pick = 0;
      if (roll < this.mistakePct && cand.length > 1) { pick = 1 + which; if (pick >= cand.length) pick = cand.length - 1; this.stats.mistakes++; }
      if (single === null) { if (cand[pick].mv === 'tap') this.stats.pickTap++; else this.stats.pickHold++; }
      return new Controller(type, cand[pick].tc, cand[pick].tr, cand[pick].mv, gap);
    }
  };
  return bot;
}

// ---------- one whole run ----------
export const MARK_6MIN = 21600, MARK_10MIN = 36000;
// stopAt: stop the run after this many frames (default: never; the run ends at top out or the 60-min cap).
// levelAt[L]: the first frame the run was at level L (-1 = never).
export function playRun({ seed, tier = 9, mode = 'arcade', reaction, mistakePct, planAhead = false, move = 'hold', tapGap = TAP_GAP, stopAt = Infinity, seenLock = false }) {
  const sim = createSim({ seed, mode });
  const bot = createBot({ seed, tier, reaction, mistakePct, planAhead, move, tapGap, seenLock });
  let level20At = -1, score6 = -1, score10 = -1;
  const levelAt = new Array(21).fill(-1);
  while (!sim.done && sim.frame < stopAt) {
    sim.step(bot.word(sim)); sim.clearEvents();
    const f = sim.frame;
    if (levelAt[sim.level] < 0) levelAt[sim.level] = f;
    if (level20At < 0 && sim.level === 20) level20At = f;
    if (f === MARK_6MIN) score6 = sim.score; else if (f === MARK_10MIN) score10 = sim.score;
  }
  bot.closeOut();
  const frames = sim.frame;
  if (score6 < 0) score6 = sim.score; if (score10 < 0) score10 = sim.score; // ended before the mark: the final score
  return {
    seed, tier, level: sim.level, frames, minutes: frames / 3600, lines: sim.lines, score: sim.score, reason: sim.reason,
    hash: sim.stateHash(), stats: bot.stats, replay: sim.replay(), level20At, score6, score10, levelAt
  };
}

// ---------- rule overrides (candidate rule sets, measured in this process only, never applied) ----------
// gravity: the sim reads the exported GRAVITY array from defs.js at call time, so a candidate table is written into that
// array here and put back afterwards (defs.js on disk is untouched).
// lockDelay / resets / linesPerLevel: defs.js exports these as const, so nothing outside defs.js can change them. They
// work only when tools/stacklight-rules.mjs is loaded first (node --import): it changes the text of defs.js as Node
// loads it, in memory, so that those three are read from a settable value. The sim's own code is what runs; no file on
// disk changes. Without that hook, asking for them throws.
export const rulesHookActive = () => typeof defs.__stacklightSetRules === 'function';
const intsIn = (t, n, lo, hi) => Array.isArray(t) && t.length === n && t.every(v => Number.isInteger(v) && v >= lo && v <= hi);
export function checkRules(rules) {
  if (rules === null || rules === undefined) return;
  if (typeof rules !== 'object') throw new Error('rules: an object or null');
  for (const k of Object.keys(rules)) if (!['gravity', 'lockDelay', 'resets', 'linesPerLevel'].includes(k)) throw new Error('rules: unknown key ' + k);
  if (rules.gravity !== undefined && !intsIn(rules.gravity, 20, 1, 5376)) throw new Error('rules.gravity: 20 integers 1 to 5376 (levels 1 to 20)');
  if (rules.lockDelay !== undefined && !intsIn(rules.lockDelay, 20, 0, 255)) throw new Error('rules.lockDelay: 20 integers 0 to 255 (levels 1 to 20)');
  if (rules.resets !== undefined && !(Number.isInteger(rules.resets) && rules.resets >= 0 && rules.resets <= 99)) throw new Error('rules.resets: an integer 0 to 99');
  if (rules.linesPerLevel !== undefined && !(Number.isInteger(rules.linesPerLevel) && rules.linesPerLevel >= 1 && rules.linesPerLevel <= 99)) throw new Error('rules.linesPerLevel: an integer 1 to 99');
  if ((rules.lockDelay !== undefined || rules.resets !== undefined || rules.linesPerLevel !== undefined) && !rulesHookActive())
    throw new Error('rules: lockDelay, resets and linesPerLevel need node --import ./tools/stacklight-rules.mjs');
}
export function withRules(rules, fn) {
  if (typeof fn !== 'function') throw new Error('withRules: fn must be a function');
  const kind = fn.constructor && fn.constructor.name;
  if (kind === 'AsyncFunction' || kind === 'AsyncGeneratorFunction' || kind === 'GeneratorFunction')
    throw new Error('withRules: fn must be a plain synchronous function (the rules are put back when it returns)');
  checkRules(rules);
  const saved = GRAVITY.slice();
  const savedHook = rulesHookActive() ? defs.__stacklightGetRules() : null;
  try {
    if (rules) {
      if (rules.gravity) for (let i = 0; i < 20; i++) GRAVITY[i + 1] = rules.gravity[i];
      const set = {};
      if (rules.lockDelay) set.lockTable = [rules.lockDelay[0], ...rules.lockDelay]; // index by level; level 0 never used
      if (rules.resets !== undefined) set.resets = rules.resets;
      if (rules.linesPerLevel !== undefined) set.linesPerLevel = rules.linesPerLevel;
      if (Object.keys(set).length) defs.__stacklightSetRules(set);
    }
    const out = fn();
    if (out !== null && (typeof out === 'object' || typeof out === 'function') && typeof out.then === 'function')
      throw new Error('withRules: fn returned a promise; the rules were put back before it finished, so its result is void');
    return out;
  } finally {
    for (let i = 0; i < saved.length; i++) GRAVITY[i] = saved[i];
    if (savedHook !== null) defs.__stacklightSetRules(savedHook);
  }
}
export function withGravity(table, fn) {
  if (table !== null && table !== undefined && !intsIn(table, 20, 1, 5376)) throw new Error('withGravity: 20 integers 1 to 5376 (levels 1 to 20)');
  return withRules(table ? { gravity: table } : null, fn);
}

export function bandVerdict(r) {
  const why = [];
  if (r.reason !== 'topout') why.push('ended ' + r.reason);
  if (r.level < BAND_LEVEL_MIN || r.level > BAND_LEVEL_MAX) why.push(`level ${r.level} outside ${BAND_LEVEL_MIN}-${BAND_LEVEL_MAX}`);
  if (r.frames < BAND_FRAMES_MIN || r.frames > BAND_FRAMES_MAX) why.push(`${r.frames} frames outside ${BAND_FRAMES_MIN}-${BAND_FRAMES_MAX}`);
  return why;
}

// ---------- CLI ----------
function parseSeeds(s) {
  const out = [];
  for (const part of s.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error('bad --seeds ' + s);
    const a = +m[1], b = m[2] === undefined ? a : +m[2];
    if (b < a || b - a > 1000) throw new Error('bad --seeds ' + s);
    for (let i = a; i <= b; i++) out.push(i);
  }
  return out;
}
const pad = (v, n) => String(v).padStart(n);
const hex = h => '0x' + (h >>> 0).toString(16).padStart(8, '0');

// ctl: { move, tapGap }. The default prints exactly what the bot printed before the tap controller; any other controller adds one line first.
const ctlNote = ctl => ctl.move === 'hold' && ctl.tapGap === TAP_GAP ? null : `controller: ${ctlName(ctl)} (${ctlWords(ctl)})`;
export const ctlName = ctl => ctl.move + (ctl.move === 'hold' && ctl.tapGap === TAP_GAP ? '' : ctl.tapGap);
const ctlWords = ctl => ctl.move === 'hold' ? `today's: taps every ${ctl.tapGap} frames for 1 to 3 columns, a held direction for 4+`
  : ctl.move === 'tap' ? `every column a separate 1-frame tap, one every ${ctl.tapGap} frames (${(60 / ctl.tapGap).toFixed(1)} a second), never held`
  : `per move, hold or tap (every ${ctl.tapGap} frames), whichever shows the target sooner`;
function runBand(seeds, tier, ctl = { move: 'hold', tapGap: TAP_GAP }) {
  if (ctlNote(ctl)) console.log(ctlNote(ctl));
  console.log(`STACKLIGHT bot, tier ${tier} (reaction ${reactionFor(tier)} frames, mistakes ${mistakePercentFor(tier)}%), Free Play`);
  console.log('seed | level | frames | minutes | lines | score | end | pieces | skipped | missed | stateHash | band');
  let ok = true; const why = [];
  for (const seed of seeds) {
    const r = playRun({ seed, tier, ...ctl });
    const w = bandVerdict(r);
    if (w.length) { ok = false; why.push(`seed ${seed}: ${w.join('; ')}`); }
    console.log(`${pad(seed, 4)} | ${pad(r.level, 5)} | ${pad(r.frames, 6)} | ${pad(r.minutes.toFixed(2), 7)} | ${pad(r.lines, 5)} | ${pad(r.score, 5)} | ${r.reason} | ${pad(r.stats.pieces, 6)} | ${pad(r.stats.skipped, 7)} | ${pad(r.stats.missed, 6)} | ${hex(r.hash)} | ${w.length ? 'out' : 'in'}`);
  }
  console.log(`band: top out at level ${BAND_LEVEL_MIN}-${BAND_LEVEL_MAX} and ${BAND_FRAMES_MIN}-${BAND_FRAMES_MAX} frames (6-10 min)`);
  if (ok) console.log('PASS'); else { console.log('FAIL: ' + why.join(' | ')); }
  return ok;
}

function runTiers(seeds, ctl = { move: 'hold', tapGap: TAP_GAP }) {
  if (ctlNote(ctl)) console.log(ctlNote(ctl));
  const res = []; // res[tier][seedIndex]
  for (let t = 1; t <= 9; t++) res[t] = seeds.map(seed => { const r = playRun({ seed, tier: t, ...ctl }); return { frames: r.frames, score: r.score, level: r.level, reason: r.reason }; });
  console.log(`STACKLIGHT tier table: ${seeds.length} seeds (${seeds[0]}-${seeds[seeds.length - 1]}), Free Play. "A beats B" on a seed = A's run lasts more frames (tie: higher score; equal on both is a tie, counted for nobody).`);
  console.log('tier | mean level | mean frames | mean score | topped out before the run cap');
  for (let t = 1; t <= 9; t++) {
    const m = f => res[t].reduce((a, x) => a + f(x), 0) / seeds.length;
    console.log(`${pad(t, 4)} | ${pad(m(x => x.level).toFixed(1), 10)} | ${pad(m(x => x.frames).toFixed(0), 11)} | ${pad(m(x => x.score).toFixed(0), 10)} | ${pad(res[t].filter(x => x.reason === 'topout').length, 2)} of ${seeds.length}`);
  }
  const wins = (a, b) => { let w = 0; for (let i = 0; i < seeds.length; i++) { const x = res[a][i], y = res[b][i]; if (x.frames > y.frames || (x.frames === y.frames && x.score > y.score)) w++; } return w; };
  console.log(`win table: row tier beat column tier, out of ${seeds.length} seeds`);
  console.log('     | ' + [1, 2, 3, 4, 5, 6, 7, 8, 9].map(b => pad(b, 3)).join(' '));
  for (let a = 1; a <= 9; a++) console.log(`${pad(a, 4)} | ` + [1, 2, 3, 4, 5, 6, 7, 8, 9].map(b => a === b ? '  -' : pad(wins(a, b), 3)).join(' '));
  // information only (not the gate): the same table if "beats" meant a higher score on the seed
  const sw = (a, b) => { let w = 0; for (let i = 0; i < seeds.length; i++) if (res[a][i].score > res[b][i].score) w++; return w; };
  console.log('for information, not the gate: win table by higher score on the same seed');
  console.log('     | ' + [1, 2, 3, 4, 5, 6, 7, 8, 9].map(b => pad(b, 3)).join(' '));
  for (let a = 1; a <= 9; a++) console.log(`${pad(a, 4)} | ` + [1, 2, 3, 4, 5, 6, 7, 8, 9].map(b => a === b ? '  -' : pad(sw(a, b), 3)).join(' '));
  const half = seeds.length / 2, bad = [];
  for (let a = 2; a <= 9; a++) for (let b = 1; b < a; b++) { const w = wins(a, b); if (!(w > half)) bad.push(`tier ${a} vs ${b}: ${w}/${seeds.length}`); }
  if (bad.length === 0) { console.log('PASS'); return true; }
  console.log(`FAIL: ${bad.length} of 36 higher-over-lower pairs do not win more than half: ${bad.join(', ')}`);
  return false;
}

const mean = (xs, f) => xs.length ? xs.reduce((a, x) => a + f(x), 0) / xs.length : NaN;
const fmt = (v, d = 0) => Number.isNaN(v) ? '-' : v.toFixed(d);

// --reaction-sweep: tier-9 placement quality, zero mistakes, one reaction at a time (review finding 1)
export function sweepRows(seeds, reactions, planAhead, ctl = {}) {
  return reactions.map(reaction => {
    const runs = seeds.map(seed => playRun({ seed, tier: 9, reaction, mistakePct: 0, planAhead, ...ctl }));
    const tops = runs.filter(r => r.reason === 'topout');
    return {
      reaction, runs, capped: runs.length - tops.length, meanFrames: mean(runs, r => r.frames), meanLevel: mean(runs, r => r.level),
      meanTopLevel: mean(tops, r => r.level), meanAfter20: mean(tops.filter(r => r.level20At >= 0), r => r.frames - r.level20At),
      missed: runs.reduce((a, r) => a + r.stats.missed, 0)
    };
  });
}
export function cliffOf(rows, n) {
  // last: the highest reaction below which every seed always reached the cap; first: the first reaction where any seed
  // tops out; wall: the first reaction from which no seed reaches the cap at this or any higher reaction in the sweep
  let last = null, first = null, wall = null;
  for (const r of rows) { if (first === null && r.capped === n) last = r.reaction; else if (first === null) first = r.reaction; }
  for (let i = rows.length - 1; i >= 0 && rows[i].capped === 0; i--) wall = rows[i].reaction;
  return { last, first, wall };
}
function runSweep(seeds, reactions, planAhead, ctl = { move: 'hold', tapGap: TAP_GAP }) {
  if (ctlNote(ctl)) console.log(ctlNote(ctl));
  console.log(`STACKLIGHT reaction sweep: tier-9 placement, 0% mistakes, Free Play, seeds ${seeds.join(',')}, plan ahead ${planAhead ? 'ON (reads NEXT in the entry delay, its wait starts at the lock)' : 'OFF (its wait starts when it first sees the piece)'}`);
  console.log('reaction | reached 60-min cap | mean frames | mean min | mean end level | mean top-out level | frames lived after level 20 (top-outs) | missed');
  const rows = sweepRows(seeds, reactions, planAhead, ctl);
  for (const r of rows)
    console.log(`${pad(r.reaction, 8)} | ${pad(r.capped + ' of ' + seeds.length, 18)} | ${pad(fmt(r.meanFrames), 11)} | ${pad(fmt(r.meanFrames / 3600, 2), 8)} | ${pad(fmt(r.meanLevel, 1), 14)} | ${pad(fmt(r.meanTopLevel, 1), 18)} | ${pad(fmt(r.meanAfter20), 38)} | ${pad(r.missed, 6)}`);
  const c = cliffOf(rows, seeds.length);
  const v = x => x === null ? '(none in range)' : x;
  console.log(`cliff (plan ahead ${planAhead ? 'ON' : 'OFF'}): every seed reaches the cap up to reaction ${v(c.last)}; first top-out at reaction ${v(c.first)}; every seed tops out from reaction ${v(c.wall)}`);
  return true;
}

// --cause: what kills tiers 1 to 8, reaction or mistakes (review finding 2). Each tier three ways on the same seeds.
function runCause(seeds) {
  console.log(`STACKLIGHT cause table: Free Play, seeds ${seeds.join(',')}, plan ahead OFF. "cap" = reached the 60-min run cap (never topped out).`);
  console.log('tier | reaction | mistakes | A: as D.7 (cap, mean frames) | B: reaction forced to 12, own mistakes | C: own reaction, 0% mistakes');
  const cell = rs => `${rs.filter(r => r.reason !== 'topout').length} of ${rs.length} cap, ${fmt(mean(rs, r => r.frames))}`;
  for (let t = 1; t <= 9; t++) {
    const R = reactionFor(t), M = mistakePercentFor(t);
    const A = seeds.map(seed => playRun({ seed, tier: t }));
    const B = seeds.map(seed => playRun({ seed, tier: t, reaction: 12 }));
    const C = seeds.map(seed => playRun({ seed, tier: t, mistakePct: 0 }));
    console.log(`${pad(t, 4)} | ${pad(R, 8)} | ${pad(M + '%', 8)} | ${pad(cell(A), 28)} | ${pad(cell(B), 38)} | ${cell(C)}`);
  }
  for (const R of [16, 20]) {
    const rs = seeds.map(seed => playRun({ seed, tier: 9, reaction: R }));
    console.log(`tier 9 placement, 0% mistakes, reaction ${R} (tier 8 is reaction 16, tier 7 is 20): ${cell(rs)}, mean top-out level ${fmt(mean(rs, r => r.level), 1)}`);
  }
  return true;
}

// ---------- options for the owner: candidate rule sets, measured here, never applied ----------
// Every candidate is a PROPOSAL, NOT APPLIED. Any of them changes the game's rules, so it breaks the golden replays and
// would be GAME_VERSION 2.0 (design C.7). They were found by trying walls at levels 13 to 17 against the plan-ahead
// tier-9 bot, then setting lines per level so its top-out lands at 6 to 10 minutes.
const survivors = rows => rows.filter(r => r.capped === r.runs.length).map(r => r.reaction).join(', ') || 'none of ' + rows.map(r => r.reaction).join(', ');
const shippedGravity = () => GRAVITY.slice(1, 21);
const shippedLock = () => Array.from({ length: 20 }, (_, i) => lockDelayFor(i + 1));
const instantFrom = (from) => shippedGravity().map((g, i) => (i + 1 >= from ? 5376 : g));
const lockFrom = (from, v) => shippedLock().map((d, i) => (i + 1 >= from ? v : d));
export const OPTIONS = [
  { id: 'NOW', name: 'current rules (for comparison)', control: true, rules: () => null,
    player: 'nothing changes' },
  { id: 'A', name: 'wall at level 15: instant drop and a 10-frame lock from 15, 28 lines a level',
    rules: () => ({ gravity: instantFrom(15), lockDelay: lockFrom(15, 10), linesPerLevel: 28 }),
    player: 'levels 1 to 14 play as today but each lasts 3.5 times as long. From level 15 pieces fall to the stack at once (today: from 20) and lock 1/6 s after landing (today 1/2 s); holding a direction to slide is too slow there, only fast taps work' },
  { id: 'B', name: 'wall at level 17: instant drop and a 10-frame lock from 17, 24 lines a level',
    rules: () => ({ gravity: instantFrom(17), lockDelay: lockFrom(17, 10), linesPerLevel: 24 }),
    player: 'levels 1 to 16 play as today but each lasts 3 times as long. From level 17 the same wall as A: instant fall, 1/6 s lock' },
  { id: 'C', name: 'no lock resets anywhere, today\'s level-20 rules from level 15, 28 lines a level',
    rules: () => ({ gravity: instantFrom(15), lockDelay: lockFrom(15, 16), resets: 0, linesPerLevel: 28 }),
    player: 'at every level a piece locks a fixed time after it first lands, however much you move it (today each move restarts the timer, up to 12 times). From level 15 pieces fall at once with a 16-frame lock. Levels last 3.5 times as long' },
  { id: 'LONG', name: 'control: 28 lines a level, nothing else', control: true, rules: () => ({ linesPerLevel: 28 }),
    player: 'levels last 3.5 times as long; no wall' }
];

// the 36 higher-over-lower tier pairs that win more than half, by frames lived and by score
export function tierSummary(seeds, planAhead) {
  const res = [];
  for (let t = 1; t <= 9; t++) res[t] = seeds.map(seed => playRun({ seed, tier: t, planAhead }));
  let byFrames = 0, byScore = 0;
  for (let a = 2; a <= 9; a++) for (let b = 1; b < a; b++) {
    let wf = 0, ws = 0;
    for (let i = 0; i < seeds.length; i++) {
      const x = res[a][i], y = res[b][i];
      if (x.frames > y.frames || (x.frames === y.frames && x.score > y.score)) wf++;
      if (x.score > y.score) ws++;
    }
    if (wf > seeds.length / 2) byFrames++;
    if (ws > seeds.length / 2) byScore++;
  }
  return { byFrames, byScore, levels: res.slice(1).map(rs => mean(rs, r => r.level)), mins: res.slice(1).map(rs => mean(rs, r => r.frames) / 3600) };
}

function runOptions(seeds, tierSeeds) {
  console.log('STACKLIGHT options for the owner: candidate rule sets, measured in this process only.');
  console.log('EVERY ROW IS A PROPOSAL, NOT APPLIED: games/stacklight/** is unchanged on disk. Any rule change breaks the golden replays (GAME_VERSION 2.0 per design C.7).');
  console.log(`band runs: plan-ahead tier 9 (reaction 12, 0% mistakes), seeds ${seeds.join(',')}; tier tables: plan-ahead tiers 1-9, seeds ${tierSeeds[0]}-${tierSeeds[tierSeeds.length - 1]}`);
  // does each lever reach the sim on its own? seed 1, plan-ahead tier 9, the state hash at frame 20000 (past level 20
  // under the current rules), with only that one lever changed
  const probe = () => { const sim = createSim({ seed: 1, mode: 'arcade' }), bot = createBot({ seed: 1, tier: 9, planAhead: true }); while (!sim.done && sim.frame < 20000) { sim.step(bot.word(sim)); sim.clearEvents(); } return hex(sim.stateHash()) + ' at frame ' + sim.frame; };
  const nowProbe = withRules(null, probe);
  const levers = [['gravity instant from 15', { gravity: instantFrom(15) }], ['lock delay 10 from 15', { lockDelay: lockFrom(15, 10) }], ['resets 0', { resets: 0 }], ['28 lines a level', { linesPerLevel: 28 }]];
  console.log(`override check, one lever at a time (seed 1 hash): current rules ${nowProbe}; ` + levers.map(([n, r]) => { const h = withRules(r, probe); return `${n} ${h}${h === nowProbe ? ' SAME (did not reach the sim)' : ''}`; }).join('; '));
  const summary = [];
  for (const o of OPTIONS) {
    const rules = o.rules();
    withRules(rules, () => {
      const band = seeds.map(seed => playRun({ seed, tier: 9, planAhead: true }));
      const bandOk = band.every(r => bandVerdict(r).length === 0);
      const noPlan = seeds.map(seed => playRun({ seed, tier: 9 }));
      const sw = sweepRows(seeds, [8, 12, 16, 20, 24], true);
      const ts = tierSummary(tierSeeds, true);
      console.log('');
      console.log(`== ${o.id}: ${o.name}${o.control ? '' : '  [PROPOSAL, NOT APPLIED; breaks the golden replays, GAME_VERSION 2.0]'}`);
      if (rules) console.log('   rules: ' + JSON.stringify(rules));
      console.log(`   for a player: ${o.player}`);
      console.log(`   band, plan ahead: ${band.map(r => `seed ${r.seed} L${r.level} ${r.minutes.toFixed(1)} min ${r.reason} ${hex(r.hash)}`).join('; ')}  => ${bandOk ? 'PASS' : 'FAIL'}`);
      console.log(`   band, no plan ahead: ${noPlan.map(r => `L${r.level} ${r.minutes.toFixed(1)} min ${r.reason}`).join('; ')}`);
      console.log(`   plan-ahead reaction sweep (reaction: seeds reaching the 60-min cap): ${sw.map(r => `${r.reaction}: ${r.capped}`).join(', ')}; every seed survives at: ${survivors(sw)}`);
      console.log(`   tier table (plan ahead): higher tier wins more than half: ${ts.byFrames} of 36 pairs by frames lived, ${ts.byScore} of 36 by score`);
      console.log(`   tier mean top-out level 1..9: ${ts.levels.map(v => v.toFixed(1)).join(' ')}; mean minutes 1..9: ${ts.mins.map(v => v.toFixed(1)).join(' ')}`);
      summary.push({ o, band, bandOk, ts, c: { rows: sw } });
    });
  }
  console.log('');
  console.log('summary | band (plan-ahead tier 9) | top-out level | minutes | tier pairs by frames | tier pairs by score | plan-ahead reactions (of 8-24) where every seed survives');
  for (const { o, band, bandOk, ts, c } of summary) {
    const lv = band.map(r => r.level), mn = band.map(r => r.minutes);
    console.log(`${pad(o.id, 7)} | ${pad(bandOk ? 'PASS' : 'FAIL', 24)} | ${pad(Math.min(...lv) + '-' + Math.max(...lv), 13)} | ${pad(Math.min(...mn).toFixed(1) + '-' + Math.max(...mn).toFixed(1), 7)} | ${pad(ts.byFrames + ' of 36', 20)} | ${pad(ts.byScore + ' of 36', 19)} | ${survivors(c.rows)}`);
  }
  console.log('none applied. The owner picks (or none).');
  return true;
}

// ---------- the same options under a controller that can tap ----------
// A and B were walls only because the hold controller's first auto-repeat (11 frames) is
// slower than their 10-frame lock. Here every option is measured under five controllers. The reaction is the wait
// before the FIRST press of a piece only; later taps follow at the tap rate (a player who has decided keeps tapping).
//   hold   today's controller (taps every 4 frames for 1 to 3 columns, a held direction for 4+)
//   tap4   every column a separate 1-frame press, one every 4 frames (15 a second: about the fastest human tapping)
//   tap6   the same, one every 6 frames (10 a second: a fast, practised tapper)
//   best4  per move, hold or tap4, whichever the bot's model says shows the target sooner (taps inside hold also every 4)
//   best6  the same with taps every 6 frames
export const CONTROLLERS = [
  { move: 'hold', tapGap: 4 }, { move: 'tap', tapGap: 4 }, { move: 'tap', tapGap: 6 }, { move: 'best', tapGap: 4 }, { move: 'best', tapGap: 6 }
];
// the level from which each option's wall applies (today's rules: level 20, instant fall and a 16-frame lock)
const WALL_AT = { NOW: 20, A: 15, B: 17, C: 15, LONG: 20 };
// candidates found by --wall-search (proposals, never applied); filled in from that search's output, see the build log
export const W52C_OPTIONS = [
  { id: 'D', wall: 15, name: 'wall at level 15: instant drop and a 12-frame lock from 15, no lock resets anywhere, 28 lines a level',
    rules: () => ({ gravity: instantFrom(15), lockDelay: lockFrom(15, 12), resets: 0, linesPerLevel: 28 }) },
  { id: 'E', wall: 15, name: 'wall at level 15: instant drop and an 8-frame lock from 15, 1 lock reset anywhere, 28 lines a level',
    rules: () => ({ gravity: instantFrom(15), lockDelay: lockFrom(15, 8), resets: 1, linesPerLevel: 28 }) },
  // the earlier side claim: "a 12-frame lock or 2 resets is survivable; 10 frames or 0 resets is not" (A is the
  // 10-frame row, C the 0-resets row)
  { id: 'A12', wall: 15, control: true, name: 'side check: A with a 12-frame lock', rules: () => ({ gravity: instantFrom(15), lockDelay: lockFrom(15, 12), linesPerLevel: 28 }) },
  { id: 'C2', wall: 15, control: true, name: 'side check: C with 2 lock resets', rules: () => ({ gravity: instantFrom(15), lockDelay: lockFrom(15, 16), resets: 2, linesPerLevel: 28 }) }
];
const capList = rows => rows.map(r => `${r.reaction}:${r.capped}`).join(' ');
const lived = (runs, wall) => { const xs = runs.filter(r => r.reason === 'topout' && r.levelAt[wall] >= 0).map(r => r.frames - r.levelAt[wall]); return xs.length ? Math.max(...xs) : -1; };
export function measureOption(o, ctl, seeds, reactions) {
  const plan = sweepRows(seeds, reactions, true, ctl), noPlan = sweepRows(seeds, reactions, false, ctl);
  const r12 = plan.find(r => r.reaction === 12);
  return { plan, noPlan, band: r12 ? r12.runs : null };
}
function runMoveOptions(seeds, reactions, scoreSeeds, noScore, seenLock = false, only = null) {
  const ctls = CONTROLLERS.map(c => ({ ...c, seenLock }));
  console.log('STACKLIGHT options under five controllers (w52c). Measured in this process only; EVERY RULE ROW IS A PROPOSAL, NOT APPLIED (golden replays break, GAME_VERSION 2.0).');
  console.log(`tier-9 placement, 0% mistakes, seeds ${seeds.join(',')}, reactions ${reactions.join(',')} with planning (plan) and without (no plan). "cap" = lived to the 60-min run cap.`);
  console.log('controllers: ' + CONTROLLERS.map(c => `${ctlName(c)} = ${ctlWords(c)}`).join('; '));
  console.log('the reaction is the wait before the first press of each piece; later taps follow at the tap rate.');
  console.log(`seen lock ${seenLock ? 'ON: the model starts a resting piece from its used lock time and resets' : 'OFF: the model starts every plan from a fresh lock timer (the w52b bot)'}`);
  console.log('option | controller | band (plan, reaction 12): top-out level, minutes | plan: reaction:seeds at cap | no plan: reaction:seeds at cap | survives forever (all seeds) at, plan / no plan | most frames lived after the wall level (top-outs) | missed');
  const all = [...OPTIONS, ...W52C_OPTIONS].filter(o => only === null || only.includes(o.id));
  for (const o of all) {
    const rules = o.rules(), wall = o.wall || WALL_AT[o.id];
    console.log('');
    console.log(`== ${o.id}: ${o.name}${o.control ? '' : '  [PROPOSAL, NOT APPLIED]'}`);
    if (rules) console.log('   rules: ' + JSON.stringify(rules));
    withRules(rules, () => {
      for (const ctl of ctls) {
        const m = measureOption(o, ctl, seeds, reactions);
        const b = m.band, lv = b ? b.map(r => r.level) : [], mn = b ? b.map(r => r.minutes) : [];
        const bandTxt = b ? `L${Math.min(...lv)}-${Math.max(...lv)} ${Math.min(...mn).toFixed(1)}-${Math.max(...mn).toFixed(1)} min ${b.every(r => bandVerdict(r).length === 0) ? 'PASS' : 'FAIL'}` : '-';
        const both = [...m.plan, ...m.noPlan].flatMap(r => r.runs);
        const surv = rows => rows.filter(r => r.capped === r.runs.length).map(r => r.reaction).join(',') || 'none';
        console.log(`${pad(o.id, 6)} | ${pad(ctlName(ctl), 5)} | ${pad(bandTxt, 22)} | ${capList(m.plan)} | ${capList(m.noPlan)} | ${surv(m.plan)} / ${surv(m.noPlan)} | ${lived(both, wall)} | ${both.reduce((a, r) => a + r.stats.missed, 0)}`);
      }
    });
  }
  if (!noScore) {
    console.log('');
    console.log(`== SCORE (rules unchanged): score at 10 min (final score if sooner), tiers 1-9 as D.7, seeds ${scoreSeeds[0]}-${scoreSeeds[scoreSeeds.length - 1]}, no planning`);
    for (const ctl of ctls) {
      const per = [], all2 = [];
      for (let t = 1; t <= 9; t++) { per[t] = scoreSeeds.map(seed => playRun({ seed, tier: t, ...ctl, stopAt: MARK_10MIN }).score10); all2.push(...per[t]); }
      const sorted = all2.slice().sort((x, y) => x - y), q = f => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
      let ok = 0;
      for (let a = 2; a <= 9; a++) for (let b = 1; b < a; b++) { let w = 0; for (let i = 0; i < scoreSeeds.length; i++) if (per[a][i] > per[b][i]) w++; if (w > scoreSeeds.length / 2) ok++; }
      console.log(`SCORE  | ${pad(ctlName(ctl), 5)} | field p75 ${q(0.75)}, p90 ${q(0.9)} | tier pairs by score at 10 min: ${ok} of 36`);
    }
  }
  console.log('none applied. The owner picks (or none).');
  return true;
}

// --wall-search: the smallest change that is a wall for every controller, planning or not, at every reaction given.
// A "wall" here: every run (tier-9 placement, 0% mistakes) tops out before the 60-min cap. Grid: instant fall and a
// lock of L frames from the wall level, R lock resets at every level, 28 lines a level (the line count only moves when
// the wall is reached). A cell stops at its first run that reaches the cap and prints it.
export function firstSurvivor(seeds, reactions, seenLock = false) {
  let most = 0, runs = 0;
  for (const ctl of [CONTROLLERS[3], CONTROLLERS[1], CONTROLLERS[0], CONTROLLERS[4], CONTROLLERS[2]])
    for (const planAhead of [true, false]) for (const reaction of reactions) for (const seed of seeds) {
      const r = playRun({ seed, tier: 9, reaction, mistakePct: 0, planAhead, ...ctl, seenLock }); runs++;
      if (r.reason !== 'topout') return { survivor: { ctl, planAhead, reaction, seed }, runs };
      if (r.frames > most) most = r.frames;
    }
  return { survivor: null, runs, most };
}
export const WALL_GRID = { walls: [15, 17], locks: [16, 12, 10, 8, 6], resets: [12, 4, 2, 1, 0] };
export const gridRules = (wall, lock, resets, lines = 28) => ({ gravity: instantFrom(wall), lockDelay: lockFrom(wall, lock), resets, linesPerLevel: lines });
function runWallSearch(seeds, reactions, grid = WALL_GRID, seenLock = false) {
  console.log(`STACKLIGHT wall search (w52c): instant fall + lock L from the wall level, R resets everywhere, 28 lines a level. Seeds ${seeds.join(',')}, reactions ${reactions.join(',')}, plan and no plan, controllers ${CONTROLLERS.map(ctlName).join(', ')}, seen lock ${seenLock ? 'ON' : 'OFF'}.`);
  console.log('wall | lock | resets | verdict (WALL = every run tops out; else the first run that reached the cap) | runs | longest run (min)');
  for (const wall of grid.walls) for (const lock of grid.locks) for (const resets of grid.resets) {
    const res = withRules(gridRules(wall, lock, resets), () => firstSurvivor(seeds, reactions, seenLock));
    const v = res.survivor ? `lives: ${ctlName(res.survivor.ctl)}, ${res.survivor.planAhead ? 'plan' : 'no plan'}, reaction ${res.survivor.reaction}, seed ${res.survivor.seed}` : 'WALL';
    console.log(`${pad(wall, 4)} | ${pad(lock, 4)} | ${pad(resets, 6)} | ${v} | ${res.runs} | ${res.survivor ? '60 (cap)' : (res.most / 3600).toFixed(1)}`);
  }
  return true;
}

// --band score (B.8). PASS rule: in both fields (plan ahead OFF and ON) the re-measured p75 and p90 equal the
// frozen SCORE_BAND numbers, and the good-player tier's median score at 10 min is inside [p75, p90], with the tier below
// it in the check (6) under p75 and the flawless tier (9) over p90. Anything else is FAIL.
export function measureScoreBand(seeds) {
  const out = {};
  for (const planAhead of [false, true]) {
    const all = [], median = [];
    for (let t = 1; t <= 9; t++) {
      const s = seeds.map(seed => playRun({ seed, tier: t, planAhead, stopAt: MARK_10MIN }).score10);
      all.push(...s);
      median[t] = s.slice().sort((x, y) => x - y)[Math.floor(seeds.length / 2)];
    }
    const sorted = all.sort((x, y) => x - y), q = f => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
    out[planAhead ? 'on' : 'off'] = { p75: q(0.75), p90: q(0.9), median, runs: sorted.length };
  }
  return out;
}
// m: measureScoreBand's result; frozen: SCORE_BAND (or a candidate). Returns the reasons it fails; empty = PASS.
export function judgeScoreBand(m, frozen = SCORE_BAND, goodTier = frozen.goodTier) {
  const why = [];
  for (const k of ['off', 'on']) {
    const f = frozen[k], r = m[k], name = 'plan ahead ' + k.toUpperCase();
    if (!(f.p75 < f.p90)) why.push(`${name}: frozen p75 ${f.p75} is not below p90 ${f.p90}`);
    if (r.p75 !== f.p75) why.push(`${name}: p75 is ${r.p75}, frozen ${f.p75}`);
    if (r.p90 !== f.p90) why.push(`${name}: p90 is ${r.p90}, frozen ${f.p90}`);
    const g = r.median[goodTier];
    if (!(g >= f.p75 && g <= f.p90)) why.push(`${name}: good player (tier ${goodTier}) median ${g} is outside the band ${f.p75}-${f.p90}`);
    if (!(r.median[frozen.belowTier] < f.p75)) why.push(`${name}: tier ${frozen.belowTier} median ${r.median[frozen.belowTier]} is not below p75 ${f.p75}`);
    if (!(r.median[frozen.aboveTier] > f.p90)) why.push(`${name}: tier ${frozen.aboveTier} median ${r.median[frozen.aboveTier]} is not above p90 ${f.p90}`);
  }
  return why;
}
function runScoreBandGate(seeds, goodTier) {
  const fz = SCORE_BAND;
  console.log(`STACKLIGHT score band gate (B.8, D85): score at 10 min (final score if the run ended sooner). Field: tiers 1-9 as D.7, seeds ${seeds[0]}-${seeds[seeds.length - 1]}, plan ahead OFF and ON (one field each). Good player = tier ${goodTier}.`);
  console.log(`PASS rule: in both fields p75 and p90 equal the frozen numbers, tier ${goodTier} median is inside [p75, p90], tier ${fz.belowTier} median is below p75, tier ${fz.aboveTier} median is above p90.`);
  const m = measureScoreBand(seeds);
  console.log('field          | runs | p75 now | p75 frozen | p90 now | p90 frozen');
  for (const k of ['off', 'on']) console.log(`plan ahead ${pad(k.toUpperCase(), 3)} | ${pad(m[k].runs, 4)} | ${pad(m[k].p75, 7)} | ${pad(fz[k].p75, 10)} | ${pad(m[k].p90, 7)} | ${pad(fz[k].p90, 10)}`);
  const where = (v, f) => v < f.p75 ? 'below' : v > f.p90 ? 'above' : 'IN';
  console.log('tier | median OFF | band OFF | median ON | band ON');
  for (let t = 1; t <= 9; t++) console.log(`${pad(t, 4)} | ${pad(m.off.median[t], 10)} | ${pad(where(m.off.median[t], fz.off), 8)} | ${pad(m.on.median[t], 9)} | ${pad(where(m.on.median[t], fz.on), 7)}`);
  const why = judgeScoreBand(m, fz, goodTier);
  console.log(why.length === 0
    ? `PASS: both fields match the frozen p75 and p90; tier ${goodTier} is inside the band, tier ${fz.belowTier} below it, tier ${fz.aboveTier} above it`
    : 'FAIL: ' + why.join('; '));
  return why.length === 0;
}

// --score-band: the time-based alternative. Keep every rule; judge a run by its score at the 10-minute mark (its final
// score if it topped out sooner), and define "good player" as a percentile band of the bot field.
function runScoreBand(seeds) {
  console.log(`STACKLIGHT score band (rules unchanged): measure = score at 10 min, or the final score if the run ended sooner. Field: tiers 1-9, seeds ${seeds[0]}-${seeds[seeds.length - 1]}, plan ahead OFF and ON.`);
  for (const planAhead of [false, true]) {
    const all = [], per = [];
    for (let t = 1; t <= 9; t++) { per[t] = seeds.map(seed => playRun({ seed, tier: t, planAhead }).score10); all.push(...per[t]); }
    const sorted = all.slice().sort((x, y) => x - y);
    const q = f => sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
    const rank = v => Math.round(100 * sorted.filter(x => x < v).length / sorted.length);
    console.log(`plan ahead ${planAhead ? 'ON' : 'OFF'}: field percentiles p10 ${q(0.1)}, p25 ${q(0.25)}, p50 ${q(0.5)}, p75 ${q(0.75)}, p90 ${q(0.9)}`);
    console.log('tier | median score at 10 min | its percentile in the field');
    for (let t = 1; t <= 9; t++) { const m = per[t].slice().sort((x, y) => x - y)[Math.floor(seeds.length / 2)]; console.log(`${pad(t, 4)} | ${pad(m, 22)} | ${pad(rank(m), 3)}`); }
    let ok = 0;
    for (let a = 2; a <= 9; a++) for (let b = 1; b < a; b++) { let w = 0; for (let i = 0; i < seeds.length; i++) if (per[a][i] > per[b][i]) w++; if (w > seeds.length / 2) ok++; }
    console.log(`tier table by this measure: ${ok} of 36 higher-over-lower pairs win more than half`);
  }
  console.log('proposal, not applied: e.g. "a good player scores between the field p75 and p90 at 10 minutes". No rule changes, so no golden replay breaks.');
  return true;
}

if (process.argv[1] && process.argv[1].endsWith('stacklight-bot.mjs')) {
  const a = process.argv.slice(2);
  if ((a.includes('--options') || a.includes('--move-options') || a.includes('--wall-search')) && !rulesHookActive()) { // lock delay, resets and lines per level need the hook (see withRules)
    const { spawnSync } = await import('node:child_process');
    const hook = new URL('./stacklight-rules.mjs', import.meta.url).href;
    const r = spawnSync(process.execPath, ['--import', hook, process.argv[1], ...a], { stdio: 'inherit' });
    process.exit(r.status === null ? 2 : r.status);
  }
  const opt = n => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  try {
    // --band score's field is fixed, so these would be ignored; refuse them instead (exit 2)
    if (a.includes('--band') && ['--move', '--tap-gap', '--plan-ahead'].some(f => a.includes(f))) throw new Error('--band score refuses --move, --tap-gap and --plan-ahead: its field is fixed (hold controller, plan ahead OFF and ON)');
    const seeds = parseSeeds(opt('--seeds') || '1-5');
    const tier = opt('--tier') === undefined ? 9 : +opt('--tier');
    if (!Number.isInteger(tier) || tier < 1 || tier > 9) throw new Error('bad --tier');
    let table = null;
    if (opt('--gravity') !== undefined) {
      table = opt('--gravity').split(',').map(Number);
      if (table.length !== 20 || table.some(v => !Number.isInteger(v) || v < 1)) throw new Error('--gravity needs 20 positive integers (levels 1 to 20)');
    }
    const planAhead = a.includes('--plan-ahead');
    const ctl = { move: opt('--move') === undefined ? 'hold' : opt('--move'), tapGap: opt('--tap-gap') === undefined ? TAP_GAP : +opt('--tap-gap') };
    if ((a.includes('--move') && opt('--move') === undefined) || (a.includes('--tap-gap') && opt('--tap-gap') === undefined)) throw new Error('--move and --tap-gap need a value');
    checkMove(ctl.move, ctl.tapGap);
    const t0 = process.hrtime.bigint();
    const ok = withGravity(table, () => {
      if (table) console.log('candidate gravity (levels 1-20): ' + table.join(','));
      if (a.includes('--move-options')) return runMoveOptions(opt('--seeds') ? seeds : [1, 2, 3, 4, 5], parseSeeds(opt('--reactions') || '8,12,16,20,24'), parseSeeds(opt('--score-seeds') || '1-20'), a.includes('--no-score'), a.includes('--seen-lock'), opt('--only') ? opt('--only').split(',') : null);
      if (a.includes('--wall-search')) return runWallSearch(opt('--seeds') ? seeds : [1, 2, 3, 4, 5], parseSeeds(opt('--reactions') || '8,12,16,20,24'), {
        walls: opt('--walls') ? parseSeeds(opt('--walls')) : WALL_GRID.walls, locks: opt('--locks') ? parseSeeds(opt('--locks')) : WALL_GRID.locks,
        resets: opt('--resets') !== undefined ? parseSeeds(opt('--resets')) : WALL_GRID.resets }, a.includes('--seen-lock'));
      if (a.includes('--reaction-sweep')) return runSweep(opt('--seeds') ? seeds : [1, 2, 3, 4, 5], parseSeeds(opt('--reactions') || '10-20'), planAhead, ctl);
      if (a.includes('--cause')) return runCause(opt('--seeds') ? seeds : parseSeeds('1-10'));
      if (a.includes('--options')) return runOptions(opt('--seeds') ? seeds : [1, 2, 3, 4, 5], parseSeeds(opt('--tier-seeds') || '1-20'));
      if (a.includes('--band')) {
        if (opt('--band') !== 'score') throw new Error('--band needs the value score');
        const g = opt('--good-tier') === undefined ? SCORE_BAND.goodTier : +opt('--good-tier');
        if (!Number.isInteger(g) || g < 1 || g > 9) throw new Error('bad --good-tier');
        return runScoreBandGate(opt('--seeds') ? seeds : parseSeeds(SCORE_BAND.seeds), g);
      }
      if (a.includes('--score-band')) return runScoreBand(opt('--seeds') ? seeds : parseSeeds('1-20'));
      return a.includes('--tiers') ? runTiers(seeds, ctl) : runBand(seeds, tier, ctl);
    });
    console.error(`runtime ${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(1)} s`);
    process.exit(ok ? 0 : 1);
  } catch (e) { console.error(String(e.message || e)); process.exit(2); }
}
