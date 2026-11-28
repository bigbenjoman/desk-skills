#!/usr/bin/env bash
# suite: batch end to end (triage records to done, offline, scripted workers)
# layer: L3
# One autopilot batch driven through the real queue.mjs admit, pass.mjs, setup-worktree.sh,
# spawn-worker.sh (preflight included), harvest.mjs and answer.mjs. Only `claude` and `gh` are
# replaced, by scripts on PATH: the fake claude answers the preflight checks and
# `claude agents --json`, and plays each worker from tests' own script, one per ticket and round.
# PATH holds nothing but the fakes and the system directories, git refuses every network protocol,
# and origin is a local bare repo, so a real claude, gh, codex or desk-jira is never reachable.
# The setup is tests/batch_e2e_setup.sh; feature batches are the second half, tests/test_batch_e2e_spine.sh.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
# shellcheck source=batch_e2e_setup.sh
. "$(dirname "$0")/batch_e2e_setup.sh"
q init e2e

# ---- AC1 + AC2: two independent tickets and a third that collides with the first ------------------
record T-1 src/a.txt; record T-2 src/b.txt; record T-3 src/a.txt
printf 'WAIT\nAUTOPILOT_STAGE: 4/9 verify\nAUTOPILOT_DONE: pr=101 jira=none\n' > "$T/scripts/T-1.1"
printf 'WAIT\nAUTOPILOT_DONE: pr=102 jira=none\n' > "$T/scripts/T-2.1"
printf 'WAIT\nAUTOPILOT_DONE: pr=103 jira=none\n' > "$T/scripts/T-3.1"
for k in T-1 T-2 T-3; do q admit "$k"; done
check "admit reads the fixture records and marks the collision" '[ "$(state T-3)" = triaged ] && [ "$(field T-3 collides_with)" = "\"T-1\"" ]'

pass
check "the first pass spawns both independent tickets, and exits 0" '[ $rc -eq 0 ] && [ "$(state T-1)" = running ] && [ "$(state T-2)" = running ] && live T-1 && live T-2'
check "the colliding ticket does not spawn beside its blocker" '[ "$(state T-3)" = triaged ] && [ ! -e "$T/runs/T-3.1" ] && echo "$out" | grep -q "held back by a collision: T-3"'
check "each worker runs in its own worktree on its own branch"  'grep -q "\"cwd\":\"$T/wt/T-1\"" "$T/runs/T-1.1" && [ "$(git -C "$T/wt/T-1" branch --show-current)" = fix/T-1 ]'
check "each worker passed a real preflight first"               '[ "$(grep -c "^claude preflight" "$T/calls.log")" = 2 ]'
check "DS-158 AC1 each spawn line shows its preflight's cost and turns" '[ "$(echo "$out" | grep "^spawned: " | grep -o "preflight \$0.43, 9 turn(s)" | wc -l | tr -d " ")" = 2 ]'
check "DS-158 AC1 and the ticket's log holds them, ahead of the worker" 'head -1 "$T/state/logs/T-1.log" | grep -q "\"type\":\"desk_preflight\",\"total_cost_usd\":0.4321,\"num_turns\":9"'
REVIEW_SEATS='["lena-code-reviewer","nadia-security-auditor","theo-api-designer","mira-playwright-expert","jim-solution-architect","suki-frontend-architect","bea-business-analyst","ada-devils-advocate"]'
check "DS-367 AC1 each worker is started with every named review seat as an agent" 'grep -qF "\"agents\":$REVIEW_SEATS" "$T/runs/T-1.1" && grep -qF "\"agents\":$REVIEW_SEATS" "$T/runs/T-2.1"'
check "DS-367 AC4 and still with no user setting sources and the one generated settings file" 'grep -qF "\"sources\":\"\",\"settings\":1" "$T/runs/T-1.1" && grep -qF "\"sources\":\"\",\"settings\":1" "$T/runs/T-2.1"'
check "a worker commits as config §1 Git author name / email, author and committer both" 'grep -qF "\"git\":\"Pat Tester|pat@example.com|Pat Tester|pat@example.com\"" "$T/runs/T-1.1"'
check "DS-158 AC4 a worker is started with no partial messages" 'grep -q "\"partial\":false" "$T/runs/T-1.1" && grep -q "\"partial\":false" "$T/runs/T-2.1"'
REFS="$SRC/skills/desk-autopilot/references"
check "a ticket worker's system prompt holds the core contract, and its first message the briefing" 'run_has "$T/runs/T-1.1" system "Stage sections: read each one when you reach it" && run_has "$T/runs/T-1.1" prompt "# Briefing for this ticket" && ! run_has "$T/runs/T-1.1" system "# Briefing for this ticket"'
check "and no stage section: verification, command forms, the orchestrator's part, Jira, the task" '! grep -qE "## 3\. Verification|### Self-review|## 6\. Command forms|## 5\. What the orchestrator|### Jira comments|## 0\. If you were given a task|## Review-sweep" "$T/runs/T-1.1"'
check "and the directory its stage sections are read from" 'grep -q "in \`$REFS\`" "$T/runs/T-1.1" && ! grep -q "{{STAGE_DIR}}" "$T/runs/T-1.1"'
check "with no Worker models row, no worker or preflight is passed a model" '[ "$(ran_on T-1 1)" = none ] && [ "$(ran_on T-2 1)" = none ] && [ "$(grep -c "^claude preflight model=none$" "$T/calls.log")" = 2 ] && [ "$(field T-1 model)" = "\"default\"" ]'

pass
check "a pass while both run spawns nothing more, and exits 10" '[ $rc -eq 10 ] && [ "$(state T-3)" = triaged ] && [ ! -e "$T/runs/T-3.1" ]'

finish T-1; finish T-2
touch "$T/preflight-text"
pass
rm -f "$T/preflight-text"
check "DS-158 AC3 a preflight that gives no result says its cost is unknown, not zero" 'echo "$out" | grep "^spawned: " | grep -q "T-3 .*; preflight cost unknown, turns unknown"'
check "both tickets reach done with the PRs their workers printed" '[ "$(state T-1)" = done ] && [ "$(field T-1 result.pr)" = 101 ] && [ "$(state T-2)" = done ] && [ "$(field T-2 result.pr)" = 102 ]'
check "the stage a worker printed is recorded"                  '[ "$(field T-1 stage)" = "\"4/9\"" ]'
check "DS-554 AC1 the worker's exit code is recorded for its session once it exits" 'grep -qE "^\{\"session\":\"[0-9a-f-]{36}\",\"code\":0,\"at\":\"[0-9T:-]+Z\"\}$" "$T/state/workers/T-1.exit.json"'
check "DS-695 AC1 the same record is renamed into the repo's exits folder, with no temp file left" '[ "$(cat "$T/state/exits"/T-1.[0-9]*.json)" = "$(cat "$T/state/workers/T-1.exit.json")" ] && ! ls -A "$T/state/exits" | grep -q "^\."'
check "the held ticket spawns once its blocker has finished"    '[ $rc -eq 0 ] && [ "$(state T-3)" = running ] && live T-3'

finish T-3
for n in 101 102 103; do echo MERGED > "$T/pr/$n"; done
pass
check "the held ticket reaches done"                           '[ "$(state T-3)" = done ] && [ "$(field T-3 result.pr)" = 103 ]'
check "the batch stops spawning: IDLE, and the finished batch exits 11" '[ $rc -eq 11 ] && echo "$out" | grep -q "^IDLE"'
pass
check "a further pass spawns nothing"                           '[ "$(grep -c "^claude worker" "$T/calls.log")" = 3 ] && echo "$out" | grep -q "^IDLE"'

# ---- AC2: a ticket held behind another's PR does not spawn while its blocker runs -----------------
record T-4 src/c.txt; record T-5 src/d.txt
printf 'WAIT\nAUTOPILOT_DONE: pr=104 jira=none\n' > "$T/scripts/T-4.1"
q admit T-4; q admit T-5; q hold T-5 T-4
pass; finish T-4
pass
check "a finished blocker with an open PR keeps the batch waiting on its merge, exit 10" '[ $rc -eq 10 ] && [ "$(state T-4)" = done ] && [ "$(state T-5)" = parked ] && [ ! -e "$T/runs/T-5.1" ] && echo "$out" | grep -q "WAITING ON MERGE: T-5 (T-4)" && ! echo "$out" | grep -q "^IDLE"'
q drop T-5

# ---- AC3: a worker parks with a question; answered and requeued, a second worker finishes it ------
record T-6 src/e.txt
printf 'WAIT\nAUTOPILOT_STAGE: 2/9 understand\nAUTOPILOT_PARK: which fixture helper should the spec use?\n' > "$T/scripts/T-6.1"
printf 'WAIT\nAUTOPILOT_DONE: pr=106 jira=none\n' > "$T/scripts/T-6.2"
q admit T-6
pass
# The worker keeps the text its park waits on in its park file, beside the question.
mkdir -p "$T/state/parks"
printf '{"question": "which fixture helper should the spec use?", "approve": {"kind": "jira-comment", "target": "T-6", "body": "Line one.\\nLine two."}}\n' > "$T/state/parks/T-6.json"
finish T-6
pass
check "a worker that parks leaves the ticket parked with its question, exit 11" '[ $rc -eq 11 ] && [ "$(state T-6)" = parked ] && field T-6 park | grep -q "which fixture helper"'
check "#775 and the pass's report carries it, whole" 'grep -qF "T-6: which fixture helper should the spec use? — awaiting approval, its exact text (jira-comment on T-6, as JSON): \"Line one.\\nLine two.\"" <<< "$out"'
check "#775 the text its park file says awaits approval is kept with the park" '[ "$(field T-6 park.approve)" = "{\"kind\":\"jira-comment\",\"target\":\"T-6\",\"body\":\"Line one.\\nLine two.\"}" ]'
out=$(node "$B/answer.mjs" T-6 "use makeFixture from tests/helpers" 2>&1); arc=$?
out=$(node "$B/queue.mjs" requeue T-6 2>&1); rc=$?
check "the answered ticket requeues, answer and requeue exit 0" '[ $arc -eq 0 ] && [ $rc -eq 0 ] && [ "$(state T-6)" = triaged ]'
pass
check "a second worker spawns for the requeued ticket, exit 0"  '[ $rc -eq 0 ] && [ "$(state T-6)" = running ] && [ -e "$T/runs/T-6.2" ]'
check "the second worker's briefing carries the answer"         'grep -q "use makeFixture from tests/helpers" "$T/runs/T-6.2"'
finish T-6
pass
check "the requeued ticket reaches done with the second worker's PR" '[ "$(state T-6)" = done ] && [ "$(field T-6 result.pr)" = 106 ]'

# ---- DS-155: a worker hands off at the end of Stage 4, and a fresh session takes Stage 4b ---------
# Its 4b session fails, the requeue raises it to the high model, and the next 4b session hands off to 7.
# The row names a text model, which only the Stage 7 session runs on.
# Its §1 Git author name / email is TODO, so its worker is given no GIT_AUTHOR_* or GIT_COMMITTER_*.
AUTHOR='`TODO`' config "standard=sonnet high=opus text=haiku"
record T-80 src/h.txt
printf 'WAIT\nAUTOPILOT_STAGE: 4/9 verify\nAUTOPILOT_HANDOFF: 4b\n' > "$T/scripts/T-80.1"
printf 'WAIT\nAUTOPILOT_STAGE: 4b/9 self-review\n' > "$T/scripts/T-80.2"
printf 'WAIT\nAUTOPILOT_STAGE: 6/9 hygiene\nAUTOPILOT_HANDOFF: 7\n' > "$T/scripts/T-80.3"
printf 'WAIT\nAUTOPILOT_DONE: pr=180 jira=none\n' > "$T/scripts/T-80.4"
q admit T-80
pass
mkdir -p "$T/state/handoffs"
printf '{"ticket": "T-80", "stage": "4b", "criteria": ["AC1: h saves"], "lane": "A", "verification": ["bash tests/run.sh: pass"], "review": [], "evidence": []}\n' > "$T/state/handoffs/T-80.json"
finish T-80
pass
check "DS-155 AC2 after a handoff the real spawn-worker starts a new session in the same worktree, told to start at Stage 4b" '[ "$(state T-80)" = running ] && [ -e "$T/runs/T-80.2" ] && grep -q "This session starts at Stage 4b" "$T/runs/T-80.2" && grep -q "\"cwd\":\"$T/wt/T-80\"" "$T/runs/T-80.2" && [ "$(node -e "const r = (n) => JSON.parse(require(\"fs\").readFileSync(process.argv[1] + n, \"utf8\")).sid; console.log(r(1) !== r(2))" "$T/runs/T-80.")" = true ]'
check "a worker whose §1 Git author name / email is TODO is given no git author or committer" 'grep -qF "\"git\":\"-|-|-|-\"" "$T/runs/T-80.1"'
check "#1382 AC2 a worker's Node compile cache is the repo's cache folder on disk, made before it starts" 'grep -qF "\"compileCache\":\"$T/state/cache/node-compile-cache\"" "$T/runs/T-80.1" && [ -d "$T/state/cache/jest" ] && [ -d "$T/state/cache/runs" ]'
check "DS-155 AC2 with the handoff briefing in its first message" 'run_has "$T/runs/T-80.2" prompt "# Briefing for this ticket" && run_has "$T/runs/T-80.2" prompt "## Handoff: this session starts at Stage 4b" && grep -q "AC1: h saves" "$T/runs/T-80.2" && grep -q "fix/T-80" "$T/runs/T-80.2" && [ "$(ran_on T-80 2)" = sonnet ]'
finish T-80
pass
out=$(node "$B/queue.mjs" requeue T-80 2>&1)
pass
check "DS-155 AC8 a failed handoff session, requeued, starts at Stage 4b again, on the model the requeue raised it to" '[ "$(state T-80)" = running ] && grep -q "This session starts at Stage 4b" "$T/runs/T-80.3" && [ "$(ran_on T-80 3)" = opus ] && [ "$(field T-80 model)" = "\"opus\"" ]'
printf '{"ticket": "T-80", "stage": "7", "criteria": ["AC1: h saves"], "lane": "A", "verification": ["bash tests/run.sh: pass"], "review": ["P2 src/h.txt:1 fixed in abc1234"], "evidence": []}\n' > "$T/state/handoffs/T-80.json"
finish T-80
pass
check "DS-155 AC3 a handoff at the end of Stage 6 starts a new session at Stage 7 through the real spawn-worker" '[ "$(state T-80)" = running ] && grep -q "This session starts at Stage 7" "$T/runs/T-80.4" && grep -q "## Handoff: this session starts at Stage 7" "$T/runs/T-80.4" && grep -q "P2 src/h.txt:1 fixed in abc1234" "$T/runs/T-80.4"'
check "DS-338 AC2 a session resumed at Stage 4b or 7 is told to read the Stage 3 file, which holds the dev server's form" 'grep -q "for Stage 4b and its Stage 3 file" "$T/runs/T-80.2" && grep -q "for Stage 7 and its Stage 3 file" "$T/runs/T-80.4"'
check "DS-157 AC3 the Stage 7 session runs on the text model, and the batch report shows it" '[ "$(ran_on T-80 4)" = haiku ] && [ "$(field T-80 model)" = "\"haiku\"" ] && echo "$out" | grep -q "T-80 fresh session from Stage 7 (handed off) .*model=haiku"'
check "DS-696 AC1 every preflight proved the text model from the CLI's list, spending no model turn on it" '[ "$(grep -c "^claude model-list$" "$T/calls.log")" = 4 ] && ! grep -q "^claude model-check model=haiku$" "$T/calls.log"'
finish T-80
pass
check "DS-155 the handoff session's DONE finishes the ticket, and a later rework requeue starts from Stage 0" '[ "$(state T-80)" = done ] && [ "$(field T-80 result.pr)" = 180 ] && [ "$(field T-80 handoff_stage)" = null ] && node "$B/queue.mjs" requeue T-80 >/dev/null 2>&1 && [ "$(field T-80 handoff)" = null ]'
q drop T-80
config

# ---- AC4: a worker that exits with no done marker is not done ------------------------------------
record T-7 src/f.txt
printf 'WAIT\nAUTOPILOT_STAGE: 3/9 implement\n' > "$T/scripts/T-7.1"
q admit T-7
pass; finish T-7
pass
check "a worker with no done marker and no PR is reported failed, exit 11 naming it" '[ $rc -eq 11 ] && echo "$out" | grep -q "^NOTIFY: .*T-7" && [ "$(state T-7)" = failed ] && [ "$(field T-7 result)" = null ] && echo "$out" | grep -q "T-7: exited with no marker and no open PR"'
out=$(node "$B/queue.mjs" requeue T-7 2>&1)
check "with no Worker models row, a requeue after a failure claims no model change" '[ "$(field T-7 model_tier)" = null ] && [ "$(field T-7 model_note)" = null ] && ! echo "$out" | grep -q "high model"'
q drop T-7

# ---- a task instead of a ticket: its worker gets the task section and every stage section up front --
record T-60 src/t.txt
printf 'WAIT\nAUTOPILOT_DONE: pr=160 jira=none\n' > "$T/scripts/T-60.1"
q admit T-60
export AUTOPILOT_TASK='Review the open PR for this ticket. Your ticket is $TICKET. Your worktree is $WT.'
pass; unset AUTOPILOT_TASK
check "a task worker is spawned with the task as its prompt" 'grep -q "Review the open PR for this ticket. Your ticket is T-60. Your worktree is $T/wt/T-60" "$T/runs/T-60.1"'
check "its system prompt holds the core, the task section and the review-sweep rules" 'grep -q "Stage sections: read each one when you reach it" "$T/runs/T-60.1" && grep -q "## 0. If you were given a task instead of a ticket" "$T/runs/T-60.1" && grep -q "## Review-sweep tasks: the comment is the deliverable" "$T/runs/T-60.1"'
check "and every stage section, self-review included"                'grep -q "## 3. Verification must cover what CI covers" "$T/runs/T-60.1" && grep -q "### Self-review" "$T/runs/T-60.1" && grep -q "## 6. Command forms that are silently denied" "$T/runs/T-60.1" && grep -q "## 5. What the orchestrator owns, not you" "$T/runs/T-60.1" && grep -q "### Jira comments and transitions follow config" "$T/runs/T-60.1"'
check "the task section sits where section 0 always did: after the header, before section 1" '[ "$(node -e '"'"'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).system; const at = (h) => s.indexOf(h); console.log(at("Read config values with") < at("## 0. If you were given") && at("## 0. If you were given") < at("## 1. You cannot ask"))'"'"' "$T/runs/T-60.1")" = true ]'
finish T-60; pass
q drop T-60

# ---- worker models: a standard and a high model, picked per ticket from its triage ----------------
config "standard=sonnet high=opus"
record T-8 src/g.txt A S; record T-9 src/h.txt B S; record T-10 src/i.txt A M
printf 'WAIT\nAUTOPILOT_STAGE: 3/9 implement\n' > "$T/scripts/T-8.1"
printf 'WAIT\nAUTOPILOT_DONE: pr=108 jira=none\n' > "$T/scripts/T-8.2"
printf 'WAIT\nAUTOPILOT_DONE: pr=109 jira=none\n' > "$T/scripts/T-9.1"
printf 'WAIT\nAUTOPILOT_DONE: pr=110 jira=none follow_on={"x": 1}\n' > "$T/scripts/T-10.1"
q admit T-8; q admit T-9; q admit T-10
pass
check "a lane A ticket sized S runs on the standard model, and so does its preflight" '[ "$(ran_on T-8 1)" = sonnet ] && [ "$(field T-8 model_tier)" = "\"standard\"" ] && grep -q "^claude preflight model=sonnet$" "$T/calls.log"'
check "a lane B ticket runs on the high model"                  '[ "$(ran_on T-9 1)" = opus ] && [ "$(field T-9 model_tier)" = "\"high\"" ]'
check "a ticket sized M runs on the high model"                 '[ "$(ran_on T-10 1)" = opus ]'
check "the status table shows each running worker's model"      'echo "$out" | grep -qE "RUNNING +T-8 +stage .*model sonnet" && echo "$out" | grep -qE "RUNNING +T-9 +stage .*model opus"'
finish T-8; finish T-9; finish T-10
pass
check "the standard-model worker with no marker is failed"      '[ "$(state T-8)" = failed ]'
check "issue-1549 AC2 a follow_on= that does not read is kept on the ticket" '[ "$(state T-10)" = done ] && [ "$(field T-10 follow_on_unreadable.error)" = "\"not a JSON array\"" ] && field T-10 follow_on_unreadable.raw | grep -qF "\"x\\\": 1" && [ "$(field T-10 follow_on)" = null ]'
out=$(node "$B/queue.mjs" render 2>&1)
check "issue-1549 AC2 and the status table says it on the ticket's row" 'echo "$out" | grep -qF "follow-on unreadable: {\"x\": 1}" && echo "$out" | grep "follow-on unreadable" | grep -q "T-10"'
out=$(node "$B/queue.mjs" requeue T-8 2>&1)
check "requeueing a failed standard-model ticket raises it to high" '[ "$(field T-8 model_tier)" = "\"high\"" ] && echo "$out" | grep -q "runs on the high model"'
out=$(node "$B/queue.mjs" render 2>&1)
check "the status table shows the change"                       'echo "$out" | grep -qE "TRIAGED +T-8 .*standard → high after a failed worker"'
pass
check "its next worker runs on the high model"                  '[ "$(ran_on T-8 2)" = opus ] && echo "$out" | grep -qE "RUNNING +T-8 .*model opus .*standard → high"'
finish T-8
pass
check "the raised ticket finishes"                              '[ "$(state T-8)" = done ] && [ "$(field T-8 result.pr)" = 108 ]'

# An unsized ticket runs on high; a standard ticket that parks with a question keeps its model.
record T-11 src/j.txt A -; record T-12 src/k.txt A XS
printf 'WAIT\nAUTOPILOT_DONE: pr=111 jira=none\n' > "$T/scripts/T-11.1"
printf 'WAIT\nAUTOPILOT_PARK: which helper should the spec use?\n' > "$T/scripts/T-12.1"
printf 'WAIT\nAUTOPILOT_DONE: pr=112 jira=none\n' > "$T/scripts/T-12.2"
q admit T-11; q admit T-12
pass
check "a ticket with no size runs on the high model"            '[ "$(ran_on T-11 1)" = opus ]'
check "a lane A ticket sized XS runs on the standard model"     '[ "$(ran_on T-12 1)" = sonnet ]'
finish T-11; finish T-12
pass
out=$(node "$B/answer.mjs" T-12 "use makeFixture" 2>&1)
out=$(node "$B/queue.mjs" requeue T-12 2>&1)
check "a requeue after a park with a question keeps the model"  '[ "$(field T-12 model_tier)" = "\"standard\"" ] && [ "$(field T-12 model_note)" = null ] && ! echo "$out" | grep -q "high model"'
pass
check "its next worker runs on the same model"                  '[ "$(ran_on T-12 2)" = sonnet ]'
finish T-12
pass

# A standard-model worker that pass.mjs stops as stalled (six passes with no log growth) is raised
# too, through the park the stall killer itself writes.
record T-13 src/l.txt A S
printf 'WAIT\n' > "$T/scripts/T-13.1"
q admit T-13
pass
check "the silent worker spawns on the standard model"          '[ "$(ran_on T-13 1)" = sonnet ] && live T-13'
for _ in 1 2 3 4 5 6; do pass; done
check "pass.mjs stops the silent worker and parks it as stalled" '[ "$(state T-13)" = parked ] && echo "$out" | grep -q "T-13: no output for 6 passes"'
out=$(node "$B/queue.mjs" requeue T-13 2>&1)
check "requeueing a stalled standard-model ticket raises it to high" '[ "$(field T-13 model_tier)" = "\"high\"" ] && [ "$(field T-13 model_note)" = "\"standard → high after a stalled worker\"" ]'
q drop T-13

# A model the CLI rejects fails that ticket's preflight, naming the value; no worker ran, so a
# requeue keeps the tier.
config "standard=no-such-model high=opus"
record T-14 src/m.txt A S; q admit T-14; q set T-14 model_tier=standard
pass
check "a rejected model fails the preflight with a message naming the value" '[ "$(state T-14)" = failed ] && [ ! -e "$T/runs/T-14.1" ] && echo "$out" | grep -q "T-14: preflight failed" && echo "$out" | grep -q "MODEL .*no-such-model"'
out=$(node "$B/queue.mjs" requeue T-14 2>&1)
check "a requeue after a failed preflight keeps the model"      '[ "$(field T-14 model_tier)" = "\"standard\"" ] && [ "$(field T-14 model_note)" = null ]'
q drop T-14

# DS-157 AC4: a finder or text model the CLI rejects fails the preflight too, though the worker's
# own model is fine, naming the row and the value, and no worker spawns.
config "standard=sonnet high=opus finder=nosuchalias"
record T-16 src/o.txt A S; q admit T-16
pass
check "DS-157 AC4 and DS-696 AC2 a finder model the CLI does not list, and rejects, fails the preflight, naming the row and the value" '[ "$(state T-16)" = failed ] && [ ! -e "$T/runs/T-16.1" ] && echo "$out" | grep -q "T-16: preflight failed" && echo "$out" | grep -q "FINDER  FAIL .*Worker models names finder=\"nosuchalias\""'
q drop T-16
config "default text=no-such-model"
record T-17 src/p.txt A S; q admit T-17
pass
check "DS-157 AC4 a rejected text model fails it too"            '[ "$(state T-17)" = failed ] && [ ! -e "$T/runs/T-17.1" ] && echo "$out" | grep -q "TEXT  FAIL .*Worker models names text=\"no-such-model\""'
q drop T-17

# DS-367 AC2: a named review agent that is not installed fails the preflight, naming it, and no
# worker spawns to review with a general-purpose stand-in.
config "standard=sonnet high=opus"
mkdir -p "$T/away"; mv "$T/home/.claude/agents/nadia-security-auditor.md" "$T/away/"
record T-19 src/r.txt A S; q admit T-19
pass
check "DS-367 AC2 a missing review agent fails the preflight, naming it" '[ "$(state T-19)" = failed ] && [ ! -e "$T/runs/T-19.1" ] && echo "$out" | grep -q "T-19: preflight failed" && echo "$out" | grep -q "review agent missing: nadia-security-auditor" && ! echo "$out" | grep -q "review agent missing: lena-code-reviewer"'
mv "$T/away/nadia-security-auditor.md" "$T/home/.claude/agents/"; q drop T-19

# DS-344 AC2: a preflight the account's usage limit refuses (HTTP 429) is told apart from a failed
# one by the real spawn-worker.sh. The ticket keeps its place, and the batch holds on the limit.
config "standard=sonnet high=opus"
touch "$T/preflight-429" "$T/probe-429"
record T-18 src/q.txt A S; q admit T-18
pass
check "DS-344 AC2 a preflight refused with HTTP 429 fails nothing, and the batch holds on the weekly limit" '[ "$(state T-18)" = triaged ] && [ "$(field T-18 spawn_failed)" = null ] && [ ! -e "$T/runs/T-18.1" ] && echo "$out" | grep -q "T-18: its preflight was refused at the weekly usage limit" && [ "$(bfield usage_hold.preflight)" = "\"T-18\"" ]'
q drop T-18; rm -f "$T/preflight-429" "$T/probe-429"
pass
check "DS-344 AC3 a probe that succeeds lifts the hold"         '[ "$(bfield usage_hold)" = null ] && grep -q "^claude probe$" "$T/calls.log"'

# A malformed row holds every spawn rather than reading as default.
config "standard=sonnet"
record T-15 src/n.txt A S; q admit T-15
pass
check "a malformed Worker models row holds spawns, naming the row" '[ "$(state T-15)" = triaged ] && [ ! -e "$T/runs/T-15.1" ] && echo "$out" | grep -q "Worker models"'
q drop T-15

echo "batch e2e: $PASS passed, $FAIL failed"; [ "$FAIL" -eq 0 ]
