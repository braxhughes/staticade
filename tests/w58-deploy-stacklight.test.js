// tools/deploy-site.sh ships stacklight.html and the live smoke checks /stacklight and /stacklight.html
// the way it checks the Starfall pair. Helpers are copied from the Starfall deploy smoke test (not exported from it).
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
  fs.writeFileSync(path.join(d, 'stacklight.html'), '<title>x</title>');
  fs.writeFileSync(path.join(d, 'robots.txt'), 'User-agent: *\nAllow: /\n');
  fs.writeFileSync(path.join(d, 'sitemap.xml'), '<urlset></urlset>\n');
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
const SL_PAGE = '<!doctype html>\n<title>STACKLIGHT</title>\n<canvas></canvas>\n';
const PAGES = { 'index.html': INDEX_PAGE, 'starfall.html': SF_PAGE };
PAGES['stacklight.html'] = SL_PAGE;

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
  fs.copyFileSync(path.join(d, 'stacklight.html'), path.join(bin, 'stacklight.html'));
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
  https://staticade.com/stacklight) bodyf="${path.join(bin, 'stacklight.html')}"
    [ -n "$STUB_SL_BODY" ] && { bodyf=''; body=$STUB_SL_BODY; }; [ -n "$STUB_SL_CODE" ] && code=$STUB_SL_CODE ;;
  https://staticade.com/stacklight.html)
    code=307; h='location: /stacklight'
    [ -n "$STUB_SLH_CODE" ] && code=$STUB_SLH_CODE
    [ "$STUB_SLH_BUILT" = 1 ] && bodyf="${path.join(bin, 'stacklight.html')}"
    [ -n "$STUB_SLH_LOC" ] && h=$STUB_SLH_LOC
    [ "$STUB_SLH_LOC_SET" = 1 ] && h='' ;;
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

function failsWith(env, re) {
  const d = pushedRepo(); const s = stubs(d);
  const r = deploy(d, s, env);
  assert.notEqual(r.status, 0, 'the run must fail:\n' + r.stdout);
  assert.match(r.stdout, re);
  assert.match(r.stderr, /live smoke failed after 2 rounds/);
}

// Git 2.54 stops at "pathspec 'stacklight.html' did not match" (script: "git archive failed") before the
// script's own "missing from archive: stacklight.html" check can run; either message proves the path is required.
test('w58 (a): a repo without stacklight.html fails the build, naming stacklight.html', () => {
  const d = scratch(OK_LINE);
  git(d, 'rm', '-q', 'stacklight.html');
  git(d, 'commit', '-qm', 'drop stacklight');
  const r = run(d, '--dry-run');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing from archive: stacklight\.html|pathspec 'stacklight\.html' did not match[\s\S]*git archive failed/);
});

test('w58 (b): /stacklight answers 404 -> the smoke fails naming /stacklight', () => {
  failsWith({ STUB_SL_CODE: '404' }, /staticade\.com\/stacklight -> HTTP 404 \(want 200, no redirect\)/);
});
test('w58 (b): /stacklight answers 200 with another page -> the smoke fails', () => {
  failsWith({ STUB_SL_BODY: INDEX_PAGE }, /staticade\.com\/stacklight -> 200 but not the built stacklight\.html/);
});
test('w58 (b): /stacklight bad alone -> the Starfall lines are not named', () => {
  const d = pushedRepo(); const s = stubs(d);
  const r = deploy(d, s, { STUB_SL_CODE: '500' });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /staticade\.com\/stacklight -> HTTP 500/);
  assert.doesNotMatch(r.stdout, /staticade\.com\/starfall(\.html)? -> /);
});

test('w58 (c): /stacklight.html 200 with the built page while html_handling wants a redirect -> fails', () => {
  failsWith({ STUB_SLH_CODE: '200', STUB_SLH_BUILT: '1', STUB_SLH_LOC_SET: '1' }, /stacklight\.html -> HTTP 200 \(want a 307 or 308 redirect to \/stacklight\)/);
});
test('w58 (c): /stacklight.html 307 to somewhere else -> fails', () => {
  failsWith({ STUB_SLH_LOC: 'location: /' }, /stacklight\.html -> 307 to '\/' \(want \/stacklight\)/);
});
test('w58 (c): /stacklight.html 307 to /starfall -> fails', () => {
  failsWith({ STUB_SLH_LOC: 'location: /starfall' }, /stacklight\.html -> 307 to '\/starfall' \(want \/stacklight\)/);
});
test('w58 (c): /stacklight.html 307 to another site -> fails', () => {
  failsWith({ STUB_SLH_LOC: 'location: https://evil.example/stacklight' }, /stacklight\.html -> 307 to 'https:\/\/evil\.example\/stacklight'/);
});
test('w58 (c): /stacklight.html 308 to the absolute /stacklight address passes', () => {
  const d = pushedRepo(); const s = stubs(d);
  const r = deploy(d, s, { STUB_SLH_CODE: '308', STUB_SLH_LOC: 'location: ' + ORIGIN + '/stacklight' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('w58 (d): clean dry run lists stacklight.html in the built folder, byte for byte', () => {
  const d = scratch(OK_LINE, null, PAGES);
  const r = run(d, '--dry-run');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const site = keptFolder(r);
  assert.deepEqual(fs.readdirSync(site).filter(f => f.endsWith('.html')).sort(), ['index.html', 'stacklight.html', 'starfall.html']);
  assert.equal(fs.readFileSync(path.join(site, 'stacklight.html'), 'utf8'), SL_PAGE);
});
test('w58 (d): clean --deploy run (stubs) checks both stacklight addresses and passes', () => {
  const d = pushedRepo(); const s = stubs(d);
  const r = deploy(d, s);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /smoke ok: .*\/stacklight/);
  assert.match(r.stdout, /deployed .* and smoke passed/);
  assert.match(s.calls(), /^curl https:\/\/staticade\.com\/stacklight origin=$/m);
  assert.match(s.calls(), /^curl https:\/\/staticade\.com\/stacklight\.html origin=$/m);
  assert.match(s.calls(), /cwd-has: .*site/);
});
