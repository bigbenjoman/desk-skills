# desk-review Phase 7: post

Read when the review reaches Phase 7. The results file, `verdict.mjs` and the verdict line it
prints are in the core's *The verdict*; this file is where the review goes and how to confirm it
landed. The config, the bar, the entry points, every seat's prompt and the round rules are in
`../SKILL.md`, already loaded; a "below" or "above" this file does not hold points there or to
another phase's file. Paths such as `references/gotchas.md` are from the skill's directory.

## Phase 7: post

**Who may post where** is config §3, and it is a per-PR decision:

| The PR is | Row | `yes` | `ask` | `no` or missing |
| --- | --- | --- | --- | --- |
| yours (author is `<me>`) | `pr-self-review-comment` | post | ask before posting | report only, and say so |
| someone else's | `pr-review-others` | post | ask before each post (a sweep asks one question listing every PR, answered per PR) | report only, and say so |

`--no-comment`, or nowhere to land (a range, a file, a branch with no PR), also means report only;
say which. So does **a reviewed SHA that is not the PR's head** (`git rev-parse HEAD` ≠
`headRefOid`, usually because the fix is not pushed yet): print the report, and post it after the
push, once `headRefOid` equals the reviewed SHA. Never stamp a verdict on a commit the finders did
not read. **Before posting to more than 3 PRs in one run, print the list and ask**, whatever §3
says: the row settles whether to post, this settles how many. **Never `--approve`, never
`--request-changes`, never an `APPROVE` or `REQUEST_CHANGES` event.**

**A follow-up** ("fixed in `<sha>`") opens with `<!-- desk-review:reply -->` and carries **no
verdict**: it posts at a head nothing reviewed, and a review marker there would be a false clean.
**Never post a second verdict at a SHA that already has one with different counts.** A wrong count
needs a new run, because a gate reads the newest verdict and a re-count is indistinguishable from
editing the result until it passes.

**A clean run posts too**: "No P0, P1 or P2 findings at `<sha>`, N files, refuted by codex". Absence
of a review then means *not reviewed*, unambiguously, and the next sweep's skip rule reads it.

**Where each thing goes:**

- **P0 and P1 on a line inside the diff: inline**, next to the code, in the same review as the body.
- **P2, scope findings of any severity, requirement gaps**, and anything outside the diff: the body,
  under their own headings. Nine inline P2s bury the one P0.
- **`UNVERIFIED CODE CLAIM` gaps never reach GitHub** in any form.

Interactive: one call posts the body and its inline comments as a single review
(`references/gotchas.md#posting` has the JSON). In a worker, which has no `gh api` and writes only
inside its worktree, everything goes in the body, written to `desk-review.md` at the worktree root
after the finders are done, and removed afterwards with `git clean -f desk-review.md`:

```bash
gh pr review <n> --repo <owner>/<repo> --comment --body-file desk-review.md
```

Every placeholder is substituted **literally**, never a shell variable: `gh pr review ""` does not
fail, it resolves the PR for the current branch and posts the review on an unrelated PR, publicly.

### Confirm it landed

A `gh` exit code is not evidence. Count our marker reviews **at the reviewed SHA**, before posting
and again after; the second count must be one higher:

```bash
gh api "repos/<owner>/<repo>/pulls/<n>/reviews" --paginate --slurp | jq '[add[] | select(.user.login=="<me>") | select(.commit_id=="<sha>") | select((.body // "") | startswith("<!-- desk-review:local -->"))] | length'
```

**`--paginate --slurp` piped to `jq`, never `--paginate --jq`**: `gh` runs `--jq` once per page, so
a PR with more than one page of reviews prints several counts, and the before/after comparison reads
the wrong one. `--slurp` refuses `--jq`, hence the pipe.

A worker has no `gh api`. It reads the GraphQL shape, whose field names differ (`author.login`,
`commit.oid`), and a copy of the REST filter there counts zero every time and double-posts:

```bash
gh pr view <n> --repo <owner>/<repo> --json reviews --jq '[.reviews[] | select(.author.login=="<me>") | select(.commit.oid=="<sha>") | select((.body // "") | startswith("<!-- desk-review:local -->"))] | length'
```

**No increase means nothing landed**: post once more and say it took two attempts. A count that was
already non-zero before posting means this SHA has a verdict: do not post a second one with
different counts (above). `--paginate` is not optional (without it the newest reviews fall off and
you re-post a review that landed), and compare counts, never `.[-1]` to a string (null on an empty
array, so the check passes quietly). On a sweep, confirm every PR in one loop before writing the
report; a PR still at zero is named, never counted as posted.

### A required check that reads the verdict

If one of §4 Required checks reads this verdict, it may have run before the review landed and
recorded a failure. Re-run it only when **all** hold: the read-back above found the review, the
verdict is clean, a run exists for this head, and §3 `ci-rerun` allows. Then:

```bash
gh run list --repo <owner>/<repo> --commit <headRefOid> --limit 5 --json databaseId,name,conclusion
gh run rerun <run id> --repo <owner>/<repo> --failed
```

**`--failed`, never a bare rerun**, which repeats every green job for no new information.
