# desk Usage: accounts, not folders

Date: 2026-11-09. Status: design approved in conversation; canvas at
https://claude.ai/artifact/8bSfhGvKq2xhhLi7Z9XuH1 (boards: Today, After: all signed in,
After: not signed in yet, After: wrong account, After: adding an account).

## Why

The user pays for three Claude subscriptions (`ben@studia.io`, `ben.lavender1@gmail.com`,
`ben.lavender@studia.io`) and wants desk to spread workers across them. View 6 (Usage) lists one row
per *login folder* (`CLAUDE_CONFIG_DIR`), labelled with whatever account that folder is signed in to
at the moment, read live.

The default login is `~/.claude`, which is also the user's own interactive Claude Code. When they run
`/login` there for their own work, desk's "default" slot silently changes account. On 2026-11-09 that
left `ben.lavender@studia.io` in two folders (default and `login-3`, shown as "the same account as
default") and `ben@studia.io` in none, so it vanished from view 6 entirely.

The user's words: "I should just be able to give it the three accounts that I use and regardless of
which one it is, it should indicate which one is signed in. There would only be those three and not a
duplication." And: "The supervisor and desk queue should … just be using where there is an available
resource."

## Goals

1. View 6 lists **accounts**: exactly one row per account desk knows, always, whatever the user's own
   Claude Code is signed in to.
2. Switching account in the user's own Claude Code **never changes desk**: no new row, no lost row, no
   worker moved.
3. Each row says whether that account is usable now and, when it isn't, exactly how to fix it, with
   the command copyable (`y`).
4. Workers (pass.mjs `pickLogin`, `callLogin`) keep choosing by available room, as today, over usable
   accounts only.
5. The Codex row is named by its account email and shows a readable plan (today: `default`,
   `self_serv`).

## Non-goals

- Reading the user's own Claude Code usage. Decided: worker readings only. The 5h/7d percentages come
  from what Anthropic reports to desk's workers, which are believed to be account-wide, so they are at
  most one read (about 5 minutes) behind. If the build shows they are per-client, stop and report;
  don't build a workaround.
- Reserving an account for the user's own use.
- Changing how rotation ranks logins (rotation before standby, most room, lower weekly use, fewest
  running: login-choice.mjs).
- Multiple Codex accounts. Codex keeps one login; only its name and plan change.

## Anti-goals (would be a failure even if it "works")

- Any path where desk follows the account of `~/.claude` once the user has more than one account.
- An account appearing twice, or a known account disappearing from view 6.
- Breaking a single-login user: someone with only `~/.claude` and no subscriptions file must see no
  change and need no setup.
- Desk using or copying Codex sign-in tokens.

## The model

### Account pinning

- The subscriptions file (`subscriptions.md`, logins.mjs:76-147) gains an **Account** column for Claude
  rows: the account email the folder belongs to, lowercased. Table becomes
  `| Tool | Name | Folder | Account | Rule |`. The parser must still read files without the column.
- A folder's account is pinned the first time desk sees it signed in (the add flow, or migration
  below). After that the pinned email is the row's identity and label; the live email is only compared
  with it.
- Live email still comes from `checkLogin` (`claude auth status --json`, falling back to
  `.claude.json`). New per-row states, replacing today's `duplicate`:
  - **signed in**: live email equals the pin. Usable.
  - **not signed in**: the folder is signed out (today's `signed out`). Not usable.
  - **wrong account**: signed in, but to a different email. Not usable. The row keeps its pinned label.
    Its readings are not shown (they'd belong to the other account).
- An account is shown once. If two folders are pinned to the same email (possible only by hand-editing),
  the first in file order is the account's folder and the rest are reported as an error in the footer;
  the add flow refuses to create that case.
- Rules (`in rotation` / `standby` / `off`) stay per row and survive sign-out and wrong-account: a row
  that becomes usable again goes straight back into its rule.

### Desk stops using `~/.claude` (multi-account only)

- Once the subscriptions file exists with an Account column, desk never starts a Claude worker or a
  pass model call on `~/.claude` (no more `configDir: null` / `AUTOPILOT_LOGIN_DIR=''` for Claude).
  Every account has its own folder under `~/.claude-logins/`.
- With no subscriptions file (single-login users), behaviour is unchanged: one default login on
  `~/.claude`, no Account column, no new copy.
- Resumed sessions stay on the folder they started on (pass.mjs:227-228), as today.
- **No room anywhere means wait** (decided by the user). When no account is usable, or every usable
  one is at its limit, desk starts no worker and runs no pass model call on `~/.claude`. Today's
  fallbacks to the caller's own environment go for Claude in multi-account mode: `callLogin`'s
  `keep`/`all`/no-choice cases (call-login.mjs:84-91), and `OWN_LOGIN` as the held-batch probe default
  (pass.mjs:239). Triage and epic planning are deferred to the next pass that has room, not run on
  `~/.claude`. The usage probe runs per account folder, never on `~/.claude`. The existing "every
  login at its limit" headline and Home `▲ usage` note say when the first account is back.

### The first extra account (single → multi-account)

Decided by the user: sign in both in one flow. The first time a no-file (or single-account-file) user
presses `a`, the add panel asks for two sign-ins, each in a new folder under `~/.claude-logins/`:

1. Their current account, named by the email `~/.claude` is on now:
   `1 In another terminal, run CLAUDE_CONFIG_DIR=~/.claude-logins/login-1 claude, then type /login and sign in to <current email>.`
2. The new account, as in the normal add flow.

Until the first of these is signed in and pinned, desk keeps working exactly as before on `~/.claude`.
Multi-account mode (Account column written, `~/.claude` no longer used for Claude) starts when the
current account's folder is pinned; the new account joins on standby when its sign-in is seen. `esc`
part-way leaves whatever has been pinned so far, and the file stays valid.

### Migration of an existing multi-login file

On the first read by the new version of a file without an Account column:

1. Each listed or found folder under `~/.claude-logins/` that is signed in is pinned to its current
   email, keeping its rule.
2. The `~/.claude` row is removed from rotation (moved to `## Removed`). If its current account is not
   pinned to any other folder, desk shows an "add this account" hint in the footer naming that email
   and the `a` key, rather than inventing a row with no folder.
3. Two folders on the same email: the first in file order is pinned; the other is left unpinned and
   shown with the add-flow refusal copy, so the user can sign it in to another account.

Migration runs only when the file lists, or desk finds, at least one Claude folder under
`~/.claude-logins/`. A file that exists only for Codex rules or to set a rule on `~/.claude` is a
single-account file and is left alone. (Builder call, settled in review.)

**Unpinned folders and who writes pins** (builder call, settled in review):

- Only interactive paths write the file: desk-q (view 6) and `desk-env logins …`. Background passes,
  `call-login.mjs` and the probe only read it, and treat an unpinned folder as unusable. No new locking.
- desk-q pins a signed-in, unlisted folder under `~/.claude-logins/` automatically the first time it
  sees it, unless its email is already pinned elsewhere (as `a` would, on standby).
- A folder that can't be pinned (signed out at migration, or a second folder on a pinned account) gets
  a row labelled by its folder name, cell `◆ not set up: desk won't use it`, and a note with the
  sign-in command, so the user can sign it in to an account desk doesn't have yet, or remove it with `x`.

For this user, today that gives: `login-2` → `ben.lavender1@gmail.com`, `login-3` →
`ben.lavender@studia.io`, and `ben@studia.io` added once with `a` (new folder `login-4`).

## View 6, as drawn on the canvas

Terminal colours and widths unchanged from today (desk-q.mjs Usage table: name, PLAN, RULE, 5H, 7D,
WORKERS). The table heading stays `CLAUDE`, matching `CODEX`.

- **Row label**: the pinned email. The folder appears only in a footer line for the selected row:
  `ben@studia.io signs in for desk through ~/.claude-logins/login-4.`
- **Footer reassurance line** (always, when multi-account):
  `Desk keeps its own sign-ins, so switching account in your own Claude Code changes nothing here.`
- **Not signed in**: plan `—`, the window cells merged into
  `◆ not signed in: desk won't use it`, workers 0. Note:
  `◆ sign in  <email> isn't signed in for desk yet. In another terminal, run CLAUDE_CONFIG_DIR=<folder> claude, then type /login and sign in to <email>. Press y to copy the command.`
  Headline: `New Claude workers start on <best>. <email> isn't signed in yet, so desk can't use it.`
- **Wrong account**: plan `—`, cell `◆ on <live email>: desk won't use it`. Note:
  `◆ wrong account  Desk's sign-in for <pinned> is now on <live>, so desk counts that account once and has stopped using this one. To switch it back, run CLAUDE_CONFIG_DIR=<folder> claude in another terminal, then type /login and sign in to <pinned>. Press y to copy the command.`
  Headline: `New Claude workers start on <best>. <pinned>'s sign-in was switched to another account, so desk has stopped using it.`
- **Headline priority** when several things are wrong: wrong account, then not signed in, then the
  existing limit/rotation headlines. Headlines wrap whole and keep a reset time on one line (already in
  the uncommitted work).
- **Key bar**: `a add an account` (was "add a login"); `y copy command` appears when the selected row
  has a fix command.
- **Add flow (`a`)**: a `new account` row reading `waiting for you to sign in…` and the panel
  `ADD A CLAUDE ACCOUNT` / `1 In another terminal, run CLAUDE_CONFIG_DIR=<next folder> claude` /
  `2 Type /login and sign in to the account you want to add.` /
  `Desk adds the account on standby as soon as it sees you're signed in. An account that's already listed isn't added twice: desk asks you to sign in to a different one.`
  Keys: `y copy command · esc stop adding`. On sign-in the folder is pinned to the live email and set
  to standby (as today, desk-q.mjs:3519-3533). If the email is already pinned elsewhere, keep waiting
  and say `That's <email>, which desk already has. Sign this folder in to a different account, or press esc.`

The Queue view's footer and Home's `▲ usage` note name accounts by pinned email (uncommitted
`loginLabel` work already does this for the live email).

## Codex name and plan

- Read `~/.codex/auth.json` (or the login's `CODEX_HOME`), take `tokens.id_token`, base64url-decode
  **only the JWT payload**, and read `email` and the `https://api.openai.com/auth` claim's
  `chatgpt_plan_type`. No signature check, no network, and never read, log or copy the access or
  refresh tokens. This reverses the deliberate "never read auth.json" rule in codex-usage.mjs:7-8;
  update that comment to say exactly what is read and why.
- Label: the email (falling back to the desk-label, then the folder name, as today). Plan: the plan
  type title-cased (`pro` → `Pro`); unknown or missing → `—`. Never show the session-log
  `rate_limits.plan_type` value (`self_serve`) as a plan.
- Confirm during the build what `chatgpt_plan_type` holds on this machine before choosing the
  display mapping.

## Relation to the uncommitted work on `main`

`desk/bin/desk-q.mjs` and three tests carry unshipped changes (account labels on the Claude line and
Home note, headline wrapping, a `duplicate` row/headline/note). Keep the labels and wrapping. The
`duplicate` copy (`◆ same account as above`, `2 logins are signed in to …`, the `◆ one account` note)
is superseded by the wrong-account state and goes.

## Left to the builder

- Where pinning lives in code (logins.mjs is the natural home) and the exact state names.
- How long a wrong-account or signed-out row's old readings are kept on disk; they must not be shown.
- Test shape, following the existing `tests/test_desk_q_*` and logins tests, including a single-login
  no-file test proving no change.
- Splitting into PRs (suggested: pinning + migration + rotation, then view 6 copy, then Codex).
