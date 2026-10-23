#!/usr/bin/env bash
# suite: install.sh with no terminal (every skipped prompt listed)
# install.sh run with no terminal (as /desk-update runs it: stdin from /dev/null) skips every
# settings prompt; each skip must be listed at the end with the way to apply it. Runs the whole
# installer under a throwaway HOME with stub claude, gh and codex. Nothing touches your real ~/.claude.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
SH="${BASH:-bash}"
export HOME="$T/home"; mkdir -p "$HOME/.claude/desk"
unset DESK_CONFIG_ROOT
touch "$HOME/.claude/desk/skills-upstream.last"   # the upstream check would otherwise reach the network
# Desk's Playwright and @playwright/mcp already at the pin, or every run downloads them and Chromium.
PW="$HOME/.claude/desk/playwright"; mkdir -p "$PW/node_modules/playwright" "$PW/node_modules/@playwright/mcp"
printf 'playwright %s, @playwright/mcp %s\n' \
  "$(sed -n 's/^PLAYWRIGHT_VERSION="\(.*\)"$/\1/p' "$S/../install.sh")" \
  "$(sed -n 's/^PLAYWRIGHT_MCP_VERSION="\(.*\)"$/\1/p' "$S/../install.sh")" > "$PW/version"
touch "$PW/node_modules/playwright/index.mjs" "$PW/node_modules/@playwright/mcp/cli.js"
PASS=0; FAIL=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out" | tail -n 40; fi; }

mkdir -p "$T/bin"
cat > "$T/bin/claude" <<'EOF'
#!/bin/sh
[ "$1 $2" = "plugin list" ] && echo '[]'
exit 0
EOF
cat > "$T/bin/gh" <<'EOF'
#!/bin/sh
[ "$1 $2" = "auth status" ] && { echo "  - Token scopes: 'repo', 'workflow'"; exit 0; }
exit 1
EOF
printf '#!/bin/sh\nexit 0\n' > "$T/bin/codex"
chmod +x "$T/bin/claude" "$T/bin/gh" "$T/bin/codex"
export PATH="$T/bin:$PATH"

# AC3: stdin that is not a terminal means no terminal, whatever /dev/tty says.
fn="$(sed -n '/^have_tty() {/p' "$S/../install.sh")"
check "have_tty is found in install.sh" '[ -n "$fn" ]'
eval "$fn"
check "have_tty is false with stdin from /dev/null" '! have_tty </dev/null'

# A repo whose earlier /desk-setup recorded an unpinned merge allow, next to one the user added.
R="$T/repo"; git init -q "$R"; mkdir -p "$R/.claude"; printf '.claude/settings.local.json\n' > "$R/.gitignore"
printf '{"permissions":{"allow":["Bash(gh pr merge * --squash)","Bash(gh pr merge * --rebase)"]}}\n' > "$R/.claude/settings.local.json"
C="$HOME/.config/desk/repos/o__r"; mkdir -p "$C"
printf '## 2. Paths on your machine\n\n| Field | Value | Notes |\n|---|---|---|\n| Primary repo root | `%s` | x |\n' "$R" > "$C/config.md"
printf '{"rules":[{"list":"allow","rule":"Bash(gh pr merge * --squash)","rows":["pr-merge-green"],"added":"2026-01-01"}]}\n' > "$C/harness-rules.json"

out="$("$SH" "$S/../install.sh" </dev/null 2>&1)"
# shellcheck disable=SC2034  # rc and summary are read inside check's eval strings
rc=$?
# shellcheck disable=SC2034
summary="$(printf '%s\n' "$out" | sed -n '/^Skipped (no terminal)/,/^Next:/p')"
check "install.sh exits 0" '[ $rc -eq 0 ]'
check "summary has a Skipped (no terminal) block with the count" \
  '[[ "$summary" == "Skipped (no terminal): 9 prompt(s)"* ]]'
for q in "Make one real codex call to prove it can answer?" \
         "Register the attribution hook in ~/.claude/settings.json (backed up first)?" \
         "Register the update notice in ~/.claude/settings.json (backed up first)?" \
         "Register the context handoff in ~/.claude/settings.json (backed up first)?" \
         "Add the always-on deny rules to ~/.claude/settings.json (backed up first)?" \
         "Install the missing plugins now, user scope?" \
         "Register desk's Playwright MCP as your user-level playwright server?" \
         "List skills by name only in ~/.claude/settings.json (backed up first)?" \
         "Install claude-statusline (settings.json backed up first)?"; do
  check "listed: $q" '[[ "$summary" == *"  SKIP  $q"* ]]'
done
check "every skip line is followed by an apply line" \
  '[ "$(printf "%s\n" "$summary" | grep -c "^  SKIP  ")" = "$(printf "%s\n" "$summary" | grep -c "^        apply: ")" ]'
check "codex skip carries the real call" '[[ "$summary" == *"apply: codex exec --sandbox read-only"* ]]'
check "deny-rule skip carries the harness-rules command" '[[ "$summary" == *"harness-rules.py\" --settings"*"baseline"* ]]'
check "plugin skip names each plugin install" '[[ "$summary" == *"claude plugin install vercel@claude-plugins-official --scope user"* ]]'
check "the playwright plugin is no longer installed" '[[ "$summary" != *"install playwright@claude-plugins-official"* ]]'
# Claude's browser is a user-level server on desk's pinned MCP, loading the one saved login.
# shellcheck disable=SC2034  # mcp and LOGIN are read inside check's eval strings
mcp="$(printf '%s\n' "$summary" | sed -n "s/.*claude mcp add-json --scope user playwright '\(.*\)'$/\1/p" | head -n 1)"
# shellcheck disable=SC2034
LOGIN="$HOME/.cache/ms-playwright-mcp/desk-profile.github-session.json"
check "the MCP skip carries the user-level add-json" '[ -n "$mcp" ]'
check "the MCP runs desk's pinned @playwright/mcp on desk's browsers" \
  '[ "$(printf "%s" "$mcp" | jq -r ".args[0]")" = "$PW/node_modules/@playwright/mcp/cli.js" ] && [ "$(printf "%s" "$mcp" | jq -r .env.PLAYWRIGHT_BROWSERS_PATH)" = "$PW/browsers" ]'
check "the MCP is isolated on the saved login" \
  '[ "$(printf "%s" "$mcp" | jq -c ".args[1:]")" = "[\"--browser\",\"chromium\",\"--isolated\",\"--storage-state\",\"$LOGIN\"]" ]'
check "an empty owner-only login is in place before the first sign-in" \
  '[ "$(jq -c . "$LOGIN")" = "{\"cookies\":[],\"origins\":[]}" ] && [ "$(stat -c %a "$LOGIN" 2>/dev/null || stat -f %Lp "$LOGIN")" = 600 ]'
check "a hook skip says to re-run in a terminal" \
  '[[ "$summary" == *"attribution hook"*$'"'"'\n'"'"'"        apply: run in a terminal: cd "* ]]'
check "a repo's recorded unpinned merge allow is retired and reported" \
  '[[ "$out" == *"RETIRED  allow Bash(gh pr merge * --squash)"* ]] && ! grep -q -- "--squash)" "$R/.claude/settings.local.json" && ! grep -q "gh pr merge" "$C/harness-rules.json"'
check "the repo's settings are backed up before the retire" 'grep -q -- "--squash)" "$R"/.claude/settings.local.json.bak-desk-*'
check "an unpinned merge allow the user added is reported and kept" \
  '[[ "$out" == *"retired  allow Bash(gh pr merge * --rebase)  (yours"* ]] && grep -q -- "--rebase)" "$R/.claude/settings.local.json"'
check "nothing was written to settings.json" '[ ! -f "$HOME/.claude/settings.json" ] || ! grep -q desk-update-check "$HOME/.claude/settings.json"'
# A new shell runs desk-q from any directory, and it finds the repo set up above.
# shellcheck disable=SC2034  # q_out is read inside check's eval string
q_out="$(cd / && unset DESK_HOME DESK_MACHINE && PATH="$HOME/.local/bin:$PATH" desk-q --plain --all 2>&1)"
check "desk-q is on PATH and runs from any directory" \
  '[ -x "$HOME/.local/bin/desk-q" ] && [[ "$q_out" == "● "* ]] && [[ "$q_out" == *"desk-q · "* ]] && [[ "$q_out" == *"  r  "*"no batch"* ]]'

echo; echo "$PASS/$((PASS+FAIL)) checks passed"; [ "$FAIL" = 0 ]
