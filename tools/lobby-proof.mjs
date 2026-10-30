// Proof checks for the lobby handoff and the Starfall intro regression.
// Usage: node tools/lobby-proof.mjs <outDir> [baselineBase]
//   handoff : last lobby frame vs Starfall's first frame (pixel diff)
//   regress : starfall.html here vs a baseline server (e.g. another copy of the site on another port), seeded Math.random
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [outDir = 'shots', baseline] = process.argv.slice(2);
const HERE = 'http://localhost:8782';
fs.mkdirSync(outDir, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle'] });
const seeded = `(() => { let s = 12345; Math.random = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296; })();`;

async function diff(fa, fb) {
  const p = await browser.newPage();
  const a = fs.readFileSync(fa).toString('base64'), b = fs.readFileSync(fb).toString('base64');
  const r = await p.evaluate(async ([a, b]) => {
    const load = s => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + s; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height;
    const x = c.getContext('2d'); x.drawImage(ia, 0, 0); const da = x.getImageData(0, 0, c.width, c.height).data;
    x.drawImage(ib, 0, 0); const db = x.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, over = 0, max = 0, n = c.width * c.height;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]));
      sum += d; if (d > 12) over++; if (d > max) max = d;
    }
    return { meanAbs: +(sum / n).toFixed(4), pctOver12: +(100 * over / n).toFixed(3), max };
  }, [a, b]);
  await p.close(); return r;
}

// 1. handoff
{
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 } });
  await page.goto(HERE + '/index.html'); await page.waitForTimeout(1200);
  await page.evaluate('LOBBY.manualHandoff(true)'); await page.evaluate('LOBBY.select()');
  await page.waitForFunction('LOBBY.info().handoffReady'); await page.waitForTimeout(200);
  const A = path.join(outDir, 'handoff_a_lobby_last.png'); await page.screenshot({ path: A });
  await page.evaluate('LOBBY.proceed()');
  await page.waitForFunction('window.SF && SF.info().state === "cabinet"');
  const B = path.join(outDir, 'handoff_b_starfall_first.png'); await page.screenshot({ path: B });
  console.log('handoff diff', JSON.stringify(await diff(A, B)));
  await page.close();
}
// 2. Starfall alone vs baseline.
// Run order changes the first-load pixels a little (shader/GPU warm-up), so: (a) load both servers' starfall.html once
// and throw it away (warm-up), then (b) measure a noise floor = here vs here (same page, captured twice), and
// report here-vs-baseline next to it. A real change must clearly exceed the noise floor.
if (baseline) {
  const shot = async (base, name, sec, file) => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 750 } });
    await page.addInitScript(seeded);
    await page.clock.install({ time: 0 });   // virtual time: both pages see identical frames
    await page.goto(base + '/starfall.html'); await page.clock.runFor(1000);
    if (sec != null) { await page.evaluate(`SF.introAt(${sec})`); await page.clock.runFor(300); }
    await page.screenshot({ path: file }); await page.close(); return file;
  };
  for (const base of [HERE, baseline]) await shot(base, 'warm', null, path.join(outDir, 'warmup_discard.png'));
  for (const [name, sec] of [['coin', null], ['pan', 2.4]]) {
    const f = t => path.join(outDir, `starfall_${name}_${t}.png`);
    await shot(HERE, name, sec, f('here')); await shot(baseline, name, sec, f('base')); await shot(HERE, name, sec, f('here2'));
    console.log(`starfall ${name} noise floor (here vs here, same code)`, JSON.stringify(await diff(f('here'), f('here2'))));
    console.log(`starfall ${name} here vs baseline`, JSON.stringify(await diff(f('here'), f('base'))));
  }
}
await browser.close();
