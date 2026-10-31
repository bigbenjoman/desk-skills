# desk-autopilot: a design in Claude Design

Part of desk-autopilot, read at Stage 1 when `desk-design.mjs check` finds a ticket that links a
Claude Design artifact. It binds exactly as the core `SKILL.md` does. Where it says "above" or
"below" of something this file does not hold, or cites a section in *italics* it does not hold, that
is in the core or in the file the core's reference table names.

### A design in Claude Design

Workers have no Artifact tool, so a ticket whose design is a Claude Design artifact gets a
snapshot **at Stage 1, before its triage**, taken by you. Find them with
`node ~/.claude/desk/bin/desk-design.mjs check <KEY>` per ticket (a `blocking` line: no copy is saved
in the repo yet). List the artifact's files (`Artifact action:list scope:files`), then read
`project/canvas.json`, every `project/*.dc.html`, and the `support.js`, stylesheets and fonts they
load, with `paths` and `out_dir: <state>/designs/<TICKET>/` (they land under
`<state>/designs/<TICKET>/project/`; triage and workers can read `<state>`). Read too what the
published files leave out: each `/_blob/<id>` asset a board names, in its attributes or script, one
`read` with `path: "/_blob/<id>"` apiece (a `paths` read refuses asset ids), and
`artifact-type/dc-runtime.js` when a board loads a `support.js` the artifact does not publish
(desk-ticket `design-canvas.md` has why). The saves need no
approval: `/desk-setup` grants this session the state folder (`orchestrator-tools`), so a prompt per
file means the repo was set up before that, and re-running `/desk-setup` fixes it. Then record where it
came from, naming **every** ticket in the batch that uses this canvas, so the workers who save it
write identical files:

```bash
node ~/.claude/desk/bin/desk-design.mjs write <state>/designs/<TICKET> --url <artifact URL> \
  --version <its version> --epic <EPIC, or the first ticket> --key <KEY> [--boards '<a>,<b>'] --key <KEY2> …
```

Each worker runs `desk-design.mjs save` on its snapshot (desk-ticket `design-canvas.md`, "A Claude Design canvas is saved
into the repo"), which commits it under `<§2 Design canvases directory>/<EPIC or KEY>/` on the
ticket's branch, once per artifact. `canvas.json` names each board and its width; each board holds
the exact copy, colours and sizes. For a ticket whose canvas is already saved (`check` prints `ok`
or an `advisory`), read the artifact's current version (`Artifact action:list`) and run
`desk-design.mjs status <URL> --version <v>`. Exit 3 means it has moved on: re-saving is a Stage 3
question, and on a yes you snapshot it as above.
An artifact the user does not own returns a summary, not the files: that, or one that will not
read, is asked at Stage 1, before any ticket is spawned, never left for Stage 3: name the artifact
and ask the user to share it with this subscription or give its files. A worker never builds from a
summary or a guess.

**A single-page artifact** (no `project/canvas.json`, no boards) is snapshotted the same way: its
page (`project/index.html` or whatever HTML it publishes) and every file and `/_blob/<id>` asset the
page loads. `desk-design.mjs save` copies a page with no canvas.json, and `render` shoots it at every
breakpoint.

**Every way into a batch takes the snapshot first.** `/desk-admit` snapshots in its own session
before it admits (its step 0), from the same list as above. Where no session can (standing intake, a
feature batch started headless, a ticket plan-batch seeds with no snapshot), the ticket is parked on
`design not snapshotted: <URL>` rather than admitted runnable, so it shows as one need naming the
artifact, and plan-batch lists it under `PARKED ON DESIGN`. A snapshot in the repo's own state
folder is found from a feature batch's too.
