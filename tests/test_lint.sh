#!/usr/bin/env bash
# suite: syntax and shellcheck (every shell script and .mjs)
# Every tracked desk script, one file at a time: `bash -n` on each shell script (by extension or
# shebang), `node --check` on each .mjs, and, when it is installed, `shellcheck -S warning` on each
# shell script. DESK_REQUIRE_SHELLCHECK=1 (CI) makes a missing shellcheck a failure. Every suite's CPU
# budget line names a ticket and stays under the cap.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"
SH="${BASH:-bash}"
PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); echo "ok   $1"; }
bad(){ FAIL=$((FAIL+1)); echo "FAIL $1"; }
cd "$SRC" || exit 1

shells=(); mjs=()
while IFS= read -r f; do
  case "$f" in
    *.mjs) mjs+=("$f") ;;
    *.sh) shells+=("$f") ;;
    *) head -n 1 "$f" | grep -qE '^#!.*[/ ](ba)?sh( |$)' && shells+=("$f") ;;
  esac
done < <(git ls-files)
[ "${#shells[@]}" -gt 0 ] && [ "${#mjs[@]}" -gt 0 ] || { bad "no scripts found by git ls-files"; exit 1; }

for f in "${shells[@]}"; do
  if out=$("$SH" -n "$f" 2>&1); then ok "bash -n $f"; else bad "bash -n $f: ${out%%$'\n'*}"; fi
done
for f in "${mjs[@]}"; do
  if out=$(node --check "$f" 2>&1); then ok "node --check $f"; else bad "node --check $f: ${out%%$'\n'*}"; fi
done

# A suite's `# budget: N <ticket>` line (`//` in .mjs, in its first ten lines; run.sh reads it with
# suite_env.sh's budget_of) names the ticket that answers for it and stays at or under BUDGET_CAP CPU
# seconds. budget_problem prints what is wrong with file $1's, or nothing.
# shellcheck source=suite_env.sh
. "$S/suite_env.sh"
BUDGET_CAP=600
budget_problem(){ local l n
  l=$(head -n 10 "$1" | grep -m 1 -E '^(#|//) budget:') || return 0
  n=$(budget_of "$1")
  if [ -z "$n" ]; then echo "its budget line has no whole number of CPU seconds: $l"
  elif ! printf '%s\n' "$l" | grep -qE '(^|[^A-Za-z0-9])[A-Z][A-Z0-9]+-[0-9]+'; then echo "its budget line names no ticket key: $l"
  elif [ "$((10#$n))" -gt "$BUDGET_CAP" ]; then echo "its budget of $n CPU seconds is over the cap of $BUDGET_CAP"
  fi; }
# The check itself, on fixture suites, then on every tracked suite.
BT="$(mktemp -d)"; trap 'rm -rf "$BT"' EXIT
printf '#!/usr/bin/env bash\n# budget: 200\n' > "$BT/test_nokey.sh"
printf '// suite: x\n// budget: 700 DS-1 compare_pass\n' > "$BT/test_over.mjs"
printf '#!/usr/bin/env bash\n# budget: 400 DS-12 the stub server\n' > "$BT/test_fine.sh"
printf '#!/usr/bin/env bash\n# budget: lots DS-12\n' > "$BT/test_nonumber.sh"
case "$(budget_problem "$BT/test_nokey.sh")" in *"names no ticket key"*) ok "budget: a line with no ticket key is refused" ;; *) bad "budget: a line with no ticket key is not refused" ;; esac
case "$(budget_problem "$BT/test_over.mjs")" in *"over the cap of $BUDGET_CAP"*) ok "budget: a budget over the cap is refused" ;; *) bad "budget: a budget over the cap is not refused" ;; esac
case "$(budget_problem "$BT/test_nonumber.sh")" in *"no whole number"*) ok "budget: a line with no number is refused" ;; *) bad "budget: a line with no number is not refused" ;; esac
[ -z "$(budget_problem "$BT/test_fine.sh")" ] && ok "budget: a keyed line under the cap passes" || bad "budget: a keyed line under the cap is refused"
for f in tests/test_*.sh tests/test_*.mjs; do
  [ -f "$f" ] || continue
  p=$(budget_problem "$f"); if [ -z "$p" ]; then ok "budget $f"; else bad "budget $f: $p"; fi
done

if command -v shellcheck >/dev/null 2>&1; then
  for f in "${shells[@]}"; do
    if out=$(shellcheck -S warning -f gcc "$f" 2>&1); then ok "shellcheck $f"
    else while IFS= read -r l; do bad "shellcheck $l"; done <<< "$out"; fi
  done
elif [ "${DESK_REQUIRE_SHELLCHECK:-}" = 1 ]; then
  bad "shellcheck is not installed and DESK_REQUIRE_SHELLCHECK=1"
else
  echo "SKIP shellcheck: not installed (brew install shellcheck, or apt-get install shellcheck)"
fi

echo "lint: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
