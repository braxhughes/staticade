// Lead aim (design.md B.11 2.1): aimed enemy shots land ahead of a moving ship.
// sim.js calls S.lead(S, e) inside startAim after the aim point is set to the ship and e.aimV to 1.2, and before
// the type's own aim hook (a hook that retargets wins, and sim.js puts aimV back to 1.2).
// Lead: T = max(20, (player.y - e.y) / bulletSpd()), lead = clamp(player.vx * (TELE_AIM + T) * k, -72, 72),
// aimX = clamp(player.x + lead, 10, 390). A shot with a lead may angle up to 1.6 sideways (e.aimV).
// k by zone (the row's zone, so endless follows 0.7): Z1 0, Z2 0.5, Z3 0.75.
// Boss volleys never come through startAim, so they never lead. aimV is hashed by the twist system (0.3).
// Pure: no DOM, Math.random or Date; no per-frame allocation.
import { W } from '../defs.js';
import { clamp } from '../sim-path.js';
import { TELE_AIM } from './feel.js';

export const LEAD_K = [0, 0, 0.5, 0.75];
export const LEAD_MAX = 72, LEAD_AIMV = 1.6;

function lead(S, e) {
  const k = LEAD_K[S.zone] || 0;
  if (k === 0) return;
  const p = S.player, T = Math.max(20, (p.y - e.y) / S.bulletSpd());
  const l = clamp(p.vx * (TELE_AIM + T) * k, -LEAD_MAX, LEAD_MAX);
  e.aimX = clamp(p.x + l, 10, W - 10); e.aimY = p.y;
  if (l !== 0) e.aimV = LEAD_AIMV;
}

export const aimSystem = {
  id: 'aim',
  init(S) { S.lead = lead; },
  step(S) {},
  onEvent(S, ev) {}
};
