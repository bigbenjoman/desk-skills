# Each ticket and deploy as it stands now

Read when writing an item's "Where it stands now" (SKILL.md step 3). The collectors ran earlier,
and what the user last did is how they left the work, not how it stands.

## Each ticket, with every PR naming its key

**Read each ticket again as you write its bullet, with every PR naming its key.** What the user
commented or did on a ticket is how they left it, not how it stands now: a teammate may have fixed
it since. For every ticket the post mentions, read its current status in its tracker (§4 Tracker
`jira`: `desk-jira get <KEY>` for that ticket's repo, `DESK_SLUG=<slug>` as the Jira collector sets
it; `none`: `gh issue view <n> --repo <owner/name> --json state,closedAt`) and every PR naming it,
by any author, open or merged:

```bash
gh pr list --repo <owner/name> --state all --search "<KEY>" --json number,title,author,state,isDraft,mergedAt
```

With Tracker `none`, search `#<n>`. The bullet states what those reads show.

**A ticket someone else's merged PR fixed since the user last touched it** (merged after the
user's last comment, move, PR or session on it) is said as that, naming who and which PR
("Sam fixed it in #1540 (merged), now in Review"), or left out. Any ask in its bullet is
dropped, and so is any claim that PR settles ("the second criterion isn't fixed").

Read a ticket only where its repo's collector read it (§3 `read-own-work`, as for PRs). If a read
fails, write what the collectors showed and name the ticket under **Check before posting** as last
seen by them.

## A claim about when a change reaches production

**A claim about when a merged change reaches production** ("from the next deploy") **is read from
the latest production deploy first**, in a repo the GitHub collector read:

1. Its newest successful GitHub deployment to production. The list has no status filter and comes
   newest first, so walk it:
   `gh api -X GET "repos/<owner/name>/deployments" -f environment=production -f per_page=10`, and
   for each deployment in turn read
   `gh api -X GET "repos/<owner/name>/deployments/<id>/statuses" -f per_page=1` (its latest
   status). Take the first whose latest status is `success`: a newer one that failed or is still
   queued or in progress is skipped, never compared. The environment may be named `Production`.
2. With no successful deployment found, the newest successful run of the deploy workflow on the
   repo's default branch (§0 Default branch, `desk-env get default-branch`;
   `gh workflow list --repo <owner/name>` names the workflow):
   `gh run list --repo <owner/name> --workflow <file> --branch <default> --status success --limit 1 --json headSha,updatedAt`.

The change is live when that deploy's commit contains the PR's merge commit
(`gh pr view <n> --repo <owner/name> --json mergeCommit`, then
`gh api "repos/<owner/name>/compare/<merge sha>...<deploy sha>" --jq .status` is `ahead` or
`identical`). Then its line says it is live and since when, never "from the next deploy"; only a
merge the latest deploy does not contain is still waiting for one.

When neither read finds a deploy, the line says only that it merged, and the deploy claim goes
under **Check before posting** with why ("no production deployment or deploy workflow run found in
owner/repo").
