// Card 3b (w25-client): every server state the player can hit, in the real page (headless Chrome, Playwright).
// The leaderboard server is faked with context routes on a free localhost port: the page uses the same client code
// path as with the real server (server/client.js fetch). Scope items: 2 retry and refusal codes, 4 wrong_version,
// 5 OFFLINE board and read rate, 6 daily timer, 7 storage warning, 8 null placements, 11 hooks; plus two tabs
// sending one queue and a bad stored queue. The real-server flows are tests/w25-client-browser.test.js.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { staticServer, freePort, openGame, toTitle, playToEntry, shot, texts, clearTexts, until, WAIT } from './w25-helpers.mjs';
import { dailyNumber, fmtScore } from '../games/starfall/modes.js';
import { GAME_VERSION } from '../games/starfall/sim.js';

let browser, web;
before(async () => {
  web = await staticServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { if (browser) await browser.close(); if (web) web.server.close(); });
const clean = (p, name) => assert.deepEqual(p.problems, [], name + ': no page errors (failed requests to the leaderboard aside)');
const BAD_TEXT = /null|undefined|nan/i;
// the system clipboard is shared by every test running at once, so these tests record what the page tries to copy instead
const CLIP = ['window.__clip = null; Object.defineProperty(navigator, "clipboard", { value: { writeText: t => { window.__clip = t; return Promise.resolve(); } }, configurable: true });'];
const today = () => new Date().toISOString().slice(0, 10);
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const J = (status, body) => ({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
const OK201 = { ok: true, score: 1, id: 'srv-1', placements: { all: 4, season: 4 }, trophyDelta: 750, trophies: 750, league: { name: 'Gold', tier: 'III', label: 'Gold III' },
  rating: { avg5: 1200, top5: [6000], enteredTop5: true, percentile: 0.5, players: 3 }, boardCap: 1000 };
const RANK = { ok: true, trophies: 750, league: 'Gold', tier: 'III', label: 'Gold III', best: 6000, seasonBest: 6000, avg5: 1200, top5: [6000], percentile: 0.5, players: 3, carry: 0 };

// A fake leaderboard at a free localhost port. Submit answers come from S.next(request) ('hang' = never answer);
// every request is counted. Routed on the context, so two tabs share it.
async function fake() {
  const port = await freePort();
  const { dailySeed } = await import('../engine/rng.js'); // what the dev server answers on /daily with no DAILY_SECRET
  const S = { url: `http://127.0.0.1:${port}`, submits: 0, boards: 0, ranks: 0, next: () => J(201, OK201), rank: () => J(200, RANK), board: () => J(200, { ok: true, rows: [] }), held: [] };
  S.setup = ctx => ctx.route(S.url + '/**', async route => {
    const req = route.request(), u = new URL(req.url());
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-headers': 'content-type, x-player-id' } });
    let a;
    if (u.pathname === '/submit') { S.submits++; a = await S.next(req); }
    else if (u.pathname === '/board') { S.boards++; a = S.board(); }
    else if (u.pathname === '/rank') { S.ranks++; a = S.rank(); }
    else if (u.pathname === '/daily') { const t = Date.now(), dayKey = new Date(t).toISOString().slice(0, 10); a = J(200, { ok: true, game: 'starfall', dayKey, seed: dailySeed(dayKey), ticket: null, issuedAt: t, dailySecret: false }); }
    else a = J(404, { ok: false, error: 'not_found', message: 'no' });
    if (a === 'hang') { S.held.push(route); return; }
    return route.fulfill(a);
  });
  return S;
}
const entry = (i, extra = {}) => ({ body: { game: 'starfall', playerId: 'state-player-01', name: 'ACE', score: 100 + i, replay: 'fake-replay-' + i, seed: 3, mode: 'free', version: GAME_VERSION, ...extra } });
const seed = (page, items) => page.evaluate(v => localStorage.setItem('starfall.sendq', JSON.stringify(v)), { v: 1, items });

describe('card 3b server states in the page', { concurrency: true }, () => {
  test('retry and refusal codes: each answer does the right thing to the queue and the status line', async () => {
    const S = await fake();
    const g = await openGame(browser, web.url, { lb: S.url, setup: S.setup });
    const { page } = g;
    await toTitle(page);
    const step = async (answer, items) => {
      S.next = () => answer;
      if (items) await seed(page, items);
      const before = S.submits;
      const done = await page.evaluate(() => SF.flushQueue(true));
      return { done, sent: S.submits - before, q: await page.evaluate(() => SF.queue()), status: await page.evaluate(() => SF.status()) };
    };
    let r = await step(J(500, { ok: false, error: 'server_error', message: 'something went wrong on the server' }), [entry(1)]);
    assert.deepEqual([r.done[0].kind, r.q.length, r.q.codes[0]], ['retry', 1, 'server_error']);
    assert.equal(r.status, 'SERVER BUSY: 1 RUN SAVED HERE, WILL RETRY');
    r = await step({ status: 502, contentType: 'text/html', headers: CORS, body: '<h1>bad gateway</h1>' });
    assert.deepEqual([r.done[0].kind, r.q.codes[0]], ['retry', 'server_error'], '5xx without JSON');
    r = await step(J(503, { ok: false, error: 'busy', message: 'busy' }));
    assert.deepEqual([r.done[0].kind, r.q.codes[0]], ['retry', 'busy']);
    r = await step(J(429, { ok: false, error: 'rate_limited', message: 'too many submits, slow down' }));
    assert.deepEqual([r.done[0].kind, r.q.codes[0]], ['retry', 'rate_limited']);
    assert.ok(r.q.items[0].next - (await page.evaluate(() => Date.now())) > 55000, 'rate_limited waits a minute');
    assert.equal(r.q.items[0].tries, 4);
    r = await step(J(202, { ok: true, held: true, code: 'held_for_review', heldId: 7, score: 101, message: 'held for review' }));
    assert.deepEqual([r.done[0].kind, r.q.length, r.status], ['held', 0, 'HELD FOR REVIEW'], '202 counts as delivered');
    await page.evaluate(() => SF.page('table'));
    await shot(page, 'held-for-review');
    for (const [code, status, want] of [['score_zero', 422, 'NOT SENT: SCORE ZERO'], ['bad_name', 400, 'NOT SENT: BAD NAME'], ['replay_mismatch', 422, 'NOT SENT: REPLAY MISMATCH'],
      ['near_duplicate', 409, 'NOT SENT: NEAR DUPLICATE'], ['duplicate_replay', 409, 'ALREADY SAVED ONLINE']]) {
      r = await step(J(status, { ok: false, error: code, message: code }), [entry(2)]);
      assert.equal(r.sent, 1, code); assert.equal(r.q.length, 0, code); assert.equal(r.status, want, code);
      r = await step(J(201, OK201));
      assert.equal(r.sent, 0, code + ': never sent again');
    }
    // a send that never answers ends as a timeout (15 s) and stays queued
    r = await step('hang', [entry(3)]);
    assert.deepEqual([r.done[0].kind, r.q.codes[0], r.sent], ['retry', 'timeout', 1]);
    assert.equal(r.status, 'OFFLINE: 1 RUN SAVED HERE, WILL RETRY');
    clean(g, 'codes');
    await g.ctx.close();
  });

  test('wrong_version on a real run: NEW VERSION, RELOAD, the run stays on this device, never retried', async () => {
    const S = await fake();
    S.next = () => J(422, { ok: false, error: 'wrong_version', message: 'new version, reload: the server takes starfall 9.0, this run is ' + GAME_VERSION });
    const g = await openGame(browser, web.url, { lb: S.url, setup: S.setup });
    const { page } = g;
    await toTitle(page);
    await playToEntry(page, 'free');
    const res = await page.evaluate(() => SF.nameEntry('ACE'));
    assert.ok(res && res.id);
    await until(page, () => SF.lastRemote() && SF.lastRemote().kind === 'version');
    assert.equal(await page.evaluate(() => SF.status()), 'NEW VERSION, RELOAD');
    assert.equal(await page.evaluate(() => SF.queue().length), 0);
    assert.equal((await page.evaluate(() => SF.scores('all'))).length, 1, 'kept on the local board');
    await page.waitForTimeout(300);
    assert.ok((await texts(page)).includes('NEW VERSION, RELOAD'), 'drawn');
    await shot(page, 'new-version-reload');
    await page.evaluate(() => SF.flushQueue(true));
    assert.equal(S.submits, 1, 'not retried');
    clean(g, 'wrong_version');
    await g.ctx.close();
  });

  test('null placements past the 1000-row cap and an unrated player never print null, undefined or NaN', async () => {
    const S = await fake();
    S.next = () => J(201, { ...OK201, placements: { all: null, season: null }, trophyDelta: 0, rating: { avg5: 0, top5: [], enteredTop5: false, percentile: null, players: 1200 } });
    S.rank = () => J(200, { ok: true, trophies: 0, league: 'Bronze', tier: 'III', label: 'Bronze III', best: 0, seasonBest: 0, avg5: 0, top5: [], percentile: null, players: 0, carry: 0 });
    const g = await openGame(browser, web.url, { lb: S.url, setup: S.setup });
    const { page } = g;
    await toTitle(page);
    await page.evaluate(() => SF.page('table'));
    await until(page, () => SF.table().rating === 'NOT RATED THIS SEASON');
    await playToEntry(page, 'free');
    await page.evaluate(() => SF.nameEntry('ACE'));
    await until(page, () => SF.lastRemote() && SF.lastRemote().kind === 'ok');
    const t = await page.evaluate(() => SF.table());
    assert.equal(t.note, 'PAST THE TOP 1000  +0 TROPHIES');
    assert.equal(await page.evaluate(() => SF.status()), 'ONLINE: NOT RATED THIS SEASON');
    await page.waitForTimeout(400);
    const bad = (await texts(page)).filter(s => BAD_TEXT.test(s));
    assert.deepEqual(bad, []);
    clean(g, 'null placements');
    await g.ctx.close();
  });

  test('board OFFLINE, not LOADING, when the server is down; one read per 10 s from table, rank and attract together', async () => {
    const dead = `http://127.0.0.1:${await freePort()}`; // nothing listens here
    const reads = [];
    const g = await openGame(browser, web.url, { lb: dead, setup: ctx => ctx.on('request', r => { if (r.url().startsWith(dead)) reads.push(Date.now()); }) });
    const { page } = g;
    await toTitle(page);
    await page.evaluate(() => SF.page('table'));
    await until(page, () => SF.table().offline === true);
    assert.ok(reads.length >= 1);
    const t0 = reads[0];
    await page.waitForTimeout(300);
    assert.ok((await texts(page)).includes('OFFLINE'), 'OFFLINE drawn');
    await shot(page, 'board-offline');
    // attract mode, the table opened again and a direct board read inside the 10 s: no new request (the gate answers)
    await page.evaluate(() => SF.attractNow());
    await page.waitForTimeout(1500);
    assert.notEqual((await page.evaluate(() => SF.attract())).phase, 'wait', 'attract falls back to the local board or the demo');
    await page.evaluate(() => SF.page('table'));
    assert.equal(await page.evaluate(() => SF.boardScores('all').then(() => 'read', e => e.code)), 'offline');
    await page.waitForTimeout(Math.max(0, t0 + 9500 - Date.now()));
    assert.equal(reads.length, 1, 'one request in the first 10 s: ' + reads.map(t => t - t0));
    assert.equal(await page.evaluate(() => SF.table().offline), true, 'still OFFLINE, not LOADING');
    // the open table tries again by itself once the 10 s are up
    await page.waitForTimeout(Math.max(0, t0 + 12500 - Date.now()));
    assert.equal(reads.length, 2, 'one more read after 10 s: ' + reads.map(t => t - t0));
    assert.ok(reads[1] - t0 >= 10000);
    clean(g, 'offline');
    await g.ctx.close();
  });

  test('a board read that never answers ends at OFFLINE (timeout), not LOADING forever', async () => {
    const S = await fake();
    S.board = () => 'hang';
    const g = await openGame(browser, web.url, { lb: S.url, setup: S.setup });
    const { page } = g;
    await toTitle(page);
    await page.evaluate(() => SF.page('table'));
    await page.waitForTimeout(1000);
    assert.equal((await page.evaluate(() => SF.table())).offline, false);
    await page.waitForFunction(() => SF.table().offline === true, null, { timeout: 25000 });
    clean(g, 'hang board');
    await g.ctx.close();
  });

  test('daily row: NEW DAILY IN Xh (UTC), minutes in the last hour', async () => {
    const g = await openGame(browser, web.url, { init: [`(() => { const real = Date.now.bind(Date); window.__now = ${Date.UTC(2026, 9, 30, 19, 0, 0)}; Date.now = () => window.__now == null ? real() : window.__now; })();`] });
    const { page } = g;
    await toTitle(page);
    await page.keyboard.press('ArrowDown');
    await until(page, () => SF.info().menu === 1);
    await page.waitForTimeout(1300);
    assert.ok((await texts(page)).includes('NEW DAILY IN 5H'));
    await shot(page, 'daily-timer');
    await page.evaluate(ms => { window.__now = ms; window.__texts.clear(); }, Date.UTC(2026, 9, 30, 23, 18, 0));
    await page.waitForTimeout(1300);
    assert.ok((await texts(page)).includes('NEW DAILY IN 42M'));
    clean(g, 'timer');
    await g.ctx.close();
  });

  test('storage refused: SCORES NOT KEPT ON THIS DEVICE shows, and runs still save and send for this page', async () => {
    const S = await fake();
    const g = await openGame(browser, web.url, { lb: S.url, setup: S.setup,
      init: ["Storage.prototype.setItem = function () { throw new DOMException('refused', 'QuotaExceededError'); };"] });
    const { page } = g;
    await toTitle(page);
    assert.equal(await page.evaluate(() => SF.storageWarn()), true);
    await page.waitForTimeout(300);
    assert.ok((await texts(page)).includes('SCORES NOT KEPT ON THIS DEVICE'));
    await shot(page, 'storage-warning');
    await playToEntry(page, 'free');
    assert.ok(await page.evaluate(() => SF.nameEntry('ACE')), 'saved in memory');
    await until(page, () => SF.lastRemote() && SF.lastRemote().kind === 'ok');
    assert.equal(await page.evaluate(() => SF.table().warn), 'SCORES NOT KEPT ON THIS DEVICE');
    clean(g, 'storage');
    await g.ctx.close();
  });

  test('a corrupt or older stored queue is dropped at load without an error', async () => {
    for (const stored of ['{not json', JSON.stringify({ v: 0, items: [entry(1)] }), JSON.stringify({ v: 1, items: [entry(1, { version: '0.1' }), { junk: true }] })]) {
      const S = await fake();
      const g = await openGame(browser, web.url, { lb: S.url, setup: S.setup, tap: false,
        init: [`if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('starfall.sendq', ${JSON.stringify(stored)}); }`] });
      const { page } = g;
      await page.waitForTimeout(1500);
      const q = await page.evaluate(() => SF.queue());
      assert.equal(q.length, 0, stored);
      assert.equal(S.submits, 0);
      clean(g, 'stored ' + stored);
      await g.ctx.close();
    }
  });

  test('two tabs with one queue: the run is sent once (Web Locks)', async () => {
    const S = await fake();
    S.next = () => new Promise(r => setTimeout(() => r(J(201, OK201)), 400));
    const g = await openGame(browser, web.url, { lb: S.url, setup: S.setup, tap: false });
    const page2 = await g.ctx.newPage();
    await page2.goto(web.url + 'starfall.html?lb=' + encodeURIComponent(S.url));
    await page2.waitForFunction(() => window.SF);
    await g.page.waitForTimeout(1500);
    await seed(g.page, [entry(5)]);
    await Promise.all([g.page.evaluate(() => SF.flushQueue(true)), page2.evaluate(() => SF.flushQueue(true))]);
    assert.equal(S.submits, 1, 'one send across two tabs');
    assert.equal(await page2.evaluate(() => SF.queue().length), 0);
    clean(g, 'two tabs');
    await g.ctx.close();
  });

  // ---------- fix round 3b-fix ----------
  test('MED2 N5b: a null daily placement beside a numeric all-time one prints no null or undefined', async () => {
    const S = await fake();
    S.next = () => J(201, { ...OK201, placements: { all: 4, daily: null, season: 4 } });
    const g = await openGame(browser, web.url, { lb: S.url, setup: S.setup });
    const { page } = g;
    await toTitle(page);
    await playToEntry(page, 'daily');
    await page.evaluate(() => SF.nameEntry('ACE'));
    await until(page, () => SF.lastRemote() && SF.lastRemote().kind === 'ok');
    assert.equal((await page.evaluate(() => SF.table())).note, 'RANK 4 ALL-TIME  +750 TROPHIES');
    await page.waitForTimeout(400);
    assert.deepEqual((await texts(page)).filter(s => BAD_TEXT.test(s)), [], 'nothing drawn says null, undefined or NaN');
    assert.ok((await texts(page)).includes('RANK 4 ALL-TIME  +750 TROPHIES'));
    clean(g, 'null daily');
    await g.ctx.close();
  });

  test('MED2 N10: a run left in the queue by an earlier visit is sent about a second after the page loads, with no other trigger', async () => {
    const S = await fake();
    const g = await openGame(browser, web.url, { lb: S.url, setup: S.setup, tap: false,
      init: [`if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('starfall.sendq', ${JSON.stringify(JSON.stringify({ v: 1, items: [entry(1)] }))}); }`] });
    const { page } = g;
    assert.equal(await page.evaluate(() => SF.queue().length), 1, 'waiting at load');
    await page.waitForFunction(() => SF.queue().length === 0, null, { timeout: 8000 });
    assert.equal(S.submits, 1, 'sent once, by itself');
    assert.equal((await page.evaluate(() => SF.lastRemote())).kind, 'ok');
    clean(g, 'load flush');
    await g.ctx.close();
  });

  test('MED2 N11: the browser coming back online sends a waiting run now, not after the 5 s backoff', async () => {
    const S = await fake();
    S.next = () => J(503, { ok: false, error: 'busy', message: 'busy' });
    const g = await openGame(browser, web.url, { lb: S.url, setup: S.setup, tap: false,
      init: [`if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('starfall.sendq', ${JSON.stringify(JSON.stringify({ v: 1, items: [entry(1)] }))}); }`] });
    const { page } = g;
    await until(page, () => SF.lastRemote() && SF.lastRemote().kind === 'retry');
    const t0 = Date.now();
    S.next = () => J(201, OK201);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForFunction(() => SF.queue().length === 0, null, { timeout: 3000 });
    assert.ok(Date.now() - t0 < 4000, 'well inside the 5 s backoff');
    assert.equal(S.submits, 2);
    assert.equal((await page.evaluate(() => SF.lastRemote())).kind, 'ok');
    clean(g, 'online');
    await g.ctx.close();
  });

  // The board read gate holds every read for 10 s after a failed one. An answer from the submit endpoint proves the server is
  // back, so the gate opens and the table reads again at once (accepted and held alike).
  for (const [name, answer, kind] of [['N17 accepted (201)', () => J(201, OK201), 'ok'],
    ['N18 held for review (202)', () => J(202, { ok: true, held: true, code: 'held_for_review', heldId: 7, score: 101, message: 'held for review' }), 'held']]) {
    test(`MED2 ${name}: after a failed board read, a submit answer reopens the board read at once (no 10 s wait)`, async () => {
      const S = await fake();
      S.board = () => J(500, { ok: false, error: 'server_error', message: 'down' });
      const g = await openGame(browser, web.url, { lb: S.url, setup: S.setup });
      const { page } = g;
      await toTitle(page);
      await page.evaluate(() => SF.page('table'));
      await until(page, () => SF.table().offline === true);
      const t0 = Date.now();
      S.board = () => J(200, { ok: true, rows: [{ id: 'r1', rank: 1, name: 'ZED', score: 5000, mode: 'free' }] });
      S.next = answer;
      await seed(page, [entry(1)]);
      const done = await page.evaluate(() => SF.flushQueue(true));
      assert.equal(done[0].kind, kind);
      await page.waitForFunction(() => SF.table().loaded && SF.table().rows === 1, null, { timeout: 4000 });
      assert.ok(Date.now() - t0 < 8000, 'read again before the 10 s of the gate were up');
      assert.equal((await page.evaluate(() => SF.table())).offline, false);
      clean(g, name);
      await g.ctx.close();
    });
  }

  test('LOW4: a 413 HTML page, a 500 verify_disagree and a run out of tries are dropped with NOT SENT once; a malformed 200 body is retried', async () => {
    const S = await fake();
    const g = await openGame(browser, web.url, { lb: S.url, setup: S.setup });
    const { page } = g;
    await toTitle(page);
    const step = async (answer, items) => {
      S.next = () => answer;
      if (items) await seed(page, items);
      const before = S.submits;
      const done = await page.evaluate(() => SF.flushQueue(true));
      return { done, sent: S.submits - before, q: await page.evaluate(() => SF.queue()), status: await page.evaluate(() => SF.status()) };
    };
    let r = await step({ status: 413, contentType: 'text/html', headers: CORS, body: '<h1>413 Request Entity Too Large</h1>' }, [entry(1)]);
    assert.deepEqual([r.done[0].kind, r.sent, r.q.length, r.status], ['drop', 1, 0, 'NOT SENT: HTTP 413']);
    r = await step(J(201, OK201));
    assert.equal(r.sent, 0, '413: never sent again');
    r = await step(J(500, { ok: false, error: 'verify_disagree', message: 'the game verifier and the server re-sim disagree' }), [entry(2)]);
    assert.deepEqual([r.done[0].kind, r.sent, r.q.length, r.status], ['drop', 1, 0, 'NOT SENT: VERIFY DISAGREE']);
    r = await step(J(201, OK201));
    assert.equal(r.sent, 0, 'verify_disagree: never sent again');
    r = await step({ status: 200, contentType: 'text/plain', headers: CORS, body: 'not json at all {' }, [entry(3)]);
    assert.deepEqual([r.done[0].kind, r.q.length], ['retry', 1], 'a malformed answer is not a refusal: kept for a retry');
    // the last try: 19 sends already made, the 20th fails, the run leaves the queue and shows once
    r = await step(J(503, { ok: false, error: 'busy', message: 'busy' }), [entry(4)]);
    assert.equal(r.q.length, 1);
    await seed(page, [{ ...entry(5), tries: 19 }]);
    r = await step(J(503, { ok: false, error: 'busy', message: 'busy' }));
    assert.deepEqual([r.done[0].kind, r.q.length, r.status], ['drop', 0, 'NOT SENT: BUSY'], 'a maximum try count');
    r = await step(J(201, OK201));
    assert.equal(r.sent, 0);
    clean(g, 'low4');
    await g.ctx.close();
  });

  test('LOW5: when the queue refuses the body the status says NOT SENT: SAVED HERE ONLY, and the run stays on the local board', async () => {
    const REFUSE = ["{ const o = Number.isSafeInteger; Number.isSafeInteger = v => (new Error().stack || '').includes('submit-queue') ? false : o(v); }"];
    for (const [name, init] of [['body refused', REFUSE]]) {
      const S = await fake();
      const g = await openGame(browser, web.url, { lb: S.url, setup: S.setup, init });
      const { page } = g;
      await toTitle(page);
      await playToEntry(page, 'free');
      const res = await page.evaluate(() => SF.nameEntry('ACE'));
      assert.ok(res && res.id, name + ': saved on this device');
      await until(page, () => SF.state === 'title');
      assert.equal(await page.evaluate(() => SF.status()), 'NOT SENT: SAVED HERE ONLY', name);
      assert.equal((await page.evaluate(() => SF.scores('all'))).length, 1, name + ': on the local board');
      assert.equal(await page.evaluate(() => SF.queue().length), 0);
      await page.waitForTimeout(1500);
      assert.equal(S.submits, 0, name + ': nothing sent');
      assert.equal(await page.evaluate(() => SF.status()), 'NOT SENT: SAVED HERE ONLY', name + ': still shown');
      assert.ok((await page.evaluate(() => SF.table().note)).startsWith('RANK 1 ALL-TIME'), 'the local result line still shows');
      if (name === 'body refused') { await page.waitForTimeout(300); assert.ok((await texts(page)).includes('NOT SENT: SAVED HERE ONLY')); }
      clean(g, name);
      await g.ctx.close();
    }
  });

  test('LOW6: a ranked daily queued while the server was busy is refused with bad_day later: dropped, NOT SENT: BAD DAY, still on the local day board', async () => {
    const S = await fake();
    S.next = () => J(503, { ok: false, error: 'busy', message: 'busy' });
    const g = await openGame(browser, web.url, { lb: S.url, setup: S.setup });
    const { page } = g;
    await toTitle(page);
    await playToEntry(page, 'daily');
    await page.evaluate(() => SF.nameEntry('ACE'));
    await until(page, () => SF.lastRemote() && SF.lastRemote().kind === 'retry');
    assert.equal((await page.evaluate(() => SF.queue())).items[0].mode, 'daily');
    S.next = () => J(422, { ok: false, error: 'bad_day', message: 'that day is closed' });
    const done = await page.evaluate(() => SF.flushQueue(true));
    assert.equal(done[0].kind, 'drop');
    assert.equal(await page.evaluate(() => SF.status()), 'NOT SENT: BAD DAY');
    assert.equal(await page.evaluate(() => SF.queue().length), 0);
    assert.equal((await page.evaluate(d => SF.scores('daily', d), today())).length, 1, 'kept on the local day board');
    const sent = S.submits;
    await page.evaluate(() => SF.flushQueue(true));
    assert.equal(S.submits, sent, 'not sent again');
    clean(g, 'bad_day');
    await g.ctx.close();
  });

  test('LOW7: the share hint and the C key belong to the run just finished: after a later free run there is no C: SHARE and C does nothing', async () => {
    const S = await fake();
    const g = await openGame(browser, web.url, { lb: S.url, setup: S.setup, init: CLIP });
    const { page } = g;
    await toTitle(page);
    await playToEntry(page, 'daily');
    await page.evaluate(() => SF.nameEntry('ACE'));
    await until(page, () => SF.lastRemote() && SF.lastRemote().kind === 'ok' && SF.state === 'title');
    let t = await page.evaluate(() => SF.table());
    assert.equal(t.hint, 'UP DOWN: BOARD   C: SHARE   FIRE: BACK');
    await page.waitForTimeout(300);
    assert.ok((await texts(page)).includes('TAP HERE: SHARE'), 'the tap target is drawn after a daily');
    // a practice run started after the daily (never submitted) already ends the daily's share
    await page.evaluate(() => { window.__clip = null; });
    await page.evaluate(() => SF.start(1, 5));
    await page.evaluate(() => SF.page('table'));
    assert.equal((await page.evaluate(() => SF.table())).hint, null, 'no C: SHARE once another run has started');
    await page.keyboard.press('KeyC');
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => SF.lastShare()), null, 'C after a practice run shares nothing');
    assert.equal(await page.evaluate(() => window.__clip), null, 'nothing was copied');
    await page.evaluate(() => SF.page('main'));
    await playToEntry(page, 'free');
    await page.evaluate(() => SF.nameEntry('BEE'));
    await until(page, () => SF.state === 'title' && SF.info().page === 'table' && SF.lastRemote() && SF.lastRemote().kind === 'ok');
    t = await page.evaluate(() => SF.table());
    assert.equal(t.hint, null, 'no C: SHARE after a free run');
    await clearTexts(page);
    await page.waitForTimeout(400);
    const drawn = await texts(page);
    assert.ok(!drawn.some(x => /SHARE/.test(x)), 'nothing on the table mentions share: ' + drawn.filter(x => /SHARE/.test(x)));
    await page.keyboard.press('KeyC');
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => SF.lastShare()), null, 'C shared nothing');
    assert.notEqual(await page.evaluate(() => SF.status()), 'COPIED');
    assert.equal(await page.evaluate(() => window.__clip), null, 'nothing was copied');
    clean(g, 'stale share');
    await g.ctx.close();
  });

  test('LOW8: a tap or click on the SHARE target on the table copies the daily and keeps the table open; a tap elsewhere still goes back', async () => {
    const S = await fake();
    const g = await openGame(browser, web.url, { lb: S.url, setup: S.setup, init: CLIP, hasTouch: true });
    const { page } = g;
    await toTitle(page);
    const run = await playToEntry(page, 'daily');
    await page.evaluate(() => SF.nameEntry('ACE'));
    await until(page, () => SF.lastRemote() && SF.lastRemote().kind === 'ok' && SF.state === 'title');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => SF.info().page), 'table');
    const want = `Daily ${dailyNumber(today()) ? '#' + dailyNumber(today()) : today()} · ${fmtScore(run.score)} · Gold III`;
    // the canvas fills the 1000 x 750 view at 2.5 px per field unit; the target is the bottom strip at field y 279..300
    await page.evaluate(() => { window.__clip = null; });
    await page.touchscreen.tap(500, 725);
    await until(page, () => SF.status() === 'COPIED');
    const got = await page.evaluate(() => window.__clip);
    assert.ok(got.includes(want), 'a tap copies the share text: ' + JSON.stringify(got) + ' wanted ' + want);
    assert.equal(await page.evaluate(() => SF.info().page), 'table', 'the table stays open');
    await shot(page, 'share-tap-target');
    await page.evaluate(() => { window.__clip = null; });
    await page.mouse.click(500, 725);
    await page.waitForFunction(() => window.__clip !== null, null, WAIT);
    assert.equal(await page.evaluate(() => SF.info().page), 'table', 'a click keeps the table open too');
    await page.touchscreen.tap(500, 300); // anywhere else on the table: tap = fire = back
    await until(page, () => SF.info().page === 'main');
    clean(g, 'tap share');
    await g.ctx.close();
  });
});
