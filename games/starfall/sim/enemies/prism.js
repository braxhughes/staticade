// Prism (design.md B.3, Z2+): a glass diamond whose bright face turns toward the player.
// The face glows 90 frames, then rests 60. While it glows, a shot that strikes the face is deflected:
// the shot vanishes with a small spark at the face, counts as fired but not as a hit, and never becomes a hazard.
// Player shots fly straight up, so they strike a Prism's lower side; that side is the face while the face points
// within FACE_ARC of straight down. Counter-play: shoot while the face rests, or from the side during a dive.
//
// Sim only: plain data art, no render imports. Pure and allocation-free (fields live on the pooled enemy).
// Per-enemy fields: pfa (face angle, 0 = straight down, positive toward +x), pt (glow clock), pdf (frame of the last deflect).
import { SFX_ID, FX_DEFLECT, PI, TAU } from '../../defs.js';
import { atan2 } from '../../../../engine/dmath.js';
import { angDiff } from '../../sim-path.js';

export const PRISM_ON = 90, PRISM_OFF = 60, PRISM_CYCLE = PRISM_ON + PRISM_OFF;
export const FACE_TURN = 0.06;  // radians per frame the face turns toward the player
export const FACE_ARC = 0.9;    // a face within this angle of straight down covers the side shots strike

// glow clock position (0..PRISM_CYCLE-1); the face glows while it is below PRISM_ON
export const prismT = e => (e.pt + e.phase * 3) % PRISM_CYCLE;
export const prismGlowing = e => prismT(e) < PRISM_ON;
// true when a shot striking from below meets the glowing face
export const prismDeflects = e => prismGlowing(e) && Math.abs(e.pfa) < FACE_ARC;

export const prism = {
  name: 'PRISM', hp: 2, r: 6, form: 160, dive: 400,
  art: {
    // a tall cut-glass spindle: long axis vertical, a bright center facet line
    A: ['...i...', '..iwi..', '..ivi..', '.ivwti.', '.itwvi.', 'ivtwtvi', 'ivvwvvi', '.itwti.', '.ivwvi.', '..ivi..', '..iwi..', '...i...'],
    B: ['...i...', '..iwi..', '..iti..', '.itwvi.', '.ivwti.', 'itvwvti', 'ittwtti', '.ivwvi.', '.itwti.', '..iti..', '..iwi..', '...i...'],
    pal: { i: [0.8, 0.95, 1], t: [0.25, 0.95, 0.9], v: [0.6, 0.4, 1], w: [1, 1, 1] },
    hurt: { i: [1, 0.7, 0.8], t: [1, 0.45, 0.6], v: [0.9, 0.3, 0.6], w: [1, 1, 1] }
  },
  init(S, e) { e.pfa = 0; e.pt = 0; e.pdf = -999; },
  // the core moves it (formation, dives, aimed shots); this only turns the face and runs the glow clock
  move(S, e) {
    e.pt++;
    const P = S.player, want = atan2(P.x - e.x, P.y - e.y);
    const d = angDiff(e.pfa, want);
    e.pfa += d > FACE_TURN ? FACE_TURN : d < -FACE_TURN ? -FACE_TURN : d;
    if (e.pfa > PI) e.pfa -= TAU; else if (e.pfa < -PI) e.pfa += TAU;
    return false;
  },
  // a shot overlaps this Prism: true = deflected (the sim removes the shot without a hit)
  shot(S, e, p) {
    if (!prismDeflects(e)) return false;
    S.sfx(SFX_ID.deflect); S.fx(FX_DEFLECT, p.x, e.y + 5);
    S.prismDeflects = (S.prismDeflects | 0) + 1; e.pdf = S.frame; // pdf: frame of the last deflect (render flare)
    return true;
  }
};
