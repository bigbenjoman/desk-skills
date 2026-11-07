Score each change as the pull request you were asked to merge for this ticket. The tests have
already said whether it works; this score says whether you would merge it.

### A mergeable change

- Does what the ticket asks, and meets every acceptance criterion it can be held to.
- Changes only what the ticket needs: no unrelated edits, stray files or one-off scripts.
- Fits the code around it: its names, its patterns and its existing helpers, not new copies of them.
- Tests the behaviour it adds or fixes where the repo tests that kind of code, and adds no tests
  nobody asked for.
- Leaves the reviewer nothing to finish: no TODOs, debug output or commented-out code.

### What disqualifies a change (it scores 1)

- It does not do what the ticket asks, or does something else instead.
- It breaks existing behaviour, or deletes or weakens a test to get past it.
- It invents data, names or business rules the ticket did not give.
- It carries a secret or a credential, or writes to production data.

### The points

- **5**: merge as it is.
- **4**: merge after small fixes a reviewer would mention in passing (a name, a comment, one
  missed edge case).
- **3**: the right approach, but it needs a real round of changes before it could merge.
- **2**: it addresses part of the ticket; most of it would be rewritten.
- **1**: disqualified, or not worth a review.
