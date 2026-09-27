#!/usr/bin/env bash
# Warns about user-level review-bar and pullbot copies. Only studia-web's own
# .agents/skills copy is supported, so each one found is named for the user to remove.
# Read-only: it never deletes or refreshes a copy, and never fetches.
#
#   user-skill-copies.sh [studia-web checkout]    exit 0 none found, 1 one or more found
set -uo pipefail

REPO="${1:-${DESK_REPO:-$HOME/code/studia-web}}"
note() { printf '        %s\n' "$1"; }
found=0

for name in review-bar pullbot; do
  for dir in "$HOME/.agents/skills" "$HOME/.claude/skills"; do
    path="$dir/$name"
    [ -e "$path" ] || [ -L "$path" ] || continue
    found=$((found + 1))
    shown="~/${path#"$HOME"/}"
    [ -L "$path" ] && shown="$shown -> $(readlink "$path")"
    printf '  WARN  user-level %s copy: %s\n' "$name" "$shown"

    sha=""
    if [ -f "$path/.source" ]; then
      sha="$(tr -s ' \t:=@' '\n' <"$path/.source" | grep -E '^[0-9a-f]{7,40}$' | head -n 1)"
    fi
    if [ -z "$sha" ]; then
      note "source: unpinned (no .source commit), so how far behind it is can't be pinned"
    elif behind="$(git -C "$REPO" rev-list --count "$sha..origin/main" -- ".agents/skills/$name" 2>/dev/null)"; then
      note "source: $sha, $behind commit(s) to .agents/skills/$name behind origin/main (as of your last fetch)"
    else
      note "source: $sha, which $REPO does not know, so how far behind it is can't be pinned"
    fi
  done
done

if [ "$found" -gt 0 ]; then
  note "Only studia-web's .agents/skills copy of review-bar and pullbot is supported. A user copy can"
  note "load in its place and review at an older bar than the pullbot-gate CI enforces."
  note "Remove each one above by hand (rm -r the directory, or rm the link); nothing refreshes it."
  exit 1
fi
exit 0
