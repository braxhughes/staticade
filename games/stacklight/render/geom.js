// STACKLIGHT screen geometry and colours (design B.1 and B.10). Field units: the 400 x 300 field, y down.
// Board x 141.5 to 258.5 (9 columns of 13), visible rows y 40 to 274 (18 rows of 13, row 0 at the bottom),
// spawn zone (rows 18 to 20) y 1 to 40, drawn above the frame.
export const W = 400, H = 300, CX = 200;
export const CELL = 13;
export const BX0 = 141.5, BX1 = 258.5;
export const BY_FLOOR = 274, BY_CEIL = 40, BY_TOP = 1;

// centre of column c, centre of row r
export const colX = c => BX0 + c * CELL + CELL / 2;
export const rowY = r => BY_FLOOR - r * CELL - CELL / 2;

// Colours are plain arrays with generic (tagged) elements: a component read from one is passed to gfx.dot as the heap
// number it already is. An all-number array literal stores raw doubles, and every read passed to a call the compiler
// did not inline makes a new heap number (seen in a heap profile).
const rgb = (r, g, b) => { const c = [null, null, null]; c[0] = r; c[1] = g; c[2] = b; return c; };

// B.10 colours. BAR teal and PLUS amber are the cabinet palette (arcade/machines.js stacklight entry).
export const C_BAR = rgb(0.2, 1, 0.75);
export const C_PLUS = rgb(0.9, 1, 0.3);
export const C_STEEL = rgb(0.65, 0.8, 0.72);   // SHADE (30%) and RIDGE (45%)
export const C_WHITE = rgb(1, 1, 1);
// cabinet palette for the frame, labels and the title (arcade/machines.js: edge, marqueeTop, marqueeBottom)
export const C_EDGE = rgb(0.3, 1, 0.55);
export const C_TOP = rgb(0.6, 1, 0.65);
export const C_LOW = rgb(0.1, 0.85, 0.85);
export const C_DIM = rgb(0.42, 0.6, 0.52);
export const C_WARN = rgb(1, 0.45, 0.4);

// B.10 brightness: settled 55%, SHADE 30%, RIDGE 45%
export const SETTLED_A = 0.55, SHADE_A = 0.3, RIDGE_A = 0.45;

// cell type (C.1: 1 BAR, 2 PLUS, 3 SHADE, 4 RIDGE) to colour and settled brightness
export const TYPE_COL = [C_WHITE, C_BAR, C_PLUS, C_STEEL, C_STEEL];
export const TYPE_A = [0, SETTLED_A, SETTLED_A, SHADE_A, RIDGE_A];
