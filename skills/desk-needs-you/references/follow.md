# A `follow` item: try it before asking

A `follow` item's need gives one `Check:` per step a merged PR left, naming the §3 row a step needs
and that row's value; a step with none names no row. Settle each step yourself where you can, before it reaches the user. This is the one
read beyond the script:

- **The PR already covers it**: where the merged PR's Testing or its checks show the step working,
  it is covered. Name the test or check. The need names the ticket, not the PR: find it with
  `gh pr list --repo <owner/name> --state merged --search "<KEY>" --json number,title`, then read it
  with `gh pr view <n> --repo <owner/name> --json body,statusCheckRollup`.
- **You can run it**: where its row is `yes`, or it names no row and the step only reads (a page
  loads, a record exists), run it with the tools this session has (the signed-in browser, `gh`, the
  repo's own scripts) and note what it showed.
- **Anything else stays the user's**: a row short of `yes` is never run, and a step that failed when
  you ran it is theirs too, with what you saw.

When every step ran clean, `record` the item `done` without asking, and say what each run showed.
Otherwise ask, and say in the question which steps you settled and how. Where the PR's evidence
covers every step you did not run clean, offer `done` as recommended, naming the test or check: the
user closes it on that evidence, never you.
