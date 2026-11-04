// Renders every README picture with Staticade's own dot renderer (engine/gl-dots.js, engine/font.js, engine/crt.js)
// in headless Chrome, so the README matches the site: same dots, glow and CRT pass.
// Also shoots the real lobby as the hero image.
// Usage, from the repo root: node tools/readme/render.mjs .   (ONLY=stats,cards to render a few)
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath, pathToFileURL } from 'node:url';
import { SCENES } from './scenes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(process.argv[2] || '');
const out = path.resolve(process.argv[3] || path.join(repo, 'docs', 'media'));
if (!fs.existsSync(path.join(repo, 'engine', 'gl-dots.js'))) { console.error('usage: node render.mjs <staticade repo> [outDir]'); process.exit(2); }
fs.mkdirSync(out, { recursive: true });
const { chromium } = await import(pathToFileURL(path.join(repo, 'node_modules', 'playwright', 'index.mjs')).href);

// static server: /__readme/page.html from here, everything else from the repo
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]); if (rel.endsWith('/')) rel += 'index.html';
  const base = rel.startsWith('/__readme/') ? here : repo;
  const file = path.join(base, path.normalize(rel.replace(/^\/__readme\//, '/')));
  if (!file.startsWith(base)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (e, d) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(d); });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle'] });
const problems = [];
const only = process.env.ONLY ? process.env.ONLY.split(',') : null;

for (const s of SCENES) {
  if (only && !only.includes(s.name)) continue;
  const dpr = 2, cssW = Math.round(s.px / dpr), cssH = Math.round(cssW * s.H / s.W);
  const page = await browser.newPage({ viewport: { width: cssW, height: cssH }, deviceScaleFactor: dpr });
  page.on('pageerror', e => problems.push(`${s.name}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) problems.push(`${s.name}: ${m.text()}`); });
  await page.addInitScript(sc => { window.__SCENE = sc; }, s);
  await page.goto(`${origin}/__readme/page.html`);
  const info = await page.waitForFunction(() => window.__DONE, null, { timeout: 15000 }).then(h => h.jsonValue());
  await page.screenshot({ path: path.join(out, s.name + '.png') });
  console.log(`${s.name}.png  ${info.w}x${info.h}  ${info.dots} dots`);
  await page.close();
}

// hero: the real lobby, as the site draws it
if (!only || only.includes('lobby')) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 675 }, deviceScaleFactor: 2 });
  page.on('pageerror', e => problems.push(`lobby: ${e.message}`));
  await page.goto(`${origin}/index.html`);
  await page.waitForFunction(() => window.LOBBY && window.LOBBY.info().mode === 'lobby', null, { timeout: 20000 });
  await page.waitForTimeout(+(process.env.LOBBY_WAIT || 2500));
  await page.screenshot({ path: path.join(out, 'staticade-lobby.png') });
  console.log('staticade-lobby.png  2400x1350  (real lobby)');
  await page.close();
}

await browser.close(); server.close();
if (problems.length) { console.log('PROBLEMS:\n' + problems.join('\n')); process.exit(1); }
console.log('OK: no page errors');
