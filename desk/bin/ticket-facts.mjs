#!/usr/bin/env node
// Read the facts plan-batch needs from Jira once, deterministically, and merge them into the ticket's
// triage record ($DESK_STATE/triage/<KEY>.json). Run by triage.sh after the model has written it, so
// plan-batch never needs the network and never takes a link from a model's summary.
//
//   ticket-facts.mjs <KEY>
//
// Adds, for a tracker key:
//   blockers     [{key, category}] — "is blocked by" (Blocks) links, with the blocker's status category
//   other_links  how many links of another type (not Blocks, not Relates) were ignored
//   size         XS|S|M|L|XL from the field named "Size", else a first description line "Size: M", else null
// or, when the read fails, facts_error instead (and no blockers), which plan-batch turns into a
// question: an unread link list must never read as "no blockers".
// A key that is not a tracker key gets links: "n/a".
// Every ticket also gets lint, desk-jira lint's findings [{severity, rule, message}] (a ticket file
// or GitHub issue is linted here, with no size), or lint_error when the lint could not run.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { ghRepo, stateDir, ticketKind } from './desk-env.mjs';
import { lintTicket, designRoot, SIZE_LINE } from './ticket-lint.mjs';

const key = process.argv[2];
const kind = ticketKind(key);
if (!kind.ok) { console.error(kind.error); process.exit(2); }
const path = join(stateDir(), 'triage', `${key}.json`);
if (!existsSync(path)) { console.error(`no triage record at ${path}`); process.exit(1); }
const rec = JSON.parse(readFileSync(path, 'utf8'));
for (const f of ['blockers', 'other_links', 'size', 'facts_error', 'links', 'lint', 'lint_error']) delete rec[f];
const lastLine = (e) => String(e.stderr ?? e.message ?? e).trim().split('\n').pop();

const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
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
  if (text !== null) rec.lint = lintTicket({ key, text, wiki: false }, designRoot());
} else {
  let issue = null;
  try {
    issue = JSON.parse(execFileSync('desk-jira', ['get', key, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 }));
  } catch (e) {
    rec.facts_error = lastLine(e) || 'desk-jira get failed';
  }
  if (issue) {
    const links = issue.fields?.issuelinks ?? [];
    rec.blockers = links
      .filter((l) => l.inwardIssue && /blocked by/i.test(l.type?.inward ?? ''))
      .map((l) => ({ key: l.inwardIssue.key, category: l.inwardIssue.fields?.status?.statusCategory?.key ?? 'new' }));
    rec.other_links = links.filter((l) => !/block/i.test(l.type?.name ?? '') && !/^relates$/i.test(l.type?.name ?? '')).length;
    const sizeField = Object.entries(issue.names ?? {}).find(([, n]) => /^(t-shirt )?size$/i.test(String(n).trim()))?.[0];
    const firstLine = String(issue.fields?.description ?? '').split('\n').find((l) => l.trim()) ?? '';
    rec.size = (sizeField && asSize(issue.fields?.[sizeField]))
      ?? asSize(SIZE_LINE.exec(firstLine)?.[1]);
    // Exit 1 with findings on stdout is a blocking finding, still a result; anything else is a lint
    // that did not run.
    try { rec.lint = JSON.parse(execFileSync('desk-jira', ['lint', key, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 })); }
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
