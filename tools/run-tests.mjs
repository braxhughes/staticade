// Test runner split: `npm test` runs the fast Node-only files,
// `npm run test:browser` the files that drive headless Chrome, `npm run test:all` both.
// A file counts as a browser test when its source mentions playwright or chromium.
// Usage: node tools/run-tests.mjs node|browser|all
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const which = process.argv[2] || 'all';
if (!['node', 'browser', 'all'].includes(which)) { console.error('usage: node tools/run-tests.mjs node|browser|all'); process.exit(2); }
const dir = 'tests';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(dir, f));
const isBrowser = f => /playwright|chromium/.test(fs.readFileSync(f, 'utf8'));
const pick = which === 'all' ? files : files.filter(f => isBrowser(f) === (which === 'browser'));
const r = spawnSync(process.execPath, ['--test', ...pick], { stdio: 'inherit' });
process.exit(r.status ?? 1);
