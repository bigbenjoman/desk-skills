# Microcopy Patterns by Component

Complete Do/Don't patterns for every UI component. Read when writing or
reviewing copy for a specific component type.

---

## Buttons & CTAs

Start with a verb. Name the outcome, not the mechanical action.

| Don't | Do | Why |
|-------|-----|-----|
| Submit | Send Message | Names what happens |
| Click Here | Download Report | Names the destination |
| Next | Continue to Payment | Shows progress context |
| OK | Got It / Save Changes | Specific to the action |
| Yes / No | Delete Project / Keep Project | Names consequences |
| Learn More | See Pricing Plans | Tells what they'll see |
| Cancel (in dialogs) | Keep My Account | Positive framing of safe choice |

**Rules:**
- Primary CTA: specific outcome verb. "Start Free Trial" not "Sign Up"
- Secondary CTA: lower visual weight but equally clear
- Destructive CTA: name what's destroyed. "Delete 3 Files" not "Delete"
- Value-first CTAs outperform action-first: "Start Saving Time" > "Create Account"

---

## Error Messages

Every error must answer THREE questions: What happened? Why? What now?

| Don't | Do |
|-------|-----|
| Something went wrong | Your payment was declined — the card number doesn't match. Check it or try another card. |
| Invalid input | Email must include @ and a domain (like name@example.com) |
| Error 403 | You don't have permission to see this page. Try signing in with a different account. |
| Please try again | We couldn't save your changes — connection dropped. Your work is saved locally. Reconnect and try again. |
| Oops! We hit a snag | We're having trouble loading this page. Try refreshing, or contact support if it persists. |

**Rules:**
- Never blame the user ("You entered the wrong password" → "That password
  doesn't match our records")
- Preserve user's work when possible and SAY so
- Inline validation > post-submission errors
- No humor, no "oops", no casual tone during frustration
- If you genuinely don't know what failed, give a way forward: refresh, retry
  with timeframe, contact support with reference code

---

## Empty States

Empty ≠ broken. It's an opportunity to guide.

**Three types:**

1. **Initial empty state** (first visit, no data yet):
   "Your analytics will appear here once your site gets its first visitor."

2. **Ongoing empty state** (cleared/filtered to nothing):
   "No results for 'xylophone.' Try a different search term, or browse
   popular items."

3. **Time-dependent empty state** (needs collection period):
   "We're gathering your data. Your first report will be ready within
   24 hours."

**Rules:**
- Always explain WHY it's empty
- Always suggest a NEXT ACTION
- Show what it will look like when populated (illustration or example)
- For search no-results: suggest corrections, show popular items, check typos

---

## Form Labels & Hints

Labels tell what to enter. Hints tell format or purpose.

| Don't | Do |
|-------|-----|
| Name | Full name (as it appears on your ID) |
| Password | Password (at least 12 characters, one number) |
| Phone | Phone number (we'll text delivery updates) |
| Date | Date of birth (DD/MM/YYYY) |
| Placeholder: "John Doe" | Placeholder: "e.g., Maria García" |

**Rules:**
- Labels go ABOVE fields, not inside as placeholders (placeholders disappear)
- If you ask for sensitive data, explain why: "Phone (for delivery updates only)"
- Show requirements BEFORE the user types, not after they fail
- Real-time validation beats post-submission error walls
- Use format examples: "DD/MM/YYYY" not "Enter date"

---

## Tooltips & Help Text

One piece of context, exactly when needed.

**Rules:**
- Answer the ONE question the user has at this moment
- Keep under 15 words when possible
- Use plain language: "CVV: the 3-digit code on the back of your card"
- Don't repeat what the label already says
- Don't put essential information in tooltips — if everyone needs it, make it
  visible by default

---

## Confirmation Dialogs

For any irreversible or significant action.

**Structure:**
- **Title:** The action being confirmed ("Delete this project?")
- **Body:** The specific consequence ("This permanently removes all 23 files
  and 8 comments. Team members will lose access.")
- **Primary button:** Safe option with positive framing ("Keep Project")
- **Secondary button:** Matches the title verb ("Delete Project")

**Rules:**
- Use real numbers: "47 photos" not "your photos"
- For critical actions, require typing the name
- Never use "Cancel" / "OK" — name both actions specifically
- The safe option should be the default/primary button

---

## Loading States

Silence during waits feels broken. Copy reassures.

| Duration | Pattern |
|----------|---------|
| < 2 seconds | No text needed, just a visual indicator |
| 2-10 seconds | "Loading your dashboard..." |
| 10-30 seconds | "Getting your results. Should take about 15 seconds." |
| 30+ seconds | "Processing your file (2 of 5 complete)..." with progress |
| Unknown duration | "This might take a moment. We'll notify you when it's ready." |

**Rules:**
- Set time expectations when possible
- Show progress (steps complete, percentage) for long processes
- Offer an escape: "You can close this — we'll email when done"
- Never leave a loading state without any text

---

## Success Messages

Confirm the action + what happens next.

| Don't | Do |
|-------|-----|
| Success! | Sent! You'll receive a confirmation email within 5 minutes. |
| Done. | Your project is live. Share it with your team → |
| Submitted | Application received. We'll review it within 2 business days. |

**Rules:**
- Be specific about what succeeded
- Set expectations for what happens next (email, review, processing)
- Offer the natural next action
- Warm but brief — don't slow users down with celebrations

---

## Notifications & Push

Every notification is an interruption. It must justify itself in the first 5 words.

**Rules:**
- First 5 words must convey the value
- "Your payment of $450 was declined" — justified interruption
- "You might like..." — never justified as a push notification
- Batch low-priority notifications
- Include enough context to act without opening the app
- "Tap" on mobile, "Click" on desktop. "Select" if cross-platform.

---

## Onboarding

Guide new users to their first success moment.

**Rules:**
- One action per step
- Show progress: "Step 2 of 4"
- Lead with value: "Let's get your first campaign live" not "Fill out your profile"
- Use possessive language: "Your workspace" not "The workspace"
- Make skip options visible — forced onboarding causes drop-off
- Celebrate the first milestone genuinely

---

## Search

**Placeholder:** Tell what's searchable. "Search projects, files, or members"
not just "Search."

**No results:**
- Check for typos and suggest corrections
- Show popular or recent items
- "No results for 'xylophne.' Did you mean 'xylophone'?"
- Never just "No results found." with nothing else

---

## AI Interface Copy

For products with AI features, chatbots, or LLM-powered experiences.

**The blank prompt problem:**
- Never show an empty text input with "Ask anything"
- Provide 3-4 starter prompts: "Try: 'Summarize this doc' or 'Find action items'"
- Frame the input: "Ask about your sales data" not "Ask anything"

**Setting expectations:**
- "Here's what I found" (not "I know the answer")
- "Based on available information" (signals limits)
- "Review for accuracy" on AI-generated content

**Handoff to human:**
- "This needs a human touch. Connecting you — they usually respond in 5 min."
- Not: "I can't help with that."

**Disclosure:**
- "Powered by AI" as a subtle label
- "AI-suggested reply" on auto-drafts
- Be transparent, not apologetic
