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

A `blocking` line means no copy is saved yet. With the Artifact tool, list the artifact's files
(`action:list scope:files`) and read `project/canvas.json`, every board's `project/*.dc.html`, and
the `support.js`, stylesheets and fonts they load, with `paths` and `out_dir: $DESK_STATE/designs/<TICKET>/`.
Then, on the branch after Stage 1:

```bash
node ~/.claude/desk/bin/desk-design.mjs save $DESK_STATE/designs/<TICKET> --key <TICKET> \
  [--boards '<board>,<board>'] [--epic <EPIC>] --url <artifact URL> --version <its version>
```

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

An artifact the user does not own reads as a summary, not the files: ask for access or an export
rather than saving that. **When a copy is already saved** (`check` prints `ok`, or an `advisory`
naming the path), still read the artifact's current version (`action:list scope:files`) and run
`node ~/.claude/desk/bin/desk-design.mjs status <saved folder> --version <v>`. Exit 3 means the
artifact has moved on: say so, and re-save as above on the user's confirmation (in a batch the
orchestrator asks and snapshots it).
