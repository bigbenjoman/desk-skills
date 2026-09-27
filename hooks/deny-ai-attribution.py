#!/usr/bin/env python3
"""PreToolUse(Bash) hook: refuse AI attribution in commits, tags, notes, PR/issue/release text,
GitHub API bodies and Jira text.

PER SUBCOMMAND, PER REPO. Each checked subcommand is judged by the repo IT targets, not by the
session's cwd: `cd other && git commit`, `git -C other commit`, `gh -R owner/name ...` and
`gh api repos/owner/name/...` are judged by `other` / `owner/name`. Where that repo's desk config
has §5 "AI attribution" set to `forbidden` (~/.config/desk/repos/<slug>/config.md) the subcommand
is checked; any other value, no config, or no git repo means it is not. The slug is resolved
exactly as desk-env.mjs resolves it (ownerRepoFromUrl ported below: any host, ssh aliases,
trailing slashes, lower-case; remote-less repos are `local__<name>-<8 hex of the path>`;
DESK_REPO_OVERRIDE and DESK_CONFIG are honoured as desk-env honours them). `--self-test` proves the
port agrees with desk-env.mjs on a table of URLs.

A compound command is split on `&&`, `||`, `;`, `|`, `&` and newlines (outside quotes and `$(...)`).
`cd`/`pushd` move the directory later subcommands target (not across a pipe, and not out of a
`( ... )` subshell; a target naming an unset variable leaves the directory unchanged).
`bash|sh|zsh|dash|ksh -c '<script>'` and `eval <words>` are checked recursively. Checked:
  git [-C dir | -c k=v | --git-dir d ...] commit | merge | tag | commit-tree | notes add|append|edit
        their text; -F/--file (and commit's -t/--template, -c commit.template) files, any unique
        long-option prefix, bundled short flags; commit --trailer values with -c trailer.<a>.key
        aliases resolved
  gh pr create|edit|comment|review|merge      text, --body-file/-F <file>
  gh issue comment|create|edit                text, --body-file/-F <file>
  gh release create|edit                      text (--notes/-n), --notes-file/-F <file>
  gh api ...                                  text (-f body=...), -F/--field k=@<file>, --input <file>
  desk-jira comment|create|edit               text, a body-file argument or field=@<file>
With each: heredoc bodies, `< file` redirects, `$(cat file)`/`$(<file)`, and the text and heredocs
of the pipeline stages feeding it (`cat <<EOF | git commit -F -`). Unrelated subcommands
(`printf ... >> NOTES.md`) are not. Files resolve against the tracked directory; up to 1 MB each.
A file that does not exist yet at hook time, or whose name appears elsewhere in the command (it
may be written earlier in the same call), is not trusted: the WHOLE command text is scanned
instead. Stdin from a process the hook cannot see stays unseen.

Refused, case-insensitively: a Co-Authored-By trailer (`:` or `=`) naming Claude or Anthropic
(a human co-author is allowed: the rule is no AI attribution, not no co-authors), Claude-Session,
'Generated with Claude Code', noreply@anthropic.com ANYWHERE (an --author, a trailer, a body), a
claude.ai/code/session_ URL, the robot emoji. Detection is literal: a commit message that merely
describes this hook and quotes a banned trailer is refused too. Reword it.

Returns only permissionDecision=deny and never updatedInput, so it coexists with any other
PreToolUse(Bash) hook that rewrites commands: only one rewrite survives, but a deny wins.
Git is called only for a subcommand whose text already carries a banned pattern, so an ordinary
call costs the interpreter start and a parse.
"""

import hashlib
import json
import os
import re
import shlex
import subprocess
import sys

ROW = re.compile(r"^\|\s*AI attribution\s*\|\s*`([^`]*)`", re.I | re.M)
# desk-env.mjs ownerRepoFromUrl, verbatim ($ -> \Z: Python's $ also matches before a final newline).
REMOTE = re.compile(
    r"(?:^[a-z][a-z0-9+.-]*://[^/]+/|^[^@\s/]+@[^:\s/]+:|^[^:\s/]+:(?!/))(?:.*/)?([^/\s:]+)/([^/\s:]+)\Z",
    re.I)

BANNED = (
    re.compile(r"co-authored-by\s*[:=][^\n\"']*(claude|anthropic)", re.I),
    re.compile(r"claude-session\s*[:=]", re.I),
    re.compile(r"generated with \[?claude code", re.I),
    re.compile(r"noreply@anthropic\.com", re.I),
    re.compile(r"claude\.ai/code/session_", re.I),
    re.compile("\N{ROBOT FACE}"),
)

MAX_BYTES = 1 << 20
MAX_DEPTH = 4
WRAPPERS = {"rtk", "env", "command", "builtin", "exec", "nohup", "time", "nice", "stdbuf", "timeout", "sudo"}
KEYWORDS = {"if", "then", "do", "else", "elif", "while", "until", "!", "{", "(", "}", ")"}
SHELLS = {"bash", "sh", "zsh", "dash", "ksh"}
HEREDOC = re.compile(r"(?<!<)<<(?!<)(-?)[ \t]*(?:'([^'\n]*)'|\"([^\"\n]*)\"|\\?([A-Za-z_][\w.-]*))")
CMDSUB_FILE = re.compile(r"(?:\$\(|`)\s*(?:cat\s+([^\s)`;|&]+)|<\s*([^\s)`;|&]+))\s*(?:\)|`)")

# git subcommand -> (file short letters, value-taking short letters, optional-attached letters,
#                    [(long option, shortest unique prefix)] that name a file)
GIT_SUBS = {
    "commit": ("Ft", "mcC", "uS", [("file", 3), ("template", 2)]),
    "merge": ("F", "msX", "S", [("file", 2)]),
    "tag": ("F", "mu", "", [("file", 2)]),
    "commit-tree": ("F", "mp", "S", []),
    "notes": ("F", "mcC", "", [("file", 2)]),
}
NOTES_WRITERS = {"add", "append", "edit"}
GH_TEXT = {
    "pr": ({"create", "edit", "comment", "review", "merge"}, ("-F", "--body-file")),
    "issue": ({"comment", "create", "edit"}, ("-F", "--body-file")),
    "release": ({"create", "edit"}, ("-F", "--notes-file")),
}
JIRA_SUBS = {"comment", "create", "edit"}


def banned(text):
    return any(b.search(text) for b in BANNED)


# --- which repo, which policy (a port of desk-env.mjs currentRepo / configPathOrNull) -----------

def config_root():
    return os.path.expanduser(os.environ.get("DESK_CONFIG_ROOT") or "~/.config/desk")


def owner_repo_from_url(url):
    u = re.sub(r"/+\Z", "", str(url or "").strip())
    u = re.sub(r"\.git\Z", "", u)
    m = REMOTE.search(u)
    return f"{m.group(1)}/{m.group(2)}" if m else None


def slug_of(owner_repo):
    return owner_repo.lower().replace("/", "__", 1)


def _git(d, *args):
    try:
        return subprocess.run(["git", "-C", d, *args], capture_output=True, text=True,
                              timeout=3).stdout.strip()
    except Exception:  # noqa: BLE001
        return ""


def slug_for_dir(d):
    override = os.environ.get("DESK_REPO_OVERRIDE")
    owner_repo = override or owner_repo_from_url(_git(d, "remote", "get-url", "origin"))
    if owner_repo:
        return slug_of(owner_repo)
    common = _git(d, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if not common:
        return None
    root = os.path.dirname(common)
    return f"local__{os.path.basename(root).lower()}-{hashlib.sha1(root.encode()).hexdigest()[:8]}"


def config_path(slug):
    if os.environ.get("DESK_CONFIG"):
        return os.path.expanduser(os.environ["DESK_CONFIG"])
    return os.path.join(config_root(), "repos", slug, "config.md") if slug else None


_policy = {}


def forbidden(target_dir=None, owner_repo=None):
    """True where the targeted repo's config says AI attribution is forbidden."""
    key = (target_dir, owner_repo)
    if key not in _policy:
        if owner_repo and not os.environ.get("DESK_REPO_OVERRIDE"):
            slug = slug_of(owner_repo)
        else:
            slug = slug_for_dir(target_dir or os.getcwd())
        path, verdict = config_path(slug), False
        if path:
            try:
                with open(path, encoding="utf-8") as f:
                    m = ROW.search(f.read())
                verdict = bool(m) and m.group(1).strip().lower().startswith("forbidden")
            except OSError:
                pass
        _policy[key] = verdict
    return _policy[key]


# --- splitting --------------------------------------------------------------------------------

def strip_heredocs(command):
    """Return (text without heredoc bodies, [(offset of the << operator, body)])."""
    lines = command.split("\n")
    kept, docs, pos, i = [], [], 0, 0
    while i < len(lines):
        line = lines[i]
        kept.append(line)
        start, i = pos, i + 1
        pos += len(line) + 1
        for m in HEREDOC.finditer(line):
            delim = next(g for g in m.groups()[1:] if g is not None)
            for j in range(i, len(lines)):
                probe = lines[j].lstrip("\t") if m.group(1) else lines[j]
                if probe == delim:
                    docs.append((start + m.start(), "\n".join(lines[i:j])))
                    i = j + 1
                    break
    return "\n".join(kept), docs


def split_pipelines(text):
    """[[(start, end), ...], ...]: pipelines of stages, split outside quotes and $(...)."""
    pipelines, stages = [], []
    quote, depth, start, i, n = None, 0, 0, 0, len(text)

    def cut(end, new_pipeline):
        nonlocal stages
        stages.append((start, end))
        if new_pipeline:
            pipelines.append(stages)
            stages = []

    while i < n:
        c = text[i]
        if c == "\\" and quote != "'":
            i += 2
            continue
        if quote:
            if c == quote:
                quote = None
            i += 1
            continue
        if c in "'\"`":
            quote = c
        elif c == "$" and text[i + 1:i + 2] == "(":
            depth, i = depth + 1, i + 1
        elif c == ")" and depth:
            depth -= 1
        elif depth == 0:
            two = text[i:i + 2]
            if two in ("&&", "||"):
                cut(i, True)
                start, i = i + 2, i + 2
                continue
            if c in ";\n":
                cut(i, True)
                start = i + 1
            elif c == "|":
                cut(i, False)
                start = i + (2 if two == "|&" else 1)
                i = start
                continue
            elif c == "&" and text[i - 1:i] not in ("<", ">") and text[i + 1:i + 2] != ">":
                cut(i, True)
                start = i + 1
        i += 1
    cut(n, True)
    return pipelines


def group_balance(segment):
    """Unquoted `(` minus `)` that are not `$(`...`)`: <0 opens a subshell, >0 closes one."""
    quote, opens, closes, sub, i = None, 0, 0, 0, 0
    while i < len(segment):
        c = segment[i]
        if c == "\\" and quote != "'":
            i += 2
            continue
        if quote:
            if c == quote:
                quote = None
        elif c in "'\"`":
            quote = c
        elif c == "$" and segment[i + 1:i + 2] == "(":
            sub, i = sub + 1, i + 1
        elif c == "(":
            opens += 1
        elif c == ")":
            if sub:
                sub -= 1
            else:
                closes += 1
        i += 1
    return closes - opens


def tokens_of(segment):
    try:
        toks = shlex.split(segment, comments=False, posix=True)
    except ValueError:
        toks = segment.split()
    out = []
    for t in toks:  # `(cd x` and `commit)` from a subshell group
        if t.startswith("(") and not t.startswith("$("):
            t = t.lstrip("(")
        if t.endswith(")") and "(" not in t:
            t = t.rstrip(")")
        if t:
            out.append(t)
    return out


def command_start(tokens):
    """Index of the real command word after keywords, VAR=x assignments and wrappers."""
    k, wrapped = 0, False
    while k < len(tokens):
        t = tokens[k]
        if t in KEYWORDS or re.match(r"^[A-Za-z_]\w*=", t):
            k += 1
        elif t in WRAPPERS:
            k, wrapped = k + 1, True
        elif wrapped and (t.startswith("-") or re.match(r"^\d+(\.\d+)?[smhd]?$", t)):
            k += 1
        else:
            return k
    return k


def assignment(tokens, k, name):
    for t in tokens[:k]:
        if t.startswith(name + "="):
            return t[len(name) + 1:]
    return None


def resolve_dir(base, target):
    """A directory a cd / -C names, or None if it cannot be known before the shell runs."""
    target = os.path.expanduser(os.path.expandvars(target))
    if "$" in target or "`" in target:
        return None
    return os.path.normpath(os.path.join(base, target))


# --- per-family arguments -----------------------------------------------------------------------

def long_opt(tok, full, shortest):
    """(matched, value or None) for --<unique prefix of full>[=value]."""
    if not tok.startswith("--"):
        return False, None
    name, eq, value = tok[2:].partition("=")
    if len(name) >= shortest and full.startswith(name):
        return True, value if eq else None
    return False, None


def git_text(tokens, k, cwd):
    """(kind, target dir, file tokens, extra text) for a checked git subcommand, or None."""
    j, gitdir, configs = k + 1, cwd, []
    env_dir = assignment(tokens, k, "GIT_DIR")
    if env_dir:
        gitdir = resolve_dir(cwd, env_dir) or cwd
    while j < len(tokens) and tokens[j].startswith("-"):
        t = tokens[j]
        if t in ("-C", "-c", "--git-dir") and j + 1 < len(tokens):
            if t == "-c":
                configs.append(tokens[j + 1])
            else:
                gitdir = resolve_dir(gitdir, tokens[j + 1]) or gitdir
            j += 2
        elif t.startswith("--git-dir="):
            gitdir = resolve_dir(gitdir, t[len("--git-dir="):]) or gitdir
            j += 1
        elif t in ("--work-tree", "--namespace", "--config-env", "--exec-path") and j + 1 < len(tokens):
            j += 2
        else:
            j += 1
    if j >= len(tokens) or tokens[j] not in GIT_SUBS:
        return None
    sub = tokens[j]
    file_letters, value_letters, optional_letters, longs = GIT_SUBS[sub]
    args = tokens[j + 1:]
    if sub == "notes":
        n = 0
        while n < len(args) and args[n].startswith("-"):
            n += 2 if args[n] == "--ref" else 1
        if n >= len(args) or args[n] not in NOTES_WRITERS:
            return None
        args = args[n + 1:]
    files, trailers, aliases = [], [], {}
    if sub == "commit":
        for kv in configs:
            key, _, val = kv.partition("=")
            m = re.match(r"^trailer\.(.+)\.key$", key, re.I)
            if m:
                aliases[m.group(1).lower()] = val
            elif key.lower() == "commit.template":
                files.append(val)
    i = 0
    while i < len(args):
        t = args[i]
        nxt = args[i + 1] if i + 1 < len(args) else None
        if t == "--":
            break
        took = False
        for full, shortest, kind in [(f, s, "file") for f, s in longs] + (
                [("trailer", 2, "trailer")] if sub == "commit" else []):
            hit, value = long_opt(t, full, shortest)
            if hit:
                if value is None:
                    value, i = nxt, i + 1
                if value is not None:
                    (files if kind == "file" else trailers).append(value)
                took = True
                break
        if not took and re.match(r"^-[A-Za-z]", t):
            for pos, ch in enumerate(t[1:], start=2):
                if not ch.isalpha():
                    break
                if ch in file_letters or ch in value_letters or ch in optional_letters:
                    rest = t[pos:]
                    if ch in file_letters:
                        if rest:
                            files.append(rest)
                        elif nxt is not None:
                            files.append(nxt)
                            i += 1
                    elif ch in value_letters and not rest:
                        i += 1
                    break
        i += 1
    extra = []
    for tr in trailers:
        m = re.match(r"^\s*([^:=]*?)\s*[:=]\s*(.*)$", tr, re.S)
        key, val = (m.group(1), m.group(2)) if m else (tr, "")
        low = key.lower()
        full = next((v for a, v in aliases.items() if low and a.startswith(low)), key)
        extra.append(f"{full.rstrip(': =')}: {val}")
    kind = {"commit": "commit", "merge": "merge message", "tag": "tag message",
            "commit-tree": "commit-tree message", "notes": "git note"}[sub]
    return kind, gitdir, files, "\n".join(extra)


def gh_text(tokens, k):
    """(kind, owner/name or None, file tokens) for a checked gh subcommand, or None."""
    owner_repo = None
    for i, t in enumerate(tokens[k + 1:], start=k + 1):
        value = None
        if t in ("-R", "--repo") and i + 1 < len(tokens):
            value = tokens[i + 1]
        elif t.startswith("--repo="):
            value = t[len("--repo="):]
        if value:
            parts = [p for p in value.split("/") if p]
            if len(parts) >= 2:
                owner_repo = "/".join(parts[-2:])
    if not owner_repo:
        env_repo = assignment(tokens, k, "GH_REPO")
        if env_repo and env_repo.count("/") >= 1:
            owner_repo = "/".join(env_repo.split("/")[-2:])
    j = k + 1
    while j < len(tokens) and tokens[j].startswith("-"):
        j += 2 if tokens[j] in ("-R", "--repo") else 1
    rest = tokens[j:]
    if len(rest) >= 2 and rest[0] in GH_TEXT and rest[1] in GH_TEXT[rest[0]][0]:
        flags, api, kind = GH_TEXT[rest[0]][1], False, f"gh {rest[0]} {rest[1]} text"
    elif rest and rest[0] == "api":
        flags, api, kind = ("-F", "--field", "--input"), True, "GitHub API call"
        for t in rest[1:]:
            m = re.match(r"^/?repos/([^/{}\s]+)/([^/?#{}\s]+)", t)
            if m and not owner_repo:
                owner_repo = f"{m.group(1)}/{m.group(2)}"
    else:
        return None
    files = []
    args = rest[1:]
    for i, t in enumerate(args):
        value = None
        for flag in flags:
            if t == flag and i + 1 < len(args):
                value = args[i + 1]
            elif t.startswith(flag + "="):
                value = t[len(flag) + 1:]
            elif flag == "-F" and t.startswith("-F") and len(t) > 2:
                value = t[2:].lstrip("=")
            if value is not None:
                break
        if value is None:
            continue
        m = re.match(r"^[^=]*=@(.+)$", value)
        if m:
            files.append(m.group(1))
        elif not api or t.startswith("--input"):
            files.append(value)
    return kind, owner_repo, files


def jira_text(tokens, k):
    if k + 1 >= len(tokens) or tokens[k + 1] not in JIRA_SUBS:
        return None
    files = []
    for i, t in enumerate(tokens[k + 2:], start=k + 2):
        m = re.match(r"^[\w.-]+=@(.+)$", t)
        if m:
            files.append(m.group(1))
        elif i >= k + 3 and not t.startswith("-"):
            files.append(t.lstrip("@"))  # `desk-jira comment KEY <file>`: the command, sub and key come first
    return files


def shell_script(tokens, k):
    """The script string of `bash -c '<script>'` / `eval <words>`, or None."""
    word = os.path.basename(tokens[k])
    if word == "eval":
        return " ".join(tokens[k + 1:]) or None
    has_c, j = False, k + 1
    while j < len(tokens):
        t = tokens[j]
        if t == "--":
            j += 1
            break
        if t in ("-o", "+o", "-O", "+O"):
            j += 2
            continue
        if t.startswith("-") and not t.startswith("--") and len(t) > 1:
            has_c = has_c or "c" in t[1:]
            j += 1
            continue
        if t.startswith("--"):
            j += 1
            continue
        break
    return tokens[j] if has_c and j < len(tokens) else None


def redirects(tokens):
    out = []
    for i, t in enumerate(tokens):
        if t == "<" and i + 1 < len(tokens):
            out.append(tokens[i + 1])
        elif t.startswith("<") and not t.startswith("<<") and not t.startswith("<(") and len(t) > 1:
            out.append(t[1:])
    return out


def cmdsub_files(segment):
    return [(a or b).strip("'\"") for a, b in CMDSUB_FILE.findall(segment)]


def file_path(base, token):
    path = os.path.expanduser(os.path.expandvars(token))
    return path if os.path.isabs(path) else os.path.join(base, path)


def read_file(path):
    try:
        with open(path, "rb") as f:
            return f.read(MAX_BYTES).decode("utf-8", "replace")
    except OSError:
        return ""


def named_elsewhere(token, whole):
    """True if the file name appears more than once in the command: it may be written earlier."""
    pat = r"(?<![\w./~-])" + re.escape(token) + r"(?![\w./-])"
    return len(re.findall(pat, whole)) > 1


# --- the walk -----------------------------------------------------------------------------------

class Check:
    def __init__(self, kind, target, owner_repo, files, extra):
        self.kind, self.target, self.owner_repo, self.files, self.extra = kind, target, owner_repo, files, extra


def classify(tokens, k, cwd):
    word = os.path.basename(tokens[k])
    if word == "git":
        found = git_text(tokens, k, cwd)
        if found:
            kind, target, files, extra = found
            return Check(kind, target, None, files, extra)
    elif word == "gh":
        found = gh_text(tokens, k)
        if found:
            kind, owner_repo, files = found
            return Check(kind, cwd, owner_repo, files, "")
    elif word == "desk-jira":
        files = jira_text(tokens, k)
        if files is not None:
            return Check("Jira text", cwd, None, files, "")
    return None


def find_hit(command, cwd, whole=None, stdin=(), depth=0):
    """(kind, where) of the first checked subcommand carrying AI attribution into a repo whose
    config forbids it, or None."""
    whole = command if whole is None else whole
    text, docs = strip_heredocs(command)
    stack = []
    for pipeline in split_pipelines(text):
        fed = list(stdin)  # text and heredocs of earlier stages, which feed this one's stdin
        for start, end in pipeline:
            segment = text[start:end]
            bodies = [body for off, body in docs if start <= off < end]
            balance = group_balance(segment)
            for _ in range(-balance):
                stack.append(cwd)
            tokens = tokens_of(segment)
            k = command_start(tokens)
            if k < len(tokens):
                word = os.path.basename(tokens[k])
                if word in ("cd", "pushd"):
                    args = [t for t in tokens[k + 1:] if t not in ("-P", "-L", "--")]
                    target = resolve_dir(cwd, args[0] if args else "~")
                    if target and len(pipeline) == 1:
                        cwd = target
                elif (word in SHELLS or word == "eval") and depth < MAX_DEPTH:
                    script = shell_script(tokens, k)
                    if script:
                        hit = find_hit(script, cwd, whole, fed + bodies, depth + 1)
                        if hit:
                            return hit
                else:
                    check = classify(tokens, k, cwd)
                    if check:
                        hit = judge(check, segment, bodies, fed, cwd, whole, tokens)
                        if hit:
                            return hit
            fed += [segment] + bodies
            for _ in range(balance):
                if stack:
                    cwd = stack.pop()
    return None


def judge(check, segment, bodies, fed, cwd, whole, tokens):
    carries = None
    if banned("\n".join(fed + [segment, check.extra] + bodies)):
        carries = "the command"
    else:
        for token in check.files + redirects(tokens) + cmdsub_files(segment):
            if not token or token == "-":
                continue
            path = file_path(check.target if check.kind != "Jira text" else cwd, token)
            if not os.path.isfile(path) or named_elsewhere(token, whole):
                # Written by this very call, or not there yet: the command text is all there is.
                if banned(whole):
                    carries = f"{token} (not readable before the call runs, so the whole command was scanned)"
                    break
                continue
            if banned(read_file(path)):
                carries = token
                break
    if carries and forbidden(check.target, check.owner_repo):
        return check.kind, carries
    return None


def deny(hit):
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    f"The {hit[0]} in {hit[1]} carries AI attribution, which must never reach "
                    "this repo's git history, PRs, issues, releases or Jira (desk config §5 AI attribution: "
                    "forbidden). Remove any Co-Authored-By trailer naming Claude or Anthropic, "
                    "Claude-Session line, noreply@anthropic.com, claude.ai/code/session_ link, "
                    "'Generated with Claude Code' line and the robot emoji, then run it again."
                ),
            }
        },
        sys.stdout,
    )


def decide(command, cwd):
    if not re.search(r"\b(?:git|gh|desk-jira)\b", command):
        return None
    try:
        return find_hit(command, cwd)
    except Exception:  # noqa: BLE001 - a parser bug fails closed on the whole command text
        return ("command", "the command") if banned(command) and forbidden(cwd) else None


def main() -> int:
    if sys.argv[1:] == ["--self-test"]:
        return self_test()
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0  # never block on a malformed payload
    command = (payload.get("tool_input") or {}).get("command") or ""
    cwd = payload.get("cwd") or os.getcwd()
    hit = decide(command, cwd)
    if hit is not None:
        deny(hit)
    return 0


# --- self-test ----------------------------------------------------------------------------------

URL_TABLE = [
    "git@github.com:Acme/Widget.git", "https://github.com/acme/widget", "https://github.com/acme/widget/",
    "https://github.com/acme/widget.git/", "ssh://git@github.com:443/Acme/Widget.git",
    "git@github-work:acme/widget.git", "https://gitlab.example.com/group/sub/widget.git",
    "https://user:tok@github.com/acme/widget.git", "github.com:acme/widget", "  https://github.com/a/b  ",
    "/srv/git/widget.git", "https://github.com/widget", "file:///srv/acme/widget.git", "", "not a url",
    "git@github.com:/abs/acme/widget.git", "https://github.com/acme/wid get",
]


def self_test():
    import tempfile
    import time
    failures = []

    def expect(label, got, want):
        if got != want:
            failures.append(f"{label}: got {got!r}, want {want!r}")

    here = os.path.dirname(os.path.abspath(__file__))
    mjs = next((p for p in (os.path.join(here, "..", "desk", "bin", "desk-env.mjs"),
                            os.path.expanduser("~/.claude/desk/bin/desk-env.mjs")) if os.path.isfile(p)), None)

    # 1. the URL port agrees with desk-env.mjs
    if mjs:
        js = ("import {ownerRepoFromUrl} from " + json.dumps("file://" + os.path.abspath(mjs)) + ";"
              "for (const u of JSON.parse(process.env.T)) console.log(JSON.stringify(ownerRepoFromUrl(u)));")
        out = subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True,
                             env={**os.environ, "T": json.dumps(URL_TABLE)}).stdout.splitlines()
        for u, line in zip(URL_TABLE, out):
            expect(f"url {u!r}", owner_repo_from_url(u), json.loads(line))
        expect("url table length", len(out), len(URL_TABLE))
    else:
        print("self-test: desk-env.mjs not found; URL agreement not checked", file=sys.stderr)

    tmp = tempfile.mkdtemp(prefix="deny-ai-attr-")
    saved = {k: os.environ.get(k) for k in ("DESK_CONFIG_ROOT", "DESK_CONFIG", "DESK_REPO_OVERRIDE", "HOME")}
    os.environ["DESK_CONFIG_ROOT"] = os.path.join(tmp, "cfg")
    os.environ.pop("DESK_CONFIG", None)
    os.environ.pop("DESK_REPO_OVERRIDE", None)

    def repo(name, remote, policy):
        d = os.path.join(tmp, name)
        subprocess.run(["git", "init", "-q", d], check=True)
        if remote:
            subprocess.run(["git", "-C", d, "remote", "add", "origin", remote], check=True)
        slug = slug_for_dir(d)
        c = os.path.join(config_root(), "repos", slug)
        os.makedirs(c, exist_ok=True)
        with open(os.path.join(c, "config.md"), "w") as f:
            f.write(f"## 5. Conventions\n\n| Field | Value |\n|---|---|\n| AI attribution | `{policy}` |\n")
        return d, slug

    forb, forb_slug = repo("forb", "git@github.com:Acme/Forb.git", "forbidden")
    allow, allow_slug = repo("allow", "https://github.com/acme/allow/", "allowed")
    loc, loc_slug = repo("loc", None, "forbidden")
    expect("slug lower-cased", forb_slug, "acme__forb")
    expect("trailing slash", allow_slug, "acme__allow")
    expect("local slug shape", bool(re.match(r"^local__loc-[0-9a-f]{8}$", loc_slug)), True)
    if mjs:
        for d, slug in ((forb, forb_slug), (allow, allow_slug), (loc, loc_slug)):
            out = subprocess.run(["node", mjs, "where"], capture_output=True, text=True,
                                 env={**os.environ, "DESK_REPO_DIR": d}).stdout
            m = re.search(r"^SLUG='([^']*)'", out, re.M)
            expect(f"desk-env where slug for {os.path.basename(d)}", m and m.group(1), slug)

    with open(os.path.join(forb, "clean.md"), "w") as f:
        f.write("fix: a clean body\n")
    with open(os.path.join(forb, "dirty.md"), "w") as f:
        f.write("body\n\n\N{ROBOT FACE} Generated with Claude Code\n")
    with open(os.path.join(forb, "msg.txt"), "w") as f:
        f.write("fix: clean for now\n")

    CAB = "Co-Authored-By: Claude <noreply@anthropic.com>"
    CAB_ONLY = "Co-Authored-By: Claude Opus"
    cases = [
        # H1: the repo each subcommand targets decides
        (allow, f'cd ../forb && git commit -m "fix: x\n\n{CAB_ONLY}"', True),
        (allow, f'git -C ../forb commit -m "fix: x\n\n{CAB_ONLY}"', True),
        (allow, f'git --git-dir ../forb/.git commit -m "fix\n\n{CAB_ONLY}"', True),
        (forb, f'cd ../allow && git commit -m "fix: x\n\n{CAB_ONLY}"', False),
        (forb, f'git -C {allow} commit -m "fix\n\n{CAB_ONLY}"', False),
        (allow, f'git commit -m "fix\n\n{CAB}"', False),
        (allow, f'(cd ../forb && git commit -m "fix\n\n{CAB_ONLY}")', True),
        (forb, f'(cd ../allow && ls); git commit -m "fix\n\n{CAB_ONLY}"', True),
        (allow, f'gh -R Acme/Forb pr comment 1 --body "\N{ROBOT FACE}"', True),
        (allow, 'gh api repos/acme/forb/issues/1/comments -f body="Generated with Claude Code"', True),
        (forb, 'gh api repos/acme/allow/issues/1/comments -f body="Generated with Claude Code"', False),
        (loc, f'git commit -m "fix\n\n{CAB_ONLY}"', True),
        # H2: more writers
        (forb, f'git merge -m "merge\n\n{CAB_ONLY}" topic', True),
        (forb, 'git merge --file dirty.md topic', True),
        (forb, 'git tag -a v1 -m "\N{ROBOT FACE} Generated with Claude Code"', True),
        (forb, 'git tag -a v1 -F dirty.md', True),
        (forb, 'git commit-tree HEAD^{tree} -p HEAD -m "x noreply@anthropic.com"', True),
        (forb, 'git notes add -m "Claude-Session: abc" HEAD', True),
        (forb, 'git notes --ref review append -F dirty.md', True),
        (forb, 'gh issue comment 3 --body "Generated with Claude Code"', True),
        (forb, 'gh issue create --title t --body-file dirty.md', True),
        (forb, 'gh issue edit 3 -F dirty.md', True),
        (forb, 'gh release create v1 --notes "\N{ROBOT FACE} notes"', True),
        (forb, 'gh release edit v1 -n "Generated with Claude Code"', True),
        (forb, 'gh release create v1 --notes-file dirty.md', True),
        (forb, 'gh pr review 4 --comment --body "Generated with Claude Code"', True),
        (forb, f"bash -c 'git commit -m \"fix\n\n{CAB_ONLY}\"'", True),
        (forb, f"sh -c 'git commit -m \"fix\n\n{CAB_ONLY}\"'", True),
        (forb, f"zsh -lc 'git merge -m \"{CAB_ONLY}\" x'", True),
        (forb, f"eval \"git commit -m 'fix {CAB_ONLY}'\"", True),
        (allow, f"bash -c 'cd ../forb && git commit -m \"{CAB_ONLY}\"'", True),
        (forb, f"printf '%s\\n' 'fix' '' '{CAB_ONLY}' > /tmp/desk-selftest-missing-$$.txt && "
               "git commit -F /tmp/desk-selftest-missing-$$.txt", True),
        (forb, f"echo '{CAB_ONLY}' >> msg.txt && git commit -F msg.txt", True),
        (forb, "git commit -F msg.txt", False),
        (forb, "git commit -F clean.md", False),
        (forb, "git commit -F dirty.md", True),
        (forb, 'git commit -m "$(cat dirty.md)"', True),
        (forb, f"git commit -m \"$(cat <<'EOF'\nfix: x\n\n{CAB_ONLY}\nEOF\n)\"", True),
        (forb, f"cat <<EOF | git commit -F -\nfix\n\n{CAB_ONLY}\nEOF", True),
        (forb, f"printf '{CAB_ONLY}' >> NOTES.md", False),
        (forb, 'git commit -m "fix" --author "Bot <noreply@anthropic.com>"', True),
        (forb, 'git commit -m "fix\n\nCo-Authored-By: Jane Doe <jane@example.com>"', False),
        (forb, "git -c trailer.cab.key=Co-authored-by commit -m fix --trailer 'cab: Claude'", True),
        (forb, "desk-jira comment KAN-1 dirty.md", True),
        (forb, "desk-jira create Task 'summary' 'Generated with Claude Code'", True),
        (forb, "git status && git log --oneline -3", False),
    ]
    for cwd, cmd, want in cases:
        expect(f"[{os.path.basename(cwd)}] {cmd!r}", decide(cmd, cwd) is not None, want)

    # DESK_REPO_OVERRIDE applies to every subcommand, as in desk-env
    os.environ["DESK_REPO_OVERRIDE"] = "acme/allow"
    _policy.clear()
    expect("override", decide(f'git commit -m "{CAB_ONLY}"', forb), None)
    os.environ.pop("DESK_REPO_OVERRIDE")
    _policy.clear()

    # latency on an ordinary, clean call (interpreter start + parse, no git)
    payload = json.dumps({"tool_input": {"command": 'git add -A && git commit -m "fix: clean"'}, "cwd": forb})
    t0 = time.time()
    for _ in range(5):
        subprocess.run([sys.executable, os.path.abspath(__file__)], input=payload, text=True, capture_output=True)
    ms = (time.time() - t0) / 5 * 1000
    print(f"self-test: clean call {ms:.0f} ms per run (includes interpreter start)")

    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    subprocess.run(["rm", "-rf", tmp])
    if failures:
        print("\n".join(f"FAIL {f}" for f in failures))
        print(f"self-test: {len(failures)} failure(s)")
        return 1
    print(f"self-test: {len(cases) + len(URL_TABLE) + 5} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
