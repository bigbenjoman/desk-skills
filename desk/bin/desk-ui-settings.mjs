// What Desk's Settings screen reads (screen-spec §9), for desk-ui.mjs. Everything here only reads:
// a repo's desk setup changes only through /desk-setup, and a subscription only from Usage & costs.
//   repoSettings(slug)      GET /api/settings/repos/<slug>  a repo's config rows, grouped, each with its meaning
//   subscriptionsView()     GET /api/settings/subscriptions every Claude and Codex subscription, with its badge
//   installView()           GET /api/settings/install       the install, GitHub main and the auto-release state line
//   appState()              the app build the server serves, a build that failed, and the installed commit:
//                           /api/meta carries it, and the `server` event says when it moves
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as E from './desk-env.mjs';
import { readInstalled } from './installed.mjs';
import { readSubscriptions, tilde } from './logins.mjs';

const short = (sha) => String(sha ?? '').slice(0, 8);
const yes = (v) => /^yes\b/i.test(String(v ?? '').trim());
// A repo's name as its slug names it: owner__repo -> repo.
export const repoNameOf = (slug) => String(slug).split('__').pop();

// ---- a repo's desk setup (§9.3) -----------------------------------------------------------------

export const NOT_SET = "Desk can't use this until it's set.";
const nonzero = (v) => /[1-9]/.test(String(v ?? ''));
const dollars = (v) => (/^\d+(\.\d+)?$/.test(String(v)) ? `$${v}` : String(v));
// The rows Settings shows, in §9.3's groups. `meaning(value, values)` says what the set value does.
export const REPO_ROWS = [
  // §3's rows are permissions (permissionOrUnset), the rest config rows (repoConfigValue).
  { group: 'Autonomy (§3)', id: 'pr-merge-green', label: 'Merge on green', perm: true,
    meaning: (v) => (yes(v) ? 'Workers merge a PR once its checks pass.' : 'A person approves each merge.') },
  { group: 'Autonomy (§3)', id: 'pr-ready', label: 'Undraft PRs', perm: true,
    meaning: (v) => (yes(v) ? 'Workers take PRs out of draft when checks pass.' : 'PRs stay in draft until a person undrafts them.') },
  { group: 'Autonomy (§3)', id: 'autopilot-judgement', label: 'Take judgement calls', perm: true,
    meaning: (v) => (yes(v) ? 'Workers take product, design and wording calls themselves, and log each one.' : 'Workers ask you before a product, design or wording call.') },
  { group: 'Capacity (§3b)', id: 'concurrency', label: 'Concurrency cap',
    value: (v) => String(E.concurrencyLimits(v).cap),
    meaning: (v) => { const n = E.concurrencyLimits(v).cap; return `Up to ${n} worker${n === 1 ? '' : 's'} for this repo.`; } },
  { group: 'Capacity (§3b)', id: 'memory-ceiling', label: 'Memory ceiling', value: (v) => (/^\d+(\.\d+)?$/.test(v) ? `${v} GiB` : v),
    meaning: () => 'No new worker starts above this.' },
  { group: 'Spend', id: 'worker-budget', label: 'Per-worker budget', value: dollars,
    meaning: (v) => (nonzero(v) ? 'The most one worker spends on a ticket before it stops.' : 'No limit on one worker.') },
  { group: 'Spend', id: 'batch-budget', label: 'Per-batch budget', value: dollars,
    meaning: (v) => (nonzero(v) ? 'The most one batch spends before its workers stop.' : 'No limit on one batch.') },
  { group: 'Checks (§4)', id: 'required-checks', label: 'Required checks', list: true, meaning: () => 'A PR merges only once these pass.' },
  { group: 'People', id: 'jira-site', label: 'Jira site', meaning: () => 'Ticket keys link here.' },
  { group: 'People', id: 'code-reviewer', label: 'Code reviewer', meaning: () => 'Reads the review findings on each PR.' },
  { group: 'People', id: 'product-owner', label: 'Product owner', meaning: () => 'Answers the product questions workers ask.' },
];

// -> { slug, name, rows: [{ group, id, label, value, meaning, set }] } | { slug, name, error }. A row
// with no value of its own (blank, TODO or missing) is `Not set`.
export function repoSettings(slug, root = E.deskConfigRoot()) {
  const name = repoNameOf(slug);
  if (!existsSync(join(root, 'repos', slug, 'config.md'))) {
    return { slug, name, error: `Can't read ${name}'s desk setup (desk-config.md missing). Run /desk-setup to create it.` };
  }
  const rows = REPO_ROWS.map((r) => {
    const values = r.list ? (E.repoConfigValues(slug, r.id, root) ?? []) : null;
    const raw = r.list ? (values.length ? values.join(', ') : null)
      : r.perm ? E.repoPermissionOrUnset(slug, r.id, root) : E.repoConfigValue(slug, r.id, root);
    if (raw == null || raw === '') return { group: r.group, id: r.id, label: r.label, value: 'Not set', meaning: NOT_SET, set: false };
    return { group: r.group, id: r.id, label: r.label, value: r.value ? r.value(raw) : String(raw), meaning: r.meaning(raw, values), set: true };
  });
  return { slug, name, rows };
}

// ---- subscriptions (§9.5) -----------------------------------------------------------------------

// The badge rule, here and in Usage & costs: Default, else Off, else Pinned · N repos, else Unused.
export function badgeOf(l) {
  if (l.default) return 'Default';
  if (l.off) return 'Off';
  const n = l.pinned?.length ?? 0;
  return n ? `Pinned · ${n} repo${n === 1 ? '' : 's'}` : 'Unused';
}
const and = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const TOOL = { claude: 'Claude', codex: 'Codex' };

// -> { file, rows: [{ tool, email, name, plan, badge, note }], pinned: [line] } | { file, error }.
// `logins` is desk-q's usage view's (desk-q-model.mjs usageViewJson).
export function subscriptionsView(logins, file = tilde(E.subscriptionsPath())) {
  const rows = logins.map((l) => ({
    tool: TOOL[l.tool] ?? l.tool, email: l.label ?? l.name, name: l.name ?? null, plan: l.plan ?? null, badge: badgeOf(l),
    note: l.default ? `${TOOL[l.tool] ?? l.tool} default` : l.off ? "desk won't pick it for new work." : null,
  }));
  const pinned = logins.filter((l) => l.pinned?.length).map((l) => `${and(l.pinned)} run${l.pinned.length === 1 ? 's' : ''} on ${l.label ?? l.name}${l.name ? ` (${l.name})` : ''}`);
  return { file, rows, pinned };
}
export async function readSubscriptionsView(now = Date.now()) {
  const file = tilde(E.subscriptionsPath());
  try {
    const Q = await import('./desk-q-model.mjs');
    E.forgetReads();
    // desk's own reasons for rows it can't read: the page says the first, verbatim.
    const bad = readSubscriptions(E.subscriptionsPath()).errors ?? [];
    if (bad.length) return { file, error: `desk can't read ${file}: ${bad[0]}${bad.length > 1 ? ` (and ${bad.length - 1} more)` : ''}. Fix those rows first.` };
    return subscriptionsView(Q.usageViewJson(Q.loadRepos(now), { now }).logins, file);
  } catch (e) {
    return { file, error: `desk can't read ${file}: ${String(e.message ?? e).split('\n')[0]}. Fix those rows first.` };
  }
}

// ---- the install (§9.6) -------------------------------------------------------------------------

const git = (dir, ...a) => {
  const r = spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8', timeout: 10_000 });
  return r.status === 0 ? String(r.stdout ?? '').trim() : null;
};
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')) ?? {}; } catch { return {}; } };

// main's own commits after `from` up to `to` (first parent only), as the release counts them, or null.
export function commitsBetween(dir, from, to) {
  if (!dir || !from || !to || from === to) return from && from === to ? 0 : null;
  const n = git(dir, 'rev-list', '--first-parent', '--count', `${from}..${to}`);
  return n == null ? null : Number(n);
}

// The state line (§9.6): { glyph, text } from what the last pass recorded and main's check on its head.
// `check` is maintenance.mjs releaseCheck's answer for `head`.
export function stateLine({ installed, head, check, release = {} }) {
  const at = short(installed), to = short(head);
  if (!head) return { glyph: '◌', text: "◌ Can't tell where GitHub main is: this checkout has never fetched it. desk tries again at the next pass." };
  if (head === installed) return { glyph: '✓', text: `✓ Up to date. Installed ${at} is GitHub main.` };
  if (release.blocked?.sha === head && release.blocked.why) return { glyph: '✕', text: `✕ Not installing ${to}: ${release.blocked.why}.` };
  if (check?.error) return { glyph: '◌', text: `◌ Waiting: main's tests check on ${to} couldn't be read (${check.error}). desk tries again at the next pass.` };
  if (check?.state === 'failure') return { glyph: '✕', text: `✕ main's tests check failed on ${to}, not installing. You stay on ${at} until a newer commit passes.` };
  if (check?.state === 'pending') return { glyph: '·', text: `· Waiting for main's tests check on ${to}. desk installs it once the check passes.` };
  return { glyph: '·', text: `· ${to} passed its tests check. desk installs it at the next pass.` };
}

// `check(src, sha)` is releaseCheck; `release` is release.json. Both are passed in by the tests.
export async function installView({ check = null, release = null, updates = null } = {}) {
  const M = await import('./maintenance.mjs');
  const inst = readInstalled();
  const src = (typeof inst?.from === 'string' && inst.from) || M.sourceCheckout();
  const rel = release ?? readJson(M.releaseFile(M.maintDir()));
  const head = src && existsSync(src) ? git(src, 'rev-parse', '--verify', '-q', 'refs/remotes/origin/main') : null;
  const installed = inst?.commit ?? null;
  const ahead = head && installed && head !== installed ? commitsBetween(src, installed, head) : 0;
  const c = head && installed && head !== installed ? (check ?? M.releaseCheck)(src, head, M.releaseCheck) : null;
  return {
    checkout: src ? tilde(src) : null,
    checked_at: rel.fetched_at ?? null,
    installed: installed && { commit: installed, at: inst.at ?? null },
    main: head && { commit: head, ahead, check: c?.state ?? (c?.error ? 'unreadable' : head === installed ? 'success' : null) },
    state: stateLine({ installed, head, check: c, release: rel }),
    updates,
  };
}

// ---- skill and plugin updates (§9.6 Skills & plugins) -------------------------------------------

export const UPDATES_EVERY_MS = 6 * 60 * 60 * 1000;
const UPDATES_TIMEOUT_MS = 5 * 60 * 1000;
const runJson = (file, args) => new Promise((resolve) => {
  execFile(file, args, { shell: false, timeout: UPDATES_TIMEOUT_MS, maxBuffer: 4 << 20, encoding: 'utf8' },
    // outdated and plugins exit 10 when anything is outdated: that is an answer, not a failure.
    (err, stdout) => { try { resolve(err && err.code !== 10 ? null : JSON.parse(stdout)); } catch { resolve(null); } });
});
// skills-upstream's answers counted: { count, names, at } or null when neither could be read.
export function countUpdates(skills, plugins, at) {
  if (!skills && !plugins) return null;
  const names = [...(skills?.results ?? []).filter((r) => r.outdated).map((r) => r.name),
    ...(Array.isArray(plugins) ? plugins : []).filter((p) => p.status === 'outdated').map((p) => `plugin ${p.plugin}`)];
  return { count: names.length, names, at };
}
// Runs the checkout's skills-upstream, which reads GitHub: in the background, at most every 6 h.
export async function readUpdates(now = Date.now()) {
  const from = readInstalled()?.from;
  const bin = typeof from === 'string' && from ? join(from, 'bin', 'skills-upstream') : null;
  if (!bin || !existsSync(bin)) return null;
  const [skills, plugins] = await Promise.all([runJson(bin, ['outdated', '--json']), runJson(bin, ['plugins', '--json'])]);
  return countUpdates(skills, plugins, new Date(now).toISOString());
}

// ---- the app build -----------------------------------------------------------------------------

const readLine = (f) => { try { return readFileSync(f, 'utf8').trim() || null; } catch { return null; } };
// desk-app.mjs installUi's files: the source hash of the build served, and of a build that failed.
export const appStampFile = (home = E.deskHome()) => join(home, 'ui', 'source-hash');
export const appFailedFile = (home = E.deskHome()) => join(home, 'ui', 'build-failed');
export const appLogFile = () => join(E.HOME, '.desk-autopilot', 'ui', 'desk-ui-build.log');
// -> { app: { build, failed }, installed }: `failed` is the source hash that did not build, null when
// the last build went in.
export function appState(home = E.deskHome()) {
  return { app: { build: readLine(appStampFile(home)), failed: readLine(appFailedFile(home)) }, installed: readInstalled(home)?.commit ?? null };
}
