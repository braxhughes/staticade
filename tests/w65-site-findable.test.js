// staticade.com is findable on search engines. Every page says what it is in standard head tags, the lobby names the site for
// Google, the games describe themselves as VideoGame, robots.txt points at a sitemap that lists exactly the deployed pages,
// and the deploy script ships both files. Head tags are read from the live DOM in headless Chrome, not only from file text.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://staticade.com';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml' };
// file -> the clean address the live site serves it at (/starfall.html redirects to /starfall)
const PAGES = { 'index.html': '/', 'starfall.html': '/starfall', 'stacklight.html': '/stacklight' };
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let server, base, browser;
before(async () => {
  server = http.createServer((req, res) => {
    const f = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle'] });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

async function headOf(file) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 } });
  await page.goto(base + '/' + file, { waitUntil: 'domcontentloaded' });
  const h = await page.evaluate(() => {
    const m = sel => { const e = document.querySelector(sel); return e ? e.getAttribute('content') : null; };
    return {
      lang: document.documentElement.lang, title: document.title,
      description: m('meta[name="description"]'),
      canonical: (document.querySelector('link[rel="canonical"]') || {}).href || null,
      ogTitle: m('meta[property="og:title"]'), ogDescription: m('meta[property="og:description"]'),
      ogUrl: m('meta[property="og:url"]'), ogType: m('meta[property="og:type"]'), ogSite: m('meta[property="og:site_name"]'),
      twCard: m('meta[name="twitter:card"]'), twTitle: m('meta[name="twitter:title"]'), twDescription: m('meta[name="twitter:description"]'),
      ld: [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent),
      noscript: document.querySelector('noscript') ? document.querySelector('noscript').textContent : ''
    };
  });
  await page.close();
  // The lobby script sets document.title = ARCADE_NAME at run time (arcade/lobby.js:31, outside this card), so the title
  // a no-JS crawler reads is the one in the served HTML. Check that one; the live one is checked to still name the arcade.
  h.liveTitle = h.title;
  h.title = (read(file).match(/<title>([^<]*)<\/title>/) || [])[1];
  return h;
}

for (const [file, url] of Object.entries(PAGES)) {
  test(`w65: ${file} head tags in the live DOM`, async () => {
    const h = await headOf(file);
    assert.equal(h.lang, 'en');
    assert.ok(h.liveTitle.includes('STATICADE'), 'live title still names the arcade: ' + h.liveTitle);
    assert.ok(h.ogTitle.length >= 9 && h.ogTitle.length <= 70, 'title length: ' + h.ogTitle);
    assert.ok(h.description && h.description.length >= 50 && h.description.length <= 200, 'description: ' + h.description);
    assert.equal(h.canonical, SITE + url);
    assert.equal(h.ogUrl, SITE + url);
    assert.ok(h.ogTitle.includes(h.title), 'og:title carries the page title');
    assert.equal(h.ogDescription, h.description);
    assert.equal(h.ogType, 'website');
    assert.equal(h.ogSite, 'Staticade');
    assert.equal(h.twCard, 'summary');
    assert.equal(h.twTitle, h.ogTitle);
    assert.equal(h.twDescription, h.description);
    assert.ok(!/<img|og:image/.test(read(file)), 'no image tags: there are no image files');
    assert.equal(h.ld.length, 1);
    assert.ok(h.noscript.length > 40, 'a text fallback for people and crawlers with JavaScript off');
  });
}

test('w65: titles name the page and the arcade', async () => {
  const t = Object.fromEntries(await Promise.all(Object.keys(PAGES).map(async f => [f, (await headOf(f)).title])));
  // The lobby <title> stays exactly the arcade name (the owner's call, and tests/w41-titles.test.js pins it); the
  // descriptive line lives in og:title and twitter:title.
  assert.equal(t['index.html'], 'STATICADE');
  assert.equal((await headOf('index.html')).ogTitle, 'STATICADE: free arcade games in your browser');
  assert.equal(t['starfall.html'], 'STARFALL · STATICADE');
  assert.equal(t['stacklight.html'], 'STACKLIGHT · STATICADE');
  assert.equal(new Set(Object.values(t)).size, 3, 'three different titles');
});

test('w65: lobby JSON-LD is a WebSite with the site name', async () => {
  const j = JSON.parse((await headOf('index.html')).ld[0]);
  assert.equal(j['@context'], 'https://schema.org');
  assert.equal(j['@type'], 'WebSite');
  assert.equal(j.name, 'Staticade');
  assert.equal(j.alternateName, 'STATICADE');
  assert.equal(j.url, SITE + '/');
});

for (const [file, name, genre] of [['starfall.html', 'Starfall', 'Fixed shooter'], ['stacklight.html', 'Stacklight', 'Puzzle']]) {
  test(`w65: ${file} JSON-LD is a free web VideoGame`, async () => {
    const h = await headOf(file), j = JSON.parse(h.ld[0]);
    assert.equal(j['@context'], 'https://schema.org');
    assert.equal(j['@type'], 'VideoGame');
    assert.equal(j.name, name);
    assert.equal(j.description, h.description);
    assert.equal(j.url, SITE + PAGES[file]);
    assert.equal(j.genre, genre);
    assert.equal(j.gamePlatform, 'Web browser');
    assert.equal(j.isAccessibleForFree, true);
    assert.equal(j.offers.price, '0');
  });
}

test('w65: the lobby text fallback links both games', async () => {
  const n = (await headOf('index.html')).noscript;
  assert.ok(n.includes('/starfall') || /href="\/starfall"/.test(read('index.html')));
  assert.match(read('index.html'), /<noscript>[\s\S]*href="\/starfall"[\s\S]*href="\/stacklight"[\s\S]*<\/noscript>/);
});

test('w65: sitemap.xml is valid and lists exactly the deployed pages', () => {
  const x = read('sitemap.xml');
  assert.match(x, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(x, /<\/urlset>\s*$/);
  const opens = x.match(/<url>/g) || [], closes = x.match(/<\/url>/g) || [];
  assert.equal(opens.length, closes.length);
  const locs = [...x.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);
  assert.deepEqual(locs, Object.values(PAGES).map(u => SITE + u));
  assert.equal(opens.length, locs.length);
  assert.ok(!/[&](?!amp;|lt;|gt;|quot;|apos;)/.test(x), 'unescaped ampersand');
  // every listed page is a file the deploy ships and is that page's canonical
  for (const f of Object.keys(PAGES)) assert.ok(deployPaths().includes(f), f + ' is deployed');
});

test('w65: robots.txt allows all and names the sitemap', () => {
  const r = read('robots.txt').split('\n');
  assert.ok(r.includes('User-agent: *'));
  assert.ok(r.includes('Allow: /'));
  assert.ok(!r.some(l => /^Disallow:\s*\S/.test(l)), 'nothing is disallowed');
  assert.ok(r.includes('Sitemap: ' + SITE + '/sitemap.xml'));
});

function deployPaths() {
  const m = read('tools/deploy-site.sh').match(/^PATHS=\(([^)]*)\)/m);
  assert.ok(m, 'PATHS line');
  return m[1].trim().split(/\s+/);
}
test('w65: deploy-site.sh ships robots.txt and sitemap.xml', () => {
  const p = deployPaths();
  assert.ok(p.includes('robots.txt'));
  assert.ok(p.includes('sitemap.xml'));
  for (const f of p) assert.ok(fs.existsSync(path.join(root, f)), f + ' exists');
});

// The text fallback is what a person with JavaScript off actually sees: on screen at desktop and phone sizes, visible,
// readable, on top of the (blank) canvas, with working links. Nothing about it is for crawlers only.
const FALLBACK_LINKS = { 'index.html': ['/starfall', '/stacklight'], 'starfall.html': ['/', '/stacklight'], 'stacklight.html': ['/', '/starfall'] };
for (const [w, h] of [[1000, 750], [390, 844]]) {
  for (const file of Object.keys(PAGES)) {
    test(`w65: ${file} text fallback is on screen with JavaScript off at ${w}x${h}`, async () => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, javaScriptEnabled: false });
      const page = await ctx.newPage();
      await page.goto(base + '/' + file, { waitUntil: 'load' });
      // page.evaluate still runs with page scripts off; only the page's own scripts are blocked
      const r = await page.evaluate(() => {
        const box = el => { const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
        const seen = el => el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true });
        const rgba = c => (c.match(/[\d.]+/g) || []).map(Number);
        // every line box of the element (a link can wrap onto two lines) has its centre hit the element itself
        const onTop = el => [...el.getClientRects()].every(b => { const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return !!hit && (hit === el || el.contains(hit)); });
        const div = document.querySelector('noscript > div');
        if (!div) return null;
        const cs = getComputedStyle(div);
        const texts = [...div.querySelectorAll('h1, p, li')].map(e => ({ box: box(e), seen: seen(e), onTop: onTop(e), color: rgba(getComputedStyle(e).color), text: e.innerText.trim() }));
        const links = [...div.querySelectorAll('a[href]')].map(a => ({ href: a.getAttribute('href'), box: box(a), seen: seen(a), onTop: onTop(a), color: rgba(getComputedStyle(a).color) }));
        return { vw: innerWidth, vh: innerHeight, box: box(div), seen: seen(div), bg: rgba(cs.backgroundColor), fontPx: parseFloat(cs.fontSize), texts, links, text: div.innerText };
      });
      await ctx.close();
      assert.ok(r, 'the fallback is parsed as elements with JavaScript off');
      const inside = (b, what) => {
        assert.ok(b.w > 0 && b.h > 0, what + ' has a size: ' + JSON.stringify(b));
        assert.ok(b.x >= 0 && b.y >= 0 && b.r <= r.vw && b.b <= r.vh, what + ' is inside the ' + r.vw + 'x' + r.vh + ' viewport: ' + JSON.stringify(b));
      };
      inside(r.box, 'fallback');
      assert.ok(r.seen, 'fallback is visible (not display:none, visibility:hidden or opacity 0)');
      assert.ok(r.fontPx >= 14, 'readable font size: ' + r.fontPx);
      // an opaque dark background, so the text never sits on anything but black
      assert.ok(r.bg.length >= 3 && (r.bg.length === 3 || r.bg[3] === 1) && r.bg[0] + r.bg[1] + r.bg[2] < 60, 'opaque dark background: ' + r.bg);
      const bright = (c, what) => assert.ok((c.length === 3 || c[3] === 1) && c[0] + c[1] + c[2] >= 400, what + ' is a bright, opaque colour: ' + c);
      assert.ok(r.texts.length >= 2, 'a heading and at least one line of text');
      for (const t of r.texts) {
        assert.ok(t.text.length > 0, 'no empty text block');
        inside(t.box, 'text "' + t.text.slice(0, 30) + '"');
        assert.ok(t.seen && t.onTop, 'text "' + t.text.slice(0, 30) + '" is visible and not covered');
        bright(t.color, 'text "' + t.text.slice(0, 30) + '"');
      }
      assert.ok(r.text.length > 60, 'says what the page is');
      assert.deepEqual(r.links.map(l => l.href).sort(), FALLBACK_LINKS[file].slice().sort(), 'the fallback links');
      for (const l of r.links) {
        inside(l.box, 'link ' + l.href);
        assert.ok(l.seen && l.onTop, 'link ' + l.href + ' is visible and clickable (nothing covers it)');
        bright(l.color, 'link ' + l.href);
      }
    });
  }
}

test('w65: with JavaScript on, the text fallback is not rendered', async () => {
  for (const file of Object.keys(PAGES)) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 750 } });
    await page.goto(base + '/' + file, { waitUntil: 'domcontentloaded' });
    const r = await page.evaluate(() => ({ kids: document.querySelector('noscript').children.length, div: !!document.querySelector('noscript > div') }));
    await page.close();
    assert.deepEqual(r, { kids: 0, div: false }, file + ': the noscript content stays inert text when scripts run');
  }
});

// Structured data makes no claims the site cannot back: no ratings or reviews exist, so none may be declared.
// "rating" or "review" as a word of the key (aggregateRating, review, reviewRating), not inside one (operatingSystem)
const RATED = /^(rating|review)|Rating|Review/;
test('w65: JSON-LD declares no ratings or reviews', () => {
  const bad = [];
  const walk = (v, where) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, where + '[' + i + ']'));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (RATED.test(k)) bad.push(where + '.' + k);
        if (k === '@type' && RATED.test(String(x))) bad.push(where + ' @type ' + x);
        walk(x, where + '.' + k);
      }
    }
  };
  for (const file of Object.keys(PAGES)) {
    const blocks = [...read(file).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.ok(blocks.length >= 1, file + ' has JSON-LD');
    blocks.forEach((b, i) => walk(JSON.parse(b), file + '#' + i));
  }
  assert.deepEqual(bad, []);
});
