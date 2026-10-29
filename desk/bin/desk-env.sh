# shellcheck shell=bash
# Shared resolver for the desk/bin shell scripts. Source it:
#   . "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/desk-env.sh"
#
# Config parsing and the id -> config row map live in desk-env.mjs (one parser, one map); this
# file wraps it and adds the portable shell helpers, so Linux, WSL and macOS differ in these two
# files and nowhere else. Resolution order everywhere: environment variable -> config -> default.
# Identity-shaped values (GitHub handle, Jira name, repo root) have no default and fail loudly.

DESK_ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESK_ENV_MJS="$DESK_ENV_DIR/desk-env.mjs"

command -v node >/dev/null 2>&1 || { echo "desk: node is required and is not on PATH" >&2; return 1 2>/dev/null || exit 1; }

desk_cfg()  { node "$DESK_ENV_MJS" get "$1"; }    # desk_cfg <config id>      (exit 3 if unset)
desk_perm() { node "$DESK_ENV_MJS" perm "$1"; }   # desk_perm <permission id> -> yes|ask|no|never|stop
desk_budget() { node "$DESK_ENV_MJS" budget "$1"; } # desk_budget worker|batch -> <usd>|none (exit 4 if malformed)

# desk_where: exports DESK_SLUG_WHERE, DESK_CONFIG_PATH, DESK_CREDS for the cwd's repo; fails outside one.
desk_where() {
  local out
  out="$(node "$DESK_ENV_MJS" where)" || { echo "desk: not inside a git repo; no repo config to use" >&2; return 1; }
  eval "$out"
  DESK_SLUG_WHERE="$SLUG" DESK_CONFIG_PATH="$CONFIG" DESK_CREDS="$CREDS"
  export DESK_SLUG_WHERE DESK_CONFIG_PATH DESK_CREDS
  [ "$EXISTS" = yes ] || { echo "desk: no config for $SLUG at $CONFIG. Run /desk-setup in this repo." >&2; return 1; }
}

# desk_take_batch "$@": takes `--batch <name>` (or `--batch=<name>`) out of the arguments, up to a bare
# `--`, through desk-env.mjs's takeBatchArg, and exports it as DESK_BATCH so this script and every child
# act on that batch. The other arguments are left in DESK_ARGS, in order; follow with
#   set -- ${DESK_ARGS[@]+"${DESK_ARGS[@]}"}
# A missing name, or two different names from either source, fails with exit 4 and nothing exported.
desk_take_batch() {
  local out
  out="$(node "$DESK_ENV_MJS" take-batch "$@")" || return 4
  eval "$out"
}

# Autopilot entry points only (triage.sh, merge-driver.sh; pass.mjs does the same in node): export
# the queue's batch base as DESK_DEFAULT_BRANCH before desk_load_paths, so this process and every
# child targets it. No base set is a no-op. An unreadable base, or one contradicting an
# already-exported DESK_DEFAULT_BRANCH, fails: falling back to the config's default would send the
# batch's work to the wrong branch silently. See batchBase() in desk-env.mjs.
desk_apply_batch_base() {
  local b rc
  b="$(node "$DESK_ENV_MJS" batch-base)"; rc=$?
  [ "$rc" = 3 ] && return 0
  [ "$rc" = 0 ] && [ -n "$b" ] || { echo "desk: could not read the batch base from the queue (exit $rc)" >&2; return 1; }
  if [ -n "${DESK_DEFAULT_BRANCH:-}" ] && [ "$DESK_DEFAULT_BRANCH" != "$b" ]; then
    echo "desk: DESK_DEFAULT_BRANCH=$DESK_DEFAULT_BRANCH contradicts the batch base $b. Unset one; refusing to guess." >&2
    return 1
  fi
  export DESK_DEFAULT_BRANCH="$b"
}

# Sets and exports each `KEY='value'` line of desk-env.mjs output, so the keys are named only there.
desk_export_assigned() {
  local k
  eval "$1"
  while IFS= read -r k; do
    if [ -n "$k" ]; then export "${k?}"; fi
  done <<EOF
$(printf '%s\n' "$1" | sed -n 's/^\([A-Z_][A-Z0-9_]*\)=.*/\1/p')
EOF
}

# Exports every value `desk-env.mjs paths` prints (DESK_REPO_ROOT, DESK_DEFAULT_BRANCH, DESK_STATE,
# DESK_QUEUE and the rest). Fails (non-zero) with the resolver's message if the repo root is unset.
desk_load_paths() {
  local out
  out="$(node "$DESK_ENV_MJS" paths)" || return 1
  desk_export_assigned "$out"
}

# Exports DESK_GITHUB_HANDLE and DESK_JIRA_NAME, or fails loudly.
desk_load_identity() {
  local out
  out="$(node "$DESK_ENV_MJS" identity)" || return 1
  desk_export_assigned "$out"
}

# Headless `claude -p` needs the grant before it launches, because it cannot ask.
#   desk_require_headless          a detached worker: `yes`, or `ask` with AUTOPILOT_USER_APPROVED=1
#   desk_require_headless triage   a read-only, foreground triage pass: `yes` or `ask`. The batch is
#                                    confirmed once, at Stage 3, before any worker spawns; triage runs
#                                    first so that one question round has something to ask about.
desk_require_headless() {
  local p mode="${1:-worker}" key
  key="$(node "$DESK_ENV_MJS" key autopilot-workers)"
  p="$(desk_perm autopilot-workers)"
  case "$p" in
    yes) return 0 ;;
    ask) [ "$mode" = triage ] && return 0
         [ -n "${AUTOPILOT_USER_APPROVED:-}" ] && return 0
         echo "FAIL: config §3 $key is ask — confirm this batch with the user, then export AUTOPILOT_USER_APPROVED=1" >&2 ;;
    *)   echo "FAIL: config §3 $key is $p — refusing to launch a headless claude -p. Run /desk-setup to change it." >&2 ;;
  esac
  return 1
}

# timeout(1) is GNU coreutils: absent on stock macOS. gtimeout (brew coreutils), then a perl alarm.
# On timeout every one kills the command's whole process group, TERM then KILL 2s later, so a child
# the command started (docker exec under a wrapper, a shell's pipeline) does not outlive it. 124 on
# timeout (137 from timeout(1) when the command outlived the TERM), otherwise the command's own
# status (128+n when a signal ended it).
desk_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout -k 2 "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout -k 2 "$secs" "$@"
  else desk_timeout_perl "$secs" "$@"
  fi
}

# The fallback, separate so a test can run it where timeout(1) exists. The command leads its own
# process group (set on both sides of the fork, so an early kill still finds it), and INT, TERM and
# HUP sent to this wrapper are passed on to that group, as timeout(1) does. A command those end
# exits 128+n, not 0, so a forwarded Ctrl-C never reads as success.
desk_timeout_perl() {
  perl -MPOSIX -e '
    my $s = shift @ARGV; my $pid = fork();
    if (!defined $pid) { exit 125 }
    if ($pid == 0) { setpgrp(0, 0); exec @ARGV or exit 127 }
    setpgrp($pid, $pid);
    my $grp = sub { kill($_[0], -$pid) or kill($_[0], $pid) };
    $SIG{$_} = sub { $grp->($_[0]) } for qw(INT TERM HUP);
    $SIG{ALRM} = sub {
      $grp->("TERM");
      for (1 .. 20) { waitpid($pid, WNOHANG); last unless kill(0, -$pid); select(undef, undef, undef, 0.1) }
      $grp->("KILL"); exit 124 };
    alarm $s;
    1 until waitpid($pid, 0) == $pid || !$!{EINTR};
    exit($? & 127 ? 128 + ($? & 127) : $? >> 8);' "$@"
}

# Run a command in a new session so it outlives the caller. setsid(1) is util-linux: absent on macOS,
# where perl's POSIX::setsid does the same. Call it backgrounded: `desk_detach cmd ... >>log 2>&1 &`.
desk_detach() {
  if command -v setsid >/dev/null 2>&1; then exec setsid nohup "$@"
  elif command -v perl >/dev/null 2>&1; then exec nohup perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV or exit 127' "$@"
  else exec nohup "$@"
  fi
}

# GNU and BSD sed disagree on -i. Rewrite through a temp file and copy back to keep the file's mode.
desk_sed_inplace() { # desk_sed_inplace <sed -E expression> <file>
  local tmp="$2.desk-sed.$$"
  sed -E "$1" "$2" > "$tmp" && cat "$tmp" > "$2"; local rc=$?
  rm -f "$tmp"; return $rc
}

desk_port_in_use() { node "$DESK_ENV_MJS" port-in-use "$1"; }
desk_uuid()        { node "$DESK_ENV_MJS" uuid; }
desk_mem()         { node "$DESK_ENV_MJS" mem "${1:-status}"; }
desk_realdir()     { (cd "$1" 2>/dev/null && pwd -P); }
