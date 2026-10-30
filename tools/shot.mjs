// Headless browser check: load a page at 1000x750, run steps, save screenshots, report console.
// Usage: node tools/shot.mjs <url> <outDir> [steps.json]
// steps.json: [{"js":"SF.start(1)"}, {"wait":500}, {"key":"Enter"}, {"shot":"name"}]
// Prints console errors/warnings and exits 1 on any page error or non-favicon console error.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [url, outDir = 'shots', stepsFile] = process.argv.slice(2);
if (!url) { console.error('usage: node tools/shot.mjs <url> <outDir> [steps.json]'); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });
const steps = stepsFile ? JSON.parse(fs.readFileSync(stepsFile, 'utf8')) : [{ wait: 1500 }, { shot: 'load' }];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 750 } });
const problems = [];
page.on('console', m => {
  const t = m.type(), s = m.text();
  if (t === 'error' && !/favicon|404 \(File not found\)|Failed to load resource/.test(s)) problems.push(`console.${t}: ${s}`);
  if (t === 'error' || t === 'warning') console.log(`[${t}] ${s}`);
});
page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) problems.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(url, { waitUntil: 'load' });
for (const s of steps) {
  if (s.wait) await page.waitForTimeout(s.wait);
  if (s.key) await page.keyboard.press(s.key);
  if (s.down) await page.keyboard.down(s.down);
  if (s.up) await page.keyboard.up(s.up);
  if (s.click) await page.mouse.click(s.click[0], s.click[1]);
  if (s.js) { const r = await page.evaluate(s.js); if (r !== undefined) console.log(`js> ${s.js} => ${JSON.stringify(r)}`); }
  if (s.shot) { const f = path.join(outDir, s.shot + '.png'); await page.screenshot({ path: f }); console.log('shot', f); }
}
await browser.close();
if (problems.length) { console.log('PROBLEMS:\n' + problems.join('\n')); process.exit(1); }
console.log('OK: no page errors');
