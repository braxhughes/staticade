# How Staticade was built

**What this is:** how one person and a team of AI coding agents built Staticade over a few days, and how the work was checked.

## In one paragraph

I set the goals, the rules and the taste, and I playtested. Claude agents wrote the code, the tests and the design spec. A coordinator agent split the work into small cards. A builder agent did each card in its own git branch. A fresh agent that had not seen the work then reviewed it and tried to break it. The rule the process followed: a card did not merge while its review had serious findings open. "Directed and tested by a human, written by AI agents" is the honest summary.

## What Staticade is

| Piece | One line |
|---|---|
| Idea | An arcade of original competitive games inspired by classic genres. Learn what made the classics great, then build our own answer. Never copy sprites, names, music, layouts or signature mechanics. |
| First game | STARFALL, a fixed shooter. You carry a lantern, kill in chains, graze bullets for points and fight three multi-phase bosses. |
| Look | Every pixel is a dot computed in code, drawn with WebGL, then passed through a CRT effect. No image or font files. |
| Sound | Web Audio synthesis only. No audio files. |
| Rules of play | Pure skill. No pay-to-win. A Daily for every game, same seed for everyone. |

## How it was built

| Step | Who | What happens |
|---|---|---|
| 1. Goal | Me | Goals in priority order, plus the rules every agent must follow (originality, purity of the game simulation, how to test). |
| 2. Plan | Coordinator agent | Turns goals into cards. Each card has a written brief: scope, files it owns, what is forbidden, acceptance checks, and "what the reviewer will try". |
| 3. Build | Builder agent | Works in its own git worktree and branch, so parallel cards never touch the same files. Writes code, new tests and short notes on what it did. Never grades its own work. |
| 4. Re-run | Coordinator agent | Re-runs the full test suite itself instead of trusting the builder's report. |
| 5. Cold review | A fresh agent, often a different model size than the builder | Gets a neutral brief and is told to be adversarial. Writes probes, mutates code in scratch copies to see if the tests catch it, and returns PASS, PARTIAL or FAIL. |
| 6. Fix or stop | Builder, or me | Fixes go back through review. After two failed reviews on the same card, the line stops and I decide. |
| 7. Look | Agents | The process asked for every slice to end with headless screenshots that an agent opens and describes. |
| 8. Playtest | Me | I played each build and sent back what felt wrong. Several of those notes changed the game. |

### Tests are append-only for agents

An agent may add tests. It may not edit, weaken or delete an existing test to make something pass. When a design change really did make an old test wrong, the agent wrote down the exact old and new assertion and asked. I approved or refused each one, and each approved change went in as its own labelled commit. In one case a builder loosened its own test; the reviewer flagged it, and that change was not merged.

### A bug the tests missed

The "press Esc to go back to the lobby" feature passed its own tests and the full suite. A cold reviewer then wrote a probe that stalled one frame for about 120 ms and pressed Esc during it. The game loop kept running the rest of that frame's steps after leaving, and the game's title music started playing over the lobby. Verdict: FAIL. A new card fixed it with a test that reproduces that exact timing. This is the clearest example of why review is a separate step from testing.

### Originality was policed, not assumed

| What was flagged | What happened |
|---|---|
| The first request was a faithful clone of a classic shooter | The agent declined and built an original game in the same genre. From then on: learn from the classics, answer each idea our own way, every system explainable in one line. |
| HUD labels and a default high score copied the classic layout | Replaced with SCORE, BEST and 10000. |
| A mechanic close to a classic "capture" move | Kept on purpose, with the differences sharpened (it targets one diver, costs the full lantern, and the wingman drains it). |
| A pop-culture parody name for a future game | Dropped for an original name. |

## How the game stays fair

| Idea | How |
|---|---|
| Deterministic simulation | The game rules are pure code: no DOM, no WebGL, no audio, no clock, no `Math.random`. All randomness comes from one seeded generator. Trig goes through our own math helpers, because browser `Math.sin` is not guaranteed identical across engines. A test checks the simulation code for these. |
| Fixed step | The simulation runs at exactly 60 steps a second. Rendering interpolates between steps. |
| Replays | A run is saved as its seed plus one input word per frame, run-length encoded. |
| Replay proof | `tools/replay-proof.mjs` plays the game in headless Chrome with real key and touch events, then re-simulates the recording in Node. Score, frame count and a hash of the final state must match exactly. |
| Server check | The leaderboard server re-runs every submitted replay on the same game code and records the score that re-run produces, not the score the client claims. It also refuses duplicate replays and holds near-copies for review. See `server/README.md`. |

## Stack

| Layer | What |
|---|---|
| Language | JavaScript as native ES modules. GLSL shaders inside JS. One SQL schema. |
| Build | None. Serve the folder as static files. |
| Runtime dependencies | None. |
| Dev dependency | Playwright, to drive headless Chrome in tests. |
| Rendering | One WebGL point-sprite pipeline, then a CRT pass (curvature, scanlines, fringe, glare). |
| Audio | Web Audio synthesis with a small tracker-style sequencer. |
| Server | A Cloudflare Worker with a D1 (SQLite) database. `server/dev-server.mjs` runs the same code locally. |

## Run it locally

No build step. From the repo folder:

```
npm run serve
```

Open http://localhost:8770/ for the lobby, or http://localhost:8770/starfall.html for the game. Any static server works too, for example `python3 -m http.server 8770`.

## Test it

```
npm install
npm test               # fast Node-only tests
npm run test:browser   # headless browser tests, using your installed Google Chrome
npm run test:all       # both
```

Other useful tools:

| Tool | What it does |
|---|---|
| `node tools/replay-proof.mjs` | Browser vs Node replay match, described above. |
| `node tools/resim.mjs` | Re-simulates a replay in Node, the same way the server does. |
| `node tools/sim-bot.mjs` | A deterministic bot used as a balance check. |
| `node tools/shot.mjs` | Headless screenshots from a step file. |

## Honest limits

- Every reviewer was a Claude model too, just a fresh instance. No outside human has reviewed the code.
- Determinism is proven on Chrome's engine only, not yet on Firefox or Safari.
- At launch there is no real-player data yet, so the near-copy threshold was measured on simulated runs only.

## License

Source-available, all rights reserved. See [LICENSE](LICENSE).
