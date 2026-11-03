// Retry queue for runs sent to the remote leaderboard.
// The game saves every finished ranked run on this device first (main.js), then adds the exact submit body here.
// The queue lives in localStorage, so a run that could not be sent (offline, server down, busy, rate limited, no
// answer) is sent again later: on load, after the next run, when the browser comes back online, and on a backoff timer.
//
// Stored value at QUEUE_KEY: { v: QUEUE_V, items: [{ id, body, tries, next, code, deadline? }] }, oldest first.
//   id    hashReplay(body.replay): one queue entry per run
//   body  the exact JSON body for POST /submit
//   tries sends started so far; next = earliest time (ms) to try again; code = the last retryable error code
//   deadline (Daily with a ticket only) the client time (ms) when the server's ticket window closes, less a margin.
//     A Daily's retries never skip over it: if the normal backoff would land past it, the try happens at the deadline,
//     so the last try lands inside the window. Free Play and old entries have none and keep the plain backoff.
//     if the try at the deadline fails, an extra try follows at deadline + DEADLINE_MARGIN_MS / 2 (15 s before the
//     client's estimate of the window end), so a server that comes back in that last stretch still gets the run. After
//     the extra try the plain backoff is back. No stored field: it is worked out from the time the failed try was SENT
//     and the time its answer came back (see afterFail), so a deadline try that hangs until the client gives up
//     (REMOTE_TIMEOUT_MS, 15 s) still gets its extra try.
//     Still lost: a server back after the extra try (about the last 14 s of the window); timers that fire late (a hidden
//     tab); and the extra try is inside the server's window only while the ticket's and the send's travel times
//     add up to less than 15 s (when they do not, that try gets ticket_stale, which the next try would have got anyway).
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
import { TICKET_GRACE_S, TICKET_SLACK_S, FPS } from '../../leaderboard/ticket-window.js'; // one source for the 600 and the 10 (the server reads the same file)

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

// the safety margin taken off the server's ticket window. The client times the window from the moment the ticket
// ARRIVED, which is after the server issued it (by the request's travel time, a few seconds at most, the client times
// out sooner), so the client's window ends LATER than the server's by that much; the margin (and the travel time of the
// last try itself) must cover it. Both ends are read on the client clock, so a client clock that is off the server's
// by a fixed amount does not matter, only drift over ten minutes does (milliseconds).
export const DEADLINE_MARGIN_MS = 30000;
// the one extra try after the deadline goes at deadline + half the margin. Half is safe while the ticket's travel time
// plus the extra try's own travel time stay under 15 s (normally a few seconds; the client gives up on a request after
// 15 s, so a slow ticket can use it all). Past that the extra try gets ticket_stale: no worse than not making it.
export const EXTRA_TRY_MS = DEADLINE_MARGIN_MS / 2;
// client time (ms) when a Daily whose ticket arrived at ticketAt (ms) and whose run lasted `frames` frames must have
// been tried for the last time: ticket + play time + grace + slack - margin. null when either input is not usable.
export function dailyDeadline(ticketAt, frames) {
  if (!Number.isFinite(ticketAt) || !Number.isFinite(frames) || frames < 0) return null;
  return ticketAt + (frames / FPS + TICKET_GRACE_S + TICKET_SLACK_S) * 1000 - DEADLINE_MARGIN_MS;
}
// when to try an entry again, `t` = now. Without a deadline: the plain backoff. With one still ahead: the plain backoff,
// but never later than the deadline. From the deadline on, until the extra try time (deadline + EXTRA_TRY_MS): the plain
// backoff, but never later than the extra try (once t has reached it this rule no longer applies; a short backoff
// can fit more than one try in those 15 s). After that: the plain backoff again (the next answer decides,
// ticket_stale included).
export function nextTry(t, tries, code, deadline) {
  const n = t + backoffMs(tries, code);
  if (!Number.isFinite(deadline)) return n;
  if (t < deadline) return n > deadline ? deadline : n;
  const extra = deadline + EXTRA_TRY_MS;
  return t < extra && n > extra ? extra : n;
}
// When to try again after a retryable answer to a try SENT at `sent` that came back at `t`.
// Normally nextTry(t, ...). But a try sent from the deadline on, before the extra try time, has earned the extra try
// whatever the answer was and however long it took: if the answer came back at or after the extra try time (the client
// timed out after REMOTE_TIMEOUT_MS = 15 s, or a slow refusal), the extra try is due at once, `t` (main.js waits at least
// 1 s). It is still made only once: that try is sent at or after the extra try time, so its own failure gets the plain
// backoff. If the answer comes back late (a request sent at deadline + 14 s that hangs 15 s returns at deadline + 29 s),
// the extra try may land after the server's window: it then gets ticket_stale and the entry is dropped, which is what the
// plain backoff would have led to as well. Tries sent before the deadline, Free Play and no-deadline entries: unchanged.
export function afterFail(sent, t, tries, code, deadline) {
  const n = nextTry(t, tries, code, deadline);
  if (!Number.isFinite(deadline) || !(sent >= deadline)) return n;
  const extra = deadline + EXTRA_TRY_MS;
  return sent < extra && t >= extra ? t : n;
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
    const item = { id, body: e.body, tries: Number.isInteger(e.tries) && e.tries >= 0 ? e.tries : 0,
      next: Number.isFinite(e.next) ? e.next : 0, code: typeof e.code === 'string' ? e.code : null };
    if (typeof e.deadline === 'number' && Number.isFinite(e.deadline)) item.deadline = e.deadline; // anything else is read as no deadline
    out.push(item);
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
    // an entry may be sent now (main.js flushes at once when the page is visible again: a hidden tab's timer may fire late)
    due() { return Q.nextDue() <= now(); },
    // add one run (the exact submit body); the same replay is never queued twice.
    // opts.ticketAt = the client time (ms) the Daily's ticket arrived, opts.frames = the run's frame count (default
    // body.stats.frames). A Daily with a ticket then gets a deadline (dailyDeadline); without ticketAt, or for Free Play, the entry has none.
    add(body, opts) {
      if (!validBody(body, version)) return Promise.resolve(false);
      const id = hashReplay(body.replay);
      const dl = body.mode === 'daily' && body.ticket && opts && opts.ticketAt !== undefined ? dailyDeadline(opts.ticketAt, opts.frames !== undefined ? opts.frames : body.stats && body.stats.frames) : null;
      return editLock(() => {
        const items = load();
        if (!items.some(e => e.id === id)) items.push({ id, body, tries: 0, next: 0, code: null, ...(dl !== null && { deadline: dl }) });
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
          let sent = 0; // the time this try was claimed and sent
          const head = await editLock(() => {
            const items = load(), t = now();
            const e = items.find(x => x.next <= t);
            if (!e) return null;
            sent = t;
            e.tries++; e.next = nextTry(t, e.tries, e.code, e.deadline); // a send that never ends still waits its turn
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
              if (e) { e.code = code; e.next = afterFail(sent, now(), e.tries, code, e.deadline); }
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
