# desk-setup step 5: write it, then show every row

Read at the start of step 5. The step table in `../SKILL.md` names this file for it.

## 5. Write it, then show every row

`mkdir -p` the config folder (`chmod 700`), then write `CONFIG` from the template
`~/.agents/skills/desk-setup/references/desk-config.template.md` (`install.sh` copies the
checkout's `desk-config.md` there on every run), **keeping its structure, section numbers, row
names, keys and the Rules header**; skills cite rows by them. Then print every row with the user's
own answer:

```
DESK CONFIG WRITTEN — <CONFIG>   (repo <owner/name>)

repo      : <owner/name> · default <branch> · <description>
identity  : <name> · short <short form> · <github> · jira <email / none> · <jira display name> ·
            account <jira account id> · git <author> · pronouns <pronouns or they/them>
paths     : root <path> · worktrees <path> · handoff <path> · backups <path> · canvases <path> · WSL <yes/no>
tracker   : <jira site / none> · project <key> · keys <pattern> · other ids <patterns / none> ·
            states <in-progress> → <review> → <done> · priority <field> · desk-jira <yes/no>
github    : protection <summary (classic / ruleset <name>) / none> · required <checks / none> ·
            advisory <checks / none> · holds <glob: why / none> · merge <method> · auto-merge <on/off> ·
            gh scopes <scopes> · codex <yes date / no> · review <command> (clean = <verdict>)
toolchain : <package manager> · prefix <prefix/none> · install · dev · typecheck · lint · test · e2e · build · codegen ·
            env files <names>          (each list item as its own backtick span, `dir: cmd` where it has one)
pre-push  : checks <items / none> · pr-body <command / none> · hook <committed in #<n> / declined / not offered> ·
            hooksPath <.githooks / <other>, left alone / unset> · first run <n>s ·
            desk gate <committed in #<n> / declined / not offered> · protected <regex / none>
services  : db <…/none> · db vars <names / none> · services <…/none> · staging <url/none> ·
            vercel <…/none> · slack <…/none> · check-out → <destination>
people    : reviewer <…> · infra/security <…> · product <…> · designer <…> · QA <…> · deletes <…>
reading   : own-work <a> · local-git <a> · others <a> · slack-public <a> · figma <a> · vercel <a> ·
            confluence <a> · transcripts <a> · calendar <a> · slack-own <a>
jira      : assign-self <a> · comment <a> · create <a> · edit <a> · transition <a> · close-own-merged <a> ·
            close <a> · route <a> · others <a>
git / PR  : commit <a> · push <a> · force-with-lease <a> · open <a> · edit <a> · images <a> · self-review <a> ·
            reply <a> · request-review <a> · ready <a> · auto-merge <a> · merge-green <a> · feedback-first <a> ·
            update-branch <a> · conflict-unreviewed <a> · conflict-reviewed <a> · ci-rerun <a> · codex <a> ·
            ci-protection <a>
autopilot : workers <a> · mode <a> · merge <a> · base-push <a> · judgement <a> · reclaim <a> ·
            dependency-install <a> · screenshots <a> · local-services <a>
local     : db-per-ticket <a> · clone-staging <a> · staging-write <a> · reindex <a> · tests-shared-db <a> ·
            worktree-remove <a> · branch-delete <a> · server-stop <a> · skills-edit <a> · vercel-env <a> ·
            slack-draft <a>
never     : slack-send · merge-bypass · others-prs      stop: product-calls · legal-content
autonomy  : subagents <a> · workers <a> (cap <a>) · memory <a>GB · spawn gate <a> · tests <a> · port <a> ·
            park <a>m · budget <a>/<a> · location <a> · stage reports <a> · push notify <a>
conventions: branches <…> · PR title <…> · attribution <forbidden/allowed> · instructions <files>
design    : breakpoints <widths / none> · system <files / none> · DESIGN.md <drafted in #<n> / declined / not offered>
connectors: Atlassian <present/missing/not needed> · Slack <…> · Figma <…> · Vercel <…> · Playwright <…>
harness   : deny-only plan <already there / n NEW> (user-level) · <n> NEW allow · <n> ask · <n> guards removed ·
            <n> yours (untouched) → <root>/.claude/settings.local.json · backup <path>
plugins   : off here <ids / none> · kept <ids> (skills listed <before> → <after>)
still TODO: <rows>
```

Every row appears, including the `no`s. Then say how to change it: re-run `/desk-setup` in this
repo, `/desk-setup permissions`, or edit the file. No reinstall needed. Other repos are untouched.

Then run `desk-env drift` on the file just written. Any `UNLISTED` line blocks: that §4 command item
can never be allow-listed for a worker, so fix the row with the user (one plain command, or a repo
script run as `bash <path>.sh`) and write it again before going on.

**Then offer the instruction-file audit**, `/desk-cleanup instructions`: it measures everything a
session in this repo loads at launch (the `CLAUDE.md` and `AGENTS.md` chain, rules, `MEMORY.md`,
skill and agent descriptions) and proposes where each oversized part could move. It writes nothing
until the user approves a move. Offer it once, as the last question of setup.
