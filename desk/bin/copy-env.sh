#!/usr/bin/env bash
# Seed git-ignored env files into a worktree.
#
# Worktrees are git *linked worktrees*, so we can locate the developer's primary
# checkout portably (no hardcoded user paths) via the shared git common dir.
# Env files are git-ignored and therefore absent in a fresh worktree, and an
# install step (config §4 Install) can hard-fail without them, so this must run
# before the install. Run it from inside the worktree.
#
# Which files: config §4 "Env files" — repo-relative paths in ONE backtick span,
# separated by commas and/or spaces (e.g. `apps/web/.env, apps/api/.env.local`),
# or `none`. Unset is refused rather than guessed.
set -euo pipefail

# shellcheck source=desk-env.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/desk-env.sh"

# Absolute path to the primary repo's shared .git, then its parent = repo root.
main_git_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
main_root="$(dirname "$main_git_dir")"

if ! files="$(desk_cfg env-files 2>/dev/null)"; then
  echo "[copy-env] FAIL: config §4 \"Env files\" is not set — run /desk-setup (write \`none\` if the repo needs none). Refusing to guess." >&2
  exit 1
fi
case "$(printf '%s' "$files" | tr 'A-Z' 'a-z')" in
  none|none\ *) echo "[copy-env] config §4 Env files is none — nothing to copy"; exit 0 ;;
esac

missing=0
set -f   # the list is paths, not globs
for rel in $(printf '%s' "$files" | tr ',;' '  '); do
  case "$rel" in
    /*|*..*) echo "[copy-env] refusing '$rel': env files must be repo-relative, without .." >&2; missing=1; continue ;;
  esac
  src="$main_root/$rel"
  if [ -f "$src" ]; then
    if [ "$src" -ef "$rel" ]; then
      echo "[copy-env] $rel already in place (running from the primary checkout)"
      continue
    fi
    mkdir -p "$(dirname "$rel")"
    cp "$src" "$rel"
    echo "[copy-env] $rel"
  else
    echo "[copy-env] MISSING: $src — create it in your primary checkout" >&2
    missing=1
  fi
done
set +f

exit "$missing"
