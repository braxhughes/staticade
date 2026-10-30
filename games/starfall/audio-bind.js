// Starfall audio binding (S13a): one engine/audio.js instance, the sfx.js sound bank and the music.js tracks, wired to
// the sim's sound ids and the game's app states. Presentation only: no sim state is read or written here.
//
// NAME MAP: sim id (defs.js SFX_NAMES) -> sfx.js sound. The sim passes no kind with its ids, so main.js hands in what it
// knows from the same event batch (boss on? / enemy type of the explosion just before a pop / is this life a real ship?).
//   fire      -> shot          the player's shot
//   ding      -> hit           a hit that did not kill; bossHit while a boss is on (boss pieces, core and shields use ding)
//   pop       -> kill {kind}   an enemy died; kind from the explosion event just before it (KILL_KIND_OF). A pop with no
//                              explosion of its own (Hound) gets the neutral kill (no kind: the bank's default pop)
//   big       -> panelBreak    a boss piece broke (quieter, vol 0.5, when no boss is on: Warden and Hound kills, they already play kill)
//   die       -> playerDie     the ship was lost
//   kindle    -> kindle        meter full / Kindle used
//   life      -> extraLife     extra ship (SFX only: the engine has one music slot, so no jingle and the zone track runs on).
//                              A life id with no ship awarded (STARLIGHT perfect) plays STARLIGHT_PERFECT (coin) instead
//   warp      -> warp          stage warp, boss timeout
//   wingLost  -> wingLost      a wingman was lost
//   phase2    -> phase2        boss phase change
//   morph     -> morph         Splitter cracking / Pyre morph
//   deflect   -> deflect       a shot bounced
//   select    -> menuSelect    STARLIGHT: one per Complete phrase (sim/starlight.js, the phrase grade popup) and the finale of a
//                              clear without a perfect (the same cue as a menu pick). It rides on top of the bonus track and is not
//                              in its key on purpose: a short confirm tick, so it never fights the lead melody
//   jingle    -> SILENT        the run-start cue; the zone track starts at the same moment and does that job
//   beat      -> SILENT        STARLIGHT pulse; the bonus track is the pulse now (part b locks it to the beat clock)
//   bossDie   -> bossDie       boss death blast; the bossDefeat jingle follows when the stage clears
//   powerup   -> powerup, powerdown -> powerdown, cut -> cut, hunt -> hunt, snap -> snap   same names, same moments
//
// BEAT LOCK (S13b): the bonus track is the STARLIGHT pulse. Its beat 0 is the sim's beat 0 (stage frame 0, the first 'play'
// frame; 25 frames = 1 beat = 1 audio beat at 144 bpm, so one 4/4 bar = 100 frames). The sim gives its position in frames
// (api.beat(f); f < 0 during the stage card, null off STARLIGHT). The track is started only on a bar edge, LEAD frames early
// because the engine starts a track about 60 ms after the call; so every note lands on the sim's beat grid. A track start for
// any other reason (mute then unmute, a jingle that ends, first gesture) waits for the next bar edge the same way. The melody
// needs no extra scheduling: its beats are the track's beats, and the swing only delays odd 16ths (the off-beat ones).
// Audio clock: gestures only unlock audio that was never unlocked. Pause and a hidden tab suspend the context; it runs
// again only when the game is not paused, the tab is visible, and (after a hidden tab) the sound is not muted.
// RE-ANCHOR: once per bar the measured drift is nudged back toward 0 (engine nudge), so a pause, a hidden tab or a stall heals.
// Mute owns the master gain. Jingles: a state-driven track change (new stage, title, attract, name entry, mute) stops a
// playing jingle at once; the jingle hands back to the wanted track only when that did not change while it played.
import { createAudio, MUSIC_START_LEAD_S } from '../../engine/audio.js';
import { SFX, KILL_KINDS } from './sfx.js';
import { TRACKS, ZONE_TRACKS, BOSS_TRACKS } from './music.js';
import { SFX_NAMES } from './defs.js';

export const SILENT = null;
const NUDGE_MIN = 0.25, NUDGE_MAX = 2, REARM = 6, REARM_MS = 100; // re-anchor: ignore drift under 0.25 frame, move at most 2 frames per bar; past 6 frames wait for a fresh bar edge
const BAR_FRAMES = 100, FRAME_MS = 1000 / 60, ENGINE_LEAD_MS = MUSIC_START_LEAD_S * 1000; // 4 sim beats of 25 frames; a 60 Hz sim frame; engine/audio.js starts a track MUSIC_START_LEAD_S after the call
const LATE_MS = ENGINE_LEAD_MS - 10; // latest a bar-edge start call is still taken: the engine can pull the start back by this much and it is still in the future
// sim id -> sfx.js name (string) or SILENT; ding, big, pop and life get their variant in playSfx
export const SIM_MAP = {
  fire: 'shot', ding: 'hit', pop: 'kill', big: 'panelBreak', die: 'playerDie', kindle: 'kindle', life: 'extraLife', warp: 'warp',
  wingLost: 'wingLost', phase2: 'phase2', morph: 'morph', deflect: 'deflect', select: 'menuSelect', jingle: SILENT, beat: SILENT,
  bossDie: 'bossDie', powerup: 'powerup', powerdown: 'powerdown', cut: 'cut', hunt: 'hunt', snap: 'snap'
};
export const SILENT_IDS = SFX_NAMES.filter(n => SIM_MAP[n] === SILENT);
// enemy type id -> sfx.js kill kind (one line of reason each)
export const KILL_KIND_OF = {
  moth: 'moth', wisp: 'wisp', warden: 'warden', splitter: 'splitter', spark: 'spark', // their own sounds
  prism: 'wisp',        // a glass diamond: the glassy flick
  eel: 'spark',         // a ribbon of segments: the electric zap
  lamplighter: 'wisp',  // its lantern goes out: the airy fade
  cinder: 'spark',      // a hot ember: the crackle
  mirage: 'wisp',       // an illusion fading: the airy fade
  tether: 'splitter'    // one of a linked pair: the double pop
};
export const STARLIGHT_PERFECT = 'coin'; // a life id with no ship awarded: a bright two-note reward, not the extra-life cue
export { KILL_KINDS, ZONE_TRACKS, BOSS_TRACKS };

const NAME_OF = SFX_NAMES.map(n => SIM_MAP[n]); // by numeric id
const ID = {}; SFX_NAMES.forEach((n, i) => { ID[n] = i; });

export function createAudioBind(opts = {}) {
  const audio = createAudio({ tracks: TRACKS, sfx: SFX, ctx: opts.ctx });
  const O = { kind: undefined, vol: undefined }; // one reused options object
  let unlocked = false, muted = false, paused = false, hidden = false, held = false, clockRun = true;
  let want = null;            // the track the game wants now (zone, boss, title ...), null = none
  let playing = null;         // the music track id started (or queued before unlock); a jingle id while one plays
  let jingleOn = null;        // a jingle id while one plays
  let lastSfx = null, lastKind = null, lastVol = 1, sfxCount = 0, lastPop = null, pops = 0, jingles = 0; // test read-outs (SF.audioLast)
  let simF = null, anchorF = 0, wall0 = 0, wallN = 0, wallNow = 0,  waiting = false, anchored = false, drift = 0, lastBar = 0, lastI = -1, pos = 0, bigSince = 0, rearms = 0, nudges = 0; // beat lock (see BEAT LOCK above); lastI = last intensity sent
  const JO = { onEnd: null }, MO = { fadeMs: 120 }, SO = { fadeMs: 250 }, CUT = { fadeMs: 0 }; // reused options objects

  function startWant() {
    if (muted || jingleOn) return;
    if (want === playing && !waiting) return;
    anchored = false;
    if (want === null) { audio.stopMusic(SO); playing = null; waiting = false; return; }
    playing = want;
    if (simF !== null && TRACKS[want] && TRACKS[want].beatLocked) { waiting = true; audio.stopMusic(SO); tryAnchor(); return; }
    waiting = false; audio.playMusic(want, MO);
  }
  // start a beat-locked track on a bar edge of the sim's beat clock: LEAD frames before frame 0 or before a later bar edge
  function tryAnchor() {
    if (!waiting || !unlocked || muted || jingleOn || simF === null) return;
    if (wallN < 8) return; // the wall-clock fit needs a few steps
    // The sim steps in ticks that can be late (a busy main thread), so a bar edge is timed on the fitted wall clock of the sim
    // (wall0 = wall time of stage frame 0), not on the tick that happens to run. A start call is due at wall0 + edge - LEAD. Ticks
    // arrive in bursts under load, so the call is accepted from half a frame early to LATE_MS late (a window of one frame could
    // be missed bar after bar and the track would never start). A late call is corrected at once by pulling the track's grid back by
    // the lateness (engine nudge), up to what keeps its start in the future; the per-bar nudge heals the rest.
    let k = Math.ceil((wallNow - wall0 + ENGINE_LEAD_MS - LATE_MS) / (BAR_FRAMES * FRAME_MS));
    if (k < 0) k = 0;
    const edge = k * BAR_FRAMES, due = wall0 + edge * FRAME_MS - ENGINE_LEAD_MS;
    if (wallNow < due - FRAME_MS / 2) return; // not yet
    waiting = false; anchored = true; bigSince = 0; anchorF = edge; lastBar = 0;
    if (audio.playMusic(playing, MO)) { // audio beat 0 = sim frame anchorF
      const late = wallNow - due; // audio is this many ms behind the sim's beat (negative: ahead)
      if (late > 0.5 || late < -0.5) audio.nudge(-late / 1000);
    }
  }
  function onJingleEnd() { jingleOn = null; playing = null; startWant(); }
  JO.onEnd = onJingleEnd;
  // the context runs only when unlocked, not paused, the tab is visible and no muted return from a hidden tab holds it
  function clock() {
    const c = audio.ctx;
    if (!unlocked || !c || c.state === 'closed') return;
    const run = !paused && !hidden && !held;
    if (run === clockRun) return;
    clockRun = run;
    if (run) c.resume(); else c.suspend();
  }
  const live = () => unlocked && !muted && !paused && !hidden;

  const api = {
    // first gesture only: true when this call unlocked the audio (later gestures never touch the clock)
    unlock() {
      if (unlocked || !audio.unlock()) return false;
      unlocked = true; clockRun = true; clock();
      return true;
    },
    // play an sfx.js sound by its own name; true only when a sound was really started
    sfxName(name, o) {
      if (!live()) return false;
      return audio.sfx(name, o);
    },
    // play the sound for a sim id. boss: a boss is on; type: enemy type id of this pop's explosion (undefined: neutral);
    // noShip: a life id with no ship awarded
    playSfx(id, arg, boss, type, noShip) {
      const name = NAME_OF[id];
      if (name === undefined || name === null || !live()) return false;
      O.kind = undefined; O.vol = undefined;
      let n = name;
      if (id === ID.ding && boss) n = 'bossHit';
      else if (id === ID.big && !boss) O.vol = 0.5;
      else if (id === ID.pop) O.kind = type === undefined ? undefined : KILL_KIND_OF[type];
      else if (id === ID.life && noShip) n = STARLIGHT_PERFECT;
      if (id === ID.pop) { lastPop = O.kind === undefined ? null : O.kind; pops++; } // the kind chosen, even if the engine drops it
      const ok = audio.sfx(n, O);
      if (ok) { lastSfx = n; lastKind = O.kind === undefined ? null : O.kind; lastVol = O.vol === undefined ? 1 : O.vol; sfxCount++; }
      return ok;
    },
    // music: the track the game wants (null = none). A change stops a playing jingle; waits while muted.
    music(id) {
      id = id || null;
      if (id !== want) { want = id; jingleOn = null; }
      startWant();
    },
    stopMusic() { api.music(null); },
    // a short non-looping tune that takes the music slot; the wanted track starts when it ends (if still wanted)
    jingle(id) {
      if (!unlocked || muted || !TRACKS[id]) return false;
      jingleOn = id; playing = id; waiting = false; anchored = false;
      const ok = audio.playMusic(id, JO);
      if (ok) jingles++;
      if (!ok) { jingleOn = null; playing = null; startWant(); }
      return ok;
    },
    setMuted(m) {
      muted = !!m; audio.setMuted(muted);
      if (muted) { audio.stopMusic(CUT); playing = null; jingleOn = null; waiting = false; anchored = false; }
      else { held = false; clock(); startWant(); }
    },
    // w30: a suspend() sent while the very first resume() was still in flight can lose the race; asked again once settled
    settle() { const c = audio.ctx; if (unlocked && c && c.state === 'running' && (paused || hidden || held)) c.suspend(); },
    pause(on) { paused = !!on; wallN = 0; clock(); }, // wallN = 0: the wall-clock fit starts over after a pause
    // tab hidden (true) or visible again (false)
    hidden(on) {
      hidden = !!on; wallN = 0;
      if (!hidden && muted) held = true;
      clock();
    },
    // the sim's position on the STARLIGHT beat clock, once per sim step: frame f of the stage (negative on the stage card),
    // null when there is no beat clock. Starts a waiting beat-locked track and measures drift (sim frames, audio ahead > 0).
    beat(f) {
      if (f === null) {
        simF = null; anchored = false; wallN = 0;
        if (waiting) { waiting = false; if (unlocked && !muted && !jingleOn) audio.playMusic(playing, MO); }
        return;
      }
      simF = f; wallNow = performance.now();
      const o = wallNow - f * FRAME_MS; // wall time of frame 0 as this step sees it; averaged so one late tick does not move it
      if (wallN === 0) wall0 = o; else wall0 += (o - wall0) / (wallN < 16 ? wallN + 1 : 16);
      wallN++;
      tryAnchor();
      if (anchored) {
        pos = audio.beatAt() * 3600 / TRACKS[playing].bpm + anchorF; // the audio's position on the sim's frame grid
        drift = pos - f;
        // a big drift (a stall longer than the sim's 250 ms catch-up, fast-forward through test hooks) is not nudged: the track is
        // stopped and anchored again on a fresh bar edge, so drift never builds up (design.md z2 meter)
        // The drift must stay past the limit for REARM_MS of wall time: after a stall the sim catches up in a burst of steps that
        // read as a big negative drift for a few milliseconds, which is not drift.
        if (drift > REARM || drift < -REARM) {
          if (bigSince === 0) bigSince = wallNow;
          else if (wallNow - bigSince >= REARM_MS) {
            anchored = false; waiting = true; wallN = 0; bigSince = 0; rearms++;
            audio.stopMusic(SO);
            return;
          }
        } else bigSince = 0;
        // re-anchor: once per bar (4 sim beats) move the track's grid back toward the sim's, at most NUDGE_MAX frames a time, so a
        // long stall (the audio clock ran on while the sim was held back) heals over a few bars instead of jumping. Drift > 0 = audio ahead
        const bar = Math.floor((f - anchorF) / BAR_FRAMES);
        if (bar !== lastBar) {
          lastBar = bar;
          if (drift > NUDGE_MIN || drift < -NUDGE_MIN) { nudges++; audio.nudge((drift > NUDGE_MAX ? NUDGE_MAX : drift < -NUDGE_MAX ? -NUDGE_MAX : drift) * FRAME_MS / 1000); }
        }
      }
    },
    // music intensity 0..1 (engine setIntensity); the engine is only touched when the value changes
    intensity(x) { if (x !== lastI) { lastI = x; audio.setIntensity(x); } },
    state() {
      const t = playing && TRACKS[playing] ? TRACKS[playing] : null;
      return { track: playing, bpm: t ? t.bpm : null, drift: anchored && simF !== null ? drift : null, muted, unlocked,
        simF, anchor: anchored ? anchorF : null, pos: anchored ? pos : null, rearms, nudges, intensity: audio.getIntensity() };
    },
    // latest sim sound played (sfx, kind, vol), sim sounds played, the kind chosen for the latest pop, jingles started
    last() { return { sfx: lastSfx, kind: lastKind, vol: lastVol, count: sfxCount, pop: lastPop, pops, jingles }; },
    get engine() { return audio; }
  };
  return api;
}
