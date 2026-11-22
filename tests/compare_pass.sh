#!/usr/bin/env bash
# Shows whether a change moved what pass.mjs does. Runs the base's pass shell suites twice, once
# against the base tree and once against the head tree, with the base's tests/ in both, so cases the
# head moved into a unit suite still run against it. A `node` shim first on PATH saves the queue and
# the pass's output after every pass.mjs run (compare_pass.mjs record), and the two runs are then
# listed side by side (compare_pass.mjs diff). Written for bash 3.2 as well as 4+.
#   bash tests/compare_pass.sh <base> [<head>]                  base and head: a git ref or a directory;
#                                                               head defaults to HEAD
#   bash tests/compare_pass.sh --suite test_pass_spawns.sh <base> ...  only that suite (repeatable); by
#                                                               default every tests/test_pass*.sh in the base
#   PASS_CMP_KEEP=1 bash tests/compare_pass.sh ...              keep the recordings and both trees when a run
#                                                               differs or was not compared, and print the
#                                                               diff command that lists them again
#   PASS_CMP_SERIAL=1 bash tests/compare_pass.sh ...            run the trees and suites one after the
#                                                               other rather than side by side
# Exit 0 when nothing differs, 1 when something does, 2 when a run was not compared (it ran on one tree
# only, or crashed on one only) or the trees could not be built.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"
suites=()
while [ $# -gt 0 ]; do
  case "$1" in
    --suite) [ $# -ge 2 ] || { echo "compare_pass: --suite needs a suite name" >&2; exit 2; }; suites+=("${2##*/}"); shift 2 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
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

# shellcheck source=suite_env.sh
. "$S/suite_env.sh"
export PASS_CMP_NODE="$NODE" PASS_CMP_RECORDER="$S/compare_pass.mjs"
# The machine's own usage dir, whose probe stamps the recorder never holds (compare_pass.mjs holdProbeStamps).
PASS_CMP_LIVE_USAGE=$("$NODE" --input-type=module -e "import { usageDir } from '$SRC/desk/bin/usage-pace.mjs'; console.log(usageDir())") || exit 2
export PASS_CMP_LIVE_USAGE
# Every commit a suite makes is dated when the comparison started, on both trees. Otherwise a commit's
# SHA depends on the second it was made in: two identical commits share one when made in the same
# second, so one tree could show a single SHA where the other shows two.
GIT_AUTHOR_DATE="$(date +%s) +0000"; GIT_COMMITTER_DATE=$GIT_AUTHOR_DATE
export GIT_AUTHOR_DATE GIT_COMMITTER_DATE
# One suite $2 on the tree $1, in its own scratch HOME.
run(){ echo "compare_pass: $2 on the $1" >&2
  (cd "$W/$1" && PATH="$W/shim:$PATH" PASS_CMP_OUT="$W/rec/$1/$2" PASS_CMP_SUITE_LOG="$W/rec/$1/$2.log" \
    "$SH" "tests/$2" > "$W/rec/$1/$2.log" 2>&1 < /dev/null)
  mkdir -p "$W/rec/$1/$2"; }
mkdir -p "$W/rec/base" "$W/rec/head"
# Both trees and every suite run side by side, each suite's stand-in workers under session ids of its own
# (tests/pass_setup.sh SID_SUFFIX), as queue.mjs stop finds a worker by session id across the machine.
# PASS_CMP_SERIAL=1 runs them one after the other, as does a base whose suites predate those ids.
if [ "${PASS_CMP_SERIAL:-}" = 1 ] || ! grep -q '^SID_SUFFIX=' "$W/base/tests/pass_setup.sh" 2>/dev/null; then
  for t in base head; do for s in "${suites[@]}"; do run "$t" "$s"; done; done
else
  # Stopped, it ends each suite it started and everything under it before the scratch dir goes: a
  # suite started with & ignores SIGINT.
  tree_kill(){ local c; for c in $(ps -A -o pid= -o ppid= | awk -v p="$1" '$2 == p { print $1 }'); do tree_kill "$c"; done
    kill -TERM "$1" 2>/dev/null; }
  stop_suites(){ local p; trap "" INT TERM
    for p in ${pids[@]+"${pids[@]}"}; do tree_kill "$p"; done; wait; exit 130; }
  pids=()
  trap stop_suites INT TERM
  for t in base head; do for s in "${suites[@]}"; do run "$t" "$s" & pids+=($!); done; done
  wait
  trap - INT TERM
fi
"$NODE" "$S/compare_pass.mjs" diff "$W/rec/base" "$W/rec/head" "$W/base" "$W/head"; rc=$?
if [ "${PASS_CMP_KEEP:-}" = 1 ] && [ $rc -ne 0 ]; then
  trap - EXIT
  echo "compare_pass: kept the recordings and both trees in $W; list them again with:" >&2
  { printf '  node'; printf ' %q' "$S/compare_pass.mjs" diff "$W/rec/base" "$W/rec/head" "$W/base" "$W/head"; echo; } >&2
fi
exit $rc
