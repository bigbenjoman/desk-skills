# desk-clearance phase 1: Derive state

Read at the start of phase 1, or earlier where the core's Phases section says. The config, ownership, what config
§3 decides, the merge bar, parking and the red flags every phase shares are in `../SKILL.md`, already
loaded.

### 1. Derive state — one call, never per-PR

```bash
node ~/.agents/skills/desk-clearance/bin/clearance-state.mjs derive
```

~8s for the whole set. Zero open PRs is an answer, not a failure: it exits 0 and says on stderr
which search it ran. Run it from inside the repo: the repo and its config come from the origin
remote. It writes `~/.desk-clearance/<slug>/state.json` and renders a table: lane per PR,
verdict, human feedback counts, required-check state, behind-count, park reasons, stack and
auto-merge flags, file overlap, merge order. Author comes from `--author` → `DESK_GITHUB_HANDLE` →
§1 GitHub handle → `gh api user`; the GitHub repo from the origin remote → §0 GitHub repo; the
local checkout from `--repo` → §2 Primary repo root. It dies rather than default any of them. Its
header names the required checks it read, where from, the merge method, and any drift from config.

**The traps live in that script, not in your head** — verdict derived ignoring `COMMENTED`, bots
filtered out, required checks read live from the ruleset and branch protection and asserted
positively, a base other than the default branch flagged, a foreign-authored base named, truncated lists refused. It exits non-zero on any failed
query. **A failed query is never a clean answer**: fix it or park. Never fall back to hand-rolled
`gh` calls with `2>/dev/null`, which is how an expired token becomes "no reviews found". A hand
call that disagrees with the script is wrong until proven otherwise (`gh api` stops at 30 rows
without saying so; always `--paginate`).

Re-derive after every merge, and at the start of every pass. Each derive keeps the last, so a loop
asks what moved:

```bash
node ~/.agents/skills/desk-clearance/bin/clearance-state.mjs diff
```

A change in verdict, feedback or threads is worth a pass. A lone gate or head change usually is
not, and `mergeable` never is — it flaps to `UNKNOWN` every time the default branch moves.
