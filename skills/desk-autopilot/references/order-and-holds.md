# desk-autopilot: merge order, holds and sizes

Part of desk-autopilot, read at Stage 2 for the merge order, Jira-linked holds and sizes, and
whenever a pass reports `RELEASE DUE` or `STUCK`. It binds exactly as the core `SKILL.md` does. Where
it says "above" or "below" of something this file does not hold, or cites a section in *italics* it
does not hold, that is in the core or in the file the core's reference table names.

## Order the batch by blast radius

`plan-batch` sets the merge order: triage records each ticket's `change_kind` (`relocate`, `schema`,
`shared` or `surface`), and the plan's `MERGE ORDER` section lists the admitted tickets largest blast
radius first, each with its kind and why. Two tickets that share files are chained, the larger blast
radius first (two of a kind: the smaller first, then the order named), as holds in the queue and
entries in the `--deps` it prints, which already carries the chain; tickets that share no files are
never chained. Jira Blocks links win over the kinds, and `CONTRADICTIONS` names each place they
disagree. **Say the order in the Stage 2 report** and put it in the status table's Notes; a
contradiction is worth one line to the user, since the link may be stale.

**The user's named order is spawn priority, not a merge chain**: `plan-batch` seeds the queue
blockers first and otherwise in the order named, and `pass.mjs` spawns in queue order, so pass the
tickets that gate the most others first. If the user asks for a literal chain that would idle a gate,
say what that costs and ask. A released ticket's `collides_with` still
blocks it while that worker runs, so clear the entry too if you release it early. A ticket added
mid-batch (`queue.mjs admit`) is not chained for you: hold it with `queue.mjs hold <SUCCESSOR>
<TICKET>` behind any ticket it shares files with.

### Dependencies from Jira links

`triage.sh` records each ticket's "is blocked by" (Blocks) links and size from Jira, and
`plan-batch` acts on them. Only Blocks is honoured; it reports any other link type it ignored.

| Blocker | What `plan-batch` does |
|---|---|
| in the batch, admitted | holds the successor: parked `held by orchestrator: blocked by … (Jira link)`, `held_by` set, and an entry in the `--deps` it prints |
| outside the batch and done | nothing (noted) |
| outside the batch and not done; in the batch but parked or someone else's; or links that could not be read | a question on the successor, asked at Stage 3 like any unknown |
| on a cycle | parks every ticket on it: the links need fixing |

A ticket parked for its lane (C, D) or its size (L, XL) is **never held and never in `--deps`**:
those parks win, so a release can never send one to a headless worker. `plan-batch` seeds the queue
blockers first, and its `--deps` already carries the merge chain for tickets that share files (*Order
the batch by blast radius*): pass it to the merge driver as it stands.

**A held ticket is in flight, not idle.** While every blocker is still on its way (running, waiting
to spawn, or done with an open PR), `pass.mjs` reports it under `WAITING ON MERGE` and never exits
with `status` `idle`: keep the loop going. Two states come to you as an exit 11, in `release_due` or
`stuck` and under `waiting`:

- **RELEASE DUE**: every blocker's PR has merged. The merge driver releases it on its next loop (it
  reads both `--deps` and the queue's `held_by`, so a blocker added mid-batch counts). **Where the
  driver is not running** (no merge grants), you release it: `queue.mjs set <TICKET> state=triaged
  park=null held_by=null`, then `queue.mjs front <TICKET>`. That is the one manual release, and only
  once GitHub shows every blocker merged: never because "it probably does not really depend on it".
- **STUCK**: a blocker can no longer merge on its own (it failed, is parked for its own reason,
  finished with no PR, or its PR was closed unmerged). The user decides: re-run or finish the
  blocker, release the ticket anyway, or drop it. Of those blockers, a failed or parked one is
  already that question, so what is held behind it is not STUCK (below): only a blocker that
  finished with no PR, closed its PR unmerged or is not in the batch comes to you as STUCK. A
  blocker in no batch that the ticket was admitted behind (`held_outside`) is not STUCK: the pass
  lifts it once it is Done in Jira and its PR has merged to the batch's base.

**Behind a failed or parked blocker, a held ticket is not a question of its own.** That blocker is
already in front of the person (its `FAILED` line, or its park), so what is held behind it, at any
depth, is listed once under `WAITING ON A PARK` and in `on_park`, never under `stuck` or `waiting`:
the answer to the blocker settles it.

Answering a held ticket's question (`answer.mjs`) keeps the hold.

**"Add the blocker to the batch"** as an answer: fetch as at Stage 1, `triage.sh <B>`, `queue.mjs admit <B>`,
`queue.mjs hold <S> <B>`. A running merge driver picks B up from the queue on its next loop and
merges B's PR; do not restart it. Never re-run `plan-batch` with `AUTOPILOT_WRITE_QUEUE` mid-batch: it resets every ticket's
state.

### Size

Every ticket should carry a size (desk-jira's scale: XS, S, M, L, XL), from the project's `Size`
field or a first description line `Size: M`. **L and XL park** (`size L — split it before
batching`): they are split into smaller tickets, not run. A ticket with no size is reported
`! no size` and runs on its lane as before.
