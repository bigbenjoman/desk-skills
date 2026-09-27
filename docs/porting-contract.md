# Porting contract: studia-* to desk-*

How the skills were made generic, and the rules any future change must keep. desk-skills began as a
copy of studia-skills 2.3, a set of skills written for one company's monorepo. desk is the same
workflow with every fact about that company moved into a **per-repo config**.

## The one idea

Nothing about a repo, a company, a person or a toolchain is written into a skill or script. It is
read from the config of the repo the skill is running in:

```
~/.config/desk/repos/<owner__name>/config.md     the config (template: desk-config.md)
~/.config/desk/repos/<owner__name>/jira-email    credentials, beside it, by path only
~/.config/desk/repos/<owner__name>/atlassian-token
```

`<owner__name>` comes from `git remote get-url origin`, so every worktree of a repo shares one config.

## How a skill reads it

At the start of every skill:

```bash
desk-env where        # SLUG=, GH_REPO=, CONFIG=, CREDS=, EXISTS=yes|no  (exit 3 outside a repo)
```

Then Read the `CONFIG` file. `EXISTS=no` means stop and offer `/desk-setup`. Cite rows as
`§3 <key>` for permissions and `§<n> <Row name>` for everything else (`§4 Ticket key pattern`).
`desk-env` is `~/.claude/desk/bin/desk-env.mjs`, linked onto PATH by `install.sh`. Scripts use
`desk-env get <id>` / `desk-env perm <key>` (ids in `CONFIG_ROWS`, keys in `PERMISSION_KEYS`) or,
from shell, `desk_cfg` / `desk_perm` / `desk_load_paths` in `desk-env.sh`.

## What replaced what

| Studia-specific | Generic replacement |
|---|---|
| `~/.claude/studia-config.md` (one per person) | `~/.config/desk/repos/<slug>/config.md` (one per repo) |
| `SV-123`, "the SV project" | `§4 Ticket key pattern`; examples use `ABC-123`, paths use `<TICKET>` |
| Studia's Jira site, cloudId, workflow names (`In Development`, `Review/QA`, `Done`) | `§4 Jira site`, `Jira cloudId`, `In-progress state`, `Review state`, `Done state` |
| Launch Priority `customfield_10159`, `sev-pN` labels, Figma field | `§4 Priority`, `§4 Labels`, `§4 Other fields` |
| `studia-web`, `Sophos-Education/...` | `§0 GitHub repo`, `§2 Primary repo root` |
| `🏁 CI gate` and its list of checks, Protect Main ruleset | `§4 Required checks`, `§4 Branch protection` ("green" = every required check passed; with `none`, every check on the PR) |
| `--squash` | `§4 Merge method` |
| `/pullbot`, `pullbot-gate`, `review-bar`, `p0=0 p1=0 p2=0` | `§4 Local review command`, `§4 Clean review verdict` |
| bun only, `mise exec -- bun`, npm/pnpm/npx blocked | `§4 Package manager`, `§4 Command prefix`, and the `§4 Toolchain` command rows |
| `bun run agents:sync` | `§4 Project subagents sync` |
| Postgres `studia-web-postgres-1`, Typesense, Mailpit, `specs-it/` | `§4 Local database`, `§4 Local services`; permission keys `local-reindex`, `tests-shared-db` |
| `next.studia.io`, Vercel team and project ids | `§4 Staging`, `§4 Vercel`, `§4 Staging bypass token location` |
| Chris Anthony, Joni, Shan, Ben as product owner | `§4 People, by role` (`you` in a solo repo) |
| `#agenda` Check Out, `#tech`, `#testing` | `§4 Check-out destination`, `§4 Slack channels` |
| AI attribution always forbidden | `§5 AI attribution`: `forbidden` or `allowed`, per repo, enforced by the hook only where forbidden |
| House review bar mined from Studia PRs | `§4 What review here consistently asks for` |
| Branch and PR title conventions | `§5 Branch names`, `§5 PR title`, `§5 PR body`, `§5 PR lifecycle` |
| Studia's CLAUDE.md conventions | `§5 Repo instructions`: the repo's own files win on anything they cover |

Renamed permission keys: `typesense-reindex` became `local-reindex`, and `specs-it-shared` became
`tests-shared-db`.

## Rules for editing a skill

1. **Keep the behaviour and every safety rail.** The allowlist, ownership tests, park-don't-guess,
   backups before writes, never-send-Slack, never-merge-past-checks: all of it stays. Genericising is
   not a licence to simplify.
2. **A Studia fact becomes a config read, not a different hardcoded fact.** Never write `pnpm`,
   `KAN-`, `main`, a person, or a URL into a skill.
3. **`none` is a real value.** Every step that depends on a §4 row says what happens when it is
   `none` (no Jira: skip the Jira steps; no local database: skip per-ticket DBs; no designer: the
   design questions go to the product owner).
4. **Tracker `none`.** The ticket skills then take a plain description or a GitHub issue URL in
   place of a key, name the branch from a slug of it, and skip every Jira step.
5. **Examples are neutral.** `ABC-123`, `<TICKET>`, `owner/repo`, `example.com`.
6. **The finished check** (run from the repo root):

   ```bash
   grep -rniE 'studia|sophos|\bSV-|\bbun\b|mise exec|typesense|specs-it|mailpit|mousedown|chris anthony|joni|shan |blake|next\.studia|🏁|customfield_10159|agenda' \
     --exclude-dir=.git --exclude=porting-contract.md .
   ```

   Any hit left must be deliberate and explained in a comment beside it.

## Subagents (`agents/`) and commands (`commands/`)

The eleven subagents began as studia-web's project subagents. They are installed **user-level**
(`~/.claude/agents/`) by `install.sh`, so they load in every repo, which means each one must discover
the repo it is in rather than assume one. A repo that needs a tailored agent adds a project-level
`.claude/agents/<name>.md`, which Claude Code prefers over the user-level copy.

1. **Keep the persona.** Name, `model`, `color`, `memory`, `tools`, voice, structure and every
   judgement rule stay. Only facts about one codebase go.
2. **Every agent opens with a "This repo" step**: run `desk-env where`; if `EXISTS=yes`, read that
   config (§0 description, §4 toolchain, tracker and people, §5 conventions and Repo instructions).
   Always read the repo's own instruction files (`CLAUDE.md`, `AGENTS.md`, `DESIGN.md` where they
   exist) and detect the stack from the repo (`package.json`, lockfiles, framework config). The
   agent must work in a repo with no desk config.
3. **A stack fact becomes a detected fact.** "Use tRPC and bun" becomes "use the API style and
   package manager this repo already uses". Framework expertise stays as expertise, e.g. tRPC is
   one of several API styles Theo knows, not the one he assumes.
4. **Studia-only machinery goes or becomes conditional**: the `.agents/knowledge` base,
   `knowledge:check`, `agents:sync`, the `studia-` design tokens, `packages/studia-web`,
   Studia's user roles.
5. **Tickets**: Bea writes to the tracker in §4 via `desk-jira`; with Tracker `none` she drafts a
   GitHub issue (`gh issue create`). Neither is created without the user's approval.
