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
   **Stacked** (the render says `STACKED`): every ordinary path refuses, including `--auto`; use
   `gh api -X PUT repos/<§0 GitHub repo>/pulls/<n>/merge-async -f merge_method=<method>`, which only
   *enqueues* — poll `.merged`. Merge stacks bottom-up.
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
