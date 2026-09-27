---
name: working-backwards
description: "Write Amazon-style Working Backwards documents (PR/FAQs). Use this skill whenever the user mentions 'Working Backwards', 'PR/FAQ', 'PRFAQ', 'press release and FAQ', 'product definition document', or asks to write a product proposal, product requirements document, or feature definition in the Amazon narrative style. Also trigger when editing, reviewing, or providing feedback on an existing PR/FAQ. This skill covers the full PR/FAQ structure: press release, external FAQs, internal FAQs, appendix, product backlog, market sizing (TAM/SAM/SOM) and competitive analysis. It outputs markdown or plain text, and .docx where a docx skill is installed. Always use this skill even for partial requests like 'write me a press release for a new feature' or 'help me with the FAQ section of my PR/FAQ'."
---

# Working Backwards Document (PR/FAQ) Skill

## What This Skill Does

Generates Amazon-style Working Backwards documents — the methodology that starts with the customer and works backwards. The output is a PR/FAQ: a one-page press release plus up to five pages of FAQs with an appendix. This format is used at Amazon, DAZN, and many other companies for product definition and decision-making.

**Before writing anything**, read `references/structure.md` for the full document template, `references/writing-guide.md` for narrative writing best practices, and `references/market-and-competition.md` for the sizing and competitive method — the last of these is needed in Step 3, not just at the appendix.

**This skill has no dependencies.** It is markdown and reference files only — no CLI tools, no binaries, no scripts, nothing to install. Never tell the user that some external tool is required before you can start writing. The one optional extra is a docx skill, and only if they ask for a Word file (Step 5); without it, output markdown.

## When to Use

- Creating a new PR/FAQ from scratch
- Drafting just the press release section
- Writing external (customer) or internal (stakeholder) FAQs
- Building the appendix (backlog, KPIs, market sizing, competitive analysis)
- Sizing a market (TAM/SAM/SOM) or building a competitive matrix for a product proposal
- Reviewing or improving an existing PR/FAQ
- Converting a product idea into Working Backwards format

## Revise Mode

If a PR/FAQ already exists, **revise it — do not regenerate it.** Regenerating silently discards the user's own edits, their sourced figures and the wording they have already argued through with stakeholders.

Before starting the workflow below, check whether a document exists at the path the user gave, or in the working directory. If one does:

1. **Read it first.** Identify what is already there — press release, external and internal FAQs, appendix sections, market sizing, competitive matrix.
2. **Detect the stage.** Look for a declared document stage. If none is stated, ask, and add it — an undeclared stage means every evidence bar in `references/market-and-competition.md` is unenforceable.
3. **Ask what to revise.** Present the sections found and ask which to change. Common goals: sharpening the problem or differentiation, threading in new research, adding FAQs raised in review, replacing inferred claims with sourced ones, re-sizing after a stage change, updating the competitive matrix.
4. **Edit surgically.** Change only what was asked for. Preserve everything else exactly, including formatting and figures you did not verify yourself.
5. **Report what moved.** List the sections changed and any figure that now contradicts another — particularly SOM against KPI targets, which drift apart across revisions more than anything else.

When a revision changes the stage — a hypothesis document that has now had customer interviews becomes validated — re-check the market sizing and competitive analysis against the new stage's bar before anything else. Numbers that were acceptable as labelled assumptions may now be blocking gaps.

Only start from scratch if the user explicitly asks for a new document.

## Workflow

### Step 1: Gather Context

Before writing, establish these essentials. Ask the user if not provided:

1. **Who is the customer?** Be specific — not "users" but "duty managers at multi-site care homes" or "enterprise procurement managers". Any industry: this skill is not tuned to a sector, and neither are its examples
2. **What is the single problem or opportunity?** There can only be one. If there are multiple, split into separate PR/FAQs
3. **What is the proposed solution?** High-level — no implementation details
4. **What is the launch date?** Real or aspirational
5. **What is the key customer benefit?** The one thing that matters most
6. **What company is this for?** Needed for confidentiality footer and leader quote
7. **What stage is this at?** One of **hypothesis** (pre-validation — no users, no interviews, no pricing test), **validated** (post-interviews or post-pilot), or **growth** (live product with users and a funnel). This governs how much evidence every number in the market sizing and competitive analysis must carry — see `references/market-and-competition.md` § Document Stage. If the user does not know, assume hypothesis and say so in the document

### Step 2: Write the Press Release (1 page)

Read `references/structure.md` § Press Release Template for the exact structure.

Key rules:
- **One page maximum.** If it needs more, the idea isn't clear enough
- **Customer language only.** No internal jargon, no technical implementation
- **Eliminate weasel words.** "Nearly all customers" → "7.6M customers". "Huge improvement" → "+25 basis points"
- **Replace adjectives with data.** "Much faster" → "Reduced latency from 200ms to 30ms"
- **Under 30 words per sentence.** "Due to the fact that" → "because"
- **Pass the "so what" test.** Would a customer actually care about this?
- **Information hierarchy.** Assume the reader stops at any point — every sentence adds the next most important thing
- **Make the reader empathise with the problem.** Reading it should make us question why we do this to customers
- **The solution can't be magic.** You need at least a high-level idea of the entire solution

### Step 3: Write the FAQs (2-5 pages)

This is where the core product definition happens. Two sections:

**External (Customer) FAQs** — Questions a customer would ask:
- What is this? How does it work?
- How do I find/access it?
- What does it cost?
- What do I need to use it?
- What's different from alternatives?

**Internal (Stakeholder) FAQs** — Questions leadership and teams would ask:
- What are the trade-offs and why?
- What data supports this approach?
- What are the risks and mitigations?
- What is technically uncertain, and how will we test it? (name the assumptions that could prove unbuildable, and the spike or prototype that resolves each. "We don't yet know whether X is achievable, and we'll find out in week two" is a strong answer)
- Can a customer reach value without help? (where does onboarding require a call, a migration, training or a behaviour change — and what is the time to first value)
- It is a year from now and this has failed — what happened? (pre-mortem: name the *most likely* failure, not the most dramatic one)
- Is this the highest-priority use of the team's time? (say what does not get built if this does)
- What's the competitive positioning? (vs each named competitor, including the status quo)
- How big is the opportunity? (SOM — **build the appendix sizing from Step 4 before writing this answer**, then quote it. Writing the headline number first and reconciling later is how SOM and the KPI targets drift apart, which the reference file names as the most common defect)
- Why can't a competitor simply copy this?
- What's the estimated ROI?
- What metrics define success?
- What options were considered?

Rules for FAQs:
- **Order by breadth then importance.** Start broad, narrow to specific
- **Auto-number all FAQs.** Use sequential numbering across both sections
- **Answer every question a reader might ask.** The ideal PR/FAQ eliminates the need for discussion
- **Present options with pros/cons.** Don't just state a decision — show the alternatives considered
- **Use data to support decisions.** Include market data, customer research, projections
- **Use "we" in internal FAQs.** Customer voice in external, company voice in internal
- **No implementation details — but technical *risk* is not an implementation detail.** Describe the customer experience, not how it's built. "We'll use React and Postgres" is a design decision and belongs in a technical plan. "We don't know whether this can be done inside 200ms, and that assumption carries the product" is a risk disclosure, and it belongs here: it is exactly what an engineer reading the document is best placed to challenge, and the cheapest thing to discover before a build decision rather than after

### Step 4: Write the Appendix

Include as relevant:
- **Product Backlog** — Prioritised requirements with P1/P2/P3/P4 ratings (see `references/structure.md` § Priority Definitions)
- **KPIs** — Success metrics with specific targets
- **Market Sizing** — TAM, SAM and SOM built bottoms-up, with filters and sources shown, and the document stage stated at the top (see `references/market-and-competition.md`)
- **Competitive Analysis** — Named competitors and the status quo, compared on customer decision criteria, with the document stage stated at the top (see `references/market-and-competition.md`)
- **Visuals** — Wireframes, user flows, UX mocks (reference only in text)
- **Supporting Data** — Market research, customer data, financial projections
- **GTM Tags** — Metrics for measuring feature usage

### Step 5: Format and Output

Ask which format the user wants. Default to markdown if they have no preference — it is the format that always works.

**If outputting as .docx:** This requires a docx skill to be installed. Check that one is available before promising a Word file; if it is not, say so and offer markdown instead — do not attempt to hand-assemble Office XML. Apply these formatting rules:

- Paper: A4
- Margins: Word "Narrow" preset — 1.27cm (0.5 inch) on all four sides, which is 720 DXA left/right/top/bottom
- Font: Arial or Calibri, minimum 10pt, single line spacing
- Footer: "[Company Name] Confidential" centred, page number right-aligned
- FAQs must be auto-numbered
- Headings: Bold, consistent hierarchy

**If outputting as markdown or text:** Follow the same structural template but use markdown formatting. FAQ numbering is manual — check it is sequential and unbroken across both FAQ sections before presenting.

Whichever format, present the result as a **first draft to be argued with**, not a finished document. A PR/FAQ that has not been through review has not done its job — see `references/writing-guide.md` § The Review Process.

## Voice and Tone Rules

| Section | Voice | Perspective |
|---------|-------|-------------|
| Headline & Sub-heading | Customer-facing, compelling | Third person |
| Press Release body | Customer-centric, simple language | Third person |
| Leader Quote | Visionary but specific | First person (quoted) |
| Customer Testimonial | Specific, believable, human — **aspirational at every stage** | First person (quoted) |
| External FAQs | Customer language, helpful | Second person ("you") |
| Internal FAQs | Business language, analytical | First person plural ("we") |
| Appendix | Data-driven, precise | Neutral/analytical |

## Quality Checklist

Before presenting the document, verify:

- [ ] Press release is one page or fewer
- [ ] Single clear problem or opportunity stated
- [ ] Customer is explicitly defined
- [ ] No weasel words (nearly, significant, many, often, huge)
- [ ] Adjectives replaced with data where possible
- [ ] Sentences under 30 words
- [ ] No implementation details in press release or external FAQs
- [ ] FAQs are auto-numbered sequentially
- [ ] Options presented with pros and cons in internal FAQs
- [ ] Priority definitions included with backlog
- [ ] Document stage declared, and stated at the top of the market sizing and competitive appendices
- [ ] Market sized bottoms-up — no capture percentage used as an input
- [ ] TAM, SAM and SOM all present, each with filters, and every figure marked as sourced or assumed
- [ ] Evidence meets the bar for the declared stage — at validated and growth, no `[CITATION NEEDED]` left on the population count or the price
- [ ] SOM reconciles with KPI targets (every stage), and with delivery capacity and acquisition budget (validated and growth)
- [ ] Competitors named individually, and the status quo included as a column
- [ ] At least one matrix row where a **named competitor** beats us — losing only to the status quo does not count — sourced from a customer at validated stage, from loss records at growth
- [ ] Customer unit held constant across TAM, SAM and SOM, and correlated filters not multiplied as independent
- [ ] Leader quote attributed to a real named person, or left as a bracketed placeholder — never a fabricated name
- [ ] "Why can't they copy this?" is answered, and the advantage named as feature or structural — feature-only is acceptable at hypothesis stage only if declared temporary with the path to structural named
- [ ] Technical uncertainties named, each with the spike or test that resolves it
- [ ] Time to first value stated, and anything blocking unaided onboarding named
- [ ] SOM reconciled against a KPI target that was set independently, not derived from SOM
- [ ] Stage not under-declared — any interview, pilot or usage data in the document means at least validated
- [ ] Pre-mortem answered with a plausible failure, not a token one
- [ ] Opportunity cost stated — what does not get built if this does
- [ ] The analysis reaches a stated verdict, not just a description (see `references/market-and-competition.md` § What the Analysis Decides)
- [ ] Confidentiality footer included
- [ ] Passes the "so what" test — a customer would care about this
- [ ] Leader quote captures the single most important customer value
- [ ] Customer testimonial is specific, believable, and human-sounding

## Common Mistakes to Avoid

1. **Starting with the solution, not the customer.** Always begin: who is the customer and what is their problem?
2. **Multiple problems in one PR/FAQ.** One problem = one PR/FAQ. Write an umbrella PR/FAQ if needed
3. **Vague language.** "Improved experience" means nothing. Quantify everything
4. **Internal jargon in customer-facing sections.** If your customer wouldn't say it, rewrite it
5. **Missing trade-off analysis.** Every decision had alternatives — show them
6. **No data.** Assertions without evidence are opinions. Back claims with research, metrics, or projections
7. **Too long.** Press release > 1 page = unclear thinking. Total document > 6 pages (excl. appendix) = too much
8. **Implementation details.** "We'll use React and PostgreSQL" doesn't belong anywhere in a PR/FAQ. Describe what the customer sees and does. Do not let this rule swallow technical *risk*, which does belong: naming what might not be buildable, and how you will find out, is a disclosure rather than a design decision
9. **Sensitive information.** No customer PII, security details, or credentials
10. **Top-down market sizing.** "The market is $250B, we'll take 1%" is not analysis. Count customers, multiply by price, show the filters. A capture percentage is an output, never an input
11. **Winning every row of the competitive matrix.** If you beat every competitor on every dimension, you chose the dimensions you win. Find the rows you lose and include them — and lose to a named competitor, not just to the status quo
12. **"We have no competitors."** This means the market is unproven, the analysis is incomplete, or customers solve the problem another way and you haven't found it. Never a strength

## Reference Files

- `references/structure.md` — Full document template with all sections and examples
- `references/writing-guide.md` — Narrative writing best practices, grammar rules, formatting standards
- `references/market-and-competition.md` — TAM/SAM/SOM sizing method and competitive analysis
