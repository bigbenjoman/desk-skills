#!/usr/bin/env bash
# Take a named box-wide lock, then run the command under it. Exists because workers are denied
# `flock <file> -c '<cmd>'`: the permission matcher will not auto-approve a wrapper that executes an
# inner command it cannot statically verify, even with Bash(flock:*) allowed. The denial is
# silent-ish and workers then run suites UNLOCKED, which is the whole OOM path this guards.
#   with-lock.sh test  <config §4 Unit tests command> <specs>   # at config §3b's test worker cap: 4, 2 while the spawn gate says hold
#   with-lock.sh tsc   <config §4 Typecheck command>
#   with-lock.sh browser <screenshot capture>
# The locks are box-wide on purpose, shared by every repo desk runs in: memory is per machine, not per repo.
#
# Uses flock(1) where it exists (Linux). Where it does not (stock macOS) it falls back to an atomic
# `mkdir` lock recording the wrapper's and the command's pids, so a crashed holder is detected and
# taken over instead of wedging the box. Both block with no timeout: waiting is the feature.
set -uo pipefail
name="${1:?usage: with-lock.sh <test|tsc|browser> <command...>}"; shift
[ "$#" -gt 0 ] || { echo "with-lock.sh: no command given" >&2; exit 2; }

dir="${DESK_LOCK_DIR:-/tmp}"
# `tsc` deliberately maps to the TEST lock, not a lock of its own. Separate locks let a suite (~3GB)
# and a typecheck (~3.5GB) run at the same time from two different workers, each correctly believing
# it was serialised, and OOM-kill a full suite. Typechecks queue behind suites.
case "$name" in
  test|tsc) lock="$dir/desk-test.lock" ;;
  browser)  lock="$dir/desk-browser.lock" ;;
  *) echo "with-lock.sh: unknown lock '$name'" >&2; exit 2 ;;
esac

if command -v flock >/dev/null 2>&1; then
  exec flock "$lock" "$@"
fi

# ---- mkdir fallback ---------------------------------------------------------------------------
# An unwritable lock dir would make every mkdir fail and the loop below wait forever for a holder
# that does not exist. Refuse instead.
if [ ! -d "$dir" ] || [ ! -w "$dir" ]; then
  echo "with-lock.sh: lock directory $dir is missing or not writable (set DESK_LOCK_DIR) — not running unlocked" >&2
  exit 2
fi

ldir="$lock.d"   # distinct from flock's file so the two can never be confused
alive() { local p; for p in "$@"; do kill -0 "$p" 2>/dev/null && return 0; done; return 1; }

waited=0
while ! mkdir "$ldir" 2>/dev/null; do
  [ -d "$ldir" ] || { echo "with-lock.sh: cannot create $ldir" >&2; exit 2; }
  # shellcheck disable=SC2046
  holders="$(cat "$ldir/pid" 2>/dev/null || true)"
  stale=""
  if [ -n "$holders" ]; then
    # shellcheck disable=SC2086
    alive $holders || stale=1
  elif [ -n "$(find "$ldir" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
    stale=1   # created but no pid written for over a minute: the taker died between the two steps
  fi
  if [ -n "$stale" ]; then
    # Rename first: mv of a directory is atomic, so exactly one taker wins and nobody deletes a
    # lock a faster taker has just re-created.
    grave="$ldir.stale.$$"
    if mv "$ldir" "$grave" 2>/dev/null; then rm -rf "$grave" 2>/dev/null || true; fi
    continue
  fi
  if [ "$waited" -eq 0 ]; then echo "with-lock.sh: waiting for $name lock (held by pid ${holders:-?})" >&2; fi
  waited=$((waited + 2))
  sleep 2
done

echo "$$" > "$ldir/pid"
release() { rm -rf "$ldir" 2>/dev/null || true; }

# Run the command as a child (explicit <&0: a background job would otherwise get /dev/null) and
# record its pid beside ours, so the lock counts as held while either is alive — a SIGKILLed wrapper
# must not free the lock under a suite that is still running.
"$@" <&0 &
child=$!
echo "$$ $child" > "$ldir/pid"
# On INT/TERM, pass it on and keep holding the lock until the command has actually exited.
on_signal() { kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; release; exit "$1"; }
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
wait "$child"; rc=$?
release
exit "$rc"
