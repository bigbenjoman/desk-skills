#!/usr/bin/env python3
"""Summarise what the user did in Jira within a time window, per configured repo.

For every desk repo in this check-out's scope (the current repo, repos sharing its §4
Check-out destination, and side projects; see desk_repos.py) whose §4 Tracker is `jira`
and whose §3 read-own-work allows it, finds candidate issues in that repo's §4 Jira
project with JQL, then reads each issue's changelog and comments and keeps only the
changes the user made inside the window: tickets raised, status moves, reassignments,
priority and other field changes, and comments. Prints compact markdown.

Usage:
  jira_activity.py [--day auto|today|yesterday|<weekday>|YYYY-MM-DD] [--include <slug>]

The grade shown is the repo's §4 Priority: its custom field when it names one
(customfield_NNNNN), otherwise Jira's built-in priority.

Every request goes through `desk-jira api` with DESK_SLUG set to the repo, so the site,
email and token rules (and their JIRA_* overrides) live in desk-jira alone, and the token
never passes through this script.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

sys.dont_write_bytecode = True  # a __pycache__ in the installed skill reads as a user edit to install.sh
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import window  # noqa: E402
import desk_repos  # noqa: E402

DESK_JIRA = shutil.which("desk-jira") or os.path.expanduser("~/.local/bin/desk-jira")
# Built-in fields worth reporting. Custom fields are all reported (by display name) except these,
# which move on every drag or sprint shuffle and say nothing about the work.
TRACKED = {"status", "assignee", "priority", "resolution", "Sprint", "labels"}
UNTRACKED_CUSTOM = {"Rank", "Sprint"}
# Severity-style labels cut across batches, so they never name a raise group.
SEVERITY_LABEL = re.compile(r"^(sev|severity|prio|priority|p\d)", re.I)


class JiraError(Exception):
    pass


class Jira:
    def __init__(self, slug):
        self.env = {k: v for k, v in os.environ.items() if k != "DESK_CONFIG"}
        self.env["DESK_SLUG"] = slug

    def get(self, path, **params):
        rest = path.removeprefix("/rest/") + ("?" + urllib.parse.urlencode(params) if params else "")
        try:
            out = subprocess.run([DESK_JIRA, "api", rest], capture_output=True, text=True, timeout=60, env=self.env)
        except FileNotFoundError:
            raise JiraError("desk-jira not found; run the desk-skills install.sh and set up the Jira token")
        if out.returncode != 0:
            raise JiraError(f"desk-jira api {path}: {' '.join(out.stderr.split())[:300]}")
        return json.loads(out.stdout)

    def changelog(self, key):
        """Every history entry: the endpoint pages oldest-first, so today's are on the last page."""
        values, start = [], 0
        while True:
            page = self.get(f"/rest/api/3/issue/{key}/changelog", startAt=start, maxResults=100)
            values += page.get("values", [])
            start += page.get("maxResults", 100)
            if page.get("isLast", True) or start >= page.get("total", 0):
                return values


def adf_text(node, limit=900):
    """Flatten Atlassian Document Format to plain text."""
    out = []

    def walk(n):
        if isinstance(n, dict):
            if n.get("type") == "text":
                out.append(n.get("text", ""))
            elif n.get("type") in ("mention",):
                out.append((n.get("attrs") or {}).get("text", "@?"))
            for c in n.get("content", []) or []:
                walk(c)
            if n.get("type") in ("paragraph", "listItem", "heading"):
                out.append(" ")
        elif isinstance(n, list):
            for c in n:
                walk(c)

    walk(node)
    text = " ".join("".join(out).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def parse_jira_time(value):
    return datetime.strptime(value[:19] + value[23:], "%Y-%m-%dT%H:%M:%S%z")


def repo_activity(repo, start, end):
    """Print one repo's Jira activity. Returns the (site, key) pairs printed, for de-duplication."""
    jira = Jira(repo.slug)
    me = jira.get("/rest/api/3/myself")
    my_id = me["accountId"]
    project = (repo.get("jira-project") or "").split()[0].strip("`,;\"") if repo.get("jira-project") else ""
    prio = re.search(r"customfield_\d+", repo.get("jira-priority") or "")
    prio_field = prio.group(0) if prio else "priority"

    since, until = start.astimezone(timezone.utc), end.astimezone(timezone.utc)
    s, e = f'"{start:%Y-%m-%d %H:%M}"', f'"{end:%Y-%m-%d %H:%M}"'
    jql = (
        f"(creator = currentUser() AND created >= {s} AND created < {e})"
        f" OR status CHANGED BY currentUser() DURING ({s}, {e})"
        f" OR assignee CHANGED BY currentUser() DURING ({s}, {e})"
        # updatedBy catches edits JQL's CHANGED cannot name, such as custom select fields.
        f' OR issuekey IN updatedBy("{my_id}", {s}, {e})'  # JQL won't nest currentUser() here
        f" OR ((assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser())"
        f" AND updated >= {s} AND updated < {e})"
    )
    if project and project.lower() != "none":
        jql = f"project = {project} AND ({jql})"

    issues, token_next = [], None
    while True:
        params = {"jql": jql, "fields": f"summary,status,assignee,created,creator,labels,{prio_field}", "maxResults": 100}
        if token_next:
            params["nextPageToken"] = token_next
        page = jira.get("/rest/api/3/search/jql", **params)
        issues += page.get("issues", [])
        token_next = page.get("nextPageToken")
        if not token_next or page.get("isLast", True):
            break

    def my_actions(issue):
        key, f = issue["key"], issue["fields"]
        actions = []
        created = parse_jira_time(f["created"])
        if (f.get("creator") or {}).get("accountId") == my_id and since <= created < until:
            actions.append("raised")
        # Net change per field, so an assign-then-unassign during triage reads as nothing.
        first_from, last_to, order, others = {}, {}, [], []
        for h in jira.changelog(key):
            when = parse_jira_time(h["created"])
            if not (since <= when < until):
                continue
            if (h.get("author") or {}).get("accountId") != my_id:
                # On your own tickets, what others did the same day is part of the story.
                who = (h.get("author") or {}).get("displayName", "someone").split()[0]
                for item in h.get("items", []):
                    if item.get("field") == "status":
                        others.append((who, item.get("fromString"), item.get("toString")))
                continue
            for item in h.get("items", []):
                field = item.get("field")
                custom = item.get("fieldtype") == "custom"
                if not ((field in TRACKED) or (custom and field not in UNTRACKED_CUSTOM)):
                    continue
                if field not in first_from:
                    first_from[field] = item.get("fromString")
                    order.append(field)
                last_to[field] = item.get("toString")
        for field in order:
            if first_from[field] != last_to[field]:
                actions.append(f"{field}: {first_from[field] or '—'} → {last_to[field] or '—'}")
        comments = jira.get(f"/rest/api/3/issue/{key}/comment", orderBy="-created", maxResults=50)
        for c in comments.get("comments", []):
            when = parse_jira_time(c["created"])
            if (c.get("author") or {}).get("accountId") == my_id and since <= when < until:
                actions.append("commented: " + adf_text(c.get("body")))
        if actions and others:
            # Net per person: "then Sam: To Do → Done", not three hops.
            net = {}
            for who, frm, to in others:
                net[who] = (net.get(who, (frm, None))[0], to)
            actions += [f"then {who}: {frm} → {to}" for who, (frm, to) in net.items() if frm != to]
        return issue, actions

    def grade(value):
        if isinstance(value, dict):
            return value.get("value") or value.get("name")
        return value if isinstance(value, str) else None

    raised, touched = [], []
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(my_actions, issues))
    for issue, actions in results:
        if not actions:
            continue
        f = issue["fields"]
        row = {
            "key": issue["key"],
            "summary": f["summary"],
            "status": f["status"]["name"],
            "assignee": (f.get("assignee") or {}).get("displayName", "unassigned"),
            "grade": grade(f.get(prio_field)) or "ungraded",
            "labels": f.get("labels") or [],
            "actions": actions,
        }
        (raised if actions[0] == "raised" else touched).append(row)

    scope = "" if repo.scope == "this" else f", {desk_repos.SCOPE_LABELS[repo.scope]}"
    print(f"# Jira activity for {me['displayName']} in {project or repo.slug} ({repo.slug}{scope}), {window.label(start)}\n")
    if not raised and not touched:
        print("No Jira activity in the window.\n")
        return

    def line(r):
        out = [f"- {r['key']} [{r['status']} · {r['assignee']} · {r['grade']}] {r['summary']}"]
        out += [f"    · {a}" for a in r["actions"] if a != "raised"]
        return "\n".join(out)

    if raised:
        # Bulk raises share a label (e.g. an audit); group them so they roll up into one line.
        remaining, groups = list(raised), []
        while remaining:
            counts = {}
            for r in remaining:
                for lab in r["labels"]:
                    if not SEVERITY_LABEL.match(lab):
                        counts[lab] = counts.get(lab, 0) + 1
            top = max(counts.items(), key=lambda kv: kv[1], default=(None, 0))
            if top[1] < 3:
                groups.append(("individually", remaining))
                break
            groups.append((f"label {top[0]}", [r for r in remaining if top[0] in r["labels"]]))
            remaining = [r for r in remaining if top[0] not in r["labels"]]
        print(f"## Raised ({len(raised)})")
        for name, rows in groups:
            print(f"### {name} ({len(rows)})")
            print("\n".join(line(r) for r in sorted(rows, key=lambda r: r["key"])))
        print()
    if touched:
        print(f"## Changed or commented ({len(touched)})")
        print("\n".join(line(r) for r in sorted(touched, key=lambda r: r["key"])))
        print()


def main():
    ap = argparse.ArgumentParser()
    window.add_day_argument(ap)
    desk_repos.add_include_argument(ap)
    args = ap.parse_args()
    start, end = window.resolve(args.day)
    repos, current = desk_repos.load_all(args.include)
    if current is None:
        print("Not inside a git repo: run from the repo the check-out is for.")
        return 1

    notes, seen = [], set()
    targets = sorted((r for r in repos if r.scope in ("this", "side")),
                     key=lambda r: (desk_repos.SCOPE_ORDER[r.scope], r is not current, r.slug))
    for repo in targets:
        if repo.config_path is None:
            notes.append(f"{repo.slug}: no desk config - run /desk-setup")
            continue
        if repo.tracker != "jira":
            notes.append(f"{repo.slug}: §4 Tracker is {repo.tracker or 'unset'} - no Jira to read")
            continue
        ok, note = desk_repos.allowed(repo, "read-own-work")
        if not ok:
            notes.append(note)
            continue
        # Two repos on one Jira project would report the same tickets twice.
        ident = ((repo.get("jira-site") or "").split()[0] if repo.get("jira-site") else "",
                 (repo.get("jira-project") or "").split()[0] if repo.get("jira-project") else repo.slug)
        if ident in seen:
            notes.append(f"{repo.slug}: same Jira project as a repo already reported")
            continue
        seen.add(ident)
        try:
            repo_activity(repo, start, end)
        except JiraError as err:
            notes.append(f"{repo.slug}: {err}")
    others = [r.slug for r in repos if r.scope == "other" and r.tracker == "jira"]
    if others:
        notes.append("not queried (different check-out destination): " + ", ".join(others))
    if notes:
        print("## Jira notes")
        print("\n".join(f"- {n}" for n in notes))


if __name__ == "__main__":
    sys.exit(main())
