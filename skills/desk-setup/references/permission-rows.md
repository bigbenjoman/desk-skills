# Permission rows — questions, trade-offs, harness rules

One question per row, four per `AskUserQuestion` call, in these rounds. Skip the Jira rounds (write
`no`) when §4 Tracker is `none`. The first option is the Recommended value (a proven starting point), labelled `(Recommended)`. "Unlocks"
and "Exposes" go into that option's description; the alternatives get their own one-line trade-off.
**Where a row's rule reaches further than the row's wording (marked _Reach_), say so in the
question.** The answer then covers what the rule really allows.

## The rule column

What `/desk-setup` §4 hands to `bin/harness-rules.py`. Rules are written only when **every** row
in the rule's owner set is `yes`; revoking any owner removes the rule.

- Plain rules go to `permissions.allow`. `ask:` rules go to `permissions.ask` and only force a
  prompt; `unguard:` removes an `ask:` guard setup added earlier (put back on revoke).
- `—` means no rule can be scoped to the row's wording, so it keeps prompting. **When in doubt, no
  allow rule: a prompt is safer than an over-grant.**
- `<merge>` is this repo's §4 Merge method as a flag (`--squash`, `--merge` or `--rebase`); setup
  substitutes it before writing, so the rule matches exactly what the skills run here.
- Allow rules go to **this repo's** `<Primary repo root>/.claude/settings.local.json`, so a grant
  in one repo never reaches another. The deny-only plan goes to `~/.claude/settings.json`.
- `<slack>`, `<figma>`, `<atlassian>` are the MCP prefixes of claude.ai connectors,
  `mcp__claude_ai_Slack__`, `mcp__claude_ai_Figma__`, `mcp__claude_ai_Atlassian_Rovo__` (check the
  session's tool list; use what it shows).

**Rule syntax, verified** (docs: code.claude.com/docs/en/permissions, and an empirical
`claude -p --settings … --permission-mode dontAsk` run against stub binaries):

| Fact | Consequence |
|---|---|
| `*` matches any text, spaces included, and can be empty; it may sit anywhere | `Bash(gh pr merge *--admin*)` catches `--admin` in any position |
| `:*` is recognised only as a trailing wildcard, and a mid-rule `*` plus trailing `:*` did **not** match (`Bash(git -C * push:*)` let `git -C /tmp push` run) | never mix them; this file uses ` *` throughout |
| A space in the pattern is literal: `Bash(git push * --tags*)` misses `git push --tags origin` | flag guards are written `*--flag*`; short flags as `-f*`, `* -f`, `* -f *` (never `*-f*`, which matches `fix/…` branches) |
| A trailing ` *` also matches the bare command only when it is the rule's sole wildcard | an exact tail such as `Bash(gh pr ready *)` is a safe allow form. The pinned merge rules end in `--match-head-commit *`, so extra flags after the SHA also match: `--auto` is caught by its `ask` guard and `--admin` by the deny |
| Order is deny, then ask, then allow; first match wins. Compound commands are split and every part must match; `timeout`, `nohup`, `nice`, `time`, `stdbuf` are stripped first | guards beat allows; `nohup …/merge-driver.sh` matches its rule |
| An allow does not match past `VAR=1 cmd` (unless the variable is a known-safe one), a `$B/` path, `git -C dir`, or an absolute binary path | those forms prompt; that is the safe direction |
| git takes bundled short flags (`-qf`) and any unique prefix of a long option (`--force-w`, `--delet`, `--mirro`, `--upl`) | no exact-string guard fences a broad git allow, so git gets no allow that a flag can turn dangerous; a guard is written as the shortest unambiguous prefix (`*--u*`) |

## Always written — the deny-only plan

`references/baseline-deny.json`, applied by `harness-rules.py baseline`: by `install.sh` when the
user accepts its settings edits, otherwise by §4 before any allow is offered. Whatever the answers
and whatever the connector detection says: it only takes capability away. The file is the list;
this table is the summary.

| Owner | Denies |
|---|---|
| `slack-send` | the Slack connector's send and write tools (`slack_send_message`, `slack_schedule_message`, canvas, list, reaction, conversation and file-upload tools) under `mcp__claude_ai_Slack__`, plus any other Slack prefix passed as `--slack-prefix` |
| `merge-bypass` | `gh pr merge *--admin*`; **best-effort** `git push` with `--force`, `-f`, a `+refspec`, `--mirror`, `--delete` or `-d`. git's abbreviations (`-qf`, `--forc`, `--delet`) and `git -C dir push` get past them: they catch a slip, not a workaround |
| `others-prs`, `product-calls`, `legal-content` | — (the skills refuse; no rule can tell whose PR or what content) |

`slack_send_message_draft` is never denied; it is `slack-draft`'s allow. `--force-with-lease` is
not denied: `git-force-with-lease` can be `yes`, and it prompts.

## Always written with a repo's plan — orchestrator tools

`harness-rules.py add` adds these to every plan it writes to a repo's `.claude/settings.local.json`,
whatever the rows say: they are what an orchestrator or interactive desk session uses to wait on a
batch, read a Claude Design canvas, drive the Chrome extension and keep its memory (decision
2026-10-21: routine operations get no permission prompts). _Reach_: the Chrome tools act in your
signed-in browser. Owner `orchestrator-tools`, not a §3 row, so `remove
orchestrator-tools` revokes them (until the next `add`). Workers never get them.

| Owner | Allows |
|---|---|
| `orchestrator-tools` | `Monitor` `mcp__claude-in-chrome__*` `ArtifactComments` `ArtifactData` `Edit(~/.claude/projects/<repo root, each non-alphanumeric character as ->/memory/**)` (the repo's session memory directory, `desk-env paths`'s `DESK_MEMORY_DIR`) |

## Auto-mode entries — per repo, in the user settings

`harness-rules.py automode` (desk-setup §4 step 5) writes these to `autoMode.allow` in
`~/.claude/settings.json`, the only place Claude Code reads `autoMode` besides managed settings.
Each starts `In <owner/name> only:`, is recorded in this repo's ledger, and goes when its owner is
revoked. The script owns the wording; none covers a deploy, and `permissions` (the
`gh workflow run production-deploy*` ask included) is never touched. A new `allow` array starts with
`"$defaults"`, so the built-in rules stay.

| Owner | Entry |
|---|---|
| `pr-merge-green` | merging a PR whose required checks are green: the merge driver, or `gh pr ready <n>` followed by `gh pr merge <n> <merge> --match-head-commit <sha>`. Unpinned, `--admin` and other repos are named as not covered |
| `db-migrate` (not a §3 row: present while §4 Database migrate is set) | running migrations with §4 Database migrate against a local or per-ticket database. Shared, staging and production databases, and any production deploy, are named as not covered |

`scope_environment` prefixes an `autoMode.environment` entry the user confirms describes only this
repo with `In <owner/name> only:`, so one repo's environment stops applying everywhere.

## Which rows a script reads

Besides the harness rules below, some rows are read by a script at run time, so changing one takes
effect on the next run without a re-install. Measured against the scripts; when the user asks what
a row changes, say which of these applies.

| Script | Rows it reads |
|---|---|
| `worker-settings.mjs` (a worker's own settings) | `git-push`, `git-force-with-lease`, `pr-open`, `pr-edit`, `pr-self-review-comment` (`gh pr review` and `gh pr comment`; `--approve` and `--request-changes` stay denied), `pr-reply` (`gh pr comment` only; never `gh api`), `pr-update-branch`, `ci-rerun`, `jira-comment`, `jira-transition`, `jira-create`, `jira-edit`, `codex-review`, `read-figma`, `worker-dependency-install`, `worker-screenshots`, `worker-local-services`: anything short of `yes`, unset included, is denied to the worker |
| `setup-worktree.sh` | `db-per-ticket` (a per-ticket database, or every §4 Database URL variable blanked) |
| `merge-driver.sh` | `autopilot-merge`, `pr-merge-green`, `pr-update-branch`, `ci-rerun`, `merge-feedback-first` (it never arms auto-merge, so `pr-auto-merge` does not reach it) |
| `pass.mjs` | `autopilot-workers`, `pr-images`, `batch-base-push` (unset is `ask`), `autopilot-usage-resume` (unset is `no`) |
| `triage.sh` | `autopilot-workers` (`yes` or `ask`: triage is read-only and foreground) |
| `spawn-worker.sh` | `autopilot-workers`, `codex-review` |
| `upload-images.mjs` | `pr-images` |
| `desk-ci.mjs protection` | `ci-protection` (unset is `ask`; `no` refuses every `--apply`) |
| `desk-jira create`, `create-batch` | `jira-assign-self` (a new ticket with no assignee given is assigned to you) |
| `clearance-state.mjs` | `pr-merge-green`, `merge-feedback-first` |
| `/desk-checkout`'s collectors (`github_activity.py`, `jira_activity.py`, `claude_activity.py`) | `read-own-work`, `read-transcripts`, per repo |

Every other row is read by no script. It decides harness rules (most `read-*` rows, `git-commit`,
`slack-draft`) or is enforced by the skills' own written rules (`autopilot-worker-mode`,
`autopilot-judgement`, `autopilot-reclaim`, `skills-edit`, `vercel-env`, and the `never`/`stop`
rows).

## Round 1 — your work, read

| Key | Recommended | Unlocks | Exposes | Other options | Rules |
|---|---|---|---|---|---|
| `read-own-work` | yes | every skill: tickets, PRs, reviews, CI state | nothing beyond your own output. _Reach_: the rules read any PR or ticket, so they need `read-others` too | ask | owners `read-own-work` + `read-others`: `Bash(gh pr view *)` `Bash(gh pr list *)` `Bash(gh pr checks *)` `Bash(gh pr diff *)` `Bash(gh run list *)` `Bash(gh run view *)` `Bash(desk-jira whoami)` `Bash(desk-jira get *)` `Bash(desk-jira search *)` `Bash(desk-jira comments *)` `Bash(desk-jira transitions *)` `Bash(desk-jira fields *)` `Bash(desk-jira children *)` |
| `read-local-git` | yes | cleanup, autopilot collision checks, stray-commit guard | other sessions' worktrees are read (not written) | ask | `Bash(git status *)` `Bash(git log *)` `Bash(git diff *)` `Bash(git show *)` `Bash(git fetch *)` `Bash(git worktree list *)` `Bash(git merge-tree *)` `Bash(git rev-parse *)` · `ask: Bash(git log *--output*)` `ask: Bash(git diff *--output*)` `ask: Bash(git show *--output*)` (they write files; git rejects `--outp`, ambiguous with `--output-indicator-*`) · `ask: Bash(git fetch *--u*)` `ask: Bash(git fetch *--upload*)` (`--upload-pack`, or any prefix down to `--upl`, runs a command; `*--u*` also prompts `--unshallow`) |
| `read-others` | yes | ownership checks, sibling PRs a ticket depends on | colleagues' PR and ticket text enters the session | no (weakens the ownership guard; the read rules are then not written) | co-owner of `read-own-work`'s rules |
| `read-slack-public` | yes | a reviewer's ruling or a convention announced in a channel | channel messages, including other people's words | ask · no | `<slack>slack_search_public` only. `slack_read_channel` and `slack_read_thread` also open private channels and DMs, so they keep prompting |

## Round 2 — tools, read

| Key | Recommended | Unlocks | Exposes | Other options | Rules |
|---|---|---|---|---|---|
| `read-figma` | yes | design context and screenshots for UI tickets | design files linked from tickets | ask · no | `<figma>get_design_context` `<figma>get_screenshot` `<figma>get_metadata` `<figma>get_variable_defs` |
| `read-vercel` | yes | preview build state, why a deploy failed, runtime logs | build and runtime logs, which can include request data | ask · no | `Bash(vercel inspect *)` `Bash(vercel logs *)` `Bash(vercel list *)` `mcp__plugin_vercel_vercel__list_deployments` `mcp__plugin_vercel_vercel__get_deployment` `mcp__plugin_vercel_vercel__get_deployment_build_logs` `mcp__plugin_vercel_vercel__get_runtime_logs` |
| `read-confluence` | ask | background from team pages | whatever the page holds | yes · no | `<atlassian>getConfluencePage` `<atlassian>searchConfluenceUsingCql` |
| `codex-review` | yes | cross-vendor refutation: a second model tries to break each finding | diff excerpts go to OpenAI under your codex seat | ask · no (refutation is then same-vendor, and says so) | `Bash(codex exec --sandbox read-only *)` · `ask:` `Bash(codex exec *--dangerously*)` `Bash(codex exec *--full-auto*)` `Bash(codex exec *--approve*)` `Bash(codex exec *danger-full-access*)` `Bash(codex exec *workspace-write*)` `Bash(codex exec *--config*)` `Bash(codex exec * -c*)` `Bash(codex exec *--enable*)` `Bash(codex exec *--disable*)` `Bash(codex exec *--profile*)` `Bash(codex exec * -p*)` `Bash(codex exec *--output*)` `Bash(codex exec * -o*)` (attached forms such as `-cfoo=1` and `-p=x` included; codex does not abbreviate long options) |

## Round 3 — Jira, routine

| Key | Recommended | Unlocks | Exposes | Other options | Rules |
|---|---|---|---|---|---|
| `jira-assign-self` | yes | starting a ticket without a round-trip; `desk-jira create` assigns a new ticket to you | board shows you on it | ask | — (`desk-jira create` assigns only you, and refuses another assignee without `--route`, which `jira-create`'s rule keeps prompting. No `edit` rule: `desk-jira edit` can set any assignee) |
| `jira-comment` | yes | the root-cause + PR-link comment posts as it happens; exact text printed `posted` | text is public to the team under your name; editable. _Reach_: the rule posts on **any** ticket on the Jira site, other people's included; only the skill's `jira-others` check keeps it to yours | ask (every comment prompts) | `Bash(desk-jira comment *)` |
| `jira-create` | yes | follow-ups a review finds get filed immediately; an epic's children filed in one command | a new ticket under your name | ask | `Bash(desk-jira create *)` `Bash(desk-jira create-batch *)` · `ask: Bash(desk-jira create *--route*)` `ask: Bash(desk-jira create *reporter*)` `ask: Bash(desk-jira create-batch *--route*)` (routing a ticket to someone else is `jira-route`, and prompts. `create *` does not match `create-batch`, which takes its own rules; its routing and reporter rows sit in the file, so `create-batch` refuses them without `--route` on the command). No `assignee` ask: `desk-jira create` assigns only you without `--route`, and `harness-rules.py` drops the one an earlier setup recorded. No `attach` rule: it reaches any ticket |
| `jira-edit` | yes | narrowing a description to what shipped, the §4 Priority field, labels, an epic's Blocks links | overwrites fields others read | ask | — (`desk-jira edit`, `labels` and `link` reach any ticket and any field, assignee included; `link` is never a worker's) |

## Round 4 — Jira, board state

| Key | Recommended | Unlocks | Exposes | Other options | Rules |
|---|---|---|---|---|---|
| `jira-transition` | yes | §4 In-progress state on start, §4 Review state when the PR is up | board state the team filters on | ask | — (`desk-jira transition` reaches any ticket and any state, Done included) |
| `jira-close-own-merged` | yes | the ticket goes to §4 Done state the moment your own last PR on the key merges, with its one-line comment | a Done others act on, on evidence: a merged PR you authored and no PR on the key still open | ask · no | — |
| `jira-close` | yes | duplicate, not-a-bug and already-fixed closes without a wait | a judgement others act on; already-fixed needs every acceptance criterion checked | ask | — |
| `jira-route` | ask | — | a ticket lands on a colleague in your name | yes · no | — |

## Round 5 — git

| Key | Recommended | Unlocks | Exposes | Other options | Rules |
|---|---|---|---|---|---|
| `git-commit` | yes | commits in the ticket's own branch | local only | ask | `Bash(git add *)` `Bash(git commit *)` |
| `git-push` | yes | the skills push your ticket branch without asking you first; the DIFF REVIEW block is a record; a stray commit still hard-stops | your branch on GitHub, CI runs. Claude Code still prompts on every push unless you run a mode that does not prompt: no allow rule is written, because git's flag abbreviations (`-qf`, `--force-w`, `--delet`) mean no pattern can fence every dangerous spelling. The deny-only plan catches plain force, delete and mirror pushes as a best-effort backstop | ask | — |
| `git-force-with-lease` | yes | rewriting your own pushed branch | overwrites remote history; fails if someone else pushed. Prompts either way | ask · no | — |
| `pr-open` | yes | draft PR opened as soon as the branch is ready | a PR in the team's list | ask | `Bash(gh pr create *)` |

## Round 6 — PR content

| Key | Recommended | Unlocks | Exposes | Other options | Rules |
|---|---|---|---|---|---|
| `pr-edit` | yes | body and title kept current, image table filled | text reviewers read. _Reach_: `gh pr edit` also adds reviewers and reaches any PR, so its rule needs `pr-request-review` too | ask | owners `pr-edit` + `pr-request-review`: `Bash(gh pr edit *)` · `ask: Bash(gh pr edit *--base*)` |
| `pr-images` | yes | before/after images uploaded without a pause | drives a browser signed in to GitHub as you; never submits a comment | ask (every run) · no (placeholders) | `Bash(node ~/.claude/desk/bin/upload-images.mjs *)` |
| `pr-review-others` | ask | `/desk-review` on a colleague's PR, or a sweep of the queue, posts where the author reads it | a `COMMENTED` review under your name on someone else's PR. Never approves or requests changes. Workers never review others' PRs; **known gap**: a worker's `pr-self-review-comment` grant allows `gh pr review` on any PR number, so that is the skill's rule, not the harness's | yes · no (report only) | — (`gh pr review` can approve, so it is never allow-listed; each post prompts) |
| `pr-self-review-comment` | yes | the clean §4 Local review command sweep posted where the reviewer reads it | a comment under your name. _Reach_: any PR. The review itself goes up with `gh pr review --comment` or, from `/desk-review`, `gh api …/reviews` with event `COMMENT`; neither is allow-listed (both can approve), so each post still prompts in an interactive session | ask | `Bash(gh pr comment *)` (never `gh pr review`, which can approve) |
| `pr-reply` | yes | clearance works, replies to and resolves review threads | replies under your name; resolving hides a thread. **Autopilot workers never get `gh api`, even at `yes`**: a worker replies only with `gh pr comment`, and resolving threads stays with you or the orchestrator | ask | — (`gh api graphql` cannot be scoped; `Bash(gh api *)` would also allow merges and deletions) |

## Round 7 — PR to merge

| Key | Recommended | Unlocks | Exposes | Other options | Rules |
|---|---|---|---|---|---|
| `pr-request-review` | yes | hand-back to the reviewer; infra/security owner added without asking | pings a colleague | ask | co-owner of `pr-edit`'s rule |
| `pr-ready` | yes | undraft once the local review at head reads §4 Clean review verdict and the PR is not DIRTY | the PR enters review queues and the merge driver's view. _Reach_: any PR | ask | `Bash(gh pr ready *)` |
| `pr-auto-merge` | ask | GitHub merges the moment the gate clears | merges without a final look | yes · no | owners `pr-auto-merge` + `pr-merge-green`: `Bash(gh pr merge * --auto <merge> --match-head-commit *)` `Bash(gh pr merge * <merge> --auto --match-head-commit *)` · `unguard: Bash(gh pr merge *--auto*)`. Only the pinned form is allowed: an unpinned merge still prompts, and `harness-rules.py` drops the unpinned rules an earlier setup recorded |
| `pr-merge-green` | yes (`ask` where §4 Branch protection is `none`, and the question says this repo is unprotected) | merge (§4 Merge method) once §4 Required checks are green, no approval wait (a standing CHANGES_REQUESTED still stops it) | code reaches the default branch, and deploys wherever the repo deploys from it, with no human approval unless §4 Branch protection requires one: the agent's own verdict can be the last check. _Reach_: any PR the `*` names, `--repo` included; `--admin` is always denied | ask · no (you merge; skills report ready at APPROVED + green) | `Bash(gh pr merge * <merge> --match-head-commit *)` · `ask: Bash(gh pr merge *--auto*)` (removed when `pr-auto-merge` is yes) · `ask: Bash(gh pr merge *"*)` `ask: Bash(gh pr merge *'*)` `ask: Bash(gh pr merge *#*)` `ask: Bash(gh pr merge *<*)` `ask: Bash(gh pr merge *>(*)` `ask: Bash(gh pr merge *$*)` ``ask: Bash(gh pr merge *`*)`` `ask: Bash(gh pr merge *--match-head-commit=*)` (a `*` can absorb pin text the shell never passes to gh: a quoted value under any flag spelling, bundled short flags included, a comment, a heredoc, an expansion or an output process substitution; and a later `=` or empty pin overrides the real one. A SHA pin needs none of these characters. These guards catch mistakes and the common ways of smuggling a pin, not every shell construct someone could craft: a pattern rule cannot parse shell). Only the pinned form is allowed: an unpinned merge still prompts, and `harness-rules.py` drops the unpinned rules an earlier setup recorded |

## Round 8 — shepherding

| Key | Recommended | Unlocks | Exposes | Other options | Rules |
|---|---|---|---|---|---|
| `pr-update-branch` | yes | behind-main PRs refreshed server-side before merge | a new CI run. _Reach_: any PR | ask | `Bash(gh pr update-branch *)` |
| `pr-conflict-unreviewed` | yes | DIRTY PRs fixed and re-reviewed without a round-trip | a resolution nobody else has read yet | ask | — |
| `pr-conflict-reviewed` | ask | — | a silent resolution can revert a reviewer's merged work | yes | — |
| `ci-rerun` | yes | a cancelled run or known flake retried, completed runs only | CI minutes; a rerun on a live run cancels it. _Reach_: any run; the skill checks it completed | ask | `Bash(gh run rerun *)` |
| `ci-protection` | ask | `/desk-ci protection` restores a snapshot, pins required checks to GitHub Actions and makes the default workflow token read-only; each change is printed in full first and applies only by its plan id | a wrong protection write can block every merge or let one through unchecked; a snapshot taken first restores it | yes · no (the plans still print; nothing applies) | — (the script reads the row; `node desk-ci.mjs` keeps prompting) |

## Round 9 — autopilot (say the plain explanation first)

| Key | Recommended | Unlocks | Exposes | Other options | Rules |
|---|---|---|---|---|---|
| `autopilot-workers` | yes | a named batch worked in parallel while you are away | headless agents acting as you with nobody watching, within your grants | no | `Bash(node ~/.claude/desk/bin/pass.mjs *)` `Bash(node ~/.claude/desk/bin/plan-batch.mjs *)` `Bash(node ~/.claude/desk/bin/expand-parent.mjs *)` `Bash(node ~/.claude/desk/bin/queue.mjs *)` `Bash(node ~/.claude/desk/bin/answer.mjs *)` `Bash(node ~/.claude/desk/bin/decisions.mjs *)` `Bash(node ~/.claude/desk/bin/harvest.mjs *)` `Bash(node ~/.claude/desk/bin/desk-env.mjs *)` `Bash(desk-env *)` `Bash(~/.claude/desk/bin/triage.sh *)`. The skills invoke the scripts in exactly these forms (never through a `$B/` variable, which no rule matches). Never `with-lock.sh` (it runs whatever command it is given) and never the scripts `pass.mjs` runs itself |
| `autopilot-worker-mode` | dontAsk + generated allow-list | writes scoped to the worker's own worktree, every other worktree denied, a preflight proves it | anything on the allow-list runs without a prompt | none | — (workers get their own settings file) |
| `autopilot-merge` | yes (only with `pr-merge-green` yes; `ask` where §4 Branch protection is `none`, and the question says this repo is unprotected) | serial merge driver: each PR merges when green, then the next colliding ticket starts | PRs merge while you are away | ask · no (PRs wait for you) | owners `autopilot-workers` + `autopilot-merge`: `Bash(~/.claude/desk/bin/merge-driver.sh *)` |
| `batch-base-push` | ask | a batch on a base branch starts each worker on a current tree: before a pass spawns, the default branch is merged into the base and pushed. A feature-mode batch whose base has no commits beyond the default branch also pushes one empty commit there, so its draft promotion PR can open, and its base gate merges the default branch in once more before it checks the base | pushes to a shared branch while you are away; a merge commit or an empty commit only, never a rebase or a force | yes · no (the base is not synced; a feature-mode batch then spawns nothing, and opens no promotion PR on a base with nothing beyond the default branch) | — (the script reads the row; `ask` is one approval per batch, passed as `AUTOPILOT_BASE_PUSH_APPROVED=1`) |
| `autopilot-judgement` | yes | every call outside the ask categories (money, legal, production data or credentials, customer copy where length means cost, facts only you hold) taken on its recommendation and logged, instead of parking the batch | a call you might have made differently; you can overrule | no (park and ask) | — |
| `autopilot-usage-resume` | no (a worker at the limit is stopped and parked with the reset time) | a worker that reaches the 5-hour usage limit waits for the reset and carries on, so an overnight batch keeps going | the next 5-hour window is spent while you are away, and it is account-wide: your own sessions share it | yes | — (the script reads the row; unset is `no`) |

## Round 9b — what an autopilot worker may run (skip when `autopilot-workers` is `no`)

These write no harness rule: `worker-settings.mjs` reads them when each worker spawns, and anything
short of `yes`, unset included, is refused to the worker, which parks naming the row.

| Key | Recommended | Unlocks | Exposes | Other options | Rules |
|---|---|---|---|---|---|
| `worker-dependency-install` | ask | a ticket that needs a new package, or a lockfile sync (`uv sync`), finishes instead of parking | the package's install scripts run on your machine with nobody watching, and the lockfile change ships in the PR. Never global, another directory or project, or a `..` path; `remove` and the one-off runners (`npx`, `dlx`) stay refused | yes · no | — (the script reads the row) |
| `worker-screenshots` | ask | before/after evidence for UI tickets without a park: Playwright, Storybook or a Python script, from the worker's own worktree, under the browser lock | a script the worker wrote runs a headless browser against your local servers. Unset or not `yes` also refuses the Playwright capture workers used to be given, so a UI repo wants `yes` | yes · no (UI tickets park at Stage 5) | — (the script reads the row) |
| `worker-local-services` | ask | a worker starts a §4 Local services entry it needs, by the name each item starts with, in the main checkout's compose project (`docker compose -f <main checkout>/compose.yaml [-f <its override>] up -d --no-recreate --no-deps <service>`; nothing where its `.env` sets `COMPOSE_FILE`) | a shared container started while you are away. Stopping, removing or recreating one stays refused, since another session may be using it, and so does starting it from a worktree, which would make a second stack (skip, writing `no`, when §4 Local services is `none`) | yes · no | — (the script reads the row) |

## Round 10 — shared state

| Key | Recommended | Unlocks | Exposes | Other options | Rules |
|---|---|---|---|---|---|
| `autopilot-reclaim` | yes | a batch survives memory pressure | an orphaned server or `tsc` is killed (never a worker mid-commit, never another session's) | no (batch drops concurrency only) | — |
| `db-per-ticket` | yes | isolated seeds, migrations and screenshots | disk, invisible to other sessions | ask | — |
| `db-clone-staging` | yes | real staging data locally (skip when §4 Local database or Staging is `none`) | reads live staging under load; the copy holds real personal data | ask · no | — |
| `staging-write` | ask + backup + independent review | data fixes on staging | data others depend on | no | — |

## Round 11 — local

| Key | Recommended | Unlocks | Exposes | Other options | Rules |
|---|---|---|---|---|---|
| `local-reindex` | ask | a shared local index or cache (§4 Local services) reflects your change | it is shared: every session's copy is rebuilt (skip when §4 Local services is `none`) | no | — |
| `tests-shared-db` | no | database-backed tests without a per-ticket DB | test setup that truncates or deletes wipes another session's data | ask | — |
| `worktree-remove` | yes | disk back (~4GB per worktree) | untracked files, local state | ask | — |
| `branch-delete` | no | tidy branch list | `-D` discards commits `-d` refused to | ask | — |

## Round 12 — other

| Key | Recommended | Unlocks | Exposes | Other options | Rules |
|---|---|---|---|---|---|
| `server-stop` | ask | ports and memory back | a server another session may still be using | yes · no | — |
| `skills-edit` | ask | fixing a skill mid-task | a change that steers every future session | yes · no | — |
| `vercel-env` | ask | env changes without waiting on the owner | a production auth boundary; tell the owner either way | no | — |
| `slack-draft` | yes | a drafted message sitting in your Slack composer | nothing is sent. _Reach_: a draft in any channel or DM | ask · no | `<slack>slack_send_message_draft` |

## Round 13 — guards

| Key | Recommended | Unlocks | Exposes | Other options | Rules |
|---|---|---|---|---|---|
| `merge-feedback-first` | yes | no reviewer comment is merged past unanswered | a green PR waits while its feedback is worked | no (the gate alone decides; feedback is still worked and reported) | — |
| `jira-others` | no | reconcile sweeps could act on others' tickets | narrating or closing someone else's work as you | ask | — |

## Round 14 — your day, read (`/desk-checkout`)

| Key | Recommended | Unlocks | Exposes | Other options | Rules |
|---|---|---|---|---|---|
| `read-transcripts` | yes | the story behind the day's work: what you chased, what got found, work that never became a PR | your prompts and Claude's replies from every session that day, including sessions in other repos (the check-out lists those rather than posting them) | ask · no | — (the collector runs from a `$S/` path, which no allow rule matches) |
| `read-calendar` | yes | the meeting lines, and the decisions from meeting notes in your Gmail (e.g. Gemini's) | event titles and attendees; the notes carry everything said in the meeting, HR and personal matters included (the check-out leaves those out). _Reach_: the rule lists events on any calendar shared with you, colleagues' included, not only your primary | ask · no | `mcp__claude_ai_Google_Calendar__list_events`. Gmail keeps prompting: `search_threads` and `get_thread` open the whole mailbox |
| `read-slack-own` | ask | asks and agreements you made in DMs, which often carry the day's decisions | the other side of each DM too. _Reach_: the search can match anyone's messages in your DMs and private channels | yes · no | — (`slack_search_public_and_private` reaches past your own messages) |
