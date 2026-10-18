#!/usr/bin/env bash
# suite: plugins (unbumped vs outdated)
# Tests `skills-upstream plugins` for plugins that live inside their marketplace, against a throwaway
# HOME and a stub `claude`. A folder that changed under an unchanged version is UNBUMPED (claude plugin
# update cannot apply it) and must not set exit 10; a bumped version is OUTDATED and must.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; T="$(mktemp -d)"
export HOME="$T/home"
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     rc=$rc out: $out"; fi; }

MK="$HOME/.claude/plugins/marketplaces/mkt"; CACHE="$HOME/.claude/plugins/cache/mkt"
plugin(){ # name, marketplace version, installed version, extra marketplace file (or "")
  mkdir -p "$MK/plugins/$1/.claude-plugin" "$CACHE/$1/$3/.claude-plugin"
  echo "{\"name\":\"$1\",\"version\":\"$2\"}" > "$MK/plugins/$1/.claude-plugin/plugin.json"
  echo "{\"name\":\"$1\",\"version\":\"$3\"}" > "$CACHE/$1/$3/.claude-plugin/plugin.json"
  [ -n "$4" ] && echo licence > "$MK/plugins/$1/$4"; }
plugin same 1.0.0 1.0.0 ""
plugin unbumped 1.0.0 1.0.0 LICENSE
plugin bumped 1.1.0 1.0.0 ""
mkdir -p "$MK/.claude-plugin"
cat > "$MK/.claude-plugin/marketplace.json" <<'J'
{"plugins": [{"name": "same", "source": "./plugins/same"},
             {"name": "unbumped", "source": "./plugins/unbumped"},
             {"name": "bumped", "source": "./plugins/bumped"}]}
J
LIST="["; for n in same unbumped bumped; do v=1.0.0
  LIST="$LIST{\"id\":\"$n@mkt\",\"version\":\"$v\",\"installPath\":\"$CACHE/$n/$v\"},"; done
LIST="${LIST%,}]"
mkdir -p "$T/bin"; printf '#!/bin/sh\nprintf %%s %q\n' "$LIST" > "$T/bin/claude"; chmod +x "$T/bin/claude"
export PATH="$T/bin:$PATH"
U(){ out=$(python3 "$S/../bin/skills-upstream" "$@" 2>&1); rc=$?; }

U plugins
check "identical folder is ok" '[[ "$out" == *"ok       same@mkt"* ]]'
check "changed, same version is UNBUMPED with the change listed" '[[ "$out" == *"UNBUMPED unbumped@mkt"*"same version 1.0.0"*"+LICENSE"* ]]'
check "version bump is OUTDATED with the new version" '[[ "$out" == *"OUTDATED bumped@mkt"*"-> 1.1.0"* ]]'
check "a bump still sets exit 10" '[ $rc -eq 10 ]'

rm -rf "$MK/plugins/bumped"; cp -R "$CACHE/bumped/1.0.0" "$MK/plugins/bumped"
U plugins
check "UNBUMPED alone does not set exit 10" '[ $rc -eq 0 ] && [[ "$out" == *UNBUMPED* ]] && [[ "$out" != *OUTDATED* ]]'
U plugins --json
check "json status is unbumped" '[[ "$out" == *"\"status\": \"unbumped\""* ]]'

rm -rf "$T"
echo; echo "$PASS/$((PASS+FAIL)) checks passed"; [ "$FAIL" = 0 ]
