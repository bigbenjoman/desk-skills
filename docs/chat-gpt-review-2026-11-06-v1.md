**My recommendation is to improve the existing pipeline and test your current subscriptions before upgrading to Pro 500 or buying another provider.** There is a substantial opportunity, but the evidence does not yet prove a savings multiplier or an overall provider winner.

I’ve produced the artifacts:

- Short decision memo (docs/efficiency-audit-2026-11-06/decision-memo.md)
- Full technical proposal, hypotheses and evaluation plan (docs/efficiency-audit-2026-11-06/proposal.md)
- Independent editorial review (docs/efficiency-audit-2026-11-06/editorial-review.md)

The strongest findings are:

1. **Your Claude workload is overwhelmingly Opus.** Across seven complete days, approximately 99.5% of 117,031 distinct assistant messages used Opus 5.5. Median input context was about 97k tokens, including cached input.
2. **Coding is only part of the opportunity.** Implementation accounted for roughly 8–11% of stage-attributed worker input volume. Review, verification and preparation deserve equal attention. Those figures are not subscription-cost shares.
3. **Much of the proposed optimisation already exists.** All 13 linked DS-359 children are Done. Model tiers, smaller briefings and incremental reviews should be validated and consistently deployed before being rebuilt.
4. **Your backlog contains valuable evaluation work.** PR Ninja already plans fixed-input comparisons, shared rubrics and blind multi-vendor judging. The proposal maps these tickets to a subscription-based worker evaluation.
5. **Portia offers useful mechanisms, rather than a clear migration case:** lighter paths for small changes, gate-result reuse and explicit rework metrics. Deskills already has much of its shared-contract approach.

My proposed allocation is **Codex implementation trials using Pro 100, existing Opus review retained, and deterministic code for routine administration**. Consider Pro 200 only after measuring its marginal value. Artificial Analysis helps shortlist candidates, but its API costs cannot establish subscription capacity. [AA coding-agent methodology](https://artificialanalysis.ai/agents/coding-agents)

The separate reviewer found no remaining blocking issues after revisions. **Live comparative worker trials have not been run**, and actual GBP billing remains unmeasured. No configuration, subscriptions, Jira tickets or queues were changed.