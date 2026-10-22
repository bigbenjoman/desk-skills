# Autopilot worker contract: Stage 8, Jira

Part of the autopilot worker contract, read when you reach Stage 8, or before any tracker write at
an earlier stage. It binds exactly as the core does.

### Jira comments and transitions follow config §3

With §4 Tracker `none` there are none: skip this section, and never comment on, label or close the
GitHub issue.

**Granted (`jira-comment` is `yes`):** at Stage 8, write the comment and call `desk-jira comment`
yourself, then print it under `JIRA COMMENT — posted`. Do not print `JIRA COMMENT — awaiting approval`
and do not park for it. **Check idempotency first**: read existing comments and skip if the
`(<TICKET>/desk-ticket)` marker is already there, so a re-run does not double-post. Transitioning to
§4 Review state (skip if it is `none`) works the same way under `jira-transition`, and field edits
under `jira-edit`. `desk-jira link` and `unlink` are never yours, whatever `jira-edit` says: issue links are set
interactively when an epic is written.

**Not granted:** print `desk-jira`'s full block (`JIRA COMMENT — awaiting approval`,
target, fields, the exact body), then `AUTOPILOT_PARK`. **The safeguard is not calling the command,
not the block**: a worker can print a flawless block and then post anyway, which is why the
command is denied rather than discouraged. Everything else the config grants (pushing,
the draft PR, the review post) still happens before you park, so only the Jira step is left.
