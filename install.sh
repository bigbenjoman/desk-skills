#!/usr/bin/env bash
# Installs the studia-* Claude Code skills and the environment they expect.
#
#   ./install.sh           asks before settings.json, plugins, a foreign desk-jira, the Playwright patch
#   ./install.sh --yes     accepts those prompts too, except large downloads (scripted re-install)
#   ./install.sh --check   reports dependencies only, changes nothing
#
# Safe to re-run. Studia-owned files (the skills, ~/.claude/desk/bin, the hook script, a first
# config) are written without asking and listed at the end; a copy you edited is backed up first.
# An existing config is never overwritten. settings.json is backed up before it is touched.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
CLAUDE_DIR="$HOME/.claude"
AGENTS="$HOME/.agents/skills"
SKILLS_LINK="$CLAUDE_DIR/skills"
STUDIA="$CLAUDE_DIR/studia"
PRISTINE="$HOME/.agents/.desk-pristine"   # what the last install wrote, to tell your edits from ours
BACKUP="$HOME/.agents/desk-backup/$TS"
CONFIG="$CLAUDE_DIR/desk-config.md"
SETTINGS="$CLAUDE_DIR/settings.json"
HOOK="$CLAUDE_DIR/hooks/deny-ai-attribution.py"
PROFILE_DIR="$HOME/.cache/ms-playwright-mcp/studia-profile"
REPO="${DESK_REPO:-$HOME/code/studia-web}"

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
    fd, tmp = tempfile.mkstemp(prefix=".studia-", suffix=".tmp", dir=folder)
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

# install_dir <src dir> <dest dir> — same, for a whole skill directory
install_dir() {
  local src="${1%/}" dest="${2%/}" rel pristine
  rel="${dest#"$HOME"/}"
  pristine="$PRISTINE/$rel"
  if [ -d "$dest" ] && ! diff -rq "$src" "$dest" >/dev/null 2>&1; then
    if [ ! -d "$pristine" ] || ! diff -rq "$dest" "$pristine" >/dev/null 2>&1; then
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
    if gh api repos/Sophos-Education/studia-web --jq .full_name >/dev/null 2>&1; then
      ok "gh can read Sophos-Education/studia-web"
    else
      warn "gh cannot read Sophos-Education/studia-web. Ask to be added to the org, then re-run."
    fi
  else
    bad "gh is not signed in. Run: gh auth login -h github.com -s repo,workflow"
  fi
fi

# bun is mise-managed from studia-web's .tool-versions. Agent shells often miss mise's PATH
# injection, which is why the skills call `mise exec -- bun`.
if need mise 0 "brew install mise" "curl https://mise.run | sh" "studia-web pins node and bun through mise"; then
  if [ -f "$REPO/.tool-versions" ]; then
    if bunpath="$(cd "$REPO" && mise which bun 2>/dev/null)"; then
      ok "bun via mise in $REPO  ($bunpath)"
    else
      warn "mise has not installed bun for $REPO. Run: cd $REPO && mise install"
    fi
  else
    note "no studia-web checkout at $REPO to check bun against (set DESK_REPO=/path/to/studia-web)"
  fi
fi

if need codex 0 "brew install --cask codex, or npm i -g @openai/codex" \
    "npm i -g @openai/codex (or bun add -g @openai/codex)" "cross-vendor refutation in /pullbot and autopilot"; then
  note "codex --version and codex login status pass even on a seat with no usage left; only a real call proves it."
  if [ "$CHECK_ONLY" = 1 ]; then
    note "no real codex call under --check; run ./install.sh without it, or /desk-setup, to make one"
  elif confirm "Make one real codex call to prove it can answer?"; then
    if out="$(cd "$SRC" && codex exec --sandbox read-only "Reply with exactly: CODEX_OK" </dev/null 2>&1)" \
        && printf '%s' "$out" | grep -q CODEX_OK; then
      ok "codex answered"
    else
      warn "codex did not answer: $(printf '%s' "$out" | tail -n 2 | tr '\n' ' ')"
      note "run 'codex login' and pick the Studia team seat; 'start a free trial of Plus' means you landed on a personal one"
    fi
  fi
fi

need flock 0 "brew install flock" "sudo apt install util-linux" "autopilot serialises test suites box-wide with it" || true
need lsof 0 "ships with macOS" "sudo apt install lsof" "cleanup and dev find port and worktree owners with it" || true

if [ "$CHECK_ONLY" = 1 ]; then
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
for dir in "$SRC"/skills/studia-*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  shipped="$shipped$name "
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
wrote "skills   ~/.agents/skills/studia-* ($count, replaced wholesale)"
wrote "template ~/.agents/skills/desk-setup/references/desk-config.template.md (from desk-config.md)"
wrote "pristine ~/.agents/.desk-pristine (what this install wrote, to tell your edits from ours)"
[ "$LINK_MODE" = each ] && wrote "links    ~/.claude/skills/studia-* -> ~/.agents/skills"

# Stale: a studia-* skill this installer put there (pristine copy, or our link) that no longer ships.
stale=""
for d in "$AGENTS"/studia-*; do
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
section "Autopilot and clearance tooling  -> ~/.claude/desk/bin"

if [ -d "$SRC/desk/bin" ]; then
  mkdir -p "$STUDIA/bin"
  count=0
  for f in "$SRC"/desk/bin/*; do
    [ -f "$f" ] || continue
    case "$f" in *.bak*) continue ;; esac
    install_file "$f" "$STUDIA/bin/$(basename "$f")"
    chmod +x "$STUDIA/bin/$(basename "$f")"
    count=$((count + 1))
  done
  ok "$count scripts (queue.json, workers/ and batch state are never touched)"
  wrote "scripts  ~/.claude/desk/bin ($count)"
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
  if "$JIRA_DEST" whoami >/dev/null 2>&1; then
    ok "desk-jira whoami works"
  else
    note "desk-jira is not configured yet (JIRA_EMAIL or ~/.config/studia/jira-email, plus ~/.config/studia/atlassian-token; see README)"
  fi
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
    note "Registers a PreToolUse(Bash) hook at user level: a git commit message, gh pr or gh api body,"
    note "or desk-jira text (inline, heredoc or file) carrying a Co-Authored-By trailer, Claude-Session,"
    note "an Anthropic noreply address, a Claude session link, 'Generated with Claude Code' or the robot"
    note "emoji is denied, in every repo. Other hooks are kept."
    if confirm "Register it in ~/.claude/settings.json (backed up first)?"; then
      backup_settings
      if settings_hook apply; then ok "registered"; else warn "could not write ~/.claude/settings.json"; fi
    else
      note "not registered. To do it later, re-run ./install.sh"
    fi
    ;;
esac

# Claude Code's own attribution (settings key `attribution`, docs: code.claude.com/docs/en/settings).
# Empty commit and pr strings plus sessionUrl false hide all of it; the hook stays as the backstop.
# attribution_setting <check|apply> — exit 0 already hidden/applied, 1 not, 2 unreadable settings.json
attribution_setting() {
  python3 - "$SETTINGS" "$1" <<'PY'
import json, os, sys
path, mode = sys.argv[1], sys.argv[2]
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
a = data.get("attribution")
hidden = isinstance(a, dict) and a.get("commit") in ("", False) and a.get("pr") in ("", False) \
    and a.get("sessionUrl") is False
if mode == "check" or hidden:
    sys.exit(0 if hidden else 1)
if not isinstance(a, dict):
    a = data["attribution"] = {}
a.update({"commit": "", "pr": "", "sessionUrl": False})
exec(os.environ["DESK_WRITE_JSON_PY"])
write_json(path, data)
PY
}

rc=0; attribution_setting check || rc=$?
case "$rc" in
  0) ok "Claude Code's own commit and PR attribution is already off" ;;
  2) warn "$SETTINGS is not valid JSON; fix it, then re-run to turn attribution off" ;;
  *)
    note "Claude Code adds a Co-Authored-By trailer and a PR line by default. Sets attribution to"
    note "{\"commit\": \"\", \"pr\": \"\", \"sessionUrl\": false} at user level; other keys are kept."
    if confirm "Turn it off in ~/.claude/settings.json (backed up first)?"; then
      backup_settings
      if attribution_setting apply; then ok "attribution off"; else warn "could not write ~/.claude/settings.json"; fi
    else
      note "left on; the hook still denies it in commits, PR bodies and Jira text if registered"
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

# The plugin ships `npx @playwright/mcp@latest`. Inside studia-web npm dies on the root
# package.json's overrides before the MCP handshake (CONNECTION_CLOSED), and the default
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
        warn "left on npx: bunx does not run outside studia-web here, so a swap would break the MCP elsewhere"
        note "npx fails to start inside studia-web (root overrides). Fix: mise use -g bun@<studia-web's"
        note "version>, or install bun globally, then re-run ./install.sh"
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
section "studia-web checkout"

if [ -e "$REPO/.git" ]; then
  links="$(find "$REPO/.claude/agents" -maxdepth 1 -type l 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${links:-0}" -gt 0 ]; then
    ok "$links project subagent links in $REPO/.claude/agents"
  else
    warn "$REPO/.claude/agents has no subagent links. /pullbot's named reviewers then silently run as general-purpose."
    note "fix: cd $REPO && mise exec -- bun run agents:sync   (gitignored links; also needed in any worktree made by hand)"
    if has mise && confirm "Run agents:sync in $REPO now?"; then
      (cd "$REPO" && mise exec -- bun run agents:sync) || warn "agents:sync failed; run it by hand"
    fi
  fi
else
  note "no checkout at $REPO. Clone it, or re-run with DESK_REPO=/path/to/studia-web; /desk-setup asks too."
fi
[ "$OS" = wsl ] && note "WSL: /desk-setup will ask for a Windows-visible handoff directory and a memory ceiling"

# ---------------------------------------------------------------------------------------------
section "User-level review-bar and pullbot copies"

# Only the studia-web copy is supported. Reported for you to remove; never deleted or refreshed.
if copies="$(bash "$SRC/skills/desk-setup/bin/user-skill-copies.sh" "$REPO")"; then
  ok "none; /pullbot uses studia-web's own .agents/skills copy"
else
  printf '%s\n' "$copies"
  n="$(printf '%s\n' "$copies" | grep -c '^  WARN ' || true)"
  WARNINGS=$((WARNINGS + ${n:-0}))
fi

# ---------------------------------------------------------------------------------------------
section "Config"

if [ -f "$CONFIG" ]; then
  ok "kept your existing ~/.claude/desk-config.md (never overwritten)"
  if grep -qE 'Check-out channel|Work-log directory' "$CONFIG"; then
    warn "it is the 1.x layout. Run /desk-setup: it carries your answers across and asks the new rows."
  fi
  note "template for comparison: ~/.agents/skills/desk-setup/references/desk-config.template.md"
else
  cp "$SRC/desk-config.md" "$CONFIG"
  ok "created ~/.claude/desk-config.md (every answer TODO until /desk-setup)"
  wrote "config   ~/.claude/desk-config.md (new; never overwritten once it exists)"
fi
# Unset table values only, not the word TODO in the rules text.
# shellcheck disable=SC2016
todos="$(grep -c '^|.*`TODO`' "$CONFIG" 2>/dev/null || true)"

printf '\nDone. %s warning(s) above.\n' "$WARNINGS"
if [ -n "$WROTE" ]; then
  echo "Written or moved, because these paths are studia-owned (an edited copy is backed up"
  echo "under $BACKUP first):"
  printf '%s' "$WROTE"
fi
echo
echo "Next:"
echo "  1. Restart Claude Code so it loads the skills, plugins and hook."
echo "  2. Run /desk-setup. It confirms who you are and where things live, then asks you"
echo "     every permission, one by one. Nothing is granted until you answer it."
if [ "${todos:-0}" -gt 0 ]; then
  echo "     ($todos unanswered fields right now; the skills stop and ask until they are set.)"
fi
echo "  3. Then: /desk-ticket SV-XXX, or /desk-autopilot SV-XXX SV-YYY for a batch."
