#!/usr/bin/env bash
# suite: auto-release (a pass installs desk-skills main once it passed its tests check)
# layer: L2
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
# run with its arguments and how much it read on stdin, and writes installed.json as the real one does.
# It prints $T/install.out where there is one, as the real one prints what installed.mjs restart said.
git init -q -b main "$T/seed"
printf '#!/bin/sh\necho "installed args=$* stdin=$(wc -c | tr -d " ")" >> "%s/install.calls"\nprintf %s "$(git rev-parse HEAD)" > "%s/desk/installed.json"\n[ -f "%s/install.out" ] && cat "%s/install.out"\ntrue\n' \
  "$T" "'{\"commit\": \"%s\"}\n'" "$T" "$T" "$T" > "$T/seed/install.sh"
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

# The check: prints $T/check.<commit> where there is one, else $T/check.state, and records the commit
# asked about.
printf '#!/bin/sh\necho "$1" >> "%s/check.calls"\nif [ -f "%s/check.$1" ]; then cat "%s/check.$1"; else cat "%s/check.state"; fi\n' "$T" "$T" "$T" "$T" > "$T/check.sh"
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
# #773: a ticket handed off to Stage 7 is triaged with its handoff pending until its session starts,
# keeping the stage its last session reached.
printf '{"version":1,"batch":"r","tickets":{"R-2":{"key":"R-2","state":"triaged","stage":"6/9","handoff":"pending","handoff_stage":"7"},"R-3":{"key":"R-3","state":"triaged","stage":"3/9","handoff":"pending","handoff_stage":"4b"}}}\n' > "$T/queue.json"
step 2026-10-27T09:16:20Z
check "#773 a ticket waiting on its Stage 7 session holds the install, named as waiting" '[ "$(calls install)" = 0 ] && grep -q "waiting to install it for .*R-2 waiting on its Stage 7 session\"" <<< "$out" && ! grep -q "R-3" <<< "$out"'
# A pass that harvested the handoff has it in memory before writing it: its view is judged, not the file.
printf '{"version":1,"batch":"r","tickets":{"R-6":{"key":"R-6","state":"running","stage":"6/9"}}}\n' > "$T/queue.json"
out=$(DESK_MAINT_NOW=2026-10-27T09:16:40Z MAINT_MJS="$B/maintenance.mjs" QF="$T/queue.json" node --input-type=module -e '
  const { maintenance } = await import(process.env.MAINT_MJS);
  const view = { version: 1, batch: "r", tickets: { "R-6": { key: "R-6", state: "triaged", stage: "6/9", handoff: "pending", handoff_stage: "7" } } };
  console.log(JSON.stringify(await maintenance({ running: [], stop: () => ({ ok: false }), selfQueue: process.env.QF, selfView: view })));
' 2>&1)
check "#773 a handoff the pass holds in memory, not yet written, holds the install" '[ "$(calls install)" = 0 ] && grep -q "R-6 waiting on its Stage 7 session" <<< "$out"'
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
printf '{"version":1,"batch":"r","tickets":{"R-4":{"key":"R-4","state":"running","stage":"4/9"},"R-5":{"key":"R-5","state":"triaged"}}}\n' > "$T/queue.json"
# What installed.mjs restart says, in install.sh's section and again in its summary: one driver
# restarted, one left running mid-loop.
restart_said='  merge driver for r (pid 111): left running on the old code, it is mid-loop and may be merging; a supervisor tick moves it to the new code once it waits between loops
  merge driver for r batch b: restarted on the new code (pid 222 -> 333) for R-4'
printf '%s\n        %s\n' "$restart_said" "$restart_said" > "$T/install.out"
step 2026-10-27T09:26:00Z
rm "$T/install.out"
printf '{"version":1,"batch":"r","tickets":{}}\n' > "$T/queue.json"
check "#773 the install line names the running workers that pick it up" 'grep -q "installed, main.s tests check passed on it; running workers that pick it up on their next call: .*R-4;" <<< "$out" && ! grep -q "R-5" <<< "$out"'
check "DS-841 the install line says which merge driver it restarted, once, and not the one left running" 'grep -q "R-4; merge driver restarted on the new code, so its log.s .*merge driver exited 143.* is this restart: r batch b (pid 222 -> 333)\"" <<< "$out" && [ "$(grep -o "pid 222 -> 333" <<< "$out" | wc -l | tr -d " ")" = 1 ] && ! grep -q "pid 111" <<< "$out" && mlog | grep -q "merge driver restarted on the new code.*r batch b (pid 222 -> 333)"'
check "AC1 the checkout is fast-forwarded to origin/main's head" '[ "$(srchead)" = "$new" ]'
check "AC1 install.sh runs once with nothing on stdin"      '[ "$(calls install)" = 1 ] && grep -qx "installed args=--any-branch stdin=0" "$T/install.calls"'
check "AC1 installed.json names the new commit"             '[ "$(installed)" = "$new" ]'
check "AC1 the report and the log say so"                   'grep -q "release: desk-skills ${old:0:12} -> ${new:0:12} (3 merge(s) to main) installed" <<< "$out" && mlog | grep -q "release: desk-skills ${old:0:12} -> ${new:0:12}"'
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

# ---- a head that has not passed installs the newest commit before it that has --------------------
# pass <commit>: its check passed; every other commit reads $T/check.state.
pass(){ echo success > "$T/check.$1"; }
echo cancelled > "$T/check.state"; inst=$(calls install); was=$new
upstream g0; g0=$(originhead); pass "$g0"; upstream g1; g1=$(originhead); pass "$g1"; upstream mid; mid=$(originhead); upstream head1; h=$(originhead)
: > "$T/check.calls"
step 2026-10-27T09:46:00Z
check "DS-754 AC1 a cancelled head installs the newest passing commit before it" '[ "$(srchead)" = "$g1" ] && [ "$(installed)" = "$g1" ] && [ "$(calls install)" = $((inst + 1)) ]'
check "DS-754 AC1 the line names it and says why the head was not" 'grep -q "release: desk-skills ${was:0:12} -> ${g1:0:12} (2 merge(s) to main) installed, main'"'"'s tests check passed on it; main'"'"'s head ${h:0:12} was not installed: its tests check was cancelled, and is read again next pass (cancelled)" <<< "$out"'
check "DS-754 AC1 checks are read newest first, and stop at the first that passed" '[ "$(tr "\n" " " < "$T/check.calls")" = "$h $mid $g1 " ]'
check "DS-754 AC2 a cancelled head raises no failure"       '[ "$(pushes)" = 0 ] && ! grep -q "check failed" <<< "$out" && ! mlog | grep -q "check failed (cancelled)"'
step 2026-10-27T09:47:00Z
check "DS-754 AC6 nothing after the installed commit passed: nothing installed, the installed version stays" '[ "$(calls install)" = $((inst + 1)) ] && grep -q "waiting for main'"'"'s tests check on it (cancelled), and no commit since the installed one passed it, so the installed version stays at ${g1:0:12}" <<< "$out" && [ "$(pushes)" = 0 ]'
pass "$h"
step 2026-10-27T09:48:00Z
check "DS-754 AC3 a successful re-run of the head installs it" '[ "$(installed)" = "$h" ] && grep -q "release: desk-skills ${g1:0:12} -> ${h:0:12} (2 merge(s) to main) installed, main'"'"'s tests check passed on it\"" <<< "$out"'

upstream g2; g2=$(originhead); pass "$g2"; upstream red; f=$(originhead); echo failure > "$T/check.$f"
step 2026-10-27T09:53:00Z
check "DS-754 AC4 a failed head pushes once, naming it, and the newest passing commit is installed" '[ "$(pushes)" = 1 ] && grep -q "release-failed-$f" <<< "$out" && grep -q "check failed (failure) on ${f:0:12}, so it was not installed; ${g2:0:12}, the newest commit before it whose check passed, is installed in its place when nothing blocks it" <<< "$out" && [ "$(installed)" = "$g2" ]'
check "DS-754 AC4 the install line says why the head was not" 'grep -q "${h:0:12} -> ${g2:0:12} (1 merge(s) to main) installed, main'"'"'s tests check passed on it; main'"'"'s head ${f:0:12} was not installed: its tests check failed (failure)" <<< "$out"'
inst=$(calls install)
step 2026-10-27T09:54:00Z
check "DS-754 AC4 a later pass keeps the push, logs the failure once and installs nothing more" '[ "$(pushes)" = 1 ] && [ "$(mlog | grep -c "check failed (failure) on ${f:0:12}")" = 1 ] && [ "$(calls install)" = "$inst" ]'

echo pending > "$T/check.state"
upstream g3; g3=$(originhead); pass "$g3"; upstream running; p=$(originhead)
step 2026-10-27T09:59:00Z
check "DS-754 AC5 a pending head installs the earlier passing commit" '[ "$(installed)" = "$g3" ] && grep -q "${g2:0:12} -> ${g3:0:12} (2 merge(s) to main) installed, .*main'"'"'s head ${p:0:12} was not installed: its tests check is still running (pending)" <<< "$out"'

echo cancelled > "$T/check.state"; inst=$(calls install)
upstream g4; g4=$(originhead); pass "$g4"; upstream head4; c=$(originhead)
printf '{"version":1,"batch":"r","tickets":{"R-9":{"key":"R-9","state":"running","stage":"7/9"}}}\n' > "$T/queue.json"
step 2026-10-27T10:05:00Z
check "DS-754 AC7 a worker at Stage 7 holds the earlier commit's install too" '[ "$(calls install)" = "$inst" ] && [ "$(installed)" = "$g3" ] && grep -q "desk-skills main ${g4:0:12} passed its tests check; main'"'"'s head ${c:0:12} was not installed: .*; waiting to install it for .*R-9 at Stage 7" <<< "$out"'
printf '{"version":1,"batch":"r","tickets":{}}\n' > "$T/queue.json"
echo success > "$T/check.state"; inst=$(calls install)

# ---- a PR merged with a merge commit counts once: the line counts main's own commits ------------
was=$(installed)
git -C "$T/seed" checkout -q -b long
for i in 1 2 3; do git -C "$T/seed" commit -q --allow-empty -m "long $i"; done
git -C "$T/seed" checkout -q main; git -C "$T/seed" merge -q --no-ff -m "Merge pull request from long" long; git -C "$T/seed" push -q "$T/origin.git" main
upstream direct; new=$(originhead)
fp=$(git -C "$T/seed" rev-list --first-parent --count "$was..$new"); all=$(git -C "$T/seed" rev-list --count "$was..$new")
step 2026-10-27T10:10:00Z
check "a merge-commit history counts main's own commits, not each merged branch's" '[ "$fp" != "$all" ] && [ "$(installed)" = "$new" ] && grep -q "release: desk-skills ${was:0:12} -> ${new:0:12} ($fp merge(s) to main) installed" <<< "$out" && ! grep -q "($all " <<< "$out"'
inst=$(calls install)

# ---- AC8: the maintenance window open ----------------------------------------------------------
upstream six; new=$(originhead)
printf '{"week":"x","phase":"draining","since":"2026-10-27T10:29:00.000Z","window":"Mon 06:30 UTC"}\n' > "$T/maint/maintenance.json"
printf '{"version":1,"batch":"r","tickets":{"R-2":{"key":"R-2","state":"running","stage":"3/9"}}}\n' > "$T/queue.json"
step 2026-10-27T10:30:00Z
check "AC8 an open window: the auto-release does nothing"   '[ "$(calls install)" = "$inst" ] && ! grep -q "release:" <<< "$out" && grep -q "maintenance: draining" <<< "$out"'

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
