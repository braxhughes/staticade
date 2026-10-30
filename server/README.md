# Leaderboard server

**What this is:** one small web service that keeps Starfall's online high scores and refuses cheated ones, because it replays every run itself and keeps only the score the replay really earns.

It is code only. Nothing is deployed and no account exists yet. The game still uses its local leaderboard until you flip one switch (step 7 below).

**Production must set the secret `DAILY_SECRET`** (Go live, step 5b). Without it the Daily's seed is the public one, and anyone can work out tomorrow's level today and practise it. See "The Daily's seed and ticket".

## How a score gets in

| Step | Check | Refused with |
|---|---|---|
| 1 | Same address (IPv6: same /64 block) sent more than 30 submits in 10 minutes | `rate_limited` (429) |
| 2 | Body over 880,448 bytes: the replay cap plus 16 KB for the other fields (stops reading at the cap) | `body_too_large` (413) |
| 3 | Not JSON, or a bad field (playerId, score, replay over 864,064 chars...). Name not exactly 3 letters A-Z, or on the blocklist (`names.js`) | `bad_json`, `bad_name`, `bad_player`, ... (400) |
| 3b | Score 0 (nothing to rank, and a pile of them would pad the field) | `score_zero` (422) |
| 4 | Same playerId sent more than 12 submits in 10 minutes | `rate_limited` (429) |
| 5 | The exact replay string is already stored | `duplicate_replay` (409) |
| 5b | Only with `DAILY_SECRET` set, daily runs only: no ticket, or not this server's ticket for this game, day and player, or a run with more frames than real time since the ticket allows (frames / 60 > seconds since the ticket + 10) | `bad_ticket` (422) |
| 6 | Replay header: not today's game version (message starts "new version, reload"), wrong mode or seed, daily run outside its window. With `DAILY_SECRET`: the seed must be the server's seed for that day, and the day must be today or yesterday (UTC). Without it: the public seed, today plus or minus 1 day | `wrong_version`, `bad_mode`, `bad_seed`, `bad_day` (422) |
| 7 | Replay longer than 216,000 frames (60 minutes) | `replay_too_long` (422) |
| 8 | Re-simulate on the real game sim: broken replay, frames after game over, run not finished | `bad_replay`, `frames_after_end`, `run_not_finished` (422) |
| 9 | The re-simulated score is not the claimed score | `score_mismatch` (422) |
| 10 | A run with the same final sim state and score is already on that board (one run with edited "ignored" frames) | `duplicate_result` (409) |
| 10b | The run is a near copy of one already on that board: 60% or more of its first 128 scoring moments (same points, within 4 frames) match (an edited copy, see below) | Not refused: **held for review** (202 `held_for_review`), see "Near-copy check". `near_duplicate` (409) only when 500 runs already wait |
| 11 | Store it with the server's score and stats: one `db.batch` of single atomic SQL statements (`server/boards.js`), no lock. Trophies use the same rule as the browser (`leaderboard/ranking.js`) | |

Why those numbers: the fastest possible game over is about 53 seconds, so a real player can finish about 11 runs in 10 minutes (limit 12). 30 per address leaves room for a few players on one home or school network.

## Copies

**What this is:** how the server stops one run from filling the board, or someone else's run being sent under a new name.

The first review showed that the exact check (step 10) alone was not enough. Flipping one fire bit on one frame keeps the score but changes the final sim state, so 5 copies of one run got in. Now the server also keeps each run's first 128 scoring moments (frame and points) and compares a new run with the stored runs near its score (up to 50 each side, between half and double the score).

Measured with `node server/dedupe-measure.mjs` (2 minutes, Node):

| Runs compared | How alike (share of scoring moments that match) |
|---|---|
| Honest runs on the same seed: 400 runs, 15,800 pairs (one pair even has the same score) | at most 0.32; none at 0.6 or more |
| One-bit edits like the reviewer's (all 19 frames that keep the score and change the state) | all held, none on the board (test `MED1: the reviewer's one-bit copies...`) |
| Copies with 1, 5 or 40 random bit flips that still end cleanly (3 victims, 600 tries each) | at least 0.96: all held |
| The same flips "repaired" (cut or pad the ending so the run is finished; scripted victims of 34k to 64k points) | 7 to 191 of 200 get under 0.6. Those changed early and play out differently; against these weak scripted victims some even score more, because they are new runs, not copies |
| Repaired copies of strong runs (state-reading bot, 230k to 330k points; 360 tries) | the ones that get in score at most 45% of the run they copied |

**What is left:** a cheater can still edit someone's replay until it plays out differently in the opening. What gets in is then a different run, and against a strong run a much weaker one: the same as any tool-assisted run (table at the end). Runs with fewer than 16 scoring moments are too short to compare and only get the exact check; they score too little to matter.

**Replays stay public** (`GET /replay/<id>`). The game's attract mode plays the top runs from the board, so hiding them would break a feature, and a downloaded replay is now no use for copying (steps 5, 10, 10b in the first table).

## Near-copy check

**What this is:** the server compares each new run with stored runs near its score, and holds a run for review (instead of putting it on the board) when it looks like an edited copy of one.

| Thing | Value |
|---|---|
| What is compared | The first 128 scoring moments (frame, points) of the server's own re-sim. Two moments match if the points are equal and the frames are at most 4 apart (`TOL`) |
| Threshold | 60% or more matching (`NEAR = 0.6`, `server/dedupe.js`) |
| Measured on bots | Honest runs: at most **0.317** alike (400 runs, 15,800 pairs). Edited copies: at least **0.968** |
| Measured on real players | **Unknown until launch.** People may play more alike than bots |
| What a held run gets | Stored in table `flagged` with the id and similarity of the run it matched. On no board, no trophies. The player gets 202 `{ ok: true, held: true, code: "held_for_review", heldId, message }` |
| Still refused outright | Exact copies: same replay (`duplicate_replay`), same final state and score (`duplicate_result`) |
| Pinned by tests | `tests/server-dedupe.test.js`: a pair 30-40% alike both go on the board; a copy 65-75% alike is held; moments 4 frames apart match, 5 apart do not |

**Check flagged runs: every few days for the first weeks after launch** (from the `server` folder):

```
npx wrangler d1 execute arcade-lb --remote --command "SELECT id, datetime(t/1000,'unixepoch') AS held_at, name, pid, score, near_entry, near_score, round(similarity,2) AS alike FROM flagged WHERE status = 'flagged' ORDER BY t DESC LIMIT 50"
```

Look at `alike`. Close to 1.0 is a copy: leave it. Between 0.6 and 0.8 might be a real player: watch both replays (`near_entry` is the id of the matched run, `GET /replay/<id>`). If honest runs land here often, raise `NEAR`.

**Release one onto the board** (it counts as accepted at the moment you release it, trophies included):

1. Once: `npx wrangler secret put ADMIN_TOKEN` and paste a long random string (for example the output of `openssl rand -hex 24`). It lives only in Cloudflare, never in the repo. Without it the release route answers 404.
2. `curl -s -X POST https://arcade-lb.<you>.workers.dev/admin/release -H "authorization: Bearer <token>" -H 'content-type: application/json' -d '{"id": 7}'`
3. It answers 201 with the new board entry. A second release of the same id answers 409 `already_released`.

Released runs stay in `flagged` with `status = 'released'` (the record of what you let in). At most 500 runs wait at once (`LIMITS.heldCap`, about 100 MB at worst); past that a near copy is refused with `near_duplicate`.

## The Daily's seed and ticket (card 3c)

**What this is:** how the server makes the Daily's level something nobody can know before the day starts, and ties each daily run to a time.

| Thing | How |
|---|---|
| Seed | First 4 bytes (a whole number up to 4,294,967,295) of HMAC-SHA256(`DAILY_SECRET`, `daily:<game>:<YYYY-MM-DD>`). HMAC is a keyed hash: without the secret nobody can compute it, not even for tomorrow |
| Where the game gets it | `GET /daily?game=starfall` with header `x-player-id`, when the player picks DAILY FLIGHT. The game never uses the public seed for an online daily: if `/daily` does not answer it shows "DAILY NEEDS THE BOARD: OFFLINE" and offers free play |
| Ticket | `<issuedAt in base 36>.<HMAC of game, day, issuedAt and playerId>`. The server keeps no table: it checks the MAC again (with WebCrypto's own compare, `crypto.subtle.verify`). Another day, player, game or time breaks it |
| Real time | A daily may hold at most (seconds since its ticket + 10) x 60 frames. The 10 s covers two Worker copies whose clocks differ a little. An honest run always fits: the game asks for the ticket before the run starts and plays 60 frames a second |
| Day window | Today or yesterday (UTC, server clock), never tomorrow. A run started at 23:59 and sent at 00:01 still counts for its day |
| Rate limit | 60 `/daily` calls per address per 10 minutes (a real player starts at most about 11 dailies in that time). Each answer is signed for one player, so it cannot be cached |
| No secret (dev, tests) | `/daily` answers the public seed, `ticket: null`, `dailySecret: false`, and daily runs are checked exactly as before card 3c (public seed, plus or minus 1 day, no ticket) |
| Secret set but under 32 characters | A deploy mistake: `/daily` and every submit answer 500 `server_error` (the Worker log says why), rather than quietly falling back to the public seed |

**What a ticket does not prove (the honest limit).** A ticket proves a run is no older than its ticket, not that it was played live. A player can fetch the day's seed, practise it all day (fetching a new ticket for each try), and send only their best run. The first-daily-counts rule is still kept in the browser (see "What is still trusted to the client"). What the secret does stop: knowing or practising a day's level before that day starts, and sending a daily that would take longer to play than the time since its ticket.

## Boards as rows (w22)

**What this is:** how scores are stored since card 3a, and why it stays cheap as the game grows.

| Thing | Value |
|---|---|
| One row per | player per board (their best run there). Boards: `all`, `season:<id>`, `daily:YYYY-MM-DD`, each kept per game and **major** game version |
| Cap | **1,000 rows per board** (`BOARD_CAP`, `server/boards.js`). The game shows the top 10 and attract mode plays the top few, so 1,000 exact ranks is plenty. Past the cap, a run below the lowest kept row is answered (trophies still count, placement `null`) but not stored on that board |
| Board read | A walk of index `board_top` in fixed windows of 100 rows (ranks 1-100, 101-200, ...): a cache miss costs at most the window's start + 100 rows whatever the board size (checked with EXPLAIN QUERY PLAN in the tests) |
| Cap check | Reads one row of `board_size` (kept by triggers), not a count of the board |
| Concurrency | No lock. Each write is one statement (`INSERT ... ON CONFLICT ... WHERE excluded.score > score`), so two players never wait on each other and one player's two runs can only raise their row |
| Name | Exactly 3 letters A-Z (what the game's entry screen makes). A short blocklist lives in `server/names.js` |
| Cache | `GET /board` answers `cache-control: public, max-age=10`: a new score shows within 10 seconds. The edge cache key is built only from the known params, normalised (game, major version, the board with its default season or day filled in, the window start), so `&x=<random>`, reordered params or another `limit` cannot get past it. At most 10 windows per board, so a burst of reads costs at most 10 window reads per board per 10 s per edge location |
| Edge cache purge | The Worker keeps each board window in Cloudflare's edge cache (`caches.default`) for 10 s. An accepted submit (201), an admin release and an admin hide delete every cached window (all 10) of every board the run is on (`all`, this season, and for a daily that day) before they answer, so the player's next read shows their row. One key helper, `windowKey()` in `server/worker.js`, builds the key for both the read and the purge. A held (202) or refused submit changes no board and purges nothing. Limits: the purge reaches only the data centre that took the submit (Cloudflare's cache is per data centre), so a player elsewhere can see the old board for up to 10 s; and a board read that started just before the submit and finishes just after can put the old window back for up to 10 s. On a `*.workers.dev` address `caches.default` may do nothing at all (then there is nothing to purge and every read goes to D1). **NOT CONFIRMED**: checked in Node with a fake cache only; check it on the live Worker after deploying. No edge cache (Node, the dev server): the purge is skipped |
| `limit`, `offset` | Whole numbers of at most 6 digits, or refused (`bad_board`, no database read). `limit` is cut to 100 and to the rows left before 1,000; an `offset` at or past 1,000 answers `[]` without a read |
| Percentile | Read from counts kept by triggers (keys `rank:...` in `board_size`), not by counting every player: about 60 rows per `/rank` whatever the season size. See "Database reads" below |

### Storage math (plain numbers)

Measured on Node's SQLite (`server/fixtures.mjs`, 2,000 daily submits): about **0.8 KB of rows per accepted submit**, not counting the replay text. Replays of scripted bot runs are **17 to 34 KB**. A dense touch run is 4 chars a frame: a 10-minute run is about 144 KB, the 60-minute maximum is 864 KB.

| What | Grows with | Size |
|---|---|---|
| `all` board | capped | at most 1,000 rows and 1,000 replays: about 25 MB with typical replays |
| One season board | one new board every 28 days | at most 25 MB each with typical replays |
| One daily board | **one new board every day, never trimmed** | at most 25 MB each with typical replays |
| `seen`, `players`, `ratings` | one row per accepted submit / player / player-season | well under 1 KB each |
| `season_runs` | at most 5 rows per player per season | tiny |
| `results` | one row per accepted submit, with the signature | about 1.5 KB each |

**Where it could get big:** old daily boards. With 100 players a day, a year of dailies is about 0.9 GB. With 1,000 players every day (every daily board full), about 9 GB a year, past D1's included 5 GB. If that day comes, delete old daily rows (from the `server` folder). The triggers then drop each replay that no board lists any more:

```
npx wrangler d1 execute arcade-lb --remote --command "DELETE FROM board WHERE board LIKE 'daily:%' AND board < 'daily:2027-01-01'"
```

**Replay pruning is automatic.** A replay is deleted the moment the last board row pointing at it goes: a better run replaced it, the cap pushed it out, or `POST /admin/hide` (triggers `board_removed` and `board_replaced` in `schema.sql`). A run that lands on no board at all never keeps its replay (last statement of the submit batch). The tests check that no replay is left that no board lists. So no separate prune job is needed.

### Database reads (w22 fix, MED1)

**What this is:** how many database rows one submit and one `/rank` read, as the season grows. D1 bills rows read.

Measured with `node server/rows-read.mjs` (it replays the real statements in the `sqlite3` tool with `.scanstats on`, which counts every row and index entry a query walks). Season of N players, all-time and season boards full. "Before" is commit e43f906.

| Players this season | Submit, before | Submit, after | Submit that just gets onto the full boards, after | `/rank`, before | `/rank`, after |
|---|---|---|---|---|---|
| 1,000 | 2,010 | 1,050 | 2,027 | 1,004 | 29 |
| 13,000 | 15,016 | 75 | 2,078 | 13,003 | 53 |
| 100,000 | 102,016 | 88 | 2,120 | 100,003 | 58 |

- **Why it was big:** the percentile counted every rated player of the season, once or twice per submit and once per `/rank`.
- **What changed:** the field is kept as counts at 5 levels (the exact average, groups of 64, of 4,096, ...), updated by triggers in the same statement as the rating, so they cannot drift. "Players below you" is a sum of at most 63 counts a level: exact, and a few hundred rows at the very most whatever the season size. A test rebuilds the counts from `ratings` after 1,500 random submits and hides and compares.
- **The dearer submit** is one that lands on a full board: its placement counts the rows above it, at most 1,000 per board. Most runs on a busy game land below the full boards, and their placement is 3 single-row reads.
- The Worker adds the near-copy lookup (at most 50 rows each side of the score) and the rate counters (2 rows): call a typical submit about 200 rows read, 25 rows written. Not counted above: reads inside triggers (single-row lookups by key).

**Free tier** (D1 free plan: 5 million rows read and 100,000 rows written a day; Workers Paid includes 25 billion rows read and 50 million rows written a month. From Cloudflare's published limits as known when this was written, not re-checked: check at sign-up.)

| Per day, free plan | Before (100,000 players) | After |
|---|---|---|
| Submits that fit the read limit | about 16 (3 percentile scans each, per the review) to 49 | about 25,000 typical, about 2,300 if every run landed on a full board |
| `/rank` reads that fit | about 50 | about 86,000 |
| Submits that fit the write limit (about 10 rows each before, about 20 after: the counts) | about 10,000 | about 5,000 (writes are now the free plan's limit) |

The replay check needs Workers Paid anyway ("Re-sim CPU" below), and its included D1 amounts are far above these numbers.

### Migration note

This is a **fresh schema**. There is no live data yet (nothing has been deployed), so nothing is migrated. The old one-JSON-value-per-board layout in `kv` is no longer written by the Worker; `kv` and `locks` stay only because `d1-adapter.js` `d1Storage` (a general key-value adapter) still uses them. If a database was ever created from the older `schema.sql`, drop it and create it again (Go live, steps 4 and 6). The percentile counts (w22 fix) fill themselves once from `ratings` when `schema.sql` is applied to a database that has ratings but no counts; applying it again never counts anyone twice.

## Taking an entry off the boards

**What this is:** how the owner removes a run (an offensive name the blocklist missed, a cheat found by eye).

1. You need the `ADMIN_TOKEN` secret (see "Near-copy check", step 1).
2. Find the entry id: it is the `id` of the row in `GET /board`.
3. `curl -s -X POST https://arcade-lb.<you>.workers.dev/admin/hide -H "authorization: Bearer <token>" -H 'content-type: application/json' -d '{"entryId": "<id>"}'`
4. It answers 200 `{ ok, hidden, rows, runs }` (`rows`: how many boards it was on; `runs`: 1 if it was one of the player's best 5 this season), or 404 if neither. The entry leaves every board and version, and its replay goes too. A record stays in table `hidden`.
5. **It also leaves trophies** (w22 fix). The run leaves the player's best 5, their average is worked out again from the runs left (a missing run counts as 0, as always), and everyone else's percentile moves with it at once. A player with no run left this season is unrated again (back to their carry from last season). If it was their all-time best, `best` on `/rank` falls to the best run left in their best 5.
6. **Caches:** the hide purges this data centre's cached board windows (see "Edge cache purge" above); a board read already cached at another edge can still show the entry for up to 10 s, and `GET /replay/<id>` for up to 300 s (5 minutes), because those answers are `public, max-age`. After that it is gone everywhere.

The player can still play and submit new runs; the same replay or result again is refused as a duplicate. If the name is the problem, add it to `server/names.js` and redeploy.

## Endpoints

| Call | Answer |
|---|---|
| `POST /submit` with the run as JSON (`game, playerId, name, score, replay, seed, mode, dayKey?, ticket?, version`; `ticket` is the one `/daily` gave, needed for a daily when `DAILY_SECRET` is set) | 201 `{ ok, score, verified: {frames, stage, hash}, id, placements, trophyDelta, trophies, league, rating: {avg5, top5, enteredTop5, percentile, players}, boardCap }`, or 202 `{ ok, held: true, code: "held_for_review", heldId, score, message }` for a near copy |
| `GET /board?game=starfall&board=all\|daily\|season&key=&limit=&offset=&version=` | `{ ok, rows: [{rank, name, score, date, mode, id}] }`. One row per player. `version` defaults to the server's major version. `limit` at most 100, ranks past 1,000 are not kept. Other params are ignored. Cached 10 s |
| `GET /rank?game=starfall&playerId=...&version=` | `{ ok, trophies, league, tier, label, season, best, seasonBest, avg5, top5, percentile, players, carry }` (rule: `leaderboard/README.md`, "Trophies") |
| `GET /replay/<id>` | `{ ok, replay, seed, version, stats, ... }` or 404 |
| `GET /daily?game=starfall` with header `x-player-id: <playerId>` (required when `DAILY_SECRET` is set) | `{ ok, game, dayKey, seed, ticket, issuedAt, dailySecret }`: today's (UTC, server clock) Daily. `ticket` is `null` and `dailySecret` false when no secret is set. Not cached. 60 per address per 10 minutes, then `rate_limited` (429) |
| `POST /admin/release` with `{ id }` and header `authorization: Bearer <ADMIN_TOKEN>` | 201 `{ ok, released, score, id, ... }`. Off (404) unless the secret is set |
| `POST /admin/hide` with `{ entryId }`, same header | 200 `{ ok, hidden, rows, runs }`, or 404 if no board or best-5 list has it. Off (404) unless the secret is set |

Every error is `{ ok: false, error: "<code>", message }`.

## Files

| File | Job |
|---|---|
| `worker.js` | The Worker: routes, limits, the submit flow |
| `boards.js` | Boards, players, replays and trophies as SQL rows; the one-batch submit |
| `names.js` | The 3-letter name check and its blocklist |
| `verify.js` | The replay check (header checks, then the sim, then the game's own strict verifier must agree) |
| `daily.js` | Card 3c: the Daily's seed and ticket from `DAILY_SECRET` (WebCrypto HMAC-SHA256) |
| `d1-adapter.js` | result claims and near-copy lookup, rate counters, and `d1Storage` (a key-value adapter the Worker no longer uses) |
| `dedupe.js` | near-copy check: a run's signature and how alike two runs are |
| `dedupe-measure.mjs` | Measures that check on honest runs and edited copies (numbers above) |
| `schema.sql` | The tables, their indexes and the board triggers |
| `client.js` | Optional browser side: the same methods as the local leaderboard, over HTTP. Off by default |
| `sqlite-d1.js`, `dev-server.mjs`, `fixtures.mjs` | Local only: a D1 stand-in on Node's built-in SQLite, a local server, test helpers |
| `time-resim.mjs` | Measures replay check CPU |
| `rows-read.mjs` | Measures database rows read per submit and per `/rank` (table in "Database reads"; needs the `sqlite3` tool) |
| `wrangler.toml.example` | Deploy config template (no secrets) |

## Try it locally (no account, from the repo root)

```
node server/dev-server.mjs 8850
curl -s 'http://127.0.0.1:8850/board?game=starfall'
```

## Re-sim CPU (measured on this Mac, Node 26)

| Run | Frames | One sim pass | Server check (2 passes) |
|---|---|---|---|
| Short (a quick game over) | 4,239 | about 15 ms | 30 ms warm, 174 ms on a cold start |
| Full first loop (sim-bot seed 1) | 38,859 | 190 ms warm, 438 ms cold | about 380 ms warm, about 0.9 s cold |

**The free plan cannot do this.** It allows 10 ms of CPU per request. Even the shortest real game needs 30 ms, and a full game about 380 ms. Server-side checking needs **Workers Paid ($5 a month)**. Cloudflare's CPU may be a bit faster or slower than this Mac.

The second pass (the game's own verifier) is a safety net. Dropping it would halve the CPU. Not worth it at our size.

## Monthly cost

Prices as researched on 2026-10-28 (log section "(d2) Going live") plus Cloudflare's published paid allowances; check them at sign-up.

| Players' submits per month | Plan | About |
|---|---|---|
| Any, but no server check (trust the client) | Free | $0 |
| Up to about 75,000 (0.4 s CPU each fits the 30 million CPU ms included) | Workers Paid | $5 |
| 250,000 | Workers Paid | $5 + about $1.40 extra CPU = $6.40 |
| 1,000,000 | Workers Paid | $5 + about $7.40 extra CPU = $12.40 |

The site itself (Cloudflare Pages) stays free. D1 storage and reads stay inside the included amounts at these sizes (each submit writes about 12 rows).

## Go live (the owner clicks these)

Steps 3 to 6 run in a terminal **inside the `server` folder** (`cd server` from the repo root), because `wrangler.toml` lives there.

1. Create a free Cloudflare account at dash.cloudflare.com.
2. Upgrade to **Workers Paid** ($5/month): Workers & Pages > Plans. Needed for the replay check (see above).
3. `cd server`, then `npx wrangler login` (opens the browser once).
4. `npx wrangler d1 create arcade-lb`. Copy the `database_id` it prints.
5. `cp wrangler.toml.example wrangler.toml`, paste the id, and set `ALLOWED_ORIGIN` to the game's address (for example `https://<your-project>.pages.dev`).
6. `npx wrangler d1 execute arcade-lb --remote --file=schema.sql`, then `npx wrangler deploy`. It prints the Worker's address, like `https://arcade-lb.<you>.workers.dev`.
5b. **The Daily's secret (required).** `npx wrangler secret put DAILY_SECRET` and paste the output of `openssl rand -hex 32` (64 characters; at least 32 are required). It lives only in Cloudflare, never in the repo. Why: without it the Daily's seed is public, so anyone can compute tomorrow's level today and practise it, and daily runs need no ticket. Check after step 6: `curl -s -H 'x-player-id: checkcheck' 'https://arcade-lb.<you>.workers.dev/daily?game=starfall'` must show `"dailySecret":true`. Never change the secret during a day: every ticket and seed of today and yesterday would stop matching, and those dailies would be refused.
6b. **Deploy the site and the Worker together, every time the game version changes.** The Worker re-simulates runs with its own copy of the game, so it only takes runs of its own `GAME_VERSION`. Boards are kept per major version. If the site ships a new game first, every new run is refused (`wrong_version`); if the Worker ships first, every player on the old page is refused. Deploy both in the same few minutes. A page left open across a deploy gets `wrong_version` with a message that starts "new version, reload"; the game shows it so the player reloads (card 3b).
7. **The one config line:** set `REMOTE_LEADERBOARD_URL = 'https://arcade-lb.<you>.workers.dev'` in `server/client.js`. The game already reads it (`pickLeaderboard` in `games/starfall/main.js`); while it is empty the game keeps its local board. Set it **in the copy of the site you deploy, not in the repo**: `tests/server-client.test.js` checks that the repo copy is empty.
8. Optional, recommended: in the Cloudflare dashboard, Security > WAF > Rate limiting rules, add one rule for the Worker's `/submit` path (for example 60 requests per minute per IP, block for 10 minutes). It stops a flood at the edge before it costs Worker CPU. The server's own limits (steps 1 and 4 in the first table) still apply.
8b. **Recommended: a rate limit on reads.** The Worker has no read limit of its own. Add a rate limiting rule for `GET` requests whose path is `/board` or `/rank` (for example 120 requests per minute per IP, block for 1 minute). The game reads a board or a rank a few times a minute at most, so no real player meets it; a script hammering `/rank` (about 60 rows each, never cached) is stopped at the edge. If your plan allows only one rule, make it one rule covering `/submit`, `/board` and `/rank` at the read numbers.
9. Check (any folder): `curl -s 'https://arcade-lb.<you>.workers.dev/board?game=starfall'` answers `{"ok":true,"rows":[]}`.

## What is still trusted to the client

| Thing | Why it is still trusted | What would fix it |
|---|---|---|
| **Who you are** (`playerId`) | No accounts. Anyone can make a new id, so trophies and "best per player" are per id, not per person | Logins |
| **The one ranked daily attempt** | "First started daily run counts" is kept in the browser. The server cannot see runs that were never sent, so a player can retry the daily and send only the best. Card 3c's ticket does not change this: it proves a run is no older than its ticket, not that it was the first or played live | Count tickets per player per day on the server and take only the first ticket's run (costs a row per `/daily`) |
| **Who played the inputs** | A replay proves the inputs make the score, not that a human typed them. A bot or a tool-assisted run passes | Nothing cheap; watch the top of the board |
| **Free-play seeds** | The client picks the seed, so a player can practise one seed until it is perfect | Server-issued seeds |

## Known limits

- Rows that grow by one per accepted submit and are never trimmed: `results` (result claims, about 1.5 KB each with the signature) and `seen` (exact-replay marks, about 60 bytes). A million submits is about 1.5 GB; D1 includes 5 GB (as researched; check at sign-up). Boards stay at most 1,000 rows each; old daily boards are the one place that keeps growing (see "Storage math").
- Rows read per submit and per `/rank` no longer grow with the season (see "Database reads"). A submit that lands on a full board still counts up to 1,000 rows per board for its placement.
- **Trophies and boards are per major game version.** A major version bump (2.x to 3.0) starts everyone's trophies, best-5 lists and boards again from zero on the new version (the old ones stay readable with `version=`). Minor bumps (2.4 to 2.5) keep everything.
- Hiding a run from an earlier season corrects that season's rating, but not the carry a player already took into this season (it was stored when their first run this season came in).
- Trophies are a percentile, so new low players lift everyone above them. Each one needs a real finished run (rate limited), and players whose best-5 average is 0 are left out of the field.
- Not checked on real D1 yet: the triggers and `INDEXED BY ratings_pid`. Check both on the first deploy (submit twice, read `board_size`).
- Held near copies (`flagged`) keep their whole replay until you delete them; at most 500 wait at once.
- Read calls (`/board`, `/rank`, `/replay`) have no rate limit in the Worker (`/daily` has one: 60 per address per 10 minutes); add the WAF rule (Go live, step 8b). `/board` is cached in at most 10 windows per board, so it is cheap even without it.
- There is no submit lock any more (w22): concurrent submits only race on single atomic statements.
