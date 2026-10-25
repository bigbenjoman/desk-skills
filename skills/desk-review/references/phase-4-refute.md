# desk-review Phase 4: refute

Read when the review reaches Phase 4, or at Phase 3 for the codex cold call's quoting rules. The
config, the bar, the entry points, every seat's prompt, the round rules and the verdict are in
`../SKILL.md`, already loaded; a "below" or "above" this file does not hold points there or to
another phase's file. Paths such as `references/gotchas.md` are from the skill's directory.

## Phase 4: refute

**The refuter is always the other vendor.** Claude's findings go to codex; codex's go to Claude.

**Claude's findings: one codex call per finding**, prompt under ~800 characters, `file:line` named
and the mechanism stated flat. Codex reads the file itself; never paste a diff or ask it to run git.
Independent calls may run in parallel.

```bash
codex exec --sandbox read-only 'Refute this code-review finding by reading the code. Reply CONFIRMED with a one-line proof, REJECTED with the reason, or DUPLICATE-OF <n>. If uncertain, REJECTED. <P1> <path:line>: <mechanism in one or two sentences>'
```

- **On a PR, add `--cd <the PR's worktree>`** after `--sandbox read-only`, so codex reads the PR's
  files. The long form, never `-C`, which sits next to the denied `-c`.
- **Single quotes, and plain words inside them.** In double quotes a backtick or `$` in the
  mechanism is command substitution, which makes the call compound and a worker refuses it. The
  worker's deny rules also match the prompt text, so ` -c `, ` -s `, `danger` or `--config` written
  literally (a finding about `bash -c`, or `dangerouslySetInnerHTML`) gets the call denied. Describe
  flags and API names in words: "runs its input through a shell", "sets raw HTML". An apostrophe is
  written as a typographic ’, never `'`.
- **No `-c`, `--config`, `-m` or `-p`.** Desk's harness asks on every one of them and a worker
  denies them. Reasoning effort is set in the user's `~/.codex/config.toml`, not per call.
- **Never offer a benign alternative** ("or is this deliberate?"). Codex rejects when uncertain, so
  the clause flips real findings to REJECTED with no change in the code.
- **An empty, denied or useless reply is `UNREFUTED`**, never REJECTED and never a pass. Retry it
  once with the prompt reworded. Still nothing: the finding stays in the report under its severity,
  tagged `UNREFUTED`, and is counted in the verdict's `unrefuted`. A run with any `UNREFUTED`
  finding is not clean. Dropping it would turn a refuter outage into a clean verdict.

**Codex's findings: one `ada-devils-advocate` call** (else `general-purpose`) holding all of them,
each with an id, the same refutation instruction (read the code, reject when uncertain, never a
benign alternative), and the answer form `VERDICT <id>: CONFIRMED | REJECTED | DUPLICATE-OF <id>`
with a `proof:` or `counter:` line. It is read-only like the finders (Phase 3, item 1). A missing
verdict for an id is that finding `UNREFUTED`, under the same rules as above. A Claude finding and a
codex finding at the same position are refuted separately, each by the other vendor, and merged
only after.

**Same-vendor** (agreed in Phase 0): Claude's findings go to `ada-devils-advocate` too, every
verdict tagged `(same-vendor)`.

The refuter rejects a finding when an existing guard, caller contract, test or framework behaviour
already handles it, or when the repo already records it as known (per the bar's *Never report*) and
the diff leaves the anchored code untouched. **When genuinely uncertain, reject**: a missed issue
costs less than a false positive that burns the author's time.

`CONFIRMED` and `UNREFUTED` findings reach the report; `REJECTED` ones do not. Duplicates merge: keep
the clearest write-up and the union of the evidence, at the severity of the one that survived
refutation; the other is recorded as `DUPLICATE` of it (Phase 7). Requirement gaps never enter this
phase (Phase 5 owns them), and neither does a `PREMISE`: it is a claim nobody could prove, so a
refuter reading the same code has nothing to add.

**Existing bot comments** (interactive, on a PR): tag any surviving finding an automated reviewer
already raised, so the report shows what is new. `references/gotchas.md#bot-comments` has the call;
it is the `pulls/<n>/comments` endpoint, overlap is **positional** (same path, line inside the bot's
range), and overlap is annotated, never dropped. A worker has no `gh api`: skip it and say so.
