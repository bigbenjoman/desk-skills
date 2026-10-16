#!/usr/bin/env bash
# Every tracked desk script, one file at a time: `bash -n` on each shell script (by extension or
# shebang), `node --check` on each .mjs, and, when it is installed, `shellcheck -S warning` on each
# shell script. DESK_REQUIRE_SHELLCHECK=1 (CI) makes a missing shellcheck a failure.
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
