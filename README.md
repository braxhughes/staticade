<p align="center">
  <a href="https://staticade.com"><img src="docs/media/staticade-lobby.png" alt="The Staticade lobby: arcade cabinets drawn in glowing dots, with STARFALL selected" width="100%" /></a>
</p>

<p align="center"><b>Original browser arcade games, drawn entirely in glowing dots.</b></p>

<p align="center">
  <a href="https://staticade.com"><img src="docs/media/btn-play.svg" alt="Play" height="44" /></a>
  <a href="#how-it-was-built"><img src="docs/media/btn-built.svg" alt="How it was built" height="44" /></a>
  <a href="docs/design.md"><img src="docs/media/btn-design.svg" alt="Design" height="44" /></a>
  <a href="server/README.md"><img src="docs/media/btn-server.svg" alt="Server" height="44" /></a>
</p>

<img src="docs/media/h-play.svg" alt="See it move" width="100%" />

<table>
  <tr>
    <td width="50%"><img src="docs/media/starfall-machine-select.gif" alt="Picking STARFALL in the lobby and pushing into the CRT title screen" /></td>
    <td width="50%"><img src="docs/media/starfall-gameplay.gif" alt="STARFALL gameplay: enemy waves diving and the chain counter climbing" /></td>
  </tr>
</table>

<img src="docs/media/h-inside.svg" alt="What's inside" width="100%" />

<img src="docs/media/cards.svg" alt="Starfall: fixed shooter with 15 stages and 3 bosses. All dots: no image, font or audio files. Fair scores: the server replays your inputs to verify every score. Leaderboards: all-time, daily and season boards with leagues." width="100%" />

<a name="how-it-was-built"></a>
<img src="docs/media/h-built.svg" alt="How it was built" width="100%" />

I directed a team of AI coding agents. They wrote the code; I set the goals and rules, approved every change to an existing test, and played every build.

<img src="docs/media/stats.svg" alt="4 days, October 27 to 30, 2026. 421 commits. 688 Node tests passing. 17 test changes I approved by hand." width="100%" />

<img src="docs/media/pipeline.svg" alt="The build loop. 1 Goal (me): goals in priority order plus the rules every agent follows. 2 Plan (coordinator agent): splits goals into cards with written briefs. 3 Build (builder agent): one card in its own git branch, never grades its own work. 4 Re-run (coordinator): runs the full test suite again instead of trusting the report. 5 Review (fresh agent): never saw the work, writes probes and tries to break it. 6 Fix or stop: fixes go back to review; after two failed reviews I decide. 7 Look (agents): headless screenshots of each slice, opened and described. 8 Playtest (me): what feels wrong goes back as a new card." width="100%" />

| What I did | What the agents did |
|---|---|
| Set the goals, their order, and the rules every agent follows | Wrote all the runtime code: engine, game, lobby, server, tools |
| Answered design questions and sent back what felt wrong in playtests | Wrote the tests, the design spec and notes on every change |
| Approved or refused each change to an existing test | Planned the cards, built them, and reviewed each other's work |

**Tests are append-only for agents.** An agent can add tests but not edit or delete one to make something pass. When a design change made an old test wrong, the agent wrote down the exact old and new assertion and I approved or refused it. Each approval is its own labelled commit. One builder loosened its own test; the reviewer flagged it and it was not merged.

<img src="docs/media/caught.svg" alt="Review caught what tests missed. Passed: Esc-to-lobby passed its own tests and the full suite. Probe: the reviewer stalled one frame for about 120 ms and pressed Esc during it. Fail: the loop finished that frame after leaving, and game music played over the lobby. Fixed: a new card fixed it, with a test that reproduces that exact timing." width="100%" />

<img src="docs/media/h-fair.svg" alt="How scores stay fair" width="100%" />

<img src="docs/media/fair.svg" alt="Browser: runs the game at a fixed 60 steps a second from one seed. Replay: the seed plus one input word per frame, compressed. Worker: re-runs the replay on the same game code in a Cloudflare Worker. D1: stores the score the re-run produced, not the one the client claims. Duplicate replays are refused and near-copies held for review." width="100%" />

**Honest limits.** Every reviewer was a Claude model too, just a fresh instance; no outside human has reviewed the code. Determinism is proven on Chrome's engine only. There is no real-player data yet. The full write-up, including how originality was checked, is in [HOW-IT-WAS-BUILT.md](HOW-IT-WAS-BUILT.md).

<img src="docs/media/h-run.svg" alt="Run it" width="100%" />

```
npm run serve                     # open http://localhost:8770
npm install && npm run test:all   # Node and headless browser tests
```

No build step and zero runtime dependencies.

<sub>Source-available, all rights reserved. See [LICENSE](LICENSE).</sub>

<img src="docs/media/footer.svg" alt="" width="100%" />
