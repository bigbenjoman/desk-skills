"""The check-out window, shared by every collector so they all cover the same stretch.

`--day` takes today, yesterday, a weekday name (the most recent one before today) or
YYYY-MM-DD. The default, auto, is today, except before 10:00 local, when it is yesterday:
a check-out written first thing is for the day before.

`--since` starts the window at the previous check-out of the same day, as the destination shows
it was posted, so a second check-out lists only what came after the first. It takes a time (HH:MM,
local, on the day) or an ISO timestamp; the default, none, covers the whole day. A time outside the
day, or not yet past, leaves the whole day.
"""
from datetime import datetime, time, timedelta

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
MORNING_CUTOFF = time(10, 0)


def add_day_argument(parser):
    parser.add_argument("--day", default="auto", help="auto | today | yesterday | <weekday> | YYYY-MM-DD")
    parser.add_argument("--since", default="none", help="none | HH:MM | an ISO timestamp: when the previous check-out of the day was posted")


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
    value = (value or "none").strip().lower()
    if value == "none":
        return None
    try:
        return datetime.combine(target, datetime.strptime(value, "%H:%M").time()).astimezone()
    except ValueError:
        return datetime.fromisoformat(value).astimezone()


def resolve(day="auto", now=None, since="none"):
    """Return (start, end) as aware local datetimes: the chosen day, from `since` when it falls in it."""
    now = (now or datetime.now()).astimezone()
    target = _target(day, now)
    start = datetime.combine(target, time.min).astimezone()
    end = start + timedelta(days=1)
    from_ = _since(since, target)
    if from_ is not None and start < from_ < min(end, now):
        start = from_
    return start, end


def label(start):
    day = start.strftime("%A %-d %B %Y")
    return day if start.time() == time.min else f"{day}, from {start.strftime('%H:%M')} (the previous check-out)"
