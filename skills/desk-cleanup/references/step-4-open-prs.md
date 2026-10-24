# desk-cleanup step 4: Open PRs

Read at the start of step 4. The config, ownership, the order, the precondition, what is never touched, the confirmation and the red flags every step shares are in
`../SKILL.md`, already loaded.

## 4. Open PRs — the user's only

**Update a branch only where it is actually needed.** Read §4 Branch protection, and verify it live
with the calls in desk-clearance's `references/repo-facts.md`: where the default branch does not
require branches to be up to date, being behind never blocks a merge.

Update when the PR is **behind the default branch** *and* either conflicting (`mergeStateStatus:
DIRTY`), or its CI last ran against a default branch that has since changed files it touches, or the
branch must be up to date and the PR is otherwise ready. Otherwise report and leave alone.

When updating, **never rebase locally and force-push.** Use server-side `gh pr update-branch
--rebase <n>` under §3 `pr-update-branch` (a branch touching `.github/workflows/**` needs the
`workflow` token scope). A `DIRTY` PR goes to `desk-clearance`, whose `pr-conflict-*` rows apply.
- **Run §4 Typecheck after any update**, even a clean one — a hunk that auto-merges can still
  reference a symbol the other side removed. §4 Typecheck `none`: say the update is unverified.
- **A PR stacked on a branch that has since squash-merged is not a rebase job.** It conflicts with
  the default branch even where content is identical, and it may still track the parent's gitignored
  files (`git ls-files -ci --exclude-standard`), which only surface once the base is retargeted.
  Report it and hand it to `desk-clearance`.

### Ready-to-merge report

For each open PR of the user's: required check state · standing `CHANGES_REQUESTED`? · behind by N ·
`mergeStateStatus` · ready.

**Report readiness; never merge** — that is `desk-clearance`'s job, under config §3. Read the bar
from the platform, not memory or the config row:

- The required contexts are whatever the ruleset's `required_status_checks` and the branch's
  classic protection list (`gh api repos/<repo>/rules/branches/<default branch>` and
  `gh api repos/<repo>/branches/<default branch> --jq .protection`). §4 Required checks records
  them; if it disagrees, say so and suggest `/desk-setup`. Nothing required and the row `none`:
  every check on the PR must be green, and a PR with no checks is not green.
- Required approvals and `dismiss_stale_reviews_on_push` come from the same places (§4 Branch
  protection). Where no approval is required, an `APPROVED` review is not needed; where stale
  approvals are not dismissed, it is not evidence it covers the current head. Whether this user
  merges without one is config §3 `pr-merge-green`.
- A standing `CHANGES_REQUESTED` blocks where the platform enforces it (`mergeStateStatus:
  BLOCKED`), and is reported as not ready everywhere, protected or not.
- Fetch reviews with `gh api --paginate`. Without it `gh api` returns 30 rows silently, which
  can hide a PR's 35th review — the approval — behind a stale `CHANGES_REQUESTED`. Treat
  any result of exactly 30 as truncated.
