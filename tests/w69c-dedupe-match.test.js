// server/dedupe.js matches() pinned exactly, with no hash. STACKLIGHT signatures built by hand
// from pieceKey / placeCode: 20 events, one per piece. Two placements match only when they are the very same
// placement (row, column and orientation all equal) on the same piece. One row or one column off, or the other
// orientation, is a miss, at any position in the list. similarity() is the real exported function.
// Columns 0 to 2 are used so a +-1 shift never lands on the mirror of another column (the mirror of c is 8 - c, 6 to 8),
// and no column is 4 (its own mirror); rows 2 to 10 so a shift stays on the board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { similarity, pieceKey, placeCode, MIN_EVENTS } from '../server/dedupe.js';

const N = 20;
assert.ok(N >= MIN_EVENTS);
const cell = n => ({ row: 2 + (n % 9), col: n % 3, rot: n % 2 });
function sig(edit) {
  const s = [];
  for (let n = 0; n < N; n++) {
    let { row, col, rot } = cell(n);
    if (edit && edit.n === n) ({ row, col, rot } = edit.f({ row, col, rot }));
    s.push(pieceKey(n), placeCode(row, col, rot));
  }
  return s;
}
const base = sig();

test('identical placements match: similarity exactly 1', () => {
  assert.equal(similarity(base, sig()), 1);
});

test('one placement one row, one column or one orientation off is a miss: exactly (N-1)/N, at every position', () => {
  const edits = {
    'row +1': c => ({ ...c, row: c.row + 1 }),
    'row -1': c => ({ ...c, row: c.row - 1 }),
    'col +1': c => ({ ...c, col: c.col + 1 }),
    'col -1': c => ({ ...c, col: c.col - 1 }),
    'orientation flipped': c => ({ ...c, rot: 1 - c.rot })
  };
  for (const [name, f] of Object.entries(edits)) {
    for (let n = 0; n < N; n++) {
      const c = cell(n);
      if (name === 'col -1' && c.col === 0) continue; // off the board's left edge
      const x = similarity(base, sig({ n, f })), y = similarity(sig({ n, f }), base);
      assert.equal(x, (N - 1) / N, `${name} at event ${n}: ${x}`);
      assert.equal(y, (N - 1) / N, `${name} at event ${n}, other way round: ${y}`);
    }
  }
});

test('every placement one column off: nothing matches (0), not 1', () => {
  const s = [];
  for (let n = 0; n < N; n++) { const c = cell(n); s.push(pieceKey(n), placeCode(c.row, c.col + 1, c.rot)); }
  assert.equal(similarity(base, s), 0);
  const r = [];
  for (let n = 0; n < N; n++) { const c = cell(n); r.push(pieceKey(n), placeCode(c.row + 1, c.col, c.rot)); }
  assert.equal(similarity(base, r), 0);
});
