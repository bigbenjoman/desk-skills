# desk-autopilot: sharing the machine

Part of desk-autopilot, read at Stage 0 before `init`, and for Stage 0b's handshake. It binds exactly
as the core `SKILL.md` does. Where it says "above" or "below" of something this file does not hold,
or cites a section in *italics* it does not hold, that is in the core or in the file the core's
reference table names.

## Sharing the machine

**Name this session for its role**, so the user's terminals and a peer's `SendMessage` tell it
apart. `<repo>` is the name part of §0 GitHub repo: a batch session is `<repo>-batch` (an epic run
beside the standing batch, `<repo>-batch-<EPIC>`), a single-ticket session `<repo>-ticket-<KEY>`, and
a session that hands work to other sessions and merges theirs `<repo>-orchestrator`. The name stays
when the batch gains tickets. Only the user can run `/rename`, so at Stage 0 print the line
(`/rename <repo>-batch`, with this repo's name in place of `<repo>`) once and carry on. Workers are named at spawn, and a handoff records
the name so `/desk-resume` gives it back after `/clear`.

Assume you are never alone: the user runs interactive sessions alongside you and often a second
batch, possibly in another repo, so coordinate, and do not run out of memory on spikes such as test
runs or the PR image upload. Batch state is per repo; these four resources are machine-wide, and
each has cost a run.

**Handshake at Stage 0b, before any worker spawns.** `ListAgents`, then one `SendMessage` per live
session stating your repo and batch, worktrees, port range, the files your tickets touch, and your
test-lock and test-worker cap, and asking the same four back. Re-send when a new session appears.
What a peer says it holds beats anything you can measure, and a peer's heads-up ("full suite in five
minutes") is the only warning before a 10GB spike.

**Lease your port range at Stage 0b, before any worker spawns**, by the port lease kind's mode
(`desk-env lease mode port`):

- **`shadow` or `on`**: lease the range for your own Claude session with
  `~/.claude/desk/bin/port-lease.mjs range <from>-<to>` (with `--batch <EPIC>` for an epic batch, so
  the lease carries your batch's name), and publish it at the handshake too. Run the
  same command again at each handshake and at least every 30 minutes while the batch runs: it renews
  the ports you hold and leases any your workers have given back. A lease nobody renews lapses at
  twice its one-hour TTL, and every lease you hold lapses when your session exits. Your own pass
  gives your workers ports from that range, handing each worker the port's lease; every other pass
  skips it.
- **`off`**: publish your range at the handshake as before, and take no lease.

| Resource | Protocol |
|---|---|
| **Test suites** | One at a time machine-wide, via `~/.claude/desk/bin/with-lock.sh test --cwd <dir> -- <cmd>` (unit, integration, E2E; `<dir>` and `<cmd>` from `desk-env cmds test-cmd`) and `with-lock.sh tsc --cwd <dir> -- <cmd>` (same lock). No timeout, no bypass; waiting is the feature. Two database-backed integration runs also collide on their per-worker schemas for the whole run, so announce integration runs to peers. |
| **GitHub PR image upload** | One signed-in browser profile (config §2), so it is exclusive. Every pass in every repo uploads through the machine's one upload queue (`desk/bin/upload-queue.mjs`, `~/.claude/desk/upload-queue.json`), which runs one upload at a time, takes repos in turn, keeps to about 6 images a minute and 300 an hour from the upload log, and stops every repo's uploads for one stall's back-off. An upload run by hand is outside it: claim the profile from peer sessions by message before `upload-images.mjs` runs and release it by message immediately after. Screenshot *capture* uses Playwright's own browser and `with-lock.sh browser`, and is safely concurrent: do not serialise the wrong one. Never delete the profile's `SingletonLock`. |
| **Ports** | Yours start above the user's dev port. Publish your range, and lease it as above. With the port lease kind on, no pass gives a worker a port another session leases; in shadow, the lease log records each such pick as a would-refuse. A peer that runs no autopilot batch (an interactive session, a server run by hand) has its range recorded as claimed: `~/.claude/desk/bin/port-claims.mjs claim <from>-<to> --by '<the peer>'`, which every pass skips even while its server is down; claim it again at each handshake and at least every 12 hours while it is live (a claim lapses after 12), and `release --by` when it says it is done. Never record another batch's range: its workers' ports are already skipped, and its published range is the one its own pass uses. Never kill a server you did not start however idle it looks. |
| **Files** | Exchange diff surfaces at handshake. `plan-batch` finds collisions inside your batch only; the cross-batch one can only come from the peer. |

**Probe the lock, do not trust it.** Test it once at Stage 0 with
`~/.claude/desk/bin/with-lock.sh test true`. If workers report it refused, serialise Stage 4
yourself (one worker in a suite at a time) and say in the report that the lock is not covering them.

**The memory rules are seeded, not remembered.** `queue.mjs init` backs up
`<state>/batch-notes.md`, resets it, and re-seeds `references/batch-notes-header.md`, so the test
cap and the lock survive an init. If another orchestrator is live, `init` keeps the file instead of
resetting it, because that batch's workers still read it. Check the `## MEMORY` heading is there
after `init`; if it is not, add `references/batch-notes-header.md` to the end of the file with the
Edit tool (Write if the file is missing), not a shell redirect. The rules also live in the worker
contract, which is never truncated.
