# desk-setup step 1: the desk gate workflow

Read during step 1, once §4 Local review command is confirmed as `/desk-review`. The step table
in `../SKILL.md` names this file for it. "The same templates directory" is the one
`step-1-pre-push-hook.md` names, and "the merge holds proposed above" are step 1's, in
`step-1-detect.md`.

### The desk gate workflow

Once §4 Local review command is confirmed as `/desk-review`, offer, as its own question, to commit
the CI gate: `desk/templates/.github/workflows/desk-gate.yml` and
`desk/templates/scripts/desk/review-gate.mjs`, from the same templates directory. It runs three
jobs, and say what each one fails on:

| Job (check name) | Fails when |
|---|---|
| `desk-review verdict` | the PR's latest `desk-review:verdict` marker (from someone with write access, read from the repo's permission endpoint) is missing, attests a SHA other than the head, has any of `p0` `p1` `p2` `deferred` `gaps` `unrefuted` `partial` non-zero, or sits under a heading that lists findings, or names another SHA or round. `REQUIRE_VENDOR: 'codex-cross'` also refuses a same-vendor refutation. P2s a third round carried are out of `p2` and never fail it; the gate does not read the carried line, so any copy gives the same result |
| `CLAUDE.md size` | a tracked `CLAUDE.md` is over 20,000 characters, the most the reviewer loads |
| `protected-path approval` | the PR touches a path the `PROTECTED` regex matches (a rename's old path included) and has no approval at its head from someone with write access other than its author, unless it is a small `fix`, `docs` or `chore` change: that type in the title, no breaking `!`, and at most 30 changed files, not counting lockfiles and build output |

Ask for the protected paths as a second question: the merge-hold globs the user wants a second
person on, written as one regex, Recommended `^(\.github|scripts/desk)/` so a change to CI or to
this gate is at least asked for an approval. `none` leaves `PROTECTED: ''` and the job passes. **Say
plainly that none of the three jobs can protect itself**: a PR runs its own copy of the workflow and
script, so it can blank `PROTECTED` or rewrite a job and the check still passes under its name. Only
the branch ruleset closes that, with required reviewers (or CODEOWNERS review) over `.github/**` and
`scripts/desk/**`, and that is the user's change to make. Say that a solo repo cannot meet this job's approval (the author's
own never counts), so it should stay unrequired there. If the repo already has both files and they
match, say so and skip; if they differ, show the diff and ask. On a yes, on a new branch off
`<default>` named per §5 Branch names:

```bash
T="$(cat ~/.claude/desk/source-checkout)/desk/templates"
mkdir -p .github/workflows scripts/desk
cp "$T/.github/workflows/desk-gate.yml" .github/workflows/desk-gate.yml && cp "$T/scripts/desk/review-gate.mjs" scripts/desk/review-gate.mjs
# then set PROTECTED in .github/workflows/desk-gate.yml to the confirmed regex, with Edit
git add .github/workflows/desk-gate.yml scripts/desk/review-gate.mjs
git commit -m "<§5 PR title format>: add the desk gate workflow"
```

Push it and open the PR through `desk-pr`, under §3 `git-push` and `pr-open`; pushing a workflow
needs `gh`'s `workflow` scope. It blocks nothing until a job is required: offer to add the chosen
check names to §4 Required checks, and say that the branch ruleset is the user's change to make.
Both paths fall under the merge holds proposed above.
