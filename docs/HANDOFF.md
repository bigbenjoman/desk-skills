# Handoff: continue here after /clear (written 2026-09-27)

Read this first, then `~/.claude/projects/-Users-benlavender-voicepa/memory/project_desk_skills.md`.
Ben's standing rules: solutions not problems; `AskUserQuestion` with a recommended first option;
never paste or echo tokens; verify before claiming; mind zsh (no word-splitting of `$var`, `$x:r`
is a modifier, `?`/`*` glob in unquoted args — use `bash -c '…' _ args` or quote).

## Where things are

- **desk-skills** `~/desk-skills` → `bigbenjoman/desk-skills` (private). Per-repo config at
  `~/.config/desk/repos/<owner__name>/config.md`; `desk-env where`. Installed on this Mac.
  Adversarial review record: `docs/review-2026-09-27.md`; tests: `bash tests/run.sh` (148 checks).
- **Skills, one copy each**: `~/.agents/skills/<name>` is the only real copy, `~/.claude/skills/<name>`
  links to it. Sources in `vendor/sources.json` (types `github`, `drive`, `checkout`).
  `skills-upstream list|outdated|upgrade|verify|plugins|rehash`; `/desk-update` is the brew-style skill.
  - 59 pinned third-party skills (byte-identical to a proven upstream commit / Drive zip).
  - `checkout` type: `energy-trader` → `bigbenjoman/energy-trader`, `property-expert` →
    `bigbenjoman/property-expert` (both private, split with history 2026-09-27), and `clerk` →
    `clerk/skills` cloned in `~/.agents/sources/clerk` with 11 sub-skills linked.
  - Backups of everything moved: `~/.agents/desk-backup/20260927-*`.
- **pullbot** `~/pullbot` → `bigbenjoman/pullbot`, PR #1 merged (generic per-repo config).

## Still to do, in order

1. **Commit + push desk-skills** if `git status` shows changes (the `checkout`/`subskills` support in
   `bin/skills-upstream` and `install.sh`, and the `clerk` entry). Then update README "Skills,
   one copy each" + `/desk-update` sections to describe `vendor/`, the three source types and
   `skills-upstream`.
2. **ux-motion, interactive-prototype**: Yummy Design skills still loose in `~/.claude/skills`. Ask
   Ben for their Google Drive folder links (like the UX/UI ones), list the folder via
   `https://drive.google.com/embeddedfolderview?id=<id>`, download, confirm byte-identical, add as
   `drive` entries (see ux-designer's entry), `skills-upstream rehash`, `./install.sh </dev/null`.
   `learned` and `synced` are not skills (ECC data dir, claude.ai skill cache): leave them.
3. **Submodules** (Ben chose this): in `bigbenjoman/forewatt` replace `.claude/skills/energy-trader`
   and in `bigbenjoman/yield-index` (local clone `~/yieldindex`) replace `.claude/skills/property-expert`
   with a git submodule of the new repo at the SAME path, pinned to the commit whose tree equals the
   current copy (verify tree equality first). Both paths are load-bearing: forewatt
   `.github/workflows/doc-guards.yml` runs `docs/trading-skill/tools/check_skill_pointers.py --skill
   .claude/skills/energy-trader`; yield-index `.github/workflows/ci.yml` path-filters
   `.claude/skills/property-expert/references/**`, `apps/pipeline/tests/test_attribution_single_source.py`
   and scoring code cite it. CI needs `actions/checkout` with `submodules: true` and access to the
   private skill repo: proposed read-only **deploy key** per skill repo (public half on the skill repo,
   private half as a secret in the consumer repo, `ssh-key:` on checkout) — confirm with Ben before
   creating keys/secrets. Use worktrees off `origin/main` (Ben's checkouts have in-flight work). PRs,
   not direct pushes.
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
