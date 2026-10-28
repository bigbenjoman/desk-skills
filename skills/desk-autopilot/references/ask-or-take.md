# desk-autopilot: ask or take

Part of desk-autopilot, read at Stage 2 before Stage 3's questions, and before any question, yours
or a worker's, mid-run. Interactive sessions and workers that cite `desk-autopilot` *Ask or take*
read it here. It binds exactly as the core `SKILL.md` does. Where it says "above" or "below" of
something this file does not hold, or cites a section in *italics* it does not hold, that is in the
core or in the file the core's reference table names.

## Ask or take

Most questions only add waiting: the recommended option is chosen nearly nine times in ten. So
every would-be question, yours, a worker's or an interactive session's, is first sorted into **ask**
or **take**.

**Try before asking.** A question whether the user has done a step ("is the secret set?", "has the
DNS record gone in?", "did the migration run?") is not a question when you can check it through an
API, CLI or browser read config §3 already grants. Check first, and ask only if the check cannot
settle it:

- **It settles it:** ask nothing, carry on, and log what you checked and what it showed. A worker
  prints `AUTOPILOT_CHECKED: {"question": "…", "checked": "…", "showed": "…"}` at the start of a line
  in its own text; you and interactive sessions run
  `node ~/.claude/desk/bin/decisions.mjs check <TICKET> '{"question": "…", "checked": "…", "showed": "…"}'`.
  The digest lists it under `Checked instead of asking`.
- **It fails** (refused, an error, an answer that settles nothing): ask, and say in the question what
  you tried and the error it got, word for word.
- **Never attempt** a step whose attempt would spend money, write to a shared or live system, or
  need a credential you do not hold. Ask it as an ask-category question (`money` or `production`),
  without trying. Trying never widens §3: an attempt uses only what the config already grants.

A value only the user holds stays a question, with its routes offered (*Asking*); a step you can
check is not one of them.

**Do not re-ask what the user put off.** An answer of "not now" puts the question in the repo's
register, `<state>/not-now.jsonl` (`not-now.mjs`), with the date and the inputs it depends on: the
ticket, a PR head SHA, config rows, an external value it read, whatever the question names. A
question in the register whose inputs are unchanged is not asked again: the digest lists it once
under `Put off`, with the date, and its ticket stays parked without counting as waiting on the
user. One whose inputs changed is asked, with a line saying what changed since it was put off.

- **A worker** names a park's inputs on the line after it, as
  `AUTOPILOT_PARK_INPUTS: {"ticket": "ABC-1", "pr-head": "3f2a…"}` (a flat object of plain values;
  none is `{}`, which matches on the question's text alone). `pass.mjs` stores them on the park and
  checks the register when it harvests the run. While the park stays put off, each pass reads its
  `pr-head` (the branch's head on origin) and `config:<row id>` inputs again, and asks the question
  as soon as one has changed; any other input is compared only when a session asks again.
- **A park can say what clears it**: a worker's `AUTOPILOT_PARK_CLEARS_WHEN: <condition>` on the
  line after its park (`pr <n> merged`, `pr <n> ready` for out of draft, `ticket <KEY> done`,
  `variable <NAME> set` for a repo Actions variable, or `none`), or
  `queue.mjs clears-when <TICKET> "<condition>"` from you or the decider, is stored as the park's
  `clears_when` (`clears-when.mjs`). It names the one fact the park waits on, never a guess, and is
  left out (or `none`) when only a person can settle it. Each pass checks it, and once it holds settles the park as
  `references/orchestrator-recovery.md` says, with no model: a lane C ticket, or a lane D parked at triage on its design, stays for a
  person, one whose own PR merged is recorded done, any other is requeued. Each outcome, and any
  check that could not run (the park left as it is), is one line under `clears-when:` in the report.
  An idle supervised batch with anything parked or failed still runs a pass every 30 minutes
  (`DESK_IDLE_RECHECK_MS`), so a condition cleared outside the queue is seen.
- **You and interactive sessions** check before asking, and record a "not now" the user gives in
  the conversation (an answer through `answer.mjs` or the digest is recorded for you):

```
node ~/.claude/desk/bin/not-now.mjs check "<question>" --inputs '{"ticket": "ABC-1"}'
node ~/.claude/desk/bin/not-now.mjs add <TICKET> "<question>" --inputs '{"ticket": "ABC-1"}'
```

  `check` exits 3 for a question put off with the same inputs (do not ask it), and 0 to ask, printing
  the what-changed line to put in the question when there is one. An entry stops holding the question back once its
  inputs change, and goes when the user answers the question or clears it (`not-now.mjs clear "<question>"`, or `ask-again` from the digest); it never
  expires by age. A register that cannot be read puts nothing off: every question is asked as it
  would be without one, and each pass reports it under `WAITING ON YOU`.

**Ask** only when it falls in one of the five ask categories (the id in brackets is the one
`decisions.mjs` knows):

| Ask category | For example |
|---|---|
| money (`money`) | approving a spend, a paid plan, anything billed |
| legal or regulatory (`legal`) | legal or policy copy, privacy, compliance (`legal-content` is `stop`) |
| production data or credentials (`production`) | a production database, a secret, a key, a live account |
| customer copy where length means cost (`customer-copy`) | an SMS, a paid placement, any copy billed by length |
| facts only the user holds (`user-fact`) | product or catalog data, a design URL, an asset, a name, who owns what |

Ask too when the call has **no recommendation you can defend**: say so, as "no recommendation", in
the question.

**Take** everything else: a product, design, wording, review, engineering, scope or tracker call
with a recommendation. Build or do the recommended option, carry on, and log the call so the
check-in digest can list it. Taking it is not widening §3: a row that is not `yes` still parks or
asks, so a take never makes a write the config did not grant. And `autopilot-judgement` decides it
for workers: where that row is not `yes`, a worker parks as before.

Each taken call is one entry in `<state>/decisions.jsonl` (time, repo, ticket, question, options,
the option chosen, category, PR link):

- **A worker** prints one line per call, at the start of a line in its own text, as
  `AUTOPILOT_DECISION: {"question": "…", "options": ["…", "…"], "chose": "…", "category": "…"}`,
  and lists it in its PR body under `Decisions taken` (`desk-pr`). `pass.mjs` appends it to the log
  when it harvests the finished run, with the PR from its `AUTOPILOT_DONE`, once per run however
  often it reads the log. A line it cannot read (not that JSON, a choice outside its options, or an
  ask category) logs nothing and comes back under `WAITING ON YOU` as `unreadable decision`, with
  the raw line: settle it with the user, and log it yourself if it stands.
- **You and interactive sessions** log through the CLI, after doing it:

```
node ~/.claude/desk/bin/decisions.mjs log <TICKET> '{"question": "…", "options": ["…", "…"], "chose": "…", "category": "…"}' [--pr <n>]
```

A category is one of `product`, `design`, `wording`, `review`, `engineering`, `scope` or `tracker`;
the CLI refuses an ask category with exit 11, because that call is asked, never taken. A Jira write
that §3 grants is a `tracker` entry.
