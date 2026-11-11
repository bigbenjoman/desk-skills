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

**Merge holds.** A PR into §0 Default branch whose diff touches any glob in §4 Merge holds (for a
`<glob>#<key>` hold, changes that key of the file) is merged by a person, never by
the driver or by you, whatever §3 grants: the repo needs a manual step first (the hold says which).
The driver skips it and logs `HELD`; you put it under `WAITING ON YOU` with the hold's reason, the
PR link and its head SHA, and it stays there until the user says they have merged it. The one hold
that is met with no person is one whose reason is a code-owner approval (it matches `code owner` in
any spelling) where the base's CODEOWNERS gives every held file to §1's handle alone: nobody else's
approval exists to give, so GitHub's own review decision and the gate decide that merge. Any other
owner keeps it held, and the hold's reason names them. A PR into any
other base (a feature batch's) deploys nothing, so it merges as any other; the hold falls on that
base's own PR into the default branch. The driver records it on the child's ticket as it merges, and
each pass names it under `WAITING ON YOU` against the promotion PR until that PR merges.

The other exception is a hold that names its routine (`<glob>: <why>; desk runs: <command>`) where §3
`merge-hold-routine` is `yes`: the driver takes the PR through the rest of the gate, then runs each
routine once at the head, in a detached checkout of it, and merges pinned to that head only if every
one exits 0 and the head has not moved. A routine that fails is recorded with the step it failed at
(its last line of output), and is not run again until a new head; put that under `WAITING ON YOU`.
You never run a routine yourself: it is the driver's, outside any session's permission mode.

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
- a check the row does not name: it stays red.

A row that does not parse stops the driver at start, naming the row; fix it with `/desk-setup`.
Unset waives nothing.

**State checks are never rerun.** A check §4 State checks names (`` `<check>[: verdict|approval]` ``;
unset, desk-gate.yml's `desk-review verdict` and `protected-path approval`) reads the PR's reviews,
approvals or title, so a rerun reads the same state and fails the same way. The driver logs each red
one with the error its run gave and reruns only the rest, so a PR red on nothing else gets no rerun
and no cooldown. A red `approval` check is recorded as `merge_blocked` `approval: … needs approval
from a human reviewer`, which desk-q and needs-you put to the person. A red `verdict` check with no
unclean review at the head (a review missing, for an older head, or in a form the gate rejects) goes
to a review worker that reviews the head and posts it, under the fix tries below; the person gets it
once no try is left. A bare one (a title check, or a CI gate red because one of these is) red with
no `verdict` or `approval` check beside it is put to the person as stuck. Where a red state check
shares a workflow run with one red check to rerun, the driver reruns that check's job, not the run
(with more, the run, and its log says the state check is rerun with it). A row that does not parse
stops the driver at start.

**Fix tries: what the driver cannot merge goes back to a worker, twice.** Each pass reads every
ready batch PR (`pass.mjs`, `fix-tries.mjs`). One still red after the driver's two reruns at its
head, and not waived above, or one GitHub reports in conflict with its base, has its ticket
requeued for a fix worker on the same branch and PR. That worker's briefing names each failing
check with its run URL, or the conflict with the files git lists, and the worker gets the fix as its
task (`AUTOPILOT_TASK`). The try is kept on the ticket as `fix` (`try`, `of`, `what`, `head`) and
appended to `fix_tries`, and a head gets one try at most. A conflict counts only conflict tries, so
tries spent on a check or a review still leave it two, and not one that left the PR mergeable until
a later merge to the base (each try records the base tip and merge base it was made at), up to five
repairs of any outcome per PR, after which the item names the files. After a repair the merge driver
holds a ready PR changing the same file behind the repaired one until it merges, goes red or parks,
or 60 minutes after the repair. A push that takes a PR the driver read as `DIRTY` out of conflict is
a repair too, a person's included, timed from when the driver saw it. After two tries, or a try whose worker
left the head where it was, the PR is not requeued again: the ticket records `stuck`
(`still red after 2 fix tries: <check>`, or the conflict) and it goes under `WAITING ON YOU`. A red
check whose job annotates an error line, or whose failed log names one, first gets one more worker
with those lines in its brief, once per PR and outside the two tries (`extra` in `fix_tries`), and
the stuck reason quotes the line. A check
§4 Checks workers can't fix names is never a worker's. A PR red only on such a check is stuck with
`<check> · <what fixes it>`. A PR red on one beside a fixable check is requeued for the fixable one,
and its briefing says the other is not the worker's to fix. desk-q shows each ticket's try and
what it is fixing. Usage pacing never holds a fix try: while 7-day usage is ahead of pace, new
tickets wait and fix tries still start, within the batch's worker count.

Before any of these, on every pass, each open child is compared with its base: a migration the base
has renumbered since the child left it, that the child's own changed files still name by the old
filename, sends the child to a worker with the old and new names (`migration-renames.mjs`, kind
`renames` in `fix_tries`). That try is outside the two tries, once per rename, and a child naming
none of the renamed files is left alone. A PR in conflict goes to its conflict tries first. The merge
driver leaves that PR alone, red or green, until the pass closes the try, as it does for the person's
instruction.

Out of draft, a check §4 Check builds names is a person's too, with its command, and so is one that
is, or failed at a step that is, a §4 Pre-merge steps item, with that step. A stuck reason names
each check a worker could not fix with the step its run failed at (`Lint (failed step: Run eslint)`),
and `stuck` keeps the checks by name: desk-q and desk-needs-you drop any that has since gone green on
the PR, and stop showing the PR as stuck once none is left. A needs-you item whose blocker is a step
outside GitHub recommends nothing: it names the step.

Review feedback goes to a fix worker the same way, under the same two tries. A ready PR whose latest
desk-review at its head is not clean, with a P0 or a P1 (or a gap, under §3 `autopilot-judgement`
`yes`), gets a review fix, as a draft does. Where `merge-feedback-first` is not `no`, one with a
review thread left unresolved (one no clean verdict settles) or changes requested gets a feedback
fix: its briefing quotes each thread, and the worker validates each with `desk-review-response`,
fixes what is right, answers every thread with `gh pr comment`, pushes, and posts a fresh
desk-review on the new head. Once that worker has finished and pushed past the try's head, the pass
replies on each thread the try quoted and resolves it, so the next pass reads only what is still
open. A worker that cannot fix a thread parks naming it and what blocks it. Out of tries, the PR is
`stuck` with `review feedback still open after 2 fix tries: <each thread>`.

Every PR, whatever its title, merges on a clean review with no person's approval: desk-review, fix,
desk-review, merge. Where §4 Local review command is set, the driver merges a green PR only with a
clean verdict (§4 Clean review verdict) at its head, or one carried to it by clean merges of the base
alone. It reads the verdict itself, since green holds one only where CI runs a §4 State check reading
it. A P0, a P1 or an uncarried P2 blocks; a carried P2 does not. With no verdict or a stale one, it does
not merge, and the pass sends it to a review worker out of draft (`fix-tries.mjs` `verdictTry`), and
to the person once no try is left. A review at the head that is not clean goes to a fix worker where
it lists a P0, a P1, a P2 or, under §3 `autopilot-judgement`, a gap (`reviewFix`; P2s once nothing worse
is left, and a later round may carry one), and otherwise to the person. A gap the review tags `PERSON'S
CALL` earns no fix try and goes to the person, after any try the rest of the review earns: on a draft
or a ready PR, the needs-you item offers `answer`, and a worker on the PR carries out their call.

With the `review-reuse` lever on (config §3b Phase 0 levers), the carry rests on what the review read
instead: after a rebase or any merge of the base, a verdict holds at the new head only while the PR's
own diff is unchanged and the base changed none of the files its `rests-on` line names, no dependency
manifest or lockfile and no repo configuration (`undraft.mjs` `restsOnCarries`). The undraft comment
and the driver's log name the base range checked, and say the head itself was not reviewed. Otherwise
the head is reviewed again, as with no verdict. A repo running desk-gate's `desk-review verdict` check
gets no saving from a carry, as with the carry above: that check reads only a verdict posted on the
head, so a head it holds red is reviewed again. That limit is kept on purpose: the gate is what a
writer's review attests at the exact head, and a carry the orchestrator decides is not an attestation
it can check, so `review-gate.mjs` still never reads one.

When such a carry fails over a clean review, the review try is narrowed where it can be
(`undraft.mjs` `targetedReview`). That applies when the PR's own diff is unchanged and the base changed
some files the review rests on but no lockfile, manifest or configuration file (`restsOnAlways`). The
try's brief then names those files and the PR's changed files that name one, and desk-review's
targeted round (its `targeted.md` reference) reads only them. Its review records what it re-reviewed and
what it carried from the earlier one, at which heads, and is read like any review at the head: a P0 or
P1 goes to a fix worker. Any other failed carry, or the lever off, gets the whole review.

The driver does not wait on GitHub's review decision: desk opens PRs from the person's own account,
and GitHub never lets an author approve their own PR. A person's approval holds a PR in two cases only.
One is a PR whose GitHub review decision is `REVIEW_REQUIRED`, because branch protection wants an
approving review. The other is a red §4 State check of kind `approval`. Either is recorded as
`merge_blocked` `approval: …`, red or green, and desk-q and needs-you ask the person. No rerun or fix
worker gives it the approval, though a red one is still rerun and repaired. The request is cleared
once that no longer holds the PR. A §4 Merge holds path still waits for a person whatever its review says.

Before a red check's approval goes to the person, a worker tries what a change on the branch can
clear (`fix-tries.mjs` `gateTry`), read from the error lines the check's job gave. Protected files the
line names go to a protected-files try: its worker drops each change the ticket's criteria do not need,
or changes nothing and says which criterion needs it. One goes per head, only for a file no earlier one
judged, two at most per PR, outside the fix tries. A file still in the diff after its try is the
person's to approve. A line saying the gate reads no verdict at the head (none, a stale one, an old
format) gets a review try there first, under the fix tries. A file count or a title alone is the
person's.

A PR in conflict goes to a fix worker only where §3 `pr-conflict-unreviewed` (no one but the user's
handle, and no bot, has reviewed or commented on it) or `pr-conflict-reviewed` (someone has) is
`yes`, the rows a batch base's conflict reads too (`feature-branch.md`). Otherwise it goes under
`WAITING ON YOU` as `CONFLICT`, to resolve on its branch.

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
a time**: skips a PR with outstanding review feedback where `merge-feedback-first` is `yes` (first
resolving each thread an earlier desk-review by that handle opened, once the latest desk-review
verdict reads as §4 Clean review verdict at the head; anyone else's thread stays), skips
a PR under a §4 Merge holds glob (logging `HELD` and the reason), disarming any auto-merge armed on
either, merges with §4 Merge method and `--match-head-commit <sha>` when the head is green, updates
a `BEHIND` PR with `gh pr update-branch` where §3 `pr-update-branch` is `yes`, skips a `DIRTY` PR,
holds a green one that fails §4 Merged-tree check once merged into the base's head (run last before
the merge, in a throwaway checkout; recorded on the ticket as `tree_check`, which the pass sends to a
conflict fix worker under the same §3 conflict rows as a `DIRTY` PR, not to the person; an epic PR's
is noted on the queue's promotion (`merged-tree check: …`), which the pass reports to the person,
and cleared once it passes; a check
that timed out holds the merge for that loop only; with the row unset or `none` the log says none is
configured and it merges), and, where `ci-rerun` is `yes`, retriggers `gh run rerun <id> --failed` only once that run has
reached `completed`. It **never arms auto-merge** (the platform's idea of green is not the
config's) and never undrafts. Why a ticket's PR is not merging is recorded on the ticket as
`merge_blocked=` (a hold, behind without `pr-update-branch`, a PR held for unresolved threads on
two loops, green or red, naming the first, or one waiting on an approval), which `queue.mjs
render` shows and desk-q and needs-you list as needing the person, apart from held threads with a
fix try still left, which desk-q shows as merging. In `queue.mjs render` a done ticket reads
`DONE` only once its PR has merged (or it finished with no PR): `PR OPEN` while its PR is open,
`CLOSED` once it was closed unmerged. It
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
  given at Stage 3`. Declined, or never asked: report the PR as ready to undraft. Done and reviewed means the review verdict on the PR's **current**
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
  ticket as `undraft`; a feature spine is left to `queue.mjs approve`. **A draft the person put back
  to draft is theirs to hold**: one the pass undrafted before, or whose PR events hold a
  `convert_to_draft`, is recorded as `undraft` `held`. The pass then never undrafts it, re-runs or
  builds its checks, or sends it to a review or fix worker, and it is under WAITING ON YOU as `HELD` (desk-q and `/desk-needs-you` show it as needing the person). Their
  own `gh pr ready` releases it, and the driver merges it once green. The driver merges a ready PR,
  pinned, the moment it is green with a clean review at its head (never a PR under a §4 Merge holds glob). Do not arm auto-merge.
  Undrafting earlier pings the reviewer before the evidence is in.
- **A draft whose every red check was cancelled or timed out is re-run by the pass**, where §3
  `ci-rerun` is `yes`: those runs never tested the code. It keeps the driver's cap of two reruns per
  check per head and its 12-minute gap, in the same `reruns-<n>-<sha>` and `cooldown-<n>` files.
  Red again with a failure, or still red after both reruns, it goes on as any red draft does.
- **A draft with a stale review or a red check goes to a worker before it reaches you.** A verdict
  for an older head still holds at the current one when every commit since is a clean merge of the
  base, and the ticket records it as carried from that commit. Otherwise a draft with no verdict
  readable at its head goes to a review worker, and one with a red required check to a fix worker
  with each check's name and run, within the same two tries as a ready PR's fixes (`fix-tries.mjs`
  `reviewTry`, `draftChecksFix`). desk-gate's own verdict check reads only the head, so a draft red
  on it alone goes to a review worker. Such a draft is under WAITING ON YOU only once those tries are
  spent, or when its red check is one §4 Checks workers can't fix names. With the `failure-class`
  lever on and §3 `ci-rerun` `yes`, a draft whose checks a worker would take all have error lines
  classed runner or resource is re-run once first; red again, its fix try says one rerun was tried.
- **A draft red only on checks §4 Check builds names gets their build from the pass**, where §3
  `ci-rerun` is `yes` (`check-build.mjs`): the row's command runs once per head on the host, from the
  pass's clean checkout of origin's default branch (`<state>/live-read-checkout`, the one Live reads
  run from), never the ticket's worktree, so no script or file the worker wrote runs. It receives the
  PR's tree as `DESK_CHECK_TREE`, a clean checkout of the head the pass owns
  (`<state>/check-trees/<n>`, reset to the head before each build and removed once the PR merges or
  closes), with the head's SHA as `DESK_CHECK_HEAD`; a command that ignores them builds the default
  branch. The command must install and write nothing in the default-branch checkout: a file left
  there, an ignored one included, makes it dirty for every later check build and live read. Where
  either checkout cannot be made (a failed fetch, a dirty checkout), nothing runs and the draft goes
  to the person with the reason. It runs detached so a pass that ends leaves it running,
  with its output and exit code under `<state>/check-builds/`. Once it succeeds, the pass re-runs those checks with
  `--failed`. A command that fails at a head behind its base goes to a sync try (`fix-tries.mjs`
  `syncFix`, one of the fix tries): its worker merges the base, fixes what the merge breaks in a commit
  of its own and pushes, and the pass builds the new head. A command that fails at a head up to date
  with its base, or a check still red after the re-run, goes to the person with the command, its exit
  code and its last lines; it is not run again at that head. A worker never runs it,
  and never parks on it: a worker whose park asks only for that build (every clause names the check or
  its command, or lists the steps it did not reach), while its open draft is red on those checks alone, is recorded done at harvest
  (`undraft.mjs` `buildPark`), so this step builds it. A park that asks anything else stays a park.
- **A conflicted draft goes to a fix worker, not to `DRAFT`**, where §3 `pr-conflict-unreviewed`
  (no one but the user's handle has reviewed or commented) or `pr-conflict-reviewed` (someone has)
  is `yes`: it merges `<default>` in, reviews its new head and posts that review, within two tries of
  its own, one per head (`fix-tries.mjs` `conflictFix`): tries of another kind leave a conflict its own. A new head it leaves with no review of its
  own is a stale review, so it goes to a review worker as above. Such a draft reaches WAITING ON YOU
  only once its tries are spent, as `STUCK` with what the last try reported.
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
