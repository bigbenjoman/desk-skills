#!/usr/bin/env bash
# suite: syntax and shellcheck (every shell script and .mjs)
# layer: L2
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
# seconds. The cap holds the pull-request figure: a `(main M)` after N, the budget of a main push or a
# local run, is uncapped but must be a whole number. budget_problem prints what is wrong with file
# $1's, or nothing.
# shellcheck source=suite_env.sh
. "$S/suite_env.sh"
BUDGET_CAP=600
budget_problem(){ local l n
  l=$(head -n 10 "$1" | grep -m 1 -E '^(#|//) budget:') || return 0
  n=$(budget_of "$1" pr)
  if [ -z "$n" ]; then echo "its budget line has no whole number of CPU seconds: $l"
  elif printf '%s\n' "$l" | grep -qE '^(#|//) budget: [0-9]+ \(main' && [ -z "$(budget_main_of "$1")" ]; then
    echo "its budget line's main figure is no whole number of CPU seconds: $l"
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
printf '#!/usr/bin/env bash\n# budget: 60 (main 1500) DS-942 the full replay\n' > "$BT/test_main.sh"
printf '#!/usr/bin/env bash\n# budget: 700 (main 1500) DS-942\n' > "$BT/test_main_over.sh"
printf '#!/usr/bin/env bash\n# budget: 60 (main lots) DS-942\n' > "$BT/test_main_nonumber.sh"
for e in pull_request push ''; do
  [ -z "$(GITHUB_EVENT_NAME="$e" budget_problem "$BT/test_main.sh")" ] && ok "DS-942 AC1 budget ($e): a main figure over the cap passes, the cap holding the pull-request figure" || bad "DS-942 AC1 budget ($e): a main figure over the cap is refused"
done
case "$(budget_problem "$BT/test_main_over.sh")" in *"budget of 700 CPU seconds is over the cap of $BUDGET_CAP"*) ok "DS-942 AC2 budget: a pull-request figure over the cap is refused beside a main one" ;; *) bad "DS-942 AC2 budget: a pull-request figure over the cap is not refused beside a main one" ;; esac
case "$(budget_problem "$BT/test_main_nonumber.sh")" in *"main figure is no whole number"*) ok "DS-942 budget: a main figure that is no number is refused" ;; *) bad "DS-942 budget: a main figure that is no number is not refused" ;; esac
for f in tests/test_*.sh tests/test_*.mjs; do
  [ -f "$f" ] || continue
  p=$(budget_problem "$f"); if [ -z "$p" ]; then ok "budget $f"; else bad "budget $f: $p"; fi
done

# Every suite declares exactly one test layer, L1, L2 or L3, in a `# layer:` line (`//` in .mjs) in its
# first ten lines: scope_sections.mjs --layers names each suite whose line is missing, doubled or unknown.
printf '#!/usr/bin/env bash\n# suite: x\n' > "$BT/test_nolayer.sh"
printf '// suite: x\n// layer: L1\n' > "$BT/test_layered.mjs"
out=$(node "$S/scope_sections.mjs" --layers "$BT/test_nolayer.sh" "$BT/test_layered.mjs" 2>&1); rc=$?
if [ "$rc" -eq 1 ] && grep -qF "$BT/test_nolayer.sh: declares no layer" <<< "$out" && ! grep -qF test_layered.mjs <<< "$out"; then
  ok "DS-985 AC2 layer: a suite with no layer line fails and is named"
else bad "DS-985 AC2 layer: a suite with no layer line is not refused by name (rc $rc): $out"; fi
if out=$(node "$S/scope_sections.mjs" --layers 2>&1); then ok "layer: every suite declares one"
else while IFS= read -r l; do bad "layer $l"; done <<< "$out"; fi

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
