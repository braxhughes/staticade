// S13b: engine/audio.js nudge(dt) shifts the playing track's beat grid without restarting it. Node only: a recursive stub
// stands in for the AudioContext (every property is a function or node that accepts anything), so no browser is needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudio } from '../engine/audio.js';
import { TRACKS } from '../games/starfall/music.js';

function stubCtx() {
  const mk = () => new Proxy(function () {}, {
    get: (t, k) => (k === 'value' ? 0 : k === Symbol.toPrimitive ? () => 0 : mk()),
    set: () => true,
    apply: () => mk()
  });
  const ctx = mk();
  const clock = { t: 10 };
  return new Proxy(ctx, {
    get: (t, k) => (k === 'currentTime' ? clock.t : k === 'state' ? 'running' : k === 'sampleRate' ? 44100 : k === 'startRendering' ? undefined : ctx[k]),
    set: () => true
  });
}

test('nudge moves beatAt by dt x bpm / 60 beats and keeps the same track playing', () => {
  const a = createAudio({ tracks: TRACKS, sfx: {}, ctx: stubCtx() });
  assert.equal(a.nudge(0.1), undefined, 'no music: nudge is a harmless no-op');
  assert.equal(a.playMusic('bonus', { fadeMs: 0 }), true);
  try {
    const t = 10.5;
    const before = a.beatAt(t), info = a.current();
    a.nudge(1 / 60);
    const after = a.beatAt(t);
    assert.ok(Math.abs((before - after) - (1 / 60) * 144 / 60) < 1e-9, 'later grid: beat position drops by dt x bpm / 60');
    assert.ok(Math.abs((info.startTime + 1 / 60) - a.current().startTime) < 1e-12);
    a.nudge(-1 / 60);
    assert.ok(Math.abs(a.beatAt(t) - before) < 1e-9, 'a negative nudge undoes it');
    assert.equal(a.current().id, 'bonus', 'same track, not restarted');
    a.nudge(0);
    assert.ok(Math.abs(a.beatAt(t) - before) < 1e-9, 'zero is a no-op');
  } finally { a.stopMusic({ fadeMs: 0 }); }
});
