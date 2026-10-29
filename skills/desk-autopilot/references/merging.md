# desk-autopilot: merging each PR on green

Part of desk-autopilot, read at Stage 4 in the session before starting the merge driver, and at
Stage 7. It binds exactly as the core `SKILL.md` does. Where it says "above" or "below" of something
this file does not hold, or cites a section in *italics* it does not hold, that is in the core or in
the file the core's reference table names.

## Merge each PR the moment it goes green

**An open PR is not a finished ticket, and holding several open is what makes a batch expensive.**
Every merge moves `<default>`, and every PR still open has to absorb that move: a conflict to
resolve, a new head SHA, and, where a required check matches the review verdict against the *exact*
head, a whole fresh review and CI run. The cost is quadratic in how many you hold: the last of a
batch carried to all-open-before-any-merged pays a conflict resolution and a re-review for each PR
ahead of it, none of which exist had each merged when it first went green.

**This section applies as written where config §3 `autopilot-merge` and `pr-merge-green` are both
`yes`, or where the user approved merging this batch at Stage 3 (the queue's `approved.merge` is
`true`; the §3 table under *Read the config first*).** Where neither holds, do everything below except the merge itself:
undraft (if `pr-ready` allows), keep the checks green, and put each green PR in front of the user the
moment it flips (the pass lists it as `READY TO MERGE`): the cost of holding PRs open is the same, so
say so rather than letting them queue.

**"Green" is the config's one definition** (desk-config "Green"), the same in the driver, in
`desk-clearance`, in `desk-ticket` and here: on the **exact head commit** being merged, every §4
Required checks entry completed with success (**a skipped one passes**, as branch protection counts it); no other check failed, errored,
timed out or is still queued or running, unless §4 Advisory checks names it; and at least one check
completed with success. With Required checks `none`, the second and third clauses still apply. The
merge is pinned to that commit, `gh pr merge <n> --<§4 Merge method> --match-head-commit <sha>`, so a
push after the checks cannot be merged unchecked. With §4 Branch protection `none`, GitHub will
accept a merge with red checks, so the rule is enforced only by you and the driver.

**Merge holds.** A PR whose diff touches any glob in §4 Merge holds (for a `<glob>#<key>` hold, changes
that key of the file) is merged by a person, never by
the driver or by you, whatever §3 grants: the repo needs a manual step first (the hold says which).
The driver skips it and logs `HELD`; you put it under `WAITING ON YOU` with the hold's reason, the
PR link and its head SHA, and it stays there until the user says they have merged it.

**Known flaky checks: the one written waiver.** A PR whose only red checks are named in §4 Known
flaky checks (`` `<check>: <glob> [<glob>…]` ``) is merged by the driver, pinned to its head, once
each of them is still red after the driver's two reruns at that head, the PR's files touch none of
the globs the row gives for that check, and nothing else in the gate is red or pending. It logs
`WAIVED <check>`, and once merged files a ticket naming the check, the PR, the head SHA and the
failing run (`desk-jira create`, under §3 `jira-create`). Where it cannot file one (§3 not `yes`,
Tracker `none`, or `create` refused), its log names the body file under `<state>/merge-driver/`:
put that under `WAITING ON YOU`. It never waives:

- a check the PR's diff could have broken (it touches one of the row's globs): logged as the waiver
  not applying, and red as ever;
- a §4 Required check, whatever the row says: branch protection enforces it, and merging past it
  would be a bypass (§3 `merge-bypass` is `never`). The driver records it as `merge_blocked` and you
  report the PR;
- a check the row does not name: red, as it always was.

A row that does not parse stops the driver at start, naming the row; fix it with `/desk-setup`.
Unset waives nothing.

**Fix tries: what the driver cannot merge goes back to a worker, twice.** Each pass reads every
ready batch PR (`pass.mjs`, `fix-tries.mjs`). One still red after the driver's two reruns at its
head, and not waived above, or one GitHub reports in conflict with its base, has its ticket
requeued for a fix worker on the same branch and PR. That worker's briefing names each failing
check with its run URL, or the conflict with the files git lists, and the worker gets the fix as its
task (`AUTOPILOT_TASK`). The try is kept on the ticket as `fix` (`try`, `of`, `what`, `head`) and
appended to `fix_tries`, and a head gets one try at most. After two tries, or a try whose worker
left the head where it was, the PR is not requeued again: the ticket records `stuck`
(`still red after 2 fix tries: <check>`, or the conflict) and it goes under `WAITING ON YOU`. A check
§4 Checks workers can't fix names is never a worker's. A PR red only on such a check is stuck with
`<check> · <what fixes it>`. A PR red on one beside a fixable check is requeued for the fixable one,
and its briefing says the other is not the worker's to fix. desk-q shows each ticket's try and
what it is fixing. Usage pacing never holds a fix try: while 7-day usage is ahead of pace, new
tickets wait and fix tries still start, within the batch's worker count.

When the pass takes a PR out of draft, it comments on it: why it left draft, quoting the clean
verdict it read on that head.

**Start the merge driver at Stage 4, before the first worker finishes, unless the batch is handed
to the supervisor (it starts one itself): do not merge off your own turn cadence.** Merging tied to when a monitor happens to wake you is how a PR sits green and
unmerged: nothing undrafts, merges or retriggers it until the orchestrator's next turn.

The driver **refuses to start while §4 Merge holds is unset** (write `none` when nothing is held),
as it does for §4 Required checks and Merge method.

```bash
nohup ~/.claude/desk/bin/merge-driver.sh --tickets "ABC-1 ABC-2 ABC-3" --deps "ABC-3:ABC-1" \
  --log &
```

`--log` has the driver append its own output to `<state>/merge-driver.log`, so the command carries
no `>>` redirect: a redirect outside the working directory prompts every time, whatever the allow
rules say. **Where the batch is handed to the supervisor, do not start one**: it starts the driver for a
handed-over batch and starts it again after a reboot (*The supervisor*).

It loops every ~2 minutes over the batch's **ready** (non-draft) PRs by config §1's handle, **one at
a time**: skips a PR with outstanding review feedback where `merge-feedback-first` is `yes`, skips
a PR under a §4 Merge holds glob (logging `HELD` and the reason), disarming any auto-merge armed on
either, merges with §4 Merge method and `--match-head-commit <sha>` when the head is green, updates
a `BEHIND` PR with `gh pr update-branch` where §3 `pr-update-branch` is `yes`, skips a `DIRTY` PR,
and, where `ci-rerun` is `yes`, retriggers `gh run rerun <id> --failed` only once that run has
reached `completed`. It **never arms auto-merge** (the platform's idea of green is not the
config's) and never undrafts. Why a ticket's PR is not merging is recorded on the ticket as
`merge_blocked=` (a hold, or behind without `pr-update-branch`), which `queue.mjs render` shows. It
matches a ticket's PR by the recorded branch and base (above). `--tickets` is the starting set:
every loop also takes in each ticket in the queue, so a ticket admitted or requeued mid-batch is
merged with no restart. `--tickets` takes whitespace- or comma-separated keys and refuses (exit 2) anything that is not a key for this repo (§4 Ticket
key pattern, §4 Other work id patterns, or the Tracker-`none` forms), and `--deps` anything not
`<key>:<key>[,<key>…]`. Only one driver runs at a time (`<state>/merge-driver.lock.d`); a second
exits 1 naming the holder's pid. Two things it must get right or it makes the problem worse: **never
retrigger a run that is not `completed`** (per-PR `cancel-in-progress` kills the run in flight, and a
loop that re-reads too soon after a rerun sees the stale `completed` and fires again, starving the PR
forever) and **only one PR may be building a preview at a time** (see the preview-build cap below).

- **Merge on green as defined, not on the checks you like.** A red check is advisory only when §4
  Advisory checks names it, and waivable only by the driver under §4 Known flaky checks (above),
  never by you. Read checks with
  `gh pr checks <n> --json name,state,bucket` against the head SHA you will pin, or `awk -F'\t'` on
  the plain output: it is tab-separated and a name column that carries an emoji makes splitting on
  whitespace silently yield the wrong word instead of the verdict, and nothing ever merges.
- **Never bypass them.** `--admin` is not yours to use (`merge-bypass` is `never`).
- **A review gate can fail on a PR's first CI run when the review posts late.** Where a required
  check reads the posted review verdict: opening the PR triggers CI seconds before the worker posts
  its review. If the gate polls for the verdict briefly, a review posted inside that window passes
  the same run. Posting starts no run of its own: CI typically runs only on open, reopen and push.
  Otherwise confirm the verdict's SHA equals `headRefOid` and re-run the whole failed set once the
  run is `completed`. The driver merges on its next loop once the gate clears.
- **A PR that has gone `DIRTY` merges nothing.** Resolve it, then expect the re-review: that is the
  cost this stage exists to avoid paying seven more times. A conflict in a generated file (one whose
  header says it is generated) is resolved by taking `<default>`'s version and re-running only that
  generator.
- **Undraft only once the PR is done and reviewed with no findings**, and only where config §3
  `pr-ready` is `yes`, or is `ask` and the user approved undrafting for this batch at Stage 3 (the
  queue's `approved.undraft` is `true`), then do whatever is needed to merge it immediately. Under
  that batch approval, undraft without asking again, and add one line to `batch-notes.md` with the
  Edit tool each time: `- [<TICKET>] undrafted #<n> at <head sha>: §3 pr-ready is ask, batch approval
  given at Stage 3`. Declined, or never asked, is today's rule: report the PR as ready to undraft. Done and reviewed means the review verdict on the PR's **current**
  `headRefOid` reads as §4 Clean review verdict with nothing deferred and no requirement gaps, the
  screenshots are uploaded (or the body says nothing renders differently), and `mergeStateStatus` is
  not `DIRTY`. Where §4 Clean review verdict is plain text (`no findings`) rather than counts, a
  desk-review verdict marker reads clean only with every count it writes at 0, and a review with no
  marker only when it is the latest at the head, opens a line with that text as its outcome, states
  that nothing is deferred or carried, and names no deferred, carried or counted item; an unset row
  leaves every draft to the person. A review gate may pass with gaps open, so a gap count above 0 is a question for the
  user, not a merge: keep it draft, since the driver merges any ready PR that goes green. With §4
  Local review command `none`, there is no verdict: "reviewed" is then the user's call, so report the
  PR rather than undrafting it. A clean verdict on a conflicted head is spent the moment the conflict
  is resolved. Workers are denied `gh pr ready`, so every pass checks these facts for each done
  ticket's draft PR (`undraft.mjs`, whoever runs the pass, the supervisor included), with its checks
  green too, then runs `gh pr ready` and writes that `batch-notes.md` line itself. One whose checks
  are still running, or whose mergeability GitHub has not worked out yet, waits for a later pass; any other draft it may not undraft is under WAITING ON
  YOU as `DRAFT`, with the reason and what to do. Either way it is recorded on the
  ticket as `undraft`; a feature spine is left to `queue.mjs approve`. The driver merges a ready PR,
  pinned, the moment it is green (never a PR under a §4 Merge holds glob). Do not arm auto-merge.
  Undrafting earlier pings the reviewer before the evidence is in.
- **A draft whose every red check was cancelled or timed out is re-run by the pass**, where §3
  `ci-rerun` is `yes`: those runs never tested the code. It keeps the driver's cap of two reruns per
  check per head and its 12-minute gap, in the same `reruns-<n>-<sha>` and `cooldown-<n>` files.
  Red again with a failure, or still red after both reruns, it goes on as any red draft does.
- **One preview build at a time, where PRs deploy previews (§4 Vercel set). Two is already too
  many.** A shared preview builder can OOM concurrent builds against each other: seven triggered
  together have given one `Ready` and six `Error` (exit 137), and **two** PRs opening a minute apart
  have killed *both* builds. A monorepo PR can trigger several previews at once (an app, docs, a
  component catalogue), so two PRs can be four-plus concurrent builds. Stagger PR creation and
  serialise every retrigger. Where this applies, it, not review or CI, caps how fast a batch can
  merge, and it is what a red preview-deploy check almost always means. Where config §3
  `read-vercel` allows, read the build log before treating it as broken code:
  `vercel inspect --logs <url> --scope <team slug from §4 Vercel>`, looking for exit 137 or
  "Out of Memory".

**Act, do not watch.** The failure this stage exists to prevent is a green PR sitting unmerged while
the orchestrator reports on it. If a PR can be merged, merge it before writing the next status
table; if a build is red and nothing is in flight, retrigger it. When asked why a batch is slow,
answer with the specific thing being waited on and what is already in flight against it.
