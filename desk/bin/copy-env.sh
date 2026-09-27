#!/usr/bin/env bash
# Seed git-ignored env files into a worktree.
#
# Worktrees are git *linked worktrees*, so we can locate the developer's main
# checkout portably (no hardcoded user paths) via the shared git common dir.
# .env is git-ignored and therefore absent in a fresh worktree; `prisma generate`
# (run by `bun install`) hard-fails without DATABASE_URL, so this must run before
# the install. Run it from inside the worktree.
set -euo pipefail

# Absolute path to the main repo's shared .git, then its parent = repo root.
main_git_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
main_root="$(dirname "$main_git_dir")"

# Env files to mirror, relative to repo root. Add more here if needed.
rel_paths=(
  "packages/studia-web/.env"
)

missing=0
for rel in "${rel_paths[@]}"; do
  src="$main_root/$rel"
  if [ -f "$src" ]; then
    if [ "$src" -ef "$rel" ]; then
      echo "[copy-env] $rel already in place (running from main checkout)"
      continue
    fi
    mkdir -p "$(dirname "$rel")"
    cp "$src" "$rel"
    echo "[copy-env] $rel"
  else
    echo "[copy-env] MISSING: $src — create it in your main checkout" >&2
    missing=1
  fi
done

exit "$missing"
