// Fixed-step game loop: step() runs at a fixed rate (default 60 Hz) from an accumulator,
// render(alpha) runs once per display frame with alpha in [0, 1) for interpolation.
// Long frames are clamped so a stall never triggers a huge catch-up burst; when the tab is
// hidden the clock is reset on return, so time spent away is not replayed.

export function createLoop({ step, render, hz = 60, maxFrameMs = 250, raf, now } = {}) {
  const STEP = 1000 / hz;
  const rafFn = raf || (cb => requestAnimationFrame(cb));
  const nowFn = now || (() => performance.now());
  let acc = 0, last = 0, running = false;

  function frame(t) {
    if (!running) return;
    advance(t);
    rafFn(frame);
  }
  // exposed for tests: feed a timestamp, run the steps it buys, render once
  function advance(t) {
    let dt = t - last; last = t;
    if (dt > maxFrameMs) dt = maxFrameMs;
    if (dt < 0) dt = 0;
    acc += dt;
    while (acc >= STEP) { step(); acc -= STEP; }
    render(acc / STEP);
  }
  function resetClock() { last = nowFn(); acc = 0; }
  function onVis() { if (typeof document !== 'undefined' && !document.hidden) resetClock(); }

  return {
    start() {
      if (running) return;
      running = true; resetClock();
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis);
      rafFn(frame);
    },
    stop() {
      running = false;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis);
    },
    resetClock, advance,
    get alpha() { return acc / STEP; },
    STEP
  };
}
