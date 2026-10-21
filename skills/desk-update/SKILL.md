---
name: desk-update
description: >-
  Use when the user wants their skills brought up to date, brew-style — "update my skills",
  "desk update", "are my skills outdated", "check for skill updates", "upgrade the Yummy skills",
  "is there a new version of <skill>", "brew update for skills", "update desk". Pulls and installs
  desk-skills itself (no separate ./install.sh), checks every pinned third-party skill against where
  it came from (GitHub, Google Drive), checks Claude Code plugins and their marketplaces, offers any
  new desk setting (skills listed by name only) and, inside a configured repo, the plugins that repo
  does not need; upgrades and changes only what the user picks, after showing what changed. Runs
  from anywhere.
argument-hint: "[outdated | <skill>... | --all]"
---

# desk-update

`brew update && brew upgrade`, for skills. Three kinds of skill live on this machine, each with its
own source of truth; this skill checks all three and upgrades only what the user chooses.

| Kind | Where the one real copy lives | Where it comes from | Updated by |
|---|---|---|---|
| desk's own (`desk-*`, the subagents, `/userflow`) | `~/.agents/skills`, `~/.claude/agents`, `~/.claude/commands` | the desk-skills checkout (`bigbenjoman/desk-skills`) | `git pull` + `./install.sh` |
| **pinned third-party** (e.g. Yummy's ux/ui-designer, context-audit) | `~/.agents/skills/<name>`, linked from `~/.claude/skills` | `vendor/sources.json`: a GitHub repo path or a Google Drive folder | `skills-upstream upgrade` + review + `./install.sh` |
| **your own / tracked live** (`checkout` entries, e.g. clerk) | a git clone at `~/.agents/skills/<name>`, or `~/.agents/sources/<name>` with `subskills` linked in | `vendor/sources.json`: `{repo, branch}` | `skills-upstream upgrade <name>` (`git pull --ff-only`; nothing to commit in desk-skills) |
| plugin skills (superpowers, vercel, …) | the plugin cache | the plugin's marketplace | `claude plugin marketplace update` + `claude plugin update` |
| **the status line** (a `tools` entry, not a skill) | `~/.claude/statusline-command.sh` and settings.json's `statusLine` | `vendor/sources.json` `tools.claude-statusline`: the whole repo at a pinned commit | `skills-upstream upgrade claude-statusline` (the pin only) + review, then `skills-upstream statusline install` (its own installer) |

Anything else in `~/.agents/skills` or `~/.claude/skills` is **untracked**: its source is not
recorded, so it cannot be checked. Report those; never guess a source for one.

## Never do these

- **Never upgrade what the user did not pick.** Report first, ask, then upgrade.
- **Never adopt an upstream change unseen.** Show what changed (commit messages, `git diff --stat`,
  and the substance of the SKILL.md diff) before it is installed.
- **Never edit a vendored skill by hand** to "fix" it. Local changes belong in the upstream, or in a
  repo-level override (`<repo>/.claude/skills/<name>`), and are said out loud.
- **Never push** the desk-skills commit without asking; it is the user's repo. **Never push to
  `main`**: it takes changes only through a PR (§3).
- A source that cannot be reached is **reported**, not treated as "up to date".

## 1. Update desk itself

```bash
D="$(cat ~/.claude/desk/source-checkout)"          # the desk-skills checkout install.sh ran from
git -C "$D" branch --show-current                   # must be main to pull or install
git -C "$D" status --short                          # must be clean to pull
git -C "$D" fetch -q && git -C "$D" log --oneline HEAD..origin/main
```

**Off `main`, pull and install nothing.** If the checkout is on any other branch (or a detached
HEAD), skip the pull and every `./install.sh` in this run, and say which branch is checked out and
how to get back: `git -C "$D" switch main`, once that branch's work is committed. A feature branch's
upstream is not desk's release, and installing its files puts unmerged work in every session. §2
still reports, and §3 still commits upgrades on its own branch cut from `origin/main`.

On `main`, if there are incoming commits and the tree is clean, `git -C "$D" pull --ff-only` and
list them in one line each. A dirty tree or a diverged branch: say so and skip the pull (never
stash, reset or merge for the user).

**Then install them, in the same run.** A pull alone changes nothing the user runs: the skills,
agents, scripts and the skill index are copies made by `install.sh`. After any pull (and whenever
`skills-upstream verify` reports DRIFTED below), run:

```bash
"$D/install.sh" </dev/null       # files only: with stdin not a terminal every settings prompt is skipped
```

and report its warning count. Its output ends with a `Skipped (no terminal): <n> prompt(s)` block
listing every prompt it skipped, each as a `SKIP  <question>` line followed by an
`apply: <command>` line (the exact command that does it, or `run in a terminal: cd … && ./install.sh`
where there is none). Each one becomes a SETTING row in §2 and an option in §3, never applied
silently.

## 2. Check everything

```bash
skills-upstream outdated                  # pinned third-party skills and the status line; exit 10 = outdated
skills-upstream statusline check          # exit 1: the installed status line is missing or not at the pin
skills-upstream statusline other          # exit 0: a status line desk did not install is in place (printed)
skills-upstream verify                    # installed copies match vendor/ (drift, hand edits), and every
                                          # skill is reachable from ~/.claude/skills (else "Unknown skill")
claude plugin marketplace update          # refresh the marketplaces' copies (installs nothing)
skills-upstream plugins                   # each installed plugin vs its refreshed marketplace; exit 10 = behind
```

```bash
skills-upstream index --quiet --name-only --check   # exit 1: skills still listed in full every turn
jq -e '[.hooks.SessionStart[]?.hooks[]?.command] | any(test("desk-update-check"))' ~/.claude/settings.json
                                                    # false: no once-a-day update notice at session start
jq -e '[.hooks.UserPromptSubmit, .hooks.PostToolUse, .hooks.Stop, .hooks.SessionStart]
  | all([.[]?.hooks[]?.command] | any(test("desk-handoff")))' ~/.claude/settings.json
                                                    # false: no context handoff on one or more events
eval "$(desk-env where)"                            # EXISTS=yes: the cwd is a configured repo
python3 ~/.agents/skills/desk-setup/bin/repo-plugins.py --root "$(git rev-parse --show-toplevel)" suggest
                                                    # only when EXISTS=yes: rows with suggest off, now on
```

`skills-upstream plugins` compares the installed plugin folder with the marketplace's copy (or the
version the marketplace pins) and lists what changed, e.g. `+LICENSE`, `~skills/x/SKILL.md`. Say
plainly when a change is trivial (a licence file only) versus a changed skill.

`UNBUMPED` means the marketplace copy changed but kept the installed version number.
`claude plugin update` goes by version only, so it will answer "already at the latest version" and
change nothing. Report these rows separately and never offer them as upgrades. They do not set
exit 10, and they clear on their own once upstream bumps the version.

Untracked skills: every real folder in `~/.agents/skills` (and any real folder left in
`~/.claude/skills`) whose name is neither `desk-*` nor a key in `vendor/sources.json`.

Report as one table, brew-style:

```
DESK UPDATE — <date>
desk-skills   <n> new commits pulled | up to date | skipped: <reason>
OUTDATED      context-audit     8560b4f (2026-04-13) -> 8928560 (2026-04-13)  Vesely/skills  2 commits: "Add README…", "…"
OUTDATED      claude-statusline 8eeb63190 (2026-08-15) -> <latest>  bigbenjoman/claude-statusline  <n> commits: "…"
OUTDATED      plugin vercel     1.4.0 -> 1.5.1
STATUSLINE    not at the pin: <what `statusline check` printed>; or: not one desk installed: <what `statusline other` printed>
UNBUMPED      plugin code-simplifier  1.0.0: +LICENSE (no version bump, so nothing to update yet)
ok            ux-designer, ui-designer, ux-copywriter, <plugins…>
UNREACHABLE   <name>: <error>
DRIFTED       <name>: ~/.agents/skills copy differs from vendor/ (run ./install.sh)
UNLINKED      <name>: not reachable from ~/.claude/skills; fix: <the line verify printed>
SHADOWED      <name>: ~/.claude/skills/<name> lands on another copy, so that stale copy runs; fix: <the line verify printed>
NOT INSTALLED <name>: no SKILL.md in ~/.agents/skills (run ./install.sh)
NOT IN CLONE  <name>: a checkout sub-skill missing from the local clone; `skills-upstream upgrade <origin>`
              first, and only if it is still missing is it gone upstream (then remove it from `subskills`)
WRONG COPY    <name>: ~/.agents/skills/<name> is not the checkout's clone, or does not resolve into it,
              or ~/.agents/sources/<name> is not a clone of its repo (once per checkout; all its sub-skills fail)
UNVERIFIED    <dir>: git could not read the clone's origin (ownership, a corrupt config); check it by hand,
              never ./install.sh, which would move it aside
UNTRACKED     <names>: no recorded source, so no update check
SETTING       skills listed in full: name-only + skill-index cuts the listing ~30,000 -> ~9,600 chars a turn
SETTING       no update notice: a SessionStart hook would say once a day when desk-skills has new commits
SETTING       no context handoff: past §2 Handoff at context % the session would write .handoffs/<date>.md,
              and the session after /clear or a compaction would pick it up
SETTING       skipped by install.sh: <question>
              apply: <the apply line install.sh printed under it, verbatim>
PLUGINS       <repo>: <n> plugins this repo does not need (<ids>), <m> skills listed every turn
```

One `skipped by install.sh` row per `SKIP` line in §1's block, none dropped. Where a skipped prompt is
the same setting as one of the checked rows above (the update notice, the context handoff,
name-only listing, the status line), report it once: the checked row, with the skipped row's `skipped by install.sh:
<question>` and `apply:` lines under it.

For each OUTDATED pinned skill or tool, say in one or two lines **what changed upstream** (GitHub: the
commit subjects since the pin, `gh api "repos/<repo>/compare/<pin>...<latest>" --jq
'.commits[].commit.message'`; Drive: the new file name and date, and the publisher's page for
release notes).

## 3. Ask, then upgrade

One `AskUserQuestion` (multi-select): which to upgrade, plus one option per SETTING, STATUSLINE and PLUGINS line
(so a run that finds nothing outdated can still offer them). First option "All outdated (Recommended)"
only when every change reads as routine; otherwise recommend the specific ones and say why a
particular upgrade deserves a look first (a rewritten SKILL.md, a new tool it asks to use, a
licence change).

Then, for the chosen pinned skills, **on a new branch cut from `origin/main`**, never on the branch
that is checked out (the tree must be clean; if it is not, say so and upgrade nothing):

```bash
git -C "$D" fetch -q origin
git -C "$D" switch --no-track -c "chore/vendor-$(date +%F)" origin/main   # exists already: say so and stop
skills-upstream upgrade <name>...          # writes vendor/<name> and the pin; nothing is installed yet
git -C "$D" diff --stat -- vendor/
git -C "$D" diff -- vendor/<name>/SKILL.md # summarise the substance for the user
```

Commit on that branch: `chore(vendor): upgrade <name> to <new pin>` (one commit per skill). Then
go back to where the run started, with `git -C "$D" checkout -q -` (it returns to the previous
branch, or the detached commit, without needing a variable from an earlier call), and report the
new branch and its commits. The previous branch gains nothing. **Install nothing from
`chore/vendor-<date>`**: it is not `main`, so the upgrade is installed by §1 of the first run after
it merges.

Ask before pushing it. On yes, push that branch and open a PR from it into `main`:

```bash
git -C "$D" push -u origin chore/vendor-<date>
gh pr create --repo <owner/name> --base main --head chore/vendor-<date> \
  --title "chore(vendor): upgrade <name>..." --body "<one line per skill: old pin -> new pin, what changed>"
```

`<owner/name>` is the GitHub repo `git -C "$D" remote get-url origin` names, so the PR opens on the
desk-skills checkout's origin whatever directory you run it from.

Report the PR URL `gh pr create` prints. Nothing is pushed to `main`: CI and the user merge the PR.
If the push or the PR fails, report the error and the branch name, and leave it there; never retry
by pushing to `main`. On no, report the branch as local only.

For the update notice: re-run `./install.sh` in a terminal, or register it the way install.sh does (a
`SessionStart` entry running `bash ~/.claude/hooks/desk-update-check.sh`, timeout 15, settings backed up
first). For the context handoff: the same, or register it the way install.sh does (an entry running
`python3 ~/.claude/hooks/desk-handoff.py`, timeout 15, on each of `UserPromptSubmit`, `PostToolUse`,
`Stop` and `SessionStart` that lacks one, settings backed up first). For the name-only SETTING: `skills-upstream index --quiet --name-only` (it backs nothing up itself, so
copy `~/.claude/settings.json` to `~/.claude/settings.json.bak-desk-<date>` first). For a chosen
PLUGINS line: run `/desk-setup` §4b for this repo (`desk-setup plugins`), which asks which ones.
For any other chosen `skipped by install.sh` row: run its `apply:` command; where that says
`run in a terminal`, tell the user to run it there rather than doing it for them.

For the status line, an upgrade is the same branch-and-PR flow as a vendored skill:
`skills-upstream upgrade claude-statusline` moves only the pin in `vendor/sources.json` (there is no
`vendor/` copy; show the commits from the compare above instead of a diff), and the first run on
`main` after it merges installs it. A chosen STATUSLINE row (or its `skipped by install.sh` row) is
installed on confirmation: copy `~/.claude/settings.json` to `~/.claude/settings.json.bak-desk-<date>`,
then `skills-upstream statusline install`, which runs the repo's own installer at the pin (it copies
the old script aside first). Where `statusline other` printed anything (a status line desk did not
install, even one at `~/.claude/statusline-command.sh`), the row says it **replaces** that, and it is
never part of "All outdated": the user picks it on its own or it stays.

For chosen plugins: `claude plugin update <plugin>` each, then `claude plugin list --json` to show
the new version. Say that plugin and skill changes load in the **next** Claude Code session.

## 4. Adding a source for an untracked skill

When the user wants an untracked skill tracked: find its source first (search GitHub for a
distinctive sentence from its SKILL.md; date the earliest commit to find the original, not a copy),
and only record it when a specific upstream version is **byte-identical** to the installed copy.
Then add an entry to `vendor/sources.json` (same shape as the existing ones), copy the files to
`vendor/<name>/`, run `skills-upstream rehash`, and install. A skill whose source cannot be
proven stays untracked, and the report keeps saying so.
