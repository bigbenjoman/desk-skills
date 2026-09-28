#!/usr/bin/env bash
# Tests `skills-upstream links` (and its use by `verify` and `install.sh --check`) against a scratch
# desk-skills tree and a throwaway HOME. Nothing touches your real ~/.claude or ~/.agents.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; T="$(mktemp -d)"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1
: > "$GIT_CONFIG_GLOBAL"; git config --global user.email t@example.com; git config --global user.name t
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     rc=$rc out: $out"; fi; }

# A scratch desk-skills tree: one desk skill, one vendored skill, a single-skill checkout and a
# checkout with two sub-skills. skills-upstream finds its tree from its own path, so it is copied in.
R="$T/src"; mkdir -p "$R/bin" "$R/skills/desk-alpha" "$R/vendor/vend"
cp "$S/../bin/skills-upstream" "$S/../install.sh" "$R/bin/"; mv "$R/bin/install.sh" "$R/install.sh"
echo "# alpha" > "$R/skills/desk-alpha/SKILL.md"; echo "# vend" > "$R/vendor/vend/SKILL.md"
cat > "$R/vendor/sources.json" <<'J'
{"skills": {
  "vend": {"source": {"type": "github", "repo": "acme/vend", "path": "vend"}, "pin": {"commit": "abc1234", "date": "2026-01-01"}},
  "solo": {"source": {"type": "checkout", "repo": "acme/solo", "branch": "main"}},
  "multi": {"source": {"type": "checkout", "repo": "acme/multi", "branch": "main", "subskills": ["skills/one", "skills/two"]}}
}}
J
U(){ out=$(python3 "$R/bin/skills-upstream" "$@" 2>&1); rc=$?; }
U rehash

# What install.sh leaves behind in LINK_MODE=each: real copies in ~/.agents/skills (checkouts as git
# clones, sub-skills linked in from ~/.agents/sources), one link per skill in ~/.claude/skills.
A="$HOME/.agents/skills"; C="$HOME/.claude/skills"; mkdir -p "$A" "$C" "$HOME/.agents/sources"
cp -R "$R/skills/desk-alpha" "$R/vendor/vend" "$A/"
clone(){ git init -q "$1"; git -C "$1" remote add origin "https://github.com/$2"; mkdir -p "$1/$3"
         echo "# $3" > "$1/$3/SKILL.md"; git -C "$1" add -A; git -C "$1" commit -qm init; }
clone "$A/solo" acme/solo .
M="$HOME/.agents/sources/multi"; clone "$M" acme/multi skills/one; mkdir -p "$M/skills/two"; echo "# two" > "$M/skills/two/SKILL.md"
git -C "$M" add -A; git -C "$M" commit -qm two
ln -s "$M/skills/one" "$A/one"; ln -s "$M/skills/two" "$A/two"
for n in desk-alpha vend solo one two; do ln -sfn "$A/$n" "$C/$n"; done

U links
check "all five linked: exit 0" '[ $rc -eq 0 ] && [[ "$out" == *"5 skills: 5 reachable from ~/.claude/skills, 0 not"* ]]'
U verify
check "verify passes with every link present" '[ $rc -eq 0 ] && [[ "$out" == *"5 reachable"* ]]'

rm "$C/vend"
U links
check "missing vendored link: exit 1, named, fix given" '[ $rc -eq 1 ] && [[ "$out" == *"UNLINKED ~/.claude/skills/vend does not exist (vendor)"* ]] && [[ "$out" == *"fix: ln -sfn ~/.agents/skills/vend ~/.claude/skills/vend"* ]] && [[ "$out" == *"4 reachable"*"1 not"* ]]'
U verify
check "verify fails on the missing link too" '[ $rc -ne 0 ] && [[ "$out" == *"UNLINKED ~/.claude/skills/vend"* ]]'
out=$(cd "$R" && ./install.sh --check 2>&1); rc=$?
check "install.sh --check WARNs with the fix, still exit 0" '[ $rc -eq 0 ] && [[ "$out" == *"WARN  5 skills: 4 reachable"* ]] && [[ "$out" == *"fix: ln -sfn ~/.agents/skills/vend"* ]]'
eval "$(printf '%s\n' "$out" | grep -o 'ln -sfn ~/.agents/skills/vend ~/.claude/skills/vend' | sed "s|~|$HOME|g")"
U links
check "the printed fix restores it" '[ $rc -eq 0 ] && [ -L "$C/vend" ]'

rm "$C/desk-alpha" "$C/two"
U links
check "missing desk and sub-skill links both reported" '[ $rc -eq 1 ] && [[ "$out" == *"skills/desk-alpha does not exist (desk)"* ]] && [[ "$out" == *"skills/two does not exist (checkout multi)"* ]] && [[ "$out" == *"2 not"* ]]'
ln -sfn "$A/desk-alpha" "$C/desk-alpha"; ln -s "$T/nowhere" "$C/two"
U links
check "a dangling link is reported with the ln -sfn fix" '[ $rc -eq 1 ] && [[ "$out" == *"skills/two is a link that reaches no SKILL.md"* ]] && [[ "$out" == *"ln -sfn ~/.agents/skills/two"* ]]'
rm "$C/two"; mkdir "$C/two"
U links
check "a real folder in the way sends you to install.sh, not ln" '[ $rc -eq 1 ] && [[ "$out" == *"skills/two is a real folder"* ]] && [[ "$out" != *"ln -sfn ~/.agents/skills/two"* ]]'
rmdir "$C/two"; ln -sfn "$A/two" "$C/two"; rm -rf "$A/solo"; ln -sfn "$A/solo" "$C/solo"
U links
check "not installed at all: install.sh, not a link fix" '[ $rc -eq 1 ] && [[ "$out" == *"NOT INSTALLED  ~/.agents/skills/solo"* ]] && [[ "$out" != *"ln -sfn ~/.agents/skills/solo"* ]]'
clone "$A/solo" acme/solo .

# LINK_MODE=same: ~/.claude/skills IS ~/.agents/skills, so no per-skill links exist or are needed.
rm -rf "$C"; ln -s "$A" "$C"
U links
check "same mode: no per-skill links needed, exit 0" '[ $rc -eq 0 ] && [[ "$out" == *"5 reachable"*"no per-skill links are needed"* ]]'
rm "$A/one"
U links
check "same mode: a gap is NOT INSTALLED, never an ln fix" '[ $rc -eq 1 ] && [[ "$out" == *"NOT INSTALLED  ~/.agents/skills/one"* ]] && [[ "$out" != *"ln -sfn"* ]]'
ln -s "$M/skills/one" "$A/one"

# LINK_MODE=none: ~/.claude/skills does not resolve to a directory.
rm "$C"; ln -s "$T/nowhere" "$C"
U links
check "broken ~/.claude/skills: every skill unreachable, exit 1" '[ $rc -eq 1 ] && [[ "$out" == *"is not a directory"* ]] && [[ "$out" == *"0 reachable"*"5 not"* ]]'

rm -rf "$T"
echo; echo "$PASS passed, $FAIL failed"; [ $FAIL = 0 ]
