# desk-clearance: self-reviewing a backlog

Read only for a one-off self-review of the user's PRs that predate desk-ticket's own review. The
config, ownership, what config §3 decides, the merge bar, parking and the red flags every phase
shares are in `../SKILL.md`, already loaded.

## Self-reviewing a backlog — one-off, not part of a pass

desk-ticket runs §4 Local review command before a PR opens. This section is only for the user's
PRs that predate that, and only once; with §4 Local review command `none` it does not apply.
Everything is in `references/hazards.md#backlog-self-review`; the two rules that matter:

- **A sweep mode of a review tool may review everyone's open PRs.** Scope the queue to the §1
  GitHub handle, or the first command crosses the ownership boundary (on one sweep, 24 of 46 were
  other people's).
- **A finding is a park, never an amendment to the merge bar.** A confirmed P0 parks the merge with
  its `file:line`, and the user decides.
