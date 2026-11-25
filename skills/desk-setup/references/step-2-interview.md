# desk-setup step 2: the permission interview

Read at the start of step 2. The step table in `../SKILL.md` names this file for it. Once the §3
rounds below are done, the §3b rounds, the dev-server port and §4 People are in the core's *§3b:
the autonomy rows*, already loaded.

## 2. The permission interview

`references/permission-rows.md` holds every row: the question, the Recommended option with what
it unlocks and what it exposes, the alternatives, and the harness rules it maps to. Read it now.

**How to ask:**

- `AskUserQuestion`, **one question per row, at most four per call**, in the rounds the reference
  lists. Run as many calls as it takes. Skip the Jira rounds when §4 Tracker is `none`.
- **First option = the Recommended value, labelled `(Recommended)`.** If the start-point repo
  answered differently, say so in the question ("in voicepa you chose `yes`") and keep both as
  options; the user picks. Its description says what it unlocks *and* what it exposes, **in this
  repo**. Where §4 Branch protection is `none`, `pr-merge-green` and `autopilot-merge` are
  Recommended at `ask`, not `yes`, and that option's description says the repo is unprotected:
  nothing on GitHub stops a red merge, so the agent's own check is the only one.
- After each round, echo the four answers in one line before the next round.

**Starting from another repo** (`/desk-setup from <repo>`, or chosen at step 0), the §3 and §3b rows
are not asked one by one:

1. Settle, unasked, the rows this repo's §4 forces, and say which and why. The schema holds them, so
   read them, never recall them: write the template with the rows step 1 confirmed (§3 and §3b as
   the template has them) to a scratch file outside the repo, and run
   `DESK_CONFIG=<that file> desk-env forced`. Each `FORCED` line names a row, the value it writes
   and why: every Jira row with §4 Tracker `none`, `pr-auto-merge` with auto-merge off in §4 Repo
   merge settings, and each row that needs a §4 Local database, Staging or Local services this repo
   lacks, all `no`. Write each as its line says, show the lines, and delete the scratch file.
2. Show every other row in one table, with one **will write** value each: the start-point repo's
   answer, unless a rule here names another for this repo (Branch protection `none` above, say),
   with the rule that chose. Where the start-point answer and the Recommended value differ, show
   both beside it (`start-point: yes`, `Recommended: ask`).
   For each `yes`, what it unlocks and exposes **in this repo**. A row the start-point repo has no
   answer for writes the Recommended value, marked new. When the table writes `autopilot-workers`
   `yes`, the autopilot statement below comes first.
3. One `AskUserQuestion`: write the table as shown, edit some rows (ask only the rows the user
   names, one question per row; every other row writes its table value), or ask every row (the
   rounds above).
4. Then the consistency checks below, on the rows as confirmed. Where an edit turns on a row whose
   dependents the start-point repo had off (`autopilot-workers` from `no` to `yes`, say), ask those
   dependents. A `yes` written this way is one the user chose in this conversation: it was in the
   table they confirmed. Keep the rows written `yes` because the start-point repo had them, not
   asked one by one: step 5's summary names each.

Kept out of the table, and never copied from the start-point repo: the Subscription row and the
dev-server port (asked on their own, as the core says), and the Phase 0 levers and Codex review rows
(set as the core's *§3b: the autonomy rows* says: they are not asked).

**Before the autopilot round, or a start-point table that writes `autopilot-workers` `yes`, say this
plainly:** autopilot runs detached `claude -p` workers, one
per ticket, in their own worktrees of this repo. They edit code, push, open PRs, post to Jira and,
with `autopilot-merge`, merge once §4 Required checks are green, **with nobody watching**. Anything
they are not granted, they park and ask about rather than guess. A worker never has more than the
user's own §3 grants in this repo.

**Consistency checks — ask again rather than writing a contradiction:**

| If | Then |
|---|---|
| `autopilot-workers` is `no` | write `no`/`none` for the other autopilot rows; say so, don't ask them |
| `pr-auto-merge` ≠ `pr-merge-green` | auto-merge merges on green by itself; ask which they meant |
| `pr-auto-merge` is `yes` but §4 Repo merge settings say auto-merge is off | it cannot work here; say so and write `no` unless they turn it on in GitHub first |
| `autopilot-merge` is `yes` but `pr-merge-green` is not | a worker cannot exceed its user; ask again |
| `read-others` is `no` | the `read-own-work` harness rules are not written either; say so |
| `pr-edit` is `yes` but `pr-request-review` is not | `gh pr edit` gets no harness rule; say so |
| `autopilot-merge` is `no` | `merge-driver.sh` gets no harness rule |
| `staging-write` | only `ask + backup + independent review` or `no` are offered; `no` when §4 Staging is `none` |
| `db-per-ticket`, `db-clone-staging`, `tests-shared-db` with §4 Local database `none` | write `no`; say there is no local database to act on |
| `local-reindex` or `worker-local-services` with §4 Local services `none` | write `no`; say so |

**State what is not on offer**, so the absence reads as a decision: sending or scheduling a Slack
message; merging past required checks or plain `--force`; touching someone else's PR; deciding
product, design or content questions; committing legal or compliance content. Editing the file to
`yes` changes nothing. The deny-only plan (§4 step 1) is in `~/.claude/settings.json` whatever the
answers.

**When a row's rule reaches further than its wording** (the reference's _Reach_ notes), put that
reach in the Recommended option's description. For `git-push` say that Claude Code still prompts on
each push: no allow rule is written, because git's abbreviations mean no pattern can fence every
dangerous spelling.
