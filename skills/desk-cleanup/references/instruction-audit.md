# desk-cleanup: the instruction-file audit

Read when step 6 reaches the instruction files, or when `/desk-cleanup instructions` runs the audit on
its own (as `/desk-setup` offers when it finishes). The config, ownership, the confirmation and the red
flags every step shares are in `../SKILL.md`, already loaded.

## What loads at launch, and where each oversized part could go

Every session and every autopilot worker reads the same files before it does any work, so each line
in them costs every session in the repo. Some places load only when the work reaches them: a rule
with `paths:` in its frontmatter, a `CLAUDE.md` in a subdirectory, a skill's body and its references,
and a memory topic file. The audit measures what loads at launch and proposes moving each oversized
part to one of those places.

Run the scan from the repo root. It only reads:

```bash
node ~/.agents/skills/desk-cleanup/bin/cleanup-scan.mjs instructions --repo <repo root> \
  [--skill-doctor <file>] [--prompt-audit <file>]
```

It prints one `launch` line per file, in the order Claude Code reads them, with its size: the managed
policy `CLAUDE.md`, `~/.claude/CLAUDE.md`, the rules in `~/.claude/rules` and `.claude/rules` that have
no `paths:`, the `CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.md` and `CLAUDE.local.md` in the repo root
and every directory above it, the auto-memory `MEMORY.md`, and the description of every skill and
agent in `~/.claude` and `.claude`. A skill is counted as the skill listing carries it: left out when
`skillOverrides` sets it `off` or `user-invocable-only` or it sets `disable-model-invocation: true`,
listed by name only under `name-only`, and otherwise its description with its `when_to_use`. Plugin
skills are not counted. A `total` line ends the list.

The caps: 200 lines for an instruction file (Claude Code's own target for one `CLAUDE.md`), 6 KB or
60 lines for `MEMORY.md`, and 1,024 characters for a description. A line over its cap says so.

**An `@` import is listed under the file that names it, and says that it does not reduce what
loads.** Claude Code reads the imported file when it reads the importer, so moving text behind an
`@` import changes where the text lives, not what a session carries. Never propose an import as a
fix for size.

For each file over its cap, the scan prints a `propose` line per move, largest section first, until
the file would be within the cap:

| The text | Moves to | Loads |
|---|---|---|
| a section naming paths under one directory of the repo | that directory's `CLAUDE.md` | when a file under it is read |
| a section naming paths under several directories | a rule in `.claude/rules/` with those directories in `paths:` | when a matching file is read |
| a section naming no path, or in a file outside the repo | a skill whose body is the section | when the skill runs |
| a `MEMORY.md` entry longer than one line | a memory topic file, with a one-line pointer left in the index | when the session looks it up |
| a skill or agent description past its first sentence | the skill or agent body, under `## When to use` | when it runs |

Then `diff :` and every change as a unified diff: the source file losing each section, and each new
or extended file. A new skill's description is a draft: say so in the plan, and offer a better one.
A file over its cap with no headed sections gets no move; the plan says to split it by topic first.

## Run /skill-doctor and /doctor prompt-audit, never a copy of them

Where `/skill-doctor` and `/doctor prompt-audit` are installed, run each and pass its output to the
scan, which prints it verbatim:

```bash
claude -p '/skill-doctor'          # save to a scratch file, then --skill-doctor <file>
claude -p '/doctor prompt-audit'   # save to a scratch file, then --prompt-audit <file>
```

With `--skill-doctor`, the scan lists each description's size and judges none of them: the findings
on skills and agents are skill-doctor's. A command that answers that it is unknown is not installed;
the plan's `skipped` line names it, and the scan's own description check stands in for it.

## The plan, and what approval writes

The scan's `launch` lines go in the plan's `report only` section, and its `propose` lines and diffs
go under `instructions` (see the confirmation in `../SKILL.md`).

**Nothing is written until the user approves it.** Approval is per proposal, and covers the diff as
shown and nothing else. What an approved move writes depends on where it lands:

- A file outside the repo (`~/.claude`, a memory directory): apply the approved diff with Edit or
  Write, and say what was written.
- A file the repo tracks, or a new file in it: never written here. This skill does not commit, and
  a restructure of the repo's instructions is a change for review. Offer to file a ticket carrying
  the approved diffs, under §3 `jira-create` (with §4 Tracker `none`, hand the diffs to the user).

A proposal the user declines, or does not answer, is left as it is.
