import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import worker from '../server/www/worker.js';
import { ARCADE_NAME } from '../arcade/brand.js';

const base = 'https://' + ARCADE_NAME.toLowerCase() + '.com';
const workerSrc = new URL('../server/www/worker.js', import.meta.url);

const cases = [
  ['root', 'https://www.example.test/', undefined, '/'],
  ['path and query', 'https://www.example.test/starfall?x=1', undefined, '/starfall?x=1'],
  ['encoded slash', 'https://www.example.test/a%2Fb?q=%2F', undefined, '/a%2Fb?q=%2F'],
  ['double slash path', 'https://www.example.test//evil.example/', undefined, '//evil.example/'],
  ['other Host header', 'https://www.example.test/p?z=9', { headers: { host: 'evil.example' } }, '/p?z=9'],
  ['other host in the URL', 'http://evil.example/p?z=9', undefined, '/p?z=9'],
];

for (const [name, url, init, tail] of cases) {
  test(`301 to the brand-built target: ${name}`, async () => {
    const res = await worker.fetch(new Request(url, init));
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), base + tail);
  });
}

test('TARGET follows the brand name: worker loaded against a stub brand module', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w38c-'));
  try {
    fs.mkdirSync(path.join(dir, 'server', 'www'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'arcade'));
    fs.writeFileSync(path.join(dir, 'arcade', 'brand.js'), "export const ARCADE_NAME = 'ZigZag-9';\n");
    const copy = path.join(dir, 'server', 'www', 'worker.js');
    fs.copyFileSync(workerSrc, copy);
    const stub = (await import(pathToFileURL(copy).href)).default;
    const res = await stub.fetch(new Request('https://www.example.test/starfall?x=1'));
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), 'https://zigzag-9.com/starfall?x=1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
