// V4 fix: cut, hunt and snap must be audible, quieter than every kill sound, short, valid, and not copies of themselves.
// Part A reads the synth voice lists in Node. Part B renders each sound offline in headless Chrome (same graph as tools/audio-check.mjs)
// and measures peak, rms and length. Kills: near-silent snap (vol 0.004), loud or long hunt, invalid waveform, hunt pulse 2 = pulse 1.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { SFX, KILL_KINDS } from '../games/starfall/sfx.js';
import { WAVES } from '../engine/audio.js';

const NEW = ['cut', 'hunt', 'snap'];
const MAX_SECONDS = 0.5;        // short cues: voice start + length + release
const FILTERS = ['lowpass', 'highpass', 'bandpass', 'notch', 'allpass', 'peaking', 'lowshelf', 'highshelf'];

function voices(name) {
  const list = [];
  SFX[name]({ o: {}, tone: (s, at) => list.push({ kind: 'tone', s, at: at || 0 }), noise: (s, at) => list.push({ kind: 'noise', s, at: at || 0 }) }, {});
  return list;
}

// ---------- Part A: voice lists ----------
for (const n of NEW) {
  test(n + ': every voice has valid numbers, a valid oscillator type and filter, and ends within ' + MAX_SECONDS + ' s', () => {
    const vs = voices(n);
    assert.ok(vs.length >= 2, 'at least two voices');
    let end = 0;
    for (const v of vs) {
      const s = v.s;
      if (v.kind === 'tone') assert.ok(s.w === undefined || WAVES.includes(s.w), 'bad waveform ' + s.w);
      if (s.ft !== undefined) assert.ok(FILTERS.includes(s.ft), 'bad filter ' + s.ft);
      for (const k of ['f', 'f2', 'dur', 'vol', 'r', 'a', 'lp']) if (s[k] !== undefined) assert.ok(Number.isFinite(s[k]) && s[k] >= 0, k + ' finite and not negative');
      assert.ok(Number.isFinite(v.at) && v.at >= 0);
      assert.ok(s.dur > 0 && s.dur <= MAX_SECONDS, 'voice dur ' + s.dur);
      assert.ok((s.vol == null ? 0.2 : s.vol) >= 0.01, 'every voice declares vol >= 0.01 (got ' + s.vol + ')');
      end = Math.max(end, v.at + s.dur + (s.r || 0));
    }
    assert.ok(end <= MAX_SECONDS, 'ends at ' + end.toFixed(3) + ' s, limit ' + MAX_SECONDS);
    assert.ok(end >= 0.1, 'not a blip: ' + end.toFixed(3) + ' s');
  });
}

test('hunt is two different pulses, the second not a copy of the first', () => {
  const tri = voices('hunt').filter((v) => v.kind === 'tone' && v.s.w === 'tri');
  assert.ok(tri.length >= 2, 'two pulse voices');
  const [p1, p2] = tri.sort((a, b) => a.at - b.at);
  assert.ok(p2.at - p1.at >= 0.08, 'second pulse starts clearly later');
  assert.ok(p2.s.f !== p1.s.f && p2.s.f2 !== p1.s.f2, 'second pulse has its own pitch');
  const all = voices('hunt').filter((v) => v.kind === 'tone');
  const keys = all.map((v) => [v.s.w, v.s.f, v.s.f2].join('/'));
  assert.equal(new Set(keys).size, keys.length, 'no two tone voices share waveform and pitches');
});

// ---------- Part B: offline render ----------
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
let server, browser, rows;

before(async () => {
  server = http.createServer((req, res) => {
    const file = path.join(ROOT, path.normalize(decodeURIComponent(req.url.split('?')[0])));
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(data);
    });
  }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.goto(url + '/tools/audio-lab.html');
  rows = await page.evaluate(async (names) => {
    const { createAudio } = await import('/engine/audio.js');
    const { TRACKS } = await import('/games/starfall/music.js');
    const { SFX, KILL_KINDS } = await import('/games/starfall/sfx.js');
    const SR = 22050;
    const out = {};
    const items = [...names.map((n) => [n, n, {}]), ...KILL_KINDS.map((k) => ['kill.' + k, 'kill.' + k, {}])];
    for (const [label, name] of items) {
      const ac = new OfflineAudioContext(2, SR * 3, SR);
      const a = createAudio({ ctx: ac, tracks: TRACKS, sfx: SFX, limiter: true });
      const ok = a.sfx(name, {});
      const buf = await ac.startRendering();
      let peak = 0, sum = 0, n = 0, last = 0, nan = false;
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) {
          const v = d[i]; if (v !== v) { nan = true; continue; }
          const m = Math.abs(v); if (m > peak) peak = m;
          sum += v * v; n++;
          if (m > 0.002 && i / SR > last) last = i / SR;
        }
      }
      out[label] = { ok, peak, rms: Math.sqrt(sum / n), len: last, nan };
    }
    return out;
  }, NEW);
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

test('rendered cut, hunt and snap play, are loud enough to hear, and are never NaN', () => {
  for (const n of NEW) {
    const r = rows[n];
    assert.equal(r.ok, true, n + ' played');
    assert.equal(r.nan, false, n + ' NaN');
    assert.ok(r.peak >= 0.1, n + ' peak ' + r.peak.toFixed(3) + ' below the 0.1 floor');
    assert.ok(r.rms >= 0.008, n + ' rms ' + r.rms.toFixed(4) + ' below the 0.008 floor');
  }
});

test('rendered cut, hunt and snap are each quieter than the quietest kill sound (peak and rms)', () => {
  const kills = KILL_KINDS.map((k) => rows['kill.' + k]);
  const minPeak = Math.min(...kills.map((r) => r.peak)), minRms = Math.min(...kills.map((r) => r.rms));
  for (const n of NEW) {
    assert.ok(rows[n].peak < minPeak, n + ' peak ' + rows[n].peak.toFixed(3) + ' not under quietest kill ' + minPeak.toFixed(3));
    assert.ok(rows[n].rms < minRms, n + ' rms ' + rows[n].rms.toFixed(4) + ' not under quietest kill ' + minRms.toFixed(4));
  }
});

test('rendered cut, hunt and snap die out within ' + MAX_SECONDS + ' s', () => {
  for (const n of NEW) assert.ok(rows[n].len > 0.05 && rows[n].len <= MAX_SECONDS, n + ' audible for ' + rows[n].len.toFixed(3) + ' s');
});
