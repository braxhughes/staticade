// Offline audio audit in headless Chrome (OfflineAudioContext). Exits 1 on any failure.
// Tracks: whole first pass at intensity 1 with the safety limiter bypassed (fails if the raw mix exceeds 1.0),
//   limiter gain reduction, RMS of the intro (first 8 s) AND of an 8 s window at the loop point, the calm mix (intensity 0),
//   and every channel soloed (its peak must be a sensible fraction of what its vol implies, so a muted lead cannot hide).
// SFX: every effect (per kill kind, chainTick at chain 1 and 11) must be non-silent by peak and by loudest 50 ms window.
// Usage: node tools/audio-check.mjs [baseUrl]   (default starts its own server on port 8772 if none given)
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

let base = process.argv[2];
let server = null;
if (!base) {
  server = spawn('python3', ['-m', 'http.server', '8772'], { stdio: 'ignore' });
  base = 'http://localhost:8772';
  await new Promise((r) => setTimeout(r, 900));
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) problems.push('console: ' + m.text()); });
await page.goto(base + '/tools/audio-lab.html');

// Optional: AUDIO_CHECK_ONLY=z1,shot limits the run to named items (quick mutation checks).
const ONLY = process.env.AUDIO_CHECK_ONLY ? process.env.AUDIO_CHECK_ONLY.split(',') : null;
const rows = await page.evaluate(async (ONLY) => {
  const { createAudio, trackDuration } = await import('/engine/audio.js');
  const { TRACKS, TRACK_IDS } = await import('/games/starfall/music.js');
  const { SFX, SFX_NAMES, KILL_KINDS } = await import('/games/starfall/sfx.js');
  const SR = 22050, BUS = 0.8 * 0.9;         // music bus x master gain: what a channel's vol turns into at the output
  // peak, overall RMS, NaN flag, loudest 50 ms window RMS, optionally restricted to [from, to) seconds
  const stats = (buf, from = 0, to = Infinity) => {
    let peak = 0, sum = 0, n = 0, nan = false, win = 0;
    const W = Math.floor(SR * 0.05);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      const i0 = Math.floor(from * SR), i1 = Math.min(d.length, Math.floor(to * SR));
      let ws = 0, wn = 0;
      for (let i = i0; i < i1; i++) {
        const v = d[i];
        if (v !== v || !isFinite(v)) { nan = true; continue; }
        const a = Math.abs(v); if (a > peak) peak = a;
        sum += v * v; n++; ws += v * v; wn++;
        if (wn === W) { win = Math.max(win, Math.sqrt(ws / W)); ws = 0; wn = 0; }
      }
    }
    return { peak, rms: Math.sqrt(sum / Math.max(1, n)), nan, win };
  };
  // Worst limiter gain reduction in dB: smallest |limited| / |raw| over loud samples.
  const limiterGR = (raw, fin) => {
    let worst = 1;
    for (let c = 0; c < raw.numberOfChannels; c++) {
      const r = raw.getChannelData(c), f = fin.getChannelData(c);
      for (let i = 0; i < r.length; i++) { const a = Math.abs(r[i]); if (a > 0.5) worst = Math.min(worst, Math.abs(f[i]) / a); }
    }
    return 20 * Math.log10(worst);
  };
  const loopStart = (t) => {
    let s = 0;
    for (let i = 0; i < (t.loopFrom || 0) && t.loop !== false; i++) s += t.song[i].bars * t.stepsPerBar * 60 / t.bpm / t.stepsPerBeat;
    return s;
  };
  const render = async (track, intensity, limiter, sec) => {
    const ac = new OfflineAudioContext(2, Math.ceil(SR * sec), SR);
    const a = createAudio({ ctx: ac, tracks: { [track.id]: track }, sfx: SFX, limiter });
    a.setIntensity(intensity); a.playMusic(track.id); a.renderTo(sec);
    return ac.startRendering();
  };
  const out = [];
  for (const id of TRACK_IDS) {
    if (ONLY && !ONLY.includes(id)) continue;
    const t = TRACKS[id];
    const full = Math.min(trackDuration(t), 75), ls = loopStart(t);
    const bodyEnd = Math.min(full, ls + 8);
    const raw = await render(t, 1, false, full);        // all layers, limiter bypassed = true compressor output, whole first pass
    const fin = await render(t, 1, true, bodyEnd);      // as shipped, covering the intro and the body window
    const lo = await render(t, 0, true, bodyEnd);       // calmest layer set
    const rs = stats(raw), fs = stats(fin);
    const head = stats(fin, 0, Math.min(8, full)), body = stats(fin, ls, bodyEnd), body0 = stats(lo, ls, bodyEnd);
    // each channel on its own at intensity 1, in the first section that uses it: its peak must be a sensible
    // fraction of what its vol implies (a channel whose volume is broken cannot hide behind the others)
    let minSolo = Infinity, minCh = '';
    const soloPeaks = {};
    for (const ch of Object.keys(t.channels)) {
      const spec = t.channels[ch];
      const sec = t.song.find((s) => ch in s.p);
      let r = 0;
      if (sec) {
        const only = { ...t, loop: false, channels: { [ch]: spec }, song: [{ bars: sec.bars, p: { [ch]: sec.p[ch] } }] };
        const dur = Math.min(8, sec.bars * t.stepsPerBar * 60 / t.bpm / t.stepsPerBeat);
        const sb = stats(await render(only, 1, false, dur));
        r = sb.peak / (spec.vol * BUS * (spec.drum ? 0.28 : 1));
        soloPeaks[ch] = sb.peak;
      } else soloPeaks[ch] = 0;
      if (r < minSolo) { minSolo = r; minCh = ch; }
    }
    // Scale check that does not trust the declared vol: every channel must reach 3% of the loudest channel's solo peak
    // (and an absolute 0.01), so a channel whose vol was broken (e.g. 1e-6) cannot pass by being "as quiet as declared".
    const loudest = Math.max(...Object.values(soloPeaks));
    for (const ch of Object.keys(soloPeaks)) {
      const rel = soloPeaks[ch] / loudest;
      if ((rel < 0.03 || soloPeaks[ch] < 0.01) && rel < minSolo) { minSolo = rel; minCh = ch; }
    }
    const nGR = Math.min(raw.length, fin.length);
    const rawPrefix = { numberOfChannels: 2, getChannelData: (c) => raw.getChannelData(c).subarray(0, nGR) };
    out.push({
      kind: 'track', name: id, rawPeak: rs.peak, peak: fs.peak, gr: limiterGR(rawPrefix, fin),
      headRms: head.rms, bodyRms: body.rms, body0Rms: body0.rms, win: body.win, minSolo, minCh, nan: rs.nan || fs.nan || body0.nan, secs: full
    });
  }
  const items = [];
  for (const n of SFX_NAMES) {
    if (n === 'kill') for (const k of KILL_KINDS) items.push(['kill.' + k, 'kill', { kind: k }]);
    else if (n === 'chainTick') { items.push(['chainTick#1', n, { chain: 1 }]); items.push(['chainTick#11', n, { chain: 11 }]); }
    else items.push([n, n, {}]);
  }
  const renderSfx = async (name, opts, limiter) => {
    const ac = new OfflineAudioContext(2, SR * 3, SR);
    const a = createAudio({ ctx: ac, tracks: TRACKS, sfx: SFX, limiter });
    const ok = a.sfx(name, opts);
    return { ok, buf: await ac.startRendering() };
  };
  for (const [label, n, o] of items) {
    if (ONLY && !ONLY.includes(label) && !ONLY.includes(n)) continue;
    const r = await renderSfx(n, o, false), f = await renderSfx(n, o, true);
    const rs = stats(r.buf), fs = stats(f.buf);
    // expected scale: loudest declared voice x sfx bus x master; silence is judged relative to this, not an absolute floor
    let maxVol = 0; const stub = { o, tone: (sp) => { maxVol = Math.max(maxVol, sp.vol == null ? 0.2 : sp.vol); }, noise: (sp) => { maxVol = Math.max(maxVol, sp.vol == null ? 0.2 : sp.vol); } };
    SFX[n](stub, o);
    out.push({ kind: 'sfx', name: label, rawPeak: rs.peak, peak: fs.peak, gr: limiterGR(r.buf, f.buf), bodyRms: fs.rms, win: fs.win, nan: rs.nan || fs.nan, ok: f.ok, rel: fs.peak / (maxVol * 0.81) });
  }
  return out;
}, ONLY);
await browser.close();
if (server) server.kill();

const f = (x, d = 3) => x.toFixed(d);
let bad = 0;
console.log('Tracks: full first pass at intensity 1 (raw = limiter bypassed), body window = 8 s from the loop point.');
console.log('kind  name             rawPeak  peak    GR(dB)  headRMS bodyRMS body@i0 minSolo(ch)        status');
for (const r of rows) {
  const why = [];
  if (r.nan) why.push('NaN');
  if (r.rawPeak > 1.0) why.push('CLIP(raw>1.0)');
  if (r.peak > 1.0) why.push('PEAK>1');
  if (r.kind === 'track') {
    if (r.headRms < 0.02) why.push('SILENT_HEAD');
    if (r.bodyRms < 0.02) why.push('SILENT_BODY');
    if (r.body0Rms < 0.02) why.push('SILENT@i0');
    if (r.minSolo < 0.25) why.push('CHANNEL_QUIET(' + r.minCh + ')');
  } else {
    if (r.rel < 0.15 || r.peak < 0.005 || r.win < 0.001) why.push('SILENT(rel ' + f(r.rel, 2) + ')');
    if (r.ok === false) why.push('NOT PLAYED');
  }
  if (why.length) bad++;
  const line = r.kind.padEnd(5) + ' ' + r.name.padEnd(16) + ' ' + f(r.rawPeak).padStart(7) + ' ' + f(r.peak).padStart(7) + ' ' + f(r.gr, 2).padStart(7);
  const mid = r.kind === 'track'
    ? ' ' + f(r.headRms).padStart(7) + ' ' + f(r.bodyRms).padStart(7) + ' ' + f(r.body0Rms).padStart(7) + ' ' + (f(r.minSolo, 2) + '(' + r.minCh + ')').padEnd(18)
    : ' ' + ('win ' + f(r.win)).padStart(7) + ' ' + ('rms ' + f(r.bodyRms)).padStart(11) + ' ' + ('rel ' + f(r.rel, 2)).padEnd(22);
  console.log(line + mid + ' ' + (why.length ? 'FAIL ' + why.join(',') : 'ok'));
}
console.log(`\n${rows.length} items, ${bad} failing, ${rows.filter((r) => r.rawPeak > 1).length} clipping before the limiter, worst limiter GR ${f(Math.min(...rows.map((r) => r.gr)), 2)} dB`);
if (problems.length) { console.log('PAGE PROBLEMS:\n' + problems.join('\n')); process.exit(1); }
process.exit(bad ? 1 : 0);
