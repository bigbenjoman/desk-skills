# desk-ticket Stage 1: Branch

Read at the start of Stage 1, and no other stage's file with it. The config, the gates, "Ask or
take", the resume file and the red flags every stage shares are in `../SKILL.md`, already loaded;
a "below" here that this file does not hold points there.

| # | Stage | What happens |
|---|---|---|
| 1 | Branch | Off up-to-date `<default>`, named per §5 Branch names with `<TICKET>` in it, prefix from the issue type. Record the exact branch in the resume file: the PR is opened from it and is found by it (the autopilot merge driver matches a ticket's PR by its exact head branch and base `<default>`), so never rename it later. Worktree if another session is live, or lane C/D. **A new worktree then runs §4 Project subagents sync**, see below. |

**Where the ticket links a Claude Design artifact and no saved copy is committed on this branch
yet**, the canvas is saved here once the branch exists: read `design-canvas.md` (beside this file)
now if this session did not read it at Stage 0, as one resumed from the resume file has not.

**A new worktree can have no agents until you sync it (Stage 1).** Where the repo gitignores its
generated `.claude/agents/*.md`, a fresh worktree starts with that directory empty and every named
agent silently resolves to `general-purpose`: every review finder, and the same-vendor refuter the
review falls back to when codex is unavailable. Nothing warns you. First commands in a new worktree:

```bash
<§4 Project subagents sync>          # skip when it is `none`; then `ls .claude/agents/` is not empty
~/.claude/desk/bin/copy-env.sh       # §4 Env files from the main checkout; skip when that row is `none`
```

Env files go in before §4 Install, which can fail without them. If a review did run without the
agents, say so in the report header rather than letting it pass as a full fleet run.
