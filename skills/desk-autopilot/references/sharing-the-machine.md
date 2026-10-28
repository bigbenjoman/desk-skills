# desk-autopilot: sharing the machine

Part of desk-autopilot, read at Stage 0 before `init`, and for Stage 0b's handshake. It binds exactly
as the core `SKILL.md` does. Where it says "above" or "below" of something this file does not hold,
or cites a section in *italics* it does not hold, that is in the core or in the file the core's
reference table names.

## Sharing the machine

Assume you are never alone: the user runs interactive sessions alongside you and often a second
batch, possibly in another repo, so coordinate, and do not run out of memory on spikes such as test
runs or the PR image upload. Batch state is per repo; these four resources are machine-wide, and
each has cost a run.

**Handshake at Stage 0b, before any worker spawns.** `ListAgents`, then one `SendMessage` per live
session stating your repo and batch, worktrees, port range, the files your tickets touch, and your
test-lock and test-worker cap, and asking the same four back. Re-send when a new session appears.
What a peer says it holds beats anything you can measure, and a peer's heads-up ("full suite in five
minutes") is the only warning before a 10GB spike.

| Resource | Protocol |
|---|---|
| **Test suites** | One at a time machine-wide, via `~/.claude/desk/bin/with-lock.sh test --cwd <dir> -- <cmd>` (unit, integration, E2E; `<dir>` and `<cmd>` from `desk-env cmds test-cmd`) and `with-lock.sh tsc --cwd <dir> -- <cmd>` (same lock). No timeout, no bypass; waiting is the feature. Two database-backed integration runs also collide on their per-worker schemas for the whole run, so announce integration runs to peers. |
| **GitHub PR image upload** | One signed-in browser profile (config §2), so it is exclusive. `pass.mjs` serialises it *within* your batch; across sessions claim it by message before `upload-images.mjs` runs and release it by message immediately after. Screenshot *capture* uses Playwright's own browser and `with-lock.sh browser`, and is safely concurrent: do not serialise the wrong one. Never delete the profile's `SingletonLock`. |
| **Ports** | Yours start above the user's dev port. Publish your range, treat a peer's as claimed, and never kill a server you did not start however idle it looks. |
| **Files** | Exchange diff surfaces at handshake. `plan-batch` finds collisions inside your batch only; the cross-batch one can only come from the peer. |

**Probe the lock, do not trust it.** Test it once at Stage 0 with
`~/.claude/desk/bin/with-lock.sh test true`. If workers report it refused, serialise Stage 4
yourself (one worker in a suite at a time) and say in the report that the lock is not covering them.

**The memory rules are seeded, not remembered.** `queue.mjs init` backs up
`<state>/batch-notes.md`, resets it, and re-seeds `references/batch-notes-header.md`, so the test
cap and the lock survive an init. If another orchestrator is live, `init` keeps the file instead of
resetting it, because that batch's workers still read it. Check the `## MEMORY` heading is there
after `init`; if it is not, add `references/batch-notes-header.md` to the end of the file with the
Edit tool (Write if the file is missing), not a shell redirect. The rules also live in the worker
contract, which is never truncated.
