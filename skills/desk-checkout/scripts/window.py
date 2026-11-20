"""The check-out window, shared by every collector so they all cover the same stretch.

`--day` takes today, yesterday, a weekday name (the most recent one before today) or
YYYY-MM-DD. The default, auto, is today, except before 10:00 local, when it is yesterday:
a check-out written first thing is for the day before.

`--since` starts the window at the previous check-out, when that falls inside the day, so a second
check-out the same day lists only what came after the first. It takes a time (HH:MM, local, on the
day) or an ISO timestamp; the default, auto, is the last check-out this computer handed over (the
stamp `window.py mark` keeps); `none` covers the whole day.

  python3 window.py mark     record now as the last check-out (the skill's step 5)
  python3 window.py last     print the last check-out's time, or nothing
"""
import os
import sys
from datetime import datetime, time, timedelta

WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
MORNING_CUTOFF = time(10, 0)


def stamp_path():
    return os.environ.get("DESK_CHECKOUT_STAMP") or os.path.join(os.path.expanduser("~"), ".desk-autopilot", "checkout-last")


def add_day_argument(parser):
    parser.add_argument("--day", default="auto", help="auto | today | yesterday | <weekday> | YYYY-MM-DD")
    parser.add_argument("--since", default="auto", help="auto (the last check-out) | none | HH:MM | an ISO timestamp")


def last_checkout():
    """The last check-out handed over on this computer, as an aware datetime, or None."""
    try:
        with open(stamp_path()) as f:
            return datetime.fromisoformat(f.read().strip()).astimezone()
    except (OSError, ValueError):
        return None


def mark(now=None):
    path = stamp_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write((now or datetime.now()).astimezone().isoformat(timespec="seconds"))


def _since(value, day_start):
    value = (value or "auto").strip().lower()
    if value == "none":
        return None
    if value == "auto":
        return last_checkout()
    try:
        return datetime.combine(day_start.date(), datetime.strptime(value, "%H:%M").time()).astimezone()
    except ValueError:
        return datetime.fromisoformat(value).astimezone()


def resolve(day="auto", now=None, since="none"):
    """Return (start, end) as aware local datetimes: the chosen day, from `since` when it falls in it."""
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
    end = start + timedelta(days=1)
    from_ = _since(since, start)
    if from_ is not None and start < from_ < min(end, now):
        start = from_
    return start, end


def label(start):
    day = start.strftime("%A %-d %B %Y")
    return day if start.time() == time.min else f"{day}, from {start.strftime('%H:%M')} (the last check-out)"


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "mark":
        mark()
        print(f"last check-out recorded: {last_checkout().strftime('%Y-%m-%d %H:%M')}")
    elif cmd == "last":
        last = last_checkout()
        if last:
            print(last.isoformat(timespec="minutes"))
    else:
        sys.exit("usage: window.py mark | last")
