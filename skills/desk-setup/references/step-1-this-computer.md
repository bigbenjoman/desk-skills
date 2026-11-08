# desk-setup step 1: this computer

Read during step 1, once the detection rounds are done: the machine profile, the bench's cap and
reserve, and how the §3b rows fall back to it. The step table in `../SKILL.md` names this file for it.

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
  - **No profile** (the user declined it): still ask both in the same carousel, with the same
    Recommended answers, and say the answers are kept in the profile, so storing them means writing
    it. Offer the profile again with the `desk-env machine propose` table already shown: on a yes,
    `desk-env machine write`, then `desk-env machine set` with their answers. On a second no, write
    nothing, since `machine set` refuses without a profile, and say the bench will use 10 points and
    a 25% reserve until a profile exists.
- **Then §3b.** The repo rows for worker concurrency, memory ceiling and test worker cap fall back to
  the profile when they are `TODO` or absent, and a set repo row wins. With a profile, the
  Recommended answer for each is the profile's value; say that writing `TODO` instead makes the row
  follow the profile, including after a re-proposal.
- `desk-env machine get <key>` reads a value and `desk-env machine why <key>` its reason.
