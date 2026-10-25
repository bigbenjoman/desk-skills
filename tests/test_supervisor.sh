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
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"
# Resolved, as node resolves the script's own path: macOS temp dirs sit behind /private.
T="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/bin" "$T/fakes" "$T/repo" "$T/state"
export HOME="$T/home"
unset DESK_CONFIG DESK_REPO_DIR DESK_REPO_ROOT DESK_SLUG DESK_STATE DESK_DEFAULT_BRANCH DESK_GH_REPO \
  AUTOPILOT_DRY_RUN AUTOPILOT_BASE_PUSH_APPROVED
export DESK_CONFIG_ROOT="$T/cfg" DESK_REPO_OVERRIDE=acme/widgets DESK_HOME="$T/desk" \
  DESK_AUTOPILOT_STATE="$T/state" DESK_QUEUE="$T/queue.json" DESK_SKILLS_DIR="$T/no-skills"
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
for f in desk-env.mjs machine.mjs test-scope.mjs batch-state.mjs decider.mjs handoff.mjs briefing.mjs intake.mjs closeout.mjs installed.mjs; do ln -s "$B/$f" "$T/bin/$f"; done
cat > "$T/bin/pass.mjs" <<EOF
import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync('$T/pass.calls', \`\${process.env.AUTOPILOT_USER_APPROVED ?? '-'} \${process.env.AUTOPILOT_BASE_PUSH_APPROVED ?? '-'}\\n\`);
appendFileSync('$T/pass.args', \`\${process.argv.slice(2).join(' ')}\\n\`);
const v = JSON.parse(readFileSync('$T/verdict.json', 'utf8'));
console.log(JSON.stringify(v));
process.exitCode = v.code;
EOF
# The check-in an idle tick runs: whatever $T/checkin.json holds.
cat > "$T/bin/digest.mjs" <<EOF
import { readFileSync, existsSync } from 'node:fs';
let d = { status: 'not_due', push: null };
// checkin.hangs: a check-in that never answers.
if (existsSync('$T/checkin.hangs')) await new Promise((r) => setTimeout(r, 60_000));
try { d = JSON.parse(readFileSync('$T/checkin.json', 'utf8')); } catch {}
console.log(JSON.stringify(d));
EOF
# The maintenance step an idle tick runs: no window.
echo "console.log(JSON.stringify({ hold: false, lines: [] }));" > "$T/bin/maintenance.mjs"
# The merge driver, whose output the supervisor sends to merge-driver.log. By default it ends as the
# real one does, with its exit line; driver.mode `fail` stops it at once as a signed-out gh does, and
# `hang` keeps it running, holding the lock. driver.calls is written last, once its log lines are out.
cat > "$T/bin/merge-driver.sh" <<EOF
#!/bin/sh
case "\$(cat "$T/driver.mode" 2>/dev/null)" in
  fail) echo "00:00:01Z FAIL: gh is signed out (HTTP 401: Bad credentials) — nothing can merge until \\\`gh auth login\\\`; stopping"
        echo "00:00:01Z merge driver exited 1"; echo "\$@" >> "$T/driver.calls"; exit 1 ;;
  hang) mkdir -p "$T/state/merge-driver.lock.d"; echo \$\$ > "$T/state/merge-driver.lock.d/pid"
        echo "\$@" >> "$T/driver.calls"; exec sleep 30 ;;
esac
echo "00:00:01Z merge driver exited 0"; echo "\$@" >> "$T/driver.calls"
EOF
cat > "$T/fakes/launchctl" <<EOF
#!/bin/sh
echo "\$@" >> "$T/launchctl.calls"
case "\$1" in
  print) [ -f "$T/loaded" ] ;;
  bootstrap) touch "$T/loaded" ;;
  bootout) rm -f "$T/loaded" ;;
esac
EOF
printf '#!/bin/sh\n[ -f "%s/notify.fails" ] && exit 1\nprintf "%%s|" "$@" >> "%s/notify.calls"; echo >> "%s/notify.calls"\n' "$T" "$T" "$T" > "$T/fakes/osascript"
printf '#!/bin/sh\necho OPEN\n' > "$T/fakes/gh"
chmod +x "$T/bin/merge-driver.sh" "$T/fakes/launchctl" "$T/fakes/osascript" "$T/fakes/gh"
export PATH="$T/fakes:$PATH"

sup(){ (cd "$T/repo" && node "$T/bin/supervisor.mjs" "$@" 2>&1); }
tick(){ sup tick --foreground; }
# queue <supervised> <approved json> <tickets json> [batch]
queue(){ printf '{"version":1,"batch":"%s","supervised":%s,"approved":%s,"tickets":%s}\n' "${4:-b1}" "$1" "$2" "$3" > "$DESK_QUEUE"; }
verdict(){ printf '%s\n' "$1" > "$T/verdict.json"; }
count(){ if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }
# The merge driver and a plain tick run detached, so their files land after the tick returns: wait
# (at most 10s) for <file> to reach <n> lines.
waitlines(){ i=0; while [ "$(count "$1")" -lt "$2" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done; }
started(){ grep -c "^merge driver: started" "$LOG"; }
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
out=$(tick); out=$(tick)
check "no pass for a batch not handed over at Stage 4" '[ "$(count "$T/pass.calls")" = 0 ]'
check "the log says so, once" '[ "$(grep -c "batch b1 is not handed over" "$LOG")" = 1 ]'

# ---- AC1 and AC3: a pass runs, its report is logged, the merge driver starts -------------------
queue true '{}' "$RUNNING"
out=$(tick); rc=$?
check "a tick exits 0" '[ $rc -eq 0 ]'
check "AC1: a pass runs" '[ "$(count "$T/pass.calls")" = 1 ]'
check "AC1: its report is appended to the supervisor log" 'grep -q "pass: exit 10 (nothing_yet)" "$LOG" && grep -q "^no change this pass$" "$LOG"'
check "DS-185 AC6 and DS-221 AC4: the pass is named the supervisor's, and records the next tick, one interval away, as its next pass" 'grep -qx -- "--json --by supervisor --next +300" "$T/pass.args"'
waitlines "$T/driver.calls" 1
check "AC3: the merge driver starts for the batch's tickets" '[ "$(started)" = 1 ] && grep -qx -- "--tickets A B --log" "$T/driver.calls"'

# ---- AC2 by launchd's own path: a plain tick returns at once and the work lands -----------------
out=$(sup tick); rc=$?
waitlines "$T/pass.calls" 2
check "a plain tick (what launchd runs) still runs a pass" '[ $rc -eq 0 ] && [ "$(count "$T/pass.calls")" = 2 ]'
i=0; while { [ "$(started)" -lt 2 ] || [ -f "$T/state/supervisor.lock" ]; } && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
check "the detached run finishes and releases its lock" '[ "$(started)" = 2 ] && [ ! -f "$T/state/supervisor.lock" ]'
waitlines "$T/driver.calls" 2

# ---- AC4: a driver holding the lock means no second one -----------------------------------------
sleep 30 & HOLDER=$!
mkdir -p "$T/state/merge-driver.lock.d"; echo "$HOLDER" > "$T/state/merge-driver.lock.d/pid"
n=$(started)
out=$(tick)
check "AC4: no second merge driver while one holds the lock" '[ "$(started)" = "$n" ]'
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
out=$(tick)
check "a dead driver's lock does not stop a new one" '[ "$(started)" = $((n + 1)) ]'
rm -rf "$T/state/merge-driver.lock.d"
waitlines "$T/driver.calls" "$(started)"
check "DS-225: a driver that exits 0 is logged as stopped, not failed, and notifies nothing" 'grep -q "^merge driver: stopped (pid [0-9]*, started .*, exit 0): it wrote nothing to its log$" "$LOG" && [ "$(count "$T/notify.calls")" = 0 ]'

# ---- DS-225: why a merge driver stopped, and a notification after 2 failed starts ---------------
drv(){ node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).driver ?? {}; console.log(s[process.argv[2]])' "$T/state/supervisor.json" "$1"; }
echo fail > "$T/driver.mode"
out=$(tick); waitlines "$T/driver.calls" "$(started)"      # logs the last exit 0, starts one that fails
out=$(tick); waitlines "$T/driver.calls" "$(started)"
check "DS-225 AC1: the next tick logs the reason from the driver's log, not started" 'grep -q "^merge driver: stopped (pid [0-9]*, started .*, exit 1): FAIL: gh is signed out (HTTP 401: Bad credentials)" "$LOG"'
check "DS-225 AC1: the supervisor's record keeps the reason" 'drv reason | grep -q "^FAIL: gh is signed out" && [ "$(drv failures)" = 1 ]'
check "DS-225: one failed start notifies nothing yet" '[ "$(count "$T/notify.calls")" = 0 ]'
out=$(tick); waitlines "$T/driver.calls" "$(started)"
check "DS-225 AC3: 2 failed starts in a row send one notification naming the repo and the reason" '[ "$(count "$T/notify.calls")" = 1 ] && grep -q "|desk: acme__widgets|The merge driver failed 2 starts in a row: FAIL: gh is signed out (HTTP 401: Bad credentials)" "$T/notify.calls" && grep -q "^notification: sent for the merge driver (2 failed starts in a row)$" "$LOG"'
out=$(tick); waitlines "$T/driver.calls" "$(started)"
check "DS-225 AC3: a third failed start sends no second notification" '[ "$(count "$T/notify.calls")" = 1 ] && [ "$(drv failures)" = 3 ]'
echo hang > "$T/driver.mode"
out=$(tick)
i=0; while [ ! -s "$T/state/merge-driver.lock.d/pid" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
before=$(grep -c "merge driver" "$LOG")
out=$(tick); out=$(tick)
check "DS-225 AC4: a driver running normally gets nothing new in the log" '[ "$(grep -c "merge driver" "$LOG")" = "$before" ] && grep -q "pass: exit 10" "$LOG"'
check "DS-225 AC4: a running driver ends the run of failures" '[ "$(drv failures)" = 0 ] && [ "$(drv notified)" = false ]'
kill "$(cat "$T/state/merge-driver.lock.d/pid")" 2>/dev/null; rm -rf "$T/state/merge-driver.lock.d" "$T/driver.mode"
out=$(tick)
check "DS-225: a running driver that is killed is logged with no exit code" 'grep -q "^merge driver: stopped (pid [0-9]*, started .*, no exit code logged)" "$LOG"'
waitlines "$T/driver.calls" "$(started)"
# The notification counts below start from none.
rm -f "$T/notify.calls"

# ---- the merge driver is not started without its grants ---------------------------------------
config yes ask; n=$(started)
out=$(tick)
check "no merge driver without autopilot-merge" '[ "$(started)" = "$n" ] && grep -q "merge driver: not started, since config §3 autopilot-merge is \"ask\"" "$LOG"'
queue true '{"merge":true}' "$RUNNING"
out=$(tick); waitlines "$T/driver.calls" "$(started)"
check "DS-203 AC7: a batch that approved merging at Stage 3 gets its merge driver, though autopilot-merge is ask" '[ "$(started)" = $((n + 1)) ]'
n=$(started); queue true '{"merge":false}' "$RUNNING"
out=$(tick)
check "DS-203 AC8: a batch that declined merging gets no merge driver, and the log says why" '[ "$(started)" = "$n" ] && grep -q "merge driver: not started, since config §3 autopilot-merge is \"ask\", and merging was declined for this batch at Stage 3" "$LOG"'
config yes no; queue true '{"merge":true}' "$RUNNING"
out=$(tick)
check "DS-203: a batch approval never outranks a §3 no" '[ "$(started)" = "$n" ] && grep -q "merge driver: not started, since config §3 autopilot-merge is \"no\"" "$LOG"'
queue true '{}' "$RUNNING"
config yes yes

# ---- AC5: a pass still running, the supervisor's own or one run by hand ------------------------
for lock in supervisor.lock orchestrator.lock; do
  sleep 30 & HOLDER=$!
  printf '{"pid":%s,"since":"x"}\n' "$HOLDER" > "$T/state/$lock"
  before=$(count "$T/pass.calls")
  out=$(tick)
  check "AC5: no second pass while $lock is held" '[ "$(count "$T/pass.calls")" = "$before" ]'
  check "AC5: the log records the skip ($lock)" 'grep -q "skipped: a pass is still running (pid $HOLDER)" "$LOG"'
  kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null
  out=$(tick)
  check "a dead holder's $lock does not stop the next pass" '[ "$(count "$T/pass.calls")" = $((before + 1)) ]'
  rm -f "$T/state/$lock"
done
check "a finished run releases its lock" '[ ! -f "$T/state/supervisor.lock" ]'

# ---- AC6 and AC7: one notification per new push, and nothing else pushed ---------------------
check "no notification while nothing needs the person" '[ "$(count "$T/notify.calls")" = 0 ]'
verdict '{"status":"show_person","code":11,"message":"NOTIFY: 2 item(s) need you","waiting":["B: FAILED — requeue it"],"parked":[{"key":"A","question":"which copy?"}],"notify":true,"push":[]}'
out=$(tick)
check "DS-140 AC10: parks and failures between check-ins push nothing" '[ "$(count "$T/notify.calls")" = 0 ]'
DIG='{"key":"digest:2026-10-22T17:00","text":"Check-in 17:00: 1 question(s), 0 decision(s) across 1 repo(s). /p.md"}'
verdict "{\"status\":\"show_person\",\"code\":11,\"message\":\"x\",\"waiting\":[],\"parked\":[{\"key\":\"A\",\"question\":\"which copy?\"}],\"notify\":true,\"push\":[$DIG]}"
out=$(tick)
check "AC6: the check-in digest is one notification" '[ "$(count "$T/notify.calls")" = 1 ]'
check "AC6: it names the repo and carries the push text" 'grep -q "|desk: acme__widgets|Check-in 17:00: 1 question(s), 0 decision(s) across 1 repo(s). /p.md|$" "$T/notify.calls"'
out=$(tick)
check "AC7: the same push sends no second notification" '[ "$(count "$T/notify.calls")" = 1 ] && grep -q "notification: not sent, the last one already named digest:2026-10-22T17:00" "$LOG"'
URG='{"key":"urgent:acme__widgets:C","text":"C: PRODUCTION BROKEN: checkout 500s"}'
verdict "{\"status\":\"show_person\",\"code\":11,\"message\":\"x\",\"waiting\":[],\"parked\":[],\"notify\":true,\"push\":[$DIG,$URG]}"
touch "$T/notify.fails"; out=$(tick); rm -f "$T/notify.fails"
check "a notification that fails is logged" 'grep -q "notification: failed .* the next pass tries again" "$LOG"'
out=$(tick)
check "a failed notification is sent again, carrying only what is new" '[ "$(count "$T/notify.calls")" = 2 ] && tail -1 "$T/notify.calls" | grep -q "|C: PRODUCTION BROKEN: checkout 500s|$"'
verdict "$NOTHING"; out=$(tick)
verdict "{\"status\":\"show_person\",\"code\":11,\"message\":\"x\",\"waiting\":[],\"parked\":[],\"notify\":true,\"push\":[$URG]}"
out=$(tick)
check "a push that went away and came back notifies again" '[ "$(count "$T/notify.calls")" = 3 ]'

# ---- AC8: only the approvals recorded with the batch are passed on -----------------------------
config ask yes; verdict "$NOTHING"; : > "$T/pass.calls"
out=$(AUTOPILOT_USER_APPROVED=1 tick)
check "AC8: no approval recorded, none passed on, even one in the environment" '[ "$(cat "$T/pass.calls")" = "- -" ] && grep "approvals passed on:" "$LOG" | tail -1 | grep -q "approvals passed on: none$"'
queue true '{"workers":true,"base_push":true}' "$RUNNING"; : > "$T/pass.calls"
out=$(tick)
check "the recorded approvals are passed on" '[ "$(cat "$T/pass.calls")" = "1 1" ] && grep "approvals passed on:" "$LOG" | tail -1 | grep -q "approvals passed on: workers, base push$"'
config yes yes; queue true '{}' "$RUNNING"

# ---- AC9: an idle batch runs nothing until it changes -------------------------------------------
DONE='{"A":{"key":"A","state":"done","result":{"pr":7}},"B":{"key":"B","state":"failed"}}'
queue true '{}' "$DONE"; : > "$T/pass.calls"; n=$(started)
notified=$(count "$T/notify.calls")
verdict "{\"status\":\"idle\",\"code\":11,\"message\":\"IDLE\",\"waiting\":[\"B: FAILED — requeue it\"],\"parked\":[],\"notify\":true,\"push\":[{\"key\":\"digest:2026-10-23T08:00\",\"text\":\"Check-in 08:00\"}]}"
touch "$T/notify.fails"; out=$(tick); rm -f "$T/notify.fails"
check "an idle batch whose notification failed is not recorded idle" '! grep -q "batch b1 is idle" "$LOG"'
out=$(tick)
check "the idle pass is logged and the batch recorded idle" '[ "$(count "$T/pass.calls")" = 2 ] && grep -q "batch b1 is idle" "$LOG"'
check "DS-140: a finished batch pushes only its push entries" '[ "$(count "$T/notify.calls")" = $((notified + 1)) ] && tail -1 "$T/notify.calls" | grep -q "|Check-in 08:00|$"'
out=$(tick); out=$(tick)
check "AC9: no pass once the batch is idle" '[ "$(count "$T/pass.calls")" = 2 ]'
check "AC9: no merge driver once the batch is idle" '[ "$(started)" = "$n" ]'
notified=$(count "$T/notify.calls")
echo '{"status":"sent","push":{"key":"digest:2026-10-23T17:00","text":"Check-in 17:00: 1 question(s)"}}' > "$T/checkin.json"
out=$(tick); out=$(tick)
check "DS-140: an idle batch still pushes the check-in, once, and runs no pass" '[ "$(count "$T/notify.calls")" = $((notified + 1)) ] && tail -1 "$T/notify.calls" | grep -q "|Check-in 17:00: 1 question(s)|$" && [ "$(count "$T/pass.calls")" = 2 ]'
rm -f "$T/checkin.json"
touch "$T/checkin.hangs"; s0=$SECONDS
out=$(DESK_CHECKIN_TIMEOUT_MS=1000 tick); rc=$?
rm -f "$T/checkin.hangs"
check "DS-225 AC5: a check-in that hangs is killed at its timeout and the tick carries on" '[ $rc -eq 0 ] && [ $((SECONDS - s0)) -lt 30 ] && grep -q "idle check-in: timed out after 1s and was killed; the next tick tries again" "$LOG" && ! pgrep -f "$T/bin/digest.mjs" >/dev/null'
# A driver an earlier pass started that stops while the batch is idle is still reported, and notified.
DL="$T/state/merge-driver.log"; touch "$DL"
node -e 'const fs = require("fs"); const [f, from] = process.argv.slice(1); const s = JSON.parse(fs.readFileSync(f, "utf8")); s.driver = { pid: 999999, started: "2026-10-23T09:00:00.000Z", from: Number(from), failures: 1, notified: false }; fs.writeFileSync(f, JSON.stringify(s))' "$T/state/supervisor.json" "$(wc -c < "$DL" | tr -d ' ')"
printf '00:00:02Z FAIL: gh is signed out while idle\n00:00:02Z merge driver exited 1\n' >> "$DL"
notified=$(count "$T/notify.calls"); n=$(started)
out=$(tick)
check "DS-225 AC1/AC3: an idle tick logs why the driver stopped and notifies, running no pass" 'grep -q "^merge driver: stopped (pid 999999, started .*, exit 1): FAIL: gh is signed out while idle$" "$LOG" && [ "$(count "$T/notify.calls")" = $((notified + 1)) ] && tail -1 "$T/notify.calls" | grep -q "failed 2 starts in a row: FAIL: gh is signed out while idle|$" && [ "$(count "$T/pass.calls")" = 2 ] && [ "$(started)" = "$n" ]'
out=$(tick)
check "DS-225: the next idle tick logs nothing new about the driver" '[ "$(grep -c "999999" "$LOG")" = 1 ] && [ "$(count "$T/notify.calls")" = $((notified + 1)) ]'
out=$(sup status)
check "status says the batch is idle" 'grep -q "batch b1: idle" <<< "$out"'
mkdir -p "$T/state/closed-out"
printf '{"ticket":"B","how":"merged","pr":9,"at":"2026-10-23T09:00:00.000Z","queue":"%s"}\n' "$T/elsewhere.json" > "$T/state/closed-out/B.json"
out=$(tick)
check "DS-180 a close-out note for another queue leaves the batch idle" '[ "$(count "$T/pass.calls")" = 2 ]'
printf '{"ticket":"B","how":"merged","pr":9,"at":"2026-10-23T09:00:00.000Z","queue":"%s"}\n' "$DESK_QUEUE" > "$T/state/closed-out/B.json"
out=$(tick)
check "DS-180 an interactive close-out's note ends the idle, so a pass reads it" '[ "$(count "$T/pass.calls")" = 3 ]'
rm -f "$T/state/closed-out/B.json"
queue true '{}' '{"A":{"key":"A","state":"done","result":{"pr":7}},"B":{"key":"B","state":"triaged"}}'
verdict "$NOTHING"
out=$(tick)
check "a ticket requeued into the batch runs passes again" '[ "$(count "$T/pass.calls")" = 4 ]'
queue true '{}' "$DONE" b2
out=$(tick)
check "a new batch runs passes again" '[ "$(count "$T/pass.calls")" = 5 ]'

# ---- a pass that gives no verdict -------------------------------------------------------------
printf 'not json\n' > "$T/verdict.json"
out=$(tick)
check "a pass with no verdict is logged as an error and notified" 'grep -q "(error)" "$LOG" && tail -1 "$T/notify.calls" | grep -q "the pass refused or failed"'

# ---- DS-224: the agent's version, --reload, and what runs old code ------------------------------
mkdir -p "$DESK_HOME"; printf '{"commit":"new1"}\n' > "$DESK_HOME/installed.json"
n=$(grep -c "^bootstrap" "$T/launchctl.calls")
out=$(sup install --interval 300 --reload); out=$(sup install --interval 300 --reload)
check "DS-224 AC3: --reload reloads even an unchanged agent, and its plist names the installed version" '[ "$(grep -c "^bootstrap" "$T/launchctl.calls")" = $((n + 2)) ] && grep -A1 "<key>DESK_AGENT_VERSION</key>" "$PL" | grep -q "<string>new1</string>"'
code(){ node -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).code; console.log(`${c.installed} ${c.supervisor.version} ${c.supervisor.old_code} ${c.driver?.version} ${c.driver?.old_code}`)' "$T/state/supervisor.json"; }
sleep 30 & HOLDER=$!
mkdir -p "$T/state/merge-driver.lock.d"; echo "$HOLDER" > "$T/state/merge-driver.lock.d/pid"; echo old0 > "$T/state/merge-driver.lock.d/version"
out=$(DESK_AGENT_VERSION=old0 tick)
check "DS-224 AC5: an agent and a merge driver started at an older version are recorded as running old code" '[ "$(code)" = "new1 old0 true old0 true" ]'
echo new1 > "$T/state/merge-driver.lock.d/version"
out=$(DESK_AGENT_VERSION=new1 tick)
check "DS-224 AC5: once both run the installed version, the record says neither runs old code" '[ "$(code)" = "new1 new1 false new1 false" ]'
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null; rm -rf "$T/state/merge-driver.lock.d"

# ---- AC10: uninstall ----------------------------------------------------------------------------
out=$(sup uninstall); rc=$?
check "AC10: uninstall exits 0" '[ $rc -eq 0 ]'
check "AC10: the agent is booted out" 'grep -q "^bootout gui/[0-9]*/com.desk-skills.supervisor.acme__widgets$" "$T/launchctl.calls" && [ ! -f "$T/loaded" ]'
check "AC10: the agent's plist is removed" '[ ! -f "$PL" ]'
out=$(sup status); rc=$?
check "status says not installed" '[ $rc -eq 1 ] && grep -q "not installed" <<< "$out"'

# Let any detached fake driver finish before the scratch directory goes.
waitlines "$T/driver.calls" "$(started)"
echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
