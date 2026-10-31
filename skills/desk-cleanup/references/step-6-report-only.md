# desk-cleanup step 6: Report only

Read at the start of step 6. The config, ownership, the order, the precondition, what is never touched, the confirmation and the red flags every step shares are in
`../SKILL.md`, already loaded.

## 6. Report only — never acted on

Ports in use, what is serving them **and its RSS** (a bare `3007 · next-server` line reads as "busy,
leave alone" while hiding 6 GB) · live session count and their MCP overhead · swap · local branches
with no worktree (see 3) · caches · stale `<handoff dir>/<TICKET>` folders (config §2) for merged
tickets · anything odd, like two worktree naming conventions coexisting.

**The auto-memory index.** Claude Code loads the repo's `MEMORY.md` (in
`~/.claude/projects/<repo root, each non-alphanumeric character as ->/memory/`) into every session
and worker on every call, so an index that has grown into a document costs all of them. Run
`cleanup-scan.mjs memory-index --repo <repo root>` and copy its lines into the plan as they are. It
prints nothing when the file is within 6 KB and 60 lines, or when the repo has no memory directory.
Its second line names the entries that run past one line: those are the ones to move into their own
memory files. Report only: never rewrite a memory file here.

**Never quote a per-worktree `du` figure.** Package managers that link `node_modules` from a global
store (§4 Package manager; the reference says which do) make `du` over one worktree overcharge it and
`du` over several undercharge all but the first. Measure the containing directory once, expect ~1 GB
marginal per worktree rather than the full per-tree figure, and on macOS quote the `df` change
instead. Detail and cache sizes in the reference — caches are only worth touching when `df` shows
under ~15% free.
