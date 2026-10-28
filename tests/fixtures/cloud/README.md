# Cloud session fixtures

Recorded by Ben Lavender on 2026-10-28 with Claude Code 2.1.312, copied verbatim from DS-124's
Verification section. `tests/test_cloud_worker.mjs` reads them.

- `created.txt`: `claude --cloud "DS-124 recording"`, run under `script` so it had a TTY. It returns
  at once. The description is also the session's first prompt.
- `print-refused.txt`: `claude -p "..." --cloud "<description>"`. A new cloud session cannot be
  started in print mode.
- `send-json.json`: `claude -p "<msg>" --cloud <session-id> --output-format json`. It queues the
  message and does not wait for the reply.
- `stream-json-refused.txt`: `claude -p "<msg>" --cloud <session-id> --output-format stream-json`.

No route found gives a cloud session's tokens or cost: `claude --teleport <session-id>` replays the
conversation, but `/cost` then shows only local turns, and no local transcript is written.
