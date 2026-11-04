// Every README picture, described as dots. Units are playfield units; `px` is the output width in pixels.
// Font: 5x7 dot font, upper case only. A line of n letters at scale sc is n*6*sc - sc wide and 7*sc tall.
const GOLD = [1, .84, .3], AMBER = [1, .62, .2], VIOLET = [.62, .45, 1], TEAL = [.3, .9, .85], ROSE = [1, .35, .55], WHITE = [1, 1, 1];
const DIM = [.62, .66, .78];
const tw = (s, sc) => s.length * 6 * sc - sc;

function header(name, label, col) {
  const W = 300, H = 32, sc = 2, w = tw(label, sc);
  return { name, W, H, px: 1800, stars: 50, seed: label.length * 31, items: [
    { text: label, x: W / 2, y: (H - 7 * sc) / 2, col, sc, align: 'c' },
    { line: [12, H / 2, W / 2 - w / 2 - 10, H / 2], col, a: .55, step: 2.5, size: .7 },
    { line: [W / 2 + w / 2 + 10, H / 2, W - 12, H / 2], col, a: .55, step: 2.5, size: .7 },
  ] };
}

function button(name, label, col) {
  const sc = 1.6, H = 30, W = Math.round(tw(label, sc) + 34);
  return { name, W, H, px: Math.round(W * 6), stars: 0, items: [
    { box: [6, 5, W - 12, H - 10], col, a: .8, step: 2, size: .75 },
    { text: label, x: W / 2, y: (H - 7 * sc) / 2, col, sc, align: 'c' },
  ] };
}

// a row of boxes: [{title, col, lines:[...]}], titles at tsc, lines at lsc, '>' between boxes when arrows
function boxRow(items, { W, y, h, x0, bw, gap, tsc, lsc, arrows, arrowCol }) {
  const out = [];
  items.forEach((b, i) => {
    const x = x0 + i * (bw + gap);
    out.push({ box: [x, y, bw, h], col: b.col, a: .7, step: 2, size: .7 });
    out.push({ text: b.title, x: x + bw / 2, y: y + 7, col: b.col, sc: tsc, align: 'c' });
    b.lines.forEach((l, j) => out.push({ text: l, x: x + bw / 2, y: y + 9 + 7 * tsc + 4 + j * (7 * lsc + 4), col: DIM, sc: lsc, align: 'c' }));
    if (arrows && i < items.length - 1) out.push({ text: '>', x: x + bw + gap / 2, y: y + h / 2 - 4, col: arrowCol || AMBER, sc: 1.2, align: 'c' });
  });
  return out;
}

export const SCENES = [
  { name: 'wordmark', W: 300, H: 84, px: 1800, stars: 170, seed: 3, items: [
    // the site's wordmark: teal fading to violet, letter by letter
    ...[...'STATICADE'].map((ch, i) => { const t = i / 8, x0 = 150 - tw('STATICADE', 4) / 2;
      return { text: ch, x: x0 + i * 24, y: 18, col: [TEAL[0] + (VIOLET[0] - TEAL[0]) * t, TEAL[1] + (VIOLET[1] - TEAL[1]) * t, TEAL[2] + (VIOLET[2] - TEAL[2]) * t], sc: 4 }; }),
    { line: [60, 54, 240, 54], col: VIOLET, a: .5, step: 2.5, size: .7 },
    { text: 'PURE SKILL. DRAWN IN LIGHT.', x: 150, y: 60, col: DIM, sc: 1.25, align: 'c' },
  ] },

  button('btn-play', 'PLAY', GOLD),
  button('btn-built', 'HOW IT WAS BUILT', TEAL),
  button('btn-design', 'DESIGN', VIOLET),
  button('btn-server', 'SERVER', AMBER),

  header('h-play', 'SEE IT MOVE', GOLD),
  header('h-inside', "WHAT'S INSIDE", TEAL),
  header('h-built', 'HOW IT WAS BUILT', VIOLET),
  header('h-fair', 'HOW SCORES STAY FAIR', AMBER),
  header('h-run', 'RUN IT', TEAL),


  header('h-decisions', 'DECISIONS I OWNED', ROSE),

  { name: 'calls', W: 320, H: 74, px: 1800, stars: 40, seed: 7, items: [
    ...[['36', 'CALLS', 'AGENTS STOPPED TO ASK ME', ROSE], ['17', 'TEST CHANGES', 'I APPROVED OR REFUSED', VIOLET],
        ['11', 'SESSIONS', 'I RAN AND HANDED OFF', TEAL]]
      .flatMap(([n, l, s, c], i) => {
        const cx = 54 + i * 106;
        return [
          { text: n, x: cx, y: 8, col: c, sc: 2.5, align: 'c' },
          { text: l, x: cx, y: 34, col: WHITE, sc: 1.1, align: 'c' },
          { text: s, x: cx, y: 47, col: DIM, sc: .6, align: 'c' },
        ];
      }),
    { text: 'STARFALL BUILD, OCT 27 - 30', x: 160, y: 62, col: DIM, sc: .6, align: 'c', a: .7 },
  ] },

  { name: 'cards', W: 300, H: 150, px: 1800, stars: 60, seed: 11, items: [
    ...boxRow([
      { title: 'STARFALL', col: GOLD, lines: ['FIXED SHOOTER', '15 STAGES, 3 BOSSES', 'DAILY SEED, LEAGUES'] },
      { title: 'STACKLIGHT', col: VIOLET, lines: ['FALLING BLOCK PUZZLE', 'PIECES ARE BEAMS', 'THAT MELT IN'] },
    ], { y: 6, h: 66, x0: 7, bw: 140, gap: 6, tsc: 1.5, lsc: 1 }),
    ...boxRow([
      { title: 'ALL DOTS', col: TEAL, lines: ['NO IMAGE FILES', 'NO FONT FILES', 'NO AUDIO FILES'] },
      { title: 'FAIR SCORES', col: AMBER, lines: ['THE SERVER REPLAYS', 'YOUR INPUTS TO', 'CHECK EVERY SCORE'] },
    ], { y: 78, h: 66, x0: 7, bw: 140, gap: 6, tsc: 1.5, lsc: 1 }),
  ] },

  { name: 'stats', W: 320, H: 66, px: 1800, stars: 40, seed: 5, items: [
    ...[['8', 'DAYS', 'OCT 27 - NOV 3', GOLD], ['885', 'COMMITS', 'PRIVATE REPO', TEAL],
        ['1,491', 'TESTS', 'NODE + BROWSER', VIOLET], ['2', 'GAMES', 'BOTH ORIGINAL', AMBER]]
      .flatMap(([n, l, s, c], i) => {
        const cx = 40 + i * 80;
        return [
          { text: n, x: cx, y: 8, col: c, sc: 2.5, align: 'c' },
          { text: l, x: cx, y: 34, col: WHITE, sc: 1.2, align: 'c' },
          { text: s, x: cx, y: 48, col: DIM, sc: .7, align: 'c' },
        ];
      }),
  ] },

  { name: 'pipeline', W: 320, H: 124, px: 1800, stars: 40, seed: 9, items: [
    ...boxRow([
      { title: '1 GOAL', col: GOLD, lines: ['ME'] },
      { title: '2 PLAN', col: TEAL, lines: ['COORDINATOR'] },
      { title: '3 BUILD', col: TEAL, lines: ['BUILDER AGENT'] },
      { title: '4 RE-RUN', col: TEAL, lines: ['COORDINATOR'] },
    ], { y: 6, h: 50, x0: 6, bw: 70, gap: 10, tsc: 1.25, lsc: .8, arrows: true }),
    ...boxRow([
      { title: '5 REVIEW', col: VIOLET, lines: ['FRESH AGENT', 'BREAKS IT'] },
      { title: '6 FIX', col: ROSE, lines: ['TWO FAILS:', 'I DECIDE'] },
      { title: '7 LOOK', col: TEAL, lines: ['SCREENSHOTS', 'OPENED + READ'] },
      { title: '8 PLAY', col: GOLD, lines: ['ME', 'FEEL CHECK'] },
    ], { y: 68, h: 50, x0: 6, bw: 70, gap: 10, tsc: 1.25, lsc: .8, arrows: true }),
  ] },

  { name: 'fair', W: 320, H: 62, px: 1800, stars: 30, seed: 13, items: boxRow([
    { title: 'BROWSER', col: TEAL, lines: ['60 STEPS/S', 'ONE SEED'] },
    { title: 'REPLAY', col: VIOLET, lines: ['SEED+INPUTS', 'COMPRESSED'] },
    { title: 'WORKER', col: AMBER, lines: ['RE-RUNS IT', 'SAME CODE'] },
    { title: 'D1', col: GOLD, lines: ['STORES THE', 'REAL SCORE'] },
  ], { y: 7, h: 48, x0: 7, bw: 66, gap: 14, tsc: 1.25, lsc: .8, arrows: true }) },

  { name: 'caught', W: 320, H: 62, px: 1800, stars: 30, seed: 17, items: boxRow([
    { title: 'PASSED', col: TEAL, lines: ['OWN TESTS OK', 'SUITE OK'] },
    { title: 'PROBE', col: AMBER, lines: ['STALL 120 MS', 'THEN ESC'] },
    { title: 'FAIL', col: ROSE, lines: ['MUSIC PLAYED', 'OVER LOBBY'] },
    { title: 'FIXED', col: GOLD, lines: ['NEW CARD', 'TIMING TEST'] },
  ], { y: 7, h: 48, x0: 7, bw: 66, gap: 14, tsc: 1.25, lsc: .8, arrows: true }) },

  { name: 'footer', W: 300, H: 18, px: 1800, stars: 60, seed: 21, items: [
    { line: [12, 9, 120, 9], col: VIOLET, a: .45, step: 2.5, size: .6 },
    { text: 'STATICADE', x: 150, y: 6, col: DIM, sc: .9, align: 'c' },
    { line: [180, 9, 288, 9], col: VIOLET, a: .45, step: 2.5, size: .6 },
  ] },
];
