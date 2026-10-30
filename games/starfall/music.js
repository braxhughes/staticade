// Starfall original score. All melodies written for this game; no borrowed tunes.
// Track format is documented in engine/audio.js (patterns are bar-delimited strings, "|" between bars).
// TEMPO / BEAT CONTRACT: the game sim counts only quarter-note beats, at 60 fps.
//   Every track exposes bpm and framesPerBeat (= 3600 / bpm, always a whole number).
//   framesPerBar is exported only where it is also whole (null for 7/8 z2: 87.5 frames); the sim should not use bars.
//   Odd meters (z2 7/8, boss2 5/4) still count a quarter note as one beat.
// Swing (bonus, nameEntry) delays odd 16th notes only; beats and 8th notes stay on the grid, so beat scoring is unaffected.
// Known accepted limits: one chord per bar, so mid-bar chord changes are not expressed; the lead may pass through non-chord tones.
// Layers: each channel has minI, the intensity (0..1) at which it joins. Typical order:
//   lead/pad/bass 0 -> drums .15 -> counter/harm .3 -> arp .45 -> hats .6 -> extras .8

// ---------- composing helpers (data only) ----------
const NN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const PCS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const QUAL = { '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], dim: [0, 3, 6], sus4: [0, 5, 7], 5: [0, 7] };
const nm = (m) => NN[m % 12] + (Math.floor(m / 12) - 1);

function chordOf(sym) {
  const m = /^([A-G])([#b]?)(.*)$/.exec(sym);
  if (!m || !(m[3] in QUAL)) throw new Error('bad chord ' + sym);
  const root = (PCS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  return { root, iv: QUAL[m[3]] };
}
// 'F Dm*2 Bb' -> [chord, chord, chord, chord]
function prog(str) {
  const out = [];
  for (const t of str.split(/\s+/).filter(Boolean)) {
    const [s, n] = t.split('*');
    for (let i = 0; i < (n ? +n : 1); i++) out.push(chordOf(s));
  }
  return out;
}
const toneOf = (c, i, oct) => c.root + 12 * (oct + 1) + c.iv[i % c.iv.length] + 12 * Math.floor(i / c.iv.length);
// Fill a per-chord template. r root, q root+8ve, t third, f fifth, g fifth+8ve, x triad, y third+fifth, digit = chord tone index.
function comp(progStr, tpl, oct) {
  return prog(progStr).map((c) => tpl.split(/\s+/).filter(Boolean).map((tk) => {
    const m = /^([rqtfgxy]|\d)(.*)$/.exec(tk);
    if (!m) return tk;
    const h = m[1];
    let names;
    if (h === 'r') names = [toneOf(c, 0, oct)];
    else if (h === 'q') names = [toneOf(c, 0, oct) + 12];
    else if (h === 't') names = [toneOf(c, 1, oct)];
    else if (h === 'f') names = [toneOf(c, 2, oct)];
    else if (h === 'g') names = [toneOf(c, 2, oct) + 12];
    else if (h === 'x') names = [toneOf(c, 0, oct), toneOf(c, 1, oct), toneOf(c, 2, oct)];
    else if (h === 'y') names = [toneOf(c, 1, oct), toneOf(c, 2, oct)];
    else names = [toneOf(c, +h, oct)];
    return names.map(nm).join('+') + m[2];
  }).join(' ')).join(' | ');
}
const bassL = (p, tpl, oct = 2) => comp(p, tpl, oct);
const padL = (p, steps, oct = 3) => comp(p, 'x:' + steps, oct);
const M = (...bars) => bars.join(' | ');
const rep = (s, n) => Array(n).fill(s).join(' | ');
// Shift every pitched note by semis.
function tr(str, semis) {
  return str.replace(/[A-G][#b]?\d(?:\+[A-G][#b]?\d)*/g, (g) => g.split('+').map((n) => {
    const m = /^([A-G])([#b]?)(\d)$/.exec(n);
    const midi = PCS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (+m[3] + 1) * 12 + semis;
    return nm(midi);
  }).join('+'));
}
// Chord-tone harmony: for each bar, move every melody note to the nearest tone of that bar's TRIAD
// (root, third, fifth: exactly the notes the pad plays) that is at least 3 semitones below it.
// This keeps the harmony line off the pad's major V and dorian-6th colour tones, so it can never rub a semitone against the pad.
function harmC(str, progStr, minDrop = 3) {
  const chords = prog(progStr), bars = str.split('|');
  if (bars.length !== chords.length) throw new Error('harmC: ' + bars.length + ' bars vs ' + chords.length + ' chords');
  return bars.map((bar, i) => {
    const c = chords[i], pcs = [0, 1, 2].map((k) => (c.root + c.iv[k]) % 12);
    return bar.replace(/[A-G][#b]?\d/g, (n) => {
      const m = /^([A-G])([#b]?)(\d)$/.exec(n);
      let midi = PCS[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (+m[3] + 1) * 12 - minDrop;
      while (!pcs.includes(((midi % 12) + 12) % 12)) midi--;
      return nm(midi);
    });
  }).join('|');
}
// Drum bar sets (16 steps). k kick, s snare, h hat, o open hat, c crash, p clap, t/u toms.
const fillBars = (basic, fill, n) => [rep(basic, n - 1), fill].join(' | ');

const tracks = {};
function add(t) { tracks[t.id] = t; return t; }
const ECHO_NONE = null;

// =====================================================================
// TITLE: "Starfall"  A minor, 90 BPM. Wonder and a little loneliness.
// Motif: a slow falling triad (E D C A) answered by a rising fifth.
// =====================================================================
{
  const pA = 'Am F C G Am F C E', pB = 'Dm Am F E Dm Am E Am';
  const leadA = M(
    'A4:4 C5:4 E5:8', 'A4:2 C5:2 F5:4 E5:4 C5:4', 'E5:4 G5:4 E5:4 C5:4', 'D5:6 B4:2 G4:8',
    'A4:4 C5:4 E5:4 A5:4', 'G5:4 F5:4 E5:4 C5:4', 'D5:4 E5:4 G5:8', 'G#4:4 B4:4 E5:8');
  const leadB = M(
    'F5:4 A5:4 D6:8', 'E6:4 C6:4 A5:8', 'C6:4 A5:4 F5:8', 'B5:4 G#5:4 E5:8',
    'D6:4 F6:4 A6:8', 'E6:4 A6:4 C7:8', 'B6:4 G#6:4 E6:4 B5:4', 'A5:12 .:4');
  const leadA2 = M(
    'A4:2 C5:2 E5:4 A5:8', 'A4:2 C5:2 F5:4 E5:2 F5:2 A5:4', 'E5:2 G5:2 C6:4 B5:2 G5:2 E5:4', 'D5:4 G5:2 B5:2 D6:8',
    'A5:4 E5:4 C5:4 E5:4', 'G5:4 A5:4 C6:4 A5:4', 'D6:4 E6:4 G6:4 E6:4', 'G#5:4 B5:4 E6:8');
  add({
    id: 'title', name: 'Starfall', bpm: 90, key: 'A minor', mood: 'wonder, a little lonely, night sky',
    stepsPerBeat: 4, stepsPerBar: 16, echo: { beats: 0.75, fb: 0.4, mix: 0.45 }, loopFrom: 0,
    channels: {
      lead: { wave: 'pulse', duty: 0.25, vol: 0.13, env: [0.01, 0.15, 0.7, 0.12], vib: [5, 14, 0.3], send: 0.5 },
      harm: { wave: 'pulse', duty: 0.5, vol: 0.07, env: [0.01, 0.1, 0.6, 0.1], minI: 0.2, pan: -0.25, send: 0.3 },
      arp: { wave: 'pulse', duty: 0.125, vol: 0.06, gate: 0.55, minI: 0.1, pan: 0.3, send: 0.6 },
      pad: { wave: 'tri', vol: 0.11, env: [0.08, 0, 1, 0.2], gate: 1 },
      bass: { wave: 'tri', vol: 0.2, gate: 0.9 },
      drums: { drum: true, vol: 0.4, minI: 0.25 }
    },
    patterns: {
      arpI: comp('Am F', '0 1 2 3 2 1 2 1 0 1 2 3 2 1 2 1', 4), padI: padL('Am F', 16), bassI: comp('Am F', 'r:8 f:8', 2),
      leadA, leadB, leadA2, harmA2: harmC(leadA2, pA), harmB: harmC(leadB, pB),
      arpA: comp(pA, '0 1 2 3 2 1 2 1 0 1 2 3 2 1 2 1', 4), arpB: comp(pB, '0 2 1 2 3 2 1 2 0 2 1 2 3 2 1 2', 4),
      padA: padL(pA, 16), padB: padL(pB, 16),
      bassA: comp(pA, 'r:6 .:2 r:4 f:4', 2), bassB: comp(pB, 'r:4 f:4 q:4 f:4', 2),
      drA: fillBars('k . . . . . . . s . . . . . k .', 'k . . . . . . . s . . . t . u .', 4) + ' | ' + fillBars('k . . . . . . . s . . . . . k .', 'k . . . s . . . s . s . t t u u', 4)
    },
    song: [
      { bars: 2, p: { arp: 'arpI', pad: 'padI', bass: 'bassI' } },
      { bars: 8, p: { lead: 'leadA', arp: 'arpA', pad: 'padA', bass: 'bassA' } },
      { bars: 8, p: { lead: 'leadB', harm: 'harmB', arp: 'arpB', pad: 'padB', bass: 'bassB', drums: 'drA' } },
      { bars: 8, p: { lead: 'leadA2', harm: 'harmA2', arp: 'arpA', pad: 'padA', bass: 'bassA', drums: 'drA' } }
    ]
  });
}

// =====================================================================
// Z1  LANTERN REACH  F major, 120 BPM. Warm, hopeful, teaching, amber.
// Motif: "lighting the lantern": F A C (up the triad), then a long glow.
// =====================================================================
{
  const pA = 'F Am Bb C F Dm Gm C', pB = 'Bb F C Dm Bb F Gm C';
  const leadA = M(
    'F4:2 A4:2 C5:4 F5:6 E5:2', 'E5:4 C5:4 A4:4 C5:4', 'D5:2 F5:2 D5:4 Bb4:4 D5:4', 'E5:6 G5:2 E5:4 D5:4',
    'F4:2 A4:2 C5:4 F5:4 A5:4', 'G5:4 F5:4 D5:4 F5:4', 'D5:4 G5:4 Bb5:4 A5:2 G5:2', 'E5:6 D5:2 C5:2 Bb4:2 A4:2 G4:2');
  const leadA2 = M(
    'F4:2 A4:2 C5:4 F5:6 E5:2', 'E5:4 C5:4 A4:4 C5:4', 'D5:2 F5:2 D5:4 Bb4:4 D5:4', 'E5:6 G5:2 E5:4 D5:4',
    'F4:2 A4:2 C5:2 F5:2 A5:4 C6:4', 'G5:2 F5:2 D5:2 F5:2 G5:2 A5:2 Bb5:2 A5:2', 'Bb5:4 A5:4 G5:4 D5:4', 'E5:6 D5:2 C5:2 Bb4:2 A4:2 G4:2');
  const leadB = M(
    'D5:8 F5:4 Bb5:4', 'A5:8 C6:4 A5:4', 'G5:6 E5:2 G5:4 C6:4', 'A5:8 F5:4 D5:4',
    'D5:2 F5:2 Bb5:4 A5:4 F5:4', 'C5:4 F5:4 A5:4 C6:4', 'Bb5:6 A5:2 G5:4 D5:4', 'E5:4 G5:4 .:4 G4:2 C5:2');
  const dBasic = 'k . . . s . . . k . . . s . . .', dDrive = 'k . . . s . . k . . k . s . . .';
  const fill = 'k . . . s . . . k . s . t . u .';
  const hat = 'h . h . h . h . h . h . h . h .', hatO = 'h . h . h . h . h . h . h . o .';
  add({
    id: 'z1', name: 'Lantern Reach', bpm: 120, key: 'F major', mood: 'warm, hopeful, amber, teaching',
    stepsPerBeat: 4, stepsPerBar: 16, loopFrom: 1,
    channels: {
      lead: { wave: 'pulse', duty: 0.25, vol: 0.14, env: [0.005, 0.1, 0.7, 0.07], vib: [5.5, 16, 0.25] },
      harm: { wave: 'pulse', duty: 0.5, vol: 0.075, env: [0.005, 0.08, 0.6, 0.06], minI: 0.3, pan: -0.3 },
      counter: { wave: 'pulse', duty: 0.5, vol: 0.06, gate: 0.5, minI: 0.3, pan: 0.3 },
      arp: { wave: 'pulse', duty: 0.125, vol: 0.055, gate: 0.6, minI: 0.45, pan: 0.2 },
      pad: { wave: 'tri', vol: 0.1, env: [0.06, 0, 1, 0.15], gate: 1 },
      bass: { wave: 'tri', vol: 0.22, gate: 0.85 },
      drums: { drum: true, vol: 0.5, minI: 0.15 },
      hats: { drum: true, vol: 0.5, minI: 0.6 }
    },
    patterns: {
      padI: padL('F Am Bb C', 16), arpI: comp('F Am Bb C', '0 1 2 3 2 1 2 1 0 1 2 3 2 1 2 1', 4), bassI: comp('F Am Bb C', 'r:8 f:8', 2),
      hatsI: rep(hat, 4),
      leadA, leadA2, leadB, harmA2: harmC(leadA2, pA), harmB: harmC(leadB, pB), harmA: harmC(leadA, pA),
      padA: padL(pA, 16), padB: padL(pB, 16),
      bassA: comp(pA, 'r:3 .:1 r:2 q:2 r:2 f:2 r:2 q:2', 2), bassA2: comp(pA, 'r:2 r:2 q:2 r:2 r:2 r:2 q:2 f:2', 2),
      bassB: comp(pB, 'r:4 r:2 f:2 r:4 g:2 f:2', 2),
      arpA: comp(pA, '0 1 2 3 2 1 2 1 0 1 2 3 2 1 2 1', 4), arpB: comp(pB, '0 2 1 3 0 2 1 3 0 2 1 3 2 1 2 1', 4),
      stabA: comp(pA, '.:2 y:2 .:2 y:2 .:2 y:2 .:2 y:2', 4), stabB: comp(pB, '.:2 y:2 .:2 y:2 .:2 y:2 .:2 y:2', 4),
      drA: fillBars(dBasic, fill, 8), drA2: fillBars(dDrive, fill, 8),
      drB: fillBars(dBasic, 'k . . . s . . . s . s . s s s s', 8),
      hatsA: fillBars(hat, hatO, 8)
    },
    song: [
      { bars: 4, p: { pad: 'padI', arp: 'arpI', bass: 'bassI', hats: 'hatsI' } },
      { bars: 8, p: { lead: 'leadA', pad: 'padA', bass: 'bassA', drums: 'drA', arp: 'arpA', counter: 'stabA', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadA2', harm: 'harmA2', counter: 'stabA', pad: 'padA', bass: 'bassA2', drums: 'drA2', hats: 'hatsA', arp: 'arpA' } },
      { bars: 8, p: { lead: 'leadB', harm: 'harmB', counter: 'stabB', pad: 'padB', bass: 'bassB', drums: 'drB', hats: 'hatsA', arp: 'arpB' } },
      { bars: 8, p: { lead: 'leadA', harm: 'harmA', counter: 'stabA', pad: 'padA', bass: 'bassA2', drums: 'drA2', hats: 'hatsA', arp: 'arpA' } }
    ]
  });
}

// =====================================================================
// Z2  GLASS TIDE  E dorian, 7/8, 144 BPM (quarter). Cool, flowing, teal and violet.
// Bar = 14 sixteenths grouped 6+4+4. Echoing bell lead over a rolling arpeggio.
// =====================================================================
{
  const pA = 'Em7 A Em7 A Cmaj7 D Bm7 Bm7', pB = 'Cmaj7 Bm7 Am7 D G Cmaj7 Bm7 B';
  const leadA = M(
    'E5:3 G5:3 B5:2 A5:2 G5:2 E5:2', 'A5:3 C#6:3 B5:2 A5:2 E5:2 C#5:2', 'E5:3 G5:3 B5:2 D6:2 B5:2 G5:2', 'C#6:6 B5:2 A5:2 E5:4',
    'G5:3 B5:3 E6:2 D6:2 B5:2 G5:2', 'F#5:3 A5:3 D6:2 C#6:2 A5:2 F#5:2', 'D6:6 C#6:2 B5:2 A5:2 F#5:2', 'B5:8 .:2 F#5:2 G5:2');
  const leadB = M(
    'B5:6 G5:4 E5:4', 'D6:6 B5:4 F#5:4', 'C6:6 A5:4 E5:4', 'A5:3 D6:3 F#6:4 E6:2 D6:2',
    'D6:6 B5:4 G5:4', 'E6:6 C6:4 G5:4', 'D6:4 F#6:4 A6:6', 'G6:6 F#6:4 D#6:2 B5:2');
  const dB = 'k . . . . . s . . . k . . .', dB2 = 'k . . k . . s . . . k . s .';
  const hat = 'h . h . h . h . h . h . h .';
  add({
    id: 'z2', name: 'Glass Tide', bpm: 144, key: 'E dorian', mood: 'cool, flowing, teal and violet, glassy', meter: '7/8',
    stepsPerBeat: 4, stepsPerBar: 14, echo: { beats: 0.75, fb: 0.42, mix: 0.5 }, loopFrom: 1,
    channels: {
      lead: { wave: 'fm', fm: [3.5, 1.3], vol: 0.12, env: [0.003, 0.2, 0.6, 0.25], send: 0.45 },
      harm: { wave: 'pulse', duty: 0.25, vol: 0.06, env: [0.01, 0.1, 0.6, 0.12], minI: 0.3, pan: 0.3, send: 0.5 },
      arp: { wave: 'pulse', duty: 0.125, vol: 0.06, gate: 0.55, minI: 0.1, pan: -0.25, send: 0.65 },
      pad: { wave: 'tri', vol: 0.1, env: [0.12, 0, 1, 0.25], gate: 1, pan: 0.1 },
      bass: { wave: 'tri', vol: 0.21, gate: 0.85 },
      drums: { drum: true, vol: 0.45, minI: 0.2 },
      hats: { drum: true, vol: 0.45, minI: 0.55 }
    },
    patterns: {
      padI: padL('Em7 A', 14), arpI: comp('Em7 A', '0 1 2 3 4 3 2 1 0 1 2 3 2 1', 4), bassI: comp('Em7 A', 'r:14', 2),
      leadA, leadB, harmA: harmC(leadA, pA), harmB: harmC(leadB, pB),
      padA: padL(pA, 14), padB: padL(pB, 14),
      bassA: comp(pA, 'r:6 r:2 f:2 r:2 q:2', 2), bassB: comp(pB, 'r:3 r:3 f:4 g:2 f:2', 2),
      arpA: comp(pA, '0 1 2 3 4 3 2 1 0 1 2 3 2 1', 4), arpB: comp(pB, '0 2 1 3 2 4 3 2 1 3 2 1 2 1', 4),
      drA: fillBars(dB, 'k . . . . . s . . . s s t u', 8), drB: fillBars(dB2, 'k . . k . . s . . . s s t u', 8),
      hatsA: rep(hat, 8)
    },
    song: [
      { bars: 2, p: { pad: 'padI', arp: 'arpI', bass: 'bassI' } },
      { bars: 8, p: { lead: 'leadA', pad: 'padA', bass: 'bassA', arp: 'arpA', drums: 'drA' } },
      { bars: 8, p: { lead: 'leadA', harm: 'harmA', pad: 'padA', bass: 'bassA', arp: 'arpA', drums: 'drB', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadB', harm: 'harmB', pad: 'padB', bass: 'bassB', arp: 'arpB', drums: 'drB', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadA', harm: 'harmA', pad: 'padA', bass: 'bassA', arp: 'arpB', drums: 'drB', hats: 'hatsA' } }
    ]
  });
}

// =====================================================================
// Z3  HOLLOW SUN  D minor, 180 BPM. Urgent, crimson, relentless.
// Motif: a repeated-note "flare" (D D F A) driving into leaps; major V (A) for heat.
// =====================================================================
{
  const pA = 'Dm Dm Bb A Dm Dm Gm A', pB = 'F C Bb A Bb F Gm A', pC = 'Dm*4 Bb*2 A*2';
  const leadA = M(
    'D5:2 D5:1 F5:1 A5:2 G5:2 F5:2 E5:2 D5:2 F5:2', 'A5:2 A5:1 C6:1 D6:4 C6:2 A5:2 F5:4', 'Bb5:2 Bb5:1 A5:1 G5:2 F5:2 D5:2 F5:2 G5:2 Bb5:2', 'A5:4 C#6:4 E6:4 D6:2 C#6:2',
    'D5:2 D5:1 F5:1 A5:2 G5:2 F5:2 E5:2 D5:2 F5:2', 'D6:2 D6:1 E6:1 F6:4 E6:2 D6:2 A5:4', 'G5:2 Bb5:2 D6:4 C6:2 Bb5:2 A5:2 G5:2', 'A5:2 C#6:2 E6:2 A6:2 G6:2 E6:2 C#6:2 A5:2');
  const leadB = M(
    'A5:4 C6:4 F6:8', 'E6:4 G6:4 E6:4 C6:4', 'D6:4 F6:4 D6:4 Bb5:4', 'C#6:4 E6:4 A6:8',
    'Bb5:2 D6:2 F6:4 D6:4 Bb5:4', 'C6:2 F6:2 A6:4 F6:4 C6:4', 'D6:4 G6:4 Bb6:4 A6:4', 'A6:2 G6:2 F6:2 E6:2 D6:2 C#6:2 E6:2 A5:2');
  const leadC = M(
    rep('D6 A5 F5 A5 D6 A5 F5 A5 D6 A5 F5 A5 D6 A5 F5 A5', 2), rep('F6 A5 D5 A5 F6 A5 D5 A5 F6 A5 D5 A5 F6 A5 D5 A5', 2),
    rep('D6 Bb5 F5 Bb5 D6 Bb5 F5 Bb5 D6 Bb5 F5 Bb5 D6 Bb5 F5 Bb5', 2),
    'E6 C#6 A5 C#6 E6 C#6 A5 C#6 E6 C#6 A5 C#6 E6 C#6 A5 C#6', 'A6:2 G6:2 E6:2 C#6:2 A5:2 C#6:2 E6:2 A6:2');
  const dr = 'k . k k s . . k . . k . s . k .', fl = 's s s s t t u u k . k . s s s s';
  const hat = 'h^ h h h h^ h h h h^ h h h h^ h o h';
  add({
    id: 'z3', name: 'Hollow Sun', bpm: 180, key: 'D minor', mood: 'urgent, crimson, relentless',
    stepsPerBeat: 4, stepsPerBar: 16, loopFrom: 1,
    channels: {
      lead: { wave: 'pulse', duty: 0.125, vol: 0.14, env: [0.003, 0.06, 0.75, 0.04], vib: [6.5, 12, 0.2], gate: 0.88 },
      harm: { wave: 'pulse', duty: 0.5, vol: 0.07, env: [0.003, 0.06, 0.7, 0.04], minI: 0.3, pan: -0.3 },
      counter: { wave: 'pulse', duty: 0.25, vol: 0.06, gate: 0.4, minI: 0.3, pan: 0.3 },
      arp: { wave: 'pulse', duty: 0.25, vol: 0.05, gate: 0.5, minI: 0.45, pan: 0.2 },
      pad: { wave: 'tri', vol: 0.09, env: [0.03, 0, 1, 0.1], gate: 1 },
      bass: { wave: 'tri', vol: 0.22, gate: 0.7 },
      drums: { drum: true, vol: 0.5, minI: 0.15 },
      hats: { drum: true, vol: 0.45, minI: 0.55 }
    },
    patterns: {
      padI: padL('Dm Dm Bb A', 16), bassI: comp('Dm Dm Bb A', 'r:2 r:2 r:2 r:2 r:2 r:2 r:2 r:2', 2), hatsI: rep(hat, 4),
      arpI: comp('Dm Dm Bb A', '0 2 1 2 0 2 1 2 0 2 1 2 0 2 1 2', 4),
      leadA, leadB, leadC, harmA: harmC(leadA, pA), harmB: harmC(leadB, pB),
      padA: padL(pA, 16), padB: padL(pB, 16), padC: padL(pC, 16),
      bassA: comp(pA, 'r r q r r q r r r q r r q r f g', 2), bassB: comp(pB, 'r:2 r:1 r:1 q:2 r:2 r:2 r:1 r:1 f:2 q:2', 2),
      bassC: comp(pC, 'r r r r q r r r r r r r q r q r', 2),
      arpA: comp(pA, '0 2 1 2 0 2 1 2 0 2 1 2 0 2 1 2', 4), arpB: comp(pB, '0 1 2 1 0 1 2 3 0 1 2 1 2 3 2 1', 4),
      stabA: comp(pA, 'x:1 .:1 x:1 .:1 .:2 x:1 .:1 x:1 .:1 .:2 x:1 .:1 x:1 .:1', 4), stabB: comp(pB, '.:2 y:2 .:2 y:2 .:2 y:2 .:2 y:2', 4),
      drA: fillBars(dr, fl, 8), hatsA: fillBars(hat, 'h h h h h h h h h h h h c . . .', 8)
    },
    song: [
      { bars: 4, p: { pad: 'padI', bass: 'bassI', arp: 'arpI', hats: 'hatsI' } },
      { bars: 8, p: { lead: 'leadA', pad: 'padA', bass: 'bassA', drums: 'drA', arp: 'arpA', counter: 'stabA', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadA', harm: 'harmA', pad: 'padA', bass: 'bassA', drums: 'drA', arp: 'arpA', counter: 'stabA', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadB', harm: 'harmB', pad: 'padB', bass: 'bassB', drums: 'drA', arp: 'arpB', counter: 'stabB', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadC', pad: 'padC', bass: 'bassC', drums: 'drA', arp: 'arpA', counter: 'stabA', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadA', harm: 'harmA', pad: 'padA', bass: 'bassA', drums: 'drA', arp: 'arpB', counter: 'stabA', hats: 'hatsA' } }
    ]
  });
}

// =====================================================================
// BOSS 1  ECLIPSE  C minor, 100 BPM (half-time grind). Heavy, brooding.
// Motif: C . Gb G : a tritone "shadow" step that resolves up a half step.
// =====================================================================
{
  const pA = 'Cm Cm Ab G Cm Cm Fm G', pB = 'Ab Bb Cm Cm Ab Bb G G';
  const leadA = M(
    'C5:3 .:1 Gb5:3 .:1 G5:4 .:4', 'Eb5:2 F5:2 G5:4 Eb5:4 C5:4', 'Ab4:3 .:1 Eb5:3 .:1 Ab5:4 G5:4', 'B4:4 D5:4 G5:4 F5:4',
    'C5:3 .:1 Gb5:3 .:1 G5:2 Ab5:2 Bb5:4', 'C6:4 Bb5:4 G5:4 Eb5:4', 'F5:4 Ab5:4 C6:4 Ab5:4', 'D6:4 B5:4 G5:4 .:2 B4:2');
  const leadB = M(
    'Eb5:4 Ab5:4 C6:8', 'D6:4 F6:4 Bb5:8', 'Eb6:8 C6:4 G5:4', 'G5:4 C6:4 Eb6:4 G6:4',
    'Ab5:4 C6:4 Eb6:4 Ab6:4', 'Bb5:4 D6:4 F6:4 Bb6:4', 'B5:4 D6:4 G6:8', 'G6:2 F6:2 D6:2 B5:2 G5:8');
  const h1 = 'k . . . . . . . s . . . . . k .', h2 = 'k . . k . . k . s . . . k . . .';
  add({
    id: 'boss1', name: 'Eclipse', bpm: 100, key: 'C minor', mood: 'heavy, brooding, a slow dark grind',
    stepsPerBeat: 4, stepsPerBar: 16, loopFrom: 1,
    channels: {
      lead: { wave: 'pulse', duty: 0.25, vol: 0.14, env: [0.004, 0.08, 0.7, 0.06], vib: [5, 20, 0.3], gate: 0.85 },
      harm: { wave: 'pulse', duty: 0.5, vol: 0.07, minI: 0.3, pan: -0.3, env: [0.004, 0.08, 0.6, 0.06] },
      arp: { wave: 'pulse', duty: 0.125, vol: 0.05, gate: 0.5, minI: 0.45, pan: 0.3 },
      pad: { wave: 'tri', vol: 0.1, env: [0.04, 0, 1, 0.12], gate: 1 },
      bass: { wave: 'pulse', duty: 0.5, vol: 0.13, lp: 700, gate: 0.7 },
      sub: { wave: 'tri', vol: 0.2, gate: 1 },
      drums: { drum: true, vol: 0.55, minI: 0.1 },
      hats: { drum: true, vol: 0.4, minI: 0.6 }
    },
    patterns: {
      padI: padL('Cm*4', 16), subI: comp('Cm*4', 'r:16', 2), drI: M('k . . . . . . . . . . . . . . .', 'k . . . . . . . . . . . t . t .', 'k . . . . . . . s . . . . . . .', 'k . . . s . . . t t u u s s s s'),
      bassI: comp('Cm*4', 'r:3 .:1 r:2 q:2 r:2 .:2 r:2 f:2', 2),
      leadA, leadB, harmA: harmC(leadA, pA), harmB: harmC(leadB, pB),
      padA: padL(pA, 16), padB: padL(pB, 16), subA: comp(pA, 'r:16', 2), subB: comp(pB, 'r:16', 2),
      bassA: comp(pA, 'r:2 r:2 .:2 r:2 q:2 r:2 .:2 f:2', 2), bassB: comp(pB, 'r:2 r:2 q:2 r:2 r:2 r:2 q:2 f:2', 2),
      arpA: comp(pA, '0 1 2 1 0 1 2 3 0 1 2 1 2 3 2 1', 4), arpB: comp(pB, '0 2 1 2 0 2 1 2 0 2 3 2 1 2 3 2', 4),
      drA: fillBars(h1, 'k . . . . . . . s . . . t t u u', 8), drB: fillBars(h2, 'k . k . s . . . t t u u s s s s', 8),
      hatsA: rep('h . . . h . . . h . . . h . h .', 8), hatsB: rep('h . h . h . h . h . h . h . h h', 8)
    },
    song: [
      { bars: 4, p: { pad: 'padI', sub: 'subI', bass: 'bassI', drums: 'drI' } },
      { bars: 8, p: { lead: 'leadA', pad: 'padA', sub: 'subA', bass: 'bassA', drums: 'drA', arp: 'arpA', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadA', harm: 'harmA', pad: 'padA', sub: 'subA', bass: 'bassA', drums: 'drA', arp: 'arpA', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadB', harm: 'harmB', pad: 'padB', sub: 'subB', bass: 'bassB', drums: 'drB', arp: 'arpB', hats: 'hatsB' } }
    ]
  });
}

// =====================================================================
// BOSS 2  SHARDS  F# minor, 5/4, 150 BPM. Icy, staccato, syncopated.
// Bar = 20 sixteenths grouped 6+6+4+4. Glassy FM stabs over a snapping groove.
// =====================================================================
{
  const pA = 'F#m Dmaj7 Bm7 C# F#m Dmaj7 Bm7 C#', pB = 'Bm D C# F#m Bm D C# C#';
  const leadA = M(
    'F#5:2 A5:2 C#6:2 E6:2 C#6:2 A5:2 F#5:4 C#6:2 .:2', 'D5:2 F#5:2 A5:2 C#6:2 A5:2 F#5:2 D6:4 C#6:2 .:2', 'B5:2 D6:2 F#6:2 A6:2 F#6:2 D6:2 B5:4 D6:2 .:2', 'C#6:2 F6:2 G#6:2 F6:2 C#6:2 G#5:2 C#6:4 F6:4',
    'A5:2 C#6:2 E6:2 F#6:2 E6:2 C#6:2 A5:4 F#5:2 A5:2', 'F#5:2 A5:2 D6:2 F#6:2 D6:2 A5:2 C#6:4 A5:2 F#5:2', 'D6:2 F#6:2 B6:2 A6:2 F#6:2 D6:2 B5:4 A5:2 F#5:2', 'G#5:2 C#6:2 F6:2 G#6:2 F6:2 C#6:2 G#5:4 .:4');
  const leadB = M(
    'D6:6 B5:6 F#5:8', 'A5:6 F#5:6 D6:8', 'G#5:6 C#6:6 F6:8', 'C#6:6 A5:6 F#5:8',
    'B5:4 D6:4 F#6:4 A6:8', 'A6:4 F#6:4 D6:4 A5:8', 'G#5:4 C#6:4 F6:4 G#6:8', 'G#6:6 F6:6 C#6:4 .:4');
  const dk = 'k . . . . . k . . . . . s . . . s . k .', dk2 = 'k . . k . . k . . . k . s . . . s . s s';
  add({
    id: 'boss2', name: 'Shards', bpm: 150, key: 'F# minor', mood: 'icy, staccato, syncopated, shattering glass', meter: '5/4',
    stepsPerBeat: 4, stepsPerBar: 20, echo: { beats: 0.75, fb: 0.35, mix: 0.4 }, loopFrom: 1,
    channels: {
      lead: { wave: 'fm', fm: [3.5, 1.8], vol: 0.12, env: [0.002, 0.12, 0.4, 0.12], gate: 0.7, send: 0.35 },
      harm: { wave: 'pulse', duty: 0.125, vol: 0.06, gate: 0.5, minI: 0.3, pan: 0.3, send: 0.4 },
      arp: { wave: 'pulse', duty: 0.25, vol: 0.05, gate: 0.5, minI: 0.45, pan: -0.3, send: 0.4 },
      pad: { wave: 'tri', vol: 0.09, env: [0.05, 0, 1, 0.15], gate: 1 },
      bass: { wave: 'pulse', duty: 0.25, vol: 0.14, lp: 900, gate: 0.6 },
      sub: { wave: 'tri', vol: 0.16, gate: 0.95 },
      drums: { drum: true, vol: 0.5, minI: 0.1 },
      hats: { drum: true, vol: 0.4, minI: 0.55 }
    },
    patterns: {
      padI: padL('F#m*2', 20), subI: comp('F#m*2', 'r:20', 2), drI: M(dk, dk2),
      leadA, leadB, harmA: harmC(leadA, pA), harmB: harmC(leadB, pB),
      padA: padL(pA, 20), padB: padL(pB, 20), subA: comp(pA, 'r:20', 2), subB: comp(pB, 'r:20', 2),
      bassA: comp(pA, 'r:3 q:1 r:2 r:3 f:1 r:2 r:2 q:2 f:2 r:2', 2), bassB: comp(pB, 'r:2 .:1 r:1 q:2 r:2 .:1 r:1 f:2 r:2 q:2 f:2 r:2', 2),
      arpA: comp(pA, '0 1 2 3 2 1 0 1 2 3 2 1 0 2 1 2 0 2 3 2', 4), arpB: comp(pB, '0 2 1 2 0 2 1 2 0 2 1 2 3 2 1 2 3 2 1 2', 4),
      drA: fillBars(dk, 'k . . . . . s . s . s . t . u . s s s s', 8), drB: fillBars(dk2, 'k . . k . . s . s . s . t . u . s s s s', 8),
      hatsA: rep('h . h . h . h . h . h . h . h . h . h .', 8)
    },
    song: [
      { bars: 2, p: { pad: 'padI', sub: 'subI', drums: 'drI' } },
      { bars: 8, p: { lead: 'leadA', pad: 'padA', sub: 'subA', bass: 'bassA', drums: 'drA', arp: 'arpA', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadA', harm: 'harmA', pad: 'padA', sub: 'subA', bass: 'bassA', drums: 'drB', arp: 'arpA', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadB', harm: 'harmB', pad: 'padB', sub: 'subB', bass: 'bassB', drums: 'drB', arp: 'arpB', hats: 'hatsA' } }
    ]
  });
}

// =====================================================================
// BOSS 3  NOVA REQUIEM  C# minor, 200 BPM. Epic, fast, climactic.
// Motif: rising minor arpeggio that leaps an octave; the G# major dominant is the cliff edge.
// =====================================================================
{
  const pA = 'C#m A E B C#m A F#m G#', pB = 'A B G#m C#m A B G# G#';
  const leadA = M(
    'C#6:2 E6:2 G#6:4 F#6:2 E6:2 C#6:4', 'A5:2 C#6:2 E6:4 D6:2 C#6:2 A5:4', 'B5:2 E6:2 G#6:4 B6:4 G#6:4', 'A#5:2 D#6:2 F#6:4 A#6:2 F#6:2 D#6:4',
    'C#6:1 C#6:1 E6:2 G#6:2 C#7:2 B6:2 G#6:2 E6:2 C#6:2', 'A6:4 G#6:2 E6:2 C#6:4 A5:4', 'F#6:4 A6:4 C#7:4 A6:4', 'G#5:2 C6:2 D#6:2 G#6:2 C7:2 D#7:2 G#6:2 D#6:2');
  const leadB = M(
    'E6:4 A6:4 C#7:8', 'D#6:4 F#6:4 B6:8', 'D#6:4 G#6:4 B6:8', 'C#6:4 E6:4 G#6:4 C#7:4',
    'C#7:4 B6:4 A6:4 E6:4', 'D#6:2 F#6:2 B6:4 A#6:4 F#6:4', 'G#6:4 C7:4 D#7:8', 'D#7:2 C7:2 G#6:2 D#6:2 G#5:8');
  const dr = 'k . . . s . k . k . . k s . . .', dr2 = 'k . k . s . k . k . k . s . k k';
  const fl = 's s t t u u s s k . k . s s s s';
  add({
    id: 'boss3', name: 'Nova Requiem', bpm: 200, key: 'C# minor', mood: 'epic, fast, climactic, last stand',
    stepsPerBeat: 4, stepsPerBar: 16, loopFrom: 1,
    channels: {
      lead: { wave: 'pulse', duty: 0.25, vol: 0.14, env: [0.003, 0.07, 0.75, 0.05], vib: [6, 18, 0.15], gate: 0.9 },
      harm: { wave: 'pulse', duty: 0.5, vol: 0.075, env: [0.003, 0.07, 0.7, 0.05], minI: 0.25, pan: -0.3 },
      arp: { wave: 'pulse', duty: 0.125, vol: 0.055, gate: 0.5, minI: 0.4, pan: 0.3 },
      pad: { wave: 'tri', vol: 0.1, env: [0.03, 0, 1, 0.1], gate: 1 },
      bass: { wave: 'pulse', duty: 0.5, vol: 0.12, lp: 800, gate: 0.65 },
      sub: { wave: 'tri', vol: 0.18, gate: 0.95 },
      drums: { drum: true, vol: 0.5, minI: 0.1 },
      hats: { drum: true, vol: 0.4, minI: 0.5 }
    },
    patterns: {
      padI: padL('C#m*4', 16), subI: comp('C#m*4', 'r:16', 2), drI: M(rep('t . . . . . u . . . t . . . u .', 3), 's s s s t t u u s s s s s s s s'),
      bassI: comp('C#m*4', 'r r q r r q r r r q r r q r f g', 2),
      leadA, leadB, harmA: harmC(leadA, pA), harmB: harmC(leadB, pB),
      padA: padL(pA, 16), padB: padL(pB, 16), subA: comp(pA, 'r:16', 2), subB: comp(pB, 'r:16', 2),
      bassA: comp(pA, 'r r q r r q r r r q r r q r f g', 2), bassB: comp(pB, 'r:2 r:2 q:2 r:2 r:2 r:2 q:2 f:2', 2),
      arpA: comp(pA, '0 1 2 3 0 1 2 3 0 1 2 3 2 1 2 3', 4), arpB: comp(pB, '0 2 1 2 3 2 1 2 0 2 1 2 3 2 4 2', 4),
      drA: fillBars(dr, fl, 8), drB: fillBars(dr2, fl, 8), hatsA: fillBars('h h h h h h h h h h h h h h h h', 'h h h h h h h h h h h h c . . .', 8)
    },
    song: [
      { bars: 4, p: { pad: 'padI', sub: 'subI', bass: 'bassI', drums: 'drI' } },
      { bars: 8, p: { lead: 'leadA', pad: 'padA', sub: 'subA', bass: 'bassA', drums: 'drA', arp: 'arpA', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadA', harm: 'harmA', pad: 'padA', sub: 'subA', bass: 'bassA', drums: 'drB', arp: 'arpA', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadB', harm: 'harmB', pad: 'padB', sub: 'subB', bass: 'bassB', drums: 'drB', arp: 'arpB', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadA', harm: 'harmA', pad: 'padA', sub: 'subA', bass: 'bassA', drums: 'drA', arp: 'arpB', hats: 'hatsA' } }
    ]
  });
}

// =====================================================================
// BONUS  STARLIGHT  G major, 144 BPM, steady 4/4, no tempo changes. Bouncy.
// Kick on every beat, snare on 2 and 4, so shots-on-beat can be scored later (see beatAt).
// =====================================================================
{
  const pA = 'G Em C D G Em Am D', pB = 'C D Bm Em C D G G';
  const leadA = M(
    'G5:2 B5:2 D6:2 B5:2 G5:2 B5:2 D6:4', 'E6:2 D6:2 B5:2 G5:2 E5:2 G5:2 B5:4', 'C6:2 E6:2 G6:2 E6:2 C6:2 E6:2 G6:4', 'F#6:2 E6:2 D6:2 A5:2 F#5:2 A5:2 D6:4',
    'G5:2 B5:2 D6:2 G6:2 F#6:2 D6:2 B5:4', 'E6:2 G6:2 B6:2 G6:2 E6:2 B5:2 G5:4', 'A5:2 C6:2 E6:2 A6:2 G6:2 E6:2 C6:4', 'D6:2 C6:2 B5:2 A5:2 F#5:2 A5:2 D6:2 .:2');
  const leadB = M(
    'E6:4 E6:2 G6:2 E6:4 C6:4', 'F#6:4 F#6:2 A6:2 F#6:4 D6:4', 'D6:4 D6:2 F#6:2 B6:4 F#6:4', 'G6:2 B6:2 G6:2 E6:2 B5:4 G5:4',
    'E6:4 E6:2 G6:2 E6:4 C6:4', 'A6:4 F#6:4 D6:4 A5:4', 'B5:2 D6:2 G6:2 B6:2 D7:4 B6:4', 'G6:4 D6:4 B5:4 G5:2 .:2');
    const dBeat = 'k . . . s . . . k . . . s . . .', dBeat2 = 'k . . . k . . . k . . . k . . .';
  add({
    id: 'bonus', name: 'Starlight', bpm: 144, key: 'G major', mood: 'bouncy, playful, steady pulse for shots-on-beat',
    stepsPerBeat: 4, stepsPerBar: 16, swing: 0.12, loopFrom: 0, beatLocked: true,
    channels: {
      lead: { wave: 'pulse', duty: 0.25, vol: 0.14, env: [0.003, 0.05, 0.6, 0.04], gate: 0.55 },
      harm: { wave: 'pulse', duty: 0.5, vol: 0.07, env: [0.003, 0.05, 0.5, 0.04], gate: 0.5, minI: 0.25, pan: -0.3 },
      arp: { wave: 'pulse', duty: 0.125, vol: 0.05, gate: 0.4, minI: 0.4, pan: 0.3 },
      pad: { wave: 'tri', vol: 0.07, env: [0.03, 0, 1, 0.1], gate: 0.5, minI: 0 },
      bass: { wave: 'tri', vol: 0.22, gate: 0.5 },
      drums: { drum: true, vol: 0.5, minI: 0 },
      hats: { drum: true, vol: 0.4, minI: 0.4 }
    },
    patterns: {
      leadA, leadB, harmA: harmC(leadA, pA), harmB: harmC(leadB, pB),
      padA: comp(pA, '.:4 x:2 .:2 .:4 x:2 .:2', 3), padB: comp(pB, '.:4 x:2 .:2 .:4 x:2 .:2', 3),
      bassA: comp(pA, 'r:2 .:2 f:2 .:2 r:2 .:2 f:2 .:2', 2), bassB: comp(pB, 'r:2 .:2 f:2 .:2 r:2 .:2 q:2 f:2', 2),
      arpA: comp(pA, '0 1 2 1 0 1 2 1 0 1 2 1 0 1 2 3', 4), arpB: comp(pB, '2 1 0 1 2 1 0 1 2 3 2 1 2 3 4 3', 4),
      drA: fillBars(dBeat, 'k . . . s . . . k . . . s . s s', 8), drB: fillBars(dBeat2, 'k . . . s . . . k . . . s s s s', 8),
      hatsA: rep('. . h . . . h . . . h . . . h o', 8)
    },
    song: [
      { bars: 8, p: { lead: 'leadA', pad: 'padA', bass: 'bassA', drums: 'drA', arp: 'arpA', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadA', harm: 'harmA', pad: 'padA', bass: 'bassA', drums: 'drA', arp: 'arpA', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadB', harm: 'harmB', pad: 'padB', bass: 'bassB', drums: 'drB', arp: 'arpB', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadA', harm: 'harmA', pad: 'padA', bass: 'bassB', drums: 'drB', arp: 'arpA', hats: 'hatsA' } }
    ]
  });
}

// =====================================================================
// ENDLESS  G minor, 150 BPM. Hypnotic, marathon, driving.
// Long form so it does not fatigue: four 8-bar movements with a different bass each time.
// =====================================================================
{
  const pA = 'Gm Eb Bb F Gm Eb Cm D', pB = 'Cm Gm Eb F Cm Gm Bb D';
  const leadA = M(
    'G5:2 Bb5:2 D6:4 C6:2 Bb5:2 G5:4', 'Eb5:2 G5:2 Bb5:4 G5:2 Bb5:2 Eb6:4', 'D6:2 F6:2 Bb6:4 A6:2 F6:2 D6:4', 'C6:2 F6:2 A6:4 G6:2 F6:2 C6:4',
    'G5:2 Bb5:2 D6:4 G6:4 F6:2 D6:2', 'Eb6:4 D6:4 Bb5:4 G5:4', 'C6:4 Eb6:4 G6:4 Eb6:4', 'D6:2 F#6:2 A6:4 F#6:2 D6:2 A5:2 F#5:2');
  const leadB = M(
    'Eb6:8 C6:4 G5:4', 'D6:8 Bb5:4 G5:4', 'Bb5:4 Eb6:4 G6:8', 'A5:4 C6:4 F6:8',
    'C6:2 Eb6:2 G6:4 Eb6:4 C6:4', 'D6:2 G6:2 Bb6:4 G6:4 D6:4', 'F6:4 D6:4 Bb5:4 F5:4', 'F#6:4 A6:4 D7:8');
  const dr = 'k . . . s . . . k . k . s . . k', dr2 = 'k . . k s . . . k . k . s . k .';
  const fl = 'k . k . s . s . t t u u s s s s';
  const hat = 'h . h . h . h . h . h . h . h .';
  add({
    id: 'endless', name: 'Endless', bpm: 150, key: 'G minor', mood: 'hypnotic, driving, marathon',
    stepsPerBeat: 4, stepsPerBar: 16, loopFrom: 1,
    channels: {
      lead: { wave: 'pulse', duty: 0.25, vol: 0.14, env: [0.004, 0.08, 0.7, 0.05], vib: [6, 14, 0.2], gate: 0.88 },
      harm: { wave: 'pulse', duty: 0.5, vol: 0.07, env: [0.004, 0.08, 0.6, 0.05], minI: 0.3, pan: -0.3 },
      counter: { wave: 'pulse', duty: 0.125, vol: 0.05, gate: 0.4, minI: 0.3, pan: 0.3 },
      arp: { wave: 'pulse', duty: 0.25, vol: 0.05, gate: 0.5, minI: 0.45, pan: 0.25 },
      pad: { wave: 'tri', vol: 0.09, env: [0.05, 0, 1, 0.12], gate: 1 },
      bass: { wave: 'tri', vol: 0.22, gate: 0.75 },
      drums: { drum: true, vol: 0.5, minI: 0.15 },
      hats: { drum: true, vol: 0.45, minI: 0.55 }
    },
    patterns: {
      padI: padL('Gm Eb Bb F', 16), bassI: comp('Gm Eb Bb F', 'r:4 r:4 r:4 f:4', 2), arpI: comp('Gm Eb Bb F', '0 1 2 3 2 1 2 1 0 1 2 3 2 1 2 1', 4), hatsI: rep(hat, 4),
      leadA, leadB, harmA: harmC(leadA, pA), harmB: harmC(leadB, pB),
      padA: padL(pA, 16), padB: padL(pB, 16),
      bassA: comp(pA, 'r:2 r:2 q:2 r:2 r:2 r:2 q:2 f:2', 2), bassB: comp(pB, 'r r q r r q r r r q r r q r f g', 2),
      bassC: comp(pA, 'r:3 .:1 r:2 q:2 r:2 f:2 r:2 q:2', 2),
      arpA: comp(pA, '0 1 2 3 2 1 2 1 0 1 2 3 2 1 2 1', 4), arpB: comp(pB, '0 2 1 3 0 2 1 3 0 2 1 3 2 1 2 1', 4),
      stabA: comp(pA, '.:2 y:2 .:2 y:2 .:2 y:2 .:2 y:2', 4), stabB: comp(pB, '.:2 y:2 .:2 y:2 .:2 y:2 .:2 y:2', 4),
      drA: fillBars(dr, fl, 8), drB: fillBars(dr2, fl, 8), hatsA: fillBars(hat, 'h h h h h h h h h h h h c . . .', 8)
    },
    song: [
      { bars: 4, p: { pad: 'padI', bass: 'bassI', arp: 'arpI', hats: 'hatsI' } },
      { bars: 8, p: { lead: 'leadA', pad: 'padA', bass: 'bassA', drums: 'drA', arp: 'arpA', counter: 'stabA', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadB', harm: 'harmB', pad: 'padB', bass: 'bassB', drums: 'drB', arp: 'arpB', counter: 'stabB', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadA', harm: 'harmA', pad: 'padA', bass: 'bassC', drums: 'drB', arp: 'arpA', counter: 'stabA', hats: 'hatsA' } },
      { bars: 8, p: { lead: 'leadB', harm: 'harmB', pad: 'padB', bass: 'bassB', drums: 'drA', arp: 'arpB', counter: 'stabB', hats: 'hatsA' } }
    ]
  });
}

// =====================================================================
// JINGLES (one-shots; loop:false)
// =====================================================================
const jingleCh = {
  lead: { wave: 'pulse', duty: 0.25, vol: 0.15, env: [0.004, 0.08, 0.7, 0.1], vib: [5.5, 14, 0.25] },
  harm: { wave: 'pulse', duty: 0.5, vol: 0.08, env: [0.004, 0.08, 0.6, 0.1], pan: -0.3 },
  pad: { wave: 'tri', vol: 0.1, env: [0.02, 0, 1, 0.2], gate: 1 },
  bass: { wave: 'tri', vol: 0.22, gate: 0.85 },
  drums: { drum: true, vol: 0.5 }
};

// stageClear: C major, 150 BPM, 4 bars. A quick fanfare up the triad and a held resolution.
{
  const p = 'C F G C';
  const lead = M('C5:2 E5:2 G5:2 C6:4 G5:2 C6:4', 'A5:2 C6:2 F6:4 E6:2 C6:2 A5:4', 'B5:2 D6:2 G6:4 F6:2 D6:2 B5:4', 'C6:2 E6:2 G6:2 C7:2 E7:8');
  add({
    id: 'stageClear', name: 'Stage Clear', bpm: 150, key: 'C major', mood: 'triumphant, quick, bright', loop: false, tail: 1.2,
    stepsPerBeat: 4, stepsPerBar: 16, channels: jingleCh,
    patterns: {
      lead, harm: harmC(lead, p), pad: padL(p, 16), bass: comp(p, 'r:4 r:4 q:4 f:4', 2),
      dr: M('k . . . s . k . k . . . s . s s', 'k . . . s . k . k . . . s . s s', 'k . . . s . k . k . . . s s s s', 'k . . . . . . . c . . . . . . .')
    },
    song: [{ bars: 4, p: { lead: 'lead', harm: 'harm', pad: 'pad', bass: 'bass', drums: 'dr' } }]
  });
}

// bossDefeat: Bb major, 120 BPM, 5 bars. Bigger and slower than stageClear, ends on a long held tonic.
{
  const p = 'Bb Gm Eb F Bb';
  const lead = M('Bb4:2 D5:2 F5:4 Bb5:4 D6:4', 'G5:2 Bb5:2 D6:4 G6:4 F6:4', 'Eb6:4 G5:4 Bb5:4 Eb6:4', 'F6:2 A5:2 C6:2 F6:2 A6:8', 'Bb6:12 .:4');
  add({
    id: 'bossDefeat', name: 'Boss Defeated', bpm: 120, key: 'Bb major', mood: 'victorious, weighty, relief', loop: false, tail: 1.6,
    stepsPerBeat: 4, stepsPerBar: 16, channels: Object.assign({}, jingleCh, { bell: { wave: 'fm', fm: [3.5, 1.2], vol: 0.09, env: [0.003, 0.2, 0.5, 0.4], gate: 1 } }),
    patterns: {
      lead, harm: harmC(lead, p), pad: padL(p, 16), bass: comp(p, 'r:4 r:4 q:4 f:4', 2),
      bell: comp(p, 'x:16', 5),
      dr: M('t . t . u . u . t . t . u . u .', 'k . . . s . k . k . . . s . s s', 'k . . . s . k . k . . . s . s s', 'k . . . s s s s t t u u s s s s', 'k . . . . . . . c . . . . . . .')
    },
    song: [{ bars: 5, p: { lead: 'lead', harm: 'harm', pad: 'pad', bass: 'bass', bell: 'bell', drums: 'dr' } }]
  });
}

// gameOver: C minor, 80 BPM, 4 bars. Slow descending lament that resolves to a quiet tonic.
{
  const p = 'Cm Ab Fm Cm';
  const lead = M('G5:6 Eb5:2 C5:8', 'Ab5:6 F5:2 C5:8', 'C6:4 Ab5:4 F5:8', 'Eb5:4 D5:4 C5:8');
  add({
    id: 'gameOver', name: 'Game Over', bpm: 80, key: 'C minor', mood: 'sad, slow, falling, resolved', loop: false, tail: 2.0,
    stepsPerBeat: 4, stepsPerBar: 16,
    channels: {
      lead: { wave: 'pulse', duty: 0.25, vol: 0.13, env: [0.01, 0.2, 0.6, 0.3], vib: [4.5, 20, 0.4] },
      harm: { wave: 'pulse', duty: 0.5, vol: 0.06, env: [0.02, 0.2, 0.6, 0.3], pan: -0.3 },
      pad: { wave: 'tri', vol: 0.1, env: [0.1, 0, 1, 0.4], gate: 1 },
      bass: { wave: 'tri', vol: 0.2, gate: 1 }
    },
    patterns: { lead, harm: harmC(lead, p), pad: padL(p, 16), bass: comp(p, 'r:16', 2) },
    song: [{ bars: 4, p: { lead: 'lead', harm: 'harm', pad: 'pad', bass: 'bass' } }]
  });
}

// extraLife: C major, 150 BPM, 2 bars. A bright rising sparkle with bell on top.
{
  const lead = M('C6:1 E6:1 G6:1 C7:1 E6:1 G6:1 C7:1 E7:1 G6:2 C7:2 E7:4', 'G7:4 E7:2 C7:2 C7:8');
  add({
    id: 'extraLife', name: 'Extra Life', bpm: 150, key: 'C major', mood: 'sparkling, rising, happy', loop: false, tail: 1.0,
    stepsPerBeat: 4, stepsPerBar: 16,
    channels: {
      lead: { wave: 'pulse', duty: 0.25, vol: 0.12, env: [0.002, 0.05, 0.7, 0.08], gate: 0.8 },
      bell: { wave: 'fm', fm: [3.5, 1.2], vol: 0.09, env: [0.002, 0.2, 0.5, 0.4], gate: 1 },
      bass: { wave: 'tri', vol: 0.2, gate: 0.9 }
    },
    patterns: { lead, bell: M('.:8 C6:8', 'E6+G6:16'), bass: M('C3:4 G3:4 C4:8', 'C3:16') },
    song: [{ bars: 2, p: { lead: 'lead', bell: 'bell', bass: 'bass' } }]
  });
}

// nameEntry: D major, 100 BPM, loops. Relaxed, proud, arcade hi-score mood.
{
  const p = 'D Bm G A D Bm G A';
  const lead = M('F#5:4 A5:4 D6:4 A5:4', 'D6:4 B5:4 F#5:4 B5:4', 'B5:4 D6:4 G6:4 D6:4', 'C#6:4 E6:4 A5:8',
    'D6:2 C#6:2 D6:4 F#6:4 A6:4', 'B6:4 A6:4 F#6:4 D6:4', 'G6:4 F#6:2 E6:2 D6:4 B5:4', 'C#6:4 E6:4 A6:8');
  const lead2 = M('A5:2 D6:2 F#6:4 D6:4 A5:4', 'B5:2 D6:2 F#6:4 D6:4 B5:4', 'G5:2 B5:2 D6:4 G6:4 D6:4', 'E6:4 C#6:4 A5:2 C#6:2 E6:4',
    'F#6:2 A6:2 D7:4 A6:4 F#6:4', 'D6:2 F#6:2 B6:4 F#6:4 D6:4', 'B5:2 D6:2 G6:4 F#6:2 E6:2 D6:4', 'C#6:2 E6:2 A6:4 E6:4 C#6:4');
  add({
    id: 'nameEntry', name: 'Name Entry', bpm: 100, key: 'D major', mood: 'relaxed, proud, hi-score glow',
    stepsPerBeat: 4, stepsPerBar: 16, swing: 0.1, loopFrom: 0,
    channels: {
      lead: { wave: 'pulse', duty: 0.25, vol: 0.13, env: [0.005, 0.1, 0.65, 0.1], vib: [5, 14, 0.3] },
      harm: { wave: 'pulse', duty: 0.5, vol: 0.06, env: [0.005, 0.1, 0.6, 0.1], pan: -0.3 },
      arp: { wave: 'pulse', duty: 0.125, vol: 0.05, gate: 0.5, pan: 0.3 },
      pad: { wave: 'tri', vol: 0.1, env: [0.05, 0, 1, 0.15], gate: 1 },
      bass: { wave: 'tri', vol: 0.2, gate: 0.8 },
      drums: { drum: true, vol: 0.35 }
    },
    patterns: {
      lead, lead2, harm: harmC(lead, p), pad: padL(p, 16), bass: comp(p, 'r:4 f:4 r:4 f:4', 2),
      arp: comp(p, '0 1 2 1 0 1 2 1 0 1 2 1 0 1 2 3', 4),
      dr: rep('k . . . . . . . s . . . . . . .', 8), drB: rep('k . . . s . . . k . . . s . h .', 8)
    },
    song: [
      { bars: 8, p: { lead: 'lead', pad: 'pad', bass: 'bass', arp: 'arp', drums: 'dr' } },
      { bars: 8, p: { lead: 'lead2', harm: 'harm', pad: 'pad', bass: 'bass', arp: 'arp', drums: 'drB' } }
    ]
  });
}

// lobby: C major, 72 BPM. Quiet arcade-floor ambience: slow pad, soft bell bleeps, no drums.
{
  const p = 'Cmaj7 Am7 Fmaj7 G Cmaj7 Em7 Am7 G';
  add({
    id: 'lobby', name: 'Arcade Floor', bpm: 72, key: 'C major', mood: 'quiet, hazy, neon hum, far-off bleeps',
    stepsPerBeat: 4, stepsPerBar: 16, echo: { beats: 1.5, fb: 0.45, mix: 0.55 }, loopFrom: 0,
    channels: {
      pad: { wave: 'tri', vol: 0.06, env: [0.5, 0, 1, 0.8], gate: 1, pan: 0.1 },
      bass: { wave: 'tri', vol: 0.1, env: [0.1, 0, 1, 0.3], gate: 1 },
      bell: { wave: 'fm', fm: [3.5, 0.9], vol: 0.045, env: [0.003, 0.3, 0.4, 0.5], gate: 1, send: 0.8, pan: -0.2 },
      blip: { wave: 'pulse', duty: 0.125, vol: 0.025, gate: 0.4, send: 0.7, pan: 0.35 }
    },
    patterns: {
      pad: padL(p + ' ' + p.split(' ').slice(0, 4).join(' '), 16), bass: comp(p + ' ' + p.split(' ').slice(0, 4).join(' '), 'r:16', 2),
      bell: M('E6:3 .:5 G6:2 .:6', '.:4 A6:3 .:3 E6:2 .:4', 'C6:3 .:5 A5:2 .:6', 'D6:2 .:6 B5:3 .:5',
        'G6:3 .:5 E6:2 .:6', '.:6 B5:3 .:3 G5:2 .:2', 'A5:2 .:6 C6:3 .:5', 'B5:6 .:4 D6:3 .:3',
        'E6:3 .:5 G6:2 .:6', 'D6:3 .:3 B5:2 .:8', 'A5:3 .:5 E6:2 .:6', 'D6:6 .:2 G5:6 .:2'),
      blip: M('.:16', '.:8 E7:1 .:7', '.:16', '.:12 C7:1 .:3', '.:16', '.:6 G6:1 .:9', '.:16', '.:10 D7:1 .:5',
        '.:16', '.:4 A6:1 .:11', '.:16', '.:14 E7:1 .:1')
    },
    song: [{ bars: 12, p: { pad: 'pad', bass: 'bass', bell: 'bell', blip: 'blip' } }]
  });
}

// Sim owns the beat at 60 fps: every tempo must be a whole number of frames per beat.
for (const t of Object.values(tracks)) {
  t.framesPerBeat = 3600 / t.bpm;
  const fpb = (t.framesPerBeat * t.stepsPerBar) / t.stepsPerBeat;
  t.framesPerBar = Number.isInteger(fpb) ? fpb : null;
  if (!Number.isInteger(t.framesPerBeat)) throw new Error(t.id + ' bpm ' + t.bpm + ' is not an integer-frame tempo');
}
export const TRACKS = tracks;
export const TRACK_IDS = Object.keys(tracks);
// Zone mapping.
export const ZONE_TRACKS = { 1: 'z1', 2: 'z2', 3: 'z3' };
export const BOSS_TRACKS = { 1: 'boss1', 2: 'boss2', 3: 'boss3' };
export const JINGLES = ['stageClear', 'bossDefeat', 'gameOver', 'extraLife'];
export const BPM = Object.fromEntries(TRACK_IDS.map((k) => [k, tracks[k].bpm]));
export const FRAMES_PER_BAR = Object.fromEntries(TRACK_IDS.map((k) => [k, tracks[k].framesPerBar]));
export const FRAMES_PER_BEAT = Object.fromEntries(TRACK_IDS.map((k) => [k, tracks[k].framesPerBeat]));

// Beat position (float) for a track after `sec` seconds of playing. Constant tempo, so this is exact.
export function beatAt(trackId, sec) { return (sec * tracks[trackId].bpm) / 60; }
// Seconds from track start to beat n.
export function timeOfBeat(trackId, n) { return (n * 60) / tracks[trackId].bpm; }
// 0 on the beat, rising to 0.5 half-way between beats; use for "how close was that shot to a beat" scoring.
export function beatDistance(trackId, sec) {
  const b = beatAt(trackId, sec), f = b - Math.floor(b);
  return Math.min(f, 1 - f);
}
