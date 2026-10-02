#!/usr/bin/env bash
# Installs the desk-* Claude Code skills and the environment they expect, once per machine.
# Per-repo settings are not written here: run /desk-setup inside each repo.
#
#   ./install.sh           asks before settings.json, plugins, a foreign desk-jira, the Playwright patch
#   ./install.sh --yes     accepts those prompts too, except large downloads (scripted re-install)
#   ./install.sh --check   reports dependencies and any skill ~/.claude/skills cannot reach, changes nothing
#
# Safe to re-run. desk-owned files (the skills, ~/.claude/desk/bin, desk-env and desk-jira in
# ~/.local/bin, the hook script) are written without asking and listed at the end; a copy you edited
# is backed up first. Repo configs under ~/.config/desk/repos are never touched. settings.json is
# backed up before it is touched.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
CLAUDE_DIR="$HOME/.claude"
AGENTS="$HOME/.agents/skills"
SKILLS_LINK="$CLAUDE_DIR/skills"
DESKDIR="$CLAUDE_DIR/desk"
PRISTINE="$HOME/.agents/.desk-pristine"   # what the last install wrote, to tell your edits from ours
BACKUP="$HOME/.agents/desk-backup/$TS"
CONFIG_ROOT="${DESK_CONFIG_ROOT:-$HOME/.config/desk}"
SETTINGS="$CLAUDE_DIR/settings.json"
HOOK="$CLAUDE_DIR/hooks/deny-ai-attribution.py"
PROFILE_DIR="$HOME/.cache/ms-playwright-mcp/desk-profile"

PLUGINS="vercel@claude-plugins-official superpowers@claude-plugins-official frontend-design@claude-plugins-official code-review@claude-plugins-official code-simplifier@claude-plugins-official playwright@claude-plugins-official codex@openai-codex"

YES=0
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=1 ;;
    --check) CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux) OS=linux; grep -qi microsoft /proc/version 2>/dev/null && OS=wsl ;;
  *) OS=other ;;
esac

MISSING=0
WARNINGS=0
section() { printf '\n== %s\n' "$1"; }
ok()      { printf '  ok    %s\n' "$1"; }
warn()    { printf '  WARN  %s\n' "$1"; WARNINGS=$((WARNINGS + 1)); }
bad()     { printf '  MISS  %s\n' "$1"; MISSING=$((MISSING + 1)); }
note()    { printf '        %s\n' "$1"; }
has()     { command -v "$1" >/dev/null 2>&1; }
WROTE=""
wrote()   { WROTE="$WROTE        $1
"; }
# resolved <path> — the physical directory a path lands on, empty if it lands nowhere
resolved() { (cd -P "$1" 2>/dev/null && pwd) || true; }
SETTINGS_BACKED_UP=""
backup_settings() {
  [ -n "$SETTINGS_BACKED_UP" ] && return 0
  if [ -f "$SETTINGS" ]; then cp -p "$SETTINGS" "$SETTINGS.bak-desk-$TS"; note "backup: $SETTINGS.bak-desk-$TS"; fi
  SETTINGS_BACKED_UP=1
}
show_err() { printf '%s\n' "$1" | tail -n 6 | sed 's/^/        | /'; }
# Every JSON write below execs this: it replaces the file a path resolves to (a symlinked
# settings.json stays a symlink), from a temp file beside it that carries the file's mode.
DESK_WRITE_JSON_PY="$(cat <<'PY'
import json, os, shutil, tempfile
def write_json(path, data):
    real = os.path.realpath(path)
    folder = os.path.dirname(real)
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".desk-", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        if os.path.exists(real):
            shutil.copymode(real, tmp)
        else:
            mask = os.umask(0)
            os.umask(mask)
            os.chmod(tmp, 0o666 & ~mask)
        os.replace(tmp, real)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
PY
)"
export DESK_WRITE_JSON_PY
pick()    { if [ "$OS" = mac ]; then printf '%s' "$1"; else printf '%s' "$2"; fi; }

# check_links — every skill this installs must be reachable as ~/.claude/skills/<name>/SKILL.md, or
# Claude Code says "Unknown skill". The loops below link each one, yet on 2026-09-28 three were found
# unlinked, cause never reproduced, and nothing noticed; so the result is checked, not assumed.
# Read-only: `skills-upstream links` names each gap and its one-line fix. A gap is a WARN, like the
# unusable ~/.claude/skills case in "Skills": every other skill still works.
check_links() {
  section "Skill links  ~/.claude/skills -> ~/.agents/skills"
  if ! has python3 || [ ! -f "$SRC/vendor/sources.json" ]; then note "python3 or vendor/sources.json missing; not checked"; return 0; fi
  local out rc=0
  out="$(python3 "$SRC/bin/skills-upstream" links 2>&1)" || rc=$?
  if [ "$rc" = 0 ]; then
    ok "$(printf '%s\n' "$out" | tail -n 1)"
  else
    printf '%s\n' "$out" | sed '$d' | sed 's/^/        /'
    warn "$(printf '%s\n' "$out" | tail -n 1)"
  fi
}

have_tty() { { : </dev/tty; } 2>/dev/null; }

# confirm "question" [big]  — big=1 means --yes does not accept it on your behalf
confirm() {
  if [ "$YES" = 1 ] && [ "${2:-0}" != 1 ]; then printf '  ?     %s [y/N] y (--yes)\n' "$1"; return 0; fi
  if ! have_tty; then printf '  skip  %s (no terminal to ask on)\n' "$1"; return 1; fi
  local reply=""
  printf '  ?     %s [y/N] ' "$1"
  read -r reply </dev/tty || reply=""
  case "$reply" in y|Y|yes|Yes|YES) return 0 ;; *) return 1 ;; esac
}

# need <cmd> <required:1|0> <mac hint> <linux hint> [why]
need() {
  if has "$1"; then ok "$1  ($(command -v "$1"))"; return 0; fi
  local msg
  msg="$1 not found. Install: $(pick "$3" "$4")"
  [ -n "${5:-}" ] && msg="$msg  - $5"
  if [ "$2" = 1 ]; then bad "$msg"; else warn "$msg"; fi
  return 1
}

# install_file <src> <dest> — keeps a copy of <dest> if you had edited it since the last install
install_file() {
  local src="$1" dest="$2" rel pristine
  rel="${dest#"$HOME"/}"
  pristine="$PRISTINE/$rel"
  if [ -f "$dest" ] && ! cmp -s "$src" "$dest"; then
    if [ ! -f "$pristine" ] || ! cmp -s "$dest" "$pristine"; then
      mkdir -p "$(dirname "$BACKUP/$rel")"
      cp -p "$dest" "$BACKUP/$rel"
      note "your edited ~/$rel was saved to $BACKUP/$rel"
      wrote "backup   ~/$rel -> $BACKUP/$rel (your edit)"
    fi
  fi
  mkdir -p "$(dirname "$dest")" "$(dirname "$pristine")"
  cp "$src" "$dest"
  cp "$src" "$pristine"
}

# Python bytecode is build output, never shipped: not copied, and not counted as an edit.
DIFF_X=(-x __pycache__ -x '*.pyc')
prune_bytecode() { find "$1" \( -name __pycache__ -o -name '*.pyc' \) -prune -exec rm -rf {} + 2>/dev/null || true; }

# install_dir <src dir> <dest dir> — same, for a whole skill directory
install_dir() {
  local src="${1%/}" dest="${2%/}" rel pristine
  rel="${dest#"$HOME"/}"
  pristine="$PRISTINE/$rel"
  if [ -d "$dest" ] && ! diff -rq "${DIFF_X[@]}" "$src" "$dest" >/dev/null 2>&1; then
    if [ ! -d "$pristine" ] || ! diff -rq "${DIFF_X[@]}" "$dest" "$pristine" >/dev/null 2>&1; then
      mkdir -p "$(dirname "$BACKUP/$rel")"
      cp -R "$dest" "$BACKUP/$rel"
      note "your edited ~/$rel was saved to $BACKUP/$rel"
      wrote "backup   ~/$rel -> $BACKUP/$rel (your edit)"
    fi
  fi
  rm -rf "${dest:?}" "${pristine:?}"
  mkdir -p "$(dirname "$dest")" "$(dirname "$pristine")"
  cp -R "$src" "$dest"
  cp -R "$src" "$pristine"
  prune_bytecode "$dest"
  prune_bytecode "$pristine"
}

echo "desk-skills installer  ($SRC)"
echo "platform: $OS"

# ---------------------------------------------------------------------------------------------
section "Dependencies"

need curl 1 "ships with macOS" "sudo apt install curl" "desk-jira and the Claude Code installer use it" || true
need claude 1 "curl -fsSL https://claude.ai/install.sh | bash" "curl -fsSL https://claude.ai/install.sh | bash" || true
need git 1 "xcode-select --install" "sudo apt install git" || true
need jq 1 "brew install jq" "sudo apt install jq" || true
need python3 1 "brew install python" "sudo apt install python3" || true
need node 1 "brew install node, or Node 24 from your version manager (nvm, fnm, mise)" \
  "Node 24 from your version manager (nvm, fnm, mise) or https://nodejs.org/en/download" \
  "the autopilot and clearance scripts are Node" || true

if need gh 1 "brew install gh" "see https://github.com/cli/cli/blob/trunk/docs/install_linux.md"; then
  if status="$(gh auth status -h github.com 2>&1)"; then
    scopes="$(printf '%s\n' "$status" | sed -n 's/.*Token scopes: //p' | head -n 1)"
    if [ -z "$scopes" ]; then
      warn "gh is signed in but its token scopes are unreadable (fine-grained token or GH_TOKEN?). The skills need repo + workflow."
    else
      for s in repo workflow; do
        case "$scopes" in
          *"'$s'"*) ok "gh token has the $s scope" ;;
          *) warn "gh token lacks '$s'. Run: gh auth refresh -h github.com -s $s"
             [ "$s" = workflow ] && note "without it, updating any PR branch that touches .github/workflows fails, merge and rebase alike" ;;
        esac
      done
    fi
  else
    bad "gh is not signed in. Run: gh auth login -h github.com -s repo,workflow"
  fi
fi

# Some repos pin node and other tools through mise; /desk-setup detects that per repo and writes
# `mise exec --` as the repo's command prefix, because agent shells often miss mise's PATH injection.
need mise 0 "brew install mise" "curl https://mise.run | sh" "only for repos that pin tools through mise" || true

if need codex 0 "brew install --cask codex, or npm i -g @openai/codex" \
    "npm i -g @openai/codex" "cross-vendor refutation in local review and autopilot"; then
  note "codex --version and codex login status pass even on a seat with no usage left; only a real call proves it."
  if [ "$CHECK_ONLY" = 1 ]; then
    note "no real codex call under --check; run ./install.sh without it, or /desk-setup, to make one"
  elif confirm "Make one real codex call to prove it can answer?"; then
    if out="$(cd "$SRC" && codex exec --sandbox read-only "Reply with exactly: CODEX_OK" </dev/null 2>&1)" \
        && printf '%s' "$out" | grep -q CODEX_OK; then
      ok "codex answered"
    else
      warn "codex did not answer: $(printf '%s' "$out" | tail -n 2 | tr '\n' ' ')"
      note "run 'codex login' and pick the seat you use for this work; 'start a free trial of Plus' means that seat has no plan"
    fi
  fi
fi

if [ "$OS" = mac ] && ! has flock; then
  note "flock not installed: fine on macOS, where with-lock.sh falls back to an atomic mkdir lock (brew install flock to use flock instead)"
else
  need flock 0 "brew install flock" "sudo apt install util-linux" "autopilot serialises test suites box-wide with it" || true
fi
need lsof 0 "ships with macOS" "sudo apt install lsof" "cleanup and dev find port and worktree owners with it" || true

if [ "$CHECK_ONLY" = 1 ]; then
  check_links
  printf '\n%s missing, %s warnings. Nothing was changed (--check).\n' "$MISSING" "$WARNINGS"
  exit 0
fi
if [ "$MISSING" -gt 0 ]; then
  printf '\n%s required tool(s) missing. Install them (hints above) and re-run; nothing was changed.\n' "$MISSING"
  exit 1
fi

# ---------------------------------------------------------------------------------------------
section "Skills  -> ~/.agents/skills, linked into ~/.claude/skills"

mkdir -p "$AGENTS"
AGENTS_REAL="$(resolved "$AGENTS")"
[ -e "$SKILLS_LINK" ] || [ -L "$SKILLS_LINK" ] || mkdir -p "$SKILLS_LINK"
# each: one link per skill · same: ~/.claude/skills already IS ~/.agents/skills · none: unusable
LINK_MODE=each
case "$(resolved "$SKILLS_LINK")" in
  "") LINK_MODE=none; warn "your ~/.claude/skills is not a directory (a broken link?); skills installed but not linked" ;;
  "$AGENTS_REAL") LINK_MODE=same; ok "your ~/.claude/skills resolves to ~/.agents/skills; no per-skill links needed" ;;
esac

shipped=" "
count=0
vcount=0
# desk's own skills, then the third-party skills pinned in vendor/ (vendor/sources.json says where
# each came from). Either way ~/.agents/skills/<name> is the ONE real copy and ~/.claude/skills/<name>
# is a link to it; a loose real copy found in ~/.claude/skills is moved to the backup first.
for dir in "$SRC"/skills/desk-*/ "$SRC"/vendor/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  case "$dir" in "$SRC"/vendor/*) vcount=$((vcount + 1)) ;; *) shipped="$shipped$name " ;; esac
  install_dir "$dir" "$AGENTS/$name"
  count=$((count + 1))
  if [ "$LINK_MODE" = each ]; then
    link="$SKILLS_LINK/$name"
    target="$(resolved "$AGENTS/$name")"
    if [ -n "$target" ] && [ "$(resolved "$link")" = "$target" ]; then
      :   # already lands on the installed copy (a relative link, or a linked parent)
    else
      if [ -e "$link" ] && [ ! -L "$link" ]; then
        mkdir -p "$BACKUP/.claude/skills"
        mv "$link" "$BACKUP/.claude/skills/$name"
        note "a real directory at ~/.claude/skills/$name was moved to $BACKUP/.claude/skills/"
        wrote "moved    ~/.claude/skills/$name (a real directory) -> $BACKUP/.claude/skills/$name"
      fi
      ln -sfn "$AGENTS/$name" "$link"
    fi
  fi
  ok "$name"
done
# The config template, where /desk-setup reads it to find rows a newer version added.
TEMPLATE="$AGENTS/desk-setup/references/desk-config.template.md"
[ -d "$AGENTS/desk-setup" ] && install_file "$SRC/desk-config.md" "$TEMPLATE"
wrote "skills   ~/.agents/skills/desk-* and $vcount vendored ($count, replaced wholesale)"
wrote "template ~/.agents/skills/desk-setup/references/desk-config.template.md (from desk-config.md)"
wrote "pristine ~/.agents/.desk-pristine (what this install wrote, to tell your edits from ours)"
[ "$LINK_MODE" = each ] && wrote "links    ~/.claude/skills/desk-* -> ~/.agents/skills"

# Stale: a desk-* skill this installer put there (pristine copy, or our link) that no longer ships.
stale=""
for d in "$AGENTS"/desk-*; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  case "$shipped" in *" $name "*) continue ;; esac
  if [ -d "$PRISTINE/.agents/skills/$name" ] \
     || { [ "$LINK_MODE" = each ] && [ -L "$SKILLS_LINK/$name" ] \
          && [ "$(resolved "$SKILLS_LINK/$name")" = "$(resolved "$d")" ]; }; then
    stale="$stale $name"
  fi
done
if [ -n "$stale" ]; then
  warn "no longer shipped:$stale"
  if confirm "Move them out of ~/.agents/skills and ~/.claude/skills (kept under $BACKUP)?"; then
    mkdir -p "$BACKUP/.agents/skills"
    for name in $stale; do
      [ "$LINK_MODE" = each ] && [ -L "$SKILLS_LINK/$name" ] && rm -f "$SKILLS_LINK/$name"
      mv "$AGENTS/$name" "$BACKUP/.agents/skills/$name"
      rm -rf "${PRISTINE:?}/.agents/skills/$name"
      ok "retired $name"
      wrote "moved    ~/.agents/skills/$name (retired) -> $BACKUP/.agents/skills/$name"
    done
  fi
fi

# ---------------------------------------------------------------------------------------------
section "Subagents and commands  -> ~/.claude/agents, ~/.claude/commands"

# User-level, so they load in every repo; each one reads the repo it is in (desk config, CLAUDE.md,
# the detected stack). A repo's own .claude/agents/<name>.md takes precedence over these.
# A same-named file this installer did not write (e.g. an older copy from another repo) is backed up
# under $BACKUP before it is replaced, by install_file.
for kind in agents commands; do
  [ -d "$SRC/$kind" ] || continue
  count=0
  for f in "$SRC/$kind"/*.md; do
    [ -f "$f" ] || continue
    install_file "$f" "$CLAUDE_DIR/$kind/$(basename "$f")"
    count=$((count + 1))
  done
  ok "$count $kind"
  wrote "$kind   ~/.claude/$kind ($count; a same-named copy you had is backed up first)"
done

# ---------------------------------------------------------------------------------------------
section "Your own skills  -> git clones in ~/.agents/skills, linked into ~/.claude/skills"

# vendor/sources.json entries of type "checkout" are skills you own: the one real copy is a git clone
# of that skill's repo (no copy in vendor/). This clones what is missing and never pulls; pulling is
# /desk-update's job, after showing what is incoming. A plain folder in the way is moved to the backup.
checkouts="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("\n".join(n+"\t"+e["source"]["repo"]+"\t"+",".join(e["source"].get("subskills",[])) for n,e in d["skills"].items() if e["source"]["type"]=="checkout"))' "$SRC/vendor/sources.json" 2>/dev/null || true)"
# link_skill <name> <real folder>: ~/.agents/skills/<name> and ~/.claude/skills/<name> end up pointing at it
link_skill() {
  local name="$1" real="$2" a="$AGENTS/$1"
  if [ "$(resolved "$a")" != "$(resolved "$real")" ]; then
    if [ -e "$a" ] && [ ! -L "$a" ]; then
      mkdir -p "$BACKUP/.agents/skills"; mv "$a" "$BACKUP/.agents/skills/$name"
      wrote "moved    ~/.agents/skills/$name -> $BACKUP/.agents/skills/$name"
    fi
    [ "$real" = "$a" ] || ln -sfn "$real" "$a"
  fi
  if [ "$LINK_MODE" = each ]; then
    local link="$SKILLS_LINK/$name"
    if [ "$(resolved "$link")" != "$(resolved "$real")" ]; then
      if [ -e "$link" ] && [ ! -L "$link" ]; then
        mkdir -p "$BACKUP/.claude/skills"; mv "$link" "$BACKUP/.claude/skills/$name"
        wrote "moved    ~/.claude/skills/$name (a real directory) -> $BACKUP/.claude/skills/$name"
      fi
      ln -sfn "$a" "$link"
    fi
  fi
}
while IFS="$(printf '\t')" read -r name repo subs; do
  [ -n "$name" ] || continue
  if [ -n "$subs" ]; then dest="$HOME/.agents/sources/$name"; else dest="$AGENTS/$name"; fi
  # Is it already the clone? The same exact github.com/owner/repo test `skills-upstream links` and
  # `verify` use, so the three can never disagree. Only a definite no (exit 1) moves a folder aside:
  # if the helper itself fails, leave the folder alone and say so.
  rc=0; python3 "$SRC/bin/skills-upstream" is-clone-of "$dest" "$repo" || rc=$?
  if [ "$rc" = 0 ]; then
    ok "$name (clone of $repo; /desk-update pulls it)"
  elif [ "$rc" != 1 ]; then
    warn "$name: could not tell whether ${dest/#$HOME/~} is a clone of $repo (skills-upstream is-clone-of exit $rc); left alone"
    continue
  else
    if [ -e "$dest" ] && [ ! -L "$dest" ]; then
      mkdir -p "$BACKUP/clones"; mv "$dest" "$BACKUP/clones/$name"
      wrote "moved    ${dest/#$HOME/~} (not a clone of $repo) -> $BACKUP/clones/$name"
    fi
    mkdir -p "$(dirname "$dest")"
    if out="$(gh repo clone "$repo" "$dest" -- -q 2>&1)"; then ok "$name cloned from $repo"; wrote "clone    ${dest/#$HOME/~} <- $repo"
    else warn "could not clone $repo (gh auth? repo access?)"; show_err "$out"; continue; fi
  fi
  if [ -n "$subs" ]; then
    n=0
    for sub in $(printf '%s' "$subs" | tr ',' ' '); do
      [ -f "$dest/$sub/SKILL.md" ] || { warn "$name: $sub has no SKILL.md upstream any more"; continue; }
      link_skill "$(basename "$sub")" "$dest/$sub"; n=$((n + 1))
    done
    ok "$name: $n skills linked from ${dest/#$HOME/~}"
  else
    link_skill "$name" "$dest"
  fi
done <<EOF
$checkouts
EOF

check_links

# ---------------------------------------------------------------------------------------------
section "Autopilot and clearance tooling  -> ~/.claude/desk/bin"

if [ -d "$SRC/desk/bin" ]; then
  mkdir -p "$DESKDIR/bin"
  count=0
  for f in "$SRC"/desk/bin/*; do
    [ -f "$f" ] || continue
    case "$f" in *.bak*|*.pyc) continue ;; esac
    install_file "$f" "$DESKDIR/bin/$(basename "$f")"
    chmod +x "$DESKDIR/bin/$(basename "$f")"
    count=$((count + 1))
  done
  ok "$count scripts (queue.json, workers/ and batch state are never touched)"
  wrote "scripts  ~/.claude/desk/bin ($count)"
  # desk-env on PATH: the skills run `desk-env where` to find the current repo's config.
  mkdir -p "$HOME/.local/bin"
  ENV_SHIM="$(mktemp)"
  printf '#!/usr/bin/env bash\n# Installed by desk-skills install.sh: the per-repo config resolver.\nexec node "%s" "$@"\n' \
    "$DESKDIR/bin/desk-env.mjs" > "$ENV_SHIM"
  install_file "$ENV_SHIM" "$HOME/.local/bin/desk-env"; rm -f "$ENV_SHIM"
  chmod +x "$HOME/.local/bin/desk-env"
  ok "desk-env -> ~/.local/bin (desk-env where: which repo config applies here)"
  wrote "desk-env ~/.local/bin/desk-env"
  # skills-upstream runs from this checkout (vendor/ lives here), so the shim records where it is.
  UP_SHIM="$(mktemp)"
  printf '#!/usr/bin/env bash\n# Installed by desk-skills install.sh: check and upgrade the pinned third-party skills.\nexec python3 "%s" "$@"\n' \
    "$SRC/bin/skills-upstream" > "$UP_SHIM"
  install_file "$UP_SHIM" "$HOME/.local/bin/skills-upstream"; rm -f "$UP_SHIM"
  chmod +x "$HOME/.local/bin/skills-upstream"
  printf '%s\n' "$SRC" > "$DESKDIR/source-checkout"
  ok "skills-upstream -> ~/.local/bin (runs from $SRC)"
  wrote "shim     ~/.local/bin/skills-upstream, ~/.claude/desk/source-checkout"
else
  note "this checkout ships no desk/bin; skipped"
fi

if [ -f "$SRC/bin/desk-jira" ]; then
  JIRA_DEST="$HOME/.local/bin/desk-jira"
  write_jira=1
  # Ours to refresh silently only if it is what the last install wrote; anything else is asked.
  if [ -e "$JIRA_DEST" ] && ! cmp -s "$SRC/bin/desk-jira" "$JIRA_DEST" \
     && { [ ! -f "$PRISTINE/.local/bin/desk-jira" ] || ! cmp -s "$JIRA_DEST" "$PRISTINE/.local/bin/desk-jira"; }; then
    note "your ~/.local/bin/desk-jira exists and is not the copy this installer last wrote (edited, or another tool's)"
    confirm "Replace it with this checkout's desk-jira (yours is backed up first)?" || write_jira=0
  fi
  if [ "$write_jira" = 1 ]; then
    install_file "$SRC/bin/desk-jira" "$JIRA_DEST"
    chmod +x "$JIRA_DEST"
    ok "desk-jira -> ~/.local/bin"
    wrote "desk-jira  ~/.local/bin/desk-jira"
  else
    warn "kept your ~/.local/bin/desk-jira; the skills expect this checkout's commands and flags"
  fi
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) warn "$HOME/.local/bin is not on your PATH; add it or the skills cannot find desk-jira" ;;
  esac
  first="$(command -v desk-jira 2>/dev/null || true)"
  [ -n "$first" ] && [ "$first" != "$JIRA_DEST" ] && warn "a different desk-jira comes first on PATH: $first"
  note "desk-jira is configured per repo by /desk-setup (site in the repo's config, email and token beside it)"
fi

# ---------------------------------------------------------------------------------------------
section "Commit-attribution hook"

install_file "$SRC/hooks/deny-ai-attribution.py" "$HOOK"
chmod +x "$HOOK"
ok "hook script -> ~/.claude/hooks/deny-ai-attribution.py"
wrote "hook     ~/.claude/hooks/deny-ai-attribution.py (script only; registering it is asked)"

# settings_hook <check|apply> — exit 0 registered/applied, 1 absent, 2 unreadable settings.json
settings_hook() {
  python3 - "$SETTINGS" "python3 \"$HOOK\"" "$1" <<'PY'
import json, os, sys
path, command, mode = sys.argv[1], sys.argv[2], sys.argv[3]
data = {}
if os.path.exists(path):
    try:
        with open(path) as f:
            raw = f.read()
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        sys.exit(2)
if not isinstance(data, dict):
    sys.exit(2)
pre = data.setdefault("hooks", {}).setdefault("PreToolUse", [])
present = any("deny-ai-attribution.py" in (h.get("command") or "")
              for entry in pre for h in (entry.get("hooks") or []))
if mode == "check" or present:
    sys.exit(0 if present else 1)
pre.append({"matcher": "Bash",
            "hooks": [{"type": "command", "command": command, "timeout": 10}]})
exec(os.environ["DESK_WRITE_JSON_PY"])
write_json(path, data)
PY
}

rc=0; settings_hook check || rc=$?
case "$rc" in
  0) ok "already registered in ~/.claude/settings.json" ;;
  2) warn "$SETTINGS is not valid JSON; fix it, then re-run to register the hook" ;;
  *)
    note "Registers a PreToolUse(Bash) hook at user level. Aimed at a repo whose desk config sets AI"
    note "attribution to forbidden (judged per subcommand, by the repo it targets): a git commit, merge,"
    note "tag or note message, a gh pr/issue/release or gh api body, or desk-jira text (inline, heredoc"
    note "or file, also inside bash -c or eval) carrying a Co-Authored-By trailer naming Claude or"
    note "Anthropic, Claude-Session, an Anthropic noreply address, a Claude session link, 'Generated with"
    note "Claude Code' or the robot emoji is denied. Other repos are untouched. Other hooks are kept."
    if confirm "Register it in ~/.claude/settings.json (backed up first)?"; then
      backup_settings
      if settings_hook apply; then ok "registered"; else warn "could not write ~/.claude/settings.json"; fi
    else
      note "not registered. To do it later, re-run ./install.sh"
    fi
    ;;
esac

# Claude Code's own attribution is a per-repo choice (config §5 AI attribution): /desk-setup
# writes it to the repo's .claude/settings.local.json where the repo forbids it. The hook above
# acts only in repos whose config says `forbidden`, so registering it changes nothing elsewhere.
note "AI attribution is decided per repo by /desk-setup; nothing is changed at user level here"

# Update notice: a SessionStart hook that, at most once a day, says when this checkout has new
# commits upstream. It only notifies; /desk-update shows what changed and installs it.
UPDATE_HOOK="$CLAUDE_DIR/hooks/desk-update-check.sh"
install_file "$SRC/hooks/desk-update-check.sh" "$UPDATE_HOOK"
chmod +x "$UPDATE_HOOK"
wrote "hook     ~/.claude/hooks/desk-update-check.sh (script only; registering it is asked)"
rc=0; python3 - "$SETTINGS" "$UPDATE_HOOK" check <<'PY' || rc=$?
import json, os, sys
path, cmd, mode = sys.argv[1:4]
try:
    data = json.load(open(path)) if os.path.exists(path) else {}
except Exception:
    sys.exit(2)
ss = data.setdefault("hooks", {}).setdefault("SessionStart", [])
present = any("desk-update-check.sh" in (h.get("command") or "") for e in ss for h in (e.get("hooks") or []))
sys.exit(0 if present else 1)
PY
case "$rc" in
  0) ok "update notice already registered (SessionStart)" ;;
  2) warn "$SETTINGS is not valid JSON; fix it, then re-run to register the update notice" ;;
  *)
    note "Registers a SessionStart hook: once a day it fetches this checkout (killed after 5 seconds)"
    note "and, if there are new commits, shows one line telling you to run /desk-update. Nothing is installed."
    if confirm "Register it in ~/.claude/settings.json (backed up first)?"; then
      backup_settings
      if python3 - "$SETTINGS" "$UPDATE_HOOK" <<'PY'
import json, os, sys
path, cmd = sys.argv[1:3]
data = json.load(open(path)) if os.path.exists(path) else {}
data.setdefault("hooks", {}).setdefault("SessionStart", []).append(
    {"hooks": [{"type": "command", "command": f'bash "{cmd}"', "timeout": 15}]})
exec(os.environ["DESK_WRITE_JSON_PY"])
write_json(path, data)
PY
      then ok "registered"; else warn "could not write ~/.claude/settings.json"; fi
    else
      note "not registered. To do it later, re-run ./install.sh (or answer it in /desk-update)"
    fi
    ;;
esac

# The deny-only plan (skills/desk-setup/references/baseline-deny.json): Slack send and write
# tools, gh pr merge --admin, and best-effort force, delete and mirror pushes. It only takes
# capability away, whatever /desk-setup is later answered.
HARNESS="$AGENTS/desk-setup/bin/harness-rules.py"
rc=0; python3 "$HARNESS" --settings "$SETTINGS" baseline --check >/dev/null 2>&1 || rc=$?
case "$rc" in
  0) ok "the always-on deny rules are already in ~/.claude/settings.json" ;;
  2) warn "$SETTINGS is not valid JSON; fix it, then re-run to add the always-on deny rules" ;;
  *)
    note "Adds deny rules at user level: the Slack connector's send and write tools (drafts stay"
    note "possible), gh pr merge --admin, and git push with --force, -f, +refspec, --delete, -d or"
    note "--mirror. The push patterns are best-effort: git also takes -qf, --forc, --delet. Other rules are kept."
    if confirm "Add them to ~/.claude/settings.json (backed up first)?"; then
      if out="$(python3 "$HARNESS" --settings "$SETTINGS" baseline 2>&1)"; then
        ok "deny rules added (recorded in ~/.claude/desk/harness-rules.json)"
      else
        warn "could not add the deny rules"; show_err "$out"
      fi
    else
      note "not added. /desk-setup adds them before it offers any allow rule"
    fi
    ;;
esac

# ---------------------------------------------------------------------------------------------
section "Claude Code plugins"

plugin_json="$(claude plugin list --json 2>/dev/null || echo '[]')"
missing_plugins=""
for p in $PLUGINS; do
  if printf '%s' "$plugin_json" | jq -e --arg id "$p" '.[] | select(.id == $id and .enabled)' >/dev/null 2>&1; then
    ok "$p"
  elif printf '%s' "$plugin_json" | jq -e --arg id "$p" '.[] | select(.id == $id)' >/dev/null 2>&1; then
    warn "$p is installed but disabled. Run: claude plugin enable $p"
  else
    missing_plugins="$missing_plugins $p"
  fi
done

if [ -n "$missing_plugins" ]; then
  note "missing:$missing_plugins"
  if confirm "Install them now, user scope?"; then
    if ! out="$(claude plugin marketplace add anthropics/claude-plugins-official 2>&1)"; then
      warn "could not add the claude-plugins-official marketplace (fine if it is already added)"; show_err "$out"
    fi
    case "$missing_plugins" in
      *@openai-codex*)
        if ! out="$(claude plugin marketplace add openai/codex-plugin-cc 2>&1)"; then
          warn "could not add the openai-codex marketplace (fine if it is already added)"; show_err "$out"
        fi ;;
    esac
    for p in $missing_plugins; do
      if out="$(claude plugin install "$p" --scope user 2>&1)"; then ok "installed $p"
      else warn "failed: claude plugin install $p --scope user"; show_err "$out"; fi
    done
  else
    note "to install by hand:"
    note "  claude plugin marketplace add anthropics/claude-plugins-official"
    note "  claude plugin marketplace add openai/codex-plugin-cc"
    for p in $missing_plugins; do note "  claude plugin install $p --scope user"; done
  fi
fi

# ---------------------------------------------------------------------------------------------
section "Playwright MCP"

# The plugin ships `npx @playwright/mcp@latest`. Inside a monorepo whose root package.json carries
# overrides, npm can die before the MCP handshake (CONNECTION_CLOSED), and the default
# `chrome` channel is not installed on most dev boxes. bunx, the bundled chromium and a pinned
# profile fix all three. A plugin update resets the file, so re-run this installer afterwards.
pw_files=""
pw_install="$(claude plugin list --json 2>/dev/null \
  | jq -r '.[] | select(.id == "playwright@claude-plugins-official") | .installPath' 2>/dev/null | head -n 1 || true)"
[ -n "$pw_install" ] && [ -f "$pw_install/.mcp.json" ] && pw_files="$pw_install/.mcp.json"
pw_market="$CLAUDE_DIR/plugins/marketplaces/claude-plugins-official/external_plugins/playwright/.mcp.json"
[ -f "$pw_market" ] && pw_files="$pw_files${pw_files:+
}$pw_market"

# Claude Code starts the MCP from whatever directory the session opened in, where mise may not put
# bun on PATH. So swap npx for bunx only if bunx runs from outside any checkout.
bunx_anywhere() { (cd / && command -v bunx >/dev/null 2>&1 && bunx --version >/dev/null 2>&1); }
USE_BUNX=0
bunx_anywhere && USE_BUNX=1

# mcp_patch <check|apply> <file> — exit 0 nothing to do/applied, 1 needs patch, 2 unreadable.
# Sets --browser chromium, adds a --user-data-dir if there is none, npx -> bunx when USE_BUNX=1.
# Every other arg the plugin ships is kept, in order.
mcp_patch() {
  python3 - "$2" "$PROFILE_DIR" "$1" "$USE_BUNX" <<'PY'
import json, os, sys
path, profile, mode, use_bunx = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
try:
    with open(path) as f:
        cfg = json.load(f)
except Exception:
    sys.exit(2)
servers = cfg.get("mcpServers", cfg)
srv = servers.get("playwright") if isinstance(servers, dict) else None
if not isinstance(srv, dict) or not isinstance(srv.get("args", []), list):
    sys.exit(2)
args = list(srv.get("args") or [])
new = list(args)
i = next((k for k, a in enumerate(new) if a == "--browser" or a.startswith("--browser=")), None)
if i is None:
    new += ["--browser", "chromium"]
elif new[i] == "--browser":
    if i + 1 < len(new) and not new[i + 1].startswith("-"):
        new[i + 1] = "chromium"
    else:
        new.insert(i + 1, "chromium")
else:
    new[i] = "--browser=chromium"
if not any(a == "--user-data-dir" or a.startswith("--user-data-dir=") for a in new):
    new += ["--user-data-dir", profile]
command = srv.get("command")
if use_bunx and command == "npx":
    command = "bunx"
    pkg = next((k for k, a in enumerate(new) if not a.startswith("-")), len(new))
    new = [a for k, a in enumerate(new) if k >= pkg or a not in ("-y", "--yes")]  # npx-only flags
if new == args and command == srv.get("command"):
    sys.exit(0)
if mode == "check":
    sys.exit(1)
srv["command"], srv["args"] = command, new
exec(os.environ["DESK_WRITE_JSON_PY"])
write_json(path, cfg)
PY
}

if [ -z "$pw_files" ]; then
  note "playwright plugin not installed; skipped"
else
  todo=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    rc=0; mcp_patch check "$f" || rc=$?
    case "$rc" in
      0) ok "already patched: ${f#"$HOME"/}" ;;
      2) warn "unreadable, left alone: $f" ;;
      *) todo="$todo${todo:+
}$f" ;;
    esac
  done <<EOF
$pw_files
EOF
  if [ -n "$todo" ]; then
    [ "$USE_BUNX" = 1 ] && note "Rewrites the plugin's .mcp.json: npx -> bunx, --browser chromium,"
    [ "$USE_BUNX" = 1 ] || note "Rewrites the plugin's .mcp.json: --browser chromium,"
    note "--user-data-dir $PROFILE_DIR if none is set (the profile PR image upload reuses)."
    note "Every other argument the plugin ships is kept."
    if confirm "Apply it (each file backed up first)?"; then
      mkdir -p "$PROFILE_DIR"
      while IFS= read -r f; do
        [ -n "$f" ] || continue
        cp -p "$f" "$f.bak-desk-$TS"
        if mcp_patch apply "$f"; then ok "patched ${f#"$HOME"/}"; else warn "could not patch $f"; fi
      done <<EOF
$todo
EOF
      note "takes effect when Claude Code restarts"
    fi
  fi
  if [ "$USE_BUNX" = 0 ]; then
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      if [ "$(jq -r '(.mcpServers // .).playwright.command // empty' "$f" 2>/dev/null)" = npx ]; then
        note "left on npx: bunx is not on PATH outside a checkout here, so a swap would break the MCP"
        note "if the MCP fails to start inside a repo (CONNECTION_CLOSED), install bun globally and re-run ./install.sh"
        break
      fi
    done <<EOF
$pw_files
EOF
  fi
  note "if a browser call later fails with 'Browser ... is not installed', download the build (no root, ~300MB):"
  note "  cd /tmp && bunx @playwright/mcp@latest install-browser chrome-for-testing"
  if [ "$USE_BUNX" = 1 ] && confirm "Download it now?" 1; then
    (cd "${TMPDIR:-/tmp}" && bunx @playwright/mcp@latest install-browser chrome-for-testing) \
      || warn "browser download failed; run the command above by hand"
  fi
fi

# ---------------------------------------------------------------------------------------------
section "Skill index  -> ~/.agents/skills/skill-index"

# After the plugins, so their skills are indexed too. The index is desk-owned and rebuilt every run;
# listing skills by name only changes settings.json, so that part is asked.
if out="$(python3 "$SRC/bin/skills-upstream" index 2>&1)"; then
  printf '%s\n' "$out" | while IFS= read -r l; do case "$l" in *"no area for"*) warn "${l#skill-index: }" ;; *) ok "${l#skill-index: }" ;; esac; done
  wrote "skill    ~/.agents/skills/skill-index (areas map + one description file per area)"
  rc=0; python3 "$SRC/bin/skills-upstream" index --quiet --name-only --check >/dev/null 2>&1 || rc=$?
  case "$rc" in
    0) ok "skills are listed to Claude by name only, full descriptions in skill-index" ;;
    2) warn "$SETTINGS is not valid JSON; fix it, then re-run to list skills by name only" ;;
    *)
      note "Claude Code resends every skill's description on every turn (~30,000 characters here, measured"
      note "2026-09-30) and cuts descriptions to fit. This lists your own and claude.ai skills by name only,"
      note "shrinks the listing budget to 0.3% of the context window (plugin skills cannot be set name-only),"
      note "and adds ~/.claude/rules/desk-skill-index.md pointing Claude at skill-index, whose area files hold"
      note "every full description. Entries you already set in skillOverrides are kept."
      if confirm "List skills by name only in ~/.claude/settings.json (backed up first)?"; then
        backup_settings
        if out="$(python3 "$SRC/bin/skills-upstream" index --quiet --name-only 2>&1)"; then ok "${out#skill-index: }"
        else warn "could not update ~/.claude/settings.json"; show_err "$out"; fi
      else
        note "not changed. To do it later, re-run ./install.sh"
      fi
      ;;
  esac
else
  warn "could not build the skill index"; show_err "$out"
fi

# ---------------------------------------------------------------------------------------------
section "Repo configs  -> ~/.config/desk/repos/<owner__name>/"

mkdir -p "$CONFIG_ROOT/repos" && chmod 700 "$CONFIG_ROOT" "$CONFIG_ROOT/repos"
configured=0
for c in "$CONFIG_ROOT"/repos/*/config.md; do
  [ -f "$c" ] || continue
  configured=$((configured + 1))
  slug="$(basename "$(dirname "$c")")"
  # Unset table values only, not the word TODO in the rules text.
  # shellcheck disable=SC2016
  todos="$(grep -c '^|.*`TODO`' "$c" 2>/dev/null || true)"
  if [ "${todos:-0}" -gt 0 ]; then warn "$slug: $todos unanswered fields (run /desk-setup in that repo)"
  else ok "$slug"; fi
done
[ "$configured" = 0 ] && note "no repo is configured yet: run /desk-setup inside each repo you want desk in"
note "template /desk-setup writes from: ~/.agents/skills/desk-setup/references/desk-config.template.md"
[ "$OS" = wsl ] && note "WSL: /desk-setup will ask for a Windows-visible handoff directory and a memory ceiling"

# ---------------------------------------------------------------------------------------------
section "Pinned third-party skills: upstream check"

# Upstreams change rarely, so this runs at most every 30 days; `/desk-update` or
# `skills-upstream outdated` checks on demand. It only reports; nothing is upgraded here.
if [ -f "$SRC/vendor/sources.json" ]; then
  age="$(python3 "$SRC/bin/skills-upstream" stamp-age-days 2>/dev/null || echo 9999)"
  if [ "$CHECK_ONLY" = 1 ]; then
    note "last checked ${age} day(s) ago; not checking under --check"
  elif [ "${age:-9999}" -ge 30 ]; then
    rc=0; out="$(python3 "$SRC/bin/skills-upstream" outdated 2>&1)" || rc=$?
    printf '%s\n' "$out" | sed 's/^/        /'
    case "$rc" in
      0)  ok "every pinned skill matches its upstream" ;;
      10) warn "upstream has newer versions (above). Review and adopt them with /desk-update" ;;
      *)  warn "could not reach every source (above); try /desk-update later" ;;
    esac
  else
    ok "checked ${age} day(s) ago; next check after 30 days (or run /desk-update)"
  fi
fi

printf '\nDone. %s warning(s) above.\n' "$WARNINGS"
if [ -n "$WROTE" ]; then
  echo "Written or moved, because these paths are desk-owned (an edited copy is backed up"
  echo "under $BACKUP first):"
  printf '%s' "$WROTE"
fi
echo
echo "Next:"
echo "  1. Restart Claude Code so it loads the skills, plugins and hook."
echo "  2. cd into a repo and run /desk-setup. It detects that repo's Jira, checks, toolchain and"
echo "     conventions, has you confirm them, then asks every permission for that repo, one by one."
echo "     Nothing is granted until you answer it. Repeat per repo (it can start from another repo's answers)."
echo "  3. Then, in that repo: /desk-ticket ABC-123, or /desk-autopilot ABC-1 ABC-2 for a batch."
