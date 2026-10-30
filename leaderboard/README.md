# Leaderboard

**What this is:** a plain JavaScript module that keeps scores, boards, trophies, leagues and seasons. It stores data in the browser today and can swap to a real server later without changing the game code.

## Files

| File | Job |
|---|---|
| `api.js` | `createLeaderboard(...)`: the async methods games call |
| `ranking.js` | Pure math: trophies, leagues, seasons (formulas are in its header comment) |
| `storage.js` | `memoryAdapter()`, `localStorageAdapter(prefix)`, board trimming |

## Use it

```js
import { createLeaderboard } from './leaderboard/api.js';
import { localStorageAdapter } from './leaderboard/storage.js';

const lb = createLeaderboard({
  storage: localStorageAdapter('arcade:'),
  now: () => Date.now(),        // inject a fake clock in tests
  verifyReplay: undefined,      // optional async ({game, replay, seed, mode, dayKey, version, score}) => score | {score}
});
```

## Methods

| Method | Returns |
|---|---|
| `submitScore({ game, playerId, name, score, replay, seed, mode, dayKey?, version, stats? })` | `{ id, placements: {all, daily?, season}, trophyDelta, trophies, league: {name, tier, label}, rating: {avg5, top5, enteredTop5, percentile}, promoted?, demoted?, from? }` |
| `getBoard({ game, board, key?, limit=10, offset=0, unique=true })` | `[{ rank, name, score, date, mode, id }]` |
| `getRank({ game, playerId })` | `{ trophies, league, tier, season: {id,start,end}, best, seasonBest, avg5, top5, percentile, players, carry }` |
| `getReplay(id)` | stored run (`replay` string, seed, version, stats) or `null` |
| `getSeason(now?)` | `{ id, start, end }` (ms) |
| `listLeagues()` | league names with trophy ranges and sub-tiers |

Rules in short:
- `playerId` (8 to 64 chars of `A-Za-z0-9_-`) identifies a player. `name` is only a display label. In the browser, get a stable id with `getLocalPlayerId(storage)` (from `storage.js`).
- Trophies follow the rule in "Trophies" below. An identical replay string is rejected (`duplicate_replay`).
- Limits: score is a safe integer, replay at most 864,064 chars (`MAX_REPLAY_CHARS`: 60 minutes of the densest touch input), name is ASCII with a letter or digit. A `dayKey` must be a real date, and without `verifyReplay` within 1 day of today (UTC).
- If localStorage refuses writes, the adapter sets `degraded = true` and submit results carry `storageDegraded: true`.
- Concurrency: adapters may offer `withLock(name, fn)`. A submit runs entirely under one lock (memory adapters share it per adapter object; localStorage uses `navigator.locks` when the browser has it, so tabs serialise). If any write fails, the submit rolls back every key it touched.
- Boards grow with every unique player (the cap keeps the top 100 plus each player's best), so storage grows with player count. Accepted. `getBoard` clamps `limit` to 100.
- Known limits (accepted): without `verifyReplay` the score is the client's claim. Without `navigator.locks` or an adapter `withLock`, locking is per instance only, so tabs are best effort. Duplicate-replay marks are kept forever (small).
- `mode` is `'daily'` or `'free'`. `dayKey` is `YYYY-MM-DD` (UTC), defaulting to today. Only daily runs enter the daily board.
- Names are uppercased, then must be 1 to 10 of `A-Z 0-9 space . -`. Score must be a whole number, 0 or more. Replay string is required.
- Bad input throws `LeaderboardError` with a `code` (`bad_name`, `bad_score`, `missing_replay`, `replay_mismatch`, ...).
- Boards show each player's best run. Pass `unique: false` for every run. Ties: earlier submission ranks higher.
- `board: 'season'` uses `key` = season id (default: current). `board: 'daily'` uses `key` = dayKey (default: today).
- Each board keeps the top 100 plus every player's best run.
- Storage corruption never throws: unreadable boards read as empty, bad rows are dropped.

## Trophies

**What this is:** how your league and tier are worked out, the same on this device and on the server.

1. **Your rating is the average of your best 5 runs this season.** Fewer than 5 runs: the missing ones count as 0, so one lucky run is not a full rating.
2. **Your trophies come from where that average sits among everyone rated this season** (your percentile). Beat 75% of players and you are about Platinum.
3. **A run that is not one of your best 5 changes nothing.** A run that is can only raise your average, so playing never costs you trophies. Other players passing you can move you down.
4. **20 imaginary players** (half above you, half below) are always added, so the first player of a season is Gold III, not Legend. With 1,000 players they barely matter.
5. **Players whose average is 0 do not count** in anyone's field, so a pile of empty runs cannot lift anyone.
   A player whose own average is 0 (on the server: runs of 1 to 4 points only) is still rated, against everyone else plus the 20 imaginary players. The 10 imaginary players below them always count, so in a small season a run of 1 point still earns trophies: alone, 750 (Gold III); with 5 real players above, 570 (Silver II). Only in a big season does it fall toward 0% and Bronze. That is by design: a new player is never shown 0 in an empty season.
6. **A new season keeps half.** You start a season at half of what you ended the last one with (a quarter after two seasons away). Your new rating replaces it once it is higher.
7. Seasons are 28 days, counted from launch day, 2026-10-30 (UTC).
8. **On the server, trophies are kept per major game version.** A major version bump (2.x to 3.0) starts everyone's trophies, best 5 and boards again from zero there, because runs on the new version are a different game. Minor bumps (2.4 to 2.5) keep everything. On this device trophies are not split by version. More in `server/README.md`, "Known limits".

| Percentile | Trophies | League |
|---|---|---|
| 0 | 0 | Bronze |
| 25% | 300 | Silver |
| 50% | 750 | Gold |
| 70% | 1,200 | Platinum |
| 85% | 1,800 | Diamond |
| 95% | 2,400 | Master |
| 99% | 3,400 | Legend |

Between two rows the trophies go up in a straight line. Bronze to Diamond each have three tiers: III (low), II, I (high). Example: you are alone in the season, so you sit at 50%: 750, Gold III. The formulas and more worked examples are in the header of `ranking.js`.

On this device "everyone" means the players who played in this browser. On the server it means everyone online.

## Backend endpoints

**What a server would do:** run `ranking.js` and the validation in `api.js` itself (never trust a client's trophy math), and re-run the replay. Then the browser only calls these. The server authenticates `playerId` (for example from a login session) and never accepts one from the request body as proof of identity.

| Method and path | Replaces | Body or query | Response |
|---|---|---|---|
| `POST /v1/scores` | `submitScore` | JSON body of the run | submitScore result, 201. 422 on bad input or replay mismatch |
| `GET /v1/games/:game/boards/:board` | `getBoard` | `?key=&limit=&offset=&unique=` | array of entries |
| `GET /v1/games/:game/players/:playerId/rank` | `getRank` | none | rank object |
| `GET /v1/replays/:id` | `getReplay` | none | stored run, 404 if gone |
| `GET /v1/season` | `getSeason` | `?at=<ms>` | `{ id, start, end }` |
| `GET /v1/leagues` | `listLeagues` | none | league list |

To swap: write `createLeaderboard`'s HTTP twin that calls these, or implement `get/set/remove/keys` against a key-value route if you only want remote storage.
