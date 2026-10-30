// W6 LOW: PYRE can die with petals still alive; its HP bar must read 0 at death (scoring unchanged).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { bosses } from '../games/starfall/sim/registry.js';
import { PYRE } from '../games/starfall/sim/bosses/pyre.js';

const IDLE = 128, B = bosses.pyre;
const step = (sim, n = 1) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(IDLE); sim.clearEvents(); } return sim; };

test('PYRE killed through the core with petals alive: the HP bar reads 0', () => {
  const sim = createSim({ seed: 15, mode: 'stage15' });
  while (sim.state !== 'play') step(sim);
  sim.setGod(true);
  while (sim.boss.entering) step(sim);
  const S = sim.ctx, boss = sim.boss;
  B.setPhase(S, 3); step(sim, 1 + 8 + PYRE.quiet);
  assert.equal(boss.phase, 3);
  let alive = 0; for (let k = 0; k < boss.fHp.length; k++) if (boss.fHp[k] > 0) alive++;
  assert.ok(alive > 0, 'some petals still alive');
  // keep the petals out of the shot's way, then land the last core hit
  for (let k = 0; k < boss.fHp.length; k++) { boss.fX[k] = -500; boss.fY[k] = -500; }
  boss.core = 1;
  const before = sim.score, p = sim.ps[0];
  p.on = true; p.x = p.px = boss.x; p.y = p.py = boss.y;
  assert.equal(B.shot(S, p), true);
  assert.equal(sim.boss.on, false, 'boss defeated');
  assert.ok(sim.score > before, 'the boss bonus is still paid');
  let still = 0; for (let k = 0; k < boss.fHp.length; k++) if (boss.fHp[k] > 0) still++;
  assert.ok(still > 0, 'petals were alive at the moment of death');
  const hp = sim.bossHp();
  assert.equal(hp[0], 0); assert.ok(hp[1] > 0);
});
