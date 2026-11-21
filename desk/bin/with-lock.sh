#!/usr/bin/env bash
# Take a named box-wide lock, then run the command under it. Exists because workers are denied
# `flock <file> -c '<cmd>'`: the permission matcher will not auto-approve a wrapper that executes an
# inner command it cannot statically verify, even with Bash(flock:*) allowed. The denial is
# silent-ish and workers then run suites UNLOCKED, which is the whole OOM path this guards.
#   with-lock.sh test  <config §4 Unit tests command> <specs>   # at config §3b's test worker cap: 4, 2 while the spawn gate says hold
#   with-lock.sh tsc   <config §4 Typecheck command>
#   with-lock.sh browser <screenshot or image script>
#   with-lock.sh light <a suite §4 Suite weight calls light>  # what `test` becomes in such a repo
#   with-lock.sh browser -- node shot.mjs                     # a leading -- is dropped with or without --cwd
#   with-lock.sh test --cwd apps/api -- uv run pytest tests/x.py
#   with-lock.sh nolock --cwd portal -- pnpm dev              # a directory, no lock
#   with-lock.sh tsc --timeout 60 --cwd . -- pnpm typecheck   # give up waiting after 60 s: exit 75
# --cwd runs the command in that directory, relative to the root of the git worktree the caller is in:
# the form a §4 command item with a directory (`apps/api: uv run pytest`) takes, because `cd dir && …`
# is a compound command that neither the lock nor the worker allow-list can see into. The directory
# must be inside the worktree: a relative path, or an absolute one under the worktree root, never
# with `..`. The `--` after it is optional.
# An absolute directory may also be in another worktree of the same repository (the same git common
# directory), so a session whose shell sits in the main checkout can run a ticket worktree's command.
# The locks are box-wide on purpose, shared by every repo desk runs in: memory is per machine, not per repo.
#
# Uses flock(1) where it exists (Linux). Where it does not (stock macOS) it falls back to an atomic
# `mkdir` lock recording the wrapper's and the command's pids, so a crashed holder is detected and
# taken over instead of wedging the box. Both block with no timeout: waiting is the feature.
# --timeout <seconds> is only for a caller that must not wait (the committed pre-push hook): it bounds
# the wait for the lock, never the command, and exits 75 without running anything when it passes.
#
# The test lock has SLOTS: up to N commands hold it at once, each in a slot of its own. N is the
# machine profile's `test-lock-slots` row (DESK_TEST_LOCK_SLOTS wins over it), 1 without either, so
# a machine nobody sized keeps the old one-at-a-time lock. Slot 1 is the original lock path, so a
# command waiting under an older copy of this script still queues for it correctly. The browser lock
# is always one slot. Slots raise throughput; the profile keeps the memory bound.
#
# Each run also takes its slot as a lease from the machine's lease broker (slot-lease.mjs), so every
# holder on the machine is in `desk-env lease list` with where it runs and what. test and tsc share the
# heavy pool (a lint, which runs under `tsc`, is told apart and holds a `lint` slot); browser and light
# are a slot each. The slot kind's lever (desk-env lease mode slot) says how:
#   off     the lock files above, as before, and no lease.
#   shadow  the lock files above, waited on as before, and then a lease beside them that never holds
#           the command up: shadow logs a would-refuse where the pool was full.
#   on      the lease alone, waited for in place of the lock files. An unreadable store or a failing
#           broker falls back to the lock files, saying so once.
# The lease is owned by this script's pid, which execs into the command, or by the command's pid where
# the mkdir fallback runs it as a child, so it is held exactly as long as the command runs.
set -uo pipefail
# This script's own directory, taken before --cwd moves us: desk-env.mjs is installed beside it.
here="$(cd "$(dirname "$0")" && pwd -P)"
name="${1:?usage: with-lock.sh <test|tsc|browser|light|nolock> [--timeout <seconds>] [--cwd <dir> -- | --] <command...>}"; shift
# A repo whose §4 Suite weight is `light` runs its suites under the light lock instead: one slot of its
# own, box-wide, so a long light suite neither holds nor queues behind the heavy suites and typechecks
# that share the test lock. It runs again under that name, so the pass, which counts only `test` and
# `tsc` wrappers and the test lock's files (suite-wait.mjs), counts none of it. Typechecks stay heavy.
if [ "$name" = test ] && [ "$(node "$here/desk-env.mjs" get suite-weight 2>/dev/null)" = light ]; then
  exec bash "$here/with-lock.sh" light "$@"
fi
timeout=""
if [ "${1:-}" = "--timeout" ]; then
  case "${2:-}" in ''|*[!0-9]*) echo "with-lock.sh: --timeout needs a whole number of seconds" >&2; exit 2 ;; esac
  timeout="$2"; shift 2
fi
if [ "${1:-}" = "--cwd" ]; then
  [ "$#" -ge 3 ] || { echo "with-lock.sh: usage: with-lock.sh <lock> --cwd <dir> [--] <command...>" >&2; exit 2; }
  rel="$2"; shift 2
  [ "$1" = "--" ] && shift   # the separator is optional here too
  case "/$rel/" in
    */../*) echo "with-lock.sh: --cwd '$rel' must be a path inside the worktree, without .." >&2; exit 2 ;;
  esac
  [ -n "$rel" ] || { echo "with-lock.sh: --cwd needs a directory" >&2; exit 2; }
  top="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "with-lock.sh: --cwd needs to run inside a git worktree" >&2; exit 2; }
  # An absolute --cwd is accepted inside this worktree or another worktree of its repository (below).
  case "$rel" in /*) from="$rel" ;; *) from="$top/$rel" ;; esac
  target="$(cd "$from" 2>/dev/null && pwd -P)" || { echo "with-lock.sh: --cwd $rel does not exist under $top" >&2; exit 2; }
  real_top="$(cd "$top" && pwd -P)"
  case "$target/" in
    "$real_top"/*) ;;
    *)
      common() { (cd "$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P); }
      mine="$(common "$real_top")"; theirs=""
      case "$rel" in /*) git -C "$target" rev-parse --show-toplevel >/dev/null 2>&1 && theirs="$(common "$target")" ;; esac
      [ -n "$theirs" ] && [ "$theirs" = "$mine" ] || {
        echo "with-lock.sh: --cwd $target resolves outside this worktree ($real_top) and every other worktree of its repository" >&2; exit 2; } ;;
  esac
  cd "$target" || exit 2
elif [ "${1:-}" = "--" ]; then
  shift   # `with-lock.sh browser -- node x.mjs`: the separator is optional without --cwd
fi
[ "$#" -gt 0 ] || { echo "with-lock.sh: no command given" >&2; exit 2; }

dir="${DESK_LOCK_DIR:-/tmp}"
# `tsc` deliberately maps to the TEST lock, not a lock of its own. Separate locks let a suite (~3GB)
# and a typecheck (~3.5GB) run at the same time from two different workers, each correctly believing
# it was serialised, and OOM-kill a full suite. Typechecks queue behind suites.
case "$name" in
  test|tsc) lock="$dir/desk-test.lock" ;;
  browser)  lock="$dir/desk-browser.lock" ;;
  light)    lock="$dir/desk-light.lock" ;;
  # nolock: no lock at all, only --cwd. A §4 command item with a directory that is not heavy (a dev
  # server, a codegen) runs this way, because the worker allow-list has no `cd`.
  nolock)   lock="" ;;
  *) echo "with-lock.sh: unknown lock '$name'" >&2; exit 2 ;;
esac
[ -n "$lock" ] || exec "$@"
# The command knows it already runs inside a slot of this lock, so a script that takes a slot itself
# (tests/related.sh) does not wait for a second one behind its own.
export DESK_LOCK_HELD="$name"
gave_up() { echo "with-lock.sh: gave up waiting for the $name lock after ${timeout}s" >&2; exit 75; }
# Says once that this run waits, with the lock's state ($1) and, for the test and light locks, who holds
# it as suite-wait.mjs names them: where each holder runs, what, and for how long.
waiting() {
  local by=""
  case "$name" in
    test|tsc) by="$(node "$here/suite-wait.mjs" holders 2>/dev/null)" ;;
    light) by="$(node "$here/suite-wait.mjs" holders --light 2>/dev/null)" ;;
  esac
  echo "with-lock.sh: waiting for $name lock ($1)${by:+: $by}" >&2
}

# The slot lease. Anything but shadow or on, a failing node included, is off.
lease_mode="$(node "$here/slot-lease.mjs" mode 2>/dev/null)" || lease_mode=off
if [ "$lease_mode" = on ]; then
  if [ -n "$timeout" ]; then node "$here/slot-lease.mjs" take "$name" --pid "$$" --timeout "$timeout" -- "$@" </dev/null
  else node "$here/slot-lease.mjs" take "$name" --pid "$$" -- "$@" </dev/null; fi
  case $? in
    0) exec "$@" ;;
    75) exit 75 ;;
    *) lease_mode=off ;;   # it said why: the lock files below, as with the kind off
  esac
fi
# shadow_lease <owner pid> <command...>: in shadow, the lease beside the lock just taken. How it ends
# changes nothing here: the lock files are what this run waited on.
shadow_lease() {
  [ "$lease_mode" = shadow ] || return 0
  local owner="$1"; shift
  node "$here/slot-lease.mjs" take "$name" --pid "$owner" -- "$@" </dev/null >/dev/null 2>&1 || true
}

# How many commands may hold this lock at once.
slots=1
if [ "$name" = test ] || [ "$name" = tsc ]; then
  want="${DESK_TEST_LOCK_SLOTS:-}"
  # desk-env reads the profile as every other caller does; with no profile, row or node it prints
  # nothing and the lock keeps one slot.
  [ -n "$want" ] || want="$(node "$here/desk-env.mjs" machine get test-lock-slots 2>/dev/null)"
  case "$want" in ''|*[!0-9]*|0) ;; *) slots="$want" ;; esac
fi
# Slot i's lock path: slot 1 is the original path.
slot_path() { if [ "$1" -eq 1 ]; then echo "$lock"; else echo "$lock.$1"; fi; }
# Where flock's lock is taken and then exec'd into the command, record the command's pid (exec keeps
# it) beside slot $1, so a reader can tell the holder: the autopilot pass, telling a worker running its
# suite from a wedged one. The file outlives the holder; a reader checks the pid is still there.
holder() { echo "$$" > "$(slot_path "$1").pid" 2>/dev/null || true; }

if command -v flock >/dev/null 2>&1; then
  if [ "$slots" -eq 1 ]; then
    # The descriptor form, so a wait is said before it blocks, a timeout is told apart from the
    # command's own exit status, and a shadow lease is taken once the lock is held. The command
    # inherits fd 9, so the lock is held until it exits.
    exec 9>>"$lock" || exit 2
    if ! flock -n 9; then
      # A timeout of 0 is that one try: some flock builds (Homebrew's) refuse `-w 0`.
      [ "${timeout:-}" = 0 ] && gave_up
      waiting "held by pid $(cat "$lock.pid" 2>/dev/null || echo '?')"
      if [ -z "$timeout" ]; then flock 9 || exit 2; else flock -w "$timeout" 9 || gave_up; fi
    fi
    holder 1
    shadow_lease "$$" "$@"
    exec "$@"
  fi
  # Several slots: try each without blocking, and wait 2 s between rounds.
  waited=0
  while :; do
    i=1
    while [ "$i" -le "$slots" ]; do
      exec 9>>"$(slot_path "$i")" || exit 2
      flock -n 9 && { holder "$i"; shadow_lease "$$" "$@"; exec "$@"; }
      exec 9>&-
      i=$((i + 1))
    done
    [ -n "$timeout" ] && [ "$waited" -ge "$timeout" ] && gave_up
    [ "$waited" -eq 0 ] && waiting "all $slots slots held"
    waited=$((waited + 2))
    sleep 2
  done
fi

# ---- mkdir fallback ---------------------------------------------------------------------------
# An unwritable lock dir would make every mkdir fail and the loop below wait forever for a holder
# that does not exist. Refuse instead.
if [ ! -d "$dir" ] || [ ! -w "$dir" ]; then
  echo "with-lock.sh: lock directory $dir is missing or not writable (set DESK_LOCK_DIR) — not running unlocked" >&2
  exit 2
fi

alive() { local p; for p in "$@"; do kill -0 "$p" 2>/dev/null && return 0; done; return 1; }

# Take slot directory $1, clearing it first if its holder is dead. 0 = taken, 1 = held by a live one.
take() {
  local d="$1" holders stale grave
  while ! mkdir "$d" 2>/dev/null; do
    [ -d "$d" ] || { echo "with-lock.sh: cannot create $d" >&2; exit 2; }
    holders="$(cat "$d/pid" 2>/dev/null || true)"
    stale=""
    if [ -n "$holders" ]; then
      # shellcheck disable=SC2086
      alive $holders || stale=1
    elif [ -n "$(find "$d" -maxdepth 0 -mmin +1 2>/dev/null)" ]; then
      stale=1   # created but no pid written for over a minute: the taker died between the two steps
    fi
    [ -n "$stale" ] || { last_holders="$holders"; return 1; }
    # Rename first: mv of a directory is atomic, so exactly one taker wins and nobody deletes a
    # lock a faster taker has just re-created.
    grave="$d.stale.$$"
    if mv "$d" "$grave" 2>/dev/null; then rm -rf "$grave" 2>/dev/null || true; fi
  done
  return 0
}

waited=0
last_holders=""
ldir=""
while [ -z "$ldir" ]; do
  i=1
  while [ "$i" -le "$slots" ]; do
    d="$(slot_path "$i").d"   # distinct from flock's file so the two can never be confused
    if take "$d"; then ldir="$d"; break; fi
    i=$((i + 1))
  done
  [ -n "$ldir" ] && break
  [ -n "$timeout" ] && [ "$waited" -ge "$timeout" ] && gave_up
  if [ "$waited" -eq 0 ]; then
    if [ "$slots" -eq 1 ]; then waiting "held by pid ${last_holders:-?}"
    else waiting "all $slots slots held"; fi
  fi
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
# On INT/TERM, pass it on and keep holding the lock until the command has actually exited. Set before
# the shadow lease below, so a signal while it is taken still reaches the command.
on_signal() { kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; release; exit "$1"; }
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
# The shadow lease is the command's own, not this wrapper's: a SIGKILLed wrapper leaves it held.
shadow_lease "$child" "$@"
wait "$child"; rc=$?
release
exit "$rc"
