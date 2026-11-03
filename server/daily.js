// the Daily's seed and run ticket, made by the server from a secret (Worker secret DAILY_SECRET).
//
// Why: the public seed (engine/rng.js dailySeed, the same formula in every browser) lets anyone compute tomorrow's
// level today and practise it. With a secret, nobody can know a day's seed before the server hands it out that day.
//
//   seed   = first 4 bytes (big-endian uint32) of HMAC-SHA256(DAILY_SECRET, 'daily:' + game + ':' + dayKey)
//   ticket = issuedAt (base 36) + '.' + base64url(HMAC-SHA256(DAILY_SECRET, 'ticket:' + game + '|' + dayKey + '|' +
//            issuedAt + '|' + playerId))
// The ticket carries its own issuedAt, so the client keeps one string and the server needs no table: changing the
// time, the day, the game or the player changes the MAC. The two messages start with different words ('daily:' and
// 'ticket:'), so a seed can never be read as a ticket or the other way round. Tickets are checked with
// crypto.subtle.verify (WebCrypto's own comparison, not a string compare that stops at the first wrong byte).
//
// WebCrypto only (globalThis.crypto.subtle), so the same code runs in the Worker and in Node.
// No secret set: dailySecretOf returns null and the server keeps the public seed and today's checks.
import { dailySeed } from '../engine/rng.js';
import { TICKET_SLACK_S, TICKET_GRACE_S, FPS } from '../leaderboard/ticket-window.js';

export const MIN_SECRET_LEN = 32; // `openssl rand -hex 32` gives 64 characters
// A run may claim at most this much more play time than real time has passed since its ticket (seconds). Covers the
// difference between two Worker copies' clocks; an honest run is always shorter than the time since the ticket,
// because the game asks for the ticket before the run starts and the sim runs at most 60 frames a second.
// TICKET_SLACK_S, TICKET_GRACE_S and FPS are defined in leaderboard/ticket-window.js (the game's send queue reads them
// too, and the site deploy ships leaderboard/ but not this file); re-exported here, same values.
export { TICKET_SLACK_S, TICKET_GRACE_S, FPS };
const TICKET_RE = /^([0-9a-z]{1,11})\.([A-Za-z0-9_-]{43})$/; // 32-byte MAC in base64url without padding is 43 chars

export class DailyConfigError extends Error {}

// The secret from the Worker env: null when not set (dev, tests), the string when long enough. A secret that is set
// but too short is a deploy mistake: refuse to run dailies on it rather than quietly go back to the public seed.
export function dailySecretOf(env) {
  const s = env ? env.DAILY_SECRET : undefined;
  if (s === undefined || s === null || s === '') return null;
  if (typeof s !== 'string' || s.length < MIN_SECRET_LEN) throw new DailyConfigError(`DAILY_SECRET must be at least ${MIN_SECRET_LEN} characters`);
  return s;
}

const enc = new TextEncoder();
function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const todayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
export const ticketMessage = (game, dayKey, issuedAt, playerId) => `ticket:${game}|${dayKey}|${issuedAt}|${playerId}`;

// One per Worker copy: the imported key and the seeds of the last few days, kept in memory.
export function createDailyKeys() {
  let keyFor = null, keyP = null; // the secret the cached key belongs to, and its CryptoKey promise
  const seeds = new Map();        // `${game}:${dayKey}` -> uint32, for keyFor only
  function key(secret) {
    if (secret !== keyFor) {
      keyFor = secret; seeds.clear();
      keyP = globalThis.crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    }
    return keyP;
  }
  async function mac(secret, msg) { return new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', await key(secret), enc.encode(msg))); }

  return {
    // the day's seed; secret null gives the public seed (the local daily's)
    async seed(secret, game, dayKey) {
      if (!secret) return dailySeed(dayKey);
      await key(secret);
      const k = `${game}:${dayKey}`;
      if (seeds.has(k)) return seeds.get(k);
      const m = await mac(secret, `daily:${game}:${dayKey}`);
      const v = ((m[0] << 24) | (m[1] << 16) | (m[2] << 8) | m[3]) >>> 0;
      if (seeds.size >= 8) seeds.clear(); // a few days at most are ever asked for (today, yesterday)
      seeds.set(k, v);
      return v;
    },
    async ticket(secret, game, dayKey, issuedAt, playerId) {
      return issuedAt.toString(36) + '.' + b64url(await mac(secret, ticketMessage(game, dayKey, issuedAt, playerId)));
    },
    // the ticket's issuedAt (ms) if the ticket is this server's for exactly this game, day and player, else null
    async check(secret, ticket, game, dayKey, playerId) {
      if (typeof ticket !== 'string' || ticket.length > 64) return null;
      const m = TICKET_RE.exec(ticket);
      if (!m) return null;
      const issuedAt = parseInt(m[1], 36);
      if (!Number.isSafeInteger(issuedAt) || issuedAt.toString(36) !== m[1]) return null; // one spelling per time
      let sig;
      try { sig = unb64url(m[2]); } catch { return null; }
      if (sig.length !== 32 || b64url(sig) !== m[2]) return null;
      const ok = await globalThis.crypto.subtle.verify('HMAC', await key(secret), sig, enc.encode(ticketMessage(game, dayKey, issuedAt, playerId)));
      return ok ? issuedAt : null;
    },
  };
}

// Frames a run may have if its ticket was issued at issuedAt and it is checked at t (both ms, server clock).
export const maxFramesSince = (issuedAt, t) => Math.floor(((t - issuedAt) / 1000 + TICKET_SLACK_S) * FPS);

// A ticket's maximum age. A ticketed Daily must arrive within its own play time (frames / 60 s) plus a
// grace plus TICKET_SLACK_S after its ticket was issued, or it is refused (ticket_stale). Before this a ticket was good
// for about 48 hours, time enough to work the seed out offline.
// Why 10 minutes of grace: the real time around a run that is not play time. The game asks for the ticket when the
// Daily starts (menu to first frame is seconds; STACKLIGHT asks again if its cached ticket is over a minute old),
// the pause screen stops the sim but not the clock, then the name entry after game over, then the send (the client's
// timeout and the submit queue's retries). The queue knows this window and spaces a Daily's retries so the last
// try lands 30 s before it closes (games/starfall/submit-queue.js); a page made visible again sends a due try at
// once. A Daily is lost only if the server stays unreachable until that last try, or the player keeps the tab hidden
// past the window; the queue then drops it with ticket_stale, it never loops. The brief caps the grace at 10 minutes. TICKET_SLACK_S (the
// existing allowance for two Worker copies' clocks, used the other way round by maxFramesSince) is added on top for
// the same reason: issuedAt and the check may come from two Worker copies.
// ON by default: server/worker.js LIMITS.ticketGraceS is TICKET_GRACE_S. A test can pass limits
// { ticketGraceS: null } to a Worker copy to switch it off.
// true when a run of `frames` frames on a ticket issued at issuedAt arrives too late at t (ms, server clock)
export const ticketStale = (issuedAt, frames, t, graceS = TICKET_GRACE_S) => t - issuedAt > (frames / FPS + graceS + TICKET_SLACK_S) * 1000;
// kv rows dailyrun:<day>:... are kept this long (a Daily is taken for today or yesterday only, so 3 days is plenty)
export const DAILY_KEEP_MS = 3 * 86400000;
