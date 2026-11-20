# desk-ticket: a Claude Design canvas

Read at Stage 0 when the ticket's Design section links a Claude Design artifact; it covers that
stage's check and Stage 1's save. A session that reached Stage 1 without reading it at Stage 0
(one resumed from the resume file) reads it at Stage 1.

**A Claude Design canvas is saved into the repo (Stages 0–1).** A shared artifact is viewable from
another account but not editable, and a headless worker cannot read one at all, so whenever a
ticket's Design section links a Claude Design artifact, the canvas goes into the repo and every
reader works from there. At Stage 0, check it (it also says where the copy belongs: under the
ticket's epic, or the ticket itself):

```bash
node ~/.claude/desk/bin/desk-design.mjs check <TICKET>    # blocking: … names the URL and the path; exit 1
```

**An `advisory` that says `it is snapshotted at <path>`** means `/desk-admit` or the orchestrator has
already saved every file the design needs. Save from that path (`desk-design.mjs save <path> --key
<TICKET>`, below; its `source.json` carries the URL and version) and build from the saved copy, with
no Artifact read: the snapshot stands in for the artifact even once it can no longer be read, so a
headless worker never parks asking for the design. A single-page artifact (a page with no
`canvas.json`) is saved and read the same way.

**A Slides deck is saved the same way.** Its snapshot holds `project/deck.json` and each slide at
`project/slides/<id>.html`; `save` copies them with their `/_blob/<id>` images and writes an
`index.html` beside them: open it to read every slide in order, offline. A deck has no boards and is
not rendered (slides are a fixed 1920×1080). An `advisory` that says `a single page rather than a
canvas or deck` needs nothing saved before the build.

**Two kinds of file a board needs are not among the published files.** Its images are `/_blob/<id>`
asset ids, in its attributes or in strings in its script: read each by its id, one `read` with
`path: "/_blob/<id>"` apiece (a `paths` read refuses asset ids), into the same `out_dir` as the files
below. And the `./support.js` a board loads is the type's runtime, which the artifact serves rather
than publishes: read `artifact-type/dc-runtime.js` instead. The save finds an asset by its id as the
file name, saves it as `assets/<id>.<ext>` and points the boards at it, and saves `dc-runtime.js` as the
`support.js` they load. `missing: asset <id>` is an asset still to read.

**Before reading any file for a `blocking` line, check who owns the artifact.** `check` cannot see
ownership. An artifact the Artifact listing marks as created outside the user's organisation, or
one whose read returns a summary rather than its files, is not saved: ask for access or an export,
and say so in the triage. A ticket that links its epic's canvas but uses no board from it says so on
a line of its own in the Design section, as `No UI.` is written: `No board yet.` (or `No board for
this ticket yet.`). `check` then gives an `advisory` saying there is nothing to save. Prose saying
the same is not read, and a section holding anything else beside that line and the link, alone on
its own line (no label), still blocks.

A `blocking` line means no copy is saved yet. With the Artifact tool, list the artifact's files
(`action:list scope:files`) and read `project/canvas.json`, every board's `project/*.dc.html`, and
the `support.js`, stylesheets and fonts they load, with `paths` and `out_dir: $DESK_STATE/designs/<TICKET>/`.
Then, on the branch after Stage 1:

```bash
node ~/.claude/desk/bin/desk-design.mjs save $DESK_STATE/designs/<TICKET> --key <TICKET> \
  [--boards '<board>,<board>'] [--epic <EPIC>] --url <artifact URL> --version <its version>
```

`--boards` names a board by its title, commas and all, or its file name (`Main.dc.html`). A name
that matches no board exits 2, saving nothing, and lists the boards the canvas has.

In a batch the orchestrator's snapshot already records the URL and version, so `--url` and
`--version` are left off. It copies those files into `<§2 Design canvases directory>/<EPIC or KEY>/`, or into the folder
already holding the same artifact, so a canvas several tickets share is saved once and each ticket is
added to it. It writes `source.json` (URL, version, fetched-at, the tickets using it) and a README
with the ticket-to-board table, and refuses, saving nothing, when a board references a file the
snapshot lacks (`missing:`): read that file too. A `remote:` line is a file loaded from the network,
which will not render offline; say so. Then render every board at every breakpoint, under the
browser lock:

```bash
~/.claude/desk/bin/with-lock.sh browser node ~/.claude/desk/bin/desk-design.mjs render <saved folder>
```

It writes `screens/<board>@<width>.png` for each width in §5 Breakpoints and each board's own width,
and lists them in the README, each width labelled `drawn` or `interpolated` (no board was drawn at
it). Exit 4 names a board and the file it could not load, and writes no image: save that file too.
Commit the folder, screens included, on the ticket's branch. Then make the
ticket's Design section carry both the artifact URL and the repo path (the `design:` line it prints),
via `desk-jira edit` under §3 `jira-edit`.

**The groom states the PR's upload count and time.** Once a canvas is saved, either here or already
(`check` prints `ok`, or an `advisory` naming the path), estimate what the PR's images will cost:

```bash
node ~/.claude/desk/bin/desk-design.mjs estimate <saved folder> --key <TICKET>
```

It prints `uploads: <n> (<boards> × <themes>), about <time> at 6 a minute and 300 an hour`. That is
one stitched image per board the ticket names, for each theme in §5 Themes (`desk-env list themes`;
one when the row is unset or `none`). A board drawn as another's dark theme ("Order summary dark")
stitches into that board's dark image, so it counts as that board, and its theme as one of the
themes. A `note:` line means `source.json` does not list the ticket
yet (a canvas saved for another ticket), so every board is counted: say so beside the count. Put
the `uploads:` line, and any `flag:` line, in the ticket's Design section beside the `design:` line,
via `desk-jira edit` under §3 `jira-edit`, and give the user the same lines in the update for the
stage you ran it at (Stage 0's triage for a copy already saved, Stage 1's for one saved there). A `flag:` line
means the uploads take over an hour: say so and suggest splitting the ticket by board, with at most
the number of boards per ticket that the line names. Never split the ticket yourself: that is the
user's call.

An artifact the user does not own reads as a summary, not the files: ask for access or an export
rather than saving that. **When a copy is already saved** (`check` prints `ok`, or an `advisory`
naming the path), still read the artifact's current version (`action:list scope:files`) and run
`node ~/.claude/desk/bin/desk-design.mjs status <saved folder> --version <v>`. Exit 3 means the
artifact has moved on: say so, and re-save as above on the user's confirmation (in a batch the
orchestrator asks and snapshots it).

**Comparing the build with each board (Stages 4–5).** Where §4 Storybook (`desk-env cmds
storybook-cmd`) is set, build it, then shoot each board beside its story, both under the browser lock:

```bash
~/.claude/desk/bin/with-lock.sh browser --cwd <DIR> -- <CMD>      # §4 Storybook, exactly as written
~/.claude/desk/bin/with-lock.sh browser node ~/.claude/desk/bin/desk-design.mjs compare <saved folder> \
  --storybook <DIR>/storybook-static --out <screenshot directory>/captures [--boards '<board>,<board>']
```

`--storybook` is the folder the build wrote (`storybook-static` beside its package unless the command
names another). `compare` serves the saved folder and the build itself,
with nothing fetched from claude.ai, and pairs a board with the story whose id, or title and name,
reads as the board's name, else a story whose title does (`Checkout/OrderSummary` for the board
`Order summary`). For each pair it writes `canvas-<board>-<width>.png` and `built-<board>-<width>.png`
at each §5 Breakpoint (as `render`; 390, 768 and 1440 are among the defaults) and the board's own
width: the canvas table's cells (desk-pr
`references/screenshots.md`), compared by eye, each result `PASS` or `FAIL` with what differs.
`not compared: <board>` is a board no story matches: the PR names it as not compared, with that
reason, and it parks nothing. A `note:` is a file the story could not load, worth a look before
calling the pair a `PASS`. Exit 4 names a board or story that failed, and writes nothing. Remove the
build folder afterwards (`git clean -fdx <DIR>/storybook-static`) so `git status` is clean.
