import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../server/www/worker.js';

async function hit(url, init) {
  const res = await worker.fetch(new Request(url, init));
  return res;
}

const cases = [
  ['root', 'https://www.staticade.com/', undefined, 'https://staticade.com/'],
  ['path and query', 'https://www.staticade.com/starfall?x=1&y=2', undefined, 'https://staticade.com/starfall?x=1&y=2'],
  ['dot segments', 'https://www.staticade.com/a/b/../c', undefined, 'https://staticade.com/a/c'],
  ['encoded slash and unicode', 'https://www.staticade.com/a%2Fb/caf%C3%A9/é?q=%2F', undefined, 'https://staticade.com/a%2Fb/caf%C3%A9/%C3%A9?q=%2F'],
  ['double slash host', 'https://www.staticade.com//evil.com', undefined, 'https://staticade.com//evil.com'],
  ['backslash host', 'https://www.staticade.com/\\evil.com', undefined, 'https://staticade.com//evil.com'],
  ['encoded double slash', 'https://www.staticade.com/%2F%2Fevil.com', undefined, 'https://staticade.com/%2F%2Fevil.com'],
  ['POST', 'https://www.staticade.com/submit?a=1', { method: 'POST', body: 'x' }, 'https://staticade.com/submit?a=1'],
  ['HEAD', 'https://www.staticade.com/starfall', { method: 'HEAD' }, 'https://staticade.com/starfall'],
  ['evil Host header', 'https://www.staticade.com/p?z=9', { headers: { host: 'evil.com' } }, 'https://staticade.com/p?z=9'],
  ['absolute-form other host', 'http://evil.com/p?z=9', undefined, 'https://staticade.com/p?z=9'],
  ['query only', 'https://www.staticade.com/?a=1&a=2&b=%20', undefined, 'https://staticade.com/?a=1&a=2&b=%20'],
];

for (const [name, url, init, expected] of cases) {
  test(`301 to exact Location: ${name}`, async () => {
    const res = await hit(url, init);
    assert.equal(res.status, 301);
    const loc = res.headers.get('location');
    assert.equal(loc, expected);
    assert.equal(new URL(loc).host, 'staticade.com');
    assert.equal(new URL(loc).protocol, 'https:');
    assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
  });
}

const TOML_URL = new URL('../server/www/wrangler.toml', import.meta.url);

async function configLines() {
  const { readFile } = await import('node:fs/promises');
  const text = await readFile(TOML_URL, 'utf8');
  // comments and blank lines dropped; everything else must match the pinned config exactly
  return text.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
}

test('deploy config: exact name, main, workers_dev, one route, nothing else', async () => {
  const lines = await configLines();
  const keyed = (k) => lines.filter((l) => new RegExp(`^${k}\\s*=`).test(l));
  assert.deepEqual(keyed('name'), ['name = "staticade-www"']);
  assert.deepEqual(keyed('main'), ['main = "worker.js"']);
  assert.deepEqual(keyed('workers_dev'), ['workers_dev = false']);
  assert.equal(lines.filter((l) => /^\[/.test(l)).length, 0, 'no tables: no [assets], [[routes]], [vars]');
  assert.equal(lines.filter((l) => /^routes?\s*=/.test(l) || l.includes('pattern')).length, 2, 'one routes key and one pattern line');
  assert.equal(lines.join('\n').match(/pattern/g).length, 1, 'exactly one pattern');
  assert.ok(lines.includes('{ pattern = "www.staticade.com", custom_domain = true }'), 'the one route is www.staticade.com custom domain');
  assert.equal(lines.join('\n').match(/staticade\.com/g).length, 1, 'staticade.com appears only in the www route');
});

test('deploy config: whole file equals the pinned config', async () => {
  assert.deepEqual(await configLines(), [
    'name = "staticade-www"',
    'main = "worker.js"',
    'compatibility_date = "2026-10-01"',
    'workers_dev = false',
    'routes = [',
    '{ pattern = "www.staticade.com", custom_domain = true }',
    ']',
  ]);
});
