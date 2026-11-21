#!/usr/bin/env bash
# suite: queue finish (a parked ticket whose last step the orchestrator finished)
# queue.mjs finish records a parked ticket done on its PR, as the pass records one whose draft PR it
# opened, and refuses a ticket that is not parked and a PR that is not open or merged, from a fork, on
# another branch or into another base. A running, held or claimed ticket, a spine or plan park, and a
# feature spine are refused too, and every refusal leaves the queue as it was.
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
# gh pr view <n>: the PR's JSON from $T/pr-<n>.json, or exit 1 naming it. Each call is logged.
cat > "$T/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$GH_DIR/gh.calls"
[ "$1 $2" = "pr view" ] || exit 2
f="$GH_DIR/pr-$3.json"; [ -f "$f" ] || { echo "no pull requests found for #$3" >&2; exit 1; }
cat "$f"
EOF
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH" GH_DIR="$T" DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue.json" DESK_REPO_DIR="$T/repo"
git init -q "$T/repo"; mkdir -p "$T/repo/.claude"
q(){ out=$(node "$B/queue.mjs" "$@" 2>&1); rc=$?; }
f(){ node -e 'let v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]; for (const p of process.argv[3].split(".")) v = v?.[p]; console.log(JSON.stringify(v));' "$DESK_QUEUE" "$1" "$2"; }
sum(){ cksum < "$DESK_QUEUE"; }
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

# DS-826 AC2: a ticket held behind it waits on its PR's merge, as behind any done ticket.
q add F-2; q set F-2 state=triaged lane=A branch=feat/F-2-thing; q hold F-2 fix-a
check "DS-826 AC2: a ticket held behind it waits on its merge" '[ "$(node --input-type=module -e "import { waitingOnMerge } from \"$B/batch-state.mjs\"; const q = JSON.parse((await import(\"node:fs\")).readFileSync(process.argv[1], \"utf8\")); console.log(waitingOnMerge(q, q.tickets[\"F-2\"]))" "$DESK_QUEUE")" = true ]'

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
before=$(sum); : > "$T/gh.calls"; q finish "" --pr 66
check "DS-826 an empty ticket is refused with the usage, before asking GitHub" '[ $rc -eq 11 ] && [[ "$out" == *"usage: queue.mjs finish <TICKET> --pr <PR number>"* ]] && [ ! -s "$T/gh.calls" ] && [ "$(sum)" = "$before" ]'
pr 66 MERGED false fix/fix-b
q finish fix-b --pr 66
check "#822 a merged PR is recorded, and no draft is set" '[ $rc -eq 0 ] && [[ "$out" == *"PR #66 (merged,"* ]] && [ "$(f fix-b draft_pr)" = undefined ]'
q finish nope --pr 66
check "#822 a ticket not in the queue is refused" '[ $rc -eq 11 ] && [[ "$out" == *"nope"* ]]'

# DS-826 AC4: a running ticket is refused as having a live worker.
q add F-4; q set F-4 state=triaged lane=A branch=feat/F-4-thing; q set F-4 state=running session_id=s-1
pr 70 OPEN true feat/F-4-thing
before=$(sum); q finish F-4 --pr 70
check "DS-826 AC4: a running ticket is refused as having a live worker" '[ $rc -ne 0 ] && [[ "$out" == *"F-4 has a live worker"* ]] && [ "$(sum)" = "$before" ]'

# A held ticket has no step of its own to finish.
pr 71 OPEN true feat/F-2-thing
before=$(sum); q finish F-2 --pr 71
check "DS-826 a held ticket is refused" '[ $rc -ne 0 ] && [[ "$out" == *"F-2 is held"* ]] && [ "$(sum)" = "$before" ]'

# A spine awaiting approval, or an epic's plan awaiting an answer, has an open PR on its own branch too,
# but its park is the person's call: finish never clears it.
for k in F-6 F-7; do
  if [ "$k" = F-6 ]; then c='spine awaiting approval: specs passed'; else c='feature plan awaiting your answer: 3 children'; fi
  q add "$k"; q set "$k" state=triaged lane=A "branch=feat/$k-thing"; q set "$k" state=parked "park={\"question\":\"$c\"}"
  pr 72 OPEN true "feat/$k-thing"
  before=$(sum); q finish "$k" --pr 72
  check "DS-826 a park awaiting the person's answer is refused (${c%%:*})" '[ $rc -ne 0 ] && [[ "$out" == *"$k waits on the person"*"answer"* ]] && [ "$(sum)" = "$before" ]'
done

# A park an interactive session claimed is that session's to finish.
q add F-9; q set F-9 branch=feat/F-9-thing; q park F-9 "AUTOPILOT_PARK: jira comment refused"
q set F-9 'park.claim={"session":"0b7c2a9e-1111-4222-8333-444455556666","at":"2026-11-20T09:05:00.000Z"}'
pr 73 OPEN true feat/F-9-thing
before=$(sum); q finish F-9 --pr 73
check "DS-826 a park an interactive session claimed is refused" '[ $rc -ne 0 ] && [[ "$out" == *"F-9 is claimed by interactive session 0b7c2a9e"* ]] && [ "$(sum)" = "$before" ]'

# A feature spine parked on a step of its own: the pass checks its specs as it records it done, so
# finish leaves it to a requeue. (Last, as it makes this a feature batch.)
q add F-8; q set F-8 branch=feat/F-8-thing; q park F-8 "AUTOPILOT_PARK: jira comment refused"; q set-batch feature=true spine=F-8
pr 74 OPEN true feat/F-8-thing
before=$(sum); q finish F-8 --pr 74
check "DS-826 a feature spine is refused, pointing to requeue" '[ $rc -ne 0 ] && [[ "$out" == *"F-8 is its feature batch'"'"'s spine"*"queue.mjs requeue F-8"* ]] && [ "$(sum)" = "$before" ]'

# DS-826 AC6: the recovery row for a park on a single remaining step names the command.
check "DS-826 AC6: the recovery reference names queue.mjs finish on that row" 'grep -E "^\| a worker.s .AUTOPILOT_PARK. on a single remaining step" "$S/../skills/desk-autopilot/references/orchestrator-recovery.md" | grep -q "queue.mjs finish <TICKET> --pr <n>"'

rm -rf "$T"
echo "queue finish: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
