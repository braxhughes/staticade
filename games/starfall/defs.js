// Starfall constants shared by the sim (rules) and the browser side (render, fx, sound).
// Pure data: no DOM, no Math.random, no trig.
export const GAME_ID = 'starfall', GAME_VERSION = '2.5';
export const W = 400, H = 300, CX = W / 2, PI = 3.141592653589793, TAU = 2 * PI;

// v1 enemy stats (registered as enemy types in sim/registry.js; sprites live in sprites.js).
// The player's explosion uses TI_PLAYER, a sentinel outside the registered type indices.
export const TI_PLAYER = -1;
export const STATS = {
  moth: { form: 60, dive: 120, r: 6, hp: 1, name: 'MOTH' },
  wisp: { form: 90, dive: 180, r: 6, hp: 1, name: 'WISP' },
  warden: { form: 200, dive: 500, r: 7, hp: 2, name: 'WARDEN' },
  splitter: { form: 150, dive: 300, r: 6, hp: 1, name: 'SPLITTER' },
  spark: { form: 100, dive: 100, r: 4, hp: 1, name: 'SPARK' }
};

// Formation: 4 wardens, 16 wisps, 20 moths (some become splitters from stage 2).
export const ROWS = [4, 8, 8, 10, 10];
export const GROUPS = [
  { path: 'PAIR', slots: [[1, 2], [3, 3], [1, 3], [3, 4], [1, 4], [3, 5], [1, 5], [3, 6]] },
  { path: 'SL', slots: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 6], [0, 3], [1, 7]] },
  { path: 'SR', slots: [[2, 0], [2, 1], [2, 2], [2, 3], [2, 4], [2, 5], [2, 6], [2, 7]] },
  { path: 'TR', slots: [[3, 0], [3, 1], [3, 2], [3, 7], [3, 8], [3, 9], [4, 0], [4, 9]] },
  { path: 'TL', slots: [[4, 1], [4, 2], [4, 3], [4, 4], [4, 5], [4, 6], [4, 7], [4, 8]] }
];
// entry paths are authored on a 240x320 grid and fitted to the playfield
export const CP_TOP = [100, -16, 100, 30, 80, 110, 40, 170, 30, 215, 60, 245, 100, 225, 105, 180];
export const CP_SIDE = [-16, 260, 40, 250, 100, 225, 140, 185, 140, 145, 110, 125, 80, 140, 85, 175];
export const CP_TOP_LOOP = [68, 207], CP_SIDE_LOOP = [112, 155];
export const BONUS_CP_RAW = [
  [-16, 60, 60, 90, 120, 160, 180, 230, 220, 160, 180, 90, 120, 160, 60, 230, 20, 160, 60, 90, 120, 60, 256, 40],
  null,
  [120, 336, 120, 250, 160, 200, 160, 140, 120, 110, 80, 140, 80, 200, 120, 230, 170, 180, 200, 100, 256, 60],
  null,
  [-16, 40, 60, 120, 100, 60, 140, 120, 180, 60, 220, 120, 180, 200, 120, 240, 60, 200, 20, 120, -16, 40]
];
export const BONUS_TYPES = ['moth', 'wisp', 'splitter', 'warden', 'moth'];

// the lantern meter is fractional: each living wingman burns one dot every 10 s, each lost wingman costs 3
// B.10: at most 1 wingman, alive 600 play frames (it blinks for the last WING_BLINK, then peels off the top)
export const WING_MAX = 1, WING_LIFE = 600, WING_BLINK = 90;
export const METER_MAX = 10, WING_DRAIN = 1 / 600, WING_LOSS = 3;

export const STATES = ['intro', 'play', 'dying', 'ready', 'clear', 'bonusEnd', 'gameover', 'bossOut'];

// ---- sim -> browser events (ring buffer, see sim.drain) ----
export const EV_SFX = 1, EV_SHAKE = 2, EV_HITSTOP = 3, EV_STATE = 4, EV_POPUP = 5, EV_EXPLODE = 6, EV_FX = 7, EV_PULSE = 8;
export const SFX_NAMES = ['fire', 'ding', 'pop', 'big', 'die', 'kindle', 'life', 'warp', 'wingLost', 'phase2', 'morph', 'deflect', 'select', 'jingle', 'beat', 'bossDie', 'powerup', 'powerdown',
  'cut', 'hunt', 'snap']; // C2-0: B.11 sounds (V4 synthesizes them); appended so older ids keep their numbers
export const SFX_ID = {}; SFX_NAMES.forEach((n, i) => { SFX_ID[n] = i; });
// popups: kind, x, y, value, color
export const POP_NUM = 0, POP_1UP = 1, POP_KINDLE_READY = 2, POP_LANTERN = 3, POP_KINDLED = 4, POP_CLEAR = 5, POP_DEEPSKY = 6, POP_PHASE2 = 7, POP_CORE = 8, POP_PASSES = 9, POP_FADED = 10,
  POP_CUT = 11; // C2-0: Tetherling CUT (B.11 3.1)
// S10 STARLIGHT (sim/starlight.js): a phrase grade (value = points x 8 + flags 1 Complete, 2 In Tune, 4 In Order)
// and the finale (value = points x 2 + 1 for STANDING OVATION, 0 for ENCORE)
export const POP_PHRASE = 12, POP_FINALE = 13;
// boss display names; POP_PASSES carries the index as its value
export const BOSS_NAMES = ['ECLIPSE', 'MOONWELL', 'PYRE'];
export const C_WHITE = 0, C_AMBER = 1, C_ROSE = 2, C_TEAL = 3, C_GOLD = 4, C_VIOLET = 5, C_DIM = 6;
// explode: type index (TI_PLAYER = player), sprite variant (0 A / 1 B), palette code, x, y, ang, vx, vy, power
// palette codes: 0-3 normal by multiplier, 4-7 hurt by multiplier, 8 kindled, 9 player
export const PC_HURT = 4, PC_KINDLE = 8, PC_PLAYER = 9;
// particle bursts (EV_FX kind, args...)
export const FX_SPLIT = 0, FX_DEATH = 1, FX_KINDLE = 2, FX_SPARK = 3, FX_COMET_TRAIL = 4, FX_COMET_HIT = 5,
  FX_BOSS_DOTS = 6, FX_CORE = 7, FX_DEFLECT = 8,
  FX_TETHER = 10; // C2-0: Tetherling line snap (B.11 3.1); 9 stays free for ARC (V3, deferred)
// boss dot lists for FX_BOSS_DOTS: 0 hull, 1 core, 2..9 panel k
