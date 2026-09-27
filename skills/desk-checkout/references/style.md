# Check Out style

## A worked example

Ben's check-out, posted in `#agenda`. The user's own previous check-out sets their voice; this
one shows the register the house conventions aim at: plain, problem-first, and specific about
stakes and who needs to act.

```text
Check Out

Triage P1s with Chris, Avi, Sadegh & Joni
Check-in with Joni on UX in flight - focus on multiple 1-2-1 bookings

Two security problems on portal, both live on main right now, plus an email fault that's been quietly breaking things.

The portal middleware can be bypassed with a URL suffix. The @studia.io domain check runs in middleware before every portal page — but any URL containing .js, .css or .png anywhere in it skips middleware entirely, so the check never runs. A non-Studia account with any service grant reaches real data. Live on main now; my branch didn't cause it, I found it fixing something else. PR #1425, waiting on approval.
Google-only sign-in is a security control, not presentation. The portal offers Apple, Microsoft and email sign-in that shouldn't exist. Hiding the buttons isn't the fix — no Studia Google account behind the session, no portal. SV-1750 and SV-1751. Built it twice: the first version leaned on Clerk's lastAuthenticationStrategy, which describes the device rather than the session and so proves nothing about how you logged in. Three reviewers found the same P0 independently. Scrapped and rebuilt client-side.
Created a fix, split into 3 PRs and running adversarial reviews. WIP.

Every transactional email we send was failing DKIM — the signature that proves the mail is really from us, so failures drift towards spam. The mte1/mte2._domainkey records were Cloudflare-proxied, so the CNAMEs never resolved. Mandrill reported "valid" throughout, which is why nobody caught it. Fixed and verified. SV-1756 takes DMARC to enforcement (telling providers to actually reject failures), due 5 Oct.
Parked BIMI to ~March 2027 (SV-1747) — that's our logo showing next to the sender name in Gmail. It needs a Mark Certificate, which requires twelve months of provable continuous logo use. [...] We can't buy that evidence window, only start it. SV-1756 is not parked with it.
PullBot's API budget is exhausted — $10.06 against $10. Failing on every PR since ~17:15, repo-wide, until someone raises the cap. Not the usual flake we ignore. @Chris Anthony
Three PRs need a human approval — #1425, #1422, #1398 (protected paths and size). All substantive CI passes on every one; everything red is a gate. #1398 has a real gitleaks hit — two candidate secrets that need triaging rather than waving through. And #1048 has been open 11 days for a 24-line change.
Raised 6 tickets and moved 17 off me, Shan, Hark and Valyn onto Avaneesh and Sadegh. SV-1420 dropped P1→P2 — DBS is offline for launch. SV-1200 reopened as a regression.

Project Orsino (Belmont new version) - The first version of orsino was too large and bloated and after A/B testing I've had to literally just go back to first principles and break it down into the component pieces. [...] Almost every verify round also found written claims that went further than the code does, so a lot of the effort went into making those match the code.
```

## What makes it work

- **Meetings first, one line each, with who.** "Triage P1s with Chris, Avi, Sadegh & Joni."
  No times, no agenda dump.
- **The problem comes before the fix, in terms a non-engineer can follow.** "The portal
  middleware can be bypassed with a URL suffix", then the mechanism, then the consequence
  ("reaches real data"), then the state ("PR #1425, waiting on approval").
- **Jargon gets explained inline, once.** "DKIM — the signature that proves the mail is really
  from us". "BIMI — that's our logo showing next to the sender name in Gmail".
- **Say why nobody caught it, when that's the interesting part.** "Mandrill reported
  'valid' throughout".
- **Be honest about dead ends.** "Built it twice… Scrapped and rebuilt". A reversal is
  worth reporting because it tells reviewers what not to suggest.
- **Asks are explicit and addressed**: `@Chris Anthony`, with the number that makes it
  urgent ("$10.06 against $10").
- **Housekeeping is one line of counts**, plus only the moves someone would care about
  (priority drops, reopened regressions).
- **Side projects go last**, in a paragraph, with scale ("about 280 commits", "eight of its
  milestones").
- **It's plain text.** No headings and no bold; bullets are optional, and blank lines separate
  the groups. Slack renders it as typed.

## House conventions (from the rest of #agenda)

- The header varies ("Check out", "Check Out", "Monday Checkout"). Keep the user's own form;
  the default is `Check Out`, with the day when posting late or for another day:
  `Check Out (Friday)`.
- Status suffixes the whole team reads: `(merged)`, `(in review)`, `(raised)`,
  `(investigated, no code change)`, `(on hold pending SV-nnn)`, `(not started)`.
- Tickets are `SV-1234`, and PRs are `#1234` next to their ticket: `SV-1688 (#1380)`.
- Name people by first name as the team does (Chris, Avi, Sadegh, Joni, Eleanor, Shan, Valyn,
  Glen). Use `@Full Name` only on a real ask.

## Don'ts

- Don't write "Worked on X" with no outcome. Say what changed or what was found.
- Don't list every ticket key raised in bulk triage.
- Don't use hedges like "I think" or "possibly". Leave an uncertain claim out, or state it with
  its source in the checklist under the draft.
- Don't include anything personal, HR, pay or investor-confidential, from a meeting, a DM, a
  private channel or a transcript, and don't quote other people's DMs.
- Don't use emoji, apart from the odd one the team already uses (🧊, :partying_face:). Most
  posts barely use them.
