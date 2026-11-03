// window.SL: STACKLIGHT test hooks (design F.1 row T3), so a headless browser can drive the real page.
//   SL.start(seed, mode)  a new run ('arcade' default, or 'daily'); seed omitted = a random one. Clears any test start.
//   SL.info()             sim.info() (score, lines, level, piece, next, heights, ...) plus app, paused, crt, touchUi
//   SL.place(col, rot)    puts the current piece's pivot at col (B.2: BAR flat its middle cell, BAR upright and PLUS
//                         their centre column; rot 0 flat, 1 upright, ignored for PLUS) and hard drops it. It feeds
//                         ordinary input words through the same step as play (recorded in the replay like played
//                         frames), then one neutral word, then input.resume() so the next real word is packed as usual.
//   SL.setHeights(arr)    restart through the test-only start (B.7): each column filled from row 0 with RIDGE (type 4)
//   SL.setLines(n)        restart through the test-only start with lines n (and so the level). Both keep the other's
//                         value and the current seed; test starts never make a replay (sim.replay() is null).
//   SL.hash()             sim.stateHash()
//   SL.replay()           sim.replay() (null for a test start)
// Read-only extras for the browser test (tests/stacklight-browser.test.js):
//   SL.hud()   the strings the HUD drew last (score, level, lines, glow, best) and the tick it drew them
//   SL.fx()    the render effects state: last lock, fit, clear mask and age, live particles, popups on screen
//   SL.pausePad()  the touch PAUSE pad box { x, y, w, h } in CSS px while a run is in play, else null
//   SL.view()  touch layout, field box, pads drawn, the turn-sideways screen, the tick counter
//   SL.hudLayout()  the play HUD grid in field units (panel boxes, bracket step and arm, label and value rows, the
//              NEXT column, the GLOW meter, the points lane, the footer); read only, the same on every look
// T5 (modes, boards, attract; games/stacklight/main.js t5):
//   SL.mode(m)       'free' or 'daily' on the title (highlights that row; daily puts its card up). No argument: the mode now
//   SL.info().mode   in a run the sim's mode ('arcade' | 'daily' | 'test'); on the title the highlighted mode ('free' | 'daily')
//   SL.title()       what the title card shows: highlighted row, page, the Daily card { ridge, rule, level, noStr, dayKey, seed }, state
//   SL.runInfo()     the run record of a run started from the title (mode, day, seed, claimed, ranked, submitted), else null
//   SL.page(p, tab)  'table' opens the board page on a tab, anything else the main page;  SL.table() what the board page holds
//   SL.scores / SL.boardScores   rows of the local board / the board the page shows;  SL.queue(), SL.flushQueue(now), SL.status()
//   SL.nameEntry(name)  on the entry screen: set the 3 letters and save (returns the submit promise);  SL.lastSubmit(), SL.lastError()
//   SL.attractNow(), SL.idle(n), SL.attract()   attract mode: start it, read or set the idle tick count, its phase and sim
//   SL.mute(v)       set (or just read) the mute flag;  SL.remote(), SL.boardReads(), SL.fromLobby(), SL.attemptUsed(day)
import { PH_PLAY } from './sim.js';
import { BAR, PLUS, IN_ROT_PRESS, IN_HARD_PRESS, IN_LEFT, IN_LEFT_PRESS, IN_RIGHT, IN_RIGHT_PRESS } from './defs.js';
import { POPS, POP_FIT, POP_POINTS, POP_LEVEL } from './render/fx.js';

const POP_NAMES = ['', 'fit', 'points', 'level'];

export function installHooks(SL, app) {
  const { ui, fx, input, renderer, rotate, gfx, sound, t5 } = app;
  let testStart = null; // the current test start ({ heights, lines }), so setLines and setHeights keep each other
  const seedNow = () => (app.sim ? app.sim.seed : 1);

  SL.start = function start(seed, mode = 'arcade') {
    const s = seed == null ? app.newSeed() : seed >>> 0;
    app.startRun(s, mode); // throws on an unknown mode, before anything changes
    testStart = null;
    return true;
  };
  SL.setLines = function setLines(n) {
    const t = { lines: n };
    if (testStart && testStart.heights) t.heights = testStart.heights.slice();
    app.startRun(seedNow(), 'test', t); // the sim checks n; a bad value throws and the old run carries on
    testStart = t;
    return true;
  };
  SL.setHeights = function setHeights(arr) {
    if (!Array.isArray(arr)) throw new Error('SL.setHeights wants an array of 9 heights');
    const t = { heights: arr.slice() };
    if (testStart && testStart.lines !== undefined) t.lines = testStart.lines;
    app.startRun(seedNow(), 'test', t); // the sim checks the heights; bad input throws and the old run carries on
    testStart = t;
    return true;
  };

  SL.place = function place(col, rot = 0) {
    const sim = app.sim;
    if (!sim || sim.done || !Number.isInteger(col)) return null;
    // not for a run left to the title (or over). Not blocked while paused: tests/stacklight-browser.test.js
    // (the 'over' step of the allocation test) calls SL.place right after the resume key, before the next tick has
    // un-paused the run, and that test may not change. Logged as a question.
    if (app.app !== 'play') return null;
    const S = sim.ctx, step = app.stepSim;
    let guard = 0;
    while (!(S.phase === PH_PLAY && S.pType) && !sim.done && guard++ < 64) step(0); // wait out entry or clear delay
    if (sim.done) return null;
    const type = S.pType, want = rot ? 1 : 0;
    if (type === BAR && S.rot !== want) { step(IN_ROT_PRESS); step(0); }
    guard = 0;
    while (S.pType && S.px !== col && guard++ < 12) {
      const px = S.px;
      step(col < px ? IN_LEFT | IN_LEFT_PRESS : IN_RIGHT | IN_RIGHT_PRESS); step(0);
      if (S.px === px) break; // blocked
    }
    const ok = S.pType !== 0 && S.px === col && (type === PLUS || S.rot === want);
    if (S.pType) step(IN_HARD_PRESS);
    step(0);        // a neutral word: the sim's previous word is 0 again
    input.resume(); // and the input carries on as after a hold (contract 3)
    return { ok, type: type === BAR ? 'BAR' : 'PLUS', score: sim.score, lines: sim.lines, level: sim.level, frame: sim.frame };
  };

  // the looks for the owner to compare (render only, games/stacklight/render/looks.js). SL.look(n) sets look n
  // (0 = the shipped look, LIVING FIELD + SWEEP; 1 SOLID LIGHT; 2 the earlier shipped look; 3 HYBRID, look 1's lit stack on
  // look 0's field with the sweep); no argument reads it. Not stored anywhere: a reload is look 0.
  SL.look = n => renderer.look(n);
  SL.hash = () => (app.sim ? app.sim.stateHash() : null);
  SL.replay = () => (app.sim ? app.sim.replay() : null);

  // the touch PAUSE pad's box in CSS px ({ x, y, w, h }), or null when it is not live (not in a run in play, or no touch UI)
  SL.pausePad = function pausePad() {
    if (!ui.touchUi || !input.pauseLive || rotate.shown()) return null;
    const q = input.getLayout().pause;
    return q ? { x: q.x, y: q.y, w: q.w, h: q.h } : null;
  };
  SL.info = function info() {
    const sim = app.sim;
    const out = sim ? sim.info() : { score: 0, lines: 0, level: 1, frame: 0, done: false };
    out.app = app.app; out.paused = ui.paused; out.crt = ui.crtOn; out.touchUi = ui.touchUi;
    if (app.app === 'title' || app.app === 'attract') out.mode = ui.mode; // in a run: the sim's own mode name (arcade | daily | test)
    out.muted = ui.muted;
    return out;
  };
  // ---------- T5 ----------
  SL.mode = m => (m === undefined ? t5.modeNow() : t5.setMode(m));
  SL.title = () => t5.title();
  SL.daily = start => t5.chooseDaily(!!start);
  SL.runInfo = () => t5.runInfo();
  SL.attemptUsed = day => t5.attemptUsed(day);
  SL.page = (p, tab) => t5.page(p, tab);
  SL.table = () => t5.table();
  SL.scores = (board, key, unique) => t5.scores(board, key, unique);
  SL.boardScores = (board, key) => t5.boardScores(board, key);
  SL.boardReads = () => t5.boardReads();
  SL.remote = () => t5.remote();
  SL.queue = () => t5.queue();
  SL.flushQueue = now => t5.flushQueue(now);
  SL.status = () => t5.status();
  SL.lastRemote = () => t5.lastRemote();
  SL.storageWarn = () => t5.storageWarn();
  SL.nameEntry = name => t5.nameEntry(name);
  SL.lastSubmit = () => t5.lastSubmit();
  SL.lastError = () => t5.lastError();
  SL.entryT = () => t5.entryT();
  SL.entryInfo = () => t5.entryInfo(); // the entry screen's strings and how many times they were built (score and mode once, TIME per second)
  SL.attractNow = () => t5.attractNow();
  SL.idle = n => t5.idle(n);
  SL.attract = () => t5.attract();
  SL.mute = v => t5.mute(v);
  SL.fromLobby = () => t5.fromLobby();

  // ---------- read-only extras ----------
  SL.hud = () => { const h = renderer.hud; return { score: h.score, level: h.level, lines: h.lines, glow: h.glow, best: h.best, drawnF: h.drawnF, F: ui.F }; };
  SL.fx = function fxInfo() {
    const S = fx.S, sim = app.sim, now = sim ? sim.frame - 1 : 0, pops = [];
    for (let i = 0; i < POPS; i++) {
      const o = i * 5, kind = fx.pop[o];
      if (!kind || now - fx.pop[o + 3] > fx.pop[o + 4] || now < fx.pop[o + 3]) continue;
      pops.push({ kind: POP_NAMES[kind], text: fx.popStr[i], x: fx.pop[o + 1], y: fx.pop[o + 2], born: fx.pop[o + 3] });
    }
    return {
      now, lockF: S.lockF, lockAge: now - S.lockF, lockCol: S.lockCol, fit: S.fit, moved: S.moved, melt: S.nMelt,
      clearF: S.clearF, clearMask: S.clearMask, clearRows: S.clearRows, clearAge: now - S.clearF,
      particles: S.nPart, popups: pops, overReason: S.overReason
    };
  };
  // T4: SL.audio() -> { track, bpm, layers, ... } the sound state, read only (audio-bind.js state()): the music playing now (null when
  // none), its tempo, the layer count for the level, the tempo / chord waiting for a bar line, a log of the switches, and a count of
  // every sound requested (sfx) and really started (played) by name.
  SL.audio = () => sound.state();
  SL.hudLayout = () => renderer.hudLayout();
  SL.view = function view() {
    const L = input.getLayout(), v = gfx.view;
    return {
      F: ui.F, touchUi: ui.touchUi, rotateShown: rotate.shown(), padsDrawn: ui.padsDrawn, padsDrawnF: ui.padsDrawnF,
      field: { x: L.field.x, y: L.field.y, w: L.field.w, h: L.field.h }, band: L.band, scale: L.scale,
      pause: L.pause ? { x: L.pause.x, y: L.pause.y, w: L.pause.w, h: L.pause.h } : null,
      // the pads on screen now: the five, plus PAUSE while a run is in play (padsDrawn still counts the five)
      pads: (input.pauseLive && L.pause ? L.pads.concat([L.pause]) : L.pads).map(p => ({ name: p.name, x: p.x, y: p.y, w: p.w, h: p.h })),
      gl: { x: v.x, y: v.y, w: v.w, h: v.h, scale: v.scale, dpr: v.dpr, cw: v.cw, ch: v.ch }
    };
  };
}
