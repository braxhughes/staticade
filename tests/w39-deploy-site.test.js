// tools/deploy-site.sh refuses bad input. Uses scratch git repos; never deploys, never runs the real wrangler.
// The --deploy runs use stub npx and curl placed first on PATH; the real ones are never reached.
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
const LOGIN = os.userInfo().username;    // what `id -un` prints for the script

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

test('dry run builds, sets the url once, keeps the folder', () => {
  const r = run(scratch(OK_LINE), '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  const folder = keptFolder(r);
  assert.ok(/REMOTE_LEADERBOARD_URL = 'https:\/\/api\.staticade\.com';/.test(fs.readFileSync(path.join(folder, 'server', 'client.js'), 'utf8')));
});
test('fails when the url line is already set', () => {
  const r = run(scratch("export const REMOTE_LEADERBOARD_URL = 'https://x.example';"), '--dry-run');
  assert.notEqual(r.status, 0);
});
test('fails when the url line is missing', () => {
  assert.notEqual(run(scratch('// nothing'), '--dry-run').status, 0);
});
test('fails on a planted home-folder path and prints it', () => {
  const r = run(scratch(OK_LINE, '// ' + HOME_DIR + 'someone/x\n'), '--dry-run');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, new RegExp(HOME_DIR + 'someone'));
});
test('rejects an unknown flag', () => {
  assert.notEqual(spawnSync('bash', [script, '--bogus'], { encoding: 'utf8' }).status, 0);
});

// ---------- serve hint ----------
test('serve hint quotes the folder and has no double slash', () => {
  const r = runEnv(envFor(scratch(OK_LINE), { TMPDIR: os.tmpdir() + '/' }), '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  const folder = keptFolder(r);
  assert.ok(!folder.includes('//'), folder);
  assert.ok(r.stdout.includes(`node tools/serve.mjs <port> '${folder}'`), r.stdout);
});

// ---------- the leak patterns, each one planted (mixed case where it can be) ----------
const leakCases = [
  ['owner surname, lower case', 'quokkaman was here', /quokkaman/i],
  ['owner first name, upper case', 'ZED IS THE OWNER', /ZED/],
  ['the owner email', 'mail nobody here', null],
  ['the owner email domain', 'x' + '@Pro' + 'ton.example', null],
  ['the admin token name, lower case', 'admin' + '_token = 1', /admin_token/],
  ['the daily secret with spaces', 'DAILY' + '_SECRET = abc', null],
  ['the daily secret without a space', 'daily' + '_secret=abc', null],
  ['the private notes folder, mixed case', 'see Agent' + '_Docs here', null],
  ['the private state file name, lower case', 'ask the ' + 'COORDI'.toLowerCase() + 'nator', null],
];
for (const [name, text, re] of leakCases) {
  test(`leak grep catches ${name}`, () => assertLeak(run(scratch(OK_LINE, '// ' + text + '\n'), '--dry-run'), re));
}
test('control: clean input passes with the same fake owner (so the cases above fail for the leak, not the setup)', () => {
  const r = run(scratch(OK_LINE), '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  keptFolder(r);
});
test('leak grep catches the login running the script', { skip: LOGIN.length < 3 }, () => {
  assertLeak(run(scratch(OK_LINE, '// by ' + LOGIN + '\n'), '--dry-run'));
});
test('leak grep checks file names too', () => {
  const r = run(scratch(OK_LINE, null, { 'games/Quokkaman-notes.js': '// clean\n' }), '--dry-run');
  assertLeak(r, /Quokkaman-notes/);
});
test('leak grep checks file names ignoring case', () => {
  assertLeak(run(scratch(OK_LINE, null, { 'games/quokkaman.js': '// clean\n' }), '--dry-run'), /quokkaman\.js/);
});
test('a short owner name (no word of 3 letters) is still searched as a whole', () => {
  const env = envFor(scratch(OK_LINE, '// by al wu\n'), { GIT_CONFIG_GLOBAL: gitConfig('Al Wu') });
  assertLeak(runEnv(env, '--dry-run'), /al wu/);
});
test('leak grep reads binary files', () => {
  const bin = Buffer.concat([Buffer.from([0, 1, 2, 0, 255]), Buffer.from(HOME_DIR + 'x'), Buffer.from([0, 0])]);
  const d = scratch(OK_LINE);
  fs.writeFileSync(path.join(d, 'games', 'blob.bin'), bin);
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'bin');
  assertLeak(run(d, '--dry-run'), /blob\.bin/);
});
test('a symlink in the site folder is refused', () => {
  const d = scratch(OK_LINE);
  fs.symlinkSync('../index.html', path.join(d, 'games', 'link.html'));
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'link');
  const r = run(d, '--dry-run');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /symlink/);
  assert.match(r.stderr, /link\.html/);
});
test('an empty git user.name stops the run with a message', () => {
  for (const cfg of [gitConfig(null), gitConfig('   ')]) {
    const r = runEnv(envFor(scratch(OK_LINE), { GIT_CONFIG_GLOBAL: cfg }), '--dry-run');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /user\.name is empty/);
  }
});
test('a grep error during the leak scan fails the run, not counted as clean', () => {
  const bin = tmp('w39-bin-');
  const realGrep = spawnSync('bash', ['-c', 'command -v grep'], { encoding: 'utf8' }).stdout.trim();
  // grep that errors (exit 2) on the leak scan's pattern-file calls and behaves normally otherwise
  fs.writeFileSync(path.join(bin, 'grep'), `#!/bin/bash\nfor a in "$@"; do [ "$a" = -f ] && exit 2; done\nexec ${realGrep} "$@"\n`, { mode: 0o755 });
  const r = runEnv(envFor(scratch(OK_LINE), { PATH: bin + ':' + process.env.PATH }), '--dry-run');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /grep failed \(exit 2\)/);
});

// ---------- --deploy with stub npx and curl ----------
const TOML_OK = 'name = "staticade"\ncompatibility_date = "2026-10-01"\n\n[assets]\ndirectory = "./site"\n';

// A repo with a pushed upstream (a local bare repo), so the push check can pass.
function pushedRepo(files) {
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
code=200; body='<title>x</title>'; h=''
case "$url" in
  https://staticade.com/) [ "$STUB_BREAK" = root ] && { code=307; body=''; } ;;
  https://staticade.com/starfall) ;;
  https://staticade.com/server/client.js) body=$(cat "${builtClient}"); [ "$STUB_BREAK" = client ] && body="export const REMOTE_LEADERBOARD_URL = '';" ;;
  https://staticade.com/games/starfall/defs.js) body=$(cat "${path.join(bin, 'defs.js')}"); [ "$STUB_BREAK" = stale ] && body="export const GAME_VERSION = 'old';" ;;
  'https://api.staticade.com/board?game=starfall')
    body='{"ok":true,"rows":[]}'
    [ "$STUB_BREAK" = boardok ] && body='{"ok":false}'
    [ -n "$origin" ] && [ "$STUB_BREAK" != cors ] && h="access-control-allow-origin: $origin" ;;
  *) code=404; body='' ;;
esac
printf 'HTTP/2 %s\\r\\n%s\\r\\n\\r\\n' "$code" "$h" > "$hdr"
printf '%s\\n' "$body" > "$out"
printf '%s' "$code"
`, { mode: 0o755 });
  const toml = path.join(bin, 'site-wrangler.toml');
  fs.writeFileSync(toml, TOML_OK);
  return { bin, log, toml, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '') };
}
function deploy(d, s, more = {}) {
  return runEnv(envFor(d, { PATH: s.bin + ':' + process.env.PATH, SITE_WRANGLER_TOML: s.toml, SMOKE_TRIES: '2', SMOKE_WAIT: '0', ...more }), '--deploy');
}

test('deploy: clean pushed repo deploys with pinned wrangler and passes smoke (stubs)', () => {
  const d = pushedRepo(); const s = stubs(d);
  const r = deploy(d, s);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /smoke passed/);
  const calls = s.calls();
  assert.match(calls, /^npx --yes wrangler@4\.156\.0 deploy \| cwd-has: site wrangler\.toml/m);
  assert.match(calls, /curl https:\/\/staticade\.com\/ origin=$/m);
  assert.match(calls, /curl https:\/\/staticade\.com\/server\/client\.js origin=$/m);
  assert.match(calls, /curl https:\/\/api\.staticade\.com\/board\?game=starfall origin=https:\/\/staticade\.com$/m);
});
test('deploy: uncommitted changes stop it before wrangler', () => {
  const d = pushedRepo(); const s = stubs(d);
  fs.writeFileSync(path.join(d, 'engine', 'a.js'), '// edited\n');
  const r = deploy(d, s);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /uncommitted changes/);
  assert.doesNotMatch(s.calls(), /npx/);
});
test('deploy: an untracked file stops it too', () => {
  const d = pushedRepo(); const s = stubs(d);
  fs.writeFileSync(path.join(d, 'new.txt'), 'x');
  const r = deploy(d, s);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(s.calls(), /npx/);
});
test('deploy: commits not pushed stop it before wrangler', () => {
  const d = pushedRepo(); const s = stubs(d);
  fs.writeFileSync(path.join(d, 'engine', 'a.js'), '// newer\n');
  git(d, 'commit', '-qam', 'local only');
  const r = deploy(d, s);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not pushed/);
  assert.doesNotMatch(s.calls(), /npx/);
});
test('deploy: no upstream stops it before wrangler', () => {
  const d = scratch(OK_LINE); const s = stubs(d);
  const r = deploy(d, s);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /has no upstream branch/);
  assert.doesNotMatch(s.calls(), /npx/);
});
test('deploy: a site config with the wrong name or folder is refused before wrangler', () => {
  for (const bad of [TOML_OK.replace('"staticade"', '"arcade-lb"'), TOML_OK.replace('./site', './public'), '']) {
    const d = pushedRepo(); const s = stubs(d);
    fs.writeFileSync(s.toml, bad);
    const r = deploy(d, s);
    assert.notEqual(r.status, 0, bad);
    assert.match(r.stderr, /copied wrangler\.toml has no line (name|directory)/);
    assert.doesNotMatch(r.stdout, /leak grep clean/, 'refused before the build');
    assert.doesNotMatch(s.calls(), /npx/);
  }
});
test('deploy: wrangler failure exits non-zero with no smoke', () => {
  const d = pushedRepo(); const s = stubs(d);
  const r = deploy(d, s, { STUB_NPX_EXIT: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /wrangler deploy failed/);
  assert.doesNotMatch(s.calls(), /curl/);
});
for (const [brk, re] of [
  ['root', /staticade\.com\/ -> HTTP 307/],
  ['client', /client\.js differs|does not contain/],
  ['stale', /defs\.js differs/],
  ['boardok', /no "ok":true/],
  ['cors', /no access-control-allow-origin/],
]) {
  test(`deploy: smoke failure (${brk}) exits non-zero`, () => {
    const d = pushedRepo(); const s = stubs(d);
    const r = deploy(d, s, { STUB_BREAK: brk });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, re);
    assert.match(r.stderr, /live smoke failed after 2 rounds/);
  });
}
test('deploy: a leak stops it before wrangler', () => {
  const d = pushedRepo({ 'engine/b.js': '// ' + HOME_DIR + 'x\n' }); const s = stubs(d);
  const r = deploy(d, s);
  assertLeak(r);
  assert.doesNotMatch(s.calls(), /npx/);
});
