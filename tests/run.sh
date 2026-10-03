#!/usr/bin/env bash
# Runs every desk-skills regression test. Each test uses a throwaway HOME and git repos; nothing
# touches your real ~/.claude, ~/.config/desk, repos, Jira or GitHub.
set -u
T="$(cd "$(dirname "$0")" && pwd)"
fail=0
run() { printf '\n== %s\n' "$1"; shift; "$@" >"${TMPDIR:-/tmp}/desk-test.out" 2>&1; rc=$?
  { grep -E "checks passed" "${TMPDIR:-/tmp}/desk-test.out"; c=$(grep -c "^ok" "${TMPDIR:-/tmp}/desk-test.out"); [ "$c" -gt 0 ] && echo "ok: $c"; }
  grep -E 'FAIL' "${TMPDIR:-/tmp}/desk-test.out" && fail=1; [ $rc -eq 0 ] || { echo "exit $rc"; tail -5 "${TMPDIR:-/tmp}/desk-test.out"; fail=1; }; }
run "attribution hook self-test" python3 "$T/../hooks/deny-ai-attribution.py" --self-test
run "gate (one definition of green)" node "$T/test_gate.mjs"
run "desk-jira against a local stub" bash "$T/test_jira.sh"
run "harness-rules" bash "$T/test_harness.sh"
run "batch base (one batch targets a feature branch)" bash "$T/test_batch_base.sh"
run "epics (expansion, Jira links, held tickets)" bash "$T/test_epic.sh"
run "skill links (skills-upstream links)" bash "$T/test_links.sh"
run "plugins (unbumped vs outdated)" bash "$T/test_plugins.sh"
[ "$fail" = 0 ] && echo && echo "all passed" || { echo; echo "FAILURES above"; }
exit $fail
