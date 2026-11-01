// the live smoke checks in tools/deploy-site.sh each fail on their own bad answer.
// Every --deploy run uses stub npx and curl placed first on PATH; the real ones are never reached.
// No private string is written literally here (this file is copied into the public repo, whose
// leak check would fail on it): every planted leak is glued together at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'deploy-site.sh');
// The commit email has no dot after the @ so no email-shaped text appears in this file.
const G = ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@localhost'];
const API = 'https://api.staticade.com';
const OK_LINE = "export const REMOTE_LEADERBOARD_URL = '';";
const HOME_DIR = '/Us' + 'ers/';
const OWNER = 'Zed Quokkaman';          // the fake owner every run sees in git config

// Every scratch folder made here is removed when the file finishes, pass or fail.
const made = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const git = (cwd, ...a) => {
  const r = spawnSync('git', [...G, ...a], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

// A fake public repo with the paths the site needs. `files` adds or overrides files (path -> content).
function scratch(clientLine, extra, files = {}) {
  const d = tmp('w39-test-');
  for (const dir of ['arcade', 'engine', 'games/starfall', 'leaderboard', 'server']) fs.mkdirSync(path.join(d, dir), { recursive: true });
  fs.writeFileSync(path.join(d, 'index.html'), '<title>x</title>');
  fs.writeFileSync(path.join(d, 'starfall.html'), '<title>x</title>');
  for (const dir of ['arcade', 'engine', 'games', 'leaderboard']) fs.writeFileSync(path.join(d, dir, 'a.js'), extra && dir === 'engine' ? extra : '// ok\n');
  fs.writeFileSync(path.join(d, 'games', 'starfall', 'defs.js'), "export const GAME_VERSION = 'v-test';\n");
  fs.writeFileSync(path.join(d, 'server', 'client.js'), clientLine + '\n');
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true });
    fs.writeFileSync(path.join(d, p), c);
  }
  git(d, 'init', '-q');
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'x');
  return d;
}

// Global git config for the script: a fake owner, nothing from the real machine.
function gitConfig(name, email = 'nobody') {
  const f = path.join(tmp('w39-cfg-'), 'gitconfig');
  fs.writeFileSync(f, (name === null ? '' : `[user]\n\tname = ${name}\n\temail = ${email}\n`));
  return f;
}
const CFG = gitConfig(OWNER);

function envFor(d, more = {}) {
  return { ...process.env, STATICADE_REPO: d, GIT_CONFIG_GLOBAL: CFG, GIT_CONFIG_NOSYSTEM: '1', ...more };
}
const runEnv = (env, ...args) => spawnSync('bash', [script, ...args], { env, cwd: os.tmpdir(), encoding: 'utf8' });
const run = (d, ...args) => runEnv(envFor(d), ...args);

// Removes the folder a passing dry run keeps; returns the site folder path.
function keptFolder(r) {
  const folder = r.stdout.trim().split('\n').find(l => l.endsWith('/site'));
  assert.ok(folder, 'dry run prints the kept folder on its own line');
  made.push(path.dirname(folder));
  return folder;
}
function assertLeak(r, re) {
  assert.notEqual(r.status, 0, 'leak must fail the run');
  assert.match(r.stderr, /LEAK/);
  if (re) assert.match(r.stderr, re);
}

const TOML_OK = 'name = "staticade"\ncompatibility_date = "2026-10-01"\n\n[assets]\ndirectory = "./site"\n';

// the two pages differ, so serving one at the other's address is caught by the byte compare.
const INDEX_PAGE = '<!doctype html>\n<title>Lobby</title>\n<p>lobby page</p>\n';
const SF_PAGE = '<!doctype html>\n<title>Starfall</title>\n<canvas></canvas>\n';
const PAGES = { 'index.html': INDEX_PAGE, 'starfall.html': SF_PAGE };

// A repo with a pushed upstream (a local bare repo), so the push check can pass.
function pushedRepo(files = PAGES) {
  const d = scratch(OK_LINE, null, files);
  const bare = tmp('w39-bare-');
  git(bare, 'init', '-q', '--bare');
  git(d, 'remote', 'add', 'origin', bare);
  const branch = git(d, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  git(d, 'push', '-q', '-u', 'origin', branch);
  return d;
}

// stub dir with npx (records its args and folder) and curl (answers like the live site, or breaks one thing)
function stubs(d) {
  const bin = tmp('w39-stub-');
  const log = path.join(bin, 'calls.log');
  const builtClient = path.join(bin, 'client.js');
  fs.writeFileSync(builtClient, `export const REMOTE_LEADERBOARD_URL = '${API}';\n`);
  fs.copyFileSync(path.join(d, 'games', 'starfall', 'defs.js'), path.join(bin, 'defs.js'));
  fs.copyFileSync(path.join(d, 'index.html'), path.join(bin, 'index.html'));
  fs.copyFileSync(path.join(d, 'starfall.html'), path.join(bin, 'starfall.html'));
  fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/bash
echo "npx $* | cwd-has: $(ls | tr '\\n' ' ')" >> "${log}"
exit "\${STUB_NPX_EXIT:-0}"
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/bash
out=/dev/null; hdr=/dev/null; origin=; url=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    -D) hdr=$2; shift ;;
    -H) case "$2" in Origin:*) origin=\${2#Origin: } ;; esac; shift ;;
    -w|--max-time) shift ;;
    -L|--location) echo "curl stub: redirects must not be followed" >&2; exit 99 ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
echo "curl $url origin=$origin" >> "${log}"
# Pages and JS are served from exact copies of the built files (bodyf); an override body is sent as is.
code=200; body=''; bodyf=''; h=''
case "$url" in
  https://staticade.com/) bodyf="${path.join(bin, 'index.html')}"
    [ -n "$STUB_ROOT_BODY" ] && { bodyf=''; body=$STUB_ROOT_BODY; }; [ -n "$STUB_ROOT_CODE" ] && code=$STUB_ROOT_CODE ;;
  https://staticade.com/starfall) bodyf="${path.join(bin, 'starfall.html')}"
    [ -n "$STUB_SF_BODY" ] && { bodyf=''; body=$STUB_SF_BODY; }; [ -n "$STUB_SF_CODE" ] && code=$STUB_SF_CODE ;;
  https://staticade.com/starfall.html)
    # default: what the assets Worker does with html_handling auto-trailing-slash
    code=307; h='location: /starfall'
    [ -n "$STUB_SFH_CODE" ] && code=$STUB_SFH_CODE
    [ "$STUB_SFH_BUILT" = 1 ] && bodyf="${path.join(bin, 'starfall.html')}"
    [ -n "$STUB_SFH_BODY" ] && body=$STUB_SFH_BODY
    [ -n "$STUB_SFH_LOC" ] && h=$STUB_SFH_LOC
    [ "$STUB_SFH_LOC_SET" = 1 ] && h='' ;;
  https://staticade.com/server/client.js) bodyf="${builtClient}" ;;
  https://staticade.com/games/starfall/defs.js) bodyf="${path.join(bin, 'defs.js')}" ;;
  'https://api.staticade.com/board?game=starfall')
    body='{"ok":true,"rows":[]}'
    if [ -n "$STUB_CORS_LINE" ]; then h=$STUB_CORS_LINE
    elif [ "$STUB_CORS_LINE_SET" != 1 ] && [ -n "$origin" ]; then h="access-control-allow-origin: $origin"; fi ;;
  *) code=404; body='' ;;
esac
printf 'HTTP/2 %s\\r\\n%s\\r\\n\\r\\n' "$code" "$h" > "$hdr"
if [ -n "$bodyf" ]; then cat "$bodyf" > "$out"; else printf '%s' "$body" > "$out"; fi
printf '%s' "$code"
`, { mode: 0o755 });
  const toml = path.join(bin, 'site-wrangler.toml');
  fs.writeFileSync(toml, TOML_OK);
  return { bin, log, toml, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}
function deploy(d, s, more = {}) {
  return runEnv(envFor(d, { PATH: s.bin + ':' + process.env.PATH, SITE_WRANGLER_TOML: s.toml, SMOKE_TRIES: '2', SMOKE_WAIT: '0', ...more }), '--deploy');
}


const ORIGIN = 'https://staticade.com';
const CORS = (v) => ({ STUB_CORS_LINE: 'access-control-allow-origin: ' + v });
const NO_CORS = { STUB_CORS_LINE_SET: '1' };   // the board answers 200 with no CORS header at all

function failsWith(env, re) {
  const d = pushedRepo(); const s = stubs(d);
  const r = deploy(d, s, env);
  assert.notEqual(r.status, 0, 'the run must fail:\n' + r.stdout);
  assert.match(r.stdout, re);
  assert.match(r.stderr, /live smoke failed after 2 rounds/);
}

test('smoke control: every answer good, run exits 0', () => {
  const d = pushedRepo(); const s = stubs(d);
  const r = deploy(d, s);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /deployed .* and smoke passed/);
  assert.match(s.calls(), /^curl https:\/\/staticade\.com\/starfall origin=$/m);
  assert.match(s.calls(), /^curl https:\/\/staticade\.com\/starfall\.html origin=$/m);
});

// ---------- /starfall ----------
test('smoke: /starfall answers 200 with a body that has no <title> -> fails naming /starfall', () => {
  failsWith({ STUB_SF_BODY: 'fake page, no title here' }, /staticade\.com\/starfall -> 200 but not the built starfall\.html/);
});
test('smoke: /starfall answers 200 with an empty body -> fails', () => {
  failsWith({ STUB_SF_BODY: ' ' }, /staticade\.com\/starfall -> 200 but not the built starfall\.html/);
});
test('smoke: /starfall answers 404 -> fails naming /starfall', () => {
  failsWith({ STUB_SF_CODE: '404' }, /staticade\.com\/starfall -> HTTP 404/);
});
test('smoke: /starfall answers a redirect (307) -> fails, redirects are not followed', () => {
  failsWith({ STUB_SF_CODE: '307' }, /staticade\.com\/starfall -> HTTP 307/);
});
test('smoke: root and /starfall both bad in the same run -> both are named (one does not hide the other)', () => {
  const d = pushedRepo(); const s = stubs(d);
  const r = deploy(d, s, { STUB_ROOT_CODE: '500', STUB_SF_CODE: '500' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /staticade\.com\/ -> HTTP 500/);
  assert.match(r.stdout, /staticade\.com\/starfall -> HTTP 500/);
});
test('smoke: /starfall bad alone -> only /starfall is named, the good root is not', () => {
  const d = pushedRepo(); const s = stubs(d);
  const r = deploy(d, s, { STUB_SF_CODE: '500' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /staticade\.com\/starfall -> HTTP 500/);
  assert.doesNotMatch(r.stdout, /staticade\.com\/ -> /);
});

// ---------- CORS ----------
test('smoke: board has no access-control-allow-origin header -> fails naming the header', () => {
  failsWith(NO_CORS, /no access-control-allow-origin: https:\/\/staticade\.com/);
});
for (const [name, v] of [
  ['*', '*'],
  ['another origin', 'https://evil.example'],
  ['a lookalike origin (dot is not a wildcard)', 'https://staticadeXcom'],
  ['a subdomain of the site', 'https://www.staticade.com'],
  ['the site plus a second origin', ORIGIN + ', https://evil.example'],
  ['the site with a trailing space', ORIGIN + ' '],
  ['the site with a trailing slash', ORIGIN + '/'],
  ['http instead of https', 'http://staticade.com'],
  ['null', 'null'],
]) {
  test(`smoke: CORS value ${name} -> fails`, () => {
    failsWith(CORS(v), /no access-control-allow-origin: https:\/\/staticade\.com/);
  });
}
test('smoke: a different header that merely mentions the origin does not count', () => {
  failsWith({ STUB_CORS_LINE: 'x-access-control-allow-origin: ' + ORIGIN }, /no access-control-allow-origin/);
});
test('smoke: CORS exactly the site origin passes, header name in any case', () => {
  for (const line of ['access-control-allow-origin: ' + ORIGIN, 'Access-Control-Allow-Origin: ' + ORIGIN]) {
    const d = pushedRepo(); const s = stubs(d);
    const r = deploy(d, s, { STUB_CORS_LINE: line });
    assert.equal(r.status, 0, line + '\n' + r.stdout + r.stderr);
  }
});

// ---------- <title> on the root ----------
test('smoke: live / answers 200 with no <title> -> fails naming the root', () => {
  failsWith({ STUB_ROOT_BODY: '<h1>hello</h1>' }, /staticade\.com\/ -> 200 but not the built index\.html/);
});
test('smoke: live / answers 200 with an empty body -> fails', () => {
  failsWith({ STUB_ROOT_BODY: ' ' }, /staticade\.com\/ -> 200 but not the built index\.html/);
});
test('smoke: live / answers 307 -> fails naming the root', () => {
  failsWith({ STUB_ROOT_CODE: '307' }, /staticade\.com\/ -> HTTP 307/);
});

// ---------- pages must be the built pages, byte for byte ----------
const NOT_INDEX = /staticade\.com\/ -> 200 but not the built index\.html/;
const NOT_SF = /staticade\.com\/starfall -> 200 but not the built starfall\.html/;
test('w39d probe: /starfall serves the index page (SPA fallback) -> fails naming /starfall', () => {
  failsWith({ STUB_SF_BODY: INDEX_PAGE }, NOT_SF);
});
test('w39d probe: /starfall answers 200 with <title>404 Not Found</title> -> fails', () => {
  failsWith({ STUB_SF_BODY: '<html><title>404 Not Found</title></html>' }, NOT_SF);
});
test('w39d probe: root answers 200 with <title>404 Not Found</title> -> fails', () => {
  failsWith({ STUB_ROOT_BODY: '<html><title>404 Not Found</title></html>' }, NOT_INDEX);
});
test('w39d probe: root answers 200 with <title>Hello World</title> -> fails naming the root', () => {
  failsWith({ STUB_ROOT_BODY: '<!doctype html><title>Hello World</title>' }, NOT_INDEX);
});
test('w39d: root serves the starfall page -> fails', () => {
  failsWith({ STUB_ROOT_BODY: SF_PAGE }, NOT_INDEX);
});
test('w39d: /starfall is the built page plus one extra byte -> fails', () => {
  failsWith({ STUB_SF_BODY: SF_PAGE + ' ' }, NOT_SF);
});
test('w39d: the page check does not depend on the title text (built pages with new titles pass)', () => {
  const d = pushedRepo({ 'index.html': '<title>Renamed lobby</title>\n', 'starfall.html': '<title>Renamed game</title>\n' });
  const s = stubs(d);
  const r = deploy(d, s);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ---------- /starfall.html ----------
const SFH = /staticade\.com\/starfall\.html -> /;
test('w39d: /starfall.html 308 to /starfall passes (auto-trailing-slash, the default)', () => {
  const d = pushedRepo(); const s = stubs(d);
  const r = deploy(d, s, { STUB_SFH_CODE: '308' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
test('w39d: /starfall.html 307 to the absolute /starfall address passes', () => {
  const d = pushedRepo(); const s = stubs(d);
  const r = deploy(d, s, { STUB_SFH_LOC: 'Location:\t' + ORIGIN + '/starfall' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
test('w39d: /starfall.html 200 with the built page, but html_handling wants a redirect -> fails', () => {
  failsWith({ STUB_SFH_CODE: '200', STUB_SFH_BUILT: '1', STUB_SFH_LOC_SET: '1' }, /starfall\.html -> HTTP 200 \(want a 307 or 308/);
});
test('w39d: /starfall.html 404 -> fails', () => {
  failsWith({ STUB_SFH_CODE: '404', STUB_SFH_LOC_SET: '1' }, /starfall\.html -> HTTP 404/);
});
test('w39d: /starfall.html 307 to somewhere else -> fails', () => {
  failsWith({ STUB_SFH_LOC: 'location: /' }, /starfall\.html -> 307 to '\/' \(want \/starfall\)/);
});
test('w39d: /starfall.html 307 to another site -> fails', () => {
  failsWith({ STUB_SFH_LOC: 'location: https://evil.example/starfall' }, /starfall\.html -> 307 to 'https:\/\/evil\.example\/starfall'/);
});
test('w39d: /starfall.html 307 with no location header -> fails', () => {
  failsWith({ STUB_SFH_LOC_SET: '1' }, /starfall\.html -> 307 without exactly one location header/);
});
test('w39d: /starfall.html 307 with two location headers -> fails', () => {
  failsWith({ STUB_SFH_LOC: 'location: https://evil.example/\r\nlocation: /starfall' }, /starfall\.html -> 307 without exactly one location header/);
});

for (const [name, loc] of [
  ['/starfall/', '/starfall/'],
  ['/starfallx', '/starfallx'],
  ['/starfall?x=1', '/starfall?x=1'],
  ['a lookalike host with /starfall', 'https://staticade.com.evil.example/starfall'],
]) {
  test(`w39e: /starfall.html 307 to ${name} -> fails with the to '...' message`, () => {
    failsWith({ STUB_SFH_LOC: 'location: ' + loc }, new RegExp("starfall\\.html -> 307 to '" + loc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "' \\(want /starfall\\)"));
  });
}

function withToml(extra) {
  const d = pushedRepo(); const s = stubs(d);
  fs.writeFileSync(s.toml, TOML_OK + extra);
  return { d, s };
}
const NONE = 'html_handling = "none"\n';
// none is refused in the gate, before wrangler runs, with its own message and the raw toml line.
for (const [name, extra, line] of [
  ['none', NONE, 'html_handling = "none"'],
  ['none with no spaces', 'html_handling="none"\n', 'html_handling="none"'],
  ['none with tabs and indent', '\thtml_handling\t=\t"none"\n', '\thtml_handling\t=\t"none"'],
  ['none in a CRLF file', 'html_handling = "none"\r\n', 'html_handling = "none"'],
]) {
  test(`w39e: html_handling ${name} -> refused before any wrangler call`, () => {
    const { d, s } = withToml(extra);
    const r = deploy(d, s);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /sets html_handling to none, which is refused/);
    assert.match(r.stderr, /Nothing deployed/);
    assert.ok(r.stderr.includes('Line: ' + line + '.'), r.stderr);
    assert.equal(s.calls(), '', 'no npx and no curl call');
  });
}
test('w39e: a commented-out # html_handling = "none" line is ignored (deploy passes with the 307 stub)', () => {
  const { d, s } = withToml('# html_handling = "none"\n  #html_handling="none"\n');
  const r = deploy(d, s);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /html_handling auto-trailing-slash/);
});
test('w39e: an unquoted html_handling value is refused and the message shows the raw line', () => {
  const { d, s } = withToml('html_handling = none\n');
  const r = deploy(d, s);
  assert.notEqual(r.status, 0);
  assert.ok(r.stderr.includes('Line: html_handling = none.'), r.stderr);
  assert.doesNotMatch(r.stderr, /got ''/);
  assert.doesNotMatch(s.calls(), /npx/);
});
test('w39d: html_handling drop-trailing-slash is accepted and wants the redirect', () => {
  const { d, s } = withToml('html_handling = "drop-trailing-slash"\n');
  const r = deploy(d, s);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
for (const [name, extra] of [
  ['force-trailing-slash', 'html_handling = "force-trailing-slash"\n'],
  ['an unknown value', 'html_handling = "spa"\n'],
  ['set twice', NONE + 'html_handling = "auto-trailing-slash"\n'],
]) {
  test(`w39d: html_handling ${name} -> refused before anything is deployed`, () => {
    const { d, s } = withToml(extra);
    const r = deploy(d, s);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /html_handling/);
    assert.match(r.stderr, /Nothing deployed/);
    assert.doesNotMatch(s.calls(), /npx/);
  });
}

// ---------- CORS header count and whitespace ----------
test('w39d: two access-control-allow-origin lines (another origin, then the site) -> fails', () => {
  failsWith({ STUB_CORS_LINE: 'access-control-allow-origin: https://evil.example\r\naccess-control-allow-origin: ' + ORIGIN },
    /2 access-control-allow-origin lines \(want exactly one/);
});
test('w39d: two access-control-allow-origin lines (the site, then another origin) -> fails', () => {
  failsWith({ STUB_CORS_LINE: 'access-control-allow-origin: ' + ORIGIN + '\r\nAccess-Control-Allow-Origin: https://evil.example' },
    /2 access-control-allow-origin lines/);
});
test('w39d: the site origin twice -> fails (browsers reject duplicates)', () => {
  failsWith({ STUB_CORS_LINE: 'access-control-allow-origin: ' + ORIGIN + '\r\naccess-control-allow-origin: ' + ORIGIN },
    /2 access-control-allow-origin lines/);
});
test('w39d: a tab (or no space) after the header colon passes', () => {
  for (const line of ['access-control-allow-origin:\t' + ORIGIN, 'Access-Control-Allow-Origin:' + ORIGIN]) {
    const d = pushedRepo(); const s = stubs(d);
    const r = deploy(d, s, { STUB_CORS_LINE: line });
    assert.equal(r.status, 0, JSON.stringify(line) + '\n' + r.stdout + r.stderr);
  }
});
