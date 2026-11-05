// What each lobby wall really DRAWS, not what its board object holds.
// The real index.html at 1000x750, served by tools/serve.mjs, in headless Chrome.
//  1. Remote path (?lb= -> server/dev-server.mjs seeded with different rows per game): every cabinet's wall draws its own
//     game's board (LOBBY.drawnBoard / drawnTop, set inside drawBoard from the object it draws). Catches a wall drawing another game's board.
//  2. The COMING SOON cabinet, selected: no /board or /rank for it, even on a forced refresh; its board is never read; no
//     console error of any kind (failed requests included); the poster drawn. Catches a request or console error for it.
//  3. Local path (no ?lb=): an old 1.0 STACKLIGHT run on this device is not on the STACKLIGHT wall (STACKLIGHT's own page
//     hides it through versionBoard), the 3.0 runs are, and a STARFALL run stays on the STARFALL wall.
// Screenshots go to W68_SHOT_DIR when it is set.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { devServer, freePort, WAIT, ROOT } from './w25-helpers.mjs';
import { majorOf } from '../server/boards.js';
import { gameOf } from '../server/games.js';
import { MACHINES } from '../arcade/machines.js';

const PID = 'w68b-player-0001';
const SHOT_DIR = process.env.W68_SHOT_DIR || null;
const IDX = Object.fromEntries(MACHINES.map((m, i) => [m.id, i]));
let browser, web, webUrl, dev, proxy, proxyUrl;
const log = [];

// a free port in 8900..8999 (the range this repo's agents use for tools/serve.mjs)
async function servePort() {
  for (let p = 8900 + Math.floor(Math.random() * 100), n = 0; n < 100; n++, p = 8900 + ((p - 8900 + 1) % 100)) {
    const ok = await new Promise(r => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); });
    if (ok) return p;
  }
  throw new Error('no free port in 8900..8999');
}
async function startServe() {
  const port = await servePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'tools/serve.mjs'), String(port), ROOT], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { child.stdout.on('data', d => { if (/serving/.test(String(d))) res(); }); child.once('exit', c => rej(new Error('serve.mjs exited ' + c))); });
  return { child, url: `http://127.0.0.1:${port}/` };
}

// STARFALL: 12 rows from 900,000 down (SFA..). STACKLIGHT: 12 rows from 40,000 down (SLA..). The player is 3rd in both.
function seed(dbFile) {
  const db = new DatabaseSync(dbFile);
  const ins = db.prepare('INSERT INTO board (game, ver, board, pid, score, t, entry, name, mode, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const pl = db.prepare('INSERT INTO players (game, ver, pid, name, best, t) VALUES (?, ?, ?, ?, ?, ?)');
  const fill = (game, top, step, tag) => {
    const ver = majorOf(gameOf(game).version);
    for (let i = 0; i < 12; i++) {
      const pid = i === 2 ? PID : `w68b-${tag}-${String(i).padStart(4, '0')}`, name = tag + String.fromCharCode(65 + i), score = top - i * step;
      ins.run(game, ver, 'all', pid, score, 1000 + i, 'e' + tag + String(i).padStart(8, '0'), name, 'free', '2026-10-30T00:00:00.000Z');
      pl.run(game, ver, pid, name, score, 1000 + i);
    }
  };
  fill('starfall', 900000, 10000, 'SF');
  fill('stacklight', 40000, 1000, 'SL');
  db.close();
}

before(async () => {
  web = await startServe(); webUrl = web.url;
  dev = await devServer();
  await dev.kill(); seed(dev.db); await dev.start();
  const port = await freePort();
  proxy = http.createServer((req, res) => {
    log.push(req.url);
    const up = http.request({ host: '127.0.0.1', port: dev.port, path: req.url, method: req.method, headers: req.headers }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  await new Promise(r => proxy.listen(port, '127.0.0.1', r));
  proxyUrl = 'http://127.0.0.1:' + port;
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=angle', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => {
  if (browser) await browser.close();
  if (proxy) proxy.close();
  if (dev) await dev.kill();
  if (web) web.child.kill();
});

// remote: true points the page at the seeded dev server (through the counting proxy); false keeps the local board
async function open({ remote = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  await ctx.addInitScript(id => { try { localStorage.setItem('arcade:playerId', JSON.stringify(id)); } catch (e) {} }, PID);
  const page = await ctx.newPage();
  const errors = [], failed = [];
  page.on('pageerror', e => errors.push(e.message));
  // every console error counts here, a failed request included; only the favicon 404 is allowed
  page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text() + ' ' + ((m.location() || {}).url || ''))) errors.push(m.text()); });
  page.on('requestfailed', r => failed.push(r.url()));
  page.on('response', r => { if (r.status() >= 400 && !/favicon/.test(r.url())) failed.push(r.status() + ' ' + r.url()); });
  await page.goto(webUrl + 'index.html' + (remote ? '?lb=' + encodeURIComponent(proxyUrl) : ''));
  await page.waitForFunction(() => window.LOBBY, null, WAIT);
  await page.evaluate(() => LOBBY.wordmarkSkip());
  return { ctx, page, errors, failed };
}
const gameOfUrl = u => new URL(u, 'http://x').searchParams.get('game');
const go = async (page, id) => {
  await page.evaluate(i => LOBBY.go(i), IDX[id]);
  await page.waitForFunction(i => { const x = LOBBY.info(); return x.index === i && !x.moving; }, IDX[id], WAIT);
};
// wait until cabinet id's wall has drawn its row 1 (the rows type in after the answer arrives)
const drawnRow1 = (page, id) => page.waitForFunction(i => LOBBY.drawnTop(i) !== null, IDX[id], WAIT);
const drawn = (page, id) => page.evaluate(i => ({ game: LOBBY.drawnBoard(i), top: LOBBY.drawnTop(i), info: LOBBY.info().id }), IDX[id]);
const shot = async (page, name) => { if (!SHOT_DIR) return; fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') }); };

describe('w68b lobby walls: what is drawn, in a real browser', { concurrency: false }, () => {
  test('every cabinet draws its own game\'s board: STARFALL, STACKLIGHT, STARFALL again, and COMING SOON', { timeout: 90000 }, async () => {
    const { ctx, page, errors } = await open();
    // the start cabinet is STARFALL
    await page.waitForFunction(() => LOBBY.boardOf('starfall').state === 'ok', null, WAIT);
    await drawnRow1(page, 'starfall');
    let d = await drawn(page, 'starfall');
    assert.equal(d.info, 'starfall');
    assert.equal(d.game, 'starfall', 'the STARFALL wall drew board ' + d.game);
    assert.deepEqual(d.top, { name: 'SFA', score: '900,000' });
    // STACKLIGHT: its wall draws STACKLIGHT's board, its row 1 is SLA 40,000 (the D118 bug drew SFA 900,000 here)
    await go(page, 'stacklight');
    await page.waitForFunction(() => LOBBY.boardOf('stacklight').state === 'ok', null, WAIT);
    await drawnRow1(page, 'stacklight');
    d = await drawn(page, 'stacklight');
    assert.equal(d.info, 'stacklight');
    assert.equal(d.game, 'stacklight', 'the STACKLIGHT wall drew board ' + d.game);
    assert.deepEqual(d.top, { name: 'SLA', score: '40,000' });
    // what is drawn agrees with that cabinet's own board snapshot
    const sl = await page.evaluate(() => LOBBY.boardOf('stacklight'));
    assert.deepEqual(d.top, { name: sl.rows[0].name, score: sl.rows[0].score });
    await page.waitForTimeout(1800); await shot(page, 'stacklight-wall');
    // back to STARFALL: STARFALL's board again, not the one drawn last
    await go(page, 'starfall');
    await drawnRow1(page, 'starfall');
    d = await drawn(page, 'starfall');
    assert.equal(d.game, 'starfall', 'back on STARFALL the wall drew board ' + d.game);
    assert.deepEqual(d.top, { name: 'SFA', score: '900,000' });
    await page.waitForTimeout(1800); await shot(page, 'starfall-wall');
    // COMING SOON: its own (empty) board, no rows, the poster
    await go(page, 'ledgelords');
    await page.waitForFunction(i => LOBBY.drawnBoard(i) !== null, IDX.ledgelords, WAIT);
    await page.waitForTimeout(600);
    d = await drawn(page, 'ledgelords');
    assert.equal(d.game, 'ledgelords'); assert.equal(d.top, null);
    assert.ok((await page.evaluate(() => LOBBY.posterShown())).includes('ledgelords'));
    // a wall that is not on screen is not reported as drawn
    assert.equal(await page.evaluate(i => LOBBY.drawnBoard(i), IDX.stacklight), null);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('the COMING SOON cabinet, selected: no /board or /rank for it (even forced), never read, poster drawn, console clean', { timeout: 60000 }, async () => {
    const { ctx, page, errors, failed } = await open();
    await page.waitForFunction(() => LOBBY.boardOf('starfall').state === 'ok', null, WAIT);
    log.length = 0;
    await go(page, 'ledgelords');
    await page.waitForTimeout(2500);   // long past the lazy read a selected playable cabinet gets at once
    const r = await page.evaluate(i => ({ info: LOBBY.info().id, b: LOBBY.boardOf('ledgelords'), poster: LOBBY.posterShown(), drawn: LOBBY.drawnBoard(i) }), IDX.ledgelords);
    assert.equal(r.info, 'ledgelords');
    assert.ok(r.poster.includes('ledgelords'), 'the COMING SOON poster is drawn: ' + JSON.stringify(r.poster));
    assert.equal(r.drawn, 'ledgelords');
    assert.equal(r.b.state, 'idle', 'selecting it does not read it'); assert.equal(r.b.reads, 0); assert.equal(r.b.n, 0);
    assert.deepEqual(log, [], 'no request at all while COMING SOON is selected: ' + JSON.stringify(log));
    // even a forced refresh of its board sends nothing: it has no network reader
    await page.evaluate(() => LOBBY.refreshBoardOf('ledgelords'));
    await page.waitForTimeout(800);
    assert.deepEqual(log, [], 'no request after a forced refresh either: ' + JSON.stringify(log));
    await shot(page, 'coming-soon-wall');
    assert.deepEqual(failed, [], 'no failed request: ' + JSON.stringify(failed));
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('local board (no ?lb=): an old 1.0 STACKLIGHT run is not on the STACKLIGHT wall; 3.0 runs are; STARFALL keeps its own', { timeout: 60000 }, async () => {
    const { ctx, page, errors } = await open({ remote: false });
    // the opening read is STARFALL's (empty local board); STACKLIGHT's waits until it is selected, so seed this device now
    await page.waitForFunction(() => LOBBY.boardOf('starfall').state === 'ok', null, WAIT);
    await page.evaluate(async pid => {
      const { createLeaderboard } = await import('/leaderboard/api.js');
      const { localStorageAdapter } = await import('/leaderboard/storage.js');
      const lb = createLeaderboard({ storage: localStorageAdapter('arcade:') });
      let i = 0;
      const post = (game, playerId, name, score, version) =>
        lb.submitScore({ game, playerId, name, score, replay: `r1~${game}~${version}~${++i}~free~AAAA${i}`, seed: i, mode: 'free', version });
      await post('stacklight', 'w68b-other-0001', 'OLD', 1813885, '1.0');   // a 1.0 run (old lock rule) by someone else
      await post('stacklight', pid, 'NEW', 30000, '3.0');
      await post('stacklight', 'w68b-other-0002', 'TWO', 25000, '3.0');
      await post('starfall', 'w68b-other-0003', 'SFX', 123450, '1.0');
    }, PID);
    // the in-game STACKLIGHT table's view of the same storage (versionBoard over the raw local board)
    const inGame = await page.evaluate(async () => {
      const { createLeaderboard } = await import('/leaderboard/api.js');
      const { localStorageAdapter } = await import('/leaderboard/storage.js');
      const { versionBoard } = await import('/games/stacklight/modes.js');
      const rows = await versionBoard(createLeaderboard({ storage: localStorageAdapter('arcade:') })).getBoard({ game: 'stacklight', board: 'all', limit: 100 });
      return rows.map(r => r.name + ' ' + r.score);
    });
    assert.deepEqual(inGame, ['NEW 30000', 'TWO 25000']);
    await go(page, 'stacklight');
    await page.waitForFunction(() => LOBBY.boardOf('stacklight').state === 'ok', null, WAIT);
    await drawnRow1(page, 'stacklight');
    const sl = await page.evaluate(() => LOBBY.boardOf('stacklight'));
    assert.deepEqual(sl.rows.map(r => r.name + ' ' + r.score), ['NEW 30,000', 'TWO 25,000'], 'the wall lists what the game lists');
    assert.equal(sl.you, 'ranked'); assert.equal(sl.youScore, '30,000'); assert.equal(sl.youRank, '1'); assert.equal(sl.rows[0].me, true);
    const d = await drawn(page, 'stacklight');
    assert.equal(d.game, 'stacklight'); assert.deepEqual(d.top, { name: 'NEW', score: '30,000' });
    await page.waitForTimeout(1800); await shot(page, 'stacklight-wall-local');
    // STARFALL reads its local board as Starfall's page does (no version filter): its own run, read again on the way back
    await page.evaluate(() => { LOBBY.reset(); });
    await go(page, 'starfall');
    await page.waitForFunction(() => LOBBY.boardOf('starfall').n === 1, null, WAIT);
    await drawnRow1(page, 'starfall');
    assert.deepEqual(await drawn(page, 'starfall').then(x => [x.game, x.top]), ['starfall', { name: 'SFX', score: '123,450' }]);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('LOBBY.reset() resolves to the selected cabinet\'s board (STACKLIGHT here), read again', { timeout: 60000 }, async () => {
    const { ctx, page, errors } = await open();
    await go(page, 'stacklight');
    await page.waitForFunction(() => LOBBY.boardOf('stacklight').state === 'ok', null, WAIT);
    const before = await page.evaluate(() => LOBBY.boardOf('stacklight').reads);
    const snap = await page.evaluate(() => LOBBY.reset());
    assert.equal(snap.reads, before + 1, 'the STACKLIGHT board was read again and its snapshot returned');
    assert.equal(snap.rows[0].name, 'SLA');
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});
