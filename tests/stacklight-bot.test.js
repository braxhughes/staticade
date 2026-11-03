// STACKLIGHT T7 bot (tools/stacklight-bot.mjs). Node only, a few seconds.
//   1. determinism: the same (seed, tier) twice gives the same hash and the same words
//   2. the bot only sends real input words: no reserved bit, the replay of its words on a fresh sim ends in the same state
//   3. on hand-set boards it reaches the placement it chose, through real words (KEY into a notch, upright BAR into a well,
//      a far column at a fast level by held auto-repeat)
//   4. reaction: tier 1 waits 44 frames after it first sees a piece, tier 9 waits 12
//   5. mistake rolls come from the 'bot' stream (two draws per plan) and never touch the sim's own stream or its deck
//   6. no Math.random or Date in the bot's source; a candidate gravity table is put back afterwards
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Rng } from '../engine/rng.js';
import { createSim, EV_LOCK } from '../games/stacklight/sim.js';
import { GRAVITY, INPUT_MASK, NEUTRAL, streamSeed } from '../games/stacklight/defs.js';
import { playRun, createBot, reactionFor, mistakePercentFor, withGravity } from '../tools/stacklight-bot.mjs';

function drive(sim, bot, until, limit = 3000) {
  const words = [];
  for (let i = 0; i < limit && !sim.done && !until(sim); i++) {
    const w = bot.word(sim);
    words.push(w);
    sim.step(w);
  }
  return words;
}
function lockEvents(sim) { const out = []; sim.drain((b, o) => { if (b[o] === EV_LOCK) out.push({ type: b[o + 2], fit: b[o + 3], melted: b[o + 4], col: b[o + 5] }); }); return out; }

test('same seed and tier twice: same hash, same score, same replay', () => {
  for (const [seed, tier] of [[1, 1], [3, 5], [7, 8]]) {
    const a = playRun({ seed, tier }), b = playRun({ seed, tier });
    assert.equal(a.hash, b.hash); assert.equal(a.frames, b.frames); assert.equal(a.score, b.score); assert.equal(a.replay, b.replay);
    assert.equal(a.reason, 'topout');
  }
});

test('only real words: no reserved bit, and replaying the words on a fresh sim ends in the same state', () => {
  const sim = createSim({ seed: 4, mode: 'arcade' }), bot = createBot({ seed: 4, tier: 3 });
  while (!sim.done) { const w = bot.word(sim); assert.equal(w & ~INPUT_MASK, 0); sim.step(w); sim.clearEvents(); }
  assert.equal(sim.badInput, false);
  const again = createSim({ seed: 4, mode: 'arcade' });
  for (let i = 0; i < sim.frame; i++) again.step(sim.rec[i]);
  assert.equal(again.stateHash(), sim.stateHash());
  assert.equal(again.score, sim.score);
});

function oneLock(heights, pieces, lines = 0, tier = 9) {
  const sim = createSim({ seed: 5, mode: 'test', test: { heights, pieces, lines } });
  const bot = createBot({ seed: 5, tier });
  let planned = null;
  const words = [];
  for (let i = 0; i < 400 && !sim.done; i++) {
    const w = bot.word(sim);
    if (bot.ctl !== null && planned === null) planned = { tcol: bot.ctl.tcol, trot: bot.ctl.trot };
    words.push(w); sim.step(w);
    const ev = lockEvents(sim);
    if (ev.length) return { sim, bot, planned, lock: ev[0], words };
  }
  throw new Error('the piece never locked');
}

test('reaches a KEY: PLUS into a one-cell notch', () => {
  const r = oneLock([1, 1, 1, 1, 0, 1, 1, 1, 1], ['PLUS', 'BAR', 'BAR']);
  assert.equal(r.planned.tcol, 4); assert.equal(r.lock.col, 4); assert.equal(r.lock.fit, 2); assert.equal(r.lock.melted, 0);
  assert.equal(r.sim.lines, 1);
});

test('reaches an upright BAR in a three-deep well (a real rotate press, then a drop)', () => {
  const r = oneLock([3, 3, 3, 3, 0, 3, 3, 3, 3], ['BAR', 'PLUS', 'BAR']);
  assert.equal(r.planned.trot, 1); assert.equal(r.lock.col, 4);
  assert.ok(r.words.some(w => w & 64), 'a rotate press was sent');
  assert.equal(r.sim.lines, 3);
});

test('reaches a far column at level 16 with a held direction (auto-repeat), and a flat BAR on a level surface (FLAT)', () => {
  const far = oneLock([0, 3, 3, 3, 3, 3, 3, 3, 3], ['BAR', 'PLUS', 'BAR'], 120);
  assert.equal(far.sim.level, 16); assert.equal(far.planned.tcol, 0); assert.equal(far.lock.col, 0);
  assert.ok(far.words.some(w => (w & 1) && !(w & 8)), 'LEFT was held without a new press');
  const flat = oneLock([2, 2, 2, 2, 2, 2, 2, 2, 2], ['BAR', 'BAR', 'BAR']);
  assert.equal(flat.lock.fit, 1); assert.equal(flat.lock.col, flat.planned.tcol);
});

test('reaches what it chose on several other boards', () => {
  for (const heights of [[2, 2, 2, 0, 0, 0, 2, 2, 2], [1, 0, 1, 2, 1, 0, 1, 2, 1], [3, 2, 2, 1, 1, 1, 2, 2, 3], [0, 0, 1, 1, 2, 2, 3, 3, 4]]) {
    for (const piece of ['BAR', 'PLUS']) {
      const r = oneLock(heights, [piece, 'BAR', 'PLUS']);
      assert.equal(r.lock.col, r.planned.tcol, `${piece} on ${heights}`);
    }
  }
});

test('reaction: tier 1 waits 44 frames after it first sees a piece, tier 9 waits 12', () => {
  assert.equal(reactionFor(1), 44); assert.equal(reactionFor(9), 12); assert.equal(reactionFor(5), 28);
  assert.equal(mistakePercentFor(1), 32); assert.equal(mistakePercentFor(9), 0);
  for (const tier of [1, 9]) {
    const sim = createSim({ seed: 2, mode: 'test', test: { heights: [0, 3, 3, 3, 3, 3, 3, 3, 3], pieces: ['PLUS', 'BAR', 'BAR'] } });
    const bot = createBot({ seed: 2, tier });
    const words = drive(sim, bot, s => s.frame >= 80);
    // frame 0 spawns the piece (the bot cannot see it yet); it sees it before frame 1 and waits `reaction` neutral words
    const first = words.findIndex(w => w !== NEUTRAL);
    assert.equal(first, 1 + reactionFor(tier), 'tier ' + tier + ' first press at frame ' + first);
  }
});

test('mistake rolls: two draws per plan from the bot stream, none from the sim, and the deck does not change', () => {
  const run = (tier) => {
    const sim = createSim({ seed: 6, mode: 'arcade' }), bot = createBot({ seed: 6, tier });
    const seq = [];
    let seen = -1;
    while (!sim.done && sim.frame < 6000) {
      const w = bot.word(sim);
      const inf = sim.info();
      if (inf.piece && inf.spawned !== seen) { seen = inf.spawned; seq.push(inf.piece.type); }
      sim.step(w); sim.clearEvents();
    }
    return { sim, bot, seq };
  };
  const a = run(1), b = run(9);
  // the pieces dealt depend on the seed only: both runs see the same prefix
  const n = Math.min(a.seq.length, b.seq.length);
  assert.ok(n > 20);
  assert.deepEqual(a.seq.slice(0, n), b.seq.slice(0, n));
  assert.ok(a.bot.stats.mistakes > 0, 'tier 1 made mistakes'); assert.equal(b.bot.stats.mistakes, 0);
  // the bot stream: exactly 2 draws per plan, at every tier, from new Rng(streamSeed(seed, 'bot'))
  for (const r of [a, b]) {
    const ref = new Rng(streamSeed(6, 'bot'));
    for (let i = 0; i < 2 * r.bot.stats.plans; i++) ref.u32();
    assert.deepEqual(r.bot.rng.save(), ref.save());
  }
  // the sim's own stream is where a plain replay of the same words puts it
  for (const r of [a, b]) {
    const plain = createSim({ seed: 6, mode: 'arcade' });
    for (let i = 0; i < r.sim.frame; i++) plain.step(r.sim.rec[i]);
    assert.deepEqual(plain.rng.save(), r.sim.rng.save());
    assert.equal(plain.stateHash(), r.sim.stateHash());
  }
});

test('no Math.random or Date in the bot, and a candidate gravity table is put back', () => {
  const src = fs.readFileSync(new URL('../tools/stacklight-bot.mjs', import.meta.url), 'utf8')
    .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(src, /Math\.random|Date\b|performance\.now/);
  const before = GRAVITY.slice();
  const cand = Array(20).fill(5376);
  const inside = withGravity(cand, () => GRAVITY.slice());
  assert.equal(inside[1], 5376); assert.equal(inside[20], 5376); assert.equal(inside[0], 0);
  assert.deepEqual(GRAVITY, before);
});

// ---------- fixes: model/sim agreement, reaction on every piece, plan ahead, rule overrides ----------
//  10. a full tier-9 run on seeds 1-5 keeps `missed` small (review finding 3; mutant 4 breaks it)
//  11. the bot's piece model and the sim agree frame by frame under the controller's words (finding 3, directly)
//  12. reaction: every piece of a 20+ piece run waits exactly `reaction` frames from first sight (finding 4; mutant 6)
//  13. plan ahead: waits `reaction` from each lock it sees, sends only what the sim carries, reads only NEXT[0]
//  14. withRules / withGravity refuse a bad table and a non-plain function and always put the rules back (finding 7)
//  15. the rule hook (tools/stacklight-rules.mjs) changes nothing by itself, and each lever reaches the sim
import { spawnSync } from 'node:child_process';
import { PieceModel, Controller, withRules, checkRules } from '../tools/stacklight-bot.mjs';
import { SPAWN_COL, SPAWN_ROW, ROT_H, BAR as T_BAR, PLUS as T_PLUS, IN_LEFT_PRESS, IN_RIGHT_PRESS, IN_HARD_PRESS, IN_ROT_PRESS } from '../games/stacklight/defs.js';

test('model agrees with the sim over full tier-9 runs: at most 4 misses a run and 8 over seeds 1-5', () => {
  // Bound: on the shipped code these 5 runs (about 30,000 placements) miss 0, 0, 1, 1, 2 (total 4), i.e. the bot's model
  // and the sim disagree on about 1 placement in 7,500. 8 in total (and 4 in one run) leaves room for that, and is far
  // below what a wrong model gives: with the first auto-repeat modelled as 3 frames (review mutant 4) the same runs miss
  // 0, 9, 6, 5, 3 (total 23).
  // GAME_VERSION 2.0 (D111, D113): with no lock resets a plan made after the piece has rested a while must know how much
  // of the delay is left. The default bot plans from lockT 0 (it never read the timer; resets used to hide that), so it
  // misses 7, 6, 15, 6, 13 at level 19 to 20 for that reason alone. This test checks the model's physics, so it runs
  // with seenLock (the model starts from the sim's lockT): 0, 0, 1, 0, 3 (total 4). Same bounds as before.
  const missed = [1, 2, 3, 4, 5].map(seed => playRun({ seed, tier: 9, seenLock: true }).stats.missed);
  const total = missed.reduce((a, b) => a + b, 0);
  assert.ok(missed.every(m => m <= 4), 'misses per run ' + missed.join(','));
  assert.ok(total <= 8, 'misses over seeds 1-5: ' + total + ' (' + missed.join(',') + ')');
});

// one piece on a hand-set board, driven by a Controller; the model is stepped with the same words from the sim's state
function lockstep({ heights, piece, lines, tcol, trot, early = false }) {
  const sim = createSim({ seed: 3, mode: 'test', test: { heights, pieces: early ? ['PLUS', piece, 'BAR'] : [piece, 'BAR', 'PLUS'], lines } });
  const type = piece === 'BAR' ? T_BAR : T_PLUS;
  const m = new PieceModel(), ctl = new Controller(type, tcol, trot);
  let pre = 0;
  if (early) { // drop the first piece, then plan the next one from the first frame of the entry delay (8 frames)
    sim.step(0); sim.step(IN_HARD_PRESS); assert.equal(sim.info().phase, 'delay'); sim.clearEvents();
    pre = sim.lines !== lines ? 28 : 8; // B.6: 8 entry frames, or 20 clear + 8 entry
    m.grid.set(sim.grid);
    m.reset(type, SPAWN_COL, SPAWN_ROW, ROT_H, GRAVITY[sim.level], sim.level, pre);
  } else {
    sim.step(0); // the spawn frame
    const p = sim.info().piece, S = sim.ctx;
    m.grid.set(sim.grid);
    m.reset(type, p.col, p.row, p.rot, GRAVITY[sim.level], sim.level, 0);
    m.sub = S.sub; m.lockT = S.lockT; m.resets = S.resets; m.arDir = S.arDir; m.arT = S.arT; m.prev = S.prev;
  }
  for (let t = 0; t < 400; t++) {
    const preBefore = m.pre, w = ctl.next(m.c, m.rot, m.pre);
    const lockedM = m.step(w);
    sim.step(w);
    const ev = lockEvents(sim), p = sim.info().piece;
    if (preBefore > 0) { assert.ok(p === null && !lockedM && ev.length === 0, 'still in the delay at t ' + t); continue; }
    if (lockedM || ev.length) {
      assert.ok(lockedM && ev.length === 1, `lock on the same frame (model ${lockedM}, sim ${ev.length}) at t ${t}`);
      assert.equal(ev[0].col, m.c, 'lock column'); return t;
    }
    assert.ok(p !== null, 'sim piece out at t ' + t);
    assert.deepEqual([p.col, p.row, p.rot], [m.c, m.r, m.rot], `frame ${t}: sim (col,row,rot) vs model`);
  }
  throw new Error('no lock in 400 frames');
}

test('the piece model and the sim agree frame by frame (held repeat, taps, turn, sliding on the stack, planned spawns)', () => {
  const boards = [[0, 0, 0, 0, 0, 0, 0, 0, 0], [0, 3, 3, 3, 3, 3, 3, 3, 3], [2, 2, 1, 0, 0, 0, 1, 2, 2], [1, 0, 1, 2, 1, 0, 1, 2, 1], [4, 3, 2, 1, 0, 1, 2, 3, 4]];
  let n = 0;
  for (const lines of [0, 72, 120, 152]) for (const heights of boards) for (const [piece, tcol, trot] of [['PLUS', 1], ['PLUS', 7], ['BAR', 0, 1], ['BAR', 8, 1], ['BAR', 2, 0], ['BAR', 6, 0], ['PLUS', 3]]) {
    for (const early of [false, true]) { lockstep({ heights, piece, lines, tcol, trot: trot || 0, early }); n++; }
  }
  assert.equal(n, 280);
});

// every piece: the frame the bot first sees it (or, planning ahead, first sees the lock before it), the frame it plans,
// and its first non-neutral word
function reactionTrace(seed, tier, planAhead, frames = 9000) {
  const sim = createSim({ seed, mode: 'arcade' }), bot = createBot({ seed, tier, planAhead });
  const out = []; let seen = -1, cur = null, hadPiece = false, inGap = false;
  while (!sim.done && sim.frame < frames) {
    const inf = sim.info();
    if (inf.piece && inf.spawned !== seen) { seen = inf.spawned; if (!planAhead || !hadPiece) { cur = { start: inf.frame, plan: -1, first: -1 }; out.push(cur); } hadPiece = true; inGap = false; }
    if (planAhead && !inf.piece && hadPiece && !inGap) { inGap = true; cur = { start: inf.frame, plan: -1, first: -1 }; out.push(cur); }
    const plans = bot.stats.plans, w = bot.word(sim);
    if (cur && cur.plan < 0 && bot.stats.plans !== plans) cur.plan = inf.frame;
    if (cur && cur.first < 0 && w !== NEUTRAL) cur.first = inf.frame;
    sim.step(w); sim.clearEvents();
  }
  return out.filter(x => x.first >= 0 && x.plan >= 0);
}

test('reaction: every piece of a run of 20+ pieces waits exactly its reaction, not only the first', () => {
  for (const tier of [1, 5, 9]) {
    const tr = reactionTrace(2, tier, false);
    assert.ok(tr.length >= 20, 'tier ' + tier + ': ' + tr.length + ' pieces');
    tr.forEach((x, i) => {
      assert.equal(x.first - x.start, reactionFor(tier), `tier ${tier} piece ${i}: first press ${x.first - x.start} frames after first sight`);
      assert.equal(x.plan - x.start, reactionFor(tier), `tier ${tier} piece ${i}: planned ${x.plan - x.start} frames after first sight`);
    });
  }
});

test('plan ahead: waits its reaction from each lock it sees, sends only carried inputs in the delay, reads only NEXT[0]', () => {
  for (const tier of [9, 5]) {
    const tr = reactionTrace(4, tier, true);
    assert.ok(tr.length >= 20, tr.length + ' pieces');
    // it decides exactly `reaction` frames after it first sees the lock, and never sends anything before that (its first
    // word can come later: in a long clear delay a tap has to wait for the spawn frame)
    tr.forEach((x, i) => {
      assert.equal(x.plan - x.start, reactionFor(tier), `tier ${tier} piece ${i}: planned ${x.plan - x.start} frames after the lock was seen`);
      assert.ok(x.first >= x.plan, `tier ${tier} piece ${i}: pressed before deciding`);
    });
  }
  // in the delay: no sideways or drop press (the sim would drop them), a rotate press only in the 8 entry frames
  const sim = createSim({ seed: 7, mode: 'arcade' }), bot = createBot({ seed: 7, tier: 9, reaction: 2, planAhead: true });
  let delayWords = 0, rots = 0, lastLock = -1, cleared = false, lines = 0;
  while (!sim.done && sim.frame < 20000) {
    const inf = sim.info();
    if (inf.piece) { lastLock = -1; lines = inf.lines; }
    else if (lastLock < 0 && inf.frame > 0) { lastLock = inf.frame; cleared = inf.lines !== lines; }
    const w = bot.word(sim);
    if (!inf.piece && inf.frame > 0) {
      const spawnAt = lastLock + (cleared ? 28 : 8), pre = spawnAt - inf.frame;
      if (pre > 0) {
        delayWords++;
        assert.equal(w & (IN_LEFT_PRESS | IN_RIGHT_PRESS | IN_HARD_PRESS), 0, 'no sideways or drop press in the delay');
        if (w & IN_ROT_PRESS) { rots++; assert.ok(pre <= 8, 'rotate pressed ' + pre + ' frames before the spawn frame'); }
      }
    }
    sim.step(w); sim.clearEvents();
  }
  assert.ok(bot.stats.early > 100 && delayWords > 100 && rots > 0, `planned ${bot.stats.early} pieces in the delay, ${rots} rotates`);
  // NEXT beyond the first piece is never read: hiding NEXT[1] and NEXT[2] changes no word
  const play = hide => {
    const s = createSim({ seed: 8, mode: 'arcade' }), b = createBot({ seed: 8, tier: 9, reaction: 4, planAhead: true });
    if (hide) { const real = s.info.bind(s); s.info = () => { const i = real(); i.next = [i.next[0], 'X', 'X']; return i; }; }
    while (!s.done && s.frame < 15000) { s.step(b.word(s)); s.clearEvents(); }
    return s.stateHash();
  };
  assert.equal(play(true), play(false));
});

test('withRules and withGravity refuse bad tables and non-plain functions, and always put the rules back', () => {
  const before = GRAVITY.slice();
  assert.throws(() => withGravity(Array(19).fill(10), () => 1), /20 integers/);
  assert.throws(() => withGravity(Array(21).fill(10), () => 1), /20 integers/);
  assert.throws(() => withGravity([...Array(19).fill(10), 1.5], () => 1), /20 integers/);
  assert.throws(() => withGravity(Array(20).fill(10), async () => 1), /plain synchronous/);
  assert.throws(() => withRules({ gravity: Array(20).fill(10) }, function* () { yield 1; }), /plain synchronous/);
  assert.throws(() => withRules({ gravity: Array(20).fill(10) }, () => Promise.resolve(1)), /promise/);
  assert.deepEqual(GRAVITY, before, 'put back after a refused promise');
  assert.throws(() => withRules({ gravity: Array(20).fill(10) }, () => { throw new Error('boom'); }), /boom/);
  assert.deepEqual(GRAVITY, before, 'put back after a throw');
  assert.throws(() => checkRules({ lockDelay: Array(19).fill(8) }), /20 integers/);
  assert.throws(() => checkRules({ resets: -1 }), /resets/);
  assert.throws(() => checkRules({ speed: 1 }), /unknown key/);
  // without the hook, the const levers are refused (never silently ignored)
  assert.throws(() => withRules({ lockDelay: Array(20).fill(8) }, () => 1), /--import/);
  assert.throws(() => withRules({ resets: 0 }, () => 1), /--import/);
});

test('rule hook: no change by itself; lock delay, resets, lines per level and gravity each reach the sim and are put back', () => {
  const script = `
    import { playRun, withRules, rulesHookActive } from './tools/stacklight-bot.mjs';
    const h = r => withRules(r, () => { const x = playRun({ seed: 1, tier: 5 }); return x.hash + ':' + x.frames + ':' + x.level; });
    const out = { active: rulesHookActive(), base: h(null), gravity: h({ gravity: Array(20).fill(5376) }) };
    if (out.active) { out.lock = h({ lockDelay: Array(20).fill(8) }); out.resets = h({ resets: 12 }); out.lines = h({ linesPerLevel: 4 }); }
    out.again = h(null);
    console.log(JSON.stringify(out));`;
  const root = new URL('..', import.meta.url);
  const run = withHook => {
    const args = [...(withHook ? ['--import', './tools/stacklight-rules.mjs'] : []), '--input-type=module', '-e', script];
    const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  };
  const off = run(false), on = run(true);
  assert.equal(off.active, false); assert.equal(on.active, true);
  assert.equal(on.base, off.base, 'the hook alone changes nothing');
  assert.equal(on.again, on.base, 'rules put back');
  for (const k of ['lock', 'resets', 'lines', 'gravity']) assert.notEqual(on[k], on.base, k + ' reached the sim');
  assert.equal(on.gravity, off.gravity, 'gravity override is the same with or without the hook');
  const same = playRun({ seed: 1, tier: 5 });
  assert.equal(same.hash + ':' + same.frames + ':' + same.level, off.base, 'and the same as in this process');
});

// ---------- tapping re-measure: the tap controller, 'best', and the default bot unchanged ----------
//  16. tap: every sideways word is a 1-frame press (never a held repeat), presses at least tapGap frames apart, in play and
//      in the planning delay (review mutant "make tap hold" breaks it)
//  17. best: on hand-built positions, the real bot with move 'best' shows its target in the sim no later than hold or tap
//      sent to the same target from the same frame; and both kinds of win occur (mutant "best always picks hold" breaks it)
//  18. default output: `--seeds 1-5` and `--tiers --seeds 1-20` print exactly what it printed before the tap controller
import crypto from 'node:crypto';
import { checkMove } from '../tools/stacklight-bot.mjs';
import { IN_LEFT, IN_RIGHT } from '../games/stacklight/defs.js';

test('tap controller: no held repeats, every sideways word a 1-frame press, presses at least tapGap frames apart', () => {
  let presses = 0;
  for (const tapGap of [4, 6]) for (const planAhead of [false, true]) for (const seed of [1, 2]) {
    const sim = createSim({ seed, mode: 'arcade' }), bot = createBot({ seed, tier: 9, planAhead, move: 'tap', tapGap });
    let prev = 0, lastPress = -1e9, lastPiece = -1;
    while (!sim.done && sim.frame < 12000) {
      const w = bot.word(sim), f = sim.frame;
      for (const [held, press] of [[IN_LEFT, IN_LEFT_PRESS], [IN_RIGHT, IN_RIGHT_PRESS]]) {
        if (w & held) {
          assert.ok(w & press, `seed ${seed} gap ${tapGap} plan ${planAhead} frame ${f}: a held direction without a press (a held repeat)`);
          assert.equal(prev & held, 0, `seed ${seed} gap ${tapGap} plan ${planAhead} frame ${f}: direction held two frames running`);
        }
      }
      if (w & (IN_LEFT_PRESS | IN_RIGHT_PRESS)) {
        presses++;
        if (sim.info().piece !== null) {
          // within one piece the controller keeps its own rate; a new piece may tap at once, so only same-piece gaps count
          if (f - lastPress < tapGap && bot.spawned === lastPiece) assert.fail(`seed ${seed} gap ${tapGap}: presses ${f - lastPress} frames apart`);
          lastPress = f; lastPiece = bot.spawned;
        }
      }
      prev = w; sim.step(w); sim.clearEvents();
    }
    assert.equal(sim.badInput, false);
  }
  assert.ok(presses > 1000, presses + ' sideways presses checked');
  assert.throws(() => checkMove('tap', 3), /tapGap/); assert.throws(() => checkMove('slide', 4), /move/);
});

// The real bot with move 'best' plans the second piece of a hand-built board (planning ahead or not). From the frame it
// planned, the same target is sent by plain hold and plain tap controllers on a fresh sim that got the same words so far.
// Returns the frame after which each first shows the target (column and turn) in the sim, or locks in the target
// column (a drop where it stands, or a piece dropped on its spawn frame), Infinity if never.
function bestVsBoth({ heights, piece, lines, tapGap, planAhead }) {
  const mk = () => createSim({ seed: 3, mode: 'test', test: { heights, pieces: ['PLUS', piece, 'BAR'], lines } });
  const sim = mk(), bot = createBot({ seed: 3, tier: 9, reaction: 2, mistakePct: 0, planAhead, move: 'best', tapGap });
  const words = [];
  let P = -1, tgt = null, pre = 0, done = false;
  const shows = (s, t) => { const p = s.info().piece; return p !== null && p.col === t.tcol && (t.type !== T_BAR || p.rot === t.trot); };
  let best = Infinity;
  for (let i = 0; i < 600 && !sim.done && !done; i++) {
    const plans = bot.stats.plans, w = bot.word(sim);
    if (P < 0 && plans === 1 && bot.stats.plans === 2) {
      P = i; tgt = { tcol: bot.ctl.tcol, trot: bot.ctl.trot, type: bot.ctl.type, move: bot.ctl.move };
      pre = sim.info().piece === null ? bot.spawnAt - sim.frame : 0;
    }
    words.push(w); sim.step(w);
    if (P < 0) { sim.clearEvents(); continue; }
    const ev = lockEvents(sim);
    if (best === Infinity && (shows(sim, tgt) || (ev.length && ev[0].col === tgt.tcol))) best = i;
    if (ev.length) done = true;
  }
  assert.ok(P >= 0 && done, 'the best bot planned and locked the second piece');
  const other = mv => {
    const s = mk();
    for (let i = 0; i < P; i++) s.step(words[i]);
    s.clearEvents(); // the first piece's lock is not this piece's
    const c = new Controller(tgt.type, tgt.tcol, tgt.trot, mv, tapGap);
    for (let i = P; i < P + 400 && !s.done; i++) {
      const p = s.info().piece;
      s.step(p === null ? c.next(SPAWN_COL, ROT_H, Math.max(pre - (i - P), 0)) : c.next(p.col, p.rot));
      const ev = lockEvents(s);
      if (shows(s, tgt) || (ev.length && ev[0].col === tgt.tcol)) return i;
      if (ev.length) return Infinity;
    }
    return Infinity;
  };
  return { best, hold: other('hold'), tap: other('tap'), pick: tgt.move, tgt };
}

test("best: never shows its target later than hold or tap from the same frame, and picks each kind where it is faster", () => {
  const boards = [[0, 3, 3, 3, 3, 3, 3, 3, 3], [3, 3, 3, 3, 3, 3, 3, 3, 0], [0, 0, 2, 2, 2, 2, 2, 2, 2], [2, 2, 2, 2, 2, 2, 2, 0, 0], [2, 1, 2, 2, 2, 2, 2, 2, 2], [2, 2, 2, 2, 2, 2, 2, 1, 2]];
  let holdWins = 0, tapWins = 0, n = 0;
  for (const tapGap of [4, 6]) for (const planAhead of [false, true]) for (const lines of [0, 152]) for (const heights of boards) for (const piece of ['BAR', 'PLUS']) {
    const r = bestVsBoth({ heights, piece, lines, tapGap, planAhead });
    const tag = `gap ${tapGap} plan ${planAhead} lines ${lines} ${piece} on ${heights} -> col ${r.tgt.tcol} by ${r.pick}`;
    assert.ok(r.best < Infinity, tag + ': best reached its target');
    assert.ok(r.best <= r.hold, `${tag}: best at ${r.best}, hold at ${r.hold}`);
    assert.ok(r.best <= r.tap, `${tag}: best at ${r.best}, tap at ${r.tap}`);
    if (r.hold < r.tap) holdWins++; if (r.tap < r.hold) tapWins++;
    n++;
  }
  assert.equal(n, 96);
  assert.ok(holdWins > 0 && tapWins > 0, `hold faster on ${holdWins} positions, tap faster on ${tapWins}`);
});

test('default output: --seeds 1-5 and --tiers --seeds 1-20 print exactly what w52b printed', () => {
  const root = new URL('..', import.meta.url);
  const cli = args => spawnSync(process.execPath, ['tools/stacklight-bot.mjs', ...args], { cwd: root, encoding: 'utf8' });
  const a = cli(['--seeds', '1-5']);
  // GAME_VERSION 2.0 (D111, D113): re-pinned from the CLI on 2.0. 1.0 printed 60-minute runs (lightsout, ~13.9M);
  // with no lock resets tier 9 tops out at level 19 to 20 in about 3.7 minutes
  assert.equal(a.status, 1); // the level/frames band fails on 2.0 too (tops out above level 17, under 6 min)
  assert.equal(a.stdout.split('\n').slice(0, 7).join('\n'), [
    'STACKLIGHT bot, tier 9 (reaction 12 frames, mistakes 0%), Free Play',
    'seed | level | frames | minutes | lines | score | end | pieces | skipped | missed | stateHash | band',
    '   1 |    19 |  13340 |    3.71 |   147 | 369110 | topout |    377 |     225 |      7 | 0x7d4c7115 | out',
    '   2 |    19 |  13445 |    3.73 |   148 | 381035 | topout |    379 |     242 |      6 | 0x204cd33e | out',
    '   3 |    20 |  13532 |    3.76 |   152 | 414190 | topout |    380 |     173 |     15 | 0x691d2d8b | out',
    '   4 |    19 |  13589 |    3.77 |   149 | 396870 | topout |    383 |     239 |      6 | 0x88074de5 | out',
    '   5 |    20 |  13499 |    3.75 |   153 | 392685 | topout |    376 |     224 |     13 | 0xd37c5773 | out'].join('\n'));
  const sha = s => crypto.createHash('sha256').update(s).digest('hex');
  assert.equal(sha(a.stdout), '9b36834bb0cc2e271e4b457b3806fb08bfed53dc04f7c3089bfb58399b476984', 'whole --seeds 1-5 stdout');
  const t = cli(['--tiers', '--seeds', '1-20']);
  // Re-pinned (the lock timer no longer pauses in the air) from the CLI; the tier 9 rows above did not move
  assert.equal(sha(t.stdout), 'd7b4c61f2e57d2c9ad617d6aca80ba83e5eaae879620c13ddd636985101e6ca5', 'whole --tiers --seeds 1-20 stdout');
  // and naming today's controller explicitly changes nothing
  assert.equal(cli(['--seeds', '1-5', '--move', 'hold', '--tap-gap', '4']).stdout, a.stdout);
});
