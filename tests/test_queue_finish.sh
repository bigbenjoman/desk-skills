#!/usr/bin/env bash
# suite: queue finish records a parked ticket done on its own open PR
# queue.mjs finish <TICKET> --pr <n>, run once the orchestrator has finished a park's last step itself:
# the ticket is recorded done on that PR with the fields pass.mjs writes for a draft it opened, so the
# next pass handles it as any done ticket. A running ticket, a PR on another branch, a PR that is not
# open, or one GitHub will not give, is refused and the queue left as it was.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"; T="$(mktemp -d)"
export HOME="$T/home"; mkdir -p "$HOME" "$T/state" "$T/fakes"
unset CLAUDE_CONFIG_DIR
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }
cat > "$T/config.md" <<'EOF'
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | `acme/widgets` |
| Default branch | `main` |
EOF
export DESK_CONFIG="$T/config.md" DESK_QUEUE="$T/queue.json" DESK_REPO_DIR="$T/repo" DESK_AUTOPILOT_STATE="$T/state"
git init -q "$T/repo"
# The fake gh: answers `pr view` with $T/pr.json, or fails as GitHub would while $T/gh.fail exists.
cat > "$T/fakes/gh" <<EOF
#!/bin/sh
echo "\$*" >> "$T/gh.calls"
[ -f "$T/gh.fail" ] && { echo "HTTP 502: Bad Gateway (https://api.github.com/graphql)" >&2; exit 1; }
cat "$T/pr.json"
EOF
chmod +x "$T/fakes/gh"
export PATH="$T/fakes:$PATH"
pr(){ printf '{"headRefName":"%s","state":"%s","isCrossRepository":%s}\n' "$1" "${2:-OPEN}" "${3:-false}" > "$T/pr.json"; }

q(){ out=$(node "$B/queue.mjs" "$@" 2>&1); rc=$?; }
# f <KEY> <path>: the JSON of that ticket's field at that dotted path.
f(){ node -e 'let v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).tickets[process.argv[2]]; for (const p of process.argv[3].split(".")) v = v?.[p]; console.log(JSON.stringify(v));' "$DESK_QUEUE" "$1" "$2"; }
sum(){ cksum < "$DESK_QUEUE"; }
parked(){ q add "$1"; q set "$1" state=triaged lane=A "branch=feat/$1-thing"; q set "$1" state=parked stage=8/9 handoff_stage=4b 'park={"question":"jira comment refused: post it","since":"2026-11-20T09:00:00.000Z"}'; }

q init t

# AC1: a parked ticket whose own branch has open PR #41.
parked F-1
pr feat/F-1-thing OPEN
q finish F-1 --pr 41
check "AC1: finish records the ticket done"                           '[ $rc -eq 0 ] && [ "$(f F-1 state)" = "\"done\"" ] && [[ "$out" == *"F-1 recorded done on PR #41"* ]]'
check "AC1: its PR is the result, and its draft PR as the pass records" '[ "$(f F-1 result.pr)" = 41 ] && [ "$(f F-1 draft_pr)" = 41 ]'
check "AC1: its park and handoff stage are cleared"                    '[ "$(f F-1 park)" = null ] && [ "$(f F-1 handoff_stage)" = null ]'
check "AC1: its summary says who recorded it and what the park was"   '[[ "$(f F-1 result.summary)" == *"recorded done by the orchestrator"*"jira comment refused"* ]]'
check "AC1: the PR was read from the config repo"                     'grep -q "pr view 41 --repo acme/widgets --json headRefName,state,isCrossRepository" "$T/gh.calls"'

# AC2: a ticket held behind it waits on its PR's merge, as behind any done ticket, and is not stuck.
q add F-2; q set F-2 state=triaged lane=A branch=feat/F-2-thing; q hold F-2 F-1
check "AC2: a ticket held behind it waits on its merge"               '[ "$(node --input-type=module -e "import { waitingOnMerge } from \"$B/batch-state.mjs\"; const q = JSON.parse((await import(\"node:fs\")).readFileSync(process.argv[1], \"utf8\")); console.log(waitingOnMerge(q, q.tickets[\"F-2\"]))" "$DESK_QUEUE")" = true ]'

# AC3: PR #42's head is another branch.
parked F-3
pr feat/OTHER-9-thing OPEN
before=$(sum); q finish F-3 --pr 42
check "AC3: a PR on another branch is refused naming both"            '[ $rc -ne 0 ] && [[ "$out" == *"feat/OTHER-9-thing"*"feat/F-3-thing"* ]] && [ "$(sum)" = "$before" ]'

# AC4: a running ticket.
q add F-4; q set F-4 state=triaged lane=A branch=feat/F-4-thing; q set F-4 state=running session_id=s-1
pr feat/F-4-thing OPEN
before=$(sum); q finish F-4 --pr 43
check "AC4: a running ticket is refused as having a live worker"      '[ $rc -ne 0 ] && [[ "$out" == *"F-4 has a live worker"* ]] && [ "$(sum)" = "$before" ]'

# AC5: GitHub does not answer.
parked F-5
touch "$T/gh.fail"
before=$(sum); q finish F-5 --pr 44
check "AC5: an unreadable PR is refused naming the error"             '[ $rc -ne 0 ] && [[ "$out" == *"PR #44 could not be read from GitHub (HTTP 502: Bad Gateway"* ]] && [ "$(sum)" = "$before" ]'
rm -f "$T/gh.fail"

# A PR that is not open, a ticket that is not parked, and a malformed call change nothing either.
pr feat/F-5-thing CLOSED
before=$(sum); q finish F-5 --pr 44
check "a closed PR is refused"                                         '[ $rc -ne 0 ] && [[ "$out" == *"PR #44 is closed, not open"* ]] && [ "$(sum)" = "$before" ]'
pr feat/F-5-thing OPEN true
before=$(sum); q finish F-5 --pr 44
check "a fork's PR on a same-named branch is refused"                 '[ $rc -ne 0 ] && [[ "$out" == *"PR #44 is from a fork"* ]] && [ "$(sum)" = "$before" ]'
pr feat/F-1-thing OPEN
before=$(sum); q finish F-1 --pr 41
check "a ticket already done is refused"                               '[ $rc -ne 0 ] && [[ "$out" == *"F-1 is not parked"* ]] && [ "$(sum)" = "$before" ]'
q finish F-2 --pr 41
check "a held ticket is refused"                                       '[ $rc -ne 0 ] && [[ "$out" == *"F-2 is not parked on a step of its own"*"held"* ]] && [ "$(sum)" = "$before" ]'
q finish F-5 41
check "a call without --pr is refused with its usage"                  '[ $rc -ne 0 ] && [[ "$out" == *"usage: queue.mjs finish <TICKET> --pr <n>"* ]] && [ "$(sum)" = "$before" ]'

# A spine awaiting approval, or an epic's plan awaiting an answer, has an open PR on its own branch too,
# but its park is the person's call: finish never clears it.
for k in F-6 F-7; do
  if [ "$k" = F-6 ]; then c='spine awaiting approval: specs passed'; else c='feature plan awaiting your answer: 3 children'; fi
  q add "$k"; q set "$k" state=triaged lane=A "branch=feat/$k-thing"; q set "$k" state=parked "park={\"question\":\"$c\"}"
  pr "feat/$k-thing" OPEN
  before=$(sum); q finish "$k" --pr 45
  check "a park awaiting the person's answer is refused (${c%%:*})" '[ $rc -ne 0 ] && [[ "$out" == *"$k waits on the person"*"answer"* ]] && [ "$(sum)" = "$before" ]'
done

# A park an interactive session claimed is that session's to finish.
parked F-9; q set F-9 'park.claim={"session":"0b7c2a9e-1111-4222-8333-444455556666","at":"2026-11-20T09:05:00.000Z"}'
pr feat/F-9-thing OPEN
before=$(sum); q finish F-9 --pr 47
check "a park an interactive session claimed is refused"              '[ $rc -ne 0 ] && [[ "$out" == *"F-9 is claimed by interactive session 0b7c2a9e"* ]] && [ "$(sum)" = "$before" ]'

# A feature spine parked on a step of its own: the pass checks its specs as it records it done, so
# finish leaves it to a requeue. (Last, as it makes this a feature batch.)
parked F-8; q set-batch feature=true spine=F-8
pr feat/F-8-thing OPEN
before=$(sum); q finish F-8 --pr 46
check "a feature spine is refused, pointing to requeue"               '[ $rc -ne 0 ] && [[ "$out" == *"F-8 is its feature batch'"'"'s spine"*"queue.mjs requeue F-8"* ]] && [ "$(sum)" = "$before" ]'

# AC6: the recovery row for a park on a single remaining step names the command.
check "AC6: the recovery reference names queue.mjs finish on that row" 'grep -E "^\| a worker.s .AUTOPILOT_PARK. on a single remaining step" "$S/../skills/desk-autopilot/references/orchestrator-recovery.md" | grep -q "queue.mjs finish <TICKET> --pr <n>"'

rm -rf "$T"
echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
