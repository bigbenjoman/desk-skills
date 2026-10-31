#!/usr/bin/env python3
"""Autopilot worker Read hook: no reading a file again that is unchanged since the last read.

Workers never compact, so the first copy of a file they Read stays in context for the rest of the
session, and a second Read of the same file and range pays for it twice. worker-settings.mjs
registers this script on PreToolUse and PostToolUse (matcher Read) and on PreCompact in every
worker's settings. It acts only where DESK_AUTOPILOT_WORKER=1 (set by spawn-worker.sh), and
DESK_ALLOW_REREAD=1 turns it off.

- PostToolUse records each successful Read: the path, its range (offset, limit, pages) and a
  sha256 of the file's content, one record per path and range under
  ~/.claude/desk/worker-reread/<session id>/.
- PreToolUse refuses a Read whose path and range have a record and whose content hashes the same,
  naming the earlier read. A changed hash (an edit, a rebase, any shell command) lets it through, as
  does a range never read.
- PreCompact drops the session's records: after a compaction the earlier copy is gone.

A subagent shares its parent's session id but holds none of its context, so a call carrying
agent_id (set only inside a subagent) is neither recorded nor refused.

Never fails a session: any error exits 0 with no output, which lets the Read through.
"""
import hashlib
import json
import os
import shutil
import sys
import time

HOME = os.path.expanduser("~")
DESK_HOME = os.path.expanduser(os.environ.get("DESK_HOME") or os.path.join(HOME, ".claude", "desk"))
STATE_DIR = os.path.join(DESK_HOME, "worker-reread")
RANGE_KEYS = ("offset", "limit", "pages")


def safe(s):
    return "".join(c for c in str(s) if c.isalnum() or c in "-_") or "unknown"


def session_dir(session):
    return os.path.join(STATE_DIR, safe(session))


def target(inp):
    """(real path, range dict) for a Read input, or None when it names no file."""
    path = inp.get("file_path")
    if not isinstance(path, str) or not path:
        return None
    return os.path.realpath(path), {k: inp[k] for k in RANGE_KEYS if inp.get(k) not in (None, "")}


def record_path(session, path, rng):
    key = json.dumps([path, rng], sort_keys=True)
    return os.path.join(session_dir(session), hashlib.sha1(key.encode()).hexdigest() + ".json")


def content_hash(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def describe(rng):
    if not rng:
        return "the whole file"
    if "pages" in rng:
        return f"pages {rng['pages']}"
    start = int(rng.get("offset") or 1)
    return f"lines {start}-{start + int(rng['limit']) - 1}" if "limit" in rng else f"from line {start}"


def post(session, inp):
    t = target(inp)
    if not t:
        return
    path, rng = t
    rec = {"path": path, "range": rng, "sha256": content_hash(path), "at": time.strftime("%H:%M:%S")}
    out = record_path(session, path, rng)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    tmp = f"{out}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(rec, f)
    os.replace(tmp, out)


def pre(session, inp):
    t = target(inp)
    if not t:
        return
    path, rng = t
    try:
        with open(record_path(session, path, rng)) as f:
            rec = json.load(f)
    except Exception:
        return
    if rec.get("sha256") != content_hash(path):
        return
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": (
            f"desk autopilot: you already read {inp['file_path']} ({describe(rng)}) at {rec.get('at')} in this "
            "session, and its content has not changed since, so that copy is still in your context. "
            "Use it rather than reading the file again. An edit or a command that changes the file "
            "lets the next read through, and so does a different range."),
    }}))


def main():
    if os.environ.get("DESK_AUTOPILOT_WORKER") != "1" or os.environ.get("DESK_ALLOW_REREAD") == "1":
        return
    data = json.load(sys.stdin)
    session = data.get("session_id")
    if not session or data.get("agent_id"):
        return
    event = data.get("hook_event_name")
    if event == "PreCompact":
        shutil.rmtree(session_dir(session), ignore_errors=True)
        return
    if data.get("tool_name") != "Read" or not isinstance(data.get("tool_input"), dict):
        return
    if event == "PreToolUse":
        pre(session, data["tool_input"])
    elif event == "PostToolUse":
        post(session, data["tool_input"])


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
