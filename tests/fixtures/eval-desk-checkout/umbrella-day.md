Covered today, Thursday, from midnight: there is no previous check-out to start from.

```text
Check-out

Queue throughput: batches stuck behind a dead worker were never drained, so tickets sat queued for hours, and a worker that lost its claim dropped the ticket. SV-3625: 2 PRs merged (#1596, #1577), batches now drain and a lost claim retries.
Cloud workers: workers could only run on my laptop. SV-3625: they now start in the cloud, #1601 (merged), with logs in #1603 (in review).
Review reliability: a review that timed out failed the whole PR. SV-3625: #1610 (merged), it now retries.
Reviews were missing real bugs, so I switched the review model from sonnet to opus (review-model row in the config), in effect since 14:10.
```

Copied to the clipboard.

- **Check before posting**: "2 PRs merged" counts the queue PRs merged today, from the GitHub collector.
