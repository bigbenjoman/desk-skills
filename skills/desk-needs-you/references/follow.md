# A `follow` item: try it before asking

A `follow` item's need lists the steps a merged PR left, each with the §3 row it needs and that
row's value. Settle each step yourself where you can, before it reaches the user. This is the one
read beyond the script:

- **The PR already covers it**: where the merged PR's Testing or its checks show the step working
  (`gh pr view <n> --repo <owner/name> --json body,statusCheckRollup`), it is covered. Name the test
  or check.
- **You can run it**: where its row is `yes`, or it names no row and the step only reads (a page
  loads, a record exists), run it with the tools this session has (the signed-in browser, `gh`, the
  repo's own scripts) and note what it showed.
- **Anything else stays the user's**: a row short of `yes` is never run, and a step that failed when
  you ran it is theirs too, with what you saw.

When every step is covered or ran clean, `record` the item `done` without asking, and say how each
step was settled. Otherwise ask. Offer `done` as recommended where the PR's evidence covers what is
left, and say in the question which steps you settled and how.
