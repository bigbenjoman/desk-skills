#!/usr/bin/env bash
# desk-update's vendor PRs: one open at a time. Every run upgrades from origin/main's pins, so a new
# vendor PR holds every upgrade an older open one does, at the same or a newer commit.
#   vendor-prs.sh same <checkout> <branch>
#       exit 0: <branch>'s vendor/ equals origin/main's, so there is nothing to open; 1: it differs
#   vendor-prs.sh open <checkout> <owner/name> <branch> <title> <body>
#       opens the PR from <branch> into main, then closes every other open chore/vendor-* PR from
#       this repo with a comment naming it, and deletes its branch. Exits 3, opening nothing, when
#       `same` holds; 1 when the PR does not open, closing nothing; 4 when a close failed.
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

same "$D" "$BRANCH"; rc=$?
if [ "$rc" = 0 ]; then echo "main is already current: $BRANCH changes nothing under vendor/, so no PR opened"; exit 3; fi
[ "$rc" = 1 ] || { echo "vendor-prs.sh: could not compare $BRANCH with origin/main" >&2; exit 1; }

url=$(gh pr create --repo "$REPO" --base main --head "$BRANCH" --title "$5" --body "$6") \
  || { echo "vendor-prs.sh: the PR from $BRANCH did not open; no older vendor PR was closed" >&2; exit 1; }
new=${url##*/}
case "$new" in ''|*[!0-9]*) echo "vendor-prs.sh: gh pr create printed no PR URL ($url); no older vendor PR was closed" >&2; exit 1 ;; esac
echo "opened $url"

list=$(gh pr list --repo "$REPO" --state open --limit 200 --json number,headRefName,isCrossRepository) \
  || { echo "vendor-prs.sh: could not list open PRs, so no older vendor PR was closed" >&2; exit 4; }
old=$(printf '%s' "$list" | jq -r --arg p "$PREFIX" --argjson n "$new" \
  '.[] | select((.headRefName | startswith($p)) and (.isCrossRepository | not) and .number != $n) | .number')
rc=0
for n in $old; do
  if gh pr close "$n" --repo "$REPO" --delete-branch --comment "Superseded by #$new, which upgrades from main's current pins and so holds every upgrade here at the same or a newer commit." >/dev/null; then
    echo "closed #$n: superseded by #$new"
  else echo "vendor-prs.sh: could not close #$n" >&2; rc=4; fi
done
exit "$rc"
