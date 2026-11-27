#!/usr/bin/env bash
# suite: queue adopt (a PR opened in the batch with no ticket)
# layer: L2
# queue.mjs adopt takes an open PR into the batch's base in as a done ticket on that PR, by its branch,
# so the merge driver merges it and the pass and desk-q list it; it refuses a key the driver would not
# take, a PR that is not open, one on another base, and a branch another ticket already has.
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

## 4. Project
| Field | Value |
|---|---|
| Tracker | `none` |
| Ticket key pattern | `ABC-[0-9]+` |
EOF
# gh pr view <n>: the PR's JSON from $T/pr-<n>.json, or exit 1 naming it.
cat > "$T/bin/gh" <<'EOF'
#!/usr/bin/env bash
[ "$1 $2" = "pr view" ] || exit 2
f="$GH_DIR/pr-$3.json"; [ -f "$f" ] || { echo "no pull requests found for #$3" >&2; exit 1; }
[ -f "$GH_DIR/slow" ] && sleep 1   # a slow GitHub, so two adopts overlap
cat "$f"
EOF
chmod +x "$T/bin/gh"
export DESK_GITHUB_HANDLE=me PATH="$T/bin:$PATH" GH_DIR="$T" DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue.json" DESK_REPO_DIR="$T/repo"
git init -q "$T/repo"; mkdir -p "$T/repo/.claude"
q(){ out=$(node "$B/queue.mjs" "$@" 2>&1); rc=$?; }
f(){ node -e 'let v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]; for (const p of process.argv[3].split(".")) v = v?.[p]; console.log(JSON.stringify(v));' "$DESK_QUEUE" "$1" "$2"; }
pr(){ printf '{"number":%s,"state":"%s","headRefName":"%s","baseRefName":"%s","title":"%s","author":{"login":"%s"}}\n' "$1" "$2" "$3" "$4" "$5" "${6:-me}" > "$T/pr-$1.json"; }

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
pr 55 OPEN fix/d main "Someone else's" them
q adopt their-pr 55
check "#807 a PR by another author than §1 GitHub handle is refused, since the driver would not merge it" '[ $rc -eq 11 ] && [[ "$out" == *"PR #55 is by them, and the merge driver merges only PRs by me"* ]]'
pr 56 OPEN fix/e main "Tracker"
q adopt ABC-12 56
check "#807 a tracker key is refused without --filed: the driver would move that ticket to Done" '[ $rc -eq 11 ] && [[ "$out" == *"ABC-12 is a tracker key, and the merge driver moves that ticket to Done when PR #56 merges"* ]] && [ "$(f ABC-12 state)" = undefined ]'
q adopt ABC-12 56 --filed
check "#807 with --filed, the ticket filed for the PR is adopted" '[ $rc -eq 0 ] && [ "$(f ABC-12 result.pr)" = "\"56\"" ]'
q requeue flaky-spec
check "#807 an adopted PR is never requeued for a worker, saying what settles it" '[ $rc -eq 11 ] && [[ "$out" == *"flaky-spec is PR #51, adopted with no ticket, so no worker takes it"* ]] && [ "$(f flaky-spec state)" = "\"done\"" ]'
# Two adopts at once both land: each holds the queue lock from read to save.
pr 57 OPEN fix/f main "One"; pr 58 OPEN fix/g main "Two"
touch "$T/slow"
node "$B/queue.mjs" adopt para-one 57 >/dev/null 2>&1 & node "$B/queue.mjs" adopt para-two 58 >/dev/null 2>&1 & wait
rm -f "$T/slow"
out=""
check "#807 adopts made at once both land" '[ "$(f para-one result.pr)" = "\"57\"" ] && [ "$(f para-two result.pr)" = "\"58\"" ]'
q adopt missing 99
check "#807 a PR gh cannot read is refused, saying why" '[ $rc -eq 11 ] && [[ "$out" == *"gh could not read PR #99 on acme/widgets (no pull requests found for #99)"* ]]'
# #1532 AC5: a done red-base repair gives its branch up to the fix PR adopted from it; a live one does not.
q add base-red-main-20261126175511; q set base-red-main-20261126175511 branch=fix/base-red-main-20261126175511 state=done
pr 59 OPEN fix/base-red-main-20261126175511 main "Guard subscription-access-ending-soon"
q adopt ABC-13 59 --filed
check "#1532 AC5 a done repair's branch is taken over by the adopted fix PR, saying so" '[ $rc -eq 0 ] && [[ "$out" == *"base-red-main-20261126175511 is a done red-base repair, so it gave up its branch fix/base-red-main-20261126175511"* ]] && [ "$(f ABC-13 branch)" = "\"fix/base-red-main-20261126175511\"" ] && [ "$(f base-red-main-20261126175511 branch)" = null ]'
q add base-red-main-20261126190000; q set base-red-main-20261126190000 branch=fix/base-red-live state=parked
pr 60 OPEN fix/base-red-live main "Still the repair's"
q adopt ABC-14 60 --filed
check "#1532 AC5 a repair that is not done keeps its branch: refused as before" '[ $rc -eq 11 ] && [[ "$out" == *"branch fix/base-red-live is already base-red-main-20261126190000'"'"'s: nothing adopted"* ]]'

rm -rf "$T"
echo "queue adopt: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
