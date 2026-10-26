# desk-pr: the PR-description checks, opening the PR, and editing its body later

Read before `gh pr create` or `gh pr edit`: for the PR-description checks, the title, opening the
draft, undrafting and merging, and editing the body once the PR is open. The step table in
`../SKILL.md` names this file for those steps. The config, the diff hygiene block (§1) and the start
of §4, the pre-push checks, are in `../SKILL.md`, already loaded; the body itself is in
`the-body.md`, beside this file, and the screenshots in `screenshots.md`.

### Before `gh pr create` or `gh pr edit`: the PR-description checks

Where `desk-env cmds pr-description-checks` prints items, CI checks the PR's description, and a
body that fails is a red check on the first run. Write the body to its file first, then run each
item in its directory with the file's absolute path appended:

```bash
<cmd> <absolute path to the body file>                                          # an item at the root
~/.claude/desk/bin/with-lock.sh nolock --cwd <DIR> -- <cmd> <absolute path>    # an item with a directory
```

Run it on **every** body you are about to hand to `gh pr create` or `gh pr edit --body-file`, not
only the first one.

- **It passes**: create or edit.
- **It fails on something the body owns** (a missing section, a heading, the ticket reference, an
  unticked box the template asks for): fix the body, re-run, then create or edit.
- **A fix would need content you do not have** (a value you would be inventing, a sign-off someone
  else gives) **or the failure is not about the body**: stop and report the output. Do not open or
  edit the PR with a body you know fails.

The image upload script's own edit only swaps `_drag <file>_` cells for images in a body you already
checked, so it is not run through the checks again.

### Open it

```bash
gh pr create --repo <§0 GitHub repo> --draft --base <default> --head <your branch> \
  --body-file <path> --title "<title in the §5 PR title format>"
```

Gated on config §3 `pr-open`. Always pass `--repo`, `--head` and `--title` explicitly, and keep
`--repo <§0 GitHub repo> --draft` first, in that order: an autopilot worker's allow rule matches only
a command beginning `gh pr create --draft` or `gh pr create --repo <§0 GitHub repo> --draft`, and the
same form keeps interactive and worker PRs identical. `--repo` is
what keeps the PR on this repo when `origin` is a fork (without it `gh` may offer, or pick, the
fork), and `--head` is the ticket's recorded branch, the one the merge driver will look the PR up
by.

**Draft first**, unless §5 PR lifecycle says this repo doesn't use drafts. The draft gives the
images somewhere to land. Then follow §5 PR lifecycle; the usual order is: upload the images, post
the Stage 4b self-review (`desk-ticket` Stage 7), and — if §3 `pr-ready`, `pr-auto-merge` and
`pr-merge-green` all allow, and §4 Repo merge settings allow auto-merge — `gh pr ready <n> &&
gh pr merge <n> --auto --<§4 Merge method> --match-head-commit <headRefOid>`. **Arm auto-merge only
when GitHub's gate and ours coincide**: every check that runs on this repo's PRs is either in §4
Required checks (which GitHub enforces) or in §4 Advisory checks. GitHub's auto-merge waits only for
the checks branch protection requires, so where another check runs (a path-filtered API suite, say)
it would merge past that check failing. Otherwise do not arm it: undraft, and merge when the head is
green by the definition below. Merging needs the head
**green** as the config defines it (desk-config "Green": every §4 Required checks entry completed
with success, skipped not counting; nothing else failed, errored, timed out or still running unless
§4 Advisory checks names it; at least one success), and is always pinned to that head with
`--match-head-commit`. A PR touching a glob in §4 Merge holds is never armed or merged by a skill:
report it with the hold's reason and the user merges. Never `--admin`, never past a failing check
(`merge-bypass` is `never`). A draft cannot merge, so a PR left drafted is a merge silently deferred; if a row says
`no`, say plainly it waits on the user. `desk-ticket`'s Stage 7 "Merging" section owns shepherding,
including disarming auto-merge when review feedback lands under §3 `merge-feedback-first`, and the
close-out once it merges: the move to Done, and `closeout.mjs` telling any batch that still holds
the ticket. If `gh`
fails, fall back to handing over the raw markdown to paste.

**The title follows §5 PR title exactly** — the format (e.g. conventional commits
`type(scope): <TICKET> description`), where the key sits, and whether CI checks it. When §4 Merge
method is `squash` and the repo squash-titles from the PR title, this one string is what reaches the
default branch, and it is often the only thing a Jira integration parses for a key.

- Match the key to §4 Ticket key pattern **exactly, case included**: a lowercased key links to
  nothing. Put it where §5 PR title puts it; a key in the wrong position fails a title check.
- If §5 PR title uses conventional commits, the type comes from the standard set
  (`feat|fix|chore|ci|docs|test|refactor|perf|build|style|revert`), a `!` before the colon marks a
  breaking change, and a scope is lowercase `[a-z0-9./_-]` — **an uppercase or spaced scope
  commonly fails and reports itself as a *type* error**, so check the scope's case before you doubt
  the type. Take scopes from the repo's instructions or recent merged titles; omit one rather than
  invent it for a change spanning several.
- Genuinely ticketless work, in a repo with a tracker, takes whatever §5 PR title says waives the
  key (a label, a marker). That is the user's call — ask. With §4 Tracker `none`, titles carry no key.
- §5 Repo instructions win on anything the repo's own files say about titles.

**A CI title check that runs on `pull_request` with the default event types does not re-run on
rename**: `edited` is not one of them. Renaming a PR does not re-run the check, and re-running the
failed job replays the *old* payload — only a push clears a bad title. Get it right at
`gh pr create`.

**The branch feeds the title.** Branches follow §5 Branch names (e.g. `<type>/<TICKET>-short-slug`,
with the type mapped from the issue type as §5 gives it). Keep the key's case as §4 Ticket key
pattern has it: commit hooks and GitHub's title pre-fill take it from the branch. A branch with no
key (`worktree-*`, `agent-*`) gives both nothing to work with.

**When one ticket ships as more than one PR**, number the parts after the key, unless §5 PR title
says otherwise. **Digits, never letters** — `(1/2)`, not `(A/B)`:

```
feat(auth): ABC-512 (1/2) add the parent-invite backend
feat(auth): ABC-512 (2/2) add the sign-up UI for the parent invite
```

The first number is this part, the second the total — a three-part ticket runs `(1/3)`, `(2/3)`,
`(3/3)`. Both are counts to substitute: `(B/B)` is wrong and has happened. The marker never goes
before the key — a title check wants the key exactly where §5 puts it. Say in the body which PRs
make up the set and the order they merge in.

### Editing the body later: start from the live body, never your draft

Once the PR is open, the body on GitHub is no longer only yours. CI and bots add sections after
`gh pr create` (a preview-links table, a coverage summary, a deploy status), and a
`gh pr edit --body-file` from your local draft deletes them. Nothing puts them back until the next
push, and a PR can merge in that gap with the section gone. So every edit, whatever prompted it
(new screenshots, a fix-up after review, a corrected Testing bullet):

1. **Fetch the live body immediately before you edit**: `gh pr view <n> --repo <§0 GitHub repo>
   --json body --jq .body`, saved to the body file. Not the draft you opened the PR with, and not a
   copy from earlier in the session: CI may have written since.
2. **Change only desk's section**: the text between `<!-- desk-pr: body -->` and `<!-- desk-pr: end -->`.
   Everything outside the markers stays byte for byte, including where it sits.
   - **No markers** (a PR opened before this rule, or by hand): edit the live body in place,
     changing only the lines you mean to change. Do not wrap text you did not write in desk's
     markers.
   - **A marker missing its partner, or either one appearing twice**: do not guess where desk's
     section ends. Stop and report the body as you found it.
3. **Run the PR-description checks** on the file (above).
4. **Fetch the live body once more, just before writing**, and compare everything outside the
   markers (with no markers, the whole body) with the step 1 copy. Any difference means CI or a bot wrote while you edited, and your
   file would delete it: go back to step 1 from the new body. Twice in a row: stop and report
   rather than loop.
5. **Write it back** with `gh pr edit <n> --repo <§0 GitHub repo> --body-file <path>`. `gh pr edit`
   has no compare-and-swap, so step 4 narrows the window to seconds; it does not close it.

The image upload script already edits from the live body and touches only the `_drag <file>_`
cells, so it needs none of this.
