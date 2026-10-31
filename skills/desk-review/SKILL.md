---
name: desk-review
description: >-
  Use when reviewing a branch, a PR or the open PR queue in this repo before a human does: "review
  my branch", "review this PR", "review #460", "what needs reviewing", "sweep the open PRs",
  "/desk-review". Finds P0, P1 and P2 only, against this repo's review bar, in read-only finder
  subagents routed by path, plus codex reading the diff cold. The other vendor refutes each finding:
  codex refutes Claude's, Claude refutes codex's. A tested script computes the verdict. Checks the diff
  against its ticket in both directions: work it is missing, and work nothing asked for. Posts one
  COMMENTED review with a machine-readable verdict where config allows. It is also the §4 Local
  review command desk-ticket, desk-review-response and autopilot workers run at Stage 4b.
---

# desk-review

A local code review that reports only what matters, and says so when it finds nothing.

```
target → route by path → read-only finders + codex cold → cross-vendor refutation
       → ranked findings + requirement gaps → verdict.mjs → report → post (where allowed) → confirm it landed
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

### Which review bar

The bar is the one **at the reviewed commit**, `<TIP>` (Phase 1), never the current checkout's copy
and never one remembered from an earlier run. A branch moves its bar with its code, and a PR is
judged by the bar its own commit carries:

1. §4 Review bar names a repo-relative path, and it exists at `<TIP>`
   (`git cat-file -e <TIP>:<path>`): the bar is `git show <TIP>:<path>`, **repo**.
2. Otherwise, or with the row `default`, it is `references/review-bar.md` beside this SKILL.md,
   **default**. When the reviewed repo itself ships that file (desk-skills does, at
   `skills/desk-review/references/review-bar.md`), read it at `<TIP>` the same way, so a PR that
   changes the bar is reviewed against its own copy.

**One exception: someone else's PR that changes the bar's file.** The author must not write the
rules their PR is judged by, so the bar is then read at `origin/<base>` instead (`git show
origin/<base>:<path>`), and the header line ends `· changed by this PR, base copy used`. On your own
branch or PR the changed copy is the bar, as above: a branch that edits its own bar is reviewed
against it.

The header names which bar ran and the commit it was read at:
`bar: repo <path>@<short sha>`, `bar: default@<short sha>` or `bar: default@installed`. Every
finder, Bea and codex get the same text.

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

## Phases

Each phase's rules are in its own file under `references/`. **Read a phase's file when the review
reaches it.** The phases overlap, so some are read together: Phase 3 dispatches Bea (Phase 5) in the
same message as the finders, and its codex cold call follows Phase 4's quoting rules, so read all
three at Phase 3. This file holds what every phase needs: the config, the bar, the entry points,
every seat's prompt, the round rules and the verdict.

| # | Phase | Read at its start |
|---|---|---|
| 0 | Preflight | `references/phase-0-preflight.md` |
| 1 | Target | `references/phase-1-target.md` |
| 2 | Route | `references/phase-2-route.md` |
| 3 | Find | `references/phase-3-find.md`, with `references/phase-5-requirements.md` and `references/phase-4-refute.md` |
| 4 | Refute | `references/phase-4-refute.md` |
| 5 | Requirements | `references/phase-5-requirements.md` (dispatched at Phase 3) |
| 6 | Report | `references/phase-6-report.md` |
| 7 | Post | `references/phase-7-post.md`, after *The verdict* below |

**A phase file you cannot read stops the review.** If the file for the phase you are starting is
missing or empty, stop and name it by its full path; never run the phase from memory or from an
earlier copy of this skill. `/desk-update` reinstalls it.

## Every seat's prompt

Each Claude prompt carries, in order:

1. **Read-only.** No Edit, no Write, no git state changes, no `gh pr review`, no `gh run rerun`;
   fixes described in prose only. A finder once posted its own verdict and turned a gate green.
2. The review bar **verbatim**, as resolved at `<TIP>` (*Which review bar*). Then §4
   *What review here consistently asks for*, as this repo's house asks. **The bar's definitions
   win, and the `FINDING` block is the output format**: not Lena's `## Review Summary`, not
   Nadia's findings table or verdict, and never `P3`.
3. The diff command, substituted literally: branch `git diff "origin/<base>...HEAD"`; PR
   `git diff "origin/<base>...refs/desk-review/pr-<n>"` after `git fetch --quiet origin <base>`.
   **From round 2, the fix range instead**: branch `git diff "<since>..HEAD"`, PR
   `git diff "<since>..refs/desk-review/pr-<n>"` (*Round 2 and above*). Bea alone keeps the whole
   range.
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
severity: P0 | P1 | P2 | PREMISE
file: <path>:<line>
title: <one line>
detail: <what breaks, or what this duplicates and where the original lives>
evidence: <file:line citations from the actual code>
suggested_fix: <specific change, or "none">
```

## Rounds

### Re-reviews (round 2 and above)

A fresh agent runs a first pass by default, finds a different set of small things, and the author
watches "do X" become "do Y" and back. So on round 2+, every finder prompt, codex's brief included,
adds:

1. **Read our earlier review threads before the diff**: what was raised, what the author did, what
   they said (`gh pr view <n> --comments`).
2. **An addressed finding is settled**, even if a different fix would also have worked.
3. **Raise no new P2s.** Confirm the P0s and P1s are fixed and catch what the fixes broke. A P0 an
   earlier round missed still counts. **Earlier findings the author has neither fixed nor answered
   are carried forward** and stay in this round's counts: the verdict counts what is outstanding at
   this head, not only what this round found.
4. **`NO FINDINGS` is the expected ending.** If the history shows the same ground covered round after
   round, say so in the report: that needs a human, not another lap.

### Round 2 and above: the fix range, and only P0 and P1 block

By round 2 the branch has been read whole once. What is left unreviewed is the fixes, so from round
2 the finders, codex's cold read included, read **only the commits since the previous round**:

```bash
git diff <previous round's reviewed SHA>..HEAD     # never origin/<base>...HEAD from round 2
```

The previous round's SHA is the `sha=` of the last verdict on the PR, or, before a PR exists
(desk-ticket Stage 4b), the SHA that round reviewed. It goes in the results file as `since`, the
header names the range (`fix range <since short>..<head short>`), and verdict.mjs refuses a results
file from round 2 on without it. An empty range is a stated stop, as an empty diff is. Earlier findings
still carried forward (rule 3 above) stay in the counts whatever the range. **The requirements seat
still reads the whole branch** (`origin/<base>...HEAD`): criteria are met by the whole change, and
judged against a few fix commits most of them would read as unmet.

**From round 2 a P2 can be carried** instead of blocking: `"carried": true` on its finding, which
takes it out of `p2` and counts it on the carried line instead. Carry a P2 when fixing it would mean
another round. A P0 or P1 is never carried; verdict.mjs refuses one, naming the finding, and a P2 on
round 1 is fixed rather than carried. A carried finding needs `where` as `file:line`.
`node verdict.mjs --carried <results>` prints the PR body's `### Carried review findings` section,
one `file:line` per finding (desk-pr places it).

## The verdict

**The body's first three lines are computed, never written by hand**: the review marker, the
verdict marker and the heading, and from round 2 a fourth, the carried line. A hand count is how a
review reads clean when it is not. Once every finder and refuter has answered, write the run's
results with the Write tool to `<scratchpad>/desk-review-results.json` (a worker:
`desk-review-results.json` at its worktree root, removed at the end with `git clean -f`):

```json
{ "sha": "<full reviewed SHA>", "round": 1, "gaps": 0, "skipped_files": 0,
  "seats": [ { "role": "correctness", "agent": "lena-code-reviewer", "vendor": "claude", "status": "ran" },
             { "role": "codex", "vendor": "codex", "status": "ran" } ],
  "findings": [ { "id": "F1", "seat": "correctness", "severity": "P1", "where": "src/a.ts:12",
                  "result": "CONFIRMED", "refuted_by": "codex", "deferred": false } ] }
```

- `seats`: every seat dispatched, Bea and simplicity included, each `ran` or `died` (Phase 3).
- `findings`: every finding any seat raised, kept even when `REJECTED` or `DUPLICATE`, with its
  refutation `result` and who refuted it (`refuted_by`, absent when `UNREFUTED`). Scope findings
  are Bea's (`"seat": "requirements"`); `PREMISE` findings carry no result. `deferred: true` for a
  finding deliberately left unfixed; `carried: true` for a P2 carried from round 2 (above). A
  merged duplicate is `"result": "DUPLICATE"` with `duplicate_of` naming the finding kept, and it
  still counts unless that one is counted at the same severity or higher: merging must never drop a
  confirmed finding behind a rejected one.
- `gaps`, `skipped_files`: the open requirement gaps and the files the oversized cap skipped. Every
  count is required, `0` when there are none: one left out is refused, never read as zero.
- `since`: from round 2 on, the full SHA the previous round reviewed (the fix range's start).

Then:

```bash
node ~/.agents/skills/desk-review/bin/verdict.mjs <results>
```

`<results>` is the file's full scratchpad path, or `desk-review-results.json` in a worker (run from
its worktree root). `$DESK_SKILLS_DIR` goes in place of `~/.agents/skills` where it is set
elsewhere. It prints the three lines (four from round 2) and refuses (exit 2) any results file that
is incomplete or contradicts itself. Its tests, `tests/test_review_verdict.mjs`, prove that no
combination with an open finding, a skipped file, a dead seat or an open gap prints the clean
verdict. Use its output verbatim, then the report below it. The clean form, which the tests hold
this line to:

```
<!-- desk-review:local -->
<!-- desk-review:verdict v=1 sha=<full reviewed SHA> p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex-cross round=1 -->
**desk-review, round 1: No P0, P1 or P2 findings at `<short sha>`** · codex read the diff cold · refuted cross-vendor
```

| Field | Meaning |
| --- | --- |
| `sha` | The full SHA the finders read, equal to the PR head when posted. It attests that commit and no other |
| `p0` `p1` `p2` | Findings **outstanding at this head**: `CONFIRMED` or `UNREFUTED`, deferred ones included, except P2s carried from round 2, which count only on the carried line. One raised and already fixed in this SHA is not in the results file |
| `deferred` | Findings deliberately left unfixed, any severity (also counted in their `p` field). A body reading "clean" that defers one is `deferred=1` |
| `gaps` | Open requirement gaps, excluding `UNVERIFIED CODE CLAIM` ones (never posted) |
| `unrefuted` | Findings whose refutation did not run (also counted in their `p` field, or on the carried line when carried) |
| `partial` | Reviewable files skipped by the oversized cap, plus every seat that died; non-zero is never clean |
| `vendor` | `codex-cross` only when codex read this head cold on this run **and** every finding was refuted by the other vendor; else `same-vendor` |
| `round` | The round this review is |

From round 2 a fourth line follows the heading, `<!-- desk-review:carried v=1 p2=<n> since=<full SHA> -->`:
the P2 findings carried (counted there, **not** in `p2`) and the fix range's start. It never decides
clean; the blocking counts above do. It sits after the heading rather than in the verdict line
because repos commit their own copy of the gate, and a copy from before carrying matches the verdict
line exactly: an extra field there would read as no verdict at all. That copy reads this verdict as
the blocking counts say (`tests/test_review_gate.mjs` holds it to that).

With these markers §4 Clean review verdict for this skill is
`p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0`.
`deferred` earns its place: prose that opens "no findings" and defers one further down reads as clean
to a human skimming and to any regex over the summary.

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
| Writing the verdict marker or heading by hand | `bin/verdict.mjs` on the results file |
| `vendor=codex-cross` on a run where codex only refuted, or never ran | Codex read the diff cold, or the run is `same-vendor` |
| A finder that errored left out of the results | `"status": "died"`, counted in `partial` |
| The bar read from the current checkout or an installed copy | The bar at `<TIP>` (at the base on someone else's PR that changes it), named in the header |

## References

- `references/phase-<n>-*.md`: each phase's rules (*Phases* above).
- `references/review-bar.md`: the default bar, and how a repo supplies its own.
- `references/gotchas.md`: the sweep query, tiering patterns, base-merge count, bot comments, and the
  single-call review post. Read it when a command misbehaves.
- `bin/verdict.mjs`: the review marker, verdict marker and heading from the results file, tested by
  `tests/test_review_verdict.mjs`.
