#!/usr/bin/env node
// How well triage's files_in_scope predicted what each ticket's merged PRs changed, per repo: the
// numbers config §3b "Per-file collision budget" is set from. Read only: it changes nothing.
//   node scope-precision.mjs <owner/name>... [--days 30]
// For each repo it joins the triage records under its state folder (the standing batch's and every
// named batch's) with the files of the PRs merged in the last --days days whose branch or title names
// the record's key, then prints precision (named files changed / files named) and recall (changed
// files named / files changed), overall and for the 10 most-named files. It ends with a proposed k for
// each of those files and a proposed hot-serial list, per repo.
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { slugOf, batchPaths, BATCHES_DIR } from './desk-env.mjs';
import { fileBudget } from './config-schema.mjs';

export const TOP = 10;
export const SERIAL_AT = 0.8;
// The most places the default budget row gives any file.
export const K_CAP = fileBudget(null).big;
export const RULE = `k = 1 where at least ${SERIAL_AT * 100}% of the tickets naming a file changed it (the hot-serial list); otherwise ceil(1 / precision), at most ${K_CAP}, the default row's k for a long file`;

const norm = (s) => String(s).trim().replace(/^\.\//, '');
const covers = (entry, file) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry);
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');

// Every triage record under a repo's state folder -> Map key -> files_in_scope. A key in more than one
// batch keeps the standing batch's record. Challenge files and unreadable records are skipped.
export function scopeRecords(state) {
  const dirs = [join(state, 'triage')];
  try { for (const b of readdirSync(join(state, BATCHES_DIR))) dirs.push(join(state, BATCHES_DIR, b, 'triage')); } catch {}
  const out = new Map();
  for (const dir of dirs) {
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const f of names) {
      const m = /^([^.]+)\.json$/.exec(f);
      if (!m || out.has(m[1])) continue;
      try {
        const s = JSON.parse(readFileSync(join(dir, f), 'utf8')).files_in_scope;
        if (Array.isArray(s)) out.set(m[1], [...new Set(s.map(norm).filter(Boolean))]);
      } catch {}
    }
  }
  return out;
}

// The PRs merged into a repo on or after `since` (YYYY-MM-DD): [{ number, headRefName, title, files }].
// GitHub lists at most 100 files a PR.
export function mergedPrs(repo, since) {
  const out = execFileSync('gh', ['pr', 'list', '--repo', repo, '--state', 'merged', '--search', `merged:>=${since}`,
    '--limit', '1000', '--json', 'number,headRefName,title,files'], { encoding: 'utf8', maxBuffer: 256 << 20 });
  return JSON.parse(out).map((p) => ({ ...p, files: (p.files ?? []).map((f) => f.path) }));
}

// The records with a merged PR naming their key -> [{ key, named, changed }], `changed` the union of
// those PRs' files. A key is matched whole: DS-69 is not DS-697.
export function joinTickets(records, prs) {
  const out = [];
  for (const [key, named] of records) {
    const re = new RegExp(`(^|[^A-Za-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`);
    const mine = prs.filter((p) => re.test(p.headRefName ?? '') || re.test(p.title ?? ''));
    if (mine.length) out.push({ key, named, changed: [...new Set(mine.flatMap((p) => p.files).map(norm))] });
  }
  return out;
}

// -> { tickets, named, hits, changed, covered, files: [{ file, named, hits, changed }] } over the
// joined tickets, `files` the TOP most-named entries (most named first, then by name). A named entry is
// a hit when its ticket changed it (a directory entry: anything under it); a changed file is covered
// when any of its ticket's entries covers it. A file's `changed` counts the tickets that changed it,
// named or not.
export function measure(tickets, top = TOP) {
  const per = new Map();
  let named = 0, hits = 0, changed = 0, covered = 0;
  for (const t of tickets) {
    for (const e of t.named) {
      const r = per.get(e) ?? per.set(e, { file: e, named: 0, hits: 0 }).get(e);
      r.named++; named++;
      if (t.changed.some((f) => covers(e, f))) { r.hits++; hits++; }
    }
    changed += t.changed.length;
    covered += t.changed.filter((f) => t.named.some((e) => covers(e, f))).length;
  }
  const files = [...per.values()].sort((a, b) => b.named - a.named || (a.file < b.file ? -1 : 1)).slice(0, top)
    .map((r) => ({ ...r, changed: tickets.filter((t) => t.changed.some((f) => covers(r.file, f))).length }));
  return { tickets: tickets.length, named, hits, changed, covered, files };
}

// A file's proposed k from the share of the tickets naming it that changed it.
export function proposeK(hits, named, cap = K_CAP) {
  const p = named ? hits / named : 0;
  if (p >= SERIAL_AT) return 1;
  return p > 0 ? Math.min(cap, Math.ceil(1 / p)) : cap;
}

// [{ repo, since, records (how many), m (measure's) }] -> the text, the measurements first and the proposals last.
export function render(results) {
  const lines = [];
  for (const { repo, since, records, m } of results) {
    lines.push(`${repo}: ${m.tickets} of ${records} triaged tickets have a PR merged since ${since}`);
    lines.push(`  precision ${pct(m.hits, m.named)} (${m.hits} of ${m.named} named files changed), recall ${pct(m.covered, m.changed)} (${m.covered} of ${m.changed} changed files named)`);
    if (!m.files.length) { lines.push('  no file named', ''); continue; }
    lines.push(`  ${m.files.length} most-named files: named  changed  precision  recall`);
    for (const r of m.files) lines.push(`    ${r.file}: ${r.named}  ${r.changed}  ${pct(r.hits, r.named)}  ${pct(r.hits, r.changed)}`);
    lines.push('');
  }
  lines.push(`Proposed per-file budget (${RULE})`);
  for (const { repo, m } of results) {
    lines.push(`${repo}:`);
    for (const r of m.files) lines.push(`  ${r.file}: k=${proposeK(r.hits, r.named)} (${r.hits} of ${r.named} naming tickets changed it)`);
    const serial = m.files.filter((r) => proposeK(r.hits, r.named) === 1).map((r) => r.file);
    lines.push(`  hot-serial: ${serial.length ? serial.join(', ') : 'none'}`);
  }
  return lines.join('\n');
}

export function run(repos, { days = 30, now = Date.now(), records = (repo) => scopeRecords(batchPaths(slugOf(repo)).state), prs = mergedPrs } = {}) {
  const since = new Date(now - days * 86400e3).toISOString().slice(0, 10);
  return render(repos.map((repo) => {
    const recs = records(repo);
    return { repo, since, records: recs.size, m: measure(joinTickets(recs, prs(repo, since))) };
  }));
}

const isMain = () => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
};
if (isMain()) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--days');
  const days = at >= 0 ? Number(args[at + 1]) : 30;
  const repos = args.filter((a, i) => !(at >= 0 && (i === at || i === at + 1)));
  if (!repos.length || !(days > 0) || repos.some((r) => !/^[\w.-]+\/[\w.-]+$/.test(r))) {
    console.error('usage: scope-precision.mjs <owner/name>... [--days 30]');
    process.exit(2);
  }
  console.log(run(repos, { days }));
}
