# desk-clearance phase 6: Merge lane

Read at the start of phase 6, or earlier where the core's Phases section says. The config, ownership, what config
§3 decides, the merge bar, parking and the red flags every phase shares are in `../SKILL.md`, already
loaded.

### 6. Merge lane — serial, parent only, never delegated

Only if config §3 `pr-merge-green` is `yes` (or `ask`, answered). May run alongside phase 5.
Before each merge, from freshly derived state:

1. **Order.** Computed by the render, not eyeballed. A base relationship is not the only way one PR
   swallows another: a branch can contain another PR's commits while being based on a third. Anything
   under **DO NOT MERGE** would close another PR with open threads: **stop and ask.** The contained PR's code lands **and GitHub auto-closes it**, orphaning
   the reviewer's threads where nobody will answer them.
2. **Overlap.** If anything sharing a file merged since this PR's checks ran, update and get a fresh
   green first.
3. **Re-verify.** `OPEN`, not `DIRTY`, verdict unchanged, feedback still 0 (under `merge-feedback-first`), no §4 Merge holds glob matches its files, and **re-read the head
   SHA** — that SHA must be green.
4. **Title and body.** Under a squash merge the commit message is the PR title and body, so a stale
   description becomes permanent history. The title must follow §5 PR title — where §4 Tracker is
   `jira`, the ticket key in it is what links the merge to the ticket.
5. **§4 Merge method, and only that.** The render prints it and warns if a ruleset allows
   something else. Unstacked: the render prints the exact pinned command for each ready PR,
   `gh pr merge <n> --repo <§0 GitHub repo> --<method> --match-head-commit <head>`; run that one,
   after confirming step 3's SHA is still that head (or leave armed auto-merge, armed with the same
   `--match-head-commit`, to fire).
   **Every merge is claimed and recorded** in the machine-wide merge log, so the merge driver and
   another session never race one PR and who merged it is on record. Before merging or arming:
   `node ~/.claude/desk/bin/merge-log.mjs claim <n> <head> --by "session <your session name>"`. When
   it refuses (exit 11), do not merge or arm it, and report the line it printed. Where another desk
   path already merged, armed or claimed the PR, that line names who did it and at which head; any
   other refusal (a usage error, an unreadable repo) is not another merger, so do not say it is. After: `merge-log.mjs record <n> <head> --by
   "session <your session name>" --event merged` (`armed` for auto-merge, `disarmed` when you turn it off, `failed` when gh refuses).
   `merge-log.mjs show --pr <n>` says who did.
   **Every merge is one hold of the merge lease** for the repo and the PR's base, the one the merge
   driver takes, with the ticket ledger checked inside it. `desk-env lease mode merge` says how: `off`
   merges as before, with no lease and no ledger check; `shadow` takes the lease without waiting, and
   the lease log records a would-refuse naming you and any holder; `on` waits for it. Unstacked, take
   it before the claim exactly as `desk-ticket` Stage 7 says (`merge-lease.mjs take … --owner claude`,
   and what each exit means: 3 is a merge or arming another desk path made, which you report and do
   not merge; 4 is an unreadable lease store, where merges wait and you report
   `desk-env lease reset --reason <why>`). Then claim, merge, record, and, with the kind not `off`,
   record the merge in the ledger before releasing the lease, where a batch holds the PR's ticket:
   `node ~/.claude/desk/bin/queue.mjs merged <TICKET> --pr <n> --head <branch> --head-sha <head>
   --base <base> --by "session <your session name>"`. A ticket no batch holds is refused there, and
   the merge log's line is its record. Release with `node ~/.claude/desk/bin/leases.mjs release
   <lease> --pid <owner>`, on every path out of the hold: a refused claim or a merge gh refuses
   releases it too, or it blocks every merge into that base until it lapses.
   **Stacked** (the render says `STACKED`): every ordinary path refuses, including `--auto`; the merge
   goes through GitHub's enqueue-only call (`merge-async`), and one command makes the whole hold:
   ```bash
   node ~/.claude/desk/bin/merge-lease-hold.mjs <n> <head> --repo <§0 GitHub repo> --base <the PR's base> --method <method> --by "session <your session name>" --ticket <TICKET> --head <branch>
   ```
   Give it the Bash tool's longest timeout (600000 ms): it can wait six minutes for the lease and two
   for GitHub, and a call the tool cuts off at its two-minute default never releases the lease or
   records the merge. It takes the lease and the ledger check, claims, enqueues, polls `.merged` until GitHub reports
   the PR merged or 120 seconds pass, whichever is first, records the merge in the merge log and the
   ledger, and only then releases the lease, so the next PR's check can see this one. Leave out
   `--ticket` and `--head` for a PR with no ticket. Exit 0 is merged at that head; 1 is not merged in
   time, a refused enqueue, or a merge at another head (it says which: stop and report); 3, 4 and 75
   are the take's, above; 11 a refused claim. Merge stacks bottom-up, the next PR only after exit 0.
6. **Confirm** `state == MERGED`, that the merged head (`headRefOid`) is the SHA you checked, and
   record the merge commit SHA. A different head means something merged unchecked: stop and report.

**Armed auto-merge merges without you.** If the render says `AUTO-MERGE ARMED`, anything that turns
the head green — a posted verdict reading as §4 Clean review verdict where a check reads it, a rerun — merges
the PR seconds later, unless it is `DIRTY`. Treat clearing the gate on such a PR as the merge itself:
apply the bar first.

**Merging may deploy.** Read §4 Staging and §4 Production: where a push to the default branch
releases somewhere and runs database migrations, a PR carrying a migration *executes* it on merge,
and back-to-back merges stack concurrent migrations (an advisory-lock timeout is the usual symptom).
**Space merges out** there. Where §4 Staging is `none` and nothing deploys on merge, serial is still
the rule; the spacing is not needed.

**Never pile onto a broken default branch.** If its CI is red, stop merging and report. If a merge
breaks it, stop and report — a revert is a judgement call.
