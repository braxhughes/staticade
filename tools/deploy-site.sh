#!/usr/bin/env bash
# What this is: builds the Staticade site folder from the scrubbed public repo and
# (only with --deploy) ships it to staticade.com as the assets-only Worker "staticade".
#
# Usage (run from the root of the public repo or this repo; paths below are absolute):
#   bash tools/deploy-site.sh [--dry-run]   build + leak grep, keep the folder (default)
#   bash tools/deploy-site.sh --deploy      build + leak grep + wrangler deploy + live smoke
#
# Run the public-repo export first (bash ~/Projects/retro-arcade-export.sh <sha>), then
# commit and push in ~/Projects/staticade. This script reads only what is committed there
# (HEAD). --deploy refuses to run if that repo has uncommitted changes or unpushed commits.
#
# Env overrides, for tests only:
#   STATICADE_REPO      git repo folder (default ~/Projects/staticade)
#   SITE_WRANGLER_TOML  site config (default ~/Projects/_ops/retro-arcade/site-wrangler.toml)
#   SMOKE_TRIES         live smoke rounds before giving up (default 6)
#   SMOKE_WAIT          seconds between smoke rounds (default 10)
#
# No private string is written literally in this file: it is copied into the public repo,
# whose own leak check would fail on it. Patterns are built at run time instead.
set -euo pipefail

REPO="${STATICADE_REPO:-$HOME/Projects/staticade}"
WRANGLER_TOML="${SITE_WRANGLER_TOML:-$HOME/Projects/_ops/retro-arcade/site-wrangler.toml}"
SITE_URL="https://staticade.com"
API_URL="https://api.staticade.com"
WRANGLER_VERSION="4.156.0"
SMOKE_TRIES="${SMOKE_TRIES:-6}"
SMOKE_WAIT="${SMOKE_WAIT:-10}"
PATHS=(index.html starfall.html stacklight.html robots.txt sitemap.xml arcade engine games leaderboard server/client.js)
# JS files compared byte for byte with the live site (the edge never rewrites .js).
SAME_BYTES=(server/client.js games/starfall/defs.js)

die() { echo "deploy-site: $*" >&2; exit 1; }
usage() { die "usage: bash tools/deploy-site.sh [--dry-run|--deploy]"; }

MODE=dry
[ $# -le 1 ] || usage
case "${1:-}" in
  ''|--dry-run) MODE=dry ;;
  --deploy) MODE=deploy ;;
  *) usage ;;
esac
case "$SMOKE_TRIES" in ''|*[!0-9]*) die "SMOKE_TRIES must be a whole number" ;; esac
case "$SMOKE_WAIT" in ''|*[!0-9]*) die "SMOKE_WAIT must be a whole number" ;; esac
[ "$SMOKE_TRIES" -ge 1 ] || die "SMOKE_TRIES must be at least 1"

# 0. Who the owner is (for the leak grep). An empty name would silently weaken the grep.
OWNER=$(git config --get user.name 2>/dev/null || true)
[ -n "$(printf '%s' "$OWNER" | tr -d '[:space:]')" ] \
  || die "git config user.name is empty; set it (git config --global user.name ...) so the leak grep can look for the owner's name"
OWNER_EMAIL=$(git config --get user.email 2>/dev/null || true)
LOGIN=$(id -un 2>/dev/null || true)

git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1 || die "not a git repo: $REPO"
SHA=$(git -C "$REPO" rev-parse HEAD)
DIRTY=$(git -C "$REPO" status --porcelain) || die "git status failed in $REPO"

if [ "$MODE" = deploy ]; then
  [ -z "$DIRTY" ] || die "$REPO has uncommitted changes; commit (or discard) them first. Nothing deployed."
  UPSTREAM=$(git -C "$REPO" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null) \
    || die "$REPO has no upstream branch; push it first (git push -u origin main). Nothing deployed."
  AHEAD=$(git -C "$REPO" rev-list '@{u}..HEAD') || die "git rev-list failed in $REPO"
  [ -z "$AHEAD" ] || die "$REPO has commits not pushed to $UPSTREAM; push first. Nothing deployed."
  [ -f "$WRANGLER_TOML" ] || die "missing $WRANGLER_TOML"
elif [ -n "$DIRTY" ]; then
  echo "deploy-site: WARNING, $REPO has uncommitted changes; only committed HEAD is used"
fi

TMPROOT="${TMPDIR:-/tmp}"
TMPROOT="${TMPROOT%/}"
WORK=$(mktemp -d "$TMPROOT/staticade-site.XXXXXX")
case "$WORK" in */staticade-site.*) ;; *) die "bad work dir $WORK" ;; esac
KEEP=0
cleanup() { if [ "$KEEP" -eq 0 ]; then rm -rf -- "$WORK"; fi; }
trap cleanup EXIT
SITE="$WORK/site"
mkdir -p "$SITE"

# Deploy config, copied next to ./site (as its [assets] directory expects) and checked as copied.
if [ "$MODE" = deploy ]; then
  cp "$WRANGLER_TOML" "$WORK/wrangler.toml"
  grep -qx 'name = "staticade"' "$WORK/wrangler.toml" || die "copied wrangler.toml has no line name = \"staticade\"; refusing. Nothing deployed."
  grep -qx 'directory = "./site"' "$WORK/wrangler.toml" || die "copied wrangler.toml has no line directory = \"./site\"; refusing. Nothing deployed."
  # How the assets Worker answers /starfall.html depends on [assets] html_handling (Cloudflare
  # default when the line is absent: "auto-trailing-slash").
  #   auto-trailing-slash, drop-trailing-slash: /starfall serves starfall.html and /starfall.html
  #     answers a 307 (or 308) redirect to /starfall. The smoke check wants exactly that redirect.
  #   anything else, none included: refused here, before anything is deployed. With none,
  #     /starfall has no file behind it, and force-trailing-slash would redirect /starfall to
  #     /starfall/. The smoke check expects neither.
  HH_LINES=$(grep -cE '^[[:space:]]*html_handling[[:space:]]*=' "$WORK/wrangler.toml" || true)
  case "$HH_LINES" in
    0) HTML_HANDLING=auto-trailing-slash ;;
    1)
      HH_RAW=$(grep -E '^[[:space:]]*html_handling[[:space:]]*=' "$WORK/wrangler.toml" | tr -d '\r')
      HTML_HANDLING=$(printf '%s\n' "$HH_RAW" | sed -nE 's/^[[:space:]]*html_handling[[:space:]]*=[[:space:]]*"([^"]*)"[[:space:]]*$/\1/p')
      case "$HTML_HANDLING" in
        auto-trailing-slash|drop-trailing-slash) ;;
        none) die "copied wrangler.toml sets html_handling to none, which is refused: /starfall would have no page behind it. Use auto-trailing-slash or drop-trailing-slash. Line: $HH_RAW. Nothing deployed." ;;
        *) die "copied wrangler.toml html_handling must be auto-trailing-slash or drop-trailing-slash; refusing. Line: $HH_RAW. Nothing deployed." ;;
      esac ;;
    *) die "copied wrangler.toml sets html_handling more than once; refusing. Nothing deployed." ;;
  esac
fi

# 1. Extract exactly the files the browser loads.
git -C "$REPO" archive --format=tar HEAD -- "${PATHS[@]}" | tar -x -f - -C "$SITE" \
  || die "git archive failed (is every path committed in $REPO?)"
for p in "${PATHS[@]}"; do [ -e "$SITE/$p" ] || die "missing from archive: $p"; done

# Only plain files and folders. A symlink could point the deploy at anything on this disk.
ODD=$(cd "$SITE" && find . ! -type f ! -type d -print)
[ -z "$ODD" ] || die "symlink or special file in the site folder; refusing:
$ODD"

# 2. Point the game at the API, in this copy only. Must change exactly one line.
CLIENT="$SITE/server/client.js"
OLD_RE="^export const REMOTE_LEADERBOARD_URL = '';"
[ "$(grep -c "$OLD_RE" "$CLIENT" || true)" = 1 ] \
  || die "REMOTE_LEADERBOARD_URL line is missing, duplicated or already set in client.js; refusing to build"
sed -i.bak "s|^export const REMOTE_LEADERBOARD_URL = '';|export const REMOTE_LEADERBOARD_URL = '$API_URL';|" "$CLIENT"
rm -f "$CLIENT.bak"
[ "$(grep -c "^export const REMOTE_LEADERBOARD_URL = '$API_URL';" "$CLIENT" || true)" = 1 ] \
  || die "REMOTE_LEADERBOARD_URL did not change exactly once"

# 2b. Audit L3 (w54): switch off the test-only ?lb= override in this copy. Starfall's main.js and the lobby's
#     lobby-board.js take ?lb=http://127.0.0.1:<port> (localhost only) to point at the local dev server. Here its
#     address check is replaced by a regex that never matches, so ?lb= is ignored and the page uses
#     REMOTE_LEADERBOARD_URL. Fixed-string replace (perl \Q...\E), in the built copy only. Step 3 checks it is gone.
LB_RE='/^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/?$/'
LB_OFF='/(?!)/'
LB_FILES=$(cd "$SITE" && grep -rlF -- "$LB_RE" . || true)
if [ -n "$LB_FILES" ]; then
  while IFS= read -r f; do
    LB_RE="$LB_RE" LB_OFF="$LB_OFF" perl -pi -e 's/\Q$ENV{LB_RE}\E/$ENV{LB_OFF}/g' "$SITE/$f" || die "could not switch off ?lb= in $f"
  done <<< "$LB_FILES"
fi

# 3. Leak grep on the built folder, contents (text and binary) and file names, ignoring case.
#    Fixed strings: the owner's name (whole and each word of 3+ letters), login, email, and
#    private markers. Each marker is glued from two pieces so this file's text never contains it.
FIXED=("$OWNER")
set -f   # split the name on spaces without expanding * or ? in it
for w in $OWNER; do if [ "${#w}" -ge 3 ]; then FIXED+=("$w"); fi; done
set +f
[ "${#LOGIN}" -lt 3 ] || FIXED+=("$LOGIN")
[ -z "$OWNER_EMAIL" ] || FIXED+=("$OWNER_EMAIL")
FIXED+=("/Us""ers/" "@pro""ton" "ADMIN""_TOKEN" "COORDI""NATOR" "agent""_docs")
# Regular expressions (ERE): a secret assignment with or without spaces.
REGEX=('DAILY''_SECRET[[:space:]]*=')

PATFILE_F="$WORK/patterns-fixed.txt"
PATFILE_E="$WORK/patterns-regex.txt"
: > "$PATFILE_F"
for p in "${FIXED[@]}"; do
  [ -n "$(printf '%s' "$p" | tr -d '[:space:]')" ] || continue   # an empty pattern would match everything
  printf '%s\n' "$p" >> "$PATFILE_F"
done
printf '%s\n' "${REGEX[@]}" > "$PATFILE_E"

NAMES=$(cd "$SITE" && find . -print) || die "find failed listing the site folder"
LEAKS=0
# grep exit codes: 0 = found, 1 = nothing found, anything else = error (not clean).
leak_scan() { # label, grep mode flag (-F or -E), pattern file, what (contents|names)
  local out rc=0
  if [ "$4" = contents ]; then
    out=$(cd "$SITE" && grep -rni "$2" -f "$3" -- .) || rc=$?
  else
    out=$(printf '%s\n' "$NAMES" | grep -ni "$2" -f "$3") || rc=$?
  fi
  case "$rc" in
    0) LEAKS=1; echo "deploy-site: LEAK ($1, $4), forbidden text found:" >&2; printf '%s\n' "$out" | sed 's/^/  /' >&2 ;;
    1) ;;
    *) die "grep failed (exit $rc) during the leak scan ($1, $4); not treating that as clean. Nothing deployed." ;;
  esac
}
leak_scan fixed -F "$PATFILE_F" contents
leak_scan regex -E "$PATFILE_E" contents
leak_scan fixed -F "$PATFILE_F" names
leak_scan regex -E "$PATFILE_E" names
# L3 (w54): no localhost address check may be left, and every file that still reads ?lb= must carry the
# never-matching check from step 2b.
LB_LEFT=$(cd "$SITE" && grep -rnF -- '(127\.0\.0\.1|localhost)' . || true)
if [ -n "$LB_LEFT" ]; then LEAKS=1; echo "deploy-site: LEAK (?lb= override), localhost address check still in the build:" >&2; printf '%s\n' "$LB_LEFT" | sed 's/^/  /' >&2; fi
LB_READERS=$(cd "$SITE" && grep -rlF -- "get('lb')" . || true)
if [ -n "$LB_READERS" ]; then
  while IFS= read -r f; do
    grep -qF -- "$LB_OFF" "$SITE/$f" || { LEAKS=1; echo "deploy-site: LEAK (?lb= override), $f reads ?lb= without the switched-off check" >&2; }
  done <<< "$LB_READERS"
fi
[ "$LEAKS" -eq 0 ] || die "leak grep FAILED; nothing deployed"
rm -f -- "$PATFILE_F" "$PATFILE_E"   # keep only site/ (and later wrangler.toml) in the work folder

COUNT=$(find "$SITE" -type f | wc -l | tr -d ' ')
echo "deploy-site: source commit $SHA"
echo "deploy-site: $COUNT files, leak grep clean, API url set to $API_URL"

if [ "$MODE" = dry ]; then
  KEEP=1
  echo "deploy-site: dry run, nothing deployed. Folder kept:"
  echo "$SITE"
  echo "deploy-site: serve it (from the retro-arcade or staticade folder) with: node tools/serve.mjs <port> '$SITE'"
  exit 0
fi

# 4. Deploy, from the work folder that holds site/ and the checked wrangler.toml.
(cd "$WORK" && npx --yes "wrangler@$WRANGLER_VERSION" deploy) || die "wrangler deploy failed"

# 5. Live smoke. No redirects are followed: each address must answer 200 itself.
BODY="$WORK/smoke-body"
HDRS="$WORK/smoke-headers"
fetch() { # url [origin]; sets CODE, fills $BODY and $HDRS
  : > "$BODY"; : > "$HDRS"
  local args=(-sS -o "$BODY" -D "$HDRS" -w '%{http_code}' --max-time 30 -H 'Cache-Control: no-cache')
  [ -z "${2:-}" ] || args+=(-H "Origin: $2")
  CODE=$(curl "${args[@]}" "$1" 2>/dev/null) || CODE=000
}
# Header lookups in $HDRS: name matched in any case, CR stripped, spaces or tabs after the colon
# skipped. hdr_count prints how many lines carry that header; hdr_value prints the first value.
hdr_count() { tr -d '\r' < "$HDRS" | awk -v n="$1" 'tolower(substr($0, 1, length(n) + 1)) == n ":" { c++ } END { print c + 0 }'; }
hdr_value() { tr -d '\r' < "$HDRS" | awk -v n="$1" 'tolower(substr($0, 1, length(n) + 1)) == n ":" && !f { v = substr($0, length(n) + 2); sub(/^[ \t]+/, "", v); print v; f = 1 }'; }
FAILS=""
note() { FAILS="$FAILS
  $1"; }
smoke_round() {
  FAILS=""
  # Pages must be the built pages byte for byte (like SAME_BYTES below). A fallback index page,
  # a 200 error page or anyone else's page fails, whatever its <title> says.
  fetch "$SITE_URL/"
  if [ "$CODE" != 200 ]; then note "$SITE_URL/ -> HTTP $CODE (want 200, no redirect)"
  elif ! cmp -s "$BODY" "$SITE/index.html"; then note "$SITE_URL/ -> 200 but not the built index.html"; fi

  # One check per game page (Starfall, STACKLIGHT): the same rules for each.
  local g loc
  for g in starfall stacklight; do
    fetch "$SITE_URL/$g"
    if [ "$CODE" != 200 ]; then note "$SITE_URL/$g -> HTTP $CODE (want 200, no redirect)"
    elif ! cmp -s "$BODY" "$SITE/$g.html"; then note "$SITE_URL/$g -> 200 but not the built $g.html"; fi

    # /$g.html: see html_handling where the copied wrangler.toml is checked.
    fetch "$SITE_URL/$g.html"
    loc=$(hdr_value location)
    if [ "$CODE" != 307 ] && [ "$CODE" != 308 ]; then note "$SITE_URL/$g.html -> HTTP $CODE (want a 307 or 308 redirect to /$g)"
    elif [ "$(hdr_count location)" != 1 ]; then note "$SITE_URL/$g.html -> $CODE without exactly one location header"
    elif [ "$loc" != "/$g" ] && [ "$loc" != "$SITE_URL/$g" ]; then note "$SITE_URL/$g.html -> $CODE to '$loc' (want /$g)"; fi
  done

  local f
  for f in "${SAME_BYTES[@]}"; do
    fetch "$SITE_URL/$f"
    if [ "$CODE" != 200 ]; then note "$SITE_URL/$f -> HTTP $CODE"
    elif ! cmp -s "$BODY" "$SITE/$f"; then note "$SITE_URL/$f differs from the built folder (old deploy still served?)"; fi
  done
  fetch "$SITE_URL/server/client.js"
  if [ "$CODE" = 200 ] && ! grep -qF "$API_URL" "$BODY"; then note "$SITE_URL/server/client.js does not contain $API_URL"; fi

  fetch "$API_URL/board?game=starfall" "$SITE_URL"
  if [ "$CODE" != 200 ]; then note "$API_URL/board?game=starfall -> HTTP $CODE"
  else
    grep -qF '"ok":true' "$BODY" || note "$API_URL/board?game=starfall -> no \"ok\":true"
    # Exactly one header line, value exactly the site origin (browsers reject duplicates).
    local acao_n
    acao_n=$(hdr_count access-control-allow-origin)
    if [ "$acao_n" -gt 1 ]; then note "$API_URL/board?game=starfall -> $acao_n access-control-allow-origin lines (want exactly one: $SITE_URL)"
    elif [ "$acao_n" != 1 ] || [ "$(hdr_value access-control-allow-origin)" != "$SITE_URL" ]; then
      note "$API_URL/board?game=starfall -> no access-control-allow-origin: $SITE_URL"
    fi
  fi
  [ -z "$FAILS" ]
}
try=1
until smoke_round; do
  echo "deploy-site: smoke round $try of $SMOKE_TRIES failed:$FAILS"
  [ "$try" -lt "$SMOKE_TRIES" ] || die "live smoke failed after $SMOKE_TRIES rounds. The deploy itself went out; check the site, roll back if needed."
  try=$((try + 1))
  sleep "$SMOKE_WAIT"
done
echo "deploy-site: smoke ok: /, /starfall and /stacklight are the built pages, /starfall.html and /stacklight.html as html_handling $HTML_HANDLING wants, live JS matches the build, board ok with CORS for $SITE_URL"
echo "deploy-site: deployed $SHA and smoke passed"
