// The per-frame gameplay input word (16 bits). This is what replays record and the sim reads.
//   bits 0-8  payload: analog move (128 + round(move * 127)), or touch target x (0..511) when TOUCH is set
//   bit 9     fire held
//   bit 10    fire pressed this frame
//   bit 11    second action (kindle) pressed this frame
//   bit 12    TOUCH: payload is a playfield x the ship steers toward
//   bits 13-15 reserved (0)
export const W_PAYLOAD = 0x1ff, W_FIRE = 1 << 9, W_FIRE_PRESS = 1 << 10, W_ALT_PRESS = 1 << 11, W_TOUCH = 1 << 12;
export const MOVE_ZERO = 128, MOVE_SCALE = 127;
export const IDLE_WORD = MOVE_ZERO;

export function packWord(move, fire, firePress, altPress, touchActive, touchX) {
  let w;
  if (touchActive) {
    let tx = Math.round(touchX);
    if (!(tx >= 0)) tx = 0; else if (tx > W_PAYLOAD) tx = W_PAYLOAD;
    w = W_TOUCH | tx;
  } else {
    const m = move < -1 ? -1 : move > 1 ? 1 : (move || 0);
    w = MOVE_ZERO + Math.round(m * MOVE_SCALE);
  }
  if (fire) w |= W_FIRE;
  if (firePress) w |= W_FIRE_PRESS;
  if (altPress) w |= W_ALT_PRESS;
  return w;
}
// move in [-1, 1] (0 for touch words)
export function wordMove(w) { return (w & W_TOUCH) ? 0 : ((w & W_PAYLOAD) - MOVE_ZERO) / MOVE_SCALE; }
export function wordTouchX(w) { return w & W_PAYLOAD; }
