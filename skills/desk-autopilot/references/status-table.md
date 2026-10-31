# desk-autopilot: the status table and the batch report

Part of desk-autopilot, read at Stage 4 in the session before the first status table, and at
Stage 8. It binds exactly as the core `SKILL.md` does. Where it says "above" or "below" of something
this file does not hold, or cites a section in *italics* it does not hold, that is in the core or in
the file the core's reference table names.

## The status table

**Every state change gets a table, not a sentence** (unless the repo has set quiet, below), so the user can see each ticket and its state
whenever one moves. A prose line about the one ticket that moved makes the reader reconstruct the
other six from memory, and silence between spawn and PR reads as nothing happening.

Emit it whenever the status monitor fires with a real change: a spawn, a park, an unpark, a question
for the person, a PR landing, a merge, a failure. Not on memory jitter, and not on a pass that
changed nothing. **A worker stepping from one stage to the next no longer wakes you**: each wake
re-reads your whole context, and desk-q already shows every stage. The table printed on the next
real change carries each running ticket's current stage. `queue.mjs watch --stages` fires on stage
steps too, as it used to. A draft PR a worker opens while it carries on shows on its running row
once a pass finds it on GitHub (from Stage 7, kept as `draft_pr`), and a merge (`queue.mjs merged`)
marks the done row `merged`, so both wake you.

| Ticket | State | Stage | Port | Notes |
|---|---|---|---|---|
| ABC-1200 | 🟢 Running | 5/9 | 3001 | one line: the gate, blocker or decision that matters |
| ABC-1208 | ⏳ Queued | — | — | its position when the order was set deliberately |
| ABC-1166 | 🅿️ Parked | — | — | what unparks it |
| ABC-1181 | ✅ PR #NNN | — | — | the PR number once it exists |

- **Every ticket in the batch, every time**: parked and queued rows included.
- **Mark what changed** (an arrow, a bold cell) so the delta is findable without diffing.
- **Carry `vmmem=` and `avail=`** with it, since the ladder decision is read from those two numbers.
- **Notes stay to one line.** The full park reason lives in the queue.

**Quiet: config §3b "Orchestrator status table" `quiet`** (`desk-env get status-table`; unset is
`full`, the rule above). It applies to a batch run in the session: someone following the batch in
desk-q already sees every row, so the table twice in the session is only spent context. The status
watch then prints the table once at start and, after that, one line per ticket that changed (key,
old → new) with the memory line. On a spawn (or, with `--stages`, a stage step), reply in one line at most, with no
table, or not at all. Quiet removes repetition, never signal:

- **A park, a question for the person, a PR opening, a merge or a failure** still gets its line,
  naming the ticket and what it needs (what unparks it, the question, the PR number, the failure).
- **The Stage 8 batch report** carries the full table and the `WORKER COST` table, as at `full`.
- **Asked for the status**, print the full table (`queue.mjs render`, with `desk-env mem status`).

Any value but `full` or `quiet` reads as `full`: the watch's first line says the value was not
recognised; say that once to the person, and run the batch at `full`.

**The batch report (Stage 8) carries the batch's CI red rate.** Workers now run related tests rather
than full suites, so a rise in red PRs is the cost of that showing up. Once the batch has PRs, run

```bash
node ~/.claude/desk/bin/desk-ci.mjs batch-red      # the queue's finished tickets; --prs 12,13 for others
```

It measures those PRs exactly as `desk-ci measure` measures a window (a PR is red when any attempt
of any run on it went red) and compares the rate with the newest `measure` report for the repo, the
D6 baseline, in the main checkout's `.handoffs/`. Put its `batch:` and `baseline:` lines in the
report. **`RED RATE ROSE`** (more than 5 percentage points above the baseline, exit 1) is a finding:
say it first, with the PRs that went red, and do not lower it to a note. With no baseline it says so;
offer `desk-ci measure` rather than reporting the rate as normal.

**It counts the reviews that fell short too.** `batch-red` reads each PR's latest desk-review verdict
and prints `review:` lines: the PRs reviewed same-vendor and the PRs with a fallback seat, each
counted and listed, plus any whose review predates the method line (fallback unknown, never zero)
and any with no verdict. Put them in the report as printed.

**The batch report also carries what each worker cost.** The idle pass prints a `WORKER COST` table:
each worker's input and output tokens, cost in USD and wall time, summed over every round of it in
this batch, and a total row. Put the table in the report as printed. A worker whose log has no result event reads `unknown`, and
the total says how many it left out: report those as unknown, never as zero. The cost includes the
permissions preflight before each spawn, and the `preflight` column gives that part on its own; a
preflight that produced no result is named `unknown` there, never counted as zero. Each spawn line
of a pass says what its preflight cost too. Each row also gives
the worker's first-turn input (the prompt each run started on), and under it one line per stage
with the input and output tokens from that stage marker to the next; tokens before the first marker
are `start-up`. A worker whose log has no usage figures reads `unknown` there too.
