#!/usr/bin/env bash
# suite: triage (claude -p receives every flag)
# triage.sh's headless claude -p calls must receive every flag they are written with: a stub claude on
# PATH records its argv, and the first pass and the lane challenge are each checked for the flags,
# the redirects and the `|| true` (the stub exits non-zero). Scratch HOME and repo only.
# check() evals its condition string, so the variables it reads look unused to shellcheck.
# shellcheck disable=SC2034
set -u
S="$(cd "$(dirname "$0")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/state/tickets" "$T/skills/desk-ticket/references" "$T/stub"
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
unset DESK_CONFIG DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_DEFAULT_BRANCH AUTOPILOT_SKIP_CHALLENGE
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }

git init -q -b main "$T/repo"; git -C "$T/repo" commit -q --allow-empty -m init
cat > "$T/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$T/repo\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`yes\` |

## 4. Tracker
| Field | Value |
|---|---|
| Tracker | \`none\` |
| Ticket key pattern | \`none\` |
| Other work id patterns | \`none\` |
EOF
: > "$T/skills/desk-ticket/references/desk-ticket-routing.md"
printf '# fix-thing\n\nSource: the user\n\nFix the thing.\n' > "$T/state/tickets/fix-thing.md"
export DESK_CONFIG="$T/config.md" DESK_HOME="$SRC/desk" DESK_AUTOPILOT_STATE="$T/state" DESK_STATE="$T/state" DESK_QUEUE="$T/queue.json" \
  DESK_SKILLS_DIR="$T/skills" STUB_LOG="$T/argv" STUB_LANE=A

# The stub writes each call's argv (NUL-separated) to its own file, writes the record the prompt asks
# for, then talks on stdout and stderr and fails, as a claude that hit its budget would.
cat > "$T/stub/claude" <<'EOF'
#!/usr/bin/env bash
n=$(ls "$STUB_LOG".* 2>/dev/null | wc -l | tr -d ' ')
printf '%s\0' "$@" > "$STUB_LOG.$n"
if [ "$n" = 0 ]; then
  printf '{"ticket":"fix-thing","lane":"%s","branch":"%s","change_kind":"%s"%s}' "$STUB_LANE" "${STUB_BRANCH:-fix/fix-thing}" "${STUB_KIND-surface}" "${STUB_EXTRA:-}" > "$DESK_STATE/triage/fix-thing.json"
else
  [ -n "${STUB_CHAL:-}" ] || STUB_CHAL=$(printf '{"verdict":"CONFIRM","lane":"%s","reason":"stub"}' "$STUB_LANE")
  printf '%s' "$STUB_CHAL" > "$DESK_STATE/triage/fix-thing.challenge.json"
fi
echo "STUB-STDOUT"; echo "STUB-STDERR" >&2
exit 1
EOF
chmod +x "$T/stub/claude"
export PATH="$T/stub:$PATH"

# has <call n> <flag> [<value>]: the flag is in that call's argv, followed by the value when one is given.
has(){ [ -f "$STUB_LOG.$1" ] && node -e '
  const a = require("fs").readFileSync(process.argv[1], "utf8").split("\0").slice(0, -1);
  const [flag, val] = process.argv.slice(2);
  process.exit(a.some((x, i) => x === flag && (val === undefined || a[i + 1] === val)) ? 0 : 1);' "$STUB_LOG.$1" "${@:2}"; }

flags_ok(){ local n="$1" budget="$2"
  has "$n" -p && has "$n" --setting-sources "" && has "$n" --strict-mcp-config \
    && has "$n" --tools "Bash,Read,Write" \
    && has "$n" --settings "$T/state/workers/fix-thing.triage.settings.json" \
    && has "$n" --permission-mode dontAsk \
    && has "$n" --add-dir "$T/state" && has "$n" --add-dir "$T/skills" \
    && has "$n" --max-budget-usd "$budget" && has "$n" --output-format text; }

# The rendered triage settings decide every git call a prompt names. permits <settings> <command>:
# each `|` stage matches an allow rule and no deny rule, read the way the harness reads them (a
# trailing `:*` is a prefix, any other `*` a glob, neither an exact string). `match.js prompt <argv>`
# prints each backticked `git …` span of that call's -p prompt, one per line, placeholders as `x`.
cat > "$T/match.js" <<'EOF'
const fs = require('fs');
const [mode, a, b] = process.argv.slice(2);
if (mode === 'prompt') {
  const argv = fs.readFileSync(a, 'utf8').split('\0');
  const prompt = argv[argv.indexOf('-p') + 1] || '';
  for (const m of prompt.matchAll(/`(git [^`]*)`/g)) console.log(m[1].replace(/<[^<>]*>/g, 'x'));
  process.exit(0);
}
const perms = JSON.parse(fs.readFileSync(a, 'utf8')).permissions;
const body = (r) => (/^Bash\((.*)\)$/s.exec(r) || [])[1];
const hit = (r, cmd) => {
  const p = body(r);
  if (p === undefined) return false;
  if (p.endsWith(':*')) { const pre = p.slice(0, -2); return cmd === pre || cmd.startsWith(`${pre} `); }
  if (p.includes('*')) return new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's').test(cmd);
  return cmd === p;
};
const ok = b.split(' | ').every((c) => perms.allow.some((r) => hit(r, c.trim())) && !perms.deny.some((r) => hit(r, c.trim())));
process.exit(ok ? 0 : 1);
EOF
TS="$T/state/workers/fix-thing.triage.settings.json"
permits(){ node "$T/match.js" allow "$TS" "$1"; }
# Every git command call n names is permitted (`git <subcommand>` is the generic form, not one).
prompt_git_ok(){ local n="$1" cmd bad=0 seen=0
  while IFS= read -r cmd; do
    [ "$cmd" = "git x" ] && continue
    seen=$((seen+1))
    if ! permits "$cmd"; then echo "     refused: $cmd"; bad=1; fi
  done < <(node "$T/match.js" prompt "$STUB_LOG.$n")
  [ "$seen" -ge 2 ] && [ "$bad" -eq 0 ]; }

cd "$T/repo" || exit 1
out=$(bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "lane A: triage succeeds though claude exits non-zero (|| true)" '[ $rc -eq 0 ]'
check "lane A: one claude call, no challenge"                           '[ -f "$STUB_LOG.0" ] && [ ! -f "$STUB_LOG.1" ]'
check "first pass receives every flag"                                  'flags_ok 0 3'
check "first pass output goes to /dev/null"                             '[ -f "$STUB_LOG.0" ] && [[ "$out" != *STUB-* ]]'
check "first pass: every git command it names runs under triage settings" 'prompt_git_ok 0'
check "first pass: names no git -C or fetch"                            '! node "$T/match.js" prompt "$STUB_LOG.0" | grep -qE "^git (-C|fetch)"'
check "AC1: the prompt asks for one of the four change kinds"           'tr "\0" "\n" < "$STUB_LOG.0" | grep -qF "\"change_kind\": \"relocate|schema|shared|surface\""'
for k in '' 'move'; do
  rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
  out=$(STUB_KIND="$k" bash "$B/triage.sh" fix-thing 2>&1); rc=$?
  check "AC1: a record whose change kind is '$k' is refused as malformed" '[ $rc -ne 0 ] && [[ "$out" == *"triage record is malformed"* ]]'
done
# DS-346: a branch with the convention's placeholder left in (DS-345's own triage output) is refused
# and not recorded; one git accepts is kept as written. The prompt names every placeholder.
for br in 'fix/DS-345-<slug>' 'fix/DS-345 two words' 'fix/DS-345..x'; do
  rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
  out=$(STUB_BRANCH="$br" bash "$B/triage.sh" fix-thing 2>&1); rc=$?
  check "DS-346 AC1: a record whose branch is '$br' is refused and not kept" \
    '[ $rc -ne 0 ] && [[ "$out" == *"triage record is malformed"* ]] && [ ! -f "$T/state/triage/fix-thing.json" ]'
done
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(STUB_BRANCH='fix/DS-345-triage-branch-placeholder' bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-346 AC2: a branch git accepts is kept as written" \
  '[ $rc -eq 0 ] && [ "$(jq -r .branch "$T/state/triage/fix-thing.json")" = fix/DS-345-triage-branch-placeholder ]'
check "DS-346: the prompt asks for every <...> placeholder to be filled" \
  'tr "\0" "\n" < "$STUB_LOG.0" | grep -qF "every other <...> placeholder filled in"'
cat >> "$T/config.md" <<'EOF'

## 5. Conventions
| Field | Value |
|---|---|
| Branch names | `<type>/<slug>` |
EOF
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-346: §5 Branch names reaches the prompt with its <slug> kept, not the repo slug" \
  'tr "\0" "\n" < "$STUB_LOG.0" | grep -qF "this repo'"'"'s branch convention, <type>/<slug>, with"'
check "triage settings: git ls-tree on any ref"                       'permits "git ls-tree -r --name-only origin/main -- desk" && permits "git ls-tree HEAD"'
check "triage settings: branch listing allowed"                         'permits "git branch -a" && permits "git branch -r" && permits "git branch --list -r"'
check "triage settings: branch -r/-a cannot delete"                     '! permits "git branch -r -d origin/x" && ! permits "git branch -a -D x" && ! permits "git branch -rd origin/x"'
check "triage settings: fetch and -C refused"                           '! permits "git fetch" && ! permits "git fetch origin" && ! permits "git -C /x log"'

rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
export STUB_LANE=C
out=$(bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "lane C: triage succeeds and challenges"                          '[ $rc -eq 0 ] && [ -f "$STUB_LOG.1" ]'
check "challenge receives every flag"                                   'flags_ok 1 2'
check "challenge output goes to /dev/null"                              '[ -f "$STUB_LOG.1" ] && [[ "$out" != *STUB-* ]]'
check "challenge: every git command it names runs under triage settings"  'prompt_git_ok 1'
check "challenge: names no git -C or fetch"                             '! node "$T/match.js" prompt "$STUB_LOG.1" | grep -qE "^git (-C|fetch)"'
check "challenge: a CONFIRM with no failed reads stays CONFIRM"           '[ "$(jq -r .lane_challenge.verdict "$T/state/triage/fix-thing.json")" = CONFIRM ]'

# A challenge whose code reads failed is INCONCLUSIVE, with the reads; a CONFIRM that lists failed
# reads is too, and neither changes the lane.
lc(){ jq -r "$@" "$T/state/triage/fix-thing.json"; }
for chal in '{"verdict":"INCONCLUSIVE","lane":"C","reason":"could not read","failed_reads":["git show main:a.ts: denied"]}' \
            '{"verdict":"CONFIRM","lane":"C","reason":"rests on the first pass","failed_reads":["git show main:a.ts: denied"]}'; do
  rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
  out=$(STUB_CHAL="$chal" bash "$B/triage.sh" fix-thing 2>&1); rc=$?
  check "challenge $(printf '%s' "$chal" | jq -r .verdict) with failed reads: INCONCLUSIVE, reads kept, lane kept" \
    '[ $rc -eq 0 ] && [ "$(lc .lane_challenge.verdict)" = INCONCLUSIVE ] && [ "$(lc ".lane_challenge.failed_reads[0]")" = "git show main:a.ts: denied" ] && [ "$(lc .lane)" = C ] && [ "$(lc .lane_original)" = null ]'
done
check "challenge prompt asks for INCONCLUSIVE and failed_reads" \
  'node -e "const a=require(\"fs\").readFileSync(process.argv[1],\"utf8\").split(\"\\0\"); const p=a[a.indexOf(\"-p\")+1]; process.exit(/INCONCLUSIVE/.test(p) && /failed_reads/.test(p) ? 0 : 1)" "$STUB_LOG.1"'

# DS-242: lane C only when a person must agree first. The lanes are the model's call, so the prompts
# carry the rules, and the record and the merge are checked against fixture outputs.
P0(){ tr "\0" "\n" < "$STUB_LOG.0"; }
P1(){ tr "\0" "\n" < "$STUB_LOG.1"; }
lc_ok(){ [ "$(lc .lane)" = "$1" ]; }
STEPS='"ben_steps":[{"step":"a cdk deploy","blocker":"deploy the stack, unblocking fix-thing"}]'
pkgs='"lane_reason":"two packages: apps/web, packages/ui"'

rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(STUB_LANE=A STUB_EXTRA=",$pkgs,$STEPS" bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-242 AC1: the first pass is told multi-package work at M or smaller is A or B, packages named" \
  'P0 | grep -qF "Spanning more than one app or package is not lane C at size M or smaller" && P0 | grep -qF "name the packages in \`lane_reason\`"'
check "DS-242 AC2: the first pass is told unmerged blockers hold the ticket and never change its lane" \
  'P0 | grep -qF "Unmerged blockers are not \"more than one sitting\"" && P0 | grep -qF "never change its lane" && ! P0 | grep -qF "and \`unknowns\` (which base to use)"'
check "DS-242 AC4: the first pass asks for ben_steps from the routing file list, the lane unchanged" \
  'P0 | grep -qF "\"ben_steps\": [{\"step\"" && P0 | grep -qF "Steps only the user can take" && P0 | grep -qF "rest of the ticket keeps the lane it would otherwise get"'
check "DS-242 AC1/AC4: a lane A record naming its packages and a person-only step is kept as written, no challenge" \
  '[ $rc -eq 0 ] && [ ! -f "$STUB_LOG.1" ] && lc_ok A && [ "$(lc .lane_reason)" = "two packages: apps/web, packages/ui" ] && [ "$(lc ".ben_steps[0].step")" = "a cdk deploy" ]'
for bad in '"ben_steps":"a cdk deploy"' '"ben_steps":[{"step":"a cdk deploy"}]' '"ben_steps":[{"step":"","blocker":"x"}]'; do
  rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
  out=$(STUB_LANE=A STUB_EXTRA=",$bad" bash "$B/triage.sh" fix-thing 2>&1); rc=$?
  check "DS-242 AC4: ben_steps $bad is refused as malformed" '[ $rc -ne 0 ] && [[ "$out" == *"triage record is malformed"* ]]'
done

# The challenge (AC5) on a lane C fixture: its prompt carries AC1 to AC3, a DOWNGRADE moves the ticket
# to A or B and keeps its ben_steps, and a CONFIRM on an L-sized ticket keeps C (AC3).
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(STUB_LANE=C STUB_EXTRA=",$STEPS" STUB_CHAL='{"verdict":"DOWNGRADE","lane":"A","reason":"size M, only signal is two packages: apps/web, packages/ui"}' bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-242 AC5: the challenge prompt applies AC1 to AC3" \
  'P1 | grep -qF "Spanning more than one app or package read as lane C" && P1 | grep -qF "Unmerged blockers read as \"more than one sitting\"" && P1 | grep -qF "A ticket sized L or" && P1 | grep -qF "downgrade it to A or B"'
check "DS-242 AC5: a lane C ticket failing AC1 is downgraded to A, ben_steps kept" \
  '[ $rc -eq 0 ] && lc_ok A && [ "$(lc .lane_original)" = C ] && [[ "$(lc .lane_reason)" == "downgraded from C at challenge: size M, only signal is two packages"* ]] && [ "$(lc ".ben_steps[0].step")" = "a cdk deploy" ]'
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(STUB_LANE=C STUB_EXTRA=",$STEPS" STUB_CHAL='{"verdict":"DOWNGRADE","lane":"B","reason":"only signal is a deploy","ben_steps":[{"step":"a cdk deploy","blocker":"again"},{"step":"create the IAM role","blocker":"create the role, unblocking fix-thing"},{"step":"x"}]}' bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-242 AC4/AC5: a step the challenge finds joins ben_steps on a downgrade, a repeat or malformed one does not" \
  '[ $rc -eq 0 ] && P1 | grep -qF "\"ben_steps\": [{\"step\"" && lc_ok B && [ "$(lc ".ben_steps | length")" = 2 ] && [ "$(lc ".ben_steps[0].blocker")" = "deploy the stack, unblocking fix-thing" ] && [ "$(lc ".ben_steps[1].step")" = "create the IAM role" ]'
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(STUB_LANE=C STUB_EXTRA=',"lane_reason":"size L feature: split into three stages"' STUB_CHAL='{"verdict":"CONFIRM","lane":"C","reason":"size L"}' bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-242 AC3: a confirmed L-sized lane C ticket stays C with the split it proposes" \
  '[ $rc -eq 0 ] && lc_ok C && [ "$(lc .lane_challenge.verdict)" = CONFIRM ] && [ "$(lc .lane_reason)" = "size L feature: split into three stages" ]'
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(AUTOPILOT_SKIP_CHALLENGE=1 STUB_LANE=C STUB_EXTRA=",$STEPS" bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-242: with AUTOPILOT_SKIP_CHALLENGE set, no challenge runs and the record is kept as written" \
  '[ $rc -eq 0 ] && [ ! -f "$STUB_LOG.1" ] && lc_ok C && [ "$(lc .lane_challenge)" = null ] && [ "$(lc ".ben_steps[0].step")" = "a cdk deploy" ]'

# AC6: the routing table's lane C row, its Lane C section and Stage 2 carry the same signals.
RT="$SRC/skills/desk-ticket/references/desk-ticket-routing.md"; S2="$SRC/skills/desk-ticket/references/stage-2-understand.md"
check "DS-242 AC6: lane C's row names L or XL, intermittent and wrong behaviour, and no package signal" \
  'row=$(grep "^| \*\*C\*\* |" "$RT") && [[ "$row" == *"sized L or XL"* ]] && [[ "$row" == *intermittent* ]] && [[ "$row" == *"looks wrong"* ]] && [[ "$row" != *package* ]]'
check "DS-242 AC6: the routing file lists the person-only steps and what is not lane C" \
  'grep -qF "### Steps only the user can take" "$RT" && grep -qF "a \`cdk deploy\`" "$RT" && grep -qF "**Blockers that have not merged.**" "$RT" && ! grep -qF "one spanning more than one app or package" "$RT"'
check "DS-242 AC6: Stage 2 commits lane C on the same signals" \
  'grep -qF "Commit lane C only on its own signals" "$S2" && grep -qF "M or smaller that spans several packages is lane A or B" "$S2"'

# DS-374: a change writing under .claude/ is lane C, whatever either pass said, since no grant lets a
# worker write there.
WP='the harness write-protects .claude/ for workers'
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(STUB_LANE=A STUB_EXTRA=',"lane_reason":"size S","files_in_scope":["CLAUDE.md",".claude/rules/api.md",".claude/rules/web.md"]' bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-374 AC1: the first pass is told a change under .claude/ is lane C, and why" \
  'P0 | grep -qF "A change that adds or edits any file under \`.claude/\` is lane C" && P0 | grep -qF "start \`lane_reason\` with \"$WP\""'
check "DS-374 AC1: a lane A record writing .claude/rules/ becomes lane C, its reason naming the write-protect" \
  '[ $rc -eq 0 ] && lc_ok C && [[ "$(lc .lane_reason)" == "$WP, so only an interactive desk-ticket session can write .claude/rules/api.md, .claude/rules/web.md; lane A before this rule" ]] && [ "$(lc .lane_original)" = null ]'
check "DS-374 AC1: a lane C lifted by the rule reads as confirmed, not as an unreviewed park" \
  '[ "$(lc .lane_challenge.verdict)" = CONFIRM ] && [ "$(lc .lane_challenge.reason)" = "$WP: lane C set by rule, not by the challenge" ]'
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(STUB_LANE=C STUB_EXTRA=',"lane_reason":"size L","files_in_scope":["apps/web/.claude/settings.json"]' STUB_CHAL='{"verdict":"DOWNGRADE","lane":"A","reason":"size M"}' bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-374 AC1: the challenge is told a change under .claude/ stays C" \
  'P1 | grep -qF "A change that adds or edits any file under \`.claude/\` stays C whatever its size"'
check "DS-374 AC1: a challenge downgrade of a .claude/ change is undone, with no lane_original left" \
  '[ $rc -eq 0 ] && lc_ok C && [[ "$(lc .lane_reason)" == "$WP, so only an interactive desk-ticket session can write apps/web/.claude/settings.json; lane A before this rule" ]] && [ "$(lc .lane_original)" = null ]'
check "DS-374 AC1: the undone downgrade leaves no DOWNGRADE challenge for plan-batch to read as unreviewed" \
  '[ "$(lc .lane_challenge.verdict)" = CONFIRM ] && [ "$(lc .lane_challenge.reason)" = "$WP: lane C set by rule, not by the challenge" ]'
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(STUB_LANE=C STUB_EXTRA=",\"lane_reason\":\"$WP: .claude/rules/a.md\",\"files_in_scope\":[\".claude/rules/a.md\"]" STUB_CHAL='{"verdict":"INCONCLUSIVE","lane":"C","reason":"could not read","failed_reads":["x"]}' bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-374 AC1: an inconclusive challenge on a .claude/ change leaves the lane confirmed by the rule, not unchecked" \
  '[ $rc -eq 0 ] && lc_ok C && [ "$(lc .lane_reason)" = "$WP: .claude/rules/a.md" ] && [ "$(lc .lane_challenge.verdict)" = CONFIRM ]'
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(STUB_LANE=C STUB_EXTRA=",\"lane_reason\":\"$WP: .claude/rules/a.md\",\"files_in_scope\":[\".claude/rules/a.md\"]" bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-374 AC1: a lane C record already giving the reason is kept as written" \
  '[ $rc -eq 0 ] && lc_ok C && [ "$(lc .lane_reason)" = "$WP: .claude/rules/a.md" ] && [ "$(lc .lane_challenge.reason)" = stub ]'
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(STUB_LANE=B STUB_EXTRA=',"lane_reason":"size S","files_in_scope":["docs/claude/rules.md","skills/x/.claude-plugin/plugin.json"]' bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-374 AC1: a path that only looks like .claude/ keeps its lane" \
  '[ $rc -eq 0 ] && lc_ok B && [ "$(lc .lane_reason)" = "size S" ]'

# The prompt names each linked canvas's snapshot, found by URL, so an epic's child in its
# feature batch reads the epic's snapshot under the repo state.
EPIC_URL=https://claude.ai/design/p/epic-boards; OWN_URL=https://claude.ai/design/p/own-boards; NONE_URL=https://claude.ai/design/p/no-snap
mkdir -p "$T/state/designs/EPIC-1/project" "$T/state/designs/fix-thing/project" "$T/state/batches/EPIC-1/tickets"
printf '{"url": "%s#board", "version": "3"}\n' "$EPIC_URL" > "$T/state/designs/EPIC-1/source.json"
printf '{"url": "%s", "version": "1"}\n' "$OWN_URL" > "$T/state/designs/fix-thing/source.json"
design_ticket(){ printf '# fix-thing\n\nSource: the user\n\n## Outcome\nFix the thing.\n\n## Design\nBuild it from %s\n' "$2" > "$1/tickets/fix-thing.md"; }
SNAP_UNKNOWNS=',"unknowns":["Ben: export or snapshot boards 4 and 5","Design board 2 is not snapshotted","which empty-state copy?","Should users be able to export boards as PDF?"]'
BS="$T/state/batches/EPIC-1"
design_ticket "$BS" "$EPIC_URL"
rm -f "$STUB_LOG".*
out=$(DESK_AUTOPILOT_STATE="$BS" DESK_STATE="$BS" STUB_LANE=A STUB_EXTRA="$SNAP_UNKNOWNS" bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-393 AC1: an epic child's prompt names the epic's snapshot under the repo state" \
  '[ $rc -eq 0 ] && P0 | grep -qF "  - $EPIC_URL: snapshotted, its boards under $T/state/designs/EPIC-1/project/." && ! P0 | grep -qF "$BS/designs/fix-thing"'
check "DS-393 AC2: the record keeps no unknown asking for the boards to be snapshotted, and keeps one about exporting boards as a feature" \
  '[ "$(jq -c .unknowns "$BS/triage/fix-thing.json")" = "[\"which empty-state copy?\",\"Should users be able to export boards as PDF?\"]" ] && [[ "$out" == *"dropped 2 unknown(s) asking for a snapshot"* ]]'
check "DS-393 AC2: the prompt says a snapshotted canvas raises no such unknown" \
  'P0 | grep -qF "raise no" && P0 | grep -qF "unknown, park or lane reason saying its boards are not snapshotted or need exporting."'
SNAP_REASON=',"lane_reason":"a new screen the canvas specifies, parked until boards 3 and 5 are snapshotted; Design board 2 is not snapshotted; size M"'
rm -f "$STUB_LOG".* "$BS/triage/fix-thing.json"
out=$(DESK_AUTOPILOT_STATE="$BS" DESK_STATE="$BS" STUB_LANE=D STUB_EXTRA="$SNAP_REASON" STUB_CHAL='{"verdict":"CONFIRM","lane":"D","reason":"stub"}' bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-393 AC2: a lane D record's park reason loses its ask for a snapshot, and keeps its lane and other signals" \
  '[ $rc -eq 0 ] && [ "$(jq -r .lane "$BS/triage/fix-thing.json")" = D ] && [ "$(jq -r .lane_reason "$BS/triage/fix-thing.json")" = "a new screen the canvas specifies; size M; every linked canvas is snapshotted or saved on the base" ] && [[ "$out" == *"dropped the lane D reason'"'"'s ask for a snapshot"* ]]'
design_ticket "$T/state" "$OWN_URL"
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(STUB_LANE=A bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-393 AC3: a single ticket's prompt names the snapshot under its own key" \
  '[ $rc -eq 0 ] && P0 | grep -qF "  - $OWN_URL: snapshotted, its boards under $T/state/designs/fix-thing/project/."'
design_ticket "$T/state" "$NONE_URL"
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(STUB_LANE=A STUB_EXTRA="$SNAP_UNKNOWNS" bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-393 AC4: with no snapshot the prompt says the design is unread" \
  '[ $rc -eq 0 ] && P0 | grep -qF "  - $NONE_URL: no snapshot." && P0 | grep -qF "otherwise it is unread, so say so in \`unknowns\`." && ! P0 | grep -qF "snapshotted, its boards"'
check "DS-393 AC4: and its unknowns about the snapshot are kept" '[ "$(jq ".unknowns | length" "$T/state/triage/fix-thing.json")" = 4 ]'
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(STUB_LANE=D STUB_EXTRA="$SNAP_REASON" STUB_CHAL='{"verdict":"CONFIRM","lane":"D","reason":"stub"}' bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-393 AC4: and a lane D reason waiting on the snapshot is kept" \
  '[ $rc -eq 0 ] && [ "$(jq -r .lane_reason "$T/state/triage/fix-thing.json")" = "a new screen the canvas specifies, parked until boards 3 and 5 are snapshotted; Design board 2 is not snapshotted; size M" ]'
printf '# fix-thing\n\nSource: the user\n\nFix the thing.\n' > "$T/state/tickets/fix-thing.md"
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(STUB_LANE=A bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-393: a ticket linking no canvas keeps the general rule" \
  '[ $rc -eq 0 ] && P0 | grep -qF "saved under $T/state/designs/fix-thing/project/ when the orchestrator could read"'

# DS-394: only a reserved topic or a call with no recommendation stays a question; already met is
# verify-only; what is already settled for the ticket rides in the prompt.
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
CALLS=',"unknowns":["a plain question",{"question":"what does the pro tier cost?","category":"money","options":["10 GBP","20 GBP"],"recommended":"10 GBP"},{"question":"which retry backoff?","category":"engineering","options":["fixed","exponential"],"recommended":"exponential"},{"question":"keep the old export?","category":"scope","options":["keep","drop"],"recommended":null}]'
out=$(STUB_LANE=A STUB_EXTRA="$CALLS" bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-394 AC2: the prompt asks for each unknown's category and recommendation, and takes a take-category call" \
  'P0 | grep -qF "\"recommended\": \"<one of options, or null>\"" && P0 | grep -qF "A take-category call with a recommendation" && P0 | grep -qF "\`user-fact\` for a fact only the user holds"'
check "DS-394 AC2/AC3: the record keeps only the questions for the user in unknowns, as strings" \
  '[ $rc -eq 0 ] && [ "$(lc -c .unknowns)" = "[\"a plain question\",\"what does the pro tier cost?\",\"keep the old export?\"]" ]'
check "DS-394 AC2: the call taken on its recommendation goes to decided" \
  '[ "$(lc -c .decided)" = "[{\"question\":\"which retry backoff?\",\"options\":[\"fixed\",\"exponential\"],\"chose\":\"exponential\",\"category\":\"engineering\"}]" ] && [[ "$out" == *"took 1 call(s) on their recommendation"* ]]'
check "DS-394 AC4: the prompt says already met is verify-only, proved with tests, and never an unknown" \
  'P0 | grep -qF "\"Already fixed\" is not a lane, and not a question." && P0 | grep -qF "proves each" && P0 | grep -qF "none of this goes in \`unknowns\`" && P0 | grep -qF "\"verify_only\": <true only when every acceptance criterion is in already_met>"'
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(STUB_LANE=A STUB_EXTRA=',"verify_only":true,"already_met":["AC1: src/a.js:12"]' bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-394 AC4: a record with every criterion met stays verify-only" '[ $rc -eq 0 ] && [ "$(lc .verify_only)" = true ] && [ "$(lc -c .already_met)" = "[\"AC1: src/a.js:12\"]" ]'
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(STUB_LANE=A STUB_EXTRA=',"verify_only":true' bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-394 AC4: verify-only naming no met criterion is not verify-only" '[ $rc -eq 0 ] && [ "$(lc .verify_only)" = false ] && [ "$(lc -c .already_met)" = "[]" ]'
check "DS-394 AC5: with nothing recorded, the prompt has no settled section" '! P0 | grep -qF "Already settled for fix-thing"'
mkdir -p "$T/state/briefings"
printf '# Briefing for fix-thing\n\n## Answer from the user (2026-11-01T06:28:00Z)\n\nAC2 holds already: build AC1 only.\n' > "$T/state/briefings/fix-thing.md"
printf '%s\n' '{"id":"a","ticket":"fix-thing","question":"which retry backoff?","options":["fixed","exponential"],"chose":"exponential","category":"engineering"}' \
  '{"id":"b","ticket":"other","question":"not this ticket","options":["x","y"],"chose":"x","category":"scope"}' > "$T/state/decisions.jsonl"
rm -f "$STUB_LOG".* "$T/state/triage/fix-thing.json"
out=$(STUB_LANE=A bash "$B/triage.sh" fix-thing 2>&1); rc=$?
check "DS-394 AC5: a re-triage prompt carries the recorded answer and calls, and binds them" \
  '[ $rc -eq 0 ] && P0 | grep -qF "**Already settled for fix-thing.** These bind: raise no unknown they answer, on the same acceptance" && P0 | grep -qxF "AC2 holds already: build AC1 only." && P0 | grep -qxF -- "- which retry backoff?: took \"exponential\" (engineering)"'
check "DS-394 AC5: another ticket's calls are left out" '! P0 | grep -qF "not this ticket"'
rm -rf "$T/state/briefings" "$T/state/decisions.jsonl"

check "shellcheck: no flag parsed as a command (SC2215) in desk/bin" \
  '! command -v shellcheck >/dev/null || ! shellcheck -S warning -f gcc "$B"/*.sh 2>/dev/null | grep -q SC2215'

echo "triage: $PASS passed, $FAIL failed"; rm -rf "$T"; [ "$FAIL" -eq 0 ]
