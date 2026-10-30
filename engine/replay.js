// Replays: the input word of every sim frame, run-length encoded.
// String form: r1~<game>~<gameVersion>~<seed base36>~<mode>~<body>
// body = base64url of (varint word, varint runLength) pairs.
export const REPLAY_FORMAT = 'r1';
// hard cap on decoded frames (2^26 = about 12.9 days at 60 Hz) so a hostile run length can't hang or exhaust memory
export const MAX_FRAMES = 2 ** 26;
const FIELD = /^[A-Za-z0-9._+-]+$/;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64I = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) B64I[B64.charCodeAt(i)] = i;

export function b64urlEncode(bytes, n = bytes.length) {
  let s = '';
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i], b = i + 1 < n ? bytes[i + 1] : 0, c = i + 2 < n ? bytes[i + 2] : 0, v = (a << 16) | (b << 8) | c;
    s += B64[(v >> 18) & 63] + B64[(v >> 12) & 63];
    if (i + 1 < n) s += B64[(v >> 6) & 63];
    if (i + 2 < n) s += B64[v & 63];
  }
  return s;
}
export function b64urlDecode(s) {
  if (s.length % 4 === 1) throw new Error('replay: bad base64 length');
  const out = new Uint8Array((s.length * 3) >> 2);
  let o = 0, acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i), v = c < 128 ? B64I[c] : -1;
    if (v < 0) throw new Error('replay: bad base64 char');
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
  }
  return out.subarray(0, o);
}

// Records words with run-length encoding as it goes; grows by doubling (no per-frame allocation).
export function createRecorder(cap = 1024) {
  let rw = new Uint16Array(cap), rn = new Uint32Array(cap), runs = 0, frames = 0;
  return {
    push(w) {
      w &= 0xffff;
      frames++;
      if (runs && rw[runs - 1] === w) { rn[runs - 1]++; return; }
      if (runs === rw.length) {
        const w2 = new Uint16Array(runs * 2), n2 = new Uint32Array(runs * 2);
        w2.set(rw); n2.set(rn); rw = w2; rn = n2;
      }
      rw[runs] = w; rn[runs] = 1; runs++;
    },
    reset() { runs = 0; frames = 0; },
    get frames() { return frames; },
    get runs() { return runs; },
    encode(header) { return encodeRuns(header, rw, rn, runs); }
  };
}

function header(h) {
  const seed = h.seed >>> 0;
  if (seed !== h.seed) throw new Error('replay: seed must be a uint32');
  for (const k of ['game', 'version', 'mode']) if (!FIELD.test(String(h[k]))) throw new Error('replay: bad ' + k + ' field');
  return [REPLAY_FORMAT, h.game, h.version, seed.toString(36), h.mode].join('~');
}

export function encodeRuns(h, rw, rn, runs) {
  const bytes = new Uint8Array(runs * 8 + 1);
  let o = 0;
  const varint = v => { while (v >= 128) { bytes[o++] = (v & 127) | 128; v = Math.floor(v / 128); } bytes[o++] = v; };
  for (let i = 0; i < runs; i++) { varint(rw[i]); varint(rn[i]); }
  return header(h) + '~' + b64urlEncode(bytes, o);
}

// words: any array-like of uint16
export function encode(h, words) {
  const r = createRecorder(16);
  for (let i = 0; i < words.length; i++) r.push(words[i] & 0xffff);
  return r.encode(h);
}

export function decode(str) {
  const parts = String(str).trim().split('~');
  if (parts.length !== 6 || parts[0] !== REPLAY_FORMAT) throw new Error('replay: not an ' + REPLAY_FORMAT + ' replay');
  const [, game, version, seed36, mode, body] = parts;
  if (!/^[0-9a-z]+$/.test(seed36)) throw new Error('replay: bad seed');
  const seed = parseInt(seed36, 36);
  if (!(seed >= 0 && seed <= 0xffffffff)) throw new Error('replay: seed out of range');
  const bytes = b64urlDecode(body);
  let i = 0;
  const varint = () => {
    let v = 0, mul = 1;
    for (;;) {
      if (i >= bytes.length) throw new Error('replay: truncated body');
      const b = bytes[i++]; v += (b & 127) * mul;
      if (b < 128) return v;
      mul *= 128; if (mul > 2 ** 35) throw new Error('replay: varint too long');
    }
  };
  const rw = [], rn = [];
  let frames = 0;
  while (i < bytes.length) {
    const w = varint(), n = varint();
    if (w > 0xffff || n < 1) throw new Error('replay: bad run');
    if (n > MAX_FRAMES || frames + n > MAX_FRAMES) throw new Error('replay: more than ' + MAX_FRAMES + ' frames');
    rw.push(w); rn.push(n); frames += n;
  }
  const words = new Uint16Array(frames);
  for (let k = 0, o = 0; k < rw.length; k++) { words.fill(rw[k], o, o + rn[k]); o += rn[k]; }
  return { format: REPLAY_FORMAT, game, version, seed, mode, frames, words };
}
