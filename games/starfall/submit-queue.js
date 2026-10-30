// Retry queue for runs sent to the remote leaderboard.
// The game saves every finished ranked run on this device first (main.js), then adds the exact submit body here.
// The queue lives in localStorage, so a run that could not be sent (offline, server down, busy, rate limited, no
// answer) is sent again later: on load, after the next run, when the browser comes back online, and on a backoff timer.
//
// Stored value at QUEUE_KEY: { v: QUEUE_V, items: [{ id, body, tries, next, code }] }, oldest first.
//   id    hashReplay(body.replay): one queue entry per run
//   body  the exact JSON body for POST /submit
//   tries sends started so far; next = earliest time (ms) to try again; code = the last retryable error code
// A value with another `v`, unreadable JSON, or an entry that is not a well-formed body for this game version is
// dropped on read (the run is still on the local board). At most QUEUE_CAP entries: past it the oldest goes.
//
// Exactly once: an entry is removed only after the server answered for it. If an answer is lost (tab closed, server
// killed after it stored the run) the entry is sent again and the server answers duplicate_replay (same replay string
// already stored), which counts as delivered. Two tabs: sends run under one Web Lock ('starfall-sendq-send') so only
// one tab sends at a time; queue edits run under a second, short lock. Without Web Locks the server dedupe above
// still makes a double send harmless.
// No DOM, no timers: main.js owns scheduling; storage, clock, locks and the remote client are injected (Node tests).
import { hashReplay, LeaderboardError } from '../../leaderboard/api.js';
import { isPlayerId } from '../../leaderboard/storage.js';

export const QUEUE_KEY = 'starfall.sendq';
export const QUEUE_V = 1;
export const QUEUE_CAP = 10;
export const BACKOFF_MS = 5000;      // first retry after 5 s, doubling
export const BACKOFF_MAX_MS = 300000; // never more than 5 minutes apart
export const RATE_WAIT_MS = 60000;    // rate_limited: wait at least a minute
// retryable: the run itself may be fine, the server or the network was not
export const RETRY_CODES = Object.freeze(['offline', 'timeout', 'server_error', 'busy', 'rate_limited']);
// every entry gets this many sends; a run that still fails after them leaves the queue (it stays on the local board)
export const MAX_TRIES = 20;
// answers that will never turn into a success for this exact run, even though the status looks like a server problem
const NEVER_CODES = Object.freeze(['verify_disagree']);
// 4xx answers worth another go: the request timed out or the server asked us to slow down
const RETRY_4XX = Object.freeze([408, 425, 429]);

export function isRetryable(err) {
  if (!err) return false;
  if (typeof err.code !== 'string') return true; // not a LeaderboardError (a bug or a network library error): try again later
  if (NEVER_CODES.indexOf(err.code) >= 0) return false;
  // a 4xx without a JSON body (a proxy's 413 page, say) reaches us as server_error with its status: sending the same
  // body again gets the same answer, so it is not retried
  if (err.code === 'server_error' && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) return RETRY_4XX.indexOf(err.status) >= 0;
  return RETRY_CODES.indexOf(err.code) >= 0 || (Number.isInteger(err.status) && err.status >= 500);
}
// the code shown in 'NOT SENT: <CODE>' for a refusal
export function dropCode(err) {
  if (err && err.code === 'server_error' && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) return 'http_' + err.status;
  return err && typeof err.code === 'string' ? err.code : 'server_error';
}
export const isWrongVersion = err => !!err && (err.code === 'wrong_version' || /^new version, reload/i.test(String(err.message || '')));

export function backoffMs(tries, code) {
  const d = Math.min(BACKOFF_MAX_MS, BACKOFF_MS * Math.pow(2, Math.max(0, tries - 1)));
  return code === 'rate_limited' ? Math.max(RATE_WAIT_MS, d) : d;
}

function validBody(b, version) {
  return !!b && typeof b === 'object' && typeof b.game === 'string' && isPlayerId(b.playerId) && typeof b.name === 'string' &&
    Number.isSafeInteger(b.score) && b.score > 0 && typeof b.replay === 'string' && b.replay.length > 0 &&
    typeof b.seed === 'number' && (b.mode === 'free' || (b.mode === 'daily' && typeof b.dayKey === 'string')) &&
    (b.ticket === undefined || (typeof b.ticket === 'string' && b.ticket.length > 0 && b.ticket.length <= 64)) && // kept as given
    String(b.version) === String(version);
}
function cleanItems(raw, version) {
  if (!raw || typeof raw !== 'object' || raw.v !== QUEUE_V || !Array.isArray(raw.items)) return null;
  const out = [], seen = new Set();
  for (const e of raw.items) {
    if (!e || typeof e !== 'object' || !validBody(e.body, version)) continue;
    const id = hashReplay(e.body.replay);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, body: e.body, tries: Number.isInteger(e.tries) && e.tries >= 0 ? e.tries : 0,
      next: Number.isFinite(e.next) ? e.next : 0, code: typeof e.code === 'string' ? e.code : null });
  }
  return out;
}

// What a queue event looks like on screen (main.js shows it; tests pin it). `left` = entries still waiting.
export function statusFor(ev, ratingText = () => '') {
  const n = ev.left | 0, runs = n === 1 ? '1 RUN' : n + ' RUNS';
  switch (ev.kind) {
    case 'sending': return 'SAVED HERE. SENDING...';
    case 'ok': { const r = ratingText(ev.res); return r ? 'ONLINE: ' + r : 'SAVED ONLINE'; }
    case 'held': return 'HELD FOR REVIEW';
    case 'dup': return 'ALREADY SAVED ONLINE';
    case 'version': return 'NEW VERSION, RELOAD';
    case 'retry': return (ev.code === 'offline' || ev.code === 'timeout' ? 'OFFLINE: ' : 'SERVER BUSY: ') + runs + ' SAVED HERE, WILL RETRY';
    case 'drop': return 'NOT SENT: ' + String(ev.code || 'refused').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ');
    case 'nosend': return 'NOT SENT: SAVED HERE ONLY';
    case 'waiting': return n ? runs + ' WAITING TO SEND' : '';
    default: return '';
  }
}

// remote: { submitScore(body) } (server/client.js). backend: a localStorage-like object (getItem/setItem/removeItem).
// onEvent({ kind, entry, res, err, code, left }) after each answer: kind ok | held | dup | version | retry | drop.
export function createSubmitQueue({ remote, backend, now = () => Date.now(), locks, version, onEvent = () => {} } = {}) {
  if (!remote || typeof remote.submitScore !== 'function') throw new TypeError('submit queue needs a remote leaderboard');
  if (version == null) throw new TypeError('submit queue needs the game version');
  const ls = () => { try { return backend !== undefined ? backend : globalThis.localStorage || null; } catch (e) { return null; } };
  let mem = null;        // used when storage refuses (private window): the queue lasts this page only
  let degraded = false;
  let lastRead = { corrupt: false, dropped: 0 };
  let flushing = null;
  const chains = new Map(); // in-page stand-in for Web Locks: one chain per lock name (the send lock takes the edit lock inside)
  const lock = (name, fn) => {
    try {
      const L = locks !== undefined ? locks : globalThis.navigator && globalThis.navigator.locks;
      if (L && typeof L.request === 'function') return L.request(name, () => fn());
    } catch (e) { /* fall through to the in-page queue */ }
    const prev = chains.get(name) || Promise.resolve();
    const run = prev.then(fn, fn);
    chains.set(name, run.catch(() => {}));
    return run;
  };
  const editLock = fn => lock('starfall-sendq-edit', fn);

  function load() {
    let raw = null, text = null;
    if (mem) return mem.map(e => ({ ...e }));
    try { const s = ls(); text = s ? s.getItem(QUEUE_KEY) : null; } catch (e) { text = null; }
    if (text == null) { lastRead = { corrupt: false, dropped: 0 }; return []; }
    try { raw = JSON.parse(text); } catch (e) { raw = undefined; }
    const items = cleanItems(raw, version);
    if (items === null) { lastRead = { corrupt: true, dropped: Array.isArray(raw && raw.items) ? raw.items.length : 0 }; return []; }
    lastRead = { corrupt: false, dropped: raw.items.length - items.length };
    return items;
  }
  function save(items) {
    while (items.length > QUEUE_CAP) items.shift(); // past the cap the oldest goes (it is still on the local board)
    if (!mem) {
      for (;;) {
        try {
          const s = ls();
          if (!s) throw new Error('no localStorage');
          if (items.length) s.setItem(QUEUE_KEY, JSON.stringify({ v: QUEUE_V, items }));
          else s.removeItem(QUEUE_KEY);
          return items;
        } catch (e) {
          // full storage: drop the oldest and try again; storage refused outright: keep the queue in memory
          if (items.length > 1) { items.shift(); continue; }
          break;
        }
      }
      degraded = true;
    }
    mem = items.map(e => ({ ...e }));
    return items;
  }

  const Q = {
    get degraded() { return degraded; },
    get lastRead() { return lastRead; },
    items: () => load(),
    get length() { return load().length; },
    // earliest time a waiting entry may be sent (Infinity when the queue is empty)
    nextDue() { let t = Infinity; for (const e of load()) if (e.next < t) t = e.next; return t; },
    // add one run (the exact submit body); the same replay is never queued twice
    add(body) {
      if (!validBody(body, version)) return Promise.resolve(false);
      const id = hashReplay(body.replay);
      return editLock(() => {
        const items = load();
        if (!items.some(e => e.id === id)) items.push({ id, body, tries: 0, next: 0, code: null });
        save(items);
        return true;
      });
    },
    // the browser is back online: everything waiting may go now
    wake() { return editLock(() => { const items = load(); for (const e of items) e.next = 0; save(items); }); },
    // send every entry that is due, oldest first; stops at the first retryable failure. One flush at a time per page,
    // one sender at a time across tabs.
    flush() {
      if (flushing) return flushing;
      flushing = lock('starfall-sendq-send', async () => {
        const done = [];
        for (let guard = 0; guard <= QUEUE_CAP; guard++) {
          const head = await editLock(() => {
            const items = load(), t = now();
            const e = items.find(x => x.next <= t);
            if (!e) return null;
            e.tries++; e.next = t + backoffMs(e.tries, e.code); // a send that never ends still waits its turn
            save(items);
            return { ...e };
          });
          if (!head) break;
          let res = null, err = null;
          try { res = await remote.submitScore(head.body); } catch (e) { err = e || new Error('submit failed'); }
          let kind;
          if (!err) kind = res && res.held ? 'held' : 'ok';
          else if (isWrongVersion(err)) kind = 'version';
          else if (err.code === 'duplicate_replay') kind = 'dup';
          else if (isRetryable(err)) kind = head.tries >= MAX_TRIES ? 'drop' : 'retry'; // no retry forever
          else kind = 'drop';
          const code = err ? dropCode(err) : res && res.held ? 'held_for_review' : null;
          const left = await editLock(() => {
            let items = load();
            if (kind === 'retry') {
              const e = items.find(x => x.id === head.id);
              if (e) { e.code = code; e.next = now() + backoffMs(e.tries, code); }
            } else if (kind === 'version') {
              items = items.filter(x => x.id !== head.id && String(x.body.version) !== String(head.body.version));
            } else items = items.filter(x => x.id !== head.id);
            save(items);
            return items.length;
          });
          const ev = { kind, entry: head, res, err, code, left };
          done.push(ev);
          try { onEvent(ev); } catch (e) { /* a display bug must not stop the queue */ }
          if (kind === 'retry') break;
        }
        return done;
      }).finally(() => { flushing = null; });
      return flushing;
    }
  };
  return Q;
}

// board reads from the remote server. After a failed read every read fails at once (code 'offline',
// no request) until READ_RETRY_MS has passed, so a down server costs at most one request per 10 s from the table,
// the rank line and attract mode together. `requests` counts the reads that really went out (tests).
export const READ_RETRY_MS = 10000;
export function gateReads(remote, { now = () => Date.now(), wait = READ_RETRY_MS } = {}) {
  let failAt = -Infinity;
  const G = { ...remote, requests: 0, get waiting() { return now() - failAt < wait; } };
  // reads go one at a time, so two reads started together (table and rank at load) cost one request when the server is down
  let chain = Promise.resolve();
  const gate = name => (...a) => {
    const run = chain.then(async () => {
      if (now() - failAt < wait) throw new LeaderboardError('offline', 'board read waits 10 s after a failure');
      G.requests++;
      try { return await remote[name](...a); } catch (e) { failAt = now(); throw e; }
    });
    chain = run.catch(() => {});
    return run;
  };
  G.reset = () => { failAt = -Infinity; }; // a submit just got an answer: the server is back
  G.getBoard = gate('getBoard'); G.getRank = gate('getRank'); G.getReplay = gate('getReplay');
  if (typeof remote.getDaily === 'function') G.getDaily = gate('getDaily'); // the Daily's seed and ticket, same gate
  return G;
}
