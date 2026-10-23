#!/usr/bin/env python3
"""Add, remove and list the Claude Code permission rules /desk-setup writes.

  harness-rules.py add <plan.json>          apply a plan; prints which rules were new. A plan for a
                                            repo's .claude/ also gets the orchestrator-tools entries
                                            (Monitor, mcp__claude-in-chrome__*, ArtifactComments,
                                            ArtifactData, Edit on the repo's session memory dir; the
                                            desk folders ~/.desk-autopilot, ~/.config/desk and
                                            ~/.claude/desk as additionalDirectories with Read on
                                            each, Edit on the first, Edit on the config on ask, and
                                            Read of a *token* file under the config denied)
  harness-rules.py baseline [--check] [--slack-prefix P]... [<plan.json>]
                                            apply the deny-only plan (default
                                            ../references/baseline-deny.json); --check exits 0
                                            if every rule is already in settings.json, 1 if not
  harness-rules.py retire                   drop the RETIRED rules setup recorded and move REOWNED
                                            rules to their new row (add and baseline do this first
                                            too; --check reports them)
  harness-rules.py remove <row> [<row>...]  revoke rows: drop every rule any of them owns
  harness-rules.py remove --all             drop everything setup ever recorded
  harness-rules.py list [--markdown]        the ledger (--markdown: rows for config §3c)
  harness-rules.py unset-default-mode       drop permissions.defaultMode from --settings when it is
                                            dontAsk (backed up first); the ledger is not touched
  harness-rules.py automode <plan.json>     write this repo's auto-mode classifier entries to
                                            --user-settings (autoMode.allow), and scope the named
                                            autoMode.environment entries to this repo

Options (before the command): --settings PATH      (default ~/.claude/settings.json)
                              --ledger PATH        (default ~/.claude/desk/harness-rules.json)
                              --user-settings PATH (default ~/.claude/settings.json; autoMode only)

Where rules may go. A plan that WIDENS access (any `allow` entry, or any `remove_guards`) is written
only to a settings file inside a repo's own `.claude/` directory (<repo root>/.claude/<file>), and
only if git ignores that file there: `git check-ignore` from the repo root, which honours the repo's
.gitignore files, .git/info/exclude and your global excludes. The report names the file that
ignores it; if only .git/info/exclude or your global excludes do, it recommends adding
`.claude/settings.local.json` to the repo's .gitignore so every clone is covered. A tracked or
un-ignored file is refused: an allow rule must never reach git. User-level files
(~/.claude/settings.json, or any path not in a repo's .claude/) take deny and ask rules only, so
the baseline stays user-level; an allow plan aimed at one is refused (exit 2, nothing written).

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
Exit 2 on an unreadable settings.json, ledger or plan, or a refused destination; nothing is written
then. `remove` never creates a settings file: when the file does not exist it says no rule was
removed from it and drops only the ledger records.

A revoke also reaches the worktrees. When `remove` or `retire` changes a repo-level <root>/.claude/<file>, the
same file in every other worktree `git worktree list` shows is checked: a copy that matched the
file byte for byte before the revoke is backed up and replaced with the new file (removed, if the
file was); a copy that differs is left alone and named, for revoking there by hand. A copy that
cannot be read or written is named FAILED, the rest are still done, and `remove` exits 1.

Auto mode. Claude Code reads `autoMode` only from user or managed settings, so a repo's
classifier entries go in ~/.claude/settings.json, each naming its repo ("In owner/name only: …").
`automode` takes a plan of facts, never prose:
  {"repo": "owner/name", "granted": ["pr-merge-green", …], "merge": "--merge",
   "migrate": "<§4 Database migrate>" or null, "scope_environment": ["<exact entry>", …]}
and writes at most two `autoMode.allow` entries from the templates below: pinned merges (owner
pr-merge-green) and migrations through the repo's runner against a local or per-ticket database
(owner db-migrate, present while §4 Database migrate is set). No template covers a deploy, and
`permissions` is never touched. Each entry is recorded in --ledger (the repo's own), so `remove
<row>` with that ledger drops it from --user-settings and leaves other repos' entries alone; an
entry the ledger did not record is never changed. Re-running it with a changed plan swaps an entry
whose text changed and drops one whose condition no longer holds. A `scope_environment` entry
found verbatim in autoMode.environment is prefixed "In <repo> only: ". Creating autoMode.allow
starts it with "$defaults", so the built-in rules stay. An unreadable --user-settings stops it
with nothing written (exit 2); in `remove` it is named FAILED, its entries stay recorded for a
later remove, the permission revoke still runs, and `remove` exits 1.
"""

import datetime
import json
import os
import shutil
import subprocess
import sys
import tempfile

LISTS = ("allow", "ask", "deny")
DIRS = "additionalDirectories"  # a ledger "list" only orchestrator-tools writes; never in a plan
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
    write_bytes(path, (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode())


def read_bytes(path):
    if not os.path.isfile(path):
        return None
    with open(path, "rb") as f:
        return f.read()


def write_bytes(path, raw):
    """Replace the file a path resolves to, so a symlinked settings.json stays a symlink."""
    real = os.path.realpath(path)
    folder = os.path.dirname(real)
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".desk-", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
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


def _git(root, *args):
    try:
        return subprocess.run(["git", "-C", root, *args], capture_output=True, text=True, timeout=10)
    except Exception:  # noqa: BLE001
        return None


def repo_settings_scope(settings_path):
    """(repo root, path relative to it) when the file is <repo root>/.claude/<file>, else None."""
    path = os.path.abspath(os.path.expanduser(settings_path))
    folder = os.path.dirname(path)
    if os.path.basename(folder) != ".claude":
        return None
    user_claude = os.path.join(os.path.expanduser("~"), ".claude")
    if os.path.realpath(folder) == os.path.realpath(user_claude):
        return None  # ~/.claude is user-level even when $HOME is itself a git repo (dotfiles)
    root = os.path.dirname(folder)
    r = _git(root, "rev-parse", "--show-toplevel")
    if not r or r.returncode != 0 or os.path.realpath(r.stdout.strip()) != os.path.realpath(root):
        return None
    return root, os.path.join(".claude", os.path.basename(path))


def check_ignored(root, rel):
    """Die unless git ignores rel in root. Returns a note naming what ignores it."""
    tracked = _git(root, "ls-files", "--error-unmatch", "--", rel)
    if tracked and tracked.returncode == 0:
        die(f"{os.path.join(root, rel)} is tracked by git, so allow rules written there would be "
            "committed; nothing changed. Untrack it and add it to the repo's .gitignore.")
    q = _git(root, "check-ignore", "-q", "--", rel)
    if not q or q.returncode != 0:
        die(f"git does not ignore {rel} in {root}, so allow rules written there could be committed; "
            f"nothing changed. Add `{rel}` to {os.path.join(root, '.gitignore')} and run it again.")
    v = _git(root, "check-ignore", "-v", "--", rel)
    source = (v.stdout.split(":", 1)[0] if v and v.returncode == 0 else "").strip()
    src_abs = os.path.realpath(source if os.path.isabs(source) else os.path.join(root, source))
    inside = src_abs.startswith(os.path.realpath(root) + os.sep)
    info_exclude = source.replace(os.sep, "/").endswith(".git/info/exclude")
    if inside and not info_exclude:
        return f"ignored by the repo's {os.path.relpath(src_abs, os.path.realpath(root))}"
    what = ".git/info/exclude (this clone only)" if info_exclude else f"your global excludes ({source})"
    return (f"ignored only by {what}; recommend adding `{rel}` to {os.path.join(root, '.gitignore')} "
            "so every clone and teammate is covered")


def widens(plan):
    return any(e["list"] in ("allow", DIRS) for e in plan.get("add", [])) or bool(plan.get("remove_guards"))


def check_destination(settings_path, plan):
    """Refuse a widening plan anywhere but an ignored file in a repo's .claude/. Returns a note."""
    if not widens(plan):
        return None
    scope = repo_settings_scope(settings_path)
    if scope is None:
        die(f"{settings_path} is user-level (not in a repo's .claude/), and this plan grants access "
            "(allow rules or removed guards). Grants are per repo: pass --settings "
            "<repo root>/.claude/settings.local.json. Nothing changed.")
    return check_ignored(*scope)


def worktree_copies(settings_path):
    """The same <worktree>/.claude/<file> in every other worktree `git worktree list` shows."""
    scope = repo_settings_scope(settings_path)
    if scope is None:
        return []
    root, rel = scope
    r = _git(root, "worktree", "list", "--porcelain")
    if not r or r.returncode != 0:
        return []
    trees = [line[len("worktree "):] for line in r.stdout.splitlines() if line.startswith("worktree ")]
    return [os.path.join(t, rel) for t in trees if os.path.realpath(t) != os.path.realpath(root)]


def sync_copies(st, before):
    """After a revoke, bring each worktree copy that matched the file before it up to date.

    setup-worktree.sh and desk-setup copy <root>/.claude/settings.local.json into worktrees, so a
    rule revoked only in the main file stays live in every copy. A copy that differs from the main
    file before the revoke is someone's own edit: it is left alone and named. A copy that cannot be
    read or written is named too, and the rest are still checked. Returns True if any copy failed."""
    after = read_bytes(st.settings_path)
    if before is None or after == before:
        return False
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    failed = False
    for copy in worktree_copies(st.settings_path):
        if not os.path.isfile(copy) or os.path.realpath(copy) == os.path.realpath(st.settings_path):
            continue
        try:
            if read_bytes(copy) != before:
                st.log.append(f"differs  {copy}  (did not match {st.settings_path} before the revoke: "
                              "left alone; revoke there by hand)")
                continue
            st.log.append(f"backup   {backup(copy, stamp)}")
            if after is None:
                os.remove(copy)
                st.log.append(f"removed  {copy} (the main file it copied was removed)")
            else:
                write_bytes(copy, after)
                st.log.append(f"synced   {copy}")
        except OSError as e:
            failed = True
            st.log.append(f"FAILED   {copy}  ({e}; it may still allow what was revoked: revoke there by hand)")
    return failed


class State:
    def __init__(self, settings_path, ledger_path, need_settings=True):
        self.settings_path, self.ledger_path = settings_path, ledger_path
        self.ledger, _ = load_json(ledger_path, {})
        if not isinstance(self.ledger, dict):
            die(f"{ledger_path} is not a JSON object; nothing changed")
        self.ledger.setdefault("rules", [])          # [{list, rule, rows, added}]
        self.ledger.setdefault("removed_guards", [])  # [{list, rule, rows, guard_rows, removed}]
        self.ledger.setdefault("created", [])         # keys setup created: "file", "permissions", "permissions.allow"
        self.ledger.setdefault("automode", [])        # [{repo, kind, text, rows, added}] in --user-settings' autoMode.allow
        self.ledger.setdefault("automode_created", [])  # "autoMode", "autoMode.allow" setup created there
        self.log = []
        self.before_ledger = json.dumps(self.ledger, sort_keys=True)
        if not need_settings:
            return
        self.settings, self.settings_existed = load_json(settings_path, {})
        if not isinstance(self.settings, dict):
            die(f"{settings_path} is not a JSON object; nothing changed")
        perm = self.settings.get("permissions")
        if perm is not None and (not isinstance(perm, dict) or
                                 any(not isinstance(perm.get(n, []), list) for n in LISTS + (DIRS,))):
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
        if not self.settings_existed and self.settings != {}:
            self._created("file")
        # Drop containers setup created and nothing else now uses.
        perm = self.settings.get("permissions")
        if isinstance(perm, dict):
            for name in LISTS + (DIRS,):
                if f"permissions.{name}" in self.ledger["created"] and perm.get(name) == []:
                    del perm[name]
                    self.ledger["created"].remove(f"permissions.{name}")
            if "permissions" in self.ledger["created"] and perm == {}:
                del self.settings["permissions"]
                self.ledger["created"].remove("permissions")
        empty = not self.ledger["rules"] and not self.ledger["removed_guards"]
        if not self.settings_existed and self.settings == {}:
            self.ledger["created"] = [k for k in self.ledger["created"] if k != "file"]
        elif empty and "file" in self.ledger["created"] and self.settings == {}:
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
            owners = sorted(set(rec["rows"]) | set(rows))
            if rule in cur and owners == rec["rows"]:
                st.log.append(f"present  {lst:5} {rule}  (recorded for {', '.join(owners)})")
                continue
            if rule not in cur:
                cur.append(rule)
            rec["rows"] = owners
            st.log.append(f"recorded {lst:5} {rule}  (owners now {', '.join(rec['rows'])})")
        elif rule in cur:
            st.log.append(f"present  {lst:5} {rule}  (yours: already in the settings file; not recorded, "
                          "never removed)")
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


# Rules an earlier version of setup wrote and no row writes any more: (list, rule, why it went,
# what a copy the user added themselves still does, the rule that replaces it or None). `add`,
# `baseline` and `retire` drop them when setup recorded them (a copy the user added themselves is
# reported, never touched), so re-running setup or install.sh migrates an existing install. A
# replacement is written in the same list with the dropped record's owners, unless it is there.
UNPINNED = ("no row grants it any more", "it still lets an unpinned merge run unprompted, so remove "
            "it by hand to enforce the pin", None)
ROUTE_ASK = "Bash(desk-jira create *--route*)"
RETIRED = [
    # Merges are pinned with --match-head-commit; these let an unpinned merge run unprompted.
    ("allow", rule, *UNPINNED)
    for m in ("--squash", "--merge", "--rebase")
    for rule in (f"Bash(gh pr merge * {m})", f"Bash(gh pr merge * --auto {m})", f"Bash(gh pr merge * {m} --auto)")
] + [
    # desk-jira create assigns only the user; another assignee needs --route, which keeps prompting.
    # Where jira-assign-self was not granted, no --route ask was ever written, so it replaces this.
    ("ask", "Bash(desk-jira create *assignee*)",
     "desk-jira create assigns only you; routing to someone else needs --route, which still prompts",
     "it still prompts on every desk-jira create that names an assignee; remove it by hand to stop that",
     ROUTE_ASK),
]

# Rules whose owner row changed: (list, rule, old owner, new owner). The --route ask belonged to
# jira-assign-self, so revoking that row would have dropped it while jira-create still allows
# `desk-jira create *`, letting routing run unprompted.
REOWNED = [("ask", ROUTE_ASK, "jira-assign-self", "jira-create")]

# Tools an orchestrator or interactive desk session relies on, written whenever `add` writes a plan
# to a repo: Monitor (waiting on a batch), the Chrome extension's tools, the Artifact tools Claude
# Design canvases are read with, Edit on this repo's session memory directory, and the desk folders
# it works in all day (DESK_FOLDERS).
ORCHESTRATOR = "orchestrator-tools"
ORCHESTRATOR_TOOLS = ["Monitor", "mcp__claude-in-chrome__*", "ArtifactComments", "ArtifactData"]
# The batch state, the desk config and the installed desk scripts: additional directories with Read
# on all three. Edit is allowed under the state folder only (design snapshots land there); an edit to
# the config stays the user's call, since it can widen what workers may do, and the credentials kept
# beside it stay unreadable, as they are to workers.
STATE_FOLDER, CONFIG_FOLDER = "~/.desk-autopilot", "~/.config/desk"
DESK_FOLDERS = [STATE_FOLDER, CONFIG_FOLDER, "~/.claude/desk"]
DESK_FOLDER_RULES = ([("allow", f"Read({d}/**)") for d in DESK_FOLDERS] +
                     [("allow", f"Edit({STATE_FOLDER}/**)"), ("ask", f"Edit({CONFIG_FOLDER}/**)"),
                      ("deny", f"Read({CONFIG_FOLDER}/**/*token*)")])


def memory_dir_rule(root):
    """Edit on <root>'s session memory directory, named as Claude Code names a project
    (desk-env.mjs memoryDir: every character outside [A-Za-z0-9] becomes '-')."""
    slug = "".join(c if c.isascii() and c.isalnum() else "-" for c in root)
    return f"Edit(~/.claude/projects/{slug}/memory/**)"


def orchestrator_entries(settings_path):
    """The orchestrator-tools add entries for a repo-level settings file; none at user level."""
    scope = repo_settings_scope(settings_path)
    if scope is None:
        return []
    top = _git(scope[0], "rev-parse", "--show-toplevel")
    root = top.stdout.strip() if top and top.returncode == 0 else scope[0]
    tools = [("allow", r) for r in ORCHESTRATOR_TOOLS + [memory_dir_rule(root)]]
    dirs = [(DIRS, os.path.expanduser(d)) for d in DESK_FOLDERS]
    return [{"list": lst, "rule": r, "rows": [ORCHESTRATOR]} for lst, r in tools + DESK_FOLDER_RULES + dirs]


def retire(st):
    """Drop retired rules setup recorded; report a copy the user added themselves."""
    for lst, rule, why, yours, repl in RETIRED:
        cur = st.perm_list(lst, create=False) or []
        rec, g = st.recorded(lst, rule), st.unguarded(lst, rule)
        if rec:
            if rule in cur:
                cur.remove(rule)
            st.ledger["rules"].remove(rec)
            st.log.append(f"RETIRED  {lst:5} {rule}  ({why})")
            if repl and repl not in cur and not st.recorded(lst, repl):
                st.perm_list(lst, create=True).append(repl)
                st.ledger["rules"].append({"list": lst, "rule": repl, "rows": rec["rows"],
                                           "added": datetime.date.today().isoformat()})
                st.log.append(f"REPLACED {lst:5} {repl}  (in place of {rule}; {', '.join(rec['rows'])})")
        elif rule in cur:
            st.log.append(f"retired  {lst:5} {rule}  (yours, left alone: {yours})")
        if g:  # a guard setup removed: forget it, so revoking its row never puts it back
            st.ledger["removed_guards"].remove(g)
            st.log.append(f"RETIRED  {lst:5} {rule}  (guard record dropped: {why})")
    for lst, rule, old, new in REOWNED:
        rec = st.recorded(lst, rule)
        if rec and old in rec["rows"]:
            rec["rows"] = sorted((set(rec["rows"]) - {old}) | {new})
            st.log.append(f"REOWNED  {lst:5} {rule}  ({old} -> {new})")


def cmd_add(st, plan_path):
    plan = read_plan(plan_path)
    plan["add"] = plan.get("add", []) + orchestrator_entries(st.settings_path)
    note = check_destination(st.settings_path, plan)
    if note:
        st.log.append(f"gitignore {st.settings_path}: {note}")
    retire(st)
    apply_plan(st, plan)
    st.save()


def cmd_retire(st):
    before = read_bytes(st.settings_path)
    retire(st)
    st.save()
    return sync_copies(st, before)


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
        stale = [(lst, r) for lst, r, *_ in RETIRED if st.recorded(lst, r) or st.unguarded(lst, r)]
        for lst, rule in stale:
            print(f"retired  {lst:5} {rule}  (recorded by setup; baseline drops it)")
        return 1 if missing or stale else 0
    retire(st)
    apply_plan(st, plan)
    st.save()
    return None


def cmd_remove(st, rows, everything, user_settings):
    us, auto_failed = revoke_automode(st, user_settings, rows, everything)
    revoked = set(rows)
    hit = (lambda owners: True) if everything else (lambda owners: bool(revoked & set(owners)))
    missing = not st.settings_existed
    for rec in [r for r in st.ledger["rules"] if hit(r["rows"])]:
        cur = st.perm_list(rec["list"], create=False) or []
        st.ledger["rules"].remove(rec)
        if rec["rule"] in cur:
            cur.remove(rec["rule"])
            st.log.append(f"REMOVED  {rec['list']:5} {rec['rule']}  ({', '.join(rec['rows'])})")
        elif missing:
            st.log.append(f"absent   {rec['list']:5} {rec['rule']}  ({st.settings_path} does not exist: "
                          "nothing removed from it; ledger record dropped)")
        else:
            st.log.append(f"absent   {rec['list']:5} {rec['rule']}  (no longer in {st.settings_path}; "
                          "ledger record dropped)")
    for g in list(st.ledger["removed_guards"]):
        if everything or revoked & set(g["guard_rows"]):
            st.ledger["removed_guards"].remove(g)  # the rule it guarded is gone too
        elif revoked & set(g["rows"]) and missing:
            st.ledger["removed_guards"].remove(g)
            st.log.append(f"absent   {g['list']:5} {g['rule']}  ({st.settings_path} does not exist: "
                          "guard not restored; ledger record dropped)")
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
    if not st.log:
        what = "any recorded rule" if everything else f"a recorded rule owned by {', '.join(rows)}"
        where = f"{st.settings_path} does not exist and the" if missing else "the"
        st.log.append(f"nothing to remove: {where} ledger ({st.ledger_path}) has no {what}")
    if everything or ORCHESTRATOR in revoked:  # the user's own copies of what this row writes
        for e in orchestrator_entries(st.settings_path):
            if e["rule"] in (st.perm_list(e["list"], create=False) or []) and not st.recorded(e["list"], e["rule"]):
                st.log.append(f"kept     {e['list']:5} {e['rule']}  (yours: setup did not add it; left in place)")
    before = read_bytes(st.settings_path)
    if us:
        us.save(st, datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
    st.save()
    return sync_copies(st, before) or auto_failed


def cmd_list(st, markdown):
    rules, guards, auto = st.ledger["rules"], st.ledger["removed_guards"], st.ledger["automode"]
    if markdown:
        print("| Rule | List | Owning rows (revoking any removes it) | Added |")
        print("|---|---|---|---|")
        for r in rules:
            print(f"| `{r['rule']}` | {r['list']} | {', '.join(f'`{x}`' for x in r['rows'])} | {r['added']} |")
        for g in guards:
            print(f"| `{g['rule']}` | {g['list']}, **guard removed** | {', '.join(f'`{x}`' for x in g['rows'])}"
                  f" (restored on revoke) | {g['removed']} |")
        for a in auto:
            print(f"| {a['kind']} entry for `{a['repo']}` | autoMode.allow (user settings) | "
                  f"{', '.join(f'`{x}`' for x in a['rows'])} | {a['added']} |")
        if not rules and not guards and not auto:
            print("| — | — | none yet | — |")
        return
    for r in rules:
        print(f"{r['list']:5} {r['rule']}  <- {', '.join(r['rows'])}")
    for g in guards:
        print(f"unguarded {g['list']} {g['rule']}  <- removed for {', '.join(g['rows'])}")
    for a in auto:
        print(f"autoMode.allow [{a['repo']}] {a['kind']}  <- {', '.join(a['rows'])}")
    if not rules and not guards and not auto:
        print("no rules recorded")


USAGE = ("usage: harness-rules.py [--settings P] [--ledger P] [--user-settings P] add <plan.json> | "
         "baseline [--check] [--slack-prefix P]... [<plan.json>] | retire | remove <row>...|--all | list [--markdown] | "
         "unset-default-mode | automode <plan.json>")


def cmd_unset_default_mode(settings_path):
    """Drop permissions.defaultMode from one file when it is dontAsk. The ledger is not involved:
    setup never sets a mode, it only removes the one that blocks the orchestrator."""
    data, _ = load_json(settings_path, {})
    perm = data.get("permissions") if isinstance(data, dict) else None
    if not isinstance(perm, dict) or perm.get("defaultMode") != "dontAsk":
        print(f"nothing to change: defaultMode is not dontAsk in {settings_path}")
        return 0
    b = backup(settings_path, datetime.datetime.now().strftime("%Y%m%d-%H%M%S"))
    del perm["defaultMode"]
    write_json(settings_path, data)
    print(f"backup   {b}")
    print(f"removed  permissions.defaultMode (dontAsk) from {settings_path}")
    return 0


MERGE_FLAGS = ("--squash", "--merge", "--rebase")


def scope(repo):
    return f"In {repo} only: "


def automode_entries(plan):
    """{kind: (text, rows)} for the entries this plan grants. The only texts setup ever writes."""
    repo, out = plan["repo"], {}
    if "pr-merge-green" in plan.get("granted", []) and plan.get("merge") in MERGE_FLAGS:
        out["merge"] = (
            f"{scope(repo)}merging a pull request once its required checks are green is sanctioned by "
            f"the user (desk-setup row pr-merge-green): the desk merge driver "
            f"(~/.claude/desk/bin/merge-driver.sh) merging it, or `gh pr ready <n>` followed by "
            f"`gh pr merge <n> {plan['merge']} --match-head-commit <sha>`. An unpinned merge, --admin, "
            f"or a merge in any other repo is not covered.", ["pr-merge-green"])
    if plan.get("migrate"):
        out["migrate"] = (
            f"{scope(repo)}running this repo's database migrations with `{plan['migrate']}` against a "
            f"local database or a per-ticket database is sanctioned by the user (desk-setup, §4 Database "
            f"migrate). Migrating a shared, staging or production database, and any production deploy, "
            f"is not covered.", ["db-migrate"])
    return out


class Unreadable(Exception):
    pass


class UserSettings:
    """--user-settings, read only when an autoMode entry is written or revoked. When it is the
    same file as --settings, it works on State's copy and leaves the write to State.save."""

    def __init__(self, path, st=None):
        self.path, self.existed = path, os.path.exists(path)
        self.shared = st is not None and hasattr(st, "settings") and \
            os.path.realpath(path) == os.path.realpath(st.settings_path)
        self.data = st.settings if self.shared else {}
        if self.existed and not self.shared:
            try:
                with open(path) as f:
                    raw = f.read()
                self.data = json.loads(raw) if raw.strip() else {}
            except Exception as e:  # noqa: BLE001
                raise Unreadable(f"{path} could not be read ({e})") from None
        am = self.data.get("autoMode") if isinstance(self.data, dict) else None
        if not isinstance(self.data, dict) or (am is not None and (
                not isinstance(am, dict) or any(not isinstance(am.get(k, []), list)
                                                for k in ("allow", "environment")))):
            raise Unreadable(f"{path} could not be read: its autoMode block is malformed")
        self.before = json.dumps(self.data, sort_keys=True)

    def allow(self, st, create):
        am = self.data.get("autoMode")
        if am is None:
            if not create:
                return None
            am = self.data["autoMode"] = {}
            if "autoMode" not in st.ledger["automode_created"]:
                st.ledger["automode_created"].append("autoMode")
        if "allow" not in am:
            if not create:
                return None
            am["allow"] = ["$defaults"]  # leaving it out would replace the built-in rules
            if "autoMode.allow" not in st.ledger["automode_created"]:
                st.ledger["automode_created"].append("autoMode.allow")
        return am["allow"]

    def save(self, st, stamp):
        """Drop containers setup created that hold nothing of the user's, then write if changed."""
        am = self.data.get("autoMode")
        created = st.ledger["automode_created"]
        if isinstance(am, dict) and "autoMode.allow" in created and am.get("allow") in (["$defaults"], []):
            del am["allow"]
            created.remove("autoMode.allow")
        if isinstance(am, dict) and "autoMode" in created and am == {}:
            del self.data["autoMode"]
            created.remove("autoMode")
        if self.shared or json.dumps(self.data, sort_keys=True) == self.before:
            return
        b = backup(self.path, stamp)
        if b:
            st.log.append(f"backup   {b}")
        write_json(self.path, self.data)


def save_ledger(st, stamp):
    if json.dumps(st.ledger, sort_keys=True) == st.before_ledger:
        return
    b = backup(st.ledger_path, stamp)
    if b:
        st.log.append(f"backup   {b}")
    write_json(st.ledger_path, st.ledger)


def read_automode_plan(plan_path):
    plan, ok = load_json(plan_path, None)
    if not ok or not isinstance(plan, dict):
        die(f"cannot read plan {plan_path}")
    repo = plan.get("repo")
    if not isinstance(repo, str) or repo.count("/") != 1 or any(c.isspace() for c in repo) or "" in repo.split("/"):
        die(f"bad repo in {plan_path}: want owner/name")
    if not isinstance(plan.get("granted", []), list) or not isinstance(plan.get("scope_environment", []), list):
        die(f"bad granted or scope_environment in {plan_path}")
    if plan.get("merge") is not None and plan["merge"] not in MERGE_FLAGS:
        die(f"bad merge in {plan_path}: want one of {', '.join(MERGE_FLAGS)}")
    m = plan.get("migrate")
    if m is not None and (not isinstance(m, str) or "\n" in m or "`" in m):
        die(f"bad migrate in {plan_path}: want the §4 Database migrate command on one line")
    return plan


def drop_automode(st, us, rec):
    """Remove one recorded entry from --user-settings and the ledger."""
    st.ledger["automode"].remove(rec)
    cur = us.allow(st, create=False) or []
    if rec["text"] in cur:
        cur.remove(rec["text"])
        st.log.append(f"REMOVED  autoMode.allow [{rec['repo']}] {rec['kind']}  ({', '.join(rec['rows'])})")
    else:
        st.log.append(f"absent   autoMode.allow [{rec['repo']}] {rec['kind']}  (not in {us.path}; "
                      "ledger record dropped)")


def cmd_automode(st, user_settings, plan_path):
    plan = read_automode_plan(plan_path)
    repo, want = plan["repo"], automode_entries(plan)
    try:
        us = UserSettings(user_settings)
    except Unreadable as e:
        die(f"{e}; no auto-mode entry was written")
    today = datetime.date.today().isoformat()
    for kind in ("merge", "migrate"):
        rec = next((r for r in st.ledger["automode"] if r["repo"] == repo and r["kind"] == kind), None)
        text, rows = want.get(kind, (None, None))
        if rec and rec["text"] != text:
            drop_automode(st, us, rec)
            rec = None
        if text is None:
            continue
        cur = us.allow(st, create=False)
        if rec:
            if text in (cur or []):
                st.log.append(f"present  autoMode.allow [{repo}] {kind}  (recorded for {', '.join(rows)})")
            else:
                us.allow(st, create=True).append(text)
                st.log.append(f"RESTORED autoMode.allow [{repo}] {kind}  ({', '.join(rows)})")
        elif text in (cur or []):
            st.log.append(f"present  autoMode.allow [{repo}] {kind}  (yours: already there; not recorded, "
                          "never removed)")
        else:
            us.allow(st, create=True).append(text)
            st.ledger["automode"].append({"repo": repo, "kind": kind, "text": text, "rows": rows,
                                          "added": today})
            st.log.append(f"NEW      autoMode.allow [{repo}] {kind}  ({', '.join(rows)}): {text}")
    env = (us.data.get("autoMode") or {}).get("environment") or []
    for text in plan.get("scope_environment", []):
        if not isinstance(text, str):
            continue
        if text.startswith(scope(repo)) and text in env or scope(repo) + text in env:
            st.log.append(f"scoped   autoMode.environment  (already names {repo}): {text[:60]}")
        elif text in env:
            env[env.index(text)] = scope(repo) + text
            st.log.append(f"SCOPED   autoMode.environment  now applies only to {repo}: {text[:60]}")
        else:
            st.log.append(f"missing  autoMode.environment  (no entry reads exactly this; nothing changed): {text[:60]}")
    for text in env:
        if isinstance(text, str) and repo in text and not text.startswith("In "):
            st.log.append(f"unscoped autoMode.environment  names {repo} but applies in every repo: {text[:60]}")
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    us.save(st, stamp)
    save_ledger(st, stamp)


def revoke_automode(st, user_settings, rows, everything):
    """`remove`'s part for autoMode entries this ledger recorded: (UserSettings or None, failed).
    An unreadable file keeps the records for a later remove; the permission revoke still runs."""
    revoked = set(rows)
    hits = [r for r in st.ledger["automode"] if everything or revoked & set(r["rows"])]
    if not hits:
        return None, False
    try:
        us = UserSettings(user_settings, st)
    except Unreadable as e:
        for rec in hits:
            st.log.append(f"FAILED   autoMode.allow [{rec['repo']}] {rec['kind']}  ({e}; still in place and "
                          "recorded: fix the file and remove again)")
        return None, True
    for rec in hits:
        drop_automode(st, us, rec)
    return us, False


def main(argv):
    home = os.path.expanduser("~")
    settings = os.path.join(home, ".claude", "settings.json")
    user_settings = settings
    ledger = os.path.join(home, ".claude", "desk", "harness-rules.json")
    args = list(argv)
    while args and args[0] in ("--settings", "--ledger", "--user-settings"):
        if len(args) < 2:
            die("missing value for " + args[0])
        if args[0] == "--settings":
            settings = args[1]
        elif args[0] == "--user-settings":
            user_settings = args[1]
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
    if cmd == "unset-default-mode" and not rest:
        return cmd_unset_default_mode(settings)
    if cmd == "automode" and len(rest) == 1:
        st = State(settings, ledger, need_settings=False)
        cmd_automode(st, user_settings, rest[0])
        print("\n".join(st.log) if st.log else "nothing to change")
        return 0
    st = State(settings, ledger)
    code = 0
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
        checked = cmd_baseline(st, plan, prefixes, check)
        if checked is not None:
            return checked
    elif cmd == "retire" and not rest:
        code = 1 if cmd_retire(st) else 0
    elif cmd == "remove" and rest == ["--all"]:
        code = 1 if cmd_remove(st, [], True, user_settings) else 0
    elif cmd == "remove" and rest and "--all" not in rest:
        code = 1 if cmd_remove(st, rest, False, user_settings) else 0
    else:
        die(USAGE)
    print("\n".join(st.log) if st.log else "nothing to change")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
