# shellcheck shell=bash
# Sourced by tests/run.sh and tests/compare_pass.sh: the environment every suite starts from, and the
# bash it runs under. Written for bash 3.2 as well as 4+.
# A desk worker runs these suites with its own DESK_* environment (DESK_GH_REPO, DESK_BATCH, ...), and
# some suites read those, so every suite starts with none: each sets what it needs itself. keep_env is
# the exception: DESK_REQUIRE_SHELLCHECK is CI's switch that makes test_lint.sh fail without shellcheck,
# and DESK_COMPOSER_SMOKE opts test_pr_composer.mjs in to its live smoke test.
keep_env=" DESK_REQUIRE_SHELLCHECK DESK_COMPOSER_SMOKE "
for v in $(compgen -e); do
  case "$v" in DESK_*) case "$keep_env" in *" $v "*) ;; *) unset "$v" ;; esac ;; esac
done
unset DATABASE_URL DIRECT_DATABASE_URL
# The pass's test lock gate reads this machine's real lock queue, which a suite run from a worker is
# itself part of: every suite's passes run without it, and the suites that test it turn it back on.
export AUTOPILOT_LOCK_QUEUE=off
# Every bash suite runs under the bash running the caller, so `/bin/bash tests/run.sh` tests 3.2.
# shellcheck disable=SC2034  # read by the caller
SH="${BASH:-bash}"
# The CPU budget a suite's header sets: the N of the first `# budget: N <ticket>` line (`//` in .mjs)
# in its first ten lines, or nothing where it has none or N is not a whole number. A suite that does
# more off a pull request (a main push or a local run) can give that its own figure as
# `# budget: N (main M) <ticket>`: then M is its budget unless GITHUB_EVENT_NAME is pull_request, or
# $2 is `pr`. run.sh budgets by it, and test_lint.sh checks the same line.
budget_of(){ local l n m
  l=$(head -n 10 "$1" | grep -m 1 -E '^(#|//) budget:') || return 1
  n=$(printf '%s\n' "$l" | grep -oE '^(#|//) budget: [0-9]+( |$)' | grep -oE '[0-9]+') || return 1
  m=$(budget_main_of "$1")
  if [ -n "$m" ] && [ "${2:-}" != pr ] && [ "${GITHUB_EVENT_NAME:-}" != pull_request ]; then echo "$m"; else echo "$n"; fi; }
# The M of that line's `(main M)`, or nothing where it has none or it is not well formed. The one
# reading of the main figure: budget_of uses it, and test_lint.sh refuses a `(main` it cannot read.
budget_main_of(){ head -n 10 "$1" | grep -m 1 -E '^(#|//) budget:' | grep -oE '^(#|//) budget: [0-9]+ \(main [0-9]+\)( |$)' | grep -oE '\(main [0-9]+' | grep -oE '[0-9]+'; }
