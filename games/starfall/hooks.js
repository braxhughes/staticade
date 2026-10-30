// window.SF hook registry. A slice adds one registration line at the bottom of this file.
//   registerHook(name, fn): SF[name](...args) calls fn(app, ...args); app = { sim, stepSim(word), ... } (see main.js)
//   registerInfo(fn):       SF.info() merges fn(sim, app) into its result while a run exists
// Hooks are test tools: anything that changes the run outside its inputs must mark it tainted.
import { packWord } from '../../engine/input-word.js';
import { glyphType, dropGlyph } from './sim/powerups.js';
import { bosses } from './sim/registry.js';
import { houndsLive } from './sim/enemies/hound.js';
import { starlightInfo } from './sim/starlight.js';
import { flameStep, intensity } from './sim/heat.js';

const hookList = [], infoList = [];
export function registerHook(name, fn) { hookList.push([name, fn]); }
export function registerInfo(fn) { infoList.push(fn); }

// called once by main.js after it builds SF and the app context
export function installHooks(SF, app) {
  for (const [name, fn] of hookList) SF[name] = (...a) => fn(app, ...a);
  const base = SF.info;
  SF.info = function () {
    const out = base.call(SF);
    if (app.sim) for (const fn of infoList) Object.assign(out, fn(app.sim, app));
    return out;
  };
}

// ---------- registrations (one line per slice) ----------
// S1a: run table position and heat
registerInfo(sim => ({ zone: sim.zone, loop: sim.loop, kind: sim.stageKind, heat: sim.heat }));
// S1b: hit-stop, live enemy bullets, active telegraphs; autoFire(frames) runs that many sim frames now with fire
// held (and the ship still), recorded in the replay like played frames, so the run stays exact (not tainted)
registerInfo(sim => ({ hitstop: sim.hitstop, bullets: sim.liveBullets(), telegraphs: sim.telegraphs() }));
registerHook('autoFire', (app, frames = 60) => {
  let n = 0;
  for (let i = 0; i < frames; i++) if (app.stepSim(packWord(0, true, i === 0, false, false, 0), true)) n++; else break;
  return n;
});
// S4: give(power) sets the held power-up now ('' clears it); glyph() drops a test glyph starting at FAN
// (above the ship, out of reach) when none is falling, and returns the falling glyph's type. Both taint the run.
registerHook('give', (app, id = '') => { const S = app.sim && app.sim.ctx; if (!S || !S.setPower(String(id))) return null; S.tainted = true; return S.power; });
registerHook('glyph', app => { const S = app.sim && app.sim.ctx; if (!S) return null; if (!S.glyph.on) { dropGlyph(S, S.player.x < 200 ? 300 : 100, 20, 0); S.tainted = true; } return glyphType(S.glyph); });
registerInfo(sim => ({ power: sim.ctx.power || null, glyph: sim.ctx.glyph.on ? glyphType(sim.ctx.glyph) : null }));
// S5: bossPhase(n) forces the active boss into phase n through its optional setPhase (tainted); info bossPhase (0 = no boss)
registerInfo(sim => ({ bossPhase: sim.boss.on ? sim.boss.phase | 0 : 0 }));
registerHook('bossPhase', (app, n) => { const sim = app.sim, B = sim && sim.boss.on && bosses[sim.boss.id]; if (!Number.isInteger(n) || n < 1 || !B || !B.setPhase) return false; B.setPhase(sim.ctx, n); sim.ctx.tainted = true; return true; });
// S3: Ember Chain length now, longest this run, grazes this run (sim/score.js)
registerInfo(sim => ({ chain: sim.ctx.chain, chainMax: sim.ctx.chainMax, grazes: sim.ctx.grazes }));
// B.10: powerT = play frames of power-up time left (0 = none); wings = wingmen out; wingLife = frames left on the first one (0 = none)
registerInfo(sim => ({ powerT: sim.ctx.powerT, wings: sim.wing.length, wingLife: sim.wing.length ? sim.wing[0].life : 0 }));
// S6: types = the enemy type ids alive now (one reused array)
registerInfo(function types(sim) { const t = types.buf || (types.buf = []); t.length = 0; for (let i = 0; i < sim.enemies.length; i++) { const e = sim.enemies[i]; if (!e.dead && t.indexOf(e.type) < 0) t.push(e.type); } return { types: t }; });
// S12: mode(m) starts a run in 'daily' or 'free' (no argument returns the current mode); info mode is set by main.js
registerHook('mode', (app, m) => app.setMode(m));
// C2-0 (B.11): twistT = twist clock (0.1); hunt = Hunt count toward 150 (2.2); hounds = Hounds on screen (3.2)
registerInfo(sim => ({ twistT: sim.ctx.twistT, hunt: sim.ctx.huntN, hounds: houndsLive(sim.ctx) }));
// S13a: autoFireLoud(frames, move, fire) is autoFire (ship moving at move, fire held unless fire is false) with sounds, jingles and music on
registerHook('autoFireLoud', (app, frames = 60, move = 0, fire = true) => { let n = 0; for (let i = 0; i < frames; i++) if (app.stepSim(packWord(move, fire, fire && i === 0, false, false, 0), false)) n++; else break; return n; });
// S10: STARLIGHT beat clock (sim/starlight.js): beatFrames 25 on STARLIGHT (0 elsewhere), beat and phrase (-1 before beat 0)
registerInfo(sim => starlightInfo(sim.ctx));
// S11: heat flame step (0 unlit, 1..5) and the music intensity input heat / 100 (read-only; S13b wires setIntensity)
registerInfo(sim => ({ flame: flameStep(sim.heat), intensity: intensity(sim.heat) }));
