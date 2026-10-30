// STARLIGHT drawing (design.md B.4): the stage card, the phrase hues, the beat pulse and the tally. Draws only on bonus
// stages. It is the last playfield layer (not a hud layer), so its marks sit above everything in the field;
// STARLIGHT has no shake. Every pulse comes from the sim beat (sim.ctx.sl, stage frame = stageT - 1), never from audio.
// The grade and finale popups are fx.js popups (POP_PHRASE, POP_FINALE).
import { CX, TAU } from '../defs.js';
import { COL } from '../sprites.js';
import { BEAT_FRAMES, PHRASES, GR_COMPLETE, GR_TUNE, GR_DONE, FIN_OVATION, FIN_ENCORE } from '../sim/starlight.js';

// the two alternating phrase hues (sim/starlight.js PHRASE_C: teal, rose)
const HUE = [COL.teal, COL.rose];

export const starlightLayer = {
  id: 'starlight',
  draw(R, sim, al, st) {
    if (sim.stageKind !== 'bonus' || R.ui.paused) return;
    const text = R.text, dot = R.dot, t = sim.stateT, L = sim.ctx.sl;
    if (st === 'intro') {
      const a = Math.min(1, t / 15);
      text('STARLIGHT STAGE', CX, 140, COL.teal, 1.4, 'c', a, 1.5); text('SHOOT ON THE BEAT', CX, 160, COL.white, 1, 'c', a);
    }
    // the sim beat: frames since the last beat (0 on the beat); no pulse before beat 0
    const f = sim.stageT - 1, d = f >= 0 ? f % BEAT_FRAMES : BEAT_FRAMES, pulse = Math.exp(-d * 0.16);
    if (st === 'play' || st === 'dying' || st === 'ready') {
      // phrase hues: a ring of 10 dots around each flying enemy, in its phrase's hue, brighter on the beat
      for (let i = 0; i < L.n; i++) {
        const e = L.ord[i];
        if (!e || e.dead || e.st === 'wait') continue;
        const c = HUE[((i / L.size) | 0) & 1], x = e.px + (e.x - e.px) * al, y = e.py + (e.y - e.py) * al, r = 9 + pulse * 2;
        for (let k = 0; k < 10; k++) { const q = k / 10 * TAU; dot(x + Math.cos(q) * r, y + Math.sin(q) * r, 1.5, c[0], c[1], c[2], 0.55 + 0.45 * pulse); }
      }
    }
    if (st !== 'intro') phraseBar(R, L, pulse);
    if (st === 'bonusEnd') {
      let comp = 0, tune = 0;
      for (let p = 0; p < PHRASES; p++) { if (L.grade[p] & GR_COMPLETE) comp++; if (L.grade[p] & GR_TUNE) tune++; }
      text('NOTES HIT', CX, 112, COL.teal, 1, 'c');
      text(sim.bonusHits + ' / ' + sim.bonusTotal, CX, 124, COL.white, 2, 'c');
      text('COMPLETE ' + comp + ' / 6   IN TUNE ' + tune + ' / 6', CX, 146, COL.white, 1, 'c');
      if (t > 70) {
        if (L.finale === FIN_OVATION) text('STANDING OVATION', CX, 170, COL.gold, 1.6, 'c', 1, 2);
        else if (L.finale === FIN_ENCORE) text('ENCORE', CX, 170, COL.gold, 2, 'c', 1, 2);
        else text('NO FINALE', CX, 170, COL.dim, 1, 'c');
      }
    }
  }
};

// the beat pulse on the HUD: six phrase pips under the best score. The current phrase pulses in its hue on every sim beat;
// a graded phrase shows its grade (gold In Tune, white Complete, dim missed); later phrases are dim. Two side lights
// flash on each beat.
function phraseBar(R, L, pulse) {
  const dot = R.dot, y = 27;
  for (let p = 0; p < PHRASES; p++) {
    const x = CX - 35 + p * 14, g = L.grade[p];
    let c = COL.dim, s = 2, a = 0.6;
    if (g & GR_DONE) { c = g & GR_TUNE ? COL.gold : g & GR_COMPLETE ? COL.white : COL.dim; s = 2.6; a = g & GR_COMPLETE ? 1 : 0.45; }
    else if (p === L.phrase) { c = HUE[p & 1]; s = 2.4 + pulse * 1.8; a = 0.65 + 0.35 * pulse; }
    dot(x, y, s, c[0], c[1], c[2], a);
  }
  if (L.beat < 0) return;
  const c = HUE[L.phrase & 1];
  for (let sx = -1; sx <= 1; sx += 2) for (let k = 0; k < 3; k++) dot(CX + sx * (50 + k * 5), y, 1.6 + pulse * 1.2, c[0], c[1], c[2], (0.2 + 0.8 * pulse) * (1 - k * 0.25));
}
