#!/usr/bin/env bash
# Triage one ticket, read-only, before any worktree exists.
#
# Cheap and disposable: no worktree, no install, no branch. Runs against the primary
# checkout purely to read code. Writes a JSON record the orchestrator can act on
# without ever reading the ticket itself — that is what keeps its context flat.
#
#   triage.sh <TICKET>
#
# Which ids are accepted, and where each one's text comes from (desk-env ticket-kind):
#   a key matching §4 Ticket key pattern          read from the tracker with desk-jira
#   an id matching §4 Other work id patterns       (e.g. `P1-M14-FIX-1`, `BUG-119-5`) and, with §4
#   or, with Tracker none, a lower-case kebab slug   Tracker none, a slug: read from the ticket file
#                                                    $DESK_STATE/tickets/<TICKET>.md, which the
#                                                    orchestrator writes before triage
#   `issue-<n>` with Tracker none                  GitHub issue n of this repo, via `gh issue view`
# Ids are case-sensitive as written.
set -euo pipefail

# shellcheck source=desk-env.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/desk-env.sh"
desk_take_batch "$@" || exit 2
set -- ${DESK_ARGS[@]+"${DESK_ARGS[@]}"}
TICKET="${1:?usage: triage.sh [--batch <name>] <TICKET>}"
KIND="$(node "$DESK_ENV_MJS" ticket-kind "$TICKET")" || exit 2
desk_apply_batch_base || exit 1
desk_load_paths || exit 1
# Read-only and foreground, so `ask` does not block it: the batch is confirmed once, at Stage 3, and
# that one question round needs triage's output to exist. `no` still refuses.
desk_require_headless triage || exit 1

MAIN="$DESK_REPO_ROOT"
STATE="$DESK_STATE"
BASE="origin/$DESK_DEFAULT_BRANCH"
# A config row desk-env.mjs does not know yet reads as the fallback.
cfg_opt() { local v; if v="$(desk_cfg "$1" 2>/dev/null)" && [ -n "$v" ]; then printf '%s' "$v"; else printf '%s' "${2:-}"; fi; }
TRACKER="$(cfg_opt tracker '')"
[ -n "$TRACKER" ] || { echo "FAIL: config §4 Tracker is not set — run /desk-setup (\`jira\` or \`none\`). Refusing to guess." >&2; exit 1; }
TRACKER="$(printf '%s' "$TRACKER" | tr 'A-Z' 'a-z')"
BRANCH_CONV="$(cfg_opt branch-names '<type>/<TICKET>-<kebab-slug>')"
REPO_DESC="$(cfg_opt repo-description '')"
INSTRUCTIONS="$(cfg_opt repo-instructions 'CLAUDE.md or AGENTS.md, where they exist')"
if [ "$KIND" = work-id ] || [ "$KIND" = slug ] || [ "$KIND" = issue ]; then
  if [ "$KIND" = issue ]; then
    ISSUE_NO="${TICKET#issue-}"
    READ_TICKET="Read the ticket, GitHub issue #$ISSUE_NO, with \`gh issue view $ISSUE_NO --repo $DESK_GH_REPO --comments\` (a later comment can settle or rule out what the description asks for)"
    STATUS_JSON='"<the issue state: open or closed>"'
    ASSIGNEE_JSON='"<the issue assignee GitHub login, or null if unassigned>"'
  else
    # Not a tracker key, so there is nothing to fetch: the text is whatever the orchestrator wrote.
    TICKET_FILE="$STATE/tickets/$TICKET.md"
    [ -f "$TICKET_FILE" ] || { echo "FAIL: '$TICKET' is not a tracker key ($KIND), so its text must be in $TICKET_FILE — write the ticket there first (a description of the work, and where it came from)" >&2; exit 1; }
    READ_TICKET="Read the ticket in $TICKET_FILE (it is not a tracker issue; this file is the whole ticket)"
    STATUS_JSON="null"
    ASSIGNEE_JSON="null"
  fi
  RELATED="If the ticket names another piece of work (\"follow-up from …\", an issue number), check whether it merged: \`git log --oneline $BASE --grep=<its name or number>\`"
  TYPE_HINT="Bug|Feature|Chore, your reading of the ticket"
else
  [ "$TRACKER" != none ] || { echo "FAIL: '$TICKET' reads as a tracker key but config §4 Tracker is none" >&2; exit 2; }
  READ_TICKET="Read the ticket with \`desk-jira get $TICKET\` and its comments with \`desk-jira comments $TICKET\` (a later comment can settle or rule out what the description asks for). Its \`parent\` line names the parent and its type (\`-\` when it has none); if it has one (an epic or a story), read the parent's description with \`desk-jira get <that key>\` for context only: this ticket's own criteria are its scope"
  RELATED="If the ticket names another ticket key (\"follow-up from <KEY>\"), check whether that one merged: \`git log --oneline $BASE --grep=<KEY>\` returning nothing means an unmerged dependency — name it in \`prior_art\`. It is not a lane signal: plan-batch holds the ticket behind a Jira-linked blocker in the batch and asks about one outside it"
  TYPE_HINT="Jira issue type"
  STATUS_JSON='"<Jira status>"'
  ASSIGNEE_JSON='"<assignee display name, or null if unassigned>"'
fi
ROUTING="$DESK_SKILLS_DIR/desk-ticket/references/desk-ticket-routing.md"
OUT="$STATE/triage/$TICKET.json"
SETTINGS="$STATE/workers/$TICKET.triage.settings.json"   # per repo, like the worker's
mkdir -p "$STATE/triage" "$STATE/workers"

[ -f "$ROUTING" ] || { echo "FAIL: routing file missing at $ROUTING — is desk-ticket installed?" >&2; exit 1; }
# Where each Claude Design artifact the ticket links is snapshotted, found by URL: an epic's child
# reads the epic's snapshot, which is under the repo state and the epic's key, not its own. A lookup
# that cannot run (a GitHub issue, an unread ticket) leaves the general rule in the prompt.
DESIGN_READ="A Claude Design artifact's boards are saved under $STATE/designs/$TICKET/project/ when the orchestrator could read
  it, or in the repo under the Design canvases directory once a ticket has committed them
  (\`canvas.json\` lists the boards and their widths); read them there, never guess a design."
if [ "$KIND" != issue ] && SNAPS="$(node "$DESK_BIN/desk-design.mjs" snapshots "$TICKET" 2>/dev/null)" && [ -n "$SNAPS" ]; then
  DESIGN_READ="This ticket's Design section links these Claude Design artifacts; read each where it says, never guess a design
  (\`canvas.json\` lists the boards and their widths):"
  while IFS=$'\t' read -r url snap; do
    if [ "$snap" = - ]; then
      DESIGN_READ+=$'\n'"  - $url: no snapshot. Read it in the repo under the Design canvases directory if a ticket has
    committed it; otherwise it is unread, so say so in \`unknowns\`."
    else
      DESIGN_READ+=$'\n'"  - $url: snapshotted, its boards under $snap/project/. Every board is there: raise no
    unknown, park or lane reason saying its boards are not snapshotted or need exporting."
    fi
  done <<< "$SNAPS"
fi

node "$DESK_BIN/worker-settings.mjs" triage --ticket "$TICKET" --out "$SETTINGS" >/dev/null \
  || { echo "FAIL: could not generate triage settings" >&2; exit 1; }
# Both passes are offered only the tools they use (worker-tools.mjs).
desk_tool_args triage || { echo "FAIL: could not read the tool list (worker-tools.mjs)" >&2; exit 1; }

# What is already settled for this ticket: the user's answers in its briefing (answer.mjs) and the
# calls logged for it (decisions.mjs), so a re-triage does not ask them again.
read -r -d '' RECORDED_JS <<'RECORDED_END' || true
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [state, ticket, bin] = process.argv.slice(-3);
const load = (f) => import(pathToFileURL(join(bin, f)).href);
const { collectAnswers, capBriefing } = await load('briefing.mjs');
const { readDecisions } = await load('digest.mjs');
const { ticketCalls } = await load('decisions.mjs');
const brief = join(state, 'briefings', `${ticket}.md`);
const answers = existsSync(brief) ? collectAnswers(readFileSync(brief, 'utf8')) : '';
const { taken, checks } = ticketCalls(readDecisions(state), ticket);
const calls = [
  ...taken.map((d) => `- ${d.question}: took "${d.chose}"${d.was !== undefined ? `, overriding "${d.was}"${d.by ? ` (${d.by})` : ''}` : ''} (${d.category})`),
  ...checks.map((c) => `- ${c.question}: checked ${c.checked}, which showed ${c.showed}`),
];
const out = [answers, calls.length ? `Calls already taken or checked for ${ticket}:\n${[...new Set(calls)].join('\n')}` : ''].filter(Boolean).join('\n\n');
if (out) process.stdout.write(capBriefing(out, 12000));
RECORDED_END
RECORDED="$(node --input-type=module -e "$RECORDED_JS" "$STATE" "$TICKET" "$DESK_BIN" 2>/dev/null || true)"

read -r -d '' PROMPT <<PROMPT_END || true
Triage ticket $TICKET in $DESK_GH_REPO${REPO_DESC:+ ($REPO_DESC)}. Read-only: change nothing, create
no branch or worktree.

You already have the memory index and the desk-* skills. **Read $ROUTING and apply its lane
rules as written** — do not work from a summary of them. $READ_TICKET, then read enough of the code
to judge the lane. Enough to judge it, not to fix it.

You are running in $MAIN, the primary checkout. Run git there as plain \`git <subcommand>\`: pointing
git at a directory with its -C option is refused, and so is anything that writes, fetching included.
The orchestrator fetches before triage, so $BASE should be current; the working tree may not be. Read
code as it is on $BASE: \`git ls-tree -r --name-only $BASE -- <dir>\`, \`git show $BASE:<path>\`,
\`git grep -n <pattern> $BASE -- <path>\`. If $BASE looks stale, say so rather than claiming
something does not exist.

Things that are not in that file and matter here:

- **Judge the lane as if every item in \`unknowns\` were already answered.** Missing information
  belongs in \`unknowns\`, never in the lane. A net-new endpoint or a security dimension is
  ordinary engineering, not lane C. Reserve C/D for their structural signals.
- **Lane C means a person must agree something before code exists**: a feature sized L or XL (the
  ticket's Size; with none, more than one sitting judged from the code), an intermittent bug, or
  stated behaviour that looks wrong. Nothing else is lane C:
  - **Spanning more than one app or package is not lane C at size M or smaller.** Pick A or B, and
    name the packages in \`lane_reason\`.
  - **Unmerged blockers are not "more than one sitting".** They hold the ticket until they merge and
    never change its lane: name them in \`prior_art\`, not in \`unknowns\` or \`lane_reason\`.
  - **A step from the routing file's "Steps only the user can take" list** goes in \`ben_steps\`, one
    entry per step, each with a proposed blocker ticket for the user. It does not set the lane: the
    rest of the ticket keeps the lane it would otherwise get.
- **A change that adds or edits any file under \`.claude/\` is lane C**, whatever its size: the
  harness write-protects \`.claude/\` for a headless worker, and no setting or allow rule unlocks it,
  so only an interactive \`desk-ticket\` session can build it. List those paths in \`files_in_scope\`
  and start \`lane_reason\` with "the harness write-protects .claude/ for workers".
- **Only five topics wait for the user; every other call is taken.** Before listing an unknown,
  check whether the repo's own instructions ($INSTRUCTIONS), a memory or what is already settled
  for this ticket (below) answers it. Would any reasonable engineer just pick one and note it in the
  PR? Then pick it, and it is not an unknown. Otherwise write it as \`{"question", "category",
  "options", "recommended"}\`, where \`category\` is an ask category (\`money\`, \`legal\` for legal
  or regulatory, \`production\` for production data or credentials, \`customer-copy\` for customer
  copy where length means cost, \`user-fact\` for a fact only the user holds, such as missing
  product, catalog or copy data) or a take category (\`product\`, \`design\`, \`wording\`,
  \`review\`, \`engineering\`, \`scope\`, \`tracker\`). A take-category call with a recommendation
  you can defend is taken: \`recommended\` names your option, the worker builds it and it is logged
  as a decision, and it never stops the ticket. \`recommended\` is null only for an ask category,
  or when you have no recommendation you can defend: those wait for the user. Two well-aimed
  questions beat five.
- **A design attached to a ticket is not by itself lane D.** Where UI tickets routinely carry a
  design (a Figma frame, or a Claude Design artifact), treating one as sufficient on its own parks
  most of the board. D is for a new screen, section or component the design specifies; a change to
  an existing screen that links a design, implemented across a handful of files, is lane A.
  $DESIGN_READ
- **Labels are a hint, not a verdict.** An effort label encodes the estimate made when the ticket was
  written, and a waiting-on-design label means just that. Read the body anyway: a ticket labelled
  small can really be a redesign, or not a code fix at all.
- **Look for prior art before sizing the ticket.** Another branch may already have done part of
  this, or done it the opposite way — that changes the lane and the scope more than anything in the
  description does. \`git for-each-ref --sort=-committerdate --count=40 --format='%(refname:short)' refs/heads refs/remotes\`,
  then for any branch whose name or ticket looks related, \`git diff --stat $BASE...<branch>\` and
  check whether it touches your \`files_in_scope\`. $RELATED.
- **Size the ticket AFTER prior art, not before.** This is the step that gets skipped: prior art is
  researched, written into \`prior_art\`, and then the lane is chosen from the ticket description as
  though nothing had been found. Half-built is the common case here — a builder, route, model or
  helper that already exists turns "new feature spanning more than one sitting" into an extension
  you can name file by file, which is lane A. Before writing lane C or D on a size signal, state
  what is genuinely missing *given what already exists*. If \`prior_art\` is non-empty and the lane
  is still C or D, \`lane_reason\` must say why the prior art does not shrink it.
- **"Already fixed" is not a lane, and not a question.** For each acceptance criterion the code on
  $BASE seems to satisfy, add an \`already_met\` entry naming the criterion and the file:line that
  satisfies it, and keep the lane you would otherwise pick. When every criterion is met, set
  \`verify_only\` to true: the ticket is admitted as a verify-only task whose worker proves each
  criterion with a test and changes code only where one fails. Nothing in a batch closes a ticket on
  a triage opinion, and none of this goes in \`unknowns\`.
- **Name the change's blast radius in \`change_kind\`**: the largest of these the change makes, from
  the code you read, not the ticket's wording. plan-batch merges the batch in this order.
  \`relocate\`: moves, renames or deletes files or whole directories, or adds a new shared package.
  \`schema\`: changes a schema, a migration, or a persisted or wire format others read.
  \`shared\`: changes code, components, primitives or translation files more than one surface uses.
  \`surface\`: ordinary work on one surface.
${RECORDED:+
**Already settled for $TICKET.** These bind: raise no unknown they answer, on the same acceptance
criterion or any other, and judge the lane and scope with them applied.

$RECORDED
}
Write ONLY this JSON to $OUT — no prose, no code fence:

{
  "ticket": "$TICKET",
  "type": "<$TYPE_HINT>",
  "status": $STATUS_JSON,
  "assignee": $ASSIGNEE_JSON,
  "summary": "<one line>",
  "lane": "A|B|C|D|E",
  "lane_reason": "<the specific signal that chose it, in the routing file's terms>",
  "branch": "<this repo's branch convention, $BRANCH_CONV, with <TICKET> = $TICKET and every other <...> placeholder filled in: <type> from the issue type, a slug as two to five lower-case kebab words of the summary. No < or > and no spaces may remain>",
  "files_in_scope": ["repo-relative paths you expect to change"],
  "change_kind": "relocate|schema|shared|surface",
  "change_kind_reason": "<one clause: what it moves, the schema or shared code it changes, or the surface it touches>",
  "unknowns": [{"question": "<one line>", "category": "<an ask or take category, above>", "options": ["<at least two>"], "recommended": "<one of options, or null>"}],
  "already_met": ["<an acceptance criterion the code already satisfies>: <file:line>"],
  "verify_only": <true only when every acceptance criterion is in already_met>,
  "prior_art": ["<branch or PR that already touches these files, and in one clause what it does — opposite intent, same intent, or partial. Empty if none found.>"],
  "ben_steps": [{"step": "<a step only the user can take, from the routing file's list>", "blocker": "<the proposed blocker ticket's summary: what the user does, and what it unblocks>"}],
  "renders": <true if the change alters what a user sees, so Stage 5 evidence is required>,
  "needs_db": <true if verifying it needs a database, seed, or integration test>,
  "needs_local": <null, or one clause naming what verifying it needs that only this computer has: a local dev server, the browser, local stub binaries, a local service. A cloud session has the repo from GitHub and nothing else>
}

files_in_scope drives collision detection across the batch, so be concrete and do not pad it.
unknowns and already_met are [] when there are none.
ben_steps is [] when the ticket needs no step only the user can take.
PROMPT_END

cd "$MAIN"
# No --allowedTools: it would grant every Bash command and Write outright, overriding the
# read-only triage settings. The settings file alone decides what triage may run.
desk_timeout 600 claude -p "$PROMPT" \
  --setting-sources "" --strict-mcp-config \
  ${DESK_TOOL_ARGS[@]+"${DESK_TOOL_ARGS[@]}"} \
  --settings "$SETTINGS" \
  --permission-mode dontAsk \
  --add-dir "$STATE" --add-dir "$DESK_SKILLS_DIR" \
  --max-budget-usd "${AUTOPILOT_TRIAGE_BUDGET_USD:-3}" \
  --output-format text > /dev/null 2>&1 < /dev/null || true

if [ ! -f "$OUT" ]; then
  echo "FAIL: $TICKET produced no triage record at $OUT (an empty run can also be the account session limit)" >&2
  exit 1
fi
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!"ABCDE".includes(d.lane)||d.lane.length!==1) throw new Error("bad lane"); if(!d.branch) throw new Error("no branch"); if(!["relocate","schema","shared","surface"].includes(d.change_kind)) throw new Error("bad change_kind"); const s=d.ben_steps; if(s!==undefined&&!(Array.isArray(s)&&s.every((x)=>x&&typeof x.step==="string"&&x.step.trim()&&typeof x.blocker==="string"&&x.blocker.trim()))) throw new Error("bad ben_steps");' "$OUT" \
  || { echo "FAIL: $TICKET triage record is malformed" >&2; exit 1; }
# Only the questions the user must answer stay in `unknowns`, as strings every reader of the record
# takes them as; each call taken on its recommendation goes to `decided`, logged when the ticket is
# admitted. `verify_only` holds only with criteria named in `already_met`.
node --input-type=module - "$OUT" "$DESK_BIN" <<'CALLS_END' || { echo "FAIL: $TICKET triage record's questions could not be split" >&2; exit 1; }
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [out, bin] = process.argv.slice(2);
const { triageCalls } = await import(pathToFileURL(join(bin, 'decisions.mjs')).href);
const d = JSON.parse(readFileSync(out, 'utf8'));
const { ask, taken } = triageCalls(d);
d.unknowns = ask;
d.decided = taken;
d.already_met = (Array.isArray(d.already_met) ? d.already_met : []).map(String).filter((s) => s.trim());
d.verify_only = d.verify_only === true && d.already_met.length > 0;
writeFileSync(out, `${JSON.stringify(d, null, 2)}\n`);
if (taken.length) console.log(`[triage] ${d.ticket}  took ${taken.length} call(s) on their recommendation`);
CALLS_END
# A branch the worker could never push is refused, and the record goes with it, so the ticket is
# triaged again rather than queued on that branch.
BRANCH=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).branch)' "$OUT")
if ! WHY=$(node "$DESK_ENV_MJS" branch-check "$BRANCH" 2>&1); then
  rm -f "$OUT"
  echo "FAIL: $TICKET triage record is malformed: ${WHY#desk: }. Triage it again." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Lane challenge. Only C and D get one, because only they are terminal: an
# over-escalated ticket parks at plan-batch and does no work at all until
# the user reads a question, so a wrong C/D costs a whole batch cycle while a
# wrong A costs the worker one demotion. Bounded by construction — it fires on
# the minority of tickets, reuses the read-only settings, and can only ever
# downgrade. One whose code reads failed is INCONCLUSIVE, never a confirm:
# plan-batch then shows the lane as unchecked. Set AUTOPILOT_SKIP_CHALLENGE=1
# to turn it off.
# ---------------------------------------------------------------------------
LANE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).lane)' "$OUT")
CHAL="$STATE/triage/$TICKET.challenge.json"
rm -f "$CHAL"

if [ -z "${AUTOPILOT_SKIP_CHALLENGE:-}" ] && { [ "$LANE" = "C" ] || [ "$LANE" = "D" ]; }; then
  read -r -d '' CHALLENGE_PROMPT <<CHALLENGE_END || true
A first triage pass put ticket $TICKET in lane $LANE, which means it will be parked and
worked by hand rather than run. Your job is to check that call before it costs a batch cycle.
Read-only: change nothing.

Read $STATE/triage/$TICKET.json for the first pass's reasoning, read $ROUTING, and read enough of
the code to judge it yourself. You are in $MAIN: run plain \`git <subcommand>\` (its -C option and
fetching are both refused), and read code as it is on $BASE
(\`git show $BASE:<path>\`, \`git grep -n <pattern> $BASE -- <path>\`).

**Confirm unless you can name the specific C or D trigger that does not in fact fire.** Doubt about
a judgement you could check means confirm. You are looking for clear over-escalation, not an
argument — the routing file's own rule is that ties break toward the cheaper lane and then the doubt
gets stated, so a genuine tie is a confirm with the doubt written down.

**A check you could not make is not doubt: it is INCONCLUSIVE.** If a read you needed to judge the
lane failed (a command was denied or errored, a file you had to read could not be opened, a ref did
not resolve) and you found no other way to read the same code, do not confirm on the first pass's own
file references. Answer INCONCLUSIVE, keep the lane, and list each of those reads in
\`failed_reads\`, so the plan shows the lane as unchecked rather than as settled. A search that ran
and found nothing is a result, not a failed read. Any entry in \`failed_reads\` makes the verdict
INCONCLUSIVE, so list only the reads you needed and could not make.

The ones that have actually been got wrong, all toward over-escalation:

- **A design read as lane D on its own** (a Figma frame or a Claude Design artifact). UI tickets
  routinely link one. The question is whether the design specifies something new to build, not
  whether a design exists.
- **An unanswered question read as complexity.** Missing information belongs in \`unknowns\`. Judge
  the lane as if every unknown were already answered.
- **\`spans more than one sitting\` sized from the description instead of the code.** The most common
  one. Check the first pass's own \`prior_art\`, and for each thing it counts as "new", look on
  $BASE for an existing pattern to copy (a token helper, an email template, an accept route, a
  repository already writing that relation). If one exists, the work is an extension, not a build
  from nothing, and the size signal probably does not fire. Where the ticket itself defines
  sequenced, independently-mergeable stages, size the FIRST stage — the batch runs that.
- **Spanning more than one app or package read as lane C.** It is not a C signal on its own: a ticket
  sized M or smaller (its Size, \`desk-jira get\`'s \`Size\` line where it has one) whose only C
  signal is that goes to A or B, with the packages named in your reason.
- **Unmerged blockers read as "more than one sitting".** Blockers hold a ticket until they merge;
  they never set its lane. A ticket whose only C signal is its blockers goes to A or B.
- **A step only the user can take read as lane C** (the routing file's list). It is its own blocker
  ticket, and the rest of the ticket keeps its lane: list each one the first pass's \`ben_steps\`
  does not already hold in your \`ben_steps\`.

Lane C stands only on its own signals: a feature sized L or XL (with no size, more than one sitting
judged from the code), an intermittent bug, or stated behaviour that looks wrong. A ticket sized L or
XL stays C. A lane C ticket with none of these fails the check: downgrade it to A or B.

A change that adds or edits any file under \`.claude/\` stays C whatever its size: the harness
write-protects \`.claude/\` for a headless worker, so a downgrade only sends it to a worker that parks.

Downgrade to A, B or E when the change is one you could describe file by file right now.

The file-by-file test is evidence for a downgrade, not a precondition for one. Do not apply it to a
ticket parked purely on size: a large-but-mechanical change cannot be listed exhaustively by
definition, so requiring the list there makes the size trigger unfalsifiable and confirms every
time. For that trigger the question is instead whether the work is mechanical and bounded — the same
edit repeated, or an extension of something that exists — in which case downgrade and say so.

Write ONLY this JSON to $CHAL — no prose, no code fence:

{
  "verdict": "CONFIRM|DOWNGRADE|INCONCLUSIVE",
  "lane": "<the lane you land on: $LANE if CONFIRM or INCONCLUSIVE, else A|B|E>",
  "reason": "<one or two sentences. On DOWNGRADE, name the trigger that does not fire and list the files. On CONFIRM, name the trigger that does, and for each 'new' thing say whether an existing pattern was found. On INCONCLUSIVE, say what you could not check.>",
  "failed_reads": ["<each read you needed that failed, as the command or path and why, e.g. 'git show $BASE:src/x.ts: path not in $BASE'; [] when none did>"],
  "ben_steps": [{"step": "<a step only the user can take that the first pass did not record>", "blocker": "<the proposed blocker ticket's summary: what the user does, and what it unblocks>"}]
}

ben_steps is [] when there is no such step.
CHALLENGE_END

  cd "$MAIN"
  desk_timeout 420 claude -p "$CHALLENGE_PROMPT" \
    --setting-sources "" --strict-mcp-config \
    ${DESK_TOOL_ARGS[@]+"${DESK_TOOL_ARGS[@]}"} \
    --settings "$SETTINGS" \
    --permission-mode dontAsk \
    --add-dir "$STATE" --add-dir "$DESK_SKILLS_DIR" \
    --max-budget-usd "${AUTOPILOT_CHALLENGE_BUDGET_USD:-2}" \
    --output-format text > /dev/null 2>&1 < /dev/null || true

  # Merge defensively. A missing, malformed or upgrading challenge leaves the
  # first pass's lane exactly as it was — the record must survive a failed
  # challenge unchanged.
  node - "$OUT" "$CHAL" <<'MERGE_END'
const fs = require('fs');
const [out, chal] = process.argv.slice(2);
const d = JSON.parse(fs.readFileSync(out, 'utf8'));
if (!fs.existsSync(chal)) {
  d.lane_challenge = { verdict: 'UNAVAILABLE', reason: 'the challenge pass produced no record; first-pass lane kept' };
} else {
  let c = null;
  try { c = JSON.parse(fs.readFileSync(chal, 'utf8')); }
  catch (e) { d.lane_challenge = { verdict: 'UNAVAILABLE', reason: `unreadable challenge record (${e.message}); first-pass lane kept` }; }
  if (c) {
    const reason = String(c.reason ?? '').trim();
    // A person-only step the challenge found joins the record whatever the verdict: it is not a lane
    // signal, and a downgrade on it must not drop it. Malformed entries are ignored.
    const have = new Set((d.ben_steps ?? []).map((s) => s.step.trim()));
    const found = (Array.isArray(c.ben_steps) ? c.ben_steps : [])
      .filter((s) => s && typeof s.step === 'string' && s.step.trim() && typeof s.blocker === 'string' && s.blocker.trim())
      .filter((s) => !have.has(s.step.trim()) && have.add(s.step.trim()))
      .map((s) => ({ step: s.step.trim(), blocker: s.blocker.trim() }));
    if (found.length) d.ben_steps = [...(d.ben_steps ?? []), ...found];
    // A challenge that could not read the code has not checked the lane, whatever verdict it wrote:
    // any failed read makes it INCONCLUSIVE, and the first-pass lane stays, marked unchecked.
    const failedReads = (Array.isArray(c.failed_reads) ? c.failed_reads : []).map((x) => String(x).trim()).filter(Boolean);
    if (c.verdict === 'INCONCLUSIVE' || failedReads.length) {
      d.lane_challenge = { verdict: 'INCONCLUSIVE', reason, failed_reads: failedReads };
    } else if (c.verdict === 'DOWNGRADE' && ['A', 'B', 'E'].includes(c.lane)) {
      d.lane_original = d.lane;
      d.lane = c.lane;
      d.lane_reason = `downgraded from ${d.lane_original} at challenge: ${reason}`;
      d.lane_challenge = { verdict: 'DOWNGRADE', reason };
    } else if (c.verdict === 'CONFIRM') {
      d.lane_challenge = { verdict: 'CONFIRM', reason };
    } else {
      d.lane_challenge = { verdict: 'UNAVAILABLE', reason: `challenge returned ${JSON.stringify(c.verdict)}/${JSON.stringify(c.lane)}; first-pass lane kept` };
    }
  }
}
fs.writeFileSync(out, JSON.stringify(d, null, 2));
const ch = d.lane_challenge ?? {};
console.log(d.lane_original
  ? `[challenge] ${d.ticket}  lane ${d.lane_original} -> ${d.lane}  ${(ch.reason ?? '').slice(0, 100)}`
  : `[challenge] ${d.ticket}  lane ${d.lane} ${ch.verdict ?? ''}`);
MERGE_END
fi

# A change writing under .claude/ is lane C whatever either pass said: the harness write-protects it
# for a headless worker, and no grant unlocks it, so a worker given it only parks.
node - "$OUT" <<'CLAUDE_DIR_END'
const fs = require('fs');
const out = process.argv[2];
const d = JSON.parse(fs.readFileSync(out, 'utf8'));
const WHY = 'the harness write-protects .claude/ for workers';
const hit = (d.files_in_scope ?? []).map(String).filter((p) => /(?:^|\/)\.claude(?:\/|$)/.test(p));
let changed = false;
if (hit.length && !(d.lane === 'C' && String(d.lane_reason ?? '').startsWith(WHY))) {
  const was = d.lane !== 'C' ? `; lane ${d.lane} before this rule` : d.lane_reason ? `; ${d.lane_reason}` : '';
  d.lane = 'C';
  if (d.lane_original === 'C') delete d.lane_original;
  d.lane_reason = `${WHY}, so only an interactive desk-ticket session can write ${hit.join(', ')}${was}`;
  changed = true;
}
// The rule settles the lane, so a downgrade, an unchecked or a missing challenge must not leave this C
// reading as unreviewed: plan-batch and desk-q would invite a re-lane to A, back to a worker that parks.
if (hit.length && d.lane_challenge?.verdict !== 'CONFIRM') {
  d.lane_challenge = { verdict: 'CONFIRM', reason: `${WHY}: lane C set by rule, not by the challenge` };
  changed = true;
}
if (changed) {
  fs.writeFileSync(out, JSON.stringify(d, null, 2));
  console.log(`[triage] ${d.ticket}  lane C: writes under .claude/`);
}
CLAUDE_DIR_END

# Jira facts plan-batch needs (Blocks links, size, the lint findings), read deterministically rather
# than taken from the model: a read failure is recorded as facts_error, which plan-batch turns into a
# question.
node "$DESK_BIN/ticket-facts.mjs" "$TICKET" \
  || { echo "FAIL: could not record $TICKET's Jira facts in $OUT" >&2; exit 1; }

# With every canvas snapshotted or saved on the base, an unknown or a lane (park) reason asking for
# boards to be snapshotted or exported is false, and would only park the ticket for the user. The lane
# stays: only the false clause goes from its reason.
node - "$OUT" <<'SNAPPED_END'
const fs = require('fs');
const out = process.argv[2];
const d = JSON.parse(fs.readFileSync(out, 'utf8'));
const canvases = d.design?.canvases ?? [];
const UNTIL = /,?\s*\b(?:(?:held|parked|blocked|waiting)\s+)?until\b[^.;]*?\b(?:are|is|been)\s+snapshotted\b/gi;
const SNAP_ASK = /\bnot\s+(?:yet\s+|been\s+)*snapshotted\b|\bunsnapshotted\b|\buntil\b[^.;]*?\b(?:are|is|been)\s+snapshotted\b|\b(?:export\s+(?:or|and)\s+)?snapshot(?:\s+(?:or|and)\s+export)?\s+(?:the\s+|its\s+)?boards?\b/i;
if (canvases.length && canvases.every((c) => c.snapshot || c.saved)) {
  const said = [];
  if (Array.isArray(d.unknowns)) {
    const dropped = d.unknowns.filter((u) => SNAP_ASK.test(String(u)));
    if (dropped.length) {
      d.unknowns = d.unknowns.filter((u) => !SNAP_ASK.test(String(u)));
      said.push(`dropped ${dropped.length} unknown(s) asking for a snapshot`);
    }
  }
  if (typeof d.lane_reason === 'string' && SNAP_ASK.test(d.lane_reason)) {
    const kept = d.lane_reason.split(/\s*;\s*|(?<=\.)\s+/)
      .map((c) => c.replace(UNTIL, '').trim())
      .filter((c) => c && !SNAP_ASK.test(c));
    d.lane_reason = [...kept, 'every linked canvas is snapshotted or saved on the base'].join('; ');
    said.push(`dropped the lane ${d.lane} reason's ask for a snapshot`);
  }
  if (said.length) {
    fs.writeFileSync(out, `${JSON.stringify(d, null, 2)}\n`);
    console.log(`[triage] ${d.ticket}  ${said.join(', ')}: every canvas is snapshotted or saved`);
  }
}
SNAPPED_END

node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(`[triage] ${d.ticket}  lane ${d.lane}  ${(d.files_in_scope??[]).length} files  ${(d.unknowns??[]).length} unknowns`)' "$OUT"
