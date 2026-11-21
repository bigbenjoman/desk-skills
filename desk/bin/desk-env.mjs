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
// Every desk command that loads this module, and every shell script that sources desk-env.sh, takes
// `--batch <name>` to act on that named batch, as DESK_BATCH=<name> does (takeBatchArg).
//
// CLI (used by desk-env.sh, so there is one markdown parser, not two):
//   node desk-env.mjs where                   print SLUG=, GH_REPO=, CONFIG=, CREDS=, EXISTS= for the cwd's repo
//   node desk-env.mjs show [<section>...]     print the config's rules for the agent, then its headings and
//                                             table rows, no other prose
//                                             (configRows): the named sections (e.g. 3 5), else every one but
//                                             §3c, the rule ledger only /desk-setup reads; exit 3 with no config
//   node desk-env.mjs get <config id>         print the value (CONFIG_ROWS; first item), exit 3 if unset;
//                                             default-branch honours a batch base (DESK_DEFAULT_BRANCH);
//                                             review-asks prints every ask, one per line
//   node desk-env.mjs batch-base              print the queue's batch base branch, exit 3 if none is set
//   node desk-env.mjs levers [<lever>]        what is on and where each lever's state comes from (pinned,
//                                             auto or off), the freeze, unknown names; exit 1 on an invalid
//                                             row; with <lever>, on or off. A row unlike the last one the
//                                             repo's lever log recorded is logged as a row_change. With
//                                             `auto` in the row, a last `levers: …` line gives each managed
//                                             lever's state in this repo (lever-changes.mjs summaryLine)
//   node desk-env.mjs levers freeze|thaw [reason]  set or clear the machine-wide freeze
//                                             (~/.desk-autopilot/levers.freeze), logged in every repo's log
//   node desk-env.mjs lines <file> <A>[,<B>]  with the wrappers lever on, print what `sed -n A,Bp <file>`
//                                             prints, refusing a file a worker may not read; exit 3 lever off
//   node desk-env.mjs list <config id>        print every item of a list row, one per line, exit 3 if unset
//   node desk-env.mjs cmds <config id>        print each command item as DIR<TAB>CMD (nothing for `none`)
//   node desk-env.mjs required-fields <type>  print §4 Required fields for an issue type as JSON (requiredFields)
//   node desk-env.mjs branch-check <name>     exit 1, saying why, if the name is no usable ticket branch
//   node desk-env.mjs perm-or-unset <id>      as perm, but exit 3 (no output) when the row is unset
//   node desk-env.mjs ticket-kind <id>        print tracker|work-id|base|audit|issue|slug, exit 2 if the id is not accepted
//   node desk-env.mjs perm <permission id>    print yes|ask|no|never|stop, or merged for branch-delete (PERMISSION_KEYS; unset -> no),
//                                             exit 3 if no repo config is found
//   node desk-env.mjs key <permission id>     print the §3 key it maps to
//   node desk-env.mjs merge-grant             print config|batch|none, a tab, and why (mergeGrant); exit 1
//                                             when nothing may merge this batch's green PRs
//   node desk-env.mjs model finder|text       print §3b Worker models' finder or text model, `none` if
//                                             unset (no override), exit 4 if the row is malformed
//   node desk-env.mjs effort <start>          print the effort a worker session starting there runs at
//                                             (`default` with the lever off), exit 4 if §3b Worker
//                                             effort is malformed
//   node desk-env.mjs budget worker|batch     print USD or none; exit 4 if malformed
//   node desk-env.mjs config                  print what every get (but default-branch), list, perm,
//                                             perm-or-unset and budget prints, as shell assignments for
//                                             desk-env.sh's desk_load_config
//   node desk-env.mjs ids                     print every id, the row it maps to, and its value
//   node desk-env.mjs paths [--machine]       print KEY=value lines for the shell (--machine: only the ones
//                                             no repo is needed for, DESK_SKILLS_DIR among them). Outside
//                                             a configured repo: the machine ones, `# KEY unset` for the
//                                             rest, and exit 4
//   node desk-env.mjs take-batch [args...]    print, for desk_take_batch to eval, `export DESK_BATCH=` when
//                                             the args named one, then DESK_ARGS=( the args without it )
//   node desk-env.mjs identity                print GITHUB_HANDLE= and JIRA_NAME= (fails if unset)
//   node desk-env.mjs git-author              print §1 Git author name / email as NAME<TAB>EMAIL (gitAuthor);
//                                             exit 3 if unset or `none`, 4 if it is neither form
//   node desk-env.mjs mem <avail|used|rss|status>
//   node desk-env.mjs test-scope [--base <ref>]   what a worker tests before pushing: scope=related|full|none,
//                                             reason=, changed=, workspace= per uncovered workspace, then
//                                             DIR<TAB>CMD<TAB>FILES per suite to run (a workspace-test line per
//                                             uncovered one), then UNCOVERED<TAB>DIR<TAB>WHY per touched workspace
//                                             nothing runs
//   node desk-env.mjs workspace-test <dir>    run workspace package <dir>'s package.json test script there,
//                                             capped for Vitest or Jest; PASS|FAIL line
//   node desk-env.mjs baseline typecheck|lint  run §4 Typecheck or Lint here; with §4 Baseline checks on and a
//                                             recorded batch base, fail only on errors the base does not have
//   node desk-env.mjs mem watch [--interval s] [--window s]   runs until killed; prints SUSTAINED-HIGH
//                                             when avail stays under the band for the window (default 300s)
//                                             with nothing heavy running, and HEAVY-UNKNOWN while ps cannot be read
//                                             (harmStep) SWAP-GROWING, OOM-KILL, TMPFS-HIGH and TMPFS-INODES on
//                                             the harm signals, and OOM-UNKNOWN once when dmesg cannot be read
//   node desk-env.mjs uuid
//   node desk-env.mjs port-in-use <port>      exit 0 if something is listening
//   node desk-env.mjs ports [--cap <n>]       every repo config's dev port and worker block (REPO), each
//                                             one this repo's block meets (CLASH), and a free port (PROPOSE);
//                                             --cap sizes this repo's block instead of its concurrency row
//   node desk-env.mjs default-mode            print DEFAULT_MODE= and SOURCE= for the cwd's repo; exit 1 (with
//                                             the warning on stderr) when it is dontAsk
//   node desk-env.mjs drift [--all]           rows the template has that the config lacks (MISSING), `ask` rows
//                                             an unattended batch parks on (STALLS), §4 command items no worker
//                                             may run or, with worker-local-services yes, a Local services
//                                             item with no service name (UNLISTED), an app directory other command rows
//                                             name with no Dev server item (NODEV), a §4 Pre-merge steps item
//                                             keyed to a job of several steps (JOBKEY), a dontAsk settings file (DONTASK);
//                                             "no drift" and exit 0, else exit 1. --all: every repo
//   node desk-env.mjs drift --app <dir>       every §4 row that app needs to run for screenshots and lacks,
//                                             with the value to add: Dev server (NODEV) and the .env* files
//                                             its primary-checkout directory holds (NOENV); exit 1 if any
//   node desk-env.mjs add-row <section> <§3 key | "row name"> <value> [--note "<text>"]
//                                             add one row drift names MISSING, from the template, with that
//                                             value; prints ADDED, and a §3 row's perm read back
//   node desk-env.mjs machine detect         print this computer's hardware, and what changed since the profile
//   node desk-env.mjs machine propose         print the sizes the rules propose, with the arithmetic
//   node desk-env.mjs machine write [--drop-override <key>]...
//                                             write ~/.config/desk/machine.md (only after the user confirms),
//                                             keeping each override unless dropped, and naming the ones kept
//   node desk-env.mjs machine set <key>=<value>... [--reason "<text>"]
//                                             set the bench's bench-cap-points, bench-reserve-percent and
//                                             bench-run-limit-<provider> in the profile (only after the
//                                             user answers), or a proposed size as an override (its Why
//                                             "override: <reason>"); <size>= clears an override back to
//                                             the proposal. A bad value exits 1 naming it, and nothing
//                                             is written
//   node desk-env.mjs machine get|why <key>   print a profile value or its reason, exit 3 if there is none
//   node desk-env.mjs costs detect            print the GitHub repos, Vercel teams and projects and AWS
//                                             profiles this computer can see
//   node desk-env.mjs costs propose [edits]   print which name each source would be saved under, merged
//                                             with ~/.config/desk/costs.md; writes nothing
//   node desk-env.mjs costs write [edits]     write ~/.config/desk/costs.md (only after the user confirms);
//                                             edits: --name <supplier>:<key>=<name>, --drop <supplier>:<key>,
//                                             --actions-budget <usd>, --credit <profile>=<usd>@<YYYY-MM-DD>
//   node desk-env.mjs costs show [--json]     print the saved cost sources; a missing file is "no cost sources"
//   node desk-env.mjs logins list [--json]    print the Claude and Codex logins in ~/.config/desk/subscriptions.md,
//                                             each with its folder and default or unused; a missing file is
//                                             ~/.claude and ~/.codex. A file in the older rules (in rotation,
//                                             standby, off) is rewritten once as each tool's default and unused
//   node desk-env.mjs logins default <claude|codex> <name|account>
//                                             make one login its tool's default and its old default unused,
//                                             keeping the previous file as .bak
//   node desk-env.mjs logins check [--json]   as list, with each login's sign-in, account and plan, the signed-in
//                                             folders under ~/.claude-logins and ~/.codex-logins it does not list,
//                                             and the usable ones (logins.mjs)
//   node desk-env.mjs logins set <claude|codex> <name> <unused|off>
//                                             set one login unused or off, keeping the previous file as .bak;
//                                             the older rules (in rotation, standby) are refused
//   node desk-env.mjs logins remove <claude|codex> <name>
//                                             remove one login from the rules, leaving its folder and sign-in;
//                                             a folder under the logins folder is not found again; refused
//                                             while a repo's Subscription row runs on it
//   node desk-env.mjs preview-slot [--wait <s>] <label>
//                                             take the preview-build slot for §4 Vercel's team before a push
//                                             that starts a preview build, waiting up to <s> (default 600)
//                                             for the one in flight; nothing to take with no team (exit 0)
//   node desk-env.mjs subscription [--json]   print the Claude subscription this repo's work runs on as
//                                             SUBSCRIPTION=, LOGIN=, FOLDER=, CONFIG_DIR= and SOURCE=:
//                                             DESK_SUBSCRIPTION, then config §3b Subscription (`row`), then
//                                             this computer's default; exit 4 naming an email no login here
//                                             is signed in to
//   node desk-env.mjs subscription list [--json]
//                                             every repo's resolved subscription (row, default or unknown
//                                             email), ignoring DESK_SUBSCRIPTION
//   node desk-env.mjs subscription set <slug> <default|email>
//                                             write that repo's Subscription row, naming the previous value
import { readFileSync, readdirSync, existsSync, realpathSync, writeFileSync, mkdirSync, copyFileSync, renameSync, statSync, utimesSync, unlinkSync, statfsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { homedir, platform, totalmem, freemem, release } from 'node:os';
import { basename, dirname, join } from 'node:path';
import net from 'node:net';
import * as M from './machine.mjs';
import * as TS from './test-scope.mjs';
import { jobKeyedPremerge } from './workflow-yaml.mjs';
import {
  PERMISSION_KEYS, CONFIG_ROWS, MACHINE_FALLBACK, ROWS, norm, DeskConfigError, isNone, mixesNone, parseCommandItem, localServiceName,
  permValues, permValue, requiredFieldsIn, parseBudget, EXTRA_MODELS, parseWorkerModels, parseWorkerLocation, LEVERS, LEVERS_AUTO, leverRow, leverWords, parseLevers,
  EFFORTS, RESUME_STAGES, EFFORT_STARTS, parseWorkerEffort, CODEX_ROLES, CODEX_EFFORTS, CODEX_DEFAULTS, parseCodexReview, spawnGateOf,
  fileBudget as fileBudgetOf, gitAuthorOf, reviewAccountOf, gateReviewersOf,
} from './config-schema.mjs';

export const HOME = process.env.HOME || homedir();
export const expandHome = (p) => (typeof p === 'string' ? p.replace(/^~(?=\/|$)/, HOME) : p);
// Which files in a screenshot directory upload-images.mjs uploads, and so which mean it has images.
export const SCREENSHOT_FILE = /\.(png|jpe?g)$/i;

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

// An environment for a child run in another repo's checkout: every override that would pin it to
// this repo (its dir, config, Jira or git directory) removed, so the checkout decides.
export const otherRepoEnv = (env = process.env) => Object.fromEntries(Object.entries(env)
  .filter(([k]) => !/^(DESK_REPO|DESK_CONFIG$|JIRA_|GIT_DIR$|GIT_WORK_TREE$|GIT_CONFIG_(COUNT$|KEY_|VALUE_))/.test(k)));

export const repoConfigDir = (slug = currentRepo().slug) => (slug ? join(deskConfigRoot(), 'repos', slug) : null);
export const credsDir = () => repoConfigDir();

// A config file's headings and tables, without its prose: what a skill reads at its start. `sections`
// names the ones wanted ('3', '3b', '5'); empty is every section but 3c, the rule ledger, which
// grows with each rule setup grants, is kept in harness-rules.json too, and only /desk-setup reads.
// An unnumbered section (the rules for the agent reading the file) is printed whole, prose and all,
// when no section is named: its prose is what it says.
export function configRows(text, sections = []) {
  const want = sections.map((x) => String(x).replace(/^§/, '').toLowerCase());
  let keep = false, whole = false, fence = false;
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd();
    if (/^##\s/.test(line)) {
      fence = false;
      const id = /^##\s+(\d+[a-z]?)[.)]?\s/i.exec(line)?.[1]?.toLowerCase() ?? null;
      whole = id == null && !want.length;
      keep = id == null ? whole : want.length ? want.includes(id) : id !== '3c';
      if (keep) { if (out.length) out.push(''); out.push(line); }
      continue;
    }
    if (whole) { if (line.trim() !== '---') out.push(line); continue; }
    if (/^```/.test(line.trim())) { fence = !fence; continue; }
    if (fence) continue;
    if (/^#\s/.test(line) && !want.length) { out.push(line); continue; }
    if (!keep) continue;
    if (/^###\s/.test(line)) out.push('', line);
    else if (line.trim().startsWith('|')) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function configPathOrNull() {
  if (process.env.DESK_CONFIG) return expandHome(process.env.DESK_CONFIG);
  const d = repoConfigDir();
  return d ? join(d, 'config.md') : null;
}
const configPathHint = () =>
  configPathOrNull() ?? '(no repo: run inside the repo, or set DESK_REPO_DIR or DESK_CONFIG)';

// ---- the one map from what a script means to where the config says it ------------------------
// Scripts never name a config row directly. They name a logical id, and the schema
// (config-schema.mjs) is the only place that knows which row that is, so a row renamed by
// /desk-setup is a one-line edit there. PERMISSION_KEYS and CONFIG_ROWS are derived from it.
//
// §3 rows are matched by their stable Key column. §1, §2 and §3b have no key column, so their rows
// are matched by display name. Either way the match is EXACT (case, backticks and spacing aside):
// a near-miss must read as unset, never borrow a neighbouring row's value.
export { PERMISSION_KEYS, CONFIG_ROWS };
// The row grammars live in the schema as its types; each is re-exported here under its own name.
export {
  DeskConfigError, isNone, parseCommandItem, localServiceName, permValues, parseBudget, EXTRA_MODELS, parseWorkerModels,
  parseWorkerLocation, LEVERS, LEVERS_AUTO, leverRow, parseLevers, EFFORTS, RESUME_STAGES, EFFORT_STARTS, parseWorkerEffort, CODEX_ROLES, CODEX_EFFORTS,
  CODEX_DEFAULTS, parseCodexReview,
};

// No config file resolves (outside a repo, or setup never ran): nothing was read, so nothing may be
// read as a value. The CLI exits 3 on it, as for any lookup it cannot resolve.
export class NoRepoConfigError extends DeskConfigError {}

// ---- config parsing ------------------------------------------------------------------------
// The config is markdown written by /desk-setup and editable by hand: sections are `## <n>.`
// headings, rows are table rows, and the value is the first backtick span in the value column.
// The value column comes from the header ("Your setting", else "Value", else "Setting", else the
// second column) because §2's Notes and §3's Recommended columns also carry backticks, and taking
// the wrong one would read the suggestion as the user's answer. The row id is the "Key" column
// where the table has one, otherwise the first column.
let cache = null;
// `<section>/<heading>` of every table id, as tableLines normalises a `###` heading.
const TABLE_IDS = new Set(Object.values(CONFIG_ROWS).filter((r) => r.table).map((r) => `${r.section}/${norm(r.row)}`));

const { splitRow } = M;

function parseConfig() {
  if (cache) return cache;
  cache = parseConfigFile(configPathOrNull());
  return cache;
}

// Every table row of a config file's text, in order: the line it is on, its section, its table's
// header (normalised) and the header's line, its cells and its label. `declared` marks a row of a
// Key, Field or Role table: the rule ledger (§3c) and the review asks (§4) hold the user's own rows,
// so they are not declared rows. parseConfigFile reads values from it; addTemplateRow places rows by it.
function tableLines(text) {
  const out = { sections: [], rows: [] };
  let section = null, sub = null, header = null, table = null;
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    const h = /^##\s+(\d+[a-z]?)[.)]?\s/i.exec(line);
    if (h) { section = h[1].toLowerCase(); sub = null; header = null; out.sections.push(section); return; }
    const s = /^###\s+(.+)$/.exec(line);
    if (s) sub = norm(s[1]);
    if (!section || !line.startsWith('|')) { header = null; return; }
    const cells = splitRow(line);
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) return; // separator row
    if (!header) { header = cells.map(norm); table = i; return; }
    const label = (cells[0] ?? '').replace(/`/g, '').trim();
    out.rows.push({ i, section, sub, table, header, cells, label, declared: !!label && ['key', 'field', 'role'].includes(header[0]) });
  });
  return out;
}
// What a config file's text declares, for the schema's coverage check: its declared rows, and the
// `###` headings of its tables of the person's own rows (the §3c ledger has none).
export function declaredRows(text) {
  const { rows } = tableLines(String(text));
  const tables = new Map(rows.filter((r) => !r.declared && r.sub).map((r) => [`${r.section}/${r.sub}`, { section: r.section, heading: r.sub }]));
  return { rows: rows.filter((r) => r.declared).map(({ section, label }) => ({ section, label })), tables: [...tables.values()] };
}
const settingCol = (header) => ['your setting', 'value', 'setting'].map((n) => header.indexOf(n)).find((i) => i >= 0) ?? 1;

// Any config file, not only this repo's: `ports` reads every repo's to keep dev ports apart.
function parseConfigFile(path) {
  // `rows`: every declared row, in order, for `drift`.
  // `tables`: the cells of every row of a table id's `###` table (TABLE_IDS), by section and heading.
  const parsed = { path, exists: !!path && existsSync(path), sections: {}, rows: [], tables: {} };
  if (!parsed.exists) return parsed;
  const table = tableLines(readFileSync(path, 'utf8'));
  for (const section of table.sections) parsed.sections[section] ??= { byKey: {}, byName: {} };
  for (const { section, sub, header, cells, label, declared } of table.rows) {
    if (TABLE_IDS.has(`${section}/${sub}`)) { (parsed.tables[`${section}/${sub}`] ??= []).push(cells); continue; }
    const keyCol = header.indexOf('key');
    const items = cellItems(cells[settingCol(header)] ?? '');
    const s = parsed.sections[section];
    if (declared) parsed.rows.push({ section, byKey: header[0] === 'key', id: norm(label), label });
    // `value` is the first item (what every single-valued row means); `items` is every backtick span.
    const entry = { value: items[0], items };
    if (keyCol >= 0) { const k = norm(cells[keyCol] ?? ''); if (k) s.byKey[k] = entry; }
    else { const n = norm(cells[0] ?? ''); if (n) s.byName[n] = entry; }
  }
  return parsed;
}

// How many rows of a config file are unanswered: the value (first span of the value column, as every
// read takes it) is `TODO`. A TODO in a note, or in another column, is not one. The rows the template
// keeps `TODO` on purpose to follow the machine profile are not counted (MACHINE_FALLBACK_ROWS).
export const MACHINE_FALLBACK_ROWS = ROWS.filter((e) => e.machine).map((e) => norm(e.label));
export function unansweredRows(path) {
  if (!path || !existsSync(path)) return 0;
  return tableLines(readFileSync(path, 'utf8')).rows
    .filter(({ cells, label, header }) => !MACHINE_FALLBACK_ROWS.includes(norm(label)) && cellItems(cells[settingCol(header)] ?? '')[0] === 'TODO')
    .length;
}

// A value cell's items: every backtick span, except those in a trailing parenthesised note
// (`` `ABC` (not `parent`) `` is one item, ABC). With no spans, the whole cell is the one item.
export function cellItems(raw) {
  // The template's notes show list values as `` `A` `B` `` (a code span holding backticks);
  // copied into a value, the doubled backticks are display only. The note goes before they do, since
  // a note may hold longer runs they are part of. A cell has one trailing note, so a parenthesis before
  // it is value text (`` `A` (CI: `B`) (note) `` is A and B): only where none trailed the cell is one
  // looked for again after, a note inside that display form.
  const undoubled = (s) => s.replace(/``\s?/g, '').replace(/\s?``/g, '').trim();
  const whole = raw.trim();
  const noted = stripTrailingNote(whole);
  const cell = noted === whole ? stripTrailingNote(undoubled(whole)) : undoubled(noted);
  const spans = [...cell.matchAll(/`([^`]*)`/g)].map((m) => m[1].trim());
  return spans.length ? spans : [undoubled(raw)];
}

// The cell less a trailing `(…)` note, found by walking back from the closing paren to its match.
// Parens inside code spans are value text (a regex like `(-FIX)?`), so they are skipped. A
// cell that is only a note, or whose last paren never opens, is returned whole.
function stripTrailingNote(cell) {
  if (!cell.endsWith(')')) return cell;
  const inSpan = codeSpanMask(cell);
  let depth = 0;
  for (let i = cell.length - 1; i >= 0; i--) {
    if (inSpan[i]) continue;
    const c = cell[i];
    if (c === ')') depth++;
    else if (c === '(' && --depth === 0) return cell.slice(0, i).trim() ? cell.slice(0, i) : cell;
  }
  return cell;
}

// A code span as CommonMark reads one: a run of N backticks opens a span that closes at the next run of
// exactly N on its line, so ```` ```x ```` is one span; a run never closed is text. evidence.mjs reads
// a PR body's spans by it too.
export const CODE_SPAN = /(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g;

// Which characters sit inside a code span.
function codeSpanMask(s) {
  const mask = new Array(s.length).fill(false);
  for (const m of s.matchAll(CODE_SPAN)) mask.fill(true, m.index, m.index + m[0].length);
  return mask;
}

const unset = (v) => v == null || v === '' || /^todo\b/i.test(v);

function rowFor(id) {
  const r = CONFIG_ROWS[id];
  if (!r) throw new Error(`desk-env: unknown config id "${id}" (known: ${Object.keys(CONFIG_ROWS).join(', ')})`);
  return r;
}

// `<slug>` in a value (the template's own path examples) means this repo's slug. Not in §5 Branch
// names, where it is the ticket's own short slug.
const NO_SLUG_EXPANSION = new Set(['branch-names']);
const expandSlug = (v) => (typeof v === 'string' && v.includes('<slug>') && currentRepo().slug
  ? v.replaceAll('<slug>', currentRepo().slug) : v);

// ---- the machine profile -------------------------------------------------------------------
// One per computer, beside the repo configs. §3b rows that are about the computer rather than the
// repo fall back to it when the repo leaves them TODO or absent; a set repo row wins, and with no
// profile they read as unset exactly as before. The memory ceiling is the exception: the profile's
// is a hard limit across every repo, so a repo row may set it lower, never higher (machineLimited).
export const machineProfilePath = () => expandHome(process.env.DESK_MACHINE ?? join(deskConfigRoot(), 'machine.md'));
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
// How many runs may hold the test lock at once: DESK_TEST_LOCK_SLOTS when set, else the profile's
// test-lock-slots; anything but a whole number from 1 is 1. with-lock.sh is this rule's shell twin.
export function testLockSlots() {
  const v = String(process.env.DESK_TEST_LOCK_SLOTS || machineValue('test-lock-slots') || '').trim();
  return /^\d+$/.test(v) && Number(v) >= 1 ? Number(v) : 1;
}

// ---- cost sources --------------------------------------------------------------------------
// One per computer, beside the machine profile: which GitHub repo, Vercel team and AWS profile bill
// each name, across every repo. Read it with costs.mjs's readCosts(costsPath()); a missing file
// reads as no cost sources. costs.mjs is imported only by the `costs` command, so the scripts that
// copy this file on its own need nothing new.
export const costsPath = () => expandHome(process.env.DESK_COSTS ?? join(deskConfigRoot(), 'costs.md'));
// The Claude and Codex logins desk may use, one file per computer beside costs.md: read and change
// it with logins.mjs, which only the `logins` and `subscription` commands import. A missing file is the
// default logins.
export const subscriptionsPath = () => expandHome(process.env.DESK_SUBSCRIPTIONS ?? join(deskConfigRoot(), 'subscriptions.md'));
// Every configured repo: its config file and §0 GitHub repo (the slug's, where the row is unset).
export function configuredRepos(root = deskConfigRoot()) {
  let slugs = [];
  try { slugs = readdirSync(join(root, 'repos')).sort(); } catch { return []; }
  return slugs.map((slug) => ({ slug, config: join(root, 'repos', slug, 'config.md') }))
    .filter((r) => existsSync(r.config))
    .map((r) => ({ ...r, ghRepo: repoConfigValue(r.slug, 'gh-repo', root) ?? r.slug.replace('__', '/') }));
}

// Where a ticket's Jira Repository field (ticket-facts.mjs `repository`) sends it, matched against each
// configured repo's GitHub repo by its name, or whole where the field is `owner/name`, case aside:
// null when the field is empty or names this repo; {repository, slug, ghRepo, root} for one other
// configured repo (root its §2 Primary repo root, or null); {repository, unknown: true, slugs} where
// no configured repo has that name, or several do.
export function repoPlacement(repository, root = deskConfigRoot()) {
  const want = String(repository ?? '').trim().toLowerCase();
  if (!want) return null;
  const names = (g) => {
    const s = String(g ?? '').trim().toLowerCase();
    return !!s && (want.includes('/') ? s === want : s.split('/').pop() === want);
  };
  const self = currentRepo();
  let own = null;
  try { own = configValue('gh-repo'); } catch { /* no config here: the remote decides */ }
  const repos = configuredRepos(root);
  if (names(self.ownerRepo) || names(own) || repos.some((r) => r.slug === self.slug && names(r.ghRepo))) return null;
  const hits = repos.filter((r) => r.slug !== self.slug && names(r.ghRepo));
  if (hits.length !== 1) return { repository, unknown: true, slugs: hits.map((r) => r.slug) };
  const dir = String(repoConfigValue(hits[0].slug, 'repo-root', root) ?? '').trim();
  return { repository, slug: hits[0].slug, ghRepo: hits[0].ghRepo, root: dir && !isNone(dir) ? expandHome(dir) : null };
}

// Where a triage record puts a ticket's code when that is wholly another repo, or null to build it
// here: repoPlacement's answer for that repo, with `why`. Every files_in_scope entry prefixed
// `<repo>: ` with the same name that is not this repo's sends it there, and so does a scope call
// whose choice says to run it in exactly one other configured repo and names this one only as where
// it is taken from. Entries in this repo and another build here. Prefixes naming no configured repo
// give {unknown: true, names, why}.
export function triagePlacement(rec, root = deskConfigRoot()) {
  if (!rec || typeof rec !== 'object') return null;
  // Each entry's repo: null for this one (no prefix, this repo's name, or a prefix that is a path's,
  // with a slash or a file extension, and no configured repo's).
  const repoOf = (f) => {
    const name = String(f).match(/^\s*([A-Za-z0-9][\w.-]*(?:\/[\w.-]+)?):\s+\S/)?.[1];
    const p = name ? repoPlacement(name, root) : null;
    return p && !(p.unknown && /\/|\.\w{1,5}$/.test(name)) ? { name, p } : null;
  };
  const files = (Array.isArray(rec.files_in_scope) ? rec.files_in_scope : []).map(String).filter((f) => f.trim());
  const away = files.map(repoOf).filter(Boolean);
  if (away.length && away.length < files.length) return null;
  if (away.length) {
    const names = [...new Set(away.map((a) => a.name))];
    const unknown = [...new Map(away.filter((a) => a.p.unknown).map((a) => [a.name, a.p.slugs])).entries()];
    const slugs = new Set(away.filter((a) => !a.p.unknown).map((a) => a.p.slug));
    if (!unknown.length && slugs.size === 1) return { ...away[0].p, why: `its files in scope are all in ${away[0].p.ghRepo}` };
    const isWhat = ([n, s]) => `${n} is ${s.length ? `the name of ${s.length} repos configured on this computer (${s.join(', ')})` : 'no repo configured on this computer'}`;
    return { unknown: true, names, why: unknown.length
      ? `its files in scope are all in ${names.join(', ')}, and ${unknown.map(isWhat).join('; ')}`
      : `its files in scope are all in other repos, split across ${names.join(', ')}` };
  }
  const calls = (Array.isArray(rec.decided) ? rec.decided : []).filter((d) => d?.category === 'scope' && typeof d.chose === 'string' && /\b(run|runs|running|batch)\b/i.test(d.chose));
  if (!calls.length) return null;
  const self = currentRepo();
  let own = null;
  try { own = configValue('gh-repo'); } catch { /* no config here: the remote decides */ }
  const repos = configuredRepos(root);
  const namesOf = (slug, gh) => [slug?.split('__').slice(1).join('__'), gh, String(gh ?? '').split('/').pop()].filter(Boolean);
  const selfNames = [...namesOf(self.slug, self.ownerRepo), ...(own ? namesOf(null, own) : [])];
  const named = (text, names) => names.some((n) => new RegExp(`(?<![\\w.-])${escapeRe(n)}(?![\\w-])`, 'i').test(text));
  for (const d of calls) {
    const fromSelf = new RegExp(`\\bfrom\\s+(?:this\\s+|the\\s+)?(?:${selfNames.map(escapeRe).join('|')})(?![\\w-])`, 'gi');
    if (selfNames.length && named(d.chose.replace(fromSelf, ''), selfNames)) continue;
    const hits = repos.filter((r) => r.slug !== self.slug && !selfNames.some((n) => n.toLowerCase() === r.ghRepo.toLowerCase()) && named(d.chose, namesOf(r.slug, r.ghRepo)));
    if (hits.length !== 1) continue;
    const p = repoPlacement(hits[0].ghRepo, root);
    if (p && !p.unknown) return { ...p, why: `triage decided to run it in ${p.ghRepo} ("${d.chose.trim()}")` };
  }
  return null;
}

// Admits `key` into the other configured repo `p` (repoPlacement's answer) by intake.mjs admit, run in
// that repo's checkout with nothing of this repo's in its environment: {ok, line} or {ok: false, why, cmd}.
export function admitInRepo(p, key, { by }) {
  const intake = join(runBin(), 'intake.mjs');
  // This repo's copy is dropped once the admit is made, so it does not refuse it (batches.mjs belongsElsewhere).
  const from = currentRepo().slug ?? '';
  const cmd = `cd ${p.root ?? `<${p.ghRepo}'s checkout>`} && DESK_ADMIT_FROM=${from} node ${join(binDir(), 'intake.mjs')} admit ${key} --by ${by}`;
  if (!p.root || !existsSync(p.root)) return { ok: false, why: `${p.ghRepo}'s checkout (its config §2 Primary repo root) is ${p.root ? `not at ${p.root}` : 'unset'}`, cmd };
  const env = otherRepoEnv();
  for (const k of [...PER_REPO_ENV, 'DESK_AUTOPILOT_STATE', 'AUTOPILOT_WRITE_QUEUE']) delete env[k];
  Object.assign(env, { DESK_REPO_DIR: p.root, DESK_REPO_ROOT: p.root, DESK_ADMIT_FROM: from });
  const x = spawnSync(process.execPath, [intake, 'admit', key, '--by', by, '--json'], { cwd: p.root, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  let out = null;
  try { out = JSON.parse(String(x.stdout ?? '').trim().split('\n').pop()); } catch { /* no report: the exit and stderr say why */ }
  const mine = (out?.lines ?? []).filter((l) => l.includes(key));
  if (x.status === 0 && out?.admitted?.includes(key)) return { ok: true, line: mine.find((l) => /^admitted /.test(l)) ?? `admitted ${key}` };
  // Already in one of that repo's batches (its own intake, or a person, admitted it there first).
  const there = mine.find((l) => l.startsWith(`${key} is already in batch `));
  if (x.status === 0 && there) return { ok: true, line: there };
  const why = out?.error ?? mine.at(-1) ?? (x.error?.message || String(x.stderr ?? '').trim().split('\n').pop() || `intake.mjs exited ${x.status}`);
  return { ok: false, why, cmd };
}

// The per-computer files' write: the previous copy kept beside it as <path>.bak.
function writeWithBackup(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const had = existsSync(path);
  if (had) copyFileSync(path, `${path}.bak`);
  writeFileSync(path, text);
  return `wrote ${path}${had ? ` (previous copy: ${path}.bak)` : ''}`;
}

// Exact lookup by logical id. Unset (missing row, blank, TODO) is null. The first item only: use
// configValues for rows that hold a list (Required checks, Env files, several commands).
export function configValue(id) {
  const parsed = parseConfig();
  if (id === 'suite-weight') return suiteWeightIn(parsed, configRepoRoot(parsed)).value;
  return configValueIn(parsed, id);
}

// The main checkout a config's repo settings live in: its §2 Primary repo root, else (with `cwd`,
// for the cwd's own repo) the cwd's checkout, else null.
const configRepoRoot = (parsed, { cwd = true } = {}) => {
  const row = configValueIn(parsed, 'repo-root');
  if (row) return expandHome(row);
  return cwd ? git(currentRepo().dir, 'rev-parse', '--show-toplevel') || null : null;
};

// §4 Suite weight describes the repo's suites, so the repo's committed settings carry it, as
// env.DESK_SUITE_WEIGHT in <root>/.claude/settings.json. -> { value, file } or null when unset.
export function committedSuiteWeight(root) {
  if (!root) return null;
  const file = join(root, '.claude', 'settings.json');
  let v;
  try { v = JSON.parse(readFileSync(file, 'utf8'))?.env?.DESK_SUITE_WEIGHT; }
  catch { return null; } // missing or unreadable: no committed value
  return typeof v === 'string' && v.trim() ? { value: v.trim().toLowerCase(), file } : null;
}

// The committed value wins over the config's row; with neither, `heavy`.
// -> { value, committed: {value, file} | null, row: the config's value | null }
export function suiteWeightIn(parsed, root) {
  const committed = committedSuiteWeight(root);
  const row = repoValueIn(parsed, 'suite-weight')?.trim().toLowerCase() ?? null;
  return { value: committed?.value ?? row ?? 'heavy', committed, row };
}

function configValueIn(parsed, id) {
  const own = repoValueIn(parsed, id);
  if (own != null) return id === 'memory-ceiling' ? machineLimited(own).value : own;
  return MACHINE_FALLBACK[id] ? machineValue(MACHINE_FALLBACK[id]) : null;
}
// The repo's own row, with no machine fallback. Unset is null.
function repoValueIn(parsed, id) {
  const { section, row, table } = rowFor(id);
  if (table) return tableItemsIn(parsed, id)?.join('\n') ?? null;
  const e = parsed.sections[section]?.byName[norm(row)];
  if (unset(e?.value)) return null;
  return NO_SLUG_EXPANSION.has(id) ? e.value : expandSlug(e.value);
}

// A repo memory ceiling above the machine profile's reads as the machine's.
//   -> { value, repo: GB | null, machine: GB | null, limited }
const gbOf = (v) => { const n = Number(/\d+(\.\d+)?/.exec(String(v ?? ''))?.[0]); return n > 0 ? n : null; };
function machineLimited(own) {
  const repo = gbOf(own);
  const machine = gbOf(machineValue('memory-ceiling-gb'));
  const limited = repo != null && machine != null && repo > machine;
  return { value: limited ? String(machine) : own, repo, machine, limited };
}

// This repo's memory ceiling, and the report line naming whose figure it is. DESK_MEM_CEILING_GB
// overrides; then this repo's row, at most the machine profile's; then the profile's; then 16.
//   -> { gb, line }
export function memoryCeiling() {
  const env = gbOf(process.env.DESK_MEM_CEILING_GB);
  const { repo, machine, limited } = machineLimited(repoValueIn(parseConfig(), 'memory-ceiling'));
  const row = `config §3b "${CONFIG_ROWS['memory-ceiling'].row}"`;
  if (env != null) return { gb: env, line: `memory ceiling ${env}G (DESK_MEM_CEILING_GB)` };
  if (limited) return { gb: machine, line: `memory ceiling ${machine}G, the machine profile's limit (this repo's ${row} says ${repo}G, and a repo may not raise the machine's)` };
  if (repo != null) return { gb: repo, line: `memory ceiling ${repo}G (${row}${machine != null ? `, within the machine's ${machine}G` : ''})` };
  if (machine != null) return { gb: machine, line: `memory ceiling ${machine}G, the machine profile's limit` };
  return { gb: 16, line: `memory ceiling 16G (the default: no ${row} and no machine profile)` };
}

// Every item of a row, one per backtick span, in order. Items are never split on commas: a check
// can be called `Lint, Type Check & Build`. Unset is null; `none` is ['none'] (callers test isNone).
export function configValues(id) {
  return configValuesIn(parseConfig(), id);
}

// A labels row's items, lowercased: [] when the row is unset or `none`, and with no config. Read from
// this repo's config, or from repo `slug`'s where one is given.
function labelsRow(id, slug = null) {
  try { return [].concat((slug == null ? configValues(id) : repoConfigValues(slug, id)) ?? []).filter((v) => v && !isNone(v)).map((v) => String(v).trim().toLowerCase()); }
  catch { return []; }
}
// §4 Person-step labels: the labels marking a ticket as a step only the person takes, which holds the
// merge of a ticket it blocks (batch-state.mjs labelPark, personStep).
export function personStepLabels(slug = null) { return labelsRow('person-step-labels', slug); }
// §4 Person-input labels: a step only the person takes that produces something the build reads (a
// fixture, a recorded response, a key), which holds the build of a ticket it blocks.
export function personInputLabels(slug = null) { return labelsRow('person-input-labels', slug); }

// §4 Required fields for an issue type, or for every type with none named: {need: [field id, in rule order],
// malformed: [item that is not `<Type>[, <Type>…]: <field>[, <field>…]`]}. No config reads as no rules. The
// one reader of this row's grammar.
export function requiredFields(type) {
  let rules = [];
  try { rules = [].concat(configValues('jira-required-fields') ?? []).filter((r) => r && !isNone(r)); } catch { /* no config: no rules */ }
  return requiredFieldsIn(rules, type);
}

// A table id's rows as `<first cell>: <second cell>`, or the first cell alone when the second is
// blank, a dash or a placeholder. A first cell that is TODO or the "Not mined" placeholder setup
// writes is no row; with no rows left the table is unset (null).
const tableCell = (c) => { const v = (c ?? '').trim(); const m = /^`([^`]*)`$/.exec(v); return (m ? m[1] : v).trim(); };
const placeholder = (v) => unset(v) || /^not mined\b/i.test(v) || /^[-—–]$/.test(v);
function tableItemsIn(parsed, id) {
  const { section, row } = rowFor(id);
  const items = (parsed.tables?.[`${section}/${norm(row)}`] ?? [])
    .map((cells) => [tableCell(cells[0]), tableCell(cells[1])])
    .filter(([a]) => !placeholder(a))
    .map(([a, d]) => (placeholder(d) ? a : `${a}: ${d}`));
  return items.length ? items : null;
}

function configValuesIn(parsed, id) {
  const { section, row, table } = rowFor(id);
  if (table) return tableItemsIn(parsed, id);
  const e = parsed.sections[section]?.byName[norm(row)];
  if (!e || unset(e.value)) return null;
  const items = e.items.filter((x) => !unset(x)).map(expandSlug);
  // `none` beside other items is a note written in backticks: every span is an item, so the note
  // would be read as a command or check. Refuse rather than guess which one was meant.
  if (mixesNone(items)) {
    throw new DeskConfigError(
      `desk: config §${section} "${row}" mixes \`none\` with other items (${items.join(' | ')}) in ${parsed.path || configPathHint()}. ` +
        '`none` must stand alone: move the note out of backticks, e.g. `none` (the note in plain text). Refusing to guess.',
    );
  }
  return items;
}
// The preview-build slot (leases.mjs preview-build, one pool per §4 Vercel team, sized by the machine's
// preview-build-slots row, default 1): a push that starts a preview build takes it first, so builds on
// a shared builder never run at once and kill each other. It has no owner, since the build runs on
// Vercel after the pusher exits, and lapses after PREVIEW_TTL_S unless released. It is labelled by
// previewLabel, and taking it again under the same label renews that unit (leases.mjs sameHolder), so
// all of one PR's builds hold one unit. Null where §4 Vercel names no team (unset, TODO or none).
export const PREVIEW_TTL_S = 1200;
// How long `desk-env preview-slot` waits by default for the build in flight.
export const PREVIEW_WAIT_S = 600;
// A preview-build unit's label: `<owner/repo>#<PR>` once the PR exists, `<owner/repo>@<branch>` before.
export const previewLabel = (repo, { pr = null, branch = '' } = {}) => (pr != null && pr !== '' ? `${repo}#${pr}` : `${repo}@${branch}`);
export function previewTeam() {
  let v;
  try { v = configValues('vercel'); } catch { return null; }
  const team = [].concat(v ?? [])[0];
  return !team || isNone(v) || /^TODO\b/.test(String(team)) ? null : String(team).trim();
}
export function previewSlotArgs(label, wait) {
  const team = previewTeam();
  return team && ['acquire', 'preview-build', team, '--ttl', String(PREVIEW_TTL_S), '--wait', String(wait), '--no-owner', '--label', label];
}

// §4 Command prefix, '' with the row unset or `none`.
export function commandPrefix() {
  const pre = configValue('command-prefix');
  return pre && !isNone(pre) ? pre.trim() : '';
}

// key=value pairs, as the §4 Clean review verdict row writes them.
export function pairs(text) {
  return Object.fromEntries([...String(text ?? '').matchAll(/([a-z0-9_]+)=(\S+)/gi)].map((m) => [m[1], m[2]]));
}

// Whether a §4 Local review command item posts a desk-review verdict marker: /desk-review does, and a
// review skill the repo ships does where its SKILL.md names the marker.
export function postsVerdict(item, root) {
  const name = /^\/([\w-]+)(?=\s|$)/.exec(String(item ?? '').trim())?.[1];
  if (!name) return false;
  if (name === 'desk-review') return true;
  return ['.agents', '.claude'].some((d) => {
    try { return readFileSync(join(root, d, 'skills', name, 'SKILL.md'), 'utf8').includes('desk-review:verdict'); } catch { return false; }
  });
}

// The review to run and post, under §4 Local review command (`rows`, its items) and §4 Clean review
// verdict (`clean`): { run, clash }. A verdict row in counts form reads only a desk-review verdict
// marker, so with no item that posts one `run` is /desk-review and `clash` says the rows contradict
// each other. `run` is `none` with no review, and null with the row unset.
export function reviewPlan(rows, clean, root) {
  const items = [].concat(rows ?? []);
  if (!items.length) return { run: null, clash: null };
  if (isNone(items) || !Object.keys(pairs(clean)).length) return { run: items[0], clash: null };
  const posting = items.find((x) => postsVerdict(x, root));
  if (posting) return { run: posting, clash: null };
  return {
    run: '/desk-review',
    clash: `config §4 Local review command (${items.map((x) => `\`${x}\``).join(' ')}) and §4 Clean review verdict (\`${clean}\`) contradict each other: that verdict reads only a desk-review verdict marker, and that command posts none, so workers run /desk-review in its place. Run /desk-setup to set §4 Local review command to /desk-review`,
  };
}

// The lock a §4 command row's items take under with-lock.sh; every other row runs `nolock`.
export const LOCK_OF = { 'test-cmd': 'test', 'related-test-cmd': 'test', 'integration-cmd': 'test', 'typecheck-cmd': 'tsc', 'lint-cmd': 'tsc', 'e2e-cmd': 'browser', 'storybook-cmd': 'browser' };
// Rows a worker runs only under their lock, never bare. A type-aware lint is as heavy as a typecheck.
export const LOCK_ONLY = new Set(['storybook-cmd', 'lint-cmd']);
export const lockFor = (id) => LOCK_OF[id] ?? 'nolock';
// The linters a worker runs as a node_modules binary, only under `with-lock.sh tsc`: worker-settings.mjs
// allows them there, and slot-lease.mjs gives each run a `lint` slot.
export const LINT_BINS = Object.freeze(['eslint', 'biome', 'oxlint', 'stylelint']);

// The §4 command rows a worker may run (migrate and seed only against a per-ticket database). Its
// settings allow each item as the exact configured command, so an item must be one plain command.
export const WORKER_COMMAND_IDS = ['install-cmd', 'dev-cmd', 'typecheck-cmd', 'lint-cmd', 'test-cmd', 'related-test-cmd', 'integration-cmd', 'e2e-cmd', 'storybook-cmd', 'build-cmd', 'codegen-cmd', 'agents-sync',
  'merged-tree-check-cmd', 'pr-description-checks', 'db-migrate-cmd', 'seed-cmd'];
// Never allowed even as the exact configured command: a prefix rule for `rm -rf build` also matches
// `rm -rf build /`, and a shell, fetcher or privilege tool is an allow-everything. git, gh and docker
// have their own rules.
export const NO_EXACT = new Set(['rm', 'sudo', 'doas', 'curl', 'wget', 'eval', 'exec', 'xargs', 'env', 'git', 'gh', 'docker',
  'cd', 'source', '.', 'sh', 'bash', 'zsh', 'dash', 'fish', 'nohup', 'time', 'timeout', 'npx', 'pnpx', 'bunx', 'uvx']);
// The one shell form a toolchain item may take: `bash|sh <repo-relative .sh path>`, no flags. It runs a
// file in the worktree, the same exposure as `pnpm test`; a flag or command string (`bash -c`) never matches.
export const SHELL_SCRIPT = /^(bash|sh) (?![-/])(?!(.*\/)?\.\.(\/|$))[A-Za-z0-9._/-]+\.sh$/;
// Why a command item's command (parseCommandItem's cmd) can never be allow-listed, or null when it can.
export function commandItemProblem(cmd) {
  if (/&&|\|\||[;|<>`]|\$\(/.test(cmd) || /^\s*\w+=/.test(cmd)) return 'is a compound or env-prefixed shell command — not allow-listed; write it as `<dir>: <command>`, or put it in a script run as `bash <path>.sh`';
  const bin = cmd.split(/\s+/)[0];
  if (NO_EXACT.has(bin) && !SHELL_SCRIPT.test(cmd)) return `starts with ${bin}, which is never allow-listed`;
  return null;
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
// is a `no`. An id this file does not know is a bug in the caller, so it throws. With no config at
// all it throws NoRepoConfigError: an unread grant is not a refusal.
export function permission(id) {
  const parsed = parseConfig();
  if (!parsed.exists) {
    throw new NoRepoConfigError(`desk: no repo config found at ${configPathHint()}, so permission "${id}" cannot be read. Run inside the repo, or /desk-setup.`);
  }
  return permissionIn(parsed, id);
}
// Another repo's §3 row, by slug, read as permission() reads this repo's: no config is a `no`.
export const repoPermission = (slug, id, root = deskConfigRoot()) => permissionIn(parseConfigFile(join(root, 'repos', slug, 'config.md')), id);
// Whether a §3 row is absent from a config that exists: never asked, so it reads as `no`, and
// /desk-update asks it (drift names it MISSING). A blank or TODO row is present: /desk-setup's to set.
const rowMissing = (parsed, id) => parsed.exists && !parsed.sections?.['3']?.byKey[norm(PERMISSION_KEYS[id] ?? id)];
export const permissionMissing = (id) => rowMissing(parseConfig(), id);
// Another repo's, by slug; false with no config.
export const repoPermissionUnset = (slug, id, root = deskConfigRoot()) => rowMissing(parseConfigFile(join(root, 'repos', slug, 'config.md')), id);
// Whether <base> already holds all <head> has: merging head into base changes base's tree in nothing.
// A squash or rebase merge leaves no ancestry, so this is the test that it landed. `git` is
// (...args) -> {ok, out}.
export function baseHolds(git, base, head) {
  const baseTree = git('rev-parse', `${base}^{tree}`);
  const tree = git('merge-tree', '--write-tree', base, head);
  return baseTree.ok && tree.ok && tree.out.split('\n')[0] === baseTree.out;
}
function permissionIn(parsed, id) {
  const key = PERMISSION_KEYS[id];
  if (!key) throw new Error(`desk-env: unknown permission id "${id}" (known: ${Object.keys(PERMISSION_KEYS).join(', ')})`);
  const v = parsed.sections?.['3']?.byKey[norm(key)]?.value;
  if (unset(v)) return 'no';
  return permValue(key, v);
}
// Tri-state for guard rows, where "unset" must mean the strict default rather than `no`:
// returns yes|ask|no|never|stop, or null when the row is missing, blank or TODO. A value it cannot
// read is a `no`, as in permission(): a typo must never borrow the unset default.
export function permissionOrUnset(id) {
  const key = PERMISSION_KEYS[id];
  if (!key) throw new Error(`desk-env: unknown permission id "${id}" (known: ${Object.keys(PERMISSION_KEYS).join(', ')})`);
  const v = parseConfig().sections['3']?.byKey[norm(key)]?.value;
  if (unset(v)) return null;
  return permValue(key, v);
}
export const permissionKey = (id) => PERMISSION_KEYS[id];

// The merge driver holding <state>/merge-driver.lock.d: its pid while that process lives (one another
// user owns counts), 'starting' for a lock made under a minute ago that has no pid yet, else null.
export function mergeDriverHolder(state) {
  const d = join(state, 'merge-driver.lock.d');
  if (!existsSync(d)) return null;
  const pid = Number((() => { try { return readFileSync(join(d, 'pid'), 'utf8').trim(); } catch { return ''; } })());
  if (pid) { try { process.kill(pid, 0); return pid; } catch (e) { return e.code === 'EPERM' ? pid : null; } }
  try { return Date.now() - statSync(d).mtimeMs < 60_000 ? 'starting' : null; } catch { return null; }
}
// The command that releases a held ticket by hand, as the merge driver releases one whose blockers
// merged. `queue` is how the caller names queue.mjs.
export const releaseCommand = (key, queue = 'queue.mjs') => `${queue} set ${key} state=triaged park=null held_by=null, then ${queue} front ${key}`;

// Whether a batch's green PRs merge without the person: config §3 autopilot-merge and pr-merge-green
// both `yes`, or each `yes` or `ask` with the batch's Stage 3 approval (the queue's approved.merge).
// The approval lasts one batch: queue.mjs init starts the next without it. `why` names the rows, and
// how the batch answered where they are `ask`. `perm` reads the rows: another repo's for desk-q.
//   -> { by: 'config' | 'batch' | null, why }
const MERGE_GRANT_ROWS = ['autopilot-merge', 'pr-merge-green'];
export function mergeGrant(q = readQueueOrNull(), perm = permission) {
  const rows = MERGE_GRANT_ROWS.map((id) => ({ key: permissionKey(id), v: perm(id) }));
  const said = (list) => `config §3 ${list.map((r) => `${r.key} is "${r.v}"`).join(' and ')}`;
  if (rows.every((r) => r.v === 'yes')) return { by: 'config', why: said(rows) };
  const off = rows.filter((r) => r.v !== 'yes' && r.v !== 'ask');
  if (off.length) return { by: null, why: said(off) };
  const asked = said(rows.filter((r) => r.v === 'ask'));
  const a = q?.approved?.merge;
  if (a === true) return { by: 'batch', why: `${asked}, and merging was approved for this batch at Stage 3` };
  return { by: null, why: `${asked}${a === false ? ', and merging was declined for this batch at Stage 3' : ' with no batch approval'}` };
}

// The value a row's reader here falls back to when the row is unset: its schema entry's default.
const rowDefault = (id) => ROWS.find((e) => e.id === id).default;

// The §3b spend guards, each read by parseBudget (config-schema.mjs).
export const workerBudget = () => parseBudget(resolve({ env: 'AUTOPILOT_BUDGET_USD', id: 'worker-budget', fallback: rowDefault('worker-budget') }), 'the per-worker budget');
export const BATCH_BUDGET_LABEL = 'the batch budget';
export const batchBudgetRaw = () => resolve({ env: 'AUTOPILOT_BATCH_BUDGET_USD', id: 'batch-budget', fallback: rowDefault('batch-budget') });
export const batchBudget = () => parseBudget(batchBudgetRaw(), BATCH_BUDGET_LABEL);

// §3b Worker models, Worker location and Phase 0 levers, each read by its grammar in config-schema.mjs.
export const workerModels = () => parseWorkerModels(resolve({ id: 'worker-models', fallback: rowDefault('worker-models') }));
export const workerLocation = () => parseWorkerLocation(resolve({ id: 'worker-location', fallback: rowDefault('worker-location') }));
// The levers row's items, or null with no row or no config.
const leverItems = () => {
  try { return configValues('levers'); } catch (e) { if (e instanceof NoRepoConfigError) return null; throw e; }
};
// A worker reads its ticket's pin (lever-pin.mjs), which spawn-worker.sh exports as DESK_LEVERS
// (`none` for an empty set), not the row; with DESK_LEVERS unset the row stands.
export function levers(env = process.env) {
  return parseLevers(env.DESK_LEVERS != null ? [env.DESK_LEVERS] : leverItems());
}
export const leverOn = (name, l = levers()) => l.on.includes(name);

// Where each lever's state comes from: `pinned` (named in the row, or in this ticket's pin), `auto`
// (the row reads `auto` and does not name it) or `off`. `from` is `pin` inside a pinned worker, else
// `row`; `row` is the row as written, null when unset.
//   -> { from, row, states: { <lever>: 'pinned' | 'auto' | 'off' }, unknown, invalid }
export function leverStates(env = process.env) {
  const pin = env.DESK_LEVERS != null;
  const items = pin ? [env.DESK_LEVERS] : leverItems();
  const r = leverRow(items);
  return { from: pin ? 'pin' : 'row', row: items?.length ? items.join(' ') : null, states: statesOfRow(r, { auto: !pin }), unknown: r.unknown, invalid: r.invalid };
}
// Each lever's state from a parsed levers row (`leverRow`): `auto: false` reads a pin, where `auto`
// never applies. `rowStates` is the same for any repo's row items, as the evaluation reads them.
const statesOfRow = (r, { auto = true } = {}) =>
  Object.fromEntries(LEVERS.map((n) => [n, r.on.includes(n) ? 'pinned' : auto && r.auto && !r.invalid ? 'auto' : 'off']));
export const rowStates = (items) => statesOfRow(leverRow(items));
// A slug's name without its owner: the part after the first `__`, or the slug with none.
export const shortName = (slug) => slug.split('__').slice(1).join('__') || slug;
// Each slug's name as desk-q shows it: the part after the owner, or owner/name where two repos share it.
export function shownNames(slugs) {
  const short = slugs.map(shortName);
  return slugs.map((s, i) => (short.filter((n) => n === short[i]).length > 1 ? s.replace('__', '/') : short[i]));
}
// The calendar day of `ms` in time zone `tz`, as YYYY-MM-DD: the levers' evaluation and view key days by it.
export const localDay = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));

// The machine-wide freeze: while ~/.desk-autopilot/levers.freeze exists, every trial in every repo is
// stopped. `leversFrozen` is { at, reason } from the file, or null with no file; a file it cannot parse
// is still a freeze, dated by its mtime.
export const freezeFile = () => join(HOME, '.desk-autopilot', 'levers.freeze');
export function leversFrozen(file = freezeFile()) {
  let body;
  try { body = readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  try { const j = JSON.parse(body); if (j && typeof j === 'object' && j.at) return { at: j.at, reason: j.reason ?? null }; } catch { /* dated below */ }
  return { at: statSync(file).mtime.toISOString(), reason: null };
}

// §3b Worker effort is read by parseWorkerEffort (config-schema.mjs), only with the effort lever on.
export const DEFAULT_EFFORT = 'medium';
export const NO_EFFORT = 'default';
// The effort a session starting at `start` is launched at: NO_EFFORT (no --effort) with the lever off.
export const workerEffort = (start) => (leverOn('effort') ? parseWorkerEffort(configValues('worker-effort'))[start] ?? DEFAULT_EFFORT : NO_EFFORT);

// §3b Codex review, read by parseCodexReview (config-schema.mjs) with the codex lever on.
export function codexReview() {
  try { return parseCodexReview(configValues('codex-models')); } catch (e) { if (e instanceof NoRepoConfigError) return parseCodexReview(null); throw e; }
}

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
// §1 Git author name / email as { name, email }, or null when the row is unset or `none`. It takes
// `Name <email>` or two spans, `Name` / `email`. Anything else throws: an author desk guessed is worse
// than git's own default, and the row is the one place a worker's commit author comes from.
export function gitAuthor() {
  const items = configValues('git-author');
  const author = gitAuthorOf(items);
  if (author === undefined) {
    const r = CONFIG_ROWS['git-author'];
    throw new DeskConfigError(`desk: config §${r.section} "${r.row}" (${items.join(' | ')}) is not \`Name <email>\` or \`Name\` / \`email\` in ${configPathHint()}. Refusing to guess.`);
  }
  return author;
}
// §4 Review account, the login desk posts its review verdicts from and that login's gh config
// directory: { login, dir }, or null where the row is unset, a TODO or `none` (verdicts post from the
// §1 GitHub handle). A value in another shape throws rather than posting from a guessed account.
export function reviewAccount() {
  const v = String(configValue('review-account') ?? '').trim();
  const acct = reviewAccountIn(v);
  if (acct === undefined) {
    const r = CONFIG_ROWS['review-account'];
    throw new DeskConfigError(`desk: config §${r.section} "${r.row}" (${v}) is not \`<login>: <gh config directory>\` or \`none\` in ${configPathHint()}. Refusing to guess.`);
  }
  return acct;
}
// A §4 Review account value as { login, dir }, null where it is unset, a TODO or `none`, and
// undefined where it is malformed.
function reviewAccountIn(value) {
  const acct = reviewAccountOf(value);
  return acct ? { login: acct.login, dir: expandHome(acct.dir) } : acct;
}
// The logins whose review verdicts are desk's own, comma-separated as loginIn reads them: the §1
// GitHub handle, and the §4 Review account's login where it is set (a malformed row adds none: the
// review-post command refuses it). null with no handle.
export function verdictLogins() {
  let handle = null, acct = null;
  try { handle = githubHandle(); } catch { return null; }
  try { acct = reviewAccount(); } catch { /* malformed: the handle alone */ }
  return loginsOf(handle, acct);
}
// §4 Gate reviewers, the logins whose verdicts a §4 State check of kind verdict counts, one span
// each: null where the row is unset, a TODO, `none` or `any` (the gate counts any account). A span that
// is not a GitHub login throws rather than comparing against a guess.
export function gateReviewers() {
  return gateReviewersIn(configValues('gate-reviewers'));
}
// The same, from the row's spans, read by gateReviewersOf (config-schema.mjs).
export function gateReviewersIn(items) {
  const { logins, bad } = gateReviewersOf(items);
  if (bad.length) {
    const r = CONFIG_ROWS['gate-reviewers'];
    throw new DeskConfigError(`desk: config §${r.section} "${r.row}" (${items.join(' | ')}) is not one GitHub login per span, \`any\` or \`none\` in ${configPathHint()}. Refusing to guess.`);
  }
  return logins;
}
// Another repo's §4 Gate reviewers, by slug, as gateReviewers reads this repo's.
export function repoGateReviewers(slug, root = deskConfigRoot()) {
  return gateReviewersIn(configValuesIn(parseConfigFile(join(root, 'repos', slug, 'config.md')), 'gate-reviewers'));
}
// Another repo's, by slug, as verdictLogins reads this repo's: $DESK_GITHUB_HANDLE, else its §1 row.
export function repoVerdictLogins(slug, root = deskConfigRoot()) {
  const parsed = parseConfigFile(join(root, 'repos', slug, 'config.md'));
  const env = process.env.DESK_GITHUB_HANDLE;
  const handle = unset(env) ? configValueIn(parsed, 'github-handle') : env;
  return loginsOf(handle == null ? null : expandHome(handle), reviewAccountIn(configValueIn(parsed, 'review-account')));
}
const loginsOf = (handle, acct) => (!handle ? null
  : acct && acct.login.toLowerCase() !== handle.toLowerCase() ? `${handle},${acct.login}` : handle);
export const repoRoot = () => resolve({ env: 'DESK_REPO_ROOT', id: 'repo-root', identity: true }).replace(/\/+$/, '');
// reviewPlan on this repo's rows.
export const reviewRows = () => reviewPlan(configValues('local-review'), configValue('clean-verdict'), repoRoot());
export const worktreesDir = () => resolve({
  env: 'DESK_WORKTREES_DIR', id: 'worktrees-dir',
  fallback: () => { const r = repoRoot(); return join(dirname(r), `${basename(r)}-worktrees`); },
}).replace(/\/+$/, '');
// One per machine, beside which github-signin.mjs saves the GitHub login that the uploader and Claude's
// Playwright MCP share (install.sh registers the MCP on it). A repo's §2 row overrides it for that repo's
// uploads only: the MCP is user-level and keeps the machine one.
export const DEFAULT_BROWSER_PROFILE = expandHome(rowDefault('browser-profile'));
export const browserProfile = () => resolve({ env: 'DESK_BROWSER_PROFILE', id: 'browser-profile', fallback: DEFAULT_BROWSER_PROFILE });
// The origin remote wins over the config row: the row is what setup saw, the remote is what is true now.
export const ghRepo = () => currentRepo().ownerRepo ?? resolve({ env: 'DESK_GH_REPO', id: 'gh-repo', identity: true });
export const repoSlug = () => {
  const s = currentRepo().slug;
  if (!s) throw new DeskConfigError(`desk: not inside a git repo, so there is no repo config to read. ${configPathHint()}`);
  return s;
};
// A named batch (DESK_BATCH) is one batch's queue: its base is this process's default branch, as the
// standing batch's is once an autopilot entry point has applied it. An exported DESK_DEFAULT_BRANCH
// still wins.
export const defaultBranch = () => {
  const base = unset(process.env.DESK_DEFAULT_BRANCH) && batchName() ? batchBase() : null;
  return base ?? resolve({ env: 'DESK_DEFAULT_BRANCH', id: 'default-branch', fallback: rowDefault('default-branch') });
};
export const deskHome = () => expandHome(process.env.DESK_HOME ?? join(HOME, '.claude', 'desk'));
export const binDir = () => join(deskHome(), 'bin');
// The bin a running script starts desk's other scripts from: the release folder it was loaded from
// (node loads a script by its real path), so an install mid-run never mixes two releases. Paths shown
// to a person or written into settings stay binDir(), which follows the current release.
export function runBin() {
  const here = dirname(fileURLToPath(import.meta.url));
  return releaseDirOf(here) ? here : binDir();
}
// The release folder a real bin path belongs to (<DESK_HOME>/releases/<name>/bin), or null outside one.
export function releaseDirOf(bin, home = deskHome()) {
  let releases;
  try { releases = join(realpathSync(home), 'releases'); } catch { return null; }
  return dirname(dirname(bin)) === releases && basename(bin) === 'bin' ? dirname(bin) : null;
}
// Batch state is per repo, so autopilot can run in two repos at once without sharing a queue. A repo
// holds its standing batch at these paths and each named batch (DESK_BATCH, an epic key) nested under
// them in `batches/<name>/`, so a reader that takes each top-level state folder for a repo slug never
// meets a batch. An explicit DESK_QUEUE or DESK_AUTOPILOT_STATE wins over both.
export const BATCHES_DIR = 'batches';
// The repo's own state folder for a state folder that may be a named batch's (<repo state>/batches/<name>).
export const repoStateOf = (state) => state.replace(new RegExp(`[/\\\\]${BATCHES_DIR}[/\\\\][^/\\\\]+[/\\\\]?$`), '');
// DESK_BATCH, or null for the standing batch. It names a directory, so a value that is not a safe id
// is refused before any path is built from it.
export function batchName() {
  const b = process.env.DESK_BATCH;
  if (b == null || b === '') return null;
  if (!SAFE_ID.test(b) || b.includes('..')) {
    throw new DeskConfigError(`desk: DESK_BATCH "${b}" is not a batch name (letters, digits, . _ - only; no ..). Unset it for the standing batch.`);
  }
  return b;
}
// Where a batch's queue and state live by default, without the environment's overrides.
export function batchPaths(slug, batch = null) {
  const tail = batch ? [BATCHES_DIR, batch] : [];
  return { queue: join(deskHome(), 'repos', slug, ...tail, 'queue.json'), state: join(HOME, '.desk-autopilot', slug, ...tail) };
}
export const stateDir = () => expandHome(process.env.DESK_AUTOPILOT_STATE ?? batchPaths(repoSlug(), batchName()).state);
export const queueFile = () => expandHome(process.env.DESK_QUEUE ?? batchPaths(repoSlug(), batchName()).queue);
// The clones of §4 Worker read-only repos belong to the repo, not to a batch: they sit under the
// standing batch's folder whichever batch this is, and DESK_AUTOPILOT_STATE, which names one batch, never moves them.
export const readRepoDir = () => join(batchPaths(repoSlug()).state, 'ref');
// §4 Worker read-only repos as [{ repo, path }]; `path` is null for an item that is not `owner/name`.
export function readRepos() {
  const items = configValues('worker-read-repos');
  if (!items || isNone(items)) return [];
  return items.map((repo) => ({ repo, path: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) && !repo.includes('..') ? join(readRepoDir(), slugOf(repo)) : null }));
}

// The file naming the login a worker runs on (claude-logins.mjs reads it).
export const loginFile = (state, key) => join(state, 'workers', `${key}.login.json`);

// Move a ticket's last round aside so the next worker starts clean: its log (a kept AUTOPILOT_DONE
// blocks the respawn, and a kept PR line sends screenshots to the old PR), its park record (an old
// question reads as the new worker's) and, with `answers`, its mailbox (a stale answer satisfies the
// next park instantly). All take one suffix, the first `.round<n>` free for every one of them, so a
// round's files stay together. The log is gzipped as it moves (`.round<n>.gz`, its time kept, since a
// batch's cost and spawn history read a round's time); one that fails to compress stays as it was,
// and every reader of round logs takes both. An empty log is left in place. The worker's login file
// is copied to the same suffix, as the next round's start overwrites it and a round's usage readings
// stay its login's. Returns the files moved.
export function rotateRound(key, { answers = false } = {}) {
  const state = stateDir();
  const files = [join(state, 'logs', `${key}.log`), join(state, 'parks', `${key}.json`)];
  if (answers) files.push(join(state, 'answers', `${key}.txt`));
  const present = files.filter((f) => existsSync(f) && (!f.endsWith('.log') || statSync(f).size > 0));
  if (!present.length) return [];
  let n = 1;
  while (files.some((f) => existsSync(`${f}.round${n}`) || existsSync(`${f}.round${n}.gz`))) n += 1;
  const login = loginFile(state, key);
  if (existsSync(login)) copyFileSync(login, `${login}.round${n}`);
  return present.map((f) => {
    const to = `${f}.round${n}`;
    renameSync(f, to);
    return f.endsWith('.log') ? gzipRound(to) : to;
  });
}

function gzipRound(path) {
  const gz = `${path}.gz`;
  try {
    const { atime, mtime } = statSync(path);
    writeFileSync(`${gz}.tmp`, gzipSync(readFileSync(path)));
    utimesSync(`${gz}.tmp`, atime, mtime);
    renameSync(`${gz}.tmp`, gz);
    unlinkSync(path);
    return gz;
  } catch {
    try { unlinkSync(`${gz}.tmp`); } catch { /* never written */ }
    return path;
  }
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
// The queue as it stands, or null when there is none or it does not parse.
function readQueueOrNull() {
  try { return JSON.parse(readFileSync(queueFile(), 'utf8')); } catch { return null; }
}
export function batchBase() {
  const q = readQueueOrNull();
  if (!q) return null;
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
// The id a batch base's conflict fix worker runs under: its base worktree's directory name
// (base-sync.mjs baseWorktreePath), so its log, settings and ticket file sit beside the tickets'.
export const baseFixKey = (base) => `base-${String(base).replace(/[^A-Za-z0-9._-]/g, '-')}`;
// Whether a sync of the batch base may push it: §3 batch-base-push, unset meaning `ask`, which is one
// approval per batch passed to every pass (and every base conflict fix worker) as
// AUTOPILOT_BASE_PUSH_APPROVED=1. The pass, the base gate and the worker's settings all read it here.
export function basePushGrant() {
  const perm = permissionOrUnset('batch-base-push') ?? 'ask';
  return { perm, key: permissionKey('batch-base-push'), ok: perm === 'yes' || (perm === 'ask' && !!process.env.AUTOPILOT_BASE_PUSH_APPROVED) };
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

const DEFAULT_DEV_PORT = Number(rowDefault('dev-port'));
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
  return configuredRepos(root).map(({ slug, config }) => {
    const parsed = parseConfigFile(config);
    const port = positiveInt(configValueIn(parsed, 'dev-port')) ?? DEFAULT_DEV_PORT;
    return { slug, port, last: port + concurrencyLimits(configValueIn(parsed, 'concurrency')).cap };
  });
}

// A row from another repo's config, by slug: desk-q reads every repo's cap. Unset is null.
export const repoConfigValue = (slug, id, root = deskConfigRoot()) =>
  configValueIn(parseConfigFile(join(root, 'repos', slug, 'config.md')), id);
// Every item of another repo's row, as configValues reads this repo's. Unset is null.
export const repoConfigValues = (slug, id, root = deskConfigRoot()) =>
  configValuesIn(parseConfigFile(join(root, 'repos', slug, 'config.md')), id);

const blocksMeet = (a, b) => a.port <= b.last && b.port <= a.last;
export const portClashes = (self, claims) => claims.filter((c) => c.slug !== self.slug && blocksMeet(self, c));

// The lowest port from `from`, in steps of `step`, whose block of `cap` workers meets no claim.
export function proposePort(cap, claims, { from = 3000, step = 100 } = {}) {
  for (let port = from; port + cap <= 65535; port += step) {
    if (!claims.some((c) => blocksMeet({ port, last: port + cap }, c))) return port;
  }
  return null;
}

// §3b "Spawn gate (available memory)", read by spawnGateOf (config-schema.mjs): { start, hold, dropTo }.
// AUTOPILOT_MIN_AVAIL_GB overrides start (0 = off). `row` is this repo's by default; desk-q passes
// another repo's (repoConfigValue).
export function spawnGate(row = configValue('spawn-gate')) {
  const gate = spawnGateOf(row);
  const env = process.env.AUTOPILOT_MIN_AVAIL_GB;
  return { ...gate, start: env != null && env !== '' && Number.isFinite(Number(env)) ? Number(env) : gate.start };
}

// §3b "Per-file collision budget", read by its grammar in config-schema.mjs, from this repo's row by
// default. configValues refuses a cell mixing `none` with other spans: more than one span all the same.
const fileBudgetSpans = () => { try { return configValues('file-budget'); } catch { return [null, null]; } };
export function fileBudget(row = fileBudgetSpans()) { return fileBudgetOf(row); }

// ---- ticket ids ------------------------------------------------------------------------------
// A ticket id names files and directories, so it is checked for shape before anything else, then
// against this repo's config. Case-sensitive as written: `ABC-1` and `abc-1` are different ids.
//   tracker   matches §4 Ticket key pattern in full           -> text from the tracker
//   work-id   matches one §4 Other work id patterns item      -> text from $DESK_STATE/tickets/<id>.md
//   issue     `issue-<n>` with §4 Tracker none                 -> GitHub issue n
//   slug      lower-case kebab with §4 Tracker none           -> text from $DESK_STATE/tickets/<id>.md
// -> { ok: true, kind } | { ok: false, error }
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// `--batch <name>` (or `--batch=<name>`) on any desk command names its batch as DESK_BATCH does, for a
// caller whose exports do not outlive one shell call. It leaves argv before the command reads its own
// arguments (up to a bare `--`, past which arguments belong to another command), and is set in the
// environment so every child the command starts follows it. Two different names, from either source,
// are refused rather than one picked.
export function takeBatchArg(argv = process.argv, env = process.env) {
  const named = [];
  for (let i = 1; i < argv.length;) {
    if (argv[i] === '--') break;
    const m = /^--batch(?:=(.*))?$/.exec(argv[i]);
    if (!m) { i += 1; continue; }
    const v = m[1] ?? argv[i + 1];
    if (v == null || v === '' || v.startsWith('-')) throw new DeskConfigError('desk: --batch wants a batch name (--batch <name>).');
    named.push(v);
    argv.splice(i, m[1] == null ? 2 : 1);
  }
  if (!named.length) return null;
  const other = named.find((v) => v !== named[0]);
  if (other) throw new DeskConfigError(`desk: --batch "${named[0]}" and --batch "${other}" name different batches. Give one.`);
  if (env.DESK_BATCH && env.DESK_BATCH !== named[0]) {
    throw new DeskConfigError(`desk: DESK_BATCH "${env.DESK_BATCH}" and --batch "${named[0]}" name different batches. Unset DESK_BATCH or drop --batch.`);
  }
  env.DESK_BATCH = named[0];
  return named[0];
}
// Every desk script loads this module first, so a bad --batch or DESK_BATCH stops it before it touches a file.
let batchArg = null;
try { batchArg = takeBatchArg(); batchName(); } catch (e) { console.error(e.message); process.exit(4); }
export const fullMatch = (pattern, s) => { try { return new RegExp(`^(?:${pattern})$`).test(s); } catch { return false; } };
export function ticketKind(key) {
  const k = String(key ?? '');
  if (!SAFE_ID.test(k) || k.includes('..')) return { ok: false, error: `'${k}' is not usable as a ticket id (letters, digits, . _ - only; no ..)` };
  const tracker = (configValue('tracker') ?? '').trim().toLowerCase();
  const pattern = configValue('ticket-pattern');
  if (pattern && !isNone(pattern) && fullMatch(pattern, k)) return { ok: true, kind: 'tracker' };
  const others = configValues('work-id-patterns');
  if (others && !isNone(others) && others.some((p) => fullMatch(p, k))) return { ok: true, kind: 'work-id' };
  // This batch's base, worked by its conflict fix worker. A queue that cannot be read has no base.
  if (k.startsWith('base-')) {
    let b = null;
    try { b = batchBase(); } catch { /* no usable base */ }
    if (b && k === baseFixKey(b)) return { ok: true, kind: 'base' };
  }
  // A merged ticket's blind audit (levers-audit.mjs), worked under `audit.<its key>`.
  if (k.startsWith('audit.')) {
    const inner = ticketKind(k.slice('audit.'.length));
    if (inner.ok && !['audit', 'base'].includes(inner.kind)) return { ok: true, kind: 'audit' };
  }
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

// ---- branch names ----------------------------------------------------------------------------
// A ticket's branch is pushed by name, so a convention placeholder left in it (`<slug>`), a space,
// or anything `git check-ref-format --branch` refuses makes it unusable (git itself accepts < and >).
// -> why it is unusable, or null
export function branchProblem(name) {
  const b = String(name ?? '');
  if (!b) return 'it is empty';
  if (/[<>]/.test(b)) return 'it still holds a <placeholder>';
  if (/\s/.test(b)) return 'it holds a space';
  try { execFileSync('git', ['check-ref-format', '--branch', b], { stdio: 'ignore' }); } catch { return '`git check-ref-format --branch` refuses it'; }
  return null;
}
// A usable branch for a ticket from its key and summary: the prefix an unusable branch already had,
// else the one its issue type takes.
const BRANCH_PREFIX = { bug: 'fix', chore: 'chore' };
export function branchFor({ key, type, summary, from }) {
  const prefix = /^([a-z]+)\//.exec(String(from ?? ''))?.[1] ?? BRANCH_PREFIX[String(type ?? '').toLowerCase()] ?? 'feat';
  const words = String(summary ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 6);
  return [`${prefix}/${key}`, ...words].join('-');
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
  const stub = Number(process.env.DESK_MEM_AVAIL_GB);
  if (process.env.DESK_MEM_AVAIL_GB && stub >= 0) return stub; // tests
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
  try { return psRows('rss=').reduce((s, r) => s + (r.rss || 0), 0) * 1024 / GiB; } catch { return NaN; }
}

// Every process's command line can carry a worker's whole prompt, so the list runs to megabytes.
const PS_MAX_BUFFER = 64 * 1024 * 1024;
const PS_NUMERIC = new Set(['pid', 'ppid', 'rss']);
// `ps` output for `columns` (e.g. 'pid=,args=') as one object per process keyed by column name:
// every column but the last is one word, the last runs to the end of the line. pid, ppid and rss
// are numbers. A line of another shape is skipped.
export function parsePs(text, columns) {
  const names = columns.split(',').map((c) => c.replace(/=.*$/, ''));
  const re = new RegExp(`^\\s*${names.slice(0, -1).map(() => '(\\S+)\\s+').join('')}(.*?)\\s*$`);
  const rows = [];
  for (const line of String(text).split('\n')) {
    const m = re.exec(line);
    if (!m || !line.trim()) continue;
    rows.push(Object.fromEntries(names.map((n, i) => [n, PS_NUMERIC.has(n) ? Number(m[i + 1]) : m[i + 1]])));
  }
  return rows;
}
// Every process, read whole from one `ps`. Throws when ps cannot be read, rather than giving a
// partial or empty list. `env` adds to ps's environment (e.g. TZ and LC_ALL for lstart).
export function psRows(columns, env = {}) {
  const r = spawnSync('ps', ['-ww', '-axo', columns], { encoding: 'utf8', maxBuffer: PS_MAX_BUFFER, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.error || r.status !== 0) {
    const why = r.error?.code ?? r.error?.message ?? (`${r.stderr ?? ''}`.trim().split('\n').pop() || `exit ${r.status ?? r.signal}`);
    throw new Error(`ps could not be read (${why})`);
  }
  return parsePs(r.stdout, columns);
}
// The `mem status` line, which `queue.mjs watch` prints under its table too.
export function memStatusLine() {
  return `vmmem=${usedGiB().toFixed(1)}G avail=${availableGiB().toFixed(1)}G rss=${rssGiB().toFixed(1)}G`;
}

export const memCeilingGiB = () => memoryCeiling().gb;

// Heavy processes (suites, typecheck, dev servers) counted by argv[0]/argv[1], never `pgrep -f`:
// a claude worker carries its briefing in argv (which mentions jest, vitest and tsc), and the
// harness's own `bash -c` wrapper carries the pattern literally, so a -f match counts both.
// Throws when ps cannot be read: an empty list would say nothing heavy is running.
export function heavyProcesses() {
  return heavyFromPs(psRows('pid=,args='), process.pid);
}
// `playwright` only as a whole name: `playwright test` is a suite, an idle `playwright-mcp` server is not.
// `procs` is psRows('pid=,args=') rows.
export function heavyFromPs(procs, selfPid) {
  const rows = [];
  for (const { pid, args } of procs) {
    if (!Number.isInteger(pid) || pid === selfPid) continue;
    const [a0 = '', a1 = '', a2 = ''] = args.split(/\s+/);
    const exe = basename(a0);
    if (['claude', 'bash', 'sh', 'zsh', 'grep', 'ps', 'awk'].includes(exe)) continue;
    // argv[2] only for `python -m <module>`, so a Python suite or server counts the same as a JS one.
    const hay = `${exe} ${basename(a1)}${/^python/.test(exe) && a1 === '-m' ? ` ${a2}` : ''}`;
    if (/jest|vitest|tsc|next-server|next dev|\bplaywright\b(?!-)|storybook|pytest|uvicorn|gunicorn/.test(hay)) rows.push({ pid, args: args.slice(0, 160) });
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

// The harm signals the watch also reads, which preceded real damage where the host's free memory did
// not: swap use growing by `swapGrowGiB` or more within `windowMs`, a kernel OOM kill newer than the
// watch's first reading (`oom` is each kill's key as oomKills reads it, its kernel timestamp or its
// line; null when the kernel log cannot be read, undefined off Linux, where none is watched),
// a tmpfs /tmp holding `tmpfsGiB` or more (its contents are pushed to swap, which looks like a
// leak), and a tmpfs /tmp with `inodeShare` or more of its fixed count of inodes used (`tmpInodes`:
// { used, total }): once every one is used, no file can be made there, and every shell on the machine,
// Claude Code's included, stops. Each line is said once, and again only after the signal has cleared.
//   sample { now, swapGiB, oom, tmpGiB, tmpInodes }  ->  { state, lines }
export function harmStep(state, { now, swapGiB, oom, tmpGiB, tmpInodes }, { swapGrowGiB = 2, windowMs = 600_000, tmpfsGiB = 4, inodeShare = 0.8 } = {}) {
  const st = { swap: [], oomKeys: null, swapFired: false, tmpFired: false, inodesFired: false, oomUnread: false, ...state };
  const lines = [];
  if (swapGiB != null) {
    const swap = [...st.swap.filter((x) => now - x.at <= windowMs), { at: now, gib: swapGiB }];
    const low = Math.min(...swap.map((x) => x.gib));
    const grew = swapGiB - low;
    if (grew >= swapGrowGiB && !st.swapFired) lines.push(`SWAP-GROWING: swap used ${swapGiB.toFixed(1)}G, up ${grew.toFixed(1)}G in ${Math.round(windowMs / 60000)}m: hold new spawns`);
    st.swapFired = grew >= swapGrowGiB ? true : grew < swapGrowGiB / 2 ? false : st.swapFired;
    st.swap = swap;
  }
  if (oom === undefined) { /* not watched on this platform */ } else if (oom === null) {
    if (!st.oomUnread) lines.push('OOM-UNKNOWN: the kernel log cannot be read (dmesg), so OOM kills are not watched');
    st.oomUnread = true;
  } else {
    st.oomUnread = false;
    // A kill is new when its line was not in the last reading: the ring buffer dropping old kill
    // lines, even while a new kill writes them out, hides nothing. Each line is keyed by its
    // timestamp, or its whole text in a log with none (printk.time off).
    const keys = oom.map(String);
    if (st.oomKeys != null) {
      const was = new Set(st.oomKeys);
      const fresh = keys.filter((k) => !was.has(k)).length;
      if (fresh) lines.push(`OOM-KILL: the kernel killed ${fresh} process(es) for memory: drop to the ladder's lowest count`);
    }
    st.oomKeys = keys;
  }
  if (tmpGiB != null) {
    if (tmpGiB >= tmpfsGiB && !st.tmpFired) lines.push(`TMPFS-HIGH: /tmp (tmpfs) holds ${tmpGiB.toFixed(1)}G, which memory pressure pushes to swap, not a leak: see what holds it (du -sh /tmp/*)`);
    st.tmpFired = tmpGiB >= tmpfsGiB ? true : tmpGiB < tmpfsGiB / 2 ? false : st.tmpFired;
  }
  if (tmpInodes?.total > 0) {
    const share = tmpInodes.used / tmpInodes.total;
    if (share >= inodeShare && !st.inodesFired) {
      lines.push(`TMPFS-INODES: /tmp (tmpfs) has used ${Math.round(share * 100)}% of its inodes (${tmpInodes.used.toLocaleString('en-US')} of ${tmpInodes.total.toLocaleString('en-US')}); once all are used no shell on this computer can start: see what holds them (du --inodes -s /tmp/* | sort -n | tail)`);
    }
    st.inodesFired = share >= inodeShare ? true : share < inodeShare * 0.75 ? false : st.inodesFired;
  }
  return { state: st, lines };
}

// The OOM kills in a kernel log, each keyed by its timestamp in seconds since boot, or by its whole
// line where it has none: one `Out of memory: Killed process` line per kill, global or a cgroup's
// (`Memory cgroup out of memory: …`); the `oom-kill:` summary beside a global one is not counted.
export const oomKills = (dmesg) => String(dmesg).split('\n').filter((l) => /out of memory: Killed process/i.test(l))
  .map((l) => { const m = /^\[\s*(\d+(?:\.\d+)?)\]/.exec(l); return m ? Number(m[1]) : l.trim(); });

// What harmStep reads on this computer: swap from /proc/meminfo, OOM-killer lines from dmesg, and /tmp
// when it is a tmpfs. Each is null where it cannot be read; off Linux none is read (oom undefined).
export function harmSample() {
  // Off Linux there is no swap figure, kernel log or tmpfs to read: nothing is watched, and nothing said.
  if (platform() !== 'linux') return { swapGiB: null, oom: undefined, tmpGiB: null, tmpInodes: null };
  const m = linuxMeminfo();
  const swapGiB = m?.SwapTotal != null && m?.SwapFree != null ? (m.SwapTotal - m.SwapFree) / GiB : null;
  let oom = null;
  try {
    const out = execFileSync('dmesg', [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
    oom = oomKills(out);
  } catch { /* dmesg_restrict, or no dmesg */ }
  let tmpGiB = null, tmpInodes = null;
  try {
    const tmpfs = readFileSync('/proc/mounts', 'utf8').split('\n').some((l) => { const f = l.split(' '); return f[1] === '/tmp' && f[2] === 'tmpfs'; });
    if (tmpfs) {
      const st = statfsSync('/tmp');
      tmpGiB = ((st.blocks - st.bfree) * st.bsize) / GiB;
      tmpInodes = { used: st.files - st.ffree, total: st.files };
    }
  } catch { /* not Linux */ }
  return { swapGiB, oom, tmpGiB, tmpInodes };
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

// ---- config drift --------------------------------------------------------------------------
// What a repo's config has fallen behind on: rows the template has that the file lacks, rows set to
// `ask` that a batch with nobody watching can only park on, and a settings file that starts sessions
// in dontAsk. /desk-setup shows it on a re-run; `desk-env drift --all` checks every repo.
// The checkout's own template wins, so a run from the checkout reads the template it ships with.
export function templatePath() {
  if (process.env.DESK_CONFIG_TEMPLATE) return expandHome(process.env.DESK_CONFIG_TEMPLATE);
  const sibling = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'desk-config.md');
  return existsSync(sibling) ? sibling : join(skillsDir(), 'desk-setup', 'references', 'desk-config.template.md');
}

// `ask` on these rows is a park in an unattended batch: there is nobody to ask.
export const STALLING_ROWS = Object.freeze({
  'git-push': 'every worker parks before it pushes',
  'pr-open': 'every worker parks before it opens its PR',
  'pr-self-review-comment': 'every worker parks before it posts its review',
  'pr-ready': 'worker PRs stay drafts, so nothing merges without you',
  'pr-merge-green': 'green PRs wait for you to merge them',
  'autopilot-merge': 'the merge driver does not merge green PRs, so they wait for you',
});
// Unprotected, nothing on GitHub stops a red merge, so these stay recommended at `ask` (desk-setup §2).
const MERGE_ROWS = new Set(['pr-merge-green', 'autopilot-merge']);

// -> { missing: [{section, label}], stalls: [{key, reason}], unlisted, noDev, weight, dontAsk: file | null }
export function configDrift({ config, template = templatePath(), root = null, home = HOME }) {
  if (!existsSync(template)) throw new DeskConfigError(`desk-env drift: no template at ${template}: run ./install.sh, or set DESK_CONFIG_TEMPLATE`);
  const parsed = parseConfigFile(config);
  const have = new Set(parsed.rows.map((r) => `${r.section}\t${r.id}`));
  const missing = parseConfigFile(template).rows.filter((r) => !have.has(`${r.section}\t${r.id}`))
    .map(({ section, byKey, label }) => ({ section, label: byKey ? label : `"${label}"` }));
  const perm = (key) => parsed.sections['3']?.byKey[key]?.value?.trim().toLowerCase() ?? '';
  const stalls = [];
  if (/^yes\b/.test(perm('autopilot-workers'))) {
    const unprotected = isNone(configValueIn(parsed, 'branch-protection') ?? '');
    for (const [key, reason] of Object.entries(STALLING_ROWS)) {
      if (unprotected && MERGE_ROWS.has(key)) continue;
      if (/^ask\b/.test(perm(key))) stalls.push({ key, reason });
    }
  }
  const { mode, file } = defaultModeIn(root, home);
  // Command items a worker's settings cannot allow: every worker is refused them.
  const unlisted = [];
  for (const id of [...WORKER_COMMAND_IDS, 'worker-measure-cmds']) {
    const values = configValuesIn(parsed, id);
    if (!values || isNone(values)) continue;
    for (const item of values) {
      const why = commandItemProblem(parseCommandItem(item).cmd);
      if (why) unlisted.push({ row: CONFIG_ROWS[id].row, item, why });
    }
  }
  // With §3 worker-local-services yes, a §4 Local services item a worker starts by its leading name.
  const services = configValuesIn(parsed, 'local-services');
  if (/^yes\b/.test(perm('worker-local-services')) && services && !isNone(services)) {
    for (const item of services) {
      if (!localServiceName(item)) unlisted.push({ row: CONFIG_ROWS['local-services'].row, item, why: 'does not start with a compose service name (lowercase, then `:port` or a space)' });
    }
  }
  // §4 Suite weight set in both places and disagreeing: the committed value wins, so the row is stale.
  const w = suiteWeightIn(parsed, root);
  const weight = w.committed && w.row != null && w.row !== w.committed.value ? { row: w.row, committed: w.committed.value, file: w.committed.file } : null;
  return { missing, stalls, unlisted, noDev: root ? devServerGaps(parsed, root) : [], weight, dontAsk: mode === 'dontAsk' ? file : null };
}

// App directories the other §4 command rows name, whose package.json has a `dev` script, that §4 Dev
// server has no item for: a worker on a ticket there is refused that app's dev server. A Dev server
// item's own directory serves it, and so does a `--filter`/`-F` naming its package or path. The root
// is never a gap: its `dev` script runs the workspace, not a second app.
// -> [{ dir, rows: [row name] }]. None while the Dev server row is unset or `none`.
export function devServerGaps(parsed, root) {
  const dev = configValuesIn(parsed, 'dev-cmd');
  if (!dev || isNone(dev)) return [];
  const served = devServed(dev);
  const pkg = (dir) => readPackage(root, dir);
  const named = new Map();
  for (const id of WORKER_COMMAND_IDS.filter((x) => x !== 'dev-cmd')) {
    const values = configValuesIn(parsed, id);
    if (!values || isNone(values)) continue;
    for (const item of values) {
      const { dir } = parseCommandItem(item);
      if (dir === '.' || served.has(dir)) continue;
      if (!named.has(dir)) named.set(dir, []);
      if (!named.get(dir).includes(CONFIG_ROWS[id].row)) named.get(dir).push(CONFIG_ROWS[id].row);
    }
  }
  return [...named]
    .map(([dir, rows]) => ({ dir, rows, p: pkg(dir) }))
    .filter(({ p }) => p?.scripts?.dev && !served.has(p.name))
    .map(({ dir, rows }) => ({ dir, rows }));
}

// The directories and package names §4 Dev server items serve: each item's own directory, and any
// `--filter`/`-F` it passes.
function devServed(items) {
  const served = new Set();
  for (const item of items) {
    const { dir, cmd } = parseCommandItem(item);
    served.add(dir);
    for (const m of cmd.matchAll(/(?:--filter[=\s]|-F\s)\s*['"]?([^\s'"]+)/g)) served.add(m[1].replace(/^\.\//, '').replace(/\/+$/, ''));
  }
  return served;
}
const readPackage = (root, dir) => { try { return JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')); } catch { return null; } };

// Every §4 row one app needs before a worker can run it for screenshots, that the config lacks for
// it, each with the value to add: a Dev server item where its package.json has a dev script, and the
// `.env*` files its directory holds in the primary checkout (`root`) where Env files names none under
// it. A row unset is drift's MISSING, and `none` is a decision: neither is a gap here.
// -> [{ row, dir, value: [item], have?: [file] }]
export function appSetupGaps(parsed, root, dir) {
  const app = String(dir).replace(/^(\.\/)+/, '').replace(/\/+$/, '') || '.';
  const gaps = [];
  const dev = configValuesIn(parsed, 'dev-cmd');
  const p = readPackage(root, app);
  if (dev && !isNone(dev) && p?.scripts?.dev && !devServed(dev).has(app) && !devServed(dev).has(p.name)) {
    const pm = configValuesIn(parsed, 'package-manager');
    gaps.push({ row: 'Dev server', dir: app, value: [`${app === '.' ? '' : `${app}: `}${TS.packageManager(root, pm && !isNone(pm) ? pm[0] : null)} run dev`] });
  }
  const env = configValuesIn(parsed, 'env-files');
  if (env && !isNone(env) && !env.some((f) => (app === '.' ? !f.includes('/') : f.startsWith(`${app}/`)))) {
    let have = [];
    try { have = readdirSync(join(root, app), { withFileTypes: true }).filter((e) => e.isFile() && /^\.env/.test(e.name) && !/\.(example|sample|template|dist)$/.test(e.name)).map((e) => e.name).sort(); } catch { /* no such directory */ }
    if (have.length) gaps.push({ row: 'Env files', dir: app, value: have.map((f) => (app === '.' ? f : `${app}/${f}`)), have });
  }
  return gaps;
}

export function appGapLines(gaps, dir) {
  const spans = (xs) => xs.map((x) => `\`${x}\``).join(' ');
  const lines = gaps.map((g) => (g.row === 'Dev server'
    ? `NODEV    §4 Dev server has no item for ${g.dir}, whose package.json has a dev script: add ${spans(g.value)}`
    : `NOENV    §4 Env files has no item under ${g.dir}, whose primary checkout holds ${g.have.join(', ')}: add ${spans(g.value)}`));
  return lines.length ? lines : [`no setup gaps for ${dir}`];
}

// A §4 Pre-merge steps item named after a job of several steps (workflow-yaml.mjs jobKeyedPremerge): the
// step it is for, in its place, where one step fits it, else the job's named steps to choose from.
const jobKeyedLine = (j) => {
  const quoted = (xs) => xs.map((s) => `"${s}"`).join(', ');
  const fix = j.fits.length === 1 ? `name the step instead: "${j.fits[0]}: ${j.command}"`
    : (j.fits.length ? j.fits : j.named).length ? `name the step it is for instead, one of ${quoted(j.fits.length ? j.fits : j.named)}` : 'name the step it is for instead';
  return `JOBKEY   §4 Pre-merge steps item "${j.name}" names a job of ${j.steps} steps, so desk guesses from its words which failed step is yours: ${fix}`;
};

export function driftLines({ missing, stalls, unlisted = [], noDev = [], weight = null, jobKeyed = [], dontAsk }) {
  const lines = [
    ...missing.map((m) => `MISSING  §${m.section} ${m.label}: the template has this row, the config does not`),
    ...stalls.map((s) => `STALLS   §3 ${s.key} is ask with autopilot-workers yes: ${s.reason}`),
    ...unlisted.map((u) => `UNLISTED §4 ${u.row} item "${u.item}" ${u.why}: every worker is refused it`),
    ...noDev.map((g) => `NODEV    §4 Dev server has no item for ${g.dir}, which §4 ${g.rows.join(', ')} name${g.rows.length > 1 ? '' : 's'} and whose package.json has a dev script: a worker on a ticket there cannot run its dev server`),
    ...(weight ? [`WEIGHT   §4 Suite weight is ${weight.row} in the config but ${weight.committed} in the repo's committed settings (env.DESK_SUITE_WEIGHT in ${weight.file}), which win: set the row to ${weight.committed} or remove it`] : []),
    ...jobKeyed.map(jobKeyedLine),
    ...(dontAsk ? [`DONTASK  ${dontAsk}: ${DONTASK_WARNING}`] : []),
  ];
  return lines.length ? lines : ['no drift'];
}

// ---- a missing row, added from the template ------------------------------------------------
// The declared rows of a file, each with its id.
const tableRows = (text) => tableLines(text).rows.filter((r) => r.declared).map((r) => ({ ...r, id: norm(r.label) }));
// A row's cells as a table line: a `|` outside backticks is escaped, as splitRow reads it back.
function joinRow(cells) {
  const esc = (c) => { let tick = false; return [...c].map((ch) => { if (ch === '`') tick = !tick; return ch === '|' && !tick ? '\\|' : ch; }).join(''); };
  return `| ${cells.map(esc).join(' | ')} |`;
}

// Adds §<section> <row> (a §3 key, else the row's name) to the config as the template has it, with
// `value` in its setting column and `note` after it, placed after the nearest row above it in the
// template's table that the config has (else before the nearest below). Only a row `drift` names as
// MISSING: one the config has is refused, never overwritten. -> { section, label, line }
export function addTemplateRow({ config, section, row, value, note = '', template = templatePath() }) {
  const sec = String(section).replace(/^§/, '').toLowerCase();
  const id = norm(String(row).replace(/^"(.*)"$/, '$1'));
  const v = String(value ?? '').trim();
  if (!v || v.includes('`') || /\n/.test(v)) throw new DeskConfigError('desk-env add-row: the value must be one line with no backticks');
  if (!existsSync(template)) throw new DeskConfigError(`desk-env add-row: no template at ${template}: run ./install.sh, or set DESK_CONFIG_TEMPLATE`);
  if (!config || !existsSync(config)) throw new DeskConfigError(`desk-env add-row: no config at ${config ?? configPathHint()}: run /desk-setup`);
  const tRows = tableRows(readFileSync(template, 'utf8'));
  const t = tRows.find((r) => r.section === sec && r.id === id);
  if (!t) throw new DeskConfigError(`desk-env add-row: the template has no §${sec} row "${row}"`);
  const text = readFileSync(config, 'utf8');
  const cRows = tableRows(text);
  const at = (r) => cRows.find((c) => c.section === r.section && c.id === r.id);
  if (at(t)) throw new DeskConfigError(`desk-env add-row: the config already has §${sec} ${t.label}; change it with /desk-setup`);
  const col = settingCol(t.header);
  // A §3 row whose Recommended value is a permission takes a permission: a typo would read as `no`.
  if (sec === '3' && t.header[0] === 'key') {
    const rec = cellItems(t.cells[t.header.indexOf('recommended')] ?? '')[0] ?? '';
    const takes = permValues(t.label);
    if (takes.includes(rec.split(/[\s(]/)[0].toLowerCase()) && !takes.includes(v.split(/[\s(]/)[0])) throw new DeskConfigError(`desk-env add-row: §3 ${t.label} takes ${takes.slice(0, -1).join(', ')} or ${takes.at(-1)}, not "${v}"`);
  }
  const cells = t.cells.slice();
  cells[col] = `\`${v}\`${note.trim() ? ` (${note.trim().replace(/\n/g, ' ')})` : ''}`;
  const line = joinRow(cells);
  const peers = tRows.filter((r) => r.table === t.table);
  const k = peers.indexOf(t);
  const above = peers.slice(0, k).reverse().map(at).find(Boolean);
  const below = above ? null : peers.slice(k + 1).map(at).find(Boolean);
  if (!above && !below) throw new DeskConfigError(`desk-env add-row: the config has no row of the template's table for §${sec} ${t.label} to sit beside: run /desk-setup`);
  const lines = text.split('\n');
  lines.splice(above ? above.i + 1 : below.i, 0, line);
  const tmp = `${config}.tmp-${process.pid}`;
  writeFileSync(tmp, lines.join('\n'));
  renameSync(tmp, config);
  cache = null;
  return { section: sec, label: t.label, line };
}

// Sets a declared row's value in place, keeping its note. false when the config has no such row.
function setRowValue(config, section, row, value) {
  const text = readFileSync(config, 'utf8');
  const r = tableRows(text).find((x) => x.section === section && x.id === norm(row));
  if (!r) return false;
  const cells = r.cells.slice();
  const col = settingCol(r.header);
  const cell = cells[col] ?? '';
  cells[col] = /`[^`]*`/.test(cell) ? cell.replace(/`[^`]*`/, () => `\`${value}\``) : `\`${value}\``;
  const lines = text.split('\n');
  lines[r.i] = joinRow(cells);
  const tmp = `${config}.tmp-${process.pid}`;
  writeFileSync(tmp, lines.join('\n'));
  renameSync(tmp, config);
  cache = null;
  return true;
}

// ---- the repo's subscription ---------------------------------------------------------------
// Config §3b Subscription: `default` or the email of one of this computer's Claude subscriptions.
// logins.mjs resolves it (repoSubscription); `L` is that module, imported only when a caller needs it.
// Every configured repo's subscription from its own row and this computer's default. DESK_SUBSCRIPTION
// is one caller's override, so it is not read here.   -> [{ slug, email, login, source }]
export function repoSubscriptions(L, subs, root = deskConfigRoot()) {
  return configuredRepos(root).map(({ slug }) => ({ slug, ...L.repoSubscription(subs, { value: repoConfigValue(slug, 'subscription', root), source: 'row' }) }));
}
// This repo's subscription: DESK_SUBSCRIPTION, one caller's override, else its own row. `from` names
// where an email no login here is signed in to came from, and `fix` what to change.
//   -> { email, login, source, from, fix }
export function thisRepoSubscription(L, subs, env = process.env) {
  const value = env.DESK_SUBSCRIPTION?.trim();
  const r = L.repoSubscription(subs, value ? { value, source: 'DESK_SUBSCRIPTION' } : { value: configValue('subscription'), source: 'row' });
  return { ...r, from: value ? 'DESK_SUBSCRIPTION' : `this repo's config §3b "${CONFIG_ROWS.subscription.row}" row`, fix: value ? 'DESK_SUBSCRIPTION' : 'the row' };
}

// Writes another repo's Subscription row: `default`, or an email one of this computer's Claude logins is
// signed in to (stored lowercase). An unknown email or repo, or an email whose login is set off, is
// refused with the config unchanged.
//   -> { slug, was, now }
export async function setRepoSubscription(slug, value, root = deskConfigRoot()) {
  const L = await import('./logins.mjs');
  const config = join(root, 'repos', String(slug), 'config.md');
  const row = CONFIG_ROWS.subscription.row;
  if (!/^[\w.-]+$/.test(String(slug)) || !existsSync(config)) throw new DeskConfigError(`desk-env subscription set: no repo config for "${slug}" under ${join(root, 'repos')}`);
  const now = String(value ?? '').trim().toLowerCase();
  if (!now || now.includes('`') || /\s/.test(now)) throw new DeskConfigError('desk-env subscription set: the value is `default` or an account email');
  const subs = now === 'default' ? null : L.readSubscriptions(subscriptionsPath());
  const off = subs && L.offSubscriptionLogin(subs, now);
  if (off) throw new DeskConfigError(`desk-env subscription set: ${now} is off (claude ${off.name}), so desk starts no new work on it: set it unused first (desk-env logins set claude ${off.name} unused); ${slug}'s config is unchanged`);
  if (subs && !L.subscriptionLogin(subs, now)) {
    throw new DeskConfigError(`desk-env subscription set: ${now} is not one of this computer's subscriptions: sign it in and add it in desk-q view 6 (Usage) first; ${slug}'s config is unchanged`);
  }
  const was = repoConfigValue(slug, 'subscription', root)?.toLowerCase() ?? 'default';
  if (!setRowValue(config, '3b', row, now)) addTemplateRow({ config, section: '3b', row, value: now });
  return { slug, was, now };
}

// What `paths` and `identity` print, in that order. Most of it belongs to one repo; a child started
// for another repo must not inherit that part, so PER_REPO_ENV names it (with DESK_BATCH, an input).
const PATHS = {
  DESK_REPO_ROOT: repoRoot, DESK_WORKTREES_DIR: worktreesDir, DESK_HOME: deskHome, DESK_SLUG: repoSlug, DESK_REPO_CONFIG_DIR: repoConfigDir, DESK_DEFAULT_BRANCH: defaultBranch,
  DESK_BIN: binDir, DESK_RUN_BIN: runBin, DESK_STATE: stateDir, DESK_QUEUE: queueFile, DESK_SKILLS_DIR: skillsDir,
  DESK_LOCK_DIR: lockDir, DESK_MEMORY_DIR: memoryDir, DESK_GH_REPO: ghRepo,
  DESK_PG_CONTAINER: pgContainer, DESK_DEV_PORT: devPort, DESK_WORKER_PORT_FLOOR: workerPortFloor, DESK_IS_WSL: () => (isWSL() ? 'yes' : 'no'),
};
const IDENTITY = { DESK_GITHUB_HANDLE: githubHandle, DESK_JIRA_NAME: jiraName };
export const MACHINE_PATHS = ['DESK_HOME', 'DESK_BIN', 'DESK_RUN_BIN', 'DESK_SKILLS_DIR', 'DESK_LOCK_DIR', 'DESK_IS_WSL'];
export const PATH_VARS = Object.keys(PATHS);
// The subcommands that write the machine profile, the cost sources, the login rules, the subscription
// or the lever freeze: the user's to
// confirm, so a worker is refused them here as well as by its deny rules. The deny rules match on the
// command's start, and `--batch <name>` may come before the subcommand, so they cannot hold alone.
export const WORKER_DENIED_WRITES = ['machine write', 'machine set', 'costs write', 'logins set', 'logins default', 'logins remove', 'subscription set', 'levers freeze', 'levers thaw'];
export const PER_REPO_ENV = ['DESK_BATCH', ...Object.keys(PATHS).filter((k) => !MACHINE_PATHS.includes(k)), ...Object.keys(IDENTITY)];
const shellQuote = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

// `desk-env levers freeze|thaw`: sets or clears the freeze file and says so. Returns the lever log
// event every repo's log gets, or null when the freeze was already that way and nothing changed.
function setFreeze(action, reason, file = freezeFile(), now = new Date()) {
  const was = leversFrozen(file);
  if (action === 'freeze') {
    if (was) { console.log(`levers: already frozen since ${was.at}; nothing changed`); return null; }
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ at: now.toISOString(), reason: reason || null })}\n`);
    console.log(`levers: frozen: every trial in every repo is stopped until desk-env levers thaw (${file})`);
  } else {
    if (!was) { console.log('levers: not frozen; nothing changed'); return null; }
    unlinkSync(file);
    console.log('levers: thawed: trials resume');
  }
  return { kind: action, actor: 'ben', reason_code: action, reason: reason || `${action === 'freeze' ? 'frozen' : 'thawed'} by hand with desk-env levers ${action}`, at: now.toISOString() };
}

// Appends `event` to the lever log of every repo with a desk config; returns 1 when any could not be
// written, naming each.
function logEveryRepo(append, event, repos = configuredRepos()) {
  let failed = 0;
  for (const { slug } of repos) {
    try { append(slug, event); } catch (e) { failed++; console.error(`desk-env levers: ${slug}'s lever log: ${e.message}`); }
  }
  console.log(`levers: ${event.kind} logged in ${repos.length - failed} of ${repos.length} repo lever logs`);
  return failed ? 1 : 0;
}

// Appends a row_change event to this repo's lever log when its levers row reads differently from the
// last row the log recorded, or the log has recorded none. The log is read and written under its lock,
// so callers reading one edit at once record it once. A worker records nothing: the row is the user's,
// and a worker's `desk-env` is read-only. A log it cannot write is said, not fatal.
function logRowChange(row, LL) {
  if (process.env.DESK_AUTOPILOT_WORKER === '1') return;
  const p = configPathOrNull();
  if (!p || !existsSync(p)) return;
  const key = (r) => leverWords([r ?? 'none']).sort().join(' ');
  try {
    const slug = repoSlug();
    LL.appendWith(slug, () => {
      const last = LL.read(slug, { kinds: ['row_change'] }).events.at(-1);
      if (last && key(last.after) === key(row)) return null;
      const after = row ?? 'none';
      return { kind: 'row_change', actor: 'ben', reason_code: 'row_change', reason: `config §3b "${CONFIG_ROWS.levers.row}" now reads \`${after}\``, before: last?.after ?? null, after };
    });
  } catch (e) {
    console.error(`desk-env levers: could not record the row change in the lever log: ${e.message}`);
  }
}

// What `get`, `list`, `perm`, `perm-or-unset` and `budget` print for one id, or null where they exit
// 3. The CLI cases print it and `config` snapshots it, so desk-env.sh's readers answer as they do.
const line = (v) => (v == null ? null : `${v}\n`);
const READS = {
  // default-branch honours a batch's base (inherited as DESK_DEFAULT_BRANCH), so a worker that asks
  // for <default> gets the branch its batch targets, not the config row.
  get: (id) => line(expandHome(id === 'default-branch' ? defaultBranch() : configValue(id))),
  list: (id) => configValues(id)?.map((x) => line(expandHome(x))).join('') ?? null,
  perm: (id) => line(permission(id)),
  'perm-or-unset': (id) => line(permissionOrUnset(id)),
  budget: (which) => {
    const b = which === 'batch' ? batchBudget() : which === 'worker' ? workerBudget() : null;
    if (!b) throw new Error('usage: desk-env.mjs budget worker|batch');
    return line(b.off ? 'none' : b.usd);
  },
};
const printRead = (cmd, id) => {
  const out = READS[cmd](id);
  if (out == null) process.exit(3);
  process.stdout.write(out);
};

// The files desk skills leave untracked in a worktree and never commit, each with the skill that writes
// it. `<TICKET>` stands for any one path segment. tree-status leaves them out of git status.
export const KNOWN_UNTRACKED = Object.freeze([
  Object.freeze({ path: '.claude/desk-ticket-<TICKET>.json', by: 'desk-ticket', what: 'resume file' }),
]);
// The scratch files one desk-review run writes at the worktree root, `<run>` that run's id and `<seat>`
// a role; `tree-status --run <run>` leaves out the ones carrying that id.
const REVIEW_SCRATCH = Object.freeze(['desk-review-codex-brief-<run>.txt', 'desk-review-<seat>-brief-<run>.txt', 'desk-review-results-<run>.json', 'desk-review.md']);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templateRe = (t, fill) => new RegExp(`^${t.split(/(<[A-Za-z]+>)/).map((p) => (/^<[A-Za-z]+>$/.test(p) ? fill(p) : escapeRe(p))).join('')}$`);

// The lines of `git status --porcelain --untracked-files=all` output that are changes: every line but an
// untracked known file, or with `run`, an untracked scratch file of that review run.
export function treeStatus(porcelain, { run } = {}) {
  const known = KNOWN_UNTRACKED.map((k) => templateRe(k.path, () => '[^/]+'));
  if (run) known.push(...REVIEW_SCRATCH.map((s) => templateRe(s, (p) => (p === '<run>' ? escapeRe(run) : '[^/]+'))));
  return porcelain.split('\n').filter((l) => l && !(l.startsWith('?? ') && known.some((re) => re.test(l.slice(3)))));
}

// ---- CLI -----------------------------------------------------------------------------------
// The subcommands the CLI handles: any other is refused with this usage. tests/test_desk_env_commands.mjs
// holds the switch below equal to it.
export const DESK_ENV_COMMANDS = Object.freeze(['where', 'list', 'cmds', 'required-fields', 'get', 'review-cmd', 'verdict-logins',
  'levers', 'lines', 'batch-base', 'ticket-kind', 'branch-check', 'perm-or-unset', 'perm', 'config', 'merge-grant', 'key', 'model',
  'effort', 'budget', 'ids', 'paths', 'take-batch', 'identity', 'git-author', 'mem', 'heavy', 'test-scope', 'workspace-test',
  'baseline', 'uuid', 'default-mode', 'unanswered', 'show', 'drift', 'add-row', 'port-in-use', 'ports', 'machine', 'costs', 'logins', 'subscription', 'lease', 'preview-slot', 'tree-status']);
const deskEnvUsage = () => `usage: desk-env.mjs ${DESK_ENV_COMMANDS.join('|')}`;

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);
  if (process.env.DESK_AUTOPILOT_WORKER === '1' && WORKER_DENIED_WRITES.includes(`${cmd} ${args[0]}`)) {
    console.error(`desk-env ${cmd} ${args[0]}: refused in an autopilot worker; this change is the user's to confirm.`);
    process.exit(4);
  }
  if (!DESK_ENV_COMMANDS.includes(cmd)) { console.error(deskEnvUsage()); process.exit(2); }
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
      case 'show': {
        const p = configPathOrNull();
        if (!p || !existsSync(p)) { console.error('desk-env show: no config for this repo (run /desk-setup)'); process.exit(3); }
        console.log(configRows(readFileSync(p, 'utf8'), args));
        break;
      }
      case 'list':
        printRead(cmd, args[0]);
        break;
      case 'cmds': {
        const v = configValues(args[0]);
        if (v == null) process.exit(3);
        if (isNone(v)) break;
        for (const x of v) { const c = parseCommandItem(x); console.log(`${c.dir}\t${c.cmd}`); }
        break;
      }
      case 'required-fields': {
        console.log(JSON.stringify(requiredFields(args[0] ?? '')));
        break;
      }
      case 'get':
        printRead(cmd, args[0]);
        break;
      case 'review-cmd': {
        const { run } = reviewRows();
        if (run == null) process.exit(3);
        console.log(run);
        break;
      }
      case 'verdict-logins': {
        // The logins a verdict is read as desk's own from, comma-separated (merge-driver.sh's --handle).
        const l = verdictLogins();
        if (!l) process.exit(3);
        console.log(l);
        break;
      }
      case 'levers': {
        // `levers freeze [reason]` and `levers thaw [reason]` set and clear the machine-wide freeze;
        // `levers <name>` prints on or off; bare, what is on, where each lever's state comes from, the
        // freeze, and every name desk does not know. An invalid row is said either way, and exits 1
        // only bare, so a script asking about one lever still reads `off`.
        // lever-log.mjs imports this module, so it is loaded without `await`: awaiting it here would
        // leave each module waiting for the other to finish, and node would exit with nothing written.
        const leverLog = (fn) => import('./lever-log.mjs').then(fn, (e) => { console.error(`desk-env levers: the lever log: ${e.message}`); process.exitCode = 1; });
        if (args[0] === 'freeze' || args[0] === 'thaw') {
          const event = setFreeze(args[0], args.slice(1).join(' ').trim());
          if (event) leverLog((LL) => { process.exitCode = logEveryRepo(LL.append, event); });
          break;
        }
        const s = leverStates();
        if (s.from === 'row') leverLog((LL) => logRowChange(s.row, LL));
        const l = levers();
        const known = `known: ${LEVERS.join(', ')}`;
        const row = `config §3b "${CONFIG_ROWS.levers.row}"`;
        if (s.invalid) {
          console.error(`desk-env: ${row} is invalid: ${s.invalid}`);
          if (!args[0]) process.exitCode = 1;
        }
        if (args[0]) {
          console.log(leverOn(args[0], l) ? 'on' : 'off');
          if (!LEVERS.includes(args[0])) console.error(`desk-env: "${args[0]}" is not a lever desk knows (${known}); read as off`);
          break;
        }
        console.log(`on: ${l.on.join(' ') || 'none'}`);
        console.log(`from: ${s.from === 'pin' ? 'this ticket\'s pin (DESK_LEVERS)' : `${row}, \`${s.row ?? 'none'}\``}`);
        for (const n of LEVERS) console.log(`${n}: ${s.states[n]}`);
        const f = leversFrozen();
        if (f) console.log(`frozen: every trial in every repo is stopped, since ${f.at}${f.reason ? ` (${f.reason})` : ''}; desk-env levers thaw ends it`);
        if (l.unknown.length) console.log(`unknown: ${l.unknown.join(' ')} (${row} names levers desk does not know; each is read as off; ${known})`);
        // With `auto`, one line of each managed lever's state in this repo, from its lever log.
        if (Object.values(s.states).includes('auto')) {
          Promise.all([import('./lever-log.mjs'), import('./lever-changes.mjs')]).then(([LL, LC]) => {
            const slug = repoSlug();
            const line = LC.summaryLine({ slug, states: s.states, events: LL.read(slug).events });
            if (line) console.log(line);
          }).catch((e) => { console.error(`desk-env levers: the summary line: ${e.message}`); process.exitCode = 1; });
        }
        break;
      }
      case 'lines': {
        // The wrappers lever's one wrapper: `sed -n A,Bp <file>` as one command, refused whatever a
        // worker's reading tools are refused (desk-lines.mjs).
        if (!leverOn('wrappers')) {
          console.error(`desk-env lines: refused: the wrappers lever is off (config §3b "${CONFIG_ROWS.levers.row}"). Read the range with the Read tool's offset and limit`);
          process.exit(3);
        }
        const L = await import('./desk-lines.mjs');
        const range = L.parseRange(args[1]);
        if (!args[0] || !range || args.length > 2) { console.error('usage: desk-env lines <file> <A>[,<B>|,$]   (prints what sed -n A,Bp <file> prints)'); process.exit(2); }
        let reads;
        try { reads = L.workerReads(); } catch (e) { console.error(`desk-env lines: refused: ${e.message}`); process.exit(1); }
        let creds = reads?.creds ?? null;
        try { creds ??= credsDir(); } catch { /* no repo config: no credentials directory to keep out of */ }
        const why = L.readRefusal(args[0], { creds, dirs: reads?.dirs ?? null });
        if (why) { console.error(`desk-env lines: refused: ${why}`); process.exit(1); }
        let text;
        try { text = readFileSync(args[0], 'latin1'); }
        catch (e) { console.error(`desk-env lines: ${args[0]}: ${e.code === 'ENOENT' ? 'No such file or directory' : e.code === 'EISDIR' ? 'Is a directory' : e.message}`); process.exit(1); }
        process.stdout.write(L.sliceLines(text, range), 'latin1');
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
      case 'branch-check': {
        const why = branchProblem(args[0]);
        if (why) { console.error(`desk: branch '${args[0] ?? ''}' is not usable: ${why}`); process.exit(1); }
        break;
      }
      case 'perm-or-unset':
      case 'perm':
        printRead(cmd, args[0]);
        break;
      case 'config': {
        // Every value desk-env.sh's readers (desk_cfg, desk_list, desk_perm, desk_perm_or_unset,
        // desk_budget) give, as assignments for desk_load_config to eval: `=` and what get, list, perm,
        // perm-or-unset or budget prints, or `!` for one that exits 3. A read that fails is assigned
        // empty, so the shell asks node for it alone and gets that read's own error, and a value from
        // an earlier snapshot is not kept. default-branch is left out: it follows the queue's batch
        // base, which can change mid-run.
        const out = [];
        const put = (kind, cmd, id) => {
          if (!/^[a-z0-9-]+$/.test(id)) return;
          let v;
          try { v = READS[cmd](id); v = v == null ? '!' : `=${v}`; } catch { v = ''; }
          out.push(`_DESK_${kind}_${id.replaceAll('-', '_')}=${shellQuote(v)}`);
        };
        for (const id of Object.keys(CONFIG_ROWS)) {
          if (id !== 'default-branch') put('G', 'get', id);
          put('L', 'list', id);
        }
        for (const id of Object.keys(PERMISSION_KEYS)) {
          put('P', 'perm', id);
          put('U', 'perm-or-unset', id);
        }
        put('B', 'budget', 'worker');
        put('B', 'budget', 'batch');
        console.log(out.join('\n'));
        break;
      }
      case 'merge-grant': {
        const g = mergeGrant();
        console.log(`${g.by ?? 'none'}\t${g.why}`);
        if (!g.by) process.exit(1);
        break;
      }
      case 'key':
        if (!PERMISSION_KEYS[args[0]]) throw new Error(`desk-env: unknown permission id "${args[0]}"`);
        console.log(PERMISSION_KEYS[args[0]]);
        break;
      case 'model': {
        // §3b Worker models' finder or text model; `none` when it is unset (no override). Exits 0
        // either way, so a worker reads the answer without a compound `; echo $?`.
        if (!EXTRA_MODELS.includes(args[0])) throw new Error(`usage: desk-env.mjs model ${EXTRA_MODELS.join('|')}`);
        console.log(workerModels()[args[0]] || 'none');
        break;
      }
      case 'effort':
        // What spawn-worker.sh launches a session at; a malformed §3b Worker effort row exits 4.
        if (!args[0]) throw new Error(`usage: desk-env.mjs effort ${EFFORT_STARTS.join('|')}`);
        console.log(workerEffort(args[0]));
        break;
      case 'budget':
        printRead(cmd, args[0]);
        break;
      case 'ids':
        for (const [id, key] of Object.entries(PERMISSION_KEYS)) console.log(`perm ${id} -> §3 ${key} = ${permission(id)}`);
        for (const [id, r] of Object.entries(CONFIG_ROWS)) {
          // A row `list` refuses is not set, whatever its first item reads as through `get`.
          let refused = null;
          try { configValues(id); } catch (e) { if (!(e instanceof DeskConfigError)) throw e; refused = e.message; }
          console.log(`get  ${id} -> §${r.section} "${r.row}" = ${refused ? `(not readable: ${refused})` : configValue(id)?.replaceAll('\n', ' · ') ?? '(unset)'}`);
        }
        break;
      case 'paths': {
        // --machine: only the entries no repo is needed for, so a caller outside a configured repo
        // can still find desk's own directories.
        // Outside a configured repo, the bare form prints the machine paths too, and each per-repo one
        // as an unset comment rather than a fallback guessed without a repo, then still exits 4.
        const keys = args[0] === '--machine' ? MACHINE_PATHS : Object.keys(PATHS);
        let noRepo = null;
        if (keys.some((k) => !MACHINE_PATHS.includes(k))) {
          try { repoRoot(); } catch (e) { if (!(e instanceof DeskConfigError)) throw e; noRepo = e; }
        }
        const lines = keys.map((k) => [k, noRepo && !MACHINE_PATHS.includes(k) ? null : PATHS[k]()]);
        for (const [k, v] of lines) console.log(v == null ? `# ${k} unset: no repo config` : `${k}=${shellQuote(v)}`);
        if (noRepo) {
          console.error(`desk-env paths: no repo config found, so only the machine paths are set. ${noRepo.message}`);
          process.exit(4);
        }
        break;
      }
      case 'take-batch': {
        // Loading this module already took --batch out of argv and checked it, so the shell has one parser.
        if (batchArg) console.log(`export DESK_BATCH=${shellQuote(batchArg)}`);
        console.log(`DESK_ARGS=(${args.map((a) => shellQuote(a)).join(' ')})`);
        break;
      }
      case 'identity':
        for (const [k, f] of Object.entries(IDENTITY)) console.log(`${k}=${shellQuote(f())}`);
        break;
      case 'git-author': {
        const a = gitAuthor();
        if (!a) process.exit(3);
        console.log(`${a.name}\t${a.email}`);
        break;
      }
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
          let harm = null;
          let unread = null;
          for (;;) {
            // A sample whose processes cannot be read is skipped, said once until ps reads again.
            let heavy = null;
            try { heavy = heavyProcesses().length; unread = null; } catch (e) {
              if (unread !== e.message) console.log(`HEAVY-UNKNOWN: ${e.message}`);
              unread = e.message;
            }
            const r = heavy === null ? { state } : sustainedStep(state, { now: Date.now(), avail: availableGiB(), heavy }, cfg);
            state = r.state;
            if (r.line) console.log(r.line);
            // --window is the avail watch's; the harm signals keep their own ten-minute window.
            const h = harmStep(harm, { now: Date.now(), ...harmSample() });
            harm = h.state;
            for (const l of h.lines) console.log(l);
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
        const pkgs = TS.workspacePackages(top);
        const d = TS.decide(changes, { shared: TS.sharedPackages(pkgs), related: relatedItems.length > 0 });
        const suites = { relatedItems, fullItems: items('test-cmd') };
        // A touched workspace no item covers runs its own test script, or is named UNCOVERED.
        const loose = TS.uncoveredWorkspaces(d, pkgs, suites);
        const label = (w) => `${w.dir}${w.name ? ` (${w.name})` : ''}`;
        console.log(`scope=${d.scope}`);
        console.log(`reason=${d.reason}`);
        console.log(`changed=${d.files.length}`);
        for (const w of loose.filter((x) => x.test)) console.log(`workspace=${label(w)} has a changed file no §4 Related or Unit tests item covers, so its suite line runs its package.json test script (${w.test}) there; workspace-test caps it, so add no --maxWorkers`);
        for (const r of TS.runs(d, suites)) console.log(`${r.dir}\t${r.cmd}\t${r.files.join(' ')}`);
        for (const w of loose.filter((x) => x.test)) console.log(`.\tdesk-env workspace-test ${w.dir}\t`);
        for (const w of loose.filter((x) => !x.test)) console.log(`UNCOVERED\t${label(w)}\thas a changed file no §4 Related or Unit tests item covers and no package.json test script: nothing ran for it, so the PR's Testing names it untested and never says its tests passed`);
        break;
      }
      case 'workspace-test': {
        // One workspace package's own package.json test script, in its directory, capped where it is
        // Vitest or Jest; test-scope prints it as a suite line, so the worker runs it under the test lock.
        // The package is read from the worktree now, so a workspace the branch added runs too, and
        // nothing but a workspace package's test script runs here.
        const top = git(process.cwd(), 'rev-parse', '--show-toplevel');
        if (!top) throw new Error('desk-env workspace-test: not inside a git work tree');
        if (args.length !== 1) { console.error('usage: desk-env.mjs workspace-test <workspace dir>'); process.exit(2); }
        const want = args[0].replace(/^(\.\/)+/, '').replace(/\/+$/, '');
        const w = TS.workspacePackages(top).find((p) => p.dir === want);
        if (!w) { console.error(`desk-env workspace-test: ${args[0]} is not a workspace package of ${top}`); process.exit(2); }
        if (!w.test) { console.error(`desk-env workspace-test: ${w.dir} has no package.json test script`); process.exit(2); }
        const pmItems = configValues('package-manager');
        const cmd = TS.workspaceTestCmd(TS.packageManager(top, pmItems && !isNone(pmItems) ? pmItems[0] : null), w.test, configValue('test-cap'));
        const prefix = commandPrefix();
        const [bin, ...argv] = prefix ? ['sh', '-c', `${prefix} ${cmd}`] : cmd.split(' ');
        const r = spawnSync(bin, argv, { cwd: join(top, w.dir), stdio: 'inherit' });
        const code = r.status ?? 1;
        console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${w.dir}: ${cmd} (exit ${code})`);
        process.exitCode = code === 0 ? 0 : 1;
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
        const prefix = commandPrefix();
        let pass = true;
        for (const { dir, cmd } of list) {
          const run = B.runItem({ bin: runBin(), root: top, dir, cmd, lock: lockFor(row), prefix });
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
      // unanswered <config.md>: how many of its rows are still `TODO` (install.sh's per-repo line).
      case 'unanswered':
        console.log(unansweredRows(args[0]));
        break;
      case 'drift': {
        const ai = args.indexOf('--app');
        if (ai >= 0) {
          // One app's setup gaps, for the one screenshot park that names them all.
          const dir = args[ai + 1];
          if (!dir || dir.startsWith('-') || args.includes('--all')) { console.error('usage: desk-env.mjs drift --app <app dir>'); process.exit(2); }
          const config = configPathOrNull();
          if (!config || !existsSync(config)) throw new DeskConfigError(`desk-env drift: no config at ${configPathHint()}: run /desk-setup`);
          const parsed = parseConfigFile(config);
          const root = configRepoRoot(parsed) || process.cwd();
          const gaps = appSetupGaps(parsed, root, dir);
          for (const l of appGapLines(gaps, dir)) console.log(l);
          process.exitCode = gaps.length ? 1 : 0;
          break;
        }
        // One repo's config (the cwd's), or with --all every config under ~/.config/desk/repos/.
        const repos = args.includes('--all') ? configuredRepos() : [{ slug: null, config: configPathOrNull() }];
        if (!repos.length) { console.log(`no repo configs under ${join(deskConfigRoot(), 'repos')}`); break; }
        let drift = false;
        for (const { slug, config } of repos) {
          if (!config || !existsSync(config)) throw new DeskConfigError(`desk-env drift: no config at ${configPathHint()}: run /desk-setup`);
          const parsed = parseConfigFile(config);
          const root = configRepoRoot(parsed, { cwd: !slug });
          const premerge = configValuesIn(parsed, 'pre-merge-steps');
          const jobKeyed = root && premerge && !isNone(premerge) ? jobKeyedPremerge(premerge, root) : [];
          const lines = driftLines({ ...configDrift({ config, root }), jobKeyed });
          if (lines[0] !== 'no drift') drift = true;
          if (slug) console.log(`== ${slug}`);
          for (const l of lines) console.log(slug ? `  ${l}` : l);
        }
        process.exitCode = drift ? 1 : 0;
        break;
      }
      case 'add-row': {
        const i = args.indexOf('--note');
        const note = i >= 0 ? args[i + 1] ?? '' : '';
        const pos = i >= 0 ? [...args.slice(0, i), ...args.slice(i + 2)] : args;
        if (pos.length !== 3) throw new Error('usage: desk-env.mjs add-row <section> <§3 key | "row name"> <value> [--note "<text>"]');
        const r = addTemplateRow({ config: configPathOrNull(), section: pos[0], row: pos[1], value: pos[2], note });
        console.log(`ADDED §${r.section} ${r.label}: ${r.line}`);
        if (r.section === '3' && PERMISSION_KEYS[norm(r.label)]) console.log(`perm ${norm(r.label)} = ${permission(norm(r.label))}`);
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
        const [sub, ...rest] = args;
        const [key] = rest;
        const path = machineProfilePath();
        if (sub === 'get' || sub === 'why') {
          const v = sub === 'get' ? machineValue(String(key ?? '').toLowerCase()) : machineWhy(String(key ?? '').toLowerCase());
          if (v == null) process.exit(3);
          console.log(v);
          break;
        }
        if (!['detect', 'propose', 'write', 'set'].includes(sub)) {
          console.error('usage: desk-env.mjs machine detect|propose|write|set <key>=<value>...|get <key>|why <key>');
          process.exit(2);
        }
        const profile = machineProfile();
        if (sub === 'set') {
          // Every pair is checked before anything is written, so one bad value stores nothing. A
          // proposed size is stored as an override; `<size>=` clears one back to the proposal.
          const rows = [];
          const ri = rest.indexOf('--reason');
          const reason = ri >= 0 ? rest[ri + 1] : '';
          if (ri >= 0 && !String(reason ?? '').trim()) { console.error('nothing written: --reason needs the reason as its next argument'); process.exit(1); }
          const pairs = ri >= 0 ? rest.filter((_, j) => j !== ri && j !== ri + 1) : rest;
          for (const pair of pairs) {
            const i = pair.indexOf('=');
            const k = (i > 0 ? pair.slice(0, i) : pair).trim().toLowerCase();
            const v = i > 0 ? pair.slice(i + 1).trim() : '';
            if (i > 0 && M.isSizingKey(k)) {
              if (v === '') {
                if (!M.isOverride(profile?.sizing?.[k])) { console.error(`nothing written: \`${k}\` holds no override to clear`); process.exit(1); }
                // Back to what the rules propose for the hardware the profile records; with none
                // recorded there is no proposal, so the row goes.
                const recorded = M.sizesProposed(profile) ? Object.fromEntries(Object.entries(profile.hardware).map(([hk, h]) => [hk, h.value])) : null;
                const back = recorded ? M.propose(recorded).find((s) => s.key === k) : null;
                rows.push(back ?? { key: k, value: null });
                continue;
              }
              const bad = M.sizingSettingError(k, v);
              if (bad) { console.error(`nothing written: ${bad}`); process.exit(1); }
              rows.push({ key: k, value: v, why: M.overrideWhy(reason) });
              continue;
            }
            const bad = i > 0 ? M.benchSettingError(k, v) : `"${pair}" is not <key>=<value>`;
            if (bad) { console.error(`nothing written: ${bad}${i > 0 && !M.benchWhy(k) ? `, or a size: ${M.SIZING_KEYS.join(', ')}` : ''}`); process.exit(1); }
            rows.push({ key: k, value: v, why: M.benchWhy(k) });
          }
          if (!rows.length) { console.error('usage: desk-env.mjs machine set <key>=<value>...'); process.exit(2); }
          // Without a profile, one is started holding only these rows: no hardware, so the next detect
          // still offers the whole proposal.
          const text = existsSync(path) ? readFileSync(path, 'utf8') : M.BENCH_ONLY_PROFILE;
          console.log(writeWithBackup(path, M.setSizingRows(text, rows)));
          // Read back from the written file, so what prints is what the readers will get.
          const stored = M.readProfile(path)?.sizing ?? {};
          for (const r of rows) console.log(stored[r.key] ? `  ${r.key}: ${stored[r.key].value} (${stored[r.key].why})` : `  ${r.key}: removed`);
          break;
        }
        const hw = M.gather();
        const proposal = M.propose(hw);
        if (sub === 'detect') {
          for (const k of M.HARDWARE_KEYS) console.log(`${k.padEnd(18)} ${hw[k]}`);
          if (!profile) { console.log(`\nno profile at ${path}: desk-env machine propose shows the sizes it would write`); break; }
          const problems = M.profileProblems(profile);
          if (problems.length) console.log(`\nrows in ${path} it cannot read (desk-env machine set <key>=<value> rewrites one):`);
          for (const p of problems) console.log(`  ${p}`);
          // Listed before the no-sizes stop: `machine set` can start a profile holding only an override.
          const ovr = M.sizingOverrides(profile, proposal);
          if (ovr.length) console.log('\noverrides kept (a re-write keeps them; desk-env machine write --drop-override <key> drops one):');
          for (const o of ovr) console.log(`  ${o.key}: ${o.value} (the rules propose ${o.proposed}) ${o.why}`);
          if (!M.sizesProposed(profile)) { console.log(`\nno sizes proposed in ${path} yet: desk-env machine propose shows the sizes it would write`); break; }
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
            const ovr = M.isOverride(profile?.sizing[s.key]) ? ', an override that write keeps' : '';
            console.log(`${s.key.padEnd(27)} ${s.value.padEnd(8)} ${s.why}${was != null && (was !== s.value || ovr) ? `  (profile: ${was}${ovr})` : ''}`);
          }
          break;
        }
        // write: overwrites; /desk-setup runs it only after the user confirms the proposal. Overrides
        // and the rows the proposal does not make (the bench settings) are kept; --drop-override <key>
        // replaces one override with the proposal.
        const drop = [];
        for (let j = 0; j < rest.length; j++) {
          if (rest[j] !== '--drop-override') { console.error(`usage: desk-env.mjs machine write [--drop-override <key>]...: "${rest[j]}" is not one`); process.exit(2); }
          const k = String(rest[++j] ?? '').trim().toLowerCase();
          if (!M.isOverride(profile?.sizing?.[k]) || !M.isSizingKey(k)) { console.error(`nothing written: \`${k}\` is not an override in ${path}`); process.exit(1); }
          drop.push(k);
        }
        console.log(writeWithBackup(path, M.renderProfile(hw, M.rewrittenSizing(profile, proposal, drop), new Date().toISOString().slice(0, 10))));
        for (const k of drop) console.log(`dropped override ${k}: now ${proposal.find((s) => s.key === k).value}, as proposed`);
        for (const o of M.sizingOverrides(profile, proposal).filter((x) => !drop.includes(x.key))) {
          console.log(`kept override ${o.key}: ${o.value} (the rules propose ${o.proposed}); desk-env machine write --drop-override ${o.key} drops it`);
        }
        break;
      }
      case 'costs': {
        const [sub, ...rest] = args;
        const C = await import('./costs.mjs');
        const path = costsPath();
        const saved = C.readCosts(path);
        if (sub === 'show') {
          if (!saved.exists) { console.log(`no cost sources (no file at ${path}): /desk-setup costs records them`); break; }
          if (rest.includes('--json')) { console.log(JSON.stringify({ names: C.costsByName(saved), budget: saved.budget, logins: saved.logins }, null, 2)); break; }
          for (const l of C.proposalLines(saved)) console.log(l);
          break;
        }
        if (!['detect', 'propose', 'write'].includes(sub)) {
          console.error('usage: desk-env.mjs costs detect|propose|write|show [--name <supplier>:<key>=<name>] [--drop <supplier>:<key>] [--actions-budget <usd>] [--credit <profile>=<usd>@<YYYY-MM-DD>]');
          process.exit(2);
        }
        const edits = C.parseEdits(sub === 'detect' ? [] : rest);
        const found = await C.detect({ repos: configuredRepos() });
        if (sub === 'detect') {
          console.log(`github (gh signed in as ${found.login ?? 'nobody: gh auth login'}):`);
          for (const r of found.repos) console.log(`  ${r.ghRepo}  (repo ${r.slug})`);
          console.log(`vercel (${found.vercel.auth}):${found.vercel.error ? ` ${found.vercel.error}` : ''}`);
          for (const t of found.vercel.teams) console.log(`  ${t.slug}  ${t.id}  plan ${t.plan}  projects: ${t.projects.join(', ') || 'none'}`);
          console.log(`aws (${found.aws.path}):${found.aws.error ? ` ${found.aws.error}` : ''}`);
          for (const p of found.aws.profiles) console.log(`  ${p}`);
          break;
        }
        const proposal = C.propose({ found, saved, edits, today: new Date().toISOString().slice(0, 10) });
        if (sub === 'propose') {
          for (const w of [found.vercel.error && `vercel: ${found.vercel.error}`, found.aws.error && `aws: ${found.aws.error}`].filter(Boolean)) console.log(`warning: ${w}`);
          for (const l of C.proposalLines(proposal)) console.log(l);
          console.log(`\nnothing written: desk-env costs write with the same options saves this to ${path}`);
          break;
        }
        // write: overwrites; /desk-setup costs runs it only after the user confirms the proposal.
        console.log(writeWithBackup(path, C.renderCosts(proposal)));
        break;
      }
      case 'logins': {
        const [sub, ...rest] = args;
        const L = await import('./logins.mjs');
        const path = subscriptionsPath();
        let subs = L.readSubscriptions(path);
        const json = rest.includes('--json');
        if (sub === 'list') {
          // A file still in the older rules is written once as one default per tool and the rest unused.
          const was = subs;
          subs = L.migrateSubscriptions(was);
          if (L.needsMigration(was) && !was.errors.length && process.env.DESK_AUTOPILOT_WORKER !== '1') {
            writeWithBackup(path, L.renderSubscriptions(subs.logins.filter((l) => l.source === 'file'), subs.removed));
            console.error(`${path}: now records one default per tool and every other login as unused; the previous copy is ${path}.bak`);
          }
          if (json) console.log(JSON.stringify({ file: path, exists: subs.exists, errors: subs.errors, logins: subs.logins.map(L.loginJson) }, null, 2));
          else for (const l of L.listLines(subs, path)) console.log(l);
          break;
        }
        if (sub === 'check') {
          const r = L.checkLogins(subs);
          if (json) console.log(JSON.stringify({ file: path, exists: r.exists, errors: r.errors, logins: r.logins.map(L.loginJson), usable: r.usable.map((l) => `${l.tool}:${l.name}`) }, null, 2));
          else for (const l of L.checkLines(r, path)) console.log(l);
          break;
        }
        // The repos whose Subscription row runs on login `l`: it is neither removed nor turned off.
        const repos = (l) => (l.tool === 'claude'
          ? repoSubscriptions(L, subs).filter((s) => s.source === 'row' && s.login?.dir === l.dir).map((s) => s.slug) : []);
        if (sub === 'set' && rest.length >= 3) {
          const [tool, name, ...rule] = rest;
          const r = L.setRule(subs, { tool, name, rule: rule.join(' '), check: () => L.checkLogins(subs), repos });
          console.log(writeWithBackup(path, r.text));
          console.log(`${tool} ${name}: ${r.login.rule === 'off' ? 'off' : 'unused'}`);
          break;
        }
        if (sub === 'default' && rest.length === 2) {
          const [tool, who] = rest;
          const r = L.setDefault(subs, { tool, who });
          console.log(writeWithBackup(path, r.text));
          console.log(`${tool} ${r.login.name}: default${r.was ? `; ${r.was.name}: unused` : ''}`);
          break;
        }
        if (sub === 'remove' && rest.length === 2) {
          const [tool, name] = rest;
          const r = L.removeLogin(subs, { tool, name, check: () => L.checkLogins(subs), repos });
          console.log(writeWithBackup(path, r.text));
          console.log(`${tool} ${name}: removed; ${r.login.folder} and its sign-in are left as they are`);
          break;
        }
        if (sub === 'pin' && rest.length === 2 && rest[0] === 'claude') {
          const r = L.pinLogin(subs, { tool: 'claude', name: rest[1], check: () => L.checkLogins(subs) });
          console.log(writeWithBackup(path, r.text));
          console.log(`claude ${r.login.name}: pinned to ${r.login.account}, ${L.ruleWord(r.login)}`);
          break;
        }
        if (sub === 'migrate' && rest.length === 0) {
          if (!L.needsPinMigration(subs)) { console.log('nothing to migrate'); break; }
          const r = L.migratePins(subs, () => L.checkLogins(subs));
          if (r.text === null) { console.log('nothing to migrate'); break; }
          console.log(writeWithBackup(path, r.text));
          if (r.hint) console.log(`add ${r.hint} with a in view 6`);
          break;
        }
        console.error(`usage: desk-env.mjs logins list|check [--json] | default <claude|codex> <name|account> | set <claude|codex> <name> <${Object.keys(L.SET_WORDS).join('|')}> | remove <claude|codex> <name> | pin claude <name> | migrate`);
        process.exit(2);
        break;
      }
      case 'subscription': {
        const [sub, ...rest] = args;
        const L = await import('./logins.mjs');
        const subs = L.readSubscriptions(subscriptionsPath());
        const json = args.includes('--json');
        const shown = (r) => ({ email: r.email, source: r.source, login: r.login?.name ?? null, folder: r.login?.folder ?? null, configDir: r.login?.configDir ?? null });
        if (sub === 'list' && rest.every((a) => a === '--json')) {
          const all = repoSubscriptions(L, subs);
          if (json) console.log(JSON.stringify(all.map((r) => ({ slug: r.slug, ...shown(r) })), null, 2));
          else for (const r of all) console.log([r.slug, r.email ?? '-', r.source, r.login?.folder ?? '-'].join('\t'));
          break;
        }
        if (sub === 'set' && rest.length === 2) {
          const r = await setRepoSubscription(rest[0], rest[1]);
          console.log(`${r.slug}: Subscription ${r.now} (was ${r.was})`);
          break;
        }
        if (sub === undefined || (sub === '--json' && !rest.length)) {
          const r = thisRepoSubscription(L, subs);
          if (!r.login) {
            throw new DeskConfigError(`desk-env subscription: ${r.from} names ${r.email}, which is not one of this computer's subscriptions, so this repo has none (it never falls back to the default): sign that account in and add it in desk-q view 6 (Usage), or change ${r.fix}`);
          }
          const s = shown(r);
          if (json) console.log(JSON.stringify(s, null, 2));
          else for (const [k, v] of [['SUBSCRIPTION', s.email], ['LOGIN', s.login], ['FOLDER', s.folder], ['CONFIG_DIR', s.configDir], ['SOURCE', s.source]]) console.log(`${k}=${shellQuote(v ?? '')}`);
          break;
        }
        console.error('usage: desk-env.mjs subscription [--json] | list [--json] | set <slug> <default|email>');
        process.exit(2);
        break;
      }
      case 'lease':
        process.exit((await import('./leases.mjs')).leaseCli(args, { env: { machineValue, testLockSlots, psRows } }));
      case 'preview-slot': {
        // preview-slot [--wait <seconds>] <label>: take the preview-build slot before a push, waiting
        // for the build in flight (default PREVIEW_WAIT_S). Exit 0 taken or nothing to take, 3 refused, 75
        // gave up waiting, as `lease acquire`.
        const i = args.indexOf('--wait');
        const wait = i < 0 ? PREVIEW_WAIT_S : Number(args[i + 1]);
        if (!Number.isInteger(wait) || wait < 0) { console.error('usage: desk-env preview-slot [--wait <seconds>] <label>'); process.exit(2); }
        const label = args.filter((_, k) => i < 0 || (k !== i && k !== i + 1)).join(' ').trim() || 'a push';
        const lease = previewSlotArgs(label, wait);
        if (!lease) { console.log('no preview slot to take: §4 Vercel names no team'); process.exit(0); }
        process.exit((await import('./leases.mjs')).leaseCli(lease, { env: { machineValue, testLockSlots, psRows } }));
      }
      case 'tree-status': {
        // tree-status [--run <run>]: this tree's changes, as `git status --porcelain --untracked-files=all`
        // prints them, without KNOWN_UNTRACKED (and that review run's scratch files). Exit 0 and nothing
        // printed is a clean tree; 1 lists the changes; 3 is not a git work tree.
        const i = args.indexOf('--run');
        const run = i < 0 ? null : args[i + 1];
        if ((i >= 0 && !run) || args.length !== (i < 0 ? 0 : 2)) { console.error('usage: desk-env tree-status [--run <run>]'); process.exit(2); }
        const r = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', maxBuffer: 64 << 20 });
        if (r.status !== 0) { console.error(`desk-env tree-status: ${(r.stderr || 'git status failed').trim()}`); process.exit(3); }
        const changes = treeStatus(r.stdout, { run });
        if (changes.length) { console.log(changes.join('\n')); process.exit(1); }
        break;
      }
      default:
        console.error(deskEnvUsage());
        process.exit(2);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(e instanceof NoRepoConfigError ? 3 : e instanceof DeskConfigError ? 4 : 1);
  }
}
