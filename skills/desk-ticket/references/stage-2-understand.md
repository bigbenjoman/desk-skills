# desk-ticket Stage 2: Understand

Read at the start of Stage 2, and no other stage's file with it. The config, the gates, "Ask or
take", the resume file and the red flags every stage shares are in `../SKILL.md`, already loaded;
a "below" here that this file does not hold points there.

| # | Stage | What happens |
|---|---|---|
| 2 | Understand | Read the code paths, and **what the repo's own documentation says about them** before writing any code (below). Reproduce the bug. **Commit the lane now**: this is the first point it is knowable. Transition to §4 In-progress state (Jira only). Flag anything wrong in the ticket. |

**Read what the repo documents before writing code (Stage 2).** The files §5 Repo instructions names
are the repo's own rules, and Stage 4b's review reads the same material, so a documented rule
learnt there costs a round. Where those instructions describe a knowledge base with a check command
that maps a path to the documented claims about it (below, "the knowledge check"), run it for each
file in scope and read the claims it names, not whole domain files. Otherwise read the sections of
the instruction files that cover the paths. If nothing documents the path, say so in one line.

**Commit lane C only on its own signals (Stage 2).** Lane C means a person must agree something before
code exists: a feature sized L or XL, an intermittent bug, or stated behaviour that looks wrong
(`desk-ticket-routing.md`). Work at size M or smaller that spans several packages is lane A or B,
naming the packages; unmerged blockers hold the ticket without changing its lane; and a step only
the user can take becomes its own blocker ticket while the rest keeps its lane.

## Red flags at this stage — stop

- Writing code in a documented area without having read what the repo documents about its files
