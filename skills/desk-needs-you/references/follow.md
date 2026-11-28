# A `follow` item: try it before asking

A `follow` item's need gives one `Check:` per step a merged PR left, naming the §3 row a step needs
and that row's value; a step with none names no row. Settle each step yourself where you can, before it reaches the user. This is the one
read beyond the script:

- **The PR already covers it**: where the merged PR's Testing or its checks show the step working,
  it is covered. Name the test or check. The `done` action names the PR (`PR #<n>'s own checks`):
  read it with `gh pr view <n> --repo <owner/name> --json body,statusCheckRollup`. Where it names no
  PR number, no step is covered by the PR.
- **You can run it**: where its row is `yes`, or it names no row and the step only reads (a page
  loads, a record exists), run it with the tools this session has (the signed-in browser, `gh`, the
  repo's own scripts) and note what it showed.
- **Anything else stays the user's**: a row short of `yes` is never run, and a step that failed when
  you ran it is theirs too, with what you saw.

A step that only reads CI, desk's logs or desk's state is run after the merge by desk's follow-step
checker, and reaches this list only when it failed: its `Check:` then says what the checker found and
its evidence (a run URL or a file). Read that evidence before running it again; a failure the evidence
confirms is the user's. One no checker passed or failed within two hours of its code going out (the run
it reads was still going, or no pass started a checker) is listed too, its note saying so: run it as any
other step. Each checker step is an item of its own (`follow:<KEY>:checked:<id>`, after any gate), as
is a step that waits a set time after the merge (`follow:<KEY>:later:<id>`), so `done` on one item never
settles a step another holds.

Before you start running steps, take the item on, so desk-q shows it as `checking (<session>)` and
leaves it out of the user's count meanwhile: `node ~/.claude/desk/bin/needs-you.mjs claim <repo>
<item> --by <your session id>`. The claim ends with `done`, or once your session has been idle past
§3b Release idle claims after (hours). Claim only an item you are about to run: while the claim lasts
it is off the user's list, so a step you then leave to them is asked in this session.

When every step ran clean, `record` the item `done` without asking, and say what each run showed.
Otherwise ask, and say in the question which steps you settled and how. Where the PR's evidence
covers every step you did not run clean, offer `done` as recommended, naming the test or check: the
user closes it on that evidence, never you.
