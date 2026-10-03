# Phase 7: fix offer

Read this only when Phase 6 has reported at least one finding and the target is exactly `HEAD`.

Precondition: a clean tree.

```bash
git status --porcelain      # must be empty
```

A dirty tree is refused: ask the author to commit or stash, so anything applied can come back with
one `git checkout`. Never stash or discard it for them.

Then, one finding at a time, in report order:

1. Show the exact diff the fix would apply. Never propose an edit the author has not seen, least of
   all a reverted hunk, which is deletion of work they meant to do.
2. Ask. One finding, one answer. **Never offer a bulk "apply all".**
3. Apply only inside the file the finding names. A fix that spreads is the scope creep this skill
   exists to catch.

**Only mechanical findings are offered:** delete an unused option, collapse a one-caller abstraction
into its caller, remove an unreachable guard, revert an out-of-scope hunk, delete a narrative or
restating comment, or cut one down to the why it carries. If you cannot state the fix as a concrete
diff before the author agrees to it, it is not mechanical: report it and leave it.

**A fix that needs a test changed to keep passing changed behaviour.** Abandon it and say so.

Nothing is committed. Finish by naming what was applied and what was left, and remind the author to
run their tests: this skill does not.
