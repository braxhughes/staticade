// STACKLIGHT solo simulation (design slice T1, the STACKLIGHT design document, sections B and C).
// Pure: no DOM, no audio, no wall clock, no unseeded randomness, no trig. All randomness comes from engine/rng.js
// streams (C.6). Fixed 60 Hz steps; one step(word) per sim frame. No allocation inside step() or stateHash().
//
// createSim({ seed, mode }) with mode 'arcade' (Free Play) or 'daily' (Daily Ridge).
// createSim({ seed, mode: 'test', test: { heights, lines, pieces, frame } }) is the test-only start (B.7):
//   heights fills each column from row 0 with RIDGE cells (type 4), lines sets lines and so the level (Free Play rule),
//   pieces ('BAR' / 'PLUS') are dealt first, then the normal deck (new Rng(seed)) takes over. frame (optional, default 0)
//   sets the starting frame number, so a test can reach the run cap. 'test' is accepted only with a test object, a test
//   object only with mode 'test', and replay() returns null for it: no replay string can describe a test start.
//
// Frame model (B.6): frame f is processed by the f-th call to step(). The first piece's first frame is frame 0. A lock on
// frame L with no clear gives entry frames L+1..L+8 and the next piece on L+9; with a clear, clear frames L+1..L+20,
// entry L+21..L+28, next piece on L+29. A lock is resolved at once on its frame: MELT, line clears, then the ceiling rule.
// D1 (1v1) adds junk rising between the clears and the ceiling check; nothing for it exists in solo, and the solo hash
// will never include 1v1 fields (C.7).
import { Rng } from '../../engine/rng.js';
import { encode } from '../../engine/replay.js';
import {
  GAME_ID, GAME_VERSION, COLS, ROWS, CELLS, CELL_RIDGE, BAR, PLUS, ROT_H, ROT_V, SPAWN_COL, SPAWN_ROW, PIECE_NAMES,
  DECK_MAX, PREVIEW, SHORT_SIGHT_PREVIEW, AUTO_REPEAT_FIRST, AUTO_REPEAT_EVERY, ENTRY_DELAY, CLEAR_DELAY, LOCK_RESETS,
  lockDelayFor, GRAVITY, SUB_ROW, SOFT_DROP_G, RUN_CAP, FIT_NONE, FIT_FLAT, FIT_KEY, GLOW_FRAMES, QUICK_GLOW_FRAMES,
  LEAN, SHORT_SIGHT, QUICK_GLOW, NO_RULE, DAY_RULES, RIDGES, IN_LEFT, IN_RIGHT, IN_SOFT, IN_LEFT_PRESS, IN_RIGHT_PRESS,
  IN_HARD_PRESS, IN_ROT_PRESS, INPUT_MASK, streamSeed
} from './defs.js';
import { createBoard, fillHeights, fullRowMask, clearRows, spawnZoneUsed, popcount, columnHeight } from './sim/board.js';
import { SHAPE_N, SHAPE_DX, SHAPE_DY, SHAPE_BAR_H, SHAPE_PLUS, shapeOf, fits, tryTurn, meltInto } from './sim/piece.js';
import { shuffleDeck } from './sim/deck.js';
import { clearPoints, fitPoints, nextGlow, levelFor } from './sim/score.js';

// phases
export const PH_DELAY = 0, PH_PLAY = 1, PH_OVER = 2;
// end reasons
export const END_NONE = 0, END_TOPOUT = 1, END_LIGHTSOUT = 2;
export const END_REASONS = ['', 'topout', 'lightsout'];

// presentation events (not part of the game state, never hashed): [type, frame, a, b, c, d]
export const EV_SPAWN = 1;      // a piece type, b pivot col, c pivot row
export const EV_MOVE = 2;       // a direction (-1 / +1), b 1 if it moved, 0 if blocked
export const EV_TURN = 3;       // a 1 turned, 0 blocked, 2 PLUS (never turns: the shimmer), b new rot
export const EV_HARD_DROP = 4;  // a rows fallen
export const EV_LOCK = 5;       // a piece type, b fit kind (0 none, 1 FLAT, 2 KEY), c cells melted, d pivot col
export const EV_MELT = 6;       // one per piece cell: a col, b row before melt, c row after melt
export const EV_FIT = 7;        // a kind, b points
export const EV_CLEAR = 8;      // a rows cleared, b bit mask of the cleared rows (before removal), c points, d GLOW step g
export const EV_LEVEL = 9;      // a new level
export const EV_TOPOUT = 10;
export const EV_LIGHTSOUT = 11;
export const EVS = 6;
const EVN = 512;

const QMAX = 8;

export function createSim(opts) { return new StacklightSim(opts); }

// The sim is a class with prototype methods (not per-instance closures): every instance shares the same functions, so
// optimised code and call targets stay valid from one run to the next and the hot loop never deopts or allocates.
class StacklightSim {
  constructor({ seed = 0, mode = 'arcade', test } = {}) {
    if (mode !== 'arcade' && mode !== 'daily' && mode !== 'test') throw new Error('stacklight: unknown mode ' + mode);
    if (test !== undefined && mode !== 'test') throw new Error('stacklight: a test start is only allowed with mode test');
    if (mode === 'test' && (test === null || typeof test !== 'object')) throw new Error('stacklight: mode test needs a test start');
    seed = seed >>> 0;
    const isDaily = mode === 'daily', isTest = mode === 'test';
    this._seed = seed; this._mode = mode; this.isDaily = isDaily;

    // ---------- streams (C.6) ----------
    this.rng = new Rng(seed); // solo pieces: the plain seed, as Starfall
    this.dailyRng = isDaily ? new Rng(streamSeed(seed, 'daily')) : null;

    // ---------- state ----------
    // Everything that steers the game is in S (scalars), grid, deck, queue, testPieces and the rng words; stateHash()
    // covers all of it. Every key of S is hashed (tests/stacklight-sim.test.js perturbs each one).
    const grid = this.grid = createBoard();
    this.deck = new Uint8Array(DECK_MAX);
    this.queue = new Uint8Array(QMAX); // upcoming pieces, queue[0] is the next to spawn
    const S = this.ctx = {
      frame: 0, phase: PH_DELAY, delayT: 0, done: 0, reason: END_NONE,
      // active piece: type 0 = none
      pType: 0, px: 0, py: 0, rot: ROT_H, sub: 0, lockT: 0, resets: 0, spawned: 0,
      // input: auto-repeat direction (-1, 0, +1) and frames to its next move, buffered turn, previous masked word (C.2)
      arDir: 0, arT: 0, turnBuf: 0, prev: 0,
      // deck and preview
      deckLen: 0, deckPos: 0, queueLen: 0, testPos: 0,
      // score
      score: 0, lines: 0, level: 1, glow: 0, glowT: 0,
      // Daily
      dayRule: NO_RULE, ridge: -1
    };

    this.testPieces = null;
    if (isTest) {
      const { heights, lines = 0, pieces = [], frame = 0 } = test;
      if (heights !== undefined) {
        if (!Array.isArray(heights) || heights.length !== COLS) throw new Error('stacklight: test.heights must be ' + COLS + ' numbers');
        for (const h of heights) if (!Number.isInteger(h) || h < 0 || h >= ROWS) throw new Error('stacklight: test height out of range 0..' + (ROWS - 1));
        fillHeights(grid, heights, CELL_RIDGE);
      }
      if (!Number.isInteger(lines) || lines < 0 || lines > 1e6) throw new Error('stacklight: bad test.lines');
      if (!Array.isArray(pieces) || pieces.length > 1024) throw new Error('stacklight: bad test.pieces');
      if (!Number.isInteger(frame) || frame < 0 || frame >= RUN_CAP) throw new Error('stacklight: bad test.frame');
      const tp = this.testPieces = new Uint8Array(pieces.length);
      pieces.forEach((p, i) => {
        if (p !== 'BAR' && p !== 'PLUS') throw new Error('stacklight: test piece must be BAR or PLUS, got ' + p);
        tp[i] = p === 'BAR' ? BAR : PLUS;
      });
      S.lines = lines; S.frame = frame;
    }
    if (isDaily) {
      S.ridge = this.dailyRng.int(RIDGES.length);
      S.dayRule = this.dailyRng.int(DAY_RULES.length);
      const r = RIDGES[S.ridge];
      for (let c = 0; c < COLS; c++) for (let k = 0; k < +r[c]; k++) grid[k * COLS + c] = CELL_RIDGE;
    }
    this.lean = S.dayRule === LEAN;
    this._previewN = S.dayRule === SHORT_SIGHT ? SHORT_SIGHT_PREVIEW : PREVIEW;
    this._glowFrames = S.dayRule === QUICK_GLOW ? QUICK_GLOW_FRAMES : GLOW_FRAMES;
    S.level = levelFor(isDaily, S.lines);

    // replay recording: one word per frame, preallocated for the whole run cap (no growth inside step)
    this.rec = isTest ? null : new Uint16Array(RUN_CAP);
    this._badInput = false; // a word had a reserved bit (7 to 15) set: the server refuses such a replay (C.2, C.4)

    // events (presentation only)
    this.ev = new Int32Array(EVN * EVS);
    this.evHead = 0; this.evCount = 0;

    this.turnOut = new Int32Array(1);
    this.meltOut = new Int8Array(15);
    this.pieceCells = new Int32Array(10); // reused by cells(): col, row pairs of the active piece

    this.fillQueue(this._previewN + 1); // the first piece and its preview, before frame 0
  }

  push(type, a, b, c, d) {
    if (this.evCount >= EVN) return; // presentation only: dropping is safe
    const ev = this.ev, o = ((this.evHead + this.evCount) % EVN) * EVS; this.evCount++;
    ev[o] = type; ev[o + 1] = this.ctx.frame; ev[o + 2] = a; ev[o + 3] = b; ev[o + 4] = c; ev[o + 5] = d;
  }

  // ---------- deck and preview (B.3) ----------
  draw() {
    const S = this.ctx, tp = this.testPieces;
    if (tp !== null && S.testPos < tp.length) return tp[S.testPos++];
    if (S.deckPos >= S.deckLen) { S.deckLen = shuffleDeck(this.deck, this.lean, this.rng); S.deckPos = 0; }
    return this.deck[S.deckPos++];
  }
  // the next deck is shuffled as soon as the preview needs it
  fillQueue(n) { const S = this.ctx; while (S.queueLen < n) { const p = this.draw(); this.queue[S.queueLen++] = p; } }
  popQueue() {
    const S = this.ctx, queue = this.queue, p = queue[0];
    for (let i = 1; i < S.queueLen; i++) queue[i - 1] = queue[i];
    S.queueLen--; queue[S.queueLen] = 0;
    return p;
  }

  // ---------- piece ----------
  shape() { return shapeOf(this.ctx.pType, this.ctx.rot); }
  resting() { const S = this.ctx; return !fits(this.grid, this.shape(), S.px, S.py - 1); }

  spawn() {
    const S = this.ctx;
    S.pType = this.popQueue(); this.fillQueue(this._previewN);
    S.px = SPAWN_COL; S.py = SPAWN_ROW; S.rot = ROT_H; S.sub = 0; S.lockT = 0; S.resets = 0; S.spawned++;
    S.phase = PH_PLAY;
    // the ceiling rule keeps the spawn zone empty, so the piece always fits here (B.1)
    this.push(EV_SPAWN, S.pType, S.px, S.py, 0);
  }

  // a successful move or turn while resting would restart the lock delay, at most LOCK_RESETS times per piece (B.6).
  // LOCK_RESETS is 0 since 2.0 (D111), so this never fires. Since 3.0 (D119) a piece can be resting at a move or turn
  // only inside the frame it locks (it spawned onto the stack, or that frame's turn left it resting).
  moved(wasResting) {
    const S = this.ctx;
    if (wasResting && S.resets < LOCK_RESETS) { S.resets++; S.lockT = 0; }
  }

  turn() {
    const S = this.ctx;
    if (S.pType === PLUS) { this.push(EV_TURN, 2, S.rot, 0, 0); return; } // no turn, no lock reset
    const wasResting = this.resting();
    if (tryTurn(this.grid, S.pType, S.rot, S.px, S.py, this.turnOut)) {
      S.rot = S.rot === ROT_H ? ROT_V : ROT_H; S.px = this.turnOut[0];
      this.moved(wasResting);
      this.push(EV_TURN, 1, S.rot, 0, 0);
    } else this.push(EV_TURN, 0, S.rot, 0, 0);
  }

  shift(d) {
    const S = this.ctx;
    const wasResting = this.resting();
    if (fits(this.grid, this.shape(), S.px + d, S.py)) { S.px += d; this.moved(wasResting); this.push(EV_MOVE, d, 1, 0, 0); }
    else this.push(EV_MOVE, d, 0, 0, 0);
  }

  // B.4 melt, B.5 clears, B.7 score, then the B.1 ceiling rule. All on the lock frame.
  lock() {
    const S = this.ctx, grid = this.grid, meltOut = this.meltOut;
    const sh = this.shape(), type = S.pType, n = SHAPE_N[sh], level = S.level;
    const melted = meltInto(grid, sh, S.px, S.py, type, meltOut);
    const fit = melted !== 0 ? FIT_NONE : sh === SHAPE_BAR_H ? FIT_FLAT : sh === SHAPE_PLUS ? FIT_KEY : FIT_NONE; // BAR V never pays a fit
    this.push(EV_LOCK, type, fit, melted, S.px);
    for (let i = 0; i < n; i++) this.push(EV_MELT, meltOut[i * 3], meltOut[i * 3 + 1], meltOut[i * 3 + 2], 0);
    if (fit !== FIT_NONE) { const p = fitPoints(fit, level); S.score += p; this.push(EV_FIT, fit, p, 0, 0); }
    const mask = fullRowMask(grid), rows = popcount(mask);
    if (rows > 0) {
      S.glow = nextGlow(S.glow, S.glowT);
      const p = clearPoints(rows, level, S.glow);
      S.score += p;
      S.glowT = this._glowFrames;
      clearRows(grid, mask);
      S.lines += rows;
      this.push(EV_CLEAR, rows, mask, p, S.glow);
      const nl = levelFor(this.isDaily, S.lines);
      if (nl !== S.level) { S.level = nl; this.push(EV_LEVEL, nl, 0, 0, 0); }
    }
    // (1v1, D1: pending junk rises here, before the ceiling check)
    S.pType = 0; S.sub = 0; S.lockT = 0; S.resets = 0;
    if (spawnZoneUsed(grid)) { S.done = 1; S.reason = END_TOPOUT; S.phase = PH_OVER; this.push(EV_TOPOUT, 0, 0, 0, 0); return; }
    S.phase = PH_DELAY;
    S.delayT = rows > 0 ? CLEAR_DELAY + ENTRY_DELAY : ENTRY_DELAY;
  }

  // ---------- step ----------
  step(word) {
    const S = this.ctx, grid = this.grid;
    if (S.done) return;
    word &= 0xffff;
    if (this.rec !== null) this.rec[S.frame] = word;
    if (word & ~INPUT_MASK) this._badInput = true;
    const w = word & INPUT_MASK;
    // C.2: a pressed bit counts only if that same pressed bit was clear in the previous word
    const edge = w & ~S.prev;
    S.prev = w;
    const pL = edge & IN_LEFT_PRESS, pR = edge & IN_RIGHT_PRESS, pHard = edge & IN_HARD_PRESS, pTurn = edge & IN_ROT_PRESS;

    // B.7: the GLOW timer counts down every sim frame, including entry and clear delays
    if (S.glowT > 0) S.glowT--;

    // B.6 auto-repeat: the charge runs in every phase, so a held direction moves on the spawn frame
    const active = S.phase === PH_PLAY || (S.phase === PH_DELAY && S.delayT === 0);
    let move = 0;
    if (pL && pR) { S.arDir = 0; S.arT = 0; } // pressed together: neither moves, no repeat while both stay held
    else if (pL) { S.arDir = -1; S.arT = AUTO_REPEAT_FIRST; move = -1; }
    else if (pR) { S.arDir = 1; S.arT = AUTO_REPEAT_FIRST; move = 1; }
    else {
      const hL = w & IN_LEFT, hR = w & IN_RIGHT;
      if ((S.arDir < 0 && !hL) || (S.arDir > 0 && !hR)) { S.arDir = 0; S.arT = 0; }
      if (S.arDir === 0) {
        // only one direction held with no press (the last pressed was let go): it charges from the start
        if (hL && !hR) { S.arDir = -1; S.arT = AUTO_REPEAT_FIRST; }
        else if (hR && !hL) { S.arDir = 1; S.arT = AUTO_REPEAT_FIRST; }
      } else {
        if (S.arT > 0) S.arT--;
        if (S.arT === 0 && active) { move = S.arDir; S.arT = AUTO_REPEAT_EVERY; }
      }
    }

    if (S.phase === PH_DELAY) {
      if (S.delayT > 0) {
        S.delayT--;
        // a turn pressed during entry delay is applied on the spawn frame; moves are not buffered; drops are ignored
        if (pTurn && S.delayT < ENTRY_DELAY) S.turnBuf = 1;
        this.endFrame(); return;
      }
      this.spawn();
    }

    // ---------- play frame ----------
    if (pTurn || S.turnBuf) { S.turnBuf = 0; this.turn(); }
    if (move !== 0) this.shift(move);
    if (pHard) {
      const y0 = S.py, sh = this.shape();
      while (fits(grid, sh, S.px, S.py - 1)) S.py--;
      this.push(EV_HARD_DROP, y0 - S.py, 0, 0, 0);
      this.lock(); this.endFrame(); return;
    }
    // gravity: a sub-row counter adds G each frame; the piece drops one row per full 256 (soft drop: at least 128)
    const sh = this.shape();
    let g = GRAVITY[S.level];
    if ((w & IN_SOFT) && g < SOFT_DROP_G) g = SOFT_DROP_G;
    if (fits(grid, sh, S.px, S.py - 1)) {
      S.sub += g;
      while (S.sub >= SUB_ROW && fits(grid, sh, S.px, S.py - 1)) { S.py--; S.sub -= SUB_ROW; }
    }
    // lock (D119, GAME_VERSION 3.0): checked here, at the end of the frame, after this frame's turn, move and gravity.
    // lockT counts resting frames from the first one (that frame counts as 1) and, once started, every frame after it
    // (D117: it never pauses in the air). The piece locks on a resting frame with lockT > lockDelayFor(level). The delay
    // is 0, so the piece locks on its first resting frame: the frame it touches down, or the frame it spawns resting.
    const rest = !fits(grid, sh, S.px, S.py - 1);
    if (rest) S.sub = 0;
    if (rest || S.lockT > 0) {
      S.lockT++;
      if (rest && S.lockT > lockDelayFor(S.level)) this.lock();
    }
    this.endFrame();
  }

  endFrame() {
    const S = this.ctx;
    S.frame++;
    if (!S.done && S.frame >= RUN_CAP) { S.done = 1; S.reason = END_LIGHTSOUT; S.phase = PH_OVER; this.push(EV_LIGHTSOUT, 0, 0, 0, 0); }
  }

  // ---------- hash (C.1) ----------
  // FNV-1a over the grid, the active piece, auto-repeat and the previous word, deck contents and position, the preview,
  // the 4 words of every stream Rng (read directly, never rng.save()), score, lines, level, g, GLOW timer, the day rule.
  // Returns a uint32. No allocation: the work is in hashCore(), which returns an int32 (a small integer, never boxed);
  // this wrapper is small enough to inline into the caller, so the uint32 is never boxed as a heap number either.
  stateHash() { return this.hashCore() >>> 0; }
  hashCore() {
    const S = this.ctx, grid = this.grid, deck = this.deck, queue = this.queue, tp = this.testPieces;
    const rng = this.rng, dailyRng = this.dailyRng;
    let h = 0x811c9dc5 | 0;
    for (let i = 0; i < CELLS; i++) { h ^= grid[i]; h = Math.imul(h, 0x01000193); }
    h = mix(h, S.frame); h = mix(h, S.phase); h = mix(h, S.delayT); h = mix(h, S.done); h = mix(h, S.reason);
    h = mix(h, S.pType); h = mix(h, S.px); h = mix(h, S.py); h = mix(h, S.rot); h = mix(h, S.sub); h = mix(h, S.lockT);
    h = mix(h, S.resets); h = mix(h, S.spawned);
    h = mix(h, S.arDir); h = mix(h, S.arT); h = mix(h, S.turnBuf); h = mix(h, S.prev);
    h = mix(h, S.deckLen); h = mix(h, S.deckPos); for (let i = 0; i < S.deckLen; i++) h = mix(h, deck[i]);
    h = mix(h, S.queueLen); for (let i = 0; i < S.queueLen; i++) h = mix(h, queue[i]);
    h = mix(h, S.testPos);
    if (tp !== null) for (let i = S.testPos; i < tp.length; i++) h = mix(h, tp[i]);
    h = mix(h, rng.a); h = mix(h, rng.b); h = mix(h, rng.c); h = mix(h, rng.d);
    if (dailyRng !== null) { h = mix(h, dailyRng.a); h = mix(h, dailyRng.b); h = mix(h, dailyRng.c); h = mix(h, dailyRng.d); }
    h = mix(h, S.score); h = mix(h, Math.floor(S.score / 4294967296));
    h = mix(h, S.lines); h = mix(h, S.level); h = mix(h, S.glow); h = mix(h, S.glowT);
    h = mix(h, S.dayRule); h = mix(h, S.ridge);
    return h | 0;
  }

  // drain(fn): fn(buf, offset) per pending event, oldest first; buf[offset] is the EV_* type, buf[offset + 1] the frame
  drain(fn) {
    const ev = this.ev;
    while (this.evCount) { fn(ev, this.evHead * EVS); this.evHead = (this.evHead + 1) % EVN; this.evCount--; }
  }
  clearEvents() { this.evHead = 0; this.evCount = 0; }

  // ---------- read-outs ----------
  // cells(): fills pieceCells with the active piece's (col, row) pairs and returns the count (0 with no piece)
  cells() {
    const S = this.ctx, pc = this.pieceCells;
    if (S.pType === 0) return 0;
    const sh = this.shape(), o = sh * 5, n = SHAPE_N[sh];
    for (let i = 0; i < n; i++) { pc[i * 2] = S.px + SHAPE_DX[o + i]; pc[i * 2 + 1] = S.py + SHAPE_DY[o + i]; }
    return n;
  }
  heights() { const a = []; for (let c = 0; c < COLS; c++) a.push(columnHeight(this.grid, c)); return a; }
  info() {
    const S = this.ctx;
    return {
      game: GAME_ID, version: GAME_VERSION, seed: this._seed, mode: this._mode,
      frame: S.frame, phase: ['delay', 'play', 'over'][S.phase], done: !!S.done, reason: END_REASONS[S.reason],
      score: S.score, lines: S.lines, level: S.level, glow: S.glow, glowT: S.glowT, glowMul: (4 + S.glow) / 4,
      piece: S.pType ? { type: PIECE_NAMES[S.pType], col: S.px, row: S.py, rot: S.rot, lockT: S.lockT, resets: S.resets } : null,
      next: Array.from(this.queue.subarray(0, this._previewN), p => PIECE_NAMES[p]),
      dayRule: S.dayRule < 0 ? null : DAY_RULES[S.dayRule], ridge: S.ridge < 0 ? null : RIDGES[S.ridge],
      heights: this.heights(), spawned: S.spawned, badInput: this._badInput
    };
  }
  replay() {
    if (this.rec === null) return null;
    return encode({ game: GAME_ID, version: GAME_VERSION, seed: this._seed, mode: this._mode }, this.rec.subarray(0, this.ctx.frame));
  }

  get seed() { return this._seed; } get mode() { return this._mode; }
  get frame() { return this.ctx.frame; } get done() { return !!this.ctx.done; } get reason() { return END_REASONS[this.ctx.reason]; }
  get score() { return this.ctx.score; } get lines() { return this.ctx.lines; } get level() { return this.ctx.level; }
  get glow() { return this.ctx.glow; } get glowT() { return this.ctx.glowT; } get phase() { return this.ctx.phase; }
  get previewN() { return this._previewN; } get glowFrames() { return this._glowFrames; } get badInput() { return this._badInput; }
}

function mix(h, v) {
  v = v | 0;
  h ^= v & 255; h = Math.imul(h, 0x01000193);
  h ^= (v >>> 8) & 255; h = Math.imul(h, 0x01000193);
  h ^= (v >>> 16) & 255; h = Math.imul(h, 0x01000193);
  h ^= (v >>> 24) & 255; h = Math.imul(h, 0x01000193);
  return h;
}

