# desk-review Phase 6: report

Read when the review reaches Phase 6. The config, the bar, the entry points, every seat's prompt,
the round rules and the verdict are in `../SKILL.md`, already loaded; a "below" or "above" this file
does not hold points there or to another phase's file.

## Phase 6: report

Always printed, whether or not it is also posted.

```
branch fix/abc-123-rounding → main · round 1 · 14 files · MEDIUM tier · 2 finders + Bea + simplicity + codex cold
bar: default@installed · domain: energy-trader · cross-vendor: codex refuted 2 Claude findings, Claude refuted 1 codex finding

P0 (1)
 apps/api/routes/invoices.py:67        invoice total rounded per line, then summed

P1 (1)
 packages/core/src/money.ts:12         second currency formatter
                                       — packages/core/src/format.ts:8 is the original

P2 (2)
 apps/web/src/components/Pager.tsx:1   no consumer outside its own story
 apps/api/services/tz.py:31            timezone helper rewritten; traces to no AC on ABC-123 (scope, body only)

REQUIREMENT GAPS (2, 1 unverified)  ABC-123
 AC3: "export includes VAT" — no VAT column in the CSV writer
 AC1: "the cache is keyed per tenant" — UNVERIFIED CODE CLAIM, terminal only, not posted

UNPROVEN PREMISES (1)
 apps/api/jobs/sync.py:12              assumes the vendor retries a 5xx webhook; not run, docs silent

→ posting to #742
```

`UNPROVEN PREMISES` are posted in the review body and counted in no field of the verdict.

The last line says what is about to happen: `→ posting to #<n>`, `→ not posting (--no-comment)`,
`→ not posting: no PR for this branch`, or `→ not posting: §3 <key> is no`.

A sweep reports per PR under one header, and the buckets are **computed by partitioning the queue,
never written by hand**. Findings + clean + errored + merge-skipped equals the queued count; a PR
whose finders errored is `ERRORED`, never `CLEAN`:

```
account: <me> · 23 open non-draft · 1 reviewed at head → 22 queued
tiers: 5 high · 6 medium · 11 low → 31 finders → 21 candidates → 16 confirmed across 5 PRs, 5 rejected
P0 (3)  #460 apps/api/routes/family.py:88  under-13 link skips consent
P1 (4)  #434 packages/core/src/money.ts:14  second rounding rule  [also: coderabbitai]
P2 (9)  #441 (3) · #452 (2) · #460 (2) · #467 (2)
REQ GAPS (2, 1 unverified)  #460 ABC-512 AC2 · #412 ABC-640 AC3 (unverified)
CLEAN (13)    #429 #440 #464 …
SKIPPED (2)   #430 — reviewed at 6ff8e39 · #418 — only base merges since 4c1a80d
ERRORED (0)
```

Then per-finding detail: evidence, suggested fix, and a collapsed `<details>` holding the finder's
reasoning and the refuter's proof. If nothing survives, lead with **"No P0, P1 or P2 findings"**
and one line on what was checked.
