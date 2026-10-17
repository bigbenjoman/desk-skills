#!/usr/bin/env bash
# Runs the repo's desk config §4 "Pre-push checks", in order, on the commit being pushed. Called by
# .githooks/pre-push with git's arguments (<remote> <url>) and stdin (one
# "<local ref> <local sha> <remote ref> <remote sha>" line per ref).
#
# - No desk install, no repo config, or the row unset, TODO or `none`: pushes as if there were no hook.
# - Tags and deletes are never checked. Any other ref must be HEAD with a clean tracked tree, because
#   the checks run on the working tree.
# - An item equal to a §4 Typecheck or Unit tests item takes the box-wide test lock (with-lock.sh, the
#   memory guard), waiting at most the machine profile's typecheck-lock-timeout-min (60 s without
#   one); past that it is skipped with a warning, since CI runs it anyway.
# - A failing check stops the push with its command and output. `git push --no-verify` skips the
#   hook; CI stays the control.
set -uo pipefail
DESK_HOME="${DESK_HOME:-$HOME/.claude/desk}"
ENV_MJS="$DESK_HOME/bin/desk-env.mjs"
WITH_LOCK="$DESK_HOME/bin/with-lock.sh"
say() { echo "pre-push: $*" >&2; }

refs=""
while read -r lref lsha _; do
  [ -n "${lsha:-}" ] || continue
  case "$lsha" in *[!0]*) ;; *) continue ;; esac   # all zeros: a delete
  case "$lref" in refs/tags/*) continue ;; esac
  refs="$refs $lref=$lsha"
done
[ -n "$refs" ] || exit 0

command -v node >/dev/null 2>&1 && [ -f "$ENV_MJS" ] || exit 0
top="$(git rev-parse --show-toplevel)" || exit 0
cd "$top" || exit 0
checks="$(node "$ENV_MJS" cmds pre-push-checks 2>/dev/null)"; rc=$?
case "$rc" in
  0) [ -n "$checks" ] || exit 0 ;;   # none
  3) exit 0 ;;                       # unset, TODO, or no repo config
  *) say "could not read config §4 Pre-push checks (desk-env exit $rc); pushing unchecked"; exit 0 ;;
esac

head="$(git rev-parse HEAD)"
for pair in $refs; do
  sha="${pair##*=}"
  [ "$sha" = "$head" ] && continue
  say "${pair%=*} is at ${sha:0:12}, not HEAD (${head:0:12}). The checks run on the working tree, so"
  say "check it out and push from there, or push with --no-verify."
  exit 1
done
if ! git diff --quiet HEAD --; then
  say "tracked files differ from HEAD, so the checks would not be checking the pushed commit."
  say "Commit or set the changes aside, or push with --no-verify."
  exit 1
fi

typecheck="$(node "$ENV_MJS" cmds typecheck-cmd 2>/dev/null)"
unit="$(node "$ENV_MJS" cmds test-cmd 2>/dev/null)"
mins="$(node "$ENV_MJS" machine get typecheck-lock-timeout-min 2>/dev/null)"
case "$mins" in ''|*[!0-9]*) wait_s=60 ;; *) wait_s=$((mins * 60)) ;; esac
lock_for() {
  if printf '%s\n' "$typecheck" | grep -qxF -- "$1"; then echo tsc
  elif printf '%s\n' "$unit" | grep -qxF -- "$1"; then echo test
  else echo nolock; fi
}

out="$(mktemp "${TMPDIR:-/tmp}/desk-pre-push.XXXXXX")" || exit 1
trap 'rm -f "$out"' EXIT
began=$(date +%s)
while IFS=$'\t' read -r dir cmd <&3; do
  [ -n "${cmd:-}" ] || continue
  lock="$(lock_for "$dir"$'\t'"$cmd")"
  where=""; [ "$dir" = . ] || where=" (in $dir)"
  start=$(date +%s)
  if [ "$lock" = nolock ]; then
    (cd "$dir" && bash -c "$cmd") >"$out" 2>&1 </dev/null; rc=$?
  elif [ -f "$WITH_LOCK" ]; then
    bash "$WITH_LOCK" "$lock" --timeout "$wait_s" --cwd "$dir" -- bash -c "$cmd" >"$out" 2>&1 </dev/null; rc=$?
  else
    say "skip  $cmd$where: with-lock.sh is not installed, so it cannot take the test lock; CI will run it"
    continue
  fi
  secs=$(( $(date +%s) - start ))
  if [ "$rc" = 75 ] && [ "$lock" != nolock ] && grep -q '^with-lock.sh: gave up waiting' "$out"; then
    say "skip  $cmd$where: the box-wide test lock stayed busy for ${wait_s}s; CI will run it"
    continue
  fi
  if [ "$rc" -ne 0 ]; then
    say "FAIL  $cmd$where (${secs}s, exit $rc)"
    cat "$out" >&2
    say "push stopped. Fix it and push again, or push with --no-verify (CI still runs every check)."
    exit 1
  fi
  say "ok    $cmd$where (${secs}s)"
done 3<<< "$checks"
say "checks passed in $(( $(date +%s) - began ))s"
