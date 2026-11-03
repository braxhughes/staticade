// STACKLIGHT pieces (B.2): cell offsets from the pivot, collision, rotation with sideways kicks (B.6) and MELT (B.4).
// Shapes: 0 = BAR flat (H), 1 = BAR upright (V), 2 = PLUS. Offsets are listed lowest row first, which is the
// order MELT takes the cells in. No allocation in any function here.
import { COLS, TOTAL_ROWS, EMPTY, BAR, PLUS, ROT_H, ROT_V } from '../defs.js';

export const SHAPE_BAR_H = 0, SHAPE_BAR_V = 1, SHAPE_PLUS = 2;
export const SHAPE_N = Uint8Array.of(3, 3, 5);
// 5 slots per shape
export const SHAPE_DX = Int8Array.of(-1, 0, 1, 0, 0, /* V */ 0, 0, 0, 0, 0, /* PLUS */ 0, -1, 0, 1, 0);
export const SHAPE_DY = Int8Array.of(0, 0, 0, 0, 0, /* V */ 0, 1, 2, 0, 0, /* PLUS */ 0, 1, 1, 1, 2);

export function shapeOf(type, rot) { return type === PLUS ? SHAPE_PLUS : rot === ROT_V ? SHAPE_BAR_V : SHAPE_BAR_H; }

// true if every cell of the shape with its pivot at (px, py) is inside the board and empty
export function fits(grid, shape, px, py) {
  const o = shape * 5, n = SHAPE_N[shape];
  for (let i = 0; i < n; i++) {
    const c = px + SHAPE_DX[o + i], r = py + SHAPE_DY[o + i];
    if (c < 0 || c >= COLS || r < 0 || r >= TOTAL_ROWS) return false;
    if (grid[r * COLS + c] !== EMPTY) return false;
  }
  return true;
}

// B.6 rotate. Writes the new pivot column into out[0] and returns true, or returns false (no turn).
// BAR H to V: pivot stays, cells go up (needs pivot +1 and +2 rows free). V to H: pivot stays, cells go sideways;
// if blocked, try shifted +1 column, then -1 column. Nothing ever moves up. PLUS never turns (the caller handles it).
export function tryTurn(grid, type, rot, px, py, out) {
  if (type !== BAR) return false;
  if (rot === ROT_H) {
    if (fits(grid, SHAPE_BAR_V, px, py)) { out[0] = px; return true; }
    return false;
  }
  if (fits(grid, SHAPE_BAR_H, px, py)) { out[0] = px; return true; }
  if (fits(grid, SHAPE_BAR_H, px + 1, py)) { out[0] = px + 1; return true; }
  if (fits(grid, SHAPE_BAR_H, px - 1, py)) { out[0] = px - 1; return true; }
  return false;
}

// B.4 MELT: take the cells from lowest row to highest; each drops straight down while the cell below it is empty and
// above row 0; then it is part of the stack. Writes each cell's (col, fromRow, toRow) into meltOut (3 per cell).
// Returns how many cells moved (0 = FIT).
export function meltInto(grid, shape, px, py, cellType, meltOut) {
  const o = shape * 5, n = SHAPE_N[shape];
  let moved = 0;
  for (let i = 0; i < n; i++) {
    const c = px + SHAPE_DX[o + i], r0 = py + SHAPE_DY[o + i];
    let r = r0;
    while (r > 0 && grid[(r - 1) * COLS + c] === EMPTY) r--;
    grid[r * COLS + c] = cellType;
    if (r !== r0) moved++;
    meltOut[i * 3] = c; meltOut[i * 3 + 1] = r0; meltOut[i * 3 + 2] = r;
  }
  return moved;
}
