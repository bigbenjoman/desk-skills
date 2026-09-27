#!/usr/bin/env python3
"""Summarise the authenticated GitHub user's pull-request activity on the check-out day.

Uses the `gh` CLI (already authenticated), so no token handling here. Lists PRs you
opened, merged, closed or pushed to, and other people's PRs you reviewed. Open PRs
carry their review decision and check state, which is what "waiting on approval"
claims need. Output is grouped Studia / side projects / not Studia work.

Side projects are repos you want reported but kept apart from Studia work: set
DESK_CHECKOUT_SIDE_REPOS to a comma-separated list of owner/repo.

Usage:
  github_activity.py [--day auto|today|yesterday|<weekday>|YYYY-MM-DD]
"""
import argparse
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

sys.dont_write_bytecode = True  # a __pycache__ in the installed skill reads as a user edit to install.sh
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import window  # noqa: E402

DESK_OWNER = "Sophos-Education"
SIDE_REPOS = {r.strip() for r in os.environ.get("DESK_CHECKOUT_SIDE_REPOS", "").split(",") if r.strip()}
GROUPS = ("Studia", "Side project", "Not Studia work")


def gh(*args):
    out = subprocess.run(["gh", *args], capture_output=True, text=True)
    return out.stdout if out.returncode == 0 else None


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def search(query):
    raw = gh("api", "-X", "GET", "search/issues", "-f", f"q={query}", "-f", "per_page=100")
    if raw is None:
        raise SystemExit(f"gh search failed for {query!r}")
    return json.loads(raw).get("items", [])


def group_of(repo):
    if repo in SIDE_REPOS:
        return "Side project"
    return "Studia" if repo.startswith(DESK_OWNER + "/") else "Not Studia work"


def pr_state(repo, number):
    """Review decision and a one-word check summary for an open PR."""
    raw = gh("pr", "view", str(number), "-R", repo, "--json", "reviewDecision,statusCheckRollup,isDraft")
    if not raw:
        return ""
    data = json.loads(raw)
    failing = sorted({
        c.get("name") or c.get("context") or "?"
        for c in data.get("statusCheckRollup") or []
        if (c.get("conclusion") or c.get("state") or "").upper() in ("FAILURE", "ERROR", "TIMED_OUT", "CANCELLED")
    })
    pending = any((c.get("status") or "").upper() in ("IN_PROGRESS", "QUEUED", "PENDING") for c in data.get("statusCheckRollup") or [])
    checks = f"failing: {', '.join(failing)}" if failing else ("checks running" if pending else "checks green")
    review = (data.get("reviewDecision") or "no review decision").lower().replace("_", " ")
    return f"{'draft, ' if data.get('isDraft') else ''}{review}, {checks}"


def my_commits_in_window(repo, number, login, since, until):
    raw = gh("api", f"repos/{repo}/pulls/{number}/commits", "--paginate")
    count = 0
    for c in json.loads(raw or "[]"):
        author = (c.get("author") or {}).get("login")
        date = ((c.get("commit") or {}).get("committer") or {}).get("date")
        message = (c.get("commit") or {}).get("message", "")
        if author == login and date and since <= parse_time(date) < until and not message.startswith("Merge "):
            count += 1
    return count


def my_reviews(repo, number, login, since, until):
    raw = gh("api", f"repos/{repo}/pulls/{number}/reviews", "--paginate")
    return [
        r["state"].lower().replace("_", " ")
        for r in json.loads(raw or "[]")
        if (r.get("user") or {}).get("login") == login and r.get("submitted_at")
        and since <= parse_time(r["submitted_at"]) < until
    ]


def main():
    ap = argparse.ArgumentParser()
    window.add_day_argument(ap)
    args = ap.parse_args()
    start, end = window.resolve(args.day)
    since, until = start.astimezone(timezone.utc), end.astimezone(timezone.utc)
    login = (gh("api", "user", "-q", ".login") or "").strip()
    day = (start.astimezone(timezone.utc)).strftime("%Y-%m-%d")  # search is date-granular; filter below

    def within(ts):
        return bool(ts) and since <= parse_time(ts) < until

    def describe(pr):
        repo = pr["repository_url"].split("repos/")[1]
        merged_at = (pr.get("pull_request") or {}).get("merged_at")
        events = []
        if within(pr["created_at"]):
            events.append("opened")
        if within(merged_at):
            events.append("merged")
        elif pr["state"] == "closed" and within(pr.get("closed_at")):
            events.append("closed unmerged")
        elif pr["state"] == "open":
            pushed = my_commits_in_window(repo, pr["number"], login, since, until)
            if pushed:
                events.append(f"{pushed} commit{'s' if pushed > 1 else ''} pushed")
            if events:
                events.append(pr_state(repo, pr["number"]))
        if not events:
            return None  # touched only by bots, CI, title edits or branch syncs
        return group_of(repo), f"- {repo}#{pr['number']} {pr['title']} — {'; '.join(events)}"

    mine = search(f"is:pr author:{login} updated:>={day}")
    with ThreadPoolExecutor(max_workers=8) as pool:
        rows = [r for r in pool.map(describe, mine) if r]

    reviewed = search(f"is:pr reviewed-by:{login} -author:{login} updated:>={day}")

    def describe_review(pr):
        repo = pr["repository_url"].split("repos/")[1]
        states = my_reviews(repo, pr["number"], login, since, until)
        if not states:
            return None
        author = (pr.get("user") or {}).get("login", "?")
        return f"- {repo}#{pr['number']} {pr['title']} (by {author}) — you: {', '.join(states)}"

    with ThreadPoolExecutor(max_workers=8) as pool:
        reviews = [r for r in pool.map(describe_review, reviewed) if r]

    print(f"# GitHub activity for {login}, {window.label(start)}\n")
    for group in GROUPS:
        items = [line for g, line in rows if g == group]
        if items:
            print(f"## {group} PRs ({len(items)})")
            print("\n".join(items) + "\n")
    if not rows:
        print("No PRs of yours moved in the window.\n")
    print(f"## Reviews you gave ({len(reviews)})")
    print("\n".join(reviews) if reviews else "none")


if __name__ == "__main__":
    sys.exit(main())
