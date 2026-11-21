# desk-ci: protection

Read before any `protection` command (`snapshot`, `restore`, `pin` or `token`), and no other step's
file with it. The overview, the placement rule and the red flags every command shares are in
`../SKILL.md`, already loaded.

## protection

Moving checks to a self-hosted runner changes what can satisfy a required check, so protection is
saved before anything changes and every required check is bound to the app that should run it.

```bash
node ~/.claude/desk/bin/desk-ci.mjs protection snapshot --ticket <KEY | none> [--repo owner/name] [--branches main,production]
node ~/.claude/desk/bin/desk-ci.mjs protection restore <snapshot file> [--apply <plan id>]
node ~/.claude/desk/bin/desk-ci.mjs protection pin   [--branches main,production] [--apply <plan id>]
node ~/.claude/desk/bin/desk-ci.mjs protection token [--apply <plan id>]
```

Branches default to the default branch and `production` (one that does not exist is recorded as
such). Reading protection needs admin rights on the repo: an unreadable protection is an error,
never recorded as "off", because restoring "off" deletes it. `restore`, `pin` and `token` run from a
checkout of the repo they change (a `--repo` naming another is refused): its committed files and
its config §3 are what decide. `pin` and `token` fetch `origin/<default>` and refuse if it is not
the head GitHub reports.

- **snapshot** saves classic branch protection, the effective rules on each branch, and the repo's
  own rulesets in full, with every required check and the app it accepts (`any app`, or an app id
  and slug), as `<UTC time>-ci-protection-<owner>__<name>.json` in the main checkout's `.handoffs/`
  (`--out` picks another directory). It never overwrites a file. `--ticket` is required: the repo's
  cut-over ticket, which it attaches the file to with `desk-jira attach` under the Jira grants, or
  `none` to save only. A failed attach says so, prints the command to retry and exits 1. An
  organisation's rulesets show in the effective rules but are not the repo's to restore.
- **restore** puts the snapshot back: classic protection (`PUT`, or `DELETE` where the snapshot had
  none), required signatures, and each ruleset (`PUT` by id, else by name; `POST` if gone; `DELETE`
  for one the snapshot lacks). It then reads everything back and compares it with the file:
  `restored: read back, … matches` or each difference, exit 1.
- **pin** reads the GitHub Actions app id from a real check run on the repo (the default branch's
  head, else the latest completed Actions run's commit) and binds each required check that any app
  may satisfy, and that an Actions check run carries, to that app, in classic protection (`app_id`)
  and in the repo's rulesets (`integration_id`), so a status of the same name posted with a personal
  token no longer satisfies it. Nothing else is repointed: a check no Actions run carries is
  reported `left` (pinning it would block every merge), and one already bound to another app
  `another app` (repointing it would let a PR's own workflow satisfy it). It reads back, and reports
  `pinned:` only when every required check accepts only GitHub Actions; anything left, bound to
  another app, or undone by a committed file (below) reports `not pinned` and exits 1.
- **A repo that rewrites its own protection from a committed file** (a workflow, a file under
  `.github/`, a JSON file or a script a workflow names, read at `origin/<default>`) undoes the pin on
  its next run. A writer is a JSON file carrying `required_status_checks`, a protection or rulesets
  REST path with a method or body flag beside it (`gh api`, `curl -d`, a `${{ }}` expression in the
  path included), or an Octokit write such as `updateBranchProtection` in `actions/github-script`.
  `pin` names each such file, its line and the change it needs (`"app_id": <id>` on each check,
  `"checks"` not `"contexts"`; `integration_id` in a ruleset), and reports `not pinned` until the
  file carries it. The fix is a PR to that file, which this skill does not write.
- **token** lists every workflow at `origin/<default>` with no top-level `permissions:` block, and
  sets the default workflow token to read-only only once there are none (it keeps the "approve pull
  requests" setting as it is).

**Every write is a plan first.** Without `--apply` each command prints its plan, the exact method,
path and JSON body of every write, with a plan id, and changes nothing. `--apply <id>` re-reads live
state, recomputes the plan and applies it only if the id still matches, so what runs is what was
shown. `pin` and `token` refuse `--apply` until a snapshot of the repo exists. Config §3
`ci-protection` (unset reads as `ask`) gates it:

| `ci-protection` | What you do |
|---|---|
| `ask` (default) | print the plan, ask, and apply only on the user's yes, with that plan's id |
| `yes` | print the plan, then apply it with its id |
| `no` | print the plan; `--apply` is refused |

A write that fails stops the run and says how many applied before it: restore from the snapshot.

1. `snapshot` first, every time, with the cut-over ticket, and print where it was saved.
2. `pin` or `token`: print the plan and what it leaves, gate it, apply, print the read-back.
3. To undo: `restore <file>`, gated the same way.
