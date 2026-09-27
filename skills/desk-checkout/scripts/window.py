"""The check-out window, shared by every collector so they all cover the same day.

`--day` takes today, yesterday, a weekday name (the most recent one before today) or
YYYY-MM-DD. The default, auto, is today, except before 10:00 local, when it is yesterday:
a check-out written first thing is for the day before.
"""
from datetime import datetime, time, timedelta

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
MORNING_CUTOFF = time(10, 0)


def add_day_argument(parser):
    parser.add_argument("--day", default="auto", help="auto | today | yesterday | <weekday> | YYYY-MM-DD")


def resolve(day="auto", now=None):
    """Return (start, end) as aware local datetimes covering the whole chosen day."""
    now = (now or datetime.now()).astimezone()
    today = now.date()
    value = day.strip().lower()
    if value == "auto":
        target = today - timedelta(days=1) if now.time() < MORNING_CUTOFF else today
    elif value == "today":
        target = today
    elif value == "yesterday":
        target = today - timedelta(days=1)
    elif value in WEEKDAYS:
        back = (today.weekday() - WEEKDAYS.index(value)) % 7 or 7
        target = today - timedelta(days=back)
    else:
        target = datetime.strptime(value, "%Y-%m-%d").date()
    start = datetime.combine(target, time.min).astimezone()
    return start, start + timedelta(days=1)


def label(start):
    return start.strftime("%A %-d %B %Y")
