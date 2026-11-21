#!/usr/bin/env bash
# suite: supervisor (launchd and systemd passes, the merge driver, notifications)
# supervisor.mjs with a fake pass.mjs, a fake merge driver, a fake launchctl and a fake osascript, as
# on macOS (DESK_PLATFORM=darwin), then a fake systemctl and a fake notify-send, as on Linux:
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
  DESK_AUTOPILOT_STATE="$T/state" DESK_QUEUE="$T/queue.json" DESK_SKILLS_DIR="$T/no-skills" DESK_PLATFORM=darwin
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }

# config <autopilot-workers> <autopilot-merge> [<running on WSL?>, default no, so a WSL host reads as plain Linux]
config(){ mkdir -p "$T/cfg/repos/acme__widgets"; cat > "$T/cfg/repos/acme__widgets/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |
| Running on WSL? | \`${3:-no}\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`$1\` |
| \`autopilot-merge\` | The merge driver merges | \`ask\` | \`$2\` |
| \`pr-merge-green\` | Merge on green | \`ask\` | \`yes\` |
EOF
}
config yes yes

# The supervisor copied beside the fakes below and links to the real modules (link_bin, after them),
# so it runs the fakes next to it. installed.mjs is copied too: it restarts the merge driver beside it,
# which must be the fake.
# shellcheck source=link_bin.sh
. "$S/link_bin.sh"
cp "$B/supervisor.mjs" "$B/installed.mjs" "$T/bin/"
# The fake pass reads its batch's base as the real one does, so a base it inherited is refused here too.
# verdict.<batch>.json (standing for the standing batch), where it exists, is that batch's own verdict.
cat > "$T/bin/pass.mjs" <<EOF
import { appendFileSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import * as E from './desk-env.mjs';
appendFileSync('$T/pass.calls', \`\${process.env.AUTOPILOT_USER_APPROVED ?? '-'} \${process.env.AUTOPILOT_BASE_PUSH_APPROVED ?? '-'}\\n\`);
// exit.during: a worker exits while this pass runs, once.
if (existsSync('$T/exit.during')) { rmSync('$T/exit.during'); mkdirSync(E.exitsDir(), { recursive: true }); writeFileSync(\`\${E.exitsDir()}/B.2.json\`, '{}\\n'); }
// exit.burst: ten workers exit over a second from now, the first while this pass runs, once.
if (existsSync('$T/exit.burst')) {
  rmSync('$T/exit.burst'); writeFileSync(\`\${E.exitsDir()}/A.b1.json\`, '{}\\n');
  const more = "const fs = require('fs'); let i = 1; const t = setInterval(() => { i += 1; fs.writeFileSync(process.argv[1] + '/A.b' + i + '.json', '{}'); if (i === 10) clearInterval(t); }, 100);";
  spawn(process.execPath, ['-e', more, E.exitsDir()], { detached: true, stdio: 'ignore' }).unref();
}
appendFileSync('$T/pass.args', \`\${process.argv.slice(2).join(' ')}\\n\`);
appendFileSync('$T/pass.woken', \`\${process.env.DESK_BATCH ?? '-'} \${process.argv.includes('--woken')}\\n\`);
let base;
try { E.applyBatchBase(); base = E.defaultBranch(); } catch { base = 'REFUSED'; }
appendFileSync('$T/pass.batches', \`\${process.env.DESK_BATCH ?? '-'} \${base}\\n\`);
const own = \`$T/verdict.\${process.env.DESK_BATCH ?? 'standing'}.json\`;
const v = JSON.parse(readFileSync(existsSync(own) ? own : '$T/verdict.json', 'utf8'));
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
link_bin "$B" "$T/bin"
# The merge driver, whose output the supervisor sends to merge-driver.log. By default it ends as the
# real one does, with its exit line; driver.mode `fail` stops it at once as a signed-out gh does, and
# `hang` keeps it running, holding the lock. driver.calls is written last, once its log lines are out.
cat > "$T/bin/merge-driver.sh" <<EOF
#!/bin/sh
echo "\${DESK_BATCH:--} \$*" >> "$T/driver.batches"
case "\$(cat "$T/driver.mode" 2>/dev/null)" in
  fail) echo "00:00:01Z FAIL: gh is signed out (HTTP 401: Bad credentials) — nothing can merge until \\\`gh auth login\\\`; stopping"
        echo "00:00:01Z merge driver exited 1"; echo "\$@" >> "$T/driver.calls"; exit 1 ;;
  hang) mkdir -p "$T/state/merge-driver.lock.d"; echo \$\$ > "$T/state/merge-driver.lock.d/pid"
        echo "\$@" >> "$T/driver.calls"; exec sleep 30 ;;
  # loop: as the real one at rest, it records the version of the release it runs from in its lock,
  # sleeps between loops (or, with $T/busy, is mid-loop: its child is not sleep), and on TERM drops the lock.
  loop) D="\$DESK_AUTOPILOT_STATE/merge-driver.lock.d"; mkdir -p "\$D"; echo \$\$ > "\$D/pid"
        node "\$(dirname "\$0")/installed.mjs" running > "\$D/version"
        echo "\$@" >> "$T/driver.calls"
        trap 'rm -rf "\$D"; exit 143' TERM
        while true; do if [ -f "$T/busy" ]; then tail -f /dev/null; else sleep 30; fi; done ;;
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
EX="$T/state/exits"
check "DS-695: install makes the exits folder, and the agent ticks when it changes, at most every 20s" '[ -d "$EX" ] && grep -A2 "<key>WatchPaths</key>" "$PL" | grep -qF "<string>$EX</string>" && grep -A1 "<key>ThrottleInterval</key>" "$PL" | grep -q "<integer>20</integer>"'
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

# ---- DS-695: a worker's exit file wakes a tick, which consumes it -----------------------------------
# old <file>: an exit file written before any round now starts. No gap between rounds here but where set.
old(){ printf '{}\n' > "$EX/$1"; touch -t 202001010000 "$EX/$1"; }
export DESK_WAKE_GAP_MS=0
WAKE="$T/state/supervisor.wake"; COUNTED="$T/state/supervisor.counted"
rm -f "$WAKE" "$COUNTED"
before=$(count "$T/pass.calls")
old A.1.json; printf '{}\n' > "$EX/.A.9.tmp"
out=$(tick)
check "DS-695 AC1: a tick runs a pass and deletes the exit file it saw, not one still being written" '[ "$(count "$T/pass.calls")" = $((before + 1)) ] && [ ! -e "$EX/A.1.json" ] && [ -e "$EX/.A.9.tmp" ]'
check "DS-695: the first pass in an interval counts a quiet pass" '[ "$(tail -1 "$T/pass.args" | grep -c -- "--woken")" = 0 ]'
rm -f "$EX/.A.9.tmp"
out=$(tick)
check "DS-695 AC2: the wake that deletion causes runs no pass" '[ "$(count "$T/pass.calls")" = $((before + 1)) ]'
# Ten exits over a second, from inside a pass that takes no time: the gap folds them into one round.
rm -f "$WAKE" "$COUNTED"; old A.10.json; touch "$T/exit.burst"
out=$(DESK_WAKE_GAP_MS=3000 tick)
check "DS-695 AC2: ten exits in a burst run at most two passes, and every file goes" '[ "$(count "$T/pass.calls")" = $((before + 3)) ] && [ -z "$(ls -A "$EX")" ]'
check "DS-695: a pass an exit adds within the interval counts no quiet pass" '[ "$(tail -1 "$T/pass.args" | grep -c -- " --woken")" = 1 ]'
# Two more exits of the burst, each starting its own tick (as a systemd path unit does): the first waits
# out the gap from the burst's last round and passes both; the second then finds nothing left.
printf '{}\n' > "$EX/G.2.json"; (DESK_WAKE_GAP_MS=3000 tick >/dev/null) & T2=$!
sleep 0.5; printf '{}\n' > "$EX/G.3.json"; (DESK_WAKE_GAP_MS=3000 tick >/dev/null) & T3=$!
wait "$T2" "$T3"
check "DS-695 AC2: separate ticks within one burst run one more pass between them, no more" '[ "$(count "$T/pass.calls")" = $((before + 4)) ] && [ -z "$(ls -A "$EX")" ]'
rm -f "$WAKE"
# A tick holding the repo's tick lock: one woken meanwhile waits for it, then runs only for what it left.
HOLDER=$(sh -c 'sleep 4 >/dev/null 2>&1 & echo $!')
printf '{"pid":%s,"since":"x"}\n' "$HOLDER" > "$T/state/supervisor.tick.lock"
old A.11.json; ( sleep 2; rm -f "$EX/A.11.json" ) &
out=$(tick); wait
check "DS-695 AC2: a tick woken while another runs its rounds waits, and passes nothing that one consumed" '[ "$(count "$T/pass.calls")" = $((before + 4)) ] && [ ! -e "$T/state/supervisor.tick.lock" ]'
# An interval after the last counted pass, a pass counts whatever woke it: an exit file never stops it.
old A.12.json; printf '2020-01-01T00:00:00.000Z\n' > "$COUNTED"
out=$(tick)
check "DS-695: once an interval has passed, the pass counts a quiet pass though an exit woke it" '[ "$(count "$T/pass.calls")" = $((before + 5)) ] && [ "$(tail -1 "$T/pass.args" | grep -c -- "--woken")" = 0 ]'
before=$((before + 4))
old A.3.json; touch "$T/exit.during"
out=$(tick)
check "DS-695 AC2: an exit landing while the pass runs gets one more round, no more, and both files go" '[ "$(count "$T/pass.calls")" = $((before + 3)) ] && [ -z "$(ls -A "$EX")" ]'
sleep 30 & HOLDER=$!
printf '{"pid":%s,"since":"x"}\n' "$HOLDER" > "$T/state/supervisor.lock"
old A.4.json
out=$(tick)
check "DS-695: a tick whose pass is skipped for a lock leaves the exit for the run holding it" '[ "$(count "$T/pass.calls")" = $((before + 3)) ] && [ -e "$EX/A.4.json" ]'
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null; rm -f "$T/state/supervisor.lock"
out=$(tick)
check "DS-695: the next tick passes and consumes it" '[ "$(count "$T/pass.calls")" = $((before + 4)) ] && [ ! -e "$EX/A.4.json" ]'
old A.5.json; chmod 555 "$EX"
out=$(tick); out=$(tick)
chmod 755 "$EX"
check "DS-695 AC3: an exits folder that cannot be written to still gets a pass every tick, one round each" '[ "$(count "$T/pass.calls")" = $((before + 6)) ] && [ -e "$EX/A.5.json" ]'
rm -f "$EX/A.5.json" "$WAKE" "$COUNTED"
unset DESK_WAKE_GAP_MS

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
# The last pass's heartbeat, 20 minutes old, with the next tick it planned long past.
BEAT=$(node -e 'import(process.argv[1]).then((m) => console.log(m.beatFile(process.argv[2], process.argv[3])))' "$B/borrow.mjs" "$T/state" "$DESK_QUEUE")
mkdir -p "$T/state/orchestrators"
node -e 'const t = Date.now() - 20 * 60000; require("fs").writeFileSync(process.argv[1], JSON.stringify({ queue: process.argv[2], batch: "b1", pid: 1, at: new Date(t).toISOString(), next: new Date(t + 180000).toISOString() }))' "$BEAT" "$DESK_QUEUE"
t0=$(node -e 'console.log(Date.now())')
out=$(tick); out=$(tick)
check "AC9: no pass once the batch is idle" '[ "$(count "$T/pass.calls")" = 2 ]'
check "AC9: no merge driver once the batch is idle" '[ "$(started)" = "$n" ]'
# DS-396 AC2: the idle tick runs no pass, so it refreshes the heartbeat itself: `at` the tick's time,
# `next` the agent's next tick, and desk-q's liveBeat reads the batch as live again.
every=$(grep -A1 '<key>StartInterval</key>' "$PL" | grep -oE '[0-9]+')
check "DS-396 AC2: an idle tick's heartbeat is at the tick's time, its next one interval on, live, and keeps the last pass's time" \
  '[ "$(node -e "import(process.argv[1]).then((m) => { const b = JSON.parse(require(\"fs\").readFileSync(process.argv[2], \"utf8\")); const at = Date.parse(b.at), t0 = Number(process.argv[3]); const lb = m.lastBeat(process.argv[6], process.argv[5]); console.log([at >= t0 && at <= Date.now(), Date.parse(b.next) - at === Number(process.argv[4]) * 1000, b.queue === process.argv[5] && b.batch === \"b1\", m.liveBeat(lb), t0 - lb.pass >= 20 * 60000 && t0 - lb.pass < 21 * 60000].join(\" \")); })" "$B/borrow.mjs" "$BEAT" "$t0" "$every" "$DESK_QUEUE" "$T/state")" = "true true true true true" ]'
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
# The auto-release's push from an idle tick's maintenance step goes out once.
echo "console.log(JSON.stringify({ hold: false, lines: ['release: red'], push: [{ key: 'release-failed-abc', text: 'main tests check failed on abc' }] }));" > "$T/bin/maintenance.mjs"
notified=$(count "$T/notify.calls")
out=$(tick); out=$(tick)
check "DS-276 AC3: an idle tick pushes the maintenance step's push, once" '[ "$(count "$T/notify.calls")" = $((notified + 1)) ] && tail -1 "$T/notify.calls" | grep -q "|main tests check failed on abc|$" && grep -q "idle maintenance: notification sent for release-failed-abc" "$LOG"'
echo "console.log(JSON.stringify({ hold: false, lines: [] }));" > "$T/bin/maintenance.mjs"
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

# ---- DS-269: an idle batch rechecks on a timer, and any answer to a park wakes it -------------------
verdict '{"status":"idle","code":11,"message":"IDLE","waiting":[],"parked":[],"notify":true,"push":[]}'
: > "$T/pass.calls"
out=$(tick); out=$(tick)
check "DS-269 an idle batch with a failed ticket runs no pass before the recheck interval" '[ "$(count "$T/pass.calls")" = 1 ]'
# backdate <seconds>: moves the recorded idle that far into the past, as if the batch had sat idle that
# long, so an interval passes without the test waiting it out. Each case below backdates 10 minutes
# and sets a 5-minute interval: a tick on a loaded machine never takes the difference.
backdate(){ node -e 'const fs = require("fs"), f = process.argv[1], s = JSON.parse(fs.readFileSync(f, "utf8")); s.idle_at = new Date(Date.parse(s.idle_at) - Number(process.argv[2]) * 1000).toISOString(); fs.writeFileSync(f, JSON.stringify(s))' "$T/state/supervisor.json" "$1"; }
# The first idle is 10 minutes old by the recheck, so a 5-minute interval runs a pass after it only if
# that pass did not record the idle again.
backdate 600
out=$(DESK_IDLE_RECHECK_MS=300000 tick)
check "DS-269 AC1 once the interval has passed, the next tick runs a pass anyway" '[ "$(count "$T/pass.calls")" = 2 ] && grep -q "a park is answered, or 30 minutes pass with anything parked, failed or held behind a blocker in no batch" "$LOG"'
out=$(DESK_IDLE_RECHECK_MS=300000 tick)
check "DS-269 AC1 that pass starts the interval again" '[ "$(count "$T/pass.calls")" = 2 ]'
queue true '{}' '{"A":{"key":"A","state":"done","result":{"pr":7}}}' b3
out=$(tick); out=$(DESK_IDLE_RECHECK_MS=1 tick)
check "DS-269 AC1 a batch with nothing parked or failed still runs none" '[ "$(count "$T/pass.calls")" = 3 ]'
queue true '{}' '{"A":{"key":"A","state":"done","result":{"pr":7}},"P":{"key":"P","state":"parked","lane":"A","park":{"question":"which colour?","since":"2020-01-01T09:00:00.000Z"}}}' b4
mkdir -p "$T/state/briefings"
printf '# Briefing for P\n\n## Answer from the user (2020-01-01T09:30:00Z)\n\nan answer the last pass already had\n' > "$T/state/briefings/P.md"
out=$(tick); out=$(tick)
check "DS-269 AC5 an answer older than the idle wakes nothing" '[ "$(count "$T/pass.calls")" = 4 ]'
# The idle is 10 minutes old (inside the 30-minute recheck), so an answer stamped this second is after it.
backdate 600
printf '\n## Answer from the user (%s)\n\nblue\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$T/state/briefings/P.md"
out=$(tick)
check "DS-269 AC5 an answer to a park never handed on ends the idle: a pass runs" '[ "$(count "$T/pass.calls")" = 5 ]'
out=$(tick)
check "DS-269 AC5 once a pass has run, the same answer wakes it no more" '[ "$(count "$T/pass.calls")" = 5 ]'
queue true '{}' "$DONE" b5

# ---- DS-815: an idle batch held only behind blockers in no batch rechecks on the timer too ---------
verdict '{"status":"idle","code":11,"message":"IDLE","waiting":[],"parked":[],"notify":true,"push":[]}'
queue true '{}' '{"H":{"key":"H","state":"parked","held_by":"X-1","held_outside":"X-1","park":{"question":"held by orchestrator: blocked by X-1"}}}' b6
: > "$T/pass.calls"
out=$(tick); out=$(tick)
check "DS-815 an idle batch held behind an outside blocker runs no pass before the recheck interval" '[ "$(count "$T/pass.calls")" = 1 ]'
backdate 600
out=$(DESK_IDLE_RECHECK_MS=300000 tick)
check "DS-815 AC1 once the interval has passed, a batch held only behind an outside blocker runs a pass" '[ "$(count "$T/pass.calls")" = 2 ]'
queue true '{}' '{"A":{"key":"A","state":"done","result":{"pr":7}},"H":{"key":"H","state":"parked","held_by":"A","held_outside":"X-9","park":{"question":"held by orchestrator: blocked by A"}}}' b7
: > "$T/pass.calls"
out=$(tick); backdate 600
out=$(DESK_IDLE_RECHECK_MS=300000 tick)
check "DS-815 AC2 a batch held only behind blockers inside it, an outside key a release left behind included, runs no extra pass on the interval" '[ "$(count "$T/pass.calls")" = 1 ]'
queue true '{}' "$DONE" b8

# ---- DS-836: an idle batch recording a PR no ticket owns rechecks on the timer, so a pass drops it ---
# Every ticket done and nothing parked, failed or held, so only the recorded PR can make it recheck.
SETTLED='{"A":{"key":"A","state":"done","result":{"pr":7}}}'
tl_queue(){ printf '{"version":1,"batch":"%s","supervised":true,"approved":{},%s"tickets":%s}\n' "$1" "$2" "$SETTLED" > "$DESK_QUEUE"; }
tl_queue b836 '"ticketless_prs":[{"pr":10,"title":"t","branch":"fix/x","since":null}],'
: > "$T/pass.calls"
out=$(tick); out=$(tick)
check "DS-836 AC2 an idle batch recording a ticketless PR runs no pass before the recheck interval" '[ "$(count "$T/pass.calls")" = 1 ] && grep -q "or a PR no ticket owns still recorded" "$LOG"'
backdate 600
out=$(DESK_IDLE_RECHECK_MS=300000 tick)
check "DS-836 AC2 once the interval has passed, it runs a pass, which reads the PR merged or closed" '[ "$(count "$T/pass.calls")" = 2 ]'
tl_queue b836c ''
: > "$T/pass.calls"
out=$(tick); backdate 600
out=$(DESK_IDLE_RECHECK_MS=300000 tick)
check "DS-836 the same settled batch with no PR recorded runs no pass on the interval" '[ "$(count "$T/pass.calls")" = 1 ]'
queue true '{}' "$DONE" b836b

# ---- DS-852: an idle batch whose park waits on an Actions run rechecks on the shorter interval -----
verdict '{"status":"idle","code":11,"message":"IDLE","waiting":[],"parked":[],"notify":true,"push":[]}'
queue true '{}' '{"R":{"key":"R","state":"parked","lane":"A","park":{"question":"wait for the run","clears_when":{"kind":"run-completed","run":44719886024}}}}' b9
: > "$T/pass.calls"
out=$(tick)
check "DS-852 the idle line names the shorter interval while a park waits on a run" 'grep -q "(2 minutes while a park waits on an Actions run or a PR.s checks)" "$LOG"'
backdate 600
out=$(DESK_RUN_RECHECK_MS=300000 tick)
check "DS-852 AC2 once the run interval has passed, an idle batch waiting on a run runs a pass, well inside the idle interval" '[ "$(count "$T/pass.calls")" = 2 ]'
out=$(DESK_RUN_RECHECK_MS=300000 tick)
check "DS-852 AC2 that pass starts the run interval again" '[ "$(count "$T/pass.calls")" = 2 ]'
queue true '{}' '{"P":{"key":"P","state":"parked","lane":"A","park":{"question":"which colour?","clears_when":{"kind":"none"}}}}' b10
# P's answer from the idle-recheck cases above is not this batch's: backdated past it, the idle would read it as new.
rm -f "$T/state/briefings/P.md"; : > "$T/pass.calls"
out=$(tick); backdate 600
out=$(DESK_RUN_RECHECK_MS=300000 tick)
check "DS-852 AC6 an idle batch with no park on a run or checks keeps the idle interval" '[ "$(count "$T/pass.calls")" = 1 ]'
queue true '{}' "$DONE" b11

# ---- a pass that gives no verdict -------------------------------------------------------------
printf 'not json\n' > "$T/verdict.json"
out=$(tick)
check "a pass with no verdict is logged as an error and notified" 'grep -q "(error)" "$LOG" && tail -1 "$T/notify.calls" | grep -q "the pass refused or failed"'

# ---- DS-276 AC3: a pass that refused or failed keeps the keys already sent ----------------------
REL='{"key":"release-failed-abc","text":"main tests check failed on abc"}'
verdict "{\"status\":\"show_person\",\"code\":11,\"message\":\"x\",\"waiting\":[],\"parked\":[],\"notify\":true,\"push\":[$REL]}"
out=$(tick); notified=$(count "$T/notify.calls")
verdict '{"status":"error","code":2,"message":"REFUSED: something else"}'
out=$(tick)
check "DS-276 AC3: a refused pass is still notified" '[ "$(count "$T/notify.calls")" = $((notified + 1)) ] && tail -1 "$T/notify.calls" | grep -q "the pass refused or failed: REFUSED: something else"'
verdict "{\"status\":\"show_person\",\"code\":11,\"message\":\"x\",\"waiting\":[],\"parked\":[],\"notify\":true,\"push\":[$REL]}"
out=$(tick)
check "DS-276 AC3: the next pass does not push a key sent before the refused one again" '[ "$(count "$T/notify.calls")" = $((notified + 1)) ] && grep -q "notification: not sent, the last one already named release-failed-abc" "$LOG"'

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
mv "$DESK_QUEUE" "$T/queue.away"
out=$(DESK_AGENT_VERSION=old0 tick)
check "DS-224 AC5: a tick with no batch still records the agent as running old code" '[ "$(code)" = "new1 old0 true new1 false" ]'
printf 'not json\n' > "$DESK_QUEUE"
out=$(DESK_AGENT_VERSION=new1 tick)
check "DS-224 AC5: so does a tick whose queue is unreadable" '[ "$(code)" = "new1 new1 false new1 false" ]'
mv "$T/queue.away" "$DESK_QUEUE"
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null; rm -rf "$T/state/merge-driver.lock.d"

# ---- DS-666: a merge driver on old code moves to the installed code once it waits between loops ----
held(){ cat "$T/state/merge-driver.lock.d/pid" 2>/dev/null; }
# A driver an earlier tick left, detached, that runs from the older release old0 while installed.json
# names new1: it writes its lock's version itself. It waits for the driver's sleep (or, mid-loop,
# tail): the node writing its version has finished by then.
OLDREL="$DESK_HOME/releases/old0"; mkdir -p "$OLDREL/bin"; printf '{"commit":"old0","release":"old0"}\n' > "$OLDREL/release.json"
cp "$T/bin/merge-driver.sh" "$T/bin/installed.mjs" "$OLDREL/bin/"
link_bin "$T/bin" "$OLDREL/bin"
olddriver(){
  kid='sleep'; [ -f "$T/busy" ] && kid='tail'
  echo loop > "$T/driver.mode"; rm -rf "$T/state/merge-driver.lock.d"
  (cd "$T/repo" && "$OLDREL/bin/merge-driver.sh" --tickets "A B" --deps "B:A" --log </dev/null >/dev/null 2>&1 &)
  i=0; while { [ -z "$(held)" ] || ! pgrep -x -P "$(held)" "$kid" >/dev/null; } && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
}
# setdriver <pid> <from>: supervisor.json's record of the driver the supervisor itself started.
setdriver(){ node -e 'const f = process.argv[1]; const s = JSON.parse(require("fs").readFileSync(f, "utf8")); s.driver = { failures: 0, notified: false, pid: Number(process.argv[2]), started: "then", from: Number(process.argv[3]) }; require("fs").writeFileSync(f, JSON.stringify(s))' "$T/state/supervisor.json" "$1" "$2"; }
driverrec(){ node -e 'const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).driver; console.log(`${d.pid} ${d.started === "then"} ${d.from}`)' "$T/state/supervisor.json"; }
stopdriver(){ p="$(held)"; [ -n "$p" ] && { kill "$p" 2>/dev/null; pkill -P "$p" 2>/dev/null; }; i=0; while [ -n "$(held)" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done; rm -rf "$T/state/merge-driver.lock.d"; }
olddriver; old="$(held)"; n=$(count "$T/driver.calls")
check "DS-810: the supervisor's driver here, started from an older release, holds a lock naming that release (the real driver's write: test_merge_driver_loop.sh)" '[ "$(cat "$T/state/merge-driver.lock.d/version")" = old0 ]'
# A pass running holds supervisor.lock: the driver is not moved under it.
sleep 30 & PASSPID=$!; printf '{"pid":%s}\n' "$PASSPID" > "$T/state/supervisor.lock"
out=$(DESK_AGENT_VERSION=new1 tick)
check "DS-666 AC1: no driver is moved while a pass holds the lock" '[ "$(held)" = "$old" ] && [ "$(count "$T/driver.calls")" = "$n" ] && ! grep -q "restarted on the new code" "$LOG"'
kill "$PASSPID" 2>/dev/null; wait "$PASSPID" 2>/dev/null; rm -f "$T/state/supervisor.lock"
setdriver "$old" 0; from=0; [ -f "$T/state/merge-driver.log" ] && from=$(wc -c < "$T/state/merge-driver.log" | tr -d ' ')
out=$(DESK_AGENT_VERSION=new1 tick); new="$(held)"
check "DS-666 AC1: the supervisor's own driver is followed to its new pid, its stop read from the new one's output" '[ "$(driverrec)" = "$new false $from" ]'
check "DS-666 AC1: the tick stops a driver on old code that waits between loops" '[ -n "$old" ] && ! kill -0 "$old" 2>/dev/null'
check "DS-666 AC1: and starts it again with the same tickets and deps" '[ -n "$new" ] && [ "$new" != "$old" ] && kill -0 "$new" && [ "$(count "$T/driver.calls")" = $((n + 1)) ] && [ "$(tail -1 "$T/driver.calls")" = "--tickets A B --deps B:A --log" ]'
check "DS-666 AC1: its lock records the installed commit, and supervisor.json says it is current" '[ "$(cat "$T/state/merge-driver.lock.d/version")" = new1 ] && [ "$(code)" = "new1 new1 false new1 false" ]'
check "DS-666 AC1: the log says it was restarted on the new code" 'grep -q "merge driver for acme__widgets: restarted on the new code (pid $old -> $new) for A B$" "$LOG"'
out=$(DESK_AGENT_VERSION=new1 tick)
check "DS-666 AC1: a driver on the installed code is left alone" '[ "$(held)" = "$new" ] && [ "$(grep -c "restarted on the new code" "$LOG")" = 1 ]'
stopdriver
touch "$T/busy"; olddriver; busy="$(held)"; n=$(count "$T/driver.calls")
out=$(DESK_AGENT_VERSION=new1 tick); out=$(DESK_AGENT_VERSION=new1 tick)
check "DS-666 AC2: a driver on old code that is mid-loop is left running" 'kill -0 "$busy" && [ "$(held)" = "$busy" ] && [ "$(count "$T/driver.calls")" = "$n" ]'
check "DS-666 AC2: the log says, once, it was left because it is mid-loop" '[ "$(grep -c "merge driver for acme__widgets (pid $busy): left running on the old code, it is mid-loop and may be merging" "$LOG")" = 1 ]'
rm -f "$T/busy"; stopdriver; rm -f "$T/driver.mode"

# ---- DS-309: a tick runs every batch in the repo, each on its own base ---------------------------
# No explicit queue or state here: the repo's own paths, the standing batch and batches/<name>/ under it.
SQ="$DESK_HOME/repos/acme__widgets/queue.json"; SS="$HOME/.desk-autopilot/acme__widgets"
XQ="$DESK_HOME/repos/acme__widgets/batches/X-1/queue.json"; XS="$SS/batches/X-1"
YQ="$DESK_HOME/repos/acme__widgets/batches/Y-1/queue.json"; YS="$SS/batches/Y-1"
mtick(){ (unset DESK_QUEUE DESK_AUTOPILOT_STATE; tick); }
XRUN='{"X1":{"key":"X1","state":"running"}}'
# bq <queue file> <batch> <supervised> <tickets json> [base]
bq(){ mkdir -p "$(dirname "$1")"; b=""; [ -n "${5:-}" ] && b="\"base\":\"$5\","
  printf '{"version":1,"batch":"%s","supervised":%s,%s"approved":{},"tickets":%s}\n' "$2" "$3" "$b" "$4" > "$1"; }
# Intake that is always due, counting its runs.
rm -f "$T/bin/intake.mjs"
cat > "$T/bin/intake.mjs" <<EOF
import { appendFileSync } from 'node:fs';
export const intakeQuery = () => 'project = ACME';
export const prOpen = () => true;
export const handedByIntake = () => [];
export const takePushed = () => [];
if (process.argv[2] === 'run') { appendFileSync('$T/intake.calls', 'run\n'); console.log(JSON.stringify({ lines: ['intake: nothing new'] })); }
EOF
# gh answers each PR's state from $T/gh/<n>, OPEN where there is none.
mkdir -p "$T/gh"
printf '#!/bin/sh\ncat "%s/gh/$3" 2>/dev/null || echo OPEN\n' "$T" > "$T/fakes/gh"
verdict "$NOTHING"; : > "$T/pass.batches"; : > "$T/driver.batches"
bq "$SQ" s1 true "$RUNNING"
out=$(mtick)
check "DS-309 AC8: with only the standing batch, a tick runs intake and one pass, as before" '[ "$(cat "$T/pass.batches")" = "- main" ] && [ "$(count "$T/intake.calls")" = 1 ] && grep -q "pass: exit 10 (nothing_yet)" "$SS/supervisor.log" && grep -q "^intake: nothing new$" "$SS/supervisor.log"'
waitlines "$T/driver.batches" 1
# Nothing running and its last promotion merged: a named batch so would be archived, the standing one never.
printf '{"version":1,"batch":"s1","supervised":true,"promotion":{"pr":9},"approved":{},"tickets":{}}\n' > "$SQ"
echo MERGED > "$T/gh/9"; out=$(mtick); rm -f "$T/gh/9"
check "DS-311 AC11: with only the standing batch, no archive check runs and nothing is moved" '[ -f "$SQ" ] && [ -d "$SS" ] && [ ! -e "$DESK_HOME/repos/.done" ] && [ ! -e "$HOME/.desk-autopilot/.done" ] && ! grep -q "archiv" "$SS/supervisor.log"'
bq "$SQ" s1 true "$RUNNING"
bq "$XQ" X-1 true "$XRUN" feat/x
: > "$T/pass.batches"; : > "$T/driver.batches"
out=$(DESK_DEFAULT_BRANCH=feat/x mtick)
check "DS-309 AC1: intake runs once and each batch gets one pass, the standing batch first" '[ "$(count "$T/intake.calls")" = 3 ] && [ "$(count "$T/pass.batches")" = 2 ]'
check "DS-309 AC1: each pass is logged in its own state folder" '[ "$(grep -c "pass: exit 10" "$XS/supervisor.log")" = 1 ] && [ "$(grep -c "pass: exit 10" "$SS/supervisor.log")" = 3 ] && ! grep -q "intake:" "$XS/supervisor.log"'
check "DS-309 AC2: the standing pass targets main and X-1 its own base, though feat/x was inherited" '[ "$(head -1 "$T/pass.batches")" = "- main" ] && [ "$(tail -1 "$T/pass.batches")" = "X-1 feat/x" ]'
waitlines "$T/driver.batches" 2
check "DS-309 AC4: each batch starts its own merge driver on its own queue" 'grep -qx -- "- --tickets A B --log" "$T/driver.batches" && grep -qx -- "X-1 --tickets X1 --log" "$T/driver.batches" && grep -q "^merge driver: started" "$XS/supervisor.log"'
notified=$(count "$T/notify.calls")
printf '%s\n' '{"status":"show_person","code":11,"message":"x","waiting":[],"parked":[],"notify":true,"push":[{"key":"urgent:acme__widgets:X1","text":"X1: PRODUCTION BROKEN: checkout 500s"}]}' > "$T/verdict.X-1.json"
out=$(mtick)
check "DS-309 AC5: a notification about X-1 names the repo and X-1" '[ "$(count "$T/notify.calls")" = $((notified + 1)) ] && tail -1 "$T/notify.calls" | grep -q "|desk: acme__widgets X-1|X1: PRODUCTION BROKEN: checkout 500s|$"'
rm -f "$T/verdict.X-1.json"
DIG2='{"key":"digest:2026-10-30T08:00","text":"Check-in 08:00"}'
verdict "{\"status\":\"show_person\",\"code\":11,\"message\":\"x\",\"waiting\":[],\"parked\":[],\"notify\":true,\"push\":[$DIG2]}"
notified=$(count "$T/notify.calls")
out=$(mtick); out=$(mtick)
check "DS-309: the check-in digest both passes carry goes out once, titled with the repo" '[ "$(count "$T/notify.calls")" = $((notified + 1)) ] && tail -1 "$T/notify.calls" | grep -q "|desk: acme__widgets|Check-in 08:00|$"'
# pv <push json>: a verdict that pushes it.
pv(){ printf '{"status":"show_person","code":11,"message":"x","waiting":[],"parked":[],"notify":true,"push":[%s]}' "$1"; }
# A health key both batches sent: X-1 keeps it while the standing batch drops it, and when it comes
# back X-1's stored key is no reason to stay quiet.
HK='{"key":"health:acme__widgets:gh","text":"gh check failing"}'
verdict "$(pv "$HK")"; out=$(mtick)
pv "$HK" > "$T/verdict.X-1.json"; verdict "$NOTHING"; out=$(mtick)
verdict "$(pv "$HK")"; notified=$(count "$T/notify.calls")
out=$(mtick)
check "DS-309: a key another batch sent on an earlier tick is pushed again when it returns" '[ "$(count "$T/notify.calls")" = $((notified + 1)) ] && tail -1 "$T/notify.calls" | grep -q "|desk: acme__widgets|gh check failing|$"'
# A digest the standing batch sent reaches X-1 only on a later tick of its slot: it is not sent twice.
DIG3='{"key":"digest:2026-10-30T17:00","text":"Check-in 17:00"}'
printf '%s\n' "$NOTHING" > "$T/verdict.X-1.json"; verdict "$(pv "$DIG3")"; notified=$(count "$T/notify.calls")
out=$(mtick)
pv "$DIG3" > "$T/verdict.X-1.json"; out=$(mtick)
check "DS-309: a digest another batch sent on an earlier tick goes out once" '[ "$(count "$T/notify.calls")" = $((notified + 1)) ] && tail -1 "$T/notify.calls" | grep -q "|desk: acme__widgets|Check-in 17:00|$"'
# So does main's failed release, which names its commit.
RF='{"key":"release-failed-def","text":"main tests check failed on def"}'
printf '%s\n' "$NOTHING" > "$T/verdict.X-1.json"; verdict "$(pv "$RF")"; notified=$(count "$T/notify.calls")
out=$(mtick)
pv "$RF" > "$T/verdict.X-1.json"; out=$(mtick)
check "DS-309: a failed release another batch sent on an earlier tick goes out once" '[ "$(count "$T/notify.calls")" = $((notified + 1)) ] && tail -1 "$T/notify.calls" | grep -q "|desk: acme__widgets|main tests check failed on def|$"'
rm -f "$T/verdict.X-1.json"
verdict "$NOTHING"; printf 'not json\n' > "$T/verdict.standing.json"; : > "$T/pass.batches"
out=$(mtick); rc=$?
check "DS-309 AC3: the standing pass crashing still leaves X-1 its pass" '[ $rc -eq 0 ] && [ "$(tail -1 "$T/pass.batches")" = "X-1 feat/x" ] && grep "pass: exit" "$SS/supervisor.log" | tail -1 | grep -q "(error)" && grep "pass: exit" "$XS/supervisor.log" | tail -1 | grep -q "pass: exit 10 (nothing_yet)"'
rm -f "$T/verdict.standing.json"
bq "$YQ" Y-1 false "$XRUN"; : > "$T/pass.batches"
out=$(mtick)
check "DS-309 AC7: a batch not handed over is not driven, and its own log says so" '! grep -q "^Y-1 " "$T/pass.batches" && [ "$(count "$T/pass.batches")" = 2 ] && grep -q "batch Y-1 is not handed over" "$YS/supervisor.log"'
out=$(unset DESK_QUEUE DESK_AUTOPILOT_STATE; sup status)
check "DS-309 AC6: status lists every batch with its state" 'grep -q "^batch s1: handed over$" <<< "$out" && grep -q "^X-1: batch X-1: handed over$" <<< "$out" && grep -q "^Y-1: batch Y-1: not handed over" <<< "$out"'
# An exit landing during the standing batch's pass: the round it adds runs every batch again, though
# the round before it ended inside the last batch it entered.
: > "$T/pass.batches"; mkdir -p "$SS/exits"; printf '{}\n' > "$SS/exits/A.1.json"; touch -t 202001010000 "$SS/exits/A.1.json"; touch "$T/exit.during"
out=$(DESK_WAKE_GAP_MS=0 mtick)
check "DS-695: the round an exit adds passes every batch, the standing one included" '[ "$(grep -c "^- " "$T/pass.batches")" = 2 ] && [ "$(grep -c "^X-1 " "$T/pass.batches")" = 2 ] && [ -z "$(ls -A "$SS/exits")" ]'
# Each batch counts its own quiet pass, decided as its pass starts. One batch skipped for its pass lock
# leaves the round unconsumed, but X-1, which passed, has counted: the next woken round counts it no
# second time, while the standing batch, which passed nothing, counts.
rm -f "$SS/supervisor.wake" "$SS/supervisor.counted" "$XS/supervisor.counted"
sleep 30 & HOLDER=$!
printf '{"pid":%s,"since":"x"}\n' "$HOLDER" > "$SS/supervisor.lock"
printf '{}\n' > "$SS/exits/A.6.json"; touch -t 202001010000 "$SS/exits/A.6.json"; : > "$T/pass.woken"
out=$(DESK_WAKE_GAP_MS=0 mtick)
check "DS-695: a round with one batch skipped for its lock still counts the batch that passed" '[ "$(cat "$T/pass.woken")" = "X-1 false" ] && [ -e "$SS/exits/A.6.json" ] && [ -s "$XS/supervisor.counted" ] && [ ! -e "$SS/supervisor.counted" ]'
kill "$HOLDER" 2>/dev/null; wait "$HOLDER" 2>/dev/null; rm -f "$SS/supervisor.lock"; : > "$T/pass.woken"
out=$(DESK_WAKE_GAP_MS=0 mtick)
check "DS-695: the next woken round counts the skipped batch and not again the one that passed" '[ "$(grep -c "^- false$" "$T/pass.woken")" = 1 ] && [ "$(grep -c "^X-1 true$" "$T/pass.woken")" = 1 ] && [ -z "$(ls -A "$SS/exits")" ]'
# A batch whose quiet pass is due counts it though another batch in the same round is not due: the
# standing batch counted just now, X-1 an interval ago.
date -u +%Y-%m-%dT%H:%M:%SZ > "$SS/supervisor.counted"; printf '2020-01-01T00:00:00.000Z\n' > "$XS/supervisor.counted"
printf '{}\n' > "$SS/exits/A.7.json"; touch -t 202001010000 "$SS/exits/A.7.json"; : > "$T/pass.woken"
out=$(DESK_WAKE_GAP_MS=0 mtick)
check "DS-695: each batch's count is decided by its own last counted pass" '[ "$(head -1 "$T/pass.woken")" = "- true" ] && [ "$(sed -n 2p "$T/pass.woken")" = "X-1 false" ]'
rm -f "$SS/supervisor.wake" "$SS/supervisor.counted" "$XS/supervisor.counted"

# ---- DS-311: a feature batch whose promotion PR is merged or closed is archived -------------------
# xq <tickets json>: X-1 on feat/x, handed over, its promotion PR #9.
xq(){ printf '{"version":1,"batch":"X-1","supervised":true,"base":"feat/x","promotion":{"pr":9},"approved":{},"tickets":%s}\n' "$1" > "$XQ"; }
echo CLOSED > "$T/gh/9"
xq "$XRUN"; before=$(cat "$XQ"); : > "$T/pass.batches"
out=$(mtick)
check "DS-311 AC6: with a worker running, X-1 is not archived and is unchanged" '[ "$(cat "$XQ")" = "$before" ] && grep -q "^X-1 " "$T/pass.batches" && ! grep -q "archiv" "$XS/supervisor.log"'
xq '{"X1":{"key":"X1","state":"done","result":{"pr":21}},"X2":{"key":"X2","state":"done","result":{"pr":22}}}'
echo MERGED > "$T/gh/22"; : > "$T/pass.batches"
out=$(mtick)
check "DS-311 AC7: with a ticket PR still open, X-1 is not archived and still runs" '[ -f "$XQ" ] && grep -q "^X-1 " "$T/pass.batches"'
check "DS-311 AC7: the open PR is handed to the digest, and the log says so" 'grep -q "\"id\": \"archive:X-1:X1:21\"" "$XS/handed.json" && grep -q "\"kind\": \"archive\"" "$XS/handed.json" && ! grep -q "\"X2\"" "$XS/handed.json" && grep -q "archive: batch X-1 waits on X1 (PR #21), handed to the digest" "$XS/supervisor.log"'
echo CLOSED > "$T/gh/21"; : > "$T/pass.batches"
out=$(mtick)
DQ="$DESK_HOME/repos/acme__widgets/batches/.done/X-1/queue.json"
check "DS-311 AC5: X-1 is moved under batches/.done/" '[ ! -e "$XQ" ] && [ -f "$DQ" ] && [ ! -e "$XS" ] && [ -d "$SS/batches/.done/X-1" ]'
check "DS-311 AC5: the archive is logged in the standing batch's log" 'grep -q "batch X-1 archived: its promotion PR #9 is closed" "$SS/supervisor.log"'
check "DS-311 AC5: X-1 is not driven" '! grep -q "^X-1 " "$T/pass.batches" && grep -q "^- " "$T/pass.batches"'
out=$(unset DESK_QUEUE DESK_AUTOPILOT_STATE; sup status)
check "DS-311 AC5: X-1 is no longer listed" '! grep -q "^X-1:" <<< "$out" && grep -q "^Y-1:" <<< "$out"'

# ---- DS-759: supervisor.log rotates past its size limit, keeping three copies --------------------
SL="$SS/supervisor.log"
rm -f "$SL".[1-4]
printf 'old line %s\n' $(seq 1 100) > "$SL"; old=$(cat "$SL")
out=$(DESK_LOG_ROTATE_BYTES=1000 mtick)
check "DS-759 AC1: a log over the limit is kept as supervisor.log.1, and the tick writes a new one" '[ "$(cat "$SL.1")" = "$old" ] && ! grep -q "old line" "$SL" && grep -q "pass: exit" "$SL"'
check "DS-759 AC4: the new log, whose tail desk-q reads, ends with the tick's last line, not an empty file" '[ -s "$SL" ] && tail -1 "$SL" | grep -q . && ! tail -1 "$SL" | grep -q "old line"'
out=$(DESK_LOG_ROTATE_BYTES=1000 mtick)
check "DS-759: a log under the limit is appended to, not rotated" '[ "$(cat "$SL.1")" = "$old" ] && [ ! -e "$SL.2" ] && [ "$(grep -c "pass: exit" "$SL")" = 2 ]'
echo copy1 > "$SL.1"; echo copy2 > "$SL.2"; echo copy3 > "$SL.3"
printf 'old line %s\n' $(seq 1 100) > "$SL"
out=$(DESK_LOG_ROTATE_BYTES=1000 mtick)
check "DS-759 AC2: with three copies, the oldest is deleted and the others move up one" '[ "$(cat "$SL.3")" = copy2 ] && [ "$(cat "$SL.2")" = copy1 ] && [ "$(cat "$SL.1")" = "$old" ] && [ ! -e "$SL.4" ] && ! grep -q "old line" "$SL"'

# ---- DS-654: each tick ends by refreshing the machine-wide Levers page --------------------------
# The real levers-refresh.mjs is linked beside the supervisor (link_bin; node runs it from its own
# folder), so the ticks above may have built the page already: it starts here from no page.
ln -sf "$B/levers-refresh.mjs" "$T/bin/levers-refresh.mjs"
LV="$HOME/.desk-autopilot/levers"; rm -rf "$LV"; LS="$HOME/.desk-autopilot/acme__widgets"; mkdir -p "$LS"
built(){ grep -c "levers: built the page" "$LOG"; }
# Moves build.json's last attempt <n> minutes into the past, leaving its fingerprint.
attempted(){ node -e 'const f=process.argv[1],r=JSON.parse(require("fs").readFileSync(f,"utf8"));r.attempted_at=new Date(Date.now()-process.argv[2]*60000).toISOString();require("fs").writeFileSync(f,JSON.stringify(r))' "$LV/build.json" "$1"; }
b0=$(built); out=$(tick)
check "DS-654: a tick builds the page that is not there yet" '[ "$(built)" = $((b0 + 1)) ] && [ -s "$LV/index.html" ] && [ -s "$LV/view.json" ]'
mtime(){ node -e 'console.log(require("fs").statSync(process.argv[1]).mtimeMs)' "$1"; }
attempted 4; b0=$(built); m0=$(mtime "$LV/build.json"); out=$(tick)
check "DS-654 AC1: no input changed and the last build 4 minutes ago, the tick runs no build" '[ "$(built)" = "$b0" ] && [ "$(mtime "$LV/build.json")" = "$m0" ]'
attempted 11; b0=$(built); out=$(tick)
check "DS-654: no input changed but the last build 11 minutes ago, the tick builds" '[ "$(built)" = $((b0 + 1)) ]'
printf '{"at":"%s","kind":"transition","lever":"preflight","from":"trial","to":"adopted","actor":"evaluate","ticket":"WID-654"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LS/levers.jsonl"
b0=$(built); out=$(tick)
check "DS-654 AC2: a new levers.jsonl line, the next tick builds, and the page and its view model show it" '[ "$(built)" = $((b0 + 1)) ] && grep -q WID-654 "$LV/view.json" && grep -q WID-654 "$LV/index.html"'
# A folder where view.json goes makes the build's write throw.
page0=$(cksum < "$LV/index.html"); rm "$LV/view.json"; mkdir "$LV/view.json"; echo >> "$LS/levers.jsonl"
out=$(tick); rc=$?
check "DS-654 AC3: a build that throws leaves index.html unchanged, build.json holds the error, and the tick succeeds" '[ $rc -eq 0 ] && [ "$(cksum < "$LV/index.html")" = "$page0" ] && grep -q "\"failed\"" "$LV/build.json" && grep -q "view.json" "$LV/build.json" && grep -q "levers: couldn.t update the page" "$LOG"'
rmdir "$LV/view.json"; echo >> "$LS/levers.jsonl"
b0=$(built)
for _ in 1 2 3 4; do tick > /dev/null & done; wait
check "DS-654 AC4: four ticks ending within a second run exactly one build" '[ "$(built)" = $((b0 + 1)) ] && ! grep -q "\"failed\"" "$LV/build.json"'
rm -f "$T/bin/levers-refresh.mjs"

# ---- AC10: uninstall ----------------------------------------------------------------------------
out=$(sup uninstall); rc=$?
check "AC10: uninstall exits 0" '[ $rc -eq 0 ]'
check "AC10: the agent is booted out" 'grep -q "^bootout gui/[0-9]*/com.desk-skills.supervisor.acme__widgets$" "$T/launchctl.calls" && [ ! -f "$T/loaded" ]'
check "AC10: the agent's plist is removed" '[ ! -f "$PL" ]'
out=$(sup status); rc=$?
check "status says not installed" '[ $rc -eq 1 ] && grep -q "not installed" <<< "$out"'

# ---- #735: the systemd backend, as on Linux and WSL ---------------------------------------------
# A fake systemctl keeps the timer's state in $T/active and the service's last run in $T/result, and a
# fake loginctl says lingering is off. The batch gets its own state folder.
waitlines "$T/driver.calls" "$(started)"
export DESK_PLATFORM=linux XDG_CONFIG_HOME="$T/xdg" DESK_AUTOPILOT_STATE="$T/lstate" DESK_QUEUE="$T/lqueue.json"
cat > "$T/fakes/systemctl" <<EOF
#!/bin/sh
echo "\$@" >> "$T/systemctl.calls"
case "\$2" in
  is-active) case "\$4" in *.path) [ -f "$T/active" ] && [ ! -f "$T/path.failed" ] ;; *) [ -f "$T/active" ] ;; esac ;;
  enable) touch "$T/active" ;;
  disable) rm -f "$T/active" ;;
  restart) rm -f "$T/path.failed"; [ -f "$T/active" ] ;;
  show) r=\$(cat "$T/result" 2>/dev/null || echo success)
        printf 'ActiveState=inactive\nResult=%s\nExecMainStatus=%s\n' "\$r" "\$([ "\$r" = success ] && echo 0 || echo 3)" ;;
esac
EOF
printf '#!/bin/sh\necho Linger=no\n' > "$T/fakes/loginctl"
printf '#!/bin/sh\nprintf "%%s|" "$@" >> "%s/notify-send.calls"; echo >> "%s/notify-send.calls"\n' "$T" "$T" > "$T/fakes/notify-send"
# No real Windows toast: on WSL the next notifier after notify-send is powershell.exe.
printf '#!/bin/sh\nexit 1\n' > "$T/fakes/powershell.exe"
chmod +x "$T/fakes/systemctl" "$T/fakes/loginctl" "$T/fakes/notify-send" "$T/fakes/powershell.exe"
UD="$T/xdg/systemd/user"; SV="$UD/com.desk-skills.supervisor.acme__widgets.service"; TM="$UD/com.desk-skills.supervisor.acme__widgets.timer"
out=$(sup install); rc=$?
check "#735 AC1: install on Linux exits 0 and writes no launchd agent" '[ $rc -eq 0 ] && [ ! -f "$PL" ]'
check "#735 AC1: the service runs a tick of this supervisor in the repo root" 'grep -qxF "ExecStart=\"$(node -p process.execPath)\" \"$T/bin/supervisor.mjs\" tick" "$SV" && grep -qxF "WorkingDirectory=$T/repo" "$SV"'
check "#735 AC1: the service leaves the merge driver running and passes the repo on" 'grep -qx "KillMode=process" "$SV" && grep -qxF "Environment=\"DESK_REPO_DIR=$T/repo\"" "$SV"'
check "#735 AC1: the timer runs it at once and every 180s by default" 'grep -qx "OnActiveSec=0" "$TM" && grep -qx "OnUnitActiveSec=180s" "$TM" && grep -qx "WantedBy=timers.target" "$TM"'
check "#735 AC1: install reloads systemd and enables the timer now" 'grep -qx -- "--user daemon-reload" "$T/systemctl.calls" && grep -qx -- "--user enable --now com.desk-skills.supervisor.acme__widgets.timer com.desk-skills.supervisor.acme__widgets.path" "$T/systemctl.calls"'
PU="$UD/com.desk-skills.supervisor.acme__widgets.path"
check "DS-695: the path unit runs the service whenever the exits folder changes" '[ -d "$T/lstate/exits" ] && grep -qxF "PathChanged=$T/lstate/exits" "$PU" && grep -qx "Unit=com.desk-skills.supervisor.acme__widgets.service" "$PU" && grep -qx "WantedBy=paths.target" "$PU"'
check "#735 AC1: with lingering off, install says ticks stop at logout and how to keep them" 'grep -q "loginctl enable-linger" <<< "$out"'
check "DS-838 AC3: on plain Linux, install says nothing about WSL" '! grep -q "WSL" <<< "$out"'
out=$(sup install)
check "#735 AC1: an unchanged install enables nothing again" '[ "$(grep -c " enable " "$T/systemctl.calls")" = 1 ] && grep -q "unchanged" <<< "$out"'
check "DS-695: the service lifts systemd's start limit, so a burst of exits cannot fail it" 'grep -qx "StartLimitIntervalSec=0" "$SV"'
touch "$T/path.failed"; out=$(sup install)
check "DS-695: an install finding the path unit failed clears it and restarts it, not unchanged" '! grep -q "unchanged" <<< "$out" && grep -qx -- "--user reset-failed com.desk-skills.supervisor.acme__widgets.service com.desk-skills.supervisor.acme__widgets.timer com.desk-skills.supervisor.acme__widgets.path" "$T/systemctl.calls" && [ ! -f "$T/path.failed" ]'
out=$(sup install --interval 300)
check "#735 AC1: a new interval rewrites the timer and restarts it" 'grep -qx "OnUnitActiveSec=300s" "$TM" && grep -qx -- "--user restart com.desk-skills.supervisor.acme__widgets.timer com.desk-skills.supervisor.acme__widgets.path" "$T/systemctl.calls"'
out=$(sup status); rc=$?
check "#735 AC2: status names the timer as loaded, with its interval" '[ $rc -eq 0 ] && grep -q "installed (every 300s), loaded" <<< "$out"'
agent(){ node --input-type=module -e "import { supervisorAgent } from '$T/bin/run-by.mjs'; console.log(JSON.stringify(supervisorAgent('acme__widgets')))"; }
out=$(agent)
check "#735 AC2: a loaded timer whose last run succeeded reports no failed exit" '[ "$out" = "{\"loaded\":true,\"exit\":null}" ]'
echo exit-code > "$T/result"
out=$(agent)
check "#735 AC2: a failed last run is read as launchctl print is: its code and why" '[ "$out" = "{\"loaded\":true,\"exit\":{\"code\":3,\"why\":\"exit-code\"}}" ]'
rm -f "$T/result"

# ---- DS-838: on WSL, lingering does not keep the timer running --------------------------------------
config yes yes yes
out=$(sup install --interval 300 --reload)
check "DS-838 AC1: on WSL with lingering off, install keeps the lingering note" 'grep -q "loginctl enable-linger" <<< "$out"'
check "DS-838 AC1: and says ticks run only while WSL is up, naming both ways to keep it up" 'grep -q "On WSL, ticks run only while WSL is up" <<< "$out" && grep -q "Keep a terminal open" <<< "$out" && grep -qF "Windows Task Scheduler entry at logon that runs \`wsl.exe --exec sleep infinity\`" <<< "$out"'
check "DS-838 AC1: and says how to name a non-default distro and to lift the task's 3-day limit" 'grep -qF "\`-d <distro>\` if this is not your default distro" <<< "$out" && grep -qF "\"Stop the task if it runs longer than 3 days\" turned off" <<< "$out"'
printf '#!/bin/sh\necho Linger=yes\n' > "$T/fakes/loginctl"
out=$(sup install --interval 300 --reload)
check "DS-838 AC2: on WSL with lingering on, install still says ticks run only while WSL is up" '! grep -q "Lingering is off" <<< "$out" && grep -q "On WSL, ticks run only while WSL is up" <<< "$out" && grep -qF "wsl.exe --exec sleep infinity" <<< "$out"'
printf '#!/bin/sh\necho Linger=no\n' > "$T/fakes/loginctl"
config yes yes

# ---- #735 AC3: notifications off macOS ----------------------------------------------------------
rm -f "$T"/verdict.*.json "$T/driver.mode"
LLOG="$T/lstate/supervisor.log"
queue true '{}' "$RUNNING"
verdict '{"status":"show_person","code":11,"message":"x","waiting":[],"parked":[],"notify":true,"push":[{"key":"digest:2026-11-18T09:00","text":"Check-in 09:00: 1 question(s)"}]}'
n=$(count "$T/notify.calls")
out=$(tick)
check "#735 AC3: on Linux the push goes out through notify-send, naming the repo" 'grep -q "desk: acme__widgets|Check-in 09:00: 1 question(s)|$" "$T/notify-send.calls" && grep -q "^notification: sent for digest:2026-11-18T09:00$" "$LLOG"'
check "#735 AC3: and not through osascript" '[ "$(count "$T/notify.calls")" = "$n" ]'
# A notify-send that cannot show one (no notification daemon) keeps failing: with nothing else to try,
# the log is the record, so the push counts as told and the batch can go idle.
printf '#!/bin/sh\necho "Cannot autolaunch D-Bus without X11 \\$DISPLAY" >&2; exit 1\n' > "$T/fakes/notify-send"
NOPATH="$(printf %s "$PATH" | tr : '\n' | grep -v '^/mnt/' | paste -sd: -)"
if PATH="$NOPATH" command -v powershell.exe >/dev/null 2>&1; then echo "SKIP #735 AC3 failing notifier: this computer has powershell.exe outside /mnt"
else
  verdict '{"status":"idle","code":0,"message":"idle","waiting":[],"parked":[],"notify":true,"push":[{"key":"digest:2026-11-18T20:00","text":"Check-in 20:00"}]}'
  out=$(PATH="$NOPATH" tick)
  check "#735 AC3: a notify-send that fails is logged as not shown, with its error, and the batch still goes idle" 'grep -q "^notification: none shown, no notifier here could show one (notify-send: Cannot autolaunch D-Bus.*) for digest:2026-11-18T20:00$" "$LLOG" && grep -q "^supervisor: batch b1 is idle" "$LLOG"'
fi
waitlines "$T/driver.calls" "$(started)"

out=$(sup uninstall); rc=$?
check "#735 AC4: uninstall disables the timer and removes the units" '[ $rc -eq 0 ] && grep -qx -- "--user disable --now com.desk-skills.supervisor.acme__widgets.timer com.desk-skills.supervisor.acme__widgets.path" "$T/systemctl.calls" && [ ! -f "$SV" ] && [ ! -f "$TM" ] && [ ! -f "$PU" ] && [ ! -f "$T/active" ]'
out=$(sup status); rc=$?
check "#735 AC4: status then says not installed" '[ $rc -eq 1 ] && grep -q "not installed" <<< "$out"'
unset XDG_CONFIG_HOME; export DESK_PLATFORM=darwin

# Let any detached fake driver finish before the scratch directory goes.
waitlines "$T/driver.calls" "$(started)"
echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
