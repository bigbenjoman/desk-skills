# shellcheck shell=bash
# Sourced by tests/run.sh and tests/compare_pass.sh: the environment every suite starts from, and the
# bash it runs under. Written for bash 3.2 as well as 4+.
# A desk worker runs these suites with its own DESK_* environment (DESK_GH_REPO, DESK_BATCH, ...), and
# some suites read those, so every suite starts with none: each sets what it needs itself. keep_env is
# the exception: DESK_REQUIRE_SHELLCHECK is CI's switch that makes test_lint.sh fail without shellcheck.
keep_env=" DESK_REQUIRE_SHELLCHECK "
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
