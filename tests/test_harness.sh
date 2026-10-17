#!/usr/bin/env bash
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
echo; echo "$PASS passed, $FAIL failed"; [ $FAIL = 0 ]
