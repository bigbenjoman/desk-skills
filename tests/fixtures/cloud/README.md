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
- `created-no-tty.txt`: `claude --cloud "<description>"` started exactly as `startCloud` does on
  macOS (`script -q /dev/null claude --cloud …`, stdin closed, no TTY of its own). Recorded by
  Ben's session on 2026-10-30 with Claude Code 2.1.314, raw bytes as `script` returned them. Two
  things differ from `created.txt`: the output carries `ESC 7`/`ESC 8` (save/restore cursor),
  `ESC ( B` and `SI`, which `clean()` strips; and the session title (`No-TTY recording`) is the
  CLI's own summary, not the description passed in.

No route found gives a cloud session's tokens or cost: `claude --teleport <session-id>` replays the
conversation, but `/cost` then shows only local turns, and no local transcript is written.
