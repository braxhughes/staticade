// Optional remote leaderboard for the browser: the same methods as createLeaderboard (leaderboard/api.js),
// but each call goes to the leaderboard server (server/worker.js). OFF by default.
//
// The switch is one config value, REMOTE_LEADERBOARD_URL below. While it is '' the game keeps its local
// leaderboard exactly as today. pickLeaderboard(local) returns the local one unless the URL is set.
// games/starfall/main.js wires pickLeaderboard (card 3b): submits always go to the local board first, then to this
// client through a retry queue (games/starfall/submit-queue.js).
// Every failure is a LeaderboardError with a code; errors from an HTTP answer also carry its `status` (so a 5xx is
// known to be worth retrying). A call that has no answer after `timeoutMs` fails with code 'timeout'.
import { LeaderboardError } from '../leaderboard/api.js';
import { listLeagues, seasonFor } from '../leaderboard/ranking.js';

export const REMOTE_LEADERBOARD_URL = ''; // e.g. 'https://arcade-lb.<your-subdomain>.workers.dev'

export function pickLeaderboard(local, url = REMOTE_LEADERBOARD_URL, opts) {
  return url ? createRemoteLeaderboard({ url, ...opts }) : local;
}

export const REMOTE_TIMEOUT_MS = 15000;

export function createRemoteLeaderboard({ url, fetch: fetchFn = (...a) => globalThis.fetch(...a), now = () => Date.now(), timeoutMs = REMOTE_TIMEOUT_MS } = {}) {
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new TypeError('remote leaderboard needs an http(s) url');
  const base = url.replace(/\/+$/, '');
  const fail = (code, msg, status) => { const e = new LeaderboardError(code, msg); if (status) e.status = status; return e; };

  async function call(path, init) {
    let res, body, timer, timedOut = false;
    let ac = null;
    try { ac = new AbortController(); } catch { /* old browser: the timer below still ends the wait */ }
    // a fetch that never answers (a stalled connection) must not hold the queue or leave the board on LOADING
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(fail('timeout', `leaderboard server did not answer in ${timeoutMs} ms`));
        try { ac?.abort(); } catch { /* ignore */ }
      }, timeoutMs);
    });
    timeout.catch(() => {});
    try {
      try { res = await Promise.race([fetchFn(base + path, ac ? { ...init, signal: ac.signal } : init), timeout]); } catch (e) {
        if (e instanceof LeaderboardError) throw e;
        if (timedOut) throw fail('timeout', `leaderboard server did not answer in ${timeoutMs} ms`);
        throw fail('offline', `leaderboard server unreachable: ${e?.message ?? e}`);
      }
      try { body = await Promise.race([res.json(), timeout]); } catch (e) {
        if (e instanceof LeaderboardError) throw e;
        if (timedOut) throw fail('timeout', `leaderboard server did not answer in ${timeoutMs} ms`);
        throw fail('server_error', `leaderboard server sent ${res.status} without JSON`, res.status);
      }
    } finally { clearTimeout(timer); }
    if (!res.ok || !body || body.ok !== true) {
      if (res.status === 404 && path.startsWith('/replay/')) return null;
      throw fail(body?.error || 'server_error', body?.message || `leaderboard server sent ${res.status}`, res.status);
    }
    const { ok, ...rest } = body; // eslint-disable-line no-unused-vars
    return rest;
  }
  const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');

  return {
    remote: true,
    submitScore: (run) => call('/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(run) }),
    // fresh: true is the read right after the player's own submit. The server answers /board with max-age=10, so the
    // browser may hold the pre-submit board; this read skips the browser cache (cache: 'no-store') and carries a one-off
    // `_` param so no proxy in between can match it either. The Worker ignores `_`. Ordinary reads stay cacheable.
    getBoard: async ({ game, board = 'all', key, limit = 10, offset = 0, unique = true, fresh = false } = {}) =>
      (await (fresh ? call(`/board?${qs({ game, board, key, limit, offset, unique, _: now() })}`, { cache: 'no-store' })
        : call(`/board?${qs({ game, board, key, limit, offset, unique })}`))).rows,
    getRank: ({ game, playerId } = {}) => call(`/rank?${qs({ game, playerId })}`),
    // card 3c: today's Daily from the server ({ dayKey, seed, ticket, issuedAt, dailySecret }). The playerId goes in a
    // header, not the URL (the ticket is signed for it), so it never lands in a log or a referrer.
    getDaily: ({ game, playerId } = {}) => call(`/daily?${qs({ game })}`, playerId ? { headers: { 'x-player-id': String(playerId) } } : undefined),
    getReplay: (id) => (typeof id === 'string' && id ? call(`/replay/${encodeURIComponent(id)}`) : Promise.resolve(null)),
    getSeason: async (at = now()) => seasonFor(at instanceof Date ? at.getTime() : at),
    listLeagues: async () => listLeagues(),
  };
}
