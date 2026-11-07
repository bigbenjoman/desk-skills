# Prompt audit: Claude Code configuration loading in desk-skills sessions (2026-11-06)

## Assumptions (Step 0)

- **Target model:** Claude Opus 5.5 (the model this session runs on). Two subagents pin `model: sonnet` (karen, muriel), so they were audited against Claude Sonnet 5.5.
- **Scope:** the Claude Code configuration that loads into sessions here:
  - There is **no CLAUDE.md, CLAUDE.local.md or AGENTS.md** in the project root or any ancestor, no `.claude/CLAUDE.md` in the project, and no `~/.claude/CLAUDE.md`.
  - The two nested `vendor/vercel-*/AGENTS.md` files are vendored upstream copies (treated as a dependency directory) and were not audited.
  - No managed-policy CLAUDE.md was found.
- **What was audited:**
  - `~/.claude/rules/*.md` (4 files).
  - `~/.claude/agents/*.md` (11 subagents) and `~/.claude/commands/userflow.md`.
  - `~/.claude/skills/*`, about 90 skills.
- **Source of truth.** All desk-* skills, the 11 subagents, the command and the 58 vendored skills are **installed from this repo** (`install.sh` → `~/.agents/skills` → `~/.claude/skills`). The proposed edits therefore target the repo source, because an edit to the installed copy is overwritten on the next install. They still load in **every project**.
- **Vendored skills** (`vendor/`, `bin/skills-upstream upgrade` replaces them wholesale) and **clerk-\*** (an upstream checkout) get **flag only**. The fix belongs upstream, or in a recorded local patch.
- **User-level files not from the repo**, marked **[user-level, affects all projects]**:
  - `asking-questions.md`, `context7.md` and `handoffs.md` in `~/.claude/rules/`;
  - the `interactive-prototype` skill;
  - `~/.claude/agents/belmont/*`;
  - `chirp`.
- **Plugins** (superpowers, figma, feature-dev, codex, coderabbit, code-review, atlassian, claude-md-management, code-simplifier) are **report only**.
- **Not read:** settings files, `.mcp.json`, `~/.claude.json`.
- **Method:** seven parallel read-only reviewers, one per file group, each applying `shared/prompt-audit.md`. Eight high-confidence claims were re-checked against the repo by hand, and all held.
- **Non-Anthropic provider markers:** none relevant. codex's `gpt-5-4-prompting` skill concerns GPT prompts.
- **Group 4** (request code) is not applicable: no request-building code is in scope. The subagent roster check found no redundant desk agents.

## Summary

The desk surface is in good health. Paths, scripts, subcommands and flags are almost all accurate. There is almost no caps-lock pressure, thinking prose or retired model IDs, and prohibitions mostly carry their reasons. The debt is **Group 2 drift**. The highest-impact findings:

1. **Commands and claims the repo now contradicts.**
   - The `desk-pr` screenshot invocation leaves out 2 of the 5 arguments its own script needs, so it throws.
   - `desk-review/gotchas.md` uses `--paginate --jq`, which the same skill says never to use (it misses page 2 and later).
   - `desk-disk` excludes a CI-runner VM that was removed on 2026-10-27.
   - An autopilot red flag tells the orchestrator to hand-park a worker that `pass.mjs` already parks automatically.
   - `desk-setup`'s list of §3b rounds leaves out 8 of the 25 rows. This is the gap behind the 2026-11-04 incident where pacing was set back to `5`.
2. **Dead routing text inside nine subagent bodies.** DS-366 moved the "User: … / Assistant: I'll use the X agent" examples out of the descriptions and into the bodies. Only the agent already dispatched reads them there, and it imitates them.
3. **Always-on plugin text competing with your own routing.** superpowers injects an `<EXTREMELY_IMPORTANT>` "1% chance → ABSOLUTELY MUST invoke a skill" block at every SessionStart, plus a brainstorm-before-building gate. It works against `desk-skill-index.md` and `asking-questions.md` ("routine judgement calls are yours"). This is report only; the fix is yours to choose (see P1).

**Counts** (approximate, after merging duplicates):

| Group | Findings |
|---|---|
| Group 1 (dated prompt text) | 24 |
| Group 2 (brittle config: drift, conflicts, fossils) | 45 |
| Group 3 (descriptions and routing) | 9 |
| Group 4 | not applicable (roster check: 0 redundant) |

The proposed diff covers 57 hunks in 36 files: `docs/prompt-audit-2026-11-06/proposed.diff`. Its paths are `a/<repo path>`, with user-level files under `a/home/.claude/…`. **No audited file was edited.**

---

## Findings: high confidence

| # | Location | Evidence | Pattern | Why obsolete | Action |
|---|---|---|---|---|---|
| H1 | skills/desk-pr/references/screenshot-surfaces.md:118-119 | `./<script>.mjs <port> <path> <out.png>` while the script reads `[port, path, out, email, envFile]` | G2 volatile specifics | `readFileSync(undefined)` throws before sign-in | rewrite: add `<test user email> <env file holding the instance's keys>` (in diff) |
| H2 | skills/desk-pr/references/image-upload.md:4-5, :78 | "`SKILL.md` §3 applies unchanged"; "(SKILL.md §4, "Editing the body later")" | G2 stale section ref | after the split, SKILL.md has no §3 gate; the gate is in screenshots.md and the section is in opening.md | rewrite (in diff) |
| H3 | skills/desk-review/references/gotchas.md:149-155 | `--paginate --jq '[.[] …]'` | G2 repo contradicts itself | phase-7-post.md:67 and gotchas.md:80 say never use `--paginate --jq` (it emits one array per page) | rewrite to `--paginate --slurp \| jq '[add[] …]'` (in diff) |
| H4 | skills/desk-disk/SKILL.md:20-21 | "the CI runner VM's disk is DS-62's" | G2 stale fact + ticket ID | the local runner was retired 2026-10-27 (DS-271) and its VM deleted (DS-428); desk-ci:22 says there is no local CI | rewrite (in diff) |
| H5 | skills/desk-autopilot/SKILL.md:273 | "A worker quiet for 6+ passes: park it, do not wait" | G2 repo contradicts | `pass.mjs:229,567` (`WEDGE_PASSES = 6`) parks it automatically; red flag :287 forbids hand-written parks | rewrite to the case the orchestrator must catch: a growing log (in diff) |
| H6 | skills/desk-autopilot/SKILL.md:169-170 | "…and nothing else does" | G2 conflict | desk-cleanup:173 and closeout.mjs also move tickets to Done | rewrite "nothing else in the batch does" (in diff) |
| H7 | skills/desk-setup/SKILL.md:127-131 | "**Then §3b** (five rounds): …" | G2 enumeration outgrown | 8 of 25 §3b rows are missing (Borrow idle workers, Free disk floor, Promotion slice size, Release idle claims, Usage pacing headroom, Maintenance window/drain limit, Intake query), so the template value gets proposed | rewrite (not in diff: the multi-line list needs your wording): "every row the template's §3b holds, four per AskUserQuestion call, in template order; Recommended is the template's value unless a rule below names another; a row this repo already sets, `off` included, is offered first as it stands." |
| H8 | agents/{bea,jim,karen,lena,mira,muriel,otto,suki,theo}.md, the `## When you are called` blocks (e.g. lena:9-23) | `- User: "Review this PR…" / Assistant: "Let me launch the lena-code-reviewer agent…"` | G3 fake dialogue / G1c stale few-shot | routing text that only the already-dispatched agent reads; the strongest signal in each prompt, in a third-person voice. No test covers bodies (`tests/test_skill_size.mjs` checks descriptions only) | remove; Muriel's Suki-boundary line moves under *Division of Labour with Suki* (in diff) |
| H9 | agents/suki-frontend-architect.md:10 | "Auto-trigger phrases (any of): … 26 phrases" | G2 trigger enumeration in a body | read only after Suki is chosen | remove (part of the H8 hunk) |
| H10 | agents/nadia-security-auditor.md:95 vs :114-115 | "it never approves or blocks one on its own" vs `[BLOCK / APPROVE WITH CONDITIONS / APPROVE]` | G2 contradiction (blame: :95 is the newer line, 2026-10-03) | desk-review/SKILL.md:23 agrees with the newer line | rewrite the verdict to severity counts (in diff). The Critical Rules (:120-122) are **flagged, not edited** (prohibitions): if you agree, make them "Rate as P0: …" |
| H11 | agents/karen-seo-optimizer.md:127-154 | "Your PR description should follow this structure: ## SEO/GEO/AEO Optimization Report" | G2 conflict with desk-pr / §5 PR body | desk-pr owns the body (`the-body.md`, updated 2026-11-01) | rewrite to "write the body with desk-pr…" (in diff) |
| H12 | ~/.claude/skills/interactive-prototype/SKILL.md:110-112, :381, :394 **[user-level, affects all projects]** | "Use `ask_user_input`…"; "move to Claude Code" | G2 tool contract that doesn't resolve | installed in Claude Code, where the tool is AskUserQuestion | rewrite :110-112 (in diff). :381/:394: make "move to Claude Code" apply only to claude.ai (proposed text: "In a claude.ai artifact, offer to move to Claude Code; in Claude Code, offer to wire it into the repo or deploy a preview"), not in diff |
| H13 | interactive-prototype SKILL.md:305 vs :383 **[user-level]** | "write out your findings visibly" vs "Do not include the raw audit log" | G2 contradiction in one file | both can't be followed | rewrite :305; "re-test mentally" → "re-render and re-check" (in diff) |
| H14 | ~/.claude/rules/asking-questions.md:9, :17-18 **[user-level]** | "in all five categories below"; "(rules 1, 2 and 4)" | G2 stale count | there are six categories, and rule 6 (property-expert) also names a skill | rewrite (in diff) |
| H15 | asking-questions.md:64 **[user-level]** | "Measured 2026-08-19 in this repo" | G1d relative phrasing | the rule loads in every project, so "this repo" points at whichever repo is open | rewrite "in the YieldIndex repo" (in diff) |
| H16 | skill-index generator, bin/skills-upstream:~1029 → ~/.agents/skills/skill-index/SKILL.md:15 | "If none fits, no skill applies: say so and carry on." | G2 repo contradicts | `installed_skills()` never sees Claude Code's bundled skills (claude-api, update-config, …), and area summaries promise skills their rows lack | rewrite the step-1 text (in diff). Follow-up, not in diff: emit a "not installed here" cell per area |
| H17 | skills/desk-setup/references/step-1-detect.md:189-190 | "autopilot and clearance will never merge a PR that touches a held path" | G2 conflict (newer: permission-rows.md:194, `merge-hold-routine`, DS-411) | no longer true when the routine row is `yes` | **flag** (a safety statement; the guide says flag). Suggested: "clearance never merges a held PR; autopilot merges one only when `merge-hold-routine` is `yes` and the hold's routine passed at that head" |
| H18 | skills/desk-cleanup/references/step-6-report-only.md:19 vs instruction-audit.md:82-83 | "never rewrite a memory file here" vs "apply the approved diff with Edit or Write" | G2 conflict; the newer text loosens a prohibition | | **flag**: you decide whether approved memory-index moves may be written |

## Findings: medium confidence

| # | Location | Evidence | Pattern | Action |
|---|---|---|---|---|
| M1 | skills/desk-review/references/review-bar.md:115-117 | "her "Minor" is P3 and dropped" | G2 stale (Lena has no Minor section) | rewrite (in diff) |
| M2 | skills/desk-cleanup/references/step-2-worktrees.md:107-108 | "the path with `/` turned into `-`" vs step-6 "each non-alphanumeric character" | G2 conflict | rewrite (in diff) |
| M3 | skills/desk-autopilot/SKILL.md:29-30 | "where one and a skill disagree, the skill wins" | G2 internal contradiction (the contract overrides skills on purpose) | rewrite (in diff) |
| M4 | desk-autopilot/references/autopilot-worker-contract.md:182 | "Nobody is reading live, so drop the running commentary." | G1d update suppressor (DS-173: workers sat at 0/9) | rewrite to "…the orchestrator greps it. Print one line at each stage boundary" (in diff) |
| M5 | desk-autopilot/references/status-table.md:60 | "the D6 baseline" | G2 orphaned DoD id | rewrite (in diff) |
| M6 | desk-autopilot/references/status-table.md:40 | "reply in one line at most" | G1f numeric cap | rewrite "reply briefly" (in diff) |
| M7 | desk-autopilot (19 sites) and desk-setup (6 sites): "as before", "as it always has", "no longer", "today", "now" | e.g. SKILL.md:101 "workers check as before" | G1d migration-relative phrasing; headless workers read these cold | rewrite: 12 sites in diff. feature-mode.md:109/119/159, epic-batch.md:65, orchestrator-recovery.md:176, merging.md:200, feature-branch.md:76, worker-contract-stage-4.md:251, desk-setup :141/:153, permission-rows:207 and step-4-harness:29 are line-wrapped and left for hand edits using the replacements below |
| M8 | desk-autopilot/references/stalls-and-spend.md:28; desk-setup/SKILL.md:147-151 | "an alias such as `haiku`"; "(`sonnet`, `haiku`) for self-review finders" | G1c example plus a conflict with your opus-over-sonnet memory | rewrite (in diff) |
| M9 | desk-setup/references/permission-rows.md:60 | "(decisions 2026-10-21 and 2026-10-23: …" | G2 history narrative | rewrite (in diff) |
| M10 | desk-kiss/SKILL.md:75 | "there is no `--fix` or `--no-fix` flag" | G1d phantom alternative | remove (in diff) |
| M11 | desk-update/SKILL.md:155 | "~30,000 -> ~9,600 chars a turn" | G2 unverified figure (skills-upstream:960 says "~30,000 either way") | rewrite (in diff) |
| M12 | desk-jira/references/cli-and-markup.md:12-13 | "your copy predates 2.0: re-run install.sh" | G1d fossil | remove (in diff) |
| M13 | desk-review-response/SKILL.md:36-38, :189 | "**Load this skill, don't approximate it.**" | G3 trigger text in body | move into the description (in diff) |
| M14 | desk-review-response/references/voice.md:36-42, SKILL.md:193 | "PR reply: 2-3 sentences. … Standup: 3-5 bullets" | G1f numeric ceilings | rewrite as an outcome (in diff). You may reasonably decline: it is your register |
| M15 | desk-review/SKILL.md:3-11 | a description that is ⅔ mechanics | G3 / G2 every-session text | rewrite (not in diff): "Use when reviewing a branch, a PR or the open PR queue in this repo before a human does: "review my branch", "review #460", "sweep the open PRs", "/desk-review". Also the §4 Local review command desk-ticket, desk-review-response and autopilot workers run at Stage 4b." |
| M16 | desk-review/references/phase-0-preflight.md:45-48 | "Fix it with `! codex login`, or say **proceed**" | G2 conflict with asking-questions (no recommendation) | rewrite to lead with **Recommended** (not in diff) |
| M17 | desk-ticket/references/stage-4b-self-review.md:9, :81-83, :140 (+ SKILL.md:200, 214) | "Moving equivalent sites onto a helper … is not growth" ×3 | G1c repetition | rewrite: keep :81-83, shorten :9 and :140 (not in diff) |
| M18 | desk-disk/SKILL.md:14-16 | "one lost about 4,700 Docker volumes…" | G2 narrative as the reason | rewrite: "Disk fixes are mostly irreversible, and a fix batched with others can run after the user rejected it…" (not in diff) |
| M19 | agents/karen-seo-optimizer.md:60-99, :239 (Sonnet 5.5 target) | 5-phase script; "Analyse thoroughly, implement carefully…" | G1c choreography; G1a/1d booster | rewrite / remove (in diff) |
| M20 | agents/lena-code-reviewer.md:232-240 | 7 × "Do NOT …" restating P3 | G1c/1e | rewrite to "Staying in your lane" (not in diff) |
| M21 | agents/ada-devils-advocate.md:194-201 | "NEVER rubber-stamp. ALWAYS steel-man…" | G1a/1c | rewrite to "Two rules that matter most" (not in diff) |
| M22 | agents/theo-api-designer.md:152 | "**Update your notes** … if you keep memory" with no `memory:` | G2 config mismatch | add `memory: user` (in diff) |
| M23 | agents/jim-solution-architect.md:89-99 | "Vercel KV/Postgres (both discontinued)" | G2 undated vendor claims | rewrite the heading with "checked 2026-09; confirm against current docs" (not in diff) |
| M24 | agents karen:23-50, mira:68-75, lena Step 3, jim:103-111 | capability bullet walls | G2 verbose known content | remove the generic parts, keep lines with a house reason (not in diff) |
| M25 | ~/.claude/rules/context7.md:1-3 **[user-level]** | the whole "Use Context7 … Do not use for: … code review" paragraph | G2 drifted duplicate of the Context7 server's own instructions (the server's newer text excludes only reviewing code that doesn't depend on a library, and adds porting) | rewrite to defer to the server's instructions and keep the Steps (in diff) |
| M26 | ~/.claude/agents/belmont/design-agent.md:43, :169, :253-255 **[user-level]** | SKIPPED rule ×3, 15 emphatics | G1a/1c | rewrite :43, remove :254 (in diff) |
| M27 | interactive-prototype SKILL.md:41, :106, :301-307, :3 **[user-level]** | "avoid the generic AI look"; "MANDATORY GATE"; "MANDATORY, DO NOT SKIP"; 12-phrase trigger list | G1e (Opus 5.5 frontend exception: name the defaults); G1a; G2 enumeration | :41 and :301-303 in diff. :106 → "Ask, then end your turn and wait for the designer's answers before writing code, so they shape the prototype instead of reacting to your assumptions." :3 → intent categories. These two are not in diff |
| M28 | desk-autopilot/references/worker-contract-stage-4.md:42-44 vs batch-notes-header.md:53-54 | "keep the cap, proceed" vs "drop to the lower cap" when with-lock is refused | G2 conflict; the newer text loosens a safety rule | **flag** |
| M29 | desk-checkout/references/style.md vs desk-review-response/references/voice.md:3-4,19,33 | em-dashes and hedges are allowed in one file and banned in the other; both claim standup posts | G2 conflict; history can't order them (both 2026-09-27) | **flag**: scope voice.md to exclude check-outs, or align style.md |
| M30 | desk-needs-you/SKILL.md:61-62; desk-ticket/SKILL.md:103-106; agents/bea:70-75 | "With no recommendation, none is labelled" | G2 conflict with asking-questions.md "Always provide a recommendation" (outside the project) | **flag**. Project-side option: "label none, and say what would decide it" |

## Low confidence and flags (no edit proposed)

- **desk-clearance.**
  - phase-3-assess.md:14-16, "It is an order." Re-test it plainly on Opus 5.5.
  - SKILL.md:58-65 and hazards.md:93-97, "by PR 15". This figure was measured on an older model; keep the flat-parent design and re-measure the figure.
- **desk-setup.**
  - step-4b-plugins.md:9-12 has dated plugin counts.
  - The `voicepa` example repo name appears in a skill that loads everywhere (SKILL.md:7, :55; step-2-interview.md:17).
- **desk-admit:6.** "admit DS-123" uses this repo's own key; use `ABC-123`.
- **desk-update:4-12.** The description lists 8 near-synonym triggers.
- **desk-jira.**
  - SKILL.md:253/297 has "Two or three lines" (a team format convention).
  - desk-jira:234 and desk-pr opening.md:88 are low-stakes asks that conflict with your ask-only-on-reserved-topics memory.
- **desk-autopilot.**
  - SKILL.md:225-226 says "your own judgement…". Consider adding "after loading any skill your rules name".
  - The red-flag and rationalization lists repeat the body. They are recaps (keep list 10), apart from H5.
  - `desk/bin/harvest.mjs:24,46` reads only `text` blocks. On Opus 5.5, between-tool text can arrive as `thinking` blocks, so check one worker log to see where mid-turn `AUTOPILOT_STAGE` markers land. This is code, outside the .md scope.
- **Agents.**
  - Karen and Muriel are pinned `model: sonnet`, which contradicts your opus-over-sonnet memory. Muriel writes production React. The fix is `model: opus` if you agree.
  - "elite" and credential persona lines (keep list 9).
  - interactive-prototype doesn't load ux-designer/ui-designer before its UI questions, as asking-questions.md rule 1 requires.
- **Belmont** (`~/.claude/agents/belmont/`, symlinked).
  - These six files have no frontmatter, so Claude Code does not register them. They are prompt templates for the separate `belmont` CLI.
  - Leaving them in `~/.claude/agents` is misleading but harmless.
- **Vendored skills (fix upstream or record a local patch).**
  - **context-audit** has stale Claude Code facts: "15-20k tokens per MCP server every turn" (tools are deferred now), `.claudeignore`, and `autocompact_percentage_override`. It also has a points-arithmetic score.
  - **docker-expert** hands off to skills that don't exist ("kubernetes-architect (future)") and then stops. Its description is an identity statement.
  - **ux-copywriter.** Its MANDATORY GATE contradicts its own "infer for single strings" rule, and its gold example asks questions for a single error message.
  - **ux-designer, ui-designer and ux-copywriter ask-first gates** conflict with your batch-mode question rules. A one-line user rule saying your question rules override vendored ask-first gates would settle it without touching vendor files.
  - **find-skills** runs `npx skills add … -g -y`, which bypasses sources.json pinning.
  - **fastapi-pro and data-engineer** are template padding. Consider dropping them from sources.json.
  - Trigger enumeration appears in about 12 vendored descriptions. The cost is low because they are name-only in the listing.
- **clerk upstream.**
  - clerk-cli ("prefer the CLI") contradicts clerk-backend-api ("ALWAYS execute requests with direct curl").
  - The "LTS until Jan 2027" date will rot.
  - clerk-custom-ui gives the shadcn rule twice.
  - clerk-backend-api echoes the start of the secret key.
- **chirp** has a frontmatter `notice` that smuggles behaviour, and its "cannot … yet" wording will date.

### Plugins (report only; owner: plugin author)

- **P1. superpowers 7.0.0, SessionStart hook plus using-superpowers:10-50.**
  - What it does: `<EXTREMELY_IMPORTANT>` around "1% chance … ABSOLUTELY MUST invoke … not negotiable", invoked before any response including clarifying questions, plus a red-flags rationalization table and an announce-the-skill rule.
  - Pattern: G1a. On Opus 5.5 this over-triggers.
  - Interaction with your setup: it stacks a second routing regime on `desk-skill-index.md`. Together with the brainstorming skill's "MUST use before … modifying behavior" and its one-question-per-message HARD-GATE, it conflicts with `asking-questions.md` "Scope" and with unattended batches.
  - Your options: disable the plugin, or add a user rule saying `desk-skill-index.md` and `asking-questions.md` govern skill routing and questions.
- **P2. figma 2.2.157.**
  - figma-use:51-55 says to issue parallel `use_figma` calls in one message. figma-generate-library:113 says "NEVER parallelize `use_figma` calls". Both load together.
  - Elsewhere, MUST-walls cover real contracts that should stay as plain contract text.
- **P3. Pinned cheaper models against your opus-over-sonnet memory.**
  - feature-dev's code-reviewer, code-explorer and code-architect are `model: sonnet`.
  - `code-review` command:15-56 pins haiku/sonnet per step.
  - superpowers subagent-driven-development:186-217 says "least powerful model".
- **P4. Overlapping reviewers.** `code-review` (plugin), the built-in `/code-review`, coderabbit's two, feature-dev:code-reviewer, and your lena-code-reviewer. Consider disabling the plugin `code-review`, which the built-in supersedes.
- **P5. Dated pressure elsewhere.**
  - feature-dev:61 "CRITICAL … DO NOT SKIP" clarifying questions.
  - codex-result-handling:19: the constraint is real, so keep it, but the volume is dated.
  - The atlassian "ALWAYS ASK/offer" lines, plus stale `skills/v1/` copies.
  - superpowers writing-skills teaches the "YOU MUST / No exceptions" register. Don't author desk skills from it.
- Installed but not visible in this session: everything-claude-code (168 signal hits) and vercel (26). Their enabled state was not checked because settings were not read.

## Clean

- `~/.claude/rules/desk-skill-index.md` and `~/.claude/rules/handoffs.md` match the repo (desk-config.md §2 Handoff directory, desk-reboot).
- `commands/userflow.md`.
- desk-ci, desk-groom, desk-checkout scripts, desk-reboot (no findings beyond the above).
- No retired model IDs, `budget_tokens`, `temperature`, "think step by step" or `<thinking>` scaffolds anywhere in the loaded surface.

## Verify (Step 7)

- **Conflicts and facts:** re-check them against the repo. `tests/test_skill_size.mjs` checks only descriptions, and grep found no tests on the changed body text.
- **The agent example removal (H8)** is the change that most affects behaviour. Run one desk-review pass and one Suki task before and after.
- **M4 (the commentary suppressor):** watch one autopilot batch's stage reporting after the change.
