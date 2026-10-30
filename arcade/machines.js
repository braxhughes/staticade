// The arcade floor's machine list, left to right: only the games we plan to make.
// Starfall is the only playable cabinet; the rest are lit COMING SOON machines for original games in classic genres.
// Names and palettes are our own. `attract` picks the idle animation drawn on the tube.
import { COL } from '../games/starfall/sprites.js';

// The platform racer's name lives here and nowhere else, so a rename is one edit.
export const PLATFORM_RACE_NAME = 'LEDGE LORDS';   // the owner's pick

export const MACHINES = [
  {
    // STACKLIGHT twist: the falling pieces are beams of light (a bar of 3 or a plus of 5 cells) that melt into the stack; never 4-cell pieces.
    id: 'stacklight', name: 'STACKLIGHT', genre: 'FALLING BLOCK PUZZLE', sub: 'BLOCK PUZZLE', playable: false, attract: 'blocks',
    glow: [.3, 1, .6],
    palette: {
      edge: [.3, 1, .55], body: [.1, .5, .3], dark: [.06, .26, .17], steel: [.65, .8, .72],
      teal: [.2, 1, .75], amber: [.9, 1, .3], gold: [.85, 1, .45], lampFill: [.5, 1, .35], ball: [.4, 1, .6],
      marqueeBox: [.3, 1, .6], marqueeTop: [.6, 1, .65], marqueeBottom: [.1, .85, .85]
    }
  },
  {
    id: 'starfall', name: 'STARFALL', genre: 'FIXED SHOOTER', sub: 'FIXED SHOOTER', playable: true, attract: 'starfall',
    glow: [.25, .95, .88],
    palette: { teal: COL.teal, amber: COL.amber, gold: COL.gold, dim: COL.dim }
  },
  {
    // Platform race twist: two runners made of light race head to head along floating sky ledges at dawn; a clean jump over
    // a gap leaves a spark that boosts the runner behind you, so the lead swaps back and forth. No plumber, no pipes,
    // no mushrooms, no flagpole: you race a rival to a light beacon, you do not rescue anyone.
    id: 'ledgelords', name: PLATFORM_RACE_NAME, genre: 'PLATFORM RACE', sub: 'PLATFORM RACE', playable: false, attract: 'race',
    glow: [.45, .72, 1],
    palette: {
      edge: [.45, .68, 1], body: [.16, .3, .66], dark: [.08, .15, .36], steel: [.7, .78, .95],
      teal: [.55, .85, 1], amber: [1, .62, .38], gold: [1, .86, .45], lampFill: [1, .6, .35], ball: [1, .7, .45],
      marqueeBox: [1, .7, .45], marqueeTop: [1, .9, .45], marqueeBottom: [1, .45, .55]
    }
  }
];

export const START_INDEX = MACHINES.findIndex(m => m.id === 'starfall');
export const ids = () => MACHINES.map(m => m.id);
