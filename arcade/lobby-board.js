// The lobby's wall leaderboard (w31): the selected game's ALL-TIME top 10 and the player's own line.
// Data comes from the same board Starfall's table reads: the remote board when one is configured (or the test-only
// ?lb= localhost override), else this device's local board. One refresh per lobby visit, never per frame: the draw
// code only reads the strings built here when an answer arrives.
// No DOM here, so node tests can drive it with a memory leaderboard.
import { createLeaderboard } from '../leaderboard/api.js';
import { localStorageAdapter, isPlayerId } from '../leaderboard/storage.js';
import { pickLeaderboard, REMOTE_LEADERBOARD_URL } from '../server/client.js';
import { gateReads } from '../games/starfall/submit-queue.js';
import { FONT } from '../engine/font.js';

export const BOARD_ROWS = 10;      // the classic arcade high-score table length
export const RANK_WINDOW = 100;    // rows read in one request (one server window); a rank past it reads "100+"
export const NAME_MAX = 5;         // longer names are clipped so a 7-digit score still fits the panel

export const fmtScore = n => (Number.isFinite(n) ? String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '0');
const cleanName = s => {
  let o = '';
  const u = String(s == null ? '' : s).toUpperCase();
  for (let i = 0; i < u.length && o.length < NAME_MAX; i++) o += FONT[u[i]] || u[i] === ' ' ? u[i] : '?';
  return o.trim() || '?';
};

// lb: anything with getBoard / getRank (local createLeaderboard, or a gated remote client).
// playerId(): resolves to this device's player id, or null when it has none yet (never creates one).
export function createLobbyBoard({ lb, game = 'starfall', playerId = async () => null }) {
  const rows = [];
  for (let i = 0; i < BOARD_ROWS; i++) rows.push({ rank: String(i + 1), name: '', score: '', me: false });
  let pending = null;
  // state: 'idle' | 'loading' | 'ok' | 'offline'. you: 'none' (no run yet) | 'ranked' | 'unknown' (rank read failed)
  const B = {
    state: 'idle', n: 0, rows, you: 'none', youScore: '', youRank: '', reads: 0, rankReads: 0,
    refresh() {
      if (pending) return pending;
      if (B.state !== 'ok') B.state = 'loading';
      B.reads++;
      pending = (async () => {
        let list;
        try { list = await lb.getBoard({ game, board: 'all', limit: RANK_WINDOW }); } catch (e) { B.state = 'offline'; B.n = 0; return; }
        list = Array.isArray(list) ? list : [];
        let best = 0, you = 'none';
        try {
          const pid = await playerId();
          if (isPlayerId(pid)) { B.rankReads++; const r = await lb.getRank({ game, playerId: pid }); best = r && Number.isFinite(r.best) ? Math.max(0, Math.floor(r.best)) : 0; }
        } catch (e) { you = 'unknown'; }
        B.n = Math.min(BOARD_ROWS, list.length);
        let meAt = -1;
        if (best > 0) {
          let above = 0;
          for (const x of list) if (+x.score > best) above++;
          const past = list.length >= RANK_WINDOW && best < +list[list.length - 1].score;
          B.youRank = past ? RANK_WINDOW + '+' : String(above + 1);
          B.youScore = fmtScore(best); you = 'ranked';
          for (let i = 0; i < B.n; i++) if (+list[i].score === best) { meAt = i; break; }
        }
        for (let i = 0; i < BOARD_ROWS; i++) {
          const x = list[i], r = rows[i];
          r.rank = String(i + 1); r.name = x ? cleanName(x.name) : ''; r.score = x ? fmtScore(+x.score) : ''; r.me = i === meAt;
        }
        B.you = you; B.state = 'ok';
      })().finally(() => { pending = null; });
      return pending;
    },
    // plain copy for the test hook
    snapshot() {
      return { state: B.state, n: B.n, rows: rows.slice(0, B.n).map(r => ({ rank: r.rank, name: r.name, score: r.score, me: r.me })),
        you: B.you, youScore: B.youScore, youRank: B.youRank, reads: B.reads, rankReads: B.rankReads };
    }
  };
  return B;
}

// The board the lobby reads in the browser: the same choice Starfall's main.js makes (remote when configured or the
// test-only ?lb= localhost override, else the local board), with the same 10 s read gate after a failure (LOW11).
export function browserBoard(search) {
  const store = localStorageAdapter('arcade:');
  const local = createLeaderboard({ storage: store });
  let url = '';
  try { const v = new URLSearchParams(search).get('lb'); url = v && /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/?$/.test(v) ? v : ''; } catch (e) { url = ''; }
  let picked = local;
  try { picked = pickLeaderboard(local, url || REMOTE_LEADERBOARD_URL); } catch (e) { picked = local; }
  const lb = picked !== local ? gateReads(picked) : local;
  return createLobbyBoard({ lb, playerId: () => store.get('playerId').catch(() => null) });
}
