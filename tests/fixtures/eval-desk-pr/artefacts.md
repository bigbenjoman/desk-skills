```
DIFF REVIEW — awaiting approval
commits ahead : c5d81aa feat(cart): SHOP-420 apply discounts after tax
files changed : 3  src/cart/discount.ts src/cart/discount.test.ts scripts/backfill-once.mjs
artefacts     : ?? .playwright-mcp/  ?? after.png
scripts       : scripts/backfill-once.mjs
```

- Remove `scripts/backfill-once.mjs` from the commit: it has already run and nothing calls it.
- Delete the `.playwright-mcp/` directory; it is browser tool output.
- Delete the loose `after.png`.
