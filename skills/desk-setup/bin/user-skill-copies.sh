#!/usr/bin/env bash
# Warns about user-level skills that shadow a skill this repo ships. A repo can carry its own skills
# in .agents/skills or .claude/skills (a review bar its CI enforces, say). A user-level copy with the
# same name under ~/.agents/skills or ~/.claude/skills can load in its place and run an older
# version, so each one found is named for the user to decide about.
# Read-only: it never deletes or refreshes a copy, and never fetches.
#
#   user-skill-copies.sh [repo checkout]    exit 0 none found, 1 one or more found
set -uo pipefail

REPO="${1:-${DESK_REPO_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}}"
note() { printf '        %s\n' "$1"; }
found=0

for repo_dir in "$REPO/.agents/skills" "$REPO/.claude/skills"; do
  [ -d "$repo_dir" ] || continue
  for skill in "$repo_dir"/*/; do
    [ -f "$skill/SKILL.md" ] || continue
    name="$(basename "$skill")"
    for dir in "$HOME/.agents/skills" "$HOME/.claude/skills"; do
      path="$dir/$name"
      [ -e "$path" ] || [ -L "$path" ] || continue
      # A user-level link that lands on the repo's own copy is not a shadow.
      [ "$(cd -P "$path" 2>/dev/null && pwd)" = "$(cd -P "$skill" 2>/dev/null && pwd)" ] && continue
      found=$((found + 1))
      shown="~/${path#"$HOME"/}"
      [ -L "$path" ] && shown="$shown -> $(readlink "$path")"
      printf '  WARN  user-level %s shadows the repo copy at %s\n' "$shown" "${skill#"$REPO"/}"
      if diff -rq "$path" "$skill" >/dev/null 2>&1; then
        note "identical to the repo copy today; it will drift the next time the repo's copy changes"
      else
        note "differs from the repo copy: whichever loads first decides which version runs"
      fi
    done
  done
done

if [ "$found" -gt 0 ]; then
  note "The repo's copy is the one its CI and teammates use. Remove each user-level copy above by"
  note "hand (rm -r the directory, or rm the link) if you want the repo's version to run here."
  exit 1
fi
exit 0
