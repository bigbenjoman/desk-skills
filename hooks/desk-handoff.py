#!/usr/bin/env python3
"""Context handoff hook: keep a desk session's carry-over in .handoffs/ and resume from it.

One script, registered by install.sh on four events; it reads `hook_event_name` from its input.

  UserPromptSubmit, PostToolUse  Once the session's input-side context passes config §2 "Handoff at
                                 context %" (default 45, `0` disables), inject once: finish the
                                 current step, write the handoff, start no new work.
  Stop                           After that has fired, and while no handoff newer than the firing
                                 exists, block the end of the turn once ("write the handoff first").
  SessionStart                   source `clear` or `compact`: inject "read .handoffs/<latest>.md and
                                 continue from its next step" when that file is under 24 hours old
                                 and not yet consumed, then mark it consumed. Any source also records
                                 the session's model, which says whether the window is 1M.

A desk session is one whose repo has a desk config (`desk-env where` says EXISTS=yes); anywhere else
the hook is silent. Context used is the last main-chain assistant entry's usage in the transcript
(input + cache creation + cache read tokens), divided by the window: DESK_CONTEXT_WINDOW if set,
else 1,000,000 for a `[1m]` model (or once usage has passed 200,000, which no smaller window
allows), else 200,000. Handoffs are <repo root>/.handoffs/<yyyy-mm-dd>[-n].md, and .handoffs/ is
added to .git/info/exclude. Per-session state is ~/.claude/desk/handoff/<session id>.json, which is
also the marker that stops a second injection or a second Stop block.

Never fails a session: any error exits 0 with no output.
"""
import glob
import json
import os
import subprocess
import sys
import time

DEFAULT_PCT = 45
SMALL_WINDOW = 200_000
LARGE_WINDOW = 1_000_000
FRESH_SECONDS = 24 * 3600
TAIL_LIMIT = 8 * 1024 * 1024  # how far back to look for the last main-chain usage
HOME = os.path.expanduser("~")
DESK_HOME = os.path.expanduser(os.environ.get("DESK_HOME") or os.path.join(HOME, ".claude", "desk"))
STATE_DIR = os.path.join(DESK_HOME, "handoff")


def git(root, *args):
    try:
        return subprocess.run(["git", "-C", root, *args], capture_output=True, text=True,
                              timeout=5).stdout.strip()
    except Exception:
        return ""


def desk_env(root, *args):
    """(exit code, stdout) of desk-env.mjs run for this repo."""
    script = os.path.join(DESK_HOME, "bin", "desk-env.mjs")
    env = dict(os.environ, DESK_REPO_DIR=root)
    try:
        p = subprocess.run(["node", script, *args], capture_output=True, text=True, timeout=10,
                           cwd=root, env=env)
        return p.returncode, p.stdout
    except Exception:
        return 1, ""


def threshold(root):
    """The §2 percentage for this repo; 0 when it is not a desk repo or the row disables it."""
    rc, out = desk_env(root, "where")
    if rc != 0 or "EXISTS=yes" not in out:
        return 0
    rc, out = desk_env(root, "get", "handoff-pct")
    if rc != 0:
        return DEFAULT_PCT
    try:
        pct = float(out.strip().rstrip("%"))
    except ValueError:
        return DEFAULT_PCT
    return pct if 0 <= pct < 100 else DEFAULT_PCT


def state_path(session):
    safe = "".join(c for c in str(session) if c.isalnum() or c in "-_") or "unknown"
    return os.path.join(STATE_DIR, safe + ".json")


def load_state(session):
    try:
        with open(state_path(session)) as f:
            s = json.load(f)
        return s if isinstance(s, dict) else {}
    except Exception:
        return {}


def save_state(session, state):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = state_path(session) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, state_path(session))


def context_used(transcript):
    """Input-side tokens of the last main-chain assistant entry, or None."""
    try:
        with open(transcript, "rb") as f:
            f.seek(0, os.SEEK_END)
            end = f.tell()
            start = max(0, end - TAIL_LIMIT)
            f.seek(start)
            data = f.read()
    except Exception:
        return None
    lines = data.split(b"\n")
    if start > 0:
        lines = lines[1:]  # the first line may be cut
    for raw in reversed(lines):
        if b'"usage"' not in raw:
            continue
        try:
            e = json.loads(raw)
        except Exception:
            continue
        if e.get("type") != "assistant" or e.get("isSidechain"):
            continue
        u = (e.get("message") or {}).get("usage") or {}
        total = sum(int(u.get(k) or 0) for k in
                    ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
        if total > 0:
            return total
    return None


def model_hint(state):
    if state.get("model"):
        return str(state["model"])
    if os.environ.get("ANTHROPIC_MODEL"):
        return os.environ["ANTHROPIC_MODEL"]
    try:
        with open(os.path.join(HOME, ".claude", "settings.json")) as f:
            return str(json.load(f).get("model") or "")
    except Exception:
        return ""


def window(state, used):
    try:
        w = int(os.environ.get("DESK_CONTEXT_WINDOW") or 0)
        if w > 0:
            return w
    except ValueError:
        pass
    if "[1m]" in model_hint(state).lower() or used > SMALL_WINDOW:
        return LARGE_WINDOW
    return SMALL_WINDOW


def handoff_dir(root):
    return os.path.join(root, ".handoffs")


def next_handoff(root):
    day = time.strftime("%Y-%m-%d")
    path, n = os.path.join(handoff_dir(root), day + ".md"), 1
    while os.path.exists(path):
        n += 1
        path = os.path.join(handoff_dir(root), f"{day}-{n}.md")
    return path


def exclude_handoffs(root):
    common = git(root, "rev-parse", "--path-format=absolute", "--git-common-dir")
    if not common:
        return
    path = os.path.join(common, "info", "exclude")
    try:
        lines = open(path).read().splitlines() if os.path.exists(path) else []
        if any(line.strip() in (".handoffs/", ".handoffs", "/.handoffs/") for line in lines):
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a") as f:
            if lines and lines[-1] != "":
                f.write("\n")
            f.write(".handoffs/\n")
    except Exception:
        pass


def handoffs(root):
    """Handoff files, newest first."""
    files = glob.glob(os.path.join(handoff_dir(root), "*.md"))
    return sorted(files, key=os.path.getmtime, reverse=True)


def inject(event, text):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}))


def session_threshold(state, root):
    """The threshold, looked up once per session and repo (two node calls), then cached."""
    if state.get("root") != root or "pct" not in state:
        state["root"], state["pct"] = root, threshold(root)
    return state["pct"]


def on_context(event, data, session, root):
    state = load_state(session)
    if state.get("fired_at"):
        return
    pct = session_threshold(state, root)
    if not pct:
        save_state(session, state)
        return
    used = context_used(data.get("transcript_path") or "")
    if used is None:
        save_state(session, state)
        return
    w = window(state, used)
    now = used * 100.0 / w
    if now < pct:
        save_state(session, state)
        return
    path = next_handoff(root)
    exclude_handoffs(root)
    state.update(fired_at=time.time(), handoff=path, blocked=False)
    save_state(session, state)
    rel = os.path.relpath(path, root)
    inject(event, (
        f"desk handoff: context is at {now:.0f}% of a {w:,}-token window (threshold {pct:g}%). "
        "Finish the step you are on, then write the handoff and start no new work. "
        f"Write it to {path} (repo-relative: {rel}), following ~/.claude/rules/handoffs.md where it "
        "exists, with these sections: where things stand; the task in progress and its next step; "
        "decisions made; open questions; and last, the paste-in line "
        f"(`Read {rel} and continue from its next step.`). "
        "Then tell the user to type /clear: the next session reads the handoff on its own."))


def on_stop(data, session, root):
    if data.get("stop_hook_active"):
        return
    state = load_state(session)
    fired = state.get("fired_at")
    if not fired or state.get("blocked"):
        return
    if any(os.path.getmtime(f) >= fired - 1 for f in handoffs(root)):
        return
    state["blocked"] = True
    save_state(session, state)
    path = state.get("handoff") or next_handoff(root)
    print(json.dumps({"decision": "block", "reason": (
        f"desk handoff: write the handoff first. Context passed the threshold; write {path} "
        "(where things stand, the task in progress and its next step, decisions made, open "
        "questions, the paste-in line), then end the turn and tell the user to type /clear.")}))


def on_session_start(data, session, root):
    state = load_state(session)
    if data.get("model"):
        m = data["model"]
        state["model"] = m.get("id") if isinstance(m, dict) else str(m)
    source = data.get("source")
    if source in ("clear", "compact"):
        # The context just emptied, so the next threshold crossing is a new one.
        for k in ("fired_at", "blocked", "handoff"):
            state.pop(k, None)
    pct = session_threshold(state, root)
    save_state(session, state)
    if source not in ("clear", "compact") or not pct:
        return
    files = handoffs(root)
    if not files or time.time() - os.path.getmtime(files[0]) > FRESH_SECONDS:
        return
    latest = files[0]
    name = os.path.basename(latest)
    consumed_path = os.path.join(handoff_dir(root), ".consumed")
    try:
        consumed = open(consumed_path).read().split()
    except Exception:
        consumed = []
    if name in consumed:
        return
    with open(consumed_path, "a") as f:
        f.write(name + "\n")
    rel = os.path.relpath(latest, root)
    inject("SessionStart", (
        f"desk handoff: read {rel} (in {root}) and continue from its next step. "
        "It is the previous session's carry-over; treat its decisions as made and its open "
        "questions as still open."))


def main():
    data = json.load(sys.stdin)
    event = data.get("hook_event_name")
    cwd = data.get("cwd") or os.getcwd()
    root = git(cwd, "rev-parse", "--show-toplevel")
    session = data.get("session_id")
    if not root or not session:
        return
    if event in ("UserPromptSubmit", "PostToolUse"):
        on_context(event, data, session, root)
    elif event == "Stop":
        on_stop(data, session, root)
    elif event == "SessionStart":
        on_session_start(data, session, root)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
