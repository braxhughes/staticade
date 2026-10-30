// The v1 formation: entry groups and paths, formation slots (breathe + sway), dive picking and the dive timer.
// B.11 levers that live here (slice V1; numbers and the lever table in sim/twists.js):
//   Weave (1.0)  slot(): on stage row 2, row 3 x += wv and row 4 x -= wv
//   Pincer (1.1) pickDiver(): on stage row 3, every 3rd launch may be a mirrored pair with one shot between them
//   Hunt (2.2)   pickDiver(): once the ship has stayed in its band 150 twist steps, the launch takes the nearest enemy
// Every function takes the sim context S (see sim.js). Pure and allocation-free per frame.
import { CX, W, H, ROWS, GROUPS, CP_TOP, CP_SIDE, CP_TOP_LOOP, CP_SIDE_LOOP, SFX_ID } from '../defs.js';
import { sin } from '../../../engine/dmath.js';
import { buildPath, fit, mirror, clamp } from '../sim-path.js';
import { slotType } from './stages.js';
import { diveShots } from './difficulty.js';
import { TELE_DIVE, TELE_WARDEN } from './feel.js';
import { leverOf, weaveOffset, huntReady, PINCER_EVERY, PINCER_TYPES } from './twists.js';
import { headOf } from './enemies/eel.js';

// entry variety: each group's path is rebuilt per stage with random mirroring, loop size and speed
function variedPath(path, cp, ctr, k, mir) {
  const out = cp.slice();
  for (let i = 6; i < out.length; i += 2) { out[i] = ctr[0] + (out[i] - ctr[0]) * k; out[i + 1] = ctr[1] + (out[i + 1] - ctr[1]) * k; }
  const f = fit(out);
  return buildPath(path, mir ? mirror(f) : f);
}

export function setupFormation(S) {
  const rnd = S.rnd, entryInfo = S.entryInfo, entryPaths = S.entryPaths;
  for (let gi = 0; gi < GROUPS.length; gi++) {
    const G = GROUPS[gi], V = entryInfo[gi];
    const mir = rnd() < 0.5, k = 0.8 + rnd() * 0.45, spd = 0.85 + rnd() * 0.3;
    const top = G.path === 'PAIR' || G.path[0] === 'T', cp = top ? CP_TOP : CP_SIDE, ctr = top ? CP_TOP_LOOP : CP_SIDE_LOOP;
    const right = G.path[1] === 'R';
    V.mir = mir; V.loop = Math.round(k * 100) / 100; V.spd = Math.round(spd * 100) / 100;
    V.a = variedPath(entryPaths[gi * 2], cp, ctr, k, G.path !== 'PAIR' && right !== mir);
    V.b = G.path === 'PAIR' ? variedPath(entryPaths[gi * 2 + 1], cp, ctr, k, true) : null;
  }
  for (let gi = 0; gi < GROUPS.length; gi++) {
    const G = GROUPS[gi], V = entryInfo[gi];
    let lead = false;
    for (let j = 0; j < G.slots.length; j++) {
      const r = G.slots[j][0], c = G.slots[j][1];
      const e = S.mkEnemy(slotType(S.row, r, c), r, c);
      e.path = V.b ? ((j % 2 === 0) !== V.mir ? V.a : V.b) : V.a;
      e.delay = 30 + gi * 165 + (G.path === 'PAIR' ? (j >> 1) * 10 : j * 9);
      e.spd = S.D.entry * V.spd;
      // group leader: the first member in entry order that is not a Warden (Wardens never lead)
      e.group = gi;
      if (!lead && e.type !== 'warden') { e.leader = true; lead = true; }
      S.enemies.push(e);
    }
  }
}

// formation slot (r, c) at the current formation time; result in S.SX, S.SY
export function slot(S, r, c) {
  const n = ROWS[r];
  const br = S.formFull ? (sin(S.formT * (S.zone === 3 ? 0.045 : 0.03)) * 0.5 + 0.5) * 0.14 : 0;
  S.SX = CX + (c - (n - 1) / 2) * 24 * (1 + br) + sin(S.formT * 0.017) * (S.formFull ? 4 : 16);
  if (S.zone === 2) S.SX += sin(S.formT * 0.02 + r * 0.9) * 10; // Z2 tide sway (B.3): each row rides a phase-shifted wave
  S.SY = 34 + r * 16 * (1 + br * 0.6) + sin(S.formT * 0.07 + c * 0.8) * 1.3;
  if (r >= 3 && S.row === 2) { const wv = weaveOffset(S); S.SX += r === 3 ? wv : -wv; } // Weave (B.11 1.0)
}

const cxl = v => clamp(v, 8, W - 8);
export function startDive(S, e, side, offx) {
  const player = S.player, px = clamp(player.x, 40, W - 40), x = e.x, y = e.y, q = H / 320, c = S.diveCp;
  c[0] = x; c[1] = y; c[2] = cxl(x + side * 14); c[3] = y - 16; c[4] = cxl(x + side * 30); c[5] = y - 4; c[6] = cxl(x + side * 28); c[7] = y + 24;
  c[8] = cxl(x + side * 6); c[9] = y + 60; c[10] = cxl(px - side * 40 + offx); c[11] = 170 * q; c[12] = cxl(px + side * 14 + offx); c[13] = 236 * q;
  c[14] = cxl(px - side * 26 + offx); c[15] = 300 * q; c[16] = cxl(px - side * 54 + offx); c[17] = H + 32;
  e.path = buildPath(e.dpath, c); e.dist = 0; e.idx = 0; e.st = 'dive'; e.spd = S.diveSpd();
  e.fireCd = 15 + S.rnd() * 40; e.shots = diveShots(S.D, S.rnd);
  // Pincer (B.11 1.1): the shots are drawn as usual (same stream use), then the pair shares one shot
  if (e.pin) { e.shots = e.pin === 1 ? 1 : 0; e.pin = 0; }
  e.hunt = 0; // the Hunt mark lasts for the telegraph only
}

// dive telegraph (B.9): the diver glows in its slot for TELE_DIVE frames (a Warden and its escorts TELE_WARDEN),
// then leaves on the dive path (see the 'tele' state in sim.js)
function telegraph(e, frames, side, offx) { e.st = 'tele'; e.tele = frames; e.teleSide = side; e.teleOff = offx; }

// Hunt target (B.11 2.2): the 'form' candidate nearest the ship in x; ties go to the larger r, then the smaller c
function huntTarget(cand, nc, px) {
  let best = null, bd = Infinity;
  for (let i = 0; i < nc; i++) {
    const o = cand[i];
    if (o.dead) continue;
    const d = Math.abs(o.x - px);
    if (best === null || d < bd || (d === bd && (o.r > best.r || (o.r === best.r && o.c < best.c)))) { best = o; bd = d; }
  }
  return best;
}
// Pincer mirror (B.11 1.1): the live 'form' moth, wisp or splitter in slot (r, ROWS[r] - 1 - c), or null
function pincerMate(S, e) {
  if (!PINCER_TYPES[e.type] || e.r < 0 || e.r >= ROWS.length) return null;
  const en = S.enemies, mc = ROWS[e.r] - 1 - e.c;
  let m = null, divers = 0;
  for (let i = 0; i < en.length; i++) {
    const o = en[i];
    if (o.dead) continue;
    if (o.st === 'tele' || o.st === 'dive' || o.st === 'spark') divers++;
    else if (o !== e && o.st === 'form' && o.r === e.r && o.c === mc && PINCER_TYPES[o.type]) m = o;
  }
  return m && divers + 2 <= S.maxDivers(en.length) ? m : null;
}

export function pickDiver(S) {
  const cand = S.cand, enemies = S.enemies;
  let nc = 0;
  for (const e of enemies) if (e.st === 'form') cand[nc++] = e;
  if (!nc) return;
  let e = cand[S.rnd() * nc | 0]; // a Hunt launch draws this same one rnd() and replaces the pick (cut box LOW)
  const hunt = huntReady(S);
  if (hunt) {
    const h = huntTarget(cand, nc, S.player.x);
    if (h) e = h;
    S.huntN = 0; S.huntC = S.player.x;
    S.sfx(SFX_ID.hunt);
  }
  // a pick on an Eel segment dives from its head (eel.js), so the Hunt mark goes on the head
  const hd = e.type === 'eel' && e.ek > 0 ? headOf(S, e) : null;
  e.hunt = hunt && !hd ? 1 : 0;
  if (hd && hd.st === 'form') hd.hunt = hunt ? 1 : 0;
  const side = e.x < CX ? -1 : 1;
  // Pincer (B.11 1.1): the counter advances on every launch, then every 3rd may pair (cut box LOW)
  let m = null;
  if (leverOf(S.row) === 'pincer') { S.pincerN++; if (S.pincerN % PINCER_EVERY === 0) m = pincerMate(S, e); }
  const T = e.type === 'warden' ? TELE_WARDEN : TELE_DIVE;
  telegraph(e, T, side, 0);
  if (m) { e.pin = 1; m.pin = 2; m.hunt = 0; telegraph(m, TELE_DIVE, -side, 0); }
  if (e.type === 'warden') {
    // the two nearest formation wisps of row 1 escort the warden (ties keep formation order)
    let e1 = null, e2 = null, d1 = Infinity, d2 = Infinity;
    for (const o of enemies) {
      if (o.st !== 'form' || o.r !== 1) continue;
      const d = Math.abs(o.x - e.x);
      if (d < d1) { e2 = e1; d2 = d1; e1 = o; d1 = d; } else if (d < d2) { e2 = o; d2 = d; }
    }
    if (e1) telegraph(e1, T, side, -14);
    if (e2) telegraph(e2, T, side, 14);
  }
  for (let i = 0; i < nc; i++) cand[i] = null;
}

// once per world update: formation-full check, then the dive timer
export function updFormation(S) {
  const enemies = S.enemies;
  if (!S.formFull && S.stageKind === 'normal') {
    let all = true;
    for (const e of enemies) if (!(e.st === 'form' || e.st === 'tele' || e.st === 'dive' || e.st === 'spark')) { all = false; break; }
    if (all) S.formFull = true;
  }
  if (S.state === 'play' && S.player.alive && S.stageKind === 'normal' && S.formFull) {
    const n = enemies.length;
    if (--S.diveTimer <= 0) {
      S.diveTimer = S.diveGap(n);
      let divers = 0; for (const e of enemies) if (e.st === 'tele' || e.st === 'dive' || e.st === 'spark') divers++;
      if (divers < S.maxDivers(n)) pickDiver(S);
    }
  }
}
