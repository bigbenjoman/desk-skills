# Autopilot worker contract: Stage 8, Jira

Part of the autopilot worker contract, read when you reach Stage 8, or before any tracker write at
an earlier stage. It binds exactly as the core does.

### Jira comments and transitions follow config §3

With §4 Tracker (`desk-env get tracker`) `none` there are none: skip this section, and never comment on, label or close the
GitHub issue.

**Granted (`jira-comment` is `yes`):** at Stage 8, write the comment and call `desk-jira comment`
yourself, then print it under `JIRA COMMENT — posted`. Do not print `JIRA COMMENT — awaiting approval`
and do not park for it. **Check idempotency first**: read existing comments and skip if the
`(<TICKET>/desk-ticket)` marker is already there, so a re-run does not double-post. Transitioning to
§4 Review state (`desk-env get review-state`; skip if it is `none`) works the same way under `jira-transition`, and field edits
under `jira-edit`. `desk-jira link` and `unlink` are never yours, whatever `jira-edit` says: issue links are set
interactively when an epic is written.

**A link your ticket needs** (a follow-up you raised, a duplicate you found) is the pass's to make, so
never park for it. Print one line per link, at the start of a line, before your `AUTOPILOT_DONE` or
`AUTOPILOT_PARK`, in the arguments `desk-jira link` takes:

```
AUTOPILOT_LINK: DS-764 relates-to DS-814
```

When you end, the pass makes each one under `jira-edit` and reads it back. It parks the ticket,
naming the exact command, for one it does not make: `jira-edit` not `yes`, a ticket outside your
project, one that does not exist, or a Blocks link (`blocks`, `blocked-by`), which changes the order
tickets spawn in and stays the person's. Leave the link out of the steps you name as not reached.

**A ticket with follow-ons** (the `follow_on=` steps on your DONE line, Stage 5 file) lists each in
that comment, one line each under "Once this merges:", with the §3 row it needs. The PR still goes to
the merge path: a follow-on never holds the merge, and never makes this comment a park.

**Not granted:** print `desk-jira`'s full block (`JIRA COMMENT — awaiting approval`,
target, fields, the exact body), then `AUTOPILOT_PARK`. **The safeguard is not calling the command,
not the block**: a worker can print a flawless block and then post anyway, which is why the
command is denied rather than discouraged. Everything else the config grants (pushing,
the draft PR, the review post) still happens before you park, so only the Jira step is left.
