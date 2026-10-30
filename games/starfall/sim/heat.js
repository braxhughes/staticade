// Heat (design.md B.5 "Heat (visible rank)"): a rank the player can see. It rises with clean play, falls on death,
// and raises both danger and points.
//
// Events (each changes S.heat, then it is held in 0..100; a run starts at 0):
//   clear a normal stage without dying in it   +2   ('clear' event, deaths this stage = 0)
//   kill a boss                                +5   ('bossKill' event; a boss timeout gives nothing)
//   reach chain tier x4 (chain 60)             +1   once per stage
//   hold a power-up when a stage starts        +1   ('stage' event with S.power set)
//   death                                      -15
//
// Effects (the numbers live in sim/difficulty.js and sim/score.js, where the speeds and points are computed):
//   bullet speed x (1 + heat x 0.002), at most +20%   heatBullet()  (sim.js bulletSpd, boss bullet speeds)
//   dive gap - floor(heat x 0.3) frames               heatGap()     (sim.js diveGap)
//   kill points x (1 + heat / 200), at most x1.5       heatFactor()  (sim/score.js killPoints)
// Each is applied before the B.5 global limits (limitBullet / limitGap run last, in sim.js and the boss files).
//
// Hit-stop: every heat change comes from a gameplay event or this system's step, and the sim runs neither during
// hit-stop (sim.js step returns before the state machine and the systems), so heat events freeze in hit-stop.
//
// Music: intensity = heat / 100 (SF.info().intensity; S13b wires it to setIntensity).
//
// Test-only: createSim({ infiniteLives: true }) (balance bot, tools/sim-bot.mjs) gives the ship back on every death,
// so deaths are counted and the run goes on. Only Node code can pass it (main.js builds the sim from seed and mode),
// and such a run is tainted from frame 0, so its replay carries '+dev' and can never be submitted or verified.
//
// Pure and allocation-free: no DOM, Math.random or Date.
import { heatBullet, heatGap } from './difficulty.js';
import { heatFactor } from './score.js';

export { heatBullet, heatGap, heatFactor };
export const HEAT_MIN = 0, HEAT_MAX = 100;
export const HEAT_CLEAR = 2, HEAT_BOSS = 5, HEAT_TIER4 = 1, HEAT_POWER = 1, HEAT_DEATH = -15;
export const TIER4_CHAIN = 60;   // sim/score.js tier(): 60+ is x4
export const FLAME_STEPS = 5;

export function addHeat(S, d) {
  const v = S.heat + d;
  S.heat = v < HEAT_MIN ? HEAT_MIN : v > HEAT_MAX ? HEAT_MAX : v;
}
// the HUD flame step: 0 at heat 0 (an unlit ember), then 1..5 (1-20, 21-40, 41-60, 61-80, 81-100)
export function flameStep(heat) { return heat <= 0 ? 0 : Math.min(FLAME_STEPS, Math.ceil(heat / 20)); }
// music intensity input (B.8): heat / 100, 0..1
export const intensity = heat => heat / HEAT_MAX;

// tier x4 reached: once per stage
function tier4(S) {
  if (S.heatT4) return;
  S.heatT4 = 1;
  addHeat(S, HEAT_TIER4);
}
// a chain that ended on this very frame (the score system ends it before this system sees the event) still counts
const endedAt4 = S => S.chainEndF === S.frame && S.chainLast >= TIER4_CHAIN;

export const heatSystem = {
  id: 'heat',
  init(S) {
    S.heat = 0;
    S.heatT4 = 0;       // 1 once this stage's tier x4 heat is paid
    S.heatStD = 0;      // S.deaths when this stage started
    if (S.infiniteLives === undefined) S.infiniteLives = false;
  },
  step(S) {
    if (S.chain >= TIER4_CHAIN) tier4(S);
  },
  onEvent(S, ev) {
    switch (ev.type) {
      case 'stage':
        S.heatT4 = 0; S.heatStD = S.deaths;
        if (S.power) addHeat(S, HEAT_POWER);
        break;
      case 'kill':
        if (S.chain >= TIER4_CHAIN) tier4(S);
        break;
      case 'clear':
        if (endedAt4(S)) tier4(S);
        if (S.deaths === S.heatStD) addHeat(S, HEAT_CLEAR);
        break;
      case 'bossKill':
        if (endedAt4(S)) tier4(S);
        addHeat(S, HEAT_BOSS);
        break;
      case 'bossTimeout':
        if (endedAt4(S)) tier4(S);
        break;
      case 'death':
        if (endedAt4(S)) tier4(S);
        addHeat(S, HEAT_DEATH);
        if (S.infiniteLives) S.lives++;   // test-only: the ship comes back, the death still counts
        break;
    }
  },
  hash(S, u32) {
    u32(S.heatT4); u32(S.heatStD);
    if (S.infiniteLives) u32(0x1f1f1f1f);
  }
};
