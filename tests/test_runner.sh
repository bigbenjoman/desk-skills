#!/usr/bin/env bash
# suite: desk-runner (profile gate, stubbed tart, isolation results)
# desk-runner against a stubbed tart (and stubbed softnet, sudo, ifconfig, lsof, route, launchctl,
# pmset, defaults): the machine profile gates `up`, the VM is created once at the profile's sizes and
# started behind the Softnet block, isolation results are read from the probe's output, status and
# down report the state, the launchd agents bring the VM back with backoff and verify it nightly,
# the gate closes on a failed or stale verification, and the Mac settings change only on a yes.
# Then runner-probe.sh itself against local listeners, where `timeout` exists (not stock macOS).
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; T="$(mktemp -d)"
trap 'rm -rf "$T"; pkill -f "$T/stub/tart run" 2>/dev/null' EXIT
export HOME="$T/home"; mkdir -p "$HOME" "$T/stub" "$T/tart"
export DESK_MACHINE="$T/machine.md" DESK_RUNNER_STATE="$T/state" DESK_RUNNER_VM=desk-runner-test DESK_RUNNER_BOOT_WAIT=6
R="$SRC/desk/bin/desk-runner"
PASS=0; FAIL=0; out=""; rc=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }
run(){ : > "$T/tart.log"; : > "$T/launchctl.log"; : > "$T/sudo.log"; : > "$T/gh.log"; out=$("$R" "$@" 2>&1 < /dev/null); rc=$?; log=$(cat "$T/tart.log"); }
# settings <answer>: desk-runner settings, answering its prompt
settings(){ : > "$T/sudo.log"; out=$(printf '%s\n' "$1" | "$R" settings 2>&1); rc=$?; }

# ---- stubs ----
cat > "$T/stub/tart" <<'EOF'
#!/usr/bin/env bash
# A tart that keeps each VM as a directory of files: cpu, memory, disk, running, provisioned.
D="$STUB_TART"; echo "$*" >> "$D/../tart.log"
cmd=$1; shift
case $cmd in
  get) v="$D/$1"; [ -d "$v" ] || exit 1
       r=false; [ -f "$v/running" ] && r=true
       printf '{"CPU":%s,"Memory":%s,"Disk":%s,"Running":%s}\n' "$(cat "$v/cpu")" "$(cat "$v/memory")" "$(cat "$v/disk")" "$r" ;;
  clone) v="$D/$2"; mkdir -p "$v"; echo 4 > "$v/cpu"; echo 4096 > "$v/memory"; echo 20 > "$v/disk" ;;
  set) v="$D/$1"; shift
       while [ $# -gt 0 ]; do case $1 in --cpu) echo "$2" > "$v/cpu" ;; --memory) echo "$2" > "$v/memory" ;; --disk-size) echo "$2" > "$v/disk" ;; esac; shift 2; done ;;
  run) # like the real one, it runs until the VM is stopped
       : > "$D/$1/running"; echo "$*" > "$D/$1/run-args"
       n=0; while [ -f "$D/$1/running" ] && [ $n -lt 600 ]; do sleep 0.1; n=$((n + 1)); done ;;
  stop) rm -f "$D/$1/running" ;;
  exec)
    [ "$1" = -i ] && { stdin=1; shift; }
    v="$D/$1"; shift; [ -f "$v/running" ] || exit 1
    case "$*" in
      true) ;;
      "cat /var/lib/desk-runner/provisioned") cat "$v/provisioned" 2>/dev/null || exit 1 ;;
      "sudo -n bash -s -- "*) cat > "$v/provision-script"; echo "$6" > "$v/provisioned" ;;
      "ip -4 route show default") echo "default via 10.9.9.1 dev enp0s1 proto dhcp src 10.9.9.2 metric 100" ;;
      "sudo -n sh -c ulimit -n 8192; exec bash /var/lib/desk-runner/probe.sh"*) shift 7; printf '%s\n' "$@" > "$v/targets"; cat "$STUB_GUEST_OUT" ;;
      *"cat > /var/lib/desk-runner/slot.sh") cat > "$v/slot.sh" ;;
      # Slots are lines of $v/slots: <id> <repo> <runner-id> <state> <cpus> <memory-gb>.
      "sudo -n bash /var/lib/desk-runner/slot.sh list") cat "$v/slots" 2>/dev/null; exit "${STUB_LIST_RC:-0}" ;;
      "sudo -n bash /var/lib/desk-runner/slot.sh start "*)
        echo "$*" >> "$v/slot-starts"; read -r jit; echo "$jit" >> "$v/jits"
        [ -n "${STUB_START_RC:-}" ] && exit "$STUB_START_RC"
        echo "$6 $7 $8 running ${11} ${12}" >> "$v/slots" ;;
      "sudo -n bash /var/lib/desk-runner/slot.sh reap "*)
        echo "$6" >> "$v/reaped"; awk -v i="$6" '$1 != i' "$v/slots" > "$v/slots.new"; mv "$v/slots.new" "$v/slots" ;;
      "sudo -n sh -c "*) cat > "$v/probe.sh"; exit "${STUB_COPY_RC:-0}" ;;
      "sudo -n docker run "*) shift 11; printf '%s\n' "$@" > "$v/container-targets"; cat "$STUB_CONTAINER_OUT" ;;
      *) echo "stub tart: unexpected exec $*" >&2; exit 99 ;;
    esac ;;
  *) echo "stub tart: unexpected $cmd" >&2; exit 99 ;;
esac
EOF
printf '#!/bin/sh\necho softnet\n' > "$T/stub/softnet"
cat > "$T/stub/sudo" <<'EOF'
#!/bin/sh
echo "$*" >> "$STUB_TART/../sudo.log"
[ -n "${STUB_SUDO_RC:-}" ] && exit "$STUB_SUDO_RC"
[ "$1" = -n ] && shift
exec "$@"
EOF
# launchctl keeps each loaded label as a file; pmset and defaults keep each setting as a file.
cat > "$T/stub/launchctl" <<'EOF'
#!/bin/sh
D="$STUB_TART/../launchd"; mkdir -p "$D"; echo "$*" >> "$STUB_TART/../launchctl.log"
case $1 in
  print) [ -f "$D/${2##*/}" ] ;;
  bootstrap) l=$(basename "$3" .plist); [ -f "$D/$l" ] && exit 5; : > "$D/$l" ;;
  bootout) [ -f "$D/${2##*/}" ] || exit 3; rm -f "$D/${2##*/}" ;;
  *) echo "stub launchctl: unexpected $*" >&2; exit 99 ;;
esac
EOF
cat > "$T/stub/pmset" <<'EOF'
#!/bin/sh
M="$STUB_TART/../mac"
case $1 in
  -g) printf 'System-wide power settings:\nCurrently in use:\n standby              0\n sleep                %s\n autorestart          %s\n' "$(cat "$M/sleep")" "$(cat "$M/autorestart")" ;;
  -a) echo "$3" > "$M/$2" ;;
esac
EOF
cat > "$T/stub/defaults" <<'EOF'
#!/bin/sh
M="$STUB_TART/../mac"
case $1 in
  read) cat "$M/updates" 2>/dev/null || { echo "The domain/default pair of ($2, $3) does not exist" >&2; exit 1; } ;;
  write) [ "$4 $5" = "-bool false" ] && echo 0 > "$M/updates" ;;
esac
EOF
mkdir -p "$T/mac"; mac(){ echo "$1" > "$T/mac/sleep"; echo "$2" > "$T/mac/autorestart"; rm -f "$T/mac/updates"; }; mac 1 0
cat > "$T/stub/ifconfig" <<'EOF'
#!/bin/sh
printf 'lo0: flags\n\tinet 127.0.0.1 netmask 0xff000000\nen0: flags\n\tinet 192.168.4.187 netmask 0xffffff00\n'
printf 'en1: flags\n\tinet 192.168.4.26 netmask 0xffffff00\nbridge102: flags\n\tinet 10.9.9.1 netmask 0xfffffffc\n'
EOF
# lsof: two fixed listeners, then this machine's real TCP listeners (so desk-runner sees its own
# test services, as it does on a Mac), unless STUB_LSOF_EMPTY.
cat > "$T/stub/lsof" <<'EOF'
#!/bin/sh
[ -n "${STUB_LSOF_EMPTY:-}" ] && exit 0
printf 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nControlCe 1 b 9u IPv4 0x0 0t0 TCP *:5000 (LISTEN)\npostgres 2 b 7u IPv6 0x0 0t0 TCP [::1]:5432 (LISTEN)\n'
if [ -e /proc/net/tcp ]; then
  # python, not awk, for the hex port: gawk reads "0x1F90" + 0 as 0, mawk as 8080.
  python3 -c 'import sys
for path in sys.argv[1:]:
    for row in open(path).read().splitlines()[1:]:
        f = row.split()
        if f[3] == "0A": print("py 3 b 3u IPv4 0x0 0t0 TCP *:%d (LISTEN)" % int(f[1].rsplit(":", 1)[1], 16))' /proc/net/tcp /proc/net/tcp6
else
  /usr/sbin/lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR > 1'
fi
EOF
printf '#!/bin/sh\nprintf "   route to: default\\n    gateway: 192.168.4.1\\n"\n' > "$T/stub/route"
# gh: each call logged one per line; a repo is private unless STUB_PRIVATE says otherwise; each JIT
# request answers runner id 100, 101, …; a DELETE of an id in STUB_BUSY is refused, as GitHub refuses
# a runner mid-job; the runners listed are the lines of $T/gh-runners (<id> <name> <status> [<busy>]),
# turned into GitHub's JSON and put through the real jq filter.
# Runs and jobs come from JSON files, through the real jq: $T/runs-queued.json, $T/runs-progress.json
# and $T/jobs-<run>.json.
cat > "$T/stub/gh" <<'EOF'
#!/bin/bash
G="$STUB_TART/.."; echo "$*" >> "$G/gh.log"
case "$*" in
  "api --paginate repos/"*"/actions/runs/"*"/jobs?"*) r=${3#*/runs/}; jq -r "$5" "$G/jobs-${r%%/*}.json" ;;
  "api --paginate repos/"*"/actions/runs?status="*)
    [ -n "${STUB_RUNS_RC:-}" ] && exit 1
    [ -n "${STUB_RUNS_FAIL:-}" ] && [[ $3 == *"/$STUB_RUNS_FAIL/"* ]] && exit 1
    f=queued; case $3 in *status=in_progress*) f=progress ;; esac
    r=${3#repos/}; r=${r%%/actions/*}; f="$G/runs-$f"; [ -f "$f-${r%%/*}_${r#*/}.json" ] && f="$f-${r%%/*}_${r#*/}"; f="$f.json"
    [ -s "$f" ] || echo '{"workflow_runs":[]}' > "$f"; jq -r "$5" "$f" ;;
  "api repos/"*" --jq .private") echo "${STUB_PRIVATE:-true}" ;;
  "api -X POST repos/"*"/generate-jitconfig"*)
    [ -n "${STUB_JIT_RC:-}" ] && { echo "HTTP 403: Resource not accessible" >&2; exit 1; }
    n=$(cat "$G/gh-next" 2>/dev/null || echo 100); echo $((n + 1)) > "$G/gh-next"
    printf '{"runner":{"id":%s},"encoded_jit_config":"JIT-%s"}\n' "$n" "$n" ;;
  "api -X DELETE repos/"*)
    id=${4##*/}; case " ${STUB_BUSY:-} " in *" $id "*) exit 1 ;; esac; echo "$id" >> "$G/gh-deleted" ;;
  "api --paginate repos/"*"/actions/runners --jq "*)
    [ -n "${STUB_RUNNERS_RC:-}" ] && exit 1
    { cat "$G/gh-runners" 2>/dev/null || true; } \
      | jq -R 'split(" ") | {id: (.[0] | tonumber), name: .[1], status: .[2], busy: (.[3] == "true")}' \
      | jq -s '{runners: .}' | jq -r "$5" ;;
  *) echo "stub gh: unexpected $*" >&2; exit 99 ;;
esac
EOF
chmod +x "$T/stub/"*
export STUB_TART="$T/tart" PATH="$T/stub:$PATH"
[ "$(command -v tart)" = "$T/stub/tart" ] || { echo "FAIL the tart stub is not first on PATH"; exit 1; }
[ "$(command -v launchctl)" = "$T/stub/launchctl" ] || { echo "FAIL the launchctl stub is not first on PATH"; exit 1; }
[ "$(command -v sudo)" = "$T/stub/sudo" ] && [ "$(command -v pmset)" = "$T/stub/pmset" ] || { echo "FAIL the sudo or pmset stub is not first on PATH"; exit 1; }
KEEP="$HOME/Library/LaunchAgents/com.desk-skills.desk-runner-test.plist"
NIGHTLY="$HOME/Library/LaunchAgents/com.desk-skills.desk-runner-test.nightly.plist"
BACKOFF="$T/state/restart.backoff"; UID_="$(id -u)"
pl(){ python3 -c 'import plistlib,sys; d=plistlib.load(open(sys.argv[1],"rb")); print(eval(sys.argv[2]))' "$1" "$2"; }
stop_vm(){ "$T/stub/tart" stop desk-runner-test; n=0; while pgrep -f "$T/stub/tart run desk-runner-test" >/dev/null && [ $n -lt 30 ]; do sleep 0.1; n=$((n + 1)); done; }
next_in(){ read -r _ nx < "$BACKOFF"; echo $(( nx - $(date +%s) )); }
STUB_GUEST_OUT="$T/guest.out"; STUB_CONTAINER_OUT="$T/container.out"; export STUB_GUEST_OUT STUB_CONTAINER_OUT
probe_ok(){ printf 'OK %s deny 10.9.9.1:1-1024 (no port connected)\nOK %s allow registry.npmjs.org:443 (connected)\nDONE %s\n' "$1" "$1" "$1"; }
probe_ok guest > "$STUB_GUEST_OUT"; probe_ok container > "$STUB_CONTAINER_OUT"
# The idle timeout is off unless given, so slots keep each repo's wanted number; a value of unset leaves the row out.
profile(){ { printf '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n'; [[ " $* " == *" runner-idle-minutes "* ]] || printf '| `runner-idle-minutes` | `off` | test |\n'
  while [ $# -gt 0 ]; do [ "$2" = unset ] || printf '| `%s` | `%s` | %s |\n' "$1" "$2" "test"; shift 2; done; } > "$DESK_MACHINE"; }
on_profile(){ profile runner-possible yes runner-vm-cpus 8 runner-vm-memory-gb 24 runner-vm-disk-gb 100 runner-idle-minutes 10; }
yes_profile(){ profile runner-possible yes runner-vm-cpus "${1:-8}" runner-vm-memory-gb "${2:-24}" runner-vm-disk-gb "${3:-100}"; }

# ---- usage and the machine profile (AC8) ----
run
check "no command: usage, exit 2"                       '[ $rc -eq 2 ] && [[ "$out" == *"desk-runner up"* ]]'
run bogus
check "an unknown command: usage, exit 2"               '[ $rc -eq 2 ]'
run up
check "no profile: up refuses, exit 3"                  '[ $rc -eq 3 ] && [[ "$out" == *"no machine profile"* ]] && [[ "$out" == *"/desk-setup"* ]]'
check "no profile: tart is never called"                '[ -z "$log" ]'
printf '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `runner-possible` | `no` | below the minimum: 16 GB memory |\n' > "$DESK_MACHINE"
run up
check "profile says no: refuses with its reason"        '[ $rc -eq 3 ] && [[ "$out" == *"says no runner"* ]] && [[ "$out" == *"below the minimum: 16 GB memory"* ]] && [ -z "$log" ]'

# ---- the VM tool ----
yes_profile
# A PATH with node and python3 but no tart at all: never the real one, which would start a real VM.
mkdir -p "$T/notart"; for b in node python3; do ln -s "$(command -v "$b")" "$T/notart/$b"; done
PATH="$T/notart:/usr/bin:/bin" run up
check "no tart: refuses, naming the install"            '[ $rc -ne 0 ] && [[ "$out" == *"brew install openai/tools/tart"* ]]'
STUB_SUDO_RC=1 run up
check "softnet not setuid, no sudo: refuses with the fix" '[ $rc -ne 0 ] && [[ "$out" == *"chmod u+s"* ]] && [[ "$log" != *clone* ]]'

profile runner-possible yes runner-vm-cpus 8 runner-vm-disk-gb 100
run up
check "a size missing from the profile: refuses before cloning" '[ $rc -ne 0 ] && [[ "$out" == *"has no runner-vm-memory-gb"* ]] && [[ "$log" != *clone* ]]'
profile runner-possible yes runner-vm-cpus 8 runner-vm-memory-gb lots runner-vm-disk-gb 100
run up
check "a size that is not a number: refuses before cloning" '[ $rc -ne 0 ] && [[ "$out" == *"not a whole number"* ]] && [[ "$log" != *clone* ]]'
yes_profile

# ---- first up (AC1, AC4) ----
run up
v="$T/tart/desk-runner-test"
check "first up: exit 0, isolated"                      '[ $rc -eq 0 ] && [[ "$out" == *"isolation passed"* ]]'
check "first up: cloned from Ubuntu 24.04"              '[[ "$log" == *"clone ghcr.io/cirruslabs/ubuntu:24.04 desk-runner-test"* ]]'
check "first up: sized from the profile"                '[ "$(cat "$v/cpu") $(cat "$v/memory") $(cat "$v/disk")" = "8 24576 100" ]'
check "started headless behind the Softnet block"       'grep -q -- "--no-graphics --net-softnet-block=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,169.254.0.0/16" "$v/run-args"'
check "no shared folder or forwarded port"              '! grep -qE -- "--dir|--net-softnet-expose|--net-softnet-allow" "$v/run-args"'
check "guest set up: public resolvers, Docker"          'grep -q "use-dns: false" "$v/provision-script" && grep -q "docker.io" "$v/provision-script" && [ "$(cat "$v/provisioned")" = 3 ]'
check "the guest gets the pinned runner, Node, Docker and sysbox" '[[ "$log" == *"bash -s -- 3 1.1.1.1 9.9.9.9 2.338.0 22.23.3 29.9.0 desk-slot:2.338.0 docker:29.9.0-dind 0.7.1 04ca894ae0b53f0fa54eaacc173ce40363c9a95ea5450f773716a84ef650a69b"* ]]'
check "no slots yet: up says how to add them, calls no gh" '[[ "$out" == *"desk-runner scale <owner/repo>"* ]] && [ ! -s "$T/gh.log" ]'
check "the probe was copied into the guest"             'cmp -s "$v/probe.sh" "$SRC/desk/bin/runner-probe.sh"'
check "the pass is recorded"                            'read -r r _ < "$T/state/isolation.status"; [ "$r" = pass ]'
check "the busy lock is released"                       '[ ! -e "$T/state/busy" ]'

# ---- the launchd agents (AC5, AC7) ----
check "first up: both agents bootstrapped in the GUI domain" 'grep -qx "bootstrap gui/$UID_ $KEEP" "$T/launchctl.log" && grep -qx "bootstrap gui/$UID_ $NIGHTLY" "$T/launchctl.log"'
job_keep=$(pl "$KEEP" '" ".join(map(str, [d["RunAtLoad"], d["StartInterval"], d["AbandonProcessGroup"]] + d["ProgramArguments"]))')
job_env=$(pl "$KEEP" '" ".join(d["EnvironmentVariables"].get(k, "-") for k in ("DESK_RUNNER_VM", "DESK_RUNNER_STATE", "PATH"))')
job_nightly=$(pl "$NIGHTLY" '" ".join(map(str, [d["StartCalendarInterval"]["Hour"], d["StartCalendarInterval"]["Minute"], "RunAtLoad" in d, d["AbandonProcessGroup"]] + d["ProgramArguments"]))')
check "keep: at login and every minute, runs desk-runner keep" '[ "$job_keep" = "True 60 True $R keep" ]'
check "keep: the VM name, state and PATH carried over"  '[[ "$job_env" == "desk-runner-test $T/state $T/stub:"* ]]'
check "nightly: verify-isolation at 03:30"              '[ "$job_nightly" = "3 30 False True $R verify-isolation" ]'

# ---- the Mac settings (AC6) ----
check "up shows the settings, changes none without a terminal" '[[ "$out" == *"never sleep"*"needs a change (sleep 1): sudo pmset -a sleep 0"* ]] && [[ "$out" == *"restart after power loss"*"needs a change (autorestart 0)"* ]] && [[ "$out" == *"AutomaticallyInstallMacOSUpdates unset"* ]] && [[ "$out" == *"run desk-runner settings in a terminal"* ]] && ! grep -qE "pmset|defaults" "$T/sudo.log"'
settings n
check "settings: a no changes nothing"                  '[ $rc -eq 0 ] && [[ "$out" == *"[y/N]"* ]] && [[ "$out" == *"nothing changed"* ]] && [ ! -s "$T/sudo.log" ] && [ "$(cat "$T/mac/sleep")" = 1 ]'
settings ""
check "settings: no answer changes nothing"             '[[ "$out" == *"nothing changed"* ]] && [ ! -s "$T/sudo.log" ]'
STUB_SUDO_RC=1 settings y
check "settings: a sudo that fails is reported, exit 1" '[ $rc -eq 1 ] && [[ "$out" == *"failed: sudo pmset -a sleep 0"* ]] && [[ "$out" == *"3 still not as needed"* ]]'
settings y
check "settings: a yes makes each change with sudo"     '[ $rc -eq 0 ] && grep -qx "pmset -a sleep 0" "$T/sudo.log" && grep -qx "pmset -a autorestart 1" "$T/sudo.log" && grep -qx "defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false" "$T/sudo.log" && [[ "$out" == *"all set"* ]]'
settings y
check "settings: all set, no prompt and no sudo"        '[ $rc -eq 0 ] && [[ "$out" != *"[y/N]"* ]] && [[ "$out" == *"all set"* ]] && [ ! -s "$T/sudo.log" ]'

# ---- what is probed (AC2) ----
targets=$(cat "$v/targets")
check "the guest sweeps every port of the gateway"      'grep -qx "deny:10.9.9.1:1-65535" "$v/targets"'
check "the container sweeps its low ports and known ones" 'grep -qx "deny:10.9.9.1:1-1024" "$v/container-targets" && grep -qx "deny:10.9.9.1:5000" "$v/container-targets" && ! grep -q "1-65535" "$v/container-targets"'
check "both get every other target"                     '[ "$(grep -vc "^deny:10.9.9.1:[0-9-]*$" "$v/targets")" = "$(grep -vc "^deny:10.9.9.1:[0-9-]*$" "$v/container-targets")" ]'
check "the gateway is not also probed as a Mac address" '! grep -qx "deny:10.9.9.1:5000" "$v/targets" && [ "$(grep -cx "deny:10.9.9.1:5000" "$v/container-targets")" = 1 ]'
check "every Mac address, on every listening port"      'grep -qx "deny:192.168.4.187:5000" "$v/targets" && grep -qx "deny:192.168.4.26:5432" "$v/targets" && grep -qx "deny:192.168.4.187:22" "$v/targets"'
STUB_LSOF_EMPTY=1 run verify-isolation
check "no listeners listed: refuses, recorded as a failure" '[ $rc -ne 0 ] && [[ "$out" == *"could not list the Mac'"'"'s listening sockets"* ]] && read -r r _ < "$T/state/isolation.status" && [ "$r" = fail ]'
run verify-isolation
check "loopback is not a target"                        '! grep -q "deny:127\." "$v/targets"'
check "the router, metadata and Tailscale addresses"    'grep -qx "deny:192.168.4.1:53" "$v/targets" && grep -qx "deny:169.254.169.254:80" "$v/targets" && grep -qx "deny:100.100.100.100:53" "$v/targets"'
check "the VM tools' host aliases"                      'grep -qx "deny:host.docker.internal:22" "$v/targets" && grep -qx "deny:host.lima.internal:22" "$v/targets"'
svc=$(printf '%s\n' "$out" | sed -n 's/.*test services on 127.0.0.1:\([0-9]*\) and every interface:\([0-9]*\).*/\1 \2/p')
sp1=${svc% *}; sp2=${svc#* }
check "both Mac test services, at every Mac address"    '[ -n "$sp1" ] && [ "$sp1" != "$sp2" ] && [ -z "$(for a in 192.168.4.187 192.168.4.26; do for q in "$sp1" "$sp2"; do grep -qx "deny:$a:$q" "$v/targets" || echo "$a:$q"; done; done)" ]'
check "DNS over UDP: gateway and router denied, 1.1.1.1 the control" 'grep -qx "deny:10.9.9.1:53/udp" "$v/targets" && grep -qx "deny:192.168.4.1:53/udp" "$v/targets" && grep -qx "allow:1.1.1.1:53/udp" "$v/targets"'
check "npm must be reachable"                           'grep -qx "allow:registry.npmjs.org:443" "$v/targets"'

# ---- a second up changes nothing (AC1) ----
run up
check "second up: exit 0"                               '[ $rc -eq 0 ]'
check "second up: no clone, set, run or setup"          '[[ "$log" != *clone* ]] && [[ "$log" != *"set desk-runner-test"* ]] && [[ "$log" != *"run desk-runner-test"* ]] && [[ "$log" != *"bash -s"* ]]'
check "second up: the agents are not reloaded"          '! grep -qE "bootstrap|bootout" "$T/launchctl.log" && [[ "$out" == *"all set"* ]]'
cp "$KEEP" "$T/keep.plist"; printf 'changed\n' > "$KEEP"
run up
check "an agent whose plist changed is reloaded"        'grep -qx "bootout gui/$UID_/com.desk-skills.desk-runner-test" "$T/launchctl.log" && grep -qx "bootstrap gui/$UID_ $KEEP" "$T/launchctl.log" && cmp -s "$KEEP" "$T/keep.plist" && ! grep -qE "(bootstrap|bootout).*nightly" "$T/launchctl.log"'

# ---- failures (AC2, AC4) ----
printf 'OK guest deny 192.168.4.187:22 (no connection)\nBAD guest deny 10.9.9.1:1-1024 (connected: 53 88)\nDONE guest\n' > "$STUB_GUEST_OUT"
run verify-isolation
check "a BAD probe: exit 1, naming it"                  '[ $rc -eq 1 ] && [[ "$out" == *"isolation FAILED"* ]] && [[ "$out" == *"10.9.9.1:1-1024 (connected: 53 88)"* ]]'
check "the failure is recorded"                         'read -r r _ < "$T/state/isolation.status"; [ "$r" = fail ]'
run up
check "up after a failed probe starts no runner"        '[ $rc -eq 1 ] && [[ "$out" == *"no runner started"* ]]'
probe_ok guest > "$STUB_GUEST_OUT"; printf 'OK container deny read:/Users (not readable)\n' > "$STUB_CONTAINER_OUT"
run verify-isolation
check "a probe that did not finish is a failure"        '[ $rc -eq 1 ] && [[ "$out" == *"container probe did not finish"* ]]'
: > "$STUB_GUEST_OUT"; : > "$STUB_CONTAINER_OUT"
run verify-isolation
check "no output at all is a failure, not a pass"       '[ $rc -eq 1 ] && [[ "$out" != *"isolation passed"* ]]'
probe_ok guest > "$STUB_GUEST_OUT"; probe_ok container > "$STUB_CONTAINER_OUT"
run verify-isolation
STUB_COPY_RC=1 run verify-isolation
check "a run that stops early: exit non-zero"           '[ $rc -ne 0 ] && [[ "$out" == *"could not copy the probe"* ]]'
check "a run that stops early replaces the last pass"   'read -r r _ < "$T/state/isolation.status"; [ "$r" = fail ]'

# ---- a VM not started behind the block ----
run down
: > "$v/running"   # running as far as tart get says, with no tart run of ours behind it
run verify-isolation
check "a VM tart run did not start with the block: refused" '[ $rc -ne 0 ] && [[ "$out" == *"not running behind the Softnet block"* ]]'
check "... and recorded as a failure"                   'read -r r _ < "$T/state/isolation.status"; [ "$r" = fail ]'
rm -f "$v/running"; run up
check "up starts it behind the block again"             '[ $rc -eq 0 ] && [[ "$out" == *"isolation passed"* ]]'

# ---- runner slots ----
RP=bigbenjoman/voicepa; SL="$T/state/slots"
run scale
check "scale with no repo: usage, exit 2"               '[ $rc -eq 2 ] && [[ "$out" == *"desk-runner scale <owner/repo>"* ]]'
run scale 'bad repo' 2
check "scale with a malformed repo: usage, exit 2"      '[ $rc -eq 2 ] && [ ! -e "$SL" ]'
run scale "$RP"
check "scale with no n and no profile size: refuses"    '[ $rc -ne 0 ] && [[ "$out" == *"has no runner-slots-per-repo"* ]] && [ ! -e "$SL" ]'
run scale "$RP" two
check "scale with n not a number: refuses"              '[ $rc -ne 0 ] && [[ "$out" == *"not a whole number"* ]] && [ ! -e "$SL" ]'
STUB_PRIVATE=false run scale bigbenjoman/desk-skills 2
check "a public repo gets no slots"                     '[ $rc -ne 0 ] && [[ "$out" == *"is public"* ]] && [ ! -e "$SL" ] && ! grep -q generate-jitconfig "$T/gh.log"'

run scale "$RP" 2
check "scale: two runners registered and started"       '[ $rc -eq 0 ] && [ "$(grep -c generate-jitconfig "$T/gh.log")" = 2 ] && [ "$(wc -l < "$v/slot-starts" | tr -d " ")" = 2 ] && [ "$(cat "$SL")" = "$RP 2" ]'
check "each runner: self-hosted, linux, arm64 and the pool" 'grep -q -- "-f labels\[\]=self-hosted -f labels\[\]=linux -f labels\[\]=arm64 -f labels\[\]=desk-local-pr" "$T/gh.log" && grep -q "runner_group_id=1" "$T/gh.log"'
check "each runner is named for this VM and repo"       'grep -q -- "-f name=desk-runner-test-voicepa-" "$T/gh.log"'
check "the JIT config goes in on stdin, never as an argument" '[ "$(cat "$v/jits")" = "$(printf "JIT-100\nJIT-101")" ] && ! grep -q JIT- "$v/slot-starts" && ! grep -q JIT- "$T/tart.log"'
check "each slot gets its runner id, the pinned images, its own CPUs and 7 GB" 'grep -q " $RP 100 desk-slot:2.338.0 docker:29.9.0-dind 0-1 7$" "$v/slot-starts" && grep -q " $RP 101 desk-slot:2.338.0 docker:29.9.0-dind 2-3 7$" "$v/slot-starts"'
check "the slot script was copied into the guest"       'cmp -s "$v/slot.sh" "$SRC/desk/bin/runner-slot.sh"'
check "scale says how to switch runs-on, both ways"     '[[ "$out" == *"gh variable set DESK_RUNS_ON --body local -R $RP"* ]] && [[ "$out" == *"gh variable delete DESK_RUNS_ON -R $RP"* ]]'
run slots
check "slots: all running, nothing started or reaped"   '[ $rc -eq 0 ] && [ "$(wc -l < "$v/slot-starts" | tr -d " ")" = 2 ] && [ ! -e "$v/reaped" ]'
run status
check "status: the slots wanted and running"            '[[ "$out" == *"slots: $RP wants 2, 2 running"* ]]'

first=$(awk 'NR == 1 {print $1}' "$v/slots")
awk 'NR == 1 {$4 = "exited"} {print}' "$v/slots" > "$v/s"; mv "$v/s" "$v/slots"
run keep
check "keep: a finished slot is reaped, deregistered and replaced" '[ $rc -eq 0 ] && grep -qx "$first" "$v/reaped" && grep -qx 100 "$T/gh-deleted" && [ "$(wc -l < "$v/slot-starts" | tr -d " ")" = 3 ] && [ "$(awk "\$4 == \"running\"" "$v/slots" | wc -l | tr -d " ")" = 2 ]'
check "... on the CPUs the finished slot freed"         '[ "$(sed -n 3p "$v/slot-starts" | awk "{print \$(NF - 1)}")" = 0-1 ]'

printf '101 desk-runner-test-voicepa-a online\n555 desk-runner-test-voicepa-b offline\n556 someone-else offline\n' > "$T/gh-runners"
run slots
check "an offline runner of ours with no slot is deregistered" 'grep -qx 555 "$T/gh-deleted" && ! grep -qx 556 "$T/gh-deleted" && ! grep -qx 101 "$T/gh-deleted"'
rm -f "$T/gh-runners"

STUB_JIT_RC=1 run scale "$RP" 3
check "a refused registration: said, nothing started"   '[[ "$out" == *"could not register a runner for $RP: HTTP 403"* ]] && [ "$(wc -l < "$v/slot-starts" | tr -d " ")" = 3 ]'
STUB_START_RC=1 run slots
check "a slot that does not start: its runner deregistered" '[ $rc -ne 0 ] && [[ "$out" == *"did not start; its runner is deregistered"* ]] && grep -qx 103 "$T/gh-deleted"'
run slots
check "the next pass starts the missing slot"           '[ $rc -eq 0 ] && [ "$(awk "\$4 == \"running\"" "$v/slots" | wc -l | tr -d " ")" = 3 ]'

# ---- slot limits and how many the VM fits (DS-248): 8 CPUs, 24 GB, 2-CPU 7 GB slots fit 3 ----
run status
cpusets=$(printf '%s\n' "$out" | sed -n 's/^  slot [^:]*: CPUs \([0-9-]*\), 7 GB$/\1/p')
check "status: each slot's own CPU set, none shared"    '[ "$(printf "%s\n" "$cpusets" | sort | tr "\n" " ")" = "0-1 2-3 4-5 " ] && [[ "$out" == *"3 running (2 CPUs and 7 GB each)"* ]] && [[ "$out" != *"held back"* ]]'
starts=$(wc -l < "$v/slot-starts" | tr -d " ")
run scale "$RP" 6
check "scale past what the VM fits: recorded, says how many run and why, exit 0" '[ $rc -eq 0 ] && [ "$(cat "$SL")" = "$RP 6" ] && [[ "$out" == *"$RP: 3 of them will run; slots held back: 3 of the 6 wanted; the VM fits 3, min(8 CPUs / 2, (24 GB - 2 for the VM) / 7 GB)"* ]]'
check "... and starts none past the 3"                  '[ "$(wc -l < "$v/slot-starts" | tr -d " ")" = "$starts" ] && [ "$(wc -l < "$v/slots" | tr -d " ")" = 3 ]'
run status
check "status: how many are held back and why"          '[[ "$out" == *"slots held back: 3 of the 6 wanted; the VM fits 3, min(8 CPUs / 2, (24 GB - 2 for the VM) / 7 GB)"* ]]'
echo 12 > "$v/cpu"; echo 40960 > "$v/memory"; run status
check "a 12-CPU 40 GB VM fits 5 of the 6"               '[[ "$out" == *"slots held back: 1 of the 6 wanted; the VM fits 5, min(12 CPUs / 2, (40 GB - 2 for the VM) / 7 GB)"* ]]'
echo 8 > "$v/cpu"; echo 24576 > "$v/memory"
run scale bigbenjoman/other 3
check "two repos share the 3 in turn: 2 and 1"          '[ $rc -eq 0 ] && [ "$(awk -v r=$RP "\$2 == r" "$v/slots" | wc -l | tr -d " ")" = 2 ] && [ "$(awk "\$2 == \"bigbenjoman/other\"" "$v/slots" | wc -l | tr -d " ")" = 1 ] && [[ "$out" == *"removed (more than wanted)"* ]]'
run scale bigbenjoman/other 0
check "back to one repo: it has all 3 again"            '[ "$(awk -v r=$RP "\$2 == r" "$v/slots" | wc -l | tr -d " ")" = 3 ] && [ "$(wc -l < "$v/slots" | tr -d " ")" = 3 ]'
echo "7-1 $RP 900 running" >> "$v/slots"
run keep
check "an idle slot from before limits is replaced"     '[ $rc -eq 0 ] && grep -qx 7-1 "$v/reaped" && grep -qx 900 "$T/gh-deleted" && [[ "$out" == *"slot 7-1 for $RP was not 2 CPUs and 7 GB; replaced"* ]] && [ "$(wc -l < "$v/slots" | tr -d " ")" = 3 ]'
echo "7-2 $RP 901 running" >> "$v/slots"
STUB_BUSY=901 run keep
check "... one mid-job is left to finish, an idle one making room" '! grep -qx 7-2 "$v/reaped" && grep -q "^7-2 " "$v/slots" && [ "$(wc -l < "$v/slots" | tr -d " ")" = 3 ]'
awk '$1 != "7-2"' "$v/slots" > "$v/s"; mv "$v/s" "$v/slots"
profile runner-possible yes runner-vm-cpus 8 runner-vm-memory-gb 24 runner-vm-disk-gb 100 runner-slot-cpus 4 runner-slot-memory-gb 10
awk '{$4 = "exited"} {print}' "$v/slots" > "$v/s"; mv "$v/s" "$v/slots"
run keep
check "a slot size in the profile: 4 CPUs and 10 GB, 2 fit" '[ $rc -eq 0 ] && [ "$(tail -n 2 "$v/slot-starts" | awk "{print \$(NF - 1) FS \$NF}" | tr "\n" " ")" = "0-3 10 4-7 10 " ] && [ "$(awk "\$4 == \"running\"" "$v/slots" | wc -l | tr -d " ")" = 2 ]'
busy4=$(awk '{print $3}' "$v/slots" | tr '\n' ' ')
yes_profile
STUB_BUSY="$busy4" run keep
check "a smaller slot size beside busy larger slots: says why, starts none" '[[ "$out" == *"no memory in desk-runner-test for another $RP slot"* ]] && [ "$(awk "\$4 == \"running\"" "$v/slots" | wc -l | tr -d " ")" = 2 ]'
run keep
check "idle slots of the old size are replaced at the new one" '[[ "$out" == *"was not 2 CPUs and 7 GB; replaced"* ]] && [ "$(awk "\$4 == \"running\" {print \$5 FS \$6}" "$v/slots" | sort | tr "\n" " ")" = "0-1 7 2-3 7 4-5 7 " ]'
profile runner-possible yes runner-vm-cpus 8 runner-vm-memory-gb 24 runner-vm-disk-gb 100 runner-slot-memory-gb 10
awk '{$4 = "exited"} {print}' "$v/slots" > "$v/s"; mv "$v/s" "$v/slots"
run keep
busy10=$(awk '{print $3}' "$v/slots" | tr '\n' ' ')
yes_profile
STUB_BUSY="$busy10" run keep
check "busy 10 GB slots leave no memory for a 7 GB one: says so, starts none" '[[ "$out" == *"no memory in desk-runner-test for another $RP slot"* ]] && [ "$(awk "\$4 == \"running\" {print \$6}" "$v/slots" | tr "\n" " ")" = "10 10 " ]'
profile runner-possible yes runner-vm-cpus 8 runner-vm-memory-gb 24 runner-vm-disk-gb 100 runner-slot-cpus none
run status
check "a slot size that is not a number: refused, naming it" '[ $rc -ne 0 ] && [[ "$out" == *"runner-slot-cpus is '"'"'none'"'"', not a whole number"* ]]'
yes_profile
awk '{$4 = "exited"} {print}' "$v/slots" > "$v/s"; mv "$v/s" "$v/slots"
run scale "$RP" 3
check "the defaults again: 3 slots of 2 CPUs"           '[ "$(awk "\$4 == \"running\" {print \$5}" "$v/slots" | sort | tr "\n" " ")" = "0-1 2-3 4-5 " ]'

busy=$(awk 'NR == 1 {print $3}' "$v/slots")
STUB_BUSY="$busy" run scale "$RP" 1
check "scale down: idle runners removed, the busy one kept" '[ $rc -eq 0 ] && [ "$(wc -l < "$v/slots" | tr -d " ")" = 1 ] && [ "$(awk "{print \$3}" "$v/slots")" = "$busy" ] && [ "$(cat "$SL")" = "$RP 1" ]'

printf '%s desk-runner-test-voicepa-x online\n' "$busy" > "$T/gh-runners"
run down
check "down deregisters our runners before stopping"    '[ $rc -eq 0 ] && grep -q "api -X DELETE repos/$RP/actions/runners/$busy" "$T/gh.log" && [ -s "$SL" ]'
rm -f "$T/gh-runners" "$v/slots"; run up
check "up brings the wanted slots back"                 '[ $rc -eq 0 ] && [ "$(wc -l < "$v/slots" | tr -d " ")" = 1 ]'
run gate >/dev/null; printf 'fail %s 1 failed\n' "$(date +%s)" > "$T/state/isolation.status"
run slots
check "slots with the gate closed: says why, starts none" '[ $rc -ne 0 ] && [[ "$out" == *"runner slots closed: the last verify-isolation failed"* ]] && ! grep -q generate-jitconfig "$T/gh.log"'
run verify-isolation
run scale "$RP" 0
check "scale to 0: the repo's slots go, and the line"   '[ $rc -eq 0 ] && [ ! -s "$v/slots" ] && [ ! -e "$SL" ] && [[ "$out" != *"gh variable set"* ]]'

run scale "$RP" 2
busy=$(awk 'NR == 1 {print $3}' "$v/slots"); bid=$(awk 'NR == 1 {print $1}' "$v/slots")
printf '%s desk-runner-test-voicepa-x online\n' "$busy" > "$T/gh-runners"
STUB_BUSY="$busy" run scale "$RP" 0
check "scale to 0 with a slot mid-job: the repo stays at 0" '[ "$(cat "$SL")" = "$RP 0" ] && [ "$(awk "{print \$3}" "$v/slots")" = "$busy" ]'
awk '{$4 = "exited"} {print}' "$v/slots" > "$v/s"; mv "$v/s" "$v/slots"; rm -f "$T/gh-runners"
run keep
check "once its job ends, keep reaps it and drops the repo" '[ $rc -eq 0 ] && grep -qx "$bid" "$v/reaped" && [ ! -e "$SL" ] && ! grep -q generate-jitconfig "$T/gh.log"'

run scale "$RP" 2
printf 'fail %s 1 failed\n' "$(date +%s)" > "$T/state/isolation.status"
run scale "$RP" 0
check "scale to 0 with the gate closed: idle slots still go" '[ ! -s "$v/slots" ] && [ ! -e "$SL" ] && [[ "$out" == *"runner slots closed"* ]]'
run verify-isolation

run scale "$RP" 2
STUB_PRIVATE=false run slots
check "a repo made public: its slots go, none start"   '[[ "$out" == *"$RP is public now"* ]] && [ ! -s "$v/slots" ] && [ ! -e "$SL" ] && ! grep -q generate-jitconfig "$T/gh.log"'

echo 9216 > "$v/memory"   # (9 GB - 2) / 7 fits one slot
run scale "$RP" 1
run scale bigbenjoman/other 1
check "a repo the full VM allots none keeps its request" '[ "$(awk "\$1 == \"bigbenjoman/other\" {print \$2}" "$SL")" = 1 ] && [ "$(wc -l < "$v/slots" | tr -d " ")" = 1 ]'
run scale bigbenjoman/other 0; run scale "$RP" 0; echo 24576 > "$v/memory"

run scale "$RP" 1
run down
run scale "$RP" 0
check "scale to 0 with the VM down: the repo stays at 0"  '[ "$(cat "$SL")" = "$RP 0" ] && [ -s "$v/slots" ]'
run up
check "... and the next up reaps its slot and drops it"   '[ ! -s "$v/slots" ] && [ ! -e "$SL" ]'

run scale "$RP" 1
printf '1-1 other/repo 9990 exited\n1-2 %s 9x9 exited\n' "$RP" >> "$v/slots"
run slots
check "rows naming another repo or a bad id: nothing deregistered" '! grep -qE "^(9990|9x9)$" "$T/gh-deleted" && ! grep -qE "runners/(9990|9x9)" "$T/gh.log"'
run scale "$RP" 0; rm -f "$v/slots" "$SL"

# ---- runner-slot.sh against a stubbed docker and systemctl (DS-248) ----
mkdir -p "$T/slotstub"
cat > "$T/slotstub/docker" <<'EOF'
#!/bin/sh
echo "docker $*" >> "$SLOTLOG"
EOF
cat > "$T/slotstub/systemctl" <<'EOF'
#!/bin/sh
echo "systemctl $*" >> "$SLOTLOG"
EOF
chmod +x "$T/slotstub/"*
export SLOTLOG="$T/slot.log"; : > "$SLOTLOG"
out=$(echo JIT-1 | PATH="$T/slotstub:$PATH" bash "$SRC/desk/bin/runner-slot.sh" start 17-42 "$RP" 7 img dind 2-3 7 2>&1); rc=$?
lim="--cgroup-parent deskslot_17_42.slice --cpuset-cpus 2-3 --memory 7g --label desk.cpus=2-3 --label desk.memory=7"
check "slot start: the memory is a label too, for list" 'grep "^docker run -d --name desk-slot-17-42-runner" "$SLOTLOG" | grep -qF -- "--label desk.memory=7"'
check "slot start: the slice is capped at the slot's memory" '[ $rc -eq 0 ] && grep -qx "systemctl start deskslot_17_42.slice" "$SLOTLOG" && grep -qx "systemctl set-property --runtime deskslot_17_42.slice MemoryMax=7G MemorySwapMax=0" "$SLOTLOG"'
check "slot start: dind and the runner both carry the CPU set, memory and slice" '[ "$(grep "^docker run -d" "$SLOTLOG" | grep -cF -- "$lim")" = 2 ] && grep "^docker run -d --name desk-slot-17-42-dind" "$SLOTLOG" | grep -qF -- "$lim" && grep "^docker run -d --name desk-slot-17-42-runner" "$SLOTLOG" | grep -qF -- "$lim"'
out=$(PATH="$T/slotstub:$PATH" bash "$SRC/desk/bin/runner-slot.sh" start 17-42 "$RP" 7 img dind 2>&1 < /dev/null); rc=$?
check "slot start without the limits: usage, exit 2"    '[ $rc -eq 2 ] && [[ "$out" == *"<cpus> <memory-gb>"* ]]'
: > "$SLOTLOG"; PATH="$T/slotstub:$PATH" bash "$SRC/desk/bin/runner-slot.sh" reap 17-42
check "slot reap: the slice goes too"                   'grep -qx "systemctl stop deskslot_17_42.slice" "$SLOTLOG" && grep -qx "systemctl revert deskslot_17_42.slice" "$SLOTLOG"'
: > "$SLOTLOG"; PATH="$T/slotstub:$PATH" bash "$SRC/desk/bin/runner-slot.sh" list
check "slot list: the CPU set and memory are the fifth and sixth fields" 'grep -qF "{{.State}} {{.Label \"desk.cpus\"}} {{.Label \"desk.memory\"}}" "$SLOTLOG"'

# ---- the gate on new runner slots (AC7) ----
run gate
check "gate: open after a pass"                         '[ $rc -eq 0 ] && [[ "$out" == *"runner slots open"* ]]'
printf 'BAD guest deny 10.9.9.1:1-65535 (connected: 5000)\nDONE guest\n' > "$STUB_GUEST_OUT"
run verify-isolation   # what the nightly agent runs
run gate
check "gate: a failed verify closes it, naming why"     '[ $rc -eq 1 ] && [[ "$out" == *"runner slots closed: the last verify-isolation failed 0m ago (1 failed)"* ]]'
probe_ok guest > "$STUB_GUEST_OUT"
run verify-isolation; run gate
check "gate: the next pass reopens it"                  '[ $rc -eq 0 ]'
read -r r at d < "$T/state/isolation.status"; printf 'pass %s %s\n' $((at - 26 * 3600)) "$d" > "$T/state/isolation.status"
run gate
check "gate: a pass older than 25h closes it"           '[ $rc -eq 1 ] && [[ "$out" == *"the last pass is 26h old"* ]]'
run status
check "status: the last result, its age, and the slots" '[[ "$out" == *"isolation: pass, 26h ago"* ]] && [[ "$out" == *"runner slots: closed (the last pass is 26h old"* ]] && [[ "$out" == *"every minute loaded; verify-isolation nightly at 03:30 loaded"* ]]'

# ---- keep: bringing the VM back (AC5) ----
run keep
check "keep: a stale pass is verified again, no restart" '[ $rc -eq 0 ] && [[ "$log" != *"run desk-runner-test"* ]] && [[ "$out" == *"isolation passed"* ]] && read -r r at _ < "$T/state/isolation.status" && [ "$r" = pass ] && [ $(( $(date +%s) - at )) -lt 60 ]'
run keep
check "keep: a healthy VM is left alone, silently"      '[ $rc -eq 0 ] && [ -z "$out" ] && [[ "$log" != *exec* ]] && [[ "$log" != *"run desk-runner-test"* ]]'
stop_vm
run status
check "status: a stopped VM closes the slots"           '[ $rc -eq 1 ] && [[ "$out" == *"runner slots: closed (desk-runner-test is not running)"* ]]'
run keep
check "keep: a stopped VM is started and verified"      '[ $rc -eq 0 ] && [[ "$out" == *"bringing desk-runner-test back: desk-runner-test is not running"* ]] && [[ "$out" == *"is back and isolated"* ]] && grep -q -- "--net-softnet-block=" "$v/run-args" && [ ! -e "$BACKOFF" ]'
run status
check "status after keep: running, slots open"          '[ $rc -eq 0 ] && [[ "$out" == *"desk-runner-test: running"* ]] && [[ "$out" == *"runner slots: open"* ]]'

stop_vm; printf 'BAD guest deny 10.9.9.1:1-65535 (connected: 5000)\nDONE guest\n' > "$STUB_GUEST_OUT"
run keep
check "keep: a failed attempt exits 1, next in 1m"      '[ $rc -eq 1 ] && [[ "$out" == *"attempt 1 to bring desk-runner-test back failed; the next is in 1m"* ]] && read -r f _ < "$BACKOFF" && [ "$f" = 1 ] && n=$(next_in) && [ "$n" -ge 55 ] && [ "$n" -le 60 ]'
run keep
check "keep: inside the wait, no attempt"               '[ $rc -eq 0 ] && [[ "$out" == *"waiting"* ]] && [[ "$log" != *exec* ]]'
run status
check "status: the failed restarts and the next attempt" '[[ "$out" == *"restarts: 1 failed in a row; the next attempt is in"* ]]'
echo "1 0" > "$BACKOFF"; run keep
check "keep: the second failure waits 2m"               '[ $rc -eq 1 ] && read -r f _ < "$BACKOFF" && [ "$f" = 2 ] && n=$(next_in) && [ "$n" -ge 115 ] && [ "$n" -le 120 ]'
echo "2 0" > "$BACKOFF"; run keep
check "keep: the third waits 4m"                        'read -r f _ < "$BACKOFF" && [ "$f" = 3 ] && n=$(next_in) && [ "$n" -ge 235 ] && [ "$n" -le 240 ]'
echo "9 0" > "$BACKOFF"; run keep
check "keep: the wait stops doubling at an hour"        'read -r f _ < "$BACKOFF" && [ "$f" = 10 ] && n=$(next_in) && [ "$n" -ge 3595 ] && [ "$n" -le 3600 ]'
probe_ok guest > "$STUB_GUEST_OUT"; echo "1 0" > "$BACKOFF"
STUB_COPY_RC=1 run keep
check "keep: an attempt that dies part-way also backs off" '[ $rc -ne 0 ] && [[ "$out" == *"could not copy the probe"* ]] && read -r f _ < "$BACKOFF" && [ "$f" = 2 ]'
echo "2 0" > "$BACKOFF"; run keep
check "keep: a passing attempt clears the backoff"      '[ $rc -eq 0 ] && [[ "$out" == *"is back and isolated"* ]] && [ ! -e "$BACKOFF" ]'

stop_vm; mkdir "$T/state/busy"; echo $$ > "$T/state/busy/pid"
run keep
check "keep: another desk-runner busy, nothing done"    '[ $rc -eq 0 ] && [[ "$out" == *"is busy"* ]] && [[ "$log" != *"run desk-runner-test"* ]] && [ -d "$T/state/busy" ]'
sh -c 'exit 0' & dead=$!; wait $dead; echo "$dead" > "$T/state/busy/pid"
run keep
check "keep: a dead holder's lock is taken over"        '[ $rc -eq 0 ] && [[ "$out" == *"is back and isolated"* ]] && [ ! -e "$T/state/busy" ]'

# ---- sleeping when idle and waking on a queued job (DS-249) ----
ACT="$T/state/active"; ASL="$T/state/asleep"
ago_s(){ echo $(( $(date +%s) - $1 )); }
iso_ago(){ python3 -c 'import sys,time; print(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - int(sys.argv[1]))))' "$1"; }
runs(){ printf '{"workflow_runs":[%s]}\n' "$2" > "$T/runs-$1.json"; }
# job <run> <labels, comma-separated and quoted> <queued so many seconds ago>: one queued job in that run
job(){ printf '{"jobs":[{"status":"completed","labels":[%s],"created_at":"%s"},{"status":"queued","labels":[%s],"created_at":"%s"}]}\n' "$2" "$(iso_ago 900)" "$2" "$(iso_ago "$3")" > "$T/jobs-$1.json"; }
no_runs(){ rm -f "$T/runs-queued.json" "$T/runs-progress.json" "$T"/jobs-*.json; }
idle_for(){ echo $(( $(date +%s) - $1 * 60 )) > "$ACT"; }
our(){ printf '%s desk-runner-test-voicepa-x online %s\n' "$(awk 'NR == 1 {print $3} END {if (!NR) print 901}' "$v/slots")" "$1" > "$T/gh-runners"; }
run scale "$RP" 1
on_profile; idle_for 30; our true
run keep
check "a slot mid-job keeps the VM up and restarts the idle clock" '[ $rc -eq 0 ] && [ -f "$v/running" ] && [ "$(ago_s "$(cat "$ACT")")" -lt 60 ] && [ ! -e "$ASL" ]'
idle_for 30; rm -f "$T/gh-runners"; awk '{$4 = "exited"} {print}' "$v/slots" > "$v/s"; mv "$v/s" "$v/slots"
run keep
check "a job that just finished keeps the VM up too"     '[ $rc -eq 0 ] && [ -f "$v/running" ] && [ "$(ago_s "$(cat "$ACT")")" -lt 60 ] && [[ "$out" == *"finished; reaped"* ]]'
off_profile(){ profile runner-possible yes runner-vm-cpus 8 runner-vm-memory-gb 24 runner-vm-disk-gb 100 runner-idle-minutes off; }
off_profile; run keep
idle_for 30; our false
run keep
check "runner-idle-minutes off: the VM stays up"        '[ $rc -eq 0 ] && [ -f "$v/running" ] && [ ! -e "$ASL" ] && [ -z "$out" ]'
run status
check "status: off, never sleeps"                       '[[ "$out" == *"idle: never sleeps (runner-idle-minutes is off)"* ]]'
on_profile
STUB_RUNNERS_RC=1 run keep
check "a runner list GitHub would not give: the VM stays up" '[ -f "$v/running" ] && [ ! -e "$ASL" ]'
profile runner-possible yes runner-vm-cpus 8 runner-vm-memory-gb 24 runner-vm-disk-gb 100 runner-idle-minutes unset
idle_for 9; run keep
check "9 idle minutes, under the default 10: stays up"  '[ $rc -eq 0 ] && [ -f "$v/running" ] && [ ! -e "$ASL" ]'
idle_for 11; STUB_BUSY="$(awk '{print $1}' "$T/gh-runners")" run keep
check "a runner that takes a job as the VM would stop: it stays up" '[ -f "$v/running" ] && [ ! -e "$ASL" ] && [[ "$out" == *"took a job; desk-runner-test stays up"* ]]'
off_profile; run scale "$RP" 2; on_profile; idle_for 11
awk '$4 == "running" {print $3, "desk-runner-test-voicepa-" NR, "online", "false"}' "$v/slots" > "$T/gh-runners"
first=$(awk 'NR == 1 {print $1}' "$T/gh-runners"); second=$(awk 'NR == 2 {print $1}' "$T/gh-runners")
fsid=$(awk -v r="$first" '$3 == r {print $1}' "$v/slots"); ssid=$(awk -v r="$second" '$3 == r {print $1}' "$v/slots")
STUB_BUSY="$second" run keep
check "a runner refused part-way: the slot already deregistered is reaped, the other kept" '[ -f "$v/running" ] && [ ! -e "$ASL" ] && grep -qx "$first" "$T/gh-deleted" && grep -qx "$fsid" "$v/reaped" && ! grep -qx "$ssid" "$v/reaped"'
off_profile; run scale "$RP" 1; on_profile; our false
idle_for 11; rid=$(awk '{print $1}' "$T/gh-runners"); sid=$(awk 'NR == 1 {print $1}' "$v/slots")
run keep
check "10 idle minutes: runners deregistered, slots reaped, the VM stopped" '[ $rc -eq 0 ] && grep -qx "$rid" "$T/gh-deleted" && grep -qx "$sid" "$v/reaped" && [ ! -f "$v/running" ] && ! pgrep -f "$T/stub/tart run desk-runner-test" >/dev/null'
check "... logging why, and asleep"                     '[[ "$out" == *"no slot has run a job for 10m"* ]] && [[ "$out" == *"desk-runner-test is asleep"* ]] && [ -s "$ASL" ]'
rm -f "$T/gh-runners"; no_runs
run keep
check "asleep, nothing queued: stays stopped, silently, no backoff" '[ $rc -eq 0 ] && [ -z "$out" ] && [ ! -f "$v/running" ] && [ ! -e "$BACKOFF" ] && [[ "$log" != *"run desk-runner-test"* ]]'
check "asleep: two GitHub calls for the repo, and no runner list" '[ "$(wc -l < "$T/gh.log" | tr -d " ")" = 2 ] && grep -q "repos/$RP/actions/runs?status=queued" "$T/gh.log" && grep -q "repos/$RP/actions/runs?status=in_progress" "$T/gh.log" && ! grep -q "actions/runners" "$T/gh.log"'
run status
check "status: asleep, since when, and why"             '[ $rc -eq 1 ] && [[ "$out" == "desk-runner-test: asleep ("* ]] && [[ "$out" =~ "asleep: since "[0-9]{4}-[0-9]{2}-[0-9]{2}" "[0-9]{2}:[0-9]{2}" (no job for 10m); it wakes when a job is queued for desk-local-pr" ]] && [[ "$out" == *"runner slots: closed (desk-runner-test is asleep until a job is queued for desk-local-pr)"* ]]'
iso_before=$(cat "$T/state/isolation.status")
run verify-isolation
check "the nightly verify-isolation leaves it asleep and the last pass as it was" '[ $rc -eq 0 ] && [[ "$out" == *"is asleep: not started"* ]] && [ ! -f "$v/running" ] && [ "$(cat "$T/state/isolation.status")" = "$iso_before" ]'
runs queued '{"id":7}'; job 7 '"ubuntu-latest"' 60
run keep
check "a job queued for GitHub-hosted only: stays asleep" '[ $rc -eq 0 ] && [ ! -f "$v/running" ] && grep -q "repos/$RP/actions/runs/7/jobs" "$T/gh.log" && [ "$(wc -l < "$T/gh.log" | tr -d " ")" = 3 ]'
STUB_RUNS_RC=1 run keep
check "GitHub not answering: stays asleep and says so"  '[ $rc -eq 0 ] && [ ! -f "$v/running" ] && [[ "$out" == *"could not read $RP'"'"'s queued jobs"* ]]'
starts=$(wc -l < "$v/slot-starts" | tr -d " ")
runs progress '{"id":8}'; job 8 '"self-hosted","linux","arm64","desk-local-pr"' 90
run keep
check "a job queued for the pool in a run under way wakes the VM behind the block" '[ $rc -eq 0 ] && [ -f "$v/running" ] && grep -q -- "--net-softnet-block=" "$v/run-args" && [ ! -e "$ASL" ] && [ ! -e "$BACKOFF" ]'
check "... and its repo gets a slot"                    '[ "$(wc -l < "$v/slot-starts" | tr -d " ")" = $((starts + 1)) ] && [ "$(awk "\$4 == \"running\"" "$v/slots" | wc -l | tr -d " ")" = 1 ]'
check "the wake logs when the job queued, the VM answered and the slot came online" '[[ "$out" =~ "waking desk-runner-test: a job for desk-local-pr in $RP was queued at "[0-9T:-]+Z ]] && [[ "$out" =~ "desk-runner-test answered at "[0-9T:-]+Z ]] && [[ "$out" =~ "a slot came online at "[0-9T:-]+Z", "(9[0-9]|1[0-9][0-9])"s after the job was queued" ]]'
check "a pass under 25h is reused: no verify-isolation"  '[[ "$out" == *"slots open on the verify-isolation pass from "*" ago: it is under 25h old"* ]] && [[ "$out" != *"isolation passed"* ]] && [[ "$log" != *probe.sh* ]]'
run status
check "status: the last wake used the pass, and its age" '[ $rc -eq 0 ] && [[ "$out" =~ "last wake: "[0-9-]+" "[0-9:]+", which used the pass from "[0-9]+[mh]" ago" ]] && [[ "$out" == *"idle: sleeps once no slot has run a job for 10m"* ]]'
check "the wake starts the idle clock"                  '[ "$(ago_s "$(cat "$ACT")")" -lt 60 ]'
echo "$(date +%s) no job for 10m" > "$ASL"; idle_for 30; our false
run keep
check "a wake that died with the VM up: the next keep clears asleep and restarts the clock" '[ $rc -eq 0 ] && [ -f "$v/running" ] && [ ! -e "$ASL" ] && [ "$(ago_s "$(cat "$ACT")")" -lt 60 ]'
rm -f "$T/gh-runners"
go_to_sleep(){ idle_for 11; our false; run keep; rm -f "$T/gh-runners"; }
no_runs; go_to_sleep
read -r r at d < "$T/state/isolation.status"; printf 'pass %s %s\n' $((at - 26 * 3600)) "$d" > "$T/state/isolation.status"
runs queued '{"id":9}'; job 9 '"desk-local-pr"' 30
run keep
check "a wake on a pass 25h old or more runs verify-isolation in full first" '[ $rc -eq 0 ] && [ -f "$v/running" ] && [[ "$out" == *"isolation passed"* ]] && [[ "$out" != *"slots open on the verify-isolation pass"* ]] && grep -q "ran verify-isolation in full" "$T/state/woke"'
no_runs; go_to_sleep
printf 'fail %s 1 failed\n' "$(date +%s)" > "$T/state/isolation.status"
printf 'BAD guest deny 10.9.9.1:1-65535 (connected: 5000)\nDONE guest\n' > "$STUB_GUEST_OUT"
starts=$(wc -l < "$v/slot-starts" | tr -d " ")
runs queued '{"id":9}'; job 9 '"desk-local-pr"' 30
run keep
check "a wake after a failed verify runs it again, and opens no slot when it fails" '[ $rc -eq 1 ] && [[ "$out" == *"isolation FAILED"* ]] && [ "$(wc -l < "$v/slot-starts" | tr -d " ")" = "$starts" ] && [ -s "$BACKOFF" ]'
probe_ok guest > "$STUB_GUEST_OUT"; rm -f "$BACKOFF"
run keep
check "... and the next passing verify opens them"     '[ $rc -eq 0 ] && [[ "$out" == *"isolation passed"* ]] && [ "$(awk "\$4 == \"running\"" "$v/slots" | wc -l | tr -d " ")" = 1 ]'
no_runs; go_to_sleep
profile runner-possible yes runner-vm-cpus 8 runner-vm-memory-gb 24 runner-vm-disk-gb 100 runner-idle-minutes off
run keep
check "asleep when the timeout turns off: brought back with nothing queued" '[ $rc -eq 0 ] && [ -f "$v/running" ] && [ ! -e "$ASL" ] && [[ "$out" == *"bringing desk-runner-test back"* ]]'
on_profile; go_to_sleep
run up
check "up wakes it and clears asleep"                   '[ $rc -eq 0 ] && [ -f "$v/running" ] && [ ! -e "$ASL" ]'
go_to_sleep
run down
check "down while asleep: stopped, not asleep"         '[ $rc -eq 0 ] && [ ! -e "$ASL" ]'

# ---- slots follow the jobs queued, oldest first (DS-250) ----
OT=bigbenjoman/other
# queue <run> <file suffix or ""> <seconds ago...>: that many jobs queued for the pool in one run
queue(){ local run=$1 who=$2 j="" a; shift 2; for a in "$@"; do j="$j${j:+,}{\"status\":\"queued\",\"labels\":[\"desk-local-pr\"],\"created_at\":\"$(iso_ago "$a")\"}"; done
  printf '{"jobs":[%s]}\n' "$j" > "$T/jobs-$run.json"; printf '{"workflow_runs":[{"id":%s}]}\n' "$run" > "$T/runs-queued${who:+-$who}.json"; }
running(){ awk -v r="${1:-}" '$4 == "running" && (r == "" || $2 == r)' "$v/slots" | wc -l | tr -d ' '; }
on_profile; run up; run scale "$RP" 0; rm -f "$v/slots" "$SL" "$T/gh-runners"; no_runs
queue 20 "" 120 60
run scale "$RP" 3
check "2 jobs queued, 3 wanted: 2 slots open, not 3"  '[ "$(running)" = 2 ] && [[ "$out" == *"$RP: 3 runner slots wanted"* ]]'
run keep
check "... and the next pass, with both still queued for those idle slots, opens no third" '[ "$(running)" = 2 ]'
run status
check "status: the jobs queued, the slots open and the wanted number" '[[ "$out" == *"slots: $RP wants 3, 2 running (2 CPUs and 7 GB each), 2 jobs queued for desk-local-pr"* ]]'
no_runs; awk 'NR == 1 {$4 = "exited"} {print}' "$v/slots" > "$v/s"; mv "$v/s" "$v/slots"
starts=$(wc -l < "$v/slot-starts" | tr -d " ")
run keep
check "a slot whose job finished, nothing more queued: reaped, not replaced, and the idle one dropped" '[[ "$out" == *"finished; reaped"* ]] && [[ "$out" == *"removed (no job queued for it)"* ]] && [ "$(running)" = 0 ] && [ "$(wc -l < "$v/slot-starts" | tr -d " ")" = "$starts" ]'
awk '{$4 = "exited"} {print}' "$v/slots" > "$v/s"; mv "$v/s" "$v/slots"
queue 21 "" 30
run keep
check "a slot whose job finished, another job queued: replaced" '[ "$(running)" = 1 ] && [ "$(wc -l < "$v/slot-starts" | tr -d " ")" = $((starts + 1)) ]'
no_runs; run scale "$RP" 0; rm -f "$v/slots" "$SL"
queue 22 bigbenjoman_voicepa 100; queue 23 bigbenjoman_other 300 200 150
printf '%s 3\n%s 3\n' "$RP" "$OT" > "$SL"
run slots
check "jobs in two repos, 3 free slots: the oldest 3 jobs get them, all in the other repo" '[ "$(running "$OT")" = 3 ] && [ "$(running "$RP")" = 0 ]'
run keep
check "... and they stay: none dropped for a turn-by-turn share" '[ "$(running "$OT")" = 3 ] && [ "$(running "$RP")" = 0 ] && [[ "$out" != *"more than wanted"* ]]'
rm -f "$T/runs-queued-bigbenjoman_other.json"
run keep
check "the other repo's jobs cancelled: its idle slots go back, and the job still queued gets one" '[ "$(running "$OT")" = 0 ] && [ "$(running "$RP")" = 1 ] && [[ "$out" == *"removed (no job queued for it)"* ]]'
rm -f "$v/slots"; queue 24 bigbenjoman_other 300 200 150; printf '%s 3\n%s 3\n' "$OT" "$RP" > "$SL"
STUB_RUNS_FAIL=voicepa run slots
check "a repo whose queue GitHub will not give keeps its share before the other's jobs take the rest" '[ "$(running "$RP")" -ge 1 ] && [ "$(running)" = 3 ]'
TH=bigbenjoman/third; rm -f "$v/slots" "$T/runs-queued-bigbenjoman_other.json"
off_profile; printf '%s 3\n' "$OT" > "$SL"; run slots; on_profile
printf '%s 3\n%s 3\n%s 3\n' "$OT" "$TH" "$RP" > "$SL"; queue 25 bigbenjoman_third 300 200 150
STUB_RUNS_FAIL=voicepa run slots
check "... and when idle slots fill the VM, the share comes from those they give back" '[ "$(running "$OT")" = 0 ] && [ "$(running "$RP")" -ge 1 ] && [ "$(running)" = 3 ]'
rm -f "$T"/runs-queued-*.json; no_runs; run scale "$OT" 0; run scale "$RP" 0; rm -f "$v/slots" "$SL"
profile runner-possible yes runner-vm-cpus 8 runner-vm-memory-gb 24 runner-vm-disk-gb 100 runner-idle-minutes off
run scale "$RP" 2
check "the timeout off: the wanted number, with nothing queued" '[ "$(running)" = 2 ] && ! grep -q "actions/runs?status" "$T/gh.log"'
run up; run scale "$RP" 0; rm -f "$v/slots" "$SL" "$T/gh-runners"; no_runs

# ---- status and down (AC9) ----
run verify-isolation
run status
check "status: running, with the last result and age"   '[ $rc -eq 0 ] && [[ "$out" == *"desk-runner-test: running (8 CPUs, 24576 MB, 100 GB disk)"* ]] && [[ "$out" == *"isolation: pass, 0m ago"* ]]'
run down
check "down stops the VM, and its tart run is gone"     '[ $rc -eq 0 ] && [[ "$log" == *"stop desk-runner-test"* ]] && [ ! -f "$v/running" ] && [[ "$out" == *"nothing is left running"* ]] && ! pgrep -f "$T/stub/tart run desk-runner-test" >/dev/null'
check "down removes both agents first"                  'grep -qx "bootout gui/$UID_/com.desk-skills.desk-runner-test" "$T/launchctl.log" && grep -qx "bootout gui/$UID_/com.desk-skills.desk-runner-test.nightly" "$T/launchctl.log" && [ ! -e "$KEEP" ] && [ ! -e "$NIGHTLY" ]'
run status
check "status after down: stopped, exit 1"              '[ $rc -eq 1 ] && [[ "$out" == *"stopped"* ]] && [[ "$out" == *"every minute not installed; verify-isolation nightly at 03:30 not installed"* ]]'
run down
check "down when stopped: says so, exit 0"              '[ $rc -eq 0 ] && [[ "$out" == *"is not running"* ]] && [[ "$log" != *stop* ]] && ! grep -q bootout "$T/launchctl.log"'
run verify-isolation
check "verify-isolation on a stopped VM refuses"        '[ $rc -ne 0 ] && [[ "$out" == *"is not running"* ]]'

# ---- the profile changes ----
yes_profile 6 16 120
run up
check "stopped VM, new profile: resized before start"   '[ $rc -eq 0 ] && [ "$(cat "$v/cpu") $(cat "$v/memory") $(cat "$v/disk")" = "6 16384 120" ]'
yes_profile 8 24 100
run up
check "running VM, new profile: says how, no resize"    '[ $rc -eq 0 ] && [[ "$out" == *"down, then up, applies it"* ]] && [[ "$log" != *"set desk-runner-test"* ]]'
run down; yes_profile 8 24 100
run up
check "a smaller disk is never shrunk"                  '[ "$(cat "$v/disk")" = 120 ] && [ "$(cat "$v/cpu")" = 8 ]'
run down
rm -rf "$v"; run status
check "status with no VM: absent, exit 1"               '[ $rc -eq 1 ] && [[ "$out" == *"absent"* ]] && [[ "$out" == *"isolation: pass"* ]]'

# ---- runner-probe.sh against local listeners ----
if command -v timeout >/dev/null 2>&1; then
  python3 -c '
import socket, threading, sys
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(8)
t = socket.socket(); t.bind(("127.0.0.1", 0)); t.listen(8)
print(s.getsockname()[1], t.getsockname()[1], flush=True)
def serve(x):
    while True:
        c, _ = x.accept(); c.close()
for x in (s, t): threading.Thread(target=serve, args=(x,), daemon=True).start()
threading.Event().wait()' > "$T/ports" & lpid=$!
n=0; while [ ! -s "$T/ports" ] && [ $n -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
read -r open open2 < "$T/ports"
closed=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
python3 -c '
import socket
u = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); u.bind(("127.0.0.1", 0)); print(u.getsockname()[1], flush=True)
while True:
    data, peer = u.recvfrom(512); u.sendto(data[:2] + b"\x81\x80" + data[4:], peer)' > "$T/udp" & upid=$!
n=0; while [ ! -s "$T/udp" ] && [ $n -lt 50 ]; do sleep 0.1; n=$((n + 1)); done
read -r udp < "$T/udp"
uout=$(bash "$SRC/desk/bin/runner-probe.sh" here "allow:127.0.0.1:$udp/udp" "deny:127.0.0.1:$closed/udp" "deny:127.0.0.1:$udp/udp" 2>&1); kill $upid 2>/dev/null
out=$(bash "$SRC/desk/bin/runner-probe.sh" here "deny:127.0.0.1:$closed" "allow:127.0.0.1:$open" "deny:127.0.0.1:$open2" \
  "allow:127.0.0.1:$closed" "deny:127.0.0.1:$((open2 - 2))-$((open2 + 2))" 2>&1); kill $lpid 2>/dev/null
check "probe: a closed deny is OK"                      '[[ "$out" == *"OK here deny 127.0.0.1:$closed (no connection)"* ]]'
check "probe: an open allow is OK"                      '[[ "$out" == *"OK here allow 127.0.0.1:$open (connected)"* ]]'
check "probe: an open deny is BAD"                      '[[ "$out" == *"BAD here deny 127.0.0.1:$open2 (connected)"* ]]'
check "probe: a closed allow is BAD"                    '[[ "$out" == *"BAD here allow 127.0.0.1:$closed (no connection)"* ]]'
check "probe: a range names the port that connected"    '[[ "$out" =~ "BAD here deny 127.0.0.1:$((open2 - 2))-$((open2 + 2)) (connected: "[0-9\ ]*"$open2" ]]'
check "probe: a UDP resolver that answers is reached"   '[[ "$uout" == *"OK here allow 127.0.0.1:$udp/udp (connected)"* ]] && [[ "$uout" == *"BAD here deny 127.0.0.1:$udp/udp (connected)"* ]]'
check "probe: UDP with no answer is not reached"        '[[ "$uout" == *"OK here deny 127.0.0.1:$closed/udp (no connection)"* ]]'
check "probe: results keep the order given, then DONE"  '[ "$(echo "$out" | grep -E "127.0.0.1" | awk "{print \$4}" | tr "\n" " ")" = "127.0.0.1:$closed 127.0.0.1:$open 127.0.0.1:$open2 127.0.0.1:$closed 127.0.0.1:$((open2 - 2))-$((open2 + 2)) " ] && [ "$(echo "$out" | tail -n 1)" = "DONE here" ]'
else
  echo "SKIP runner-probe.sh against local listeners: no timeout(1) here (it runs inside the Linux VM, and in CI)"
fi

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
