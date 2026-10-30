// Hit-stop and shake per gameplay event (design.md B.9). S14 tunes these numbers.
// stop: sim frames of hit-stop (stacks, never above HITSTOP_CAP). shake: render units; set = replace instead of max.
export const HITSTOP_CAP = 8;

export const FEEL = {
  kill: { stop: 0, shake: 0, set: false },        // normal kill
  close: { stop: 1, shake: 1, set: false },       // diving enemy killed within 32 units of the player
  big: { stop: 3, shake: 3, set: false },         // Warden / Prism / Mirage kill
  interrupt: { stop: 4, shake: 3, set: false },   // Warden killed during its dive telegraph
  piece: { stop: 3, shake: 4, set: true },        // boss piece destroyed
  phase: { stop: 8, shake: 6, set: false },       // boss phase change
  bossDeath: { stop: 8, shake: 8, set: true },
  wingLost: { stop: 2, shake: 3, set: false },
  death: { stop: 5, shake: 7, set: true }         // player death
};

// enemy types whose kill is a 'big' kill
export const BIG_KILLS = { warden: true, prism: true, mirage: true };
export const CLOSE_RANGE = 32;

// telegraph lengths in sim frames (B.9)
export const TELE_DIVE = 20, TELE_WARDEN = 30, TELE_AIM = 20;
// volley-wait rule (B.5): a volley that would go over the bullet cap waits up to this many frames, then is skipped
export const VOLLEY_WAIT = 30;

// apply one feel event to the sim (S.hitstop is the sim-side counter; shake leaves as a render event)
export function feel(S, id) {
  const F = FEEL[id];
  if (F.stop) S.addHitstop(F.stop);
  if (F.shake) S.shake(F.shake, F.set);
}
