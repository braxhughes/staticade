// STACKLIGHT constants shared by the sim (rules) and, later, the browser side (render, sound).
// Every number here comes from the STACKLIGHT design document, section B (and C for the input word and streams).
// Pure data plus streamSeed: no DOM, no wall clock, no unseeded randomness, no trig.
import { seedFromString } from '../../engine/rng.js';

export const GAME_ID = 'stacklight', GAME_VERSION = '3.0';

// B.1 board: 9 columns x 18 visible rows (0 to 17, row 0 at the bottom) plus a 3-row spawn zone (18 to 20)
export const COLS = 9, ROWS = 18, SPAWN_ROWS = 3, TOTAL_ROWS = ROWS + SPAWN_ROWS, CELLS = COLS * TOTAL_ROWS;
export const SPAWN_ZONE_ROW = ROWS; // the ceiling rule: any cell at row 18 or above after a lock ends the run
// C.1 cell types
export const EMPTY = 0, CELL_BAR = 1, CELL_PLUS = 2, CELL_SHADE = 3, CELL_RIDGE = 4;

// B.2 pieces (the piece type is also the cell type it leaves) and spawn pivot
export const BAR = 1, PLUS = 2;
export const ROT_H = 0, ROT_V = 1;
export const SPAWN_COL = 4, SPAWN_ROW = 18;
export const PIECE_NAMES = ['', 'BAR', 'PLUS'];

// B.3 deck (Fisher-Yates from these starting arrays, deal from index 0 up)
export const DECK = [BAR, BAR, BAR, PLUS, PLUS];
export const LEAN_DECK = [BAR, BAR, PLUS, PLUS];
export const DECK_MAX = 5;
export const PREVIEW = 3, SHORT_SIGHT_PREVIEW = 1;

// B.6 timings, in sim frames at 60 Hz
export const AUTO_REPEAT_FIRST = 11, AUTO_REPEAT_EVERY = 2;
export const ENTRY_DELAY = 8, CLEAR_DELAY = 20;
// D111 (GAME_VERSION 2.0): no lock resets. Kept as a constant so the bot's rule hook can vary it.
// D119 (GAME_VERSION 3.0): instant lock. lockDelayFor(level) is the number of frames a piece may wait AFTER its first
// resting frame before it locks; it is 0 at every level, so a piece locks on the first frame it rests (the touchdown
// frame), at the end of that frame, after that frame's input and gravity. A piece lives at most ceil(18 x 256 / G)
// frames from its spawn frame (B.6). The sim still counts lockT (resting frames, the first one counts as 1) and locks
// when lockT > lockDelayFor(level), so the bot's rule hook can measure other delays.
export const LOCK_RESETS = 0;
export function lockDelayFor(level) { return 0; }
// gravity G per level, in 1/256 row per frame (index = level; index 0 unused)
export const GRAVITY = [0, 6, 8, 10, 13, 16, 20, 26, 32, 40, 51, 64, 80, 102, 128, 160, 204, 256, 384, 640, 5376];
export const SUB_ROW = 256;
export const SOFT_DROP_G = 128;
// B.1 run cap: the run ends LIGHTS OUT after this many frames (the server's MAX_RUN_FRAMES)
export const RUN_CAP = 216000;

// B.7 scoring
export const LINE_POINTS = [0, 100, 260, 640]; // x level x (4 + g) / 4; at most 3 rows clear from one piece (B.5)
export const FLAT_POINTS = 40, KEY_POINTS = 120; // x level, not multiplied by GLOW
export const FIT_NONE = 0, FIT_FLAT = 1, FIT_KEY = 2;
export const GLOW_FRAMES = 240, QUICK_GLOW_FRAMES = 150, GLOW_MAX = 4;

// B.7 / B.9 levels
export const LEVEL_CAP = 20;
export const FREE_LINES_PER_LEVEL = 8;
export const DAILY_START_LEVEL = 4, DAILY_LINES_PER_LEVEL = 6;

// B.9 Daily day rules, drawn as daily.int(3) right after the ridge
export const LEAN = 0, SHORT_SIGHT = 1, QUICK_GLOW = 2, NO_RULE = -1;
export const DAY_RULES = ['LEAN', 'SHORT SIGHT', 'QUICK GLOW'];

// B.9 RIDGES: 64 starting surfaces, 9 digits each = column heights from column 0 to 8 (RIDGE cells, type 4)
export const RIDGES = [
  '222200000', '201122000', '211021100', '202022100', '221220200', '101221200', '002022200', '202111001',
  '111212001', '201120101', '201121101', '111212101', '102110201', '112201201', '112221201', '112212201',
  '222020011', '210121011', '220212011', '201110111', '102201111', '202102111', '001222111', '202020211',
  '202011211', '221102211', '002122211', '211201002', '111102002', '102122002', '201120102', '201211102',
  '111202102', '222122102', '212210202', '212201202', '001221202', '202112202', '112200012', '202101012',
  '222121012', '222112012', '220200112', '101220112', '200021112', '210012112', '210100212', '202020212',
  '220011212', '112002212', '002022212', '220210022', '220201022', '102121022', '210112022', '202000122',
  '201020122', '112201122', '201002122', '001022122', '201010222', '221220222', '110211222', '001202222'
];

// C.2 input word (16 bits; bits 7 to 15 reserved, must be 0)
export const IN_LEFT = 1, IN_RIGHT = 2, IN_SOFT = 4, IN_LEFT_PRESS = 8, IN_RIGHT_PRESS = 16, IN_HARD_PRESS = 32, IN_ROT_PRESS = 64;
export const IN_PRESS_BITS = IN_LEFT_PRESS | IN_RIGHT_PRESS | IN_HARD_PRESS | IN_ROT_PRESS;
export const INPUT_MASK = 0x007f, NEUTRAL = 0;

// C.3 replay modes (the test-only start, mode 'test', is not one of them)
export const REPLAY_MODES = ['arcade', 'daily'];

// C.6 the one rule for every named random stream
export function streamSeed(seed, name) { return seedFromString((seed >>> 0).toString(36) + ':' + name); }
