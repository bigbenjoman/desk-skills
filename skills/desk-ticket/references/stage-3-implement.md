# desk-ticket Stage 3: Implement

Read at the start of Stage 3, and no other stage's file with it. The config, the gates, "Ask or
take", the resume file and the red flags every stage shares are in `../SKILL.md`, already loaded;
a "below" here that this file does not hold points there.

| # | Stage | What happens |
|---|---|---|
| 3 | Implement | Per lane. A ticket that renders UI loads the design skills before any UI code (below). A change that is not mechanical gets its design from the area's expert first, and you write the code (below). Lane C stops for agreement before this stage; lane D hands the build to the project's design-build agent where it has one (routing reference). |

**Experts shape the design; you write the code (Stage 3).** The project's own subagents (in
`.claude/agents/`, linked into a worktree by §4 Project subagents sync, `desk-env cmds agents-sync`) are for development as well
as review. When a change is not mechanical, ask the agent that owns its area for the approach before
writing it, routed by path: use the area table the repo gives them (the local review command's role
table where it has one, otherwise each agent's description), and the infra and security owner's
paths from §4 People for infra and auth. Brief it with the ticket, the repro and what you have read,
and ask for the design, not the code. Then write it in this session, which holds the ticket context
and can ask the user; splitting one change across agents by file type loses both. Mechanical changes
need no consult. A repo with no project subagents has no consult: put the design in the plan
yourself and say so. Lane D is the exception (routing reference).

**A ticket that renders UI loads the design skills before any UI code (Stage 3).** It renders UI
when autopilot triage says `renders: true`, when the ticket's Design section says anything other
than `No UI`, or when the change alters what a user sees. Nobody has to ask; load them in every lane,
before the first component, style or message-file edit:

- **`ux-designer`** for the flow and every state the UI can be in: empty, loading, error and
  success, plus any the ticket implies. A state the design or ticket does not show is designed here,
  not left to whatever the code falls into.
- **`ui-designer`** in its existing-system mode (Mode B), against the files §5 Design system names
  (`desk-env list design-system`): read them before designing. Every colour, type size, spacing value
  and radius comes from those tokens; a value they do not hold is labelled in the PR as a proposed
  extension (its Mode C), never added silently. With the row `none`, its own Step 0 detection decides
  the mode, and the PR says which it chose.
- **`ux-copywriter`** for any user-facing wording: labels, buttons, errors, empty states,
  confirmations. Copy the ticket or design states verbatim stays verbatim; this is for the wording
  nobody wrote.

Load each with the Skill tool. An autopilot worker has no skill registry and reads each one's
`SKILL.md` as a file instead (worker contract). A skill that is not installed is said in the plan,
with `/desk-update` as the fix, never skipped silently. Brief any design consult or design-build
agent (Suki, Muriel) with the same three skills and the Design system row.

## Red flags at this stage — stop

- Handing an expert subagent the implementation rather than asking it for the design

## Rationalizations at this stage

| Excuse | Reality |
|--------|---------|
| "The design has placeholder copy, so the ticket is blocked" | Build with the placeholders in as real copy keys and raise **one** spin-off ticket for all of them, in desk-jira's ticket template. |

## Common mistakes at this stage

| Mistake | Consequence |
|---|---|
| Handing the implementation to an expert subagent | It has none of the ticket, repro or code reading this session built, and cannot ask the user. Ask it for the design; write the code here |
