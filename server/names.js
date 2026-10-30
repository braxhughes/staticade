// Player names on the server (MED6): exactly 3 letters A-Z, the same as the game's name entry (games/starfall/modes.js
// LETTERS, NAME_LEN). Lower case is taken and shown upper case. BLOCKED: 3-letter combinations that are slurs or
// obscene, refused with bad_name. One plain list; add to it when a new one turns up (POST /admin/hide removes an
// entry already on a board). Kept short on purpose: words that are also ordinary names or identities (GAY, JEW, HOE,
// ARS, ...) are not on it. Reviewed and extended in the w22 fix round (29 to 51 entries).
export const BLOCKED = [
  // obscene words and their 3-letter spellings
  'ANL', 'ASS', 'BCH', 'CLT', 'CNT', 'COC', 'COK', 'CUM', 'CUN', 'DCK', 'DIC', 'DIK', 'DIX', 'FAP', 'FCK', 'FKN', 'FKR',
  'FKU', 'FUC', 'FUK', 'FUQ', 'FUX', 'JIZ', 'KNT', 'KUM', 'MFK', 'PIS', 'PNS', 'PRN', 'SEX', 'SHT', 'SLT', 'TIT', 'TWT',
  'VAG', 'WNK', 'WTF', 'XXX',
  // slurs and hate symbols
  'FAG', 'FGT', 'JAP', 'KKK', 'KYK', 'KYS', 'NAZ', 'NGA', 'NGG', 'NGR', 'NIG', 'RTD', 'WOP',
];
const SET = new Set(BLOCKED);
const NAME3 = /^[A-Za-z]{3}$/;

// Returns the name upper-cased, or null when it is not 3 letters or is blocked.
export function cleanName(name) {
  if (typeof name !== 'string' || !NAME3.test(name)) return null;
  const up = name.toUpperCase();
  return SET.has(up) ? null : up;
}
