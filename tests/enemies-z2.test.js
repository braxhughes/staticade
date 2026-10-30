// S6: Z2 enemies (design.md B.3): Prism (deflecting face), Eel (5-segment ribbon), wingman hunting (B.1),
// the B.9 telegraph rule for every Z2 dive and aimed shot, and the `types` info field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSim } from '../games/starfall/sim.js';
import { enemyTypes } from '../games/starfall/sim/registry.js';
import { prismT, PRISM_ON, PRISM_CYCLE } from '../games/starfall/sim/enemies/prism.js';
import { EEL_DELAY, EEL_SCATTER, UNSPOOL_BONUS, CURL, HUNT_Y } from '../games/starfall/sim/enemies/eel.js';
import { PRISM_OFF } from '../games/starfall/sim/enemies/prism.js';
import { TELE_DIVE, TELE_AIM } from '../games/starfall/sim/feel.js';
import { installHooks } from '../games/starfall/hooks.js';
import { layers } from '../games/starfall/render/layers.js';
import { enemiesZ2Layer } from '../games/starfall/render/enemies-z2.js';
import { enemiesLayer } from '../games/starfall/render/core.js';
import { packWord } from '../engine/input-word.js';

const IDLE = 128;
const step = (sim, n = 1, w = IDLE) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(w); sim.clearEvents(); } return sim; };
const toFull = sim => { for (let i = 0; i < 4000 && !sim.formFull; i++) step(sim); assert.ok(sim.formFull, 'formation fills'); return sim; };
const eelsOf = sim => sim.enemies.filter(e => e.type === 'eel');
const ribbon = (sim, g) => { const r = []; for (const e of eelsOf(sim)) if (e.eg === g && e.ek >= 0) r[e.ek] = e; return r; };
// a wingman beside the player, as KINDLE would make it
function addWing(sim, dx) {
  const S = sim.ctx, w = S.wingPool[S.wing.length];
  w.ti = enemyTypes.moth.ti; w.T = enemyTypes.moth; w.x = w.px = sim.player.x + dx; w.y = w.py = sim.player.y + 2; w.side = dx < 0 ? -1 : 1; w.ang = 0;
  S.wing.push(w); return w;
}

test('Prism and Eel are registered with the B.3 stats; the Eel head is worth 400', () => {
  const P = enemyTypes.prism, E = enemyTypes.eel;
  assert.deepEqual([P.hp, P.form, P.dive], [2, 160, 400]);
  assert.deepEqual([E.hp, E.form, E.dive], [1, 80, 80]);
  const sim = createSim({ seed: 1, mode: 'stage7' }), heads = eelsOf(sim).filter(e => e.ek === 0);
  assert.equal(heads.length, 2);
  for (const h of heads) assert.deepEqual([h.T.form, h.T.dive, h.T.ti, h.type], [400, 400, E.ti, 'eel']);
});

test('section C verify: stage 7, once the formation is full, info types include prism and eel', () => {
  const SF = { info() { return {}; } };
  const app = { sim: null };
  installHooks(SF, app);
  app.sim = toFull(createSim({ seed: 7, mode: 'stage7' }));
  const t = SF.info().types;
  assert.ok(t.includes('prism') && t.includes('eel'), JSON.stringify(t));
  assert.equal(SF.info().types, t, 'one reused array');
  // stage 6 has Prisms but no Eels (B.3)
  app.sim = toFull(createSim({ seed: 7, mode: 'stage6' }));
  assert.ok(SF.info().types.includes('prism') && !SF.info().types.includes('eel'));
});

test('Prism: face glows 90 frames, rests 60', () => {
  const sim = toFull(createSim({ seed: 3, mode: 'stage6' }));
  const p = sim.enemies.find(e => e.type === 'prism');
  let on = 0;
  assert.deepEqual([PRISM_ON, PRISM_OFF, PRISM_CYCLE], [90, 60, 150], 'B.3: on 90, off 60');
  for (let i = 0; i < 150 * 4; i++) { if (prismT(p) < PRISM_ON) on++; p.pt++; }
  assert.equal(on, 90 * 4);
});

// put a shot right under a formation Prism, then run one frame
let sim;
function shootPrism(s, glow) {
  sim = s;
  const S = sim.ctx, p = sim.enemies.find(e => e.type === 'prism' && e.st === 'form');
  for (const e of sim.enemies) if (e !== p && e.st === 'form' && Math.abs(e.x - p.x) < 10 && e.y > p.y) e.dead = true; // clear the lane
  while ((prismT(p) < PRISM_ON) !== glow) step(sim);
  p.pfa = 0; // face straight down (toward a player below)
  const shot = sim.ps[0]; shot.on = true; shot.x = shot.px = p.x; shot.y = shot.py = p.y + 9;
  const before = { hits: S.hits, fired: S.shotsFired, hp: p.hp, defl: S.prismDeflects | 0 };
  step(sim);
  return { p, shot, before, S };
}

test('Prism deflects a shot that hits its glowing face: shot gone, counts as fired not hit, no damage', () => {
  const { p, shot, before, S } = shootPrism(toFull(createSim({ seed: 3, mode: 'stage6' })), true);
  assert.equal(shot.on, false, 'the shot vanished');
  assert.equal(S.hits, before.hits, 'not a hit');
  assert.equal(S.shotsFired, before.fired, 'still counted as fired (when it was fired)');
  assert.equal(p.hp, before.hp, 'no damage');
  assert.equal(S.prismDeflects, before.defl + 1);
  assert.equal(sim.eb.some(b => b.on && Math.abs(b.x - p.x) < 4), false, 'a deflected shot never becomes a hazard');
});

test('Prism takes the hit while its face rests', () => {
  const { p, shot, before, S } = shootPrism(toFull(createSim({ seed: 3, mode: 'stage6' })), false);
  assert.equal(shot.on, false);
  assert.equal(S.hits, before.hits + 1);
  assert.equal(p.hp, before.hp - 1);
});

test('Prism can be hit from the side: a face turned away from below does not deflect', () => {
  const sim = toFull(createSim({ seed: 3, mode: 'stage6' })), S = sim.ctx;
  const p = sim.enemies.find(e => e.type === 'prism' && e.st === 'form');
  while (prismT(p) >= PRISM_ON) step(sim);
  p.pfa = 1.5; // face turned sideways (as when it passes the player in a dive)
  const shot = sim.ps[0]; shot.on = true; shot.x = shot.px = p.x; shot.y = shot.py = p.y + 9;
  const h = S.hits;
  step(sim); // the face turns at most 0.06 this frame, so it stays outside the arc

  assert.equal(S.hits, h + 1);
});

test('Prism face turns toward the player at a bounded rate', () => {
  const sim = toFull(createSim({ seed: 3, mode: 'stage6' }));
  const p = sim.enemies.find(e => e.type === 'prism');
  p.pfa = 2;
  const a0 = p.pfa; step(sim);
  assert.ok(Math.abs(p.pfa - a0) <= 0.06 + 1e-9 && p.pfa < a0);
});

test('Eel ribbons: row 4 is two 5-segment ribbons with heads at columns 0 and 9', () => {
  const sim = createSim({ seed: 2, mode: 'stage7' });
  for (const g of [0, 1]) {
    const r = ribbon(sim, g);
    assert.equal(r.filter(Boolean).length, 5);
    assert.deepEqual(r.map(e => e.c), g === 0 ? [0, 1, 2, 3, 4] : [9, 8, 7, 6, 5]);
  }
});

test('Eel entry: the ribbon enters as one, each segment 8 frames behind the one before on the same path', () => {
  const sim = createSim({ seed: 2, mode: 'stage7' }), S = sim.ctx;
  const r = ribbon(sim, 0), trail = r.map(() => []);
  for (let f = 0; f < 1100; f++) {
    const stop = S.hitstop > 0;
    step(sim);
    if (!stop) r.forEach((e, k) => { if (e.st === 'path') trail[k].push(e.x.toFixed(4) + ',' + e.y.toFixed(4)); });
  }
  assert.ok(trail[0].length > 40, 'head entered on a path');
  for (let k = 1; k < 5; k++) assert.deepEqual(trail[k].slice(0, 40), trail[0].slice(0, 40), 'segment ' + k + ' follows the same path');
  assert.equal(r[1].path, r[0].path);
  for (let k = 1; k < 5; k++) assert.ok(r[k].st === 'form' || r[k].st === 'join');
});

// force ribbon g to dive now: start its head's dive telegraph as the formation picker would
// (it also lifts the diver cap, so the ribbon is sure to fit; the cap rule has its own tests below)
function roomy(sim) { sim.ctx.D.maxFull = sim.ctx.D.maxLow = 40; return sim; }
function diveRibbon(sim, g, side = 1) {
  roomy(sim);
  const h = ribbon(sim, g)[0];
  h.st = 'tele'; h.tele = TELE_DIVE; h.teleSide = side; h.teleOff = 0;
  return h;
}

test('Eel dive: segments glow with the head, then each follows the head\'s path 8 x k frames later', () => {
  const sim = toFull(createSim({ seed: 4, mode: 'stage7' })), S = sim.ctx;
  S.god = true;
  const r = ribbon(sim, 0), h = diveRibbon(sim, 0);
  const pos = r.map(() => []), states = r.map(() => []);
  for (let f = 0; f < 140; f++) {
    step(sim);
    r.forEach((e, k) => { pos[k].push([e.x, e.y]); states[k].push(e.st); });
  }
  assert.equal(states[0][0], 'tele');
  for (let k = 1; k < 5; k++) assert.equal(states[k][0], 'tele', 'segment ' + k + ' glows from the head\'s first telegraph frame');
  const firstDive = states.map(s => s.indexOf('dive'));
  assert.equal(firstDive[0], TELE_DIVE - 1, 'head: 20 telegraph frames, then the dive');
  for (let k = 1; k < 5; k++) {
    assert.equal(EEL_DELAY, 8, 'B.3: 8-frame delay');
    assert.ok(firstDive[k] - firstDive[0] >= 8 * k && firstDive[k] - firstDive[0] <= 8 * k + 1, 'segment ' + k + ' starts ' + (firstDive[k] - firstDive[0]));
    const lag = firstDive[k] - firstDive[0];
    for (let f = firstDive[k]; f < 140; f++) {
      if (states[k][f] !== 'dive' || states[0][f - lag] !== 'dive') break;
      assert.deepEqual(pos[k][f], pos[0][f - lag], `segment ${k} at frame ${f} is where the head was ${lag} frames earlier`);
    }
  }
  assert.ok(h.st === 'dive');
});

test('a dive pick that lands on an Eel segment is passed to its head', () => {
  const sim = toFull(createSim({ seed: 4, mode: 'stage7' }));
  roomy(sim);
  const r = ribbon(sim, 1), s = r[3];
  s.st = 'tele'; s.tele = TELE_DIVE; s.teleSide = -1; s.teleOff = 0;
  step(sim, 2);
  assert.equal(r[0].st, 'tele', 'head telegraphs');
  assert.equal(r[0].teleSide, -1);
  assert.equal(s.st, 'tele'); assert.equal(s.ew, 1, 'the segment now waits for the head\'s path');
  step(sim, 30);
  assert.equal(r[0].st, 'dive');
});

test('the ribbon returns: each segment rejoins its own slot after the head\'s dive ends', () => {
  const sim = toFull(createSim({ seed: 4, mode: 'stage7' })), S = sim.ctx;
  S.god = true;
  const r = ribbon(sim, 0); diveRibbon(sim, 0);
  let back = false;
  for (let f = 0; f < 1500 && !back; f++) { step(sim); back = f > 60 && r.every(e => e.st === 'form'); }
  assert.ok(back, 'all five back in formation: ' + r.map(e => e.st));
  step(sim); // the curl pose applies from the first full formation frame
  r.forEach(e => { S.slot(e.r, e.c); assert.ok(Math.abs(e.x - S.SX) < 1e-9 && Math.abs(e.y - S.SY - CURL[e.ek]) < 1e-9); });
});

test('killing the head scatters the rest: resting segments glow 20 frames, then fly free', () => {
  const sim = toFull(createSim({ seed: 5, mode: 'stage7' })), S = sim.ctx;
  S.god = true;
  const r = ribbon(sim, 1);
  S.kill(r[0]);
  const seen = r.map(() => []);
  for (let f = 0; f < 40; f++) { step(sim); r.forEach((e, k) => seen[k].push(e.st)); }
  for (let k = 1; k < 5; k++) {
    const t = seen[k].indexOf('tele'), sp = seen[k].indexOf('spark');
    assert.equal(t, 0, 'segment ' + k + ' glows at once');
    assert.equal(sp - t, EEL_SCATTER, 'then flies after 20 glow frames');
    assert.equal(r[k].ek, -1, 'no longer part of a ribbon');
  }
});

test('a head taken by KINDLE also scatters its ribbon; segments already following fly on at once', () => {
  const sim = toFull(createSim({ seed: 5, mode: 'stage7' })), S = sim.ctx;
  S.god = true;
  const r = ribbon(sim, 0); diveRibbon(sim, 0);
  step(sim, TELE_DIVE + EEL_DELAY + 6); // head and segment 1 moving, 2-4 still waiting
  assert.equal(r[1].st, 'dive'); assert.equal(r[3].st, 'tele');
  r[0].dead = true; // what doKindle does to the enemy it turns into a wingman
  step(sim);
  assert.equal(r[1].st, 'spark', 'a following segment flies on');
  assert.ok(r[1].vy >= 1.2);
  assert.equal(r[3].st, 'tele'); assert.equal(r[3].esc, EEL_SCATTER, 'a waiting one starts its 20-frame glow');
});

test('UNSPOOLED: killing all five tail to head pays +2000 flat; any other order pays nothing extra', () => {
  for (const order of [[4, 3, 2, 1, 0], [3, 4, 2, 1, 0]]) {
    const sim = toFull(createSim({ seed: 6, mode: 'stage7' })), S = sim.ctx;
    const r = ribbon(sim, 0);
    for (const k of order) S.kill(r[k]);
    const tail = order[0] === 4 && order[1] === 3;
    assert.equal(S.eels.unspooled, tail ? 1 : 0, order.join(''));
  }
  // the flat bonus itself
  const sim = toFull(createSim({ seed: 6, mode: 'stage7' })), S = sim.ctx, r = ribbon(sim, 1);
  let gain = 0;
  for (let k = 4; k >= 0; k--) { const s0 = S.score; S.kill(r[k]); gain += S.score - s0; }
  // kill points of five formation kills (80 x 4 + 400 head) at chain tier 1, plus the flat 2000
  assert.equal(UNSPOOL_BONUS, 2000);
  assert.equal(gain, 4 * 80 + 400 + 2000, 'five formation kills at tier 1 plus the flat 2000 (loop 0)');
});

test('hunting: from Z2 a Wisp\'s aimed shot locks onto the nearest wingman; in Z1 it still aims at the player', () => {
  for (const [mode, zone] of [['stage7', 2], ['stage3', 1]]) {
    const sim = toFull(createSim({ seed: 8, mode })), S = sim.ctx;
    const w = addWing(sim, 17);
    const wisp = sim.enemies.find(e => e.type === 'wisp');
    wisp.st = 'path'; wisp.y = 120; // aiming only happens in flight
    // startAim is internal; run the same aim-lock the sim does, through the registered hook
    wisp.aimT = TELE_AIM; wisp.aimX = sim.player.x; wisp.aimY = sim.player.y;
    if (wisp.T.aim) wisp.T.aim(S, wisp);
    assert.equal(S.zone, zone);
    if (zone === 2) assert.deepEqual([wisp.aimX, wisp.aimY], [w.x, w.y]);
    else assert.deepEqual([wisp.aimX, wisp.aimY], [sim.player.x, sim.player.y]);
  }
});

test('hunting in play: a Z2 Wisp\'s dive shot flies at the wingman, not the player', () => {
  const sim = toFull(createSim({ seed: 8, mode: 'stage7' })), S = sim.ctx;
  S.god = true;
  let hit = null, w = null;
  for (let f = 0; f < 6000 && !hit; f++) {
    if (!S.wing.length) w = addWing(sim, -17); // a stray bullet can take the wingman; put one back
    step(sim);
    if (S.wing.length) for (const e of sim.enemies) if (e.type === 'wisp' && e.aimT === TELE_AIM) { hit = e; break; }
  }
  assert.ok(hit, 'a wisp started an aimed shot');
  assert.ok(Math.abs(hit.aimX - w.x) < 3 && Math.abs(hit.aimY - w.y) < 3, `aim (${hit.aimX}, ${hit.aimY}) wing (${w.x}, ${w.y})`);
});

test('hunting: a diving Eel head steers toward the nearest wingman', () => {
  const run = withWing => {
    const sim = toFull(createSim({ seed: 9, mode: 'stage7' })), S = sim.ctx;
    S.god = true;
    let w = null; if (withWing) w = addWing(sim, 17);
    const h = diveRibbon(sim, 0, 1);
    let minD = Infinity;
    for (let f = 0; f < 400 && h.st !== 'join'; f++) {
      step(sim);
      if (h.st === 'dive' && w && h.y > 200 && h.y < w.y) minD = Math.min(minD, Math.abs(h.x - w.x));
      if (h.st === 'dive' && !w && h.y > 200 && h.y < sim.player.y) minD = Math.min(minD, Math.abs(h.x - (sim.player.x + 17)));
    }
    return { minD, off: h.eoff };
  };
  const hunt = run(true), plain = run(false);
  assert.ok(hunt.minD < 4, 'head closes on the wingman: ' + hunt.minD);
  assert.ok(plain.minD > hunt.minD, `without a wingman the path is not bent that way (${plain.minD} vs ${hunt.minD})`);
});

// ---------- B.9 telegraph audit: every Z2 dive and every enemy bullet gets >= 20 frames of visible warning ----------
// Counts only frames the sim actually advanced (hit-stop frames do not count toward the warning).
function audit(mode, seed, frames) {
  const sim = createSim({ seed, mode }), S = sim.ctx;
  S.god = true;
  const rec = new Map(), bOn = new Uint8Array(sim.eb.length);
  const out = { dives: { prism: 0, eel: 0 }, scatters: 0, ribbonDives: 0, bullets: 0, fails: [] };
  let n = 0; // frames the sim advanced (not hit-stop)
  const stage0 = sim.stage;
  for (let f = 0; f < frames && !sim.done && sim.stage === stage0; f++) { // this stage only (the next may be a boss)
    const stop = S.hitstop > 0;
    // a scripted pilot: sweeps, fires, and uses KINDLE whenever the lantern is full
    const mv = ((f >> 6) & 3) === 0 ? -1 : ((f >> 6) & 3) === 2 ? 1 : 0;
    sim.step(packWord(mv, true, f % 9 === 0, S.meter >= 10 && f % 4 === 0, false, 0)); sim.clearEvents();
    if (stop) continue;
    n++;
    for (const e of sim.enemies) {
      let r = rec.get(e);
      if (!r || r.n !== n - 1 || r.type !== e.type) { r = { n, e, type: e.type, st: e.st, tele: 0, aim: e.aimT, aimRun: e.aimT > 0 ? 1 : 0, pend: 0, x: 0, y: 0 }; rec.set(e, r); }
      const moving = e.st === 'dive' || e.st === 'spark', was = r.st === 'dive' || r.st === 'spark';
      if ((e.type === 'prism' || e.type === 'eel') && moving && !was && !e.dead) {
        out.dives[e.type]++;
        if (e.type === 'eel' && e.st === 'spark') out.scatters++;
        if (e.type === 'eel' && e.st === 'dive' && e.ek > 0) out.ribbonDives++;
        if (r.tele < 20) out.fails.push(`${e.type} ${r.st}->${e.st} after ${r.tele} glow frames at f${f}`);
      }
      r.tele = e.st === 'tele' ? r.tele + 1 : 0;
      // the glow ends when the timer leaves 1 (it may restart at 20 in the same frame: a new, full glow)
      if (r.aim === 1) { if (r.aimRun >= TELE_AIM) r.pend = 31; r.aimRun = e.aimT > 0 ? 1 : 0; }
      else r.aimRun = e.aimT > 0 ? r.aimRun + 1 : 0;
      r.aim = e.aimT;
      r.st = e.st; r.n = n; r.x = e.x; r.y = e.y;
    }
    // every new enemy bullet must come from an enemy whose aim-lock glow just ran its full 20 frames
    for (let i = 0; i < sim.eb.length; i++) {
      const b = sim.eb[i];
      if (b.on && !bOn[i]) {
        out.bullets++;
        let src = null;
        // the source may have died later in the same frame, so look at every recent record (last known position)
        for (const r of rec.values()) if (r.pend > 0 && Math.abs(r.x - (b.x - b.vx)) < 10 && Math.abs(r.y - (b.y - b.vy)) < 12) { src = r; break; }
        if (src) src.pend = 0; else out.fails.push(`bullet at f${f} (${b.x.toFixed(1)}, ${b.y.toFixed(1)}) without a 20-frame aim glow`);
      }
      bOn[i] = b.on ? 1 : 0;
    }
    for (const r of rec.values()) if (r.pend > 0) r.pend--;
  }
  return out;
}

test('B.9 telegraphs: in stages 6, 7 and 8 every Prism/Eel dive and every enemy bullet gets >= 20 frames of warning', () => {
  const tot = { prism: 0, eel: 0, scatters: 0, ribbonDives: 0, bullets: 0 };
  for (const [mode, seed] of [['stage6', 11], ['stage7', 12], ['stage8', 13], ['stage8', 14]]) {
    const o = audit(mode, seed, 7000);
    assert.deepEqual(o.fails, [], mode);
    tot.prism += o.dives.prism; tot.eel += o.dives.eel; tot.scatters += o.scatters; tot.ribbonDives += o.ribbonDives; tot.bullets += o.bullets;
  }
  // the audit is not vacuous: it saw Prism dives, ribbon dives, scatters and aimed shots
  assert.ok(tot.prism >= 3 && tot.ribbonDives >= 4 && tot.scatters >= 1 && tot.bullets >= 10, JSON.stringify(tot));
});

test('stages 7 and 8 replay exactly: same seed and inputs give the same hash', () => {
  const run = mode => { const s = createSim({ seed: 21, mode }); for (let f = 0; f < 3000 && !s.done; f++) { s.step(packWord(((f >> 5) & 1) ? 1 : -1, true, f % 7 === 0, f % 500 === 0, false, 0)); s.clearEvents(); } return s.stateHash(); };
  for (const m of ['stage7', 'stage8']) assert.equal(run(m), run(m));
});

test('sim stays pure in stages 7 and 8 (Math.sin / Math.cos / Math.random trap)', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const script = `
    const trap = name => { throw new Error('sim touched ' + name); };
    Math.random = () => trap('Math.random'); Math.sin = () => trap('Math.sin'); Math.cos = () => trap('Math.cos');
    const { createSim } = await import('../games/starfall/sim.js');
    for (const mode of ['stage7', 'stage8']) {
      const sim = createSim({ seed: 5, mode });
      for (let f = 0; f < 2500 && !sim.done; f++) { sim.step(((f >> 5) & 1 ? 255 : 1) | 512 | (f % 300 === 0 ? 2048 : 0)); sim.drain(() => {}); }
      sim.stateHash();
    }
    console.log('pure-ok');`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: here, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /pure-ok/);
});

test('render: the Z2 layer sits right after the enemies layer and draws faces, spines and the UNSPOOLED call-out', () => {
  assert.equal(layers[layers.indexOf(enemiesLayer) + 1], enemiesZ2Layer);
  const sim = toFull(createSim({ seed: 3, mode: 'stage8' }));
  let dots = 0, bad = 0; const texts = [];
  const R = { ui: { F: 50 }, dot(x, y, s, r, g, b, a) { dots++; if (!(a >= 0 && a <= 1) || !(s > 0) || r > 1 || g > 1 || b > 1 || !Number.isFinite(x + y)) bad++; }, text(s) { texts.push(s); }, drawSpr() {} };
  enemiesZ2Layer.draw(R, sim, 0.5);
  assert.equal(bad, 0);
  // 6 Prisms x 7 face dots (+ a glow dot when lit), 2 ribbons x 4 links x 3 spine dots, 2 heads x 2 crest dots
  assert.ok(dots >= 6 * 7 + 2 * 4 * 3 + 4, 'dots ' + dots);
  const S = sim.ctx, r = ribbon(sim, 0);
  for (let k = 4; k >= 0; k--) S.kill(r[k]);
  enemiesZ2Layer.draw(R, sim, 0.5);
  assert.ok(texts.includes('UNSPOOLED'));
});

// ---------- review fixes (cold review) ----------
test('head killed on entry: segments not yet on screen enter on their own as lone Eels and can still be scored', () => {
  const sim = createSim({ seed: 2, mode: 'stage7' }), S = sim.ctx;
  S.god = true;
  const r = ribbon(sim, 0), h = r[0];
  while (!(h.st === 'path' && h.y > 0)) step(sim);
  assert.ok(r.slice(1).every(e => e.st === 'wait'), 'segments still waiting');
  S.kill(h);
  const seen = [false, false, false, false, false];
  for (let f = 0; f < 1500; f++) {
    step(sim);
    r.forEach((e, k) => { if (k && !e.dead && e.y > 0 && e.y < 300 && e.x > 0 && e.x < 400) seen[k] = true; });
    if (r.slice(1).every(e => e.st === 'form')) break;
  }
  for (let k = 1; k < 5; k++) {
    assert.ok(seen[k], 'segment ' + k + ' came on screen');
    assert.equal(r[k].ek, -1, 'lone');
    assert.equal(r[k].st, 'form', 'segment ' + k + ' joined the formation');
  }
  const s0 = S.score; S.kill(r[1]); assert.ok(S.score > s0, 'and scores');
});

test('B.5 diver cap: a ribbon only dives when all its members fit; otherwise the pick is dropped', () => {
  const sim = toFull(createSim({ seed: 4, mode: 'stage7' })), S = sim.ctx;
  S.god = true;
  const cap = S.maxDivers(sim.enemies.length), r = ribbon(sim, 0);
  // one core diver already out: 1 + 5 > cap (4 here), so the ribbon must not go
  assert.equal(cap, 4);
  const other = sim.enemies.find(e => e.st === 'form' && e.type === 'moth');
  other.st = 'tele'; other.tele = 20; other.teleSide = 1; other.teleOff = 0;
  const h = r[0]; h.st = 'tele'; h.tele = 20; h.teleSide = 1; h.teleOff = 0;
  step(sim);
  assert.equal(h.st, 'form', 'pick dropped');
  assert.ok(r.slice(1).every(e => e.st === 'form'), 'segments stay resting');
});

test('B.5 diver cap holds whenever a ribbon launches in play (stages 7 and 8)', () => {
  let launches = 0;
  for (const [mode, seed] of [['stage7', 4], ['stage7', 12], ['stage8', 13], ['stage8', 14]]) {
    const sim = createSim({ seed, mode }), S = sim.ctx, stage0 = sim.stage;
    S.god = true;
    const was = new Map();
    for (let f = 0; f < 7000 && sim.stage === stage0 && !sim.done; f++) {
      sim.step(packWord(((f >> 6) & 1) ? 1 : -1, true, f % 9 === 0, false, false, 0)); sim.clearEvents();
      for (const e of sim.enemies) {
        if (e.type === 'eel' && e.ek === 0) {
          const t = e.st === 'tele' && e.etl === 1;
          if (t && !was.get(e)) {
            launches++;
            let d = 0; for (const o of sim.enemies) if (!o.dead && (o.st === 'tele' || o.st === 'dive' || o.st === 'spark')) d++;
            assert.ok(d <= S.maxDivers(sim.enemies.length), `${mode} f${f}: ${d} divers with the ribbon, cap ${S.maxDivers(sim.enemies.length)}`);
          }
          was.set(e, t);
        }
      }
    }
  }
  assert.ok(launches >= 2, 'ribbons launched: ' + launches);
});

test('hunting bends the dive: a head steers its path toward a wingman that moved away, by more than the base path', () => {
  const run = withWing => {
    const sim = toFull(createSim({ seed: 9, mode: 'stage7' })), S = sim.ctx;
    S.god = true;
    if (withWing) addWing(sim, 17);
    const h = diveRibbon(sim, 0, 1);
    while (h.st !== 'dive') step(sim);
    let minD = Infinity, maxOff = 0, wx = 0;
    for (let f = 0; f < 400 && h.st === 'dive'; f++) {
      S.player.x = 330; // the ship (and its wingman) slide far right after the dive was aimed
      step(sim);
      maxOff = Math.max(maxOff, h.eoff);
      if (S.wing.length) { wx = S.wing[0].x; if (h.y > 230 && h.y < S.wing[0].y) minD = Math.min(minD, Math.abs(h.x - wx)); }
    }
    return { minD, maxOff };
  };
  const hunt = run(true), plain = run(false);
  assert.equal(plain.maxOff, 0, 'no wingman: no bend');
  assert.ok(hunt.maxOff > 30, 'the head bends more than 30 units toward the wingman: ' + hunt.maxOff);
  assert.ok(hunt.minD < 12, 'and closes on it: ' + hunt.minD);
  assert.equal(HUNT_Y, 110);
});

// a shot of a given power right under a glowing, down-facing Prism
function powerShot(pw, pierce, hit) {
  const sim = toFull(createSim({ seed: 3, mode: 'stage6' })), S = sim.ctx;
  const p = sim.enemies.find(e => e.type === 'prism' && e.st === 'form');
  for (const e of sim.enemies) if (e !== p && e.st === 'form' && Math.abs(e.x - p.x) < 10 && e.y > p.y) e.dead = true;
  while (prismT(p) >= 40) step(sim);
  p.pfa = 0;
  const sh = sim.ps[0]; sh.on = true; sh.x = sh.px = p.x; sh.y = sh.py = p.y + 9; sh.vx = 0; sh.vy = -6.5; sh.pw = pw; sh.pierce = pierce; sh.hit = hit; sh.l1 = sh.l2 = null;
  const h0 = S.hits, hp = p.hp;
  step(sim);
  return { sh, p, dh: S.hits - h0, dhp: hp - p.hp };
}
test('Prism deflects a LANCE shot regardless of pierce: gone, no hit, no damage', () => {
  for (const hit of [false, true]) {
    const o = powerShot('lance', 3, hit);
    assert.equal(o.sh.on, false); assert.equal(o.dh, 0); assert.equal(o.dhp, 0);
  }
});
test('Prism deflects an ECHO shot: gone, no hit, no damage', () => {
  const o = powerShot('echo', 0, false);
  assert.equal(o.sh.on, false); assert.equal(o.dh, 0); assert.equal(o.dhp, 0);
});
test('LANCE in play: pressing fire under a glowing Prism with LANCE held gives deflects and no hits on it', () => {
  const sim = createSim({ seed: 3, mode: 'stage6' }), S = sim.ctx;
  S.god = true; toFull(sim); S.setPower('lance'); // god first: the ship must still be flying
  assert.equal(sim.state, 'play');
  const p = sim.enemies.find(e => e.type === 'prism' && e.st === 'form');
  for (const e of sim.enemies) if (e !== p && e.st === 'form' && Math.abs(e.x - p.x) < 10 && e.y > p.y) e.dead = true;
  while (prismT(p) >= 10) step(sim);
  const d0 = S.prismDeflects | 0, h0 = S.hits, hp = p.hp;
  // the formation sways while the shot climbs, so keep the shots in the Prism's column (the test is about the hit, not aim)
  for (let f = 0; f < 60 && p.st === 'form'; f++) { S.player.x = p.x; p.pfa = 0; for (const q of sim.ps) if (q.on) q.x = p.x; step(sim, 1, packWord(0, true, f === 0, false, false, 0)); }
  assert.ok((S.prismDeflects | 0) > d0, 'deflected');
  assert.equal(p.hp, hp); assert.equal(p.hurt, false, 'the Prism never took a LANCE hit'); void h0; // (a diver crossing the column may take a hit)
});
