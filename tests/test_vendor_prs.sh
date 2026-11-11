#!/usr/bin/env bash
# suite: vendor PRs (a new desk-update vendor PR closes the older ones it supersedes)
# covers: desk/bin/vendor-prs.sh skills/desk-update/**
# vendor-prs.sh against a fake gh and a throwaway checkout with an origin: the PR opens, then only the
# other open chore/vendor-* PRs from this repo whose every moved pin the new branch upgrades, or main
# pins at exactly that commit, are closed naming it; any other stays open; a failed create closes nothing; a branch
# whose vendor/ equals origin/main's opens nothing; `free` refuses a branch already in the checkout or
# on origin, naming its open PR.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; V="$S/../desk/bin/vendor-prs.sh"; T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home"; mkdir -p "$HOME" "$T/bin"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: $out"; echo "     gh: $(cat "$GH_LOG" 2>/dev/null)"; fi; }

# The fake gh logs each call. `pr create` prints PR 401's URL, or fails while $T/create-fails exists;
# `pr list` answers from $T/list.json; `pr close` succeeds.
cat > "$T/bin/gh" <<'EOF'
#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "pr create") [ -f "$GH_DIR/create-fails" ] && { echo "pull request create failed: GraphQL: Head sha can't be blank" >&2; exit 1; }
               echo "https://github.com/acme/desk/pull/401" ;;
  "pr list") cat "$GH_DIR/list.json" ;;
  "pr close") ;;
  *) echo "fake gh: unexpected $*" >&2; exit 2 ;;
esac
EOF
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH" GH_DIR="$T" GH_LOG="$T/gh.log"
LIST='[{"number":401,"headRefName":"chore/vendor-2026-11-02","isCrossRepository":false},
 {"number":272,"headRefName":"chore/vendor-2026-10-28","isCrossRepository":false},
 {"number":273,"headRefName":"chore/vendor-2026-10-29","isCrossRepository":false},
 {"number":274,"headRefName":"chore/vendor-2026-10-30","isCrossRepository":false},
 {"number":276,"headRefName":"chore/vendor-2026-10-27","isCrossRepository":false},
 {"number":400,"headRefName":"fix/DS-1-other","isCrossRepository":false},
 {"number":399,"headRefName":"chore/vendor-mine","isCrossRepository":true}'
printf '%s]\n' "$LIST" > "$T/list.json"

# A checkout whose origin/main first pins skills a, b and c at 1. On origin, cut from there: #276's
# branch upgrades c to 3, #272's c to 2, #273's a, #274's b. Then main takes c at 3 from another vendor
# PR, which may be older than #272's c2 (merged after it was opened). Locally: 11-02, cut from that main,
# upgrades a, so it holds #273 and #276 (main pins c at exactly its pin), not #272 (main's c differs)
# or #274; 11-03 changes no vendor/.
git init -q --bare "$T/origin.git"
git clone -q "$T/origin.git" "$T/d" 2>/dev/null
D="$T/d"
pins(){ mkdir -p "$D/vendor/a" "$D/vendor/b" "$D/vendor/c"
  echo "$1" > "$D/vendor/a/f"; echo "$2" > "$D/vendor/b/f"; echo "$3" > "$D/vendor/c/f"
  printf '{"_about":"x","skills":{"a":{"pin":{"commit":"%s"}},"b":{"pin":{"commit":"%s"}},"c":{"pin":{"commit":"%s"}}},"tools":{}}\n' "$1" "$2" "$3" > "$D/vendor/sources.json"; }
pins a1 b1 c1; echo x > "$D/README"
git -C "$D" add -A; git -C "$D" commit -qm init; git -C "$D" branch -qM main; git -C "$D" push -q origin main
# Its own message, so within one second it is not the very commit main takes c3 in below.
git -C "$D" switch -qc chore/vendor-2026-10-27 main; pins a1 b1 c3; git -C "$D" commit -qam "c3 on 10-27"; git -C "$D" push -q origin HEAD
git -C "$D" switch -qc chore/vendor-2026-10-28 main; pins a1 b1 c2; git -C "$D" commit -qam c2; git -C "$D" push -q origin HEAD
git -C "$D" switch -qc chore/vendor-2026-10-29 main; pins a2 b1 c1; git -C "$D" commit -qam a2; git -C "$D" push -q origin HEAD
git -C "$D" switch -qc chore/vendor-2026-10-30 main; pins a1 b2 c1; git -C "$D" commit -qam b2; git -C "$D" push -q origin HEAD
git -C "$D" switch -q main; pins a1 b1 c3; git -C "$D" commit -qam c3; git -C "$D" push -q origin main
git -C "$D" switch -qc chore/vendor-2026-11-02 main; pins a3 b1 c3; git -C "$D" commit -qam a3
git -C "$D" switch -qc chore/vendor-2026-11-03 main; echo y > "$D/README"; git -C "$D" commit -qam readme
git -C "$D" switch -q main

# AC3: a branch whose vendor/ equals origin/main's opens nothing.
out=$(bash "$V" same "$D" chore/vendor-2026-11-03); rc=$?
check "AC3 same: vendor/ equal to origin/main's exits 0" '[ $rc -eq 0 ]'
out=$(bash "$V" same "$D" chore/vendor-2026-11-02); rc=$?
check "AC3 same: a changed vendor/ exits 1" '[ $rc -eq 1 ]'
: > "$GH_LOG"
out=$(bash "$V" open "$D" acme/desk chore/vendor-2026-11-03 t b 2>&1); rc=$?
check "AC3 open: nothing to open exits 3, says main is current, calls no gh" '[ $rc -eq 3 ] && [[ "$out" == *"main is already current"* ]] && [ ! -s "$GH_LOG" ]'

# AC2: the new PR fails to open, so nothing is listed or closed.
: > "$GH_LOG"; touch "$T/create-fails"
out=$(bash "$V" open "$D" acme/desk chore/vendor-2026-11-02 t b 2>&1); rc=$?
check "AC2 a failed create exits 1 and closes nothing" '[ $rc -eq 1 ] && [[ "$out" == *"no older vendor PR was closed"* ]] && ! grep -qE "^pr (list|close)" "$GH_LOG"'
rm -f "$T/create-fails"

# AC1, AC4: the new PR opens; only the older vendor PR from this repo that it supersedes is closed.
: > "$GH_LOG"
out=$(bash "$V" open "$D" acme/desk chore/vendor-2026-11-02 "chore(vendor): upgrade x" body 2>&1); rc=$?
check "AC1 open exits 0 and reports the new PR and the close" '[ $rc -eq 0 ] && [[ "$out" == *"opened https://github.com/acme/desk/pull/401"* ]] && [[ "$out" == *"closed #273: superseded by #401"* ]]'
check "AC1 the PR opens from the branch into main" 'grep -qF "pr create --repo acme/desk --base main --head chore/vendor-2026-11-02 --title chore(vendor): upgrade x --body body" "$GH_LOG"'
check "AC1 the older vendor PR closes with a comment naming the new one and its branch deleted" 'grep -qE "^pr close 273 --repo acme/desk --delete-branch --comment Superseded by #401" "$GH_LOG"'
check "an older vendor PR whose pin main now has exactly closes too" '[[ "$out" == *"closed #276: superseded by #401"* ]] && grep -qE "^pr close 276 --repo acme/desk --delete-branch --comment Superseded by #401" "$GH_LOG"'
check "an older vendor PR whose pin main moved to a different, maybe older, commit stays open, named" '[[ "$out" == *"kept #272: main moved c to a different pin than it has"* ]] && ! grep -q "^pr close 272" "$GH_LOG"'
check "an older vendor PR upgrading a skill the new one does not stays open, named" '[[ "$out" == *"kept #274: it upgrades b, which #401 does not"* ]] && ! grep -q "^pr close 274" "$GH_LOG"'
check "AC4 exactly two PRs closed: not the new one, another head, a fork or one not superseded" '[ "$(grep -c "^pr close" "$GH_LOG")" = 2 ]'

# An older vendor PR whose branch cannot be read is left open, and the run says so with exit 4.
printf '%s,\n {"number":275,"headRefName":"chore/vendor-gone","isCrossRepository":false}]\n' "$LIST" > "$T/list.json"
: > "$GH_LOG"
out=$(bash "$V" open "$D" acme/desk chore/vendor-2026-11-02 t b 2>&1); rc=$?
check "an unreadable older vendor PR is left open and exits 4" '[ $rc -eq 4 ] && [[ "$out" == *"could not read #275"* ]] && ! grep -q "^pr close 275" "$GH_LOG"'

# free: today's branch only on origin, with an open PR, stops the upgrade and names both.
printf '%s]\n' "$LIST" > "$T/list.json"
git -C "$D" push -q origin chore/vendor-2026-11-02:refs/heads/chore/vendor-2026-11-07
out=$(bash "$V" free "$D" acme/desk chore/vendor-2026-11-07 2>&1); rc=$?
check "free: a branch only on origin exits 1 and names it" '[ $rc -eq 1 ] && [[ "$out" == "chore/vendor-2026-11-07 exists on origin (open PR: none)"* ]]'
out=$(bash "$V" free "$D" acme/desk chore/vendor-2026-11-02 2>&1); rc=$?
check "free: a local branch exits 1, naming its open PR" '[ $rc -eq 1 ] && [[ "$out" == "chore/vendor-2026-11-02 exists in the checkout (open PR: #401)"* ]]'
git -C "$D" push -q origin chore/vendor-2026-11-02
out=$(bash "$V" free "$D" acme/desk chore/vendor-2026-11-02 2>&1); rc=$?
check "free: local and on origin names both" '[[ "$out" == "chore/vendor-2026-11-02 exists in the checkout and on origin (open PR: #401)"* ]]'
out=$(bash "$V" free "$D" acme/desk chore/vendor-2026-11-09 2>&1); rc=$?
check "free: a branch on neither exits 0, silently" '[ $rc -eq 0 ] && [ -z "$out" ]'
out=$(bash "$V" free "$T/nowhere" acme/desk chore/vendor-2026-11-09 2>&1); rc=$?
check "free: an unreadable origin exits 2" '[ $rc -eq 2 ]'

# A branch outside chore/vendor-* is refused before gh runs.
: > "$GH_LOG"
out=$(bash "$V" open "$D" acme/desk main t b 2>&1); rc=$?
check "a non-vendor branch is refused" '[ $rc -eq 2 ] && [ ! -s "$GH_LOG" ]'

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" = 0 ]
