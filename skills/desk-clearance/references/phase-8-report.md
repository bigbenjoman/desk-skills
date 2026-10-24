# desk-clearance phase 8: After a merge, and the report

Read at the start of phase 8, or earlier where the core's Phases section says. The config,
ownership, what config §3 decides, the merge bar, parking and the red flags every phase shares are in
`../SKILL.md`, already loaded. Once the report is out, `learning-from-reviews.md` (beside this file)
covers refreshing what reviews here keep asking for.

### 8. After a merge, and the report

**A merged PR's ticket goes to §4 Done state** via **desk-jira**, as soon as the merge is
confirmed — subject to config §3 `jira-close-own-merged`; any other close is `jira-close` and waits.
Merge and Done are one action in two systems; splitting them is how a board ends up with ~20 merged
tickets parked in §4 Review state. Two exceptions only: **a multi-part ticket whose other part is
still open** (comment what landed, transition on the last part), and **no ticket key in the branch
or title at all**. **§4 Tracker `none`: skip this step entirely** — there is no ticket to move.

**Report** stale worktrees and branches, never delete them: a worktree carries
`.claude/desk-ticket-<TICKET>.json`, which desk-ticket resumes from. **desk-cleanup** removes them.

### The report — one per pass, fixed shape

Reports that left the queue out made the user reconstruct it by hand — "why did you stop?", "so
nothing needed me, and all comments are closed?", counting who was waiting on whom — all of which
the state render already knows. So the report is a fixed shape, not a summary you compose:

```
CLEARANCE PASS <time> - <n> open PRs - bar: <gate|approved>
MERGED       #<n> <TICKET> <merge sha>
READY        #<n> <TICKET>  (when §3 pr-merge-green is no or TODO, §4 Merge method is unset, or approvals are required)
HELD         #<n> <TICKET> at <sha> - <the §4 Merge holds reason>   (green; a person merges it)
HANDED BACK  #<n> <TICKET> -> <reviewer>            (re-review requested)
WORKED, NOT HANDED BACK  #<n> - <why>
PARKED       #<n> - <reason, and whether it is the merge or the comments that are parked>
WAITING ON   <person>: #<n> #<n>
NEEDS YOU    <one line each, or the exact words "nothing needed from you">
CI           <as of <sha>: PRs with a required check pending, or an advisory check red>
```

- **"Nothing needed from you" is said explicitly** when true. Its absence reads as an omission.
- **Never report a PR green while a required check is pending.** Give CI as of a named SHA, and
  **name every red advisory check** — the GitHub UI draws a red cross for those, so silence reads
  as a miss.
