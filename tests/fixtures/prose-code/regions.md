# Generated regions, each what the code says

Each finding carries the refuter's vendor (<!-- facts: refuted-by -->`refuted_by`: `claude` or `codex`, not an agent; absent when `UNREFUTED`<!-- /facts -->).

The plan prints its rule:

<!-- facts: spawn-order -->
Blockers start first, then the tickets that gate the most others (directly or through any chain of holds), then the fewest planned files, then the order named.
With --keep-order, tickets start in the order named, blockers still first.
<!-- /facts: spawn-order -->

A marker shown in a fenced block is not a region:

```markdown
<!-- facts: not-a-region -->
```
