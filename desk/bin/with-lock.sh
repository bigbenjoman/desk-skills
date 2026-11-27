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
#   with-lock.sh install -- sh -c 'bun install'               # a dependency install, one at a time
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
# is always one slot. The light lock's slots are desk-env lightLockSlots (admission.mjs pool light):
# §3b "Light lock slots" of the repo whose run asks, else the profile's light-lock-slots, else 1, and 1
# while available memory is under the spawn gate's start. Slots raise throughput; the profile keeps
# the memory bound.
#
# Each run also takes its slot as a lease from the machine's lease broker (slot-lease.mjs), so every
# holder on the machine is in `desk-env lease list` with where it runs and what. test and tsc share the
# heavy pool (a lint, which runs under `tsc`, is told apart and holds a `lint` slot); browser and light
# are a slot each. The slot kind's lever (desk-env lease mode slot) says how:
#   off     the lock files above, as before, and no lease.
#   shadow  the lock files above, waited on as before, and then a lease beside them that never holds
#           the command up: shadow logs a would-refuse where the pool was full.
#   on      the lease alone, waited for in place of the lock files, in the broker's queue for its pool:
#           oldest first, the run told its place as it starts to wait and as it gives up, and a run
#           that gave up taking its place back when it asks again soon after with the same command.
#           A slot whose lock file a live run holds with no lease (an older wrapper) counts as held.
#           An unreadable store or a failing broker falls back to the lock files, saying so once.
# In every mode the grant line names the commit of the release that took the slot (`release`).
# The lease is owned by this script's pid, which execs into the command (on WSL into locked-run.mjs,
# which runs it as a child to measure it), or by the command's pid where the mkdir fallback runs it as
# a child, so it is held exactly as long as the command runs.
#
# Every wait is logged in the lease log (leases.mjs), in every mode: a queued line as a run starts to
# wait, then a grant line (the lease's own where a lease is taken) or a gave-up line, each with the
# class, the worktree, the seconds waited, how many other runs wait for the lock, and the load and
# memory then. A reading that fails is left empty rather than holding the command up. The command is
# told its lock and wait in DESK_LOCK_CLASS and DESK_LOCK_WAITED (tests/run.sh records them).
#
# A test, tsc or light run that waits is also judged by headroom admission (admission.mjs), under the
# machine profile's lock-admission row: shadow logs a would-admit or would-deny in the lease log for it
# as it starts to wait and whenever that changes; off, unset or a row that does not read logs nothing.
# Neither changes what is granted.
#
# With the row on, the pool's floor (test-lock-slots, light-lock-slots) is granted as above with no
# look at headroom, and a run that finds it full is let into a slot above it, up to the pool's ceiling
# (test-lock-max, light-lock-max), when admission.mjs grant admits it: the floor is tried every 2 s,
# headroom every DESK_ADMIT_RECHECK_S seconds (10). Slots above the floor are more of the same slot
# files, which an older copy of this script, counting only the floor, never takes. The run says once
# what it waits for and why, and again only when the reason changes, at most once a minute. Anything
# that cannot be read, the rows included, grants the floor alone. With the slot lease kind on, the
# broker's pool grows the same way (slot-lease.mjs).
#
# The light lock has an express lane where the machine profile's light-express-lane row is on: one
# slot of its own (desk-light.lock.express), outside light-lock-max, that only a run called with
# DESK_LIGHT_SMALL=1 may take, once it finds every pool slot it may take held. Its grant line names the
# lane, and headroom admission counts it as a recent admit at light-run-gb.
#
# With the machine profile's job-tokens row on, the light lock takes no slot at all: a run is bounded
# by the job tokens (job-token.mjs) it takes, one per suite for tests/run.sh, one for any other command.
#
# A granted run never outlives its caller: lock-caller-watch.mjs, started as the slot is granted, ends
# the run's process group (or, where the group holds anything else, the run and its descendants) once
# the caller that started it exits, so the lock is freed with it. A holder that escapes that (an older
# copy of this script) is named, and reclaimed under config §3 autopilot-reclaim, by the pass
# (lock-orphans.mjs).
set -uo pipefail
# This script's own directory, taken before --cwd moves us: desk-env.mjs is installed beside it.
here="$(cd "$(dirname "$0")" && pwd -P)"
name="${1:?usage: with-lock.sh <test|tsc|browser|light|install|nolock>[--timeout <seconds>] [--cwd <dir> -- | --] <command...>}"; shift
# A repo whose §4 Suite weight is `light` runs its suites under the light lock instead: slots of its
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
  # install: one slot, never a lease or headroom admission, so dependency installs (worktree setup,
  # the base gate, the baseline) run one at a time machine-wide without queueing behind a suite.
  install)  lock="$dir/desk-install.lock" ;;
  *) echo "with-lock.sh: unknown lock '$name'" >&2; exit 2 ;;
esac
[ -n "$lock" ] || exec "$@"
# A Jest or `turbo run` the command starts gets the test cap or turbo-concurrency added
# (locked-run.mjs bound), unless it sets its own. A node that fails leaves the command as given.
case "$name" in test|tsc|light)
  bounded=(); nb=0
  while IFS= read -r -d '' x; do bounded+=("$x"); nb=$((nb + 1)); done < <(node "$here/locked-run.mjs" bound "$name" -- "$@" </dev/null)
  [ "$nb" -gt 0 ] && set -- "${bounded[@]}" ;;
esac
# On WSL a test or tsc run is measured: its command runs as locked-run.mjs's child, which logs the
# guest's memory peak once it exits (DESK_RUN_PEAK=on or off overrides the kernel check).
measure=()
case "$name" in test|tsc)
  peak="${DESK_RUN_PEAK:-}"
  [ -n "$peak" ] || { grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null && peak=on; }
  [ "$peak" = on ] && measure=(node "$here/locked-run.mjs" run "$name" --) ;;
esac
# A measured run's locked-run.mjs hands fd 9 on to the command only when this shell holds it (flock).
run_cmd() {
  if [ -n "${measure[*]+x}" ] && { : >&9; } 2>/dev/null; then export DESK_RUN_FD9=1; else unset DESK_RUN_FD9; fi
  exec ${measure[@]+"${measure[@]}"} "$@"
}
# An autopilot worker's test run keeps its temporary files on disk, never in a tmpfs /tmp: its TMPDIR is
# a folder of its own in the repo's cache folder (spawn-worker.sh), named by this pid, which the command
# keeps, so a later run removes it once that pid is gone. In it, Jest's default cache (jest_<uid in base
# 36>) links to the cache folder's jest, so it outlives the run; CDK synth output and every other
# temporary folder is the run's own.
if [ "${DESK_AUTOPILOT_WORKER:-}" = 1 ] && { [ "$name" = test ] || [ "$name" = light ]; } && [ -d "${DESK_CACHE_DIR:-}/runs" ]; then
  runs="$DESK_CACHE_DIR/runs"
  for d in "$runs"/*; do
    p="${d##*/}"
    case "$p" in ''|*[!0-9]*) continue ;; esac
    [ -d "$d" ] && ! kill -0 "$p" 2>/dev/null && rm -rf "$d" 2>/dev/null
  done
  uid=$(id -u 2>/dev/null); b36=""; digits=0123456789abcdefghijklmnopqrstuvwxyz
  case "$uid" in ''|*[!0-9]*) ;; *)
    while :; do b36="${digits:$((uid % 36)):1}$b36"; uid=$((uid / 36)); [ "$uid" -gt 0 ] || break; done ;;
  esac
  if mkdir -p "$runs/$$" 2>/dev/null; then
    [ -z "$b36" ] || ln -sfn "$DESK_CACHE_DIR/jest" "$runs/$$/jest_$b36" 2>/dev/null
    export TMPDIR="$runs/$$"
  fi
fi
# Once granted, the run ends when its caller does (lock-caller-watch.mjs, in the background with the
# lock's descriptor and its output closed), so a run whose worker died cannot keep the lock. A run
# inside another locked run (DESK_LOCK_HELD already set) ends with that one, and starts no watch.
outer="${DESK_LOCK_HELD:-}"; watching=""
watch_caller() {
  [ -z "$outer" ] && [ -z "$watching" ] || return 0
  watching=1
  # Started from /, never from the run's directory: the watch outlives the run by up to a poll, and a
  # process working in a worktree holds it (pass.mjs busyWorktree), so a pass's own spec run in a
  # child's worktree would keep the next pass from spawning there (issue #1636).
  (cd / && exec node "$here/lock-caller-watch.mjs" "$$") 9>&- </dev/null >/dev/null 2>&1 &
}
# The command knows it already runs inside a slot of this lock, so a script that takes a slot itself
# (tests/related.sh) does not wait for a second one behind its own.
export DESK_LOCK_HELD="$name"
# Whether the caller says this run is small (the express lane, below). The command is not told: a run
# it starts is sized by whoever starts it.
small="${DESK_LIGHT_SMALL:-}"
unset DESK_LIGHT_SMALL

# With the machine profile's job-tokens row on (job-token.mjs lever), a light run holds no light slot:
# the job tokens it takes bound it instead, so a long run holds back only the tokens its suites use. A
# command inside a suite (TEST_JOB_TOKENS=held) runs at once on that suite's token. Any other command
# first takes one token, owned by this pid, which execs into it, waiting in the job pool's queue (up to
# --timeout, exiting 75 having run nothing). A tests/run.sh with job-token.mjs in the desk/bin beside it
# takes one for each suite itself, so it gives that first token back as it starts: the take is only its
# admission, which keeps --timeout's bound and proves the broker answers. Any other command keeps its
# token while it runs, and is told TEST_JOB_TOKENS=held so a run.sh it starts takes none. Neither waits
# on the lock files nor logs a light grant. A token the broker cannot give (an unreadable lease store, a
# failing broker) falls back to the light slot below, so a run is never left with neither.
# The script a command runs: its first word past an `env`, VAR=value words and a shell's options.
script_of() {
  [ "${1##*/}" = env ] && shift
  while [ "$#" -gt 0 ]; do case "$1" in [A-Za-z_]*=*) shift ;; *) break ;; esac; done
  case "${1##*/}" in
    bash|sh|zsh|dash)
      shift
      while [ "$#" -gt 0 ]; do case "$1" in -c) return 0 ;; -*) shift ;; *) break ;; esac; done ;;
  esac
  printf '%s\n' "${1:-}"
}
if [ "$name" = light ] && [ "$(node "$here/job-token.mjs" lever 2>/dev/null)" = on ]; then
  if [ "${TEST_JOB_TOKENS:-}" = held ]; then export DESK_LOCK_CLASS="$name" DESK_LOCK_WAITED=0; exec "$@"; fi
  script="$(script_of "$@")"
  per_suite=""
  [ "${script##*/}" = run.sh ] && [ -f "$(dirname "$script")/../desk/bin/job-token.mjs" ] && per_suite=1
  t0=$SECONDS
  # The whole command is the token's label and its place's identity in the queue, so two commands in
  # one worktree never take each other's place back.
  token="$(node "$here/job-token.mjs" take --pid "$$" --worktree "$(pwd -P)" --as with-lock.sh ${timeout:+--timeout "$timeout"} -- "$*" </dev/null)"
  case $? in
    0) if [ -n "$token" ]; then
         export DESK_LOCK_CLASS="$name" DESK_LOCK_WAITED="$((SECONDS - t0))"
         # Given back before run.sh's suites ask for theirs. A release that fails leaves it held by this
         # pid, run.sh once it execs, where a suite could wait on it until run.sh ends: so run.sh then
         # takes none, and runs in the light slot below, as with the row off.
         watch_caller
         [ -n "$per_suite" ] && node "$here/job-token.mjs" release "$token" --pid "$$" >/dev/null </dev/null && exec "$@"
         export TEST_JOB_TOKENS=held
         [ -n "$per_suite" ] || exec "$@"
       fi ;;
    # The line every lock's give-up prints, which the pre-push hook reads as the box being busy.
    75) echo "with-lock.sh: gave up waiting for the $name lock after ${timeout}s (no job token came free)" >&2; exit 75 ;;
  esac
fi
# The run's wait on the lock files: queued once it starts to wait, when its marker (named by this pid)
# sits in the lock's waiting directory, which slot-lease.mjs counts as the queue. A run granted at its
# first try waited 0 seconds.
case "$name" in test|tsc) wdir="$dir/desk-test.waiting" ;; *) wdir="$dir/desk-$name.waiting" ;; esac
queued=""; w=""
waited_s() { if [ -n "$w" ]; then echo "$w"; elif [ -n "$queued" ]; then echo $((SECONDS - t0)); else echo 0; fi; }
# Logs this run's queued, grant or gave-up line ($1), saying nothing whatever happens.
note() { node "$here/slot-lease.mjs" note "$1" "$name" --pid "$$" --waited "$(waited_s)" ${lane:+--lane "$lane"} </dev/null >/dev/null 2>&1 || true; }
# This wrapper's process start time as leases.mjs startTimes reads it and admit-ledger.mjs startStamp
# writes it (/proc's starttime, else ps's lstart in UTC), which the marker holds so a reader tells a
# later process given its pid from it; empty where it does not read.
start_stamp() {
  local s
  if [ -r "/proc/$$/stat" ]; then
    s="$(cat "/proc/$$/stat" 2>/dev/null)"; s="${s##*) }"
    # shellcheck disable=SC2086
    set -- $s; printf '%s' "${20:-}"
  else
    s="$(LC_ALL=C TZ=UTC0 ps -o lstart= -p "$$" 2>/dev/null)"
    # shellcheck disable=SC2086
    set -- $s; local IFS=_; printf '%s' "$*"
  fi
}
queue() { queued=1; mkdir -p "$wdir" 2>/dev/null && start_stamp > "$wdir/$$" 2>/dev/null; note queued; }
unqueue() { [ -z "$queued" ] || rm -f "$wdir/$$" 2>/dev/null; }
gave_up() { unwatch; unqueue; note gave-up; echo "with-lock.sh: gave up waiting for the $name lock after ${timeout}s" >&2; exit 75; }
# Headroom admission's look at this run while it waits (admission.mjs watch): in the background, so the
# wait itself is unchanged. It judges the run once its marker is in the waiting directory, which it is
# from the moment it waits on the lock files or on a lease, and again while it waits, logging a line
# only when the outcome or reason changes. It is node, never a forked shell: a subshell keeps this
# wrapper's command line, and suite-wait.mjs would count it as a second run waiting. It closes the lock's
# descriptor, so it never holds the lock, and it is stopped before the command runs.
admit_pid=""
watch_admission() {
  case "$name" in test|tsc|light) ;; *) return 0 ;; esac
  node "$here/admission.mjs" watch "$name" --pid "$$" --marker "$wdir/$$" 9>&- </dev/null >/dev/null 2>&1 &
  admit_pid=$!
}
unwatch() { [ -z "$admit_pid" ] || kill "$admit_pid" 2>/dev/null; admit_pid=""; }
# The run holds its lock: it waits no longer, and its command is told which lock and how long it waited.
held() { unwatch; unqueue; w="$(waited_s)"; export DESK_LOCK_CLASS="$name" DESK_LOCK_WAITED="$w"; }
# Says once that this run waits, with the lock's state ($1) and, for the test and light locks, who holds
# it as suite-wait.mjs names them (slot-lease.mjs holders): where each holder runs, what, and for how long.
waiting() {
  queue
  watch_admission
  say_waiting "$1"
}
say_waiting() {
  local by=""
  case "$name" in
    test|tsc) by="$(node "$here/slot-lease.mjs" holders 2>/dev/null)" ;;
    light) by="$(node "$here/slot-lease.mjs" holders --light 2>/dev/null)" ;;
  esac
  echo "with-lock.sh: waiting for $name lock ($1)${by:+: $by}" >&2
}

# The slot lease. Anything but shadow or on, a failing node included, is off.
lease_mode="$(node "$here/slot-lease.mjs" mode 2>/dev/null)" || lease_mode=off
[ "$name" = install ] && lease_mode=off
# The light lock's express lane: one slot of its own, a lock file outside light-lock-max and never
# gated on headroom, for a run its caller says is small (DESK_LIGHT_SMALL=1, as tests/related.sh does)
# where the machine profile's light-express-lane row is on. Such a run takes a pool slot it may have
# first, and the lane only when there is none; a run not called small never takes it. Its lock is named
# as a light slot, so the lock's holder readers (suite-wait.mjs) count its holder. With the slot lease
# kind on, the broker takes the lane's lock directory once the pool refuses the run (exit 10).
express=""; lane=""; elock="$dir/desk-light.lock.express"
if [ "$name" = light ] && [ "$small" = 1 ] \
  && [ "$(node "$here/desk-env.mjs" machine get light-express-lane 2>/dev/null)" = on ]; then
  express=1
fi
# Says, once, that a small run found the pool's slots held and takes the express lane instead.
took_express() { lane=express; echo "with-lock.sh: all $name slots it may take are held, so this small run takes the express lane" >&2; }
# granted <owner pid> <command...>: logs the grant of the lock just taken. In shadow that is the lease
# taken beside it, whose grant line carries the wait; one that fails is logged as with the kind off. How
# the lease ends changes nothing here: the lock files are what this run waited on.
granted() {
  local owner="$1"; shift
  # An express-lane grant takes no lease, which would draw on the light pool it sits outside: its grant
  # line names the lane, and admission's ledger counts it as a recent admit.
  if [ -n "$lane" ]; then
    node "$here/admission.mjs" express "$name" --pid "$owner" </dev/null >/dev/null 2>&1 || true
    note grant; return 0
  fi
  if [ "$lease_mode" = shadow ] && node "$here/slot-lease.mjs" take "$name" --pid "$owner" --waited "$w" -- "$@" </dev/null >/dev/null 2>&1; then return 0; fi
  note grant
}
t0=$SECONDS
if [ "$lease_mode" = on ]; then
  # The lease's own queued, grant and gave-up lines carry this run's wait. A wait for the lease holds
  # the same marker as one on the lock files, so admission looks at it the same way.
  watch_admission
  if [ -n "$timeout" ]; then node "$here/slot-lease.mjs" take "$name" --pid "$$" --timeout "$timeout" ${express:+--express "$elock.d"} -- "$@" </dev/null
  else node "$here/slot-lease.mjs" take "$name" --pid "$$" ${express:+--express "$elock.d"} -- "$@" </dev/null; fi
  rc=$?
  unwatch
  case $rc in
    0) export DESK_LOCK_CLASS="$name" DESK_LOCK_WAITED="$((SECONDS - t0))"; watch_caller; run_cmd "$@" ;;
    10) w=$((SECONDS - t0)); took_express; granted "$$" "$@"; export DESK_LOCK_CLASS="$name" DESK_LOCK_WAITED="$w"; watch_caller; run_cmd "$@" ;;
    75) exit 75 ;;
    *) lease_mode=off; t0=$SECONDS ;;   # it said why: the lock files below, as with the kind off
  esac
fi

# How many commands may hold this lock at once.
slots=1
if [ "$name" = test ] || [ "$name" = tsc ]; then
  want="${DESK_TEST_LOCK_SLOTS:-}"
  # desk-env reads the profile as every other caller does; with no profile, row or node it prints
  # nothing and the lock keeps one slot.
  [ -n "$want" ] || want="$(node "$here/desk-env.mjs" machine get test-lock-slots 2>/dev/null)"
  case "$want" in ''|*[!0-9]*|0) ;; *) slots="$want" ;; esac
fi
# Headroom admission on (admission.mjs pool prints `on <floor> <ceiling>`): `slots` is the floor, and
# the slots from there to `ceiling` are taken only on an admit. A ceiling at the floor has no slot to
# admit to, so the lock is today's. Anything else leaves it off.
admit_on=""; ceiling="$slots"
case "$name" in
  test|tsc|light)
    read -r amode afloor aceil <<<"$(node "$here/admission.mjs" pool "$name" 2>/dev/null)"
    case "${afloor:-}${aceil:-}" in ''|*[!0-9]*) ;; *)
      if [ "$afloor" -ge 1 ] && [ "$aceil" -ge "$afloor" ]; then
        if [ "${amode:-}" = on ]; then
          slots="$afloor"; ceiling="$aceil"
          [ "$aceil" -gt "$afloor" ] && admit_on=1
        elif [ "$name" = light ]; then
          # The light floor is desk-env lightLockSlots whatever the admission mode.
          slots="$afloor"; ceiling="$afloor"
        fi
      fi ;;
    esac ;;
esac
recheck="${DESK_ADMIT_RECHECK_S:-10}"
# A leading zero is refused too: bash reads 08 as octal, and the arithmetic error would end the wait.
case "$recheck" in ''|*[!0-9]*|0*) recheck=10 ;; esac
# One look at headroom (admission.mjs grant), as the run starts to wait and every `recheck` seconds
# after: 0 when it is let in above the floor (admitted). It prints the waiting line grant gives it as
# grant says (the first, then a new reason at most once a minute), or the plain one where grant says
# nothing.
admitted=""; akey=""; said=""; said_at=""
admit_check() {
  local line k say at text
  line="$(node "$here/admission.mjs" grant "$name" --pid "$$" ${akey:+--last "$akey"} ${said:+--said "$said" --said-at "$said_at"} </dev/null 2>/dev/null)"
  IFS=$'\t' read -r k say at text <<<"$line"
  if [ -z "$k" ]; then
    [ -n "$said" ] || { said=plain; say_waiting "all $slots slots held"; }
    return 1
  fi
  akey="$k"
  case "$k" in admit:*) admitted=1; return 0 ;; esac
  [ "$say" = 1 ] && { echo "with-lock.sh: $text" >&2; said="$k"; said_at="$at"; }
  return 1
}
# Where the run waits on the lock files with admission on: its first look marks it queued.
admit_round() {
  [ -n "$admit_on" ] && [ -z "$admitted" ] && [ "$waited" -ge "$next_check" ] || return 1
  [ "$waited" -eq 0 ] && queue
  next_check=$((waited + recheck))
  admit_check
}
next_check=0
# Slot i's lock path: slot 1 is the original path.
slot_path() { if [ "$1" -eq 1 ]; then echo "$lock"; else echo "$lock.$1"; fi; }
# The slots a round tries, in order: the floor's; a run let in above the floor tries the slots above it
# first, so it holds the one its admit counts, and the floor's after.
slot_order() {
  local i
  if [ -n "$admitted" ]; then i=$((slots + 1)); while [ "$i" -le "$ceiling" ]; do echo "$i"; i=$((i + 1)); done; fi
  i=1; while [ "$i" -le "$slots" ]; do echo "$i"; i=$((i + 1)); done
}
# Where flock's lock is taken and then exec'd into the command, record the command's pid (exec keeps
# it) beside slot $1, so a reader can tell the holder: the autopilot pass, telling a worker running its
# suite from a wedged one. The file outlives the holder; a reader checks the pid is still there.
holder() { echo "$$" > "$(slot_path "$1").pid" 2>/dev/null || true; }
held_text() { if [ -n "$express" ]; then echo "all $slots slots and the express lane held"; else echo "all $slots slots held"; fi; }

if command -v flock >/dev/null 2>&1; then
  if [ "$slots" -eq 1 ] && [ -z "$admit_on" ] && [ -z "$express" ]; then
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
    held; granted "$$" "$@"
    watch_caller
    run_cmd "$@"
  fi
  # Several slots, or admission on: try each without blocking, and wait 2 s between rounds. A run let
  # in above the floor tries every slot up to the ceiling (slot_order), at once and then each round.
  waited=0
  while :; do
    for i in $(slot_order); do
      exec 9>>"$(slot_path "$i")" || exit 2
      flock -n 9 && { holder "$i"; held; granted "$$" "$@"; watch_caller; run_cmd "$@"; }
      exec 9>&-
    done
    admit_round && continue
    if [ -n "$express" ]; then
      exec 9>>"$elock" || exit 2
      flock -n 9 && { echo "$$" > "$elock.pid" 2>/dev/null; took_express; held; granted "$$" "$@"; watch_caller; run_cmd "$@"; }
      exec 9>&-
    fi
    [ -n "$timeout" ] && [ "$waited" -ge "$timeout" ] && gave_up
    [ "$waited" -eq 0 ] && [ -z "$admit_on" ] && waiting "$(held_text)"
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
  for i in $(slot_order); do
    d="$(slot_path "$i").d"   # distinct from flock's file so the two can never be confused
    if take "$d"; then ldir="$d"; break; fi
  done
  [ -n "$ldir" ] && break
  admit_round && continue
  if [ -n "$express" ] && take "$elock.d"; then ldir="$elock.d"; took_express; break; fi
  [ -n "$timeout" ] && [ "$waited" -ge "$timeout" ] && gave_up
  if [ "$waited" -eq 0 ] && [ -z "$admit_on" ]; then
    if [ "$slots" -eq 1 ] && [ -z "$express" ]; then waiting "held by pid ${last_holders:-?}"
    else waiting "$(held_text)"; fi
  fi
  waited=$((waited + 2))
  sleep 2
done

echo "$$" > "$ldir/pid"
release() { rm -rf "$ldir" 2>/dev/null || true; }
held

# Run the command as a child (explicit <&0: a background job would otherwise get /dev/null) and
# record its pid beside ours, so the lock counts as held while either is alive — a SIGKILLed wrapper
# must not free the lock under a suite that is still running.
${measure[@]+"${measure[@]}"} "$@" <&0 &
child=$!
echo "$$ $child" > "$ldir/pid"
watch_caller
# On INT/TERM, pass it on and keep holding the lock until the command has actually exited. Set before
# the shadow lease below, so a signal while it is taken still reaches the command.
on_signal() { kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null; release; exit "$1"; }
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
# The shadow lease is the command's own, not this wrapper's: a SIGKILLed wrapper leaves it held.
granted "$child" "$@"
wait "$child"; rc=$?
release
exit "$rc"
