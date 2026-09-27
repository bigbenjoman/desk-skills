# Writing register

For anything the user will send or paste as themselves: PR review replies, Jira comments, Slack
drafts to colleagues, standup points.

**Config §5 "Messages to colleagues" is the source of truth.** What follows is the team's
default register, and setup offers it as the default. If a user has changed that row, the row wins.
If you have seen enough of the user's own writing this session — their Slack messages, Jira comments,
PR replies — let it tune the details, within the rules below.

## The register

Plain, direct, British. Written like someone talking, not someone drafting. Short sentences. The
point goes in the first line.

**Never:**
- emoji
- em-dashes as connectors; use a spaced hyphen ` - ` or a full stop
- "Successfully…", "I've gone ahead and…", "Just wanted to flag…", "Hope that helps"
- chummy filler and softeners: "shout if you'd rather", "no rush", "worth checking", "worth
  confirming". They bury the point
- bold on every other phrase
- a summary paragraph restating what was just said
- American spelling

**Do:**
- lead with what the issue is, then the ask
- numbered points when there is more than one
- say "Check X", not "Worth confirming X"; "unless you want to do it", not "shout if you'd rather"
- name people plainly, first name only
- say "I" and "we" naturally
- state real uncertainty plainly: "not sure if", "I think"
- keep it to a few sentences unless there is genuinely more

## Length

Slack to a supervisor: 3-6 lines. PR reply: 2-3 sentences. Jira comment: 2-3 lines. Standup: 3-5
bullets, a few words each.

If it is longer than that, cut it. "More concise", "less verbose", "simpler language" and "easier to
read" are the most common feedback these drafts get.

## Slack to a supervisor or reviewer

No greeting ceremony, no sign-off. Ask the question or give the update. If a decision is needed,
make it obvious and say what you would do.

**Draft only.** Sending or scheduling a Slack message as the user is `never` in config §3 (`slack-send`). An
instruction like "put a response to X in Slack" or "reply to him" still means a draft — the message
posts under their account and cannot be retracted.

Shape that works:

> Quick one on SV-482 - the backfill's done on staging, 143 rows across 78 profiles, GCSE filter
> now returns 77 tutors instead of 0.
>
> One risk: a tutors:import re-run would wipe it, since the script isn't merged. Do we want it in
> main, or just re-run the backfill after any import?

Outcome with numbers, the one risk, then the decision in front of the reader. No preamble.

## Standup points

Bare bullets, what was done and what is blocked. No narrative.

## When it is Claude speaking, not the user

Sometimes a finding is pasted attributed to Claude ("Claude said this is the issue"). Write those as
the agent: state the diagnosis and the evidence directly, with no attempt at the user's voice — *"Write
it like you're talking, not me. Just what you pinpoint the issue to be."*

## Other registers

- **PR bodies** are ordinary technical prose where em-dashes and longer sentences are normal — see
  `desk-pr`. Don't carry one register into the other.
- **User-facing copy you draft** — SEO titles and descriptions, marketing text, i18n strings — has no
  em-dashes or similar flourishes (decorative en-dashes, semicolon chains) either; they read as
  AI-written on public pages. Copy supplied verbatim by design or product (Figma, the product owner)
  ships as given.
