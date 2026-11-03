// STACKLIGHT rule-override hook for the T7 bot (measure only). Writes no file.
//
// Usage: node --import ./tools/stacklight-rules.mjs tools/stacklight-bot.mjs --options
//        (the bot's --options re-runs itself this way when the hook is not loaded)
//
// Why it exists: defs.js exports the lock delay (a function), LOCK_RESETS and FREE_LINES_PER_LEVEL as const, so no other
// module can change them, and the sim reads them at call time. To measure candidate rule sets without touching
// games/stacklight/** on disk, this hook changes the text of defs.js as Node loads it, in this process only:
//   * lockDelayFor(level) first checks a table (null = the shipped rule, unchanged)
//   * LOCK_RESETS and FREE_LINES_PER_LEVEL become `let` with the shipped values
//   * two extra exports: __stacklightSetRules({ lockTable, resets, linesPerLevel }) and __stacklightGetRules()
// With no rule set, every value is the shipped one (a test checks the hash of a run is the same with and without it).
// Each change is an exact text match; if defs.js changes shape, loading throws instead of silently measuring nothing.
import { registerHooks } from 'node:module';

function patch(src) {
  const sub = (re, fn, what) => {
    if (!re.test(src)) throw new Error('stacklight-rules: defs.js no longer matches (' + what + '); fix the hook');
    src = src.replace(re, fn);
  };
  sub(/export const LOCK_RESETS = (\d+);/, (m, v) => `export let LOCK_RESETS = ${v};`, 'LOCK_RESETS');
  sub(/export const FREE_LINES_PER_LEVEL = (\d+);/, (m, v) => `export let FREE_LINES_PER_LEVEL = ${v};`, 'FREE_LINES_PER_LEVEL');
  sub(/export function lockDelayFor\(level\) \{ return ([^;{}]+); \}/,
    (m, body) => `let __lockTable = null;\nexport function lockDelayFor(level) { if (__lockTable !== null) return __lockTable[level]; return ${body}; }`,
    'lockDelayFor');
  src += `
export function __stacklightSetRules(r) {
  if ('lockTable' in r) __lockTable = r.lockTable;
  if ('resets' in r) LOCK_RESETS = r.resets;
  if ('linesPerLevel' in r) FREE_LINES_PER_LEVEL = r.linesPerLevel;
}
export function __stacklightGetRules() { return { lockTable: __lockTable, resets: LOCK_RESETS, linesPerLevel: FREE_LINES_PER_LEVEL }; }
`;
  return src;
}

registerHooks({
  load(url, context, nextLoad) {
    const r = nextLoad(url, context);
    if (!url.startsWith('file:') || !url.endsWith('/games/stacklight/defs.js')) return r;
    return { ...r, format: 'module', source: patch(typeof r.source === 'string' ? r.source : new TextDecoder().decode(r.source)), shortCircuit: true };
  }
});
