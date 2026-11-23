#!/usr/bin/env bash
# suite: batch end to end, feature mode (spine, children, batch base gate, promotion slices, logins)
# layer: L3
# The second half of the offline end-to-end batch (the first is tests/test_batch_e2e.sh), on its own
# queue: feature batches driven through the real queue.mjs admit, approve and reject, pass.mjs,
# setup-worktree.sh, spawn-worker.sh (preflight included), harvest.mjs and answer.mjs. Only `claude`
# and `gh` are replaced, by the fakes tests/batch_e2e_setup.sh puts on PATH, with git offline and origin
# a local bare repo, so a real claude, gh, codex or desk-jira is never reachable.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
# shellcheck source=batch_e2e_setup.sh
. "$(dirname "$0")/batch_e2e_setup.sh"
q init e2e

# ---- feature spine: checked, parked draft for approval, approved, merged, children released --------
config
q set-batch feature=true spine=T-20 'spine_ids=["AC1","AC2","AC3"]'
record T-20 tests/acceptance/feature.spec.ts; record T-21 src/s.txt; record T-22 src/t.txt
printf 'WAIT\nAUTOPILOT_DONE: pr=120 jira=none\n' > "$T/scripts/T-20.1"
printf 'WAIT\nAUTOPILOT_DONE: pr=120 jira=none\n' > "$T/scripts/T-20.2"
printf 'WAIT\nAUTOPILOT_DONE: pr=120 jira=none\n' > "$T/scripts/T-20.3"
printf 'WAIT\nAUTOPILOT_DONE: pr=121 jira=none\n' > "$T/scripts/T-21.1"
printf 'WAIT\nAUTOPILOT_DONE: pr=122 jira=none\n' > "$T/scripts/T-22.1"
q admit T-20; q admit T-21; q admit T-22; q hold T-21 T-20; q hold T-22 T-20
# spec <path> <content>: the spine worker's commit on its branch.
spec(){ mkdir -p "$(dirname "$T/wt/T-20/$1")"; printf '%s\n' "$2" > "$T/wt/T-20/$1"
  git -C "$T/wt/T-20" add -A && git -C "$T/wt/T-20" commit -q -m "spec $1"; }
pass
check "the spine spawns first and the children it holds do not" '[ "$(state T-20)" = running ] && [ "$(state T-21)" = parked ] && [ ! -e "$T/runs/T-21.1" ]'

# AC2: a spec that is not expected-fail, and an id with no spec.
spec tests/acceptance/feature.spec.ts "import { test } from 'vitest';
test.fails('AC1: a finished spine parks for approval', () => {});
test('AC2: incomplete specs park', () => {});
test.describe('AC3 group', () => {});
// test.fails('AC3: commented out, so not a spec', () => {});"
finish T-20
pass
check "AC2: incomplete specs park the spine naming each problem, exit 11" '[ $rc -eq 11 ] && [ "$(state T-20)" = parked ] && field T-20 park | grep -q "spine specs incomplete" && field T-20 park | grep -q "AC2: .*not marked strict expected-fail" && field T-20 park | grep -q "AC3: no spec titled with it"'
check "AC2: no approval is offered"                             '! field T-20 park | grep -q "approve" && ! echo "$out" | grep -q "queue.mjs approve"'
out=$(node "$B/queue.mjs" approve T-20 2>&1); rc=$?
check "AC2: approve refuses a spine whose specs failed the check" '[ $rc -eq 11 ] && echo "$out" | grep -q "failed the check" && [ "$(state T-20)" = parked ]'
check "AC2: the children wait on the spine, not STUCK"          '! echo "$(node "$B/queue.mjs" render)" | grep -q STUCK && [ "$(state T-21)" = parked ]'
out=$(node "$B/queue.mjs" reject T-20 "AC2 must be marked expected-fail and AC3 needs a spec" 2>&1); rc=$?
check "the spine is sent back with a note"                      '[ $rc -eq 0 ] && [ "$(state T-20)" = triaged ] && [ "$(state T-21)" = parked ]'
pass
check "a new spine worker gets the note"                        '[ "$(state T-20)" = running ] && grep -q "AC3 needs a spec" "$T/runs/T-20.2"'

# AC1 + AC3: one strict expected-fail spec per id, in TypeScript and in Python.
spec tests/acceptance/feature.spec.ts "import { test, it } from 'vitest';
test.fails('AC1: a finished spine parks for approval', () => {});
it.fails('AC2: incomplete specs park', () => {});"
spec tests/acceptance/test_feature.py "import pytest

@pytest.mark.xfail(
    strict=True, reason='not built yet')
def test_ac3_children_wait():
    assert False"
finish T-20
pass
check "AC1: complete specs park the spine for approval"          '[ "$(state T-20)" = parked ] && field T-20 park | grep -q "spine awaiting approval" && [ "$(field T-20 result.pr)" = 120 ]'
check "AC1: its PR stays draft"                                  '! grep -q "pr ready" "$T/gh.log"'
check "AC3: the children show as waiting on approval, not STUCK, and the pass exits 11" '[ $rc -eq 11 ] && echo "$out" | grep -q "WAITING ON APPROVAL: T-21 (spine T-20), T-22 (spine T-20)" && ! echo "$out" | grep -q STUCK && echo "$out" | grep -q "T-20: SPINE APPROVAL"'
check "AC3: the batch is not reported idle"                      '! echo "$out" | grep -q "^IDLE" && ! echo "$out" | grep -q "batch is finished"'

# AC7: rejected with a note from the approval park: a new worker gets it, and nothing is released.
out=$(node "$B/queue.mjs" reject T-20 "AC1's spec checks the wrong state" 2>&1); rc=$?
# Even with its PR merged by hand, a rejected spine releases nothing.
echo MERGED > "$T/pr/120"
pass
check "AC7: a new spine worker gets the note"                    '[ $rc -eq 0 ] && [ "$(state T-20)" = running ] && [ "$(field T-20 approved)" = null ] && grep -q "checks the wrong state" "$T/runs/T-20.3"'
check "AC7: nothing is released"                                 '[ "$(state T-21)" = parked ] && [ "$(state T-22)" = parked ] && [ ! -e "$T/runs/T-21.1" ] && ! echo "$out" | grep -q "RELEASE DUE"'
rm "$T/pr/120"
finish T-20
pass
check "the reworked spine parks for approval again"             '[ "$(state T-20)" = parked ] && field T-20 park | grep -q "spine awaiting approval"'

# AC4 + AC5: approved, the spine is done and its PR leaves draft; with no merge grant the person merges.
out=$(node "$B/queue.mjs" approve T-20 2>&1); rc=$?
check "AC4: approve marks the spine done and undrafts its PR"    '[ "$(state T-20)" = done ] && [ "$(field T-20 approved)" = true ] && grep -q "^pr ready 120 --repo acme/widgets" "$T/gh.log"'
check "AC5: with no merge grant, approve asks the person to merge the spine PR" '[ $rc -eq 11 ] && echo "$out" | grep -q "merge PR #120 yourself" && echo "$out" | grep -q "T-21, T-22 are released once it merges"'
pass
check "AC5: the pass report asks for the merge too, and the children are not released" '[ $rc -eq 11 ] && echo "$out" | grep -q "T-20: SPINE APPROVED — merge PR #120" && [ "$(state T-21)" = parked ] && echo "$out" | grep -q "WAITING ON MERGE: T-21 (T-20)"'

# AC6: once the spine PR merges, the children are released and spawn on a later pass.
echo MERGED > "$T/pr/120"
pass
check "AC6: a merged spine releases the children, with no merge driver running" 'echo "$out" | grep -q "^released: T-21" && echo "$out" | grep -q "^released: T-22" && ! echo "$out" | grep -q "RELEASE DUE" && ! echo "$out" | grep -q "SPINE APPROVED"'
pass
check "AC6: the released children spawn"                         '[ "$(state T-21)" = running ] && [ "$(state T-22)" = running ]'
finish T-21; finish T-22
pass

# An approved spine sent back again needs a fresh approval, and its PR back in draft.
out=$(node "$B/queue.mjs" requeue T-20 2>&1)
check "requeueing an approved spine clears its approval and says its PR left draft" '[ "$(field T-20 approved)" = null ] && echo "$out" | grep -q "gh pr ready 120 --repo acme/widgets --undo"'
# Its worktree holds the spine's unpushed spec commits, which drop refuses to discard: discarded first.
check "drop refuses a worktree holding unpushed commits, naming it" 'node "$B/queue.mjs" drop T-20 2>&1 | grep -q "$T/wt/T-20 holds work origin does not have (.*commit(s) not pushed" && [ -d "$T/wt/T-20" ]'
git -C "$T/repo" worktree remove --force "$T/wt/T-20"; q drop T-20

# ---- feature children: each makes the specs it owns pass and leaves the others alone ----------------
# The merged spine's specs on main, and an acceptance runner that logs the ids it was given and fails
# any id listed in tests/acceptance/failing on the branch.
mkdir -p "$T/repo/tests/acceptance"
SPECS="import { test } from 'vitest';
test.fails('AC1: an owner makes its spec pass', () => {});
test.fails('AC2: a failing spec parks', () => {});
test.fails('AC3: other specs are left alone', () => {});"
printf '%s\n' "$SPECS" > "$T/repo/tests/acceptance/feature.spec.ts"
cat > "$T/repo/tests/acceptance/run.sh" <<EOF
echo "\$1" >> "$T/specs-run.log"
grep -qx "\$1" tests/acceptance/failing 2>/dev/null && { echo "\$1 failed: expected true, got false"; exit 1; }
exit 0
EOF
git -C "$T/repo" add -A && git -C "$T/repo" commit -q -m "spine specs" && git -C "$T/repo" push -q origin main
q set-batch 'owners={"AC1":"T-31","AC2":"T-32","AC3":"T-33"}'
record T-31 src/u.txt; record T-32 src/v.txt; record T-33 src/w.txt; record T-34 src/x.txt
for k in T-31 T-32 T-33 T-34; do printf 'WAIT\nAUTOPILOT_DONE: pr=1%s jira=none\n' "${k#T-}" > "$T/scripts/$k.1"; q admit "$k"; done
printf 'WAIT\nAUTOPILOT_DONE: pr=132 jira=none\n' > "$T/scripts/T-32.2"
printf 'WAIT\nAUTOPILOT_DONE: pr=132 jira=none\n' > "$T/scripts/T-32.3"
# commit_in <TICKET> <path> <content>: the child worker's commit on its branch; content - deletes it.
commit_in(){ if [ "$3" = - ]; then git -C "$T/wt/$1" rm -q "$2"; else mkdir -p "$(dirname "$T/wt/$1/$2")"; printf '%s\n' "$3" > "$T/wt/$1/$2"; fi
  git -C "$T/wt/$1" add -A && git -C "$T/wt/$1" commit -q -m "$1 $2"; }
# unmark <id> [<spec text>]: the spec text with that id's expected-fail marker removed.
unmark(){ printf '%s\n' "${2:-$SPECS}" | sed "s/test.fails('$1:/test('$1:/"; }
pass
brief31="$T/state/briefings/T-31.md"
check "AC1: a child that owns a criterion is told which spec it owns and to make it pass" 'grep -q "^## Acceptance specs you own" "$brief31" && grep -qF -- "- AC1: \"AC1: an owner makes its spec pass\" in tests/acceptance/feature.spec.ts" "$brief31" && grep -q "remove the marker that makes it strict expected-fail" "$brief31" && grep -q "make it pass" "$brief31"'
check "AC1: it is told only its own spec, and the run that checks it" '! grep -q "AC2: a failing spec parks" "$brief31" && grep -qF "bash tests/acceptance/run.sh AC1" "$brief31"'
check "AC1: the worker gets that section in its instructions" 'grep -q "Acceptance specs you own" "$T/runs/T-31.1"'

# AC2: T-31 unmarks its spec, and it passes.
commit_in T-31 tests/acceptance/feature.spec.ts "$(unmark AC1)"
# AC3: T-32 leaves its spec marked expected-fail.
commit_in T-32 src/v.txt "built"
# AC4: T-33 makes its own spec pass but also changes AC1's, which T-31 owns.
commit_in T-33 tests/acceptance/feature.spec.ts "$(unmark AC3 | sed "s/'AC1: an owner makes its spec pass', () => {}/'AC1: an owner makes its spec pass', () => { expect(1).toBe(1); }/")"
finish T-31; finish T-32; finish T-33
pass
check "AC2: an owner whose spec is unmarked and passes is done, as today" '[ "$(state T-31)" = done ] && [ "$(field T-31 result.pr)" = 131 ] && [ "$(field T-31 spec_check.ok)" = true ]'
check "the pass runs only the child's own specs" 'grep -qx "AC1" "$T/specs-run.log" && ! grep -q "AC2\|AC3" "$T/specs-run.log"'
check "AC3: an owned spec still marked expected-fail parks naming it" '[ "$(state T-32)" = parked ] && field T-32 park | grep -q "acceptance specs not done: AC2: .*AC2: a failing spec parks.* in tests/acceptance/feature.spec.ts is still marked expected-fail" && echo "$out" | grep -q "^PARKED:"'
check "AC4: a child that changed a spec another child owns parks naming the spec and its owner" '[ "$(state T-33)" = parked ] && field T-33 park | grep -q "AC1: an owner makes its spec pass.* in tests/acceptance/feature.spec.ts is AC1'\''s spec, owned by T-31: T-33 changed it"'
check "AC4: its own spec passing is not what parked it" '! field T-33 park | grep -q "AC3:"'
check "a child that owns nothing has no section, and runs as today" 'live T-34 && ! grep -q "Acceptance specs you own" "$T/state/briefings/T-34.md"'
finish T-34
pass
check "a child that owns nothing is done without a spec check"  '[ "$(state T-34)" = done ] && [ "$(field T-34 spec_check)" = null ]'

# AC3: unmarked but failing when run parks too, naming the spec; fixed, it is done.
node "$B/answer.mjs" T-32 "remove the marker on AC2's spec and make it pass" >/dev/null 2>&1; q requeue T-32
pass
commit_in T-32 tests/acceptance/feature.spec.ts "$(unmark AC2)"
commit_in T-32 tests/acceptance/failing "AC2"
finish T-32
pass
check "AC3: an owned spec that fails when run parks naming it"  '[ "$(state T-32)" = parked ] && field T-32 park | grep -q "acceptance specs not done: AC2: .*AC2: a failing spec parks.* in tests/acceptance/feature.spec.ts fails when run (bash tests/acceptance/run.sh AC2): AC2 failed"'
node "$B/answer.mjs" T-32 "AC2 still fails" >/dev/null 2>&1; q requeue T-32
pass
commit_in T-32 tests/acceptance/failing -
finish T-32
pass
check "AC3: once it passes the child is done"                   '[ "$(state T-32)" = done ] && [ "$(field T-32 spec_check.ok)" = true ] && [ "$(field T-32 park)" = null ]'

# ---- feature mode on a batch base: a draft promotion PR at the start, the base gate at the end ------
# tc.sh, lint.sh and tests/run.sh stand in for §4 Typecheck, Lint and Unit tests: each logs where it
# ran to checks.log, and fails while a broken-<name> file is on the branch.
check_script(){ mkdir -p "$(dirname "$T/repo/$2")"
  printf 'echo "%s $(pwd)" >> "%s/checks.log"\n[ ! -e broken-%s ] || { echo "%s failed: broken-%s is here"; exit 1; }\n' "$1" "$T" "$1" "$1" "$1" > "$T/repo/$2"; }
check_script tc tc.sh; check_script lint lint.sh; check_script tests tests/run.sh
git -C "$T/repo" add -A && git -C "$T/repo" commit -q -m "base checks" && git -C "$T/repo" push -q origin main
# Wait for the background gate to write its result.
wait_gate(){ for _ in $(seq 1 300); do [ "$(bfield gate.state)" = '"running"' ] || return 0; sleep 0.1; done; echo "the base gate did not finish"; }

# AC2: a base protected against the empty commit: no promotion PR, the refusal reported, the batch carries on.
git -C "$T/repo" push -q origin main:feat/R
printf '#!/bin/sh\nwhile read -r old new ref; do [ "$ref" = refs/heads/feat/R ] && { echo "error: GH006: Protected branch update failed for $ref." >&2; exit 1; }; done\nexit 0\n' > "$T/origin.git/hooks/pre-receive"
chmod +x "$T/origin.git/hooks/pre-receive"
q init refused; q set-batch base=feat/R epic=E-1 feature=true
record T-50 src/r.txt; printf 'WAIT\nAUTOPILOT_DONE: pr=150 jira=none\n' > "$T/scripts/T-50.1"; q admit T-50
: > "$T/gh.log"
pass
check "AC2: a refused empty-commit push opens no promotion PR" '! grep -q "^pr create" "$T/gh.log" && [ "$(git -C "$T/origin.git" rev-parse feat/R)" = "$(git -C "$T/origin.git" rev-parse main)" ] && [ "$(bfield promotion.pr)" = null ]'
check "AC2: the report names the refusal under WAITING ON YOU" 'echo "${out#*WAITING ON YOU}" | grep -q "promotion PR: not opened — the push of an empty commit to feat/R was refused: .*GH006"'
check "AC2: the batch carries on: the child spawns"              '[ "$(state T-50)" = running ]'
pass
check "AC2: it is tried once, not on every pass"                '! grep -q "^pr create" "$T/gh.log" && ! echo "$out" | grep -q "promotion PR: not opened"'
rm "$T/origin.git/hooks/pre-receive"
finish T-50
pass
check "a child whose PR is still open keeps the gate waiting, and the batch not idle" 'echo "$out" | grep -q "BASE GATE: waits on T-50 (PR #150) merging into feat/R, and no merge driver is running" && ! echo "$out" | grep -q "^IDLE" && [ "$(bfield gate)" = null ]'
echo CLOSED > "$T/pr/150"
pass
check "a child PR closed without merging: the gate does not run, and the batch reaches the person" 'echo "${out#*WAITING ON YOU}" | grep -q "BASE GATE: not run, since T-50 (PR #150 closed without merging) cannot merge into feat/R" && echo "$out" | grep -q "^IDLE" && [ "$(bfield gate)" = null ]'

# AC1: a base with nothing beyond main gets one empty commit and a draft promotion PR titled with the epic key.
git -C "$T/repo" push -q origin main:feat/E
q init feature; q set-batch base=feat/E epic=E-1 feature=true 'spine_ids=["AC1","AC2"]'
printf '{"parent": "E-1", "containers": {}, "criteria": [{"id": "AC1", "text": "one"}, {"id": "AC2", "text": "two"}, {"id": "AC3", "text": "three"}]}\n' > "$T/state/expansion.json"
record T-51 src/p.txt; record T-52 src/q.txt
printf 'WAIT\nAUTOPILOT_PARK: which helper should the spec use?\n' > "$T/scripts/T-51.1"
printf 'WAIT\nAUTOPILOT_DONE: pr=151 jira=none\n' > "$T/scripts/T-51.2"
printf 'WAIT\nAUTOPILOT_DONE: pr=152 jira=none\n' > "$T/scripts/T-52.1"
q admit T-51; q admit T-52
: > "$T/gh.log"
# What the person and a reviewer will have written on PR #200: its body, and a comment.
printf 'Notes from the person: check the summary screen.\n\n## After merge\n- tell support\n' > "$T/pr/200.body"; cp "$T/pr/200.body" "$T/pr/200.body.orig"
printf '%s' '[{"viewerDidAuthor":false,"body":"A reviewer: <!-- desk-autopilot:ledger --> looks odd","url":"https://github.com/acme/widgets/pull/200#issuecomment-1"}]' > "$T/pr/200.comments"
pass
check "AC1: one empty commit is pushed to the base"              '[ "$(git -C "$T/origin.git" rev-list --count main..feat/E)" = 1 ] && [ -z "$(git -C "$T/origin.git" diff main feat/E)" ]'
check "AC1: a draft promotion PR from the base to main is open, titled with the epic key" 'grep -q "^pr create --repo acme/widgets --draft --base main --head feat/E --title E-1: " "$T/gh.log" && [ "$(bfield promotion.pr)" = 200 ] && echo "$out" | grep -q "promotion PR #200 opened as a draft, feat/E → main"'
check "AC1: the children spawn"                                  '[ "$(state T-51)" = running ] && [ "$(state T-52)" = running ]'
pass
check "AC1: it is opened once"                                   '[ "$(grep -c "^pr create" "$T/gh.log")" = 1 ]'
check "ledger: one ledger comment on the promotion PR, one row per child, with its state and model" '[ "$(ledgers)" = 1 ] && ledger | grep -qE "^\| T-51 \| running \| — \| default \|$" && ledger | grep -qE "^\| T-52 \| running \| — \| default \|$" && [ "$(ledger | grep -c "^| T-")" = 2 ]'
check "ledger: it is created once, and an unchanged one is not written again" '[ "$(grep -c "^pr comment 200" "$T/gh.log")" = 1 ] && ! grep -q "^api -X PATCH" "$T/gh.log"'

# AC6: a parked child: the gate does not run, and the report lists it.
echo MERGED > "$T/pr/152"
finish T-51; finish T-52
pass
check "AC6: with a child parked the gate does not run, and the report names it" '[ $rc -eq 11 ] && [ "$(bfield gate)" = null ] && echo "${out#*WAITING ON YOU}" | grep -q "BASE GATE: not run, since 1 child(ren) did not finish: T-51 (parked: which helper"'
node "$B/answer.mjs" T-51 "use makeFixture" >/dev/null 2>&1; q requeue T-51
pass; finish T-51
pass
check "ledger: a child merging into the base rewrites its row in the same comment, with its PR" '[ "$(ledgers)" = 1 ] && ledger | grep -qE "^\| T-52 \| merged \| #152 \| default \|$" && ledger | grep -qE "^\| T-51 \| in review \| #151 \| default \|$" && grep -q "^api -X PATCH repos/acme/widgets/issues/comments/901 --input -" "$T/gh.log" && [ "$(grep -c "^pr comment 200" "$T/gh.log")" = 1 ]'
check "ledger: the PR body is never read or written, so the person's text is unchanged" 'cmp -s "$T/pr/200.body" "$T/pr/200.body.orig" && ! grep -q "^pr edit 200" "$T/gh.log" && ! grep -q "^api .*/pulls/200" "$T/gh.log" && ! grep -qE "^pr view 200 .*--json [^ ]*body" "$T/gh.log"'
check "ledger: the reviewer's comment is left alone"            'grep -q "A reviewer: <!-- desk-autopilot:ledger --> looks odd" "$T/pr/200.comments"'

# AC3 + AC5: every child merged into the base, with a spec still expected-fail, one failing when run,
# and a failing typecheck. main moved on meanwhile.
git clone -q "$T/origin.git" "$T/basework"; git -C "$T/basework" switch -q feat/E
mkdir -p "$T/basework/tests/acceptance"
printf "import { test } from 'vitest';\ntest('AC1: one', () => {});\ntest.fails('AC2: two', () => {});\n" > "$T/basework/tests/acceptance/feature.spec.ts"
printf "import { test } from 'vitest';\ntest('DoD4: an earlier epic', () => {});\n" > "$T/basework/tests/acceptance/older.spec.ts"
printf 'def test_dod5_an_earlier_python_spec():\n    assert True\n' > "$T/basework/tests/acceptance/test_older.py"
echo AC1 >"$T/basework/tests/acceptance/failing"; touch "$T/basework/broken-tc"
git -C "$T/basework" add -A && git -C "$T/basework" commit -q -m "the children, merged" && git -C "$T/basework" push -q origin feat/E
git -C "$T/repo" commit -q --allow-empty -m "main moved" && git -C "$T/repo" push -q origin main
echo MERGED > "$T/pr/151"
: > "$T/checks.log"; : > "$T/specs-run.log"
touch "$T/pr/200.unreadable"
pass
check "AC3: once every child has merged, the gate starts in the background" '[ $rc -eq 10 ] && echo "$out" | grep -q "BASE GATE: started on feat/E" && ! echo "$out" | grep -q "^IDLE"'
check "ledger: comments that cannot be read are reported, and the batch carries on" 'echo "$out" | grep -q "promotion PR #200: ledger not updated, since its comments could not be read (HTTP 502: Bad Gateway). The batch carries on" && ledger | grep -qE "^\| T-51 \| in review "'
rm "$T/pr/200.unreadable"
wait_gate
pass
check "ledger: the next pass writes it, in the same comment"     '[ "$(ledgers)" = 1 ] && ledger | grep -qE "^\| T-51 \| merged \| #151 \| default \|$" && cmp -s "$T/pr/200.body" "$T/pr/200.body.orig"'
BWT="$T/wt/base-feat-E"
check "AC3: the gate merged main into the base first"            'git -C "$T/origin.git" merge-base --is-ancestor main feat/E'
check "AC3: it ran every acceptance spec in the base worktree, an earlier epic's included" 'grep -qx AC1 "$T/specs-run.log" && grep -qx AC2 "$T/specs-run.log" && grep -qx DoD4 "$T/specs-run.log" && grep -qx DoD5 "$T/specs-run.log"'
check "AC3: and the typecheck, lint and unit tests there"        'grep -qx "tc $BWT" "$T/checks.log" && grep -qx "lint $BWT" "$T/checks.log" && grep -qx "tests $BWT" "$T/checks.log"'
check "AC5: a failed gate leaves the promotion PR draft"         '[ "$(bfield gate.state)" = "\"failed\"" ] && ! grep -q "^pr ready 200" "$T/gh.log"'
check "AC5: each failure is named under WAITING ON YOU, exit 11" '[ $rc -eq 11 ] && w="${out#*WAITING ON YOU}" && echo "$w" | grep -q "BASE GATE: \"AC2: two\" in tests/acceptance/feature.spec.ts is still marked expected-fail" && echo "$w" | grep -q "BASE GATE: AC1: \"AC1: one\" in tests/acceptance/feature.spec.ts fails when run (bash tests/acceptance/run.sh AC1)" && echo "$w" | grep -q "BASE GATE: §4 Typecheck (sh tc.sh) failed with exit 1: tc failed" && echo "$w" | grep -q "promotion PR #200 stays draft"'
check "AC5: the batch is idle, and the close-out is not offered" 'echo "$out" | grep -q "^IDLE" && ! echo "$out" | grep -q "close-out:"'
pass
check "a failed gate does not run again while the base stands still" '! echo "$out" | grep -q "BASE GATE: started"'

# AC4 + AC7: fixed on the base, the gate runs again, passes, and marks the promotion PR ready.
git -C "$T/basework" pull -q --no-rebase origin feat/E
printf "import { test } from 'vitest';\ntest('AC1: one', () => {});\ntest('AC2: two', () => {});\n" > "$T/basework/tests/acceptance/feature.spec.ts"
git -C "$T/basework" rm -q tests/acceptance/failing broken-tc
git -C "$T/basework" add -A && git -C "$T/basework" commit -q -m "fixed on the base" && git -C "$T/basework" push -q origin feat/E
pass
check "the gate runs again once the base moves"                 'echo "$out" | grep -q "BASE GATE: started on feat/E again"'
wait_gate
pass
check "AC4: a passing gate marks the promotion PR ready"         '[ "$(bfield gate.state)" = "\"passed\"" ] && grep -q "^pr ready 200 --repo acme/widgets" "$T/gh.log"'
check "AC4: and the report gives its link"                       '[ $rc -eq 11 ] && echo "$out" | grep -q "Promotion PR #200 is ready for review: https://github.com/acme/widgets/pull/200" && echo "$out" | grep -q "^IDLE"'
check "AC7: the close-out checks only the criterion with no spec" 'echo "$out" | grep -q "close-out: check only AC3 per criterion"'

# ---- promotion slices: the base gate runs every N children merged, or at a milestone ---------------
# Seven children, finished straight into the queue rather than through workers. A child "merges" when
# its pr/<n> says MERGED and a commit lands on the base, as a merge into it would.
SLICE=5 config
git -C "$T/repo" push -q origin main:feat/S
git clone -q "$T/origin.git" "$T/slicework"; git -C "$T/slicework" switch -q feat/S
# The spine's specs on main are still expected-fail; on this base its children have made them pass.
printf "import { test } from 'vitest';\ntest('AC1: one', () => {});\n" > "$T/slicework/tests/acceptance/feature.spec.ts"
git -C "$T/slicework" commit -q -am "the specs pass on the base" && git -C "$T/slicework" push -q origin feat/S
land(){ for k in "$@"; do echo MERGED > "$T/pr/1${k#T-}"; git -C "$T/slicework" commit -q --allow-empty -m "$k"; done; git -C "$T/slicework" push -q origin feat/S; }
q init slices; q set-batch base=feat/S epic=E-2 feature=true
for k in 61 62 63 64 65 66 67; do record "T-$k" "src/s$k.txt"; q admit "T-$k"; q set "T-$k" state=done "result.pr=1$k"; done
q set T-67 state=parked 'park={"question":"which copy should the banner use?"}'
: > "$T/gh.log"
pass
check "slices: the batch opens its promotion PR as before"      '[ "$(bfield promotion.pr)" = 200 ] && [ "$(bfield gate)" = null ]'
land T-61 T-62 T-63 T-64
pass
check "AC1: below the slice size the gate does not run"         '[ "$(bfield gate)" = null ] && ! echo "$out" | grep -q "BASE GATE: started"'
land T-65
pass
check "AC1: the fifth child merging starts the gate, with a child still open and one parked" 'echo "$out" | grep -q "BASE GATE: started on feat/S for slice 1: 5 of 7 children, since 5 children merged since the last promotion" && [ "$(bfield gate.slice.keys)" = "[\"T-61\",\"T-62\",\"T-63\",\"T-64\",\"T-65\"]" ]'
check "AC7: the parked child is named as not in this slice"     'echo "$out" | grep -q "BASE GATE: not in this slice: T-67 (parked: which copy"'
wait_gate
pass
check "AC3: a passing slice gate marks the promotion PR ready, and names the slice" '[ "$(bfield gate.state)" = "\"passed\"" ] && grep -q "^pr ready 200 --repo acme/widgets" "$T/gh.log" && echo "$out" | grep -q "BASE GATE: passed on feat/S at [0-9a-f]* (slice 1: 5 of 7 children): .*Promotion PR #200 is ready for review"'
check "AC6: a slice that is not the last offers no close-out"   '! echo "$out" | grep -q "close-out:"'
printf '{"ticket": "T-66", "type": "Story", "lane": "A", "size": "S", "branch": "feat/T-66", "files_in_scope": ["src/s66.txt"], "unknowns": [], "labels": ["milestone"]}\n' > "$T/state/triage/T-66.json"
land T-66
pass
check "AC2: a milestone child merging starts the gate whatever the count" 'echo "$out" | grep -q "BASE GATE: started on feat/S again (it moved since the last run, at [0-9a-f]*) for slice 1: 6 of 7 children, since milestone T-66 merged"'
check "a ready promotion PR goes back to draft once the base moves past its gate" 'grep -q "^pr ready 200 --repo acme/widgets --undo" "$T/gh.log" && echo "$out" | grep -q "Promotion PR #200 is back in draft until it passes"'
wait_gate
echo MERGED > "$T/pr/200"; echo 201 > "$T/pr/next"
pass
check "AC5: once the promotion PR merges, the next one opens as a draft and is recorded" 'echo "$out" | grep -q "promotion PR #200 (slice 1) merged into main" && grep -q "^pr create --repo acme/widgets --draft --base main --head feat/S --title E-2: promote feat/S to main (slice 2)" "$T/gh.log" && [ "$(bfield promotion.pr)" = 201 ] && [ "$(bfield promotion.slice)" = 2 ] && [ "$(bfield promotion.merged.0.pr)" = 200 ]'
check "AC5: the ledger comment is carried over to the new PR"    'grep -q "^pr comment 201" "$T/gh.log"'
check "AC5: the count starts again from that merge"             '[ "$(bfield gate)" = null ] && echo "$out" | grep -q "BASE GATE: not run, since 1 child(ren) did not finish: T-67"'
pass
check "AC5: a merged promotion PR is followed once"             '[ "$(grep -c "^pr create" "$T/gh.log")" = 2 ]'
q set T-67 state=done result.pr=167 park=null
land T-67
pass
check "AC6: the last child merging runs the last slice"         'echo "$out" | grep -q "BASE GATE: started on feat/S for slice 2: 1 of 7 children, the last"'
wait_gate
pass
check "AC6: the last slice passing offers the epic close-out"   'grep -q "^pr ready 201 --repo acme/widgets" "$T/gh.log" && echo "$out" | grep -q "close-out:"'
# A promotion PR that merged before the last child merged into the base leaves that child to promote.
echo MERGED > "$T/pr/201"; echo 2000-01-01T00:00:00Z > "$T/pr/201.merged_at"; echo 202 > "$T/pr/next"
pass
check "AC5: a child merged after the promotion PR merged is promoted by the next one, even with every child merged" 'grep -q "^pr create --repo acme/widgets --draft --base main --head feat/S --title E-2: promote feat/S to main (slice 3)" "$T/gh.log" && [ "$(bfield promotion.pr)" = 202 ]'
wait_gate
pass
echo MERGED > "$T/pr/202"; echo 2999-01-01T00:00:00Z > "$T/pr/202.merged_at"
pass
check "AC6: a promotion PR merged after every child opens no further one" '[ "$(grep -c "^pr create" "$T/gh.log")" = 3 ] && [ "$(bfield promotion.merged.2.pr)" = 202 ]'

# ---- the repo's subscription is not ~/.claude: the real spawn-worker.sh puts the preflight and worker on it --
# b is the default, so the repo following the default runs there, though ~/.claude has more room.
export DESK_QUEUE="$T/queue-l.json" DESK_AUTOPILOT_STATE="$T/state-l" DESK_SUBSCRIPTIONS="$T/subscriptions.md" DESK_USAGE_DIR="$T/usage"
LOGIN_B="$T/home/.claude-logins/b"
mkdir -p "$T/state-l/triage" "$T/usage" "$LOGIN_B"
printf '| Tool | Name | Folder | Rule |\n|---|---|---|---|\n| `claude` | `default` | `~/.claude` | `unused` |\n| `claude` | `b` | `~/.claude-logins/b` | `default` |\n' > "$DESK_SUBSCRIPTIONS"
reading(){ node -e 'const r = Math.floor(Date.now() / 1000) + 3600; const u = Number(process.argv[1]); console.log(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { unifiedWindows: { five_hour: { utilization: u, resetsAt: r }, seven_day: { utilization: u, resetsAt: r } } } }))' "$1"; }
reading 0.1 > "$T/usage/probe.log"; reading 0.9 > "$T/usage/probe.b.log"
printf '{"ticket": "T-91", "type": "Bug", "lane": "A", "size": "S", "branch": "fix/T-91", "files_in_scope": ["src/l.txt"], "unknowns": []}\n' > "$T/state-l/triage/T-91.json"
printf 'WAIT\nAUTOPILOT_DONE: pr=191 jira=none\n' > "$T/scripts/T-91.1"
q init logins; q admit T-91
: > "$T/logins.log"
MEM="$T/home/.claude/projects/$(printf '%s' "$T/repo" | tr -c 'A-Za-z0-9' '-')/memory"
mkdir -p "$MEM"; echo '- [A hazard](hazard.md) — the one to remember' > "$MEM/MEMORY.md"
pass
check "DS-620 AC1 AC3 the real preflight and the worker both run on the repo's subscription, not the roomier login" '[ "$(cat "$T/logins.log")" = "$(printf "preflight %s\nworker %s" "$LOGIN_B" "$LOGIN_B")" ]'
check "DS-465 AC1 the row and the worker's login file name it" '[ "$(field T-91 login.name)" = "\"b\"" ] && grep -q "\"login\":\"b\"" "$T/state-l/workers/T-91.login.json"'
check "DS-465 a worker on another login gets the memory index in its brief, its auto-memory being that login's" 'run_has "$T/runs/T-91.1" prompt "the one to remember"'
check "DS-839 a park never messages the orchestrator, so no briefing names one, on any login" '[ -f "$T/state-l/briefings/T-91.md" ] && ! grep -q "^Orchestrator session name" "$T/state-l/briefings/T-91.md" "$T/state/briefings/T-34.md"'
finish T-91

echo "batch e2e spine: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
