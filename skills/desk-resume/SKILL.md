---
name: desk-resume
description: >-
  Use when the user types /desk-resume, which a context handoff asks for right after /clear: reads
  the handoff the SessionStart hook pointed this cleared session at and carries on from its next
  step with no further prompt. Not for resuming a ticket from its resume file (that is
  desk-ticket).
---

# desk-resume

The second half of a context handoff. When a session passes its handoff threshold, it writes
`.handoffs/<date>.md` and asks the person to type `/clear`, then `/desk-resume`. After `/clear` the
SessionStart hook puts the handoff in the fresh session's context, but a hook cannot start a turn,
so this command is the prompt that does.

With `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` set, a session compacts on its own instead and is never asked
for `/clear` or this command: after the compaction the hook tells it to read its handoff, and it
carries on in the same turn. This command is still the way back in after a `/clear`.

## Steps

1. **Find the handoff.** It is the one this session's context names in a line `desk handoff: read
   <path> (in <root>) and continue from its next step`. The hook already chose it (the handoff this
   session was told to write, else the newest written one), and only when it is written, under a day
   old and not resumed before. **With no such line, do not pick one yourself**: the hook named none
   because that handoff is unwritten, stale or already resumed. List the `.md` files in `<repo root>/.handoffs/` changed in
   the last day that do not start `<!-- desk handoff placeholder`, with each one's first lines, and
   ask which to resume, or say there is none and stop.
2. **Read it whole**, along with any file it says to read first. **If it has a `Session name:`
   line, your first output is the line `/rename <that name>`**, on its own, for the person to run:
   `/clear` dropped the name, and only the person can run `/rename`.
3. **Treat its decisions as made and its open questions as still open.** Do not re-ask what it
   settled, and do not re-run a step it records as done unless it says to check it.
4. **Re-check external state before acting**: the branch and worktree it names still exist, a PR it
   names is still open, and nothing it waits on has already happened. Say in one line anything that
   has moved.
5. **Continue from its next step** without asking whether to (once step 1 has the handoff). Say in
   one line which step you are resuming, then do it.

## Red flags

- Asking the person what to do next when the handoff names a next step
- Starting work the handoff does not name before its next step is done
- Resuming a handoff the context did not name without the person choosing it
- Burying the `/rename` line after other output, or leaving it out when the handoff names the session
