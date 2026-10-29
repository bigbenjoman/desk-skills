#!/usr/bin/env bash
# suite: health (the watchdog holds spawns while a sign-in or free disk fails)
# pass.mjs runs health.mjs's checks before it spawns: fake gh, desk-jira, claude and codex on PATH, a
# fake saved GitHub login for the browser profile and a fake free-disk figure. All passing spawns as
# usual; a failing required check holds new spawns, leaves running workers alone, names the check and
# its fix, and pushes it; the real supervisor notifies once per newly failing check; a recovery says
# so; codex and the browser profile are not required where §3 says no; results are reused for 15
# minutes; a check that does not answer in time fails "timed out" and is retried; a remote check is
# told only once it fails two runs in a row; every remote check unreachable together is the network,
# with no sign-in fix. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/state/logs" "$T/desk/bin" "$T/stub" "$T/wt"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  CLAUDE_CODE_SESSION_ID AUTOPILOT_DRY_RUN AUTOPILOT_RERUN AUTOPILOT_PORT_FLOOR DESK_UPLOAD_APPROVED AUTOPILOT_BATCH_BUDGET_USD \
  AUTOPILOT_HEALTH_CHECKS DESK_HEALTH_TIMEOUT_MS AUTOPILOT_USER_APPROVED AUTOPILOT_BASE_PUSH_APPROVED
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
# config <codex-review> <pr-images>
config(){ cat > "$T/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |
| Worktrees directory | \`$T/wt\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`yes\` |
| \`codex-review\` | Send diffs to codex | \`yes\` | \`$1\` |
| \`pr-images\` | Upload PR screenshots | \`yes\` | \`$2\` |

## 3b. Cost and autonomy
| Field | Recommended | Your setting |
|---|---|---|
| Free disk floor (GB) | \`20\` | \`20\` |

## 4. Tracker
| Field | Value |
|---|---|
| Tracker | \`jira\` |
EOF
}
config yes yes

for f in queue.mjs harvest.mjs desk-env.mjs batch-state.mjs briefing.mjs; do ln -s "$B/$f" "$T/desk/bin/$f"; done
cat > "$T/desk/bin/setup-worktree.sh" <<EOF
mkdir -p "$T/wt/\$2"; echo "[setup-worktree] worktree=$T/wt/\$2"; echo "[setup-worktree] branch=\$3"
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<'EOF'
if [ "$3" = preflight ]; then echo "[preflight] pass"; else echo "[spawn] ticket=$1"; fi
EOF
# Each sign-in command answers per its mode file ($T/mode.<name>: ok, out or hang) and logs each check.
for c in gh claude codex desk-jira; do
  cat > "$T/stub/$c" <<EOF
#!/bin/sh
case "\$1" in
  agents) echo '[{"sessionId": "live-1"}]'; exit 0 ;;
  auth|login|whoami) echo "\$@" >> "$T/calls.$c" ;;
  *) exit 0 ;;
esac
case "\$(cat "$T/mode.$c" 2>/dev/null || echo ok)" in
  out) echo "You are not logged in to $c" >&2; exit 1 ;;
  net) echo "error connecting to api.example.com: dial tcp: lookup api.example.com: no such host" >&2; exit 1 ;;
  hang) sleep 5 ;;
  once) [ -f "$T/hung.$c" ] || { : > "$T/hung.$c"; sleep 5; } ;;
esac
exit 0
EOF
  chmod +x "$T/stub/$c"
done
mode(){ echo "$2" > "$T/mode.$1"; }
printf '#!/bin/sh\n[ -f "%s/notify.fails" ] && exit 1\nprintf "%%s|" "$@" >> "%s/notify.calls"; echo >> "%s/notify.calls"\n' "$T" "$T" "$T" > "$T/stub/osascript"
chmod +x "$T/stub/osascript"
# A signed-in browser profile: a saved GitHub login cookie expiring next year.
signin(){ printf '{"user":"t","cookies":[{"name":"user_session","domain":"github.com","expires":%s}],"origins":[]}\n' "$1" > "$T/profile.github-session.json"; }
signin "$(( $(date +%s) + 31536000 ))"

export PATH="$T/stub:$PATH" DESK_CONFIG="$T/config.md" DESK_HOME="$T/desk" DESK_AUTOPILOT_STATE="$T/state" \
  DESK_QUEUE="$T/queue.json" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_ORCHESTRATOR=test \
  DESK_BROWSER_PROFILE="$T/profile" DESK_FREE_DISK_GB=100 DESK_HEALTH_RETRY_MS=0
cd "$T/repo" || exit 1
q(){ node "$B/queue.mjs" "$@" >/dev/null 2>&1; }
field(){ node -e 'const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]; console.log(t?.[process.argv[3]] ?? null)' "$DESK_QUEUE" "$1" "$2"; }
pushes(){ node -e 'const v = JSON.parse(process.argv[1]); console.log(v.push.map((p) => p.key).filter((k) => k.startsWith("health:")).join(" "))' "$json"; }
# Make the last results 16 minutes old, so the next pass runs the checks again but still knows what
# failed last time (the 15-minute reuse is AC9's own case).
stale(){ [ -f "$T/state/health.json" ] && node -e 'const f = process.argv[1]; const h = JSON.parse(require("fs").readFileSync(f, "utf8")); h.at = new Date(Date.now() - 16 * 60000).toISOString(); require("fs").writeFileSync(f, JSON.stringify(h))' "$T/state/health.json"; }
# One pass: $json is its verdict, $out its report.
pj(){ stale; json=$(node "$B/pass.mjs" --json 2>/dev/null); out=$(node -e 'console.log(JSON.parse(process.argv[1]).message)' "$json"); }
calls(){ if [ -f "$T/calls.$1" ]; then wc -l < "$T/calls.$1" | tr -d ' '; else echo 0; fi; }

q init h
# ---- AC1: everything signed in, disk above the floor ------------------------------------------
q add H-1; q set H-1 state=triaged branch=fix/H-1
pj
check "AC1 all passing: the ticket spawns"                  '[ "$(field H-1 state)" = running ]'
check "AC1 one health line saying all checks pass"          '[ "$(grep -c "health: all checks pass" <<< "$out")" = 1 ]'
check "AC1 nothing is pushed"                               '[ -z "$(pushes)" ]'
check "AC1 every required check ran"                        '[ "$(calls gh)" = 1 ] && [ "$(calls claude)" = 1 ] && [ "$(calls codex)" = 1 ] && [ "$(calls desk-jira)" = 1 ]'

# ---- AC2: gh signed out ------------------------------------------------------------------------
q set H-1 session_id=live-1
q add H-2; q set H-2 state=triaged branch=fix/H-2
mode gh out
pj
check "AC2 no new worker starts"                            '[ "$(field H-2 state)" = triaged ]'
check "AC2 the running worker is left alone"                '[ "$(field H-1 state)" = running ]'
check "AC2 a first failing run is rechecked, not told"      'grep -q "health: 1 check(s) failing — gh — holding new spawns (checked now; rechecking before telling you: gh)" <<< "$out" && [ -z "$(pushes)" ]'
check "AC2 an auth failure is not retried"                  '[ "$(calls gh)" = 2 ]'
pj
check "DS-333 AC3 failing two runs in a row is told"        '[ "$(field H-2 state)" = triaged ] && ! grep -q "rechecking" <<< "$out"'
check "AC2 the report names the failed check"               'grep -q "health: GitHub CLI (gh auth status) failed: You are not logged in to gh" <<< "$out"'
check "AC2 the report names the fix"                        'grep -q "fix: gh auth login" <<< "$out"'
check "AC2 the health line says spawns are held"            'grep -q "health: 1 check(s) failing — gh — holding new spawns" <<< "$out"'
check "AC2 the pass pushes the gh check"                    '[[ "$(pushes)" =~ ^health:.+:gh$ ]]'

# ---- AC5: gh recovers --------------------------------------------------------------------------
mode gh ok
pj
check "AC5 spawns resume"                                   '[ "$(field H-2 state)" = running ]'
check "AC5 the report says gh recovered"                    'grep -q "health: all checks pass (checked now; recovered: gh)" <<< "$out"'
check "AC5 nothing is pushed once it recovers"              '[ -z "$(pushes)" ]'

# ---- AC6: free disk under the floor ------------------------------------------------------------
# Finished tickets free their slots, so only the health checks can hold the next one.
q set H-1 state=done; q set H-2 state=done
q add H-3; q set H-3 state=triaged branch=fix/H-3
DESK_FREE_DISK_GB=12 pj
check "AC6 low disk holds spawns"                           '[ "$(field H-3 state)" = triaged ]'
check "AC6 the report names the free space and the floor"   'grep -q "12 GB free on $T/wt, under the 20 GB floor" <<< "$out"'

# ---- AC7 / AC8: codex and the browser profile not required where §3 says no ---------------------
config no no
mode codex out
signin 1
: > "$T/calls.codex"
pj
check "AC7/8 the pass still spawns"                         '[ "$(field H-3 state)" = running ]'
check "AC7 Codex is listed as not required"                 'grep -q "Codex (config §3 codex-review is \"no\")" <<< "$out"'
check "AC7 codex is not even asked"                         '[ "$(calls codex)" = 0 ]'
check "AC8 the browser profile is listed as not required"   'grep -q "browser profile (config §3 pr-images is \"no\")" <<< "$out"'
config yes yes
q set H-3 state=done
q add H-4; q set H-4 state=triaged branch=fix/H-4
pj
check "AC8 where §3 pr-images is yes, a stale login holds"  '[ "$(field H-4 state)" = triaged ] && grep -q "the GitHub login in $T/profile.github-session.json expired" <<< "$out"'
check "a local check is told on its first failing run"     '[[ "$(pushes)" =~ :browser$ ]] && grep -q "rechecking before telling you: codex)" <<< "$out"'
pj
check "AC7 where §3 codex-review is yes, codex signed out holds" 'grep -q "health: Codex (codex login status) failed" <<< "$out"'
mode codex ok
signin "$(( $(date +%s) + 31536000 ))"

# ---- AC9: results under 15 minutes old are reused ----------------------------------------------
pj
n=$(calls gh)
mode gh out
out=$(node "$B/pass.mjs" 2>&1)
check "AC9 the checks do not run again"                     '[ "$(calls gh)" = "$n" ]'
check "AC9 the last results are reused"                     'grep -q "health: all checks pass (checked 0 min ago, reused)" <<< "$out"'
pj
check "AC9 results 16 minutes old are run again"            '[ "$(calls gh)" = $((n + 1)) ] && grep -q "health: 1 check(s) failing — gh" <<< "$out"'
mode gh ok

# ---- AC10: a check that does not answer in time ------------------------------------------------
mode claude hang
: > "$T/calls.claude"
DESK_HEALTH_TIMEOUT_MS=500 pj
check "DS-333 AC1 a timed-out check is retried"             '[ "$(calls claude)" = 2 ] && grep -q "rechecking before telling you: claude" <<< "$out" && [ -z "$(pushes)" ]'
DESK_HEALTH_TIMEOUT_MS=500 pj
check "AC10 the check fails as timed out"                   'grep -q "health: Claude (claude auth status) failed: timed out" <<< "$out"'
check "DS-333 a timeout names the connection, not a sign-in" 'grep -q "fix: check this machine.s connection to Claude" <<< "$out" && ! grep -q "claude auth login" <<< "$out"'
mode claude ok
pj
check "a timeout that clears: recovered, nothing pushed"   'grep -q "health: all checks pass (checked now; recovered: claude)" <<< "$out" && [ -z "$(pushes)" ]'
mode gh once; : > "$T/calls.gh"
DESK_HEALTH_TIMEOUT_MS=500 pj
check "DS-333 AC1 a timeout that passes on its retry passes" '[ "$(calls gh)" = 2 ] && grep -q "health: all checks pass (checked now)" <<< "$out"'
mode gh ok

# ---- DS-333 AC2: every remote check failing together is the network ---------------------------
for c in gh claude codex desk-jira; do mode "$c" net; done
pj
check "DS-333 AC2 all remote failing: named the network"    'grep -q "health: 4 check(s) failing — gh, jira, claude, codex, every remote check: the network — holding new spawns" <<< "$out"'
check "DS-333 AC2 a network failure is retried"             '[ "$(calls gh)" -ge 2 ]'
check "DS-333 AC2 not told on its first run"                '[ -z "$(pushes)" ]'
pj
check "DS-333 AC2 then one network push"                    '[[ "$(pushes)" =~ ^health:.+:network$ ]]'
check "DS-333 AC2 it says the network"                      'grep -q "this machine looks offline, not signed out: check its network connection" <<< "$out"'
check "DS-333 AC2 no credential remedy"                     '! grep -qE "gh auth login|renew the Jira|claude auth login|codex login" <<< "$out"'
for c in gh claude codex desk-jira; do mode "$c" ok; done
pj

check "a test pass can turn the checks off"                 'out=$(AUTOPILOT_HEALTH_CHECKS=off node "$B/pass.mjs" 2>&1); grep -q "health: checks off" <<< "$out"'

# ---- AC3 / AC4: the supervisor notifies once per newly failing check ---------------------------
# The real supervisor and its notifier, running the real pass.
q set-batch supervised=true
q add H-5; q set H-5 state=triaged branch=fix/H-5
rm -f "$T/state/health.json" "$T/notify.calls"
mode gh out
sup(){ node "$B/supervisor.mjs" tick --foreground >/dev/null 2>&1; }
notes(){ if [ -f "$T/notify.calls" ]; then wc -l < "$T/notify.calls" | tr -d ' '; else echo 0; fi; }
sup
check "DS-333 gh failing once: no notification yet"        '[ "$(notes)" = 0 ]'
sup
check "AC3 gh failing two runs in a row: one notification" '[ "$(notes)" = 1 ]'
check "AC3 the notification names the check and its fix"    'grep -q "GitHub CLI check is failing.*Fix: gh auth login" "$T/notify.calls"'
sup
check "AC4 still failing on the next pass: no second one"   '[ "$(notes)" = 1 ]'
mode gh ok; sup
mode gh out; rm -f "$T/state/health.json"; sup; sup
check "failing again after a recovery notifies again"       '[ "$(notes)" = 2 ]'

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
