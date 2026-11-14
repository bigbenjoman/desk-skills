# desk-setup step 1: this computer

Read during step 1, once the detection rounds are done: the machine profile, the bench's cap and
reserve, how the §3b rows fall back to it, this computer's subscriptions, and which one runs this
repo. The step table in `../SKILL.md` names this file for it.

### This computer

Desk runs on one computer, and what local work it can carry depends on that computer, not the repo.
The machine profile, `~/.config/desk/machine.md`, records both and is shared by every repo.

- **No profile yet**: show the `desk-env machine detect` table, then `desk-env machine propose`,
  whose third column is the arithmetic behind each size. Say in one line what the rules are (memory
  less 8 GB for the OS is the ceiling; autopilot workers at ~3 GB each from it; test workers capped
  at the performance cores). **Write nothing until the user confirms**; then `desk-env machine
  write`. Any size they want different is a hand edit to that file afterwards, said as such. A
  re-write keeps the bench rows below.
- **A profile exists**: `desk-env machine detect` says what changed since it was written. Nothing
  changed: say so and move on. Something changed (another computer, more memory, the disk filling
  up): show the changes and offer to re-propose; on a yes, the same propose, confirm, write.
- **Then the bench's quota, once per computer.** One weekly allowance covers every repo on the
  computer, so the bench's limits live in the profile: `bench-cap-points`, the points of each weekly
  allowance the bench may spend, and `bench-reserve-percent`, the share it leaves for interactive
  work. Read both with `desk-env machine get`.
  - **Both set**: show them in one line, say they can be changed, and ask nothing unless the user
    says they want to change them; then ask as below.
  - **Either unset**: ask both in one carousel, the bench cap in points of weekly allowance with
    `10` as the Recommended answer, and the interactive reserve as a percentage with `25`; say that
    unset, the bench runs on those same figures without anyone having chosen them. Store the answers
    with `desk-env machine set bench-cap-points=<cap> bench-reserve-percent=<reserve>`, which checks
    both before writing either. An answer that is not a number exits 1 naming the bad value and
    writes nothing: say which value was refused and ask again. The bench prints the stored values
    in its `quota:` line at its next start.
  - **No profile** (the user declined the proposed sizes): ask and store both just as above. With no
    profile, `machine set` starts one holding only these two rows, with no hardware and no sizes, so
    the declined proposal is not written; say so in one line. `machine detect` then reports no sizes
    proposed: treat that profile as **No profile yet** above on the next run, and a `machine write`
    keeps the two rows.
- **Then §3b.** The repo rows for worker concurrency, memory ceiling and test worker cap fall back to
  the profile when they are `TODO` or absent, and a set repo row wins. With a profile, the
  Recommended answer for each is the profile's value; say that writing `TODO` instead makes the row
  follow the profile, including after a re-proposal.
- `desk-env machine get <key>` reads a value and `desk-env machine why <key>` its reason.

### Subscriptions on this computer

Each tool's default subscription is a fact of the computer, not the repo:
`~/.config/desk/subscriptions.md` is shared by every repo here, and the default is chosen in desk-q
view 6, never in setup. So this step asks nothing; it says what desk will run on. Run `desk-env logins
check`. It signs nothing in and reads no credential. It lists each tool's default login, every login
the file names and every signed-in folder it finds under `~/.claude-logins` and `~/.codex-logins`,
with its folder and state, plus each Claude login's account and plan. Its first line says whether
the file exists. A folder under either of those that the check leaves out is not signed in: `ls`
both, and list each such folder as signed out.

- **A subscriptions file** (the file exists): open with "Subscriptions on this computer: already
  set, so nothing to ask". Show each login as `desk-env logins list` names it (`default`, `unused`
  or `off`), as an email for a Claude login and as its name for a Codex login. Then say "To change the
  default, open desk-q and press 6." Ask nothing.
- **No file, two or more signed-in logins of a tool**: say "I found <n> Claude logins and <m> Codex
  logins signed in here". Name each such tool's default first: the login named `default`, the
  account `~/.claude` is signed in to (a Codex default is `~/.codex`, by its name). Then list each
  other signed-in login as `unused`: a Claude login by its email, plan and folder, and a Codex login
  by its name and folder (desk reads no Codex account). Say in one line that desk runs every repo's
  work on the default unless the repo is pinned to another (*This repo's subscription*, below), never
  switches on its own, and that desk-q view 6 changes the default for every repo here. Ask nothing,
  and write nothing.
- **Fewer than two signed-in logins of a tool**: name the one desk uses, and ask nothing.
- **A login that is not signed in is listed, and is never a default or a pin here.** For a signed-out
  login, mark it `signed out` and give the sign-in command from the check's note, or, for a folder
  the check left out, `CLAUDE_CONFIG_DIR=<folder> claude, then /login` (Codex:
  `CODEX_HOME=<folder> codex login`). For a refused login (the same account as another), mark it
  refused and name that other login. For a login the check could not run, mark it `not checked`
  with the reason.

### This repo's subscription

Which subscription runs this repo is the repo's own choice, its config §3b `Subscription` row:
`default`, which follows this computer's Claude default wherever view 6 moves it, or the email of one
subscription, which pins the repo to it. It is asked here, once per repo, and never in the §3b
rounds. A subscription is a Claude login the check above found signed in, and not refused or `off`.

- **The row is already set** (`default` included): ask nothing. Run `desk-env subscription` and say
  which subscription this repo runs on, its `SUBSCRIPTION` email, following this computer's default
  (`SOURCE` `default`) or pinned to it (`SOURCE` `row`), and that desk-q view 6 changes it. Where it
  exits naming an email that is not one of this computer's subscriptions, say so in its words: the
  repo runs on nothing until that account is signed in or view 6 moves the repo.
- **One subscription, no row**: ask nothing, and save `default`. Say "This repo follows this
  computer's default, <its email>. desk-q view 6 changes it."
- **Two or more subscriptions, no row**: ask one question, "Which subscription runs <repo name>?",
  with "Workers, triage and the decider for this repo all use it. Change it later in desk-q, view 6."
  as the text above the options, and these options, in this order:
  1. `Use this computer's default` (Recommended), described as `<the default's email> · follows
     changes`. The default's email is the `SUBSCRIPTION` `desk-env subscription` prints while the row
     is unset.
  2. `Pin to <email>`, one per subscription in the check's order, described as `<plan> · 7d <n>%`:
     the plan from the check's `PLAN` column, and `<n>` the login's 7-day use, rounded, from `node
     ~/.claude/desk/bin/usage-probe.mjs readings`. A login with no 7-day reading there is described
     as `<plan> · 7d no reading`.

  Below the options, say "Pin a repo when its work belongs to that account: Studia repos on the
  Studia seat, client repos on the client's account. Leave the rest on the default." Then "Saves one
  row to `<CONFIG>`" and the row the Recommended answer saves, `| Subscription | default |`.
- **More than three subscriptions**: the question shows four options at most, so ask it in your
  reply instead of as a question carousel: the question, the line above the options, then every
  choice numbered from 1 in the order above, each with its description, `(Recommended)` after the
  first, then the lines below the options. A number typed as the answer is that choice, and an email
  typed (any case) is the pin to it. An answer typed instead of an option in the carousel is read the
  same way. Anything else is asked again.
- **Saving**: `Use this computer's default` saves `default`, and `Pin to <email>` saves that email,
  so the config holds `| Subscription | default |` or `| Subscription | <email> |`. On a re-run,
  where this repo's config is already written, save it now with `desk-env subscription set <SLUG>
  <default|email>` (`SLUG` from `desk-env where`), which refuses an email that is not one of this
  computer's subscriptions and leaves the config unchanged. Otherwise it is the §3b `Subscription`
  row's value when step 5 writes the config.
