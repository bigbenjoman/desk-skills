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
//   node desk-env.mjs get <config id>         print the value (CONFIG_ROWS; first item), exit 3 if unset;
//                                             default-branch honours a batch base (DESK_DEFAULT_BRANCH)
//   node desk-env.mjs batch-base              print the queue's batch base branch, exit 3 if none is set
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
//   node desk-env.mjs mem <avail|used|rss|status>   status adds runner= and ladder= while the runner VM
//                                             runs with a reservation in the machine profile
//   node desk-env.mjs test-scope [--base <ref>]   what a worker tests before pushing: scope=related|full|none,
//                                             reason=, changed=, then DIR<TAB>CMD<TAB>FILES per suite to run
//   node desk-env.mjs baseline typecheck|lint  run §4 Typecheck or Lint here; with §4 Baseline checks on and a
//                                             recorded batch base, fail only on errors the base does not have
//   node desk-env.mjs mem watch [--interval s] [--window s]   runs until killed; prints SUSTAINED-HIGH
//                                             when avail stays under the band for the window (default 300s)
//                                             with nothing heavy running
//   node desk-env.mjs uuid
//   node desk-env.mjs port-in-use <port>      exit 0 if something is listening
//   node desk-env.mjs ports [--cap <n>]       every repo config's dev port and worker block (REPO), each
//                                             one this repo's block meets (CLASH), and a free port (PROPOSE);
//                                             --cap sizes this repo's block instead of its concurrency row
//   node desk-env.mjs default-mode            print DEFAULT_MODE= and SOURCE= for the cwd's repo; exit 1 (with
//                                             the warning on stderr) when it is dontAsk
//   node desk-env.mjs machine detect         print this computer's hardware, and what changed since the profile
//   node desk-env.mjs machine propose [--runner]  print the sizes the rules propose, with the arithmetic;
//                                             the runner is off by default; --runner sizes it on
//   node desk-env.mjs machine write [--runner]    write ~/.config/desk/machine.md (only after the user confirms)
//   node desk-env.mjs machine get|why <key>   print a profile value or its reason, exit 3 if there is none
import { readFileSync, readdirSync, existsSync, realpathSync, writeFileSync, mkdirSync, copyFileSync, renameSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { homedir, platform, totalmem, freemem, release } from 'node:os';
import { basename, dirname, join } from 'node:path';
import net from 'node:net';
import * as M from './machine.mjs';
import * as TS from './test-scope.mjs';

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
  'ci-protection': 'ci-protection',
  'autopilot-workers': 'autopilot-workers',
  'autopilot-worker-mode': 'autopilot-worker-mode',
  'autopilot-merge': 'autopilot-merge',
  'batch-base-push': 'batch-base-push',
  'autopilot-judgement': 'autopilot-judgement',
  'autopilot-reclaim': 'autopilot-reclaim',
  'autopilot-usage-resume': 'autopilot-usage-resume',
  'worker-dependency-install': 'worker-dependency-install',
  'worker-screenshots': 'worker-screenshots',
  'worker-local-services': 'worker-local-services',
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
  'design-dir': { section: '2', row: 'Design canvases directory' },
  wsl: { section: '2', row: 'Running on WSL?' },
  'browser-profile': { section: '2', row: 'Signed-in browser profile' },
  'handoff-pct': { section: '2', row: 'Handoff at context %' },
  'handoff-pct-1m': { section: '2', row: 'Handoff at context % on a 1M window' },
  tracker: { section: '4', row: 'Tracker' },
  'jira-site': { section: '4', row: 'Jira site' },
  'jira-project': { section: '4', row: 'Jira project' },
  'ticket-pattern': { section: '4', row: 'Ticket key pattern' },
  'in-progress-state': { section: '4', row: 'In-progress state' },
  'review-state': { section: '4', row: 'Review state' },
  'done-state': { section: '4', row: 'Done state' },
  'jira-priority': { section: '4', row: 'Priority' },
  'jira-other-fields': { section: '4', row: 'Other fields' },
  'jira-required-fields': { section: '4', row: 'Required fields' },
  'jira-size-field': { section: '4', row: 'Size field' },
  'jira-priority-user-only': { section: '4', row: 'Priorities only you set' },
  'jira-cloudid': { section: '4', row: 'Jira cloudId' },
  labels: { section: '4', row: 'Labels' },
  'required-checks': { section: '4', row: 'Required checks' },
  'work-id-patterns': { section: '4', row: 'Other work id patterns' },
  'merge-holds': { section: '4', row: 'Merge holds' },
  'incidental-paths': { section: '4', row: 'Incidental paths' },
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
  'baseline-checks': { section: '4', row: 'Baseline checks' },
  'test-cmd': { section: '4', row: 'Unit tests' },
  'related-test-cmd': { section: '4', row: 'Related tests' },
  'e2e-cmd': { section: '4', row: 'E2E tests' },
  'build-cmd': { section: '4', row: 'Build' },
  'codegen-cmd': { section: '4', row: 'Codegen' },
  'integration-cmd': { section: '4', row: 'Integration tests' },
  'acceptance-specs': { section: '4', row: 'Acceptance specs' },
  'pre-push-checks': { section: '4', row: 'Pre-push checks' },
  'pr-description-checks': { section: '4', row: 'PR-description checks' },
  'seed-cmd': { section: '4', row: 'Seed' },
  'db-url-var': { section: '4', row: 'Database URL variable' },
  'db-migrate-cmd': { section: '4', row: 'Database migrate' },
  'branch-protection': { section: '4', row: 'Branch protection' },
  'advisory-checks': { section: '4', row: 'Advisory checks' },
  'flaky-checks': { section: '4', row: 'Known flaky checks' },
  'repo-merge-settings': { section: '4', row: 'Repo merge settings' },
  vercel: { section: '4', row: 'Vercel' },
  'staging-bypass': { section: '4', row: 'Staging bypass token location' },
  'slack-channels': { section: '4', row: 'Slack channels' },
  'repo-instructions': { section: '5', row: 'Repo instructions' },
  'subagents-without-asking': { section: '3b', row: 'Subagents that may run without asking' },
  'test-cap': { section: '3b', row: 'Test worker cap under the test lock' },
  'spawn-gate': { section: '3b', row: 'Spawn gate (available memory)' },
  'park-after': { section: '3b', row: 'Park an unanswered question after (minutes)' },
  'checkin-times': { section: '3b', row: 'Check-in times' },
  'env-files': { section: '4', row: 'Env files' },
  'local-db': { section: '4', row: 'Local database' },
  'local-services': { section: '4', row: 'Local services' },
  staging: { section: '4', row: 'Staging' },
  'checkout-destination': { section: '4', row: 'Check-out destination' },
  'ai-attribution': { section: '5', row: 'AI attribution' },
  'branch-names': { section: '5', row: 'Branch names' },
  'pr-title': { section: '5', row: 'PR title' },
  breakpoints: { section: '5', row: 'Breakpoints' },
  'design-system': { section: '5', row: 'Design system' },
  'dev-port': { section: '3b', row: 'Preferred dev-server port' },
  concurrency: { section: '3b', row: 'Autopilot worker concurrency' },
  'memory-ceiling': { section: '3b', row: 'Memory ceiling for parallel work (GB)' },
  'worker-budget': { section: '3b', row: 'Autopilot per-worker budget (USD)' },
  'batch-budget': { section: '3b', row: 'Autopilot batch budget (USD)' },
  'worker-models': { section: '3b', row: 'Worker models' },
  'worker-location': { section: '3b', row: 'Worker location' },
  'borrow-idle': { section: '3b', row: 'Borrow idle workers' },
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

const { splitRow } = M;

function parseConfig() {
  if (cache) return cache;
  cache = parseConfigFile(configPathOrNull());
  return cache;
}

// Any config file, not only this repo's: `ports` reads every repo's to keep dev ports apart.
function parseConfigFile(path) {
  const parsed = { path, exists: !!path && existsSync(path), sections: {} };
  if (!parsed.exists) return parsed;
  let section = null;
  let header = null;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    const h = /^##\s+(\d+[a-z]?)[.)]?\s/i.exec(line);
    if (h) { section = h[1].toLowerCase(); header = null; parsed.sections[section] ??= { byKey: {}, byName: {} }; continue; }
    if (!section) continue;
    if (!line.startsWith('|')) { header = null; continue; }
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue; // separator row
    if (!header) { header = cells.map(norm); continue; }
    let col = ['your setting', 'value', 'setting'].map((n) => header.indexOf(n)).find((i) => i >= 0) ?? -1;
    if (col < 0) col = 1;
    const keyCol = header.indexOf('key');
    const items = cellItems(cells[col] ?? '');
    const s = parsed.sections[section];
    // `value` is the first item (what every single-valued row means); `items` is every backtick span.
    const entry = { value: items[0], items };
    if (keyCol >= 0) { const k = norm(cells[keyCol] ?? ''); if (k) s.byKey[k] = entry; }
    else { const n = norm(cells[0] ?? ''); if (n) s.byName[n] = entry; }
  }
  return parsed;
}

// A value cell's items: every backtick span, except those in a trailing parenthesised note
// (`` `ABC` (not `parent`) `` is one item, ABC). With no spans, the whole cell is the one item.
export function cellItems(raw) {
  // The template's notes show list values as `` `A` `B` `` (a code span holding backticks);
  // copied into a value, the doubled backticks are display only.
  const cell = raw.replace(/``\s?/g, '').replace(/\s?``/g, '').trim();
  const spans = [...stripTrailingNote(cell).matchAll(/`([^`]*)`/g)].map((m) => m[1].trim());
  return spans.length ? spans : [cell];
}

// The cell less a trailing `(…)` note, found by walking back from the closing paren to its match.
// Parens inside backtick spans are value text (a regex like `(-FIX)?`), so they are skipped. A
// cell that is only a note, or whose last paren never opens, is returned whole.
function stripTrailingNote(cell) {
  if (!cell.endsWith(')')) return cell;
  let depth = 0;
  let inSpan = false;
  for (let i = cell.length - 1; i >= 0; i--) {
    const c = cell[i];
    if (c === '`') inSpan = !inSpan;
    else if (inSpan) continue;
    else if (c === ')') depth++;
    else if (c === '(' && --depth === 0) return cell.slice(0, i).trim() ? cell.slice(0, i) : cell;
  }
  return cell;
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

// ---- the machine profile -------------------------------------------------------------------
// One per computer, beside the repo configs. §3b rows that are about the computer rather than the
// repo fall back to it when the repo leaves them TODO or absent; a set repo row always wins, and
// with no profile they read as unset exactly as before.
export const machineProfilePath = () => expandHome(process.env.DESK_MACHINE ?? join(deskConfigRoot(), 'machine.md'));
const MACHINE_FALLBACK = Object.freeze({
  concurrency: 'autopilot-concurrency',
  'memory-ceiling': 'memory-ceiling-gb',
  'test-cap': 'test-cap',
});
let machineCache;
export function machineProfile() {
  if (machineCache === undefined) machineCache = M.readProfile(machineProfilePath());
  return machineCache;
}
// A profile value by key (hardware or sizing), or null.
export function machineValue(key) {
  const p = machineProfile();
  const v = p?.sizing[key]?.value ?? p?.hardware[key]?.value;
  return unset(v) ? null : v;
}
export const machineWhy = (key) => machineProfile()?.sizing[key]?.why || null;

// Exact lookup by logical id. Unset (missing row, blank, TODO) is null. The first item only: use
// configValues for rows that hold a list (Required checks, Env files, several commands).
export function configValue(id) {
  return configValueIn(parseConfig(), id);
}

function configValueIn(parsed, id) {
  const { section, row } = rowFor(id);
  const e = parsed.sections[section]?.byName[norm(row)];
  if (!unset(e?.value)) return expandSlug(e.value);
  return MACHINE_FALLBACK[id] ? machineValue(MACHINE_FALLBACK[id]) : null;
}

// Every item of a row, one per backtick span, in order. Items are never split on commas: a check
// can be called `Lint, Type Check & Build`. Unset is null; `none` is ['none'] (callers test isNone).
export function configValues(id) {
  const { section, row } = rowFor(id);
  const e = parseConfig().sections[section]?.byName[norm(row)];
  if (!e || unset(e.value)) return null;
  const items = e.items.filter((x) => !unset(x)).map(expandSlug);
  // `none` beside other items is a note written in backticks: every span is an item, so the note
  // would be read as a command or check. Refuse rather than guess which one was meant.
  if (items.length > 1 && items.some((x) => isNone(x))) {
    throw new DeskConfigError(
      `desk: config §${section} "${row}" mixes \`none\` with other items (${items.join(' | ')}) in ${configPathHint()}. ` +
        '`none` must stand alone: move the note out of backticks, e.g. `none` (the note in plain text). Refusing to guess.',
    );
  }
  return items;
}
export const isNone = (v) => (Array.isArray(v) ? v.length === 1 && isNone(v[0]) : /^none$/i.test(String(v ?? '').trim()));

// The lock a §4 command row's items take under with-lock.sh; every other row runs `nolock`.
export const LOCK_OF = { 'test-cmd': 'test', 'related-test-cmd': 'test', 'integration-cmd': 'test', 'typecheck-cmd': 'tsc', 'e2e-cmd': 'browser' };
export const lockFor = (id) => LOCK_OF[id] ?? 'nolock';

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
// returns yes|ask|no|never|stop, or null when the row is missing, blank or TODO. A value it cannot
// read is a `no`, as in permission(): a typo must never borrow the unset default.
export function permissionOrUnset(id) {
  const key = PERMISSION_KEYS[id];
  if (!key) throw new Error(`desk-env: unknown permission id "${id}" (known: ${Object.keys(PERMISSION_KEYS).join(', ')})`);
  const v = parseConfig().sections['3']?.byKey[norm(key)]?.value;
  if (unset(v)) return null;
  return /^(yes|ask|no|never|stop)\b/i.exec(v.trim())?.[1].toLowerCase() ?? 'no';
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

// Config §3b "Worker models": `default` (no --model, the session default) or
// `standard=<model> high=<model>`, each a `claude --model` alias or full name. Anything else is
// refused rather than read as default, so a typo never silently runs every worker on one model.
//   -> { off: true } | { standard, high }, or throws DeskConfigError
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]*$/;
export function parseWorkerModels(raw) {
  const v = String(raw ?? '').trim();
  if (/^default$/i.test(v)) return { off: true };
  const pairs = Object.fromEntries(v.split(/\s+/).map((p) => p.split('=')).filter((p) => p.length === 2));
  const ok = v.split(/\s+/).length === 2 && Object.keys(pairs).sort().join() === 'high,standard'
    && MODEL_NAME.test(pairs.standard) && MODEL_NAME.test(pairs.high);
  if (!ok) throw new DeskConfigError(`desk: config §3b "Worker models" is "${raw}" — want \`default\`, or \`standard=<model> high=<model>\`. Refusing to guess.`);
  return { standard: pairs.standard, high: pairs.high };
}
export const workerModels = () => parseWorkerModels(resolve({ id: 'worker-models', fallback: 'default' }));

// Config §3b "Worker location": `local` (also when the row is unset) or `cloud`. Cloud workers do
// not exist yet, so both run every worker locally, and the batch plan says so at `cloud`. Anything
// else is refused rather than read as local.
//   -> 'local' | 'cloud', or throws DeskConfigError
export function parseWorkerLocation(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'local' || v === 'cloud') return v;
  throw new DeskConfigError(`desk: config §3b "Worker location" is "${raw}" — want \`local\` or \`cloud\`. Refusing to guess.`);
}
export const workerLocation = () => parseWorkerLocation(resolve({ id: 'worker-location', fallback: 'local' }));

// Which tier a ticket's worker runs on, from its triage: a lane A or E ticket sized XS or S is
// `standard`; lane B, size M and an unsized ticket are `high`.
export function modelTier({ lane, size } = {}) {
  return ['A', 'E'].includes(String(lane ?? '').toUpperCase()) && ['XS', 'S'].includes(String(size ?? '').toUpperCase())
    ? 'standard' : 'high';
}

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
// One per machine, beside which github-signin.mjs saves the GitHub login that the uploader and Claude's
// Playwright MCP share (install.sh registers the MCP on it). A repo's §2 row overrides it for that repo's
// uploads only: the MCP is user-level and keeps the machine one.
export const DEFAULT_BROWSER_PROFILE = join(HOME, '.cache', 'ms-playwright-mcp', 'desk-profile');
export const browserProfile = () => resolve({ env: 'DESK_BROWSER_PROFILE', id: 'browser-profile', fallback: DEFAULT_BROWSER_PROFILE });
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

// Move a ticket's last round aside so the next worker starts clean: its log (a kept AUTOPILOT_DONE
// blocks the respawn, and a kept PR line sends screenshots to the old PR), its park record (an old
// question reads as the new worker's) and, with `answers`, its mailbox (a stale answer satisfies the
// next park instantly). All take one suffix, the first `.round<n>` free for every one of them, so a
// round's files stay together. An empty log is left in place. Returns the files moved.
export function rotateRound(key, { answers = false } = {}) {
  const state = stateDir();
  const files = [join(state, 'logs', `${key}.log`), join(state, 'parks', `${key}.json`)];
  if (answers) files.push(join(state, 'answers', `${key}.txt`));
  const present = files.filter((f) => existsSync(f) && (!f.endsWith('.log') || statSync(f).size > 0));
  if (!present.length) return [];
  let n = 1;
  while (files.some((f) => existsSync(`${f}.round${n}`))) n += 1;
  for (const f of present) renameSync(f, `${f}.round${n}`);
  return present.map((f) => `${f}.round${n}`);
}

// A batch may target a branch other than §0 Default branch: a feature branch that ships as one merge.
// It is the queue's top-level `base` (`queue.mjs set-batch base=<branch>`), and it reaches the code
// as DESK_DEFAULT_BRANCH, which defaultBranch() already reads first. Only the autopilot's own entry
// points (pass.mjs, triage.sh, merge-driver.sh) call applyBatchBase(), and every child they start
// (setup-worktree, spawn-worker, worker-settings, the worker itself) inherits the variable. An
// interactive session never reads the queue, so a batch's base can never redirect its PRs.
export const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
// A batch merges into its base, and pass.mjs pushes to it, so a production branch is refused on every
// read, not only when set-batch writes it: production only ever takes promotion PRs.
export const PRODUCTION_BRANCH = /^(production|prod|release)$/i;
export function batchBase() {
  let q;
  try { q = JSON.parse(readFileSync(queueFile(), 'utf8')); } catch { return null; }
  const b = typeof q?.base === 'string' ? q.base.trim() : '';
  if (!b) return null;
  if (!BRANCH_NAME.test(b) || b.includes('..') || b.endsWith('.lock')) {
    throw new DeskConfigError(`desk: queue base "${b}" is not a valid branch name. Fix it with queue.mjs set-batch base=<branch> (or base= to clear).`);
  }
  if (PRODUCTION_BRANCH.test(b)) {
    throw new DeskConfigError(`desk: queue base "${b}" is a production branch, and a batch never merges into one. Fix it with queue.mjs set-batch base=<branch> (or base= to clear).`);
  }
  return b;
}
// Exports the batch's base for this process and its children. A DESK_DEFAULT_BRANCH already set to
// something else is a contradiction, not a preference: refuse rather than pick one.
export function applyBatchBase() {
  const b = batchBase();
  if (!b) return null;
  const env = process.env.DESK_DEFAULT_BRANCH;
  if (!unset(env) && env !== b) {
    throw new DeskConfigError(`desk: DESK_DEFAULT_BRANCH=${env} contradicts the batch base ${b} in ${queueFile()}. Unset one; refusing to guess.`);
  }
  process.env.DESK_DEFAULT_BRANCH = b;
  return b;
}
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

const DEFAULT_DEV_PORT = 3000;
const positiveInt = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
export function devPort() {
  return positiveInt(resolve({ env: 'DESK_DEV_PORT', id: 'dev-port', fallback: String(DEFAULT_DEV_PORT) })) ?? DEFAULT_DEV_PORT;
}

// Worker ports start one above the user's dev port and skip anything taken. One definition, used
// by pass.mjs (the real path) and spawn-worker.sh's standalone fallback alike.
export function workerPortFloor() {
  return positiveInt(process.env.AUTOPILOT_PORT_FLOOR ?? devPort() + 1) ?? devPort() + 1;
}

// `<default> / <cap>` from §3b, default 2 / 3.
export function concurrencyLimits(row = configValue('concurrency')) {
  const nums = (row ?? '').match(/\d+/g)?.map(Number) ?? [];
  const def = nums[0] ?? 2;
  return { def, cap: nums[1] ?? Math.max(def, 3) };
}

// ---- dev ports across repos ----------------------------------------------------------------
// A repo holds its §3b dev port and the worker ports above it: workers start one above the dev
// port (workerPortFloor), so a repo at P with a worker cap of N holds P..P+N. /desk-setup proposes
// a port whose block meets no other repo's, and flags this repo's when it already does. A config
// that leaves the port unset runs on devPort()'s default, so it claims that.
export function repoPortClaims(root = deskConfigRoot()) {
  const dir = join(root, 'repos');
  let slugs = [];
  try { slugs = readdirSync(dir).sort(); } catch { return []; }
  return slugs.flatMap((slug) => {
    const parsed = parseConfigFile(join(dir, slug, 'config.md'));
    if (!parsed.exists) return [];
    const port = positiveInt(configValueIn(parsed, 'dev-port')) ?? DEFAULT_DEV_PORT;
    return [{ slug, port, last: port + concurrencyLimits(configValueIn(parsed, 'concurrency')).cap }];
  });
}

// A row from another repo's config, by slug: desk-q reads every repo's cap. Unset is null.
export const repoConfigValue = (slug, id, root = deskConfigRoot()) =>
  configValueIn(parseConfigFile(join(root, 'repos', slug, 'config.md')), id);

const blocksMeet = (a, b) => a.port <= b.last && b.port <= a.last;
export const portClashes = (self, claims) => claims.filter((c) => c.slug !== self.slug && blocksMeet(self, c));

// The lowest port from `from`, in steps of `step`, whose block of `cap` workers meets no claim.
export function proposePort(cap, claims, { from = 3000, step = 100 } = {}) {
  for (let port = from; port + cap <= 65535; port += step) {
    if (!claims.some((c) => blocksMeet({ port, last: port + cap }, c))) return port;
  }
  return null;
}

// §3b "Spawn gate (available memory)", e.g. `start work > 8 GiB · hold 4–8 · drop to 1 below 4`:
// start = spawn only above this, hold = below it run at most one worker, dropTo = that one.
// Unset reads as the template's recommended values. AUTOPILOT_MIN_AVAIL_GB overrides start (0 = off).
// `row` is this repo's by default; desk-q passes another repo's (repoConfigValue).
export function spawnGate(row = configValue('spawn-gate')) {
  const v = row ?? '';
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
// The runner VM's reservation, which the autopilot ladder holds back from `avail`. Where the
// desk-runner VM runs, its memory from the machine profile (`runner-memory-reserved-gb`) is a fixed
// reservation: CI can fill it at any moment, so a worker spawned into it is spawned into memory
// that is already promised. A VM's guest memory comes out of the Mac only as the guest touches it,
// so what it has touched is already missing from `avail`; holding back the whole reservation on top
// would count that part twice. Held back is the reservation less the VM's resident memory. Without
// a running VM, or with no reservation in the profile, nothing is held back.
// -> null | { reservedGiB, residentGiB, heldGiB }
export function runnerReservation({ running, reservedGiB, residentGiB }) {
  if (!running || !(reservedGiB > 0)) return null;
  const resident = Number.isFinite(residentGiB) && residentGiB > 0 ? residentGiB : 0;
  return { reservedGiB, residentGiB: resident, heldGiB: Math.max(0, reservedGiB - resident) };
}
const runnerVm = () => process.env.DESK_RUNNER_VM || 'desk-runner';
// Whether the VM runs (`tart get`), and the resident memory of the process holding its disk image
// open (the Virtualization framework's VM process). An unreadable size reads as 0 resident, so the
// whole reservation is held back: a wrong read only ever delays a spawn.
export function runnerState() {
  const reservedGiB = Number(machineValue('runner-memory-reserved-gb'));
  if (!(reservedGiB > 0)) return { running: false, reservedGiB: 0, residentGiB: 0 };
  const quiet = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 };
  let running = false;
  try { running = JSON.parse(execFileSync('tart', ['get', runnerVm(), '--format', 'json'], quiet)).Running === true; } catch { running = false; }
  if (!running) return { running, reservedGiB, residentGiB: 0 };
  let residentGiB = 0;
  try {
    const disk = join(expandHome(process.env.TART_HOME ?? join(HOME, '.tart')), 'vms', runnerVm(), 'disk.img');
    const pids = execFileSync('lsof', ['-t', disk], quiet).split('\n').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
    if (pids.length) {
      const kb = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], quiet).split('\n').reduce((s, l) => s + (Number(l.trim()) || 0), 0);
      residentGiB = (kb * 1024) / GiB;
    }
  } catch { residentGiB = 0; }
  return { running, reservedGiB, residentGiB };
}
// `avail` with the runner's reservation held back: what the ladder gates a spawn on.
export function ladderMemory(avail = availableGiB(), state = runnerState()) {
  const reservation = runnerReservation(state);
  return { avail, reservation, gate: Math.max(0, avail - (reservation?.heldGiB ?? 0)) };
}
// The status-line segment for a ladderMemory() result, or '' with no reservation.
export const runnerSegment = ({ reservation: r, gate }) => (r
  ? ` runner=${r.reservedGiB.toFixed(1)}G reserved (${r.residentGiB.toFixed(1)}G resident, ${r.heldGiB.toFixed(1)}G held back) ladder=${gate.toFixed(1)}G`
  : '');
// The `mem status` line, which `queue.mjs watch` prints under its table too.
export function memStatusLine() {
  const l = ladderMemory();
  return `vmmem=${usedGiB().toFixed(1)}G avail=${l.avail.toFixed(1)}G rss=${rssGiB().toFixed(1)}G${runnerSegment(l)}`;
}

export const memCeilingGiB = () => Number(/\d+(\.\d+)?/.exec(resolve({ env: 'DESK_MEM_CEILING_GB', id: 'memory-ceiling', fallback: '16' }))?.[0]) || 16;

// Heavy processes (suites, typecheck, dev servers) counted by argv[0]/argv[1], never `pgrep -f`:
// a claude worker carries its briefing in argv (which mentions jest, vitest and tsc), and the
// harness's own `bash -c` wrapper carries the pattern literally, so a -f match counts both.
export function heavyProcesses() {
  let out = '';
  try { out = execFileSync('ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }); } catch { return []; }
  return heavyFromPs(out, process.pid);
}
// `playwright` only as a whole name: `playwright test` is a suite, an idle `playwright-mcp` server is not.
export function heavyFromPs(out, selfPid) {
  const rows = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) === selfPid) continue;
    const [a0 = '', a1 = '', a2 = ''] = m[2].split(/\s+/);
    const exe = basename(a0);
    if (['claude', 'bash', 'sh', 'zsh', 'grep', 'ps', 'awk'].includes(exe)) continue;
    // argv[2] only for `python -m <module>`, so a Python suite or server counts the same as a JS one.
    const hay = `${exe} ${basename(a1)}${/^python/.test(exe) && a1 === '-m' ? ` ${a2}` : ''}`;
    if (/jest|vitest|tsc|next-server|next dev|\bplaywright\b(?!-)|storybook|pytest|uvicorn|gunicorn/.test(hay)) rows.push({ pid: Number(m[1]), args: m[2].slice(0, 160) });
  }
  return rows;
}

// The sustained-high watch: `avail` under the lowest band of §3b "Spawn gate (available memory)",
// held for the window with nothing heavy running. Never vmmem, which counts page cache (macOS sits
// over any ceiling while tens of GiB are free). The band is 2 GiB (the ladder's reclaim row) unless
// the row names a lower one; the `drop to <n>` worker count is not a band.
export function sustainedBandGiB(row = configValue('spawn-gate') ?? '') {
  const bands = String(row).replace(/drop(?:\s+to)?\s*\d+/gi, '').replace(/\d+\s*(?=below)/gi, '')
    .match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  return Math.min(2, ...bands);
}
// One sample in, the next state out, plus the line to print (once per episode). state: { since, fired }.
export function sustainedStep(state, { now, avail, heavy }, { band, windowMs }) {
  if (!(avail < band) || heavy > 0) return { state: { since: null, fired: false }, line: null };
  const since = state?.since ?? now;
  if (state?.fired || now - since < windowMs) return { state: { since, fired: !!state?.fired }, line: null };
  const mins = Math.round((now - since) / 60000);
  return { state: { since, fired: true }, line: `SUSTAINED-HIGH: avail=${avail.toFixed(1)}G below ${band}G for ${mins}m with nothing heavy running` };
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

// ---- the session's permission mode ---------------------------------------------------------
// A `permissions.defaultMode` of `dontAsk` refuses AskUserQuestion and Monitor, which an
// orchestrator (and /desk-setup's interview) cannot work without. Workers are unaffected: they run
// with `--setting-sources ""` and their own settings file. The files are read in Claude Code's
// precedence order, highest first, so the first one that sets it is the mode a session starts in.
export const DONTASK_WARNING = 'defaultMode is dontAsk: the orchestrator cannot ask questions or run monitors';

export function defaultModeIn(root, home = HOME) {
  const files = [
    ...(root ? [join(root, '.claude', 'settings.local.json'), join(root, '.claude', 'settings.json')] : []),
    join(home, '.claude', 'settings.json'),
  ];
  for (const file of files) {
    let mode;
    try { mode = JSON.parse(readFileSync(file, 'utf8'))?.permissions?.defaultMode; }
    catch { continue; } // missing or unreadable: Claude Code skips it too
    if (typeof mode === 'string' && mode) return { mode, file };
  }
  return { mode: null, file: null };
}

export const sessionDefaultMode = () => defaultModeIn(git(currentRepo().dir, 'rev-parse', '--show-toplevel') || null);

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
        // default-branch honours a batch's base (inherited as DESK_DEFAULT_BRANCH), so a worker that
        // asks for <default> gets the branch its batch targets, not the config row.
        const v = args[0] === 'default-branch' ? defaultBranch() : configValue(args[0]);
        if (v == null) process.exit(3);
        console.log(expandHome(v));
        break;
      }
      case 'batch-base': {
        const b = batchBase();
        if (!b) process.exit(3);
        console.log(b);
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
        else if (what === 'watch') {
          // Runs until killed (a Monitor); prints only when the condition has held for the window.
          const opt = (name, dflt) => { const i = args.indexOf(name); return i > 0 && Number(args[i + 1]) > 0 ? Number(args[i + 1]) : dflt; };
          const cfg = { band: sustainedBandGiB(), windowMs: opt('--window', 300) * 1000 };
          const intervalMs = opt('--interval', 30) * 1000;
          let state = null;
          for (;;) {
            const r = sustainedStep(state, { now: Date.now(), avail: availableGiB(), heavy: heavyProcesses().length }, cfg);
            state = r.state;
            if (r.line) console.log(r.line);
            await new Promise((res) => setTimeout(res, intervalMs));
          }
        }
        else console.log(memStatusLine());
        break;
      }
      case 'heavy':
        for (const p of heavyProcesses()) console.log(`${p.pid} ${p.args}`);
        break;
      case 'test-scope': {
        // What a worker tests before it pushes: the branch's changes against the merge base with
        // origin/<default> (committed, staged, unstaged and untracked), decided by test-scope.mjs.
        const top = git(process.cwd(), 'rev-parse', '--show-toplevel');
        if (!top) throw new Error('desk-env test-scope: not inside a git work tree');
        const i = args.indexOf('--base');
        const ref = i >= 0 && args[i + 1] ? args[i + 1] : `origin/${defaultBranch()}`;
        const mergeBase = git(top, 'merge-base', 'HEAD', ref);
        if (!mergeBase) throw new Error(`desk-env test-scope: no merge base between HEAD and ${ref}`);
        const changes = TS.parseNameStatus([git(top, 'diff', '--name-status', '-M', mergeBase),
          ...git(top, 'ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean).map((p) => `?? ${p}`)].join('\n'));
        const items = (id) => { const v = configValues(id); return v && !isNone(v) ? v.map(parseCommandItem) : []; };
        const relatedItems = items('related-test-cmd');
        const d = TS.decide(changes, { shared: TS.sharedPackages(TS.workspacePackages(top)), related: relatedItems.length > 0 });
        console.log(`scope=${d.scope}`);
        console.log(`reason=${d.reason}`);
        console.log(`changed=${d.files.length}`);
        for (const r of TS.runs(d, { relatedItems, fullItems: items('test-cmd') })) console.log(`${r.dir}\t${r.cmd}\t${r.files.join(' ')}`);
        break;
      }
      case 'baseline': {
        // A worker's §4 Typecheck or Lint, compared with the batch base's recorded errors where config
        // §4 Baseline checks is on (baseline.mjs); otherwise the full check, saying why.
        const B = await import('./baseline.mjs');
        const name = args[0];
        if (!B.CHECKS[name]) { console.error('usage: desk-env.mjs baseline typecheck|lint'); process.exit(2); }
        const top = git(process.cwd(), 'rev-parse', '--show-toplevel');
        if (!top) throw new Error('desk-env baseline: not inside a git work tree');
        const row = B.CHECKS[name];
        const v = configValues(row);
        const list = v && !isNone(v) ? v.map(parseCommandItem) : [];
        if (!list.length) { console.log(`config §4 ${CONFIG_ROWS[row].row} is ${v ? 'none' : 'unset'}: nothing to run`); break; }
        const branch = defaultBranch();
        const a = B.activeBaseline({ setting: configValue('baseline-checks'), base: branch !== configValue('default-branch') ? branch : null, stateDir: stateDir() });
        if (a.on) {
          console.log(`baseline: ${a.b.base} at ${a.b.sha.slice(0, 12)}, recorded ${a.b.at}`);
          const at = git(top, 'merge-base', 'HEAD', `origin/${a.b.base}`);
          if (at && at !== a.b.sha) console.log(`note: this branch is on ${at.slice(0, 12)}, not the recorded ${a.b.sha.slice(0, 12)}: an error the base fixed or added since reads differently until you rebase`);
        } else console.log(`baseline: off (${a.why}): the full check`);
        const pre = configValue('command-prefix');
        const prefix = pre && !isNone(pre) ? pre.trim() : '';
        let pass = true;
        for (const { dir, cmd } of list) {
          const run = B.runItem({ bin: binDir(), root: top, dir, cmd, lock: lockFor(row), prefix });
          if (!a.on) {
            if (run.out.trim()) console.log(run.out.trimEnd());
            console.log(`${run.code === 0 ? 'PASS' : 'FAIL'} ${dir === '.' ? '' : `${dir}: `}${cmd} (exit ${run.code})`);
            pass &&= run.code === 0;
            continue;
          }
          const entry = a.b.checks?.[name]?.find((e) => e.dir === dir && e.cmd === cmd);
          const r = B.compareRun({ entry, run, root: top, dir, cmd });
          for (const l of r.lines) console.log(l);
          pass &&= r.pass;
        }
        process.exitCode = pass ? 0 : 1;
        break;
      }
      case 'uuid':
        console.log(uuid());
        break;
      case 'default-mode': {
        const { mode, file } = sessionDefaultMode();
        console.log(`DEFAULT_MODE=${mode ?? 'unset'}`);
        console.log(`SOURCE=${file ?? 'none'}`);
        if (mode === 'dontAsk') { console.error(`WARNING: ${DONTASK_WARNING} (${file})`); process.exit(1); }
        break;
      }
      case 'port-in-use':
        process.exit((await portInUse(Number(args[0]))) ? 0 : 1);
        break;
      case 'ports': {
        // --cap: the worker cap /desk-setup has just been told, before it is written to the config.
        const slug = currentRepo().slug;
        const i = args.indexOf('--cap');
        const cap = (i >= 0 ? positiveInt(args[i + 1]) : null) ?? concurrencyLimits().cap;
        const others = repoPortClaims().filter((c) => c.slug !== slug);
        const port = positiveInt(configValue('dev-port'));
        const self = port ? { slug, port, last: port + cap } : null;
        for (const c of [...others, ...(self ? [self] : [])]) {
          console.log(`REPO\t${c.slug}\t${c.port}\tworkers ${c.port + 1}-${c.last}${c === self ? '\t(this repo)' : ''}`);
        }
        for (const c of self ? portClashes(self, others) : []) {
          console.log(`CLASH\t${c.slug}\t${c.port}\tworkers ${c.port + 1}-${c.last}`);
        }
        console.log(`PROPOSE\t${proposePort(cap, others) ?? 'none'}`);
        break;
      }
      case 'machine': {
        // The subcommand is always the first word, so a worker's `machine write` deny rule holds.
        const [sub, ...rest] = args;
        const key = rest.find((a) => a !== '--runner');
        const path = machineProfilePath();
        if (sub === 'get' || sub === 'why') {
          const v = sub === 'get' ? machineValue(String(key ?? '').toLowerCase()) : machineWhy(String(key ?? '').toLowerCase());
          if (v == null) process.exit(3);
          console.log(v);
          break;
        }
        if (!['detect', 'propose', 'write'].includes(sub)) {
          console.error('usage: desk-env.mjs machine detect|propose|write|get <key>|why <key>');
          process.exit(2);
        }
        const hw = M.gather();
        const profile = machineProfile();
        // The runner is off unless --runner asks for it or the profile already has one.
        const proposal = M.propose(hw, { runner: M.runnerChosen(profile, rest.includes('--runner')) });
        if (sub === 'detect') {
          for (const k of M.HARDWARE_KEYS) console.log(`${k.padEnd(18)} ${hw[k]}`);
          if (!profile) { console.log(`\nno profile at ${path}: desk-env machine propose shows the sizes it would write`); break; }
          const hwc = M.hardwareChanges(profile, hw);
          const szc = M.sizingChanges(profile, proposal);
          if (!hwc.length && !szc.length) { console.log(`\nunchanged since ${path}`); break; }
          if (hwc.length) console.log(`\nhardware changed since ${path}:`);
          for (const c of hwc) console.log(`  ${c.key}: ${c.was} -> ${c.now}`);
          if (szc.length) console.log('\nthe rules would now propose:');
          for (const c of szc) console.log(`  ${c.key}: ${c.was} -> ${c.now}`);
          console.log('\nre-propose the sizes: desk-env machine propose, then desk-env machine write once confirmed');
          break;
        }
        if (sub === 'propose') {
          for (const s of proposal) {
            const was = profile?.sizing[s.key]?.value;
            console.log(`${s.key.padEnd(27)} ${s.value.padEnd(8)} ${s.why}${was != null && was !== s.value ? `  (profile: ${was})` : ''}`);
          }
          break;
        }
        // write: overwrites; /desk-setup runs it only after the user confirms the proposal.
        mkdirSync(dirname(path), { recursive: true });
        const had = existsSync(path);
        if (had) copyFileSync(path, `${path}.bak`);
        writeFileSync(path, M.renderProfile(hw, proposal, new Date().toISOString().slice(0, 10)));
        console.log(`wrote ${path}${had ? ` (previous copy: ${path}.bak)` : ''}`);
        break;
      }
      default:
        console.error('usage: desk-env.mjs where|get|batch-base|list|cmds|perm|key|budget|ids|paths|identity|mem|heavy|uuid|port-in-use|ports|machine');
        process.exit(2);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(e instanceof DeskConfigError ? 4 : 1);
  }
}
