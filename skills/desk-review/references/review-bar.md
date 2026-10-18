# Review bar (desk default)

The bar `desk-review` hands every finder **verbatim**, unless this repo's config §4 Review bar names
its own file. It overrides any severity scale an agent carries in its own definition, so everything
that reads it reviews at one bar.

Four priorities, of which three are reported. A finding is P0, P1 or P2, or it is not reported. The
one thing listed beside them is an unproven premise (under P0), which is never counted.

A repo that wants its own bar copies this file into the repo (so it is versioned with the code it
judges), edits the classes and calibration to fit, and sets §4 Review bar to that path. Keep the
four-level shape and the section names: the skill and the verdict marker count P0, P1 and P2.

---

## P0: breaks production

Something a user, an operator or the books experience as wrong.

| Class | What qualifies |
| --- | --- |
| **Authorization** | A gate that is missing, bypassable, or scoped to the wrong role. A handler that checks sign-in and nothing further, where the resource belongs to someone. |
| **Money** | Currency held as float, mixed units (pence and pounds, MWh and kWh), or rounded outside the one place that owns rounding. Two code paths that compute the same amount differently. |
| **Data isolation** | Cross-tenant or cross-user reads and writes. Personal data reaching a log, a client payload, an LLM prompt or a third party it was not meant for. A non-essential storage write (a cookie, local or session storage, a tracking pixel) or a third-party script that runs before the user has given cookie consent (PECR). |
| **Data loss** | A destructive or non-reversible migration. A write that can clobber a concurrent write. A migration chain with two heads. |
| **Contract** | A change that breaks an existing consumer of a published API, webhook payload, event, file format or persisted shape. |
| **Async** | An unhandled rejection or error path that surfaces as a user-visible failure, a stuck record, or a job that silently stops. A batch with no per-item isolation, where one item's failure aborts or loses the rest. |
| **Secrets** | A credential, token or key committed, logged, or sent to the client. |
| **Premise** | The change relies on behaviour it does not own (a library's config, a vendor API, an environment variable, a registration elsewhere) and that behaviour does not hold. Counted only when running it, or the vendor's own documentation, shows it does not hold; reading the vendor's source is not proof. A premise nobody could prove either way is not a P0: list it separately (*Unproven premises* below). |

**Unproven premises.** Report one as a `FINDING` with `severity: PREMISE`, naming what the change
assumes and why it could not be proven. It is listed apart from the findings and never counted.

**Calibration.** A create endpoint that read its input and never read the caller's identity, so any
signed-in user could create an admin invitation. The omission had no syntactic form, so neither the
type checker nor a large sibling test suite could see it. That is the P0 bar: reachable, and wrong.

---

## P1: this should not exist

Correct code that makes the codebase worse by existing. Nothing else in CI measures this axis, which
is why it is here.

| Class | What qualifies |
| --- | --- |
| **Duplication** | A new implementation of logic that already exists: a helper, hook, util, component, flow, query or generator. Search by **mechanism** as well as name before deciding it is new. |
| **Second vocabulary** | A new normalisation map, alias table, enum or spelling for a concept that already has a canonical form. |
| **Rule enforced only in the UI** | A business rule the client checks (a disabled button, a form validator, a limit on a field) that the server write it guards does not check, so a direct request gets past it. A rule about *who* may act (a role, ownership, a tenant) that only the UI enforces is P0 **Authorization**, not this. |
| **Layer bypass** | Work done in a layer the repo has put somewhere else: database access outside its data-access layer, a transaction opened in a route handler, business logic in a view, a direct third-party call where a client wrapper exists. The repo's own instructions say which layers exist. |
| **Dead on arrival** | An export whose only non-test reference is its own story or test. A new module with no importer. A flag, field or enum value with no writer. |
| **Advisory by accretion** | A new `continue-on-error`, a new warn-level lint rule, a skipped test, or an `except: pass` added with no expiry. A control that cannot fail is not a control. |
| **Prose that outranks the linter** | A rule added to a `.md` file that the linter enforces at `warn`, or not at all. Stated severity and configured severity must agree. |
| **Speculative generality** | An abstraction with exactly **one** consumer: an interface, factory, config object, generic parameter or options bag introduced for a caller that does not exist yet. *Dead on arrival* is the zero-consumer case; this is the one-consumer case, and the more common one. |
| **Scope creep with no consumer** | A hunk that traces to no line of stated intent **and** whose product nothing live calls. Out of scope on its own is P2 below; out of scope *and* serving no consumer is this. |
| **Extracted, callers not migrated** | A new or changed shared helper that leaves equivalent inline copies alive, where the PR description does not list them under *Not migrated*. Cite each surviving copy as `path#symbol`. Listed copies are a decision on record, not a finding. With no PR description to read, report every surviving copy. |

**The cheapest signal.** A comment near the top of a file saying *"mirrors"*, *"copied from"*,
*"structurally identical to"* or *"same shape as"* plus a path is the author having already found
the duplication. Report it.

**Extract first, then drop the comment.** Those comments, and "must match" comments like them, are
how twins get found. The finding is to extract the shared code and then delete the comment, in that
order. Never report the comment alone, and never accept a fix that deletes it while both copies
survive: that hides the duplication and leaves the code unchanged.

**Calibration.** Two approval flows that are structural clones, one carrying a comment "mirrors the
other's steps 7–9", both encoding the same age and consent rules. Not broken, but the second copy is
where the next defect lives, because a fix to one will not reach the other.

**What "stated intent" means**, for the two scope classes above and P2 *Out of scope* below. In
order of authority: the ticket's acceptance criteria, then the PR description, then the branch's
stated purpose. If none exists there is no intent to measure against: say so and report no scope
finding. Never infer the intent from the diff and then mark the diff against it; that is circular
and always returns clean.

---

## P2: the same axis, contained

P1's classes at a smaller blast radius: one helper rather than one flow, one dead export rather than
a dead subsystem. Real, mechanical, worth knowing, and never ranked beside a P0.

| Class | What qualifies |
| --- | --- |
| **Local duplication** | A helper, type, mapping or constant restated in a second place inside one module or package. |
| **Transcription** | One shape declared more than once (a schema, a type, a mapping, a model) where one declaration could derive the rest. Adding a field means editing every copy. |
| **Unparsed boundary** | External data (a request body, a webhook, a third-party response, a file, a queue message) given its type by a cast or an annotation instead of being parsed with the repo's runtime validator. |
| **Copy outside i18n** | User-facing copy written inline where the repo has an i18n layer, instead of going through it. A repo with no i18n layer has no finding here. |
| **Dead weight** | A single unused export, a story-only component, a dependency declared and never imported. |
| **A test that cannot fail** | An assertion that a mock returns what the mock was told to return, a suite under `continue-on-error`, or a mock that re-implements the logic under test. Source-text tests belong here too: reading a source file as text (`readFileSync`, `open(...).read()`), slicing markup with `indexOf`, a regex over class names, or a hand-rolled evaluator of a query filter. Each one checks how the code is written, not what it does. |
| **Narrative comment** | An added comment that carries a ticket ID, a review-finding number, a person's name, a date, "previously", or an account of a failed attempt. That history belongs in the commit and the PR. Also reportable: an added comment that contradicts the code beside it. A *"mirrors"* or "must match" twin annotation is not narrative; see *Extract first, then drop the comment* under P1. Nor is the expiry on a skip, a lint suppression or a `continue-on-error`: the ticket ID or date saying when it comes out is what *Advisory by accretion* asks for. |
| **Out of scope** | A hunk that traces to no line of stated intent but does have a live consumer. Worth naming; the author judges whether it stays in this PR. |

**The boy-scout exemption, and it is not optional.** Many repos' instructions ask an author who
finds copies of a pattern to move them onto the shared helper in the same change. A hunk doing that
traces to no acceptance criterion and would otherwise read as *Out of scope*. **Never report as out
of scope:** deduplication, consolidation onto an existing shared helper, a shared extraction the
repo's instructions ask for, or a change the diff had to make to compile, type-check or keep an
existing test green. Scope creep is *unasked-for new capability*, not *housekeeping the repo
demands*.

P2 is reported in its own section and, when posting, grouped in the review body, never as an inline
comment.

---

## P3: not reported

Style, naming, preference, "consider extracting". If a finding is P3, drop it; do not promote it to
P2 to justify having found something. An empty report is the expected result for most changes.

## How this maps to the agents' own scales

P0–P3 is the vocabulary `lena-code-reviewer`, `nadia-security-auditor` and `suki-frontend-architect`
already use, so nothing needs translating. Lena's
"Critical" is P0 or P1 by the tables above, her "Important" is P2, her "Minor" is P3 and dropped.
Her *Scope Discipline* rule is live here as *Speculative generality*, *Scope creep with no consumer*
and *Out of scope*.

Nadia's P3 hardening notes are not reported, and her *Verdict* line is ignored: findings here never
approve or block anything.

A domain-expert finder (§4 Review domain experts) reports in this scale too. A domain error that
moves money, a trade, a valuation or a regulated decision is P0 under **Money** or **Contract**; the
expert's own vocabulary is not a severity.

## Never report

- Style, naming, formatting, import order, file organisation.
- Test-coverage opinions, "consider adding a test", "consider extracting".
- **Reviewer-proposed** refactors of code that works. Distinct from P1 *Speculative generality*,
  which is the author having already built an abstraction nobody needs. The test is who wrote it: in
  the diff, judge it; outside the diff, leave it alone.
- Performance micro-optimisation, hypothetical future needs.
- Anything the type checker, formatter or CI already enforces, or a linter rule at error level. A
  rule at warn level enforces nothing, so a finding it also flags may still be reported.
- A hunk the repo's own instructions mandate (the boy-scout exemption above) as *Out of scope*.
- A defect the repo already records as known (a known-issues register, an ADR, a `KNOWN GAP`
  note the repo instructions point to), **unless this diff changes the code it anchors to**; then
  report it and cite the record.
- Complexity the repo's docs explain and justify. Read before simplifying.

## When uncertain

Reject. A missed P1 costs less than a false positive that burns the author's time and teaches them
to skim the next report.
