# desk-review: the targeted round

Read when an autopilot review try's briefing has a "Targeted" section. The config, the bar, every
seat's prompt, the round rules and the verdict are in `../SKILL.md`, already loaded.

With the `review-reuse` lever on, a clean review stops holding once a rebase or a base merge changes a
file it rests on. When the PR's own diff is unchanged and the base changed no lockfile, manifest or
configuration file, the pass narrows the head's review to what moved (`desk/bin/undraft.mjs`
`targetedReview`). The briefing names the clean review's SHA (`<from>`), the base range
(`<range>`), the base's changed files and the PR's changed files that name one. Everything else that
review read is carried, not re-read.

**What the finders read.** Every seat's prompt keeps its order, with item 3 the two commands below
in place of the PR diff, and item 4 the two file lists:

```bash
git diff <range> -- <the base's changed files>         # what the base changed under the review
git diff "origin/<base>...HEAD" -- <the PR's files that use them>
```

The finders judge whether the PR's change still holds over the moved files: a caller the base
changed, a signature or behaviour the PR relied on, a fixture or contract it reads. They read the
moved files in full at `HEAD`, the PR files using them, and their direct callers. The PR's own code
elsewhere was reviewed at `<from>` and is not re-judged, so a finding outside these files is out of
scope unless the base change breaks it. A briefing listing no PR files means none names a moved file
by name: the finders confirm that from the moved files' callers at `HEAD` before reporting nothing.

**The round.** It is the next round on the PR (Phase 1's count), so round 2 or later, and the round 2
rules apply: no new P2s, and a P0 or P1 any round missed still counts. Codex reads the same two
commands cold. Bea is not dispatched: the PR's own diff is unchanged, so the requirements judged at
`<from>` stand. `gaps` is 0, as that review was clean, and any gap it accepted goes in `accepted`
again, from its *Accepted gaps* section.

**The results file** adds, beside the usual fields:

- `since`: `<from>`, the full SHA of the clean review this round carries.
- `targeted`: `{ "from": "<from>", "range": "<range>", "files": [...], "users": [...] }`, the
  briefing's values as given (`users` is `[]` when it lists none).
- `rests_on`: this round's `FILES READ` paths and the carried review's own list from its
  `desk-review:rests-on` line, so a later base move is checked against both.

verdict.mjs then prints a `desk-review:targeted` marker and a line saying what this round re-reviewed
and what it carried from `<from>`, at which heads. The verdict marker attests this head and counts
only this round's findings. A P0 or P1 goes to a fix worker like any review finding, and a clean
verdict lets the PR undraft or merge.
