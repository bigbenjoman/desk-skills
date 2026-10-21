#!/usr/bin/env bash
# suite: supervisor (launchd passes, the merge driver, notifications)
# supervisor.mjs with a fake pass.mjs, a fake merge driver, a fake launchctl and a fake osascript:
# install writes a RunAtLoad agent with the interval, a tick runs one pass for a handed-over batch and
# logs its report, starts one merge driver while tickets are still to merge, skips while a pass runs,
# notifies once per new set of items, passes on only the approvals recorded with the batch, runs
# nothing for an idle batch until it changes, and uninstall removes the agent. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/bin" "$T/fakes" "$T/repo" "$T/state"
export HOME="$T/home"
unset DESK_CONFIG DESK_REPO_DIR DESK_REPO_ROOT DESK_SLUG DESK_STATE DESK_DEFAULT_BRANCH DESK_GH_REPO \
  AUTOPILOT_DRY_RUN AUTOPILOT_BASE_PUSH_APPROVED
export DESK_CONFIG_ROOT="$T/cfg" DESK_REPO_OVERRIDE=acme/widgets DESK_HOME="$T/desk" \
  DESK_AUTOPILOT_STATE="$T/state" DESK_QUEUE="$T/queue.json"
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }

# config <autopilot-workers> <autopilot-merge>
config(){ mkdir -p "$T/cfg/repos/acme__widgets"; cat > "$T/cfg/repos/acme__widgets/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`$1\` |
| \`autopilot-merge\` | The merge driver merges | \`ask\` | \`$2\` |
| \`pr-merge-green\` | Merge on green | \`ask\` | \`yes\` |
EOF
}
config yes yes

# The supervisor copied beside the real modules it imports, so it runs the fakes next to it.
cp "$B/supervisor.mjs" "$T/bin/"
for f in desk-env.mjs machine.mjs test-scope.mjs batch-state.mjs; do ln -s "$B/$f" "$T/bin/$f"; done
cat > "$T/bin/pass.mjs" <<EOF
import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync('$T/pass.calls', \`\${process.env.AUTOPILOT_USER_APPROVED ?? '-'} \${process.env.AUTOPILOT_BASE_PUSH_APPROVED ?? '-'}\\n\`);
const v = JSON.parse(readFileSync('$T/verdict.json', 'utf8'));
console.log(JSON.stringify(v));
process.exitCode = v.code;
EOF
printf '#!/bin/sh\necho "$@" >> "%s/driver.calls"\n' "$T" > "$T/bin/merge-driver.sh"
cat > "$T/fakes/launchctl" <<EOF
#!/bin/sh
echo "\$@" >> "$T/launchctl.calls"
case "\$1" in
  print) [ -f "$T/loaded" ] ;;
  bootstrap) touch "$T/loaded" ;;
  bootout) rm -f "$T/loaded" ;;
esac
EOF
printf '#!/bin/sh\nprintf "%%s|" "$@" >> "%s/notify.calls"; echo >> "%s/notify.calls"\n' "$T" "$T" > "$T/fakes/osascript"
printf '#!/bin/sh\necho OPEN\n' > "$T/fakes/gh"
chmod +x "$T/bin/merge-driver.sh" "$T/fakes/launchctl" "$T/fakes/osascript" "$T/fakes/gh"
export PATH="$T/fakes:$PATH"

sup(){ (cd "$T/repo" && node "$T/bin/supervisor.mjs" "$@" 2>&1); }
# queue <supervised> <approved json> <tickets json>
queue(){ printf '{"version":1,"batch":"b1","supervised":%s,"approved":%s,"tickets":%s}\n' "$1" "$2" "$3" > "$DESK_QUEUE"; }
verdict(){ printf '%s\n' "$1" > "$T/verdict.json"; }
count(){ if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }
LOG="$T/state/supervisor.log"
RUNNING='{"A":{"key":"A","state":"running"},"B":{"key":"B","state":"parked","held_by":"A","park":{"question":"held by orchestrator: blocked by A"}}}'
NOTHING='{"status":"nothing_yet","code":10,"message":"no change this pass","waiting":[],"parked":[],"notify":false}'

# ---- install (AC2) -----------------------------------------------------------------------------
PL="$HOME/Library/LaunchAgents/com.desk-skills.supervisor.acme__widgets.plist"
out=$(sup install); rc=$?
check "install exits 0" '[ $rc -eq 0 ]'
check "install writes the agent" '[ -f "$PL" ]'
check "the agent runs at load (login)" 'grep -A1 "<key>RunAtLoad</key>" "$PL" | grep -q "<true/>"'
check "the agent runs every 180s by default" 'grep -A1 "<key>StartInterval</key>" "$PL" | grep -q "<integer>180</integer>"'
check "the agent runs a tick of this supervisor" 'grep -q "<string>$T/bin/supervisor.mjs</string>" "$PL" && grep -q "<string>tick</string>" "$PL"'
check "the agent works in the repo root" 'grep -A1 "<key>WorkingDirectory</key>" "$PL" | grep -q "$T/repo"'
check "the agent leaves the merge driver running" 'grep -A1 "<key>AbandonProcessGroup</key>" "$PL" | grep -q "<true/>"'
check "install bootstraps the agent" 'grep -q "^bootstrap gui/[0-9]* $PL$" "$T/launchctl.calls"'
out=$(sup install)
check "an unchanged install does not reload" '[ "$(grep -c "^bootstrap" "$T/launchctl.calls")" = 1 ] && grep -q "unchanged" <<< "$out"'
out=$(sup install --interval 300)
check "a new interval reloads the agent" '[ "$(grep -c "^bootstrap" "$T/launchctl.calls")" = 2 ] && grep -A1 "<key>StartInterval</key>" "$PL" | grep -q "<integer>300</integer>"'
out=$(sup install --interval 5); rc=$?
check "an interval under a minute is refused" '[ $rc -eq 2 ]'
out=$(sup status); rc=$?
check "status names the agent as loaded" '[ $rc -eq 0 ] && grep -q "installed (every 300s), loaded" <<< "$out"'

# ---- a batch not handed over -------------------------------------------------------------------
queue false '{}' "$RUNNING"; verdict "$NOTHING"
out=$(sup tick)
check "no pass for a batch not handed over at Stage 4" '[ "$(count "$T/pass.calls")" = 0 ]'

# ---- AC1 and AC3: a pass runs, its report is logged, the merge driver starts -------------------
queue true '{}' "$RUNNING"
out=$(sup tick); rc=$?
check "a tick exits 0" '[ $rc -eq 0 ]'
check "AC1: a pass runs" '[ "$(count "$T/pass.calls")" = 1 ]'
check "AC1: its report is appended to the supervisor log" 'grep -q "pass: exit 10 (nothing_yet)" "$LOG" && grep -q "^no change this pass$" "$LOG"'
check "AC3: the merge driver starts for the batch's tickets and dependencies" 'grep -qx -- "--tickets A B --deps B:A --log" "$T/driver.calls"'

# ---- AC4: a driver holding the lock means no second one -----------------------------------------
sleep 30 & HOLDER=$!
mkdir -p "$T/state/merge-driver.lock.d"; echo "$HOLDER" > "$T/state/merge-driver.lock.d/pid"
out=$(sup tick)
check "AC4: no second merge driver while one holds the lock" '[ "$(count "$T/driver.calls")" = 1 ]'
check "AC4: the log names the running driver" 'grep -q "merge driver: running (pid $HOLDER)" "$LOG"'
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
out=$(sup tick)
check "a dead driver's lock does not stop a new one" '[ "$(count "$T/driver.calls")" = 2 ]'
rm -rf "$T/state/merge-driver.lock.d"

# ---- the merge driver is not started without its grants ---------------------------------------
config yes ask
out=$(sup tick)
check "no merge driver without autopilot-merge" '[ "$(count "$T/driver.calls")" = 2 ] && grep -q "merge driver: not started, since config §3 autopilot-merge is \"ask\"" "$LOG"'
config yes yes

# ---- AC5: a pass still running ----------------------------------------------------------------
sleep 30 & HOLDER=$!
printf '{"pid":%s,"since":"x"}\n' "$HOLDER" > "$T/state/orchestrator.lock"
before=$(count "$T/pass.calls"); drivers=$(count "$T/driver.calls")
out=$(sup tick)
check "AC5: no second pass while one holds the lock" '[ "$(count "$T/pass.calls")" = "$before" ]'
check "AC5: the log records the skip" 'grep -q "skipped: a pass is still running (pid $HOLDER)" "$LOG"'
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
out=$(sup tick)
check "a dead pass's lock does not stop the next" '[ "$(count "$T/pass.calls")" = $((before + 1)) ]'
rm -f "$T/state/orchestrator.lock"

# ---- AC6 and AC7: one notification per new set of items ----------------------------------------
check "no notification while nothing needs the person" '[ "$(count "$T/notify.calls")" = 0 ]'
verdict '{"status":"show_person","code":11,"message":"NOTIFY: 2 item(s) need you","waiting":["B: FAILED — requeue it"],"parked":[{"key":"A","question":"which copy?"}],"notify":true}'
out=$(sup tick)
check "AC6: one notification" '[ "$(count "$T/notify.calls")" = 1 ]'
check "AC6: it names the repo and both items" 'grep -q "|desk: acme__widgets|2 item(s) need you: A, B|$" "$T/notify.calls"'
out=$(sup tick)
check "AC7: the same items send no second notification" '[ "$(count "$T/notify.calls")" = 1 ] && grep -q "notification: not sent, the last one already named A, B" "$LOG"'
verdict '{"status":"show_person","code":11,"message":"x","waiting":["C: FAILED"],"parked":[{"key":"A","question":"which copy?"}],"notify":true}'
out=$(sup tick)
check "a new item notifies again, naming every item" '[ "$(count "$T/notify.calls")" = 2 ] && tail -1 "$T/notify.calls" | grep -q "need you: A, C|$"'
verdict "$NOTHING"; out=$(sup tick)
verdict '{"status":"show_person","code":11,"message":"x","waiting":["C: FAILED"],"parked":[],"notify":true}'
out=$(sup tick)
check "an item that went away and came back notifies again" '[ "$(count "$T/notify.calls")" = 3 ]'

# ---- AC8: only the approvals recorded with the batch are passed on -----------------------------
config ask yes; verdict "$NOTHING"; : > "$T/pass.calls"
out=$(AUTOPILOT_USER_APPROVED=1 sup tick)
check "AC8: no approval recorded, none passed on, even one in the environment" '[ "$(cat "$T/pass.calls")" = "- -" ] && tail -3 "$LOG" | grep -q "approvals passed on: none"'
queue true '{"workers":true,"base_push":true}' "$RUNNING"; : > "$T/pass.calls"
out=$(sup tick)
check "the recorded approvals are passed on" '[ "$(cat "$T/pass.calls")" = "1 1" ] && tail -3 "$LOG" | grep -q "approvals passed on: workers, base push"'
config yes yes; queue true '{}' "$RUNNING"

# ---- AC9: an idle batch runs nothing until it changes -------------------------------------------
DONE='{"A":{"key":"A","state":"done","result":{"pr":7}},"B":{"key":"B","state":"failed"}}'
queue true '{}' "$DONE"; : > "$T/pass.calls"; : > "$T/driver.calls"
verdict '{"status":"idle","code":11,"message":"IDLE","waiting":[],"parked":[],"notify":true}'
out=$(sup tick)
check "the idle pass is logged and the batch recorded idle" '[ "$(count "$T/pass.calls")" = 1 ] && grep -q "batch b1 is idle" "$LOG"'
check "the finished batch notifies" 'tail -1 "$T/notify.calls" | grep -q "the batch is finished"'
out=$(sup tick); out=$(sup tick)
check "AC9: no pass once the batch is idle" '[ "$(count "$T/pass.calls")" = 1 ]'
check "AC9: no merge driver once the batch is idle" '[ "$(count "$T/driver.calls")" = 0 ]'
out=$(sup status)
check "status says the batch is idle" 'grep -q "batch b1: idle" <<< "$out"'
queue true '{}' '{"A":{"key":"A","state":"done","result":{"pr":7}},"B":{"key":"B","state":"triaged"}}'
verdict "$NOTHING"
out=$(sup tick)
check "a ticket requeued into the batch runs passes again" '[ "$(count "$T/pass.calls")" = 2 ]'

# ---- a pass that gives no verdict -------------------------------------------------------------
printf 'not json\n' > "$T/verdict.json"
out=$(sup tick)
check "a pass with no verdict is logged as an error and notified" 'grep -q "(error)" "$LOG" && tail -1 "$T/notify.calls" | grep -q "the pass refused or failed"'

# ---- AC10: uninstall ----------------------------------------------------------------------------
out=$(sup uninstall); rc=$?
check "AC10: uninstall exits 0" '[ $rc -eq 0 ]'
check "AC10: the agent is booted out" 'grep -q "^bootout gui/[0-9]*/com.desk-skills.supervisor.acme__widgets$" "$T/launchctl.calls" && [ ! -f "$T/loaded" ]'
check "AC10: the agent's plist is removed" '[ ! -f "$PL" ]'
out=$(sup status); rc=$?
check "status says not installed" '[ $rc -eq 1 ] && grep -q "not installed" <<< "$out"'

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
