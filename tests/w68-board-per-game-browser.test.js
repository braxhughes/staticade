// Lobby wall boards per game, browser half: the real index.html at 1000x750 against server/dev-server.mjs seeded with DIFFERENT rows per
// game. The STACKLIGHT wall shows STACKLIGHT's rows and the STARFALL wall shows STARFALL's. A counting proxy checks that
// every /board and /rank request carries the matching game=. Screenshots go to W68_SHOT_DIR when it is set.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { staticServer, devServer, freePort, WAIT } from './w25-helpers.mjs';
import { majorOf } from '../server/boards.js';
import { gameOf } from '../server/games.js';

const PID = 'w68-player-0001';
const SHOT_DIR = process.env.W68_SHOT_DIR || null;
let browser, web, dev, proxy, proxyUrl;
const log = [];
// STARFALL: 30 rows from 900,000 down (names SFA..), the player 12th with 790,000. STACKLIGHT: 14 rows from 40,000 down (names SLA..), the player 3rd with 38,000.
const SF_TOP = i => 900000 - i * 10000, SL_TOP = i => 40000 - i * 1000;

function seed(dbFile) {
  const db = new DatabaseSync(dbFile);
  const ins = db.prepare('INSERT INTO board (game, ver, board, pid, score, t, entry, name, mode, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const pl = db.prepare('INSERT INTO players (game, ver, pid, name, best, t) VALUES (?, ?, ?, ?, ?, ?)');
  const fill = (game, n, scoreOf, tag, meAt) => {
    const ver = majorOf(gameOf(game).version);
    for (let i = 0; i < n; i++) {
      const pid = i === meAt ? PID : `w68-${tag}-${String(i).padStart(4, '0')}`, name = tag + String.fromCharCode(65 + (i % 26)), score = scoreOf(i);
      ins.run(game, ver, 'all', pid, score, 1000 + i, 'e' + tag + String(i).padStart(8, '0'), name, 'free', '2026-10-30T00:00:00.000Z');
      pl.run(game, ver, pid, name, score, 1000 + i);
    }
  };
  fill('starfall', 30, SF_TOP, 'SF', 11);
  fill('stacklight', 14, SL_TOP, 'SL', 2);
  db.close();
}

before(async () => {
  web = await staticServer();
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
after(async () => { if (browser) await browser.close(); if (proxy) proxy.close(); if (dev) await dev.kill(); if (web) web.server.close(); });

async function open() {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  await ctx.addInitScript(id => { try { localStorage.setItem('arcade:playerId', JSON.stringify(id)); } catch (e) {} }, PID);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(web.url + 'index.html?lb=' + encodeURIComponent(proxyUrl));
  await page.waitForFunction(() => window.LOBBY, null, WAIT);
  await page.evaluate(() => LOBBY.wordmarkSkip());
  return { ctx, page, errors };
}
const gameOfUrl = u => new URL(u, 'http://x').searchParams.get('game');
const go = async (page, id) => {
  await page.evaluate(i => LOBBY.go(i), id === 'stacklight' ? 0 : 1);
  await page.waitForFunction(i => { const x = LOBBY.info(); return x.index === i && !x.moving; }, id === 'stacklight' ? 0 : 1, WAIT);
  await page.waitForTimeout(1800);   // the rows type in
};
const shot = async (page, name) => { if (!SHOT_DIR) return; fs.mkdirSync(SHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(SHOT_DIR, name + '.png') }); };

describe('w68 lobby wall board per game, in a real browser', { concurrency: false }, () => {
  test('each wall shows its own game: rows, rank and you-line; every request carries the matching game=', { timeout: 90000 }, async () => {
    log.length = 0;
    const { ctx, page, errors } = await open();
    // reads are lazy: the opening read is the start cabinet's (STARFALL); STACKLIGHT's goes out when it is first selected
    await page.waitForFunction(() => LOBBY.boards().starfall.state === 'ok', null, WAIT);
    await page.waitForTimeout(1500);
    assert.deepEqual(log.filter(u => u.startsWith('/board')).map(gameOfUrl), ['starfall'], JSON.stringify(log));
    assert.equal(await page.evaluate(() => LOBBY.boardOf('stacklight').reads), 0);
    await go(page, 'stacklight'); await shot(page, 'stacklight-wall');
    await page.waitForFunction(() => LOBBY.boards().stacklight.state === 'ok', null, WAIT);
    await go(page, 'starfall'); await shot(page, 'starfall-wall');
    const all = await page.evaluate(() => LOBBY.boards());
    const sl = all.stacklight, sf = all.starfall;
    assert.equal(sl.n, 10); assert.deepEqual(sl.rows.map(r => r.name).slice(0, 3), ['SLA', 'SLB', 'SLC']);
    assert.equal(sl.rows[0].score, '40,000'); assert.equal(sl.you, 'ranked'); assert.equal(sl.youRank, '3'); assert.equal(sl.youScore, '38,000');
    assert.equal(sl.rows[2].me, true);
    assert.equal(sf.n, 10); assert.deepEqual(sf.rows.map(r => r.name).slice(0, 3), ['SFA', 'SFB', 'SFC']);
    assert.equal(sf.rows[0].score, '900,000'); assert.equal(sf.you, 'ranked'); assert.equal(sf.youRank, '12'); assert.equal(sf.youScore, '790,000');
    assert.ok(sf.rows.every(r => !r.me), 'rank 12 is below the top 10');
    // the old STARFALL hooks still mean STARFALL
    assert.deepEqual(await page.evaluate(() => LOBBY.board()), sf);
    assert.deepEqual(await page.evaluate(() => LOBBY.boardOf('stacklight')), sl);
    assert.equal(await page.evaluate(() => LOBBY.boardOf('ledgelords').n), 0);
    // the requests: one /board and one /rank per game looked at, each with its own game=; none while idle
    await page.waitForTimeout(3000);
    const boards = log.filter(u => u.startsWith('/board')), ranks = log.filter(u => u.startsWith('/rank'));
    assert.deepEqual(boards.map(gameOfUrl).sort(), ['stacklight', 'starfall'], JSON.stringify(boards));
    assert.deepEqual(ranks.map(gameOfUrl).sort(), ['stacklight', 'starfall'], JSON.stringify(ranks));
    assert.ok(log.every(u => gameOfUrl(u) === 'stacklight' || gameOfUrl(u) === 'starfall'), JSON.stringify(log));
    assert.equal(sl.reads, 1); assert.equal(sf.reads, 1);
    // coming back from a game re-reads the selected wall at once and the other one when it is next selected; each with its own game=
    log.length = 0;
    await page.evaluate(() => LOBBY.reset());
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => LOBBY.boardOf('starfall').reads), 2);
    assert.equal(await page.evaluate(() => LOBBY.boardOf('stacklight').reads), 1, 'the other wall waits until it is selected');
    assert.ok(log.every(u => gameOfUrl(u) === 'starfall'), JSON.stringify(log));
    await go(page, 'stacklight');
    await page.waitForFunction(() => LOBBY.boardOf('stacklight').reads === 2, null, WAIT);
    await page.waitForTimeout(1500);   // the answer comes in
    // (the client's reads are cacheable for 10 s, so the browser may answer STACKLIGHT's repeat /board from its cache: its read count is the proof)
    assert.ok(log.length >= 2 && log.every(u => ['stacklight', 'starfall'].includes(gameOfUrl(u))), JSON.stringify(log));
    assert.ok(log.some(u => u.startsWith('/rank') && gameOfUrl(u) === 'stacklight'), JSON.stringify(log));
    assert.deepEqual((await page.evaluate(() => LOBBY.boardOf('stacklight'))).rows.slice(0, 1).map(r => r.name), ['SLA']);
    assert.deepEqual((await page.evaluate(() => LOBBY.boardOf('starfall'))).rows.slice(0, 1).map(r => r.name), ['SFA']);
    await page.waitForTimeout(2500);
    assert.ok(log.length <= 4, 'no reads while idle: ' + JSON.stringify(log));
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('the COMING SOON cabinet keeps empty rows and is never read', { timeout: 60000 }, async () => {
    log.length = 0;
    const { ctx, page, errors } = await open();
    await page.waitForFunction(() => LOBBY.boards().starfall.state === 'ok', null, WAIT);
    const b = await page.evaluate(() => LOBBY.boardOf('ledgelords'));
    assert.equal(b.state, 'idle'); assert.equal(b.n, 0); assert.equal(b.reads, 0);
    assert.ok(log.every(u => gameOfUrl(u) !== 'ledgelords'));
    assert.deepEqual(errors, []);
    await ctx.close();
  });
});
