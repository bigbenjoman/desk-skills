# Gotchas

Read this when a command in `SKILL.md` or a phase file misbehaves. Each entry explains a failure that is silent
rather than loud: it produces a plausible report, not an error.

Every block below may run in its own shell and inherits nothing. Substitute `<owner>`, `<repo>`,
`<me>`, `<n>` and SHAs **literally**; never `$N` or `$REPO`.

## The sweep query

One GraphQL call fetches the open queue with its files and reviews, so no per-PR round trip is
needed. Interactive only: workers have no `gh api graphql`.

```bash
gh api graphql -f owner=<owner> -f name=<repo> -f query='
query($owner:String!, $name:String!) {
  repository(owner:$owner, name:$name) {
    pullRequests(states:OPEN, first:100, orderBy:{field:UPDATED_AT, direction:DESC}) {
      pageInfo { hasNextPage }
      nodes { number title isDraft headRefOid baseRefName additions deletions
        author { login }
        files(first:100) { nodes { path } pageInfo { hasNextPage } }
        reviews(last:50) { nodes { author { login } commit { oid } submittedAt body } } }
    }
  }
}' | jq --arg me '<me>' '
  .data.repository.pullRequests.pageInfo.hasNextPage                as $pr_page_truncated
  | .data.repository.pullRequests.nodes
  | map(select(.isDraft | not))                                    as $nd
  | ($nd | map(. as $pr
      | ([$pr.reviews.nodes[]
          | select(.author.login == $me
                   and (.body // "" | startswith("<!-- desk-review:local -->")))]) as $mine
      | . + {
          reviewedAt:      ([$mine[] | select(.commit.oid == $pr.headRefOid) | .commit.oid] | last),
          lastReviewedAt:  ($mine | map(.submittedAt) | last),
          lastReviewedSha: ($mine | map(.commit.oid)  | last),
          rounds:          ($mine | length),
          mine:            ($pr.author.login == $me),
          filesTruncated:  $pr.files.pageInfo.hasNextPage }))       as $tagged
  | { queueTruncated: $pr_page_truncated,
      queued:        ($tagged | map(select(.reviewedAt == null))),
      skipped:       ($tagged | map(select(.reviewedAt != null)) | map({number, title, reviewedAt})),
      totalNonDraft: ($nd | length) }'
```

- **The active account must be §1 GitHub handle** (Phase 0). A wrong account can read an empty queue,
  which looks like "nothing to review". If the query returns no repository, stop and say which
  account was active; never report an empty queue as clean.
- **`-f`, never `-F`.** `-F` coerces a numeric-looking repo name to a number and fails `String!`.
- **`reviews(last:50)`, never `first`.** Reviews come oldest-first; `first:50` drops the newest,
  including yours at the current head, and the PR gets reviewed twice.
- **`. as $pr` is required.** Inside `.reviews.nodes[]`, `.headRefOid` resolves against the review
  node, yields `null`, and matches nothing.
- **Marker, `startswith`, `.body // ""`.** See `phase-1-target.md` for why author-only and substring
  matches are false cleans. `// ""` guards the null body of a reply artefact.
- **`reviewedAt` vs `lastReviewedAt`.** `reviewedAt` only matches the *current* head, so it is the
  skip rule. `lastReviewedAt` is our newest review at *any* head, the baseline for the base-merge
  count. Using `reviewedAt` there makes the check a no-op, because it is null on every PR it is for.
- **`mine`** decides which §3 row governs posting (`pr-self-review-comment` or `pr-review-others`).
- **`filesTruncated`** means over 100 files: the path list is short, the PR under-tiers, and files
  are hidden from the finders. Treat it as oversized and say so.
- **`queueTruncated`** means more than 100 open PRs: the queue read is the 100 most recently updated.
  Say so in the header (`queue truncated at 100`); never present it as the whole queue.
- `first:100` is fetch depth, not `--limit`. Apply `--limit` after filtering and say when it
  truncated the queue.
- **A PR with `filesTruncated`** gets its full list before routing, so the tier and the finders see
  every file: once its worktree is fetched (`phase-1-target.md`),
  `git diff --name-only "origin/<base>...refs/desk-review/pr-<n>"`. Not `gh pr diff --name-only`,
  which fails with `HTTP 406` on any PR over 20,000 diff lines, exactly the PRs this is for.

## Base merges

For each queued PR with a `lastReviewedAt`:

```bash
gh api "repos/<owner>/<repo>/pulls/<n>/commits" --paginate --slurp | jq '[add[] | select(.commit.committer.date > "<lastReviewedAt>") | select(.parents | length < 2)] | length'
```

- **`--slurp` piped to `jq`, never `--paginate --jq`.** `gh` runs `--jq` once per page and prints a
  count per page, so a real commit on page two sits behind a `0` from page one and the PR is skipped.
- **`--paginate` is not optional.** The endpoint pages at 30 and caps at 250; unpaginated, it reads
  the oldest 30 and concludes nothing changed. That is a false skip.
- A merge plus one real commit is a real push. The test is "were they all merges".
- A PR never reviewed goes straight through; do not make the call.
- It catches merges, not rebases. A rebase rewrites committer dates and gets a full round, which is
  the safe direction.

## Tiering

Paths are tested in this order: excluded (docs, assets, generated), then test, then HIGH, then MEDIUM.

```jq
def SKIP: "(^|/)(docs?|\\.belmont|\\.planning|\\.plans|\\.agents|\\.claude|node_modules|dist|build|\\.next|\\.venv|vendor|__snapshots__)/"
        + "|\\.(md|mdx|txt|rst|png|jpe?g|gif|svg|webp|ico|pdf|csv|parquet|lock)$"
        + "|(^|/)(pnpm-lock\\.yaml|package-lock\\.json|yarn\\.lock|uv\\.lock|poetry\\.lock|bun\\.lockb?)$";
        # bun.lockb is listed as a lockfile name to skip, not a toolchain choice (porting check).
def TEST: "(^|/)(specs?|tests?|__tests__|e2e|testing|fixtures|__mocks__|storybook)/"
        + "|\\.(spec|test|stories|e2e)\\.[cm]?[jt]sx?$|(^|/)test_[^/]*\\.py$|_test\\.(py|go)$|(^|/)conftest\\.py$";
def HI:   "(^|/)(middleware|proxy)\\.[cm]?[jt]s$|(^|/)app/api/|(^|/)pages/api/"
        + "|(^|/)(routers?|routes|handlers|endpoints|controllers|resolvers)/"
        + "|(^|/)(auth|authn|authz|oauth|sessions?|permissions?|rbac|policies|rls)(/|\\.[a-z]+$)"
        + "|(^|/|[-_])(auth|authn|authz|oauth|permissions?|sessions?)[-_.]"
        + "|(payment|billing|stripe|checkout|invoice|payout|ledger|refund|subscription|webhook)"
        + "|(^|/)(migrations|alembic)/|(^|/)schema\\.prisma$|(^|/)\\.env";
def MED:  "(^|/)(server|lib|libs|services?|hooks|api|core|domain|backend|models?|repositories|db|flows|jobs|lambdas?|workers?|pipelines?)/"
        + "|(^|/)\\.github/workflows/|(^|/)(infra|infrastructure|terraform|cdk|deploy)/|\\.tf$"
        + "|(^|/)Dockerfile|docker-compose|compose\\.ya?ml$|(next|vite|webpack)\\.config\\.|turbo\\.json$"
        + "|(^|/)(package\\.json|pyproject\\.toml|vercel\\.json|serverless\\.ya?ml)$";

.queued
| map(. + {tier:
    ( [.files.nodes[].path] as $all
    | ($all | map(select(test(SKIP; "i") | not))) as $code
    | ($code | map(select(test(TEST; "i") | not))) as $prod
    | (.additions + .deletions) as $lines
    | if   ($prod | any(test(HI; "i")))                          then "HIGH"
      elif ($prod | any(test(MED; "i"))) or ($lines > 300)       then "MEDIUM"
      else                                                           "LOW" end ) })
```

Then add §4 Infra and security owner paths and §4 Merge holds globs (`desk-env list merge-holds`): any production path matching
one raises the PR to HIGH. They are globs, so test them with the shell's matcher or `git ls-files`,
not the regexes above.

Constraints behind the patterns, each found against real repositories:

- **Docs and planning go first.** Planning tools keep files like `.belmont/features/auth-pages/PRD.md`
  and `migrations/ARCHIVE.md`. Without `SKIP`, a documentation change reads as auth plus migration
  and tiers HIGH.
- **Migrations by directory, never bare `\.sql$`.** dbt models are `.sql` too (`dbt/models/…`) and
  are not schema changes. Alembic lives under `alembic/versions/` or `migrations/versions/`, raw SQL
  under `migrations/`; both are covered by the directory match.
- **Python tests have three shapes**: `tests/…`, `test_x.py`, and `x_test.py` next to the code. Miss
  one and a test file raises the tier.
- **Payment words are unanchored on purpose.** A presentational `PaymentSummary.tsx` goes HIGH and
  costs one extra agent; anchoring to a server directory misses repos whose money code lives
  elsewhere (`app/flows/handlers/subscriptions.py`). Over-tiering is the cheap direction.
- **A filename says auth only at a word boundary**: `auth.py`, `require-auth.ts`, `session_store.py`
  match; `AuthorCard.tsx` must not. An auth *directory* is HIGH wherever it sits, including
  `components/auth/`, since UI there usually carries the sign-in flow.
- **`\.env` fires on `.env.example`**, which is intended: the example is the environment contract.
- **Anchor with `(^|/)`, never a leading `/`**, or a repo-root path and a nested one tier differently.

The security finder fires on `$prod` (test-excluded), the same set HIGH is computed from.

## Bot comments

```bash
gh api "repos/<owner>/<repo>/pulls/<n>/comments" --paginate --jq \
  '[.[] | select(.user.type == "Bot" or (.user.login | test("\\[bot\\]$")))
        | {path, login: .user.login,
           start_line: (.start_line // .original_start_line // .line // .original_line),
           line: (.line // .original_line), body}]'
```

- **`pulls/<n>/comments`, not `issues/<n>/comments`.** The issues endpoint holds only a bot's summary
  ("No actionable comments… 🎉") while its line findings sit on the pulls endpoint. Reading the wrong
  one reports as new a finding a bot already raised.
- **Match on `type == "Bot"` or a `[bot]` suffix**, never a hardcoded name: REST says
  `coderabbitai[bot]`, GraphQL says `coderabbitai`, and a hardcoded spelling silently matches nothing.
- **Positional overlap.** Same path, and the finding's line inside the inclusive
  `[start_line, line]`. `.line` is null once a hunk moved, hence the `original_*` fallbacks. Never
  match on prose: a bot's wording never resembles a finder's.

## Posting

Interactive: one review, body and inline comments together, so a partial post cannot happen. Write
the payload to the scratchpad, then:

```json
{
  "commit_id": "<full headRefOid>",
  "event": "COMMENT",
  "body": "<!-- desk-review:local -->\n<!-- desk-review:verdict v=1 sha=… -->\n…",
  "comments": [
    { "path": "apps/api/routes/invoices.py", "line": 67, "side": "RIGHT", "body": "**P0** …" }
  ]
}
```

```bash
gh api "repos/<owner>/<repo>/pulls/<n>/reviews" --method POST --input <scratchpad>/review.json
```

- **`event` is `COMMENT`**, always. Never `APPROVE`, never `REQUEST_CHANGES`.
- **An inline comment must sit on a line in the diff** (`side: RIGHT` for added or context lines).
  One that does not makes GitHub reject the whole review with `422 Line could not be resolved`. Move
  that finding to the body's *Additional findings* and post again; never drop it.
- **`commit_id` pins the review to the reviewed SHA.** If the head moved during the run, the
  comments land on the old commit, which is correct: the verdict attests that SHA.

Worker, or when `gh api` is not allowed: `gh pr review <n> --repo <owner>/<repo> --comment
--body-file <file>`, with every finding in the body. `--repo` is required, or the PR resolves from
the current directory's remote. An empty `<n>` does not fail; it posts to the current branch's PR.
