#!/usr/bin/env bash
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

out="$("$SH" "$S/../install.sh" </dev/null 2>&1)"; rc=$?
summary="$(printf '%s\n' "$out" | sed -n '/^Skipped (no terminal)/,/^Next:/p')"
check "install.sh exits 0" '[ $rc -eq 0 ]'
check "summary has a Skipped (no terminal) block with the count" \
  '[[ "$summary" == "Skipped (no terminal): 7 prompt(s)"* ]]'
for q in "Make one real codex call to prove it can answer?" \
         "Register the attribution hook in ~/.claude/settings.json (backed up first)?" \
         "Register the update notice in ~/.claude/settings.json (backed up first)?" \
         "Register the context handoff in ~/.claude/settings.json (backed up first)?" \
         "Add the always-on deny rules to ~/.claude/settings.json (backed up first)?" \
         "Install the missing plugins now, user scope?" \
         "List skills by name only in ~/.claude/settings.json (backed up first)?"; do
  check "listed: $q" '[[ "$summary" == *"  SKIP  $q"* ]]'
done
check "every skip line is followed by an apply line" \
  '[ "$(printf "%s\n" "$summary" | grep -c "^  SKIP  ")" = "$(printf "%s\n" "$summary" | grep -c "^        apply: ")" ]'
check "codex skip carries the real call" '[[ "$summary" == *"apply: codex exec --sandbox read-only"* ]]'
check "deny-rule skip carries the harness-rules command" '[[ "$summary" == *"harness-rules.py\" --settings"*"baseline"* ]]'
check "plugin skip names each plugin install" '[[ "$summary" == *"claude plugin install playwright@claude-plugins-official --scope user"* ]]'
check "a hook skip says to re-run in a terminal" \
  '[[ "$summary" == *"attribution hook"*$'"'"'\n'"'"'"        apply: run in a terminal: cd "* ]]'
check "nothing was written to settings.json" '[ ! -f "$HOME/.claude/settings.json" ] || ! grep -q desk-update-check "$HOME/.claude/settings.json"'

echo; echo "$PASS/$((PASS+FAIL)) checks passed"; [ "$FAIL" = 0 ]
