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

## Reference files — read at their step

This file holds what every Jira write needs: the config, the transport, the gate, epics,
transitions and comments. The rest is in `references/`, beside it. **At each step below, read the
file the table names for it**, and only that one; a step not listed needs nothing beyond this file.

| Step | Sections | Read |
|---|---|---|
| Writing any body (a ticket, a comment, a description), setting a field with the CLI, or acting on a priority `search` shows | the rest of *Transport* | `references/cli-and-markup.md` |
| Creating a ticket, one or a set, or editing its priority, size, labels, assignee, sprint or §4 Other fields | *House ticket format*, *Fields* | `references/tickets-and-fields.md` |
| Laying out a ticket's body, for any type | the layouts | `references/ticket-template.md` |
| Before the user approves an epic and its children | the readiness review | `references/epic-readiness.md` |
| A call the CLI has no command for (a comment delete, inline images, subtasks with sprints) | the recipes | `references/jira-rest-recipes.md` |

**A reference file you cannot read stops the write.** If the file a step names is missing or empty,
stop and name it by its full path; never write from memory or an earlier copy of this skill.
`/desk-update` reinstalls it.

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

- **Reads prove the login first.** `search`, `get` and `comments` check the credentials before
  querying and exit non-zero on a bad or expired token, because Jira answers an anonymous search
  with 200 and no issues. An empty `search` with exit 0 is a real "no matches"; a non-zero exit is
  a search that did not run, never "nothing found".
- **Credentials never reach an argv.** The CLI hands them to curl on stdin (`curl -K -`). A call
  no subcommand covers still goes through it: `desk-jira api <path>` reads and `desk-jira rest
  <PUT|POST|DELETE> <path> [<body file>]` writes (`references/jira-rest-recipes.md`), never a shell
  function or `curl` of your own.
- **Screenshots go on the ticket**, not only the PR: `desk-jira attach ABC-123 before.png after.png`.

The rest of what the CLI does on a write (field values, the read-back, positional bodies, the
priority `search` shows) and how a body is written (markdown, wiki markup, the render check) are in
**`references/cli-and-markup.md`**: read it before writing any body or setting any field.

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

## Epics

A large feature is an epic whose children are each one sitting, so `desk-autopilot <EPIC>` can run
them as a batch. The commands:

```bash
desk-jira children ABC-900                         # its children (or a story's subtasks), rank order
desk-jira create Story "<summary>" body.md parent=ABC-900 <size field>=M
desk-jira create-batch tickets.tsv                 # a set of tickets, one line each (below)
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
run the readiness review in `references/epic-readiness.md`.** File in this order: the epic and the
children in one `desk-jira create-batch`, then the links, then read it all back (`desk-jira children
<EPIC>`). Every write goes through the gate above.

**File a set of tickets with `create-batch`, never a loop over `create`.** Write each body as a `.md`
file and a `.tsv` file beside them (both with the Write tool, in the worktree or `$DESK_STATE`),
one line per ticket, tab-separated: type, summary, body file, then the `field=value` pairs and
`create` flags that ticket needs. `parent=@1` is the key row 1 gets, so the epic goes on row 1 and
its children name it; an existing epic is `parent=ABC-900`. Blank lines and `#` lines are skipped.

```
Epic	Checkout redesign	epic.md	customfield_10208=XL
Story	Card form validates as you type	card-form.md	parent=@1	customfield_10208=M
Story	Saved cards on the payment step	saved-cards.md	parent=@1	customfield_10208=S
```

Every row is checked as `create` checks it (the field rules, the lint, the assignee) before any is
sent, and one refused row creates nothing: the output names the row and why. Rows then go in order,
each printing `created <KEY>`; a Jira error stops the batch there and names what was created and
which rows were not sent. File the rest from a new file holding only the rows not created, with
each `parent=@<n>` that pointed at a created row replaced by its key. A row that routes the ticket (`--route`, or a `reporter=`) needs `--route` on `create-batch`
itself, which asks first (gate item 3). Links stay a separate step: `desk-jira link`.

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
