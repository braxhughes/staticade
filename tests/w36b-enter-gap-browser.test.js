// Enter move, browser half (playwright, headless Chrome, the real index.html): every frame of the Enter move reads as one row
// closing up around the selected cabinet, from the start of the move, not only from its middle;
// and the COMING SOON poster is drawn on the boards of the machines that are not playable, never on Starfall's.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { staticServer } from './w25-helpers.mjs';

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });

async function open(width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(web.url + 'index.html');
  await page.waitForFunction(() => window.LOBBY);
  await page.evaluate(async () => {
    LOBBY.wordmarkSkip(); LOBBY.manualHandoff(true);
    window.__frames = k => new Promise(r => { let f = 0; const t = () => { if (++f >= k) r(); else requestAnimationFrame(t); }; requestAnimationFrame(t); });
    await __frames(70);
  });
  return { ctx, page, errors };
}

// the move is closed up to at most one cabinet width from this point of it on
const CLOSED_BY = 0.2;
const STEP = 0.05;

// freeze the Enter move at every q in 0..1 (STEP apart) and read the cabinets' screen boxes from the frames after each
const sweep = page => page.evaluate(async step => {
  const out = [];
  for (let i = 0; i <= Math.round(1 / step); i++) {
    const q = Math.min(i * step, 0.999);
    LOBBY.swingAt(q); await __frames(3);
    out.push({ q, r: LOBBY.rowBoxes() });
  }
  return out;
}, STEP);
// neighbouring cabinets left to right: the gaps between them (negative: they overlap on screen)
function gaps(r) {
  const bs = r.boxes.slice().sort((a, b) => a.x0 - b.x0), g = [];
  for (let i = 1; i < bs.length; i++) g.push({ a: bs[i - 1], b: bs[i], gap: bs[i].x0 - bs[i - 1].x1 });
  return g;
}

const SIZES = [[1000, 650], [1440, 900], [1820, 1100], [1000, 750], [390, 844]];
for (const [w, h] of SIZES) {
  test(`w36b: Enter at ${w}x${h}: the row closes up from the start, steadily, without cabinets overlapping`, async () => {
    const { ctx, page, errors } = await open(w, h);
    const sel = await page.evaluate(() => LOBBY.info().index);
    const frames = await sweep(page);
    let prev = null;
    for (const { q, r } of frames) {
      assert.equal(r.mode, 'swing', `q=${q.toFixed(2)}: still the Enter move`);
      assert.equal(r.sel, sel);
      const s = r.boxes[r.sel], cw = s.x1 - s.x0, g = gaps(r), widest = Math.max(...g.map(x => x.gap));
      // (c) no two cabinets overlap on screen at any q
      for (const x of g) assert.ok(x.gap >= 0, `q=${q.toFixed(2)}: ${x.a.id} (${x.a.x0.toFixed(1)}..${x.a.x1.toFixed(1)}) overlaps ${x.b.id} (${x.b.x0.toFixed(1)}..${x.b.x1.toFixed(1)})`);
      // (a) from CLOSED_BY on, no empty gap in the row wider than one cabinet
      if (q >= CLOSED_BY - 1e-9) assert.ok(widest <= cw, `q=${q.toFixed(2)}: a ${widest.toFixed(1)} wide gap in the row (one cabinet is ${cw.toFixed(1)})`);
      // (b) after q=0.05 the widest gap never grows from one step to the next (0.25 field units of slack for rounding)
      if (prev && q > 0.05 + 1e-9) assert.ok(widest <= prev.widest + 0.25, `q=${q.toFixed(2)}: the widest gap grew from ${prev.widest.toFixed(1)} to ${widest.toFixed(1)}`);
      prev = { widest };
    }
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('w36b: the COMING SOON poster is drawn on STACKLIGHT and LEDGE LORDS boards and not on STARFALL', async () => {
  const { ctx, page, errors } = await open(1000, 750);
  const ids = await page.evaluate(() => LOBBY.info().ids);
  const playable = { stacklight: false, starfall: true, ledgelords: false };
  const seen = {};
  for (let i = 0; i < ids.length; i++) {
    seen[ids[i]] = await page.evaluate(async i => { LOBBY.go(i); await __frames(90); return { shown: LOBBY.posterShown(), id: LOBBY.info().id }; }, i);
    assert.equal(seen[ids[i]].id, ids[i]);
  }
  assert.deepEqual(Object.keys(playable).sort(), ids.slice().sort(), 'the machine list this test knows');
  for (const id of ids) assert.deepEqual(seen[id].shown, playable[id] ? [] : [id], `${id}: posters drawn ${JSON.stringify(seen[id].shown)}`);
  assert.deepEqual(errors, []);
  await ctx.close();
});
