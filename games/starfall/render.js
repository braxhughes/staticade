// Draws a Starfall run from sim state, interpolated by alpha. Reads the sim, never writes it.
// The picture is the ordered layer list in render/layers.js. Cosmetic randomness (shake jitter) is unseeded on purpose.
import { layers } from './render/layers.js';

const rnd = Math.random;

export function createRenderer({ gfx, crt, fx, text, ui }) {
  const dot = gfx.dot;

  // dotted frame
  function panel(x, y, w, h, col, a) {
    for (let i = 0; i <= w; i += 3) { dot(x + i, y, 0.8, col[0], col[1], col[2], a); dot(x + i, y + h, 0.8, col[0], col[1], col[2], a); }
    for (let j = 3; j < h; j += 3) { dot(x, y + j, 0.8, col[0], col[1], col[2], a); dot(x + w, y + j, 0.8, col[0], col[1], col[2], a); }
  }

  function drawSpr(S, x, y, ang, pal, sc, a, flash, asm) {
    const c = Math.cos(ang) * sc, s = Math.sin(ang) * sc, d = S.d, k = asm == null ? 1 : asm;
    for (let i = 0; i < d.length; i += 3) {
      const col = pal[d[i + 2]];
      if (!col) continue;
      const dx = d[i] * k, dy = d[i + 1] * k;
      const X = x + dx * c - dy * s, Y = y + dx * s + dy * c;
      if (flash) dot(X, Y, 1.2 * sc, 1, 1, 1, a); else dot(X, Y, 1.1 * sc, col[0], col[1], col[2], a);
    }
  }

  const R = { gfx, dot, text, fx, ui, drawSpr, panel };

  // st: the sim state, or 'results' once the run is over
  function drawGame(sim, al, st) {
    gfx.reset();
    for (let i = 0; i < layers.length; i++) if (!layers[i].hud) layers[i].draw(R, sim, al, st);
    const split = gfx.count();
    for (let i = 0; i < layers.length; i++) if (layers[i].hud) layers[i].draw(R, sim, al, st);
    const sh = fx.shake;
    crt.flush(split, (rnd() - .5) * sh, (rnd() - .5) * sh, ui.crtOn, ui.F / 60);
  }
  return { drawGame, drawSpr, panel };
}
