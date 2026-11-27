# Skill evals and benchmarks

> Part of the [desk-skills docs](README.md). Back to the [main README](../../README.md).

Tools for measuring whether a skill earns its place and how different models and settings do on real merged tickets, each with hard spend caps.

**`skill-eval.mjs`** runs a task set once with a skill loaded and once without it, so prose that
only restates what the model now does by default can be found. Each task is a prompt with pass/fail
checks on the final reply (`contains`, `absent` or `matches` a regex). Both arms run `claude -p`
with no setting sources, so no installed skill reaches either, in an empty directory of their own;
only the skill arm gets the skill's `SKILL.md`. The report lists each task's checks for both arms
side by side and ends with one verdict: **keep** (the skill arm passed more), **trim** (the same
number, with the transcripts linked to read) or **drop** (fewer). A run that fails or times out is
marked failed and counted neither way. It refuses to start without `--max-budget-usd`, each run's
spend ceiling. `--total-budget-usd` (default 5) caps the whole eval: a task starts only while both
its runs fit under what is left, and any task left unstarted is named in the report, which then
gives no verdict. The figures are claude's reported cost, so on a claude.ai subscription they are
plan usage, not a charge:

```
node ~/.claude/desk/bin/skill-eval.mjs --skill <name|dir> --tasks <tasks.json> --max-budget-usd <usd> \
  [--total-budget-usd 5] [--skills-dir skills] [--out <dir>] [--timeout 600] [--model <model>]
```

`evals/desk-pr.json` is desk-pr's task set; its last report is `docs/evals/desk-pr/report.md`.

**`bench.mjs`** runs named arms over frozen tasks taken from real merged tickets. Each run gets a
throwaway checkout of the task's repo at the commit the ticket started from: a repository of its
own with no remote and no later history, so the merged fix is not there to read and there is
nowhere to push. The merged PR's tests are kept outside it (a test file the PR changed is there in
its base version, as the ticket's worker found it) and copied in only after the run, then
run with that repo's §4 Unit tests under the test lock. The task is **accepted** if every one
passes and **rejected** if one fails. A run that errors, times out or is stopped is **failed**,
which counts as neither. Each test command gets an hour from when it holds the test lock; the wait
for the lock is not counted. Arms run on a worker's permission set for that repo with gh, Jira, the web
and pushes taken out. Any attempt to push, open a PR or reach Jira is recorded in that run's
result. Arm order is shuffled per task from `--seed`, and prompt caching stays at the CLI's
default. A result scored at the same base and arm settings is reused. Each run keeps its diff, its
stream-json transcript, its test output and its tokens (uncached, cache write, cache read, output)
under the output folder. Its `result.json` also has `ran_at`: the model and effort read back from
the session's own init event. A value the log does not name is null, with the reason, and is never
filled in from the arm's settings:

```
node ~/.claude/desk/bin/bench.mjs --tasks <tasks.json> --arm <name>[=<model>[:<effort>]] [--arm …] \
  --max-budget-usd <usd> [--total-budget-usd 5] [--out <dir>] [--timeout 1800] [--seed <n>] \
  [--plans <file>] [--providers <file>]
```

Keep the task set outside this repo, under `~/.config/desk/bench/`, which `desk-disk` and
`desk-cleanup` never remove. The frozen desk-skills set (the DS-535 PRs) is kept at
`~/.config/desk/bench/ds-535/`, as `tasks.json` with its hidden tests beside it. Its paths are
relative to the file:

```json
{"tasks": [{"id": "ds-123", "repo": "owner/name", "base": "<full SHA>", "prompt": "<ticket text>",
  "hidden_tests": {"dir": "hidden/ds-123", "files": ["tests/test_x.mjs"]}}]}
```

`hidden_tests.run` (default: every file) names the files handed to the test command; the rest,
such as fixtures, are only copied in.

The bench spends at most a set share of each weekly allowance and always leaves a reserve for your own
work. Before each run it reads the weekly use of the account the run will spend: for Claude, a usage
probe on that login; for an arm on a GPT or Codex model, the signed-in Codex login's session logs.
It stops before the run, naming the account, when the bench has used its cap of points in this
weekly window, when less than the reserve is left, or when the reading is missing, older than 30
minutes or cannot be parsed. A missing reading is never read as zero. The whole rise in weekly use
during a run's session, other work on that account included, is that run's `quota.points` in its
`result.json`; the reading is taken again once the session ends, before the hidden tests are scored,
so a long wait for the test lock is not counted, and is kept per computer in `<usage dir>/bench-quota.jsonl`. The points are printed at
every stop and in the report. Run it again once the window resets and it picks up at the first task
and arm not yet scored. The cap and reserve are per computer, set as the machine profile's Sizing rows
`bench-cap-points` and `bench-reserve-percent` (unset: 10 points and 25%), which `/desk-setup` asks
for once per computer and stores with `desk-env machine set`, which starts a profile holding only them where there is none. A value that is not a number refuses to
start.

An arm on OpenCode Go (model `opencode-go/<model>`) has no meter to read: each Go response
reports only `opencode.allowance`, the dollars that request counted against the model's monthly
limit. So the guard adds up the allowance the bench's own runs on that model recorded over rolling
windows of 5 hours, 7 days and 30 days. It measures each window against the model's monthly limit in
the plan table (below; `--plans <file>`, default `<out>/plans.json`), read from the longest `usd`
window on the row serving the model. The 5-hour window is 20% of that limit, the week 50% and the
month 100%, and the cap and reserve apply to each window. A run's `quota.points` is its share of the
weekly window, and `quota.windows` holds its share of each window. Every stop line and report row
for Go says it counts the bench's own use only, since use of the plan outside the bench is invisible
to it. The bench stops before the next run on that model, naming the model and the reason, when a
response's allowance is missing, is not a finite non-negative number or has a shape it does not know,
or when no plan table row gives the model a monthly limit. A run whose allowance was never recorded
holds that model's runs until the run is 30 days old. An arm on any other `<provider>/<model>` has no
meter and no ledger, so it is refused unless the machine profile gives that provider a run limit,
the most runs a week the bench may start on it: `desk-env machine set bench-run-limit-<provider>=<runs>`.
Either kind of arm also needs a runner that sends its runs to that provider, and a Go one that records
each response's allowance. An `--arm` from the command line has one only as an endpoint arm (below);
otherwise it would run on claude, so the bench refuses it.

An endpoint arm runs Claude Code itself against the provider's Anthropic-compatible endpoint, so the
task, brief, sandbox and scoring are the Claude arms' and only the model differs:
`--arm go-kimi=opencode-go/kimi-k3.1-pro`. The provider needs an entry in the providers file
(`--providers <file>`, default `bench-providers.json` in the desk usage dir, beside
`bench-quota.jsonl`):

```json
{"providers": {"opencode-go": {"base_url": "https://opencode.ai/inference/go/anthropic",
  "key_file": "~/.config/desk/opencode-go.key", "session_header": "x-opencode-session"}}}
```

`headers` (name to value) are sent with every request, and `session_header` with one new id per run.
Before any run, the bench refuses an arm whose entry is missing, whose base URL is unset or
Anthropic's, or whose key file is missing, empty or open to group or others (fix: `chmod 600`).
Claude runs on that endpoint with the model after the slash, behind a local forwarding proxy
(`endpoint-proxy.mjs`) that alone reads the key: claude, and every command the model runs, hold only a
token made for that run, which the proxy swaps for the key on each request it sends on, and the arm's
settings deny the key file and its folder to every tool, by absolute path and by `~` and `$HOME`. Its environment holds no Claude credential and its `CLAUDE_CONFIG_DIR` is a
fresh empty folder, checked again just before it starts, so the run cannot bill a Claude login. Its
tokens come from the session's own log. Its USD figure is claude's pricing at Anthropic's rates, so it
is kept as `claude_priced_usd`, its `cost` is null, and it spends none of `--total-budget-usd`. On
OpenCode Go, the proxy also records each response's `opencode.allowance` for the guard.

**`bench-build.mjs`** writes that task set from merged PRs. For each one it records the base and
merge commits and the ticket its title or branch names. It keeps the ticket's key, size, summary and
description as they read when the PR's first commit was authored: later edits are undone from the
Jira changelog, and comments are never read. A ticket created after that commit is dropped, since
all of its text came after the work. The size is the Size field's, else a first description line
`Size: M`. The PR's added or changed test files at the merge go to `<set dir>/<task id>/hidden/`,
where the task id is `<owner>__<name>-<n>`. A task is kept only if those tests fail at the base and pass at the
merge, run as `bench.mjs` scores them. A PR with no test changes is skipped. The rest are dropped
with the reason: tests that pass at the base, fail at the merge, or cannot run. The file counts the
tasks per repo and per size, and lists the dropped PRs. A PR already in the set, kept or dropped, is
left alone unless `--rewrite` is given, so a frozen set stays frozen:

```
node ~/.claude/desk/bin/bench-build.mjs --set <tasks.json> --pr <owner/name>#<n> [--pr …] [--rewrite] [--timeout 3600]
```

```json
{"tasks": [{"id": "names-the-ticket", "prompt": "…", "checks": [{"name": "title has the key", "matches": "DS-[0-9]+"}]}]}
```

**`bench-blind.mjs`** turns a bench run into blind scoring sheets. `export` reads the output
folder's `run.json` and writes, under `<out>/blind`, one Markdown sheet per task in `sheets/`: the
ticket text, the rubric (`desk/bin/bench-rubric.md`, or `--rubric <file>`) and every arm's diff
under a letter drawn at random per task, with an arm that made no diff, or whose run failed, shown
as "no change produced". Names of models, arms and efforts in a diff (a co-author trailer, a comment, a branch
name) become `[redacted]`. It also writes `scores.csv`, a `task,letter,score` template with the
scores blank, and `key.json`, which maps each letter to its arm and is named by no sheet. Fill in
each score from 1 to 5, then `join` attaches them to the arms through the key and writes
`joined.json`. A sheet with a missing, out-of-range or unknown score is listed and none of its
scores count:

```
node ~/.claude/desk/bin/bench-blind.mjs export --tasks <tasks.json> [--out <dir>] [--dest <dir>] [--rubric <file>]
node ~/.claude/desk/bin/bench-blind.mjs join --tasks <tasks.json> [--out <dir>] [--dest <dir>]
```

**`bench-report.mjs`** writes one report per bench run to `<out>/report.md`, with each arm beside the
Phase 0 baseline. For each arm it shows the tasks accepted out of the tasks run, the mean blind score
from `joined.json`, and the runs that failed, which count in no other figure. Per accepted task, it
gives the median uncached input, cache-write, cache-read and output tokens, and the median quota
points per account. Over every scored run, accepted or rejected, it gives the median cache-write
tokens and the median input-equivalent tokens: each kind of token at its list price for the arm's
model, as uncached input (cache writes at the 5-minute rate), or "not priced" for a model desk has no
prices for. The baseline column comes from `phase0-report.mjs`'s output saved as
`<out>/phase0-baseline.txt` (or `--baseline <file>`). It holds the baseline's tokens per accepted
ticket, its 7-day quota points divided by the tickets it accepted, and its fix tries per accepted
ticket, and it names the baseline's last day. With no baseline, the column reads "no baseline" and
the report gives the command that produces one. Until the scores are joined, the score reads "not
scored". A run the cap or budget never started is listed as not run. When the arms did not run the
same tasks, the report puts no two arms side by side: each arm gets its own table beside the
baseline.

Each arm also shows £ per accepted task and accepted tasks per 5-hour window, priced from the plan
table at `<out>/plans.json` (or `--plans <file>`), which you write by hand from each provider's own
page. Each plan row gives its provider, plan, monthly price and currency, the date and URL the price
was read from, its windows (`{ name, hours, size, unit }`), and the arms or models it serves; a
served entry may carry its own windows where the plan's allowance is per model. The table's `rates`
list gives each other currency's rate to GBP and the date it was read. Accepted tasks per 5-hour
window is that window's size over the arm's median use per accepted task. £ per accepted task is the
monthly price in £ over the accepted tasks a month of windows allows at that use, the tightest
window binding. The bench records use only in `weekly points`, so a window in any other unit reads
"not measured". An arm with no plan, or a price with no rate, reads "not priced" and the report
names why; a price read over 31 days ago is flagged stale. The report states figures and gives no
verdict:

```
node ~/.claude/desk/bin/phase0-report.mjs --days 7 > <out>/phase0-baseline.txt
node ~/.claude/desk/bin/bench-report.mjs --tasks <tasks.json> [--out <dir>] [--blind <dir>] [--baseline <file>] [--plans <file>]
```

**`bench-replay.mjs`** asks whether the spawn preflight and the decider need Opus. It samples
calls Opus answered in the last `--days` from every batch of this repo (or each `--state`): a
preflight's record under `<state>/preflight/`, which `spawn-worker.sh` writes on every spawn, and a
decider session's prompt and reply under `<state>/decider/`. A call whose files cannot be read, a
preflight from before they were recorded, and an answer that cannot be read line by line are left
out and counted. Each call is answered twice more. The no-model side is a script that answers from
the call's recorded inputs whatever needs no model and marks the rest "needs a model". The model
side (`--model`, Haiku by default, at low effort) is sent the same prompt: a preflight in a
throwaway checkout with the recorded settings and tools, a decider with no tools. Each model replay
goes through the bench's quota guard first. `<out>/replay-report.md` gives, per call type, each
side's share of answers that match Opus's, tokens per call and quota points, and lists every
mismatch:

```
node ~/.claude/desk/bin/bench-replay.mjs --out <dir> [--state <dir>]… [--days 7] [--sample 20] [--model haiku] \
  [--max-budget-usd 0.5] [--total-budget-usd 5] [--seed <s>] [--no-haiku]
```

**`bench-arm1.mjs`** runs arm 1: each task twice, as `filed` (the ticket text alone) and as `packet`
(the ticket text with its task packet after it), both on opus at medium effort, with nothing else
different. A task's packet is `<set dir>/packets/<task id>.md`, written from the ticket and the base
commit only, never from the merged PR. It names the entry points and consumers, the conventions to
reuse, the criteria the worker can check itself and the commands that check them. No arm may read
the packets folder. A task with no packet is skipped on both sides. A packet that quotes a line of the
task's merged diff or hidden tests is refused. Lines under 20 characters, or with no letter or digit,
do not count. Both kinds of task are named when the run starts and listed under "Left out" in
the report. The report then puts `filed` beside `packet`:

```
node ~/.claude/desk/bin/bench-arm1.mjs --tasks <tasks.json> --max-budget-usd <usd> [--total-budget-usd 5] \
  [--out <dir>] [--timeout 1800] [--seed <n>]
```

**`bench-arm-pack.mjs`** asks whether a start-4b stage pack saves quota: the first `--limit` tasks
(default 10) run as the baseline and as `pack-4b`, both on one model (`--model`, default `opus`) at medium effort, the second with the
start-4b pack appended to its system prompt, so it is in context from turn 0. The pack is the skill
files a worker starting at Stage 4b reads, taken from the installed skills (`--skills`) and joined
with every paragraph an earlier file already holds dropped. Each pack run keeps it as `system.md`,
and its run key hashes it, so a changed skill file is a new run. The baseline arm keeps the name an
earlier run gave it (`--baseline-arm`, default `opus`), so its stored results are reused rather than
paid for again. The model is part of a run's key, so give `--model` the model the stored runs named:
the DS-535 baseline ran as `claude-opus-5-5`, which `opus` does not reuse. No arm may read the skills folder. `bench-report.mjs` then puts the two side by side:

```
node ~/.claude/desk/bin/bench-arm-pack.mjs --tasks <tasks.json> --max-budget-usd <usd> [--total-budget-usd 5] \
  [--out <dir>] [--timeout 1800] [--seed <n>] [--limit 10] [--baseline-arm opus] [--model opus] [--skills <dir>]
```

**`skill-ride.mjs`** measures what such a pack would replace. For each start stage, over the worker
logs of the last `--days` (default 14), it prints the sessions, the bytes they read from skill files
and the mean remaining-turn fraction of those reads: a Read at turn i of n rides the n - 1 - i turns
after it, where a pack loaded at turn 0 rides them all. The byte-weighted mean is the share of the
read bytes that rides the rest of the session. A session is one spawn, from `spawn-worker.sh`'s
`desk_spawn` event to the next, and only the main thread's Reads count. It reads every batch's logs
(the standing batch, named and archived ones) unless `--logs` names the folders. `--files <stage>`
lists that stage's skill files instead:

```
node ~/.claude/desk/bin/skill-ride.mjs [--days 14] [--logs <dir>]… [--skills <dir>]… [--files <stage>]
```

**`bench-arm2.mjs`** runs arm 2, a shadow Codex review seat against the current Opus finder seat, on
the frozen tasks with real defects put back. `seed` takes a CSV of review findings (`repo`, `pr`, `file`,
`line`, `acted_commit`, any other columns kept) and reverts, onto each task's merged tree, the hunk of
the acting commit at the finding's file and line. It records each seed in `<set dir>/seeds/<task id>/`
and lists each finding it could not revert cleanly with the reason. A run gives `current` and `codex`
each their own checkout holding the seeded change and the same brief, written from desk-review's
files. Neither is told about the seeds. The Codex seat runs through `codex-exec.mjs`, read-only, at the
finder effort in the repo's §3b Codex review and at this command's `--timeout`. A run that times out or
fails is marked failed and none of its findings are scored. A finding inside a seeded hunk is a hit. Any
other is listed in the report with an id, and counts only once you mark it `real` or `false-alarm`:

```
node ~/.claude/desk/bin/bench-arm2.mjs seed --tasks <tasks.json> --findings <findings.csv> [--seeds-dir <dir>] [--rewrite]
node ~/.claude/desk/bin/bench-arm2.mjs --tasks <tasks.json> --max-budget-usd <usd> [--total-budget-usd 5] \
  [--seeds-dir <dir>] [--out <dir>] [--timeout 1800] [--seed <n>]
node ~/.claude/desk/bin/bench-arm2.mjs report --tasks <tasks.json> [--out <dir>]
node ~/.claude/desk/bin/bench-arm2.mjs mark --tasks <tasks.json> [--out <dir>] <id> real|false-alarm
```

**`bench-arm3.mjs`** runs arm 3: each task on four implementers, `codex-medium` and `codex-high`
(Codex Sol, `gpt-6.1-sol`, at medium and at high effort), `opus-medium` and `sonnet` (at the CLI's
default effort), each in its own checkout at the task's base. A Codex side runs through
`codex-exec.mjs`, the same call `desk-codex` makes: stdin closed, its final message saved as
`last-message.txt`, ended at `--timeout`, and the model and effort passed on the command line. Its
sandbox is `workspace-write` on the checkout, with no network and no writable `/tmp`, so it can write
only there. It runs on the Codex login whose weekly reading the quota guard takes before and after,
and spends none of the USD budget. Its tokens come from its own session log, kept as
`codex-session.jsonl`. Every tool call the sandbox refused is listed under `refusals` in its
`result.json`, and the run is still scored on its hidden tests. The report gives the Claude and Codex
allowances separate rows.

`--fable` adds a fifth side, `fable`, on Claude Fable. Before you use it, confirm usage credits are
switched off in the settings of every Claude account desk signs in with. A headless request that
would bill them goes through without asking, so the side also checks for itself: it probes each
login, and refuses before anything runs unless every login's newest reading shows overage rejected
for a reason other than `out_of_credits`, naming any login that does not and its reading. It checks
again before each Fable run. A run whose log records `isUsingOverage` is ended, no further Fable run
starts, and the task and account are printed and listed in the report:

```
node ~/.claude/desk/bin/bench-arm3.mjs --tasks <tasks.json> --max-budget-usd <usd> [--total-budget-usd 5] \
  [--out <dir>] [--timeout 1800] [--seed <n>] [--fable]
```

**`bench-pr-text.mjs`** runs arm 4: each task's PR description written three ways from the same
inputs (the ticket, the commit subjects, the changed files and the repo's PR template at the base).
`opus` (medium effort) and `haiku` also get the merged diff, and run with no tools in an empty folder
under the bench's quota guard and USD budget. `no-model` fills the template with no model call. A repo
with no PR template gets desk-pr's Summary, Changes and Testing sections. Each description goes through
the repo's §4 PR-description checks in a checkout at the base; a repo with none reads "no checks
configured", not a pass. A task with no merge commit is left out and named. Results go to
`bench-pr-text-out` beside the task set, apart from the code arms'. `bench-blind.mjs --out <that
folder>` makes the sheets, showing descriptions under random letters against
`desk/bin/bench-pr-text-rubric.md`. After `join`, `report` writes `<out>/report.md`, with each side's
check pass rate, mean blind score, tokens per description and quota points:

```
node ~/.claude/desk/bin/bench-pr-text.mjs --tasks <tasks.json> --max-budget-usd <usd> [--total-budget-usd 5] \
  [--out <dir>] [--timeout 1800] [--seed <n>]
node ~/.claude/desk/bin/bench-pr-text.mjs report --tasks <tasks.json> [--out <dir>] [--blind <dir>]
```
