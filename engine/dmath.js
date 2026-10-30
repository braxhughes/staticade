// Deterministic trig. Browser Math.sin/cos/atan2 are not required to match bit for bit across
// engines, so the simulation uses these instead. Only + - * / and Math.sqrt / Math.round / Math.abs,
// which IEEE 754 and the JS spec define exactly.

export const PI = 3.141592653589793, TAU = 6.283185307179586, HALF_PI = 1.5707963267948966;

// pi/2 split into three parts (fdlibm) for accurate range reduction
const P1 = 1.57079632673412561417e+00, P2 = 6.07710050630396597660e-11, P3 = 2.02226624879595063154e-21;
const INV_HALF_PI = 6.36619772367581382433e-01;

// Taylor coefficients 1/n!
const S3 = -1 / 6, S5 = 1 / 120, S7 = -1 / 5040, S9 = 1 / 362880, S11 = -1 / 39916800, S13 = 1 / 6227020800, S15 = -1 / 1307674368000;
const C2 = -1 / 2, C4 = 1 / 24, C6 = -1 / 720, C8 = 1 / 40320, C10 = -1 / 3628800, C12 = 1 / 479001600, C14 = -1 / 87178291200, C16 = 1 / 20922789888000;

// |r| <= pi/4
function ksin(r) { const z = r * r; return r + r * z * (S3 + z * (S5 + z * (S7 + z * (S9 + z * (S11 + z * (S13 + z * S15)))))); }
function kcos(r) { const z = r * r; return 1 + z * (C2 + z * (C4 + z * (C6 + z * (C8 + z * (C10 + z * (C12 + z * (C14 + z * C16))))))); }

let RQ = 0, RR = 0;
function reduce(x) {
  const k = Math.round(x * INV_HALF_PI);
  RR = ((x - k * P1) - k * P2) - k * P3;
  RQ = ((k % 4) + 4) % 4;
}

export function sin(x) {
  if (x !== x || x === Infinity || x === -Infinity) return NaN;
  reduce(x);
  switch (RQ) { case 0: return ksin(RR); case 1: return kcos(RR); case 2: return -ksin(RR); default: return -kcos(RR); }
}
export function cos(x) {
  if (x !== x || x === Infinity || x === -Infinity) return NaN;
  reduce(x);
  switch (RQ) { case 0: return kcos(RR); case 1: return -ksin(RR); case 2: return -kcos(RR); default: return ksin(RR); }
}

// atan for t in [0, 1]: two half-angle reductions bring t under tan(pi/16), then a short series
function katan(t) {
  t = t / (1 + Math.sqrt(1 + t * t));
  t = t / (1 + Math.sqrt(1 + t * t));
  const z = t * t;
  const s = t * (1 + z * (-1 / 3 + z * (1 / 5 + z * (-1 / 7 + z * (1 / 9 + z * (-1 / 11 + z * (1 / 13 + z * (-1 / 15 + z * (1 / 17 + z * (-1 / 19 + z * (1 / 21)))))))))));
  return 4 * s;
}

export function atan2(y, x) {
  if (x !== x || y !== y) return NaN;
  if (y === 0) {
    // keep the sign rules of Math.atan2 for signed zeros
    if (x > 0 || (x === 0 && 1 / x > 0)) return y;
    return 1 / y > 0 ? PI : -PI;
  }
  if (x === 0) return y > 0 ? HALF_PI : -HALF_PI;
  const ax = x < 0 ? -x : x, ay = y < 0 ? -y : y;
  let r;
  if (ax === Infinity || ay === Infinity) {
    r = ax === Infinity ? (ay === Infinity ? PI / 4 : 0) : HALF_PI;
  } else r = ay <= ax ? katan(ay / ax) : HALF_PI - katan(ax / ay);
  if (x < 0) r = PI - r;
  return y < 0 ? -r : r;
}

export function atan(x) { return atan2(x, 1); }

export function hypot(x, y) { return Math.sqrt(x * x + y * y); }
