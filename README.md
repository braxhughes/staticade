<p align="center">
  <a href="https://staticade.com"><img src="docs/media/staticade-lobby.png" alt="The Staticade lobby: a STATICADE wordmark over a row of arcade cabinets drawn in glowing dots, with STARFALL selected" width="820" /></a>
</p>

<p align="center"><b>A free browser arcade of original skill games, drawn entirely as glowing dots computed in code.</b></p>

<p align="center">
  <a href="https://staticade.com"><b>Play at staticade.com</b></a> ·
  <a href="HOW-IT-WAS-BUILT.md">How it was built</a> ·
  <a href="docs/design.md">Design doc</a> ·
  <a href="server/README.md">Leaderboard server</a>
</p>

---

## What is in it

| Piece | What it is |
|---|---|
| **STARFALL** | The first game. A fixed shooter: 15 stages in 3 zones, 3 multi-phase bosses, rhythm bonus stages, then endless. |
| **Lobby** | A first-person row of dot-drawn arcade cabinets. Walk up to one and the camera pushes into its CRT screen. |
| **Leaderboards** | All-time, Daily and Season boards, plus ranked leagues from Bronze to Legend. |
| **Fair scores** | The game sends only your inputs. The server re-runs them on the same game code and records the score that re-run produces. |

<table>
  <tr>
    <td width="50%"><img src="docs/media/starfall-machine-select.gif" alt="Picking STARFALL in the lobby, inserting a coin, and pushing into the CRT title screen" /></td>
    <td width="50%"><img src="docs/media/starfall-gameplay.gif" alt="STARFALL gameplay: enemy waves diving and the chain counter climbing" /></td>
  </tr>
  <tr>
    <td align="center">Lobby to cabinet to title screen</td>
    <td align="center">Stage 1, building a kill chain</td>
  </tr>
</table>

## How it works

- **Everything is dots.** No image, font or audio files. Every dot and letter is computed in code, drawn with WebGL, then passed through a CRT shader. All music and sound is synthesized live with Web Audio.
- **Deterministic by design.** The game runs on a fixed 60 Hz step with its own seeded random numbers and math, so the same inputs always produce the same run, in the browser and in Node.
- **Scores you can trust.** Because runs are deterministic, the browser only sends its inputs. A Cloudflare Worker replays them on the real game code and keeps the score only if it matches.
- **No build step.** Plain JavaScript modules and zero runtime dependencies. Serve the folder and it runs.

## How it was built

One person directing a team of AI coding agents. I set the goals, the rules and the quality bar, and I playtested every build. Claude agents wrote the code, tests and design spec, and a separate agent reviewed each change and tried to break it before it could merge. The full story, including what review caught that tests missed, is in [HOW-IT-WAS-BUILT.md](HOW-IT-WAS-BUILT.md).

## Run it locally

You need Node (tested on v26) or Python 3. There is no build step.

```
npm run serve
```

Then open http://localhost:8770/ for the lobby, or http://localhost:8770/starfall.html for the game. Any static file server works too, for example `python3 -m http.server 8770`.

## Test it

```
npm install
npm test               # fast Node-only tests
npm run test:browser   # headless browser tests (uses your installed Google Chrome)
npm run test:all       # both
```

## License

Source-available, all rights reserved. You may read the code. You may not copy, modify, host or reuse it without written permission. See [LICENSE](LICENSE).
