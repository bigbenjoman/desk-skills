#!/usr/bin/env python3
"""Add, remove and list the Claude Code permission rules /desk-setup writes.

  harness-rules.py add <plan.json>          apply a plan; prints which rules were new
  harness-rules.py baseline [--check] [--slack-prefix P]... [<plan.json>]
                                            apply the deny-only plan (default
                                            ../references/baseline-deny.json); --check exits 0
                                            if every rule is already in settings.json, 1 if not
  harness-rules.py remove <row> [<row>...]  revoke rows: drop every rule any of them owns
  harness-rules.py remove --all             drop everything setup ever recorded
  harness-rules.py list [--markdown]        the ledger (--markdown: rows for config §3c)

Options (before the command): --settings PATH (default ~/.claude/settings.json)
                              --ledger PATH   (default ~/.claude/desk/harness-rules.json)

Plan shape:
  {"add":           [{"list": "allow|ask|deny", "rule": "Bash(gh pr ready *)", "rows": ["pr-ready"]}],
   "remove_guards": [{"list": "ask", "rule": "Bash(gh pr merge *--auto*)", "rows": ["pr-auto-merge"]}]}

`rows` on an add entry are its owners: the rule exists only while every one is granted, so
revoking any of them removes it. A rule already in settings.json that the ledger did not add is
the user's own: it is left alone and never recorded. A guard is removed only if setup added it,
stays removed when a plan re-adds it, and is put back once when the row that removed it is
revoked. A baseline plan may hold only deny entries; `<slack>` in a rule expands to
mcp__claude_ai_Slack__ and each --slack-prefix. Re-applying any plan is a no-op. Every write backs
up settings.json and the ledger first, and writes through a symlink with the file's mode kept.
Exit 2 on an unreadable settings.json, ledger or plan; nothing is written then.
"""

import datetime
import json
import os
import shutil
import sys
import tempfile

LISTS = ("allow", "ask", "deny")
SLACK_PREFIX = "mcp__claude_ai_Slack__"
BASELINE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "references", "baseline-deny.json")


def die(msg, code=2):
    print(f"harness-rules: {msg}", file=sys.stderr)
    sys.exit(code)


def load_json(path, default):
    if not os.path.exists(path):
        return default, False
    try:
        with open(path) as f:
            raw = f.read()
        return (json.loads(raw) if raw.strip() else default), True
    except Exception as e:  # noqa: BLE001
        die(f"{path} is not valid JSON ({e}); nothing changed")


def backup(path, stamp):
    if os.path.exists(path):
        dest, n = f"{path}.bak-desk-{stamp}", 1
        while os.path.exists(dest):  # never overwrite an earlier backup from the same second
            dest, n = f"{path}.bak-desk-{stamp}-{n}", n + 1
        shutil.copy2(path, dest)
        return dest
    return None


def write_json(path, data):
    """Replace the file a path resolves to, so a symlinked settings.json stays a symlink."""
    real = os.path.realpath(path)
    folder = os.path.dirname(real)
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".desk-", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        if os.path.exists(real):
            shutil.copymode(real, tmp)
        else:
            mask = os.umask(0)
            os.umask(mask)
            os.chmod(tmp, 0o666 & ~mask)
        os.replace(tmp, real)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


class State:
    def __init__(self, settings_path, ledger_path, need_settings=True):
        self.settings_path, self.ledger_path = settings_path, ledger_path
        self.ledger, _ = load_json(ledger_path, {})
        if not isinstance(self.ledger, dict):
            die(f"{ledger_path} is not a JSON object; nothing changed")
        self.ledger.setdefault("rules", [])          # [{list, rule, rows, added}]
        self.ledger.setdefault("removed_guards", [])  # [{list, rule, rows, guard_rows, removed}]
        self.ledger.setdefault("created", [])         # keys setup created: "file", "permissions", "permissions.allow"
        self.log = []
        self.before_ledger = json.dumps(self.ledger, sort_keys=True)
        if not need_settings:
            return
        self.settings, self.settings_existed = load_json(settings_path, {})
        if not isinstance(self.settings, dict):
            die(f"{settings_path} is not a JSON object; nothing changed")
        perm = self.settings.get("permissions")
        if perm is not None and (not isinstance(perm, dict) or
                                 any(not isinstance(perm.get(n, []), list) for n in LISTS)):
            die(f"{settings_path} has a malformed permissions block; nothing changed")
        self.before_settings = json.dumps(self.settings, sort_keys=True) if self.settings_existed else None

    # settings helpers
    def perm_list(self, name, create):
        perm = self.settings.get("permissions")
        if perm is None:
            if not create:
                return None
            perm = self.settings["permissions"] = {}
            self._created("permissions")
        if name not in perm:
            if not create:
                return None
            perm[name] = []
            self._created(f"permissions.{name}")
        return perm[name]

    def _created(self, key):
        if key not in self.ledger["created"]:
            self.ledger["created"].append(key)

    def recorded(self, lst, rule):
        return next((r for r in self.ledger["rules"] if r["list"] == lst and r["rule"] == rule), None)

    def unguarded(self, lst, rule):
        return next((g for g in self.ledger["removed_guards"] if g["list"] == lst and g["rule"] == rule), None)

    def save(self):
        if json.dumps(self.settings, sort_keys=True) == self.before_settings and \
                json.dumps(self.ledger, sort_keys=True) == self.before_ledger:
            return  # nothing changed: no backup, no write
        stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
        for p in (self.settings_path, self.ledger_path):
            b = backup(p, stamp)
            if b:
                self.log.append(f"backup   {b}")
        if not self.settings_existed:
            self._created("file")
        # Drop containers setup created and nothing else now uses.
        perm = self.settings.get("permissions")
        if isinstance(perm, dict):
            for name in LISTS:
                if f"permissions.{name}" in self.ledger["created"] and perm.get(name) == []:
                    del perm[name]
                    self.ledger["created"].remove(f"permissions.{name}")
            if "permissions" in self.ledger["created"] and perm == {}:
                del self.settings["permissions"]
                self.ledger["created"].remove("permissions")
        empty = not self.ledger["rules"] and not self.ledger["removed_guards"]
        if empty and "file" in self.ledger["created"] and self.settings == {}:
            if os.path.exists(self.settings_path):
                os.remove(self.settings_path)
            self.log.append(f"removed  {self.settings_path} (setup had created it)")
        else:
            write_json(self.settings_path, self.settings)
        if empty:
            self.ledger["created"] = [k for k in self.ledger["created"] if k != "file"] if os.path.exists(self.settings_path) else []
        write_json(self.ledger_path, self.ledger)


def read_plan(plan_path):
    plan, ok = load_json(plan_path, None)
    if not ok or not isinstance(plan, dict):
        die(f"cannot read plan {plan_path}")
    for key in ("add", "remove_guards"):
        entries = plan.get(key, [])
        if not isinstance(entries, list) or any(
                not isinstance(e, dict) or e.get("list") not in LISTS or not isinstance(e.get("rule"), str)
                or not isinstance(e.get("rows"), list) or not e["rows"] for e in entries):
            die(f"bad {key} entry in {plan_path}")
    return plan


def apply_plan(st, plan):
    today = datetime.date.today().isoformat()
    for e in plan.get("add", []):
        lst, rule, rows = e["list"], e["rule"], sorted(set(e["rows"]))
        g = st.unguarded(lst, rule)
        if g:  # a guard a granted row removed: keep it removed, remember the new owners for revoke
            g["guard_rows"] = sorted(set(g["guard_rows"]) | set(rows))
            st.log.append(f"unguarded {lst:5} {rule}  (kept removed for {', '.join(g['rows'])})")
            continue
        cur = st.perm_list(lst, create=True)
        rec = st.recorded(lst, rule)
        if rec:
            if rule not in cur:
                cur.append(rule)
            rec["rows"] = sorted(set(rec["rows"]) | set(rows))
            st.log.append(f"recorded {lst:5} {rule}  (owners now {', '.join(rec['rows'])})")
        elif rule in cur:
            st.log.append(f"yours    {lst:5} {rule}  (already in settings.json; not recorded, never removed)")
        else:
            cur.append(rule)
            st.ledger["rules"].append({"list": lst, "rule": rule, "rows": rows, "added": today})
            st.log.append(f"NEW      {lst:5} {rule}  ({', '.join(rows)})")
    for e in plan.get("remove_guards", []):
        lst, rule, rows = e["list"], e["rule"], sorted(set(e["rows"]))
        g = st.unguarded(lst, rule)
        if g:
            g["rows"] = sorted(set(g["rows"]) | set(rows))
            st.log.append(f"unguarded {lst:5} {rule}  (already removed; for {', '.join(g['rows'])})")
            continue
        rec = st.recorded(lst, rule)
        cur = st.perm_list(lst, create=False) or []
        if rec is None:
            note = "yours: left in place" if rule in cur else "not present"
            st.log.append(f"guard    {lst:5} {rule}  ({note})")
            continue
        if rule in cur:
            cur.remove(rule)
        st.ledger["rules"].remove(rec)
        st.ledger["removed_guards"].append(
            {"list": lst, "rule": rule, "rows": rows, "guard_rows": rec["rows"], "removed": today})
        st.log.append(f"UNGUARD  {lst:5} {rule}  (removed for {', '.join(rows)}; back on revoke)")


def cmd_add(st, plan_path):
    apply_plan(st, read_plan(plan_path))
    st.save()


def baseline_plan(plan_path, prefixes):
    plan = read_plan(plan_path)
    if plan.get("remove_guards") or any(e["list"] != "deny" for e in plan.get("add", [])):
        die(f"{plan_path} is not deny-only; nothing changed")
    entries = []
    for e in plan.get("add", []):
        expanded = [e["rule"].replace("<slack>", p) for p in prefixes] if "<slack>" in e["rule"] else [e["rule"]]
        entries += [{"list": "deny", "rule": r, "rows": e["rows"]} for r in expanded]
    return {"add": entries}


def cmd_baseline(st, plan_path, prefixes, check):
    plan = baseline_plan(plan_path, prefixes)
    if check:
        deny = st.perm_list("deny", create=False) or []
        missing = [e["rule"] for e in plan["add"] if e["rule"] not in deny]
        for rule in missing:
            print(f"missing  deny  {rule}")
        return 1 if missing else 0
    apply_plan(st, plan)
    st.save()
    return None


def cmd_remove(st, rows, everything):
    revoked = set(rows)
    hit = (lambda owners: True) if everything else (lambda owners: bool(revoked & set(owners)))
    for rec in [r for r in st.ledger["rules"] if hit(r["rows"])]:
        cur = st.perm_list(rec["list"], create=False) or []
        if rec["rule"] in cur:
            cur.remove(rec["rule"])
        st.ledger["rules"].remove(rec)
        st.log.append(f"REMOVED  {rec['list']:5} {rec['rule']}  ({', '.join(rec['rows'])})")
    for g in list(st.ledger["removed_guards"]):
        if everything or revoked & set(g["guard_rows"]):
            st.ledger["removed_guards"].remove(g)  # the rule it guarded is gone too
        elif revoked & set(g["rows"]):
            st.ledger["removed_guards"].remove(g)
            cur = st.perm_list(g["list"], create=True)
            if g["rule"] not in cur:
                cur.append(g["rule"])
            rec = st.recorded(g["list"], g["rule"])
            if rec:
                rec["rows"] = sorted(set(rec["rows"]) | set(g["guard_rows"]))
            else:
                st.ledger["rules"].append({"list": g["list"], "rule": g["rule"], "rows": g["guard_rows"],
                                           "added": datetime.date.today().isoformat()})
            st.log.append(f"REGUARD  {g['list']:5} {g['rule']}  ({', '.join(g['guard_rows'])})")
    st.save()


def cmd_list(st, markdown):
    rules, guards = st.ledger["rules"], st.ledger["removed_guards"]
    if markdown:
        print("| Rule | List | Owning rows (revoking any removes it) | Added |")
        print("|---|---|---|---|")
        for r in rules:
            print(f"| `{r['rule']}` | {r['list']} | {', '.join(f'`{x}`' for x in r['rows'])} | {r['added']} |")
        for g in guards:
            print(f"| `{g['rule']}` | {g['list']}, **guard removed** | {', '.join(f'`{x}`' for x in g['rows'])}"
                  f" (restored on revoke) | {g['removed']} |")
        if not rules and not guards:
            print("| — | — | none yet | — |")
        return
    for r in rules:
        print(f"{r['list']:5} {r['rule']}  <- {', '.join(r['rows'])}")
    for g in guards:
        print(f"unguarded {g['list']} {g['rule']}  <- removed for {', '.join(g['rows'])}")
    if not rules and not guards:
        print("no rules recorded")


USAGE = ("usage: harness-rules.py [--settings P] [--ledger P] add <plan.json> | "
         "baseline [--check] [--slack-prefix P]... [<plan.json>] | remove <row>...|--all | list [--markdown]")


def main(argv):
    home = os.path.expanduser("~")
    settings = os.path.join(home, ".claude", "settings.json")
    ledger = os.path.join(home, ".claude", "desk", "harness-rules.json")
    args = list(argv)
    while args and args[0] in ("--settings", "--ledger"):
        if len(args) < 2:
            die("missing value for " + args[0])
        if args[0] == "--settings":
            settings = args[1]
        else:
            ledger = args[1]
        args = args[2:]
    if not args or args[0] in ("-h", "--help"):
        print(__doc__)
        return 0 if args else 2
    cmd, rest = args[0], args[1:]
    if cmd == "list" and rest in ([], ["--markdown"]):
        cmd_list(State(settings, ledger, need_settings=False), bool(rest))
        return 0
    st = State(settings, ledger)
    if cmd == "add" and len(rest) == 1:
        cmd_add(st, rest[0])
    elif cmd == "baseline":
        check, prefixes, plan = False, [SLACK_PREFIX], BASELINE
        while rest:
            if rest[0] == "--check":
                check, rest = True, rest[1:]
            elif rest[0] == "--slack-prefix" and len(rest) > 1:
                if rest[1] not in prefixes:
                    prefixes.append(rest[1])
                rest = rest[2:]
            elif len(rest) == 1 and not rest[0].startswith("-"):
                plan, rest = rest[0], []
            else:
                die(USAGE)
        code = cmd_baseline(st, plan, prefixes, check)
        if code is not None:
            return code
    elif cmd == "remove" and rest == ["--all"]:
        cmd_remove(st, [], True)
    elif cmd == "remove" and rest and "--all" not in rest:
        cmd_remove(st, rest, False)
    else:
        die(USAGE)
    print("\n".join(st.log) if st.log else "nothing to change")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
