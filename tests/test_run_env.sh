#!/usr/bin/env bash
# suite: run.sh starts every suite without the caller's DESK_* environment
# A desk worker runs tests/run.sh with its own DESK_* variables exported, which some suites read.
# run.sh clears every DESK_* variable but DESK_REQUIRE_SHELLCHECK (CI's), and DATABASE_URL and
# DIRECT_DATABASE_URL, before any suite runs; tests/related.sh runs through run.sh, so its suites get
# the same. A copy of both runners in a scratch repo runs a probe suite that records its environment.
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
cat "$S/run.sh" > "$R/tests/run.sh"; cat "$S/related.sh" > "$R/tests/related.sh"
printf 'print("ok stub hook")\n' > "$R/hooks/deny-ai-attribution.py"
cat > "$R/tests/test_probe.sh" <<'EOF'
#!/usr/bin/env bash
env | grep -E '^(DESK_|DATABASE_URL=|DIRECT_DATABASE_URL=)' > "$PROBE_OUT"
echo "ok probe"
EOF
git init -q -b main "$R"; git -C "$R" add -A; git -C "$R" commit -q -m init
export PROBE_OUT="$T/probe.env"

export DESK_GH_REPO=bigbenjoman/desk-skills DESK_BATCH=DS-528 DESK_SLUG=x__y DESK_REQUIRE_SHELLCHECK=1 \
  DATABASE_URL=postgresql://u@localhost/db DIRECT_DATABASE_URL=postgresql://u@localhost/db

# AC2: a suite sees no DESK_* it did not set, but CI's DESK_REQUIRE_SHELLCHECK, and no database URL.
: > "$PROBE_OUT"
out=$(bash "$R/tests/run.sh" test_probe.sh 2>&1); rc=$?
check "run.sh with the probe suite passes" '[ $rc -eq 0 ]'
out=$(cat "$PROBE_OUT")
check "the suite sees DESK_REQUIRE_SHELLCHECK=1 and nothing else" '[ "$out" = DESK_REQUIRE_SHELLCHECK=1 ]'

# AC3: tests/related.sh runs its suites through run.sh, so they see no DESK_GH_REPO. The scratch repo
# has no origin, so related.sh runs every suite there, which is the probe.
: > "$PROBE_OUT"
out=$(cd "$R" && bash tests/related.sh 2>&1); rc=$?
check "related.sh with the probe suite passes" '[ $rc -eq 0 ] && printf "%s" "$out" | grep -q "== test_probe.sh"'
out=$(cat "$PROBE_OUT")
check "a suite related.sh runs sees no DESK_GH_REPO" '[ "$out" = DESK_REQUIRE_SHELLCHECK=1 ]'

# AC1: the two suites that failed inside workers pass with a worker's DESK_GH_REPO and DESK_BATCH.
out=$(bash "$S/run.sh" test_worktree_db.sh test_intake.sh 2>&1); rc=$?
check "test_worktree_db.sh and test_intake.sh pass with DESK_GH_REPO and DESK_BATCH exported" \
  '[ $rc -eq 0 ] && printf "%s" "$out" | grep -q "^all passed"'

echo "run env: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
