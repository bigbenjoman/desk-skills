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

echo "related: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
