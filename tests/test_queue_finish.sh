#!/usr/bin/env bash
# suite: queue finish (a parked ticket whose last step the orchestrator finished)
# queue.mjs finish records a parked ticket done on its PR, as the pass records one whose draft PR it
# opened, and refuses a ticket that is not parked and a PR that is not open or merged, from a fork, on
# another branch or into another base.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME" "$T/bin"
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }
cat > "$T/config.md" <<'EOF'
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | `acme/widgets` |
| Default branch | `main` |
EOF
# gh pr view <n>: the PR's JSON from $T/pr-<n>.json, or exit 1 naming it.
cat > "$T/bin/gh" <<'EOF'
#!/usr/bin/env bash
[ "$1 $2" = "pr view" ] || exit 2
f="$GH_DIR/pr-$3.json"; [ -f "$f" ] || { echo "no pull requests found for #$3" >&2; exit 1; }
cat "$f"
EOF
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH" GH_DIR="$T" DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue.json" DESK_REPO_DIR="$T/repo"
git init -q "$T/repo"; mkdir -p "$T/repo/.claude"
q(){ out=$(node "$B/queue.mjs" "$@" 2>&1); rc=$?; }
f(){ node -e 'let v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]; for (const p of process.argv[3].split(".")) v = v?.[p]; console.log(JSON.stringify(v));' "$DESK_QUEUE" "$1" "$2"; }
pr(){ printf '{"number":%s,"state":"%s","isDraft":%s,"headRefName":"%s","baseRefName":"%s","isCrossRepository":%s}\n' "$1" "$2" "$3" "$4" "${5:-main}" "${6:-false}" > "$T/pr-$1.json"; }

q init t
for k in fix-a fix-b fix-c; do q add "$k"; q set "$k" "branch=fix/$k"; q park "$k" "AUTOPILOT_PARK: gh pr create was refused"; done

pr 61 OPEN true fix/fix-a
q finish fix-a --pr 61
check "#822 a parked ticket is recorded done on its draft PR, saying so" '[ $rc -eq 0 ] && [ "$out" = "fix-a recorded done on PR #61 (a draft, fix/fix-a into main): no longer parked" ]'
check "#822 as the pass records one: done, the park cleared, its PR and the draft" '[ "$(f fix-a state)" = "\"done\"" ] && [ "$(f fix-a park)" = null ] && [ "$(f fix-a result.pr)" = 61 ] && [ "$(f fix-a draft_pr)" = 61 ]'
check "#822 its summary says the orchestrator finished it, and what the park was" '[[ "$(f fix-a result.summary)" == "\"PR #61: its last step finished by the orchestrator, after the worker parked (AUTOPILOT_PARK: gh pr create was refused)\"" ]]'
q render
check "#822 the status table lists it on its PR" '[ $rc -eq 0 ] && grep -q "fix-a .*PR #61" <<< "$out"'

q finish fix-a --pr 61
check "#822 a ticket not parked is refused" '[ $rc -eq 11 ] && [[ "$out" == *"fix-a is done, not parked"* ]]'
pr 62 CLOSED false fix/fix-b
q finish fix-b --pr 62
check "#822 a closed PR is refused, and the ticket stays parked" '[ $rc -eq 11 ] && [[ "$out" == *"PR #62 is closed, not open or merged: nothing recorded"* ]] && [ "$(f fix-b state)" = "\"parked\"" ]'
pr 63 OPEN false fix/other
q finish fix-b --pr 63
check "#822 a PR from another branch is refused, naming both" '[ $rc -eq 11 ] && [[ "$out" == *"PR #63 is from fix/other, not fix-b'"'"'s branch fix/fix-b"* ]]'
pr 64 OPEN false fix/fix-b release
q finish fix-b --pr 64
check "#822 a PR into another base is refused, naming both" '[ $rc -eq 11 ] && [[ "$out" == *"PR #64 is into release, not this batch'"'"'s base main"* ]]'
pr 65 OPEN false fix/fix-b main true
q finish fix-b --pr 65
check "#822 a PR from a fork is refused" '[ $rc -eq 11 ] && [[ "$out" == *"PR #65 is from a fork"* ]]'
q finish fix-b --pr 99
check "#822 a PR gh cannot read is refused, saying why" '[ $rc -eq 11 ] && [[ "$out" == *"gh could not read PR #99 on acme/widgets (no pull requests found for #99)"* ]]'
q finish fix-b 66
check "#822 no --pr is refused with the usage" '[ $rc -eq 11 ] && [[ "$out" == *"usage: queue.mjs finish <TICKET> --pr <PR number>"* ]]'
pr 66 MERGED false fix/fix-b
q finish fix-b --pr 66
check "#822 a merged PR is recorded, and no draft is set" '[ $rc -eq 0 ] && [[ "$out" == *"PR #66 (merged,"* ]] && [ "$(f fix-b draft_pr)" = undefined ]'
q finish nope --pr 66
check "#822 a ticket not in the queue is refused" '[ $rc -eq 11 ] && [[ "$out" == *"nope"* ]]'

rm -rf "$T"
echo "queue finish: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
