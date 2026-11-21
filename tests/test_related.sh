#!/usr/bin/env bash
# suite: related tests (tests/related.sh runs the suites scope_sections.mjs picks, else every suite)
# tests/related.sh in a scratch repo holding copies of it, tests/run.sh and tests/scope_sections.mjs,
# a toy desk/bin/desk-env.mjs, and four toy suites: test_a.sh, test_b.sh and test_c.sh name lib/a.sh,
# lib/b.sh and lib/c.sh (test_c.sh also an export desk-env.mjs gains), test_lint.sh always runs.
# Scratch HOME and repo only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"
# The real path: scope_sections.mjs runs its CLI only when argv[1] is its resolved path (macOS's /var is a link).
T="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/bin"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
# desk-env answers the default-branch lookup, and run.sh's test-cap one (its default -j).
printf '#!/usr/bin/env bash\ncase "$2" in test-cap) echo 3 ;; *) echo main ;; esac\n' > "$T/bin/desk-env"; chmod +x "$T/bin/desk-env"
export PATH="$T/bin:$PATH"
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

R="$T/repo"; mkdir -p "$R/tests" "$R/lib" "$R/hooks" "$R/desk/bin"
cp "$S/related.sh" "$S/run.sh" "$S/suite_env.sh" "$S/scope_sections.mjs" "$R/tests/"
printf 'print("ok attribution hook stub")\n' > "$R/hooks/deny-ai-attribution.py"
for n in a b c; do
  printf 'echo %s\n' "$n" > "$R/lib/$n.sh"
  printf '# runs lib/%s.sh\necho "ok suite %s"\n' "$n" "$n" > "$R/tests/test_$n.sh"
done
# test_c.sh also uses an export desk-env.mjs does not have yet.
printf '# and calls newThing from desk-env.mjs\n' >> "$R/tests/test_c.sh"
printf 'export const one = 1;\n\nexport function two() {\n  return 2;\n}\n' > "$R/desk/bin/desk-env.mjs"
printf 'echo "ok suite lint"\n' > "$R/tests/test_lint.sh"
git -C "$R" init -q -b main; git -C "$R" add -A; git -C "$R" commit -q -m init
git -C "$R" update-ref refs/remotes/origin/main HEAD
git -C "$R" checkout -q -b fix/x
printf 'echo a2\n' > "$R/lib/a.sh"; git -C "$R" commit -q -am 'change a'
related(){ out=$(cd "$R" && bash tests/related.sh 2>&1); rc=$?; }
ran(){ [[ "$out" == *"== test_$1.sh"* ]]; }

related
check "AC2 a change to one suite's file runs that suite"     '[ $rc -eq 0 ] && ran a'
check "AC2 and the always-run suite"                         'ran lint'
check "AC2 and no other"                                     '! ran b'
check "AC2 it says which scope it ran"                       '[[ "$out" == *"related: scope some against origin/main: test_a.sh test_lint.sh"* ]]'

printf 'echo "FAIL suite a"\n' >> "$R/tests/test_a.sh"; git -C "$R" commit -q -am 'break a'
related
check "a failing suite fails the run"                        '[ $rc -ne 0 ] && ran a && ! ran b'
git -C "$R" reset -q --hard HEAD~1

printf 'x\n' > "$R/.gitignore"; git -C "$R" add .gitignore; git -C "$R" commit -q -m 'root file'
related
check "a full scope runs every suite"                        '[ $rc -eq 0 ] && ran a && ran b && ran lint && [[ "$out" == *"scope full against origin/main (.gitignore is a root file), so every suite runs"* ]]'
git -C "$R" reset -q --hard HEAD~1

printf 'echo b2\n' > "$R/lib/b.sh"
related
check "an uncommitted edit counts: its suite runs too"       '[ $rc -eq 0 ] && ran a && ran b && [[ "$out" == *"scope some against origin/main: test_a.sh test_b.sh test_lint.sh"* ]]'
git -C "$R" checkout -q -- lib/b.sh

git -C "$R" rm -q lib/b.sh
related
check "an uncommitted deletion runs every suite" '[ $rc -eq 0 ] && ran a && ran b && [[ "$out" == *"scope full against origin/main (lib/b.sh was deleted), so every suite runs"* ]]'
git -C "$R" reset -q --hard HEAD

# DS-818 AC1: as many at once as run.sh's default (here its test-cap of 3), or DESK_TEST_JOBS.
related
check "DS-818 AC1 by default as many run at once as run.sh's default" '[ $rc -eq 0 ] && ran a && [[ "$out" == *"up to 3 suites at once"* ]]'
out=$(cd "$R" && DESK_TEST_JOBS=2 bash tests/related.sh 2>&1); rc=$?
check "DS-818 AC1 DESK_TEST_JOBS sets how many run at once"  '[ $rc -eq 0 ] && ran a && ran lint && [[ "$out" == *"up to 2 suites at once"* ]]'
out=$(cd "$R" && DESK_TEST_JOBS=1 bash tests/related.sh 2>&1); rc=$?
check "DS-818 AC1 DESK_TEST_JOBS=1 runs them one at a time"  '[ $rc -eq 0 ] && ran a && [[ "$out" != *"suites at once"* ]]'
printf 'x\n' > "$R/.gitignore"; git -C "$R" add .gitignore; git -C "$R" commit -q -m 'root file'
out=$(cd "$R" && DESK_TEST_JOBS=2 bash tests/related.sh 2>&1); rc=$?
check "DS-818 AC1 and so does a run of every suite"          '[ $rc -eq 0 ] && ran b && [[ "$out" == *"up to 2 suites at once"* ]]'
git -C "$R" reset -q --hard HEAD~1

# DS-818 AC2: a change that only adds exports to desk-env.mjs runs the suites that use them.
printf '\n// The second thing.\nexport function newThing() {\n  return 3;\n}\n' >> "$R/desk/bin/desk-env.mjs"; git -C "$R" commit -q -am 'add newThing'
related
check "DS-818 AC2 a new desk-env.mjs export runs the suites using it, with the branch's other suites" '[ $rc -eq 0 ] && [[ "$out" == *"scope some against origin/main: test_a.sh test_c.sh test_lint.sh"* ]] && ! ran b'
# AC3: changing or removing an existing export runs every suite.
printf 'export const one = 9;\n\nexport function two() {\n  return 2;\n}\n' > "$R/desk/bin/desk-env.mjs"
related
check "DS-818 AC3 a changed desk-env.mjs export runs every suite" '[ $rc -eq 0 ] && ran b && [[ "$out" == *"(desk/bin/desk-env.mjs is shared by every suite), so every suite runs"* ]]'
printf 'export function two() {\n  return 2;\n}\n' > "$R/desk/bin/desk-env.mjs"
related
check "DS-818 AC3 a removed desk-env.mjs export runs every suite" '[ $rc -eq 0 ] && ran b && [[ "$out" == *"(desk/bin/desk-env.mjs is shared by every suite), so every suite runs"* ]]'
git -C "$R" reset -q --hard HEAD~1

# DS-818 AC8: related.sh and CI's pull request plan choose the same suites for one branch. main moves
# on (lib/c.sh) and is merged into the branch, which also has an uncommitted edit; CI then sees the
# pull request's merge commit with that edit committed.
git -C "$R" checkout -q main; printf 'echo c2\n' > "$R/lib/c.sh"; git -C "$R" commit -q -am 'main moves'
git -C "$R" update-ref refs/remotes/origin/main HEAD; git -C "$R" checkout -q fix/x
git -C "$R" merge -q --no-edit origin/main
printf 'echo b2\n' > "$R/lib/b.sh"
related
local_suites=$(printf '%s\n' "$out" | grep -m 1 '^related: scope some' | grep -oE 'test_[a-z]+\.sh' | tr '\n' ' ')
git -C "$R" commit -q -am 'the edit'; git -C "$R" checkout -q --detach origin/main; git -C "$R" merge -q --no-ff --no-edit fix/x
: > "$T/gh_out"
(cd "$R" && GITHUB_OUTPUT="$T/gh_out" node tests/scope_sections.mjs --base HEAD^1 --head HEAD --github-output >/dev/null)
ci_suites=$(grep -m 1 '^suites=' "$T/gh_out" | grep -oE 'test_[a-z]+\.sh' | tr '\n' ' ')
out="local: $local_suites ci: $ci_suites"
check "DS-818 AC8 related.sh and CI choose the same suites"  '[ "$local_suites" = "test_a.sh test_b.sh test_lint.sh " ] && [ "$ci_suites" = "$local_suites" ]'
git -C "$R" checkout -q fix/x

cp "$R/tests/scope_sections.mjs" "$T/scope_sections.mjs"
printf 'process.exit(1);\n' > "$R/tests/scope_sections.mjs"
related
check "AC3 scope_sections.mjs failing runs every suite"      '[ $rc -eq 0 ] && ran a && ran b && ran lint'
check "AC3 and says why"                                     '[[ "$out" == *"related: scope_sections.mjs failed against origin/main, so every suite runs"* ]]'
cp "$T/scope_sections.mjs" "$R/tests/scope_sections.mjs"

git -C "$R" update-ref -d refs/remotes/origin/main
related
check "no merge base with the default branch runs every suite" '[ $rc -eq 0 ] && ran a && ran b && ran lint && [[ "$out" == *"related: no merge base with origin/main, so every suite runs"* ]]'
check "DS-924 with no with-lock.sh to find it says so and runs with no slot" '[[ "$out" == *"related: no with-lock.sh found, so the suites run without a test slot"* ]]'
git -C "$R" update-ref refs/remotes/origin/main main

# DS-924: related.sh takes a test slot first. A stub lock wrapper where the installed one goes records
# each call and the directory it ran in, then waits, gives up or runs its command as STUB says.
mkdir -p "$HOME/.claude/desk/bin"; WL="$HOME/.claude/desk/bin/with-lock.sh"; CALLS="$T/calls"
cat > "$WL" <<'EOF'
#!/usr/bin/env bash
printf '%s\ncwd %s\n' "$*" "$(pwd -P)" >> "$STUB_CALLS"
name=$1; shift; t=""; [ "$1" = --timeout ] && { t=$2; shift 2; }; [ "$1" = -- ] && shift
case "${STUB:-run}" in
  wait) echo "with-lock.sh: waiting for $name lock (all 1 slots held): ~/other: bash tests/run.sh, held 2m" >&2 ;;
  timeout) echo "with-lock.sh: gave up waiting for the $name lock after ${t}s" >&2; exit 75 ;;
esac
export DESK_LOCK_HELD="$name"; exec "$@"
EOF
export STUB_CALLS="$CALLS"
: > "$CALLS"; out=$(cd "$R" && STUB=wait bash tests/related.sh 2>&1); rc=$?
check "DS-924 AC1 it takes a test slot through the wrapper, with an hour's deadline" '[[ "$(head -n 1 "$CALLS")" == "test --timeout 3600 -- env DESK_LOCK_HELD=test "*"bash $R/tests/related.sh" ]]'
check "DS-924 AC1 it says it waits, and on whom, and runs once it holds the slot" \
  '[ $rc -eq 0 ] && [[ "$out" == *"related: taking a test slot first, waiting up to 3600s for one"*"with-lock.sh: waiting for test lock (all 1 slots held): ~/other"* ]] && ran a && ! ran c'
check "DS-924 AC1 the wrapper is called once: the run inside the slot takes no second" '[ "$(grep -c -- --timeout "$CALLS")" -eq 1 ]'
: > "$CALLS"; out=$(cd "$R" && DESK_RELATED_WAIT=90 bash tests/related.sh 2>&1); rc=$?
check "DS-924 DESK_RELATED_WAIT sets the deadline in seconds" '[ $rc -eq 0 ] && [[ "$(head -n 1 "$CALLS")" == "test --timeout 90 -- "* ]]'
out=$(cd "$R" && DESK_RELATED_WAIT=1h bash tests/related.sh 2>&1); rc=$?
check "DS-924 a DESK_RELATED_WAIT that is not whole seconds is refused" '[ $rc -eq 2 ] && [[ "$out" == *"DESK_RELATED_WAIT wants a whole number of seconds, not '"'1h'"'"* ]] && ! ran a'

# AC2: from a sibling worktree of the same repo it runs that worktree's suites, in that worktree.
W="$T/wt2"; git -C "$R" worktree add -q -b fix/y "$W" fix/x
printf 'echo c3\n' > "$W/lib/c.sh"
: > "$CALLS"; out=$(cd "$W" && bash tests/related.sh 2>&1); rc=$?
check "DS-924 AC2 from a sibling worktree its suites run under the slot, in that worktree" \
  '[ $rc -eq 0 ] && [ "$(sed -n 2p "$CALLS")" = "cwd $(cd "$W" && pwd -P)" ] && [[ "$out" == *"scope some against origin/main: test_a.sh test_b.sh test_c.sh test_lint.sh"* ]] && ran c'

# AC3: a run already inside a slot (called through the wrapper, which exports DESK_LOCK_HELD) takes none.
: > "$CALLS"; out=$(cd "$R" && DESK_LOCK_HELD=test bash tests/related.sh 2>&1); rc=$?
check "DS-924 AC3 a run already in a slot does not take a second" '[ $rc -eq 0 ] && ran a && [ ! -s "$CALLS" ] && [[ "$out" != *"taking a test slot"* ]]'

# AC4: the wait passes its deadline: the wrapper's 75, said, and no suite run.
out=$(cd "$R" && STUB=timeout DESK_RELATED_WAIT=5 bash tests/related.sh 2>&1); rc=$?
check "DS-924 AC4 past the deadline it exits 75, says it timed out waiting for a slot, and runs nothing" \
  '[ $rc -eq 75 ] && [[ "$out" == *"related: timed out after 5s waiting for a test slot, so no suite ran"* ]] && ! ran a'

# The same through the real with-lock.sh, on a scratch lock and lease directory with one test slot.
rm -f "$WL"; rmdir "$HOME/.claude/desk/bin"; ln -s "$(cd "$S/../desk/bin" && pwd -P)" "$HOME/.claude/desk/bin"
mkdir -p "$T/locks" "$T/leases"
export DESK_LOCK_DIR="$T/locks" DESK_LEASE_DIR="$T/leases" DESK_TEST_LOCK_SLOTS=1 DESK_MACHINE="$T/no-machine.md" DESK_CONFIG="$T/no-config.md"
M="$T/held"
bash "$WL" test -- sh -c ": > '$M'; while [ ! -e '$M.go' ]; do sleep 0.1; done" & holder=$!
for _ in $(seq 1 100); do [ -e "$M" ] && break; sleep 0.1; done
(cd "$R" && DESK_RELATED_WAIT=60 bash tests/related.sh > "$T/rel.out" 2>&1; echo $? > "$T/rel.rc") &
for _ in $(seq 1 150); do grep -q 'waiting for test lock' "$T/rel.out" 2>/dev/null && break; sleep 0.1; done
out=$(cat "$T/rel.out")
check "DS-924 AC1 (real wrapper) a held slot makes it wait, saying on whom, before any suite runs" \
  '[[ "$out" == *"with-lock.sh: waiting for test lock (held by pid "*"): "*", held "* ]] && ! ran a'
: > "$M.go"; wait "$holder"
for _ in $(seq 1 300); do [ -s "$T/rel.rc" ] && break; sleep 0.1; done
out=$(cat "$T/rel.out")
check "DS-924 AC1 (real wrapper) it runs once the slot frees" '[ "$(cat "$T/rel.rc")" = 0 ] && ran a'
out=$(cd "$R" && bash "$WL" test -- env DESK_RELATED_WAIT=5 bash tests/related.sh 2>&1); rc=$?
check "DS-924 AC3 (real wrapper) called through with-lock.sh it runs in that slot and takes no second" '[ $rc -eq 0 ] && ran a && [[ "$out" != *"taking a test slot"* ]]'
# A with-lock.sh installed before DS-924 exports no DESK_LOCK_HELD: the holder file naming the run is enough.
out=$(cd "$R" && bash "$WL" test -- env -u DESK_LOCK_HELD DESK_RELATED_WAIT=5 bash tests/related.sh 2>&1); rc=$?
check "DS-924 AC3 (real wrapper) under a wrapper that exports no marker, the holder file keeps it in its slot" '[ $rc -eq 0 ] && ran a && [[ "$out" != *"taking a test slot"* ]]'
# That older wrapper's untimed one-slot path ran `flock <lock> <command>`, naming the run in no file: the
# flock(1) running it as its child is enough.
if command -v flock >/dev/null 2>&1; then
  out=$(cd "$R" && flock "$DESK_LOCK_DIR/desk-test.lock" env -u DESK_LOCK_HELD DESK_RELATED_WAIT=5 bash tests/related.sh 2>&1); rc=$?
  check "DS-924 AC3 run by flock(1) on the test lock, as an older wrapper did, it takes no second slot" '[ $rc -eq 0 ] && ran a && [[ "$out" != *"taking a test slot"* ]]'
else
  echo "skip DS-924 AC3 under flock(1): no flock here (test_gate.mjs checks inSlot's flock rule)"
fi
rm -f "$M" "$M.go"
bash "$WL" test -- sh -c ": > '$M'; while [ ! -e '$M.go' ]; do sleep 0.1; done" & holder=$!
for _ in $(seq 1 100); do [ -e "$M" ] && break; sleep 0.1; done
out=$(cd "$R" && DESK_RELATED_WAIT=1 bash tests/related.sh 2>&1); rc=$?
: > "$M.go"; wait "$holder"
check "DS-924 AC4 (real wrapper) past the deadline it exits 75 and says why" \
  '[ $rc -eq 75 ] && [[ "$out" == *"gave up waiting for the test lock after 1s"*"related: timed out after 1s waiting for a test slot, so no suite ran"* ]] && ! ran a'

echo "related: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
