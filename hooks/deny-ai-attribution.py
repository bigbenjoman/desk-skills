#!/usr/bin/env python3
"""PreToolUse(Bash) hook: refuse AI attribution in commits, PR text, GitHub API bodies and Jira text.

PER REPO. It acts only where the repo's desk config says so: §5 "AI attribution" set to `forbidden`
in ~/.config/desk/repos/<owner__name>/config.md, found from the origin remote of the call's cwd.
Any other value, no config, or no git repo means the hook allows the call. Where it is forbidden,
history and team-facing text must come from a human author alone, and this is a backstop for a
mistake that is permanent (git history) or seen by the whole team.

A compound command is split on `&&`, `||`, `;`, `|`, `&` and newlines (outside quotes and `$(...)`),
and only these subcommands are checked:
  git [-C dir | -c k=v ...] commit     its text, -F/--file and -t/--template files (any unique
                                       prefix, bundled short flags), --trailer values with
                                       -c trailer.<alias>.key aliases resolved, -c commit.template
  gh pr create|edit|comment|review|merge   its text (--body, --subject), --body-file/-F <file>
  gh api ...                           its text (-f body=...), -F/--field k=@<file>, --input <file>
  desk-jira comment|create|edit          its text, a body-file argument or field=@<file>
Checked with each: heredoc bodies, `< file` redirects, and the text and heredocs of the pipeline
stages feeding it (`cat <<EOF | git commit -F -`). Unrelated subcommands (`printf ... >> NOTES.md`)
are not. Files resolve against the call's cwd, a preceding `cd`, and `git -C`; up to 1 MB each.
Stdin from a process the hook cannot see stays unseen.

Refused, case-insensitively: a Co-Authored-By trailer (any author, `:` or `=`), Claude-Session,
'Generated with Claude Code', noreply@anthropic.com, a claude.ai/code/session_ URL, the robot emoji.
Detection is literal: a commit message that merely describes this hook and quotes a banned
trailer ("fix: hook now denies Claude-Session: lines") is refused too. Reword it; the hook
deliberately does not guess intent.

Returns only permissionDecision=deny and never updatedInput, so it coexists with any other
PreToolUse(Bash) hook that rewrites commands: only one rewrite survives, but a deny wins.
"""

import json
import os
import re
import shlex
import subprocess
import sys

CONFIG_ROOT = os.path.expanduser(os.environ.get("DESK_CONFIG_ROOT", "~/.config/desk"))
REMOTE = re.compile(r"github\.com[:/]+([^/\s]+)/([^/\s]+?)(?:\.git)?/?$")
ROW = re.compile(r"^\|\s*AI attribution\s*\|\s*`([^`]*)`", re.I | re.M)


def repo_config(cwd):
    """This repo's desk config path, or None. Slug rule matches desk-env.mjs."""
    def git(*args):
        try:
            return subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True,
                                  timeout=3).stdout.strip()
        except Exception:  # noqa: BLE001
            return ""
    m = REMOTE.search(git("remote", "get-url", "origin"))
    if m:
        slug = f"{m.group(1)}__{m.group(2)}"
    else:
        common = git("rev-parse", "--path-format=absolute", "--git-common-dir")
        if not common:
            return None
        slug = "local__" + os.path.basename(os.path.dirname(common))
    return os.environ.get("DESK_CONFIG") or os.path.join(CONFIG_ROOT, "repos", slug, "config.md")


def attribution_forbidden(cwd):
    path = repo_config(cwd)
    if not path:
        return False
    try:
        with open(path, encoding="utf-8") as f:
            m = ROW.search(f.read())
    except OSError:
        return False
    return bool(m) and m.group(1).strip().lower().startswith("forbidden")

BANNED = (
    re.compile(r"co-authored-by\s*[:=][^\n\"']*(claude|anthropic)", re.I),
    re.compile(r"claude-session\s*[:=]", re.I),
    re.compile(r"generated with \[?claude code", re.I),
    re.compile(r"noreply@anthropic\.com", re.I),
    re.compile(r"claude\.ai/code/session_", re.I),
    re.compile("\N{ROBOT FACE}"),
)

MAX_BYTES = 1 << 20
WRAPPERS = {"rtk", "env", "command", "builtin", "exec", "nohup", "time", "nice", "stdbuf", "timeout", "sudo"}
KEYWORDS = {"if", "then", "do", "else", "elif", "while", "until", "!", "{", "("}
HEREDOC = re.compile(r"(?<!<)<<(?!<)(-?)[ \t]*(?:'([^'\n]*)'|\"([^\"\n]*)\"|\\?([A-Za-z_][\w.-]*))")
PR_SUBS = {"create", "edit", "comment", "review", "merge"}
JIRA_SUBS = {"comment", "create", "edit"}


def banned(text):
    return any(b.search(text) for b in BANNED)


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


def tokens_of(segment):
    try:
        return shlex.split(segment, comments=False, posix=True)
    except ValueError:
        return segment.split()


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


# --- per-family arguments -----------------------------------------------------------------------

def long_opt(tok, full, shortest):
    """(matched, value or None) for --<unique prefix of full>[=value]."""
    if not tok.startswith("--"):
        return False, None
    name, eq, value = tok[2:].partition("=")
    if len(name) >= shortest and full.startswith(name):
        return True, value if eq else None
    return False, None


def git_commit(tokens, k, cwd):
    """(files, extra text) for a `git ... commit` whose `git` is tokens[k], or None."""
    j, gitdir, configs = k + 1, cwd, []
    while j < len(tokens) and tokens[j].startswith("-"):
        t = tokens[j]
        if t in ("-C", "-c") and j + 1 < len(tokens):
            if t == "-C":
                gitdir = os.path.join(gitdir, os.path.expanduser(tokens[j + 1]))
            else:
                configs.append(tokens[j + 1])
            j += 2
        elif t in ("--git-dir", "--work-tree", "--namespace", "--config-env") and j + 1 < len(tokens):
            j += 2
        else:
            j += 1
    if j >= len(tokens) or tokens[j] != "commit":
        return None
    files, trailers, args = [], [], tokens[j + 1:]
    aliases = {}
    for kv in configs:
        key, _, val = kv.partition("=")
        m = re.match(r"^trailer\.(.+)\.key$", key, re.I)
        if m:
            aliases[m.group(1).lower()] = val
        elif key.lower() == "commit.template":
            files.append((gitdir, val))
    i = 0
    while i < len(args):
        t = args[i]
        nxt = args[i + 1] if i + 1 < len(args) else None
        if t == "--":
            break
        took = False
        for full, shortest, kind in (("file", 3, "file"), ("template", 2, "file"), ("trailer", 2, "trailer")):
            hit, value = long_opt(t, full, shortest)
            if hit:
                if value is None:
                    value, i = nxt, i + 1
                if value is not None:
                    (files.append((gitdir, value)) if kind == "file" else trailers.append(value))
                took = True
                break
        if not took and re.match(r"^-[A-Za-z]", t):
            for pos, ch in enumerate(t[1:], start=2):
                if not ch.isalpha():
                    break
                if ch in "FtmcCuS":
                    rest = t[pos:]
                    if ch in "Ft":
                        if rest:
                            files.append((gitdir, rest))
                        elif nxt is not None:
                            files.append((gitdir, nxt))
                            i += 1
                    elif ch in "mcC" and not rest:
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
    return files, "\n".join(extra)


def gh_text(tokens, k, cwd):
    """Files for `gh pr <text sub>` or `gh api`, or None."""
    j = k + 1
    while j < len(tokens) and tokens[j].startswith("-"):
        j += 2 if tokens[j] in ("-R", "--repo") else 1
    rest = tokens[j:]
    if len(rest) >= 2 and rest[0] == "pr" and rest[1] in PR_SUBS:
        flags, api = ("-F", "--body-file"), False
    elif rest and rest[0] == "api":
        flags, api = ("-F", "--field", "--input"), True
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
            files.append((cwd, m.group(1)))
        elif not api or t.startswith("--input"):
            files.append((cwd, value))
    return files


def jira_text(tokens, k, cwd):
    if k + 1 >= len(tokens) or tokens[k + 1] not in JIRA_SUBS:
        return None
    files = []
    for i, t in enumerate(tokens[k + 2:], start=k + 2):
        m = re.match(r"^[\w.-]+=@(.+)$", t)
        if m:
            files.append((cwd, m.group(1)))
        elif i >= k + 3 and not t.startswith("-"):
            files.append((cwd, t))  # `desk-jira comment KEY <file>`: the command, sub and key come first
    return files


def redirects(tokens, cwd):
    out = []
    for i, t in enumerate(tokens):
        if t == "<" and i + 1 < len(tokens):
            out.append((cwd, tokens[i + 1]))
        elif t.startswith("<") and not t.startswith("<<") and len(t) > 1:
            out.append((cwd, t[1:]))
    return out


def read_file(base, token):
    if not token or token == "-":
        return ""
    path = os.path.expanduser(token)
    if not os.path.isabs(path):
        path = os.path.join(base, path)
    try:
        if os.path.isfile(path):
            with open(path, "rb") as f:
                return f.read(MAX_BYTES).decode("utf-8", "replace")
    except OSError:
        pass
    return ""


def classify(segment, cwd):
    """(kind, files, extra text) for a checked subcommand, ("cd", dir) or None."""
    tokens = tokens_of(segment)
    k = command_start(tokens)
    if k >= len(tokens):
        return None
    word = os.path.basename(tokens[k])
    if word == "cd":
        target = tokens[k + 1] if k + 1 < len(tokens) else "~"
        return ("cd", os.path.join(cwd, os.path.expanduser(target)))
    if word == "git":
        found = git_commit(tokens, k, cwd)
        if found:
            return ("commit", found[0] + redirects(tokens, cwd), found[1])
    elif word == "gh":
        found = gh_text(tokens, k, cwd)
        if found is not None:
            kind = "GitHub API call" if "api" in tokens[k + 1:k + 4] else "PR text"
            return (kind, found + redirects(tokens, cwd), "")
    elif word == "desk-jira":
        found = jira_text(tokens, k, cwd)
        if found is not None:
            return ("Jira text", found + redirects(tokens, cwd), "")
    return None


def find_hit(command, cwd):
    text, docs = strip_heredocs(command)
    for pipeline in split_pipelines(text):
        fed = []  # text and heredocs of earlier stages, which feed this one's stdin
        for start, end in pipeline:
            segment = text[start:end]
            bodies = [body for off, body in docs if start <= off < end]
            found = classify(segment, cwd)
            if found and found[0] == "cd":
                if len(pipeline) == 1:
                    cwd = found[1]
                found = None
            if found:
                kind, files, extra = found
                if banned("\n".join(fed + [segment, extra] + bodies)):
                    return kind, "the command"
                for base, token in files:
                    if banned(read_file(base, token)):
                        return kind, token
            fed += [segment] + bodies
    return None


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0  # never block on a malformed payload

    command = (payload.get("tool_input") or {}).get("command") or ""
    cwd = payload.get("cwd") or os.getcwd()
    if not re.search(r"\b(?:git|gh|desk-jira)\b", command):
        return 0
    if not attribution_forbidden(cwd):
        return 0
    try:
        hit = find_hit(command, cwd)
    except Exception:  # noqa: BLE001 - a parser bug fails closed on the whole command text
        hit = ("command", "the command") if banned(command) else None
    if hit is None:
        return 0

    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    f"The {hit[0]} in {hit[1]} carries AI attribution, which must never reach "
                    "this repo's git history, PRs or Jira (desk config §5 AI attribution: forbidden). Remove any Co-Authored-By trailer, "
                    "Claude-Session line, noreply@anthropic.com, claude.ai/code/session_ link, "
                    "'Generated with Claude Code' line and the robot emoji, then run it again."
                ),
            }
        },
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
