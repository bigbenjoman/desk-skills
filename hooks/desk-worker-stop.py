#!/usr/bin/env python3
"""Autopilot worker Stop hook: no ending the turn with a background task still running.

`claude -p` kills a worker's background tasks when its turn ends, so a suite started with
run_in_background and left running is killed half way and the worker reports work that never
finished. worker-settings.mjs registers this on Stop in every worker's settings; it acts only where
DESK_AUTOPILOT_WORKER=1 (set by spawn-worker.sh), so any other session is untouched.

A background task is a Bash call whose result says "running in background with ID: <id>. Output is
being written to: <file>". It is still running while some process holds that file open (lsof, or
/proc on Linux). Where neither can be read, it is running until the transcript carries its
completion notification (`<task-id><id></task-id>` with a status) or a TaskStop/KillShell for it.

The first Stop with a task running is blocked, naming the task. A later Stop with the same task
still running ends the turn, and the hook appends a `[stop-hook]` line to the worker log
(DESK_WORKER_LOG, set by spawn-worker.sh; stderr without it) saying the rule was broken. Which tasks
it has already blocked on is kept per session in ~/.claude/desk/worker-stop/<session id>.json.

Never fails a session: any error exits 0 with no output.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time

HOME = os.path.expanduser("~")
DESK_HOME = os.path.expanduser(os.environ.get("DESK_HOME") or os.path.join(HOME, ".claude", "desk"))
STATE_DIR = os.path.join(DESK_HOME, "worker-stop")
STARTED = re.compile(r"running in background with ID: ([A-Za-z0-9_-]+)\. "
                     r"Output is being written to: (\S+?\.output)")
DONE = re.compile(r"<task-id>([A-Za-z0-9_-]+)</task-id>.*?<status>([a-z_]+)</status>", re.S)
STOP_TOOLS = ("TaskStop", "KillShell", "KillBash")


def strings(v):
    """Every string inside a parsed transcript entry."""
    if isinstance(v, str):
        yield v
    elif isinstance(v, dict):
        for x in v.values():
            yield from strings(x)
    elif isinstance(v, list):
        for x in v:
            yield from strings(x)


def entries(transcript):
    try:
        with open(transcript) as f:
            for line in f:
                try:
                    yield json.loads(line)
                except Exception:
                    continue
    except Exception:
        return


def background_tasks(transcript):
    """{id: {"file", "desc", "done"}} for each background Bash task the transcript started."""
    calls, tasks, stopped = {}, {}, set()
    for e in entries(transcript):
        content = (e.get("message") or {}).get("content")
        for c in content if isinstance(content, list) else []:
            if not isinstance(c, dict):
                continue
            inp = c.get("input") if isinstance(c.get("input"), dict) else {}
            if c.get("type") == "tool_use" and c.get("name") == "Bash":
                calls[c.get("id")] = inp.get("description") or str(inp.get("command") or "")[:80]
            elif c.get("type") == "tool_use" and c.get("name") in STOP_TOOLS:
                stopped.update(str(inp.get(k)) for k in ("task_id", "shell_id", "bash_id") if inp.get(k))
            elif c.get("type") == "tool_result":
                for s in strings(c.get("content")):
                    m = STARTED.search(s)
                    if m:
                        tasks[m.group(1)] = {"file": m.group(2), "desc": calls.get(c.get("tool_use_id")) or "",
                                             "done": False}
        for s in strings(e):
            if "<task-id>" in s:
                for m in DONE.finditer(s):
                    if m.group(1) in tasks:
                        tasks[m.group(1)]["done"] = True
    for tid in stopped & set(tasks):
        tasks[tid]["done"] = True
    return tasks


def held_open(path):
    """True when some process has `path` open, False when none does, None when it cannot be told."""
    if shutil.which("lsof"):
        try:
            p = subprocess.run(["lsof", "-t", "--", path], capture_output=True, text=True, timeout=10)
            # lsof exits 1 both for "no process" and for errors; an error writes to stderr.
            if p.stdout.strip():
                return True
            if p.returncode == 1 and not p.stderr.strip():
                return False
        except Exception:
            pass
    if os.path.isdir("/proc/self/fd"):
        try:
            target = os.path.realpath(path)
            for pid in os.listdir("/proc"):
                if not pid.isdigit():
                    continue
                fd_dir = os.path.join("/proc", pid, "fd")
                try:
                    for fd in os.listdir(fd_dir):
                        if os.path.realpath(os.path.join(fd_dir, fd)) == target:
                            return True
                except Exception:
                    continue
            return False
        except Exception:
            pass
    return None


def running(transcript):
    """[(id, desc, file)] of the background tasks still running."""
    out = []
    for tid, t in background_tasks(transcript).items():
        held = held_open(t["file"]) if os.path.exists(t["file"]) else False
        if held or (held is None and not t["done"]):
            out.append((tid, t["desc"], t["file"]))
    return out


def state_path(session):
    safe = "".join(c for c in str(session) if c.isalnum() or c in "-_") or "unknown"
    return os.path.join(STATE_DIR, safe + ".json")


def load_blocked(session):
    try:
        with open(state_path(session)) as f:
            return set(json.load(f).get("blocked") or [])
    except Exception:
        return set()


def save_blocked(session, blocked):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = state_path(session) + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"blocked": sorted(blocked)}, f)
    os.replace(tmp, state_path(session))


def named(tasks):
    return "; ".join(f"{tid} ({desc})" if desc else tid for tid, desc, _ in tasks)


def record_broken(tasks):
    line = (f"[stop-hook] {time.strftime('%Y-%m-%dT%H:%M:%S%z')} rule broken: the worker ended its "
            f"turn with a background task still running, which claude -p now kills: {named(tasks)}\n")
    log = os.environ.get("DESK_WORKER_LOG")
    try:
        if log:
            with open(log, "a") as f:
                f.write(line)
            return
    except Exception:
        pass
    sys.stderr.write(line)


def main():
    if os.environ.get("DESK_AUTOPILOT_WORKER") != "1":
        return
    data = json.load(sys.stdin)
    session = data.get("session_id")
    if data.get("hook_event_name") != "Stop" or not session:
        return
    tasks = running(data.get("transcript_path") or "")
    if not tasks:
        return
    blocked = load_blocked(session)
    fresh = [t for t in tasks if t[0] not in blocked]
    if not fresh:
        record_broken(tasks)
        return
    save_blocked(session, blocked | {t[0] for t in fresh})
    print(json.dumps({"decision": "block", "reason": (
        f"desk autopilot: a background task you started is still running: {named(fresh)}. "
        "claude -p kills it the moment your turn ends, so its work would never finish. Stop it "
        "with TaskStop and run it again in the foreground under the lock, which waits for it, "
        "then end your turn.")}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
