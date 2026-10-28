# desk-autopilot: batch arguments and the ticket file

Part of desk-autopilot, read at Stage 1 before triage when an argument is not a tracker key, and
whenever a script refuses a key or a PR's branch is in question. It binds exactly as the core
`SKILL.md` does. Where it says "above" or "below" of something this file does not hold, or cites a
section in *italics* it does not hold, that is in the core or in the file the core's reference
table names (the §3 table is the core's, under *Read the config first*).

### What a batch argument can be, and the ticket file

Every argument becomes one **key**, which names the queue entry, worktree, log and screenshot
directory. There are three kinds, the same ones `desk-ticket` accepts:

| Argument | Key | Where its text comes from |
|---|---|---|
| a tracker key matching §4 Ticket key pattern (Tracker `jira`) | the key as given | Jira, read by `triage.sh` with `desk-jira` |
| an **epic** key (Tracker `jira`) | never a key itself: it expands to its children (see *An epic as a batch*) | Jira |
| an id matching §4 Other work id patterns (any tracker), e.g. a planning-tool id `P1-M14-FIX-1` or `BUG-119-5` | the id exactly as given, case kept | the ticket file you write (below), never Jira |
| with Tracker `none`: a GitHub issue URL or `#<n>` on §0 GitHub repo | `issue-<n>` | the ticket file you write, from the issue |
| with Tracker `none`: a short description the user typed | a lowercase kebab slug of it, stated back at Stage 2 | the ticket file you write, from the user's words |

An argument that is none of these is refused: say so and ask; never reshape it to look like a key.

**For every key that is not a tracker key, write its ticket file before Stage 1 triage**, because
triage, the worker and the merge driver read the ticket from there and nowhere else. The file is
`$DESK_STATE/tickets/<KEY>.md` (`desk-env paths` prints `DESK_STATE`), written as:

```markdown
# <KEY>

Source: <one of: the user, in this conversation · GitHub issue <owner/name>#<n> · <path of the planning file>, entry <id>>

<the ticket text, verbatim: title, description, acceptance criteria>

## Comments
<for a GitHub issue, every comment in order with author and date; otherwise omit this section>
```

- **From the user**: their words verbatim, plus anything they added when you stated the slug back.
- **From a GitHub issue**: `gh issue view <n> --repo <§0 GitHub repo> --comments`, copied, not
  summarised. A later comment can settle or rule out what the description asks for.
- **From a planning file** (`.belmont/`, or wherever §5 Repo instructions say the repo plans work):
  find the entry for that id and copy the task text and its acceptance criteria verbatim, with the
  file's path in `Source:`. Two entries with the same id, or none, is a question for the user, not a
  pick.

Never write a ticket file for a tracker key (Jira is the source), and never edit one after triage:
answers go through `answer.mjs` into the ticket's briefing.

Everything Jira-shaped drops out for a non-tracker key: the Jira rows of the §3 table below do not
apply, workers skip `desk-ticket`'s Jira stages, and "unassigned or yours" means a GitHub issue with no
assignee or assigned to §1 GitHub handle (a description the user typed, or a planning entry, is
theirs by definition). **If an installed script refuses a key** (the merge driver's `--tickets`,
`plan-batch`, `triage.sh`), stop and say which script and which key: never reshape it to get past
the refusal.

**The branch is recorded, and the merge driver finds the PR by it.** Triage proposes a branch name
from §5 Branch names; `setup-worktree.sh` creates the worktree on it and the queue records it as the
ticket's `branch`. The merge driver takes a PR as the ticket's only when its head branch is **exactly**
that recorded branch and its base is §0 Default branch (or the batch's base: see *A batch that targets a feature branch*), so a promotion PR (default → production), a
PR for a longer id that starts with this one (`BUG-119-5` vs `BUG-119`) and a colleague's PR on the
same key are never merged by it. Never rename a worker's branch or open its PR from another one: the
driver will not see it.
