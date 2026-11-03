// STACKLIGHT in the browser (design slices T3 and T5): the page, the fixed 60 Hz loop, app states title -> play -> pause ->
// over -> entry -> title (board), attract, the dot renderer, the touch side bands (E) and the window.SL test hooks.
// T4 sound: audio-bind.js, called from onEvent, stepSim and render. T5: Free Play and Daily Ridge on the title (modes.js), name
// entry, the local board first then the remote board through the retry queue, attract after 30 s idle (attract.js), the mute key,
// and the lobby route (?from=lobby: Esc on the title goes back to index.html).
//
// Input CALL CONTRACT (games/stacklight/input.js header), followed exactly:
//   every tick: input.poll() first; sim.step(input.word()) exactly once on a tick where a sim frame runs, and never
//   word() on a tick with no sim frame (title, pause, game over, the turn-sideways hold, the tick that pauses);
//   input.beginRun() right after createSim; input.resume() when leaving pause.
import { createGfx } from '../../engine/gl-dots.js';
import { createCrt } from '../../engine/crt.js';
import { createText } from '../../engine/font.js';
import { createLoop } from '../../engine/loop.js';
import { createRotate } from '../../arcade/rotate.js';
import { ARCADE_NAME } from '../../arcade/brand.js';
import { createInput, touchLayout, M_UP, M_DOWN, M_FIRE, M_BACK, M_PAUSE, M_MUTE } from './input.js';
import { createSim } from './sim.js';
import { createFx } from './render/fx.js';
import { createRenderer } from './render.js';
import { W, H, CX, C_BAR, C_PLUS, C_WARN, C_TOP, C_WHITE } from './render/geom.js';
import { installHooks } from './hooks.js';
import { createAudioBind } from './audio-bind.js';
import { GAME_ID } from './defs.js';
import { createLeaderboard, hashReplay } from '../../leaderboard/api.js';
import { localStorageAdapter, getLocalPlayerId } from '../../leaderboard/storage.js';
import { pickLeaderboard, REMOTE_LEADERBOARD_URL } from '../../server/client.js';
import { MODE_DAILY, MODE_FREE, createModes, createEntry, createTable, storageKv, makeVerifyReplay, ratingText, dailyResetText,
  dailyCard, wallClock, createStacklightQueue, gateReads, statusFor, READ_RETRY_MS, versionBoard } from './modes.js';
import { IDLE_TICKS, createAttract } from './attract.js';
import { DEMO_REPLAY } from './demo-replay.js';

// the arcade name lives only in arcade/brand.js (tests/lobby-wordmark.test.js), so the page title gets it from there
document.title = 'STACKLIGHT \u00b7 ' + ARCADE_NAME;
const canvas = document.getElementById('c');
const gfx = createGfx(canvas, { W, H, maxDots: 24000 });
if (!gfx) {
  canvas.style.display = 'none'; document.getElementById('nogl').style.display = 'block';
  throw new Error('STACKLIGHT needs WebGL');
}

// ---------- shared UI state ----------
const SEL_DEFAULT = 1; // the menu rows are DAILY RIDGE, FREE PLAY, CRT, BOARDS, SOUND; FREE PLAY is the one Enter starts at once
const ui = { F: 0, appT: 0, crtOn: true, paused: false, sel: SEL_DEFAULT, page: 'main', mode: 'free', muted: false, touchUi: false, padsDrawnF: -1, padsDrawn: 0 };
let best = 0;
try { ui.crtOn = localStorage.getItem('stacklight.crt') !== '0'; } catch (e) {}
try { ui.muted = localStorage.getItem('stacklight.mute') === '1'; } catch (e) {}
try { best = Math.max(0, +localStorage.getItem('stacklight.hi') || 0); } catch (e) {}
let bestStr = String(best);
function setCrt(v) { ui.crtOn = v; try { localStorage.setItem('stacklight.crt', v ? '1' : '0'); } catch (e) {} }
const sound = createAudioBind(); // T4: music and sound effects, presentation only (audio-bind.js)
// T5 mute (M, or the SOUND row): kept across runs and page loads. Before the first gesture the engine has no context; it reads the flag when it builds one.
function setMute(v) { ui.muted = !!v; sound.setMuted(ui.muted); try { localStorage.setItem('stacklight.mute', ui.muted ? '1' : '0'); } catch (e) {} }
sound.setMuted(ui.muted);

// ---------- E: touch side bands ----------
// Touch in use = a coarse pointer, or any touch on the page this session. Then the field is laid out by the input
// module's own touchLayout (the same boxes its hit test uses), so the drawn pads and the hit areas always match.
const insets = { left: 0, right: 0, top: 0, bottom: 0 };
const insetEl = document.getElementById('insets');
function readInsets() {
  if (!insetEl) return;
  const cs = getComputedStyle(insetEl);
  insets.top = parseFloat(cs.paddingTop) || 0; insets.right = parseFloat(cs.paddingRight) || 0;
  insets.bottom = parseFloat(cs.paddingBottom) || 0; insets.left = parseFloat(cs.paddingLeft) || 0;
}
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
ui.touchUi = coarse;
// runs inside gfx.resize(), before the CRT texture and the bezel are rebuilt (registered first on purpose)
gfx.onResize(view => {
  readInsets();
  if (!ui.touchUi) return;
  const L = touchLayout(innerWidth, innerHeight, insets);
  if (!(L.scale > 0)) return;
  const dpr = view.dpr;
  view.scale = L.scale * dpr;
  view.w = Math.max(1, Math.floor(W * view.scale)); view.h = Math.max(1, Math.floor(H * view.scale));
  view.x = Math.floor(L.field.x * dpr);
  const top = Math.floor(L.field.y * dpr);
  view.y = view.ch - top - view.h; // GL viewport y counts from the bottom
  view.padX = view.x / view.scale; view.padY = top / view.scale;
});
const crt = createCrt(gfx);
const text = createText(gfx.dot, ui);
const rotate = createRotate({ gfx, text }); // the shared turn-sideways screen and the bezel
gfx.resize();

const input = createInput({ target: window, surface: canvas, insets });
const fx = createFx();
sound.listen(window, document);   // sound starts on the first key, press or tap
const renderer = createRenderer({ gfx, text, ui });

// touches for drawing pressed pads (read only; the input module owns the real hit test)
const touches = new Float32Array(20);
let nTouch = 0;
function onTouchDraw(e) {
  const t = e.touches; nTouch = Math.min(10, t.length);
  for (let i = 0; i < nTouch; i++) { touches[i * 2] = t[i].clientX; touches[i * 2 + 1] = t[i].clientY; }
  if (!ui.touchUi) { ui.touchUi = true; gfx.resize(); }
}
for (const n of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) canvas.addEventListener(n, onTouchDraw, { passive: true });

// ---------- modes, boards, attract (modes.js, attract.js) ----------
// Every run is saved on this device first (lb, the local board). The remote board is one config value, REMOTE_LEADERBOARD_URL in
// server/client.js, '' (off) by default; pickLeaderboard returns the local board while it is ''. Test-only override:
// ?lb=http://127.0.0.1:<port> (localhost addresses only) points the page at server/dev-server.mjs. ?from=lobby is the arcade's route.
const query = (() => { try { return new URLSearchParams(location.search); } catch (e) { return new URLSearchParams(''); } })();
const fromLobby = query.get('from') === 'lobby';
const remoteUrl = (() => { const v = query.get('lb'); return v && /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/?$/.test(v) ? v : REMOTE_LEADERBOARD_URL; })();
const lbStore = localStorageAdapter('arcade:');
const lb = createLeaderboard({ storage: lbStore, now: wallClock, verifyReplay: makeVerifyReplay({ now: wallClock }) });
let picked = lb;
try { picked = pickLeaderboard(lb, remoteUrl); } catch (e) { picked = lb; } // a mistyped URL keeps the local board
const remote = picked !== lb ? picked : null;
const localBoard = versionBoard(lb); // reads of the local board show this major version's runs only
const boardLb = remote ? gateReads(remote) : localBoard; // board, rank, attract and /daily reads; a failed read waits 10 s
const kv = storageKv();
const modes = createModes({ lb, kv, now: wallClock });
const table = createTable({ lb: boardLb, game: GAME_ID });
const entry = createEntry(kv.get('name') || 'AAA');
const att = createAttract({ lb: boardLb, fallback: remote ? localBoard : null, demo: DEMO_REPLAY });
const attFx = createFx(); // attract has its own effects state: the player's last run is never disturbed
let run = null;            // the current run's record (null for hook starts, test starts)
let idleT = 0;             // title ticks without input
let typed = 0;             // letter typed this tick on the name entry screen (1..26)
let lastSubmit = null, lastError = null, savingNow = false, playerId = null;
getLocalPlayerId(lbStore).then(id => { playerId = id; refreshTable(); }, () => {});
let boardTimer = 0;
// The server's board answers are cacheable for 10 s, so the read after the player's own submit skips the browser cache (fresh)
const FRESH_MS = 10500;
let freshUntil = 0;
function refreshTable(fresh = false) {
  if (fresh) freshUntil = wallClock() + FRESH_MS;
  table.refresh(fresh || wallClock() < freshUntil).then(() => playerId && boardLb.getRank({ game: GAME_ID, playerId })).then(r => {
    if (r && !table.note && typeof r.league === 'string') table.summary = table.leagueLine(r.league, r.tier, r.trophies);
    if (r && remote) { table.rating = ratingText(r); syncLine(); }
  }, () => {}).then(() => {
    // an open table whose read failed tries again after the read gate's 10 s, not before
    if (table.offline && remote && !boardTimer) boardTimer = setTimeout(() => { boardTimer = 0; if (app === 'title' && ui.page === 'table') refreshTable(); }, READ_RETRY_MS + 100);
  });
}
refreshTable();

// ---------- status line, retry queue, storage warning ----------
const COL_OK = C_BAR, COL_WAIT = C_PLUS, COL_BAD = C_WARN;
const status = { text: '', col: COL_OK };
table.rating = '';
table.lineCol = COL_OK;
function syncLine() { table.line = status.text || table.rating; table.lineCol = status.text ? status.col : COL_OK; }
function setStatus(sx, col = COL_OK) { status.text = sx || ''; status.col = col; syncLine(); }
const WARN_TEXT = 'SCORES NOT KEPT ON THIS DEVICE'; // storage refused (private window, blocked site data): runs last this page only
function storageWorks() { try { const k = 'stacklight.probe'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; } catch (e) { return false; } }
let storageWarn = false;
function checkStorage(probe) {
  if (storageWarn) return;
  if ((probe && !storageWorks()) || lbStore.degraded === true || (sendq && sendq.degraded)) { storageWarn = true; table.warn = WARN_TEXT; }
}
let addRefused = false, lastRemote = null, qTimer = 0;
const sendq = remote ? createStacklightQueue({ remote, now: wallClock, onEvent: onQueueEvent }) : null;
checkStorage(true);
function onQueueEvent(ev) {
  lastRemote = { kind: ev.kind, code: ev.code, res: ev.res };
  setStatus(statusFor(ev, ratingText), ev.kind === 'ok' || ev.kind === 'dup' ? COL_OK : ev.kind === 'held' ? COL_WAIT : COL_BAD);
  if (ev.kind === 'ok' && ev.res) { boardLb.reset(); table.setResult(ev.res); table.hiId = ev.res.id; refreshTable(true); }
  else if (ev.kind === 'held') { boardLb.reset(); table.note = ''; table.hiId = null; refreshTable(true); } // the server answered: read the board again
}
// send what is due now, then set one timer for the next entry that waits (backoff); never per frame
function flushQueue() {
  if (!sendq) return Promise.resolve([]);
  clearTimeout(qTimer); qTimer = 0;
  return sendq.flush().then(done => { scheduleQueue(); return done; }, () => { scheduleQueue(); return []; });
}
function scheduleQueue() {
  clearTimeout(qTimer); qTimer = 0;
  const due = sendq.nextDue();
  if (due !== Infinity) qTimer = setTimeout(flushQueue, Math.max(1000, due - wallClock()));
}
if (sendq) {
  const n = sendq.length;
  if (n) setStatus(statusFor({ kind: 'waiting', left: n }), COL_WAIT);
  setTimeout(flushQueue, 1000); // runs left from an earlier visit
  addEventListener('online', () => { sendq.wake().then(flushQueue); });
  // a hidden tab's timers can fire a minute late, past a Daily's last try; coming back to the page sends what is due now
  document.addEventListener('visibilitychange', () => { if (!document.hidden && sendq.due()) flushQueue(); });
}

// ---------- the Daily card and the Daily's seed ----------
// Remote board on: the Daily's day, seed and ticket come from GET /daily?game=stacklight (never the public seed for an online Daily:
// if the board does not answer, the Daily is not started and the card says why). Remote off: the public dailySeed of the UTC day.
// The card (ridge, rule, level) is read from a sim built with that same seed (modes.js dailyCard), so it is what the run will be.
let card = null, dState = 'ready', dMsg = '', dServer = null, dailyAsk = null, session = 0, wantStart = false;
const rowInfo = { at: -999, day: '', used: false, reset: '' }; // the title's once-a-second facts (titleInfo below)
// a card for another day shows that day's attempt at once (not the old day's until the next titleInfo)
function setCard(seed, dayKey) { if (!card || card.seed !== seed >>> 0 || card.dayKey !== dayKey) { card = dailyCard(seed, dayKey); rowInfo.used = modes.attemptUsed(dayKey); } }
function localDaily() { const r = modes.begin(MODE_DAILY); setCard(r.seed, r.dayKey); return r; }
// make sure a card is showing for today. start: begin the run when the answer is in.
function chooseDaily(start) {
  const today = modes.todayKey();
  if (!remote) { const r = localDaily(); dState = 'ready'; if (start) startRun(r.seed, 'daily', undefined, r); return Promise.resolve(MODE_DAILY); }
  if (dailyAsk) { wantStart = wantStart || !!start; return dailyAsk; } // one ask at a time (before the cache, so the asking state holds)
  // the cached answer: the title card always; a run only on a ticket fresh enough to make the server's window (else ask again).
  // A practice run (today's attempt already used) is never submitted, so its ticket does not matter: it starts on the cache, offline too
  if (dServer && dServer.dayKey >= today && (!start || modes.ticketFresh(dServer) || modes.attemptUsed(dServer.dayKey))) {
    dState = 'ready'; setCard(dServer.seed, dServer.dayKey);
    if (start) startRun(dServer.seed, 'daily', undefined, modes.begin(MODE_DAILY, 0, dServer));
    return Promise.resolve(MODE_DAILY);
  }
  dState = 'asking'; dMsg = ''; wantStart = !!start;
  const sid = session;
  dailyAsk = (async () => {
    const id = playerId || await getLocalPlayerId(lbStore);
    const d = await boardLb.getDaily({ game: GAME_ID, playerId: id });
    modes.begin(MODE_DAILY, 0, d); // throws on an answer that is not a day and a seed
    return d;
  })().then(d => {
    dailyAsk = null;
    if (sid !== session) return null;
    dServer = d; dState = 'ready'; setCard(d.seed, d.dayKey);
    const go = wantStart && app === 'title' && ui.page === 'main' && ui.sel === 0; wantStart = false; // not if the player has moved on (table, other row) while it asked
    if (go) startRun(d.seed, 'daily', undefined, modes.begin(MODE_DAILY, 0, d));
    return MODE_DAILY;
  }, e => {
    dailyAsk = null; wantStart = false;
    if (sid !== session) return null;
    dState = 'off';
    dMsg = e && /^bad daily answer/.test(String(e.message)) ? 'BAD ANSWER' : !e || e.code === 'offline' || e.code === 'timeout' || typeof e.code !== 'string' ? 'OFFLINE'
      : e.code === 'rate_limited' ? 'BUSY, TRY AGAIN SOON' : 'ERROR ' + e.code.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ');
    return null;
  });
  return dailyAsk;
}
if (!remote) localDaily();

// ---------- app state ----------
let app = 'title', sim = null;
const over = { newBest: false, save: false };
const runOpts = { paused: false, over: false, overT: 0, touch: false, best: '0', newBest: false, save: false };
const titleOpts = { sel: SEL_DEFAULT, crtOn: true, muted: false, touch: false, best: '0', page: 'main', card: null, dstate: 'ready', dmsg: '', used: false, reset: '',
  status: '', statusCol: COL_OK, warn: '' };
const entryInfo = { scoreStr: '', modeStr: '', timeStr: '', record: false, left: -2, builds: 0 }; // built when they change, not per frame
const boardOpts = { hints: true, touch: false };
const attOpts = { paused: false, over: false, overT: 0, touch: false, best: '0', newBest: false, save: false };

function setApp(s) { app = s; ui.appT = 0; input.pauseLive = s === 'play'; } // the touch PAUSE pad is live only in a run
function newSeed() { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]; }

// a new run. Builds the sim first, so a bad test start throws before anything changes. runRec is the run record (modes.js) of a run
// started from the title; hooks start runs without one, so those are never claimed or submitted.
function startRun(seed, mode, test, runRec = null) {
  const s = test ? createSim({ seed, mode: 'test', test }) : createSim({ seed, mode });
  sim = s; run = runRec;
  input.beginRun(); // contract 2: right after createSim, before the first word()
  fx.reset(); renderer.hudReset();
  ui.paused = false; over.newBest = false; over.save = false;
  lastSubmit = null; lastError = null; savingNow = false;
  setApp('play');
  return sim;
}
// from the title: Free Play and Daily Ridge runs carry a record (ranked or practice, decided on the first sim frame)
function startFree() { const sd = newSeed(); return startRun(sd, 'arcade', undefined, modes.begin(MODE_FREE, sd)); }
// the first sim frame claims the run (Daily: ranked or practice; the marker is written now). A local Daily that began before midnight
// UTC and reaches its first frame after it starts again, so the day, the seed and the replay agree (nothing was claimed yet).
function afterStep() {
  if (!run || run.claimed) return;
  if (modes.stale(run)) { const r = localDaily(); startRun(r.seed, 'daily', undefined, r); return; }
  modes.claim(run);
}
// one sim frame: keep what the renderer needs from before it, step, hand the events to the renderer
function onEvent(buf, o) { fx.onEvent(buf, o); sound.event(buf, o); }
function stepSim(w) {
  fx.beforeStep(sim);
  sim.step(w);
  sim.drain(onEvent);
  sound.endStep();
  afterStep();
  if (sim.done && app === 'play') toOver();
}
function toOver() {
  setApp('over'); ui.paused = false;
  if (sim.mode !== 'test' && sim.score > best) {
    best = sim.score; bestStr = String(best); over.newBest = true;
    try { localStorage.setItem('stacklight.hi', String(best)); } catch (e) {}
  }
  over.save = !!run && modes.canSubmit(run, sim);
}
function toTitle() { setApp('title'); ui.paused = false; ui.sel = SEL_DEFAULT; ui.mode = ui.sel === 0 ? 'daily' : 'free'; ui.page = 'main'; idleT = 0; titleInfo(); } // ui.mode follows the highlighted row
function pause() { if (app === 'play' && !ui.paused) ui.paused = true; }
function toLobby() {
  if (!fromLobby) return false;
  try { location.assign(new URL('index.html', location.href).href); } catch (e) { return false; }
  return true;
}

// a hidden tab or a lost focus pauses a run (keys and touches cannot be read while away)
document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
addEventListener('blur', pause);
addEventListener('keydown', e => { // typing a letter on the name entry screen
  if (app === 'entry' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && /^Key[A-Z]$/.test(e.code)) typed = e.code.charCodeAt(3) - 64;
});

// ---------- finished runs: name entry and submit ----------
function afterOver() {
  if (run && modes.canSubmit(run, sim)) {
    entry.set(kv.get('name') || 'AAA'); typed = 0; lastError = null; setApp('entry');
    // The entry strings are built once here; the heading follows the same best the HUD uses (over.newBest)
    entryInfo.scoreStr = sim.score + ''; entryInfo.modeStr = run.mode === MODE_DAILY ? 'DAILY RIDGE ' + run.dayKey : 'FREE PLAY';
    entryInfo.record = over.newBest; entryInfo.left = -2; entryInfo.timeStr = ''; entryInfo.builds += 2;
  }
  else toTitle();
}
function openTable(tab = 0) { ui.page = 'table'; table.tab = tab; refreshTable(); }
function confirmEntry() {
  if (savingNow) return lastSubmit;
  savingNow = true; kv.set('name', entry.name);
  const name = entry.name, rp = sim.replay(), rec = run, frames = sim.frame; // frames: kept for the send queue's ticket window
  lastSubmit = (async () => {
    try {
      const id = playerId || await getLocalPlayerId(lbStore);
      const body = modes.body(rec, sim, rp, name, id);
      const res = await modes.submit(rec, sim, rp, name, id); // the local board first, always
      if (sendq) {
        let queued = false; addRefused = false;
        try { queued = (await sendq.add(body, { ticketAt: rec.ticketAt, frames })) === true; } catch (e) { queued = false; }
        if (queued) { setStatus(statusFor({ kind: 'sending' }), COL_OK); table.note = ''; } // then the queue sends it
        else { addRefused = true; setStatus(statusFor({ kind: 'nosend' }), COL_BAD); table.setResult(res); } // saved here, will not be sent
      } else table.setResult(res);
      lastError = null; return res;
    } catch (e) { lastError = e.code || e.message; return null; }
  })().then(res => {
    savingNow = false; table.hiId = res && !sendq ? res.id : null; if (!res) table.note = 'NOT SAVED: ' + lastError;
    checkStorage(false);
    toTitle(); openTable(0);
    if (res && sendq && !addRefused) flushQueue();
    return res;
  });
  return lastSubmit;
}

// ---------- attract mode ----------
let attSim = null;
function startAttract() { att.start(); idleT = 0; attSim = null; setApp('attract'); }
function leaveAttract() { att.stop(); attSim = null; renderer.hudReset(); toTitle(); }
const attBefore = s => attFx.beforeStep(s);
const attEvent = (b, o) => attFx.onEvent(b, o); // effects show, sound stays off

// ---------- one 60 Hz tick ----------
function tick() {
  // Shared screen: a touch phone held upright. A run is paused like the pause key and the tick holds still (no sim frame, so no
  // word()); the first tick after turning sideways is held too. The game stays paused until a tap resumes. The results and the name
  // entry are held too (their timers do not count, nothing is submitted behind the screen).
  if (rotate.tick() && (app === 'play' || app === 'over' || app === 'entry')) {
    input.pauseLive = false; input.poll(); typed = 0;
    pause();
    return;
  }
  ui.F++; ui.appT++;
  input.pauseLive = app === 'play'; // after the turn-sideways check: the PAUSE pad is live again
  input.poll();
  const m = input.menu;
  if ((m & M_MUTE) && app !== 'entry') setMute(!ui.muted); // the mute key works on the title, in a run, paused, in attract
  if (ui.F % 60 === 0 && app === 'title') titleInfo();
  if (app === 'title') {
    if (ui.page === 'table') {
      if (m & M_UP) table.cycle(-1);
      if (m & M_DOWN) table.cycle(1);
      if (m & (M_FIRE | M_BACK)) { ui.page = 'main'; table.hiId = null; table.note = ''; }
      return;
    }
    if (m & ~M_MUTE) idleT = 0; else if (++idleT === IDLE_TICKS - 300) att.prepare(); else if (idleT >= IDLE_TICKS) { startAttract(); return; }
    if (m & M_BACK) { toLobby(); return; }
    if (m & (M_UP | M_DOWN)) { ui.sel = (ui.sel + (m & M_UP ? 4 : 1)) % 5; if (ui.sel < 2) ui.mode = ui.sel === 0 ? 'daily' : 'free'; if (ui.sel === 0) chooseDaily(false); }
    if (m & M_FIRE) {
      if (ui.sel === 0) { ui.mode = 'daily'; chooseDaily(true); }
      else if (ui.sel === 1) { ui.mode = 'free'; startFree(); }
      else if (ui.sel === 2) setCrt(!ui.crtOn);
      else if (ui.sel === 3) openTable(0);
      else setMute(!ui.muted);
    }
    return;
  }
  if (app === 'attract') {
    if (m & ~M_MUTE) { leaveAttract(); return; }
    att.update(attBefore, attEvent);
    return;
  }
  if (app === 'entry') {
    if (!savingNow) {
      const t = typed; typed = 0;
      if (entry.step(t ? 0 : m, t)) confirmEntry();
    }
    return;
  }
  if (app === 'over') {
    if ((ui.appT > 45 && (m & M_FIRE)) || (m & M_BACK)) afterOver();
    return;
  }
  // play
  if (ui.paused) {
    if (m & M_BACK) { toTitle(); return; }                              // Esc while paused: leave the run
    if (m & (M_FIRE | M_PAUSE)) { ui.paused = false; input.resume(); } // contract 3: resume() before the next word()
    return;
  }
  if (m & (M_PAUSE | M_BACK)) { ui.paused = true; return; }             // P, Start or Esc: pause on this tick, no sim frame
  stepSim(input.word());                                                 // contract 1: exactly one word per sim frame
}
// the title's once-a-second facts: the Daily attempt marker, the time to the next Daily, the day (a new day gets a new local card)
function titleInfo() {
  rowInfo.at = ui.F; rowInfo.day = modes.todayKey();
  if (!remote && card && card.dayKey !== rowInfo.day) localDaily();
  rowInfo.used = modes.attemptUsed(card ? card.dayKey : rowInfo.day);
  const r = dailyResetText(wallClock()); if (r !== rowInfo.reset) rowInfo.reset = r;
  checkStorage(false);
}
titleInfo();

// ---------- render ----------
function appName() { return app === 'play' ? 'play' : app === 'over' || app === 'entry' ? 'over' : 'title'; }
function render(al) {
  sound.sync(appName(), ui.paused || rotate.shown(), sim); // music follows the app state; the clock stops while paused or sideways
  if (gfx.lost) return;
  if (rotate.shown()) { rotate.draw(app === 'play' ? 'YOUR RUN IS PAUSED' : app === 'entry' ? 'YOUR SCORE WAITS' : ''); return; }
  gfx.reset();
  if (app === 'title') {
    titleOpts.sel = ui.sel; titleOpts.crtOn = ui.crtOn; titleOpts.muted = ui.muted; titleOpts.touch = ui.touchUi; titleOpts.best = bestStr;
    titleOpts.page = ui.page; titleOpts.card = card; titleOpts.dstate = dState; titleOpts.dmsg = dMsg; titleOpts.used = rowInfo.used; titleOpts.reset = rowInfo.reset;
    titleOpts.status = ui.page === 'main' ? status.text : ''; titleOpts.statusCol = status.col; titleOpts.warn = storageWarn ? WARN_TEXT : '';
    renderer.T[1] = al;
    renderer.drawTitle(titleOpts);
    if (ui.page === 'table') { boardOpts.touch = ui.touchUi; renderer.drawBoard(table, boardOpts); }
  } else if (app === 'entry') {
    const left = savingNow ? -1 : Math.max(0, Math.ceil((1800 - entry.t) / 60));
    if (left !== entryInfo.left) { entryInfo.left = left; entryInfo.timeStr = left < 0 ? 'SAVING...' : 'TIME ' + left; entryInfo.builds++; } // only when the second changes
    renderer.drawEntry(entry, entryInfo);
  } else if (app === 'attract') {
    if (att.phase === 'play' && att.sim) {
      if (att.sim !== attSim) { attSim = att.sim; attFx.reset(); renderer.hudReset(); }
      attOpts.touch = ui.touchUi; attOpts.best = bestStr;
      renderer.T[1] = al;
      renderer.drawRun(att.sim, attFx, attOpts);
      if (att.banner !== '') text(att.banner, CX, 281, C_TOP, 1, 'c', 0.95);
    } else {
      boardOpts.hints = false; boardOpts.touch = ui.touchUi;
      renderer.drawBoard(table, boardOpts); boardOpts.hints = true;
    }
    if (ui.F % 60 < 40) text('PRESS ANY KEY', CX, 291, C_WHITE, 1, 'c', 0.9);
  } else {
    runOpts.paused = ui.paused; runOpts.over = app === 'over'; runOpts.overT = ui.appT; runOpts.touch = ui.touchUi;
    runOpts.best = best; runOpts.newBest = over.newBest; runOpts.save = over.save;
    renderer.T[1] = app === 'play' && !ui.paused ? al : 0;
    renderer.drawRun(sim, fx, runOpts);
  }
  crt.flush(gfx.count(), 0, 0, ui.crtOn, ui.F / 60);
  if (ui.touchUi) {
    // E: the pads live in the side bands, never inside the 400 x 300 field (drawBars paints only the strips)
    gfx.reset();
    ui.padsDrawn = renderer.drawPads(input.getLayout(), touches, nTouch, app === 'play');
    ui.padsDrawnF = ui.F;
    gfx.drawBars();
  } else rotate.drawBezel();
}

const loop = createLoop({ step: tick, render });
loop.start();

// ---------- test hooks (window.SL, games/stacklight/hooks.js) ----------
window.SL = {};
installHooks(window.SL, {
  get sim() { return sim; },
  get app() { return app; },
  ui, fx, input, renderer, rotate, gfx, sound,
  startRun, stepSim, newSeed,
  // T5 (read only unless the hook name says otherwise)
  t5: {
    setMode(m) { // 'free' or 'daily' on the title: highlights that row; daily also makes sure its card is up
      if (m !== 'free' && m !== 'daily') return null;
      if (app !== 'title') toTitle();
      ui.page = 'main'; ui.mode = m; ui.sel = m === 'daily' ? 0 : 1; idleT = 0;
      if (m === 'daily') chooseDaily(false);
      return m;
    },
    modeNow() { return app === 'play' || app === 'over' || app === 'entry' ? sim.mode : ui.mode; },
    title() {
      return { app, sel: ui.sel, page: ui.page, mode: ui.mode, dstate: dState, dmsg: dMsg, used: rowInfo.used, reset: rowInfo.reset, status: status.text, warn: storageWarn ? WARN_TEXT : '',
        muted: ui.muted, card: card ? { seed: card.seed, dayKey: card.dayKey, ridge: card.ridge, rule: card.rule, level: card.level, levelStr: card.levelStr, noStr: card.noStr } : null };
    },
    chooseDaily, startFree,
    runInfo() { return run ? { mode: run.mode, dayKey: run.dayKey, seed: run.seed, claimed: run.claimed, ranked: run.ranked, ticket: run.ticket || null, fromServer: !!run.fromServer, submitted: run.submitted } : null; },
    attemptUsed: day => modes.attemptUsed(day || modes.todayKey()),
    page(p, tab) { if (app !== 'title') toTitle(); if (p === 'table') openTable(tab | 0); else ui.page = 'main'; return ui.page; },
    table() { return { offline: table.offline, loaded: table.loaded, rows: table.rows[table.tab].length, tab: table.tab, note: table.note, summary: table.summary, line: table.line, warn: table.warn, hiId: table.hiId }; },
    scores: (board = 'all', key, unique = true) => localBoard.getBoard({ game: GAME_ID, board, key, limit: 10, unique }),
    boardScores: (board = 'all', key) => boardLb.getBoard({ game: GAME_ID, board, key, limit: 10 }),
    boardReads: () => (remote ? boardLb.requests : 0),
    remote: () => (remote ? remoteUrl : ''),
    queue() {
      if (!sendq) return { length: 0, codes: [], items: [], corrupt: false, dropped: 0 };
      const items = sendq.items();
      return { length: items.length, codes: items.map(e => e.code), items: items.map(e => ({ id: e.id, mode: e.body.mode, dayKey: e.body.dayKey || null, score: e.body.score, tries: e.tries, code: e.code, next: e.next })),
        corrupt: sendq.lastRead.corrupt, dropped: sendq.lastRead.dropped };
    },
    flushQueue(now) { if (!sendq) return Promise.resolve([]); return (now ? sendq.wake() : Promise.resolve()).then(flushQueue).then(d => d.map(e => ({ kind: e.kind, code: e.code, left: e.left }))); },
    status: () => status.text,
    lastRemote: () => lastRemote,
    storageWarn: () => storageWarn,
    nameEntry(name) { if (app !== 'entry') return null; if (name === undefined) return { name: entry.name, pos: entry.pos }; entry.set(name); return confirmEntry(); },
    lastSubmit: () => lastSubmit,
    lastError: () => lastError,
    entryT: () => entry.t,
    entryInfo: () => ({ builds: entryInfo.builds, record: entryInfo.record, scoreStr: entryInfo.scoreStr, modeStr: entryInfo.modeStr, timeStr: entryInfo.timeStr }),
    attractNow() { if (app === 'title') startAttract(); return app; },
    idle(n) { if (n !== undefined) idleT = n | 0; return idleT; },
    attract() { return { app, phase: att.phase, kind: att.kind, banner: att.banner, t: att.t, frame: att.sim ? att.sim.frame : 0, score: att.sim ? att.sim.score : 0, seed: att.sim ? att.sim.seed : null, mode: att.sim ? att.sim.mode : null }; },
    mute: v => { if (v !== undefined) setMute(v); return ui.muted; },
    fromLobby: () => fromLobby
  }
});
