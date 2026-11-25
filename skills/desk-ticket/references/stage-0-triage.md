# desk-ticket Stage 0: Triage

Read at the start of Stage 0, and no other stage's file with it. The config, the gates, "Ask or
take", the resume file and the red flags every stage shares are in `../SKILL.md`, already loaded;
a "below" here that this file does not hold points there.

| # | Stage | What happens |
|---|---|---|
| 0 | Triage | Read the ticket fully: description, comments, linked issues, the design link if one is set, and, for context only, its parent epic or story (this ticket's own criteria are its scope). Note the issue type. Rename the session (below). Assign to the user if unassigned (Jira only). Pick a **provisional** lane and state it with its cost, **plus which skills own which stage** (below). Write the resume file. **Do not transition the ticket yet.** |

**Where the ticket's Design section links a Claude Design artifact**, read
`design-canvas.md` (beside this file) now: it holds this stage's check and Stage 1's save.

### What the ticket can be, and the ticket file

| Argument | `<TICKET>` | Text comes from |
|---|---|---|
| a key matching §4 Ticket key pattern (`desk-env get ticket-pattern`; Tracker `jira`) | the key | Jira, via `desk-jira` |
| an id matching §4 Other work id patterns (`desk-env list work-id-patterns`; any tracker), e.g. `P1-M14-FIX-1`, `BUG-119-5` | the id exactly as given, case kept | the planning file that defines it (`.belmont/`, or wherever §5 Repo instructions say work is planned), or the user |
| with Tracker `none`: a GitHub issue URL or `#<n>` | `issue-<n>` | the issue, `gh issue view <n> --repo <repo> --comments` (§3 `read-own-work` / `read-others`) |
| with Tracker `none`: a plain description | a kebab-case slug of it (two to five words, lowercase ASCII) that you state at Stage 0 | the user's words: anything they leave open is a question |

Anything else is not a ticket here: say which patterns it failed and ask. `<TICKET>` goes everywhere
a key would: the branch, the resume file, the handoff directory, the session name, the comment
marker. A work id is matched whole: `BUG-119` is not `BUG-119-5`.

**For every non-tracker `<TICKET>`, write the ticket file at Stage 0**, so a later session, an
autopilot batch and the merge driver all read the same text: `$DESK_STATE/tickets/<TICKET>.md`
(`desk-env paths` prints `DESK_STATE`), as

```markdown
# <TICKET>

Source: <one of: the user, in this conversation · GitHub issue <owner/name>#<n> · <planning file path>, entry <id>>

<the ticket text, verbatim: title, description, acceptance criteria>

## Comments
<for a GitHub issue, every comment in order with author and date; otherwise omit this section>
```

Copy, never summarise. For a planning id, find its entry in the planning file and copy the task
text and acceptance criteria with the path in `Source:`; no entry, or two, is a question. If the file
already exists, read it and say so rather than overwriting it. Never write one for a tracker key.

For every non-tracker ticket, these change, each said in one line when you reach it rather than
silently skipped:

- **The issue type** comes from the description, the issue's labels, or asking: bug, feature, or
  other. It picks the branch prefix exactly as a Jira type would.
- **Every Jira step is skipped**: no assignment at Stage 0, no transition at Stage 2, no comment or
  transition at Stage 8, no move to a done state after merge. Nothing in §3 lets a skill comment on,
  label, assign or close a GitHub issue, so never do any of those; the PR body references the issue
  in the form §5 PR body uses, and adds a closing keyword only if that convention does.
- **"The ticket is done"** means the PR merged (and, for an issue, that it is closed).

### Claim plan-first work parked in a batch

**An interactive session taking on a ticket an autopilot batch parked claims it (Stage 0)**, whatever
its lane, so the batch shows it as this session's work rather than on the person's needs-you list,
and recommends no resume while this session is alive. Read it with
`node ~/.claude/desk/bin/queue.mjs get <TICKET>` (run in the repo; it finds the batch holding the
key, and refuses one in no queue, which has nothing to claim). Where it is `"state": "parked"`,
claim it:

```bash
node ~/.claude/desk/bin/queue.mjs park <TICKET> --claimed-by "$CLAUDE_CODE_SESSION_ID"
```

The park keeps its question, so no worker takes it. Once this session's transcript has been still
past §3b "Release idle claims after (hours)" (`desk-env get claim-release`), a pass ends the claim:
plan-first work (lane C parked at triage) waits for a session again, and reaches needs-you once
unclaimed past §3b "Plan-first wait before needs-you (hours)" (`desk-env get plan-first-wait`); any
other lane C or D park needs the person again; a lane A or B one with a clean worktree goes back to
the workers. A held ticket or a spine cannot be claimed. An autopilot worker never claims: its
ticket is running, not parked.

### Skill routing

**Skill routing goes in the plan, not a closing checklist (Stage 0).** State a short table of which
skill owns which stage: `desk-ticket` for this ticket, `desk-pr` at Stage 7, `desk-jira` for
Jira writes (or "none: no tracker"), `desk-review-response` for any reviewer comment, `desk-dev` for
the environment, `desk-autopilot` for a batch of tickets, and for a ticket that renders UI
`ux-designer`, `ui-designer` and `ux-copywriter` at Stage 3. Name any the user would expect that you
are **not** using, with the reason. A plan that buries the routing reads as improvised process.

## Session rename (Stage 0)

Sessions are named for their role, so parallel ones are tellable apart and a peer session can
reach them by name: a ticket session is `<repo>-ticket-<TICKET>`, `<repo>` being the name part of
§0 GitHub repo (`widgets` for `acme/widgets` below): substitute this repo's before printing it.

```
widgets-ticket-ABC-448   widgets-ticket-issue-81   widgets-ticket-fix-login-redirect
```

The name stays the ticket's for its whole life: a handoff records it, and `/desk-resume` gives it
back after `/clear`. An autopilot worker is named this way at spawn and skips this section.

**You cannot do this yourself.** `/rename` is a built-in command and only the user can type it.
Writing the `name` field in `~/.claude/sessions/<pid>.json` does change the stored value, but the
running process owns that file and the displayed title does not pick the change up mid-session, so
it looks like nothing happened.

So at Stage 0, ask for it in one line and move on. Don't wait for it, and don't edit the file:

> Worth renaming this session: `/rename widgets-ticket-ABC-612`

## Red flags at this stage — stop

- About to work a non-tracker ticket without having written its ticket file
