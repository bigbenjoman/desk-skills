#!/usr/bin/env bash
# suite: repo-plugins (suggest, offer, apply)
# Tests desk-setup's repo-plugins.py against a throwaway HOME holding a stub plugin list, a temporary
# git repo and a stub desk-env: the per-plugin rules, the unjudged listing, the /desk-update offer
# check, and the refusal to write a tracked settings.local.json.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; T="$(mktemp -d)"
export HOME="$T/home"
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     rc=$rc out: $out"; fi; }

CACHE="$HOME/.claude/plugins/cache"
plugin(){ # id, number of skills
  n=0; while [ $n -lt "$2" ]; do mkdir -p "$CACHE/$1/skills/s$n"; echo x > "$CACHE/$1/skills/s$n/SKILL.md"; n=$((n+1)); done; }
plugin legal@synced 4
plugin everything-claude-code@ecc 30
plugin mystery@somewhere 7
plugin codex@openai 2
mkdir -p "$HOME/.claude/plugins"
cat > "$HOME/.claude/settings.json" <<'J'
{"enabledPlugins": {"legal@synced": true, "everything-claude-code@ecc": true,
                    "mystery@somewhere": true, "codex@openai": true, "gone@x": false}}
J
cat > "$HOME/.claude/plugins/installed_plugins.json" <<J
{"plugins": {"legal@synced": [{"installPath": "$CACHE/legal@synced"}],
             "everything-claude-code@ecc": [{"installPath": "$CACHE/everything-claude-code@ecc"}],
             "mystery@somewhere": [{"installPath": "$CACHE/mystery@somewhere"}],
             "codex@openai": [{"installPath": "$CACHE/codex@openai"}]}}
J
mkdir -p "$T/bin"; printf '#!/bin/sh\necho none\n' > "$T/bin/desk-env"; chmod +x "$T/bin/desk-env"
export PATH="$T/bin:$PATH"

R="$T/repo"; mkdir -p "$R"; git -C "$R" init -q; echo readme > "$R/README.md"
git -C "$R" add README.md; git -C "$R" -c user.name=t -c user.email=t@t commit -qm init
P(){ out=$(python3 "$S/../skills/desk-setup/bin/repo-plugins.py" --root "$R" "$@" 2>&1); rc=$?; }
row(){ python3 -c 'import json,sys; r=[x for x in json.loads(sys.argv[1]) if x["plugin"]==sys.argv[2]]; print(r[0][sys.argv[3]] if r else "MISSING")' "$out" "$1" "$2"; }

P suggest
check "legal@synced is suggested off with no contract documents" '[ "$(row legal@synced suggest)" = off ]'
check "legal@synced carries its evidence" '[[ "$(row legal@synced evidence)" == *"contracts to review"* ]]'
check "everything-claude-code is listed with its skill count" '[ "$(row everything-claude-code@ecc skills)" = 30 ]'
check "everything-claude-code is suggested off" '[ "$(row everything-claude-code@ecc suggest)" = off ]'
check "a plugin with no rule is listed as unjudged" '[ "$(row mystery@somewhere suggest)" = unjudged ]'
check "an unjudged plugin carries its skill count" '[ "$(row mystery@somewhere skills)" = 7 ]'
check "codex is kept" '[ "$(row codex@openai suggest)" = keep ]'
check "a plugin disabled at user level is not listed" '[ "$(row gone@x suggest)" = MISSING ]'

mkdir -p "$R/contracts"; echo x > "$R/contracts/msa.md"; git -C "$R" add contracts
P suggest
check "legal@synced is kept where the repo holds contracts" '[ "$(row legal@synced suggest)" = keep ]'
git -C "$R" rm -rq --cached contracts; rm -rf "$R/contracts"

P offer
check "no plugin entries: offer with the skills it would remove" '[ $rc -eq 0 ] && [[ "$out" == "offer: 2 plugins, 34 skills"* ]]'
check "the offer leaves the unjudged plugin out" '[[ "$out" != *mystery* ]]'

echo '.claude/settings.local.json' > "$R/.gitignore"
P apply --off legal@synced
check "apply writes the off entry" '[ $rc -eq 0 ] && [[ "$(cat "$R/.claude/settings.local.json")" == *'"'"'"legal@synced": false'"'"'* ]]'
P offer
check "plugin entries already present: no offer" '[ $rc -eq 1 ] && [[ "$out" == "no offer:"* ]]'

printf '{"permissions": {}}\n' > "$R/.claude/settings.local.json"
P offer
check "settings.local.json without plugin entries still offers" '[ $rc -eq 0 ]'

rm "$R/.gitignore"; git -C "$R" add -f .claude/settings.local.json
before=$(cat "$R/.claude/settings.local.json")
P apply --off legal@synced
check "a tracked settings.local.json is refused" '[ $rc -eq 2 ] && [[ "$out" == *"add \`.claude/settings.local.json\` to .gitignore first"* ]]'
check "nothing is written when refused" '[ "$(cat "$R/.claude/settings.local.json")" = "$before" ]'

rm -rf "$T"
echo; echo "$PASS/$((PASS+FAIL)) checks passed"; [ "$FAIL" = 0 ]
