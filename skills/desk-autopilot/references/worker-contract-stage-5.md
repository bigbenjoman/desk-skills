# Autopilot worker contract: Stage 5, evidence, to Stage 7, PR

Part of the autopilot worker contract, read when you reach Stage 5, even when the ticket skips its
evidence, and before you push or open a PR (or earlier, as the core says). It binds exactly as the
core does.

## 4. Before you push: rebase

The default branch moves while you work. `git fetch origin`, and if
`git rev-list --count HEAD..origin/<default>` is non-zero, probe with
`git merge-tree --write-tree origin/<default> HEAD | grep -c '^CONFLICT'`, without touching the
tree. Clean → rebase, then **re-run typecheck and your specs**. Any conflict → park, naming the
files.

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
