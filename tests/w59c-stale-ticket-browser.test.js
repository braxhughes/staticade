// page half: the real starfall.html and stacklight.html in headless
// Chrome against the real leaderboard dev server (server/dev-server.mjs) with a random DAILY_SECRET. Localhost only.
// The page clock is moved with window.__skew (Date.now only; timers keep real time), so a test never waits minutes.
//   SF1 Starfall: a Daily with /submit blocked: the stored queue entry has a deadline from the real ticket and frames, not in body
//   SF2 Starfall: the page made visible again sends a due entry at once (its timer is still 80 s away)
//   SL1a/b/c STACKLIGHT Daily highlighted; started 59 s later on the cached ticket; 61 s later the page asks again (asking
//       state, a double Enter gives one ask and one run); a failed re-ask does not start the Daily
//   SL3 a practice Daily starts on the cached answer, offline; SL4 a start waiting on the re-ask does not fire under the table page
//   SL2 STACKLIGHT: Daily highlighted, started 15 minutes later: a second GET /daily, the run and the queued entry carry the new
//       ticket, the deadline is timed from it; then the visible page sends the due entry at once
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { staticServer, devServer, openGame, toTitle, playToEntry, WAIT } from './w25-helpers.mjs';
import { TICKET_GRACE_S, TICKET_SLACK_S, FPS } from '../leaderboard/ticket-window.js';
import { DEADLINE_MARGIN_MS, backoffMs } from '../games/starfall/submit-queue.js';
import { TICKET_FRESH_MS } from '../games/stacklight/modes.js';

const SKEW = `(() => { const realNow = Date.now.bind(Date); window.__skew = 0; Date.now = () => realNow() + window.__skew; })();`;
const issuedOf = ticket => parseInt(ticket.split('.')[0], 36);
// what a stored entry says the ticket's arrival time was: deadline = ticketAt + play + grace + slack - margin
const impliedTicketAt = (deadline, frames) => deadline - ((frames / FPS + TICKET_GRACE_S + TICKET_SLACK_S) * 1000 - DEADLINE_MARGIN_MS);
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = (page, fn, arg) => page.waitForFunction(fn, arg, WAIT);

let browser, web, dev;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
  process.env.DAILY_SECRET = 'w59c-' + randomBytes(32).toString('hex');
  try { dev = await devServer(); } finally { delete process.env.DAILY_SECRET; }
});
after(async () => { if (dev) await dev.kill(); if (browser) await browser.close(); if (web) web.server.close(); });

const isSubmit = u => u.href.startsWith(dev.url + '/submit');
const isDaily = u => u.href.startsWith(dev.url + '/daily');
const block = r => r.abort('connectionrefused');

// make the stored entry wait: four more failed sends (wake + flush), so its next try is backoffMs(5) = 80 s away
async function pushBack(page, hook) {
  for (let i = 0; i < 4; i++) await page.evaluate(h => window[h].flushQueue(true), hook);
}

// ---------- Starfall ----------
test('SF1 + SF2 Starfall: the Daily\'s queue entry has the deadline from the real ticket and frames (not in the body); a visible page sends a due entry at once', { timeout: 180000 }, async () => {
  const g = await openGame(browser, web.url, { lb: dev.url, init: [SKEW] });
  const { page, ctx, problems } = g;
  try {
    await toTitle(page);
    await ctx.route(isSubmit, block);
    await playToEntry(page, 'daily');
    const info = await page.evaluate(() => ({ run: SF.runInfo(), frames: SF.info().frames }));
    assert.ok(info.run.fromServer && typeof info.run.ticket === 'string', JSON.stringify(info.run));
    await page.evaluate(() => SF.nameEntry('ACE'));
    await until(page, () => SF.lastRemote() && SF.lastRemote().kind === 'retry');
    const it = (await page.evaluate(() => JSON.parse(localStorage.getItem('starfall.sendq')))).items[0];
    assert.equal(it.body.mode, 'daily'); assert.equal(it.body.ticket, info.run.ticket);
    assert.equal(typeof it.deadline, 'number', 'the entry has a deadline: ' + JSON.stringify(Object.keys(it)));
    assert.ok(!('deadline' in it.body), 'the deadline is not sent');
    const gap = impliedTicketAt(it.deadline, info.frames) - issuedOf(info.run.ticket);
    assert.ok(gap >= 0 && gap < 5000, 'the deadline is timed from when the real ticket arrived (arrival - issue = ' + gap + ' ms)');
    // SF2: the entry now waits 80 s; the server is back and the page clock passes the due time; only a flush on visibility sends it now
    await pushBack(page, 'SF');
    const q = (await page.evaluate(() => JSON.parse(localStorage.getItem('starfall.sendq')))).items[0];
    assert.equal(q.tries, 5);
    const left = q.next - await page.evaluate(() => Date.now());
    assert.ok(left > backoffMs(5) - 5000, 'its timer is ' + left + ' ms away');
    await ctx.unroute(isSubmit, block);
    let sent = 0;
    page.on('response', r => { if (r.url().startsWith(dev.url + '/submit') && r.request().method() === 'POST') sent++; });
    await page.evaluate(ms => { window.__skew += ms; }, left + 1000);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    // the server answers (any answer: this autoFire run holds more frames than real seconds passed, so it is bad_ticket here)
    await page.waitForFunction(() => SF.lastRemote() && SF.lastRemote().kind !== 'retry', null, { timeout: 5000 })
      .catch(async e => { throw new Error('not sent on visibility: ' + e.message + ' ' + JSON.stringify(await page.evaluate(() => [SF.lastRemote(), SF.queue()]))); });
    assert.ok(sent > 0, 'a POST /submit reached the server');
    assert.equal(await page.evaluate(() => localStorage.getItem('starfall.sendq')), null, 'the queue is empty');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

// ---------- STACKLIGHT ----------
async function openSL({ query = '' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  await ctx.addInitScript(SKEW);
  const page = await ctx.newPage();
  const problems = [], dailies = [], reqs = [];
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  page.on('request', r => { if (r.url().startsWith(dev.url + '/daily') && r.method() === 'GET') reqs.push(Date.now()); }); // asks sent, answered or not
  page.on('response', async r => {
    if (r.status() >= 400 && !/favicon/.test(r.url())) problems.push('HTTP ' + r.status() + ' ' + r.url());
    if (r.url().startsWith(dev.url + '/daily') && r.request().method() === 'GET') { try { dailies.push((await r.json()).ticket); } catch (e) { dailies.push('?'); } }
  });
  await page.goto(web.url + 'stacklight.html?lb=' + encodeURIComponent(dev.url) + (query ? '&' + query : ''));
  await page.waitForFunction(() => window.SL && SL.info().app === 'title' && SL.hud().F > 5, null, WAIT);
  return { ctx, page, problems, dailies, reqs };
}
const press = async (page, k, gap = 80) => { await page.keyboard.press(k); await wait(gap); };
const COLS = [1, 4, 7, 2, 5, 3, 6];
const finish = page => page.evaluate(cols => { let n = 0; while (!SL.info().done && n++ < 800) SL.place(cols[n % 7], n % 2); return SL.info().score; }, COLS);
// a short run: every piece into one column tops the well out in a few pieces. The server holds a Daily to (real seconds since its ticket
// + 10) x 60 frames, and this test moves only the page clock, so a long run could be refused as bad_ticket for a reason that is not the page's
const finishShort = page => page.evaluate(() => { let n = 0; while (!SL.info().done && n++ < 800) SL.place(n < 5 ? [1, 4, 7, 2][n - 1] : 1, 0); return { score: SL.info().score, frames: SL.info().frame }; });
const skew = (page, ms) => page.evaluate(m => { window.__skew += m; }, ms);
async function highlightDaily(page, dailies, n) {
  await page.evaluate(() => SL.mode('daily'));
  await until(page, () => SL.title().dstate === 'ready' && SL.title().card);
  for (let i = 0; i < 50 && dailies.length < n; i++) await wait(20);
  assert.equal(dailies.length, n, 'GET /daily count');
}

// SL1a/b/c each use a fresh page: a Daily run uses up the day's ranked attempt, and a practice Daily starts on the cache (SL3)
test('SL1a STACKLIGHT HIGH-1: 59 s after the highlight the run starts on the cached ticket, no new ask', { timeout: 180000 }, async () => {
  const { ctx, page, problems, dailies, reqs } = await openSL();
  try {
    await highlightDaily(page, dailies, 1);
    const A = dailies[0];
    assert.ok(typeof A === 'string' && A.length > 0, 'the board gave a ticket');
    // 59 s: fresh enough, the cached answer starts the run, no new ask
    await skew(page, TICKET_FRESH_MS - 1000);
    await press(page, 'Enter', 200);
    await until(page, () => SL.info().app === 'play');
    assert.equal((await page.evaluate(() => SL.runInfo())).ticket, A);
    assert.equal(dailies.length, 1, 'no second GET /daily at 59 s');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('SL1b STACKLIGHT HIGH-1: 61 s after the highlight Enter asks again (asking state; a double Enter is one ask and one run, on the new ticket)', { timeout: 180000 }, async () => {
  const { ctx, page, problems, dailies, reqs } = await openSL();
  try {
    await highlightDaily(page, dailies, 1);
    const A = dailies[0];
    // 61 s after ticket A arrived: Enter on DAILY RIDGE asks again. The answer is held back 800 ms to see the asking state and press twice
    await skew(page, TICKET_FRESH_MS + 1000);
    await page.evaluate(() => SL.mode('daily'));
    const slow = async r => { await wait(800); try { await r.continue(); } catch (e) { /* the test is over */ } };
    await ctx.route(isDaily, slow);
    await press(page, 'Enter', 150);
    const mid = await page.evaluate(() => ({ t: SL.title(), app: SL.info().app }));
    assert.deepEqual([mid.app, mid.t.dstate], ['title', 'asking'], 'the card shows the asking state while it asks');
    // Another row and back while it asks (the cursor re-shows the Daily card) must not undo the asking state
    await press(page, 'ArrowDown', 30); await press(page, 'ArrowUp', 30);
    assert.equal(await page.evaluate(() => SL.title().dstate), 'asking', 'the cursor passing the Daily row does not end the asking state');
    await press(page, 'Enter', 50);
    await until(page, () => SL.info().app === 'play');
    const f0 = await page.evaluate(() => SL.info().frame);
    assert.ok(f0 < 120, 'one run, started once (frame ' + f0 + ')');
    // The second Enter joins the ask in flight. Reads go one at a time, so a second ask would arrive after the
    // first answer; wait it out while the route is still slow, then count the requests that were sent (not the answers)
    await wait(2000);
    assert.equal(reqs.length, 2, 'one new GET /daily request for two Enters (' + (reqs.length - 1) + ' new)');
    await ctx.unroute(isDaily, slow);
    assert.equal(dailies.length, 2, 'one new GET /daily for two Enters: ' + JSON.stringify(dailies));
    const B = dailies[1];
    assert.notEqual(B, A);
    const r = await page.evaluate(() => SL.runInfo());
    assert.equal(r.ticket, B, 'the run is on the new ticket');
    assert.ok((await page.evaluate(() => SL.info().frame)) > f0, 'the run was not started a second time');
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('SL1c STACKLIGHT HIGH-1: 61 s after the highlight and the board does not answer: the Daily does not start, the card says why', { timeout: 180000 }, async () => {
  const { ctx, page, problems, dailies } = await openSL();
  try {
    await highlightDaily(page, dailies, 1);
    await skew(page, TICKET_FRESH_MS + 1000);
    await page.evaluate(() => SL.mode('daily'));
    await ctx.route(isDaily, block);
    await press(page, 'Enter', 200);
    await until(page, () => SL.title().dstate === 'off');
    const off = await page.evaluate(() => ({ t: SL.title(), app: SL.info().app }));
    assert.deepEqual([off.app, off.t.dmsg], ['title', 'OFFLINE']);
    await wait(500);
    assert.equal(await page.evaluate(() => SL.info().app), 'title', 'still on the title');
    await ctx.unroute(isDaily, block);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('SL2 STACKLIGHT: Daily highlighted, started 15 minutes later: a new ticket, and the queued entry has the deadline from it and the run\'s frames (not in the body); a visible page sends the due entry at once', { timeout: 180000 }, async () => {
  const { ctx, page, problems, dailies } = await openSL();
  try {
    await highlightDaily(page, dailies, 1);
    const A = dailies[0];
    await ctx.route(isSubmit, block);
    await skew(page, 15 * 60000);
    const startedAt = await page.evaluate(() => Date.now());
    await press(page, 'Enter', 200);
    await until(page, () => SL.info().app === 'play');
    assert.equal(dailies.length, 2, 'asked again: ' + JSON.stringify(dailies));
    const B = dailies[1];
    assert.notEqual(B, A);
    const run = await page.evaluate(() => SL.runInfo());
    assert.deepEqual([run.ticket, run.ranked, run.fromServer], [B, true, true]);
    const fin = await finishShort(page);
    assert.ok(fin.score > 0 && fin.frames < 400, 'SL2 needs a short, scoring run (the server holds a Daily to real time since its ticket): ' + JSON.stringify(fin));
    await until(page, () => SL.info().app === 'over');
    await wait(900);
    await press(page, 'Enter', 150);
    await until(page, () => SL.info().app === 'entry');
    await page.evaluate(() => SL.nameEntry('ACE'));
    await until(page, () => SL.lastRemote() && SL.lastRemote().kind === 'retry');
    const it = (await page.evaluate(() => JSON.parse(localStorage.getItem('stacklight.sendq')))).items[0];
    assert.equal(it.body.ticket, B, 'the submit carries the new ticket');
    assert.equal(typeof it.deadline, 'number', 'the entry has a deadline: ' + JSON.stringify(Object.keys(it)));
    assert.ok(!('deadline' in it.body), 'the deadline is not sent');
    const at = impliedTicketAt(it.deadline, it.body.stats.frames);
    assert.ok(at >= startedAt && at - startedAt < 5000, 'timed from when ticket B arrived (page clock): ' + (at - startedAt) + ' ms after Enter');
    // and that is the real ticket's window: arrival - issue (server clock) is the page skew plus travel
    const gap = at - (issuedOf(B) + await page.evaluate(() => window.__skew));
    assert.ok(gap >= -1000 && gap < 5000, 'arrival - issue = ' + gap + ' ms');
    // the visible page sends a due entry at once
    await pushBack(page, 'SL');
    const q = (await page.evaluate(() => JSON.parse(localStorage.getItem('stacklight.sendq')))).items[0];
    const left = q.next - await page.evaluate(() => Date.now());
    assert.ok(left > backoffMs(5) - 5000, 'its timer is ' + left + ' ms away');
    await ctx.unroute(isSubmit, block);
    await skew(page, left + 1000);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => SL.lastRemote() && SL.lastRemote().kind === 'ok', null, { timeout: 5000 })
      .catch(async e => { throw new Error('not sent on visibility: ' + e.message + ' ' + JSON.stringify(await page.evaluate(() => [SL.lastRemote(), SL.queue()]))); });
    assert.equal(await page.evaluate(() => localStorage.getItem('stacklight.sendq')), null);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('SL3 STACKLIGHT LOW-1: a practice Daily (today\'s attempt already used) starts on the cached answer even when it is over 60 s old and the board is down', { timeout: 120000 }, async () => {
  const { ctx, page, problems, dailies, reqs } = await openSL();
  try {
    await highlightDaily(page, dailies, 1);
    await press(page, 'Enter', 200);
    await until(page, () => SL.info().app === 'play');
    assert.equal((await page.evaluate(() => SL.runInfo())).ticket, dailies[0]);
    await press(page, 'Escape'); await press(page, 'Escape');
    await until(page, () => SL.info().app === 'title');
    await page.evaluate(() => SL.mode('daily'));
    await until(page, () => SL.title().used === true);
    await skew(page, TICKET_FRESH_MS + 1000);
    await ctx.route(isDaily, block);
    await press(page, 'Enter', 400);
    const s = await page.evaluate(() => ({ app: SL.info().app, run: SL.runInfo(), t: SL.title() }));
    assert.equal(s.app, 'play', 'the practice Daily starts offline: ' + JSON.stringify([s.t.dstate, s.t.dmsg]));
    assert.equal(s.run.ranked, false, 'it is a practice run');
    assert.equal(reqs.length, 1, 'no new GET /daily for a practice start');
    await ctx.unroute(isDaily, block);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('SL4 STACKLIGHT LOW-3: a Daily start that is waiting on the re-ask does not fire once the player has opened the high-score table', { timeout: 120000 }, async () => {
  const { ctx, page, problems, dailies } = await openSL();
  try {
    await highlightDaily(page, dailies, 1);
    await skew(page, TICKET_FRESH_MS + 1000);
    await page.evaluate(() => SL.mode('daily'));
    const slow = async r => { await wait(1200); try { await r.continue(); } catch (e) { /* the test is over */ } };
    await ctx.route(isDaily, slow);
    await press(page, 'Enter', 150);
    assert.equal(await page.evaluate(() => SL.title().dstate), 'asking');
    await press(page, 'ArrowDown', 30); await press(page, 'ArrowDown', 30); await press(page, 'ArrowDown', 30);
    await press(page, 'Enter', 30);
    assert.equal(await page.evaluate(() => SL.title().page), 'table', 'the table is open');
    await until(page, () => SL.title().dstate === 'ready');
    await wait(500);
    const end = await page.evaluate(() => ({ app: SL.info().app, page: SL.title().page }));
    assert.deepEqual(end, { app: 'title', page: 'table' }, 'the Daily did not start under the table');
    await ctx.unroute(isDaily, slow);
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});
