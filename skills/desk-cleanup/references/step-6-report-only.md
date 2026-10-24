# desk-cleanup step 6: Report only

Read at the start of step 6. The config, ownership, the order, the precondition, what is never touched, the confirmation and the red flags every step shares are in
`../SKILL.md`, already loaded.

## 6. Report only — never acted on

Ports in use, what is serving them **and its RSS** (a bare `3007 · next-server` line reads as "busy,
leave alone" while hiding 6 GB) · live session count and their MCP overhead · swap · local branches
with no worktree (see 3) · caches · stale `<handoff dir>/<TICKET>` folders (config §2) for merged
tickets · anything odd, like two worktree naming conventions coexisting.

**Never quote a per-worktree `du` figure.** Package managers that link `node_modules` from a global
store (§4 Package manager; the reference says which do) make `du` over one worktree overcharge it and
`du` over several undercharge all but the first. Measure the containing directory once, expect ~1 GB
marginal per worktree rather than the full per-tree figure, and on macOS quote the `df` change
instead. Detail and cache sizes in the reference — caches are only worth touching when `df` shows
under ~15% free.
