// Balance bot (design.md section C row S11, B.0 run budget): a deterministic scripted player that plays a whole
// first loop in Node and fails unless the difficulty curve lands in the design's band.
//
// Usage: node tools/sim-bot.mjs [--seed N] [--quiet]
//   PASS (exit 0) only if the run reaches stage 16 in 34,000 to 46,000 frames with at most 8 deaths.
//   Otherwise FAIL (exit 1). Prints per-stage frames, deaths and heat, then the totals and the final state hash
//   (two runs of the same seed print the same hash).
//
// The bot has no randomness of its own and reads only the sim's current state each frame (positions and current
// velocities; never a copy of the sim stepped ahead). Every frame, in order:
//   1. dodge: of the enemy bullets and diving bodies heading for the ship (their straight-line path at the current
//      velocity crosses the ship's row within LOOK frames, inside DANGER units of the ship), take the one that
//      arrives first and move away from where it will cross; near a wall, move the other way.
//   2. else move under the nearest enemy (the boss's center on a boss stage) and fire.
//   3. KINDLE (the second action) whenever the lantern is full.
// Gap steering: while a MOONWELL tide wall is falling, or a PYRE arc ring is in flight (the inhale
// that follows the ring), the bot steers to that wall's or ring's gap, which the screen shows. It reads only the gap
// of the wall or ring already on screen (boss.gapX after it spawned): never a coming wall's gap, never the RNG.
// Inside the gap it dodges only bullets that will cross inside the gap, and never steps out of it.
// Fire is held the whole time (auto-fire, 10-frame refire) with a fresh press every PRESS frames.
// The run uses the test-only sim option infiniteLives, so deaths are counted and the run goes on (the run is
// tainted and can never be submitted).
import { createSim } from '../games/starfall/sim.js';
import { packWord } from '../engine/input-word.js';
import { METER_MAX, W } from '../games/starfall/defs.js';
import { BREATH_IN, PYRE } from '../games/starfall/sim/bosses/pyre.js';
import { MOONWELL } from '../games/starfall/sim/bosses/moonwell.js';

export const BAND_MIN = 34000, BAND_MAX = 46000, MAX_DEATHS = 8, GOAL_STAGE = 16, FRAME_LIMIT = 120000;
const LOOK = 40, DANGER = 11, PRESS = 8, WALL = 24, GAP_MARGIN = 6;

// the gap of the wall or ring now on screen, or -1
export function visibleGap(sim) {
  const b = sim.boss;
  if (!b.on) return -1;
  if (b.id === 'moonwell' && b.wallOn) return b.gapX;
  if (b.id === 'pyre' && b.phase === 2 && b.breath === BREATH_IN && b.gapX >= 0) return b.gapX;
  return -1;
}
// half-width of that gap (the boss tables, B.6)
const gapHalf = sim => sim.boss.id === 'moonwell' ? MOONWELL.gapHalf : PYRE.gapHalf;

// one bot decision from the current state: returns the input word for this frame
export function botWord(sim) {
  const p = sim.player, f = sim.frame;
  const kin = sim.meter >= METER_MAX && p.alive;
  // a wall or ring gap on screen; inside it, only threats that will cross inside the gap count
  const gap = visibleGap(sim), half = gap >= 0 ? gapHalf(sim) : 0, win = half - GAP_MARGIN;
  const inGap = gap >= 0 && Math.abs(gap - p.x) <= win;
  // 1. the first threat to reach the ship's row
  let tBest = LOOK + 1, xHit = 0;
  for (let i = 0; i < sim.eb.length; i++) {
    const b = sim.eb[i];
    if (!b.on || b.vy <= 0 || b.y > p.y + 4) continue;
    const t = (p.y - b.y) / b.vy;
    if (t > LOOK || t >= tBest) continue;
    const x = b.x + b.vx * t;
    if (inGap && Math.abs(x - gap) >= half) continue;
    if (Math.abs(x - p.x) < DANGER) { tBest = t; xHit = x; }
  }
  for (let i = 0; i < sim.enemies.length; i++) {
    const e = sim.enemies[i];
    if (e.dead || e.bonus || !(e.st === 'dive' || e.st === 'spark' || e.st === 'path')) continue;
    const vy = e.y - e.py, vx = e.x - e.px;
    if (vy <= 0 || e.y > p.y + 6) continue;
    const t = (p.y - e.y) / vy;
    if (t > LOOK || t >= tBest) continue;
    const x = e.x + vx * t;
    if (inGap && Math.abs(x - gap) >= half + 4) continue;
    if (Math.abs(x - p.x) < DANGER + 4) { tBest = t; xHit = x; }
  }
  let move;
  if (gap >= 0) {
    // steer to the gap. Inside it, dodge only what will cross inside the gap (the wall or ring itself crosses
    // outside it) and never step out of it; on the way there, dodge first as usual.
    const dx = gap - p.x, toGap = Math.abs(dx) < 1 ? 0 : Math.max(-1, Math.min(1, dx / 10));
    if (inGap) {
      const dir = tBest <= LOOK ? (p.x >= xHit ? 1 : -1) : 0;
      move = dir !== 0 && Math.abs(p.x + dir * 3 - gap) <= win ? dir : toGap;
    } else move = tBest <= LOOK ? (p.x >= xHit ? 1 : -1) : toGap;
  } else if (tBest <= LOOK) {
    let dir = p.x >= xHit ? 1 : -1;
    if (p.x > W - WALL && dir > 0) dir = -1; else if (p.x < WALL && dir < 0) dir = 1;
    move = dir;
  } else {
    // 2. under the nearest enemy (smallest sideways distance, lower enemies first on a tie), or the boss
    let tx = p.x, best = 1e9;
    if (sim.boss.on) tx = sim.boss.x;
    else for (let i = 0; i < sim.enemies.length; i++) {
      const e = sim.enemies[i];
      if (e.dead || e.st === 'wait' || e.y < 0 || e.y > p.y - 10) continue;
      const d = Math.abs(e.x - p.x) - e.y * 0.001;
      if (d < best) { best = d; tx = e.x; }
    }
    const dx = tx - p.x;
    move = Math.abs(dx) < 1 ? 0 : Math.max(-1, Math.min(1, dx / 10));
  }
  return packWord(move, true, f % PRESS === 0, kin, false, 0);
}

export function runBot(seed = 1, { log = null } = {}) {
  const sim = createSim({ seed, mode: 'arcade', infiniteLives: true });
  const rows = [];
  let stage = sim.stage, start = 0, d0 = 0, reached = -1;
  while (sim.frame < FRAME_LIMIT && !sim.done) {
    sim.step(botWord(sim)); sim.clearEvents();
    if (sim.stage !== stage) {
      const row = { stage, frames: sim.frame - start, deaths: sim.deaths - d0, heat: sim.heat };
      rows.push(row); if (log) log(row);
      stage = sim.stage; start = sim.frame; d0 = sim.deaths;
      if (stage >= GOAL_STAGE) { reached = sim.frame; break; }
    }
  }
  const pass = reached >= BAND_MIN && reached <= BAND_MAX && sim.deaths <= MAX_DEATHS;
  return { seed, pass, reached, frames: sim.frame, deaths: sim.deaths, heat: sim.heat, score: sim.score, stage: sim.stage, hash: sim.stateHash(), rows };
}

if (process.argv[1] && process.argv[1].endsWith('sim-bot.mjs')) {
  const a = process.argv.slice(2), i = a.indexOf('--seed');
  const seed = i >= 0 ? Number(a[i + 1]) >>> 0 : 1;
  const quiet = a.includes('--quiet');
  if (!quiet) console.log('stage | frames | deaths | heat after');
  const r = runBot(seed, { log: quiet ? null : x => console.log(`${x.stage} | ${x.frames} | ${x.deaths} | ${x.heat}`) });
  console.log(`seed ${seed}: stage 16 at frame ${r.reached < 0 ? 'never' : r.reached} (band ${BAND_MIN}-${BAND_MAX}), deaths ${r.deaths} (max ${MAX_DEATHS}), heat ${r.heat}, score ${r.score}, hash ${r.hash}`);
  console.log(r.pass ? 'PASS' : 'FAIL');
  process.exit(r.pass ? 0 : 1);
}
