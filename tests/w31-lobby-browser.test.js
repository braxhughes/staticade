// Lobby v2, the browser half: the real index.html in headless Chrome (playwright), against a seeded dev board
// (server/dev-server.mjs on a sqlite file we fill with board rows), the dev board down, and no remote board at all.
// A small counting proxy in front of the dev server records every /board and /rank request.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { staticServer, devServer, freePort } from './w25-helpers.mjs';
import { SERVER_VERSION } from '../server/worker.js';

const PID = 'w31-player-0001';
let browser, web, dev, proxy, proxyUrl;
const log = [];

function seed(dbFile) {
  const db = new DatabaseSync(dbFile);
  const ins = db.prepare('INSERT INTO board (game, ver, board, pid, score, t, entry, name, mode, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const pl = db.prepare('INSERT INTO players (game, ver, pid, name, best, t) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 50; i++) {
    const pid = i === 36 ? PID : 'w31-seed-' + String(i).padStart(4, '0'), score = i === 0 ? 1234567 : 200000 - i * 1000;
    const name = i === 1 ? 'LONGNAME10' : 'P' + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + ((i * 7) % 26));
    ins.run('starfall', SERVER_VERSION, 'all', pid, score, 1000 + i, 'e' + String(i).padStart(10, '0'), name, 'free', '2026-10-30T00:00:00.000Z');
    pl.run('starfall', SERVER_VERSION, pid, name, score, 1000 + i);
  }
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

async function open({ lb = '', pid = null } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
  if (pid) await ctx.addInitScript(id => { try { localStorage.setItem('arcade:playerId', JSON.stringify(id)); } catch (e) {} }, pid);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(web.url + 'index.html' + (lb ? '?lb=' + encodeURIComponent(lb) : ''));
  await page.waitForFunction(() => window.LOBBY);
  return { ctx, page, errors };
}
const boardOf = page => page.evaluate(() => LOBBY.board());

describe('w31 lobby in a real browser', { concurrency: false }, () => {
  test('seeded dev board: 10 rows plus the you-line (#37), one board read per visit, none while idle', { timeout: 60000 }, async () => {
    log.length = 0;
    const { ctx, page, errors } = await open({ lb: proxyUrl, pid: PID });
    await page.waitForFunction(() => LOBBY.board().state === 'ok', null, { timeout: 20000 });
    const b = await boardOf(page);
    assert.equal(b.n, 10);
    assert.deepEqual(b.rows.map(r => r.rank), ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    assert.equal(b.rows[0].score, '1,234,567');
    assert.equal(b.rows[1].name, 'LONGN', 'a 10-letter name is clipped');
    assert.equal(b.you, 'ranked'); assert.equal(b.youRank, '37'); assert.equal(b.youScore, fmt(200000 - 36000));
    await page.waitForTimeout(4000);   // idle: the draw loop must not read the board
    const boards = log.filter(u => u.startsWith('/board')), ranks = log.filter(u => u.startsWith('/rank'));
    assert.equal(boards.length, 1, 'board requests ' + JSON.stringify(boards));
    assert.ok(/limit=100/.test(boards[0]) && /board=all/.test(boards[0]), boards[0]);
    assert.equal(ranks.length, 1);
    assert.equal((await boardOf(page)).reads, 1);
    // coming back to the lobby (the return path's refresh) reads once more
    // (the client's ordinary reads are cacheable for 10 s, so the browser may answer it from its cache: at most one more request)
    assert.equal((await page.evaluate(() => LOBBY.refreshBoard())).reads, 2);
    assert.ok(log.filter(u => u.startsWith('/board')).length <= 2);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('dev board down: the board shows OFFLINE', { timeout: 60000 }, async () => {
    const dead = 'http://127.0.0.1:' + await freePort();
    const { ctx, page, errors } = await open({ lb: dead, pid: PID });
    await page.waitForFunction(() => LOBBY.board().state === 'offline', null, { timeout: 20000 });
    assert.equal((await boardOf(page)).n, 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('no remote board: the local board is read (empty here: NO RUNS YET, not ranked)', { timeout: 60000 }, async () => {
    const { ctx, page, errors } = await open();
    await page.waitForFunction(() => LOBBY.board().state === 'ok', null, { timeout: 20000 });
    const b = await boardOf(page);
    assert.equal(b.n, 0); assert.equal(b.you, 'none');
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('three machines in order; Enter swings the cabinet flush before the dolly (coin intro) starts', { timeout: 60000 }, async () => {
    const { ctx, page, errors } = await open();
    await page.evaluate(() => LOBBY.manualHandoff(true));
    const info = await page.evaluate(() => LOBBY.info());
    assert.deepEqual(info.ids, ['stacklight', 'starfall', 'ledgelords']);
    assert.equal(info.id, 'starfall'); assert.equal(info.angle, 72);
    // sample every frame from Enter until the dolly finishes
    const trace = await page.evaluate(() => new Promise(res => {
      const out = [];
      LOBBY.select();
      const f = () => { const i = LOBBY.info(); out.push([i.mode, i.angle, i.dolly]); if (i.handoffReady || out.length > 400) res(out); else requestAnimationFrame(f); };
      requestAnimationFrame(f);
    }));
    const swing = trace.filter(t => t[0] === 'swing'), firstDolly = trace.findIndex(t => t[0] === 'dolly');
    assert.ok(swing.length >= 10, 'the swing takes visible time: ' + swing.length + ' frames');
    assert.ok(swing.some(t => t[1] > 15 && t[1] < 45), 'mid-swing angles are seen');
    for (let k = 1; k < swing.length; k++) assert.ok(swing[k][1] <= swing[k - 1][1] + 1e-9, 'angle only closes');
    assert.ok(firstDolly > 0 && trace.slice(0, firstDolly).every(t => t[0] === 'swing'), 'swing comes first');
    assert.ok(trace.slice(firstDolly).every(t => t[1] === 0), 'flush for the whole dolly');
    assert.ok(trace.slice(0, firstDolly).every(t => t[2] === 0), 'the dolly does not move during the swing');
    assert.equal(trace.at(-1)[2], 1);
    // the coin intro: Starfall loads on the same canvas
    await page.evaluate(() => LOBBY.proceed());
    await page.waitForFunction(() => window.SF && SF.info().state === 'cabinet', null, { timeout: 20000 });
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('Enter and arrows spammed mid-swing change nothing; a COMING SOON cabinet refuses and stays angled', { timeout: 60000 }, async () => {
    const { ctx, page, errors } = await open();
    await page.evaluate(() => { LOBBY.wordmarkSkip(); LOBBY.manualHandoff(true); });
    await page.evaluate(() => LOBBY.go(0));
    await page.waitForFunction(() => !LOBBY.info().moving);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(100);
    let i = await page.evaluate(() => LOBBY.info());
    assert.equal(i.mode, 'lobby'); assert.ok(i.flash > 0, 'refusal flash'); assert.equal(i.angle, 72);
    await page.evaluate(() => LOBBY.go(1));
    await page.waitForFunction(() => !LOBBY.info().moving);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => LOBBY.info().mode === 'swing');   // (an arrow in the same tick as Enter would step first, as before)
    for (const k of ['ArrowRight', 'Enter', 'ArrowLeft', 'Enter', 'ArrowRight']) await page.keyboard.press(k);
    await page.waitForFunction(() => LOBBY.info().handoffReady, null, { timeout: 10000 });
    i = await page.evaluate(() => LOBBY.info());
    assert.equal(i.id, 'starfall'); assert.equal(i.angle, 0);
    assert.deepEqual(errors, []);
    await ctx.close();
  });

  test('the lobby draw loop allocates no typed arrays or arrays per frame (board, swing and slide included)', { timeout: 60000 }, async () => {
    const ctx = await browser.newContext({ viewport: { width: 1000, height: 750 } });
    await ctx.addInitScript(() => {
      window.__alloc = 0; window.__count = false;
      for (const n of ['Float32Array', 'Array', 'Uint8Array']) {
        const Orig = window[n];
        window[n] = new Proxy(Orig, { construct(t, a, nt) { if (window.__count) window.__alloc++; return Reflect.construct(t, a, nt); } });
      }
    });
    const page = await ctx.newPage();
    await page.goto(web.url + 'index.html');
    await page.waitForFunction(() => window.LOBBY && LOBBY.board().state === 'ok');
    const n = await page.evaluate(async () => {
      LOBBY.wordmarkSkip(); LOBBY.manualHandoff(true);
      const frames = k => new Promise(r => { let f = 0; const t = () => { if (++f >= k) r(); else requestAnimationFrame(t); }; requestAnimationFrame(t); });
      window.__alloc = 0; window.__count = true;
      await frames(60); LOBBY.at(0.25, 1); await frames(30); LOBBY.at(null); await frames(60);
      LOBBY.go(1); await frames(60); LOBBY.swingAt(0.5); await frames(30);
      window.__count = false; return window.__alloc;
    });
    assert.equal(n, 0, 'constructions: ' + n);
    await ctx.close();
  });
});

function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
