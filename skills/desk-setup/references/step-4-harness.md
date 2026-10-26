# desk-setup step 4: harness permissions

Read at the start of step 4, and before a re-run revokes or adds a row's rules (*Re-running and
revoking*, in `../SKILL.md`), which uses the `$H` and `REPO_RULES` this file's first block sets. The
step table in `../SKILL.md` names this file for it.

## 4. Harness permissions

Offer to write Claude Code `permissions` rules so granted actions stop prompting. The rule column
of `references/permission-rows.md` is the only source; read its syntax table first. **The rules
must never grant more than the answers: a prompt is always preferable to an over-grant.** Never
hand-edit a settings file for this; `bin/harness-rules.py` does the merge and the record.

```bash
H=~/.agents/skills/desk-setup/bin/harness-rules.py
eval "$(desk-env where)"                                   # SLUG, CONFIG, CREDS
ROOT=<§2 Primary repo root>
REPO_RULES=(--settings "$ROOT/.claude/settings.local.json" --ledger "$CREDS/harness-rules.json")
```

1. **The deny-only plan first, user-level, before any allow is offered.** Run
   `python3 $H baseline --check` (defaults: `~/.claude/settings.json`, ledger
   `~/.claude/desk/harness-rules.json`). Exit 0: already there; say so. Exit 1: show the `missing`
   lines, say it only takes capability away, then run `python3 $H baseline` (add
   `--slack-prefix <prefix>` for any other Slack prefix the session shows). Not a question. Exit 2:
   the settings file is unreadable; stop §4 and say so.
   Then `python3 $H "${REPO_RULES[@]}" retire`, also not a question: it only takes capability away.
   `retire`, `add` and `baseline` all first drop any rule in the script's `RETIRED` list that setup
   recorded (printed `RETIRED`, backed up first; today the unpinned `gh pr merge` allows and the
   `desk-jira create *assignee*` ask), and `baseline --check` lists them as `retired`. A retired rule
   the user added themselves is printed `retired … yours` with what it still does, and left alone:
   pass that on. Retiring the assignee ask writes the `desk-jira create *--route*` ask in its place
   where it is missing (printed `REPLACED`), so routing keeps prompting; where it was there already,
   its owner moves from `jira-assign-self` to `jira-create` (printed `REOWNED`).
2. **Build the allow plan** (JSON; shape in the script's header), replacing `<merge>` with this
   repo's §4 Merge method flag:
   - an `add` entry for each rule whose **every** owner row is `yes`, `rows` = all its owners.
   - the row's `ask:` guards with the same owners; `unguard:` entries go in `remove_guards`.
   - not the orchestrator tools (Monitor, `mcp__claude-in-chrome__*`, ArtifactComments,
     ArtifactData, Edit on this repo's session memory directory, the desk folders
     `~/.desk-autopilot` and `~/.claude/desk`, and Read on the desk config files): `add` writes them with every plan,
     owner `orchestrator-tools` (permission-rows.md). Show them in step 3 all the same.
3. **Show the plan** grouped by row, _Reach_ notes included, name the file it goes to
   (`<root>/.claude/settings.local.json`), and get a yes.
4. Apply it **to this repo only**, then refresh §3c:

```bash
python3 $H "${REPO_RULES[@]}" add "${TMPDIR:-/tmp}/desk-harness-plan-$SLUG.json"
python3 $H "${REPO_RULES[@]}" list --markdown      # replaces the §3c table
```

**`harness-rules.py` enforces where allows may go**: it writes an allow plan only to a
`settings.local.json` inside a repo's own `.claude/` that git ignores there, and refuses a tracked
or un-ignored file and any user-level file (exit 2, nothing written). Pass its report on: when only
`.git/info/exclude` or your global excludes ignore the file, it recommends adding
`.claude/settings.local.json` to the repo's `.gitignore` so a colleague's clone is covered too
(their call, in a PR). On a refusal, offer that `.gitignore` line (and `git rm --cached` for a
tracked copy) as the user's own action.

5. **Auto-mode entries**, written to `~/.claude/settings.json` because Claude Code reads `autoMode`
   only from user or managed settings (docs, settings-reference, checked 2026-10-22). They tell
   the auto-mode classifier what the user has sanctioned **in this repo**, so a pinned merge or a
   local migration is not blocked while production deploys still prompt. Build the plan from facts,
   never prose (the script owns the wording; shape in its header): `repo` (§0 GitHub repo),
   `granted` (every §3 row that is `yes`), `merge` (§4 Merge method as a flag), `migrate` (§4
   Database migrate, or `null` when `none`). Then read `autoMode.environment` in
   `~/.claude/settings.json`, and for each entry that describes only this repo (a trusted repo, its
   deploy targets, its services) but does not start `In <repo> only:`, ask the user whether to scope
   it here. List those they confirm, verbatim, in `scope_environment`. Show the entries the script
   will write (permission-rows.md, "Auto-mode entries") and get a yes, then:

```bash
python3 $H "${REPO_RULES[@]}" automode "${TMPDIR:-/tmp}/desk-automode-plan-$SLUG.json"
```

   It records each entry in this repo's ledger, so `remove <row>` with `REPO_RULES` also drops this
   repo's entries from the user settings and leaves other repos' alone. An entry it did not write is
   printed `yours` and never touched; an `unscoped` line names an environment entry that mentions
   this repo but applies in every repo: offer to scope it. Exit 2 with `could not be read` means the
   user settings file is unreadable and nothing was written: say so and stop this step. In a later
   `remove`, the same file unreadable prints `FAILED autoMode.allow …` and exits 1: the permission
   rules were still revoked, the auto-mode entries were not, and stay recorded for the next `remove`.

Existing worktrees you open yourself do not see the file; offer to copy it into the ones
`git worktree list` shows (backing up any that exist). A later `remove` updates those copies too,
as long as nobody has edited them since. **Autopilot worker worktrees never get a
copy**: `setup-worktree.sh` does not copy it, because it carries your own allows (merge driver
included). Workers run on their own settings built from §3 by `worker-settings.mjs`, kept outside the
repo in `$DESK_STATE/workers/`.

Say plainly: a harness rule removes the prompt, not the skill's own gate. Autopilot workers never
use these rules.
