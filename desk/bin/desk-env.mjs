#!/usr/bin/env node
// Shared resolver for the desk/bin scripts: one place that turns "who am I, where is the repo,
// what am I allowed to do" into values, so no script hardcodes a person or a machine.
//
// Config is PER REPO: ~/.config/desk/repos/<slug>/config.md, where <slug> is `owner__name` of the
// origin remote of the repo the process runs in (DESK_REPO_DIR, else the cwd). Every worktree of a
// repo shares the remote, so they share one config. DESK_CONFIG overrides the lookup outright.
//
// Resolution order for every value: environment variable -> this repo's config -> default.
// Anything identity-shaped (GitHub handle, Jira name, repo root) has NO default and fails loudly:
// a guessed handle sends work to the wrong place silently.
//
// Also the portable OS helpers the scripts share (memory, uuid, ports), so Linux, WSL and macOS
// differ in exactly one file.
//
// CLI (used by desk-env.sh, so there is one markdown parser, not two):
//   node desk-env.mjs where                   print SLUG=, GH_REPO=, CONFIG=, CREDS=, EXISTS= for the cwd's repo
//   node desk-env.mjs get <config id>         print the value (CONFIG_ROWS; first item), exit 3 if unset
//   node desk-env.mjs list <config id>        print every item of a list row, one per line, exit 3 if unset
//   node desk-env.mjs cmds <config id>        print each command item as DIR<TAB>CMD (nothing for `none`)
//   node desk-env.mjs perm-or-unset <id>      as perm, but exit 3 (no output) when the row is unset
//   node desk-env.mjs ticket-kind <id>        print tracker|work-id|issue|slug, exit 2 if the id is not accepted
//   node desk-env.mjs perm <permission id>    print yes|ask|no|never|stop (PERMISSION_KEYS; unset -> no)
//   node desk-env.mjs key <permission id>     print the §3 key it maps to
//   node desk-env.mjs budget worker|batch     print USD or none; exit 4 if malformed
//   node desk-env.mjs ids                     print every id, the row it maps to, and its value
//   node desk-env.mjs paths                   print KEY=value lines for the shell
//   node desk-env.mjs identity                print GITHUB_HANDLE= and JIRA_NAME= (fails if unset)
//   node desk-env.mjs mem <avail|used|rss|status>
//   node desk-env.mjs uuid
//   node desk-env.mjs port-in-use <port>      exit 0 if something is listening
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { homedir, platform, totalmem, freemem, release } from 'node:os';
import { basename, dirname, join } from 'node:path';
import net from 'node:net';

export const HOME = process.env.HOME || homedir();
export const expandHome = (p) => (typeof p === 'string' ? p.replace(/^~(?=\/|$)/, HOME) : p);

// ---- which repo, which config --------------------------------------------------------------
export const deskConfigRoot = () => expandHome(process.env.DESK_CONFIG_ROOT ?? join(HOME, '.config', 'desk'));

const git = (dir, ...args) => {
  try { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
};

// `owner/name` from any git remote URL: https://host/owner/name(.git)(/), git@host:owner/name.git,
// ssh://git@host:443/owner/name.git, and ssh host aliases such as git@github-work:owner/name.git.
// The host is deliberately ignored: an alias hides it, and the last two path segments are the repo.
// Returns null for anything that does not end in owner/name.
export function ownerRepoFromUrl(url) {
  const u = String(url ?? '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const m = /(?:^[a-z][a-z0-9+.-]*:\/\/[^/]+\/|^[^@\s/]+@[^:\s/]+:|^[^:\s/]+:(?!\/))(?:.*\/)?([^/\s:]+)\/([^/\s:]+)$/i.exec(u);
  return m ? `${m[1]}/${m[2]}` : null;
}

// GitHub owner and repo names are case-insensitive, so the slug is lower-case: two clones spelled
// differently must find one config, on a case-sensitive filesystem as well as on macOS.
export const slugOf = (ownerRepo) => ownerRepo.toLowerCase().replace('/', '__');

// The repo this process works in. Slug is `owner__name` of the origin remote. A repo with no usable
// origin falls back to `local__<main checkout dir name>-<hash of its path>`, so two unrelated remote-less
// repos with the same folder name never share a config. DESK_REPO_OVERRIDE (`owner/name`) forces a
// repo for tests; it is deliberately not a name any desk script exports, so it cannot leak into a
// child process and silently switch repos.
let repoCache = null;
export function currentRepo() {
  if (repoCache) return repoCache;
  const dir = expandHome(process.env.DESK_REPO_DIR ?? process.cwd());
  const ownerRepo = process.env.DESK_REPO_OVERRIDE || ownerRepoFromUrl(git(dir, 'remote', 'get-url', 'origin'));
  let slug = null;
  if (ownerRepo) slug = slugOf(ownerRepo);
  else {
    const common = git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    if (common) {
      const root = dirname(common);
      slug = `local__${basename(root).toLowerCase()}-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`;
    }
  }
  repoCache = { dir, ownerRepo, slug };
  return repoCache;
}

export const repoConfigDir = (slug = currentRepo().slug) => (slug ? join(deskConfigRoot(), 'repos', slug) : null);
export const credsDir = () => repoConfigDir();

export function configPathOrNull() {
  if (process.env.DESK_CONFIG) return expandHome(process.env.DESK_CONFIG);
  const d = repoConfigDir();
  return d ? join(d, 'config.md') : null;
}
const configPathHint = () =>
  configPathOrNull() ?? '(no repo: run inside the repo, or set DESK_REPO_DIR or DESK_CONFIG)';

// ---- the one map from what a script means to where the config says it ------------------------
// Scripts never name a config row directly. They name a logical id below, and this is the only
// place that knows which row that is, so a row renamed by /desk-setup is a one-line edit here.
//
// §3 rows are matched by their stable Key column. §1, §2 and §3b have no key column, so their rows
// are matched by display name. Either way the match is EXACT (case, backticks and spacing aside):
// a near-miss must read as unset, never borrow a neighbouring row's value.
export const PERMISSION_KEYS = Object.freeze({
  'read-own-work': 'read-own-work',
  'read-local-git': 'read-local-git',
  'read-others': 'read-others',
  'read-slack-public': 'read-slack-public',
  'read-figma': 'read-figma',
  'read-vercel': 'read-vercel',
  'read-confluence': 'read-confluence',
  'read-transcripts': 'read-transcripts',
  'read-calendar': 'read-calendar',
  'read-slack-own': 'read-slack-own',
  'jira-assign-self': 'jira-assign-self',
  'jira-comment': 'jira-comment',
  'jira-create': 'jira-create',
  'jira-edit': 'jira-edit',
  'jira-transition': 'jira-transition',
  'jira-close-own-merged': 'jira-close-own-merged',
  'jira-close': 'jira-close',
  'jira-route': 'jira-route',
  'jira-others': 'jira-others',
  'git-commit': 'git-commit',
  'git-push': 'git-push',
  'git-force-with-lease': 'git-force-with-lease',
  'pr-open': 'pr-open',
  'pr-edit': 'pr-edit',
  'pr-images': 'pr-images',
  'pr-self-review-comment': 'pr-self-review-comment',
  'pr-review-others': 'pr-review-others',
  'pr-reply': 'pr-reply',
  'pr-request-review': 'pr-request-review',
  'pr-ready': 'pr-ready',
  'pr-auto-merge': 'pr-auto-merge',
  'pr-merge-green': 'pr-merge-green',
  'merge-feedback-first': 'merge-feedback-first',
  'pr-update-branch': 'pr-update-branch',
  'pr-conflict-unreviewed': 'pr-conflict-unreviewed',
  'pr-conflict-reviewed': 'pr-conflict-reviewed',
  'ci-rerun': 'ci-rerun',
  'codex-review': 'codex-review',
  'autopilot-workers': 'autopilot-workers',
  'autopilot-worker-mode': 'autopilot-worker-mode',
  'autopilot-merge': 'autopilot-merge',
  'autopilot-judgement': 'autopilot-judgement',
  'autopilot-reclaim': 'autopilot-reclaim',
  'db-per-ticket': 'db-per-ticket',
  'db-clone-staging': 'db-clone-staging',
  'staging-write': 'staging-write',
  'local-reindex': 'local-reindex',
  'tests-shared-db': 'tests-shared-db',
  'worktree-remove': 'worktree-remove',
  'branch-delete': 'branch-delete',
  'server-stop': 'server-stop',
  'skills-edit': 'skills-edit',
  'vercel-env': 'vercel-env',
  'slack-draft': 'slack-draft',
  'slack-send': 'slack-send',
  'merge-bypass': 'merge-bypass',
  'others-prs': 'others-prs',
  'product-calls': 'product-calls',
  'legal-content': 'legal-content',
});

export const CONFIG_ROWS = Object.freeze({
  'gh-repo': { section: '0', row: 'GitHub repo' },
  'default-branch': { section: '0', row: 'Default branch' },
  'repo-description': { section: '0', row: 'One-line description' },
  'github-handle': { section: '1', row: 'GitHub handle' },
  'jira-email': { section: '1', row: 'Jira email' },
  'jira-display-name': { section: '1', row: 'Jira display name' },
  'jira-account-id': { section: '1', row: 'Jira account id' },
  name: { section: '1', row: 'Name' },
  'repo-root': { section: '2', row: 'Primary repo root' },
  'worktrees-dir': { section: '2', row: 'Worktrees directory' },
  'handoff-dir': { section: '2', row: 'Handoff directory' },
  'backups-dir': { section: '2', row: 'Backups directory' },
  wsl: { section: '2', row: 'Running on WSL?' },
  'browser-profile': { section: '2', row: 'Signed-in browser profile' },
  tracker: { section: '4', row: 'Tracker' },
  'jira-site': { section: '4', row: 'Jira site' },
  'jira-project': { section: '4', row: 'Jira project' },
  'ticket-pattern': { section: '4', row: 'Ticket key pattern' },
  'in-progress-state': { section: '4', row: 'In-progress state' },
  'review-state': { section: '4', row: 'Review state' },
  'done-state': { section: '4', row: 'Done state' },
  'jira-priority': { section: '4', row: 'Priority' },
  'jira-other-fields': { section: '4', row: 'Other fields' },
  'jira-cloudid': { section: '4', row: 'Jira cloudId' },
  labels: { section: '4', row: 'Labels' },
  'required-checks': { section: '4', row: 'Required checks' },
  'work-id-patterns': { section: '4', row: 'Other work id patterns' },
  'merge-holds': { section: '4', row: 'Merge holds' },
  'merge-method': { section: '4', row: 'Merge method' },
  'local-review': { section: '4', row: 'Local review command' },
  'clean-verdict': { section: '4', row: 'Clean review verdict' },
  'review-bar': { section: '4', row: 'Review bar' },
  'review-experts': { section: '4', row: 'Review domain experts' },
  'agents-sync': { section: '4', row: 'Project subagents sync' },
  'package-manager': { section: '4', row: 'Package manager' },
  'command-prefix': { section: '4', row: 'Command prefix' },
  'install-cmd': { section: '4', row: 'Install' },
  'dev-cmd': { section: '4', row: 'Dev server' },
  'typecheck-cmd': { section: '4', row: 'Typecheck' },
  'lint-cmd': { section: '4', row: 'Lint' },
  'test-cmd': { section: '4', row: 'Unit tests' },
  'e2e-cmd': { section: '4', row: 'E2E tests' },
  'build-cmd': { section: '4', row: 'Build' },
  'integration-cmd': { section: '4', row: 'Integration tests' },
  'seed-cmd': { section: '4', row: 'Seed' },
  'db-url-var': { section: '4', row: 'Database URL variable' },
  'db-migrate-cmd': { section: '4', row: 'Database migrate' },
  'branch-protection': { section: '4', row: 'Branch protection' },
  'advisory-checks': { section: '4', row: 'Advisory checks' },
  'repo-merge-settings': { section: '4', row: 'Repo merge settings' },
  vercel: { section: '4', row: 'Vercel' },
  'staging-bypass': { section: '4', row: 'Staging bypass token location' },
  'slack-channels': { section: '4', row: 'Slack channels' },
  'repo-instructions': { section: '5', row: 'Repo instructions' },
  'subagents-without-asking': { section: '3b', row: 'Subagents that may run without asking' },
  'test-cap': { section: '3b', row: 'Test worker cap under the test lock' },
  'spawn-gate': { section: '3b', row: 'Spawn gate (available memory)' },
  'park-after': { section: '3b', row: 'Park an unanswered question after (minutes)' },
  'env-files': { section: '4', row: 'Env files' },
  'local-db': { section: '4', row: 'Local database' },
  'local-services': { section: '4', row: 'Local services' },
  staging: { section: '4', row: 'Staging' },
  'checkout-destination': { section: '4', row: 'Check-out destination' },
  'ai-attribution': { section: '5', row: 'AI attribution' },
  'branch-names': { section: '5', row: 'Branch names' },
  'pr-title': { section: '5', row: 'PR title' },
  'dev-port': { section: '3b', row: 'Preferred dev-server port' },
  concurrency: { section: '3b', row: 'Autopilot worker concurrency' },
  'memory-ceiling': { section: '3b', row: 'Memory ceiling for parallel work (GB)' },
  'worker-budget': { section: '3b', row: 'Autopilot per-worker budget (USD)' },
  'batch-budget': { section: '3b', row: 'Autopilot batch budget (USD)' },
});

export class DeskConfigError extends Error {}

// ---- config parsing ------------------------------------------------------------------------
// The config is markdown written by /desk-setup and editable by hand: sections are `## <n>.`
// headings, rows are table rows, and the value is the first backtick span in the value column.
// The value column comes from the header ("Your setting", else "Value", else "Setting", else the
// second column) because §2's Notes and §3's Recommended columns also carry backticks, and taking
// the wrong one would read the suggestion as the user's answer. The row id is the "Key" column
// where the table has one, otherwise the first column.
let cache = null;
const norm = (s) => s.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

// Split a markdown table row into cells. A `|` inside backticks is part of the value (a regex such
// as `KAN-[0-9]+|VPL-[0-9]+`), not a column break; `\|` is a literal pipe too.
function splitRow(line) {
  const body = line.replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  let tick = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\' && body[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') tick = !tick;
    if (c === '|' && !tick) { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function parseConfig() {
  if (cache) return cache;
  const path = configPathOrNull();
  cache = { path, exists: !!path && existsSync(path), sections: {} };
  if (!cache.exists) return cache;
  let section = null;
  let header = null;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    const h = /^##\s+(\d+[a-z]?)[.)]?\s/i.exec(line);
    if (h) { section = h[1].toLowerCase(); header = null; cache.sections[section] ??= { byKey: {}, byName: {} }; continue; }
    if (!section) continue;
    if (!line.startsWith('|')) { header = null; continue; }
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue; // separator row
    if (!header) { header = cells.map(norm); continue; }
    let col = ['your setting', 'value', 'setting'].map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
    if (col < 0) col = 1;
    const keyCol = header.indexOf('key');
    // The template's notes show list values as `` `A` `B` `` (a code span holding backticks);
    // copied into a value, the doubled backticks are display only.
    const cell = (cells[col] ?? '').replace(/``\s?/g, '').replace(/\s?``/g, '');
    const spans = [...cell.matchAll(/`([^`]*)`/g)].map((m) => m[1].trim());
    const items = spans.length ? spans : [cell.trim()];
    const s = cache.sections[section];
    // `value` is the first item (what every single-valued row means); `items` is every backtick span.
    const entry = { value: items[0], items };
    if (keyCol >= 0) { const k = norm(cells[keyCol] ?? ''); if (k) s.byKey[k] = entry; }
    else { const n = norm(cells[0] ?? ''); if (n) s.byName[n] = entry; }
  }
  return cache;
}

const unset = (v) => v == null || v === '' || /^todo\b/i.test(v);

function rowFor(id) {
  const r = CONFIG_ROWS[id];
  if (!r) throw new Error(`desk-env: unknown config id "${id}" (known: ${Object.keys(CONFIG_ROWS).join(', ')})`);
  return r;
}

// `<slug>` in a value (the template's own path examples) means this repo's slug.
const expandSlug = (v) => (typeof v === 'string' && v.includes('<slug>') && currentRepo().slug
  ? v.replaceAll('<slug>', currentRepo().slug) : v);

// Exact lookup by logical id. Unset (missing row, blank, TODO) is null. The first item only: use
// configValues for rows that hold a list (Required checks, Env files, several commands).
export function configValue(id) {
  const { section, row } = rowFor(id);
  const e = parseConfig().sections[section]?.byName[norm(row)];
  return unset(e?.value) ? null : expandSlug(e.value);
}

// Every item of a row, one per backtick span, in order. Items are never split on commas: a check
// can be called `Lint, Type Check & Build`. Unset is null; `none` is ['none'] (callers test isNone).
export function configValues(id) {
  const { section, row } = rowFor(id);
  const e = parseConfig().sections[section]?.byName[norm(row)];
  if (!e || unset(e.value)) return null;
  return e.items.filter((x) => !unset(x)).map(expandSlug);
}
export const isNone = (v) => (Array.isArray(v) ? v.length === 1 && isNone(v[0]) : /^none$/i.test(String(v ?? '').trim()));

// A command item may name the directory it runs in, relative to the repo root: `apps/api: uv run pytest`.
// -> { dir: 'apps/api' | '.', cmd }. The directory must be a plain relative path (no spaces, no ..).
export function parseCommandItem(item) {
  const m = /^([A-Za-z0-9._][A-Za-z0-9._/-]*):\s+(\S.*)$/.exec(String(item).trim());
  if (m && !m[1].split('/').includes('..')) {
    return { dir: m[1].replace(/\/+$/, ''), cmd: m[2] };
  }
  return { dir: '.', cmd: String(item).trim() };
}

// env -> config -> fallback. Identity-shaped values have no fallback and fail loudly.
export function resolve({ env, id, fallback, identity = false }) {
  const fromEnv = env ? process.env[env] : undefined;
  if (!unset(fromEnv)) return expandHome(fromEnv);
  const fromCfg = id ? configValue(id) : null;
  if (fromCfg != null) return expandHome(fromCfg);
  if (!identity && fallback !== undefined) return typeof fallback === 'function' ? fallback() : fallback;
  const where = parseConfig().exists ? configPathHint() : `${configPathHint()} (missing)`;
  const r = id ? CONFIG_ROWS[id] : null;
  throw new DeskConfigError(
    `desk: ${r ? `"${r.row}"` : env} is not set. Set ${env ? `$${env} or ` : ''}` +
      `${r ? `config §${r.section} "${r.row}"` : 'it'} in ${where} — run /desk-setup. Refusing to guess.`,
  );
}

// §3 is an allowlist, matched by exact key: a missing row, a blank, a TODO or anything unrecognised
// is a `no`. An id this file does not know is a bug in the caller, so it throws.
export function permission(id) {
  const key = PERMISSION_KEYS[id];
  if (!key) throw new Error(`desk-env: unknown permission id "${id}" (known: ${Object.keys(PERMISSION_KEYS).join(', ')})`);
  const v = parseConfig().sections['3']?.byKey[norm(key)]?.value;
  if (unset(v)) return 'no';
  return /^(yes|ask|no|never|stop)\b/i.exec(v.trim())?.[1].toLowerCase() ?? 'no';
}
// Tri-state for guard rows, where "unset" must mean the strict default rather than `no`:
// returns yes|ask|no|never|stop, or null when the row is missing, blank or TODO.
export function permissionOrUnset(id) {
  const key = PERMISSION_KEYS[id];
  if (!key) throw new Error(`desk-env: unknown permission id "${id}" (known: ${Object.keys(PERMISSION_KEYS).join(', ')})`);
  const v = parseConfig().sections['3']?.byKey[norm(key)]?.value;
  if (unset(v)) return null;
  return /^(yes|ask|no|never|stop)\b/i.exec(v.trim())?.[1].toLowerCase() ?? null;
}
export const permissionKey = (id) => PERMISSION_KEYS[id];

// A spend guard is a number of USD or explicitly off. Anything else ("25 USD", "0", "lots") is
// refused rather than read as off: a typo must never silently remove a cap.
//   -> { off: true } | { usd: <number> }, or throws DeskConfigError
export function parseBudget(raw, label) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (/^(none|off|no|no cap)$/.test(v)) return { off: true };
  if (/^\d+(\.\d+)?$/.test(v) && Number(v) > 0) return { usd: Number(v) };
  throw new DeskConfigError(`desk: ${label} is "${raw}" — want a positive number of USD, or none/off/no cap. Refusing to guess.`);
}
export const workerBudget = () => parseBudget(resolve({ env: 'AUTOPILOT_BUDGET_USD', id: 'worker-budget', fallback: '25' }), 'the per-worker budget');
export const batchBudget = () => parseBudget(resolve({ env: 'AUTOPILOT_BATCH_BUDGET_USD', id: 'batch-budget', fallback: 'none' }), 'the batch budget');

// ---- identity and paths --------------------------------------------------------------------
export const githubHandle = () => resolve({ env: 'DESK_GITHUB_HANDLE', id: 'github-handle', identity: true });
// Jira shows the assignee by display name, so the ownership test needs that exact string.
export const jiraName = () => {
  try { return resolve({ env: 'DESK_JIRA_NAME', id: 'jira-display-name', identity: true }); }
  catch { return resolve({ env: 'DESK_JIRA_NAME', id: 'name', identity: true }); }
};
export const repoRoot = () => resolve({ env: 'DESK_REPO_ROOT', id: 'repo-root', identity: true }).replace(/\/+$/, '');
export const worktreesDir = () => resolve({
  env: 'DESK_WORKTREES_DIR', id: 'worktrees-dir',
  fallback: () => { const r = repoRoot(); return join(dirname(r), `${basename(r)}-worktrees`); },
}).replace(/\/+$/, '');
export const browserProfile = () => resolve({ env: 'DESK_BROWSER_PROFILE', id: 'browser-profile', identity: true });
// The origin remote wins over the config row: the row is what setup saw, the remote is what is true now.
export const ghRepo = () => currentRepo().ownerRepo ?? resolve({ env: 'DESK_GH_REPO', id: 'gh-repo', identity: true });
export const repoSlug = () => {
  const s = currentRepo().slug;
  if (!s) throw new DeskConfigError(`desk: not inside a git repo, so there is no repo config to read. ${configPathHint()}`);
  return s;
};
export const defaultBranch = () => resolve({ env: 'DESK_DEFAULT_BRANCH', id: 'default-branch', fallback: 'main' });
export const deskHome = () => expandHome(process.env.DESK_HOME ?? join(HOME, '.claude', 'desk'));
export const binDir = () => join(deskHome(), 'bin');
// Batch state is per repo, so autopilot can run in two repos at once without sharing a queue.
export const stateDir = () => expandHome(process.env.DESK_AUTOPILOT_STATE ?? join(HOME, '.desk-autopilot', repoSlug()));
export const queueFile = () => expandHome(process.env.DESK_QUEUE ?? join(deskHome(), 'repos', repoSlug(), 'queue.json'));
export const skillsDir = () => expandHome(process.env.DESK_SKILLS_DIR ?? join(HOME, '.agents', 'skills'));
export const lockDir = () => expandHome(process.env.DESK_LOCK_DIR ?? '/tmp');
// Claude Code keys a project's memory dir by the absolute cwd with every non-alphanumeric char as `-`.
export const memoryDir = (root = repoRoot()) => join(HOME, '.claude', 'projects', root.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
export const pgContainer = () => resolve({ env: 'DESK_PG_CONTAINER', fallback: () => `${basename(repoRoot())}-postgres-1` });

export function isWSL() {
  const cfg = configValue('wsl');
  if (cfg) return /^yes/i.test(cfg);
  return platform() === 'linux' && /microsoft/i.test(release());
}

export function devPort() {
  const v = Number(resolve({ env: 'DESK_DEV_PORT', id: 'dev-port', fallback: '3000' }));
  return Number.isInteger(v) && v > 0 ? v : 3000;
}

// Worker ports start one above the user's dev port and skip anything taken. One definition, used
// by pass.mjs (the real path) and spawn-worker.sh's standalone fallback alike.
export function workerPortFloor() {
  const v = Number(process.env.AUTOPILOT_PORT_FLOOR ?? devPort() + 1);
  return Number.isInteger(v) && v > 0 ? v : devPort() + 1;
}

// `<default> / <cap>` from §3b, default 2 / 3.
export function concurrencyLimits() {
  const nums = (configValue('concurrency') ?? '').match(/\d+/g)?.map(Number) ?? [];
  const def = nums[0] ?? 2;
  return { def, cap: nums[1] ?? Math.max(def, 3) };
}

// §3b "Spawn gate (available memory)", e.g. `start work > 8 GiB · hold 4–8 · drop to 1 below 4`:
// start = spawn only above this, hold = below it run at most one worker, dropTo = that one.
// Unset reads as the template's recommended values. AUTOPILOT_MIN_AVAIL_GB overrides start (0 = off).
export function spawnGate() {
  const v = configValue('spawn-gate') ?? '';
  const num = (re) => { const m = re.exec(v); return m ? Number(m[1]) : null; };
  const start = num(/start[^0-9]*(\d+(?:\.\d+)?)/i) ?? num(/(\d+(?:\.\d+)?)/) ?? 8;
  const hold = num(/below\s*(\d+(?:\.\d+)?)/i) ?? num(/hold\s*(\d+(?:\.\d+)?)/i) ?? Math.min(4, start);
  const dropTo = num(/(?:drop to|drop)\s*(\d+)/i) ?? num(/(\d+)\s*below/i) ?? 1;
  const env = process.env.AUTOPILOT_MIN_AVAIL_GB;
  return { start: env != null && env !== '' && Number.isFinite(Number(env)) ? Number(env) : start, hold, dropTo };
}

// ---- ticket ids ------------------------------------------------------------------------------
// A ticket id names files and directories, so it is checked for shape before anything else, then
// against this repo's config. Case-sensitive as written: `ABC-1` and `abc-1` are different ids.
//   tracker   matches §4 Ticket key pattern in full           -> text from the tracker
//   work-id   matches one §4 Other work id patterns item      -> text from $DESK_STATE/tickets/<id>.md
//   issue     `issue-<n>` with §4 Tracker none                 -> GitHub issue n
//   slug      lower-case kebab with §4 Tracker none           -> text from $DESK_STATE/tickets/<id>.md
// -> { ok: true, kind } | { ok: false, error }
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const fullMatch = (pattern, s) => { try { return new RegExp(`^(?:${pattern})$`).test(s); } catch { return false; } };
export function ticketKind(key) {
  const k = String(key ?? '');
  if (!SAFE_ID.test(k) || k.includes('..')) return { ok: false, error: `'${k}' is not usable as a ticket id (letters, digits, . _ - only; no ..)` };
  const tracker = (configValue('tracker') ?? '').trim().toLowerCase();
  const pattern = configValue('ticket-pattern');
  if (pattern && !isNone(pattern) && fullMatch(pattern, k)) return { ok: true, kind: 'tracker' };
  const others = configValues('work-id-patterns');
  if (others && !isNone(others) && others.some((p) => fullMatch(p, k))) return { ok: true, kind: 'work-id' };
  if (/^none\b/.test(tracker)) {
    if (/^issue-[0-9]+$/.test(k)) return { ok: true, kind: 'issue' };
    if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(k)) return { ok: true, kind: 'slug' };
  }
  const want = [
    pattern && !isNone(pattern) ? `§4 Ticket key pattern (${pattern})` : null,
    others && !isNone(others) ? `a §4 Other work id patterns item (${others.join(' | ')})` : null,
    /^none\b/.test(tracker) ? 'issue-<n> or a lower-case kebab slug (§4 Tracker none)' : null,
  ].filter(Boolean);
  if (!tracker) want.push('(§4 Tracker is unset — run /desk-setup)');
  return { ok: false, error: `'${k}' is not ${want.join(', or ') || 'a ticket id this config accepts'}` };
}

// ---- memory --------------------------------------------------------------------------------
// Two numbers answer two different questions; see the autopilot skill's memory section.
//   avail: is there room to START something?  Linux MemAvailable; macOS free+inactive+purgeable+speculative.
//   used:  how big has the VM / machine footprint grown?  Linux MemTotal-MemFree (counts page cache,
//          which WSL's VmmemWSL also counts); macOS total minus free pages.
const GiB = 1024 ** 3;
function linuxMeminfo() {
  try {
    const m = {};
    for (const l of readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const x = /^(\w+):\s+(\d+)/.exec(l);
      if (x) m[x[1]] = Number(x[2]) * 1024;
    }
    return m.MemTotal ? m : null;
  } catch { return null; }
}
function macVmStat() {
  try {
    const out = execFileSync('vm_stat', { encoding: 'utf8' });
    const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
    const pages = (label) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1] ?? 0) * pageSize;
    return {
      free: pages('Pages free'), inactive: pages('Pages inactive'),
      speculative: pages('Pages speculative'), purgeable: pages('Pages purgeable'),
    };
  } catch { return null; }
}
export function availableGiB() {
  const m = linuxMeminfo();
  if (m?.MemAvailable) return m.MemAvailable / GiB;
  const v = platform() === 'darwin' ? macVmStat() : null;
  if (v) return (v.free + v.inactive + v.speculative + v.purgeable) / GiB;
  return freemem() / GiB; // last resort; under-reports, which only ever delays a spawn
}
export function usedGiB() {
  const m = linuxMeminfo();
  if (m) return (m.MemTotal - m.MemFree) / GiB;
  const v = platform() === 'darwin' ? macVmStat() : null;
  if (v) return (totalmem() - v.free) / GiB;
  return (totalmem() - freemem()) / GiB;
}
export function rssGiB() {
  try {
    const out = execFileSync('ps', ['-axo', 'rss='], { encoding: 'utf8' });
    return out.split('\n').reduce((s, l) => s + (Number(l.trim()) || 0), 0) * 1024 / GiB;
  } catch { return NaN; }
}
export const memCeilingGiB = () => Number(/\d+(\.\d+)?/.exec(resolve({ env: 'DESK_MEM_CEILING_GB', id: 'memory-ceiling', fallback: '16' }))?.[0]) || 16;

// Heavy processes (suites, typecheck, dev servers) counted by argv[0]/argv[1], never `pgrep -f`:
// a claude worker carries its briefing in argv (which mentions jest, vitest and tsc), and the
// harness's own `bash -c` wrapper carries the pattern literally, so a -f match counts both.
export function heavyProcesses() {
  let out = '';
  try { out = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }); } catch { return []; }
  const rows = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) === process.pid) continue;
    const [a0 = '', a1 = '', a2 = ''] = m[2].split(/\s+/);
    const exe = basename(a0);
    if (['claude', 'bash', 'sh', 'zsh', 'grep', 'ps', 'awk'].includes(exe)) continue;
    // argv[2] only for `python -m <module>`, so a Python suite or server counts the same as a JS one.
    const hay = `${exe} ${basename(a1)}${/^python/.test(exe) && a1 === '-m' ? ` ${a2}` : ''}`;
    if (/jest|vitest|tsc|next-server|next dev|playwright|storybook|pytest|uvicorn|gunicorn/.test(hay)) rows.push({ pid: Number(m[1]), args: m[2].slice(0, 160) });
  }
  return rows;
}

// ---- misc ----------------------------------------------------------------------------------
export const uuid = () => randomUUID();

// Probe by connecting, which works the same on Linux and macOS and needs no ss/lsof.
export function portInUse(port, timeoutMs = 400) {
  const probe = (host) => new Promise((res) => {
    const s = net.connect({ port, host });
    const done = (v) => { s.destroy(); res(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then((r) => r.some(Boolean));
}

// ---- CLI -----------------------------------------------------------------------------------
const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'where': {
        const r = currentRepo(); const p = configPathOrNull();
        const q = (v) => `'${String(v ?? '').replace(/'/g, `'\\''`)}'`;
        console.log(`SLUG=${q(r.slug)}`);
        console.log(`GH_REPO=${q(r.ownerRepo)}`);
        console.log(`CONFIG=${q(p)}`);
        console.log(`CREDS=${q(repoConfigDir())}`);
        console.log(`EXISTS=${p && existsSync(p) ? 'yes' : 'no'}`);
        if (!r.slug) process.exit(3);
        break;
      }
      case 'list': {
        const v = configValues(args[0]);
        if (v == null) process.exit(3);
        for (const x of v) console.log(expandHome(x));
        break;
      }
      case 'cmds': {
        const v = configValues(args[0]);
        if (v == null) process.exit(3);
        if (isNone(v)) break;
        for (const x of v) { const c = parseCommandItem(x); console.log(`${c.dir}\t${c.cmd}`); }
        break;
      }
      case 'get': {
        const v = configValue(args[0]);
        if (v == null) process.exit(3);
        console.log(expandHome(v));
        break;
      }
      case 'ticket-kind': {
        const r = ticketKind(args[0]);
        if (!r.ok) { console.error(`desk: ${r.error}`); process.exit(2); }
        console.log(r.kind);
        break;
      }
      case 'perm-or-unset': {
        const v = permissionOrUnset(args[0]);
        if (v == null) process.exit(3);
        console.log(v);
        break;
      }
      case 'perm':
        console.log(permission(args[0]));
        break;
      case 'key':
        if (!PERMISSION_KEYS[args[0]]) throw new Error(`desk-env: unknown permission id "${args[0]}"`);
        console.log(PERMISSION_KEYS[args[0]]);
        break;
      case 'budget': {
        const b = args[0] === 'batch' ? batchBudget() : args[0] === 'worker' ? workerBudget() : null;
        if (!b) throw new Error('usage: desk-env.mjs budget worker|batch');
        console.log(b.off ? 'none' : b.usd);
        break;
      }
      case 'ids':
        for (const [id, key] of Object.entries(PERMISSION_KEYS)) console.log(`perm ${id} -> §3 ${key} = ${permission(id)}`);
        for (const [id, r] of Object.entries(CONFIG_ROWS)) console.log(`get  ${id} -> §${r.section} "${r.row}" = ${configValue(id) ?? '(unset)'}`);
        break;
      case 'paths': {
        const lines = {
          DESK_REPO_ROOT: repoRoot(), DESK_WORKTREES_DIR: worktreesDir(), DESK_HOME: deskHome(), DESK_SLUG: repoSlug(), DESK_REPO_CONFIG_DIR: repoConfigDir(), DESK_DEFAULT_BRANCH: defaultBranch(),
          DESK_BIN: binDir(), DESK_STATE: stateDir(), DESK_QUEUE: queueFile(), DESK_SKILLS_DIR: skillsDir(),
          DESK_LOCK_DIR: lockDir(), DESK_MEMORY_DIR: memoryDir(), DESK_GH_REPO: ghRepo(),
          DESK_PG_CONTAINER: pgContainer(), DESK_DEV_PORT: devPort(), DESK_WORKER_PORT_FLOOR: workerPortFloor(), DESK_IS_WSL: isWSL() ? 'yes' : 'no',
        };
        for (const [k, v] of Object.entries(lines)) console.log(`${k}=${String(v).replace(/'/g, `'\\''`).replace(/^|$/g, "'")}`);
        break;
      }
      case 'identity':
        console.log(`DESK_GITHUB_HANDLE='${githubHandle()}'`);
        console.log(`DESK_JIRA_NAME='${jiraName().replace(/'/g, `'\\''`)}'`);
        break;
      case 'mem': {
        const what = args[0] ?? 'status';
        if (what === 'avail') console.log(availableGiB().toFixed(1));
        else if (what === 'used') console.log(usedGiB().toFixed(1));
        else if (what === 'rss') console.log(rssGiB().toFixed(1));
        else console.log(`vmmem=${usedGiB().toFixed(1)}G avail=${availableGiB().toFixed(1)}G rss=${rssGiB().toFixed(1)}G`);
        break;
      }
      case 'heavy':
        for (const p of heavyProcesses()) console.log(`${p.pid} ${p.args}`);
        break;
      case 'uuid':
        console.log(uuid());
        break;
      case 'port-in-use':
        process.exit((await portInUse(Number(args[0]))) ? 0 : 1);
        break;
      default:
        console.error('usage: desk-env.mjs where|get|list|cmds|perm|key|budget|ids|paths|identity|mem|heavy|uuid|port-in-use');
        process.exit(2);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(e instanceof DeskConfigError ? 4 : 1);
  }
}
