#!/usr/bin/env bash
# Runs every desk-skills regression test. Each test uses a throwaway HOME and git repos; nothing
# touches your real ~/.claude, ~/.config/desk, repos, Jira or GitHub. Written for bash 3.2 (stock
# macOS /bin/bash) as well as 4+/5.
set -u
T="$(cd "$(dirname "$0")" && pwd)"
OUT="$(mktemp "${TMPDIR:-/tmp}/desk-test.XXXXXX")" || exit 1
trap 'rm -f "$OUT"' EXIT
# Every bash suite runs under the bash running this script, so `/bin/bash tests/run.sh` tests 3.2.
SH="${BASH:-bash}"
echo "bash $BASH_VERSION ($SH); scripts with #!/usr/bin/env bash get $(command -v bash)"
fail=0; total=0
# A suite fails the run on a FAIL line, a non-zero exit, a bash error, or no checks at all.
run() { printf '\n== %s\n' "$1"; shift; "$@" >"$OUT" 2>&1; rc=$?
  grep -E "checks passed|^SKIP" "$OUT"; c=$(grep -c "^ok" "$OUT")
  [ "$c" -gt 0 ] || c=$(grep -oE '[0-9]+ checks passed' "$OUT" | grep -oE '^[0-9]+' | head -n 1)
  c=${c:-0}; total=$((total + c)); echo "ok: $c"
  grep -E 'FAIL|too many arguments|unbound variable|bad substitution|syntax error' "$OUT" && fail=1
  [ $rc -eq 0 ] || { echo "exit $rc"; tail -5 "$OUT"; fail=1; }
  [ "$c" -gt 0 ] || { echo "no checks ran"; fail=1; }; }
run "syntax and shellcheck (every shell script and .mjs)" "$SH" "$T/test_lint.sh"
run "attribution hook self-test" python3 "$T/../hooks/deny-ai-attribution.py" --self-test
run "gate (one definition of green)" node "$T/test_gate.mjs"
run "machine profile (detection, sizing, §3b fallback)" node "$T/test_machine.mjs"
run "config values (list items, trailing notes)" node "$T/test_config.mjs"
run "memory watch (avail band, heavy processes)" node "$T/test_mem_watch.mjs"
run "desk-jira against a local stub" "$SH" "$T/test_jira.sh"
run "harness-rules" "$SH" "$T/test_harness.sh"
run "dev ports across repo configs" node "$T/test_ports.mjs"
run "batch base (one batch targets a feature branch)" "$SH" "$T/test_batch_base.sh"
run "triage (claude -p receives every flag)" "$SH" "$T/test_triage.sh"
run "worker-settings (shell-script toolchain)" "$SH" "$T/test_worker_settings.sh"
run "epics (expansion, Jira links, held tickets)" "$SH" "$T/test_epic.sh"
run "pass (screenshots go to the current round's PR; requeue)" "$SH" "$T/test_pass.sh"
run "queue set (JSON objects and arrays)" "$SH" "$T/test_queue_set.sh"
run "skill links (skills-upstream links)" "$SH" "$T/test_links.sh"
run "plugins (unbumped vs outdated)" "$SH" "$T/test_plugins.sh"
run "install_file (rename over a running script)" "$SH" "$T/test_install_file.sh"
run "pre-push hook (stdin, no row, lock timeout)" "$SH" "$T/test_pre_push.sh"
run "timeout (process group, hung psql in setup-worktree)" "$SH" "$T/test_timeout.sh"
run "playwright lookup and saved GitHub login" node "$T/test_playwright.mjs"
run "desk-runner (profile gate, stubbed tart, isolation results)" "$SH" "$T/test_runner.sh"
run "reboot-check (worktrees across repos, runner, heavy)" "$SH" "$T/test_reboot.sh"
run "desk-ci (classify placement, ci-lint secret safety)" node "$T/test_ci.mjs"
[ "$fail" = 0 ] && { echo; echo "all passed: $total checks"; } || { echo; echo "FAILURES above ($total checks passed)"; }
exit $fail
