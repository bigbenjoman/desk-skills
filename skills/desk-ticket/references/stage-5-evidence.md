# desk-ticket Stage 5: Evidence

Read at the start of Stage 5, and no other stage's file with it. The config, the gates, "Ask or
take", the resume file and the red flags every stage shares are in `../SKILL.md`, already loaded.
How to capture is in `desk-ticket-working-style.md` ("Evidence") and `desk-pr`.

| # | Stage | What happens |
|---|---|---|
| 5 | Evidence | **Only if the change alters what renders, or what a server route, webhook or job does at runtime.** For a rendered change, confirm the running server's HEAD matches your branch, capture before/after to `<handoff dir>/<TICKET>/` (config §2), and delete the Playwright artefacts. For a server or webhook fix, the evidence is the request or log that shows the fix running, not only a screenshot. If neither applies, skip the stage and say so in one line. |

## Common mistakes at this stage

| Mistake | Consequence |
|---|---|
| Assuming the §3b Preferred dev-server port (`desk-env get dev-port`) is yours | Another session may own it; screenshots may be of another branch's code |
| Capturing evidence before Stage 4b | A confirmed finding means a code change, and every screenshot is then of the old build |
| `git stash` to stage the "before" shot after committing | It no-ops with nothing to stash, and stashes are shared across worktrees, so the "before" can be the fixed code. Use `git checkout HEAD~1 -- <path>` |
