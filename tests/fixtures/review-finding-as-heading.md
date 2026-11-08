<!-- desk-review:local -->
<!-- desk-review:verdict v=1 sha=91e88a0017e238b2cdc57e5eaa5361d2c97dd0c5 p0=1 p1=0 p2=0 deferred=0 gaps=0 unrefuted=0 partial=0 vendor=codex-cross round=3 -->
**desk-review, round 3, fix range 9dabb9a..91e88a0: not clean: 1 P0 outstanding at `91e88a0`** · codex read the diff cold · refuted cross-vendor
<!-- desk-review:carried v=1 p2=0 since=9dabb9a06dc2ee9359889431061601cbee964454 -->
<!-- desk-review:method v=1 fallback=0 -->
<!-- desk-review:rests-on v=1 files=["README.md","desk/bin/bench-arm3.mjs","desk/bin/bench-credits.mjs","desk/bin/bench-quota.mjs","desk/bin/bench-report.mjs","desk/bin/bench.mjs","desk/bin/claude-logins.mjs","desk/bin/codex-exec.mjs","desk/bin/desk-env.mjs","desk/bin/logins.mjs","desk/bin/overage-watch.mjs","desk/bin/skill-eval.mjs","desk/bin/usage-limit.mjs","desk/bin/usage-pace.mjs","desk/bin/usage-probe.mjs","skills/desk-review/references/review-bar.md","tests/fixtures/usage-limit-allowed.json","tests/test_bench_arm3.mjs"] -->

```
branch feat/DS-484-bench-fable-credits-gate → feat/DS-461-subscription-rotation-usage-limits · round 3 · 9 files · LOW tier · correctness + Bea + simplicity + codex cold
bar: default@91e88a0 · cross-vendor: codex refuted 1 Claude finding · codex's cold read found nothing, so Claude refuted none
```

This round read the whole branch, because a clean rebase onto the moved base rewrote its commits. Rounds 1 and 2 ran before the rebase, at `32e49803` and `c812a6c2`. Round 2 was clean. `git range-diff` shows both commits unchanged by the rebase, and the base changed none of the files that review rested on. This finding was in the code at those rounds too.

**Handed to a fix try.** Round 3 is the last round, so this P0 is posted here rather than fixed on this branch.

## P0 (1)

### `desk/bin/bench.mjs:358`: with `CLAUDE_CODE_OAUTH_TOKEN` set, the quota guard reads a different account from the one a Fable run spends

Round 1's fix moved the Fable run onto the signed-in login by dropping every credential that outranks it (`fableEnv`, `desk/bin/bench-credits.mjs:15-19`, used at `desk/bin/bench-arm3.mjs:139`). `runBench` still gives the quota guard the unfiltered `armEnv()` for `startRun` and `endRun` (`desk/bin/bench.mjs:358` and `:369`). The probe removes only `ANTHROPIC_API_KEY` (`desk/bin/usage-probe.mjs:86-89`, `desk/bin/logins.mjs:65`), so an exported token stays.

With the token exported, the before and after readings come from the token's account while Fable spends the login's weekly allowance. The per-computer cap and the interactive reserve then never trip on the account being spent, and the report's Fable quota figures are wrong. The other sides keep the token for both the run and the probe, so only Fable has this mismatch.

It applies only when the token is exported, and nothing in the repo sets it. Usage credits stay gated on the login. `tests/test_bench_arm3.mjs:280` sets this environment but asserts only which credential the run received.

**Suggested fix:** have the guard read the environment the arm runs in. For example, let an arm carry its own run environment (Fable's being `fableEnv(armEnv())`) and have `runBench` pass that to `accountFor`, `startRun` and `endRun`, falling back to `armEnv()` for other arms. Extend the token test to assert that the guard's probes for the Fable side ran without the token.

<details><summary>Refutation</summary>

codex: CONFIRMED. `bench.mjs:358,369` pass `armEnv()` to quota probes, whose `probeEnv`/`loginEnv` retain `CLAUDE_CODE_OAUTH_TOKEN`, while `runFable` uses `fableEnv()` to remove it; quota checks therefore measure the token account rather than the signed-in account Fable spends.

</details>

## Requirements

No gaps against DS-484 AC1 to AC5, and nothing out of scope. Ben's manual check of each account's settings is still to do, as the ticket says.

## Other seats

Simplicity and codex cold: no findings.
