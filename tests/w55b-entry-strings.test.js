// STACKLIGHT entry screen strings (node, source check): render() in games/stacklight/main.js builds no entry-screen string per frame.
// This does not use the production `builds` counter (the browser check does; a mutant that rebuilds the strings without
// bumping it got past that check). It reads the source:
//   1. inside render(), the only write to an entry string (scoreStr, modeStr, timeStr) is the TIME line, and it sits behind
//      the "the second changed" guard `if (left !== entryInfo.left) { ... }`
//   2. the entry branch of render(), with that one guarded statement taken out, has no string building at all: no `+`,
//      no template literal, no String(), toString, concat, join, padStart / padEnd, toFixed, slice or repeat
//   3. drawEntry in render.js builds no string either (it draws the strings it is given, the letters and fixed text)
// The browser half (an accessor instrument on the object render() hands to drawEntry) is in w55b-pause-pad-browser.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN = process.env.W55B_MAIN || path.join(ROOT, 'games/stacklight/main.js');
const strip = s => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// the body of the first `function name(...) {` in src, by brace matching on comment-free text (no braces inside strings here)
function body(src, head) {
  const i = src.indexOf(head);
  assert.ok(i >= 0, 'not found: ' + head);
  let d = 0, j = src.indexOf('{', i);
  const start = j;
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}' && --d === 0) break; }
  return src.slice(start + 1, j);
}
const BUILD = [/\+/, /`/, /\bString\s*\(/, /\.toString\s*\(/, /\.concat\s*\(/, /\.join\s*\(/, /\.pad(Start|End)\s*\(/, /\.toFixed\s*\(/, /\.slice\s*\(/, /\.repeat\s*\(/];

test('1. inside render(), the only entry-string write is TIME, behind the second-changed guard', () => {
  const r = body(strip(fs.readFileSync(MAIN, 'utf8')), 'function render(al)');
  const GUARD = /if \(left !== entryInfo\.left\) \{[^{}]*\}/g;
  const guards = r.match(GUARD) || [];
  assert.equal(guards.length, 1, 'one guarded TIME block in render()');
  assert.match(guards[0], /entryInfo\.timeStr\s*=/);
  const rest = r.replace(GUARD, '');
  const writes = rest.match(/entryInfo\.(scoreStr|modeStr|timeStr)\s*=(?!=)/g) || [];
  assert.deepEqual(writes, [], 'entry strings written in render() outside the guard (every frame)');
  assert.ok(!/entryInfo\s*=(?!=)/.test(rest) && !/drawEntry\(entry,\s*\{/.test(rest), 'render() hands drawEntry the one kept entryInfo object');
});

test('2. the entry branch of render() builds no string outside the guard', () => {
  const r = body(strip(fs.readFileSync(MAIN, 'utf8')), 'function render(al)');
  const a = r.indexOf("else if (app === 'entry') {"), b = r.indexOf("else if (app === 'attract')");
  assert.ok(a > 0 && b > a, 'the entry branch is where it was');
  const branch = r.slice(a, b).replace(/if \(left !== entryInfo\.left\) \{[^{}]*\}/, '');
  const found = BUILD.filter(re => re.test(branch)).map(String);
  assert.deepEqual(found, [], 'string building in the entry branch, every frame:\n' + branch);
});

test('3. drawEntry in render.js builds no string', () => {
  const d = body(strip(fs.readFileSync(path.join(ROOT, 'games/stacklight/render.js'), 'utf8')), 'function drawEntry(e, info)');
  // dot coordinates use + on numbers; strings come only from info, e.letter() and literals. No + touches a string literal or info.
  assert.ok(!/['"`]\s*\+|\+\s*['"`]/.test(d), 'a literal joined with +');
  assert.ok(!/info\.\w+\s*\+|\+\s*info\./.test(d), 'an info string joined with +');
  assert.ok(!/`|\bString\s*\(|\.toString\s*\(|\.concat\s*\(|\.join\s*\(|\.toFixed\s*\(/.test(d), 'other string building');
});
