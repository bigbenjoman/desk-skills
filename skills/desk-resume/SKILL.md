---
name: desk-resume
description: >-
  Use right after /clear when a context handoff was written (desk-handoff.py asked for /clear then
  /desk-resume), or when the user says "resume", "pick up from the handoff" or "continue from the
  note": reads the handoff the cleared session was pointed at, else the newest one in this repo's
  .handoffs/, and carries on from its next step with no further prompt.
---

# desk-resume

The second half of a context handoff. When a session passes its handoff threshold, it writes
`.handoffs/<date>.md` and asks the person to type `/clear`, then `/desk-resume`. After `/clear` the
SessionStart hook puts the handoff in the fresh session's context, but a hook cannot start a turn,
so this command is the prompt that does.

## Steps

1. **Find the handoff.** If this session's context has a line `desk handoff: read <path> (in <root>)
   and continue from its next step`, that is the one. Otherwise take the newest file in
   `<repo root>/.handoffs/` by modification time that does not start
   `<!-- desk handoff placeholder` (a name reserved, not yet written). If there is none, say so in
   one line and stop.
2. **Read it whole**, along with any file it says to read first.
3. **Treat its decisions as made and its open questions as still open.** Do not re-ask what it
   settled, and do not re-run a step it records as done unless it says to check it.
4. **Re-check external state before acting**: the branch and worktree it names still exist, a PR it
   names is still open, and nothing it waits on has already happened. Say in one line anything that
   has moved.
5. **Continue from its next step** without asking whether to. Say in one line which step you are
   resuming, then do it.

## Red flags

- Asking the person what to do next when the handoff names a next step
- Starting work the handoff does not name before its next step is done
- Resuming from an older handoff when the context named a newer one
