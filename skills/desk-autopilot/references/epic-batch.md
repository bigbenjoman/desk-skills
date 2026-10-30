# desk-autopilot: an epic as a batch

Part of desk-autopilot, read at Stage 0 when an argument is an epic, and at the epic's close-out. It
binds exactly as the core `SKILL.md` does. Where it says "above" or "below" of something this file
does not hold, or cites a section in *italics* it does not hold, that is in the core or in the file
the core's reference table names. Feature mode is in `feature-mode.md`, read only when `plan-batch`
turns it on.

## An epic as a batch

A large feature runs as an epic: one key whose children are the tickets. **An epic runs as its own
feature batch, beside the standing batch, never over it.** For an epic, Stage 0 starts that batch
in place of `init`, which would write a fresh queue over the standing batch's and, by setting a base
on it, stop standing intake; the standing batch, its supervisor and intake carry on untouched. A repo
runs one feature batch per epic, each on its own branch, beside the standing batch and every other
epic's; all of them share the repo's limits, and when more of them have ready work than the §3b cap
has slots, the free slots go to each in turn. **Start the batch, then expand the epic, both at Stage 0 before
triage**, and never triage, build, transition or edit the epic itself:

```bash
git -C <§2 Primary repo root> fetch origin --quiet
git -C <§2 Primary repo root> push origin origin/<default>:refs/heads/feat/ABC-900-<slug>   # only when it is not on origin yet
node ~/.claude/desk/bin/batch.mjs start ABC-900 feat/ABC-900-<slug> --batch ABC-900          # the batch ABC-900, its epic and base set
node ~/.claude/desk/bin/expand-parent.mjs ABC-900 --batch ABC-900   # the batch keys on stdout, the report on stderr
```

- **The feature branch** is named as §5 Branch names says, cut from `origin/<default>`, and is the
  batch's base from the start. Pushing it is §3 `git-push`: at anything but `yes`, ask it now, the
  one question before `start`. A branch already on origin is used as it is.
- **`start` refuses (exit 11) and makes nothing** while another epic's feature batch is live on the
  same branch, naming it: show the person and stop. It refuses a batch that already exists for this epic
  too: an earlier session started it, so pick it up with `--batch ABC-900` rather than start it
  again. The batch is not handed to the supervisor until Stage 4.
- **Every later command for this batch passes `--batch <EPIC>`**: triage, the plan, every pass, the
  merge driver, answers, holds, admits, approvals, the hand-over at Stage 4 (`queue.mjs set-batch
  supervised=true … --batch <EPIC>`), and the close-out; the Stage 4 handoff says so. Without it a
  command acts on the standing batch.
- **The epic's children merge into its feature branch, never into §0 Default branch**, so production
  carries no half-built feature: the whole feature reaches the default branch through the promotion
  PR the person merges (*Epic close-out*). `start` refuses the default branch as a base. From here
  on, the base works as *A batch that targets a feature branch* says.
- Tickets the user names with the epic that are not its children are not in its batch: say so, and
  run them on their own, in the standing slot (`/desk-autopilot` with no epic, or `/desk-admit`).
- **A declined plan discards the batch.** When the person declines the epic's plan at Stage 3, run
  `node ~/.claude/desk/bin/batch.mjs discard ABC-900 --batch ABC-900` and report what it prints. It
  removes the batch's queue and state folders, and deletes the feature branch from origin when that
  holds no commit §0 Default branch lacks; otherwise it keeps the branch and says why, naming the
  command to delete it by hand. It refuses a batch with a started ticket or one handed to the
  supervisor.
- `expand-parent` keeps the epic's children that are this repo's keys and not started, in Jira rank order. A
  child story that has open subtasks is replaced by them (one level), **whether the story itself is
  To Do or In Progress**, and its Blocks links pass to them (`<state>/expansion.json`, read by
  `plan-batch`). Done children are dropped; **in-progress children are dropped** too (one may
  already have a PR), and so is an In Progress story with no open subtask: include one only if the
  user names it. The subtasks of a story are read before its own status is, because an In Progress
  story is where open subtasks usually sit, and dropping it first made them vanish unreported.
- Exit 4 means the key is not an epic: discard the batch (as for a declined plan) and run the key as
  an ordinary ticket in the standing slot. A story runs as its subtasks only when the user asks for
  exactly that (`--subtasks`); a bug or story named on its own with QA or checklist subtasks runs as
  itself, as it always has. Exit 3: nothing open under it; discard the batch and say so.
- **State the expanded list and every drop with its reason in the Stage 2 report.** A child the
  user named alongside the epic is one key, not two.
- Triage reads the epic's description for context; each child's own criteria are its scope.
- Tickets filed during the batch (an L split into children, a close-out follow-up) are written in
  desk-jira's `references/ticket-template.md` layout for their type, each child with its own
  criteria and its dependencies as Blocks links, and join the batch one at a time: fetch as at Stage 1, `triage.sh <KEY> --batch <EPIC>`, then `queue.mjs admit <KEY> --batch <EPIC>` (and `queue.mjs hold <KEY> <BLOCKER> --batch <EPIC>` if it is blocked by a
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
3. The promotion PR (base → default) is the user's to merge. Title it with the epic
   key so `/desk-review` checks the epic's criteria against the whole feature, and say so. In feature
   mode it is already open, titled that way, and the last slice's gate marked it ready; earlier
   slices' promotion PRs may already have merged. Otherwise open it now, under §3 `pr-open` (at
   anything but `yes`, ask, or give the person the command):
   `gh pr create --repo <repo> --base <default> --head <base> --title "ABC-900: <the epic's summary>" --body "Promotion PR for ABC-900: everything its batch merged into <base>. Merging it is the person's call."`
   (with no terminal, `gh` refuses a PR with no body).
   Then record it on the batch, `node ~/.claude/desk/bin/queue.mjs set-batch promotion.pr=<n> --batch ABC-900`,
   so the supervisor archives the batch once it merges.
4. **Never transition the epic**, whatever the result.
