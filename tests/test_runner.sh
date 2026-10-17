#!/usr/bin/env bash
# desk-runner against a stubbed tart (and stubbed softnet, sudo, ifconfig, lsof, route): the machine
# profile gates `up`, the VM is created once at the profile's sizes and started behind the Softnet
# block, isolation results are read from the probe's output, and status and down report the state.
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
run(){ : > "$T/tart.log"; out=$("$R" "$@" 2>&1); rc=$?; log=$(cat "$T/tart.log"); }

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
      "sudo -n sh -c "*) cat > "$v/probe.sh"; exit "${STUB_COPY_RC:-0}" ;;
      "sudo -n docker run "*) shift 11; printf '%s\n' "$@" > "$v/container-targets"; cat "$STUB_CONTAINER_OUT" ;;
      *) echo "stub tart: unexpected exec $*" >&2; exit 99 ;;
    esac ;;
  *) echo "stub tart: unexpected $cmd" >&2; exit 99 ;;
esac
EOF
printf '#!/bin/sh\necho softnet\n' > "$T/stub/softnet"
printf '#!/bin/sh\nexit "${STUB_SUDO_RC:-0}"\n' > "$T/stub/sudo"
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
  awk '$4 == "0A" {split($2, a, ":"); printf "py 3 b 3u IPv4 0x0 0t0 TCP *:%d (LISTEN)\n", ("0x" a[2]) + 0}' /proc/net/tcp /proc/net/tcp6
else
  /usr/sbin/lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR > 1'
fi
EOF
printf '#!/bin/sh\nprintf "   route to: default\\n    gateway: 192.168.4.1\\n"\n' > "$T/stub/route"
chmod +x "$T/stub/"*
export STUB_TART="$T/tart" PATH="$T/stub:$PATH"
[ "$(command -v tart)" = "$T/stub/tart" ] || { echo "FAIL the tart stub is not first on PATH"; exit 1; }
STUB_GUEST_OUT="$T/guest.out"; STUB_CONTAINER_OUT="$T/container.out"; export STUB_GUEST_OUT STUB_CONTAINER_OUT
probe_ok(){ printf 'OK %s deny 10.9.9.1:1-1024 (no port connected)\nOK %s allow registry.npmjs.org:443 (connected)\nDONE %s\n' "$1" "$1" "$1"; }
probe_ok guest > "$STUB_GUEST_OUT"; probe_ok container > "$STUB_CONTAINER_OUT"
profile(){ { printf '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n'; while [ $# -gt 0 ]; do printf '| `%s` | `%s` | %s |\n' "$1" "$2" "test"; shift 2; done; } > "$DESK_MACHINE"; }
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
check "guest set up: public resolvers, Docker"          'grep -q "use-dns: false" "$v/provision-script" && grep -q "docker.io" "$v/provision-script" && [ "$(cat "$v/provisioned")" = 1 ]'
check "the probe was copied into the guest"             'cmp -s "$v/probe.sh" "$SRC/desk/bin/runner-probe.sh"'
check "the pass is recorded"                            'read -r r _ < "$T/state/isolation.status"; [ "$r" = pass ]'

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

# ---- status and down (AC9) ----
run verify-isolation
run status
check "status: running, with the last result and age"   '[ $rc -eq 0 ] && [[ "$out" == *"desk-runner-test: running (8 CPUs, 24576 MB, 100 GB disk)"* ]] && [[ "$out" == *"isolation: pass, 0m ago"* ]]'
run down
check "down stops the VM, and its tart run is gone"     '[ $rc -eq 0 ] && [[ "$log" == *"stop desk-runner-test"* ]] && [ ! -f "$v/running" ] && [[ "$out" == *"nothing is left running"* ]] && ! pgrep -f "$T/stub/tart run desk-runner-test" >/dev/null'
run status
check "status after down: stopped, exit 1"              '[ $rc -eq 1 ] && [[ "$out" == *"stopped"* ]]'
run down
check "down when stopped: says so, exit 0"              '[ $rc -eq 0 ] && [[ "$out" == *"is not running"* ]] && [[ "$log" != *stop* ]]'
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
