#!/usr/bin/env bash
# suite: base sync (a batch base's worktree, synced from the default branch before a pass spawns)
# pass.mjs with a batch base: every pass makes the base its own worktree, and a pass that will spawn
# first merges main into the base and pushes it. A conflict, a refused push or the §3 batch-base-push
# row pushes nothing and is reported; in feature mode it also holds the spawns. A non-fast-forward
# push is fetched, merged and retried once. A primary checkout on the base gets no worktree and no
# sync. Each case has its own throwaway origin; the real pass.mjs runs with stub claude, gh,
# setup-worktree and spawn-worker. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/desk/bin" "$T/stub"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
git config --global init.defaultBranch main
# An autopilot worker inherits spawn-worker's exports, which would point this suite at the real repo.
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  CLAUDE_CODE_SESSION_ID AUTOPILOT_DRY_RUN AUTOPILOT_RERUN AUTOPILOT_PORT_FLOOR AUTOPILOT_BATCH_BUDGET_USD \
  AUTOPILOT_USER_APPROVED AUTOPILOT_BASE_PUSH_APPROVED
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

for f in queue.mjs harvest.mjs desk-env.mjs batch-state.mjs briefing.mjs; do ln -s "$B/$f" "$T/desk/bin/$f"; done
cat > "$T/desk/bin/setup-worktree.sh" <<'EOF'
mkdir -p "$DESK_WORKTREES_DIR/$2"; echo "[setup-worktree] worktree=$DESK_WORKTREES_DIR/$2"; echo "[setup-worktree] branch=$3"
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<'EOF'
if [ "$3" = preflight ]; then echo "[preflight] pass"; else echo "[spawn] ticket=$1"; fi
EOF
printf '#!/bin/sh\necho "[]"\n' > "$T/stub/claude"
printf '#!/bin/sh\nexit 0\n' > "$T/stub/gh"
# git, but the first push to feat/x first moves origin's feat/x on (what the merge driver does when it
# merges a PR into the base between the sync's fetch and its push). Armed by $T/race.arm, which holds the clone to push from.
REAL_GIT=$(command -v git)
cat > "$T/stub/git" <<EOF
#!/bin/sh
case " \$* " in *" push "*"refs/heads/feat/x"*)
  if [ -f "$T/race.arm" ]; then d=\$(cat "$T/race.arm"); rm -f "$T/race.arm"
    "$REAL_GIT" -C "\$d" commit -q --allow-empty -m "merged by the driver" && "$REAL_GIT" -C "\$d" push -q origin HEAD:feat/x; fi ;;
esac
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$T/stub/claude" "$T/stub/gh" "$T/stub/git"
export PATH="$T/stub:$PATH" DESK_HOME="$T/desk" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off AUTOPILOT_ORCHESTRATOR=test

# fresh <case> [batch-base-push value] [base]: an origin holding main and feat/x, with main two commits
# ahead, a primary checkout on main, and a queue with one triaged ticket. No base when <base> is -.
fresh(){
  C="$T/$1"; mkdir -p "$C/state" "$C/wt"
  git init -q --bare "$C/origin.git"
  git init -q "$C/repo"; git -C "$C/repo" remote add origin "$C/origin.git"
  echo base > "$C/repo/a.txt"; git -C "$C/repo" add a.txt; git -C "$C/repo" commit -q -m init
  git -C "$C/repo" push -q origin main main:feat/x
  git -C "$C/repo" commit -q --allow-empty -m one; git -C "$C/repo" commit -q --allow-empty -m two
  git -C "$C/repo" push -q origin main
  local perm=${2:-yes}
  cat > "$C/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$C/repo\` |
| Worktrees directory | \`$C/wt\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`yes\` |
| \`batch-base-push\` | Push to a batch base | \`ask\` | \`$perm\` |
EOF
  [ "$perm" = unset ] && grep -v batch-base-push "$C/config.md" > "$C/c" && command cat "$C/c" > "$C/config.md"
  export DESK_CONFIG="$C/config.md" DESK_AUTOPILOT_STATE="$C/state" DESK_QUEUE="$C/queue.json" DESK_WORKTREES_DIR="$C/wt"
  cd "$C/repo" || exit 1
  node "$B/queue.mjs" init t >/dev/null
  [ "${3:-feat/x}" = - ] || node "$B/queue.mjs" set-batch "base=${3:-feat/x}" >/dev/null
  node "$B/queue.mjs" add T-1 >/dev/null; node "$B/queue.mjs" set T-1 state=triaged branch=feat/T-1 >/dev/null
}
# feature: plan-batch seeded the batch in feature mode (the queue's epic has a filed spine).
feature(){ node "$B/queue.mjs" set-batch epic=E-1 feature=true >/dev/null; echo '{"epic":"E-1","spine":"T-0"}' > "$C/state/feature.json"; }
# conflict: main and feat/x both change a.txt.
conflict(){
  git -C "$C/repo" fetch -q origin; git -C "$C/repo" switch -q -c side origin/feat/x
  echo theirs > a.txt; git -C "$C/repo" commit -q -am base-side; git -C "$C/repo" push -q origin HEAD:feat/x
  git -C "$C/repo" switch -q main; echo ours > a.txt; git -C "$C/repo" commit -q -am main-side; git -C "$C/repo" push -q origin main
  git -C "$C/repo" branch -q -D side
}
pass(){ out=$(node "$B/pass.mjs" 2>&1); rc=$?; }
origin_has_main(){ git -C "$C/origin.git" merge-base --is-ancestor main feat/x; }
origin_tip(){ git -C "$C/origin.git" rev-parse feat/x; }
BWT='$C/wt/base-feat-x'

# AC9: no base, no base worktree, no sync.
fresh nobase yes -; pass
check "no base: a pass spawns as before"              '[[ "$out" == *"spawned: T-1"* ]]'
check "no base: no base worktree is made"            '[ -z "$(ls "$C/wt" | grep base-)" ]'
check "no base: no sync is attempted"                '[[ "$out" != *"base sync"* ]]'

# AC1, AC3: the first pass makes the base worktree; a pass that spawns nothing does not sync.
fresh idle; node "$B/queue.mjs" set T-1 state=done >/dev/null; tip=$(origin_tip); pass
check "the first pass makes the base worktree"       "[ \"\$(git -C $BWT symbolic-ref --short HEAD)\" = feat/x ]"
check "it is a worktree of the primary checkout"     'git -C "$C/repo" worktree list | grep -q "base-feat-x .*\[feat/x\]"'
check "the report says it was made"                  '[[ "$out" == *"base worktree for feat/x made at $C/wt/base-feat-x"* ]]'
check "a pass that spawns nothing does not sync"     '[ "$(origin_tip)" = "$tip" ] && [[ "$out" != *"base sync"* ]]'
pass
check "a second pass keeps the worktree, quietly"    '[[ "$out" != *"base worktree"* ]] && [ -d "$C/wt/base-feat-x" ]'

# AC2: a base behind main that merges cleanly is merged, pushed and counted before the spawn.
fresh clean; pass
check "a clean sync merges main into the base"       'origin_has_main'
check "it is a merge commit, not a rebase"           '[ "$(git -C "$C/origin.git" rev-list --parents -n 1 feat/x | wc -w | tr -d " ")" = 3 ]'
check "the report counts the commits"                '[[ "$out" == *"merged 2 commit(s) from main into feat/x and pushed"* ]]'
check "and the pass still spawns"                    '[[ "$out" == *"spawned: T-1"* ]]'
node "$B/queue.mjs" add T-2 >/dev/null; node "$B/queue.mjs" set T-2 state=triaged >/dev/null; pass
check "a base already current says so"               '[[ "$out" == *"feat/x already has everything on main"* ]]'

# AC4, AC7: a conflict pushes nothing and lists its files; an ordinary batch still spawns.
fresh conflict; conflict; tip=$(origin_tip); pass
check "a conflict pushes nothing"                    '[ "$(origin_tip)" = "$tip" ]'
check "it lists the files under WAITING ON YOU"      '[[ "${out#*WAITING ON YOU}" == *"Conflicting files: a.txt"* ]]'
check "it leaves the base worktree clean"            "[ -z \"\$(git -C $BWT status --porcelain)\" ] && [ \"\$(git -C $BWT rev-parse HEAD)\" = \"$tip\" ]"
check "not feature mode: spawning carries on"        '[[ "$out" == *"spawned: T-1"* ]] && [[ "$out" == *"spawning carries on"* ]]'
check "a conflict needs the person"                  '[ $rc -eq 11 ]'

# AC6: in feature mode a conflict spawns nothing.
fresh fconflict; feature; conflict; pass
check "feature mode: a conflict spawns nothing"      '[[ "$out" != *"spawned:"* ]] && [[ "$out" == *"feature mode, so nothing spawns this pass"* ]]'

# An ordinary batch plan-batch seeded while feature.json still names the epic and a spine (here §4
# Acceptance specs is unset, so feature mode is off): a failed sync holds no spawns.
fresh planned; conflict; node "$B/queue.mjs" set-batch epic=E-1 >/dev/null; node "$B/queue.mjs" drop T-1 >/dev/null
echo '{"epic":"E-1","spine":"T-1"}' > "$C/state/feature.json"; mkdir -p "$C/state/triage"
echo '{"ticket":"T-1","type":"Task","lane":"A","branch":"feat/T-1","files_in_scope":["b.txt"],"unknowns":[],"links":"n/a"}' > "$C/state/triage/T-1.json"
printf '\n## 1. Identity\n| Field | Value |\n|---|---|\n| GitHub handle | `me` |\n| Jira display name | `Me` |\n' >> "$C/config.md"
out=$(AUTOPILOT_WRITE_QUEUE=1 node "$B/plan-batch.mjs" T-1 2>&1)
check "plan-batch records an ordinary batch on the queue" '[ "$(jq -r .feature "$DESK_QUEUE")" = false ] && [ "$(jq -r ".tickets[\"T-1\"].state" "$DESK_QUEUE")" = triaged ]'
pass
check "feature.json naming a spine does not hold its spawns" '[[ "$out" == *"spawned: T-1"* ]] && [[ "$out" == *"spawning carries on"* ]]'

# AC6, AC7: a push refused by branch protection rolls back, and holds spawns only in feature mode.
fresh refused; printf '#!/bin/sh\necho "error: GH006: Protected branch update failed for refs/heads/feat/x." >&2\nexit 1\n' > "$C/origin.git/hooks/pre-receive"
chmod +x "$C/origin.git/hooks/pre-receive"; tip=$(origin_tip); pass
check "a refused push leaves origin alone"           '[ "$(origin_tip)" = "$tip" ]'
check "and names the reason"                         '[[ "$out" == *"the push to feat/x was refused"* ]] && [[ "$out" == *"GH006"* ]]'
check "and rolls the merge back locally"             "[ \"\$(git -C $BWT rev-parse HEAD)\" = \"$tip\" ]"
check "not feature mode: a refused push still spawns" '[[ "$out" == *"spawned: T-1"* ]]'
node "$B/queue.mjs" set T-1 state=triaged >/dev/null; feature; pass
check "feature mode: a refused push spawns nothing"  '[[ "$out" != *"spawned:"* ]] && [[ "$out" == *"refused"* ]]'

# AC6, AC7: the permission row.
fresh denied no; feature; tip=$(origin_tip); pass
check "batch-base-push no: nothing pushed"           '[ "$(origin_tip)" = "$tip" ] && [[ "$out" == *"config §3 batch-base-push is \"no\""* ]]'
check "feature mode: the row refusing spawns nothing" '[[ "$out" != *"spawned:"* ]]'
fresh askit unset; tip=$(origin_tip); pass
check "unset reads as ask, and asks for the approval" '[ "$(origin_tip)" = "$tip" ] && [[ "$out" == *"is \"ask\""* ]] && [[ "$out" == *"AUTOPILOT_BASE_PUSH_APPROVED=1"* ]]'
check "not feature mode: the row refusing still spawns" '[[ "$out" == *"spawned: T-1"* ]]'
fresh approved ask; out=$(AUTOPILOT_BASE_PUSH_APPROVED=1 node "$B/pass.mjs" 2>&1)
check "ask with the approval syncs"                  'origin_has_main && [[ "$out" == *"merged 2 commit(s)"* ]]'
fresh typo nope; tip=$(origin_tip); out=$(AUTOPILOT_BASE_PUSH_APPROVED=1 node "$B/pass.mjs" 2>&1)
check "a value the row cannot read is no, not ask"   '[ "$(origin_tip)" = "$tip" ] && [[ "$out" == *"batch-base-push is \"no\""* ]]'

# A production base written into the queue by hand is refused on read, before anything is pushed.
fresh prod; git -C "$C/repo" push -q origin origin/feat/x:refs/heads/production
tip=$(git -C "$C/origin.git" rev-parse production)
node -e 'const f = process.argv[1]; const q = JSON.parse(require("fs").readFileSync(f, "utf8")); q.base = "production"; require("fs").writeFileSync(f, JSON.stringify(q))' "$DESK_QUEUE"
pass
check "a production base in the queue is refused"    '[ $rc -eq 11 ] && [[ "$out" == *"is a production branch"* ]] && [ "$(git -C "$C/origin.git" rev-parse production)" = "$tip" ] && [ ! -e "$C/wt/base-production" ]'

# AC5: a push refused as non-fast-forward is fetched, merged again and retried once.
fresh race; git clone -q "$C/origin.git" "$C/other"; git -C "$C/other" switch -q feat/x; echo "$C/other" > "$T/race.arm"; pass
check "a non-fast-forward push is retried and lands" 'origin_has_main && git -C "$C/origin.git" log --format=%s feat/x | grep -qx "merged by the driver"'
check "the report says it retried"                   '[[ "$out" == *"fetched, merged again, retried once"* ]] && [[ "$out" == *"spawned: T-1"* ]]'

# AC8: a primary checkout on the base gets no worktree and no sync.
fresh primary; git -C "$C/repo" switch -q feat/x; tip=$(origin_tip); pass
check "primary on the base: no base worktree"        '[ ! -e "$C/wt/base-feat-x" ]'
check "and no sync"                                   '[ "$(origin_tip)" = "$tip" ]'
check "and the report says to switch it off"         '[[ "$out" == *"switch the primary checkout off feat/x"* ]]'
node "$B/queue.mjs" set T-1 state=done >/dev/null; pass
check "it is reported even on a pass that spawns nothing" '[[ "$out" == *"switch the primary checkout off feat/x"* ]]'

# Baseline checks: tc.sh stands in for §4 Typecheck, printing errors.txt as tsc would and failing when it
# holds any error. baseline <case> [on|off] [base]: fresh, with that row and the toolchain rows set.
baseline(){
  fresh "$1" yes "${3:-feat/x}"
  printf '## 4. Tools\n| Field | Value |\n|---|---|\n| Install | `none` |\n| Typecheck | `sh tc.sh` |\n| Lint | `none` |\n| Baseline checks | `%s` |\n' "${2:-on}" >> "$C/config.md"
  git clone -q "$C/origin.git" "$C/seed"; git -C "$C/seed" switch -q feat/x
  printf 'cat errors.txt\n! grep -q error errors.txt\n' > "$C/seed/tc.sh"
  printf "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error.\n" > "$C/seed/errors.txt"
  git -C "$C/seed" add tc.sh errors.txt; git -C "$C/seed" commit -q -m "a base with an error"; git -C "$C/seed" push -q origin feat/x
}
mkdir -p "$T/lock"; export DESK_LOCK_DIR="$T/lock"; ln -s "$B/with-lock.sh" "$T/desk/bin/with-lock.sh"
DESK_ENV="node $B/desk-env.mjs"

# AC1: the first pass that spawns records the base's errors, gives the count, and briefs the worker.
baseline record; pass
check "AC1 the base's errors are recorded"            '[ "$(jq -r ".checks.typecheck[0].count" "$C/state/baseline.json")" = 1 ] && [ "$(jq -r .base "$C/state/baseline.json")" = feat/x ]'
check "AC1 at the synced base's head"                 "[ \"\$(jq -r .sha \"\$C/state/baseline.json\")\" = \"\$(git -C $BWT rev-parse HEAD)\" ]"
check "AC1 the report gives the counts"               '[[ "$out" == *"baseline: recorded feat/x at "*": typecheck 1 error(s)"* ]]'
check "the worker is told to check against it"        'grep -q "## Baseline checks" "$C/state/briefings/T-1.md" && grep -q "desk-env baseline typecheck" "$C/state/briefings/T-1.md"'
check "the base worktree is left clean"               "[ -z \"\$(git -C $BWT status --porcelain)\" ]"
node "$B/queue.mjs" add T-2 >/dev/null; node "$B/queue.mjs" set T-2 state=triaged >/dev/null; pass
check "a base that has not moved is not recorded again" '[[ "$out" == *"spawned: T-2"* ]] && [[ "$out" != *"baseline: recorded"* ]]'

# AC2, AC3, AC4: a worker's check, in its own clone of the base.
git clone -q "$C/origin.git" "$C/w1"; git -C "$C/w1" switch -q feat/x; cd "$C/w1" || exit 1
wcheck(){ out=$(DESK_DEFAULT_BRANCH=feat/x $DESK_ENV baseline typecheck 2>&1); rc=$?; }
printf "src/a.ts(9,1): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error.\n" > errors.txt; wcheck
check "AC2 only the recorded error, moved: the check passes" '[ $rc -eq 0 ] && [[ "$out" == *"PASS sh tc.sh: only the 1 error(s) the base already has"* ]]'
printf "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nlib/other.ts(1,1): error TS2304: Cannot find name 'x'.\nFound 2 errors.\n" > errors.txt; wcheck
check "AC3 a new error in another file fails and is named" '[ $rc -eq 1 ] && [[ "$out" == *"FAIL sh tc.sh: 1 new error(s)"* ]] && [[ "$out" == *"lib/other.ts:1  TS2304  Cannot find name '"'x'"'."* ]]'
printf "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/a.ts(4,5): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 2 errors.\n" > errors.txt; wcheck
check "AC4 a second identical error fails on the extra one" '[ $rc -eq 1 ] && [[ "$out" == *"src/a.ts:4  TS2322"* ]] && [[ "$out" != *"src/a.ts:3"* ]]'
printf 'tsc: out of memory\n' > errors.txt; printf 'cat errors.txt\nexit 134\n' > tc.sh; wcheck
check "AC6 unreadable output runs the full check and says so" '[ $rc -eq 1 ] && [[ "$out" == *"FULL sh tc.sh: this run'"'"'s output could not be read"* ]] && [[ "$out" == *"tsc: out of memory"* ]]'
git checkout -q -- .; cd "$C/repo" || exit 1

# AC5: a sync that brings commits into the base takes the baseline again before the next spawn.
git -C "$C/repo" fetch -q origin; git -C "$C/repo" switch -q main; git -C "$C/repo" merge -q --no-edit origin/feat/x
printf "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/b.ts(1,1): error TS2304: Cannot find name 'y'.\nFound 2 errors.\n" > "$C/repo/errors.txt"
git -C "$C/repo" commit -q -am "main adds an error"; git -C "$C/repo" push -q origin main
node "$B/queue.mjs" set T-1 state=done >/dev/null; node "$B/queue.mjs" set T-2 state=done >/dev/null
node "$B/queue.mjs" add T-3 >/dev/null; node "$B/queue.mjs" set T-3 state=triaged >/dev/null; pass
check "AC5 the sync merged"                           '[[ "$out" == *"base sync: merged"* ]]'
check "AC5 and the baseline is taken again first"     '[[ "$out" == *"baseline: recorded feat/x at "*": typecheck 2 error(s)"* ]] && [ "$(jq -r ".checks.typecheck[0].count" "$C/state/baseline.json")" = 2 ]'
check "AC5 the worker is briefed on the new baseline" 'grep -q "typecheck 2 error(s)" "$C/state/briefings/T-3.md"'

# The base moved on origin (the merge driver merged a PR into it) while a stray file kept the base
# worktree from catching up: it is not recorded, and leaves no baseline to compare against.
echo stray > "$C/wt/base-feat-x/stray.txt"
git -C "$C/seed" pull -q --no-rebase origin feat/x; git -C "$C/seed" commit -q --allow-empty -m "merged by the driver"; git -C "$C/seed" push -q origin feat/x
node "$B/queue.mjs" set T-3 state=done >/dev/null
node "$B/queue.mjs" add T-4 >/dev/null; node "$B/queue.mjs" set T-4 state=triaged >/dev/null; pass
check "a base worktree behind origin drops the baseline" '[ ! -e "$C/state/baseline.json" ] && [[ "${out#*WAITING ON YOU}" == *"baseline: not recorded"*"is not at origin'"'"'s feat/x"* ]] && ! grep -q "## Baseline checks" "$C/state/briefings/T-4.md"'

# AC7: off, or no base, checks as today.
baseline off off; pass
check "AC7 off: nothing is recorded"                  '[ ! -e "$C/state/baseline.json" ] && [[ "$out" != *"baseline"* ]] && [[ "$out" == *"spawned: T-1"* ]]'
check "AC7 off: no baseline section in the briefing"  '! grep -q "## Baseline checks" "$C/state/briefings/T-1.md"'
cd "$C/seed" || exit 1; out=$(DESK_DEFAULT_BRANCH=feat/x $DESK_ENV baseline typecheck 2>&1); rc=$?; cd "$C/repo" || exit 1
check "AC7 off: the worker's check is the full check" '[ $rc -eq 1 ] && [[ "$out" == *"baseline: off (config §4 Baseline checks is \"off\", not on): the full check"* ]] && [[ "$out" == *"FAIL sh tc.sh (exit 1)"* ]]'
fresh nobase-on yes -; printf '## 4. Tools\n| Field | Value |\n|---|---|\n| Typecheck | `sh tc.sh` |\n| Baseline checks | `on` |\n' >> "$C/config.md"; pass
check "AC7 no base: nothing is recorded"              '[ ! -e "$C/state/baseline.json" ] && [[ "$out" == *"spawned: T-1"* ]] && ! grep -q "## Baseline checks" "$C/state/briefings/T-1.md"'

# A dry run probes and pushes nothing.
fresh dry; tip=$(origin_tip); out=$(AUTOPILOT_DRY_RUN=1 node "$B/pass.mjs" 2>&1)
check "a dry run pushes nothing and says what it would merge" '[ "$(origin_tip)" = "$tip" ] && [[ "$out" == *"would merge 2 commit(s)"* ]]'

echo "base sync: $PASS passed, $FAIL failed"; cd /; rm -rf "$T"; [ "$FAIL" -eq 0 ]
