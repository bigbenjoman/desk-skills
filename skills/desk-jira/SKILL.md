---
name: desk-jira
description: >-
  Use when creating, editing, commenting on, assigning, prioritising or transitioning a Studia
  Jira ticket (SV-nnn), or when reconciling several tickets against GitHub — "write a ticket for
  this", "add a Jira comment", "move it to Review/QA", "close it as a duplicate", "go through my
  Review/QA tickets and see which have merged".
---

# desk-jira

## Overview

**Read `~/.claude/desk-config.md` first.** §4 has the site, project key, workflow, label
vocabulary and who owns product, design and QA. §3 decides whether each write posts, waits or does
not happen at all. §1 has the user's GitHub handle and Jira account.

Site `studia-team-gdndoc1i.atlassian.net`, project **SV** ("Studia V2"). Issue types in use:
**Task**, **Bug**, **Story**.

**Core principle: the exact text of every Jira write appears in the conversation.** Tickets and
comments are seen by the CEO, the CPO and the engineers. Config §3 decides whether that text is a
request (`awaiting approval`) or a record (`posted`). It never decides whether the text is shown.

## Transport — `desk-jira`, not the Atlassian MCP

`desk-jira` ships with these skills (`bin/desk-jira`, installed to `~/.local/bin/`). It talks straight
to the Jira REST API with the user's own API token. Check it before relying on it:

```bash
desk-jira whoami        # prints your display name and accountId, or says what is missing
```

| Result | What to do |
|---|---|
| Prints a name | Use it for every Jira read and write, including inside fanned-out subagents. `desk-jira --help` lists the commands. |
| "no email" / "no token" | Installed but not configured. Say so and point at the setup notes at the top of the script (`JIRA_EMAIL` or `~/.config/studia/jira-email`, plus a token at `~/.config/studia/atlassian-token`). Use the Atlassian MCP meanwhile. |
| `command not found` | Not installed. Use the Atlassian MCP and don't keep retrying. |

The claude.ai Atlassian connector is a three-hop proxy (seconds per call against ~0.3s) and **it
cannot upload attachments at all**. If `desk-jira` starts failing auth mid-session, the token has
expired: say so rather than silently switching transport. **Transport is not permission.** The
gate below applies identically either way.

What the CLI does for you, and the traps it still has:

- **Field values.** `field=@path` reads a file. JSON passes through untouched. A bare value is
  wrapped to the shape the field needs: `customfield_10159=P1` becomes `{"value":"P1"}`,
  `assignee=me` becomes your accountId. If `desk-jira --help` doesn't mention `@file`, your copy
  predates 2.0: re-run `install.sh`.
- **Every `edit` prints the fields read back from Jira.** Check that output. A line saying
  `the write did not stick` is a failed write, even though the PUT returned 2xx.
- **Bodies are positional.** `comment <KEY> <body-file|text>`, and `create`'s description the same
  way. There is no `--file` flag. The CLI refuses a body that looks like a flag or a missing
  `.md`/`.txt`. Write approved text to a file and pass the path. The literal-string form of
  `create` can return a bare 400, and a file avoids shell-quoting anyway.
- **`search` requests the custom fields**, and its third column is Launch Priority. For anything
  you will act on, confirm with `desk-jira get <KEY> --json`.
- Text calls use API v2, which takes markdown-ish wiki markup. `##` headings match the recent tickets.
- **Screenshots go on the ticket**, not only the PR: `desk-jira attach SV-123 before.png after.png`.

For anything the CLI has no command for, read **`references/jira-rest-recipes.md`**. That covers
issue links (the direction is inverted), deleting a mistaken comment, editing a description that
holds inline images, and subtasks with sprints.

## Gate — which writes post, which wait

Every write prints this block. Not a summary of the text: the text.

```
JIRA <TICKET | COMMENT | EDIT | TRANSITION> — <posted | awaiting approval>
target : <SV-XXX, or "new ticket in SV">
fields : type · assignee · labels · priority · launch priority · size · impact · repository
---
<the exact body, verbatim>
```

Find the config §3 row for the write:

| Write | §3 key |
|---|---|
| Comment, or edit your own comment | `jira-comment` |
| New ticket | `jira-create` |
| Description or field edit (Launch Priority, labels, Size…) | `jira-edit` |
| Status change between working states (In Development, Review/QA, In Design, Dev Ready) | `jira-transition` |
| `Done` once the user's own last PR on the key has merged | `jira-close-own-merged` |
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
   of scope, or "already fixed". The `Done` after the user's own last PR merges is
   `jira-close-own-merged`, a record. See Transitions.
2. **Asserting a product or catalog fact** waits whatever §3 says (`product-calls` is `stop`): a
   subject, level, price or business rule not already in the ticket, a sheet or the database.
3. **Routing work to another person** (`jira-route`). Assigning or naming anyone other than the user
   as owner. A question for product goes in a comment addressed to the product owner (config §4)
   listing the exact questions, and even that waits.
4. **Anything on a ticket not assigned to the user** (`jira-others`), including unassigned ones.
   Every write comes from the user's account, so touching someone else's ticket reads as them
   narrating or closing a colleague's work. At `no`, report it instead; at `ask`, ask each time.

An unnecessary pause costs one message. A wrongly-posted product claim, or a ticket landed on a
colleague, costs a public retraction. When unsure whether a write sits inside a `yes`, wait.

## House ticket format

Keep it simple and readable: short sections, real file paths, no padding. Read two or three
neighbours before writing a new one. Summaries carry an `[Area]` prefix, e.g.
`[Calendar] Past sessions are only visible on the day they happened`.

For a **Bug**:

```markdown
## Summary
<what's wrong, in two or three sentences>

## Environment
https://next.studia.io/<path> · <browser if relevant> · audited <date>

## Steps to reproduce
1. …
2. …

## Expected vs Actual
* **Expected:** …
* **Actual:** …

## Diagnosis (code)
<file:line references and the actual mechanism>

**Suggested fix:** <one or two sentences>

## Acceptance criteria
```
Given <state>
When <action>
Then <outcome>
```

## References
<audit id, Figma node, related tickets>
```

For a **Task**, drop *Steps to reproduce* and *Expected vs Actual*, and use `## Scope` as a
numbered list of what to do. Add `## Design` with the Figma dev link when there is one, and
`## Testing` when the approach matters.

A **Story** is much richer: `## Context & Background`, `## User Stories`,
`## Acceptance Criteria (BDD Format)`, `## Technical Constraints & Integrations`,
`## Dependencies`, `## Success Metrics`, `## Out of Scope`. Use SV-440 as the reference example.

**Never invent the substance.** If the real subject name, level, price or business rule isn't in
the ticket, a sheet or the database, ask. Inventing GCSE subjects that didn't exist cost a full
revert.

**Search the backlog before writing a ticket for a page or feature**, including old unlabelled
tickets — those are the ones a new ticket ends up duplicating.

## Fields

Fill **Launch Priority, Size, Impact and Repository on every create, in the one `create` call.**
Nothing flags a blank one later, so a ticket created without them stays unfinished until someone
sweeps for blanks.

| Field | Id | Values |
|---|---|---|
| Priority | built-in | always `Medium`. The team does not rank with it |
| **Launch Priority** | `customfield_10159` | `P0`–`P4`, below |
| Size | `customfield_10511` | `XS` a one-liner · `S` under a day · `M` a few days · `L` about a week · `XL` should probably be split |
| Impact | `customfield_10512` | `Blocks` a user can't complete the journey · `Degrades` works but badly · `Polish` cosmetic · `Internal` no user sees it (CI, agents, tooling, docs) |
| Repository | `customfield_10513` | where the change lands. `studia-web` includes `apps/portal/`; `studia-portal` only for the legacy checkout |
| Figma URL | `customfield_10312` | the dev link, when there is one |
| Sprint | `customfield_10020` | a plain sprint id. **A Subtask rejects it with a bare 400**: it inherits the parent's sprint, so put the parent in instead and skip subtasks in bulk loops |

Resolve anything else with `desk-jira fields <filter>` rather than guessing an id.

**Launch Priority: assign it yourself, don't ask.** Judge it from the ticket and put the value in the
gate block.

| Value | When |
|---|---|
| `P0` | production broken, or data being lost right now |
| `P1` | cannot launch without it. Keep a high bar; most things are not P1 |
| `P2` | degrades a real user journey, or a security / data-exposure gap |
| `P3` | minor or edge-case gap, or a follow-up to a fix already shipped |
| `P4` | polish, docs, agent tooling, or blocked on something / explicitly "not needed yet" |

Don't inflate it. Calibrate against the ticket it came from and a couple of neighbours
(`desk-jira get <KEY> --json`). A follow-up rarely outranks its parent.

**Assignee.** The user, by default. Anyone else is routing (gate item 3).

**Labels.** Pick the ones that genuinely apply. There is no unconditional set: a label is there so
someone can filter on it later, and one that goes on everything filters nothing.

| Label | For |
|---|---|
| `qa-audit` | the finding came out of a QA audit pass |
| `studia-design-qa` | the finding came out of the design QA audit specifically |
| `design-system` | studia component or DESIGN.md work |
| `tutor-profile` · `about` | the surface it affects |
| `needs-design` | blocked on design (the designer in config §4) |
| `sev-p3` and the rest of the `sev-pN` family | severity, mirroring Launch Priority |
| `One-shot` | note the capital O |

Most tickets written up from an audit pass carry both audit labels. A bug found while building
something else, an infrastructure task or a security finding is not an audit finding and should
not carry them. If nothing fits, check the project list and **say you're introducing a new label**
rather than slipping it in. **Never** `audit-disc-NNN`: a label naming one finding is an id.

**Reporter.** A bug filed by the QA filers in config §4 is usually a real reproduction with a
launch-blocking framing. Treat the described behaviour as observed, not alleged.

## Transitions — read them, don't hardcode

The workflow is `To Do → In Design → Dev Ready → In Development → Review/QA → Done`, all global
and available from any state. Still run `desk-jira transitions <KEY>` and pick from what comes back
rather than assuming an id or a name. If two look plausible, ask.

| Moment | Status |
|---|---|
| Starting work (after the cause is understood, not before) | `In Development` |
| PR open and awaiting review | `Review/QA` |
| The user's own PR merged, and it was the **last** open PR on the key | `Done` (`jira-close-own-merged`) |
| Closing as not-a-bug / duplicate / out of scope / already fixed | `Done` (`jira-close`, gate item 1) |
| Needs design before it can be built | `In Design` |
| Specced and ready but not started | `Dev Ready` |

**"Already fixed" needs every acceptance criterion checked against `origin/main`.** That means
every AC, every scope item and every comment that adds scope, each cited to file:line or marked
NOT MET. Use one read-only verifier per close candidate, told to default to NOT FULLY FIXED. Anything
partial, ambiguous or narrowed by a later ticket stays open. So does an open, unmerged PR that
would fix it. A triage pass's "already fixed" verdicts are overturned by a per-ticket check more
often than not.

## Comments

**Very short. Two or three lines is the target, and one is fine.** Plain words, no narrative, no
restating the ticket: whoever reads it already has the ticket open above your comment.

What earns a place: what was actually wrong, what was done about it, the PR link.

```
Search was matching tutors on their bio, so anyone who mentioned a subject in prose showed up.
Now matches name + subjects only.

PR: #204
```

If the explanation runs long, it belongs in the PR description and the comment should just point at
it. For a close-without-building, one line: "not reproducing as of 27 Jul", "duplicate of SV-246".

**Idempotency.** Before posting, run `desk-jira comments <KEY>` and search for the marker
`SV-XXX/desk-ticket`, and include that marker in what you write. Skip the comment if one already
carries the PR link. When an earlier root-cause comment is now wrong, edit it rather than leaving a
superseded one that reads as false (recipe in the reference).

## Sweep mode

For "go through my tickets and reconcile them", follow **`desk-cleanup`'s Jira sweep** (its step 1).
It owns the decision: the evidence table, the open-PR veto (a merged PR is not proof the ticket is
finished), both ownership conditions, and the read-only fan-out. This skill supplies the writes: each
`Done` goes out under `jira-close-own-merged` and its one-line comment under `jira-comment`, each with
the gate block above. Never transition a batch silently.

## Keep them posted

On a sweep or any multi-ticket run, report as you go: which ticket you're on and what you found.
Don't work through fifteen in silence and present a wall at the end. If a ticket turns out to be
ambiguous, say so at that ticket, not in a footnote.

## Common mistakes

| Mistake | Fix |
|---|---|
| A write with no block in the conversation | The exact text always appears, marked `posted` or `awaiting approval` |
| Trusting `updated SV-XXX` | Read the read-back lines; for a comment or create, `get` / `comments` it |
| Closing a ticket as "already fixed" on a triage verdict | Per-AC check against `origin/main`, and it waits |
| Commenting on or transitioning a colleague's or an unassigned ticket | Report it for them; never write |
| A verbose comment restating the ticket | Root cause, fix, link. Two or three lines |
| Using `Priority` to signal urgency | That's Launch Priority; Priority stays Medium |
| Creating a ticket with Launch Priority, Size, Impact or Repository blank | All four in the `create` call |
| Asking which Launch Priority to use | Judge it against the table and the parent; say what you picked |
| Audit labels on a ticket that didn't come from an audit | They say where the finding came from |
| An `audit-disc-NNN` label, or a new label slipped in | Use the vocabulary; announce a genuinely new one |
| `comment SV-1 --file body.md` | The body is positional: `comment SV-1 body.md` |
| Adding a Subtask to a sprint | Put the parent in the sprint |
| Posting an issue link with the obvious inward/outward mapping | It lands backwards and still returns 201. See the reference |
| Hardcoding a transition name or id | Fetch the list; names change and vary by issue type |
| Transitioning to In Development at the very start | Once the cause is understood, so a crash doesn't leave a claimed ticket with no branch |
| Inventing acceptance criteria to fill the template | Ask for the real behaviour |
