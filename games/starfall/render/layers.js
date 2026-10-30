// Ordered draw layers, bottom to top. A slice adds one line. Each layer: { id, hud?, draw(R, sim, al, st) }.
// Layers without `hud` are drawn into the playfield (shaken by the CRT pass); `hud` layers come after the split.
// A boss or stage layer checks its own condition (for example sim.boss.id) and returns early otherwise.
import { starsLayer, enemiesLayer, cometLayer, playerLayer, shotsLayer, bulletsLayer, particlesLayer, hudLayer, overlayLayer } from './core.js';
import { eclipseLayer } from './bosses/eclipse.js';
import { pyreLayer } from './bosses/pyre.js';
import { moonwellLayer } from './bosses/moonwell.js';
import { starlightLayer } from './starlight.js';
import { powerupsLayer } from './powerups.js';
import { zonesLayer } from './zones.js';
import { chainLayer } from './hud-chain.js';
import { enemiesZ2Layer } from './enemies-z2.js';
import { z3EnemiesLayer } from './enemies-z3.js';
import { enemiesC2Layer } from './enemies-c2.js';
import { twistsLayer } from './twists.js';
import { heatLayer } from './hud-heat.js';

export const layers = [
  zonesLayer,
  starsLayer,
  eclipseLayer,
  pyreLayer,
  moonwellLayer,
  enemiesLayer,
  enemiesZ2Layer,
  z3EnemiesLayer,
  enemiesC2Layer, // C2-0 stub: Tetherling line, Hounds (V2)
  twistsLayer,    // C2-0 stub: Hunt ring, Undertow bands, Thermals edges (V1)
  cometLayer,
  powerupsLayer,
  playerLayer,
  shotsLayer,
  bulletsLayer,
  particlesLayer,
  chainLayer,
  heatLayer,      // S11: heat flame next to the lantern (a playfield layer like the chain HUD)
  starlightLayer,
  hudLayer,
  overlayLayer
];
