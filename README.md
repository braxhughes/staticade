<p align="center">
  <a href="https://staticade.com"><img src="docs/media/staticade-lobby.png" alt="The Staticade lobby: arcade cabinets drawn in glowing dots, with STARFALL selected, STACKLIGHT beside it and its top 10 board" width="100%" /></a>
</p>

<p align="center"><b>Original browser arcade games, drawn entirely in glowing dots.</b><br><sub>STARFALL and STACKLIGHT are live. LEDGE LORDS is next.</sub></p>

<p align="center">
  <a href="https://staticade.com"><img src="docs/media/btn-play.png" alt="Play" height="44" /></a>
  <a href="#how-it-was-built"><img src="docs/media/btn-built.png" alt="How it was built" height="44" /></a>
  <a href="docs/design.md"><img src="docs/media/btn-design.png" alt="Design" height="44" /></a>
  <a href="server/README.md"><img src="docs/media/btn-server.png" alt="Server" height="44" /></a>
</p>

<img src="docs/media/h-play.png" alt="See it move" width="100%" />

<table>
  <tr>
    <td width="50%"><img src="docs/media/starfall-machine-select.gif" alt="Picking STARFALL in the lobby and pushing into the CRT title screen" /></td>
    <td width="50%"><img src="docs/media/starfall-gameplay.gif" alt="STARFALL gameplay: enemy waves diving and the chain counter climbing" /></td>
  </tr>
</table>

<img src="docs/media/h-inside.png" alt="What's inside" width="100%" />

<img src="docs/media/cards.png" alt="STARFALL: fixed shooter, 15 stages, 3 bosses, daily seed and leagues. STACKLIGHT: falling block puzzle where the pieces are beams of light that melt into the stack. All dots: no image, font or audio files. Fair scores: the server replays your inputs to check every score." width="100%" />

<a name="how-it-was-built"></a>
<img src="docs/media/h-built.png" alt="How it was built" width="100%" />

I designed Staticade and ran the build on my own workflow and governance layer for Claude Code. Agents wrote the code; I steered the whole time. Whenever an agent hit a call it shouldn't make alone (taste, originality, scope, a test change, or a risky command or hook), it stopped, showed me the code or command, explained what it would do, and asked how I wanted to handle it. I playtested every build and sent back what felt wrong.

<img src="docs/media/calls.png" alt="During the STARFALL build, October 27 to 30: 36 calls the agents stopped to ask me about, 17 test changes I approved or refused, 11 coordinator sessions I ran and handed off." width="100%" />

<img src="docs/media/stats.png" alt="8 days, October 27 to November 3. 885 commits in the private repo. 1,491 Node and browser tests. 2 original games." width="100%" />

<img src="docs/media/pipeline.png" alt="The build loop. 1 Goal (me): goals in priority order plus the rules every agent follows. 2 Plan (coordinator agent): splits goals into cards with written briefs. 3 Build (builder agent): one card in its own git branch, never grades its own work. 4 Re-run (coordinator): runs the full test suite again instead of trusting the report. 5 Review (fresh agent): never saw the work, writes probes and tries to break it. 6 Fix or stop: fixes go back to review; after two failed reviews I decide. 7 Look (agents): headless screenshots of each slice, opened and described. 8 Playtest (me): what feels wrong goes back as a new card." width="100%" />

<img src="docs/media/h-decisions.png" alt="Decisions I owned" width="100%" />

<img src="docs/media/decisions.svg" alt="Decisions I owned. System: designed the workflow and governance layer the build ran on (coordinator, written briefs, one isolated git worktree per card); set the review policy (a fresh agent on a different model told to break the work; two failed reviews stop the line and come to me); made tests append-only for agents. Product: an arcade of original games across genres, shooter first, block puzzle and platform race next; every game ships a Daily with one seed for everyone; progression is cosmetic and earned, never sold; set launch scope and timing. Design: learn what made the classics work and answer each idea our own way, every system explainable in one line; a landscape layout, a cabinet intro and the CRT pass; ruled on originality flags. Risk: risky commands and hooks came to me with the code and what it would do, and I chose how to handle each; merges to main, deploys, accounts and anything paid stayed off-limits to agents; approved or refused 17 test changes. Playtests: killed a CRT regression, capped power-ups at 15 seconds, one wingman at a time, capped ECLIPSE fire, ordered a stage-variety plan, sent the lobby back for a rebuild." width="100%" />

| What I did | What the agents did |
|---|---|
| Designed the workflow and governance layer the agents ran on. Set the goals, their order and the rules | Wrote all the runtime code: engine, game, lobby, server, tools |
| Set the design direction (original answers to the classics, every system explainable in one line) and made the taste, scope and originality calls | Researched the classics and wrote the design spec with its numbers, the tests and notes on every change |
| Playtested every build, approved or refused each test change, and kept merges, deploys and purchases as my call | Planned the cards, built them, and reviewed each other's work |

**Tests are append-only for agents.** An agent can add tests but not edit or delete one to make something pass. When a design change made an old test wrong, the agent wrote down the exact old and new assertion and I approved or refused it. Each approval is its own labelled commit. One builder loosened its own test; the reviewer flagged it and it was not merged.

<img src="docs/media/caught.png" alt="Review caught what tests missed. Passed: Esc-to-lobby passed its own tests and the full suite. Probe: the reviewer stalled one frame for about 120 ms and pressed Esc during it. Fail: the loop finished that frame after leaving, and game music played over the lobby. Fixed: a new card fixed it, with a test that reproduces that exact timing." width="100%" />

<img src="docs/media/h-fair.png" alt="How scores stay fair" width="100%" />

<img src="docs/media/fair.png" alt="Browser: runs the game at a fixed 60 steps a second from one seed. Replay: the seed plus one input word per frame, compressed. Worker: re-runs the replay on the same game code in a Cloudflare Worker. D1: stores the score the re-run produced, not the one the client claims. Duplicate replays are refused and near-copies held for review." width="100%" />

The full write-up, including how originality was checked, is in [HOW-IT-WAS-BUILT.md](HOW-IT-WAS-BUILT.md).

<img src="docs/media/h-run.png" alt="Run it" width="100%" />

```
npm run serve                     # open http://localhost:8770
npm install && npm run test:all   # Node and headless browser tests
```

No build step and zero runtime dependencies.

Every picture on this page was drawn by the game's own dot renderer, font and CRT pass. The scenes are in [tools/readme](tools/readme).

<sub>Source-available, all rights reserved. See [LICENSE](LICENSE).</sub>

<img src="docs/media/footer.png" alt="" width="100%" />
