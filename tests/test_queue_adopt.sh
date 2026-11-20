#!/usr/bin/env bash
# suite: queue adopt (a PR opened in the batch with no ticket)
# queue.mjs adopt takes an open PR into the batch's base in as a done ticket on that PR, by its branch,
# so the merge driver merges it and the pass and desk-q list it; it refuses a key the driver would not
# take, a PR that is not open, one on another base, and a branch another ticket already has.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"
export HOME="$T/home"; mkdir -p "$HOME" "$T/bin"
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }
cat > "$T/config.md" <<'EOF'
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | `acme/widgets` |
| Default branch | `main` |

## 4. Project
| Field | Value |
|---|---|
| Tracker | `none` |
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
pr(){ printf '{"number":%s,"state":"%s","headRefName":"%s","baseRefName":"%s","title":"%s"}\n' "$1" "$2" "$3" "$4" "$5" > "$T/pr-$1.json"; }

q init t; q add fix-a
q set fix-a branch=fix/a
pr 51 OPEN fix/flaky-spec main "Fix the flaky spec"
q adopt flaky-spec 51
check "#807 an open PR into the base is adopted, naming its PR and branch" '[ $rc -eq 0 ] && [[ "$out" == "flaky-spec adopted PR #51 (fix/flaky-spec into main): the merge driver merges it"* ]]'
check "#807 it is a done ticket on that PR, by its branch" '[ "$(f flaky-spec state)" = "\"done\"" ] && [ "$(f flaky-spec result.pr)" = "\"51\"" ] && [ "$(f flaky-spec branch)" = "\"fix/flaky-spec\"" ] && [ "$(f flaky-spec adopted)" = true ]'
q render
check "#807 the status table lists it" '[ $rc -eq 0 ] && grep -q "flaky-spec .*PR #51" <<< "$out"'

q adopt flaky-spec 51
check "#807 a key already in the queue is refused" '[ $rc -eq 11 ] && [[ "$out" == *"flaky-spec is already in the queue (done)"* ]]'
q adopt 'Bad Key' 51
check "#807 a key the merge driver would not take is refused" '[ $rc -eq 11 ] && [[ "$out" == *"is not usable as a ticket id"* ]]'
q adopt other 51x
check "#807 a PR that is not a number is refused, with the usage" '[ $rc -eq 11 ] && [[ "$out" == *"usage: queue.mjs adopt <TICKET> <PR number>"* ]]'
pr 52 MERGED fix/b main "Done already"
q adopt merged-one 52
check "#807 a PR that is not open is refused" '[ $rc -eq 11 ] && [[ "$out" == *"PR #52 is merged, not open: nothing adopted"* ]] && [ "$(f merged-one state)" = undefined ]'
pr 53 OPEN fix/c release "Elsewhere"
q adopt other-base 53
check "#807 a PR on another base is refused, naming both" '[ $rc -eq 11 ] && [[ "$out" == *"PR #53 is on release, not this batch'"'"'s base main"* ]]'
pr 54 OPEN fix/a main "A ticket's own"
q adopt dup-branch 54
check "#807 a PR whose branch a ticket already has is refused" '[ $rc -eq 11 ] && [[ "$out" == *"branch fix/a is already fix-a'"'"'s"* ]]'
q adopt missing 99
check "#807 a PR gh cannot read is refused, saying why" '[ $rc -eq 11 ] && [[ "$out" == *"gh could not read PR #99 on acme/widgets (no pull requests found for #99)"* ]]'

rm -rf "$T"
echo "queue adopt: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
