#!/usr/bin/env node
// Read the facts plan-batch needs from Jira once, deterministically, and merge them into the ticket's
// triage record ($DESK_STATE/triage/<KEY>.json). Run by triage.sh after the model has written it, so
// plan-batch never needs the network and never takes a link from a model's summary.
//
//   ticket-facts.mjs <KEY>
//   ticket-facts.mjs --epic <KEY>...   fill in `epic` alone, for records written before it existed
//   ticket-facts.mjs --blockers <KEY>...   read `blockers` again, alone; a key that cannot be read
//                                          is left as it was and named on stderr with exit 1
//
// --epic touches nothing but `epic` and `epic_error`, so a record keeps the rest of its triage. A
// key whose issue cannot be read is left as it was, its record still without `epic`, and named on
// stderr with exit 1; pass.mjs runs this for every unfinished ticket whose record has no `epic` key.
//
// Adds, for a tracker key:
//   blockers     [{key, category}] — "is blocked by" (Blocks) links, with the blocker's status category
//   other_links  how many links of another type (not Blocks, not Relates) were ignored
//   size         XS|S|M|L|XL from the field named "Size", else a first description line "Size: M", else null
//   epic         {key, summary, children: [{key, done}]} when its Jira parent is an epic, else null; the
//                children list is left out, with epic_error, when it could not be read
//   labels       the issue's labels, as written (a feature-mode batch promotes when a `milestone` merges)
// or, when the read fails, facts_error instead (and no blockers), which plan-batch turns into a
// question: an unread link list must never read as "no blockers".
// A key that is not a tracker key gets links: "n/a".
// Every ticket also gets lint, desk-jira lint's findings [{severity, rule, message}] (a ticket file
// or GitHub issue is linted here, with no size), or lint_error when the lint could not run; and
// design, desk-design's designFact for its Design section read against the batch's base, or
// design_error when it could not be read.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { batchBase, defaultBranch, ghRepo, stateDir, ticketKind } from './desk-env.mjs';
import { lintTicket, designRoot, SIZE_LINE } from './ticket-lint.mjs';
import { designFact } from './desk-design.mjs';
import { SIZES, epicFact } from './desk-q-eta.mjs';

const lastLine = (e) => String(e.stderr ?? e.message ?? e).trim().split('\n').pop();
const jira = (args) => JSON.parse(execFileSync('desk-jira', [...args, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }));

// The epic's children in this repo, so the forecast can count the ones not queued yet; a child
// under another key pattern never runs in this queue (expand-parent.mjs drops it the same way).
// `kids` caches each epic's children across the keys of one --epic run.
function epicOf(issue, kids = new Map()) {
  const out = {};
  let children = null;
  if (epicFact(issue, null)) {
    const parent = issue.fields.parent.key;
    try {
      if (!kids.has(parent)) kids.set(parent, jira(['children', parent]).filter((c) => { const k = ticketKind(c?.key); return k.ok && k.kind === 'tracker'; }));
      children = kids.get(parent);
    } catch (e) { out.epic_error = lastLine(e) || 'desk-jira children failed'; }
  }
  out.epic = epicFact(issue, children);
  return out;
}

const blockersOf = (issue) => (issue.fields?.issuelinks ?? [])
  .filter((l) => l.inwardIssue && /blocked by/i.test(l.type?.inward ?? ''))
  .map((l) => ({ key: l.inwardIssue.key, category: l.inwardIssue.fields?.status?.statusCategory?.key ?? 'new' }));

if (process.argv[2] === '--blockers') {
  let failed = 0;
  for (const key of process.argv.slice(3)) {
    const path = join(stateDir(), 'triage', `${key}.json`);
    let rec;
    try { rec = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { failed++; console.error(`[facts] ${key}  blockers NOT READ: no readable triage record at ${path}`); continue; }
    let issue;
    try { issue = jira(['get', key]); } catch (e) { failed++; console.error(`[facts] ${key}  blockers NOT READ: ${lastLine(e) || 'desk-jira get failed'}`); continue; }
    rec.blockers = blockersOf(issue);
    writeFileSync(path, `${JSON.stringify(rec, null, 2)}\n`);
    console.log(`[facts] ${key}  blocked by ${rec.blockers.map((b) => `${b.key} (${b.category})`).join(', ') || 'nothing'}`);
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[2] === '--epic') {
  const kids = new Map();
  let failed = 0;
  for (const key of process.argv.slice(3)) {
    const path = join(stateDir(), 'triage', `${key}.json`);
    const kind = ticketKind(key);
    let rec;
    try { rec = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { failed++; console.error(`[facts] ${key}  epic NOT READ: no readable triage record at ${path}`); continue; }
    if (!kind.ok || kind.kind !== 'tracker') { failed++; console.error(`[facts] ${key}  epic NOT READ: not a tracker key`); continue; }
    let issue;
    try { issue = jira(['get', key]); } catch (e) { failed++; console.error(`[facts] ${key}  epic NOT READ: ${lastLine(e) || 'desk-jira get failed'}`); continue; }
    delete rec.epic_error;
    Object.assign(rec, epicOf(issue, kids));
    writeFileSync(path, `${JSON.stringify(rec, null, 2)}\n`);
    console.log(`[facts] ${key}  epic ${rec.epic?.key ?? 'none'}${rec.epic_error ? `  children NOT READ: ${rec.epic_error}` : ''}`);
  }
  process.exit(failed ? 1 : 0);
}

const key = process.argv[2];
const kind = ticketKind(key);
if (!kind.ok) { console.error(kind.error); process.exit(2); }
const path = join(stateDir(), 'triage', `${key}.json`);
if (!existsSync(path)) { console.error(`no triage record at ${path}`); process.exit(1); }
const rec = JSON.parse(readFileSync(path, 'utf8'));
for (const f of ['blockers', 'other_links', 'size', 'labels', 'epic', 'epic_error', 'facts_error', 'links', 'lint', 'lint_error', 'design', 'design_error']) delete rec[f];

// The design fact, read against the base a worker branches from, as origin has it where fetched.
function design(text) {
  try {
    const { root = process.cwd(), dir = null } = designRoot();
    const base = batchBase() ?? defaultBranch();
    let ref = base;
    try { execFileSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `origin/${base}`], { stdio: 'ignore' }); ref = `origin/${base}`; } catch { /* no remote copy */ }
    rec.design = designFact(text, { root, dir, ref, state: stateDir() });
  } catch (e) { rec.design_error = lastLine(e) || 'design not read'; }
}

const asSize = (v) => {
  const s = String((v && typeof v === 'object' ? v.value ?? v.name : v) ?? '').trim().toUpperCase();
  return SIZES.includes(s) ? s : null;
};

if (kind.kind !== 'tracker') {
  rec.links = 'n/a';
  // A GitHub issue's text is the issue; every other key that is not a tracker key has a ticket file.
  const file = join(stateDir(), 'tickets', `${key}.md`);
  let text = null;
  if (kind.kind === 'issue') {
    try { text = execFileSync('gh', ['issue', 'view', key.replace(/^issue-/, ''), '--repo', ghRepo(), '--json', 'body', '--jq', '.body'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { rec.lint_error = lastLine(e) || 'gh issue view failed'; }
  } else if (existsSync(file)) text = readFileSync(file, 'utf8');
  else rec.lint_error = `no ticket file at ${file}`;
  if (text !== null) { rec.lint = lintTicket({ key, text, wiki: false }, designRoot()); design(text); }
} else {
  let issue = null;
  try {
    issue = jira(['get', key]);
  } catch (e) {
    rec.facts_error = lastLine(e) || 'desk-jira get failed';
  }
  if (issue) {
    const links = issue.fields?.issuelinks ?? [];
    rec.blockers = blockersOf(issue);
    rec.other_links = links.filter((l) => !/block/i.test(l.type?.name ?? '') && !/^relates$/i.test(l.type?.name ?? '')).length;
    const sizeField = Object.entries(issue.names ?? {}).find(([, n]) => /^(t-shirt )?size$/i.test(String(n).trim()))?.[0];
    const firstLine = String(issue.fields?.description ?? '').split('\n').find((l) => l.trim()) ?? '';
    rec.size = (sizeField && asSize(issue.fields?.[sizeField]))
      ?? asSize(SIZE_LINE.exec(firstLine)?.[1]);
    rec.labels = Array.isArray(issue.fields?.labels) ? issue.fields.labels.map(String) : [];
    Object.assign(rec, epicOf(issue));
    design(issue.fields?.description);
    // Exit 1 with findings on stdout is a blocking finding, still a result; anything else is a lint
    // that did not run.
    try { rec.lint = jira(['lint', key]); }
    catch (e) {
      try { if (e.status !== 1) throw e; rec.lint = JSON.parse(e.stdout); }
      catch { rec.lint_error = lastLine(e) || 'desk-jira lint failed'; }
    }
  }
}

writeFileSync(path, `${JSON.stringify(rec, null, 2)}\n`);
const blocking = (rec.lint ?? []).filter((f) => f.severity === 'blocking').length;
console.log(`[facts] ${key}  ${rec.links === 'n/a' ? 'links n/a'
  : rec.facts_error ? `NOT READ: ${rec.facts_error}`
  : `blocked by ${rec.blockers.map((b) => b.key).join(', ') || 'nothing'}  size ${rec.size ?? '-'}`}  ${rec.lint_error ? `lint NOT RUN: ${rec.lint_error}` : `lint ${blocking} blocking`}`);
