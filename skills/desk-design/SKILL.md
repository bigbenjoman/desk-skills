---
name: desk-design
description: >-
  Use when a Claude Design canvas or Slides deck that a ticket's Design section links must be saved
  into the repo, checked or compared on its own, outside a /desk-ticket or /desk-admit run: "save
  this design", "snapshot the canvas for ABC-123", "is the saved design still current?", "the
  designer updated the canvas", "render the boards", "screens of the design", "compare the build
  with the design", a design's self-contained HTML export to import, or `/desk-design <TICKET>`. Not
  for implementing the design (muriel-design-engineer) or designing one.
---

# desk-design

## Overview

A shared Claude Design artifact is viewable from another account but not editable, and a headless
worker cannot read one at all. So a canvas a ticket links is copied into the repo (§2 Design canvases
directory, `desk-env get design-dir`, default `docs/design/`) and every reader works from that copy.
`desk/bin/desk-design.mjs` does the copying; it never talks to claude.ai. **You** read the artifact,
with the Artifact tool, and hand it the files.

**Core principle: read the artifact once, completely, then work only from the saved copy.**

Resolve this repo's config first:

```bash
desk-env where        # SLUG=, GH_REPO=, CONFIG=, CREDS=, EXISTS=yes|no
```

`EXISTS=no`: run `/desk-setup` first; the design directory, breakpoints and Storybook rows all come
from the config.

Every design belongs to a ticket: `--key` is required, and the copy lands under the ticket's epic,
or the ticket itself (`check` names the folder). With no ticket named, ask for one; never invent a key.

| The user wants | Run | Detail |
|---|---|---|
| to know whether a ticket's design is saved | `check` | step 1 |
| a canvas or deck saved into the repo | Artifact reads, then `save` (on the ticket's branch) or `write` + `propose` (no branch yet) | step 2 |
| a design's HTML export saved | `import` | step 3 |
| to know whether the saved copy is current | `status` | step 4 |
| screenshots of every board | `render` | step 5 |
| the built UI set beside each board | `compare` | step 6 |

The script is `node ~/.claude/desk/bin/desk-design.mjs <command> …`; its header lists every flag.

## 1. Check

```bash
node ~/.claude/desk/bin/desk-design.mjs check <TICKET>
```

- `ok: no unsaved Claude Design canvas`: every artifact the ticket links has a copy on the base (or
  it links none). Step 4 if the user asked whether it is current.
- `advisory … it is snapshotted at <path>`: a snapshot exists but is not in the repo yet: step 2's
  `save` or `propose` from that path, with no Artifact read. A single page snapshotted this way does
  not block a build.
- `advisory … but not its saved copy <path>`: saved, but the Design section lacks the repo path:
  add it beside the link (end of step 2).
- `blocking` (exit 1): no copy is saved on the base. It names the URL and the folder: step 2.

## 2. Save a canvas or deck

Read every file the design needs, with the Artifact tool, into `$DESK_STATE/designs/<TICKET>/`
(`desk-env paths` prints `DESK_STATE`). **Read `desk-ticket/references/design-canvas.md` first**: it
lists the files (`project/canvas.json`, every `project/*.dc.html`, what they load), and the two kinds
a board needs that are not among the published files (each `/_blob/<id>` asset, one `read` apiece;
`artifact-type/dc-runtime.js` for `support.js`). A deck is `project/deck.json` and
`project/slides/<id>.html`. Note the artifact's version from the files listing.

**An artifact that returns a summary or an error, not its files,** is not one this account can read.
Never save a summary. Ask, in one `AskUserQuestion`: the design's HTML export by its path
(Recommended: it needs no sharing), or share the artifact with this account. An export goes to step 3.

Then, **on the ticket's branch** (a `/desk-ticket` run, or a branch the user has open for it):

```bash
node ~/.claude/desk/bin/desk-design.mjs save $DESK_STATE/designs/<TICKET> --key <TICKET> \
  [--epic <EPIC>] [--boards '<board>,<board>'] --url <artifact URL> --version <v>
```

then step 5, and commit the folder, screens included, on that branch.

**With no branch for it** (the user only wants the design in the repo), record the snapshot and let
`propose` cut the branch, from the main checkout:

```bash
node ~/.claude/desk/bin/desk-design.mjs write $DESK_STATE/designs/<TICKET> --url <artifact URL> \
  --version <v> --key <TICKET> [--epic <EPIC>]
node ~/.claude/desk/bin/desk-design.mjs propose $DESK_STATE/designs/<TICKET>
```

`saved: … no PR needed` means the base already holds it. `committed: <path> on <branch> in
<worktree>`: render it there (step 5), commit the screens in that worktree, and open the PR with
`desk-pr`, titled `docs(design): <FOLDER> design canvas`. It goes through the normal review.

`save` refuses, saving nothing, on `missing: <file>` (read that file too; `missing: asset <id>` is a
`/_blob/<id>` still to read). A `remote:` line is a file loaded from the network that will not render
offline: tell the user. Once saved, make the ticket's Design section carry both the artifact URL and
the repo path (the `design:` line `save` prints) with `desk-jira`, under §3 `jira-edit`.

## 3. Import an HTML export

```bash
node ~/.claude/desk/bin/desk-design.mjs import <path> --url <artifact URL> --key <TICKET> [--key <T2>] [--epic <FOLDER>]
```

Only the path the user gave; never search their folders for it. Exit 4 names the first file the page
loads from elsewhere: it is not self-contained, so ask for one that is. Then `propose` as in step 2.

## 4. Is the saved copy current?

List the artifact's files (`Artifact action:list scope:files`) for its current version, then:

```bash
node ~/.claude/desk/bin/desk-design.mjs status <saved folder> --version <v>
```

Exit 0: current. Exit 3: the artifact has moved on. Say so, and re-save (step 2) only on the user's
confirmation: a re-save replaces the boards a build was checked against.

## 5. Render

```bash
~/.claude/desk/bin/with-lock.sh browser node ~/.claude/desk/bin/desk-design.mjs render <saved folder>
```

It writes `screens/<board>@<width>.png` at each §5 Breakpoint and each board's own width, and lists
them in the README. Exit 4 names a board and the file it could not load (save that file, step 2);
exit 6 means Playwright is missing. A deck is not rendered (slides are a fixed 1920×1080): open its
`index.html`.

## 6. Compare the build with each board

Needs §4 Storybook (`desk-env cmds storybook-cmd`); with it unset, say there is nothing to compare
against. Build it and compare, both under the browser lock, exactly as
`desk-ticket/references/design-canvas.md` "Comparing the build with each board" says, then remove the
build folder. Report each pair `PASS` or `FAIL` with what differs, and each `not compared: <board>`
with its reason.

## Red flags — stop

- About to save, or build from, an Artifact `read` that returned a summary
- About to invent a ticket key for `--key`
- About to re-save over an existing copy the user has not confirmed
- About to run `render` or `compare` without `with-lock.sh browser`
- About to commit a saved folder on the main checkout's default branch instead of the ticket's branch or `propose`'s
- About to hand-copy files into the design directory instead of `save`, `import` or `propose`
