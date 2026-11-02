# desk-review Phase 0: preflight

Read when the review reaches Phase 0. The config, the bar, the entry points, every seat's prompt,
the round rules and the verdict are in `../SKILL.md`, already loaded; a "below" or "above" this file
does not hold points there or to another phase's file. Paths such as `references/gotchas.md` are
from the skill's directory.

## Phase 0: preflight

Four checks, **before any agent is dispatched**.

**0. A clean tree** (branch target only). `git status --porcelain` must print nothing. The finders
read committed diffs, so an uncommitted fix is never reviewed, and the round-end check below cannot
tell it from a finder's stray edit. Anything listed: stop with "commit first, then re-run". Never
stash or discard it for the author.

**1. Which GitHub account** (interactive; a worker skips this, since `gh auth` is denied to it and
its `gh` is already the user's). `gh auth status --active` and read the account line. It must be §1
GitHub handle. If it is not, stop and tell the user to switch it themselves
(`! gh auth switch --user <me>`). Never run `gh auth switch` for them: it changes their global
state, and a review posted under the wrong account is public. Never use a `GH_TOKEN=… gh` prefix:
workers deny it, and it is the pattern that posts to the wrong PR when a placeholder is empty.

**2. Whether codex may and can answer.** §3 `codex-review`:

- `yes`: probe it. `ask`: ask before this run sends anything to codex (the whole run is one use:
  one diff, its cold read and its refutations), then probe on a yes. `no`: skip the probe; the run
  is same-vendor (below).
- The probe, as **one `codex`-prefixed command**, bounded by your tool timeout (~120s), never by
  `timeout` (absent on stock macOS) and never grown a pipe, `if` or `$(…)` (a worker's `dontAsk`
  refuses a compound command before the shell runs, printing nothing):

  ```bash
  codex exec --sandbox read-only "Reply with exactly: CODEX_OK"
  ```

  Exit 0 with `CODEX_OK` is usable. `codex login status` proves nothing: it reports logged in on a
  seat that is out of usage. Non-zero names the cause (a usage reset date, `at capacity`). **No
  output at all** in a worker means the harness denied a mis-shaped call; if it printed `Reading
  additional input from stdin`, add `< /dev/null`.

**If codex is unusable, or §3 says `no`, stop and ask** (a worker does not ask; it falls back and
says so in `AUTOPILOT_DONE`):

> Codex is unavailable (`<the error>`, or "§3 codex-review is no"), so refutation would fall back to
> `ada-devils-advocate`, Claude checking Claude. A model shares its own vendor's blind spots, so
> more false positives would reach you marked CONFIRMED. Fix it with `! codex login`, or say
> **proceed** to run same-vendor.

On proceed, every finding is tagged `(same-vendor)`, the header says so, there is no codex cold
finder, and the verdict line carries `vendor=same-vendor`. A reader cannot tell from the word
`CONFIRMED` which kind of check produced it, which is why the choice is the user's.

**3. Whether the named agents resolve.** Each role below is a desk subagent installed user-level
(`~/.claude/agents/<name>.md`); a repo may override one in `.claude/agents/`. If a role's file is
missing in both places, and §4 Project subagents sync (`desk-env cmds agents-sync`) is set, run it once. Anything still missing
falls back to `general-purpose`, and the header says so:
`agents: general-purpose fallback for <roles>`. A fleet that silently became one model checking
itself must never read as a full run.

An autopilot worker gets these agents through `--agents` (spawn-worker.sh builds the file from the
installed agent files, and its preflight refuses to spawn when one is missing), so in a worker they
resolve like anywhere else. Record each seat's `agent` in the results file as the type you actually
launched: `verdict.mjs` writes the fallback line into the heading for every named seat that ran as
`general-purpose`.
