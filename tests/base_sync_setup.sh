# shellcheck shell=bash
# Sourced by every tests/test_base_sync*.sh suite: the setup they share. pass.mjs with a batch base:
# every pass makes the base its own worktree, and a pass that will spawn, or finds the base behind
# main, first merges main into the base and pushes it. Each case has its own throwaway origin, copied
# from a template built once per run (tests/lib/repo_template.sh); the real pass.mjs runs with stub
# claude, gh, setup-worktree and spawn-worker. Scratch HOME only. A suite needs nothing but this.
# shellcheck disable=SC2034  # the variables and helpers here are read by the suite that sources this
set -u
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; SRC="$(cd "$S/.." && pwd)"; B="$SRC/desk/bin"
T="$(mktemp -d)"; mkdir -p "$T/home" "$T/desk/bin" "$T/stub"
trap 'rm -rf "$T"' EXIT
export HOME="$T/home" GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1; : > "$GIT_CONFIG_GLOBAL"
git config --global user.email t@example.com; git config --global user.name t
git config --global init.defaultBranch main
# An autopilot worker inherits spawn-worker's exports, which would point this suite at the real repo.
unset DESK_REPO_OVERRIDE DESK_SLUG DESK_STATE DESK_REPO_DIR DESK_REPO_ROOT DESK_WORKTREES_DIR DESK_DEFAULT_BRANCH \
  CLAUDE_CODE_SESSION_ID AUTOPILOT_DRY_RUN AUTOPILOT_RERUN AUTOPILOT_PORT_FLOOR AUTOPILOT_BATCH_BUDGET_USD \
  AUTOPILOT_USER_APPROVED AUTOPILOT_BASE_PUSH_APPROVED DESK_GH_REPO DESK_GITHUB_HANDLE CLAUDE_CONFIG_DIR DESK_SUBSCRIPTIONS \
  AUTOPILOT_BASE_BEHIND_MAX
PASS=0; FAIL=0
check(){ if eval "$2"; then PASS=$((PASS+1)); echo "ok   $1"; else FAIL=$((FAIL+1)); echo "FAIL $1"; echo "     out: ${out:-}"; fi; }
# finish <name>: the suite's last line, and its exit status.
finish(){ echo "base sync $1: $PASS passed, $FAIL failed"; cd /; rm -rf "$T"; [ "$FAIL" -eq 0 ]; }

# shellcheck source=link_bin.sh
. "$S/link_bin.sh"; link_bin "$B" "$T/desk/bin"
cat > "$T/desk/bin/setup-worktree.sh" <<'EOF'
mkdir -p "$DESK_WORKTREES_DIR/$2"; echo "[setup-worktree] worktree=$DESK_WORKTREES_DIR/$2"; echo "[setup-worktree] branch=$3"
EOF
cat > "$T/desk/bin/spawn-worker.sh" <<EOF
if [ "\$3" = preflight ]; then echo "[preflight] pass"; else echo "\$1 \$2 \${AUTOPILOT_BRANCH:-} \${AUTOPILOT_TASK:-}\${AUTOPILOT_RESUME:+RESUME session=\$3 \$AUTOPILOT_RESUME}" >> "$T/spawns"; echo "[spawn] ticket=\$1"; fi
EOF
# The session registry: $T/agents.json when it exists, else empty.
printf '#!/bin/sh\ncat "%s/agents.json" 2>/dev/null || echo "[]"\n' "$T" > "$T/stub/claude"
printf '#!/bin/sh\nexit 0\n' > "$T/stub/gh"
# kill records the pid it was asked to stop, and stops nothing.
printf '#!/bin/sh\necho "$@" >> "%s/kills"\n' "$T" > "$T/stub/kill"
# git, but the first push to feat/x first moves origin's feat/x on (what the merge driver does when it
# merges a PR into the base between the sync's fetch and its push). Armed by $T/race.arm, which holds the clone to push from.
REAL_GIT=$(command -v git)
cat > "$T/stub/git" <<EOF
#!/bin/sh
case " \$* " in *" push "*"refs/heads/feat/x"*)
  if [ -f "$T/race.arm" ]; then d=\$(cat "$T/race.arm"); rm -f "$T/race.arm"
    "$REAL_GIT" -C "\$d" commit -q --allow-empty -m "merged by the driver" && "$REAL_GIT" -C "\$d" push -q origin HEAD:feat/x; fi ;;
esac
exec "$REAL_GIT" "\$@"
EOF
chmod +x "$T/stub/claude" "$T/stub/gh" "$T/stub/git" "$T/stub/kill"
export PATH="$T/stub:$PATH" DESK_HOME="$T/desk" AUTOPILOT_MIN_AVAIL_GB=0 AUTOPILOT_HEALTH_CHECKS=off AUTOPILOT_ORCHESTRATOR=test

# The repos every case starts from: an origin holding main and feat/x, with main two commits ahead,
# and a primary checkout on main. Built once per run, whichever base sync suite asks first.
# shellcheck source=lib/repo_template.sh
. "$S/lib/repo_template.sh"; export REPO_TPL_ROOT="${REPO_TPL_ROOT:-$T/tpl}"
base_sync_repos(){
  git init -q --bare "$1/origin.git" && git init -q "$1/repo" && git -C "$1/repo" remote add origin "$1/origin.git" &&
  echo base > "$1/repo/a.txt" && git -C "$1/repo" add a.txt && git -C "$1/repo" commit -q -m init &&
  git -C "$1/repo" push -q origin main main:feat/x &&
  git -C "$1/repo" commit -q --allow-empty -m one && git -C "$1/repo" commit -q --allow-empty -m two &&
  git -C "$1/repo" push -q origin main
}
repo_template base_sync base_sync_repos || exit 1
# fresh <case> [batch-base-push value] [base]: a copy of those repos, and a queue with one triaged
# ticket. No base when <base> is -.
fresh(){
  C="$T/$1"; mkdir -p "$C/state" "$C/wt"
  repo_copy base_sync "$C" || exit 1
  local perm=${2:-yes}
  cat > "$C/config.md" <<EOF
## 0. Repo
| Field | Value |
|---|---|
| GitHub repo | \`acme/widgets\` |
| Default branch | \`main\` |

## 2. Paths
| Field | Value |
|---|---|
| Primary repo root | \`$C/repo\` |
| Worktrees directory | \`$C/wt\` |

## 3. Permissions
| Key | Capability | Recommended | Your setting |
|---|---|---|---|
| \`autopilot-workers\` | Run detached headless workers | \`yes\` | \`yes\` |
| \`batch-base-push\` | Push to a batch base | \`ask\` | \`$perm\` |
EOF
  [ "$perm" = unset ] && grep -v batch-base-push "$C/config.md" > "$C/c" && command cat "$C/c" > "$C/config.md"
  export DESK_CONFIG="$C/config.md" DESK_AUTOPILOT_STATE="$C/state" DESK_QUEUE="$C/queue.json" DESK_WORKTREES_DIR="$C/wt"
  cd "$C/repo" || exit 1
  node "$B/queue.mjs" init t >/dev/null
  [ "${3:-feat/x}" = - ] || node "$B/queue.mjs" set-batch "base=${3:-feat/x}" >/dev/null
  node "$B/queue.mjs" add T-1 >/dev/null; node "$B/queue.mjs" set T-1 state=triaged branch=feat/T-1 >/dev/null
}
# feature: plan-batch seeded the batch in feature mode (the queue's epic has a filed spine).
feature(){ node "$B/queue.mjs" set-batch epic=E-1 feature=true >/dev/null; echo '{"epic":"E-1","spine":"T-0"}' > "$C/state/feature.json"; }
# conflict: main and feat/x both change a.txt.
conflict(){
  git -C "$C/repo" fetch -q origin; git -C "$C/repo" switch -q -c side origin/feat/x
  echo theirs > a.txt; git -C "$C/repo" commit -q -am base-side; git -C "$C/repo" push -q origin HEAD:feat/x
  git -C "$C/repo" switch -q main; echo ours > a.txt; git -C "$C/repo" commit -q -am main-side; git -C "$C/repo" push -q origin main
  git -C "$C/repo" branch -q -D side
}
# shellcheck source=age_probes.sh
. "$S/age_probes.sh"
pass(){ age_probes; out=$(node "$B/pass.mjs" 2>&1); rc=$?; }
origin_has_main(){ git -C "$C/origin.git" merge-base --is-ancestor main feat/x; }
origin_tip(){ git -C "$C/origin.git" rev-parse feat/x; }
BWT='$C/wt/base-feat-x'

# DS-320: where §3 pr-conflict-unreviewed is yes, a base conflict goes to a conflict fix worker in the
# base worktree. fixrow <value> adds the row; ended <marker line> writes the worker's last turn.
fixrow(){ printf '| `pr-conflict-unreviewed` | Resolve a merge conflict before any human has reviewed it | `yes` | `%s` |\n' "$1" >> "$C/config.md"; }
ended(){ node -e 'console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: process.argv[1] }] } })); console.log(JSON.stringify({ type: "result" }))' "$1" >> "$C/state/logs/base-feat-x.log"; }
live(){ jq -n --arg s "$(jq -r .base_fix.running "$DESK_QUEUE")" '[{sessionId: $s, pid: 1}]' > "$T/agents.json"; }
# resolve: what the worker does, from a clone: merge main into feat/x, keep both sides, push.
resolve(){
  git clone -q "$C/origin.git" "$C/fixer"; git -C "$C/fixer" switch -q feat/x
  git -C "$C/fixer" merge -q --no-edit origin/main >/dev/null 2>&1; printf 'ours\ntheirs\n' > "$C/fixer/a.txt"
  git -C "$C/fixer" add a.txt; git -C "$C/fixer" commit -q --no-edit; git -C "$C/fixer" push -q origin feat/x
}
# A worker at a usage limit. The claude stub answers the pass's one probe call with no answer, so a
# probe never lifts a limit unless probe_ok is set. limit_event <reset>: the worker's log meets the
# 5-hour limit, resetting at <reset>; age_log ages the log, so an exit is not read as a worker the
# registry has not caught up with.
limit_event(){ node -e 'const e = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); e.rate_limit_info.resetsAt = Number(process.argv[2]); console.log(JSON.stringify(e))' "$S/fixtures/usage-limit-five-hour.json" "$1" >> "$C/state/logs/base-feat-x.log"; }
age_log(){ touch -t 202001010000 "$C/state/logs/base-feat-x.log"; }
probe_ok(){ printf '#!/bin/sh\nif [ "$1" = -p ]; then echo "{\\"type\\":\\"result\\",\\"is_error\\":false,\\"result\\":\\"ok\\"}"; exit 0; fi\ncat "%s/agents.json" 2>/dev/null || echo "[]"\n' "$T" > "$T/stub/claude"; }
probe_off(){ printf '#!/bin/sh\ncat "%s/agents.json" 2>/dev/null || echo "[]"\n' "$T" > "$T/stub/claude"; }
