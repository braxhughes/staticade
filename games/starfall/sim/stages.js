// The 15-stage run table (design.md B.0, B.3). Pure data plus lookups; used at stage setup only.
// Stage s plays row ((s - 1) % 15) + 1 with loop L = floor((s - 1) / 15). Kinds: 'normal', 'bonus' (STARLIGHT), 'boss'.
//
// Enemy mix: every normal stage starts from the v1 base layout (row 0 wardens, rows 1-2 wisps, rows 3-4 moths),
// then applies the row's overrides in order (a later override wins a slot). Slots are [row, col] in the formation.
// Type ids that are not registered yet (sim/registry.js) fall back to 'moth'.

export const STAGE_ROWS = 15;
export const ZONE_NAMES = ['', 'LANTERN REACH', 'GLASS TIDE', 'HOLLOW SUN'];

// slot sets
const SPLIT4 = [[3, 1], [3, 8], [4, 2], [4, 7]];             // v1 splitters (stage 2+)
const SPLIT6 = [...SPLIT4, [3, 4], [3, 5]];
// B.3 lists each Z2/Z3 stage as additions ("+") to the Z1 mix (moth, wisp, warden, splitters, Lamplighter),
// so splitters stay in later zones. In Z2 they sit in row 3 because row 4 holds the Eel ribbons in stages 7-8.
const SPLIT_Z2 = [[3, 1], [3, 8], [3, 4], [3, 5]];
const SPLIT_Z3 = [[3, 1], [3, 8], [4, 2], [4, 7]];
const LAMP = [[2, 3]];                                       // 4th member of entry group 3 (GROUPS[2])
const PRISM4 = [[1, 1], [1, 2], [1, 5], [1, 6]];
const PRISM6 = [...PRISM4, [1, 0], [1, 7]];
const EEL2 = [[4, 0], [4, 1], [4, 2], [4, 3], [4, 4], [4, 5], [4, 6], [4, 7], [4, 8], [4, 9]]; // two 5-segment ribbons
// Cinders in rows 3-4 (B.3). Stage 13 also has two Eels, which take all of row 4, so its Cinders are all in row 3.
const CINDER6 = [[3, 0], [3, 9], [3, 4], [3, 5], [4, 0], [4, 9]];
const CINDER6_S13 = [[3, 0], [3, 9], [3, 4], [3, 5], [3, 2], [3, 7]];
const MIRAGE4 = [[1, 0], [1, 7], [2, 0], [2, 7]];
const MIRAGE6 = [...MIRAGE4, [1, 3], [1, 4]];
// Tetherling pairs (B.11 3.1): each pair is two neighbouring slots that are consecutive members of one entry group.
// Stage 6: row 4, columns 2+3 and 6+7 (group TL). Stages 7-8: row 2, columns 0+1 and 6+7 (group SR; row 4 is Eels).
// The pair order here is the pair index in sim/enemies/tether.js (TETHER_SLOTS).
export const TETHER6 = [[4, 2], [4, 3], [4, 6], [4, 7]];
export const TETHER78 = [[2, 0], [2, 1], [2, 6], [2, 7]];

const mix = (...pairs) => { const out = []; for (let i = 0; i < pairs.length; i += 2) out.push({ type: pairs[i], slots: pairs[i + 1] }); return out; };

// row index 1..15 (index 0 unused)
export const STAGE_TABLE = [
  null,
  { zone: 1, kind: 'normal', mix: [] },
  { zone: 1, kind: 'normal', mix: mix('splitter', SPLIT4, 'lamplighter', LAMP) },
  { zone: 1, kind: 'normal', mix: mix('splitter', SPLIT6, 'lamplighter', LAMP) },
  { zone: 1, kind: 'bonus', enemies: 36 },
  { zone: 1, kind: 'boss', boss: 'eclipse' },
  { zone: 2, kind: 'normal', mix: mix('splitter', SPLIT_Z2, 'lamplighter', LAMP, 'prism', PRISM4, 'tether', TETHER6) },
  { zone: 2, kind: 'normal', mix: mix('splitter', SPLIT_Z2, 'lamplighter', LAMP, 'prism', PRISM4, 'eel', EEL2, 'tether', TETHER78) },
  { zone: 2, kind: 'normal', mix: mix('splitter', SPLIT_Z2, 'lamplighter', LAMP, 'prism', PRISM6, 'eel', EEL2, 'tether', TETHER78) },
  { zone: 2, kind: 'bonus', enemies: 42 },
  { zone: 2, kind: 'boss', boss: 'moonwell' },
  { zone: 3, kind: 'normal', mix: mix('splitter', SPLIT_Z3, 'lamplighter', LAMP, 'cinder', CINDER6) },
  { zone: 3, kind: 'normal', mix: mix('splitter', SPLIT_Z3, 'lamplighter', LAMP, 'cinder', CINDER6, 'mirage', MIRAGE4) },
  { zone: 3, kind: 'normal', mix: mix('splitter', SPLIT_Z3, 'lamplighter', LAMP, 'cinder', CINDER6_S13, 'mirage', MIRAGE6, 'eel', EEL2) },
  { zone: 3, kind: 'bonus', enemies: 48 },
  { zone: 3, kind: 'boss', boss: 'pyre' }
];

export const rowOf = s => ((Math.max(1, s) - 1) % STAGE_ROWS) + 1;
export const loopOf = s => Math.floor((Math.max(1, s) - 1) / STAGE_ROWS);
export const stageRow = s => STAGE_TABLE[rowOf(s)];

// v1 base type of a formation slot
export const baseType = r => r === 0 ? 'warden' : r <= 2 ? 'wisp' : 'moth';

// the type id the table asks for at slot (r, c) on row `row` (before the registry fallback)
export function slotType(row, r, c) {
  const R = STAGE_TABLE[row];
  let t = baseType(r);
  if (!R || !R.mix) return t;
  for (let i = 0; i < R.mix.length; i++) {
    const S = R.mix[i].slots;
    for (let k = 0; k < S.length; k++) if (S[k][0] === r && S[k][1] === c) { t = R.mix[i].type; break; }
  }
  return t;
}
