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
# A base given as a commit is replayed once: its recording is cached in
# ${XDG_CACHE_HOME:-~/.cache}/desk-skills/compare-pass (the last 5), keyed by the commit, the node, git
# and bash versions, the suites and these scripts. PASS_CMP_CACHE=0 replays both trees.
# Exit 0 when nothing differs, 1 when something does, 2 when a run was not compared (it ran on one tree
# only, or crashed on one only) or the trees could not be built.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"
suites=()
while [ $# -gt 0 ]; do
  case "$1" in
    --suite) [ $# -ge 2 ] || { echo "compare_pass: --suite needs a suite name" >&2; exit 2; }; suites+=("${2##*/}"); shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    -*) echo "compare_pass: unknown option $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] && [ $# -le 2 ] || { echo "usage: bash tests/compare_pass.sh [--suite <name>]... <base> [<head>]" >&2; exit 2; }
base=$1; head=${2:-HEAD}
NODE=$(command -v node) || { echo "compare_pass: node is not on PATH" >&2; exit 2; }
W="$(mktemp -d "${TMPDIR:-/tmp}/compare-pass.XXXXXX")" || exit 2
trap 'rm -rf "$W"' EXIT
# An interrupted comparison stops here rather than going on to the next suite and caching a partial base.
trap 'exit 130' INT; trap 'exit 143' TERM

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
# Every commit a suite makes is dated when the comparison started, on both trees. Otherwise a commit's
# SHA depends on the second it was made in: two identical commits share one when made in the same
# second, so one tree could show a single SHA where the other shows two.
GIT_AUTHOR_DATE="$(date +%s) +0000"; GIT_COMMITTER_DATE=$GIT_AUTHOR_DATE
export GIT_AUTHOR_DATE GIT_COMMITTER_DATE
# The two trees run one after the other, each suite in its own scratch HOME: side by side, one tree's
# queue.mjs stop ends the other's stand-in worker, which it finds by session id across the machine.
side(){ mkdir -p "$W/rec/$1"
  for s in "${suites[@]}"; do
    echo "compare_pass: $s on the $1" >&2
    (cd "$W/$1" && PATH="$W/shim:$PATH" PASS_CMP_OUT="$W/rec/$1/$s" PASS_CMP_SUITE_LOG="$W/rec/$1/$s.log" \
      "$SH" "tests/$s" > "$W/rec/$1/$s.log" 2>&1 < /dev/null)
    [ $? -lt 128 ] || stopped=1
    mkdir -p "$W/rec/$1/$s"
  done; }

# The cache key: everything the base's recording depends on besides the base tree itself, as the
# recorder and suite_env.sh come from this checkout rather than the base.
C="${XDG_CACHE_HOME:-$HOME/.cache}/desk-skills/compare-pass"; key=; hit=; stopped=
if [ "${PASS_CMP_CACHE:-1}" != 0 ] && [ ! -d "$base" ]; then
  key=$({ git -C "$SRC" rev-parse "$base^{commit}"; "$NODE" --version; git --version; echo "$BASH_VERSION"
    printf '%s\n' "${suites[@]}" | sort; cat "$S/compare_pass.sh" "$S/compare_pass.mjs" "$S/suite_env.sh"
  } | git hash-object --stdin) || key=
fi
# Each entry holds the base's records and the paths that tree ran at, which the diff masks as it does
# this run's own.
brec="$W/rec/base"; broots=("$W/base" "$W")
if [ -n "$key" ] && [ -f "$C/$key.tar" ] && mkdir -p "$W/cached" && tar -xf "$C/$key.tar" -C "$W/cached" 2>/dev/null \
  && [ -d "$W/cached/rec/base" ] && [ -f "$W/cached/roots" ]; then
  hit=1; brec="$W/cached/rec/base"; broots=()
  while IFS= read -r r; do broots+=("$r"); done < "$W/cached/roots"
  touch "$C/$key.tar"
  echo "compare_pass: the base's recording is cached, so only the head is replayed (PASS_CMP_CACHE=0 replays both)" >&2
else
  side base
fi
# A base replay that ran whole with no pass crashing is cached; the oldest entries past 5 go.
if [ -n "$key" ] && [ -z "$hit" ] && [ -z "$stopped" ] && "$NODE" "$S/compare_pass.mjs" clean "$W/rec/base" \
  && mkdir -p "$C" 2>/dev/null; then
  printf '%s\n' "$W/base" "$(cd "$W/base" && pwd -P)" "$W" "$(cd "$W" && pwd -P)" > "$W/roots"
  tar -cf "$C/.$key.$$" -C "$W" rec/base roots 2>/dev/null && mv -f "$C/.$key.$$" "$C/$key.tar"
  rm -f "$C/.$key.$$"
  ls -1t "$C"/*.tar 2>/dev/null | tail -n +6 | while IFS= read -r f; do rm -f "$f"; done
fi
side head
"$NODE" "$S/compare_pass.mjs" diff "$brec" "$W/rec/head" "${broots[@]}" "$W/head" "$W"; rc=$?
if [ "${PASS_CMP_KEEP:-}" = 1 ] && [ $rc -ne 0 ]; then
  trap - EXIT
  echo "compare_pass: kept the recordings and both trees in $W; list them again with:" >&2
  { printf '  node'; printf ' %q' "$S/compare_pass.mjs" diff "$brec" "$W/rec/head" "${broots[@]}" "$W/head" "$W"; echo; } >&2
fi
exit $rc
