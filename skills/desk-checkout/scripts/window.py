"""The check-out window, shared by every collector so they all cover the same stretch.

`--day` takes today, yesterday, a weekday name (the most recent one before today) or
YYYY-MM-DD. The default, auto, is today, except before 10:00 local, when it is yesterday:
a check-out written first thing is for the day before.

`--since` starts the window where the previous check-out stopped, so a check-out lists only what
came after the last one: at the time it was posted (as the destination shows it), or, given
`--since-for` (the day that check-out covered), at the end of that day if that came first, since a
check-out written the next morning covered only its own day. It takes a time (HH:MM, local, on the
day) or an ISO timestamp; the default, none, covers the whole day. A start on an earlier day (the
previous evening's check-out) moves the window back to it, so nothing between that post and midnight
drops out. A start after the day's end, or not yet past, leaves the whole day.
"""
from datetime import datetime, time, timedelta

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
MORNING_CUTOFF = time(10, 0)


def add_day_argument(parser):
    parser.add_argument("--day", default="auto", help="auto | today | yesterday | <weekday> | YYYY-MM-DD")
    parser.add_argument("--since", default="none", help="none | HH:MM | an ISO timestamp: when the previous check-out was posted")
    parser.add_argument("--since-for", default="none", help="none | YYYY-MM-DD: the day the previous check-out covered")


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


def _since(value, target):
    raw = (value or "none").strip()
    if raw.lower() == "none":
        return None
    try:
        return datetime.combine(target, datetime.strptime(raw, "%H:%M").time()).astimezone()
    except ValueError:
        # A trailing Z is UTC; fromisoformat reads it only from Python 3.11, so it is spelled out.
        return datetime.fromisoformat(raw[:-1] + "+00:00" if raw.endswith("Z") else raw).astimezone()


def resolve(day="auto", now=None, since="none", since_for="none"):
    """Return (start, end) as aware local datetimes: the chosen day's end, from where the previous
    check-out stopped (`since`, no later than the end of `since_for`, the day it covered) when that is
    before the day's end and already past; else from the start of the day."""
    now = (now or datetime.now()).astimezone()
    target = _target(day, now)
    start = datetime.combine(target, time.min).astimezone()
    end = start + timedelta(days=1)
    from_ = _since(since, target)
    covered = (since_for or "none").strip()
    if from_ is not None and covered.lower() != "none":
        from_ = min(from_, datetime.combine(datetime.strptime(covered, "%Y-%m-%d").date() + timedelta(days=1), time.min).astimezone())
    if from_ is not None and from_ != start and from_ < min(end, now):
        start = from_
    return start, end


def label(start, end=None):
    """The window as a header names it: the day, and where it starts when that is not its midnight
    (a start the evening before names its own day)."""
    day_start = (end - timedelta(days=1)) if end is not None else datetime.combine(start.date(), time.min).astimezone()
    day = day_start.strftime("%A %-d %B %Y")
    if start == day_start:
        return day
    at = start.strftime("%H:%M") if start.date() == day_start.date() else start.strftime("%A %-d %B %H:%M")
    return f"{day}, from {at} (the previous check-out)"
