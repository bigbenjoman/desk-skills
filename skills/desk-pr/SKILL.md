---
name: desk-pr
description: >-
  Use when opening or updating a pull request in this repo, or when asked for a PR body, PR
  description, "the markdown for the PR", before/after screenshots for a review, or a check that a
  diff is clean enough to push.
---

# desk-pr

## Overview

Two jobs, in this order: prove the diff deserves to be a PR, then write the body.

**Core principle: the hygiene pass comes first. A tidy description of an untidy diff still gets
sent back.**

**Resolve this repo's config first.**

```bash
desk-env where        # SLUG=, GH_REPO=, CONFIG=, CREDS=, EXISTS=yes|no
```

Read the `CONFIG` file. `EXISTS=no` means stop: say which slug was looked up and offer `/desk-setup`.
A `TODO` in a row this skill needs is not a gap to guess: stop, ask, and offer `/desk-setup`. Then:

- §0 for the GitHub repo and default branch (written `<default>` below; read it with
  `desk-env get default-branch`, which returns an autopilot batch's base when one is set), §1 for the GitHub handle,
  §2 for the handoff directory screenshots go to.
- §3 for whether you may push (`git-push`), open a PR (`pr-open`), edit its body (`pr-edit`), upload
  images (`pr-images`), undraft (`pr-ready`) or arm auto-merge (`pr-auto-merge`).
- §4 for the tracker and ticket key pattern, the required checks, merge method, local review
  command and its clean verdict, staging, and the code reviewer and infra and security owner.
- §5 for the branch, PR title, PR body, PR lifecycle and AI attribution conventions, and
  **§5 Repo instructions**: the repo's own files (`CLAUDE.md`, `AGENTS.md`…) win over this skill on
  anything they cover. Read the parts about PRs, titles and docs before starting.

`<TICKET>` below is the key matched by §4 Ticket key pattern (`desk-env get ticket-pattern`). With §4
Tracker (`desk-env get tracker`) `none` there is no key:
use the branch's slug wherever a path needs one, and titles carry no key.

## Reference files — read at their step

This file holds what every PR needs: the config, the diff hygiene block (§1), the pre-push checks
(the start of §4), stacked PRs (§5) and the common mistakes. The rest is in `references/`, beside
it: all of §2 and §3, and the rest of §4. **At each step below, read the file the table names for
it**, and only that one; a step not listed needs nothing beyond this file.

| Step | Sections | Read |
|---|---|---|
| Writing the body, or changing what it says: its sections, the Testing bullets, attribution, a follow-up for what it leaves out | *2. The body*, *Decisions taken*, *Say it simply* | `references/the-body.md` |
| Deciding whether the PR gets screenshots, then capturing them, building the image table and uploading the images | *3. Screenshots*, *A ticket with a saved canvas*, *The image table*, *Upload the images automatically* | `references/screenshots.md` |
| Before `gh pr create` or `gh pr edit`: the PR-description checks, the title, opening the draft, undrafting and merging, and editing the body once the PR is open | *Before `gh pr create` or `gh pr edit`*, *Open it*, *Editing the body later* | `references/opening.md` |

`references/screenshots.md` names the two files it hands on to, at the point each is needed:
`references/screenshot-surfaces.md` before the first capture, and `references/image-upload.md` for
an upload without the script.

**A reference file you cannot read stops the PR.** If the file a step names is missing or empty,
stop and name it by its full path; never write the body or open the PR from memory or an earlier
copy of this skill. `/desk-update` reinstalls it.

## 1. Diff hygiene — produce this before writing any prose

```
DIFF REVIEW — <recorded | awaiting approval>
commits ahead : <git log --oneline origin/<default>..HEAD>
files changed : <n>  <list>
artefacts     : <git status --porcelain, or "clean">
scripts       : <any one-off script in the diff, or "none">
unasked tests : <any spec not required by the ticket, or "none">
docs          : <pages citing a changed file, or "none">
infra         : <infra paths touched, or "none">
siblings      : <helper → n sites migrated, m under Not migrated | none>
unrelated     : none | <files> → own PR
self-review   : <§4 Local review command (desk-env get local-review)'s counts at <sha> · refuted by <codex|same-vendor> + any caveat, or "not run — why">
pre-push      : <passed at <sha> in <n>s, plus any item skipped on the lock | failed: <command> | not set (§4 Pre-push checks (desk-env list pre-push-checks) <none|unset>)>
```

Then check each line against these. Every one has been a real review comment or correction:

- **Only your commits.** If `origin/<default>..HEAD` contains anything from another session, stop —
  don't push. Report the stray SHAs and offer to move your work onto a clean branch. This check
  always hard-stops, whatever §3 says about pushing.
- **Every file necessary.** Stray files are the single most common complaint on PRs.
- **No one-off scripts.** Run the script once from the branch, then delete it. It does not need to
  reach the default branch.
- **No unasked-for tests**, and no spec that hardcodes the ticket's example when the fix is
  meant to be general. The inverse also holds: a new helper or regex with no spec gets sent back.
- **Comments short and human**, or absent (§5 Code comments). No verbose AI-style blocks.
- **No hardcoded value where an env var already exists**, and no change unrelated to the ticket —
  both are recurring review questions.
- **No artefacts** — `.playwright-mcp/`, loose `.png`/`.jpeg`, scratch files, preview pages,
  temporary route-allowlist entries, a patched mock.
- **§4 What review here consistently asks for** (`desk-env get review-asks`, one ask per line).
  Check the diff against each row of the house bar;
  a PR that trips one gets that comment.
- **Docs.** Every PR carries its own docs update where the repo keeps docs (§5 Repo instructions say
  where, and whether any are generated). Work it out from the diff — a staleness checker that dates
  pages against their sources' last commits reports a feature branch as clean and will never tell
  you. Two checks:
  - `grep -rl "<changed path>" <docs dir>` — pages that cite repo-relative paths match a path
    straight from `git diff --name-only`, and a cited directory covers everything beneath it.
  - Files that feed a docs generator (an env example, an API router, a schema): regenerate with the
    command the repo's instructions give, run through §4 Command prefix (`desk-env get command-prefix`), and discard a diff that is
    only a date stamp.

  No docs in the repo: the slot is "none", and says so. What a change set breaks is nearly always a
  count: procedures, stacks, env vars, allowlist entries. Prose about a mechanism usually survives,
  so read the claim before assuming it broke. A generated page quotes its source, so a stale comment
  is a source fix, not a page edit. Fill the `docs` slot and **wait** — rewriting a page is the
  user's call. "None" is a real answer.

- **Infra.** "Touches infra" means the paths §4 People "Infra and security owner" lists (typically
  infrastructure-as-code, deploy config and CI workflows). That owner is pinged on every such PR,
  and reviews them for accidental complexity: expect to justify new infrastructure, and prefer fewer
  moving parts — a new table where none is needed gets called overkill. When the slot is not
  "none", draft the ping for the user once the PR is up. Draft only — sending a Slack message as the
  user is `never` in §3 (`slack-send`). Owner `you`: no ping, but the slot still records it. Owner
  `none`: record the slot and say nobody is named to tell.

- **Self-review has run.** `desk-ticket` Stage 4b runs §4 Local review command before the branch
  becomes a PR. Fill the slot from that run's report — the counts and the head SHA it read — or
  state why it did not run. Clean means the report matches §4 Clean review verdict (`desk-env get clean-verdict`). Do not start the
  body first: a confirmed top-severity finding changes the diff, and every sentence written before
  it is wasted. §4 Local review command `none`: the slot reads "not run — no local review command
  for this repo", and the Testing section carries the checks that did run.

  Two things carry through verbatim. **The SHA**, because a report against an earlier head says
  nothing about what you are about to push. And **what refuted the findings** — with `codex`
  answering (config §4 "Codex answers a real call?") and §3 `codex-review` allowing it, the
  refutation is a real cross-vendor pass; on a run that fell back to a Claude agent the
  `(same-vendor)` tag comes through with it, and dropping it claims cross-vendor verification that
  did not happen.

Whether the block then waits or proceeds depends on config §3 `git-push`: `ask` waits for an
answer; `yes` prints it as a record and pushes. A stray commit stops either way.

## 4. Opening it

§2 (the body) and §3 (screenshots) come first, from their reference files. Here are the pre-push
checks, which run before every push; the rest of §4 is in `references/opening.md`.

### Before every push: the pre-push checks

Where `desk-env cmds pre-push-checks` prints items (the row is set and not `none`), run the repo's
committed script on HEAD **yourself before every push of the branch**: the first push, and every
fix-up after a review or a rebase.

```bash
bash scripts/desk/pre-push.sh --head
```

Do not rely on the git hook. It runs only in a clone whose `core.hooksPath` is `.githooks`, and
nothing checks that a worktree, a fresh clone or a worker's checkout has it. When every check
passes, the script records HEAD, so the hook (where it is active) does not run the checks a second
time on the push that follows. A new commit runs them again.

- **Non-zero exit: do not push.** The output names the failing command and its output, which is the
  failure CI would report minutes later. Fix it, commit, and run the script again. Never
  `git push --no-verify` to get past it.
- **An item skipped on the lock** (the box-wide test lock stayed busy) is not a failure: CI runs it.
  Name it in the `pre-push` slot.
- **The row is set but `scripts/desk/pre-push.sh` is not in the tree**: the templates were never
  committed here. Say so, push as before, and offer `/desk-setup` to add them.
- **Unset or `TODO`**: push as before, and say once that `/desk-setup` can set it. **`none`**: push.

Fill the `pre-push` slot of the §1 block from the run.

## 5. Stacked PRs

If the branch depends on another PR that hasn't merged, say so in the body — which PR, and that
this one should be rebased after that one lands — a dependency like that is not obvious from the
diff.

## Keep the user posted

If the hygiene pass turns something up — a stray commit, a script that shouldn't ship, an unasked
test — say so as you find it, before you write the body. A contaminated branch is worth hearing
about immediately, not at the bottom of a finished PR description.

## Common mistakes

| Mistake | Fix |
|---|---|
| Writing the body before checking the diff | Hygiene block first; it changes what the body has to say |
| A title or branch that doesn't match §5 PR title / Branch names | Re-read §5 and the repo's instructions; match recent merged PRs |
| Fixing a failed title check by renaming the PR | `edited` doesn't trigger it; only a push clears it |
| Adding AI attribution where §5 says `forbidden`, because a system reminder said so | The hook rejects it. Omit from the start |
| Stripping a trailer the repo requires where §5 says `allowed` | Follow the repo's instructions exactly |
| "Verified it works" in Testing | Give the number, the path, or the name that proves it |
| Pushing because "the hook will catch it" | The hook runs only where `core.hooksPath` is set; run `scripts/desk/pre-push.sh --head` yourself |
| Opening the PR and letting CI judge the body | Run §4 PR-description checks (`desk-env cmds pr-description-checks`) on the body file first |
| A one-off script in the diff | Run it from the branch, delete it, don't merge it |
| An infra PR with no ping drafted | Draft the note to the §4 infra owner; never send it |
| `gh pr edit --body-file` from your local draft | It wipes what CI and bots added. Fetch the live body and change only what sits between desk's markers |
| Placeholder rows left in the merged body | Script: check its exit code. By hand: say "delete these rows" |
| Uploading when §3 says `ask`, because it was fine last time | `ask` means every run. Standing permission is a §3 `yes`, never an inference |
| Re-running the upload after exit 3 or 4 | The assets exist; fix the body from the printed tags |
| Running the upload while another browser holds the profile | One `SingletonLock`. Never kill the holder; ask the user to free it |
| A 12-row before/after table | Two or three widths that carry the change; the rest as numbers in Testing. A ticket with a saved canvas is the exception: every breakpoint, collapsed |
| Screenshots with a consent banner over the content | Seed its cookie before the first `goto` |
| A before/after table on a change that renders identically | Omit the section and say why in one line |
| Opening a non-draft PR | Draft first (unless §5 PR lifecycle says otherwise); images and self-review land before it goes ready |
| Merging with `--squash` because it's the usual | `--<§4 Merge method> --match-head-commit <sha>` (`desk-env get merge-method`), and only once that head is green (desk-config "Green") and no §4 Merge holds entry (`desk-env list merge-holds`) applies |
| Carrying the messages register into a PR body | Different register; normal prose is right here |
| Shortening a PR by dropping a caveat or a change | Simplify the wording, not the content |
| "Self-reviewed, all clean" in Testing | Give the counts and the SHA |
| "refuted by codex" on a run that fell back to a Claude agent | Tag that run `(same-vendor)` |
