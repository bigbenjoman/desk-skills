---
name: desk-update
description: >-
  Use when the user wants their skills brought up to date, brew-style — "update my skills",
  "desk update", "are my skills outdated", "check for skill updates", "upgrade the Yummy skills",
  "is there a new version of <skill>", "brew update for skills". Updates desk-skills itself, checks
  every pinned third-party skill against where it came from (GitHub, Google Drive), checks Claude
  Code plugins and their marketplaces, and upgrades only what the user picks, after showing what
  changed. Not per repo: it runs from anywhere.
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

Anything else in `~/.agents/skills` or `~/.claude/skills` is **untracked**: its source is not
recorded, so it cannot be checked. Report those; never guess a source for one.

## Never do these

- **Never upgrade what the user did not pick.** Report first, ask, then upgrade.
- **Never adopt an upstream change unseen.** Show what changed (commit messages, `git diff --stat`,
  and the substance of the SKILL.md diff) before it is installed.
- **Never edit a vendored skill by hand** to "fix" it. Local changes belong in the upstream, or in a
  repo-level override (`<repo>/.claude/skills/<name>`), and are said out loud.
- **Never push** the desk-skills commit without asking; it is the user's repo.
- A source that cannot be reached is **reported**, not treated as "up to date".

## 1. Update desk itself

```bash
D="$(cat ~/.claude/desk/source-checkout)"          # the desk-skills checkout install.sh ran from
git -C "$D" status --short                          # must be clean to pull
git -C "$D" fetch -q && git -C "$D" log --oneline HEAD..@{u}
```

If there are incoming commits and the tree is clean, `git -C "$D" pull --ff-only` and list them in
one line each. A dirty tree or a diverged branch: say so and skip the pull (never stash, reset or
merge for the user).

## 2. Check everything

```bash
skills-upstream outdated                  # pinned third-party skills; exit 10 = something is outdated
skills-upstream verify                    # installed copies match vendor/ (drift, hand edits), and every
                                          # skill is reachable from ~/.claude/skills (else "Unknown skill")
claude plugin marketplace update          # refresh the marketplaces' copies (installs nothing)
skills-upstream plugins                   # each installed plugin vs its refreshed marketplace; exit 10 = behind
```

`skills-upstream plugins` compares the installed plugin folder with the marketplace's copy (or the
version the marketplace pins) and lists what changed, e.g. `+LICENSE`, `~skills/x/SKILL.md`. Say
plainly when a change is trivial (a licence file only) versus a changed skill.

Untracked skills: every real folder in `~/.agents/skills` (and any real folder left in
`~/.claude/skills`) whose name is neither `desk-*` nor a key in `vendor/sources.json`.

Report as one table, brew-style:

```
DESK UPDATE — <date>
desk-skills   <n> new commits pulled | up to date | skipped: <reason>
OUTDATED      context-audit     8560b4f (2026-04-13) -> 8928560 (2026-04-13)  Vesely/skills  2 commits: "Add README…", "…"
OUTDATED      plugin vercel     1.4.0 -> 1.5.1
ok            ux-designer, ui-designer, ux-copywriter, <plugins…>
UNREACHABLE   <name>: <error>
DRIFTED       <name>: ~/.agents/skills copy differs from vendor/ (run ./install.sh)
UNLINKED      <name>: not reachable from ~/.claude/skills; fix: <the line verify printed>
SHADOWED      <name>: ~/.claude/skills/<name> lands on another copy, so that stale copy runs; fix: <the line verify printed>
NOT INSTALLED <name>: no SKILL.md in ~/.agents/skills (run ./install.sh)
NOT IN CLONE  <name>: a checkout sub-skill missing from the local clone; `skills-upstream upgrade <origin>`
              first, and only if it is still missing is it gone upstream (then remove it from `subskills`)
WRONG COPY    <name>: ~/.agents/skills/<name> is not the checkout's clone, or does not resolve into it
UNTRACKED     <names>: no recorded source, so no update check
```

For each OUTDATED pinned skill, say in one or two lines **what changed upstream** (GitHub: the
commit subjects since the pin, `gh api "repos/<repo>/compare/<pin>...<latest>" --jq
'.commits[].commit.message'`; Drive: the new file name and date, and the publisher's page for
release notes).

## 3. Ask, then upgrade

One `AskUserQuestion` (multi-select): which to upgrade. First option "All outdated (Recommended)"
only when every change reads as routine; otherwise recommend the specific ones and say why a
particular upgrade deserves a look first (a rewritten SKILL.md, a new tool it asks to use, a
licence change).

Then, for the chosen pinned skills:

```bash
skills-upstream upgrade <name>...          # writes vendor/<name> and the pin; nothing is installed yet
git -C "$D" diff --stat -- vendor/
git -C "$D" diff -- vendor/<name>/SKILL.md # summarise the substance for the user
```

Commit in desk-skills: `chore(vendor): upgrade <name> to <new pin>` (one commit per skill), then
ask before `git push`. Install: `(cd "$D" && ./install.sh </dev/null)`, which installs files and
skips every settings prompt, then `skills-upstream verify` must print `ok` for each upgraded skill
and report no UNLINKED, SHADOWED, NOT INSTALLED, NOT IN CLONE or WRONG COPY skill.

For chosen plugins: `claude plugin update <plugin>` each, then `claude plugin list --json` to show
the new version. Say that plugin and skill changes load in the **next** Claude Code session.

## 4. Adding a source for an untracked skill

When the user wants an untracked skill tracked: find its source first (search GitHub for a
distinctive sentence from its SKILL.md; date the earliest commit to find the original, not a copy),
and only record it when a specific upstream version is **byte-identical** to the installed copy.
Then add an entry to `vendor/sources.json` (same shape as the existing ones), copy the files to
`vendor/<name>/`, run `skills-upstream rehash`, and install. A skill whose source cannot be
proven stays untracked, and the report keeps saying so.
