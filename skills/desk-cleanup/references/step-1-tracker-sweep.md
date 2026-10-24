# desk-cleanup step 1: Tracker sweep

Read at the start of step 1. The config, ownership, the order, the precondition, what is never touched, the confirmation and the red flags every step shares are in
`../SKILL.md`, already loaded.

## 1. Tracker sweep

**§4 Tracker `none`: skip this step**, and write `sweep: skipped — §4 Tracker none` in the plan.

Defined here so this skill stands alone. `desk-jira` owns the CLI, comment format and idempotency
markers — use it for the writes, not for the decision.

1. List issues assigned to the config §1 Jira account id in §4 Review state (with Review state
   `none`, in §4 In-progress state — the state a ticket rests in while its PR is open).
2. For each, search the key across **every** PR state, fetching title and head branch so the match
   can be checked:
   `gh pr list --repo <repo> --search "<TICKET>" --state all --json number,title,state,author,mergedAt,headRefName,baseRefName`.
3. **Keep only the PRs that carry the key as a whole id.** GitHub's search is fuzzy: it matches
   words, ignores case and punctuation, and returns `ABC-12` for a search on `ABC-123` or
   `ABC-1234`, and `BUG-119-5` for `BUG-119`. A PR counts only when its title or its head branch
   contains `<TICKET>` with no letter, digit or `-<digit>` continuing it on either side:

   ```bash
   gh pr list --repo <repo> --search "<TICKET>" --state all \
     --json number,title,state,author,mergedAt,headRefName,baseRefName \
     | node ~/.agents/skills/desk-cleanup/bin/cleanup-scan.mjs key-filter "<TICKET>"
   ```

   Match case-insensitively, since branches are often lower-case, but never loosen the bounds.
   Every Done proposal below is made from this filtered list only; a PR the search returned and the
   filter dropped is ignored, not counted as "a PR on the key".
4. Classify:

| Evidence | Proposal |
|---|---|
| a merged PR authored by the §1 handle, **and no PR on that key still open** | §4 Done state (§3 `jira-close-own-merged`), with a one-line comment naming the PR |
| any PR on the key still open | leave it — the open PR vetoes the transition |
| no PR found, or closed unmerged only | leave it; list as needing a decision |
| the merged PR is someone else's | leave it; report, propose nothing |

**A merged PR is not proof the ticket is finished.** A partial first fix often merges to unblock
something while a second PR carries the real work. **Why:** a merged-only match proposes closing a
ticket whose actual fix is still in review.

For a long list, fan out one read-only agent per ticket (within config §3b "Subagents that may run
without asking"). **No agent transitions or comments.** Collect the results and show the proposed
transitions as one list. The Done rows then follow config §3 `jira-close-own-merged`: `yes` applies
them with that list as the record, `ask` waits for agreement, `no` or `TODO` reports the drift and
changes nothing. The comment posts under §3 `jira-comment`, following §5 Ticket comment. Any other
close is `jira-close`, a decision, and is never proposed from a sweep. Each ticket moved to Done then
gets `node ~/.claude/desk/bin/closeout.mjs <TICKET> --pr <n>`, so a batch still holding it parked
records it done at its next pass (`desk-ticket` Stage 7); a ticket in no batch prints nothing.
