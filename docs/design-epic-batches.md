# Design: epics as autopilot batches

Status: **v2, implemented**, revised after two adversarial spec reviews (devil's advocate;
code-grounded verification) and four implementation reviews (devil's advocate, code review, a
cross-vendor Codex review, a baseline/after skill run) · 2026-10-03 · branch `feat/epic-batches`.
Both disposition tables are at the end.

## Why

desk-ticket works well on a bug or a one-sitting ticket, and desk-autopilot on a batch of them. A
**large feature** has no path: autopilot takes only the keys you name, triage parks a big ticket as
lane C, and the one pattern that has worked (PR Ninja KAN-389: one Story, one Subtask per milestone,
a per-batch base branch) is a hand convention in one repo's `claude.md`.

Measured 2026-10-03 across VPL, both KAN projects and FW:

- no ticket parked because its technical detail was thin; parks came from **scope decisions left
  open** in the ticket (VPL-125/126 "pending Ben's sign-off"), inputs kept outside the repo, and
  post-build caps;
- definition of done is almost never written (VPL 4/176, FW 0/73); Given/When/Then appears in
  4–27% of tickets; epics are mostly themed buckets with empty bodies;
- desk-review Phase 5 already checks every acceptance criterion against the diff;
- nothing in `desk/bin` reads a ticket's parent or its issue links, so a ticket whose UI calls an
  endpoint another ticket adds runs in parallel with it;
- a baseline run of the current skill on an epic key triages the epic as one ticket (lane C, park),
  never touches its children, runs link-dependent tickets in parallel, and cannot read a Claude
  Design link;
- headless workers have **no Artifact tool** (probed); a Claude Design artifact the user owns is
  readable interactively as files: `project/canvas.json` names every board with its width (e.g.
  390 / 768 / 1280) and each `project/*.dc.html` board carries the exact copy, colours, sizes and
  aria-labels inline; boards compose through a runtime (`dc-import`, `support.js`), so they do not
  render standalone;
- none of VPL, KAN, YI or FW has a size field; all four are team-managed; team-managed fields are
  project-scoped and the REST API cannot create them, so **a Size field is a manual UI step per
  project**.

## Goals

1. `/desk-autopilot <EPIC>` runs the epic's open children as one batch, in dependency order.
2. A Jira "is blocked by" link is honoured: a blocked ticket never starts before its blocker merges.
3. The batch keeps running across held tickets until the last one is released or needs a person.
4. Bea writes an epic and children a worker can build and desk-review can verify, and the set gets
   an adversarial readiness review before the user is asked to approve it.
5. Every ticket carries a size; nothing above M runs unattended.
6. A Claude Design link is usable as a design source.
7. **No regression**: a batch of ordinary keys behaves exactly as today, apart from honouring links
   and **parking L/XL** (deliberate: the user asked that no ticket above a size runs unattended, in
   any batch).

## Non-goals

No planning layer or new state files beyond the per-batch queue and triage records. No skill ever
transitions, closes or edits the epic. No recursion beyond epic → story → subtasks. No change to
desk-ticket's stages, to Figma lane D, or to Muriel's Figma procedure. No Jira field creation.

## A. `desk-jira`

**A1. `desk-jira children <KEY> [--json]`** (read). Proves auth, then JQL
`parent = <KEY> ORDER BY rank ASC` with fields `summary,status,issuetype,assignee,issuelinks`,
paging with `nextPageToken` in the POST body until `isLast` is true. A page that is not the last but
has no token, a token already seen, or more than 200 pages exits non-zero with the page count, never
a short list or a loop. Plain output:
`KEY<TAB>type<TAB>status<TAB>statusCategory<TAB>assignee<TAB>summary`, or `no children`. `--json`
prints the merged `issues` array. Added to `JIRA_READ` (triage and workers may read).

**A2. `desk-jira link <KEY> blocked-by|blocks <OTHER>`** (write). Owns the inverted direction
(`KEY blocked-by OTHER` → `{"type":{"name":"Blocks"},"inwardIssue":{"key":OTHER},"outwardIssue":{"key":KEY}}`).
Before posting it reads `KEY`'s links and refuses `KEY == OTHER`, prints `already linked` (exit 0)
for an identical link, and **refuses the reverse link** if it exists (it would make a 2-cycle).
After posting it reads `KEY`'s links back and exits 1 unless `is blocked by OTHER` (or `blocks
OTHER`) is there. Gate: `jira-edit`. **Never a worker's or triage's**: denied in both, and in the
dry-run list, whatever §3 says (only Bea's interactive flow links).

**A3. `parent=<KEY>`** in `fields_from_args`: a bare value matching `^[A-Z][A-Z0-9]*-[0-9]+$` becomes
`{"key":"<KEY>"}`; anything else for `parent` is refused.

## B. Expansion — `desk/bin/expand-parent.mjs <KEY> [--subtasks]`

Deterministic. stdout: the batch keys, one per line, in order. stderr: a report. Writes
`$DESK_STATE/expansion.json` (`{parent, containers: {<story>: {subtasks: [...], blocked_by: [...]}}}`)
for plan-batch.

1. Read `<KEY>` (`desk-jira get --json`). It expands only if its issue type is an **epic**
   (`issuetype.hierarchyLevel == 1`), or with `--subtasks` a story-level issue the user explicitly
   asked to run as its subtasks. Anything else exits 4 "not an epic: run it as an ordinary ticket"
   (so a bug with QA subtasks is never expanded).
2. `desk-jira children <KEY> --json`; any failure exits non-zero, never an empty batch.
3. Keep only children whose key `desk-env ticket-kind` calls `tracker` (others reported
   `not this repo's key`). Drop `statusCategory` `done` (reported `done`) and `indeterminate`
   (reported `in progress — name it explicitly to include it`: it may already have a PR), except
   that an `indeterminate` story is read for its subtasks first (step 4): an In Progress story with
   open subtasks is replaced by them, and only one with none open is dropped as in progress.
4. A kept child that is not a subtask (`issuetype.subtask` false) and has open subtasks is a
   **container**: it is replaced by its open (`new`) subtasks in rank order, and recorded in
   `expansion.json` with its own `Blocks` blockers. A container whose subtasks are all done or in
   progress stays as itself. One level only.
5. Nothing left: exit 3 "nothing open under <KEY>".

The parent is never a batch key, never triaged, never transitioned.

## C. Facts read once, deterministically — `desk/bin/ticket-facts.mjs <KEY>`

Run by `triage.sh` after the model writes the record, for tracker keys only (non-tracker: records
`links: "n/a"`). It reads `desk-jira get <KEY> --json` and merges into the triage record:

- `blockers`: `[{key, category}]` from `fields.issuelinks[]` entries with an `inwardIssue` whose
  `type.inward` matches `/blocked by/i`; `category` is that issue's `status.statusCategory.key`;
- `other_links`: the count of non-Blocks, non-Relates links (reported, never acted on);
- `size`: the value of the field whose display name (from `names`) is `Size`, else a first
  description line `Size: XS|S|M|L|XL`, else null;
- `epic`: `{key, summary, children: [{key, done}]}` when `fields.parent` is an epic (hierarchy
  level 1, or a type named for an epic), the children from `desk-jira children <EPIC> --json` that
  match this repo's ticket key pattern, else null. A children read that
  fails leaves `children` out and sets `epic_error`. desk-q's forecast reads it to date each epic;
- `facts_error`: set instead when the read fails or does not parse.

plan-batch stays offline and reads only triage records (and `expansion.json`).

## D. `plan-batch.mjs`

Order of evaluation per ticket of ours: lane park (C/D) → size park (L/XL: `size <L|XL> — split it
before batching`) → dependencies. A ticket parked by lane or size is **never held and never gets a
`--deps` entry**.

**Blockers of an admitted ticket** = its `blockers`, plus its container's `blocked_by` (from
`expansion.json`), with any blocker that is a container replaced by that container's subtasks that
are in the batch.

| Blocker | Effect on the successor |
|---|---|
| in the batch and admitted | **held**: parked `held by orchestrator: blocked by <B…> (Jira link) — starts once their PRs merge`, `held_by=<B|…>`; one `--deps` entry per successor, predecessors unioned |
| outside the batch, category `done` | ignored, noted |
| outside the batch and not done; or in the batch but parked by lane/size, or not ours | an **unknown**: "<S> is blocked by <B> (<category / why>): add <B> to the batch, or confirm <S> can start without it" |
| `facts_error` | an **unknown**: "dependencies could not be read (<reason>)" |
| on a cycle | every ticket on it parked `dependency cycle: A → B → A — fix the Jira links`, no `--deps` |

Unknowns plan-batch adds are printed under QUESTIONS and counted in `open_questions` exactly like
triage's. A held ticket can also carry unknowns. `other_links` > 0 prints
`! <n> link(s) of another type ignored — only Blocks is honoured`. A missing size prints `! no size`.

Seeding (`AUTOPILOT_WRITE_QUEUE`) writes tickets in **topological order** (ties keep argument
order), so blockers come first in spawn order. Output adds:

```
DEPENDENCIES — from Jira links
  FW-62 held: blocked by FW-61
--deps "FW-62:FW-61 FW-63:FW-61,FW-62"
```

## E. Keeping the batch alive, and releasing

- **`pass.mjs` idle**: a ticket parked with a `held by orchestrator` reason counts as **waiting,
  not idle**, while any of its `held_by` predecessors is `running`, `triaged`, `queued` or `done`
  (PR open). The pass prints `WAITING ON MERGE: <S> (<B…>)`. Only when every remaining ticket is
  done, failed, or parked for another reason (or held behind a predecessor that is itself failed or
  parked for another reason) is the batch IDLE. `queue.mjs render` shows held tickets as `HELD`
  and does not count them as waiting on you.
- **`answer.mjs`**: on a ticket parked `held by orchestrator`, it records the answer, sets
  `open_questions=0`, keeps the hold, and prints `held — releases when <B…> merge`. Other parked
  tickets behave as today.
- **Release**: the merge driver's `release_chain` does it as today. Where the driver is not running
  (no merge grants), the orchestrator releases a held ticket once GitHub shows every predecessor's
  PR merged: `queue.mjs set <S> state=triaged park=null held_by=null` then `queue.mjs front <S>`.
  That is the one sanctioned manual release.
- **Adding a blocker mid-batch** (the answer was "add B"): triage B, `queue.mjs add B …` alone
  (never re-run plan-batch with `AUTOPILOT_WRITE_QUEUE`: it resets every ticket's state), hold the
  successor. A running merge driver takes B in from the queue on its next loop, and the hold's
  `held_by` releases the successor, so it needs no restart.

## F. desk-autopilot SKILL.md

- **Argument table**: an epic key runs `expand-parent.mjs`, then `queue.mjs set-batch epic=<KEY>`;
  the expanded list and every drop (with its reason) go in the Stage 2 report. A story is run as
  its subtasks only when the user asks (`--subtasks`). Naming an epic and one of its children is
  de-duplicated.
- **Shipping half an epic**: Stage 3 always asks, for an epic batch with no batch base set, whether
  the children are safe to ship to the default branch one at a time; recommend `set-batch base=`
  unless each child is invisible or flagged until the last lands.
- **Order the batch**: plan-batch now orders by Jira links and prints `--deps`; join it with the
  collision chains (one entry per successor, predecessors unioned) for the merge driver. The
  "plan-batch does not decide sequence" wording changes accordingly.
- **Release and idle**: section E's rules, including the one sanctioned manual release.
- **Epic close-out**, when idle with no held ticket left:
  - if any child is parked or failed: list them; nothing is verified;
  - else, if the epic has acceptance criteria or a definition of done: run desk-jira's *Already
    fixed* per-criterion check on the epic against `origin/<base>` and report MET / NOT MET; each
    NOT MET is proposed as a new child under the epic through desk-jira's gate; else say "epic has
    no criteria — not verified";
  - with a batch base: the promotion PR (base → default) is the user's; title it with the epic key
    so `/desk-review` Phase 5 checks the epic's criteria end to end;
  - never transition the epic.
- **Lane C on size**: offer Bea's epic mode to split it, then batch the epic.
- **Claude Design**: Stage 1, before triage, for a ticket that links a Claude Design artifact the
  user owns: list its files and save `project/canvas.json`, `project/*.dc.html` and the
  `support.js`, stylesheets and fonts they load to `$DESK_STATE/designs/<KEY>/` (`Artifact read`
  with `paths` and `out_dir`), then `desk-design.mjs write` records the URL, version and every
  batch ticket using it. The worker's `desk-design.mjs save` commits it to
  `<Design canvases directory>/<EPIC or KEY>/` on its branch (DS-51). An artifact the user
  does not own, or one that will not read, is a Stage 3 question; a worker never builds from a
  summary.
- Red flags / rationalizations: batching an epic without stating the list; touching the epic's
  status; releasing a held ticket before its predecessors' PRs merged; re-running plan-batch with
  `AUTOPILOT_WRITE_QUEUE` mid-batch.
- `queue.mjs render` shows `epic <KEY>`.

## G. Context, design source and size in the other files

- `triage.sh` (tracker): "if it has a parent, read the parent's description for context only".
  desk-ticket Stage 0: linked issues "and, for context only, its parent".
- **Claude Design** (`desk-ticket-routing.md`, triage's two design paragraphs, Muriel): a design
  source is a Figma node **or a Claude Design artifact**. Read it from its saved copy under the
  repo's Design canvases directory, which the Artifact tool fills when interactive and the worker
  copies from `$DESK_STATE/designs/<KEY>/` in a batch. `canvas.json` gives the boards and
  their widths; each board's HTML gives the exact copy, colours and sizes. Verification for a Claude
  Design source: capture the build at every board width; check every visible string, colour and
  size the board states (or its copy key); a pixel diff needs the canvas runtime, so it is
  `UNVERIFIABLE` in a batch, never `PASS`. Figma's procedure is unchanged.
- **Size scale** (desk-jira SKILL.md): XS a few lines in one place · S one area, one PR, under half
  a day · M one PR in one sitting, several areas or a new piece in an existing pattern · L more than
  one sitting or more than one PR (split before batching) · XL several independently mergeable
  parts (an epic). Where the project has a `Size` field (`desk-jira fields size`), set it on every
  create; otherwise the description's first line is `Size: <X>`. Adding the field is a manual,
  per-project UI step (team-managed: Project settings → Issue types → Dropdown `Size`, XS–XL, on each
  type); desk-setup tells the user once if it is missing.

## H. Bea's epic mode and the readiness review

- `agents/bea-business-analyst.md`: entered when the user asks for an epic or the split rule fires.
  Epic body: Outcome; Definition of done as numbered Given/When/Then for the feature end to end;
  Out of scope; Decisions (dated, owner); children in build order. Each child: Context (the epic
  key); `AC1…` Given/When/Then, each independently checkable; Out of scope; Decisions (none open);
  Build on (existing modules or patterns, no file trees); Design (link or "no UI"); Size ≤ M.
  Dependencies are `desk-jira link`s, never prose. Filing after approval: epic → children
  (`parent=`, size) → links → read back with `desk-jira children` and each child's links.
- **Readiness checklist** in `skills/desk-jira/references/epic-readiness.md`, run by
  `ada-devils-advocate` in Judge mode **by the main session** on the draft before it is shown for
  approval (a subagent Bea cannot spawn Ada, so Bea hands back the draft marked `READINESS REVIEW
  PENDING`):
  1. every epic DoD criterion is covered by at least one child's AC;
  2. every AC is testable as written (no "works well", no mechanism);
  3. no open decisions anywhere;
  4. the links form a DAG and match the stated order;
  5. where one child calls or uses something another adds, a Blocks link exists;
  6. no two children build the same new thing;
  7. every child is ≤ M and mergeable once its blockers have merged, leaving the base green;
  8. each child is safe to ship before its successors, or the epic needs a batch base;
  9. every UI child has a design link or says "no UI";
  10. out-of-scope lines do not contradict any AC.
- desk-jira SKILL.md: an "Epics" section (the commands, the size scale, the readiness review).

## Tests (written first, run red, then green) — `tests/test_epic.sh`, added to `tests/run.sh`

- desk-jira against `stub_jira.py` (extended with paged search, issue GET with links, issueLink
  POST, issue POST capture): `children` pages twice; bad token is non-zero and never `no children`;
  `link` sends the right direction for both verbs, refuses self and reverse, skips identical, fails
  on a wrong read-back; `create … parent=FW-1` sends `{"parent":{"key":"FW-1"}}`; `parent=bad` refused.
- `expand-parent.mjs` with a fake `desk-jira` first on PATH: non-epic exits 4; done and in-progress
  dropped; foreign keys dropped; container → open subtasks with `expansion.json`; all-done container
  kept; failure non-zero; nothing open exit 3; rank order.
- `ticket-facts.mjs`: blockers parsed from the inward side only; non-Blocks counted; size from the
  field, then the body line; read failure → `facts_error`.
- `plan-batch.mjs` (hermetic: `DESK_CONFIG`, `DESK_JIRA_NAME`, `DESK_AUTOPILOT_STATE`, `DESK_QUEUE`,
  `DESK_HOME`): held park text matches `release_chain`'s pattern; `--deps` unioned; outside open
  blocker → unknown and `open_questions`; done blocker ignored; `facts_error` → unknown; lane C
  successor and size L never held; blocker parked by lane → unknown on successor; cycle parked;
  container inheritance both ways; topological seed order; a batch with no links seeds exactly as
  before (regression).
- `pass.mjs` idle logic, extracted to a pure function in `queue.mjs` (`batchIdle(queue)`) and
  unit-tested: held behind a running/done predecessor → not idle; held behind a failed one → idle.
- `answer.mjs` on a held ticket: hold kept, `open_questions=0`.
- `worker-settings.mjs`: `link` denied in triage, worker and dry-run settings even with `jira-edit
  yes`; `children` allowed.

Skill text is checked by re-running the baseline scenario with the new skill: expected expansion,
link-held FW-63, subtasks of FW-65 run, FW-62's design snapshotted, FW-64 parked on size, close-out.

## Files

`bin/desk-jira` · `desk/bin/expand-parent.mjs` (new) · `desk/bin/ticket-facts.mjs` (new) ·
`desk/bin/plan-batch.mjs` · `desk/bin/pass.mjs` · `desk/bin/queue.mjs` · `desk/bin/answer.mjs` ·
`desk/bin/triage.sh` · `desk/bin/worker-settings.mjs` · `desk-config.md` (jira-edit note) ·
`skills/desk-autopilot/SKILL.md` · `skills/desk-autopilot/references/autopilot-worker-contract.md`
(jira-edit note) · `skills/desk-ticket/SKILL.md` · `skills/desk-ticket/references/desk-ticket-routing.md` ·
`skills/desk-jira/SKILL.md` · `skills/desk-jira/references/jira-rest-recipes.md` ·
`skills/desk-jira/references/epic-readiness.md` (new) · `skills/desk-setup/SKILL.md` (size note) ·
`skills/desk-setup/references/permission-rows.md` · `agents/bea-business-analyst.md` ·
`agents/muriel-design-engineer.md` · `tests/stub_jira.py` · `tests/test_epic.sh` (new) · `tests/run.sh` ·
`README.md`.

## Review disposition

| Finding | Disposition |
|---|---|
| IDLE fires while held tickets wait; loop stops after one ticket (blocker) | fixed: §E idle rule + test |
| Release could send a lane C/D or size-parked ticket to a worker (blocker) | fixed: lane/size parks win, never held, no `--deps` |
| No release without merge grants | fixed: one sanctioned manual release, §E |
| Parked / not-ours in-batch blocker strands successor | fixed: becomes an unknown |
| Container expansion drops links | fixed: `expansion.json` inheritance both ways |
| Auto-expanding any key with children regresses bugs with QA subtasks | fixed: epics only; stories with `--subtasks` |
| Half-built epic ships | fixed: Stage 3 question + readiness item 8 |
| Design snapshot infeasible | narrowed: owned artifacts only, files not render; pixel diff UNVERIFIABLE; others a question |
| plan-batch network dependence | fixed: facts read in triage, plan-batch offline |
| In-progress child gets a second PR | fixed: dropped unless named |
| Size duplicates lane C (cut) | **kept, simplified**: the user asked for every ticket to carry a size with a cap; no config row, size read by field name or body line, L/XL parked |
| Lane D / Muriel verification changes regress Figma (cut) | fixed: Figma unchanged; new checks apply to Claude Design only |
| Close-out over-built | trimmed to the existing per-criterion check, partial case defined |
| Ada checklist gaps, Bea cannot spawn Ada | fixed: items 5, 7, 8; main session runs it |
| Reverse-link 2-cycle | fixed: `link` refuses |
| "Add B" mid-batch, re-seed unsafe | fixed: documented procedure |
| `parent=` sends a string | fixed: A3 |
| `link` for workers contradiction | fixed: never a worker's |
| ORDER re-seed cannot reorder | fixed: plan-batch seeds in topological order |
| Unknowns added by plan-batch not counted | fixed |
| Answer on a held ticket | fixed: answer.mjs keeps the hold, clears the count |
| Waivers not stored across re-runs | accepted: plan-batch runs once per batch; re-running it mid-batch is a red flag |
| `release_chain` clears `collides_with` | accepted: existing behaviour, unchanged |

## Implementation review disposition

| Finding (reviewer) | Disposition |
|---|---|
| `children` passes a whole page as one argv string: breaks on Linux/WSL past 128 KB (code review, devil's advocate) | fixed: pages merged on stdin; test with a page over 1 MB |
| Held ticket waits for ever, silently, when a blocker finishes with no PR, its PR closes unmerged, or one of two blockers fails (devil's advocate, blocker) | fixed: a hold waits only while every blocker can still merge; otherwise **STUCK**, and all-merged is **RELEASE DUE**; both under WAITING ON YOU with a notification; `pass.mjs` reads each finished blocker's PR state |
| Merge driver reads only `--deps`; a successor named twice releases after the first (Codex, devil's advocate) | fixed: `release_chain` unions every `--deps` entry and the queue's `held_by`, finds any queue ticket's merged PR; `MERGE_DRIVER_RELEASE_ONLY` hook and tests with a fake `gh` |
| "Add the blocker" procedure strands both tickets (devil's advocate) | fixed: `queue.mjs admit` and `queue.mjs hold`; driver restarted with the blocker in `--tickets` |
| Collision holds have no `held_by`, so IDLE prints while they wait (devil's advocate) | fixed: collision chains use `queue.mjs hold`; a hold with no recorded blocker is STUCK, never silently idle |
| Release clears `collides_with` (code review) | fixed: release keeps it |
| Bug/Task with QA subtasks expanded one level down; `--subtasks` accepts a bug (devil's advocate, Codex) | fixed: only a Story is a container; a story whose subtasks are all under way is dropped with the reason; every dropped subtask is reported |
| Stale `expansion.json` reshapes later batches (all three) | fixed: cleared at the start of every expansion; plan-batch uses it only for the queue's own epic |
| Cycle check misses a ticket reaching the cycle through a finished node (code review) | fixed: Tarjan strongly connected components; 4-node test |
| `parent=@file` bypasses the key check (code review, Codex) | fixed |
| Batch base asked at Stage 3, after triage used it (devil's advocate, baseline run) | fixed: asked at Stage 0, straight after expansion |
| Size parking changes ordinary batches (devil's advocate) | **kept, stated in goal 7**: the user's requirement |
| A record with no link facts raises a question (devil's advocate) | **kept**: fail closed; re-run triage or confirm |
| A link that landed backwards cannot be retried (devil's advocate) | fixed: the read-back failure shows what Jira holds and how to delete it |
| Size scale says XL "is an epic" without parking it | fixed |
| Snapshot path missing `project/` | fixed in every file |
| Container story criteria never checked | fixed: close-out checks each expanded story's criteria too |
| Link-direction tests confirm the stub's own model (code review) | accepted, with a live check: against real Jira, FW-22's "blocks FW-25" reads back from FW-25 as "blocked by FW-22" |

## Verification pass (fresh adversarial review of the fixes)

Every row above verified in code except three partials, now closed: the STUCK / RELEASE DUE output
(a live merge driver releases silently; without one, RELEASE DUE goes to you with the exact commands),
`queue.mjs admit` (now records collisions both ways), and the release keeping `collides_with`.
New findings, all fixed with tests: the base-drift line `pass.mjs` lost in an edit (restored, with a
guard); a diamond of holds read as STUCK (the cycle guard now tracks the current path only);
`hold` on an untriaged ticket (refused); one merged-PR listing per predecessor per loop (one per
release pass). Accepted: `queue.mjs render` judges holds without PR states, so a blocker whose PR was
closed shows HELD there and STUCK in the pass report, which is the one that notifies.
