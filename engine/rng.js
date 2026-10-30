// Seeded PRNG (sfc32): four 32-bit words of state, fast, and easy to save, restore and hash.
// Uses only integer ops (| >>> << ^ +), so every JS engine produces the same sequence.

export class Rng {
  constructor(seed = 0) { this.seed(seed); }
  seed(s) {
    this.a = 0x9e3779b9 | 0; this.b = 0x243f6a88 | 0; this.c = 0xb7e15162 | 0; this.d = s | 0;
    for (let i = 0; i < 12; i++) this.u32();
    return this;
  }
  // next uint32
  u32() {
    let a = this.a, b = this.b, c = this.c, d = this.d;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    this.a = a; this.b = b; this.c = c; this.d = d;
    return t >>> 0;
  }
  // float in [0, 1)
  next() { return this.u32() / 4294967296; }
  // integer in [0, n)
  int(n) { return (this.next() * n) | 0; }
  save() { return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0]; }
  restore(s) { this.a = s[0] | 0; this.b = s[1] | 0; this.c = s[2] | 0; this.d = s[3] | 0; return this; }
}

export function createRng(seed) { return new Rng(seed); }

// 32-bit seed from any string (FNV-1a over UTF-16 code units, then a murmur3 finalizer).
export function seedFromString(str) {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}

// Seed shared by everyone for one UTC day. dateStr is 'YYYY-MM-DD'.
export function dailySeed(dateStr, salt = '') {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error('dailySeed wants YYYY-MM-DD, got ' + dateStr);
  return seedFromString('daily:' + salt + ':' + dateStr);
}
