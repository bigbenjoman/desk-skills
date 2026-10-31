# desk-autopilot: commands

Part of desk-autopilot, read whenever you need a command's exact form. It binds exactly as the core
`SKILL.md` does. Where it cites a section this file does not hold, that is in the core or in the file
the core's reference table names.

## Commands

```bash
# Written exactly as the harness rules name them (permission-rows.md), so they match without a
# prompt: `node ~/.claude/desk/bin/<x>.mjs`, `~/.claude/desk/bin/<x>.sh`, `desk-env`. Never via a
# shell variable such as $B: no allow rule matches a variable path. <state> is DESK_STATE from
# `desk-env paths`, written out in full.
node ~/.claude/desk/bin/batch.mjs start ABC-900 feat/ABC-900-<slug> --batch ABC-900   # an epic's own feature batch beside the standing one; refused while another is live on its branch
node ~/.claude/desk/bin/batch.mjs discard ABC-900 --batch ABC-900    # its plan declined: removes the batch, and its branch when main has all of it
node ~/.claude/desk/bin/expand-parent.mjs ABC-900 --batch ABC-900     # an epic -> its batch keys (stdout), drops on stderr
~/.claude/desk/bin/triage.sh ABC-123                                  # read-only, no worktree
AUTOPILOT_WRITE_QUEUE=1 node ~/.claude/desk/bin/plan-batch.mjs --json ABC-GATE ABC-123 ABC-124   # gates first: arg order = spawn order
node ~/.claude/desk/bin/answer.mjs ABC-123 "<answer>"
node ~/.claude/desk/bin/pass.mjs --json                               # one pass; drive with /loop unless the supervisor runs passes; exit 0 go on, 10 nothing yet, 11 show the person
node ~/.claude/desk/bin/queue.mjs next-pass +1500                     # after scheduling the next pass: when it runs (here 25 minutes), so desk-q counts the batch live until then
node ~/.claude/desk/bin/supervisor.mjs install                        # passes and the merge driver from launchd, at login and every 3 minutes
node ~/.claude/desk/bin/supervisor.mjs status                         # exit 0 while installed and loaded; uninstall removes it
node ~/.claude/desk/bin/run-by.mjs stage4                             # Stage 4: who runs the batch (§3b Batches run by); installs the supervisor at supervisor; exit 11 an install failed
node ~/.claude/desk/bin/queue.mjs set-batch supervised=true approved.workers=true   # Stage 4 with the supervisor: only the approvals the user gave
node ~/.claude/desk/bin/queue.mjs set-batch approved.undraft=true     # Stage 3: §3 pr-ready is ask and the user approved undrafting this batch's clean PRs
node ~/.claude/desk/bin/queue.mjs set-batch approved.merge=true       # Stage 3: §3 autopilot-merge / pr-merge-green are ask and the user approved merging this batch's green PRs (=false when declined)
node ~/.claude/desk/bin/desk-env.mjs merge-grant                      # config, batch or none, and why: whether the merge driver may merge this batch
node ~/.claude/desk/bin/queue.mjs render                              # status
node ~/.claude/desk/bin/queue.mjs front ABC-123                       # move a released ticket to the front of the spawn order (one the user placed stays put)
node ~/.claude/desk/bin/queue.mjs move ABC-123 2                      # the user's order: position among unfinished tickets, or `last`; marks it placed
node ~/.claude/desk/bin/queue.mjs hold ABC-124 ABC-123               # hold a ticket behind a blocker (recorded; released on its merge)
node ~/.claude/desk/bin/queue.mjs admit ABC-125                      # add one triaged ticket mid-batch (never re-run plan-batch to do it)
node ~/.claude/desk/bin/intake.mjs run --force                        # standing intake now (§3b Intake query); the supervisor runs it every 15 minutes
node ~/.claude/desk/bin/intake.mjs admit ABC-128 --by ben --front     # /desk-admit: intake's checks on named tickets, into the supervisor's batch; exit 11 refused
node ~/.claude/desk/bin/intake.mjs forget ABC-127                     # a ticket intake handed to the digest, once fixed: the next intake tries it again
node ~/.claude/desk/bin/spine-review.mjs brief ABC-126                # the read-only reviewer's prompt for a spine awaiting approval
node ~/.claude/desk/bin/spine-review.mjs questions ABC-126 <reply>    # one approval question per spec, with the review's findings
node ~/.claude/desk/bin/queue.mjs approve ABC-126                     # the person approved a feature spine's specs: done, undrafted, merges
node ~/.claude/desk/bin/queue.mjs reject ABC-126 "<note>"             # the person sent the spine's specs back: requeued with the note
node ~/.claude/desk/bin/harvest.mjs <state>/logs/ABC-123.log
AUTOPILOT_DRY_RUN=1 …                                                 # no push, no PR, no review post, no Jira writes
AUTOPILOT_USER_APPROVED=1 node ~/.claude/desk/bin/pass.mjs            # only when §3 autopilot-workers is `ask` and the user confirmed this batch
AUTOPILOT_BASE_PUSH_APPROVED=1 node ~/.claude/desk/bin/pass.mjs       # only when §3 batch-base-push is `ask`/unset and the user approved syncing this batch's base
AUTOPILOT_ALLOW_NO_CODEX=1 node ~/.claude/desk/bin/pass.mjs           # codex-review is yes but codex is not installed: accept same-vendor reviews knowingly
nohup ~/.claude/desk/bin/merge-driver.sh --tickets "ABC-1 ABC-2" --deps "ABC-2:ABC-1" --log &   # output to <state>/merge-driver.log; not for a batch handed to the supervisor

AUTOPILOT_DEFAULT_TOOLS=1 node ~/.claude/desk/bin/pass.mjs            # workers, preflights and triage get Claude Code's default tool list, not worker-tools.mjs's

# config
desk-env where                   # which repo, which config, does it exist
desk-env ids                     # every §3 key and config row the scripts read, and its value
desk-env perm codex-review       # one permission: yes|ask|no|never|stop (missing/TODO -> no)
desk-env budget worker           # 25 | none; exit 4 if malformed

# resource management
desk-env mem status              # vmmem= avail= rss=
desk-env heavy                   # suites, typechecks, dev servers actually running (never pgrep -f)
~/.claude/desk/bin/with-lock.sh test true   # probe the lock once
# no `## MEMORY` heading in <state>/batch-notes.md: Read references/batch-notes-header.md and add it
# to the end of batch-notes.md with the Edit tool (the Write tool if the file is missing), never a
# shell redirect, which writes outside the working directory and prompts every time

# the two Monitors, started once at Stage 0b (change-only; the second fires on sustained only)
node ~/.claude/desk/bin/queue.mjs watch   # table + memory line at start, then only on a state or question change, not a stage step (--stages adds them; quiet: one line per changed ticket); every 90s, or --interval <s>
desk-env mem watch               # SUSTAINED-HIGH: avail=<x>G below <band>G for 5m with nothing heavy running

# waiting on one PR, under Monitor: one line, then exit (never a loop around gh pr checks / gh pr view)
node ~/.claude/desk/bin/pr-watch.mjs checks 123          # every check done: "none failed", or each failed check named
node ~/.claude/desk/bin/pr-watch.mjs head 123 <sha>      # the head moved off <sha>: the new sha
node ~/.claude/desk/bin/pr-watch.mjs merged 123          # merged or closed; every 60s, or --interval <s>

# apply the ladder — top-level field (a lowering leaves concurrency_by as it is)
node ~/.claude/desk/bin/queue.mjs set-batch concurrency=1
# a count the user asked for (0 pauses new spawns)
node ~/.claude/desk/bin/queue.mjs set-batch concurrency=4 concurrency_by=user
```

The keys above can be any of the three kinds: a tracker key, an §4 Other work id patterns id, or (Tracker `none`) `issue-<n>` or the slug stated at Stage 2.

For an epic's batch, every command above takes `--batch <EPIC>` (*An epic as a batch*); without it
a command acts on the standing batch.

`pass.mjs` re-reads `concurrency` from the queue on every pass, so the ladder is applied by editing
that one field between passes: never by hand-spawning, and never by holding tickets out of the batch.
