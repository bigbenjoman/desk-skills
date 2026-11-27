#!/usr/bin/env python3
"""Print the work recorded outside PRs and tickets in the check-out window: the person's own work logs,
and the settings changes desk records itself.

Work logs: the files or globs each in-scope repo's §3b "Check-out work logs" row names (`none` or unset
reads nothing). An entry is a line with a time on it: `- HH:MM …` (or `HH:MM …`) on the date of the
nearest ISO date above it (a `## 2026-11-27` heading, say), else on the file's modified date; or a line
carrying an ISO date and time (`2026-11-27 14:05`, `2026-11-27T14:05`). A line under a date heading with
no time of its own counts when that date falls in the window, marked `(no time)`. A file with no time
or date on any line falls back to its modified time: when that is in the window, its last lines are
printed, said as such.

Desk's own records, for each in-scope repo (~/.config/desk/repos/<slug>/ and ~/.desk-autopilot/<slug>/):
  config rows changed   each config.md.bak* modified in the window, diffed against the next copy (the
                        next backup, else config.md) by desk-changes.mjs --config-entries: one line
                        per row changed, added or removed; said as not read when that fails
  lever changes         levers.jsonl events that change a lever's state or the row (see LEVER_KINDS)
  decisions             decisions.jsonl in the repo's state and each batch's: calls taken, checks made
                        and overrides of a taken call
  needs-you answered    the check-in digest's answered.json entries for the repo

Each comes out as one line with its time and source. Everything here is read only under the repo's own
§3 read-own-work (`yes`, or `ask` and passed with --include <slug>).

Every source and its permission: references/sources.md.

Usage:
  worklog_activity.py [--day auto|today|yesterday|<weekday>|YYYY-MM-DD] [--since …] [--include <slug>]
"""
import argparse
import glob
import json
import os
import re
import sys
from datetime import date, datetime, timedelta

sys.dont_write_bytecode = True  # a __pycache__ in the installed skill reads as a user edit to install.sh
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import window  # noqa: E402
import desk_repos  # noqa: E402

HOME = os.path.expanduser("~")
STATE_ROOT = os.path.join(HOME, ".desk-autopilot")
ENTRY_CHARS = 300
FALLBACK_LINES = 15

ISO_DT = re.compile(r"\b(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?")
ISO_DATE = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")
TIMED = re.compile(r"^\s*(?:[-*+]\s+)?(?:\*\*|\[)?(\d{1,2}):(\d{2})(?:\*\*|\])?\b\s*[-–—:]?\s*(.*)$")
BULLET = re.compile(r"^\s*(?:[-*+]|\d+\.)\s+(.*)$")

# The lever-log kinds (desk/bin/lever-log.mjs KINDS) that change a lever or the row: a trial moving on
# (transition), a lever set by hand (override), a revert with no evaluation (trip), a kept lever's
# ramp, the machine-wide freeze and thaw, the config row changed, and a pair trial's state change.
# The rest are bookkeeping, not a change: assign (one ticket's draw), fp_reset, evidence_incomplete,
# audit, audit_deferred, and needs_you (an item raised, not resolved).
LEVER_KINDS = ("transition", "override", "trip", "ramp", "freeze", "thaw", "row_change", "pair")


def shorten(text, limit=ENTRY_CHARS):
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def parse_iso(value):
    if not value:
        return None
    try:
        v = str(value)
        t = datetime.fromisoformat(v[:-1] + "+00:00" if v.endswith("Z") else v)
    except ValueError:
        return None
    return (t if t.tzinfo else t.astimezone()).astimezone()


def local(d, hh, mm):
    """That date and time on this computer's clock, or None for a time no clock shows (24:00, 9:75)."""
    try:
        return datetime(d.year, d.month, d.day, int(hh), int(mm)).astimezone()
    except ValueError:
        return None


def iso_dt(m):
    """An ISO_DT match as a time, or None when its time is out of range. A single-digit hour is padded
    first, as fromisoformat wants two digits."""
    if not m.group(4):
        return local(_date(m.group(1)), m.group(2), m.group(3))
    hh, mm = int(m.group(2)), int(m.group(3))
    if not (hh < 24 and mm < 60):
        return None
    return parse_iso(f"{m.group(1)}T{hh:02d}:{mm:02d}{m.group(0)[m.end(3) - m.start(0):]}")


def _date(text):
    try:
        return date.fromisoformat(text)
    except ValueError:
        return None


# ---- work logs ------------------------------------------------------------------------------------

def worklog_entries(path, since, until):
    """(entries, fallback): entries [(when or None, date, text)] in the window; fallback is the file's
    last lines when it has no time or date on any line and was modified in the window, else None."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            lines = fh.read().splitlines()
        mtime = datetime.fromtimestamp(os.path.getmtime(path)).astimezone()
    except OSError:
        return [], None
    day_of_file = mtime.date()
    first_day, last_day = since.date(), (until - timedelta(microseconds=1)).date()
    current = None  # the date of the nearest ISO date above
    entries, dated = [], False
    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            continue
        m = ISO_DT.search(line)
        if m and _date(m.group(1)):
            dated = True
            when = iso_dt(m)
            rest = (line[: m.start()] + line[m.end():]).strip(" -–—:*#|")
            if when is None:  # a time out of range (24:00): an entry on its date with no time
                current = _date(m.group(1))
                if first_day <= current <= last_day and rest:
                    entries.append((None, current, rest))
                continue
            current = when.date()
            if since <= when < until and rest:
                entries.append((when, when.date(), rest))
            continue
        d = ISO_DATE.search(line)
        if d and _date(d.group(1)):
            dated = True
            b = BULLET.match(line)
            if b and not line.lstrip().startswith("#"):
                on = _date(d.group(1))  # a dated bullet with no time: an entry on that day
                rest = (line[: d.start()] + line[d.end():]).strip(" -–—:*")
                if first_day <= on <= last_day and rest:
                    entries.append((None, on, rest))
            else:
                current = _date(d.group(1))  # a date heading: the lines under it are on that day
            continue
        t = TIMED.match(line)
        if t and 0 <= int(t.group(1)) < 24 and t.group(3).strip():
            dated = True
            when = local(current or day_of_file, t.group(1), t.group(2))
            if when and since <= when < until:  # None: a minute out of range (2:75), not an entry
                entries.append((when, when.date(), t.group(3).strip()))
            continue
        b = BULLET.match(line)
        if b and current and first_day <= current <= last_day and not line.startswith(("  ", "\t")):
            entries.append((None, current, b.group(1).strip()))
    if dated or not (since <= mtime < until):
        return entries, None
    body = [l.strip() for l in lines if l.strip()]
    return [], (mtime, body[-FALLBACK_LINES:])


def worklog_paths(repo):
    """The repo's §3b Check-out work logs, as existing files (globs expanded), or [] for none/unset."""
    cmd = desk_repos.desk_env_cmd()
    if not cmd or not repo.config_path:
        return []
    out, rc = desk_repos._run(cmd + ["list", "checkout-worklogs"], {"DESK_CONFIG": repo.config_path, "DESK_SLUG": repo.slug})
    if rc != 0 or not out:
        return []
    files = []
    for item in out.splitlines():
        item = item.strip()
        if not item or item.lower() == "none":
            continue
        files += [f for f in sorted(glob.glob(os.path.expanduser(item))) if os.path.isfile(f)]
    return files


# ---- desk's own records ---------------------------------------------------------------------------

def items_text(items):
    """A row's items as desk-changes.mjs prints them: each in backticks (unless it already holds one)."""
    if not items:
        return "(empty)"
    return shorten(" ".join(i if "`" in i else f"`{i}`" for i in items), 120)


def config_changes(repo, since, until):
    """One fact per config row a write in the window changed, read through desk-changes.mjs
    --config-entries (configEntries, with desk-env's own row parser), so there is one config diff.
    desk-env copies the file to its backup at each write, so a pair whose earlier copy is a backup is
    dated by that backup's time. Returns (facts, why it could not be read, or None)."""
    if not repo.config_path:
        return [], None
    cmd = desk_repos.desk_env_cmd()
    mjs = os.path.join(os.path.dirname(cmd[-1]), "desk-changes.mjs") if cmd and cmd[-1].endswith(".mjs") else None
    if not mjs or not os.path.isfile(mjs):
        return [], "desk-changes.mjs not found beside desk-env.mjs"
    out, rc = desk_repos._run(["node", mjs, "--config-entries", repo.config_path])
    try:
        entries = json.loads(out) if rc == 0 and out else None
    except ValueError:
        entries = None
    if not isinstance(entries, list):
        return [], f"desk-changes.mjs --config-entries failed (exit {rc})"
    facts = []
    for e in entries:
        was_file = e.get("was_file") or ""
        at = parse_iso(e.get("was_at"))
        if ".bak" not in os.path.basename(was_file) or not at or not (since <= at < until):
            continue
        section, _, label = str(e.get("row", "")).partition(" ")
        was, now = e.get("from"), e.get("to")
        what = (f"added: {items_text(now)}" if was is None else f"removed (was {items_text(was)})" if now is None
                else f"{items_text(was)} → {items_text(now)}")
        src = f"{os.path.basename(was_file)} vs {os.path.basename(e.get('file') or '')}"
        facts.append((at, f'config {section} "{label}": {what} (source: {src})'))
    return facts, None


def jsonl(path):
    out = []
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    e = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(e, dict):
                    out.append(e)
    except OSError:
        pass
    return out


def lever_changes(slug, since, until):
    path = os.path.join(STATE_ROOT, slug, "levers.jsonl")
    facts = []
    for e in jsonl(path):
        at = parse_iso(e.get("at"))
        if not at or not (since <= at < until) or e.get("kind") not in LEVER_KINDS:
            continue
        who = e.get("lever") or (" + ".join(e["levers"]) if isinstance(e.get("levers"), list) else None) or "every lever"
        # A row_change carries before/after (the row's text); the state changes carry from/to.
        keys = ("before", "after") if e["kind"] == "row_change" else ("from", "to")
        move = " → ".join(str(e[k]) for k in keys if e.get(k) is not None)
        value = f" ({e['value']})" if e.get("value") is not None else ""
        reason = f" — {shorten(e['reason'], 160)}" if e.get("reason") else ""
        facts.append((at, f"lever {who} {e['kind']}{': ' + move if move else ''}{value}{reason} (source: levers.jsonl)"))
    return facts


def decisions(slug, since, until):
    paths = [os.path.join(STATE_ROOT, slug, "decisions.jsonl")] + sorted(glob.glob(os.path.join(STATE_ROOT, slug, "batches", "*", "decisions.jsonl")))
    facts, seen = [], set()
    for path in paths:
        src = os.path.relpath(path, os.path.join(STATE_ROOT, slug))
        for e in jsonl(path):
            at = parse_iso(e.get("at"))
            if not at or not (since <= at < until) or e.get("id") in seen:
                continue
            seen.add(e.get("id"))
            ticket = f"{e['ticket']}: " if e.get("ticket") else ""
            if e.get("override_of"):
                text = f"decision overridden: {ticket}{shorten(e.get('question', ''), 160)}: {e.get('was')} → {e.get('chose')}{' by ' + e['by'] if e.get('by') else ''}"
            elif e.get("kind") == "check":
                text = f"checked instead of asking: {ticket}{shorten(e.get('question', ''), 160)}: {shorten(e.get('showed', ''), 120)}"
            else:
                text = f"decision taken: {ticket}{shorten(e.get('question', ''), 160)}: chose {e.get('chose')}{' [' + e['category'] + ']' if e.get('category') else ''}"
            facts.append((at, f"{text} (source: {src})"))
    return facts


def answered(slug, since, until):
    digest = os.path.expanduser(os.environ.get("DESK_DIGEST_DIR") or os.path.join(STATE_ROOT, "digest"))
    try:
        with open(os.path.join(digest, "answered.json"), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return []
    facts = []
    for key, ts in (data.items() if isinstance(data, dict) else []):
        parts = str(key).split("/")
        at = parse_iso(ts)
        if len(parts) >= 2 and parts[0] == slug and at and since <= at < until:
            facts.append((at, f"needs-you item answered: {parts[1]} (source: digest answered.json)"))
    return facts


def main():
    ap = argparse.ArgumentParser()
    window.add_day_argument(ap)
    desk_repos.add_include_argument(ap)
    args = ap.parse_args()
    since, until = window.resolve(args.day, since=args.since, since_for=args.since_for)
    repos, _current = desk_repos.load_all(args.include)
    in_scope = [r for r in repos if r.scope == "this" and r.config_path]
    skipped, readable = [], []
    for r in in_scope:
        ok, note = desk_repos.allowed(r, "read-own-work")
        (readable.append(r) if ok else skipped.append(note))

    print(f"# Work logs and desk records, {window.label(since, until)}\n")
    files, seen = [], set()
    for r in readable:
        for f in worklog_paths(r):
            if os.path.realpath(f) not in seen:  # one file named by two repos, or two globs, once
                seen.add(os.path.realpath(f))
                files.append(f)
    if not files:
        print("## Work logs\nnone configured (§3b Check-out work logs is none or unset in every repo read)\n")
    else:
        shown = 0
        print(f"## Work logs ({len(files)} file{'s' if len(files) > 1 else ''})")
        for f in files:
            entries, fallback = worklog_entries(f, since, until)
            label = "~" + f[len(HOME):] if f.startswith(HOME + os.sep) else f
            if entries:
                shown += 1
                print(f"### {label} ({len(entries)})")
                for when, _d, text in sorted(entries, key=lambda e: (e[1], e[0] is None, e[0] or since)):
                    print(f"- {when.strftime('%H:%M') if when else '(no time)'} {shorten(text)}")
            elif fallback:
                shown += 1
                mtime, body = fallback
                print(f"### {label} (no timestamped lines; modified {mtime:%H:%M}, in the window, so its last lines)")
                print("\n".join(f"  {shorten(l)}" for l in body))
        if not shown:
            print("no entries in the window")
        print()

    for r in readable:
        config, unread = config_changes(r, since, until)
        facts = config + lever_changes(r.slug, since, until) + decisions(r.slug, since, until) + answered(r.slug, since, until)
        print(f"## Desk records: {r.slug} ({len(facts)})")
        print("\n".join(f"- {at:%H:%M} {text}" for at, text in sorted(facts, key=lambda f: f[0])) if facts else "none in the window")
        if unread:
            print(f"config rows changed: not read ({unread})")
        print()
    if skipped:
        print("## Skipped by permission")
        print("\n".join(f"- {n}" for n in sorted(skipped)))


if __name__ == "__main__":
    sys.exit(main())
