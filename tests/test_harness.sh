#!/usr/bin/env bash
# suite: harness-rules
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; T="$(mktemp -d)"; mkdir -p "$T/home" "$T/xdg"
H="$S/../"skills/desk-setup/bin/harness-rules.py
export HOME="$T/home" XDG_CONFIG_HOME="$T/xdg" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1
: > "$GIT_CONFIG_GLOBAL"; git config --global user.email t@example.com; git config --global user.name t
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; fi; }
run(){ out=$(python3 "$H" "$@" 2>&1); rc=$?; }
L="$T/ledger.json"
cat > "$T/allow.json" <<'J'
{"add":[{"list":"allow","rule":"Bash(gh pr ready *)","rows":["pr-ready"]},{"list":"ask","rule":"Bash(gh pr merge *)","rows":["pr-ready"]}]}
J
cat > "$T/guard.json" <<'J'
{"remove_guards":[{"list":"ask","rule":"Bash(gh pr merge *--auto*)","rows":["pr-auto-merge"]}]}
J
cat > "$T/deny.json" <<'J'
{"add":[{"list":"deny","rule":"Bash(git push --force *)","rows":["never"]},{"list":"ask","rule":"Bash(rm -rf *)","rows":["x"]}]}
J
mkrepo(){ git init -q "$T/$1"; mkdir -p "$T/$1/.claude"; }

# user level
run --ledger "$L" add "$T/allow.json"
check "allow plan to default ~/.claude/settings.json refused" '[ $rc -eq 2 ] && [[ "$out" == *"user-level"* ]] && [ ! -e "$HOME/.claude/settings.json" ]'
run --ledger "$L" add "$T/guard.json"
check "remove_guards to user level refused" '[ $rc -eq 2 ]'
run --ledger "$L" --settings "$T/loose/settings.json" add "$T/allow.json"
check "allow plan to a path outside any repo refused" '[ $rc -eq 2 ] && [ ! -e "$T/loose/settings.json" ]'
run --ledger "$L" add "$T/deny.json"
check "deny/ask plan to user level allowed" '[ $rc -eq 0 ] && grep -q "git push --force" "$HOME/.claude/settings.json"'
run --ledger "$L" baseline
check "baseline to user level allowed" '[ $rc -eq 0 ] && grep -q "gh pr merge" "$HOME/.claude/settings.json"'
git init -q "$HOME"; mkdir -p "$HOME/.claude"
run --ledger "$L" --settings "$HOME/.claude/settings.local.json" add "$T/allow.json"
# A check name, not a path.
# shellcheck disable=SC2088
check "~/.claude is user-level even when HOME is a git repo" '[ $rc -eq 2 ] && [[ "$out" == *"user-level"* ]]'
rm -rf "$HOME/.git"

# repo level
mkrepo own; printf '.claude/settings.local.json\n' > "$T/own/.gitignore"
run --ledger "$T/own.json" --settings "$T/own/.claude/settings.local.json" add "$T/allow.json"
check "repo .gitignore covers it: written, source named" '[ $rc -eq 0 ] && [[ "$out" == *"ignored by the repo'"'"'s .gitignore"* ]] && grep -q "gh pr ready" "$T/own/.claude/settings.local.json"'
mkrepo glob; printf '.claude/settings.local.json\n' > "$T/xdg-ignore"; git config --global core.excludesFile "$T/xdg-ignore"
run --ledger "$T/glob.json" --settings "$T/glob/.claude/settings.local.json" add "$T/allow.json"
check "only global excludes: written, recommendation given" '[ $rc -eq 0 ] && [[ "$out" == *"global excludes"* ]] && [[ "$out" == *"recommend adding"* ]]'
git config --global --unset core.excludesFile
mkrepo info; printf '.claude/settings.local.json\n' >> "$T/info/.git/info/exclude"
run --ledger "$T/info.json" --settings "$T/info/.claude/settings.local.json" add "$T/allow.json"
check "only .git/info/exclude: written, recommendation given" '[ $rc -eq 0 ] && [[ "$out" == *"info/exclude"* ]] && [[ "$out" == *"recommend adding"* ]]'
mkrepo bare
run --ledger "$T/bare.json" --settings "$T/bare/.claude/settings.local.json" add "$T/allow.json"
check "not ignored: refused, nothing written" '[ $rc -eq 2 ] && [[ "$out" == *"does not ignore"* ]] && [ ! -e "$T/bare/.claude/settings.local.json" ]'
mkrepo tracked; printf '{}\n' > "$T/tracked/.claude/settings.local.json"; git -C "$T/tracked" add -f .claude/settings.local.json
printf '.claude/settings.local.json\n' > "$T/tracked/.gitignore"
run --ledger "$T/tr.json" --settings "$T/tracked/.claude/settings.local.json" add "$T/allow.json"
check "tracked file refused even though .gitignore names it" '[ $rc -eq 2 ] && [[ "$out" == *"tracked"* ]] && [ "$(cat "$T/tracked/.claude/settings.local.json")" = "{}" ]'
run --ledger "$T/sj.json" --settings "$T/own/.claude/settings.json" add "$T/allow.json"
check "repo .claude/settings.json (not ignored) refused" '[ $rc -eq 2 ]'
mkdir -p "$T/own/sub/.claude"
run --ledger "$T/sub.json" --settings "$T/own/sub/.claude/settings.local.json" add "$T/allow.json"
check "a .claude/ that is not at a repo root is not repo-level" '[ $rc -eq 2 ] && [[ "$out" == *"user-level"* ]]'

# remove
run --ledger "$T/own.json" --settings "$T/own/.claude/settings.local.json" remove pr-ready
check "remove after add says REMOVED" '[ $rc -eq 0 ] && [[ "$out" == *"REMOVED  allow Bash(gh pr ready *)"* ]] && ! grep -q "gh pr ready" "$T/own/.claude/settings.local.json"'
run --ledger "$T/none.json" --settings "$T/own/.claude/never.json" remove pr-ready
check "remove on a never-existing file claims nothing" '[ $rc -eq 0 ] && [[ "$out" == *"nothing to remove"* ]] && [[ "$out" == *"does not exist"* ]] && [[ "$out" != *REMOVED* ]] && [ ! -e "$T/own/.claude/never.json" ]'
cp "$T/glob.json" "$T/glob2.json"
run --ledger "$T/glob2.json" --settings "$T/glob/.claude/gone.json" remove pr-ready
check "remove with ledger records but missing file: no REMOVED, no file created" '[ $rc -eq 0 ] && [[ "$out" == *"absent"* ]] && [[ "$out" != *REMOVED* ]] && [ ! -e "$T/glob/.claude/gone.json" ]'
run --ledger "$T/own.json" --settings "$T/own/.claude/settings.local.json" remove nobody
check "remove of an unowned row says nothing to remove" '[ $rc -eq 0 ] && [[ "$out" == *"nothing to remove"* ]]'

# remove reaches worktree copies: a matching copy is synced (after a backup), a differing one named
RT="$(cd "$T" && pwd -P)"  # git worktree list prints real paths (/private/var on macOS)
mkrepo wt; printf '.claude/settings.local.json\n' > "$T/wt/.gitignore"
git -C "$T/wt" add .gitignore; git -C "$T/wt" commit -qm init
printf '{"permissions":{"allow":["Bash(ls)"]}}\n' > "$T/wt/.claude/settings.local.json"  # the user's own: the file outlives the revoke
run --ledger "$T/wt.json" --settings "$T/wt/.claude/settings.local.json" add "$T/allow.json"
git -C "$T/wt" worktree add -q "$T/wt-same" -b same; git -C "$T/wt" worktree add -q "$T/wt-own" -b own
git -C "$T/wt" worktree add -q "$T/wt-none" -b none
mkdir -p "$T/wt-same/.claude" "$T/wt-own/.claude"
cp "$T/wt/.claude/settings.local.json" "$T/wt-same/.claude/settings.local.json"
printf '{"permissions":{"allow":["Bash(gh pr ready *)","Bash(ls)"]}}\n' > "$T/wt-own/.claude/settings.local.json"
run --ledger "$T/wt.json" --settings "$T/wt/.claude/settings.local.json" remove pr-ready
check "remove syncs a worktree copy that matched" '[ $rc -eq 0 ] && [[ "$out" == *"synced   $RT/wt-same/.claude/settings.local.json"* ]] && ! grep -q "gh pr ready" "$T/wt-same/.claude/settings.local.json" && cmp -s "$T/wt/.claude/settings.local.json" "$T/wt-same/.claude/settings.local.json"'
check "the synced copy is backed up first" 'grep -q "gh pr ready" "$T"/wt-same/.claude/settings.local.json.bak-desk-*'
check "a differing copy is left alone and named" '[[ "$out" == *"differs  $RT/wt-own/.claude/settings.local.json"* ]] && grep -q "gh pr ready" "$T/wt-own/.claude/settings.local.json" && ! ls "$T"/wt-own/.claude/settings.local.json.bak-desk-* >/dev/null 2>&1'
check "a worktree with no copy gets none" '[ ! -e "$T/wt-none/.claude/settings.local.json" ]'
run --ledger "$T/wt.json" --settings "$T/wt/.claude/settings.local.json" remove pr-ready
check "a second remove touches no copy" '[ $rc -eq 0 ] && [[ "$out" == *"nothing to remove"* ]] && [[ "$out" != *synced* ]] && [[ "$out" != *differs* ]]'
mkrepo wt2; printf '.claude/settings.local.json\n' > "$T/wt2/.gitignore"
git -C "$T/wt2" add .gitignore; git -C "$T/wt2" commit -qm init
run --ledger "$T/wt2.json" --settings "$T/wt2/.claude/settings.local.json" add "$T/allow.json"
git -C "$T/wt2" worktree add -q "$T/wt2-same" -b same; mkdir -p "$T/wt2-same/.claude"
cp "$T/wt2/.claude/settings.local.json" "$T/wt2-same/.claude/settings.local.json"
run --ledger "$T/wt2.json" --settings "$T/wt2/.claude/settings.local.json" remove pr-ready orchestrator-tools
check "a copy of a file setup created and now removed goes too, backed up" '[ $rc -eq 0 ] && [ ! -e "$T/wt2/.claude/settings.local.json" ] && [ ! -e "$T/wt2-same/.claude/settings.local.json" ] && ls "$T"/wt2-same/.claude/settings.local.json.bak-desk-* >/dev/null 2>&1'
mkrepo wt3; printf '.claude/settings.local.json\n' > "$T/wt3/.gitignore"
git -C "$T/wt3" add .gitignore; git -C "$T/wt3" commit -qm init
printf '{"permissions":{"allow":["Bash(ls)"]}}\n' > "$T/wt3/.claude/settings.local.json"
run --ledger "$T/wt3.json" --settings "$T/wt3/.claude/settings.local.json" add "$T/allow.json"
for w in a b; do
  git -C "$T/wt3" worktree add -q "$T/wt3-$w" -b "$w"; mkdir -p "$T/wt3-$w/.claude"
  cp "$T/wt3/.claude/settings.local.json" "$T/wt3-$w/.claude/settings.local.json"
done
chmod 000 "$T/wt3-a/.claude/settings.local.json"
run --ledger "$T/wt3.json" --settings "$T/wt3/.claude/settings.local.json" remove pr-ready
chmod 644 "$T/wt3-a/.claude/settings.local.json"
check "an unreadable copy is named, exit 1, and the next copy is still synced" '[ $rc -eq 1 ] && [[ "$out" == *"FAILED   $RT/wt3-a/.claude/settings.local.json"* ]] && [[ "$out" == *"REMOVED  allow"* ]] && [[ "$out" == *"synced   $RT/wt3-b/.claude/settings.local.json"* ]] && [[ "$out" != *Traceback* ]]'

run --ledger "$L" --settings "$HOME/.claude/settings.json" baseline --check
check "baseline --check still passes at user level" '[ $rc -eq 0 ]'

# unset-default-mode: only dontAsk goes, backed up, the rest of the file kept
mkrepo dm
printf '{"permissions":{"defaultMode":"dontAsk","allow":["Bash(ls)"]},"model":"x"}\n' > "$T/dm/.claude/settings.local.json"
run --settings "$T/dm/.claude/settings.local.json" unset-default-mode
check "unset-default-mode removes dontAsk" '[ $rc -eq 0 ] && [[ "$out" == *"removed  permissions.defaultMode"* ]] && ! grep -q defaultMode "$T/dm/.claude/settings.local.json"'
check "unset-default-mode keeps the rest" 'grep -q "Bash(ls)" "$T/dm/.claude/settings.local.json" && grep -q "\"model\"" "$T/dm/.claude/settings.local.json"'
check "unset-default-mode backs up first" 'grep -q dontAsk "$T"/dm/.claude/settings.local.json.bak-desk-*'
printf '{"permissions":{"defaultMode":"acceptEdits"}}\n' > "$T/dm/.claude/settings.json"
run --settings "$T/dm/.claude/settings.json" unset-default-mode
check "unset-default-mode leaves another mode alone" '[ $rc -eq 0 ] && [[ "$out" == *"nothing to change"* ]] && grep -q acceptEdits "$T/dm/.claude/settings.json"'

# every merge allow a row grants is pinned to a head commit, whatever the merge method
ROWS="$S/../skills/desk-setup/references/permission-rows.md"
merge_allows=$(grep -E '^\| `[a-z-]+` \|' "$ROWS" | grep -oE '`Bash\(gh pr merge [^`]*`')
out=$merge_allows
check "the rows grant merge allows" '[ "$(printf "%s\n" "$merge_allows" | grep -c .)" -ge 3 ]'
check "every merge allow in the rows requires --match-head-commit" '! printf "%s\n" "$merge_allows" | grep -v -- "--match-head-commit \*)\`$"'
for g in '"' "'" '#' '<' '>(' '$' '`' '--match-head-commit='; do
  check "the merge row prompts on $g" 'grep -qF "ask: Bash(gh pr merge *$g*)" "$ROWS"'
done
for m in --squash --merge --rebase; do
  out=$(printf '%s\n' "$merge_allows" | while IFS= read -r r; do printf '%s\n' "${r//<merge>/$m}"; done)
  check "rows rendered with $m stay pinned" '[[ "$out" == *"$m --match-head-commit *)"* ]] && ! printf "%s\n" "$out" | grep -qE -- "$m( --auto)?\)\`$"'
done

# retire: unpinned merge allows an earlier setup recorded are dropped, backed up, and reported
cat > "$T/old.json" <<'J'
{"add":[{"list":"allow","rule":"Bash(gh pr merge * --merge)","rows":["pr-merge-green"]},{"list":"allow","rule":"Bash(gh pr merge * --auto --merge)","rows":["pr-auto-merge","pr-merge-green"]}]}
J
cat > "$T/pinned.json" <<'J'
{"add":[{"list":"allow","rule":"Bash(gh pr merge * --merge --match-head-commit *)","rows":["pr-merge-green"]}]}
J
mkrepo rt; printf '.claude/settings.local.json\n' > "$T/rt/.gitignore"
git -C "$T/rt" add .gitignore; git -C "$T/rt" commit -qm init
printf '{"permissions":{"allow":["Bash(gh pr merge * --squash)"]}}\n' > "$T/rt/.claude/settings.local.json"
run --ledger "$T/rt.json" --settings "$T/rt/.claude/settings.local.json" add "$T/old.json"
git -C "$T/rt" worktree add -q "$T/rt-same" -b same; mkdir -p "$T/rt-same/.claude"
cp "$T/rt/.claude/settings.local.json" "$T/rt-same/.claude/settings.local.json"
run --ledger "$T/rt.json" --settings "$T/rt/.claude/settings.local.json" retire
check "retire drops the unpinned merge allows setup recorded" '[ $rc -eq 0 ] && [[ "$out" == *"RETIRED  allow Bash(gh pr merge * --merge)"* ]] && [[ "$out" == *"RETIRED  allow Bash(gh pr merge * --auto --merge)"* ]] && ! grep -q -- "--merge)" "$T/rt/.claude/settings.local.json" && ! grep -q "gh pr merge" "$T/rt.json"'
check "retire backs the settings file up first" 'grep -q -- "--auto --merge)" "$T"/rt/.claude/settings.local.json.bak-desk-*'
check "retire reports an unpinned allow the user added and leaves it" '[[ "$out" == *"retired  allow Bash(gh pr merge * --squash)  (yours"* ]] && grep -q -- "--squash)" "$T/rt/.claude/settings.local.json"'
check "retire syncs a worktree copy that matched" '[[ "$out" == *"synced   $RT/rt-same/.claude/settings.local.json"* ]] && cmp -s "$T/rt/.claude/settings.local.json" "$T/rt-same/.claude/settings.local.json"'
run --ledger "$T/rt.json" --settings "$T/rt/.claude/settings.local.json" retire
check "a second retire changes nothing" '[ $rc -eq 0 ] && [[ "$out" != *RETIRED* ]] && [[ "$out" != *backup* ]]'
mkrepo ra; printf '.claude/settings.local.json\n' > "$T/ra/.gitignore"
run --ledger "$T/ra.json" --settings "$T/ra/.claude/settings.local.json" add "$T/old.json"
run --ledger "$T/ra.json" --settings "$T/ra/.claude/settings.local.json" add "$T/pinned.json"
check "add retires the unpinned allows and writes the pinned one" '[ $rc -eq 0 ] && [[ "$out" == *"RETIRED  allow Bash(gh pr merge * --merge)"* ]] && [[ "$out" == *"NEW      allow Bash(gh pr merge * --merge --match-head-commit *)"* ]] && ! grep -q -- "--merge)\"" "$T/ra/.claude/settings.local.json"'
mkdir -p "$T/legacy"
printf '{"permissions":{"allow":["Bash(gh pr merge * --squash)"]}}\n' > "$T/legacy/settings.json"
printf '{"rules":[{"list":"allow","rule":"Bash(gh pr merge * --squash)","rows":["pr-merge-green"],"added":"2026-01-01"}]}\n' > "$T/legacy.json"
run --ledger "$T/legacy.json" --settings "$T/legacy/settings.json" baseline --check
check "baseline --check flags a retired allow setup recorded" '[ $rc -eq 1 ] && [[ "$out" == *"retired  allow Bash(gh pr merge * --squash)"* ]]'
run --ledger "$T/legacy.json" --settings "$T/legacy/settings.json" baseline
check "baseline drops it, backed up" '[ $rc -eq 0 ] && [[ "$out" == *"RETIRED  allow Bash(gh pr merge * --squash)"* ]] && ! grep -q -- "--squash)" "$T/legacy/settings.json" && grep -q -- "--squash)" "$T"/legacy/settings.json.bak-desk-*'
run --ledger "$T/legacy.json" --settings "$T/legacy/settings.json" baseline --check
check "baseline --check passes once it is gone" '[ $rc -eq 0 ]'

# orchestrator tools: written with every repo plan, owner orchestrator-tools
RR="$(cd "$T" && pwd -P)"; MEM="Edit(~/.claude/projects/${RR//[^A-Za-z0-9]/-}-ot/memory/**)"
mkrepo ot; printf '.claude/settings.local.json\n' > "$T/ot/.gitignore"
run --ledger "$T/ot.json" --settings "$T/ot/.claude/settings.local.json" add "$T/allow.json"
ot_ok=1
for r in Monitor 'mcp__claude-in-chrome__*' ArtifactComments ArtifactData "$MEM"; do
  jq -e --arg r "$r" '.permissions.allow | index($r)' "$T/ot/.claude/settings.local.json" >/dev/null || ot_ok=0
  jq -e --arg r "$r" '.rules[] | select(.rule == $r and .list == "allow" and .rows == ["orchestrator-tools"])' "$T/ot.json" >/dev/null || ot_ok=0
done
check "AC1: an ignored settings.local.json gets the orchestrator tools, in the file and the ledger" '[ $rc -eq 0 ] && [ $ot_ok = 1 ] && [[ "$out" == *"NEW      allow Monitor  (orchestrator-tools)"* ]]'
cat > "$T/jira.json" <<'J'
{"add":[{"list":"ask","rule":"Bash(desk-jira create *--route*)","rows":["jira-create"]}]}
J
mkrepo otr; printf '{}\n' > "$T/otr/.claude/settings.local.json"; git -C "$T/otr" add -f .claude/settings.local.json
run --ledger "$T/otr.json" --settings "$T/otr/.claude/settings.local.json" add "$T/jira.json"
check "AC2: a tracked settings.local.json is refused by name, even for an ask-only plan" '[ $rc -eq 2 ] && [[ "$out" == *"$T/otr/.claude/settings.local.json is tracked"* ]] && [ "$(cat "$T/otr/.claude/settings.local.json")" = "{}" ] && [ ! -e "$T/otr.json" ]'
mkrepo otn
run --ledger "$T/otn.json" --settings "$T/otn/.claude/settings.local.json" add "$T/jira.json"
check "AC2: a settings.local.json git does not ignore is refused by name" '[ $rc -eq 2 ] && [[ "$out" == *"does not ignore .claude/settings.local.json in $T/otn"* ]] && [ ! -e "$T/otn/.claude/settings.local.json" ]'
cp "$T/ot/.claude/settings.local.json" "$T/ot-before.json"; cp "$T/ot.json" "$T/ot-ledger-before.json"
run --ledger "$T/ot.json" --settings "$T/ot/.claude/settings.local.json" add "$T/allow.json"
check "AC7: every rule already there is reported present, with no backup and no change" '[ $rc -eq 0 ] && [[ "$out" == *"present  allow Monitor  (recorded for orchestrator-tools)"* ]] && [[ "$out" == *"present  allow Bash(gh pr ready *)"* ]] && [[ "$out" != *NEW* ]] && [[ "$out" != *backup* ]] && cmp -s "$T/ot/.claude/settings.local.json" "$T/ot-before.json" && cmp -s "$T/ot.json" "$T/ot-ledger-before.json" && [ "$(ls "$T"/ot/.claude/ | grep -c bak-desk)" = 0 ]'
mkrepo oty; printf '.claude/settings.local.json\n' > "$T/oty/.gitignore"
jq -n --arg m "${MEM//-ot\//-oty/}" '{permissions:{allow:["Bash(gh pr ready *)","Monitor","mcp__claude-in-chrome__*","ArtifactComments","ArtifactData",$m],ask:["Bash(gh pr merge *)"]}}' > "$T/oty/.claude/settings.local.json"
cp "$T/oty/.claude/settings.local.json" "$T/oty-before.json"
run --ledger "$T/oty.json" --settings "$T/oty/.claude/settings.local.json" add "$T/allow.json"
check "AC7: rules the user already holds are reported present, with no backup and no change" '[ $rc -eq 0 ] && [[ "$out" == *"present  allow Monitor  (yours"* ]] && [[ "$out" == *"present  allow ${MEM//-ot\//-oty/}  (yours"* ]] && [[ "$out" != *NEW* ]] && [[ "$out" != *backup* ]] && cmp -s "$T/oty/.claude/settings.local.json" "$T/oty-before.json" && [ "$(ls "$T"/oty/.claude/ | grep -c bak-desk)" = 0 ]'

# the desk-jira create assignee ask: retired; the --route ask moves to jira-create
ASG='Bash(desk-jira create *assignee*)'; RTE='Bash(desk-jira create *--route*)'
mkrepo asg; printf '.claude/settings.local.json\n' > "$T/asg/.gitignore"
jq -n --arg a "$ASG" --arg r "$RTE" '{permissions:{allow:["Bash(desk-jira create *)"],ask:[$a,$r]}}' > "$T/asg/.claude/settings.local.json"
jq -n --arg a "$ASG" --arg r "$RTE" '{rules:[{list:"allow",rule:"Bash(desk-jira create *)",rows:["jira-create"],added:"2026-01-01"},{list:"ask",rule:$a,rows:["jira-create"],added:"2026-01-01"},{list:"ask",rule:$r,rows:["jira-assign-self"],added:"2026-01-01"}]}' > "$T/asg.json"
run --ledger "$T/asg.json" --settings "$T/asg/.claude/settings.local.json" retire
check "AC3: retire drops the assignee ask setup recorded, from the file and the ledger" '[ $rc -eq 0 ] && [[ "$out" == *"RETIRED  ask   $ASG  (desk-jira create assigns only you"* ]] && ! grep -qF "*assignee*" "$T/asg/.claude/settings.local.json" && ! grep -qF "*assignee*" "$T/asg.json"'
check "retire moves the --route ask from jira-assign-self to jira-create" '[[ "$out" == *"REOWNED  ask   $RTE  (jira-assign-self -> jira-create)"* ]] && jq -e --arg r "$RTE" ".rules[] | select(.rule == \$r and .rows == [\"jira-create\"])" "$T/asg.json" >/dev/null'
run --ledger "$T/asg.json" --settings "$T/asg/.claude/settings.local.json" remove jira-assign-self
check "revoking jira-assign-self then leaves the --route ask in place" '[ $rc -eq 0 ] && grep -qF -- "*--route*" "$T/asg/.claude/settings.local.json"'
mkrepo asu; printf '.claude/settings.local.json\n' > "$T/asu/.gitignore"
jq -n --arg a "$ASG" '{permissions:{ask:[$a]}}' > "$T/asu/.claude/settings.local.json"
printf '{"rules":[]}\n' > "$T/asu.json"
run --ledger "$T/asu.json" --settings "$T/asu/.claude/settings.local.json" retire
check "AC4: an assignee ask the user added is left in place and named as theirs" '[ $rc -eq 0 ] && [[ "$out" == *"retired  ask   $ASG  (yours, left alone"* ]] && [[ "$out" != *RETIRED* ]] && grep -qF "*assignee*" "$T/asu/.claude/settings.local.json"'
mkrepo asr; printf '.claude/settings.local.json\n' > "$T/asr/.gitignore"
printf '{"permissions":{"allow":["Bash(desk-jira create *)"]}}\n' > "$T/asr/.claude/settings.local.json"
jq -n --arg a "$ASG" '{rules:[],removed_guards:[{list:"ask",rule:$a,rows:["jira-assign-self"],guard_rows:["jira-create"],removed:"2026-01-01"}]}' > "$T/asr.json"
run --ledger "$T/asr.json" --settings "$T/asr/.claude/settings.local.json" retire
check "retire forgets an assignee guard setup removed, so a revoke never puts it back" '[ $rc -eq 0 ] && [[ "$out" == *"RETIRED  ask   $ASG  (guard record dropped"* ]] && ! grep -qF "*assignee*" "$T/asr.json"'
run --ledger "$T/asr.json" --settings "$T/asr/.claude/settings.local.json" remove jira-assign-self
check "  … and revoking jira-assign-self adds no assignee ask" '[ $rc -eq 0 ] && ! grep -qF "*assignee*" "$T/asr/.claude/settings.local.json"'
JC=$(grep -E '^\| `jira-create` \|' "$ROWS"); JA=$(grep -E '^\| `jira-assign-self` \|' "$ROWS")
out="$JC"
check "AC5: with jira-create yes the plan holds no assignee ask" '[[ "$JC" == *"Bash(desk-jira create *)"* ]] && [[ "$JC" != *"ask: Bash(desk-jira create *assignee*)"* ]] && [[ "$JA" != *"ask: "* ]] && [[ "$JA" != *"unguard: "* ]]'
check "AC6: with jira-create yes the plan still holds the --route ask" '[[ "$JC" == *"ask: Bash(desk-jira create *--route*)"* ]]'
echo; echo "$PASS passed, $FAIL failed"; [ $FAIL = 0 ]
