// Leaderboard server: one Cloudflare Worker over a D1 database (binding name DB). JSON in, JSON out.
//   POST /submit        a finished run; the server re-simulates the replay and stores ITS score
//   GET  /board         ?game=&board=all|daily|season&key=&limit=&offset=&version=   (unique= is accepted and ignored:
//                       a board holds one row per player, their best run on it)
//   GET  /rank          ?game=&playerId=&version=
//   GET  /replay/:id    a stored run, 404 if gone
//   GET  /daily         ?game=  header x-player-id: <playerId>. Today's (UTC, server clock) Daily: { dayKey, seed, ticket,
//                       issuedAt, dailySecret } (server/daily.js). Any game in server/games.js (starfall,
//                       stacklight); each game has its own seed for a day (the HMAC message names the game)
//   POST /admin/release a held near-copy onto the board: { id }, header authorization: Bearer <ADMIN_TOKEN>
//   POST /admin/hide    take an entry off every board: { entryId }, same header
// Errors are { ok: false, error: <code>, message }. Success is { ok: true, ... }.
// Field rules: leaderboard/api.js validateSubmission plus the server's own (3-letter names, no score 0). Boards,
// players and trophies (the best-5 trophy rule in leaderboard/ranking.js) are SQL rows: server/boards.js. Boards are kept per
// major game version; version= defaults to the major version of that game this Worker was deployed with
// (server/games.js; Starfall's for a game not in the registry).
// Optional env (wrangler.toml [vars], none are secrets): ALLOWED_ORIGIN (CORS, default '*').
// Optional secret (npx wrangler secret put ADMIN_TOKEN, never in the repo): ADMIN_TOKEN, at least 24 characters.
// Without it /admin/release answers 404, as if it did not exist.
// Secret for production (npx wrangler secret put DAILY_SECRET, at least 32 characters): DAILY_SECRET. With it
// the Daily's seed comes from the secret (nobody can compute a day's seed before /daily hands it out), a daily submit
// needs the ticket /daily gave, may hold no more play than real time since that ticket, and only today's or yesterday's
// daily is taken (UTC). Without it (dev, tests) the Daily keeps the public seed and today's checks.
import { validateSubmission, hashReplay, LeaderboardError, MAX_REPLAY_CHARS } from '../leaderboard/api.js';
import { seasonFor, SEASON_EPOCH_MS } from '../leaderboard/ranking.js';
import { claimResult, releaseResult, findNearRun, hitRate, sweepRate, getHeld, markReleased, countHeld,
  claimDaily, dropDaily, sweepDaily, noteHeldFrom, expireHeld, holdRunCapped } from './d1-adapter.js';
import { isSeen, storeRun, readBoard, readRank, readReplay, hideEntry, majorOf, boardsFor, BOARD_CAP } from './boards.js';
import { cleanName } from './names.js';
import { makeServerVerifier } from './verify.js';
import { GAME_VERSION } from '../games/starfall/sim.js';
import { gameOf, GAME_IDS } from './games.js';
import { createDailyKeys, dailySecretOf, todayKey, DAILY_KEEP_MS, ticketStale, TICKET_GRACE_S } from './daily.js';

// Limits and why:
// - bodyBytes: the replay cap (MAX_REPLAY_CHARS, 864,064 chars: 60 minutes of the densest touch input, see
//   leaderboard/api.js) plus 16 KiB for the other fields (stats is at most 2,000 chars, the rest is under 1 KB).
//   Anything bigger is refused while reading, before any parsing.
// - The fastest possible game over is about 3,200 frames (53 s, measured with no input), so one player can
//   finish at most about 11 runs in 10 minutes. pidPerWindow 12 per 10 minutes never blocks real play.
// - ipPerWindow 30 per 10 minutes: a few players behind one home or school address still fit; a script that
//   rotates playerIds is held to 30 re-sims per 10 minutes per address (about 30 s of CPU at worst).
// - heldCap 500: at most this many near-copies wait for review at once (each keeps its replay, typically about
//   15 KB, 864 KB at the very most, so under 450 MB even then). Past it a near-copy is refused (near_duplicate, 409).
// - boardMaxAge 10 s: a board read may be served from a cache for up to 10 s. A new score shows within
//   10 s, which nobody notices, and a burst of reads (the attract mode after a version bump, a busy launch evening)
//   costs one database read per board per 10 s per edge location instead of one per request.
// - dailyPerWindow 60 per 10 minutes per address: GET /daily is asked once per DAILY FLIGHT start, and up to
//   twice per STACKLIGHT start (on highlight, and again at the start if that answer is over a minute old) (a run
//   takes at least 53 s, so a real player asks at most about 22 times in 10 minutes). It cannot be cached (each answer
//   is signed for one player), so a storm of it is held to 60 HMACs and 60 rate-counter writes per address.
//   With one ranked Daily per player per day and one run per ticket, more tickets do not buy a player more ranked
//   Dailies; this limit still bounds what a playerId-rotating script gets per address, so it stays.
// - heldPerPlayer 3, heldPerAddress 3: near copies waiting for review per playerId and per address
//   (IPv6: its /64). An honest player is held rarely (the bot-measured gap is honest at most 0.32, copies at least 0.97),
//   so 3 waiting at once is already unusual; past it a near copy is refused (held_limit, 409) and not stored. One
//   address can no longer fill the 500-slot queue: it takes 167 addresses.
// - heldMaxAgeDays 14: a held run still waiting after 14 days is deleted (the sweep, once per rate window per
//   Worker copy). Two weekly looks at the queue. Trade: a held run the owner has not looked at in 14 days is gone for
//   good from the server (the player still has it on their device's local board); without it the queue only grows.
// - ticketGraceS: seconds a Daily ticket stays good past its run's play time (server/daily.js
//   TICKET_GRACE_S = 600 is the chosen value and why). The rule is ON: LIMITS.ticketGraceS is TICKET_GRACE_S.
//   A test may pass limits { ticketGraceS: null } to switch it off for one Worker copy; null means no age rule.
export const LIMITS = Object.freeze({ bodyBytes: MAX_REPLAY_CHARS + 16384, windowMs: 600000, ipPerWindow: 30, pidPerWindow: 12, heldCap: 500,
  boardMaxAge: 10, replayMaxAge: 300, dailyPerWindow: 60, heldPerPlayer: 3, heldPerAddress: 3, heldMaxAgeDays: 14, ticketGraceS: TICKET_GRACE_S });
export const BOARD_WINDOW = 100; // rows per cached board window (see board below)

// the edge cache key of one board window, the one place it is built. board() reads through it and
// purge() deletes it, so the two can never drift apart. Built only from the normalised query (see board).
export function windowKey(origin, game, ver, board, from) {
  return `${origin}/board?game=${encodeURIComponent(game)}&version=${encodeURIComponent(ver)}&board=${encodeURIComponent(board)}&from=${from}`;
}
// the edge cache key of one stored run (GET /replay/:id), from the checked id only.
export function replayKey(origin, id) { return `${origin}/replay/${id}`; }
// Cloudflare's edge cache, or null where there is none (Node, the dev server).
function edgeCache() {
  try { return globalThis.caches?.default ?? null; } catch { return null; }
}
export const SERVER_VERSION = majorOf(GAME_VERSION); // the board a run goes on, and the default board to read

const STATUS = {
  bad_json: 400, bad_input: 400, bad_game: 400, bad_player: 400, bad_name: 400, bad_score: 400, missing_replay: 400,
  bad_seed: 422, bad_mode: 422, bad_version: 400, bad_stats: 400, bad_board: 400, bad_day: 422, score_zero: 422,
  replay_too_large: 413, body_too_large: 413,
  bad_replay: 422, wrong_version: 422, replay_too_long: 422, frames_after_end: 422, run_not_finished: 422,
  score_mismatch: 422, replay_mismatch: 422, replay_error: 422,
  duplicate_replay: 409, duplicate_result: 409, near_duplicate: 409,
  rate_limited: 429, busy: 503, verify_disagree: 500, bad_ticket: 422,
  ticket_used: 409, daily_done: 409, ticket_stale: 422, held_limit: 409,
  not_found: 404, method_not_allowed: 405, unauthorized: 401, already_released: 409,
};

class HttpError extends Error {
  constructor(code, message, headers) { super(message); this.code = code; this.headers = headers; }
}

const json = (status, body, cors, extra) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors, ...extra } });

// Read at most `cap` bytes; stop reading (and cancel the stream) as soon as the body passes it.
async function readCapped(request, cap) {
  const len = request.headers.get('content-length');
  if (len !== null && !(Number(len) <= cap)) throw new HttpError('body_too_large', `body over ${cap} bytes`);
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { try { await reader.cancel(); } catch { /* ignore */ } throw new HttpError('body_too_large', `body over ${cap} bytes`); }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.byteLength; }
  return new TextDecoder('utf-8', { fatal: false }).decode(all);
}

// Rate-limit key for an address. IPv6: the /64, because one home or phone line gets a whole /64 and can rotate
// through it freely. IPv4: the address. Anything unparsable is used as given (it only ever comes from Cloudflare).
export function ipKey(ip) {
  const s = String(ip || 'unknown').toLowerCase();
  if (!s.includes(':')) return s;
  if (s.includes('.')) return s.slice(s.lastIndexOf(':') + 1); // IPv4-mapped (::ffff:1.2.3.4): the IPv4 address
  const [head, tail = ''] = s.split('::');
  const hs = head ? head.split(':') : [];
  const ts = tail ? tail.split(':') : [];
  if (s.includes('::')) { while (hs.length + ts.length < 8) hs.push('0'); }
  const groups = [...hs, ...ts].slice(0, 4);
  if (groups.length < 4 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return s;
  return groups.map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

const WHOLE = /^\d{1,6}$/;
const DAY_MS = 86400000;
const GAME_RE = /^[a-z0-9_-]{1,32}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION_RE = /^\d{1,4}(\.\d{1,4})?$/;
const realDay = (k) => typeof k === 'string' && DAY_RE.test(k) && !Number.isNaN(Date.parse(`${k}T00:00:00Z`)) && new Date(`${k}T00:00:00Z`).toISOString().slice(0, 10) === k;
// Reads name a game in the registry (server/games.js) and a major version it can have boards for:
// 1 up to the game's current major plus one (the next major's boards may be read for the few minutes a deploy takes,
// README step 6b; older majors stay readable, README "Trophies and boards are per major game version"). Anything else
// is refused before any read, so made-up games and versions cannot mint new cache keys or D1 reads.
function readGame(q) {
  const game = q.get('game');
  if (game === null || !GAME_RE.test(game)) throw new LeaderboardError('bad_game', 'game required');
  const g = gameOf(game);
  if (!g) throw new LeaderboardError('bad_game', `this server has boards for ${GAME_IDS.join(' and ')} only`);
  return g;
}
function versionOf(q, g) {
  const v = q.get('version');
  if (v === null) return majorOf(g.version);
  if (!VERSION_RE.test(v)) throw new LeaderboardError('bad_board', 'version must look like 2 or 2.5');
  const n = Number(majorOf(v)), top = Number(majorOf(g.version)) + 1;
  if (!(n >= 1 && n <= top)) throw new LeaderboardError('bad_version', `${g.id} has boards for major versions 1 to ${top} only`);
  return String(n);
}
function entryTag(t, rhash) {
  let r;
  try { r = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 8); } catch { r = Math.floor(Math.random() * 2 ** 32).toString(16).padStart(8, '0'); }
  return `${Math.max(0, Math.floor(t)).toString(36).padStart(10, '0')}-${r}-${rhash}`;
}

// Compares two strings in time that depends only on their lengths (for the admin token).
function sameText(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < y.length; i++) d |= (x[i % (x.length || 1)] ?? 0) ^ y[i];
  return d === 0;
}
const REPLAY_ID = /^[a-z0-9-]{1,128}$/;

export function createWorker({ now = () => Date.now(), limits = LIMITS, maxFrames } = {}) {
  const L = { ...LIMITS, ...limits };
  const verifyRun = makeServerVerifier({ now, maxFrames });
  const dailyKeys = createDailyKeys();
  let sweptWin = -1; // the rate window this Worker copy last swept: sweep once per window, not on every request
  async function sweep(db, t) {
    const win = Math.floor(t / L.windowMs);
    if (win !== sweptWin) {
      sweptWin = win;
      await sweepRate(db, { windowMs: L.windowMs, t });
      await sweepDaily(db, { day: todayKey(t - DAILY_KEEP_MS) });
      await expireHeld(db, { before: t - L.heldMaxAgeDays * 86400000 });
    }
  }

  async function rateCheck(db, key, limit) {
    const r = await hitRate(db, key, { limit, windowMs: L.windowMs, t: now() });
    if (!r.ok) throw new HttpError('rate_limited', 'too many submits, slow down', { 'retry-after': String(r.retryAfter) });
  }

  async function submit(request, env) {
    const db = env.DB;
    await sweep(db, now());
    const ip = request.headers.get('cf-connecting-ip') || 'unknown'; // set by Cloudflare's edge; a client cannot forge it there
    const ipk = ipKey(ip);
    await rateCheck(db, `ip:${ipk}`, L.ipPerWindow);
    const text = await readCapped(request, L.bodyBytes);
    let input;
    try { input = JSON.parse(text); } catch { throw new HttpError('bad_json', 'body must be JSON'); }
    const c = validateSubmission(input);
    const name = cleanName(input.name);
    if (!name) throw new LeaderboardError('bad_name', 'name must be exactly 3 letters A-Z (and not a blocked word)');
    if (c.score === 0) throw new LeaderboardError('score_zero', 'a run that scores 0 is not stored');
    await rateCheck(db, `pid:${c.pid}`, L.pidPerWindow);

    // Same replay string as a stored run: refuse before spending CPU on it (the store's batch refuses it again atomically).
    const rhash = hashReplay(c.replay);
    if (await isSeen(db, c.game, rhash)) throw new LeaderboardError('duplicate_replay', 'this replay was already submitted');

    // with DAILY_SECRET a daily needs this server's ticket for its game, day and player
    let daily, dailyKey = null;
    const secret = dailySecretOf(env);
    if (secret && c.mode === 'daily' && typeof c.dayKey === 'string') {
      const issuedAt = await dailyKeys.check(secret, input.ticket, c.game, c.dayKey, c.pid);
      if (issuedAt === null) throw new LeaderboardError('bad_ticket', 'a daily run needs the ticket the server gave for that day (GET /daily)');
      if (todayKey(issuedAt) !== c.dayKey || issuedAt > now() + 60000) throw new LeaderboardError('bad_ticket', 'the ticket does not belong to that day');
      // One accepted run per ticket, one ranked Daily per player per day, claimed after the re-sim
      // below (claimDaily, one atomic write). Not read before it: the run's own errors (bad_seed, bad_day, ...) come
      // first, as before, and a refused second run costs one re-sim, which the per-player and per-address limits bound.
      dailyKey = { game: c.game, day: c.dayKey, pid: c.pid, ticket: input.ticket, rhash };
      daily = { seed: await dailyKeys.seed(secret, c.game, c.dayKey), issuedAt };
    }
    const v = verifyRun(c, daily);
    if (v.score !== c.score) throw new LeaderboardError('score_mismatch', `replay scores ${v.score}, claimed ${c.score}`);
    // A ticket runs out its run's play time plus ticketGraceS after it was issued (server/daily.js).
    // On by default (LIMITS.ticketGraceS = TICKET_GRACE_S); skipped only when a Worker copy is given null.
    // Checked after the re-sim, from the server's own frame count. Starfall and STACKLIGHT Dailies both pass through it.
    if (daily && L.ticketGraceS != null && ticketStale(daily.issuedAt, v.frames, now(), L.ticketGraceS)) {
      throw new LeaderboardError('ticket_stale', 'this daily arrived too long after its ticket; the ticket ran out');
    }
    let dailyFresh = false;
    if (dailyKey) {
      const got = await claimDaily(db, { ...dailyKey, t: now() });
      if (!got.ok) throw dailyRefusal(got.code);
      dailyFresh = got.fresh;
    }
    try {
      return await place(db, request, c, v, name, ipk);
    } catch (e) {
      // not stored and not held: give the Daily claim back (the player's one ranked Daily is not used up).
      // Place can also throw AFTER its write committed (an answer lost on the way back, a read
      // after the store's batch). So the claim goes back only when the run is seen to be neither on the boards nor
      // held for this player; if that check fails too, the claim stays (a lost Daily beats a second ranked one).
      // Never on duplicate_result. It means this exact result is already claimed, so the
      // run exists, stored or in flight (the same Daily sent twice at once: the resend can win the result claim and
      // not have committed yet when this submit checks, so a check here would see nothing and hand the claim back).
      if (dailyFresh && e?.code !== 'duplicate_result') {
        try {
          if (!(await landed(db, c, v, rhash))) await dropDaily(db, dailyKey);
        } catch { /* the claim stays; the player keeps daily_done */ }
      }
      throw e;
    }
  }
  // did this checked Daily get stored (its replay is in seen) or held for this player?
  async function landed(db, c, v, rhash) {
    if (await isSeen(db, c.game, rhash)) return true;
    const held = await getHeld(db, { game: c.game, board: `daily:${c.dayKey}`, hash: v.hash, score: v.score });
    return !!held && held.pid === String(c.pid);
  }
  function dailyRefusal(code) {
    return code === 'ticket_used'
      ? new LeaderboardError('ticket_used', 'this daily ticket was already used for a run; one run per ticket')
      : new LeaderboardError('daily_done', 'you already have a ranked daily for this day; one per player per day');
  }

  // The checked run onto the boards (201), held for review (202), or refused as a copy.
  async function place(db, request, c, v, name, ipk) {
    const dayKey = c.mode === 'daily' ? c.dayKey : undefined;
    const claim = { game: c.game, board: dayKey ? `daily:${dayKey}` : 'free', hash: v.hash, score: v.score };
    // Duplicate checks without a lock: the exact result first (one atomic claim), then near copies of EARLIER claims
    // only (server/d1-adapter.js findNearRun), so two copies sent at the same moment cannot both get on the board.
    // A near copy is not thrown away: the bot-measured gap (honest at most 0.32, copies at least 0.97) may not hold
    // for real players, so the run is held for review (never on a board, no trophies) and can be released later.
    const run = { game: c.game, playerId: c.pid, name, score: v.score, replay: c.replay, seed: c.seed, mode: c.mode,
      ...(dayKey && { dayKey }), version: c.version, stats: { hash: v.hash, frames: v.frames, stage: v.stage } }; // the server's numbers
    const t = now();
    if (!(await claimResult(db, { ...claim, sig: v.sig, t }))) {
      throw new LeaderboardError('duplicate_result', 'a run with this exact result is already on the board');
    }
    let near;
    try { near = await findNearRun(db, { ...claim, sig: v.sig, t }); } catch (e) { await releaseResult(db, claim); throw e; }
    if (near) {
      await releaseResult(db, claim);
      const pct = Math.round(near.similarity * 100);
      let id;
      const had = await getHeld(db, claim);
      if (had) { // the same run sent again is answered as held, whatever the caps
        id = had.id;
        await noteHeldFrom(db, { id, ip: ipk });
      } else {
        // The caps are checked inside the one atomic write that holds the run (holdRunCapped),
        // so copies sent at the same moment cannot all slip under them.
        const got = await holdRunCapped(db, { ...claim, t, near, sig: v.sig, run, ip: ipk,
          caps: { total: L.heldCap, pid: L.heldPerPlayer, ip: L.heldPerAddress } });
        if (!got) { // nothing written; which cap was full only picks the message
          if ((await countHeld(db)) >= L.heldCap) {
            throw new LeaderboardError('near_duplicate', `this run is a copy of one already on the board (${pct}% the same)`);
          }
          throw new LeaderboardError('held_limit', `this run is ${pct}% the same as a run already on the board, and too many of your runs already wait for review`);
        }
        id = got.id;
      }
      return { status: 202, body: { ok: true, held: true, code: 'held_for_review', heldId: id, score: v.score,
        message: `your run (${v.score} points) is held for review before it goes on the board: it is ${pct}% the same as a run already there` } };
    }
    const res = await store(db, claim, run, new URL(request.url).origin);
    return { status: 201, body: { ok: true, score: v.score, verified: { frames: v.frames, stage: v.stage, hash: v.hash }, ...res } };
  }

  // Put a checked run on the boards (claim already taken; the batch marks it finished); on any failure give it back.
  // Stored, the edge cache windows of every board it went on are purged before the answer goes back.
  async function store(db, claim, run, origin) {
    const t = now();
    const rhash = hashReplay(run.replay);
    const season = seasonFor(t).id;
    let res;
    try {
      res = await storeRun(db, { run: { ...run, pid: run.playerId }, t, season, entry: entryTag(t, rhash), rhash, claim });
    } catch (e) {
      try { await releaseResult(db, claim); } catch { /* the claim goes stale and can be retaken */ }
      throw e;
    }
    await purge(origin, run.game, majorOf(run.version), boardsFor({ season, dayKey: run.dayKey }).map(([, b]) => b));
    return res;
  }

  // delete every cached window (ranks 1-100 up to BOARD_CAP) of these boards from this data
  // centre's edge cache. All windows, not just the new row's: a new row moves every row under it down a rank, and a
  // player's row that moves up leaves a gap further down. Awaited (no waitUntil) so the player's next read cannot
  // beat it. No edge cache (Node, the dev server): nothing to do. A failed delete is not an error: the run is stored
  // and that window runs out in boardMaxAge seconds anyway.
  async function purge(origin, game, ver, boards) {
    const cache = edgeCache();
    if (!cache || typeof cache.delete !== 'function') return;
    const keys = [];
    for (const b of boards) for (let from = 0; from < BOARD_CAP; from += BOARD_WINDOW) keys.push(windowKey(origin, game, ver, b, from));
    await Promise.all(keys.map(async (k) => { try { await cache.delete(new Request(k)); } catch { /* runs out by itself */ } }));
  }
  async function purgeKey(k) {
    const cache = edgeCache();
    if (!cache || typeof cache.delete !== 'function') return;
    try { await cache.delete(new Request(k)); } catch { /* runs out by itself */ }
  }

  // the owner's release of a held near-copy: the run goes on the boards as if accepted now (trophies count from now).
  async function release(request, env) {
    const db = env.DB;
    const input = await adminInput(request, env);
    const id = input?.id;
    if (!Number.isSafeInteger(id) || id < 1) throw new HttpError('bad_input', 'id must be a held run id (a whole number)');
    const row = await getHeld(db, { id });
    if (!row) throw new HttpError('not_found', 'no held run with that id');
    if (row.status !== 'flagged') throw new HttpError('already_released', `held run ${id} was already released`);
    const run = JSON.parse(row.run);
    const claim = { game: row.game, board: row.board, hash: row.hash, score: row.score };
    if (!(await claimResult(db, { ...claim, sig: row.sig == null ? null : JSON.parse(row.sig), t: now() }))) {
      throw new LeaderboardError('duplicate_result', 'a run with this exact result is already on the board');
    }
    const res = await store(db, claim, run, new URL(request.url).origin);
    await markReleased(db, { id, entry: res.id });
    return { status: 201, body: { ok: true, released: id, score: run.score, ...res } };
  }

  // The admin routes: off (404) without an ADMIN_TOKEN of 24+ chars, rate limited per address, then the token.
  async function adminInput(request, env) {
    const token = typeof env.ADMIN_TOKEN === 'string' ? env.ADMIN_TOKEN : '';
    if (token.length < 24) throw new HttpError('not_found', 'no such route');
    await rateCheck(env.DB, `admin:${ipKey(request.headers.get('cf-connecting-ip'))}`, L.ipPerWindow);
    if (!sameText(request.headers.get('authorization') || '', `Bearer ${token}`)) throw new HttpError('unauthorized', 'wrong or missing admin token');
    try { return JSON.parse(await readCapped(request, 1024)); } catch { throw new HttpError('bad_json', 'body must be JSON'); }
  }

  // take an entry (an offensive name, say) off every board, and out of the player's best 5 and
  // the percentile field. The player can still play and submit new runs; the same replay or result again is
  // refused as a duplicate.
  async function hide(request, env) {
    const input = await adminInput(request, env);
    const entry = input?.entryId;
    if (typeof entry !== 'string' || !REPLAY_ID.test(entry)) throw new HttpError('bad_input', 'entryId must be a board entry id');
    // the boards the entry is on, read before it goes, so their cached windows can be purged after
    const { results: on } = await env.DB.prepare('SELECT DISTINCT game, ver, board FROM board WHERE entry = ?').bind(entry).all();
    const { rows, runs } = await hideEntry(env.DB, { entry, t: now() });
    if (!rows && !runs) throw new HttpError('not_found', 'no board or best-5 list has that entry');
    const origin = new URL(request.url).origin;
    for (const r of on) await purge(origin, r.game, r.ver, [r.board]);
    await purgeKey(replayKey(origin, entry)); // the run's cached /replay too
    return { status: 200, body: { ok: true, hidden: entry, rows, runs } };
  }

  // GET /board query to { game, ver, b, limit, offset }. Only these params count; any other is ignored (and is not
  // part of the cache key). limit is cut to 100 and to the rows left before BOARD_CAP; neither may be negative or over
  // 6 digits (a bad one is refused before any read).
  function boardQuery(url) {
    const q = url.searchParams;
    const num = (name, dflt) => {
      const s = q.get(name);
      if (s === null) return dflt;
      if (!WHOLE.test(s)) throw new LeaderboardError('bad_board', `${name} must be a whole number`);
      return Number(s);
    };
    const g = readGame(q), game = g.id;
    const kind = q.get('board') ?? 'all', key = q.get('key');
    let b;
    if (kind === 'all') b = 'all';
    else if (kind === 'season') {
      if (key !== null && !/^-?\d{1,6}$/.test(key)) throw new LeaderboardError('bad_board', 'season key must be an integer season id');
      // Launch season (0) up to next season; a clock before launch also allows last season
      const cur = seasonFor(now()).id, id = key === null ? cur : Number(key), lo = Math.min(0, cur - 1);
      if (id < lo || id > cur + 1) throw new LeaderboardError('bad_board', `season key must be a season from ${lo} to ${cur + 1}`);
      b = `season:${id}`;
    } else if (kind === 'daily') {
      const today = now(), day = key ?? new Date(today).toISOString().slice(0, 10);
      if (!realDay(day)) throw new LeaderboardError('bad_board', 'daily key must be a real date, YYYY-MM-DD');
      // Launch day (or yesterday, on a clock before launch) up to tomorrow (UTC)
      const ms = Date.parse(`${day}T00:00:00Z`), lo = Math.min(SEASON_EPOCH_MS, Date.parse(todayKey(today - DAY_MS) + 'T00:00:00Z'));
      if (ms < lo || ms > Date.parse(todayKey(today + DAY_MS) + 'T00:00:00Z')) {
        throw new LeaderboardError('bad_board', `daily key must be a day from ${todayKey(lo)} to ${todayKey(today + DAY_MS)}`);
      }
      b = `daily:${day}`;
    } else throw new LeaderboardError('bad_board', "board must be 'all', 'daily' or 'season'");
    const offset = num('offset', 0);
    const limit = Math.max(0, Math.min(100, num('limit', 10), BOARD_CAP - offset)); // nothing is kept past BOARD_CAP
    return { game, ver: versionOf(q, g), b, limit, offset };
  }

  // a board is read, and cached, in fixed windows of BOARD_WINDOW rows (ranks 1-100, 101-200, ...).
  // The cache key is built only from the normalised query (game, major version, resolved board, window start), so
  // extra or reordered params, a different limit or offset, or the default season or day spelled out all hit the
  // same few entries: at most BOARD_CAP / BOARD_WINDOW = 10 per board. A cache miss reads one window (at most 100
  // rows, plus the rows skipped before it); a request spans at most 2 windows.
  async function board(url, env, ctx, cors) {
    const { game, ver, b, limit, offset } = boardQuery(url);
    const rows = [];
    if (limit > 0) {
      const first = Math.floor(offset / BOARD_WINDOW), last = Math.floor((offset + limit - 1) / BOARD_WINDOW);
      for (let w = first; w <= last; w++) {
        const from = w * BOARD_WINDOW;
        const key = windowKey(url.origin, game, ver, b, from);
        const res = await cachedGet(key, ctx, async () => json(200, { ok: true, rows: await readBoard(env.DB, { game, ver, board: b, limit: BOARD_WINDOW, offset: from }) },
          cors, { 'cache-control': `public, max-age=${L.boardMaxAge}` }));
        rows.push(...(await res.json()).rows);
      }
    }
    const start = Math.floor(offset / BOARD_WINDOW) * BOARD_WINDOW;
    return { status: 200, body: { ok: true, rows: rows.slice(offset - start, offset - start + limit) }, headers: { 'cache-control': `public, max-age=${L.boardMaxAge}` } };
  }

  async function rank(url, env) {
    const q = url.searchParams;
    const g = readGame(q), pid = q.get('playerId');
    if (pid === null || !/^[A-Za-z0-9_-]{8,64}$/.test(pid)) throw new LeaderboardError('bad_player', 'playerId required');
    const season = seasonFor(now());
    const r = await readRank(env.DB, { game: g.id, ver: versionOf(q, g), pid, season: season.id });
    return { status: 200, body: { ok: true, ...r, season } };
  }

  // today's Daily for this game. With DAILY_SECRET: the secret seed and a ticket for this player. Without:
  // the public seed (what every browser computes) and ticket null, so a dev server behaves as before.
  async function daily(request, url, env) {
    const db = env.DB;
    const secret = dailySecretOf(env); // a too-short secret throws: no dailies at all rather than the public seed
    const game = url.searchParams.get('game');
    if (!gameOf(game)) throw new LeaderboardError('bad_game', `this server has a daily for ${GAME_IDS.join(' and ')} only`);
    const pid = request.headers.get('x-player-id');
    const pidOk = pid !== null && /^[A-Za-z0-9_-]{8,64}$/.test(pid);
    if (secret && !pidOk) throw new LeaderboardError('bad_player', 'header x-player-id required (the ticket is for one player)');
    await sweep(db, now());
    await rateCheck(db, `daily:${ipKey(request.headers.get('cf-connecting-ip'))}`, L.dailyPerWindow);
    const issuedAt = now();
    const dayKey = todayKey(issuedAt);
    const seed = await dailyKeys.seed(secret, game, dayKey);
    const ticket = secret ? await dailyKeys.ticket(secret, game, dayKey, issuedAt, pid) : null;
    return { status: 200, body: { ok: true, game, dayKey, seed, ticket, issuedAt, dailySecret: !!secret } };
  }

  // Through the edge cache like a board window, so repeat reads of one run (up to 864 KB from D1 each)
  // are served at the edge for replayMaxAge seconds. The key is built from the checked id only (replayKey). A missing
  // run is a 404 and is never cached. POST /admin/hide deletes the key, so a hidden run goes at once in that data centre.
  async function replay(url, id, env, ctx, cors) {
    if (!REPLAY_ID.test(id)) throw new HttpError('not_found', 'no such replay');
    const res = await cachedGet(replayKey(url.origin, id), ctx, async () => {
      const r = await readReplay(env.DB, id);
      if (!r) throw new HttpError('not_found', 'no such replay');
      return json(200, { ok: true, ...r }, cors, { 'cache-control': `public, max-age=${L.replayMaxAge}` });
    });
    return { status: 200, body: await res.json(), headers: { 'cache-control': `public, max-age=${L.replayMaxAge}` } };
  }

  // board windows through the edge cache (Cloudflare's caches.default) when there is one; Node has none.
  // `key` is the normalised URL (see board), never the request's own URL. Only a 200 is stored.
  async function cachedGet(key, ctx, make) {
    const cache = edgeCache();
    if (!cache) return make();
    const req = new Request(key);
    try { const hit = await cache.match(req); if (hit) return hit; } catch { /* a cache miss */ }
    const res = await make();
    if (res.status === 200) {
      try { const p = cache.put(req, res.clone()); if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p); else await p; } catch { /* serve it anyway */ }
    }
    return res;
  }

  let warnedOrigin = false;
  async function fetch(request, env, ctx) {
    // No ALLOWED_ORIGIN still works (CORS '*', the dev server and tests) but says so once per Worker copy
    if (!env?.ALLOWED_ORIGIN && !warnedOrigin) {
      warnedOrigin = true;
      console.warn("leaderboard server: ALLOWED_ORIGIN is not set, so CORS allows any origin ('*'). Set it in wrangler.toml [vars] for production (your site's origin).");
    }
    const cors = { 'access-control-allow-origin': env?.ALLOWED_ORIGIN || '*', 'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, x-player-id', 'access-control-max-age': '86400', vary: 'origin' };
    try {
      if (!env || !env.DB) throw new Error('DB binding missing');
      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, '') || '/';
      const m = request.method;
      if (m === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      let out;
      if (path === '/submit') { if (m !== 'POST') throw new HttpError('method_not_allowed', 'use POST'); out = await submit(request, env); }
      else if (path === '/board') {
        if (m !== 'GET') throw new HttpError('method_not_allowed', 'use GET');
        out = await board(url, env, ctx, cors);
      }
      else if (path === '/daily') { if (m !== 'GET') throw new HttpError('method_not_allowed', 'use GET'); out = await daily(request, url, env); }
      else if (path === '/rank') { if (m !== 'GET') throw new HttpError('method_not_allowed', 'use GET'); out = await rank(url, env); }
      else if (path === '/admin/release') { if (m !== 'POST') throw new HttpError('method_not_allowed', 'use POST'); out = await release(request, env); }
      else if (path === '/admin/hide') { if (m !== 'POST') throw new HttpError('method_not_allowed', 'use POST'); out = await hide(request, env); }
      else if (path.startsWith('/replay/')) { if (m !== 'GET') throw new HttpError('method_not_allowed', 'use GET'); out = await replay(url, path.slice(8), env, ctx, cors); }
      else throw new HttpError('not_found', 'no such route');
      return json(out.status, out.body, cors, out.headers);
    } catch (e) {
      return fail(e, cors);
    }
  }

  function fail(e, cors) {
    const code = typeof e?.code === 'string' && STATUS[e.code] ? e.code : null;
    if (!code) { console.error('leaderboard server error:', e); }
    if (!code) return json(500, { ok: false, error: 'server_error', message: 'something went wrong on the server' }, cors);
    return json(STATUS[code], { ok: false, error: code, message: String(e.message).slice(0, 300) }, cors, e.headers);
  }

  return { fetch };
}

export default createWorker();
