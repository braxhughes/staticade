// Ordered sim systems: { id, init(sim), step(sim), onEvent(sim, ev) }. A slice adds one line.
// init runs once when the sim is created, step once per gameplay frame (after the v1 core),
// onEvent for each gameplay event (ev is one reused object: { type, enemy, x, y, v }).
// Systems must stay pure (no DOM, Math.random, Date) and allocation-free in step/onEvent.
import { scoreSystem } from './score.js';
import { powerSystem } from './powerups.js';
import { cinderSystem } from './enemies/cinder.js';
import { aimSystem } from './aim.js';
import { twistSystem } from './twists.js';
import { tetherSystem } from './enemies/tether.js';
import { houndSystem } from './enemies/hound.js';
import { heatSystem } from './heat.js';
import { starlightSystem } from './starlight.js';

export const systems = [
  scoreSystem,
  powerSystem,
  cinderSystem,
  aimSystem,    // C2-0 stub: lead aim (V1)
  twistSystem,  // C2-0 stub: twist clock, stage levers, Hunt (V1)
  tetherSystem, // C2-0 stub: Tetherling pairs (V2)
  houndSystem,  // C2-0 stub: Hounds (V2)
  heatSystem,   // S11: heat (visible rank), after score so its events see the chain result
  starlightSystem // S10 (registration moved here by S11): keep last, the step and hash order depend on it
];
