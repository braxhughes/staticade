// Web Audio chiptune engine: synth voices, tracker-style sequencer, SFX player.
// Pure synthesis, no audio files. Safe to import in node (no browser globals at load time).
// The same graph builds on a real AudioContext or an OfflineAudioContext (pass { ctx }).
//
// Public API: createAudio(opts) -> { unlock, setMuted, setVolume, sfx, playMusic, stopMusic,
//   setIntensity, now, beatAt, nudge, current, renderTo, registerTracks, registerSfx, ctx }
// Pattern syntax (strings): whitespace separated tokens, "|" ignored.
//   C4:2   note, length 2 steps (default 1)     C4+E4+G4:8  chord
//   .:4    rest of 4 steps                       k s h o c p t u  drum hits (kick snare hat open crash clap tom hitom)
//   suffix ^ accent, v soft.  Steps are 16ths when stepsPerBeat is 4.

// ---------- pure helpers (testable in node) ----------
const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const NOTE_RE = /^([A-G])([#b]?)(\d)$/;
const TOKEN_RE = /^(\.|[a-z]|[A-G][#b]?\d(?:\+[A-G][#b]?\d)*)(?::(\d+))?([\^v])?$/;
export const DRUM_KEYS = 'kshocptu';
export const MUSIC_START_LEAD_S = 0.06; // playMusic schedules a track's beat 0 this long after the call (beat-locked callers lead by it)
export const WAVES = ['pulse', 'tri', 'saw', 'sine', 'square', 'fm'];

export function noteToMidi(n) {
  const m = NOTE_RE.exec(n);
  if (!m) return NaN;
  return SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
}
export const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Parse a pattern string into { steps, slots[], errors[] }. slots[i] is null or an event starting at step i.
export function parsePattern(str) {
  const toks = String(str).split(/\s+/).filter((t) => t && t !== '|');
  const slots = [], errors = [];
  let steps = 0;
  for (const tk of toks) {
    const m = TOKEN_RE.exec(tk);
    if (!m) { errors.push('bad token "' + tk + '"'); continue; }
    const len = m[2] ? parseInt(m[2], 10) : 1;
    if (len < 1) { errors.push('zero length in "' + tk + '"'); continue; }
    const head = m[1];
    let ev = null;
    if (head !== '.') {
      ev = { len, accent: m[3] === '^' ? 1.3 : m[3] === 'v' ? 0.6 : 1 };
      if (/^[a-z]$/.test(head)) {
        if (!DRUM_KEYS.includes(head)) errors.push('unknown drum "' + head + '"');
        ev.drum = head;
      } else {
        ev.notes = head.split('+').map(noteToMidi);
      }
    }
    slots.push(ev);
    for (let i = 1; i < len; i++) slots.push(null);
    steps += len;
  }
  return { steps, slots, errors };
}

const prepCache = new WeakMap();
// Parse every pattern of a track once and compute section lengths.
export function prepareTrack(track) {
  let p = prepCache.get(track);
  if (p) return p;
  const pats = {};
  for (const k of Object.keys(track.patterns)) pats[k] = parsePattern(track.patterns[k]);
  const spb = track.stepsPerBar;
  const secSteps = track.song.map((s) => s.bars * spb);
  const stepDur = 60 / track.bpm / track.stepsPerBeat;
  const total = secSteps.reduce((a, b) => a + b, 0);
  p = { pats, secSteps, stepDur, totalSteps: total, duration: total * stepDur };
  prepCache.set(track, p);
  return p;
}

// Returns an array of error strings (empty = valid).
export function validateTrack(track) {
  const e = [];
  const id = track && track.id;
  const err = (s) => e.push((id || '?') + ': ' + s);
  if (!track || typeof track !== 'object') return ['track is not an object'];
  if (typeof track.id !== 'string' || !track.id) err('missing id');
  if (!(track.bpm >= 40 && track.bpm <= 240)) err('bpm out of range');
  if (!Number.isInteger(track.stepsPerBeat) || track.stepsPerBeat < 1) err('bad stepsPerBeat');
  if (!Number.isInteger(track.stepsPerBar) || track.stepsPerBar < 1) err('bad stepsPerBar');
  if (typeof track.key !== 'string') err('missing key');
  if (!track.channels || !Object.keys(track.channels).length) { err('no channels'); return e; }
  if (!track.patterns || !Array.isArray(track.song) || !track.song.length) { err('no patterns/song'); return e; }
  for (const [cn, c] of Object.entries(track.channels)) {
    if (!c.drum && !WAVES.includes(c.wave)) err('channel ' + cn + ' bad wave ' + c.wave);
    if (!(c.vol > 0 && c.vol <= 1)) err('channel ' + cn + ' vol out of (0,1]');
    if (c.minI != null && !(c.minI >= 0 && c.minI <= 1)) err('channel ' + cn + ' minI out of range');
    if (c.wave === 'pulse' && c.duty != null && !(c.duty > 0.04 && c.duty < 0.96)) err('channel ' + cn + ' duty');
  }
  const lens = {};
  for (const [pn, ps] of Object.entries(track.patterns)) {
    const p = parsePattern(ps);
    for (const x of p.errors) err('pattern ' + pn + ': ' + x);
    lens[pn] = p.steps;
    if (!p.steps) err('pattern ' + pn + ' is empty');
    // Bar-delimited patterns ("|" between bars): every bar must be exactly one bar long.
    if (ps.indexOf('|') >= 0) {
      ps.split('|').forEach((seg, bi) => {
        const n = parsePattern(seg).steps;
        if (n !== track.stepsPerBar) err('pattern ' + pn + ' bar ' + (bi + 1) + ' has ' + n + ' steps, expected ' + track.stepsPerBar);
      });
    }
    for (const ev of p.slots) {
      if (ev && ev.notes) for (const m of ev.notes) if (!(m >= 24 && m <= 108)) err('pattern ' + pn + ' note out of range (' + m + ')');
    }
  }
  let total = 0;
  track.song.forEach((sec, i) => {
    if (!Number.isInteger(sec.bars) || sec.bars < 1) { err('section ' + i + ' bars'); return; }
    const secSteps = sec.bars * track.stepsPerBar;
    total += secSteps;
    let any = false;
    for (const [cn, pn] of Object.entries(sec.p || {})) {
      const ch = track.channels[cn];
      if (!ch) { err('section ' + i + ' unknown channel ' + cn); continue; }
      if (!(pn in lens)) { err('section ' + i + ' unresolved pattern ' + pn); continue; }
      any = true;
      if (lens[pn] < 1 || secSteps % lens[pn] !== 0) err('section ' + i + ' pattern ' + pn + ' (' + lens[pn] + ' steps) does not divide section (' + secSteps + ')');
      const p = parsePattern(track.patterns[pn]);
      const hasDrum = p.slots.some((x) => x && x.drum), hasNote = p.slots.some((x) => x && x.notes);
      if (ch.drum && hasNote) err('pattern ' + pn + ' has notes on drum channel ' + cn);
      if (!ch.drum && hasDrum) err('pattern ' + pn + ' has drums on pitched channel ' + cn);
    }
    if (!any) err('section ' + i + ' is empty');
  });
  if (track.loop !== false) {
    const lf = track.loopFrom || 0;
    if (!(lf >= 0 && lf < track.song.length)) err('loopFrom out of range');
  }
  return e;
}

export function trackDuration(track) { return prepareTrack(track).duration; }

// Seconds-to-loop (time from song start until the loop point is reached the first time).
export function beatsPerSecond(track) { return track.bpm / 60; }

// Soft clip curve: transparent below 0.8, ceiling ~0.95.
function clipCurve() {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, a = Math.abs(x);
    c[i] = a <= 0.8 ? x : Math.sign(x) * (0.8 + 0.15 * Math.tanh((a - 0.8) / 0.15));
  }
  return c;
}

// ---------- engine ----------
export function createAudio(opts = {}) {
  const LOOKAHEAD = 0.25, TICK_MS = 50;
  const offline = !!(opts.ctx && typeof opts.ctx.startRendering === 'function');
  let ctx = opts.ctx || null;
  const tracks = Object.assign({}, opts.tracks || {});
  let bank = Object.assign({}, opts.sfx || {});
  let master, comp, shaper, musicBus, sfxBus, noiseBuf;
  const pulseWaves = new Map();
  let muted = false, vMusic = 0.8, vSfx = 0.9, intensity = 0.5;
  let cur = null, timer = null, pending = null, activeVoices = 0;
  const lastSfx = Object.create(null);
  const MASTER = 0.9;

  function build() {
    if (master) return true;
    if (!ctx) {
      const C = typeof globalThis !== 'undefined' && (globalThis.AudioContext || globalThis.webkitAudioContext);
      if (!C) return false;
      try { ctx = new C({ latencyHint: 'interactive' }); } catch (e) { return false; }
    }
    master = ctx.createGain();
    master.gain.value = muted ? 0 : MASTER;
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 14; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.18;
    musicBus = ctx.createGain(); musicBus.gain.value = vMusic;
    sfxBus = ctx.createGain(); sfxBus.gain.value = vSfx;
    musicBus.connect(master); sfxBus.connect(master);
    master.connect(comp);
    if (opts.limiter === false) comp.connect(ctx.destination);
    else {
      shaper = ctx.createWaveShaper(); shaper.curve = clipCurve();
      comp.connect(shaper); shaper.connect(ctx.destination);
    }
    // deterministic noise (no Math.random)
    const len = Math.floor(ctx.sampleRate * 2);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    let s = 0x9e3779b9 >>> 0;
    for (let i = 0; i < len; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; d[i] = (s / 2147483648) - 1; }
    return true;
  }

  function pulseWave(duty) {
    const key = Math.round(duty * 100);
    let w = pulseWaves.get(key);
    if (!w) {
      const N = 48, re = new Float32Array(N + 1), im = new Float32Array(N + 1), dd = key / 100;
      for (let n = 1; n <= N; n++) {
        const c = (2 * Math.sin(n * Math.PI * dd)) / (n * Math.PI);
        re[n] = c * Math.cos(n * Math.PI * dd); im[n] = c * Math.sin(n * Math.PI * dd);
      }
      w = ctx.createPeriodicWave(re, im);
      pulseWaves.set(key, w);
    }
    return w;
  }

  // One synth voice. o: w, f, f2 (slide end), sl (slide secs), dur, vol, a, d, s, r, duty, vib[rate,cents,delay],
  // fm[ratio,index], lp (lowpass hz), ft/q (noise filter type/Q), pan.
  function voice(dest, t, o) {
    const dur = Math.max(0.012, o.dur == null ? 0.1 : o.dur);
    const r = o.r == null ? 0.03 : o.r;
    const vol = o.vol == null ? 0.2 : o.vol;
    let a = o.a == null ? 0.004 : o.a, dd = o.d || 0;
    const sus = Math.max(0.0001, o.s == null ? 1 : o.s);
    if (a + dd > dur) { const k = dur / (a + dd); a *= k; dd *= k; }
    const g = ctx.createGain(), gp = g.gain;
    gp.setValueAtTime(0.0001, t);
    gp.linearRampToValueAtTime(vol, t + a);
    let hold = vol;
    if (dd > 0 && sus < 1) { hold = Math.max(0.0001, vol * sus); gp.exponentialRampToValueAtTime(hold, t + a + dd); }
    gp.setValueAtTime(hold, t + dur);
    gp.exponentialRampToValueAtTime(0.0001, t + dur + r);
    const end = t + dur + r + 0.03;
    let out = g, src;
    const f = Math.max(1, o.f || 440);
    if (o.w === 'noise') {
      src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
      const flt = ctx.createBiquadFilter();
      flt.type = o.ft || 'lowpass'; flt.Q.value = o.q == null ? 0.7 : o.q;
      flt.frequency.setValueAtTime(f, t);
      if (o.f2) flt.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t + (o.sl == null ? dur : o.sl));
      src.connect(flt); flt.connect(g);
      src.start(t, ((t * 7.31) % 1.5));
    } else {
      src = ctx.createOscillator();
      if (o.w === 'pulse') src.setPeriodicWave(pulseWave(o.duty || 0.5));
      else src.type = o.w === 'tri' ? 'triangle' : o.w === 'saw' ? 'sawtooth' : o.w === 'fm' ? 'sine' : (o.w || 'square');
      src.frequency.setValueAtTime(f, t);
      if (o.f2) src.frequency.exponentialRampToValueAtTime(Math.max(20, o.f2), t + (o.sl == null ? dur : o.sl));
      if (o.lp) {
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = o.lp; lp.Q.value = 0.5;
        src.connect(lp); lp.connect(g);
      } else src.connect(g);
      if (o.w === 'fm') {
        const ratio = o.fm ? o.fm[0] : 3.5, idx = o.fm ? o.fm[1] : 2.5;
        const mod = ctx.createOscillator(), mg = ctx.createGain();
        mod.type = 'sine'; mod.frequency.setValueAtTime(f * ratio, t);
        mg.gain.setValueAtTime(f * idx, t);
        mg.gain.exponentialRampToValueAtTime(Math.max(1, f * idx * 0.02), t + dur + r);
        mod.connect(mg); mg.connect(src.frequency);
        mod.start(t); mod.stop(end);
      }
      if (o.vib) {
        const lfo = ctx.createOscillator(), lg = ctx.createGain();
        lfo.frequency.value = o.vib[0]; lg.gain.setValueAtTime(0, t);
        lg.gain.linearRampToValueAtTime(o.vib[1], t + (o.vib[2] || 0) + 0.12);
        lfo.connect(lg); lg.connect(src.detune);
        lfo.start(t); lfo.stop(end);
      }
      src.start(t);
    }
    if (o.pan && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner(); p.pan.value = o.pan; out.connect(p); out = p;
    }
    out.connect(dest);
    src.stop(end);
    activeVoices++;
    src.onended = () => { activeVoices--; };
  }

  // ----- drum kit -----
  function drum(dest, t, key, vol) {
    switch (key) {
      case 'k':
        voice(dest, t, { w: 'sine', f: 165, f2: 44, sl: 0.11, dur: 0.14, vol: 0.9 * vol, r: 0.05 });
        voice(dest, t, { w: 'noise', f: 2600, ft: 'lowpass', dur: 0.012, vol: 0.25 * vol, r: 0.01 });
        break;
      case 's':
        voice(dest, t, { w: 'noise', f: 1900, ft: 'bandpass', q: 0.7, dur: 0.12, vol: 0.55 * vol, r: 0.06, d: 0.1, s: 0.2 });
        voice(dest, t, { w: 'tri', f: 230, f2: 130, sl: 0.07, dur: 0.07, vol: 0.4 * vol, r: 0.03 });
        break;
      case 'h': voice(dest, t, { w: 'noise', f: 7200, ft: 'highpass', dur: 0.03, vol: 0.28 * vol, r: 0.02 }); break;
      case 'o': voice(dest, t, { w: 'noise', f: 6400, ft: 'highpass', dur: 0.16, vol: 0.26 * vol, r: 0.08, d: 0.14, s: 0.2 }); break;
      case 'c': voice(dest, t, { w: 'noise', f: 4200, ft: 'highpass', dur: 0.5, vol: 0.3 * vol, r: 0.3, d: 0.45, s: 0.15 }); break;
      case 'p':
        for (let i = 0; i < 3; i++) voice(dest, t + i * 0.011, { w: 'noise', f: 1300, ft: 'bandpass', q: 1.2, dur: 0.02, vol: 0.4 * vol, r: 0.02 });
        voice(dest, t + 0.033, { w: 'noise', f: 1300, ft: 'bandpass', q: 1.2, dur: 0.1, vol: 0.4 * vol, r: 0.07, d: 0.08, s: 0.2 });
        break;
      case 't': voice(dest, t, { w: 'sine', f: 150, f2: 72, sl: 0.18, dur: 0.2, vol: 0.7 * vol, r: 0.05 }); break;
      case 'u': voice(dest, t, { w: 'sine', f: 230, f2: 120, sl: 0.15, dur: 0.17, vol: 0.6 * vol, r: 0.05 }); break;
    }
  }

  // ----- sequencer -----
  function activeCh(spec) { return intensity + 1e-6 >= (spec.minI || 0); }

  function playEvent(c, name, spec, ev, t) {
    const node = c.chan[name];
    if (!node) return;
    const vol = spec.vol * ev.accent;
    if (spec.drum) { drum(node, t, ev.drum, vol); return; }
    const dur = ev.len * c.stepDur * (spec.gate == null ? 0.92 : spec.gate);
    const env = spec.env || [0.004, 0, 1, 0.04];
    const per = ev.notes.length > 1 ? 0.8 / Math.sqrt(ev.notes.length) : 1;
    for (const m of ev.notes) {
      voice(node, t, {
        w: spec.wave, duty: spec.duty, f: midiToFreq(m + (spec.transpose || 0)), dur, vol: vol * per,
        a: env[0], d: env[1], s: env[2], r: env[3], vib: spec.vib, fm: spec.fm, lp: spec.lp, pan: 0
      });
    }
  }

  function stepOnce(c, now) {
    const tr = c.track, P = c.prep, sec = tr.song[c.sec];
    const swung = c.step % 2 === 1 && tr.swing ? c.nextTime + tr.swing * c.stepDur : c.nextTime;
    if (swung > now - 0.05) {
      for (const cn in sec.p) {
        const spec = tr.channels[cn];
        if (!activeCh(spec)) continue;
        const pat = P.pats[sec.p[cn]];
        const ev = pat.slots[c.step % pat.steps];
        if (ev) playEvent(c, cn, spec, ev, Math.max(swung, now));
      }
    }
    c.nextTime += c.stepDur;
    c.step++;
    c.totalSteps++;
    if (c.step >= P.secSteps[c.sec]) {
      c.step = 0; c.sec++;
      if (c.sec >= tr.song.length) {
        if (tr.loop === false) { c.done = true; c.endTime = c.nextTime + (tr.tail || 0.8); }
        else c.sec = tr.loopFrom || 0;
      }
    }
  }

  function pump(until) {
    if (!cur || cur.done) return;
    const now = ctx.currentTime;
    let guard = 4000;
    while (!cur.done && cur.nextTime < until && guard-- > 0) stepOnce(cur, now);
    if (cur.done && !cur.endNotified && !offline) {
      cur.endNotified = true;
      const c = cur;
      c.endTimer = setTimeout(() => {
        c.endTimer = null;
        if (cur !== c) return;           // replaced or stopped meanwhile: stay silent
        cleanup(c); cur = null; stopTimer();
        if (c.onEnd) c.onEnd(c.track.id);
      }, Math.max(0, (c.endTime - ctx.currentTime) * 1000));
    }
  }

  function tick() { if (ctx) pump(ctx.currentTime + LOOKAHEAD); }
  function startTimer() { if (!offline && !timer) timer = setInterval(tick, TICK_MS); }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

  // Disconnect every node a track created (channel gains, panners, sends, echo loop, bus).
  function cleanup(c) {
    for (const n of c.nodes) { try { n.disconnect(); } catch (e) { /* already gone */ } }
  }

  function fadeOut(c, fadeMs) {
    const now = ctx.currentTime, f = Math.max(0.02, fadeMs / 1000);
    c.done = true; c.endNotified = true;
    if (c.endTimer) { clearTimeout(c.endTimer); c.endTimer = null; }
    const gp = c.bus.gain;
    gp.cancelScheduledValues(now);
    gp.setValueAtTime(gp.value, now);
    gp.linearRampToValueAtTime(0.0001, now + f);
    if (!offline) setTimeout(() => cleanup(c), f * 1000 + 600);
  }

  function startTrack(id, o) {
    const tr = tracks[id];
    if (!tr) return false;
    const fade = o.fadeMs == null ? 0 : o.fadeMs;
    if (cur) { fadeOut(cur, fade || 40); }
    const now = ctx.currentTime;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(fade > 0 ? 0.0001 : 1, now);
    if (fade > 0) bus.gain.linearRampToValueAtTime(1, now + fade / 1000);
    bus.connect(musicBus);
    const P = prepareTrack(tr);
    const chan = {}, nodes = [bus];
    let echo = null;
    if (tr.echo) {
      const dl = ctx.createDelay(2), fb = ctx.createGain(), lp = ctx.createBiquadFilter(), wet = ctx.createGain();
      dl.delayTime.value = Math.min(1.9, (60 / tr.bpm) * (tr.echo.beats || 0.75));
      fb.gain.value = tr.echo.fb == null ? 0.35 : tr.echo.fb;
      lp.type = 'lowpass'; lp.frequency.value = 3200;
      wet.gain.value = tr.echo.mix == null ? 0.5 : tr.echo.mix;
      dl.connect(lp); lp.connect(fb); fb.connect(dl); lp.connect(wet); wet.connect(bus);
      echo = dl;
      nodes.push(dl, fb, lp, wet);
    }
    for (const cn of Object.keys(tr.channels)) {
      const spec = tr.channels[cn];
      const g = ctx.createGain();
      g.gain.value = activeCh(spec) ? 1 : 0;
      let out = g;
      if (spec.pan && ctx.createStereoPanner) { const p = ctx.createStereoPanner(); p.pan.value = spec.pan; g.connect(p); out = p; }
      out.connect(bus);
      nodes.push(g); if (out !== g) nodes.push(out);
      if (echo && spec.send) { const s = ctx.createGain(); s.gain.value = spec.send; out.connect(s); s.connect(echo); nodes.push(s); }
      chan[cn] = g;
    }
    cur = {
      track: tr, prep: P, bus, chan, nodes, sec: 0, step: 0, totalSteps: 0, stepDur: P.stepDur,
      startTime: now + MUSIC_START_LEAD_S, nextTime: now + MUSIC_START_LEAD_S, done: false, onEnd: o.onEnd || null
    };
    pump(offline ? 0 : now + LOOKAHEAD);
    startTimer();
    return true;
  }

  function applyIntensity() {
    if (!cur) return;
    const now = ctx.currentTime;
    for (const cn of Object.keys(cur.track.channels)) {
      cur.chan[cn].gain.setTargetAtTime(activeCh(cur.track.channels[cn]) ? 1 : 0, now, 0.07);
    }
  }

  // ----- sfx -----
  function playSfx(name, o) {
    let fn = bank[name];
    if (!fn && name.indexOf('.') > 0) { const [base, kind] = name.split('.'); fn = bank[base]; o = Object.assign({}, o, { kind }); }
    if (!fn) return false;
    const now = ctx.currentTime;
    if (!offline) {
      if (now - (lastSfx[name] || -1) < 0.02) return false;
      if (activeVoices > 90) return false;
    }
    lastSfx[name] = now;
    const t0 = now + 0.005;
    const pitch = (o && o.pitch) || 1, vm = (o && o.vol) == null ? 1 : o.vol;
    const h = {
      o: o || {},
      tone(spec, at) {
        const s = Object.assign({}, spec);
        if (s.f) s.f *= pitch; if (s.f2) s.f2 *= pitch;
        s.vol = (s.vol == null ? 0.2 : s.vol) * vm;
        voice(sfxBus, t0 + (at || 0), s);
      },
      noise(spec, at) {
        const s = Object.assign({}, spec, { w: 'noise' });
        s.vol = (s.vol == null ? 0.2 : s.vol) * vm;
        voice(sfxBus, t0 + (at || 0), s);
      }
    };
    fn(h, o || {});
    return true;
  }

  const api = {
    unlock() {
      if (!build()) return false;
      if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
      if (pending) { const p = pending; pending = null; startTrack(p.id, p.o); }
      return true;
    },
    setMuted(b) { muted = !!b; if (master) master.gain.setTargetAtTime(muted ? 0 : MASTER, ctx.currentTime, 0.015); },
    isMuted() { return muted; },
    setVolume(music, sfx) {
      if (music != null) vMusic = Math.max(0, Math.min(1, music));
      if (sfx != null) vSfx = Math.max(0, Math.min(1, sfx));
      if (master) {
        const t = ctx.currentTime;
        musicBus.gain.setTargetAtTime(vMusic, t, 0.015); sfxBus.gain.setTargetAtTime(vSfx, t, 0.015);
      }
    },
    sfx(name, o) { if (!master) return false; return playSfx(name, o); },
    playMusic(id, o = {}) {
      if (!master) { pending = { id, o }; return false; }
      pending = null;
      return startTrack(id, o);
    },
    stopMusic(o = {}) {
      pending = null;
      if (!cur) return;
      fadeOut(cur, o.fadeMs == null ? 300 : o.fadeMs);
      cur = null; stopTimer();
    },
    setIntensity(x) { intensity = Math.max(0, Math.min(1, +x || 0)); applyIntensity(); },
    getIntensity() { return intensity; },
    now() { return ctx ? ctx.currentTime : 0; },
    // Music beat position (float, continuous across loops) at audio-clock time t. -1 when no music.
    beatAt(t) {
      if (!cur) return -1;
      const tt = t == null ? ctx.currentTime : t;
      return ((tt - cur.startTime) * cur.track.bpm) / 60;
    },
    // Shift the playing track's beat grid by dt seconds (dt > 0 = later) without restarting it: notes already scheduled keep
    // their time, later ones follow the moved grid. Used to heal clock drift against an outside beat clock. No-op with no music.
    nudge(dt) { if (cur && dt) { cur.startTime += dt; cur.nextTime += dt; } },
    // Info about the playing track: { id, bpm, startTime, stepsPerBeat } or null.
    current() { return cur ? { id: cur.track.id, bpm: cur.track.bpm, startTime: cur.startTime, stepsPerBeat: cur.track.stepsPerBeat, stepsPerBar: cur.track.stepsPerBar } : null; },
    // Offline only: schedule music events up to `sec` seconds on the context clock.
    renderTo(sec) { if (cur) pump(sec); },
    registerTracks(t) { Object.assign(tracks, t); },
    registerSfx(b) { bank = Object.assign(bank, b); },
    get ctx() { return ctx; },
    get activeVoices() { return activeVoices; }
  };
  if (opts.ctx) build();
  return api;
}
