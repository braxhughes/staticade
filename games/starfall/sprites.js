// Starfall art: sprites, palettes, colors and boss dot geometry (original designs). Browser-side only.
import { PI, TI_PLAYER } from './defs.js';
import { enemyTypes, TYPE_IDS } from './sim/registry.js';

const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
function P(o) { const a = new Array(128).fill(null); for (const k in o) a[k.charCodeAt(0)] = o[k]; return a; }
function rotHue(c, deg) {
  const a = deg * PI / 180, cs = Math.cos(a), sn = Math.sin(a), r = c[0], g = c[1], b = c[2];
  return [
    clamp(r * (.299 + .701 * cs + .168 * sn) + g * (.587 - .587 * cs + .330 * sn) + b * (.114 - .114 * cs - .497 * sn), 0, 1),
    clamp(r * (.299 - .299 * cs - .328 * sn) + g * (.587 + .413 * cs + .035 * sn) + b * (.114 - .114 * cs + .292 * sn), 0, 1),
    clamp(r * (.299 - .3 * cs + 1.25 * sn) + g * (.587 - .588 * cs - 1.05 * sn) + b * (.114 + .886 * cs - .203 * sn), 0, 1)];
}
const hue = (pal, deg) => pal.map(c => c ? rotHue(c, deg) : null);
const kindlePal = pal => pal.map(c => { if (!c) return null; const l = (c[0] + c[1] + c[2]) / 3; return l > 0.95 ? [1, 1, 1] : [1, 0.5 + 0.4 * l, 0.15 + 0.3 * l]; });
function spr(rows) {
  const h = rows.length, w = rows[0].length, d = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const ch = rows[y][x]; if (ch !== '.') d.push(x - (w - 1) / 2, y - (h - 1) / 2, ch.charCodeAt(0)); }
  return { d, w, h };
}
export const PLAYER = spr([
  '......y......', '.....yoy.....', '.....owo.....', '....owwwo....', 't...owywo...t', 't..owwywwo..t',
  'tt.owwwwwo.tt', 'ttwwwwwwwwwtt', 'tw.wwtttww.wt', 't..w.o.o.w..t']);
export const PAL_PLAYER = P({ w: [1, 1, 1], y: [1, .88, .35], o: [1, .55, .15], t: [.2, .92, .85] });
export const ART = {
  moth: {
    A: spr(['c.........c', '.c.......c.', '..c.vvv.c..', 'vv.vpppv.vv', 'vvvvpwpvvvv', 'vv.vpppv.vv', '...v.v.v...', '..v.....v..']),
    B: spr(['....c.c....', '....c.c....', '...cvvvc...', '.vvvpppvvv.', 'vvvvpwpvvvv', '.vv.ppp.vv.', '...v.v.v...', '...v...v...']),
    pal: P({ c: [.4, 1, 1], v: [.6, .4, 1], p: [1, .45, .8], w: [1, 1, 1] })
  },
  wisp: {
    A: spr(['....w....', '...wpw...', '..wpppw..', '.p.pwp.p.', 'pp.pwp.pp', 'p..ppp..p', '...p.p...', '..p...p..']),
    B: spr(['....w....', '...wpw...', '..wpppw..', '...pwp...', 'pp.pwp.pp', '.p.ppp.p.', '..p.p.p..', '...p.p...']),
    pal: P({ w: [1, 1, 1], p: [1, .4, .62] })
  },
  warden: {
    A: spr(['...g.....g...', '....g...g....', '..ooooooooo..', '.oowooooowoo.', 'ooooooooooooo', 'oo.ooyyyoo.oo', 'o..oyyyyyo..o', 'o...ooooo...o', '....o...o....', '...o.....o...']),
    B: spr(['...g.....g...', '....g...g....', '..ooooooooo..', '.oowooooowoo.', 'ooooooooooooo', '.o.ooyyyoo.o.', '.o.oyyyyyo.o.', 'oo..ooooo..oo', '....o...o....', '....o...o....']),
    pal: P({ g: [.5, 1, .4], o: [1, .6, .12], w: [1, 1, 1], y: [1, .95, .5] }),
    hurt: P({ g: [1, .6, .2], o: [.95, .15, .32], w: [1, 1, 1], y: [1, .6, .6] })
  },
  splitter: {
    A: spr(['....y....', '...ygy...', '..ygggy..', '.yggwggy.', 'yggwwwggy', '.yggwggy.', '..ygggy..', '...ygy...', '....y....']),
    B: spr(['....y....', '...yty...', '..ygtgy..', '.yggwggy.', 'ytgwwwgty', '.yggwggy.', '..ygtgy..', '...yty...', '....y....']),
    pal: P({ y: [1, .85, .2], g: [.3, .95, .5], t: [.6, 1, .9], w: [1, 1, 1] })
  },
  spark: {
    A: spr(['...y...', '..ygy..', '.ygwgy.', 'ygwwwgy', '.ygwgy.', '..ygy..', '...y...']),
    B: spr(['y.....y', '.ygyg..', '.gwwg..', '..www..', '..gwwg.', '..gygy.', 'y.....y']),
    pal: P({ y: [1, .85, .2], g: [.3, .95, .5], w: [1, 1, 1] })
  }
};
function finishArt(T) {
  T.pals = [0, 1, 2, 3].map(i => i ? hue(T.pal, i * 75) : T.pal);
  T.hurts = T.hurt ? [0, 1, 2, 3].map(i => i ? hue(T.hurt, i * 75) : T.hurt) : T.pals;
  T.kpal = kindlePal(T.pal);
  return T;
}
for (const k in ART) finishArt(ART[k]);

// art for an enemy type id: v1 art above, else the registered type's `art` (built once, cached),
// else the moth art (a type with no art never crashes the renderer)
const built = {};
export function artFor(id) {
  if (ART[id]) return ART[id];
  if (built[id]) return built[id];
  const d = enemyTypes[id], a = d && d.art;
  if (!a) return ART.moth;
  built[id] = finishArt({ A: spr(a.A), B: spr(a.B || a.A), pal: P(a.pal), hurt: a.hurt ? P(a.hurt) : null });
  return built[id];
}
// art by type index (the number carried by presentation events)
export const artOfTi = ti => artFor(TYPE_IDS[ti]);
// sprite for an explode event: type index (TI_PLAYER = player) + variant
export function spriteOf(ti, variant) { return ti === TI_PLAYER ? PLAYER : variant ? artOfTi(ti).B : artOfTi(ti).A; }
export function paletteOf(ti, pc) {
  if (pc === 9) return PAL_PLAYER;
  const T = artOfTi(ti);
  return pc === 8 ? T.kpal : pc >= 4 ? T.hurts[pc - 4] : T.pals[pc];
}

export const COL = { white: [1, 1, 1], amber: [1, .7, .2], rose: [1, .35, .5], teal: [.25, .95, .88], gold: [1, .88, .35], violet: [.65, .45, 1], dim: [.35, .35, .5] };
// index order matches C_* in defs.js
export const COLS = [COL.white, COL.amber, COL.rose, COL.teal, COL.gold, COL.violet, COL.dim];
export const STAR_COLS = [[1, .35, .35], [.35, .6, 1], [1, 1, .45], [.45, 1, .6], [1, 1, 1], [1, .55, 1], [.4, 1, 1]];

// ECLIPSE: a ring fortress of ~900 dots, stored as (radius, angle) pairs
export const B_HULL = [], B_CORE = [], B_PANEL = [[], [], [], [], [], [], [], []];
for (let r = 16; r <= 24; r += 4) { const n = Math.round(r * 2 * PI / 2.4); for (let i = 0; i < n; i++) B_HULL.push(r, i / n * 2 * PI); }
for (let r = 0; r <= 11; r += 2) { const n = Math.max(1, Math.round(r * 2 * PI / 2)); for (let i = 0; i < n; i++) B_CORE.push(r, i / n * 2 * PI); }
for (let k = 0; k < 8; k++) {
  const a0 = k * PI / 4 + 0.07, a1 = (k + 1) * PI / 4 - 0.07;
  for (let r = 29; r <= 39; r += 2.5) { const n = Math.ceil((a1 - a0) * r / 2.2); for (let i = 0; i <= n; i++) B_PANEL[k].push(r, a0 + (a1 - a0) * i / n); }
}
