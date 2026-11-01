// static page titles carry the arcade name, built from ARCADE_NAME.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCADE_NAME } from '../arcade/brand.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const titles = f => fs.readFileSync(path.join(root, f), 'utf8').split('\n').filter(l => /<title/i.test(l));

test('index.html has exactly one title line: the arcade name', () => {
  assert.deepEqual(titles('index.html'), [`<title>${ARCADE_NAME}</title>`]);
});

test('starfall.html has exactly one title line: STARFALL, middle dot, the arcade name', () => {
  assert.deepEqual(titles('starfall.html'), [`<title>STARFALL · ${ARCADE_NAME}</title>`]);
});
