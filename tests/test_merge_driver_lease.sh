#!/usr/bin/env bash
# suite: merge driver: the merge lease around the ledger check, the merge and its record (offline, fake gh)
# layer: L3
# The real merge-driver.sh, one loop at a time, set up by merge_driver_setup.sh, against a temporary
# lease directory, a fixture ticket ledger with its lever on and off, and the fake gh: the driver takes
# the merge lease for the repo and base (merge-lease.mjs) around one ledger check, merge and record.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=merge_driver_setup.sh
. "$S/merge_driver_setup.sh"

export DESK_LEASE_DIR="$T/leases" DESK_MACHINE="$T/machine.md"
SHA1=1111111111111111111111111111111111111111; SHA2=2222222222222222222222222222222222222222
LLOG="$DESK_LEASE_DIR/leases.log.jsonl"
# kinds <merge mode>: the machine profile's lease-kinds row.
kinds(){ printf '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `lease-kinds` | `merge=%s` | test |\n' "$1" > "$DESK_MACHINE"; }
# fresh <merge mode>: one green PR, #501 for T-1 at SHA1, and nothing leased, logged or merged yet.
fresh(){
  kinds "$1"
  rm -rf "$DESK_LEASE_DIR" "$T/ledger" "$T/gh.hang"; mkdir -p "$DESK_LEASE_DIR"
  find "$SD" \( -name 'green-*' -o -name 'backoff-*' -o -name 'lease-unreadable' \) -delete 2>/dev/null
  : > "$T/merges.log"
  export DESK_MERGE_LOG="$T/merge-log-$RANDOM.jsonl"
  cat > "$T/prs.json" <<EOF
{ "501": { "head": "fix/T-1", "base": "main", "sha": "$SHA1", "state": "open", "draft": false, "checks": [["test", "SUCCESS"]] },
  "502": { "head": "fix/T-2", "base": "main", "sha": "$SHA2", "state": "open", "draft": true, "checks": [["test", "SUCCESS"]] } }
EOF
  q init lease
  q add T-1 Task A; q set T-1 branch=fix/T-1 state=done result.pr=501
  q add T-2 Task A; q set T-2 branch=fix/T-2 state=done result.pr=502
}
# record <type> <by>: the ledger records #501 merged (or armed) by another desk path at SHA1.
record(){
  node --input-type=module -e "const { append } = await import('$B/ticket-ledger.mjs');
    const data = '$1' === 'merged' ? { by: '$2', pr: 501, head_sha: '$SHA1', base: 'main' } : { by: '$2', pr: 501, head_sha: '$SHA1' };
    append('$T', [{ type: '$1', batch: 'standing', key: 'T-1', data }]);"
}
# go [<levers>]: two loops, the first confirming #501 green and the second reaching its merge.
go(){
  local lv="${1-ledger}"
  out=""
  for _ in 1 2; do
    out="$out$(DESK_LEVERS="$lv" MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-1 T-2" 2>&1)"$'\n'
  done
}
events(){ [ -f "$LLOG" ] && jq -r 'select(.kind == "merge") | .event' "$LLOG" | paste -sd' ' -; }
# hold <seconds>: a session holds the merge lease on acme/widgets@main for as long as its process lives.
hold(){
  node -e "setTimeout(() => {}, $1 * 1000)" & HPID=$!
  node "$B/leases.mjs" acquire merge acme/widgets@main --ttl 60 --label "session hold-test" --pid "$HPID" >/dev/null
}

# ---- AC6: the kind off takes no lease and reads no ledger -------------------------------------------
fresh off; record merged "session other"; go
check "AC6 with the merge kind off, a green PR merges as before: no lease, no ledger check" '[ "$(merged)" = 501 ] && [ -z "$(events)" ] && ! echo "$out" | grep -q "ledger"'

# ---- AC5: on, ledger lever off ------------------------------------------------------------------------
fresh on; record merged "session other"; go ""
check "AC5 with the ledger lever off it merges under the lease, and says the ledger is off" '[ "$(merged)" = 501 ] && [ "$(events)" = "grant release" ] && echo "$out" | grep -q "#501 the ledger lever is off: no ledger check"'

# ---- AC2: on, ledger on, no record --------------------------------------------------------------------
fresh on; go
GRANT_AT=$(jq -r 'select(.kind == "merge" and .event == "grant") | .at' "$LLOG" 2>/dev/null)
FREE_AT=$(jq -r 'select(.kind == "merge" and .event == "release") | .at' "$LLOG" 2>/dev/null)
MERGED_AT=$(jq -r 'select(.type == "merged" and .key == "T-1") | .at' "$T/ledger/events.jsonl" 2>/dev/null)
check "AC2 the ledger read, the merge and the merged record all happen inside one hold, released after the record" '[ "$(merged)" = 501 ] && [ "$(events)" = "grant release" ] && [ -n "$MERGED_AT" ] && [[ "$GRANT_AT" < "$MERGED_AT" || "$GRANT_AT" == "$MERGED_AT" ]] && [[ "$MERGED_AT" < "$FREE_AT" || "$MERGED_AT" == "$FREE_AT" ]]'
check "AC2 the lease is the repo and base's, labelled with the driver and the PR" 'jq -r "select(.event == \"grant\") | .key + \" \" + .label" "$LLOG" | grep -q "^acme/widgets@main merge-driver .* #501$"'

# ---- AC3: on, a record from another path at this head -------------------------------------------------
fresh on; record merged "session other"; go
check "AC3 a merge the ledger records at this head is not merged again, naming the path" '[ -z "$(merged)" ] && echo "$out" | grep -q "#501 NOT merged: the ticket ledger records it merged by session other at 111111111" && [ "$(events)" = "grant release" ]'
fresh on; record automerge_armed "stage-7 session"; go
check "AC3 an armed auto-merge the ledger records at this head is not merged, naming the path" '[ -z "$(merged)" ] && echo "$out" | grep -q "armed for auto-merge by stage-7 session"'
fresh on; record merged "session other"; jq '."501".sha = "'"$SHA2"'"' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"; go
check "AC3 a record at an older head does not stop a merge at the current one" '[ "$(merged)" = 501 ]'

# ---- AC4: shadow, the same record ---------------------------------------------------------------------
fresh shadow; record merged "session other"; go
check "AC4 in shadow it merges as before, and the lease log records a would-refuse naming the earlier path" '[ "$(merged)" = 501 ] && [ "$(jq -r "select(.event == \"would-refuse\") | .holders[0].label" "$LLOG")" = "session other" ]'

# ---- AC1: a session holds the lease -------------------------------------------------------------------
one(){ out=$(DESK_LEVERS=ledger MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-1 T-2" 2>&1); }
fresh on; one; hold 8
out=$(DESK_LEVERS=ledger MERGE_DRIVER_LEASE_WAIT_SECS=30 MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-1 T-2" 2>&1)
check "AC1 with a session holding the lease, the driver waits, says who holds it, then merges" '[ "$(merged)" = 501 ] && echo "$out" | grep -q "#501 waiting for the merge lease on acme/widgets@main: merges into acme/widgets@main is held by session hold-test (pid $HPID"'
wait "$HPID" 2>/dev/null

# ---- AC9: another base takes another lease ------------------------------------------------------------
fresh on; hold 10
sed_cfg="$T/config-next.md"; while IFS= read -r l; do case "$l" in '| Default branch |'*) echo '| Default branch | `next` |' ;; *) echo "$l" ;; esac; done < "$T/config.md" > "$sed_cfg"
jq '."501".base = "next"' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"
out=$(DESK_CONFIG="$sed_cfg" MERGE_DRIVER_LEASE_WAIT_SECS=0 bash -c 'for i in 1 2; do DESK_LEVERS=ledger MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$1" --tickets "T-1 T-2" 2>&1; done' _ "$B/merge-driver.sh")
check "AC9 a driver on another base does not wait on main's merge lease" '[ "$(merged)" = 501 ] && ! echo "$out" | grep -q "waiting for the merge lease" && jq -e "select(.event == \"grant\" and .key == \"acme/widgets@next\")" "$LLOG" >/dev/null'
kill "$HPID" 2>/dev/null; wait "$HPID" 2>/dev/null

# ---- AC7 and AC8: an unreadable store -----------------------------------------------------------------
fresh on; echo 'not json' > "$DESK_LEASE_DIR/leases.json"; go
check "AC7 with the kind on and the store unreadable, it does not merge and names the reset command" '[ -z "$(merged)" ] && echo "$out" | grep -q "#501 merges wait for the lease store: .*desk-env lease reset --reason"'
fresh shadow; echo 'not json' > "$DESK_LEASE_DIR/leases.json"; go
first="$out"
jq '."501".state = "merged" | ."502".draft = false' "$T/prs.json" > "$T/prs.tmp" && mv "$T/prs.tmp" "$T/prs.json"; go
check "AC8 in shadow with the store unreadable it merges as before, and says leases were unreadable once" '[ "$(merged)" = "501 502" ] && [ "$(echo "$first" | grep -c "leases were unreadable")" -eq 1 ] && ! echo "$out" | grep -q "leases were unreadable"'

# ---- AC10: a merge call that does not return ----------------------------------------------------------
fresh on; touch "$T/gh.hang"
out=""; for _ in 1 2; do out="$out$(DESK_LEVERS=ledger MERGE_DRIVER_MERGE_SECS=1 MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-1 T-2" 2>&1)"$'\n'; done
check "AC10 a merge call past its bound releases the lease and logs the PR as unconfirmed" '[ -z "$(merged)" ] && [ "$(events)" = "grant release" ] && echo "$out" | grep -q "#501 merge UNCONFIRMED: gh pr merge did not return in 1s" && qf T-1 .merge_blocked | grep -q "^merge unconfirmed:"'
fresh shadow; echo 3 > "$T/gh.hang"
out=""; for _ in 1 2; do out="$out$(DESK_LEVERS=ledger MERGE_DRIVER_MERGE_SECS=1 MERGE_DRIVER_ONE_LOOP=1 MERGE_DRIVER_GREEN_SECS=0 bash "$B/merge-driver.sh" --tickets "T-1 T-2" 2>&1)"$'\n'; done
check "AC4 in shadow the merge call is not bounded: a slow one merges as before" '[ "$(merged)" = 501 ] && ! echo "$out" | grep -q "UNCONFIRMED"'
rm -f "$T/gh.hang"

finish lease
