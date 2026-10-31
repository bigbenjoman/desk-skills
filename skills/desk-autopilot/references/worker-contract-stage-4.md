# Autopilot worker contract: Stage 4, verify, and Stage 4b, self-review

Part of the autopilot worker contract, read when you reach Stage 4, or before the first suite,
typecheck, lint or build you run at any stage. It binds exactly as the core does.

## 3. Verification must cover what CI covers

### First: every suite is locked and capped, because you are sharing one machine

This rule lives here as well as in `batch-notes.md` because that file gets reset and this one does
not. Where the two disagree, the stricter wins.

A parallel test runner (Jest, Vitest and most others) sizes itself at `cpus - 1` workers by default,
~0.7GB each, with no awareness of the sibling worker, the second batch, or the user's own session
starting the same run a second later. One uncapped run can take the machine from 6GB to nearly 18GB.

**Cap it and lock it every time. Never the bare §4 Unit tests command.** Each item of
`desk-env cmds test-cmd` (and `typecheck-cmd`, `integration-cmd`) is a `DIR<TAB>CMD` pair; run it
under the lock **in its directory with `--cwd`**, never as `cd <dir> && …` (a compound command is
refused and would run unlocked). The cap is config §3b "Test worker cap under the test lock",
appended as `--maxWorkers=<cap>` **only when the command is Jest or Vitest**, in the form §4 Unit
tests gives for passing arguments. Never append it to pytest or any other runner: pytest rejects it
and the suite fails before running (pytest is single-process unless the repo configures otherwise).

```bash
~/.claude/desk/bin/with-lock.sh test --cwd <DIR> -- <CMD> --maxWorkers=<cap> [<spec files>]   # Jest / Vitest only
~/.claude/desk/bin/with-lock.sh test --cwd <DIR> -- <CMD> [<test files>]                      # pytest and every other runner: no --maxWorkers
~/.claude/desk/bin/with-lock.sh test --cwd <DIR> -- <integration CMD> --maxWorkers=<half the cap> <file>   # Jest / Vitest only
~/.claude/desk/bin/with-lock.sh tsc  --cwd <DIR> -- <typecheck CMD>
```

For an item at the root (`<DIR>` `.`), `with-lock.sh test <CMD> …` works as well. The `--` is
optional, and `<DIR>` may also be written as your worktree's absolute path. Write the command
exactly as the row gives it, then your arguments: the allow rule matches that prefix and nothing
else.

Use the lower cap §3b gives (by default half) while `desk-env mem status` shows `avail=` in the hold
band (config §3b "Spawn gate (available memory)"; by default 4–8 GiB), and `1` for a database-backed
integration suite in that band. The lock is what stops two suites landing in the same minute, which
is the case that actually kills the machine. It blocks until it frees and releases on exit,
including on a crash: **do not add a timeout and do not work around a wait; waiting is the
feature.** Blocked over ~20 minutes: say so in your output rather than bypassing it. If
`with-lock.sh` is refused, check headroom, keep the cap, proceed, and **say in your output that you
ran unlocked**.

The typecheck takes the same lock, so typecheck and tests never overlap. Screenshot capture uses
`with-lock.sh browser`: a dev server plus Chromium is hundreds of MB, not ten GB, and should not
queue behind a suite. **Never end your turn with a suite running in the background**: `claude -p`
kills it when the turn ends. A Stop hook blocks your first attempt to, naming the task; a second
attempt ends the turn and your log records the rule as broken.

**Before any heavy stage, read the right number:**

```bash
desk-env mem status   # gate on avail=, never on vmmem= or free's used
```

Under ~4 GiB available, wait and retry rather than starting a suite; a sibling mid-suite will drain.
A brief spike is fine: sustained time up there is what hurts. Never raise the worker count because
the machine looks idle: it looks idle right until two workers hit Stage 4 together, and an OOM takes
every worker, worktree, database and port with it. Your port is assigned in your briefing; never
kill a server you did not start, it is likely another session's.

### Then: the suites themselves

**Before you push, run the pre-push checks and the tests related to your change, not the full
suites.** CI runs the full suites on every push regardless. The pre-push checks are `desk-pr`'s
"Before every push" (`bash scripts/desk/pre-push.sh --head` where §4 Pre-push checks is set). Which
tests to run, `desk-env test-scope` decides from your branch's changes against the merge base with
`origin/<default>`, untracked files included:

```bash
desk-env test-scope   # scope=related|full|none, reason=, changed=, then DIR<TAB>CMD<TAB>FILES per suite
```

Run each suite line it prints under the lock exactly as above, with its FILES (if any) after the cap:
`with-lock.sh test --cwd <DIR> -- <CMD> --maxWorkers=<cap> <FILES>` for Vitest or Jest, `<CMD>` alone
for anything else. `scope=related` runs §4 Related tests through the import graph, plus in full the
§4 Unit tests of any directory holding a changed file that has fewer Related tests items than Unit
tests items; `scope=full` runs
§4 Unit tests, because the change touches a lockfile, a root or test config, a shared workspace
package, or deletes or renames a file (the `reason=` line says which), or §4 Related tests is `none`.
Never narrow a `full` to the files you think matter, and say the scope and reason in the PR's Testing.

**Where your briefing has a `Baseline checks` section**, the batch base already has typecheck or
lint errors, recorded by the orchestrator. Run `desk-env baseline typecheck` and `desk-env baseline
lint` from your worktree in place of §4 Typecheck and Lint: each runs the same items under the same
locks and fails only on errors your branch adds, in any file, naming each (`FAIL`, then
`file:line  rule  message`). Errors are counted per file, rule and message, so a second copy of a
recorded error is new. A `FULL` line means the output could not be read and that check ran in full:
say so in the PR's Testing. Never fix a recorded error your ticket does not need, and never edit a
file outside your ticket to clear one. With no such section, check as above.

`desk-ticket` Stage 4's typecheck + lint + unit tests is **not necessarily** the whole gate. Read
§4 Required checks (and Advisory checks) for what CI runs; where it runs suites that the local
commands do not (an integration suite, a separate test project, structural or registry tests), those
are yours to run too, capped and locked:

- **Structural tests a new or changed entry point trips.** Many repos keep a test that every new
  endpoint, route, procedure or migration must be registered with (a policy classification, an
  allow-list, a permissions map). §5 Repo instructions and §4 What review here consistently asks for
  usually name them. Adding or changing one of those entry points means running that test, and
  choosing its bucket from the guidance the repo gives beside it; anything touching money, outbound
  communication, or another account's sensitive data takes the stricter bucket, not the permissive
  one.
- **Changing an EXISTING symbol (its behaviour, its name, or its location)** → the one test above is
  not enough. Anything in a suite the local commands skip that calls it breaks, and a local
  typecheck/lint/unit run will not tell you, because those callers live outside the project those
  commands cover. Before pushing: `git grep -l '<symbol>'` across those suites' directories and run
  every file it names, capped. A precondition added to an existing entry point can pass everything
  locally and still break pre-existing journeys whose fixtures predate the guard. A rename is the
  same trap by a different route.
- When such a spec fails, the fixture usually predates your change. **Update the fixture so the test
  still exercises its own subject. Never weaken an assertion, skip a test, or relax your change to
  get green**: if a test genuinely asserts behaviour your change made obsolete, park and say which
  test and why.
- **Your database variables.** Every §4 Database URL variable in your worktree's env files points at
  your own per-ticket database when one was made (your briefing names it), and is **blank**
  otherwise (§4 Local database `none`, or §3 `db-per-ticket` not `yes`). Blank is deliberate: it is
  what stands between you and a shared, staging or production database. Never fill it in, never
  copy a URL from another env file or the primary checkout, and never run §4 Database migrate
  without a per-ticket database (it is denied). With your own database, database-backed suites are
  safe to run against it; two integration runs in different worktrees still collide on their
  per-worker schemas, so check nobody else is in one first (the batch notes carry the command) and
  follow §3 `tests-shared-db`. With a blank database, a suite that needs one is a park naming the
  suite, not a skip.

**A CI or end-to-end run you ask for is the narrowest one that covers your change.** Whether you park
asking for a run or run one of the §4 Worker workflows commands your settings allow, the request
names the tag, spec or project to run (a workflow input such as `suite=billing`, a `--grep @billing`,
a spec file, a test project) and gives one line on why that covers the change: which tests exercise
the code you touched. Find them before you ask: `rg -l` the changed component, route or symbol across
the end-to-end directory, then read the tags on the specs it names. For a run you start, you cannot
add or change an input, so narrowest means choosing among the §4 Worker workflows entries as
listed, and the line on why goes in the park on its run id, after the run id.

- **Every test is the exception.** A request for everything (`all`, or no filter) states why nothing
  narrower covers the change, such as a shared layout or config every journey loads. "To be safe" is
  not a reason: a full run on a hosted runner can take over an hour, hang, and cost money, for a
  change two specs cover.
- **A tag the workflow does not offer is said, not widened.** Where the covering tests sit under a
  tag the workflow has no input for (it offers `all`, `smoke` and `auth`, and yours are `@billing`),
  never fall back to everything: say in the park that the workflow does not offer it, name the tag
  that would cover the change (`suite=billing`, or the specs by file), and leave the person to add the
  input or run those specs.

### Self-review — `desk-ticket` Stage 4b

Run §4 Local review command on your branch once the change is verified and **before you capture any
screenshot**. A confirmed finding means a code change, and every shot taken before it is of the old
build. With `none`, Stage 4b is a stated skip: say `review=SKIPPED (none configured)` in
`AUTOPILOT_DONE`, and nothing below about findings or posting applies.

Everything it needs is inside your worktree: where the command is a repo-local skill, the skill
itself, the rubric it reviews against, and the documentation the repo's knowledge check names for
each path.

**The review's agents, finders and codex follow the Stage 3 file**, its last section, "Stage 4b's
review tools" (`worker-contract-stage-3.md`): confirming the named agents are synced, dispatching
finders read-only, and when and how to call `codex`. Read that section before the first finder.

**There is no approval block here**: that gate belongs to a session with a human in it. Instead:

- **P0, P1 or P2 on rounds 1 and 2**: fix it, and say in `AUTOPILOT_DONE` what it was and what you
  did.
- **Then run it again.** Your fix is itself unreviewed code, so only a full round that finds nothing
  has reviewed everything. Keep going until a round comes back reading as §4 Clean review verdict
  (**no P0, no P1 and no P2**, where the review grades that way). Three rounds is the ceiling, and
  round 3 reads **only the fix range**, the commits since round 2's reviewed SHA (`since` in its
  results; `desk-review`'s round-3 rules). With no PR yet the review counts every run as round 1,
  so give it the round of your loop and, from round 3, round 2's reviewed SHA. Say in
  `AUTOPILOT_DONE` how many rounds ran.
- **Round 3, a P0 or P1**: park, naming each finding and its `file:line`. No fourth round.
  **Where config §3 `autopilot-judgement` is `yes`, do not park: it goes to a fix try.** Carry on
  through Stage 7 as for a clean round, open the draft PR, and post the round-3 review on it as below,
  its verdict counting the P0s and P1s at your head and its body listing each with its `file:line`.
  That posted review is the hand-off: the pass sends the draft back to a fix worker (`fix-tries.mjs`
  `reviewFix`, as for any draft whose review finds a P0 or P1), and to the person, naming each
  finding, only once those tries are spent. End with
  `AUTOPILOT_DONE: pr=<n> jira=<status> review=round 3 left <counts> for a fix try`. Leave the PR in
  draft. These are findings handed on, not ones you have understood and left, so posting them is not
  posting a P0 left in place; a P0 you cannot fix still parks (below). Where §3
  `pr-self-review-comment` is not `yes` there is no posted review for the pass to read, so it parks
  as above.
- **Round 3, only P2s**: **carry them, do not park.** Mark each `"carried": true`, so the verdict
  reads clean on the blocking counts and records the number carried, and open the draft PR. Put the
  section `verdict.mjs --carried <results>` prints (`### Carried review findings`, `file:line` each)
  in the body. More than five, with §3 `jira-create` `yes` and a tracker: create one follow-up ticket
  listing them all via `desk-jira create`, and link it from the body instead of the list. Otherwise
  they stay in the body and nothing parks. Name the carried count in `AUTOPILOT_DONE`.
- **A P0 you cannot fix**: park, naming the finding and its `file:line`. Do not push a branch
  carrying a P0 you have understood and left.
- **Do not defer a P2.** A deferral keeps the verdict off clean, and a review gate that reads the
  deferred count fails on any non-zero value, so a deferred finding is a PR that can never merge.
  Carrying is not deferring: it exists only from round 3, only for a P2, and leaves the counts.
  Cost the fix before calling it out of scope: a "restructuring" is often ~30 lines. Fix it where it
  stands. **A fix that grows parks**: one needing a new file other than its own spec, or a file your
  diff does not already touch, is the user's call to widen the PR or split it out, so park naming it.
  So does a fix that needs someone else's decision. Moving equivalent sites onto a helper this PR
  creates or fixes is not growth. Migrate them all, or list each one under *Not migrated* in the PR
  body. Growth means new behaviour, not new call sites.
- **Requirement gaps**: report in `AUTOPILOT_DONE` and in the verdict's gap count, do not act. A gap
  keeps the PR in draft until the user decides; the orchestrator routes it.
- **Nothing found**: say so with the count of files reviewed. It goes in the PR's Testing bullet
  per `desk-pr`, carrying the SHA and any `(same-vendor)` tag.

**Post the report to your PR** where config §3 `pr-self-review-comment` is `yes` (otherwise park
with the report). After `gh pr create --draft`, submit it as one `COMMENTED` review. Where the review
command defines markers, its first line is exactly the command's local-review marker and its second
the verdict marker it emits (the full `headRefOid`, the counts, the vendor and the round count). A
later fix-up reply opens with the command's reply marker and carries no verdict: it posts at a head
nothing has reviewed. **Never post a second verdict at a commit that already has one with different
counts**, and never edit a posted verdict's counts: a gate reads the last one, so a re-count is
indistinguishable from editing the result until it passes. A wrong count needs a new run.

```bash
gh pr review <n> --repo <repo> --comment --body-file <report>
```

**Use the plain form above: never a `GH_TOKEN=… gh pr review …` prefix.** Any `VAR=value cmd`
prefix is denied by the worker permission policy, so the token-prefixed form a review skill may print
is refused *before it runs*. Plain `gh` already authenticates as the user (config §1 "GitHub
handle"). The prefixed form leaves a draft PR carrying **no** review while its `AUTOPILOT_DONE`
reports the review as run. **A refused `gh` call is not a finding about your permissions: strip the
`VAR=` prefix and retry before concluding anything.** If the retry also fails, that is a park.

The code reviewer (config §4 People) reads findings on the PR. A clean run posts too: absence of a
review has to mean *not reviewed*. **Never `--approve` or `--request-changes`**, and never post a P0
you have left in place. After posting, list the PR's reviews (`gh pr view <n> --json reviews`) and confirm exactly one verdict marker
exists at your head.

**The review comment is part of the terminal state.** A PR without it is unfinished: report
`pr=<n> review=NOT POSTED` in `AUTOPILOT_DONE` rather than a bare `pr=<n>`.

**If the local review command does not resolve**, your worktree predates it. Do §4's rebase check
now, and review afterwards. Either way, say in `AUTOPILOT_DONE` whether the review ran; silence reads
as reviewed.

### Handing off: Stages 4b and 7 start in a fresh session

Self-review and the PR stage each start in a new session, so neither pays to re-read the context
the build grew. Hand off at two points, and only at the end of a stage that passed (a stage that
parks parks as before):

- **At the end of Stage 4**, before Stage 4b, unless your session started at Stage 4b or later.
- **At the end of Stage 6**, before Stage 7, unless your session started at Stage 7.

To hand off:

1. **Commit everything** and leave `git status --porcelain` clean: the next session starts from your
   branch in this worktree, not from anything you hold. Do not push.
2. **Write `$DESK_STATE/handoffs/<TICKET>.json`** with the Write tool, holding these fields and no
   others (the orchestrator adds the branch and its commits, and drops anything else):

   ```json
   {"ticket": "<TICKET>", "stage": "<4b or 7>", "criteria": ["<each acceptance criterion, verbatim>"],
    "lane": "<lane>", "verification": ["<each check you ran: command, scope and reason, result>"],
    "review": ["<each self-review finding so far: severity, file:line, outcome and commit; the round and SHA it ran at>"],
    "evidence": ["<the absolute path of each screenshot or log captured>"]}
   ```

   `review` and `evidence` are `[]` when there is nothing yet.
3. **Update your resume file** (`$DESK_STATE/resume/<TICKET>.json`), then print `AUTOPILOT_HANDOFF: 4b` (or `7`) at the start of a line in
   your reply text, never in a code fence, and end your turn. Print no `AUTOPILOT_DONE`: the ticket
   is not done.

The orchestrator then spawns a new session for the same ticket, worktree and branch, with the
handoff in its briefing. **When your prompt says your session starts at a stage**, read that stage's
file and the Stage 3 file (its §6 holds every command form you may run, a dev server's included),
check `git status` and `git log` in your worktree, and carry on from there; an
`AUTOPILOT_IMAGES` an earlier session printed is kept. A task worker (`AUTOPILOT_TASK`) never hands
off.
