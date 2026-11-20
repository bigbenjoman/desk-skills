#!/usr/bin/env bash
# suite: install.sh with no terminal (every skipped prompt listed)
# covers: skills/** vendor/** agents/** commands/**
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
# The repo ships its own desk-kiss, which the install also links at user level: a shadowed pair.
mkdir -p "$R/.claude/skills/desk-kiss"; printf -- '---\nname: desk-kiss\n---\nthe repo copy\n' > "$R/.claude/skills/desk-kiss/SKILL.md"

# retired local CI runner: a desk installed while it shipped one, with its scripts, shim, state and
# launchd jobs, each of which the install removes.
VM=desk-runner
OLD=("$HOME/.claude/desk/bin/$VM" "$HOME/.claude/desk/bin/runner-slot.sh" "$HOME/.claude/desk/bin/runner-probe.sh"
  "$HOME/.claude/desk/bin/mem-turns.mjs" "$HOME/.local/bin/$VM" "$HOME/.claude/desk/runner" "$HOME/.claude/desk/memory-turns"
  "$HOME/Library/LaunchAgents/com.desk-skills.$VM.plist" "$HOME/Library/LaunchAgents/com.desk-skills.$VM.nightly.plist")
# end retired local CI runner
mkdir -p "$HOME/.claude/desk/bin" "$HOME/.local/bin" "$HOME/Library/LaunchAgents"
for f in "${OLD[@]}"; do case "$f" in */runner|*/memory-turns) mkdir -p "$f" ;; *) touch "$f" ;; esac; done
printf '#!/bin/sh\necho "$@" >> "%s/launchctl.calls"\nexit 1\n' "$T" > "$T/bin/launchctl"; chmod +x "$T/bin/launchctl"
# Its VM runs outside launchd, so the old tool's own down is what stops it.
# Tart holds the runner's VM and its base image by tag and by digest (deleting the tag takes the
# digest with it), beside a VM and an image that are not the runner's. TART_REFUSE names one it won't delete.
TV="$T/tart.vms"
cat > "$T/bin/tart" <<EOF
#!/bin/sh
case "\$1" in
  list) echo "Source Name Disk Size Accessed State"; cat "$TV" ;;
  delete) echo "\$2" >> "$T/tart.deletes"
    grep -qx "[a-zA-Z]* \$2" "$TV" || exit 1
    [ "\$2" = "\${TART_REFUSE:-}" ] && exit 1
    grep -vx "[a-zA-Z]* \$2" "$TV" > "$TV.n"; mv "$TV.n" "$TV"
    case "\$2" in *:24.04) grep -v "ubuntu@" "$TV" > "$TV.n"; mv "$TV.n" "$TV" ;; esac ;;
esac
exit 0
EOF
chmod +x "$T/bin/tart"
printf '%s\n' "local $VM" "local my-vm" "OCI ghcr.io/cirruslabs/ubuntu:24.04" \
  "OCI ghcr.io/cirruslabs/ubuntu@sha256:94dbb9c4" "OCI ghcr.io/cirruslabs/macos-sonoma-base:latest" > "$TV"
printf '#!/bin/sh\necho "$@" >> "%s/runner.calls"\n' "$T" > "$HOME/.claude/desk/bin/$VM"; chmod +x "$HOME/.claude/desk/bin/$VM"
left(){ for f in "${OLD[@]}"; do [ -e "$f" ] && echo "$f"; done; }
# A script an earlier install put in desk/bin that the repo no longer has, beside one desk never installed.
mkdir -p "$HOME/.agents/.desk-pristine/.claude/desk/bin"
echo old > "$HOME/.claude/desk/bin/retired-tool.mjs"; echo old > "$HOME/.agents/.desk-pristine/.claude/desk/bin/retired-tool.mjs"
echo mine > "$HOME/.claude/desk/bin/my-own.sh"

# --any-branch: this checkout is a feature branch, or CI's detached merge commit (the guard: test_installed.sh).
# No git protocol allowed: the guard's fetch never reaches the network or this checkout's origin refs.
out="$(GIT_ALLOW_PROTOCOL=none "$SH" "$S/../install.sh" --any-branch </dev/null 2>&1)"
# shellcheck disable=SC2034  # rc and summary are read inside check's eval strings
rc=$?
# shellcheck disable=SC2034
summary="$(printf '%s\n' "$out" | sed -n '/^Skipped (no terminal)/,/^Next:/p')"
check "install.sh exits 0" '[ $rc -eq 0 ]'
check "summary has a Skipped (no terminal) block with the count" \
  '[[ "$summary" == "Skipped (no terminal): 10 prompt(s)"* ]]'
for q in "Make one real codex call to prove it can answer?" \
         "Register the attribution hook in ~/.claude/settings.json (backed up first)?" \
         "Register the update notice in ~/.claude/settings.json (backed up first)?" \
         "Register the context handoff in ~/.claude/settings.json (backed up first)?" \
         "Set compaction mode in ~/.claude/settings.json (backed up first)?" \
         "Add the always-on deny rules to ~/.claude/settings.json (backed up first)?" \
         "Install the missing plugins now, user scope?" \
         "Register desk's Playwright MCP as your user-level playwright server?" \
         "List skills by name only in ~/.claude/settings.json (backed up first)?" \
         "Install claude-statusline (settings.json backed up first)?"; do
  check "listed: $q" '[[ "$summary" == *"  SKIP  $q"* ]]'
done
# #736: each skip names its prompt's id, and a hook registration's apply line works with no terminal.
check "#736 a skip names its id" '[[ "$summary" == *"  SKIP  Make one real codex call to prove it can answer? (--accept=codex-call)"* ]]'
check "#736 a hook registration's apply line is the install with its id accepted" \
  '[[ "$summary" == *"(--accept=hook-attribution)"*"apply: cd "*"./install.sh --accept=hook-attribution"* ]]'
# #738: a user-level skill shadowing a configured repo's own copy is warned of and listed in the summary.
check "#738 the repo's line warns of both user-level paths of the shadowed skill" '[[ "$out" == *"WARN  o__r: 2 user-level skill path(s) shadow a skill this repo ships"* ]]'
check "#738 the summary lists the pair, with the repo's slug" \
  '[[ "$summary" == *"Shadowed: "*"  o__r: "*"skills/desk-kiss"*"shadows the repo copy at .claude/skills/desk-kiss"* ]]'
check "every skip line is followed by an apply line" \
  '[ "$(printf "%s\n" "$summary" | grep -c "^  SKIP  ")" = "$(printf "%s\n" "$summary" | grep -c "^        apply: ")" ]'
check "DS-224 AC6: with nothing running, the summary says so in one line" \
  '[ "$(printf "%s\n" "$summary" | grep -c "nothing to restart: no merge driver or supervisor agent is running")" = 1 ]'
check "DS-224 AC4: the install records the commit it was installed from" \
  'grep -q "\"commit\": \"$(git -C "$S/.." rev-parse HEAD)\"" "$HOME/.claude/desk/installed.json"'
check "DS-271 AC6: the running VM is stopped before its tools are removed" '[ "$(cat "$T/runner.calls")" = down ]'
check "DS-271 AC6: the retired runner's scripts, shim, state and plists are removed" '[ -z "$(left)" ]'
check "DS-271 AC6: its launchd jobs are unloaded" \
  '[ "$(grep -c "^bootout gui/[0-9]*/com.desk-skills.$VM" "$T/launchctl.calls")" = 2 ]'
check "DS-271 AC6: the install says so in one line" \
  '[ "$(printf "%s\n" "$out" | grep -c "ok    removed the local CI runner:")" = 1 ]'
check "DS-428 AC1, AC2: the runner VM and its base image are deleted and named in that line" \
  '[ "$(printf "%s\n" "$out" | grep -c "ok    removed the local CI runner:.* $VM ghcr.io/cirruslabs/ubuntu:24.04$")" = 1 ]'
check "DS-428 AC2: Tart keeps only what is not the runner's, with no warning" \
  '[ "$(cat "$TV")" = "$(printf "local my-vm\nOCI ghcr.io/cirruslabs/macos-sonoma-base:latest")" ] && ! printf "%s\n" "$out" | grep -q "Tart image"'
# The Tart purge on its own, for the states a full install run does not reach.
eval "$(sed -n '/^purge_runner_tart() {/,/^}/p' "$S/../install.sh")"
has(){ command -v "$1" >/dev/null 2>&1; }
warn(){ echo "WARN $1"; }
printf 'local my-vm\n' > "$TV"; : > "$T/tart.deletes"
# shellcheck disable=SC2034  # w is read inside check's eval strings
w="$(purge_runner_tart)"; purge_runner_tart >/dev/null
check "DS-428 AC3: with neither in Tart, nothing is deleted or named" \
  '[ -z "$RUNNER_TART_GONE$w" ] && [ ! -s "$T/tart.deletes" ]'
printf 'local %s\n' "$VM" > "$TV"
# shellcheck disable=SC2034
w="$(TART_REFUSE=$VM purge_runner_tart)"
check "DS-428 AC5: a delete that fails is a warning naming the command, and the VM is kept" \
  '[ "$w" = "WARN the retired local CI runner'"'"'s Tart image $VM was not deleted: tart delete $VM" ] && grep -qx "local $VM" "$TV"'
: > "$T/tart.deletes"
# shellcheck disable=SC2034
w="$(PATH=/usr/bin:/bin; purge_runner_tart; echo "gone=$RUNNER_TART_GONE")"
check "DS-428 AC4: with no tart on PATH, nothing is called or named" \
  '[ "$w" = "gone=" ] && [ ! -s "$T/tart.deletes" ] && grep -qx "local $VM" "$TV"'
check "DS-760 AC3: a script the repo no longer has is removed, and the install names it" \
  '[ ! -e "$HOME/.claude/desk/bin/retired-tool.mjs" ] && printf "%s\n" "$out" | grep -qx "  ok    removed ~/.claude/desk/bin/retired-tool.mjs (no longer in desk)"'
check "DS-760 AC5: a file desk never installed is left alone" '[ "$(cat "$HOME/.claude/desk/bin/my-own.sh")" = mine ]'
check "DS-340 AC1: every file under desk/templates is installed, dotfiles included" \
  '[ -n "$(find "$S/../desk/templates" -type f)" ] && [ -z "$(cd "$S/../desk/templates" && find . -type f | while read -r f; do cmp -s "$f" "$HOME/.claude/desk/templates/$f" || echo "$f"; done)" ]'
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
check "a hook skip's apply line runs the install with its id accepted, no terminal needed" \
  '[[ "$summary" == *"attribution hook"*$'"'"'\n'"'"'"        apply: cd "*"&& ./install.sh --accept=hook-attribution"* ]]'
check "a repo's recorded unpinned merge allow is retired and reported" \
  '[[ "$out" == *"RETIRED  allow Bash(gh pr merge * --squash)"* ]] && ! grep -q -- "--squash)" "$R/.claude/settings.local.json" && ! grep -q "gh pr merge" "$C/harness-rules.json"'
check "the repo's settings are backed up before the retire" 'grep -q -- "--squash)" "$R"/.claude/settings.local.json.bak-desk-*'
check "an unpinned merge allow the user added is reported and kept" \
  '[[ "$out" == *"retired  allow Bash(gh pr merge * --rebase)  (yours"* ]] && grep -q -- "--rebase)" "$R/.claude/settings.local.json"'
check "nothing was written to settings.json" '[ ! -f "$HOME/.claude/settings.json" ] || ! grep -q desk-update-check "$HOME/.claude/settings.json"'
# #734: a skill folder of the user's own where a vendored skill goes, which desk never installed (no
# pristine copy), on an install with no terminal: moving it is asked and skipped, and it stays.
rm -rf "$HOME/.agents/skills/ui-designer" "$HOME/.agents/.desk-pristine/.agents/skills/ui-designer" "$HOME/.claude/skills/ui-designer"
mkdir -p "$HOME/.claude/skills/ui-designer"; echo mine > "$HOME/.claude/skills/ui-designer/SKILL.md"
# shellcheck disable=SC2034  # own_out is read inside check's eval strings
own_out="$(GIT_ALLOW_PROTOCOL=none "$SH" "$S/../install.sh" --any-branch </dev/null 2>&1)"
check "#734 moving a skill folder desk did not install is asked, saying it differs, and skipped with no terminal" \
  '[[ "$own_out" == *"~/.claude/skills/ui-designer is a skill folder desk did not install (yours, or another tool'"'"'s); it differs from desk'"'"'s"* ]] && [[ "$own_out" == *"  SKIP  Move your ~/.claude/skills/ui-designer to the backup and install desk'"'"'s ui-designer in its place?"* ]]'
check "#734 the folder stays where it was, and desk's copy is not installed beside it" \
  '[ ! -L "$HOME/.claude/skills/ui-designer" ] && [ "$(cat "$HOME/.claude/skills/ui-designer/SKILL.md")" = mine ] && [ ! -e "$HOME/.agents/skills/ui-designer" ] && [[ "$own_out" != *"moved    ~/.claude/skills/ui-designer"* ]]'

# A new shell runs desk-q from any directory, and it finds the repo set up above.
# shellcheck disable=SC2034  # q_out is read inside check's eval string
q_out="$(cd / && unset DESK_HOME DESK_MACHINE && PATH="$HOME/.local/bin:$PATH" desk-q --plain --all 2>&1)"
check "desk-q is on PATH and runs from any directory" \
  '[ -x "$HOME/.local/bin/desk-q" ] && [[ "$q_out" == "◆ "* ]] && [[ "$q_out" == *" workers running │ "* ]] && [[ "$q_out" == *"  r  "*"no batch"* ]]'

# #733: another tool's hook script of the same name, which desk never installed (no pristine copy), on
# an install with no terminal: replacing it is asked and skipped, the file kept, and it is not registered.
rm -f "$HOME/.agents/.desk-pristine/.claude/hooks/deny-ai-attribution.py"
printf '#!/usr/bin/env python3\n# theirs\n' > "$HOME/.claude/hooks/deny-ai-attribution.py"
out="$(GIT_ALLOW_PROTOCOL=none "$SH" "$S/../install.sh" --any-branch </dev/null 2>&1)"
summary="$(printf '%s\n' "$out" | sed -n '/^Skipped (no terminal)/,/^Next:/p')"
check "#733 replacing another tool's hook script is asked, and skipped with no terminal" \
  '[[ "$summary" == *"  SKIP  Replace your ~/.claude/hooks/deny-ai-attribution.py with desk'"'"'s (yours is backed up first)?"* ]]'
check "#733 the file is kept, and the install says so" \
  '[ "$(sed -n 2p "$HOME/.claude/hooks/deny-ai-attribution.py")" = "# theirs" ] && [[ "$out" == *"kept your ~/.claude/hooks/deny-ai-attribution.py"* ]]'
check "#733 a kept hook script is not registered or described as desk's" \
  '[[ "$summary" != *"Register the attribution hook"* ]] && [[ "$out" == *"registration left as it is: the hook script there is yours"* ]] && [[ "$out" != *"Aimed at a repo whose desk config"* ]]'

# --accept and --decline answer the prompts they name with no terminal; an unknown id is a warning.
rm -f "$HOME/.claude/hooks/deny-ai-attribution.py"
acc_out="$(GIT_ALLOW_PROTOCOL=none "$SH" "$S/../install.sh" --any-branch --accept=hook-attribution --decline=plugins --accept=no-such-prompt </dev/null 2>&1)"
# shellcheck disable=SC2034  # acc_summary is read inside check's eval strings
acc_summary="$(printf '%s\n' "$acc_out" | sed -n '/^Skipped (no terminal)/,/^Next:/p')"
check "#736 an accepted prompt is applied with no terminal" \
  '[[ "$acc_out" == *"Register the attribution hook in ~/.claude/settings.json (backed up first)? [y/N] y (--accept=hook-attribution)"* ]] && grep -q deny-ai-attribution.py "$HOME/.claude/settings.json"'
check "#736 a declined prompt is answered no and not listed as skipped" \
  '[[ "$acc_out" == *"(--decline=plugins)"* ]] && [[ "$acc_summary" != *"Install the missing plugins now"* ]]'
check "#736 an unknown id is a warning naming it" '[[ "$acc_out" == *"no prompt has the id \"no-such-prompt\""* ]]'

# #828: the repo-config count of unanswered fields reads each row's value, not its note, and leaves
# out the rows the template keeps `TODO` to follow the machine profile.
eval "$(sed -n '/^unanswered_rows() {/,/^}/p' "$S/../install.sh")"
cat > "$T/uc.md" <<'UEOF'
| Field | Recommended | Your setting |
|---|---|---|
| Autopilot worker concurrency | `2 / 3` (default / cap) | `TODO` |
| Memory ceiling for parallel work (GB) | WSL: `16` | `TODO` (a note) |
| Test worker cap under the test lock | `4` | `TODO` |
| Triage concurrency | `1` | `3` (how many at once; left `TODO` it is 1) |
| Intake query | `none` | `TODO` (a Jira query) |
| `pr-open` | Open a PR | `yes` | `TODO` |
Left `TODO` or absent, each falls back to the machine profile.
UEOF
check "#828 only a value of TODO counts: not a note's, not the rows that follow the machine profile, not prose" '[ "$(unanswered_rows "$T/uc.md")" = 2 ]'

echo; echo "$PASS/$((PASS+FAIL)) checks passed"; [ "$FAIL" = 0 ]
