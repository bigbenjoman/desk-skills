---
name: desk-jira
description: >-
  Use when creating, editing, commenting on, assigning, prioritising or transitioning a Jira ticket
  in this repo's project, or when reconciling several tickets against GitHub — "write a ticket for
  this", "add a Jira comment", "move it to review", "close it as a duplicate", "go through my
  in-review tickets and see which have merged".
---

# desk-jira

## Overview

**Resolve this repo's config first.**

```bash
desk-env where        # SLUG=, GH_REPO=, CONFIG=, CREDS=, EXISTS=yes|no
```

Read the `CONFIG` file. `EXISTS=no` means stop: say which slug was looked up and offer `/desk-setup`.
A `TODO` in any row this skill needs is not a gap to guess: stop, ask, and offer `/desk-setup`.

- **§4 Tracker `none`: there is no tracker for this repo.** Say so and stop. Nothing below applies;
  a ticket in this repo is a plain description or a GitHub issue, which `desk-ticket` handles.
- §4 Tracker has the site (`Jira site`), `Jira cloudId`, `Jira project` (key, name and the issue
  types in use), `Ticket key pattern`, `Workflow` and its named states, `Priority`, `Other fields`
  and `Labels`. §4 People has who owns product, design and QA.
- §5 has `Ticket format` and `Ticket comment`. §3 decides whether each write posts, waits or does
  not happen at all. §1 has the user's GitHub handle and Jira account.

Examples below use `ABC-123` for a key and `<TICKET>` in paths. Substitute this repo's §4 Ticket key
pattern; never assume a project key.

**Core principle: the exact text of every Jira write appears in the conversation.** Tickets and
comments are read by the whole team, the product owner (§4 People) included. Config §3 decides
whether that text is a request (`awaiting approval`) or a record (`posted`). It never decides
whether the text is shown.

## Transport — `desk-jira`, not the Atlassian MCP

`desk-jira` ships with these skills (`bin/desk-jira`, installed to `~/.local/bin/`). It talks straight
to the Jira REST API with the user's own API token, and takes the site, project, email and token from
this repo's config folder. Check it before relying on it:

```bash
desk-jira where         # repo slug, site, project, email file, token file, priority field it resolved
desk-jira whoami        # prints your display name and accountId, or says what is missing
```

| Result | What to do |
|---|---|
| Prints a name | Use it for every Jira read and write, including inside fanned-out subagents. `desk-jira --help` lists the commands. |
| "no email" / "no token" / "no Jira site" | Installed but not configured for this repo. Say so, show the path `desk-jira where` names (the repo's `jira-email` and `atlassian-token` beside its config), and offer `/desk-setup`. Use the Atlassian MCP with §4 Jira cloudId meanwhile. |
| `command not found` | Not installed. Use the Atlassian MCP with §4 Jira cloudId and don't keep retrying. |

§4 `desk-jira set up?` records whether setup got this working; `no` there means go straight to the
MCP fallback.

The claude.ai Atlassian connector is a three-hop proxy (seconds per call against ~0.3s) and **it
cannot upload attachments at all**. If `desk-jira` starts failing auth mid-session, the token has
expired: say so rather than silently switching transport. **Transport is not permission.** The
gate below applies identically either way.

What the CLI does for you, and the traps it still has:

- **Field values.** `field=@path` reads a file. JSON passes through untouched. A bare value is
  wrapped to the shape the field needs: `customfield_12345=P1` becomes `{"value":"P1"}`,
  `assignee=me` becomes your accountId. If `desk-jira --help` doesn't mention `@file`, your copy
  predates 2.0: re-run `install.sh`.
- **Every `edit` prints the fields read back from Jira.** Check that output. A line saying
  `the write did not stick` is a failed write, even though the PUT returned 2xx.
- **Bodies are positional.** `comment <KEY> <body-file|text>`, and `create`'s description the same
  way. There is no `--file` flag. The CLI refuses a body that looks like a flag or a missing
  `.md`/`.txt`. Write approved text to a file and pass the path. The literal-string form of
  `create` can return a bare 400, and a file avoids shell-quoting anyway. **The file must be inside
  the repo, `$DESK_STATE` or a temp directory**: the CLI refuses any other path (and `field=@path`
  and `attach` the same way), so it can never post another repo's credentials by mistake.
- **Reads prove the login first.** `search`, `get` and `comments` check the credentials before
  querying and exit non-zero on a bad or expired token, because Jira answers an anonymous search
  with 200 and no issues. An empty `search` with exit 0 is a real "no matches"; a non-zero exit is
  a search that did not run, never "nothing found".
- **Credentials never reach an argv.** The CLI hands them to curl on stdin (`curl -K -`). A call
  no subcommand covers still goes through it: `desk-jira api <path>` reads and `desk-jira rest
  <PUT|POST|DELETE> <path> [<body file>]` writes (`references/jira-rest-recipes.md`), never a shell
  function or `curl` of your own.
- **`search` shows the §4 Priority custom field** in its third column when §4 Priority names one
  (`desk-jira where` prints which), otherwise the built-in priority. For anything you will act on,
  confirm with `desk-jira get <KEY>`, which prints every set custom field by name (`--json` for raw).
- **Write bodies in markdown, in a `.md` file.** `create`'s description, `comment` and
  `edit description=@body.md` convert a `.md` file to Jira wiki markup before sending, because API v2
  reads wiki markup: a markdown `## Summary` sent raw renders as a nested numbered list, not a
  heading. `desk-jira md2wiki body.md` prints what would be sent, with no credentials.
  - **A body already in wiki markup goes unchanged.** A `.wiki` or `.txt` file and literal text are
    never converted, and nor is a `.md` file holding wiki markup (an `h2.` heading, a `{code}` or
    `{noformat}` block, `bq.`, a `||` header row, a `[text|url]` link). A `.md` file converts only
    when it has something only markdown writes: a fence, a backtick, `**bold**`, `[text](url)`, a
    `1.` item, a `|---|` row or a `#` heading on its own after a blank line. `- ` items, which wiki
    markup writes too, convert only when nothing wiki-like is beside them (`{{monospace}}`,
    `*bold*`, a run of `#` list lines).
  - **Once converting, a line starting `#` and a space is a heading**, never a wiki list item. So
    text copied from `get` or `comments`, which print wiki markup, goes back as a `.wiki` file.
  - `desk-jira rest` sends the file as it is: run `desk-jira md2wiki body.md > body.wiki` first.

  When you write wiki markup yourself (a `.wiki` file, or a `desk-jira rest` recipe), the forms are, wiki first:
  - lists `* item` and `# item` (nest with `**`, `##`), not `- item` / `1. item`;
  - bold `*bold*`, not `**bold**`;
  - inline code, flags and paths `{{\-\-add\-dir}}`, not backticks, **with every hyphen inside the
    braces escaped `\-`**: monospace does not stop the renderer, so an unescaped `{{--add-dir}}`
    renders as one hyphen and a strikethrough running to the next flag (measured). A code
    block `{code}…{code}`, not fences;
  - links `[text|https://…]`, not `[text](https://…)`;
  - tables `||head||head||` then `|cell|cell|`, with no `---` separator row.

  Some plain text is markup too: `-x-` is strikethrough and a stray `{word}` is read as a macro,
  so escape them with `\`. A `--flag` mid-sentence is left alone (measured), but `{{\-\-flag}}` is
  still the clearer way to write one. The converter escapes all of these in a `.md` body for you.

  Check a new body once in the rendered HTML with two counts. `grep -c '<h2'` should match the
  `h2.` headings sent (the `##` headings of a `.md` body). `grep -c '<del'` must print `0`: any
  `<del` is a failure (a hyphen read as strikethrough), so escape it and edit the body again:
  `desk-jira api "api/2/issue/<KEY>?fields=description&expand=renderedFields" | jq -r .renderedFields.description | grep -c '<del'`,
  or for a comment,
  `desk-jira api "api/2/issue/<KEY>/comment/<ID>?expand=renderedBody" | jq -r .renderedBody | grep -c '<del'`,
  and the same with `'<h2'`.
- **Screenshots go on the ticket**, not only the PR: `desk-jira attach ABC-123 before.png after.png`.

For anything the CLI has no command for, read **`references/jira-rest-recipes.md`**. That covers
deleting a mistaken comment, editing a description that holds inline images, and subtasks with
sprints. Issue links of every type have commands: `desk-jira link` and `desk-jira unlink` (see
*Epics*).

## Gate — which writes post, which wait

Every write prints this block. Not a summary of the text: the text.

```
JIRA <TICKET | COMMENT | EDIT | TRANSITION> — <posted | awaiting approval>
target : <ABC-123, or "new ticket in <§4 Jira project key>">
fields : type · assignee · labels · priority (§4 Priority) · every §4 Other fields value set
---
<the exact body, verbatim>
```

Find the config §3 row for the write:

| Write | §3 key |
|---|---|
| Comment, or edit your own comment | `jira-comment` |
| New ticket | `jira-create` |
| Description or field edit (§4 Priority, labels, §4 Other fields) | `jira-edit` |
| Issue link, or removing one (`desk-jira link`, `desk-jira unlink`) | `jira-edit` |
| Status change between working states (§4 In-progress state, Review state, and any other non-closing state in §4 Workflow) | `jira-transition` |
| §4 Done state once the user's own last PR on the key has merged | `jira-close-own-merged` |
| Any other close: duplicate, not-a-bug, out of scope, already fixed | `jira-close` |
| Assign a ticket to the user | `jira-assign-self` |
| Assign or route a ticket to someone else | `jira-route` |
| Anything on a ticket not assigned to the user | `jira-others` |

| Row says | Do |
|---|---|
| `yes` | Write it, print the block marked `posted` at the moment it goes, then read it back |
| `ask` | Print the block marked `awaiting approval` and wait |
| `no` or `TODO` | Don't write. Offer the block as a draft the user can paste themselves |

**These are decisions rather than records.** Their rows are recommended `ask` or `no`; read them
rather than assuming a `yes` covers them:

1. **Closing a ticket without a merged PR of the user's** (`jira-close`): duplicate, not-a-bug, out
   of scope, or "already fixed". The §4 Done state after the user's own last PR merges is
   `jira-close-own-merged`, a record. See Transitions.
2. **Asserting a product or catalog fact** waits whatever §3 says (`product-calls` is `stop`): a
   name, price, business rule or piece of product data not already in the ticket, a sheet or the
   database.
3. **Routing work to another person** (`jira-route`). Assigning or naming anyone other than the user
   as owner. A question for product goes in a comment addressed to §4 People Product owner listing
   the exact questions, and even that waits. Product owner `you` means the user decides: ask them
   in the conversation instead of commenting.
4. **Anything on a ticket not assigned to the user** (`jira-others`), including unassigned ones.
   Every write comes from the user's account, so touching someone else's ticket reads as them
   narrating or closing a colleague's work. At `no`, report it instead; at `ask`, ask each time.

An unnecessary pause costs one message. A wrongly-posted product claim, or a ticket landed on a
colleague, costs a public retraction. When unsure whether a write sits inside a `yes`, wait.

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

## Epics

A large feature is an epic whose children are each one sitting, so `desk-autopilot <EPIC>` can run
them as a batch. The commands:

```bash
desk-jira children ABC-900                         # its children (or a story's subtasks), rank order
desk-jira create Story "<summary>" body.md parent=ABC-900 <size field>=M
desk-jira link ABC-903 blocked-by ABC-901          # ABC-903 cannot start until ABC-901 merges
desk-jira link ABC-904 duplicates ABC-850          # any type the site has: relates, is-cloned-by, …
desk-jira unlink ABC-903 ABC-901                   # remove it; prints ABC-903's links left
```

`link` takes a type by its name (`Blocks`, `Relates`, `Duplicate`, `Cloners`) or by its wording
from KEY's side (`blocked-by`, `blocks`, `relates-to`, `is-duplicated-by`), owns Jira's inverted
direction, refuses a self link or the reverse of an existing one, skips one that exists, and reads
the link back. `unlink` removes every link between the two (name the type when they have links of
more than one) and reads that back. Dependencies go in links, never in prose: autopilot reads only
the Blocks links.

**Size every ticket**, epic children included:

| Size | Means | Autopilot |
|---|---|---|
| XS | a few lines in one place | runs |
| S | one area, one PR, under half a day | runs |
| M | one PR in one sitting: several areas, or a new piece in an existing pattern | runs |
| L | more than one sitting, or more than one PR | parked: split it first |
| XL | several independently mergeable parts | parked: make it an epic |

Put it in the project's `Size` field where there is one (`desk-jira fields size` finds its id; set
it in the `create`), otherwise as the description's first line, `Size: M`. Jira's API cannot add the
field to a team-managed project: it is a manual step in the project (Project settings → Issue types
→ add a Dropdown field `Size` with XS, S, M, L, XL to each type). Say so once if it is missing.

**Writing an epic** (usually Bea): the epic and each child in `references/ticket-template.md`'s
layouts, children of size M or less. **Before the user approves the set,
run the readiness review in `references/epic-readiness.md`.** File in this order: the epic, the
children (`parent=`), the links, then read it all back (`desk-jira children <EPIC>`). Every write
goes through the gate above.

## Transitions — read them, don't hardcode

§4 Workflow gives the states in order, and §4 In-progress state, Review state and Done state name
the three the skills move to. Still run `desk-jira transitions <KEY>` and pick from what comes back
rather than assuming an id or a name. If two look plausible, ask.

| Moment | Status |
|---|---|
| Starting work (after the cause is understood, not before) | §4 In-progress state |
| PR open and awaiting review | §4 Review state (`none`: skip this move and say so) |
| The user's own PR merged, and it was the **last** open PR on the key | §4 Done state (`jira-close-own-merged`) |
| Closing as not-a-bug / duplicate / out of scope / already fixed | §4 Done state, or a closing state §4 Workflow names for it (`jira-close`, gate item 1) |
| Any other state in §4 Workflow (e.g. needs design, ready for dev) | that state, under `jira-transition`, only when the moment is unambiguous |

**"Already fixed" needs every acceptance criterion checked against `origin/<§0 Default branch>`.**
That means every AC, every scope item and every comment that adds scope, each cited to file:line or
marked NOT MET. Use one read-only verifier per close candidate, told to default to NOT FULLY FIXED.
Anything partial, ambiguous or narrowed by a later ticket stays open. So does an open, unmerged PR
that would fix it. A triage pass's "already fixed" verdicts are overturned by a per-ticket check more
often than not.

## Comments

**Very short. Two or three lines is the target, and one is fine.** Plain words, no narrative, no
restating the ticket: whoever reads it already has the ticket open above your comment. §5 Ticket
comment is the shape; §5 AI attribution `forbidden` means no attribution of any kind in the text.

What earns a place: what was actually wrong, what was done about it, the PR link.

```
Search was matching records on a free-text field, so anything that mentioned the term in prose
showed up. Now matches name + tags only.

PR: #204
```

If the explanation runs long, it belongs in the PR description and the comment should just point at
it. For a close-without-building, one line: "not reproducing as of 27 Jul", "duplicate of ABC-246".

**Idempotency.** Before posting, run `desk-jira comments <KEY>` and search for the marker
`<KEY>/desk-ticket`, and include that marker in what you write. Skip the comment if one already
carries the PR link. When an earlier root-cause comment is now wrong, edit it rather than leaving a
superseded one that reads as false (recipe in the reference).

## Sweep mode

For "go through my tickets and reconcile them", follow **`desk-cleanup`'s Jira sweep** (its step 1).
It owns the decision: the evidence table, the open-PR veto (a merged PR is not proof the ticket is
finished), both ownership conditions, and the read-only fan-out. This skill supplies the writes: each
§4 Done state goes out under `jira-close-own-merged` and its one-line comment under `jira-comment`,
each with the gate block above. Never transition a batch silently.

## Keep them posted

On a sweep or any multi-ticket run, report as you go: which ticket you're on and what you found.
Don't work through fifteen in silence and present a wall at the end. If a ticket turns out to be
ambiguous, say so at that ticket, not in a footnote.

## Common mistakes

| Mistake | Fix |
|---|---|
| A write with no block in the conversation | The exact text always appears, marked `posted` or `awaiting approval` |
| Trusting `updated ABC-123` | Read the read-back lines; for a comment or create, `get` / `comments` it |
| Using another repo's site, project or states | Every value comes from this repo's config (`desk-env where`, `desk-jira where`) |
| Closing a ticket as "already fixed" on a triage verdict | Per-AC check against the default branch, and it waits |
| Commenting on or transitioning a colleague's or an unassigned ticket | Report it for them; never write |
| A verbose comment restating the ticket | Root cause, fix, link. Two or three lines |
| Using the built-in priority when §4 Priority names a custom field | The custom field is the ranking; the built-in one stays as §4 says |
| Creating a ticket with a §4 Priority or §4 Other fields value blank | All of them in the `create` call |
| Asking which priority to use | Judge it against §4 Priority and the parent; say what you picked |
| Source labels (audit, design QA) on a ticket that didn't come from there | They say where the finding came from |
| A per-finding id label, or a new label slipped in | Use §4 Labels; announce a genuinely new one |
| `comment ABC-1 --file body.md` | The body is positional: `comment ABC-1 body.md` |
| Markdown (`## Summary`, `**bold**`, fences, `[text](url)`) sent as literal text, a `.txt` or through a raw recipe | Put it in a `.md` file, which is converted (see *Transport*), or `desk-jira md2wiki` it first. `##` sent raw renders as a nested numbered list |
| Wiki text from `get` or `comments` sent back as `.md` with only `#` lists in it | Save it as `.wiki`: a converted `# item` becomes a heading |
| A `Status:`, `Priority:`, `P1` or `Size:` line in a description | Set the field; the body never repeats it (only the first-line `Size:` fallback where there is no Size field) |
| Adding a Subtask to a sprint | Put the parent in the sprint |
| Posting or deleting an issue link by hand with the token | A link posted with the obvious inward/outward mapping lands backwards and still returns 201. Use `desk-jira link` and `desk-jira unlink` |
| A dependency written in a description ("needs ABC-1 first") | Autopilot reads links only: `desk-jira link` it |
| A ticket with no size, or an L in an epic | Size it from the scale; split anything above M |
| Hardcoding a transition name or id | Fetch the list; names change and vary by issue type |
| Transitioning to the in-progress state at the very start | Once the cause is understood, so a crash doesn't leave a claimed ticket with no branch |
| Inventing acceptance criteria to fill the template | Ask for the real behaviour |
