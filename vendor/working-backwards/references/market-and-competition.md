# Market Sizing and Competitive Analysis Reference

How to size the opportunity (TAM/SAM/SOM) and position against alternatives. Both belong in the internal FAQs, with workings in the appendix. **Neither belongs in the press release** — a customer does not care how big the market is.

---

## Document Stage

Evidence expectations scale with what the product has actually been through. Establish the stage before applying anything below, and state it at the top of the market sizing and competitive analysis appendices.

| Stage | Meaning |
|-------|---------|
| **Hypothesis** | Pre-validation. No users, no customer interviews, no pricing test. The document is arguing that an idea is worth investigating |
| **Validated** | Post-interviews or post-pilot. Real customers have been spoken to, or a prototype has been in real hands. Some numbers have primary evidence behind them |
| **Growth** | A live product with users, revenue and a funnel. Claims should come from the product, not from a spreadsheet |

The **method never changes** — bottoms-up sizing, named competitors, status quo as a column, a row you lose. What changes is the strength of evidence each figure must carry, and which failures are blocking rather than noted. The stage tables at the end of each part below set that bar.

Two rules hold at every stage:

1. **Declare the stage honestly, and note that under-declaring is the easier abuse.** A document that claims hypothesis stage to excuse missing evidence it actually has is worse than one that admits the evidence is thin — and it is harder to spot, because a thin hypothesis document is exactly what a reader expects to see. Concretely: **if the document draws on any customer conversation, pilot, waitlist or usage data anywhere outside the (fictional) press release testimonial, the stage is at least validated.** You do not get to hold evidence back and claim the lower bar.
2. **Label assumption vs evidence, line by line.** At hypothesis stage this is the *entire* quality signal. An unsourced number that says it is unsourced is acceptable early; an unsourced number dressed as a fact is not acceptable at any stage.

**Scope.** These bars apply to the figures and claims in the market sizing and competitive analysis. They do **not** apply to the press release customer testimonial, which is aspirational at every stage by design and is not evidence of anything — see `writing-guide.md` § Customer Testimonial. Challenging the testimonial for want of a source is a review error.

---

## Part 1: Market Sizing (TAM, SAM, SOM)

### The Three Numbers

| Term | Definition | The question it answers |
|------|------------|------------------------|
| **TAM** — Total Addressable Market | Total annual revenue if every customer with this problem bought a solution, with no constraints on geography, business model, or competition | "How big is this category?" |
| **SAM** — Serviceable Addressable Market | The share of TAM you could actually sell to, given your business model, geography, channel, language, platform and segment | "How big is the part we can reach?" |
| **SOM** — Serviceable Obtainable Market | The share of SAM you can realistically win within the plan horizon, given competition, capacity and go-to-market | "How much will we actually get?" |

Each number is a filtered subset of the one above it: **TAM → SAM → SOM**. If your document states only one of the three, it is marketing, not analysis.

### The Only Acceptable Method: Bottoms-Up

Build every number from countable units:

```
Market size = (number of qualifying customers) × (annual revenue per customer)
```

Both terms need a source. If either is a guess, mark it `[CITATION NEEDED]` and say so.

**Top-down sizing is not acceptable** in a PR/FAQ. Top-down means starting with a large published figure and applying a capture percentage:

| Rejected | Why |
|----------|-----|
| "The global workforce-management market is $250B. If we capture 1%, that's $2.5B." | 1% is not a plan. Nothing in the sentence is falsifiable |
| "The UK scheduling software market is worth £2B and growing 12% annually." | This is category trivia, not *your* addressable revenue |
| "There are 32M SMEs in Europe." | Not all have the problem, not all can buy from you |

The tell is a percentage that appears with no justification. **A capture percentage is an output of your analysis, never an input to it.**

Note what this does *not* rule out. A published market figure is fine as a *check* on a bottoms-up number you have already built — if the two disagree by more than an order of magnitude, say so and explain which you trust. What is rejected is the capture percentage, not the published figure.

### Choose the Billing Unit First

Before any arithmetic, name **the thing a single purchase covers**. Every line of TAM, SAM and SOM must then count that same thing. This is the most common silent error in market sizing: the population count is right, the price is right, and the two describe different objects.

| Business shape | Billing unit | Commonly confused with |
|----------------|--------------|------------------------|
| Per-seat software | Named user or seat | The company |
| Site or enterprise licence | Site, location or org | The employee |
| Consumer subscription | Paying account or household | Each person who benefits |
| Device or asset management | Managed device, vehicle, machine | The administrator |
| Marketplace / payments | Transaction value × take rate | The buyer |
| Usage-based infrastructure | Unit consumed — call, GB, request | The customer |
| Services and field work | Job, visit or engagement | The depot or branch |

The test: *if this customer buys, what exactly appears on the invoice, and how many of it do they buy?* Where one buyer purchases several units, decide whether you are counting buyers × units-per-buyer or counting units directly — then say which, once, at the top. Do not switch later.

### Worked Example

Every figure below is **illustrative** — replace with sourced numbers. The point is the structure, and that each line shows its arithmetic and its filter. The business is deliberately mundane; the method is the same whatever you sell.

**Product:** shift-scheduling tool at £25 per manager per month. **Billing unit: manager seat.**

**TAM — everyone in the category**
```
Businesses employing shift workers            120,000     [source: national business survey, YYYY]
× average manager seats per business          3
Qualifying seats                              360,000
× annual price per seat (£25 × 12)            £300
TAM                                           £108M/year
```
*Meaning: every shift-based business buying a seat for every manager. Not achievable — a ceiling, not a target.*

**SAM — the part we can reach**
```
TAM                                           £108M
× businesses with 10+ shift workers            62%      [source: national business survey, YYYY]
× businesses on a payroll system we integrate  55%      [source: payroll market share report, YYYY]
SAM                                           £36.8M/year
```
*Each filter is a real constraint of the business model, with a source. "Would consider buying" is not a filter — willingness must be evidenced, not assumed.*

**Check that filters are independent before multiplying them.** The two filters above are *not* independent: larger employers are far more likely to run payroll software at all, so the population-wide 55% overstates how much additional filtering it does once the 62% size filter has been applied. Multiplying two correlated rates double-discounts the same underlying trait — here, company size — and understates SAM. Where filters are correlated, source the joint condition ("payroll-system adoption *among businesses with 10+ shift workers*") rather than multiplying the two marginal rates. If the joint figure is unavailable, apply the stronger filter alone and say that you have done so.

**SOM — what we will actually win**
```
SAM                                           £36.8M
× realistic year-1 share                       1.5%
SOM (year 1)                                  £552K/year
≈ 1,840 seats ≈ 613 businesses (at 3 seats each)
```
*Convert back to both units. Seats are what you bill; businesses are what you must sell to, staff and support. A SOM that looks modest in revenue can still imply more customers than the team can onboard.*
*The 1.5% must be defended, not asserted. See below.*

### Defending the SOM Percentage

SOM is where documents lose credibility. Rules:

1. **State the implied share explicitly.** Write "1.5% of SAM" next to the number. Hiding it inside a revenue figure is evasion.
2. **Justify it with a comparable, not a hope.** "Competitor X reached 4% of this SAM in 18 months with a paid-acquisition model we can match" is a defence. "We think 5% is conservative" is not.
3. **Anything above 10% of SAM in year one requires a named structural reason** — an existing distribution channel, an installed base, an exclusive partnership, a regulatory position. Without one, it is fantasy. As a rough prior — unsourced, and stated as a heuristic rather than a finding — most new entrants without a distribution advantage land somewhere between 0.1% and 2%. Treat it as a prompt to justify an outlier, not as a benchmark to cite.
4. **Reconcile SOM with your KPIs — and say which number came first.** If SOM implies 1,840 seats and the appendix KPI target says 400, one of them is wrong. This mismatch is the single most common defect. Check it before circulating. But note that a KPI target *derived from* SOM is not a reconciliation — it is one number wearing two hats, and it will always agree with itself. The KPI must be independently defensible from delivery capacity or acquisition budget before it is compared. State which of the two you set first.
5. **Reconcile SOM with capacity.** If SOM implies 613 new customers and onboarding can handle 150, the number is not obtainable.

### Signals of Weak Market Sizing

Check the draft for these. Each one is a review comment waiting to happen:

- A capture percentage used as an input ("if we get just 2%…")
- Correlated filters multiplied as though independent, double-discounting the same trait
- The billing unit changing between lines — seats in TAM, companies in SAM
- TAM quoted with no SAM or SOM
- No source for the population count, or a source with no year
- Price assumed rather than tested — no pricing research, no willingness-to-pay evidence
- SAM equal or nearly equal to TAM (means no real filters were applied — almost always wrong)
- SOM presented as a range so wide it commits to nothing ("£500K–£15M")
- Market size grows between document drafts with no new evidence
- Revenue confused with market size (yours is revenue; the market is everyone's)
- The same customer counted in two segments and summed
- Growth rates applied to make a small market look big ("only £4M today, but growing 40% annually") without stating when it becomes large enough to matter

### When Market Sizing Is Not the Right Frame

Do not force TAM/SAM/SOM onto:

- **Internal tools** — size by hours saved × loaded cost, or by cost avoided
- **Platform and infrastructure work** — size by the products it unblocks
- **Defensive features** — size by revenue retained or churn prevented; state the churn baseline
- **Free or open-source offerings** — size by adoption and the strategic asset created, and say explicitly what the monetisation path is (or that there isn't one)

In each case, replace the section with the appropriate measure rather than omitting sizing altogether. Say which frame you are using and why.

### Stage Calibration: Market Sizing

| Element | Hypothesis | Validated | Growth |
|---------|-----------|-----------|--------|
| **TAM** | Population count may be a labelled proxy or an analogue market. A range is acceptable if the method is stated. Order of magnitude is what matters — do not manufacture precision | Population count sourced and dated. Any proxy must be checked against a real sample | Bottoms-up and top-down should converge. Where they diverge by more than 10×, state which you trust and why |
| **SAM** | At least two named filters, each marked `[estimate]` or `[source]`. SAM ≈ TAM is a failure at every stage — an unfiltered SAM means the business model has not been thought through | Every filter sourced. Filters that survived contact with customers, not just the ones that were convenient | Filters recalibrated from funnel data — which segments actually convert, not which ones you assumed would |
| **SOM** | Stated as an explicit % of SAM with a named comparable, or declared untestable and why. A range is acceptable if bounded within one order of magnitude | Comparable must be a real competitor's observed trajectory. Waitlist, pilot conversion or pipeline data should inform the percentage | Derived from measured funnel — actual conversion × actual pipeline, not a share percentage. Report last cycle's SOM against what was actually attained |
| **The >10% rule** | Any SOM above 10% of SAM needs a named structural reason. No exceptions — at this stage you have the least right to it | Same bar, but the structural reason should now have early evidence (signed channel, live partnership, measured referral rate) | Higher shares are defensible where installed base or channel position is measured, not asserted |
| **Price / ARPU** | Comparable-based, labelled as untested. No willingness-to-pay evidence expected | Pricing test results, or WTP evidence from interviews. List price without any test is now a warning | Realised ARPU net of discounting and mix — not list price |
| **Sources** | `[CITATION NEEDED]` is an acknowledged gap, not a failure. State how many there are, so the reader can weigh the whole | `[CITATION NEEDED]` on the population count or the price is **blocking** — these are the two terms the entire number rests on | Every figure traceable. Own data preferred over third-party for anything about your own funnel |
| **Reconciliation** | SOM vs KPI targets. This is arithmetic, not evidence — there is no stage at which it can be skipped | Plus capacity, plus acquisition budget: can you afford to acquire the customer count SOM implies? | Plus churn: SOM must be net, not gross additions |
| **Downside case** | Not required, but name the single assumption that would most damage the number if wrong | Required. Restate SOM with the two weakest filters halved | Required, grounded in observed variance — actual churn and CAC ranges, not invented ones |

**Signals the declared stage is wrong:**

- A hypothesis-stage SOM quoted to three significant figures — false precision, and the tell that a number was reverse-engineered from a target
- A growth-stage document sizing itself entirely from third-party market reports while its own funnel data sits unused
- A validated-stage document whose filters are identical to the hypothesis draft — customer contact should have changed at least one of them
- The market grows between drafts with no new evidence, at any stage

---

## Part 2: Competitive Analysis

### Name Real Competitors

Never write "other solutions in the market" or "various competitors". Name them. If you cannot name three, either the analysis is not done or the market does not exist — both are findings worth surfacing.

**Always include the status quo.** The most common competitor is not a company; it is the spreadsheet, the WhatsApp group, the agency, the intern, or doing nothing. If customers currently solve this some other way, that way is your primary competitor, and it is free and already installed. A competitive matrix without a "do nothing / today" column is incomplete.

### The Comparison Matrix

Replace feature checkboxes with **customer decision criteria** — the dimensions on which a customer actually chooses. Include the status quo, and mark who wins each row.

```
| Dimension (customer decision criterion) | Us | Competitor A | Competitor B | Status quo (today) | Advantage |
|---|---|---|---|---|---|
| [e.g. Time to first value] | 5 min | 2 days | 30 min | Immediate | Us |
| [e.g. Annual cost per seat] | £300 | £1,020 | £540 | £0 | Us |
| [e.g. Breadth of integrations] | 4 systems | 12 systems | 9 systems | n/a — manual | Competitor A |
| [e.g. Reporting for the buyer] | Weekly summary | None | None | Direct observation | Us |
```

**How the Advantage column is scored:** it names the winner among *us and the named competitors only*. The status quo is not scored, because on the two dimensions customers weigh most — price and availability — doing nothing wins almost every time: it is free and already installed. Scoring it would hand the status quo most rows and tell you nothing. Its column exists to show **what you must overcome to trigger a switch**, not to compete for the Advantage cell. Read the status quo column as the switching cost you have to justify.

Rules for the matrix:

1. **Dimensions are customer criteria, not features.** "SSO support" is a feature. "Time to first value" is a criterion. If a customer would not weigh it when choosing, cut the row.
2. **You must lose at least one row to a named competitor.** A matrix where you win every dimension is evidence of confirmation bias, not superiority. If you genuinely win everything, your dimensions are self-serving — you have chosen the rows you win. Find the rows where a competitor is better and include them. Losing to the *status quo* does not discharge this rule: doing nothing is free and already installed, so conceding to it is true by definition and costs you nothing to admit. The concession that counts is to a company that could take the deal.
3. **Date-stamp the analysis.** Competitor facts decay. Add "as at [Month YYYY]" beneath the table and cite where each claim came from.
4. **Describe competitors fairly.** Words like "merely", "just", "only" and "simply" applied to a competitor's product signal that the analysis is a pitch. Strip them.
5. **No unverifiable claims about competitors.** Their pricing, features and positioning must be observable from public sources. Do not assert their roadmap, margins or internal problems.

### The 90-Day Response Test

For each named competitor, answer:

> "If they read our press release tomorrow morning, what would they do in the next 90 days — and where would that leave us?"

If the honest answer is "copy it within a quarter", the differentiation is insufficient and the document should say so. This test converts a static matrix into a strategic argument, and it is the fastest way to find out whether you have a product or a feature.

### Feature Advantage vs Structural Advantage

State which kind of advantage you have. They are not equivalent.

| Type | Examples | Durability |
|------|----------|-----------|
| **Feature advantage** | A capability they lack, better UX, faster performance, lower price | Closes in months. Assume it is temporary |
| **Structural advantage** | Proprietary data, network effects, distribution/installed base, cost structure, switching costs, regulatory position, exclusive supply | Persists — this is what makes the position defensible |

A PR/FAQ whose entire differentiation is a feature list has not answered "why won't the incumbent just build this?" Answer it explicitly. If the only answer is "we'll move faster", say that plainly and let the reader weigh it — an honest weak answer is better than a disguised one.

### Signals of Weak Competitive Analysis

- No competitor named, or fewer than three
- No status quo / do-nothing column
- We win every row
- Competitors described dismissively
- The analysis is undated, or cites no sources
- Differentiation is entirely feature-based, with no structural advantage stated
- "We have no competitors" — this means the market is unproven, the analysis is incomplete, or the customer solves the problem another way and you have not identified it. Never a strength
- The competitive FAQ answers "what makes us different?" without answering "why can't they copy it?"

### When Competitive Analysis Needs a Different Frame

A comparison matrix assumes the customer is *choosing between vendors*. Sometimes they are not, and forcing the matrix produces an invented differentiation story around something that does not differentiate. Say which frame you are using and why, then use it:

- **Table-stakes and parity features** — a capability every serious competitor already has (PDF export, SSO, an audit log). The honest analysis is not "how do we win this row" but **what it costs us not to have it**: name the deals it has blocked, the churn it has caused, or the support burden it creates. Winning is not available; parity is the goal, and saying so is the finding
- **Internal tools** — the competitor is the current process. Compare against that, not against vendors
- **Compliance- or contract-driven work** — the alternative is not a competitor, it is non-compliance. Size the exposure instead
- **Genuinely new categories** — if you truly cannot name three vendors, the competitor is the workaround. Analyse *that* seriously, and treat the absence of vendors as evidence the demand is unproven, never as a clear run

In each case you still owe the status quo column and the switching-cost argument. What you are excused from is manufacturing a structural advantage where none is on offer.

### Stage Calibration: Competitive Analysis

| Element | Hypothesis | Validated | Growth |
|---------|-----------|-----------|--------|
| **Competitor set** | Three named, found from public sources. "The category is new" is not an exemption — name the workarounds instead | Shaped by what customers named unprompted in interviews. Add the ones you did not expect; that list is the finding | Drawn from win/loss records. Include who you lose to, ranked by frequency |
| **Status quo column** | Reasoned from the customer's current workflow. Still mandatory | Observed, and the cost of the status quo quantified from what customers actually spend or lose | Measured as churn-to-nothing: customers who leave and buy no replacement |
| **Matrix cells** | Public sources only — pricing pages, docs, reviews. Mark unknowns `unknown`. An unknown is never scored as a win for us | Unknowns closed via trials, demos or customer report. Dimensions weighted by what customers said mattered | Cells reflect observed behaviour and switching data, not published claims |
| **The row we lose** | Required. Inferred is acceptable | Must come from a customer, not from us. A self-nominated weakness is usually the safest one | Must come from recorded loss reasons, with frequency attached |
| **Trajectory** | Not expected. Note where each competitor appears to be heading and mark it as inference | Informed by real signals: releases, hiring, pricing moves, funding | Based on observed movement over at least two cycles |
| **90-day response test** | Written as a hypothesis, and answered honestly even when the answer is "they could copy it" | Informed by how competitors responded to comparable launches in this market | Replaced by history: what they actually did last time, and how long it took |
| **Advantage type** | State which type you *intend* to have and what must be true for it to hold. Feature-only is acceptable here **if** declared temporary and the path to structural is named | The structural advantage must be named with a testable mechanism. Early evidence expected | Durability evidenced: has the feature gap closed? Is the moat measurably deepening — data volume, network density, switching cost? |
| **Recency** | Date-stamped, nothing older than three months | Date-stamped, plus win/loss dates | Refreshed each quarter; a stale competitive appendix at growth stage is a finding in itself |

**Signals the declared stage is wrong:**

- A validated-stage matrix whose competitor set is unchanged from the hypothesis draft — customers always name someone you missed
- A growth-stage document running the 90-day thought experiment when it has real competitor response history to cite
- Any stage where every unknown cell resolves in our favour

---

## Part 3: What the Analysis Decides

Sizing and competitive work that reaches no verdict is description, not analysis. State the verdict plainly in the internal FAQ — a reader should not have to infer it from the tone.

| What the analysis found | Verdict | What to do |
|-------------------------|---------|-----------|
| SOM is material against the cost of building, the matrix shows a structural advantage, **and each customer is profitable to serve** (contribution margin positive, or lifetime value above acquisition cost) | **Go** | Proceed. Record the SOM and the KPI targets together so the next review can check attainment against them. A large SOM with negative per-customer economics is not a Go — it is a faster way to lose money |
| Fewer than three competitors can be named, and the status quo is not a real alternative either | **Category unproven** | Do not proceed on sizing alone — an empty competitive field usually means nobody has established that the problem is worth paying to solve. Run a direct demand test (landing page, pre-sell, letter of intent) before committing build spend |
| SOM is too small to justify the build | **Market too small** | Widen or re-cut the customer definition, look at an adjacent segment, or stop. State what SOM *would* need to be — a threshold makes this reversible if the market moves |
| SAM is at or near TAM | **Not analysed** | The number is not wrong, it is unfinished. No real filter has been applied. Return to the business model and name the constraints |
| SOM contradicts the KPI targets, delivery capacity or the acquisition budget | **Not obtainable** | One of the two figures is wrong. Fix it. Never circulate both and let the reader choose |
| We win only on feature dimensions, and the 90-day test answers "they copy it" | **Not differentiated** | Rethink the advantage, or accept that this is a feature of something else rather than a product in its own right |
| The status quo column wins on cost and switching effort | **No switching trigger** | Find the event that makes a customer change — renewal, regulation, a growth threshold, a failure. Without a trigger there is no wedge, however good the product |
| The analysis is sound and the opportunity real, but something else is worth more | **Deprioritised** | Shelve **with a named trigger condition and a review date**. A shelved idea with a trigger is recoverable; one without is lost |
| Evidence falls below the bar for the declared stage | **Iterate** | Name the specific figures that need sourcing and re-present. Do not downgrade the stage to make the document pass |

Two things this table is for:

1. **Opportunity cost is a real answer.** "Deprioritised" is not a soft no — it is the correct verdict for most good ideas at any given moment, and saying so explicitly is what stops a backlog filling with proposals nobody ever decided against.
2. **A document that can only reach "Go" has not been stress-tested.** If no combination of findings in your draft could have produced any other verdict here, the analysis was written to justify a decision already taken.

---

## Where This Material Goes in the Document

| Content | Location |
|---------|----------|
| Headline market opportunity (one sentence, SOM only) | Internal FAQ — "How big is the opportunity?" |
| TAM/SAM/SOM with filters and sources | Appendix — Market Sizing |
| Named competitors and positioning | Internal FAQ — "What is the competitive positioning?" |
| Full comparison matrix | Appendix — Competitive Analysis |
| Why competitors cannot easily copy us | Internal FAQ — "What are our unique points of difference?" |
| Anything at all about market size | **Never in the press release or external FAQs** |
