---
name: desk-admit
description: >-
  Admits tickets into the autopilot batch the supervisor runs, after the same checks standing intake
  makes: a fresh triage, lane, blocking lint, open questions, size, and blockers outside the batch.
  Use when the user types "/desk-admit", or says "admit DS-123", "add these to the batch", "put this
  in the supervisor's queue", "get this into autopilot". Not for planning a new batch with approvals
  (that is desk-autopilot) or working one ticket in this session (that is desk-ticket).
argument-hint: "<TICKET>... [--front]"
---

# desk-admit

One script makes every check and every write. **Read nothing else**: no queue, triage record or
supervisor log, and do not load `desk-autopilot`. Never run `queue.mjs admit` yourself.

## 1. Admit

```bash
node ~/.claude/desk/bin/intake.mjs admit <TICKET>... --by <who> [--front]
```

- `<TICKET>...`: every ticket the user named, in one call, so a blocker named alongside what it
  blocks is admitted first and the other held behind it.
- `--by`: the user's first name, lower case, no spaces (from `git config user.name`).
- `--front`: only when the user asks for it first, or calls it urgent ("ASAP", "next").

It triages each ticket afresh, which takes a minute or two each. Exit 0: every ticket was admitted
or was already in the batch. Print its lines and stop. The supervisor's next tick picks them up, so
start no pass, loop or driver.

## 2. Refused (exit 11)

Each `not admitted <TICKET>: <why>` line, and an `admits nothing: <why>` line, goes to the user in
one `AskUserQuestion` round (at most four questions; header the ticket key). Put the first option
below as `(Recommended)`, with its reason as the description:

| `<why>` says | Recommended | Then |
|---|---|---|
| `lane C` or `lane D` | Work it in its own session: `/desk-ticket <TICKET>` (a worker would only park on it) | Leave it out of the batch |
| `open question(s): …` | Answer each one now; record the answers on the ticket (`desk-jira`) | Run step 1 again for it |
| `lint (blocking): …` | Fix the ticket as the finding says (`desk-jira`) | Run step 1 again for it |
| `size L` or `XL` | Split it into tickets of size M or less (`desk-jira`) | Admit the new tickets |
| `blocked by <B>, which is not done and not in the batch` | Admit `<B>` with it | Run step 1 with both |
| `an epic` | Plan it as a feature batch: `/desk-autopilot <TICKET>` | |
| `is run by a session, not the supervisor` | Send the tickets to that session: `ListAgents`, then `SendMessage` with each ticket and why it is wanted. That session asks and admits | Admit nothing here |
| `no batch is live, and starting one … needs …` | Plan a batch: `/desk-autopilot <TICKET>...` | |
| `triage failed` or anything else | Show the line; offer to run step 1 again | |

Do what each answer says, then run step 1 again only for the tickets now ready.

## 3. End

Print one line per ticket: admitted (and held behind what, if held), already in the batch, or left
out and why.
