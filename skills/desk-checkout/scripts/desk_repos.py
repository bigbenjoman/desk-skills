"""Which repos a check-out covers, read from the per-repo desk configs.

Every repo the user runs desk in has ~/.config/desk/repos/<owner__name>/config.md. Values are read
through desk-env.mjs (`ids`, with DESK_CONFIG pointed at each file), so there is one config parser,
not two. Nothing here names a company, an org, a site or a project.

A check-out is written from inside one repo (the current one). Its scope is:
  this      the current repo, plus every configured repo whose §4 Check-out destination is the same
            (and not none): work the same post reports on
  side      repos in DESK_CHECKOUT_SIDE_REPOS / directories in DESK_CHECKOUT_SIDE_ROOTS
  other     another configured desk repo, with a different check-out destination
  none      anything else: not work for this check-out

Per-repo permissions still apply: a collector reads a repo only when that repo's own §3 row is `yes`,
or `ask` and the user agreed (passed as --include <slug>).
"""
import glob
import os
import re
import shutil
import subprocess

HOME = os.path.expanduser("~")
CONFIG_ROOT = os.path.expanduser(os.environ.get("DESK_CONFIG_ROOT", os.path.join(HOME, ".config", "desk")))
_HERE = os.path.dirname(os.path.abspath(__file__))
_IDS_LINE = re.compile(r'^(get|perm)\s+(\S+)\s+->\s+§[^=]*?=\s(.*)$')

SCOPE_LABELS = {
    "this": "This check-out",
    "side": "Side project",
    "other": "Other desk repo (different check-out)",
    "none": "NOT work for this check-out",
}
SCOPE_ORDER = {"this": 0, "side": 1, "other": 2, "none": 3}


def desk_env_cmd():
    """argv prefix that runs desk-env, or None."""
    for cand in (os.environ.get("DESK_ENV_MJS"),
                 os.path.join(HOME, ".claude", "desk", "bin", "desk-env.mjs"),
                 os.path.normpath(os.path.join(_HERE, "..", "..", "..", "desk", "bin", "desk-env.mjs"))):
        if cand and os.path.isfile(cand) and shutil.which("node"):
            return ["node", cand]
    exe = shutil.which("desk-env")
    return [exe] if exe else None


def _run(argv, env_extra=None, cwd=None):
    env = dict(os.environ)
    env.pop("DESK_CONFIG", None)
    env.update(env_extra or {})
    try:
        out = subprocess.run(argv, capture_output=True, text=True, env=env, cwd=cwd, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None, 1
    return out.stdout, out.returncode


def _expand(p):
    return os.path.realpath(os.path.expanduser(p.strip().rstrip("/"))) if p else None


class Repo:
    def __init__(self, slug, config_path, values, perms):
        self.slug = slug
        self.config_path = config_path
        self.values = values
        self.perms = perms
        self.scope = "none"

    def get(self, key):
        v = self.values.get(key)
        return None if v in (None, "", "(unset)") else v

    def perm(self, key):
        return self.perms.get(key, "no")

    @property
    def gh_repo(self):
        v = self.get("gh-repo")
        if v:
            return v
        owner, _, name = self.slug.partition("__")
        return f"{owner}/{name}" if name and owner != "local" else None

    @property
    def roots(self):
        """The main checkout and the worktrees directory, as real paths."""
        out = []
        root = self.get("repo-root")
        if root and root != "none":
            out.append(_expand(root))
            wt = self.get("worktrees-dir")
            out.append(_expand(wt) if wt and wt != "none" else _expand(root) + "-worktrees")
        return tuple(out)

    @property
    def tracker(self):
        return (self.get("tracker") or "").split()[0].lower() if self.get("tracker") else None

    @property
    def ticket_regex(self):
        pat = self.get("ticket-pattern")
        if not pat or pat.lower() == "none" or self.tracker == "none":
            return None
        try:
            return re.compile(r"\b(?:" + pat + r")\b")
        except re.error:
            return None

    @property
    def destination(self):
        d = (self.get("checkout-destination") or "").strip()
        return None if not d or d.lower() == "none" else d


def _load(config_path, slug):
    cmd = desk_env_cmd()
    values, perms = {}, {}
    if cmd:
        out, _ = _run(cmd + ["ids"], {"DESK_CONFIG": config_path, "DESK_SLUG": slug})
        for line in (out or "").splitlines():
            m = _IDS_LINE.match(line.strip())
            if m:
                (perms if m.group(1) == "perm" else values)[m.group(2)] = m.group(3).strip()
    return Repo(slug, config_path, values, perms)


def current_repo_info():
    """(slug, owner/repo, toplevel) of the cwd's repo, from desk-env where; Nones outside a repo."""
    cmd = desk_env_cmd()
    slug = gh = None
    if cmd:
        out, _ = _run(cmd + ["where"])
        for line in (out or "").splitlines():
            k, _, v = line.partition("=")
            v = v.strip().strip("'")
            if k == "SLUG":
                slug = v or None
            elif k == "GH_REPO":
                gh = v or None
    top, rc = _run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"])
    toplevel = os.path.dirname(top.strip()) if rc == 0 and top and top.strip() else None
    return slug, gh, (os.path.realpath(toplevel) if toplevel else None)


def load_all(include=()):
    """Every configured repo, with .scope set relative to the current repo.

    Returns (repos, current) where current is the Repo for the cwd (possibly unconfigured: a Repo
    with no values, so the check-out still covers the repo it was asked from).
    """
    include = set(include or ())
    cur_slug, cur_gh, cur_top = current_repo_info()
    repos = {}
    for path in sorted(glob.glob(os.path.join(CONFIG_ROOT, "repos", "*", "config.md"))):
        slug = os.path.basename(os.path.dirname(path))
        repos[slug] = _load(path, slug)
    current = repos.get(cur_slug) if cur_slug else None
    if cur_slug and current is None:
        current = Repo(cur_slug, None, {"gh-repo": cur_gh or ""}, {})
        repos[cur_slug] = current
    if current is not None and cur_top:
        current._toplevel = cur_top
    side_repos = {r.strip().lower() for r in os.environ.get("DESK_CHECKOUT_SIDE_REPOS", "").split(",") if r.strip()}
    dest = current.destination if current else None
    for r in repos.values():
        if r is current:
            r.scope = "this"
        elif (r.gh_repo or "").lower() in side_repos:
            r.scope = "side"
        elif dest and r.destination == dest:
            r.scope = "this"
        else:
            r.scope = "other"
        r.included_by_user = r.slug in include
    return list(repos.values()), current


def side_roots():
    return tuple(_expand(p) for p in os.environ.get("DESK_CHECKOUT_SIDE_ROOTS", "").split(",") if p.strip())


def under(path, roots):
    return any(r and (path == r or path.startswith(r + os.sep)) for r in roots)


def repo_for_path(cwd, repos, current):
    """The configured repo a directory belongs to, or None."""
    if not cwd:
        return None
    real = os.path.realpath(cwd)
    for r in repos:
        roots = r.roots + ((getattr(r, "_toplevel", None),) if getattr(r, "_toplevel", None) else ())
        if roots and under(real, roots):
            return r
    return None


def scope_for_repo_name(gh_repo, repos):
    """Scope of an owner/repo string, for GitHub rows."""
    name = (gh_repo or "").lower()
    side = {r.strip().lower() for r in os.environ.get("DESK_CHECKOUT_SIDE_REPOS", "").split(",") if r.strip()}
    for r in repos:
        if (r.gh_repo or "").lower() == name:
            return r.scope, r
    return ("side" if name in side else "none"), None


def allowed(repo, perm_key):
    """(ok, note). `yes`, or `ask` the user agreed to via --include, reads; anything else is skipped."""
    if repo is None:
        return True, ""
    if repo.config_path is None:
        return True, ""  # the cwd's repo with no config: the skill already stopped for /desk-setup
    v = repo.perm(perm_key)
    if v == "yes" or (v == "ask" and getattr(repo, "included_by_user", False)):
        return True, ""
    if v == "ask":
        return False, f"{repo.slug}: §3 {perm_key} is ask - pass --include {repo.slug} once the user agrees"
    return False, f"{repo.slug}: §3 {perm_key} is {v} - skipped"


def add_include_argument(parser):
    parser.add_argument("--include", action="append", default=[], metavar="SLUG",
                        help="read a repo whose §3 row is `ask`, after the user agreed (repeatable)")
