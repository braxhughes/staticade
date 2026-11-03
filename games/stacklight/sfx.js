// STACKLIGHT sound effects (design B.11). Each entry is fn(h, o): h.tone(spec, at) / h.noise(spec, at), o = the options the
// bind passes (rows, fall, g). Voice spec keys are documented in engine/audio.js. All in D minor so they sit with the music.
//
//   move       short soft tick
//   turnBar    rising two-note chime (BAR turned)
//   turnPlus   quiet shimmer (PLUS cannot turn: it says "nothing happened" without being a dead button)
//   lockFit    bright bell (FLAT);  lockKey = the same bell with a fifth above (KEY)
//   lockSoft   a plain soft thud: a lock that melts nothing and is no fit (an upright BAR). Not in the B.11 table:
//              added so that every lock is heard (a silent lock reads as a dead key)
//   melt       a falling glissando, longer the further the cells fell (o.fall rows)
//   clear      one row: one tone; two: a fifth; three: the full triad; brighter each (o.rows)
//   glowStep   a rising shimmer a scale step higher for each GLOW step (o.g, 1 to 4); the held pad chord moves with it (music.js)
//   levelUp    short arpeggio
//   topOut     a slow falling sweep, then silence

// D minor ladder for glowStep: D5 E5 F5 G5 A5
const LADDER = [587.33, 659.25, 698.46, 783.99, 880.0];

export const SFX = {
  move(h) { h.tone({ w: 'tri', f: 640, f2: 540, dur: 0.018, vol: 0.05, r: 0.012 }); },

  turnBar(h) {
    h.tone({ w: 'fm', f: 659.25, fm: [3, 1.2], dur: 0.06, vol: 0.09, r: 0.06 });
    h.tone({ w: 'fm', f: 880, fm: [3, 1.2], dur: 0.09, vol: 0.09, r: 0.1 }, 0.065);
  },
  turnPlus(h) {
    h.tone({ w: 'sine', f: 1760, dur: 0.12, vol: 0.028, r: 0.08, vib: [9, 30, 0] });
    h.tone({ w: 'sine', f: 2349, dur: 0.1, vol: 0.018, r: 0.08 }, 0.035);
  },

  lockFit(h, o) {
    h.tone({ w: 'fm', f: 880, fm: [3.5, 1.6], dur: 0.16, vol: 0.13, r: 0.22 });
    h.tone({ w: 'sine', f: 1760, dur: 0.1, vol: 0.04, r: 0.12 });
    if (o.key) h.tone({ w: 'fm', f: 1318.5, fm: [3.5, 1.4], dur: 0.16, vol: 0.1, r: 0.22 }, 0.015); // the fifth above (E6 over A5)
  },
  lockKey(h) { SFX.lockFit(h, { key: 1 }); },
  lockSoft(h) {
    h.tone({ w: 'tri', f: 190, f2: 120, dur: 0.05, vol: 0.08, r: 0.03 });
    h.noise({ f: 900, f2: 300, dur: 0.04, vol: 0.05 });
  },

  melt(h, o) {
    const fall = o.fall > 0 ? (o.fall > 16 ? 16 : o.fall) : 1;
    const d = 0.14 + 0.055 * fall; // one row 0.2 s, a long fall 1 s
    h.tone({ w: 'sine', f: 1500, f2: 260, sl: d, dur: d, vol: 0.12, r: 0.06 });
    h.tone({ w: 'tri', f: 750, f2: 130, sl: d, dur: d, vol: 0.06, r: 0.06 });
  },

  clear(h, o) {
    const rows = o.rows;
    if (rows === 1) {
      h.tone({ w: 'tri', f: 587.33, dur: 0.26, vol: 0.14, r: 0.18 });
    } else if (rows === 2) {
      h.tone({ w: 'pulse', duty: 0.25, f: 587.33, lp: 3200, dur: 0.3, vol: 0.1, r: 0.2 });
      h.tone({ w: 'pulse', duty: 0.25, f: 880, lp: 3200, dur: 0.3, vol: 0.09, r: 0.2 }, 0.04); // the fifth
    } else {
      h.tone({ w: 'fm', f: 587.33, fm: [2, 1.4], dur: 0.4, vol: 0.09, r: 0.3 });
      h.tone({ w: 'fm', f: 698.46, fm: [2, 1.4], dur: 0.4, vol: 0.08, r: 0.3 }, 0.04);
      h.tone({ w: 'fm', f: 880, fm: [2, 1.4], dur: 0.42, vol: 0.08, r: 0.3 }, 0.08); // the full triad
      h.noise({ f: 6000, ft: 'highpass', dur: 0.3, vol: 0.05, r: 0.2 }, 0.04);
    }
  },

  glowStep(h, o) {
    const i = o.g < 1 ? 1 : o.g > 4 ? 4 : o.g;
    h.tone({ w: 'fm', f: LADDER[i] * 2, fm: [2.5, 1.0], dur: 0.2, vol: 0.06, r: 0.25, vib: [7, 20, 0] }, 0.1);
    h.tone({ w: 'sine', f: LADDER[i - 1] * 2, f2: LADDER[i] * 2, sl: 0.1, dur: 0.1, vol: 0.05, r: 0.1 }, 0.06);
  },

  levelUp(h) {
    [587.33, 698.46, 880, 1174.66].forEach((f, i) => h.tone({ w: 'pulse', duty: 0.25, f, dur: 0.07, vol: 0.09, r: 0.08 }, 0.16 + i * 0.075));
  },

  topOut(h) {
    h.tone({ w: 'saw', f: 660, f2: 55, sl: 2.2, dur: 2.2, vol: 0.12, lp: 1400, r: 0.3 });
    h.tone({ w: 'sine', f: 330, f2: 27.5, sl: 2.2, dur: 2.2, vol: 0.14, r: 0.3 });
    h.noise({ f: 1200, f2: 60, sl: 2, dur: 2, vol: 0.05, r: 0.3 });
  }
};

// the names the bind plays, in the order of its tap counters
export const SFX_LIST = ['move', 'turnBar', 'turnPlus', 'lockFit', 'lockKey', 'lockSoft', 'melt', 'clear', 'glowStep', 'levelUp', 'topOut'];
