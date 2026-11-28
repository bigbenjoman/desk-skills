#!/usr/bin/env node
// What to admit into a free batch slot: first the unstarted Bugs and self-contained Tasks in §4 Jira
// project already assigned to the person §1 names (§1 Jira account id, else the signed-in Jira user),
// then its unassigned ones, each ranked by §4 Priority, then Bugs
// before Tasks, then newest, and checked against the default branch before it is offered. The command
// only lists and writes nothing in Jira or GitHub: /desk-admit admits, and so does the pass under the
// row named below.
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
//   - an open PR, draft or not, whose title or head branch names its key: by anyone but §1 GitHub
//     handle, left out as "open PR #n by <author>"; by the person, offered flagged "open PR #n", for
//     the batch to adopt; with the open PRs unread, flagged as not checked for one;
//   - no Acceptance criteria or no design, as triage's lint reads them: said, so it is not sent
//     expecting a clean admit;
//   - a file its description names that a PR merged in the last OVERLAP_DAYS days changed: that PR is
//     named as possible overlap.
// The person's own come first, in priority order; then clean unassigned candidates, then flagged ones,
// each in priority order. A ticket assigned to anyone else is never searched for.
//
// While the standing batch has a slot free and nothing ready to take it, the pass names the person's
// own as ready to admit (slotLines), and with config §3b "Propose candidates for a free slot" on, the
// unassigned ones too, read at most every CANDIDATES_EVERY_MS and kept in <state>/candidates.json
// between reads. With §3b "Admit candidates for a free slot" on as well, the pass admits the first
// candidate that passes admitRefusal's checks, one a run (admitRun).
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { jiraSearch } from './jira-search.mjs';
import { blockersFact } from './desk-q-eta.mjs';
import { keyPattern } from './batch-state.mjs';
import { lintTicket } from './ticket-lint.mjs';
import { mergedNaming, prNames } from './recoveries.mjs';
import { listBatches, liveBatch, repoTickets } from './batches.mjs';
import { loginIn } from './gate.mjs';

// Jira's largest page for a search returning fields.
export const SEARCH_MAX = 100;
// Candidates read from Jira and GitHub a listing, in priority order: each costs a Jira get and two
// GitHub reads.
export const CHECK_MAX = 15;
export const OVERLAP_DAYS = 7;
// Open PRs read a listing, to leave out the tickets someone else's names.
const OPEN_MAX = 200;
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
const NATURAL = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
// Among values §4 Priority does not list, by the value itself (P3 before P4), an unset one last.
function unlistedOrder(a, b, pr) {
  if (rankOf(a, pr) !== pr.order.length) return 0;
  const va = valueOf(a?.fields?.[pr.field]);
  const vb = valueOf(b?.fields?.[pr.field]);
  return va === vb ? 0 : !va ? 1 : !vb ? -1 : NATURAL.compare(va, vb);
}
// Within a priority, Bugs before Tasks, then newest first.
const bugFirst = (issue) => (/^bug$/i.test(issue?.fields?.issuetype?.name ?? '') ? 0 : 1);
// Jira writes the offset without a colon (`+0000`), which ISO date parsing does not promise to read.
const createdAt = (issue) => Date.parse(String(issue?.fields?.created ?? '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) || 0;

const jqlValue = (v) => `"${String(v).replace(/["\\]/g, '\\$&')}"`;
// The searches, highest priority first, each read one page, newest first: one per value §4 Priority
// lists, then one for a value unset or unlisted, which Jira orders by the field (a select field by its
// options' order), so a backlog past a page still reads its top tickets first. With none listed, one
// search, ordered the same way. `assignee` is the search's assignee clause: unassigned unless given
// (ownAssignee).
export function candidatesJqls(project, { field, names }, assignee = 'assignee is EMPTY') {
  const base = `project = "${project}" AND issuetype in (Bug, Task) AND ${assignee} AND statusCategory = "To Do"`;
  const f = field === 'priority' ? 'priority' : `cf[${field.slice('customfield_'.length)}]`;
  const byField = `ORDER BY ${f} ${field === 'priority' ? 'DESC' : 'ASC'}, created DESC`;
  if (!names.length) return [`${base} ${byField}`];
  return [...names.map((v) => `${base} AND ${f} = ${jqlValue(v)} ORDER BY created DESC`),
    `${base} AND (${f} is EMPTY OR ${f} not in (${names.map(jqlValue).join(', ')})) ${byField}`];
}

// §1 Jira account id, or null where it is unset or `none`.
export function personOf(raw = E.configValue('jira-account-id')) {
  const v = String(raw ?? '').trim().replace(/^`|`$/g, '');
  return v && !E.isNone(v) && !/^todo\b/i.test(v) ? v : null;
}
// The assignee clause for the tickets of `person` (§1 Jira account id), else of the signed-in Jira user.
export const ownAssignee = (person) => `assignee = ${person ? jqlValue(person) : 'currentUser()'}`;

// Words in a summary or label marking a decision, or access, key or infrastructure work outside the repo.
const OUTSIDE = /\b(decide|decision|whether|policy|should we|adopt(?:ion)?|licen[cs]e|keys?|rotat(?:e|ion)|credentials?|access|IAM|WAF|DNS|infra(?:structure)?)\b/i;
// A label naming operations work, which a summary saying "ops" does not.
const OPS_LABEL = /\b((?:dev)?ops)\b/i;
// Why `issue` reads as a decision or work outside the repo, naming the word and where, or null.
function outsideWork(issue) {
  const why = (word, where) => `a decision or work outside the repo ("${word}" in its ${where})`;
  const s = OUTSIDE.exec(String(issue?.fields?.summary ?? ''));
  if (s) return why(s[1], 'summary');
  for (const l of [].concat(issue?.fields?.labels ?? [])) {
    const m = OUTSIDE.exec(String(l)) ?? OPS_LABEL.exec(String(l));
    if (m) return why(m[1], `label ${l}`);
  }
  return null;
}

// Why a searched issue is not a candidate, or null: it is in a live batch (`queued`), its summary or a
// label reads as a decision or work outside the repo, or it is a Task with an open blocker or a parent
// epic in `liveEpics`.
export function leftOut(issue, { queued = new Set(), liveEpics = new Set() } = {}) {
  if (queued.has(issue?.key)) return 'in a batch already';
  const out = outsideWork(issue);
  if (out) return out;
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

// An open PR's author's login, or null where gh gave none.
const authorOf = (p) => String(p?.author?.login ?? '').trim() || null;

// The listing, read through `reads` (defaultReads gives the real ones):
//   search(jql, max, fields)  -> {ok, issues, more} (one page; `more` when one lies behind it) | {ok: false, why}
//   description(key)          -> {ok, text} | {ok: false, why}
//   mergedPrs(key)            -> [{number, title, headRefName}] merged into the default branch, or null when unread
//   commits(key)              -> [{sha, subject}] on origin/<default>, or null when unread
//   recent(sinceDate)         -> [{number, files}] merged into the default branch since then, or null when unread
//   openPrs()                 -> [{number, title, headRefName, author: {login}}] open, or null when unread
//   queued()                  -> Set of keys in a live batch;  liveEpics() -> Set of epic keys with a live feature batch
// `person` is §1 Jira account id (null: the signed-in Jira user), and `handle` §1 GitHub handle (null:
// every open PR is someone else's). `ownOnly` lists only the person's own.
// -> {ok, offered, onMain, left, unchecked, more, ownOnly} | {ok: false, why, ownOnly}. Each offered or on-main
// entry is {key, type, priority, summary, rank, own, flags, overlap, blockers[, pr | commit][, openPr]},
// `blockers` its "is blocked by" links as [{key, category}] and `openPr` the person's own open PR naming
// it, for the batch to adopt.
export function listCandidates({ project, priority, person = null, handle = null, ownOnly = false, reads, now = Date.now(), checkMax = CHECK_MAX }) {
  const pr = priorityOf(priority);
  const fields = ['issuelinks', 'parent', 'created', ...(pr.field === 'priority' ? [] : [pr.field])];
  const ctx = { queued: reads.queued(), liveEpics: reads.liveEpics() };
  const left = [];
  const pool = [];
  // `more`: a match was not read, on a page past the first or in a lower tier no search was needed for.
  let more = false;
  // The person's own tiers first, then the unassigned ones. One an open PR by someone else names is
  // theirs, so it is left out; one only the person's own open PRs name is offered, flagged with the PR.
  const own = new Set();
  let open;
  const openPr = new Map();
  const searches = [...candidatesJqls(project, pr, ownAssignee(person)).map((jql) => ({ jql, mine: true })),
    ...(ownOnly ? [] : candidatesJqls(project, pr).map((jql) => ({ jql, mine: false })))];
  for (const { jql, mine } of searches) {
    if (pool.length >= checkMax) { more = true; break; }
    const res = reads.search(jql, SEARCH_MAX, fields);
    if (!res?.ok) return { ok: false, why: res?.why ?? 'the Jira search failed', ownOnly };
    if (res.more) more = true;
    for (const i of res.issues) {
      let why = leftOut(i, ctx);
      if (!why) {
        if (open === undefined) open = reads.openPrs();
        const naming = (open ?? []).filter(prNames(i.key));
        const theirs = naming.find((p) => !(handle && loginIn(authorOf(p), handle)));
        if (theirs) why = `open PR #${theirs.number} by ${authorOf(theirs) ?? 'an unknown author'}`;
        else if (naming.length) openPr.set(i.key, naming[0].number);
      }
      if (why) left.push({ key: i.key, why });
      else { if (mine) own.add(i.key); pool.push(i); }
    }
  }
  const notOwn = (i) => (own.has(i.key) ? 0 : 1);
  pool.sort((a, b) => notOwn(a) - notOwn(b) || rankOf(a, pr) - rankOf(b, pr) || unlistedOrder(a, b, pr) || bugFirst(a) - bugFirst(b) || createdAt(b) - createdAt(a));
  let recent;
  const offered = [];
  const main = [];
  for (const i of pool.slice(0, checkMax)) {
    const c = { key: i.key, type: i.fields?.issuetype?.name ?? null, priority: valueOf(i.fields?.[pr.field]) || null,
      summary: i.fields?.summary ?? '', rank: rankOf(i, pr), own: own.has(i.key), flags: [], overlap: [],
      blockers: blockersFact(i).map((b) => ({ key: b.key, category: b.category })) };
    const prs = reads.mergedPrs(i.key);
    const commits = reads.commits(i.key);
    const landed = onMain(i.key, { prs: prs ?? [], commits: commits ?? [] });
    if (landed) { main.push({ ...c, ...landed }); continue; }
    if (!open) c.flags.push('not checked for an open PR: the open PRs could not be read');
    if (openPr.has(i.key)) { c.openPr = openPr.get(i.key); c.flags.push(`open PR #${c.openPr}`); }
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
  // The person's own first, by priority alone; then the clean unassigned ones, then the flagged.
  const flagged = (c) => (c.own || !(c.flags.length || c.overlap.length) ? 0 : 1);
  offered.sort((a, b) => Number(b.own) - Number(a.own) || flagged(a) - flagged(b) || a.rank - b.rank);
  return { ok: true, offered, onMain: main, left, unchecked: Math.max(0, pool.length - checkMax), more, ownOnly };
}

// What a candidate's line says after its key: priority, type, summary, then each flag and overlap.
const notes = (c) => [...c.flags, ...c.overlap.map((o) => `possible overlap with #${o.number}, merged in the last ${OVERLAP_DAYS} days (${o.files.join(', ')})`)];
// The listing as lines, for a person or a pass report. With `ownOnly` and none of the person's own to
// offer, a failed read included, nothing.
export function renderLines(r, { project }) {
  if (!r.ok) return r.ownOnly ? [] : [`no candidates: ${r.why}`];
  const mine = r.offered.filter((c) => c.own);
  const rest = r.offered.filter((c) => !c.own);
  if (r.ownOnly && !mine.length) return [];
  const out = [];
  // One the person's own open PR names is taken in on that PR (queue.mjs adopt), which the merge driver
  // then merges: /desk-admit would start a worker opening a second one.
  const adopt = (c) => (c.openPr != null ? [`adopt it with node ~/.claude/desk/bin/queue.mjs adopt ${c.key} ${c.openPr} --filed, not /desk-admit, which would open a second PR`] : []);
  const line = (c, i) => {
    const n = [...notes(c), ...adopt(c)];
    return `  ${i}. ${c.key}  ${c.priority ?? 'no priority'}  ${c.type ?? '?'}  ${c.summary}${n.length ? ` — ${n.join('; ')}` : ''}`;
  };
  if (mine.length) {
    out.push(`your unstarted assigned tickets in ${project}, ready to admit:`);
    mine.forEach((c, i) => out.push(line(c, i + 1)));
  }
  if (rest.length) {
    out.push(`candidates for a free slot from ${project}, by priority:`);
    rest.forEach((c, i) => out.push(line(c, mine.length + i + 1)));
  } else if (!r.ownOnly) out.push(`no ${mine.length ? 'unassigned ' : ''}candidates for a free slot from ${project}`);
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
    // A list OPEN_MAX long may be cut short, so it reads as unread.
    openPrs: () => { const l = ghJson(['pr', 'list', '--repo', repo, '--state', 'open', '--json', 'number,title,headRefName,author', '--limit', String(OPEN_MAX)]); return l && l.length < OPEN_MAX ? l : null; },
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
  let handle = null;
  try { handle = String(E.githubHandle() ?? '').trim().replace(/^@/, '') || null; } catch { /* unset: every open PR reads as someone else's */ }
  return { project, priority: E.configValues('jira-priority'), person: personOf(), handle };
}

// The listing for this repo: { ok, lines, result, noTracker }, `noTracker` true where it has no Jira
// tracker to list from. `ownOnly` lists only the person's own unstarted assigned tickets, and says
// nothing when there are none to offer.
export function runList({ reads, ownOnly = false } = {}) {
  const t = trackerOf();
  if (t.why) return { ok: false, noTracker: true, lines: ownOnly ? [] : [`no candidates: ${t.why}`], result: { ok: false, why: t.why } };
  const base = String(E.configValue('default-branch') ?? '').trim() || 'main';
  const result = listCandidates({ project: t.project, priority: t.priority, person: t.person, handle: t.handle, ownOnly,
    reads: reads ?? defaultReads({ repo: E.ghRepo(), root: E.repoRoot(), base }) });
  return { ok: result.ok, lines: renderLines(result, t), result };
}

// Config §3b "Propose candidates for a free slot": on, or off for anything else.
export const slotCandidatesOn = (raw = E.configValue('slot-candidates')) => String(raw ?? '').trim().toLowerCase() === 'on';

// The pass's lines for a free slot: the kept listing while it is under CANDIDATES_EVERY_MS old and was
// read with the same `ownOnly`, else a fresh one, kept unless `dry`.
export function slotLines({ state, now = Date.now(), dry = false, ownOnly = false, list = runList } = {}) {
  const file = join(state, 'candidates.json');
  let kept = null;
  try { kept = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none kept yet */ }
  if (!Array.isArray(kept?.lines) || !(now - Date.parse(kept.at) < CANDIDATES_EVERY_MS) || Boolean(kept.own_only) !== ownOnly) {
    kept = { at: new Date(now).toISOString(), own_only: ownOnly, lines: list({ ownOnly }).lines };
    if (!dry) { try { writeFileSync(file, `${JSON.stringify(kept, null, 2)}\n`); } catch { /* read again next pass */ } }
  }
  return kept.lines.map((l) => `free slot: ${l}`);
}

// Config §3b "Admit candidates for a free slot": on, or off for anything else. The pass admits only with
// "Propose candidates for a free slot" on as well.
export const admitCandidatesOn = (raw = E.configValue('admit-candidates')) => String(raw ?? '').trim().toLowerCase() === 'on';
export const ADMIT_FILE = 'candidate-admit.json';
// How long a candidate the admit itself refused (its triage found a question, a lane needing a person, a
// failed lint) is passed over, so the same triage is not paid for every run.
export const ADMIT_RETRY_MS = 24 * 60 * 60 * 1000;

// Why offered candidate `c` is not admitted unattended, or null: any flag on it (no Acceptance criteria
// or Design section, an open PR to adopt, a read that failed), a blocker not Done or whose code is not
// on `base`, or a PR naming it merged into a branch other than `base`. `checks`:
//   landed(key, base)    -> true | false | null (unread), as intake.mjs landedOn
//   elsewhere(key, base) -> {branch, state} | null, as intake.mjs unpromotedBase
export function admitRefusal(c, base, { landed, elsewhere }) {
  if (c.flags?.length) return c.flags.join('; ');
  const away = (key) => { const e = elsewhere(key, base); return e && e.state !== 'merged' ? e : null; };
  for (const b of c.blockers ?? []) {
    if (b.category !== 'done') return `blocker ${b.key} is not Done`;
    const on = landed(b.key, base);
    if (on === true) continue;
    if (on == null) return `whether blocker ${b.key} is on ${base} could not be read`;
    const e = away(b.key);
    return e ? `blocker ${b.key} is merged into ${e.branch}, not ${base}` : `blocker ${b.key}'s code is not on ${base}`;
  }
  const own = away(c.key);
  return own ? `a PR naming it is merged into ${own.branch}, not ${base}` : null;
}

// A kept run as lines: what it admitted, what it refused and why, or why it admitted nothing.
export function admitText(run) {
  const out = [];
  const a = run?.admitted;
  if (a) out.push(`${a.dry ? 'would admit' : 'admitted'} ${a.key}${a.note ? ` (${a.note})` : ''}`);
  if (run?.refused?.length) out.push(`refused ${run.refused.map((x) => `${x.key} (${x.why})`).join(', ')}`);
  if (!a) out.push(`admitted nothing: ${run?.why ?? 'no candidate passed the checks'}`);
  return out;
}

// One unattended admission for a free slot, at most every CANDIDATES_EVERY_MS: the listing read afresh,
// and each offered candidate, in its order, checked (admitRefusal) until one passes; that one alone is
// admitted, at normal position, with `admit(key)` -> {admitted, why, retry}. One the admit refused is
// passed over for ADMIT_RETRY_MS unless `retry` (a usage limit). An unassigned one admitted is assigned
// with `assign(key)` -> {ok, why} where `assignSelf` (config §3 jira-assign-self) is `yes`. The run is kept
// in <state>/candidate-admit.json, which desk-q reads, unless `dry`. `on` is both §3b rows on: off, it
// does nothing. -> the pass's lines.
export function admitRun({ state, base, now = Date.now(), dry = false, list = runList, checks, admit, assign, assignSelf = 'no',
  on = slotCandidatesOn() && admitCandidatesOn() }) {
  if (!on) return [];
  const file = join(state, ADMIT_FILE);
  let kept = null;
  try { kept = JSON.parse(readFileSync(file, 'utf8')); } catch { /* no run yet */ }
  if (now - Date.parse(kept?.at) < CANDIDATES_EVERY_MS) return [];
  const at = new Date(now).toISOString();
  const passed = Object.fromEntries(Object.entries(kept?.passed_over ?? {}).filter(([, v]) => now - Date.parse(v?.at) < ADMIT_RETRY_MS));
  const run = { at, admitted: null, refused: [], why: null };
  const r = list({ ownOnly: false }).result;
  if (!r?.ok) run.why = r?.why ?? 'the candidates could not be listed';
  else {
    const offered = r.offered.filter((c) => !passed[c.key]);
    if (!offered.length) run.why = r.offered.length ? 'every candidate was refused by its admit in the last day' : 'no candidates';
    for (const c of offered) {
      const why = admitRefusal(c, base, checks);
      if (why) { run.refused.push({ key: c.key, why }); continue; }
      if (dry) { run.admitted = { key: c.key, dry: true }; break; }
      const a = admit(c.key);
      if (!a?.admitted) {
        run.refused.push({ key: c.key, why: a?.why ?? 'the admit failed' });
        if (!a?.retry) passed[c.key] = { at, why: a?.why ?? null };
        run.why = 'the one candidate tried this run was refused';
        break;
      }
      run.admitted = { key: c.key };
      if (!c.own) {
        const yes = String(assignSelf ?? '').trim().toLowerCase() === 'yes';
        const s = yes ? assign(c.key) : null;
        run.admitted.note = !yes ? `not assigned: config §3 jira-assign-self is ${String(assignSelf ?? '').trim() || 'unset'}`
          : s?.ok ? 'assigned to you' : `not assigned: ${s?.why ?? 'the assignment failed'}`;
      }
      break;
    }
  }
  if (!dry) { try { writeFileSync(file, `${JSON.stringify({ ...run, passed_over: passed }, null, 2)}\n`); } catch { /* run again next pass */ } }
  return admitText(run).map((l) => `free slot: ${l}`);
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
