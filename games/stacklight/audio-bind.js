// STACKLIGHT audio binding (design F.1 row T4): one engine/audio.js instance, the sfx.js bank and the music.js score, wired to
// the sim's events and the app states. PRESENTATION ONLY: it reads sim events and sim.level / glow / glowT / done, and never
// writes the sim. The sim never reads anything from here, so a replay hashes the same with sound on, off or blocked.
//
// EVENT MAP (sim event -> sound, each event fires its sound once):
//   EV_MOVE b=1            move          (a blocked move, b=0, is silent)
//   EV_TURN a=1 / a=2      turnBar / turnPlus   (a=0, a blocked turn, is silent)
//   EV_LOCK + its EV_MELT  melt (cells melted, by the largest fall) | lockKey | lockFit | lockSoft. Sounded once the lock's
//                          melts have been read: at the next clear / level / top out event or at endStep(), whichever is first
//   EV_CLEAR               clear (rows); glowStep too when g is 1 or more, except a clear already at the cap (g was 4 and stays 4)
//   EV_LEVEL               levelUp
//   EV_TOPOUT, EV_LIGHTSOUT  topOut, and the music fades out; then silence
//
// MUSIC (sync(), once per rendered frame):
//   plays while the app is 'play' and the sim is not done; stops on the title, on game over and on a new run (the new run then
//   starts its own track at bar 0 at once, so a restart never layers two). The context is suspended while the game is paused,
//   the tab is hidden or the turn-sideways screen is up, so notes freeze and resume exactly where they were.
//   LAYERS follow the level at once (engine intensity). TEMPO and the GLOW pad chord change only at a bar line: the engine plays
//   one tempo per track, so the bind starts the next track MUSIC_START_LEAD_S before the bar line (the engine begins a track
//   that long after the call), on the same bar of the loop (music.js builds a track for every start bar).
// AUTOPLAY: nothing sounds until the first user gesture (key, press, tap); listen(target) installs the gesture listeners, which
//   stay armed until the AudioContext is really running (each gesture asks it to resume again), then go.
// NO ALLOCATION PER FRAME: event(), endStep() and sync() allocate nothing (counters in typed arrays, one reused options object);
// a new object appears only when a track is first built or a tempo / chord switch is logged (a few times a run).
import { createAudio, MUSIC_START_LEAD_S } from '../../engine/audio.js';
import { SFX, SFX_LIST } from './sfx.js';
import { tempoFor, layersFor, INTENSITY_OF_LAYERS, trackFor, trackId, BARS, PIECE, BPM_BASE, BPM_STEP, GLOW_STEPS } from './music.js';
import { EV_MOVE, EV_TURN, EV_LOCK, EV_MELT, EV_CLEAR, EV_LEVEL, EV_TOPOUT, EV_LIGHTSOUT } from './sim.js';

const I = {}; SFX_LIST.forEach((n, i) => { I[n] = i; });
const GESTURES = ['keydown', 'pointerdown', 'pointerup', 'mousedown', 'touchend', 'click'];
const LOG_MAX = 16;
const STALL_S = 0.25; // a frame that skipped over a bar line by less than this still takes the hand-over (it restarts that bar late)

export function createAudioBind(opts = {}) {
  const audio = opts.audio || createAudio({ sfx: SFX, ctx: opts.ctx });
  const O = { rows: 0, fall: 0, g: 0, key: 0 };               // the one reused options object for every sound
  const MO = { fadeMs: 0 }, CUT = { fadeMs: 0 }, OUT = { fadeMs: 600 }, TITLE = { fadeMs: 300 }, REG = {};
  const counts = new Int32Array(SFX_LIST.length), played = new Int32Array(SFX_LIST.length);
  const ids = [];                                              // track id strings by tempo / bar / GLOW step, filled on first use
  const logRing = []; for (let i = 0; i < LOG_MAX; i++) logRing.push({ t: 0, from: 0, bpm: 0, g: 0, bar: 0, lineLateMs: 0 }); // the last switches (a test read-out), reused slots
  let unlocked = false, muted = false, paused = false, hidden = false, awaitSync = false, clockRun = true;
  let lastSim = null, lastLevel = 1, layers = 1, lastI = -1, musicOn = false;
  let curBpm = 0, curG = 0, curBase = 0, curId = null, starts = 0, switches = 0, tgtBpm = tempoFor(1), tgtG = 0;
  let lockOn = false, prevG = 0, lockFit = 0, lockMelted = 0, lockFall = 0, last = -1, listening = null, disarm = null;
  const T = new Float64Array(2); // T[0] audio time of the last frame, T[1] audio time a waiting change was first seen (-1 none); a typed array so a double never boxes
  T[1] = -1;

  // ----- clock: the context runs only when unlocked, not paused, the tab visible and the turn-sideways screen down -----
  function clock() {
    const c = audio.ctx;
    if (!unlocked || !c || c.state === 'closed') return;
    const run = !paused && !hidden && !awaitSync;
    if (run === clockRun) return;
    clockRun = run;
    if (run) c.resume(); else c.suspend();
  }
  const live = () => unlocked && !muted && !paused && !hidden;

  // ----- sound effects -----
  function play(i) {
    counts[i]++; last = i;
    if (!live()) return false;
    const ok = audio.sfx(SFX_LIST[i], O);
    if (ok) played[i]++;
    return ok;
  }
  function flushLock() {
    if (!lockOn) return;
    lockOn = false;
    if (lockMelted > 0) { O.fall = lockFall; play(I.melt); }
    else if (lockFit === 2) play(I.lockKey);
    else if (lockFit === 1) play(I.lockFit);
    else play(I.lockSoft);
  }

  // ----- music -----
  function setLayers(n) {
    layers = n;
    const x = INTENSITY_OF_LAYERS[n];
    if (x !== lastI) { lastI = x; audio.setIntensity(x); }
  }
  function startTrack(bpm, bar, g) {
    const k = (((bpm - BPM_BASE) / BPM_STEP) * BARS + bar) * GLOW_STEPS + g; // each track's id string is built once, then reused
    let id = ids[k];
    if (id === undefined) { id = ids[k] = trackId(bpm, bar, g); REG[id] = trackFor(bpm, bar, g); audio.registerTracks(REG); delete REG[id]; }
    if (!audio.playMusic(id, MO)) return false;
    musicOn = true; curBpm = bpm; curG = g; curBase = bar; curId = id; starts++;
    return true;
  }
  function stopMusic(o) { audio.stopMusic(o); musicOn = false; curId = null; curBpm = 0; T[1] = -1; }

  const api = {
    // first gesture only: true when this call unlocked the audio
    unlock() {
      if (unlocked || !audio.unlock()) return false;
      unlocked = true; clockRun = true; awaitSync = false; clock();
      return true;
    },
    // install the gesture listeners (and the tab-hide listener) on a window / document pair; main.js calls it once
    listen(win, doc) {
      if (listening) return;
      // The gestures stay armed until the context is really RUNNING. On a phone the first event of a tap
      // (pointerdown, touchstart) is not a user activation, so the first resume() can leave the context suspended; every later
      // gesture asks again. A context we suspended on purpose (pause, hidden tab, turn-sideways) is left alone.
      const settled = () => { if (disarm !== null && audio.ctx && audio.ctx.state === 'running') disarm(); };
      const onGesture = () => {
        api.unlock();
        const c = audio.ctx;
        if (!c) return;                                   // no Web Audio here (or it could not build): stay armed, harmless
        if (c.state === 'running') { disarm(); return; }
        if (unlocked && clockRun && c.state !== 'closed') {
          const p = c.resume();
          if (p && p.then) p.then(settled, settled);
        }
      };
      disarm = () => { disarm = null; for (const e of GESTURES) win.removeEventListener(e, onGesture, true); };
      for (const e of GESTURES) win.addEventListener(e, onGesture, true);
      if (doc) doc.addEventListener('visibilitychange', () => api.hidden(!!doc.hidden));
      listening = win;
    },
    setMuted(m) {
      muted = !!m; audio.setMuted(muted);
      if (muted && musicOn) stopMusic(CUT); // sync() starts it again on the next frame once unmuted
    },
    // the tab was hidden (true) or shown (false). Shown again, the clock waits for the next sync(), which knows if the game is paused
    hidden(on) {
      hidden = !!on;
      if (!hidden) awaitSync = true;
      clock();
    },

    // ---- sim events: call once per event, in order, from sim.drain ----
    event(buf, o) {
      switch (buf[o]) {
        case EV_MOVE: if (buf[o + 3] === 1) play(I.move); break;
        case EV_TURN: if (buf[o + 2] === 1) play(I.turnBar); else if (buf[o + 2] === 2) play(I.turnPlus); break;
        case EV_LOCK: flushLock(); lockOn = true; lockFit = buf[o + 3]; lockMelted = buf[o + 4]; lockFall = 0; break;
        case EV_MELT: if (lockOn) { const d = buf[o + 3] - buf[o + 4]; if (d > lockFall) lockFall = d; } break;
        case EV_CLEAR:
          flushLock();
          O.rows = buf[o + 2]; play(I.clear);
          // the shimmer for a GLOW step, but not for a clear that is already at the cap (g was 4 and stays 4: nothing stepped)
          { const g = buf[o + 5]; if (g >= 1 && !(g === GLOW_STEPS - 1 && prevG === g)) { O.g = g; play(I.glowStep); } prevG = g; }
          break;
        case EV_LEVEL: flushLock(); play(I.levelUp); break;
        case EV_TOPOUT: case EV_LIGHTSOUT:
          flushLock(); play(I.topOut);
          if (musicOn) stopMusic(OUT);
          break;
      }
    },
    // after the sim step's events have all been handed over
    endStep() { flushLock(); },

    // once per rendered frame. appName: 'title' | 'play' | 'over'. pausedNow: the game is paused or the turn-sideways screen is up.
    sync(appName, pausedNow, sim) {
      awaitSync = false;
      if (disarm !== null && unlocked && audio.ctx && audio.ctx.state === 'running') disarm(); // it came up without a further gesture
      const nw = audio.now(), dtNow = nw - T[0]; T[0] = nw; // the audio clock's step since the last frame (0 while suspended)
      if (pausedNow !== paused) { paused = pausedNow; }
      clock();
      if (sim !== lastSim) { // a new run (or the first): drop the old music, forget any pending switch
        lastSim = sim; lockOn = false; prevG = 0;
        if (musicOn) stopMusic(CUT);
      }
      if (appName !== 'play' || sim === null || sim.done) { if (musicOn) stopMusic(appName === 'title' ? TITLE : OUT); return; }
      lastLevel = sim.level;
      tgtBpm = tempoFor(lastLevel);
      tgtG = sim.glowT > 0 ? sim.glow : 0;
      const lay = layersFor(lastLevel);
      if (lay !== layers) setLayers(lay);
      if (!unlocked || paused || hidden || muted) return;
      if (!musicOn) { setLayers(lay); startTrack(tgtBpm, 0, tgtG); return; }
      if (tgtBpm === curBpm && tgtG === curG) { T[1] = -1; return; }
      // a change is waiting: take it at the bar line. The engine starts a track MUSIC_START_LEAD_S after the call, so the call
      // goes on the FIRST frame that is that close to the line or closer: it starts 0 to one frame after the line, never
      // early, at any frame rate (30 fps: up to 33 ms late, 20 fps: up to 50 ms). No window to fall through.
      const b = audio.beatAt();
      if (b < 0) return; // the track has not started sounding yet
      if (T[1] < 0) T[1] = nw; // the change is first seen waiting now
      const spb = 60 / curBpm, into = (b % 4) * spb, toLine = 4 * spb - into;
      // a stall carried this frame over the line (into is small and smaller than the time since the last frame): the line is
      // behind us, so restart this same bar now rather than wait a whole bar
      const stalled = into <= dtNow && into <= STALL_S && T[1] < nw - into; // ...and the change was already waiting before the line
      if (toLine > MUSIC_START_LEAD_S && !stalled) return;
      const bar = (curBase + Math.floor(b / 4) + (stalled ? 0 : 1)) % BARS, from = curBpm;
      if (startTrack(tgtBpm, bar, tgtG)) {
        switches++;
        const e = logRing[(switches - 1) % LOG_MAX];
        e.t = audio.now(); e.from = from; e.bpm = tgtBpm; e.g = tgtG; e.bar = bar; e.lineLateMs = Math.round((stalled ? into + MUSIC_START_LEAD_S : MUSIC_START_LEAD_S - toLine) * 1000);
      }
    },

    // read-outs for the hook and the tests (these allocate: tests only, never the frame loop)
    state() {
      const sfx = {}, pl = {}, n = switches < LOG_MAX ? switches : LOG_MAX, log = [];
      for (let i = switches - n; i < switches; i++) log.push({ ...logRing[i % LOG_MAX] });
      SFX_LIST.forEach((n, i) => { sfx[n] = counts[i]; pl[n] = played[i]; });
      return {
        track: musicOn ? PIECE : null, variant: curId, bpm: musicOn ? curBpm : null, targetBpm: tgtBpm, layers,
        level: lastLevel, g: curG, targetG: tgtG, playing: musicOn, unlocked, paused, hidden, muted, starts, switches,
        switchLog: log, sfx, played: pl, last: last < 0 ? null : SFX_LIST[last], ctxState: audio.ctx ? audio.ctx.state : null
      };
    },
    get engine() { return audio; }
  };
  return api;
}
