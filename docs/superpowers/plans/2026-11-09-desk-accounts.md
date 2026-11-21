# desk Usage: accounts, not folders — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** desk tracks a fixed set of Claude accounts, each pinned to its own desk folder, so the user's own Claude Code account switches never duplicate, hide or move a desk account.

**Architecture:** The subscriptions file gains an Account column that pins each Claude folder to an email. A file with any pin is in *multi-account mode*: `~/.claude` drops out of every Claude login list, rotation never falls back to the caller's environment, and the account check reports `wrong account` / `not set up` instead of `duplicate`. Only interactive paths (desk-q, `desk-env logins`) write pins. Codex gets its email and plan from the `id_token` payload in `auth.json`.

**Tech Stack:** Node.js ESM (`desk/bin/*.mjs`), plain `node tests/test_*.mjs` scripts with the repo's `t(name, got, want)` helper, fake `claude`/`codex` binaries in a scratch HOME.

**Spec:** `docs/superpowers/specs/2026-11-09-desk-accounts-design.md` (read it; copy strings from it verbatim). Canvas: https://claude.ai/artifact/8bSfhGvKq2xhhLi7Z9XuH1

## Global Constraints

- A computer with no subscriptions file, or a file with no Claude folder under `~/.claude-logins/`, behaves exactly as before: no Account column written, `~/.claude` used, no new copy.
- Pins are emails, compared and stored lowercased.
- Background code (pass.mjs, call-login.mjs, decider.mjs, epic-plan.mjs, usage-probe.mjs, claude-logins.mjs) never writes `subscriptions.md`.
- In multi-account mode nothing starts a Claude worker, model call or probe on `~/.claude`.
- Never read, print or store Codex `access_token`/`refresh_token`; decode only the `id_token` payload, no signature check, no network.
- Every user-facing string below is copied from the spec; `<…>` are substitutions.
- Each test file runs with `node tests/<file>` and prints `all … checks passed` on success; run all touched test files before each commit.

## Review Focus

1. **Email case**: `Ben@Studia.io` live vs pin `ben@studia.io` is the same account → `signed in`. Test in Task 2.
2. **Check failure on a pinned folder** (`claude auth status` times out or prints non-JSON) → state `error`, never `wrong account`, and never re-pinned. Test in Task 2.
3. **Hand-edited file**: an Account cell that isn't an email, or an Account on a Codex row → a `line <n>:` parse error and the row left out, no throw. Test in Task 1.
4. **A worker still running on `~/.claude` when multi-account mode starts** → the agent registry still reads `~/.claude`, so the worker is not taken for dead. Test in Task 4.
5. **Codex `auth.json` missing, unparseable, an API-key login, or a malformed JWT** → label falls back (desk-label, then folder name), plan `—`, no throw, and no token text in any output. Test in Task 5.

---

### Task 1: Account column in the subscriptions file

**Files:**
- Modify: `desk/bin/logins.mjs` (`login`, `parseSubscriptions`, `renderSubscriptions`, `toolLogins`, `setRule`)
- Test: `tests/test_logins.mjs`

**Interfaces:**
- Produces: `login({ tool, name, folder, rule, source, account = null })` → login with `account` (lowercased email or null); `multiAccount(subs) -> boolean` (true when any Claude login in `subs.logins` has `account`); `renderSubscriptions(logins, removed)` writes `| Tool | Name | Folder | Account | Rule |` when `logins.some(l => l.account)`, else the old 4-column table; Codex and unpinned rows write `` `-` `` in Account. `toolLogins('claude', subs)` omits `defaultLogin('claude')` when `multiAccount(subs)`.

- [ ] **Step 1: Write the failing tests** in `tests/test_logins.mjs`:

```js
const FIVE = '| Tool | Name | Folder | Account | Rule |\n|---|---|---|---|---|\n| `claude` | `login-2` | `~/.claude-logins/login-2` | `Ben.Lavender1@Gmail.com` | `in rotation` |\n| `codex` | `default` | `~/.codex` | `-` | `in rotation` |\n';
const s5 = parseSubscriptions(FIVE);
t('the Account column is read, lowercased', s5.logins.find((l) => l.name === 'login-2').account, 'ben.lavender1@gmail.com');
t('a pin puts the file in multi-account mode', multiAccount(s5), true);
t('a 4-column file has no pins', multiAccount(parseSubscriptions('| Tool | Name | Folder | Rule |\n|---|---|---|---|\n| `claude` | `default` | `~/.claude` | `in rotation` |\n')), false);
t('multi-account mode drops ~/.claude from the Claude logins', toolLogins('claude', s5).some((l) => !l.configDir), false);
t('a pinned file renders 5 columns', renderSubscriptions(s5.logins, s5.removed).includes('| `claude` | `login-2` | `~/.claude-logins/login-2` | `ben.lavender1@gmail.com` | `in rotation` |'), true);
t('an unpinned file still renders 4 columns', renderSubscriptions(parseSubscriptions('').logins).includes('| Tool | Name | Folder | Rule |'), true);
const bad = parseSubscriptions('| Tool | Name | Folder | Account | Rule |\n|---|---|---|---|---|\n| `claude` | `x` | `~/.claude-logins/x` | `not-an-email` | `standby` |\n| `codex` | `c` | `~/.codex` | `a@b.c` | `standby` |\n');
t('an Account that is not an email is a named error', bad.errors.some((e) => /^line 3: .*not an email/.test(e)), true);
t('an Account on a Codex row is a named error', bad.errors.some((e) => /^line 4: .*codex/.test(e)), true);
t('setRule keeps a pin', setRule(s5, { tool: 'claude', name: 'login-2', rule: 'standby', check: () => ({ usable: [] }) }).text.includes('`ben.lavender1@gmail.com` | `standby`'), true);
```

- [ ] **Step 2:** Run `node tests/test_logins.mjs`. Expected: FAIL (`multiAccount` is not exported).
- [ ] **Step 3: Implement** in `desk/bin/logins.mjs`. Accept header `tool|name|folder|account|rule` alongside `tool|name|folder|rule`; an Account cell of `-` or empty means null; email test `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`. Error texts: `${at}: claude ${name}: account "${v}" is not an email` and `${at}: codex ${name}: a Codex row takes no account`. Update the file's header prose in `renderSubscriptions` with one sentence: `Account is the Claude account a folder belongs to: desk uses the folder only while it is signed in to that account.`
- [ ] **Step 4:** Run `node tests/test_logins.mjs`. Expected: `all … checks passed`.
- [ ] **Step 5: Commit** `feat(logins): pin Claude folders to an account in subscriptions.md`

### Task 2: Account check states

**Files:**
- Modify: `desk/bin/logins.mjs` (`checkLogins`, `isUsable`, `STATE`, `checkLines`, `loginJson`)
- Test: `tests/test_logins.mjs`

**Interfaces:**
- Consumes: Task 1's `account`, `multiAccount`.
- Produces: a checked login's `state` is `'signed in' | 'signed out' | 'error' | 'wrong account' | 'not set up'` (`'duplicate'` is gone). New fields: `liveEmail` (what the folder is signed in to, or null) and `pinnable` (true only for a `not set up` folder that is signed in to an email no other login is pinned to). `email` stays the pinned email when there is a pin, else the live one. `isUsable(l)` is unchanged in shape: only `signed in` with a rule of `in rotation`/`standby`.

Rules, only when `multiAccount(subs)`; without it, keep today's behaviour minus `duplicate` (a second folder on one account becomes `not set up`, `pinnable: false`):
- pinned, signed in, live email equals pin (case-insensitive) → `signed in`
- pinned, signed in, different email → `wrong account`, `why: 'signed in to <live>'`
- pinned, signed out / error → as today; never re-pinned
- unpinned Claude folder (listed or found) → `not set up`; `pinnable` as above
- two rows pinned to one email → the first in file order keeps it; the rest `not set up`, `pinnable: false`, `why: 'pinned to the same account as <first name>'`

- [ ] **Step 1: Write the failing tests** using the existing `claudeIn(dir, email, plan)` fake and a 5-column file for `login-2` (pin `a@x.io`), `login-3` (pin `b@x.io`), and an unlisted signed-in `login-4`:
  - `t('a pinned folder on its account is signed in', st('login-2'), 'signed in')`
  - `t('case does not matter', …)` with `claudeIn(login2, 'A@X.io', 'Ultra')` → `'signed in'`
  - `t('a pinned folder on another account is wrong account', …)` with `claudeIn(login2, 'b@x.io', …)` → `'wrong account'`, `liveEmail` `'b@x.io'`, and `usable` without `login-2`
  - `t('an unlisted signed-in folder is not set up and pinnable', …)` with `claudeIn(login4, 'c@x.io', …)` → `'not set up'`, `pinnable` `true`
  - `t('an unlisted folder on a pinned account is not pinnable', …)` with `claudeIn(login4, 'b@x.io', …)` → `pinnable` `false`
  - `t('a check that errors on a pinned folder stays error', …)`: `status.json` containing `not json` with exit 0 → `'error'`
  - `t('~/.claude is never checked in multi-account mode', …)`: the fake's `CALLS` log has no line with `unset` for CLAUDE_CONFIG_DIR
  - `t('checkLines names the wrong account', checkLines(r, p).some((l) => l.includes('claude login-2 is signed in to b@x.io, not a@x.io: desk won\'t use it until it is signed back in')), true)`
- [ ] **Step 2:** Run `node tests/test_logins.mjs`. Expected: the new checks FAIL.
- [ ] **Step 3: Implement.** `STATE` becomes `{ 'signed in': 'signed in', 'signed out': 'signed out', error: 'not checked', 'wrong account': 'wrong account', 'not set up': 'not set up' }`. The `checkLines` note for `not set up` reads `claude <name> is not set up: desk-env logins pin claude <name> pins it to the account it is signed in to`. `loginJson` adds `account`, `liveEmail` and `pinnable`, and drops `duplicateOf`. Delete the `duplicate` branch, and update existing tests in this file that expect `duplicate`.
- [ ] **Step 4:** Run `node tests/test_logins.mjs`. Expected: passes.
- [ ] **Step 5: Commit** `feat(logins): wrong-account and not-set-up states replace duplicate`

### Task 3: Pinning and migration through `desk-env logins`

**Files:**
- Modify: `desk/bin/logins.mjs` (new `pinLogin`, `needsMigration`, `migrateSubscriptions`), `desk/bin/desk-env.mjs:1982-2016` (CLI)
- Test: `tests/test_logins.mjs` (CLI section, via `execFile(node, [desk-env.mjs, 'logins', …])` as the existing set/remove tests do)

**Interfaces:**
- Consumes: Task 2's `checkLogins` (`liveEmail`, `pinnable`).
- Produces:
  - `pinLogin(subs, { tool: 'claude', name, check }) -> { text, login }`. It pins the folder to its current live email. If the folder isn't listed, it is added as `standby`; otherwise its rule is kept. A folder on `~/.claude` is moved to Removed. It throws `logins: claude <name> is not signed in` or `logins: <email> is already pinned to <other name>`.
  - `needsMigration(subs) -> boolean`: the file exists, has no pins, and lists or finds at least one Claude folder under `~/.claude-logins/` that is not in Removed.
  - `migrateSubscriptions(subs, check) -> { text, hint }`. It applies spec § Migration steps 1-3. `hint` is the email `~/.claude` was on when that email isn't pinned anywhere, or null.
  - CLI: `desk-env logins pin claude <name>` and `desk-env logins migrate`. Both write with `writeWithBackup`. `migrate` is a no-op that prints `nothing to migrate` when `!needsMigration`. The usage line gains `| pin claude <name> | migrate`.

- [ ] **Step 1: Write the failing tests.** Use a 4-column file listing `claude default ~/.claude in rotation` and `claude login-2 standby`, plus a found `login-3`. Sign in `~/.claude` to `x@a.io`, `login-2` to `y@a.io` and `login-3` to `x@a.io`. Then:
  - `t('the old file needs migrating', needsMigration(subs), true)`
  - after `desk-env logins migrate`: `login-2` is pinned `y@a.io` and stays `standby`; `login-3` is pinned `x@a.io`; `~/.claude` is in the Removed table; and `hint` (printed as `add <email> with a in view 6`) is absent because `x@a.io` is pinned
  - a variant where `login-3` is signed in to `y@a.io` → `login-3` is unpinned and the output says `add x@a.io with a in view 6`
  - `t('a Codex-only file is left alone', needsMigration(parseSubscriptions(codexOnly)), false)`
  - `t('no file is left alone', needsMigration(readSubscriptions(join(T, 'none.md'))), false)`
  - `logins pin claude login-4`, where `login-4` is on a pinned email → exit 1, stderr ends `y@a.io is already pinned to login-2`
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3: Implement** both functions and the two CLI subcommands.
- [ ] **Step 4:** Run `node tests/test_logins.mjs`. Expected: passes.
- [ ] **Step 5: Commit** `feat(logins): pin and migrate commands for account pins`

### Task 4: Rotation waits instead of falling back to `~/.claude`

**Files:**
- Modify: `desk/bin/call-login.mjs:28-90`, `desk/bin/claude-logins.mjs:24-44` (`claudeLogins`, `runningLogins`), `desk/bin/pass.mjs:223-240` (`OWN_LOGIN`, `probeOnce`), `desk/bin/epic-plan.mjs:318-333` (`headlessEnv`, callers)
- Test: `tests/test_login_rotation.mjs`, `tests/test_claude_logins.mjs`

**Interfaces:**
- Consumes: `multiAccount(subs)` (Task 1). `toolLogins` already drops the default in multi-account mode, so `claudeLogins` and `probeLogins` do too.
- Produces:
  - `callLogin(...) -> { login, env, all, wait }`. In multi-account mode it never returns the caller's `env` for Claude. With no usable login, or every one benched, it returns `{ login: null, env: null, all: true, wait: true }`.
  - The CLI prints `all` for that case, so `decider.mjs` already starts nothing.
  - `headlessEnv(env)` returns `null` when `wait`, and epic planning's draft returns `{ why: 'every Claude account is at its limit or signed out, so planning waits for one with room' }` without spawning.
  - `runningLogins` still includes `~/.claude` when it exists, so the registry never misses an old worker.
  - In pass.mjs, `probeOnce()` with no login argument returns `{ ok: false }` without probing when `multiAccount(SUBS)`.

- [ ] **Step 1: Write the failing tests.**
  - In `tests/test_login_rotation.mjs`, with a pinned file and every pinned login benched: `t('multi-account: every login benched waits', JSON.stringify(callLogin({ env }).env), 'null')` and `wait` `true`. With nothing signed in, the same.
  - With no file: `callLogin({ env }).env === env` (unchanged).
  - In `tests/test_claude_logins.mjs`: `t('the registry still reads ~/.claude in multi-account mode', <readRegistry calls include CLAUDE_CONFIG_DIR unset>, true)` and `t('probeLogins leaves out ~/.claude', probeLogins().some((l) => !l.configDir), false)`.
- [ ] **Step 2:** Run both files. Expected: FAIL.
- [ ] **Step 3: Implement.** Update the header comment of `call-login.mjs` to describe waiting in place of the fallback.
- [ ] **Step 4:** Run `node tests/test_login_rotation.mjs && node tests/test_claude_logins.mjs`, plus every other `tests/test_*.mjs` that imports `call-login`, `decider` or `epic-plan` (`grep -l` them). Expected: all pass.
- [ ] **Step 5: Commit** `feat(rotation): wait for an account with room instead of using ~/.claude`

### Task 5: Codex email and plan from `auth.json`

**Files:**
- Modify: `desk/bin/logins.mjs` (new `codexAccount`; `checkLogin` codex branch), `desk/bin/codex-usage.mjs:1-8` (header comment), `desk/bin/desk-q.mjs:1916-1933` (`accountOf`/`loginLabel`/Codex `plan`)
- Test: `tests/test_codex_login.mjs`, `tests/test_logins.mjs`

**Interfaces:**
- Produces:
  - `codexAccount(l) -> { email, plan }`. It reads `<l.dir>/auth.json` → `tokens.id_token`, base64url-decodes the middle segment and returns `email` and `['https://api.openai.com/auth'].chatgpt_plan_type`, title-cased (`pro` → `Pro`, `plus` → `Plus`). Anything missing or malformed gives null.
  - `checkLogin` for Codex returns that `email` and `plan` when signed in.
  - desk-q's `loginLabel` for Codex is `codexAccount(l).email ?? loginLabelOf(l) ?? l.name`, and the Codex row's plan is `codexAccount(l).plan`, with null shown as `—`. `reading.plan` is no longer shown.
- [ ] **Step 1: Write the failing tests** using a fixture `auth.json`. Its `id_token` is built in the test as `header.payload.sig`, with the payload `{ email: 'me@x.io', 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } }`, and its `access_token` is the `TOKEN` fixture:
  - `t('codex email from the id_token', codexAccount(l).email, 'me@x.io')`
  - `t('codex plan title-cased', codexAccount(l).plan, 'Pro')`
  - Each of these gives `{ email: null, plan: null }` with no throw: no `auth.json`, `auth.json` = `{"OPENAI_API_KEY":"k"}`, `id_token` = `'a.b'`, and `id_token` = `'a.!!!.c'`.
  - `t('no token in check output', JSON.stringify(checkLogins(subs, fakes).logins.map(loginJson)).includes(TOKEN), false)`
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3: Implement.** Replace the `codex-usage.mjs` sentence `Nothing here reads auth.json or any token.` with: `Nothing here reads auth.json; logins.mjs codexAccount reads only the id_token's payload (email and plan), never the access or refresh token.` Before choosing the mapping, run `node -e` on this machine's `~/.codex/auth.json` and print only `chatgpt_plan_type`. Note the value in the commit message.
- [ ] **Step 4:** Run `node tests/test_codex_login.mjs && node tests/test_logins.mjs && node tests/test_desk_q_usage_view.mjs`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(codex): name the Codex login by its account and plan`

### Task 6: View 6 rows, notes and headline for accounts

**Files:**
- Modify: `desk/bin/desk-q.mjs`: `loginLabel` (~1917), `unusable` (~1964), `loginRow`, `usageHeadline` (~1979), `usageParts` notes (~2060-2080), the key bar for the Usage tab, and the check refresh that fills `checked`
- Test: `tests/test_desk_q_usage_view.mjs`, `tests/test_desk_q_login_lines.mjs`

**Interfaces:**
- Consumes: Task 2's states, Task 3's CLI (`pin`, `migrate`), and Task 5's labels.
- Produces:
  - **Label:** `loginLabel(l)` for Claude is `l.account ?? accountOf(l).email ?? l.name`.
  - **Copy:** strings as in spec § View 6:
    - cells `◆ not signed in: desk won't use it`, `◆ on <live>: desk won't use it`, `◆ not set up: desk won't use it`
    - notes `◆ sign in`, `◆ wrong account`, `◆ not set up`
    - the footer reassurance line, and `<email> signs in for desk through <folder>.` for the selected Claude row
    - the two new headlines, with priority wrong account > not signed in > existing
    - key bar `a add an account`, plus `y copy command` when the selected row has a fix command
  - **Background writes:** after each check, desk-q runs `desk-env logins migrate` once if `needsMigration`. It runs `desk-env logins pin claude <name>` for each `pinnable` row, through the existing `loginsWith`.
  - **Remove:** the uncommitted `duplicate` branch, the `◆ one account` note and the `2 logins are signed in to …` headline.
- [ ] **Step 1: Write the failing tests** in `tests/test_desk_q_usage_view.mjs`. They replace the block `// ---- two logins on one account` and use a pinned file:
  - The frame has exactly 3 Claude rows, and none labelled `default`.
  - With `login-2`'s fake switched to another pinned email:
    - its row contains `◆ on b@x.io: desk won't use it`
    - prose contains `Desk's sign-in for a@x.io is now on b@x.io, so desk counts that account once and has stopped using this one.`
    - `f[3]` starts with `New Claude workers start on` and contains `'s sign-in was switched to another account, so desk has stopped using it.`
  - Signed out: the row contains `◆ not signed in: desk won't use it`, and prose contains `isn't signed in for desk yet. In another terminal, run CLAUDE_CONFIG_DIR=~/.claude-logins/login-2 claude, then type /login and sign in to a@x.io. Press y to copy the command.`
  - The footer has `Desk keeps its own sign-ins, so switching account in your own Claude Code changes nothing here.`
  - Pressing `y` on the wrong-account row copies `CLAUDE_CONFIG_DIR=~/.claude-logins/login-2 claude`.
  - With no file: the frame equals today's single-login AC15 line, and no reassurance line appears.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `node tests/test_desk_q_usage_view.mjs && node tests/test_desk_q_login_lines.mjs && node tests/test_desk_q_usage.mjs`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(usage): view 6 lists accounts, with wrong-account and sign-in notes`

### Task 7: Adding an account, including the first one

**Files:**
- Modify: `desk/bin/desk-q.mjs`: `startAdding` (~3502), `addChecked` (~3519), `addingRow` (~2016), `addPanel` (~2023)
- Test: `tests/test_desk_q_usage_add.mjs`

**Interfaces:**
- Consumes: Task 3's `desk-env logins pin`, Task 2's `pinnable`.
- Produces:
  - **The new row:** reads `new account`, with the cell `waiting for you to sign in…`.
  - **The panel:** title `ADD A CLAUDE ACCOUNT`, with the steps and text from spec § View 6 (Add flow) and the keys `y copy command · esc stop adding`.
  - **On sign-in:** when the folder is `pinnable`, desk runs `pin`, which also sets it to standby. When the email is already pinned, desk keeps waiting and shows `That's <email>, which desk already has. Sign this folder in to a different account, or press esc.`
  - **First add:** when `!multiAccount(subs)`, the panel shows the two-step first-add flow from spec § The first extra account. It names `claudeAccount(defaultLogin('claude')).email` and uses two folders from `nextLoginFolder`. The current account's folder is watched first, and the flow then moves on to the new account's folder.
- [ ] **Step 1: Write the failing tests**, replacing the AC3 `duplicate` checks:
  - **Pinned file:** press `a`. The panel has `ADD A CLAUDE ACCOUNT`. Sign the new folder in to `new@x.io`, and the file gains a pinned `standby` row.
  - **Already-pinned email:** sign the new folder in to an email that is already pinned. The frame shows `That's b@x.io, which desk already has.`, and no row is added.
  - **No file, `~/.claude` on `me@x.io`:** press `a`. The panel shows `sign in to me@x.io`.
    - Before the first folder is signed in, `callLogin().env` is the caller's environment.
    - After it signs in to `me@x.io`, the file is 5-column, `~/.claude` is in Removed, and the panel moves on to the new account.
  - **`esc` part-way:** the file stays parseable, with `errors.length` 0.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** Run `node tests/test_desk_q_usage_add.mjs && node tests/test_desk_q_usage_view.mjs && node tests/test_logins.mjs`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(usage): add an account, signing the current one in on the first add`
