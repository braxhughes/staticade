// the B.8 score band gate, `node tools/stacklight-bot.mjs --band score`, through the real CLI.
//   1. the gate prints its tables and a final PASS line, exit 0; the printed numbers equal the frozen SCORE_BAND
//   2. SCORE_BAND equals the numbers written in the STACKLIGHT design notes B.8 (band, good-player tier)
//   3. the PASS rule can fail: a shifted, swapped or wrong frozen number, or another good-player tier, gives FAIL
//   4. through the CLI, a tier that is not in the band (--good-tier 9) prints FAIL and exits 1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { SCORE_BAND, judgeScoreBand } from '../tools/stacklight-bot.mjs';

const root = new URL('..', import.meta.url);
const cli = args => spawnSync(process.execPath, ['tools/stacklight-bot.mjs', ...args], { cwd: root, encoding: 'utf8' });
const num = s => Number(s.replace(/,/g, ''));

// the measurement as the CLI printed it (field rows and the per-tier median table)
function parse(stdout) {
  const m = { off: { median: [] }, on: { median: [] } };
  for (const line of stdout.split('\n')) {
    let x = line.match(/^plan ahead +(OFF|ON) \| +(\d+) \| +(\d+) \| +(\d+) \| +(\d+) \| +(\d+)$/);
    if (x) { const k = x[1].toLowerCase(); Object.assign(m[k], { runs: +x[2], p75: +x[3], p75f: +x[4], p90: +x[5], p90f: +x[6] }); continue; }
    x = line.match(/^ +([1-9]) \| +(\d+) \| +\w+ \| +(\d+) \| +\w+$/);
    if (x) { m.off.median[+x[1]] = +x[2]; m.on.median[+x[1]] = +x[3]; }
  }
  return m;
}

let gate = null;
const runGate = () => gate || (gate = cli(['--band', 'score']));

test('--band score: band table, final PASS line, exit 0, printed numbers equal the frozen ones', () => {
  const r = runGate();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.match(lines[lines.length - 1], /^PASS: /);
  assert.equal(lines.filter(l => /^(PASS|FAIL): /.test(l)).length, 1);
  const m = parse(r.stdout);
  for (const k of ['off', 'on']) {
    assert.equal(m[k].runs, 180, k + ' runs');
    assert.equal(m[k].p75, SCORE_BAND[k].p75, k + ' p75'); assert.equal(m[k].p75f, SCORE_BAND[k].p75, k + ' p75 frozen');
    assert.equal(m[k].p90, SCORE_BAND[k].p90, k + ' p90'); assert.equal(m[k].p90f, SCORE_BAND[k].p90, k + ' p90 frozen');
    assert.equal(m[k].median.filter(v => v !== undefined).length, 9, k + ' medians');
  }
  assert.deepEqual(judgeScoreBand(m), []);
});

test('SCORE_BAND equals the numbers in design B.8', () => {
  const doc = fs.readFileSync(new URL('../agent_docs/stacklight-design.md', import.meta.url), 'utf8');
  const b8 = doc.slice(doc.indexOf('### B.8 Pacing and levels'), doc.indexOf('### B.9 Modes'));
  assert.ok(b8.length > 100, 'B.8 section found');
  for (const [k, label] of [['off', 'OFF'], ['on', 'ON']]) {
    const row = b8.match(new RegExp(`^\\| plan ahead ${label} \\| ([\\d,]+) \\| ([\\d,]+) \\|`, 'm'));
    assert.ok(row, 'B.8 band row for plan ahead ' + label);
    assert.equal(num(row[1]), SCORE_BAND[k].p75, label + ' p75 in B.8');
    assert.equal(num(row[2]), SCORE_BAND[k].p90, label + ' p90 in B.8');
  }
  const good = b8.match(/\*\*Good player = tier (\d):\*\*/);
  assert.ok(good, 'B.8 names the good-player tier');
  assert.equal(+good[1], SCORE_BAND.goodTier);
  assert.match(b8, new RegExp(`tier ${SCORE_BAND.belowTier}'s median is below p75 and tier ${SCORE_BAND.aboveTier}'s median is above p90`));
  assert.equal(SCORE_BAND.seeds, '1-20');
  assert.match(b8, /seeds 1 to 20/);
});

test('the PASS rule can fail: shifted, swapped or wrong frozen numbers, other tiers', () => {
  const m = parse(runGate().stdout);
  const with_ = (k, f) => ({ ...SCORE_BAND, [k]: { ...SCORE_BAND[k], ...f } });
  for (const k of ['off', 'on']) {
    for (const q of ['p75', 'p90']) for (const d of [-1, 1]) {
      const why = judgeScoreBand(m, with_(k, { [q]: SCORE_BAND[k][q] + d }));
      assert.ok(why.some(w => w.includes(`${q} is ${m[k][q]}, frozen ${SCORE_BAND[k][q] + d}`)), `${k} ${q}${d > 0 ? '+' : ''}${d}: ${why.join('; ')}`);
    }
    const sw = judgeScoreBand(m, with_(k, { p75: SCORE_BAND[k].p90, p90: SCORE_BAND[k].p75 }));
    assert.ok(sw.some(w => w.includes('is not below p90')), k + ' swapped: ' + sw.join('; '));
  }
  for (const t of [1, 5, 6, 9]) assert.ok(judgeScoreBand(m, SCORE_BAND, t).some(w => w.includes(`good player (tier ${t})`)), 'good tier ' + t);
  assert.ok(judgeScoreBand(m, { ...SCORE_BAND, belowTier: 8 }).length > 0, 'tier 8 as the tier below the band');
  assert.ok(judgeScoreBand(m, { ...SCORE_BAND, aboveTier: 8 }).length > 0, 'tier 8 as the tier above the band');
});

test('--band score --good-tier 9 prints FAIL with the reason and exits 1', () => {
  const r = cli(['--band', 'score', '--good-tier', '9']);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const last = r.stdout.trimEnd().split('\n').pop();
  assert.match(last, /^FAIL: .*good player \(tier 9\) median \d+ is outside the band/);
  assert.equal(cli(['--band', 'tiers']).status, 2);
});
