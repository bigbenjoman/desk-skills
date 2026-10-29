# desk-autopilot: feature mode

Part of desk-autopilot, read only for an epic batch, when `plan-batch` prints `FEATURE MODE — on` or
puts `feature_plan` in `needs_person`; a batch with no epic never needs it. It binds exactly as the
core `SKILL.md` does. Where it says "above" or "below" of something this file does not hold, or cites
a section in *italics* it does not hold, that is in the core or in the file the core's reference
table names.

### Feature mode

Children of one epic that share a schema or contract build it in parallel and collide, and nothing
tests the epic's criteria until the last one merges. So an epic gets feature mode when **all** of
these hold: the batch has a base (*A batch that targets a feature branch*), config §4 Acceptance
specs names the spec directory and a command taking `{ids}`, and the epic has numbered criteria
(its DoD ids, else its AC ids, which `expand-parent.mjs` records in `expansion.json`). `plan-batch`
prints `FEATURE MODE — on` or `— off: <why>` for every epic batch; an ordinary batch says nothing.

**Stage 2: draft it.** On, with no plan yet, `plan-batch` puts a `feature_plan` entry on the epic in
`needs_person`. Draft two things into `<state>/feature.json`, then re-run `plan-batch`:

```json
{"epic": "ABC-900", "spine": null,
 "draft": "<the spine ticket, as it would be filed: one strict expected-fail spec per criterion id, titled with the id, plus the shared contracts the children need>",
 "owners": {"DoD1": "ABC-901", "DoD2": "ABC-903"},
 "contributors": {"DoD2": ["ABC-902"]},
 "untestable": {"DoD3": {"why": "about Jira state, not code"}}}
```

- **The spine** is a dedicated ticket, drafted in desk-jira's ticket template; nothing is filed yet.
- **One owner per criterion**: the child whose PR makes that criterion's spec pass. Where several
  children contribute, the owner is the one that completes it, and the rest go under `contributors`:
  `plan-batch` holds the owner behind each of them.
- **A criterion that cannot be written as a test** (for example "all children Done") goes under
  `untestable` with why. `plan-batch` asks whether to leave it to the close-out check; on a yes,
  set its `close_out` to `true`.

The plan prints the draft and one row per criterion id with its owner; a criterion with no owner, an
owner or contributor the batch does not build, an id the epic does not have, or owners and
contributors that hold each other in a cycle, is a question on the epic. Put the draft, the table and those questions to the person at Stage 3.

**Stage 3: approved.** File the spine under the epic through `desk-jira`'s gate (`create … parent=<EPIC>`),
triage it (fetch as at Stage 1, `triage.sh <SPINE>`), set `"spine": "<SPINE>"` in `feature.json`,
and seed the queue with the spine named among the children:
`AUTOPILOT_WRITE_QUEUE=1 plan-batch.mjs <SPINE> <children…>`. The spine is seeded first and runnable,
and every other child is held behind it (`held by orchestrator: blocked by <SPINE> (feature spine)`),
so nothing else spawns until its PR merges. Pass the printed `--deps` to the merge driver as usual.

- `plan-batch` **refuses to seed** while feature mode is on and the spine is not filed and planned,
  or the owner table still has questions: seeded early, the children would start with nothing held.
- **A spine that triage parks** (lane C or D, or size L or XL) stops feature mode for the batch:
  the plan says so, and the children are planned as an ordinary epic batch. Report it; the person
  decides whether to work the spine interactively first.

**When the spine finishes: the person approves its specs.** Seeding records the spine and the
criterion ids it owes a spec for on the queue (`spine`, `spine_ids`: every criterion not left to the
close-out check). When the spine's worker is done, `pass.mjs` reads the specs its branch changed
under the §4 Acceptance specs directory and checks one spec per id, titled with the id, each strict
expected-fail (`test.fail`, `it.fails`, `test.failing`, `@pytest.mark.xfail(strict=True)`). The
spine is never left done: it parks, and its PR stays draft.

- **`spine awaiting approval`**: the check passed. `WAITING ON YOU` carries `SPINE APPROVAL`, the
  children held behind it show as `WAITING ON APPROVAL` (never `STUCK`), the batch is not idle, and
  the pass exits 11. Put the specs to the person: do they mean what the criteria say? **Review them
  first**, because a page of specs hides the one that tests the wrong thing:
  1. `node ~/.claude/desk/bin/spine-review.mjs brief <SPINE>` prints the reviewer's prompt: every
     spec titled with a criterion id, its criterion and its file.
  2. Run Mira (`mira-playwright-expert`) with your own Agent call, read-only, on that prompt. It
     reports, per spec, a criterion clause the spec does not assert, two specs that contradict, a spec
     coupled to an internal module path, and an expected failure that would come from something other
     than the assertion (an import error, a typo). It changes no spec. Save its final text to
     `<state>/spine-review-<SPINE>.txt` and check `git -C <its worktree> status --porcelain` is clean.
  3. `node ~/.claude/desk/bin/spine-review.mjs questions <SPINE> <state>/spine-review-<SPINE>.txt`
     prints one question per spec, each with its criterion, its file and the findings for it. A
     reviewer that failed or returned nothing (leave the file off) makes every question say its spec
     was not reviewed; never present those as clean. Findings naming no reviewed spec come back as
     `unmatched`: show them too.
  4. Ask them as `AskUserQuestion` carousels (*Asking*), one question per spec, its `question`
     text verbatim, options approve or send back. Every spec approved: approve the spine. Any sent
     back: reject it with every spec's note in one.
  - Approved: `queue.mjs approve <SPINE>`. The spine is done, its PR leaves draft (§3 `pr-ready`;
    otherwise it tells you to undraft it), and it merges under the batch's merge rules: the merge
    driver where §3 `autopilot-merge` and `pr-merge-green` are `yes` or the batch approved merging at
    Stage 3, else each pass says
    `SPINE APPROVED — merge PR #<n>` until the person merges it. Once it merges, the children are
    released as any hold is, and spawn on a later pass. The driver releases nothing behind a spine
    that was never approved, even if its PR merged.
  - Rejected: `queue.mjs reject <SPINE> "<their note>"`. The note goes into the spine's briefing as
    a binding answer, and the spine is requeued for a new worker on the same branch and PR. Nothing
    is released.
- **`spine specs incomplete: <problems>`**: an id with no spec, or a spec not marked strict
  expected-fail, each named. `approve` refuses it; send it back with what to fix,
  `queue.mjs reject <SPINE> "<note>"`. Its children wait on it, as above.

**Each child makes the specs it owns pass, and leaves the others alone.** Seeding records the owner
table on the queue too (`owners`, `{<id>: <KEY>}`). A child that owns criteria gets a section in its
briefing, `Acceptance specs you own`, naming each owned spec (its title and file on the base) and
telling it to remove its expected-fail marker and make it pass, changing no other. When its worker
is done, `pass.mjs` checks the branch and, only once the markers are clean, runs the §4 Acceptance
specs command once for each id the child owns, and for no other, in its worktree under the test lock
(the base gate runs them all). A clean check is done as today. Otherwise it parks
`acceptance specs not done: <problems>`, its PR stays draft, and the check is on the ticket as
`spec_check`. The problems it names:

- an owned id with no spec titled with it, or an owned spec still marked expected-fail (strict or
  not) or skipped;
- an owned spec failing when run (the spec, the command and the tail of its output);
- a spec another child owns that the branch added, removed or changed, with that spec's owner.

Send it back with what to fix: `answer.mjs <KEY> "<note>"`, then `queue.mjs requeue <KEY>`. A child
that owns nothing runs as before.

`answer.mjs` still never un-parks: approving is the orchestrator's decision, made on the person's
word.

**The promotion PR opens as the batch starts.** On its first pass, a feature-mode batch opens a
draft PR from the base to §0 Default branch, titled with the epic key, and records it on the queue as
`promotion`. GitHub opens no PR between branches with nothing between them, so a base with no
commits beyond the default branch first gets one empty commit, pushed under §3 `batch-base-push`;
opening the PR is §3 `pr-open`. It is tried once: a refused push, the rows, or a failed
`gh pr create` opens nothing, the report names why under `WAITING ON YOU`, and the batch carries on.
Opened by hand later, record it with `queue.mjs set-batch promotion.pr=<n>` so the gate can mark
it ready. **Once the person merges it while children are still to merge into the base**, the next
pass opens the next one the same way, titled with its slice (`(slice 2)`), records it as `promotion`
with `slice`, `since` (the merge time the next slice counts from) and `merged` (the earlier promotion
PRs), and writes the ledger comment afresh on it. A batch whose every child had merged into the base
before that promotion merged opens no further one.

**The promotion PR carries the batch's ledger.** One comment on it, which only the autopilot writes,
holds a table with one row per child (key, state, PR link, and the model its worker ran on) between
`<!-- desk-autopilot:ledger -->` and `<!-- desk-autopilot:ledger-end -->`, so the feature can be
followed from GitHub. `pass.mjs` finds that comment by its opening marker (one you wrote, not a
reply quoting it), creates it once if it is missing and edits it in place whenever a row changes, a
child merging into the base included, under §3 `pr-edit`. It records what it wrote as
`promotion.ledger` so an unchanged ledger is not written again. The PR body is never read or
written for the ledger, so nothing the person writes there is overwritten; edits to the ledger
comment itself are. Comments that cannot be read or written (or the row not granted) are reported
as `ledger not updated`, the batch carries on, and the next pass tries again.

**The base gate checks the base before the promotion PR leaves draft, a slice at a time.** A
feature-mode batch promotes in steps rather than once at the end, so each promotion PR carries 5–10
children. `pass.mjs` starts the gate on a **slice**:

- when §3b "Promotion slice size (children)" (unset is 8; 5 to 10) of children have merged into the
  base since the last promotion PR merged and since the last gate, whatever the other children are
  doing (queued, running, open, parked or failed);
- when a child labelled `milestone` in the tracker merges (ticket-facts records its labels), whatever
  the count;
- when every child has merged: the last slice, which the epic close-out follows.

The report names the slice (`slice 2: 8 of 23 children`). A parked or failed child no longer stops a
slice: the report lists it as `not in this slice`, and it still stops the last slice and the
close-out. Until a slice is due, the report says how many more children it waits for. Otherwise, at
the end of the batch:

- A child parked or failed: the last slice does not run. `WAITING ON YOU` carries `BASE GATE: not run`
  with each such child, and a promotion PR no slice has passed stays draft.
- A child that finished with no PR, or whose PR was closed without merging: the gate does not run,
  and `WAITING ON YOU` names it to requeue or drop.
- A child's PR still open: the gate waits for it (under `WAITING ON YOU` when no merge driver is
  running), and the batch is not idle.
- A slice due: the pass starts `base-gate.mjs` in the background (it can
  outlast one pass) and reports `BASE GATE: started`. The batch is not idle while it runs, and while it
  runs in the base worktree the pass leaves that worktree alone (no sync, no baseline): new children
  branch from origin's base as it stands. In the
  base worktree the gate merges §0 Default branch in, runs §4 Install, the §4 Acceptance specs
  command once for each criterion id (the spine's, and any other a spec there is titled with), and
  §4 Typecheck, Lint and Unit tests (Jest and
  Vitest capped at §3b's test cap), each under its lock. Its result is the queue's `gate`, and its
  output is `<state>/logs/base-gate.log`.
- **Passed** (every spec and check passed, and no spec under the acceptance directory is still
  marked expected-fail or skipped): the promotion PR is marked ready (§3 `pr-ready`; otherwise
  `WAITING ON YOU` says to undraft it) and the report gives its link. Merging it is the person's.
  Only the last slice's pass offers the `close-out:` line. Once a child no gate has covered merges
  into the base, the pass puts the PR back in draft (`gh pr ready --undo`), whoever undrafted it,
  until the next slice's gate passes, so a ready PR never holds an untested child. A refused undo is
  under `WAITING ON YOU` and tried again each pass.
- **Failed**: each failure is under `WAITING ON YOU` and the PR stays draft (put back, as above, if
  it had left draft), while children keep
  spawning and merging into the base. The fix goes onto the base; the gate runs again on the first
  pass after the base moves (or at once after `queue.mjs set-batch gate=null`). A gate that failed
  only because merging §0 Default branch in conflicted is not yours: the pass hands the conflict to
  the base's conflict fix worker (`feature-branch.md`), the gate waits while it runs, and the conflict
  reaches `WAITING ON YOU` only once that worker may not take it or its tries are spent.
