// C.2 V4: every new popup, burst and sound id has a visible or audible answer. Presentation only; no sim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFx } from '../games/starfall/fx.js';
import { SFX, SFX_NAMES } from '../games/starfall/sfx.js';
import { EV_POPUP, EV_FX, POP_CUT, FX_TETHER } from '../games/starfall/defs.js';

test('POP_CUT shows the text CUT', () => {
  const fx = createFx(() => {});
  const b = new Float64Array(10); b[0] = EV_POPUP; b[1] = POP_CUT; b[2] = 100; b[3] = 80;
  assert.equal(fx.handle(b, 0), true);
  const on = fx.pops.filter(p => p.on);
  assert.equal(on.length, 1);
  assert.equal(on[0].s, 'CUT');
});

test('FX_TETHER emits 10 dots at the break point and draws them', () => {
  const dots = [];
  const fx = createFx((x, y, s, r, g, bl, a) => dots.push({ x, y, a }));
  const b = new Float64Array(10); b[0] = EV_FX; b[1] = FX_TETHER; b[2] = 250; b[3] = 160;
  assert.equal(fx.handle(b, 0), true);
  fx.drawParticles(1);
  assert.equal(dots.length, 10);
  for (const d of dots) { assert.ok(Math.abs(d.x - 250) < 1e-6 && Math.abs(d.y - 160) < 1e-6); assert.ok(d.a > 0 && d.a <= 1); }
  for (let i = 0; i < 40; i++) fx.update(0, false);
  dots.length = 0; fx.drawParticles(1);
  assert.equal(dots.length, 0, 'burst has faded');
});

test('cut, hunt, snap have synths that play voices', () => {
  for (const n of ['cut', 'hunt', 'snap']) {
    assert.ok(SFX_NAMES.includes(n), n);
    let voices = 0;
    SFX[n]({ tone: () => voices++, noise: () => voices++ }, {});
    assert.ok(voices >= 2, n);
  }
});
