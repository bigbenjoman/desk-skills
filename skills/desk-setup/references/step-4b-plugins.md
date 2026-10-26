# desk-setup step 4b: plugins this repo needs

Read at the start of step 4b, and for `/desk-setup plugins`, which runs only this step. The step
table in `../SKILL.md` names this file for it. `$ROOT` is §2 Primary repo root, as step 4 sets it.

## 4b. Plugins this repo needs

Every enabled plugin's skills are listed to Claude on every turn, and plugin skills cannot be
listed by name only, so a repo pays for plugins it never uses, and look-alike skills (37
`vercel:*`) are the main cause of wrong picks. Settings precedence is user < project < local, so a
`false` in this repo's `settings.local.json` switches a plugin off **here only**. Measured
2026-09-30: switching off five plugins took a session's listing from 172 skills to 86.

```bash
P=~/.agents/skills/desk-setup/bin/repo-plugins.py
python3 $P --root "$ROOT" suggest          # JSON: plugin, skills, suggest keep/off/unjudged, evidence, now
```

It lists every plugin enabled at user level. Those whose relevance this repo's own files can show
(Vercel, Stripe, Figma, the three legal plugins, Atlassian, TypeSafe) are `keep` or `off` on that
evidence; everything-claude-code is always `off`; codex (desk-review's refutation) and playwright
(screenshots) are always `keep`. Any other plugin is `unjudged`: listed with its skill count, never
suggested off.

1. Show each row as `keep`/`off`/`unjudged`, its skill count and the evidence in one line, then
   **one** `AskUserQuestion` call: "Switch these plugins off in this repo?", multiSelect, the
   evidence as each option's description. A question holds at most four options, so split the rows
   over up to four questions in that call: every suggested `off` first, marked (Recommended), then
   the `unjudged` ones unmarked. Any rows still left over are named in the last question's text, for
   the user to give in its free-text answer. The suggestion is a
   starting point: the user knows what the repo touches outside its files (a Stripe dashboard, a
   contract they review here).
2. Apply what they pick, and only that, to this repo:

```bash
python3 $P --root "$ROOT" apply --off <id,id,…>     # --on <id,…> undoes an earlier off
```

It refuses (exit 2, nothing written) when `.claude/settings.local.json` is tracked or not
git-ignored here, the same rule as §4; pass that on with the `.gitignore` line as the user's action.
It backs the file up first. Autopilot workers are unaffected: they load no plugins at all.
