// STACKLIGHT board: a Uint8Array(COLS * TOTAL_ROWS), index = row * COLS + col, row 0 at the bottom (C.1).
// Cell values: 0 empty, 1 BAR, 2 PLUS, 3 SHADE, 4 RIDGE. No allocation in any function here.
import { COLS, TOTAL_ROWS, CELLS, SPAWN_ZONE_ROW, EMPTY } from '../defs.js';

export function createBoard() { return new Uint8Array(CELLS); }

export function cellAt(grid, c, r) { return grid[r * COLS + c]; }

// height of a column = 1 + its highest filled row (0 if empty)
export function columnHeight(grid, c) {
  for (let r = TOTAL_ROWS - 1; r >= 0; r--) if (grid[r * COLS + c] !== EMPTY) return r + 1;
  return 0;
}

// fill each column from row 0 up to heights[c] with one cell type (B.7 test start, B.9 ridges)
export function fillHeights(grid, heights, type) {
  for (let c = 0; c < COLS; c++) for (let r = 0; r < heights[c]; r++) grid[r * COLS + c] = type;
}

// bit r set when row r is full (every column filled)
export function fullRowMask(grid) {
  let mask = 0;
  for (let r = 0; r < TOTAL_ROWS; r++) {
    let full = true;
    for (let c = 0, o = r * COLS; c < COLS; c++) if (grid[o + c] === EMPTY) { full = false; break; }
    if (full) mask |= 1 << r;
  }
  return mask;
}

// B.5: remove every row in mask; rows above drop by the number of removed rows below them (whole rows, no melting).
// Handles any count of rows. Returns the number removed.
export function clearRows(grid, mask) {
  let dst = 0, n = 0;
  for (let r = 0; r < TOTAL_ROWS; r++) {
    if (mask & (1 << r)) { n++; continue; }
    if (dst !== r) for (let c = 0; c < COLS; c++) grid[dst * COLS + c] = grid[r * COLS + c];
    dst++;
  }
  for (let r = dst; r < TOTAL_ROWS; r++) for (let c = 0; c < COLS; c++) grid[r * COLS + c] = EMPTY;
  return n;
}

// B.1 ceiling rule: true if any cell is in the spawn zone (rows 18 to 20)
export function spawnZoneUsed(grid) {
  for (let i = SPAWN_ZONE_ROW * COLS; i < CELLS; i++) if (grid[i] !== EMPTY) return true;
  return false;
}

export function popcount(m) { let n = 0; while (m) { m &= m - 1; n++; } return n; }
