#!/usr/bin/env node
// What to admit into a free batch slot: §4 Jira project's unassigned, unstarted Bugs and self-contained
// Tasks, ranked by §4 Priority, then Bugs before Tasks, then newest, each checked against the default branch before it is offered. It only
// lists and writes nothing in Jira or GitHub: /desk-admit admits.
//
//   node candidates.mjs [--json]   the list (exit 0); 1 when the Jira search failed, 3 with no Jira
//                                  tracker or project in the config, 2 on bad usage
//
// A Task is self-contained with no open "is blocked by" link and no parent epic whose feature batch is
// live. A ticket already in a live batch, or whose summary or labels read as a decision or as access,
// key or infrastructure work outside the repo, is left out. Jira is searched a priority tier at a time, one
// page each, until CHECK_MAX are found; of those, the first CHECK_MAX by priority are read from Jira
// and GitHub:
//   - a PR merged into §0 Default branch whose title or head branch names its key, or a commit on
//     origin/<default> naming it: "already on main (PR #n)", and not offered;
//   - no Acceptance criteria or no design, as triage's lint reads them: said, so it is not sent
//     expecting a clean admit;
//   - a file its description names that a PR merged in the last OVERLAP_DAYS days changed: that PR is
//     named as possible overlap.
// Clean candidates come first, then flagged ones, each in priority order.
//
// With config §3b "Propose candidates for a free slot" on, the pass lists them too (slotLines) while
// the standing batch has a slot free and nothing ready to take it, read at most every
// CANDIDATES_EVERY_MS and kept in <state>/candidates.json between reads.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { jiraSearch } from './jira-search.mjs';
import { blockersFact } from './desk-q-eta.mjs';
import { keyPattern } from './batch-state.mjs';
import { lintTicket } from './ticket-lint.mjs';
import { mergedNaming } from './recoveries.mjs';
import { listBatches, liveBatch, repoTickets } from './batches.mjs';

// Jira's largest page for a search returning fields.
export const SEARCH_MAX = 100;
// Candidates read from Jira and GitHub a listing, in priority order: each costs a Jira get and two
// GitHub reads.
export const CHECK_MAX = 15;
export const OVERLAP_DAYS = 7;
export const CANDIDATES_EVERY_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const GH_TIMEOUT_MS = 30 * 1000;
// Jira's own priority names, highest first, for a §4 Priority row that lists no order.
const STANDARD = ['highest', 'high', 'medium', 'low', 'lowest'];

// §4 Priority as { field, names, order }: the custom field it names (else Jira's `priority`), the values
// it lists as written, highest first (empty where it lists none), and those in lower case (else Jira's
// own names).
// A value written with its Jira option id (`P2=10091`) is named without it.
export function priorityOf(items) {
  const list = [].concat(items ?? []).map((v) => String(v ?? '').trim()).filter((v) => v && !E.isNone(v) && !/^todo\b/i.test(v));
  const field = list.map((v) => /customfield_\d+/.exec(v)?.[0]).find(Boolean) ?? 'priority';
  const names = list.filter((v) => !/customfield_\d+/.test(v)).map((v) => v.replace(/\s*=\s*\d+$/, '')).filter(Boolean);
  return { field, names, order: names.length ? names.map((v) => v.toLowerCase()) : STANDARD };
}
const valueOf = (v) => String((v && typeof v === 'object' ? v.value ?? v.name : v) ?? '').trim();
// Where an issue's priority sits in `order`: an unset or unknown value ranks after every listed one.
export function rankOf(issue, { field, order }) {
  const i = order.indexOf(valueOf(issue?.fields?.[field]).toLowerCase());
  return i < 0 ? order.length : i;
}
// Within a priority, Bugs before Tasks, then newest first.
const bugFirst = (issue) => (/^bug$/i.test(issue?.fields?.issuetype?.name ?? '') ? 0 : 1);
// Jira writes the offset without a colon (`+0000`), which ISO date parsing does not promise to read.
const createdAt = (issue) => Date.parse(String(issue?.fields?.created ?? '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) || 0;

const jqlValue = (v) => `"${String(v).replace(/["\\]/g, '\\$&')}"`;
// The searches, highest priority first, each read one page, newest first: one per value §4 Priority
// lists, then one for a value unset or unlisted, so a backlog past a page still reads its top tickets
// first. With none listed, one search, which Jira orders by its own priority (a custom field: by age).
export function candidatesJqls(project, { field, names }) {
  const base = `project = "${project}" AND issuetype in (Bug, Task) AND assignee is EMPTY AND statusCategory = "To Do"`;
  if (!names.length) return [`${base} ORDER BY ${field === 'priority' ? 'priority DESC, ' : ''}created DESC`];
  const f = field === 'priority' ? 'priority' : `cf[${field.slice('customfield_'.length)}]`;
  return [...names.map((v) => `${base} AND ${f} = ${jqlValue(v)} ORDER BY created DESC`),
    `${base} AND (${f} is EMPTY OR ${f} not in (${names.map(jqlValue).join(', ')})) ORDER BY created DESC`];
}

// Words in a summary or label marking a decision, or access, key or infrastructure work outside the repo.
const OUTSIDE = /\b(decide|decision|whether|policy|adopt(?:ion)?|licen[cs]e keys?|rotat(?:e|ion)|credentials?|access|IAM|WAF|DNS|infra(?:structure)?)\b/i;
// The word that marks `issue` as a decision or work outside the repo, and where: { word, in } or null.
export function outsideWork(issue) {
  const s = OUTSIDE.exec(String(issue?.fields?.summary ?? ''));
  if (s) return { word: s[1], in: 'summary' };
  for (const l of [].concat(issue?.fields?.labels ?? [])) {
    const m = OUTSIDE.exec(String(l));
    if (m) return { word: m[1], in: `label ${l}` };
  }
  return null;
}

// Why a searched issue is not a candidate, or null: it is in a live batch (`queued`), its summary or a
// label reads as a decision or work outside the repo, or it is a Task with an open blocker or a parent
// epic in `liveEpics`.
export function leftOut(issue, { queued = new Set(), liveEpics = new Set() } = {}) {
  if (queued.has(issue?.key)) return 'in a batch already';
  const out = outsideWork(issue);
  if (out) return `a decision or work outside the repo ("${out.word}" in its ${out.in})`;
  if (!/^task$/i.test(issue?.fields?.issuetype?.name ?? '')) return null;
  const open = blockersFact(issue).filter((b) => b.category !== 'done').map((b) => b.key);
  if (open.length) return `blocked by ${open.join(', ')}`;
  const parent = issue.fields?.parent?.key;
  return parent && liveEpics.has(parent) ? `a child of epic ${parent}, whose feature batch is running` : null;
}

// The flag each of triage's lint rules a candidate list names is said as.
const SECTION_FLAGS = { criteria: 'no Acceptance criteria', design: 'no Design section (no design link or "No UI." line)' };
// What triage's lint (ticket-lint.mjs) refuses a description on that the list says: no Acceptance
// criteria, no design.
export function missingSections(text, key) {
  return lintTicket({ key, text }).filter((f) => f.severity === 'blocking' && SECTION_FLAGS[f.rule]).map((f) => SECTION_FLAGS[f.rule]);
}

const EXT = 'mjs|cjs|js|jsx|ts|tsx|py|sh|md|json|ya?ml|toml|css|scss|sql|go|rs|rb|java|kt|swift|php|html|vue|svelte';
const PATH = new RegExp(String.raw`(?:^|[\s\`'"(\[{|])((?:[\w@.-]+/)+[\w@.-]+\.[A-Za-z0-9]{1,8}|[\w@-]+(?:\.[\w-]+)*\.(?:${EXT}))(?=$|[\s\`'"),.:;\]}|])`, 'g');
// The file paths a description names: ones with a directory and an extension, or a bare file name
// with a source extension.
export function namedFiles(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(PATH)) out.add(m[1].replace(/^\.\//, ''));
  return out;
}
// The PRs in `recent` ([{number, files: [{path}] | [path]}]) changing a file `names` holds, each with
// the files: [{number, files}]. A bare name matches that file in any directory.
export function overlapOf(names, recent) {
  const hits = (f) => [...names].some((n) => f === n || f.endsWith(`/${n}`));
  return (recent ?? []).map((p) => ({ number: p.number, files: (p.files ?? []).map((f) => (typeof f === 'string' ? f : f?.path)).filter((f) => f && hits(f)) }))
    .filter((p) => p.files.length);
}

// Whether ticket `key` is already on the default branch, from `prs` (merged into it) and `commits`
// ([{sha, subject}] on it): { pr } for a PR naming it in its title or head branch, or a commit naming
// it whose subject names its PR; { commit } for one that does not; null for neither.
export function onMain(key, { prs = [], commits = [] } = {}) {
  const pr = mergedNaming(key, prs);
  if (pr) return { pr: pr.number };
  const names = new RegExp(keyPattern(key));
  const c = commits.find((x) => names.test(x?.subject ?? ''));
  if (!c) return null;
  const n = /#(\d+)/.exec(c.subject)?.[1];
  return n ? { pr: Number(n) } : { commit: c.sha };
}

// The listing, read through `reads` (defaultReads gives the real ones):
//   search(jql, max, fields)  -> {ok, issues, more} (one page; `more` when one lies behind it) | {ok: false, why}
//   description(key)          -> {ok, text} | {ok: false, why}
//   mergedPrs(key)            -> [{number, title, headRefName}] merged into the default branch, or null when unread
//   commits(key)              -> [{sha, subject}] on origin/<default>, or null when unread
//   recent(sinceDate)         -> [{number, files}] merged into the default branch since then, or null when unread
//   queued()                  -> Set of keys in a live batch;  liveEpics() -> Set of epic keys with a live feature batch
// -> {ok, offered, onMain, left, unchecked, more} | {ok: false, why}. Each offered or on-main entry is
// {key, type, priority, summary, rank, flags, overlap[, pr | commit]}.
export function listCandidates({ project, priority, reads, now = Date.now(), checkMax = CHECK_MAX }) {
  const pr = priorityOf(priority);
  const fields = ['issuelinks', 'parent', 'created', ...(pr.field === 'priority' ? [] : [pr.field])];
  const ctx = { queued: reads.queued(), liveEpics: reads.liveEpics() };
  const left = [];
  const pool = [];
  // `more`: a match was not read, on a page past the first or in a lower tier no search was needed for.
  let more = false;
  for (const jql of candidatesJqls(project, pr)) {
    if (pool.length >= checkMax) { more = true; break; }
    const res = reads.search(jql, SEARCH_MAX, fields);
    if (!res?.ok) return { ok: false, why: res?.why ?? 'the Jira search failed' };
    if (res.more) more = true;
    for (const i of res.issues) {
      const why = leftOut(i, ctx);
      if (why) left.push({ key: i.key, why }); else pool.push(i);
    }
  }
  pool.sort((a, b) => rankOf(a, pr) - rankOf(b, pr) || bugFirst(a) - bugFirst(b) || createdAt(b) - createdAt(a));
  let recent;
  const offered = [];
  const main = [];
  for (const i of pool.slice(0, checkMax)) {
    const c = { key: i.key, type: i.fields?.issuetype?.name ?? null, priority: valueOf(i.fields?.[pr.field]) || null,
      summary: i.fields?.summary ?? '', rank: rankOf(i, pr), flags: [], overlap: [] };
    const prs = reads.mergedPrs(i.key);
    const commits = reads.commits(i.key);
    const landed = onMain(i.key, { prs: prs ?? [], commits: commits ?? [] });
    if (landed) { main.push({ ...c, ...landed }); continue; }
    if (!prs || !commits) c.flags.push(`not checked against ${prs ? 'the default branch\'s commits' : 'merged PRs'}: it could not be read`);
    const d = reads.description(i.key);
    if (!d?.ok) c.flags.push(`its description could not be read (${d?.why ?? 'desk-jira get failed'})`);
    else {
      c.flags.push(...missingSections(d.text, i.key));
      const names = namedFiles(d.text);
      if (names.size) {
        if (recent === undefined) recent = reads.recent(new Date(now - OVERLAP_DAYS * DAY_MS));
        if (recent) c.overlap = overlapOf(names, recent);
        else c.flags.push(`not checked for overlap: the PRs merged in the last ${OVERLAP_DAYS} days could not be read`);
      }
    }
    offered.push(c);
  }
  const flagged = (c) => (c.flags.length || c.overlap.length ? 1 : 0);
  offered.sort((a, b) => flagged(a) - flagged(b) || a.rank - b.rank);
  return { ok: true, offered, onMain: main, left, unchecked: Math.max(0, pool.length - checkMax), more };
}

// What a candidate's line says after its key: priority, type, summary, then each flag and overlap.
const notes = (c) => [...c.flags, ...c.overlap.map((o) => `possible overlap with #${o.number}, merged in the last ${OVERLAP_DAYS} days (${o.files.join(', ')})`)];
// The listing as lines, for a person or a pass report.
export function renderLines(r, { project }) {
  if (!r.ok) return [`no candidates: ${r.why}`];
  const out = [];
  if (r.offered.length) {
    out.push(`candidates for a free slot from ${project}, by priority:`);
    r.offered.forEach((c, i) => {
      const n = notes(c);
      out.push(`  ${i + 1}. ${c.key}  ${c.priority ?? 'no priority'}  ${c.type ?? '?'}  ${c.summary}${n.length ? ` — ${n.join('; ')}` : ''}`);
    });
  } else out.push(`no candidates for a free slot from ${project}`);
  if (r.onMain.length) {
    out.push('not offered:');
    for (const c of r.onMain) out.push(`  ${c.key}  already on main (${c.pr != null ? `PR #${c.pr}` : `commit ${c.commit}`})`);
  }
  if (r.left.length) out.push(`left out: ${r.left.map((l) => `${l.key} (${l.why})`).join(', ')}`);
  if (r.unchecked || r.more) out.push(`${r.unchecked ? `${r.unchecked}${r.more ? '+' : ''} more` : 'more'} not checked: only the first ${CHECK_MAX} by priority are`);
  if (r.offered.length) out.push('admit one with /desk-admit <KEY>; this list admits nothing');
  return out;
}

const ghJson = (args) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: 64 << 20 });
  try { const v = r.status === 0 ? JSON.parse(r.stdout) : null; return Array.isArray(v) ? v : null; } catch { return null; }
};
// The real reads, against `repo` (owner/name), the checkout at `root`, and its default branch `base`.
export function defaultReads({ repo, root, base }) {
  return {
    search: (jql, max, fields) => jiraSearch({ partial: true }, jql, max, fields),
    description: (key) => {
      const r = spawnSync('desk-jira', ['get', key, '--json'], { encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: 64 << 20 });
      if (r.status !== 0) return { ok: false, why: `${r.stderr ?? ''}${r.error?.message ?? ''}`.trim().split('\n').pop() || `desk-jira exited ${r.status}` };
      try { return { ok: true, text: String(JSON.parse(r.stdout)?.fields?.description ?? '') }; } catch { return { ok: false, why: 'desk-jira get did not return JSON' }; }
    },
    mergedPrs: (key) => ghJson(['pr', 'list', '--repo', repo, '--state', 'merged', '--base', base, '--search', key, '--json', 'number,title,headRefName', '--limit', '20']),
    commits: (key) => {
      const r = spawnSync('git', ['-C', root, 'log', `origin/${base}`, '-F', '--grep', key, '--format=%h%x09%s', '-n', '20'], { encoding: 'utf8' });
      if (r.status !== 0) return null;
      return r.stdout.split('\n').filter(Boolean).map((l) => { const [sha, ...s] = l.split('\t'); return { sha, subject: s.join('\t') }; });
    },
    recent: (since) => ghJson(['pr', 'list', '--repo', repo, '--state', 'merged', '--base', base, '--search', `merged:>=${since.toISOString().slice(0, 10)}`, '--json', 'number,files', '--limit', '100']),
    queued: () => { try { return new Set(repoTickets(E.repoSlug(), listBatches()).map((t) => t.key)); } catch { return new Set(); } },
    liveEpics: () => { try { return new Set(listBatches().filter((b) => b.name && liveBatch(b.name)).map((b) => b.name)); } catch { return new Set(); } },
  };
}

// This repo's tracker settings, or { why } when candidates cannot come from it.
export function trackerOf() {
  if (!/^jira\b/i.test(String(E.configValue('tracker') ?? '').trim())) return { why: 'config §4 Tracker is not jira, and candidates come from a Jira project' };
  const project = /^[`"]?([A-Z][A-Z0-9_]*)\b/.exec(String([].concat(E.configValues('jira-project') ?? [])[0] ?? '').trim())?.[1];
  if (!project) return { why: 'config §4 Jira project is not set' };
  return { project, priority: E.configValues('jira-priority') };
}

// The listing for this repo: { ok, lines, result, noTracker }, `noTracker` true where it has no Jira
// tracker to list from.
export function runList({ reads } = {}) {
  const t = trackerOf();
  if (t.why) return { ok: false, noTracker: true, lines: [`no candidates: ${t.why}`], result: { ok: false, why: t.why } };
  const base = String(E.configValue('default-branch') ?? '').trim() || 'main';
  const result = listCandidates({ project: t.project, priority: t.priority, reads: reads ?? defaultReads({ repo: E.ghRepo(), root: E.repoRoot(), base }) });
  return { ok: result.ok, lines: renderLines(result, t), result };
}

// Config §3b "Propose candidates for a free slot": on, or off for anything else.
export const slotCandidatesOn = (raw = E.configValue('slot-candidates')) => String(raw ?? '').trim().toLowerCase() === 'on';

// The pass's lines for a free slot: the kept listing while it is under CANDIDATES_EVERY_MS old, else a
// fresh one, kept unless `dry`.
export function slotLines({ state, now = Date.now(), dry = false, list = runList } = {}) {
  const file = join(state, 'candidates.json');
  let kept = null;
  try { kept = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none kept yet */ }
  if (!Array.isArray(kept?.lines) || !(now - Date.parse(kept.at) < CANDIDATES_EVERY_MS)) {
    kept = { at: new Date(now).toISOString(), lines: list().lines };
    if (!dry) { try { writeFileSync(file, `${JSON.stringify(kept, null, 2)}\n`); } catch { /* read again next pass */ } }
  }
  return kept.lines.map((l) => `free slot: ${l}`);
}

const isMain = () => { try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };
if (isMain()) {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const bad = args.filter((a) => a !== '--json');
  if (bad.length) { console.error(`candidates.mjs: unknown argument ${bad[0]}\nusage: node candidates.mjs [--json]`); process.exit(2); }
  const r = runList();
  console.log(asJson ? JSON.stringify(r.result, null, 2) : r.lines.join('\n'));
  process.exit(r.ok ? 0 : r.noTracker ? 3 : 1);
}
