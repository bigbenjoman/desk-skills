#!/usr/bin/env node
// The change log: the changes to how a repo's workers behave that no lever records and no trial can
// split, each with when it landed and the figures either side of it, so a shift in cost or quality can
// be put down to one of them.
//
//   node desk-changes.mjs [--days <n>] [--window <days>] [--json]
//       the last 30 days' changes unless --days says, each with the tickets merged in the --window days
//       (7 unless it says) before it and after it
//
// Three kinds of entry, oldest first:
//   pr      a first-parent commit on origin's default branch that changed a worker-facing path
//           (isWorkerFacing): its time, the PR it names (a merge commit or a squash, post-merge.mjs
//           landedPr), its ticket and title. A commit naming no PR, as a rebase merge, a revert or a
//           direct push lands, is an entry too, with `pr` null and its subject as the title
//   config  a row whose items differ between two consecutive copies of the repo's config, the backups
//           beside it (config.md.bak*) and the live file in modification order: the row, its old and new
//           items, and the later copy's modification time
//   claude  the first worker start (phase0-report.mjs spawn records) on a claude version other than the
//           one before it
// Each entry's `before` and `after` are the tickets merged in the window on that side of it: the median
// $ per accepted ticket over those whose cost is fully recorded, and the blind audit's findings per
// audited PR (levers-audit.mjs audit.jsonl), each with its count. A figure with no tickets is null.
//
// It only reads: git with --no-optional-locks, nothing fetched; the config backups; the batches' state.
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { allBatches } from './batches.mjs';
import { DAY_MS, perTicket, spawnRecords } from './phase0-report.mjs';
import { landedPr } from './post-merge.mjs';
import { auditFile } from './levers-audit.mjs';
import { lines as jsonlRows } from './levers-trips.mjs';
import { quantile } from './quantile.mjs';

const VERSION = 1;

// ---- what counts as worker-facing ----------------------------------------------------------------
const WORKER_DIRS = Object.freeze(['skills/', 'agents/', 'hooks/']);
// The desk/bin files that set up a worker, decide what it is handed or allowed, or that it runs itself
// (worker-settings.mjs's allow-list and the skills' commands); the rest of desk/bin is the orchestrator's.
const WORKER_BIN = Object.freeze(new Set([
  'spawn-worker.sh', 'setup-worktree.sh', 'copy-env.sh', 'env-rewrite.mjs', 'with-lock.sh', 'briefing.mjs', 'memory-digest.mjs',
  'lever-pin.mjs', 'model-list.mjs', 'preflight-fingerprint.mjs',
  'worker-agents.mjs', 'worker-settings.mjs', 'worker-tools.mjs', 'desk-env.mjs', 'desk-env.sh', 'config-schema.mjs',
  'desk-gh.mjs', 'desk-design.mjs', 'stitch-boards.mjs', 'handoff.mjs', 'desk-wait.mjs', 'clears-when.mjs',
  'closing-keywords.mjs', 'push-retry.mjs', 'review-post.mjs', 'preview-db.mjs', 'desk-codex.mjs', 'codex-exec.mjs',
  'evidence.mjs', 'decisions.mjs', 'not-now.mjs', 'needs-you.mjs', 'desk-lines.mjs', 'test-scope.mjs',
]));
const TEST_PATH = /(^|\/)(tests?|__tests__|fixtures)\/|(^|\/)test_[^/]*$|\.(test|spec)\.[cm]?[jt]sx?$/;

// Whether a repo path changes how a worker behaves: under skills/, agents/ or hooks/, or one of
// WORKER_BIN, and never a test.
export const isWorkerFacing = (path) => !TEST_PATH.test(path)
  && (WORKER_DIRS.some((d) => path.startsWith(d)) || (path.startsWith('desk/bin/') && !path.slice(9).includes('/') && WORKER_BIN.has(basename(path))));

// ---- merged PRs -----------------------------------------------------------------------------------
const runGit = (root, args) => {
  const r = spawnSync('git', ['--no-optional-locks', '-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed in ${root}: ${String(r.stderr ?? '').trim().split('\n').pop() || `exit ${r.status}`}`);
  return r.stdout;
};

// The ticket key a PR carries, from §4 Ticket key pattern: the first whole key in `texts` (no letter or
// digit before it, no digit or `-<digit>` after it), case-insensitively, as the tracker spells it.
export function ticketOf(pattern, ...texts) {
  if (!pattern) return null;
  let re;
  try { re = new RegExp(pattern, 'gi'); } catch { return null; }
  for (const s of texts.map((x) => String(x ?? ''))) {
    for (const m of s.matchAll(re)) {
      if (!m[0] || /[A-Za-z0-9]/.test(s[m.index - 1] ?? '') || /^(\d|-\d)/.test(s.slice(m.index + m[0].length))) continue;
      return m[0].toUpperCase();
    }
  }
  return null;
}

// What a first-parent commit says of the PR it landed (its number from landedPr): a merge commit's
// "Merge pull request #N from <owner>/<branch>" with the title as its body, or a squash commit's
// "<title> (#N)". Null for a commit that names no PR.
export function prOf(subject, body) {
  const pr = landedPr(subject);
  if (pr == null) return null;
  if (subject.startsWith('Merge pull request #')) {
    const from = /^Merge pull request #\d+ from (\S+)/.exec(subject)?.[1];
    return { pr, branch: from ? from.replace(/^[^/]+\//, '') : null, title: String(body ?? '').trim().split('\n')[0].trim() || null };
  }
  return { pr, branch: null, title: subject.replace(/\s*\(#\d+\)\s*$/, '') };
}

// The first-parent commits on `ref` since `since` (epoch ms) that changed a worker-facing path, each
// diffed against its first parent: [{ kind: 'pr', at, pr, ticket, title, sha, paths }], `pr` null for a
// commit naming no PR.
function prEntries({ root, ref, since, pattern = null, git = runGit }) {
  const out = git(root, ['log', '--first-parent', '-m', '--name-only', `--since=${new Date(since).toISOString()}`,
    '--format=%x1e%H%x1f%cI%x1f%s%x1f%b%x1d', ref]);
  const entries = [];
  for (const rec of out.split('\x1e').slice(1)) {
    const [head, names = ''] = rec.split('\x1d');
    const [sha, at, subject, body] = head.split('\x1f');
    const paths = [...new Set(names.split('\n').map((l) => l.trim()).filter(Boolean))].filter(isWorkerFacing).sort();
    if (!paths.length) continue;
    const p = prOf(subject, body);
    entries.push({
      kind: 'pr', at: new Date(at).toISOString(), pr: p?.pr ?? null,
      ticket: p ? ticketOf(pattern, p.branch, p.title) : ticketOf(pattern, subject), title: p ? p.title : subject, sha, paths,
    });
  }
  return entries;
}

// ---- config rows ----------------------------------------------------------------------------------
// Each row whose items differ between consecutive copies of the config in `dir` (config.md and every
// config.md.bak* beside it, by modification time), dated by the later copy, from `since` on:
// [{ kind: 'config', at, row, from, to, file }], `from` and `to` each the row's items. `from` is null for
// a row the later copy added, `to` for one it dropped.
export function configEntries({ dir, since = -Infinity }) {
  let names = [];
  try { names = readdirSync(dir).filter((f) => f === 'config.md' || f.startsWith('config.md.bak')); } catch { return []; }
  const copies = names.map((f) => {
    const file = join(dir, f);
    try { return { file, mtime: statSync(file).mtimeMs, rows: E.configRowValues(readFileSync(file, 'utf8')) }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file));
  const itemsOf = (c) => new Map(c.rows.map((r) => [`§${r.section} ${r.label}`, r.items]));
  const entries = [];
  for (let i = 1; i < copies.length; i++) {
    const at = copies[i].mtime;
    if (at < since) continue;
    const was = itemsOf(copies[i - 1]);
    const now = itemsOf(copies[i]);
    for (const row of new Set([...was.keys(), ...now.keys()])) {
      const from = was.get(row) ?? null;
      const to = now.get(row) ?? null;
      if (JSON.stringify(from) !== JSON.stringify(to)) entries.push({ kind: 'config', at: new Date(at).toISOString(), row, from, to, file: copies[i].file });
    }
  }
  return entries;
}

// ---- claude versions ------------------------------------------------------------------------------
// The first start on each claude version other than the last one recorded before it, from `since` on:
// [{ kind: 'claude', at, from, to, ticket, session }]. A start that recorded no version is passed over.
export function claudeEntries({ records, since = -Infinity }) {
  const starts = records.filter((r) => r?.claude_version && Number.isFinite(Date.parse(r.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const entries = [];
  let was = null;
  for (const r of starts) {
    if (was != null && r.claude_version !== was && Date.parse(r.at) >= since) {
      entries.push({ kind: 'claude', at: new Date(Date.parse(r.at)).toISOString(), from: was, to: r.claude_version, ticket: r.ticket ?? null, session: r.session ?? null });
    }
    was = r.claude_version;
  }
  return entries;
}

// ---- before and after -----------------------------------------------------------------------------
const round = (v, dp) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp);

// The tickets merged in [from, to) (epoch ms): the median $ per accepted ticket over those whose cost is
// fully recorded, and the blind audit's P0, P1 and P2 per audited PR over the audits of those tickets.
// `tickets` are phase0-report.mjs per-ticket rows, `audits` audit.jsonl rows.
export function sideOf({ tickets, audits, from, to }) {
  const merged = tickets.filter((t) => { const m = Date.parse(t.merged_at); return m >= from && m < to; });
  const costed = merged.filter((t) => t.cost_complete && Number.isFinite(t.cost));
  const keys = new Set(merged.map((t) => t.key));
  const audited = audits.filter((a) => keys.has(a.ticket) && !a.findings_missing && ['p0', 'p1', 'p2'].every((k) => Number.isFinite(a[k])));
  const per = (k) => (audited.length ? round(audited.reduce((n, a) => n + a[k], 0) / audited.length, 2) : null);
  return {
    accepted: merged.length, costed: costed.length, median_usd: round(quantile(costed.map((t) => t.cost), 0.5), 2),
    audited: audited.length, p0: per('p0'), p1: per('p1'), p2: per('p2'),
  };
}

// An entry with its `before` and `after`: the `windowMs` either side of when it landed.
const withFigures = (entry, { tickets, audits, windowMs }) => {
  const at = Date.parse(entry.at);
  return { ...entry, before: sideOf({ tickets, audits, from: at - windowMs, to: at }), after: sideOf({ tickets, audits, from: at, to: at + windowMs }) };
};

// ---- the log --------------------------------------------------------------------------------------
// One merged ticket per key, the newest row of it, so a ticket in two batches is counted once.
const mergedTickets = (rows) => [...new Map(rows.filter((r) => r.merged_at && Number.isFinite(Date.parse(r.merged_at)))
  .sort((a, b) => Date.parse(a.merged_at) - Date.parse(b.merged_at)).map((r) => [r.key, r])).values()];

// The change log for `slug` over the `days` to `now`. Every input is a parameter so a test can point it
// at fixtures; `tickets` are per-ticket rows and `audits` audit rows, read from the batches when not given.
export function changeLog({
  slug = E.repoSlug(), now = Date.now(), days = 30, windowDays = 7,
  root = E.repoRoot(), ref = `origin/${E.defaultBranch()}`, pattern = E.configValue('ticket-pattern'),
  configDir = join(E.deskConfigRoot(), 'repos', slug), batches = allBatches(slug),
  records = batches.flatMap((b) => spawnRecords(b.state)),
  tickets = perTicket({ slug, batches, since: 0, until: now, ci: false }).rows,
  audits = jsonlRows(auditFile(slug)).map((r) => r.rec), git = runGit,
} = {}) {
  const since = now - days * DAY_MS;
  const windowMs = windowDays * DAY_MS;
  const pat = pattern && !E.isNone(pattern) ? pattern : null;
  const merged = mergedTickets(tickets);
  const entries = [
    ...prEntries({ root, ref, since, pattern: pat, git }), ...configEntries({ dir: configDir, since }), ...claudeEntries({ records, since }),
  ].filter((e) => Date.parse(e.at) <= now).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.kind.localeCompare(b.kind))
    .map((e) => withFigures(e, { tickets: merged, audits, windowMs }));
  return { v: VERSION, slug, since: new Date(since).toISOString(), until: new Date(now).toISOString(), window_days: windowDays, ref, entries };
}

// ---- rendering ------------------------------------------------------------------------------------
const quoted = (items) => (items == null ? '(no row)' : items.length ? items.map((i) => `\`${i}\``).join(' ') : '(empty)');
const entryHead = (e) => {
  if (e.kind === 'pr') {
    const what = e.pr == null ? `commit ${e.sha.slice(0, 8)} (names no PR)` : `PR #${e.pr}`;
    return `${what}${e.ticket ? ` ${e.ticket}` : ''}: ${e.title ?? '(no title)'} (${e.paths.length} worker-facing file(s))`;
  }
  if (e.kind === 'config') return `config ${e.row}: ${quoted(e.from)} -> ${quoted(e.to)}`;
  return `claude ${e.from} -> ${e.to}, first start ${e.ticket ?? 'unknown ticket'}`;
};
const sideLine = (label, s) => {
  const usd = s.median_usd == null ? `no accepted ticket with its cost recorded (${s.accepted} merged)` : `median $${s.median_usd.toFixed(2)} per accepted ticket over ${s.costed} of ${s.accepted} merged`;
  const audit = s.audited ? `blind audit P0 ${s.p0} · P1 ${s.p1} · P2 ${s.p2} per PR over ${s.audited} audited` : 'no audited PR';
  return `    ${label}: ${usd} · ${audit}`;
};
export function logLines(log) {
  const out = [`CHANGES: ${log.slug}, ${log.since} to ${log.until}, from ${log.ref}; before and after are the ${log.window_days} day(s) either side. Read-only.`];
  if (!log.entries.length) return [...out, 'no worker-facing change in the window'];
  for (const e of log.entries) out.push(`${e.at}  ${entryHead(e)}`, sideLine('before', e.before), sideLine('after ', e.after));
  return out;
}

// ---- CLI ------------------------------------------------------------------------------------------
const isMain = () => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isMain()) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const days = opt('--days') == null ? 30 : Number(opt('--days'));
  const windowDays = opt('--window') == null ? 7 : Number(opt('--window'));
  const known = new Set(['--days', '--window', '--json']);
  if (!(days > 0) || !(windowDays > 0) || args.some((a, i) => a.startsWith('--') ? !known.has(a) : !['--days', '--window'].includes(args[i - 1]))) {
    console.error('usage: desk-changes.mjs [--days <n>] [--window <days>] [--json]'); process.exit(2);
  }
  try {
    const log = changeLog({ days, windowDays });
    if (args.includes('--json')) console.log(JSON.stringify(log, null, 2));
    else for (const l of logLines(log)) console.log(l);
  } catch (e) {
    console.error(`desk-changes: ${e.message}`);
    process.exit(e instanceof E.DeskConfigError ? 4 : 1);
  }
}
