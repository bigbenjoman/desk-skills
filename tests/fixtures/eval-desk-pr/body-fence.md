```markdown
<!-- desk-pr: body -->
Search matched records on their free-text description, so anything that mentioned the term in prose surfaced. Now it matches name and tags only (SHOP-412).

### Changes
- `src/server/search.ts`: the where clause no longer ORs in `description ILIKE`.
- `src/server/search.test.ts`: a record that mentions the term only in its description is not returned.

### Testing
- `/search?q=economics` drops 9 → 7 on a local copy of the staging database; the two dropped were tagged Business Studies and Psychology.
- `pnpm typecheck`, `pnpm lint` and the 14 specs in `src/server/search.test.ts` pass.
- `/desk-review` at `3f9c2ab`: 0 P0 · 0 P1 · 0 P2 across 2 files, findings refuted by codex.
<!-- desk-pr: end -->
```
