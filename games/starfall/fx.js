// Cosmetic effects: particles, star field, score popups, the kindle pulse and screen shake.
// Driven by sim events; uses unseeded Math.random, and never touches sim state.
import { W, H, TAU, EV_SHAKE, EV_POPUP, EV_EXPLODE, EV_FX, EV_PULSE,
  POP_NUM, POP_1UP, POP_KINDLE_READY, POP_LANTERN, POP_KINDLED, POP_CLEAR, POP_DEEPSKY, POP_PHASE2, POP_CORE, POP_PASSES, POP_FADED, POP_CUT, POP_PHRASE, POP_FINALE, BOSS_NAMES,
  FX_SPLIT, FX_DEATH, FX_KINDLE, FX_SPARK, FX_COMET_TRAIL, FX_COMET_HIT, FX_BOSS_DOTS, FX_CORE, FX_DEFLECT, FX_TETHER } from './defs.js';
import { COLS, COL, STAR_COLS, spriteOf, paletteOf, artOfTi, B_HULL, B_CORE, B_PANEL } from './sprites.js';

const rnd = Math.random;

export function createFx(dot) {
  const NP = 9000, ptX = new Float32Array(NP), ptY = new Float32Array(NP), ptPX = new Float32Array(NP), ptPY = new Float32Array(NP),
    ptVX = new Float32Array(NP), ptVY = new Float32Array(NP), ptL = new Float32Array(NP), ptM = new Float32Array(NP),
    ptR = new Float32Array(NP), ptG = new Float32Array(NP), ptB = new Float32Array(NP), ptS = new Float32Array(NP),
    ptGr = new Float32Array(NP), ptMode = new Uint8Array(NP);
  let ptHead = 0;
  function emit(x, y, vx, vy, life, r, g, b, s, mode, gr) {
    const i = ptHead; ptHead = (ptHead + 1) % NP;
    ptX[i] = ptPX[i] = x; ptY[i] = ptPY[i] = y; ptVX[i] = vx; ptVY[i] = vy; ptL[i] = ptM[i] = life;
    ptR[i] = r; ptG[i] = g; ptB[i] = b; ptS[i] = s; ptMode[i] = mode; ptGr[i] = gr || 0;
  }
  const NPOP = 24, pops = []; for (let i = 0; i < NPOP; i++) pops.push({ on: false, x: 0, y: 0, t: 0, s: '', c: null });
  function popup(x, y, s, c) {
    for (let i = 0; i < NPOP; i++) { const p = pops[i]; if (!p.on) { p.on = true; p.x = x; p.y = y; p.t = 0; p.s = s; p.c = c || COL.white; return; } }
  }
  const pulse = { on: false, x: 0, y: 0, r: 0 };
  let shake = 0;

  const NS = 150, stX = new Float32Array(NS), stY = new Float32Array(NS), stV = new Float32Array(NS), stC = new Uint8Array(NS), stPh = new Float32Array(NS);
  for (let i = 0; i < NS; i++) { stX[i] = rnd() * W; stY[i] = rnd() * H; stV[i] = 0.25 + (i % 3) * 0.25; stC[i] = i % STAR_COLS.length; stPh[i] = rnd() * TAU; }

  function explodeSprite(S, x, y, ang, pal, sc, vx, vy, power) {
    const c = Math.cos(ang) * sc, s = Math.sin(ang) * sc, d = S.d;
    power = power || 1;
    for (let i = 0; i < d.length; i += 3) {
      const col = pal[d[i + 2]]; if (!col) continue;
      const ox = d[i] * c - d[i + 1] * s, oy = d[i] * s + d[i + 1] * c, len = Math.hypot(ox, oy) + 0.6, sp = (0.5 + rnd() * 1.7) * power;
      emit(x + ox, y + oy, ox / len * sp + vx * 0.3 + (rnd() - .5) * .6, oy / len * sp + vy * 0.3 + (rnd() - .5) * .6, 28 + rnd() * 26, col[0], col[1], col[2], 1.1, 2, 0.008);
    }
    for (let i = 0; i < 14 * power; i++) { const a = rnd() * TAU, sp = 1 + rnd() * 2.5; emit(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 16 + rnd() * 16, 1, 1, 1, 0.9, 1, 0); }
  }
  function bossHitDots(list, cx, cy, rotOff, k, burst) {
    for (let i = 0; i < list.length; i += 2) {
      const r = list[i], a = list[i + 1] + rotOff, x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      const vx = Math.cos(a) * (0.5 + rnd() * burst), vy = Math.sin(a) * (0.5 + rnd() * burst);
      const teal = ((r - 29) / 2.5 | 0) % 2 === 0;
      if (k === 0) emit(x, y, vx, vy, 50 + rnd() * 60, .5, .35, .9, 1, 2, 0.03);
      else if (k === 1) emit(x, y, vx * 1.5, vy * 1.5, 50 + rnd() * 70, 1, .85, .4, 1.2, 1, 0.03);
      else emit(x, y, vx, vy, 40 + rnd() * 50, teal ? .2 : 1, teal ? .95 : .3, teal ? .9 : .75, 1, 2, 0.03);
    }
  }
  function popText(kind, v) {
    switch (kind) {
      case POP_NUM: return String(v);
      case POP_1UP: return 'EXTRA LIFE';
      case POP_KINDLE_READY: return 'KINDLE READY';
      case POP_LANTERN: return 'LANTERN -' + v;
      case POP_KINDLED: return 'KINDLED!';
      case POP_CLEAR: return 'CLEAR +' + v;
      case POP_DEEPSKY: return 'DEEP SKY X' + v;
      case POP_PHASE2: return 'PHASE 2';
      case POP_CORE: return 'CORE EXPOSED';
      case POP_FADED: return 'FADED';
      case POP_CUT: return 'CUT';
      case POP_PASSES: return (BOSS_NAMES[v] || 'IT') + ' PASSES';
      // S10 STARLIGHT: phrase grade and finale (sim/starlight.js packs the points and the grade into v)
      case POP_PHRASE: return ((v & 2) ? 'IN TUNE' : 'COMPLETE') + ((v & 4) ? ' IN ORDER' : '') + ' +' + Math.floor(v / 8);
      case POP_FINALE: return ((v & 1) ? 'STANDING OVATION' : 'ENCORE') + ' +' + Math.floor(v / 2);
    }
    return '';
  }

  // one sim event (b[o] is the type); returns true if it was ours
  function handle(b, o) {
    switch (b[o]) {
      case EV_SHAKE: shake = b[o + 2] ? b[o + 1] : Math.max(shake, b[o + 1]); return true;
      case EV_PULSE: pulse.on = true; pulse.x = b[o + 1]; pulse.y = b[o + 2]; pulse.r = 4; return true;
      case EV_POPUP: popup(b[o + 2], b[o + 3], popText(b[o + 1], b[o + 4]), COLS[b[o + 5]]); return true;
      case EV_EXPLODE: {
        const ti = b[o + 1];
        explodeSprite(spriteOf(ti, b[o + 2]), b[o + 4], b[o + 5], b[o + 6], paletteOf(ti, b[o + 3]), 1, b[o + 7], b[o + 8], b[o + 9]);
        return true;
      }
      case EV_FX: burst(b, o); return true;
    }
    return false;
  }
  function burst(b, o) {
    const x = b[o + 2], y = b[o + 3];
    switch (b[o + 1]) {
      case FX_SPLIT: for (let i = 0; i < 24; i++) { const a = rnd() * TAU; emit(x, y, Math.cos(a) * 1.4, Math.sin(a) * 1.4, 20, .6, 1, .7, .9, 0); } break;
      case FX_DEATH: for (let i = 0; i < 80; i++) { const a = rnd() * TAU, sp = rnd() * 3.2; emit(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 40 + rnd() * 40, 1, 1, 1, 1.2, 1, 0.01); } break;
      case FX_KINDLE: {
        // the kindled diver's dots stream toward the ship
        const S = artOfTi(b[o + 2]).A, bx = b[o + 3], by = b[o + 4], ang = b[o + 5], px = b[o + 6], py = b[o + 7], c = Math.cos(ang), s = Math.sin(ang);
        for (let i = 0; i < S.d.length; i += 3) {
          const ox = S.d[i] * c - S.d[i + 1] * s, oy = S.d[i] * s + S.d[i + 1] * c;
          emit(bx + ox, by + oy, (px - bx) * 0.025, (py - by) * 0.025, 40, 1, .7, .25, 1, 0);
        }
        break;
      }
      case FX_SPARK: emit(x, y, 0, -0.5, 20, 1, .7, .3, 1.2, 0); break;
      case FX_COMET_TRAIL: { const vx = b[o + 4]; emit(x, y + (rnd() - .5) * 2, -vx * 0.3 + (rnd() - .5) * .2, (rnd() - .5) * .2, 30, .5, .9, 1, 1, 0); break; }
      case FX_COMET_HIT: for (let k = 0; k < 60; k++) { const a = rnd() * TAU, s = rnd() * 3; emit(x, y, Math.cos(a) * s, Math.sin(a) * s, 50, .5, .9, 1, 1.1, 0); } break;
      case FX_BOSS_DOTS: {
        const list = b[o + 2], rotOff = b[o + 3], bur = b[o + 4], cx = b[o + 5], cy = b[o + 6];
        bossHitDots(list === 0 ? B_HULL : list === 1 ? B_CORE : B_PANEL[list - 2], cx, cy, rotOff, list > 1 ? 2 : list, bur);
        break;
      }
      case FX_CORE: for (let i = 0; i < 6; i++) emit(x, y, (rnd() - .5) * 2, rnd() * 1.5, 16, 1, .5, .3, 1, 1); break;
      // Tetherling line snap: 10 teal-white dots fly out evenly around the break point (fixed angles, tiny jitter)
      case FX_TETHER: for (let i = 0; i < 10; i++) { const a = i / 10 * TAU + rnd() * 0.3, sp = 0.9 + rnd() * 1.1; emit(x, y, Math.cos(a) * sp, Math.sin(a) * sp, 18 + rnd() * 8, .6, 1, .95, 1.4, 0); } break;
      case FX_DEFLECT: for (let i = 0; i < 4; i++) emit(x, y, (rnd() - .5) * 1.6, rnd() * 1.2, 12, .7, .6, 1, .8, 0); break;
    }
  }

  return {
    emit, popup, handle, pulse, pops,
    get shake() { return shake; },
    savePrev() { for (let i = 0; i < NP; i++) if (ptL[i] > 0) { ptPX[i] = ptX[i]; ptPY[i] = ptY[i]; } },
    // one tick: shake decays, stars scroll (unless the ship is exploding), particles and popups age
    update(warp, starsMove) {
      shake *= 0.88; if (shake < 0.05) shake = 0;
      for (let i = 0; i < NS; i++) {
        if (starsMove) stY[i] += stV[i] * (1 + warp * 16);
        if (stY[i] > H + 4) { stY[i] -= H + 8; stX[i] = rnd() * W; }
      }
      for (let i = 0; i < NP; i++) {
        if (ptL[i] <= 0) continue;
        ptX[i] += ptVX[i]; ptY[i] += ptVY[i]; ptVY[i] += ptGr[i]; ptVX[i] *= 0.985; ptVY[i] *= 0.985; ptL[i]--;
      }
      for (const p of pops) if (p.on) { p.t++; p.y -= 0.35; if (p.t > 70) p.on = false; }
    },
    updatePulse() { if (pulse.on) { pulse.r += 4.5; if (pulse.r > 140) pulse.on = false; } },
    drawStars(warp, F) {
      for (let i = 0; i < NS; i++) {
        const c = STAR_COLS[stC[i]], tw = Math.sin(F * 0.08 + stPh[i]) > -0.2 ? 1 : 0.15;
        const a = tw * (0.35 + stV[i] * 0.6);
        dot(stX[i], stY[i], 0.8 + stV[i] * 0.4, c[0], c[1], c[2], a);
        if (warp > 0.05) for (let k = 1; k <= 5; k++) dot(stX[i], stY[i] - k * warp * stV[i] * 7, 0.7, c[0], c[1], c[2], a * (1 - k / 6) * warp);
      }
    },
    drawParticles(al) {
      for (let i = 0; i < NP; i++) {
        if (ptL[i] <= 0) continue;
        const x = ptPX[i] + (ptX[i] - ptPX[i]) * al, y = ptPY[i] + (ptY[i] - ptPY[i]) * al, t = ptL[i] / ptM[i], f = 1 - t;
        let r = ptR[i], g = ptG[i], b = ptB[i];
        if (ptMode[i] === 1 || (ptMode[i] === 2 && f > 0.18)) {
          const q = ptMode[i] === 1 ? f : (f - 0.18) / 0.82;
          if (q < 0.2) { r = 1; g = 1; b = 1; } else if (q < 0.5) { r = 1; g = 1 - (q - 0.2) * 1.2; b = 0.3 - (q - 0.2); } else { r = 1 - (q - 0.5) * 0.6; g = 0.6 - (q - 0.5) * 1.1; b = 0.05; }
        }
        dot(x, y, ptS[i] * (0.5 + 0.5 * t), r, g, b, Math.min(1, t * 1.6));
      }
    },
    drawPulse() {
      if (!pulse.on) return;
      const a = 1 - pulse.r / 140;
      for (let i = 0; i < 72; i++) { const t = i / 72 * TAU; dot(pulse.x + Math.cos(t) * pulse.r, pulse.y + Math.sin(t) * pulse.r * 0.9, 1.4, 1, .7, .25, a); }
    },
    drawPops(text) { for (const p of pops) if (p.on) text(p.s, p.x, p.y, p.c, 1, 'c', p.t < 50 ? 1 : 1 - (p.t - 50) / 20); }
  };
}
