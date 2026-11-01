// CLAUDE.md: no per-frame allocations in hot loops. cometLayer.draw runs every frame while a
// comet is on, so this test counts minor garbage collections (scavenges) around 400000 draws with a stub renderer that itself
// allocates nothing. Zero allocation means no scavenge; one object per frame (for example `const pt = { x, y }`) fills the
// young generation and triggers several. It runs in a child node with --no-turbo-escape, because the optimizing compiler
// would otherwise remove a short-lived object that never leaves the function, hiding an allocation that still costs in the
// interpreter and in the first frames after a deopt. Node only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CORE = fileURLToPath(new URL('../games/starfall/render/core.js', import.meta.url));
const CHILD = `
import { PerformanceObserver } from 'node:perf_hooks';
const { cometLayer } = await import(process.argv[1]);
let scav = 0;
new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.detail.kind === 1) scav++; }).observe({ entryTypes: ['gc'] });
const sk = new Float64Array(2);
const R = { ui: { F: 0 }, dot(x, y) { sk[0] = x; sk[1] = y; } };
const sim = { cometBody: { on: true, x: 100, y: 30, px: 98, py: 30 } };
for (let i = 0; i < 20000; i++) { R.ui.F = i; cometLayer.draw(R, sim, 0.5); }   // warm up
await new Promise(r => setTimeout(r, 50)); scav = 0;
for (let i = 0; i < 400000; i++) { R.ui.F = i; cometLayer.draw(R, sim, i % 2 ? 0.25 : 0.75); }
await new Promise(r => setTimeout(r, 100));
console.log(JSON.stringify({ scav, drawn: cometLayer.drawn, dot: sk[0] > 0 }));
`;

test('cometLayer.draw allocates nothing per frame while a comet is on (no minor GC over 400000 draws)', { timeout: 120000 }, () => {
  const r = spawnSync(process.execPath, ['--no-turbo-escape', '--input-type=module', '-e', CHILD, CORE], { encoding: 'utf8', timeout: 100000 });
  assert.equal(r.status, 0, 'child failed: ' + r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.drawn, 11, 'the comet was drawn in the loop');
  assert.ok(out.dot, 'the stub saw dots');
  assert.ok(out.scav <= 1, 'minor GCs while drawing: ' + out.scav + ' (zero allocation gives 0)');
});
