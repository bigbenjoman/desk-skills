#!/usr/bin/env bash
# suite: run.sh starts every suite without the caller's DESK_* environment, and with a symlinked TMPDIR
# A desk worker runs tests/run.sh with its own DESK_* variables exported, which some suites read.
# run.sh clears every DESK_* variable but DESK_REQUIRE_SHELLCHECK and DESK_REQUIRE_PLAYWRIGHT (CI's)
# and DESK_COMPOSER_SMOKE (an opt-in), and DATABASE_URL and
# DIRECT_DATABASE_URL, before any suite runs; tests/related.sh runs through run.sh, so its suites get
# the same. Each suite's TMPDIR is a symlink to the real temporary directory, as on a Mac, even where
# the caller's is not. A copy of both runners in a scratch repo runs a probe suite that records its
# environment.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; mkdir -p "$HOME"
: > "$GIT_CONFIG_GLOBAL"; git config --global user.email t@example.com; git config --global user.name t
PASS=0; FAIL=0
check(){ if [ -n "${2:-}" ] && eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

# The scratch repo: both runners, a stub attribution hook, and one probe suite.
R="$T/repo"; mkdir -p "$R/tests" "$R/hooks"
cat "$S/run.sh" > "$R/tests/run.sh"; cat "$S/suite_env.sh" > "$R/tests/suite_env.sh"; cat "$S/related.sh" > "$R/tests/related.sh"
printf 'print("ok stub hook")\n' > "$R/hooks/deny-ai-attribution.py"
cat > "$R/tests/test_probe.sh" <<'EOF'
#!/usr/bin/env bash
env | grep -E '^(DESK_|DATABASE_URL=|DIRECT_DATABASE_URL=)' | sort > "$PROBE_OUT"
t=${TMPDIR%/}; d=$(mktemp -d)
{ [ -L "$t" ] && echo link; echo "real $(cd "$t" && pwd -P)"
  [ "$d" = "$(cd "$d" && pwd -P)" ] || echo "mktemp path is not its resolved form"; } > "$PROBE_TMP"
rmdir "$d"
echo "ok probe"
EOF
git init -q -b main "$R"; git -C "$R" add -A; git -C "$R" commit -q -m init
export PROBE_OUT="$T/probe.env" PROBE_TMP="$T/probe.tmp"
# A temporary directory with no symlink in its path, as Linux's /tmp is.
LIN="$(cd "$T" && pwd -P)/lintmp"; mkdir -p "$LIN"

export DESK_GH_REPO=bigbenjoman/desk-skills DESK_BATCH=DS-528 DESK_SLUG=x__y DESK_REQUIRE_SHELLCHECK=1 \
  DESK_REQUIRE_PLAYWRIGHT=1 DATABASE_URL=postgresql://u@localhost/db DIRECT_DATABASE_URL=postgresql://u@localhost/db

# AC2: a suite sees no DESK_* it did not set, but CI's DESK_REQUIRE_SHELLCHECK and
# DESK_REQUIRE_PLAYWRIGHT, and no database URL.
CI_ENV="DESK_REQUIRE_PLAYWRIGHT=1
DESK_REQUIRE_SHELLCHECK=1"
: > "$PROBE_OUT"
out=$(bash "$R/tests/run.sh" test_probe.sh 2>&1); rc=$?
check "run.sh with the probe suite passes" '[ $rc -eq 0 ]'
out=$(cat "$PROBE_OUT")
check "the suite sees CI's two DESK_REQUIRE_* switches and nothing else" '[ "$out" = "$CI_ENV" ]'

# AC3: tests/related.sh runs its suites through run.sh, so they see no DESK_GH_REPO. The scratch repo
# has no origin, so related.sh runs every suite there, which is the probe.
: > "$PROBE_OUT"
out=$(cd "$R" && bash tests/related.sh 2>&1); rc=$?
check "related.sh with the probe suite passes" '[ $rc -eq 0 ] && printf "%s" "$out" | grep -q "== test_probe.sh"'
out=$(cat "$PROBE_OUT")
check "a suite related.sh runs sees no DESK_GH_REPO" '[ "$out" = "$CI_ENV" ]'

# A suite's TMPDIR is a symlink to the caller's real temporary directory, even where that has no
# symlink in its path, so a path built from TMPDIR differs from its resolved form there too.
: > "$PROBE_TMP"
out=$(TMPDIR="$LIN" bash "$R/tests/run.sh" test_probe.sh 2>&1); rc=$?
check "run.sh with the probe suite and an unlinked TMPDIR passes" '[ $rc -eq 0 ]'
out=$(cat "$PROBE_TMP")
check "the suite's TMPDIR is a symlink to the real temporary directory" \
  'printf "%s\n" "$out" | grep -qx link && printf "%s\n" "$out" | grep -qxF "real $LIN"'
check "a path the suite makes with mktemp is not its resolved form" \
  'printf "%s\n" "$out" | grep -qx "mktemp path is not its resolved form"'

echo "run env: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
