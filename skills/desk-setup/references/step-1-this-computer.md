# desk-setup step 1: this computer

Read during step 1, once the detection rounds are done: the machine profile, and how the §3b rows
fall back to it. The step table in `../SKILL.md` names this file for it.

### This computer

Desk runs on one computer, and what local work it can carry depends on that computer, not the repo.
The machine profile, `~/.config/desk/machine.md`, records both and is shared by every repo.

- **No profile yet**: show the `desk-env machine detect` table, then `desk-env machine propose`,
  whose third column is the arithmetic behind each size. Say in one line what the rules are (a local
  CI runner needs at least 32 GB, 8 CPU cores and 100 GB free, and is off by default on every
  computer, battery or mains, because its memory comes off what autopilot can use; the runner VM
  takes at most 3/8 of memory and 2/3 of the cores; a slot is 2 CPUs and 7 GB, GitHub's hosted runner for private repos, with 2 GB of the VM kept back; autopilot workers at
  ~3 GB each from what the runner leaves; test workers capped at the performance cores). **Write
  nothing until the user confirms**; then `desk-env machine write`. On a computer that meets the
  minimum, say the runner is off and that opting in is `propose --runner` to see its sizes and
  `write --runner` to write them; a profile written that way keeps the runner on through later
  proposals. Any other size they want different is a hand edit to that file afterwards, said as
  such.
- **A profile exists**: `desk-env machine detect` says what changed since it was written. Nothing
  changed: say so and move on. Something changed (another computer, more memory, the disk filling
  up): show the changes and offer to re-propose; on a yes, the same propose, confirm, write.
- **Then §3b.** The repo rows for worker concurrency, memory ceiling and test worker cap fall back to
  the profile when they are `TODO` or absent, and a set repo row wins. With a profile, the
  Recommended answer for each is the profile's value; say that writing `TODO` instead makes the row
  follow the profile, including after a re-proposal.
- `desk-env machine get <key>` reads a value and `desk-env machine why <key>` its reason;
  `runner-possible` is what the runner tooling refuses on.
