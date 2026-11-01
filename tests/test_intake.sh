#!/usr/bin/env bash
# suite: intake (standing intake admits a query's tickets into the running batch)
# intake.mjs with a fake desk-jira search, a fake triage.sh that writes set lanes, lint, questions,
# sizes and blockers, the real queue.mjs on a scratch queue, and the supervisor with a fake pass and
# merge driver: what is admitted, held, handed to the digest, and what the report says. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; B="$S/../desk/bin"
T="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/home" "$T/bin" "$T/fakes" "$T/repo" "$T/state/triage" "$T/recs" "$T/no-skills"
export HOME="$T/home"
unset DESK_CONFIG DESK_REPO_DIR DESK_REPO_ROOT DESK_SLUG DESK_STATE DESK_DEFAULT_BRANCH DESK_GH_REPO \
  AUTOPILOT_DRY_RUN AUTOPILOT_BASE_PUSH_APPROVED AUTOPILOT_USER_APPROVED DESK_DIGEST_DIR
export DESK_CONFIG_ROOT="$T/cfg" DESK_REPO_OVERRIDE=acme/widgets DESK_HOME="$T/desk" \
  DESK_AUTOPILOT_STATE="$T/state" DESK_QUEUE="$T/queue.json" DESK_SKILLS_DIR="$T/no-skills"
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }

# config <autopilot-workers> [<intake query row>]
config(){ mkdir -p "$T/cfg/repos/acme__widgets"; cat > "$T/cfg/repos/acme__widgets/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`$1\` |
| \`autopilot-merge\` | The merge driver merges | \`ask\` | \`yes\` |
| \`pr-merge-green\` | Merge on green | \`ask\` | \`yes\` |
| \`git-push\` | Push a branch | \`ask\` | \`yes\` |
| \`jira-create\` | Create a ticket | \`ask\` | \`yes\` |

## 3b. Cost and autonomy
| Field | Recommended | Your setting |
|---|---|---|
| Intake query | \`none\` | ${2-\`project = ACME AND labels = autopilot\`} |
EOF
}
config yes

# intake.mjs and the supervisor copied beside fakes, so each runs the fake triage.sh, pass and driver.
cp "$B/intake.mjs" "$B/supervisor.mjs" "$B/epic-plan.mjs" "$T/bin/"
for f in desk-env.mjs machine.mjs test-scope.mjs batch-state.mjs batches.mjs batch.mjs decider.mjs handoff.mjs briefing.mjs queue.mjs desk-q-eta.mjs closeout.mjs installed.mjs run-by.mjs not-now.mjs answer.mjs; do ln -s "$B/$f" "$T/bin/$f"; done
# The search: whatever $T/search.json holds, or a failure while $T/search.fails exists.
cat > "$T/fakes/desk-jira" <<EOF
#!/bin/sh
echo "\$*" >> "$T/jira.calls"
[ "\$1" = create ] && { echo "created E-11"; exit 0; }
[ -f "$T/search.fails" ] && { echo "desk-jira: HTTP 503 from Jira" >&2; exit 1; }
cat "$T/search.json"
EOF
# Triage: copies the set record for the ticket into the state of the batch it runs in, or fails while
# $T/recs/<KEY>.fails exists. A run in a named batch is logged with that batch in $T/triage.batch.
cat > "$T/bin/triage.sh" <<EOF
#!/bin/sh
echo "\$1" >> "$T/triage.calls"
[ -n "\${DESK_BATCH:-}" ] && echo "\$1 \$DESK_BATCH \${DESK_DEFAULT_BRANCH:-unpinned}" >> "$T/triage.batch"
[ -f "$T/recs/\$1.fails" ] && { echo "triage: claude exited 1" >&2; exit 1; }
mkdir -p "\$DESK_AUTOPILOT_STATE/triage"; cp "$T/recs/\$1.json" "\$DESK_AUTOPILOT_STATE/triage/\$1.json"
EOF
cat > "$T/bin/pass.mjs" <<EOF
import { appendFileSync } from 'node:fs';
appendFileSync('$T/pass.calls', 'pass\\n');
console.log(JSON.stringify({ status: 'nothing_yet', code: 10, message: 'no change this pass', waiting: [], parked: [], notify: false, push: [] }));
process.exitCode = 10;
EOF
printf "import { appendFileSync } from 'node:fs';\nappendFileSync('%s/digest.calls', 'checkin\\\\n');\nconsole.log(JSON.stringify({ status: 'not_due', push: null }));\n" "$T" > "$T/bin/digest.mjs"
echo "console.log(JSON.stringify({ hold: false, lines: [] }));" > "$T/bin/maintenance.mjs"
printf '#!/bin/sh\necho "$@" >> "%s/driver.calls"\n' "$T" > "$T/bin/merge-driver.sh"
# A PR list is whatever $T/prs.json holds (none by default); any other call reads OPEN.
printf '#!/bin/sh\ncase "$*" in "pr list "*) cat "%s/prs.json" 2>/dev/null || echo "[]" ;; *) echo OPEN ;; esac\n' "$T" > "$T/fakes/gh"
printf '#!/bin/sh\nexit 1\n' > "$T/fakes/launchctl"
printf '#!/bin/sh\nexit 0\n' > "$T/fakes/osascript"
chmod +x "$T/fakes/"* "$T/bin/triage.sh" "$T/bin/merge-driver.sh"
export PATH="$T/fakes:$PATH"

intake(){ (cd "$T/repo" && node "$T/bin/intake.mjs" run --force "$@" 2>&1); }
tick(){ (cd "$T/repo" && node "$T/bin/supervisor.mjs" tick --foreground 2>&1); }
search(){ printf '{"issues":[%s]}\n' "$(printf '{"key":"%s"},' "$@" | sed 's/,$//')" > "$T/search.json"; }
# rec <KEY> <lane> [extra json fields]
rec(){ printf '{"ticket":"%s","type":"Story","lane":"%s","lane_reason":"needs a plan","files_in_scope":["src/%s.js"],"unknowns":[],"size":"S","blockers":[],"lint":[]%s}\n' "$1" "$2" "$1" "${3:+,$3}" > "$T/recs/$1.json"; }
count(){ if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }
qget(){ node -e 'const q=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],q); console.log(typeof v==="object"?JSON.stringify(v):String(v))' "$DESK_QUEUE" "$1"; }
handed(){ node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const e=r.tickets[process.argv[2]]; console.log(e?`${e.outcome}: ${e.text}`:"none")' "$T/state/intake.json" "$1"; }
running_batch(){ printf '{"version":1,"batch":"b1","supervised":true,"concurrency":2,"tickets":{"R":{"key":"R","state":"running"}}}\n' > "$DESK_QUEUE"; }

# ---- AC10: no query, no intake -------------------------------------------------------------------
config yes '`none`'; running_batch; search A-1
out=$(tick)
check "AC10: with the intake query row none, a tick runs no intake" '[ "$(count "$T/jira.calls")" = 0 ] && [ "$(count "$T/triage.calls")" = 0 ]'
config yes ''
out=$(intake --json)
check "AC10: with the row absent, intake does nothing" '[ "$(count "$T/jira.calls")" = 0 ] && grep -q "\"ran\":false" <<< "$out"'
config yes

# ---- AC9: autopilot-workers must be yes --------------------------------------------------------
for perm in ask no; do
  config "$perm"; out=$(intake)
  check "AC9: with autopilot-workers $perm, the report says intake needs it yes" 'grep -q "standing intake needs config §3 autopilot-workers to be \"yes\" (it is \"$perm\")" <<< "$out"'
  check "AC9: with autopilot-workers $perm, nothing is searched or admitted" '[ "$(count "$T/jira.calls")" = 0 ] && [ "$(qget tickets.A-1)" = undefined ]'
done
config yes

# ---- AC11: a failed search -----------------------------------------------------------------------
touch "$T/search.fails"
out=$(intake)
check "AC11: a failed search admits nothing and names the error" 'grep -q "the Jira search failed (desk-jira: HTTP 503 from Jira); the next intake tries again" <<< "$out" && [ "$(count "$T/triage.calls")" = 0 ]'
out=$(cd "$T/repo" && node "$T/bin/intake.mjs" run 2>&1)
check "AC11: the next run tries again without waiting out the interval" '[ "$(count "$T/jira.calls")" = 2 ]'
rm -f "$T/search.fails"

# ---- AC1: a clean lane A ticket joins the running batch ----------------------------------------
rec A-1 A; search A-1
out=$(tick)
check "AC1: the ticket is triaged" 'grep -qx A-1 "$T/triage.calls"'
check "AC1: it is admitted into the running batch" '[ "$(qget tickets.A-1.state)" = triaged ] && [ "$(qget batch)" = b1 ]'
check "AC1: the queue records it as admitted by intake" '[ "$(qget tickets.A-1.admitted_by)" = intake ]'
check "AC1: the pass report lists it as admitted by intake" 'grep -q "intake: admitted A-1 by intake into batch b1 (lane A, size S)" "$T/state/supervisor.log" && grep -A1 "intake: admitted A-1" "$T/state/supervisor.log" | grep -q "^no change this pass$"'
check "AC1: the search used the configured query" 'tail -1 "$T/jira.calls" | grep -q "^search project = ACME AND labels = autopilot 100 --json$"'

# ---- AC8: once only ------------------------------------------------------------------------------
n=$(count "$T/triage.calls")
out=$(intake)
check "AC8: an admitted ticket is not triaged or admitted again" '[ "$(count "$T/triage.calls")" = "$n" ] && ! grep -q "A-1" <<< "$out"'
full=(); while [ ${#full[@]} -lt 100 ]; do full+=(A-1); done
search "${full[@]}"; out=$(intake)
check "a full page of search results is reported, never silent" 'grep -q "the search returned its limit of 100 tickets" <<< "$out"'
check "the interval holds intake back: a tick soon after searches nothing" 'j=$(count "$T/jira.calls"); tick >/dev/null; [ "$(count "$T/jira.calls")" = "$j" ]'

# ---- AC3 to AC6: what goes to the digest --------------------------------------------------------
rec C-1 C; rec D-1 D
rec L-1 A '"lint":[{"severity":"blocking","rule":"ac","message":"no acceptance criteria"}]'
rec Q-1 A '"unknowns":["which plan tier?"]'
rec X-1 A '"size":"XL"'
search A-1 C-1 D-1 L-1; out=$(intake)
check "AC3: a lane C ticket is not admitted" '[ "$(qget tickets.C-1)" = undefined ]'
check "AC3: it goes to the digest with its lane and reason" '[ "$(handed C-1)" = "handed: lane C: needs a plan" ]'
check "AC3: so does lane D with no saved canvas, saying why" '[ "$(qget tickets.D-1)" = undefined ] && [ "$(handed D-1)" = "handed: lane D: its design was never read: re-run triage; needs a plan" ]'
check "AC4: a blocking lint finding is not admitted, and goes to the digest with the finding" '[ "$(qget tickets.L-1)" = undefined ] && [ "$(handed L-1)" = "handed: lint (blocking): no acceptance criteria" ]'
check "the report names each ticket handed on" 'grep -q "intake: handed C-1 to the digest: lane C: needs a plan" <<< "$out"'
search Q-1 X-1; out=$(intake)
check "AC5: open triage questions are not admitted, and go to the digest" '[ "$(qget tickets.Q-1)" = undefined ] && [ "$(handed Q-1)" = "handed: open question(s): which plan tier?" ]'
check "AC6: size XL is not admitted, and the digest item says it needs splitting" '[ "$(qget tickets.X-1)" = undefined ] && [ "$(handed X-1)" = "handed: size XL: it needs splitting before a worker takes it" ]'
n=$(count "$T/triage.calls")
# An epic whose triage names no branch has no feature batch to start: it goes to the digest with why.
rec E-1 A '"type":"Epic"'
echo '{"issues":[{"key":"E-1","fields":{"issuetype":{"name":"Epic","hierarchyLevel":1}}}]}' > "$T/search.json"; out=$(intake)
check "DS-351: an epic is triaged as an epic, never admitted into the standing batch" '[ "$(count "$T/triage.calls")" = $((n + 1)) ] && [ "$(qget tickets.E-1)" = undefined ]'
check "DS-351: an epic whose feature batch cannot start goes to the digest with why" '[ "$(handed E-1)" = "handed: an epic, and its feature batch was not started: its triage record names no branch for the feature batch: run /desk-autopilot E-1" ]'
n=$(count "$T/triage.calls")
search C-1 Q-1 X-1; out=$(intake)
check "AC8: a ticket already handed on is not triaged again" '[ "$(count "$T/triage.calls")" = "$n" ] && [ "$out" = "intake: nothing new" ]'

# The digest lists what intake handed on, with the way to try it again.
D=$(cd "$T/repo" && node --input-type=module -e "
import { openQuestions, renderPage } from '$B/digest.mjs';
const qs = openQuestions({ slug: 'acme__widgets', state: '$T/state', queue: '$DESK_QUEUE' });
console.log(renderPage({ slot: '2026-10-23T08:00', since: null, groups: [{ slug: 'acme__widgets', questions: qs, decisions: [] }], bin: '/b' }));")
check "the digest lists each ticket intake handed on, with why" 'grep -q "^- \[ \] \`C-1\` (intake): not admitted by intake: lane C: needs a plan$" <<< "$D" && grep -q "\`X-1\` (intake): not admitted by intake: size XL" <<< "$D"'
check "the digest says how to let intake try it again" 'grep -q "DESK_AUTOPILOT_STATE=$T/state node /b/intake.mjs forget C-1" <<< "$D"'
out=$(cd "$T/repo" && node "$T/bin/intake.mjs" forget X-1)
check "forget takes a ticket out of the register" '[ "$(handed X-1)" = none ] && grep -q "next intake triages it again" <<< "$out"'

# ---- AC7: blocked by a ticket not yet merged ----------------------------------------------------
rec B-2 A '"blockers":[{"key":"A-1","category":"indeterminate"}]'
search B-2; out=$(intake)
check "AC7: a ticket blocked by one in the batch is admitted and held behind it" '[ "$(qget tickets.B-2.held_by)" = A-1 ] && [ "$(qget tickets.B-2.state)" = parked ]'
check "AC7: the report says it is held" 'grep -q "admitted B-2 by intake into batch b1 (lane A, size S), held behind A-1" <<< "$out"'
# A blocker found in the same run is admitted first, whichever order the search gives.
rec B-4 A '"blockers":[{"key":"B-3","category":"new"}]'; rec B-3 A
search B-4 B-3; out=$(intake)
check "AC7: a blocker found in the same search is admitted first and the other held behind it" '[ "$(qget tickets.B-3.state)" = triaged ] && [ "$(qget tickets.B-4.held_by)" = B-3 ]'
rec B-6 A '"blockers":[{"key":"A-1","category":"done"}]'
search B-6; out=$(intake)
check "DS-391 AC4: a blocker in the batch that is Done in Jira but not merged there still holds it" '[ "$(qget tickets.B-6.state)" = parked ] && [ "$(qget tickets.B-6.held_by)" = A-1 ] && [ "$(qget tickets.B-6.held_outside)" = undefined ]'
# A blocker in no batch holds the ticket rather than keeping it out. DONE-2 is Done with its PR
# still open, DONE-3 Done with its PR merged to main; DONE-1 is Done with no PR.
printf '%s\n' '[{"number":5,"state":"OPEN","title":"fix: DONE-2 x","headRefName":"fix/DONE-2-x","baseRefName":"main"},{"number":6,"state":"MERGED","title":"fix: DONE-3 y","headRefName":"fix/DONE-3-y","baseRefName":"main"},{"number":7,"state":"OPEN","title":"fix: DONE-33 z","headRefName":"fix/DONE-33","baseRefName":"main"}]' > "$T/prs.json"
rec B-5 A '"blockers":[{"key":"OUT-9","category":"new"},{"key":"DONE-1","category":"done"},{"key":"DONE-2","category":"done"},{"key":"DONE-3","category":"done"}]'
search B-5; out=$(intake)
check "DS-391 AC1: a ticket blocked by an open ticket in no batch is admitted held by it" '[ "$(qget tickets.B-5.state)" = parked ] && [ "$(qget tickets.B-5.held_by)" = "OUT-9|DONE-2" ] && [ "$(qget tickets.B-5.held_outside)" = "OUT-9|DONE-2" ] && [ "$(handed B-5)" != none ] && ! grep -q "^handed" <<< "$(handed B-5)"'
check "DS-391 AC4: a blocker Done in Jira whose PR has not merged to the base holds it; one merged, or with no PR, does not" '! grep -q "DONE-1\|DONE-3" <<< "$(qget tickets.B-5.held_by)"'
check "DS-391 AC1: the report says what it waits for and until when" 'grep -q "admitted B-5 by intake into batch b1 (lane A, size S), waiting for OUT-9, DONE-2, outside the batch, until each is Done and on main" <<< "$out"'
rm -f "$T/prs.json"

# ---- the triage cap, and a triage that fails ------------------------------------------------------
for k in M-1 M-2 M-3 M-4; do rec "$k" A; done
search M-1 M-2 M-3 M-4; out=$(intake)
check "at most three are triaged a run, and the report names the rest" '[ "$(qget tickets.M-3.state)" = triaged ] && [ "$(qget tickets.M-4)" = undefined ] && grep -q "1 more ticket(s) wait for the next intake (M-4)" <<< "$out"'
out=$(intake)
check "the rest are taken next run" '[ "$(qget tickets.M-4.state)" = triaged ]'
rec F-1 A; touch "$T/recs/F-1.fails"; search F-1
out=$(intake)
check "a triage that fails is not admitted, and is tried again next run" '[ "$(qget tickets.F-1)" = undefined ] && grep -q "F-1 not admitted: triage failed: triage: claude exited 1; the next intake tries again" <<< "$out"'
out=$(intake); out=$(intake)
check "after three failed triages it goes to the digest" 'grep -q "^handed: triage failed" <<< "$(handed F-1)"'

# ---- a batch still being planned ---------------------------------------------------------------
printf '{"version":1,"batch":"p1","supervised":false,"tickets":{"P":{"key":"P","state":"triaged"}}}\n' > "$DESK_QUEUE"
rec A-9 A; search A-9; out=$(intake)
check "nothing joins a batch a session has not handed over" '[ "$(qget tickets.A-9)" = undefined ] && grep -q "admits nothing while batch p1 is not handed over" <<< "$out"'

# ---- AC2: no live batch ------------------------------------------------------------------------
# A session's batch between `queue.mjs init` and its plan has no tickets yet: still the session's.
printf '{"version":1,"batch":"p2","supervised":false,"tickets":{}}\n' > "$DESK_QUEUE"
out=$(intake)
check "nothing joins, or replaces, a session's batch that has no tickets yet" '[ "$(qget batch)" = p2 ] && [ "$(qget tickets.A-9)" = undefined ] && grep -q "admits nothing while batch p2 is not handed over" <<< "$out"'

# The register goes too, so the tick finds intake due.
rm -f "$DESK_QUEUE" "$T/state/supervisor.json" "$T/state/intake.json"
p=$(count "$T/pass.calls")
out=$(tick)
check "AC2: with no batch, intake starts a standing one for the ticket" 'grep -q "^standing-" <<< "$(qget batch)" && [ "$(qget tickets.A-9.state)" = triaged ]'
check "AC2: the standing batch is handed over to the supervisor" '[ "$(qget supervised)" = true ]'
check "AC2: the same tick runs a pass for it, reporting the start" '[ "$(count "$T/pass.calls")" = $((p + 1)) ] && grep -B1 "intake: started standing batch standing-" "$T/state/supervisor.log" | grep -q "pass: exit 10"'
i=0; while ! grep -q -- "--tickets A-9 --log" "$T/driver.calls" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
check "AC2: the merge driver picks it up" 'grep -q -- "--tickets A-9 --log" "$T/driver.calls"'
# A finished batch is not live either: the next ticket starts a new one. A blocker in it is outside the
# new one, so a ticket it blocks is held by it there.
printf '{"version":1,"batch":"old","supervised":true,"tickets":{"Z":{"key":"Z","state":"done","result":{"pr":null}}}}\n' > "$DESK_QUEUE"
rec A-7 A '"blockers":[{"key":"Z","category":"indeterminate"}]'
rec A-8 A; search A-8 A-7; out=$(intake)
check "AC2: a finished batch gets a new standing batch" 'grep -q "^standing-" <<< "$(qget batch)" && [ "$(qget tickets.A-8.state)" = triaged ] && [ "$(qget tickets.Z)" = undefined ]'
check "a blocker left in the finished batch holds its ticket in the new one" '[ "$(qget tickets.A-7.held_outside)" = Z ] && grep -q "^admitted: lane A, size S, waiting for Z, outside the batch" <<< "$(handed A-7)"'
# Not finished: a failed ticket waits on the person, and a batch on a base has its gate to come.
printf '{"version":1,"batch":"f1","supervised":false,"tickets":{"Z":{"key":"Z","state":"failed"}}}\n' > "$DESK_QUEUE"
rec A-6 A; search A-6; out=$(intake)
check "a batch with a failed ticket is not replaced" '[ "$(qget batch)" = f1 ] && [ "$(qget tickets.A-6)" = undefined ] && grep -q "batch f1 is not handed over" <<< "$out"'
printf '{"version":1,"batch":"feat","base":"feat/x","supervised":true,"tickets":{"Z":{"key":"Z","state":"done","result":{"pr":null}}}}\n' > "$DESK_QUEUE"
out=$(intake)
check "nothing joins or replaces a batch on a base" '[ "$(qget batch)" = feat ] && [ "$(qget tickets.A-6)" = undefined ] && grep -q "runs on base feat/x" <<< "$out"'
# queue.mjs checks again under its lock: a batch that is no longer the finished one is left alone.
printf '{"version":1,"batch":"p3","supervised":false,"tickets":{}}\n' > "$DESK_QUEUE"
out=$(cd "$T/repo" && node "$T/bin/queue.mjs" init standing-x --standing --if-batch old 2>&1); rc=$?
check "init --standing refuses a queue that is not the batch intake found finished" '[ $rc -ne 0 ] && [ "$(qget batch)" = p3 ] && grep -q "left as it is" <<< "$out"'
out=$(cd "$T/repo" && node "$T/bin/queue.mjs" init named-batch 2>&1)
check "a plain init keeps the batch name it is given" '[ "$(qget batch)" = named-batch ]'

# ---- with no batch at all, what intake hands on still reaches the check-in ----------------------
rm -f "$DESK_QUEUE" "$T/state/intake.json"; search C-1; d=$(count "$T/digest.calls")
out=$(tick)
check "with no batch, a tick that hands a ticket on runs the check-in" '[ ! -f "$DESK_QUEUE" ] && [ "$(handed C-1)" = "handed: lane C: needs a plan" ] && [ "$(count "$T/digest.calls")" = $((d + 1)) ]'
mkdir -p "$T/sroot/acme__other"; echo '{}' > "$T/sroot/acme__other/intake.json"
R=$(node --input-type=module -e "import { repos } from '$B/digest.mjs'; console.log(repos({ home: '$T/nohome', root: '$T/sroot' }).map((r) => r.slug).join(','));")
check "the digest finds a repo whose only news is intake's" '[ "$R" = acme__other ]'

# ---- a Claude Design canvas no worker can read -------------------------------------------------
# design <url> <snapshot or null>: the design fact triage records for one linked canvas.
design(){ printf '"design":{"ref":"origin/main","canvases":[{"url":"%s","saved":null,"snapshot":%s}],"figma":false}' "$1" "$2"; }
config yes; running_batch; rec G-1 A "$(design https://claude.ai/artifact/G1 null)"; search G-1
out=$(intake)
check "DS-358 AC5: intake admits a ticket whose canvas has no snapshot parked, not runnable" '[ "$(qget tickets.G-1.state)" = parked ] && grep -q "^design not snapshotted: https://claude.ai/artifact/G1: snapshot it from a session" <<< "$(qget tickets.G-1.park.question)"'
check "DS-358 AC5: the report names the artifact" 'grep -q "intake: admitted G-1 by intake into batch b1 (lane A, size S), parked: design not snapshotted: https://claude.ai/artifact/G1" <<< "$out"'
# Triage's lint flags the same canvas as blocking; the design park names it, so intake parks rather
# than hands it on. Its blocker in the batch is kept, and a requeue once it is snapshotted holds it.
config yes; running_batch; rm -f "$T/state/intake.json"
rec G-2 A "$(design https://claude.ai/artifact/G2 null),\"lint\":[{\"severity\":\"blocking\",\"rule\":\"design\",\"message\":\"design: G-2's Design section links the Claude Design artifact https://claude.ai/artifact/G2, but no copy is saved under docs/design/\"}],\"blockers\":[{\"key\":\"R\",\"category\":\"new\"}]"; search G-2
out=$(intake)
check "DS-358 AC5: a blocking design lint on the unread canvas still parks the ticket on its design" '[ "$(qget tickets.G-2.state)" = parked ] && grep -q "^design not snapshotted: https://claude.ai/artifact/G2" <<< "$(qget tickets.G-2.park.question)"'
check "DS-358: the design-parked ticket keeps its blocker in the batch" '[ "$(qget tickets.G-2.held_by)" = R ]'
requeue(){ (cd "$T/repo" && node "$T/bin/queue.mjs" requeue "$1" 2>&1); }
out=$(requeue G-2)
check "DS-358: a requeue holds it behind its unmerged blocker, never straight to a worker" '[ "$(qget tickets.G-2.state)" = parked ] && grep -q "^held by orchestrator: blocked by R" <<< "$(qget tickets.G-2.park.question)" && grep -q "held behind R until they merge" <<< "$out"'
node -e 'const f=process.argv[1],fs=require("fs"),q=JSON.parse(fs.readFileSync(f,"utf8")); q.tickets.R={key:"R",state:"done",merged_at:"2026-10-01T00:00:00Z"}; Object.assign(q.tickets["G-2"],{park:{question:"design not snapshotted: x"}}); fs.writeFileSync(f,JSON.stringify(q))' "$DESK_QUEUE"
out=$(requeue G-2)
check "DS-358: with its blocker merged, a requeue sends it to a worker" '[ "$(qget tickets.G-2.state)" = triaged ] && [ "$(qget tickets.G-2.held_by)" = null ]'

# ---- by hand: intake.mjs admit (/desk-admit) -----------------------------------------------------
admit(){ (cd "$T/repo" && node "$T/bin/intake.mjs" admit "$@" 2>&1); }
config yes '`none`'; running_batch; rm -f "$T/state/intake.json"
rec H-1 A; n=$(count "$T/triage.calls")
out=$(admit H-1 --by ben); rc=$?
check "admit: a clean ticket joins the supervised batch with no intake query set" '[ $rc -eq 0 ] && [ "$(qget tickets.H-1.state)" = triaged ] && [ "$(qget tickets.H-1.admitted_by)" = ben ]'
check "admit: it is triaged afresh, and the line says who admitted it and that the tick picks it up" '[ "$(count "$T/triage.calls")" = $((n + 1)) ] && grep -q "^admitted H-1 by ben into batch b1 (lane A, size S)$" <<< "$out" && grep -q "next tick picks it up" <<< "$out"'
check "admit: the register records it, so intake never takes it again" 'grep -q "^admitted: lane A, size S, by ben$" <<< "$(handed H-1)"'
out=$(admit H-1); rc=$?
check "admit: a ticket already in the batch is said so, not triaged again" '[ $rc -eq 0 ] && grep -q "H-1 is already in batch b1 (triaged)" <<< "$out" && [ "$(count "$T/triage.calls")" = $((n + 1)) ]'
rec H-2 A '"unknowns":["which tier?"]'; rec H-3 C
out=$(admit H-2 H-3); rc=$?
check "admit: a ticket failing a check is refused to the person with why, exit 11" '[ $rc -eq 11 ] && grep -q "^not admitted H-2: open question(s): which tier?$" <<< "$out" && grep -q "^not admitted H-3: lane C: needs a plan$" <<< "$out"'
check "admit: a refused ticket is not queued or handed to the digest" '[ "$(qget tickets.H-2)" = undefined ] && [ "$(handed H-2)" = none ]'
rec H-5 A '"blockers":[{"key":"H-4","category":"new"}]'; rec H-4 A
out=$(admit H-5 H-4 --front)
check "admit: a blocker named in the same call goes first, and the other is held behind it" '[ "$(qget tickets.H-4.state)" = triaged ] && [ "$(qget tickets.H-5.held_by)" = H-4 ]'
# K-1 is refused (lane C); K-2 behind it and K-3 behind K-2 are not refused for it.
rec K-1 C; rec K-2 A '"blockers":[{"key":"K-1","category":"new"}]'; rec K-3 A '"blockers":[{"key":"K-2","category":"new"}]'
out2=$(admit K-3 K-2 K-1); rc=$?
check "DS-391 AC2: a dependant of a blocker refused in the call waits for it, and none is refused for not being in the batch" \
  '[ $rc -eq 11 ] && grep -q "^not admitted K-1: lane C" <<< "$out2" && ! grep -q "not in the batch" <<< "$out2" && [ "$(qget tickets.K-2.held_outside)" = K-1 ] && [ "$(qget tickets.K-3.held_by)" = K-2 ]'
check "DS-391 AC2: the line names the blocker as waited for and not admitted in this call, and admits nothing more for it" \
  'grep -q "^admitted K-2 by hand into batch b1 (lane A, size S), waiting for K-1 (not admitted in this call), outside the batch, until it is Done and on main$" <<< "$out2" && ! grep -q "^admit next" <<< "$out2"'
# A cascade: N-1 is blocked by NX, open and in no batch; N-2 and N-3 are blocked by N-1.
rec N-1 A '"blockers":[{"key":"NX","category":"new"}]'; rec N-2 A '"blockers":[{"key":"N-1","category":"new"}]'; rec N-3 A '"blockers":[{"key":"N-1","category":"indeterminate"}]'
out2=$(admit N-3 N-2 N-1); rc=$?
check "DS-391: the KAN-1292 cascade is admitted whole, the root held by its blocker in no batch and the rest behind the root" \
  '[ $rc -eq 0 ] && [ "$(qget tickets.N-1.held_outside)" = NX ] && [ "$(qget tickets.N-2.held_by)" = N-1 ] && [ "$(qget tickets.N-3.held_by)" = N-1 ] && ! grep -q "^not admitted" <<< "$out2"'
check "DS-391 AC5: an open blocker in no batch is named for /desk-admit to admit next" 'grep -qx "admit next: NX (open blockers in no batch)" <<< "$out2"'
check "admit: --front moves each admitted ticket to the front" 'grep -q "H-4 moved to the front of the spawn order" <<< "$out" && [ "$(node -e "console.log(Object.keys(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).tickets)[0])" "$DESK_QUEUE")" = H-5 ]'
rec H-9 A "$(design https://claude.ai/artifact/H9 null)"; rec H-10 A "$(design https://claude.ai/artifact/H10 '"/snap/H-10"')"
out=$(admit H-9 H-10 --by ben); rc=$?
check "DS-358 AC4: /desk-admit refuses a ticket whose canvas has no snapshot, naming the artifact" '[ $rc -eq 11 ] && grep -q "^not admitted H-9: design not snapshotted: https://claude.ai/artifact/H9: snapshot it into $T/state/designs/H-9/ and record it (desk-design write), or have it shared" <<< "$out" && [ "$(qget tickets.H-9)" = undefined ]'
check "DS-358 AC1: a snapshotted canvas is admitted runnable" '[ "$(qget tickets.H-10.state)" = triaged ]'
# Without autopilot-workers yes, a session plans an epic with the person.
config ask '`none`'
rec H-6 A '"type":"Epic"'
out=$(admit H-6); rc=$?
check "DS-300 AC1: without autopilot-workers yes, an epic is reported as one to plan as a feature batch, not refused" '[ $rc -ne 11 ] && grep -q "^plan H-6 as a feature batch beside the standing batch: /desk-autopilot H-6$" <<< "$out" && ! grep -q "not admitted" <<< "$out" && [ "$(qget tickets.H-6)" = undefined ]'
rec H-8 A
out=$(admit H-6 H-8); rc=$?
check "DS-300 AC2: an epic and a ticket in one call: the ticket is admitted, the epic reported to plan" '[ $rc -ne 11 ] && [ "$(qget tickets.H-8.state)" = triaged ] && grep -q "^admitted H-8 by hand into batch b1" <<< "$out" && grep -q "^plan H-6 as a feature batch" <<< "$out"'
config yes '`none`'
SK="$S/../skills/desk-admit/SKILL.md"
check "DS-300: the desk-admit skill routes a plan line to the /desk-autopilot epic flow" 'grep -q "^Each \`plan <EPIC> as a feature batch beside the standing batch: /desk-autopilot <EPIC>\` line means" "$SK" && grep -q "Load \`desk-autopilot\` and run its epic flow" "$SK" && ! grep -q "| \`an epic\` | Plan it as a feature batch" "$SK"'
check "DS-391 AC5: the desk-admit skill admits an open blocker named by admit next with no question, and no longer asks to" \
  'grep -q "^\`admit next: <B>...\` line\*\* names the open blockers in no batch" "$SK" && grep -q "^again for exactly those, at once, with no question" "$SK" && ! grep -q "which is not done and not in the batch" "$SK"'
printf '{"version":1,"batch":"s1","supervised":false,"tickets":{"P":{"key":"P","state":"running"}}}\n' > "$DESK_QUEUE"
rec H-7 A; n=$(count "$T/triage.calls")
out=$(admit H-7); rc=$?
check "admit: a session-run batch is refused before any triage, pointing at that session" '[ $rc -eq 11 ] && [ "$(count "$T/triage.calls")" = "$n" ] && grep -q "is run by a session, not the supervisor: send these tickets to that session" <<< "$out"'
rm -f "$DESK_QUEUE"; config ask '`none`'
out=$(admit H-7); rc=$?
check "admit: with no batch and autopilot-workers not yes, it points at /desk-autopilot" '[ $rc -eq 11 ] && [ ! -f "$DESK_QUEUE" ] && grep -q "run /desk-autopilot H-7" <<< "$out"'
config yes '`none`'
out=$(admit H-7)
check "admit: with no batch and autopilot-workers yes, it starts a standing batch handed to the supervisor" 'grep -q "^standing-" <<< "$(qget batch)" && [ "$(qget supervised)" = true ] && [ "$(qget tickets.H-7.state)" = triaged ]'

# ---- two batches: a ticket is in one batch at most ----------------------------------------------
NB="$DESK_HOME/repos/acme__widgets/batches/X-1"; mkdir -p "$NB"
printf '{"version":1,"batch":"X-1","tickets":{"X-2":{"key":"X-2","state":"running"}}}\n' > "$NB/queue.json"
config yes; running_batch; rm -f "$T/state/intake.json"
rec X-2 A; rec X-3 A '"epic":{"key":"X-1","summary":"a feature"}'; rec X-4 A '"epic":{"key":"X-1","summary":"a feature"}'
n=$(count "$T/triage.calls")
search X-2; out=$(intake)
check "DS-307 AC2: a ticket in another batch is not triaged, admitted or handed on" '[ "$(count "$T/triage.calls")" = "$n" ] && [ "$(qget tickets.X-2)" = undefined ] && [ "$(handed X-2)" = none ]'
search X-3; out=$(intake)
check "DS-307 AC3: a new child of an epic with a live feature batch is not admitted" '[ "$(qget tickets.X-3)" = undefined ] && grep -q "^elsewhere: " <<< "$(handed X-3)"'
check "DS-307 AC3: the intake line names the feature batch" 'grep -q "intake: X-3 not admitted: X-3 is a child of epic X-1, whose feature batch X-1 is running" <<< "$out"'
check "DS-300 AC5: the intake line for a running epic's child points at /desk-admit" 'grep -q "intake: X-3 not admitted: .*: /desk-admit X-3 adds it to that batch$" <<< "$out"'
n=$(count "$T/triage.calls"); out=$(intake)
check "DS-307 AC3: it is not triaged again while that batch is live" '[ "$(count "$T/triage.calls")" = "$n" ] && [ "$out" = "intake: nothing new" ]'
before=$(cat "$DESK_QUEUE")
NQ="$NB/queue.json"; NS="$HOME/.desk-autopilot/acme__widgets/batches/X-1"
nget(){ node -e 'const q=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],q); console.log(typeof v==="object"?JSON.stringify(v):String(v))' "$NQ" "$1"; }
# Pinned, as a session that has loaded its paths is: the child's triage in X-1 must not inherit it.
out=$(DESK_DEFAULT_BRANCH=main admit X-4 --by ben); rc=$?
check "DS-300 AC4: /desk-admit adds a live epic's child to its feature batch" '[ $rc -eq 0 ] && [ "$(nget tickets.X-4.state)" = triaged ] && [ "$(nget tickets.X-4.admitted_by)" = ben ] && grep -q "^admitted X-4 by ben into feature batch X-1 (lane A, size S)$" <<< "$out"'
check "DS-300 AC4: the standing queue is unchanged" '[ "$(cat "$DESK_QUEUE")" = "$before" ] && [ -f "$NS/triage/X-4.json" ]'
check "DS-300 AC4: the child is triaged again in its feature batch, on that batch's base rather than a pinned default" 'grep -qx "X-4 X-1 unpinned" "$T/triage.batch"'
# X-5 is blocked by X-4, now in the feature batch, and shares a file with X-2, running there.
mkdir -p "$NS/triage"; printf '{"ticket":"X-2","files_in_scope":["src/shared.js"]}\n' > "$NS/triage/X-2.json"
rec X-5 A '"epic":{"key":"X-1","summary":"a feature"},"files_in_scope":["src/shared.js"],"blockers":[{"key":"X-4","category":"new"}]'
out=$(admit X-5); rc=$?
check "DS-300 AC4: a child is held behind its blocker there and behind an in-flight child it collides with" '[ $rc -eq 0 ] && [ "$(nget tickets.X-5.state)" = parked ] && [ "$(nget tickets.X-5.held_by)" = "X-4|X-2" ] && grep -q "into feature batch X-1 (lane A, size S), held behind X-4, X-2$" <<< "$out" && [ "$(cat "$DESK_QUEUE")" = "$before" ]'
# In feature mode, X-2 is the spine: a child sharing nothing with it still waits for it.
node -e 'const f=require("fs"),p=process.argv[1],q=JSON.parse(f.readFileSync(p,"utf8")); q.feature=true; q.spine="X-2"; f.writeFileSync(p,JSON.stringify(q))' "$NQ"
rec X-6 A '"epic":{"key":"X-1","summary":"a feature"}'
out=$(admit X-6); rc=$?
check "DS-300 AC4: in feature mode a child is held behind the unfinished spine, as plan-batch holds every child" '[ $rc -eq 0 ] && [ "$(nget tickets.X-6.held_by)" = X-2 ] && grep -q "into feature batch X-1 (lane A, size S), held behind X-2$" <<< "$out"'
# Y-1 is in no epic, but its blocker X-4 is in feature batch X-1: it joins X-1, not b1.
rec Y-1 A '"blockers":[{"key":"X-4","category":"indeterminate"}]'
out=$(admit Y-1); rc=$?
check "DS-391 AC3: a ticket whose blocker is in another live batch is placed in that batch, held behind it there" \
  '[ $rc -eq 0 ] && [ "$(qget tickets.Y-1)" = undefined ] && [ "$(nget tickets.Y-1.held_by)" = "X-2|X-4" ] && [ "$(nget tickets.Y-1.held_outside)" = undefined ] && grep -q "^admitted Y-1 by hand into feature batch X-1 (lane A, size S), held behind X-2, X-4$" <<< "$out"'
rec E-2 A '"type":"Epic"'
config ask; out=$(admit E-2); rc=$?; config yes
check "DS-352 AC1: with a feature batch live, another epic is planned as its own feature batch, not refused" '[ $rc -eq 0 ] && grep -q "^plan E-2 as a feature batch beside the standing batch" <<< "$out" && ! grep -q "^not admitted E-2" <<< "$out"'
rec X-1 A '"type":"Epic"'
out=$(admit X-1); rc=$?
check "DS-352 AC1: an epic whose own feature batch is live is refused naming it" '[ $rc -eq 11 ] && grep -q "^not admitted X-1: an epic, and its feature batch X-1 is already running" <<< "$out" && ! grep -q "^plan X-1" <<< "$out"'
n=$(count "$T/triage.calls"); out=$(admit X-2); rc=$?
check "DS-307 AC4: /desk-admit refuses a ticket in another batch before any triage" '[ $rc -eq 11 ] && grep -q "^not admitted X-2: X-2 is in batch X-1" <<< "$out" && [ "$(count "$T/triage.calls")" = "$n" ] && [ "$(cat "$DESK_QUEUE")" = "$before" ]'
mkdir -p "$DESK_HOME/repos/acme__widgets/batches/.done"; mv "$NB" "$DESK_HOME/repos/acme__widgets/batches/.done/X-1"
out=$(intake)
check "DS-307: once the feature batch is archived, its child is taken as any other" '[ "$(qget tickets.X-3.state)" = triaged ]'
YB="$DESK_HOME/repos/acme__widgets/batches/Y-1"; mkdir -p "$YB"
printf '{"version":1,"batch":"Y-1","tickets":{"Y-0":{"key":"Y-0","state":"done"}}}\n' > "$YB/queue.json"
rec Y-2 A '"epic":{"key":"Y-1","summary":"a shipped feature"}'
search Y-2; out=$(intake)
check "DS-307: a feature batch finished in place, never archived, does not hold its epic's new child" '[ "$(qget tickets.Y-2.state)" = triaged ]'
ZB="$DESK_HOME/repos/acme__widgets/batches/Z-1"; mkdir -p "$ZB"; printf '{ not json' > "$ZB/queue.json"
rec Z-2 A; rec Z-3 A
search Z-2 Z-3; out=$(intake); rc=$?
check "DS-307: another batch's unreadable queue is reported per ticket, and the run carries on" '[ $rc -eq 0 ] && grep -q "intake: not admitted: Z-2 cannot be checked against batch Z-1" <<< "$out" && grep -q "Z-3 cannot be checked" <<< "$out" && [ "$(qget tickets.Z-2)" = undefined ]'
rm -rf "$ZB"; out=$(intake)
check "DS-307: once that queue is fixed, the ticket is taken" '[ "$(qget tickets.Z-2.state)" = triaged ]'

# ---- DS-351: an epic admitted with no session ------------------------------------------------------
# The checkout gets an origin to push the feature branch to. expand-parent and plan-batch are fakes in
# the batch's state: the children named in $T/children/<EPIC>, and a feature-mode plan that wants a
# spine and owner table until feature.json holds one. The drafter is a fake claude answering as told.
git init -q --bare "$T/origin.git"
git -C "$T/repo" init -q -b main
git -C "$T/repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
git -C "$T/repo" remote add origin "$T/origin.git"; git -C "$T/repo" push -q origin main
mkdir -p "$T/children"
cat > "$T/bin/expand-parent.mjs" <<EOF
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const key = process.argv[2], s = process.env.DESK_AUTOPILOT_STATE;
mkdirSync(s, { recursive: true });
writeFileSync(s + '/expansion.json', JSON.stringify({ parent: key, containers: {}, criteria: [{ id: 'AC1', text: 'it works' }] }));
process.stdout.write(readFileSync('$T/children/' + key, 'utf8'));
EOF
# As plan-batch does, it asks on the epic when feature.json's AC1 owner is not a ticket it was given, and
# with AUTOPILOT_WRITE_QUEUE it seeds the named tickets, each held behind the spine where feature.json
# names one.
cat > "$T/bin/plan-batch.mjs" <<EOF
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const s = process.env.DESK_AUTOPILOT_STATE, epic = process.env.DESK_BATCH, seed = Boolean(process.env.AUTOPILOT_WRITE_QUEUE);
const keys = process.argv.slice(2).filter((a) => a !== '--json');
appendFileSync('$T/plan.calls', epic + ' ' + process.argv.slice(2).join(' ') + (seed ? ' (seed)' : '') + '\n');
const plan = existsSync(s + '/feature.json') ? JSON.parse(readFileSync(s + '/feature.json', 'utf8')) : null;
const owner = plan?.owners?.AC1;
const qs = owner && !keys.includes(owner) ? ["AC1's owner " + owner + ' is not a child this batch builds: name another owner'] : [];
const message = ['FEATURE MODE — on', plan ? '  AC1 owner ' + plan.owners.AC1 : '  no feature plan yet'];
const needs = [...(plan?.spine ? [] : [{ ticket: epic, why: 'feature_plan', detail: 'the plan' }]), ...qs.map((q) => ({ ticket: epic, why: 'question', detail: q }))];
if (seed) {
  const q = (...a) => execFileSync(process.execPath, ['$T/bin/queue.mjs', ...a], { stdio: 'ignore' });
  for (const k of keys) { q('add', k, 'Story', 'A'); q('set', k, 'state=triaged', 'held_by=null'); }
  for (const k of keys) if (plan?.spine && k !== plan.spine) q('hold', k, plan.spine);
}
console.log(JSON.stringify({ status: needs.length ? 'show_person' : 'go_on', code: needs.length ? 11 : 0, message, needs_person: needs }));
process.exitCode = needs.length ? 11 : 0;
EOF
cat > "$T/claude.out" <<'EOF'
{"type":"result","total_cost_usd":0.12,"result":"Drafted.\nPLAN_RESULT: {\"draft\": \"Spine: one strict expected-fail spec for AC1\", \"owners\": {\"AC1\": \"E-6\"}}"}
EOF
printf '#!/bin/sh\nprintf "%%s\\n" "$1 $2" | head -1 >> "%s/claude.calls"\n[ -f "%s/claude.fails" ] && { echo "claude: session limit" >&2; exit 1; }\ncat "%s/claude.out"\n' "$T" "$T" "$T" > "$T/fakes/claude"
chmod +x "$T/fakes/claude"
EB="$DESK_HOME/repos/acme__widgets/batches"; ES="$HOME/.desk-autopilot/acme__widgets/batches"
eget(){ node -e 'const q=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],q); console.log(typeof v==="object"?JSON.stringify(v):String(v))' "$EB/$1/queue.json" "$2"; }
rec E-6 A '"summary":"the first child"'; rec E-7 A '"summary":"the second child"'
printf 'E-6\nE-7\n' > "$T/children/E-5"; printf 'E-6\n' > "$T/children/E-8"
rec E-5 A '"type":"Epic","branch":"feat/E-5-a-feature"'; rec E-8 A '"type":"Epic","branch":"feat/E-8-another"'

# A plan the drafter cannot write leaves no batch behind.
touch "$T/claude.fails"; before=$(cat "$DESK_QUEUE")
out=$(admit E-8 --by ben); rc=$?
check "DS-351: an epic whose plan cannot be drafted is refused with why, and its batch discarded" '[ $rc -eq 11 ] && grep -q "^not admitted E-8: an epic, and its feature batch was not started: the plan drafter failed (claude: session limit); batch E-8 discarded$" <<< "$out" && [ ! -e "$EB/E-8" ] && [ ! -e "$ES/E-8" ]'
rm -f "$T/claude.fails"

out=$(admit E-5 --by ben); rc=$?
check "DS-351 AC1: /desk-admit accepts an epic, not refused" '[ $rc -eq 0 ] && ! grep -q "not admitted" <<< "$out" && grep -q "^started feature batch E-5 on feat/E-5-a-feature, beside the standing batch$" <<< "$out"'
check "DS-351 AC1: its feature batch is created on the epic's branch, pushed to origin" '[ "$(eget E-5 epic)" = E-5 ] && [ "$(eget E-5 base)" = feat/E-5-a-feature ] && [ -n "$(git -C "$T/repo" ls-remote --heads origin feat/E-5-a-feature)" ]'
check "DS-351 AC1: the batch is handed to the supervisor, and the standing queue is untouched" '[ "$(eget E-5 supervised)" = true ] && [ "$(cat "$DESK_QUEUE")" = "$before" ]'
check "DS-351 AC2: the spine and owner table are drafted headless into the batch" '[ "$(count "$T/claude.calls")" = 2 ] && grep -q -- "-p You are drafting the feature plan for epic E-5" "$T/claude.calls" && [ "$(node -e "console.log(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).owners.AC1)" "$ES/E-5/feature.json")" = E-6 ]'
check "DS-351 AC2: the drafter is given the epic's criteria and its children" 'grep -q "^- AC1: it works$" "$ES/E-5/plan-draft.prompt.md" && grep -q "^- E-7: the second child" "$ES/E-5/plan-draft.prompt.md"'
check "DS-351 AC2: the plan is written for the person, as plan-batch gives it with the draft" 'grep -q "AC1 owner E-6" "$ES/E-5/plan.md"'
check "DS-351 AC2: the epic waits in its batch on one feature-plan park naming the plan" '[ "$(eget E-5 tickets.E-5.state)" = parked ] && [ "$(eget E-5 tickets.E-5.lane)" = epic ] && grep -q "^feature plan awaiting your answer: the spine and owner table for E-5 are drafted, with 2 children held behind it: read $ES/E-5/plan.md" <<< "$(eget E-5 tickets.E-5.park.question)"'
check "DS-351 AC2: its children are triaged in the batch and wait held behind the epic" '[ "$(eget E-5 tickets.E-6.held_by)" = E-5 ] && [ "$(eget E-5 tickets.E-7.held_by)" = E-5 ] && [ "$(eget E-5 tickets.E-7.admitted_by)" = ben ] && [ -f "$ES/E-5/triage/E-7.json" ]'
check "DS-351 AC2: the line says the plan waits in /desk-needs-you" 'grep -q "its plan waits for you in /desk-needs-you" <<< "$out" && grep -q "^admitted: feature batch E-5 started, 2 children held behind its plan, by ben$" <<< "$(handed E-5)"'
out=$(cd "$T/repo" && env -u DESK_QUEUE -u DESK_AUTOPILOT_STATE node "$T/bin/queue.mjs" requeue E-5 --batch E-5 2>&1); rc=$?
check "DS-351: no queue.mjs requeue sends the epic to a worker" '[ $rc -ne 0 ] && grep -q "E-5 is lane epic" <<< "$out" && [ "$(eget E-5 tickets.E-5.state)" = parked ]'
item=$(node -e 'console.log(JSON.stringify({ id: "p", ticket: "E-5", kind: "parked", lane: "epic", text: process.argv[1] }))' "$(eget E-5 tickets.E-5.park.question)")
check "DS-351: the decider hands the plan straight on, with no session" '[ "$(cd "$T/repo" && node --input-type=module -e "import { presort } from \"$B/decider.mjs\"; const r = presort([JSON.parse(process.argv[1])]); console.log(r.hand.length, r.ask.length)" "$item")" = "1 0" ]'
rec E-10 A '"epic":{"key":"E-5","summary":"a feature"}'
out=$(admit E-10 --by ben); rc=$?
check "DS-351 AC2: a child admitted later into the waiting batch is held behind the epic too" '[ $rc -eq 0 ] && [ "$(eget E-5 tickets.E-10.state)" = parked ] && [ "$(eget E-5 tickets.E-10.held_by)" = E-5 ]'
config yes; rec E-9 A '"type":"Epic","branch":"feat/E-9-third"'; rec E-19 A '"summary":"the third epic child"'; printf 'E-19\n' > "$T/children/E-9"
echo '{"issues":[{"key":"E-9","fields":{"issuetype":{"name":"Epic","hierarchyLevel":1}}}]}' > "$T/search.json"; out=$(intake)
check "DS-352: standing intake starts another epic's feature batch beside a live one" '[ "$(eget E-9 base)" = feat/E-9-third ] && [ "$(eget E-5 base)" = feat/E-5-a-feature ] && grep -q "^intake: started feature batch E-9 on feat/E-9-third, beside the standing batch$" <<< "$out" && ! grep -q "E-9 not admitted" <<< "$out"'

# A start cut off before the hand-over (the supervisor's intake timeout) leaves its mark, by a pid
# that has exited: the next intake discards that batch and hands its epic on, rather than reading it
# as live forever.
mkdir -p "$EB/O-1" "$ES/O-1"; dead=$(sh -c 'echo $$')
printf '{"version":1,"batch":"O-1","epic":"O-1","base":"feat/O-1-cut","tickets":{}}\n' > "$EB/O-1/queue.json"
printf '{"pid":%s}\n' "$dead" > "$ES/O-1/epic-start.json"
out=$(intake)
check "DS-351: a feature batch whose start was cut off is discarded, and its epic handed on" '[ ! -e "$EB/O-1" ] && [ ! -e "$ES/O-1" ] && grep -q "^handed: an epic, and feature batch O-1.s start was cut off (pid $dead) before it was handed to the supervisor: discarded$" <<< "$(handed O-1)"'
check "DS-351: a finished start leaves no mark behind" '[ ! -e "$ES/E-5/epic-start.json" ]'

# ---- DS-354: the person's answer to the plan, acted on by the supervisor -------------------------
# Answered with the real answer.mjs, as /desk-needs-you records it; each tick runs every batch, with
# intake off. The editor is the fake claude, answering what $T/claude.out holds.
config yes '`none`'
answer(){ (cd "$T/repo" && env -u DESK_QUEUE -u DESK_AUTOPILOT_STATE node "$T/bin/answer.mjs" "$@" >/dev/null 2>&1); }
btick(){ (cd "$T/repo" && env -u DESK_QUEUE -u DESK_AUTOPILOT_STATE node "$T/bin/supervisor.mjs" tick --foreground 2>&1); }
pq(){ eget "$1" "tickets.$1.park.question"; }
editor(){ printf '{"type":"result","total_cost_usd":0.05,"result":"Done.\\nPLAN_EDIT: %s"}\n' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')" > "$T/claude.out"; }
SL="$HOME/.desk-autopilot/acme__widgets/supervisor.log"

editor '{"cannot": "AC9 is not one of the criteria"}'
answer E-5 "make E-7 own AC9"; out=$(btick)
check "DS-354 AC3: an edit the editor cannot apply asks again in needs-you, naming what it could not apply" '[ "$(eget E-5 tickets.E-5.state)" = parked ] && [ "$(pq E-5)" = "feature plan awaiting your answer: the plan for E-5 was not started, because your edit could not be applied: AC9 is not one of the criteria: read $ES/E-5/plan.md, then start, edit or discard it" ]'
check "DS-354 AC3: nothing is started, and the children stay held behind the epic" '[ "$(eget E-5 tickets.E-6.held_by)" = E-5 ] && ! grep -q "(seed)" "$T/plan.calls" && ! grep -q "^create" "$T/jira.calls"'
check "DS-354 AC2: the editor is given the plan and the edit, verbatim" 'grep -q -- "-p You are applying the person.s edit to the plan for epic E-5" "$T/claude.calls" && grep -q "^make E-7 own AC9$" "$ES/E-5/plan-edit.prompt.md" && grep -q "AC1 owner E-6" "$ES/E-5/plan-edit.prompt.md" && grep -q "\"AC1\": \"E-6\"" "$ES/E-5/plan-edit.prompt.md"'
n=$(count "$T/claude.calls"); out=$(btick)
check "DS-354: an answer already acted on is not acted on again" '[ "$(count "$T/claude.calls")" = "$n" ] && grep -q "your edit could not be applied: AC9" <<< "$(pq E-5)"'

# An edit the editor applies, but that leaves the owner table with a question, is not applied either.
editor '{"plan": {"draft": "Spine: AC1", "owners": {"AC1": "E-12"}}, "drop": []}'
answer E-5 "make E-12 own AC1"; out=$(btick)
check "DS-354 AC3: an edit that leaves the owner table unsettled asks again, naming plan-batch's question" 'grep -q "because your edit could not be applied cleanly: AC1.s owner E-12 is not a child this batch builds: name another owner: read " <<< "$(pq E-5)" && ! grep -q "(seed)" "$T/plan.calls"'
check "DS-354 AC3: the plan is left as it was" '[ "$(node -e "console.log(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).owners.AC1)" "$ES/E-5/feature.json")" = E-6 ]'

# A start on an owner table plan-batch questions asks again before its spine is filed; and while another
# live run holds the batch's supervisor.lock, the answer waits for it.
owner(){ node -e 'const fs=require("fs"),f=process.argv[1],p=JSON.parse(fs.readFileSync(f,"utf8")); p.owners.AC1=process.argv[2]; fs.writeFileSync(f, JSON.stringify(p))' "$ES/E-5/feature.json" "$1"; }
owner E-12; printf '{"pid":%s}\n' "$$" > "$ES/E-5/supervisor.lock"
q0=$(pq E-5); answer E-5 start; out=$(btick)
check "DS-354: an answer is not acted on while another run holds the batch's lock" '[ "$(pq E-5)" = "$q0" ]'
rm -f "$ES/E-5/supervisor.lock"; out=$(btick)
check "DS-354: a start the owner table cannot take asks again, and files no spine" 'grep -q "because plan-batch has questions on its owner table: AC1.s owner E-12 is not a child this batch builds" <<< "$(pq E-5)" && ! grep -q "^create" "$T/jira.calls" && [ "$(node -e "console.log(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).spine)" "$ES/E-5/feature.json")" = null ]'
owner E-6
q0=$(pq E-5); answer E-5 "not now"; out=$(btick)
check "DS-354: a not-now answer leaves the plan waiting" '[ "$(pq E-5)" = "$q0" ] && [ -e "$EB/E-5" ]'

# AC4: discarded on the answer, and the children released.
answer E-5 discard; out=$(btick)
check "DS-354 AC4: a rejected plan discards the feature batch and its branch" '[ ! -e "$EB/E-5" ] && [ ! -e "$ES/E-5" ] && [ -z "$(git -C "$T/repo" ls-remote --heads origin feat/E-5-a-feature)" ]'
check "DS-354 AC4: the standing log says the children are released" 'grep -q "^discarded on your answer to its plan; E-6, E-7, E-10 are released: no batch holds them" "$SL"'
out=$(admit E-10 --by ben); rc=$?
check "DS-354 AC4: a released child can be admitted again" '[ $rc -eq 0 ] && [ "$(qget tickets.E-10.state)" = triaged ]'

# AC2: an edit applied as it stands, and the batch starts with no second needs-you round.
rec E-11 A '"summary":"the spine"'; rec E-13 A '"summary":"the third child"'; rec E-14 A '"summary":"the fourth child"'
printf 'E-13\nE-14\n' > "$T/children/E-12"; rec E-12 A '"type":"Epic","branch":"feat/E-12-edited"'
cat > "$T/claude.out" <<'EOF'
{"type":"result","total_cost_usd":0.12,"result":"Drafted.\nPLAN_RESULT: {\"draft\": \"Spine: one strict expected-fail spec for AC1\", \"owners\": {\"AC1\": \"E-13\"}}"}
EOF
out=$(admit E-12 --by ben)
editor '{"plan": {"draft": "Spine: one strict expected-fail spec for AC1\nIt lands the AC1 spec.", "owners": {"AC1": "E-14"}}, "drop": []}'
answer E-12 "make E-14 own AC1, not E-13"; out=$(btick)
check "DS-354 AC2: the edit is applied to the plan" '[ "$(node -e "const f=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")); console.log(f.owners.AC1, f.spine)" "$ES/E-12/feature.json")" = "E-14 E-11" ] && grep -q "^Edited on your answer: make E-14 own AC1, not E-13$" "$ES/E-12/plan.md"'
check "DS-354 AC2: the spine is filed under the epic from the edited draft" 'grep -q "^create Story Spine: one strict expected-fail spec for AC1 $ES/E-12/spine.md parent=E-12$" "$T/jira.calls" && grep -q "^It lands the AC1 spec.$" "$ES/E-12/spine.md" && [ -f "$ES/E-12/triage/E-11.json" ]'
check "DS-354 AC2: the batch starts, seeded spine first, with no second needs-you round" 'grep -q "^E-12 --json E-11 E-13 E-14 (seed)$" "$T/plan.calls" && [ "$(eget E-12 tickets.E-12)" = undefined ] && [ "$(eget E-12 tickets.E-11.state)" = triaged ] && [ "$(eget E-12 tickets.E-11.park)" = null ] && [ "$(eget E-12 tickets.E-14.held_by)" = E-11 ]'
check "DS-354 AC2: the batch's log says what was done" 'grep -q "^your edit to E-12.s plan was applied$" "$ES/E-12/supervisor.log" && grep -q "^E-12.s feature batch started on feat/E-12-edited, with its spine E-11 first: 2 children seeded by plan-batch$" "$ES/E-12/supervisor.log"'

# AC1: approved as it stands. The edited batch above is cleared away, so a second epic can start.
rm -rf "$EB/E-12" "$ES/E-12"
rec E-16 A '"summary":"the only child"'; printf 'E-16\n' > "$T/children/E-15"; rec E-15 A '"type":"Epic","branch":"feat/E-15-approved"'
cat > "$T/claude.out" <<'EOF'
{"type":"result","total_cost_usd":0.12,"result":"Drafted.\nPLAN_RESULT: {\"draft\": \"Spine: the AC1 spec\", \"owners\": {\"AC1\": \"E-16\"}}"}
EOF
out=$(admit E-15 --by ben); n=$(count "$T/claude.calls")
answer E-15 start; out=$(btick)
check "DS-354 AC1: an approved plan starts the feature batch on its feature branch" '[ "$(eget E-15 base)" = feat/E-15-approved ] && [ "$(eget E-15 tickets.E-15)" = undefined ] && [ "$(eget E-15 tickets.E-11.state)" = triaged ] && [ "$(eget E-15 tickets.E-16.held_by)" = E-11 ] && grep -q "^E-15 --json E-11 E-16 (seed)$" "$T/plan.calls"'
check "DS-354 AC1: no editor runs on a plain start" '[ "$(count "$T/claude.calls")" = "$n" ] && grep -q "^E-15.s feature batch started on feat/E-15-approved, with its spine E-11 first: 1 child seeded by plan-batch$" "$ES/E-15/supervisor.log"'
filed=$(node --input-type=module -e "import { readEdit } from '$B/epic-plan.mjs'; const out = (plan) => JSON.stringify({ type: 'result', result: 'PLAN_EDIT: ' + JSON.stringify({ plan, drop: [] }) }); const plan = { spine: 'E-11', draft: 'Spine: AC1', owners: { AC1: 'E-6' } }; console.log(readEdit(out({ draft: 'Spine: AC1 and AC2', owners: { AC1: 'E-6' } }), { children: ['E-6'], plan }).cannot ?? 'applied'); console.log(readEdit(out({ draft: 'Spine: AC1', owners: { AC1: 'E-7' } }), { children: ['E-6', 'E-7'], plan }).plan?.owners.AC1)")
check "DS-354: an edit to a spine already filed cannot be applied, and one to its owner table can" '[ "$filed" = "$(printf "it changes the spine, which is already filed as E-11: edit E-11 in Jira, then answer start\nE-7")" ]'

# ---- DS-380: a ticket whose files are only on a running batch's base joins that batch -------------
# main and feat/k-1 both have src/both.js; only feat/k-1 has src/only-k.js. Batch K-1 runs on feat/k-1.
g(){ git -C "$T/repo" -c user.name=t -c user.email=t@t "$@"; }
g checkout -q main; mkdir -p "$T/repo/src"; echo x > "$T/repo/src/both.js"; g add src/both.js; g commit -q -m both; g push -q origin main
g checkout -q -b feat/k-1; echo y > "$T/repo/src/only-k.js"; g add src/only-k.js; g commit -q -m only-k; g push -q origin feat/k-1; g checkout -q main
mkdir -p "$EB/K-1"
printf '{"version":1,"batch":"K-1","base":"feat/k-1","supervised":true,"tickets":{"K-0":{"key":"K-0","state":"running"}}}\n' > "$EB/K-1/queue.json"
config yes; running_batch
rec K-2 A '"files_in_scope":["src/only-k.js","src/new.js"]'; rec K-3 A '"files_in_scope":["src/both.js","src/new.js"]'; rec K-4 A '"files_in_scope":["src/only-k.js"]'
search K-2; out=$(intake)
check "DS-380 AC3: intake queues a ticket naming a file only on a running batch's base in that batch" '[ "$(eget K-1 tickets.K-2.state)" = triaged ] && [ "$(qget tickets.K-2)" = undefined ] && grep -q "^intake: admitted K-2 by intake into batch K-1 (lane A, size S): K-2 names src/only-k.js, which is on batch K-1.s base feat/k-1 and not on main: it joins that batch$" <<< "$out"'
check "DS-380 AC3: it is triaged again in that batch, on its base" 'grep -qx "K-2 K-1 unpinned" "$T/triage.batch"'
search K-3; out=$(intake)
check "DS-380 AC4: a ticket whose files are on both bases is queued where it is today" '[ "$(qget tickets.K-3.state)" = triaged ] && [ "$(eget K-1 tickets.K-3)" = undefined ]'
out=$(admit K-4 --by ben); rc=$?
check "DS-380 AC3: /desk-admit routes it the same way" '[ $rc -eq 0 ] && [ "$(eget K-1 tickets.K-4.admitted_by)" = ben ] && [ "$(qget tickets.K-4)" = undefined ] && grep -q "^admitted K-4 by ben into feature batch K-1 " <<< "$out"'
# A batch a session runs (K-5 on feat/k-5, not handed over) gets its ticket once it is handed over.
g checkout -q -b feat/k-5; echo z > "$T/repo/src/only-k5.js"; g add src/only-k5.js; g commit -q -m only-k5; g push -q origin feat/k-5; g checkout -q main
mkdir -p "$EB/K-5"
printf '{"version":1,"batch":"K-5","base":"feat/k-5","tickets":{"K-0":{"key":"K-0","state":"running"}}}\n' > "$EB/K-5/queue.json"
rec K-6 A '"files_in_scope":["src/only-k5.js"]'
search K-6; out=$(intake)
check "DS-380 AC3: a ticket for a session-run batch waits for its handover, saying so" '[ "$(eget K-5 tickets.K-6)" = undefined ] && [ "$(qget tickets.K-6)" = undefined ] && grep -q "^intake: K-6 not admitted yet: K-6 names src/only-k5.js, which is on batch K-5.s base feat/k-5 and not on main: it joins that batch, once a session hands batch K-5 to the supervisor (queue.mjs set-batch supervised=true): /desk-admit K-6 adds it now$" <<< "$out"'
n=$(count "$T/triage.calls"); out=$(intake)
check "DS-380 AC3: it is not triaged again while that batch is still the session's" '[ "$(count "$T/triage.calls")" = "$n" ] && [ "$(eget K-5 tickets.K-6)" = undefined ]'
printf '{"version":1,"batch":"K-5","base":"feat/k-5","supervised":true,"tickets":{"K-0":{"key":"K-0","state":"running"}}}\n' > "$EB/K-5/queue.json"
out=$(intake)
check "DS-380 AC3: once handed over, the next intake queues it in that batch" '[ "$(eget K-5 tickets.K-6.state)" = triaged ] && [ "$(qget tickets.K-6)" = undefined ] && grep -q "^intake: admitted K-6 by intake into batch K-5 " <<< "$out"'
rm -rf "$EB/K-1" "$EB/K-5"

# ---- DS-383: an epic admitted from a checkout on another branch, with desk's pre-push hook ---------
# The real hook, with a Pre-push checks row that would fail if it ran.
mkdir -p "$T/desk"; ln -s "$B" "$T/desk/bin"
cp -R "$S/../desk/templates/.githooks" "$S/../desk/templates/scripts" "$T/repo/"; chmod +x "$T/repo/.githooks/pre-push"
printf '\n## 4. Tools\n| Field | Value |\n|---|---|\n| Pre-push checks | `false` |\n' >> "$T/cfg/repos/acme__widgets/config.md"
g config core.hooksPath .githooks; g checkout -q -b side-work; echo w > "$T/repo/src/side.js"; g add src/side.js; g commit -q -m side; g checkout -q -b elsewhere HEAD~1
out=$(g push origin side-work:refs/heads/x 2>&1); rc=$?
check "DS-383: the hook is live, and refuses a new commit that is not HEAD" '[ $rc -ne 0 ] && grep -q "^pre-push: .* not HEAD" <<< "$out"'
rec E-21 A '"summary":"the side child"'; printf 'E-21\n' > "$T/children/E-20"; rec E-20 A '"type":"Epic","branch":"feat/E-20-side"'
cat > "$T/claude.out" <<'EOF'
{"type":"result","total_cost_usd":0.12,"result":"Drafted.\nPLAN_RESULT: {\"draft\": \"Spine: the AC1 spec\", \"owners\": {\"AC1\": \"E-21\"}}"}
EOF
out=$(admit E-20 --by ben); rc=$?
check "DS-383 AC1: from a checkout on another branch, the feature branch is pushed at main's tip and the batch starts" '[ $rc -eq 0 ] && grep -q "^started feature batch E-20 on feat/E-20-side" <<< "$out" && [ "$(git -C "$T/repo" ls-remote --heads origin feat/E-20-side | cut -f1)" = "$(git -C "$T/repo" rev-parse origin/main)" ]'
mkdir -p "$T/refuse-hooks"; printf '#!/bin/sh\necho "pre-push: refused for the test" >&2\necho "pre-push: here is the fix" >&2\nexit 1\n' > "$T/refuse-hooks/pre-push"; chmod +x "$T/refuse-hooks/pre-push"
g config core.hooksPath "$T/refuse-hooks"; rec E-22 A '"type":"Epic","branch":"feat/E-22-refused"'
out=$(admit E-22 --by ben); rc=$?
check "DS-383 AC4: a refused push's reason carries the hook's pre-push lines and git's" '[ $rc -eq 11 ] && grep -q "^not admitted E-22: .*could not be read or pushed (pre-push: refused for the test pre-push: here is the fix error: failed to push some refs" <<< "$out"'
g config --unset core.hooksPath; g checkout -q main; rm -rf "$EB/E-20" "$T/desk/bin"

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
