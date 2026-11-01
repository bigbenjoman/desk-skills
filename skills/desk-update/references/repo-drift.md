# desk-update: what this repo has fallen behind on

Read in §2, inside a configured repo (`desk-env where` printed `EXISTS=yes`). `/desk-setup` writes a
repo's config and commits desk's templates into it once. Nothing after that brings either up to date,
so a row or a template fix shipped later never reaches the repo: this file is how it does.

## Rows the config lacks

`desk-env drift` names each row the installed template has and this repo's config lacks as
`MISSING  §<section> <row>: …`. A missing §3 row reads as `no`, so every worker is refused what it
grants, and each ticket that needs it parks naming it (needs-you lists those parks as one
`unset:<key>` item for the repo).

- **Each `MISSING  §3 <key>` line is asked once, in this run**, after the §3 multi-select: one
  question per row, four per `AskUserQuestion` call, worded as `/desk-setup` words it
  (`desk-setup/references/permission-rows.md`, the row's own line): its Recommended value first,
  labelled `(Recommended)`, with the row's Unlocks and Exposes, and its _Reach_ where it has one. The
  other options are the row's Other options. Recommended is the first option, never the answer.
- **Write each answer as it comes**, then show the line it added and the read-back:

  ```bash
  desk-env add-row 3 <key> <answer> --note "set <YYYY-MM-DD> by you in /desk-update"
  ```

  It copies the template's row into the config's own table, beside the row above it in the
  template, with the answer as its setting; it prints `ADDED §3 <key>: <the line>` and
  `perm <key> = <answer>`. It refuses a row the config already has (that is `/desk-setup`'s to
  change) and a §3 answer that is not `yes`, `ask` or `no` where the row takes one.
- **A row the user skips is left out**, not written as `no`: it stays `MISSING`, so the next run asks
  it again. Say which rows were skipped.
- **A `yes` on a row whose Rules column is not `—`** also needs its harness rules: say so, and offer
  `/desk-setup permissions` for that row (setup's §4 `add`). Round 9b's worker rows have none: the
  worker's settings read the row when each worker spawns, so the answer takes effect on the next spawn.
- **No `MISSING  §3` line, no permission question.** A config with every template row asks none.
- `MISSING` rows in §2, §3b, §4 and §5 are detected facts, not grants: report them on one ROW line and
  offer `/desk-setup` (a re-run asks exactly those). `STALLS`, `UNLISTED` and `DONTASK` lines are
  `/desk-setup`'s too: report them, change nothing.

If any parked ticket names a row answered here, say that `/desk-needs-you` (its `unset:<key>` item,
`done`) requeues them.

## Templates the repo committed

`repo-templates.mjs status` compares each file `/desk-setup` committed from `desk/templates/`
(`.githooks/pre-push`, `scripts/desk/pre-push.sh`, `scripts/desk/review-gate.mjs`,
`.github/workflows/desk-gate.yml`) as it stands on `origin/<default>` with the installed template.
Its base is the template version, in the desk-skills checkout's history, nearest the copy:

| Line | Means | Offer |
|---|---|---|
| `CURRENT` | the copy is the template | nothing |
| `BEHIND` | the template changed since the version the copy was made from | a PR (below) |
| `EDITED` | only this repo changed its copy (setup's own edit, such as the gate's `PROTECTED`, included) | nothing: report it |
| `UNKNOWN` | it differs, and there is no desk-skills history to tell which | nothing: report it, and the diff on request |

For each `BEHIND` file, show what the template changed since the copy's base before offering it:

```bash
node ~/.claude/desk/bin/repo-templates.mjs diff <path>
```

Summarise it in a line on the TEMPLATE row. **Never copy a template over the repo's file**: a repo can
have changed its copy on purpose (an extra check, its own message), and a whole-file copy loses that.

On a yes, one PR for every chosen file, under §3 `git-push` and `pr-open`, on a branch named per §5
Branch names (`chore/desk-templates-<YYYY-MM-DD>` where it takes a `chore/` prefix), cut from
`origin/<default>` in a worktree of its own, never in the checked-out branch:

```bash
R="$(desk-env get repo-root)"; W="$(desk-env get worktrees-dir)/desk-templates-$(date +%F)"
git -C "$R" fetch -q origin
git -C "$R" worktree add -q -b chore/desk-templates-$(date +%F) "$W" "origin/$(desk-env get default-branch)"   # exists: say so, stop
node ~/.claude/desk/bin/repo-templates.mjs apply --root "$W" <path>...
git -C "$W" add <path>... && git -C "$W" commit -m "<§5 PR title>: bring <paths> up to desk's template"
```

`apply` writes each file three-way: the template's changes since the copy's base go in, and the
repo's own edits stay. It prints `APPLIED <path>`, or `KEPT <path>` followed by each hunk where the
template and this repo changed the same lines; there the repo's lines were kept. **Every `KEPT` hunk
goes in the PR body, verbatim in a fenced block**, under a line saying the template's version of it
was not applied, so a person decides it. The body also says, per file, what the template changed
(the `diff` summary) and that this repo's own edits were kept. Push the branch, open the PR
(`desk-pr`), and report its URL. These paths usually sit under a merge hold, so a person merges it;
then needs-you's `templates` item clears on `done`. On no, nothing is written.

A `BEHIND` file is also what the supervisor records each hour (`repo-templates.mjs check`), which
needs-you shows as one `templates` item for the repo until the PR has merged.
