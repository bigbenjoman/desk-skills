#!/usr/bin/env python3
"""Summarise the authenticated GitHub user's pull-request and issue activity on the check-out day.

Uses the `gh` CLI (already authenticated), so no token handling here. Lists PRs you
opened, merged, closed or pushed to, and other people's PRs you reviewed, across every
repo. Open PRs carry their review decision and check state, which is what "waiting on
approval" claims need. For each repo it also counts the PRs merged in the window, yours and
everyone's (the latter only for a configured repo whose own §3 read-others is `yes`, or `ask`
and passed with --include-others <slug>), so a post's merged count says whose PRs it means.

Issues are listed too: those you opened, closed or commented on in the window, in every repo read,
grouped by scope, then repo, then label (or, with none, the title's `prefix:`). On a repo whose §4
Tracker is `none` they are its tickets. Every search pages through up to the API's 1000 results, and
a list cut short there says so.

Rows are grouped by scope (see desk_repos.py): this check-out (the current repo and any
configured desk repo sharing its §4 Check-out destination), side projects
(DESK_CHECKOUT_SIDE_REPOS, comma-separated owner/repo), other configured desk repos, and
work that is not for this check-out. A configured repo is read only when its own §3
read-own-work is `yes` (or `ask` and passed with --include <slug>).

Every source and its permission: references/sources.md.

Usage:
  github_activity.py [--day auto|today|yesterday|<weekday>|YYYY-MM-DD] [--include <slug>]
                     [--include-others <slug>]
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
import desk_repos  # noqa: E402


def gh(*args):
    out = subprocess.run(["gh", *args], capture_output=True, text=True)
    return out.stdout if out.returncode == 0 else None


def parse_time(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


SEARCH_CAP = 1000  # the search API returns no result past the 1000th


def search_all(query, required=True):
    """(items, total, capped): every page of a search, up to the API's cap. capped is True when the
    search found more than it returns (past the cap, or results GitHub marked incomplete). A failed
    page stops a required search; otherwise it returns None for items."""
    items, total, capped = [], 0, False
    for page in range(1, SEARCH_CAP // 100 + 1):
        raw = gh("api", "-X", "GET", "search/issues", "-f", f"q={query}", "-f", "per_page=100", "-f", f"page={page}")
        if raw is None:
            if required:
                raise SystemExit(f"gh search failed for {query!r}")
            return None, 0, False
        data = json.loads(raw)
        got = data.get("items", [])
        items += got
        total = max(total, data.get("total_count") or 0)
        capped = capped or bool(data.get("incomplete_results"))
        if len(got) < 100:
            break
    capped = capped or total > len(items)
    return items, max(total, len(items)), capped


def search(query):
    return search_all(query)[0]


def cap_note(found, total, capped):
    return f" (capped: {found} of {total} found)" if capped else ""


def merged_counts(repo, login, since, until, day, everyone):
    """(mine, all) PRs merged into repo in the window; all is None when not everyone's are read."""
    query = f"is:pr is:merged repo:{repo} merged:>={day}" + ("" if everyone else f" author:{login}")
    items, found, capped = search_all(query, required=False)
    if items is None:
        return None
    mine = total = 0
    for pr in items:
        merged_at = (pr.get("pull_request") or {}).get("merged_at")
        if merged_at and since <= parse_time(merged_at) < until:
            total += 1
            mine += (pr.get("user") or {}).get("login") == login
    return mine, (total if everyone else None), cap_note(len(items), found, capped)


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


def my_comments(repo, number, login, since, until):
    raw = gh("api", f"repos/{repo}/issues/{number}/comments", "--paginate")
    return sum(
        1 for c in json.loads(raw or "[]")
        if (c.get("user") or {}).get("login") == login and c.get("created_at")
        and since <= parse_time(c["created_at"]) < until
    )


def closer(repo, number):
    raw = gh("api", f"repos/{repo}/issues/{number}")
    return ((json.loads(raw) if raw else {}).get("closed_by") or {}).get("login")


def theme(issue):
    """An issue's group within its repo: its first label, else its title's short `prefix:`, else other."""
    labels = sorted(lbl.get("name", "") for lbl in issue.get("labels") or [] if isinstance(lbl, dict) and lbl.get("name"))
    if labels:
        return f"label: {labels[0]}"
    head, sep, _ = (issue.get("title") or "").partition(":")
    head = head.strip().strip("[]()")
    return f"theme: {head}" if sep and head and len(head) <= 40 else "theme: other"


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
    desk_repos.add_include_argument(ap)
    ap.add_argument("--include-others", action="append", default=[], metavar="SLUG",
                    help="count everyone's merged PRs in a repo whose §3 read-others is `ask`, after the user agreed")
    args = ap.parse_args()
    repos, _current = desk_repos.load_all(args.include)
    skipped = set()
    start, end = window.resolve(args.day, since=args.since, since_for=args.since_for)
    since, until = start.astimezone(timezone.utc), end.astimezone(timezone.utc)
    login = (gh("api", "user", "-q", ".login") or "").strip()
    day = (start.astimezone(timezone.utc)).strftime("%Y-%m-%d")  # search is date-granular; filter below

    def within(ts):
        return bool(ts) and since <= parse_time(ts) < until

    def scope(repo):
        """Scope of an owner/repo, or None when that repo's own config does not allow reading it."""
        sc, cfg = desk_repos.scope_for_repo_name(repo, repos)
        ok, note = desk_repos.allowed(cfg, "read-own-work")
        if not ok:
            skipped.add(note)
            return None
        return sc

    def describe(pr):
        repo = pr["repository_url"].split("repos/")[1]
        sc = scope(repo)
        if sc is None:
            return None
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
        return sc, f"- {repo}#{pr['number']} {pr['title']} — {'; '.join(events)}"

    caps = []
    mine, found, capped = search_all(f"is:pr author:{login} updated:>={day}")
    if capped:
        caps.append(f"your PRs{cap_note(len(mine), found, capped)}")
    with ThreadPoolExecutor(max_workers=8) as pool:
        rows = [r for r in pool.map(describe, mine) if r]

    reviewed, found, capped = search_all(f"is:pr reviewed-by:{login} -author:{login} updated:>={day}")
    if capped:
        caps.append(f"PRs you reviewed{cap_note(len(reviewed), found, capped)}")

    def describe_review(pr):
        repo = pr["repository_url"].split("repos/")[1]
        sc = scope(repo)
        if sc is None:
            return None
        states = my_reviews(repo, pr["number"], login, since, until)
        if not states:
            return None
        author = (pr.get("user") or {}).get("login", "?")
        label = "" if sc == "this" else f" [{desk_repos.SCOPE_LABELS[sc]}]"
        return f"- {repo}#{pr['number']} {pr['title']} (by {author}) — you: {', '.join(states)}{label}"

    with ThreadPoolExecutor(max_workers=8) as pool:
        reviews = [r for r in pool.map(describe_review, reviewed) if r]

    side = [s.strip() for s in os.environ.get("DESK_CHECKOUT_SIDE_REPOS", "").split(",") if s.strip()]
    names = {n.lower(): n for n in side + [r.gh_repo for r in repos if r.gh_repo]}.values()

    def describe_merged(repo):
        sc = scope(repo)
        if sc is None:
            return None
        # read-others has its own consent, never --include's; a repo with no desk config has no row.
        everyone, note = desk_repos.allowed(desk_repos.scope_for_repo_name(repo, repos)[1], "read-others",
                                            include=args.include_others, flag="--include-others", unconfigured=False)
        if note:
            skipped.add(note)
        counts = merged_counts(repo, login, since, until, day, everyone)
        label = "" if sc == "this" else f" [{desk_repos.SCOPE_LABELS[sc]}]"
        if counts is None:
            return sc, f"- {repo}: not counted (gh search failed){label}"
        mine, total, capped = counts
        rest = f"{total} all" if total is not None else f"all not counted ({note or 'no desk config'})"
        return sc, f"- {repo}: {mine} mine / {rest}{capped}{label}"

    # Issues: yours that moved, others' you commented on, and others' closed in a repo read (kept
    # only where you closed them). Each search pages to the cap and says when it was cut short.
    issue_rows = {}
    for what, query in [("your issues", f"is:issue author:{login} updated:>={day}"),
                        ("issues you commented on", f"is:issue commenter:{login} -author:{login} updated:>={day}")] + [
            (f"issues closed in {r}", f"is:issue repo:{r} -author:{login} closed:>={day}") for r in sorted(names, key=str.lower) if scope(r) is not None]:
        found_items, found, capped = search_all(query, required=False)
        if found_items is None:
            caps.append(f"{what}: not read (gh search failed)")
            continue
        if capped:
            caps.append(f"{what}{cap_note(len(found_items), found, capped)}")
        for it in found_items:
            if "pull_request" in it:
                continue  # `is:issue` returns none, but a PR is never listed as an issue
            issue_rows.setdefault(it["repository_url"].split("repos/")[1].lower() + f"#{it['number']}", it)

    def hm(ts):
        t = parse_time(ts).astimezone()
        return t.strftime("%H:%M") if within(ts) else t.strftime("%-d %b %H:%M")

    def describe_issue(it):
        repo = it["repository_url"].split("repos/")[1]
        sc = scope(repo)
        if sc is None:
            return None
        mine_ = (it.get("user") or {}).get("login") == login
        events = []
        if mine_ and within(it.get("created_at")):
            events.append("opened")
        if it.get("state") == "closed" and within(it.get("closed_at")):
            by = closer(repo, it["number"])
            if by == login:
                events.append("closed")
            elif mine_:
                events.append(f"closed by {by or 'someone else'}")
        if it.get("comments"):
            n = my_comments(repo, it["number"], login, since, until)
            if n:
                events.append(f"commented{f' ×{n}' if n > 1 else ''}")
        if not any(not e.startswith("closed by") for e in events):
            return None  # nothing you did in the window
        when = f"closed {hm(it['closed_at'])}" if it.get("state") == "closed" and it.get("closed_at") else f"created {hm(it['created_at'])}"
        line = f"- #{it['number']} {it['title']} [{it.get('state', '?')}, {when}] — you: {', '.join(events)}"
        return sc, repo, theme(it), it["number"], line

    with ThreadPoolExecutor(max_workers=8) as pool:
        issues = [r for r in pool.map(describe_issue, issue_rows.values()) if r]

    with ThreadPoolExecutor(max_workers=8) as pool:
        merged = sorted((r for r in pool.map(describe_merged, sorted(names, key=str.lower)) if r), key=lambda r: desk_repos.SCOPE_ORDER[r[0]])

    print(f"# GitHub activity for {login}, {window.label(start, end)}\n")
    for group in sorted(desk_repos.SCOPE_ORDER, key=desk_repos.SCOPE_ORDER.get):
        items = [line for g, line in rows if g == group]
        if items:
            print(f"## {desk_repos.SCOPE_LABELS[group]} PRs ({len(items)})")
            print("\n".join(items) + "\n")
    if not rows:
        print("No PRs of yours moved in the window.\n")
    for group in sorted(desk_repos.SCOPE_ORDER, key=desk_repos.SCOPE_ORDER.get):
        items = [r for r in issues if r[0] == group]
        if not items:
            continue
        print(f"## {desk_repos.SCOPE_LABELS[group]} issues ({len(items)})")
        for repo in sorted({r[1] for r in items}, key=str.lower):
            in_repo = [r for r in items if r[1] == repo]
            print(f"### {repo} ({len(in_repo)})")
            for th in sorted({r[2] for r in in_repo}, key=lambda x: (x == "theme: other", x)):
                rows_ = sorted((r for r in in_repo if r[2] == th), key=lambda r: r[3])
                print(f"#### {th} ({len(rows_)})")
                print("\n".join(r[4] for r in rows_))
        print()
    if not issues:
        print("No issues you opened, closed or commented on in the window.\n")
    print(f"## Reviews you gave ({len(reviews)})")
    print("\n".join(reviews) if reviews else "none")
    print("\n## Merged PRs in the window, by author (yours / everyone's)")
    print("\n".join(line for _, line in merged) if merged else "none")
    if caps:
        print("\n## Searches cut short")
        print("\n".join(f"- {c}" for c in caps))
    if skipped:
        print("\n## Skipped by permission")
        print("\n".join(f"- {n}" for n in sorted(skipped)))


if __name__ == "__main__":
    sys.exit(main())
