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
# A base given as a commit is replayed once: its recording is cached in
# ${XDG_CACHE_HOME:-~/.cache}/desk-skills/compare-pass (the last 5), keyed by the commit, the node, git
# and bash versions, the suites and these scripts; a base suite that failed a check is left out of it
# and replayed again next time. PASS_CMP_CACHE=0 replays both trees.
# Exit 0 when nothing differs, 1 when something does, 2 when a run was not compared (it ran on one tree
# only, or crashed on one only) or the trees could not be built.
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"
suites=()
while [ $# -gt 0 ]; do
  case "$1" in
    --suite) [ $# -ge 2 ] || { echo "compare_pass: --suite needs a suite name" >&2; exit 2; }; suites+=("${2##*/}"); shift 2 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    -*) echo "compare_pass: unknown option $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] && [ $# -le 2 ] || { echo "usage: bash tests/compare_pass.sh [--suite <name>]... <base> [<head>]" >&2; exit 2; }
base=$1; head=${2:-HEAD}
# A base ref is read once, so the tree replayed is the commit its recording is cached under.
[ -d "$base" ] || base=$(git -C "$SRC" rev-parse --verify -q "$base^{commit}") || base=$1
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
# One suite $2 on the tree $1, in its own scratch HOME. Its exit status is kept beside its log, as a
# suite run side by side cannot hand it back.
run(){ echo "compare_pass: $2 on the $1" >&2
  (cd "$W/$1" && PATH="$W/shim:$PATH" PASS_CMP_OUT="$W/rec/$1/$2" PASS_CMP_SUITE_LOG="$W/rec/$1/$2.log" \
    "$SH" "tests/$2" > "$W/rec/$1/$2.log" 2>&1 < /dev/null)
  echo $? > "$W/st/$1/$2"
  mkdir -p "$W/rec/$1/$2"; }

# The cache key: everything the base's recording depends on besides the base tree itself, as the
# recorder and suite_env.sh come from this checkout rather than the base.
C="${XDG_CACHE_HOME:-$HOME/.cache}/desk-skills/compare-pass"; key=; hit=
if [ "${PASS_CMP_CACHE:-1}" != 0 ] && [ ! -d "$base" ]; then
  key=$({ echo "$base"; "$NODE" --version; git --version; echo "$BASH_VERSION"
    printf '%s\n' "${suites[@]}" | sort; cat "$S/compare_pass.sh" "$S/compare_pass.mjs" "$S/suite_env.sh"
  } | git hash-object --stdin) || key=
fi
# Each entry holds the records of the base's suites that ran clean, their names, and the paths that
# tree ran at, which the diff masks as it does this run's own. A suite the entry lacks, as it failed a
# check when the entry was written (perhaps for want of a tool, or on a busy machine), is replayed on
# the base again, and added to the entry once it runs clean.
mkdir -p "$W/rec/base" "$W/rec/head" "$W/st/base" "$W/st/head"
broots=(); bsuites=("${suites[@]}"); cached=
if [ -n "$key" ] && [ -f "$C/$key.tar" ] && mkdir -p "$W/cached" && tar -xf "$C/$key.tar" -C "$W/cached" 2>/dev/null \
  && [ -f "$W/cached/suites" ] && [ -f "$W/cached/roots" ]; then
  bsuites=()
  for s in "${suites[@]}"; do
    if grep -qxF "$s" "$W/cached/suites" && [ -d "$W/cached/rec/base/$s" ] && [ -f "$W/cached/rec/base/$s.log" ]; then
      mv "$W/cached/rec/base/$s" "$W/cached/rec/base/$s.log" "$W/rec/base/"; cached="$cached$s"$'\n'
    else bsuites+=("$s"); fi
  done
  if [ -n "$cached" ]; then
    hit=1; touch "$C/$key.tar"
    while IFS= read -r r; do broots+=("$r"); done < "$W/cached/roots"
    if [ ${#bsuites[@]} -eq 0 ]; then
      echo "compare_pass: the base's recording is cached, so only the head is replayed (PASS_CMP_CACHE=0 replays both)" >&2
    else
      echo "compare_pass: the base's recording is cached but for ${bsuites[*]}, so only those are replayed on the base (PASS_CMP_CACHE=0 replays both)" >&2
    fi
  fi
fi
[ ${#bsuites[@]} -eq 0 ] || broots+=("$W/base" "$W")
# Both trees and every suite run side by side, each suite's stand-in workers under session ids of its own
# (tests/pass_setup.sh SID_SUFFIX), as queue.mjs stop finds a worker by session id across the machine.
# PASS_CMP_SERIAL=1 runs them one after the other, as does a base whose suites predate those ids.
if [ "${PASS_CMP_SERIAL:-}" = 1 ] || ! grep -q '^SID_SUFFIX=' "$W/base/tests/pass_setup.sh" 2>/dev/null; then
  for s in ${bsuites[@]+"${bsuites[@]}"}; do run base "$s"; done
  for s in "${suites[@]}"; do run head "$s"; done
else
  # Stopped, it ends each suite it started and everything under it before the scratch dir goes: a
  # suite started with & ignores SIGINT.
  tree_kill(){ local c; for c in $(ps -A -o pid= -o ppid= | awk -v p="$1" '$2 == p { print $1 }'); do tree_kill "$c"; done
    kill -TERM "$1" 2>/dev/null; }
  stop_suites(){ local p; trap "" INT TERM
    for p in ${pids[@]+"${pids[@]}"}; do tree_kill "$p"; done; wait; exit 130; }
  pids=()
  trap stop_suites INT TERM
  for s in ${bsuites[@]+"${bsuites[@]}"}; do run base "$s" & pids+=($!); done
  for s in "${suites[@]}"; do run head "$s" & pids+=($!); done
  wait
  trap 'exit 130' INT; trap 'exit 143' TERM
fi
# The base suites just replayed join the entry when they ran clean; the oldest entries past 5 go. One
# that failed a check, or exited non-zero, is left out and said; a suite stopped by a signal, or a pass
# that crashed, leaves the entry unwritten, as that replay may have stopped part way.
if [ -n "$key" ] && [ ${#bsuites[@]} -gt 0 ]; then
  why=; stop=; good=$cached
  for s in "${bsuites[@]}"; do
    st=$(cat "$W/st/base/$s" 2>/dev/null) || st='with no status'
    f=$(grep -m 1 '^FAIL ' "$W/rec/base/$s.log" 2>/dev/null)
    case "$st" in ''|*[!0-9]*) stop=1 ;; *) [ "$st" -lt 128 ] || stop=1 ;; esac
    if [ -n "$f" ]; then why="${why:+$why; }$s: $f"
    elif [ "$st" != 0 ]; then why="${why:+$why; }$s exited $st"
    else good="$good$s"$'\n'; fi
  done
  crash=$("$NODE" "$S/compare_pass.mjs" clean "$W/rec/base" "${bsuites[@]}" 2>&1) || { stop=1; why="${why:+$why; }${crash:-a pass crashed}"; }
  if [ -z "$stop" ] && [ -n "$good" ] && mkdir -p "$C" 2>/dev/null; then
    { [ ${#broots[@]} -eq 0 ] || printf '%s\n' "${broots[@]}"; (cd "$W/base" && pwd -P); (cd "$W" && pwd -P); } > "$W/roots"
    printf '%s' "$good" > "$W/suites"
    files=(roots suites)
    while IFS= read -r s; do [ -n "$s" ] && files+=("rec/base/$s" "rec/base/$s.log"); done < "$W/suites"
    tar -cf "$C/.$key.$$" -C "$W" "${files[@]}" 2>/dev/null && mv -f "$C/.$key.$$" "$C/$key.tar" \
      && echo "compare_pass: cached the base's recording as $C/$key.tar${why:+, but for $why}" >&2
    rm -f "$C/.$key.$$"
    ls -1t "$C"/*.tar 2>/dev/null | tail -n +6 | while IFS= read -r f; do rm -f "$f"; done
  else
    echo "compare_pass: the base's recording is not cached: ${why:-$C could not be made}" >&2
  fi
fi
# A cached base ran long before the head, which the diff is told so it matches times by run only.
dargs=("$S/compare_pass.mjs" diff ${hit:+"--base-cached"} "$W/rec/base" "$W/rec/head" ${broots[@]+"${broots[@]}"} "$W/head" "$W")
"$NODE" "${dargs[@]}"; rc=$?
if [ "${PASS_CMP_KEEP:-}" = 1 ] && [ $rc -ne 0 ]; then
  trap - EXIT
  echo "compare_pass: kept the recordings and both trees in $W; list them again with:" >&2
  { printf '  node'; printf ' %q' "${dargs[@]}"; echo; } >&2
fi
exit $rc
