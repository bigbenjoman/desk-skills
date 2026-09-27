# Subagent briefs

Two kinds, and the split is the point: **ASSESS is read-only and fans out wide; IMPLEMENT writes
and fans out to capacity.** Everything irreversible — merge, base change, ticket transition,
hand-back — stays with the parent and is never delegated.

Copy a brief and fill the `<>` fields. Do not paraphrase them: the return schema is what keeps the
parent's context flat, and a subagent that answers in prose puts 23 PRs of narrative back into it.

**Both kinds can reach the parent mid-run.** `SendMessage` with `{"to": "main", ...}` is delivered
while the subagent is still working. That is the channel for anything needing the user: it reaches
them while they are still at their desk, instead of in a report after the pass. Nothing travels the
other way mid-run, so a subagent never waits on a reply.

Everything sent that way must arrive **as a question with drafted options and a recommendation**,
because the parent turns it straight into a carousel question.

Fill the `<>` fields from this repo's config (`desk-env where`, then Read it) — the subagent reads
the same file, so pass it the `CONFIG` path too. Fill `<§3 limits>` from config §3 before sending: if `git-push` or `pr-reply` is not `yes`, the
IMPLEMENT subagent stops before that step and returns what it would have
pushed or posted, and the parent asks.

---

## ASSESS — one per PR with outstanding feedback

Read-only. No worktree, no branch checkout, no dev server.

> You are assessing review feedback on \<§0 GitHub repo> PR **#\<n>** (\<title>), authored by the
> user (GitHub `<handle>`). **Read-only: do not edit, commit, push, reply, or resolve anything. Do not
> run typecheck, lint or the spec suite.**
>
> Load the **desk-review-response** skill first and follow it, including `references/voice.md` —
> every reply you draft posts publicly as the user. Read the repo config at `<CONFIG path>`: §4
> (including "What review here consistently asks for" and People) and §5.
>
> Gather the feedback from three places, not one: unresolved review threads, review bodies, and
> issue comments. Ignore anything authored by a bot. Paginate every `gh api` list. Read the PR diff
> and the surrounding code before forming a verdict — the reviewer is usually right, but not always.
>
> Classify every comment into exactly one tier:
> - **GREEN** — valid, the fix is local and mechanical, it stays inside what the existing review
>   already covers, and no product, design or copy decision is involved.
> - **AMBER** — the reviewer has misread something and the honest answer is a reply rather than a
>   change; **or** the fix would go materially beyond the reviewed scope; **or** it needs a product,
>   design or catalog call. Give it the full QUESTION/OPTION shape below, with a recommendation and
>   the drafted reply as the preview. If you are genuinely unsure, it is AMBER.
> - **RED** — it cannot be worked at all without something outside this PR (a merge conflict, a
>   migration, a staging write, a decision on another ticket).
>
> Say whether the fixes would change anything visible on screen, because that decides whether
> before/after screenshots are needed.
>
> Return **only** this, and nothing else:
>
> ```
> PR: #<n>
> SUMMARY: <one line — what this reviewer is actually asking for overall>
> UI_CHANGES: yes|no
> ESTIMATE: S|M|L
> COMMENTS:
>   - id: <thread id or "review-body" / "issue-comment">
>     where: <file:line, or "-">
>     asks: <one line>
>     tier: GREEN|AMBER|RED
>     verdict: valid|partly|not-applicable
>     evidence: <one line — what in the code makes that so>
>     action: <one line — the change, or the drafted reply, or the drafted question>
> ```
>
> Keep every field to one line. No preamble, no closing summary.
>
> Always finish the whole PR. But if you find something that blocks the work outright — a conflict,
> a missing migration, a decision sitting on another ticket — **`SendMessage` it to `"main"` the
> moment you find it**, in the QUESTION/OPTION shape, and tier it RED as well.

---

## IMPLEMENT — one per PR, only after the batch round

Owns a worktree and pushes. Run as many as `clearance-state.mjs capacity` allows. Never give one PR
to two subagents, and never give two PRs that share a source file to subagents running at once.

> You are working the agreed review fixes on \<§0 GitHub repo> PR **#\<n>** in the worktree at
> **\<config §2 worktrees dir>/\<TICKET>** (branch `\<branch>`). The repo config is at
> `<CONFIG path>`.
>
> Load **desk-review-response** and follow it, including `references/voice.md`. Read config §4
> "What review here consistently asks for" and run it against your own diff before you push —
> fixing one of those now saves a round trip. (Empty or `TODO`: there is no recorded house bar yet;
> say so in your return rather than inventing one.)
>
> **Do exactly these and nothing else:**
> \<the GREEN items, plus any AMBER items the user approved, verbatim from the batch round>
>
> Anything not on that list stays untouched, however tempting. Fixing extra things is the single most
> common reason a hand-back turns into another round.
>
> **Permissions for this run:** \<§3 limits>
>
> Then, in this order:
> 1. Confirm the worktree is yours and clean, and that `HEAD` matches the PR head. If it does not,
>    stop and report — do not reset, rebuild or stash. `git stash` is shared across every worktree.
> 2. Make the changes. Commit with the repository's own identity — never pass `-c user.name` or
>    `-c user.email`. AI attribution follows config §5 AI attribution: where `forbidden`, none
>    anywhere.
> 3. Config §4 Typecheck, §4 Lint, and the §4 Unit tests covering what you touched, each with §4
>    Command prefix and using only §4 Package manager, the tests behind
>    `~/.claude/desk/bin/with-lock.sh test …` at the §3b "Test worker cap under the test lock". Any
>    row that is `none`: skip that step and say so in your return. Anything §5 Repo instructions
>    requires for the kind of change you made (an extra test suite, a generator, a check script)
>    runs too.
> 4. If the fix changes anything on screen, capture before/after per **desk-pr** into the config §2
>    handoff directory. Print `CLEARANCE_IMAGES: <dir>` and **stop there** — the parent uploads.
> 5. `git fetch --prune`, and bring the branch up to date only if behind. On any conflict: **do not
>    resolve it, and do not stop at "there is a conflict".** Probe without touching the tree
>    (`git merge-tree --write-tree --name-only origin/<§0 Default branch> origin/<branch>`; on a
>    stacked PR, against the base too), then report the conflicting files, the competing hunks, and the resolution you would
>    propose and why. Never apply one the user has not approved.
> 6. After any merge of the default branch or of the base, conflicted or not: §4 Typecheck again;
>    audit any key removed from a message catalog (i18n JSON and the like) against the source that
>    reads it; and if the branch renamed a directory, check nothing the default branch added was
>    stranded at the old path.
> 7. Push. Then reply to each thread and resolve it — including the ones where you pushed back rather
>    than changed code. Reply in the register `voice.md` and config §5 "Messages to colleagues" set:
>    short, no thanks-for-the-review preamble. Replies and resolves are GraphQL (`references/repo-facts.md`).
> 8. If the fix materially changed behaviour or UI, update the PR description via **desk-pr**.
>
> **Never** merge, enable auto-merge, change a base branch, alter an assignee, request a review,
> rerun CI, transition a ticket, or force-push. Those are the parent's.
>
> **Raise a question the moment you have it — do not save it for your return.** `SendMessage` to
> `"main"`. It reaches the parent while you are still working, and the parent puts it to the user.
>
> **Send it as a question with options already drafted, never as prose:**
>
> ```
> QUESTION  PR #<n> - <what has to be decided, one line>
> CONTEXT   <file:line, and what turns on the answer>
> OPTION A  (recommended) <course of action> - <why this one, from the code>
> OPTION B  <course of action> - <consequence>
> OPTION C  <course of action, if there is a real third> - <consequence>
> PREVIEW   <the drafted reply, or the two competing versions of the hunk, if there is an artefact>
> ```
>
> **Recommend one, and mean it.** Never an option you would not carry out, never a bare yes/no where a
> real choice exists.
>
> Then **carry on with everything the answer does not affect.** If you cannot go further without it,
> return with what you finished and name the blocker in `BLOCKED_ON`; the parent resumes you with the
> answer, your context intact.
>
> Return **only** this — including on an early return, where the unfinished parts are just empty:
>
> ```
> PR: #<n>
> PUSHED: <sha>|none
> DONE: <one line per comment addressed>
> DECLINED: <one line per comment answered with a reply instead of a change>
> UNRESOLVED_THREADS_LEFT: <n>
> DESCRIPTION_UPDATED: yes|no|n/a
> IMAGES: <dir>|none
> NEEDS: <one line per thing requiring the user, or "nothing">
> BLOCKED_ON: <what you stopped for, if this is an early return, or "-">
> ```

---

## Also worth delegating

- **CI failure diagnosis** — read-only, returns the failing required check (or, for an aggregate
  gate job, the failing upstream job), the assertion,
  whether it matches a known flake signature, and whether your own rerun or push cancelled it. Never
  lets it rerun anything.
- **Park report gathering** — read-only, turns a park reason into something actionable.

## Never delegated

Merging (including arming auto-merge), updating a PR that is next to merge, base-branch changes,
assignee and re-review changes, CI reruns, ticket transitions, image uploads. Not because a subagent
would do them badly, but because they are irreversible or cancel something in flight, and must happen
in one place, in a known order, against state re-derived seconds earlier.
