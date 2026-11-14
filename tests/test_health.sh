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
  AUTOPILOT_HEALTH_CHECKS DESK_HEALTH_TIMEOUT_MS AUTOPILOT_USER_APPROVED AUTOPILOT_BASE_PUSH_APPROVED DESK_PG_CONTAINER
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
# config <codex-review> <pr-images>; $DBROW, when set, is §4 Local database, with a per-ticket database made in it
config(){
  local perm="" rows=""
  if [ -n "${DBROW:-}" ]; then
    perm="| \`db-per-ticket\` | A database per ticket | \`yes\` | \`yes\` |"
    rows="| Local database | \`$DBROW\` |
| Database URL variable | \`DATABASE_URL\` |"
  fi
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
| Worktrees directory | \`$T/wt\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`yes\` |
| \`codex-review\` | Send diffs to codex | \`yes\` | \`$1\` |
| \`pr-images\` | Upload PR screenshots | \`yes\` | \`$2\` |
$perm

## 3b. Cost and autonomy
| Field | Recommended | Your setting |
|---|---|---|
| Free disk floor (GB) | \`20\` | \`20\` |

## 4. Tracker
| Field | Value |
|---|---|
| Tracker | \`jira\` |
$rows
EOF
}
config yes yes

for f in queue.mjs harvest.mjs desk-env.mjs batch-state.mjs briefing.mjs; do ln -s "$B/$f" "$T/desk/bin/$f"; done
# Setup answers per $T/mode.setup: ok, pgdown (Postgres not answering) or other (any other failure).
cat > "$T/desk/bin/setup-worktree.sh" <<EOF
echo "\$2" >> "$T/calls.setup"
case "\$(cat "$T/mode.setup" 2>/dev/null || echo ok)" in
  pgdown) echo "FAIL: cannot reach Postgres in container acme-pg as postgres: psql in container acme-pg did not answer within 30s, after 4 tries over 120s (is it running?)" >&2; exit 1 ;;
  other) echo "FAIL: §4 Install failed twice" >&2; exit 1 ;;
esac
mkdir -p "$T/wt/\$2"; echo "[setup-worktree] worktree=$T/wt/\$2"; echo "[setup-worktree] branch=\$3"
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<'EOF'
if [ "$3" = preflight ]; then echo "[preflight] pass"; else echo "[spawn] ticket=$1"; fi
EOF
# Each sign-in command answers per its mode file ($T/mode.<name>: ok, out, net, unreach, hang or once)
# and logs each check.
for c in gh claude codex desk-jira; do
  cat > "$T/stub/$c" <<EOF
#!/bin/sh
case "\$1" in
  agents) echo '[{"sessionId": "live-1"}]'; exit 0 ;;
  auth|login|whoami) echo "\$@" >> "$T/calls.$c" ;;
  *) exit 0 ;;
esac
# Another Claude login's folder holding signed-out is signed out, whatever the default's mode.
[ -n "\${CLAUDE_CONFIG_DIR:-}" ] && [ -f "\$CLAUDE_CONFIG_DIR/signed-out" ] && { echo "Not logged in" >&2; exit 1; }
case "\$(cat "$T/mode.$c" 2>/dev/null || echo ok)" in
  out) echo "You are not logged in to $c" >&2; exit 1 ;;
  net) printf '%s\n' "error connecting to api.example.com: dial tcp: lookup api.example.com: no such host" "- Active account: true" >&2; exit 1 ;;
  unreach) echo "desk-jira: could not reach https://acme.atlassian.net (see the curl error above)" >&2; exit 1 ;;
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


# ---- one check that cannot reach its host -------------------------------------------------------
# The connection error is above a closing hint, as gh prints it, so it is read from the whole output.
mode gh net; : > "$T/calls.gh"
pj
check "DS-333 AC1 an unreachable host is retried"           '[ "$(calls gh)" = 2 ] && grep -q "rechecking before telling you: gh" <<< "$out"'
pj
check "DS-333 one unreachable check names the connection"   'grep -q "fix: check this machine.s connection to GitHub CLI" <<< "$out" && ! grep -q "fix: gh auth login" <<< "$out"'
mode gh ok
mode desk-jira unreach; : > "$T/calls.desk-jira"
pj
check "DS-333 AC1 desk-jira not reaching Jira is retried"   '[ "$(calls desk-jira)" = 2 ]'
mode desk-jira ok
pj

# ---- every remote check unreachable together is the network ------------------------------------
for c in gh claude codex desk-jira; do mode "$c" net; : > "$T/calls.$c"; done
pj
check "DS-333 AC2 all remote failing: named the network"    'grep -q "health: 4 check(s) failing — gh, jira, claude, codex, every remote check: the network — holding new spawns" <<< "$out"'
check "DS-333 AC2 a network failure is retried"             '[ "$(calls gh)" = 2 ] && [ "$(calls desk-jira)" = 2 ]'
check "DS-333 AC2 not told on its first run"                '[ -z "$(pushes)" ]'
pj
check "DS-333 AC2 then one network push"                    '[[ "$(pushes)" =~ ^health:.+:network$ ]]'
check "DS-333 AC2 it says the network"                      'grep -q "this machine looks offline, not signed out: check its network connection" <<< "$out"'
check "DS-333 AC2 no credential remedy"                     '! grep -qE "gh auth login|renew the Jira|claude auth login|codex login" <<< "$out"'
for c in gh claude codex desk-jira; do mode "$c" ok; done
pj

# ---- every remote check failing together, one worded in a way the pattern misses ---------------
for c in gh claude codex; do mode "$c" net; done; mode desk-jira out
pj; pj
check "DS-333 AC2 all failing, one unmatched: the network"   'grep -q "every remote check: the network" <<< "$out" && [[ "$(pushes)" =~ ^health:.+:network$ ]]'
check "DS-333 AC2 all failing, one unmatched: no sign-in fix" '! grep -qE "gh auth login|renew the Jira|claude auth login|codex login" <<< "$out"'
for c in gh claude codex desk-jira; do mode "$c" ok; done
pj

# ---- every remote check signed out together is still the sign-ins ------------------------------
for c in gh claude codex desk-jira; do mode "$c" out; done
pj; pj
check "DS-333 AC3 all signed out: not called the network"   '! grep -q "the network" <<< "$out" && ! [[ "$(pushes)" =~ :network ]]'
check "DS-333 AC3 all signed out: each sign-in fix pushed"  '[ "$(pushes | wc -w | tr -d " ")" = 4 ] && grep -q "fix: gh auth login" <<< "$out" && grep -q "fix: renew the Jira API token" <<< "$out"'
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

# ---- DS-463 AC7: a second Claude login signed out ----------------------------------------------
q set-batch supervised=false
mode gh ok; rm -f "$T/state/health.json"
mkdir -p "$HOME/.claude-logins/b"; : > "$HOME/.claude-logins/b/signed-out"
export DESK_SUBSCRIPTIONS="$T/subscriptions.md"
printf '| Tool | Name | Folder | Rule |\n|---|---|---|---|\n| `claude` | `default` | `~/.claude` | `in rotation` |\n| `claude` | `b` | `~/.claude-logins/b` | `standby` |\n' > "$DESK_SUBSCRIPTIONS"
before=$(calls claude)
pj
check "DS-463 AC7 login b is checked in its own folder"     '[ "$(calls claude)" = $((before + 2)) ]'
check "DS-463 AC7 the default login's result is unchanged"  'grep -q "health: all checks pass" <<< "$out"'
check "DS-463 AC7 login b is named signed out, with its sign-in command" 'grep -qF "health: Claude login b (~/.claude-logins/b) is signed out" <<< "$out" && grep -qF "sign it in, in another terminal: CLAUDE_CONFIG_DIR=~/.claude-logins/b claude, then /login" <<< "$out"'
check "DS-463 AC7 and pushed under its own key"             '[[ "$(pushes)" =~ health:.+:claude:b ]]'
rm -f "$HOME/.claude-logins/b/signed-out"; rm -f "$T/state/health.json"
pj
check "DS-463 AC7 signed back in, nothing is said of it"    '! grep -q "Claude login b" <<< "$out" && [ -z "$(pushes)" ]'

# ---- DS-602: a listed login whose folder does not exist ----------------------------------------
# Login c is on standby at a folder never made. Another slot is the same health checks run with its
# own state folder, on the same machine.
slot(){ json=$(DESK_AUTOPILOT_STATE="$T/state2" node --input-type=module -e 'const { health } = await import(process.argv[1]); const h = await health(); console.log(JSON.stringify({ message: [h.line, ...h.stalls].join("\n"), push: h.push }))' "$B/health.mjs"); out=$(node -e 'console.log(JSON.parse(process.argv[1]).message)' "$json"); }
printf '| `claude` | `c` | `~/.claude-logins/c` | `standby` |\n' >> "$DESK_SUBSCRIPTIONS"
note_c="claude login c listed at ~/.claude-logins/c, which does not exist: remove its row (desk-env logins remove claude c) or sign it in (CLAUDE_CONFIG_DIR=~/.claude-logins/c claude, then /login)"
rm -f "$T/state/health.json"
before=$(calls claude)
pj
check "DS-602 AC1 a login with no folder is not checked"           '[ "$(calls claude)" = $((before + 2)) ]'
check "DS-602 AC1 no stall line for it, and spawns are not held"   '! grep -qE "^ *health: Claude login c" <<< "$out" && grep -q "health: all checks pass" <<< "$out"'
check "DS-602 AC1 the health line's notes name the row and folder" 'grep "^health: all checks pass" <<< "$out" | grep -qF "$note_c"'
check "DS-602 AC2 the first pass on the machine pushes it"         '[ "$(pushes)" = "health:claude-missing:c" ] && [[ "$json" == *"Claude login c is listed at ~/.claude-logins/c, which does not exist"* ]]'
pj
check "DS-602 AC2 the next pass in this slot lists the same key, which the supervisor sends once" '[ "$(pushes)" = "health:claude-missing:c" ] && grep -qF "$note_c" <<< "$out"'
slot
check "DS-602 AC2 a pass in another slot names it, does not push"  '[ -z "$(pushes)" ] && grep -qF "$note_c" <<< "$out" && ! grep -qE "^ *health: Claude login c" <<< "$out"'
: > "$HOME/.claude-logins/b/signed-out"; rm -f "$T/state/health.json"
pj
check "DS-602 AC3 a login whose folder exists is still told signed out" 'grep -qF "health: Claude login b (~/.claude-logins/b) is signed out" <<< "$out" && grep -qF "CLAUDE_CONFIG_DIR=~/.claude-logins/b claude, then /login" <<< "$out" && [[ "$(pushes)" =~ health:.+:claude:b ]]'
rm -f "$HOME/.claude-logins/b/signed-out"
mkdir -p "$HOME/.claude-logins/c"
pj
check "DS-602 AC4 once the folder is made and signed in, the note goes" '! grep -q "login c" <<< "$out" && [ -z "$(pushes)" ] && grep -q "health: all checks pass" <<< "$out"'
slot
check "DS-602 AC4 in the other slot too"                            '! grep -q "login c" <<< "$out" && [ -z "$(pushes)" ]'
rm -rf "$HOME/.claude-logins/c"
pj
check "DS-602 a folder that goes missing again is pushed again"    '[ "$(pushes)" = "health:claude-missing:c" ]'
printf '%s\n' "$T/a-slot-since-removed" > "$HOME/.desk-autopilot/health-missing-logins/c"
slot
check "DS-602 a slot whose owner's state folder is gone takes the push over" '[ "$(pushes)" = "health:claude-missing:c" ]'
pj
check "DS-602 and the slot it took it from no longer lists it"     '[ -z "$(pushes)" ] && grep -qF "$note_c" <<< "$out"'
unset DESK_SUBSCRIPTIONS

# ---- DS-589: the local Postgres container ------------------------------------------------------
# docker answers pg_isready per $T/mode.docker (ok or down) and logs each call.
cat > "$T/stub/docker" <<EOF
#!/bin/sh
echo "\$@" >> "$T/calls.docker"
[ "\$(cat "$T/mode.docker" 2>/dev/null || echo ok)" = down ] && { echo "/var/run/postgresql:5432 - no response"; exit 2; }
echo "/var/run/postgresql:5432 - accepting connections"
EOF
chmod +x "$T/stub/docker"
q set H-5 state=done; q set H-4 state=done
q add H-6; q set H-6 state=triaged branch=fix/H-6
: > "$T/calls.docker"
pj
check "DS-589 AC5 no local database: no check runs, nothing held" '[ "$(calls docker)" = 0 ] && [ "$(field H-6 state)" = running ] && grep -q "health: all checks pass (checked now)" <<< "$out" && ! grep -q "local database" <<< "$out"'
q set H-6 state=done
DBROW="postgres container acme-pg" config yes yes
q add H-7; q set H-7 state=triaged branch=fix/H-7
mode docker down
pj
check "DS-589 AC1 the container not answering holds the spawn" '[ "$(field H-7 state)" = triaged ] && [ "$(calls docker)" = 1 ] && grep -q "health: 1 check(s) failing — database — holding new spawns" <<< "$out"'
check "DS-589 AC1 one item naming the container, told at once" 'grep -qF "health: local database (docker exec acme-pg pg_isready) failed:" <<< "$out" && grep -qF "start Docker and the container acme-pg" <<< "$out" && [[ "$(pushes)" =~ ^health:.+:database$ ]]'
mode docker ok
pj
check "DS-589 AC2 once it answers the ticket spawns, no answer needed" '[ "$(field H-7 state)" = running ] && grep -q "health: all checks pass (checked now; recovered: database)" <<< "$out" && [ -z "$(pushes)" ]'
q set H-7 state=done
mv "$T/stub/docker" "$T/docker.off"
json=$(PATH="$T/stub:/usr/bin:/bin" "$(command -v node)" --input-type=module -e 'const { health } = await import(process.argv[1]); const h = await health(); console.log(JSON.stringify({ message: [h.line, ...h.stalls].join("\n"), push: h.push }))' "$B/health.mjs" 2>&1)
out=$(node -e 'console.log(JSON.parse(process.argv[1]).message)' "$json")
check "DS-589 AC6 no docker on PATH: the check fails saying so" 'grep -qF "health: local database (docker exec acme-pg pg_isready) failed: docker not found" <<< "$out"'
mv "$T/docker.off" "$T/stub/docker"
rm -f "$T/state/health.json"

# AC3/AC4: health passes, then setup itself fails.
q add H-8; q set H-8 state=triaged branch=fix/H-8
q add H-9; q set H-9 state=triaged branch=fix/H-9
echo pgdown > "$T/mode.setup"; : > "$T/calls.setup"
pj
check "DS-589 AC3 setup not reaching Postgres: queued, not parked" '[ "$(field H-8 state)" = triaged ] && [ "$(field H-9 state)" = triaged ] && grep -q "worktree setup could not reach the local database, so it stays queued" <<< "$out" && ! grep -q "worktree setup failed, not spawned" <<< "$out"'
check "DS-589 AC3 the hold starts that pass: one setup, one item"   '[ "$(calls setup)" = 1 ] && grep -q "held, the local database is not answering" <<< "$out" && grep -qF "health: local database (docker exec acme-pg pg_isready) failed: cannot reach Postgres in container acme-pg" <<< "$out" && [[ "$(pushes)" =~ ^health:.+:database$ ]]'
check "DS-589 AC3 the health line says the database holds spawns"    'grep -q "health: 1 check(s) failing — database — holding new spawns" <<< "$out"'
echo ok > "$T/mode.setup"
json=$(node "$B/pass.mjs" --json 2>/dev/null); out=$(node -e 'console.log(JSON.parse(process.argv[1]).message)' "$json")
check "DS-589 AC2 the next pass checks afresh and spawns both"      '[ "$(field H-8 state)" = running ] && [ "$(field H-9 state)" = running ] && grep -q "recovered: database" <<< "$out"'
q set H-8 state=done; q set H-9 state=done
q add H-10; q set H-10 state=triaged branch=fix/H-10
echo other > "$T/mode.setup"
pj
check "DS-589 AC4 any other setup failure parks as today"            '[ "$(field H-10 state)" = parked ] && grep -q "H-10: worktree setup failed, not spawned — FAIL: §4 Install failed twice" <<< "$out" && ! grep -q "local database" <<< "$out"'
check "DS-589 a ticket that waited and spawned keeps no wait mark"   '[ "$(field H-8 db_wait)" = null ]'
q set H-10 state=done
q add H-11; q set H-11 state=triaged branch=fix/H-11
echo pgdown > "$T/mode.setup"
pj
check "DS-589 setup not reaching Postgres once: queued"             '[ "$(field H-11 state)" = triaged ]'
pj
check "DS-589 again while the database check answers: parks"        '[ "$(field H-11 state)" = parked ] && grep -q "H-11: worktree setup failed, not spawned — FAIL: cannot reach Postgres in container acme-pg.*the local database check passes" <<< "$out"'
rm -f "$T/mode.setup"

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
