#!/usr/bin/env bash
# desk-update's vendor PRs. Every run upgrades the skills the user picks from origin/main's pins, so a
# new vendor PR supersedes an older open one when it upgrades every skill or tool the older one does:
# its pins are then the same or newer. One that upgrades something the new PR does not stays open.
#   vendor-prs.sh same <checkout> <branch>
#       exit 0: <branch>'s vendor/ equals origin/main's, so there is nothing to open; 1: it differs
#   vendor-prs.sh open <checkout> <owner/name> <branch> <title> <body>
#       opens the PR from <branch> into main, then closes each other open chore/vendor-* PR from this
#       repo that it supersedes, with a comment naming it, and deletes its branch; prints `kept #<n>`
#       for one it does not. Exits 3, opening nothing, when `same` holds; 1 when the PR does not
#       open, closing nothing; 4 when an older PR could not be read or closed.
set -uo pipefail
PREFIX=chore/vendor-

same(){ git -C "$1" diff --quiet origin/main "$2" -- vendor/; }

case "${1:-}" in
  same)
    [ "$#" = 3 ] || { echo "usage: vendor-prs.sh same <checkout> <branch>" >&2; exit 2; }
    same "$2" "$3"; rc=$?
    [ "$rc" -le 1 ] || { echo "vendor-prs.sh: could not compare $3 with origin/main in $2" >&2; exit 2; }
    exit "$rc" ;;
  open) ;;
  *) echo "usage: vendor-prs.sh same <checkout> <branch> | open <checkout> <owner/name> <branch> <title> <body>" >&2; exit 2 ;;
esac

[ "$#" = 6 ] || { echo "usage: vendor-prs.sh open <checkout> <owner/name> <branch> <title> <body>" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "vendor-prs.sh: jq is required" >&2; exit 1; }
D="$2"; REPO="$3"; BRANCH="$4"
case "$BRANCH" in "$PREFIX"*) ;; *) echo "vendor-prs.sh: $BRANCH is not a $PREFIX* branch" >&2; exit 2 ;; esac
cd "$D" || exit 1

# The skills and tools whose pin in vendor/sources.json <head> changes from where it left main, one
# `skills/<name>` or `tools/<name>` per line. Fails when either side cannot be read.
upgraded(){
  local base a b
  base=$(git merge-base origin/main "$1") && a=$(git show "$base:vendor/sources.json") \
    && b=$(git show "$1:vendor/sources.json") || return 1
  jq -rn --argjson a "$a" --argjson b "$b" \
    '["skills","tools"][] as $s | ($b[$s] // {}) | to_entries[]
     | select(.value.pin != (($a[$s] // {})[.key].pin)) | "\($s)/\(.key)"'
}

same "$D" "$BRANCH"; rc=$?
if [ "$rc" = 0 ]; then echo "main is already current: $BRANCH changes nothing under vendor/, so no PR opened"; exit 3; fi
[ "$rc" = 1 ] || { echo "vendor-prs.sh: could not compare $BRANCH with origin/main" >&2; exit 1; }

url=$(gh pr create --repo "$REPO" --base main --head "$BRANCH" --title "$5" --body "$6") \
  || { echo "vendor-prs.sh: the PR from $BRANCH did not open; no older vendor PR was closed" >&2; exit 1; }
new=${url##*/}
case "$new" in ''|*[!0-9]*) echo "vendor-prs.sh: gh pr create printed no PR URL ($url); no older vendor PR was closed" >&2; exit 1 ;; esac
echo "opened $url"

mine=$(upgraded "$BRANCH") \
  || { echo "vendor-prs.sh: could not read the pins $BRANCH upgrades, so no older vendor PR was closed" >&2; exit 4; }
list=$(gh pr list --repo "$REPO" --state open --limit 200 --json number,headRefName,isCrossRepository) \
  || { echo "vendor-prs.sh: could not list open PRs, so no older vendor PR was closed" >&2; exit 4; }
old=$(printf '%s' "$list" | jq -r --arg p "$PREFIX" --argjson n "$new" \
  '.[] | select((.headRefName | startswith($p)) and (.isCrossRepository | not) and .number != $n) | "\(.number):\(.headRefName)"')
rc=0
for pr in $old; do
  n=${pr%%:*}; head=${pr#*:}
  if ! git fetch -q origin "refs/heads/$head" </dev/null || ! theirs=$(upgraded FETCH_HEAD); then
    echo "vendor-prs.sh: could not read #$n's pins from $head, so it was left open" >&2; rc=4; continue
  fi
  missing=""
  for s in $theirs; do printf '%s\n' "$mine" | grep -qxF -- "$s" || missing="$missing ${s#*/}"; done
  if [ -z "$theirs" ]; then echo "kept #$n: it changes no pin, so #$new cannot be shown to hold it"; continue; fi
  if [ -n "$missing" ]; then echo "kept #$n: it upgrades$missing, which #$new does not"; continue; fi
  if gh pr close "$n" --repo "$REPO" --delete-branch --comment "Superseded by #$new, which upgrades every skill and tool this PR does from main's current pins, so at the same or a newer commit." </dev/null >/dev/null; then
    echo "closed #$n: superseded by #$new"
  else echo "vendor-prs.sh: could not close #$n" >&2; rc=4; fi
done
exit "$rc"
