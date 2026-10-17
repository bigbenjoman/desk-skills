#!/usr/bin/env bash
# The isolation probes desk-runner verify-isolation runs inside the runner VM: once in its root shell
# and once in a container there. Never run on the Mac itself.
#   runner-probe.sh <where> <deny|allow>:<host>:<port|first-last|port/udp> ...
# A TCP port connects or not; <port>/udp sends a DNS query there and waits for any answer.
# Prints one line per probe, `OK|BAD <where> <expect> <target> (<detail>)`, then `DONE <where>`.
# A run with no DONE line did not finish, and desk-runner reads that as a failure.
set -u
where="${1:?usage: runner-probe.sh <where> <deny|allow>:<host>:<port|first-last|port/udp> ...}"; shift
line() { printf '%s %s %s %s (%s)\n' "$1" "$where" "$2" "$3" "$4"; }
connects() {
  case $2 in
    */udp) # a DNS query for the root's NS records; any reply byte means a resolver answered
      [ "$(timeout 3 bash -c "exec 3<>/dev/udp/$1/${2%/udp}; printf '\\x44\\x52\\x01\\x00\\x00\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x00\\x02\\x00\\x01' >&3; head -c 1 <&3" 2>/dev/null | wc -c)" -eq 1 ] ;;
    *) timeout 2 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null ;;
  esac
}

for path in /Users /mnt/mac; do
  if ls "$path" >/dev/null 2>&1; then line BAD deny "read:$path" "listable"; else line OK deny "read:$path" "not readable"; fi
done
shared=$(awk '$3 ~ /^(virtiofs|9p|fuse\.sshfs|nfs|nfs4|smbfs|cifs)$/ {print $2}' /proc/mounts 2>/dev/null | tr '\n' ' ')
if [ -n "$shared" ]; then line BAD deny mounts "host filesystems mounted: $shared"; else line OK deny mounts "no host filesystem mounted"; fi

# A blocked connection is dropped, so each probe waits out its timeout: run them 128 at a time.
# Each writes its result to its own file, so the output keeps the order given.
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
running=0
throttle() { running=$((running + 1)); [ "$running" -ge 128 ] && { wait; running=0; }; }
single() { # single <n> <expect> <host> <port>
  if connects "$3" "$4"; then got=allow; detail=connected; else got=deny; detail="no connection"; fi
  if [ "$got" = "$2" ]; then line OK "$2" "$3:$4" "$detail"; else line BAD "$2" "$3:$4" "$detail"; fi > "$work/$1"
}
n=0
for spec in "$@"; do
  n=$((n + 1)); expect=${spec%%:*}; rest=${spec#*:}; host=${rest%:*}; ports=${rest##*:}
  case $ports in
    *-*)
      mkdir "$work/$n.range"
      if command -v python3 >/dev/null 2>&1; then
        # 2000 connections at a time: every port of a host in about a minute, where bash takes 17.
        python3 - "$host" "${ports%-*}" "${ports#*-}" "$work/$n.range" <<'PY' || : > "$work/$n.range/sweep-failed"
import asyncio, os, sys
host, first, last, out = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
async def one(port, sem):
    async with sem:
        try:
            _, w = await asyncio.wait_for(asyncio.open_connection(host, port), 2)
            w.close(); open(os.path.join(out, str(port)), "w").close()
        except (OSError, asyncio.TimeoutError):
            pass
async def main():
    sem = asyncio.Semaphore(2000)
    await asyncio.gather(*(one(p, sem) for p in range(first, last + 1)))
asyncio.run(main())
PY
      else
        p=${ports%-*}
        while [ "$p" -le "${ports#*-}" ]; do
          { connects "$host" "$p" && : > "$work/$n.range/$p"; } &
          throttle; p=$((p + 1))
        done
      fi
      ;;
    *) single "$n" "$expect" "$host" "$ports" & throttle ;;
  esac
done
wait
n=0
for spec in "$@"; do
  n=$((n + 1)); rest=${spec#*:}; host=${rest%:*}; ports=${rest##*:}
  if [ -d "$work/$n.range" ]; then
    # A range is only ever a deny; any port that connected is named.
    hits=$(ls "$work/$n.range" | sort -n | tr '\n' ' ')
    if [ -f "$work/$n.range/sweep-failed" ]; then line BAD deny "$host:$ports" "the sweep did not run"
    elif [ -z "$hits" ]; then line OK deny "$host:$ports" "no port connected"
    else line BAD deny "$host:$ports" "connected: ${hits% }"; fi
  else
    cat "$work/$n"
  fi
done

if command -v curl >/dev/null 2>&1; then
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 https://registry.npmjs.org/ 2>&1)
  case $code in 2*|3*) line OK allow https://registry.npmjs.org "HTTP $code" ;; *) line BAD allow https://registry.npmjs.org "$code" ;; esac
fi
echo "DONE $where"
