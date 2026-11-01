# desk-jira: writing a ticket, and its fields

Read before creating a ticket (one, or a set with `create-batch`), or editing a ticket's fields:
priority, size, labels, assignee, sprint or any §4 Other fields value (`desk-env list
jira-other-fields`). The step table in `../SKILL.md` names this file for those steps. The config, the
gate, *Epics* and *Transitions* are in `../SKILL.md`, already loaded; how a body is written and sent
is in `cli-and-markup.md`, beside this file. The other rows this file names, each a `desk-env` read:
§4 Jira project `desk-env list jira-project`, Priority `desk-env list jira-priority`, Required fields
`desk-env list jira-required-fields`, Size field `desk-env get jira-size-field`, Priorities only you
set `desk-env list jira-priority-user-only` and Labels `desk-env list labels`.

## House ticket format

Keep it simple and readable: short sections, real file paths, no padding. **Every ticket follows
`references/ticket-template.md`**: one layout each for Story and Task, Bug, Epic and Subtask, with
its rules for criteria, dependencies, design links and decisions. That holds for a ticket written by
hand, by Bea, or by a machine path (a spin-off, a follow-up, an L split, an epic close-out child).
The template says how §5 Ticket format overrides it. Read two or three recent tickets of the same type in §4 Jira project before writing a new
one, and match their summary style (an `[Area]` prefix, a verb-first phrase, whatever they use).

**`desk-jira lint` checks a ticket against the template**: `desk-jira lint <KEY>` for one in Jira,
or `desk-jira lint body.md [<type>] [field=value ...]` for a draft, read as `create` would send it.
It prints one line per finding and exits 1 on any blocking one:

- **Blocking**, what makes triage ask or a worker park: no acceptance criteria; an open decision
  (TBD, TODO, decide, proposal for, needs a decision, or a question mark in Outcome, the criteria or
  Out of scope); no design link and no `No UI.` line; Size unset (not asked of a Subtask); a
  criterion that needs a Jira write, a live production run or an operator step; and `desk-design`'s
  finding for a Claude Design link with no saved copy (advisory once autopilot has snapshotted the
  canvas, since the worker saves it).
- **Advisory**: no Out of scope or Verification section; a ticket key or a sibling's title named
  with no Blocks link; a status or priority line in the body; markdown that will not render (a `##`
  heading, `**bold**` or backticks in wiki markup, an unescaped `--` inside `{{ }}`).

**`create` lints first** and refuses a blocking finding, printing them. Fix the body; `--no-lint`
files it as it is, only when the user has seen the findings and said so. Autopilot lints every
ticket at triage and shows the blocking findings in the batch plan.

**Never invent the substance.** If the real name, price, business rule or product data isn't in the
ticket, a sheet or the database, ask. Invented product data costs a full revert.

**Search the backlog before writing a ticket for a page or feature**, including old unlabelled
tickets — those are the ones a new ticket ends up duplicating.

## Fields

Fill **every field §4 Priority and §4 Other fields ask for on a create, in the one `create` call.**
Nothing flags a blank one later, so a ticket created without them stays unfinished until someone
sweeps for blanks. `desk-jira meta <type>` lists the fields Jira itself requires.

| Field | Where it comes from |
|---|---|
| Priority | §4 Priority: the built-in field, or a custom field id with its allowed values. If it says the built-in field is not used for ranking (it stays at one fixed value), leave it at that value |
| Other fields | §4 Other fields: each id, its values and when it applies (e.g. a size, an impact, a repository, a design-link field). `none` means there are none |
| Sprint | resolve with `desk-jira fields sprint`. **A Subtask rejects a sprint write with a bare 400**: it inherits the parent's sprint, so put the parent in instead and skip subtasks in bulk loops |

Resolve anything else with `desk-jira fields <filter>` rather than guessing an id.

**Status, priority and size live in their fields, never in the body.** A `Status:`, `Priority:`,
`P0`–`P4` or `Size:` line in a description goes stale the day the field moves, and then contradicts
it. `create` and `edit` refuse a description with one. The one exception is the Size fallback
under *Epics*: a first line `Size: <X>`, only for a project with no Size field (no §4 Size field in
config). Mentioning a status mid-sentence ("the body said Status: Not Started") is fine.

**The CLI enforces §4's field rules** before `create` or `edit` sends anything, and names the field
it refuses:

- §4 Required fields: a `create` missing a field its type needs is refused, and so is an `edit`
  that clears one (`null`, empty, or an empty option).
- §4 Size field: an XL is refused on every type but Epic. Split the ticket into ones of L or smaller.
- §4 Priorities only you set: these values need the user. Ask, then pass
  `--approved "<their decision, in a sentence>"`; the CLI writes the field and posts that decision
  to the ticket as a comment. A headless autopilot worker is refused even with the flag: it sets a
  lower value and parks with the case for the higher one.

Pass these options by name (`customfield_10208=L`, or `{"value":"L"}`). An option id is refused,
because the rules cannot read it.

**Priority: assign it yourself, don't ask.** Judge it from the ticket against the §4 Priority
values (and the meaning §4 gives each, where it does) and put the value in the gate block. Keep a
high bar for the top values: "production broken or losing data now" and "cannot ship without it"
are rare. Don't inflate it. Calibrate against the ticket it came from and a couple of neighbours
(`desk-jira get <KEY>`). A follow-up rarely outranks its parent. If §4 Priority names values with
no way to tell them apart, ask once and suggest `/desk-setup` record the meanings. The exception is
a value in §4 Priorities only you set: that one is the user's call (above).

**Assignee.** The user, by default. With §3 `jira-assign-self` `yes`, `create` assigns the new
ticket to the user when no `assignee=` is given; otherwise pass `assignee=me` (which waits on that
row). `create` prints the assignee read back from Jira; `(empty - the assignment did not stick)`
means set it with `desk-jira edit`. Anyone else is routing (gate item 3): `create` refuses an
assignee other than the user unless `--route` is given.

**Labels.** Use the vocabulary in §4 Labels (`any` means the project's existing labels: list them
before choosing). Pick the ones that genuinely apply. There is no unconditional set: a label is
there so someone can filter on it later, and one that goes on everything filters nothing.

- A label that records **where a finding came from** (an audit pass, a design QA pass) goes only on
  tickets that came from there. A bug found while building something else, an infrastructure task
  or a security finding is not an audit finding.
- A **severity** label family, where §4 Labels has one, mirrors the priority you chose.
- Match the exact spelling and capitalisation §4 Labels gives; a near-miss is a new label.
- If nothing fits, **say you're introducing a new label** rather than slipping it in. **Never** a
  label naming one finding (`audit-finding-123`): that is an id, not a label.

**Reporter.** A bug filed by the §4 People QA filers is usually a real reproduction. Treat the
described behaviour as observed, not alleged. QA filers `none` means every report is weighed on its
own evidence.
