---
name: desk-review
description: >-
  Use when reviewing a branch, a PR or the open PR queue in this repo before a human does: "review
  my branch", "review this PR", "review #460", "what needs reviewing", "sweep the open PRs",
  "/desk-review". Finds P0, P1 and P2 only, against this repo's review bar, in read-only finder
  subagents routed by path. A different vendor (codex) then refutes each finding. Checks the diff
  against its ticket in both directions: work it is missing, and work nothing asked for. Posts one
  COMMENTED review with a machine-readable verdict where config allows. It is also the §4 Local
  review command desk-ticket, desk-review-response and autopilot workers run at Stage 4b.
---

# desk-review

A local code review that reports only what matters, and says so when it finds nothing.

```
target → route by path → read-only finders → cross-vendor refutation
       → ranked findings + requirement gaps → report → post (where allowed) → confirm it landed
```

Findings never approve or block. The output is a report plus, where posted, one `COMMENTED` review
carrying a verdict line a required check can read. Acting on it is the author's call.

**Core principle: a false clean is the worst thing this skill can produce.** An empty diff, an
unread file list, a failed fetch, an unresolved agent or an unrefuted finding is never reported as
"no findings". Every check that could not run is named in the report.

## Resolve this repo's config first

```bash
desk-env where        # SLUG=, GH_REPO=, CONFIG=, CREDS=, EXISTS=yes|no
```

Read the `CONFIG` file. `EXISTS=no` means stop: say which slug was looked up and offer
`/desk-setup`. A `TODO` in a §3 row is a `no` (config rule 4), so it makes the run report-only,
never stops it. A `TODO` in any other row this skill needs is not a gap to guess: stop, ask, offer
`/desk-setup`. Then take:

- §0 GitHub repo (`<owner>/<repo>` below) and Default branch (`<default>`); §1 GitHub handle (`<me>`).
- §3 `read-others`, `pr-self-review-comment`, `pr-review-others`, `codex-review`, `ci-rerun`.
- §4 Tracker, Ticket key pattern, Other work id patterns, Required checks, Merge holds, Project
  subagents sync, the **Infra and security owner** paths, **What review here consistently asks
  for**, and the three review rows: **Review bar**, **Review domain experts**, **Clean review
  verdict**.
- §5 Repo instructions: the repo's own files (`CLAUDE.md`, `AGENTS.md`…) win over this skill on
  anything they cover, and every finder is pointed at them.

**A review row missing from an older config is not a stop.** §4 Review bar missing or `default`
means the bar in `references/review-bar.md`; §4 Review domain experts missing or `none` means no
domain finder. Say which default applied in the report header, and offer `/desk-setup` once to add
the rows. Every other missing row follows the config's rule 7: a §3 row missing is `no`.

## Entry points

| Invocation | Behaviour |
| --- | --- |
| `/desk-review` | **Default.** The current branch against its PR base, else `origin/<default>` |
| `/desk-review 460` | One PR (number, `#460` or URL) |
| `/desk-review <base>...<branch>` | A ref range: `git diff <base>...<branch>`, reviewed SHA `git rev-parse <branch>`, report only |
| `/desk-review path/to/file` | One file in full at `HEAD`, every line treated as changed; report only, no scope check, no verdict |
| `/desk-review --sweep` | Every open non-draft PR not yet reviewed at its head |
| `/desk-review --no-comment` | Report only: nothing reaches GitHub |
| `/desk-review --limit N` | Cap the sweep (default 30) |

Strip flags **and the value each consumes** before parsing the target. `--limit 30` removes both
tokens, or the bare `30` is read as PR #30 and the wrong thing is reviewed. `--sweep` and
`--no-comment` consume nothing.

**In an autopilot worker** (your prompt says you are one) only the default branch target runs.
Workers have no `gh api`, no `gh api graphql` and no `VAR=value` command prefixes, so every step
below marks its worker form. A sweep, or a review of someone else's PR, is never a worker's job.

## Phase 0: preflight

Four checks, **before any agent is dispatched**.

**0. A clean tree** (branch target only). `git status --porcelain` must print nothing. The finders
read committed diffs, so an uncommitted fix is never reviewed, and the round-end check below cannot
tell it from a finder's stray edit. Anything listed: stop with "commit first, then re-run". Never
stash or discard it for the author.

**1. Which GitHub account** (interactive; a worker skips this, since `gh auth` is denied to it and
its `gh` is already the user's). `gh auth status --active` and read the account line. It must be §1
GitHub handle. If it is not, stop and tell the user to switch it themselves
(`! gh auth switch --user <me>`). Never run `gh auth switch` for them: it changes their global
state, and a review posted under the wrong account is public. Never use a `GH_TOKEN=… gh` prefix:
workers deny it, and it is the pattern that posts to the wrong PR when a placeholder is empty.

**2. Whether codex may and can answer.** §3 `codex-review`:

- `yes`: probe it. `ask`: ask before this run sends anything to codex (the whole run's
  refutations are one use: one diff, one question), then probe on a yes. `no`: skip the probe; the
  run is same-vendor (below).
- The probe, as **one `codex`-prefixed command**, bounded by your tool timeout (~120s), never by
  `timeout` (absent on stock macOS) and never grown a pipe, `if` or `$(…)` (a worker's `dontAsk`
  refuses a compound command before the shell runs, printing nothing):

  ```bash
  codex exec --sandbox read-only "Reply with exactly: CODEX_OK"
  ```

  Exit 0 with `CODEX_OK` is usable. `codex login status` proves nothing: it reports logged in on a
  seat that is out of usage. Non-zero names the cause (a usage reset date, `at capacity`). **No
  output at all** in a worker means the harness denied a mis-shaped call; if it printed `Reading
  additional input from stdin`, add `< /dev/null`.

**If codex is unusable, or §3 says `no`, stop and ask** (a worker does not ask; it falls back and
says so in `AUTOPILOT_DONE`):

> Codex is unavailable (`<the error>`, or "§3 codex-review is no"), so refutation would fall back to
> `ada-devils-advocate`, Claude checking Claude. A model shares its own vendor's blind spots, so
> more false positives would reach you marked CONFIRMED. Fix it with `! codex login`, or say
> **proceed** to run same-vendor.

On proceed, every finding is tagged `(same-vendor)`, the header says so, and the verdict line
carries `vendor=same-vendor`. A reader cannot tell from the word `CONFIRMED` which kind of check
produced it, which is why the choice is the user's.

**3. Whether the named agents resolve.** Each role below is a desk subagent installed user-level
(`~/.claude/agents/<name>.md`); a repo may override one in `.claude/agents/`. If a role's file is
missing in both places, and §4 Project subagents sync is set, run it once. Anything still missing
falls back to `general-purpose`, and the header says so:
`agents: general-purpose fallback for <roles>`. A fleet that silently became one model checking
itself must never read as a full run.

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
is that count + 1; a branch with no PR is round 1. Phase 3 needs it.

**Oversized** (>2,000 changed lines, >80 files, or a file list the API truncated): review the
highest-risk files and **name the ones skipped**. Never cap silently. The count of skipped
reviewable files is the verdict's `partial`, and a partial review is never clean. Always skip generated files,
lockfiles, snapshots, vendored code and build output.

## Phase 2: route

No agents yet. Everything derives from the changed-file list. `references/gotchas.md#tiering` has
the jq and the path patterns, written to work across TypeScript and Python layouts.

**Tests are excluded first.** Spec, test, story, fixture and snapshot files never raise the tier.

| Tier | Fires on (production paths) |
| --- | --- |
| HIGH | auth, sessions, permissions, middleware; API routes and handlers; payments, billing, ledgers, webhooks; migrations and schema; `.env*`; any path in §4 Infra and security owner or §4 Merge holds |
| MEDIUM | server, service, lib, domain, hooks, backend and data code; CI workflows, infrastructure and build config; or >300 changed lines |
| LOW | everything else |

**Tier is not severity.** The tier decides *how many agents to send*; P0/P1/P2 decide *what a
finding is worth*. A LOW-tier change can carry a P0. Never let the tier cap a severity or bias a
finder. Over-tiering costs one agent; under-tiering hides a file from the specialist, so the
patterns err wide.

| Role | Agent | Fires on |
| --- | --- | --- |
| correctness | `lena-code-reviewer` | always |
| security | `nadia-security-auditor` | any HIGH-tier production path |
| domain | `general-purpose`, told to invoke the skill §4 Review domain experts names | a changed path matching that row's glob |
| api | `theo-api-designer` | API routes, handlers, routers, schemas, serializers, models, migrations, `*.proto`, OpenAPI or GraphQL files |
| tests | `mira-playwright-expert` | test paths, or a HIGH-tier change with no test changed |
| infra | `jim-solution-architect` | CI workflows, infrastructure as code, Dockerfiles, compose files, deploy config |
| frontend | `suki-frontend-architect` | `*.tsx` `*.jsx` `*.vue` `*.svelte` `*.css`, message catalogues |
| requirements | `bea-business-analyst` | a ticket, or an author-written PR description (Phase 5). **Not counted against the fleet cap.** |

| Tier | Fleet |
| --- | --- |
| LOW | correctness only |
| MEDIUM | correctness + the top matched specialist |
| HIGH | correctness + up to **2** matched specialists |

Priority when trimming: **security > domain > api > tests > infra > frontend.**

So a branch review is 1–3 finders, plus one codex call per finding, and none at all when the finders
return `NO FINDINGS`, which is the common case. Keep it there: a review nobody runs because it takes
ten minutes catches nothing. §3b Subagents that may run without asking still applies.

**Domain experts** are why the fleet is not fixed. §4 Review domain experts is one span per rule,
`` `<glob>: <skill>` ``, e.g. `` `apps/api/trading/**: energy-trader` ``. A matching change gets a
finder whose first instruction is to invoke that skill with the Skill tool (where the tool lacks it,
as in an autopilot worker, Read `$DESK_SKILLS_DIR/<skill>/SKILL.md`) and read the references it
routes to, **before** reading the diff, then to report in this bar's scale. A domain error that
moves money, a trade, a valuation or a regulated decision is P0. Adopting the persona from memory is
not loading the skill; say so in the prompt.

## Phase 3: find

Send every finder in one message so they run in parallel; cap ~12 in flight on a sweep.

Each prompt carries, in order:

1. **Read-only.** No Edit, no Write, no git state changes, no `gh pr review`, no `gh run rerun`;
   fixes described in prose only. A finder once posted its own verdict and turned a gate green.
2. The review bar **verbatim**: §4 Review bar's file, else `references/review-bar.md`. Then §4
   *What review here consistently asks for*, as this repo's house asks. **The bar's definitions
   win, and the `FINDING` block is the output format**: not Lena's `## Review Summary`, not
   Nadia's findings table or verdict, and never `P3`.
3. The diff command, substituted literally: branch `git diff "origin/<base>...HEAD"`; PR
   `git diff "origin/<base>...refs/desk-review/pr-<n>"` after `git fetch --quiet origin <base>`.
   Agents run it themselves. Never paste a diff into a prompt. Not `gh pr diff`: GitHub refuses any
   diff over 20,000 lines (`HTTP 406 … too_large`), so a big PR's finders would all error.
4. The changed-file list, and the paths of §5 Repo instructions files (paths, not contents).
5. One paragraph of intent: the PR title and the author-written description, or the branch name.
   Then any copies the description lists under *Not migrated*, quoted, for the bar's *Extracted,
   callers not migrated*. With no author-written description, say so, so the finder reports every
   surviving copy.
6. The round, and on round 2+ the re-review rules below.

**Every behavioural claim needs a `file:line` in real code.** An inference from a name is not
evidence. `NO FINDINGS` is the expected result for most changes and is not a failure.

```
FINDING
severity: P0 | P1 | P2
file: <path>:<line>
title: <one line>
detail: <what breaks, or what this duplicates and where the original lives>
evidence: <file:line citations from the actual code>
suggested_fix: <specific change, or "none">
```

**Finders read the changed files and their direct callers, with two exceptions**, both for claims
about code the diff does not contain. Both search the **reviewed revision**, `<TIP>`: `HEAD` on a
branch, `refs/desk-review/pr-<n>` on a PR (Phase 1). Searching any other tree finds zero, which is a
confident false verdict. If the ref is missing the search could not run: no finding, and say so.

- **Proving duplication.** Before raising one, search for the original **twice**, by likely name and
  by mechanism, because the existing copy is often named differently:

  ```bash
  git grep -n -I -e "<likely name>" <TIP> -- ':!**/node_modules/**' ':!**/dist/**' ':!**/.venv/**'
  git grep -n -I -e "<the mechanism, e.g. Intl.NumberFormat>" <TIP> -- ':!**/node_modules/**' ':!**/dist/**' ':!**/.venv/**'
  ```

  `git grep` with quoted pathspecs, never `grep -r --include=*.ts`: unquoted, zsh expands the glob
  and aborts with `no matches found`, which reads exactly like "no original exists". **No original
  cited at `file:line`, no duplication finding.**

- **Counting consumers** of each new exported symbol, for P1 *Dead on arrival* (zero) and
  *Speculative generality* (one):

  ```bash
  git grep -n -w -e "<symbol>" <TIP> -- ':!<declaring file>' ':!**/node_modules/**' \
    ':!**/*.test.*' ':!**/*.spec.*' ':!**/*.stories.*' ':!**/test_*.py' ':!**/*_test.py' \
    ':!**/tests/**' ':!**/__tests__/**' ':!**/e2e/**'
  ```

  Repo-wide on purpose: a monorepo's consumer usually lives in another package. Zero is *Dead on
  arrival*; one, where the abstraction exists to serve it, is *Speculative generality*; two or more
  is not a finding. **Cite the census** ("one consumer: `apps/web/x.ts:14`"). No census, no finding.

**After the round, `git status --porcelain`.** The tree was clean at Phase 0, so anything listed now
is a finder's edit: save the stray diff to the scratchpad, restore with `git checkout -- <paths>`,
re-run that finder, and say in the report that a round was discarded. Otherwise the refutation confirms findings about code nobody
pushed.

### Re-reviews (round 2 and above)

A fresh agent runs a first pass by default, finds a different set of small things, and the author
watches "do X" become "do Y" and back. So on round 2+, every finder prompt adds:

1. **Read our earlier review threads before the diff**: what was raised, what the author did, what
   they said (`gh pr view <n> --comments`).
2. **An addressed finding is settled**, even if a different fix would also have worked.
3. **Raise no new P2s.** Confirm the P0s and P1s are fixed and catch what the fixes broke. A P0 an
   earlier round missed still counts. **Earlier findings the author has neither fixed nor answered
   are carried forward** and stay in this round's counts: the verdict counts what is outstanding at
   this head, not only what this round found.
4. **`NO FINDINGS` is the expected ending.** If the history shows the same ground covered round after
   round, say so in the report: that needs a human, not another lap.

## Phase 4: refute

**The refuter must be a different vendor to the finders.** One codex call **per finding**, prompt
under ~800 characters, `file:line` named and the mechanism stated flat. Codex reads the file itself;
never paste a diff or ask it to run git. Independent calls may run in parallel.

```bash
codex exec --sandbox read-only 'Refute this code-review finding by reading the code. Reply CONFIRMED with a one-line proof, REJECTED with the reason, or DUPLICATE-OF <n>. If uncertain, REJECTED. <P1> <path:line>: <mechanism in one or two sentences>'
```

- **On a PR, add `--cd <the PR's worktree>`** after `--sandbox read-only`, so codex reads the PR's
  files. The long form, never `-C`, which sits next to the denied `-c`.
- **Single quotes, and plain words inside them.** In double quotes a backtick or `$` in the
  mechanism is command substitution, which makes the call compound and a worker refuses it. The
  worker's deny rules also match the prompt text, so ` -c `, ` -s `, `danger` or `--config` written
  literally (a finding about `bash -c`, or `dangerouslySetInnerHTML`) gets the call denied. Describe
  flags and API names in words: "runs its input through a shell", "sets raw HTML". An apostrophe is
  written as a typographic ’, never `'`.
- **No `-c`, `--config`, `-m` or `-p`.** Desk's harness asks on every one of them and a worker
  denies them. Reasoning effort is set in the user's `~/.codex/config.toml`, not per call.
- **Never offer a benign alternative** ("or is this deliberate?"). Codex rejects when uncertain, so
  the clause flips real findings to REJECTED with no change in the code.
- **An empty, denied or useless reply is `UNREFUTED`**, never REJECTED and never a pass. Retry it
  once with the prompt reworded. Still nothing: the finding stays in the report under its severity,
  tagged `UNREFUTED`, and is counted in the verdict's `unrefuted`. A run with any `UNREFUTED`
  finding is not clean. Dropping it would turn a refuter outage into a clean verdict.
- Same-vendor (agreed in Phase 0): the same prompt to `ada-devils-advocate`, else `general-purpose`,
  every verdict tagged `(same-vendor)`.

The refuter rejects a finding when an existing guard, caller contract, test or framework behaviour
already handles it, or when the repo already records it as known (per the bar's *Never report*) and
the diff leaves the anchored code untouched. **When genuinely uncertain, reject**: a missed issue
costs less than a false positive that burns the author's time.

`CONFIRMED` and `UNREFUTED` findings reach the report; `REJECTED` ones do not. Duplicates merge: keep the clearest write-up and the
union of the evidence. Requirement gaps never enter this phase (Phase 5 owns them).

**Existing bot comments** (interactive, on a PR): tag any surviving finding an automated reviewer
already raised, so the report shows what is new. `references/gotchas.md#bot-comments` has the call;
it is the `pulls/<n>/comments` endpoint, overlap is **positional** (same path, line inside the bot's
range), and overlap is annotated, never dropped. A worker has no `gh api`: skip it and say so.

## Phase 5: requirements

`bea-business-analyst` (else `general-purpose`), dispatched **alongside** the Phase 3 finders. She
reads the ticket and the diff, not their output. **She never writes to the tracker**: no comment,
transition or field edit.

**Find the ticket**, case-insensitively, then in the tracker's case, from the branch name and the PR
title:

```bash
git branch --show-current
```

Match §4 Ticket key pattern against that and the PR title with `grep -oiE`, and upper-case the
result: branches are often lowercase (`fix/abc-123-…`) while keys are not, so a case-sensitive match
silently never fires on a branch. Then fetch:

| What matched | Where the ticket text comes from |
| --- | --- |
| §4 Ticket key pattern, Tracker `jira` | `desk-jira get <KEY>` (needs §3 `read-own-work`, or `read-others` for someone else's ticket) |
| §4 Other work id patterns | `$DESK_STATE/tickets/<KEY>.md` (`desk-env paths` prints `DESK_STATE`) |
| Tracker `none` | the PR's `closingIssuesReferences` (Phase 1), each read with `gh issue view <issue number> --repo <owner>/<repo>`; never the PR's own number |

If nothing matches, or the ticket cannot be read, say so in one line and continue: Direction 1 is
skipped, Direction 2 still runs if there is a description.

**Author-written intent.** Bots and CI often write into the PR *body* (preview links, checklists), so
"the description is non-empty" is almost always true and means nothing. Strip generated blocks
first, then test what is left:

```bash
gh pr view <n> --repo <owner>/<repo> --json body --jq '(.body // "") | gsub("(?s)<!--\\s*[\\w:.-]+\\s*-->.*?<!--\\s*/[\\w:.-]+\\s*-->"; "") | gsub("(?s)<!--.*?-->"; "") | test("\\S")'
```

`false` means no author-written intent (paired generated blocks and every other HTML comment
stripped, only whitespace left). It is one `gh` command, so it runs in a worker too. `gh --jq` is
gojq on Go's RE2, which has **no backreferences**: an opening block is closed by the next
`<!-- /name -->` of any name, never `\k<name>`, which errors. With no PR yet
(Stage 4b runs before one opens) there is no description: intent is the ticket or the branch. With no ticket as well, **Direction 2
does not run**: say "scope not checked: no ticket and no author-written description". Never infer
intent from the diff and mark the diff against it; that always returns clean.

### Direction 1: criteria the diff does not meet

Unmet or partly met criteria only, each quoting the criterion:

```
REQUIREMENT GAP
ticket: <KEY>
criterion: <quoted>
gap: <what the diff does or fails to do>
code_claim: yes | no
```

`code_claim` answers one question: *would this still read as a defect with the ticket deleted?* A
gap marked `yes` is a claim about code that nothing has refuted, so it is **never posted**: it goes
in the terminal report tagged `UNVERIFIED CODE CLAIM`, for the author to judge, and is excluded from
the verdict's `gaps` count. It is not sent to Phase 4 either: that refuter judges against code, not
tickets, and would reject it on procedure.

### Direction 2: diff the criteria do not ask for

Bea's prompt carries the review bar **verbatim**, as the finders' does, because she is now emitting
P1/P2 candidates and needs its definition of stated intent and, above all, its **boy-scout
exemption**, or she files obedience to the repo's own rules as scope creep.

```
OUT OF SCOPE
file: <path>:<line>
what: <what the hunk does>
intent: <the criterion or description line measured against, quoted>
basis: ticket | PR description | branch purpose
```

An out-of-scope hunk whose symbols the Phase 3 census found **no live consumer** for is P1 *Scope
creep with no consumer*; everything else is P2 *Out of scope*. Both are ordinary findings in the
P1/P2 sections, and both post in the **review body, never inline**: a scope call needs the intent
beside it.

## Phase 6: report

Always printed, whether or not it is also posted.

```
branch fix/abc-123-rounding → main · round 1 · 14 files · MEDIUM tier · 2 finders + Bea
bar: default · domain: energy-trader · refuted by codex (cross-vendor)

P0 (1)
 apps/api/routes/invoices.py:67        invoice total rounded per line, then summed

P1 (1)
 packages/core/src/money.ts:12         second currency formatter
                                       — packages/core/src/format.ts:8 is the original

P2 (2)
 apps/web/src/components/Pager.tsx:1   no consumer outside its own story
 apps/api/services/tz.py:31            timezone helper rewritten; traces to no AC on ABC-123 (scope, body only)

REQUIREMENT GAPS (2, 1 unverified)  ABC-123
 AC3: "export includes VAT" — no VAT column in the CSV writer
 AC1: "the cache is keyed per tenant" — UNVERIFIED CODE CLAIM, terminal only, not posted

→ posting to #742
```

The last line says what is about to happen: `→ posting to #<n>`, `→ not posting (--no-comment)`,
`→ not posting: no PR for this branch`, or `→ not posting: §3 <key> is no`.

A sweep reports per PR under one header, and the buckets are **computed by partitioning the queue,
never written by hand**. Findings + clean + errored + merge-skipped equals the queued count; a PR
whose finders errored is `ERRORED`, never `CLEAN`:

```
account: <me> · 23 open non-draft · 1 reviewed at head → 22 queued
tiers: 5 high · 6 medium · 11 low → 31 finders → 21 candidates → 16 confirmed across 5 PRs, 5 rejected
P0 (3)  #460 apps/api/routes/family.py:88  under-13 link skips consent
P1 (4)  #434 packages/core/src/money.ts:14  second rounding rule  [also: coderabbitai]
P2 (9)  #441 (3) · #452 (2) · #460 (2) · #467 (2)
REQ GAPS (2, 1 unverified)  #460 ABC-512 AC2 · #412 ABC-640 AC3 (unverified)
CLEAN (13)    #429 #440 #464 …
SKIPPED (2)   #430 — reviewed at 6ff8e39 · #418 — only base merges since 4c1a80d
ERRORED (0)
```

Then per-finding detail: evidence, suggested fix, and a collapsed `<details>` holding the finder's
reasoning and the refuter's proof. If nothing survives, lead with **"No P0, P1 or P2 findings"**
and one line on what was checked.

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

**The body's first two lines are the markers**, exactly:

```
<!-- desk-review:local -->
<!-- desk-review:verdict v=1 sha=<full reviewed SHA> p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex-cross round=1 -->
```

| Field | Meaning |
| --- | --- |
| `sha` | The full SHA the finders read, equal to the PR head when posted. It attests that commit and no other |
| `p0` `p1` `p2` | Findings **outstanding at this head**. One raised and already fixed in this SHA is `0` |
| `deferred` | Findings deliberately left unfixed, any severity. A body reading "clean" that defers one is `deferred=1` |
| `gaps` | Open requirement gaps, excluding `UNVERIFIED CODE CLAIM` ones (never posted) |
| `unrefuted` | Findings whose refutation did not run (also counted in their `p` field) |
| `partial` | Reviewable files skipped by the oversized cap; non-zero is never clean |
| `vendor` | `codex-cross` only when every refutation really ran on codex; else `same-vendor` |
| `round` | The round this review is |

With these markers §4 Clean review verdict for this skill is
`p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0`.
`deferred` earns its place: prose that opens "no findings" and defers one further down reads as clean
to a human skimming and to any regex over the summary.

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
array, so the check passes quietly). On a sweep,
confirm every PR in one loop before writing the report; a PR still at zero is named, never counted
as posted.

### A required check that reads the verdict

If one of §4 Required checks reads this verdict, it may have run before the review landed and
recorded a failure. Re-run it only when **all** hold: the read-back above found the review, the
verdict is clean, a run exists for this head, and §3 `ci-rerun` allows. Then:

```bash
gh run list --repo <owner>/<repo> --commit <headRefOid> --limit 5 --json databaseId,name,conclusion
gh run rerun <run id> --repo <owner>/<repo> --failed
```

**`--failed`, never a bare rerun**, which repeats every green job for no new information.

## Guardrails

- **Never flag** style, naming, formatting, import order, coverage opinions, "consider extracting",
  or a refactor **you** propose of code the diff does not touch. The test is who wrote it: in the
  diff, judge it; outside, leave it.
- **Never propose a rewrite of working code** the repo's docs justify. Read before simplifying.
- On a `gh` rate limit, back off and name the PRs not reached. Never report them clean.
- A gate that cannot perform its check says so rather than passing quietly: every skipped phase,
  fallback agent and same-vendor refutation is in the header and in anything posted.

## Common mistakes

| Mistake | Instead |
| --- | --- |
| `@{upstream}...HEAD` for a branch diff | `origin/<base>...HEAD`; the upstream of a pushed branch is itself |
| Empty diff reported as clean | A stated stop |
| Skip rule matching the author, or a substring | `startswith` on the marker |
| `grep -r --include=*.ts` unquoted | `git grep` with quoted pathspecs, on the reviewed revision |
| Duplication or dead-code finding with no citation | No original or census at `file:line`, no finding |
| Several findings in one codex prompt, or `-c` on the call | One finding per call, under ~800 chars, no config flags |
| `CONFIRMED` from a same-vendor pass left untagged | `(same-vendor)` on every finding and `vendor=same-vendor` |
| An empty codex reply treated as REJECTED | `UNREFUTED`, reported and counted, never clean |
| Reviewing with uncommitted changes, or stamping `headRefOid` on a local-only commit | Clean tree first; post only when HEAD is the PR head |
| P2 or a scope finding posted inline | Body only |
| Posting an `UNVERIFIED CODE CLAIM` | Terminal only |
| `GH_TOKEN=… gh …` or `$N` in a posting command | Plain `gh` as §1 GitHub handle, values substituted literally |
| A follow-up carrying the review marker | `<!-- desk-review:reply -->`, no verdict |
| Trusting `gh pr review`'s exit code | Read it back and count |

## References

- `references/review-bar.md`: the default bar, and how a repo supplies its own.
- `references/gotchas.md`: the sweep query, tiering patterns, base-merge count, bot comments, and the
  single-call review post. Read it when a command misbehaves.
