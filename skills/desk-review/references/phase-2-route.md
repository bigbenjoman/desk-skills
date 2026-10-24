# desk-review Phase 2: route

Read when the review reaches Phase 2. The config, the bar, the entry points, every seat's prompt,
the round rules and the verdict are in `../SKILL.md`, already loaded; a "below" or "above" this file
does not hold points there or to another phase's file. Paths such as `references/gotchas.md` are
from the skill's directory.

## Phase 2: route

No agents yet. Everything derives from the changed-file list. `references/gotchas.md#tiering` has
the jq and the path patterns, written to work across TypeScript and Python layouts.

**Tests are excluded first.** Spec, test, story, fixture and snapshot files never raise the tier.

| Tier | Fires on (production paths) |
| --- | --- |
| HIGH | auth, sessions, permissions, middleware; API routes and handlers; payments, billing, ledgers, webhooks; migrations and schema; `.env*`; any path in §4 Infra and security owner or §4 Merge holds |
| MEDIUM | server, service, lib, domain, hooks, backend and data code; CI workflows, infrastructure and build config; or >300 changed lines |
| LOW | everything else |

**Tier is not severity.** The tier decides *how many agents to send*; P0/P1/P2 decide *what a
finding is worth*. A LOW-tier change can carry a P0. Never let the tier cap a severity or bias a
finder. Over-tiering costs one agent; under-tiering hides a file from the specialist, so the
patterns err wide.

| Role | Agent | Fires on |
| --- | --- | --- |
| correctness | `lena-code-reviewer` | always |
| security | `nadia-security-auditor` | any HIGH-tier production path |
| domain | `general-purpose`, told to invoke the skill §4 Review domain experts names | a changed path matching that row's glob |
| api | `theo-api-designer` | API routes, handlers, routers, schemas, serializers, models, migrations, `*.proto`, OpenAPI or GraphQL files |
| tests | `mira-playwright-expert` | test paths, or a HIGH-tier change with no test changed |
| infra | `jim-solution-architect` | CI workflows, infrastructure as code, Dockerfiles, compose files, deploy config |
| frontend | `suki-frontend-architect` | `*.tsx` `*.jsx` `*.vue` `*.svelte` `*.css`, message catalogues |
| requirements | `bea-business-analyst` | a ticket, or an author-written PR description (Phase 5). **Not counted against the fleet cap.** |
| simplicity | `general-purpose`, told to read desk-kiss's Phases 2–5 | every target with a diff, so not `path/to/file` (below). **Not counted against the fleet cap.** |
| codex | `codex exec`, reading the diff cold (Phase 3) | every review, every tier, unless the run is same-vendor (Phase 0). **Not counted against the fleet cap.** |

| Tier | Fleet |
| --- | --- |
| LOW | correctness only |
| MEDIUM | correctness + the top matched specialist |
| HIGH | correctness + up to **2** matched specialists |

Priority when trimming: **security > domain > api > tests > infra > frontend.**

So a branch review is 1–3 finders plus the simplicity finder and codex cold, plus one refutation per
finding, and none at all when the finders return `NO FINDINGS`, which is the common case. Keep it
there: a review nobody runs because it takes ten minutes catches nothing. §3b Subagents that may run
without asking still applies.

**Domain experts** are why the fleet is not fixed. §4 Review domain experts is one span per rule,
`` `<glob>: <skill>` ``, e.g. `` `apps/api/trading/**: energy-trader` ``. A matching change gets a
finder whose first instruction is to invoke that skill with the Skill tool (where the tool lacks it,
as in an autopilot worker, Read `$DESK_SKILLS_DIR/<skill>/SKILL.md`) and read the references it
routes to, **before** reading the diff, then to report in this bar's scale. A domain error that
moves money, a trade, a valuation or a regulated decision is P0. Adopting the persona from memory is
not loading the skill; say so in the prompt.

**The simplicity finder** asks "should this be smaller?" on every review of a diff, so it does not
depend on someone remembering to run `/desk-kiss`. Its first instruction is to Read
`$DESK_SKILLS_DIR/desk-kiss/SKILL.md` (`desk-env paths` prints it; the default is `~/.agents/skills`)
and run **Phases 2–5 only**: intent, the scope, speculation, duplication and commentary passes, the
justification gate and the author's-case refutation. It is a Read, never the Skill tool, because
invoking the skill runs Phase 7's fix offer, and finders do not edit. The prompt gives it `RANGE`
(the diff command's range) and `TIP` (the reviewed revision) so it skips desk-kiss's Phase 1. It
reports survivors as `FINDING` blocks at the bar's severities. desk-kiss's `commentary` band
(restatement, commented-out code), near misses and held-the-line are not graded by the bar, so they
stay in `/desk-kiss`. Scope findings that duplicate Bea's `OUT OF SCOPE` merge in Phase 4. If the
file does not exist, the header says `simplicity: not run (desk-kiss not installed)`.
