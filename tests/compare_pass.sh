#!/usr/bin/env bash
# Shows whether a change moved what pass.mjs does. Runs the base's pass shell suites twice, once
# against the base tree and once against the head tree, with the base's tests/ in both, so cases the
# head moved into a unit suite still run against it. A `node` shim first on PATH saves the queue and
# the pass's output after every pass.mjs run (compare_pass.mjs record), and the two runs are then
# listed side by side (compare_pass.mjs diff). Written for bash 3.2 as well as 4+.
#   bash tests/compare_pass.sh <base> [<head>]                  base and head: a git ref or a directory;
#                                                               head defaults to HEAD
#   bash tests/compare_pass.sh --suite test_pass.sh <base> ...  only that suite (repeatable); by default
#                                                               every tests/test_pass*.sh in the base
# Exit 0 when nothing differs, 1 when something does, 2 when a run was not compared (it ran on one tree
# only, or crashed on one only) or the trees could not be built.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"
suites=()
while [ $# -gt 0 ]; do
  case "$1" in
    --suite) [ $# -ge 2 ] || { echo "compare_pass: --suite needs a suite name" >&2; exit 2; }; suites+=("${2##*/}"); shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    -*) echo "compare_pass: unknown option $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] && [ $# -le 2 ] || { echo "usage: bash tests/compare_pass.sh [--suite <name>]... <base> [<head>]" >&2; exit 2; }
base=$1; head=${2:-HEAD}
NODE=$(command -v node) || { echo "compare_pass: node is not on PATH" >&2; exit 2; }
W="$(mktemp -d "${TMPDIR:-/tmp}/compare-pass.XXXXXX")" || exit 2
trap 'rm -rf "$W"' EXIT

# A tree from a directory (its files, without .git) or from a ref of this repo.
tree(){ mkdir -p "$2"
  if [ -d "$1" ]; then (cd "$1" && tar -cf - --exclude ./.git .) | tar -xf - -C "$2"
  else git -C "$SRC" rev-parse --verify -q "$1^{commit}" >/dev/null || { echo "compare_pass: $1 is neither a directory nor a commit" >&2; return 1; }
    git -C "$SRC" archive "$1" | tar -xf - -C "$2"; fi; }
tree "$base" "$W/base" || exit 2
tree "$head" "$W/head" || exit 2
rm -rf "$W/head/tests"; cp -R "$W/base/tests" "$W/head/tests"

if [ ${#suites[@]} -eq 0 ]; then
  for f in "$W/base/tests"/test_pass*.sh; do [ -f "$f" ] && suites+=("${f##*/}"); done
fi
[ ${#suites[@]} -gt 0 ] || { echo "compare_pass: the base has no tests/test_pass*.sh" >&2; exit 2; }
for s in "${suites[@]}"; do [ -f "$W/base/tests/$s" ] || { echo "compare_pass: the base has no tests/$s" >&2; exit 2; }; done

mkdir -p "$W/shim"
cat > "$W/shim/node" <<'EOF'
#!/bin/sh
# The first argument that is not an option is the script: a pass.mjs run is recorded, all else is node.
for a in "$@"; do
  case "$a" in -*) continue ;; esac
  case "$a" in pass.mjs|*/pass.mjs) exec "$PASS_CMP_NODE" "$PASS_CMP_RECORDER" record "$@" ;; esac
  break
done
exec "$PASS_CMP_NODE" "$@"
EOF
chmod +x "$W/shim/node"

# Each suite runs as tests/run.sh runs it: no DESK_* from the caller, and no machine-wide lock queue.
for v in $(compgen -e); do case "$v" in DESK_*) unset "$v" ;; esac; done
unset DATABASE_URL DIRECT_DATABASE_URL
export AUTOPILOT_LOCK_QUEUE=off PASS_CMP_NODE="$NODE" PASS_CMP_RECORDER="$S/compare_pass.mjs"
SH="${BASH:-bash}"
# The two trees run one after the other, each suite in its own scratch HOME: side by side, one tree's
# queue.mjs stop ends the other's stand-in worker, which it finds by session id across the machine.
side(){ mkdir -p "$W/rec/$1"
  for s in "${suites[@]}"; do
    echo "compare_pass: $s on the $1" >&2
    (cd "$W/$1" && PATH="$W/shim:$PATH" PASS_CMP_OUT="$W/rec/$1/$s" PASS_CMP_SUITE_LOG="$W/rec/$1/$s.log" \
      "$SH" "tests/$s" > "$W/rec/$1/$s.log" 2>&1 < /dev/null)
    mkdir -p "$W/rec/$1/$s"
  done; }
side base
side head
"$NODE" "$S/compare_pass.mjs" diff "$W/rec/base" "$W/rec/head" "$W/base" "$W/head"
