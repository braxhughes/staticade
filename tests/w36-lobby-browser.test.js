// Lobby polish, browser half (playwright, headless Chrome): the Enter move closes the row up around the selected
// cabinet and ends centred on it at every window shape the owner plays at; lobby behaviour that had no other test
// (neighbours flush while one is selected; LOBBY.reset() back to the lobby swung open with the board read again).
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
// freeze the Enter move at q and read the cabinets' screen boxes from the next frames
const boxesAt = (page, q) => page.evaluate(async q => { LOBBY.swingAt(q); await __frames(3); return LOBBY.rowBoxes(); }, q);
const centre = b => (b.x0 + b.x1) / 2;
// widest empty gap between neighbouring cabinets (sorted left to right) on screen
function widestGap(r) {
  const bs = r.boxes.slice().sort((a, b) => a.x0 - b.x0);
  let g = -1e9; for (let i = 1; i < bs.length; i++) g = Math.max(g, bs[i].x0 - bs[i - 1].x1);
  return g;
}

const SIZES = [[1000, 650], [1200, 700], [1440, 900], [1820, 1100], [1000, 750]];
for (const [w, h] of SIZES) {
  test(`w36: Enter at ${w}x${h} closes the row up and ends centred on the selected cabinet`, async () => {
    const { ctx, page, errors } = await open(w, h);
    const sel = await page.evaluate(() => LOBBY.info().index);
    // over the second half of the move every frame reads as one row: no empty gap wider than one cabinet
    for (let q = 0.5; q < 0.999; q += 0.05) {
      const r = await boxesAt(page, q), sb = r.boxes[r.sel], cw = sb.x1 - sb.x0;
      assert.equal(r.sel, sel);
      const g = widestGap(r);
      assert.ok(g <= cw, `q=${q.toFixed(2)}: a ${g.toFixed(1)} wide gap in the row (one cabinet is ${cw.toFixed(1)})`);
    }
    // the slide's end: the selected cabinet sits at the screen's centre and its neighbours stand symmetric about it
    const end = await boxesAt(page, 0.999), s = end.boxes[end.sel], L = end.boxes[end.sel - 1], R = end.boxes[end.sel + 1];
    const tol = 0.03 * 400;
    assert.ok(Math.abs(centre(s) - end.cx) < tol, `selected centre ${centre(s).toFixed(1)} vs screen centre ${end.cx}`);
    assert.ok(Math.abs((centre(s) - centre(L)) - (centre(R) - centre(s))) < tol, `neighbours not symmetric: ${centre(L).toFixed(1)} ${centre(s).toFixed(1)} ${centre(R).toFixed(1)}`);
    assert.ok(widestGap(end) <= (s.x1 - s.x0) * 0.5, 'the row is closed at the end');
    // and the dolly starts from that same centred row
    const d = await page.evaluate(async () => { LOBBY.dollyAt(0); await __frames(3); return LOBBY.rowBoxes(); });
    const ds = d.boxes[d.sel];
    assert.ok(Math.abs(centre(ds) - d.cx) < tol, `dolly start: selected centre ${centre(ds).toFixed(1)}`);
    assert.ok(Math.abs(centre(ds) - centre(s)) < tol, 'no jump from the slide end to the dolly start');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('w36 (w31c): only the selected cabinet stands swung open; its neighbours stand flush', async () => {
  const { ctx, page, errors } = await open(1000, 750);
  for (const i of [0, 1, 2]) {
    const r = await page.evaluate(async i => { LOBBY.go(i); await __frames(70); return LOBBY.rowBoxes(); }, i);
    assert.equal(r.sel, i);
    for (const b of r.boxes) assert.equal(b.angle, b === r.boxes[i] ? 72 : 0, `${b.id} angle ${b.angle} with ${r.boxes[i].id} selected`);
  }
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('w36 (w31c): LOBBY.reset() returns to the lobby with the cabinet swung open at 72 degrees and the board read again', async () => {
  const { ctx, page, errors } = await open(1000, 750);
  const r = await page.evaluate(async () => {
    const before = LOBBY.board().reads;
    LOBBY.dollyAt(0.6); await __frames(5);
    const mid = LOBBY.info();
    const snap = await LOBBY.reset(); LOBBY.dollyAt(null); await __frames(5);
    return { before, mid, after: LOBBY.info(), reads: snap.reads, boxes: LOBBY.rowBoxes() };
  });
  assert.equal(r.mid.mode, 'dolly');
  assert.equal(r.after.mode, 'lobby');
  assert.equal(r.after.id, 'starfall');
  assert.equal(r.after.angle, 72);
  assert.ok(r.reads > r.before, `board reads ${r.before} -> ${r.reads}`);
  for (const b of r.boxes.boxes) if (b.id !== 'starfall') assert.equal(b.angle, 0);
  assert.deepEqual(errors, []);
  await ctx.close();
});
