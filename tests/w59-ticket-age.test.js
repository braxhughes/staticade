// the Daily ticket age rule is ON in the Worker as shipped. Through createWorker().fetch (real
// entry point, node:sqlite) with a clock the test moves and NO limits override, so the shipped LIMITS are what runs.
// A STACKLIGHT Daily and a Starfall Daily both go through it. Localhost only; the secret is random per run, never kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Rng, seedFromString } from '../engine/rng.js';
import { createSim as slSim, PH_PLAY } from '../games/stacklight/sim.js';
import { GAME_ID as SL_ID, GAME_VERSION as SL_VERSION, COLS, BAR, PLUS, ROT_H, ROT_V } from '../games/stacklight/defs.js';
import { columnHeight } from '../games/stacklight/sim/board.js';
import { GAME_ID as SF_ID, GAME_VERSION as SF_VERSION } from '../games/starfall/sim.js';
import { LIMITS } from '../server/worker.js';
import { TICKET_GRACE_S, TICKET_SLACK_S, ticketStale } from '../server/daily.js';
import { playScripted, makeEnv, post, createWorker } from '../server/fixtures.mjs';

const MIN = 60000;
const T0 = Date.parse('2026-11-07T10:00:00Z');
const SECRET = randomBytes(32).toString('hex');
// ms from ticket to the last moment a run of `frames` frames is still good: play time + grace + slack, exactly as the rule reads
const edgeMs = (frames) => Math.floor((frames / 60 + TICKET_GRACE_S + TICKET_SLACK_S) * 1000);
const playMs = (frames) => Math.ceil(frames / 60 * 1000);

// a STACKLIGHT word bot (the same placement rule as tests/server-stacklight.test.js, best placement, tap and hard drop)
function bestPlacement(sim, rng) {
  const h = []; for (let c = 0; c < COLS; c++) h.push(columnHeight(sim.grid, c));
  const type = sim.ctx.pType, cands = [];
  const add = (rot, col, adds) => {
    const n = h.slice();
    if (adds.length === 1) n[col] += 3; else { n[col - 1] += adds[0]; n[col] += adds[1]; n[col + 1] += adds[2]; }
    const lines = Math.min(...n), mx = Math.max(...n) - lines;
    let bump = 0; for (let c = 1; c < COLS; c++) bump += Math.abs(n[c] - n[c - 1]);
    cands.push({ rot, col, v: lines * 20 - mx * 4 - bump + rng.int(3) });
  };
  if (type === BAR) { for (let c = 1; c < COLS - 1; c++) add(ROT_H, c, [1, 1, 1]); for (let c = 0; c < COLS; c++) add(ROT_V, c, [3]); }
  else for (let c = 1; c < COLS - 1; c++) add(ROT_H, c, [1, 3, 1]);
  let best = cands[0]; for (const k of cands) if (k.v > best.v) best = k;
  return best;
}
function playSL(seed) {
  const sim = slSim({ seed, mode: 'daily' }), rng = new Rng(seedFromString('w59-test:1'));
  let plan = null, planned = -1, prev = 0, idle = 0, lastPx = -1;
  while (!sim.done) {
    const S = sim.ctx; let w = 0;
    if (S.phase === PH_PLAY) {
      if (S.spawned !== planned) { planned = S.spawned; plan = bestPlacement(sim, rng); idle = 0; lastPx = S.px; }
      if (S.pType !== PLUS && S.rot !== plan.rot && idle < 3) { w = prev & 64 ? 0 : 64; idle++; }
      else if (S.px !== plan.col && idle < 40) {
        if (S.px !== lastPx) { lastPx = S.px; } else idle++;
        const press = S.px > plan.col ? 8 | 1 : 16 | 2; w = prev & (press & 24) ? 0 : press;
      } else w = prev & 32 ? 0 : 32;
    }
    sim.step(w); sim.clearEvents(); prev = w;
  }
  return { replay: sim.replay(), score: sim.score, frames: sim.frame };
}

const GAMES = {
  stacklight: { id: SL_ID, version: SL_VERSION, play: (seed) => playSL(seed) },
  starfall: { id: SF_ID, version: SF_VERSION, play: (seed) => playScripted(seed, 7, 'script', 'daily') },
};
let N = 0;
// One fresh ticket and one fresh run per case (a ticket takes one run). `after(run)` is ms past the ticket when it is sent.
async function submit(game, after) {
  const g = GAMES[game], c = { t: T0 }, W = createWorker({ now: () => c.t }), e = { ...(await makeEnv()), DAILY_SECRET: SECRET };
  const player = `w59-player-${game}-${String(++N).padStart(4, '0')}`, ip = `198.51.100.${(N % 250) + 1}`;
  const r = await W.fetch(new Request(`https://lb.test/daily?game=${g.id}`, { headers: { 'x-player-id': player, 'cf-connecting-ip': ip } }), e);
  const d = await r.json(); assert.equal(r.status, 200, JSON.stringify(d));
  const run = g.play(d.seed);
  assert.ok(run.score > 0 && run.frames > 0, 'the bot played a real run');
  c.t = T0 + after(run);
  const res = await post(W, e, { game: g.id, playerId: player, name: 'ACE', score: run.score, replay: run.replay, seed: d.seed, mode: 'daily', dayKey: d.dayKey, version: g.version, ticket: d.ticket }, { ip });
  return { status: res.status, code: res.body.error ?? 'ok', body: res.body, run };
}

test('the shipped LIMITS.ticketGraceS is TICKET_GRACE_S (the rule is on, 600 s)', () => {
  assert.equal(LIMITS.ticketGraceS, TICKET_GRACE_S);
  assert.equal(TICKET_GRACE_S, 600);
  assert.equal(TICKET_SLACK_S, 10);
});

test('ticketStale at a whole-millisecond edge: 6000 frames (100 s) + 600 s + 10 s = 710000 ms passes, 710001 fails', () => {
  assert.equal(ticketStale(1000, 6000, 1000 + 710000), false, 'exactly at the edge');
  assert.equal(ticketStale(1000, 6000, 1000 + 710001), true, '1 ms past');
  assert.equal(ticketStale(1000, 6000, 1000 + 710000 + 1000), true, '1 s past');
});

for (const game of Object.keys(GAMES)) {
  test(`${game} Daily sent 11 min past its play time: ticket_stale (422)`, async () => {
    const r = await submit(game, (run) => playMs(run.frames) + 11 * MIN);
    assert.deepEqual([r.status, r.code], [422, 'ticket_stale'], JSON.stringify(r.body));
  });
  test(`${game} Daily sent 9 min past its play time: 201`, async () => {
    const r = await submit(game, (run) => playMs(run.frames) + 9 * MIN);
    assert.deepEqual([r.status, r.code], [201, 'ok'], JSON.stringify(r.body));
  });
  test(`${game} Daily at exactly play time + 600 s + 10 s passes; 1 s past it fails`, async () => {
    const at = await submit(game, (run) => edgeMs(run.frames));
    assert.deepEqual([at.status, at.code], [201, 'ok'], 'the edge itself: ' + JSON.stringify(at.body));
    const past = await submit(game, (run) => edgeMs(run.frames) + 1000);
    assert.deepEqual([past.status, past.code], [422, 'ticket_stale'], '1 s past the edge');
  });
}
