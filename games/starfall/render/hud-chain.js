// Ember Chain HUD (design.md B.4): chain count and tier under the score, a fuel bar for the chain window,
// and the scoring popups (SCATTER, INTERRUPT, CLOSE, graze sparks, chain end, clear and no-miss bonuses).
// Dots only. Reads the sim (sim.ctx fields written by sim/score.js), never writes it.
// A playfield layer (not `hud`), so it shakes with the picture; it draws above the particles.
import { CX } from '../defs.js';
import { COL } from '../sprites.js';
import { tier, CPOP_N, CP_SCATTER, CP_INTERRUPT, CP_CLOSE, CP_GRAZE, CP_CHAIN, CP_CLEAR, CP_NOMISS, CP_LEADX2 } from '../sim/score.js';

// tier colors x1..x4: ember white, amber, rose, gold
const TIER_COL = [null, [1, .92, .8], COL.amber, COL.rose, COL.gold];
const BAR_DOTS = 30, BAR_X = 8, BAR_Y = 31;
const LIFE = 60, GRAZE_LIFE = 24;

export const chainLayer = {
  id: 'chain',
  draw(R, sim, al, st) {
    const S = sim.ctx;
    if (!S || S.chain == null || st === 'results') return;
    const { text, dot, ui } = R, F = ui.F;

    // chain counter: shows from 2 kills, fades for 40 frames after the chain ends
    const n = S.chain;
    if (n >= 2) {
      const t = tier(n), c = TIER_COL[t], low = S.chainT < 20;
      const a = low ? 0.55 + 0.45 * ((F >> 2) & 1) : 1;
      text('CHAIN ' + n, BAR_X, 21, c, 1, 'l', a);
      if (t > 1) text('X' + t, BAR_X + 62, 21, c, 1, 'l', 0.75 + 0.25 * Math.sin(F * 0.25));
      // fuel bar: one dot per 1/30 of the window the last kill granted
      const fill = S.chainT / S.chainCap * BAR_DOTS;
      for (let i = 0; i < BAR_DOTS; i++) {
        const on = i < fill;
        dot(BAR_X + 1 + i * 2.2, BAR_Y, on ? 1.05 : 0.8, on ? c[0] : .3, on ? c[1] : .25, on ? c[2] : .3, on ? a : .45);
      }
    } else {
      const age = S.frame - S.chainEndF;
      if (S.chainLast >= 2 && age >= 0 && age < 40) text('CHAIN ' + S.chainLast, BAR_X, 21, COL.dim, 1, 'l', 1 - age / 40);
    }

    // popups
    const P = S.cpop;
    for (let i = 0; i < CPOP_N; i++) {
      const k = P.k[i]; if (!k) continue;
      const age = S.frame - P.f[i];
      if (age < 0 || age >= LIFE) continue;
      const a = age < 40 ? 1 : 1 - (age - 40) / 20, x = P.x[i], y = P.y[i] - age * 0.25;
      switch (k) {
        case CP_SCATTER: text('SCATTER', x, y, COL.gold, 1, 'c', a); break;
        case CP_LEADX2: if (age < 30) text('X2', x, y, COL.gold, 1, 'c', 1 - age / 30); break;
        case CP_INTERRUPT: text('INTERRUPT', x, y, COL.gold, 1, 'c', a); break;
        case CP_CLOSE: text('CLOSE', x, y, COL.rose, 1, 'c', a); break;
        case CP_GRAZE: {
          // cyan sparks on the ship's side facing the bullet, so a graze reads as safe (B.9 rule 7)
          if (age >= GRAZE_LIFE) break;
          const ga = 1 - age / GRAZE_LIFE, q0 = Math.atan2(P.w[i], P.v[i]), px = P.x[i], py = P.y[i];
          for (let j = 0; j < 7; j++) {
            const q = q0 + (j - 3) * 0.22, r = 8 + age * 0.25;
            dot(px + Math.cos(q) * r, py + Math.sin(q) * r, 1.2, COL.teal[0], COL.teal[1], COL.teal[2], ga);
          }
          if (age < 6) dot(px + Math.cos(q0) * 7, py + Math.sin(q0) * 7, 1.8, 1, 1, 1, 1 - age / 6);
          break;
        }
        case CP_CHAIN: {
          // the banked chain end bonus, under the chain counter (the counter itself fades out above it)
          const c = TIER_COL[tier(P.w[i])], blink = age < 24 && ((F >> 2) & 1) ? 0.6 : 1;
          text('CHAIN BONUS +' + P.v[i], BAR_X, 36, c, 1, 'l', a * blink);
          if (S.chain < 2) for (let j = 0; j < BAR_DOTS; j++) dot(BAR_X + 1 + j * 2.2, BAR_Y, 1.05, c[0], c[1], c[2], a * (0.4 + 0.6 * ((j + (age >> 1)) % 6 < 3 ? 1 : 0)));
          break;
        }
        case CP_CLEAR: text('NO MISS  ACC ' + P.w[i] + '%  +' + P.v[i], CX, 196, COL.teal, 1, 'c', a); break;
        case CP_NOMISS: text('ZONE NO MISS +' + P.v[i], CX, 206, COL.gold, 1, 'c', a); break;
      }
    }
  }
};
