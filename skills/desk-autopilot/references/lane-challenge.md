# desk-autopilot: why C and D get a second look

Part of desk-autopilot, read at Stage 1b and Stage 2 when triage puts a ticket in C or D, and when
the user rules on a lane. It binds exactly as the core `SKILL.md` does. Where it says "above" or
"below" of something this file does not hold, or cites a section in *italics* it does not hold, that
is in the core or in the file the core's reference table names.

## Why C and D get a second look

Triage is one `claude -p` pass forming one opinion, and for A, B and E that is fine: the worker
commits its own lane at `desk-ticket` Stage 2 and demotes if it was wrong, so a bad guess costs
minutes. **C and D are different, because they are terminal here**: `plan-batch` parks them (a D
only when its canvas is not saved on the base or snapshotted), no worker ever runs, and the ticket sits until the user reads a question. A wrongly parked ticket
costs a whole batch cycle and looks exactly like a correctly parked one. So here
**C-or-D-when-really-A** is the expensive direction, and the challenge only ever runs downhill.

The over-escalations that have actually happened, all named in the challenge prompt:

- **A design frame read as lane D on its own.** In a repo whose UI tickets routinely link one, most
  tickets have one. A ticket triaged D on that basis can sit through a batch and turn out to be
  three files and one copy key.
- **An unanswered question read as complexity.** Missing information belongs in `unknowns`.
- **`spans more than one sitting` (lane C) sized from the description rather than the code.** The
  most common one. Triage researches `prior_art` and then sizes the ticket as though it had found
  nothing. Where a ticket defines sequenced, independently-mergeable stages, only the first stage is
  what runs.
- **Spanning more than one package read as lane C.** At size M or smaller it is one sitting: lane A
  or B, with the packages named.
- **Unmerged blockers read as "more than one sitting".** They never set its lane: plan-batch holds the
  ticket behind a Jira-linked blocker in the batch and asks about one outside it.
- **A step only the user can take read as lane C** (`desk-ticket-routing.md`'s list: a production
  migration, a deploy, an IAM role or third-party app, a sign-off, a credential). Triage records it
  in `ben_steps` with a proposed blocker ticket, the plan shows it as `your step`, and the rest of the
  ticket keeps its lane. Put each proposed blocker to the user in the digest; never file it unasked.

The challenge confirms unless it can name the trigger that does not fire, and doubt confirms. **The
one exception is a park on size alone**, where "describe it file by file" would make the trigger
unfalsifiable; there the test is whether the work is mechanical and bounded. **A challenge that could
not read the code is not doubt**: any read it needed and could not make makes its verdict
INCONCLUSIVE, with the failed reads recorded, and the lane is left exactly as the first pass set it.

**A confirmed park can still be wrong, because both passes can share one over-estimate.** A park on
size CONFIRMED by counting new things to build can be lane A in a handful of files when every one has
an existing pattern on `origin/<default>` to copy. Before reporting any park on size, check each
thing the challenge calls "new" against `origin/<default>` and say what you found: report the doubt,
not the verdict. **Branch on the challenge's `needs_person` entry**, not the plan's wording: a park
with `challenge_inconclusive` (its reads failed, named in `detail`) or `challenge_not_run` is a single
unchecked opinion that must not be reported as settled, and a confirmed park has neither. An
INCONCLUSIVE park is also a `question`: put it to the user to confirm or re-lane.

**A lane is a proposal.** When the user rules that a park's lane is wrong (it is really A, B or E),
re-lane it with `queue.mjs set <TICKET> lane=A`, answer its triage unknowns (`answer.mjs`), then
`queue.mjs requeue <TICKET>`, and, where the ticket is
genuinely big, scope it in the briefing so what runs really is one sitting. That is a new lane, not
a requeue of a C or D: a ticket that stays C, or D without its canvas saved on the base, is worked
interactively, never by a worker.
