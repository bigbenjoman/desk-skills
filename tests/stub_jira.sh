# shellcheck shell=bash
# Sourced by suites that talk to tests/stub_jira.py. stub_jira <port> <log> <delay> [<fixture>] starts
# the stub, waits up to 30 s for it to listen, and sets STUB_PID and STUB_PORT. The port is a free one
# when <port> is taken. A stub that never listens fails the suite with one line naming it and its port.
# shellcheck disable=SC2034  # STUB_PID and STUB_PORT are read by the suite that sources this
stub_jira() {
  local ready="$2.port" i=0
  rm -f "$ready"
  STUB_READY="$ready" python3 "$(dirname "${BASH_SOURCE[0]}")/stub_jira.py" "$@" & STUB_PID=$!
  while [ ! -s "$ready" ] && [ $i -lt 300 ] && kill -0 "$STUB_PID" 2>/dev/null; do sleep 0.1; i=$((i + 1)); done
  STUB_PORT=$(cat "$ready" 2>/dev/null)
  [ -n "$STUB_PORT" ] && return 0
  kill "$STUB_PID" 2>/dev/null
  echo "FAIL the Jira stub (tests/stub_jira.py) did not listen on port $1 within 30 s"
  exit 1
}
