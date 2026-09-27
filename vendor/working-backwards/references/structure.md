# Working Backwards Document — Full Structure Reference

## Document Overview

A Working Backwards document (PR/FAQ) is up to six pages:
- **Press Release**: 1 page maximum
- **FAQs**: 2–5 pages (external + internal)
- **Appendix**: As needed (not counted in the 6-page limit)

---

## Press Release Template

Use this exact structure. Every element is required unless marked optional.

```
HEADLINE
[Short, compelling description — what would make a journalist write about this?]

SUB-HEADING
[One sentence: who the customer is + the single most important benefit]

[CITY] — [DATE] — [Company] today announced [what you're launching in one sentence,
using words your customer would use].

PARAGRAPH 1: THE PROBLEM
[2-3 sentences. State the customer problem or opportunity with specificity and empathy.
Make the reader feel the pain. Use data: "Independent veterinary practices choose between
£900-a-month software built for 20-vet groups, or a paper diary that loses one appointment
in twenty."]

PARAGRAPH 2: THE SOLUTION
[2-3 sentences. Describe what you're launching and how it solves the problem. Stay in
customer language. No technical details. Focus on what changes for the customer.]

PARAGRAPH 3: HOW IT WORKS
[3-5 sentences. Walk through the customer experience. How do they discover it? What do
they do first? What value do they get? Be concrete and specific. Paint a picture of the
customer using the product.]

PARAGRAPH 4: DEEPER VALUE / CONTENT / SELECTION
[Optional. 2-4 sentences. If relevant, describe the breadth of what's available, how
content grows over time, or additional dimensions of value.]

PARAGRAPH 5: DISCOVERY AND ACCESS
[2-3 sentences. How customers find and navigate to the offering. Pricing if applicable.
Any relevant access details.]

PARAGRAPH 6: LEADER QUOTE
"[Quote from a senior leader. Must capture the ONE most important value proposition.
Should feel visionary but grounded. Include their name and title.]"

PARAGRAPH 7: CUSTOMER EXPERIENCE DETAIL
[2-3 sentences. Describe a specific, concrete customer scenario. What does a Tuesday
evening look like using this? What happens over 3 months?]

PARAGRAPH 8: CUSTOMER TESTIMONIAL
"[Specific, believable, human-sounding quote. Include name, role/location. Should
reinforce the key benefit through a personal story. Not generic praise — describe
what specifically changed. Fictional at every document stage — never a real
customer's name against an invented quote. See writing-guide.md § Customer
Testimonial.]"

PARAGRAPH 9: CALL TO ACTION
[1-2 sentences. Where to go, how to get started. Launch date if applicable.]

[Company] Confidential
```

### Press Release Examples

**Good headline:** "Amazon.com announces Ultra HD available on smart TVs from Sony, Samsung, Vizio and LG"
— Specific, names partners, clear what it is

**Bad headline:** "Company launches exciting new innovative platform"
— Vague, uses empty adjectives, no specifics

**Good problem statement:** "A 12-vehicle haulier spends nine hours a week matching proof-of-delivery photos to invoices by hand, and still writes off 3% of revenue on disputed deliveries it cannot evidence."
— Specific cost, specific trade-off, empathetic

**Bad problem statement:** "Many customers struggle with finding affordable education solutions."
— Vague ("many"), no specifics, no empathy

**Good customer testimonial:** "I used to build the rota in a spreadsheet every Sunday night, then spend half of Monday redoing it after two people swapped shifts. Now the swap goes through before I've opened the laptop, and I found out we'd been overstaffing Tuesdays for a year."
— Specific routine, specific time saved, believable voice, an unexpected concrete benefit

**Bad customer testimonial:** "This is a great product and I love using it. It has really helped me a lot."
— Generic, no specifics, could be about anything

---

## FAQs Structure

### External (Customer) FAQs

Number sequentially starting from 1. Order: broad → specific.

**Standard questions to include (adapt to context):**

1. What is [product/feature]? (Always first)
2. How is this different from [existing alternatives]?
3. What does it cost / what's the pricing?
4. What [subjects/content/features] are available?
5. How do I sign up / get started?
6. How do I find [the content, feature or person I need]?
7. What are the requirements? (devices, internet, qualifications)
8. Is it safe / what about privacy?
9. What happens if [edge case: cancellation, payment failure, poor experience]?
10. What if I need more help / want to upgrade?

**Segment by audience if applicable.** If you have distinct customer groups — typically the end user, the buyer who signs off, and any third party such as a supplier or partner — create sub-sections:

```
EXTERNAL FAQs — GENERAL
1. What is [product]?
2. How is this different?
...

EXTERNAL FAQs — FOR [AUDIENCE A]
11. [Audience-specific question]
12. [Audience-specific question]
...

EXTERNAL FAQs — FOR [AUDIENCE B]
20. [Audience-specific question]
...
```

### FAQ Answer Format

Each answer should:
- **Lead with the direct answer** — don't bury it
- **Be self-contained** — readable without context from the question
- **Include specifics** — prices, numbers, dates, names
- **Be concise** — typically 2-5 sentences. Use more only for complex trade-off analysis

**Good FAQ answer:**
> **What videos are available in Ultra HD?**
> At launch at least 10 videos are available, including new releases like "The Amazing Spider-man 2," popular Prime Instant Video titles like "The Hunger Games: Catching Fire," and classic collectibles like "Blade Runner." All new Amazon Originals series will be available in Ultra HD, starting with new Pilots in August. Additional new release, classic, and popular Prime UHD titles will be available each week. Amazon Instant Video will offer at least 100 Movies and TV shows in Ultra HD by end of 2014.

— Specific titles, specific numbers, specific timeline, commitment to growth

### Internal (Stakeholder) FAQs

Continue numbering from where external FAQs left off. Order: strategic → tactical.

**Standard questions to include:**

1. What are our unique points of difference? (and why can't a competitor copy them?)
2. What is the competitive positioning? (vs each named competitor, including the status quo)
3. How big is the opportunity? (SOM, with TAM/SAM workings in the appendix — see `references/market-and-competition.md`)
4. What are the primary risks and mitigations? (table format recommended)
5. What is technically uncertain, and how will we test it? (name the assumptions that could prove unbuildable and the spike that resolves each. This is risk disclosure, not implementation detail — see the distinction in `SKILL.md` § Step 3)
6. Can a customer reach value without help? (state time to first value, and name anything that forces a call, a migration, training or a change in habit)
7. It is a year from now and this has failed — what happened? (pre-mortem. Name the most *likely* failure, not the most dramatic. If no plausible failure can be described, the risk section is incomplete)
8. Is this the highest-priority use of the team's time? (name what does not get built if this does)
9. What is the estimated ROI / business case? (including whether each customer is profitable to serve, not only whether the market is large)
10. What metrics define success? (with specific targets, set independently of the SOM rather than derived from it)
11. What trade-offs were made and why?
12. How did we select [approach/platform/pricing]? (show options considered)
13. What is the go-to-market strategy?
14. What key learnings from research inform this approach?
15. What other documents exist for deeper detail?

**Internal FAQ answer format for trade-offs:**

Present options in a structured way:

```
We considered [N] options:

| Option | Pros | Cons |
|--------|------|------|
| Option 1 — [Name] | • [Pro 1] | • [Con 1] |
|                    | • [Pro 2] | • [Con 2] |
| Option 2 — [Name] | • [Pro 1] | • [Con 1] |

Our recommendation is Option [X] because [data-backed reasoning].
```

**Internal FAQ answer format for success metrics:**

```
MVP Targets (by [date]):
- [Metric 1]: [target] (e.g., Weekly Active Rate: ≥50%)
- [Metric 2]: [target]

Post-launch benchmarks:
- [Metric]: [target] ([context], e.g., "good" / "world-class")
```

---

## Appendix Structure

### Product Backlog

Use a table with sequential numbering, epic grouping, feature description, and priority:

```
| # | Epic | Feature | Priority |
|---|------|---------|----------|
| 1 | [Epic name] | [Feature description] | P1 |
| 2 | [Epic name] | [Feature description] | P1 |
| 3 | [Epic name] | [Feature description] | P2 |
```

### Priority Definitions

Always include these definitions with the backlog:

**P1: Required for launch**
We cannot launch without this feature. If it comes down to it, we will slip the launch date rather than ship without this feature.

**P2: Expected for launch**
Scoping and resource allocation make us believe we can deliver this feature in the launch time frame. We have a high confidence we will launch with this feature, however... If it comes down to it, we will drop this feature rather than slip the launch date. Dropping this feature should be considered a failure to meet project expectations.

**P3: Desired for launch**
We will include this feature if it can be done in the launch time frame without introducing risk to the core deliverables.

**P4: Out of scope**
Features explicitly excluded from the launch. They will not be considered in the launch timeframe and may be addressed in future iterations.

### KPIs Section

Format each KPI with:
- Metric name
- Current baseline (if known)
- Target value
- Measurement method
- Timeframe

### Market Sizing

Show TAM, SAM and SOM, each built bottoms-up with its arithmetic, filters and sources visible. See `references/market-and-competition.md` § Market Sizing for the full method, worked example and failure signals.

```
TAM: [population count] × [annual revenue per customer] = £[X]/year
     Source: [source, year]

SAM: TAM × [filter 1: %] × [filter 2: %] = £[Y]/year
     Filters: [what each represents, with source]

SOM: SAM × [share]% = £[Z]/year (≈ [N] customers, year 1)
     Basis for [share]%: [comparable, channel, or capacity argument]
```

State the document stage (hypothesis / validated / growth) at the top of this section — it sets how much evidence each figure must carry.

Non-negotiables:
- Bottoms-up only. A capture percentage is an output, never an input
- State the implied share of SAM explicitly
- Reconcile SOM against the KPI targets and against delivery capacity — mismatches here are the most common defect
- Sourceless numbers are marked `[CITATION NEEDED]`
- Close with the verdict the sizing supports, not just the number

For internal tools, platform work, defensive features or free products, replace this with the appropriate frame (hours saved, products unblocked, churn prevented, adoption) and say which frame you are using and why.

### Competitive Analysis

Use customer decision criteria as dimensions — not feature checkboxes — and always include the status quo. See `references/market-and-competition.md` § Competitive Analysis.

```
| Dimension (customer decision criterion) | Us | Competitor A | Competitor B | Status quo (today) | Advantage |
|---|---|---|---|---|---|
| [Criterion 1] | ... | ... | ... | ... | [who wins] |
| [Criterion 2] | ... | ... | ... | ... | [who wins] |

As at [Month YYYY]. Sources: [where each competitor claim came from]
```

State the document stage at the top of this section, as for market sizing.

Non-negotiables:
- Name real competitors — never "other solutions in the market". If you cannot name three, say so as a finding
- Include a status quo / do-nothing column: the spreadsheet, the incumbent habit, the agency
- **You must lose at least one row to a named competitor.** Winning every dimension is evidence of bias, not superiority. Losing to the status quo does not count — it is free and already installed, so conceding to it costs nothing
- The Advantage column scores us against named competitors only; the status quo column shows the switching cost you must overcome
- If the matrix does not fit (table-stakes features, internal tools, compliance work), use the alternative frame in `references/market-and-competition.md` § When Competitive Analysis Needs a Different Frame
- State whether your advantage is *feature* (closes in months) or *structural* (durable), and answer "why won't the incumbent just build this?"
- Apply the 90-day response test: if each competitor read the press release tomorrow, what do they do in 90 days?

### Other Appendices

Label sequentially: Appendix 1, Appendix 2, etc. Each should have a descriptive title.

Common appendices:
- Pricing and cost analysis
- Customer bandwidth/device/platform data
- Detailed financial projections
- User research findings
- Wireframes and UX mocks (reference locations)
- Flow charts and architecture diagrams (reference locations)

---

## Document Tenets (Optional)

If the product team has defined tenets (guiding principles for decision-making), include them at the top of the document before the press release. Tenets should be:

- **Numbered** — typically 3-7
- **Actionable** — guide real decisions
- **Ordered by priority** — when tenets conflict, higher-ranked tenets win
- **Opinionated** — a tenet that nobody would disagree with is useless

Example:
> 1. **Measure what matters, build what moves it.** We ship against the two metrics that predict renewal, not against the loudest request.
> 2. **The heaviest user wins ties.** When a daily user and an occasional one want opposite things, we optimise for the person who is in here forty times a day.
> 3. **Boring beats clever.** An operations tool that surprises someone has failed. Predictability is the feature.
> 4. **Own the handover, not the whole workflow.** We integrate where teams already work rather than asking them to move.
