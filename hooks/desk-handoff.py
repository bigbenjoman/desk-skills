#!/usr/bin/env python3
"""Context handoff hook: keep a desk session's carry-over in .handoffs/ and resume from it.

One script, registered by install.sh on five events; it reads `hook_event_name` from its input.

  UserPromptSubmit, PostToolUse  Once the session's input-side context passes config §2 "Handoff at
                                 context %" (default 45, `0` disables), or on a 1M window §2
                                 "Handoff at context % on a 1M window" (unset, the first row's value;
                                 `0` disables), inject once: finish the current
                                 step, write the handoff, start no new work. It also asks for a
                                 `Session name:` line: the name /rename gave (the transcript's last
                                 `custom-title`), else the session's role name to give it.
  Stop                           After that has fired, and while the handoff it named is unwritten
                                 (or, kept from before a compaction, not rewritten since), block the
                                 end of the turn once ("write the handoff first").
  SessionStart                   source `clear` or `compact`: inject "read .handoffs/<name>.md and
                                 continue from its next step" for the handoff this session was told
                                 to write (else, on `clear` with none recorded, the newest written
                                 one, skipping any a compacting session holds) when that file is
                                 written, under 24 hours old and not yet consumed. A `clear` then
                                 marks it consumed; a `compact` holds it instead (.held), so
                                 the session's own later /clear still finds it and no other
                                 session's /clear takes it. On `clear`, a `Session name:` line in
                                 the handoff becomes a `/rename <name>` line to print first, since
                                 /clear drops the name. Any source also records the session's
                                 model, which says whether the window is 1M.
  Stop, UserPromptSubmit,        For a batch whose /loop this session runs, where the step above did
  PostToolUse                    not act: at a turn's end, block it once per pass while the batch has
                                 work a pass could move and no next pass recorded still to come
                                 ("schedule the next tick first"); as the session works, once the
                                 loop reads lost (twice its interval with no pass, or sooner where
                                 needs-you would show it stalled), inject once per pass "re-arm the
                                 loop now", logged for needs-you (desk/bin/loop-tick.mjs decides both).
  PreCompact                     In compaction mode, where this session's handoff is written (and
                                 rewritten since it last fired): print
                                 it as an instruction for the compaction summary (its path, and that
                                 its next step is what to carry on with).

Compaction mode: with CLAUDE_AUTOCOMPACT_PCT_OVERRIDE set (1-100), Claude Code compacts this session
on its own and carries on, so nobody is asked to /clear. Past the threshold the session is told to
write its handoff, or refresh the one it wrote before an earlier compaction, and keep working; the
compaction then reads it back. The handoff is held (.held) from when it is named, so no other
session's /clear takes it while that Claude process runs, and one not rewritten since it was last
asked for is not handed over. Set the §2 handoff % below the override, so the handoff is written
before the compaction that needs it; install.sh offers to set the override. Without it, the handoff
asks for /clear as before.

Naming a handoff creates it, holding a one-line placeholder, so two sessions in one repo are never
given the same name; a placeholder is not a written handoff.

A desk session is one whose repo has a desk config (`desk-env where` says EXISTS=yes); anywhere else
the hook is silent. Context used is the last main-chain assistant entry's usage in the transcript
since its last compaction (input + cache creation + cache read tokens), divided by the window: DESK_CONTEXT_WINDOW if set,
else 1,000,000 for a model whose default window is 1M (DEFAULT_1M_SINCE, unless
CLAUDE_CODE_DISABLE_1M_CONTEXT is set) or a `[1m]` model (SessionStart's model id, or ANTHROPIC_MODEL or settings.json's
`model` for the same family, since that id drops the suffix; or once usage has passed 200,000,
which no smaller window allows), else 200,000. Handoffs are <repo root>/.handoffs/<yyyy-mm-dd>[-n].md, and .handoffs/ is
added to .git/info/exclude. Per-session state is ~/.claude/desk/handoff/<session id>.json, which is
also the marker that stops a second injection or a second Stop block, and records the threshold and
window the session runs under (`arm`), which handoff-report.mjs reads.

Never fails a session: any error exits 0 with no output.

Worker mode: in an autopilot worker (DESK_AUTOPILOT_WORKER=1 with DESK_HANDOFF_FILE, which
spawn-worker.sh exports and worker-settings.mjs registers this hook for, on PostToolUse, Stop and
SessionStart), the threshold is the ticket's raised one (DESK_HANDOFF_PCT, which pass.mjs sets once
two sessions in a row handed off without moving a stage or adding a commit), else the
handoff-threshold lever's value from the worker's pin (DESK_LEVER_VALUES `handoff-threshold=<pct>`),
each on both windows, else the §2 rows as above. The state stamps the context at the session's first
check (`start`: used, window, time and root), which `desk-env drift` reads as start-up use. Past the
threshold, once the context has also grown by MIN_GROWTH tokens since that first check (or the last
compaction; DESK_HANDOFF_MIN_GROWTH overrides it), and partway through a stage a session can start at
(the last `AUTOPILOT_STAGE:` line the worker printed names Stage 3 or later, else, before it prints
one, the stage a fresh session was started at, DESK_START_STAGE), inject once: commit, write the handoff briefing with `handoff.mjs write
--stage <stage> --left …`, print `AUTOPILOT_HANDOFF: <stage>` and end the turn; pass.mjs then starts
a fresh worker at that stage from the briefing. Stop blocks once while DESK_HANDOFF_FILE is unwritten
since. No .handoffs/ file is named and the loop step never runs; SessionStart records the model and,
on a compaction, makes the next crossing a new one.

Any other worker (a fix or base try: AUTOPILOT_TASK, or no DESK_HANDOFF_FILE) never hands off, and
the hook is silent in it.

Run as `desk-handoff.py offer-1m [--asked] [<dir>]` (not a hook event), it is /desk-update's one-time
offer to lower a 1M threshold of 45 to 20: see offer_1m. Run as `desk-handoff.py pick [<dir>]`, it is
/desk-resume's choice in a session started fresh, which SessionStart names no handoff for: see pick.
"""
import calendar
import glob
import json
import os
import re
import subprocess
import sys
import time

DEFAULT_PCT = 45
MIN_GROWTH = 30_000  # tokens a worker session gains before it may hand off (DESK_HANDOFF_MIN_GROWTH)
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


def transcript_lines(transcript, limit=TAIL_LIMIT):
    """The transcript's last `limit` bytes as lines (the whole file when limit is None), dropping a
    first line the cut may have split. Raises when the file cannot be read."""
    with open(transcript, "rb") as f:
        f.seek(0, os.SEEK_END)
        start = 0 if limit is None else max(0, f.tell() - limit)
        f.seek(start)
        lines = f.read().split(b"\n")
    return lines[1:] if start > 0 else lines


def context_used(transcript):
    """Input-side tokens of the last main-chain assistant entry since the last compaction, or None.

    A compaction keeps the transcript file and writes a `compact_boundary` entry; usage from before
    it describes the context that was just summarised away, so the scan stops there."""
    try:
        lines = transcript_lines(transcript)
    except Exception:
        return None
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


def load_default_1m_since():
    """The oldest version of each family whose default window is 1M, with no [1m]: desk's
    bin/model-windows.json, which handoff-report.mjs reads too. Unreadable, no model is 1M by default."""
    try:
        with open(os.path.join(DESK_HOME, "bin", "model-windows.json")) as f:
            return {k: tuple(v) for k, v in json.load(f)["default_1m_since"].items()}
    except Exception:
        return {}


DEFAULT_1M_SINCE = load_default_1m_since()


def version(model):
    """(5, 5) for `claude-opus-5-5`, (4, 5) for `claude-haiku-4-5-20251001`; None for an alias."""
    nums = [int(p) for p in model.lower().replace("[1m]", "").split("-") if p.isdigit() and len(p) <= 2]
    return tuple((nums + [0])[:2]) if nums else None


def default_1m(model):
    """Whether the model runs on a 1M window with no [1m]."""
    since, v = DEFAULT_1M_SINCE.get(family(model)), version(model)
    return since is not None and v is not None and v >= since


def is_1m(state):
    """Whether the session runs on a 1M window: a model that is 1M by default, or one with `[1m]`.
    SessionStart's model id carries no `[1m]` even on a 1M session, so a `[1m]` the user chose counts
    too, for the same model family. CLAUDE_CODE_DISABLE_1M_CONTEXT removes the [1m] variants and holds
    every model to 200k."""
    if os.environ.get("CLAUDE_CODE_DISABLE_1M_CONTEXT"):
        return False
    model = str(state.get("model") or "")
    if "[1m]" in model.lower() or default_1m(model):
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


def process_start(pid):
    """When a process started, as a value fixed for its life, so a pid the OS has given to a new
    process is not taken for the one that held a handoff: on Linux the start in clock ticks since
    boot (/proc/<pid>/stat field 22, which no clock step, TZ or locale moves); elsewhere
    `ps -o lstart` read in UTC and the C locale. "" when it cannot be read."""
    try:
        pid = int(pid)
        try:
            with open(f"/proc/{pid}/stat") as f:
                return "t" + f.read().rsplit(")", 1)[1].split()[19]
        except FileNotFoundError:
            if os.path.isdir("/proc/self"):
                return ""  # Linux, and the process has gone
        out = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True,
                             timeout=5, env={**os.environ, "LC_ALL": "C", "TZ": "UTC0"}).stdout
        return "".join(out.split())
    except Exception:
        return ""


def process_alive(pid, start=None):
    """Whether the Claude process a hold names still runs: its pid is live (another user's process
    included) and, where the hold recorded one, started when it did. A pid that is not a number (the
    test stand-in, DESK_HANDOFF_PID) or a line with none counts as running."""
    try:
        os.kill(int(pid), 0)
    except (TypeError, ValueError):
        return True
    except PermissionError:
        pass  # the process exists, under another user: its start time still says whether it is ours
    except OSError:
        return False
    if not start:
        return True
    now = process_start(pid)
    return not now or now == start


def held_names(root):
    """Handoffs a compacting session holds (.handoffs/.held, one `<name> <pid> [<start>]` a line): no
    other session's /clear takes them while the Claude process holding them runs."""
    try:
        lines = open(os.path.join(handoff_dir(root), ".held")).read().splitlines()
    except Exception:
        return []
    parts = [line.split() for line in lines]
    return [p[0] for p in parts
            if p and process_alive(p[1] if len(p) > 1 else None, p[2] if len(p) > 2 else None)]


def hold(root, path):
    name = os.path.basename(path)
    if name not in held_names(root):
        pid = claude_pid()
        with open(os.path.join(handoff_dir(root), ".held"), "a") as f:
            f.write(f"{name} {pid} {process_start(pid)}".rstrip() + "\n")


def compaction_mode():
    """Whether Claude Code compacts this session on its own: CLAUDE_AUTOCOMPACT_PCT_OVERRIDE holds a
    percentage from 1 to 100."""
    try:
        return 1 <= float(os.environ.get("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "")) <= 100
    except ValueError:
        return False


def inject(event, text):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}))


def session_threshold(state, root):
    """The thresholds, looked up once per session and repo (three node calls), then cached."""
    if state.get("root") != root or "pct" not in state or "pct_1m" not in state:
        state["root"] = root
        state["pct"], state["pct_1m"] = threshold(root)
    return state["pct"], state["pct_1m"]


def session_name(transcript):
    """The name the person gave this session with /rename (its last `custom-title` entry), or None.

    Claude Code re-appends the entry as the session goes on, so the tail usually holds it; the
    whole file is read only when the tail does not."""
    for limit in (TAIL_LIMIT, None):
        try:
            lines = transcript_lines(transcript, limit)
        except Exception:
            return None
        for raw in reversed(lines):
            if b'"custom-title"' not in raw:
                continue
            try:
                e = json.loads(raw)
            except Exception:
                continue
            name = e.get("customTitle") if e.get("type") == "custom-title" else None
            if isinstance(name, str) and name.strip():
                return name.strip()
        if os.path.getsize(transcript) <= TAIL_LIMIT:
            break  # the tail was the whole file
    return None


def repo_name(root):
    """The repo's name for role names: §0 GitHub repo's name part, else the root's directory."""
    rc, out = desk_env(root, "where")
    for line in out.splitlines() if rc == 0 else []:
        if line.startswith("GH_REPO="):
            name = line.split("=", 1)[1].strip().strip("'\"").rsplit("/", 1)[-1]
            if name:
                return name
    return os.path.basename(root)


def name_line(transcript, root):
    """What the handoff says about the session's name, so the resumed session can be given it back."""
    name = session_name(transcript)
    if name:
        return (f"Put a line `Session name: {name}` at the top of the handoff: /clear drops the name, "
                "and /desk-resume prints the /rename line that gives it back. ")
    repo = repo_name(root)
    return ("This session has no name. Put a line `Session name: <name>` at the top of the handoff, "
            f"with its role's name: `{repo}-batch` for a batch, `{repo}-ticket-<KEY>` for one "
            f"ticket, `{repo}-orchestrator` for an orchestrator. ")


NAME_PREFIX = "session name:"
PLACEHOLDER_SLOT = re.compile(r"<[A-Za-z][\w-]*>")


def handoff_name(path):
    """The name a handoff's `Session name:` line records, or None."""
    try:
        with open(path) as f:
            for _, line in zip(range(40), f):
                text = line.strip().lstrip("-*# ")  # a list item, heading or **bold** label
                if text.lower().startswith(NAME_PREFIX):
                    name = text[len(NAME_PREFIX):].lstrip("* ").rstrip()
                    if name.startswith("`") and name.count("`") >= 2:
                        name = name[1:name.index("`", 1)]
                    else:
                        name = name.rstrip("*").strip().strip("'\"")  # **Session name: x**, "x"
                    name = name.strip()
                    # A name still holding a <repo> or <KEY> slot is the role-name pattern, unfilled.
                    if name and not PLACEHOLDER_SLOT.search(name):
                        return name
    except Exception:
        pass
    return None


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
    state["arm"] = {"pct": pct, "window": w}
    now = used * 100.0 / w
    if now < pct:
        save_state(session, state)
        return
    exclude_handoffs(root)
    compacts = compaction_mode()
    # A session that compacts keeps one handoff, refreshed before each compaction.
    kept = state.get("kept") if compacts else None
    path = kept if kept and os.path.exists(kept) else next_handoff(root, session)
    state.update(fired_at=time.time(), handoff=path, blocked=False, pid=claude_pid())
    save_state(session, state)
    if compacts:
        hold(root, path)  # from now on, not only after its first compaction
    rel = os.path.relpath(path, root)
    where = f"{path} (repo-relative: {rel})"
    if is_placeholder(path):
        where += ", which holds a one-line placeholder reserving the name for this session"
    if compacts:
        verb = "write" if is_placeholder(path) else "refresh"
        lead = ("This session compacts on its own (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE), so nobody needs "
                f"to /clear. Once the step you are on is done, {verb} the handoff at {where}")
        tail = ("Then carry on with the work: after the compaction this session is told to read the "
                "handoff and continue from its next step. Do not ask the user to type /clear.")
    else:
        lead = ("Finish the step you are on, then write the handoff and start no new work. "
                f"Write it to {where}")
        tail = ("Then tell the user to type /clear, then /desk-resume: the cleared session reads the "
                "handoff and /desk-resume carries on from its next step.")
    inject(event, (
        f"desk handoff: context is at {now:.0f}% of a {w:,}-token window (threshold {pct:g}%). "
        f"{lead}: read it, then replace it whole. Follow ~/.claude/rules/handoffs.md where it "
        "exists, with these sections: where things stand; the task in progress and its next step; "
        "decisions made; open questions; and last, the paste-in line "
        f"(`Read {rel} and continue from its next step.`). "
        f"{name_line(data.get('transcript_path') or '', root)}"
        "Record each action it leaves for the person (file this, merge that, run this) with "
        "`node ~/.claude/desk/bin/needs-you.mjs ask <SLUG from desk-env where> \"<what to do>\"`, "
        f"so desk-q lists it. {tail}"))
    return True


# ---- worker mode ---------------------------------------------------------------------------------
# The stages a fresh worker can start at (config-schema.mjs RESUME_STAGES), and a worker's stage line.
RESUME_STAGES = ("3", "4", "4b", "5", "6", "7", "8", "9")
# Read as desk/bin/harvest.mjs reads them: a text line, its decoration allowed, or a Bash command that
# starts by echoing the stage.
STAGE_LINE = re.compile(r"^[\s`>*#-]*AUTOPILOT_STAGE:[ \t]*(4b|\d)(?:/9)?\b", re.I | re.M)
ECHO_STAGE = re.compile(r"""^\s*echo\s+(["'])AUTOPILOT_STAGE:[ \t]*(4b|\d)(?:/9)?\b""", re.I)


def worker_file():
    """An autopilot worker's handoff briefing path (DESK_HANDOFF_FILE), or None in any other session."""
    if os.environ.get("DESK_AUTOPILOT_WORKER") != "1" or os.environ.get("AUTOPILOT_TASK"):
        return None
    return os.environ.get("DESK_HANDOFF_FILE") or None


def lever_value():
    """The handoff-threshold lever's value in the worker's pin (DESK_LEVER_VALUES), or `config`."""
    for word in os.environ.get("DESK_LEVER_VALUES", "").split():
        k, _, v = word.partition("=")
        if k == "handoff-threshold" and v:
            return v
    return "config"


def as_pct(value):
    """A percentage from 0 to 100 (both excluded), or None."""
    try:
        pct = float(value)
    except (TypeError, ValueError):
        return None
    return pct if 0 < pct < 100 else None


def lever_pct():
    """The lever's value as a percentage, or None for `config` or a value that is not one."""
    return as_pct(lever_value())


def raised_pct():
    """The ticket's raised threshold (DESK_HANDOFF_PCT, which pass.mjs sets once its sessions hand off
    without moving a stage), or None."""
    return as_pct(os.environ.get("DESK_HANDOFF_PCT"))


def min_growth():
    """Tokens the context must gain since the session started (or last compacted) before it hands off."""
    try:
        return max(0, int(os.environ.get("DESK_HANDOFF_MIN_GROWTH", MIN_GROWTH)))
    except ValueError:
        return MIN_GROWTH


def current_stage(transcript):
    """The stage the worker's last `AUTOPILOT_STAGE:` line names ("4", "4b"), or None.

    The tail usually holds it; the whole file is read only when the tail does not, so a None means
    the worker has printed no stage line at all."""
    for limit in (TAIL_LIMIT, None):
        try:
            lines = transcript_lines(transcript, limit)
        except Exception:
            return None
        for raw in reversed(lines):
            if b"AUTOPILOT_STAGE" not in raw:
                continue
            try:
                e = json.loads(raw)
            except Exception:
                continue
            if e.get("type") != "assistant" or e.get("isSidechain"):
                continue
            for c in reversed((e.get("message") or {}).get("content") or []):
                if not isinstance(c, dict):
                    continue
                if c.get("type") == "text":
                    found = STAGE_LINE.findall(c.get("text") or "")
                    if found:
                        return found[-1].lower()
                elif c.get("type") == "tool_use" and c.get("name") == "Bash":
                    m = ECHO_STAGE.match(str((c.get("input") or {}).get("command") or ""))
                    if m:
                        return m.group(2).lower()
        if os.path.getsize(transcript) <= TAIL_LIMIT:
            break  # the tail was the whole file
    return None


def worker_stage(transcript):
    """The stage the worker is in: its last stage line, else the stage spawn-worker.sh started this
    session at (DESK_START_STAGE, from AUTOPILOT_START_STAGE). A fresh session after a handoff or a
    park starts partway through a stage and may print no stage line until the next one; without
    this it could never hand off before then."""
    stage = current_stage(transcript)
    if stage:
        return stage
    start = (os.environ.get("DESK_START_STAGE") or "").strip().lower()
    return start if start in RESUME_STAGES else None


def on_worker_context(event, data, session, root, path):
    state = load_state(session)
    if state.get("fired_at"):
        return
    raised, pin = raised_pct(), lever_pct()
    pct, pct_1m = (raised, raised) if raised else (pin, pin) if pin else session_threshold(state, root)
    transcript = data.get("transcript_path") or ""
    used = context_used(transcript)
    if used is None:
        save_state(session, state)
        return
    w = window(state, used)
    # The context at the session's first check: its start-up use, which `desk-env drift` reads.
    state.setdefault("start", {"used": used, "window": w, "at": time.time(), "root": root})
    state.setdefault("base_used", used)
    if w >= LARGE_WINDOW:
        pct = pct_1m
    if pct:
        state["arm"] = {"pct": pct, "window": w}
    now = used * 100.0 / w
    grown = used - state["base_used"] >= min_growth()
    stage = worker_stage(transcript) if pct and now >= pct and grown else None
    # Before Stage 3 no fresh session can start where this one is: it carries on, checked again later.
    if stage not in RESUME_STAGES:
        save_state(session, state)
        return
    state.update(fired_at=time.time(), stage=stage, worker_file=path)
    save_state(session, state)
    key = os.path.splitext(os.path.basename(path))[0]
    value = lever_value()
    source = ("raised for this ticket, DESK_HANDOFF_PCT" if raised else
              f"handoff-threshold {value}" if pin else
              "config §2 Handoff at context %" + (" on a 1M window" if w >= LARGE_WINDOW else ""))
    inject(event, (
        f"desk handoff: context is at {now:.0f}% of a {w:,}-token window, past this worker's "
        f"threshold of {pct:g}% ({source}), partway through Stage {stage}. Finish the tool step "
        "you are on and start nothing new. Then hand off to a fresh session at the same stage: "
        "1. commit what you have on your branch (work in progress is fine; do not push), so "
        "git status --porcelain is clean. 2. Update your resume file ($DESK_STATE/resume/"
        f"{key}.json). 3. Write the briefing in one line, one flag per item: "
        f"`~/.claude/desk/bin/handoff.mjs write {key} --stage {stage} --context {now:.0f} "
        "--left '<each piece of this stage still to do, and the next step>' --lane '<lane>' "
        "--criterion '<each acceptance criterion, verbatim>' --verification '<each check run so "
        "far: command, scope, result>'` (add --review and --evidence as the Stage 4 file's "
        "Handing off says, when there are any). 4. Print "
        f"`AUTOPILOT_HANDOFF: {stage}` at the start of a line in your reply text, not in a code "
        "fence, and end your turn. Print no AUTOPILOT_DONE."))
    return True


def on_worker_stop(data, session, path):
    if data.get("stop_hook_active"):
        return
    state = load_state(session)
    fired = state.get("fired_at")
    if not fired or state.get("blocked"):
        return
    if os.path.exists(path) and os.path.getmtime(path) >= fired - 1:
        return
    state["blocked"] = True
    save_state(session, state)
    stage = state.get("stage") or "<stage>"
    print(json.dumps({"decision": "block", "reason": (
        f"desk handoff: write the handoff briefing first. Context passed the threshold partway "
        f"through Stage {stage}: commit, run handoff.mjs write with --stage {stage} and --left, "
        f"then print AUTOPILOT_HANDOFF: {stage} and end the turn.")}))


def on_worker_session_start(data, session):
    state = load_state(session)
    if data.get("model"):
        m = data["model"]
        state["model"] = m.get("id") if isinstance(m, dict) else str(m)
    if data.get("source") == "compact":
        for k in ("fired_at", "blocked", "stage", "base_used"):
            state.pop(k, None)
    save_state(session, state)


def on_stop(data, session, root):
    if data.get("stop_hook_active"):
        return False
    state = load_state(session)
    fired = state.get("fired_at")
    if not fired or state.get("blocked"):
        return False
    own = state.get("handoff")
    if own:
        # Written since this firing: a handoff kept from before a compaction must be refreshed.
        if os.path.exists(own) and not is_placeholder(own) and os.path.getmtime(own) >= fired - 1:
            return
    elif any(os.path.getmtime(f) >= fired - 1 for f in handoffs(root)):
        return
    state["blocked"] = True
    save_state(session, state)
    path = state.get("handoff") or handoff_dir(root)
    then = (". This session compacts on its own: do not ask the user to /clear." if compaction_mode()
            else ", then end the turn and tell the user to type /clear, then /desk-resume.")
    print(json.dumps({"decision": "block", "reason": (
        f"desk handoff: write the handoff first. Context passed the threshold; write {path} "
        "(where things stand, the task in progress and its next step, decisions made, open "
        f"questions, the paste-in line){then}")}))
    return True


# A batch this session runs through /loop (loop-tick.mjs decides): the Stop step blocks a turn's end
# once per pass while no next pass is recorded still to come, and the turn steps (UserPromptSubmit,
# PostToolUse) inject a re-arm once per pass once the loop reads lost. Heartbeats are read here first,
# so node runs only for a beat whose loop is this session's with no next pass to come; a check that
# finds nothing to say is not asked again until its batch's queue changes or the time it gave.


def session_slug(state, root):
    if state.get("slug_root") != root:
        rc, out = desk_env(root, "where")
        state["slug_root"] = root
        state["slug"] = next((line.split("=", 1)[1].strip().strip("'\"") for line in out.splitlines()
                              if line.startswith("SLUG=")), "") if rc == 0 and "EXISTS=yes" in out else ""
    return state["slug"]


def own_beats(slug, session):
    """(pass, next, queue) of each queue's newest heartbeat whose loop is this session's (the session
    that recorded its next pass, else the one its last pass ran in), in the repo's standing batch and
    its named ones: times in seconds, next None when unrecorded."""
    base = os.path.join(HOME, ".desk-autopilot", slug)
    newest = {}
    for path in (glob.glob(os.path.join(base, "orchestrators", "*.json"))
                 + glob.glob(os.path.join(base, "batches", "*", "orchestrators", "*.json"))):
        try:
            with open(path) as f:
                hb = json.load(f)
            at = parse_iso(hb["at"])
        except Exception:
            continue
        k = (os.path.dirname(path), hb.get("queue"))
        if k not in newest or at > newest[k][0]:
            newest[k] = (at, hb)
    out = []
    for _, hb in newest.values():
        if (hb.get("loop") or hb.get("session")) != session:
            continue
        p = parse_iso(hb["pass"] if "pass" in hb else hb.get("at"))
        # The loop's tick: its next pass, else the one a pass run by hand carried (borrow.mjs loopTick).
        due = hb.get("next") or hb.get("tick")
        n = parse_iso(due) if due else None
        if p is not None:
            out.append((p, n, str(hb.get("queue") or "")))
    return out


def parse_iso(s):
    try:
        return float(calendar.timegm(time.strptime(str(s)[:19], "%Y-%m-%dT%H:%M:%S")))
    except Exception:
        return None


def loop_due(slug, session):
    """(key, stamp) for the passes with no next pass still to come: the key names the passes, the
    stamp their queues' modification times and their recorded next passes, so a next pass recorded
    after a cached check (which sets the loop's interval) is checked afresh. ("", "") when none is."""
    now, keys, stamps = time.time(), [], []
    for p, n, queue in own_beats(slug, session):
        if n is not None and n > now:
            continue
        keys.append(f"{p:.0f}")
        nxt = "-" if n is None else f"{n:.0f}"
        try:
            stamps.append(f"{os.path.getmtime(queue):.3f}/{nxt}")
        except OSError:
            stamps.append(f"-/{nxt}")
    return " ".join(sorted(keys)), " ".join(sorted(stamps))


def loop_tick(root, session, mode):
    """loop-tick.mjs check's {text} or {recheck}, or None."""
    script = os.path.join(DESK_HOME, "bin", "loop-tick.mjs")
    try:
        p = subprocess.run(["node", script, "check", session, mode], capture_output=True, text=True,
                           timeout=10, cwd=root, env=dict(os.environ, DESK_REPO_DIR=root))
        return json.loads(p.stdout) if p.returncode == 0 and p.stdout.strip() else None
    except Exception:
        return None


def on_loop(event, data, session, root):
    # A Stop with stop_hook_active still runs: the handoff's block may have taken this turn's first
    # Stop, and the once-per-pass mark below keeps this block to one.
    stop = event == "Stop"
    state = load_state(session)
    slug = session_slug(state, root)
    mark = "loop_stop" if stop else "loop_turn"
    key, stamp = loop_due(slug, session) if slug else ("", "")
    idle = state.get(mark + "_idle") or [None, None, None]
    if (not key or state.get(mark) == key
            or (idle[:2] == [key, stamp] and (idle[2] is None or time.time() * 1000 < idle[2]))):
        save_state(session, state)
        return
    out = loop_tick(root, session, "stop" if stop else "turn")
    if not out:  # the check failed: ask again on the next event
        save_state(session, state)
        return
    if not out.get("text"):
        state[mark + "_idle"] = [key, stamp, out.get("recheck")]
        save_state(session, state)
        return
    state[mark] = key  # acted on once per pass
    save_state(session, state)
    if stop:
        print(json.dumps({"decision": "block", "reason": out["text"]}))
    else:
        inject(event, out["text"])


def recorded_handoff(state, session, root, source):
    """The handoff this session was told to write before its context emptied: from its own state, or
    after /clear, which mints a new session id, the newest one recorded under the same Claude process.
    Taking one once it is written unlinks it from the process, so a later /clear without a new firing
    falls back to the newest written handoff."""
    if state.get("handoff"):
        return state["handoff"]
    if source != "clear":
        return state.get("kept")
    pid, best = claude_pid(), None
    for p in glob.glob(os.path.join(STATE_DIR, "*.json")):
        if p == state_path(session):
            continue
        try:
            with open(p) as f:
                s = json.load(f)
            # A compacted session holds its handoff as `kept` until it fires again.
            held = s.get("handoff") or s.get("kept")
            fired = float(s.get("fired_at") or s.get("kept_at") or 0)
        except Exception:
            continue
        if (isinstance(s, dict) and s.get("pid") == pid and s.get("root") == root
                and held and time.time() - fired <= FRESH_SECONDS
                and (best is None or fired > best[0])):
            best = (fired, held, p, s)
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


def on_pre_compact(session, root):
    if not compaction_mode():
        return
    state = load_state(session)
    path = state.get("handoff") or state.get("kept")
    if not path or not os.path.exists(path) or is_placeholder(path):
        return
    if os.path.getmtime(path) < float(state.get("fired_at") or state.get("kept_at") or 0) - 1:
        return  # not rewritten since it last fired, or since the compaction that kept it: stale
    # Stdout on a PreCompact hook is instructions for the compaction summary.
    print(f"This session's desk handoff is {path}. Name that file in the summary, and say the work "
          "carries on from its next step.")


def on_session_start(data, session, root):
    state = load_state(session)
    if data.get("model"):
        m = data["model"]
        state["model"] = m.get("id") if isinstance(m, dict) else str(m)
    source = data.get("source")
    recorded = None
    # When the handoff was last asked for: the last firing, else the compaction that kept it.
    fired = float(state.get("fired_at") or state.get("kept_at") or 0)
    if source in ("clear", "compact"):
        recorded = recorded_handoff(state, session, root, source)
        # The context just emptied, so the next threshold crossing is a new one. A compacted session
        # keeps its handoff, to refresh before its next compaction.
        for k in ("fired_at", "blocked", "handoff"):
            state.pop(k, None)
        if source == "compact" and recorded:
            state.update(kept=recorded, kept_at=time.time())
    pct, pct_1m = session_threshold(state, root)
    # How this session began, under which Claude process: `pick` resumes nothing for a session whose
    # /clear or compaction this hook has already settled.
    state.update(start_source=source, start_pid=claude_pid(), started_at=time.time())
    save_state(session, state)
    if source not in ("clear", "compact") or not (pct or pct_1m):
        return
    if recorded:
        if not os.path.exists(recorded) or is_placeholder(recorded):
            return
        if source == "compact" and os.path.getmtime(recorded) < fired - 1:
            return  # not rewritten since it was last asked for: its next step is stale
        latest = recorded
    elif source == "compact":
        # A compaction carries on this session, so only its own handoff belongs in it.
        return
    else:
        # Another session's /clear never takes a handoff a compacting session still holds.
        held = held_names(root)
        files = [f for f in handoffs(root) if os.path.basename(f) not in held]
        if not files:
            return
        latest = files[0]
    if time.time() - os.path.getmtime(latest) > FRESH_SECONDS:
        return
    name = os.path.basename(latest)
    if name in consumed_names(root):
        return
    # A compaction carries on the session that wrote it, which holds the handoff; only a /clear
    # carries it out.
    if source == "clear":
        consume(root, name)
    else:
        hold(root, latest)
    rel = os.path.relpath(latest, root)
    name = handoff_name(latest) if source == "clear" else None
    rename = (f" It names this session {name}: before anything else, print the line `/rename {name}` "
              "for the user to run, since /clear dropped the name and only the user can set it."
              if name else "")
    inject("SessionStart", (
        f"desk handoff: read {rel} (in {root}) and continue from its next step. "
        "It is the previous session's carry-over; treat its decisions as made and its open "
        f"questions as still open.{rename}"))


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


def consumed_names(root):
    try:
        return open(os.path.join(handoff_dir(root), ".consumed")).read().split()
    except Exception:
        return []


def consume(root, name):
    with open(os.path.join(handoff_dir(root), ".consumed"), "a") as f:
        f.write(name + "\n")


def started_fresh():
    """Whether this session began fresh (a new or resumed session), as SessionStart recorded it, and
    not by /clear or a compaction: SessionStart has then already chosen its handoff, or chosen none
    on purpose (its own is unwritten, stale or resumed), so no other session's is taken for it. Read
    from the session's own state (CLAUDE_CODE_SESSION_ID) and from this Claude process's newest
    session; either saying /clear or a compaction, or neither found, is not fresh."""
    sources = []
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID")
    if sid and load_state(sid).get("start_source"):
        sources.append(load_state(sid)["start_source"])
    pid, best = claude_pid(), None
    for p in glob.glob(os.path.join(STATE_DIR, "*.json")):
        try:
            with open(p) as f:
                s = json.load(f)
            at = float(s.get("started_at") or 0)
        except Exception:
            continue
        if s.get("start_pid") == pid and (best is None or at > best[0]):
            best = (at, s.get("start_source"))
    if best:
        sources.append(best[1])
    return bool(sources) and not any(s in ("clear", "compact") for s in sources)


def pick(args):
    """`desk-handoff.py pick [<dir>]`: /desk-resume in a session the hook named no handoff for
    because it started fresh rather than by /clear or a compaction. Where exactly one handoff fits
    the /clear rule (written, under 24 hours old, not consumed, not held), print its path, mark it
    consumed and exit 0; with none or several, or in a session not known to have started fresh,
    print nothing and exit 1, and the person chooses."""
    root = git(args[0] if args else os.getcwd(), "rev-parse", "--show-toplevel")
    if not root or not started_fresh():
        return 1
    skip = set(held_names(root)) | set(consumed_names(root))
    fits = [f for f in handoffs(root) if os.path.basename(f) not in skip
            and time.time() - os.path.getmtime(f) <= FRESH_SECONDS]
    if len(fits) != 1:
        return 1
    consume(root, os.path.basename(fits[0]))
    print(fits[0])
    return 0


def main():
    if sys.argv[1:2] == ["pick"]:
        try:
            sys.exit(pick(sys.argv[2:]))
        except Exception:
            sys.exit(1)
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
    worker = worker_file()
    if os.environ.get("DESK_AUTOPILOT_WORKER") == "1" and not worker:
        return  # a task worker, which never hands off: no interactive handoff either
    if worker:
        if event in ("UserPromptSubmit", "PostToolUse"):
            on_worker_context(event, data, session, root, worker)
        elif event == "Stop":
            on_worker_stop(data, session, worker)
        elif event == "SessionStart":
            on_worker_session_start(data, session)
        return
    if event in ("UserPromptSubmit", "PostToolUse"):
        if not on_context(event, data, session, root):
            on_loop(event, data, session, root)
    elif event == "Stop":
        if not on_stop(data, session, root):
            on_loop(event, data, session, root)
    elif event == "SessionStart":
        on_session_start(data, session, root)
    elif event == "PreCompact":
        on_pre_compact(session, root)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
