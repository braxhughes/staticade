// STACKLIGHT original score, "Afterglow" (design B.11, slice T4). Every note here was written for this game: an eight bar
// loop in D minor (natural), 4/4, with its own chords, bass line and arpeggio contour. No borrowed tune (Q-S1).
//
// LAYERS (they enter by level; the engine's intensity gates each channel):
//   1  pad + bass            levels 1 to 4
//   2  + arpeggio            levels 5 to 9
//   3  + drums               levels 10 and up
// TEMPO: 112 BPM at level 1, +8 BPM every 4 levels, capped at 144. The engine plays one fixed tempo per track, so a tempo
// change is a hand-over to the next tempo's track at a bar line (audio-bind.js does that), and each track is built to START
// at any bar of the loop (the eight bars are rotated), so the song carries on from the same bar.
// GLOW: the pad chord moves up one D minor scale step per GLOW step g (0 to 4). Pad notes only; bass and arpeggio stay put.
// Pure data and functions: no DOM, no audio context, no randomness. Tracks are built on demand and cached.

export const PIECE = 'afterglow';
export const BARS = 8;
export const BPM_BASE = 112, BPM_STEP = 8, BPM_MAX = 144, LEVELS_PER_TEMPO = 4;
export const GLOW_STEPS = 5; // g = 0 to 4

// level -> tempo and layer count (both pure, both tested)
export function tempoFor(level) {
  const l = level < 1 ? 1 : level;
  const b = BPM_BASE + BPM_STEP * Math.floor((l - 1) / LEVELS_PER_TEMPO);
  return b > BPM_MAX ? BPM_MAX : b;
}
export function layersFor(level) { return level >= 10 ? 3 : level >= 5 ? 2 : 1; }
export const INTENSITY_OF_LAYERS = [0, 0, 0.5, 1]; // index = layers; the channels' minI are 0, 0.5, 1

// ---------- note helpers ----------
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const mn = m => NAMES[m % 12] + (Math.floor(m / 12) - 1);
// D natural minor: D E F G A Bb C
const MINOR = [2, 4, 5, 7, 9, 10, 0];
const SCALE = [];
for (let m = 24; m <= 100; m++) if (MINOR.includes(m % 12)) SCALE.push(m);
// move a note up g steps of the scale (a note outside the scale counts from the scale note just below it)
export function stepUp(m, g) {
  let i = 0;
  while (i + 1 < SCALE.length && SCALE[i + 1] <= m) i++;
  return SCALE[Math.min(SCALE.length - 1, i + g)];
}

// ---------- the song: eight bars ----------
// pad chords (voice-led, MIDI), bass roots, bars 0 to 7:  Dm | Bb | F | C | Dm | Gm | Am | Bb
export const PAD = [[50, 53, 57], [50, 53, 58], [48, 53, 57], [48, 52, 55], [50, 53, 57], [50, 55, 58], [48, 52, 57], [50, 53, 58]];
export const ROOT = [38, 34, 41, 36, 38, 31, 33, 34];
const NEXT_ROOT_APPROACH = 36; // bar 7 walks C2 up into the D2 of bar 0

// the arpeggio rides on the pad chord one octave up; digits index [t0 t1 t2 t0+12 t1+12 t2+12 t0+24]; ^ accents the contour
const ARP = [
  '0 1 2 1 3^ 2 1 2 4^ 3 2 3 5^ 4 3 2',
  '0 1 2 1 3 2 1 2 4^ 3 2 3 3^ 2 1 0',
  '0 2 1 2 3^ 2 4 2 5^ 4 3 4 6^ 5 4 3',
  '0 1 2 3 4^ 3 2 1 2 3 4 5^ 4^ 3 2 1',
  '0 1 2 1 3^ 2 1 2 4^ 3 4 5^ 4 3 2 1',
  '0 2 1 2 3^ 2 1 0 1 2 3 4^ 3 2 1 2',
  '0 1 2 3^ 4 3 2 1 2 3 4 5^ 6^ 5 4 3',
  '0 1 2 3 4^ 3 2 1 0 1 2 1 0 1 2 3^'
];

const DRUM_A = 'k:1 .:1 h:1 .:1 s:1 .:1 h:1 .:1 k:1 .:1 h:1 k:1 s:1 .:1 h:1 o:1';
const DRUM_FILL = 'k:1 .:1 h:1 .:1 s:1 .:1 h:1 .:1 k:1 .:1 s:1 s:1 t:1 t:1 u:1 u:1';
const drumOf = bar => (bar === 3 || bar === 7 ? 'drumF' : 'drumA');

const CHANNELS = {
  pad: { wave: 'saw', vol: 0.085, lp: 1300, env: [0.25, 0, 1, 0.5], gate: 0.99, vib: [4.5, 9, 0.4], pan: 0.1 },
  bass: { wave: 'tri', vol: 0.2, gate: 0.9 },
  arp: { wave: 'pulse', duty: 0.125, vol: 0.055, gate: 0.6, minI: 0.5, pan: 0.25 },
  drums: { drum: true, vol: 0.42, minI: 1 }
};

function padPattern(bar, g) {
  const ch = PAD[bar].map(m => mn(stepUp(m, g))).join('+');
  return ch + ':16';
}
function bassPattern(bar) {
  const r = ROOT[bar], R = mn(r), O = mn(r + 12), F = mn(r + 7);
  const last = bar === 7 ? mn(NEXT_ROOT_APPROACH) : F;
  return `${R}:3 .:1 ${R}:2 .:2 ${O}:2 .:2 ${R}:2 ${last}:2`;
}
function arpPattern(bar) {
  const base = PAD[bar].map(m => m + 12);
  const pool = [base[0], base[1], base[2], base[0] + 12, base[1] + 12, base[2] + 12, base[0] + 24];
  return ARP[bar].split(' ').map(t => mn(pool[+t[0]]) + ':1' + (t[1] || '')).join(' ');
}

// The parts that do not change with tempo, start bar or GLOW are built ONCE and shared by every variant:
// bass, arpeggio and drum patterns (the same 8 bars under every id), the channels, and the pad patterns per GLOW step g (the
// pad is the only part g moves) as one patterns object per g, and the song order per start bar as one array per start bar.
const SHARED = { drumA: DRUM_A, drumF: DRUM_FILL };
for (let b = 0; b < BARS; b++) { SHARED['bass' + b] = bassPattern(b); SHARED['arp' + b] = arpPattern(b); }
const PATTERNS_OF_G = [];  // by g: SHARED plus the 8 pad patterns at that g
const SONG_OF_BAR = [];    // by start bar: the eight bars rotated to begin there
function patternsFor(g) {
  let p = PATTERNS_OF_G[g];
  if (!p) {
    p = Object.assign({}, SHARED);
    for (let b = 0; b < BARS; b++) p['pad' + b] = padPattern(b, g);
    PATTERNS_OF_G[g] = p;
  }
  return p;
}
function songFor(startBar) {
  let song = SONG_OF_BAR[startBar];
  if (!song) {
    song = [];
    for (let i = 0; i < BARS; i++) {
      const b = (startBar + i) % BARS;
      song.push({ bars: 1, p: { pad: 'pad' + b, bass: 'bass' + b, arp: 'arp' + b, drums: drumOf(b) } });
    }
    SONG_OF_BAR[startBar] = song;
  }
  return song;
}

const cache = new Map();
export const trackId = (bpm, startBar, g) => `${PIECE}-${bpm}-${startBar}-${g}`;

// the track at this tempo that begins at `startBar` of the loop with the pad lifted g scale steps
export function trackFor(bpm, startBar, g) {
  const id = trackId(bpm, startBar, g);
  let t = cache.get(id);
  if (t) return t;
  if (!(bpm >= BPM_BASE && bpm <= BPM_MAX) || (bpm - BPM_BASE) % BPM_STEP) throw new Error('bad tempo ' + bpm);
  if (!Number.isInteger(startBar) || startBar < 0 || startBar >= BARS) throw new Error('bad start bar ' + startBar);
  if (!Number.isInteger(g) || g < 0 || g >= GLOW_STEPS) throw new Error('bad glow step ' + g);
  t = { id, bpm, stepsPerBeat: 4, stepsPerBar: 16, key: 'Dm', loop: true, loopFrom: 0, channels: CHANNELS, patterns: patternsFor(g), song: songFor(startBar) };
  cache.set(id, t);
  return t;
}
