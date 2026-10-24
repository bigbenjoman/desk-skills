# desk-clearance phase 4: One batch round, and asking

Read at the start of phase 4, or earlier where the core's Phases section says. The config, ownership, what config
§3 decides, the merge bar, parking and the red flags every phase shares are in `../SKILL.md`, already
loaded. "How to ask" and "Asking as you go" hold for every question of the pass, not only this
round's.

### 4. One batch round for what you already know

Collect every AMBER across every PR and put them to the user. GREEN proceeds unattended (within
§3); RED parks. At twenty-two PRs, a per-PR "assess, then stop" is twenty-two blocking gates, which
is why it got skipped wholesale rather than honoured.

**This batches the questions you have now. It is not a lid on asking later.**

### How to ask — always the carousel, never prose

**Every question goes through `AskUserQuestion`.** A question written as prose gets skimmed past; a
question with options gets answered in a click.

1. **Lead with a recommendation.** First option, `(Recommended)` in the label, chosen on your own
   reading of the code — not the safest-sounding one. Say why in the description.
2. **Options are real, distinct courses of action** with the consequence stated: *make the
   change* / *reply pushing back* / *ask the reviewer (config §4)*. Never a bare yes/no where a
   real choice exists, never an option you would not carry out.
3. **Detail goes in `preview`** — a drafted reply, two competing hunks. Previews render side by
   side, so the user compares artefacts instead of parsing a description.
4. **`header` is 12 characters**: `#724 auth` — the PR number is what people navigate by.

**Group by decision, not by comment.** Four PRs asking the same thing is one question. Page four at
a time, **highest-stakes first**, and send the next page as soon as the last is answered.

### Asking as you go

**After the batch round, ask the moment you hit something.** Holding a question to the end costs
the hours the user was available, and buries it in a long report.

Subagents reach you by `SendMessage` to `"main"`, which lands while they are still running. **They
send drafted options; you put it straight to the user as a carousel question.** Relay each as it
arrives — never accumulate them into a prose digest. Nothing travels back mid-run, so a subagent
that truly cannot continue returns `BLOCKED_ON` and you resume it with the answer.

**Ask, carry on, then park — never block, never wait forever.** Carry on with every other PR while
you wait. Park that one item once the user has gone quiet for config §3b "Park an unanswered
question after (minutes)" — but read the room: an answer two minutes ago means they are at their
desk. Say in the report that you asked and got no reply, and **re-surface anything unanswered** at
the end. AMBER is never decided for them.
