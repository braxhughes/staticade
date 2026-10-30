// Starfall in the browser: app states (cabinet, title, game, results) around the pure sim,
// input, sound, replay recording, best score and the window.SF test hooks.
import { createGfx } from '../../engine/gl-dots.js';
import { createCrt } from '../../engine/crt.js';
import { createText } from '../../engine/font.js';
import { createLoop } from '../../engine/loop.js';
import { createInput, M_UP, M_DOWN, M_FIRE, M_ALT, M_BACK, M_ANY, M_PAUSE, M_MUTE } from '../../engine/input.js';
import { createRecorder } from '../../engine/replay.js';
import { createCabinet } from '../../arcade/cabinet.js';
import { createSim, GAME_ID, GAME_VERSION, TYPE_IDS } from './sim.js';
import { W, H, CX, EV_SFX, EV_HITSTOP, EV_STATE, EV_POPUP, EV_EXPLODE, EV_FX, STATES, SFX_NAMES, SFX_ID } from './defs.js';
import { createAudioBind, ZONE_TRACKS, BOSS_TRACKS } from './audio-bind.js';
import { createFx } from './fx.js';
import { createRenderer } from './render.js';
import { lobbyHit } from './render/core.js';
import { createTitle, MENU } from './title.js';
import { COL } from './sprites.js';
import { installHooks } from './hooks.js';
import { createLeaderboard, hashReplay } from '../../leaderboard/api.js';
import { localStorageAdapter, getLocalPlayerId } from '../../leaderboard/storage.js';
import { pickLeaderboard, REMOTE_LEADERBOARD_URL } from '../../server/client.js';
import { ARCADE_NAME } from '../../arcade/brand.js';
import { MODE_DAILY, MODE_FREE, ENTRY_TICKS, createModes, createEntry, createTable, drawTable, drawEntry, storageKv, makeVerifyReplay,
  ratingText, dailyResetText, shareText, shareScreenLines, SHARE_TAP, shareHit } from './modes.js';
import { createSubmitQueue, gateReads, statusFor, READ_RETRY_MS } from './submit-queue.js';
import { IDLE_TICKS, createAttract, drawBanner } from './attract.js';
import { DEMO_REPLAY } from './demo-replay.js';

const canvas = document.getElementById('c');
const gfx = createGfx(canvas, { W, H, maxDots: 30000 });
if (!gfx) {
  canvas.style.display = 'none'; document.getElementById('nogl').style.display = 'block';
  throw new Error('Starfall needs WebGL');
}
const crt = createCrt(gfx);
gfx.resize();

// ---------- shared UI state (read by render/title) ----------
const ui = { F: 0, appT: 0, hi: 10000, crtOn: true, muted: false, menuSel: 0, menuPage: 'main', paused: false };
try { ui.crtOn = localStorage.getItem('starfall.crt') !== '0'; } catch (e) {}
try { ui.hi = Math.max(ui.hi, +localStorage.getItem('starfall.hi') || 0); } catch (e) {}
function setCrt(v) { ui.crtOn = v; try { localStorage.setItem('starfall.crt', v ? '1' : '0'); } catch (e) {} }
function saveHi() { try { localStorage.setItem('starfall.hi', String(ui.hi)); } catch (e) {} }
const bind = createAudioBind();
function mute(m) { ui.muted = !!m; bind.setMuted(ui.muted); }

const text = createText(gfx.dot, ui);
const fx = createFx(gfx.dot);
// the renderer flushes through this gate so a screen can add dots (banner, labels) before the final draw
let preFlush = null;
const crtGate = { flush(a, b, c, d, e) { if (preFlush) preFlush(); crt.flush(a, b, c, d, e); } };
const renderer = createRenderer({ gfx, crt: crtGate, fx, text, ui });
const title = createTitle({ dot: gfx.dot, text, drawSpr: renderer.drawSpr, panel: renderer.panel, fx, ui });
// a gesture unlocks the audio once (the first one); later gestures never touch the audio clock (pause owns it)
const makeInput = () => createInput({ target: window, surface: canvas, toField: cx => gfx.toFieldX(cx), onGesture: () => { if (bind.unlock()) syncMusic(); } });
let input = makeInput(); // w30: leaving for the lobby disposes it; entering again makes a fresh one
// a hidden tab suspends the audio; visible again resumes it only when not paused and not muted
document.addEventListener('visibilitychange', () => bind.hidden(document.hidden));

// ---------- app state ----------
let app = 'cabinet', sim = null, frozen = false, quiet = false, godFlag = false, hiSavedThisRun = false;
const rec = createRecorder(4096);

// ---------- modes, leaderboard, attract (modes.js, attract.js) ----------
const lbStore = localStorageAdapter('arcade:');
// Card 3b: every run is saved on this device first (lb, the local board). The remote board is one config value,
// REMOTE_LEADERBOARD_URL in server/client.js, '' (off) by default; pickLeaderboard returns the local board while it is ''.
// Test-only override: ?lb=http://127.0.0.1:<port> (localhost addresses only) points the game at server/dev-server.mjs.
function testRemoteUrl() {
  try { const v = new URLSearchParams(location.search).get('lb'); return v && /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/?$/.test(v) ? v : ''; } catch (e) { return ''; }
}
const remoteUrl = testRemoteUrl() || REMOTE_LEADERBOARD_URL;
// card 3c: the verifier also takes a daily on a seed the board handed out on this page (modes.js begin keeps them)
const lb = createLeaderboard({ storage: lbStore, verifyReplay: makeVerifyReplay() });
let picked = lb;
try { picked = pickLeaderboard(lb, remoteUrl); } catch (e) { picked = lb; } // a mistyped URL keeps the local board
const remote = picked !== lb ? picked : null;
const boardLb = remote ? gateReads(remote) : lb; // board, rank and attract reads; a failed read waits 10 s (LOW11)
const kv = storageKv();
const modes = createModes({ lb, kv });
const table = createTable({ lb: boardLb });
const entry = createEntry(kv.get('name') || 'AAA');
const att = createAttract({ lb: boardLb, fallback: remote ? lb : null, demo: DEMO_REPLAY });
let run = null;            // the current run's mode record (null for stage starts)
let selMode = MODE_FREE;   // what the title menu last started
let idleT = 0;             // title ticks without input
let typed = 0;             // letter typed this tick on the name entry screen (1..26)
let lastSubmit = null, lastError = null, savingNow = false, playerId = null;
getLocalPlayerId(lbStore).then(id => { playerId = id; refreshTable(); }, () => {});
let boardTimer = 0;
// The server's board answers are cacheable for 10 s, so the read after the player's own submit skips the browser cache
// (fresh), and so does any table read in the next 10 s (the browser could still hold the pre-submit board for it).
const FRESH_MS = 10500;
let freshUntil = 0;
function refreshTable(fresh = false) {
  if (fresh) freshUntil = Date.now() + FRESH_MS;
  table.refresh(fresh || Date.now() < freshUntil).then(() => playerId && boardLb.getRank({ game: GAME_ID, playerId })).then(r => {
    if (r && !table.note && typeof r.league === 'string') table.summary = table.leagueLine(r.league, r.tier, r.trophies);
    if (r && remote) { table.rating = ratingText(r); syncLine(); } // Best-5 rating line, from the server only
  }, () => {}).then(() => {
    // LOW11: an open table whose read failed tries again after the read gate's 10 s, not before
    if (table.offline && remote && !boardTimer) boardTimer = setTimeout(() => { boardTimer = 0; if (app === 'title' && ui.menuPage === 'table') refreshTable(); }, READ_RETRY_MS + 100);
  });
}
refreshTable();

// ---------- card 3b: status line, retry queue, storage warning, share my daily ----------
const status = { text: '', col: COL.teal };
table.rating = '';
function syncLine() { table.line = status.text || table.rating; table.lineCol = status.text ? status.col : COL.teal; }
function setStatus(s, col = COL.teal) { status.text = s || ''; status.col = col; syncLine(); }
// MED9: storage refused (private window, blocked site data): runs last this page only, and the player is told so
const WARN_TEXT = 'SCORES NOT KEPT ON THIS DEVICE';
function storageWorks() { try { const k = 'starfall.probe'; localStorage.setItem(k, '1'); localStorage.removeItem(k); return true; } catch (e) { return false; } }
let storageWarn = false;
function checkStorage(probe) {
  if (storageWarn) return;
  if ((probe && !storageWorks()) || lbStore.degraded === true || (sendq && sendq.degraded)) { storageWarn = true; table.warn = WARN_TEXT; }
}
let addRefused = false, lastRemote = null, lastDaily = null, lastShare = null, qTimer = 0;
const sendq = remote ? createSubmitQueue({ remote, version: GAME_VERSION, onEvent: onQueueEvent }) : null;
checkStorage(true);
function onQueueEvent(ev) {
  lastRemote = { kind: ev.kind, code: ev.code, res: ev.res };
  setStatus(statusFor(ev, ratingText), ev.kind === 'ok' || ev.kind === 'dup' ? COL.teal : ev.kind === 'held' ? COL.gold : COL.amber);
  if (ev.kind === 'ok' && ev.res) {
    boardLb.reset();
    table.setResult(ev.res); table.hiId = ev.res.id;
    if (lastDaily && lastDaily.id === ev.entry.id && ev.res.league && typeof ev.res.league.label === 'string') lastDaily.league = ev.res.league.label;
    refreshTable(true);
  } else if (ev.kind === 'held') { boardLb.reset(); table.note = ''; table.hiId = null; refreshTable(true); } // the server answered: read the board again
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
  if (due !== Infinity) qTimer = setTimeout(flushQueue, Math.max(1000, due - Date.now()));
}
if (sendq) {
  const n = sendq.length;
  if (n) setStatus(statusFor({ kind: 'waiting', left: n }), COL.amber);
  setTimeout(flushQueue, 1000); // runs left from an earlier visit
  addEventListener('online', () => { sendq.wake().then(flushQueue); });
}
// D35a: after a daily run, C on the high-score table copies '<ARCADE_NAME> Daily #n · score · league' and the page link
const HINT_SHARE = 'UP DOWN: BOARD   C: SHARE   FIRE: BACK';
function share() {
  if (!lastDaily) return Promise.resolve(false);
  const txt = shareText({ arcade: ARCADE_NAME, dayKey: lastDaily.dayKey, score: lastDaily.score, league: lastDaily.league, link: location.origin + location.pathname });
  lastShare = txt;
  const onScreen = () => { table.share = shareScreenLines(txt); setStatus('COPY REFUSED: TEXT ABOVE', COL.amber); return false; };
  let p = null;
  try { p = navigator.clipboard && navigator.clipboard.writeText(txt); } catch (e) { p = null; }
  if (!p || typeof p.then !== 'function') return Promise.resolve(onScreen());
  return p.then(() => { table.share = null; setStatus('COPIED', COL.teal); return true; }, onScreen);
}
// the key hint and the tap target show only while there is a daily to share
function setShareable(on) { table.hint = on ? HINT_SHARE : null; table.tap = on ? SHARE_TAP : null; }
// LOW8: a tap or click on the SHARE target copies it (the table's tap = fire = back is held back for that spot).
// Capture phase on the window runs before the input layer's own canvas listeners.
function onTable() { return app === 'title' && ui.menuPage === 'table' && !!lastDaily && !!table.tap; }
function hitShare(cx, cy) {
  const r = canvas.getBoundingClientRect(), per = gfx.toFieldX(1) - gfx.toFieldX(0); // field units per client px
  if (!(per > 0)) return false;
  const px = 1 / per, fx = gfx.toFieldX(cx), fy = (cy - r.top - (r.height - H * px) / 2) * per;
  return shareHit(fx, fy);
}
let tapShare = false; // a touch that began on the target
addEventListener('touchstart', e => {
  if (e.target !== canvas || !onTable() || e.touches.length !== 1 || !hitShare(e.touches[0].clientX, e.touches[0].clientY)) return;
  tapShare = true; e.stopPropagation(); e.preventDefault();
}, { capture: true, passive: false });
addEventListener('touchmove', e => { if (tapShare) { e.stopPropagation(); e.preventDefault(); } }, { capture: true, passive: false });
function endTouch(e) {
  if (!tapShare) return;
  e.stopPropagation(); e.preventDefault();
  if (!e.touches.length) { tapShare = false; if (e.type === 'touchend' && onTable()) share(); }
}
addEventListener('touchend', endTouch, { capture: true, passive: false });
addEventListener('touchcancel', endTouch, { capture: true, passive: false });
addEventListener('mousedown', e => { if (e.target === canvas && onTable() && hitShare(e.clientX, e.clientY)) e.stopPropagation(); }, true);
addEventListener('click', e => { if (e.target === canvas && onTable() && hitShare(e.clientX, e.clientY)) share(); }, true);
// w30b: the touch LOBBY button on the pause screen. Touch players only: a coarse pointer (as the lobby decides its TAP hint),
// or any touch on the canvas this session. A touch that begins on the button is held back from the input layer (so it is not
// the tap that resumes); lifting it still on the button asks the tick to leave. Every other tap resumes as before.
const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
ui.touchUi = coarse;
let tapLobby = false, lobbyAsk = false;
function onLobbyBtn() { return !away && ui.paused && ui.canLobby && ui.touchUi && app === 'game'; }
function hitLobby(cx, cy) {
  const r = canvas.getBoundingClientRect(), per = gfx.toFieldX(1) - gfx.toFieldX(0);
  if (!(per > 0)) return false;
  const px = 1 / per;
  return lobbyHit(gfx.toFieldX(cx), (cy - r.top - (r.height - H * px) / 2) * per);
}
addEventListener('touchstart', e => {
  if (e.target !== canvas) return;
  ui.touchUi = true;
  if (!onLobbyBtn() || e.touches.length !== 1 || !hitLobby(e.touches[0].clientX, e.touches[0].clientY)) return;
  tapLobby = true; e.stopPropagation(); e.preventDefault();
}, { capture: true, passive: false });
addEventListener('touchmove', e => { if (tapLobby) { e.stopPropagation(); e.preventDefault(); } }, { capture: true, passive: false });
function endLobbyTouch(e) {
  if (!tapLobby) return;
  e.stopPropagation(); e.preventDefault();
  if (e.touches.length) return;
  tapLobby = false;
  const c = e.changedTouches[0];
  if (e.type === 'touchend' && c && onLobbyBtn() && hitLobby(c.clientX, c.clientY)) lobbyAsk = true;
}
addEventListener('touchend', endLobbyTouch, { capture: true, passive: false });
addEventListener('touchcancel', endLobbyTouch, { capture: true, passive: false });
addEventListener('keydown', e => { // typing a letter on the name entry screen
  if (app === 'entry' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && /^Key[A-Z]$/.test(e.code)) typed = e.code.charCodeAt(3) - 64;
  // the clipboard wants a real key press, so the share runs here and not in the tick
  if (e.code === 'KeyC' && !e.repeat && !e.ctrlKey && !e.metaKey && app === 'title' && ui.menuPage === 'table' && lastDaily) share();
});
function setApp(s) { app = s; ui.appT = 0; syncMusic(); }

const cab = createCabinet({
  W, H, marquee: 'STARFALL', sub: 'FIXED SHOOTER',
  palette: { teal: COL.teal, amber: COL.amber, gold: COL.gold, dim: COL.dim },
  onToss() { bind.sfxName('toss'); },
  onClunk() { bind.sfxName('clunk'); title.scatter(); },
  onDone() { setApp('title'); ui.menuPage = 'main'; }
});

function newSeed() { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]; }
// stage > 1 is a practice start (mode 'stageN'); opts.seed / opts.daily pick the seed
function startRun(stage = 1, opts = {}) {
  const daily = !!opts.daily;
  // daily: today's UTC seed. A seed passed in (test hook) or a stage start is a practice run: no run record, never submitted.
  const custom = opts.seed != null || stage > 1;
  run = custom ? null : daily ? (opts.server ? modes.begin(MODE_DAILY, 0, opts.server) : modes.begin(MODE_DAILY)) : modes.begin(MODE_FREE, newSeed());
  if (!custom) selMode = run.mode;
  const seed = run ? run.seed : opts.seed != null ? opts.seed >>> 0 : newSeed();
  const mode = stage > 1 ? 'stage' + stage : daily ? 'daily' : 'arcade';
  sim = createSim({ seed, mode });
  if (godFlag) sim.setGod(true);
  rec.reset(); frozen = false; hiSavedThisRun = false; bossKilled = false;
  lastDaily = null; setShareable(false); table.share = null; // LOW7: a new run ends the old run's share
  input.clearLatches();
  setApp('game');
  bossLive = false; livesBefore = sim.lives; drainSim();
}
// one sim frame: what the audio needs from before the step (boss on, lives), then the step, the replay and the events
function stepGame(w) {
  bossLive = sim.boss.on; livesBefore = sim.lives;
  sim.step(w); rec.push(w);
  drainSim();
}
// STARLIGHT beat clock position for the audio: stage frame (negative on the stage card), null off STARLIGHT
function beatPos() {
  if (sim.stageKind !== 'bonus') return null;
  return sim.state === 'play' ? sim.stageT - 1 : sim.state === 'intro' ? sim.stateT - 132 : null;
}
function drainSim() { lastKillTi = -1; lifeAwards = sim.lives - livesBefore; sim.drain(onEvent); }

// sound for one sim sound id; true only when a sound was really started (see audio-bind.js for the id -> sound map)
let lastKillTi = -1;     // type index of the explosion event just before a pop in this batch (-1 none: neutral kill)
let bossLive = false;    // a boss was on before this step (the last hit of a boss turns boss.on off within the step)
let livesBefore = 0;     // lives before this step
let lifeAwards = 0;      // ships awarded in this step, not yet matched to a life id
let bossKilled = false;  // the boss of this stage was destroyed (bossDie seen); an escaped boss gets no bossDefeat
function playSfx(id, arg) {
  if (id === SFX_ID.bossDie) bossKilled = true;
  const ti = lastKillTi;
  if (id === SFX_ID.pop || id === SFX_ID.die) lastKillTi = -1; // a remembered kind belongs to one pop only
  let noShip = false;
  // STARLIGHT perfect sends 'life' with no ship: in a bonus stage a life id only counts while ships were awarded this step
  if (id === SFX_ID.life && sim !== null && sim.stageKind === 'bonus') noShip = lifeAwards-- <= 0;
  if (quiet) return false;
  return bind.playSfx(id, arg, sim !== null && (bossLive || sim.boss.on), id === SFX_ID.pop ? TYPE_IDS[ti] : undefined, noShip);
}
// the music the current app state wants: title, zone, boss or bonus track, name entry; silence in attract and after the run
function wantTrack() {
  switch (app) {
    case 'title': return 'title';
    case 'entry': return 'nameEntry';
    case 'game': {
      const st = sim.state;
      if (st === 'bossOut' || st === 'clear' || st === 'bonusEnd' || st === 'gameover') return null; // a jingle (or silence) covers these
      return sim.stageKind === 'boss' ? BOSS_TRACKS[sim.zone] : sim.stageKind === 'bonus' ? 'bonus' : sim.loop > 0 ? 'endless' : ZONE_TRACKS[sim.zone];
    }
    default: return null;
  }
}
// S13b: the beat position and music intensity (heat / 100, the same number as SF.info().intensity) go in before the track is chosen,
// so a STARLIGHT track starts on the sim's bar edge; outside a run the intensity is the engine default 0.5
function syncMusic() {
  const g = app === 'game' && sim !== null;
  bind.beat(g ? beatPos() : null);
  bind.intensity(g ? sim.heat / 100 : 0.5);
  bind.music(wantTrack() || null);
}
function onEvent(b, o) {
  switch (b[o]) {
    case EV_SFX: playSfx(b[o + 1], b[o + 2]); return;
    case EV_HITSTOP: return; // hit-stop is sim state now (sim.hitstop); the sim still steps every tick
    case EV_STATE: {
      const s = STATES[b[o + 1]];
      if (s === 'clear' || s === 'gameover') saveHi();
      if (s === 'intro') bossKilled = false;
      if (!quiet) {
        syncMusic(); // the track this state wants first, so the jingle below belongs to it and is not cut at once
        // boss stage: bossDefeat only after a real kill, an escaped boss gets none (the warp already marks it);
        // STARLIGHT: its one stageClear plays at bonusEnd, the clear after it adds none
        if (s === 'clear') { if (sim.stageKind === 'boss') { if (bossKilled) bind.jingle('bossDefeat'); } else if (sim.stageKind !== 'bonus') bind.jingle('stageClear'); }
        else if (s === 'bonusEnd') bind.jingle('stageClear');
        else if (s === 'gameover') bind.jingle('gameOver');
      }
      return;
    }
    case EV_EXPLODE: lastKillTi = b[o + 1]; fx.handle(b, o); return;
    default: fx.handle(b, o);
  }
}
function checkHi() {
  if (sim.score > ui.hi) {
    ui.hi = sim.score;
    if (!hiSavedThisRun) { hiSavedThisRun = true; saveHi(); }
  }
}

function updTitle(m) {
  title.update();
  if ((m & M_BACK) && ui.menuPage === 'main' && toLobby()) return; // w30: Esc / Backspace on the main menu goes back to the lobby (sub-pages go to the main menu first)
  if (ui.appT < 20) return;
  if (m) idleT = 0; else if (++idleT === IDLE_TICKS - 300) att.prepare(); else if (idleT >= IDLE_TICKS) { startAttract(); return; }
  if (ui.menuPage === 'main') {
    if (m & M_UP) { ui.menuSel = (ui.menuSel + MENU.length - 1) % MENU.length; bind.sfxName('menuMove'); }
    if (m & M_DOWN) { ui.menuSel = (ui.menuSel + 1) % MENU.length; bind.sfxName('menuMove'); }
    if (m & (M_FIRE | M_ALT)) {
      bind.sfxName('menuSelect');
      if (ui.menuSel === 0) startRun(1);
      else if (ui.menuSel === 1) chooseDaily();
      else if (ui.menuSel === 2) ui.menuPage = 'how';
      else if (ui.menuSel === 3) mute(!ui.muted);
      else if (ui.menuSel === 4) setCrt(!ui.crtOn);
      else openTable();
    }
  } else if (ui.menuPage === 'dailyOff') { // card 3c: the board did not answer /daily
    if (m & (M_FIRE | M_ALT)) { bind.sfxName('menuSelect'); ui.menuPage = 'main'; startRun(1); }
    else if (m & M_BACK) { ui.menuPage = 'main'; bind.sfxName('menuMove'); }
  } else if (ui.menuPage === 'table') {
    if (m & M_UP) { table.cycle(-1); bind.sfxName('menuMove'); }
    if (m & M_DOWN) { table.cycle(1); bind.sfxName('menuMove'); }
    if (m & (M_FIRE | M_BACK | M_ALT)) { ui.menuPage = 'main'; table.hiId = null; table.note = ''; table.share = null; bind.sfxName('menuMove'); }
  } else if (m & (M_FIRE | M_BACK | M_ALT)) { ui.menuPage = 'main'; bind.sfxName('menuMove'); }
}
function openTable(tab = 0) { ui.menuPage = 'table'; table.tab = tab; refreshTable(); }

// ---------- card 3c: the Daily from the board ----------
// Remote board on: DAILY FLIGHT asks the server for today's seed and ticket first (GET /daily, through the read gate
// and the client's timeout). The run uses the server's day and seed and the submit carries the ticket. If the board
// does not answer, the Daily is not started (never the public seed for an online daily): the player sees why and may
// take FREE PLAY. Remote board off: the local daily, exactly as before.
let dailyAsk = null, dailyNote = '', dailyOffCode = '';
function chooseDaily() {
  if (!remote) { startRun(1, { daily: true }); return MODE_DAILY; }
  if (dailyAsk) return dailyAsk;
  dailyNote = 'DAILY: ASKING THE BOARD...';
  const fromApp = app, fromRun = run, sid = session;
  dailyAsk = (async () => {
    const id = playerId || await getLocalPlayerId(lbStore);
    const d = await boardLb.getDaily({ game: GAME_ID, playerId: id });
    modes.begin(MODE_DAILY, 0, d); // throws on an answer that is not a day and a seed
    return d;
  })().then(d => {
    if (sid !== session) return null; // w30: the player left for the lobby meanwhile (leave already cleared the ask)
    dailyAsk = null; dailyNote = '';
    if (app !== fromApp || run !== fromRun) return null; // the player went somewhere else meanwhile (free play, attract)
    startRun(1, { daily: true, server: d });
    return MODE_DAILY;
  }, e => {
    if (sid !== session) return null;
    dailyAsk = null; dailyNote = '';
    dailyOffCode = !e || e.code === 'offline' || e.code === 'timeout' || typeof e.code !== 'string' ? 'OFFLINE' : e.code === 'rate_limited' ? 'BUSY, TRY AGAIN SOON' : 'ERROR ' + e.code.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ');
    if (app === 'title' && app === fromApp) { ui.menuPage = 'dailyOff'; ui.appT = 20; }
    return null;
  });
  return dailyAsk;
}

// ---------- attract mode ----------
function startAttract() { att.start(); idleT = 0; setApp('attract'); }
function leaveAttract() { att.stop(); idleT = 0; setApp('title'); title.scatter(); ui.menuPage = 'main'; }
// effects show, sound stays off
function onAttractEvent(b, o) { const k = b[o]; if (k === EV_SFX || k === EV_HITSTOP || k === EV_STATE) return; fx.handle(b, o); }

// ---------- finished runs: name entry and submit ----------
// the first gameplay frame of stage 1 claims the run (daily: ranked or practice; the marker is written now)
// A daily run that began before midnight UTC and reaches its first play frame after it starts again, so the day, the seed
// and the replay agree (the intro replays; nothing was claimed yet).
function afterStep() {
  if (!run || run.claimed || sim.state !== 'play') return;
  if (modes.stale(run)) { startRun(1, { daily: true }); return; }
  modes.claim(run);
}
function afterResults() {
  if (modes.canSubmit(run, sim)) { entry.set(kv.get('name') || 'AAA'); typed = 0; lastError = null; setApp('entry'); }
  else { setApp('title'); title.scatter(); ui.menuPage = 'main'; }
}
function confirmEntry() {
  if (savingNow) return lastSubmit;
  savingNow = true; kv.set('name', entry.name);
  const name = entry.name, rp = replayString();
  lastSubmit = (async () => {
    try {
      const id = playerId || await getLocalPlayerId(lbStore);
      const body = modes.body(run, sim, rp, name, id);
      const res = await modes.submit(run, sim, rp, name, id); // the local board first, always
      // LOW7: the share belongs to the run just finished; a free run clears it
      lastDaily = run.mode === MODE_DAILY ? { id: hashReplay(rp), dayKey: run.dayKey, score: sim.score, league: remote ? null : res.league && res.league.label } : null; // remote on: the league is the server's (set in onQueueEvent), never the local board's guess
      if (sendq) {
        let queued = false; addRefused = false;
        try { queued = (await sendq.add(body)) === true; } catch (e) { queued = false; }
        if (queued) { setStatus(statusFor({ kind: 'sending' }), COL.teal); table.note = ''; } // then the queue sends it
        else { addRefused = true; setStatus(statusFor({ kind: 'nosend' }), COL.amber); table.setResult(res); } // LOW5: saved here, will not be sent
      } else table.setResult(res);
      lastError = null; return res;
    } catch (e) { lastError = e.code || e.message; return null; }
  })().then(res => {
    savingNow = false; table.hiId = res && !sendq ? res.id : null; if (!res) table.note = 'NOT SAVED: ' + lastError;
    setShareable(!!lastDaily); checkStorage(false);
    setApp('title'); title.scatter(); openTable(0);
    if (res && sendq && !addRefused) flushQueue();
    return res;
  });
  return lastSubmit;
}

// ---------- w30: back to the arcade lobby ----------
// The lobby (arcade/lobby.js) loads this module into its own page and hands over its return function. Starfall opened alone
// (starfall.html) has none, so back does nothing there. Leaving stops the loop, takes the input listeners off and silences and
// suspends the audio; the module stays loaded, so entering again (enterStarfall) is a fresh cabinet with no second loop,
// listener set or audio engine. A run left mid-way is abandoned: nothing is submitted, and a daily that was already claimed
// (first play frame seen) stays used exactly as if the tab had been closed; an unclaimed one stays unclaimed.
let lobbyReturn = null, session = 0, away = false;
export function setLobbyReturn(fn) { lobbyReturn = typeof fn === 'function' ? fn : null; ui.canLobby = lobbyReturn !== null; }
function toLobby() {
  if (!lobbyReturn || away) return false;
  leaveStarfall(); lobbyReturn();
  return true;
}
export function leaveStarfall() {
  if (away) return;
  away = true; session++; tapLobby = false; lobbyAsk = false;
  loop.stop(); input.dispose();
  clearTimeout(boardTimer); boardTimer = 0;
  ui.paused = false; audioPaused = true; bind.pause(true); bind.music(null);
  setTimeout(() => { if (away) bind.settle(); }, 400);
  att.stop(); dailyAsk = null; dailyNote = '';
  sim = null; run = null; frozen = false; quiet = false; typed = 0;
  ui.menuPage = 'main'; ui.menuSel = 0; idleT = 0; app = 'cabinet';
}
export function enterStarfall() {
  if (!away) return;
  away = false;
  input = makeInput();
  audioPaused = false; bind.pause(false);
  cab.reset(); title.scatter(); setApp('cabinet');
  loop.start();
}

// one 60 Hz tick
let audioPaused = false;
function tick() {
  if (away) return; // w30b: loop.stop() lets the rest of this frame's steps run; after leaving, none of them may touch Starfall
  ui.F++;
  input.poll();
  const m = input.menu;
  if ((m & M_MUTE) && app !== 'entry') mute(!ui.muted);
  if ((m & M_PAUSE) && app !== 'title' && app !== 'cabinet' && app !== 'attract' && app !== 'entry') ui.paused = !ui.paused;
  else if ((m & M_BACK) && app === 'game') { // w30: in a run Esc / Backspace pauses; while paused it leaves for the lobby (the run is abandoned, nothing is submitted)
    if (!ui.paused) ui.paused = true; else if (toLobby()) return;
  }
  if (ui.paused !== audioPaused) { audioPaused = ui.paused; bind.pause(audioPaused); }
  if (lobbyAsk) { lobbyAsk = false; if (ui.paused && app === 'game' && toLobby()) return; } // w30b: the touch LOBBY button
  if (ui.paused) { if (m & M_FIRE) { ui.paused = false; input.clearLatches(); } return; }
  fx.savePrev();
  // during sim hit-stop the effects freeze too; during bossOut particles run at half speed (cosmetic slow-mo)
  frozen = app === 'game' && sim.hitstop > 0;
  ui.appT++;
  const slow = app === 'game' && sim.state === 'bossOut' && (ui.F & 1);
  if (!frozen && !slow) fx.update(vsim() ? vsim().warp : 0, !(app === 'game' && sim.state === 'dying'));
  switch (app) {
    case 'cabinet': if ((m & M_BACK) && toLobby()) return; title.update(); cab.tick((m & M_FIRE) !== 0, (m & M_ANY) !== 0); return;
    case 'title': updTitle(m); return;
    case 'attract':
      if ((m & M_BACK) && toLobby()) return;
      if (m & (M_ANY | M_FIRE | M_BACK | M_ALT | M_UP | M_DOWN)) { leaveAttract(); return; }
      att.update(onAttractEvent); fx.updatePulse(); return;
    case 'entry':
      if (!savingNow) {
        const t = typed; typed = 0;
        if (entry.step(t ? 0 : m, t)) confirmEntry();
      }
      return;
    case 'game': {
      stepGame(input.word());
      afterStep();
      checkHi();
      if (sim.done) setApp('results'); else syncMusic();
      break;
    }
    case 'results':
      if ((ui.appT > 60 && (m & M_FIRE)) || ui.appT > 900) afterResults();
      break;
  }
  if (!frozen) fx.updatePulse();
}

const rowInfo = { at: -999, day: '', used: false, reset: '' };
const fxEv = new Float64Array(10); // SF.fxTest's one synthetic event (same layout as the sim's event ring)
const vsim = () => (app === 'attract' ? att.sim : sim);
function drawScreen() {
  fx.drawStars(sim ? sim.warp : 0, ui.F); title.draw();
  if (ui.menuPage === 'table') drawTable(R, table, ui.F);
  else if (ui.menuPage === 'dailyOff') {
    renderer.panel(40, 104, 320, 112, COL.violet, 0.4);
    text('DAILY NEEDS THE BOARD: ' + dailyOffCode, CX, 122, COL.amber, 1, 'c');
    text('THE DAILY IS THE SAME LEVEL FOR EVERYONE,', CX, 146, COL.dim, 1, 'c');
    text('SO IT COMES FROM THE SCORE BOARD.', CX, 158, COL.dim, 1, 'c');
    text('FIRE: FREE PLAY', CX, 184, COL.white, 1, 'c', ui.F % 50 < 34 ? 1 : 0.5);
    text('BACK: MENU', CX, 198, COL.dim, 1, 'c');
  } else if (ui.menuPage === 'main') {
    if (dailyNote) text(dailyNote, CX, 84, COL.teal, 1, 'c');
    else if (status.text) text(status.text, CX, 84, status.col, 1, 'c'); // between the subtitle and the menu panel
    if (storageWarn) text(WARN_TEXT, CX, 95, COL.amber, 1, 'c');
    if (ui.menuSel < 2) {
      if (ui.F - rowInfo.at >= 60 || ui.F < rowInfo.at) { // Date and storage once a second, not every frame
        rowInfo.at = ui.F; rowInfo.day = modes.todayKey(); rowInfo.used = modes.attemptUsed(rowInfo.day);
        const r = dailyResetText(Date.now()); if (r !== rowInfo.reset) rowInfo.reset = r; // LOW12, UTC
        checkStorage(false);
      }
      const day = rowInfo.day, used = rowInfo.used;
      const s = ui.menuSel === 1 ? (used ? 'DAILY ' + day + ': ATTEMPT USED, PRACTICE' : 'DAILY ' + day + ': RANKED ATTEMPT READY') : 'RANDOM SEED, EVERY RUN RANKS';
      text(s, CX, 258, ui.menuSel === 1 && !used ? COL.gold : COL.dim, 1, 'c');
      if (ui.menuSel === 1) text(rowInfo.reset, CX, 235, COL.teal, 1, 'c', 0.8);
    }
  }
}
const R = { dot: gfx.dot, text, panel: renderer.panel, ui };
const RA = { dot: gfx.dot, text, panel: renderer.panel }; // no ui: the table skips its key hint in attract mode
const entryInfo = { scoreStr: '', modeStr: '', timeStr: '' };

function attractOverlay() { drawBanner(R, att, ui.F); }
// a small label on the daily run: ranked attempt or practice (and on the results screen). Bottom row, in the gap between
// the reserve-life ships (x 10 to about 71) and the kindle meter (its wing-feed dot at CX-26 = 174, dots CX-22 to CX+23).
// The label starts at x 84 and ends at x 155 ("DAILY FLIGHT"). The heat flame (hud-heat.js, x about 229 to 240, up to 22
// units high) and the stage badges (x 310 to 392) are further right, the held-power timer bar (y H-15, x 8 to 66) is
// above the lives; nothing else draws there, and the top row (chain readout, pips, boss bar) is far away.
const LABEL_X = 84;
function runLabel() {
  if (!run || !run.claimed) return;
  if (run.mode === MODE_DAILY) text(run.ranked ? 'DAILY FLIGHT' : 'PRACTICE', LABEL_X, H - 11, run.ranked ? COL.gold : COL.dim, 1, 'l', 0.7);
  if (app === 'results' && !run.ranked) text('PRACTICE: NOT RANKED', CX, 228, COL.dim, 1, 'c');
}

// fps: rAF timestamps over the last second
const fpsT = new Float64Array(256); let fpsN = 0;
function render(al) {
  if (away) return; // w30b: no stray Starfall frame over the lobby after leaving
  fpsT[fpsN++ & 255] = performance.now();
  if (gfx.lost) return;
  const a = ui.paused || frozen ? 1 : al;
  if (app === 'cabinet') cab.render(gfx, crt, text, a, ui.F, ui.crtOn, drawScreen);
  else if (app === 'title') { gfx.reset(); drawScreen(); crt.flush(gfx.count(), 0, 0, ui.crtOn, ui.F / 60); }
  else if (app === 'entry') {
    gfx.reset(); fx.drawStars(0, ui.F);
    entryInfo.scoreStr = String(sim.score);
    entryInfo.modeStr = run.mode === MODE_DAILY ? 'DAILY FLIGHT ' + run.dayKey : 'FREE PLAY';
    entryInfo.timeStr = savingNow ? 'SAVING...' : 'TIME ' + Math.max(0, Math.ceil((ENTRY_TICKS - entry.t) / 60));
    drawEntry(R, entry, entryInfo, ui.F);
    crt.flush(gfx.count(), 0, 0, ui.crtOn, ui.F / 60);
  } else if (app === 'attract') {
    if (att.phase === 'play' && att.sim) { preFlush = attractOverlay; renderer.drawGame(att.sim, a, att.sim.state); preFlush = null; }
    else { gfx.reset(); fx.drawStars(0, ui.F); drawTable(RA, table, ui.F); drawBanner(R, { banner: '' }, ui.F); crt.flush(gfx.count(), 0, 0, ui.crtOn, ui.F / 60); }
  } else {
    preFlush = runLabel; renderer.drawGame(sim, a, app === 'results' ? 'results' : sim.state); preFlush = null;
  }
}

addEventListener('pagehide', saveHi);
const loop = createLoop({ step: tick, render });
loop.start();

function replayString() {
  if (!sim) return null;
  return rec.encode({ game: GAME_ID, version: GAME_VERSION, seed: sim.seed, mode: sim.mode + (sim.tainted ? '+dev' : '') });
}

// ---------- test hooks for automated checks ----------
window.SF = {
  start(n, seed) { startRun(n || 1, seed != null ? { seed } : {}); },
  daily() { return chooseDaily(); }, // card 3c: remote on, a promise ('daily' once the run started, null if the board failed)
  // modes: scores(board, key) reads a board; page(name) shows a title page; attractNow() / idle() drive attract mode;
  // nameEntry(name) types a name on the entry screen and saves; lastSubmit() the saved result (or null)
  app() { return app; }, // w30: the app state even when a run is on (state shows the sim state then)
  away() { return away; },
  paused() { return ui.paused; },
  touchUi() { return !!ui.touchUi; }, // w30b: touch player (coarse pointer or a touch seen this session)
  lobbyButton() { return ui.lobbyBtnF !== undefined && ui.F - ui.lobbyBtnF <= 2; }, // w30b: the touch LOBBY button was drawn in the last frames
  scores(board = 'all', key, unique = true) { return lb.getBoard({ game: GAME_ID, board, key, limit: 10, unique }); }, // unique false = every saved run, not the best per player
  // card 3b: remote() the remote board's address ('' = off); boardScores(board) reads the board the table shows
  // (remote when on, through the 10 s read gate); queue() the retry queue; flushQueue() sends what is due now (or
  // everything with now = true); status() the status line text; table() what the table shows; share() runs the
  // share action (C key); lastRemote() the last queue answer; storageWarn() whether the storage warning shows
  remote() { return remote ? remoteUrl : ''; },
  boardScores(board = 'all', key) { return boardLb.getBoard({ game: GAME_ID, board, key, limit: 10 }); },
  boardReads() { return remote ? boardLb.requests : 0; },
  queue() {
    if (!sendq) return { length: 0, codes: [], items: [], corrupt: false, dropped: 0 };
    const items = sendq.items();
    return { length: items.length, codes: items.map(e => e.code), items: items.map(e => ({ id: e.id, mode: e.body.mode, dayKey: e.body.dayKey || null, score: e.body.score, tries: e.tries, code: e.code, next: e.next })),
      corrupt: sendq.lastRead.corrupt, dropped: sendq.lastRead.dropped };
  },
  flushQueue(now) { if (!sendq) return Promise.resolve([]); return (now ? sendq.wake() : Promise.resolve()).then(flushQueue).then(d => d.map(e => ({ kind: e.kind, code: e.code, left: e.left }))); },
  status() { return status.text; },
  table() { return { offline: table.offline, loaded: table.loaded, rows: table.rows[table.tab].length, note: table.note, summary: table.summary, line: table.line, warn: table.warn, share: table.share, hint: table.hint, rating: table.rating }; },
  share() { return share(); },
  lastShare() { return lastShare; },
  lastRemote() { return lastRemote; },
  storageWarn() { return storageWarn; },
  page(p, tab) { if (app !== 'title') { setApp('title'); title.scatter(); } if (p === 'table') openTable(tab | 0); else ui.menuPage = p || 'main'; ui.appT = 30; return ui.menuPage; },
  attractNow() { startAttract(); },
  idle() { return idleT; },
  attract() { return { phase: att.phase, kind: att.kind, banner: att.banner, t: att.t, frame: att.sim ? att.sim.frame : 0, score: att.sim ? att.sim.score : 0, seed: att.sim ? att.sim.seed : null }; },
  nameEntry(name) { if (app !== 'entry') return null; if (name === undefined) return { name: entry.name, pos: entry.pos }; entry.set(name); return confirmEntry(); },
  lastSubmit() { return lastSubmit; },
  lastError() { return lastError; },
  runInfo() { return run ? { mode: run.mode, dayKey: run.dayKey, seed: run.seed, claimed: run.claimed, ranked: run.ranked, ticket: run.ticket || null, fromServer: !!run.fromServer } : null; },
  dailyOff() { return ui.menuPage === 'dailyOff' ? 'DAILY NEEDS THE BOARD: ' + dailyOffCode : ''; }, // card 3c
  ranked() { return run ? (run.claimed ? run.ranked : null) : null },
  get state() { return app === 'game' ? sim.state : app; },
  get stage() { return sim ? sim.stage : 1; },
  get enemies() { return sim ? sim.enemies.length : 0; },
  fill() { if (sim) sim.fill(); },
  god(v) { godFlag = v !== false; if (sim) sim.setGod(godFlag); },
  dive(n) { if (sim) sim.dive(n); },
  comet() { if (sim) sim.comet(); },
  crt(v) { setCrt(v !== false); },
  skip() { if (app === 'cabinet') { setApp('title'); ui.menuPage = 'main'; } },
  // freeze the cabinet intro at a time (seconds after the coin); release() lets it run on
  introAt(sec) { if (app !== 'cabinet') { setApp('cabinet'); cab.reset(); } cab.hold(sec); },
  release() { cab.release(); },
  breakPanels(n) { if (sim) sim.breakPanels(n); },
  // C2-0: fxTest(type, ...args) hands one synthetic presentation event to the browser-side handler only
  // (the sim is not touched, so the run is not tainted). type 'popup': (kind, x, y, value, color);
  // 'fx': (kind, ...burst args); 'sfx': (name or id, arg). Returns false for an unknown type or sound.
  fxTest(type, ...a) {
    const t = type === 'popup' ? EV_POPUP : type === 'fx' ? EV_FX : type === 'sfx' ? EV_SFX : 0;
    if (!t) return false;
    if (t === EV_SFX) { // honest: true only when a sound really started (unknown id, silent id, locked or muted audio -> false)
      const id = typeof a[0] === 'string' ? (a[0] in SFX_ID ? SFX_ID[a[0]] : -1) : (Number.isInteger(a[0]) ? a[0] : -1);
      if (id < 0 || id >= SFX_NAMES.length) return false;
      if (id === SFX_ID.pop) lastKillTi = Number.isInteger(a[1]) ? a[1] : -1; // test hook: the second argument of 'pop' is the enemy type index
      return playSfx(id, +a[1] || 0);
    }
    fxEv.fill(0); fxEv[0] = t;
    for (let i = 0; i < a.length && i < fxEv.length - 1; i++) fxEv[i + 1] = +a[i] || 0;
    onEvent(fxEv, 0);
    return true;
  },
  // S13a: what the audio is doing: { track, bpm, drift (null until S10), muted, unlocked }; audioLast() = { sfx, kind, vol, count, pop, pops, jingles } (audio-bind.js last())
  audio() { return bind.state(); },
  audioLast() { return bind.last(); },
  entry() { return sim ? sim.entry() : []; },
  info() {
    if (!sim) return { state: app, stage: 1, score: 0, lives: 3, crt: ui.crtOn, menu: ui.menuSel, page: ui.menuPage, mode: selMode };
    let bullets = 0; for (const b of sim.eb) if (b.on) bullets++;
    return { state: this.state, stage: sim.stage, kind: sim.stageKind, enemies: sim.enemies.length, formFull: sim.formFull, wing: sim.wing.length,
      mult: sim.mult, score: sim.score, lives: sim.lives, deaths: sim.deaths, boss: sim.boss.on, fury: sim.boss.fury, meter: +sim.meter.toFixed(3),
      crt: ui.crtOn, bullets, frames: sim.frame, shots: sim.shotsFired, hits: sim.hits, tainted: sim.tainted, menu: ui.menuSel, page: ui.menuPage, mode: run ? run.mode : selMode };
  },
  // the current (or last finished) run as a replay string
  replay: replayString,
  hash() { return sim ? sim.stateHash() : null; },
  seed() { return sim ? sim.seed : null; },
  fps() {
    const n = Math.min(fpsN, 256), now = fpsT[(fpsN - 1) & 255];
    let c = 0; for (let i = 0; i < n; i++) if (now - fpsT[(fpsN - 1 - i) & 255] < 1000) c++;
    return c;
  },
  // simulate a lost GPU context, restored after ms
  loseContext(ms = 300) {
    const ext = gfx.gl.getExtension('WEBGL_lose_context');
    if (!ext) return false;
    ext.loseContext(); setTimeout(() => ext.restoreContext(), ms); return true;
  }
};

// registered hooks and info fields (hooks.js); app is what a hook may use
const hookApp = {
  get sim() { return sim; },
  // SF.mode(m): start a run in 'daily' or 'free'; no argument returns the current mode
  // card 3c: daily with the remote board on goes through chooseDaily and returns its promise
  setMode(m) { if (m === undefined) return run ? run.mode : selMode; if (m !== MODE_DAILY && m !== MODE_FREE) return null; if (m === MODE_DAILY) return chooseDaily(); startRun(1); return m; },
  // one sim frame with this input word, recorded in the replay exactly like a played frame
  // quiet: skip sound effects (for hooks that run many frames at once)
  stepSim(w, q) { if (!sim || sim.done || app !== 'game') return false; quiet = !!q; stepGame(w); quiet = false; afterStep(); checkHi(); if (sim.done) setApp('results'); else syncMusic(); return true; }
};
installHooks(window.SF, hookApp);
