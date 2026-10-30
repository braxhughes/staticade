# Starfall design

**What this is:** the research on what made the classic fixed shooters great, and the design of Starfall that answers each lesson in its own way.

How to read it:
- Section A: what the classics did, and Starfall's original answer, one line each.
- Section B: the full design with exact numbers.
- Section D: planned, not in this release (a short summary).

Ground rules this design obeys:
- Everything that affects score or survival lives in the sim (`games/starfall/sim.js` and its modules). All timing is in **sim frames at 60 Hz**. No wall-clock time anywhere in scoring or difficulty. "1 s" below always means 60 frames.
- All gameplay randomness uses the seeded RNG. A replay (seed + input words) must re-simulate to the same score in Node.
- Distances are in playfield units (the 400x300 field). Speeds are units per frame. The player moves at up to 2.7 units/frame and sits at y = 274 (v1 values).
- No copied names, sprites, music, score tables, layouts or signature mechanics.

---

## A. Lesson table

| System | Classic example | What it does for the player | Starfall's ORIGINAL answer (one line) | Source |
|---|---|---|---|---|
| Entry choreography | Galaga: enemies fly into formation from the top and sides before the stage is fought | A free "read the pattern" moment and a target-rich window for players who learn the paths | **Lead kill:** each entry group has a glowing leader; kill it on its path and the rest of the group panics and is worth x2 until it reaches the formation | https://en.wikipedia.org/wiki/Galaga |
| Formation | Galaxian: a formation near the top that individual aliens break away from | One calm, readable threat structure that each dive breaks apart | The formation **breathes** (already in v1) and in Z2 it **sways like a tide**, so slot positions drift and aim must lead | https://en.wikipedia.org/wiki/Galaxian |
| Dives | Galaxian: enemies watch the player's moves and attack based on them; Galaga: dives get faster and fire more as stages go up | Personal, reactive danger; the core skill test | Every dive is **telegraphed** (diver glows 20 frames first, Warden 30) and the Warden's telegraph is a scoring window (**Interrupt**) | https://en.wikipedia.org/wiki/Galaxian , https://en.wikipedia.org/wiki/Galaga |
| Escort bonus | Galaxian: flagship dives with two escorts; killing all three gives bonus points, with the order mattering | Makes players take a riskier shot order for a bigger payout | **Interrupt:** kill the Warden during its 30-frame telegraph, before it gathers escorts, for 750; no kill-order table | https://en.wikipedia.org/wiki/Galaxian , https://strategywiki.org/wiki/Galaxian/Walkthrough |
| Capture / dual ship risk-reward | Galaga: a Boss captures your ship; rescue it for a dual fighter with double fire and a bigger hitbox | Players deliberately risk a life to gain power; the most famous gamble in the genre | **KINDLE** (kept from v1): spend a full lantern to turn one diver into a wingman; wingmen drain the lantern and can be shot off you | https://en.wikipedia.org/wiki/Galaga , https://giantbomb.com/wiki/Games/Galaga |
| Capture, later take | Gaplus: shoot enemies to get power-ups, including a beam that captures bugs as escorts | Power without losing a life | Kept KINDLE single-target and paid for; captures-many is NOT used (see B.1 note) | https://en.wikipedia.org/wiki/Gaplus |
| Mass convert | Galaga Legions DX: shooting a black-hole bomb pulls on-screen enemies to your side | A big satisfying swing of power | Not used. KINDLE stays one-at-a-time so the gamble stays sharp | https://en.wikipedia.org/wiki/Galaga_Legions_DX |
| Bonus stages | Galaga: every 4th stage enemies fly a set pattern and do not shoot; perfect clear gives a big bonus | A breather that still tests skill; a "perfect" to brag about | **STARLIGHT** (kept) is a **rhythm stage built from phrases**: enemies arrive on the beat in phrases, and you are graded per phrase (complete, in tune, in order) | https://en.wikipedia.org/wiki/Galaga , https://www.arcade-history.com/game/898/ |
| Bonus stage variety | Gaplus: the bonus stage has you juggle enemies by hitting them as many times as possible | Fresh skill test inside the same frame | One shared STARLIGHT track (144 BPM); zones differ by **phrase density** (one enemy per 2 beats, per beat, two per beat) and enemy count (36 / 42 / 48) | https://en.wikipedia.org/wiki/Gaplus |
| Music-led choreography | Galaga '88: tracks were written first and enemy movement was choreographed to the music | Movement feels like dance; the game feels alive | The **sim owns the beat** (every beat is a whole number of frames) and STARLIGHT arrivals land on beats, so music and motion cannot drift, even in replays | https://en.wikipedia.org/wiki/Galaga_%2788 |
| Routes / dimensions | Galaga '88: collect warp capsules to jump to harder dimensions; endings depend on the dimension | Long-term goals and replay value | Not in v2. Daily seeded runs need everyone on the same path. Replay value comes from scoring depth instead | https://en.wikipedia.org/wiki/Galaga_%2788 , https://strategywiki.org/wiki/Galaga_'88/Walkthrough |
| Scoring chains | DoDonPachi: kill in quick succession to build a chain; waiting too long breaks it | The core "great vs good" separator: tempo and routing | **Ember Chain:** kills within 90 frames keep a chain; tiers x2/x3/x4; **grazes refuel the chain timer** | https://shmups.wiki/library/DoDonPachi , https://shmups.wiki/library/DoDonPachi_3 |
| Chain by kind | Ikaruga: three kills of the same color in a row form a chain that doubles in value | Forces kill order planning | Not copied. Our order-planning levers are **Lead kill**, **Interrupt**, and STARLIGHT's **In Order** phrase grade | https://en.wikipedia.org/wiki/Ikaruga |
| Multiplier pickups | Geometry Wars RE2: enemies drop geoms; collecting raises a multiplier that survives death | Rewards moving into danger to collect | Not copied. Our "go into danger" lever is **graze** and **Close** kills (+50% within 32 units) | https://en.wikipedia.org/wiki/Geometry_Wars:_Retro_Evolved_2 |
| Graze | Psyvariar: grazing bullets builds Buzz that levels up the ship | Makes near misses the most exciting moment | A graze adds score and **12 frames of chain time** and fans the lantern (8 grazes = 1 lantern dot) | https://shmup.fandom.com/wiki/Psyvariar |
| Chain explosions | Galaga Legions DX: big enemies explode and chain through the squad, for half points | Efficient clears with a scoring cost | **Cinder** (Z3) drops a falling ember when killed; kill it high on screen or eat the danger | https://www.gamespot.com/reviews/galaga-legions-dx-review/1900-6322400/ |
| Difficulty and rank | Galaga: dives faster and more shots per stage; Battle Garegga: hidden rank rises with scoring and drops when you die | Pressure that matches the player; a resource expert players manage | **Heat** is visible (a flame on the HUD), rises with clean play, falls on death, and raises both danger and points | https://en.wikipedia.org/wiki/Galaga , https://shmups.wiki/library/Battle_Garegga |
| Bosses | Phoenix: the 5th stage is a large fortress; shoot through its hull and a rotating shield band to reach the pilot | A set-piece that tests aim and patience | Three **multi-phase** bosses, each with a different weak-point logic: break panels (Eclipse), cut tendrils then catch the open lens (Moonwell), catch the exhale (Pyre) | https://en.wikipedia.org/wiki/Phoenix_(1980_video_game) |
| Power-ups | Gaplus: certain destroyed enemies drop upgrades, including shot-cancel and slow-enemy powers | Spikes of power and choice | One **Lamplighter** per stage drops a glyph that **cycles** its type as it falls; you choose by when you catch it; each power has a cost | https://en.wikipedia.org/wiki/Gaplus |
| Power-up roulette | Space Invaders Extreme: shoot a UFO, play a roulette, matching color gives a power-up, then Fever | Choice-under-pressure and a payoff burst | No roulette or fever. The cycling glyph is the choice; the fixed cycle order means skill, not luck, picks it | https://en.wikipedia.org/wiki/Space_Invaders_Extreme |
| Pacing | Galaga: early location tests let players go too far on one coin, so difficulty was raised | Session length is a design target, not an accident | Fixed target: **15 to 20 min** for a good player through 3 zones, then endless; checked with a deterministic headless bot | https://en.wikipedia.org/wiki/Galaga |
| Audio | Galaxian: first Namco arcade game composed with a synthesizer; Galaga '88: music and sound meant to convey "a sense of entertainment" | Sound tells you what happened without looking | All Web Audio synthesis; every sim event has a sound; chain ticks rise in pitch; music adds layers as heat rises | https://en.wikipedia.org/wiki/Galaxian , https://en.wikipedia.org/wiki/Galaga_%2788 |
| Music sync | Space Invaders Extreme 2: music synced to on-screen actions; shots produce notes | Play feels like performing | In STARLIGHT, on-beat kills play the next note of the melody; off-beat kills play a muted thud | https://www.siliconera.com/space-invaders-extreme-2-feel-the-flow/ |
| Attract mode | Arcade attract loops drew passers-by and taught the game; some showed it played comically badly | The game sells itself and teaches while idle | Attract mode **plays the best local replay** of the current version (the real run, re-simulated); otherwise a bundled demo replay | https://lawofgamedesign.com/2016/07/29/phalanx3ds-attract-mode/ , https://tvtropes.org/pmwiki/pmwiki.php/Main/AttractMode |
| High-score culture | Asteroids is credited with the first high-score table; 3-letter initials; Galaga still has record tournaments (Twin Galaxies) | Public proof of skill; a reason to come back | Local boards with trophies and leagues, replays attached to every score, 10-char names | https://arcadeblogger.com/2021/01/31/anatomy-of-arcade-high-score-tables/ , https://en.wikipedia.org/wiki/Galaga |
| Daily run | Spelunky daily: one seed per day, same for everyone, one attempt | Scores reflect skill, not luck of the draw; a daily habit | **Daily Flight:** UTC-date seed; the first **started** run is the ranked one, later runs are practice on the same seed | https://spelunky.fandom.com/wiki/Daily_Challenge_Mode_(HD) , https://www.gamedeveloper.com/design/the-24-hour-ticket-examining-daily-runs- |
| Hit-stop | Sakurai: freeze the action for impact, with a cap on max freeze; Vlambeer-style shooters freeze 10 to 20 ms on hit and use quickly decaying shake | Impacts feel heavy | Hit-stop is a **sim frame counter** with a per-event table and a hard cap of 8 frames | https://sourcegaming.info/2015/11/11/thoughts-on-hitstop-sakurais-famitsu-column-vol-490-1/ , https://infovore.org/?p=5275 |
| Bullet readability | Enemy bullets must stand out, usually bright; bullet-to-background contrast should be high | Deaths feel fair | Enemy bullets are always round with a **white core** and a halo that contrasts each zone's sky; player shots are always vertical streaks | https://www.gamedeveloper.com/design/bright-slow-and-deadly , https://www.gamedeveloper.com/design/the-anatomy-of-a-shmup |

Citation note: the Game Developer daily-runs URL really ends in a dash (that is the article's slug; checked that it resolves).

---

## B. Full design

### B.0 Run structure

| Zone | Stages | Content |
|---|---|---|
| Z1 Lantern Reach | 1, 2, 3 normal; 4 STARLIGHT; 5 boss ECLIPSE | Teaching zone |
| Z2 Glass Tide | 6, 7, 8 normal; 9 STARLIGHT; 10 boss MOONWELL | New: Prism, Eel |
| Z3 Hollow Sun | 11, 12, 13 normal; 14 STARLIGHT; 15 boss PYRE | New: Cinder, Mirage |
| Endless | 16+ | Stage s plays table row `((s-1) % 15) + 1` with loop scaling L = floor((s-1)/15) |

Note: v1's "bonus every 4th, boss every 5th" is replaced by this table (`stageKind` comes from the table, not modulo).

**Run length budget for a good player** (one who clears every stage, kills every boss, and dies about 4 times):

| Piece | Each (s) | Count | Total (s) | Basis | Bot-measured each (s) |
|---|---|---|---|---|---|
| Z1 normal stage | 50 | 3 | 150 | v1 entry takes about 16 s; clearing 40 slow divers about 35 s | 28 (18 to 40) |
| Z2 normal stage | 60 | 3 | 180 | more hp (Prism), Eels, tide sway | 32 (21 to 43) |
| Z3 normal stage | 70 | 3 | 210 | Mirage misses, Cinder dodging | 30 (23 to 44) |
| STARLIGHT | 43 | 3 | 129 | fixed length: 104 beats x 25 frames = 2600 frames | 52 (3093 frames with its cards) |
| ECLIPSE | 50 | 1 | 50 | 24 panel hp + 16 core hp, 2 shots in flight | 31 (28 to 37), killed |
| MOONWELL | 70 | 1 | 70 | lens only open 60 of every ~180 frames | 98, timeout |
| PYRE | 90 | 1 | 90 | core only open on exhale in phase 2 | 98 (98 to 100), timeout |
| Stage card + clear card | 4 | 15 | 60 | 240 frames each | inside each stage above |
| Death respawn | 3 | 4 | 12 | 180 frames each | inside each stage above |
| **Total** | | | **951 s = 15.9 min = 57,060 frames** | inside the 15 to 20 min band | **650 s = 10.8 min = 38,992 frames** |

**Bot-measured budget:** the last column is the balance bot (`tools/sim-bot.mjs`), mean of seeds 1 to 5 (range in brackets), with card, clear and respawn frames counted inside each stage. The bot reaches stage 16 at 37,934 to 40,605 frames with 0 to 6 deaths. It clears normal stages in about half the paper guess and times out MOONWELL and PYRE. The paper column is kept as the design intent for a human; the balance gate uses the measured run: **stage 16 in 34,000 to 46,000 frames, at most 8 deaths**.

A weaker player who times out every boss adds about (90 - 50) + (90 - 70) + (90 - 90) = 60 s: 16.9 min. A great player may finish in about 13 min; the band is for a good player. The balance bot checks this with a bot.

Boss timeout: every boss leaves after 5400 non-hit-stop frames (90 s) if not killed ("ECLIPSE PASSES" and so on). You advance, but get no boss kill bonus and no zone no-miss bonus. This caps the run length and prevents a stuck run.

Lives: start 3. Extra life at 40,000 and 150,000, then every 250,000 (400k, 650k, ...). Max stock 6. No continues (one credit, arcade style). Check against B.4 scoring: a good player scores about 150k in loop 1 (2 extends); a great player about 500k to 600k (3 to 4 extends, hits the stock cap only in endless).

### B.1 KINDLE, DEEP SKY, STARLIGHT (kept)

| Feature | v1 behavior | v2 change | Why |
|---|---|---|---|
| KINDLE | 10 kills fill the lantern; X turns the nearest diver into a wingman (max 2) or clears bullets in 130 units | Keep. Lantern also fills from grazes (8 grazes = 1 dot). Wingmen fire your base shot, never your power-up. Z2+ Wisps aim at wingmen first. **B.10: at most 1 wingman (X with a wingman out does the bullet clear instead); a wingman lives 600 frames (10 s), blinks for its last 90, then peels off the top of the screen (no points, no lantern loss)** | Keeps the classic "risk for power" gamble but paid with a meter, not a life |
| DEEP SKY comet | Shoot the comet: multiplier +1 (max x4) until death; palette shift | Keep. Comet appears in normal stages 2 to 13 with chance 0.7 (seeded), at a seeded frame between 500 and 1200 of the stage | Already original; it is the "long run" multiplier, the chain is the "short run" one |
| STARLIGHT | Every 4th stage, 40 enemies on set paths, no fire, 100 per hit | Rebuilt as a phrase-based rhythm stage (B.4). Different counts, values and bonuses from v1 | v1's skeleton matched Galaga's Challenging Stage too closely; rhythm is now its identity |

Note on KINDLE originality: Gaplus has a beam that captures enemies as escorts and Legions DX converts every enemy on screen. KINDLE differs in three ways: it targets one diver, it costs the full lantern, and wingmen keep draining it. Kept on purpose.

Note on ECLIPSE's ring: a boss with a rotating shield ring around a weak core is a genre trope going back to Phoenix's rotating shield band (https://en.wikipedia.org/wiki/Phoenix_(1980_video_game)). Starfall keeps its ring (v1 feature) and makes it its own with breakable panels that change the attack phases (B.6).

Note on the Eel: a segmented body that follows its head is a centipede-style trope (Centipede, 1981). The Eel differs: a body hit kills only that segment and never splits the ribbon into new heads; only the head steers and dives; killing the head scatters the rest as free flyers; and the reward is for unspooling it tail to head.

### B.2 Power-ups

**Source:** one **Lamplighter** per normal stage from stage 2 (new Z1 enemy, 1 hp, 300 / 600 pts). It enters as the 4th member of entry group 3 and joins the formation. It is visibly lit (a small lantern dot above it).

**Drop rule (fair and deterministic):**
- Kill the Lamplighter anywhere (formation, path or dive): it drops a **glyph**.
- The glyph falls at 0.8 units/frame and **cycles** type every 45 frames in fixed order: FAN, LANCE, HALO, ECHO, FAN... (B.11 4 grows the cycle by zone: Z1 adds REED, Z2 MIRROR, Z3 ARC)
- Starting type is drawn at stage setup (B.11 4: from its own seeded stream, so it is the same for everyone on the daily seed).
- **Mercy rule:** if you died in the previous stage, the start type is HALO.
- Catch it by touching it (radius 8). Shooting it does nothing. Missed glyphs are gone. (B.11 4.0a, once built: a glyph from a kill at y <= 120 waits at your row for one full cycle, and a waiting glyph is caught only after 12 frames in a row within radius 8, so dodging across it never catches it.)
- You hold **one** power-up. Catching a new one replaces the old. Death removes it.
- **B.10 timer:** every power-up lasts **900 play frames (15 s)**. The clock runs only while the ship is alive in the `play` state and is frozen by hit-stop, stage intro and stage clear. A catch (even of the same type) restarts it at 900. A thin bar under the ship's lives shows the time left; the last 120 frames it blinks. At 0 the power ends with `powerdown` and a "FADED" popup.

v1 fire rules for reference: auto-fire every 10 frames while held; at most 2 shots on screen per ship; shots fly at 6.5.

| Power-up | What it does (one line) | Cost (the tradeoff) | Duration |
|---|---|---|---|
| **FAN** | Every shot is 3 shots at -12, 0, +12 degrees | Shots fly at 5.0 instead of 6.5 and the cap stays 2 volleys on screen, so a missed volley blocks fire longer; side shots that miss count as fired, so the accuracy bonus drops | 900 frames or death |
| **LANCE** | Shot pierces up to 3 enemies in a line | Refire 24 frames instead of 10; LANCE kills give only 45 frames of chain time instead of 90 | 900 frames or death |
| **HALO** | A ring around the ship absorbs 3 enemy bullets (or 1 body hit) | You cannot graze while HALO is up; ship speed -15% (2.3 max) | 3 absorbs, 900 frames, or death |
| **ECHO** | Every shot fires again from the same spot 20 frames later | Echo shots count against your 2-shot cap, so fresh aimed fire is roughly halved; echoes cannot follow a moving target | 900 frames or death |

Catch score: 500 (a flat bonus, see B.4). Losing a power-up on death plays `powerdown`.

### B.3 Zones

Palettes are RGB in 0..1 for the dot renderer. Star fields are cosmetic (render side, may use unseeded randomness).

| | Z1 Lantern Reach | Z2 Glass Tide | Z3 Hollow Sun |
|---|---|---|---|
| Mood | Warm, hopeful, teaching | Cool, flowing, uncanny | Urgent, hot, final |
| Sky base | black, as v1 | black | black |
| Accent 1 | amber (1, 0.7, 0.25) | teal (0.25, 0.95, 0.9) | crimson (0.95, 0.15, 0.25) |
| Accent 2 | gold (1, 0.88, 0.4) | violet (0.6, 0.4, 1) | rose (1, 0.5, 0.65) |
| Accent 3 | soft white (1, 0.95, 0.85) | ice (0.8, 0.95, 1) | gold (1, 0.85, 0.3) |
| Enemy bullet halo | magenta-rose (1, 0.3, 0.6) | coral (1, 0.55, 0.3) | cyan-white (0.6, 1, 1) |
| Star field | 140 stars, 3 parallax layers, speed 0.3 / 0.6 / 0.9 down; slow gold twinkle | 120 stars drifting down-left; whole field sways x by sin(frame*0.01)*6; 3 faint caustic bands that ripple | 160 stars streaming 1.2 / 1.8 / 2.4 down; a hollow sun ring (radius 70) low on the horizon that pulses on each sim beat; heat shimmer on the bottom 40 rows |
| Formation | v1 breathe + sway | v1 breathe + **tide sway**: row r offsets x by sin(formT*0.02 + r*0.9)*10 | v1 breathe, faster: breathe period 0.045 |
| Enemy mix per stage | S1: moth, wisp, warden. S2: + 4 splitters, + Lamplighter. S3: + 6 splitters | S6: + 4 Prisms (row 1). S7: + 1 Eel per 2 groups. S8: 6 Prisms + 2 Eels | S11: + 6 Cinders (row 3-4). S12: + 4 Mirages. S13: 6 Cinders + 6 Mirages + 2 Eels |
| Entry choreography | v1 paths (top loop, side sweep), mirrored and varied per stage | **Braids:** two groups enter at once on mirrored paths that cross mid-screen | **Spirals:** groups enter on paths that orbit the screen center once before joining |

New enemies (all original designs, sprites drawn as dots):

| Enemy | Zone | HP | Form / Dive pts | Behavior | Counter-play |
|---|---|---|---|---|---|
| **Lamplighter** | Z1+ | 1 | 300 / 600 | Carries the power-up glyph; dives rarely (weight 0.3) | Kill it, then position to catch the glyph type you want |
| **Prism** | Z2+ | 2 | 160 / 400 | Glass diamond whose bright face turns toward the player. While the face glows (on 90 frames, off 60), shots that hit the face are **deflected: the shot vanishes with a small spark at the face**. Deflected shots never become hazards; they count as fired, not hit | Hit it when the face dims, or from the side during a dive |
| **Eel** | Z2+ | 5 segments, 1 each | 80 per segment; head 400 | Enters as one 5-segment ribbon; joins formation as a curled row. Dives as a ribbon (segments follow the head with an 8-frame delay). Killing the head makes the rest scatter as free flyers | Kill tail-first: all 5 tail to head gives +2000 "UNSPOOLED" |
| **Cinder** | Z3 | 1 | 120 / 260 | On death drops an ember bullet straight down at 1.4. **If the Cinder dies within 48 units of the player, no ember spawns** (readability rule 5) | Kill it high (above y = 120) so the ember is easy to dodge |
| **Mirage** | Z3 | 1 | 200 / 500 | Shows two copies 30 units apart. Every 40 frames the solid copy swaps. The swap is a **12-frame cross-fade**, and the hit state switches at the **start** of the fade: the copy that begins brightening is already the solid one. Shots pass through the ghost | Watch which copy starts brightening; ghost shots still count as fired |

Wingman reaction (roadmap item 3): from Z2, Wisps fire at the nearest wingman if one exists, and Eel heads steer toward wingmen. One line: "enemies hunt your borrowed friends first".

### B.4 Scoring depth

**Two kinds of points:**
- **Kill points** = base x DEEP SKY (1..4) x chain tier (1..4) x heat factor (1..1.5) x loop factor (1..3), rounded down to a multiple of 10.
- **Flat bonuses** (graze, catch, comet, Unspooled, chain end, stage clear, STARLIGHT phrase and finale, boss kill, zone no-miss) = value x loop factor only.

Every timer is in sim frames. During hit-stop no scoring timer runs (see B.9).

**Base values** (v1 values kept, new ones added): moth 60/120, wisp 90/180, warden 200/500, splitter 150/300, spark 100, Lamplighter 300/600, Prism 160/400, Eel segment 80, Eel head 400, Cinder 120/260, Mirage 200/500. (Form value / dive value.)

**Ember Chain**
| Rule | Number |
|---|---|
| Chain window after each kill | 90 frames (45 for every kill while LANCE is held) |
| Graze adds to the window | +12 frames, never above the window the last kill granted (90, or 45 after a LANCE kill) |
| Tier x1 | chain 0 to 9 |
| Tier x2 | chain 10 to 29 |
| Tier x3 | chain 30 to 59 |
| Tier x4 | chain 60+ |
| Chain end bonus (chain length n at least 10) | 5 x n x n, n capped at 60 (max 18,000 per chain in loop 1). Flat bonus |
| Chain breaks on | window runs out, player death, stage end. Window run-out and stage end pay the end bonus; **a death forfeits it** |
| Boss hits | each panel/tendril/lens/core hit refreshes the window to 90 but adds no count; each piece destroyed adds 1 |

For scale: the chain end max (18,000) is below a fast boss kill bonus (up to 40,000) and below a STARLIGHT finale (up to 21,120).

**Risk-reward bonuses**
| Bonus | Trigger | Points |
|---|---|---|
| Lead kill | Kill an entry group's leader while it is on its path | Kill points: leader x2; followers x2 until they join formation; popup "SCATTER" |
| Interrupt | Kill a Warden during its 30-frame dive telegraph | Base becomes 750 (kill points, so all multipliers apply) |
| Close | Kill a diving enemy whose center is within 32 units of the player | Base +50% |
| Graze | An enemy bullet passes within 7 units of the player's center without hitting (once per bullet) | 20 flat, +12 chain frames, +1/8 lantern dot |
| Unspooled | Kill all 5 Eel segments tail to head | 2000 flat |
| Catch | Catch a glyph | 500 flat |
| Comet | Shoot the DEEP SKY comet | 1000 x new DEEP SKY mult (v1 rule), flat |
| Stage clear, no death | Clear a normal stage without dying | 30 x accuracy percent (max 3000); accuracy is capped at 100% |
| Boss kill | Kill the boss | max(5000, 40000 - 8 x fight frames), counting non-hit-stop frames. 50 s fight = 16,000; 30 s = 25,600 |
| Zone no-miss | Kill the zone's boss without having died in that zone | 20,000. **None if the boss timed out** |

**Stacking rules:** at most one base adjustment applies to a kill. Interrupt and Close never stack: Interrupt kills happen before the dive, and Close only applies to diving enemies. Interrupt replaces the Warden's base; Lead does not apply to it (Wardens are never group leaders).

**Worked example, stage 3** (40 enemies, average base 110, no LANCE):

| | Good player | Great player |
|---|---|---|
| DEEP SKY | x1 | x2 (comet hit in stage 2) |
| Heat at stage 3 | 0 (died in stage 2) | 4 (two clean stages): factor 1.02 |
| Chain | breaks every few kills, always tier x1: tier sum 40 | one 40-kill chain: kills 1 to 9 at x1, 10 to 29 at x2, 30 to 40 at x3: tier sum 9 + 40 + 33 = 82 |
| Kill points | 110 x 1 x 40 = 4,400 | 110 x 2 x 82 x 1.02 = 18,400 |
| Chain end bonus | 0 | 5 x 40 x 40 = 8,000 |
| Stage clear | 30 x 80 = 2,400 (no death this stage) | 30 x 97 = 2,910 |
| **Stage total** | **6,800** | **29,310 (about 4.3x)** |

**STARLIGHT (phrase-based rhythm stage)**

One shared track for every STARLIGHT stage: `bonus`, 144 BPM, G major. **One beat = 25 frames in every zone.** Beat 0 is the first frame after the stage card. STARLIGHT has **no hit-stop**, so the beat clock is simply STARLIGHT stage frames / 25.

| Rule | Z1 (stage 4) | Z2 (stage 9) | Z3 (stage 14) |
|---|---|---|---|
| Enemies | 36 | 42 | 48 |
| Phrases | 6 phrases of 6 | 6 phrases of 7 | 6 phrases of 8 |
| Phrase density | one arrival every 2 beats | one arrival per beat | two arrivals per beat (on the beat and the half beat, 12 and 13 frames) |
| Phrase start | every 16 beats (beats 0, 16, 32, 48, 64, 80) | same | same |
| Flight | each enemy flies its zone's phrase path for 10 beats, then exits | same | same |
| Stage length | 104 beats = 2600 frames (43 s) | same | same |

| Scoring rule | Number |
|---|---|
| On-beat window | kill frame within 4 frames of a beat (9 of every 25 frames) |
| Kill, off-beat | 120 (kill points: DEEP SKY, chain, heat and loop apply) |
| Kill, on-beat | 250 (kill points) |
| Phrase **Complete** (every enemy in the phrase killed) | 90 x phrase size flat (Z1 540, Z2 630, Z3 720) |
| Phrase **In Tune** (Complete and every kill on-beat) | 210 x phrase size flat instead (Z1 1,260, Z2 1,470, Z3 1,680) |
| Phrase **In Order** (this phrase's enemies killed in their arrival order) | phrase bonus x1.5. Phrases can overlap in Z1 (a phrase's last enemy leaves at beat 20, the next phrase starts at beat 16), so order is judged **per phrase only**: kills of other phrases' enemies never break it. Each phrase is tinted with one of two alternating hues so overlapping phrases are easy to tell apart |
| Finale **ENCORE** (every phrase Complete) | 175 x enemy count flat (Z1 6,300, Z2 7,350, Z3 8,400) |
| Finale **STANDING OVATION** (every phrase In Tune) | 440 x enemy count flat instead (Z1 15,840, Z2 18,480, Z3 21,120) |
| Chain | STARLIGHT kills extend the Ember Chain as usual |

Audio: on-beat kills play the next note of the phrase melody; off-beat kills play a muted thud.

### B.5 Difficulty curve

**First loop, stage by stage.** Speeds in units/frame, gaps in frames.

| Stage | Kind | Entry spd | Dive spd | Bullet spd | Shots/dive | Max divers (full / 8 or fewer left) | Dive gap (full / 8 or fewer) | Path fire chance /frame | Bullet cap | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | normal | 2.4 | 1.65 | 2.0 | 0 or 1 (50%) | 2 / 3 | 120 / 45 | 0 | 12 | Teaching. No Lamplighter |
| 2 | normal | 2.4 | 1.75 | 2.0 | 1 | 2 / 3 | 120 / 45 | 0 | 14 | Lamplighter, splitters, comet; Weave (B.11) |
| 3 | normal | 2.6 | 1.95 | 2.3 | 2 | 3 / 5 | 95 / 25 | 0.002 | 18 | Pincer, Hunt (B.11) |
| 4 | STARLIGHT | path-timed | | | | | | | 0 | 36 enemies |
| 5 | ECLIPSE | | | 1.0 to 1.6 | | | | | 40 | See B.6 |
| 6 | normal | 2.7 | 2.10 | 2.4 | 2 | 3 / 6 | 88 / 25 | 0.004 | 22 | Prisms |
| 7 | normal | 2.8 | 2.20 | 2.5 | 2 | 4 / 6 | 80 / 25 | 0.005 | 24 | Eels |
| 8 | normal | 2.9 | 2.35 | 2.6 | 2 | 4 / 7 | 72 / 22 | 0.006 | 26 | |
| 9 | STARLIGHT | path-timed | | | | | | | 0 | 42 enemies |
| 10 | MOONWELL | | | 1.2 to 1.4 | | | | | 84 | |
| 11 | normal | 3.0 | 2.50 | 2.8 | 3 | 5 / 7 | 64 / 20 | 0.008 | 30 | Cinders |
| 12 | normal | 3.1 | 2.65 | 2.9 | 3 | 5 / 8 | 58 / 20 | 0.009 | 32 | Mirages |
| 13 | normal | 3.2 | 2.80 | 3.0 | 3 | 6 / 8 | 52 / 18 | 0.010 | 34 | Everything |
| 14 | STARLIGHT | path-timed | | | | | | | 0 | 48 enemies |
| 15 | PYRE | | | 1.3 to 2.0 | | | | | 96 | |

Dive gap gets +0 to 40 seeded jitter (v1 rule). DEEP SKY mult still adds +10% dive speed per level above 1 (v1 rule).

**Endless loop scaling** (L = 1 for stages 16 to 30, 2 for 31 to 45, ...):

| Value | Formula | Own cap |
|---|---|---|
| Bullet speed | x (1 + 0.06 L) | x 1.36 |
| Dive speed | x (1 + 0.05 L) | x 1.30 |
| Max divers | + L | 9 |
| Shots per dive | + floor(L / 2) | 4 |
| Dive gap | x 0.92^L | (global floor below) |
| Bullet cap | + 6 L | 96 |
| Boss HP (all parts) | x (1 + 0.25 L) | x 2.5 |
| Boss timeout | stays 5400 | |
| Score loop factor | 1 + 0.25 L | x 3 |

**Global limits, applied last, after every modifier (table, jitter, DEEP SKY, loop and heat), in every loop including loop 0:**

| Value | Floor | Ceiling |
|---|---|---|
| Enemy bullet speed | 1.0 | 3.6 |
| Dive speed | | 3.6 |
| Dive gap, full formation | 30 frames | |
| Dive gap, 8 or fewer left | 14 frames | |

**Heat (visible rank)**
| Event | Heat change |
|---|---|
| Clear a normal stage without dying | +2 |
| Kill a boss | +5 |
| Reach chain tier x4 | +1 (once per stage) |
| Holding a power-up at stage start | +1 |
| Death | -15 |
| Range | 0 to 100, start 0 |

Effect: bullet speed x (1 + heat x 0.002) (max +20%), dive gap - floor(heat x 0.3) frames, heat factor on kill points = 1 + heat / 200 (max x1.5). Global limits above still apply. Shown as a flame next to the lantern that grows in 5 steps. Music intensity input = heat / 100 (`setIntensity`).

**Bullet cap behavior:** when a new volley would push the on-screen enemy bullet count over the cap, the **whole volley waits** (no partial volleys). It retries every frame for up to 30 frames, then it is skipped. The attack's own timer keeps running, so a skipped volley never makes the next one come sooner. Deterministic, because it depends only on sim state. **Exception:** Moonwell's tide wall and Pyre's arc ring always spawn in full (never wait, never skip), so their gap always exists. Their bullets still count toward the cap, so other volleys wait for room.

**No-threading rule** (walls and rings): v1's hit test treats a bullet as a point and hits when abs(dx) < 3.5 and abs(dy) < 4.5 (B.9). Two neighboring bullets s units apart can be threaded only if s is at least 7 (ship width 7 + 2 x bullet collision radius 0). Walls and rings therefore space bullets **5 units apart** at the player's row (2 units of margin).

### B.6 Bosses

**Shared rules**
- Entrance 120 frames, invulnerable.
- Timeout after 5400 non-hit-stop frames (90 s). No kill bonus and no zone no-miss bonus on timeout.
- **Phase change:** all enemy bullets clear, 8 frames of hit-stop, then **20 frames with no new attacks**. Shake 6 and a popup.
- **Telegraphs:** every bullet-spawning event gets at least 20 frames of warning. Aimed volleys use an **aim-lock glow**: the source glows for 20 frames and the aim direction is locked at the start of the glow. Patterns that aren't aimed (rings, spirals, walls) show their source glow or guide lines for 20 to 30 frames.
- Bullet counts below are steady-state estimates (spawn rate x time on screen), checked against each boss's cap.

**ECLIPSE (Z1, rebalanced; beatable with the base shot and no wingmen)**

**B.10 (after a playtest: "fires far too much", only beaten with 2 KINDLEs):** the table below is the new target. Old values in brackets. Cap 40 becomes **26**. Steady-state estimates drop from about 27 / 31 / 24 to about **17 / 20 / 17**. Proof of "beatable without power-ups" comes from the balance bot (no power-ups, no wingmen, human-like reaction delay), and the base-shot bot test must still win.

v1 problems: the phase 2 spiral reached 69 bullets on screen; core 25 hp; no cap. All ECLIPSE bullets fly at 1.0 to 1.6.

| Phase | Trigger | Body | Attacks (speed) | Weak point | Telegraph | Bullets on screen (cap 26 [40]) |
|---|---|---|---|---|---|---|
| 1 Ring | start | 8 panels x 3 hp; ring spin 0.006 rad/frame (+0.002 per broken panel); sways x by 120 | Ring volley every 140 [100] frames: 8 [10] bullets, lower half only (1.1). Aimed 3-way every 90 [60] frames (1.6). 2 moths summoned every 420 [300] frames | Panels (1000 each) | Lead panel glows 20 frames before the ring; aim-lock glow 20 frames before the 3-way | ring 8 x 190/140 = 11; 3-way 3 x 125/90 = 4; moths about 2: **about 17** [27] |
| 2 Spiral | 4 panels broken | Ring spin +0.014 | 2-arm spiral, one bullet per arm every 16 [10] frames (1.1). Aimed 3-way every 120 [90] frames (1.6). No summons | Remaining panels | Spiral guide lines for 30 frames after the quiet period; aim-lock glow for the 3-way | spiral 2 x 136/16 = 17; 3-way 3 x 125/120 = 3: **about 20** [31] |
| 3 Core | 6 panels broken | Ring shrinks to 70%; sway slows to 60 | Aimed 5-way fan every 75 [50] frames (1.3). Slow ring of 8 every 200 [150] frames (1.0) | Core, 16 hp | Core aim-lock glow (white) for 20 frames before each fan; ring source glow 20 frames | fan 5 x 160/75 = 11; ring 8 x 150/200 = 6: **about 17** [24] |

How shots reach the core (phase 3): a shot that crosses the ring over a **broken** panel's sector passes through to the core; a shot over an **intact** panel hits that panel. At 6 broken panels, 6 of the 8 sectors are open and the 2 intact panels still block (and can still be broken for points). This is v1's hit rule, kept.

**MOONWELL (Z2): a glass bell with six hanging tendrils.** All bullets 1.2 to 1.4.

| Phase | Trigger | Body | Attacks (speed) | Weak point | Telegraph | Bullets on screen (cap 84) |
|---|---|---|---|---|---|---|
| 1 Tendrils | start | Bell at y = 70 drifts in a figure 8; 6 tendrils (chains of 7 dots) swing as pendulums | Each tendril tip drops a **bubble** every 70 frames: rises 20 units over 60 frames, then falls (1.2). Aimed pair every 80 frames (1.4) | Tendril tips, 6 hp each (800). Cut tendrils fall as harmless debris | Tip fills white over 20 frames before a bubble; aim-lock glow for the pair | bubbles 6 x 200/70 = 17; pairs 2 x 150/80 = 4: **about 21** |
| 2 Tide wall | all tendrils cut | Bell flips; its lens opens | **Tide wall** (spec below). Aimed pair every 90 frames (1.4) | Lens, 24 hp, **open only for the 60 frames after each wall spawns** (a closed lens deflects shots like a Prism face) | Gap glow 30 frames before each wall; aim-lock glow for the pair | one wall at most 71; pairs about 4: **about 75** |
| 3 Shatter | lens below 50% | Bell breaks into 3 shards orbiting the center (radius 50) | Each shard fires a slow ring of 6 every 90 frames, staggered by 30 (1.2). The last shard alive dives at the player once every 180 frames | Shards, 10 hp each | Shard glows 20 frames before its ring; diving shard flashes and wobbles 30 frames before diving | rings 3 x 6 x 170/90 = 34: **about 34** |

**Tide wall spec**
| Rule | Number |
|---|---|
| Bullets | one row at x = 5 + 5k for k = 0..78 (79 slots, 5 units apart, so it cannot be threaded; see the no-threading rule in B.5), minus every slot within 20 units of the gap center: 71 bullets |
| Gap | 40 units wide; with the 3.5 half-width hit test the ship's center has 33 units of safe space inside it |
| Gap center | within x 40 to 360, and **at most 160 units from the previous wall's gap center**; picked with the seeded RNG inside those limits |
| Spawn and speed | spawns at y = 100, falls at 1.2; reaches the player's row (y = 274) about 145 frames after spawn |
| One wall at a time | the next wall's 30-frame gap glow starts only when the previous wall passes y = 280; so a wall spawns every 180 frames and never overlaps another |
| Reachability | from passing one gap to the next wall reaching you takes 30 + 145 = 175 frames. Even with HALO (2.3 units/frame) you can move 402 units; the 160-unit limit uses under 40% of that, leaving room to dodge the aimed pairs |
| Cap | walls always spawn in full (B.5 exception) and count toward the 84 cap; worst case 71 + about 4 from pairs = 75 fits |

**PYRE (Z3): a hollow sun with a crown of flare petals.** All bullets 1.3 to 2.0.

| Phase | Trigger | Body | Attacks (speed) | Weak point | Telegraph | Bullets on screen (cap 96) |
|---|---|---|---|---|---|---|
| 1 Corona | start | Ring of 12 petals around a dark core, slow rotation | Every 90 frames one petal detaches and dives like an enemy (dive speed 2.4, 2 aimed shots at 1.8). Aimed 3-way every 70 frames (1.8) | Petals 4 hp each; **attached petal kill = 600 base, detached = 300 base** | Petal brightens and wobbles 40 frames before detaching; aim-lock glow 20 frames for every aimed shot | petal shots about 3; 3-way 3 x 110/70 = 5: **about 8** |
| 2 Breath | 6 petals gone | The remaining 6 petals stay attached and stop detaching. The sun stops swaying and holds at y = 88. It alternates **inhale** (150 frames) and **exhale** (90 frames) | Inhale: one **arc ring** at inhale start (spec below) and the shot pull. Exhale: radial burst of 16 (1.5) | Core, 30 hp, **hittable only during exhale** | Core glows rose 20 frames before exhale; gap marker shown 20 frames before each ring | ring 72 + burst 16 + a few ring stragglers: **peak about 90** |
| 3 Collapse | core below 40% | Sun shrinks to 60%, moves faster (sway 140); the remaining petals detach together at phase start | 3-arm spiral, one bullet per arm every 9 frames (1.3). Aimed 5-way every 60 frames (2.0) | Core, 12 hp, always open | Spiral guide lines 30 frames after the quiet period; aim-lock glow for the 5-way; the star field reverses direction (cosmetic cue) | spiral 3 x 154/9 = 51; 5-way 5 x 100/60 = 8: **about 59** |

**Pyre arc ring spec (phase 2)**
| Rule | Number |
|---|---|
| Shape | the arc is built from the player's row (y = 274, 186 units below the core). Bullet k aims at the point (x = 5k, y = 274) for k = 0..80, so 81 slots that cross the player's row **5 units apart** (no-threading rule, B.5). All fly outward at the same speed, so together they form an arc. Along the arc, neighbors are at most 5 units apart when they cross the row |
| Gap | slots whose row point is within 24 units of the gap x are removed (about 9): about 72 bullets. The gap is about 48 units wide at the player's row |
| Expansion | radius starts at 14 and grows 1.4 units/frame; reaches the player's row in 123 frames (straight down) up to about 242 frames (far corners) |
| Gap marker | a gold dot sweeps along the player's row at 1.2 units/frame, bouncing between x = 30 and 370; the gap is **locked at the marker's x when the ring spawns** |
| Reachability | if the locked gap is more than 200 units from the player's x at spawn, it is moved toward the player until it is 200 units away. Worst case 200 units in 123 frames = 1.63 units/frame, under 75% of HALO speed (2.3) |
| Cap | the ring always spawns in full (B.5 exception) and counts toward the 96 cap |
| Shot pull (inhale only) | each player shot gets a sideways acceleration of 0.03 units/frame² toward the core's x, with sideways speed capped at 1.2 units/frame; vertical speed is unchanged. Exhale removes the pull (sideways speed decays x0.8 per frame) |

### B.7 Modes

| | Daily Flight | Free Play |
|---|---|---|
| Seed | `dailySeed('YYYY-MM-DD')`, UTC date when the run starts | Random seed picked outside the sim (main.js), stored in the replay |
| Ranked attempt | The **first started** run of the UTC day. "Started" = the first gameplay frame of stage 1. Quitting, closing the tab or crashing still counts as that day's attempt. Later runs that day are "practice" and go nowhere | Every run |
| Boards | daily (by dayKey) + all-time + season | all-time + season |
| Trophies | Yes (leaderboard ranking) | Yes |
| Replay | Required, attached to the score | Required |
| Rules | Identical game rules in both modes. Game version is in the replay header; a replay from another version is shown but not ranked | |

How the attempt is tracked: main.js writes `daily-attempt:<dayKey>` to storage on the first gameplay frame of stage 1. **This is bypassable locally** (clear storage or use a private window). Accepted for a local-only game; a backend later can enforce it with a server-issued attempt token.

Why first-started-only: Spelunky's daily got its fairness from one shot per seed. Locally we can't stop practice, so practice is allowed but unranked.

**Attract mode:** after 30 s idle on the title, play the best all-time replay **whose game version matches the running game**, re-simulated live, with a banner "BEST FLIGHT: <name> <score>". If no replay matches, play the bundled demo replay. The demo replay is **regenerated (tools script) whenever the game version changes**; if its version doesn't match either, attract mode shows only the high-score table. Alternate with the high-score table every 20 s.

Name entry: 1 to 10 chars, A-Z 0-9 space . - (matches leaderboard validation).

### B.8 Music direction (Web Audio terms)

These match the tracks built in `games/starfall/music.js` (`engine/audio.js` voices: pulse with duty via PeriodicWave, triangle, filtered noise, FM bell; lookahead scheduling per https://web.dev/articles/audio-scheduling). Every tempo is a whole number of frames per beat.

| Track | BPM (frames/beat) | Key / meter | Mood | Instrumentation direction | Intensity layers (`setIntensity`) |
|---|---|---|---|---|---|
| title | 90 (40) | A minor | Inviting, a little wistful | FM bell melody, triangle bass, soft noise brush | none |
| z1 Lantern Reach | 120 (30) | F major | Hopeful, teaching | Pulse 25% lead, pulse 50% harmony, triangle bass, noise hat on 8ths (15 frames) | added as heat rises |
| z2 Glass Tide | 144 (25) | E dorian, 7/8 | Cool, flowing | FM bell arps, triangle bass with slides, bandpass noise "surf", pulse 12.5% counter-line | added as heat rises |
| z3 Hollow Sun | 180 (20) | D minor | Urgent, hot | Two detuned pulse 12.5% leads, triangle bass in 8ths (10 frames), noise kick/snare | added as heat rises |
| boss1 Eclipse | 100 (36) | C minor, half-time feel | Ominous, steady | Low pulse ostinato, FM bell stabs on phase change | added per phase |
| boss2 Moonwell | 150 (24) | F# minor, 5/4 | Eerie, swelling | Wide FM bells, slow-vibrato triangle, noise wash | added per phase |
| boss3 Pyre | 200 (18) | C# minor | Final, furious | Two pulse leads, triangle bass, noise drums | added per phase; inhale filters down, exhale opens |
| bonus (STARLIGHT, every zone) | 144 (25) | G major | Bouncy, playful | Pulse lead **plays only on on-beat kills**; backing keeps time | n/a |
| endless | 150 (24) | G minor | Relentless | Z3 palette plus FM bell | heat |
| lobby | 72 (50) | | Quiet arcade-floor ambience | | |

Jingles: stageClear, bossDefeat, gameOver, extraLife, nameEntry.

**Odd meters and whole frames:**
- The sim uses only beats, and every beat is a whole number of frames. **Bar lines are audio-only.**
- z2 counts 144 BPM as quarter notes: one beat = 25 frames. Its 7/8 bar (87.5 frames) and its 8th notes (12.5 frames) are audio-only.
- boss2 is 5/4 at 150: beat 24 frames. The bar is audio-only too.
- Anything finer than the beat (8ths, 16ths, ornaments) is audio-only and never needs to be a whole number of frames.

**Beat sync rules:**
1. The sim owns the beat: `beat = floor(stageFrames / framesPerBeat)`, where the stage frame counter is the one used for gameplay. STARLIGHT has no hit-stop, so its beat clock never pauses.
2. Audio follows the sim. main.js starts a track on the sim's beat-0 frame. Every 4 sim beats it compares the audio clock with the sim's beat time and **re-anchors the next 4-beat block** to the sim, so drift never builds up. (It uses sim beats, not bar lines, because bar lines are audio-only and z2's bar isn't a whole number of frames.)
3. Visual beat pulses (Z3 sun ring, STARLIGHT HUD) come from the sim beat, not the audio clock.
4. The sim never reads audio time.

New SFX names needed (beyond the first audio list): `chainTick` (pitch +1 semitone per 5 chain), `chainBreak`, `grazeTick`, `powerup`, `powerdown`, `glyphCycle`, `interrupt`, `unspooled`, `phraseComplete`, `phraseInTune`.

### B.9 Feel

**Hit-stop** (sim frames). Hard cap: hit-stop never stacks above 8.

During hit-stop:
- Every gameplay timer is frozen: movement, chain window, power-up timers, glyph cycle, boss attack timers, boss timeout, the fight-frame count for the boss kill bonus, heat events, and the dive timer.
- The replay frame counter still advances and inputs are still recorded (and ignored), so replays stay exact.
- STARLIGHT has no hit-stop at all.

| Event | Hit-stop | Shake (units) |
|---|---|---|
| Normal kill | 0 | 0 |
| Close kill | 1 | 1 |
| Warden / Prism / Mirage kill | 3 | 3 |
| Interrupt | 4 | 3 |
| Boss piece destroyed | 3 | 4 |
| Boss phase change | 8 (then 20 quiet frames, B.6) | 6 |
| Boss death | 8 | 8 |
| Wingman lost | 2 | 3 |
| Player death | 5 | 7 |

Shake decays x0.82 per frame, max 8. It's a render effect driven by the sim event value and never moves sim objects.

**Boss death sequence:** the sim enters a 60-frame `bossOut` state. All enemy bullets are cleared, nothing can hurt the player, and no score is possible. The render plays the explosion particles at half speed (cosmetic slow-mo; the sim runs at normal speed).

**Bullet readability rules**
1. Enemy bullets are always round: a white core of radius 1.1 plus a halo of radius 2.2 in the zone's halo color (B.3). Nothing else in the game uses a white-core round dot.
2. Player shots are always vertical 3-dot streaks (v1 look), amber to white. Wingman and ECHO shots look the same at 70% alpha.
3. Draw order (bottom to top): stars, particles, enemies, player shots, enemy bullets, player, HUD.
4. Particles and debris: alpha at most 0.7, never white-core. Stars at most 0.5 brightness.
5. No enemy bullet spawns within 48 units of the player (this includes Cinder embers). Enemy bullet speed always stays between 1.0 and 3.6 (B.5 global limits). One named exception: the MOONWELL bubble's slow rise (20 units over 60 frames, B.6) is below 1.0, because the rise is the tell.
6. Collision radii, from v1 `starfall.html` (kept):

   | Test | Hit when |
   |---|---|
   | Enemy bullet vs player | abs(dx) < 3.5 and abs(dy) < 4.5 (bullet center vs ship center; the bullet is a point, collision radius 0) |
   | Enemy bullet vs wingman | abs(dx) < 4.5 and abs(dy) < 5 |
   | Enemy body vs player or wingman | abs(dx) < 7 and abs(dy) < 7 |

   So the ship is 7 units wide and 9 tall for bullets. The 2.2 halo is visual only. Graze counts between this box and 7 units. When HALO is up, the ring shows the absorb radius.
7. Graze sparks are small cyan dots on the player's side, so a graze reads as safe.
8. Every rule must hold with the CRT on and off (check screenshots with both).

**Telegraph rules (all enemies, not only bosses)**
| Source | Telegraph |
|---|---|
| Normal dive | diver glows 20 frames before leaving the formation |
| Warden dive | glows 30 frames (this is the Interrupt window) |
| Any aimed shot (dive shots, path fire, boss aimed volleys) | aim-lock glow 20 frames; aim locked at glow start. In Z1 and for boss volleys the shot flies at **where the player was 20 frames earlier** (moving during the glow dodges it). From Z2, enemy dive shots and path fire add **lead aim** (B.11 2.1): the locked point is moved ahead along the ship's motion at glow start, up to 72 units. Path fire: when the per-frame chance triggers, the 20-frame glow starts and the shot fires at its end |
| Boss rings, spirals, walls | source glow or guide lines 20 to 30 frames (B.6) |
| Boss phase change | bullets clear + 8 hit-stop + 20 quiet frames |

### B.11 Variety

**Why:** A playtest: "by stage 5 it gets boring: needs more power-up variety, systems, enemy variety, movement and smarter enemies." Rule for this section: **from stage 2 on, every stage adds one thing the stage before it did not have**, and the first run-shaping choice comes right after stage 5. Everything is fixed per stage (learnable). Numbers are first guesses: the balance bot and playtests tune them, and tuning changes a number, never a rule. No B.11 rule touches a boss fight, so ECLIPSE stays exactly as B.10 left it (cap 26, 900-frame power-ups, 1 wingman for 600 frames).

**Stages 1 to 5: what is new in each**

| Stage | New this stage (not in the stage before) | Where |
|---|---|---|
| 1 | The base game: moths, wisps, Wardens on v1 entry paths; KINDLE | B.0, B.1 |
| 2 | **Weave**: the two front rows slide past each other every 8 s (they slide from the moment they arrive, about 10 to 15 s in). Also new: 4 splitters, the Lamplighter and its glyph (now 5 types, with the new **REED**), the DEEP SKY comet | 1.0, 4.0, B.2, B.3 |
| 3 | **Pincer** (every 3rd dive launch can be a mirrored pair) and **Hunt** (stand still 2.5 s and the nearest enemy comes for you). Also 6 splitters and faster dives (B.5) | 1.1, 2.2 |
| 4 | STARLIGHT: the rhythm stage, 36 enemies in 6 phrases, no enemy fire | B.4 |
| 5 | ECLIPSE, the first boss; after it, the first **Charm card** | B.6, 5 |

**0. Shared rules for everything in B.11**

| # | Rule | Detail |
|---|---|---|
| 0.1 | Twist clock | `S.twistT` counts frames in the `play` state with the ship alive. It is a field of the twist system (`sim/twists.js`). At the start of that system's `step()`, if `S.state === 'play'` and the ship is alive, `twistT++`; then, in this order, the Undertow pull (1.3), Thermals (1.5) and Pressing sky ticks (1.4) run with the new value. So the first play frame of a stage ends with `twistT === 1`. Everything in the next frame (`slot()`, dive picks, aim) reads that value. Hit-stop skips the whole step, so it freezes. It does not run in intro, dying, ready, clear, bossOut, bonusEnd or charm. The 'stage' event resets it to 0. It is **not** `formT`, which also runs in dying and ready. "At `twistT` N" in a Verify line means "after the frame whose step made `twistT` equal N" |
| 0.2 | Randomness | `rnd` means the shared run stream `S.rnd`, used only where named. Things that must be the same for every player on a seed (glyph start, charm offer) use their own preallocated `Rng`, re-seeded with `rng.seed(...)` (no allocation) |
| 0.3 | Purity, hash | Sim only, `engine/dmath.js` for sin, cos and hypot, no `Math.random`, no `Date`, no per-frame allocation. Pools and typed arrays are made once in a system's `init`. Every new piece of state is mixed into `stateHash` through its owning system's `hash(S, u32, f64)`, never by editing the `stateHash` body in `sim.js` (that would change every old hash). New per-enemy fields (`hunt`, `pin`, `press`, `aimV`) are mixed by the twist system for every live enemy; the bullet field `th` by the twist system for every live bullet |
| 0.4 | Clamps | The ship's position and every point that aims at the ship (lead aim point, Hound target) use x 10..390, the ship's own clamp. Enemy dive paths keep v1's clamps (`startDive`: ship x clamped to 40..360, control points to 8..392); B.11 does not change them. So a Pincer mirror path is the exact mirror only while both paths stay inside those clamps; near an edge it is the clamped path |
| 0.5 | Practice mode `charmK` | New mode string `charmK` (K = 0, 1, 2, ...): the run starts at stage `5K + 6` in the `'charm'` state with boss index K, no charms taken. It is a practice mode (never submitted, like `stageN`), not tainted, and exists so replay-proof and tests can reach the card without killing a boss. Old mode strings parse as before |
| 0.6 | Limits | B.5 global limits apply last (enemy bullet vy 1.0 to 3.6, dive at most 3.6). B.9 telegraphs unchanged unless stated. New bullets follow the volley-waits rule and count toward the stage cap |
| 0.7 | Endless | Stage s uses row `((s-1) % 15) + 1`: that row's lever, enemies and zone rules (lead k, glyph cycle) |

**1. Stage levers**

| Stage row | Lever | What the player learns |
|---|---|---|
| 2 | **Weave** (1.0) | The enemy in your lane keeps changing: time your shots |
| 3 | **Pincer** (1.1); **Hunt** starts (2.2) | Mirrored pairs close a box around your lane; standing still gets you targeted |
| 5 (after the boss) | **First Charm card** (5) | A run-shaping pick |
| 6 | **Tetherling** (3.1); **lead aim** from Z2 (2.1) | Cut linked pairs; aimed shots land ahead of you |
| 7 | **Parting** (1.2) | A timed lane opens through the middle |
| 8 | **Undertow** (1.3) | A current drags the ship |
| 11 | **Pressing sky** (1.4) | Clear whole rows to push the formation back |
| 12 | **Thermals** (1.5) | Find the columns where bullets slow |
| 13 | **Hounds** (3.2) | Enemies that follow where you were |

The row-to-lever table lives in `sim/twists.js`. Wheel (old stage 12) stays dropped.

**1.0 Weave (stage row 2)**
- `wv = 24 * sin(twistT * 0.0131)`: -24 to +24 units, one cycle every 480 frames (8 s); first full swing at `twistT` 120 (2 s).
- In `slot()`: row 3 x `+= wv`, row 4 x `-= wv`. Rows 0 to 2 do not move. At the extremes the two rows are offset by 48 units (2 slot gaps) from each other. Widest point: row 4 spans 200 +- 151, inside 10..390.
- Enemies joining a weaving row fly to the moving slot (v1 `join` already follows `slot()`). A diver leaves from where its slot is at dive start.
- Hash: `twistT` (everything else is derived).
- Noticed in the first 20 s: rows 3 and 4 enter in groups 4 and 5 (delays 525 and 690 frames) and join slots that are already sliding, so by about 15 s the two bottom rows visibly slide past each other.
- Counter-play: fire just before a row slides into your lane; follow one enemy as it slides.
- Own answer: genre formations breathe or march as one block; ours has its front rows slide past each other like a loom, so the target in your lane changes and you learn to time shots, not only aim them.
- Verify: Node, stage 2, `formT` fixed, `twistT = 120`: row 3 slot x minus the slot x at `twistT = 0` is +24 (within 0.01) and row 4 is -24; rows 0 to 2 are unchanged; stage 1 and stage 3 slots are unchanged at any `twistT`.

**1.1 Pincer (stage row 3)**
- `S.pincerN` counts dive launches (every `pickDiver` call that starts a telegraph), +1 per launch.
- On a launch where `pincerN % 3 === 0`, the launch is a pincer if all of these hold: the picked diver is a moth, wisp or splitter; its **mirror slot** (same row r, column `ROWS[r] - 1 - c`) holds a live enemy in `'form'` that is also a moth, wisp or splitter (never a Warden, Lamplighter, Eel or Tetherling); and live divers + 2 is at most `maxDivers(n)`. Otherwise it is a normal dive and the counter still advances.
- Both start the 20-frame dive telegraph (`TELE_DIVE`) on the same frame. The diver dives with `(side, offx 0)`, `side = e.x < 200 ? -1 : 1`; the mirror dives with `(-side, 0)` (see 0.4 for edges).
- **One shot per pincer:** enemy field `pin` (0 none, 1 diver, 2 mirror) is set at the telegraph. `startDive` draws `diveShots` as usual (so the shared stream is used the same way), then sets `shots = 1` when `pin === 1` and `shots = 0` when `pin === 2`, and clears `pin`. The pair counts as 2 divers.
- Hash: `pincerN`; every live enemy's `pin` (0.3).
- Counter-play: break one side early and slip out through it.
- Own answer: classic mirrored double dives double the fire; ours closes a box around your lane with one shot between both enemies, so the skill is choosing which side to break.
- Verify: Node, stage 3, formation full: launches 1 and 2 each start one telegraph (plus escorts for a Warden). Launch 3 with an eligible mirror starts exactly 2 telegraphs: same r, columns c and `ROWS[r]-1-c`, opposite `teleSide`; after both dives start their `shots` sum to 1 and both `pin` are 0. With the mirror slot dead, launch 3 starts 1 telegraph.

**1.2 Parting (stage row 7)**
- `off = 22 * (1 - cos(twistT * 0.0105))`: 0 to 44 units, one cycle every 598 frames.
- In `slot()`, every row: columns `c < n/2` move by `-off`, columns `c >= n/2` by `+off` (all rows have an even count). The **added** separation between the two middle columns of a row is `2 * off` (88 at most), on top of the Z2 sway and breathe.
- **Inner-column weight:** the random dive pick gives each candidate in columns `n/2 - 2` to `n/2 + 1` weight 2 and every other candidate weight 1. One `rnd()` call picks over the total weight, candidates in `enemies` order. Eel ribbons pick their own dives (eel.js) and are unchanged.
- Hash: `twistT`.
- Counter-play: fire up the open lane, but watch its edges: that is where divers come from.
- Own answer: a formation that opens a timed firing lane whose edges are the danger, so the opening is both the chance and the trap.
- Verify: Node, stage 7, `twistT = 299`: for row 0, slot x of columns 1 and 2 minus the slot x at the same `formT` with `twistT = 0` is exactly `-off` and `+off`, and `off` is within 0.01 of 44. A unit test feeds the weighted pick fixed `rnd` values and checks each inner candidate owns twice the range of an outer one.

**1.3 Undertow (stage row 8, answers "movement")**
- Cycle of 400 `twistT` frames. Phase `p = twistT % 400`.
- Telegraph `p` 280 to 309 (30 frames): the Z2 caustic bands brighten and flow toward the pull side (twist render layer).
- Pull `p` 310 to 399 (90 frames): `player.x = clamp(player.x + 0.4 * d, 10, 390)`, `d = +1` when `floor(twistT / 400)` is even, `-1` when odd (the first pull goes right).
- **Order:** the pull runs in the twist step (0.1), so it comes after this frame's ship move, shots, collisions and graze; the pulled x is what the next frame starts from, what the Hound ring records (3.2, the hound system runs after the twist system) and what Hunt measures (2.2). `player.px` is not touched, so the render interpolates the pull smoothly.
- Against the pull at full speed the ship still moves 2.3 per frame (HALO 1.9). Unresisted drift: 36 units per pull. Wingmen follow the ship as usual. Bullets, enemies and glyphs are not pulled.
- Hash: `twistT`.
- Counter-play: steer into it, or ride it to cross the field fast. A ship that rides it leaves the Hunt band, so drifting is also a way to avoid being hunted.
- Own answer: a sea current on the ship, announced by the sky and alternating, so movement itself becomes something to plan.
- Verify: Node, stage 8, ship idle at x 200 from `twistT` 0: x is 200 at `twistT` 309 and `200 + 0.4 x 90 = 236` at 399 (within 1e-9); x is back at 200 at 799.

**1.4 Pressing sky (stage row 11; stronger, and fixed for splitters and fire)**
- `press` grows by 1 on every twist step where `twistT % 20 === 0`, at most **48**. Max is reached at `twistT` 960 (16 s of a 70 s stage). `slot()` adds `press` to every slot's y, so the bottom row moves from about y 98 to about 146.
- **Row lift:** the first time this stage that row r (0 to 4) has no live enemy with `e.r === r` (any state), `lift += 16`. Each twist step while `lift > 0`: `d = min(0.4, lift, press)`, `press -= d`, `lift -= d`; if `press` reaches 0 the rest of `lift` is dropped. So a lift is eased over 40 frames. Each row lifts once per stage (5-bit mask).
- **Splitters and dive fire:** enemy field `press` is set to `S.press` when a dive starts (`startDive`), 0 otherwise. Every dive y line in `sim.js` moves down by it: a splitter splits when `e.y > H * 0.47 + e.press` (so it still splits at least 36 units below the slot it left, as in every other stage), and a diver may start an aimed shot only while `H * 0.28 + e.press < e.y < min(H * 0.69 + e.press, H - 74)` (the upper bound never comes within 48 units of the ship's row, B.9 rule 5). The band is shorter when pressed (94 units instead of 123 at press 48), so the first shot's countdown at dive start is `max(6, 15 + rnd() * 40 - e.press / 2)` (same single `rnd()` draw as v1). With `press` 0 every one of these is the v1 rule, so no other stage changes.
- Hash: `press`, `lift`, the row mask; every live enemy's `press` (0.3).
- Counter-play: finish whole rows to push it back up.
- Own answer: a descending formation is a genre staple; ours is a clock you push back by finishing whole rows, so it rewards row-focused fire, and it never lands or ends the run.
- Verify: Node, stage 11, no fire: `press` is 48 at `twistT` 960 and still 48 at 3600; row 4's slot y at `twistT` 960 minus at `twistT` 0 (same `formT`) is 48. Killing every row-0 enemy by test: `lift` is 0 again 40 frames later and `press` equals the value before minus 16 plus the ticks in those 40 frames (2).
- **Feel check (one line):** Node, seeds 1 to 3, stage 11, god, ship idle at x 200, 3600 frames: aimed shots per dive with Pressing sky on are at least 85% of the same runs with `S.pressMax = 0` (a test-only field read by the twist system), and no splitter splits less than 36 units below its dive start y.

**1.5 Thermals (stage row 12, replaces Wheel)**
- Two columns 24 wide. Centers `cx0 = 200 + 120 * sin(twistT * 0.004)` and `cx1 = 200 - 120 * sin(twistT * 0.004)`: they drift at most 0.48 units per frame, cross at the middle, period 1571 frames.
- In the twist step: an enemy bullet that is inside a column (`abs(b.x - cx) < 12` for either) and has `th === 0` gets its velocity multiplied by `f = max(0.6, 1.0 / s)`, `s = hypot(vx, vy)` (`f = 1` when `s <= 1.0`), and `th = f`. A bullet with `th > 0` that is in neither column gets its velocity divided by `th` and `th = 0`. So a slowed bullet never drops below 1.0 (B.5 floor). A column that moves over a bullet counts as entering. `takeBullet` resets `th` to 0.
- Player shots are not slowed. Grazing works as usual.
- Render: each column is two thin dotted edge lines, alpha at most 0.25, dots rising slowly. Not a grid (the zones-no-grid rule holds).
- Hash: `twistT`; `th` of every live bullet (0.3).
- Counter-play: drift with a column; bullets inside it are slower and easier to read.
- Own answer: instead of a hazard to avoid, the stage gives you safe air to chase.
- Verify: Node, stage 12, `twistT` pinned: a bullet with vx 0, vy 2.9 placed at `cx0` has vy 1.74 after one frame and 2.9 again (within 1e-9) the frame after it leaves; a bullet at speed 1.4 slows to exactly 1.0.

**2. Smarter enemies**

**2.1 Lead aim (Z1 k = 0, Z2 k = 0.5, Z3 k = 0.75; stronger)**
- Applies to enemy aimed shots started by `startAim` (dive shots and path fire). Never to boss volleys, Hound shots (3.2) or shots a type's `aim` hook retargets.
- At lock (`startAim`, the start of the 20-frame glow, `TELE_AIM`): `T = max(20, (player.y - e.y) / bulletSpd())`, using `e.y` and `bulletSpd()` at lock (heat and B.5 limits included). `lead = clamp(player.vx * (TELE_AIM + T) * k, -72, 72)`. `aimX = clamp(player.x + lead, 10, 390)`, `aimY = player.y`.
- **Lead shots may angle more:** enemy field `aimV` is the shot's sideways speed limit. `startAim` sets it to 1.2 (v1) before the lead hook runs; the lead sets it to **1.6** when `lead !== 0`. `eFireAimed` clamps vx to `+-aimV` instead of a fixed 1.2. B.5 limits still apply to the bullet's vy as today.
- `player.vx` is the ship's own smoothed speed (v1, max 2.7, HALO 2.3). No ring buffer.
- Order: the lead is set first, then `e.T.aim` runs. When it retargets (the Z2 Wisp's `huntAim` picks a wingman), its target wins and `aimV` goes back to 1.2.
- **What it really does:** it puts the shot up to 72 units ahead of you on your line of travel. A steady full-speed run beats it (in 72 frames the ship moves about 190 units), and so does reversing. It catches the run that stops 50 to 90 units ahead of where you were at lock. A still ship has no lead.
- Hash: every live enemy's `aimV` (0.3); the bullet's velocity is already hashed.
- Counter-play: commit: keep moving, or turn back; do not stop just ahead of where you were.
- Own answer: Galaxian's aliens react to the player; ours read your direction at the glow and aim at your stopping point, while the glow still tells you it is coming.
- Verify (pinned): Node, stage 6 (k 0.5), heat 0, one enemy pinned in `'form'` at (200, 150), `player.x = 150`, `player.vx = 2.0`: `S.startAim(e)` gives `aimX = clamp(150 + clamp(2.0 * (20 + T) * 0.5, -72, 72), 10, 390)` with `T = max(20, 124 / S.bulletSpd())`, to 1e-9, and `aimV === 1.6`. Then `S.fireAim(e)`: `vx = clamp((aimX - 200) / max(20, 124 / sp), -1.6, 1.6)`. Stage 1: `aimX === 150`, `aimV === 1.2`. Z2 Wisp with a wingman out: `aimX` is the wingman's x and `aimV === 1.2`.
- **Feel check (one line):** same enemy, ship at x 200 with `player.vx = 2.7`: the shot crosses y 274 at least 60 units right of x 200 in stage 6 (72) and stage 11 (about 71); with k 0 it crosses at 200.

**2.2 Hunt (stage 3 and later, every zone; triggers more)**
- `huntC` (band center) and `huntN` (count). Each twist step: if `abs(player.x - huntC) > 24`, then `huntC = player.x`, `huntN = 0`; else `huntN++`. At stage start `huntC = player.x`, `huntN = 0`.
- When `huntN >= 150` (2.5 s), the next dive launch is a **Hunt**: the target is the `'form'` enemy with the smallest `abs(e.x - player.x)`; ties go to the larger r (nearer the ship), then the smaller c. It replaces the random pick for that launch only; a Warden target still gets its 30-frame glow and escorts. After a Hunt launch `huntN = 0`, `huntC = player.x`.
- In stage 3, a launch that is both a Hunt and a pincer launch (1.1) uses the Hunt target as the diver.
- Cue (twist render layer, on top of the normal glow): red dots over the glow **and** a ring of 8 dots (radius 10) that blinks 4 frames on, 4 off, for the whole telegraph (works without colour). Enemy field `hunt` marks it; `pickDiver` sets it on every launch (true or false). SFX `hunt` on the launch.
- Hash: `huntC`, `huntN`; every live enemy's `hunt` (0.3).
- Counter-play: standing still gets you hunted: drift.
- Own answer: enemies that answer camping, with a visible ringed tell and a reset, so it pushes movement without feeling random.
- Verify: Node, stage 3, ship held still: once `huntN` reaches 150, the next launch's diver matches the nearest rule and `huntN` is 0 after it; with the ship still from the first play frame, a Hunt launch happens within 150 + 135 frames after `formFull` (135 = stage 3's longest dive gap, 95 + 40 jitter). A run that moves 30 units every 120 frames never starts a Hunt in 3000 frames.

**2.3 Wingman hunting (Z2+):** unchanged (B.3).

**3. New enemies** (original designs, dots only)

**3.1 Tetherling (stages 6, 7, 8)**
- HP 1 each, 150 / 350 each. Always a pair in neighbouring slots of one row, and both slots are consecutive members of **one entry group**, so they enter together.
- Slots: stage 6: row 4, columns 2+3 and 6+7 (group TL). Stages 7 and 8: row 2, columns 0+1 and 6+7 (group SR; row 4 is Eels there). None of these overlap other mix slots (B.3 and `sim/stages.js`) and no pair straddles Parting's split. Stage 13 has none.
- **Launch:** in the tether system's step (same frame as the pick, since systems step after `updFormation`): a Tetherling in `'tele'` whose partner is live in `'form'` puts the partner in `'tele'` with the same telegraph count and side. The left member gets `offx -15`, the right `+15`. If live divers + 1 is more than `maxDivers(n)`, both go back to `'form'` and that dive cycle passes, like an Eel ribbon that does not fit. If the partner is gone or not in `'form'`, the pick dives alone with no line.
- Spacing: the two dive paths' control points from the 6th on (y 159 and below) are exactly 30 apart in x; before that the gap is the slot gap, 24 to 28.
- **Line timeline by y** (ym = mean y of the pair): in formation and early in the dive a faint harmless line. **Blink** starts on the first frame `ym >= 130` and lasts 30 frames, harmless. **Solid** from then until `ym > 290`, or either member leaves the screen or dies. Then it is gone for that dive.
- Line hit: during Solid, take the point P on the segment between the two centers nearest the ship's center; the ship is hit when `abs(P.x - x) < 3.5` and `abs(P.y - y) < 4.5` (the bullet-point rule, B.9). HALO absorbs a touch as one bullet (one charge), then the line ignores the ship for 30 frames. Wingmen and the MIRROR ghost ignore the line. The line never grazes.
- Spawn distance: B.9 rule 5 (48 units) does not apply, because the line is not a bullet. Its warning is the blink, which starts at y 130, 144 units above the ship's row.
- **Break:** kill one during the dive (shot, ARC jump or KINDLE) and the line breaks (SFX `snap`, `FX_TETHER`); the other leaves its path and flies straight down at `limitDive(1.5 * diveSpd())` (at most 3.6 after every modifier), x fixed, then re-enters from the top and joins its slot like any diver. Kill one in formation and the other is a plain single diver.
- **CUT:** both killed within 30 frames of each other: +1000 flat, popup `POP_CUT` ("CUT"), SFX `cut`.
- Hash: per pair (2 per stage, preallocated): line phase, phase frames, HALO ignore frames, CUT frames.
- Counter-play: kill one before the line lights, or slip past the ends.
- Own answer: a linked pair whose hazard is the gap between them, telegraphed by a blink and only dangerous mid-dive.
- Verify: Node, stage 6: `types` includes `tether` once the formation is full. Forcing a pick on a Tetherling starts 2 telegraphs with `offx` -15 and +15. The line phase is 0 while `ym < 130`, 1 for exactly 30 frames from the first `ym >= 130`, then 2 until `ym > 290`. A ship on the segment's midpoint dies only in phase 2. With HALO it loses one charge and is ignored for 30 frames. After a break, the survivor's speed is `min(3.6, 1.5 * diveSpd())`.

**3.2 Hound (stage row 13)**
- **Trigger** (in the hound system): `N0` = `enemies.length` on the stage's first play frame. On the first frame the live count is at most `floor(N0 / 2)`, 2 Hounds enter. Once per stage.
- Hounds live in the hound system's own pool of 2, **not** in `enemies`. So they never block the stage clear, never count in `n` or in divers, and KINDLE, ARC and Hunt never touch them. When the stage clears, live Hounds are removed (no points).
- **States** (`st` per Hound, `f` = frames in the state):

| st | Name | What happens | Next |
|---|---|---|---|
| 0 | off | not drawn, not hit | 1 when triggered (Hound 1 waits 60 frames in 0 first) |
| 1 | enter | straight down at 1.2 from (20, -10) or (380, -10) | 2 on reaching y 190 |
| 2 | shadow | moves toward `tx` at up to 1.2 per frame | 3 when the fire rule holds; 5 when its life reaches 600 |
| 3 | glow | 20-frame aim-lock glow, x frozen | 4 when the first bullet fires (or 2 if the volley wait runs out) |
| 4 | second | x frozen, 8 frames, then the second bullet | 2, cooldown 70 |
| 5 | leave | up at 1.2, no points | 0 when y < -10 |

- Every Hound timer (f, life, cooldown) counts twist steps only, so a Hound freezes in place while the ship is dead and during hit-stop. Its bullets already in flight keep moving.
- **Shadow:** `tx` is the ship's x 30 twist steps ago (a preallocated 32-slot ring of ship x, written each twist step after the Undertow pull, filled with the ship's x at stage start), clamped to 10..390. If the two Hounds are within 16 units, the later one holds its x that frame. The highest y a Hound reaches is 200, so its body never meets the ship (y 274).
- **Fire rule:** state 2, `abs(x - tx) < 3`, cooldown 0. Bullets: straight down at 2.2 from the Hound's x, the second **8 frames after the first in the same column**. The pair is one 2-bullet volley: the first bullet needs `volleyOk(2)`; with no room it waits up to 30 frames, then the volley is skipped; the second always follows once the first fired.
- Life: 600 twist steps from entering state 1; checked only in state 2.
- Damage: a player shot inside `abs(dx) < 7`, `abs(dy) < 7` is used up (LANCE and FAN shots too, no pierce), `S.hits++`. 3 hp. Kill: `S.pieceKill(800)` (kill points with all multipliers, chain +1, window 90), feel `big`.
- Hash: per Hound: st, f, x, y, hp, life, cooldown, volley wait; the ring and its index; trigger flag; `N0`.
- Counter-play: keep moving so it chases your past, then turn and shoot up at it.
- Own answer: an enemy that stalks where you were, not where you are, so your own movement history is the threat.
- Verify: Node, stage 13, god mode: no Hound before the live count reaches `floor(N0 / 2)`; exactly 2 per stage; the highest y any Hound reaches is at most 200; every state change follows the table; the stage clears with a Hound alive. With god off and the ship still, the Hound's first bullet passes within 3 units of the ship's x and hits it.

**4. Power-up variety**. The glyph cycle grows by zone (the row's zone in endless), still one type every 45 frames:

| Zone | Cycle (n) | Full cycle |
|---|---|---|
| Z1 | FAN, LANCE, HALO, ECHO, **REED** (5) | 225 frames |
| Z2 | FAN, LANCE, HALO, ECHO, REED, MIRROR (6) | 270 frames |
| Z3 | FAN, LANCE, HALO, ECHO, REED, MIRROR, ARC (7) | 315 frames |

- `POWER_IDS` becomes `['fan', 'lance', 'halo', 'echo', 'reed', 'mirror', 'arc']`; a zone's cycle is the first n (`S.zone`, set in `setupStage` from the stage row). The power hash keeps `POWER_IDS.indexOf(S.power) + 1`.
- The glyph stores its own `n` at the drop (`g.n`), and the type is `POWER_IDS[(g.start + floor(g.t / 45)) % g.n]` (today's `% 4`).
- **Start type, fixed for everyone on a seed:** `glyphRng.seed((S.seed ^ Math.imul(S.stage, 0x85ebca6b)) >>> 0)`, start = `glyphRng.int(n)` (`engine/rng.js` `Rng` has `seed()` and `int()`; one module-level `Rng`, no allocation). **The old `S.rng.int(4)` draw stays, and its value is thrown away**, so the shared stream advances exactly as today and every other random choice in the run stays where it was. (Measured in a scratch copy: without that draw, one more existing test moves, the Eel test "hunting bends the dive" in `tests/enemies-z2.test.js`; with it, only the 3 glyph pins listed in C.2 V3a move.) The **mercy rule** is unchanged: after a death in the previous stage the start type is HALO (index 2 in every cycle).

**4.0a The glyph waits at your row.** Why the old line was false: the ship cannot move up or down (`player.y = H - 26 = 274`), and a glyph falls straight down at 0.8, so it passes the ship's row once, in reach for about 20 frames (the catch radius is 8, so y 266 to 282 at 0.8 per frame). A falling glyph is the type that happens to be showing then: the player could only take it or skip it. And from the Lamplighter's slot (row 2, y 64.7 to 70.0: `34 + 32 x (1 + 0.6 br) + 1.3 sin(...)`, br 0 to 0.14, so 34 + 32 - 1.3 = 64.7 up to 34 + 34.69 + 1.3 = 69.99) the fall to y 274 takes `ceil((274 - y) / 0.8)` = 256 to 262 frames, shorter than a Z2 cycle (270) or a Z3 cycle (315); with Slow Glyph's old 75 frames a Z1 cycle was 375. The new rule:
- **High drop:** a glyph dropped at y <= 120 (any formation kill: the lowest row's slot is at most y 104.7; and any path or dive kill above 120, the same line as the Cinder's "kill it high") gets `g.wait = n x 45` at the drop. Each power step: if `g.wait > 0`, then `g.y = min(274, g.y + 0.8)`, and on every frame that ends with `g.y === 274`, `g.wait--` (the arrival frame counts). When `g.wait` is 0 it falls on at 0.8 as today and is gone once `g.y > H + 8` (308): 43 more frames.
- **Low drop:** a glyph dropped below y 120 (a dive kill low on the screen, a body hit, KINDLE) gets `g.wait = 0` and falls straight through, exactly as B.2.
- **The frame math (true for every zone and both settings):** the glyph sits at y 274 for exactly `n x 45` frames in a row, and `g.t` runs on every one of them. Any `45n` consecutive values of `g.t` give every type in the cycle exactly 45 frames, because the type is `floor((45 x start + t) / 45) mod n` and `45n` consecutive integers cover every remainder mod `45n` once. The type showing on arrival gets its 45 frames in two parts (the rest of its window at the start, the remainder at the end), so every type has at least 23 frames in one stretch (45 is odd). Z3, 7 types: a Lamplighter killed in its slot reaches the row after 256 to 262 frames, waits 315, and if never touched is gone 43 frames after its last waiting frame (arrival + 315 + 42 = 613 to 619 frames, about 10 s after the kill). The claim does not depend on the fall speed (0.8 in every zone): the wait is counted at the row.
- **Dwell catch:** a waiting glyph sits in the ship's row for up to 315 frames, so with a touch catch it was an obstacle: dodging across its column took whatever type showed and silently replaced the held power (worst for HALO, which the dodge was protecting). The rule: while `g.wait > 0`, the glyph is caught only after **12 frames in a row** with the ship alive and `abs(g.x - player.x) < 8` (both are at y 274, so this is the radius-8 test). Glyph field `g.dwell` counts those frames and goes back to 0 on any frame the ship is outside the window or dead. On the 12th frame the glyph is caught as the type showing on that frame. A falling glyph (`g.wait === 0`: a low drop, or a waiting glyph whose wait ran out) keeps B.2's touch catch, since it is in reach for at most 20 frames.
  - Why 12: the catch window is 16 units wide (x - 8 to x + 8, open). At full speed (2.7) the ship's x moves 2.7 a frame, so a crossing spends at most `ceil(16 / 2.7)` = 6 frames inside; with HALO (2.3) at most `ceil(16 / 2.3)` = 7. Any crossing faster than 16 / 12 = 1.33 units a frame never catches. 12 frames is 0.2 s of standing still on purpose.
  - Every type stays catchable: each type has at least 23 frames in one stretch (above), and 23 >= 12. To take a type, step in no later than 33 frames into its 45-frame window (45 - 12), or 11 frames into a 23-frame stretch.
  - Applies the same with or without a power held (one rule to learn), and to Slow Glyph's longer wait.
- Counter-play: dodge freely through a waiting glyph; when the type you want lights, stop on it for 12 frames.
- **Render** (`render/powerups.js`): a waiting glyph draws `n` small dots in a ring around it, one per type; the current type's dot is bright, the types already shown during this wait are dim, so the player can read what is still to come. While `g.dwell > 0` the ring closes in, from radius 10 to radius 5 over the 12 frames, so the player sees the catch coming and can step off.
- Freezes: the wait, like `g.t`, runs on every frame the power system steps (every frame but hit-stop), so a death or a stage clear does not stop it; the next stage's setup removes the glyph (as today).
- Hash: `g.n`, `g.wait` and `g.dwell` (power system hash, next to `g.t` and `g.start`).
- **Code shape:** `dropGlyph(S, x, y, start)` today does `g.start = start & 3`, which would turn types 4 to 6 into 0 to 2. The planned change makes it `g.start = start` (callers pass 0 to n - 1), and `dropGlyph` itself sets `g.n` (from `S.zone`), `g.wait` (the y <= 120 check and `S.glyphWaitCycles`, `S.glyphAnyHeight`, 5) and `g.dwell = 0`, so the `'kill'` handler and the `glyph()` test hook (drop at y 20, a high drop) both get the rule.
- Own answer: cycling pick-ups that you grab when the right type shows are a genre staple; ours waits at your row for exactly one full cycle after a kill made high on the screen, so the pick is a choice you time, and the Lamplighter's counter-play line (B.3, "kill it, then position to catch the type you want") becomes true.
- B.10 applies to every new type: 900 play frames (Long Wick 1200), restart on catch, bar and FADED.
- Verify (Node): stage 2 (Z1), stage 6 (Z2) and stage 11 (Z3), ship parked at x 300: `dropGlyph(S, 100, 66, 0)`: `g.y` is first exactly 274 on frame 260 (measured in a scratch copy for all three zones) and stays 274 for exactly `45n` frames (225, 270, 315); over those frames each id of the zone's cycle shows exactly 45 times; then `g.y` grows by 0.8 per frame and the glyph is off 43 frames later (gone on frame 527, 572, 617; measured). `dropGlyph(S, 100, 200, 0)`: `g.wait === 0`, `g.y === 200 + 0.8 t` until it is gone. `dropGlyph(S, 100, 66, 6)` in stage 11 reads `arc` at `g.t` 0 (start not truncated). **Dwell:** stage 11, `give('halo')`, a glyph waiting at (100, 274): the ship held right at full speed from x 80 to x 120 crosses it, `g.dwell` peaks at 6 or less, and the power is still `halo`; with HALO's speed (2.3) the peak is 7 or less; the ship parked at x 100 catches it on its 12th frame there, as the type `glyphType(g)` showed on that frame; a ship that leaves after 11 frames and comes back starts again at 1. A falling glyph (`g.wait === 0`) is still caught on the first touching frame. Start type: the same seed and stage give the same `glyphStart` in two sims; over seeds 1 to 40, stage 2 gives 5 different values and stage 11 gives 7. Shared stream: `S.rng` state after stage 2's setup equals the state a test gets by drawing `int(4)` once more on a copy of the pre-setup stream (or: the base-vs-head script of C.2 shows the same `rng` state after setup on seeds 1 to 3).

**4.0 REED (Z1+, the zone 1 power-up)**
- Fire: one shot from the ship, `vx = 0`, `vy = -5.5`, `pw = 'reed'`. Refire and shot cap as the base shot (10 frames, 2 on screen).
- **Bend:** in the power system's step, on play frames while `S.power === 'reed'`, every live shot with `pw === 'reed'` does `p.vx += (0.6 * player.vx - p.vx) * 0.25`. So shots in flight drift the way the ship is moving, at most 1.62 units per frame sideways (0.6 x 2.7), and ease back to straight when the ship stops (they keep the x they reached). After FADED or death, shots in flight keep their last vx.
- **Upside: SWEEP.** A kill by a REED shot that is at least **24 units** sideways from where it was fired scores **base +50%** (kill points, so every multiplier applies) and the popup "SWEEP" (`CP_SWEEP = 9`, appended after `CP_LEADX2 = 8` in `sim/score.js`, drawn by `render/hud-chain.js` like CLOSE). It is a base adjustment, last in the B.4 order: **Interrupt, then Lead, then Close, then Sweep**; at most one applies (B.4 stacking rule), so a kill that is already Close is not also a Sweep. How it is read: C.2 V3-0 adds shot field `x0` (set in `shot()`) and `S.hitDx = abs(p.x - p.x0)`, set next to `S.hitBy = p.pw` before the kill and cleared after it; `score.js` applies Sweep when `S.hitBy === 'reed' && S.hitDx >= 24`, as an optional 5th argument of `killBase(base, lead, interrupt, close, sweep)`, so the 4-argument calls in `tests/score.test.js:188-190, 275-276` keep their results.
- **The numbers** (measured in a scratch copy with the code's update order: `updPlayer` sets `player.vx`, the shot moves in the core update, then the power step bends it): with the ship already at full speed (2.7) when it fires and still holding, a REED shot is 24.3 units sideways 18 frames after the fire frame, at y 161.5; fired from a standstill and then held, 24.6 units after 21 frames, at y 145. So steady strafing earns Sweeps on the formation (y 34 to 105) and on divers above y about 145 to 160, and never on a shot fired from a still ship that stays still. Fire from a standstill, then hold right for 20 frames: the shot has moved 22.96 units.
- **Cost:** shots fly 5.5 instead of 6.5 (crossing the 274 units from y 266 to the top edge at -8 takes 50 frames instead of 43, so the 2-shot cap holds 16% longer on a miss), and they go where your ship goes, so every dodge pulls your fire off its target. Firing straight means standing still, which Hunt (stage 3+) punishes.
- **Score budget (B.4):** Sweep never raises the highest base a kill can have (it is the same +50% as Close and never stacks with it, Lead or Interrupt), so no B.4 ceiling moves: the chain end max (18,000), boss kill bonus (up to 40,000) and STARLIGHT finales are untouched (Sweep is kill points only). Bound for a stage: if every kill in B.4's worked stage 3 example were a Sweep, the great player's kill points would go from 18,400 to 27,600 (stage total 29,310 to 38,510, +31%), which is exactly what "every kill Close" already allows today. Realistic: REED lasts 900 frames, about half of a normal stage at the bot's measured 1,270 to 2,454 frames, and about half of those kills sweep: about +2,300 (+8%). STARLIGHT kills score only by B.4's STARLIGHT table (they go through `starlight.hit`, not `kill`), so no Sweep there. **Eels: Sweep applies to them, on purpose.** A swept Eel head goes from base 400 to 600 and a segment from 80 to 120. That is no new ceiling: a diving head already reaches 600 with Close, and a head on its entry path reaches 800 with Lead (x2), so the highest Eel base is unchanged.
- Duration: 900 play frames (Long Wick 1200), or death.
- Cycle and mercy: 5th in every cycle (after ECHO); with 4.0a the player can now pick it on purpose; the mercy start stays HALO.
- Scoring otherwise normal: 90-frame chain window, normal accuracy (every REED shot counts as fired).
- Hash: the power id (existing); vx of every live `'reed'` shot (power system hash). `x0` and `hitDx` are not hashed: `x0` is fixed at spawn from the hashed ship x and `hitDx` is 0 between kills.
- Not dominant: FAN still clears faster (3 shots a volley), LANCE still pierces; REED is the scoring tool for a player who strafes. **FAN and LANCE keep a role:** REED fires 1 shot a volley at 5.5 against FAN's 3 at 5.0, and never hits more than 1 enemy a shot against LANCE's up to 3, so on kills per second against a full formation REED should lose to both; it wins only on score per kill when bent. The C.2 V3a `power-compare` gate checks this: a tuning miss if REED beats **both** FAN and LANCE on **both** mean stage score and kills per second in stages 2, 3, 6 and 7. Not useless: it is the only power whose shots can follow a target sideways after firing, and it pays +50% for doing so.
- Own answer: most shooters fix a shot's path when it leaves the ship; REED's shots keep bending with your movement, so dodging and aiming become one motion, and a shot you bent into a kill pays a SWEEP.
- Verify (Node): stage 2, `give('reed')`, ship at x 200: one fire, then hold right for 20 frames: the shot's x is 222.96 (within 0.05) and its vy is -5.5; with the ship still, a new shot's x stays 200 to 1e-9. Sweep: a moth placed in `'form'` where a shot bent by 24 or more hits it pays `floor(60 x 1.5)` before multipliers and pops `CP_SWEEP`; the same moth hit by a straight REED shot pays 60; a diving moth within 32 of the ship hit by a bent shot pays Close, not both. After 900 play frames the power is `''` (FADED). A Z1 glyph with start 0 reads fan, lance, halo, echo, reed, fan at `g.t` 0, 45, 90, 135, 180, 225. A death in stage 2 makes stage 3's glyph start at halo.

**4.1 MIRROR (Z2+)**
- A ghost ship at `x' = 400 - player.x`, same y; drawn at 70% alpha.
- **Merged:** while `abs(x' - player.x) < 14` (ship within 7 of the center), the ghost is merged into the ship: no ghost shot, no ghost hit test, drawn as a faint outline on the ship. This stops a centered ship from using the ghost as a free shield.
- Fire: each fire spawns your base shot (`vy -6.5`, `pw = 'mirror'`) and, when not merged, a **ghost shot at `x'` that flies at 5.0** (`vy -5.0`, `pw = 'ghost'`). They share one `vol` (`S.shot()` gives a fresh `vol`; the power sets the ghost's `vol` to the first shot's, as FAN does), so the pair is 1 unit of the 2-volley cap (up to 4 shots on screen; the shot pool is 24). Wingmen fire their base shot as usual.
- **Cost:** the old pair (both at 6.5, one cap unit) doubled every volley's lanes for free, and that enemies aim at the ship, not the ghost, so the "first bullet in the ghost box ends it" cost rarely triggers. Now the cap unit is held until the slower ghost shot is gone: a missed pair leaves the screen (y 266 to below -8, 274 units) after `ceil(274 / 5.0)` = 55 frames instead of `ceil(274 / 6.5)` = 43 (+28%), and a ghost shot needs about 40 frames to reach the formation's row 2 (199 units) instead of about 31. So with MIRROR your own aimed fire comes back to you slower whenever the ghost misses, and the ghost cannot snipe a diver as fast as your shot can. The `pw = 'ghost'` tag only marks the kill for the gate below (`score.js` gives it no special rule).
- **Gate (`power-compare`):** with the bot playing stages 6, 7, 11, 12 under MIRROR, a **tuning miss** if MIRROR's mean stage score is more than 1.10 x the best of no power, FAN and LANCE on the same runs, or its kills per second more than 1.10 x FAN's, or the ghost's kill share (kills with `S.hitBy === 'ghost'` over all kills under MIRROR) is outside 15% to 50%. The script also prints the ghost's hit rate (ghost shots that hit, over ghost shots fired) for the log. Tuning order on a miss: ghost shot speed 5.0 down in steps of 0.5 to 4.0; still a miss at 4.0 becomes an operator question.
- **Ghost hit, tested before the ship:** the power's `bullet` hook runs for every enemy bullet before the ship test (`sim.js` enemy bullet loop, guarded by `player.alive && player.inv <= 0`); a bullet inside the ghost box (`abs(dx) < 3.5`, `abs(dy) < 4.5`, the ship's own box) is removed and MIRROR ends (`powerdown`, FADED). The ship is not hit by that bullet. Boss and Hound bullets are in the same pool, so they end it too.
- **Ghost body (a planned seam):** `updEnemy` calls the power's optional `ghostBody(S, e, bx)` for every moving enemy (path, join, dive, spark) just before the ship body test, under the same `player.alive && player.inv <= 0` guard. MIRROR's version ends MIRROR when the enemy is within 7 x 7 of the ghost; the enemy is unharmed and the ship test still runs after it.
- The ghost is not tested while the ship is invulnerable after a respawn, ignores the Tetherling line, never grazes and never catches a glyph.
- Ends: 900 frames, a ghost hit, or death.
- Hash: nothing new (power id and timer are already hashed; merged is derived from `player.x`).
- Not dominant: it doubles coverage on the mirrored column, not damage on one target; the slow ghost shot holds the cap; the first bullet in the ghost box ends it; and the gate above measures it. Not useless: it covers the other half of the screen.
- Own answer: a classic dual fighter sits beside you and widens one lane; MIRROR's ghost covers the other half of the screen and costs the power, never a life.
- Verify: Node, stage 6, `give('mirror')`, ship at x 120: a fire spawns shots at x 120 (vy -6.5) and 280 (vy -5.0, `pw` `'ghost'`) with the same `vol`, and the cap counts 1 until the ghost shot is gone (with no enemies, the pair's unit is freed on the frame its ghost shot leaves above y -8, 12 frames after its 6.5 shot left). A bullet placed at (280, 274) is removed, the power is cleared and the ship lives. A bullet at (120, 274) kills the ship. An enemy body placed at (280, 274) in `'dive'` clears the power and stays alive. With the ship at x 200, a fire spawns 1 shot and a bullet at (200, 274) kills the ship.

**4.2 ARC (Z3+)**
- **Fire:** one base shot, `vx = 0`, `vy = -6.5`, `pw = 'arc'`, no pierce; cap 2 volleys as the base shot.
- **Refire 16, enforced:** `gap: 16` for held fire, and `ready: S => S.arcCd <= 0` with `S.arcCd = 16` on each ARC fire, counted down in the power system's step (exactly like LANCE's `lanceCd`, whose test measures its 24). So pressing fire every frame cannot beat 16.
- When a shot fired under ARC (`S.hitBy === 'arc'`) kills an enemy, the power system's `onEvent('kill')` only **queues** a jump: it writes the killed enemy's (x, y) into `S.arcQ` (preallocated `Float64Array(16)`, 8 entries) and `S.arcN++` (a full queue drops the jump). It never calls `kill()`, so `emit()` is never re-entered and every later system (the Cinder ember rule) sees the original event.
- **Resolve:** at the start of the power system's `step()` (same frame: systems step after the core update), for each queued entry in order: target = the nearest other live enemy within 48 units, measured from the queued (x, y) to the target's hit point (`e.T.hitX ? e.T.hitX(S, e) : e.x`, and `e.y`; so a Mirage is reached only at its solid copy), with state `'form'`, `'join'`, `'dive'` or `'path'`, `y > 0`, not a STARLIGHT enemy (`e.bonus`), and not a Prism for which `prismDeflects(e)` is true (exported by `sim/enemies/prism.js`). `'tele'` is left out on purpose, so a jump never earns Interrupt's 750 (a reward for timing a shot, B.4). Ties go to the lower index in `enemies`. 1 damage: if `hp > 1`, `e.hp--`, `e.flash = 6`, `e.hurt = true` (as a shot hit); otherwise `S.hitBy = 'arcJump'`, `S.kill(e)`, `S.hitBy = ''`. Render event `FX_ARC` (from x, y, to x, y). Sound: the jump kill's own `pop` (no new sound id). Then `S.arcN = 0`. The queue is cleared on the 'stage' event, not on death (a jump earned before the ship died still happens).
- **A jump kill never grows the chain (replaces the old 45-frame jump window).** It is a normal `kill()` with normal kill points and base adjustments, scored at the chain's current tier, but it adds **0** to the chain count and does not touch the window: in `S.addKill`, `grant()` is skipped when `S.hitBy === 'arcJump'` (today `grant` reads only `S.power === 'lance'`). The shot kill before it granted its normal 90 (Ember Memory 120), and that window stands. It emits its own 'kill' event at the top level (the Cinder ember rule applies normally) and never queues another jump. The jump does not change `shotsFired` or `hits`. Bosses and Hounds are never targets.
- Numbers: formation neighbours are 24 to 27.4 apart in x (`24 x (1 + br)`) and 16 to 17.3 apart in y, so a formation kill almost always jumps; in a dive it jumps only when another enemy is within 48.
- **Why the old rule was dominant (worked out):** against a formation, base fire is held back by the cap, not the 10-frame refire: a shot from y 266 needs about 31 frames to reach row 2 (199 units at 6.5), so 2 shots in flight give one shot every ~15.3 frames, about 3.9 kills a second. ARC fires every 16 frames (3.75 shots a second) and each kill jumps, so about 7.5 kills a second (1.9x). With jump kills counting, the chain grew 2 a shot: tier 2 (chain 10) after 5 shots (80 frames) against base's ~153, tier 3 (30) after 240 against ~459, tier 4 (60) after 480 against ~918, longer than a 900-frame power. The 45-frame window never bit, since kills came every 16 frames. So ARC doubled chain growth and tier climb and also cleared fastest: dominant.
- **With the fix:** the chain grows 1 per ARC shot kill, 3.75 a second against base's 3.9, so tier climb is no faster than base. A stage has a fixed number of enemies, so if about half of them die by jumps, the chain over the stage is about half as long: a chain of 20 pays a 2,000 end bonus against 8,000 for 40 (`5 x n^2`), and later kills sit a tier lower. ARC is now the fast, safe clear (fewer enemies left to dive, about 1.9x kills a second in formation) that pays for it in chain. LANCE still wins on columns and FAN on spread.
- **Gate (`power-compare`):** with the bot playing stages 11 and 12 under ARC, a **tuning miss** if ARC's mean stage score is more than 1.10 x the best of no power, FAN, LANCE, ECHO, REED and MIRROR on the same runs (dominant), or its kills per second are more than 1.5 x the best of those (clears too fast), or less than 1.0 x no power's (useless). Tuning order on a miss: jump range 48 down in steps of 8 to 32, then refire 16 up to 20; still a miss after that becomes an operator question.
- Hash: `arcCd`; `arcN` and its entries (always 0 between frames; hashed so a stuck queue shows up).
- Own answer: chain lightning is common; ARC jumps once, only on a kill, and a jump kill pays points but never grows your chain, so you choose between a fast clear and a long chain.
- Verify: Node, stage 11, `give('arc')`: with two formation enemies 30 apart, killing one with a shot damages the other on the same frame; at 49 apart nothing jumps; a neighbour in `'tele'` is never the target; after a shot kill and its jump kill on the same frame, `S.chain` has grown by exactly 1 and `S.chainT` is 90 (the shot kill's window); the jump kill's points use `tier(S.chain)` of that moment. **Ember:** a Cinder killed by a jump still queues its ember, and the Cinder killed by the shot does too (both in `S.embers`). **Mash:** fire pressed every frame for 200 frames with no enemies: no two ARC shots spawn less than 16 frames apart, and every ARC shot has vy -6.5.

**5. Lantern Charms (a run-shaping choice)**
- **When:** after every boss, killed (`bossDefeated`) or timed out (`bossPass`). The order: bossOut (60 frames), the clear card (130), then the next stage is set up (`S.stage++`, `setupStage()`), then the **CHARM card**, then that stage's intro. No card on game over, and none after 4 charms are taken. The practice mode `charmK` (0.5) starts directly on the card.
- **State:** `'charm'` is appended at the **end** of `STATES` (index 8), so existing indices and hashes do not shift.
- **Offer:** its own stream: `charmRng.seed((seed ^ Math.imul(b + 1, 0x9e3779b1)) >>> 0)`, with b = `floor((S.stage - 1) / 5) - 1` for the stage just set up (0 before stage 6, 1 before stage 11, 2 before stage 16). A Fisher-Yates shuffle of the 7 charm ids with `charmRng.int`; the offer is the first 3 not already taken. Honest promise: the first card is the same for everyone on a seed; later cards are the same for everyone who made the same earlier picks.
- **Input:** the cursor starts on the middle card. A left or right step happens when the move input crosses from below 0.5 to at least 0.5 in size (one step per push, clamped to the 3 cards; sound `select`). A **fire press** (`S.inFirePressed`: a new press, so fire held from play does not count) takes the highlighted card (sound `powerup`). No new sound ids: `tests/s13-audio-fix.test.js` pins the whole `SIM_MAP` as a literal, so a new id would need a deliberate test change; `select` and `powerup` already exist and fit. Touch: the touch x picks the card by thirds of the screen, and holding a touch 20 frames takes it. After 600 frames with no take, the highlighted card is taken.
- During the card nothing in the game runs: the ship shows but cannot move or fire; the power-up clock, wingman life, chain window, `twistT` and boss clocks are frozen; no hit-stop is added. Checked against code: the `'charm'` case calls neither `updPlayer` nor `updWorld`, so the ship, shots and bullets hold still; the power timer, echoes, wingman life and `twistT` already count only in `'play'`; the chain was banked by the clear card (`score.js` ends it in `'clear'`); `setupStage` already cleared bullets and the glyph. Only `lanceCd`, `arcCd` and `haloLostT` keep counting down, which is harmless (they only allow fire sooner). The heat system changes only on events (clear, bossKill, tier x4, stage, death), so it does nothing during the card.
- **Boss fights:** charms do apply in boss fights. ECLIPSE (stage 5) comes before the first card, so it is exactly as B.10 left it; from MOONWELL on, Long Wick, Twin Flame, Quick Lantern, Third Shot, Ember Memory and Spare Spark all work in the fight. B.11's "no rule touches a boss fight" holds for ECLIPSE and for every twist, not for charms. MIRROR's ghost is hit by boss bullets; ARC never targets a boss.
- Shown afterwards as small icons next to the lantern. Never the same charm twice.

| Charm | Effect (with the B.10 numbers) |
|---|---|
| Long Wick | Power-ups last 1200 frames instead of 900 |
| Twin Flame | The wingman lives 900 frames instead of 600 (still at most 1) |
| Quick Lantern | Each kill adds 1.25 lantern dots instead of 1, so 8 kills fill it instead of 10 (grazes unchanged) |
| Third Shot | **With no power-up held**, 3 base volleys on screen per ship instead of 2. Power-up caps stay 2 (the seam applies `S.shotCapPer` only when `S.power === ''`) |
| Ember Memory | Every kill's chain window is 30 frames longer (90 to 120, LANCE 45 to 75; an ARC jump kill grants no window, 4.2); the graze cap follows |
| Slow Glyph | The glyph waits at your row for **two full cycles** instead of one (Z1 450, Z2 540, Z3 630 frames; every type in reach for 90 frames), and a glyph from a low drop waits too, as long as it was dropped above your row (y < 274; below it, it falls through). The cycle stays 45 frames a type. (the old "every 75 frames" made each type slower to come round and gave no real benefit once 4.0a exists) |
| Spare Spark | Your next death keeps your power-up and its timer (used up on that death) |

- **Spare Spark order:** taking it sets `S.spareArmed = 1`. The power system's 'death' handler checks it first: if armed, it sets `spareArmed = 0` and keeps `S.power` and `S.powerT` (the echo queue is still cleared); otherwise it clears the power as today. Both live in V3's files, so no cross-system order is needed.
- **Seams each charm uses** (none of them is built yet; each is inert until a charm sets it): Long Wick `S.powerFrames` (900; `setPower` reads it) and Spare Spark `S.spareArmed` (0) and Slow Glyph `S.glyphWaitCycles` (1) and `S.glyphAnyHeight` (0), all in `sim/powerups.js` (V3a); Ember Memory `S.chainExtra` (0; added to every window `grant()` gives, so 90 and LANCE's 45 both grow by 30; an ARC jump kill skips `grant()`) in `sim/score.js` (V3a); Twin Flame `S.wingLife` (600; `doKindle` sets `w.life = S.wingLife`), Quick Lantern `S.meterGain` (1; `kill()` adds it, and 8 x 1.25 = 10 = `METER_MAX` exactly), Third Shot `S.shotCapPer` (2; `fire()` blocks at `(S.power === '' ? S.shotCapPer : 2) * (1 + wing.length)`) in `sim.js` (V3-0).
- **Budget:** a card is at most 600 frames, and a run meets 3 cards before stage 16's intro (after the bosses of stages 5, 10 and 15), so at most 1800 frames (30 s). A good player takes about 5 s per card: the B.0 total goes from 951 s to about 966 s (16.1 min), worst case 16.4 min, still inside 15 to 20 min. The balance bot already makes a fresh fire press every 8 frames (`PRESS = 8` in `tools/sim-bot.mjs`), so it takes whichever card is highlighted within 8 frames (its move input may step the cursor first; still deterministic), with no bot change. The bot's mark is `sim.stage` reaching 16, which `setupStage` sets before the third card shows, so only the first 2 cards (at most 16 frames) fall inside the measured span. That does not move the balance band (34,000 to 46,000 frames, B.0). Wall clock: the B.0 total of 951 s becomes about 966 s for a good player (5 s per card), worst case 981 s (16.4 min).
- Hash: taken mask (7 bits), taken count, the 3 offers, cursor, card frames, touch hold frames, `spareArmed`.
- Own answer: picking one of three upgrades is a common roguelite pattern; ours are lantern charms that bend systems the game already has, at most 4 per run, offered the same way to every daily player.
- Verify: Node, seed 7, stage 5, god: after the boss dies, bossOut and the clear card, the stage is 6 and the state is `'charm'` with 3 different offers; the same seed gives the same offers twice; a boss timeout also leads to the card; 600 idle frames take the middle card; fire held through the change of state takes nothing; `STATES.indexOf('charm') === 8`; the power-up timer is the same before and after the card. Mode `charm0` on seed 7 shows the same 3 offers as the run above. Slow Glyph: a glyph dropped at (100, 66) in stage 11 sits at y 274 for exactly 630 frames, each of the 7 ids 90 of them; one dropped at y 200 sits there for 630 frames too; one dropped at y 280 falls through. Ember Memory: a LANCE kill leaves a 75-frame window, and an ARC shot kill plus its jump kill leave 120. Twin Flame: a KINDLE wingman has `life` 900. Third Shot: with FAN held the cap is still 2 volleys. Spare Spark: a death with LANCE at `powerT` 500 keeps LANCE at 500 once, and the next death clears it.

**6. Logged for later (not built)**
- **TRACER** (Z2 power-up candidate from the review): shots fly at 5.0 and curve toward the nearest enemy ahead at 0.04 rad per frame; cost: slower shots and no Lead bonus. Revisit after a playtest.

**7. The playtest complaint, answered**

| Complaint | Answer | First met |
|---|---|---|
| Power-up variety | REED, MIRROR, ARC, Charms | stage 2, 6, 11, after stage 5 |
| Systems | Charms; stage levers | after stage 5; stage 2 |
| Enemy variety | Tetherling, Hound | stage 6, 13 |
| Movement | Weave, Hunt, Undertow, Thermals | stage 2, 3, 8, 12 |
| Smarter enemies | Pincer, Hunt, lead aim, Hound | stage 3, 3, 6, 13 |

---

## D. Planned, not in this release

**Planned, not in this release.** Nothing in this section is built. It records the direction for a later update, so the rules are written down before any code.

The plan: coins earned only from server-verified play, achievements, cosmetic skins for Starfall's ship and the lobby cabinet, crate openings paid for with earned coins, a fixed "harder" modifier for the Daily, and a restore code so a player can move their id to a new device.

Rules any such update must obey:

| Rule | What it means |
|---|---|
| Earn-only forever | Coins come only from server-verified play. No money, no purchase, no trading, no gifting, no cash value. There is no shop that takes real currency, now or later |
| Cosmetic only | A skin changes how dots are colored and placed inside the same box. It never changes a hitbox, a speed, a timer, what the player can see of bullets, or the sim. Replays stay deterministic |
| Original | Every skin is our own design, described from dots. No brand, character, film, show or game references |
| Every game has a Daily | Starfall's Daily gets a fixed "harder" modifier |

## Things I could not source

- Galaga's exact per-enemy point table: the StrategyWiki gameplay page returned 403. I only used the Challenging Stage figures from https://www.arcade-history.com/game/898/ to know what to avoid. Starfall's values come from v1 and are not derived from Galaga's table.
- Galaga's dip-switch difficulty details and any hidden rank: no source found.
- Exact DoDonPachi (1997) gauge timings: sources describe the system, not frame counts. The 90-frame window is our own number.
- That Jan Willem Nijman's "Art of Screenshake" talk itself covers hit-stop: only a secondary blog (https://infovore.org/?p=5275) describes the freeze.
- Space Invaders Extreme (the first game) music sync: the source found covers the sequel.
- Galaxian's 300-point escort case: sources disagree on the kill order (https://strategywiki.org/wiki/Galaxian/Walkthrough vs arcade-history). Not used.
- Galaga '88 "Galactic Dancin'" stage gameplay: Wikipedia only mentions it in the music section.
- The 15 to 20 minute run length is our own design target, not a sourced genre norm; the balance bot measures it.