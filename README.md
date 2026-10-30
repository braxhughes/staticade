# STATICADE

**What this is:** a free browser arcade of original skill games, drawn entirely as glowing dots computed in code.

PURE SKILL. DRAWN IN LIGHT.

Play: https://staticade.com

![Walking up to the STARFALL cabinet in the lobby, inserting a coin, and pushing into the CRT title screen](docs/media/starfall-machine-select.gif)

![STARFALL gameplay: stage 1, enemy waves diving, chain counter climbing](docs/media/starfall-gameplay.gif)

## What is in it

| Piece | One line |
|---|---|
| STARFALL | The first game. A fixed shooter: 15 stages in 3 zones, 3 multi-phase bosses, rhythm bonus stages, then endless. |
| Lobby | A first-person row of dot-drawn arcade cabinets. Walk up to one and the camera pushes into its CRT screen. |
| Leaderboards | All-time, Daily and Season boards, plus ranked leagues from Bronze to Legend. |
| Fair scores | The game sends only your inputs. The server re-runs them on the same game code and records the score that re-run produces. |

No image files, no font files, no audio files. Every dot, letter and sound is made in code.

## Run it locally

You need Node (tested on v26) or Python 3. There is no build step.

```
npm run serve
```

Then open http://localhost:8770/ for the lobby, or http://localhost:8770/starfall.html for the game.

Any static file server works too, for example `python3 -m http.server 8770`.

## Test it

```
npm install
npm test               # fast Node-only tests
npm run test:browser   # headless browser tests (uses your installed Google Chrome)
npm run test:all       # both
```

## More

- [HOW-IT-WAS-BUILT.md](HOW-IT-WAS-BUILT.md): how the arcade was built, and how it was checked.
- [docs/design.md](docs/design.md): the Starfall design, with the numbers behind it.
- [server/README.md](server/README.md): the leaderboard server and its anti-cheat checks.

## License

Source-available, all rights reserved. You may read the code. You may not copy, modify, host or reuse it without written permission. See [LICENSE](LICENSE).
