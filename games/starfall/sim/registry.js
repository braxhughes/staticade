// Sim registries: enemy types, bosses and power-ups by id. A slice adds one line per registry.
// Lookups fall back so the run table can name things that are not built yet:
// an unregistered enemy id plays as 'moth', an unregistered boss plays as 'eclipse'.
import { STATS } from '../defs.js';
import { eclipse } from './bosses/eclipse.js';
import { pyre } from './bosses/pyre.js';
import { moonwell } from './bosses/moonwell.js';
import { prism } from './enemies/prism.js';
import { eel, huntAim } from './enemies/eel.js';
import { LAMPLIGHTER } from './enemies/lamplighter.js';
import { POWERS } from './powerups.js';
import { CINDER } from './enemies/cinder.js';
import { MIRAGE } from './enemies/mirage.js';
import { TETHER } from './enemies/tether.js';

// ---------- enemy types ----------
// registerEnemy(id, def) adds one type. def (plain data, plus an optional draw function):
//   { name, hp, r, form, dive }   stats: hit points, hit half-size, formation / dive kill value
//   art?:  { A: [rows], B: [rows], pal: { ch: [r, g, b] }, hurt?: { ch: [r, g, b] } }
//          two animation frames as strings, one char per dot ('.' = empty), and the char -> color map;
//          the browser builds the sprites lazily (sprites.js artFor), so the sim never touches them
//   draw?: (R, e, al, sim) => void   draws the enemy itself instead of the art (render side only)
//   hitX?: (S, e) => x               x of the part that shots and bodies hit (default e.x; S7 Mirage)
// optional sim hooks (S6; pure, allocation-free; e.T is the def):
//   init(S, e)          end of mkEnemy (e.r, e.c set; path and delay are set after)
//   move(S, e) -> bool  start of the enemy's update; true = it moved e itself this frame (the core state switch is skipped)
//   shot(S, e, p) -> bool  a player shot overlaps e; true = deflected (the shot vanishes, no hit, no damage)
//   aim(S, e)           after an aim-lock starts (e.aimX / e.aimY hold the player); may retarget it
//   onKill(S, e)        inside kill(), after the score
// A type with neither art nor draw is drawn (and explodes) with the moth art; it never crashes.
// `ti` (the numeric index used in presentation events) is the registration order; the player is TI_PLAYER (-1).
export const enemyTypes = {};
export const TYPE_IDS = [];
export function registerEnemy(id, def) {
  if (enemyTypes[id]) throw new Error('enemy type registered twice: ' + id);
  def.id = id; def.ti = TYPE_IDS.length;
  TYPE_IDS.push(id); enemyTypes[id] = def;
  return def;
}

registerEnemy('moth', { ...STATS.moth });
registerEnemy('wisp', { ...STATS.wisp });
registerEnemy('warden', { ...STATS.warden });
registerEnemy('splitter', { ...STATS.splitter });
registerEnemy('spark', { ...STATS.spark });
registerEnemy('prism', prism);
registerEnemy('eel', eel);
enemyTypes.wisp.aim = huntAim; // S6: from Z2, Wisps aim at the nearest wingman first (design.md B.1)

// ---------- bosses ----------
// boss: { id, name, setup(sim), update(sim), shot(sim, p) -> bool, hp(sim, out) -> out = [cur, max] }
//   setPhase?(sim, n): optional; forces phase n now (the SF.bossPhase(n) test hook calls it and taints the run).
//   A boss with phases keeps its current phase in sim.boss.phase (SF.info().bossPhase); setupBoss resets it to 0.
//   hash?(sim, h): optional; mixes the boss's own state into stateHash with h.u32(int) and h.f64(number).
// scoring contract (sim/score.js): a shot that connects does S.hits++ (refreshes the chain), a destroyed piece calls S.pieceKill(base)
export const bosses = {
  pyre,
  eclipse
};
bosses.moonwell = moonwell;

// ---------- power-ups ----------
export const powerups = {};
Object.assign(powerups, POWERS); // S4: fan, lance, halo, echo (sim/powerups.js)

export const enemyTypeId = id => enemyTypes[id] ? id : 'moth';
export const bossId = id => bosses[id] ? id : 'eclipse';

// S4: the Lamplighter (power-up carrier)
registerEnemy('lamplighter', LAMPLIGHTER);

// S7: Z3 enemies (Cinder: ember + 48-unit rule; Mirage: two copies, 12-frame fade)
registerEnemy('cinder', CINDER);
registerEnemy('mirage', MIRAGE);

// C2-0: the Tetherling (B.11 3.1), registered last so every older type keeps its index; V2 fills it
registerEnemy('tether', TETHER);
