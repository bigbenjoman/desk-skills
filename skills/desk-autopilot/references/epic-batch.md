# desk-autopilot: an epic as a batch

Part of desk-autopilot, read at Stage 0 when an argument is an epic, and at the epic's close-out. It
binds exactly as the core `SKILL.md` does. Where it says "above" or "below" of something this file
does not hold, or cites a section in *italics* it does not hold, that is in the core or in the file
the core's reference table names. Feature mode is in `feature-mode.md`, read only when `plan-batch`
turns it on.

## An epic as a batch

A large feature runs as an epic: one key whose children are the tickets. **Expand it at Stage 0,
before triage**, and never triage, build, transition or edit the epic itself:

```bash
node ~/.claude/desk/bin/expand-parent.mjs ABC-900   # the batch keys on stdout, the report on stderr
node ~/.claude/desk/bin/queue.mjs set-batch epic=ABC-900
```

- It keeps the epic's children that are this repo's keys and not started, in Jira rank order. A
  child story that has open subtasks is replaced by them (one level), **whether the story itself is
  To Do or In Progress**, and its Blocks links pass to them (`<state>/expansion.json`, read by
  `plan-batch`). Done children are dropped; **in-progress children are dropped** too (one may
  already have a PR), and so is an In Progress story with no open subtask: include one only if the
  user names it. The subtasks of a story are read before its own status is, because an In Progress
  story is where open subtasks usually sit, and dropping it first made them vanish unreported.
- Exit 4 means the key is not an epic: run it as an ordinary ticket. A story runs as its subtasks
  only when the user asks for exactly that (`--subtasks`); a bug or story named on its own with QA
  or checklist subtasks runs as itself, as it always has. Exit 3: nothing open under it; say so.
- **State the expanded list and every drop with its reason in the Stage 2 report.** A child the
  user named alongside the epic is one key, not two.
- **Half an epic on the default branch: ask now, at Stage 0, before triage.** With no batch base,
  each child merges to §0 Default branch as it goes green, so production carries a half-built feature
  until the last one lands. Ask this one question straight after expansion (an `AskUserQuestion`,
  recommending `set-batch base=<feature branch>` unless each child is invisible or flagged until the
  feature is complete), because the base must be set before triage reads prior art against it
  (*A batch that targets a feature branch*). Everything else waits for Stage 3.
- Triage reads the epic's description for context; each child's own criteria are its scope.
- Tickets filed during the batch (an L split into children, a close-out follow-up) are written in
  desk-jira's `references/ticket-template.md` layout for their type, each child with its own
  criteria and its dependencies as Blocks links, and join the batch one at a time: fetch as at Stage 1, `triage.sh <KEY>`, then `queue.mjs admit <KEY>` (and `queue.mjs hold` if it is blocked by a
  ticket in the batch), or they wait for the next batch.

### Epic close-out

When the batch is idle with no held ticket left:

1. If any child is parked or failed, list them and stop: the epic is not complete, and nothing is
   verified. In feature mode, also stop while the base gate has not passed: its failures come first.
2. Otherwise, if the epic has acceptance criteria or a definition of done (and likewise for each
   story that was expanded into its subtasks, whose own criteria no worker checked), check each one against
   `origin/<base>` with desk-jira's *"Already fixed"* method (one read-only verifier per criterion,
   file:line or NOT MET, defaulting to NOT MET) and report MET / NOT MET. Each NOT MET is proposed
   as a new child under the epic through `desk-jira`'s gate, in the ticket template's layout (the
   unmet criterion becomes its AC1), never appended to the epic. With no
   criteria, say "epic has no criteria — not verified". **In feature mode, a passed base gate has
   already checked every criterion with a spec**: verify only the ones its `close-out:` line names
   (the criteria no spec covers, such as those left to the close-out at Stage 2), or every one when
   it says the criteria could not be read.
3. With a batch base, the promotion PR (base → default) is the user's to merge. Title it with the epic
   key so `/desk-review` checks the epic's criteria against the whole feature, and say so. In feature
   mode it is already open, titled that way, and the gate marked it ready.
4. **Never transition the epic**, whatever the result.
