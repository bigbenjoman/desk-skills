# Install and update

> Part of the [desk-skills docs](README.md). Back to the [main README](../../README.md).

What `install.sh` writes, what it asks before touching, the hooks it registers, the tools it needs, and how skills stay one copy each and up to date.

## Install

```bash
./install.sh            # install or update
./install.sh --check    # report missing tools and unreachable skills, change nothing
./install.sh --yes      # accept the prompts (not large downloads)
./install.sh --accept=hook-attribution,plugins --decline=statusline   # answer the prompts named, with no terminal
./install.sh --any-branch   # install a checkout off main or behind origin/main, which it otherwise refuses
./install.sh --rollback     # go back to the release installed before the current one
```

It fetches `origin/main` first and installs nothing from another branch, a detached HEAD or a `main`
behind `origin/main`, saying the branch and how many commits behind; nor when the fetch fails,
saying the check could not run.

What it does:

- **Writes without asking** (desk's own files; a copy you edited is backed up first):
  the skills (`~/.agents/skills/desk-*`, linked into `~/.claude/skills`), the subagents and
  `/userflow` (`~/.claude/agents`, `~/.claude/commands`; a same-named file you already had is backed
  up), the third-party skills, the scripts (`~/.claude/desk/bin`), `desk-env`, `desk-q`,
  `desk-jira` and `skills-upstream` (`~/.local/bin`), and the four hook scripts. It also removes the
  files an older desk installed for its local CI runner, and that runner's launchd jobs.
- **Asks first** before changing `~/.claude/settings.json` (registering the hooks, adding the
  always-on deny rules, listing skills by name only), installing plugins, replacing a `desk-jira` it
  didn't install, registering the Playwright MCP at user level, or disabling the `playwright` plugin.

The four hooks: **`deny-ai-attribution.py`** (before each Bash command) refuses Claude trailers in a
repo whose §5 AI attribution is `forbidden`, **`desk-update-check.sh`** (at session start, at
most once a day) says when this checkout has new commits for `/desk-update` to install, and
**`desk-handoff.py`** (on prompt submit, after each tool, at turn end, at session start and before a compaction) has a
session in a configured repo write `.handoffs/<date>.md` once its context passes §2 Handoff at
context % (default 45; on a 1M window §2 Handoff at context % on a 1M window, which setup proposes at 20 and unset takes the row above's value), and points the session after `/clear` or a compaction at it. A hook cannot start a turn, so it asks
you to type `/clear`, then `/desk-resume`, which carries on from the handoff's next step. In a
session that runs a batch through `/loop`, it also blocks a turn that ends with no next pass
recorded, once per pass, and once no pass has run for twice the loop's interval (or sooner, where
needs-you would show the batch stalled) it tells the session's next turn to re-arm the loop, which
`queue.mjs next-pass` logs for needs-you (`desk/bin/loop-tick.mjs`).

With `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` set in Claude Code's environment (a percentage from 1 to 100
under `env` in `~/.claude/settings.json`; `install.sh` offers to set it at 55 and keeps a value
already there), nobody types anything: past §2 the session writes its
handoff and keeps working, Claude Code compacts it on its own, the hook's `PreCompact` step names the
handoff for the summary, and after the compaction the session is told to read it and carry on. Each
later crossing refreshes that same handoff, and the turn cannot end until it has. A compaction does
not mark it consumed, so the session's own later `/clear` still finds it, and from the moment it
is named no other session's `/clear` takes it. Set §2 below the override, so the handoff is written before the compaction.

**`desk-worker-stop.py`** is never registered in `settings.json`: each autopilot worker's own
settings run it at turn end. It blocks the worker's first attempt to end its turn while a background
task it started is still running, which `claude -p` would kill, and logs a second attempt.
**`desk-worker-reread.py`** is registered the same way, on the worker's Read calls and on
compaction. It refuses a worker's Read of a file and range it has already read in this session when
the file's content (by hash) has not changed since, naming the earlier read. A changed file, a new
range, a compaction, a subagent's Read or `DESK_ALLOW_REREAD=1` in the environment lets it through.
**`desk-worker-hints.py`** is registered the same way, on the worker's Bash calls, and only with the
`wrappers` lever on (config §3b Phase 0 levers). A command the worker's allow-list refuses anyway is
refused naming the single command that does the same: the command without a `cd` into its own
worktree, `desk-env lines <file> A,B` for a `sed -n A,Bp` line range, or §4 Unit tests with the one
test file it ran directly. It only ever denies, and stays silent on any command it cannot be sure of.
- **Never** writes a repo config. That is `/desk-setup`'s job, per repo.

Requirements (`./install.sh --check` names anything missing):

| Tool | Notes |
|---|---|
| Claude Code, `git`, `curl`, `jq`, `node`, `python3` | |
| `gh` | `gh auth login -s repo,workflow` |
| `codex` | optional: cross-vendor review. `brew install --cask codex` or `npm i -g @openai/codex`, then `codex login` |
| `mise` | only for repos that pin tools through it |
| `lsof` | preinstalled on macOS; `apt install lsof` on Linux |
| `flock` | optional; a fallback lock is used without it |

## Updating

```bash
cd ~/desk-skills && git switch main && git pull --ff-only && ./install.sh
```

Pull and install only on `main`: a feature branch's files would put unmerged work in every session.
`main` is protected, so changes to desk-skills go through a PR, never a push to `main`.

Restart Claude Code. Repo configs are kept; if the template gained rows, `/desk-setup` in that repo
asks only those.

You don't need to remember to check: once a day, the first session you start says when desk-skills
has new commits.

**`/desk-update`** does all of it brew-style, from any directory: pulls desk-skills (only when the
checkout is on `main`), runs `skills-upstream outdated`, `verify` and `plugins`, reports one table
(outdated, drifted, unlinked, unreachable, untracked), says what changed upstream for each, and
upgrades only what you pick, after showing the diff. Upgrades are committed on a new
`chore/vendor-<date>` branch cut from `origin/main`, never on the branch you have checked out, and
installed by the first `/desk-update` after that branch merges. It never pushes the branch without
asking; when you agree, it pushes `chore/vendor-<date>`, opens a PR into `main` and prints its URL.
Once that PR is open it closes each older open vendor PR whose every upgrade it repeats or `main`
already pins at the same commit, naming the new one, and leaves open any other. A run whose upgrades leave `vendor/` as
`main` has it opens no PR.

## Skills, one copy each

Every skill on the machine, desk's or anyone else's, has **one real copy** in
`~/.agents/skills/<name>`; `~/.claude/skills/<name>` is a link to it. No skill is copied into a repo
or duplicated between the two folders, so there is one thing to update and nothing to drift.

Besides desk's own `desk-*` skills, `install.sh` installs the third-party skills listed in
[`vendor/sources.json`](../../vendor/sources.json). Each entry records where the skill came from and
which version is installed, as one of three source types:

| Type | Use for | Where the files live | "Outdated" means |
|---|---|---|---|
| `github` | a skill published in a GitHub repo | `vendor/<name>/`, byte-identical to `{repo, path}` at `pin.commit` | a newer commit touches that path |
| `drive` | a skill published as a zip in a public Google Drive folder (e.g. Yummy Design's ux/ui skills) | `vendor/<name>/`, unpacked from the zip whose `sha256` is pinned | the folder's file name or modified date changed |
| `checkout` | your own skills, and upstreams you want to track live | a git clone at `~/.agents/skills/<name>`; nothing in `vendor/`. A repo holding several skills (`subskills`, e.g. `clerk/skills`) is cloned once to `~/.agents/sources/<name>` and each listed sub-skill linked in | `origin/<branch>` has commits you have not pulled |

`vendor/<name>/` is never edited by hand: its `tree_sha256` in `sources.json` is checked by
`skills-upstream verify`. A local change belongs upstream, in a repo-level override
(`<repo>/.claude/skills/<name>`, which Claude Code prefers), or, for one every machine should get,
in a patch: a diff relative to the skill folder under `vendor-patches/`, named in the entry's
`patches` list. `upgrade` re-applies each patch to the new upstream before it reaches `vendor/`, and
records the hash after patching; a patch that no longer applies refuses that skill (exit 1) and
leaves `vendor/<name>` and its pin as they were, so rework the patch and upgrade again.

Claude Code only sees a skill through `~/.claude/skills/<name>/SKILL.md`; an installed copy with no
link there is "Unknown skill". `skills-upstream links` checks every skill desk installs (`desk-*`,
`vendor/*` and each `checkout` and its `subskills`) and prints the fix for each gap, usually
`ln -sfn ~/.agents/skills/<name> ~/.claude/skills/<name>`. A link or folder there that lands on any
other copy is reported too (SHADOWED), since Claude Code would run that stale copy. A `checkout`'s
`~/.agents/skills/<name>` must be its clone, or resolve into it for a sub-skill (WRONG COPY otherwise). When `~/.claude/skills` is itself a link
to `~/.agents/skills` there are no per-skill links, and a gap means the skill is not installed.
`install.sh` runs it after linking and under `--check`, and `verify` includes it.

`skills-upstream` (installed to `~/.local/bin`, runs from this checkout) manages them:

```bash
skills-upstream list                  # every tracked skill, its source and pin
skills-upstream outdated              # compare each pin with its source; exit 10 if any is behind
skills-upstream upgrade <name>...     # pull the newest upstream into vendor/ (or git pull a checkout)
skills-upstream upgrade --all
skills-upstream verify                # vendor/ matches sources.json, installed copies match vendor/, and links
skills-upstream links                 # every installed skill is reachable as ~/.claude/skills/<name>
skills-upstream is-clone-of <dir> <owner/repo>   # exact origin test install.sh and links share
skills-upstream plugins               # installed plugins vs their marketplaces
skills-upstream rehash                # re-record tree hashes after adding an entry
```

`upgrade` only writes `vendor/` (review it with `git diff`, then commit and run `./install.sh`); a
`checkout` upgrade is a `git pull --ff-only` in the clone and leaves nothing to commit here. To
track a skill that has no entry yet, prove a specific upstream version is byte-identical to the
installed copy first; a skill whose source cannot be proven stays untracked and is reported as such.

## Skill index: listing skills by name only

Claude Code resends every installed skill's description on every turn and cuts descriptions to fit
its budget (about 30,000 characters on a machine with ~170 skills, desk's own among those cut). So
`install.sh` builds a two-level catalogue and, if you agree, lists skills by name only:

- `skills-upstream index` writes `~/.agents/skills/skill-index`: a short map of areas (desk
  workflow, security and privacy, UX and design, ...) and `areas/<area>.md` with each skill's full
  description. Claude reads the map, then one area file. Areas come from
  [`desk/skill-areas.json`](../../desk/skill-areas.json); a skill no glob matches is reported, so add it there.
- `skills-upstream index --name-only` (asked by `install.sh`) sets your own and claude.ai skills to
  `name-only`, lowers `skillListingBudgetFraction` to 0.003, and adds
  `~/.claude/rules/desk-skill-index.md` pointing at the index. Entries you set yourself are kept.
- Plugin skills cannot be set name-only, so `/desk-setup` step 4b switches off, **per repo**, the
  plugins that repo does not need (from its own files, confirmed by you).

Measured 2026-10-02: the listing went from 29,954 to 9,648 characters; 29 of 30 test prompts loaded
the expected skill, and Claude opened the index on the 3 ambiguous ones. To undo: delete the
`skillOverrides` entries listed in `~/.claude/desk/skill-index.name-only.json` and
`skillListingBudgetFraction` from `~/.claude/settings.json`, and the rule file.
