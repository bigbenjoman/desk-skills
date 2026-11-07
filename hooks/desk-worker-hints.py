#!/usr/bin/env python3
"""PreToolUse(Bash) hook for autopilot workers with the wrappers lever on (config §3b Phase 0 levers):
a command the worker's allow-list refuses anyway is refused naming the single command that does the
same, instead of the harness's bare "denied because Claude Code is running in don't ask mode".

    python3 desk-worker-hints.py <worker settings file>

worker-settings.mjs registers it only with the lever on, beside the settings file whose allow rules
it reads and the `.wrappers.json` sidecar it writes (the worktree, the §4 Unit tests items).

It only ever denies, and only a command the harness would refuse too: one with a step that no allow
rule matches (a prefix rule matched as a bare prefix, the widest reading) and that is not a command
the harness may allow by itself (the CAN_RUN words: cd, sed, the reading tools). Every doubt goes the
other way, so a hint is lost before a command that would have run is refused: a command it cannot
split with confidence (`$`, backticks, a heredoc, a subshell, a loop) gets no opinion, and so does a
refused command none of the hints below fits. The hints:
  - `cd <its own worktree> && ...`: the cd does nothing, so the same command without it;
  - `sed -n A,Bp <file>`: `desk-env lines <file> A,B`, one command with nothing chained;
  - one test file run directly (`node tests/test_x.mjs`, `bash tests/test_x.sh`): §4 Unit tests with
    that file, under the test lock.
"""

import json
import os
import re
import shlex
import sys

# Words the harness may allow with no rule (its own read-only checks), never treated as the refused step.
CAN_RUN = {
    "cd", "pushd", "popd", "sed", "echo", "printf", "true", "false", "pwd", "ls", "cat", "head", "tail", "grep",
    "egrep", "fgrep", "rg", "wc", "sort", "uniq", "cut", "tr", "diff", "cmp", "comm", "file", "stat", "find", "which",
    "type", "command", "date", "basename", "dirname", "realpath", "readlink", "test", "[", "od", "xxd", "hexdump",
    "jq", "nl", "column", "paste", "fold", "fmt", "rev", "tac", "seq", "expr", "whoami", "id", "uname", "hostname",
    "du", "df", "tree", "less", "more", "strings", "md5", "md5sum", "shasum", "sha1sum", "sha256sum", "cksum",
    "env", "printenv", "sleep", "time", "timeout", "nice", "nohup", "stdbuf", "xargs", "tee", "awk", "ps", "pgrep",
}
UNSPLITTABLE = re.compile(r"[$`]|<<|<\(|>\(|\(|\)|\{|\}")
LOOP_WORDS = {"for", "while", "until", "if", "case", "select", "function", "do", "then"}
ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
REDIRECT = re.compile(r"^(?:\d*>>?|&>>?|\d*<|>&|\d*>&)\S*$")
BARE_REDIRECT = re.compile(r"^(?:\d*>>?|&>>?|\d*<|\d*>&)$")
SED_RANGE = re.compile(r"^([1-9][0-9]*)(?:,([1-9][0-9]*|\$))?p$")
TEST_FILE = re.compile(r"^(?:test[_-].+|.+[._-](?:test|spec))\.(?:mjs|cjs|js|ts|sh|py)$")
SHELLS = {"node", "bash", "sh", "zsh", "python", "python3"}


def split_steps(command):
    """[(step text, separator after it)] split on && || ; | & and newlines outside quotes."""
    steps, quote, start, i, n = [], None, 0, 0, len(command)
    while i < n:
        c = command[i]
        if c == "\\" and quote != "'":
            i += 2
            continue
        if quote:
            quote = None if c == quote else quote
            i += 1
            continue
        if c in "'\"":
            quote = c
        elif command[i:i + 2] in ("&&", "||"):
            steps.append((command[start:i], command[i:i + 2]))
            start = i = i + 2
            continue
        elif c in ";|\n" or (c == "&" and command[i - 1:i] not in ("<", ">") and command[i + 1:i + 2] != ">"):
            steps.append((command[start:i], c))
            start = i + 1
        i += 1
    if quote:
        raise ValueError("unbalanced quote")
    steps.append((command[start:], ""))
    return [(s.strip(), sep) for s, sep in steps if s.strip()]


def matches(rule, cmd):
    if rule in ("Bash", "Bash(*)"):
        return True
    if not (rule.startswith("Bash(") and rule.endswith(")")):
        return False
    pat = rule[5:-1]
    if pat.endswith(":*") and "*" not in pat[:-2]:
        return cmd.startswith(pat[:-2])
    if "*" in pat:
        return re.match("^" + ".*".join(re.escape(p) for p in pat.split("*")) + "$", cmd, re.S) is not None \
            or (pat.endswith(" *") and cmd == pat[:-2])
    return cmd == pat


def spellings(tokens):
    """The step as written, and without redirections, leading assignments and wrappers."""
    plain, skip = [], False
    for t in tokens:
        if skip:
            skip = False
        elif REDIRECT.match(t):
            skip = BARE_REDIRECT.match(t) is not None  # its target is the next word
        else:
            plain.append(t)
    while plain and ASSIGN.match(plain[0]):
        plain = plain[1:]
    return [" ".join(tokens), " ".join(plain)], plain


def may_run(step, allow):
    tokens = shlex.split(step)
    texts, plain = spellings(tokens)
    if not plain or os.path.basename(plain[0]) in CAN_RUN:
        return True
    return any(matches(r, t) for r in allow for t in [step, *texts])


def own_dir(target, cwd, worktrees):
    path = os.path.realpath(os.path.join(cwd, os.path.expanduser(target)))
    return any(path == os.path.realpath(w) for w in worktrees)


def test_hint(tokens, tests, lock):
    if len(tokens) < 2 or os.path.basename(tokens[0]) not in SHELLS or not TEST_FILE.match(os.path.basename(tokens[1])):
        return None
    if not tests:
        return None
    t = tests[0]
    where = "" if t.get("dir", ".") == "." else f" --cwd {t['dir']}"
    return (f"`{' '.join(tokens[:2])}` runs one test file directly, which is not allowed: run it through §4 Unit "
            f"tests instead, `{lock} test{where} -- {t['cmd']} {tokens[1]}`, and read its summary rather than piping it")


def hints(command, cwd, allow, side):
    if UNSPLITTABLE.search(command):
        return None
    steps = split_steps(command)
    refused = [s for s, _ in steps if not may_run(s, allow)]
    if not refused:
        return None
    out = []
    first = shlex.split(steps[0][0])
    if len(steps) > 1 and len(first) == 2 and first[0] == "cd" and steps[0][1] in ("&&", ";") \
            and own_dir(first[1], cwd, side.get("worktree", [])):
        rest = command.split(steps[0][1], 1)[1].strip()
        out.append(f"the `cd {first[1]}` does nothing: your commands already run in your worktree. Run the rest "
                   f"without it: `{rest}`")
    for step, _ in steps:
        tokens = shlex.split(step)
        if tokens[:2] == ["sed", "-n"] and len(tokens) == 4 and SED_RANGE.match(tokens[2]):
            m = SED_RANGE.match(tokens[2])
            span = m.group(1) + (f",{m.group(2)}" if m.group(2) else "")
            out.append(f"for a line range, `desk-env lines {tokens[3]} {span}` prints what `{step}` does, "
                       "as one command")
    for step in refused:
        h = test_hint(spellings(shlex.split(step))[1], side.get("tests", []), side.get("lock", "~/.claude/desk/bin/with-lock.sh"))
        if h:
            out.append(h)
    if not out:
        return None
    names = ", ".join(f"`{s}`" for s in refused)
    return (f"Refused before it ran: {names} {'is' if len(refused) == 1 else 'are'} not allowed on its own, and a "
            "command runs only when every part of it is. " + " ".join(f"Instead, {h}." for h in out))


def sidecar(settings):
    return re.sub(r"\.json$", "", settings) + ".wrappers.json"


def main():
    try:
        settings = sys.argv[1]
        payload = json.load(sys.stdin)
        command = (payload.get("tool_input") or {}).get("command") or ""
        cwd = payload.get("cwd") or os.getcwd()
        with open(settings, encoding="utf-8") as f:
            allow = (json.load(f).get("permissions") or {}).get("allow") or []
        with open(sidecar(settings), encoding="utf-8") as f:
            side = json.load(f)
        reason = hints(command, cwd, allow, side)
    except Exception:  # noqa: BLE001 - any doubt is no opinion: the harness decides as it would
        return 0
    if reason:
        json.dump({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny",
                                          "permissionDecisionReason": reason}}, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
