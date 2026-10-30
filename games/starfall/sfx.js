// Starfall sound effects. Each entry is fn(h, o): h.tone(spec, at) / h.noise(spec, at), o = caller options
// (pitch multiplier, vol multiplier, plus per-effect options: kind, chain). Voice spec keys are documented in engine/audio.js.
// Matches and extends the v1 palette in starfall.html.

// Pentatonic ladder used by chainTick so a long chain climbs a musical scale.
const LADDER = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.51, 1567.98, 1760.0, 2093.0];

const KILLS = {
  // moth: a soft papery pop, quick
  moth(h) {
    h.noise({ f: 3400, f2: 360, dur: 0.17, vol: 0.2, r: 0.04 });
    h.tone({ w: 'tri', f: 260, f2: 70, dur: 0.11, vol: 0.2, r: 0.03 });
    h.tone({ w: 'pulse', duty: 0.25, f: 1320, f2: 880, dur: 0.05, vol: 0.05 }, 0.01);
  },
  // wisp: airy, glassy upward flick then fade
  wisp(h) {
    h.tone({ w: 'sine', f: 500, f2: 1700, dur: 0.14, vol: 0.14, r: 0.06 });
    h.tone({ w: 'fm', f: 1320, fm: [2.5, 1.6], dur: 0.22, vol: 0.1, r: 0.12 }, 0.05);
    h.noise({ f: 5200, f2: 1200, ft: 'bandpass', q: 1.5, dur: 0.16, vol: 0.12 });
  },
  // warden: heavy armour crunch with a metallic ring
  warden(h) {
    h.noise({ f: 2200, f2: 90, dur: 0.42, vol: 0.3, r: 0.1 });
    h.tone({ w: 'saw', f: 170, f2: 45, dur: 0.38, vol: 0.14, lp: 1400, r: 0.08 });
    h.tone({ w: 'fm', f: 740, fm: [3.7, 3], dur: 0.35, vol: 0.09, r: 0.2 }, 0.02);
  },
  // splitter: a double pop, one low one high, as it cracks in two
  splitter(h) {
    h.noise({ f: 3000, f2: 300, dur: 0.12, vol: 0.18 });
    h.tone({ w: 'pulse', duty: 0.25, f: 420, f2: 160, dur: 0.1, vol: 0.12 });
    h.tone({ w: 'pulse', duty: 0.25, f: 700, f2: 260, dur: 0.1, vol: 0.1 }, 0.07);
    h.noise({ f: 3600, f2: 500, dur: 0.1, vol: 0.12 }, 0.07);
  },
  // spark: electric zap, rapid stepped square
  spark(h) {
    const f = [2400, 1800, 2900, 1500, 2200, 900];
    f.forEach((x, i) => h.tone({ w: 'square', f: x, dur: 0.028, vol: 0.07, r: 0.006 }, i * 0.026));
    h.noise({ f: 6500, f2: 1500, ft: 'highpass', dur: 0.18, vol: 0.1 });
  }
};

export const SFX = {
  shot(h) { h.tone({ w: 'pulse', duty: 0.125, f: 1300, f2: 520, dur: 0.06, vol: 0.05, r: 0.01 }); },
  hit(h) { h.tone({ w: 'square', f: 700, f2: 1000, dur: 0.05, vol: 0.08, r: 0.01 }); },
  kill(h, o) { (KILLS[o.kind] || KILLS.moth)(h); },
  bossHit(h) {
    h.tone({ w: 'square', f: 360, f2: 220, dur: 0.07, vol: 0.1, r: 0.02 });
    h.noise({ f: 1800, f2: 400, dur: 0.07, vol: 0.12 });
  },
  panelBreak(h) {
    h.noise({ f: 5000, f2: 500, dur: 0.3, vol: 0.28, r: 0.06 });
    h.tone({ w: 'tri', f: 200, f2: 60, dur: 0.25, vol: 0.2 });
    [2600, 3400, 2000, 3900].forEach((f, i) => h.tone({ w: 'fm', f, fm: [3.1, 2], dur: 0.12, vol: 0.05, r: 0.08 }, 0.03 + i * 0.045));
  },
  bossDie(h) {
    h.noise({ f: 2400, f2: 60, dur: 1.6, vol: 0.4, r: 0.2, a: 0.01 });
    h.tone({ w: 'saw', f: 140, f2: 28, dur: 1.5, vol: 0.14, lp: 900, r: 0.2 });
    for (let i = 0; i < 6; i++) h.noise({ f: 3000 - i * 300, f2: 200, dur: 0.14, vol: 0.2 }, 0.18 * i);
    h.tone({ w: 'sine', f: 70, f2: 30, dur: 1.2, vol: 0.4 }, 0.05);
    [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => h.tone({ w: 'fm', f, fm: [2, 1.5], dur: 0.35, vol: 0.06, r: 0.3 }, 1.0 + i * 0.07));
  },
  playerDie(h) {
    h.noise({ f: 1600, f2: 60, dur: 1.1, vol: 0.38, r: 0.2 });
    h.tone({ w: 'saw', f: 440, f2: 50, dur: 1.0, vol: 0.1, lp: 1800, r: 0.1 });
    h.tone({ w: 'sine', f: 120, f2: 36, dur: 0.8, vol: 0.3 });
  },
  kindle(h) { [523, 659, 784, 1047, 1319].forEach((f, i) => h.tone({ w: 'tri', f, dur: 0.18, vol: 0.14, r: 0.08 }, i * 0.05)); },
  wingLost(h) {
    h.tone({ w: 'tri', f: 520, f2: 130, dur: 0.35, vol: 0.2, r: 0.05 });
    h.noise({ f: 2000, f2: 200, dur: 0.2, vol: 0.18 });
  },
  powerup(h) {
    [392, 523, 659, 784, 1047].forEach((f, i) => h.tone({ w: 'pulse', duty: 0.25, f, dur: 0.07, vol: 0.09, r: 0.03 }, i * 0.055));
    h.tone({ w: 'fm', f: 1568, fm: [2, 1.2], dur: 0.35, vol: 0.07, r: 0.25 }, 0.3);
  },
  powerdown(h) {
    [784, 622, 466, 349, 262].forEach((f, i) => h.tone({ w: 'pulse', duty: 0.5, f, dur: 0.07, vol: 0.08, r: 0.03 }, i * 0.06));
    h.tone({ w: 'saw', f: 220, f2: 80, dur: 0.3, vol: 0.06, lp: 900 }, 0.1);
  },
  // o.chain = 1.. (chain length); pitch climbs a pentatonic ladder
  chainTick(h, o) {
    const n = Math.max(0, Math.min(LADDER.length - 1, ((o.chain || 1) - 1)));
    const f = LADDER[n];
    h.tone({ w: 'pulse', duty: 0.25, f, dur: 0.07, vol: 0.09, r: 0.03 });
    h.tone({ w: 'sine', f: f * 2, dur: 0.1, vol: 0.04, r: 0.05 }, 0.01);
  },
  chainBreak(h) {
    h.tone({ w: 'saw', f: 600, f2: 150, dur: 0.22, vol: 0.09, lp: 1500, r: 0.04 });
    h.tone({ w: 'square', f: 220, f2: 110, dur: 0.18, vol: 0.06 }, 0.05);
  },
  comet(h) {
    h.tone({ w: 'saw', f: 90, f2: 1800, dur: 0.9, vol: 0.06, lp: 2400, a: 0.3, r: 0.05 });
    h.noise({ f: 300, f2: 5200, ft: 'bandpass', q: 0.9, dur: 0.9, vol: 0.12, a: 0.3 });
  },
  extraLife(h) { [880, 1175, 1568, 2093, 1568, 2093].forEach((f, i) => h.tone({ w: 'sine', f, dur: i > 3 ? 0.4 : 0.22, vol: 0.12, r: 0.1 }, i * 0.09)); },
  coin(h) {
    h.tone({ w: 'pulse', duty: 0.25, f: 988, dur: 0.06, vol: 0.09, r: 0.01 });
    h.tone({ w: 'pulse', duty: 0.25, f: 1319, dur: 0.22, vol: 0.09, d: 0.2, s: 0.2, r: 0.1 }, 0.06);
  },
  // arcade coin drop: v1 "clunk" (thunk, ring, rattle, two-note confirm)
  clunk(h) {
    h.noise({ f: 1100, f2: 120, dur: 0.14, vol: 0.4 });
    h.tone({ w: 'sine', f: 95, f2: 42, dur: 0.22, vol: 0.3 });
    h.tone({ w: 'tri', f: 2150, dur: 0.3, vol: 0.035 }, 0.015);
    h.tone({ w: 'sine', f: 3300, dur: 0.18, vol: 0.02 }, 0.02);
    h.noise({ f: 2500, f2: 800, dur: 0.04, vol: 0.12 }, 0.09);
    h.noise({ f: 2500, f2: 800, dur: 0.03, vol: 0.08 }, 0.15);
    h.tone({ w: 'square', f: 880, dur: 0.07, vol: 0.035 }, 0.32);
    h.tone({ w: 'square', f: 1320, dur: 0.12, vol: 0.035 }, 0.39);
  },
  menuMove(h) { h.tone({ w: 'square', f: 990, dur: 0.045, vol: 0.05, r: 0.01 }); },
  menuSelect(h) {
    h.tone({ w: 'square', f: 660, dur: 0.07, vol: 0.06 });
    h.tone({ w: 'square', f: 1320, dur: 0.12, vol: 0.06, r: 0.05 }, 0.06);
  },
  // quiet footstep tick in the arcade lobby; o.alt flips the pitch for alternating feet
  lobbyStep(h, o) {
    h.noise({ f: o.alt ? 900 : 750, f2: 180, dur: 0.05, vol: 0.12, r: 0.02 });
    h.tone({ w: 'tri', f: o.alt ? 130 : 112, f2: 70, dur: 0.05, vol: 0.08 });
  },
  grazeTick(h) { h.tone({ w: 'pulse', duty: 0.125, f: 3000, f2: 3600, dur: 0.025, vol: 0.05, r: 0.008 }); },
  // v1 extras kept so integration can swap them in
  warp(h) {
    h.tone({ w: 'saw', f: 70, f2: 1800, dur: 0.9, vol: 0.07, lp: 2600, a: 0.1, r: 0.05 });
    h.noise({ f: 300, f2: 5000, dur: 0.9, vol: 0.14 });
  },
  phase2(h) {
    h.tone({ w: 'saw', f: 60, f2: 240, dur: 1.0, vol: 0.1, lp: 1200, a: 0.05, r: 0.1 });
    h.noise({ f: 400, f2: 3000, dur: 0.8, vol: 0.16 });
  },
  morph(h) { h.tone({ w: 'sine', f: 300, f2: 1400, dur: 0.3, vol: 0.12 }); },
  deflect(h) { h.tone({ w: 'square', f: 1900, dur: 0.03, vol: 0.04 }); },
  // C.2 (B.11): short cues under the existing levels
  // cut: a clean downward slice, a bright blade-ring on top
  cut(h) {
    h.noise({ f: 6000, f2: 1400, ft: 'highpass', dur: 0.1, vol: 0.12, r: 0.03 });
    h.tone({ w: 'saw', f: 1500, f2: 400, dur: 0.1, vol: 0.06, lp: 3000, r: 0.03 });
    h.tone({ w: 'sine', f: 1960, dur: 0.14, vol: 0.04, r: 0.08 }, 0.03);
  },
  // hunt: a low two-pulse sonar ping that warns a hunter has locked on
  hunt(h) {
    h.tone({ w: 'tri', f: 196, f2: 160, dur: 0.12, vol: 0.05, r: 0.05 });
    h.tone({ w: 'tri', f: 247, f2: 200, dur: 0.14, vol: 0.05, r: 0.07 }, 0.14);
    h.tone({ w: 'sine', f: 98, dur: 0.26, vol: 0.045, r: 0.1 });
  },
  // snap: a taut line parting, a quick high twang and a dry crack
  snap(h) {
    h.noise({ f: 4200, f2: 900, dur: 0.06, vol: 0.14, r: 0.02 });
    h.tone({ w: 'square', f: 1800, f2: 700, dur: 0.07, vol: 0.06, r: 0.02 });
    h.tone({ w: 'tri', f: 880, f2: 330, dur: 0.16, vol: 0.08, r: 0.08 }, 0.02);
  },
  toss(h) { h.tone({ w: 'tri', f: 2400, f2: 3200, dur: 0.05, vol: 0.06 }); }
};

export const SFX_NAMES = Object.keys(SFX);
export const KILL_KINDS = Object.keys(KILLS);
