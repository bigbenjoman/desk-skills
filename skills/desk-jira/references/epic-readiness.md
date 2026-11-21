# Epic readiness review

Run on a drafted epic and its children **before the user is asked to approve them**, by the main
session (a subagent such as Bea cannot start another one: she hands the draft back marked
`READINESS REVIEW PENDING`). Dispatch `ada-devils-advocate` in Judge mode with the whole draft (epic
body, every child, the planned links) and the checklist below. Fix what the draft can fix, then show
the user the draft with the verdict: every item PASS, or the item, the child and what is wrong.

An epic that fails here is cheap to fix. One that fails in a batch parks a ticket, holds everything
behind it, or merges a feature that does not hang together.

## Checklist

1. **Coverage.** Every criterion in the epic's definition of done is met by at least one child's
   acceptance criteria. Name the child per criterion.
2. **Testable.** Every acceptance criterion can be checked as written: Given / When / Then, no
   "works well", no mechanism (file paths, component or library names, regexes) in place of
   behaviour.
3. **Decided.** No open question, "TBD", or "pending sign-off" anywhere. Each decision is dated and
   names its owner. A `Precondition:` line under Verification (the template's input someone else
   supplies) is not an open question.
4. **Order.** The planned Blocks links form no cycle and match the order the epic states. Each link
   is one of two kinds, and the verdict names which: **start-after**, where a child reads or calls
   what another child adds, so it cannot be built first; or **merge-after**, where the blocker is a
   step only the person takes, so the child is built and reviewed meanwhile and merges once the step
   is Done. Autopilot reads both from the one Blocks link, telling them apart by the blocker's label.
5. **Hidden dependencies.** Wherever one child calls, reads or renders something another child adds
   (an endpoint, a table, a component, a copy key), there is a Blocks link between them: a
   start-after link. Every blocker that is a step only the person takes carries the §4 label that
   says what it holds (`desk-env list person-step-labels`, `desk-env list person-input-labels`), and
   the verdict names the label per step: a Person-input label where the step makes something the
   build reads (a fixture, a recorded response, a key), which holds the child's build; a Person-step
   label for a sign-off, walkthrough, go-live or account step, which holds only its merge. A step
   with neither label holds the build as an ordinary blocker. Where both rows are `none`, say so
   and leave the step unlabelled.
6. **No duplicate build.** No two children create the same new thing.
7. **Size.** Every child is M or smaller, and mergeable once its blockers have merged, leaving the
   base green.
8. **Safe to ship part-way.** Each child can reach production before its successors (invisible or
   behind a flag), or the epic is marked to run on a feature branch (autopilot `set-batch base=`).
9. **Design.** Every child that changes what a user sees links its design (Figma or Claude Design)
   or says "no UI".
10. **Scope.** No out-of-scope line contradicts an acceptance criterion, in the epic or a child.
11. **Template.** The epic and every child carry every section `references/ticket-template.md`
    gives their type. No criterion is one a worker cannot do (creating Jira links, a live production
    measurement, an operator run, a sign-off). No status, priority or dependency is written in a body.
