// Starfall v1 synthesized sound effects, moved here unchanged from the one-file v1.
// Kept as it was when it moved here.
const rnd = Math.random;

export let AC = null, master = null, NB = null, muted = false;
export function audio() {
  if (!AC) {
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
      master = AC.createGain(); master.gain.value = muted ? 0 : 0.55; master.connect(AC.destination);
      NB = AC.createBuffer(1, AC.sampleRate, AC.sampleRate);
      const d = NB.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1;
    } catch (e) { AC = null; }
  }
  if (AC && AC.state === 'suspended') AC.resume();
}
export function setMuted(m) { muted = m; if (master) master.gain.value = m ? 0 : 0.55; }
function tone(f, dur, type, vol, slide, when) {
  if (!AC) return;
  const t = AC.currentTime + (when || 0), o = AC.createOscillator(), g = AC.createGain();
  o.type = type || 'square'; o.frequency.setValueAtTime(f, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, slide), t + dur);
  g.gain.setValueAtTime(vol || 0.06, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur, vol, f0, f1, when) {
  if (!AC) return;
  const t = AC.currentTime + (when || 0), s = AC.createBufferSource(), f = AC.createBiquadFilter(), g = AC.createGain();
  s.buffer = NB; f.type = 'lowpass'; f.frequency.setValueAtTime(f0, t);
  if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + dur);
}
export const SFX = {
  fire() { tone(1300, 0.06, 'square', 0.025, 520); },
  ding() { tone(700, 0.05, 'square', 0.04, 1000); },
  pop() { noise(0.2, 0.16, 3200, 300); tone(240, 0.12, 'triangle', 0.07, 60); },
  big() { noise(0.7, 0.32, 2400, 70); tone(110, 0.6, 'sawtooth', 0.05, 30); },
  die() { noise(1.1, 0.4, 1600, 60); tone(440, 1.0, 'sawtooth', 0.06, 50); },
  kindle() { [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.18, 'triangle', 0.07, 0, i * 0.05)); },
  life() { [880, 1175, 1568, 2093].forEach((f, i) => tone(f, 0.25, 'sine', 0.08, 0, i * 0.09)); },
  warp() { tone(70, 0.9, 'sawtooth', 0.05, 1800); noise(0.9, 0.1, 300, 5000); },
  toss() { tone(2400, 0.05, 'triangle', 0.03, 3200); },
  clunk() {
    noise(0.14, 0.4, 1100, 120); tone(95, 0.22, 'sine', 0.3, 42);
    tone(2150, 0.3, 'triangle', 0.035, 0, 0.015); tone(3300, 0.18, 'sine', 0.02, 0, 0.02);
    noise(0.04, 0.12, 2500, 800, 0.09); noise(0.03, 0.08, 2500, 800, 0.15);
    tone(880, 0.07, 'square', 0.035, 0, 0.32); tone(1320, 0.12, 'square', 0.035, 0, 0.39);
  },
  wingLost() { tone(520, 0.35, 'triangle', 0.07, 130); },
  phase2() { tone(60, 1.0, 'sawtooth', 0.07, 240); noise(0.8, 0.18, 400, 3000); },
  morph() { tone(300, 0.3, 'sine', 0.07, 1400); },
  deflect() { tone(1900, 0.03, 'square', 0.02); },
  menu() { tone(990, 0.05, 'square', 0.03); },
  select() { tone(660, 0.08, 'square', 0.04); tone(1320, 0.12, 'square', 0.04, 0, 0.06); },
  jingle() {
    const mel = [392, 523, 659, 784, 659, 784, 988, 1047], bass = [131, 131, 165, 196];
    mel.forEach((f, i) => tone(f, 0.16, 'square', 0.035, 0, i * 0.14));
    bass.forEach((f, i) => tone(f, 0.3, 'triangle', 0.09, 0, i * 0.28));
  },
  beat(n) {
    const arp = [523, 659, 784, 988, 784, 659, 587, 740];
    tone(arp[n % 8], 0.12, 'square', 0.025);
    if (n % 4 === 0) tone([131, 147, 165, 147][(n >> 2) % 4], 0.3, 'triangle', 0.08);
  }
};
export function isMuted() { return muted; }
