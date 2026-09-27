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

# Exports DESK_REPO_ROOT, DESK_WORKTREES_DIR, DESK_HOME, DESK_SLUG, DESK_REPO_CONFIG_DIR,
# DESK_DEFAULT_BRANCH, DESK_BIN, DESK_STATE, DESK_QUEUE,
# DESK_SKILLS_DIR, DESK_LOCK_DIR, DESK_MEMORY_DIR, DESK_GH_REPO, DESK_PG_CONTAINER,
# DESK_DEV_PORT, DESK_WORKER_PORT_FLOOR, DESK_IS_WSL. Fails (non-zero) with the resolver's
# message if the repo root is unset.
desk_load_paths() {
  local out
  out="$(node "$DESK_ENV_MJS" paths)" || return 1
  eval "$out"
  export DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_HOME DESK_SLUG DESK_REPO_CONFIG_DIR DESK_DEFAULT_BRANCH DESK_BIN DESK_STATE DESK_QUEUE \
    DESK_SKILLS_DIR DESK_LOCK_DIR DESK_MEMORY_DIR DESK_GH_REPO DESK_PG_CONTAINER \
    DESK_DEV_PORT DESK_WORKER_PORT_FLOOR DESK_IS_WSL
}

# Exports DESK_GITHUB_HANDLE and DESK_JIRA_NAME, or fails loudly.
desk_load_identity() {
  local out
  out="$(node "$DESK_ENV_MJS" identity)" || return 1
  eval "$out"
  export DESK_GITHUB_HANDLE DESK_JIRA_NAME
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
desk_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"
  else
    perl -e '
      my $s = shift @ARGV; my $pid = fork();
      if (!defined $pid) { exit 125 }
      if ($pid == 0) { exec @ARGV or exit 127 }
      local $SIG{ALRM} = sub { kill "TERM", $pid; sleep 2; kill "KILL", $pid; exit 124 };
      alarm $s; waitpid($pid, 0); exit($? >> 8);' "$secs" "$@"
  fi
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
