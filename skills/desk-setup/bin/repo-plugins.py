#!/usr/bin/env python3
"""Which of the user's plugins a repo needs, and switching the rest off for that repo only.

  repo-plugins.py --root <repo> suggest             JSON: each repo-specific plugin enabled at user
                                                    level, its skill count, keep/off and the evidence
  repo-plugins.py --root <repo> apply --off a,b [--on c,d]
                                                    write enabledPlugins false (or remove our false, for
                                                    --on) in <repo>/.claude/settings.local.json

Why: Claude Code lists every enabled plugin's skills on every turn, and plugin skills cannot be
listed by name only (skillOverrides does not reach them), so a repo that never touches Stripe
still pays for Stripe's skills, and look-alike skills (40 vercel:*) are the main cause of wrong
picks in large skill libraries. Settings precedence is user < project < local, so a false here
wins over the user-level true. Only plugins whose relevance a repo's own files can show are
suggested; general ones (codex for desk-review, playwright for screenshots, review and process
plugins) are never touched here.

Like harness-rules.py, it writes only a settings.local.json that git ignores in this repo (exit 2
otherwise, nothing written), and backs the file up first. Exit 0 done, 2 refused or unreadable.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HOME = os.path.expanduser("~")


def sh(root, *args):
    try:
        return subprocess.run(args, cwd=root, capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None


def tracked_text(root, pattern):
    """True if any tracked file (bounded) matches the regex: git grep, so ignored and vendored trees are skipped."""
    r = sh(root, "git", "grep", "-I", "-l", "-E", "-i", "--max-count=1", pattern, "--", ".", ":!*.lock", ":!*lock.json", ":!*lock.yaml")
    return bool(r and r.returncode == 0 and r.stdout.strip())


def has_file(root, *names):
    r = sh(root, "git", "ls-files", "--", *[f"*{n}" for n in names])
    return bool(r and r.stdout.strip())


def manifests_mention(root, word):
    """A dependency named in package.json / pyproject / requirements anywhere in the repo."""
    r = sh(root, "git", "ls-files", "--", "*package.json", "*pyproject.toml", "*requirements*.txt")
    for f in (r.stdout.split() if r else []):
        try:
            if re.search(rf'["\'\s^]{re.escape(word)}', open(os.path.join(root, f), errors="replace").read(), re.M):
                return True
        except OSError:
            pass
    return False


def contract_files(root):
    r = sh(root, "git", "ls-files")
    return any(re.search(r"(^|/)(contracts?|matters?)/|(nda|msa|dpa|agreement|contract)[^/]*\.(docx?|pdf)$", f, re.I)
               for f in (r.stdout.splitlines() if r else []))


def desk_tracker():
    r = subprocess.run(["desk-env", "get", "tracker"], capture_output=True, text=True)
    return (r.stdout or "").strip().lower()


# plugin name -> (why it would matter, test of this repo's own files)
SIGNALS = {
    "vercel": ("deploys on Vercel or uses Next.js",
               lambda root: has_file(root, "vercel.json") or os.path.isdir(os.path.join(root, ".vercel"))
               or manifests_mention(root, "next")),
    "stripe": ("takes payments with Stripe", lambda root: manifests_mention(root, "stripe")),
    "figma": ("implements Figma designs", lambda root: tracked_text(root, r"figma\.com/(file|design)/")),
    # Contract documents, not a product's own terms page (which says "indemnify" too).
    "commercial-legal": ("holds contracts to review", lambda root: contract_files(root)),
    "privacy-legal": ("handles privacy compliance work", lambda root: tracked_text(root, r"\b(DPIA|data processing agreement|DSAR)\b")),
    "atlassian": ("tracks work in Jira", lambda root: desk_tracker() == "jira"),
    "typesafe": ("calls TypeSafe / Jev", lambda root: manifests_mention(root, "typesafe") or manifests_mention(root, "@typesafe-ai")),
}


def user_plugins():
    try:
        enabled = json.load(open(os.path.join(HOME, ".claude", "settings.json"))).get("enabledPlugins") or {}
    except (OSError, ValueError):
        enabled = {}
    try:
        installs = json.load(open(os.path.join(HOME, ".claude", "plugins", "installed_plugins.json")))["plugins"]
    except (OSError, ValueError, KeyError):
        installs = {}
    out = {}
    for pid, on in enabled.items():
        if on in (None, False):
            continue
        path = (installs.get(pid) or [{}])[0].get("installPath", "")
        skills = os.path.join(path, "skills")
        n = sum(1 for d in os.listdir(skills) if os.path.isfile(os.path.join(skills, d, "SKILL.md"))) if os.path.isdir(skills) else 0
        out[pid] = n
    return out


def local_settings(root):
    return os.path.join(root, ".claude", "settings.local.json")


def ignored(root, path):
    rel = os.path.relpath(path, root)
    tracked = sh(root, "git", "ls-files", "--error-unmatch", rel)
    if tracked and tracked.returncode == 0:
        return False
    r = sh(root, "git", "check-ignore", "-q", rel)
    return bool(r and r.returncode == 0)


def write_json(path, data):
    real = os.path.realpath(path)
    os.makedirs(os.path.dirname(real), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".desk-", suffix=".tmp", dir=os.path.dirname(real))
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    if os.path.exists(real):
        shutil.copymode(real, tmp)
    os.replace(tmp, real)


def main(argv):
    if "--root" not in argv or len(argv) < 3:
        print(__doc__.strip())
        return 2
    root = os.path.realpath(argv[argv.index("--root") + 1])
    cmd = [a for i, a in enumerate(argv) if not a.startswith("--") and argv[i - 1] not in ("--root", "--off", "--on")]
    path = local_settings(root)
    try:
        current = json.load(open(path)) if os.path.exists(path) else {}
    except (OSError, ValueError):
        print(f"{path} is not valid JSON", file=sys.stderr)
        return 2
    local = current.get("enabledPlugins") or {}

    if cmd[:1] == ["suggest"]:
        rows = []
        for pid, n in sorted(user_plugins().items()):
            name = pid.split("@")[0]
            if name not in SIGNALS:
                continue
            why, test = SIGNALS[name]
            seen = bool(test(root))
            rows.append({"plugin": pid, "skills": n, "suggest": "keep" if seen else "off",
                         "evidence": f"this repo {why}" if seen else f"nothing shows this repo {why}",
                         "now": "off here" if local.get(pid) is False else "on"})
        print(json.dumps(rows, indent=1))
        return 0

    if cmd[:1] == ["apply"]:
        off = [p for p in (argv[argv.index("--off") + 1].split(",") if "--off" in argv else []) if p]
        on = [p for p in (argv[argv.index("--on") + 1].split(",") if "--on" in argv else []) if p]
        if not ignored(root, path):
            print(f"refused: {os.path.relpath(path, root)} is tracked or not git-ignored in this repo; "
                  "add `.claude/settings.local.json` to .gitignore first", file=sys.stderr)
            return 2
        if os.path.exists(path):
            backup = f"{path}.bak-desk-{time.strftime('%Y%m%d-%H%M%S')}"
            shutil.copy2(path, backup)
            print(f"backup: {backup}")
        for p in off:
            local[p] = False
        for p in on:
            if local.get(p) is False:
                del local[p]   # back to whatever the user level says
        if local:
            current["enabledPlugins"] = local
        else:
            current.pop("enabledPlugins", None)
        write_json(path, current)
        print(f"off in this repo: {', '.join(sorted(p for p, v in local.items() if v is False)) or 'none'}")
        return 0

    print(__doc__.strip())
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
