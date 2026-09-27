# Lane routing

Pick a lane at Stage 0, **commit it at the end of Stage 2**. The lane sets how much machinery
the ticket gets and how much autonomy you have.

## Why the lane is provisional until Stage 2

Lane A requires "cause is obvious"; lane B is "cause unknown". That distinction is not knowable
before reading the code, so a Stage-0 choice is a guess. The mis-routing is asymmetric:

- **A when it was really B** is the expensive direction. Lane A proceeds without asking, so a
  symptom patch lands *plus a guarding spec that codifies the wrong behaviour* — and it is only
  caught when the human tests it, if then.
- **B when it was really A** costs ten minutes of unnecessary care.

So default toward the cheaper lane for *cost*, and toward the more careful lane for *certainty*.
When Stage 2 contradicts the Stage-0 guess, say so and re-state the lane before continuing.

## The lanes

| Lane | Predicate — all must hold | Path | Subagents |
|---|---|---|---|
| **A** | the change is mechanical once the cause is known · no product or design decision · repro reproduced or the change is cosmetic | direct minimal change | 0 |
| **B** | Jira type is Bug · repro confirmed · cause not identified after reading the code | `superpowers:systematic-debugging`, then `superpowers:test-driven-development` | 0–1 |
| **C** | new feature spanning more than one sitting · or spans `packages/studia-web` and `apps/portal` · or the bug is intermittent · or the ticket's stated behaviour looks wrong rather than the code | **agree first**: a plan or the evidence at the end of Stage 2, then wait (below) | the area experts' design consults |
| **D** | the deliverable is a screen, section or component built from a Figma design | `muriel-design-engineer` builds it with the `figma-to-studia` skill; Stages 4–9 stay here (below) | 1 |
| **E** | data, catalog or staging-DB work · little or no application code · deliverable may be a one-off script rather than a PR | staging-write runbook | 1 reviewer |

Ties break toward the cheaper lane, then state the doubt.

**A Figma frame on its own is not lane D.** Nearly every Studia UI ticket links one. A change to an
existing screen that happens to carry a frame is lane A: load `figma-to-studia` for the token
mapping and build it here. D is for when the design is the specification for something new.

**Legal or compliance content is none of these.** It goes findings-first (gate 8): a Jira comment
with the recommended change, and a follow-up ticket that waits for team sign-off.

## Demotion triggers — re-state the lane and re-gate

Leaving lane A silently is the failure this exists to prevent. Any one of these means stop,
say which trigger fired, give the new lane and its cost, and wait:

- the first minimal change does not make the repro go away
- the change stops being mechanical — you are learning something new about the cause with each
  edit, rather than applying a cause you already understood. A wide diff is not itself a trigger:
  fifteen files each getting the same known one-line change is still lane A; three files that keep
  surprising you is not
- a product, design, or catalog question surfaces
- the ticket's own description is contradicted by the code
- the fix depends on the shape of an external API's payload — a webhook body, a third-party
  response. A guessed contract is how one fix turns into five, so the fix carries three
  obligations: parse the response with zod; build the spec fixture from a recorded real payload
  and name its source in the PR's Testing; and verify a runtime or hydration fix on a preview
  before merge

## Cost is stated, not silent

Before starting lanes C or D, say the lane, the specific signal that chose it, and the subagent
count — then wait for agreement. Lanes A, B and E proceed without asking. How many subagents may run
without asking at all is config §3b.

Cost is the whole reason lanes exist. "Delete an empty video placeholder" is one line; routed to C
it would stop for a plan nobody needs. Escalation needs a named signal, never a
feeling that the ticket seems important.

## Lane C — agree before building

C is the work where building the wrong thing is the expensive outcome, so Stage 2 ends in something
the user can say yes to, not in code:

- **A feature too big for one sitting, or one spanning `packages/studia-web` and `apps/portal`:** a
  plan naming the files each part touches, the order, and where it splits into independently
  mergeable stages, each its own PR. Get each area's design from its expert (SKILL.md, Stage 3) and
  put it in the plan. Look for prior art first: an existing pattern on `origin/main` usually
  shrinks the work to lane A.
- **An intermittent bug:** `superpowers:systematic-debugging` until the cause is evidenced, then the
  evidence and the proposed fix.
- **The ticket's behaviour looks wrong rather than the code:** that is a product question. Post the
  finding to the ticket through `desk-jira` and wait for the owner (config §4).

Write the resume file, then stop and wait. Once agreed, build in this session one stage at a time,
each through Stages 3–9 as its own PR.

## Lane D — design build

When a Figma design is the specification:

1. At Stage 3, dispatch `muriel-design-engineer` with the Figma URL or node, the ticket, the files in
   scope from Stage 2, and an instruction to follow the `figma-to-studia` skill: studia tokens and
   components, i18n keys, the Storybook story, and the screenshot diff against the frame. It commits
   nothing; ask for the changed files and the diff result.
2. Read what it changed before Stage 4, as you would a colleague's diff. Stages 4–9 run here.
3. Placeholder copy in the design does not block the build (working-style reference).

The build goes to muriel rather than being written here because a Figma node carries its own
specification, so little of the context a handoff usually loses is at risk.
