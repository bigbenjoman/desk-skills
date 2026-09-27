#!/usr/bin/env bash
# Triage one ticket, read-only, before any worktree exists.
#
# Cheap and disposable: no worktree, no install, no branch. Runs against the main
# checkout purely to read code. Writes a JSON record the orchestrator can act on
# without ever reading the ticket itself — that is what keeps its context flat.
set -euo pipefail

TICKET="${1:?usage: triage.sh SV-XXX}"

# shellcheck source=desk-env.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/desk-env.sh"
studia_load_paths || exit 1
# Read-only and foreground, so `ask` does not block it: the batch is confirmed once, at Stage 3, and
# that one question round needs triage's output to exist. `no` still refuses.
studia_require_headless triage || exit 1

MAIN="$DESK_REPO_ROOT"
STATE="$DESK_STATE"
ROUTING="$DESK_SKILLS_DIR/desk-ticket/references/desk-ticket-routing.md"
OUT="$STATE/triage/$TICKET.json"
SETTINGS="$DESK_HOME/workers/$TICKET.triage.settings.json"
mkdir -p "$STATE/triage" "$DESK_HOME/workers"

[ -f "$ROUTING" ] || { echo "FAIL: routing file missing at $ROUTING — is desk-ticket installed?" >&2; exit 1; }
node "$DESK_BIN/worker-settings.mjs" triage --ticket "$TICKET" --out "$SETTINGS" >/dev/null \
  || { echo "FAIL: could not generate triage settings" >&2; exit 1; }

read -r -d '' PROMPT <<PROMPT_END || true
Triage Studia ticket $TICKET. Read-only: change nothing, create no branch or worktree.

You already have the memory index and the studia-* skills. **Read $ROUTING and apply its lane
rules as written** — do not work from a summary of them. Read the ticket with \`desk-jira get $TICKET\`
and its comments with \`desk-jira comments $TICKET\` (a later comment can settle or rule out what the
description asks for), then read enough of the code in $MAIN to judge the lane. Enough to judge it,
not to fix it.

Things that are not in that file and matter here:

- **Judge the lane as if every item in \`unknowns\` were already answered.** Missing information
  belongs in \`unknowns\`, never in the lane. A net-new endpoint or a security dimension is
  ordinary engineering, not lane C. Reserve C/D for their structural signals.
- **\`unknowns\` is only for decisions that are the user's.** Before listing one, check: is it
  already settled by CLAUDE.md, DESIGN.md, .agents/knowledge/ or a memory? Is it really the product
  owner's or the reviewer's call (config §4) — if so say whose call it is. Would any reasonable
  engineer just pick one and note it in the PR? Then pick it. Two well-aimed questions beat five.
- **A design attached to a ticket is not by itself lane D.** Almost every Studia UI ticket carries
  a Figma frame, so treating one as sufficient on its own parks most of the board. D is for a new
  screen, section or component the design specifies; a change to an existing screen that links a
  frame, implemented across a handful of files, is lane A.
- **Labels are a hint, not a verdict.** \`One-shot\` / \`Multi-stage\` encode the effort estimated when
  the ticket was written, and \`needs-design\` means it waits on design. Read the body anyway: some
  \`One-shot\` tickets are really a redesign or not a code fix at all.
- **Look for prior art before sizing the ticket.** Another branch may already have done part of
  this, or done it the opposite way — that changes the lane and the scope more than anything in the
  description does. \`git branch -a --sort=-committerdate | head -40\`, then for any branch whose
  name or ticket looks related, \`git diff --stat origin/main...<branch>\` and check whether it
  touches your \`files_in_scope\`. If the ticket names another SV key ("follow-up from SV-NNN"),
  check whether that one merged: \`git log --oneline origin/main --grep=SV-NNN\` returning nothing
  means an unmerged dependency — name it in \`prior_art\` and \`unknowns\` (which base to use).
  Remote-tracking refs may be a little stale; say so rather than claiming none exists.
- **Size the ticket AFTER prior art, not before.** This is the step that gets skipped: prior art is
  researched, written into \`prior_art\`, and then the lane is chosen from the ticket description as
  though nothing had been found. Half-built is the common case here — a builder, route, model or
  helper that already exists turns "new feature spanning more than one sitting" into an extension
  you can name file by file, which is lane A. Before writing lane C or D on a size signal, state
  what is genuinely missing *given what already exists*. If \`prior_art\` is non-empty and the lane
  is still C or D, \`lane_reason\` must say why the prior art does not shrink it.
- **"Already fixed" is not a lane.** If the code seems to satisfy the ticket, say so in
  \`lane_reason\` with file:line per acceptance criterion, keep the lane you would otherwise pick,
  and add an \`unknowns\` entry. Nothing in a batch closes a ticket on a triage opinion.

Write ONLY this JSON to $OUT — no prose, no code fence:

{
  "ticket": "$TICKET",
  "type": "<Jira issue type>",
  "status": "<Jira status>",
  "assignee": "<assignee display name, or null if unassigned>",
  "summary": "<one line>",
  "lane": "A|B|C|D|E",
  "lane_reason": "<the specific signal that chose it, in the routing file's terms>",
  "branch": "<prefix per the routing rules>/$TICKET-<kebab-slug>",
  "files_in_scope": ["repo-relative paths you expect to change"],
  "unknowns": ["questions only the user can answer. Empty if none."],
  "prior_art": ["<branch or PR that already touches these files, and in one clause what it does — opposite intent, same intent, or partial. Empty if none found.>"],
  "renders": <true if the change alters what a user sees, so Stage 5 evidence is required>,
  "admin_api": <true if any file in scope is under src/app/api/admin/, src/server/openapi/ or src/schemas/admin->,
  "needs_db": <true if verifying it needs a database, seed, or integration test>
}

files_in_scope drives collision detection across the batch, so be concrete and do not pad it.
PROMPT_END

cd "$MAIN"
studia_timeout 600 claude -p "$PROMPT" \
  --settings "$SETTINGS" \
  --permission-mode dontAsk \
  --allowedTools "Read,Grep,Glob,Bash,Write" \
  --add-dir "$STATE" --add-dir "$DESK_SKILLS_DIR" \
  --max-budget-usd "${AUTOPILOT_TRIAGE_BUDGET_USD:-3}" \
  --output-format text > /dev/null 2>&1 < /dev/null || true

if [ ! -f "$OUT" ]; then
  echo "FAIL: $TICKET produced no triage record at $OUT (an empty run can also be the account session limit)" >&2
  exit 1
fi
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if(!"ABCDE".includes(d.lane)||d.lane.length!==1) throw new Error("bad lane"); if(!d.branch) throw new Error("no branch");' "$OUT" \
  || { echo "FAIL: $TICKET triage record is malformed" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Lane challenge. Only C and D get one, because only they are terminal: an
# over-escalated ticket parks at plan-batch and does no work at all until
# the user reads a question, so a wrong C/D costs a whole batch cycle while a
# wrong A costs the worker one demotion. Bounded by construction — it fires on
# the minority of tickets, reuses the read-only settings, and can only ever
# downgrade. Set AUTOPILOT_SKIP_CHALLENGE=1 to turn it off.
# ---------------------------------------------------------------------------
LANE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).lane)' "$OUT")
CHAL="$STATE/triage/$TICKET.challenge.json"
rm -f "$CHAL"

if [ -z "${AUTOPILOT_SKIP_CHALLENGE:-}" ] && { [ "$LANE" = "C" ] || [ "$LANE" = "D" ]; }; then
  read -r -d '' CHALLENGE_PROMPT <<CHALLENGE_END || true
A first triage pass put Studia ticket $TICKET in lane $LANE, which means it will be parked and
worked by hand rather than run. Your job is to check that call before it costs a batch cycle.
Read-only: change nothing.

Read $STATE/triage/$TICKET.json for the first pass's reasoning, read $ROUTING, and read enough of
the code in $MAIN to judge it yourself.

**Confirm unless you can name the specific C or D trigger that does not in fact fire.** Doubt means
confirm. You are looking for clear over-escalation, not an argument — the routing file's own rule is
that ties break toward the cheaper lane and then the doubt gets stated, so a genuine tie is a
confirm with the doubt written down.

The ones that have actually been got wrong, all toward over-escalation:

- **A Figma frame read as lane D on its own.** Nearly every Studia UI ticket has one. The question
  is whether the design specifies something new to build, not whether a design exists.
- **An unanswered question read as complexity.** Missing information belongs in \`unknowns\`. Judge
  the lane as if every unknown were already answered.
- **\`spans more than one sitting\` sized from the description instead of the code.** The most common
  one. Check the first pass's own \`prior_art\`, and for each thing it counts as "new", look on
  origin/main for an existing pattern to copy (a token helper, an email template, an accept route, a
  repository already writing that relation). If one exists, the work is an extension, not a build
  from nothing, and the size signal probably does not fire. Where the ticket itself defines
  sequenced, independently-mergeable stages, size the FIRST stage — the batch runs that.

Downgrade to A, B or E when the change is one you could describe file by file right now.

The file-by-file test is evidence for a downgrade, not a precondition for one. Do not apply it to a
ticket parked purely on size: a large-but-mechanical change cannot be listed exhaustively by
definition, so requiring the list there makes the size trigger unfalsifiable and confirms every
time. For that trigger the question is instead whether the work is mechanical and bounded — the same
edit repeated, or an extension of something that exists — in which case downgrade and say so.

Write ONLY this JSON to $CHAL — no prose, no code fence:

{
  "verdict": "CONFIRM|DOWNGRADE",
  "lane": "<the lane you land on: $LANE if CONFIRM, else A|B|E>",
  "reason": "<one or two sentences. On DOWNGRADE, name the trigger that does not fire and list the files. On CONFIRM, name the trigger that does, and for each 'new' thing say whether an existing pattern was found.>"
}
CHALLENGE_END

  cd "$MAIN"
  studia_timeout 420 claude -p "$CHALLENGE_PROMPT" \
    --settings "$SETTINGS" \
    --permission-mode dontAsk \
    --allowedTools "Read,Grep,Glob,Bash,Write" \
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
    if (c.verdict === 'DOWNGRADE' && ['A', 'B', 'E'].includes(c.lane)) {
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

node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(`[triage] ${d.ticket}  lane ${d.lane}  ${(d.files_in_scope??[]).length} files  ${(d.unknowns??[]).length} unknowns`)' "$OUT"
