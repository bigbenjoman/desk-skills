#!/usr/bin/env bash
# suite: merge driver: one driver for all of a repo's batches (offline, fake gh)
# The real merge-driver.sh --all-batches (merge-driver-repo.sh) over the standing batch and two named
# batches on bases of their own, set up by merge_driver_setup.sh with the repo's own paths in place of
# an explicit queue and state: one pid holds or points every batch's lock, a green PR in each batch
# merges onto that batch's base, a red base holds only its own batch, one `gh pr list` serves a sweep,
# a sweep's lines are not said again on the next, and TERM lets every lock go.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=merge_driver_setup.sh
. "$S/merge_driver_setup.sh"

# The repo's own batch paths, under a scratch desk home whose bin is this checkout's.
mkdir -p "$T/desk"; ln -s "$B" "$T/desk/bin"
unset DESK_AUTOPILOT_STATE DESK_QUEUE
export DESK_HOME="$T/desk"
SLUG=$(node --input-type=module -e "const E = await import('$B/desk-env.mjs'); console.log(E.repoSlug())")
SQ="$T/desk/repos/$SLUG/queue.json"; SS="$HOME/.desk-autopilot/$SLUG"
XQ="$T/desk/repos/$SLUG/batches/X-1/queue.json"; XS="$SS/batches/X-1"
YQ="$T/desk/repos/$SLUG/batches/Y-1/queue.json"; YS="$SS/batches/Y-1"
# bq <queue file> <batch> <ticket> <base, or - for none>: a handed-over batch of one running ticket.
bq(){ mkdir -p "$(dirname "$1")"; b=""; [ "$4" = - ] || b="\"base\":\"$4\","
  printf '{"version":1,"batch":"%s","supervised":true,%s"approved":{},"tickets":{"%s":{"key":"%s","state":"running","branch":"fix/%s"}}}\n' "$2" "$b" "$3" "$3" "$3" > "$1"; }
bq "$SQ" s1 T-1 -; bq "$XQ" X-1 T-2 feat/x; bq "$YQ" Y-1 T-3 feat/y

SHA1=1111111111111111111111111111111111111111; SHA2=2222222222222222222222222222222222222222
SHA3=3333333333333333333333333333333333333333
cat > "$T/prs.json" <<EOF
{
  "201": { "head": "fix/T-1", "base": "main",   "sha": "$SHA1", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] },
  "202": { "head": "fix/T-2", "base": "feat/x", "sha": "$SHA2", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] },
  "203": { "head": "fix/T-3", "base": "feat/y", "sha": "$SHA3", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] }
}
EOF
# feat/y's newest run of the required check failed; main and feat/x pass.
G=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; R=cccccccccccccccccccccccccccccccccccccccc
printf '{"tip":"%s","tips":{"feat/y":"%s"},"commits":{"%s":{"parent":null,"runs":[["test","completed","success"]]},"%s":{"parent":null,"runs":[["test","completed","failure","https://github.com/acme/widgets/actions/runs/870"]]}}}\n' \
  "$G" "$R" "$G" "$R" > "$T/base.json"

# The fake sleep: with sleep.pass holding n, the next n sleeps return at once; with sleep.real, it
# sleeps; otherwise it records the call and stops the driver, as merge_driver_setup.sh's does.
cat > "$T/stub/sleep" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "\$FAKE_SLEEPS"
if [ -f "$T/sleep.real" ]; then exec /bin/sleep "\$@"; fi
n=\$(cat "$T/sleep.pass" 2>/dev/null || echo 0)
if [ "\$n" -gt 0 ]; then echo \$((n - 1)) > "$T/sleep.pass"; exit 0; fi
kill -TERM "\$PPID"
EOF
chmod +x "$T/stub/sleep"
sweep(){ : > "$T/gh.log"; rm -f "$T/sleeps"; out=$(MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --all-batches 2>&1); rc=$?; }
lists(){ grep -c "^pr list" "$T/gh.log"; }
# The repo's lock, then the standing batch's, X-1's and Y-1's: each lock's pid, or - with none.
RL="$SS/merge-driver/repo.lock.d"
locks(){ for d in "$RL" "$SS/merge-driver.lock.d" "$XS/merge-driver.lock.d" "$YS/merge-driver.lock.d"; do cat "$d/pid" 2>/dev/null || echo -; done | paste -sd' ' -; }

# ---- AC1: one driver, one pid on every batch's lock ---------------------------------------------
# At the PR list, every batch's lock is read: the sweep's driver holds or points each one by then.
atlist(){ echo "for d in '$RL' '$SS/merge-driver.lock.d' '$XS/merge-driver.lock.d' '$YS/merge-driver.lock.d'; do cat \"\$d/pid\" 2>/dev/null || echo -; done | paste -sd' ' - > '$T/locks.seen'; cp '$RL/version' '$T/version.seen' 2>/dev/null; cp '$XS/merge-driver.lock.d/version' '$T/xversion.seen' 2>/dev/null" > "$T/gh.atlist"; }
atlist
sweep
seen=$(cat "$T/locks.seen" 2>/dev/null)
check "AC1: one pid holds the repo's lock and points the standing batch's and both named batches' locks" '[ -n "$seen" ] && [ "$(echo "$seen" | tr " " "\n" | sort -u | wc -l | tr -d " ")" = 1 ] && [ "${seen%% *}" != - ]'
check "AC1: a batch's lock carries the driver's version, as the repo's does" '[ -f "$T/version.seen" ] && cmp -s "$T/version.seen" "$T/xversion.seen"'
check "AC1: the driver says it is up once, for every batch, and each batch's loop says its own base" 'echo "$out" | grep -q "merge driver up for every batch: repo=acme/widgets" && echo "$out" | grep -q "merge driver up: .*base=main" && echo "$out" | grep -q "merge driver up: .*base=feat/x" && echo "$out" | grep -q "merge driver up: .*base=feat/y"'
check "one gh pr list serves the whole sweep" '[ "$(lists)" = 1 ]'
check "a first sweep confirms the green heads and merges nothing" '[ ! -s "$T/merges.log" ] && echo "$out" | grep -q "#201 green at 111111111" && echo "$out" | grep -q "#202 green at 222222222"'
check "AC3: feat/y's red base holds its own PR, naming the check" 'echo "$out" | grep -q "HOLDING on red feat/y" || echo "$out" | grep -q "red .*feat/y"'
check "with green heads waiting, the sweep pauses 120s" '[ "$(cat "$T/sleeps")" = 120 ]'
check "the driver's exit lets every lock go, and it writes the one exit line" '[ "$(locks)" = "- - - -" ] && [ "$(echo "$out" | grep -c "merge driver exited")" = 1 ] && echo "$out" | tail -1 | grep -q "merge driver exited 143$"'

# ---- AC2 and AC3: each green PR merges onto its own base; the red base holds only its own -------
sweep
check "AC3: the PRs into main and feat/x merge, each onto its own base, while feat/y is red" 'grep -qx "201 main $SHA1" "$T/merges.log" && grep -qx "202 feat/x $SHA2" "$T/merges.log" && ! grep -q "^203 " "$T/merges.log"'
check "AC2: a merge in any batch pauses 30s" '[ "$(cat "$T/sleeps")" = 30 ]'
check "one gh pr list in that sweep too" '[ "$(lists)" = 1 ]'
check "a merge is recorded in its own batch's queue" '[ "$(jq -r ".tickets[\"T-2\"].merged_at" "$XQ")" != null ] && [ "$(jq -r ".tickets[\"T-1\"].merged_at" "$SQ")" != null ]'
printf '{"tip":"%s","commits":{"%s":{"parent":null,"runs":[["test","completed","success"]]}}}\n' "$G" "$G" > "$T/base.json"
sweep; sweep
check "AC2: once feat/y is green, its PR merges onto feat/y" 'grep -qx "203 feat/y $SHA3" "$T/merges.log"'

# ---- a sweep's lines are said once across sweeps, and every sweep reads the PRs once ------------
SHA4=4444444444444444444444444444444444444444
node -e 'const f = process.argv[1]; const p = JSON.parse(require("fs").readFileSync(f, "utf8")); p["204"] = { head: "fix/T-4", base: "feat/x", sha: process.argv[2], state: "open", draft: false, checks: [["test", "PENDING"]] }; require("fs").writeFileSync(f, JSON.stringify(p))' "$T/prs.json" "$SHA4"
DESK_BATCH=X-1 node "$B/queue.mjs" add T-4 Task A >/dev/null 2>&1; DESK_BATCH=X-1 node "$B/queue.mjs" set T-4 branch=fix/T-4 state=running >/dev/null 2>&1
echo 1 > "$T/sleep.pass"
sweep
check "two sweeps in one run read the PRs once each" '[ "$(lists)" = 2 ] && [ "$(wc -l < "$T/sleeps" | tr -d " ")" = 2 ]'
check "a PR's unchanged state is logged once across sweeps" '[ "$(echo "$out" | grep -c "#204 red at 444444444: required check")" = 1 ]'
check "each batch's loop says it is up only on the first sweep" '[ "$(echo "$out" | grep -c "merge driver up: .*base=feat/x")" = 1 ]'

# ---- TERM between sweeps lets every lock go -----------------------------------------------------
touch "$T/sleep.real"; rm -f "$T/sleep.pass" "$T/sleeps"
(MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --all-batches --log </dev/null >/dev/null 2>&1 &)
i=0; while ! grep -q "^120$" "$T/sleeps" 2>/dev/null && [ $i -lt 150 ]; do sleep 0.1; i=$((i + 1)); done
pid=$(cat "$RL/pid" 2>/dev/null)
check "a running driver holds the repo's lock and points every batch's" '[ -n "$pid" ] && [ "$(locks)" = "$pid $pid $pid $pid" ]'
kill -TERM "$pid" 2>/dev/null
i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
check "TERM stops it and lets the repo's lock and every pointer go" '! kill -0 "$pid" 2>/dev/null && [ "$(locks)" = "- - - -" ] && tail -1 "$SS/merge-driver.log" | grep -q "merge driver exited 143$"'
check "--log writes each batch's loop into that batch's own log" 'grep -q "#204" "$XS/merge-driver.log" && ! grep -q "#204" "$SS/merge-driver.log"'
rm -f "$T/sleep.real"

# ---- a batch with a driver of its own is left to it, the standing batch too ---------------------
/bin/sleep 30 & OWN=$!
mkdir -p "$SS/merge-driver.lock.d"; echo "$OWN" > "$SS/merge-driver.lock.d/pid"
atlist; sweep; seen=$(cat "$T/locks.seen" 2>/dev/null)
check "a session's driver on the standing batch does not stop the repo's driver, which leaves that batch to it" 'echo "$out" | grep -q "batch standing: its own merge driver (pid $OWN) runs it, so this one leaves it" && [ "$(cat "$SS/merge-driver.lock.d/pid")" = "$OWN" ] && echo "$out" | grep -q "merge driver up: .*base=feat/x" && ! echo "$out" | grep -q "merge driver up: .*base=main"'
check "the repo's driver holds its own lock, not the standing batch's" '[ "${seen%% *}" != - ] && [ "${seen%% *}" != "$OWN" ] && [ "$(echo "$seen" | cut -d" " -f2)" = "$OWN" ]'
kill "$OWN" 2>/dev/null; wait "$OWN" 2>/dev/null; rm -rf "$SS/merge-driver.lock.d"

# ---- a standing batch it does not cover keeps its lock free --------------------------------------
cp "$SQ" "$T/sq.json"; jq '.supervised = false' "$T/sq.json" > "$SQ"
atlist; sweep; seen=$(cat "$T/locks.seen" 2>/dev/null)
check "a standing batch not handed over gets no pointer, while the named batches do" '[ "$(echo "$seen" | cut -d" " -f2)" = - ] && [ "${seen%% *}" != - ] && [ "$(echo "$seen" | cut -d" " -f3)" = "${seen%% *}" ]'
cp "$T/sq.json" "$SQ"

# ---- a list as long as its limit falls back to each batch's own --------------------------------
: > "$T/gh.log"; out=$(MERGE_DRIVER_LIST_LIMIT=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --all-batches 2>&1); rc=$?
check "a PR list at its limit is said once, and each batch lists its own PRs that sweep" 'echo "$out" | grep -q "the open PR list reached its limit of 1, so each batch lists its own this sweep" && [ "$(grep -c "^pr list.*--base" "$T/gh.log")" -ge 3 ]'

# ---- signed out, the one PR list stops the driver -----------------------------------------------
touch "$T/gh.signedout"
sweep
check "a signed-out gh stops the driver, saying so" '[ $rc -eq 1 ] && echo "$out" | grep -q "FAIL: gh is signed out" && [ "$(locks)" = "- - - -" ]'
rm -f "$T/gh.signedout"

finish repo
