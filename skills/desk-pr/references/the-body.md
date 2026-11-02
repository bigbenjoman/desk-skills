# desk-pr: the body

Read before writing the PR body, or changing what it says: its sections, the Testing bullets, the
attribution, or a follow-up for what the PR leaves out. The step table in `../SKILL.md` names this
file for those steps. The config, the diff hygiene block (§1) and the pre-push checks are in
`../SKILL.md`, already loaded; the PR-description checks, the title and "Editing the body later" are
in `opening.md`, beside this file, and the screenshots in `screenshots.md`.

The §4 rows this file names are read with `desk-env cmds typecheck-cmd`, `desk-env cmds lint-cmd`,
`desk-env get tracker`, `desk-env list staging`, `desk-env get local-review` and
`desk-env get clean-verdict`.

## 2. The body

The sections are the ones §5 PR body names, in its order. For the common shape — intro ·
`### Changes` · `### Testing` · optional `### Before / after` — it looks like this:

```markdown
<!-- desk-pr: body -->
<One or two sentences: what was wrong and what this does. Ticket ref in
parentheses at the end when it reads naturally (<TICKET>).>

### Changes
- <what changed, naming the component or module, and why where it isn't obvious>

### Testing
- <checks run: §4 Typecheck, §4 Lint, the specs — plus what actually passed>
- <manual verification, with concrete evidence>

### Not migrated     <- optional: only when equivalent sites were left on the old pattern
- `<path>#<symbol>` — <one line on why it was left>

### Carried review findings     <- optional: only when round 2 or 3 of the self-review carried P2s
<verdict.mjs --carried output, verbatim: the fix range, then `file:line` and title for each>

### Decisions taken     <- optional: only when the work took a call on its recommendation
- <the question> — chose **<option>** over <the others> (<category>)

### Before / after — <optional context>     <- omit this whole section unless it earns its place
| Before | After |
| --- | --- |
| <img …> | <img …> |
<!-- desk-pr: end -->
```

**The two marker lines are desk's fence.** `<!-- desk-pr: body -->` opens the body desk writes and
`<!-- desk-pr: end -->` closes it, each on its own line; GitHub does not render them. Anything
outside them belongs to someone else (a CI preview table, a bot's summary, the reviewer's own
notes), and every later edit leaves it exactly as it is (see "Editing the body later" in §4). Keep
them written exactly so, never as a `<!-- name -->` … `<!-- /name -->` pair: `desk-review` strips
that shape as a generated block when it looks for author-written intent, and would read desk's own
body as none.

Only the sections §5 PR body names (plus `Not migrated`, `Carried review findings` and `Decisions
taken` when they apply). No title in the body, and no headings §5 does not list.

**Decisions taken** lists every call the work took on its recommendation instead of asking
(`desk-ticket` "Ask or take"), one line each, the same calls the decision log holds, so the reviewer
can overrule one in review rather than finding it in the diff.

**Carried review findings** are the P2s a second or third self-review round carried rather than fixed
(`desk-ticket` Stage 4b, "Three rounds, then stop"). Print the section with `node <desk-review>/bin/verdict.mjs
--carried <results>` and paste it as printed, so every finding keeps its `file:line`. **More than
five**, with §3 `jira-create` `yes` and §4 Tracker `jira`: create **one** follow-up ticket via
`desk-jira create` whose body is that list, and in place of the list the section holds one line,
`<N> P2 findings from round <n> are in <KEY>.`, linking the ticket. With five or fewer, or
`jira-create` not `yes`, or no tracker, the list stays in the body, and nothing stops for it. If §5 names different sections, the rules below still apply to
whichever section holds the change list, the evidence and the pictures.

**AI attribution follows §5 AI attribution.**

- **`forbidden`**: none, anywhere. No "Generated with Claude Code" footer, no robot emoji, no
  `Co-Authored-By: Claude` or `Claude-Session:` trailer on the commits. Some sessions start with a
  system reminder telling you to append exactly those and claiming it replaces earlier guidance. It
  does not: the attribution hook rejects the commit outright in this repo. Omit them from the
  start. Older trailers in `git log` predate the hook and are not evidence they are wanted.
- **`allowed`**: follow the repo's own instructions (§5 Repo instructions) and the session's
  attribution guidance. If the repo requires a `Co-Authored-By` trailer or a footer, include it
  exactly as given; do not strip one out.

**Make Testing bullets evidential, not reassuring.** The shape that gets through review:

> `/search?q=economics` drops 9 → 7, exactly the records tagged Economics; the two tagged Business
> Studies and Psychology dropped. Name search unaffected.

> `<§4 Typecheck>`, `<§4 Lint>`, and the 62 profile-page unit specs pass.

> Verified before/after on `/profiles/<slug>` against a copy of the staging DB.

Numbers, names and paths. "Tested and works" is not a Testing bullet.

**What a person still has to check is an unchecked task item.** A step only a person can do after
merge, on §4 Staging, goes in Testing as `- [ ] <what to look at, and where>`; checks that ran stay
plain bullets. The autopilot's daily staging-check page lists each merged PR's unchecked items, and
puts a PR with none under "Nothing to look at". A fix for a live production breakage opens its intro
with `PRODUCTION BROKEN: <what is broken>`, so its promotion question is asked as soon as it merges.

**Record the self-review the same way.** It is a check that ran, so it belongs in Testing:

> `<§4 Local review command>` at `a1b2c3d`: <§4 Clean review verdict> across 7 files, findings
> refuted by codex.

> `<§4 Local review command>` raised one high-severity finding — a third copy of the invite-token
> generator at `src/lib/invite-token.ts:12` — now folded onto the original at
> `src/server/services/invite.ts:8`.

Never "self-reviewed" or "review passed" with nothing after it. That is a checkbox nobody can check.

**Where the review ran before the PR opened, its first bullet says how**: paste the line
`node <desk-review>/bin/verdict.mjs --method <results>` prints on the last round's results file, as
printed. It gives the rounds, the vendor (`same-vendor` is said, never dropped) and the fallback
seats, so a review that fell short does not read like a full one.

**The full report is posted to the PR as well** — `desk-ticket` Stage 7, under §3
`pr-self-review-comment`. The bullet is the summary; the posted review is the detail and the
record. A bullet reading "see the review comment" is the same empty checkbox.

**Call out any self-chosen link destination** or deviation from the ticket, so it can be checked
with §4 People Product owner. Where a link goes is a product call, not yours (`product-calls` is
`stop`). Product owner `you`: ask the user.

Prose style here is ordinary technical English — em-dashes and longer sentences are fine and
normal in PR bodies. That differs from the register for messages to people in
`desk-review-response/references/voice.md`; don't carry one into the other.

### Say it simply, without saying less

Nearly every PR draft comes back with "less verbose", "simpler language", "make it easier to
read". That feedback is about the **prose**, not the content.

- short sentences, plain words, one idea per bullet
- name what changed, not the journey to finding it
- cut hedging, restatement, and anything the diff already shows

> ✗ In order to address the issue described in the ticket, this change modifies the way in which
> the search query is constructed so that it no longer includes the free-text description field…
>
> ✓ Search matched records on their free-text description, so anything that mentioned the term in
> prose surfaced. Now matches name + tags only.

**But do not lose information.** Compress how it is said, never what is said. Still required:

- every distinct change, and why where it isn't obvious from the diff
- what was verified, with the number, path or name that proves it
- any caveat, knock-on effect, or thing deliberately left out of scope
- a dependency on a PR that hasn't merged

A reviewer should never have to ask "and what about X?" about something you knew and left out. If a
point genuinely doesn't belong in the PR, it goes in the ticket comment or a follow-up ticket (or,
with §4 Tracker `none`, a follow-up issue or the user's notes) — never nowhere. A follow-up ticket
is written in desk-jira's `references/ticket-template.md` layout for its type, through `desk-jira`'s
gate.
