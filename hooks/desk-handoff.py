#!/usr/bin/env python3
"""Context handoff hook: keep a desk session's carry-over in .handoffs/ and resume from it.

One script, registered by install.sh on four events; it reads `hook_event_name` from its input.

  UserPromptSubmit, PostToolUse  Once the session's input-side context passes config §2 "Handoff at
                                 context %" (default 45, `0` disables), or on a 1M window §2
                                 "Handoff at context % on a 1M window" (unset, the first row's value;
                                 `0` disables), inject once: finish the current
                                 step, write the handoff, start no new work.
  Stop                           After that has fired, and while the handoff it named is unwritten,
                                 block the end of the turn once ("write the handoff first").
  SessionStart                   source `clear` or `compact`: inject "read .handoffs/<name>.md and
                                 continue from its next step" for the handoff this session was told
                                 to write (else, with none recorded, the newest written one) when
                                 that file is written, under 24 hours old and not yet consumed, then
                                 mark it consumed. Any source also records the session's model, which
                                 says whether the window is 1M.

Naming a handoff creates it, holding a one-line placeholder, so two sessions in one repo are never
given the same name; a placeholder is not a written handoff.

A desk session is one whose repo has a desk config (`desk-env where` says EXISTS=yes); anywhere else
the hook is silent. Context used is the last main-chain assistant entry's usage in the transcript
since its last compaction (input + cache creation + cache read tokens), divided by the window: DESK_CONTEXT_WINDOW if set,
else 1,000,000 for a `[1m]` model (SessionStart's model id, or ANTHROPIC_MODEL or settings.json's
`model` for the same family, since that id drops the suffix; or once usage has passed 200,000,
which no smaller window allows), else 200,000. Handoffs are <repo root>/.handoffs/<yyyy-mm-dd>[-n].md, and .handoffs/ is
added to .git/info/exclude. Per-session state is ~/.claude/desk/handoff/<session id>.json, which is
also the marker that stops a second injection or a second Stop block.

Never fails a session: any error exits 0 with no output.

Run as `desk-handoff.py offer-1m [--asked] [<dir>]` (not a hook event), it is /desk-update's one-time
offer to lower a 1M threshold of 45 to 20: see offer_1m.
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


def row_pct(root, row, default):
    rc, out = desk_env(root, "get", row)
    if rc != 0:
        return default
    try:
        pct = float(out.strip().rstrip("%"))
    except ValueError:
        return default
    return pct if 0 <= pct < 100 else default


def threshold(root):
    """The §2 percentages for this repo, (200k window, 1M window); 0 for one the rows disable, and
    (0, 0) when it is not a desk repo. An unset 1M row is the 200k row's value."""
    rc, out = desk_env(root, "where")
    if rc != 0 or "EXISTS=yes" not in out:
        return 0, 0
    pct = row_pct(root, "handoff-pct", DEFAULT_PCT)
    return pct, row_pct(root, "handoff-pct-1m", pct)


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
    """Input-side tokens of the last main-chain assistant entry since the last compaction, or None.

    A compaction keeps the transcript file and writes a `compact_boundary` entry; usage from before
    it describes the context that was just summarised away, so the scan stops there."""
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
        if b'"usage"' not in raw and b"compact_boundary" not in raw:
            continue
        try:
            e = json.loads(raw)
        except Exception:
            continue
        if e.get("type") == "system" and e.get("subtype") == "compact_boundary":
            return None
        if e.get("type") != "assistant" or e.get("isSidechain"):
            continue
        u = (e.get("message") or {}).get("usage") or {}
        total = sum(int(u.get(k) or 0) for k in
                    ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
        if total > 0:
            return total
    return None


def configured_model():
    """The model the user chose: ANTHROPIC_MODEL, else ~/.claude/settings.json's `model`."""
    if os.environ.get("ANTHROPIC_MODEL"):
        return os.environ["ANTHROPIC_MODEL"]
    try:
        with open(os.path.join(HOME, ".claude", "settings.json")) as f:
            return str(json.load(f).get("model") or "")
    except Exception:
        return ""


def family(model):
    """`opus` for `opus[1m]` and `claude-opus-5-5` alike: the first part not `claude` or a number."""
    for part in model.lower().replace("[1m]", "").split("-"):
        if part and part != "claude" and not part.isdigit():
            return part
    return ""


def is_1m(state):
    """Whether the session runs on a 1M window. SessionStart's model id carries no `[1m]` even on a
    1M session, so a `[1m]` the user chose counts too, for the same model family."""
    model = str(state.get("model") or "")
    if "[1m]" in model.lower():
        return True
    chosen = configured_model()
    if "[1m]" not in chosen.lower():
        return False
    return not model or family(chosen) == family(model)


def window(state, used):
    try:
        w = int(os.environ.get("DESK_CONTEXT_WINDOW") or 0)
        if w > 0:
            return w
    except ValueError:
        pass
    if is_1m(state) or used > SMALL_WINDOW:
        return LARGE_WINDOW
    return SMALL_WINDOW


def handoff_dir(root):
    return os.path.join(root, ".handoffs")


PLACEHOLDER = "<!-- desk handoff placeholder"


def next_handoff(root, session):
    """Reserve the first free <day>[-n].md by creating it, holding a one-line placeholder, so a
    second session's search skips it."""
    day = time.strftime("%Y-%m-%d")
    os.makedirs(handoff_dir(root), exist_ok=True)
    n = 1
    while True:
        name = day + ".md" if n == 1 else f"{day}-{n}.md"
        path = os.path.join(handoff_dir(root), name)
        try:
            with open(path, "x") as f:
                f.write(f"{PLACEHOLDER}: reserved by session {session}, not written yet -->\n")
            return path
        except FileExistsError:
            n += 1


def is_placeholder(path):
    try:
        with open(path) as f:
            return f.read(len(PLACEHOLDER)) == PLACEHOLDER
    except Exception:
        return False


def claude_pid():
    """The Claude process this hook runs under, which outlives /clear's new session id: the hook's
    parent, or the parent's parent when that is the shell running the hook command.
    DESK_HANDOFF_PID stands in for it."""
    if os.environ.get("DESK_HANDOFF_PID"):
        return os.environ["DESK_HANDOFF_PID"]
    pid = os.getppid()
    try:
        out = subprocess.run(["ps", "-o", "ppid=,comm=", "-p", str(pid)], capture_output=True,
                             text=True, timeout=5).stdout.split(None, 1)
        if len(out) == 2 and os.path.basename(out[1].strip()).lstrip("-") in (
                "sh", "bash", "dash", "zsh"):
            pid = int(out[0])
    except Exception:
        pass
    return str(pid)


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
    """Written handoff files, newest first; a placeholder never filled is not one."""
    files = [f for f in glob.glob(os.path.join(handoff_dir(root), "*.md")) if not is_placeholder(f)]
    return sorted(files, key=os.path.getmtime, reverse=True)


def inject(event, text):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}))


def session_threshold(state, root):
    """The thresholds, looked up once per session and repo (three node calls), then cached."""
    if state.get("root") != root or "pct" not in state or "pct_1m" not in state:
        state["root"] = root
        state["pct"], state["pct_1m"] = threshold(root)
    return state["pct"], state["pct_1m"]


def on_context(event, data, session, root):
    state = load_state(session)
    if state.get("fired_at"):
        return
    pct, pct_1m = session_threshold(state, root)
    if not pct and not pct_1m:
        save_state(session, state)
        return
    used = context_used(data.get("transcript_path") or "")
    if used is None:
        save_state(session, state)
        return
    w = window(state, used)
    if w >= LARGE_WINDOW:
        pct = pct_1m
    if not pct:
        save_state(session, state)
        return
    now = used * 100.0 / w
    if now < pct:
        save_state(session, state)
        return
    exclude_handoffs(root)
    path = next_handoff(root, session)
    state.update(fired_at=time.time(), handoff=path, blocked=False, pid=claude_pid())
    save_state(session, state)
    rel = os.path.relpath(path, root)
    inject(event, (
        f"desk handoff: context is at {now:.0f}% of a {w:,}-token window (threshold {pct:g}%). "
        "Finish the step you are on, then write the handoff and start no new work. "
        f"Write it to {path} (repo-relative: {rel}), which holds a one-line placeholder reserving "
        "the name for this session: read it, then replace it whole. Follow ~/.claude/rules/handoffs.md where it "
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
    own = state.get("handoff")
    if own:
        if os.path.exists(own) and not is_placeholder(own):
            return
    elif any(os.path.getmtime(f) >= fired - 1 for f in handoffs(root)):
        return
    state["blocked"] = True
    save_state(session, state)
    path = state.get("handoff") or handoff_dir(root)
    print(json.dumps({"decision": "block", "reason": (
        f"desk handoff: write the handoff first. Context passed the threshold; write {path} "
        "(where things stand, the task in progress and its next step, decisions made, open "
        "questions, the paste-in line), then end the turn and tell the user to type /clear.")}))


def recorded_handoff(state, session, root, source):
    """The handoff this session was told to write before its context emptied: from its own state, or
    after /clear, which mints a new session id, the newest one recorded under the same Claude process.
    Taking one once it is written unlinks it from the process, so a later /clear without a new firing
    falls back to the newest written handoff."""
    if state.get("handoff"):
        return state["handoff"]
    if source != "clear":
        return None
    pid, best = claude_pid(), None
    for p in glob.glob(os.path.join(STATE_DIR, "*.json")):
        if p == state_path(session):
            continue
        try:
            with open(p) as f:
                s = json.load(f)
            fired = float(s.get("fired_at") or 0)
        except Exception:
            continue
        if (isinstance(s, dict) and s.get("pid") == pid and s.get("root") == root
                and s.get("handoff") and time.time() - fired <= FRESH_SECONDS
                and (best is None or fired > best[0])):
            best = (fired, s["handoff"], p, s)
    if not best:
        return None
    _, path, p, s = best
    if os.path.exists(path) and not is_placeholder(path):
        s.pop("pid", None)
        try:
            with open(p + ".tmp", "w") as f:
                json.dump(s, f)
            os.replace(p + ".tmp", p)
        except Exception:
            pass
    return path


def on_session_start(data, session, root):
    state = load_state(session)
    if data.get("model"):
        m = data["model"]
        state["model"] = m.get("id") if isinstance(m, dict) else str(m)
    source = data.get("source")
    recorded = None
    if source in ("clear", "compact"):
        recorded = recorded_handoff(state, session, root, source)
        # The context just emptied, so the next threshold crossing is a new one.
        for k in ("fired_at", "blocked", "handoff"):
            state.pop(k, None)
    pct, pct_1m = session_threshold(state, root)
    save_state(session, state)
    if source not in ("clear", "compact") or not (pct or pct_1m):
        return
    if recorded:
        if not os.path.exists(recorded) or is_placeholder(recorded):
            return
        latest = recorded
    else:
        files = handoffs(root)
        if not files:
            return
        latest = files[0]
    if time.time() - os.path.getmtime(latest) > FRESH_SECONDS:
        return
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


OFFER_1M = (
    "handoff at 45% of a 1M window (~450k tokens): lower §2 \"Handoff at context % on a "
    "1M window\" to 20 (~200k)? Replaying 71 orchestrator sessions, a fresh start at 200k saved 53% "
    "of re-read tokens, against 10% at 450k")


def offer_1m(args):
    """`desk-handoff.py offer-1m [<dir>]`: print desk-update's SETTING text and exit 0 when the repo's
    1M threshold is 45 (its row at 45, or unset under a 45 row) and it has not been offered before;
    else exit 1. `offer-1m --asked [<dir>]` records that it was offered, whatever the answer."""
    asked = "--asked" in args
    rest = [a for a in args if a != "--asked"]
    root = git(rest[0] if rest else os.getcwd(), "rev-parse", "--show-toplevel")
    if not root:
        return 1
    rc, out = desk_env(root, "where")
    slug = next((line.split("=", 1)[1].strip("'") for line in out.splitlines()
                 if line.startswith("SLUG=")), "")
    if rc != 0 or "EXISTS=yes" not in out or not slug:
        return 1
    marker = os.path.join(STATE_DIR, "offered-1m-" + "".join(
        c for c in slug if c.isalnum() or c in "-_.") + ".json")
    if asked:
        os.makedirs(STATE_DIR, exist_ok=True)
        with open(marker, "w") as f:
            json.dump({"at": time.time()}, f)
        return 0
    if os.path.exists(marker) or threshold(root)[1] != 45:
        return 1
    print(OFFER_1M)
    return 0


def main():
    if sys.argv[1:2] == ["offer-1m"]:
        try:
            sys.exit(offer_1m(sys.argv[2:]))
        except Exception:
            sys.exit(1)
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
