#!/usr/bin/env bash
# suite: related tests (tests/related.sh runs the suites scope_sections.mjs picks, else every suite)
# tests/related.sh in a scratch repo holding copies of it, tests/run.sh and tests/scope_sections.mjs,
# and three toy suites: test_a.sh names lib/a.sh, test_b.sh names lib/b.sh, test_lint.sh always runs.
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
# desk-env answers the default-branch lookup.
printf '#!/usr/bin/env bash\necho main\n' > "$T/bin/desk-env"; chmod +x "$T/bin/desk-env"
export PATH="$T/bin:$PATH"
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

R="$T/repo"; mkdir -p "$R/tests" "$R/lib" "$R/hooks"
cp "$S/related.sh" "$S/run.sh" "$S/scope_sections.mjs" "$R/tests/"
printf 'print("ok attribution hook stub")\n' > "$R/hooks/deny-ai-attribution.py"
for n in a b; do
  printf 'echo %s\n' "$n" > "$R/lib/$n.sh"
  printf '# runs lib/%s.sh\necho "ok suite %s"\n' "$n" "$n" > "$R/tests/test_$n.sh"
done
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
check "a full scope runs every suite"                        '[ $rc -eq 0 ] && ran a && ran b && ran lint && [[ "$out" == *"scope full against origin/main, so every suite runs"* ]]'
git -C "$R" reset -q --hard HEAD~1

printf 'echo b2\n' > "$R/lib/b.sh"
related
check "an uncommitted edit counts: its suite runs too"       '[ $rc -eq 0 ] && ran a && ran b && [[ "$out" == *"scope some against origin/main: test_a.sh test_b.sh test_lint.sh"* ]]'
git -C "$R" checkout -q -- lib/b.sh

git -C "$R" rm -q lib/b.sh
related
check "an uncommitted deletion runs every suite" '[ $rc -eq 0 ] && ran a && ran b && [[ "$out" == *"lib/b.sh was deleted or renamed against origin/main, so every suite runs"* ]]'
git -C "$R" reset -q --hard HEAD

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
