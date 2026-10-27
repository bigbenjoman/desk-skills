#!/usr/bin/env bash
# suite: maintenance (the weekly window drains, updates, checks and restarts, then resumes)
# The real pass.mjs on a fixed clock (DESK_MAINT_NOW), with a running worker whose session is a real
# process, a fake desk-skills checkout cloned from a scratch origin, a fake reboot check and a fake
# restart command that records its calls. One week per case, so each
# window starts fresh. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(cd "$(mktemp -d)" && pwd -P)"
trap 'kill "$(cat "$T/pid" 2>/dev/null)" 2>/dev/null; rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/state/logs" "$T/desk/bin" "$T/stub" "$T/wt"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  CLAUDE_CODE_SESSION_ID AUTOPILOT_DRY_RUN AUTOPILOT_RERUN AUTOPILOT_PORT_FLOOR DESK_UPLOAD_APPROVED AUTOPILOT_BATCH_BUDGET_USD \
  AUTOPILOT_USER_APPROVED AUTOPILOT_BASE_PUSH_APPROVED DESK_MAINT_NOW DESK_BOOT_TIME DESK_SOURCE_CHECKOUT
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
# config <window> <machine-reboot>
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
| \`machine-reboot\` | Restart the computer | \`ask\` | \`$2\` |

## 3b. Cost and autonomy
| Field | Recommended | Your setting |
|---|---|---|
| Maintenance window | \`none\` | \`$1\` |
| Maintenance drain limit (minutes) | \`60\` | \`30\` |
| Usage pacing headroom (points) | \`5\` | \`off\` |
EOF
}

for f in queue.mjs harvest.mjs desk-env.mjs batch-state.mjs briefing.mjs; do ln -s "$B/$f" "$T/desk/bin/$f"; done
cat > "$T/desk/bin/setup-worktree.sh" <<EOF
mkdir -p "$T/wt/\$2"; echo "[setup-worktree] worktree=$T/wt/\$2"; echo "[setup-worktree] branch=\$3"
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<'EOF'
if [ "$3" = preflight ]; then echo "[preflight] pass"; else echo "[spawn] ticket=$1"; fi
EOF
# The registry lists one live worker session, live-1, whose pid is a real process the window can stop.
cat > "$T/stub/claude" <<EOF
#!/bin/sh
[ "\$1" = agents ] && printf '[{"sessionId": "live-1", "pid": %s}]\n' "\$(cat "$T/pid" 2>/dev/null || echo 0)"
exit 0
EOF
printf '#!/bin/sh\nexit 0\n' > "$T/stub/gh"
chmod +x "$T/stub/claude" "$T/stub/gh"
worker(){ ( sleep 300 & echo $! > "$T/pid" ); }
alive(){ kill -0 "$(cat "$T/pid")" 2>/dev/null; }

# desk-skills: a scratch origin, the checkout cloned from it on main, and an install.sh that records
# each run. upstream() lands a new commit on origin for the next pull.
git init -q -b main "$T/seed"
printf '#!/bin/sh\necho installed >> "%s/install.calls"\n' "$T" > "$T/seed/install.sh"; chmod +x "$T/seed/install.sh"
git -C "$T/seed" add install.sh; git -C "$T/seed" commit -q -m one
git init -q --bare -b main "$T/origin.git"; git -C "$T/seed" push -q "$T/origin.git" main
git clone -q -b main "$T/origin.git" "$T/desk-src"
upstream(){ git -C "$T/seed" commit -q --allow-empty -m "$1"; git -C "$T/seed" push -q "$T/origin.git" main; }
# Dates are in the past: the check-in digest lists only notes made before now.
srchead(){ git -C "$T/desk-src" rev-parse HEAD; }

# reboot-check's summary line, as the fake check prints it: checkout_says <heavy> [<filevault>].
checkout_says(){ printf 'worktrees: 1 configured repo\nsummary: dirty=0 unpushed=0 heavy=%s filevault=%s\n' "$1" "${2:-off}" > "$T/check.out"; }
checkout_says 0

export PATH="$T/stub:$PATH" DESK_CONFIG="$T/config.md" DESK_HOME="$T/desk" DESK_AUTOPILOT_STATE="$T/state" \
  DESK_QUEUE="$T/queue.json" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_ORCHESTRATOR=test AUTOPILOT_HEALTH_CHECKS=off \
  DESK_DIGEST_DIR="$T/digest-pass" DESK_SOURCE_CHECKOUT="$T/desk-src" DESK_REBOOT_CHECK_CMD="cat $T/check.out" \
  DESK_RESTART_CMD="echo restart >> $T/restart.calls" DESK_BOOT_TIME=2026-09-01T00:00:00Z \
  DESK_MAINT_DIR="$T/maint"
cd "$T/repo" || exit 1
q(){ node "$B/queue.mjs" "$@" >/dev/null 2>&1; }
field(){ node -e 'const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]; const v = process.argv[3].split(".").reduce((o, k) => o?.[k], t); console.log(v ?? null)' "$DESK_QUEUE" "$1" "$2"; }
# One pass at the given time: $out is its report.
pj(){ out=$(DESK_MAINT_NOW="$1" node "$B/pass.mjs" --json 2>/dev/null | node -e 'let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => console.log(JSON.parse(s).message))'); }
calls(){ if [ -f "$T/$1.calls" ]; then wc -l < "$T/$1.calls" | tr -d ' '; else echo 0; fi; }
mlog(){ cat "$T/maint/maintenance.log" 2>/dev/null; }
# A check-in built now into a fresh digest directory: the page it writes.
digest(){ d="$T/digest-$1"; DESK_DIGEST_DIR="$d" node "$B/digest.mjs" checkin >/dev/null 2>&1; cat "$d"/*.md 2>/dev/null; }

q init m

# ---- AC10: no window row, no window ------------------------------------------------------------
config TODO ask
q add M-9; q set M-9 state=triaged branch=fix/M-9
pj 2026-09-07T06:31:00Z
check "AC10 an unset window row runs no window: the ticket spawns" '[ "$(field M-9 state)" = running ]'
check "AC10 the report has no maintenance line"             '! grep -q "maintenance:" <<< "$out"'
check "AC10 nothing is recorded"                            '[ ! -f "$T/maint/maintenance.json" ] && [ "$(calls install)" = 0 ]'
q set M-9 state=done

# ---- AC1: Monday 06:31, a pass drains ----------------------------------------------------------
config "Mon 06:30 UTC" ask
worker
q add M-0; q set M-0 state=running session_id=live-1 branch=fix/M-0 worktree="$T/wt/M-0"; mkdir -p "$T/wt/M-0"
q add M-1; q set M-1 state=triaged branch=fix/M-1
pj 2026-09-07T06:31:00Z
check "AC1 no new worker starts"                            '[ "$(field M-1 state)" = triaged ]'
check "AC1 the report says maintenance: draining"           'grep -q "^maintenance: draining" <<< "$out"'
check "AC1 the running worker is left to finish"            'alive && [ "$(field M-0 state)" = running ]'
check "AC1 nothing is updated yet"                          '[ "$(calls install)" = 0 ]'
pj 2026-09-07T06:50:00Z
check "AC1 still draining inside the limit"                 'grep -q "^maintenance: draining" <<< "$out" && alive && [ "$(field M-1 state)" = triaged ]'

# ---- AC2 / AC3 / AC5 / AC7: the drain limit, the update, the check, and "ask" ------------------
old=$(srchead); upstream two; new=$(git -C "$T/seed" rev-parse HEAD)
pj 2026-09-07T07:01:00Z
check "AC2 the worker is stopped at the limit"              '! alive'
check "AC2 its session is kept and it is queued to resume"  '[ "$(field M-0 session_id)" = live-1 ] && [ "$(field M-0 resume_why)" = "stopped for the maintenance window" ]'
check "AC2 the report names it"                             'grep -q "^maintenance: drained for 30 min, the 30 min limit: stopped M-0 (pid [0-9]*), each with its session kept" <<< "$out"'
check "AC3 desk-skills is pulled fast-forward"              '[ "$(srchead)" = "$new" ]'
check "AC3 and installed"                                   '[ "$(calls install)" = 1 ]'
check "AC3 the log records the old and new commit"          'mlog | grep -q "update: desk-skills ${old:0:12} -> ${new:0:12} (1 commit(s)), pulled fast-forward and installed"'
check "AC5 the log records the reboot check summary"        'mlog | grep -q "reboot check: summary: dirty=0 unpushed=0 heavy=0 filevault=off; no blocker"'
check "AC7 ask: no restart"                                 '[ "$(calls restart)" = 0 ]'
check "AC7 ask: spawning resumes in the same pass"          '[ "$(field M-1 state)" = running ] && grep -q "M-0 resumed after the maintenance window" <<< "$out"'
check "AC7 the report says so"                              'grep -q "maintenance: config §3 machine-reboot is \"ask\", so no restart: \"ready to reboot\" is in the next check-in; spawning resumes" <<< "$out"'
page=$(digest 1)
check "AC7 \"ready to reboot\" is in the check-in digest"   'grep -q "^## Maintenance" <<< "$page" && grep -q "ready to reboot: the maintenance window drained, updated desk-skills and found no blocker" <<< "$page"'
check "AC7 a resumed worker does not count as a killed one" '[ "$(field M-0 resumes)" = 0 ]'
q set M-0 state=done; q set M-1 state=done

# ---- AC9: once a week --------------------------------------------------------------------------
q add M-2; q set M-2 state=triaged branch=fix/M-2
pj 2026-09-09T09:00:00Z
check "AC9 later the same week the window does not run"     '[ "$(field M-2 state)" = running ] && ! grep -q "maintenance:" <<< "$out" && [ "$(calls install)" = 1 ]'
q set M-2 state=done

# ---- a window no pass reaches within 6 hours is missed ------------------------------------------
q add M-3; q set M-3 state=triaged branch=fix/M-3
pj 2026-09-15T10:00:00Z
check "a window first seen 27 hours late is missed, not run" '[ "$(field M-3 state)" = running ] && grep -q "was missed" <<< "$out" && [ "$(calls install)" = 1 ]'
q set M-3 state=done

# ---- AC4: the update fails ---------------------------------------------------------------------
# Under machine-reboot yes with no blocker, so only the failed update can stop the restart.
config "Mon 06:30 UTC" yes
echo dirty > "$T/desk-src/local.txt"
q add M-4; q set M-4 state=triaged branch=fix/M-4
pj 2026-09-21T06:31:00Z
check "AC1 with nothing running the opening pass still drains" 'grep -q "^maintenance: draining since 2026-09-21T06:31:00Z (window Mon 06:30 UTC): no new workers; none running here" <<< "$out" && [ "$(field M-4 state)" = triaged ]'
pj 2026-09-21T06:32:00Z
check "AC4 a failed update: no restart"                     '[ "$(calls restart)" = 0 ] && [ "$(calls install)" = 1 ]'
check "AC4 nor a reboot check"                              '! mlog | grep -q "^== 2026-09-21.* reboot check:"'
check "AC4 the installed version stays as it was"           '[ "$(srchead)" = "$new" ] && mlog | grep -q "update failed: .*uncommitted changes.*(installed version stays at ${new:0:12})"'
check "AC4 spawning resumes"                                '[ "$(field M-4 state)" = running ]'
page=$(digest 2)
check "AC4 the failure is in the check-in digest"           'grep -q "desk-skills update failed in the maintenance window, so the computer was not restarted" <<< "$page"'
git -C "$T/desk-src" clean -fq; q set M-4 state=done

# ---- AC6: machine-reboot yes and no blocker, FileVault off --------------------------------------
checkout_says 0 off
q add M-5; q set M-5 state=triaged branch=fix/M-5
pj 2026-09-28T06:31:00Z; pj 2026-09-28T06:32:00Z
check "AC6 the computer is restarted"                       '[ "$(calls restart)" = 1 ]'
check "DS-226 AC3 FileVault off is no blocker"              'mlog | grep -q "reboot check: summary: dirty=0 unpushed=0 heavy=0 filevault=off; no blocker"'
check "AC6 nothing spawns while it restarts"                '[ "$(field M-5 state)" = triaged ] && grep -q "maintenance: restarting the computer" <<< "$out"'
DESK_BOOT_TIME=2026-09-28T06:40:00Z pj 2026-09-28T06:45:00Z
check "AC6 after login spawning resumes"                    '[ "$(field M-5 state)" = running ] && grep -q "maintenance: restarted at 2026-09-28T06:40:00Z; spawning resumes" <<< "$out"'
q set M-5 state=done

# ---- machine-reboot yes, but the check found a blocker ------------------------------------------
checkout_says 2
q add M-6; q set M-6 state=triaged branch=fix/M-6
pj 2026-10-05T06:31:00Z; pj 2026-10-05T06:32:00Z
check "a blocker stops the restart, and spawning resumes"    '[ "$(calls restart)" = 1 ] && [ "$(field M-6 state)" = running ]'
check "the blocker is named in the check-in digest"         'grep -q "not restarted: config §3 machine-reboot is \"yes\", but the reboot check found 2 heavy process(es) running" <<< "$(digest 3)"'
q set M-6 state=done

# ---- AC8: machine-reboot no --------------------------------------------------------------------
config "Mon 06:30 UTC" no
checkout_says 0
q add M-7; q set M-7 state=triaged branch=fix/M-7
pj 2026-10-12T06:31:00Z; pj 2026-10-12T06:32:00Z
check "AC8 no: no restart"                                  '[ "$(calls restart)" = 1 ]'
check "AC8 no: spawning resumes"                            '[ "$(field M-7 state)" = running ] && grep -q "maintenance: config §3 machine-reboot is \"no\", so no restart; spawning resumes" <<< "$out"'
q set M-7 state=done

# ---- one window per computer: another repo's running worker -------------------------------------
# Its own passes would stop it; with none running, the window waits the limit plus 30 minutes, then
# moves on, and the reboot check names it.
config "Mon 06:30 UTC" ask
mkdir -p "$T/desk/repos/other"
printf '{"version":1,"batch":"o","tickets":{"O-1":{"key":"O-1","state":"running"}}}\n' > "$T/desk/repos/other/queue.json"
q add M-8; q set M-8 state=triaged branch=fix/M-8
pj 2026-10-19T06:31:00Z; pj 2026-10-19T06:50:00Z
check "a worker in another repo keeps the window draining"  'grep -q "none running here; waiting on 1 worker(s) in other repos (other O-1) until 2026-10-19T07:31:00Z" <<< "$out" && [ "$(field M-8 state)" = triaged ]'
pj 2026-10-19T07:31:00Z
check "then the window moves on and the check names it"     'mlog | grep -q "blockers: 1 worker(s) running in another repo (other O-1)" && grep -q "\"not ready to reboot\" is in the next check-in" <<< "$out" && [ "$(field M-8 state)" = running ]'
rm -r "$T/desk/repos"; q set M-8 state=done

# ---- FileVault holds a restarted Mac at the unlock screen ----------------------------------------
# Earlier weeks than the cases above, so each opens its own window and its notes are in the past.
config "Mon 06:30 UTC" yes
checkout_says 0 on
q add F-1; q set F-1 state=triaged branch=fix/F-1
pj 2026-08-10T06:31:00Z; pj 2026-08-10T06:32:00Z
check "DS-226 AC1 FileVault on is listed as a blocker"     'mlog | grep -q "blockers: FileVault is on: after a restart nothing runs until someone logs in$"'
check "DS-226 AC1 the computer is not restarted"            '[ "$(calls restart)" = 1 ] && [ "$(field F-1 state)" = running ]'
check "DS-226 AC1 the report says why"                      'grep -q "maintenance: not restarted: FileVault is on: after a restart nothing runs until someone logs in; \"ready to reboot\" is in the next check-in; spawning resumes" <<< "$out"'
page=$(digest 4)
check "DS-226 AC2 the check-in says ready to reboot, naming FileVault" 'grep -q "ready to reboot: the maintenance window drained, updated desk-skills and found no other blocker, but did not restart itself because FileVault is on: after a restart nothing runs until someone logs in" <<< "$page"'
q set F-1 state=done

checkout_says 0 unknown
q add F-2; q set F-2 state=triaged branch=fix/F-2
pj 2026-08-17T06:31:00Z; pj 2026-08-17T06:32:00Z
check "DS-226 AC4 an unreadable FileVault counts as on and says so" 'mlog | grep -q "blockers: could not tell whether FileVault is on (fdesetup status failed or is missing), so it counts as on" && [ "$(calls restart)" = 1 ]'
q set F-2 state=done

# FileVault with another blocker: not ready, and every blocker is named.
checkout_says 2 on
q add F-3; q set F-3 state=triaged branch=fix/F-3
pj 2026-08-24T06:31:00Z; pj 2026-08-24T06:32:00Z
check "DS-226 FileVault and a heavy process: not restarted, both named" 'grep -q "not restarted: config §3 machine-reboot is \"yes\", but the reboot check found 2 heavy process(es) running (test suites, typechecks, dev servers); FileVault is on" <<< "$(digest 5)" && [ "$(calls restart)" = 1 ]'
q set F-3 state=done

# At ask, FileVault alone leaves the computer ready for a restart a person makes.
config "Mon 06:30 UTC" ask
checkout_says 0 on
q add F-4; q set F-4 state=triaged branch=fix/F-4
pj 2026-08-03T06:31:00Z; pj 2026-08-03T06:32:00Z
check "DS-226 ask with FileVault on is ready to reboot, then log in" 'grep -q "\"ready to reboot\" is in the next check-in" <<< "$out" && grep -q "restart when it suits you, then log in (FileVault is on" <<< "$(digest 6)"'
q set F-4 state=done

# ---- the row ------------------------------------------------------------------------------------
config "Someday 25:00" ask
pj 2026-10-26T06:31:00Z
check "a window row that does not read is named"            'grep -q "^maintenance: config §3b \"Maintenance window\" is \"Someday 25:00\"" <<< "$out"'
check "the template has both rows and the §3 key"           'grep -q "^| Maintenance window | \`none\` |" "$SRC/desk-config.md" && grep -q "^| Maintenance drain limit (minutes) | \`60\` |" "$SRC/desk-config.md" && grep -qE "^\| \`machine-reboot\` \| .* \| \`ask\` \| \`TODO\` \|$" "$SRC/desk-config.md"'

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
