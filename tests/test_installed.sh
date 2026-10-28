#!/usr/bin/env bash
# suite: installed version and restart (install.sh moves running autopilot onto new code)
# installed.mjs with fake merge drivers (detached, as a supervisor tick leaves them) and a fake
# launchctl: `record` writes the commit installed from, `restart` restarts a driver waiting between
# loops with the same tickets, leaves one mid-loop, rewrites and reloads each loaded supervisor agent
# with this node, and says so in one line when nothing runs. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"
T="$(cd "$(mktemp -d)" && pwd -P)"
cleanup(){
  for f in "$T"/home/.desk-autopilot/*/merge-driver.lock.d/pid "$T"/home/.desk-autopilot/*/batches/*/merge-driver.lock.d/pid; do
    [ -f "$f" ] || continue
    p="$(cat "$f")"; kill "$p" 2>/dev/null; pkill -P "$p" 2>/dev/null
  done
  rm -rf "$T"
}
trap cleanup EXIT
mkdir -p "$T/home" "$T/bin" "$T/fakes" "$T/repo" "$T/desk"
export HOME="$T/home"
unset DESK_CONFIG DESK_REPO_DIR DESK_REPO_ROOT DESK_SLUG DESK_STATE DESK_QUEUE DESK_AUTOPILOT_STATE DESK_DEFAULT_BRANCH DESK_GH_REPO DESK_BATCH
export DESK_CONFIG_ROOT="$T/cfg" DESK_REPO_OVERRIDE=acme/widgets DESK_HOME="$T/desk" DESK_RESTART_WAIT_MS=5000
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }

mkdir -p "$T/cfg/repos/acme__widgets"
cat > "$T/cfg/repos/acme__widgets/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |
EOF

# installed.mjs beside the real supervisor and the modules it imports, and a fake merge driver that
# behaves as the real one does at rest: it holds the lock, sleeps between loops, and on TERM drops the
# lock once its sleep returns. With $T/busy it is mid-loop instead (its child is not `sleep`).
cp "$B/installed.mjs" "$T/bin/"
for f in supervisor.mjs desk-env.mjs machine.mjs test-scope.mjs batch-state.mjs batches.mjs decider.mjs handoff.mjs briefing.mjs intake.mjs closeout.mjs; do ln -s "$B/$f" "$T/bin/$f"; done
cat > "$T/bin/merge-driver.sh" <<EOF
#!/usr/bin/env bash
echo "\$(pwd) \$*" >> "$T/driver.calls"
echo "\$DESK_AUTOPILOT_STATE|\${DESK_QUEUE:-}|\${DESK_BATCH:-}" >> "$T/driver.env"
D="\$DESK_AUTOPILOT_STATE/merge-driver.lock.d"
mkdir -p "\$D"; echo \$\$ > "\$D/pid"
trap 'rm -rf "\$D"; exit 143' TERM
while true; do if [ -f "$T/busy" ]; then tail -f /dev/null; else sleep 30; fi; done
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
chmod +x "$T/bin/merge-driver.sh" "$T/fakes/launchctl"
export PATH="$T/fakes:$PATH"

ST="$HOME/.desk-autopilot/acme__widgets"; mkdir -p "$ST"
# The batch state directory the next driver() uses: the standing batch's unless DST names another.
DST=""
count(){ if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }
held(){ cat "${DST:-$ST}/merge-driver.lock.d/pid" 2>/dev/null; }
# A driver started as a tick leaves it: detached, so it is no child of this shell. Waits for its lock.
driver(){
  rm -rf "${DST:-$ST}/merge-driver.lock.d"
  (cd "$T/repo" && DESK_AUTOPILOT_STATE="${DST:-$ST}" "$T/bin/merge-driver.sh" "$@" </dev/null >/dev/null 2>&1 &)
  i=0; while [ -z "$(held)" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
  # and for it to reach its sleep (or, busy, its tail)
  i=0; while ! pgrep -P "$(held)" >/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
}
restart(){ node "$T/bin/installed.mjs" restart 2>&1; }

# ---- AC4: the installed version -----------------------------------------------------------------
G="$T/checkout"; git init -q "$G"; git -C "$G" -c user.name=t -c user.email=t@t commit -q --allow-empty -m one
out=$(node "$T/bin/installed.mjs" record "$G" 2>&1); rc=$?
head_sha="$(git -C "$G" rev-parse HEAD)"
check "AC4: record exits 0 and prints the commit" '[ $rc -eq 0 ] && [ "$out" = "$head_sha" ]'
check "AC4: installed.json under DESK_HOME holds the commit it was installed from" 'grep -q "\"commit\": \"$head_sha\"" "$T/desk/installed.json" && grep -q "\"from\": \"$G\"" "$T/desk/installed.json"'
out=$(node "$T/bin/installed.mjs" version)
check "AC4: version prints it back" '[ "$out" = "$head_sha" ]'
out=$(node "$T/bin/installed.mjs" record "$T/repo" 2>&1); rc=$?
check "AC4: a directory that is not a checkout replaces the commit with a version of its own, and says so" '[ $rc -eq 0 ] && grep -q "^unversioned-.* (not a git checkout)$" <<< "$out" && ! grep -q "$head_sha" "$T/desk/installed.json" && grep -q "\"commit\": \"unversioned-" "$T/desk/installed.json"'
check "AC4: so what started at the commit before it reads as old code" 'node --input-type=module -e "import { oldCode } from \"$T/bin/installed.mjs\"; process.exit(oldCode(\"$head_sha\") ? 0 : 1)"'
node "$T/bin/installed.mjs" record "$G" >/dev/null

# ---- AC6: nothing running ------------------------------------------------------------------------
out=$(restart); rc=$?
check "AC6: with nothing running, nothing restarts and one line says so" '[ $rc -eq 0 ] && [ "$out" = "nothing to restart: no merge driver or supervisor agent is running" ] && [ "$(count "$T/launchctl.calls")" = 0 ]'

# ---- AC1: a driver between loops is restarted with the same tickets -----------------------------
driver --tickets "A B" --deps "B:A,C D:A" --log
old="$(held)"
out=$(restart); rc=$?
new="$(held)"
check "AC1: restart exits 0" '[ $rc -eq 0 ]'
check "AC1: the old driver is stopped" '! kill -0 "$old" 2>/dev/null'
check "AC1: a new driver holds the lock" '[ -n "$new" ] && [ "$new" != "$old" ] && kill -0 "$new"'
check "AC1: it is started from the repo root with the same tickets and deps, logging" '[ "$(tail -1 "$T/driver.calls")" = "$T/repo --tickets A B --deps B:A,C D:A --log" ]'
check "AC1: the line names it as restarted on the new code" 'grep -q "^merge driver for acme__widgets: restarted on the new code (pid $old -> $new) for A B$" <<< "$out"'
check "DS-306 AC5: the standing batch's driver gets its state folder and no queue or batch of its own, as before" '[ "$(tail -1 "$T/driver.env")" = "$ST||" ]'

kill "$new" 2>/dev/null; pkill -P "$new"
i=0; while [ -n "$(held)" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done

# ---- AC2: a driver mid-loop is left running ------------------------------------------------------
touch "$T/busy"; driver --tickets "A" --log; rm -f "$T/busy"
busy="$(held)"; n=$(count "$T/driver.calls")
out=$(restart)
check "AC2: a driver mid-loop is left running" 'kill -0 "$busy" && [ "$(held)" = "$busy" ] && [ "$(count "$T/driver.calls")" = "$n" ]'
check "AC2: the line names it and says when it moves to the new code" 'grep -q "^merge driver for acme__widgets (pid $busy): left running on the old code, it is mid-loop and may be merging; it moves to the new code when the supervisor next starts it$" <<< "$out"'
kill "$busy" 2>/dev/null; pkill -P "$busy"
i=0; while [ -n "$(held)" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
rm -rf "$ST/merge-driver.lock.d"

# ---- DS-306 AC3: a named batch's driver is restarted on that batch's queue and state folder ------
DST="$ST/batches/X-1"; mkdir -p "$DST" "$ST/batches/.done"
driver --tickets "X-2 X-3" --log
old="$(held)"
out=$(restart); rc=$?
new="$(held)"
check "DS-306 AC3: the named batch's driver is stopped and a new one holds its lock" '[ $rc -eq 0 ] && ! kill -0 "$old" 2>/dev/null && [ -n "$new" ] && [ "$new" != "$old" ] && kill -0 "$new"'
check "DS-306 AC3: it acts on X-1's state folder and queue, as batch X-1" '[ "$(tail -1 "$T/driver.env")" = "$DST|$T/desk/repos/acme__widgets/batches/X-1/queue.json|X-1" ]'
check "DS-306 AC3: with the same tickets, from the repo root" '[ "$(tail -1 "$T/driver.calls")" = "$T/repo --tickets X-2 X-3 --log" ]'
check "DS-306 AC3: the line names the batch" 'grep -q "^merge driver for acme__widgets batch X-1: restarted on the new code (pid $old -> $new) for X-2 X-3$" <<< "$out"'
check "DS-306 AC3: and it is the only driver restarted" '[ "$(grep -c "^merge driver" <<< "$out")" = 1 ]'
kill "$new" 2>/dev/null; pkill -P "$new"
i=0; while [ -n "$(held)" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
rm -rf "$DST/merge-driver.lock.d"; DST=""

# ---- AC3: a loaded supervisor agent is rewritten with this node and reloaded --------------------
AG="$HOME/Library/LaunchAgents"; PL="$AG/com.desk-skills.supervisor.acme__widgets.plist"; mkdir -p "$AG"
cat > "$PL" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>com.desk-skills.supervisor.acme__widgets</string>
	<key>ProgramArguments</key>
	<array>
		<string>/gone/node</string>
		<string>$T/bin/supervisor.mjs</string>
		<string>tick</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$T/repo</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>/usr/bin:/bin</string>
		<key>DESK_REPO_DIR</key>
		<string>$T/repo</string>
		<key>DESK_HOME</key>
		<string>$T/desk</string>
	</dict>
	<key>StartInterval</key>
	<integer>240</integer>
</dict>
</plist>
EOF
out=$(restart)
check "AC3: an agent that is not loaded is left alone" '[ "$out" = "nothing to restart: no merge driver or supervisor agent is running" ] && grep -q "/gone/node" "$PL"'
touch "$T/loaded"
out=$(restart); rc=$?
NODE="$(node -p process.execPath)"
check "AC3: restart exits 0 and says the agent was reloaded" '[ $rc -eq 0 ] && grep -q "^supervisor com.desk-skills.supervisor.acme__widgets: rewritten with node $NODE and reloaded$" <<< "$out"'
check "AC3: the plist names this node, not the stale one" 'grep -q "<string>$NODE</string>" "$PL" && ! grep -q "/gone/node" "$PL"'
check "AC3: the agent keeps its interval and working directory" 'grep -A1 "<key>StartInterval</key>" "$PL" | grep -q "<integer>240</integer>" && grep -A1 "<key>WorkingDirectory</key>" "$PL" | grep -q "$T/repo"'
check "AC3: the agent is booted out and bootstrapped again" 'grep -q "^bootout gui/[0-9]*/com.desk-skills.supervisor.acme__widgets$" "$T/launchctl.calls" && grep -q "^bootstrap gui/[0-9]* $PL$" "$T/launchctl.calls"'
check "AC5: the plist records the installed version the agent was loaded at" 'grep -A1 "<key>DESK_AGENT_VERSION</key>" "$PL" | grep -q "<string>$head_sha</string>"'
n=$(grep -c "^bootstrap" "$T/launchctl.calls")
out=$(restart)
check "AC3: an unchanged agent is still reloaded" '[ "$(grep -c "^bootstrap" "$T/launchctl.calls")" = $((n + 1)) ]'

# ---- the --tickets and --deps a driver's command line gives -------------------------------------
out=$(node --input-type=module -e "
import { driverArgs } from '$T/bin/installed.mjs';
console.log(JSON.stringify([
  driverArgs('/bin/bash /x/merge-driver.sh --tickets A,B C --log --deps D:A,B'),
  driverArgs('bash /x/merge-driver.sh --log'),
  driverArgs('node /x/other.mjs --tickets A'),
]));")
check "driverArgs reads comma or space separated tickets, keeps each deps entry, and needs tickets" '[ "$out" = "[{\"tickets\":[\"A\",\"B\",\"C\"],\"deps\":[\"D:A,B\"]},null,null]" ]'

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
