// STACKLIGHT deck (B.3): 3 BARs and 2 PLUSes (LEAN day: 2 and 2), shuffled with Fisher-Yates from the starting
// array using the board's piece stream; deal from index 0 up; a new deck is shuffled when the old one is empty.
// No allocation: the deck lives in a preallocated Uint8Array.
import { DECK, LEAN_DECK } from '../defs.js';

// fills deck[0..len-1] with a fresh shuffle; returns len
export function shuffleDeck(deck, lean, rng) {
  const src = lean ? LEAN_DECK : DECK, len = src.length;
  for (let i = 0; i < len; i++) deck[i] = src[i];
  for (let i = len - 1; i >= 1; i--) {
    const j = rng.int(i + 1), t = deck[i];
    deck[i] = deck[j]; deck[j] = t;
  }
  return len;
}
