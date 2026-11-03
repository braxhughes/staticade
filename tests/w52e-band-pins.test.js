// Extra pins on `node tools/stacklight-bot.mjs --band score`.
//   1. the whole default stdout is pinned by sha256 (as tests/stacklight-bot.test.js pins --seeds and --tiers), and
//      the saved score band output in docs still holds that same output
//   2. the gate really measures: on another field (seeds 21-30) its printed p75, p90 and 9 tier medians per field equal a
//      second, independent measurement made here (createSim + createBot directly, not playRun or measureScoreBand)
//   3. --band score refuses --move, --tap-gap and --plan-ahead with exit 2 and a one-line message
//   4. B.8 text: the old good-player claim is gone; the gate limit and the re-freeze rule are written down
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createSim } from '../games/stacklight/sim.js';
import { createBot, SCORE_BAND } from '../tools/stacklight-bot.mjs';

const root = new URL('..', import.meta.url);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const cliAsync = args => new Promise(resolve => {
  const p = spawn(process.execPath, ['tools/stacklight-bot.mjs', ...args], { cwd: root });
  let stdout = '', stderr = '';
  p.stdout.on('data', d => { stdout += d; });
  p.stderr.on('data', d => { stderr += d; });
  p.on('close', status => resolve({ status, stdout, stderr }));
});
const cli = args => spawnSync(process.execPath, ['tools/stacklight-bot.mjs', ...args], { cwd: root, encoding: 'utf8' });

// both gate runs start now, in parallel with the in-process measurement below
const gateDefault = cliAsync(['--band', 'score']);
const gateOther = cliAsync(['--band', 'score', '--seeds', '21-30']);

// the measurement as the CLI printed it ("now" columns and the per-tier median table)
function parse(stdout) {
  const m = { off: { median: [] }, on: { median: [] } };
  for (const line of stdout.split('\n')) {
    let x = line.match(/^plan ahead +(OFF|ON) \| +(\d+) \| +(\d+) \| +(\d+) \| +(\d+) \| +(\d+)$/);
    if (x) { Object.assign(m[x[1].toLowerCase()], { runs: +x[2], p75: +x[3], p90: +x[5] }); continue; }
    x = line.match(/^ +([1-9]) \| +(\d+) \| +\w+ \| +(\d+) \| +\w+$/);
    if (x) { m.off.median[+x[1]] = +x[2]; m.on.median[+x[1]] = +x[3]; }
  }
  return m;
}

// the second code path: B.8's field definition written out again. Score at frame 36,000, or the final score if the run
// ended sooner; pN = sorted[floor(N / 100 x runs)]; a tier's median = its sorted scores at floor(seeds / 2).
function independent(seeds) {
  const out = {};
  for (const planAhead of [false, true]) {
    const all = [], median = [];
    for (let tier = 1; tier <= 9; tier++) {
      const s = [];
      for (const seed of seeds) {
        const sim = createSim({ seed, mode: 'arcade' });
        const bot = createBot({ seed, tier, planAhead });
        while (!sim.done && sim.frame < 36000) { sim.step(bot.word(sim)); sim.clearEvents(); }
        s.push(sim.score);
      }
      s.sort((x, y) => x - y);
      median[tier] = s[Math.floor(s.length / 2)];
      all.push(...s);
    }
    all.sort((x, y) => x - y);
    out[planAhead ? 'on' : 'off'] = { runs: all.length, p75: all[Math.floor(0.75 * all.length)], p90: all[Math.floor(0.9 * all.length)], median };
  }
  return out;
}

test('--band score: whole stdout pinned by sha256, exit 0, and docs/w52/w52d-band.txt still matches it', async () => {
  const r = await gateDefault;
  assert.equal(r.status, 0, r.stdout + r.stderr);
  // re-pinned for GAME_VERSION 2.0 (D111, D113) from the CLI's own output after SCORE_BAND was re-frozen
  // re-pinned again (the lock timer never pauses in the air) after SCORE_BAND off p75 was re-frozen
  assert.equal(sha(r.stdout), 'd3d37ce4e4203b7ce69da0ef043a39ead18f2870dbfc1ee2300682aa85351d5c', 'whole --band score stdout');
  const doc = fs.readFileSync(new URL('../docs/w52/w52d-band.txt', import.meta.url), 'utf8');
  assert.equal(doc, r.stdout + 'exit 0\n', 'docs/w52/w52d-band.txt is the output plus its exit line');
});

test('--band score measures: on seeds 21-30 its p75, p90 and tier medians equal an independent measurement', async () => {
  const seeds = [21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
  const want = independent(seeds);
  const r = await gateOther;
  assert.ok(r.status === 0 || r.status === 1, r.stdout + r.stderr);
  assert.match(r.stdout, /seeds 21-30/);
  const got = parse(r.stdout);
  for (const k of ['off', 'on']) {
    assert.equal(got[k].runs, 90, k + ' runs');
    assert.equal(got[k].p75, want[k].p75, k + ' p75');
    assert.equal(got[k].p90, want[k].p90, k + ' p90');
    for (let t = 1; t <= 9; t++) assert.equal(got[k].median[t], want[k].median[t], `${k} tier ${t} median`);
  }
  // this field must differ from the frozen one, or the check above could not tell measuring from echoing
  assert.ok(['off', 'on'].some(k => want[k].p75 !== SCORE_BAND[k].p75 || want[k].p90 !== SCORE_BAND[k].p90), 'seeds 21-30 give other percentiles');
});

test('--band score refuses --move, --tap-gap and --plan-ahead (exit 2, one line, nothing measured)', () => {
  for (const extra of [['--move', 'tap'], ['--move', 'hold'], ['--tap-gap', '8'], ['--tap-gap', '3'], ['--plan-ahead'], ['--move', 'best', '--plan-ahead']]) {
    const r = cli(['--band', 'score', ...extra]);
    assert.equal(r.status, 2, extra.join(' ') + ': ' + r.stdout + r.stderr);
    assert.equal(r.stdout, '', extra.join(' ') + ': nothing on stdout');
    assert.match(r.stderr, /^--band score refuses --move, --tap-gap and --plan-ahead: [^\n]*\n$/, extra.join(' '));
  }
});

test('B.8 no longer calls the good player a level 16 or 17 top-out, and states the gate limit and the re-freeze rule', () => {
  const doc = fs.readFileSync(new URL('../agent_docs/stacklight-design.md', import.meta.url), 'utf8');
  const b8 = doc.slice(doc.indexOf('### B.8 Pacing and levels'), doc.indexOf('### B.9 Modes'));
  assert.ok(b8.length > 100, 'B.8 section found');
  assert.doesNotMatch(b8, /D\.7 gives tier 8 to a player whose runs top out at level 16 or 17/);
  assert.match(b8, /\*\*A human who tops out at level 16 or 17 scores below the band\.\*\*/);
  assert.match(b8, /It does not judge pacing; pacing is judged by the owner playing\./);
  assert.match(b8, /\*\*Re-freeze rule:\*\* new band numbers are frozen .* only together with a log entry in `agent_docs\/log\.md` that says why they moved\./);
});
