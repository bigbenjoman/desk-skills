#!/usr/bin/env bash
# suite: auto-release (a pass installs desk-skills main once it passed its tests check)
# maintenance.mjs step on a fixed clock (DESK_MAINT_NOW), against a fake desk-skills checkout cloned
# from a scratch origin, a stubbed check-status command, an install.sh that records each run and
# writes installed.json, and fake queues for this repo and another. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(cd "$(mktemp -d)" && pwd -P)"
trap 'kill "$(cat "$T/holder" 2>/dev/null)" 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/desk" "$T/state"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  DESK_MAINT_NOW DESK_BOOT_TIME DESK_SOURCE_CHECKOUT DESK_RELEASE_CHECK_CMD
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
cat > "$T/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |

## 3b. Cost and autonomy
| Field | Recommended | Your setting |
|---|---|---|
| Maintenance window | \`none\` | \`none\` |
EOF

# desk-skills: a scratch origin and the checkout cloned from it on main. Its install.sh records each
# run with how much it read on stdin, and writes installed.json as the real one does.
git init -q -b main "$T/seed"
printf '#!/bin/sh\necho "installed stdin=$(wc -c | tr -d " ")" >> "%s/install.calls"\nprintf %s "$(git rev-parse HEAD)" > "%s/desk/installed.json"\n' \
  "$T" "'{\"commit\": \"%s\"}\n'" "$T" > "$T/seed/install.sh"
chmod +x "$T/seed/install.sh"
git -C "$T/seed" add install.sh; git -C "$T/seed" commit -q -m one
git init -q --bare -b main "$T/origin.git"; git -C "$T/seed" push -q "$T/origin.git" main
git clone -q -b main "$T/origin.git" "$T/desk-src"
(cd "$T/desk-src" && ./install.sh </dev/null); : > "$T/install.calls"
# upstream <message> [<file>]: lands a commit on origin, adding <file> when given.
upstream(){ if [ -n "${2:-}" ]; then echo x > "$T/seed/$2"; git -C "$T/seed" add "$2"; fi
  git -C "$T/seed" commit -q --allow-empty -m "$1"; git -C "$T/seed" push -q "$T/origin.git" main; }
originhead(){ git -C "$T/seed" rev-parse HEAD; }
srchead(){ git -C "$T/desk-src" rev-parse HEAD; }

# The check: prints $T/check.state and records the commit asked about.
printf '#!/bin/sh\necho "$1" >> "%s/check.calls"\ncat "%s/check.state"\n' "$T" "$T" > "$T/check.sh"
echo pending > "$T/check.state"

export DESK_CONFIG="$T/config.md" DESK_HOME="$T/desk" DESK_AUTOPILOT_STATE="$T/state" DESK_QUEUE="$T/queue.json" \
  DESK_SOURCE_CHECKOUT="$T/desk-src" DESK_RELEASE_CHECK_CMD="sh $T/check.sh" DESK_MAINT_DIR="$T/maint"
printf '{"version":1,"batch":"r","tickets":{}}\n' > "$T/queue.json"
cd "$T/repo" || exit 1
calls(){ if [ -f "$T/$1.calls" ]; then wc -l < "$T/$1.calls" | tr -d ' '; else echo 0; fi; }
mlog(){ cat "$T/maint/maintenance.log" 2>/dev/null; }
fetched(){ node -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).fetched_at ?? "") } catch { console.log("") }' "$T/maint/release.json"; }
installed(){ node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).commit)' "$T/desk/installed.json"; }
pushes(){ node -e 'console.log(JSON.parse(process.argv[1]).push.length)' "$out"; }
# One step at the given time: $out is its JSON.
step(){ out=$(DESK_MAINT_NOW="$1" node "$B/maintenance.mjs" step 2>&1); }

# ---- AC7: main equal to the installed commit ---------------------------------------------------
step 2026-10-27T09:00:00Z
check "AC7 origin is fetched, nothing else"                 '[ "$(fetched)" = 2026-10-27T09:00:00.000Z ] && [ "$(calls check)" = 0 ] && [ "$(calls install)" = 0 ] && ! grep -q "release:" <<< "$out"'
step 2026-10-27T09:02:00Z
check "AC7 not fetched again within 5 minutes"              '[ "$(fetched)" = 2026-10-27T09:00:00.000Z ] && [ "$(calls check)" = 0 ]'
old=$(srchead); upstream two; new=$(originhead)
step 2026-10-27T09:04:00Z
check "AC7 a commit landed since is not seen until the next fetch" '[ "$(calls check)" = 0 ] && ! grep -q "release:" <<< "$out"'

# ---- AC2: the check pending --------------------------------------------------------------------
step 2026-10-27T09:06:00Z
check "AC2 fetched after 5 minutes and the check is read on origin/main's head" '[ "$(fetched)" = 2026-10-27T09:06:00.000Z ] && grep -qx "$new" "$T/check.calls"'
check "AC2 nothing is pulled or installed"                  '[ "$(srchead)" = "$old" ] && [ "$(calls install)" = 0 ]'
check "AC2 the report says it waits for the check"          'grep -q "release: desk-skills main ${new:0:12} is ahead of the installed ${old:0:12}; waiting for main'"'"'s tests check on it" <<< "$out"'

# ---- AC3: the check failed ---------------------------------------------------------------------
echo failure > "$T/check.state"
step 2026-10-27T09:07:00Z
check "AC3 nothing is pulled or installed"                  '[ "$(srchead)" = "$old" ] && [ "$(calls install)" = 0 ]'
check "AC3 one push names the commit"                       '[ "$(pushes)" = 1 ] && grep -q "release-failed-$new" <<< "$out" && grep -q "check failed (failure) on ${new:0:12}" <<< "$out"'
step 2026-10-27T09:08:00Z
check "AC3 a later pass returns the same push, so a failed send is tried again, and logs nothing new" '[ "$(pushes)" = 1 ] && grep -q "release-failed-$new" <<< "$out" && [ "$(mlog | grep -c "check failed")" = 1 ]'
git init -q -b main "$T/repo2"; git -C "$T/repo2" commit -q --allow-empty -m init
out=$(cd "$T/repo2" && DESK_MAINT_NOW=2026-10-27T09:08:30Z node "$B/maintenance.mjs" step 2>&1)
check "AC3 another repo's pass does not push it"            '[ "$(pushes)" = 0 ] && grep -q "check failed (failure) on ${new:0:12}" <<< "$out"'
sleep 300 & echo $! > "$T/holder"
mkdir -p "$T/maint/release.lock.d"; cat "$T/holder" > "$T/maint/release.lock.d/pid"
step 2026-10-27T09:09:00Z
check "AC3 a pass that cannot take the release lock still returns the push, so its key is kept" '[ "$(pushes)" = 1 ] && grep -q "release-failed-$new" <<< "$out" && grep -q "release: skipped" <<< "$out"'
kill "$(cat "$T/holder")"; rm -r "$T/maint/release.lock.d"

# ---- AC4: a worker at Stage 7 ------------------------------------------------------------------
upstream three; new=$(originhead); echo success > "$T/check.state"
mkdir -p "$T/desk/repos/other"
printf '{"version":1,"batch":"o","tickets":{"O-1":{"key":"O-1","state":"running","stage":"7/9"},"O-2":{"key":"O-2","state":"running","stage":"4/9"}}}\n' > "$T/desk/repos/other/queue.json"
step 2026-10-27T09:15:00Z
check "AC4 the install waits"                               '[ "$(srchead)" = "$old" ] && [ "$(calls install)" = 0 ]'
check "AC3 once origin/main moves past the failed commit its push stops" '[ "$(pushes)" = 0 ]'
check "AC4 the report names the worker, and only it"        'grep -q "waiting to install it for other O-1 at Stage 7\"" <<< "$out"'
rm -r "$T/desk/repos"
printf '{"version":1,"batch":"r","tickets":{"R-1":{"key":"R-1","state":"running","stage":null,"handoff_stage":7}}}\n' > "$T/queue.json"
step 2026-10-27T09:16:00Z
check "AC4 a worker started at Stage 7 in this repo's queue holds it too" '[ "$(calls install)" = 0 ] && grep -q "R-1 at Stage 7" <<< "$out"'
printf '{"version":1,"batch":"r","tickets":{}}\n' > "$T/queue.json"

# ---- AC5: the checkout off main, dirty, or with untracked files in the way --------------------
git -C "$T/desk-src" checkout -q -b side
step 2026-10-27T09:17:00Z
check "AC5 off main: nothing installed, the reason recorded" '[ "$(calls install)" = 0 ] && grep -q "is on side, not main" <<< "$out" && mlog | grep -q "release: ${new:0:12} not installed: .* is on side, not main"'
step 2026-10-27T09:18:00Z
check "AC5 the reason is recorded once per commit"          '! grep -q "release:" <<< "$out" && [ "$(mlog | grep -c "is on side")" = 1 ]'
git -C "$T/desk-src" checkout -q main
echo changed >> "$T/desk-src/install.sh"
step 2026-10-27T09:19:00Z
check "AC5 tracked changes: nothing installed, said"        '[ "$(calls install)" = 0 ] && grep -q "uncommitted changes to tracked files" <<< "$out"'
git -C "$T/desk-src" checkout -q -- install.sh
git -C "$T/desk-src" commit -q --allow-empty -m local
step 2026-10-27T09:20:00Z
check "AC5 local commits origin/main lacks: nothing installed, said" '[ "$(calls install)" = 0 ] && grep -q "has commits on main that ${new:0:12} does not" <<< "$out"'
git -C "$T/desk-src" reset -q --hard "$old"
upstream four added.txt; new=$(originhead)
echo mine > "$T/desk-src/added.txt"
step 2026-10-27T09:25:00Z
check "AC5 an untracked file an incoming commit writes blocks it, named" '[ "$(calls install)" = 0 ] && grep -q "untracked files the incoming commits would overwrite (added.txt)" <<< "$out" && [ "$(srchead)" = "$old" ]'
git -C "$T/desk-src" clean -fq -- added.txt

# ---- AC1: passed, nobody pushing, a clean main; unrelated untracked files do not block ----------
mkdir -p "$T/desk-src/.playwright-mcp" "$T/desk-src/docs/brand"
echo a > "$T/desk-src/.playwright-mcp/log.txt"; echo b > "$T/desk-src/docs/brand/logo.svg"
step 2026-10-27T09:26:00Z
check "AC1 the checkout is fast-forwarded to origin/main's head" '[ "$(srchead)" = "$new" ]'
check "AC1 install.sh runs once with nothing on stdin"      '[ "$(calls install)" = 1 ] && grep -qx "installed stdin=0" "$T/install.calls"'
check "AC1 installed.json names the new commit"             '[ "$(installed)" = "$new" ]'
check "AC1 the report and the log say so"                   'grep -q "release: desk-skills ${old:0:12} -> ${new:0:12} (3 commit(s)) installed" <<< "$out" && mlog | grep -q "release: desk-skills ${old:0:12} -> ${new:0:12}"'
check "AC5 the unrelated untracked files are left"          '[ -f "$T/desk-src/.playwright-mcp/log.txt" ] && [ -f "$T/desk-src/docs/brand/logo.svg" ]'
step 2026-10-27T09:27:00Z
check "AC1 the next pass has nothing to do"                 '[ "$(calls install)" = 1 ] && ! grep -q "release:" <<< "$out"'

# ---- AC6: two passes at once -------------------------------------------------------------------
upstream five; new=$(originhead)
sleep 300 & echo $! > "$T/holder"
mkdir -p "$T/maint/release.lock.d"; cat "$T/holder" > "$T/maint/release.lock.d/pid"
step 2026-10-27T09:40:00Z
check "AC6 while another pass holds the lock this one skips" '[ "$(calls install)" = 1 ] && grep -q "release: skipped, another pass is checking or installing desk-skills" <<< "$out"'
kill "$(cat "$T/holder")"; rm -r "$T/maint/release.lock.d"
DESK_MAINT_NOW=2026-10-27T09:41:00Z node "$B/maintenance.mjs" step > "$T/a.out" 2>&1 &
DESK_MAINT_NOW=2026-10-27T09:41:00Z node "$B/maintenance.mjs" step > "$T/b.out" 2>&1 &
wait
check "AC6 two passes at the same moment install once"      '[ "$(calls install)" = 2 ] && [ "$(installed)" = "$new" ]'

# ---- AC8: the maintenance window open ----------------------------------------------------------
upstream six; new=$(originhead)
printf '{"week":"x","phase":"draining","since":"2026-10-27T09:59:00.000Z","window":"Mon 06:30 UTC"}\n' > "$T/maint/maintenance.json"
printf '{"version":1,"batch":"r","tickets":{"R-2":{"key":"R-2","state":"running","stage":"3/9"}}}\n' > "$T/queue.json"
step 2026-10-27T10:00:00Z
check "AC8 an open window: the auto-release does nothing"   '[ "$(calls install)" = 2 ] && ! grep -q "release:" <<< "$out" && grep -q "maintenance: draining" <<< "$out"'

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
