#!/usr/bin/env bash
# suite: pass: ticketless PRs (a whole pass with a stubbed gh PR list records the PRs no ticket owns)
# layer: L3
# The real pass.mjs and queue.mjs against a gh stub whose open-PR list holds one desk-opened PR no ticket
# owns, one a person opened, one under desk's handle without desk's body fence, and one a queued ticket
# owns: the pass records only the first in the queue's ticketless_prs, says so once, writes nothing on a
# second pass, and drops it once the PR is merged or closed. Scratch HOME only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
# shellcheck source=pass_setup.sh
. "$(dirname "$0")/pass_setup.sh"
pick_up

{ cat "$T/config.md"; printf '\n## 1. Identity\n| Field | Value |\n|---|---|\n| GitHub handle | `ben` |\n'; } > "$T/config-tl.md"
export DESK_CONFIG="$T/config-tl.md" DESK_QUEUE="$T/queue-tl.json" DESK_AUTOPILOT_STATE="$T/state-tl"
mkdir -p "$T/state-tl/logs"
# The open PRs into main: only an `--author ben` list is answered, as gh filters by author itself.
cat > "$T/stub/gh" <<EOF
#!/bin/sh
case "\$*" in
  "pr list "*"--state open --base main --author ben "*) cat "$T/tl-prs.json" ;;
  "pr list "*) echo '[]' ;;
esac
exit 0
EOF
chmod +x "$T/stub/gh"
node -e 'const fence = "<!-- desk-pr: body -->\nWhat it does.";
  const pr = (number, o = {}) => ({ number, title: `fix: change ${number}`, headRefName: `fix/change-${number}`, baseRefName: "main", body: fence, createdAt: "2026-11-20T10:00:00Z", author: { login: "ben" }, ...o });
  console.log(JSON.stringify([pr(10), pr(11, { author: { login: "someone" } }), pr(12, { body: "Bumps a dependency." }), pr(13, { title: "fix(T-50): the queue reads" })]))' > "$T/tl-prs.json"
q init tl; q add T-50; q set T-50 state=triaged lane=A
listed='PR #10 (fix/change-10) into main was opened by a desk session and no ticket owns it'

out=$(node "$B/pass.mjs" 2>&1)
check "DS-836 AC1 a pass records the desk-opened PR no ticket owns, and says so" \
  '[ "$(bfield ticketless_prs)" = "[{\"pr\":10,\"title\":\"fix: change 10\",\"branch\":\"fix/change-10\",\"since\":\"2026-11-20T10:00:00Z\"}]" ] && echo "$out" | grep -qF "$listed"'
check "DS-836 AC3/AC4 a person's PR, one without desk's fence and a queued ticket's PR are not recorded" \
  '[ "$(bfield ticketless_prs.length)" = 1 ] && [ "$(bfield ticketless_prs.0.pr)" = 10 ]'
out=$(node "$B/pass.mjs" 2>&1)
check "DS-836 AC5 a second pass keeps the one record and does not say it again" \
  '[ "$(bfield ticketless_prs.length)" = 1 ] && ! echo "$out" | grep -qF "$listed"'
echo '[]' > "$T/tl-prs.json"
out=$(node "$B/pass.mjs" 2>&1)
check "DS-836 AC2 once the PR is merged or closed, the next pass drops the record" '[ "$(bfield ticketless_prs)" = null ]'

echo "pass ticketless: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
