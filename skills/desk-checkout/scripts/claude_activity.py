#!/usr/bin/env python3
"""Summarise Claude Code sessions active on the check-out day.

Reads ~/.claude/projects/*/*.jsonl (top-level session transcripts only; subagent
transcripts are skipped because their parent session already carries the work)
and prints one compact block per session: repo, branches, what the human asked,
and how the session ended. The output is evidence for a check-out, not the
check-out itself, so it stays terse.

A session that loads the desk-checkout skill is cut off at that point, so the
drafting session never reports itself and needs no session ID.

Every session under ~/.claude/projects is considered, whatever repo it ran in. Its scope
comes from the per-repo desk configs (see desk_repos.py): a session whose directory is under
a configured repo's §2 Primary repo root or Worktrees directory takes that repo's scope
(this check-out, other desk repo), the current repo's checkout counts as this check-out
even unconfigured, directories in DESK_CHECKOUT_SIDE_ROOTS (comma-separated) are side
projects, and anything else is marked not work for this check-out. Ticket keys are found
with each in-scope repo's §4 Ticket key pattern.

A session in a configured repo is summarised only when that repo's §3 read-transcripts is
`yes` (or `ask` and passed with --include <slug>); a session in no configured repo follows
the current repo's row.

Usage:
  claude_activity.py [--day auto|today|yesterday|<weekday>|YYYY-MM-DD] [--include <slug>]
  claude_activity.py --session <id-prefix> [--tail 6]   # the last substantive replies, in full
"""
import argparse
import glob
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime

sys.dont_write_bytecode = True  # a __pycache__ in the installed skill reads as a user edit to install.sh
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import window  # noqa: E402
import desk_repos  # noqa: E402

HOME = os.path.expanduser("~")
NOISE_PREFIXES = (
    "<task-notification",
    "<command-",
    "<local-command",
    "<system-reminder",
    "Another Claude session sent a message",
    "Caveat:",
    "[Request interrupted",
)
# Harness failures and auth prompts: they say nothing about the work.
HOUSEKEEPING = re.compile(
    r"API Error|Please run /login|ENOTFOUND|Authentication failed|rate limit|Credit balance|context (?:is|at) \d+%",
    re.I,
)
EDIT_TOOLS = {"Edit", "Write", "NotebookEdit", "MultiEdit"}
PR_IN_COMMAND = re.compile(r"gh pr (?:merge|ready|view|edit|checks|review|comment|close)\s+(?:-\S+\s+\S+\s+)*#?(\d{3,5})\b")
PR_URL = re.compile(r"github\.com/[\w.-]+/[\w.-]+/pull/(\d+)")
SELF_MARKER = "desk-checkout"

# Filled in main(): every configured repo, the current one, and the side-project roots.
REPOS, CURRENT, SIDE_ROOTS = [], None, ()
TICKET_RES = []


def entry_time(entry):
    ts = entry.get("timestamp")
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def human_text(entry):
    """Return the text a human typed, or None for tool results and harness noise."""
    if entry.get("type") != "user" or entry.get("isMeta") or entry.get("isSidechain"):
        return None
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, list):
        parts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
        if not parts:
            return None
        content = "\n".join(parts)
    if not isinstance(content, str):
        return None
    text = content.strip()
    if not text or text.startswith(NOISE_PREFIXES) or HOUSEKEEPING.search(text[:300]):
        return None
    # "eta", "try again", "askuser": steering, not a statement of the work.
    if len(text) < 15 and "\n" not in text:
        return None
    text = re.sub(r"</?pasted_content[^>]*>", "", text)
    return " ".join(text.split())


def assistant_parts(entry):
    if entry.get("type") != "assistant" or entry.get("isSidechain"):
        return None, []
    content = (entry.get("message") or {}).get("content") or []
    texts, tools = [], []
    for c in content if isinstance(content, list) else []:
        if c.get("type") == "text" and c.get("text", "").strip():
            texts.append(c["text"].strip())
        elif c.get("type") == "tool_use":
            tools.append(c)
    text = "\n".join(texts) or None
    if text and HOUSEKEEPING.search(text[:300]) and len(text) < 400:
        text = None
    return text, tools


def loads_self(entry):
    """True when this entry is the desk-checkout skill being loaded."""
    if entry.get("type") == "assistant":
        for c in (entry.get("message") or {}).get("content") or []:
            if isinstance(c, dict) and c.get("type") == "tool_use" and c.get("name") == "Skill":
                if SELF_MARKER in json.dumps(c.get("input", {})):
                    return True
    if entry.get("type") == "user":
        raw = json.dumps((entry.get("message") or {}).get("content", ""))[:600]
        return "Base directory for this skill" in raw and SELF_MARKER in raw
    return False


def shorten(text, limit):
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def repo_label(cwd):
    if not cwd:
        return "?"
    rel = cwd.replace(HOME, "~")
    rel = re.sub(r"/\.claude/worktrees/([^/]+)", r" (worktree \1)", rel)
    rel = re.sub(r"-worktrees/([^/]+)", r" (worktree \1)", rel)
    return rel


_scope_cache = {}


def scope_and_repo(cwd):
    """(scope, Repo or None) for a session directory: this / side / other / none."""
    if cwd in _scope_cache:
        return _scope_cache[cwd]
    repo = desk_repos.repo_for_path(cwd, REPOS, CURRENT)
    if repo is not None:
        out = (repo.scope, repo)
    elif cwd and desk_repos.under(os.path.realpath(cwd), SIDE_ROOTS):
        out = ("side", None)
    else:
        out = ("none", None)
    _scope_cache[cwd] = out
    return out


def in_scope(cwd):
    return bool(cwd) and scope_and_repo(cwd)[0] == "this"


def scope_suffix(cwd):
    sc = scope_and_repo(cwd)[0]
    return "" if sc == "this" else ", " + desk_repos.SCOPE_LABELS[sc]


def read_session(path, since, until):
    s = {
        "id": os.path.basename(path)[:-6], "cwd": None, "branches": Counter(), "prompts": [],
        "texts": [], "tools": Counter(), "commits": [], "prs": set(), "tickets": Counter(),
        "first": None, "last": None, "entrypoint": None,
    }
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            when = entry_time(entry)
            if when is None or not (since <= when < until):
                continue
            if loads_self(entry):
                break  # everything after this is the check-out being drafted
            s["cwd"] = entry.get("cwd") or s["cwd"]
            s["entrypoint"] = entry.get("entrypoint") or s["entrypoint"]
            if entry.get("gitBranch") and entry["gitBranch"] != "HEAD":
                s["branches"][entry["gitBranch"]] += 1
            prompt = human_text(entry)
            text, tools = assistant_parts(entry)
            if prompt:
                s["prompts"].append(prompt)
            if text:
                s["texts"].append((when, text))
            for tool in tools:
                name = tool.get("name", "?")
                s["tools"][name] += 1
                if name == "Bash":
                    cmd = (tool.get("input") or {}).get("command", "")
                    m = re.search(r"git commit[^\n]*?-m\s+[\"']([^\"'\n]{1,120})", cmd)
                    if m:
                        s["commits"].append(m.group(1))
                    s["prs"].update(PR_IN_COMMAND.findall(cmd))
            for blob in filter(None, [prompt, text]):
                if not in_scope(s["cwd"]):
                    break  # a session elsewhere relaying this team's news must not merge into its items
                for rx in TICKET_RES:
                    s["tickets"].update(m.group(0) for m in rx.finditer(blob))
                s["prs"].update(PR_URL.findall(blob))
            if prompt or text or tools:
                # Span covers substantive events only, so a late /login error doesn't stretch it.
                s["first"] = s["first"] or when
                s["last"] = when
    return s


def find_files(since):
    files = glob.glob(os.path.join(HOME, ".claude/projects/*/*.jsonl"))
    return [f for f in files if os.path.getmtime(f) >= since.timestamp()]


def tail_mode(prefix, since, until, n):
    matches = [f for f in find_files(since) if os.path.basename(f).startswith(prefix)]
    if not matches:
        print(f"No session starting {prefix} active in the window.")
        return
    s = read_session(matches[0], since, until)
    ok, note = desk_repos.allowed(scope_and_repo(s["cwd"])[1] or CURRENT, "read-transcripts")
    if not ok:
        print(f"Session {s['id'][:8]} withheld: {note}")
        return
    print(f"# Session {s['id']} — {repo_label(s['cwd'])}, last {n} substantive replies\n")
    for when, text in s["texts"][-n:]:
        print(f"## {when.astimezone().strftime('%H:%M')}\n{text[:2500]}\n")


def main():
    global REPOS, CURRENT, SIDE_ROOTS, TICKET_RES
    ap = argparse.ArgumentParser()
    window.add_day_argument(ap)
    desk_repos.add_include_argument(ap)
    ap.add_argument("--session", help="print one session's last replies in full instead")
    ap.add_argument("--tail", type=int, default=6)
    ap.add_argument("--prompt-chars", type=int, default=280)
    ap.add_argument("--max-prompts", type=int, default=8)
    args = ap.parse_args()
    since, until = window.resolve(args.day)
    REPOS, CURRENT = desk_repos.load_all(args.include)
    SIDE_ROOTS = desk_repos.side_roots()
    TICKET_RES = [r.ticket_regex for r in REPOS if r.scope == "this" and r.ticket_regex]

    if args.session:
        tail_mode(args.session, since, until, args.tail)
        return

    sessions, workers, withheld = [], [], {}
    for path in find_files(since):
        s = read_session(path, since, until)
        if not s["first"]:
            continue
        # Per-repo permission: a configured repo's own §3 read-transcripts decides; a session in
        # no configured repo follows the current repo's row.
        owner = scope_and_repo(s["cwd"])[1] or CURRENT
        ok, note = desk_repos.allowed(owner, "read-transcripts")
        if not ok:
            withheld[note] = withheld.get(note, 0) + 1
            continue
        # A session with no tool calls and one short prompt is a probe ("reply with just OK").
        if not s["tools"] and sum(len(p) for p in s["prompts"]) < 60:
            continue
        headless = s["entrypoint"] in ("sdk-cli", "sdk-ts", "sdk-py")
        # Headless preflight/triage workers with almost no tool use are autopilot plumbing.
        preflight = s["texts"] and re.match(r"\s*W_IN=", s["texts"][-1][1])
        if headless and (sum(s["tools"].values()) < 3 or preflight):
            workers.append(s)
            continue
        sessions.append(s)
    sessions.sort(key=lambda s: (desk_repos.SCOPE_ORDER[scope_and_repo(s["cwd"])[0]], s["first"]))

    tz = since.astimezone().tzname() or "local time"
    print(f"# Claude Code activity, {window.label(since)} ({tz}) — {len(sessions)} sessions\n")
    if not sessions:
        print("No Claude Code activity in the window.")
    for s in sessions:
        kind = "headless worker" if s["entrypoint"] in ("sdk-cli", "sdk-ts", "sdk-py") else "interactive"
        scope = scope_suffix(s["cwd"])
        edits = sum(n for t, n in s["tools"].items() if t in EDIT_TOOLS)
        span = f"{s['first'].astimezone():%H:%M}–{s['last'].astimezone():%H:%M}"
        print(f"## {repo_label(s['cwd'])}  [{span}, {kind}{scope}, session {s['id'][:8]}]")
        if s["branches"]:
            print("branches: " + ", ".join(b for b, _ in s["branches"].most_common(4)))
        if s["tickets"]:
            print("tickets mentioned: " + ", ".join(t for t, _ in s["tickets"].most_common(8)))
        print(f"tool calls: {sum(s['tools'].values())} (file edits {edits}, bash {s['tools'].get('Bash', 0)})")
        if s["commits"]:
            print("commits: " + " | ".join(shorten(c, 90) for c in s["commits"][:6]))
        if s["prs"]:
            print("PRs acted on: " + ", ".join("#" + p for p in sorted(s["prs"])))
        prompts = s["prompts"]
        if prompts:
            print("asked:")
            if len(prompts) > args.max_prompts:
                keep = args.max_prompts - 3
                print(f"  ({len(prompts)} prompts; first 3 and last {keep} shown)")
                prompts = prompts[:3] + prompts[-keep:]
            for p in prompts:
                print("  - " + shorten(p, args.prompt_chars))
        if s["texts"]:
            print("ended with: " + shorten(s["texts"][-1][1], 600))
        print()
    if workers:
        print(f"({len(workers)} short headless autopilot/preflight sessions omitted)")
    for note, n in sorted(withheld.items()):
        print(f"({n} session{'s' if n > 1 else ''} withheld: {note})")


if __name__ == "__main__":
    sys.exit(main())
