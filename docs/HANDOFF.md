# Handoff: continue here after /clear (written 2026-09-27)

Read this first, then `~/.claude/projects/-Users-benlavender-voicepa/memory/project_desk_skills.md`.
Ben's standing rules: solutions not problems; `AskUserQuestion` with a recommended first option;
never paste or echo tokens; verify before claiming; mind zsh (no word-splitting of `$var`, `$x:r`
is a modifier, `?`/`*` glob in unquoted args — use `bash -c '…' _ args` or quote).

## Where things are

- **desk-skills** `~/desk-skills` → `bigbenjoman/desk-skills` (private). Per-repo config at
  `~/.config/desk/repos/<owner__name>/config.md`; `desk-env where`. Installed on this Mac.
  Adversarial review record: `docs/review-2026-09-27.md`; tests: `bash tests/run.sh` (211 checks as of 2026-09-28).
- **Skills, one copy each**: `~/.agents/skills/<name>` is the only real copy, `~/.claude/skills/<name>`
  links to it. Sources in `vendor/sources.json` (types `github`, `drive`, `checkout`).
  `skills-upstream list|outdated|upgrade|verify|plugins|rehash|index`; `/desk-update` is the brew-style skill.
  - 58 pinned third-party skills (byte-identical to a proven upstream commit / Drive zip).
  - `checkout` type: `clerk` → `clerk/skills` cloned in `~/.agents/sources/clerk` with 11 sub-skills linked.
  - Backups of everything moved: `~/.agents/desk-backup/20260927-*`.
- **pullbot** `~/pullbot` → `bigbenjoman/pullbot`, PR #1 merged (generic per-repo config).

## Still to do, in order

1. **Commit + push desk-skills** if `git status` shows changes (the `checkout`/`subskills` support in
   `bin/skills-upstream` and `install.sh`, and the `clerk` entry). Then update README "Skills,
   one copy each" + `/desk-update` sections to describe `vendor/`, the three source types and
   `skills-upstream`.
2. ~~**interactive-prototype**~~ **Stays loose by decision (2026-09-28).** Its SKILL.md says `author: Yummy Labs`,
   `version: 4.0.0`; it was installed at the same second as ux-motion (6 Aug 10:32:12), so both came from Yummy.
   Ben doesn't remember the source, the original download is gone, and no public copy was found (Yummy Labs
   sells a design course; this is likely its material). With no upstream to pin against it stays a loose real
   folder in `~/.claude/skills`, and `skills-upstream links` ignores it because desk does not install it. If a
   Drive/Notion link turns up, add a `drive` entry like ux-motion's. `learned` and `synced` are not skills
   (ECC data dir, claude.ai skill cache): leave them. ✅ ux-motion done 2026-09-28 (#2).
3. ~~Submodules~~ **Dropped 2026-09-27 (Ben's call).** energy-trader is used only by forewatt and
   property-expert only by yield-index, so each lives in its own repo's `.claude/skills/` and nowhere
   else: no user-level copy, no `sources.json` entry, no sync. (A private submodule would also have
   failed Vercel's clone in both repos, and CI reads both folders.) The split repos
   `bigbenjoman/energy-trader` / `property-expert` are unused; Ben to archive or delete them. The
   user-level clones are in `~/.agents/desk-backup/*-skill-repos-retired/`.
4. **Open PRs for Ben to merge**: voicepa #356 (drop shadowing skill copies), forewatt #142 (drop
   context-audit copy).
5. **`/desk-setup` in voicepa is mid-way.** Config written at
   `~/.config/desk/repos/bigbenjoman__voicepa/config.md` with §0–§2, §4, §5 confirmed (Jira site
   voicepa.atlassian.net, create in VPL, keys `(VPL|KAN)-[0-9]+`, worktrees `~/voicepa-worktrees`,
   Local database `none`, 19 merge holds). **Waiting on Ben** to write his Jira login:
   `~/.config/desk/repos/bigbenjoman__voicepa/{jira-email,atlassian-token}` (he runs the `printf`
   commands himself), then `desk-jira whoami`. Next: VPL workflow states + Launch Priority field
   (`customfield_10160`, P1=10068…P4=10071), Other work id patterns (belmont ids like
   `P1-M14-FIX-1`, `FWLUP-…`), People round (Mark = `markpinnes-create`), the §3 permission
   interview, §3b, connectors, harness rules, summary. Resume with `/desk-setup` in `~/voicepa`.
6. Later: `/desk-setup` in pr-ninja, forewatt, yield-index (`~/yieldindex`), gygg-platform (not
   cloned). `/desk-update` to adopt the ~31 outdated upstream skills + `claude-code-setup` plugin
   update — Ben's call per skill.
