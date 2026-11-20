"""The check-out window, shared by every collector so they all cover the same stretch.

`--day` takes today, yesterday, a weekday name (the most recent one before today) or
YYYY-MM-DD. The default, auto, is today, except before 10:00 local, when it is yesterday:
a check-out written first thing is for the day before.

`--since` starts the window at the previous check-out, when that falls inside the day, so a second
check-out of the same day lists only what came after the first. It takes a time (HH:MM, local, on the
day) or an ISO timestamp; `none` covers the whole day; the default, auto, is the last check-out this
computer handed over for the same destination (one team, one post) and the same day, as
`window.py mark` recorded it.

  python3 window.py mark [--day D]   record now as the hand-over of this destination's check-out for D
  python3 window.py last [--day D]   print that check-out's time, or nothing
"""
import argparse
import json
import os
import sys
from datetime import datetime, time, timedelta

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
MORNING_CUTOFF = time(10, 0)


def stamp_path():
    return os.environ.get("DESK_CHECKOUT_STAMP") or os.path.join(os.path.expanduser("~"), ".desk-autopilot", "checkout-last.json")


def add_day_argument(parser):
    parser.add_argument("--day", default="auto", help="auto | today | yesterday | <weekday> | YYYY-MM-DD")
    parser.add_argument("--since", default="auto", help="auto (this destination's last check-out that day) | none | HH:MM | an ISO timestamp")


def scope_of(current):
    """The key a check-out's stamp is kept under: its §4 Check-out destination, else its repo."""
    if current is None:
        return "default"
    return current.destination or f"repo:{current.slug}"


def _stamps():
    try:
        with open(stamp_path()) as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def last_checkout(scope, day):
    """When the check-out for `scope` covering `day` (a date) was handed over, as an aware datetime, or None."""
    s = _stamps().get(scope)
    try:
        if s and s.get("day") == day.isoformat():
            return datetime.fromisoformat(s["at"]).astimezone()
    except (KeyError, ValueError, TypeError):
        pass
    return None


def mark(scope, day, now=None):
    data = _stamps()
    data[scope] = {"at": (now or datetime.now()).astimezone().isoformat(timespec="seconds"), "day": day.isoformat()}
    path = stamp_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=1, sort_keys=True)


def _target(day, now):
    today = now.date()
    value = day.strip().lower()
    if value == "auto":
        return today - timedelta(days=1) if now.time() < MORNING_CUTOFF else today
    if value == "today":
        return today
    if value == "yesterday":
        return today - timedelta(days=1)
    if value in WEEKDAYS:
        back = (today.weekday() - WEEKDAYS.index(value)) % 7 or 7
        return today - timedelta(days=back)
    return datetime.strptime(value, "%Y-%m-%d").date()


def _since(value, target, scope):
    value = (value or "auto").strip().lower()
    if value == "none":
        return None
    if value == "auto":
        return last_checkout(scope, target) if scope else None
    try:
        return datetime.combine(target, datetime.strptime(value, "%H:%M").time()).astimezone()
    except ValueError:
        return datetime.fromisoformat(value).astimezone()


def resolve(day="auto", now=None, since="none", scope=None):
    """Return (start, end) as aware local datetimes: the chosen day, from `since` when it falls in it."""
    now = (now or datetime.now()).astimezone()
    target = _target(day, now)
    start = datetime.combine(target, time.min).astimezone()
    end = start + timedelta(days=1)
    from_ = _since(since, target, scope)
    if from_ is not None and start < from_ < min(end, now):
        start = from_
    return start, end


def label(start):
    day = start.strftime("%A %-d %B %Y")
    return day if start.time() == time.min else f"{day}, from {start.strftime('%H:%M')} (the last check-out)"


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="mark | last: this destination's last check-out")
    ap.add_argument("cmd", choices=["mark", "last"])
    ap.add_argument("--day", default="auto")
    args = ap.parse_args()
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import desk_repos  # noqa: E402
    _, current = desk_repos.load_all()
    scope = scope_of(current)
    target = _target(args.day, datetime.now().astimezone())
    if args.cmd == "mark":
        mark(scope, target)
        print(f"check-out for {target.isoformat()} recorded for {scope}: the next one that day starts after it")
    else:
        last = last_checkout(scope, target)
        if last:
            print(last.isoformat(timespec="minutes"))
