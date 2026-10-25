# desk-review Phase 1: target

Read when the review reaches Phase 1. The config, the bar, the entry points, every seat's prompt,
the round rules and the verdict are in `../SKILL.md`, already loaded; a "below" or "above" this file
does not hold points there or to another phase's file. Paths such as `references/gotchas.md` are
from the skill's directory.

## Phase 1: target

**Branch (the default).** Diff against the branch's **base**, never `@{upstream}`:

```bash
gh pr view --json number,baseRefName,headRefOid,title,body
git diff --stat "origin/<base>...HEAD"
```

`<base>` is the PR's `baseRefName`, or §0 Default branch when there is no PR. **The reviewed SHA
is `git rev-parse HEAD`**, not the PR's `headRefOid`: a review run before a push (desk-ticket
Stage 4b, desk-review-response's fix round) reads commits the PR does not have yet. Phase 7 posts
only when the two are equal. `gh pr view` with no
argument resolves the current branch's PR; **do not add `--repo`** there, or it demands a PR
argument. Once a branch is pushed its upstream is its *own* remote branch, so `@{upstream}...HEAD`
is empty and the run would report clean on a branch it never read.

**An empty diff is a stated stop, never a clean review.**

**A PR.** `gh pr view <n> --repo <owner>/<repo> --json number,author,baseRefName,headRefOid,title,body,isDraft,files,additions,deletions,closingIssuesReferences`.
(`additions` and `deletions` feed the >300-line tier rule; without them it is `null` and never fires.)
Someone else's PR needs §3 `read-others`; without it, stop and say so.

**A PR is reviewed in its own detached worktree**, never the current checkout: finders read callers
and codex reads the cited files, and the current checkout is some other revision, so both would judge
code the PR does not contain. Fetch into a per-PR ref (never the shared `FETCH_HEAD`, which parallel
sweep fetches overwrite):

```bash
git fetch --quiet origin "+pull/<n>/head:refs/desk-review/pr-<n>"
git worktree add --detach <scratchpad>/desk-review-pr-<n> refs/desk-review/pr-<n>
```

Confirm `git -C <that worktree> rev-parse HEAD` equals `headRefOid`; that SHA is the reviewed SHA
and `<TIP>`. Finders get the worktree path as their working directory, and codex gets
`--cd <that worktree>`. Remove it at the end (`git worktree remove --force <path>`, then
`git update-ref -d refs/desk-review/pr-<n>`). If the fetch fails the PR is `ERRORED`, never reviewed
from the wrong tree.

**A sweep** (interactive only) is one GraphQL query for the whole queue, then a filter that skips
every PR already carrying our review at its current head. `references/gotchas.md#the-sweep-query`
has the query, the jq, and why each part is written as it is. The two rules that matter:

- **Match our review by the marker at the start of its body, never by author alone.** Replying to
  an inline comment makes GitHub record an empty `COMMENTED` review under your name, so an
  author-only match reads a PR you only replied on as reviewed: a false clean at batch scale. Match
  with `startswith("<!-- desk-review:local -->")`, never a substring or regex, because a follow-up
  opens with `<!-- desk-review:reply -->` and a body that quotes the marker would also match.
- **A base-branch merge is not a change.** For a queued PR we reviewed before, count the commits
  since our last review that have fewer than two parents (`gotchas.md#base-merges`). Zero means
  only merges of the base landed: drop it and report `SKIPPED — only base merges since <sha>`. This
  filters the sweep only. A PR someone names, and the current branch, are always reviewed.

**Round.** Count our marker reviews already on the PR (the sweep query returns `rounds`; for one PR,
`gh pr view <n> --json reviews` and count bodies starting with the marker). The round about to run
is that count + 1; a branch with no PR is round 1. **A caller running its own loop before the PR
exists** (desk-ticket Stage 4b) passes the loop's round and, from round 3, the SHA the previous round
reviewed: use those instead, or round 3 never happens there. Phase 3 needs it.

**Oversized** (>2,000 changed lines, >80 files, or a file list the API truncated): review the
highest-risk files and **name the ones skipped**. Never cap silently. The count of skipped
reviewable files is `skipped_files` in the results file (Phase 7), which counts it in the verdict's
`partial`, and a partial review is never clean. Always skip generated files,
lockfiles, snapshots, vendored code and build output.
