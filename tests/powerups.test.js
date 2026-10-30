// S4 power-ups (design.md B.2): the Lamplighter, the glyph cycle and catch, the mercy rule,
// and each power's effect and cost (FAN, LANCE, HALO, ECHO).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSim } from '../games/starfall/sim.js';
import { enemyTypes, powerups, TYPE_IDS } from '../games/starfall/sim/registry.js';
import { systems } from '../games/starfall/sim/systems.js';
import { layers } from '../games/starfall/render/layers.js';
import { POWER_IDS, POWERS, glyphType, dropGlyph, GLYPH_CYCLE, FAN_SPEED, LANCE_GAP, HALO_SPEED, ECHO_DELAY } from '../games/starfall/sim/powerups.js';
import { packWord } from '../engine/input-word.js';

const IDLE = 128, FIRE = IDLE | (1 << 9), PRESS = FIRE | (1 << 10), RIGHT = packWord(1, false, false, false, false, 0);
const step = (sim, n = 1, w = IDLE) => { for (let i = 0; i < n && !sim.done; i++) { sim.step(w); sim.clearEvents(); } return sim; };
const toPlay = sim => { while (sim.state !== 'play') step(sim); return sim; };
// a test field: every enemy removed except one parked far off (so the stage does not clear)
function bare(seed = 1, mode = 'stage2') {
  const sim = toPlay(createSim({ seed, mode })), S = sim.ctx;
  S.clearEnemies();
  const k = S.mkEnemy('moth', -1, -1); k.st = 'wait'; k.delay = 1e9; S.enemies.push(k);
  return { sim, S };
}
function place(S, type, x, y, st = 'dive') {
  const e = S.mkEnemy(type, -1, -1); e.st = st; e.x = e.px = x; e.y = e.py = y; e.noReturn = true;
  if (st === 'dive') { e.path = { L: [0, 1e9], K: [0], len: 1e9, m: 2, p: [x, y, x, y] }; e.spd = 0; }
  S.enemies.push(e); return e;
}
const liveShots = sim => sim.ps.filter(p => p.on);

// ---------- registration and the Lamplighter ----------
test('Lamplighter, the four powers, the system and the layer are registered', () => {
  const L = enemyTypes.lamplighter;
  assert.ok(L); assert.equal(L.hp, 1); assert.equal(L.form, 300); assert.equal(L.dive, 600);
  assert.equal(L.ti, TYPE_IDS.indexOf('lamplighter'));
  assert.equal(typeof L.draw, 'undefined', 'sim def is plain data (drawing lives in render/powerups.js)');
  assert.deepEqual(Object.keys(powerups).sort(), ['echo', 'fan', 'halo', 'lance']);
  assert.deepEqual(POWER_IDS, ['fan', 'lance', 'halo', 'echo']);
  assert.ok(systems.some(s => s.id === 'powerups'));
  assert.ok(layers.findIndex(l => l.id === 'powerups') > layers.findIndex(l => l.id === 'enemies'));
  assert.ok(layers.findIndex(l => l.id === 'powerups') < layers.findIndex(l => l.id === 'player'));
});

test('one Lamplighter per normal stage from stage 2, 4th member of entry group 3; none in stage 1', () => {
  assert.equal(createSim({ seed: 3, mode: 'stage1' }).enemies.filter(e => e.type === 'lamplighter').length, 0);
  for (const st of [2, 3, 6, 13, 17]) {
    const L = createSim({ seed: 3, mode: 'stage' + st }).enemies.filter(e => e.type === 'lamplighter');
    assert.equal(L.length, 1, 'stage ' + st);
    assert.equal(L[0].r, 2); assert.equal(L[0].c, 3); assert.equal(L[0].group, 2);
  }
});

test('killing the Lamplighter drops a glyph at its spot with the stage start type; other kills do not', () => {
  const { sim, S } = bare(5);
  const m = place(S, 'moth', 100, 100); S.kill(m);
  assert.equal(S.glyph.on, false);
  const L = place(S, 'lamplighter', 150, 90, 'form');
  const before = sim.score; S.kill(L);
  assert.equal(sim.score - before, 300, 'formation value');
  assert.equal(S.glyph.on, true); assert.equal(S.glyph.x, 150); assert.equal(S.glyph.y, 90);
  assert.equal(glyphType(S.glyph), POWER_IDS[S.glyphStart]);
});

// ---------- glyph cycle, fall, catch ----------
test('glyph cycles FAN, LANCE, HALO, ECHO every 45 frames and falls at 0.8 per frame', () => {
  const { sim, S } = bare(1);
  dropGlyph(S, 50, 10, 0);
  const seen = [];
  for (let f = 0; f <= 180; f++) { if (f % GLYPH_CYCLE === 0) seen.push(glyphType(S.glyph)); if (f < 180) step(sim); }
  assert.deepEqual(seen, ['fan', 'lance', 'halo', 'echo', 'fan']);
  assert.ok(Math.abs(S.glyph.y - (10 + 180 * 0.8)) < 1e-9);
  // the type changes exactly on the 45th frame
  const g = S.glyph; g.t = 44; assert.equal(glyphType(g), 'fan'); g.t = 45; assert.equal(glyphType(g), 'lance');
});

test('glyph cycle and fall freeze during hit-stop', () => {
  const { sim, S } = bare(1);
  dropGlyph(S, 50, 10, 0);
  S.addHitstop(8); step(sim, 8);
  assert.equal(S.glyph.t, 0); assert.equal(S.glyph.y, 10);
  step(sim); assert.equal(S.glyph.t, 1);
});

test('catch by touch (radius 8): power set, 500 flat; shots pass through it; a missed glyph is gone', () => {
  const { sim, S } = bare(1);
  dropGlyph(S, sim.player.x, sim.player.y - 20, 1);
  step(sim, 3, PRESS);   // shooting it does nothing
  assert.equal(S.glyph.on, true); assert.equal(sim.hits, 0);
  const before = sim.score;
  for (let i = 0; i < 120 && S.glyph.on; i++) step(sim);
  assert.equal(S.glyph.on, false); assert.equal(S.power, 'lance');
  assert.equal(sim.score - before, 500);
  // stage 17 (loop 1): flat bonus x loop factor 1.25
  const b = bare(1, 'stage17');
  dropGlyph(b.S, b.sim.player.x, b.sim.player.y - 2, 0);
  const s0 = b.sim.score; step(b.sim);
  assert.equal(b.sim.score - s0, 625);
  // missed: dropped far from the ship, it falls off the bottom
  dropGlyph(S, 20, 200, 0); sim.player.x = 300;
  step(sim, 200);
  assert.equal(S.glyph.on, false); assert.equal(S.power, 'lance', 'unchanged');
});

test('one power at a time: a new catch replaces the old; death removes it', () => {
  const { sim, S } = bare(1);
  S.setPower('fan'); assert.equal(S.power, 'fan');
  dropGlyph(S, sim.player.x, sim.player.y - 2, 3); step(sim);
  assert.equal(S.power, 'echo');
  assert.equal(S.setPower('nope'), false); assert.equal(S.power, 'echo');
  S.playerDie(); assert.equal(S.power, '');
});

// ---------- start type and mercy ----------
test('start type is rng.int(4) at stage setup: same seed same type, and seeds differ', () => {
  const t = s => createSim({ seed: s, mode: 'stage2' }).ctx.glyphStart;
  assert.equal(t(7), t(7));
  const set = new Set(); for (let s = 1; s <= 40; s++) set.add(t(s));
  assert.equal(set.size, 4);
});

test('mercy rule: a death in the previous stage makes the next start type HALO', () => {
  // find seeds whose stage-3 start is not HALO without a death, then die in stage 2 and clear it
  let checked = 0;
  for (let seed = 1; seed <= 30 && checked < 3; seed++) {
    const clean = createSim({ seed, mode: 'stage2' }); toPlay(clean);
    clean.ctx.clearEnemies(); step(clean, 200);
    assert.equal(clean.stage, 3);
    if (clean.ctx.glyphStart === 2) continue;
    const died = createSim({ seed, mode: 'stage2' }); toPlay(died);
    died.ctx.playerDie(); step(died, 210);
    assert.equal(died.state, 'play');
    died.ctx.clearEnemies(); step(died, 200);
    assert.equal(died.stage, 3);
    assert.equal(died.ctx.glyphStart, 2, 'HALO after a death (seed ' + seed + ')');
    checked++;
  }
  assert.equal(checked, 3);
  // the rule looks at the previous stage only: die in stage 16, clean stage 17, and stage 18 is not forced to HALO
  const starts = new Set();
  for (let seed = 1; seed <= 8; seed++) {
    const sim = createSim({ seed, mode: 'stage16' }); toPlay(sim);
    sim.ctx.playerDie(); step(sim, 210); sim.ctx.clearEnemies(); step(sim, 200);
    assert.equal(sim.stage, 17); assert.equal(sim.ctx.glyphStart, 2, 'mercy in stage 17');
    toPlay(sim); sim.ctx.clearEnemies(); step(sim, 200);
    assert.equal(sim.stage, 18); assert.equal(sim.deaths, 1);
    starts.add(sim.ctx.glyphStart);
  }
  assert.ok(starts.size > 1, 'stage 18 starts vary: ' + [...starts]);
});

// ---------- FAN ----------
test('FAN: 3 shots at -12, 0, +12 degrees at speed 5.0; cap stays 2 volleys; side shots count as fired', () => {
  const { sim, S } = bare(1);
  S.setPower('fan');
  step(sim, 1, PRESS);
  const v = liveShots(sim);
  assert.equal(v.length, 3); assert.equal(sim.shotsFired, 3);
  const sp = v.map(p => Math.hypot(p.vx, p.vy));
  for (const s of sp) assert.ok(Math.abs(s - FAN_SPEED) < 1e-9, 'speed ' + s);
  const deg = v.map(p => Math.round(Math.atan2(p.vx, -p.vy) * 180 / Math.PI)).sort((a, b) => a - b);
  assert.deepEqual(deg, [-12, 0, 12]);
  step(sim, 1, PRESS); assert.equal(liveShots(sim).length, 6);
  step(sim, 1, PRESS); assert.equal(liveShots(sim).length, 6, 'third volley blocked by the 2-volley cap');
  // slower than the base shot (6.5): the volley stays on screen longer
  const base = bare(1); step(base.sim, 1, PRESS);
  let fFan = 0, fBase = 0;
  while (liveShots(sim).length) { step(sim); fFan++; }
  while (liveShots(base.sim).length) { step(base.sim); fBase++; }
  assert.ok(fFan > fBase, `fan ${fFan} vs base ${fBase} frames`);
});

test('FAN: a volley holds its cap slot while any of its shots is alive', () => {
  const { sim, S } = bare(1);
  S.setPower('fan');
  step(sim, 1, PRESS); step(sim, 1, PRESS);
  const first = liveShots(sim).filter(p => p.vol === sim.ps.find(q => q.on).vol);
  assert.equal(first.length, 3);
  first[1].on = false; first[2].on = false;     // two of the first volley gone, one left
  step(sim, 1, PRESS);
  assert.equal(liveShots(sim).length, 4, 'still 2 volleys in flight: no new volley');
  first[0].on = false;
  step(sim, 1, PRESS);
  assert.equal(liveShots(sim).length, 6, 'first volley gone: a new volley fires');
});

// ---------- LANCE ----------
test('LANCE: one shot hits up to 3 enemies in a line, counts one hit for accuracy, kills marked lance', () => {
  const { sim, S } = bare(1);
  S.setPower('lance');
  const x = sim.player.x, col = [200, 175, 150, 125].map(y => place(S, 'moth', x, y));
  const tags = [];
  const sys = { id: 't', init() {}, step() {}, onEvent(S2, ev) { if (ev.type === 'kill') tags.push(S2.hitBy); } };
  systems.push(sys);
  try {
    step(sim, 1, PRESS);
    for (let i = 0; i < 60; i++) step(sim);
  } finally { systems.splice(systems.indexOf(sys), 1); }
  assert.deepEqual(col.map(e => e.dead), [true, true, true, false], 'the 4th enemy survives');
  assert.deepEqual(tags, ['lance', 'lance', 'lance']);
  assert.equal(sim.hits, 1); assert.equal(sim.shotsFired, 1);
  assert.equal(S.hitBy, '', 'cleared after the kill');
});

test('LANCE: a 2-hp enemy takes one hit per lance shot, and the shot flies on', () => {
  const { sim, S } = bare(1);
  S.setPower('lance');
  const w = place(S, 'warden', sim.player.x, 180), m = place(S, 'moth', sim.player.x, 130);
  step(sim, 1, PRESS); for (let i = 0; i < 40; i++) step(sim);
  assert.equal(w.hp, 1); assert.equal(w.dead, false); assert.equal(m.dead, true);
});

test('LANCE: refire every 24 frames instead of 10', () => {
  // frame of the second shot while fire is held (the cap is not binding yet)
  const second = power => {
    const { sim, S } = bare(1); if (power) S.setPower(power);
    step(sim, 1, PRESS);
    for (let f = 1; f < 100; f++) { step(sim, 1, FIRE); if (sim.shotsFired === 2) return f; }
    return -1;
  };
  assert.equal(LANCE_GAP, 24);
  assert.equal(second('lance'), 24);
  assert.equal(second(''), 10);
  assert.equal(second('halo'), 10);
});

// ---------- HALO ----------
test('HALO: absorbs 3 enemy bullets, then it is gone and the next bullet kills', () => {
  const { sim, S } = bare(1);
  S.setPower('halo'); assert.equal(S.power, 'halo'); // what sim/score.js reads to turn grazing off
  const P = sim.player;
  for (let k = 0; k < 3; k++) {
    const b = S.takeBullet(); b.on = true; b.x = b.px = P.x; b.y = b.py = P.y - 12; b.vx = 0; b.vy = 2;
    step(sim, 3);
    assert.equal(P.alive, true, 'absorb ' + (k + 1)); assert.equal(b.on, false);
  }
  assert.equal(S.power, ''); assert.ok(S.haloLostT > 0 && S.haloLostT < 24, 'the lost-it cue is running');
  const b = S.takeBullet(); b.on = true; b.x = b.px = P.x; b.y = b.py = P.y - 6; b.vx = 0; b.vy = 2;
  step(sim, 4);
  assert.equal(P.alive, false);
});

test('HALO: one body hit uses the whole ring; the ship slows to 2.3', () => {
  const { sim, S } = bare(1);
  S.setPower('halo');
  for (let i = 0; i < 60; i++) step(sim, 1, RIGHT);
  assert.ok(Math.abs(sim.player.vx - HALO_SPEED) < 1e-3, 'vx ' + sim.player.vx);
  sim.player.x = 200;
  const e = place(S, 'moth', 200, sim.player.y);
  step(sim);
  assert.equal(e.dead, true); assert.equal(sim.player.alive, true); assert.equal(S.power, '');
  const f = bare(1); for (let i = 0; i < 60; i++) step(f.sim, 1, RIGHT);
  assert.ok(Math.abs(f.sim.player.vx - 2.7) < 1e-3, 'base speed 2.7');
});

// ---------- ECHO ----------
test('ECHO: every shot fires again from the same spot 20 frames later', () => {
  const { sim, S } = bare(1);
  S.setPower('echo');
  const x0 = sim.player.x, y0 = sim.player.y - 8;
  step(sim, 1, PRESS);
  assert.equal(liveShots(sim).length, 1); assert.equal(S.echoN, 1);
  let f = 0;   // the ship moves away while the echo waits; the echo does not follow
  const S2 = bare(1); S2.S.setPower('echo'); step(S2.sim, 1, PRESS);
  while (S2.S.echoN) { step(S2.sim, 1, RIGHT); f++; }
  assert.equal(f, ECHO_DELAY);
  const echo = S2.sim.ps.find(p => p.on && p.pw === 'echo');
  assert.ok(echo); assert.equal(echo.x, x0); assert.equal(echo.y, y0, 'spawned at the original spot');
  assert.notEqual(S2.sim.player.x, x0);
  assert.equal(S2.sim.shotsFired, 2);
});

test('ECHO: waiting and flying echoes count against the 2-shot cap (fresh fire roughly halved)', () => {
  const run = power => { const { sim, S } = bare(1); if (power) S.setPower(power); step(sim, 1, PRESS); step(sim, 599, FIRE); return sim.shotsFired; };
  const { sim, S } = bare(1);
  S.setPower('echo');
  step(sim, 1, PRESS); step(sim, 1, PRESS);
  assert.equal(liveShots(sim).length, 1, 'second press blocked: shot + pending echo fill the cap');
  const base = run(''), echo = run('echo');
  // echo total = fresh + echoes; fresh = echo / 2, roughly half the base rate
  const fresh = echo / 2;
  assert.ok(fresh < base * 0.65 && fresh > base * 0.35, `fresh ${fresh} vs base ${base}`);
});

test('death clears pending echoes', () => {
  const { sim, S } = bare(1);
  S.setPower('echo'); step(sim, 1, PRESS);
  assert.equal(S.echoN, 1);
  S.playerDie(); assert.equal(S.echoN, 0); assert.equal(S.power, '');
});

// ---------- determinism ----------
test('power state is in the hash, and powered runs stay deterministic', () => {
  const a = createSim({ seed: 9, mode: 'stage2' }), b = createSim({ seed: 9, mode: 'stage2' });
  assert.equal(a.stateHash(), b.stateHash());
  a.ctx.setPower('fan');
  assert.notEqual(a.stateHash(), b.stateHash());
  b.ctx.setPower('fan');
  for (let i = 0; i < 2000; i++) { const w = i % 7 < 3 ? FIRE : (i % 13 < 6 ? RIGHT : IDLE); a.step(w); b.step(w); }
  assert.equal(a.stateHash(), b.stateHash());
  for (const id of POWER_IDS) assert.equal(POWERS[id].id, id);
});

// ---------- B.2 numbers as literals (review: kill mutants of the imported constants) ----------
import { SFX_ID, EV_SFX } from '../games/starfall/defs.js';

test('B.2 literal: a glyph is caught within 8 units (7.5 away: caught; 8.5 away: never)', () => {
  const near = bare(1), far = bare(1);
  for (const [b, dx, want] of [[near, 7.5, 'fan'], [far, 8.5, '']]) {
    const P = b.sim.player;
    dropGlyph(b.S, P.x + dx, P.y - 0.8, 0);   // after one 0.8 fall it is level with the ship, dx away; then it falls away
    step(b.sim, 60);
    assert.equal(b.S.power, want, 'dx ' + dx);
  }
});

test('B.2 literal: HALO ship speed is 2.3 units per frame (base 2.7)', () => {
  const { sim, S } = bare(1);
  S.setPower('halo'); sim.player.x = 60;
  step(sim, 40, RIGHT);
  const x0 = sim.player.x; step(sim, 10, RIGHT);
  assert.ok(Math.abs((sim.player.x - x0) / 10 - 2.3) < 1e-3, 'speed ' + (sim.player.x - x0) / 10);
});

test('B.2 literal: the HALO ring absorbs inside 9 units only (8.5: absorbed; 9.5: passes untouched)', () => {
  const pass = dx => {
    const { sim, S } = bare(1); S.setPower('halo');
    const P = sim.player, b = S.takeBullet();
    b.on = true; b.x = b.px = P.x + dx; b.y = b.py = P.y - 30; b.vx = 0; b.vy = 2;
    step(sim, 40);
    return S.haloHits;
  };
  assert.equal(pass(8.5), 2);
  assert.equal(pass(9.5), 3);
});

test('B.2 literal: ECHO fires exactly 20 frames after its shot', () => {
  const { sim, S } = bare(1); S.setPower('echo');
  step(sim, 1, PRESS);
  for (let f = 1; f <= 19; f++) { step(sim); assert.equal(sim.shotsFired, 1, 'frame ' + f); }
  step(sim); assert.equal(sim.shotsFired, 2, 'frame 20');
});

test('LANCE refire is strict: mashing fire every 5 frames cannot beat the 24-frame gap', () => {
  const { sim, S } = bare(1); S.setPower('lance');
  const fired = [];
  for (let f = 0; f < 240; f++) { const n = sim.shotsFired; step(sim, 1, f % 5 === 0 ? PRESS : FIRE); if (sim.shotsFired > n) fired.push(f); }
  assert.ok(fired.length >= 5, 'fired ' + fired.length);
  for (let i = 1; i < fired.length; i++) assert.ok(fired[i] - fired[i - 1] >= 24, `gap ${fired[i] - fired[i - 1]} at ${fired[i]}`);
  // other powers keep v1 press behavior: a press fires at once
  const b = bare(1); b.S.setPower('fan'); step(b.sim, 1, PRESS); step(b.sim, 3); step(b.sim, 1, PRESS);
  assert.equal(b.sim.shotsFired, 6);
});

test('sounds: catch plays powerup; death and a used-up HALO play powerdown', () => {
  assert.ok(SFX_ID.powerup >= 0 && SFX_ID.powerdown >= 0);
  const sfxOf = sim => { const out = []; sim.drain((buf, o) => { if (buf[o] === EV_SFX) out.push(buf[o + 1]); }); return out; };
  const { sim, S } = bare(1);
  sim.clearEvents(); dropGlyph(S, sim.player.x, sim.player.y - 2, 0); sim.step(IDLE);
  assert.ok(sfxOf(sim).includes(SFX_ID.powerup));
  S.playerDie(); assert.ok(sfxOf(sim).includes(SFX_ID.powerdown));
  const h = bare(1); h.S.setPower('halo'); h.S.haloHits = 1;
  const P = h.sim.player, bl = h.S.takeBullet();
  bl.on = true; bl.x = bl.px = P.x; bl.y = bl.py = P.y - 12; bl.vx = 0; bl.vy = 2;
  h.sim.clearEvents(); for (let i = 0; i < 3; i++) h.sim.step(IDLE);
  assert.equal(h.S.power, ''); assert.ok(sfxOf(h.sim).includes(SFX_ID.powerdown));
  assert.ok(h.S.haloLostT > 0 && h.S.haloLostT <= 24);
});
