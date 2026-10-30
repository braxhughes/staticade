// our own HUD labels, no "A LANTERN CAT ARCADE", daily label clear of the chain readout.
// 1. Sources no longer carry the old strings. 2. Real starfall.html in headless Chrome: the HUD draws SCORE and BEST,
// the default best is 10000, a stored best wins, the extra-life popup says EXTRA LIFE, the title has no arcade subtitle.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { textW } from '../engine/font.js';
import { ROOT, staticServer, openGame, toTitle, texts, clearTexts, shot } from './w25-helpers.mjs';

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(js|mjs|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('w27 labels: sources', () => {
  const files = [...walk(path.join(ROOT, 'games')), ...walk(path.join(ROOT, 'arcade')), path.join(ROOT, 'starfall.html'), path.join(ROOT, 'index.html')];
  const src = f => fs.readFileSync(f, 'utf8');
  test('no "lantern cat" or "hi score" in any game or arcade source (any case)', () => {
    for (const f of files) assert.ok(!/lantern cat|hi score/i.test(src(f)), path.relative(ROOT, f));
  });
  test('"1UP" is not drawn text (only the sim constant name POP_1UP may contain it)', () => {
    for (const f of files) assert.ok(!/['"`]1UP['"`]/.test(src(f)), path.relative(ROOT, f));
  });
  test('the old title strings are gone: no "HIGH SCORE", no drawn "HI " + number', () => {
    for (const f of files) {
      const t = src(f);
      assert.ok(!/high score/i.test(t), 'HIGH SCORE in ' + path.relative(ROOT, f));
      assert.ok(!/['"`]HI ['"`]\s*\+/.test(t), 'drawn "HI " + number in ' + path.relative(ROOT, f));
    }
    const title = src(path.join(ROOT, 'games/starfall/title.js'));
    assert.ok(/'BEST FLIGHT'\]/.test(title) && /text\('BEST ' \+ ui\.hi/.test(title), 'title menu and line use BEST');
  });
  test('the default best is not 20000', () => {
    assert.ok(!/hi:\s*20000/.test(src(path.join(ROOT, 'games/starfall/main.js'))));
    assert.ok(/hi:\s*10000/.test(src(path.join(ROOT, 'games/starfall/main.js'))));
  });
});

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

describe('w27 labels: in a real browser', { concurrency: true }, () => {
  test('HUD shows SCORE and BEST, default best 10000, and no old labels; title has no arcade subtitle', { timeout: 120000 }, async () => {
    const { ctx, page, problems } = await openGame(browser, web.url);
    try {
      await toTitle(page);
      const title = await texts(page);
      assert.ok(!title.some(s => /LANTERN|ARCADE/.test(s)), 'title: ' + JSON.stringify(title));
      await shot(page, 'title');
      await clearTexts(page);
      await page.evaluate(() => SF.start(1));
      await page.waitForFunction(() => SF.state === 'play', null, { timeout: 30000 });
      await page.evaluate(() => { for (let i = 0; i < 90; i++) SF.autoFire(1); });
      await page.waitForTimeout(600);
      const t = await texts(page);
      assert.ok(t.includes('SCORE'), 'SCORE drawn');
      assert.ok(t.includes('BEST'), 'BEST drawn');
      assert.ok(t.includes('10000'), 'default best 10000 drawn');
      assert.ok(!t.some(s => s === '1UP' || s === 'HI SCORE' || s === '20000'), 'no old labels: ' + JSON.stringify(t));
      await shot(page, 'hud');
      await page.evaluate(() => SF.fxTest('popup', 1, 250, 200, 0, 0x2ee6c8));
      await page.waitForTimeout(300);
      assert.ok((await texts(page)).includes('EXTRA LIFE'), 'popup text');
      await shot(page, 'extra-life');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test('a stored best overrides the default', { timeout: 120000 }, async () => {
    const { ctx, page, problems } = await openGame(browser, web.url, { init: ["try { localStorage.setItem('starfall.hi', '55555'); } catch (e) {}"] });
    try {
      await toTitle(page);
      await page.evaluate(() => SF.start(1));
      await page.waitForFunction(() => SF.state === 'play', null, { timeout: 30000 });
      await page.evaluate(() => { for (let i = 0; i < 30; i++) SF.autoFire(1); });
      await page.waitForTimeout(400);
      const t = await texts(page);
      assert.ok(t.includes('55555'), 'stored best drawn');
      assert.ok(!t.includes('10000'), 'default not drawn');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });
});

// A text tap that also records where each string is drawn (x, y, scale, align), so a test can build boxes.
const REC_TAP = 'return function text(str, x, y, col, sc, align, a, wave) {';
const fontSrc = fs.readFileSync(path.join(ROOT, 'engine/font.js'), 'utf8');
const recFont = fontSrc.replace(REC_TAP, REC_TAP + " (window.__rec || (window.__rec = new Map())).set(str + '|' + x + '|' + y, [str, x, y, sc || 1, align || 'l']);");
const recSetup = ctx => ctx.route('**/engine/font.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: recFont }));
const CX = 200, W = 400;
// box of one recorded string: same maths as engine/font.js text() (width = textW, height = 7 * scale)
function box([str, x, y, sc, align]) {
  const w = textW(str, sc), x0 = align === 'c' ? x - w / 2 : align === 'r' ? x - w : x;
  return { x0, x1: x0 + w, y0: y, y1: y + 7 * sc };
}
const hit = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
// the HUD zones the daily label must stay out of, from the constants in render/hud-chain.js and render/starlight.js:
// the CHAIN readout and its bar (x 8, y 21 to 33; "CHAIN BONUS +n" popups at y 36), BEST (centre, y 2 to 18), SCORE and its
// number (left, y 2 to 18), the six phrase pips and beat lights (CX +- 65, y 27 +- 4.5), the multiplier and boss name/HP bar (right, y 2 to 23)
const ZONES = {
  chain: { x0: 8, x1: 8 + 62 + textW('X3', 1), y0: 21, y1: 33 },
  chainBonus: { x0: 8, x1: 8 + textW('CHAIN BONUS +9999', 1), y0: 36, y1: 43 },
  best: { x0: CX - 40, x1: CX + 40, y0: 2, y1: 18 },
  score: { x0: 8, x1: 8 + textW('SCORE', 1) + 40, y0: 2, y1: 18 },
  pips: { x0: CX - 65, x1: CX + 65, y0: 22.5, y1: 31.5 },
  boss: { x0: W - 100, x1: W - 8, y0: 2, y1: 23 }
};

describe('w27 labels: the daily label (browser)', { concurrency: true }, () => {
  test('SCORE is drawn during play, past one blink cycle (not only in the intro)', { timeout: 120000 }, async () => {
    const { ctx, page, problems } = await openGame(browser, web.url);
    try {
      await toTitle(page);
      await page.evaluate(() => SF.start(1));
      await page.waitForFunction(() => SF.state === 'play', null, { timeout: 30000 });
      await clearTexts(page);
      await page.waitForTimeout(1200); // the label blinks on 26 of every 40 frames; 1.2 s is well over one cycle
      assert.equal(await page.evaluate(() => SF.state), 'play');
      const t = await texts(page);
      assert.ok(t.includes('SCORE'), 'SCORE drawn during play: ' + JSON.stringify(t));
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  for (const [mode, label] of [['daily', 'DAILY FLIGHT']]) {
    test('the ' + label + ' label sits clear of the chain readout, pips, BEST, SCORE and boss bar', { timeout: 120000 }, async () => {
      const { ctx, page, problems } = await openGame(browser, web.url, { tap: false, setup: recSetup });
      try {
        await toTitle(page);
        await page.evaluate(m => SF.mode(m), mode);
        await page.waitForFunction(() => { const r = SF.runInfo(); return r && r.claimed && (SF.state === 'play' || SF.state === 'intro'); }, null, { timeout: 30000 });
        await page.evaluate(() => { for (let i = 0; i < 90; i++) SF.autoFire(1); });
        await page.waitForTimeout(500);
        const rec = await page.evaluate(() => [...window.__rec.values()]);
        const lab = rec.filter(r => r[0] === 'DAILY FLIGHT' || r[0] === 'PRACTICE');
        assert.ok(lab.length >= 1, 'run label drawn: ' + JSON.stringify(rec.map(r => r[0])));
        const inHud = lab.filter(r => r[2] < 40 || r[2] > 260); // the in-run label; the entry screen's own line is elsewhere
        assert.ok(inHud.length >= 1, 'label position: ' + JSON.stringify(lab));
        for (const r of inHud) {
          const b = box(r);
          for (const [name, z] of Object.entries(ZONES)) assert.ok(!hit(b, z), `label ${JSON.stringify(r)} meets ${name}`);
          assert.ok(b.x0 >= 0 && b.x1 <= W && b.y0 >= 0 && b.y1 <= 300, 'label on screen');
        }
        assert.deepEqual(problems, []);
      } finally { await ctx.close(); }
    });
  }
});

// ---------- the daily label also stays clear of the heat flame, the kindle meter, the lives row and the badges ----------
// Zones from the draw code: render/hud-heat.js (flame root FX = CX - 22 + (METER_MAX - 1) * 5 + 11, FY = H - 4; at heat 100 the
// flame is 11 rows 1.6 apart, half-width up to 4 plus sway), render/core.js (lives from x 10, 11 apart, y H - 8, up to 6 ships;
// kindle dots CX - 22 + i * 5 at H - 7, wing-feed dot at CX - 26; stage badges from W - 8 leftwards to W - 90, y H - 8).
const FXZ = CX - 22 + (10 - 1) * 5 + 11, FYZ = 300 - 4;
const BOTTOM = {
  flame: { x0: FXZ - 7, x1: FXZ + 7, y0: FYZ - 11 * 1.6 - 2, y1: FYZ + 2 },
  meter: { x0: CX - 28, x1: CX + 24, y0: 300 - 7 - 3, y1: 300 - 7 + 3 },
  lives: { x0: 6, x1: 10 + 5 * 11 + 7, y0: 300 - 8 - 6, y1: 300 - 8 + 6 },
  badges: { x0: W - 92, x1: W - 2, y0: 300 - 8 - 6, y1: 300 - 8 + 6 }
};
// the same page with the flame reading its heat from window.__heat (presentation only: the sim is untouched, nothing is added to the game)
const heatSrc = fs.readFileSync(path.join(ROOT, 'games/starfall/render/hud-heat.js'), 'utf8');
const HEAT_TAP = 's = flameStep(sim.heat);';
const heatFlex = heatSrc.replace(HEAT_TAP, 's = flameStep(window.__heat != null ? window.__heat : sim.heat);');
const recAndHeat = async ctx => { await recSetup(ctx); await ctx.route('**/render/hud-heat.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: heatFlex })); };

describe('w29: the daily label and the bottom row (browser)', { concurrency: true }, () => {
  test('source: the flame still reads sim.heat in the shape the test taps', () => { assert.ok(heatSrc.includes(HEAT_TAP)); });

  test('the zones are real: at heat 100 the flame, the kindle meter and the lives row draw dots inside their zones', { timeout: 120000 }, async () => {
    const glSrc = fs.readFileSync(path.join(ROOT, 'engine/gl-dots.js'), 'utf8');
    const DOT = '  function dot(x, y, s, r, g, b, a) {';
    assert.ok(glSrc.includes(DOT), 'engine/gl-dots.js dot() entry');
    const tapped = glSrc.replace(DOT, DOT + ' if (window.__bd && y > 270) window.__bd.push([x, y]);');
    const { ctx, page, problems } = await openGame(browser, web.url, { tap: false, setup: async c => {
      await c.route('**/render/hud-heat.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: heatFlex }));
      await c.route('**/engine/gl-dots.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: tapped }));
    } });
    try {
      await toTitle(page);
      await page.evaluate(() => { window.__heat = 100; SF.start(1); });
      await page.waitForFunction(() => SF.state === 'play', null, { timeout: 30000 });
      await page.evaluate(() => { for (let i = 0; i < 60; i++) SF.autoFire(1); });
      await page.waitForTimeout(300);
      await page.evaluate(() => { window.__bd = []; });
      await page.waitForTimeout(200);
      const dots = await page.evaluate(() => window.__bd);
      const inZ = z => dots.filter(([x, y]) => x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1).length;
      assert.ok(inZ(BOTTOM.flame) > 20, 'flame dots in the flame zone: ' + inZ(BOTTOM.flame));
      assert.ok(inZ(BOTTOM.meter) >= 1, 'meter dots in the meter zone: ' + inZ(BOTTOM.meter));
      assert.ok(inZ(BOTTOM.lives) >= 1, 'reserve-ship dots in the lives zone: ' + inZ(BOTTOM.lives));
      // the flame reaches its top: some flame dot sits within 4 units of the zone's upper edge
      const top = Math.min(...dots.filter(([x]) => x > FXZ - 7 && x < FXZ + 7).map(d => d[1]));
      assert.ok(top <= BOTTOM.flame.y0 + 6, 'flame top at ' + top + ' vs zone top ' + BOTTOM.flame.y0);
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  for (const heat of [0, 30, 90, 100]) {
    test('the daily label is clear of the flame (heat ' + heat + '), the meter, the lives row and the badges', { timeout: 120000 }, async () => {
      const { ctx, page, problems } = await openGame(browser, web.url, { tap: false, setup: recAndHeat });
      try {
        await toTitle(page);
        await page.evaluate(h => { window.__heat = h; return SF.mode('daily'); }, heat);
        await page.waitForFunction(() => { const r = SF.runInfo(); return r && r.claimed && (SF.state === 'play' || SF.state === 'intro'); }, null, { timeout: 30000 });
        await page.evaluate(() => { for (let i = 0; i < 90; i++) SF.autoFire(1); });
        await page.waitForTimeout(500);
        const lab = (await page.evaluate(() => [...window.__rec.values()])).filter(r => (r[0] === 'DAILY FLIGHT' || r[0] === 'PRACTICE') && r[2] > 260);
        assert.ok(lab.length >= 1, 'in-run label drawn: ' + JSON.stringify(lab));
        for (const r of lab) {
          const b = box(r);
          for (const [name, z] of Object.entries(BOTTOM)) assert.ok(!hit(b, z), `label ${JSON.stringify(r)} meets ${name} at heat ${heat}`);
        }
        assert.deepEqual(problems, []);
      } finally { await ctx.close(); }
    });
  }
});
