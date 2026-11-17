#!/usr/bin/env bash
# suite: merge driver: merge holds and the person's steps (offline, fake gh)
# The real merge-driver.sh and gate.mjs, one loop at a time, set up by merge_driver_setup.sh: §4 Merge
# holds (code owners and hold routines too), a green PR held on the person's step or instruction, and
# a green feature merged with no GitHub approval.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=merge_driver_setup.sh
. "$S/merge_driver_setup.sh"

# ---- DS-377: a §4 Merge holds path holds a PR into the default branch, never one into a feature base --
sed -e 's/| Merge holds | `none` |/| Merge holds | `infra\/**: deploys the infrastructure on merge` |/' "$T/config.md" > "$T/config-holds.md"
SHA51=e111111111111111111111111111111111111111; SHA52=e222222222222222222222222222222222222222
cat > "$T/prs.json" <<EOF
{
  "151": { "head": "fix/T-51", "base": "feat/epics", "sha": "$SHA51", "state": "open", "draft": false, "files": ["infra/main.tf"], "checks": [["test", "SUCCESS"]] },
  "152": { "head": "fix/T-52", "base": "main", "sha": "$SHA52", "state": "open", "draft": false, "files": ["infra/main.tf", "src/a.ts"], "checks": [["test", "SUCCESS"]] }
}
EOF
hloop(){ out=$(DESK_CONFIG="$T/config-holds.md" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "$1" 2>&1); rc=$?; }
# set-batch asks origin for the base, and this repo has none, so the base is written as set-batch would.
q init merge-holds-feature; jq '.base = "feat/epics"' "$DESK_QUEUE" > "$T/q.tmp" && mv "$T/q.tmp" "$DESK_QUEUE"
q add T-51 Bug A; q set T-51 branch=fix/T-51 state=done result.pr=151
: > "$T/merges.log"
hloop T-51; hloop T-51
check "DS-377 AC1: a held path into a feature base merges, pinned to its head" '[ "$(merged)" = 151 ] && grep -qx "151 feat/epics $SHA51" "$T/merges.log"'
check "DS-377 AC1: the log says the hold falls on the base'\''s own PR, and nothing is left for the person" 'echo "$out" | grep -q "#151 touches §4 Merge holds (deploys the infrastructure on merge — infra/\*\*, 1 file(s), e.g. infra/main.tf), but its base feat/epics is not main, so merging it deploys nothing" && [ "$(qf T-51 .merge_blocked)" = null ]'
check "DS-377 the hold it merged past goes with the ticket, for the base'\''s own PR into main" '[ "$(qf T-51 .promotion_hold)" = "deploys the infrastructure on merge — infra/**, 1 file(s), e.g. infra/main.tf" ] && echo "$out" | grep -q "#151 §4 Merge holds recorded for feat/epics'\''s own PR"'
q init merge-holds-main
q add T-52 Bug A; q set T-52 branch=fix/T-52 state=done result.pr=152
hloop T-52; hloop T-52
check "DS-377 AC2: a held path into the default branch is still held for a person" '[ "$(merged)" = 151 ] && echo "$out" | grep -q "#152 HELD by §4 Merge holds — a person merges it"'
check "DS-377 AC2: the record leads with the hold'\''s reason from the row" '[ "$(qf T-52 .merge_blocked)" = "merge hold: deploys the infrastructure on merge — infra/**, 1 file(s), e.g. infra/main.tf" ]'
# DS-657: a PR under two holds with no routine: the record quotes the first and counts the other, so
# needs-you never reads the first one's step as the last.
sed -e 's/| Merge holds | `none` |/| Merge holds | `infra\/**: deploys the infrastructure on merge` `src\/**: Ben signs off in docs\/signoff.md` |/' "$T/config.md" > "$T/config-holds2.md"
q init merge-holds-two
q add T-53 Bug A; q set T-53 branch=fix/T-52 state=done result.pr=152
out=$(DESK_CONFIG="$T/config-holds2.md" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets T-53 2>&1)
out=$(DESK_CONFIG="$T/config-holds2.md" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets T-53 2>&1)
check "DS-657 a PR under two holds with no routine: the record quotes the first and counts the other" '[ "$(qf T-53 .merge_blocked)" = "merge hold: deploys the infrastructure on merge — infra/**, 1 file(s), e.g. infra/main.tf (and 1 more merge hold(s))" ]'

# ---- a code-owner hold whose every owner is the merging account holds nothing --------------------
sed -e 's/| Merge holds | `none` |/| Merge holds | `frontend\/**: CODEOWNERS path, needs your code-owner approval` |/' "$T/config.md" > "$T/config-co.md"
mkdir -p "$T/contents/.github"; printf '* @Tester\nfrontend/b/ @tester @alice\n' > "$T/contents/.github/CODEOWNERS"
SHA71=a711111111111111111111111111111111111111; SHA72=a722222222222222222222222222222222222222
cat > "$T/prs.json" <<EOF
{
  "171": { "head": "fix/T-71", "base": "main", "sha": "$SHA71", "state": "open", "draft": false, "files": ["frontend/a.ts", "frontend/c/d.ts"], "checks": [["test", "SUCCESS"]] },
  "172": { "head": "fix/T-72", "base": "main", "sha": "$SHA72", "state": "open", "draft": false, "files": ["frontend/b/x.ts"], "checks": [["test", "SUCCESS"]] }
}
EOF
coloop(){ out=$(DESK_CONFIG="$T/config-co.md" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "$1" 2>&1); rc=$?; }
q init merge-holds-codeowners
q add T-72 Bug A; q set T-72 branch=fix/T-72 state=done result.pr=172
: > "$T/merges.log"
coloop T-72; coloop T-72
check "DS-413 AC2: a code-owner hold another person owns stays held" '[ -z "$(merged)" ] && echo "$out" | grep -q "#172 HELD by §4 Merge holds — a person merges it"'
check "DS-413 AC2: the record names that owner'\''s approval" '[ "$(qf T-72 .merge_blocked)" = "merge hold: CODEOWNERS path, needs your code-owner approval (code-owner approval from @alice) — frontend/**, 1 file(s), e.g. frontend/b/x.ts" ]'
q add T-71 Bug A; q set T-71 branch=fix/T-71 state=done result.pr=171 "merge_blocked=merge hold: CODEOWNERS path, needs your code-owner approval — frontend/**, 2 file(s), e.g. frontend/a.ts"
coloop T-71
check "DS-413 AC1: a code-owner hold the merging account alone owns is met, and says so" 'echo "$out" | grep -q "#171 §4 Merge holds met with no person: CODEOWNERS path, needs your code-owner approval (every code owner is @tester, the merging account) — frontend/\*\*" && ! echo "$out" | grep -q "#171 HELD"'
check "DS-413 AC1: its old merge-hold record is cleared, so needs-you lists nothing" '[ "$(qf T-71 .merge_blocked)" = null ]'
coloop T-71
check "DS-413 AC1: it merges pinned to its head" '[ "$(merged)" = 171 ] && grep -qx "171 main $SHA71" "$T/merges.log"'
check "DS-413 AC1: CODEOWNERS is read from the PR'\''s base" 'grep -q "contents/.github/CODEOWNERS?ref=main" "$T/gh.log"'
SHA73=a733333333333333333333333333333333333333
cat > "$T/prs.json" <<EOF
{ "173": { "head": "fix/T-73", "base": "feat/epics", "sha": "$SHA73", "state": "open", "draft": false, "files": ["frontend/a.ts"], "checks": [["test", "SUCCESS"]] } }
EOF
q init merge-holds-codeowners-feature; jq '.base = "feat/epics"' "$DESK_QUEUE" > "$T/q.tmp" && mv "$T/q.tmp" "$DESK_QUEUE"
q add T-73 Bug A; q set T-73 branch=fix/T-73 state=done result.pr=173
: > "$T/gh.log"
coloop T-73; coloop T-73
check "DS-413 a code-owner hold into a batch base is carried whole for the base'\''s own PR, never met against the batch base" '[ "$(qf T-73 .promotion_hold)" = "CODEOWNERS path, needs your code-owner approval — frontend/**, 1 file(s), e.g. frontend/a.ts" ] && ! grep -q "contents/.github/CODEOWNERS" "$T/gh.log"'

# ---- DS-411: a hold that names its routine is run by the driver, then merged pinned to the head --
# The PR heads are real commits, so the routine's checkout is of the head itself.
git -C "$T/repo" checkout -q -b fix/T-91; echo up > "$T/repo/up.sql"; git -C "$T/repo" add up.sql; git -C "$T/repo" commit -q -m T-91
SHA91=$(git -C "$T/repo" rev-parse HEAD)
git -C "$T/repo" checkout -q main; git -C "$T/repo" checkout -q -b fix/T-92; git -C "$T/repo" commit -q --allow-empty -m T-92
SHA92=$(git -C "$T/repo" rev-parse HEAD); git -C "$T/repo" checkout -q main
cat > "$T/routine.sh" <<EOF
#!/usr/bin/env bash
echo "snapshot taken"
echo "\$DESK_PR \$DESK_HEAD_SHA \$(git rev-parse HEAD) \$([ -f up.sql ] && echo has-file)" >> "$T/routine.ran"
echo "applying to staging"
[ "\$DESK_PR" = 192 ] && { echo "staging refused the migration" >&2; exit 3; }
echo "applied to production"
EOF
sed -e "s#| Merge holds | \`none\` |#| Merge holds | \`db/**: apply the migration to staging and production first; desk runs: bash $T/routine.sh\` \`infra/**: deploys the infrastructure on merge\` |#" "$T/config.md" > "$T/config-routine-off.md"
sed -e '/^| `pr-ready` |/a\
| `merge-hold-routine` | Run hold routines | `no` | `yes` |
' "$T/config-routine-off.md" > "$T/config-routine.md"
cat > "$T/prs.json" <<EOF
{ "191": { "head": "fix/T-91", "base": "main", "sha": "$SHA91", "state": "open", "draft": false, "files": ["db/up.sql"], "checks": [["test", "SUCCESS"]] },
  "192": { "head": "fix/T-92", "base": "main", "sha": "$SHA92", "state": "open", "draft": false, "files": ["db/down.sql"], "checks": [["test", "SUCCESS"]] },
  "193": { "head": "fix/T-93", "base": "main", "sha": "$SHA92", "state": "open", "draft": false, "files": ["db/up.sql", "infra/main.tf"], "checks": [["test", "SUCCESS"]] } }
EOF
rloop(){ out=$(DESK_CONFIG="$T/$1" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "$2" 2>&1); rc=$?; }
q init merge-hold-routine
for k in T-91 T-92 T-93; do q add "$k" Bug A; q set "$k" "branch=fix/$k" state=done "result.pr=1${k#T-}"; done
: > "$T/merges.log"; rm -f "$T/routine.ran"
rloop config-routine-off.md T-91; rloop config-routine-off.md T-91
check "DS-411 AC3: with §3 merge-hold-routine unset, the routine is not run and the PR is not merged" '[ -z "$(merged)" ] && [ ! -f "$T/routine.ran" ] && echo "$out" | grep -q "#191 HELD by §4 Merge holds — its routine is not run, §3 merge-hold-routine is no"'
check "DS-411 AC3: the record names the hold'\''s step and its routine" '[ "$(qf T-91 .merge_blocked)" = "merge hold: apply the migration to staging and production first — db/**, 1 file(s), e.g. db/up.sql; routine \`bash $T/routine.sh\` not run: §3 merge-hold-routine is no" ]'
rloop config-routine.md T-91
check "DS-411 AC1: green and held a first loop, the routine waits for the head to be confirmed" '[ -z "$(merged)" ] && [ ! -f "$T/routine.ran" ] && [ "$(qf T-91 .merge_blocked)" = null ] && echo "$out" | grep -q "#191 green at .* — confirming on the next loop"'
rloop config-routine.md T-91
check "DS-411 AC1: the routine runs once, in a checkout of the head, with the PR and head set" '[ "$(cat "$T/routine.ran")" = "191 $SHA91 $SHA91 has-file" ]'
check "DS-411 AC1: then the PR merges, pinned to that head, with nothing left for the person" '[ "$(merged)" = 191 ] && grep -qx "191 main $SHA91" "$T/merges.log" && [ "$(qf T-91 .merge_blocked)" = null ]'
check "DS-411 AC1: the routine'\''s checkout is removed" '[ ! -d "$T/state/merge-driver/routine-191-checkout" ] && ! git -C "$T/repo" worktree list | grep -q routine-191'
rloop config-routine.md T-92; o1=$out; rloop config-routine.md T-92; out="$o1
$out"
check "DS-411 AC2: a routine that exits non-zero leaves the PR unmerged" '[ "$(merged)" = 191 ] && echo "$out" | grep -q "#192 its §4 Merge holds routine FAILED at ${SHA92:0:9} (exit 3)"'
check "DS-411 AC2: the record names the routine and the step it failed at" '[ "$(qf T-92 .merge_blocked)" = "merge hold: apply the migration to staging and production first — db/**, 1 file(s), e.g. db/down.sql; routine \`bash $T/routine.sh\` failed at ${SHA92:0:9} (exit 3): staging refused the migration" ]'
rloop config-routine.md T-92
check "DS-411 AC2: a routine that failed is not run again at the same head" '[ "$(grep -c "^192 " "$T/routine.ran")" = 1 ] && [ "$(merged)" = 191 ] && qf T-92 .merge_blocked | grep -q "failed at ${SHA92:0:9} (exit 3)"'
rloop config-routine.md T-93; rloop config-routine.md T-93
check "DS-411: a PR that also touches a hold with no routine is the person'\''s, and no routine runs" '! grep -q "^193 " "$T/routine.ran" && [ "$(merged)" = 191 ] && echo "$out" | grep -q "#193 HELD by §4 Merge holds — a person merges it, after its step: apply the migration"'
check "DS-411 AC3: its record still leads with the routine hold'\''s step, and names the hold with no routine" '[ "$(qf T-93 .merge_blocked)" = "merge hold: apply the migration to staging and production first — db/**, 1 file(s), e.g. db/up.sql; routine \`bash $T/routine.sh\` not run: it also touches a hold no routine clears: deploys the infrastructure on merge — infra/**, 1 file(s), e.g. infra/main.tf" ]'

# ---- DS-407: the person's step in no batch holds a green PR's merge, and lifting it lets it merge --
SHA61=f111111111111111111111111111111111111111
cat > "$T/prs.json" <<EOF
{ "161": { "head": "fix/T-61", "base": "main", "sha": "$SHA61", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] } }
EOF
q init merge-after-step
q add T-61 Story A; q set T-61 branch=fix/T-61 state=done result.pr=161 merge_after=KAN-729
: > "$T/merges.log"
sloop(){ out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets T-61 2>&1); rc=$?; }
sloop; sloop
check "DS-407 AC2: a clean, green PR whose ticket waits on the person's step is not merged" '[ -z "$(merged)" ] && echo "$out" | grep -q "#161 green at f11111111, HELD until the person.s step KAN-729 is Done in Jira"'
check "DS-407 AC2: and it is not left for a person to merge by hand"     '[ "$(qf T-61 .merge_blocked)" = null ]'
q set T-61 merge_after=null
sloop; sloop
check "DS-407 AC3: once the step is lifted, it merges with no other answer, pinned to its head" '[ "$(merged)" = 161 ] && grep -qx "161 main $SHA61" "$T/merges.log"'

# ---- The person's instruction on a ready PR holds its merge until a worker has carried it out --------
SHA62=a611111111111111111111111111111111111111; SHA63=a622222222222222222222222222222222222222
SHA64=a633333333333333333333333333333333333333; SHA65=a644444444444444444444444444444444444444
green_pr(){ # green_pr <n> <sha>: the one PR, ready and green, on fix/T-<n - 100>
  printf '{ "%s": { "head": "fix/T-%s", "base": "main", "sha": "%s", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] } }\n' "$1" "$(($1 - 100))" "$2" > "$T/prs.json"
}
instruction(){ printf '{"try":1,"of":1,"kind":"instruction","pr":%s,"head":null,"ready":true,"what":"your instruction","answer":"rename it"}' "$1"; }
iloop(){ out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "$1" 2>&1); rc=$?; }
green_pr 162 $SHA62
q init merge-instruction
q add T-62 Story A; q set T-62 branch=fix/T-62 state=queued result.pr=162 "fix=$(instruction 162)"
: > "$T/merges.log"
iloop T-62; iloop T-62
check "a green PR is not merged while the person's instruction waits for a worker" '[ -z "$(merged)" ] && echo "$out" | grep -q "#162 HELD: a worker has still to carry out the person.s instruction"'
check "and it is held before the green confirmation, so that starts again once the hold lifts" '! echo "$out" | grep -q "#162 green" && [ ! -f "$T/state/merge-driver/green-162" ]'
q set T-62 state=parked
iloop T-62; iloop T-62
check "a worker that parked on it has not carried it out, so the PR is still held" '[ -z "$(merged)" ] && echo "$out" | grep -q "#162 HELD: a worker"'
q set T-62 state=done fix.finished=2026-11-07T00:00:00Z
iloop T-62; iloop T-62
check "once its fix is finished, it merges pinned to its head" '[ "$(merged)" = 162 ] && grep -qx "162 main $SHA62" "$T/merges.log"'

green_pr 163 $SHA63
q init merge-instruction-other-fix
q add T-63 Story A; q set T-63 branch=fix/T-63 state=done result.pr=163 'fix={"try":1,"of":3,"kind":"conflict","pr":163,"what":"a conflict"}'
: > "$T/merges.log"
iloop T-63; iloop T-63
check "another kind of unfinished fix is not held by this" '[ "$(merged)" = 163 ] && ! echo "$out" | grep -q "HELD: a worker"'

green_pr 166 $SHA62
q init merge-renames-held
q add T-66 Story A; q set T-66 branch=fix/T-66 state=queued result.pr=166 'fix={"try":0,"of":2,"extra":true,"kind":"renames","pr":166,"what":"names a renamed migration"}'
: > "$T/merges.log"
iloop T-66; iloop T-66
check "a green PR is not merged while its migration rename worker runs" '[ -z "$(merged)" ] && echo "$out" | grep -q "#166 HELD: a worker has still to update the migrations"'
q set T-66 state=done fix.finished=2026-11-07T00:00:00Z
iloop T-66; iloop T-66
check "once the rename try is finished, it merges" '[ "$(merged)" = 166 ]'

green_pr 164 $SHA64
q init merge-instruction-race
q add T-64 Story A; q set T-64 branch=fix/T-64 state=done result.pr=164
: > "$T/merges.log"
iloop T-64
printf '%s' "node '$B/queue.mjs' set T-64 'fix=$(instruction 164)'" > "$T/gh.midloop"
iloop T-64
check "an instruction recorded after the PR's gate read still stops the merge" '[ -z "$(merged)" ] && [ ! -e "$T/gh.midloop" ] && echo "$out" | grep -q "#164 HELD: a worker" && ! echo "$out" | grep -q "#164 gate GREEN"'

green_pr 165 $SHA65
q init merge-instruction-unreadable
q add T-65 Story A; q set T-65 branch=fix/T-65 state=done result.pr=165
: > "$T/merges.log"
printf '%s' "printf '{' > '$DESK_QUEUE'" > "$T/gh.atlist"
iloop T-65
check "a queue that cannot be read holds the merge" '[ -z "$(merged)" ] && echo "$out" | grep -q "#165 could not read the queue for the person.s instruction"'

# ---- DS-419 / DS-433: a green feature merges with no GitHub approval; review feedback goes to a worker --
SHA71=a711111111111111111111111111111111111111; SHA72=a722222222222222222222222222222222222222
cat > "$T/prs.json" <<EOF
{ "171": { "head": "feat/T-71", "base": "main", "sha": "$SHA71", "state": "open", "draft": false, "title": "feat(rail): T-71 live classes", "checks": [["test", "SUCCESS"]] },
  "172": { "head": "feat/T-72", "base": "main", "sha": "$SHA72", "state": "open", "draft": false, "title": "feat: T-72 sign-in", "feedback": "NONE 1", "checks": [["test", "SUCCESS"]] } }
EOF
q init merge-approval
q add T-71 Story A; q set T-71 branch=feat/T-71 state=done result.pr=171
q add T-72 Story A; q set T-72 branch=feat/T-72 state=done result.pr=172 "merge_blocked=approval: stale"
: > "$T/merges.log"
aloop(){ out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-71 T-72" 2>&1); rc=$?; }
aloop
check "DS-419 AC10: a feat PR with an unresolved thread is held for the feedback, and its approval request is cleared" 'echo "$out" | grep -q "#172 has outstanding review feedback (NONE, 1 unresolved)" && ! echo "$out" | grep -q "#172 .*a feature with no approval" && [ "$(qf T-72 .merge_blocked)" = null ]'
# Loop 2 holds the confirm window open, so #171 (confirming, not held) is still open while #172 is read.
out=$(MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=3600 bash "$B/merge-driver.sh" --tickets "T-71 T-72" 2>&1); rc=$?
check "DS-433: a green feat PR with no thread open and no GitHub approval is not held for one" '! echo "$out" | grep -q "a feature with no approval" && echo "$out" | grep -q "#171 green at a71111111 — confirming" && [ "$(qf T-71 .merge_blocked)" = null ]'
check "DS-419 AC10: held a second loop, its feedback is recorded for the fix worker, with no approval asked" '! echo "$out" | grep -q "#172 .*a feature with no approval" && qf T-72 .merge_blocked | grep -q "^review feedback: 1 unresolved thread on a green PR, first "'
aloop
check "DS-433: confirmed green on the next loop, it merges, pinned to its head, with no approval asked" '[ "$(merged)" = 171 ] && grep -qx "171 main $SHA71" "$T/merges.log" && [ "$(qf T-71 .merge_blocked)" = null ]'

finish holds
