#!/usr/bin/env bash
# suite: compare_pass (a fixture comparison lists what a head's pass.mjs does differently from its base's)
# layer: L3
# tests/compare_pass.sh over scratch trees whose stand-in pass.mjs writes one queue field and prints one
# line: a head that matches lists nothing; one that writes a field or prints a line differently lists
# it; one whose pass crashes is not compared; one that moved a shell case into a unit suite still runs
# the base's case; a base commit's recording is cached and reused only while nothing it depends on
# changed. Then the real pass suite against itself lists nothing: all of it on a main push or the
# nightly run, otherwise only test_pass_other_repo.sh. Scratch dirs only.
# covers: tests/test_pass*.sh
# budget: 60 (main 1500) DS-942 a pull request's smoke replay ran 28 CPU s, a main push's full one 1004
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
# compare_pass.sh caches a base commit's recording here, never in the real cache.
export XDG_CACHE_HOME="$T/cache"
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }
cmp(){ out=$(bash "$S/compare_pass.sh" "$@" 2>/dev/null); rc=$?; }

# A tree whose pass.mjs sets A-1's state to $2 and prints "A-1 is $3", with the time, its own path and
# a fresh id in both, as a real pass's output and queue carry them, and a deadline $4 hours on (1 by
# default), as a pass works one out from now.
mktree(){ mkdir -p "$T/$1/desk/bin" "$T/$1/tests"
  cat > "$T/$1/desk/bin/pass.mjs" <<EOF
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const f = process.env.DESK_QUEUE, q = JSON.parse(readFileSync(f, 'utf8'));
q.tickets['A-1'] = { ...q.tickets['A-1'], state: '$2', at: new Date().toISOString(), id: randomUUID(), by: import.meta.url,
  due: new Date(Date.now() + ${4:-1} * 3600e3).toISOString() };
writeFileSync(f, JSON.stringify(q));
console.log('A-1 is $3 at ' + new Date().toISOString() + ' from ' + import.meta.url + '${5:-}');
EOF
  cat > "$T/$1/tests/test_pass.sh" <<'EOF'
#!/usr/bin/env bash
SRC="$(cd "$(dirname "$0")/.." && pwd)"; B="$SRC/desk/bin"; D="$(mktemp -d)"
export DESK_QUEUE="$D/queue.json"
echo '{"tickets":{"A-1":{"state":"triaged","added_at":"2026-01-02T03:04:05Z"}}}' > "$DESK_QUEUE"
out=$(node "$B/pass.mjs" 2>&1)
if grep -q '"state":"running"' "$DESK_QUEUE"; then echo "ok   the first pass"; else echo "FAIL the first pass"; fi
node -e 'process.exit(0)'; echo "ok   a node run that is no pass"
out=$(node "$B/pass.mjs" 2>&1); echo "ok   the second pass"
rm -rf "$D"
EOF
}
mktree base running running
mktree same running running
mktree field parked running
mktree line running working
mktree crash running running
# The crash tree's pass imports a phase module it does not have, so it never runs.
{ echo 'import "./missing-phase.mjs";'; cat "$T/base/desk/bin/pass.mjs"; } > "$T/crash/desk/bin/pass.mjs"

cmp "$T/base" "$T/same"
check "DS-763 AC1 a head that matches its base lists nothing" '[ $rc = 0 ] && [ "$out" = "compare_pass: 2 pass run(s) compared, 0 differ, 0 not compared" ]'
check "DS-763 AC4 times, ids and paths that differ between the trees are not reported" '[ $rc = 0 ] && ! echo "$out" | grep -q "<TIME>\|<TREE>\|<UUID>"'

cmp "$T/base" "$T/field"
check "DS-763 AC2 a queue field written differently lists the ticket, the field and both values" '[ $rc = 1 ] && echo "$out" | grep -qxF "  queue A-1 state: base \"running\", head \"parked\""'
check "DS-763 AC2 the difference names the run and the check after it" 'echo "$out" | grep -qxF "test_pass.sh run 1 (before: the first pass):" && echo "$out" | grep -qxF "test_pass.sh run 2 (before: the second pass):"'
check "DS-763 AC2 only that field differs" '[ "$(echo "$out" | grep -c "^  ")" = 2 ]'
check "DS-763 a check of the base's that fails on the head only is listed" 'echo "$out" | grep -qxF "test_pass.sh: a check fails on the head only: the first pass"'

cmp "$T/base" "$T/line"
check "DS-763 AC3 a report line printed differently lists both lines" '[ $rc = 1 ] && echo "$out" | grep -qxF "  output base: A-1 is running at <TIME> from file://<TREE>/desk/bin/pass.mjs" && echo "$out" | grep -qxF "  output head: A-1 is working at <TIME> from file://<TREE>/desk/bin/pass.mjs" && ! echo "$out" | grep -q "queue"'

mktree due running running 2
cmp "$T/base" "$T/due"
check "DS-763 AC2 a deadline worked out from now differently lists both times" '[ $rc = 1 ] && echo "$out" | grep -qE "^  queue A-1 due: base \"20[0-9-]+T[0-9:.]+Z\", head \"20[0-9-]+T[0-9:.]+Z\"$" && [ "$(echo "$out" | grep -c "^  ")" = 2 ]'

# An elapsed wall time two runs print a second apart is noise; one minutes apart is a difference.
mktree wall0 running running 1 ' (0m 00s since it started)'
mktree wall1 running running 1 ' (0m 01s since it started)'
mktree wall5 running running 1 ' (5m 00s since it started)'
cmp "$T/wall0" "$T/wall1"
check "#917 an elapsed wall time a second apart on the two trees is not reported" '[ $rc = 0 ] && [ "$out" = "compare_pass: 2 pass run(s) compared, 0 differ, 0 not compared" ]'
cmp "$T/wall0" "$T/wall5"
check "#917 one minutes apart is listed, with both times" '[ $rc = 1 ] && echo "$out" | grep -qF "(0m 00s since it started)" && echo "$out" | grep -qF "(5m 00s since it started)"'

# A tree whose pass sets A-1 running with the fields $2 (JavaScript, `now` being the time it runs) and
# prints $3: what two runs of one tree write differently without behaving differently.
fieldtree(){ mkdir -p "$T/$1/desk/bin" "$T/$1/tests"; cp "$T/base/tests/test_pass.sh" "$T/$1/tests/"
  cat > "$T/$1/desk/bin/pass.mjs" <<EOF
import { readFileSync, writeFileSync } from 'node:fs';
const f = process.env.DESK_QUEUE, q = JSON.parse(readFileSync(f, 'utf8')), now = Date.now();
q.tickets['A-1'] = { ...q.tickets['A-1'], state: 'running', $2 };
writeFileSync(f, JSON.stringify(q));
console.log(\`$3\`);
EOF
}
same0='[ $rc = 0 ] && [ "$out" = "compare_pass: 2 pass run(s) compared, 0 differ, 0 not compared" ]'

fieldtree port1 'port: 47704, cloud: { port: 47704 }' 'spawned: A-1 port=47704 model=default\n  RUNNING  A-1  stage 4b  port 47704  on localhost:47704'
fieldtree port2 'port: 47705, cloud: { port: 47705 }' 'spawned: A-1 port=47705 model=default\n  RUNNING  A-1  stage 4b  port 47705  on localhost:47705'
cmp "$T/port1" "$T/port2"
check "DS-819 AC1 a port that differs in a queue field and a report line is not reported" "$same0"
fieldtree port3 'port: 47704, cloud: { port: 47705 }' 'spawned: A-1 port=47704 model=default\n  RUNNING  A-1  stage 4b  port 47704  on localhost:47704'
cmp "$T/port1" "$T/port3"
check "DS-819 AC1 two ports where the base had one is still listed" '[ $rc = 1 ] && echo "$out" | grep -qxF "  queue A-1 port: base port <PORT1>, head port <PORT2>"'

for form in '15d 12h|15d 13h' '2h 05m|2h 06m' '2h 5m|2h 6m' '0m 05s|0m 09s' '0m|1m'; do
  fieldtree span1 '' "A-1 in_progress for ${form%|*}"; fieldtree span2 '' "A-1 in_progress for ${form#*|}"
  cmp "$T/span1" "$T/span2"
  check "DS-819 AC2 an elapsed time ${form%|*} against ${form#*|} is not reported" "$same0"
done
fieldtree span1 '' 'A-1 in_progress for 15d 12h'; fieldtree span2 '' 'A-1 in_progress for 17d 12h'
cmp "$T/span1" "$T/span2"
check "DS-819 AC2 an elapsed time in days two days apart is listed" '[ $rc = 1 ] && echo "$out" | grep -qF "for 15d 12h" && echo "$out" | grep -qF "for 17d 12h"'
fieldtree span1 '' 'A-1 in_progress for 3m'; fieldtree span2 '' 'A-1 in_progress for 9m'
cmp "$T/span1" "$T/span2"
check "an elapsed time in bare minutes six minutes apart is listed" '[ $rc = 1 ] && echo "$out" | grep -qF "for 3m" && echo "$out" | grep -qF "for 9m"'

# An error the pass cuts at a length, at a different place on each tree as a port before the cut is
# longer on one, carrying each tree's own path and SHA: cut on both trees in the queue, and on one only
# in the report line.
cut='set state=running worktree=${import.meta.url} port=4770 idle_pas… — fetching ${process.env.SHA} failed'
fieldtree cut1 "why: \`$cut\`" "failed: $cut"
fieldtree cut2 "why: \`set state=running worktree=\${import.meta.url} port=47705 idle_passes=0 lo… — fetching \${process.env.SHA} failed\`" 'failed: set state=running worktree=${import.meta.url} port=47705 idle_passes=0 log_bytes=97 — fetching ${process.env.SHA} failed'
printf '#!/usr/bin/env bash\nD="$(mktemp -d)"; export DESK_QUEUE="$D/queue.json"\necho %s > "$DESK_QUEUE"\n' "'{\"tickets\":{}}'" > "$T/cut1/tests/test_pass.sh"
printf 'case "$PWD" in */base) export SHA=4a1f0c2e9 ;; *) export SHA=8b2e1d3f7 ;; esac\nnode desk/bin/pass.mjs; echo "ok   the pass"\n' >> "$T/cut1/tests/test_pass.sh"
cp "$T/cut1/tests/test_pass.sh" "$T/cut2/tests/test_pass.sh"
cmp "$T/cut1" "$T/cut2"
check "DS-819 AC3 error text alike up to where one side is cut, past masked paths and SHAs, is not reported" '[ $rc = 0 ] && [ "$out" = "compare_pass: 1 pass run(s) compared, 0 differ, 0 not compared" ]'
fieldtree cut2 "why: \`set state=parked worktree=\${import.meta.url} port=47705 idle_passes=0 lo… — fetching \${process.env.SHA} failed\`" 'failed: set state=parked worktree=${import.meta.url} port=47705 idle_passes=0 log_bytes=97 — fetching ${process.env.SHA} failed'
cp "$T/cut1/tests/test_pass.sh" "$T/cut2/tests/test_pass.sh"
cmp "$T/cut1" "$T/cut2"
check "DS-819 AC4 error text that differs before the cut is listed" '[ $rc = 1 ] && echo "$out" | grep -qF "queue A-1 why: base" && echo "$out" | grep -qF "output head: failed: set state=parked"'
fieldtree word1 'why: "set A-1 state=runn… — fetching failed"' 'failed: set A-1 state=runn… — fetching failed'
fieldtree word2 'why: "set A-1 state=park… — fetching failed"' 'failed: set A-1 state=park… — fetching failed'
cmp "$T/word1" "$T/word2"
check "DS-819 AC4 a difference inside the word the cut falls in, before the cut, is listed" '[ $rc = 1 ] && echo "$out" | grep -qF "queue A-1 why: base" && echo "$out" | grep -qF "output head: failed: set A-1 state=park…"'
# A port the cut falls just after on one tree and whole on the other: the next port has one name on both.
fieldtree cutport1 '' 'failed: set A-1 port=47704… — fetching failed\n  RUNNING  A-2  on localhost:47801'
fieldtree cutport2 '' 'failed: set A-1 port=47705 idl… — fetching failed\n  RUNNING  A-2  on localhost:47802'
cmp "$T/cutport1" "$T/cutport2"
check "DS-819 AC1 a port cut short on one tree does not shift the names of the ports after it" "$same0"
fieldtree cutport3 '' 'failed: set A-1 port=4… — fetching failed\n  RUNNING  A-2  on localhost:47801\n  RUNNING  A-3  on localhost:47802'
fieldtree cutport4 '' 'failed: set A-1 port=47705 idl… — fetching failed\n  RUNNING  A-2  on localhost:47802\n  RUNNING  A-3  on localhost:47803'
cmp "$T/cutport3" "$T/cutport4"
check "DS-819 AC1 a port cut to its first digit does not give its name to the ports after it" "$same0"
fieldtree cutport5 '' 'failed: set A-1 port=47… — fetching failed\n  RUNNING  A-2  on localhost:47704\n  RUNNING  A-3  on localhost:47704'
fieldtree cutport6 '' 'failed: set A-1 port=47… — fetching failed\n  RUNNING  A-2  on localhost:47705\n  RUNNING  A-3  on localhost:47706'
cmp "$T/cutport5" "$T/cutport6"
check "DS-819 AC1 after a cut port, two tickets on one port where the base had two ports is still listed" '[ $rc = 1 ] && echo "$out" | grep -qF "output head:   RUNNING  A-3  on localhost:<PORT2>"'
# A port and a SHA in a line cut on one tree only, then whole ones after it: they stand one for one,
# and one port on the head where the base had two is still listed.
fieldtree cutline1 '' 'failed: set A-1 port=47704 ref 4a1f0c2e9 idle_pas… — fetching failed\n  RUNNING  A-2  on localhost:47801 at 5f6a7b8c9\n  RUNNING  A-3  on localhost:47802'
fieldtree cutline2 '' 'failed: set A-1 port=47705 ref 8b2e1d3f7 idle_passes=0 port=47999 ref 0c1d2e3f4 log_bytes=97 — fetching failed\n  RUNNING  A-2  on localhost:47901 at 1b2c3d4e5\n  RUNNING  A-3  on localhost:47902'
cmp "$T/cutline1" "$T/cutline2"
check "DS-819 AC3 a port and SHA in a line cut on one tree only do not shift the ports and SHAs after it" "$same0"
fieldtree cutline3 '' 'failed: set A-1 port=47705 ref 8b2e1d3f7 idle_passes=0 port=47999 ref 0c1d2e3f4 log_bytes=97 — fetching failed\n  RUNNING  A-2  on localhost:47901 at 1b2c3d4e5\n  RUNNING  A-3  on localhost:47901'
cmp "$T/cutline1" "$T/cutline3"
check "DS-819 AC1 after a line cut on one tree only, one port where the base had two is still listed" '[ $rc = 1 ] && echo "$out" | grep -qF "output head:   RUNNING  A-3  on localhost:<PORT"'
# A SHA cut short, all digits on one tree and not on the other: the next SHA has one name on both.
fieldtree cutsha1 '' 'failed: set A-1 ref 332065893… — fetching failed\nhead at 1b2c3d4e5'
fieldtree cutsha2 '' 'failed: set A-1 ref 4a1f0c2e9… — fetching failed\nhead at 5f6a7b8c9'
cmp "$T/cutsha1" "$T/cutsha2"
check "DS-819 AC3 a SHA cut short, all digits on one tree, does not shift the names of the SHAs after it" "$same0"

fieldtree git1 'why: "fetching the head failed: fatal: remote error: upload-pack: not our ref 4a1f0c2e9"' 'fetching the head failed: fatal: remote error: upload-pack: not our ref 4a1f0c2e9'
fieldtree git2 'why: "fetching the head failed: fatal: git upload-pack: not our ref 4a1f0c2e9"' 'fetching the head failed: fatal: git upload-pack: not our ref 4a1f0c2e9'
cmp "$T/git1" "$T/git2"
check "DS-819 AC3 git's two wordings of one refused fetch are not reported" "$same0"

# A queue stamp an hour apart on the two trees, as one written late under load is; and one set on the head only.
fieldtree stamp1 'updated_at: new Date(now).toISOString(), spawned_at: now, last_start: new Date(now).toISOString(), cloud: { started: new Date(now).toISOString() }' 'A-1 running'
fieldtree stamp2 'updated_at: new Date(now + 3600e3).toISOString(), spawned_at: now + 3600e3, last_start: new Date(now + 3600e3).toISOString(), cloud: { started: new Date(now + 3600e3).toISOString() }' 'A-1 running'
cmp "$T/stamp1" "$T/stamp2"
check "DS-819 AC5 queue stamps that differ only in value are not reported" "$same0"
fieldtree stamp0 'updated_at: new Date(now).toISOString(), spawned_at: null, last_start: new Date(now).toISOString(), cloud: { started: new Date(now).toISOString() }' 'A-1 running'
cmp "$T/stamp0" "$T/stamp1"
check "DS-819 AC6 a queue stamp the head sets and the base leaves unset is listed" '[ $rc = 1 ] && echo "$out" | grep -qxF "  queue A-1 spawned_at: base null, head <STAMP:number>" && [ "$(echo "$out" | grep -c "^  ")" = 2 ]'
fieldtree stamp3 'updated_at: new Date(now).toISOString(), spawned_at: new Date(now).toISOString(), last_start: new Date(now).toISOString(), cloud: { started: new Date(now).toISOString() }' 'A-1 running'
cmp "$T/stamp1" "$T/stamp3"
check "DS-819 AC6 a queue stamp written as a string where the base wrote a number is listed" '[ $rc = 1 ] && echo "$out" | grep -qxF "  queue A-1 spawned_at: base <STAMP:number>, head <STAMP:string>"'

# Each tree's commit abbreviated as the pass prints it: one of them all digits, as one in about 70 is.
mktree shabase running running 1 ' at origin/main 332065893'
mktree shahead running running 1 ' at origin/main 4a1f0c2e9'
cmp "$T/shabase" "$T/shahead"
check "DS-763 AC4 an abbreviated SHA that is all digits matches the other tree's" '[ $rc = 0 ] && [ "$out" = "compare_pass: 2 pass run(s) compared, 0 differ, 0 not compared" ]'
# Each tree's random lease id as the pass prints it: one of them all digits, as one in about 110 is.
mktree leasebase running running 1 ' (lease L-5496517265, 34 units)'
mktree leasehead running running 1 ' (lease L-3a9f0c2e17, 34 units)'
cmp "$T/leasebase" "$T/leasehead"
check "DS-763 AC4 a lease id that is all digits matches the other tree's" '[ $rc = 0 ] && [ "$out" = "compare_pass: 2 pass run(s) compared, 0 differ, 0 not compared" ]'

# A tree whose suite leaves the usage probe start stamp in its own usage dir ($CMP_PROBE_USAGE when
# set) ten minutes old before its first pass and 90 seconds old before its second, and whose pass
# prints how old it reads that stamp as: the base's prints what a suite run in under five minutes
# sees, the head's reads it.
probetree(){ mktree "$1" running running
  cat >> "$T/$1/desk/bin/pass.mjs" <<EOF
const age = Date.now() - Number(readFileSync(process.env.DESK_USAGE_DIR + '/probe.at', 'utf8'));
console.log($2);
EOF
  cat > "$T/$1/tests/test_pass.sh" <<'EOF'
#!/usr/bin/env bash
SRC="$(cd "$(dirname "$0")/.." && pwd)"; B="$SRC/desk/bin"; D="$(mktemp -d)"
export DESK_QUEUE="$D/queue.json" DESK_USAGE_DIR="${CMP_PROBE_USAGE:-$D/usage}"; mkdir -p "$DESK_USAGE_DIR"
echo '{"tickets":{"A-1":{"state":"triaged"}}}' > "$DESK_QUEUE"
echo $(( $(date +%s) * 1000 - 600000 )) > "$DESK_USAGE_DIR/probe.at"
out=$(node "$B/pass.mjs" 2>&1); echo "ok   the first pass"
echo $(( $(date +%s) * 1000 - 90000 )) > "$DESK_USAGE_DIR/probe.at"
out=$(node "$B/pass.mjs" 2>&1); echo "ok   the second pass"
rm -rf "$D"
EOF
}
probetree probebase "'past the gap'"
probetree probehead "age > 300e3 ? 'probe due' : age > 60e3 ? 'past the gap' : 'in the gap'"
cmp "$T/probebase" "$T/probehead"
check "a probe stamp a suite left over five minutes old reads as under it, and one past the minute stays past it" '[ $rc = 0 ] && [ "$out" = "compare_pass: 2 pass run(s) compared, 0 differ, 0 not compared" ]'
# The same suite with the machine's usage dir as its own: its stamp is left ten minutes old.
out=$(env -u DESK_USAGE_DIR HOME="$T/live" CMP_PROBE_USAGE="$T/live/.desk-autopilot/usage" bash "$S/compare_pass.sh" "$T/probebase" "$T/probehead" 2>/dev/null); rc=$?
check "a usage dir that is the machine's own keeps its probe stamps as the suite left them" '[ $rc = 1 ] && echo "$out" | grep -qxF "  output head: probe due"'

# An evidence fix keyed by the id each tree's pass hashed from its own start time, one of them all
# digits, filed between two tickets so the key sorts differently on each tree, and its key printed.
fixtree(){ mkdir -p "$T/$1/desk/bin" "$T/$1/tests"; cp "$T/base/tests/test_pass.sh" "$T/$1/tests/"
  cat > "$T/$1/desk/bin/pass.mjs" <<EOF
import { readFileSync, writeFileSync } from 'node:fs';
const f = process.env.DESK_QUEUE, q = JSON.parse(readFileSync(f, 'utf8'));
q.tickets['A-1'] = { ...q.tickets['A-1'], state: 'running' };
q.tickets['evidence-fix-$2'] = { state: '${3:-queued}', file: 'fix-$2.md' };
q.tickets['Z-1'] = { state: 'queued' };
writeFileSync(f, JSON.stringify(q));
console.log('filed evidence-fix-$2');
EOF
}
fixtree fixbase 12345678
fixtree fixhead f0a1b2c3
cmp "$T/fixbase" "$T/fixhead"
check "DS-763 AC4 an evidence fix keyed by an id hashed from the pass's start time is the same ticket on both trees" '[ $rc = 0 ] && [ "$out" = "compare_pass: 2 pass run(s) compared, 0 differ, 0 not compared" ]'
fixtree fixother f0a1b2c3 parked
cmp "$T/fixbase" "$T/fixother"
check "DS-763 AC2 a field of that evidence fix written differently is still listed" '[ $rc = 1 ] && echo "$out" | grep -qxF "  queue evidence-fix-<SHA1> state: base \"queued\", head \"parked\""'

# A suite that makes the same empty commit in two clones, a second apart on the head tree only, and a
# pass that prints both SHAs: one SHA on a tree that made them in the same second, two on one that did not.
mkdir -p "$T/commits/desk/bin" "$T/commits/tests"
echo "console.log('heads ' + process.env.C1 + ' ' + process.env.C2);" > "$T/commits/desk/bin/pass.mjs"
cat > "$T/commits/tests/test_pass.sh" <<'EOF'
#!/usr/bin/env bash
SRC="$(cd "$(dirname "$0")/.." && pwd)"; D="$(mktemp -d)"
c(){ git init -q "$D/$1" && git -C "$D/$1" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m same && git -C "$D/$1" rev-parse HEAD; }
C1=$(c one); case "$SRC" in */head) sleep 1 ;; esac; C2=$(c two)
C1=$C1 C2=$C2 node "$SRC/desk/bin/pass.mjs" >/dev/null; echo "ok   the commits"
rm -rf "$D"
EOF
cmp "$T/commits" "$T/commits"
check "DS-763 AC4 the same commit made in different seconds on the two trees has one SHA on both" '[ $rc = 0 ] && [ "$out" = "compare_pass: 1 pass run(s) compared, 0 differ, 0 not compared" ]'

cmp "$T/base" "$T/crash"
check "DS-763 AC5 a pass that fails to run on one tree is reported not compared, and the run exits non-zero" '[ $rc = 2 ] && echo "$out" | grep -qF "test_pass.sh run 1 (before: the first pass): not compared: the pass failed to run on the head: Error [ERR_MODULE_NOT_FOUND]" && echo "$out" | grep -qE "^compare_pass: 0 pass run\(s\) compared, [0-9]+ differ, 2 not compared$"'
cmp "$T/crash" "$T/base"
check "DS-763 AC5 a crash on the base is not compared either" '[ $rc = 2 ] && echo "$out" | grep -qF "not compared: the pass failed to run on the base"'

# PASS_CMP_KEEP=1 ($1 is 1 or empty), each run in its own scratch TMPDIR $2: the list on stdout, the
# directory it kept (if it says so) and the command it prints to list them again.
keep(){ mkdir -p "$T/$2"
  err=$(PASS_CMP_KEEP=$1 TMPDIR="$T/$2" bash "$S/compare_pass.sh" "$3" "$4" 2>&1 >"$T/$2.out"); rc=$?
  out=$(cat "$T/$2.out"); kept=; redo=$(echo "$err" | grep '^  node ')
  case "$err" in *"kept the recordings and both trees in "*) kept=${err#*kept the recordings and both trees in }; kept=${kept%%; list them again*} ;; esac; }
keep 1 keepfield "$T/base" "$T/field"
check "DS-962 AC1 with the keep switch, a run that differs keeps its recordings and both trees and prints where" '[ $rc = 1 ] && [ -n "$kept" ] && [ -d "$kept/rec/base/test_pass.sh" ] && [ -d "$kept/rec/head/test_pass.sh" ] && [ -f "$kept/base/desk/bin/pass.mjs" ] && [ -f "$kept/head/desk/bin/pass.mjs" ]'
first=$out; out=$(eval "$redo" 2>/dev/null); rc=$?
check "DS-962 AC4 the printed diff on the kept directory lists the same differences again" '[ $rc = 1 ] && [ -n "$out" ] && [ "$out" = "$first" ]'
keep 1 keepsame "$T/base" "$T/same"
check "DS-962 AC2 with the keep switch, a run that lists nothing removes its scratch directory" '[ $rc = 0 ] && [ -z "$kept" ] && [ -z "$(ls -A "$T/keepsame")" ]'
keep '' keepoff "$T/base" "$T/field"
check "DS-962 AC3 without the keep switch, a run that differs removes its scratch directory" '[ $rc = 1 ] && [ -z "$kept" ] && [ -z "$(ls -A "$T/keepoff")" ]'
keep 1 keepcrash "$T/base" "$T/crash"
check "DS-962 AC5 with the keep switch, a run not compared keeps its recordings too" '[ $rc = 2 ] && [ -n "$kept" ] && [ -d "$kept/rec/head/test_pass.sh" ] && [ -f "$kept/head/desk/bin/pass.mjs" ]'

# The head moved its second case into a unit suite: the base's two cases still run against it.
mktree moved running running
printf '#!/usr/bin/env bash\nSRC="$(cd "$(dirname "$0")/.." && pwd)"; B="$SRC/desk/bin"\nnode -e 1; echo "ok   the first pass, all that is left"\n' > "$T/moved/tests/test_pass.sh"
printf '%s\n' '// suite: the second pass, now a unit test' 'console.log("ok   the second pass");' > "$T/moved/tests/test_pass_unit.mjs"
cmp "$T/base" "$T/moved"
check "DS-763 AC6 a head that moved a case into a unit suite runs the base's cases and lists nothing" '[ $rc = 0 ] && [ "$out" = "compare_pass: 2 pass run(s) compared, 0 differ, 0 not compared" ]'

# A base and head given as commits of a repo, as a later child compares its branch with main.
git init -q -b main "$T/repo"; cp -R "$T/base/." "$T/repo/"
git -C "$T/repo" add -A; git -C "$T/repo" -c user.name=t -c user.email=t@example.com commit -qm base
cp "$T/field/desk/bin/pass.mjs" "$T/repo/desk/bin/pass.mjs"
git -C "$T/repo" -c user.name=t -c user.email=t@example.com commit -qam head
mkdir -p "$T/repo/tests"; cp "$S/compare_pass.sh" "$S/compare_pass.mjs" "$S/suite_env.sh" "$T/repo/tests/"; cp "$SRC/desk/bin/dir-lock.mjs" "$SRC/desk/bin/queue-fields.mjs" "$T/repo/desk/bin/"
out=$(bash "$T/repo/tests/compare_pass.sh" HEAD~1 HEAD 2>/dev/null); rc=$?
check "DS-763 base and head given as commits compare those commits" '[ $rc = 1 ] && echo "$out" | grep -qxF "  queue A-1 state: base \"running\", head \"parked\""'
cmp --suite test_nope.sh "$T/base" "$T/same"
check "DS-763 a suite the base lacks is refused" '[ $rc = 2 ]'

# The base's recording cached by commit, in a repo whose base has two suites. ccmp keeps stderr, which
# names each suite as it replays on each tree, and says whether the base was cached and if not why.
CD="$T/cache/desk-skills/compare-pass"; rm -rf "$CD"
git init -q -b main "$T/crepo"; cp -R "$T/base/." "$T/crepo/"; cp "$T/crepo/tests/test_pass.sh" "$T/crepo/tests/test_pass_b.sh"
commit(){ git -C "$T/crepo" add -A; git -C "$T/crepo" -c user.name=t -c user.email=t@example.com commit -qm "$1"; }
commit base; cp "$T/line/desk/bin/pass.mjs" "$T/crepo/desk/bin/pass.mjs"; commit head
cp "$S/compare_pass.sh" "$S/compare_pass.mjs" "$S/suite_env.sh" "$T/crepo/tests/"; cp "$SRC/desk/bin/dir-lock.mjs" "$SRC/desk/bin/queue-fields.mjs" "$T/crepo/desk/bin/"
ccmp(){ out=$(bash "$T/crepo/tests/compare_pass.sh" "$@" 2>"$T/err"); rc=$?; }
replayed(){ grep -q " on the base$" "$T/err"; }
entries(){ find "$CD" -name '*.tar' 2>/dev/null | wc -l | tr -d ' '; }
ccmp HEAD~1 HEAD; first=$out; firstrc=$rc
check "DS-963 a base commit's first comparison replays it and caches its recording" '[ $rc = 1 ] && replayed && [ "$(entries)" = 1 ] && grep -q "^compare_pass: cached the base.s recording as $CD/[0-9a-f]*\.tar$" "$T/err"'
ccmp HEAD~1 HEAD
check "DS-963 AC1 a cached base is not replayed, the head is, and the result is the uncached one" '! replayed && grep -q " on the head$" "$T/err" && [ $rc = "$firstrc" ] && [ "$out" = "$first" ] && [ "$(entries)" = 1 ]'
mkdir -p "$T/keepc"; PASS_CMP_KEEP=1 TMPDIR="$T/keepc" ccmp HEAD~1 HEAD; redo=$(grep '^  node ' "$T/err")
check "DS-963 with the keep switch, a comparison against a cached base prints a command that lists it again" '! replayed && [ -n "$redo" ] && [ "$(eval "$redo" 2>/dev/null)" = "$first" ]'
PASS_CMP_CACHE=0 ccmp HEAD~1 HEAD
check "DS-963 AC7 with the cache off both trees are replayed" 'replayed && [ "$out" = "$first" ]'
ccmp HEAD HEAD
check "DS-963 AC2 another base commit is replayed" 'replayed && [ "$(entries)" = 2 ]'
ccmp --suite test_pass.sh HEAD~1 HEAD
check "DS-963 AC2 another set of suites replays the base" 'replayed && [ "$(entries)" = 3 ]'
mkdir -p "$T/fake"
for tool in node git; do
  printf '#!/bin/sh\n[ "$1" = --version ] && { echo "%s version 0.0.0"; exit 0; }\nexec %s "$@"\n' "$tool" "$(command -v $tool)" > "$T/fake/$tool"; chmod +x "$T/fake/$tool"
  PATH="$T/fake:$PATH" ccmp HEAD~1 HEAD
  check "DS-963 AC2 another $tool version replays the base" 'replayed && [ "$out" = "$first" ]'
  rm "$T/fake/$tool"
done
for f in compare_pass.sh compare_pass.mjs suite_env.sh; do
  cp "$T/crepo/tests/$f" "$T/$f.orig"; echo '' >> "$T/crepo/tests/$f"
  ccmp HEAD~1 HEAD
  check "DS-963 AC3 a changed $f replays the base" 'replayed && [ "$out" = "$first" ]'
  cp "$T/$f.orig" "$T/crepo/tests/$f"
done
# The usage probe the recorder holds stamps by, which the fixture checkout lacked until now.
printf 'export const PROBE_EVERY_MS = 300000, PROBE_GAP_MS = 60000;\nexport const usageDir = () => process.env.DESK_USAGE_DIR || "%s";\n' "$T/nousage" > "$T/crepo/desk/bin/usage-probe.mjs"
ccmp HEAD~1 HEAD
check "DS-963 AC3 a changed usage-probe.mjs, whose timings the recorder holds probe stamps by, replays the base" 'replayed && [ "$out" = "$first" ]'
rm "$T/crepo/desk/bin/usage-probe.mjs"
touch "$T/mark"; ccmp "$T/base" "$T/same"; ccmp "$T/base" "$T/same"
check "DS-963 AC4 a base given as a directory is replayed every time and never cached" 'replayed && [ $rc = 0 ] && ! find "$CD" -newer "$T/mark" -name "*.tar" | grep -q .'
# A base whose pass crashes, and one whose suite is stopped by a signal, as Ctrl-C stops one.
cp "$T/crash/desk/bin/pass.mjs" "$T/crepo/desk/bin/pass.mjs"; commit crash
ccmp HEAD HEAD~1; ccmp HEAD HEAD~1
check "DS-963 AC5 a base replay in which a pass crashed is not cached, and says which suite kept it out" '[ $rc = 2 ] && replayed && grep -q "^compare_pass: the base.s recording is not cached: test_pass" "$T/err"'
cp "$T/field/desk/bin/pass.mjs" "$T/crepo/desk/bin/pass.mjs"; echo 'kill -TERM $$' >> "$T/crepo/tests/test_pass.sh"; commit stopped
ccmp HEAD HEAD~2; ccmp HEAD HEAD~2
check "DS-963 AC5 a base replay that was stopped is not cached, and says so" 'replayed && grep -q "^compare_pass: the base.s recording is not cached: .*test_pass\.sh" "$T/err"'
# A base suite that fails a check, as one does on a machine that lacks a tool it uses.
cp "$T/base/desk/bin/pass.mjs" "$T/crepo/desk/bin/pass.mjs"
cp "$T/base/tests/test_pass.sh" "$T/crepo/tests/test_pass.sh"; echo 'echo "FAIL a tool this machine lacks"' >> "$T/crepo/tests/test_pass.sh"; commit failing
ccmp HEAD HEAD~3
check "DS-963 a base suite that failed a check is left out of the entry, which names the check" 'grep -qE "^compare_pass: cached the base.s recording as $CD/[0-9a-f]+\.tar, but for test_pass\.sh: FAIL a tool this machine lacks$" "$T/err"'
ccmp HEAD HEAD~3
check "DS-963 only the base suite the entry lacks is replayed on the base again" 'grep -q "^compare_pass: the base.s recording is cached but for test_pass.sh, so only those are replayed" "$T/err" && grep -q "test_pass.sh on the base$" "$T/err" && ! grep -q "test_pass_b.sh on the base$" "$T/err"'
rm -rf "$CD"; mkdir -p "$CD"
for i in 1 2 3 4 5; do touch -t "20200101000$i" "$CD/old$i.tar"; done
ccmp HEAD~4 HEAD~3
check "DS-963 AC8 a sixth entry removes the oldest, keeping 5" '[ "$(entries)" = 5 ] && [ ! -e "$CD/old1.tar" ] && [ -e "$CD/old2.tar" ]'
ccmp HEAD~4 HEAD~3
check "DS-963 AC8 the entry just written is the one kept" '! replayed'
# A cached base's run an hour and 5 seconds before the head's: a deadline worked out 2 hours on, where
# the head works out 1, reads 5 seconds apart, and is still a difference; a time the run made, a fixed
# one and an elapsed time a few seconds apart are not.
farrec(){ mkdir -p "$T/far/$1/test_pass.sh"; node -e '
const [f, start, due, span] = process.argv.slice(1), s = Number(start), iso = (t) => new Date(t).toISOString();
require("fs").writeFileSync(f, JSON.stringify({ run: 1, started: s, at_line: 0, exit: 0, signal: null,
  out: `A-1 in_progress for ${span}\n`, archive: null, queue: { tickets: { "A-1": { at: iso(s + 1000),
  due: iso(s + due * 3600e3), added_at: "2026-01-02T03:04:05Z" } } } }));' "$T/far/$1/test_pass.sh/1.json" "$2" "$3" "$4"; }
farrec base 1780000000000 2 '0m 05s'; farrec head 1780003605000 1 '0m 09s'
out=$(node "$S/compare_pass.mjs" diff --base-cached "$T/far/base" "$T/far/head" "$T/far"); rc=$?
check "DS-963 AC1 against a cached base a deadline worked out differently is listed though it reads seconds apart" '[ $rc = 1 ] && echo "$out" | grep -qE "^  queue A-1 due: base \"[0-9TZ:.-]+\", head \"[0-9TZ:.-]+\"$" && [ "$(echo "$out" | grep -c "^  ")" = 1 ]'
# When only some base suites came from the cache, the rest were replayed beside the head and are
# matched as in a run without the cache.
fresh=$(node "$S/compare_pass.mjs" diff "$T/far/base" "$T/far/head" "$T/far"); frc=$?
out=$(node "$S/compare_pass.mjs" diff --base-cached=test_other.sh "$T/far/base" "$T/far/head" "$T/far"); rc=$?
check "DS-963 AC1 a base suite replayed in this run is matched as without the cache, though another came from it" '[ $rc = "$frc" ] && [ "$out" = "$fresh" ]'
out=$(node "$S/compare_pass.mjs" diff --base-cached=test_other.sh,test_pass.sh "$T/far/base" "$T/far/head" "$T/far"); rc=$?
check "DS-963 AC1 a base suite named as cached is matched by run only" '[ $rc = 1 ] && echo "$out" | grep -q "^  queue A-1 due: "'
# Records as the recorder saves them, of one suite whose two runs park P-1: run 1 ran from $2 to $3 ms
# after an epoch of its tree's own ($7), parking at $4 ms with question $5; run 2 started at $6 ms and
# holds the park, as run 1 does once it was written. What a loaded machine makes of one park: written further into its run on one tree.
recs(){ mkdir -p "$T/recs/$1/s.sh"; node -e '
  const [dir, epoch, s, e, at, question, s2] = process.argv.slice(1), t = (ms) => Number(epoch) + Number(ms);
  const park = { question, since: new Date(t(at)).toISOString() };
  const rec = (run, started, ended) => JSON.stringify({ run, started: t(started), ended: t(ended), at_line: 0, exit: 0, signal: null, out: "",
    queue: { tickets: t(ended) < t(at) && t(at) < t(s2) ? {} : { "P-1": { state: "parked", park } } }, archive: null });
  require("fs").writeFileSync(dir + "/1.json", rec(1, s, e));
  require("fs").writeFileSync(dir + "/2.json", rec(2, s2, Number(s2) + 1000));
' "$T/recs/$1/s.sh" "$7" "$2" "$3" "$4" "$5" "$6"; }
pdiff(){ out=$(node "$S/compare_pass.mjs" diff "$T/recs/$1" "$T/recs/$2" "$T/recs/$1" "$T/recs/$2"); rc=$?; }
recs pb 0 2000 1250 'repo could not be refreshed' 3000 1795273210286
recs ph 0 31000 30280 'repo could not be refreshed' 32000 1795273672907
pdiff pb ph
check "DS-945 AC1 a park written 29 s further into the same run on one tree is not listed" '[ $rc = 0 ] && [ "$out" = "compare_pass: 2 pass run(s) compared, 0 differ, 0 not compared" ]'
recs pq 0 31000 30280 'which colour?' 32000 1795273672907
pdiff pb pq
check "DS-945 AC2 a park asking something else in the same run is still listed" '[ $rc = 1 ] && echo "$out" | grep -qxF "  queue P-1 park.question: base \"repo could not be refreshed\", head \"which colour?\""'
recs pl 0 31000 3630280 'repo could not be refreshed' 32000 1795273672907
pdiff pb pl
check "DS-945 a park dated an hour past its run on one tree is still listed" '[ $rc = 1 ] && echo "$out" | grep -qE "^  queue P-1 park.since: base \"[0-9T:.-]+Z\", head \"[0-9T:.-]+Z\"$"'
recs gb 0 1000 1500 'stopped by hand' 2000 1795273210286
recs gh 0 20000 21000 'stopped by hand' 41000 1795273672907
pdiff gb gh
check "DS-945 a park the suite wrote between the same two runs on both trees is not listed" '[ $rc = 0 ]'

# A pass stopped by a signal: the recorder in its place ends with the same status, and records it.
echo "process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000);" > "$T/stopped.mjs"
PASS_CMP_NODE="$(command -v node)" PASS_CMP_OUT="$T/stopped" node "$S/compare_pass.mjs" record "$T/stopped.mjs"; rc=$?
check "DS-763 a pass stopped by a signal ends the recorder with its status" '[ $rc = 143 ] && [ "$(jq -r .signal "$T/stopped/1.json")" = SIGTERM ]'

# Two suites on each tree, each noting in one file when it starts and when it ends, waiting up to 3 s
# for all four to start, then running one pass: side by side every one starts before the first ends;
# one after the other each ends before the next starts. Only a base whose tests/pass_setup.sh mints
# SID_SUFFIX runs side by side.
mkdir -p "$T/order/desk/bin" "$T/order/tests"; echo 'SID_SUFFIX=x' > "$T/order/tests/pass_setup.sh"
echo "console.log('ran');" > "$T/order/desk/bin/pass.mjs"
for s in test_pass.sh test_pass_b.sh; do cat > "$T/order/tests/$s" <<'EOF'
#!/usr/bin/env bash
echo start >> "$CMP_ORDER"
for _ in $(seq 30); do [ "$(grep -c start "$CMP_ORDER")" -ge 4 ] && break; sleep 0.1; done
node desk/bin/pass.mjs >/dev/null; echo "ok   ran"
echo end >> "$CMP_ORDER"
EOF
done
cp -R "$T/order" "$T/order-old"; rm "$T/order-old/tests/pass_setup.sh"
order(){ CMP_ORDER="$T/$1.order" PASS_CMP_SERIAL=$2 bash "$S/compare_pass.sh" "$3" "$3" >/dev/null 2>&1; rc=$?; out=$(tr '\n' ' ' < "$T/$1.order"); }
order side '' "$T/order"
check "DS-960 AC2 with no suite option, every suite of both trees starts before the first one ends" '[ $rc = 0 ] && [ "$out" = "start start start start end end end end " ]'
order serial 1 "$T/order"
check "DS-960 AC4 with PASS_CMP_SERIAL=1 the trees and suites run one after the other" '[ $rc = 0 ] && [ "$out" = "start end start end start end start end " ]'
order old '' "$T/order-old"
check "DS-960 a base whose suites mint no SID_SUFFIX runs one after the other" '[ $rc = 0 ] && [ "$out" = "start end start end start end start end " ]'

# The real pass suites against themselves: whatever differs between two runs of one tree is noise.
# The whole replay takes over 1000 CPU seconds (9 to 17 minutes), so it runs only on a main push and the nightly run
# (a push, schedule or workflow_dispatch event in GitHub Actions), or where PASS_CMP_FULL=1 opts in.
# A pull request and a local run replay one small suite instead. The trees are directories, so the
# replay never touches the cache.
full=
if [ "${PASS_CMP_FULL:-}" = 1 ]; then full=1
elif [ -n "${GITHUB_ACTIONS:-}" ]; then case "${GITHUB_EVENT_NAME:-}" in push|schedule|workflow_dispatch) full=1 ;; esac; fi
touch "$T/mark"
if [ -z "$full" ]; then
  out=$(bash "$S/compare_pass.sh" --suite test_pass_other_repo.sh "$SRC" "$SRC" 2>"$T/err"); rc=$?
  check "DS-920 AC1 on a pull request or a local run, test_pass_other_repo.sh against the same tree lists nothing" '[ $rc = 0 ] && echo "$out" | grep -qE "^compare_pass: [1-9][0-9]* pass run\(s\) compared, 0 differ, 0 not compared$"'
  if [ -n "${GITHUB_ACTIONS:-}" ]; then why="this run is a pull request"; else why="this is a local run"; fi
  echo "SKIP DS-763 AC4 the whole pass shell suite against the same tree: $why, so only test_pass_other_repo.sh was replayed (main pushes and the nightly run replay them all; PASS_CMP_FULL=1 opts a run in)"
else
  out=$(bash "$S/compare_pass.sh" "$SRC" "$SRC" 2>"$T/err"); rc=$?
  check "DS-763 AC4 the whole pass shell suite against the same tree lists nothing" '[ $rc = 0 ] && echo "$out" | grep -qE "^compare_pass: [0-9]{3,} pass run\(s\) compared, 0 differ, 0 not compared$"'
fi
check "DS-963 AC6 the same-tree replay replays the base and caches nothing" 'replayed && ! find "$CD" -newer "$T/mark" -name "*.tar" | grep -q .'

echo "$PASS checks passed, $FAIL failed"
[ "$FAIL" = 0 ]
