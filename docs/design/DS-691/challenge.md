# Devil's advocate review: recommendations.md and desktop-architecture.md (Ada, 2026-11-15)

Scope: both documents read in full. Claims spot-checked against `/Users/benlavender/studia/desk-skills` (source), `~/.claude/desk/bin` (installed), Portia at `scratchpad/repos/portia/src/src/...` (the docs' `src/...` paths are one level short, the content matches) and Orca at `scratchpad/repos/orca/src/src/...`. Sources marked "verified" were read by me. Everything else is a challenge on reasoning, not on fact.

## Steel-man

**recommendations.md.** It is disciplined. It corrects the Portia and Orca reports where desk already does the thing (fresh-session retry, setsid detach, strict MCP, mkdir locks), it ties each recommendation to a measured hotspot, it puts config flips before builds, and it lists a "don't copy" table. Its core thesis is right: worker cost is long, uncompacted contexts re-billed every turn, so the levers are fewer turns (polling), fewer bytes in context (instruction reads), and fewer wasted starts.

**desktop-architecture.md.** It makes the server the product and the window swappable. It allows no second writer (every write goes through an existing CLI on an execFile allowlist), stores no durable state, and treats a hostile web page as the main threat, with Host, Origin, cookie and CSP controls. It renders GitHub and Jira natively rather than fighting X-Frame-Options. It prefers a fresh seeded chat over an expensive resume. It is honest that the user asked for Electron and makes that the user's call (D1).

## Verified facts (the evidence is real)

| Claim | Status |
|---|---|
| Stage-4 contract forbids a timeout and uses the 20-minute `ps etime` / `TaskStop` rule | Verified, `worker-contract-stage-4.md:33-46` |
| `with-lock.sh` has `--timeout` and exit 75; mkdir fallback on macOS | Verified. The header also says why there is no default timeout: "waiting is the feature; --timeout is only for a caller that must not wait (the pre-push hook)". That is a deliberate design choice, which rec #1 overturns without arguing against it. |
| `worker-tools.mjs worker` returns 15 tools | Verified, exact list |
| `supervisor.mjs:84 DEFAULT_INTERVAL = 180`, `StartInterval` at :139 | Verified |
| `plan-batch.mjs` any shared file makes a pair a collision | Verified, :104-114 |
| Preflight fingerprint includes `worktree=$WT` | Verified, `spawn-worker.sh:201-204`. `dirs=` and `checks=` almost certainly carry the path too. |
| Only `preflight` lever on; `LEVERS` at `desk-env.mjs:897` | Verified (`desk-env levers` prints `on: preflight`) |
| `review-reuse` at `pass.mjs:3600-3612` | Verified, but **mis-described**: see rec #5 |
| `pass.mjs` 350 KB, `desk-q.mjs` 268 KB / 3,865 lines, `isMain` at :3845 | Verified |
| Re-reads are already blocked within a session | Verified, `hooks/desk-worker-reread.py`. So skill-read bytes are first reads, which supports rec #2's framing. |
| Price table ($0.2/M read, $8/M 1h write, Opus) | Verified against `worker-cost.mjs MODEL_PRICES`. These are **API-equivalent** dollars (`cache-report.mjs:3`). |
| Portia `ROLE_TOOLS` six tools, `tail` 30 lines, heavy steps under `withLock`, `patchId` | Verified |
| Orca "ask then end your turn", `list_models` control request with no API turn | Verified, `worker-dispatch-preamble.ts:90,160`, `claude-model-list-probe.ts:5-9` |
| `machineBudget` can count UI sessions "with a ui caller tag" | **Not true today.** `borrow.mjs:130` sums `running` from queue files. It has no caller registry, so a server-spawned session is invisible to it. |
| Orca's Electron is 43.8.7; the doc says "Electron 45.x" | 45 is plausible for Nov 2026 but unverified |

## A cross-cutting challenge: dollars are not the constraint

The workers run on subscription logins (`CLAUDE_CONFIG_DIR`, 5-hour and 7-day windows). The doc's own numbers put the weekly window at **88% used against 73% pace**. The "$/9 days" figures are a ranking aid. The real currency is quota headroom. This changes the ranking in two ways:
- Anything that adds parallelism (recs #6, #10, desktop chat sessions) does not raise throughput while the window is binding. It hits the wall sooner. Under a token ceiling, parallelism buys latency, not throughput.
- Token cuts (#1, #2, #3) are worth more than their dollar figure, because each one is weekly capacity.

---

## Part 1: recommendations.md

| # | Challenge | Severity | Verdict |
|---|---|---|---|
| 1 | Bounded lock wait plus `desk-wait` | **Significant** | **Modify** |
| 2 | Stage packs | **Critical** (estimate) | **Modify** |
| 3 | Trim tool list | Significant (estimate is mostly wrong) | **Modify** |
| 4 | WatchPaths wake | Minor | **Keep** |
| 5 | review-reuse on, finder/text tiering | **Significant** | **Modify** |
| 6 | Collision audit, then split pass.mjs | Significant | **Keep (a), defer (b), drop (c) for now** |
| 7 | Cloned deps, template DB | **Critical** (silent wrong-code tests) | **Modify** |
| 8 | Cross-ticket preflight fingerprint | Minor | **Modify** |
| 9 | Rework-share metric | — | **Keep, and do it first** |
| 10 | Raise concurrency | Significant | **Drop for now** |
| 11 | Narrow-lock landing | — | **Keep as investigation** |

### #1 Bounded lock wait
- **The first step does not work as written.** `--timeout 1200` is a 20-minute wait inside one Bash call, and the Bash tool's ceiling is 10 minutes (600,000 ms). The tool still pushes the call to the background at its timeout, and the model is back to `ps` and `TaskStop` polling. The bound has to sit under about 540 s, or the lock wait itself has to go through the `--detach` plus `desk-wait` path, not only the suite.
- **A 9-minute bound moves the skip threshold from 20 to 9 minutes.** More suites become "not run locally; CI covers it", which means more CI-red fix tries (fresh sessions at about 27k tokens of instruction reload each). Rework could eat the polling saving. Measure the fix-try rate before and after (rec #9).
- **`--detach` re-creates the leak in a new form.** The contract's "never end your turn with a suite running" exists because `claude -p` kills the tree. A setsid-detached suite survives a worker that crashes, is killed or hits its budget, and keeps a test slot and its memory. It needs a reaper keyed to the owning session's pid and start time, not only `desk-wait`'s identity check.
- **The saving is overstated.** (a) The per-session counts include the `with-lock` calls themselves, which are the real suite runs, not polling. (b) Tool calls are not turns: parallel calls share a turn. (c) A polling turn is a cache read of the context plus a few output tokens, about $0.026 by the doc's own split, not the $0.056 average turn. A realistic figure is about a third to a half of $290.
- **Alternative not considered:** the Portia shape. The pass, not the model, runs the heavy suite. The worker ends its turn with "ready for gate", the pass runs `with-lock test` deterministically, and it re-spawns or continues with the 30-line tail. That costs a session restart, which is why it is not obviously better, but it removes model polling entirely. It should be weighed, not skipped.

### #2 Stage packs
- **The estimate assumes every read byte rides every turn.** A file read at turn k of N costs B × (N − k). A pack placed in the system prompt costs αB × N from turn 0. If reads are spread through the session (stage-3 early, stage-4 mid, stage-5 late), today's bytes ride about half the turns on average, so a pack at **α = 0.5 roughly breaks even**. The claimed "13k × 83 turns" counts each saved byte as riding all 83 turns, which is a ceiling. The realistic range is anywhere from $0 to about $120 per 9 days, and it is negative for sessions that exit early (a carried verdict, a no-op review).
- **Cutting the prose to its rules is a quality change, not a format change.** The contracts are worded with obvious care (see stage-4's lock paragraph). The rationale sentences are what let a model handle the edge case the rule did not name. A drift test catches staleness, not lost meaning. Gate it on the blind audit, as rec #5 already does for models.
- **The cross-session cache upside is the real prize, and it is unmeasured.** `--exclude-dynamic-system-prompt-sections` is already passed (`spawn-worker.sh:460`), so a byte-identical pack ahead of the per-ticket briefing might actually share a prefix across same-stage sessions inside the TTL. That, not the arithmetic above, is what could justify the build.
- **Modify:** measure first. Use `cache-report.mjs` on a hand-built start-4b pack for about 10 sessions, then check the read-turn index distribution in the logs. Build only if the measured saving beats break-even. Keep the prose; only deduplicate.

### #3 Tool list
- `WebSearch`/`WebFetch` are **contract-sanctioned** where §3 `worker-web-read` is `yes` (`worker-contract-stage-3.md:87`, `ask-or-take.md:122`).
- `SendMessage`/`ListAgents` are **required** for orchestrator messaging (`autopilot-worker-contract.md:109-110`). `ToolSearch` is how a deferred `SendMessage` gets loaded (`stage-3.md:175`).
- Deferred tools already send only their name, so removing them saves almost nothing. The 2-5k token estimate mostly evaporates.
- "Not in the top-30 calls" is not "zero use": rare paths are exactly the ones that break.
- **Modify:** make Web* conditional on `worker-web-read`, keep the messaging tools, measure with one `system/init`, and expect under 1%.

### #4 WatchPaths
- Sound and cheap. Two watch-outs:
  - More passes mean more `gh` API calls per hour across repos; check the rate-limit headroom.
  - WatchPaths only fires on directory entry changes. Write `exit.json` by atomic rename, or the wake is missed and the 180 s fallback hides the bug.
- **Keep.**

### #5 Levers
- **review-reuse is mis-described.** The code comment (`pass.mjs:3598-3603`) and `undraft.mjs:325` show that **on** changes the carry rule rather than only narrowing it:
  - It carries a verdict across **rebases** too, which off does not.
  - It **refuses** a carry across a clean base merge that touched a file the review rests on, which off allows.
  - So "no change to quality" is false in both directions: it accepts rebased heads unreviewed, and it can *add* review tries. It is probably a good lever, but it needs the same evaluation as the others, not a straight flip.
- **Finder tiering conflicts with a stated preference.** The user's saved memory says build and review subagents go on Opus, and that sonnet is rated poorly. A `finder=` trial on a cheaper model is that user's call. Do not run it as a default experiment.
- `list_models` replacing `MODEL_OK`: fine, and verified in Orca. Note that it is $0 today anyway.

### #6 Collisions and splitting pass.mjs
- (a) is the right first move: cheap and decisive.
- (b) The split is itself the ultimate collision ticket. It is a `relocate` kind, which `plan-batch` lands before everything that edits what it moves. Every in-flight `pass.mjs` branch then needs a base-fix. Git does not follow content across a file split, so those become hand-merges.
  - Splitting also does not remove the "blind to a helper" rationale when two tickets touch the same seam. Most of the 47 may well cluster on the same seams (fix-tries glue, review carry).
  - Do it only if (a) shows the scopes are real, and then seam by seam in a quiet window.
- Under the 88% quota, "2× throughput" is not available anyway (see the cross-cutting challenge).

### #7 Cloned deps
- **Critical silent failure.** `cp -c` of a `.venv` copies absolute paths:
  - the shebangs in `bin/`;
  - `pyvenv.cfg`;
  - and above all the **editable install** of the project itself, which uv and pip `-e` point at the *primary checkout's* source.
  - Tests in the worktree then import the primary checkout's code and pass against code that is not the ticket's.
- pnpm `node_modules` is mostly relative symlinks into `.pnpm` and is safer, but workspace packages can be linked by absolute path depending on the config.
- **Modify:**
  - Clone the global stores, not the environment: uv's cache, and the pnpm store, which is already shared.
  - Or clone the environment, then re-run `uv sync` / `pnpm install --offline` as a fast reconcile.
  - Add a test that asserts `import <pkg>; pkg.__file__` sits under the worktree.
  - The template DB and running DB setup alongside the install are fine.

### #8 Preflight fingerprint
- The "deterministic dry-run of the matcher" means re-implementing Claude Code's permission engine. That is exactly the divergence the model preflight exists to catch. Drop that part.
- The placeholder fingerprint with one model preflight per fingerprint per day is fine.
- At $50 per 9 days it is low priority.
- **Modify.**

### #9 Rework share
- This should be **#0**. It is the instrument that tells whether #1's shorter bound raises fix tries, whether #2 changes compliance, and whether #6 or #10 parallelism adds conflict and base-fix rework.
- Without it, every saving above is claimed gross, not net.
- **Keep, and run it first.**

### #10 Concurrency
- With the window at 88% against a 73% pace, more workers turn slots into a faster usage hold that stalls everything.
- More parallel branches on the same hot files also mean more conflicts and base-fix tries.
- **Drop** until #9 shows headroom and #1 has landed.

---

## Part 2: desktop-architecture.md

| # | Challenge | Severity | Response needed |
|---|---|---|---|
| D-1 | **D1's own numbers undercut the PWA recommendation.** A2 justifies the PWA by "weeks on signing, notarisation, an updater, an Electron upgrade every 8 weeks". A3 and §11 then say a locally built `.app` needs **no notarisation and no updater**, and §0 says Electron later is "roughly one day". So the real delta is about 1 day, about 120 MB, and periodic version bumps. Meanwhile everything that makes it "feel like a local app" is deferred to v2: the tray glance (S1), clickable notifications, `desk://`, and the embedded terminal. And the MVP's own distinguishing features (`setAppBadge` on a localhost PWA, `web+desk://`) are **both unverified spikes**. The Electron burden is also overstated: Electron supports the latest 3 majors, about 6 months, and a shell that loads only `127.0.0.1` has a small exposure surface. | **Critical** for the decision | Recommend the thin Electron shell in Phase 1, which is what the user asked for, with the PWA as the free fallback because the server is shell-agnostic. Or run both spikes on day 1 and decide on their result. Also check that a rebuilt ad-hoc-signed app does not trigger the notification permission prompt on every `install.sh` (the signing identity changes). |
| D-2 | **The cookie is not port-scoped.** Cookies are keyed by host, not port, so `desk_ui` (Path=/) set by `127.0.0.1:4823` is sent to every `127.0.0.1:*` server. That includes the dev servers workers start (`with-lock.sh nolock -- pnpm dev`), which run LLM-written code. `SameSite=Strict` does not help, because site ignores the port. A leaked 30-day cookie, replayed by a non-browser client that forges `Origin`, gives full API access: spawn `claude`, record answers, grant merges. The doc's threat model scopes same-user processes out, which partly covers this. But the cookie also lands in the request logs of any local service, which is a credential spread the token file's chmod 600 was meant to prevent. | Significant | Use a short-lived session cookie and require a per-load token in a custom header on every `/api` call. Have Electron's preload supply that token from the main process, never a cookie. Check `Origin` on WebSocket upgrades as strictly as on POST, and reject `Origin: null`. |
| D-3 | **"Counted in machineBudget with a ui tag" does not exist.** `machineBudget` (`borrow.mjs:130`) counts running workers from queue files. Chat sessions spawned by the server are invisible to the pass, so the app *can* bypass the cap unless the server writes a registry the pass reads. | Significant | Add a `ui/sessions.json` the pass counts (a pass.mjs change, collision-prone in desk-skills). Charge it in the plan. |
| D-4 | **Worktree race.** A chat runs in "the ticket's worktree when no worker holds it". Nothing stops the pass spawning a worker into that worktree mid-chat: two writers, one tree. | Significant | The server takes a claim the pass honours (the same mechanism as a running worker), or chats always use the scratch clone. |
| D-5 | **Quota contention.** Interactive Opus sessions (up to 4) draw on the same 7-day window that is at 88%. The usage guard refuses above the hold threshold, so near the limit the app's main interactive feature switches off exactly when the person most needs to unblock things. | Significant | Reserve a quota slice for interactive use, or default chats to a cheaper model at low effort for read-only "explain" purposes. That is the user's call, given the model-quality preference. |
| D-6 | **Watcher churn.** `fs.watch` recursive on `~/.desk-autopilot` includes `logs/`, which streams stream-json continuously while workers run. That means a rebuild every 250 ms for as long as any worker is live. | Minor | Exclude `logs/` (the LogTailer owns it), or watch the specific state files. |
| D-7 | **Phase 0 is the real cost and it is under-sized.** The `model*()`/`render*()` split of a 268 KB, 3,865-line TUI with byte-identical output is weeks of work, not "Low" (A6). In desk-skills it will collide with every desk-q ticket under desk's own collision rule. Upside: desk-q is already a long-lived 2-second rereading process with change-keyed caches (`logStages`, `forecasts`, `accounts`), so importing it into a server is less risky than it looks. Nine `test_desk_q*.mjs` suites exist. | Significant | Ship `desk-q --json <view>` from the existing builders first, then refactor view by view behind it. |
| D-8 | **Simplest version not considered.** The S1 2-second glance is what makes it feel native. A SwiftBar or xbar plugin reading `desk-q --json home` would deliver it in hours, alongside a plain PWA for the rest. The bundle of server, SPA, broker, ptyd and Electron is also a second UI to keep in step with every new hold kind (a 16-value `kind` enum today). | Minor / strategic | Consider the menu-bar plugin as a Phase 1 stopgap, and budget the ongoing two-UI sync cost explicitly. |
| D-9 | **Small inconsistencies.** (a) The fixed command template already passes `--permission-prompt-tool mcp__desk_ui__approve`, while the MVP says that is v1.5 and denies instead. (b) Group record is sequential with no stated partial-failure semantics. (c) The restart reasoning ("child ends at its next read") ignores that launchd kills the job's process group on restart unless `AbandonProcessGroup` is set. Either way RPO is fine, but the mechanism is wrong. | Minor | Fix the text. |

Kept as is: execFile allowlist writes; no durable state; native GitHub and Jira panels over iframes; SSE plus WS split; the security review gate before first launch; Agent SDK deferred (zero dependencies); refusing Orca's plaintext credential fallback.

## Blind spots (neither document considers them)
1. **Quota as the binding constraint** (see the cross-cutting challenge). It reorders both documents' priorities.
2. **Net vs gross savings.** No recommendation is measured against the rework it may cause. Rec #9 needs to come first.
3. **Prompt injection through the app.** Chat seeds include Jira descriptions and PR text, which is external, untrusted content, and run with the batch allow-list in a real worktree. A human is present, but approve-fatigue is a known failure mode. Seed external text as quoted data and keep `Bash` behind the permission relay for chat sessions.
4. **The user's model preference** (Opus for review subagents) is not reflected in rec #5 or in the desktop's chat defaults.

## Verdicts
- **recommendations.md: Needs strengthening.**
  - The direction is right.
  - #1 and #2 have arithmetic and mechanism errors that matter.
  - #7 has a silent correctness bug.
  - #5 mis-describes the lever.
  - #10 fights the quota.
- **desktop-architecture.md: Needs strengthening.**
  - The architecture (server as product, CLI-only writes, no state) survives.
  - The shell decision D1 is argued with inconsistent cost numbers.
  - The security and accounting controls lean on mechanisms that don't exist (the `ui` tag, a worktree claim) or don't isolate what they claim to (SameSite across ports).

## The 3 things most likely to be wrong
1. **Rec #2's $250-400 saving.** It counts each saved byte as riding all 83 turns, but a pack loads at turn 0 while today's reads are spread through the session. At the planned 50% cut it is close to break-even, and negative for sessions that exit early. The only real upside, cache sharing across sessions, is unmeasured.
2. **Rec #1 as specified.** A 1200 s lock timeout inside a Bash tool capped at 600 s still gets backgrounded and polled. A shorter bound raises the "not run locally" rate and with it CI-red rework. A detached suite can orphan and hold a test slot. The $290 also counts real suite runs as polling, at the average turn price.
3. **D1 (PWA first) and the security story behind it.** By the doc's own A3 and §11, Electron for personal use needs no notarisation and no updater, so the case for deferring it collapses to about 1 day of work. The PWA's own advantages (badge, `web+desk://`) are unverified. Separately, a `SameSite=Strict` cookie on `127.0.0.1` is sent to every localhost port, including worker-launched dev servers.
