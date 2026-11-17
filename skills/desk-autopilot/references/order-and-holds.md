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

**A file tickets only add to is not shared.** A path §4 Append-only paths (`desk-env list
append-only-paths`) covers is not counted, by `plan-batch` or by `queue.mjs admit`, so tickets that
each only add strings to one locale file run side by side. A row that is not a list of path globs
reads as `none`, and the pass report names it.

**The user's named order is spawn priority, not a merge chain**: `plan-batch` seeds the queue
blockers first and otherwise in the order named, and `pass.mjs` spawns in queue order, so pass the
tickets that gate the most others first. If the user asks for a literal chain that would idle a gate,
say what that costs and ask. Sharing a file never holds a ticket at admission: `queue.mjs admit`
records `collides_with` for the plan and `desk-q` only, and the pass starts tickets that share a file
up to that file's per-file budget (`concurrency-and-memory.md`). A ticket added mid-batch is not
chained for you: hold it with `queue.mjs hold <SUCCESSOR> <TICKET>` where its merge must wait.

### Dependencies from Jira links

`triage.sh` records each ticket's "is blocked by" (Blocks) links and size from Jira, and
`plan-batch` acts on them. Only Blocks is honoured; it reports any other link type it ignored.

| Blocker | What `plan-batch` does |
|---|---|
| in the batch, admitted or parked for its lane or size | holds the successor: parked `held by orchestrator: blocked by … (Jira link)`, `held_by` set, and an entry in the `--deps` it prints |
| outside the batch and done | nothing (noted) |
| outside the batch, not done, and triage's `blocker_needs` calls it `build` (needed to build) | holds the successor, `held_outside` set, with no question: the pass lifts the hold once the blocker is Done and on the base |
| outside the batch, not done, and `blocker_needs` calls it `merge` (needed only to merge) | built now, its merge held: `merge_after` set, lifted by the pass once the blocker is Done and on the base (Done alone where its Jira Repository is another configured repo) |
| outside the batch, not done, and `blocker_needs` calls it `none` (not needed), under §3 `autopilot-judgement` `yes` | nothing held: a plan note, and an engineering decision "start without it" logged when the queue is seeded |
| outside the batch and not done otherwise; in the batch but someone else's; or links that could not be read | a question on the successor, asked at Stage 3 like any unknown |
| on a cycle | parks every ticket on it: the links need fixing |

Triage gives every open blocker one of the three calls, and refuses a record missing one. A record
written before the calls reads a boolean `needs` as `build` (true) or `none` (false). A blocker that is
also the person's step (a §4 Person-step or Person-input label) holds as whichever of the step and the
call holds more: a full hold over a merge-only gate, a merge-only gate over none, in the batch or out
of it, so a step in the batch that triage calls `build` holds the build, not only the merge. Standing intake and
`/desk-admit` act on the same call the same way (`batch-state.mjs` `blockerHold`). A ticket moved
(`queue.mjs transfer`) into a batch holding that blocker keeps the merge-only gate while Jira reads the
blocker Done, so the gate lifts only once the blocker's code is on the base.

A ticket parked for its lane (C, D), its size (L, XL) or its design is planned like any other: its
blockers go in `held_by` (and `held_outside`) **beside its park**, and the plan reads `HELD (blocked
by … , and parked: <its park>)`. The park wins and it is **never in `--deps`**, so a release can never
send one to a headless worker; `queue.mjs hold`, `admit` and `transfer` keep that park beside the hold. `plan-batch` seeds the queue
blockers first, and its `--deps` already carries the merge chain for tickets that share files (*Order
the batch by blast radius*): pass it to the merge driver as it stands.

**A batch planned before those parks kept their blockers** has them with `held_by` empty. `queue.mjs
backfill-holds --dry-run` (with `--batch <name>` for a named batch) prints the hold each would gain from
its triage record, as intake holds a ticket it admits: its blockers in the batch not yet merged or
done, and those in no batch it holds (in `held_outside` too). A blocker that failed in the batch is
named, not held, as is one that would close a cycle. Read it, then run it without `--dry-run` to add
them. The park itself, and any park that already has a `held_by`, is left as it is, so a second run
changes nothing. It is run once, by hand: no pass runs it, and `plan.md` stays the record of plan time.

**A held ticket is in flight, not idle.** While every blocker is still on its way (running, waiting
to spawn, or done with an open PR), `pass.mjs` reports it under `WAITING ON MERGE` and never exits
with `status` `idle`: keep the loop going. Two states come to you as an exit 11, in `release_due` or
`stuck` and under `waiting`:

- **RELEASE DUE**: every blocker's PR has merged. The merge driver releases it on its next loop (it
  reads both `--deps` and the queue's `held_by`, so a blocker added mid-batch counts). **Where the
  driver is not running** (no merge grants), the pass releases it itself, as the driver would, and
  says so under `released:`; it comes to you only when the queue refuses that release, and then you
  run `queue.mjs set <TICKET> state=triaged park=null held_by=null`, then `queue.mjs front <TICKET>`.
  That is the one manual release, and only once GitHub shows every blocker merged: never because "it
  probably does not really depend on it".
- **STUCK**: a blocker can no longer merge on its own (it failed, is parked for its own reason,
  finished with no PR, or its PR was closed unmerged). The user decides: re-run or finish the
  blocker, release the ticket anyway, or drop it. Of those blockers, a failed or parked one is
  already that question, so what is held behind it is not STUCK (below): only a blocker that
  finished with no PR, closed its PR unmerged or is not in the batch comes to you as STUCK. A
  blocker in no batch that the ticket was admitted behind (`held_outside`) is not STUCK: the pass
  lifts it once it is Done in Jira and its PR has merged to the batch's base. In a batch the
  supervisor runs, the pass also admits such a blocker into the batch (`intake.mjs admit`, `--into`
  a named batch), once per held ticket (a triage a usage limit cut off does not count, and is tried
  again once it lifts) and at most three a pass, unless it is the person's step, is outside §4 Jira
  project, or the held item is put off with not-now as desk-needs-you judges it (one a moved blocker
  brought back is not). A blocker intake refuses stays in desk-needs-you to admit by hand.

**A `blocked-until-YYYY-MM-DD` label holds a ticket until that day**, read on this machine's local
date from its triage record. The pass parks it `held by orchestrator: blocked until <date>`, shows
it under `HELD: <TICKET> (until <date>)`, and releases it on the first pass on or after that day, in
its usual order. Nothing goes to the user. Each pass reads the hold against the triage record's
labels, so a label moved, fixed or removed (then `triage.sh <TICKET>` again) moves the hold with it.
A label whose date cannot be read holds it too, and comes to the user under `waiting` (and in
desk-needs-you) naming the label: they fix it or let it start. A date-held ticket that `queue.mjs
hold` puts behind blockers waits on them first; once they release it, the pass reads its label again.
The merge driver never releases a date hold: only its day, or the person, does.

**A link to the ticket's own epic never holds it.** An epic is Done only once its children are, so a
ticket linked "is blocked by" its Jira parent epic, or by the epic its batch runs, would wait for ever.
Triage leaves that link out of the ticket's blockers, the pass lifts any hold already on it and prints
one `lint:` line saying the link is ignored, and `desk-jira lint` flags it. Nothing writes to Jira:
removing the link is the person's.

**A blocker in no batch that is a step only the person takes holds the merge, not the build.** A
Task whose summary says apply, confirm or sign off, or a blocker one of the ticket's triage
`ben_steps` names by key or quotes its whole summary, is recorded on the ticket at admission as `merge_after`, not as a hold:
the ticket is built and reviewed as any other, and the merge driver holds its PR until Jira has the
step Done, when the pass lifts it and the PRs merge in the batch's own order. Needs you lists the
step once, as `step:<KEY>`, naming every PR and ticket waiting on it.

**A ticket carrying one of config §4 Person-step labels is the person's step itself.** It is admitted
parked on it (`the person's step: labelled …`) whatever its lane, so no worker spawns, and requeue
refuses it. A blocker carrying one, in the batch or out of it, is a person's step as above: the
ticket it blocks merges after it.

**A step whose output the build reads holds the build.** A ticket carrying one of config §4
Person-input labels (a fixture, a recorded response, a key to make) is parked as the person's step
just the same, but a ticket it blocks is held behind it, as `held_outside` when it is in no batch,
until it is Done. One in the batch holds it in `held_by`, never `merge_after`, a transfer included;
dropping the step (`queue.mjs drop`, once it is Done) moves the hold to `held_outside`, which the pass
lifts on Done. A blocker labelled both Person-step and Person-input is an input. Intake and
plan-batch read a blocker the same way (`batch-state.mjs` `personStep`).

**Every pass reads these again, before it spawns.** A ticket held outside on a blocker that has since
become the person's step (a label row set, a label added) has that hold moved to `merge_after`, logged
`RECLASSIFIED <TICKET>: <BLOCKER> is a person step: build now, merge after`, and starts in that pass
once no hold is left. Here the step decides, not triage's call: a ticket is held outside on a blocker
that is no input step only because triage called it `build`, so a call that outranked the step would
keep every such ticket held. A step the build reads carries a Person-input label, which keeps the
hold. The one way back is a ticket not yet started whose `merge_after` blocker gains a Person-input label: it is held again.

**The person's instruction on an open PR holds its merge too.** From needs-you `resume` until the pass
closes that fix, the merge driver leaves the PR alone, red or green, and a worker that parks or fails
on it keeps it held. One that ends with no marker is parked, not done, so it keeps it held too.

**Behind a failed or parked blocker, a held ticket is not a question of its own.** That blocker is
already in front of the person (its `FAILED` line, or its park), so what is held behind it, at any
depth, is listed once under `WAITING ON A PARK` and in `on_park`, never under `stuck` or `waiting`:
the answer to the blocker settles it.

**A Blocks link added after admission is held by the next pass that reads it.** Before it spawns, each
pass reads the blockers of every triaged ticket that is not done again from Jira, at most once every
intake interval, in one `key in (...)` search for them all (and one more for their blockers), never a
read per ticket. A blocker the read adds to a ticket not yet started (triaged, held, or parked on its
lane, size or design, no worktree) is
held as intake holds one: `held_by` in the batch, `held_by` and `held_outside` in no batch, the person's
step as `merge_after`, and the report says `blocker link: <TICKET>: newly linked as blocked by <B>`. A
lane, size or design park keeps its park, its holds beside it. No
hold is added for a blocker already Done and on the base, merged in the batch, failed in the batch
(said), or waiting behind the ticket (said as a cycle, and raised once as a needs-you `triage` item
naming both tickets, `cycle_link`; the ticket does not start while it stands, so neither of the two
does. The item says how to settle it either way: the ticket first, remove its link; the one held behind
it first, release that one and hold the ticket behind it, as its hold outlives its link). A hold on a ticket dropped from the batch (`dropped_link`), and a
blocker in the batch closed as Won't Do with its PR unmerged (`wont_do_link`, as for one in no batch),
are each raised once the same way. A ticket whose worker started keeps its holds, and
the report says the link arrived after it started. A link removed lifts a hold in no batch (*outside
holds*, above) but never one in the batch, which may be a shared file or the spine: the report says the
link went, and the release is yours. A read that fails, either search, keeps every hold and is tried
again next interval.
What a read adds is measured against the links the pass last acted on for the ticket (`links_seen`),
not the triage record, so a read cut off part-way is acted on by the next one. A ticket's first
`links_seen` is its record before its first read, so a hold you released by hand is not taken for a
new link.

Answering a held ticket's question (`answer.mjs`) keeps the hold.

**"Add the blocker to the batch"** as an answer: fetch as at Stage 1, `triage.sh <B>`, `queue.mjs admit <B>`,
`queue.mjs hold <S> <B>`. A running merge driver picks B up from the queue on its next loop and
merges B's PR; do not restart it. Never re-run `plan-batch` with `AUTOPILOT_WRITE_QUEUE` mid-batch: it resets every ticket's
state.

### Size

Every ticket should carry a size (desk-jira's scale: XS, S, M, L, XL), from the project's `Size`
field or a first description line `Size: M`. **L and XL park** (`size L — split it before
batching`): they are split into smaller tickets, not run. A ticket with no size is reported
`! no size` and runs on its lane.
