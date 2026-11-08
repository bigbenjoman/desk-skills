# desk-setup step 1: this computer

Read during step 1, once the detection rounds are done: the machine profile, the bench's cap and
reserve, how the §3b rows fall back to it, and the subscription rules. The step table in
`../SKILL.md` names this file for it.

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

Which Claude and Codex logins new workers rotate between is a rule for the computer, not the repo:
`~/.config/desk/subscriptions.md` is shared by every repo here and asked once. Run `desk-env logins
check`. It signs nothing in and reads no credential. It lists each tool's default login, every login
the file names and every signed-in folder it finds under `~/.claude-logins` and `~/.codex-logins`,
with its folder, state and rule, plus each Claude login's account and plan. Its first line says
whether the file exists. A folder under either of those that the check leaves out is not signed in:
`ls` both, and list each such folder as signed out.

- **Rules already saved** (the file exists): open with "Subscriptions on this computer: already set,
  so nothing to ask". Show each login with its rule (`● in rotation`, `○ standby` or `off`), as an
  email for a Claude login and as its name for a Codex login. Then say "This repo uses the same rules as
  every other repo on this computer. To change them, open desk-q and press 6." Ask nothing, and write
  nothing.
- **No rules yet** (no file): say "I found <n> Claude logins and <m> Codex logins signed in here",
  then list each login: a Claude login by its email, plan and folder, and a Codex login by its name
  and folder (desk reads no Codex account). Then say in one line that desk can spread workers across
  them, so a batch keeps running when one reaches its limit, that these rules are for this computer
  and every repo here shares them, and that desk-q view 6 changes them at any time.
- **A login that is not signed in is listed but left out of every question.** For a signed-out
  login, mark it `signed out` and give the sign-in command from the check's note, or, for a folder
  the check left out, `CLAUDE_CONFIG_DIR=<folder> claude, then /login` (Codex:
  `CODEX_HOME=<folder> codex login`). For a refused
  login (the same account as another), mark it refused and name that other login. For a login the
  check could not run, mark it `not checked` with the reason. Desk writes no rule for any of these
  logins.
- **Fewer than two signed-in logins of a tool: no question for that tool.** With one Claude login and
  one Codex login, ask nothing and write nothing: desk uses them as it does today.
- **Two or more signed-in Claude logins**: one question, "Which Claude logins should new workers
  rotate between?", with these options:
  1. `All <n> in rotation (Recommended)`: "Each worker starts on whichever login has the most room.
     The most work before any limit."
  2. `Choose which rotate, the rest on standby`: "For logins you want kept back, for example a work
     account. Standby logins are used only when every login in rotation is at its limit."
  3. `Only <the default login's email>, as today`: "No rotation. Workers start on this login, and
     the others are used only when it reaches its limit." It saves the default login in rotation and
     every other signed-in login on standby. The default login is the one named `default`
     (`~/.claude`). Leave this option out when that login is not signed in.

  Choosing which rotate asks a second question, with multiple answers allowed: one option per
  login, its email as the label and its plan and folder as the description. Every login left
  unticked goes on standby, and an answer that ticks none is asked again: at least one login stays
  in rotation. **More than four logins**: the question shows four options at most, so list the logins,
  numbered, in your reply and ask the user to name the ones to rotate. An answer typed instead of
  an option is read the same way.
- **Then Codex, with two or more signed-in Codex logins**: once the Claude question is answered
  (or straight away when there was none), ask the same question with each Codex login's name in
  place of an email: "Which Codex logins should new workers rotate between?"
- **Saving**: for every signed-in login the question covered, run `desk-env logins set <claude|codex>
  <name> <in rotation|standby>`. The first call writes the file. Each call keeps the last copy as
  `subscriptions.md.bak`. Then show `desk-env logins list` and say that desk-q view 6 changes it.
