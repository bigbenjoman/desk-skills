---
name: desk-kiss
description: >-
  Finds where a change should be smaller and offers to make it smaller, applying each fix the user
  accepts. desk-review already runs its passes on every review. Use when the user says "kiss", "/desk-kiss", "keep it
  simple", "is this over-engineered", "check for scope creep", "is this more than the ticket asked
  for", "did I add an abstraction nothing uses", "too many comments", or a PR carrying a
  `debt:narrative-comment` label. Defaults to the current branch; takes a PR number, branch or ref
  range. Not for correctness, security or whether the code is any good (that is desk-review). Not
  for cleaning up code with no stated intent to measure against (that is a simplifier, such as
  `/simplify`). Not the P0-P3 definitions (that is the review bar).
---

# desk-kiss

One axis: **should this change be smaller?**

Three things:

- **Scope creep**: a hunk that traces to no line of stated intent.
- **Speculative generality**: code with exactly **one** consumer. The review bar's P1 *Dead on
  arrival* already covers **zero** consumers; one is the gap.
- **Commentary**: an added comment that narrates history or restates the code.

**Who runs what.** All three are named classes in the review bar (P2 *Out of scope*, P1
*Speculative generality*, P1 *Scope creep with no consumer*, P2 *Narrative comment*), and
`desk-review` runs **Phases 2–5 of this skill on every review**, as its simplicity finder, and
reports the survivors at the bar's severities. **That is the gate.** It runs whether or not anyone
remembers this skill, which is the point: a guard you have to invoke is not a guard. When it runs
there, desk-review supplies `RANGE` and `TIP`, so Phase 1 is skipped, and Phases 6 and 7 do not run.

`/desk-kiss` is for **acting on** those findings: it runs the same passes, prints the full report
(including the `commentary` band, near misses and held the line, which the bar does not grade), and
then offers each simplification and applies the ones you accept (Phase 7). Run it when a review's
simplicity findings are ones you want made.

Everything else defers completely: correctness and security to `desk-review`, duplication and
severity to the review bar, in-place cleanup to a simplifier. Whether the machinery is proportionate
is the simplifier's question, not a pass here.

Severity is the review bar's, and is written there rather than restated here: a scope hunk carrying
no other defect is **P2**, and a hunk that is both (out of scope *and* serving no live consumer) is
**P1**. Narration and contradiction take the bar's P2 *Narrative comment* class and its exclusions.
Restatement and commented-out code report in their own `commentary` band and never borrow a P.

## Resolve this repo's config first

```bash
desk-env where        # SLUG=, GH_REPO=, CONFIG=, CREDS=, EXISTS=yes|no
```

Read the `CONFIG` file. `EXISTS=no` is not a stop here: this skill writes nothing, so it runs with
no config, reaches intent from the PR and the commits only (Phase 2), and says
`config: none` in the report header. With a config, take:

- §0 GitHub repo (`<owner>/<repo>`) and Default branch (`<default>`).
- §3 `read-own-work` and `read-others`, for reading tickets.
- §4 Tracker (`desk-env get tracker`), Ticket key pattern (`desk-env get ticket-pattern`), Other
  work id patterns (`desk-env list work-id-patterns`), and **Review bar** (`desk-env get review-bar`).
- §5 Repo instructions: the repo's own files (`CLAUDE.md`, `AGENTS.md`…) win over this skill on
  anything they cover, including where they set the layering and when to extract.

**The review bar** is §4 Review bar's file, else the default at
`~/.agents/skills/desk-review/references/review-bar.md`. Read it now, in full. Every severity and
every *Never report* item below is that file's, never a copy of it.

## Entry points

| Invocation | Target |
| --- | --- |
| `/desk-kiss` | **Default.** The current branch against its PR base, else `origin/<default>` |
| `/desk-kiss 460` | One PR (number, `#460`, or URL) |
| `/desk-kiss main...feat/x` | A ref range |

Phase 7 asks per finding and takes "no" for an answer, so there is no `--fix` or `--no-fix` flag.

## Phase 1: target

Set `RANGE` and `TIP`. All three shapes are first class.

**Branch (default):**

```bash
gh pr view --json number,baseRefName,title,body
```

`BASE` is the PR's `baseRefName`, else §0 Default branch, else
`git symbolic-ref --quiet --short refs/remotes/origin/HEAD` with `origin/` stripped. Then
`RANGE="origin/$BASE...HEAD"` and `TIP=HEAD`. `gh pr view` with no argument resolves the current
branch's PR; do not add `--repo` there, or it demands a PR argument.

**Never `@{upstream}`.** On a pushed branch it is the branch's own remote ref, so the range is empty
and the run reports a clean review of a diff it never read.

**A PR:** `gh pr view <n> --repo <owner>/<repo> --json number,author,baseRefName,headRefOid,title,body`.
Someone else's PR needs §3 `read-others`; without it, stop and say so. Fetch the head without
checking it out, so the working tree is untouched:

```bash
git fetch --quiet origin "<base>" "+pull/<n>/head:refs/desk-kiss/pr-<n>"
```

`RANGE="origin/<base>...refs/desk-kiss/pr-<n>"` and `TIP=refs/desk-kiss/pr-<n>`. Never `gh pr diff`:
GitHub refuses any diff over 20,000 lines. Delete the ref when the report is printed
(`git update-ref -d refs/desk-kiss/pr-<n>`).

**A ref range:** `RANGE` is the argument as given; `TIP="${RANGE##*...}"`.

`git diff --stat "$RANGE"`. **An empty diff stops the run.** Say so. An empty diff is never a pass.

**Every search in this run reads `$TIP`, not the working tree.** When the target is not an ancestor
of `HEAD` (any ref range, any PR not checked out) a plain `grep -rn` searches a tree the change is
not in and returns a false clean, the same failure `@{upstream}` causes above. Check once, then use
`git grep`:

```bash
git merge-base --is-ancestor "$TIP" HEAD && echo "in tree" || echo "NOT in tree: git grep only"
git grep -n '<pattern>' "$TIP" -- '<path>'
```

A target that is not the checked-out tree cannot be fixed. Note it now and skip Phase 7.

## Phase 2: intent

The scope pass has nothing to measure against until this exists. Build it in tiers and **name the
tier reached in the report**.

Extract the ticket key from the target's own commits and PR, **not** the checked-out branch, which
for a ref range or a PR belongs to different work and will silently yield someone else's ticket.
Read the text once:

```bash
git log --format='%s%n%b' "$RANGE"
```

On a PR target add its title and body from Phase 1. (Bare `gh pr view` resolves the checked-out
branch's PR, which for a ref range is different work entirely.) Match §4 Ticket key pattern against
that text with `grep -oiE`, take the first hit and upper-case it: branches are often lowercase while
keys are not. Then try §4 Other work id patterns the same way.

1. **Ticket.**

   | What matched | Where the ticket text comes from |
   | --- | --- |
   | §4 Ticket key pattern, Tracker `jira` | `desk-jira get <KEY>` (needs §3 `read-own-work`, or `read-others` for someone else's ticket) |
   | §4 Other work id patterns | `$DESK_STATE/tickets/<KEY>.md` (`desk-env paths` prints `DESK_STATE`) |
   | Tracker `none` | the PR's linked issues, each read with `gh issue view <issue number> --repo <owner>/<repo>` |

   Take the description and acceptance criteria. **Never write to the tracker.**
2. **PR.** Its author-written title and body. Strip generated blocks first, as desk-review's
   Phase 5 does: a body holding only bot-written preview links or checklists is no intent.
3. **Commits.** The range's commit subjects and bodies.

Restate the result as bullets, one per distinct intent, however many that is. That list is the
contract the diff is held to, and the author must be able to see it to disagree.

**Fall to the next tier, naming why, when:** there is no config or no tracker; the tracker read is
not allowed or fails; the key resolves to an **epic** or anything else carrying no acceptance
criteria; there is no key at all.

**A declared partial ("1/2", "part 2", "follow-up") is measured against the half it declares.**
Holding it to the whole ticket manufactures scope findings for work the author deliberately
deferred.

**At tier 3, say so in the report and hold shared surfaces to a higher bar.** The author wrote both
the diff and the commit message, so every hunk traces to intent by construction and the scope pass
cannot fail on its own terms. A change to a file used across the app still needs a reason that is
not merely "the commit mentioned it".

**When intent is thin ("polish and fixes"), run the other passes and state that the scope pass was
not possible.** Inventing a boundary from a vague message produces confident nonsense.

## Phase 3: the passes

One question each. Read the changed files in full **at the target**, not from the working tree:
`git show "$TIP":<path>`. A hunk cannot be judged for proportionality through a diff window. Skip
generated files, lockfiles, snapshots, generated clients and vendored deps. A docs or knowledge file
the repo's instructions require to change alongside the code this diff moves is required upkeep,
not scope creep. Over ~2,000 changed lines or ~80 files, read the highest-risk files and **state
which were skipped**.

### Scope: *does every changed file trace to a line of intent?*

- A file no intent bullet reaches.
- A reformat, rename or import reshuffle in a file that needed a one-line change.
- An adjacent refactor: improving code the change merely passed through.
- A second, unrelated fix bundled in, especially one large enough to carry its own ticket.
- **Pre-existing dead code deleted.** Removing orphans *your* change created is correct; removing
  orphans that were already there is an unrequested change with its own blast radius. Mention it,
  do not delete it, and report it when someone else has.

The review bar's boy-scout exemption applies as written: moving copies onto a shared helper, a
shared extraction the repo's instructions ask for, or a change the diff needed to compile or keep a
test green is never scope creep.

### Speculation: *what serves a consumer that does not exist?*

The one-line test: **delete it. Does anything visibly break?**

- An abstraction, wrapper or generic with exactly one caller.
- An option, prop, flag or config knob no intent bullet asked for.
- An interface, union or base type with one implementer.
- Error handling for a state the types or the call sites make unreachable.
- A `switch`, map or strategy table with one real arm.

Fowler's own detector, which is a grep rather than a judgement: **a method or class whose only users
are test cases.**

"We'll need it later" is answered by the later change being cheaper than the wrong abstraction is
now. Where the repo's instructions set when to extract, theirs is the threshold; otherwise extract
at the third use, not the first.

### Duplication

Apply the review bar's P1 *Duplication*, P1 *Extracted, callers not migrated* and P2 *Local
duplication* as written. Nothing is added here, including the search-by-mechanism rule and the
"mirrors / same shape as" comment signal, which that file already carries.

**One carve-out.** The review bar treats "consider extracting" as a reviewer-proposed refactor and
never reports it. That does not cover duplication **this change created or left standing at a seam
it opened**: a change whose stated purpose is consolidation, leaving two callers repeating the thing
it consolidated, is in scope for this pass.

### Commentary: *does every added comment say something the code cannot?*

Start with a mechanical sweep of the added lines. When the repo's `.pullbot.yml` has a
`debt:narrative-comment` label rule, use its `diff` pattern so the two cannot drift; otherwise build
one from §4 Ticket key pattern. Run it with `perl`: macOS `grep` has no lookbehind.

```bash
git show "$TIP":.pullbot.yml 2>/dev/null \
  | perl -0ne "print \$1 =~ s/''/'/gr if /label: debt:narrative-comment\n(?:.*\n)*?\s*diff: '((?:[^']|'')*)'/"
```

With no pattern from there, use the added comment lines that carry a ticket key, a review-finding
reference or a dated attribution:

```bash
git diff "$RANGE" | perl -ne 'print if /^\+(?:.*(?<!:)\/\/|.*\/\*|\s*\*|\s*#).*(?:\b(?:<ticket key pattern>)\b|review,? finding|\b\d{1,2} [A-Z][a-z]{2} \d{4}\b)/'
```

`<ticket key pattern>` is §4 Ticket key pattern, verbatim. The sweep is a starting list, never the
whole pass. A missing `.pullbot.yml` rule is not a stop; a pattern that fails to compile is: say so
rather than guess.

Then read the rest of the added comments with the same question. Report:

- **Narration.** A ticket id, a review finding, a dated attribution, a person's name, "previously",
  "used to", "now", "after the fix": the history of the change. That belongs in the commit and the
  PR, which keep it; a comment keeps it only until the next edit makes it false.
- **Restatement.** A comment that says what the next line does (`// fetch the user` above
  `getUser()`), or a docblock repeating the parameter names and types.
- **Contradiction.** A comment the code beside it has already made false.
- **Commented-out code**, and a `TODO` with no ticket to carry it.

Keep a comment that records a **why** the code cannot: a non-obvious constraint, a workaround for a
named upstream bug, a regulatory rule. Two more survive the pattern matching them: a *"mirrors"* or
"must match" annotation naming its twin, which is duplication for the pass above, and the ticket or
date on a skip, a lint suppression or a `continue-on-error` saying when it comes out. When one
comment mixes the two, the finding is the narration, and the fix keeps the why. Comments in
unchanged lines are out of scope: only what this diff added.

## Phase 4: justification gate

Run before anything is reported. Deliberate complexity flagged every run teaches the author to skim.

Drop a candidate when the review bar's **Never report** list covers it (read that list, not a copy
of it) or when either clause below applies.

That list bars "hypothetical future needs", which bounds what a reviewer may **ask an author to
build**. It does not bar reporting speculative generality the author has **already built**, which
is this skill's own axis; read it that way or Phase 3 deletes itself.

- **It is the repository's own convention.** A thin repository function, a decorator that only maps
  fields, a router that only calls a service: that may be the layering this codebase chose, not
  indirection to collapse. Where convention is the whole argument, measure it (`git log` the last N
  commits touching the same shape) rather than asserting it.
- **The repo records it.** A known-issues register, an ADR, a `KNOWN GAP` note or a rejected
  proposal the repo's instructions point to, **unless this diff changes the code it anchors to**;
  then report it and cite the record.

## Phase 5: refute

One adversarial pass, inline, over the survivors, arguing the **author's** case: the caller you
missed, the second implementer landing in the same PR, the guard that is unreachable today and
reachable next week by design. Check `git blame` before reporting any deletion. Code that looks
pointless was put there by someone with a reason, and until you can say what it was you cannot say
it is safe to go.

**When uncertain, reject.** A missed finding costs less than a false positive that burns the
author's time. A candidate you rejected for a reason the author would want goes in `near misses`,
not in the bin.

## Phase 6: report

Terminal output. Nothing is written anywhere.

```
branch fix/abc-844-invite-expiry → main · 9 files read · intent: ABC-844 acceptance criteria
bar: default

intent
  · an expired invite must show the parent why, not a generic 404
  · resending must invalidate the previous token

P1 (1)
 src/invites/token_policy.py:12   `TokenPolicy` has one implementer and one caller,
                                  and no intent bullet asks for a second

P2 (2)
 src/admin/invite_row.tsx:88      re-indents the whole file around a one-line change,
                                  burying it in the diff
 src/invites/resend.py:31         narrative comment: `# ABC-844 review, finding 3: invalidate
                                  first` narrates the review; the code already reads that way

commentary (1)
 src/invites/resend.py:44         docblock restates the two parameter names and types

near misses
  `grace_window_ms` looks unused: kept, ABC-844's AC2 names it and the reader lands in part 2

held the line
  the expiry copy reuses the existing `<Banner>` rather than a new alert component
```

The example is a shape, not a bar. Judge findings against the review bar, never by whether they
resemble these.

The file count is files **read**, matching the empty-run wording. The header names the target as it
was given (`branch <name> → <base>`, `PR <n>`, or `range <a>...<b>`), the bar (`bar: default` or
§4 Review bar's path) and, with no config, `config: none`. Name the intent tier whenever it is not
the ticket: `intent: PR body (no ticket key)`, `intent: commit messages (ABC-72 is an epic)`.

**Print every band that ran, including `P1 (0)` and `commentary (0)`.** A silently absent band
cannot be told apart from one that was never checked, which is the same false clean Phase 1 exists
to prevent. When nothing at all survives: `no findings · 14 files read`.

`near misses` carries what Phase 5 rejected but the author would want to know. `held the line` names
restraint the author showed: the only part of the report that is not a criticism. With no usable
intent, print `scope pass: skipped (intent too thin)`.

## Phase 7: fix offer

Skipped whenever the target is not **exactly** HEAD, or the report was empty. Say so in one line
rather than omitting it silently. `is-ancestor` is not the test: it is true for every historical
commit on the branch, and applying a fix would edit HEAD's version of a file rather than the
target's.

```bash
git rev-parse "$TIP" HEAD     # the two lines must match, or skip Phase 7
```

Otherwise read `references/fix-offer.md` and follow it: it carries the preconditions, the
per-finding approval loop and the rule for what is mechanical enough to offer.
