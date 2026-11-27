<!-- desk-review:local -->
<!-- desk-review:verdict v=1 sha=6e13bc987d92f828e0e6dc2782f71ddbcf19eb2b p0=0 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex-cross round=5 -->
**desk-review, round 5, fix range 64c50f9..6e13bc9: No P0, P1 or P2 findings at `6e13bc9`** · codex read the diff cold · refuted cross-vendor
<!-- desk-review:carried v=1 p2=0 since=64c50f9f6bdbd48991ce330210f63776de211aa8 -->
<!-- desk-review:method v=1 fallback=0 -->
<!-- desk-review:rests-on v=1 files=["desk/bin/batch-state.mjs","desk/bin/batches.mjs","desk/bin/borrow.mjs","desk/bin/config-schema.mjs","desk/bin/conflict-record.mjs","desk/bin/desk-env.mjs","desk/bin/desk-q.mjs","desk/bin/dir-lock.mjs","desk/bin/file-budget.mjs","desk/bin/fix-tries.mjs","desk/bin/gate.mjs","desk/bin/harvest.mjs","desk/bin/pass.mjs","desk/bin/pass/advance.mjs","desk/bin/pass/shared.mjs","desk/bin/pass/spawn-loop.mjs","desk/bin/queue-states.mjs","desk/bin/queue-store.mjs","desk/bin/queue-writer.mjs","desk/bin/queue.mjs","desk/bin/scope-precision.mjs","desk/bin/scope-report.mjs","desk/bin/supervisor.mjs","desk/bin/triage.sh","skills/desk-autopilot/references/feature-branch.md","skills/desk-review/references/review-bar.md","tests/prose_check.mjs","tests/scope_sections.mjs","tests/test_needs_you.mjs","tests/test_prose_code.mjs"] -->

```
branch fix/DS-1033-desk-q-collides-budget → main · round 5 · 5 files · MEDIUM tier · 2 finders + Bea + simplicity + codex cold
bar: default@6e13bc9 (skills/desk-review/references/review-bar.md) · cross-vendor: Claude refuted 2 codex findings · learned checks: not read (review-misses.mjs refused to this worker)
```

No P0, P1 or P2 findings. The whole branch was read again from its merge base `64c50f9`, because `main` was merged in after round 4 (`3f15408`). That makes the header's range the whole branch, not a narrow fix range.

**This round's fix (fix try 1, CI red at `bd8b41f`).** Commit `6e13bc9` fixes three things:
- **The lock-orphans failure.** The branch had removed `writeJsonAtomic` from `pass.mjs`'s imports when its one use moved into `file-budget.mjs`. Main's DS-1011 lock-orphans pass, merged in at `3f15408`, writes `lock-orphans.json` with it. Without the import that write threw inside a `try`, so `test_pass_lock_orphans.sh` found no file. The import is back.
- **The prose-code failure.** `test_prose_code.mjs`'s covers lines now name `desk/bin/file-budget.mjs` and `desk/bin/conflict-record.mjs`, which `prose_check` imports through `desk-q.mjs`.
- **The needs-you failure.** The ticket page wraps its "Moves without you" text onto `▌ ` lines at a fixed text width. The `test_needs_you.mjs` check "its ticket page says the same" now joins those lines before matching, so it asserts the same full reason it did before.

**Seats.**
- **Correctness (Lena):** no findings. She checked every identifier that moved into `file-budget.mjs` against main's merged code. None other than `writeJsonAtomic` lost its import.
- **Tests (Mira):** no findings. The joined-line match rebuilds the wrapped text exactly. Without the fix, AC1 (F-6) and AC2 (F-5) still fail.
- **Simplicity:** no findings.
- **Requirements (Bea):** AC1 and AC2 are met, nothing is out of scope, and there are no gaps.
- **Codex cold read:** two P0s, both rejected by Claude:
  - **C1** (`desk/bin/desk-q.mjs:3315`, "a finished worker still fills a place"): the diff doesn't change this. The old reason used the same `state === 'running'` filter. desk-q already shows that holder as `finishing`, and the reason clears at the next pass's harvest.
  - **C2** (`desk/bin/desk-q.mjs:3320`, "desk-q ignores `DESK_DEFAULT_BRANCH`"): the supervisor and batch scripts strip that variable before every pass (`desk/bin/supervisor.mjs:468`, `:971`). The only other place it is set is `applyBatchBase`, which exports `q.base`, and desk-q's `baseOf` reads `q.base` first (`desk/bin/desk-q.mjs:228`).
