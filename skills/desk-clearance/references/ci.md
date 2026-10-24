# desk-clearance: CI

Read when a PR's CI is red, pending, or wants a rerun, in whichever phase that comes up. The
config, ownership, what config §3 decides, the merge bar, parking and the red flags every phase
shares are in `../SKILL.md`, already loaded.

## CI

**Green means every required context read live from the platform, asserted positively at the head
SHA** — the script does this. If a required check is an aggregate gate job (one whose `needs:`
carries every real job, sometimes including a PR-title check or a check that reads a local review
verdict at *this* head), a red gate means read which upstream job failed. On failure, read it before
rerunning. `references/repo-facts.md#ci` covers how to find this repo's flakes, and the three ways a
rerun makes things worse:

- **A rerun cancels the run in flight** wherever the workflow sets per-PR `cancel-in-progress`
  (check its `concurrency:` block). Never retry faster than the slowest job — measure it from recent
  runs; the cooldown per PR is longer than that.
- **Pick the run by head SHA and workflow name**, never list position — rerunning a stale head's run
  cancels the live one.
- **`gh run rerun` replays the original merge commit.** After the default branch is fixed, close and reopen the PR
  for a fresh merge ref (head SHA unchanged, verdict still valid) — but first check the branch's own
  tree does not carry the break.

Advisory checks (§4 Advisory checks, or anything not required) are reported, never blocked on —
except in "every check" mode, where nothing is advisory. An e2e suite gates a PR only if it is a
required check; read the workflow's triggers before assuming it ran on the PR at all.
