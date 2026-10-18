#!/usr/bin/env bash
# Tests the status line as a pinned tool (DS-34): `skills-upstream outdated` reports it, `upgrade` moves
# only its pin, `statusline install` runs the repo's own installer at the pin, and install.sh's section
# asks before installing and never replaces another statusLine command on --yes. Against a scratch
# desk-skills tree, a throwaway HOME and a stub gh serving a fake upstream; no network.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME/.claude"
PASS=0; FAIL=0; rc=0; out=""
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     rc=$rc out: $out"; fi; }

PIN=8eeb631906d7a6214b2c006abd613bd6b08d1e72
NEW=1234567890abcdef1234567890abcdef12345678
R="$T/src"; mkdir -p "$R/bin" "$R/vendor"
cp "$S/../bin/skills-upstream" "$R/bin/"
cat > "$R/vendor/sources.json" <<J
{"skills": {},
 "tools": {"claude-statusline": {"source": {"type": "github", "repo": "bigbenjoman/claude-statusline", "path": "",
   "installer": "install-statusline.sh"}, "pin": {"commit": "${PIN:0:9}", "date": "2026-08-15"}}}}
J

# The fake upstream: an installer that, like the real one, copies the script beside it into ~/.claude
# and merges statusLine into settings.json after a .bak.
UP="$T/upstream"; mkdir -p "$UP"
printf '#!/usr/bin/env bash\necho statusline\n' > "$UP/statusline-command.sh"
cat > "$UP/install-statusline.sh" <<'EOF'
set -e
cp statusline-command.sh "$HOME/.claude/statusline-command.sh"
s="$HOME/.claude/settings.json"; [ -f "$s" ] && cp "$s" "$s.bak-statusline"
python3 - "$s" <<'PY'
import json, os, sys
p = sys.argv[1]
d = json.load(open(p)) if os.path.exists(p) else {}
d["statusLine"] = {"type": "command", "command": "bash ~/.claude/statusline-command.sh"}
json.dump(d, open(p, "w"))
PY
EOF

# Stub gh: newest commit $LATEST (default the pin), the tree and the file contents of the upstream.
mkdir -p "$T/bin"
cat > "$T/bin/gh" <<EOF
#!/usr/bin/env bash
[ "\$1" = api ] || exit 1
latest="\${LATEST:-$PIN}"
case "\$2" in
  repos/bigbenjoman/claude-statusline/commits\?per_page=1) printf '%s\t2026-10-01\tNewer thing\n' "\$latest" ;;
  repos/bigbenjoman/claude-statusline/commits\?per_page=100) printf '%s\n' "\$latest" $PIN ;;
  repos/bigbenjoman/claude-statusline/git/trees/*)
    echo "\$2" >> "$T/fetched"
    printf '{"tree":[{"path":"install-statusline.sh","type":"blob"},{"path":"statusline-command.sh","type":"blob"}]}\n' ;;
  repos/bigbenjoman/claude-statusline/contents/*)
    f="\${2#repos/bigbenjoman/claude-statusline/contents/}"; base64 < "$UP/\${f%%\\?*}" | tr -d '\n'; echo ;;
  *) exit 1 ;;
esac
EOF
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH"
U(){ out=$(python3 "$R/bin/skills-upstream" "$@" 2>&1); rc=$?; }

# AC1: tracked with its repo and pin, and reported when the repo has newer commits.
U list
check "list shows the tool with its repo and pin" '[[ "$out" == *"claude-statusline"*"tool"*"bigbenjoman/claude-statusline  @ ${PIN:0:9}"* ]]'
U outdated
check "at the pin: ok, exit 0" '[ $rc -eq 0 ] && [[ "$out" == "ok       claude-statusline"* ]]'
export LATEST=$NEW
U outdated
check "newer commit: OUTDATED with one newer commit, exit 10" \
  '[ $rc -eq 10 ] && [[ "$out" == *"OUTDATED claude-statusline"*"latest ${NEW:0:9} (2026-10-01) Newer thing  (1 newer commit)"* ]]'
U outdated --json
check "json carries the whole-repo source" '[[ "$out" == *"\"source\": \"github:bigbenjoman/claude-statusline\""* ]]'

# AC2 (local check), AC5 (another command): nothing installed yet.
U statusline check
check "check: not installed is exit 1" '[ $rc -eq 1 ] && [[ "$out" == "not installed"* ]]'
U statusline other
check "other: no settings.json is exit 1" '[ $rc -eq 1 ]'
printf '{"statusLine":{"type":"command","command":"~/mine.sh"},"keep":1}\n' > "$HOME/.claude/settings.json"
U statusline other
check "other: a foreign command is printed, exit 0" '[ $rc -eq 0 ] && [ "$out" = "~/mine.sh" ]'
printf '{"statusLine":{"type":"command","command":"bash /opt/custom/statusline-command.sh"}}\n' > "$HOME/.claude/settings.json"
U statusline other
check "other: the same file name at another path is foreign" '[ $rc -eq 0 ] && [ "$out" = "bash /opt/custom/statusline-command.sh" ]'
printf '{not json' > "$HOME/.claude/settings.json"
U statusline other
check "other: invalid settings.json is exit 2" '[ $rc -eq 2 ]'
rm -f "$HOME/.claude/settings.json"
echo mine > "$HOME/.claude/statusline-command.sh"
U statusline other
check "other: a script desk did not install, with no statusLine, is foreign" \
  '[ $rc -eq 0 ] && [[ "$out" == "~/.claude/statusline-command.sh (a script desk did not install)" ]]'
rm -f "$HOME/.claude/statusline-command.sh"

# install.sh's section, run on its own with the installer's helpers and --yes, no terminal.
SECTION="$T/section.sh"
{ sed -n '/^section() {/,/^show_err() {/p' "$S/../install.sh"
  sed -n '/^have_tty() {/,/^}/p' "$S/../install.sh"
  sed -n '/^SKIPPED=""/,/^IN_TERMINAL=/p' "$S/../install.sh"
  sed -n '/^confirm() {/,/^}/p' "$S/../install.sh"
  sed -n '/^section "Status line/,/^# -----/p' "$S/../install.sh"
  echo 'printf "SKIPPED=%s\n%s" "$SKIPPED_N" "$SKIPPED"'; } > "$SECTION"
check "the status line section is found in install.sh" 'grep -q "statusline install" "$SECTION"'
I(){ out=$(SRC="$R" SETTINGS="$HOME/.claude/settings.json" TS=t YES="$1" WARNINGS=0 bash -c '. "$0"' "$SECTION" </dev/null 2>&1); rc=$?; }

printf '{"statusLine":{"type":"command","command":"~/mine.sh"},"keep":1}\n' > "$HOME/.claude/settings.json"
I 1
check "AC5: another command is reported" '[[ "$out" == *"not one desk installed: ~/mine.sh"* ]]'
check "AC5: --yes does not replace it; the question is skipped and listed" \
  '[[ "$out" == *"skip  Replace your statusLine command with claude-statusline"* ]] && [[ "$out" == *"SKIPPED=1"* ]]'
check "AC5: settings.json and the script are untouched" \
  'grep -q "mine.sh" "$HOME/.claude/settings.json" && [ ! -e "$HOME/.claude/statusline-command.sh" ]'

# The user's own script at the very path claude-statusline uses, never installed by desk.
echo mine > "$HOME/.claude/statusline-command.sh"
printf '{"statusLine":{"type":"command","command":"bash ~/.claude/statusline-command.sh"}}\n' > "$HOME/.claude/settings.json"
I 1
check "AC5: an unrecorded script at the same path is reported, and --yes does not replace it" \
  '[[ "$out" == *"not one desk installed: bash ~/.claude/statusline-command.sh"* ]] && [[ "$out" == *"skip  Replace your statusLine command"* ]] && [ "$(cat "$HOME/.claude/statusline-command.sh")" = mine ]'
rm -f "$HOME/.claude/statusline-command.sh"

rm -f "$HOME/.claude/settings.json"; printf '{"keep":1}\n' > "$HOME/.claude/settings.json"
I 0
check "AC2: no terminal skips the install, with its apply line" \
  '[[ "$out" == *"skip  Install claude-statusline (settings.json backed up first)?"* ]] && [[ "$out" == *"apply: cp -p"*"skills-upstream\" statusline install"* ]] && [ ! -e "$HOME/.claude/statusline-command.sh" ]'
unset LATEST
I 1
check "AC2: on yes it backs up settings.json, then installs at the pin" \
  '[ -f "$HOME/.claude/settings.json.bak-desk-t" ] && [[ "$out" == *"installed claude-statusline ${PIN:0:9}"* ]] && grep -q "trees/${PIN:0:9}" "$T/fetched"'
check "AC2: the installer wrote the script and merged statusLine, keeping other keys" \
  '[ -f "$HOME/.claude/statusline-command.sh" ] && grep -q statusline-command.sh "$HOME/.claude/settings.json" && grep -q keep "$HOME/.claude/settings.json"'
U statusline check
check "check: at the pin after install, exit 0" '[ $rc -eq 0 ] && [[ "$out" == "installed at the pin"* ]]'
U statusline other
check "other: our own command is not foreign" '[ $rc -eq 1 ]'
I 0
check "a second run reports it current and asks nothing" '[[ "$out" == *"ok    claude-statusline installed at the pin"* ]] && [[ "$out" == *"SKIPPED=0"* ]]'

# AC3: upgrade moves only the pin; the installed copy is then behind it.
export LATEST=$NEW
U upgrade claude-statusline
check "upgrade moves the pin only" \
  '[ $rc -eq 0 ] && [[ "$out" == *"${PIN:0:9} -> ${NEW:0:9}"*"pin only"* ]] && [ "$(jq -r ".tools[\"claude-statusline\"].pin.commit" "$R/vendor/sources.json")" = "${NEW:0:9}" ] && [ ! -d "$R/vendor/claude-statusline" ]'
U statusline check
check "check: installed is behind the new pin, exit 1" '[ $rc -eq 1 ] && [[ "$out" == "installed ${PIN:0:9}, pinned ${NEW:0:9}"* ]]'
U statusline install
check "install fetches the new pin and records it" '[ $rc -eq 0 ] && grep -q "trees/${NEW:0:9}" "$T/fetched" && grep -q "${NEW:0:9}" "$HOME/.claude/desk/statusline.installed"'
check "the script it replaced was copied aside first" '[[ "$out" == *"backup: ~/.claude/statusline-command.sh.bak-desk-"* ]] && ls "$HOME"/.claude/statusline-command.sh.bak-desk-* >/dev/null'

echo; echo "$PASS/$((PASS+FAIL)) checks passed"; [ "$FAIL" = 0 ]
