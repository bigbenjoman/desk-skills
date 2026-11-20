#!/usr/bin/env bash
# Seed git-ignored env files into a worktree.
#
# Worktrees are git *linked worktrees*, so we can locate the developer's primary
# checkout portably (no hardcoded user paths) via the shared git common dir.
# Env files are git-ignored and therefore absent in a fresh worktree, and an
# install step (config §4 Install) can hard-fail without them, so this must run
# before the install. Run it from inside the worktree.
#
# A bench checkout is a repository of its own, so setup-worktree.sh names the primary checkout in
# DESK_ENV_FROM.
#
# Which files: config §4 "Env files", one backtick span per repo-relative path (never split on
# commas or spaces), or `none`. Unset is refused rather than guessed.
#
# --base, for a batch base's worktree (base-sync.mjs): a file already there is left as it is, and one
# git does not ignore is never copied, since the base sync refuses a worktree with changes.
set -euo pipefail
BASE_MODE=
[ "${1:-}" != --base ] || BASE_MODE=1

# shellcheck source=desk-env.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/desk-env.sh"

# Absolute path to the primary repo's shared .git, then its parent = repo root.
main_git_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
main_root="${DESK_ENV_FROM:-$(dirname "$main_git_dir")}"

if ! files="$(node "$DESK_ENV_MJS" list env-files 2>/dev/null)"; then
  echo "[copy-env] FAIL: config §4 \"Env files\" is not set — run /desk-setup (write \`none\` if the repo needs none). Refusing to guess." >&2
  exit 1
fi
case "$(printf '%s' "$files" | head -1 | tr 'A-Z' 'a-z')" in
  none|none\ *) echo "[copy-env] config §4 Env files is none — nothing to copy"; exit 0 ;;
esac

missing=0
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  case "/$rel/" in
    //*|*/../*) echo "[copy-env] refusing '$rel': env files must be repo-relative, without .." >&2; missing=1; continue ;;
  esac
  src="$main_root/$rel"
  if [ -n "$BASE_MODE" ] && [ -e "$rel" ]; then continue; fi
  if [ -n "$BASE_MODE" ] && ! git check-ignore -q --no-index "$rel"; then
    echo "[copy-env] not copying '$rel': git does not ignore it" >&2; missing=1; continue
  fi
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
done <<EOF_FILES
$files
EOF_FILES

exit "$missing"
