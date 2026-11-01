# Autopilot worker contract: Stage 5, evidence, to Stage 7, PR

Part of the autopilot worker contract, read when you reach Stage 5, even when the ticket skips its
evidence, and before you push or open a PR (or earlier, as the core says). It binds exactly as the
core does.

**A park asking for a CI or end-to-end run**, at Stage 7 as anywhere, follows the Stage 4 file's "A
CI or end-to-end run you ask for is the narrowest one that covers your change": a session that
started at Stage 7 has not read it, so read it before you write that park.

## 4. Before you push: rebase

The default branch moves while you work. `git fetch origin`, and if
`git rev-list --count HEAD..origin/<default>` is non-zero, probe with
`git merge-tree --write-tree origin/<default> HEAD | grep -c '^CONFLICT'`, without touching the
tree, so you know before you start which files will conflict.

**How you bring it in.** Rebase (`git rebase origin/<default>`) while your branch is not on origin
yet (`git branch -r` does not list it), or where config §3 `git-force-with-lease` is `yes`, pushing
an already-pushed branch with `git push --force-with-lease origin <branch>`. A branch already on
origin with `git-force-with-lease` not `yes` takes `git merge origin/<default>` instead: no rebase,
no force push. Your settings refuse that rebase, unless your prompt names a force-push the person
approved once; then rebase and push with exactly that command.

**A conflict is yours to resolve, not a park.** Resolve each conflicted file keeping both sides'
intent: their change lands, and so does yours. Where their side renamed, moved or reshaped
something yours uses, carry your change onto their new form; never drop their hunk to make yours
apply. A conflict in a generated file is regenerated with its §4 row, not hand-merged. Stage the
files, then `git rebase --continue` (or `git commit --no-edit` for a merge); if `--continue` cannot
open an editor, `git commit --no-edit` first and `--continue` after it. Then:

- **Re-run typecheck and your specs**, under the lock (Stage 4 file), whether or not the rebase
  stopped.
- **A fresh `desk-review` at the new head, before you push**, whenever you resolved a conflict:
  the resolved hunks are in neither side's reviewed diff, even where you took both sides verbatim.
  Its findings are handled as Stage 4b's are.
- **Say it in the PR's Testing**: the files that conflicted, with whose ticket or PR, and how you
  resolved each.

**Park only when the two sides cannot both stand**: they change the same behaviour incompatibly,
and choosing between them is a product or design decision. Park naming the files and the decision
needed, with the remaining tail (core section 1). Which code shape keeps both is an engineering
call, and yours.

## 5. What the orchestrator owns, not you

- **Your port and your database** are assigned in your briefing. Never the user's own dev-server
  port (§3b). Never repoint or fill in a database variable: it already points at your own per-ticket
  database, or is blank because you have none.
- **Uploading images to the PR.** You capture; the orchestrator uploads. One shared signed-in browser
  profile means uploads must be serialised. Capture per `desk-ticket` Stage 5 and build the table
  per `desk-pr` (**not optional when anything renders differently**) into the screenshot
  directory named in your briefing (an absolute path ending `/.desk-autopilot/<slug>/images/<TICKET>/`),
  then print `AUTOPILOT_IMAGES: <that absolute path>`, copied exactly. That directory is one you can
  `Read` back, so **look at every shot before you print the marker**: a cookie banner, a fixed navbar
  or an empty element is not evidence.

  **Captured no screenshots? Print no `AUTOPILOT_IMAGES:` line at all**, even though your briefing
  names the directory: a ticket that renders nothing has no images for the orchestrator to upload.

  Leave the image cells as `_drag <file>_` placeholders, but **leave nothing else**: no "delete this
  row once the images are in", no TODO. The body ships to a reviewer as written.

  `desk-pr`'s screenshot references carry the routes and their gotchas: follow them rather than
  improvising. Three that bite workers: dismiss the consent banner or it covers the content;
  take the "before" with `git checkout HEAD~1 -- <path>`, **never `git stash`** (it is shared across
  every worktree); and real data needs the repo's seed command (§4 Local database says how), run
  against your own database. "I could not seed" is not a reason to skip evidence.
- **Opening the PR as a DRAFT.** `gh pr create --repo <repo> --draft --base <default> --head
  <your branch> --body-file <file> --title "<title>"`, in that order: the allow rule matches only a
  command beginning `gh pr create --draft` or `gh pr create --repo <repo> --draft`, and `--repo`
  keeps a fork's origin from getting the PR. Never open a
  ready-for-review PR, and never mark one ready: `gh pr ready` is denied to you. A non-draft PR
  notifies the reviewer **the moment it opens**, before the orchestrator has uploaded your
  screenshots, and pulls the reviewer to evidence tables still full of placeholders. The orchestrator
  undrafts once the review at head is clean, the evidence is in, and config §3 allows it.

  **Write the body to a file inside your worktree** (`pr-body.md` at its root, removed afterwards
  with `git clean -f pr-body.md`). Do **not** pipe it via a `--body-file -` heredoc: that can fail
  with the body existing only in the transcript, leaving the branch pushed and **no PR at all**.

  **If the PR still cannot be opened, that is a PARK, never a done.** Print the body between two
  marker lines, each at the start of its own line and written exactly with the colon,
  `AUTOPILOT_PR_BODY_BEGIN:` and `AUTOPILOT_PR_BODY_END:` (the harvester only recognises
  `AUTOPILOT_<NAME>:`), so the orchestrator can recover it verbatim, then park naming the branch and
  the exact command that failed. A pushed
  branch with no PR is invisible to `desk-clearance` and to every reviewer. Name every step you did
  not reach, as the core's section 1 says.
- **Merging.** Never. Your terminal state is a draft PR with its review posted.
