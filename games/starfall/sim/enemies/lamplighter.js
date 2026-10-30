// The Lamplighter (design.md B.2): one per normal stage from stage 2, the 4th member of entry group 3
// (the stage table puts it in slot [2, 3]). 1 hp, 300 in formation / 600 diving. Killing it anywhere
// drops a glyph (sim/powerups.js). Plain data only: the lit lantern above it is drawn by render/powerups.js.
export const LAMPLIGHTER = {
  name: 'LAMPLIGHTER', hp: 1, r: 6, form: 300, dive: 600,
  // a slate-blue moth-like keeper with a brass lantern cap; two wing frames
  art: {
    A: ['....h....', '...hyh...', 'n..nkn..n', 'nn.nkn.nn', 'nnnnwnnnn', '.n.nnn.n.', '..n...n..', '.n.....n.'],
    B: ['....h....', '...hyh...', '...nkn...', '.n.nkn.n.', 'nnnnwnnnn', 'nn.nnn.nn', '..n...n..', '...n.n...'],
    pal: { h: [1, .72, .28], y: [1, .93, .55], n: [.38, .52, .95], k: [.62, .72, 1], w: [1, 1, 1] }
  }
};
